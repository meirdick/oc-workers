// Runtime DO `rt:<inst>:e<N>` (spec 08 §4, §5). Wires RuntimeCore to ctx.container, SQLite storage,
// alarms, the Control DO and the gate entrypoints. All logic lives in core.ts.
import { DurableObject } from "cloudflare:workers";
import { realClock, wrapContainer } from "../core/container-port";
import { secretEnv } from "../core/secret-env";
import { timersFrom } from "../core/timers";
import type {
  ControlForRuntime,
  Env,
  InstanceSpec,
  RuntimeGateRpc,
  RuntimeRpc,
  WakeReason,
} from "../core/types";
import { ctlName } from "../core/types";
import { CODE_VERSION } from "../core/version";
import { type AuthRpc, authName } from "../ingress/auth-do";
import { sbxName } from "../sbx/core";
import { watchRound } from "./bridge-policy";
import { errorText } from "./classify";
import { type GateProps, RuntimeCore } from "./core";
import { freshStub } from "./ctl-stub";
import { type Faults, faultyContainer, noFaults } from "./faults";
import { Bridges, proxyToGateway, SID_HEADER, wakingResponse } from "./proxy";
import { rtTimersFrom } from "./rt-timers";

const DEFAULT_INSTANCE = { vcpu: 2, memoryMib: 6144, diskMb: 20000 };

/** `rt:<inst>:e<N>` → {inst, epoch}. */
export function parseRtName(name: string): { inst: string; epoch: number } | null {
  const m = /^rt:([a-z0-9][a-z0-9-]{0,30}):e(\d+)$/.exec(name);
  return m ? { inst: m[1] as string, epoch: Number(m[2]) } : null;
}

export function instanceFrom(env: { OC_INSTANCE?: string }): InstanceSpec {
  try {
    const v = env.OC_INSTANCE ? (JSON.parse(env.OC_INSTANCE) as InstanceSpec) : DEFAULT_INSTANCE;
    return v ?? DEFAULT_INSTANCE;
  } catch {
    return DEFAULT_INSTANCE;
  }
}

export { secretEnv };

const isWs = (req: Request) => (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
const isNav = (req: Request) =>
  req.method === "GET" && !isWs(req) && (req.headers.get("accept") ?? "").includes("text/html");
const LATCH_KEY = "uiLatch";
const LATCH_MAX = 32;

/** Idle-close latch (add §2.5): {sid: at}, newest LATCH_MAX kept. */
export class Latches {
  constructor(private store: { get<T>(k: string): T | undefined; put(k: string, v: unknown): void }) {}
  private all(): Record<string, number> {
    return this.store.get<Record<string, number>>(LATCH_KEY) ?? {};
  }
  has(sid: string): boolean {
    return sid in this.all();
  }
  set(sid: string, at: number) {
    const m = { ...this.all(), [sid]: at };
    const keep = Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LATCH_MAX);
    this.store.put(LATCH_KEY, Object.fromEntries(keep));
  }
  clear(sid: string): boolean {
    const m = this.all();
    if (!(sid in m)) return false;
    delete m[sid];
    this.store.put(LATCH_KEY, m);
    return true;
  }
}

export class Runtime extends DurableObject<Env> implements RuntimeRpc, RuntimeGateRpc {
  private core: RuntimeCore | null = null;
  private readonly bridges = new Bridges();
  private wsTimer: ReturnType<typeof setInterval> | null = null;
  private ready: Promise<void> | null = null;
  private readonly faults: Faults | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.faults = env.OC_TEST === "1" ? noFaults() : null;
    // M4 S1 hostkill: the DO dies with the container (test groups only).
    if (this.faults) this.faults.abort = (why) => ctx.abort(why);
    const name = ctx.id.name ?? null;
    if (name) this.ready = ctx.blockConcurrencyWhile(() => this.build(name));
  }

  private async build(name: string): Promise<void> {
    const p = parseRtName(name);
    if (!p) throw new Error(`bad Runtime DO name ${name}`);
    const c = this.ctx.container;
    if (!c) throw new Error("Runtime has no container; check wrangler.jsonc containers");
    const env = this.env;
    const exp = this.ctx.exports as unknown as Record<string, (o: { props: GateProps }) => Fetcher>;
    const gate = (cls: string) => (props: GateProps) => {
      const f = exp[cls];
      if (!f) throw new Error(`${cls} entrypoint is not exported`);
      return f({ props: { ...props, ...(env.OC_TEST === "1" ? { test: true } : {}) } });
    };
    const ctlStub = freshStub(() => env.CONTROL.getByName(ctlName(p.inst)) as unknown as ControlForRuntime);
    const storage = this.ctx.storage;
    this.core = new RuntimeCore({
      inst: p.inst,
      epoch: p.epoch,
      container: this.faults ? faultyContainer(wrapContainer(c), this.faults) : wrapContainer(c),
      faults: this.faults ?? undefined,
      storage: { sql: storage.sql as never, transactionSync: (fn) => storage.transactionSync(fn) },
      clock: realClock,
      timers: timersFrom(env),
      ctl: ctlStub,
      gates: {
        control: gate("ControlGate"),
        replica: gate("ReplicaGate"),
        cap: gate("CapGate"),
        sbx: gate("SandboxGate"),
        // Test groups: Telegram and LLM calls from the gateway go to the fakes (spike T7b, T7d).
        // M4b L3: prod Bot API calls pass through TelegramGate, which notes replies for the inbox.
        ...(env.OC_TEST === "1"
          ? { test: { "api.telegram.org": gate("TelegramFake"), "api.anthropic.com": gate("LlmMock") } }
          : { test: { "api.telegram.org": gate("TelegramGate") } }),
      },
      alarm: {
        set: (at) => storage.setAlarm(at),
        get: () => storage.getAlarm(),
        delete: () => storage.deleteAlarm(),
      },
      instance: instanceFrom(env),
      // M7 F1: a secret put after this DO was built arrives through freshSecretEnv (the Worker's newer env).
      secretEnv: () => ({ ...secretEnv(env), ...this.freshEnv }),
      codeVersion: CODE_VERSION,
      buildStale: () => this.isStale(),
      recycle: () => this.ctx.abort("redeploy"),
      exitCodeConfirms: false,
      bridges: () => this.bridges.count,
      closeBridges: (code, reason) => this.bridges.closeAll(code, reason),
      rtTimers: rtTimersFrom(env),
      sandboxSleep: env.SANDBOX
        ? () => {
            const sb = env.SANDBOX?.getByName(sbxName(p.inst)) as unknown as {
              sleep(r: string): Promise<unknown>;
            };
            this.ctx.waitUntil(sb.sleep("install").catch(() => undefined));
          }
        : undefined,
    });
    await this.core.init();
  }

  /** Name binding when ctx.id.name is absent (older runtimes): the caller passes the name once. */
  async bind(name: string): Promise<void> {
    if (this.core) return;
    this.ready ??= this.ctx.blockConcurrencyWhile(() => this.build(name));
    await this.ready;
  }

  private async c(): Promise<RuntimeCore> {
    if (this.ready) await this.ready;
    if (!this.core) throw new Error("Runtime DO not bound; call bind(name)");
    return this.core;
  }

  // ---- RuntimeRpc (Control DO, Worker) ----
  /** M7 F1: OC_SECRET_* values from a newer Worker isolate's env; set values only (an older isolate clears nothing). */
  private freshEnv: Record<string, string> = {};
  /** The newest Worker version id seen (deploy hand-over); differs from this DO's own env → the DO is old. */
  private freshVersion: string | undefined;
  /** The Worker version this DO was built with; env is as old as the DO. */
  private readonly builtVersion = this.env.CF_VERSION?.id;
  /** True when a Worker deploy came after this DO was built: its code, env and container image map are old. */
  async buildStale(): Promise<boolean> {
    return this.isStale();
  }
  private isStale(): boolean {
    return !!this.freshVersion && !!this.builtVersion && this.freshVersion !== this.builtVersion;
  }
  async freshSecretEnv(m: Record<string, string>, version?: string): Promise<number> {
    if (version) this.freshVersion = version;
    let n = 0;
    for (const [k, v] of Object.entries(m ?? {}))
      if (typeof v === "string" && v && this.freshEnv[k] !== v) {
        this.freshEnv[k] = v;
        n++;
      }
    return n;
  }
  async requestWake(reason: WakeReason) {
    return (await this.c()).requestWake(reason);
  }
  async ensure() {
    return (await this.c()).ensure();
  }
  async status() {
    return (await this.c()).status();
  }
  async deliver(req: {
    path: string;
    body: string;
    headers: Record<string, string>;
    okIsDurable?: boolean;
    quiet?: boolean;
  }) {
    return (await this.c()).deliver(req);
  }
  async verifyGen(a: { gen: number; dbs: string[]; timeoutMs?: number }) {
    return (await this.c()).verifyGen(a);
  }
  async sleepNow(o: { force: boolean }) {
    return (await this.c()).sleepNow(o);
  }
  async ownerStart() {
    return (await this.c()).ownerStart();
  }
  async ownerStop() {
    return (await this.c()).ownerStop();
  }
  async retire() {
    return (await this.c()).retire();
  }
  async idleInfo() {
    return (await this.c()).idleInfo();
  }
  async fault(name: string, params: Record<string, unknown>) {
    if (this.env.OC_TEST !== "1") return { ok: false, error: "not found" };
    const core = await this.c();
    if (name === "exec") {
      // Test groups only (OC_TEST=1, owner token): run a probe in the container as root, e.g. the
      // ReplicaGate refusal probe (worker/local/replica-probe.mjs). Like the spike's /ops/<name>/exec.
      const cmd = Array.isArray(params.cmd) ? params.cmd.map(String) : [];
      if (!cmd.length) return { ok: false, error: "cmd required" };
      try {
        const r = await core.exec(cmd, Math.min(Number(params.timeoutMs) || 30_000, 120_000));
        core.ring("rt", "fault", { name, cmd: cmd[0], exitCode: r.exitCode });
        return { ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      } catch (e) {
        return { ok: false, error: errorText(e) };
      }
    }
    return core.fault(name, params);
  }
  async deployCheck(head: string | null) {
    return (await this.c()).deployCheck(head);
  }

  // ---- RuntimeGateRpc (ControlGate) ----
  async onHeartbeat(body: Record<string, unknown>) {
    return (await this.c()).onHeartbeat(body);
  }
  async onEvent(body: Record<string, unknown>) {
    return (await this.c()).onEvent(body);
  }
  async finalSnapshot(body: Record<string, unknown>) {
    return (await this.c()).finalSnapshot(body);
  }
  async currentBoot() {
    return (await this.c()).currentBoot();
  }
  async bootBound(a: { gen: number; iid: string }) {
    return (await this.c()).bootBound(a);
  }

  override async alarm(): Promise<void> {
    try {
      const core = await this.c();
      await core.alarm();
    } catch (e) {
      console.error(`runtime alarm: ${errorText(e)}`);
    }
  }

  private auth(): AuthRpc | null {
    const ns = (this.env as Env & { AUTH?: DurableObjectNamespace }).AUTH;
    return ns ? (ns.getByName(authName(this.env.OC_INST)) as unknown as AuthRpc) : null;
  }

  /** WS watch (M4): every wsCheckMs while a bridge is open: session check, 24 h cap, idle-close + latch. */
  private ensureWatch(core: RuntimeCore) {
    if (this.wsTimer) return;
    const latches = new Latches(core.store);
    const auth = this.auth();
    let busy = false;
    this.wsTimer = setInterval(() => {
      if (busy) return;
      if (this.bridges.count === 0) {
        if (this.wsTimer) clearInterval(this.wsTimer);
        this.wsTimer = null;
        return;
      }
      busy = true;
      void watchRound(this.bridges.list(), {
        now: () => Date.now(),
        timers: core.rt,
        check: auth ? (sid) => auth.check(sid) : undefined,
        latch: (sid) => latches.set(sid, Date.now()),
        log: (msg, data) => core.ring("ws", msg, data),
      })
        .catch((e) => core.ring("ws", "watch-error", errorText(e)))
        .finally(() => {
          busy = false;
        });
    }, core.rt.wsCheckMs);
  }

  /** Proxied paths (§19.1). The Worker has checked auth; the path is the gateway path. */
  override async fetch(req: Request): Promise<Response> {
    const name = req.headers.get("x-oc-rt");
    if (name && !this.core) await this.bind(name);
    const core = await this.c();
    const sid = req.headers.get(SID_HEADER);
    if (sid) {
      const latches = new Latches(core.store);
      // Add §2.5 latch: a latched session's WS upgrade gets 503 and wakes nothing; its next page load clears it.
      if (isWs(req) && latches.has(sid)) {
        core.ring("ws", "latched upgrade refused", null);
        return new Response("idle-closed; reload the page", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (isNav(req) && latches.clear(sid)) core.ring("ws", "latch cleared", null);
    }
    let gate: Awaited<ReturnType<RuntimeCore["proxyAllowed"]>>;
    try {
      gate = await core.proxyAllowed();
    } catch (e) {
      core.ring("ws", "gate-error", errorText(e));
      return wakingResponse(req);
    }
    if (gate === "retired") return new Response("epoch retired", { status: 421 });
    if (gate === "waking") return wakingResponse(req);
    const clean = new Request(req);
    clean.headers.delete("x-oc-rt");
    let res: Response;
    try {
      res = await proxyToGateway(
        clean,
        this.ctx.container?.getTcpPort(18789) as Fetcher,
        this.bridges,
        (msg, data) => core.ring("ws", msg, data),
        { sid, onIntent: () => core.noteUiIntent() },
      );
    } catch (e) {
      // The container stopped between the gate and the fetch (sleep, crash): same answer as a waking install.
      core.ring("ws", "proxy-error", errorText(e));
      return wakingResponse(req);
    }
    if (res.status === 101) this.ensureWatch(core);
    return res;
  }
}
