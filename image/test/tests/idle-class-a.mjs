// Amend §2 row 9: 4 idle managed DBs for 10 min: R2 class A <= 15/min (guess target), counted at the fake
// ReplicaGate (Put, multipart, List). l0-retention-check-interval: 5m is in the rendered config.
import { IP } from "../harness/env.mjs";
import { writeRows } from "../harness/sqlite.mjs";

/** Bytes stored under a prefix in SeaweedFS (anonymous S3 list, harness only). {db: bytes}. */
async function storedByDb(prefix) {
  const out = {};
  let token = "";
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
    if (token) q.set("continuation-token", token);
    const x = await (await fetch(`http://${IP.s3}:8333/oc-host-m1?${q}`)).text();
    for (const m of x.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
      const db = m[1].slice(prefix.length).split("/").slice(0, -2).join("/");
      out[db] = (out[db] || 0) + Number(m[2]);
    }
    token = /<NextContinuationToken>([^<]+)</.exec(x)?.[1] || "";
    if (!token) break;
  }
  return out;
}

const CLASS_A = new Set([
  "PutObject",
  "CreateMultipartUpload",
  "UploadPart",
  "CompleteMultipartUpload",
  "ListObjectsV2",
]);
const MIN = Number(process.env.OCM1_IDLE_MIN || 10);

export default {
  name: "idle-class-a",
  source: "amend §2 row 9 (M1: 4 idle DBs, 10 min, class A <= 15/min)",
  rule: `State DB + 3 agent DBs, ${MIN} min with no writes after a 60 s settle: class A ops at ReplicaGate <= 15/min; rendered litestream.yml has l0-retention-check-interval: 5m.`,
  needs: ["m1"],
  timeoutMs: (MIN + 10) * 60_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    for (const a of ["i1", "i2", "i3"])
      writeRows(b, 3, { db: `agents/${a}/agent/openclaw-agent.sqlite`, tag: a });
    await t.sleep(60_000);
    t.check(
      "l0-retention-check-interval: 5m rendered",
      /l0-retention-check-interval:\s*5m/.test(b.sh("cat /run/ocrt/litestream.yml").out),
    );
    const st0 = await t.gateState();
    t.measure("dbs", Object.keys(st0.uploads?.[1] || {}));
    const since = st0.seq;
    await t.sleep(MIN * 60_000);
    const recs = (await t.records({ since, plane: "replica" })).filter((r) => CLASS_A.has(r.route));
    const byOp = {};
    for (const r of recs) byOp[r.route] = (byOp[r.route] || 0) + 1;
    const perMin = recs.length / MIN;
    t.measure("classAPerMin", Number(perMin.toFixed(2)));
    t.measure("byOp", byOp);
    // Where the ops go: route + DB (key or list prefix, without the gen root and file name).
    const byDb = {};
    for (const r of recs) {
      const k = String(r.key || r.prefix || "").split("/");
      const db =
        k
          .slice(3)
          .filter((x) => !/^\d{4}$|\.ltx$/.test(x))
          .join("/") || "(root)";
      byDb[`${r.route} ${db}`] = (byDb[`${r.route} ${db}`] || 0) + 1;
    }
    t.measure("byDb", byDb);
    t.check(
      "4 managed DBs replicated",
      Object.keys(st0.uploads?.[1] || {}).length === 4,
      Object.keys(st0.uploads?.[1] || {}),
    );
    t.check("class A <= 15/min", perMin <= 15, perMin);
    t.measure(
      "levels",
      /levels:[\s\S]*?interval: (\S+)/.exec(b.sh("cat /run/ocrt/litestream.yml").out)?.[1] ?? null,
    );
    // Per-gen storage factor (amend §2 row 10): bytes stored in r/m1/g1/<db>/ over the DB file size.
    const sizes = Object.fromEntries(
      b
        .sh(
          "cd /home/node/.openclaw && stat -c '%n %s' state/openclaw.sqlite agents/*/agent/openclaw-agent.sqlite",
        )
        .out.split("\n")
        .filter(Boolean)
        .map((l) => [l.split(" ")[0], Number(l.split(" ")[1])]),
    );
    const stored = await storedByDb("r/m1/g1/");
    const dbBytes = Object.values(sizes).reduce((a, x) => a + x, 0);
    const genBytes = Object.values(stored).reduce((a, x) => a + x, 0);
    t.measure("storage", {
      dbBytes: sizes,
      genBytes: stored,
      factor: dbBytes ? Number((genBytes / dbBytes).toFixed(2)) : null,
      atMin: Math.round((Date.now() - b.startedAt) / 60_000),
    });
  },
};
