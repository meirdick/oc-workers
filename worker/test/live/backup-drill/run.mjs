// Drill backup-drill (plan §1 F1, §6.1 row 7: monthly restore drill into a throw-away DO; ctl/drill.ts).
// 1. The automatic drill: after the first complete archive the Control DO alarm runs the drill on its own
//    (drillLast set with no owner call; the archive gets verified_by "drill").
// 2. Owner drill: POST /ops/archive/drill restores the newest archive into `drill:<inst>:<ts>`, checks the
//    files, the workspace and the SQLite header, wipes the throw-away DO, and marks the archive verified.
// 3. Owner drill of a named older archive (archiveId) works the same.
// 4. Unknown archive id → no drill (409 "no complete archive"), plus an alert drill-failed.
// env: U, T. usage: node run.mjs
import { archives, iso, note, now, ops, rawFile, result, ring } from "../backup/lib.mjs";

const KEY = "backup-drill";
rawFile(KEY);
const t0 = now();
const a0 = await archives(50);
const auto = a0.drill;
const autoArchive = (a0.archives ?? []).find((x) => x.id === auto?.archiveId);
note("auto", { auto, autoArchive });
const r1 = await ops("POST", "/ops/archive/drill", {});
note("owner", r1.json);
const older = (a0.archives ?? []).filter((x) => x.state === "complete").at(-1);
const r2 = older ? await ops("POST", "/ops/archive/drill", { archiveId: older.id }) : null;
note("named", r2?.json);
const r3 = await ops("POST", "/ops/archive/drill", { archiveId: "20990101T000000Z-nosuch00" });
note("unknown", { status: r3.status, body: r3.json });
const a1 = await archives(50);
const v = (id) => (a1.archives ?? []).find((x) => x.id === id);
const ev = (await ring(t0)).filter((e) => e.src === "drill" || e.kind === "archive-verified");
const al = ((await ops("GET", "/ops/alerts")).json?.alerts ?? []).filter((x) => x.class === "drill-failed");
const rep = (r) =>
  r?.json
    ? {
        ok: r.json.ok,
        archiveId: r.json.archiveId,
        instance: r.json.instance,
        why: r.json.why,
        report: r.json.report,
      }
    : null;
result(KEY, {
  auto: auto ? { at: iso(auto.at), ok: auto.ok, archiveId: auto.archiveId, report: auto.report } : null,
  autoVerifiedBy: autoArchive?.verified_by ?? null,
  owner: rep(r1),
  ownerMs: r1.ms,
  named: rep(r2),
  unknown: { status: r3.status, body: r3.json },
  ring: ev.map((e) => ({ at: iso(e.at), src: e.src, kind: e.kind, d: e.d })),
  drillFailedAlert: al.map((x) => ({ detail: x.detail, count: x.count })),
  checks: {
    autoRan: !!auto && auto.ok === true && autoArchive?.verified_by === "drill",
    ownerOk: r1.status === 200 && r1.json?.ok === true,
    ownerVerified: !!v(r1.json?.archiveId)?.verified_at,
    throwAwayInstance: /^drill:[^:]+:\d+$/.test(r1.json?.instance ?? ""),
    sqliteHeaderOk:
      (r1.json?.report?.dbs ?? []).length > 0 && r1.json.report.dbs.every((d) => d.headerOk !== false),
    namedOk: !r2 || (r2.status === 200 && r2.json?.archiveId === older.id),
    unknownRefused: r3.status === 409 && r3.json?.ok === false,
  },
});
