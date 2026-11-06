// M4b N1+N2 (M4 backup drill §2.8, M4-STATUS §7 N2): a corrupt managed DB never gave SQLite evidence, so
// l5-pending never fired. Corrupt state/openclaw.sqlite under a running gateway, SIGKILL the gateway: the
// restarted gateway fails on the DB; ocsup must quick_check, exit 75 `sqlite-corrupt` with the quick_check text
// (the DO counts it and raises l5-pending), not crash-loop (exit 70) or exit doctor-required.
import { exitInfo, gateEvents, gatewayPid } from "../harness/flows.mjs";
import { writeRows } from "../harness/sqlite.mjs";

// Overwrite every page after the 100-byte file header (sqlite_schema included) with random bytes, as uid 1000.
const CORRUPT = `const fs=require("fs");const f="/home/node/.openclaw/state/openclaw.sqlite";const st=fs.statSync(f);
const fd=fs.openSync(f,"r+");const ps=4096;const n=Math.max(1,Math.floor(st.size/ps)-1);
fs.writeSync(fd,require("crypto").randomBytes(ps-100),0,ps-100,100);for(let i=1;i<=n;i++){fs.writeSync(fd,require("crypto").randomBytes(ps),0,ps,i*ps)}fs.fsyncSync(fd);fs.closeSync(fd);
try{fs.rmSync(f+"-wal",{force:true});fs.rmSync(f+"-shm",{force:true})}catch{}console.log(JSON.stringify({size:st.size,pages:n}))`;

export default {
  name: "m4b-sqlite-corrupt",
  source: "M4-STATUS §7 N1, N2; plan §9.3 l5-pending; M4 backup drill 2.8",
  rule: "Corrupt managed DB + gateway SIGKILL → ocsup exit 75 reason sqlite-corrupt, detail has quick_check text, gate exit event carries both; no exit 70 gateway-crash-loop.",
  needs: ["m1"],
  timeoutMs: 600_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    writeRows(b, 20, { tag: "c" });
    await t.sleep(3000);
    const c = b.as1000(["node", "-e", CORRUPT]);
    t.measure("corrupt", c.out.trim() || c.err.slice(-300));
    const pid = gatewayPid(b);
    const t0 = Date.now();
    b.sh(`kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`);
    const code = await b.waitExit(300_000);
    const ms = Date.now() - t0;
    const info = await exitInfo(t, b);
    const ev = b.ev("exit").at(-1);
    const gx = (await gateEvents(t, "exit")).at(-1)?.body ?? null;
    t.measure("exit", { code, ms, info, detail: ev?.detail ?? null, gateEvent: gx });
    t.measure("sqliteChecks", b.ev("sqlite-check"));
    t.measure(
      "gatewayExits",
      b.ev("gateway-exit").map((e) => ({ code: e.code, signal: e.signal, cls: e.cls })),
    );
    t.check("ocsup exited (no endless loop)", code !== null, code);
    t.check(
      "exit reason sqlite-corrupt, code 75",
      info.reason === "sqlite-corrupt" && info.code === 75,
      info,
    );
    t.check(
      "exit detail carries the quick_check text",
      /quick_check/.test(String(ev?.detail ?? "")),
      ev?.detail,
    );
    t.check(
      "gate exit event: reason + detail (DO evidence input)",
      gx?.reason === "sqlite-corrupt" && /quick_check/.test(String(gx?.detail ?? "")),
      gx,
    );
  },
};
