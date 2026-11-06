#!/usr/bin/env node
// Spec 08 §21.1 coverage: every §5.2 row (T-R1..T-R58) and every §21.2 scenario (S1..S82) has a test
// whose name carries the id. Fails (exit 1) on a missing id. `it.todo` ids are listed apart and do not
// count as covered. Also checks that src/rt/machine.ts holds rows 1..58.
// Usage: node test/coverage-rows.mjs [--json]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".test.ts")) files.push(p);
  }
};
walk(here);

const want = [
  ...Array.from({ length: 58 }, (_, i) => `T-R${i + 1}`),
  ...Array.from({ length: 82 }, (_, i) => `S${i + 1}`),
];
const covered = new Map();
const todo = new Map();
// A test title: the first string or template literal after it( / it.each(...)( / it.todo( / test(.
const TITLE = /\b(it|test)(\.todo|\.each\([\s\S]*?\))?\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(TITLE)) {
    const isTodo = m[2] === ".todo";
    for (const id of m[3].match(/\b(T-R\d+|S\d+)\b/g) ?? []) {
      const into = isTodo ? todo : covered;
      into.set(id, [...(into.get(id) ?? []), f.slice(here.length + 1)]);
    }
  }
}
const missing = want.filter((id) => !covered.has(id) && !todo.has(id));
const onlyTodo = want.filter((id) => !covered.has(id) && todo.has(id));

let machine = "src/rt/machine.ts not found";
const mpath = join(here, "../src/rt/machine.ts");
if (existsSync(mpath)) {
  const ids = [...readFileSync(mpath, "utf8").matchAll(/\br\(\s*(\d+),/g)].map((m) => Number(m[1]));
  const gaps = Array.from({ length: 58 }, (_, i) => i + 1).filter((n) => !ids.includes(n));
  machine = gaps.length
    ? `machine.ts lacks rows ${gaps.join(",")}`
    : `machine.ts rows 1-58 present (${ids.length})`;
}

const out = {
  files: files.length,
  covered: want.filter((id) => covered.has(id)).length,
  total: want.length,
  todo: onlyTodo,
  missing,
  machine,
};
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`coverage: ${out.covered}/${out.total} ids have a test (${files.length} files); ${machine}`);
  if (onlyTodo.length) console.log(`todo only: ${onlyTodo.join(" ")}`);
  if (missing.length) console.log(`MISSING: ${missing.join(" ")}`);
}
process.exit(missing.length ? 1 : 0);
