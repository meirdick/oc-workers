import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { identity, listening, parseStat } from "../lib/procs.mjs";
import { reap, selectVictims, termGatewayTree } from "../lib/reaper.mjs";
import { addProc, put, rmProc, tcpLine, tmpdir } from "./fixtures.mjs";

const P = (pid, uid, state, starttime = 1000 + pid) => ({ pid, uid, state, starttime });

describe("reaper", () => {
  it("parseStat handles a comm with spaces and parens", () => {
    const s = parseStat("42 (a b) c)) S 1 42 42 0 -1 0 0 0 0 0 5 6 7 8 20 0 1 0 999 0 0\n");
    assert.equal(s.comm, "a b) c)");
    assert.equal(s.state, "S");
    assert.equal(s.ppid, 1);
    assert.equal(s.starttime, 999);
  });

  it("selectVictims: uid 1000 only, skips tracked and zombies, marks D", () => {
    const procs = [P(1, 0, "S"), P(10, 1000, "S"), P(11, 1000, "Z"), P(12, 1000, "D"), P(13, 1000, "S")];
    const v = selectVictims(procs, new Set(["13:1013"]));
    assert.deepEqual(v.kill, [10, 12]);
    assert.deepEqual(v.dstate, [12]);
    assert.deepEqual(v.zombies, [11]);
  });

  it("tracked pids (numbers) are exempt too", () => {
    assert.deepEqual(selectVictims([P(13, 1000, "S")], new Set([13])).kill, []);
  });

  it("a tracked identity with a reused pid is not exempt", () => {
    const v = selectVictims([P(13, 1000, "S", 5555)], new Set(["13:1013"]));
    assert.deepEqual(v.kill, [13]);
  });

  it("reap kills a setsid daemon, ignores a zombie and TIME_WAIT, keeps a tracked helper", async () => {
    const proc = tmpdir();
    addProc(proc, 1, { uid: 0, comm: "tini" });
    addProc(proc, 50, { uid: 1000, sid: 50, ppid: 1, comm: "daemon" }); // setsid orphan
    addProc(proc, 51, { uid: 1000, state: "Z" });
    addProc(proc, 60, { uid: 1000, comm: "litestream" });
    put(proc, "net/tcp", `  sl local rem st\n${tcpLine(18789, "06")}`);
    put(proc, "net/tcp6", "  sl local rem st\n");
    const killed = [];
    const r = await reap("test", {
      paths: { proc },
      tracked: () => new Set([identity(60, { proc })]),
      kill: (pid, sig) => {
        killed.push([pid, sig]);
        rmProc(proc, pid);
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(killed, [[50, "SIGKILL"]]);
    assert.equal(r.zombies, 1);
    assert.ok(fs.existsSync(`${proc}/60`));
  });

  it("reap fails reap-failed:uid1000 at the cap and reap-failed:listen on a LISTEN socket", async () => {
    const proc = tmpdir();
    addProc(proc, 70, { uid: 1000 });
    put(proc, "net/tcp", "x\n");
    const r = await reap("t", { paths: { proc }, capMs: 120, kill: () => {} });
    assert.equal(r.reason, "reap-failed:uid1000");
    const proc2 = tmpdir();
    put(proc2, "net/tcp6", `x\n${tcpLine(18789, "0A")}`);
    assert.equal(listening(18789, { proc: proc2 }), true);
    const r2 = await reap("t", { paths: { proc: proc2 }, listenCapMs: 100 });
    assert.equal(r2.reason, "reap-failed:listen");
  });

  it("D-state pids wait for the longer D cap", async () => {
    const proc = tmpdir();
    addProc(proc, 80, { uid: 1000, state: "D" });
    put(proc, "net/tcp", "x\n");
    setTimeout(() => rmProc(proc, 80), 250); // leaves D, dies
    const r = await reap("t", { paths: { proc }, capMs: 100, dCapMs: 2000, kill: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    addProc(proc, 81, { uid: 1000, state: "D" });
    const r2 = await reap("t", { paths: { proc }, capMs: 50, dCapMs: 150, kill: () => {} });
    assert.equal(r2.reason, "reap-failed:dstate");
  });

  it("termGatewayTree SIGTERMs every pid left in ocrt/gw", async () => {
    const root = tmpdir();
    const proc = `${root}/proc`;
    addProc(proc, 90, { uid: 1000, comm: "spawn-broker" });
    addProc(proc, 91, { uid: 1000, comm: "codex" });
    put(root, "gw/main/cgroup.procs", "90\n91\n");
    const sigs = [];
    const r = await termGatewayTree(`${root}/gw`, {
      paths: { proc },
      kill: (pid, sig) => {
        sigs.push([pid, sig]);
        rmProc(proc, pid);
      },
    });
    assert.deepEqual(sigs, [
      [90, "SIGTERM"],
      [91, "SIGTERM"],
    ]);
    assert.equal(r.left, 0);
  });
});
