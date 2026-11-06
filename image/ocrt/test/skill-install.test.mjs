// D14: ocio skill-install puts the shipped SKILL.md into the workspace; refuses symlinked dirs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OCIO = path.join(HERE, "..", "ocio", "skill-install.mjs");
const SRC = path.join(HERE, "..", "skills", "oc-host-cloudflare", "SKILL.md");
const run = (o) =>
  JSON.parse(spawnSync(process.execPath, [OCIO, JSON.stringify(o)], { encoding: "utf8" }).stdout);

test("shipped skill names the gate and the limits", () => {
  const s = fs.readFileSync(SRC, "utf8");
  assert.match(s, /^name: oc-host-cloudflare$/m);
  for (const w of ["15.0.0.3", "429", "cloudflare-docs", "/caps"]) assert.ok(s.includes(w), w);
});

test("installs, is idempotent, repairs an edit", () => {
  const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skill-")), "workspace");
  const o = { src: SRC, workspace: ws, name: "oc-host-cloudflare" };
  assert.deepEqual(run(o), { ok: true, changed: true });
  const dest = path.join(ws, "skills", "oc-host-cloudflare", "SKILL.md");
  assert.equal(fs.readFileSync(dest, "utf8"), fs.readFileSync(SRC, "utf8"));
  assert.deepEqual(run(o), { ok: true, changed: false });
  fs.writeFileSync(dest, "x");
  assert.deepEqual(run(o), { ok: true, changed: true });
  assert.equal(fs.readFileSync(dest, "utf8"), fs.readFileSync(SRC, "utf8"));
});

test("a symlinked skills dir is refused", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skill-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
  fs.symlinkSync(elsewhere, path.join(ws, "skills"));
  const r = run({ src: SRC, workspace: ws, name: "oc-host-cloudflare" });
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
