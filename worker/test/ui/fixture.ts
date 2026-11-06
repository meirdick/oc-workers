// Owner console fixture for screenshots (worker/test/ui/shoot.mjs). The real Worker routes (src/index.ts) and the
// real Auth DO under `wrangler dev` with OC_TEST=1; the Control DO and Runtime DO are fakes that answer from one of
// three states. GET /_fx/<asleep|running|backoff> picks the state (a cookie) and redirects to `/`. Local only.
import type { OwnerView } from "../../src/core/types";
import type { Panel } from "../../src/ctl/panel";
import worker from "../../src/index";

export { Auth } from "../../src/ingress/auth-do";

type Fx = "asleep" | "running" | "backoff";
const MIN = 60_000;
const H = 60 * MIN;

function panelOf(fx: Fx, now: number): Panel {
  const asleep = fx === "asleep";
  const view: OwnerView = {
    inst: "oc-meir",
    state: fx,
    stateAt: now - (fx === "asleep" ? 3 * H : fx === "running" ? 12 * MIN : 4 * MIN),
    lastActivityAt: now - (fx === "asleep" ? 3 * H + 12 * MIN : 2 * MIN),
    nextWakeAt: asleep ? now + 47 * MIN : null,
    snapshots: 14,
    alerts: [],
    now,
  };
  const cached = asleep ? " (cached 3h ago, install asleep)" : "";
  const ws = fx === "running" ? 85 : 12;
  const budget = (verb: string, used: number, limit: number, unit = "") => {
    const pct = used / limit;
    const result = pct >= 1 ? "FAIL" : pct >= 0.8 ? "WARN" : "PASS";
    return {
      verb,
      used,
      limit,
      pct,
      unit,
      next: limit * 2,
      row: {
        name: verb,
        result,
        detail: `${used}${unit} of ${limit}${unit} (${Math.round(pct * 100)}%)`,
        ...(result !== "PASS" ? { fix: `ochost caps set ${verb} ${limit * 2}` } : {}),
      },
    } as Panel["budgets"][number];
  };
  const open: Panel["alerts"]["open"] =
    fx === "backoff"
      ? [
          {
            class: "doctor-failed",
            severity: "high",
            result: "FAIL",
            at: now - 4 * MIN,
            count: 3,
            detail:
              "Doctor failed 3x on sha256:4b1c; booting without Doctor: EACCES: permission denied, open '/data/.openclaw/state.db'",
            fix: "ochost logs --source rt; ochost restart",
          },
          {
            class: "replica-lag",
            severity: "warn",
            result: "WARN",
            at: now - 26 * MIN,
            count: 1,
            detail: "replica 9 min behind",
            fix: "ochost logs --source ocsup",
          },
        ]
      : [];
  return {
    inst: "oc-meir",
    now,
    view,
    render: { docVersion: 3, cliVersion: 3, outdated: false },
    probes: { asleep, hopAt: now - 3 * H, webhookAt: now - 3 * H },
    ok: fx !== "backoff",
    fails: fx === "backoff" ? 1 : 0,
    warns: fx === "running" ? 2 : fx === "backoff" ? 2 : 1,
    checks: [],
    connected: [
      {
        name: "model",
        result: "PASS",
        detail: `cfgw, @cf/deepseek-ai/deepseek-v4.1-flash-1017, gateway default, last hop 412 ms${cached}`,
      },
      {
        name: "web search",
        result: fx === "running" ? "WARN" : "PASS",
        detail: `on; ${ws} of 100 today`,
        ...(fx === "running" ? { fix: "ochost caps set websearch 200" } : {}),
      },
      { name: "browser and web fetch", result: "PASS", detail: "on; 40s of 3600s today; 31 of 2000 today" },
      {
        name: "media",
        result: "PASS",
        detail: "speech on, transcription on, image on; 1200 of 10000 neurons",
      },
      fx === "running"
        ? { name: "sandbox", result: "PASS", detail: "on, running; 120s of 1800s today; 0.4h of 4h today" }
        : { name: "sandbox", result: "PASS", detail: "off (opt-in)", fix: "ochost sandbox on" },
      {
        name: "channel telegram",
        result: "PASS",
        detail: `transport webhook, webhook set, last error none, blocks sleep no${cached}`,
      },
      fx === "running"
        ? { name: "access", result: "PASS", detail: "on, domain oc.meir.dev, team meir" }
        : {
            name: "access",
            result: "PASS",
            detail: "off",
            fix: "ochost auth access (opt-in, recommended on a custom domain)",
          },
      fx === "asleep"
        ? {
            name: "alerts sink",
            result: "WARN",
            detail: "ntfy, configured, test not acked",
            fix: "ochost alerts test, then ochost alerts ack <code>",
          }
        : { name: "alerts sink", result: "PASS", detail: "ntfy, configured, acked 2d ago" },
      {
        name: "install",
        result: "PASS",
        detail: "CLI 0.9.2, image sha256:4b1c9e07a2d3, OpenClaw 2026.10.28, no upgrade (checked 5h ago)",
      },
      { name: "config render", result: "PASS", detail: "render 3, CLI 3" },
    ],
    alerts: {
      open,
      closed: [
        {
          class: "sleep-thrash",
          severity: "warn",
          result: "WARN",
          at: now - 20 * H,
          count: 1,
          detail: "cost guard holds the container awake (24 h spend 0.0310 USD)",
          fix: "ochost sleep status",
        },
        {
          class: "webhook-errors",
          severity: "info",
          result: "PASS",
          at: now - 2 * 24 * H,
          count: 4,
          detail: "Telegram reported 4 delivery errors; last: Connection timed out",
          fix: "ochost doctor",
        },
      ],
      doctorTail: fx === "backoff" ? "EACCES: permission denied, open '/data/.openclaw/state.db'" : null,
    },
    budgets: [
      budget("websearch", ws, 100),
      budget("browser", 40, 3600, "s"),
      budget("requests", 31, 2000),
      budget("neurons", 1200, 10000),
    ],
    backups: {
      rows: [
        { name: "archive", result: "PASS", detail: "newest 9h old; verified" },
        { name: "snapshots", result: "PASS", detail: "14 snapshots, chain 4" },
        fx === "backoff"
          ? { name: "replica lag", result: "WARN", detail: "9 min", fix: "ochost logs --source ocsup" }
          : { name: "replica lag", result: "PASS", detail: asleep ? "asleep, flushed" : "4 s" },
        { name: "next maintenance", result: "PASS", detail: "in 15h" },
      ],
      nextMaintenanceAt: now + 15 * H,
    },
    channels: {
      wake: { userIds: ["51234987"], groupChatIds: [] },
      pairing: fx === "running" ? [{ code: "k7m2qa", id: "88213", name: "Dana", count: 2, held: 1 }] : [],
      heldInbox: fx === "running" ? 1 : 0,
    },
    cost: {
      spend24Usd: fx === "running" ? 0.0861 : 0.0412,
      monthUsd: fx === "running" ? 2.58 : 1.24,
      alwaysOnMonthUsd: 31.5,
      savedPct: fx === "running" ? 92 : 96,
      wakes24: 4,
      holding: false,
    },
    chat: {
      days: [3, 7, 12, 5, 0, 9, 4].map((received, i) => ({
        day: new Date(now - (6 - i) * 24 * H).toISOString().slice(0, 10),
        received,
        replied: i === 2 ? 11 : received,
      })),
      lastInAt: now - 2 * H,
      lastInRoute: "/telegram-webhook",
      lastOutAt: now - 2 * H + 40_000,
    },
    events: [
      ...(fx === "asleep"
        ? [{ at: now - 3 * H, kind: "sleep" as const, text: "Slept after 14m awake", ms: 11_000 }]
        : []),
      ...(fx === "backoff"
        ? [{ at: now - 4 * MIN, kind: "restart" as const, text: "Restarted (ladder)", ms: null }]
        : []),
      { at: now - 3 * H - 14 * MIN, kind: "wake" as const, text: "Woke on webhook", ms: 41_000 },
      { at: now - 6 * H, kind: "archive" as const, text: "Archive (daily), complete, 184 MB", ms: 96_000 },
      { at: now - 9 * H, kind: "sleep" as const, text: "Slept after 22m awake", ms: 9_000 },
      { at: now - 9 * H - 22 * MIN, kind: "wake" as const, text: "Woke on cron", ms: 38_000 },
      { at: now - 14 * H, kind: "restart" as const, text: "Restarted (owner-force)", ms: 47_000 },
      { at: now - 15 * H, kind: "sleep" as const, text: "Slept after 1h awake", ms: 12_000 },
      { at: now - 16 * H, kind: "wake" as const, text: "Woke on ui", ms: 44_000 },
      { at: now - 30 * H, kind: "archive" as const, text: "Archive (owner), complete, 181 MB", ms: 102_000 },
    ],
  };
}

const ns = (impl: Record<string, (...a: unknown[]) => unknown>) => ({
  getByName: () =>
    new Proxy(
      {},
      {
        get: (_t, m: string) =>
          m === "then" ? undefined : async (...a: unknown[]) => (impl[m] ? impl[m](...a) : { ok: true }),
      },
    ),
});

export default {
  async fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const pick = /^\/_fx\/(asleep|running|backoff)$/.exec(url.pathname);
    if (pick)
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": `fx=${pick[1]}; Path=/; SameSite=Lax` },
      });
    const fx = (/(?:^|; )fx=(asleep|running|backoff)/.exec(req.headers.get("cookie") ?? "")?.[1] ??
      "running") as Fx;
    const now = Date.now();
    const p = panelOf(fx, now);
    const e = {
      ...env,
      CONTROL: ns({
        status: () => ({ epoch: { n: 1 } }),
        ownerView: () => p.view,
        ownerPanel: () => p,
        ops: () => ({ status: 200, body: { ok: true } }),
      }),
      RUNTIME: ns({
        fetch: () => new Response("Control UI (fixture)", { headers: { "content-type": "text/plain" } }),
        status: () => ({ state: fx }),
        requestWake: () => ({ state: "starting", action: "start" }),
        sleepNow: () => ({ ok: true }),
        ownerStart: () => ({ ok: true, state: "starting" }),
      }),
    };
    return worker.fetch(req, e as never, ctx);
  },
};
