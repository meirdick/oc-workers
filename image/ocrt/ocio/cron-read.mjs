// ocio helper (uid 1000): read-only cron facts from state/openclaw.sqlite for ocsup.
// Usage: node cron-read.mjs <state-db> busy|proactive|pairing  → one JSON line.
//   busy:      {ok, rows: [{status, started_at_ms}]} of cron_run_receipts with status 'running'
//   proactive: {ok, receipts: [{state_key, value_json}], jobs: [{job_id, name, agent_id, enabled, job_json}]}
//   pairing:   {ok, rows: [{account_id, entry}]} of channel_pairing_allow_entries for telegram (approved senders)
//   jobs:      {ok, rows: [{store_key, job_id, enabled, state_json}]} of every cron_jobs row (M4 A1 reconcile)
//   plugin-installs: {ok, records: {<plugin id>: {source, installPath}}} from the plugins.installedIndex row (docs/11 §7)
// Opens read-only with O_NOFOLLOW semantics checked by lstat (plan §4.13). A missing table → empty list.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

process.on("SIGTERM", () => {});
const [db, what] = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function all(c, sql) {
  try {
    return c.prepare(sql).all();
  } catch (e) {
    if (/no such table|no such column/.test(String(e.message))) return [];
    throw e;
  }
}

try {
  const st = fs.lstatSync(db);
  if (!st.isFile() || st.nlink !== 1) throw Object.assign(new Error("not a plain file"), { code: "EUNSAFE" });
  const c = new DatabaseSync(db, { readOnly: true });
  c.exec("PRAGMA busy_timeout=2000");
  if (what === "busy") {
    out({
      ok: true,
      rows: all(c, "SELECT status, started_at_ms FROM cron_run_receipts WHERE status='running'"),
    });
  } else if (what === "proactive") {
    out({
      ok: true,
      receipts: all(
        c,
        "SELECT state_key, value_json FROM config_machine_state WHERE state_key LIKE 'automation-default:%'",
      ),
      jobs: all(c, "SELECT job_id, name, agent_id, enabled, job_json FROM cron_jobs"),
    });
  } else if (what === "pairing") {
    out({
      ok: true,
      rows: all(
        c,
        "SELECT account_id, entry FROM channel_pairing_allow_entries WHERE channel_key = 'telegram' LIMIT 10000",
      ),
    });
  } else if (what === "jobs") {
    out({
      ok: true,
      rows: all(c, "SELECT store_key, job_id, enabled, state_json FROM cron_jobs LIMIT 1000"),
    });
  } else if (what === "plugin-installs") {
    const r = all(
      c,
      "SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
    )[0];
    const recs = (r && JSON.parse(r.value_json)?.index?.installRecords) || {};
    out({
      ok: true,
      records: Object.fromEntries(
        Object.entries(recs).map(([id, v]) => [id, { source: v?.source, installPath: v?.installPath }]),
      ),
    });
  } else throw Object.assign(new Error(`unknown query ${what}`), { code: "EINVAL" });
  c.close();
} catch (e) {
  out({ ok: false, error: e.code || "EIO", detail: String(e.message).slice(0, 200) });
  process.exitCode = 1;
}
