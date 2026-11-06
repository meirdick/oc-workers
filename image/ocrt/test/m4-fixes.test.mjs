// M4 fixes in ocsup: F9 (default config on a fresh install), A1 (orphan cron rows: reconcile, sleep-read).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, defaultVersion, render } from "../lib/config.mjs";
import { liveJobIds, orphansOf, reconcileCron } from "../lib/cron-reconcile.mjs";
import { secretRefNames } from "../lib/gateway.mjs";
import { configStep } from "../lib/guard-boot.mjs";

const OCIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ocio");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ocsup-m4-"));

test("F9 defaultVersion: model + key ref only when the Worker passes OC_ANTHROPIC_KEY", () => {
  const a = defaultVersion(["OC_GATEWAY_TOKEN", "OC_ANTHROPIC_KEY"]);
  assert.equal(a.ver, null);
  assert.equal(a.doc.agents.defaults.model.primary, DEFAULT_MODEL);
  assert.equal(a.doc.models.providers.anthropic.apiKey, "$" + "{OC_ANTHROPIC_KEY}");
  assert.equal(defaultVersion(["OC_GATEWAY_TOKEN"]).doc.models, undefined);
});

test("F9 configStep with no config version renders the default doc with the managed gateway keys", async () => {
  const writes = [];
  const ctx = {
    plan: { mode: "prod", configVer: null, trustedProxies: ["10.1.0.0/32"], managed: [] },
    state: "/home/node/.openclaw",
    envNames: ["OC_ANTHROPIC_KEY", "OC_GATEWAY_TOKEN"],
    runOcio: async (name, args, o) => {
      if (name === "cron-read") return { json: { ok: true, records: {} } }; // plugin-installs read (guard-boot pathInstallStep)
      writes.push({ name, args, text: o.stdin });
      return { json: { ok: true } };
    },
    runCli: async () => ({ code: 0, out: "" }),
    cliEnv: () => ({}),
    gate: {
      call: async () => {
        throw new Error("no gate call expected");
      },
    },
    log: () => {},
  };
  const r = await configStep(ctx);
  assert.equal(r.exit, undefined, JSON.stringify(r));
  assert.equal(r.rec.default, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[1], "/home/node/.openclaw/openclaw.json");
  const doc = JSON.parse(writes[0].text);
  assert.equal(doc.gateway.auth.mode, "trusted-proxy");
  assert.equal(doc.gateway.auth.trustedProxy.userHeader, "x-ochost-user");
  assert.equal(doc.gateway.auth.token, undefined);
  assert.equal(doc.gateway.auth.password, undefined);
  assert.equal(doc.agents.defaults.model.primary, DEFAULT_MODEL);
  assert.deepEqual(secretRefNames(ctx.cfg.rendered.doc), ["OC_ANTHROPIC_KEY"]);
  // A UI edit later proposes against no base (ver null → Control DO version 1).
  assert.equal(ctx.cfg.rendered.proposals, true);
  assert.equal(render(ctx.cfg.version, ctx.plan).sha, ctx.cfg.rendered.sha);
});

test("A1 liveJobIds and orphansOf", () => {
  assert.equal(liveJobIds(null), null);
  assert.deepEqual([...liveJobIds({ result: { jobs: [{ id: "a" }, { jobId: "b" }] } })], ["a", "b"]);
  const live = "/home/node/.openclaw/cron/jobs.json";
  const rows = [
    { store_key: live, job_id: "a" },
    { store_key: "/var/lib/ocrt/stage-u/cron/jobs.json", job_id: "x" },
    { store_key: "/other/jobs.json", job_id: "y" },
    { store_key: "/other/jobs.json", job_id: "a" },
  ];
  assert.deepEqual(
    orphansOf(rows, new Set(["a"]), live).map((o) => `${o.job_id}:${o.why}`),
    ["x:staging", "y:not-listed"],
  );
  // Gateway list unknown: only the staging row (never live) goes.
  assert.deepEqual(
    orphansOf(rows, null, live).map((o) => o.job_id),
    ["x"],
  );
});

test("A1 reconcileCron deletes and logs; a failed gateway list still drops staging rows", async () => {
  const logs = [];
  const alerts = [];
  let deleted = null;
  const r = await reconcileCron("gateway-start", {
    liveKey: "/k",
    readRows: async () => [
      { store_key: "/var/lib/ocrt/stage-u/cron/jobs.json", job_id: "b4c00b80" },
      { store_key: "/k", job_id: "live" },
    ],
    listLive: async () => {
      throw new Error("gateway down");
    },
    del: async (rows) => {
      deleted = rows;
      return { ok: true, deleted: rows.length };
    },
    log: (e, o) => logs.push([e, o]),
    alert: (...a) => alerts.push(a),
  });
  assert.deepEqual(r, { ok: true, orphans: 1, deleted: 1, live: null });
  assert.deepEqual(deleted, [{ store_key: "/var/lib/ocrt/stage-u/cron/jobs.json", job_id: "b4c00b80" }]);
  assert.equal(logs[0][0], "cron-orphan-deleted");
  assert.deepEqual(alerts, []); // routine cleanup: a log line, not an alert
});

function cronDb(file, now) {
  const c = new DatabaseSync(file);
  c.exec(`CREATE TABLE cron_jobs (store_key TEXT NOT NULL, job_id TEXT NOT NULL, name TEXT, agent_id TEXT,
    enabled INTEGER NOT NULL, job_json TEXT, state_json TEXT, PRIMARY KEY (store_key, job_id))`);
  const ins = c.prepare("INSERT INTO cron_jobs VALUES (?, ?, 'heartbeat-main', 'main', 1, ?, ?)");
  const job = JSON.stringify({ schedule: { kind: "every", everyMs: 1800000 } });
  ins.run(
    "/var/lib/ocrt/stage-u/cron/jobs.json",
    "b4c00b80",
    job,
    JSON.stringify({ nextRunAtMs: now - 4.5 * 3600_000 }),
  );
  ins.run(
    "/home/node/.openclaw/cron/jobs.json",
    "e62f8b66",
    job,
    JSON.stringify({ nextRunAtMs: now + 600_000 }),
  );
  c.close();
}

test("A1 sleep-read: orphan staging row with a past time does not hide the live job (M3 live A §5.1)", () => {
  const d = tmp();
  const db = path.join(d, "openclaw.sqlite");
  const now = 1_793_538_000_000;
  cronDb(db, now);
  const j = JSON.parse(execFileSync(process.execPath, [path.join(OCIO, "sleep-read.mjs"), db, String(now)]));
  assert.equal(j.ok, true);
  assert.equal(j.nextWakeAtMs, now + 600_000);
});

test("A1 ocio cron-read jobs + cron-fix delete: staging row deleted, live-key row refused", () => {
  const d = tmp();
  const db = path.join(d, "openclaw.sqlite");
  cronDb(db, Date.now());
  const rows = JSON.parse(
    execFileSync(process.execPath, [path.join(OCIO, "cron-read.mjs"), db, "jobs"]),
  ).rows;
  assert.equal(rows.length, 2);
  const live = "/home/node/.openclaw/cron/jobs.json";
  const out = JSON.parse(
    execFileSync(process.execPath, [path.join(OCIO, "cron-fix.mjs"), db, "delete", live], {
      input: JSON.stringify([
        { store_key: "/var/lib/ocrt/stage-u/cron/jobs.json", job_id: "b4c00b80" },
        { store_key: live, job_id: "e62f8b66" },
      ]),
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.deleted, 1);
  assert.equal(out.refused.length, 1);
  const left = JSON.parse(
    execFileSync(process.execPath, [path.join(OCIO, "cron-read.mjs"), db, "jobs"]),
  ).rows;
  assert.deepEqual(
    left.map((r) => r.job_id),
    ["e62f8b66"],
  );
});

test("A4 ocio fsops dirty: workspace file after sinceMs counts; SQLite, -wal, node_modules, ls meta do not", () => {
  const d = tmp();
  const since = Date.now() - 1000;
  fs.mkdirSync(path.join(d, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(d, "state", ".openclaw.sqlite-litestream"), { recursive: true });
  fs.mkdirSync(path.join(d, "plugins", "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(d, "state", "openclaw.sqlite"), "x");
  fs.writeFileSync(path.join(d, "state", "openclaw.sqlite-wal"), "x");
  fs.writeFileSync(path.join(d, "state", ".openclaw.sqlite-litestream", "f"), "x");
  fs.writeFileSync(path.join(d, "plugins", "node_modules", "x", "i.js"), "x");
  const run = (s) =>
    JSON.parse(
      execFileSync(process.execPath, [
        path.join(OCIO, "fsops.mjs"),
        "dirty",
        JSON.stringify({ state: d, sinceMs: s }),
      ]),
    );
  assert.equal(run(since).count, 0);
  fs.writeFileSync(path.join(d, "workspace", "MEMORY.md"), "note 12345");
  const r = run(since);
  assert.equal(r.count, 1);
  assert.equal(r.bytes, 10);
  assert.deepEqual(r.sample, ["workspace/MEMORY.md"]);
  assert.equal(run(Date.now() + 60_000).count, 0);
});
