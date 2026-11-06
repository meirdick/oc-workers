#!/usr/bin/env node
// Copy the Worker and image sources into cli/templates/ for the npm package (deploy.ts sourceRoot). Tests, results
// and node_modules stay out. Run by `npm pack` (prepack); templates/ is not in git.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(cli, "..");
const out = join(cli, "templates");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const skip = (p) =>
  /(^|\/)(node_modules|test|tests|results|\.wrangler|dist|local|live|\.claude)(\/|$)/.test(p);
const copy = (from, to) =>
  cpSync(join(repo, from), join(out, to ?? from), {
    recursive: true,
    filter: (src) => !skip(src.slice(repo.length + 1)),
  });

copy("worker/src");
copy("worker/scripts/code-version.mjs");
copy("worker/package.json");
for (const f of ["Dockerfile", "probe.sh", "README.md", "native", "plugins", "sandbox"]) copy(`image/${f}`);
copy("image/ocrt"); // ocrt/test is skipped by the filter
process.stdout.write(`templates: ${out}\n`);
