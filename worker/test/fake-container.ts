// Fake of the platform `ctx.container` (workers-types `Container`), not of a wrapper, so the
// Runtime DO under test runs its real wrapping code. Grown from spike/worker/test/fake-container.ts
// with the spec §21.1 additions: getTcpPort, intercept registry, labels, inspect, capacity reject on
// the monitor path, hung destroy/inspect/start, reject without exitCode, exit-class injector.
import { TEXT } from "./harness/texts";

export type ExecAnswer = { exitCode?: number; stdout?: string; stderr?: string } | "hang";
export type ExecHandler = (cmd: string[], opts: ContainerExecOptions) => ExecAnswer | Promise<ExecAnswer>;
export type PortHandler = (port: number, req: Request) => Response | Promise<Response>;

/** How the next start() behaves. */
export type StartScript =
  | "ok"
  | { throw: string } // start() throws synchronously
  | { monitorReject: string; exitCode?: number } // start() returns, monitor() rejects at once
  | "hang"; // start() returns; container never answers exec or ports (hung start, guess §24)

export interface CallRec {
  at: number;
  op: string;
  detail?: unknown;
}

type Waiter = { res: () => void; rej: (e: unknown) => void };

const enc = new TextEncoder();

/** An error the way the platform rejects monitor(): message plus optional numeric exitCode. */
export function platformError(text: string, exitCode?: number): Error {
  const e = new Error(text);
  if (exitCode !== undefined) (e as Error & { exitCode: number }).exitCode = exitCode;
  return e;
}

export class FakeContainer {
  private _running = false;
  private waiters: Waiter[] = [];
  private pendingFailure: Error | null = null;
  private hung = false;
  private releaseHangs: (() => void)[] = [];

  /** Every platform call in order, with the fake clock time. */
  calls: CallRec[] = [];
  startOpts: ContainerStartupOptions | undefined;
  labels: Record<string, string> = {};
  intercepts = new Map<string, Fetcher>();
  inactivity: { at: number; ms: number }[] = [];
  snapshots = new Map<string, { size: number; at: number; name?: string }>();
  imageMap: Record<string, string>;

  // Scripts
  startScript: StartScript[] = [];
  /** Used when startScript is empty. */
  startDefault: StartScript = "ok";
  inspectHang = 0; // number of next inspect() calls that never answer
  destroyHang = 0; // number of next destroy() calls that never answer
  snapshotFail: string[] = []; // texts for the next snapshotContainer() calls
  snapshotSize = 31_000_000;
  /** Throw from start() for an unknown snapshot id instead of the async monitor reject. */
  snapshotMissThrows = false;
  execHandler: ExecHandler = () => ({ exitCode: 0 });
  portHandler: PortHandler = () => new Response("no gateway", { status: 502 });
  onStart: (o: ContainerStartupOptions) => void = () => {};
  /** Called at the start of a platform call (tests act "at phase 7/8" with these). */
  hooks: { snapshot?: () => void; destroy?: () => void } = {};
  onStop: () => void = () => {};

  constructor(
    private now: () => number,
    images: Record<string, string> = { oc: "registry.cloudflare.com/acct/oc@sha256:aa" },
  ) {
    this.imageMap = { ...images };
  }

  private log(op: string, detail?: unknown) {
    this.calls.push({ at: this.now(), op, detail });
  }
  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }

  get running() {
    return this._running;
  }
  get images() {
    return { ...this.imageMap };
  }

  start(o: ContainerStartupOptions = {} as ContainerStartupOptions): void {
    this.log("start", o);
    if (this._running) throw new Error(TEXT.alreadyRunning);
    const s = this.startScript.shift() ?? this.startDefault;
    if (typeof s === "object" && "throw" in s) throw new Error(s.throw);
    const snap = (o as { containerSnapshot?: { id: string } }).containerSnapshot?.id;
    if (snap && !this.snapshots.has(snap) && this.snapshotMissThrows)
      throw new Error(TEXT.snapshotMissing(snap));
    this.startOpts = o;
    this.labels = { ...(o.labels ?? {}) };
    this._running = true;
    this.hung = s === "hang";
    this.pendingFailure = null;
    if (snap && !this.snapshots.has(snap)) {
      this.failSoon(new Error(TEXT.snapshotMissing(snap)));
      return;
    }
    if (typeof s === "object" && "monitorReject" in s) {
      this.failSoon(platformError(s.monitorReject, s.exitCode));
      return;
    }
    if (!this.hung) this.onStart(o);
  }

  private failSoon(e: Error) {
    this.pendingFailure = e;
    queueMicrotask(() => this.settle(e));
  }

  monitor(): Promise<void> {
    this.log("monitor");
    return new Promise((res, rej) => {
      if (!this._running && this.pendingFailure) return rej(this.pendingFailure);
      this.waiters.push({ res, rej });
    });
  }

  /** Settle every monitor() waiter and mark the container stopped. err undefined = resolve. */
  settle(err?: unknown) {
    const was = this._running;
    this._running = false;
    this.hung = false;
    const w = this.waiters;
    this.waiters = [];
    for (const x of w) err === undefined ? x.res() : x.rej(err);
    if (was) this.onStop();
  }

  // ---- Exit-class injector (spec §9.1 inputs) ----
  /** Process exit with a code (m0 text). With event=false no exitCode property (reject without exitCode). */
  crash(code: number, withExitCode = true) {
    this.settle(platformError(TEXT.exitCode(code), withExitCode ? code : undefined));
  }
  rejectText(text: string, exitCode?: number) {
    this.settle(platformError(text, exitCode));
  }
  /** Platform drain end: reject with the signalled text. */
  signalled() {
    this.settle(platformError(TEXT.signalled));
  }
  /** Normal exit: monitor() resolves. */
  exitClean() {
    this.settle();
  }
  /** Inactivity-stop shape: container gone, no settle at all (m0 T7c(1)). */
  vanish() {
    const was = this._running;
    this._running = false;
    this.waiters = [];
    if (was) this.onStop();
  }
  /** DO restart: the old instance's monitor() promises are gone. */
  dropWaiters() {
    this.waiters = [];
  }
  /** Release every hung call (hang ends with an error). */
  releaseAll() {
    for (const r of this.releaseHangs.splice(0)) r();
  }
  private hang<T>(signal?: AbortSignal): Promise<T> {
    return new Promise<T>((_res, rej) => {
      const end = () => rej(new Error("aborted"));
      signal?.addEventListener("abort", end, { once: true });
      this.releaseHangs.push(() => rej(new Error("released")));
    });
  }

  async destroy(error?: unknown): Promise<void> {
    this.log("destroy", error === undefined ? undefined : String(error));
    this.hooks.destroy?.();
    if (this.destroyHang > 0) {
      this.destroyHang--;
      return this.hang();
    }
    // m0 T7c(4): destroy() makes monitor() resolve with no text.
    if (this._running) this.settle();
  }

  signal(signo: number): void {
    this.log("signal", signo);
  }

  async exec(cmd: string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
    this.log("exec", cmd);
    if (!this._running) throw new Error(TEXT.notStarted);
    if (this.pendingFailure) throw this.pendingFailure;
    if (this.hung) return this.hang(options.signal);
    const a = await this.execHandler(cmd, options);
    if (a === "hang") return this.hang(options.signal);
    const out = {
      exitCode: a.exitCode ?? 0,
      stdout: enc.encode(a.stdout ?? ""),
      stderr: enc.encode(a.stderr ?? ""),
    };
    return {
      stdin: null,
      stdout: new Response(out.stdout).body,
      stderr: new Response(out.stderr).body,
      pid: 100 + this.calls.length,
      isPty: false,
      exitCode: Promise.resolve(out.exitCode),
      output: async () => out,
      kill: () => {},
      resize: () => {},
    } as unknown as ExecProcess;
  }

  async inspect(): Promise<ContainerInfo | null> {
    this.log("inspect");
    if (this.inspectHang > 0) {
      this.inspectHang--;
      return this.hang();
    }
    if (!this._running) return null;
    return { image: this.imageMap.oc ?? "", labels: { ...this.labels } };
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.inactivity.push({ at: this.now(), ms: Number(ms) });
  }

  getTcpPort(port: number): Fetcher {
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!this._running || this.hung) throw new Error("container port not listening");
        const req = input instanceof Request ? input : new Request(String(input), init);
        return this.portHandler(port, req);
      },
      connect: () => {
        throw new Error("connect not faked");
      },
    } as unknown as Fetcher;
  }

  async interceptOutboundHttp(addr: string, binding: Fetcher): Promise<void> {
    this.log("intercept", addr);
    this.intercepts.set(addr, binding);
  }
  async interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    this.log("intercept-https", addr);
    this.intercepts.set(`https:${addr}`, binding);
  }
  async interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    this.intercepts.set("*", binding);
  }
  async interceptOutboundTcp(addr: string, binding: Fetcher): Promise<void> {
    this.intercepts.set(`tcp:${addr}`, binding);
  }

  async snapshotContainer(o: ContainerSnapshotOptions = {}): Promise<ContainerSnapshot> {
    this.log("snapshot", o.name);
    this.hooks.snapshot?.();
    if (!this._running) throw new Error("Container is not running");
    const f = this.snapshotFail.shift();
    if (f) throw new Error(f);
    const id = `snap-${this.snapshots.size + 1}-${this.now()}`;
    this.snapshots.set(id, { size: this.snapshotSize, at: this.now(), name: o.name });
    return { id, size: this.snapshotSize, name: o.name };
  }
  async snapshotDirectory(): Promise<never> {
    throw new Error("snapshotDirectory not faked");
  }
  async setLabels(labels: Record<string, string>): Promise<void> {
    this.labels = { ...labels };
  }

  /** Gate fetcher the container sees at addr (what ocsup's fetch to 15.0.0.1:80 hits). */
  gate(addr: string): Fetcher | undefined {
    return this.intercepts.get(addr);
  }
}
