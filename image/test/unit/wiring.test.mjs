import assert from "node:assert/strict";
import { test } from "node:test";
import { reachable, wiringFeatures } from "../harness/wiring.mjs";

const files = {
  "ocsup.mjs": 'import { main } from "./lib/main.mjs";',
  "lib/main.mjs":
    'import { a } from "./guard.mjs";\nconst ops = { "shadow-backup": 1 };\nimport("./shadow.mjs");',
  "lib/guard.mjs": 'import { m } from "./memwatch.mjs";',
  "lib/memwatch.mjs": "",
  "lib/shadow.mjs": 'import { c } from "../lib/contract.mjs";',
  "lib/contract.mjs": "",
  "lib/credsync.mjs": "",
  "lib/faults.mjs": 'export const FAULT_CMDS = ["kill-gateway"];',
};

test("reachable follows static, dynamic and ../ imports", () => {
  assert.deepEqual([...reachable(files)].sort(), [
    "lib/contract.mjs",
    "lib/guard.mjs",
    "lib/main.mjs",
    "lib/memwatch.mjs",
    "lib/shadow.mjs",
    "ocsup.mjs",
  ]);
});

test("a present but unimported module is not wired", () => {
  const f = wiringFeatures(files);
  assert.equal(f.credsync, false);
  assert.equal(f.memwatch, true);
  assert.equal(f.shadow, true);
  assert.equal(f.guardBoot, false);
  assert.equal(f.configRender, false);
  assert.equal(f.heapFault, false);
});

test("heap fault seen in FAULT_CMDS", () => {
  const f = wiringFeatures({ ...files, "lib/faults.mjs": 'export const FAULT_CMDS = ["heap"];' });
  assert.equal(f.heapFault, true);
});

test("missing entry gives nothing wired", () => {
  assert.equal(reachable({}).size, 0);
});
