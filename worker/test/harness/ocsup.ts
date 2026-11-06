// Fake ocsup: the in-container side of every scenario. It talks to the real ControlGate through the
// intercept the Runtime DO registered (15.0.0.1:80), validates its own requests with contract.mjs,
// answers `ocsupctl` execs and the gateway port 18789 from a script.
import * as C from "../../../image/ocrt/lib/contract.mjs";
import { signV4 } from "../../../image/ocrt/lib/s3.mjs";
import { ltxFile } from "../../src/gates/ltx";
import type { FakeContainer } from "../fake-container";

export type CtlAnswer = Record<string, unknown> | "hang";
export type CtlScript = (op: string, opId: string | undefined, args: string[]) => CtlAnswer | undefined;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
const rnd = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer);

export interface BootRec {
  gen: number;
  epoch: number;
  iid: string;
  secret: string;
  plan?: Record<string, unknown>;
  status?: string;
  startedAt: number;
}

export interface ReplayRec {
  at: number;
  updateId: number | null;
  gen: number;
  status: number;
}

export class FakeOcsup {
  /** Boot delay before /v1/hello (ms of fake time). */
  bootDelayMs = 50;
  /** Time from /v1/boot ok to /startupz `started`. */
  readyAfterMs = 200;
  /** M3: per-boot hook on the received plan; `{exit}` ends the boot like ocsup's own refusal (B1). */
  onBoot: ((plan: Record<string, any>) => { exit: [number, string] } | undefined) | null = null;
  /** M3: hold this phase forever after the plan (a restore stall, F1); heartbeats keep coming. */
  stallPhase: string | null = null;
  /** Send ingress-ready this long after started; null = never. */
  ingressReadyAfterMs: number | null = 100;
  hbMs = 1000;
  hbDrop = false;
  healthzFail = false;
  draining = false;
  phase: string = "boot";
  started = false;
  lastActivityAt: number | null = null;
  cpuS = 1;
  rpo: "ok" | "seeding" | "down" = "ok";
  nextWakeAtMs: number | null = null;
  boot: BootRec | null = null;
  boots: BootRec[] = [];
  /** ocsupctl calls: [op, opId]. */
  ctl: { at: number; op: string; opId?: string }[] = [];
  /** Per-op overrides; return undefined to fall through to defaults. */
  script: CtlScript = () => undefined;
  /** Identity answer override for `cat /run/ocrt/boot.json`; "fail" = exec exit 1. */
  identity: "real" | "fail" | Record<string, unknown> = "real";
  /** Webhook replay answers in order; default 200 durable. */
  replayAnswers: (Response | (() => Response | Promise<Response>))[] = [];
  replays: ReplayRec[] = [];
  errors: string[] = [];
  /** Wake allowlist ocsup exports at each sleep flush (§12.2); null = no export. */
  wakeAllow: { userIds: string[]; groupChatIds: string[]; configVer?: number } | null = {
    userIds: ["5"],
    groupChatIds: [],
  };
  /** Ask for a final snapshot on SIGTERM (ocsup drain, §15.1). */
  finalOnSigterm = true;
  finals: { status: number; body: unknown }[] = [];
  /** Fake Litestream: upload a seed L0 per plan DB through ReplicaGate after boot. */
  litestream = true;
  /** ReplicaGate answers: [status, key]. */
  replicaLog: { at: number; op: string; key: string; status: number }[] = [];
  private txid = new Map<string, number>();
  gateLog: { at: number; path: string; status: number; body?: unknown }[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private seq = 0;
  private sleepAnswers = new Map<string, unknown>();

  constructor(
    public c: FakeContainer,
    private now: () => number = () => Date.now(),
  ) {
    c.onStart = (o) => this.onStart(o);
    c.onStop = () => this.onStop();
    c.execHandler = (cmd) => this.onExec(cmd);
    c.portHandler = (port, req) => this.onPort(port, req);
  }

  private later(ms: number, fn: () => unknown) {
    const t = setTimeout(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => this.errors.push(String(e)));
    }, ms);
    this.timers.push(t);
  }
  private onStop() {
    for (const t of this.timers.splice(0)) clearTimeout(t);
    this.started = false;
    this.draining = false;
    this.phase = "exit";
    this.sleepAnswers.clear();
  }

  private onStart(o: ContainerStartupOptions) {
    const env = o.env ?? {};
    this.started = false;
    this.draining = false;
    this.phase = "boot";
    this.seq = 0;
    this.boot = {
      gen: Number(env.OCRT_GEN),
      epoch: Number(env.OCRT_EPOCH),
      iid: rnd(16),
      secret: env.OCRT_BOOT_SECRET ?? "",
      startedAt: this.now(),
    };
    this.boots.push(this.boot);
    this.later(this.bootDelayMs, () => this.runBoot(env));
  }

  env(): Record<string, unknown> {
    const b = this.boot as BootRec;
    return { inst: this.c.startOpts?.env?.OCRT_INST, epoch: b.epoch, gen: b.gen, bootId: b.iid.slice(0, 16) };
  }

  /** POST/GET to ControlGate as ocsup does. Returns status and parsed body. */
  async gate(method: string, path: string, body?: unknown, withIid = true) {
    const g = this.c.gate("15.0.0.1:80");
    if (!g) throw new Error("no ControlGate intercept at 15.0.0.1:80");
    const b = this.boot as BootRec;
    const h: Record<string, string> = { "content-type": "application/json" };
    if (path !== "/v1/hello") h[C.HDR.secret] = b.secret;
    if (withIid && path !== "/v1/hello" && path !== "/v1/boot") h[C.HDR.iid] = b.iid;
    const r = await g.fetch(`${C.GATE.control}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const txt = await r.text();
    let j: unknown = txt;
    try {
      j = JSON.parse(txt);
    } catch {}
    this.gateLog.push({ at: this.now(), path, status: r.status, body: j });
    return { status: r.status, body: j as Record<string, unknown> };
  }

  private async runBoot(env: Record<string, string>) {
    const b = this.boot as BootRec;
    const challenge = rnd(16);
    const h = await this.gate("POST", "/v1/hello", { challenge, pv: C.PV });
    const want = await hmacHex(b.secret, `${C.DOMAIN.hello}${challenge}`);
    if (h.status !== 200 || h.body.proof !== want) {
      this.errors.push(`hello ${h.status} proof ${h.body.proof === want ? "ok" : "bad"}`);
      return this.exit(75, "restore-blocked:infra");
    }
    const req = { ...this.env(), iid: b.iid, pv: C.PV, hostname: "oc", newBoot: true, ocsup: "fake" };
    C.assertValid(C.BootReq, req, "BootReq");
    const r = await this.gate("POST", "/v1/boot", req);
    if (r.status === 409)
      return this.exit(
        r.body.error === "pv" ? 75 : 77,
        r.body.error === "pv" ? "restore-blocked:infra" : "stale",
      );
    if (r.status !== 200) {
      this.errors.push(`boot ${r.status}`);
      return this.exit(75, "restore-blocked:infra");
    }
    b.status = String(r.body.status);
    if (r.body.status === "reboot-detected") return this.exit(75, "auto-restart");
    const plan = r.body.plan as Record<string, unknown>;
    b.plan = plan;
    const errs = C.validate(C.BootPlan, plan);
    if (errs.length) this.errors.push(`plan invalid: ${JSON.stringify(errs).slice(0, 300)}`);
    const sq = plan.sqlite as { kind: string; reason?: string };
    if (sq.kind === "restore-blocked") return this.exit(75, sq.reason ?? "restore-blocked:infra");
    const hook = this.onBoot?.(plan as Record<string, any>);
    if (hook) return this.exit(hook.exit[0], hook.exit[1]);
    const t = plan.timers as { hbMs?: number } | undefined;
    if (t?.hbMs) this.hbMs = t.hbMs;
    void env;
    this.phase = "restore";
    if (!this.hbDrop) await this.heartbeat();
    if (this.litestream) {
      const dbs = ((plan.dbs as { db: string }[] | undefined) ?? []).map((d) => d.db);
      for (const db of dbs.length ? dbs : ["state/openclaw.sqlite"]) {
        this.txid.set(db, 0);
        await this.uploadL0(db, 4096);
      }
    }
    this.heartbeatLoop();
    if (this.stallPhase) {
      this.phase = this.stallPhase;
      return;
    }
    this.later(this.readyAfterMs, async () => {
      this.phase = "running";
      this.started = true;
      this.lastActivityAt = this.now();
      await this.event("startupz", {});
      if (this.ingressReadyAfterMs !== null)
        this.later(this.ingressReadyAfterMs, () => this.event("ingress-ready", {}));
    });
  }

  private heartbeatLoop() {
    this.later(this.hbMs, async () => {
      if (!this.c.running) return;
      if (!this.hbDrop) await this.heartbeat();
      this.heartbeatLoop();
    });
  }

  async heartbeat(extra: Record<string, unknown> = {}) {
    const body = {
      ...this.env(),
      seq: this.seq++,
      phase: this.draining ? "draining" : this.phase,
      draining: this.draining,
      fenced: false,
      uptimeS: Math.floor((this.now() - (this.boot?.startedAt ?? this.now())) / 1000),
      cpuS: this.cpuS,
      lastActivityAt: this.lastActivityAt,
      rpo: this.rpo,
      ...extra,
    };
    // §23 optional heartbeat fields are not in contract.mjs yet; validate the rest.
    const {
      lastActivityAt: _a,
      telegramSecretVersion: _t,
      channels: _c,
      eventJobs: _e,
      ...base
    } = body as Record<string, unknown>;
    C.assertValid(
      C.HeartbeatReq,
      { ...base, lastActivityAt: (body as { lastActivityAt?: unknown }).lastActivityAt ?? null },
      "HeartbeatReq",
    );
    const r = await this.gate("POST", "/v1/heartbeat", body);
    if (r.status === 409) return this.exit(77, "stale");
    return r;
  }

  async event(kind: string, x: Record<string, unknown>) {
    const body = { ...this.env(), kind, ts: this.now(), ...x };
    C.assertValid(C.EventReq, body, "EventReq");
    return this.gate("POST", "/v1/event", body);
  }

  // ---- Fake Litestream (S3 through ReplicaGate, SigV4 with the per-boot key, gate §1) ----
  async replicaKey(): Promise<{ id: string; secret: string }> {
    const b = this.boot as BootRec;
    return {
      id: C.replicaAccessKeyId(b.gen, b.iid),
      secret: await hmacHex(b.secret, C.replicaKeyMessage(b.gen, b.iid)),
    };
  }

  /** One signed S3 request to 15.0.0.2:80, path style, host 127.0.0.1:18790 as the proxy forwards it. */
  async s3(
    method: string,
    key: string,
    o: { body?: string | Uint8Array; query?: string; keyId?: string; secret?: string; date?: Date } = {},
  ) {
    const g = this.c.gate("15.0.0.2:80");
    if (!g) throw new Error("no ReplicaGate intercept at 15.0.0.2:80");
    const bucket = String(
      (this.boot?.plan?.replica as { bucket?: string } | undefined)?.bucket ?? "oc-host-t1",
    );
    const url = `http://127.0.0.1:18790/${bucket}/${key}${o.query ? `?${o.query}` : ""}`;
    const k = await this.replicaKey();
    const h = signV4({
      method,
      url,
      region: "auto",
      accessKey: o.keyId ?? k.id,
      secretKey: o.secret ?? k.secret,
      // signV4 hashes the body with node:crypto, which takes bytes too (its JSDoc type says string)
      body: (o.body ?? "") as string,
      now: o.date ?? new Date(this.now()),
    }) as unknown as Record<string, string>;
    const r = await g.fetch(`http://15.0.0.2${new URL(url).pathname}${o.query ? `?${o.query}` : ""}`, {
      method,
      headers: { ...h, host: "127.0.0.1:18790" },
      body: method === "GET" || method === "HEAD" ? undefined : (o.body ?? ""),
    });
    this.replicaLog.push({ at: this.now(), op: method, key, status: r.status });
    return r;
  }

  ltxKey(db: string, level: number, minTxid: number, maxTxid: number, gen = this.boot?.gen ?? 0) {
    const inst = this.c.startOpts?.env?.OCRT_INST ?? "t1";
    return `${C.genPrefix(inst, gen)}${db}/${level.toString(16).padStart(4, "0")}/${C.ltxName(minTxid, maxTxid)}`;
  }

  /** Upload the next L0 for db (first one has minTxid 1 = the seed). */
  async uploadL0(db = "state/openclaw.sqlite", bytes = 512) {
    const min = (this.txid.get(db) ?? 0) + 1;
    const max = min + 9;
    this.txid.set(db, max);
    // A real LTX header (sec F1/F3): the gate records only uploads whose header TXIDs match the key name.
    const r = await this.s3("PUT", this.ltxKey(db, 0, min, max), {
      body: ltxFile(min, max, Math.max(0, bytes - 116)),
    });
    if (r.status === 409) await this.exit(77, "stale");
    return r;
  }

  // ---- Scenario controls ----
  /** Platform SIGTERM seen by ocsup: event + draining heartbeats. */
  async sigterm() {
    this.draining = true;
    await this.event("sigterm", {});
    if (this.finalOnSigterm) await this.finalSnapshot();
  }
  async finalSnapshot(unclean: string[] | null = null) {
    const r = await this.gate("POST", "/v1/final-snapshot", { ...this.env(), kind: "final", unclean });
    this.finals.push(r);
    return r;
  }
  async drained(unclean: string[] | null = null) {
    await this.event("drained", { unclean });
  }
  /** ocsup exit: `exit` event, then the process exit the platform reports. */
  async exit(code: number, reason: string) {
    if (this.boot && this.c.running) {
      try {
        await this.event("exit", { code, reason });
      } catch {}
    }
    this.c.crash(code);
  }

  // ---- exec (ocsupctl, identity, readiness) ----
  private async onExec(cmd: string[]) {
    const bin = cmd[0] ?? "";
    if (bin === "true" || bin.endsWith("/true")) return { exitCode: 0 };
    if (cmd.some((x) => x.includes("boot.json"))) {
      if (this.identity === "fail") return { exitCode: 1, stderr: "no such file" };
      const b = this.boot as BootRec;
      const id =
        this.identity === "real"
          ? { gen: b.gen, epoch: b.epoch, iid: b.iid, secretHash: await sha256(b.secret) }
          : this.identity;
      return { exitCode: 0, stdout: JSON.stringify(id) };
    }
    const i = cmd.findIndex((x) => /(^|\/)ocsupctl(\.mjs)?$/.test(x));
    if (i < 0) return { exitCode: 127, stderr: `fake ocsup: unknown command ${cmd.join(" ")}` };
    const op = cmd[i + 1] ?? "";
    const j = cmd.indexOf("--op-id");
    const opId = j >= 0 ? cmd[j + 1] : undefined;
    this.ctl.push({ at: this.now(), op, opId });
    const a = this.script(op, opId, cmd.slice(i + 2)) ?? this.defaultCtl(op, opId);
    if (op === "sleep-flush" && a !== "hang" && a.ok !== false && this.wakeAllow) {
      const r = await this.gate("PUT", "/v1/wake-allow", { ...this.env(), ...this.wakeAllow });
      if (r.status !== 200) this.errors.push(`wake-allow ${r.status}`);
    }
    if (a === "hang") return "hang" as const;
    const errs = C.validate(C.CtlRes, a);
    if (errs.length) this.errors.push(`ctl ${op} answer invalid`);
    // image/ocrt/ocsupctl.mjs: exit 0 ok, 75 draining, 1 other errors; one JSON line on stdout.
    return {
      exitCode: a.ok === false ? (a.error === "draining" ? 75 : 1) : 0,
      stdout: `${JSON.stringify(a)}\n`,
    };
  }

  defaultCtl(op: string, opId?: string): Record<string, unknown> {
    if (this.draining && C.CTL_OPS[op as keyof typeof C.CTL_OPS]?.mutating)
      return { ok: false, error: "draining" };
    const key = `${opId}:${op}`;
    if (opId && this.sleepAnswers.has(key)) return this.sleepAnswers.get(key) as Record<string, unknown>;
    let a: Record<string, unknown>;
    switch (op) {
      case "sleep-check":
        a = { ok: true, blockers: [], nextWakeAtMs: this.nextWakeAtMs, eventJobs: [], channels: [] };
        break;
      case "sleep-prepare":
        a = { ok: true, status: "ready", retryAfterMs: null };
        break;
      case "sleep-cancel":
        a = { ok: true };
        break;
      case "sleep-stop-gateway":
        this.started = false;
        a = {
          ok: true,
          clean: true,
          code: 0,
          signal: null,
          ms: 900,
          openRows: 0,
          eventJobs: [],
          nextWakeAtMs: this.nextWakeAtMs,
        };
        break;
      case "sleep-flush":
        a = {
          ok: true,
          nextWakeAtMs: this.nextWakeAtMs,
          txidPerDb: { "state/openclaw.sqlite": 42 },
          bytesPerDb: { "state/openclaw.sqlite": 4_000_000 },
          lastWriteAtPerDb: { "state/openclaw.sqlite": this.now() - 1000 },
          archive: null,
        };
        break;
      case "resume-after-sleep":
        this.started = true;
        a = { ok: true, startupzMs: 300 };
        break;
      case "stop":
        a = { ok: true, state: "quiescing" };
        break;
      case "stop-status":
        a = { ok: true, state: "quiesced", unclean: [] };
        break;
      case "restart-gateway":
        a = { ok: true };
        break;
      case "status":
        a = { ok: true, phase: this.phase };
        break;
      default:
        a = { ok: false, error: "unknown-op" };
    }
    if (opId) this.sleepAnswers.set(key, a);
    return a;
  }

  // ---- gateway port 18789 ----
  private async onPort(port: number, req: Request): Promise<Response> {
    if (port !== 18789) return new Response("closed", { status: 502 });
    const u = new URL(req.url);
    if (u.pathname === "/startupz")
      return Response.json(
        { status: this.started ? "started" : "starting" },
        { status: this.started ? 200 : 503 },
      );
    if (u.pathname === "/healthz")
      return this.healthzFail ? new Response("bad", { status: 500 }) : Response.json({ ok: true });
    if (u.pathname === "/readyz") return Response.json({ ready: this.started });
    if (u.pathname === "/telegram-webhook") {
      let id: number | null = null;
      try {
        id = Number((JSON.parse(await req.text()) as { update_id?: number }).update_id ?? null);
      } catch {}
      const next = this.replayAnswers.shift();
      const r =
        typeof next === "function"
          ? await next()
          : (next ??
            new Response("", { status: 200, headers: { "x-openclaw-delivery-accepted": "durable" } }));
      this.replays.push({ at: this.now(), updateId: id, gen: this.boot?.gen ?? 0, status: r.status });
      this.lastActivityAt = this.now();
      return r;
    }
    this.lastActivityAt = this.now();
    return new Response(`gw ${u.pathname}`, { status: 200 });
  }
}
