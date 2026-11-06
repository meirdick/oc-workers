// ocio helper (uid 1000): read or write one config file for ocsup. Root never opens these paths
// (plan §4.13). Refuses symlinks and nlink > 1; writes are atomic (tmp, fsync, rename), mode 0600.
// Usage: node config-io.mjs read <path>            → stdout {"ok":true,"text":...,"mtimeMs":...}
//        node config-io.mjs write <path> < bytes   → stdout {"ok":true,"bytes":n}
// Paths must be under OCIO_ALLOW (colon list), default /home/node/.openclaw:/var/lib/ocrt/stage-u.
import fs from "node:fs";
import path from "node:path";

const ALLOW = (process.env.OCIO_ALLOW || "/home/node/.openclaw:/var/lib/ocrt/stage-u").split(":");
const [op, file] = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// Ignore SIGTERM in-process (scope §1.1 row "Signals"): ocsup ends helpers itself.
process.on("SIGTERM", () => {});

function allowed(p) {
  const r = path.resolve(p);
  return ALLOW.some((a) => r === a || r.startsWith(`${a}/`));
}

/** Every component below the allow root must be a real dir (lstat), not a symlink. */
function safeParents(p) {
  const r = path.resolve(p);
  const root = ALLOW.find((a) => r.startsWith(`${a}/`));
  let cur = root;
  for (const part of path.relative(root, path.dirname(r)).split("/").filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === "ENOENT") return; // the rest is made by mkdir on write
      throw e;
    }
    if (!st.isDirectory() || st.isSymbolicLink())
      throw Object.assign(new Error("unsafe path"), { code: "EUNSAFE" });
  }
}

try {
  if (!file || !allowed(file)) throw Object.assign(new Error("path not allowed"), { code: "EPERM" });
  safeParents(file);
  if (op === "read") {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1)
      throw Object.assign(new Error("not a plain file"), { code: "EUNSAFE" });
    const text = fs.readFileSync(fd, "utf8");
    fs.closeSync(fd);
    out({ ok: true, text, mtimeMs: st.mtimeMs, size: st.size });
  } else if (op === "write") {
    const data = fs.readFileSync(0);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.ocio-${process.pid}`;
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    try {
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink() || st.nlink > 1) {
        fs.unlinkSync(tmp);
        throw Object.assign(new Error("target is a link"), { code: "EUNSAFE" });
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    fs.renameSync(tmp, file);
    out({ ok: true, bytes: data.length });
  } else throw Object.assign(new Error(`unknown op ${op}`), { code: "EINVAL" });
} catch (e) {
  out({ ok: false, error: e.code || "EIO", detail: String(e.message).slice(0, 200) });
  process.exitCode = 1;
}
