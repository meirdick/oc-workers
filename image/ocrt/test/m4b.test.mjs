// M4b fixes in ocsup: C1 shadow clock from plan.shadowAt, N3 disk reserve and no crash loop at a full disk,
// N1+N2 quick_check at boot and after a gateway exit with SQLite corruption text (M4-STATUS §7).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BootPlan, classifyExit, exitCodeFor, validate } from "../lib/contract.mjs";
import { DiskWatch } from "../lib/diskwatch.mjs";
import { createGateway, DISK_FULL_RETRY_MS } from "../lib/gateway.mjs";
import { gatewayExitClass } from "../lib/lock.mjs";
import { renderConfig } from "../lib/ls-config.mjs";
import { planSteps } from "../lib/plan.mjs";
import { SHADOW_EVERY_MS, shadowDue } from "../lib/shadow.mjs";
import { SQLITE_SUSPECT_RE, sqliteCheck } from "../lib/sqlite-check.mjs";

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};
function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}
function gwWorld(extra = {}) {
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
    ...extra,
  });
  return { gw, kids, fatal, waits };
}

test("C1 shadowDue: no shadow known → due at start; 15 min after plan.shadowAt → due", () => {
  const now = 10_000_000;
  assert.equal(shadowDue(null, now), true);
  assert.equal(shadowDue(now - 60_000, now), false);
  assert.equal(shadowDue(now - SHADOW_EVERY_MS, now), true);
  assert.deepEqual(validate(BootPlan.p.shadowAt, 123), []);
});

test("N3 gateway exit with ENOSPC text → disk-full class, never counted to the crash loop", async () => {
  assert.equal(
    gatewayExitClass({ code: 1, tail: "Error: ENOSPC: no space left on device, write" }).kind,
    "disk-full",
  );
  const w = gwWorld();
  await w.gw.start();
  for (let i = 0; i < 8; i++) {
    w.kids.at(-1).stderr.emit("data", "Error: ENOSPC: no space left on device\n");
    w.kids.at(-1).emit("exit", 1, null);
    await tick();
  }
  assert.deepEqual(w.fatal, []);
  assert.equal(w.gw.state.restarts.length, 0);
  assert.ok(w.waits.every((ms) => ms === DISK_FULL_RETRY_MS));
  assert.equal(w.kids.length, 9);
});

test("N3 a plain crash while the disk watch says low is not counted; without it, 5 crashes = crash loop", async () => {
  let low = true;
  const w = gwWorld({ diskFull: () => low });
  await w.gw.start();
  for (let i = 0; i < 6; i++) {
    w.kids.at(-1).emit("exit", null, "SIGSEGV");
    await tick();
  }
  assert.deepEqual(w.fatal, []);
  low = false;
  for (let i = 0; i < 5; i++) {
    w.kids.at(-1).emit("exit", 1, null);
    await tick();
  }
  assert.deepEqual(w.fatal, ["gateway-crash-loop"]);
});

test("N3 DiskWatch: free < reserve → low (onLow), off at 2× reserve, then the reserve is made again", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"));
  let free = 10_000;
  const lows = [];
  const made = [];
  const w = new DiskWatch({
    varDir: d,
    reserveBytes: 1000,
    statfs: () => ({ usedPct: 50, inodesPct: 1, freeBytes: free, totalBytes: 20_000 }),
    onLow: (on) => lows.push(on),
    fallocate: (f, n) => {
      fs.writeFileSync(f, "x");
      made.push(n);
      return true;
    },
  });
  free = 900;
  assert.ok((await w.check()).actions.includes("low"));
  assert.equal(w.low, true);
  free = 1500;
  await w.check();
  assert.equal(w.low, true); // hysteresis
  free = 5000;
  const r = await w.check();
  assert.deepEqual([w.low, lows], [false, [true, false]]);
  assert.ok(r.actions.includes("reserve-made"));
  assert.deepEqual(made, [1000]);
});

test("N3 low-disk Litestream config: L1 and snapshot out to 24 h / 720 h", () => {
  const o = {
    state: "/s",
    gen: 3,
    inst: "t1",
    dbs: ["state/openclaw.sqlite"],
    s3: { endpoint: "http://x", bucket: "b", accessKey: "a", secretKey: "k" },
  };
  assert.match(renderConfig(o), /interval: 5m/);
  const low = renderConfig({ ...o, lowDisk: true });
  assert.match(low, /levels:\n {2}- interval: 24h/);
  assert.match(low, /snapshot:\n {2}interval: 720h/);
});

test("N1+N2 sqliteCheck: a quick_check answer is evidence; an ocio failure is not", async () => {
  const answers = {
    "/s/state/openclaw.sqlite": {
      ok: false,
      result: "*** in database main ***\nPage 3: btreeInitPage() returns error code 11",
    },
    "/s/agents/a/agent/x.sqlite": { ok: true, result: "ok" },
  };
  const ocio = async (_n, a) => ({ json: answers[JSON.parse(a[1]).file] ?? null, err: "spawn failed" });
  const r = await sqliteCheck({
    state: "/s",
    rels: ["state/openclaw.sqlite", "agents/a/agent/x.sqlite", "y.sqlite"],
    ocio,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.bad.map((b) => b.rel),
    ["state/openclaw.sqlite"],
  );
  assert.match(r.evidence, /^quick_check state\/openclaw.sqlite: \*\*\* in database main/);
  assert.equal(exitCodeFor("sqlite-corrupt"), 75);
  assert.deepEqual(classifyExit(75, "sqlite-corrupt"), { cls: "sqlite-corrupt", esc: true });
  assert.ok(SQLITE_SUSPECT_RE.test("SqliteError: database disk image is malformed"));
  assert.ok(!SQLITE_SUSPECT_RE.test("ECONNRESET"));
});

test("N1+N2 plan: sqlite-check before the workspace step for every kind but fresh", () => {
  const base = {
    v: 1,
    mode: "prod",
    inst: "t1",
    epoch: 1,
    gen: 7,
    rootfs: { kind: "image" },
    sqlite: { kind: "gen", gen: 6 },
    dbs: [{ db: "state/openclaw.sqlite", state: "uploaded" }],
    restoreGens: [],
    runDoctor: false,
    lockMode: "auto",
  };
  const names = (p) => p.steps.map((s) => s.step);
  assert.ok(names(planSteps(base)).indexOf("sqlite-check") < names(planSteps(base)).indexOf("workspace"));
  assert.ok(!names(planSteps({ ...base, sqlite: { kind: "fresh" } })).includes("sqlite-check"));
});

test("N1+N2 gateway exit with SQLITE_CORRUPT in the log: check first; failed check → no restart", async () => {
  const seen = [];
  const w = gwWorld({
    onSqliteSuspect: async (t) => {
      seen.push(t);
      return { fatal: true };
    },
  });
  await w.gw.start();
  w.kids.at(-1).stderr.emit("data", "SqliteError: database disk image is malformed (SQLITE_CORRUPT)\n");
  w.kids.at(-1).emit("exit", 1, null);
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(w.kids.length, 1); // no restart
  // Check passes → normal restart.
  const w2 = gwWorld({ onSqliteSuspect: async () => ({ fatal: false }) });
  await w2.gw.start();
  w2.kids.at(-1).stderr.emit("data", "SQLITE_CORRUPT\n");
  w2.kids.at(-1).emit("exit", 1, null);
  await tick();
  assert.equal(w2.kids.length, 2);
  // Exit 78 with schema text: checked, then doctor-required as before when the DBs pass.
  const w3 = gwWorld({ onSqliteSuspect: async () => ({ fatal: false }) });
  await w3.gw.start();
  w3.kids.at(-1).stderr.emit("data", "malformed database schema (x)\n");
  w3.kids.at(-1).emit("exit", 78, null);
  await tick();
  assert.deepEqual(w3.fatal, ["doctor-required"]);
});

test("N2 fsops dirty: lock files under tmp/, logs and caches are not dirty; a workspace file is", async () => {
  const { spawnSync } = await import("node:child_process");
  const st = fs.mkdtempSync(path.join(os.tmpdir(), "dirty-"));
  const since = Date.now() - 1000;
  for (const f of [
    "tmp/openclaw-1000/gateway.state.lock",
    "logs/gateway.log",
    "cache/x.bin",
    "agents/a/.cache/y",
    "agents/a/run.pid",
  ]) {
    fs.mkdirSync(path.dirname(path.join(st, f)), { recursive: true });
    fs.writeFileSync(path.join(st, f), "x");
  }
  const run = () =>
    JSON.parse(
      spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "../ocio/fsops.mjs"),
          "dirty",
          JSON.stringify({ state: st, sinceMs: since }),
        ],
        {
          encoding: "utf8",
        },
      ).stdout,
    );
  assert.equal(run().count, 0);
  fs.mkdirSync(path.join(st, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(st, "workspace/m.md"), "x".repeat(1024));
  assert.deepEqual([run().count, run().sample], [1, ["workspace/m.md"]]);
});
