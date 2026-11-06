// Fake `litestream replicate` for unit tests. FAKE_MODE: normal | unclean | hang | ltx-missing | enospc | crash | stale
const mode = process.env.FAKE_MODE || "normal";
const log = (level, msg, extra = "") =>
  process.stderr.write(`time=${new Date().toISOString()} level=${level} msg="${msg}" ${extra}\n`);
log("INFO", "litestream", "version=fake");
if (mode === "ltx-missing")
  log(
    "ERROR",
    "monitor error",
    'system=store db=openclaw.sqlite replica=s3 error="open ltx file /m/ltx/0/0000000000000001-0000000000000001.ltx: open /m/ltx/0/0000000000000001-0000000000000001.ltx: no such file or directory"',
  );
if (mode === "enospc") {
  log(
    "ERROR",
    "disk full while staging ltx file, replication paused until space is freed",
    'db=openclaw.sqlite error="write /m/x: no space left on device"',
  );
  setTimeout(() => process.exit(1), 50);
}
if (mode === "stale")
  log(
    "ERROR",
    "sync error",
    'db=openclaw.sqlite error="operation error S3: PutObject, https response error StatusCode: 409, stale"',
  );
if (mode === "crash") setTimeout(() => process.exit(2), 100);
const stop = (sig) => {
  if (mode === "hang") return;
  log("INFO", "signal received, litestream shutting down", `signal=${sig}`);
  if (mode === "unclean") log("WARN", "shutdown sync failed, retrying", 'db=openclaw.sqlite error="x"');
  setTimeout(() => process.exit(0), 20);
};
process.on("SIGINT", () => stop("interrupt"));
process.on("SIGTERM", () => stop("terminated"));
setInterval(() => {}, 1 << 30);
