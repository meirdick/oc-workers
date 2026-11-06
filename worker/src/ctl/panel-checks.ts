// Owner panel checks (docs/10-cli-spec.md §1.2 doctor, addendum §5.2). Pure: facts in, a green/yellow/red row with
// a "you see, do this" fix line out. Shared by the Control DO (ctl/panel.ts), the owner page and `ochost doctor`.
// No imports: the CLI loads this file too.

export type Result = "PASS" | "WARN" | "FAIL";
export interface Check {
  name: string;
  result: Result;
  detail: string;
  fix?: string;
}

export const pass = (name: string, detail: string): Check => ({ name, result: "PASS", detail });
export const warn = (name: string, detail: string, fix: string): Check => ({
  name,
  result: "WARN",
  detail,
  fix,
});
export const fail = (name: string, detail: string, fix: string): Check => ({
  name,
  result: "FAIL",
  detail,
  fix,
});

const DAY = 86_400_000;

/** 90 s, 12m, 5h, 3d (same words as the CLI's fmtDur). */
export function dur(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** The newest model hop the Control DO ran through the gate (cached one minute). */
export interface HopInfo {
  at: number;
  model: string;
  status: number;
  ms: number;
  error?: string;
}
/** The newest Telegram getWebhookInfo the Control DO read with the bot token (cached one minute). */
export interface WebhookInfo {
  at: number;
  ok: boolean;
  url: string;
  pending: number;
  lastError: string | null;
  error?: string;
}

/** Webhook URL values the Worker manages (W2: the secret path once it lands). `origin` null: host not checked. */
export function managedWebhook(origin: string | null, v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (origin === null) return v.endsWith("/telegram-webhook") || v.includes("/_ochost/hook/telegram/");
  return v === `${origin}/telegram-webhook` || v.startsWith(`${origin}/_ochost/hook/telegram/`);
}

/**
 * Model and provider URL from the OpenClaw config doc (spec §2.8). `direct` = a config from before the zero-token
 * install: the provider calls the AI Gateway itself with a token header.
 */
export function gatewayOf(
  doc: any,
): { provider: string; baseUrl: string; model: string; direct: boolean } | null {
  const providers = doc?.models?.providers ?? {};
  const primary = String(doc?.agents?.defaults?.model?.primary ?? "");
  for (const [name, p] of Object.entries<any>(providers)) {
    if (typeof p?.baseUrl !== "string" || !primary.startsWith(`${name}/`)) continue;
    const direct = p.baseUrl.includes("gateway.ai.cloudflare.com");
    if (!direct && !p.baseUrl.includes("15.0.0.3")) continue;
    return {
      provider: name,
      baseUrl: p.baseUrl.replace(/\/+$/, ""),
      model: primary.slice(name.length + 1),
      direct,
    };
  }
  return null;
}

export function checkState(s: any): Check {
  if (s?.ctlState && s.ctlState !== "ok")
    return fail("state", `control state ${s.ctlState}`, "ochost logs --source ctl; ochost status");
  if (s?.state === "restore-blocked")
    return fail("state", "restore-blocked", "ochost backup list, then ochost backup restore <id>");
  if (s?.degraded) return warn("state", `${s.state}, degraded`, "ochost logs --source rt; ochost restart");
  const lv = s?.ladder?.level;
  if (lv === "slow" || (typeof lv === "number" && lv > 1))
    return warn("state", `${s.state}, start ladder level ${lv}`, "ochost logs --source rt");
  return pass("state", String(s?.state ?? "unknown"));
}

export function checkWebhook(origin: string | null, doc: any, s: any): Check {
  const tg = doc?.channels?.telegram;
  const open = (s?.alerts ?? []).filter((a: any) => /webhook|telegram/.test(String(a.class)));
  if (!tg || tg.enabled === false)
    return warn("webhook", "no Telegram channel", "ochost channels add telegram");
  if (!managedWebhook(origin, tg.webhookUrl))
    return fail(
      "webhook",
      `webhookUrl is ${tg.webhookUrl ? "not the managed route" : "not set"}`,
      "ochost channels add telegram (sets it again)",
    );
  if (open.length)
    return fail(
      "webhook",
      `open alert ${open.map((a: any) => a.class).join(", ")}`,
      "ochost logs --source ocsup; ochost restart",
    );
  return pass("webhook", "set to the managed route");
}

/** Telegram's own view (getWebhookInfo through the Worker). Null: no bot token or no probe yet. */
export function checkWebhookLive(origin: string | null, w: WebhookInfo | null): Check | null {
  if (!w) return null;
  const name = "webhook (Telegram)";
  if (w.error) return warn(name, "Telegram did not answer", "rerun");
  if (!w.ok) return fail(name, "getWebhookInfo refused the token", "copy the token from @BotFather again");
  if (!managedWebhook(origin, w.url))
    return fail(
      name,
      `Telegram has ${w.url ? "another URL" : "no URL"}`,
      "ochost restart (the gateway sets it again)",
    );
  if (w.lastError) return warn(name, `last error: ${w.lastError}`, "ochost logs --source ocsup");
  return pass(name, `set, ${w.pending} pending`);
}

/** One chat call through the gate (the Worker's AI binding): no token on the owner's machine. */
export function checkHop(doc: any, h: HopInfo | null): Check {
  const gw = gatewayOf(doc);
  if (!gw) return warn("model hop", "no model in the config", "ochost ai-gateway setup");
  if (gw.direct)
    return warn(
      "model hop",
      "the config still calls the gateway with a token header",
      "ochost ai-gateway setup (renders the gate provider), then ochost restart",
    );
  if (!h) return warn("model hop", "not checked yet", "ochost doctor (it checks now)");
  if (h.status === 200) return pass("model hop", `200 in ${h.ms} ms (${gw.model}) through the gate`);
  if (h.status === 404)
    return fail("model hop", "the Worker has no AI gate (404)", "ochost deploy updates the Worker");
  if (h.status === 0) return warn("model hop", "no answer in 30 s", "check the network; rerun");
  const why = h.error ? ` ${h.error.slice(0, 120)}` : "";
  if (h.status === 429 || h.status >= 500)
    return warn("model hop", `${h.status} in ${h.ms} ms${why}`, "rerun in 1 min; ochost logs --source ctl");
  return fail(
    "model hop",
    `${h.status}${why}`,
    /gateway/i.test(h.error ?? "")
      ? "the gateway does not exist: ochost ai-gateway setup --gateway default"
      : "ochost model list, then ochost model set <id>; for anthropic/ models add the key to the gateway (docs/09)",
  );
}

/** The newest file storage probe (PUT, GET, DELETE of 1 byte under f/<inst>/), cached one minute. */
export interface FilesProbe {
  at: number;
  ok: boolean;
  ms: number;
  error?: string;
}

/** Bytes, decimal: 1.2 GB, 340 MB, 12 kB. */
export function bytesStr(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

/**
 * Capability row "file storage" (docs/11 §8): storage location r2 on the install's R2 bucket through the gate.
 * Off when the config has no location r2 of provider ochost-r2. FAIL when the probe fails; the cap colors the rest.
 */
export function checkFiles(
  doc: any,
  p: FilesProbe | null,
  v: { used: number; limit: number } | null,
  next: number,
): Check {
  const name = "file storage";
  if (doc?.storage?.locations?.r2?.provider !== "ochost-r2")
    return warn(name, "off (no storage location r2)", "ochost config render, then ochost restart");
  if (!p) return warn(name, "not checked yet", "ochost doctor (it checks now)");
  if (!p.ok)
    return fail(
      name,
      `probe failed: ${p.error ?? "unknown"}`,
      "ochost logs --source ctl; check the R2 bucket binding (ochost deploy)",
    );
  const use = v ? `; ${bytesStr(v.used)} of ${bytesStr(v.limit)} used` : "";
  const detail = `on, location r2, put+get+delete ${p.ms} ms${use}`;
  const pct = v && v.limit > 0 ? v.used / v.limit : 0;
  const fix = `ochost caps set storage ${next}`;
  if (pct >= 1) return fail(name, `${detail}; writes are refused`, fix);
  if (pct >= 0.8) return warn(name, detail, fix);
  return pass(name, detail);
}

export function checkReplica(s: any): Check {
  const why: string[] = [];
  if (s?.rpo === "seeding") why.push("replica seeding");
  if ((s?.blockers ?? []).includes("inbox-unreplicated")) why.push("inbox rows not replicated");
  if (s?.tier && s.tier !== "normal") why.push(`write tier ${s.tier}`);
  if (s?.rt?.hb?.rpo && s.rt.hb.rpo !== "ok" && s.rt.hb.rpo !== "seeding") why.push(`rpo ${s.rt.hb.rpo}`);
  if ((s?.inbox?.dead ?? 0) > 0) why.push(`${s.inbox.dead} dead inbox rows`);
  if (why.length)
    return warn("replica lag", why.join(", "), "ochost logs --source gate; wait for the next sync");
  return pass("replica lag", "ok");
}

export function checkArchive(a: any, state: string): Check {
  const age: number | null = a?.newestAgeMs ?? null;
  const every: number = a?.cfg?.everyMs ?? 6 * 3_600_000;
  if (age === null) return warn("archive age", "no archive yet", "ochost backup create");
  if (state === "running" && age > 2 * every)
    return fail(
      "archive age",
      `newest ${dur(age)} old while awake (cadence ${dur(every)})`,
      "ochost backup create; ochost logs --source gate",
    );
  if (age > 7 * DAY) return warn("archive age", `newest ${dur(age)} old`, "ochost backup create");
  const d = a?.drill;
  if (d && d.ok === false)
    return warn("archive age", `newest ${dur(age)} old; last drill failed`, "ochost logs --source ctl");
  return pass("archive age", `newest ${dur(age)} old`);
}

/** The alert sink as `GET /ops/alerts` reports it (`sinkInfo`): configured, kind, acked. */
export interface Sink {
  configured?: boolean;
  kind?: string | null;
  ackedAt?: number | null;
  lastOkAt?: number | null;
  failing?: boolean;
  heartbeatAt?: number | null;
}

export function checkAlerts(s: any, sink: Sink | null): Check {
  const open: any[] = (s?.alerts ?? []).filter((a: any) => a.open !== 0 && a.open !== false);
  const high = open.filter((a) => a.severity === "high");
  if (high.length)
    return fail("alerts", `open: ${high.map((a) => a.class).join(", ")}`, "ochost alerts list; ochost logs");
  if (!sink?.configured) return warn("alerts", "not set up", "ochost alerts setup");
  const kind = sink.kind ?? "sink";
  // Z2.9: a sink that never took an alert, or whose newest send failed, is a silent dead-man.
  if (!sink.lastOkAt)
    return fail(
      "alerts",
      `${kind} sink never acked an alert`,
      "ochost alerts test; ochost logs --source alert",
    );
  if (sink.failing)
    return fail(
      "alerts",
      `${kind} sink: newest send failed`,
      "ochost logs --source alert; ochost alerts setup",
    );
  if (!sink.ackedAt)
    return warn(
      "alerts",
      `${kind}, test alert not confirmed`,
      "ochost alerts ack <code>, or ochost alerts test",
    );
  if (open.length)
    return warn("alerts", `open: ${open.map((a) => a.class).join(", ")}`, "ochost alerts list");
  return pass("alerts", `${kind}, confirmed`);
}

export function checkDeadman(s: any): Check {
  if (s?.deadman?.silent)
    return fail(
      "dead-man",
      "CI dead-man silent over 2 h (workflow disabled?)",
      "gh workflow enable oc-host.yml",
    );
  if (s?.ci) return pass("dead-man", "CI workflow set");
  if (s?.sink?.heartbeatAt) return pass("dead-man", "daily heartbeat alert");
  return warn("dead-man", "no out-of-band dead-man", "ochost ci setup");
}

/** One daily budget: red at the limit, yellow from 80 %. The fix line names the doubled limit the Raise button sets. */
export function checkBudget(verb: string, used: number, limit: number, unit: string, next: number): Check {
  const pct = limit > 0 ? used / limit : 1;
  const n = (x: number) => (unit === "h" ? x.toFixed(2) : String(Math.round(x)));
  const detail = `${n(used)}${unit} of ${limit}${unit} (${Math.round(pct * 100)}%)`;
  const fix = `ochost caps set ${verb} ${next}`;
  if (pct >= 1) return fail(verb, `${detail}; calls are refused until midnight UTC`, fix);
  if (pct >= 0.8) return warn(verb, detail, fix);
  return pass(verb, detail);
}

/** The fix line per open alert class (the panel's Alerts rows, the Retry now hint on `/`). */
const ALERT_FIX: [RegExp, string][] = [
  [/^restore-blocked|^ctl-rewound|^snapshots-lost/, "ochost backup list, then ochost backup restore <id>"],
  [/^doctor-failed/, "ochost logs --source rt; ochost restart"],
  [/^alert-test/, "ochost alerts ack <code>"],
  [/webhook|telegram/, "ochost logs --source ocsup; ochost restart"],
  [/^sbx-/, "ochost sandbox status; ochost logs --source ctl"],
  [/^cap-|budget/, "ochost caps"],
  [/^storage-cap/, "ochost caps; ochost caps set storage <n>, or delete files"],
  [/gate|replica|r2/, "ochost logs --source gate"],
  [/archive|drill/, "ochost backup list; ochost logs --source ctl"],
  [/^upgrade-regression/, "ochost upgrade rollback"],
];
export const alertFix = (cls: string) =>
  ALERT_FIX.find(([re]) => re.test(cls))?.[1] ?? "ochost logs; ochost alerts list";

/** Raise: double the limit, a zero limit goes to the default, never past `max` (POST /ops/caps refuses more). */
export function raiseTo(limit: number, dflt: number, max = 1e9): number {
  return Math.min(max, limit > 0 ? limit * 2 : dflt);
}
