// oc-host Worker entry (spec 08 §19, M3 ingress D4). Routes: POST /telegram-webhook and
// POST /_ochost/hook/telegram/<seg> (webhook secret), /ops/auth/* and /ops/* (bearer), /_ochost/* (login,
// code link, logout, wake-status, owner wake/sleep), `/` (owner status page, or the login form), any other
// path → owner cookie → proxy to the active Runtime DO.
// Class exports: Control, Runtime, SandboxSession (DOs), ControlGate, ReplicaGate, CapGate, SandboxGate,
// DirectoryBackupGateway (@cloudflare/sandbox, for SandboxSession backups) (+ test fakes, inert unless OC_TEST=1).
import { ctlName, type Env, type OwnerView, rtName } from "./core/types";
import { handleAdapter } from "./ctl/adapter-webhook";
import { adapterByPath, platformSecrets } from "./ctl/adapters";
import type { FreshSecrets } from "./ctl/control";
import type { PutOut } from "./ctl/inbox";
import type { Panel } from "./ctl/panel";
import { firstText } from "./ctl/progress";
import { testTelegramFetch } from "./ctl/test-telegram";
import { sendTyping, tgCall } from "./ctl/typing";
import { handleWebhook, inlineAnswer, isWebhook } from "./ctl/webhook";
import { capGateForOwner } from "./gates/entry";
import { accessGate } from "./ingress/access";
import { handleOchost, handleOpsAuth, handleProxied, handleRoot, type IngressDeps } from "./ingress/routes";
import { hookPathOk, isHook } from "./ingress/telegram";
import { freshOf, handleOps, roleOf, sinkOf } from "./ops";
import { publicOrigin } from "./ops-telegram";

export { DirectoryBackupGateway } from "@cloudflare/sandbox";
export { Control } from "./ctl/do";
export {
  CapGate,
  ControlGate,
  LlmMock,
  ReplicaGate,
  SandboxGate,
  TelegramFake,
  TelegramGate,
} from "./gates/entry";
export { Auth } from "./ingress/auth-do";
export { Runtime } from "./rt/runtime";
export { SandboxSession } from "./sbx/do";

interface CtlEntry {
  status(): Promise<{ epoch?: { n: number } | null }>;
  ensure(): Promise<unknown>;
  inboxPut(
    p: {
      route?: string;
      body: string;
      headers: Record<string, string>;
      meta?: { platformKey: string; senderId: string | null; chatId: string | null; hold?: boolean };
    },
    fresh?: FreshSecrets,
  ): Promise<PutOut>;
  webhookPrevOk(): Promise<boolean>;
  adoptedSecrets(): Promise<Record<string, string>>;
  progressSent(chat: string, msg: number | null): Promise<unknown>;
  hookSeen(id: string, kind: string): Promise<unknown>;
  ring(a: { src: string; kind: string; detail?: unknown }): Promise<unknown>;
  ownerView(): Promise<OwnerView>;
  ownerPanel(o: { origin: string | null; fresh?: boolean }): Promise<Panel>;
  ops(r: {
    action: string;
    method: string;
    sub: string[];
    query: Record<string, string>;
    body: Record<string, unknown>;
    role: "owner";
    sink?: { url: string | null; token: string | null };
    fresh?: FreshSecrets;
  }): Promise<{ status: number; body: unknown }>;
}
interface RtEntry {
  requestWake(reason: "webhook" | "ui"): Promise<unknown>;
  sleepNow(o: { force: boolean }): Promise<{ ok: boolean; reason?: string }>;
  ownerStart(): Promise<{ ok: boolean; state?: string }>;
  ensure(): Promise<unknown>;
  fetch(req: Request): Promise<Response>;
}

/** Active epoch pointer, cached 2 s per isolate (§19.1). */
const POINTER_TTL_MS = 2000;
let pointerCache: { inst: string; n: number | null; at: number } | null = null;

const ctlOf = (env: Env) => env.CONTROL.getByName(ctlName(env.OC_INST)) as unknown as CtlEntry;
const rtOf = (env: Env, n: number) => env.RUNTIME.getByName(rtName(env.OC_INST, n)) as unknown as RtEntry;

export async function activeEpoch(env: Env, fresh = false): Promise<number | null> {
  const now = Date.now();
  if (!fresh && pointerCache && pointerCache.inst === env.OC_INST && now - pointerCache.at < POINTER_TTL_MS)
    return pointerCache.n;
  const s = await ctlOf(env).status();
  const n = s.epoch?.n ?? null;
  pointerCache = { inst: env.OC_INST, n, at: now };
  return n;
}

/** Test hook: drop the pointer cache. */
export function resetPointerCache() {
  pointerCache = null;
}

const notFound = () => new Response("not found", { status: 404 });

/** Proxy a gateway path to the active Runtime DO; a retired epoch DO answers 421 → refresh and retry once. */
async function proxy(req: Request, env: Env): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const n = await activeEpoch(env, attempt > 0);
    if (n === null) return Response.json({ ok: false, status: "not-installed" }, { status: 503 });
    const name = rtName(env.OC_INST, n);
    const fwd = new Request(req);
    fwd.headers.set("x-oc-rt", name);
    const res = await rtOf(env, n).fetch(fwd);
    if (res.status !== 421) return res;
  }
  return new Response("epoch moved", { status: 503, headers: { "retry-after": "2" } });
}

function ingressDeps(env: Env, ctx: ExecutionContext, req: Request): IngressDeps {
  return {
    proxy: (r) => proxy(r, env),
    rt: async () => {
      const n = await activeEpoch(env);
      if (n === null) return null;
      const rt = rtOf(env, n) as RtEntry & { status(): Promise<{ state?: string }> };
      return {
        status: () => rt.status(),
        requestWake: (r) => rt.requestWake(r),
        sleepNow: (o) => rt.sleepNow(o),
        ownerStart: () => rt.ownerStart(),
      };
    },
    view: () => ctlOf(env).ownerView(),
    panel: async () => {
      const p = await ctlOf(env).ownerPanel({ origin: publicOrigin(env, req) });
      return Array.isArray(p?.connected) ? p : null;
    },
    ops: (r) =>
      ctlOf(env).ops({
        ...r,
        sub: r.sub ?? [],
        query: {},
        body: r.body ?? {},
        role: "owner",
        sink: sinkOf(env),
        fresh: freshOf(env),
      }),
    waitUntil: (p) => ctx.waitUntil(p),
  };
}

function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ctl = ctlOf(env);
  // Test install: the Worker's Bot API calls go to a fake that rings (ctl/test-telegram.ts).
  const f: typeof fetch =
    env.OC_TEST === "1"
      ? testTelegramFetch(fetch, (src, kind, detail) =>
          ctl.ring({ src, kind, detail }).catch(() => undefined),
        )
      : fetch;
  return handleWebhook(req, {
    env,
    ctl: {
      webhookPrevOk: () => ctl.webhookPrevOk(),
      // A held row moves the asleep alarm to oldestHeld + heldMaxMs (§11.2): ensure() re-plans it.
      inboxPut: async (p) => {
        const r = await ctl.inboxPut(p, freshOf(env));
        if (r.status === 200 && "state" in r && r.state === "held") {
          ctx.waitUntil(
            activeEpoch(env)
              .then((n) => (n === null ? undefined : rtOf(env, n).ensure()))
              .catch(() => undefined),
          );
        }
        return r;
      },
    },
    wake: async () => {
      const n = await activeEpoch(env);
      if (n !== null) await rtOf(env, n).requestWake("webhook");
    },
    progress: async (chat) => {
      let msg: number | null = null;
      await tgCall(
        f,
        env.OC_SECRET_OC_TELEGRAM_BOT_TOKEN ?? "",
        "sendMessage",
        { chat_id: chat, text: firstText(), disable_notification: true },
        (j) => {
          const id = (j as { result?: { message_id?: unknown } } | null)?.result?.message_id;
          msg = typeof id === "number" ? id : null;
        },
      );
      await ctl.progressSent(chat, msg);
    },
    typing: (chat) => sendTyping(f, env.OC_SECRET_OC_TELEGRAM_BOT_TOKEN ?? "", chat),
    answerInline: async (id, cold) => {
      const token = env.OC_SECRET_OC_TELEGRAM_BOT_TOKEN ?? "";
      if (token) await tgCall(f, token, "answerInlineQuery", inlineAnswer(id, cold));
    },
    waitUntil: (p) => ctx.waitUntil(p),
  });
}

/** Slack, Discord, Twilio: the adapter verifies and answers; the row goes through the same inbox hand-off. */
async function adapterHook(
  a: NonNullable<ReturnType<typeof adapterByPath>>,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const ctl = ctlOf(env);
  // A secret adopted from the UI lives in the Control DO, not in this env (ctl/adopt.ts). Worker secrets win.
  let secrets = platformSecrets(env);
  if (a.secrets.some((n) => !secrets[n]))
    secrets = {
      ...(await Promise.resolve()
        .then(() => ctl.adoptedSecrets())
        .catch(() => ({}) as Record<string, string>)),
      ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)),
    };
  return handleAdapter(req, a, {
    secrets,
    ctl: {
      hookSeen: (id, kind) => ctl.hookSeen(id, kind),
      inboxPut: async (p) => {
        // M7 F1: this isolate's env is newer than the Control DO's; the replay driver signs with it.
        const r = await ctl.inboxPut(p, freshOf(env));
        if (r.status === 200 && "state" in r && r.state === "held")
          ctx.waitUntil(
            activeEpoch(env)
              .then((n) => (n === null ? undefined : rtOf(env, n).ensure()))
              .catch(() => undefined),
          );
        return r;
      },
    },
    wake: async () => {
      const n = await activeEpoch(env);
      if (n !== null) await rtOf(env, n).requestWake("webhook");
    },
    waitUntil: (p) => ctx.waitUntil(p),
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // Opt-in Access front door (ACCESS_AUD set): JWT on the custom domain, redirect from workers.dev. Webhook routes stay open.
    const hook = adapterByPath(url.pathname);
    const denied = await accessGate(req, env, isWebhook(req) || isHook(req) || hook !== undefined);
    if (denied) return denied;
    if (isWebhook(req)) return webhook(req, env, ctx);
    if (hook) return adapterHook(hook, req, env, ctx);
    // Secret-path hook: wrong path → 404 before any header check; then the same handler and inbox hand-off.
    if (isHook(req)) return (await hookPathOk(req, env)) ? webhook(req, env, ctx) : notFound();
    if (url.pathname === "/ops/auth" || url.pathname.startsWith("/ops/auth/"))
      return handleOpsAuth(req, env, await roleOf(req, env));
    if (url.pathname === "/ops/gate" || url.pathname.startsWith("/ops/gate/"))
      return (await roleOf(req, env)) === "owner" ? capGateForOwner(req, env, ctx) : notFound();
    if (url.pathname === "/ops" || url.pathname.startsWith("/ops/"))
      return handleOps(req, env, () => activeEpoch(env));
    if (url.pathname.startsWith("/_ochost/")) return handleOchost(req, env, ingressDeps(env, ctx, req));
    // Owner status page, or the login form for no session (same on the custom domain and workers.dev).
    if (url.pathname === "/") return handleRoot(req, env, ingressDeps(env, ctx, req));
    // M3: every proxied path needs the owner cookie (a bearer is not enough). No cookie → 404, no wake.
    return handleProxied(req, env, ingressDeps(env, ctx, req));
  },

  /** 5-min cron → ctl.ensure() (§19.3). Never throws. */
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      ctlOf(env)
        .ensure()
        .then(() => undefined)
        .catch((e: unknown) => console.error(`cron ensure: ${e instanceof Error ? e.message : String(e)}`)),
    );
  },
} satisfies ExportedHandler<Env>;
