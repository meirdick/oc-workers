// Log ring and status file (plan §4.12 last bullets). JSON lines; the ring is one file plus `.1`.
// Redaction: values of keys that look secret are replaced before they reach disk or the gate.
import fs from "node:fs";
import path from "node:path";

export const RING_MAX = 5 * 1024 * 1024;
const SECRET_KEY = /secret|token|password|authorization|accesskey|secretkey|b64|bootsecret/i;

/** Deep copy with secret-looking keys masked. Strings are cut at 2000 chars. */
export function redact(v, depth = 0) {
  if (depth > 6) return "[deep]";
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redact(x, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && x ? "***" : redact(x, depth + 1);
  return o;
}

/**
 * createLog({file, ringMax, stdout, now, t0}) -> {log(ev, fields), tail(n), errors()}.
 * log() never throws. A line with level "error" (or ev ending in -failed/-error) enters the error ring.
 */
export function createLog(o = {}) {
  const file = o.file;
  const ringMax = o.ringMax ?? RING_MAX;
  const now = o.now || Date.now;
  const t0 = o.t0 ?? now();
  const out = o.stdout === undefined ? process.stdout : o.stdout;
  const errs = [];
  const mem = [];
  let writes = 0;
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  function log(ev, fields = {}) {
    const t = now();
    const rec = { ts: new Date(t).toISOString(), t: t - t0, ev, ...redact(fields) };
    const line = `${JSON.stringify(rec)}\n`;
    try {
      out?.write(line);
    } catch {}
    mem.push(line);
    if (mem.length > 500) mem.shift();
    if (fields.level === "error" || /-(failed|error)$/.test(ev)) {
      errs.push(line.trim().slice(0, 500));
      if (errs.length > 5) errs.shift();
    }
    if (!file) return rec;
    try {
      fs.appendFileSync(file, line, { mode: 0o600 });
      if (++writes % 50 === 0 && fs.statSync(file).size > ringMax) fs.renameSync(file, `${file}.1`);
    } catch {}
    return rec;
  }
  /** Last n lines: from disk (ring + .1) when a file is set, else from memory. */
  function tail(n = 200) {
    if (!file) return mem.slice(-n).map((l) => l.trim());
    const read = (f) => {
      try {
        return fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    const cur = read(file);
    const lines = cur.length >= n ? cur : [...read(`${file}.1`), ...cur];
    return lines.slice(-n);
  }
  return { log, tail, errors: () => [...errs] };
}

/** Atomic JSON status writer (tmp + rename, 0600). Returns a function (obj) -> bool. */
export function createStatusWriter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return (obj) => {
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(redact(obj), null, 1), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      return true;
    } catch {
      return false;
    }
  };
}
