// /ops/* routes (spec 08 §19.2): bearer auth and routing. The Control DO serves the actions (ctl.ops);
// /ops/fault hooks for the Runtime DO go to rt.fault (OC_TEST=1 only).
import { sha256Hex } from "./core/ids";
import { secretEnv } from "./core/secret-env";
import { ctlName, type Env, rtName } from "./core/types";
import { platformSecrets } from "./ctl/adapters";
import type { FreshSecrets } from "./ctl/control";
import { handleTelegramOps, publicOrigin } from "./ops-telegram";
import { sbxName } from "./sbx/core";

export type OpsRole = "owner" | "ci";

/** Routes the CI token may call (§19.2 "ci" column). Every other route answers 404 for ci. */
const CI_ALLOWED = new Set(["status", "idle", "images-in-use", "ci", "deploy-check"]);
/** Routes that exist in M2. A path not listed → 404 for both roles. */
const ROUTES = new Set([
  "status",
  "idle",
  "images-in-use",
  "ci",
  "deploy-check",
  "wake",
  "start",
  "stop",
  "restart",
  "sleep",
  "epoch",
  "restore",
  "config",
  "settings",
  "creds",
  "inbox",
  "secrets-changed",
  "events",
  "logs",
  "alerts",
  "gc",
  "archive",
  "fault",
  // SoakPlan (OC_TEST=1 only): queue, list, stop and read soak plans. docs/17-soak-engine.md.
  "soak-plan",
  // M5 (docs/10-cli-spec.md §1.3): W1 pairing, W5 snapshot list, W8 Telegram webhook through the Worker.
  "pairing",
  "snapshots",
  "telegram",
  // D14 CapGate budgets: GET reads, POST raises (owner only).
  "caps",
  // docs/11 §8: GET file storage usage; POST /ops/files/purge deletes f/<inst>/ (ochost destroy --delete-data).
  "files",
  // docs/12: GET sandbox state and budgets; POST /ops/sandbox/sleep backs up and stops it.
  "sandbox",
  // Owner panel: GET /ops/doctor is the panel JSON (ctl/panel.ts); POST /ops/upgrade-check records `ochost upgrade check`.
  "doctor",
  "upgrade-check",
  // `ochost deploy` and `config render` report the CLI's config render version (POST); the panel compares it.
  "render-check",
]);

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

/** Constant-time compare of sha256(bearer) against sha256(token) (§19.2). */
async function tokenMatches(bearer: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [a, b] = await Promise.all([sha256Hex(bearer), sha256Hex(token)]);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0 && a.length === b.length;
}

export async function roleOf(req: Request, env: Env): Promise<OpsRole | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const bearer = (m[1] as string).trim();
  if (await tokenMatches(bearer, env.CONTROL_TOKEN)) return "owner";
  if (await tokenMatches(bearer, env.CI_TOKEN)) return "ci";
  return null;
}

interface CtlOps {
  ops(r: {
    action: string;
    method: string;
    sub: string[];
    query: Record<string, string>;
    body: Record<string, unknown>;
    role: OpsRole;
    sink?: { url: string | null; token: string | null };
    fresh?: FreshSecrets;
  }): Promise<{ status: number; body: unknown }>;
}

/**
 * W11 (M5): the Control DO reads ALERT_URL/ALERT_TOKEN from its env when it is built, and a long-lived DO kept
 * the old sink > 114 s after `wrangler secret put` (oc-m5b-wk). The Worker isolate of the new version has the
 * new values: /ops calls hand them over, so `alerts setup` then `alerts test` uses the new sink at once.
 * guess: a deleted ALERT_URL (`alerts setup --channel none`) still waits for a DO restart (not handed over).
 */
export const sinkOf = (env: Env) =>
  env.ALERT_URL ? { url: env.ALERT_URL, token: env.ALERT_TOKEN ?? null } : undefined;
/** M7 F1: same hand-over for the adapter secrets and the bot token (ctl/control.ts FreshSecrets). */
export const freshOf = (env: Env): FreshSecrets => ({
  platform: platformSecrets(env),
  botToken: env.OC_SECRET_OC_TELEGRAM_BOT_TOKEN || undefined,
  version: env.CF_VERSION?.id || undefined,
});
interface RtOps {
  fault(name: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  status(): Promise<unknown>;
  freshSecretEnv?(m: Record<string, string>, version?: string): Promise<number>;
  buildStale?(): Promise<boolean>;
}

/**
 * M7 F1, Runtime side: the container env comes from the Runtime DO's env, which is as old as the DO. Before an
 * owner action that can start the container, hand it this isolate's OC_SECRET_* values (`channels add` puts a
 * secret, sends secrets-changed, then restarts).
 */
const RT_FRESH = new Set(["secrets-changed", "restart", "start", "wake"]);
export async function freshRt(env: Env, activeEpoch: () => Promise<number | null>): Promise<boolean> {
  try {
    const n = await activeEpoch();
    if (n === null) return false;
    const rt = env.RUNTIME.getByName(rtName(env.OC_INST, n)) as unknown as RtOps;
    if (typeof rt.freshSecretEnv !== "function") return false;
    // The Worker version tells the Runtime DO it is older than the deploy: a restart then recycles it (rt/core.ts).
    await rt.freshSecretEnv(secretEnv(env), env.CF_VERSION?.id);
    return true;
  } catch {
    return false;
  }
}

/** Is the Runtime DO older than this Worker version (a deploy since it was built)? Its container image map is too. */
async function rtStale(env: Env, activeEpoch: () => Promise<number | null>): Promise<boolean> {
  try {
    const n = await activeEpoch();
    if (n === null) return false;
    const rt = env.RUNTIME.getByName(rtName(env.OC_INST, n)) as unknown as RtOps;
    return typeof rt.buildStale === "function" ? await rt.buildStale() : false;
  } catch {
    return false;
  }
}

/** Runtime-side fault names (§19.2 /ops/fault); the rest go to the Control DO. */
export const RT_FAULTS = new Set([
  "destroy-timeout",
  "capacity",
  "snapshot-not-found",
  "hung-inspect",
  "hung-start",
  "hung-destroy",
  "hb-drop",
  "sigkill",
  "exec",
  "drop-wake",
  "sleep-at",
  "destroy",
  "signal",
  "abort",
  "clear",
]);

export async function handleOps(
  req: Request,
  env: Env,
  activeEpoch: () => Promise<number | null>,
): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const action = parts[0] ?? "";
  const role = await roleOf(req, env);
  if (!role || !ROUTES.has(action)) return notFound();
  if (role === "ci" && !CI_ALLOWED.has(action)) return notFound();
  if ((action === "fault" || action === "soak-plan") && env.OC_TEST !== "1") return notFound();
  let body: Record<string, unknown> = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    const t = await req.text();
    if (t) {
      try {
        const j = JSON.parse(t);
        if (j && typeof j === "object" && !Array.isArray(j)) body = j as Record<string, unknown>;
      } catch {
        return Response.json({ error: "bad json" }, { status: 400 });
      }
    }
  }
  const query = Object.fromEntries(url.searchParams);
  // The panel compares webhook URLs with this Worker's own origin; a caller cannot choose it.
  if (action === "doctor") query.origin = publicOrigin(env, req);
  if (action === "fault") {
    const name = String(body.name ?? parts[1] ?? "");
    if (RT_FAULTS.has(name)) {
      const n = await activeEpoch();
      if (n === null) return Response.json({ error: "no-active-epoch" }, { status: 409 });
      const rt = env.RUNTIME.getByName(rtName(env.OC_INST, n)) as unknown as RtOps;
      return Response.json(await rt.fault(name, (body.params as Record<string, unknown>) ?? {}));
    }
  }
  if (RT_FRESH.has(action) && req.method === "POST") await freshRt(env, activeEpoch);
  // `ochost restart` after a deploy: the Control DO takes a pre-restart archive and the answer says so.
  if (action === "restart" && req.method === "POST") body.redeploy = await rtStale(env, activeEpoch);
  const ctl = env.CONTROL.getByName(ctlName(env.OC_INST)) as unknown as CtlOps;
  // W8: the bot token and the webhook secret are Worker env; the Control DO only records (ops-telegram.ts).
  if (action === "telegram") {
    const r = await handleTelegramOps(req, env, parts.slice(1), body, (a) =>
      ctl.ops({ action: "telegram-int", method: "POST", sub: a.sub, query: {}, body: a.body, role }),
    );
    return Response.json(r.body, { status: r.status });
  }
  if (action === "sandbox") return opsSandbox(env, ctl, role, req.method, parts[1] ?? "");
  // /ops/wake?wait=1 long-polls to `started` (≤ 120 s).
  if (action === "wake" && query.wait === "1") {
    const first = await ctl.ops({
      action,
      method: req.method,
      sub: parts.slice(1),
      query,
      body,
      role,
      sink: sinkOf(env),
      fresh: freshOf(env),
    });
    const n = await activeEpoch();
    if (n === null) return Response.json(first.body, { status: first.status });
    const rt = env.RUNTIME.getByName(rtName(env.OC_INST, n)) as unknown as RtOps;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const s = (await rt.status().catch(() => null)) as { state?: string } | null;
      if (s?.state === "running")
        return Response.json({ ...(first.body as object), state: "running", waitedMs: Date.now() - t0 });
      await new Promise((r) => setTimeout(r, 1000));
    }
    return Response.json({ ...(first.body as object), timeout: true }, { status: 504 });
  }
  const r = await ctl.ops({
    action,
    method: req.method,
    sub: parts.slice(1),
    query,
    body,
    role,
    sink: sinkOf(env),
    fresh: freshOf(env),
  });
  return Response.json(r.body, { status: r.status });
}

interface SbxOps {
  status(): Promise<unknown>;
  sleep(reason: "owner"): Promise<unknown>;
}

/** docs/12 §7: sandbox state (SandboxSession DO) and its two budgets (Control DO caps). Never wakes it. */
async function opsSandbox(
  env: Env,
  ctl: CtlOps,
  role: OpsRole,
  method: string,
  sub: string,
): Promise<Response> {
  if (!env.SANDBOX) return Response.json({ error: "no SANDBOX binding; redeploy" }, { status: 503 });
  const sb = env.SANDBOX.getByName(sbxName(env.OC_INST)) as unknown as SbxOps;
  if (method === "POST" && sub === "sleep") return Response.json(await sb.sleep("owner"));
  if (method !== "GET" || sub) return notFound();
  const caps = await ctl.ops({ action: "caps", method: "GET", sub: [], query: {}, body: {}, role });
  const v = (caps.body ?? {}) as { verbs?: Record<string, unknown> };
  return Response.json({
    ...((await sb.status()) as object),
    exec: v.verbs?.exec,
    sandbox: v.verbs?.sandbox,
  });
}
