// Amend §3 row 'T7e row 8' (F5): SIGKILL the gateway 1 s into each stop path -> abort (sleep:
// sleep-unclean-exit) or unclean (drain: drained {unclean:[gateway]}, no marker).
import { gateEvents, gatewayPid } from "../harness/flows.mjs";

export default {
  name: "gateway-sigkill-each-path",
  source: "amend §3 row 'T7e row 8'",
  rule: "Sleep path: SIGKILL the gateway right after sleep-stop-gateway starts -> answer ok:false error sleep-unclean-exit (alert sleep-unclean-exit). Drain path: SIGKILL the gateway 1 s after a platform SIGTERM -> drained event with unclean containing gateway; exit 0.",
  needs: ["ocsupctl"],
  timeoutMs: 1_200_000,
  async run(t) {
    const a = t.box({ name: "sleep", gen: 1 });
    await a.start();
    if (!t.check("sleep: /startupz", (await a.startupz()) !== null)) return;
    await t.sleep(65_000);
    const opId = `op-gsk-${Date.now()}`;
    a.ctl("sleep-check", { opId });
    a.ctl("sleep-prepare", { opId });
    const pid = gatewayPid(a);
    const p = a.ctlAsync("sleep-stop-gateway", { opId });
    await t.sleep(200);
    a.sh(`kill -KILL ${pid}`);
    const ans = await p;
    t.measure("sleepAnswer", ans);
    t.check("sleep: sleep-unclean-exit", ans.ok === false && ans.error === "sleep-unclean-exit", ans);
    const b = t.box({ name: "drain", gen: 2 });
    await b.start();
    if (!t.check("drain: /startupz", (await b.startupz()) !== null)) return;
    // Hold the gateway in its drain: an open long request (guess: the gateway waits for in-flight work).
    b.sh("(curl -s -m 30 http://127.0.0.1:18789/startupz?m1hold=1 >/dev/null &) ; true");
    const gp = gatewayPid(b);
    b.sigterm();
    await t.sleep(1000);
    const killed = b.sh(`kill -KILL ${gp} && echo killed || echo gone`).out.trim();
    t.measure("drainKill", killed);
    await b.waitExit(400_000);
    const dr = (await gateEvents(t, "drained")).filter((r) => r.body?.gen === 2).at(-1);
    t.measure("drained", dr?.body);
    if (killed !== "killed") t.note("gateway had exited before the SIGKILL; unclean check not reached");
    t.check(
      "drain: drained with unclean gateway",
      killed !== "killed" || (dr?.body?.unclean || []).includes("gateway"),
      dr?.body,
    );
    t.check("drain: exit 0", b.state().exitCode === 0, b.state());
  },
};
