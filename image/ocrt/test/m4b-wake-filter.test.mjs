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

test("wakeHours: a heartbeat tick outside the active hours does not wake; the first tick inside does", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "m4b-wh-"));
  const db = path.join(d, "s.sqlite");
  const c = new DatabaseSync(db);
  c.exec("CREATE TABLE cron_jobs (job_id TEXT, enabled INTEGER, job_json TEXT, state_json TEXT)");
  const H = 3_600_000;
  const now = Date.UTC(2026, 10, 12, 21, 30); // 21:30 UTC
  const hb = (everyMs) => ({
    name: "heartbeat-main",
    payload: { kind: "heartbeat" },
    schedule: { kind: "every", everyMs },
  });
  const add = (id, job, next) =>
    c
      .prepare("INSERT INTO cron_jobs VALUES (?, 1, ?, ?)")
      .run(id, JSON.stringify(job), JSON.stringify({ nextRunAtMs: next }));
  add("hb", hb(2 * H), Date.UTC(2026, 10, 12, 23, 15)); // next tick 23:15: outside 08-22
  add("dream", { name: "Memory Dreaming Promotion", schedule: { kind: "cron" } }, Date.UTC(2026, 10, 14, 3, 0));
  c.close();
  const read = (hours, at = now) =>
    JSON.parse(
      execFileSync(process.execPath, [
        path.join(OCIO, "sleep-read.mjs"),
        db,
        String(at),
        "[]",
        ...(hours ? [JSON.stringify(hours)] : []),
      ]),
    );
  // No hours (older plan): the raw next tick wakes.
  assert.equal(read(null).nextWakeAtMs, Date.UTC(2026, 10, 12, 23, 15));
  // 08-22 UTC: 23:15, 01:15, ... 07:15 are skipped; 09:15 next day is the first tick inside.
  const a = read({ heartbeat: { from: 8, to: 22, tz: "UTC" } });
  assert.equal(a.nextWakeAtMs, Date.UTC(2026, 10, 13, 9, 15));
  assert.deepEqual(a.moved, [
    { id: "hb", cls: "heartbeat", from: Date.UTC(2026, 10, 12, 23, 15), to: Date.UTC(2026, 10, 13, 9, 15) },
  ]);
  // The zone counts: 23:15 UTC is 15:15 in Los Angeles, inside the window.
  assert.equal(
    read({ heartbeat: { from: 8, to: 22, tz: "America/Los_Angeles" } }).nextWakeAtMs,
    Date.UTC(2026, 10, 12, 23, 15),
  );
  // A stale next tick (the install slept through it) is moved forward before the window check.
  const later = Date.UTC(2026, 10, 13, 10, 0);
  assert.equal(read({ heartbeat: { from: 8, to: 22, tz: "UTC" } }, later).nextWakeAtMs, Date.UTC(2026, 10, 13, 11, 15));
  // A bad window never hides other jobs.
  assert.equal(
    read({ heartbeat: { from: 5, to: 5, tz: "UTC" } }).nextWakeAtMs,
    Date.UTC(2026, 10, 14, 3, 0),
  );
});

test("wakeHours hardening: many heartbeat-like rows with a tiny interval cost little and never hide other jobs", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "m4b-wb-"));
  const db = path.join(d, "s.sqlite");
  const c = new DatabaseSync(db);
  c.exec("CREATE TABLE cron_jobs (job_id TEXT, enabled INTEGER, job_json TEXT, state_json TEXT)");
  const now = Date.UTC(2026, 10, 12, 23, 30); // outside 08-22 UTC
  const ins = c.prepare("INSERT INTO cron_jobs VALUES (?, 1, ?, ?)");
  c.exec("BEGIN");
  for (let i = 0; i < 1500; i++)
    ins.run(
      `heartbeat-x${i}`,
      JSON.stringify({ name: `heartbeat-x${i}`, payload: { kind: "heartbeat" }, schedule: { kind: "every", everyMs: 1 } }),
      JSON.stringify({ nextRunAtMs: now + i }),
    );
  ins.run(
    "real",
    JSON.stringify({ name: "Report", schedule: { kind: "cron" } }),
    JSON.stringify({ nextRunAtMs: now + 3 * 3_600_000 }),
  );
  ins.run(
    "hb",
    JSON.stringify({ name: "heartbeat-main", payload: { kind: "heartbeat" }, schedule: { kind: "every", everyMs: 7_200_000 } }),
    JSON.stringify({ nextRunAtMs: now + 60_000 }),
  );
  c.exec("COMMIT");
  c.close();
  const t0 = Date.now();
  const out = JSON.parse(
    execFileSync(process.execPath, [
      path.join(OCIO, "sleep-read.mjs"),
      db,
      String(now),
      "[]",
      JSON.stringify({ heartbeat: { from: 8, to: 22, tz: "UTC" } }),
    ]),
  );
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `sleep-read took ${ms} ms`);
  // The 1 ms rows are not a schedule (everyMs under 1 s) and give no wake; the cron job still does.
  assert.equal(out.nextWakeAtMs, now + 3 * 3_600_000);
});
