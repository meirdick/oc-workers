// Scope §4 M1 header: M1 runs on 2026.9.36 and 2026.10.9. One fresh boot + drain on each.
import { exitInfo } from "../harness/flows.mjs";
import { probeCount, restoreRows, writeRows } from "../harness/sqlite.mjs";

export default {
  name: "boot-both-releases",
  source: "scope §4 M1 '(local Docker, 2026.9.36 and 2026.10.9)'",
  rule: "Per release image: /startupz; 20 rows; platform SIGTERM -> exit 0; restore of the gen has the 20 rows.",
  images: ["2026.9.36"],
  timeoutMs: 900_000,
  async run(t) {
    const imgs = [
      ["2026.10.9", t.image],
      ["2026.9.36", t.images.v936?.tag],
    ];
    let gen = 1;
    for (const [rel, img] of imgs) {
      if (!img) {
        t.note(`${rel}: no image built`);
        continue;
      }
      const b = t.box({ name: rel.replace(/\./g, ""), image: img, gen });
      await b.start();
      const ms = await b.startupz(240_000);
      t.measure(`${rel}.startupzMs`, ms);
      if (!t.check(`${rel}: /startupz`, ms !== null, ms === null ? await exitInfo(t, b) : { ms })) continue;
      writeRows(b, 20, { tag: rel });
      await t.sleep(12_000);
      b.sigterm();
      await b.waitExit(300_000);
      t.check(`${rel}: exit 0`, b.state().exitCode === 0, await exitInfo(t, b));
      const rr = restoreRows(img, gen, {});
      t.check(`${rel}: restore has 20 rows`, probeCount(rr, rel) === 20, rr.probe);
      gen++;
    }
  },
};
