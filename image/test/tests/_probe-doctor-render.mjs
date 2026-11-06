// Probe (M6 polish live): boot on the polish install's config, then a second boot of the same state
// with runDoctor; print Doctor's exit and output tail. Config doc from OCM1_DOC (a JSON file).
import fs from "node:fs";

export default {
  name: "_probe-doctor-render",
  source: "M6 polish live: doctor-failed code 78 after a digest change",
  rule: "Boot 1 no Doctor, /startupz, SIGTERM; boot 2 from the snapshot with runDoctor: report Doctor.",
  timeoutMs: 900_000,
  async run(t) {
    const doc = JSON.parse(fs.readFileSync(process.env.OCM1_DOC, "utf8"));
    await t.ctl("/_ctl/config", { ver: 1, doc });
    const a = t.box({ name: "a", gen: 1, plan: { configVer: 1 } });
    await a.start();
    const ms = await a.startupz(400_000);
    t.measure("a startupz", ms);
    a.sigterm();
    await a.waitExit(400_000);
    const snap = a.snapshot();
    const b = t.box({
      name: "b",
      image: snap,
      gen: 2,
      plan: { rootfs: { kind: "snapshot", snapshotId: snap }, runDoctor: true, configVer: 1 },
    });
    await b.start();
    const ms2 = await b.startupz(400_000);
    const d = b.ev("doctor");
    t.measure("doctor", d);
    t.measure("exit", b.ev("exit"));
    t.check("b /startupz", ms2 !== null, { ms2 });
  },
};
