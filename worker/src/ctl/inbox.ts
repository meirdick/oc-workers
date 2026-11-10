// Control DO inbox (spec §12, add §2.2): store and ack each Telegram update before the container is up.
// Row states: pending, held, accepted, replicated, dead. Key: unique (route, account, platform_key).
import { ulid } from "../core/ids";
import { ADAPTERS } from "./adapters";
import { alert, resolveAlert } from "./alerts";
import { type Ctx, ring, utcDay } from "./ctx";
import { pj, type SqlValue } from "./sql";

export const ROUTE_TG = "/telegram-webhook";
export const ACCOUNT_DEFAULT = "default";
export const BODY_MAX = 1024 * 1024;
export const CAP_ROWS = 10_000;
export const CAP_BYTES = 200 * 1024 * 1024;

export type InboxState = "pending" | "held" | "accepted" | "replicated" | "dead";
export interface InboxRow {
  id: string;
  route: string;
  account: string;
  platform_key: string;
  received_at: number;
  sender_id: string | null;
  chat_id: string | null;
  headers: string;
  body: string;
  state: InboxState;
  attempts: number;
  next_attempt_at: number | null;
  accepted_at: number | null;
  accepted_boot_gen: number | null;
  replicated_at: number | null;
  dead_reason: string | null;
  /** L3: first outbound send to this chat seen after the accept (gates/fakes.ts, gates/telegram.ts). */
  replied_at?: number | null;
  /** L3: replays with a fresh update_id after a restart with no reply seen. */
  replays?: number;
  /** S0.10: not on the wake list. */
  quiet?: number;
}

/** L3: an accepted row waits this long for an outbound send to its chat; after it, the row counts as settled. */
export const REPLY_WAIT_MS = 10 * 60_000;
/**
 * L3: a replay of an accepted row with no reply goes with update_id + REPLY_ID_STEP × replays, so OpenClaw's
 * update_id dedupe (`channel_ingress_events`) does not drop it. guess: OpenClaw keeps no monotonic update_id
 * floor for webhooks (live check in M4b). Duplicates are allowed; loss is not.
 */
export const REPLY_ID_STEP = 2 ** 40;
/** L3: one fresh-key replay per row. */
export const REPLAY_MAX = 1;
/** An accepted Telegram row with no reply after this long, on a running install, raises `no-reply`. */
export const NO_REPLY_ALERT_MS = 5 * 60_000;
/** Rows accepted longer ago than this are not counted (the owner has seen the silence by then). */
const NO_REPLY_WINDOW_MS = 60 * 60_000;
/** Telegram Bot API methods that count as a reply (not typing actions or webhook calls). */
export const REPLY_METHODS = /^(send(?!ChatAction)[A-Za-z]*|copyMessages?|forwardMessages?|editMessageText)$/;

/**
 * L3: an outbound Bot API call to a chat. Each accepted (or replicated) row of that chat accepted at or before
 * `at` with no reply yet gets replied_at = at. Returns rows marked.
 */
export function noteOutbound(
  c: Ctx,
  chatId: string | number | null | undefined,
  at: number,
  method: string,
): number {
  if (chatId === null || chatId === undefined || chatId === "" || !REPLY_METHODS.test(method)) return 0;
  // L6: the boot replay takes rows accepted after the last confirmed send (ctl/driver.ts).
  if (at > c.db.metaNum("lastOutboundAt", 0)) c.db.setMeta("lastOutboundAt", at);
  const chat = String(chatId);
  const where =
    "chat_id = ? AND state IN ('accepted', 'replicated') AND replied_at IS NULL AND accepted_at IS NOT NULL AND accepted_at <= ?";
  const got = c.db.all<{ received_at: number }>(`SELECT received_at FROM inbox WHERE ${where}`, chat, at);
  if (got.length) {
    c.db.run(`UPDATE inbox SET replied_at = ? WHERE ${where}`, at, chat, at);
    if (!noReplyCount(c)) resolveAlert(c, "no-reply");
    const byDay = new Map<string, number>();
    for (const r of got) byDay.set(utcDay(r.received_at), (byDay.get(utcDay(r.received_at)) ?? 0) + 1);
    for (const [day, n] of byDay)
      c.db.run(
        "INSERT INTO msg_day (day, received, replied) VALUES (?, 0, ?) ON CONFLICT(day) DO UPDATE SET replied = replied + excluded.replied",
        day,
        n,
      );
  }
  return got.length;
}

/** Accepted Telegram rows older than NO_REPLY_ALERT_MS (within one hour) that still have no outbound reply. */
export function noReplyCount(c: Ctx): number {
  const now = c.now();
  return (
    c.db.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inbox WHERE route = ? AND state IN ('accepted', 'replicated')
       AND replied_at IS NULL AND accepted_at IS NOT NULL AND accepted_at <= ? AND accepted_at > ?`,
      ROUTE_TG,
      now - NO_REPLY_ALERT_MS,
      now - NO_REPLY_WINDOW_MS,
    )?.n ?? 0
  );
}

/**
 * Alarm check: the gateway runs but a Telegram message got no reply. Warn once per alert dedupe window with the
 * count. A not-running install is not checked (a sleeping install has nothing to reply with). Returns the count.
 */
export function noReplyCheck(c: Ctx, running: boolean): number {
  if (!running) return 0;
  const n = noReplyCount(c);
  if (!n) {
    resolveAlert(c, "no-reply");
    return 0;
  }
  const row = c.db.one<{ open: number; last_sent_at: number | null }>(
    "SELECT open, last_sent_at FROM alerts WHERE class = 'no-reply'",
  );
  const sent =
    !!row?.open && row.last_sent_at !== null && c.now() - row.last_sent_at < c.timers.alertDedupeMs;
  if (!sent)
    alert(
      c,
      "no-reply",
      "warn",
      `${n} Telegram message${n === 1 ? "" : "s"} without a reply after 5 minutes. The gateway runs. Check: ochost logs, ochost doctor`,
    );
  return n;
}

/** Console counters: one more webhook message on its UTC day; the last inbound time and route. */
function noteInbound(c: Ctx, route: string, at: number): void {
  c.db.run(
    "INSERT INTO msg_day (day, received) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET received = received + 1",
    utcDay(at),
  );
  c.db.setMeta("lastInboundAt", at);
  c.db.setMeta("lastInboundRoute", route);
}

/** The last 7 UTC days (oldest first, zeros filled) and the last chat times, for the console Overview. */
export function chatSummary(c: Ctx): {
  days: { day: string; received: number; replied: number }[];
  lastInAt: number | null;
  lastInRoute: string | null;
  lastOutAt: number | null;
} {
  const now = c.now();
  const rows = new Map(
    c.db
      .all<{ day: string; received: number; replied: number }>(
        "SELECT day, received, replied FROM msg_day WHERE day >= ?",
        utcDay(now - 6 * 86_400_000),
      )
      .map((r) => [r.day, r]),
  );
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const day = utcDay(now - i * 86_400_000);
    const r = rows.get(day);
    days.push({ day, received: r?.received ?? 0, replied: r?.replied ?? 0 });
  }
  const lastInAt = c.db.metaNum("lastInboundAt", 0) || null;
  const lastOutAt = c.db.metaNum("lastOutboundAt", 0) || null;
  return { days, lastInAt, lastInRoute: lastInAt ? c.db.meta("lastInboundRoute") : null, lastOutAt };
}

/**
 * L3: body with update_id and the message_id of the top message moved by `replays` steps (fresh dedupe keys).
 * OpenClaw dedupes twice: the ingress queue on update_id and `telegram-message-dispatch-dedupe` on
 * (chat, message_id) in plugin_state_entries (seen live on oc-m4b-ctl). guess: OpenClaw sends a DM reply
 * without a reply_to on the moved id, or with allow_sending_without_reply; not checked on real Telegram.
 * Unparsable → as is.
 */
export function replayBody(body: string, replays: number): string {
  if (!replays) return body;
  try {
    const u = JSON.parse(body) as Record<string, unknown> & { update_id?: unknown };
    if (!Number.isInteger(u.update_id)) return body;
    u.update_id = (u.update_id as number) + REPLY_ID_STEP * replays;
    for (const f of UPDATE_FIELDS) {
      const m = u[f] as { message_id?: unknown } | undefined;
      if (m && typeof m === "object" && Number.isInteger(m.message_id))
        m.message_id = (m.message_id as number) + REPLY_ID_STEP * replays;
    }
    return JSON.stringify(u);
  } catch {
    return body;
  }
}

export const UPDATE_FIELDS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
  "callback_query",
  "inline_query",
  "chosen_inline_result",
  "shipping_query",
  "pre_checkout_query",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "message_reaction",
  "message_reaction_count",
  "chat_boost",
  "removed_chat_boost",
  "purchased_paid_media",
];

/** update_id, from.id, chat.id from the first present Update field (§12.1 step 2). null = malformed. */
export function parseTelegram(
  body: string,
): { updateId: string; fromId: string | null; chatId: string | null } | null {
  let u: any;
  try {
    u = JSON.parse(body);
  } catch {
    return null;
  }
  if (!u || typeof u !== "object" || !Number.isInteger(u.update_id)) return null;
  let fromId: string | null = null;
  let chatId: string | null = null;
  for (const f of UPDATE_FIELDS) {
    const x = u[f];
    if (!x || typeof x !== "object") continue;
    const from = x.from ?? x.user ?? x.voter_chat;
    const chat = x.chat ?? x.message?.chat;
    if (from && from.id !== undefined) fromId = String(from.id);
    if (chat && chat.id !== undefined) chatId = String(chat.id);
    break;
  }
  return { updateId: String(u.update_id), fromId, chatId };
}

export interface WakeAllow {
  userIds: string[];
  groupChatIds: string[];
  configVer?: number | null;
  exportedAt: number;
}

export function getWakeAllow(c: Ctx): WakeAllow | null {
  const r = c.db.one<{
    user_ids: string;
    group_chat_ids: string;
    config_ver: number | null;
    exported_at: number;
  }>("SELECT * FROM wake_allow WHERE id = 1");
  if (!r) return null;
  return {
    userIds: JSON.parse(r.user_ids) as string[],
    groupChatIds: JSON.parse(r.group_chat_ids) as string[],
    configVer: r.config_ver,
    exportedAt: r.exported_at,
  };
}

/** PUT /v1/wake-allow (§23): replace the row. */
export function putWakeAllow(
  c: Ctx,
  w: { userIds: string[]; groupChatIds: string[]; configVer?: number },
): void {
  c.db.run(
    `INSERT INTO wake_allow (id, user_ids, group_chat_ids, config_ver, exported_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_ids = excluded.user_ids, group_chat_ids = excluded.group_chat_ids,
       config_ver = excluded.config_ver, exported_at = excluded.exported_at`,
    JSON.stringify(w.userIds.map(String)),
    JSON.stringify(w.groupChatIds.map(String)),
    w.configVer ?? null,
    c.now(),
  );
}

/** Stale = no row, or exported before the newest config change (§12.2). */
export function allowFresh(c: Ctx): WakeAllow | null {
  const w = getWakeAllow(c);
  if (!w) return null;
  const changed = c.db.one<{ m: number | null }>("SELECT MAX(created_at) AS m FROM config")?.m ?? 0;
  return w.exportedAt >= changed ? w : null;
}

/**
 * Wake list (§12.2, S0.10): the fresh export, else (stale) the last export plus the config's allowFrom and
 * groupAllowFrom ids and the owner's Telegram id from init. null = nothing known yet (first setup).
 */
export function wakeList(c: Ctx): { users: Set<string>; groups: Set<string> } | null {
  const w = getWakeAllow(c);
  const users = new Set(w?.userIds ?? []);
  const groups = new Set(w?.groupChatIds ?? []);
  if (!allowFresh(c)) {
    const doc = pj<Record<string, any>>(
      c.db.one<{ doc: string }>("SELECT doc FROM config ORDER BY ver DESC LIMIT 1")?.doc,
      {},
    );
    const tg = doc?.channels?.telegram;
    const blocks = tg && typeof tg === "object" ? [tg, ...Object.values(tg.accounts ?? {})] : [];
    const ids = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => String(x).replace(/^(telegram|tg):/i, "")) : [];
    for (const b of blocks as Record<string, unknown>[]) {
      for (const x of ids(b?.allowFrom)) users.add(x);
      for (const x of ids(b?.groupAllowFrom)) users.add(x);
      if (b?.groups && typeof b.groups === "object") for (const g of Object.keys(b.groups)) groups.add(g);
    }
  }
  const owner = c.db.meta("ownerTelegramId");
  if (owner) users.add(owner);
  return w || users.size || groups.size ? { users, groups } : null;
}

/**
 * Does this update wake (§12.2, S0.10)? A group or channel chat (chat id ≠ sender id) wakes only when the
 * group is on the list; a DM only when the sender is. Strangers never wake. Nothing known yet → wake (setup).
 * The owner from init (`--telegram-owner`) wakes from any chat, so a group rule never holds the owner.
 */
export function wakes(c: Ctx, fromId: string | null, chatId: string | null): boolean {
  if (fromId === null && chatId === null) return true;
  if (fromId !== null && fromId === c.db.meta("ownerTelegramId")) return true;
  const w = wakeList(c);
  if (!w) return true;
  const group = chatId !== null && chatId !== fromId;
  if (group) return w.groups.has(chatId as string);
  return fromId !== null && w.users.has(fromId);
}

export function liveCounts(c: Ctx): { rows: number; bytes: number } {
  const r = c.db.one<{ n: number; b: number | null }>(
    "SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS b FROM inbox WHERE state IN ('pending', 'held', 'accepted')",
  );
  return { rows: r?.n ?? 0, bytes: r?.b ?? 0 };
}

export interface PutIn {
  route?: string;
  account?: string;
  body: string;
  headers: Record<string, string>;
  /** Adapter routes (ctl/adapters): the verified platform ids. Absent = a Telegram update, parsed from the body. */
  meta?: { platformKey: string; senderId: string | null; chatId: string | null; hold?: boolean };
  /** Runtime DO state as last seen by the Control DO. */
  asleep: boolean;
  /** S0.10: quiescing (a sleep op runs): a quiet row is held, so it cannot abort the sleep. */
  quiescing?: boolean;
}
export type PutOut =
  | {
      status: 200;
      id: string;
      state: InboxState;
      dup: boolean;
      wake: boolean;
      typing?: string;
      progress?: string;
      malformed?: false;
    }
  | { status: 200; malformed: true; wake: false; typing?: undefined; progress?: undefined }
  | { status: 503 | 413; wake: false; error: string; typing?: undefined; progress?: undefined };

/** ctl.inboxPut (§12.1 steps 2-5): one storage write; redelivery is a no-op. */
export function inboxPut(c: Ctx, p: PutIn): PutOut {
  if (p.body.length > BODY_MAX) return { status: 413, wake: false, error: "too-large" };
  const t = p.meta
    ? { updateId: p.meta.platformKey, fromId: p.meta.senderId, chatId: p.meta.chatId }
    : parseTelegram(p.body);
  if (!t) {
    ring(c, "inbox", "webhook-malformed", { bytes: p.body.length });
    return { status: 200, malformed: true, wake: false };
  }
  const route = p.route ?? ROUTE_TG;
  const account = p.account ?? ACCOUNT_DEFAULT;
  return c.db.tx(() => {
    const dup = c.db.one<{ id: string; state: InboxState }>(
      "SELECT id, state FROM inbox WHERE route = ? AND account = ? AND platform_key = ?",
      route,
      account,
      t.updateId,
    );
    if (dup) return { status: 200, id: dup.id, state: dup.state, dup: true, wake: false } as PutOut;
    const live = liveCounts(c);
    if (live.rows >= CAP_ROWS || live.bytes + p.body.length >= CAP_BYTES)
      return { status: 503, wake: false, error: "inbox-cap" } as PutOut;
    // Allowlist wake rules are Telegram's. An adapter row wakes, unless the adapter says hold (delivery receipts).
    const hold = p.meta ? !!p.meta.hold : !wakes(c, t.fromId, t.chatId);
    // S0.10: a quiet row never wakes and never holds the install: held while asleep or quiescing; while awake
    // delivered, but not as activity and not counted by the sleep gate.
    const state: InboxState = (p.asleep || p.quiescing) && hold ? "held" : "pending";
    const id = ulid(c.now());
    c.db.run(
      `INSERT INTO inbox (id, route, account, platform_key, received_at, sender_id, chat_id, headers, body, state, quiet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      id,
      route,
      account,
      t.updateId,
      c.now(),
      t.fromId,
      t.chatId,
      JSON.stringify(p.headers),
      p.body,
      state,
      hold && !p.meta ? 1 : 0, // an adapter's held row (delivery receipt) keeps its maintenance wake
    );
    if (!p.meta?.hold) noteInbound(c, route, c.now()); // an adapter's held row (delivery receipt) is not a message
    return { status: 200, id, state, dup: false, wake: state === "pending" && !(hold && !p.meta) } as PutOut;
  });
}

/** At any wake start: every held row → pending (§12.2). */
export function heldToPending(c: Ctx): number {
  const n = c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE state = 'held'")?.n ?? 0;
  if (n) c.db.run("UPDATE inbox SET state = 'pending' WHERE state = 'held'");
  return n;
}

export function counts(
  c: Ctx,
): Record<InboxState, number> & { oldestPendingAt: number | null; oldestHeldAt: number | null } {
  const out = { pending: 0, held: 0, accepted: 0, replicated: 0, dead: 0 } as Record<InboxState, number>;
  for (const r of c.db.all<{ state: InboxState; n: number }>(
    "SELECT state, COUNT(*) AS n FROM inbox GROUP BY state",
  ))
    out[r.state] = r.n;
  const op =
    c.db.one<{ m: number | null }>("SELECT MIN(received_at) AS m FROM inbox WHERE state = 'pending'")?.m ??
    null;
  const oh =
    // S0.10: a quiet held row plans no wake (it waits for the next wake, or dies at inboxDeadMs).
    c.db.one<{ m: number | null }>(
      "SELECT MIN(received_at) AS m FROM inbox WHERE state = 'held' AND quiet = 0",
    )?.m ?? null;
  return { ...out, oldestPendingAt: op, oldestHeldAt: oh };
}

/** Sleep gate rule 5 (§10.1): any pending row that wakes (S0.10: quiet rows do not count), or accepted. */
export function blocksSleep(c: Ctx): { pending: number; unreplicated: number } {
  const k = counts(c);
  const pending =
    c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE state = 'pending' AND quiet = 0")?.n ?? 0;
  return { pending, unreplicated: k.accepted };
}

/** S0.10: the install leaves running (quiescing, asleep): quiet pending rows wait as held for the next wake. */
export function quietToHeld(c: Ctx): number {
  const n =
    c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE state = 'pending' AND quiet = 1")?.n ?? 0;
  if (n) c.db.run("UPDATE inbox SET state = 'held' WHERE state = 'pending' AND quiet = 1");
  return n;
}

/**
 * Path A (sleep phase 6): accepted rows with accepted_at ≤ lastWriteAt of the state DB → replicated. The sleep
 * check already waited for no open ingress row and no pending delivery, so replies went out (L3 replays only
 * after a restart with no marker).
 */
export function markReplicated(c: Ctx, lastWriteAt: number | null | undefined): number {
  if (lastWriteAt == null) return 0;
  const n =
    c.db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM inbox WHERE state = 'accepted' AND accepted_at <= ?",
      lastWriteAt,
    )?.n ?? 0;
  c.db.run(
    "UPDATE inbox SET state = 'replicated', replicated_at = ? WHERE state = 'accepted' AND accepted_at <= ?",
    c.now(),
    lastWriteAt,
  );
  return n;
}

/**
 * Age rules (§12.3, §12.4): pending/held 23 h after received_at → dead (`age`), alert `inbox-dead` (1/h, count);
 * replicated/dead rows deleted 24 h after received_at. L6/S0.4: accepted rows too: past 24 h no boot replays
 * them (ctl/driver.ts), so an always-on install no longer fills the 10,000-row cap.
 */
export function expireInbox(c: Ctx): { dead: number; deleted: number } {
  const now = c.now();
  const deadBefore = now - c.timers.inboxDeadMs;
  const dead =
    c.db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM inbox WHERE state IN ('pending', 'held') AND received_at <= ?",
      deadBefore,
    )?.n ?? 0;
  if (dead) {
    c.db.run(
      "UPDATE inbox SET state = 'dead', dead_reason = 'age' WHERE state IN ('pending', 'held') AND received_at <= ?",
      deadBefore,
    );
    alert(
      c,
      "inbox-dead",
      "high",
      `${dead} update(s) dead after ${Math.round(c.timers.inboxDeadMs / 3_600_000)} h`,
    );
  }
  c.db.run("DELETE FROM msg_day WHERE day < ?", utcDay(now - 30 * 86_400_000));
  const keepBefore = now - c.timers.inboxKeepMs;
  const deleted =
    c.db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM inbox WHERE state IN ('accepted', 'replicated', 'dead') AND received_at <= ?",
      keepBefore,
    )?.n ?? 0;
  if (deleted)
    c.db.run(
      "DELETE FROM inbox WHERE state IN ('accepted', 'replicated', 'dead') AND received_at <= ?",
      keepBefore,
    );
  return { dead, deleted };
}

/** Next inbox wake retry time (add §2.2): received_at + 15 s, + 30 s, then every 60 s after the last try. */
export function nextWakeRetryAt(c: Ctx): number | null {
  const oldest = c.db.one<{ m: number | null }>(
    "SELECT MIN(received_at) AS m FROM inbox WHERE state = 'pending' AND quiet = 0",
  )?.m;
  if (oldest == null) return null;
  const last = c.db.metaNum("inboxWakeTryAt", 0);
  const t = c.timers;
  if (last < oldest + t.inboxWakeFirstMs) return oldest + t.inboxWakeFirstMs;
  if (last < oldest + t.inboxWakeSecondMs) return oldest + t.inboxWakeSecondMs;
  return last + t.inboxWakeEveryMs;
}

export function inboxRows(c: Ctx, limit = 200): Omit<InboxRow, "body" | "headers">[] {
  return c.db.all(
    `SELECT id, route, account, platform_key, received_at, sender_id, chat_id, state, attempts, next_attempt_at,
       accepted_at, accepted_boot_gen, replicated_at, dead_reason FROM inbox ORDER BY received_at DESC LIMIT ?`,
    limit,
  );
}

/** Inbox route of a channel name: `telegram`, an adapter's config channel (`slack`, `discord`, `sms`) or its id (`twilio`). */
export function routeOfChannel(name: string): string | null {
  if (name === "telegram") return ROUTE_TG;
  return ADAPTERS.find((a) => a.channel === name || a.id === name)?.route ?? null;
}

/**
 * Dead-letter open rows (owner drop, `channels remove --force`, `sleep now --force`). A row in `states` that
 * matches `id` (one row) or `route` (all of its rows; null = every route) becomes `dead` with `reason`.
 */
export function dropInbox(
  c: Ctx,
  o: { id?: string | null; route?: string | null; states?: string[]; reason: string },
): { n: number; ids: string[] } {
  const states = (o.states?.length ? o.states : ["pending", "held"]).filter((x) =>
    ["pending", "held"].includes(x),
  );
  const where = [`state IN (${states.map(() => "?").join(", ")})`];
  const args: SqlValue[] = [...states];
  if (o.id) {
    where.push("id = ?");
    args.push(o.id);
  }
  if (o.route) {
    where.push("route = ?");
    args.push(o.route);
  }
  const ids = c.db
    .all<{ id: string }>(`SELECT id FROM inbox WHERE ${where.join(" AND ")}`, ...args)
    .map((r) => r.id);
  if (!ids.length) return { n: 0, ids };
  c.db.run(
    `UPDATE inbox SET state = 'dead', dead_reason = ?, next_attempt_at = NULL WHERE ${where.join(" AND ")}`,
    o.reason,
    ...args,
  );
  ring(c, "inbox", "drop", { n: ids.length, route: o.route ?? null, reason: o.reason });
  return { n: ids.length, ids: ids.slice(0, 200) };
}
