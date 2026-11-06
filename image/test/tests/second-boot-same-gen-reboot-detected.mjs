// Scope §4 M1 last-but-one row; plan §6.2 step 1 [Q0.3]: a second /v1/boot with a new iid on the same gen
// -> reboot-detected -> ocsup exits 75 auto-restart, no gateway.
import { exitInfo } from "../harness/flows.mjs";

export default {
  name: "second-boot-same-gen-reboot-detected",
  source: "scope §4 M1 'second /v1/boot ... reboot-detected'; contract §2 /v1/boot",
  rule: "Box 2 on the gen of box 1 (new ocsup, new iid): the fake answers {status:reboot-detected}; ocsup exits 75 auto-restart; no gateway-start.",
  timeoutMs: 400_000,
  async run(t) {
    const a = t.box({ name: "a", gen: 7 });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz()) !== null)) return;
    a.sigkill();
    await a.waitExit(30_000);
    const snap = a.snapshot();
    const b = t.box({ name: "b", image: snap, gen: 7 });
    await b.start();
    const s = await b.waitExit(180_000);
    const ex = await exitInfo(t, b);
    const boots = (await t.records({ plane: "control", route: "/v1/boot" })).map((r) => ({
      iid: r.body?.iid,
      res: r.res?.status,
    }));
    t.measure("boots", boots);
    t.check(
      "fake answered reboot-detected to a second iid",
      boots.some((x) => x.res === "reboot-detected"),
      boots,
    );
    t.check("exit 75 auto-restart", !!s && ex.code === 75 && ex.reason === "auto-restart", ex);
    t.check("no gateway start", b.ev("gateway-start").length === 0);
  },
};
