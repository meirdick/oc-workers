// One ocsup container under test ("box"). Wraps docker run/exec/kill/commit and reads ocsup's JSON log.
// A box keeps its state in the container rootfs (no volume), so `snapshot()` (docker commit) is a fair
// stand-in for snapshotContainer: a wake runs the committed image with a new boot_id and gen.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dk, dkAsync, dkOk, exec, logs, rm, state } from "./docker.mjs";
import { BOOT_SECRET, ctl, GW_TOKEN, IP, NET, PFX, TLS_DIR } from "./env.mjs";

export const newBootId = () => {
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse ocsup JSON log lines from text. Non-JSON lines are skipped. */
export function parseEvents(text) {
  const out = [];
  for (const l of text.split("\n")) {
    const i = l.indexOf("{");
    if (i < 0) continue;
    try {
      const j = JSON.parse(l.slice(i));
      if (j && typeof j.ev === "string") out.push(j);
    } catch {}
  }
  return out;
}

export class Box {
  /**
   * o: {name, image, gen=1, epoch=1, inst="m1", cpus=2, memory="6g", privileged=true, hostname,
   *     bootId (default new), env:{}, args:[], plan (queued at the fake gate before start), restoreGens}
   */
  constructor(t, o) {
    this.t = t;
    this.o = { gen: 1, epoch: 1, inst: "m1", cpus: 2, memory: "6g", privileged: true, ...o };
    this.name = o.name;
    this.image = o.image;
    this.snaps = 0;
    t?.track?.(this);
  }

  envArgs() {
    const o = this.o;
    const e = {
      OCRT_INST: o.inst,
      OCRT_EPOCH: o.epoch,
      OCRT_GEN: o.gen,
      OCRT_BOOT_SECRET: BOOT_SECRET,
      OCRT_GATE_URL: `http://${IP.gate}`,
      OCRT_REPLICA_URL: `http://${IP.replica}`,
      // Prototype (M0) ocsup reads these; M1 ocsup uses the replica proxy and the plan.
      OCRT_S3_ENDPOINT: `http://${IP.replica}`,
      OCRT_S3_BUCKET: `oc-host-${o.inst}`,
      OCRT_S3_REGION: "auto",
      OCRT_S3_ACCESS_KEY_ID: "m0-static",
      OCRT_S3_SECRET_ACCESS_KEY: "m0-static-secret",
      OCRT_SET_PTRACE: "0",
      OCRT_TEST_FAKE_BOOT_ID: o.bootId,
      OC_GATEWAY_TOKEN: GW_TOKEN,
      ...(o.hostname ? { OCRT_HOSTNAME: o.hostname } : {}),
      ...o.env,
    };
    return Object.entries(e)
      .filter(([, v]) => v !== undefined && v !== null)
      .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  }

  /** Start the container. The fake gate gets the gen (and plan) first, as the DO would before start(). */
  async start(over = {}) {
    Object.assign(this.o, over);
    if (over.image) this.image = over.image;
    this.o.bootId = over.bootId || newBootId();
    await ctl("/_ctl/gen", {
      gen: this.o.gen,
      epoch: this.o.epoch,
      restoreGens: this.o.restoreGens || [],
      mode: this.o.mode || "prod",
    });
    if (this.o.plan) await ctl("/_ctl/plan", { plan: this.o.plan });
    rm(this.name);
    this.savedLog = undefined;
    const o = this.o;
    const a = ["run", "-d", "--name", this.name, "--label", "oc-host.m1=box", "--network", NET];
    if (o.privileged) a.push("--privileged", "--cgroupns=private");
    a.push(`--cpus=${o.cpus}`, `--memory=${o.memory}`, `--memory-swap=${o.memory}`);
    if (o.hostname) a.push("--hostname", o.hostname);
    for (const h of ["api.telegram.org", "api.anthropic.com", "api.openai.com"])
      a.push("--add-host", `${h}:${h.includes("telegram") ? IP.tg : IP.llm}`);
    a.push("-v", `${TLS_DIR}/ca.pem:/etc/cloudflare/certs/cloudflare-containers-ca.crt:ro`);
    a.push(...this.envArgs(), ...(o.args || []), this.image, ...(o.cmd || []));
    this.startedAt = Date.now();
    const r = dk(a);
    if (r.code !== 0) throw new Error(`box ${this.name}: docker run: ${r.err.slice(-400)}`);
    this.id = r.out.slice(0, 12);
    this.t?.note?.(`start ${this.name} gen=${o.gen} boot_id=${o.bootId} image=${this.image}`);
    return this;
  }

  text() {
    // After rm() the container is gone: keep the log taken just before it.
    return this.savedLog ?? logs(this.name);
  }
  events() {
    return parseEvents(this.text());
  }
  ev(name) {
    return this.events().filter((e) => e.ev === name);
  }
  state() {
    return state(this.name);
  }
  running() {
    return this.state().status === "running";
  }

  /** Wait for an event matching pred (string = ev name). Returns the event or null on timeout/exit. */
  async waitEv(pred, timeoutMs = 120_000, { stopOnExit = true } = {}) {
    const f = typeof pred === "string" ? (e) => e.ev === pred : pred;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.events().find(f);
      if (hit) return hit;
      if (stopOnExit && !this.running()) return this.events().find(f) || null;
      await sleep(250);
    }
    return null;
  }
  async waitExit(timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = this.state();
      if (s.status === "exited" || s.status === "dead" || s.status === "missing") return s;
      await sleep(250);
    }
    return null;
  }
  /** Wait for /startupz (ocsup event "startupz"). Returns ms since docker run, or null. */
  async startupz(timeoutMs = 180_000) {
    const e = await this.waitEv("startupz", timeoutMs);
    return e ? Date.now() - this.startedAt : null;
  }

  sh(cmd, o) {
    return exec(this.name, cmd, o);
  }
  as1000(cmd, o) {
    return exec(this.name, cmd, { ...o, user: "1000" });
  }
  /** SIGTERM to PID 1 only (tini -s forwards to ocsup): the platform drain shape. */
  sigterm() {
    return dk(["kill", "-s", "TERM", this.name]);
  }
  /** SIGTERM to every process (inactivity-stop shape, T7c(1)): kill -TERM -1 inside, then PID 1. */
  sigtermAll() {
    const r = exec(this.name, "kill -TERM -1 2>/dev/null; true");
    dk(["kill", "-s", "TERM", this.name]);
    return r;
  }
  sigkill() {
    return dk(["kill", "-s", "KILL", this.name]);
  }
  /** docker commit -> image tag (snapshot stand-in). The container may be running or exited. */
  snapshot() {
    const tag = `${PFX}-snap:${this.name.slice(PFX.length + 1)}-${++this.snaps}`;
    dkOk(["commit", "-p", this.name, tag]);
    this.t?.note?.(`snapshot ${this.name} -> ${tag}`);
    return tag;
  }
  rm() {
    this.savedLog = logs(this.name);
    rm(this.name);
  }

  /** One ocsupctl call over the contract socket (/run/ocrt/ocsupctl.sock). Returns the parsed answer. */
  ctlArgv(op, { opId, args } = {}) {
    const req = JSON.stringify({ op, ...(opId ? { opId } : {}), ...(args ? { args } : {}) });
    const js = `const n=require("net");const s=n.connect(process.argv[1]);let b="";s.on("connect",()=>s.write(process.argv[2]+"\\n"));s.on("data",d=>{b+=d;const i=b.indexOf("\\n");if(i>=0){process.stdout.write(b.slice(0,i));s.end();}});s.on("error",e=>{process.stdout.write(JSON.stringify({ok:false,error:"socket",detail:String(e.code||e)}));});s.on("close",()=>{if(!b.includes("\\n")&&b)process.stdout.write(b)})`;
    return ["node", "-e", js, "/run/ocrt/ocsupctl.sock", req];
  }
  ctl(op, { opId, args, timeoutMs = 400_000 } = {}) {
    return parseCtl(exec(this.name, this.ctlArgv(op, { opId, args }), { timeoutMs }));
  }
  /** Same as ctl(), without blocking the event loop (for SIGTERM-during-call tests). */
  async ctlAsync(op, { opId, args, timeoutMs = 400_000 } = {}) {
    return parseCtl(await dkAsync(["exec", this.name, ...this.ctlArgv(op, { opId, args })], { timeoutMs }));
  }
  /** Fault line: ocsupctl op "fault", else the M0 fault file. */
  fault(line) {
    const r = this.ctl("fault", { args: { line } });
    if (r.ok) return r;
    exec(this.name, ["sh", "-c", `echo '${line}' > /var/lib/ocrt/faults`]);
    return { ok: true, via: "file" };
  }
  /** Read a file from the container (running or exited). */
  cat(p) {
    const r = spawnSync("docker", ["cp", `${this.name}:${p}`, "-"], { maxBuffer: 1 << 30 });
    if (r.status !== 0) return null;
    // docker cp to stdout gives a tar stream; take the single file body.
    return untarOne(r.stdout);
  }
}

function parseCtl(r) {
  try {
    return JSON.parse(r.out);
  } catch {
    return { ok: false, error: "no-answer", detail: (r.out || r.err).slice(-300) };
  }
}

/** Body (Buffer) of the first entry of a tar stream. */
export function untarOne(b) {
  if (b.length < 512) return null;
  const size = Number.parseInt(b.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim(), 8);
  return b.subarray(512, 512 + size);
}

/**
 * Fixture image: run `script` (sh -c) in a throw-away container of `base` as `user`, commit it.
 * Returns the tag (ocm1n<N>-snap:fx-<label>). The entrypoint is replaced while the script runs; the
 * commit restores the base's own ENTRYPOINT, CMD and USER (absolute paths since F-SEC-1).
 */
export function prepImage(base, label, script, { user = "1000" } = {}) {
  const name = `${PFX}-fx-${label}`.slice(0, 63);
  const tag = `${PFX}-snap:fx-${label}`;
  rm(name);
  const cfg = JSON.parse(dk(["image", "inspect", "-f", "{{json .Config}}", base]).out || "{}");
  const r = dk(["run", "--name", name, "-u", user, "--entrypoint", "sh", base, "-c", script], {
    timeoutMs: 300_000,
  });
  if (r.code !== 0) throw new Error(`fixture ${label}: ${r.err.slice(-400) || r.out.slice(-400)}`);
  const ep = cfg.Entrypoint || [
    "/usr/bin/tini",
    "-s",
    "--",
    "/usr/local/bin/node",
    "--max-old-space-size=256",
    "/opt/ocrt/ocsup.mjs",
  ];
  dkOk([
    "commit",
    "-c",
    `ENTRYPOINT ${JSON.stringify(ep)}`,
    "-c",
    `CMD ${JSON.stringify(cfg.Cmd || [])}`,
    "-c",
    `USER ${cfg.User || "root"}`,
    name,
    tag,
  ]);
  rm(name);
  return tag;
}
