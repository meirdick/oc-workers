import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Litestream } from "../lib/litestream.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "state-fx", "fake-litestream.mjs");
const S3 = { endpoint: "http://127.0.0.1:1", bucket: "b", region: "auto", accessKey: "k", secretKey: "s" };
const DBS = ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"];

function mk(mode, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-"));
  const modes = Array.isArray(mode) ? [...mode] : [mode];
  const argvs = [];
  const ls = new Litestream({
    state: "/s",
    inst: "x",
    gen: 3,
    s3: S3,
    cfgPath: path.join(dir, "litestream.yml"),
    asRoot: true,
    spawn: (_c, a) => {
      argvs.push(a);
      const m = modes.length > 1 ? modes.shift() : modes[0];
      return spawn(process.execPath, [FAKE, ...a], {
        env: { ...process.env, FAKE_MODE: m },
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    ...extra,
  });
  return { ls, dir, argvs };
}
const until = async (f, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("litestream supervisor", () => {
  it("admission hold: final stop, no respawn, release starts it again once (docs/13)", async () => {
    const { ls, argvs } = mk("normal");
    const starts = [];
    ls.on("start", (e) => starts.push(e.why));
    await ls.apply(DBS);
    await new Promise((r) => setTimeout(r, 150));
    const r = await ls.hold("admit");
    assert.equal(r.clean, true);
    assert.equal(ls.pid(), 0);
    assert.equal(ls.downForMs(), 0); // planned: no fault clock
    assert.ok(ls.lag.held());
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(argvs.length, 1); // stayed down
    assert.ok(ls.release("startupz") > 0);
    assert.equal(ls.release("cap"), null); // second release is a no-op
    assert.deepEqual(starts, ["apply", "hold-release:startupz"]);
    assert.equal(argvs.length, 2);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await ls.stopFinal()).clean, true);
  });
  it("writes the config and starts replicate; final stop is clean", async () => {
    const { ls, dir, argvs } = mk("normal");
    await ls.apply(DBS);
    assert.deepEqual(argvs[0], ["replicate", "-config", path.join(dir, "litestream.yml")]);
    const y = fs.readFileSync(path.join(dir, "litestream.yml"), "utf8");
    assert.match(y, /ls-meta\/g3\//);
    assert.equal((fs.statSync(path.join(dir, "litestream.yml")).mode & 0o777).toString(8), "400");
    await new Promise((r) => setTimeout(r, 150));
    const r = await ls.stopFinal("flush");
    assert.equal(r.clean, true);
    assert.equal(r.reason, null);
  });
  it("shutdown sync failed line → not clean although exit 0 (F1.6)", async () => {
    const { ls } = mk("unclean");
    await ls.apply(DBS);
    await new Promise((r) => setTimeout(r, 150));
    const r = await ls.stopFinal();
    assert.equal(r.code, 0);
    assert.equal(r.clean, false);
    assert.equal(r.reason, "shutdown-sync-failed");
  });
  it("no exit within 10 s of SIGINT → timeout, SIGKILL, not clean", async () => {
    const { ls } = mk("hang");
    await ls.apply(DBS);
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    const r = await ls.stopFinal();
    assert.equal(r.clean, false);
    assert.equal(r.reason, "timeout");
    assert.ok(Date.now() - t0 >= 9900);
  });
  it("ltx-missing line faults the lag of that DB (F1.4)", async () => {
    const { ls } = mk("ltx-missing");
    await ls.apply(DBS);
    await until(() => ls.lag.report().some((d) => d.fault));
    const rep = Object.fromEntries(ls.lag.report().map((d) => [d.db, d]));
    assert.equal(rep["state/openclaw.sqlite"].lag, null);
    assert.equal(rep["agents/main/agent/openclaw-agent.sqlite"].lag, 0);
    await ls.stopFinal();
  });
  it("ENOSPC exit is disk-full, not replica-crash (Z0.4); restart follows", async () => {
    const { ls } = mk(["enospc", "normal"]);
    const exits = [];
    let disk = 0;
    ls.on("exit", (e) => exits.push(e.cls));
    ls.on("disk-full", () => disk++);
    await ls.apply(DBS);
    await until(() => exits.length >= 1);
    assert.equal(exits[0], "disk-full");
    assert.equal(disk, 1);
    await until(() => ls.pid() > 0, 2500); // backoff 1 s
    await ls.stopFinal();
  });
  it("crash → replica-crash with backoff 1 s, then 2 s", async () => {
    const { ls } = mk(["crash", "crash", "normal"]);
    const ev = [];
    ls.on("fault", (f) => ev.push(f));
    await ls.apply(DBS);
    await until(() => ev.length >= 2, 4000);
    assert.deepEqual(
      ev.map((e) => [e.cls, e.wait]),
      [
        ["replica-crash", 1],
        ["replica-crash", 2],
      ],
    );
    assert.ok(ls.downForMs() > 0);
    await until(() => ls.pid() > 0, 3000);
    // H15: a respawn does not stop the fault clock; it runs until UP_OK_MS of uptime.
    const d0 = ls.downForMs();
    assert.ok(d0 >= 2500, `fault clock kept across respawns: ${d0}`);
    await ls.stopFinal();
  });
  it("H15: apply of the same set during a backoff does not respawn or reset the fault clock", async () => {
    const { ls, argvs } = mk(["crash", "normal"]);
    const ev = [];
    ls.on("fault", (f) => ev.push(f));
    await ls.apply(DBS);
    await until(() => ev.length >= 1, 3000);
    const n = argvs.length;
    assert.equal(await ls.apply(DBS), 0);
    assert.equal(argvs.length, n, "no spawn from apply while the backoff timer is pending");
    assert.ok(ls.downForMs() >= 0 && ls.downSince !== null);
    await until(() => ls.pid() > 0, 2500);
    await ls.stopFinal();
  });
  it("drain: SIGTERM exit respawns at once; final stop after it is clean", async () => {
    const { ls, argvs } = mk("normal");
    await ls.apply(DBS);
    await new Promise((r) => setTimeout(r, 150));
    ls.setDraining();
    const first = ls.pid();
    process.kill(first, "SIGTERM"); // the platform's SIGTERM to every process
    await until(() => ls.pid() > 0 && ls.pid() !== first, 1000);
    assert.equal(ls.lastExit.cls, "drain-term");
    assert.equal(argvs.length, 2);
    await new Promise((r) => setTimeout(r, 150));
    const r = await ls.stopFinal("drain");
    assert.equal(r.clean, true);
  });
  it("planned set change: SIGINT, restart, 30 s hold, no fault event", async () => {
    const { ls } = mk("normal");
    const faults = [];
    ls.on("fault", (f) => faults.push(f));
    await ls.apply([DBS[0]]);
    await new Promise((r) => setTimeout(r, 100));
    const p1 = ls.pid();
    await ls.apply(DBS);
    assert.notEqual(ls.pid(), p1);
    assert.equal(ls.lag.held(), true);
    assert.equal(faults.length, 0);
    assert.equal(ls.lastExit.cls, "planned");
    await ls.stopFinal();
  });
});

describe("litestream oom class", () => {
  it("oom_kill rising in ocrt/sys → replica-oom", async () => {
    const cg = fs.mkdtempSync(path.join(os.tmpdir(), "cg-"));
    fs.writeFileSync(path.join(cg, "memory.events"), "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n");
    const { ls } = mk("normal", { cgSys: cg });
    const ex = [];
    ls.on("exit", (e) => ex.push(e.cls));
    await ls.apply(DBS);
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(path.join(cg, "memory.events"), "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n");
    process.kill(ls.pid(), "SIGKILL");
    await until(() => ex.length === 1);
    assert.equal(ex[0], "replica-oom");
    await ls.stopFinal();
  });
});

describe("admission hold and the lag clock", () => {
  it("release ends the long hold: 30 s after the release the lag rule applies again", async () => {
    let now = 1_000_000;
    const { ls } = mk("normal", { now: () => now });
    await ls.apply(DBS);
    await new Promise((r) => setTimeout(r, 150));
    await ls.hold("admit");
    now += 25_000; // the gateway reached /startupz
    ls.release("startupz");
    assert.ok(ls.lag.held());
    now += 31_000;
    assert.equal(ls.lag.held(), false); // not held for the rest of the 120 s cap
    await new Promise((r) => setTimeout(r, 150));
    await ls.stopFinal();
  });
});
