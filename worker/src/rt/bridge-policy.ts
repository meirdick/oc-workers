// WS bridge policy (plan §7 "WebSocket"; add §2.5 rule 2 and "Idle-close latch"; M3-STATUS §5, §8):
// - close 1008 when the owner session ends (revoke, rotate, logout, 30 d expiry) and ≤ 24 h after the upgrade;
// - UI idle-close 1000 "idle" after uiIdleMs with no user-intent frame, or uiMaxMs with no chat/write frame;
// - an idle-close latches the session: its WS upgrades get 503 (no wake) until its next HTML GET.
// Pure over an injected clock and session check, so vitest drives it; runtime.ts runs `tick()` on a timer.

/** Frame classes of a client → gateway frame. Gateway protocol: {type:"req", id, method, params}. */
export type FrameClass = "intent" | "chat-or-write" | "poll";

/**
 * Write verbs (last method segment). Built from the 2026.10.9 Control UI bundle
 * (`dist/control-ui/assets/*.js`, every `request(\`<method>\`` call). guess: a method whose last segment is a
 * write verb changes state on the owner's behalf (config.set, cron.add, channels.pairing.approve, sessions.send…).
 */
const WRITE_VERBS = new Set([
  "send",
  "create",
  "reset",
  "delete",
  "patch",
  "patchMany",
  "set",
  "add",
  "update",
  "remove",
  "run",
  "approve",
  "reject",
  "install",
  "uninstall",
  "setEnabled",
  "dispatch",
  "steer",
  "abort",
  "resolve",
  "rotate",
  "revoke",
  "mutate",
  "save",
  "apply",
]);
/** chat.* reads the UI sends on its own (history load, metadata refresh): polls, not intent. */
const CHAT_READS = new Set(["chat.history", "chat.metadata", "chat.message.get"]);

/** Class of one client frame. Unknown or unparsable frames are polls (fail toward sleep, add §2.5). */
export function classifyFrame(data: unknown): FrameClass {
  if (typeof data !== "string" || data.length > 64 * 1024) return "poll";
  // Cheap pre-check: no "method" key, no parse.
  if (!data.includes('"method"')) return "poll";
  let method: unknown;
  try {
    const j = JSON.parse(data) as { type?: unknown; method?: unknown };
    if (j.type !== "req") return "poll";
    method = j.method;
  } catch {
    return "poll";
  }
  if (typeof method !== "string") return "poll";
  if (method === "presence.activity") return "intent";
  if (method.startsWith("chat.")) return CHAT_READS.has(method) ? "poll" : "chat-or-write";
  const last = method.split(".").pop() ?? "";
  return WRITE_VERBS.has(last) ? "chat-or-write" : "poll";
}

export interface BridgeMeta {
  /** Owner session id from the Worker (x-ochost-sid), or null (no session check, 24 h cap only). */
  sid: string | null;
  openedAt: number;
  /** Last user-intent frame (presence.activity, chat.*, write); starts at the upgrade. */
  lastIntentAt: number;
  /** Last chat.* or write frame; starts at the upgrade. */
  lastChatAt: number;
}

export interface PolicyTimers {
  wsMaxAgeMs: number;
  uiIdleMs: number;
  uiMaxMs: number;
}

export type CloseAction = { code: number; reason: string; latch: boolean };

/** Close decision for one bridge (sessionOk: null = not checked this round). */
export function bridgeDecision(
  m: BridgeMeta,
  now: number,
  t: PolicyTimers,
  sessionOk: boolean | null,
): CloseAction | null {
  if (sessionOk === false) return { code: 1008, reason: "session ended", latch: false };
  if (now - m.openedAt >= t.wsMaxAgeMs) return { code: 1008, reason: "max age 24 h", latch: false };
  if (now - m.lastIntentAt >= t.uiIdleMs) return { code: 1000, reason: "idle", latch: true };
  if (now - m.lastChatAt >= t.uiMaxMs) return { code: 1000, reason: "idle (max)", latch: true };
  return null;
}

/** Note one client frame on a bridge. Returns its class (the caller counts intent as activity). */
export function noteFrame(m: BridgeMeta, data: unknown, now: number): FrameClass {
  const c = classifyFrame(data);
  if (c !== "poll") m.lastIntentAt = now;
  if (c === "chat-or-write") m.lastChatAt = now;
  return c;
}

export interface WatchedBridge {
  meta: BridgeMeta;
  close(code: number, reason: string): void;
}

export interface WatchDeps {
  now(): number;
  timers: PolicyTimers;
  /** Owner session still valid? Throws or rejects → keep the socket this round (Auth DO hiccup). */
  check?(sid: string): Promise<boolean>;
  latch(sid: string): void;
  log(msg: string, data?: unknown): void;
}

/**
 * One watch round over the open bridges: session check (once per sid), 24 h cap, idle-close + latch.
 * Returns the number closed.
 */
export async function watchRound(list: WatchedBridge[], d: WatchDeps): Promise<number> {
  const now = d.now();
  const sids = [...new Set(list.map((b) => b.meta.sid).filter((s): s is string => !!s))];
  const ok = new Map<string, boolean | null>();
  await Promise.all(
    sids.map(async (sid) => {
      if (!d.check) return ok.set(sid, null);
      try {
        ok.set(sid, await d.check(sid));
      } catch {
        ok.set(sid, null);
      }
    }),
  );
  let n = 0;
  for (const b of list) {
    const a = bridgeDecision(b.meta, now, d.timers, b.meta.sid ? (ok.get(b.meta.sid) ?? null) : null);
    if (!a) continue;
    if (a.latch && b.meta.sid) d.latch(b.meta.sid);
    d.log("ws policy close", { code: a.code, reason: a.reason, sid: b.meta.sid ? "set" : null });
    b.close(a.code, a.reason);
    n++;
  }
  return n;
}
