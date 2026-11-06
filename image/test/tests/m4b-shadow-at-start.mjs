// M4b C1 (M4-STATUS §7 C1, §5 row 5): the 15 min shadow timer started at each ocsup start, so a crash loop
// with lives < 15 min never shadowed non-managed SQLite. Rule: the clock counts from plan.shadowAt (the
// Control DO's newest shadow upload), and a round runs at each gateway start when that is older than 15 min.
// Box a: make a non-managed DB, SIGKILL (no shadow). Box b from a's rootfs, plan.shadowAt null: a shadow PUT
// within 90 s of /startupz. Box c from the same rootfs, plan.shadowAt = 1 min ago: no PUT in 90 s.
import { writeRows } from "../harness/sqlite.mjs";

const S = "/home/node/.openclaw";
const FIX = `mkdir -p ${S}/workspace/m4b && node -e 'const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1]);c.exec("create table r(id integer primary key, body text)");const i=c.prepare("insert into r(body) values(?)");for(let n=0;n<100;n++)i.run("r"+n);c.close();console.log("ok")' ${S}/workspace/m4b/notes.sqlite`;

export default {
  name: "m4b-shadow-at-start",
  source: "M4-STATUS §7 C1; plan §6.1 row 5",
  rule: "Restart from a rootfs with a non-managed DB: plan.shadowAt null → shadow PUT within 90 s of /startupz; plan.shadowAt 60 s old → no PUT in 90 s.",
  needs: ["m1", "shadow"],
  timeoutMs: 900_000,
  async run(t) {
    const a = t.box({ name: "a", gen: 1 });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz()) !== null)) return;
    writeRows(a, 5, { tag: "a" });
    t.check("fixture written", /ok/.test(a.as1000(FIX).out));
    await t.sleep(3000);
    a.sigkill();
    await a.waitExit(30_000);
    const snap = a.snapshot();
    const boot = async (name, gen, shadowAt) => {
      const since = (await t.gateState()).seq;
      const b = t.box({
        name,
        image: snap,
        gen,
        restoreGens: [1],
        env: { OCRT_SNAPSHOT_ID: snap },
        plan: {
          rootfs: { kind: "snapshot", snapshotId: snap },
          sqlite: { kind: "gen", gen: 1 },
          restoreGens: [1],
          shadowAt,
        },
      });
      await b.start();
      const up = await b.startupz(240_000);
      const t0 = Date.now();
      let put = null;
      while (Date.now() - t0 < 90_000 && put === null) {
        const recs = await t.records({ since });
        const s = recs.filter(
          (r) => /^\/v1\/shadow\//.test(r.route || "") && /notes/.test(decodeURIComponent(r.route)),
        );
        if (s.length) put = Date.now() - t0;
        else await t.sleep(2000);
      }
      t.measure(`${name}.shadowPutMsAfterStartupz`, put);
      t.measure(
        `${name}.shadowLog`,
        b.ev("shadow-backup").map((e) => ({ why: e.why, n: e.n })),
      );
      b.rm();
      return { up, put };
    };
    const b = await boot("b", 2, null);
    t.check("b: /startupz", b.up !== null);
    t.check("b (shadowAt null): shadow PUT within 90 s of /startupz", b.put !== null, b.put);
    const c = await boot("c", 3, Date.now() - 60_000);
    t.check("c: /startupz", c.up !== null);
    t.check("c (shadowAt 60 s old): no shadow PUT in 90 s", c.put === null, c.put);
  },
};
