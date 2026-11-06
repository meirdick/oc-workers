// Lock step (plan §4.4; followups/lock-on-restore.md; scope §1.1 "Hostname and lock"; M0 fix:
// 2026.10.9 gateway exits 1 at once on a fresh foreign owner, ocsup waits and reclaims; amend §2
// row 19: gateway exit 78 = doctor-required at once). Pure parts here; I/O through deps.

export const HEARTBEAT_RECLAIM_MS = 95_000; // 2026.10.9: owner dead at 90 s heartbeat age (+5 s)
export const LOCK_WAIT_CAP_MS = 120_000;

/**
 * Classify lock owners seen in $STATE (sidecar files and the gateway-owner lease row).
 * seen: {files:[{ns, ageMs}], lease:[{owner:{processNamespace}, heartbeatAgeMs}]}
 * me: {host, bootId, pidNs}. Returns none | dead:samehost-newboot | same:pid-check | unknown.
 */
export function classifyOwners(seen, me) {
  const owners = [
    ...(seen?.files || []).map((f) => f.ns),
    ...(seen?.lease || []).map((l) => l.owner?.processNamespace),
  ].filter(Boolean);
  if (!owners.length) return "none";
  const sameHost = owners.every((n) => n.host === me.host);
  const sameBoot = owners.every((n) => n.identity === me.bootId);
  const sameNs = owners.every((n) => String(n.pidNsInode) === String(me.pidNs));
  if (sameHost && !sameBoot) return "dead:samehost-newboot";
  if (sameHost && sameBoot && sameNs) return "same:pid-check";
  return "unknown";
}

/** Newest heartbeat age among the owners (ms), or null. */
export function newestHeartbeatAge(seen) {
  const ages = [
    ...(seen?.files || []).map((f) => f.ageMs),
    ...(seen?.lease || []).map((l) => l.heartbeatAgeMs),
  ].filter((a) => Number.isFinite(a));
  return ages.length ? Math.min(...ages) : null;
}

/**
 * Decide the lock action. cls from classifyOwners; lockMode from the plan; recoverLock = the
 * release has `gateway recover-lock`. Returns {action: none|recover-lock|wait|blocked, waitMs?}.
 */
export function lockAction(cls, { lockMode = "auto", recoverLock = false, ageMs = null } = {}) {
  if (cls === "none" || cls === "dead:samehost-newboot" || cls === "same:pid-check" || lockMode === "none")
    return { action: "none" };
  const canRecover = recoverLock && (lockMode === "auto" || lockMode === "recover-lock");
  if (canRecover) return { action: "recover-lock" };
  if (lockMode === "recover-lock") return { action: "blocked", why: "recover-lock not in this release" };
  const waitMs = Math.max(0, HEARTBEAT_RECLAIM_MS - (ageMs ?? 0));
  return { action: "wait", waitMs: Math.min(waitMs, LOCK_WAIT_CAP_MS) };
}

// Gateway lock refusal on 2026.10.9 (LS1 log): "holder 7 at <host>/pid-ns <n>, last renewed 10 s ago. wait 80 s and retry"
const LOCK_WAIT_RE = /wait (\d+(?:\.\d+)?) ?s and retry/i;
const LOCK_TEXT_RE = /gateway lock|GatewayLockError|state owner|owner heartbeat|already running/i;
const MAINT_RE = /gateway\.maintenance_required|maintenance_required/;

/**
 * Class of a gateway exit (plan §4.7, amend §2 row 19). tail = last stderr/stdout lines.
 * Returns {kind: doctor-required|lock-wait|heap-abort|signal|crash|clean, waitMs?}.
 *  - exit 78 or maintenance_required text: doctor-required (ocsup exits 78 at once).
 *  - exit 1 with a lock text in the first 120 s: lock-wait (not a crash; wait then start again).
 */
export function gatewayExitClass({ code, signal, tail = "", uptimeMs = Infinity }) {
  if (code === 78 || MAINT_RE.test(tail)) return { kind: "doctor-required" };
  if (code === 0 && !signal) return { kind: "clean" };
  if (code === 134 || signal === "SIGABRT") return { kind: "heap-abort" };
  if (code === 1 && uptimeMs < 120_000 && (LOCK_WAIT_RE.test(tail) || LOCK_TEXT_RE.test(tail))) {
    const m = LOCK_WAIT_RE.exec(tail);
    const waitMs = m
      ? Math.min(Math.ceil(Number(m[1]) * 1000) + 2000, LOCK_WAIT_CAP_MS)
      : HEARTBEAT_RECLAIM_MS;
    return { kind: "lock-wait", waitMs };
  }
  // M4b N3: a gateway that dies on a full disk is not a crash loop (no exit 70, no restart from a snapshot).
  if (DISK_FULL_RE.test(tail)) return { kind: "disk-full" };
  if (signal) return { kind: "signal" };
  return { kind: "crash" };
}
const DISK_FULL_RE =
  /ENOSPC|EDQUOT|no space left on device|disk quota exceeded|SQLITE_FULL|database or disk is full/i;

/** Node script run as uid 1000 that prints the lock files and the lease row (read-only). */
export const LOCK_READER = `
const fs=require("fs"),p=require("path");const st=process.argv[1];const out={files:[],lease:null};
const d=p.join(st,"tmp","openclaw-1000");
try{for(const f of fs.readdirSync(d)){if(!f.endsWith(".lock"))continue;const s=fs.lstatSync(p.join(d,f));
let j=null;try{j=JSON.parse(fs.readFileSync(p.join(d,f),"utf8"))}catch{}
out.files.push({f,ageMs:Date.now()-s.mtimeMs,pid:j?.pid,ns:j?.processNamespace})}}catch(e){out.dirErr=e.code}
const db=p.join(st,"state","openclaw.sqlite");
if(fs.existsSync(db)){try{const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(db,{readOnly:true});
const r=c.prepare("select payload_json,heartbeat_at from state_leases where scope='gateway-owner'").all();
out.lease=r.map(x=>{let o=null;try{o=JSON.parse(x.payload_json).owner}catch{};return{heartbeatAgeMs:Date.now()-Number(x.heartbeat_at),owner:o}});c.close()}catch(e){out.leaseErr=String(e.message||e).slice(0,200)}}
console.log(JSON.stringify(out));`;

/**
 * Run the lock step. deps: {readOwners() -> seen, me, hasRecoverLock() -> bool, recoverLock() -> {ok},
 * sleep(ms), stopped() -> bool, log}. Returns {cls, action, ok, reason?, ms}.
 */
export async function runLockStep(lockMode, deps) {
  const t0 = Date.now();
  const seen = await deps.readOwners();
  const cls = classifyOwners(seen, deps.me);
  const recover = cls === "unknown" ? await deps.hasRecoverLock() : false;
  const a = lockAction(cls, { lockMode, recoverLock: recover, ageMs: newestHeartbeatAge(seen) });
  const res = { cls, action: a.action, ok: true, seen };
  if (a.action === "recover-lock") {
    const r = await deps.recoverLock();
    if (!r.ok) Object.assign(res, { ok: false, reason: "lock-blocked", detail: r.detail });
  } else if (a.action === "blocked") Object.assign(res, { ok: false, reason: "lock-blocked", detail: a.why });
  else if (a.action === "wait") {
    res.waitMs = a.waitMs;
    deps.log?.("lock-wait", { waitMs: a.waitMs });
    const end = Date.now() + a.waitMs;
    while (Date.now() < end && !deps.stopped?.()) await deps.sleep(Math.min(250, end - Date.now()));
  }
  res.ms = Date.now() - t0;
  return res;
}
