// Scenario world: the real Worker module (worker/src/index.ts) with fake platform pieces.
// - DO namespaces CONTROL/RUNTIME with per-name instances, restart and "down" switches
// - FakeStorage per DO (survives restarts), FakeContainer + FakeOcsup per Runtime DO name
// - FakeR2 as BUCKET, vitest fake timers as the clock, alarms fired by advance()
// Scenarios read state only through names the spec fixes (§3 tables, §4 kv keys, §19 routes).
import { vi } from "vitest";
import { FakeContainer } from "../fake-container";
import { fakeAuthNs, ownerCookie } from "../ingress/fake-auth";
import { FakeOcsup } from "./ocsup";
import { FakeR2 } from "./r2";
import { FakeStorage } from "./storage";

export const T0 = Date.parse("2026-11-02T10:00:00Z");
export const INST = "t1";
export const TOKENS = { owner: "owner-token-0123456789", ci: "ci-token-0123456789", webhook: "wh-secret-1" };
export const IMAGES = { oc: "registry.cloudflare.com/acct/oc-host@sha256:aaaa" } as const;

// ---- SUT discovery ----
type Ctor = new (ctx: unknown, env: unknown) => Record<string, unknown>;
export interface Sut {
  ok: boolean;
  why: string;
  mod: Record<string, unknown>;
  Control?: Ctor;
  Runtime?: Ctor;
  ControlGate?: Ctor;
  ReplicaGate?: Ctor;
  worker?: ExportedHandler<Record<string, unknown>>;
  /** index.ts serves the §19 routes (not the placeholder). */
  routes?: boolean;
}
let sutP: Promise<Sut> | null = null;
/** Where each class lives before index.ts re-exports it (spec §22 module map). */
const FALLBACK: Record<string, () => Promise<Record<string, unknown>>> = {
  Control: () => import("../../src/ctl/do"),
  Runtime: () => import("../../src/rt/runtime"),
  ControlGate: () => import("../../src/gates/entry"),
  ReplicaGate: () => import("../../src/gates/entry"),
  TelegramFake: () => import("../../src/gates/entry"),
  LlmMock: () => import("../../src/gates/entry"),
};
/**
 * Loads worker/src/index.ts. A class index.ts does not export yet is taken from its module
 * (FALLBACK). ok=false (with why) until all four classes load. `routes` is true once index.ts
 * has fetch + scheduled beyond the placeholder; before that cron() calls ctl.ensure() directly.
 */
export function loadSut(): Promise<Sut> {
  sutP ??= loadSutOnce();
  return sutP;
}

/** A fresh module graph (a new isolate): module-level caches such as the gate gen cache start empty. */
export async function freshSut(): Promise<Sut> {
  vi.resetModules();
  return loadSutOnce();
}

function loadSutOnce(): Promise<Sut> {
  return (async () => {
    let mod: Record<string, unknown> = {};
    const why: string[] = [];
    try {
      mod = (await import("../../src/index")) as Record<string, unknown>;
    } catch (e) {
      why.push(`index.ts: ${String(e).slice(0, 160)}`);
    }
    const cls: Record<string, Ctor | undefined> = {};
    for (const k of ["Control", "Runtime", "ControlGate", "ReplicaGate", "TelegramFake", "LlmMock"]) {
      if (typeof mod[k] === "function") {
        cls[k] = mod[k] as Ctor;
        continue;
      }
      try {
        const m = await (FALLBACK[k] as () => Promise<Record<string, unknown>>)();
        if (typeof m[k] === "function") cls[k] = m[k] as Ctor;
        else if (k !== "TelegramFake" && k !== "LlmMock") why.push(`${k} missing`);
      } catch (e) {
        if (k !== "TelegramFake" && k !== "LlmMock") why.push(`${k}: ${String(e).slice(0, 160)}`);
      }
    }
    const worker = mod.default as ExportedHandler<Record<string, unknown>> | undefined;
    return {
      ok: !!(cls.Control && cls.Runtime && cls.ControlGate && cls.ReplicaGate),
      why:
        cls.Control && cls.Runtime && cls.ControlGate && cls.ReplicaGate
          ? ""
          : `(skipped: ${why.join("; ")})`,
      mod: { ...mod, ...cls },
      Control: cls.Control,
      Runtime: cls.Runtime,
      ControlGate: cls.ControlGate,
      ReplicaGate: cls.ReplicaGate,
      worker,
      routes: typeof worker?.scheduled === "function",
    };
  })();
}
/** True when a named export exists (for scenarios that need one module more than the core). */
export async function has(...names: string[]): Promise<boolean> {
  const s = await loadSut();
  return s.ok && names.every((n) => n in s.mod);
}

// ---- DO plumbing ----
interface Slot {
  cls: "Control" | "Runtime";
  name: string;
  storage: FakeStorage;
  container?: FakeContainer;
  ocsup?: FakeOcsup;
  inst?: Record<string, unknown>;
  alarmRun?: Promise<unknown>;
  constructs: number;
  /** The container's image map when the instance was built (see World.staleImages). */
  builtImages?: Record<string, string>;
  /** Bumped on restart; an old instance's storage and container views throw after that. */
  life: number;
}

const RESET = "Durable Object reset (fake): this instance was restarted";

/** View of obj that throws once slot.life moves past `life` (the old instance is gone). */
function revocable<T extends object>(obj: T, s: Slot, life: number): T {
  return new Proxy(obj, {
    get(t, p, r) {
      if (s.life !== life) {
        if (p === "then") return undefined;
        throw new Error(RESET);
      }
      const v = Reflect.get(t, p, t);
      if (typeof v === "function")
        return (...a: unknown[]) => {
          if (s.life !== life) throw new Error(RESET);
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      if (p === "sql" && v && typeof v === "object") return revocable(v as object, s, life);
      void r;
      return v;
    },
  });
}

export interface WorldOpts {
  /** Overrides on top of the test preset (core/timers.ts TEST_TIMERS). */
  timers?: Record<string, number>;
  /** Sleep gate on (settings.sleep.mode auto). Default off so non-sleep scenarios stay awake. */
  sleep?: boolean;
  settings?: Record<string, unknown>;
  images?: Record<string, string>;
  ci?: boolean;
  vars?: Record<string, string>;
  /**
   * Workaround for issue I-1 (scenario-issues.md): a `fresh` gen has no boot-set DB rows, so the
   * ledger never marks it complete (gates/ledger.ts `c.total > 0`) and every restart after a crash
   * plans restore-blocked:mismatch. On (default), the world marks such a gen complete after its
   * first uploaded DB, so later scenarios test their own rows. The test "I-1" runs with it off.
   */
  freshCompleteWorkaround?: boolean;
}

export class World {
  slots = new Map<string, Slot>();
  r2: FakeR2;
  env: Record<string, unknown>;
  /** Classes whose stubs throw on every call (DO down). */
  down = new Set<"Control" | "Runtime">();
  /** Drop rt.requestWake calls (spec §19.2 fault "drop requestWake"). */
  dropRequestWake = 0;
  requestWakeCalls: { at: number; reason: string; dropped: boolean }[] = [];
  /** Errors thrown by alarm() handlers (spec §11.1: the handler never throws). */
  alarmErrors: { name: string; err: string }[] = [];
  waits: Promise<unknown>[] = [];
  images: Record<string, string>;
  private freshFix: boolean;
  private ownerCookie?: string;

  constructor(
    public sut: Sut,
    o: WorldOpts = {},
  ) {
    vi.useFakeTimers({
      now: T0,
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
    this.images = { ...IMAGES, ...(o.images ?? {}) };
    this.freshFix = o.freshCompleteWorkaround ?? false; // I-1 fixed in the SUT; kept for bisecting
    this.r2 = new FakeR2(() => Date.now());
    this.env = {
      OC_INST: INST,
      OC_INSTANCE: JSON.stringify({ vcpu: 2, memoryMib: 6144, diskMb: 20000 }),
      OC_SETTINGS: JSON.stringify({
        ...(o.settings ?? {}),
        sleep: { mode: o.sleep ? "auto" : "off", ...((o.settings?.sleep as object) ?? {}) },
      }),
      OC_TEST: "1",
      OC_TIMERS: JSON.stringify({ preset: "test", ...(o.timers ?? {}) }),
      CONTROL_TOKEN: TOKENS.owner,
      ...(o.ci === false ? {} : { CI_TOKEN: TOKENS.ci }),
      TELEGRAM_WEBHOOK_SECRET: TOKENS.webhook,
      CF_VERSION: { id: "v-test", tag: "", timestamp: "" },
      BUCKET: this.r2,
      CONTROL: this.ns("Control"),
      RUNTIME: this.ns("Runtime"),
      ...(o.vars ?? {}),
    };
    // M3 ingress: Auth DO (sessions). A proxied fetch with token "owner" logs in once and sends the cookie.
    this.env.AUTH = fakeAuthNs(() => this.env).ns;
  }

  dispose() {
    for (const s of this.slots.values()) s.container?.releaseAll();
    vi.useRealTimers();
  }

  now() {
    return Date.now();
  }

  private slot(cls: "Control" | "Runtime", name: string): Slot {
    const key = `${cls}:${name}`;
    let s = this.slots.get(key);
    if (!s) {
      s = { cls, name, storage: new FakeStorage(), constructs: 0, life: 0 };
      if (cls === "Runtime") {
        s.container = new FakeContainer(() => Date.now(), this.images);
        s.ocsup = new FakeOcsup(s.container, () => Date.now());
      }
      this.slots.set(key, s);
    }
    return s;
  }

  private ctxFor(s: Slot) {
    return {
      id: { name: s.name, toString: () => `${s.cls}:${s.name}`, equals: () => false },
      storage: revocable(s.storage, s, s.life),
      container: s.container ? this.staleView(revocable(s.container, s, s.life), s) : undefined,
      exports: this.exportsFor(),
      props: {},
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
      waitUntil: (p: Promise<unknown>) => {
        this.waits.push(p.catch(() => {}));
      },
      abort: (reason?: string) => {
        this.restart(s.cls, s.name, `abort:${reason ?? ""}`);
      },
      acceptWebSocket: () => {},
      getWebSockets: () => [],
      setWebSocketAutoResponse: () => {},
    };
  }

  /**
   * On the platform ctx.container.images is as old as the DO instance: a deploy shows only after the DO is evicted
   * or reset. With `staleImages` the view returns the map from when the instance was built (M7 sandbox F3).
   */
  staleImages = false;
  private staleView<T extends object>(c: T, s: Slot): T {
    return new Proxy(c, {
      get: (t, p) =>
        p === "images" && this.staleImages && s.builtImages
          ? s.builtImages
          : (t as Record<string | symbol, unknown>)[p],
    });
  }

  private exportsFor() {
    const sut = this.sut;
    const env = this.env;
    const fetcher = (Cls: Ctor | undefined, props: unknown): Fetcher =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!Cls) throw new Error("gate class missing");
          const g = new Cls(
            { props, waitUntil: (p: Promise<unknown>) => this.waits.push(p.catch(() => {})) },
            env,
          );
          const req = input instanceof Request ? input : new Request(String(input), init);
          return (g.fetch as (r: Request) => Promise<Response>).call(g, req);
        },
      }) as unknown as Fetcher;
    return {
      ControlGate: (o: { props: unknown }) => fetcher(sut.ControlGate, o?.props),
      ReplicaGate: (o: { props: unknown }) => fetcher(sut.ReplicaGate, o?.props),
      TelegramFake: (o: { props: unknown }) => fetcher(sut.mod.TelegramFake as Ctor | undefined, o?.props),
      LlmMock: (o: { props: unknown }) => fetcher(sut.mod.LlmMock as Ctor | undefined, o?.props),
      Control: this.env?.CONTROL,
      Runtime: this.env?.RUNTIME,
    };
  }

  /** Instance for a slot; constructs it (runs the constructor) when missing. */
  instance(cls: "Control" | "Runtime", name: string): Record<string, unknown> {
    const s = this.slot(cls, name);
    if (!s.inst) {
      const Cls = cls === "Control" ? this.sut.Control : this.sut.Runtime;
      if (!Cls) throw new Error(`${cls} class missing`);
      s.constructs++;
      if (s.container) s.builtImages = { ...s.container.imageMap };
      s.inst = new Cls(this.ctxFor(s), this.env);
    }
    return s.inst;
  }

  /** DO data loss (new DO with the same name): storage and instance replaced; container kept. */
  wipe(cls: "Control" | "Runtime", name: string) {
    const s = this.slot(cls, name);
    s.life++;
    s.inst = undefined;
    s.alarmRun = undefined;
    (s as { storage: FakeStorage }).storage = new FakeStorage();
  }

  /** DO restart: in-memory state and monitor() promises gone; storage and container stay. */
  restart(cls: "Control" | "Runtime", name: string, _why = "restart") {
    const s = this.slot(cls, name);
    s.life++;
    s.inst = undefined;
    s.alarmRun = undefined;
    s.container?.dropWaiters();
  }

  private ns(cls: "Control" | "Runtime"): DurableObjectNamespace {
    const world = this;
    const stub = (name: string) =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return undefined;
            if (prop === "name") return name;
            return async (...args: unknown[]) => {
              if (world.down.has(cls)) throw new Error(`Durable Object ${cls}:${name} is unavailable (fake)`);
              if (cls === "Runtime" && prop === "requestWake") {
                const dropped = world.dropRequestWake > 0;
                world.requestWakeCalls.push({ at: Date.now(), reason: String(args[0]), dropped });
                if (dropped) {
                  world.dropRequestWake--;
                  throw new Error("requestWake dropped (fault)");
                }
              }
              const inst = world.instance(cls, name);
              const fn = inst[prop as string];
              if (typeof fn !== "function") throw new Error(`${cls}.${String(prop)} is not an RPC method`);
              const a = prop === "fetch" ? args : args.map((x) => structuredClone(x));
              const r = await (fn as (...x: unknown[]) => unknown).apply(inst, a);
              return prop === "fetch" || r === undefined ? r : structuredClone(r);
            };
          },
        },
      );
    return {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (id: { name: string }) => stub(id.name),
      getByName: (name: string) => stub(name),
    } as unknown as DurableObjectNamespace;
  }

  /** Restart the DO right after the first storage write that makes pred() true (cut at a phase). */
  restartWhen(cls: "Control" | "Runtime", name: string, pred: (q: string, b: unknown[]) => boolean) {
    const s = this.slot(cls, name);
    let done = false;
    s.storage.onWrite = (q, b) => {
      if (done || !pred(q, b)) return;
      done = true;
      s.storage.onWrite = null;
      s.storage.whenCommitted(() => this.restart(cls, name, "restartWhen"));
    };
    return () => done;
  }

  // ---- time ----
  /** Advance fake time, firing due DO alarms (one in flight per DO, as on the platform). */
  async advance(ms: number, step = 50) {
    const end = Date.now() + ms;
    let guard = 0;
    while (Date.now() < end || this.dueAlarms().length) {
      if (++guard > 2_000_000) throw new Error("advance: runaway loop");
      this.applyWorkarounds();
      for (const s of this.dueAlarms()) this.fire(s);
      // A due alarm waits while the previous one still runs; it must not hold time still.
      const nextAlarm = Math.min(
        ...[...this.slots.values()].map((s) =>
          s.storage.alarmAt === null || (s.alarmRun && s.storage.alarmAt <= Date.now())
            ? Number.POSITIVE_INFINITY
            : s.storage.alarmAt,
        ),
      );
      const to = Math.min(end, Date.now() + step, Math.max(nextAlarm, Date.now()));
      if (to <= Date.now()) {
        await vi.advanceTimersByTimeAsync(0);
        if (Date.now() >= end) break;
        continue;
      }
      await vi.advanceTimersByTimeAsync(to - Date.now());
    }
    await this.settle();
  }
  private applyWorkarounds() {
    if (!this.freshFix) return;
    const st = this.slots.get(`Control:${this.ctlName()}`)?.storage;
    if (!st) return;
    try {
      st.sql.exec(
        `UPDATE gens SET state = 'complete', complete_at = ? WHERE state = 'booting' AND plan_kind = 'fresh'
           AND NOT EXISTS (SELECT 1 FROM gendb WHERE gendb.gen = gens.gen AND in_boot_set = 1)
           AND EXISTS (SELECT 1 FROM gendb WHERE gendb.gen = gens.gen AND state = 'uploaded')`,
        Date.now(),
      );
    } catch {}
  }
  private dueAlarms() {
    return [...this.slots.values()].filter(
      (s) => s.storage.alarmAt !== null && s.storage.alarmAt <= Date.now() && !s.alarmRun,
    );
  }
  private fire(s: Slot) {
    s.storage.alarmAt = null;
    const inst = this.instance(s.cls, s.name);
    const run = Promise.resolve()
      .then(() =>
        (inst.alarm as ((a?: unknown) => Promise<void>) | undefined)?.call(inst, {
          retryCount: 0,
          isRetry: false,
        }),
      )
      .catch((e) => this.alarmErrors.push({ name: `${s.cls}:${s.name}`, err: String(e) }))
      .finally(() => {
        if (s.alarmRun === run) s.alarmRun = undefined;
      });
    s.alarmRun = run;
  }
  /** Let microtasks and zero-delay timers run. */
  async settle() {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
  }
  /** Run until pred() is true or ms of fake time pass. Returns the time it took or throws. */
  async until(pred: () => boolean | Promise<boolean>, ms: number, step = 50): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 <= ms) {
      if (await pred()) return Date.now() - t0;
      await this.advance(step, step);
    }
    throw new Error(`until: condition not met in ${ms} ms`);
  }

  // ---- entry points ----
  async fetch(
    path: string,
    init: RequestInit & { token?: "owner" | "ci" | "none"; settle?: boolean } = {},
  ): Promise<Response> {
    if (!this.sut.routes) throw new Error("index.ts does not serve the §19 routes yet");
    const h = new Headers(init.headers);
    const tok = init.token ?? "owner";
    if (tok !== "none") h.set("authorization", `Bearer ${TOKENS[tok]}`);
    const proxied = !/^\/(ops|_ochost)(\/|$)|^\/telegram-webhook/.test(path);
    if (proxied && tok === "owner" && !h.has("cookie")) {
      this.ownerCookie ??= await ownerCookie(this.env);
      h.set("cookie", this.ownerCookie);
    }
    if (!h.has("cf-connecting-ip")) h.set("cf-connecting-ip", "203.0.113.9");
    const req = new Request(`https://oc.example.workers.dev${path}`, { ...init, headers: h });
    const w = this.sut.worker as ExportedHandler<Record<string, unknown>>;
    const ectx = {
      waitUntil: (p: Promise<unknown>) => this.waits.push(p.catch(() => {})),
      passThroughOnException() {},
      props: {},
    };
    const r = await (w.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
      req,
      this.env,
      ectx,
    );
    if (init.settle !== false) await this.settle();
    return r;
  }
  async ops(path: string, body?: unknown, token: "owner" | "ci" = "owner") {
    const r = await this.fetch(`/ops/${path}`, {
      method:
        body === undefined &&
        !/^(wake|start|stop|restart|sleep|epoch|deploy-check|ci|restore|fault)/.test(path)
          ? "GET"
          : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json" },
      token,
    });
    const t = await r.text();
    let j: unknown = t;
    try {
      j = JSON.parse(t);
    } catch {}
    return { status: r.status, body: j as Record<string, unknown> };
  }
  async webhook(update: Record<string, unknown>, secret = TOKENS.webhook, settle = true) {
    return this.fetch("/telegram-webhook", {
      method: "POST",
      token: "none",
      settle,
      headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" },
      body: JSON.stringify(update),
    });
  }
  async cron() {
    if (!this.sut.routes) {
      // index.ts placeholder: the cron handler is `ctl.ensure()` (spec §19.3).
      await this.stub("Control", this.ctlName()).ensure?.();
      await Promise.all(this.waits.splice(0));
      await this.settle();
      return;
    }
    const w = this.sut.worker as ExportedHandler<Record<string, unknown>>;
    const ectx = {
      waitUntil: (p: Promise<unknown>) => this.waits.push(p.catch(() => {})),
      passThroughOnException() {},
      props: {},
    };
    await (w.scheduled as (c: unknown, e: unknown, x: unknown) => Promise<void>)(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} },
      this.env,
      ectx,
    );
    await Promise.all(this.waits.splice(0));
    await this.settle();
  }

  // ---- DO handles ----
  ctlName() {
    return `ctl:${INST}`;
  }
  rtName(epoch = this.epoch()) {
    return `rt:${INST}:e${epoch}`;
  }
  ctl() {
    return this.handle("Control", this.ctlName());
  }
  rt(epoch = this.epoch()) {
    return this.handle("Runtime", this.rtName(epoch));
  }
  /** Active epoch from Control meta.pointer (spec §3.2); 1 before install. */
  epoch(): number {
    const s = this.slots.get(`Control:${this.ctlName()}`);
    const p = s?.storage.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'pointer'")[0];
    return p ? Number(JSON.parse(p.v)) : 1;
  }
  stub(cls: "Control" | "Runtime", name: string) {
    return (this.env[cls === "Control" ? "CONTROL" : "RUNTIME"] as DurableObjectNamespace).getByName(
      name,
    ) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  }

  handle(cls: "Control" | "Runtime", name: string) {
    const s = this.slot(cls, name);
    return {
      name,
      slot: s,
      storage: s.storage,
      c: s.container as FakeContainer,
      ocsup: s.ocsup as FakeOcsup,
      call: (m: string, ...a: unknown[]) => this.stub(cls, name)[m]?.(...a) as Promise<unknown>,
      restart: () => this.restart(cls, name),
      construct: () => this.instance(cls, name),
      constructs: () => s.constructs,
      rows: <T extends Record<string, unknown> = Record<string, unknown>>(q: string, ...b: unknown[]) =>
        s.storage.rows<T>(q, ...b),
      /** kv value (Runtime §4); parses JSON text values. */
      kv: <T = Record<string, unknown>>(k: string): T | undefined => {
        const r = s.storage.rows<{ v: string }>("SELECT v FROM kv WHERE k = ?", k)[0];
        if (r) return JSON.parse(r.v) as T;
        return s.storage.kvMap.get(k) as T | undefined;
      },
      meta: <T = unknown>(k: string): T | undefined => {
        const r = s.storage.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0];
        if (!r) return undefined;
        try {
          return JSON.parse(r.v) as T;
        } catch {
          return r.v as T;
        }
      },
      alarmAt: () => s.storage.alarmAt,
    };
  }

  /** Runtime rec.state (spec §4 `rec`). */
  state(epoch?: number): string | undefined {
    return this.rt(epoch).kv<{ state: string }>("rec")?.state;
  }
  ladder(epoch?: number) {
    return this.rt(epoch).kv<{
      level: number | "slow";
      nextStartAt: number;
      lastClass: string;
      stateFaults: number;
    }>("ladder");
  }
  stops(epoch?: number) {
    return this.rt(epoch).rows<{
      cls: string;
      confirmed: number;
      esc: string;
      state_fault: number;
      at: number;
      gen: number;
    }>("SELECT * FROM stops ORDER BY id");
  }
  gens() {
    return this.ctl().rows<{
      gen: number;
      op_id: string;
      state: string;
      secret: string;
      epoch: number;
      plan: string;
      plan_kind: string;
      iid: string | null;
      reason: string;
    }>("SELECT * FROM gens ORDER BY gen");
  }
  alerts() {
    return this.ctl().rows<{ class: string; severity: string; count: number }>("SELECT * FROM alerts");
  }
  alert(cls: string) {
    return this.alerts().find((a) => a.class === cls);
  }
  ring(kind?: string) {
    const r = this.ctl().rows<{ kind: string; detail: string; src: string }>(
      "SELECT * FROM ring ORDER BY id",
    );
    return kind ? r.filter((x) => x.kind === kind) : r;
  }
  epochs() {
    return this.ctl().rows<{ n: number; status: string; image_key: string; digest: string; reason: string }>(
      "SELECT * FROM epochs ORDER BY n",
    );
  }
  inbox() {
    return this.ctl().rows<{
      id: string;
      platform_key: string;
      state: string;
      attempts: number;
      dead_reason: string | null;
    }>("SELECT * FROM inbox ORDER BY CAST(platform_key AS INTEGER)");
  }
  markers() {
    return this.ctl().rows<{
      id: string;
      state: string;
      gen: number;
      snapshot_id: string | null;
      void_reason: string | null;
      consumed_by_gen: number | null;
    }>("SELECT * FROM markers ORDER BY created_at");
  }
  snapshots() {
    return this.ctl().rows<{ id: string; state: string; kind: string; misses: number; created_at: number }>(
      "SELECT * FROM snapshots ORDER BY created_at",
    );
  }
  ops_(epoch?: number) {
    return this.rt(epoch).rows<{ op_id: string; kind: string; phase: string; state: string; reason: string }>(
      "SELECT * FROM ops ORDER BY created_at",
    );
  }
}

/** Build a world and bring the instance to `running` on epoch 1 (install + first start). */
export async function runningWorld(sut: Sut, o: WorldOpts = {}): Promise<World> {
  const w = new World(sut, o);
  await w.cron(); // ctl.ensure(): install (guess, issue I-1) and first start
  await w.until(() => w.state() === "running", 30_000);
  return w;
}
