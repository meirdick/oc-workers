// M3 entry fixes in ocsup (worker/test/results/M2-STATUS.md): B1 workspace steps and helper, F1 restore
// deadline, B3 activity facts, O5 wake allowlist export.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BootPlan, classifyExit, EXIT_REASONS, exitCodeFor, validate } from "../lib/contract.mjs";
import { planSteps, RESTORE_STEPS, restoreDeadlineMs } from "../lib/plan.mjs";
import { exportWakeAllow, wakeAllowFrom } from "../lib/wake-allow.mjs";
import { workspaceStep } from "../lib/workspace.mjs";

const OCIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ocio");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ocsup-m3-"));
const names = (r) => r.steps.map((s) => s.step);
const base = {
  v: 1,
  mode: "prod",
  gen: 7,
  rootfs: { kind: "image" },
  sqlite: { kind: "gen", gen: 6 },
  dbs: [{ db: "state/openclaw.sqlite", state: "uploaded", lastTxid: 3, bytes: 10 }],
  runDoctor: false,
  lockMode: "auto",
};

test("B1 plan: image + gen + archive → workspace-restore then workspace check; snapshot → check only", () => {
  const a = planSteps({
    ...base,
    archive: { archiveId: "a1", sha256: "f".repeat(64) },
    workspace: { source: "archive" },
  });
  assert.deepEqual(names(a).slice(0, 5), [
    "wipe",
    "workspace-restore",
    "sqlite-gen",
    "sqlite-check",
    "workspace",
  ]);
  assert.equal(a.steps[4].source, "archive");
  const n = planSteps({ ...base, workspace: { source: "none" } });
  assert.deepEqual(names(n).slice(0, 4), ["wipe", "sqlite-gen", "sqlite-check", "workspace"]);
  assert.deepEqual([n.steps[3].source, n.steps[3].acceptLoss], ["none", false]);
  const s = planSteps({
    ...base,
    rootfs: { kind: "snapshot", snapshotId: "s1" },
    workspace: { source: "snapshot", acceptLoss: true },
  });
  assert.deepEqual([s.steps[3].step, s.steps[3].acceptLoss], ["workspace", true]);
  // Full archive restore (sqlite from the archive) stays M4.
  const full = planSteps({
    ...base,
    sqlite: { kind: "archive", archiveId: "a1" },
    archive: { archiveId: "a1", sha256: "f".repeat(64) },
  });
  assert.equal(full.steps[1].step, "archive-restore");
  assert.deepEqual(validate(BootPlan, { ...base, workspace: { source: "archive" } }), []);
  assert.ok(validate(BootPlan, { ...base, workspace: { source: "disk" } }).length > 0);
});

test("F1 restore deadline: 90 % of plan.timers.restoreMs; restore-timeout → exit 75, DO class escalates", () => {
  assert.equal(restoreDeadlineMs({ timers: { restoreMs: 300_000 } }), 270_000);
  assert.equal(restoreDeadlineMs({}), 270_000);
  for (const s of ["wipe", "sqlite-gen", "workspace-restore", "workspace"]) assert.ok(RESTORE_STEPS.has(s));
  assert.ok(!RESTORE_STEPS.has("lock"));
  assert.equal(EXIT_REASONS["restore-timeout"], 75);
  assert.equal(exitCodeFor("restore-timeout"), 75);
  assert.deepEqual(classifyExit(75, "restore-timeout"), { cls: "restore-timeout", esc: true });
});

const ocio = (op, args) =>
  JSON.parse(execFileSync(process.execPath, [path.join(OCIO, "workspace.mjs"), op, JSON.stringify(args)]));

function stateDb(dir, rows) {
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const db = path.join(dir, "state", "openclaw.sqlite");
  const c = new DatabaseSync(db);
  c.exec(`CREATE TABLE workspace_setup_state (workspace_key TEXT NOT NULL PRIMARY KEY, workspace_path TEXT,
    version INTEGER, bootstrap_seeded_at TEXT, setup_completed_at TEXT, updated_at INTEGER, attested_at_ms INTEGER,
    attestation_updated_at_ms INTEGER) STRICT`);
  for (const r of rows)
    c.prepare(
      "INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, bootstrap_seeded_at) VALUES (?, ?, 1, ?)",
    ).run(r.key, r.path, r.seeded ?? null);
  c.close();
  return db;
}

test("B1 ocio workspace check/reset: attested + empty → missing; not attested → ok; reset deletes the row", () => {
  const d = tmp();
  const ws = path.join(d, "workspace");
  const db = stateDb(d, [
    { key: "k1", path: ws, seeded: "2026-11-01T00:09:18Z" },
    { key: "k2", path: path.join(d, "other"), seeded: null },
  ]);
  let r = ocio("check", { db, state: d });
  assert.deepEqual(r.missing, [ws]);
  fs.mkdirSync(ws);
  assert.deepEqual(ocio("check", { db, state: d }).missing, [ws]); // empty dir counts as missing
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "hi");
  r = ocio("check", { db, state: d });
  assert.deepEqual([r.missing, r.attested[0].entries], [[], 1]);
  fs.rmSync(ws, { recursive: true });
  assert.equal(ocio("reset", { db, paths: [ws] }).deleted, 1);
  assert.deepEqual(ocio("check", { db, state: d }).missing, []);
  // No DB (fresh boot) and no table (older schema): nothing to judge.
  assert.deepEqual(ocio("check", { db: path.join(d, "none.sqlite"), state: d }).missing, []);
});

test("B1 ocio extract: workspace/ and workspace-<agent>/ files of an openclaw backup archive, nothing else", () => {
  const d = tmp();
  const state = path.join(d, "home", "node", ".openclaw");
  const src = path.join(d, "src");
  const root = path.join(src, "2026-11-01T04-21-42.219+00-00-openclaw-backup");
  const inner = path.join(root, "payload", "posix", state);
  fs.mkdirSync(path.join(inner, "workspace", "memory"), { recursive: true });
  fs.writeFileSync(path.join(inner, "workspace", "AGENTS.md"), "a");
  fs.writeFileSync(path.join(inner, "workspace", "memory", "m.md"), "m");
  fs.mkdirSync(path.join(inner, "workspace-dev"), { recursive: true });
  fs.writeFileSync(path.join(inner, "workspace-dev", "AGENTS.md"), "dev");
  fs.mkdirSync(path.join(inner, "agents", "dev", "agent"), { recursive: true });
  fs.writeFileSync(path.join(inner, "agents", "dev", "agent", "x.json"), "{}");
  fs.writeFileSync(path.join(inner, "openclaw.json"), "{}");
  fs.writeFileSync(path.join(root, "manifest.json"), "{}");
  const tgz = path.join(d, "b.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", src, path.basename(root)]);
  fs.mkdirSync(state, { recursive: true });
  const r = ocio("extract", { archive: tgz, state });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(state, "workspace", "AGENTS.md"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(state, "workspace", "memory", "m.md"), "utf8"), "m");
  assert.equal(fs.readFileSync(path.join(state, "workspace-dev", "AGENTS.md"), "utf8"), "dev");
  assert.deepEqual(r.dirs, { workspace: 2, "workspace-dev": 1 });
  assert.equal(fs.existsSync(path.join(state, "openclaw.json")), false);
  assert.equal(fs.existsSync(path.join(state, "agents")), false);
});

test("M3 e2e ocio extract: an archive with an empty workspace/ → ok, 0 files; a bad archive still fails", () => {
  const d = tmp();
  const state = path.join(d, "home", "node", ".openclaw");
  const src = path.join(d, "src");
  const root = path.join(src, "2026-11-01T09-59-03.883+00-00-openclaw-backup");
  fs.mkdirSync(path.join(root, "payload", "posix", state, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), "{}");
  const tgz = path.join(d, "e.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", src, path.basename(root)]);
  fs.mkdirSync(state, { recursive: true });
  const r = ocio("extract", { archive: tgz, state });
  assert.deepEqual([r.ok, r.files], [true, 0]);
  const bad = path.join(d, "bad.tgz");
  fs.writeFileSync(bad, "not a tgz");
  assert.throws(() => ocio("extract", { archive: bad, state }), /Command failed/); // exit 1, ok:false
});

test("B1 workspaceStep: missing → exit restore-blocked:mismatch + alert; acceptLoss → reset + alert", async () => {
  const calls = [];
  const fake = (answers) => async (_n, args) => {
    calls.push(args[0]);
    return { json: { ok: true, ...answers[args[0]] } };
  };
  const miss = { check: { attested: [{ path: "/w", entries: 0 }], missing: ["/w"] }, reset: { deleted: 1 } };
  const r1 = await workspaceStep({ state: "/s", db: "/s/db", source: "none", ocio: fake(miss) });
  assert.equal(r1.exit, "restore-blocked:mismatch");
  assert.equal(r1.alerts[0].class, "workspace-missing");
  const r2 = await workspaceStep({
    state: "/s",
    db: "/s/db",
    source: "none",
    acceptLoss: true,
    ocio: fake(miss),
  });
  assert.equal(r2.exit, undefined);
  assert.equal(r2.rec.reset, 1);
  assert.equal(r2.alerts[0].class, "workspace-reset");
  const ok = { check: { attested: [{ path: "/w", entries: 3 }], missing: [] } };
  assert.deepEqual(
    (await workspaceStep({ state: "/s", db: "/s/db", source: "snapshot", ocio: fake(ok) })).rec,
    {
      source: "snapshot",
      attested: 1,
      missing: [],
    },
  );
});

test("B3 sleep-read: lastActivityAtMs from session events, ingress, cron; an open run counts as now", () => {
  const d = tmp();
  const db = path.join(d, "s.sqlite");
  const c = new DatabaseSync(db);
  c.exec(`CREATE TABLE session_state_events (sequence INTEGER, session_key TEXT, kind TEXT, occurred_at INTEGER);
    CREATE TABLE channel_ingress_events (status TEXT, received_at INTEGER, updated_at INTEGER, completed_at INTEGER);
    CREATE TABLE cron_run_receipts (status TEXT, started_at_ms INTEGER, finished_at_ms INTEGER);`);
  const now = 1_793_500_000_000;
  c.prepare("INSERT INTO session_state_events VALUES (1, 's1', 'run.completed', ?)").run(now - 90_000);
  c.prepare("INSERT INTO channel_ingress_events VALUES ('completed', ?, ?, ?)").run(
    now - 120_000,
    now - 100_000,
    now - 95_000,
  );
  c.prepare("INSERT INTO cron_run_receipts VALUES ('ok', ?, ?)").run(now - 300_000, now - 299_000);
  const read = () =>
    JSON.parse(execFileSync(process.execPath, [path.join(OCIO, "sleep-read.mjs"), db, String(now)]));
  let r = read();
  assert.equal(r.lastActivityAtMs, now - 90_000);
  assert.equal(r.activeRuns, 0);
  c.prepare("INSERT INTO session_state_events VALUES (2, 's1', 'run.started', ?)").run(now - 50_000);
  r = read();
  assert.equal(r.activeRuns, 1);
  assert.equal(r.lastActivityAtMs, now);
  c.close();
});

test("O5 wake allowlist: ids from allowFrom, groupAllowFrom, groups; wildcard or open DMs → no export", async () => {
  assert.deepEqual(
    wakeAllowFrom({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["123", "tg:456", "@name"],
          groups: { "-100777": {} },
          accounts: { b: { allowFrom: ["telegram:789"], groupAllowFrom: ["111"] } },
        },
      },
    }),
    { userIds: ["123", "456", "789", "111"], groupChatIds: ["-100777"] },
  );
  assert.equal(wakeAllowFrom({ channels: { telegram: { allowFrom: ["*"] } } }), null);
  assert.equal(wakeAllowFrom({ channels: { telegram: { dmPolicy: "open", allowFrom: ["1"] } } }), null);
  assert.equal(wakeAllowFrom({ channels: {} }), null);
  const put = [];
  const r = await exportWakeAllow({
    readConfig: async () => JSON.stringify({ channels: { telegram: { allowFrom: ["42"] } } }),
    put: async (b) => put.push(b),
    configVer: 3,
  });
  assert.deepEqual([r.ok, put[0]], [true, { userIds: ["42"], groupChatIds: [], configVer: 3 }]);
  const bad = await exportWakeAllow({ readConfig: async () => "{", put: async () => assert.fail("no put") });
  assert.equal(bad.skipped, "config-not-json");
});

test("M3 e2e: wake allowlist adds pairing-approved senders; unreadable pairing store → no export", async () => {
  const put = [];
  const doc = JSON.stringify({ channels: { telegram: { dmPolicy: "pairing", allowFrom: ["42"] } } });
  const r = await exportWakeAllow({
    readConfig: async () => doc,
    pairedIds: async () => ["71000001", "telegram:7", "42", "x"],
    put: async (b) => put.push(b),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(put[0].userIds, ["42", "71000001", "7"]);
  const bad = await exportWakeAllow({
    readConfig: async () => doc,
    pairedIds: async () => {
      throw new Error("locked");
    },
    put: async () => assert.fail("no put: a stale list wakes on every update"),
  });
  assert.equal(bad.skipped, "pairing-unreadable");
});

test("M3 e2e: workspace-restore archive file is 0640 under ocsup's umask 077 (ocio reads it as group 1000)", async () => {
  const { workspaceRestore } = await import("../lib/workspace.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const pth = await import("node:path");
  const { createHash } = await import("node:crypto");
  const varDir = fsm.mkdtempSync(pth.join(os.tmpdir(), "wsr-"));
  const body = Buffer.from("not really a tgz");
  const old = process.umask(0o077);
  let mode = null;
  try {
    const r = await workspaceRestore({
      gate: { fetchRaw: async () => new Response(body) },
      archive: { archiveId: "a1", sha256: createHash("sha256").update(body).digest("hex") },
      state: varDir,
      varDir,
      asRoot: true,
      ocio: async (_n, args) => {
        mode = fsm.statSync(JSON.parse(args[1]).archive).mode & 0o777;
        return { json: { ok: true, files: 0 } };
      },
    });
    assert.ok(r.rec, JSON.stringify(r));
  } finally {
    process.umask(old);
  }
  assert.equal(mode, 0o640);
});
