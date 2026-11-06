// Drill backup-prune (scope M4 exit "every prune leaves ≥ 1 verified copy per class"; plan §6.3).
// Classes with a prune: archives (ctl/archives.ts runArchiveGc: 8 newest, daily 14 d, weekly 8 w, delete only
// below a newer verified copy), gens (ctl/gc.ts runGc: newest verified, newest 3, daily, current, pinned,
// create-before-delete), creds history (newest 20 versions per path). Shadows and snapshots have no prune in
// the Worker (reported, not asserted). Steps: dry-run plans, read back the newest archive (verify), run archive
// GC and gen GC twice, then check what is left.
// env: U, T. usage: node run.mjs
import { archives, credsManifest, iso, note, now, ops, rawFile, result, status } from "../backup/lib.mjs";

const KEY = "backup-prune";
rawFile(KEY);
const t0 = now();
const before = await archives(200);
const credsBefore = await credsManifest();
const genPlanBefore = (await ops("GET", "/ops/gc")).json;
const arPlanDry = (await ops("POST", "/ops/archive/gc?dry=1")).json;
const verify = (await ops("POST", "/ops/archive/verify")).json;
note("verify", verify);
const arRun1 = (await ops("POST", "/ops/archive/gc")).json;
const arRun2 = (await ops("POST", "/ops/archive/gc")).json;
const genRun1 = (await ops("POST", "/ops/gc")).json;
const genRun2 = (await ops("POST", "/ops/gc")).json;
note("gc", { arRun1: arRun1?.deleted, arRun2: arRun2?.deleted, genRun1, genRun2 });
const after = await archives(200);
const genPlanAfter = (await ops("GET", "/ops/gc")).json;
const credsAfter = await credsManifest();
const s = await status();

const done = (l) => (l.archives ?? []).filter((x) => x.state === "complete");
const verified = (l) => done(l).filter((x) => x.verified_at);
const nv = verified(after)[0] ?? null;
const deleted = (after.archives ?? []).filter((x) => x.state === "deleted");
const deletedNewerThanVerified = nv ? deleted.filter((x) => x.created_at >= nv.created_at) : deleted;
const keptGens = (genPlanAfter?.keep ?? []).map((k) => k.gen);
const credPathsBefore = new Set((credsBefore.files ?? []).map((f) => f.path));
const credPathsAfter = new Set((credsAfter.files ?? []).map((f) => f.path));
result(KEY, {
  window: { from: iso(t0), to: iso(now()) },
  archives: {
    completeBefore: done(before).length,
    verifiedBefore: verified(before).length,
    completeAfter: done(after).length,
    verifiedAfter: verified(after).length,
    newestVerified: nv ? { id: nv.id, by: nv.verified_by, created: iso(nv.created_at) } : null,
    dryRun: {
      delete: arPlanDry?.plan?.delete ?? arPlanDry?.delete,
      newestVerified: arPlanDry?.plan?.newestVerified,
    },
    verify,
    run1Deleted: arRun1?.deleted ?? null,
    run2Deleted: arRun2?.deleted ?? null,
    keep: (arRun1?.plan?.keep ?? []).map((k) => `${k.id}:${k.why.join("+")}`),
  },
  gens: {
    planBefore: genPlanBefore,
    run1: genRun1,
    run2: genRun2,
    keepAfter: genPlanAfter?.keep,
    current: s.gen?.gen,
  },
  creds: {
    pathsBefore: credPathsBefore.size,
    pathsAfter: credPathsAfter.size,
    seqBefore: credsBefore.seq,
    seqAfter: credsAfter.seq,
  },
  noPrune: ["shadows (s/<inst>/ in R2)", "snapshots (registry, M6)"],
  checks: {
    archiveVerifiedLeft: verified(after).length >= 1,
    noDeleteAtOrAboveNewestVerified: deletedNewerThanVerified.length === 0,
    archivesPruned: (arRun1?.deleted ?? []).length > 0 || done(before).length <= 9,
    gcIdempotent: (arRun2?.deleted ?? []).length === 0,
    genKeepsCurrent: keptGens.includes(s.gen?.gen),
    // §6.2 gen verify probe: a gen reaches `verified` only through Control genVerify().
    genVerifiedLeft: (genPlanAfter?.keep ?? []).some((k) => k.why.includes("newest-verified")),
    genCompleteLeft: (genPlanAfter?.keep ?? []).some((k) =>
      k.why.some((w) => /newest|verified|current/.test(w)),
    ),
    credsEveryLivePathKept: [...credPathsBefore].every((p) => credPathsAfter.has(p)),
  },
});
