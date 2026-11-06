// ocio lsmeta: long-lived watcher of Litestream's local level-0 dirs (amend §1.5 F1.5).
// Litestream runs as uid 1000, so its meta dirs are uid-1000 trees; root does not read them.
// stdin: JSON lines {dirs:{<rel>: <meta dir>}} (replaces the set). stdout: {t, txid:{<rel>: n}} each
// interval when a value changed, and at least every 30 s. argv: [intervalMs=1000]
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, out } from "./_common.mjs";

ignoreTerm();
const iv = Number(process.argv[2] || 1000);
let dirs = {};
let last = "";
let lastAt = 0;
const L0 = /^[0-9a-f]{16}-([0-9a-f]{16})\.ltx$/;
function max(dir) {
  try {
    let m = 0;
    for (const n of fs.readdirSync(path.join(dir, "ltx", "0"))) {
      const x = L0.exec(n);
      if (x) m = Math.max(m, Number.parseInt(x[1], 16));
    }
    return m;
  } catch {
    return 0;
  }
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i = buf.indexOf("\n");
  while (i >= 0) {
    try {
      dirs = JSON.parse(buf.slice(0, i)).dirs || {};
      last = "";
    } catch {}
    buf = buf.slice(i + 1);
    i = buf.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0)); // parent gone
setInterval(() => {
  const txid = Object.fromEntries(Object.entries(dirs).map(([rel, d]) => [rel, max(d)]));
  const s = JSON.stringify(txid);
  if (s !== last || Date.now() - lastAt > 30_000) {
    last = s;
    lastAt = Date.now();
    out({ t: Date.now(), txid });
  }
}, iv);
