#!/usr/bin/env node
// Print CODE_VERSION: sha256 over the sorted Runtime DO, gate and core sources (spec 08 §2.2).
// Usage: node scripts/code-version.mjs            -> hex
//        node scripts/code-version.mjs --define   -> __CODE_VERSION__:"<hex>" for wrangler --define
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../src/", import.meta.url).pathname;
const dirs = ["rt", "gates", "core"];
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|mjs|js)$/.test(n) && !n.startsWith("fake-")) files.push(p);
  }
};
for (const d of dirs) walk(join(root, d));
files.sort();
const h = createHash("sha256");
for (const f of files) {
  h.update(relative(root, f));
  h.update("\0");
  h.update(readFileSync(f));
  h.update("\0");
}
const hex = h.digest("hex");
process.stdout.write(process.argv.includes("--define") ? `__CODE_VERSION__:"${hex}"\n` : `${hex}\n`);
