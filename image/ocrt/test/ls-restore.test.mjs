import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyDbs,
  lsRestoreRun,
  markerCheck,
  pendingCheck,
  prestartWipe,
  restoredTxid,
  restoreGen,
  verifyGen,
} from "../lib/ls-restore.mjs";
import { runOcio } from "../lib/ocio-run.mjs";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "state-fx");
const ocio = (n, a, o = {}) => runOcio(n, a, { ...o, asRoot: true });
const S3 = { endpoint: "http://127.0.0.1:1", bucket: "b", region: "auto", accessKey: "k", secretKey: "s" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
const mkdb = (file, rows = 1) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode=wal; create table if not exists t(x)");
  for (let i = 0; i < rows; i++) db.exec(`insert into t values (${i})`);
  db.close();
};
const fakeSpawn = (mode) => (_c, a) =>
  spawn(process.execPath, [path.join(FX, "fake-ls-restore.mjs"), ...a], {
    env: { ...process.env, FAKE_RESTORE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("ls-restore", () => {
  it("scan + classify: managed set, unclassified shadow, symlink and hard link refused", async () => {
    const st = tmp();
    mkdb(path.join(st, "state/openclaw.sqlite"));
    mkdb(path.join(st, "agents/main/agent/openclaw-agent.sqlite"));
    mkdb(path.join(st, "plugins/team-reports/reports.sqlite"));
    mkdb(path.join(st, "state/openclaw-quarantine.sqlite"));
    mkdb(path.join(st, "tmp/plugin-captures/1/c.sqlite"));
    fs.mkdirSync(path.join(st, "agents/evil/agent"), { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(st, "agents/evil/agent/openclaw-agent.sqlite"));
    mkdb(path.join(st, "x/a.sqlite"));
    fs.linkSync(path.join(st, "x/a.sqlite"), path.join(st, "x/b.sqlite"));
    fs.mkdirSync(path.join(st, "node_modules/p"), { recursive: true });
    mkdb(path.join(st, "node_modules/p/skip.sqlite"));
    const r = await ocio("fsops", ["scan", JSON.stringify({ state: st })]);
    assert.equal(r.code, 0, r.err);
    const c = classifyDbs(r.json);
    assert.deepEqual(c.managed, ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"]);
    assert.deepEqual(c.shadow, ["plugins/team-reports/reports.sqlite"]);
    assert.deepEqual(c.ignored, ["state/openclaw-quarantine.sqlite", "tmp/plugin-captures/1/c.sqlite"]);
    assert.deepEqual(c.refused.map((x) => x.rel).sort(), [
      "agents/evil/agent/openclaw-agent.sqlite",
      "x/a.sqlite",
      "x/b.sqlite",
    ]);
    assert.deepEqual(
      c.alerts.map((a) => a.class),
      ["db-unclassified", "db-unsafe"],
    );
    assert.match(c.alerts[0].detail, /team-reports/);
  });
  it("cap 32: extras go to shadow with db-set-cap", () => {
    const sqlite = Array.from({ length: 34 }, (_, i) => ({
      rel: `agents/a${String(i).padStart(2, "0")}/agent/openclaw-agent.sqlite`,
      nlink: 1,
    }));
    const c = classifyDbs({ sqlite });
    assert.equal(c.managed.length, 32);
    assert.equal(c.shadow.length, 2);
    assert.ok(c.alerts.some((a) => a.class === "db-set-cap"));
  });
  it("pre-start wipe removes ls-meta of every gen and legacy .<db>-litestream (F1.2)", async () => {
    const st = tmp();
    const v = tmp();
    const meta = path.join(v, "ls-meta");
    fs.mkdirSync(path.join(meta, "g4/state-x/ltx/0"), { recursive: true });
    mkdb(path.join(st, "state/openclaw.sqlite"));
    fs.mkdirSync(path.join(st, "state/.openclaw.sqlite-litestream/ltx/0"), { recursive: true });
    fs.mkdirSync(path.join(v, "stage"), { recursive: true });
    const r = await prestartWipe({
      state: st,
      varDir: v,
      metaRoot: meta,
      rels: ["state/openclaw.sqlite"],
      ocio,
      asRoot: true,
    });
    assert.deepEqual(fs.readdirSync(meta), []); // emptied, dir kept
    assert.equal(fs.existsSync(path.join(st, "state/.openclaw.sqlite-litestream")), false);
    assert.equal(fs.existsSync(path.join(v, "stage")), false);
    assert.equal(fs.existsSync(path.join(st, "state/openclaw.sqlite")), true);
    assert.equal(r.legacy.length, 1);
  });
  it("legacy wipe does not follow a symlinked state dir", async () => {
    const st = tmp();
    const victim = tmp();
    fs.mkdirSync(path.join(victim, ".openclaw.sqlite-litestream"));
    fs.symlinkSync(victim, path.join(st, "state"));
    const r = await ocio("fsops", [
      "wipe-legacy",
      JSON.stringify({ state: st, rels: ["state/openclaw.sqlite"] }),
    ]);
    assert.deepEqual(r.json.removed, []);
    assert.equal(fs.existsSync(path.join(victim, ".openclaw.sqlite-litestream")), true);
  });
  it("restoreGen places the restored DB, drops -wal/-shm, never passes -if-replica-exists", async () => {
    const st = tmp();
    const v = tmp();
    mkdb(path.join(st, "state/openclaw.sqlite"), 50);
    fs.writeFileSync(path.join(st, "state/openclaw.sqlite-wal"), "stale");
    const seen = [];
    const r = await restoreGen({
      state: st,
      varDir: v,
      runDir: v,
      inst: "x",
      gen: 4,
      dbs: ["state/openclaw.sqlite"],
      lastTxid: { "state/openclaw.sqlite": 16 },
      s3: S3,
      asRoot: true,
      ocio,
      spawn: (c, a, so) => {
        seen.push(a);
        return fakeSpawn("ok")(c, a, so);
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.dbs[0].txid, 16);
    assert.ok(!seen[0].includes("-if-replica-exists"));
    assert.equal(fs.existsSync(path.join(st, "state/openclaw.sqlite-wal")), false);
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(path.join(st, "state/openclaw.sqlite"), { readOnly: true });
    assert.equal(db.prepare("select count(*) n from t").get().n, 3);
    db.close();
    assert.match(
      fs.readFileSync(path.join(v, "litestream-restore.yml"), "utf8"),
      /r\/x\/g4\/state\/openclaw.sqlite/,
    );
  });
  it("empty gen, low TXID or a bad file → restore-blocked:mismatch, local DB kept", async () => {
    for (const [mode, why] of [
      ["fail", null],
      ["lowtxid", /txid 2 < plan 16/],
      ["garbage", /quick_check/],
    ]) {
      const st = tmp();
      const v = tmp();
      mkdb(path.join(st, "state/openclaw.sqlite"), 5);
      const r = await restoreGen({
        state: st,
        varDir: v,
        runDir: v,
        inst: "x",
        gen: 4,
        dbs: ["state/openclaw.sqlite"],
        lastTxid: { "state/openclaw.sqlite": 16 },
        s3: S3,
        asRoot: true,
        ocio,
        spawn: fakeSpawn(mode),
      });
      assert.equal(r.ok, false, mode);
      assert.equal(r.reason, "restore-blocked:mismatch", mode);
      if (why) assert.match(r.why, why);
      assert.equal(fs.existsSync(path.join(st, "state/openclaw.sqlite")), true);
    }
  });
  it("N7 verifyGen: restores into the scratch dir only; the live DB is untouched; bad vs infra", async () => {
    for (const [mode, want] of [
      ["ok", { ok: true }],
      ["garbage", { ok: false, reason: "bad" }],
      ["fail", { ok: false, reason: "bad" }],
      ["refused", { ok: false, reason: "infra" }],
      ["denied", { ok: false, reason: "infra" }],
      ["deadline", { ok: false, reason: "infra" }],
    ]) {
      const st = tmp();
      const v = tmp();
      const live = path.join(st, "state/openclaw.sqlite");
      mkdb(live, 7);
      const before = fs.readFileSync(live);
      const seen = [];
      const r = await verifyGen({
        state: st,
        varDir: v,
        runDir: v,
        inst: "x",
        gen: 9,
        dbs: ["state/openclaw.sqlite"],
        s3: S3,
        asRoot: true,
        ocio,
        spawn: (c, a, so) => {
          seen.push(a);
          return fakeSpawn(mode)(c, a, so);
        },
      });
      assert.equal(r.ok, want.ok, `${mode} ${JSON.stringify(r)}`);
      if (want.reason) assert.equal(r.reason, want.reason, mode);
      const out = seen[0][seen[0].indexOf("-o") + 1];
      assert.ok(out.startsWith(path.join(v, "rv")), out);
      assert.deepEqual(fs.readFileSync(live), before, mode);
      assert.deepEqual(fs.readdirSync(path.join(v, "rv")), [], mode); // scratch emptied
      assert.match(fs.readFileSync(path.join(v, "litestream-verify.yml"), "utf8"), /r\/x\/g9\//);
    }
  });
  it("verifyGen: an LTX file gone between list and read (L0 retention) is retried; still gone → bad", async () => {
    const GONE =
      'console.error("Error: decode database: decode header: decode header for input 16: reopen ltx file at offset 0: file does not exist");process.exit(1)';
    const run = async (goneCalls) => {
      const st = tmp();
      const v = tmp();
      mkdb(path.join(st, "state/openclaw.sqlite"), 7);
      let calls = 0;
      const logs = [];
      const r = await verifyGen({
        state: st,
        varDir: v,
        runDir: v,
        inst: "x",
        gen: 9,
        dbs: ["state/openclaw.sqlite"],
        s3: S3,
        asRoot: true,
        ocio,
        ltxGoneWaitMs: 10,
        log: (ev, x) => logs.push([ev, x.attempt]),
        spawn: (c, a, so) =>
          calls++ < goneCalls
            ? spawn(process.execPath, ["-e", GONE], { stdio: ["ignore", "pipe", "pipe"] })
            : fakeSpawn("ok")(c, a, so),
      });
      return { r, calls, logs };
    };
    const once = await run(1);
    assert.equal(once.r.ok, true, JSON.stringify(once.r));
    assert.equal(once.calls, 2);
    assert.deepEqual(once.logs, [["verify-ltx-gone-retry", 1]]);
    const twice = await run(2);
    assert.equal(twice.r.ok, true);
    assert.equal(twice.calls, 3);
    const always = await run(99);
    assert.equal(always.r.ok, false);
    assert.equal(always.r.reason, "bad");
    assert.equal(always.calls, 3); // first try + 2 retries
    assert.match(always.r.why, /reopen ltx file/);
  });

  it("N7/L5 verifyGen: two runs on one scratch dir at once both pass (one at a time)", async () => {
    const st = tmp();
    const v = tmp();
    mkdb(path.join(st, "state/openclaw.sqlite"), 7);
    mkdb(path.join(st, "agents/main/agent/openclaw-agent.sqlite"), 3);
    const run = () =>
      verifyGen({
        state: st,
        varDir: v,
        runDir: v,
        inst: "x",
        gen: 9,
        dbs: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
        s3: S3,
        asRoot: true,
        ocio,
        spawn: fakeSpawn("ok"),
      });
    const rs = await Promise.all([run(), run(), run()]);
    for (const r of rs) assert.equal(r.ok, true, JSON.stringify(r));
  });
  it("lsRestoreRun refuses -if-replica-exists", () => {
    assert.throws(() => lsRestoreRun("litestream", ["restore", "-if-replica-exists", "x"]), /forbidden/);
  });
  it("restoredTxid reads hex or number", () => {
    assert.equal(restoredTxid({ txid: "00000000000000ff" }), 255);
    assert.equal(restoredTxid({ maxTXID: 7 }), 7);
    assert.equal(restoredTxid({}), null);
  });
  it("marker check passes a good unit, fails a torn one; pending keeps good, drops bad", async () => {
    const st = tmp();
    mkdb(path.join(st, "state/openclaw.sqlite"), 3);
    fs.mkdirSync(path.join(st, "agents/a/agent"), { recursive: true });
    fs.writeFileSync(path.join(st, "agents/a/agent/openclaw-agent.sqlite"), "torn".repeat(2000));
    const ok = await markerCheck({ state: st, dbs: ["state/openclaw.sqlite"], ocio });
    assert.equal(ok.ok, true);
    const bad = await markerCheck({ state: st, dbs: ["agents/a/agent/openclaw-agent.sqlite"], ocio });
    assert.equal(bad.ok, false);
    const p = await pendingCheck({
      state: st,
      dbs: ["state/openclaw.sqlite", "agents/a/agent/openclaw-agent.sqlite"],
      ocio,
    });
    assert.deepEqual(p.keep, ["state/openclaw.sqlite"]);
    assert.deepEqual(p.lost, ["agents/a/agent/openclaw-agent.sqlite"]);
    assert.equal(fs.existsSync(path.join(st, "agents/a/agent/openclaw-agent.sqlite")), false);
    assert.equal(p.alerts[0].class, "db-lost");
  });
});
