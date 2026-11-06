// Fake `litestream restore … -o OUT -json DB`. FAKE_RESTORE: ok | fail | lowtxid | garbage | refused | denied | deadline
import fs from "node:fs";

const a = process.argv.slice(2);
const out = a[a.indexOf("-o") + 1];
const mode = process.env.FAKE_RESTORE || "ok";
if (a.includes("-if-replica-exists")) process.exit(9);
if (mode === "fail") {
  process.stderr.write('level=ERROR msg="no matching backups found"\n');
  process.exit(1);
}
if (mode === "refused") {
  process.stderr.write('level=ERROR msg="dial tcp 127.0.0.1:18790: connection refused"\n');
  process.exit(1);
}
if (mode === "denied") {
  process.stderr.write('level=ERROR msg="operation error S3: GetObject, StatusCode: 403, AccessDenied"\n');
  process.exit(1);
}
if (mode === "deadline") {
  process.stderr.write('level=ERROR msg="context deadline exceeded"\n');
  process.exit(1);
}
if (mode === "garbage") fs.writeFileSync(out, "not a database at all, just bytes".repeat(200));
else {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(out);
  db.exec("create table t(x); insert into t values (1),(2),(3);");
  db.close();
}
process.stdout.write(
  `${JSON.stringify({ txid: mode === "lowtxid" ? "0000000000000002" : "0000000000000010" })}\n`,
);
