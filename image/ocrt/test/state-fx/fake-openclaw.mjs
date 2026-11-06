// Fake `openclaw backup create --output DIR --verify --json`. FAKE_ARCHIVE_BYTES, FAKE_ARCHIVE=ok|fail|two
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const a = process.argv.slice(2);
const dir = a[a.indexOf("--output") + 1];
const mode = process.env.FAKE_ARCHIVE || "ok";
// L5: record which state dir the archive read (a shadow tree sets OPENCLAW_STATE_DIR).
if (process.env.OPENCLAW_STATE_DIR) fs.writeFileSync(path.join(process.env.OPENCLAW_STATE_DIR, ".seen"), "1");
if (mode === "fail") {
  process.stderr.write("backup failed\n");
  process.exit(4);
}
const n = Number(process.env.FAKE_ARCHIVE_BYTES || 350_000);
const f = path.join(dir, "2026-10-31T10-00-00.000Z-openclaw-backup.tar.gz");
fs.writeFileSync(f, randomBytes(n));
if (mode === "two") fs.writeFileSync(path.join(dir, "other.tar.gz"), "x");
console.log(JSON.stringify({ ok: true, archivePath: f, verified: true }));
