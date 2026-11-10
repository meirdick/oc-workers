// Serial replay driver (spec §12.3, add §2.2). One queue per (route, account), ordered by update_id, one in
// flight. Starts in "not-ready" mode at `started`, counts attempts only after `ingress-ready`.
import { adapterByRoute } from "./adapters";
import { alert } from "./alerts";
import { type Ctx, DAY, ring } from "./ctx";
import { type InboxRow, REPLAY_MAX, REPLY_WAIT_MS, ROUTE_TG, replayBody } from "./inbox";

interface Queue {
  idx: number;
  retryAt: number;
  stopped?: string;
  authSince?: number | null;
  /** sec F6: consecutive delivery timeouts of the head row (`toRow`). */
  toRow?: string | null;
  toN?: number;
  /** M7 F3: consecutive 404/501 answers for the head row (`nfRow`). */
  nfRow?: string | null;
  nfN?: number;
  /** M7 soak: time of the first 404/501 in the current run for the head row. */
  nfSince?: number | null;
}

/**
 * M7 F3: `ready` comes only with the first durable accept (ocsup does not send `ingress-ready` yet, M1-STATUS),
 * so on a boot where no row is ever accepted a 404 route retried silently for 23 h. After this many 404 or 501
 * answers in a row for the same head row, the driver raises `inbox-blocked` with the route and status, ready or
 * not. S0.3: the queue never stops on a 404. A gateway that stops (sleep phase 4, memwatch restart, restart,
 * secrets set) answers 404 while its route is down; the row waits and goes again after the restart.
 */
export const BLOCKED_AFTER_MISSES = 3;

/**
 * M7 soak: a row the gateway keeps answering 404/501 goes `dead` (`http-404`, alert inbox-dead), so it no longer
 * holds the install awake (sleep rule 5 counts pending rows) until inbox.deadHours (23 h). Both must hold: at
 * least DEAD_AFTER_MISSES misses in a row for that row, and the first of them at least DEAD_MISS_MIN_MS ago. The
 * time floor keeps S0.3: a gateway restart (route down for about 1-2 min) answers 404 and must not kill rows.
 * The live soak had 61 such rows hold every sleep for 23 h (about 1.7 USD a day on 2/6/20).
 */
export const DEAD_AFTER_MISSES = 5;
export const DEAD_MISS_MIN_MS = 5 * 60_000;

/**
 * M7 F2: attempts were counted only while `ready`, so a row the gateway refused stayed at 0. Any answer but the
 * gateway-not-up family (connection error, timeout, 500, 502, 503, 504) is a real attempt and is counted.
 */
export function countsAsAttempt(status: number, ready: boolean): boolean {
  return ready || (status > 0 && ![500, 502, 503, 504].includes(status));
}

/**
 * sec F6 (ctl side of §12.3): the Runtime DO bounds each delivery with deliverTimeoutMs and answers
 * `{status: 0, error: "timeout"}`; the Control DO also caps the RPC itself at deliverTimeoutMs + this margin, so
 * a hung Runtime DO cannot hold the single `pumping` promise. After DEAD_AFTER_TIMEOUTS timeouts in a row of the
 * same head row, the row goes `dead` (`deliver-timeout`, alert inbox-dead) and the queue moves on: one update
 * the gateway never answers no longer blocks every later row (and the sleep gate) for 23 h.
 */
export const DELIVER_RPC_MARGIN_MS = 5_000;
export const DEAD_AFTER_TIMEOUTS = 3;

async function deliverCapped(
  c: Ctx,
  epoch: number,
  req: {
    path: string;
    body: string;
    headers: Record<string, string>;
    okIsDurable?: boolean;
    quiet?: boolean;
  },
): Promise<{ status: number; durable: boolean; error?: string }> {
  const cap = (c.timers.deliverTimeoutMs ?? 30_000) + (c.test ? 0 : DELIVER_RPC_MARGIN_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ status: number; durable: boolean; error: string }>((r) => {
    timer = setTimeout(() => r({ status: 0, durable: false, error: "timeout" }), cap);
  });
  try {
    return await Promise.race([c.rt(epoch).deliver(req), late]);
  } finally {
    clearTimeout(timer);
  }
}
export interface DriverState {
  gen: number | null;
  epoch: number | null;
  ready: boolean;
  active: boolean;
  queues: Record<string, Queue>;
}

const EMPTY: DriverState = { gen: null, epoch: null, ready: false, active: false, queues: {} };

export function driverState(c: Ctx): DriverState {
  return c.db.metaJson<DriverState>("driver", EMPTY);
}
function save(c: Ctx, s: DriverState): void {
  c.db.setMeta("driver", s);
}

/**
 * `/startupz` started (§8.6): the driver runs in not-ready mode. A boot without a valid marker first replays
 * every accepted row of the last 24 h that is not replicated (at-least-once, add §2.2).
 *
 * L3 (M4 loss): OpenClaw marks its ingress row `completed` before the reply goes out, so a plain replay is
 * deduped and the reply is lost. An accepted row with no outbound send to its chat (replied_at null), accepted
 * before this gateway start and less than REPLY_WAIT_MS ago, is replayed with a fresh update_id (replays + 1,
 * at most REPLAY_MAX). Duplicates are allowed; loss is not.
 */
export function driverBootStarted(c: Ctx, gen: number, epoch: number, markerUsed: boolean): number {
  let replay = 0;
  let fresh = 0;
  let settled = 0;
  c.db.tx(() => {
    if (!markerUsed) {
      const now = c.now();
      // Rows past the reply wait are settled for good (replied_at 0), so a later re-accept does not reopen them.
      c.db.run(
        "UPDATE inbox SET replied_at = 0 WHERE replied_at IS NULL AND accepted_at IS NOT NULL AND accepted_at <= ?",
        now - REPLY_WAIT_MS,
      );
      // Telegram only: its outbound sends are seen (gates/telegram.ts). An adapter row keeps its platform ids on
      // every replay, so the gateway's own dedupe (event_id, MessageSid, interaction id) applies.
      const noReply = `route = '${ROUTE_TG}' AND state IN ('accepted', 'replicated') AND replied_at IS NULL
        AND accepted_at IS NOT NULL AND accepted_at < ? AND accepted_at > ? AND replays < ?`;
      fresh =
        c.db.one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM inbox WHERE ${noReply}`,
          now,
          now - REPLY_WAIT_MS,
          REPLAY_MAX,
        )?.n ?? 0;
      if (fresh)
        c.db.run(
          `UPDATE inbox SET state = 'pending', attempts = 0, replays = replays + 1 WHERE ${noReply}`,
          now,
          now - REPLY_WAIT_MS,
          REPLAY_MAX,
        );
      // L6: the plain replay (original update_id, the gateway dedupes it) takes only rows the gateway may lack:
      // accepted after the last confirmed outbound send, or within REPLAY_WINDOW_MS. Never a row past the
      // gateway's dedupe horizon (newest DEDUPE_ROWS per route, 24 h): there a replay is a second reply.
      // Every other accepted row is settled (`replicated`), so the 24 h delete rule applies to it.
      const lastOut = c.db.metaNum("lastOutboundAt", 0);
      const after = Math.min(Math.max(lastOut, 0), now);
      for (const k of c.db.all<{ route: string; account: string }>(
        "SELECT DISTINCT route, account FROM inbox WHERE state = 'accepted'",
      )) {
        const floor = Math.max(now - DAY, horizonFloor(c, k.route, k.account));
        const pick = `route = ? AND account = ? AND state = 'accepted' AND received_at > ?
          AND accepted_at IS NOT NULL AND (accepted_at > ? OR accepted_at > ?)`;
        const args = [k.route, k.account, floor, after, now - REPLAY_WINDOW_MS] as const;
        const n = c.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox WHERE ${pick}`, ...args)?.n ?? 0;
        if (n) c.db.run(`UPDATE inbox SET state = 'pending', attempts = 0 WHERE ${pick}`, ...args);
        replay += n;
        const s = c.db.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM inbox WHERE route = ? AND account = ? AND state = 'accepted'",
          k.route,
          k.account,
        )?.n;
        if (s)
          c.db.run(
            "UPDATE inbox SET state = 'replicated', replicated_at = ? WHERE route = ? AND account = ? AND state = 'accepted'",
            now,
            k.route,
            k.account,
          );
        settled += s ?? 0;
      }
    }
    save(c, { gen, epoch, ready: false, active: true, queues: {} });
  });
  if (fresh) ring(c, "driver", "replay-no-reply", { n: fresh, gen });
  if (replay) ring(c, "driver", "replay-unreplicated", { n: replay, gen });
  if (settled) ring(c, "driver", "replay-settled", { n: settled, gen });
  return replay + fresh;
}

/** L6: a plain replay always covers rows accepted this recently (restore lag, Litestream lag). */
export const REPLAY_WINDOW_MS = 2 * 60_000;
/** L6: the gateway's update_id dedupe keeps this many completed rows (OpenClaw completedMaxEntries). */
export const DEDUPE_ROWS = 1000;

/** received_at of the oldest row still inside the gateway's dedupe horizon on this route (0 = all are). */
function horizonFloor(c: Ctx, route: string, account: string): number {
  return (
    (c.db.one<{ t: number }>(
      `SELECT received_at AS t FROM inbox WHERE route = ? AND account = ? AND accepted_at IS NOT NULL
       ORDER BY received_at DESC, id DESC LIMIT 1 OFFSET ?`,
      route,
      account,
      DEDUPE_ROWS - 1,
    )?.t ?? 0) - 1
  );
}

/** ocsup event `ingress-ready` (first durable accept). */
export function driverIngressReady(c: Ctx, gen: number): void {
  const s = driverState(c);
  if (s.gen !== gen) return;
  s.ready = true;
  for (const q of Object.values(s.queues)) q.retryAt = 0;
  save(c, s);
}

/** New secrets (M7 F1): queues waiting on a retry try again now. */
export function driverRetryNow(c: Ctx): void {
  const s = driverState(c);
  if (!s.active) return;
  for (const q of Object.values(s.queues)) q.retryAt = 0;
  save(c, s);
}

/** Back in running on the same boot (sleep aborted, maintenance done): deliver again. */
export function driverResume(c: Ctx, gen: number | null): boolean {
  const s = driverState(c);
  if (s.active || s.gen === null || s.gen !== gen) return false;
  s.active = true;
  for (const q of Object.values(s.queues)) q.retryAt = 0;
  save(c, s);
  ring(c, "driver", "resume", { gen });
  return true;
}

/** Runtime left running (sleep, stop, crash): stop delivering. Rows stay. */
export function driverStop(c: Ctx, why: string): void {
  const s = driverState(c);
  if (!s.active) return;
  s.active = false;
  save(c, s);
  ring(c, "driver", "stop", why);
}

function retryDelay(c: Ctx, ready: boolean, idx: number): number {
  const t = c.timers;
  const steps = [t.driverRetry1Ms, t.driverRetry2Ms, t.driverRetry3Ms, t.driverRetry4Ms];
  if (idx < steps.length) return steps[idx] as number;
  return ready ? c.timers.driverRetryCapMs : (steps[steps.length - 1] as number);
}

/** Next time a queue is due, or null when nothing to send. */
export function driverDueAt(c: Ctx): number | null {
  const s = driverState(c);
  if (!s.active) return null;
  let due: number | null = null;
  for (const k of c.db.all<{ route: string; account: string }>(
    "SELECT DISTINCT route, account FROM inbox WHERE state = 'pending'",
  )) {
    const q = s.queues[`${k.route}|${k.account}`];
    if (q?.stopped) continue;
    const t = q?.retryAt ?? 0;
    due = due === null ? t : Math.min(due, t);
  }
  return due;
}

export interface PumpResult {
  sent: number;
  accepted: number;
  dead: number;
}

/** Deliver due rows, one at a time, until none is due. */
export async function pump(c: Ctx, maxRows = 200): Promise<PumpResult> {
  const out: PumpResult = { sent: 0, accepted: 0, dead: 0 };
  for (let n = 0; n < maxRows; n++) {
    const s = driverState(c);
    if (!s.active || s.epoch === null) return out;
    const now = c.now();
    let pick: { key: string; row: InboxRow } | null = null;
    for (const k of c.db.all<{ route: string; account: string }>(
      "SELECT DISTINCT route, account FROM inbox WHERE state = 'pending' ORDER BY route, account",
    )) {
      const key = `${k.route}|${k.account}`;
      const q = s.queues[key];
      if (q?.stopped || (q && now < q.retryAt)) continue;
      const row = c.db.one<InboxRow>(
        "SELECT * FROM inbox WHERE state = 'pending' AND route = ? AND account = ? ORDER BY CAST(platform_key AS INTEGER), received_at, id LIMIT 1",
        k.route,
        k.account,
      );
      if (row) {
        pick = { key, row };
        break;
      }
    }
    if (!pick) return out;
    const { key, row } = pick;
    const at0 = c.now();
    const hdrs = JSON.parse(row.headers) as Record<string, string>;
    const adapter = adapterByRoute(row.route);
    let headers: Record<string, string> = { "content-type": "application/json" };
    if (!adapter && c.secrets.webhookSecret)
      headers["x-telegram-bot-api-secret-token"] = c.secrets.webhookSecret;
    if (hdrs.host) headers.host = hdrs.host;
    let status = 0;
    let durable = false;
    let timedOut = false;
    try {
      // An adapter signs the replay itself where the platform's check has a time window (Slack).
      if (adapter)
        headers = {
          ...headers,
          ...(await adapter.replayHeaders({ headers: hdrs, body: row.body }, c.secrets.platform ?? {}, at0)),
        };
      const body = adapter ? row.body : replayBody(row.body, row.replays ?? 0);
      const r = await deliverCapped(c, s.epoch, {
        path: row.route,
        body,
        headers,
        okIsDurable: adapter ? !adapter.durableHeader : false,
        // S0.10: a stranger's or an unlisted group's row is not activity (it never holds the install awake).
        ...(row.quiet ? { quiet: true } : {}),
      });
      status = r.status;
      durable = r.durable;
      timedOut = r.status === 0 && r.error === "timeout";
    } catch (e) {
      status = 0;
      ring(c, "driver", "deliver-error", String(e).slice(0, 200));
    }
    out.sent++;
    const s2 = driverState(c);
    if (s2.gen !== s.gen || !s2.active) return out; // boot changed or driver stopped while in flight
    const q: Queue = s2.queues[key] ?? { idx: 0, retryAt: 0, authSince: null };
    const at = c.now();
    const counted = countsAsAttempt(status, s2.ready);
    const bumpRetry = () => {
      q.retryAt = at + retryDelay(c, s2.ready, q.idx);
      q.idx++;
      if (counted)
        c.db.run(
          "UPDATE inbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?",
          q.retryAt,
          row.id,
        );
    };
    if (timedOut) {
      q.toN = q.toRow === row.id ? (q.toN ?? 0) + 1 : 1;
      q.toRow = row.id;
    } else {
      q.toRow = null;
      q.toN = 0;
    }
    const miss = status === 404 || status === 501;
    if (miss) {
      const same = q.nfRow === row.id;
      q.nfN = same ? (q.nfN ?? 0) + 1 : 1;
      q.nfSince = same ? (q.nfSince ?? at) : at;
      q.nfRow = row.id;
    } else {
      q.nfRow = null;
      q.nfN = 0;
      q.nfSince = null;
    }
    c.db.tx(() => {
      if (timedOut && (q.toN ?? 0) >= DEAD_AFTER_TIMEOUTS) {
        c.db.run(
          "UPDATE inbox SET state = 'dead', dead_reason = 'deliver-timeout' WHERE id = ? AND state = 'pending'",
          row.id,
        );
        out.dead++;
        q.idx = 0;
        q.retryAt = 0;
        q.toRow = null;
        q.toN = 0;
        alert(
          c,
          "inbox-dead",
          "high",
          `update ${row.platform_key} dead: ${DEAD_AFTER_TIMEOUTS} delivery timeouts in a row`,
        );
      } else if (status === 200 && durable) {
        c.db.run(
          "UPDATE inbox SET state = 'accepted', accepted_at = ?, accepted_boot_gen = ?, next_attempt_at = NULL WHERE id = ? AND state = 'pending'",
          at,
          s2.gen,
          row.id,
        );
        out.accepted++;
        q.idx = 0;
        q.retryAt = 0;
        q.authSince = null;
        if (!s2.ready) s2.ready = true;
        c.db.run(
          `UPDATE wake_log SET first_replay_ms = ? - wake_at
           WHERE id = (SELECT MAX(id) FROM wake_log WHERE gen = ?) AND first_replay_ms IS NULL`,
          at,
          s2.gen,
        );
      } else if (status === 400 || status === 413) {
        c.db.run("UPDATE inbox SET state = 'dead', dead_reason = ? WHERE id = ?", `http-${status}`, row.id);
        out.dead++;
        q.idx = 0;
        q.retryAt = 0;
        alert(c, "inbox-dead", "high", `update ${row.platform_key} dead: HTTP ${status}`);
      } else if (miss && (q.nfN ?? 0) >= DEAD_AFTER_MISSES && at - (q.nfSince ?? at) >= DEAD_MISS_MIN_MS) {
        c.db.run(
          "UPDATE inbox SET state = 'dead', dead_reason = ? WHERE id = ? AND state = 'pending'",
          `http-${status}`,
          row.id,
        );
        out.dead++;
        q.idx = 0;
        q.retryAt = 0;
        q.nfRow = null;
        q.nfN = 0;
        q.nfSince = null;
        alert(
          c,
          "inbox-dead",
          "high",
          `update ${row.platform_key} dead: gateway answered ${status} on ${row.route} for ${Math.round(DEAD_MISS_MIN_MS / 60_000)} min (route missing)`,
        );
      } else if (miss && (q.nfN ?? 0) >= BLOCKED_AFTER_MISSES) {
        if (q.nfN === BLOCKED_AFTER_MISSES)
          alert(c, "inbox-blocked", "high", blockedText(row, status, q.nfN));
        bumpRetry();
      } else if (status === 401) {
        q.authSince = q.authSince ?? at;
        if (at - q.authSince >= c.timers.driverAuthAlertMs)
          alert(
            c,
            "inbox-blocked",
            "high",
            `gateway answered 401 on ${row.route} for 5 min (webhook secret mismatch)`,
          );
        bumpRetry();
      } else {
        bumpRetry();
      }
      s2.queues[key] = q;
      c.db.setMeta("driver", s2);
    });
  }
  return out;
}

/** inbox-blocked text: route, status, what to do. */
function blockedText(row: InboxRow, status: number, n: number): string {
  const a = adapterByRoute(row.route);
  const ch = a ? a.channel : "telegram";
  return (
    `gateway answered ${status} on ${row.route}${n > 1 ? ` ${n} times` : ""} (route missing: channel plugin not loaded or config drift). ` +
    `Rows wait ${Math.round(DEAD_MISS_MIN_MS / 60_000)} min, then go dead. Fix the channel, or drop them: ochost inbox drop --all --channel ${ch}`
  );
}
