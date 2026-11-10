import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ctlRequest, dispatch, startCtlServer } from "../lib/ctl.mjs";
import { applyFault, parseFaults, takeFaults } from "../lib/faults.mjs";
import { createGate, StaleError } from "../lib/gate.mjs";
import { buildCommand, createGateway, gatewayEnv, secretRefNames, startupzOk } from "../lib/gateway.mjs";
import { createHeartbeat, elapsedSince } from "../lib/heartbeat.mjs";
import { newIid, pinHostname, readBootIdentity, stepPidCounter, writeBootJson } from "../lib/identity.mjs";
import { classifyOwners, gatewayExitClass, lockAction, runLockStep } from "../lib/lock.mjs";
import { createLog, createStatusWriter, redact } from "../lib/log.mjs";
import { planSteps, seedCapMs } from "../lib/plan.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ocsup-t-"));

test("log ring rotates, tails across .1, keeps 5 errors, redacts", () => {
  const d = tmp();
  const L = createLog({ file: path.join(d, "l"), ringMax: 2000, stdout: null });
  for (let i = 0; i < 200; i++) L.log("x", { i, token: "abc" });
  for (let i = 0; i < 7; i++) L.log("restore-failed", { i });
  assert.ok(fs.existsSync(path.join(d, "l.1")));
  const t = L.tail(50);
  assert.equal(t.length, 50);
  assert.ok(!t.join("").includes("abc"));
  assert.equal(L.errors().length, 5);
  assert.deepEqual(redact({ a: { secretKey: "s", n: 1 } }), { a: { secretKey: "***", n: 1 } });
  const w = createStatusWriter(path.join(d, "s.json"));
  assert.ok(w({ phase: "boot", bootSecret: "zz" }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "s.json"))).bootSecret, "***");
  assert.equal(fs.statSync(path.join(d, "s.json")).mode & 0o777, 0o600);
});

test("boot identity: new boot detection, count, hostname pin, pid step, boot.json", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "bid"), "aaa\n");
  const a = readBootIdentity({ bootIdFile: path.join(d, "bid"), varDir: path.join(d, "v") });
  assert.deepEqual([a.newBoot, a.bootCount, a.prev], [true, 1, null]);
  const b = readBootIdentity({ bootIdFile: path.join(d, "bid"), varDir: path.join(d, "v") });
  assert.deepEqual([b.newBoot, b.bootCount], [false, 2]);
  fs.writeFileSync(path.join(d, "bid"), "bbb\n");
  assert.equal(
    readBootIdentity({ bootIdFile: path.join(d, "bid"), varDir: path.join(d, "v") }).newBoot,
    true,
  );
  let h = "abc123";
  assert.equal(
    pinHostname("localhost", {
      get: () => h,
      set: (n) => {
        h = n;
        return { ok: true };
      },
    }).pinned,
    true,
  );
  const f = pinHostname("localhost", { get: () => "x", set: () => ({ ok: false, err: "EPERM" }) });
  assert.deepEqual([f.pinned, f.err], [false, "EPERM"]);
  fs.writeFileSync(path.join(d, "nlp"), "500");
  fs.writeFileSync(path.join(d, "pmax"), "100000");
  const s = stepPidCounter({ file: path.join(d, "nlp"), maxFile: path.join(d, "pmax"), step: 3000 });
  assert.deepEqual([s.ok, s.to, fs.readFileSync(path.join(d, "nlp"), "utf8")], [true, 3500, "3500"]);
  assert.match(newIid(), /^[0-9a-f]{32}$/);
  const bj = writeBootJson(path.join(d, "r", "boot.json"), { gen: 3, epoch: 1, iid: "i", secret: "s" });
  assert.match(bj.secretHash, /^[0-9a-f]{64}$/);
});

function fakeGateServer(secret, handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, headers: init.headers, body });
    if (u.pathname === "/v1/hello") {
      const proof = createHmac("sha256", secret).update(`oc-hello\0${body.challenge}`).digest("hex");
      return new Response(JSON.stringify({ proof, pv: [1] }));
    }
    const [status, json] = handler(u.pathname, body, init.headers);
    return new Response(JSON.stringify(json), { status });
  };
  return { fetch, calls };
}

const okPlan = {
  v: 1,
  mode: "prod",
  gen: 7,
  rootfs: { kind: "image" },
  sqlite: { kind: "fresh" },
  dbs: [],
  runDoctor: false,
  lockMode: "auto",
};

test("gate: hello proof before secret, boot binds iid, 409 -> stale once", async () => {
  let staleCount = 0;
  const g1 = fakeGateServer("sec", (p) =>
    p === "/v1/boot" ? [200, { status: "ok", plan: okPlan }] : [409, { error: "stale" }],
  );
  const gate = createGate({
    base: "http://g",
    secret: "sec",
    iid: "a".repeat(32),
    envelope: () => ({ inst: "t", gen: 7 }),
    fetch: g1.fetch,
    onStale: () => staleCount++,
  });
  const r = await gate.boot({});
  assert.equal(r.status, "ok");
  assert.equal(g1.calls[0].path, "/v1/hello");
  assert.equal(g1.calls[0].headers["x-ocrt-secret"], undefined);
  // 1.2.3: hello MAC for the control plane, never the secret
  assert.equal(
    g1.calls[0].headers["x-ocrt-hello-mac"],
    createHmac("sha256", "sec").update(`oc-hello-mac\0control\0${g1.calls[0].body.challenge}`).digest("hex"),
  );
  assert.equal(g1.calls[1].headers["x-ocrt-secret"], "sec");
  await assert.rejects(gate.heartbeat({ seq: 1 }), StaleError);
  await assert.rejects(gate.heartbeat({ seq: 2 }), StaleError);
  assert.equal(staleCount, 1);
  assert.equal(g1.calls[2].headers["x-ocrt-iid"], "a".repeat(32));
  // wrong proof: never sends the secret
  const bad = createGate({
    base: "http://g",
    secret: "other",
    iid: "b".repeat(32),
    fetch: g1.fetch,
    sleep: async () => {},
  });
  const n = g1.calls.length;
  const rb = await bad.boot({}, { capMs: 50 });
  assert.equal(rb.status, "unreachable");
  assert.ok(g1.calls.slice(n).every((c) => c.path === "/v1/hello"));
  // reboot-detected passes through
  const g2 = fakeGateServer("sec", () => [200, { status: "reboot-detected" }]);
  assert.equal(
    (await createGate({ base: "http://g", secret: "sec", iid: "c".repeat(32), fetch: g2.fetch }).boot({}))
      .status,
    "reboot-detected",
  );
});

const P = (sqlite, extra = {}) => ({
  ...okPlan,
  rootfs: { kind: "snapshot", snapshotId: "s1" },
  sqlite,
  dbs: [{ db: "state/openclaw.sqlite", bytes: 1000, state: "uploaded", lastTxid: 5 }],
  ...extra,
});
const names = (r) => r.steps.map((s) => s.step);

test("plan modes: fresh, marker, gen, archive, snapshot, restore-blocked", () => {
  assert.deepEqual(names(planSteps({ ...okPlan })), [
    "wipe",
    "sqlite-fresh",
    "workspace",
    "lock",
    "ownership",
    "creds",
    "config",
    "litestream",
    "start-gate",
    "gateway",
  ]);
  const m = planSteps(P({ kind: "marker", markerId: "m", snapshotId: "s1", gen: 6 }));
  assert.equal(m.steps[1].step, "sqlite-marker");
  assert.equal(m.startGate.wait, true);
  assert.equal(
    planSteps(P({ kind: "marker", markerId: "m", snapshotId: "s2", gen: 6 })).exit.reason,
    "restore-blocked:mismatch",
  );
  assert.equal(
    planSteps(P({ kind: "marker", markerId: "m", snapshotId: "s1", gen: 6 }), { startSnapshotId: "s9" }).exit
      .code,
    75,
  );
  const g = planSteps(
    P(
      { kind: "gen", gen: 6 },
      {
        dbs: [
          { db: "state/openclaw.sqlite", state: "uploaded" },
          { db: "agents/a/agent/openclaw-agent.sqlite", state: "pending" },
        ],
        runDoctor: true,
      },
    ),
  );
  assert.deepEqual(names(g), [
    "wipe",
    "sqlite-gen",
    "sqlite-pending",
    "sqlite-check",
    "workspace",
    "lock",
    "ownership",
    "creds",
    "config",
    "doctor",
    "litestream",
    "start-gate",
    "gateway",
  ]);
  assert.deepEqual(g.steps[1].dbs, ["state/openclaw.sqlite"]);
  const a = planSteps({
    ...okPlan,
    sqlite: { kind: "archive", archiveId: "a1" },
    archive: { archiveId: "a1", sha256: "f".repeat(64) },
  });
  assert.deepEqual(names(a).slice(0, 3), ["wipe", "archive-restore", "sqlite-archive-check"]);
  assert.equal(planSteps({ ...okPlan, sqlite: { kind: "archive", archiveId: "a1" } }).exit.code, 75);
  const fo = planSteps(P({ kind: "snapshot" }, { mode: "files-only" }));
  assert.deepEqual(
    [fo.gateway, fo.litestream, names(fo)],
    [false, false, ["wipe", "sqlite-keep", "ownership"]],
  );
  assert.equal(planSteps(P({ kind: "snapshot" })).exit.code, 75);
  assert.deepEqual(planSteps(P({ kind: "restore-blocked", reason: "restore-blocked:schema" })).exit, {
    code: 75,
    reason: "restore-blocked:schema",
    detail: "plan",
  });
  assert.equal(
    planSteps(P({ kind: "gen", gen: 2 }, { mode: "canary" })).exit.reason,
    "restore-blocked:mismatch",
  );
  const c = planSteps({ ...okPlan, mode: "canary", sqlite: { kind: "gen", gen: 2 } });
  assert.deepEqual([c.credsync, c.steps.find((s) => s.step === "config").channelsOff], ["none", true]);
  assert.equal(planSteps({ v: 1 }).exit.reason, "restore-blocked:infra");
});

test("plan start gate: big set on a marker wake goes seeding (amend §1.6 S3)", () => {
  const big = P(
    { kind: "marker", markerId: "m", snapshotId: "s1", gen: 6 },
    { dbs: [{ db: "state/openclaw.sqlite", bytes: 1e9 }] },
  );
  assert.deepEqual(planSteps(big).startGate, { wait: false, seeding: true, setBytes: 1e9 });
  assert.equal(planSteps({ ...big, sqlite: { kind: "gen", gen: 6 } }).startGate.wait, true);
  assert.equal(seedCapMs(1e9), 130_000);
});

test("lock classification and actions", () => {
  const me = { host: "localhost", bootId: "B2", pidNs: "9" };
  const ns = (host, identity, pidNsInode = 9) => ({ host, identity, pidNsInode });
  assert.equal(classifyOwners({ files: [] }, me), "none");
  assert.equal(classifyOwners({ files: [{ ns: ns("localhost", "B1") }] }, me), "dead:samehost-newboot");
  assert.equal(
    classifyOwners({ lease: [{ owner: { processNamespace: ns("localhost", "B2") } }] }, me),
    "same:pid-check",
  );
  assert.equal(classifyOwners({ files: [{ ns: ns("abc", "B1") }] }, me), "unknown");
  assert.deepEqual(lockAction("unknown", { recoverLock: true }), { action: "recover-lock" });
  assert.deepEqual(lockAction("unknown", { ageMs: 30_000 }), { action: "wait", waitMs: 65_000 });
  assert.equal(lockAction("unknown", { lockMode: "recover-lock" }).action, "blocked");
  assert.equal(lockAction("dead:samehost-newboot", {}).action, "none");
});

test("gateway exit classes: 78 doctor-required, exit 1 lock text -> wait, crash", () => {
  assert.equal(gatewayExitClass({ code: 78 }).kind, "doctor-required");
  assert.equal(
    gatewayExitClass({ code: 1, tail: "x | gateway.maintenance_required" }).kind,
    "doctor-required",
  );
  const lw = gatewayExitClass({
    code: 1,
    tail: "holder 7 at h/pid-ns 1, last renewed 10 s ago. wait 80 s and retry",
    uptimeMs: 3000,
  });
  assert.deepEqual(lw, { kind: "lock-wait", waitMs: 82_000 });
  assert.equal(gatewayExitClass({ code: 1, tail: "boom", uptimeMs: 3000 }).kind, "crash");
  assert.equal(gatewayExitClass({ code: 1, tail: "wait 80 s and retry", uptimeMs: 300_000 }).kind, "crash");
  assert.equal(gatewayExitClass({ code: null, signal: "SIGABRT" }).kind, "heap-abort");
  assert.equal(gatewayExitClass({ code: 0 }).kind, "clean");
});

test("runLockStep waits on 2026.10.9 and blocks when recover-lock fails", async () => {
  const me = { host: "localhost", bootId: "B2", pidNs: "9" };
  const seen = { files: [{ ns: { host: "x", identity: "B1" }, ageMs: 94_000 }] };
  let slept = 0;
  const r = await runLockStep("auto", {
    readOwners: async () => seen,
    me,
    hasRecoverLock: async () => false,
    sleep: async (ms) => (slept += ms),
    stopped: () => false,
  });
  assert.equal(r.action, "wait");
  assert.equal(r.waitMs, 1000);
  const b = await runLockStep("auto", {
    readOwners: async () => seen,
    me,
    hasRecoverLock: async () => true,
    recoverLock: async () => ({ ok: false }),
  });
  assert.deepEqual([b.ok, b.reason], [false, "lock-blocked"]);
});

test("secret refs and gateway env: OC_*, refs, CA, no OCRT_/AWS_", () => {
  const doc = {
    models: {
      providers: {
        a: { apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" } },
        b: { url: ["$", "{OPENAI_BASE}/v1"].join("") },
      },
    },
  };
  assert.deepEqual(secretRefNames(doc), ["ANTHROPIC_API_KEY", "OPENAI_BASE"]);
  const env = gatewayEnv(
    {
      OC_GATEWAY_TOKEN: "t",
      OCRT_BOOT_SECRET: "x",
      AWS_SECRET_ACCESS_KEY: "y",
      ANTHROPIC_API_KEY: "k",
      OTHER: "o",
    },
    { refs: ["ANTHROPIC_API_KEY", "OCRT_BOOT_SECRET"], caExists: () => true },
  );
  assert.equal(env.ANTHROPIC_API_KEY, "k");
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, "t");
  assert.equal(env.OPENCLAW_GATEWAY_PASSWORD, undefined); // no password unless trusted-proxy
  const tp = gatewayEnv({ OC_GATEWAY_TOKEN: "t" }, { caExists: () => false, localPassword: true });
  assert.equal(tp.OPENCLAW_GATEWAY_PASSWORD, "t"); // local CLI auth under trusted-proxy
  assert.equal(tp.OPENCLAW_GATEWAY_TOKEN, undefined); // token + trusted-proxy: the gateway does not start
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/cloudflare/certs/cloudflare-containers-ca.crt");
  for (const k of ["OCRT_BOOT_SECRET", "AWS_SECRET_ACCESS_KEY", "OTHER"]) assert.equal(env[k], undefined);
});

test("buildCommand: setpriv first, then env preload, prelude joins cgroup and sets oom", () => {
  const [cmd, args] = buildCommand({
    cmd: "/usr/local/bin/node",
    args: ["/app/openclaw.mjs", "gateway"],
    cg: "/sys/fs/cgroup/ocrt/gw/main",
    exists: () => true,
  });
  assert.equal(cmd, "/bin/sh"); // absolute (F-SEC-1)
  assert.match(args[1], /echo \$\$ > \/sys\/fs\/cgroup\/ocrt\/gw\/main\/cgroup.procs/);
  assert.match(args[1], /echo 500 > \/proc\/self\/oom_score_adj/);
  const rest = args.slice(3);
  assert.equal(rest[0], "/usr/bin/setpriv");
  const e = rest.indexOf("/usr/bin/env");
  assert.ok(e > rest.indexOf("--"));
  assert.match(rest[e + 1], /^LD_PRELOAD=.*libjemalloc.so.2:\/opt\/ocrt\/nodump.so$/);
  assert.ok(startupzOk(200, '{"status":"started"}'));
  assert.ok(!startupzOk(200, "<html>"));
});

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

test("gateway supervisor: lock-wait not counted, crash loop at 5, 78 fatal, stop", async () => {
  let pid = 100;
  const kids = [];
  const fatal = [];
  const waits = [];
  const gw = createGateway({
    spawn: () => {
      const c = fakeChild(++pid);
      kids.push(c);
      return c;
    },
    argv: () => ["node", []],
    env: () => ({}),
    canStart: () => true,
    sleep: async (ms) => waits.push(ms),
    onFatal: (r) => fatal.push(r),
    kill: (_p, sig) => {
      if (sig === "SIGTERM") setImmediate(() => kids.at(-1).emit("exit", 0, null));
    },
  });
  await gw.start();
  kids.at(-1).stderr.emit("data", "wait 30 s and retry\n");
  kids.at(-1).emit("exit", 1, null);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(waits[0], 32_000);
  assert.equal(gw.state.restarts.length, 0);
  for (let i = 0; i < 5; i++) {
    kids.at(-1).emit("exit", 1, null);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(fatal, ["gateway-crash-loop"]);
  await gw.start("manual");
  const before = kids.length;
  kids.at(-1).emit("exit", 78, null);
  assert.deepEqual(fatal, ["gateway-crash-loop", "doctor-required"]);
  assert.equal(kids.length, before);
  await gw.start("resume");
  const s = await gw.stop({ capMs: 1000 });
  assert.deepEqual([s.clean, s.code], [true, 0]);
});

test("heartbeat: fence after 150 s without ack, unfence on ack, stale once", async () => {
  let t = 0;
  const clocks = { mono: () => t, boot: () => t, wall: () => 1e12 + t };
  const ev = [];
  let mode = "ok";
  const hb = createHeartbeat({
    gen: 7,
    clocks,
    send: async () => {
      if (mode === "fail") throw new Error("down");
      if (mode === "stale") throw new StaleError("/v1/heartbeat");
      return { ok: true, gen: mode === "wronggen" ? 8 : 7, tier: "normal" };
    },
    body: () => ({ phase: "running" }),
    onFence: (w) => ev.push(`fence:${w}`),
    onUnfence: () => ev.push("unfence"),
    onStale: () => ev.push("stale"),
  });
  hb.armFence();
  await hb.tick();
  mode = "fail";
  t = 149_000;
  await hb.tick();
  assert.deepEqual(ev, []);
  t = 150_000;
  hb.check();
  assert.deepEqual(ev, ["fence:heartbeat-lost"]);
  mode = "wronggen";
  await hb.tick();
  assert.deepEqual(ev, ["fence:heartbeat-lost"]);
  mode = "ok";
  await hb.tick();
  assert.deepEqual(ev, ["fence:heartbeat-lost", "unfence"]);
  mode = "stale";
  await hb.tick();
  await hb.tick();
  assert.deepEqual(ev.at(-1), "stale");
  assert.equal(ev.filter((e) => e === "stale").length, 1);
  // a forward wall jump or a VM pause counts; a backward wall jump does not
  assert.equal(elapsedSince({ mono: 0, boot: 0, wall: 0 }, { mono: 10, boot: 200_000, wall: 10 }), 200_000);
  assert.equal(elapsedSince({ mono: 0, boot: null, wall: 100 }, { mono: 10, boot: null, wall: 0 }), 10);
});

test("ctl: dispatch rules and a real socket", async () => {
  const handlers = {
    status: async () => ({ ok: true, phase: "running" }),
    "restart-gateway": async () => ({ ok: true }),
  };
  let draining = false;
  assert.equal((await dispatch({ op: "nope" }, { handlers })).error, "unknown-op");
  assert.equal((await dispatch({ op: "fault" }, { handlers })).error, "unknown-op");
  draining = true;
  assert.equal(
    (await dispatch({ op: "restart-gateway" }, { handlers, draining: () => draining })).error,
    "draining",
  );
  assert.equal(
    (await dispatch({ op: "sleep-check", opId: "x" }, { handlers, draining: () => draining })).error,
    "draining",
  );
  assert.equal((await dispatch({ op: "status" }, { handlers, draining: () => draining })).phase, "running");
  const sock = path.join(tmp(), "c.sock");
  const srv = startCtlServer({ sock, handlers, draining: () => false });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  assert.deepEqual(await ctlRequest(sock, { op: "status" }), { ok: true, phase: "running" });
  srv.close();
});

test("faults: parse, consume, apply", () => {
  const d = tmp();
  const f = path.join(d, "faults");
  fs.writeFileSync(f, "# c\nkill-gateway\nexit 3\nbogus\n");
  const got = takeFaults(f);
  assert.deepEqual(
    got.map((x) => [x.cmd, x.arg, x.known]),
    [
      ["kill-gateway", null, true],
      ["exit", "3", true],
      ["bogus", null, false],
    ],
  );
  assert.ok(!fs.existsSync(f));
  assert.deepEqual(takeFaults(f), []);
  assert.equal(applyFault(got[2], {}).err, "unknown");
  assert.deepEqual(applyFault(got[0], { "kill-gateway": () => ({ pid: 5 }) }), {
    cmd: "kill-gateway",
    arg: null,
    pid: 5,
  });
  assert.equal(parseFaults("heartbeat-off").length, 1);
});
