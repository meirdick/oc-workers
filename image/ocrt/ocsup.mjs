// ocsup: in-container supervisor (plan §4). PID chain: /usr/bin/tini -s -- /usr/local/bin/node
// --max-old-space-size=256 /opt/ocrt/ocsup.mjs (root). Rules live in lib/*.mjs; wiring in lib/main.mjs;
// contract in lib/contract.mjs (docs/07-gate-contract.md).
// First: root's PATH has no uid-1000 dir (F-SEC-1). Imports below run no spawn at load time.
import { hardenPath } from "./lib/bins.mjs";
import { main } from "./lib/main.mjs";

hardenPath();
main().catch((e) => {
  process.stderr.write(`ocsup main-error ${String(e?.stack || e).slice(0, 2000)}\n`);
  process.exit(70);
});
