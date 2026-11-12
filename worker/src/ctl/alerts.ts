// Alerts table, dedupe and the alert sink (plan §9, §10; spec §17.2 `/v1/alert`). One send per class per hour.
// Writers: this module and the gates' ledger (same `alerts` table and dedupe rule). The sink scans the table for
// rows whose `last_sent_at` moved past the flush mark, so every writer reaches it. Sink: an HTTPS webhook, by
// default a token-protected ntfy topic (D9). Failed sends retry from `meta.alertRetry` (5 tries).
// M5: the sink format follows the URL (sinkKind): Slack and Discord incoming webhooks get JSON; every other
// URL gets the ntfy form (text body, title/priority/tags headers). A 429 waits for Retry-After (cap 1 h)
// before the next try. Each failure keeps the status and the start of the answer (ntfy: {code, error}).
import type { Severity } from "../core/types";
import { pruneAlertRows } from "../gates/ledger";
import { type Ctx, ring } from "./ctx";

const RANK: Record<Severity, number> = { info: 0, warn: 1, high: 2 };
const RETRY_MAX = 50;

export interface AlertRow {
  class: string;
  severity: Severity;
  last_sent_at: number | null;
  count: number;
  last_detail: string | null;
  open: number;
}

interface SendItem {
  cls: string;
  severity: Severity;
  detail: string;
  at: number;
  tries: number;
  /** Not before this time (429 Retry-After). */
  nextAt?: number;
}

export type SinkKind = "ntfy" | "slack" | "discord";

/** Sink format from the URL. Slack: hooks.slack.com/services|triggers|workflows; Discord: /api/webhooks. */
/**
 * The sink the Worker sends to. A URL the owner saved in the console (meta `alertSinkUrl`, no secret rights
 * needed) wins over the Worker secret ALERT_URL; the empty string means the owner turned alerts off.
 * A saved URL has no token: ALERT_TOKEN goes with the secret URL only.
 */
export function sinkUrl(c: Ctx): string | undefined {
  const saved = c.db.meta("alertSinkUrl");
  return saved === null ? c.secrets.alertUrl : saved || undefined;
}
const sinkToken = (c: Ctx) => (c.db.meta("alertSinkUrl") === null ? c.secrets.alertToken : undefined);

/** POST /ops/alerts/sink {url}: save the sink in the Control DO. `null` clears it (the Worker secret applies again); "" is off. */
export function setAlertSink(
  c: Ctx,
  url: unknown,
): { status: 200; body: Record<string, unknown> } | { status: 400; body: { error: string } } {
  if (url === null) {
    c.db.delMeta("alertSinkUrl");
    ring(c, "alert", "sink-set", { source: "secret" });
    return { status: 200, body: { ok: true, sink: sinkInfo(c) } };
  }
  if (typeof url !== "string") return { status: 400, body: { error: "url must be a string or null" } };
  const u = url.trim();
  if (u) {
    let ok = false;
    try {
      ok = new URL(u).protocol === "https:" && u.length <= 500;
    } catch {}
    if (!ok) return { status: 400, body: { error: "url must be an https URL of 500 characters or less" } };
  }
  c.db.setMeta("alertSinkUrl", u);
  if (!u) resolveAlert(c, ALERTS_NONE); // off is a normal state, not a fault
  ring(c, "alert", "sink-set", { source: u ? "console" : "off", kind: u ? sinkKind(u) : null });
  return { status: 200, body: { ok: true, sink: sinkInfo(c) } };
}

export function sinkKind(url: string): SinkKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "ntfy";
  }
  if (u.hostname === "hooks.slack.com") return "slack";
  if (/(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith("/api/webhooks/"))
    return "discord";
  return "ntfy";
}

export interface SinkError {
  cls: string;
  status: number | null;
  error: string;
  retryAfterS?: number;
}

const RETRY_AFTER_CAP_MS = 3_600_000;
const PRIORITY: Record<Severity, string> = { info: "2", warn: "3", high: "5" };

/** One HTTP request per alert, in the sink's format. */
export function sinkRequest(
  kind: SinkKind,
  inst: string,
  a: Pick<SendItem, "cls" | "severity" | "detail">,
  token?: string,
): RequestInit {
  const title = `oc-host ${inst}: ${a.cls}`;
  const text = `${a.severity.toUpperCase()} ${a.cls}${a.detail ? `\n${a.detail}` : ""}`;
  if (kind === "slack" || kind === "discord") {
    const line = `*${title}*\n${text}`;
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(kind === "slack" ? { text: line } : { content: line.slice(0, 1900) }),
    };
  }
  return {
    method: "POST",
    headers: {
      title,
      priority: PRIORITY[a.severity] ?? "3",
      tags: a.severity,
      "content-type": "text/plain; charset=utf-8",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: text,
  };
}

/** Retry-After (seconds or HTTP date) → ms, or null. */
function retryAfterMs(h: string | null, now: number): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

/** Record an alert. Returns true when it is due for the sink (first in its hour). Sync: safe in a transaction. */
export function alert(c: Ctx, cls: string, severity: Severity, detail = ""): boolean {
  const now = c.now();
  const row = c.db.one<AlertRow>("SELECT * FROM alerts WHERE class = ?", cls);
  const due = !row || row.last_sent_at === null || now - row.last_sent_at >= c.timers.alertDedupeMs;
  c.db.run(
    `INSERT INTO alerts (class, severity, last_sent_at, count, last_detail, open) VALUES (?, ?, ?, 1, ?, 1)
     ON CONFLICT(class) DO UPDATE SET severity = excluded.severity, count = count + 1,
       last_detail = excluded.last_detail, open = 1,
       last_sent_at = CASE WHEN ? THEN excluded.last_sent_at ELSE last_sent_at END`,
    cls,
    severity,
    now,
    detail.slice(0, 2000),
    due ? 1 : 0,
  );
  ring(c, "alert", cls, { severity, detail: detail.slice(0, 500), due });
  pruneAlertRows(c.db.store, cls); // sec F2: classes come from ocsup too
  return due;
}

/** Close an alert (resolved in /ops/status; the next alert of the class reopens it). */
export function resolveAlert(c: Ctx, cls: string): void {
  c.db.run("UPDATE alerts SET open = 0 WHERE class = ?", cls);
}

/**
 * POST /ops/alerts/close {class} (`ochost alerts close`, the console's Close): close one open alert, such as a stale
 * hello-flood of an old gen. 404 when no open alert has that class. The ring keeps who closed what.
 */
export function closeAlert(
  c: Ctx,
  cls: unknown,
  by: string,
): { status: number; body: Record<string, unknown> } {
  const k = typeof cls === "string" ? cls.trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(k)) return { status: 400, body: { error: "bad-class" } };
  const row = c.db.one<{ class: string }>("SELECT class FROM alerts WHERE class = ? AND open = 1", k);
  if (!row) return { status: 404, body: { error: "not-open", class: k } };
  resolveAlert(c, k);
  ring(c, "alert", "close", { class: k, by });
  return { status: 200, body: { ok: true, class: k } };
}

export function listAlerts(c: Ctx): AlertRow[] {
  return c.db.all<AlertRow>("SELECT * FROM alerts ORDER BY open DESC, last_sent_at DESC");
}

/** Rows due for the sink: last_sent_at past the mark, at or above the sink severity, plus retries. */
interface Mark {
  at: number;
  /** Classes already taken at exactly `at` (several alerts can share one ms). */
  cls: string[];
}

function dueItems(c: Ctx): { items: SendItem[]; mark: Mark } {
  const mark = c.db.metaJson<Mark>("alertMark", { at: 0, cls: [] });
  const min = RANK[c.settings().alerts.minSeverity];
  const rows = c.db
    .all<AlertRow>("SELECT * FROM alerts WHERE last_sent_at >= ? ORDER BY last_sent_at", mark.at)
    .filter((r) => (r.last_sent_at ?? 0) > mark.at || !mark.cls.includes(r.class));
  const items: SendItem[] = c.db.metaJson<SendItem[]>("alertRetry", []);
  const next: Mark = { at: mark.at, cls: [...mark.cls] };
  for (const r of rows) {
    const at = r.last_sent_at ?? 0;
    if (at > next.at) {
      next.at = at;
      next.cls = [];
    }
    if (at === next.at) next.cls.push(r.class);
    if ((RANK[r.severity] ?? 0) >= min || r.class === HEARTBEAT || r.class === DEADMAN)
      items.push({ cls: r.class, severity: r.severity, detail: r.last_detail ?? "", at, tries: 0 });
  }
  return { items, mark: next };
}

export function outboxSize(c: Ctx): number {
  return dueItems(c).items.length;
}

/**
 * Send due alerts. No sink configured → advance the mark (ring and /ops/status keep the record).
 * `errors` (status and the start of the answer) let the CLI print why a sink refused.
 */
export async function flushAlerts(
  c: Ctx,
): Promise<{ sent: number; failed: number; deferred?: number; kind?: SinkKind; errors?: SinkError[] }> {
  const { items, mark } = dueItems(c);
  // Claim before any await so a second flush does not resend.
  c.db.setMeta("alertMark", mark);
  c.db.setMeta("alertRetry", []);
  const url = sinkUrl(c);
  if (!items.length || !url) return { sent: 0, failed: 0 };
  const kind = sinkKind(url);
  const keep: SendItem[] = [];
  const errors: SinkError[] = [];
  let sent = 0;
  let deferred = 0;
  for (const a of items) {
    if (a.nextAt && a.nextAt > c.now()) {
      keep.push(a);
      deferred++;
      continue;
    }
    let status: number | null = null;
    try {
      const r = await c.fetch(url, {
        ...sinkRequest(kind, c.inst, a, sinkToken(c)),
        signal: AbortSignal.timeout(10_000),
      });
      status = r.status;
      if (!r.ok) {
        const body = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
        const ra = retryAfterMs(r.headers.get("retry-after"), c.now());
        if (r.status === 429) a.nextAt = c.now() + Math.min(RETRY_AFTER_CAP_MS, ra ?? 60_000 * 2 ** a.tries);
        throw Object.assign(new Error(`sink ${r.status}${body ? ` ${body}` : ""}`), {
          retryAfterS: ra === null ? undefined : Math.round(ra / 1000),
        });
      }
      sent++;
      c.db.setMeta("alertSinkOkAt", c.now());
    } catch (e) {
      c.db.setMeta("alertSinkFailAt", c.now());
      a.tries++;
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      const retryAfterS = (e as { retryAfterS?: number }).retryAfterS;
      errors.push({ cls: a.cls, status, error, ...(retryAfterS !== undefined ? { retryAfterS } : {}) });
      ring(c, "alert", "sink-failed", { cls: a.cls, kind, tries: a.tries, status, error, retryAfterS });
      if (a.tries < 5) keep.push(a);
    }
  }
  if (keep.length) {
    const more = c.db.metaJson<SendItem[]>("alertRetry", []);
    c.db.setMeta("alertRetry", [...keep, ...more].slice(-RETRY_MAX));
  }
  return {
    sent,
    failed: items.length - sent - deferred,
    kind,
    ...(deferred ? { deferred } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

// ---------------------------------------------------------------- test alert and ack (W4)

interface AlertTest {
  code: string | null;
  at: number;
}
interface AlertAck {
  code: string | null;
  at: number;
}

/** Owner test alert. `code` (from the CLI, 4-12 chars [a-z0-9]) goes in the alert text for `alerts ack`. */
export function alertTest(
  c: Ctx,
  code: unknown,
): { ok: true; code: string | null } | { ok: false; error: string } {
  let k: string | null = null;
  if (code !== undefined && code !== null && code !== "") {
    if (typeof code !== "string" || !/^[a-z0-9]{4,12}$/i.test(code)) return { ok: false, error: "bad-code" };
    k = code.toLowerCase();
  }
  const cls = "alert-test";
  c.db.run("UPDATE alerts SET last_sent_at = NULL WHERE class = ?", cls);
  // A test is never deferred by an earlier 429: the owner asked for it now.
  c.db.setMeta(
    "alertRetry",
    c.db.metaJson<SendItem[]>("alertRetry", []).filter((a) => a.cls !== cls),
  );
  alert(
    c,
    cls,
    "high",
    k ? `test alert. Confirm with: ochost alerts ack ${k}` : "test alert from /ops/alerts/test",
  );
  c.db.setMeta("alertTest", { code: k, at: c.now() } satisfies AlertTest);
  return { ok: true, code: k };
}

/** POST /ops/alerts/ack {code}: the owner saw the test alert. 409 when no test waits or the code differs. */
export function alertAck(c: Ctx, code: unknown): { status: number; body: Record<string, unknown> } {
  const t = c.db.metaJson<AlertTest | null>("alertTest", null);
  if (!t) return { status: 409, body: { error: "no-test", hint: "POST /ops/alerts/test first" } };
  const k = typeof code === "string" ? code.trim().toLowerCase() : "";
  if (t.code && k !== t.code) return { status: 409, body: { error: "code-mismatch" } };
  const ack: AlertAck = { code: t.code, at: c.now() };
  c.db.setMeta("alertAck", ack);
  resolveAlert(c, "alert-test");
  ring(c, "alert", "ack", { code: t.code, afterMs: c.now() - t.at });
  return { status: 200, body: { ok: true, ackedAt: ack.at, afterMs: c.now() - t.at } };
}

/**
 * Sink summary for GET /ops/alerts and /ops/status (no URL, no token). lastOkAt: the sink's last 2xx (it took an
 * alert); failing: the newest send failed after the newest 2xx. `ochost doctor` FAILs on never-acked or failing.
 */
export function sinkInfo(c: Ctx): Record<string, unknown> {
  const url = sinkUrl(c);
  const t = c.db.metaJson<AlertTest | null>("alertTest", null);
  const a = c.db.metaJson<AlertAck | null>("alertAck", null);
  const ok = c.db.metaNum("alertSinkOkAt", 0) || null;
  const fail = c.db.metaNum("alertSinkFailAt", 0) || null;
  return {
    configured: !!url,
    kind: url ? sinkKind(url) : null,
    token: !!sinkToken(c),
    source: c.db.meta("alertSinkUrl") === null ? (url ? "secret" : "none") : url ? "console" : "off",
    lastTestAt: t?.at ?? null,
    ackedAt: a && t && a.at >= t.at ? a.at : null,
    lastOkAt: ok,
    lastFailAt: fail,
    failing: !!url && fail !== null && fail > (ok ?? 0),
    heartbeatAt: c.db.metaNum("alertHeartbeatAt", 0) || null,
    minSeverity: c.settings().alerts.minSeverity,
  };
}

// ---------------------------------------------------------------- dead-man (Z2.9)

/** Daily sink self-test: an `info` alert that skips the severity filter. No heartbeat for 2 days = look. */
export const HEARTBEAT = "heartbeat";
/** The CI dead-man workflow posts /ops/ci every 30 min; silent past this → `deadman-silent`. */
export const DEADMAN_SILENT_MS = 2 * 3_600_000;
export const DEADMAN = "deadman-silent";
/** An open `deadman-silent` is sent again after this, not every alert dedupe window. */
export const DEADMAN_RESEND_MS = 24 * 3_600_000;

/** Before 1.2.4 the daily job opened this class when no sink was set. Now "no sink" is "alerts off": a normal state. */
export const ALERTS_NONE = "alerts-none";

/**
 * Daily job (Z2.9): with a sink, send the heartbeat (the owner sees one a day; its absence means the install or
 * the alert path is down). Without a sink, alerts are off (the default, opt-in): no alert, and an `alerts-none`
 * left open by an older version is closed. Alerts are still recorded and listed.
 */
export function dailyHeartbeat(c: Ctx): "sent" | "no-sink" {
  resolveAlert(c, ALERTS_NONE);
  if (!sinkUrl(c)) return "no-sink";
  alert(
    c,
    HEARTBEAT,
    "info",
    "daily heartbeat: install and alert path up. None for 2 days: check the install",
  );
  resolveAlert(c, HEARTBEAT); // a heartbeat is never an open problem
  c.db.setMeta("alertHeartbeatAt", c.now());
  return "sent";
}

/** Z2.9: the CI dead-man posts /ops/ci each run; once it ran, silence past DEADMAN_SILENT_MS alerts. */
export function deadmanCheck(c: Ctx): { lastAt: number | null; silent: boolean } {
  const ci = c.db.metaJson<{ deadman?: string; at?: number } | null>("ci", null);
  const lastAt = ci?.deadman && typeof ci.at === "number" ? ci.at : null;
  const silent = lastAt !== null && c.now() - lastAt > DEADMAN_SILENT_MS;
  // It skips the severity filter (warn < the default `high`), so it is sent once a day, not once an hour.
  const row = c.db.one<AlertRow>("SELECT * FROM alerts WHERE class = ?", DEADMAN);
  const sentToday =
    !!row?.open && row.last_sent_at !== null && c.now() - row.last_sent_at < DEADMAN_RESEND_MS;
  if (silent && !sentToday)
    alert(
      c,
      DEADMAN,
      "warn",
      `CI dead-man silent since ${new Date(lastAt as number).toISOString()}: GitHub may have disabled the workflow (60 days without repo activity). Fix: gh workflow enable oc-host.yml`,
    );
  else if (!silent && lastAt !== null) resolveAlert(c, DEADMAN);
  return { lastAt, silent };
}
