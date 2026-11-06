// Narrow interface over ctx.container so the Runtime state machine is unit-testable with a fake.
// From spike/worker/src/core/container-port.ts (cf-orbs origin). M2 adds async start (30 s timer, hung
// start fault), labels, and the snapshot name. Platform facts (m0, cf-orbs m0-findings):
// - start() returns before the container is ready; it throws if already running.
// - a missing snapshot surfaces as a start() throw or a monitor() reject `Snapshot "<id>" was not found.`
// - destroy() makes monitor() resolve (exit-0, empty text) in m0; the classifier uses the op journal (C9).
// - exec does not inherit start() env. user must be numeric "uid:gid".
import type { InstanceSpec } from "./types";

export interface StartOptions {
  source: { image: string } | { snapshotId: string };
  instance: InstanceSpec;
  enableInternet: boolean;
  env?: Record<string, string>;
  entrypoint?: string[];
  labels?: Record<string, string>;
}

export interface ExecOptions {
  env?: Record<string, string>;
  /** numeric "uid:gid" */
  user?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  pid: number;
  durationMs: number;
}

export interface ContainerPort {
  readonly running: boolean;
  images(): Record<string, string>;
  start(opts: StartOptions): void | Promise<void>;
  /** Resolves when the container exits normally; rejects on failure, snapshot not found or destroy(). */
  monitor(): Promise<void>;
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  snapshot(name: string): Promise<{ id: string; size: number }>;
  destroy(reason?: string): Promise<void>;
  signal(signo: number): void;
  inspect(): Promise<{ image: string; labels: Record<string, string> } | null>;
  setInactivityTimeout(ms: number): Promise<void>;
  getTcpPort(port: number): Fetcher;
  interceptOutboundHttp(addr: string, target: Fetcher): Promise<void>;
  /** HTTPS intercept (test groups: api.telegram.org, LLM host → fakes). */
  interceptOutboundHttps?(addr: string, target: Fetcher): Promise<void>;
}

export interface Clock {
  now(): number;
  /** Resolves after ms. An abort drops the timer (the promise then never resolves). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((r) => {
      const t = setTimeout(r, ms);
      signal?.addEventListener("abort", () => clearTimeout(t), { once: true });
    }),
};

/** Wrap the real DO container. Kept tiny; all logic lives behind the interface. */
export function wrapContainer(c: Container): ContainerPort {
  const td = new TextDecoder();
  const cap = (s: string) => (s.length > 65_536 ? `${s.slice(0, 65_536)}\n[truncated]` : s);
  const cc = c as any;
  return {
    get running() {
      return c.running;
    },
    images: () => (cc.images ?? {}) as Record<string, string>,
    start(o) {
      const base: any = { enableInternet: o.enableInternet, instance: o.instance, labels: o.labels };
      if (o.env) base.env = o.env;
      if (o.entrypoint) base.entrypoint = o.entrypoint;
      if ("image" in o.source) base.image = o.source.image;
      else base.containerSnapshot = { id: o.source.snapshotId };
      return cc.start(base);
    },
    monitor: () => c.monitor(),
    async exec(cmd, o = {}) {
      const t0 = Date.now();
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), o.timeoutMs ?? 20_000);
      try {
        const p = await cc.exec(cmd, {
          env: o.env,
          user: o.user,
          cwd: o.cwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await p.output();
        return {
          exitCode: out.exitCode,
          stdout: cap(td.decode(out.stdout)),
          stderr: cap(td.decode(out.stderr)),
          pid: p.pid,
          durationMs: Date.now() - t0,
        };
      } finally {
        clearTimeout(t);
      }
    },
    async snapshot(name) {
      const s = await cc.snapshotContainer({ name });
      return { id: s.id, size: s.size };
    },
    destroy: (reason) => (reason ? cc.destroy(reason) : c.destroy()),
    signal: (n) => c.signal(n),
    inspect: () => cc.inspect() as Promise<{ image: string; labels: Record<string, string> } | null>,
    setInactivityTimeout: (ms) => cc.setInactivityTimeout(ms),
    getTcpPort: (p) => c.getTcpPort(p),
    interceptOutboundHttp: (a, t) => cc.interceptOutboundHttp(a, t),
    interceptOutboundHttps: (a, t) => cc.interceptOutboundHttps(a, t),
  };
}

/** Race p against a timer. On timeout returns {timeout:true}; p keeps running (its result is dropped). */
export async function withTimeout<T>(
  clock: Clock,
  p: Promise<T>,
  ms: number,
): Promise<{ timeout: false; value: T } | { timeout: true }> {
  const ac = new AbortController();
  const timer = clock.sleep(ms, ac.signal).then(() => ({ timeout: true as const }));
  try {
    return await Promise.race([p.then((value) => ({ timeout: false as const, value })), timer]);
  } finally {
    ac.abort();
  }
}
