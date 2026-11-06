// Harness probe (not an exit test): what gateway.suspend.prepare answers in an ocsup box, called
// directly as uid 1000. Explains a `busy` from ocsupctl sleep-prepare (ocsup does not log the answer).
import { waitL0 } from "../harness/flows.mjs";
import { writeRows } from "../harness/sqlite.mjs";

const TOKEN = "m1testtoken0123456789abcdef";
const call = (b, method, params) => {
  const r = b.as1000(
    `cd /home/node && node /app/openclaw.mjs gateway call ${method} --params '${JSON.stringify(params)}' --json --timeout 15000 2>&1`,
    { env: { OPENCLAW_GATEWAY_PASSWORD: TOKEN }, timeoutMs: 30_000 },
  );
  try {
    return JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    return { raw: r.out.slice(-600), code: r.code };
  }
};

export default {
  name: "_probe-prepare",
  source: "harness probe",
  rule: "record suspend.prepare answers at +0, +30, +60 s after the first L0; resume each with its suspensionId",
  needs: ["ocsupctl"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    writeRows(b, 20, { tag: "p" });
    t.measure("firstL0Ms", await waitL0(t, 1));
    for (const at of [0, 30, 60]) {
      if (at) await t.sleep(30_000);
      const p = call(b, "gateway.suspend.prepare", { requestId: `probe-${at}`, terminalPolicy: "preserve" });
      t.measure(`prepare+${at}`, p);
      const sid = p.suspensionId ?? p.result?.suspensionId;
      if (sid) t.measure(`resume+${at}`, call(b, "gateway.suspend.resume", { suspensionId: sid }));
    }
    const viaCtl = b.ctl("sleep-check", { opId: "probe-op" });
    t.measure("ctlCheck", viaCtl);
    t.measure("ctlPrepare", b.ctl("sleep-prepare", { opId: "probe-op" }));
    t.check("probe ran", true);
  },
};
