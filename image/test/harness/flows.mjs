// Shared flows for the M1 tests: boot, process listing, exit reason, the fake-DO sleep driver, wake.
import { exec } from "./docker.mjs";

/** Start a box and wait for /startupz. Returns {box, ms} (ms null on failure; a failed check is added). */
export async function bootUp(t, o = {}, { timeoutMs = 180_000, check = true } = {}) {
  const box = t.box(o);
  await box.start();
  const ms = await box.startupz(timeoutMs);
  if (check) t.check(`${box.name}: /startupz`, ms !== null, { ms });
  return { box, ms };
}

/** Exit {code, reason} of the last ocsup run: docker exit code + reason from the gate exit event or log. */
export async function exitInfo(t, box) {
  const s = box.state();
  const ev = box.ev("exit").at(-1);
  const recs = await t.records({ plane: "control", route: "/v1/event" });
  const gx = recs.filter((r) => r.body?.kind === "exit").at(-1);
  return { code: s.exitCode, status: s.status, reason: ev?.reason ?? gx?.body?.reason ?? null, oom: s.oom };
}

/** Gate events of one kind since the test start. */
export async function gateEvents(t, kind) {
  const recs = await t.records({ plane: "control", route: "/v1/event" });
  return recs.filter((r) => !kind || r.body?.kind === kind);
}
export async function gateAlerts(t, cls) {
  const recs = await t.records({ plane: "control", route: "/v1/alert" });
  const st = await t.gateState();
  const all = [...recs.map((r) => r.body), ...(st.alerts || [])];
  return all.filter((a) => a && (!cls || a.class === cls || a.kind === cls));
}

// /proc reader: one JSON array of {pid, ppid, pgid, sid, uid, state, comm, cmd, cg}.
const PS = `const fs=require("fs");const o=[];for(const d of fs.readdirSync("/proc")){if(!/^\\d+$/.test(d))continue;try{
const st=fs.readFileSync("/proc/"+d+"/stat","utf8");const r=st.slice(st.lastIndexOf(")")+2).split(" ");
const uid=Number(/^Uid:\\s+(\\d+)/m.exec(fs.readFileSync("/proc/"+d+"/status","utf8"))[1]);
const cmd=fs.readFileSync("/proc/"+d+"/cmdline","utf8").split("\\0").join(" ").trim().slice(0,200);
const cg=fs.readFileSync("/proc/"+d+"/cgroup","utf8").trim().split(":").pop();
o.push({pid:+d,ppid:+r[1],pgid:+r[2],sid:+r[3],uid,state:r[0],comm:st.slice(st.indexOf("(")+1,st.lastIndexOf(")")),cmd,cg})}catch{}}
console.log(JSON.stringify(o))`;
export function ps(box) {
  const r = exec(box.name, ["node", "-e", PS]);
  try {
    return JSON.parse(r.out).filter((p) => !/node -e const fs=require\("fs"\);const o=\[\]/.test(p.cmd));
  } catch {
    return [];
  }
}
export const cgProcs = (box, cg) =>
  exec(box.name, `cat /sys/fs/cgroup/ocrt/${cg}/cgroup.procs 2>/dev/null`)
    .out.split("\n")
    .filter(Boolean)
    .map(Number);

/** ocsup status file (root). */
export function statusFile(box) {
  const b = box.cat("/var/lib/ocrt/status.json");
  try {
    return JSON.parse(b.toString());
  } catch {
    return null;
  }
}
/** Gateway pid: status file, else the uid-1000 node process running openclaw gateway. */
export function gatewayPid(box) {
  const s = statusFile(box);
  if (s?.gateway?.pid) return s.gateway.pid;
  const p = ps(box).find((x) => x.uid === 1000 && /openclaw\.mjs gateway/.test(x.cmd));
  return p?.pid || 0;
}

export const opIdOf = (t, n) => `op-${t.name}-${n}-${Date.now()}`;

/**
 * Fake-DO sleep op (add §2.6 phases 1-5) through ocsupctl. abortAt: phase name after which the op aborts
 * ("check"|"prepare"|"edge"|"stop-gateway"|"flush"), or null to run to the end.
 * Returns {answers:{phase: answer}, aborted, abortAnswer, busyRetries:[{opId, retryAfterMs}]}.
 */
export async function sleepOp(
  t,
  box,
  { opId = opIdOf(t, "sleep"), abortAt = null, after = {}, checkWaitMs = 150_000, busyWaitMs = 5000 } = {},
) {
  let answers = {};
  // Phase 1 blockers (config-recent for 60 s after the boot render, seeding, ...) and a prepare `busy`
  // (add §2.6 step 2: abort, retry at retryAfterMs) make the DO retry later. Each retry is a new op id,
  // as the DO would journal a new op.
  const end = Date.now() + checkWaitMs;
  const nextOp = () => {
    opId = `${opId.replace(/-r\d+$/, "")}-r${Date.now() % 100000}`;
  };
  const busyRetries = [];
  for (;;) {
    const c = box.ctl("sleep-check", { opId });
    if (c.ok && !(c.blockers || []).length) {
      if (abortAt === "check") break;
      const t0 = Date.now();
      const p = box.ctl("sleep-prepare", { opId });
      if (p.ok && p.status === "busy" && Date.now() < end) {
        const wait = Math.max(Number(p.retryAfterMs) || 0, busyWaitMs);
        busyRetries.push({ opId, retryAfterMs: p.retryAfterMs ?? null });
        t.note(`sleep prepare busy (retryAfterMs ${p.retryAfterMs}); new op in ${wait} ms`);
        await new Promise((r) => setTimeout(r, wait));
        nextOp();
        continue;
      }
      answers = { check: c, prepare: { ...p, _ms: Date.now() - t0 } };
      break;
    }
    if (Date.now() > end || c.error === "draining" || c.error === "socket" || c.error === "no-answer") break;
    t.note(`sleep check blocked: ${JSON.stringify(c.blockers || c.error).slice(0, 200)}; retry in 5 s`);
    await new Promise((r) => setTimeout(r, 5000));
    nextOp();
  }
  const steps = [
    ["check", "sleep-check"],
    ["prepare", "sleep-prepare"],
    ["edge", null],
    ["stop-gateway", "sleep-stop-gateway"],
    ["flush", "sleep-flush"],
  ];
  for (const [phase, op] of steps) {
    if (op) {
      const t0 = Date.now();
      // check and prepare ran in the retry loop above (same op id); repeat check only to fill the answer.
      if (!(phase in answers)) answers[phase] = { ...box.ctl(op, { opId }), _ms: Date.now() - t0 };
      t.note(`sleep ${phase}: ${JSON.stringify(answers[phase]).slice(0, 300)}`);
      if (after[phase]) await after[phase](answers[phase]);
      if (!answers[phase].ok) return { answers, aborted: phase, failed: true, busyRetries };
      if (phase === "prepare" && answers.prepare.status === "busy")
        return { answers, aborted: phase, failed: true, busy: true, busyRetries };
    }
    if (abortAt === phase) {
      const before4 = ["check", "prepare", "edge"].includes(phase);
      if (phase === "check") return { answers, aborted: phase };
      const t0 = Date.now();
      const a = before4 ? box.ctl("sleep-cancel", { opId }) : box.ctl("resume-after-sleep", { opId });
      t.note(`abort after ${phase}: ${JSON.stringify(a).slice(0, 300)}`);
      return { answers, aborted: phase, abortAnswer: { ...a, _ms: Date.now() - t0 }, busyRetries };
    }
  }
  return { answers, aborted: null, busyRetries };
}

/**
 * After a full sleep op: snapshot (docker commit), destroy, and plan a marker wake on gen+1.
 * Returns {snap, marker} for wake().
 */
export function sleepSnapshot(_t, box, flushAnswer) {
  const snap = box.snapshot();
  box.sigkill();
  const marker = {
    kind: "marker",
    markerId: `mk-${Date.now()}`,
    snapshotId: snap,
    gen: box.o.gen,
    txid: flushAnswer?.txidPerDb || {},
  };
  // The DO's per-DB record from the flush answer (plan.dbs): bytes drive the seed gate (amend §1.6 S3).
  const dbs = Object.entries(flushAnswer?.bytesPerDb || {}).map(([db, bytes]) => ({
    db,
    bytes,
    lastTxid: flushAnswer?.txidPerDb?.[db] ?? 0,
    state: "uploaded",
  }));
  return { snap, marker, dbs };
}

/** Wake: a new box from the snapshot image with gen+1 and the plan given (marker or gen restore). */
export async function wake(t, prev, { snap, sqlite, dbs, name, env = {}, timeoutMs = 180_000 } = {}) {
  const gen = prev.o.gen + 1;
  const box = t.box({
    name: name || `${prev.name.split("-").pop()}w${gen}`,
    image: snap,
    gen,
    restoreGens: sqlite?.kind === "gen" ? [sqlite.gen] : sqlite?.kind === "marker" ? [sqlite.gen] : [],
    env: { OCRT_SNAPSHOT_ID: snap, ...env },
    plan: {
      rootfs: { kind: "snapshot", snapshotId: snap },
      sqlite: sqlite || { kind: "fresh" },
      ...(dbs ? { dbs } : {}),
    },
  });
  await box.start();
  const ms = await box.startupz(timeoutMs);
  return { box, ms };
}

/** Local level-0 max TXID per DB from the box's meta dirs (root read). */
export function localL0(box) {
  const r = exec(
    box.name,
    "find /var/lib/ocrt/ls-meta /home/node/.openclaw -path '*ltx/0/*.ltx' 2>/dev/null | sort",
  );
  const out = {};
  for (const f of r.out.split("\n").filter(Boolean)) {
    const m = /([0-9a-f]{16})\.ltx$/.exec(f);
    const k = f.replace(/\/ltx\/0\/.*$/, "");
    out[k] = Math.max(out[k] || 0, Number.parseInt(m?.[1] || "0", 16));
  }
  return out;
}

/**
 * Run `script` as uid 1000 inside the gateway cgroup, as agent code would be: root joins ocrt/gw/main
 * (or ocrt/gw), then drops to uid 1000 with setpriv. Returns the exec result; out ends with the cgroup.
 */
export function inGw(box, script, { detach = false } = {}) {
  // The pid of THIS shell: $$ is the top shell's pid even inside the `( ... ) &` subshell of the
  // detached form, which then left the hog outside ocrt/gw (M1 integration finding, H21).
  const join =
    "me=$(exec sh -c 'echo $PPID'); for cg in /sys/fs/cgroup/ocrt/gw/main /sys/fs/cgroup/ocrt/gw; do [ -d $cg ] && echo $me > $cg/cgroup.procs 2>/dev/null && break; done; cat /proc/self/cgroup";
  const cmd = `${join}; exec setpriv --reuid=1000 --regid=1000 --init-groups -- sh -c '${script.replace(/'/g, "'\\''")}'`;
  if (detach) return exec(box.name, ["sh", "-c", `(${cmd}) >/dev/null 2>&1 &`]);
  return exec(box.name, ["sh", "-c", cmd]);
}

/** Wait until the fake ReplicaGate recorded a level-0 upload for (gen, db) newer than `after`. Returns ms or null. */
export async function waitL0(t, gen, { db = "state/openclaw.sqlite", after = 0, timeoutMs = 60_000 } = {}) {
  const k = Date.now();
  while (Date.now() - k < timeoutMs) {
    const u = (await t.gateState()).uploads?.[gen]?.[db];
    if (u?.l0MaxTxid > 0 && (u.lastWriteAt || 0) >= after) return Date.now() - k;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
