// Amend §2 row 16: 10 gateway restarts locally, p50 and max (restart request -> /startupz).
import { gatewayPid } from "../harness/flows.mjs";

export default {
  name: "gateway-restart-times",
  source: "amend §2 row 16 (M1: 10 gateway restarts locally, p50 and max)",
  rule: "10 restarts via ocsupctl restart-gateway (else gateway SIGKILL): each reaches /startupz again; report p50 and max. Pass: 10/10 back, max <= 60 s (plan §4.7 guess 40-60 s).",
  timeoutMs: 1_800_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const ms = [];
    let via = t.features.ocsupctl ? "ocsupctl" : "sigkill";
    for (let i = 0; i < 10; i++) {
      const n0 = b.ev("startupz").length;
      const k = Date.now();
      if (via === "ocsupctl") {
        const r = b.ctl("restart-gateway");
        if (!r.ok) {
          t.note(`restart-gateway: ${JSON.stringify(r)}; falling back to SIGKILL`);
          via = "sigkill";
        }
      }
      if (via === "sigkill") {
        const pid = gatewayPid(b);
        b.sh(`kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`);
      }
      const z = await b.waitEv(() => b.ev("startupz").length > n0, 180_000);
      ms.push(z ? Date.now() - k : null);
      await t.sleep(3000);
    }
    const ok = ms.filter((x) => x !== null).sort((a, c) => a - c);
    t.measure("via", via);
    t.measure("restartMs", ms);
    t.measure("p50Ms", ok[Math.floor(ok.length / 2)] ?? null);
    t.measure("maxMs", ok.at(-1) ?? null);
    t.check("10/10 restarts back at /startupz", ok.length === 10, ms);
    t.check("max <= 60 s", (ok.at(-1) ?? Infinity) <= 60_000, ok.at(-1));
  },
};
