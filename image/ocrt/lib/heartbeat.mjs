// Heartbeat and self-fence (plan §4.12; scope §1.1 "Heartbeat and fence"; contract §4).
// - 409 stale -> onStale (caller: kill gateway tree, stop Litestream with no final sync, exit 77).
// - no 2xx ack for fenceMs on the fence clock -> onFence (caller: SIGTERM gateway 15 s, reap, keep
//   container, Litestream and the heartbeat). A later 2xx ack with the current gen -> onUnfence.
// Fence clock: CLOCK_BOOTTIME (/proc/uptime counts suspend), plus the monotonic and wall clocks; the
// largest forward delta wins, so a VM pause or a wall jump fences early, never late.
import fs from "node:fs";
import { StaleError } from "./gate.mjs";

export const HB_MS = 30_000;
export const FENCE_MS = 150_000;
const WALL_JUMP_MAX_MS = 24 * 3600_000;

export function bootClockMs(file = "/proc/uptime") {
  try {
    return Math.round(Number(fs.readFileSync(file, "utf8").split(" ")[0]) * 1000);
  } catch {
    return null;
  }
}

/** Clock triple. Tests pass their own. */
export const realClocks = () => ({
  mono: () => Math.round(performance.now()),
  boot: () => bootClockMs(),
  wall: () => Date.now(),
});

/** Elapsed ms between two clock snapshots: max of the forward deltas (wall only if sane). */
export function elapsedSince(a, b) {
  const d = [b.mono - a.mono];
  if (a.boot !== null && b.boot !== null) d.push(b.boot - a.boot);
  const w = b.wall - a.wall;
  if (w > 0 && w < WALL_JUMP_MAX_MS) d.push(w);
  return Math.max(...d);
}

/**
 * createHeartbeat(o): o = {send(body) -> ack, body() -> object, gen, fenceMs, clocks, onStale,
 * onFence(why), onUnfence(), onAck(ack), onStop(), log, enabled() -> bool}
 * Returns {tick(), check(), armFence(), state}.
 */
export function createHeartbeat(o) {
  const clocks = o.clocks || realClocks();
  let fenceMs = o.fenceMs ?? FENCE_MS;
  const snap = () => ({ mono: clocks.mono(), boot: clocks.boot(), wall: clocks.wall() });
  const st = {
    seq: 0,
    ok: 0,
    fail: 0,
    consecutiveFail: 0,
    lastAck: null,
    last: null,
    fenced: false,
    armed: false,
    stale: false,
  };
  let inflight = false;

  /** Start the fence clock (call when /v1/boot answered ok). */
  function armFence() {
    st.armed = true;
    st.lastAck = snap();
  }

  async function tick() {
    if (inflight || st.stale || (o.enabled && !o.enabled())) return;
    inflight = true;
    const body = { seq: st.seq++, ...o.body() };
    try {
      const ack = await o.send(body);
      st.ok++;
      st.consecutiveFail = 0;
      st.last = { at: clocks.wall(), ok: true };
      if (ack && ack.gen !== undefined && ack.gen !== o.gen) {
        // A 2xx with another gen is a stale answer: never unfence on it.
        st.last.wrongGen = ack.gen;
      } else {
        st.lastAck = snap();
        if (st.fenced) {
          st.fenced = false;
          o.log?.("unfence", {});
          o.onUnfence?.();
        }
        o.onAck?.(ack || {});
        if (ack?.stop) o.onStop?.();
      }
    } catch (e) {
      st.fail++;
      st.consecutiveFail++;
      st.last = { at: clocks.wall(), ok: false, err: e.message };
      if (e instanceof StaleError) {
        st.stale = true;
        o.onStale?.();
      }
    } finally {
      inflight = false;
    }
    check();
  }

  /** Fence check; call every 1 s. */
  function check() {
    if (!st.armed || st.fenced || st.stale) return;
    const since = elapsedSince(st.lastAck, snap());
    if (since >= fenceMs) {
      st.fenced = true;
      o.log?.("self-fence", { why: "heartbeat-lost", sinceAckMs: since });
      o.onFence?.("heartbeat-lost");
    }
  }

  return {
    tick,
    check,
    armFence,
    /** Plan timers (contract §3) override the env default. */
    setFenceMs(ms) {
      if (Number.isFinite(ms) && ms >= 1000) fenceMs = ms;
    },
    state: st,
    sinceAckMs: () => (st.lastAck ? elapsedSince(st.lastAck, snap()) : null),
  };
}
