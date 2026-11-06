// Runs the uid-1000 helpers of the runtime guard set (config-io, cron-read) as the test user.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures.mjs";

const OCIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ocio");
const run = (name, args, o = {}) => {
  const r = spawnSync(process.execPath, [path.join(OCIO, `${name}.mjs`), ...args], {
    encoding: "utf8",
    ...o,
  });
  return { code: r.status, json: JSON.parse(r.stdout.trim().split("\n").pop()) };
};

describe("ocio config-io", () => {
  const root = tmpdir("cfgio");
  const env = { ...process.env, OCIO_ALLOW: root };
  it("write then read, atomic, 0600", () => {
    const f = path.join(root, "a/openclaw.json");
    assert.equal(run("config-io", ["write", f], { input: '{"a":1}', env }).json.ok, true);
    assert.equal((fs.statSync(f).mode & 0o777).toString(8), "600");
    assert.equal(run("config-io", ["read", f], { env }).json.text, '{"a":1}');
  });
  it("refuses symlinks, hard links, paths outside the allow list and symlinked parents", () => {
    fs.writeFileSync(path.join(root, "secret"), "s");
    fs.symlinkSync(path.join(root, "secret"), path.join(root, "link.json"));
    assert.equal(run("config-io", ["read", path.join(root, "link.json")], { env }).json.ok, false);
    fs.linkSync(path.join(root, "secret"), path.join(root, "hard.json"));
    assert.equal(run("config-io", ["read", path.join(root, "hard.json")], { env }).json.error, "EUNSAFE");
    assert.equal(run("config-io", ["read", "/etc/passwd"], { env }).json.error, "EPERM");
    fs.symlinkSync("/etc", path.join(root, "etcdir"));
    assert.equal(
      run("config-io", ["read", path.join(root, "etcdir/hostname")], { env }).json.error,
      "EUNSAFE",
    );
    const w = run("config-io", ["write", path.join(root, "link.json")], { input: "x", env });
    assert.equal(w.json.ok, false);
    assert.equal(fs.readFileSync(path.join(root, "secret"), "utf8"), "s", "symlink target unchanged");
  });
});

describe("ocio cron-read", () => {
  it("busy and proactive queries; missing tables give empty lists", () => {
    const root = tmpdir("cronrd");
    const db = path.join(root, "openclaw.sqlite");
    const c = new DatabaseSync(db);
    c.exec(`CREATE TABLE cron_run_receipts (status TEXT, started_at_ms INTEGER);
      INSERT INTO cron_run_receipts VALUES ('running', 5), ('ok', 6);
      CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT);
      INSERT INTO config_machine_state VALUES ('automation-default:/s:main', '{"jobId":"j1"}'), ('other', '{}');`);
    c.close();
    assert.deepEqual(run("cron-read", [db, "busy"]).json, {
      ok: true,
      rows: [{ status: "running", started_at_ms: 5 }],
    });
    const p = run("cron-read", [db, "proactive"]).json;
    assert.equal(p.receipts.length, 1);
    assert.deepEqual(p.jobs, []);
    assert.equal(run("cron-read", [db, "drop"]).json.error, "EINVAL");
  });
});
