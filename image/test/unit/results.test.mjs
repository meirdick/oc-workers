import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseEvents, untarOne } from "../harness/box.mjs";
import { resultsDir, statusOf, writeResult } from "../harness/results.mjs";

test("statusOf: pass needs >= 1 check and all ok; blocked and error win", () => {
  assert.equal(statusOf({ checks: [] }), "fail");
  assert.equal(statusOf({ checks: [{ ok: true }] }), "pass");
  assert.equal(statusOf({ checks: [{ ok: true }, { ok: false }] }), "fail");
  assert.equal(statusOf({ checks: [{ ok: true }], blocked: "no ocio" }), "blocked");
  assert.equal(statusOf({ checks: [], error: "x" }), "error");
});

test("writeResult writes json and a summary row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m1res-"));
  const d = resultsDir("2026-10-31", root);
  writeResult(d, {
    name: "t-a",
    checks: [{ label: "x", ok: true }],
    measured: { ms: 5 },
    image: "sha256:abc",
  });
  writeResult(d, { name: "t-b", checks: [{ label: "y", ok: false }], measured: {} });
  const s = fs.readFileSync(path.join(d, "summary.md"), "utf8");
  assert.match(s, /Pass 1, fail 1/);
  assert.match(s, /\| t-b \| fail \|.*failed: y/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "t-a.json"))).status, "pass");
  fs.rmSync(root, { recursive: true });
});

test("parseEvents keeps JSON lines with ev, skips the rest", () => {
  const t = 'noise\n{"ts":"x","t":1,"ev":"boot","pid":7}\n{"no":"ev"}\nprefix {"ev":"exit","code":0}\n';
  assert.deepEqual(
    parseEvents(t).map((e) => e.ev),
    ["boot", "exit"],
  );
});

test("untarOne reads the first tar entry body", () => {
  const body = Buffer.from("hello\n");
  const h = Buffer.alloc(512);
  h.write("f.txt", 0);
  h.write(body.length.toString(8).padStart(11, "0"), 124);
  const tar = Buffer.concat([h, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
  assert.equal(untarOne(tar).toString(), "hello\n");
});
