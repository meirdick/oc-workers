// Scope §4 M1 row 5 (part 2): a killed credsync watcher respawns and reconciles (plan §4.2, §4.10).
import { ps } from "../harness/flows.mjs";

const isWatcher = (p) => p.uid === 1000 && /ocio/.test(p.cmd) && /cred/i.test(p.cmd);
export default {
  name: "creds-watcher-respawn",
  source: "scope §4 M1 'A killed watcher respawns and reconciles'; plan §4.2 helper supervision",
  rule: "SIGKILL the credsync ocio watcher; write a cred while it is down; a new watcher pid appears within 5 s and the cred reaches the fake store (reconcile scan).",
  needs: ["m1", "ocio", "credsync"],
  timeoutMs: 300_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(3000);
    const w0 = ps(b).filter(isWatcher);
    t.measure(
      "watchers",
      w0.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 80) })),
    );
    if (!t.check("credsync watcher found", w0.length >= 1)) return;
    const since = (await t.gateState()).seq;
    const k = Date.now();
    b.sh(`kill -KILL ${w0.map((p) => p.pid).join(" ")}`);
    b.as1000(
      `mkdir -p /home/node/.openclaw/credentials/m1 && printf '{"r":1}' > /home/node/.openclaw/credentials/m1/while-down.json`,
    );
    let w1 = [];
    while (Date.now() - k < 10_000) {
      w1 = ps(b).filter((p) => isWatcher(p) && !w0.some((o) => o.pid === p.pid));
      if (w1.length) break;
      await t.sleep(100);
    }
    const respawnMs = w1.length ? Date.now() - k : null;
    t.measure("respawnMs", respawnMs);
    t.check("new watcher within 5 s", respawnMs !== null && respawnMs <= 5000, respawnMs);
    let hit = null;
    while (!hit && Date.now() - k < 40_000) {
      hit = (await t.records({ since, plane: "control", route: "/v1/creds/" })).find((x) =>
        /while-down/.test(x.route),
      );
      if (!hit) await t.sleep(250);
    }
    t.measure("reconcileMs", hit ? hit.ts - k : null);
    t.check("cred written while down reaches the store", !!hit);
  },
};
