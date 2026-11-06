// N11 (M4b): sleep-read leaves the job classes of plan.wakeIgnore out of nextWakeAtMs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const OCIO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ocio");

test("N11 sleep-read: heartbeat and Proactive check jobs ignored per wakeIgnore; other jobs still wake", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "m4b-wf-"));
  const db = path.join(d, "s.sqlite");
  const c = new DatabaseSync(db);
  c.exec("CREATE TABLE cron_jobs (job_id TEXT, enabled INTEGER, job_json TEXT, state_json TEXT)");
  const now = 1_793_500_000_000;
  const add = (id, job, next) =>
    c
      .prepare("INSERT INTO cron_jobs VALUES (?, 1, ?, ?)")
      .run(id, JSON.stringify(job), JSON.stringify({ nextRunAtMs: next }));
  add("heartbeat:main", { payload: { kind: "heartbeat" }, schedule: { kind: "every" } }, now + 30 * 60_000);
  add("a1b2", { name: "Proactive check (main)", schedule: { kind: "cron" } }, now + 60 * 60_000);
  add("c3d4", { name: "Memory Dreaming Promotion", schedule: { kind: "cron" } }, now + 5 * 3600_000);
  c.close();
  const read = (ignore) =>
    JSON.parse(
      execFileSync(process.execPath, [
        path.join(OCIO, "sleep-read.mjs"),
        db,
        String(now),
        ...(ignore ? [JSON.stringify(ignore)] : []),
      ]),
    );
  assert.equal(read(null).nextWakeAtMs, now + 30 * 60_000); // old ocsup: no list, every job wakes
  const a = read(["heartbeat"]);
  assert.equal(a.nextWakeAtMs, now + 60 * 60_000);
  assert.deepEqual(
    a.ignored.map((x) => [x.id, x.cls]),
    [["heartbeat:main", "heartbeat"]],
  );
  assert.equal(read(["heartbeat", "proactive"]).nextWakeAtMs, now + 5 * 3600_000);
});
