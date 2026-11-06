// Litestream 0.5.17 log reader (amend §1.5 F1.4, F1.6; scope §1.1 rows "Disk", "Litestream").
// Lines are slog text: time=… level=ERROR msg="monitor error" db=openclaw.sqlite error="…".
// The db key holds the file base name only, so two agent DBs share it; callers fault every DB
// with that base name (conservative).

/** Parse one slog text line into {key: value}. Quoted values keep escapes resolved. */
export function parseLogfmt(line) {
  const out = {};
  const re = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    let v = m[2];
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[m[1]] = v;
  }
  return out;
}

const DISK =
  /no space left on device|ENOSPC|disk quota exceeded|EDQUOT|disk full|SQLITE_FULL|database or disk is full/i;

/**
 * Classify a line. Returns null for lines that need no action, else
 * {cls, db, level, msg, text}. Classes:
 *   disk-full            ENOSPC/EDQUOT anywhere (checked FIRST: disk-full is never replica-down, Z0.4)
 *   ltx-missing          F1 shape: `open ltx file … no such file` (lag = infinite, F1.4)
 *   shutdown-sync-failed final sync did not finish (F1.6: no clean exit)
 *   gate-stale           ReplicaGate answered 409 (stale gen) → self-fence
 *   sync-error           other ERROR on the sync path
 *   error                any other ERROR line
 */
export function classifyLine(line) {
  if (!line) return null;
  const f = parseLogfmt(line);
  const level = f.level || "";
  const msg = f.msg || "";
  const err = f.error || "";
  const text = `${msg} ${err}`;
  const base = { db: f.db || null, level, msg, text: line.slice(0, 1000) };
  if (DISK.test(text)) return { cls: "disk-full", ...base };
  if (/open ltx file/.test(err) && /no such file/.test(err)) return { cls: "ltx-missing", ...base };
  if (/^shutdown sync (failed|timeout)/.test(msg)) return { cls: "shutdown-sync-failed", ...base };
  if (/\b409\b/.test(err) && /stale/i.test(err)) return { cls: "gate-stale", ...base };
  if (level === "ERROR" && /sync/i.test(msg)) return { cls: "sync-error", ...base };
  if (level === "ERROR") return { cls: "error", ...base };
  return null;
}

/** Line splitter for a child stream: calls onLine for each full line. */
export function lineSplitter(onLine, max = 8192) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) onLine(l.slice(0, max));
      i = buf.indexOf("\n");
    }
    if (buf.length > max) {
      onLine(buf.slice(0, max));
      buf = "";
    }
  };
}
