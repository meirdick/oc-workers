// /ops/fault hooks for the Runtime DO (spec 08 §19.2, OC_TEST=1 only): wraps the container port and
// injects capacity, snapshot-not-found, hung inspect/start/destroy and destroy timeouts. In memory only:
// a DO restart clears them (guess: enough for the live groups; each hook is armed right before use).
import type { ContainerPort } from "../core/container-port";

export interface Faults {
  capacity: number;
  snapshotNotFound: number;
  hungInspect: number;
  hungStart: number;
  hungDestroy: number;
  /** Heartbeats answer 503 (onHeartbeat throws) until this time. */
  hbDropUntil: number;
  /** M4 S8: the next N requestWake calls are dropped (no state change). */
  dropWake: number;
  /** M4 S1/S9/S6: act when the sleep op reaches this phase (before the phase runs). */
  sleepAt: SleepAtFault | null;
  /** Set by the Runtime DO: ctx.abort (DO host loss). Kept by `clear`. */
  abort?: (why: string) => void;
}

export interface SleepAtFault {
  phase: string;
  action: "sigkill" | "sigterm" | "hostkill" | "hold";
  ms: number;
}

const SLEEP_AT_ACTIONS = new Set(["sigkill", "sigterm", "hostkill", "hold"]);

export const noFaults = (): Faults => ({
  capacity: 0,
  snapshotNotFound: 0,
  hungInspect: 0,
  hungStart: 0,
  hungDestroy: 0,
  hbDropUntil: 0,
  dropWake: 0,
  sleepAt: null,
});

const never = <T>() => new Promise<T>(() => {});

export function faultyContainer(inner: ContainerPort, f: Faults): ContainerPort {
  return {
    get running() {
      return inner.running;
    },
    images: () => inner.images(),
    start(o) {
      if (f.hungStart > 0) {
        f.hungStart--;
        return never<void>();
      }
      if (f.capacity > 0) {
        f.capacity--;
        throw new Error("There is no container instance that can be provided to this durable object (fault)");
      }
      if (f.snapshotNotFound > 0 && "snapshotId" in o.source) {
        f.snapshotNotFound--;
        throw new Error(`Snapshot "${o.source.snapshotId}" was not found.`);
      }
      return inner.start(o);
    },
    monitor: () => inner.monitor(),
    exec: (c, o) => inner.exec(c, o),
    snapshot: (n) => inner.snapshot(n),
    destroy(reason) {
      if (f.hungDestroy > 0) {
        f.hungDestroy--;
        return never<void>();
      }
      return inner.destroy(reason);
    },
    signal: (n) => inner.signal(n),
    inspect() {
      if (f.hungInspect > 0) {
        f.hungInspect--;
        return never();
      }
      return inner.inspect();
    },
    setInactivityTimeout: (ms) => inner.setInactivityTimeout(ms),
    getTcpPort: (p) => inner.getTcpPort(p),
    interceptOutboundHttp: (a, t) => inner.interceptOutboundHttp(a, t),
    interceptOutboundHttps: inner.interceptOutboundHttps
      ? (a, t) => (inner.interceptOutboundHttps as NonNullable<ContainerPort["interceptOutboundHttps"]>)(a, t)
      : undefined,
  };
}

/** Apply one /ops/fault call. count = how many next calls the hook hits (default 1). */
export function setFault(f: Faults, name: string, p: Record<string, unknown>, now: number): string | null {
  const n = typeof p.count === "number" && p.count > 0 ? Math.floor(p.count) : 1;
  switch (name) {
    case "capacity":
      f.capacity = n;
      return null;
    case "snapshot-not-found":
      f.snapshotNotFound = n;
      return null;
    case "hung-inspect":
      f.hungInspect = n;
      return null;
    case "hung-start":
      f.hungStart = n;
      return null;
    case "hung-destroy":
    case "destroy-timeout":
      f.hungDestroy = n;
      return null;
    case "hb-drop":
      f.hbDropUntil = now + (typeof p.ms === "number" ? p.ms : 60_000);
      return null;
    case "drop-wake":
      f.dropWake = n;
      return null;
    case "sleep-at": {
      const action = String(p.action ?? "sigkill");
      if (typeof p.phase !== "string" || !SLEEP_AT_ACTIONS.has(action))
        return "sleep-at needs phase and action";
      f.sleepAt = {
        phase: p.phase,
        action: action as SleepAtFault["action"],
        ms: typeof p.ms === "number" ? p.ms : 60_000,
      };
      return null;
    }
    case "clear":
      Object.assign(f, noFaults(), { abort: f.abort });
      return null;
    default:
      return `unknown fault ${name}`;
  }
}
