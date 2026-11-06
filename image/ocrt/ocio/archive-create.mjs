// ocio archive-create: `openclaw backup create --output <dir> --verify --json` as uid 1000, then stream
// the archive to stdout and delete it (plan §4.11 "Archives"; scope §1.1 "Archives and shadows").
// argv[2] = JSON {outDir, cli?: [<node>,"/app/openclaw.mjs"], extra?: [], timeoutMs?, env?: {}}.
// stderr last line: JSON {ok, file, bytes, createMs, cli?: <parsed --json>, why?}.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, openSafe } from "./_common.mjs";

ignoreTerm();
const a = JSON.parse(process.argv[2] || "{}");
const cli = a.cli || [process.execPath, "/app/openclaw.mjs"];
const done = (o, code = 0) => {
  process.stderr.write(`\n${JSON.stringify(o)}\n`);
  process.exitCode = code;
};
fs.mkdirSync(a.outDir, { recursive: true, mode: 0o700 });
for (const n of fs.readdirSync(a.outDir)) fs.rmSync(path.join(a.outDir, n), { recursive: true, force: true });
const t0 = Date.now();
const child = spawn(
  cli[0],
  [...cli.slice(1), "backup", "create", "--output", a.outDir, "--verify", "--json", ...(a.extra || [])],
  {
    stdio: ["ignore", "pipe", "pipe"],
    // L5: OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH of the shadow tree (lib/archive.mjs).
    env: { ...process.env, ...(a.env || {}) },
  },
);
process.on("SIGINT", () => child.kill("SIGTERM")); // abort from ocsup (drain)
let out = "";
let err = "";
child.stdout.on("data", (d) => {
  if (out.length < 1e6) out += d;
});
child.stderr.on("data", (d) => {
  if (err.length < 1e5) err += d;
});
const timer = setTimeout(() => child.kill("SIGKILL"), a.timeoutMs || 900_000);
child.on("close", async (code, signal) => {
  clearTimeout(timer);
  const createMs = Date.now() - t0;
  let parsed = null;
  try {
    parsed = JSON.parse(out.slice(out.indexOf("{")));
  } catch {}
  if (code !== 0) {
    // 2026.10.9 `backup create` prints only "The CLI command failed." on ENOSPC (measured in M1), so
    // look at the output dir: under 1 MiB free there = a full disk (disk-full class, Z0.4).
    let why = `backup create exit ${code ?? signal}`;
    try {
      const st = fs.statfsSync(a.outDir);
      const free = st.bavail * st.bsize;
      if (free < 1024 * 1024) why += `: ENOSPC (output dir free ${free} B)`;
    } catch {}
    return done({ ok: false, why, tail: err.slice(-500), createMs }, 1);
  }
  const files = fs.readdirSync(a.outDir).filter((n) => n.endsWith(".tar.gz"));
  if (files.length !== 1)
    return done({ ok: false, why: `want 1 archive, found ${files.length}`, createMs }, 1);
  const file = path.join(a.outDir, files[0]);
  const o = openSafe(file);
  if (o.err) return done({ ok: false, why: o.err }, 1);
  const rs = fs.createReadStream(null, { fd: o.fd });
  let bytes = 0;
  rs.on("data", (d) => {
    bytes += d.length;
  });
  rs.pipe(process.stdout);
  rs.on("end", () => {
    fs.rmSync(file, { force: true });
    done({ ok: true, file: files[0], bytes, createMs, cli: parsed });
  });
  rs.on("error", (e) => done({ ok: false, why: String(e) }, 1));
});
