// ocio credwatch: long-lived credentials watcher (plan §4.10; scope §1.1 rows "credsync", "Reap and helpers").
// Runs as uid 1000 in ocrt/io. argv[2] = JSON {root, trees:["credentials"], files:["codex-home/auth.json"],
// debounceMs:100, stableMs:100, maxBytes}. stdout: JSON lines
//   {op:"put", path, sha256, mode, size, b64}   file changed (regular, nlink 1, JSON parses for *.json)
//   {op:"del", path}                             file gone
//   {op:"skip", path, why}                      symlink | hardlink | torn-json | too-big | unstable
//   {op:"scan-done", n, ms}                      after a reconcile scan
//   {op:"ready"}                                 watches armed
// stdin: JSON lines {cmd:"scan", known:{path: sha256}} → reconcile: put changed/new, del missing.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, out, readSafe, unsafeDirs } from "./_common.mjs";

ignoreTerm();
const cfg = {
  trees: ["credentials"],
  files: [],
  debounceMs: 100,
  stableMs: 100,
  maxBytes: 2 * 1024 * 1024,
  ...JSON.parse(process.argv[2] || "{}"),
};
const ROOT = cfg.root;
const timers = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");

function inScope(rel) {
  if (cfg.files.includes(rel)) return true;
  return cfg.trees.some((t) => rel === t || rel.startsWith(`${t}/`));
}

/** Stat twice, stableMs apart. Returns lstat or null (gone) or "unstable". */
async function stable(abs) {
  let a;
  try {
    a = fs.lstatSync(abs);
  } catch {
    return null;
  }
  await sleep(cfg.stableMs);
  let b;
  try {
    b = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ino !== b.ino) return "unstable";
  return b;
}

/** Read and emit one path. known: sha the root already has (skip when equal). */
async function emit(rel, known) {
  const bad = unsafeDirs(ROOT, rel);
  if (bad && bad !== "ENOENT") return out({ op: "skip", path: rel, why: bad });
  const abs = path.join(ROOT, rel);
  const st = await stable(abs);
  if (st === null) return out({ op: "del", path: rel }); // root sends a tombstone only for a path it holds
  if (st === "unstable") {
    schedule(rel); // try again after the next debounce
    return out({ op: "skip", path: rel, why: "unstable" });
  }
  if (st.isDirectory()) return;
  if (st.isSymbolicLink()) return out({ op: "skip", path: rel, why: "symlink" });
  if (!st.isFile()) return out({ op: "skip", path: rel, why: "not-file" });
  const r = readSafe(abs, cfg.maxBytes);
  if (r.err) return out({ op: "skip", path: rel, why: r.err });
  if (rel.endsWith(".json")) {
    try {
      JSON.parse(r.buf.toString("utf8"));
    } catch {
      return out({ op: "skip", path: rel, why: "torn-json" }); // waits for the next event or scan
    }
  }
  const h = sha(r.buf);
  if (known === h) return;
  out({
    op: "put",
    path: rel,
    sha256: h,
    mode: r.st.mode & 0o777,
    size: r.buf.length,
    b64: r.buf.toString("base64"),
  });
}

function schedule(rel) {
  clearTimeout(timers.get(rel));
  timers.set(
    rel,
    setTimeout(() => {
      timers.delete(rel);
      emit(rel).catch((e) => out({ op: "skip", path: rel, why: String(e.message || e) }));
    }, cfg.debounceMs),
  );
}

function walk(rel, acc) {
  const abs = path.join(ROOT, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs)) walk(`${rel}/${n}`, acc);
  } else acc.push(rel);
}

async function scan(known = {}) {
  const t0 = Date.now();
  const seen = [];
  for (const t of cfg.trees) walk(t, seen);
  for (const f of cfg.files) if (fs.lstatSync(path.join(ROOT, f), { throwIfNoEntry: false })) seen.push(f);
  const set = new Set(seen);
  for (const rel of seen) await emit(rel, known[rel]);
  for (const rel of Object.keys(known))
    if (!set.has(rel) && inScope(rel) && known[rel] !== null) out({ op: "del", path: rel });
  out({ op: "scan-done", n: seen.length, ms: Date.now() - t0 });
}

function arm() {
  for (const t of cfg.trees) {
    const abs = path.join(ROOT, t);
    try {
      fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
      fs.watch(abs, { recursive: true }, (_ev, name) => {
        if (name) schedule(`${t}/${name}`);
      });
    } catch (e) {
      out({ op: "skip", path: t, why: `watch:${e.code}` });
    }
  }
  const dirs = new Map();
  for (const f of cfg.files) {
    const d = path.dirname(f);
    if (!dirs.has(d)) dirs.set(d, []);
    dirs.get(d).push(path.basename(f));
  }
  for (const [d, names] of dirs) {
    try {
      fs.watch(path.join(ROOT, d), (_ev, name) => {
        if (name && names.includes(name)) schedule(`${d}/${name}`);
      });
    } catch {
      // Dir absent (e.g. codex off): the periodic reconcile scan still finds a file created later.
    }
  }
  out({ op: "ready" });
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i = buf.indexOf("\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\n");
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.cmd === "scan") scan(m.known || {}).catch((e) => out({ op: "scan-done", n: -1, error: String(e) }));
  }
});
process.stdin.on("end", () => process.exit(0));
arm();
