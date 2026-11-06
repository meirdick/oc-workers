#!/usr/bin/env node
// ocsupctl: CLI for the ocsup control socket (contract §8). Root only.
// Usage: ocsupctl <op> [--op-id ID] [--json '{...}'] ; sleep ops also as "sleep <phase>".
//   ocsupctl status | logs [n] | stop | stop-status | restart-gateway
//   ocsupctl sleep check|prepare|cancel|stop-gateway|flush --op-id X
//   ocsupctl resume-after-sleep --op-id X | fault "<line>"
import { OCSUPCTL_SOCK } from "./lib/contract.mjs";
import { ctlRequest } from "./lib/ctl.mjs";

const argv = process.argv.slice(2);
let op = argv.shift();
if (op === "sleep") op = `sleep-${argv.shift()}`;
const req = { op };
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--op-id") req.opId = argv[++i];
  else if (argv[i] === "--json") Object.assign(args, JSON.parse(argv[++i]));
  else if (op === "logs") args.n = Number(argv[i]);
  else if (op === "fault") args.line = argv[i];
}
if (Object.keys(args).length) req.args = args;
try {
  const res = await ctlRequest(process.env.OCSUPCTL_SOCK || OCSUPCTL_SOCK, req);
  process.stdout.write(`${JSON.stringify(res)}\n`);
  process.exit(res.ok ? 0 : res.error === "draining" ? 75 : 1);
} catch (e) {
  process.stderr.write(`ocsupctl: ${e.message}\n`);
  process.exit(2);
}
