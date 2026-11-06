// oom_score_adj policy (scope §1.1 row "PID 1 and cgroups"; M0 T2 item 5: root can set -900,
// uid 1000 cannot lower its own value).
import { writeText } from "./sysfs.mjs";

export const OOM_ADJ = Object.freeze({
  tini: -1000,
  ocsup: -900,
  litestream: -800, // plan §4.2: below every uid-1000 child, above ocsup
  ocio: 0,
  cli: 300, // CLI children: doctor, validate, plugins install, cron status, backup
  gateway: 500, // children inherit it
});

/** The value for a role. Throws on an unknown role, so a typo never runs at the default 0. */
export function oomFor(role) {
  if (!(role in OOM_ADJ)) throw new Error(`oom: unknown role ${role}`);
  return OOM_ADJ[role];
}

/** Set tini (pid 1) and ocsup (self). Returns the write results. */
export function applySupervisorOom(procRoot = "/proc") {
  return {
    tini: writeText(`${procRoot}/1/oom_score_adj`, OOM_ADJ.tini),
    ocsup: writeText(`${procRoot}/self/oom_score_adj`, OOM_ADJ.ocsup),
  };
}

/**
 * Shell lines for a spawn wrapper (run as root before the uid drop): join a cgroup, set
 * oom_score_adj, ignore SIGTERM (SIG_IGN survives exec; scope §1.1 row "Signals").
 */
export function spawnPrelude({ cg, role, ignoreTerm } = {}) {
  const pre = [];
  if (cg) pre.push(`echo $$ > ${cg}/cgroup.procs 2>/dev/null || true`);
  if (role) pre.push(`echo ${oomFor(role)} > /proc/self/oom_score_adj 2>/dev/null || true`);
  if (ignoreTerm) pre.push("trap '' TERM");
  return pre;
}
