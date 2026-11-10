// `ochost import` in the container: ocio import apply (merge rules, idempotence, link safety) and lib/importer.mjs
// (download check, ocio and cron calls, the done report).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createImporter, cronArgs } from "../lib/importer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OCIO = path.join(HERE, "..", "ocio", "import.mjs");
const run = (o) =>
  JSON.parse(spawnSync(process.execPath, [OCIO, "apply", JSON.stringify(o)], { encoding: "utf8" }).stdout);

/** tar.gz of {rel: content} (plus symlinks {rel: {link}}) like the CLI builds. */
function bundle(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "imp-src-"));
  for (const [rel, v] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof v === "string") fs.writeFileSync(p, v);
    else fs.symlinkSync(v.link, p);
  }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imp-tgz-")), "b.tgz");
  const r = spawnSync("tar", ["-czf", out, "-C", d, "."]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

function setup(existing = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "imp-state-"));
  const ws = path.join(state, "workspace");
  for (const [rel, v] of Object.entries(existing)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), v);
  }
  return { state, ws, stage: path.join(state, ".ochost-import-stage-t1") };
}

test("apply: add missing, keep the install's, replace only listed files (old in backup), remove BOOTSTRAP.md", () => {
  const { ws, stage } = setup({ "AGENTS.md": "new default", "notes.md": "install's own", "BOOTSTRAP.md": "ritual" });
  const archive = bundle({ "AGENTS.md": "old agents", "notes.md": "old notes", "memory/2026-01-31.md": "m" });
  const r = run({ archive, workspace: ws, stage, id: "t1", overwrite: ["AGENTS.md"], remove: ["BOOTSTRAP.md"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    [r.added, r.same, r.replaced, r.kept, r.removed],
    [1, 0, 1, 1, 1],
  );
  assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), "old agents");
  assert.equal(fs.readFileSync(path.join(ws, "notes.md"), "utf8"), "install's own");
  assert.equal(fs.readFileSync(path.join(ws, "memory/2026-01-31.md"), "utf8"), "m");
  assert.equal(fs.existsSync(path.join(ws, "BOOTSTRAP.md")), false);
  const bk = path.join(ws, ".ochost-import/t1/backup");
  assert.equal(fs.readFileSync(path.join(bk, "AGENTS.md"), "utf8"), "new default");
  assert.equal(fs.readFileSync(path.join(bk, "BOOTSTRAP.md"), "utf8"), "ritual");
  assert.deepEqual(r.lists.kept, ["notes.md"]);
  assert.equal(fs.existsSync(stage), false);
  assert.ok(fs.existsSync(path.join(ws, ".ochost-import/t1/result.json")));

  // Second run: nothing changes (idempotent), and the backup keeps the first default.
  const r2 = run({ archive, workspace: ws, stage, id: "t1", overwrite: ["AGENTS.md"], remove: ["BOOTSTRAP.md"] });
  assert.deepEqual([r2.added, r2.same, r2.replaced, r2.removed], [0, 2, 0, 0]);
  assert.equal(r2.kept, 1);
  assert.equal(fs.readFileSync(path.join(bk, "AGENTS.md"), "utf8"), "new default");

  // A later edit of a replaced bootstrap file survives a rerun under a new id.
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "edited by the agent");
  const r3 = run({ archive, workspace: ws, stage, id: "t1b", overwrite: ["AGENTS.md"] });
  assert.deepEqual([r3.replaced, r3.kept], [0, 2]);
  assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), "edited by the agent");
});

test("apply: links in the bundle and a symlinked dir in the workspace are skipped, never followed", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "imp-out-"));
  const { ws, stage } = setup({});
  fs.mkdirSync(ws, { recursive: true });
  fs.symlinkSync(outside, path.join(ws, "linked"));
  const archive = bundle({ "evil": { link: "/etc/passwd" }, "linked/x.md": "x", "ok.md": "ok" });
  const r = run({ archive, workspace: ws, stage, id: "t2", overwrite: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 2);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.lstatSync(path.join(ws, "evil"), { throwIfNoEntry: false }), undefined);
});

test("apply: a new file that differs only in case from one there is skipped (openclaw backup refuses twins)", () => {
  const { ws, stage } = setup({ "reports/a.csv": "a" });
  const archive = bundle({ "reports/A.csv": "b", "reports/other.csv": "c" });
  const r = run({ archive, workspace: ws, stage, id: "t4", overwrite: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.added, r.skipped], [1, 1]);
  assert.match(r.lists.skipped[0].why, /^case-collision/);
  assert.deepEqual(fs.readdirSync(path.join(ws, "reports")).sort(), ["a.csv", "other.csv"]);
});

test("apply: a bad id or a broken archive fails cleanly", () => {
  const { ws, stage } = setup({});
  assert.equal(run({ archive: "/nope", workspace: ws, stage, id: "Bad id" }).ok, false);
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imp-bad-")), "b.tgz");
  fs.writeFileSync(bad, "not a tar");
  const r = run({ archive: bad, workspace: ws, stage, id: "t3" });
  assert.equal(r.ok, false);
  assert.match(r.error, /^tar/);
});

test("cronArgs: one argv per job, --opt=value so values never read as flags", () => {
  const a = cronArgs({
    key: "import:sunday-reflection",
    name: "sunday-reflection",
    cron: "0 14 * * 0",
    tz: "UTC",
    message: "--help me reflect",
    session: "isolated",
    agent: "main",
    enabled: false,
    timeoutSeconds: 120,
    announce: { channel: "telegram", to: "42" },
  });
  assert.deepEqual(a, [
    "cron",
    "add",
    "--declaration-key=import:sunday-reflection",
    "--name=sunday-reflection",
    "--cron=0 14 * * 0",
    "--message=--help me reflect",
    "--session=isolated",
    "--json",
    "--tz=UTC",
    "--agent=main",
    "--disabled",
    "--timeout-seconds=120",
    "--announce",
    "--channel=telegram",
    "--to=42",
  ]);
  assert.ok(cronArgs({ key: "k", name: "n", cron: "* * * * *", message: "m", enabled: true }).includes("--no-deliver"));
});

test("importer: download checked by size and sha256, ocio apply, cron add per job, done reported once", async () => {
  const varDir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-var-"));
  const data = Buffer.from("bundle-bytes");
  const sha = createHash("sha256").update(data).digest("hex");
  const calls = { ocio: [], cli: [], done: [] };
  const gate = {
    fetchRaw: async (route) => {
      assert.match(route, /^\/v1\/import\/bundle\?id=seed-[12]$/);
      return new Response(data, { status: 200 });
    },
    call: async (m, route, body) => {
      calls.done.push({ m, route, body });
      return { ok: true };
    },
  };
  const imp = createImporter({
    gate,
    state: "/st",
    varDir,
    ocio: async (n, a) => {
      calls.ocio.push([n, JSON.parse(a[1])]);
      assert.equal(fs.readFileSync(JSON.parse(a[1]).archive, "utf8"), "bundle-bytes");
      return { json: { ok: true, added: 3, same: 0, replaced: 1, kept: 0, removed: 1, lists: { kept: [], replaced: ["AGENTS.md"], removed: ["BOOTSTRAP.md"] } } };
    },
    cli: async (args) => {
      calls.cli.push(args);
      return { code: args.includes("--name=bad") ? 1 : 0, out: "{}" };
    },
    ready: () => true,
  });
  const req = {
    id: "seed-1",
    sha256: sha,
    bytes: data.length,
    overwrite: ["AGENTS.md"],
    remove: ["BOOTSTRAP.md"],
    cron: [{ key: "import:a", name: "a", cron: "0 1 * * *", message: "m", enabled: true }],
  };
  assert.equal(imp.kick(req), true);
  assert.equal(imp.kick(req), false); // busy
  await imp.wait();
  assert.equal(imp.kick(req), false); // answered this boot
  assert.equal(calls.ocio[0][0], "import");
  assert.deepEqual(calls.ocio[0][1].remove, ["BOOTSTRAP.md"]);
  assert.equal(calls.ocio[0][1].workspace, "/st/workspace");
  assert.equal(calls.cli[0][0], "/app/openclaw.mjs");
  assert.equal(calls.done[0].route, "/v1/import/done");
  assert.equal(calls.done[0].body.ok, true);
  assert.equal(calls.done[0].body.result.workspace.added, 3);
  assert.deepEqual(fs.readdirSync(varDir), []); // bundle removed

  // A wrong digest never reaches ocio and reports a failure.
  const bad = createImporter({ gate, state: "/st", varDir, ocio: async () => assert.fail("no ocio"), cli: async () => ({ code: 0 }), ready: () => true });
  bad.kick({ ...req, id: "seed-2", sha256: "0".repeat(64) });
  await bad.wait();
  const last = calls.done.at(-1);
  assert.equal(last.body.ok, false);
  assert.match(last.body.why, /^bundle:/);
});
