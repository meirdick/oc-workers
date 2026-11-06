// Scope §4 M1 row 8 (part 2) [Z2.5]; amend §3 (ptrace_scope dropped): a uid-1000 reader cannot read
// /proc/<gateway>/environ or /proc/<ocio>/mem; auth.password is not in openclaw.json.
import { gatewayPid, ps } from "../harness/flows.mjs";

export default {
  name: "environ-and-mem-unreadable",
  source: "scope §4 M1 row 8 [Z2.5]; amend §3 row 'T2 item 6'",
  rule: "As uid 1000: reading /proc/<gateway>/environ and /proc/<ocio helper>/{environ,mem} fails (EACCES/EPERM); the gateway and ocio helpers are non-dumpable; openclaw.json has no auth.password value. ptrace attach is not tested (no ptrace binary in the image; amend §3 asks for a test-image binary).",
  needs: ["m1", "credsync"],
  timeoutMs: 300_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1, env: { OC_M1_SECRET_PROBE: "m1-should-not-leak" } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(3000);
    const gw = gatewayPid(b);
    const ocio = ps(b).filter((p) => p.uid === 1000 && /ocio/.test(p.cmd));
    t.measure("pids", { gateway: gw, ocio: ocio.map((p) => p.pid) });
    const tryRead = (f) => b.as1000(`head -c 64 ${f} >/dev/null 2>&1 && echo READ || echo DENIED`).out.trim();
    t.check(
      "gateway environ unreadable",
      gw > 0 && tryRead(`/proc/${gw}/environ`) === "DENIED",
      tryRead(`/proc/${gw}/environ`),
    );
    const dumpGw = b.sh(`grep -c . /proc/${gw}/environ >/dev/null; stat -c %U /proc/${gw}/environ`).out;
    t.measure("gatewayEnvironOwner", dumpGw);
    if (t.check("ocio helper found", ocio.length > 0)) {
      for (const p of ocio.slice(0, 3)) {
        t.check(`ocio ${p.pid} mem unreadable`, tryRead(`/proc/${p.pid}/mem`) === "DENIED");
        t.check(`ocio ${p.pid} environ unreadable`, tryRead(`/proc/${p.pid}/environ`) === "DENIED");
      }
    }
    const cfg = b.as1000("cat /home/node/.openclaw/openclaw.json 2>/dev/null").out;
    let pw = null;
    try {
      pw = JSON.parse(cfg)?.gateway?.auth?.password ?? null;
    } catch {}
    t.check(
      "openclaw.json has no auth.password",
      pw === null && !/"password"\s*:\s*"[^"]/.test(cfg),
      pw ? "present" : null,
    );
  },
};
