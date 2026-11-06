// reap() (plan §4.2 "Reap rule"; scope §1.1 row "Reap and helpers"; amendment row 22).
// Kills the gateway tree and every uid-1000 process that is not a tracked helper.
// - Zombies (state Z) are skipped: they hold no memory and no socket; tini reaps them.
// - D-state (uninterruptible) pids already have SIGKILL pending; they count only at the D cap.
// - setsid daemons from agent code: still in ocrt/gw (cgroup.kill) or found by the uid scan.
import { cgroupKill, procsDeep } from "./cgroups.mjs";
import { listening, listProcs, proc } from "./procs.mjs";
import { sleep, sysPaths } from "./sysfs.mjs";

export const REAP_DEFAULTS = Object.freeze({
  capMs: 10_000, // plan §4.2 step 1 and 2
  dCapMs: 30_000, // guess: extra time for D-state pids before reap-failed:dstate
  listenCapMs: 5_000,
  port: 18789,
  uid: 1000,
});

/**
 * Pick the pids to kill: uid 1000, not tracked, not a zombie. Returns {kill, dstate, zombies}.
 * tracked = Set of pids (lib/ocio-run.mjs `tracked`: own children, so a pid is not reused before
 * Node reaps it) or of "pid:starttime" identities (procs.mjs identity()). Both forms are accepted.
 */
export function selectVictims(procs, tracked, uid = 1000) {
  const kill = [];
  const dstate = [];
  const zombies = [];
  for (const p of procs) {
    if (p.uid !== uid) continue;
    if (tracked.has(p.pid) || tracked.has(`${p.pid}:${p.starttime}`)) continue;
    if (p.state === "Z" || p.state === "X") zombies.push(p.pid);
    else {
      kill.push(p.pid);
      if (p.state === "D") dstate.push(p.pid);
    }
  }
  return { kill, dstate, zombies };
}

/**
 * Run reap(). deps: {gwDir, tracked: () => Set, kill(pid, sig), paths, now}. Returns
 * {ok, reason?, killed, zombies, dstate, ms}. reason: reap-failed:cgroup|uid1000|dstate|listen.
 * The caller maps a failure to exit 70 (plan §4.2 step 4).
 */
export async function reap(why, deps = {}) {
  const o = { ...REAP_DEFAULTS, ...deps };
  const p = sysPaths(deps.paths);
  const kill = deps.kill || ((pid, sig) => process.kill(pid, sig));
  const tracked = deps.tracked ? deps.tracked() : new Set();
  const t0 = Date.now();
  const r = { why, ok: true, killed: 0, zombies: 0, dstate: 0 };
  const isZombie = (pid) => {
    const s = proc(pid, p);
    return !s || s.state === "Z" || s.state === "X";
  };
  // 1. cgroup.kill on ocrt/gw, wait until no live pid is left (cap 10 s).
  if (o.gwDir) {
    const ck = await cgroupKill(o.gwDir, { capMs: o.capMs, isZombie });
    r.cgroupKill = { written: ck.written, ms: ck.ms };
    if (!ck.ok) {
      const d = ck.left.filter((pid) => proc(pid, p)?.state === "D");
      if (d.length < ck.left.length) return done({ ok: false, reason: "reap-failed:cgroup", left: ck.left });
    }
  }
  // 2. SIGKILL every untracked uid-1000 pid until none is left. Non-D cap 10 s; D cap 30 s.
  for (;;) {
    const v = selectVictims(listProcs(p), tracked, o.uid);
    r.zombies = v.zombies.length;
    r.dstate = v.dstate.length;
    if (!v.kill.length) break;
    const age = Date.now() - t0;
    const nonD = v.kill.length - v.dstate.length;
    if (nonD > 0 && age > o.capMs) return done({ ok: false, reason: "reap-failed:uid1000", left: v.kill });
    if (nonD === 0 && age > o.dCapMs) return done({ ok: false, reason: "reap-failed:dstate", left: v.kill });
    for (const pid of v.kill) {
      try {
        kill(pid, "SIGKILL");
        r.killed++;
      } catch {}
    }
    await sleep(50);
  }
  // 3. No LISTEN socket on the gateway port (TIME_WAIT and others are ignored).
  const lend = Date.now() + o.listenCapMs;
  while (listening(o.port, p) && Date.now() < lend) await sleep(100);
  if (listening(o.port, p)) return done({ ok: false, reason: "reap-failed:listen" });
  return done({});

  function done(x) {
    Object.assign(r, x, { ms: Date.now() - t0 });
    return r;
  }
}

/**
 * After the gateway pid exits: SIGTERM every pid left in ocrt/gw (spawn-broker, codex app-server
 * have own pgids), wait up to 5 s for them to go (amendment row 22). The caller runs reap() next.
 */
export async function termGatewayTree(gwDir, deps = {}) {
  const kill = deps.kill || ((pid, sig) => process.kill(pid, sig));
  const p = sysPaths(deps.paths);
  const cap = deps.capMs ?? 5_000;
  const t0 = Date.now();
  const live = () =>
    procsDeep(gwDir).filter((pid) => {
      const s = proc(pid, p);
      return s && s.state !== "Z" && s.state !== "X";
    });
  const first = live();
  for (const pid of first) {
    try {
      kill(pid, "SIGTERM");
    } catch {}
  }
  let left = first;
  while (left.length && Date.now() - t0 < cap) {
    await sleep(100);
    left = live();
  }
  return { signalled: first.length, left: left.length, ms: Date.now() - t0 };
}
