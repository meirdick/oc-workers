// Shared bits for ocio helpers (uid 1000). Plain Node, no deps.
// File safety (plan §4.13): O_NOFOLLOW opens, fstat on the fd, regular files with nlink 1 only,
// every path component below the root a real directory (lstat).
import fs from "node:fs";
import path from "node:path";

const { O_RDONLY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;

/** Node resets SIGTERM to SIG_DFL at start, so a wrapper SIG_IGN does not hold: ignore in-process. */
export function ignoreTerm() {
  process.on("SIGTERM", () => {});
}

export const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** Each component of rel below root must be a real dir (no symlink). Returns null or the reason. */
export function unsafeDirs(root, rel) {
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) return "dot-component";
  let cur = root;
  for (const p of parts.slice(0, -1)) {
    cur = path.join(cur, p);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      return e.code;
    }
    if (!st.isDirectory()) return st.isSymbolicLink() ? "symlink-dir" : "not-dir";
  }
  return null;
}

/** Open a regular file read-only, refusing symlinks and hard links. Returns {fd, st} or {err}. */
export function openSafe(file) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    return { err: e.code === "ELOOP" ? "symlink" : e.code };
  }
  const st = fs.fstatSync(fd);
  if (!st.isFile()) {
    fs.closeSync(fd);
    return { err: "not-file" };
  }
  if (st.nlink !== 1) {
    fs.closeSync(fd);
    return { err: "hardlink" };
  }
  return { fd, st };
}

/** Read a whole file safely. Returns {buf, st} or {err}. */
export function readSafe(file, max = 64 * 1024 * 1024) {
  const o = openSafe(file);
  if (o.err) return o;
  try {
    if (o.st.size > max) return { err: "too-big", st: o.st };
    const buf = Buffer.alloc(o.st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(o.fd, buf, off, buf.length - off, off);
      if (!n) break;
      off += n;
    }
    return { buf: buf.subarray(0, off), st: o.st };
  } finally {
    fs.closeSync(o.fd);
  }
}

/** Atomic write: tmp (O_EXCL|O_NOFOLLOW), fsync, rename, fsync dir. */
export function writeAtomic(dest, data, mode = 0o600) {
  const tmp = `${dest}.ocio-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  try {
    const dfd = fs.openSync(path.dirname(dest), O_RDONLY);
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
  } catch {}
}

/** mkdir -p below root, refusing symlinked components. mode 0700. */
export function mkdirSafe(root, relDir) {
  let cur = root;
  for (const p of relDir.split("/").filter(Boolean)) {
    cur = path.join(cur, p);
    try {
      const st = fs.lstatSync(cur);
      if (!st.isDirectory()) throw Object.assign(new Error(`not a dir: ${cur}`), { code: "ENOTDIR" });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(cur, { mode: 0o700 });
    }
  }
}
