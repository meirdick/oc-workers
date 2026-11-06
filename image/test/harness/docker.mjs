// Docker CLI wrapper for the M1 harness. Host side only (not in the image).
import { spawn, spawnSync } from "node:child_process";

/** Run docker synchronously. Returns {code, out, err}. Never throws. */
export function dk(args, { input, timeoutMs = 600_000 } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", input, timeout: timeoutMs, maxBuffer: 256 << 20 });
  return { code: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Like dk, but throws on a non-zero exit. */
export function dkOk(args, opts) {
  const r = dk(args, opts);
  if (r.code !== 0)
    throw new Error(`docker ${args.slice(0, 3).join(" ")}: exit ${r.code}: ${r.err.slice(-500)}`);
  return r.out;
}

/** Async docker call with streamed output collected. */
export function dkAsync(args, { timeoutMs = 600_000, onLine } = {}) {
  return new Promise((resolve) => {
    const c = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.stdout.on("data", (d) => {
      out += d;
      if (onLine) for (const l of String(d).split("\n")) if (l) onLine(l);
    });
    c.stderr.on("data", (d) => {
      err += d;
      if (onLine) for (const l of String(d).split("\n")) if (l) onLine(l);
    });
    c.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim(), err: err.trim() });
    });
  });
}

/** docker exec. user: "0" (root) or "1000". Returns {code,out,err}. */
export function exec(name, cmd, { user, input, timeoutMs = 120_000, env = {} } = {}) {
  const a = ["exec"];
  if (input !== undefined) a.push("-i");
  if (user) a.push("-u", user);
  for (const [k, v] of Object.entries(env)) a.push("-e", `${k}=${v}`);
  a.push(name, ...(Array.isArray(cmd) ? cmd : ["sh", "-c", cmd]));
  return dk(a, { input, timeoutMs });
}

export const inspect = (name, fmt) => dk(["inspect", "-f", fmt, name]).out;
export const state = (name) => {
  const r = dk(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}", name]);
  if (r.code !== 0) return { status: "missing", exitCode: null, oom: false };
  const [status, ec, oom] = r.out.split(" ");
  return { status, exitCode: Number(ec), oom: oom === "true" };
};
export const rm = (...names) => names.length && dk(["rm", "-f", ...names]);
export const logs = (name) => {
  const r = dk(["logs", name]);
  return `${r.out}\n${r.err}`;
};
