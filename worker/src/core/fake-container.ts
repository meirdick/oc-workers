// Fake ContainerPort and fake clock for vitest (spec 08 §21.1). From spike/worker/test/fake-container.ts,
// extended per plan §3.2: getTcpPort handler, intercept registry, labels, inspect, capacity reject on the
// monitor path, hung destroy/inspect/start, reject without exitCode, exit-class injector with the m0 texts.
// Test-only: nothing in the Worker bundle imports this file.
import type { Clock, ContainerPort, ExecOptions, ExecResult, StartOptions } from "./container-port";

export type ExecHandler = (
  cmd: string[],
  opts: ExecOptions,
  fake: FakeContainer,
) => Partial<ExecResult> | string | undefined | Promise<Partial<ExecResult> | string | undefined>;

type Waiter = { res: () => void; rej: (e: Error) => void };

/** m0 texts per exit class (m0 T7c(1), (4), T7e row 6). */
export const M0_TEXTS = Object.freeze({
  oom: "Container exited with unexpected exit code: 137",
  capacity: "There is no container instance that can be provided to this durable object",
  signalled: "The runtime signalled the container to exit",
  snapshot: (id: string) => `Snapshot "${id}" was not found.`,
  destroyed: "Container was destroyed",
  exit: (code: number) => `Container exited with unexpected exit code: ${code}`,
});

/** Error with an exitCode property, like the platform reject. */
export function exitError(code: number, text = M0_TEXTS.exit(code)): Error {
  return Object.assign(new Error(text), { exitCode: code });
}

/**
 * Fake clock. sleep() registers a timer; when the event loop is idle (setImmediate), time jumps to the
 * earliest timer. So awaits on fake I/O finish before time moves. auto=false: only advance() moves time.
 */
export class FakeClock implements Clock {
  t = Date.parse("2026-10-31T12:00:00Z");
  auto = true;
  private timers: { at: number; seq: number; res: () => void }[] = [];
  private seq = 0;
  private pumping = false;
  now() {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((res) => {
      const x = { at: this.t + Math.max(0, ms), seq: this.seq++, res };
      this.timers.push(x);
      signal?.addEventListener(
        "abort",
        () => {
          const i = this.timers.indexOf(x);
          if (i >= 0) this.timers.splice(i, 1);
        },
        { once: true },
      );
      this.pump();
    });
  }
  /** Move time and fire every due timer. */
  async advance(ms: number) {
    this.t += ms;
    this.fireDue();
    await settle();
  }
  get pendingTimers() {
    return this.timers.length;
  }
  private fireDue() {
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    while (this.timers.length && (this.timers[0] as { at: number }).at <= this.t) this.timers.shift()?.res();
  }
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      if (!this.auto || !this.timers.length) return;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const first = this.timers.shift() as { at: number; res: () => void };
      if (first.at > this.t) this.t = first.at;
      first.res();
      if (this.timers.length) this.pump();
    });
  }
}

/** Let queued microtasks and immediates run. */
export async function settle(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

export class FakeContainer implements ContainerPort {
  running = false;
  knownSnapshots = new Map<string, number>();
  startedWith?: StartOptions;
  startCount = 0;
  destroyCount = 0;
  destroyReasons: string[] = [];
  snapshotCount = 0;
  signals: number[] = [];
  inactivityCalls: number[] = [];
  /** exec(["true"]) fails until now >= readyAt. */
  readyAfterMs = 0;
  /** Errors thrown by the next start() calls, in order (capacity, snapshot, already running, other). */
  startErrors: Error[] = [];
  /** start() never returns (hung start fault). */
  hangStart = false;
  /** destroy() never returns (hung destroy fault); the container keeps running. */
  hangDestroy = false;
  /** inspect() never returns. */
  hangInspect = false;
  /** Next snapshot() calls throw these, in order. */
  snapshotErrors: Error[] = [];
  snapshotDelayMs = 0;
  snapshotSize = 31_000_000;
  /** destroy() settles monitor(): "resolve" (m0 exit-0) or "reject" with M0_TEXTS.destroyed. */
  destroySettle: "resolve" | "reject" = "resolve";
  execLog: { cmd: string[]; user?: string }[] = [];
  /** Order of calls, to check intercepts before start(). */
  calls: string[] = [];
  intercepts = new Map<string, Fetcher>();
  /** Labels a container started by another code path carries (already-running cases). */
  foreignLabels?: Record<string, string>;
  handler: ExecHandler = () => ({ exitCode: 0, stdout: "" });
  portHandler: (req: Request, port: number) => Response | Promise<Response> = (req) =>
    new URL(req.url).pathname === "/startupz"
      ? Response.json({ status: "started" })
      : new Response("ok", { status: 200 });
  private waiters: Waiter[] = [];
  private pendingFailure?: Error;
  readyAt = 0;
  constructor(
    public clock: Clock,
    public imageMap: Record<string, string> = { oc: "registry.cloudflare.com/acct/oc-host-oc@sha256:beef" },
  ) {}
  images() {
    return this.imageMap;
  }
  async start(o: StartOptions) {
    this.calls.push("start");
    if (this.hangStart) return new Promise<void>(() => {});
    const e = this.startErrors.shift();
    if (e) throw e;
    if (this.running) throw new Error("Container is already running");
    this.startedWith = o;
    this.startCount++;
    this.running = true;
    this.foreignLabels = undefined;
    this.readyAt = this.clock.now() + this.readyAfterMs;
    this.pendingFailure = undefined;
    if ("snapshotId" in o.source && !this.knownSnapshots.has(o.source.snapshotId)) {
      const err = new Error(M0_TEXTS.snapshot(o.source.snapshotId));
      this.pendingFailure = err;
      queueMicrotask(() => this.exit(err));
    }
  }
  monitor(): Promise<void> {
    return new Promise((res, rej) => {
      if (!this.running && this.pendingFailure) return rej(this.pendingFailure);
      if (!this.running) return res();
      this.waiters.push({ res, rej });
    });
  }
  /** Settle every monitor() waiter: resolve on undefined, reject with err. Container stops. */
  exit(err?: Error) {
    this.running = false;
    const w = this.waiters;
    this.waiters = [];
    for (const x of w) err ? x.rej(err) : x.res();
  }
  /** Container stops with no monitor() settle (inactivity-stop shape, lost). */
  vanish() {
    this.running = false;
    this.waiters = [];
  }
  /** DO restart: the old instance monitor() promises are gone. */
  dropWaiters() {
    this.waiters = [];
  }
  /** A container this DO did not start in this life is running (DO restart, zombie). */
  adoptRunning(labels: Record<string, string>) {
    this.running = true;
    this.foreignLabels = labels;
    this.readyAt = 0;
  }
  waiterCount() {
    return this.waiters.length;
  }
  async exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.running) throw new Error("The container has not been started");
    if (this.pendingFailure) throw this.pendingFailure;
    if (this.clock.now() < this.readyAt) throw new Error("connection refused: container not ready");
    this.execLog.push({ cmd, user: opts.user });
    const r = await this.handler(cmd, opts, this);
    const base: ExecResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      pid: 100 + this.execLog.length,
      durationMs: 1,
    };
    if (typeof r === "string") return { ...base, stdout: r };
    return { ...base, ...(r ?? {}) };
  }
  async snapshot(_name: string) {
    if (!this.running) throw new Error("Container is not running");
    const e = this.snapshotErrors.shift();
    if (e) throw e;
    if (this.snapshotDelayMs) await this.clock.sleep(this.snapshotDelayMs);
    if (!this.running) throw new Error("container stopped during snapshot");
    this.snapshotCount++;
    const id = `snap-${this.snapshotCount}-${crypto.randomUUID().slice(0, 8)}`;
    this.knownSnapshots.set(id, this.snapshotSize);
    return { id, size: this.snapshotSize };
  }
  async destroy(reason?: string) {
    this.calls.push("destroy");
    this.destroyReasons.push(reason ?? "");
    this.destroyCount++;
    if (this.hangDestroy) return new Promise<void>(() => {});
    if (this.running)
      this.destroySettle === "resolve" ? this.exit() : this.exit(new Error(M0_TEXTS.destroyed));
  }
  signal(n: number) {
    this.signals.push(n);
  }
  async inspect() {
    if (this.hangInspect) return new Promise<null>(() => {});
    if (!this.running) return null;
    return { image: this.imageMap.oc ?? "", labels: this.foreignLabels ?? this.startedWith?.labels ?? {} };
  }
  async setInactivityTimeout(ms: number) {
    this.inactivityCalls.push(ms);
  }
  getTcpPort(port: number): Fetcher {
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!this.running) throw new Error("container not running");
        return this.portHandler(new Request(input as string, init), port);
      },
    } as unknown as Fetcher;
  }
  async interceptOutboundHttp(addr: string, t: Fetcher) {
    this.calls.push(`intercept:${addr}`);
    this.intercepts.set(addr, t);
  }
}
