// ocio helper (uid 1000): delete orphan cron_jobs rows from state/openclaw.sqlite (M4 fix A1).
// Usage: node cron-fix.mjs <state-db> delete <liveStoreKey>  < [{store_key, job_id}]  → one JSON line
//   {ok, deleted, refused}. A row whose store_key equals <liveStoreKey> is never deleted (refused).
// The gateway holds the DB open: busy_timeout 5 s, one transaction.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

process.on("SIGTERM", () => {});
const [db, op, liveKey] = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let input = "";
process.stdin.on("data", (d) => {
  input += d;
  if (input.length > 1_000_000) process.exit(2);
});
process.stdin.on("end", () => {
  try {
    if (op !== "delete") throw Object.assign(new Error(`unknown op ${op}`), { code: "EINVAL" });
    const st = fs.lstatSync(db);
    if (!st.isFile() || st.nlink !== 1)
      throw Object.assign(new Error("not a plain file"), { code: "EUNSAFE" });
    const rows = JSON.parse(input || "[]");
    if (!Array.isArray(rows) || rows.length > 1000)
      throw Object.assign(new Error("bad input"), { code: "EINVAL" });
    const c = new DatabaseSync(db);
    c.exec("PRAGMA busy_timeout=5000");
    let deleted = 0;
    const refused = [];
    c.exec("BEGIN IMMEDIATE");
    try {
      const del = c.prepare("DELETE FROM cron_jobs WHERE store_key = ? AND job_id = ?");
      for (const r of rows) {
        const k = String(r?.store_key ?? "");
        const id = String(r?.job_id ?? "");
        if (!k || !id || k === liveKey) {
          refused.push({ store_key: k, job_id: id });
          continue;
        }
        deleted += Number(del.run(k, id).changes);
      }
      c.exec("COMMIT");
    } catch (e) {
      c.exec("ROLLBACK");
      throw e;
    }
    c.close();
    out({ ok: true, deleted, refused });
  } catch (e) {
    out({ ok: false, error: e.code || "EIO", detail: String(e.message).slice(0, 200) });
    process.exitCode = 1;
  }
});
