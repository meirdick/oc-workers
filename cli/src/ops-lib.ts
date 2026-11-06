// Shared parts of the ops commands (docs/10-cli-spec.md §1.1): install state, owner token, the /ops client,
// output, argv, errors and the process runner. Commands get an OpsCtx so tests can swap fetch, the runner,
// prompts and the clock. Patterns from cf-orbs cli/src/{args,errors,ui,context}.ts.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { causeChain, rootCause } from "./ui.ts";
import { jsonFormatEnv, QUIET_ENV } from "./wrangler.ts";

// ---------------------------------------------------------------- errors and redaction

/** Exit codes (§1.1). */
export const EXIT = { ok: 0, failed: 1, usage: 2, manual: 3, budget: 4, interrupted: 130 } as const;

/** "Failed: <cause> — fix: <action>", one line. `code` is the exit code. */
export class CliError extends Error {
  constructor(
    readonly cause_: string,
    readonly fix: string,
    readonly code: number = EXIT.failed,
  ) {
    super(`Failed: ${oneLine(cause_)} — fix: ${oneLine(fix)}`);
    this.name = "CliError";
  }
}

export const usage = (cause: string, fix: string) => new CliError(cause, fix, EXIT.usage);

export function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

const secrets = new Set<string>();

/** Register a value so redact() removes it from every line the CLI prints. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(s: string): string {
  let out = s;
  for (const v of secrets) out = out.split(v).join("[redacted]");
  return out
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g, "[redacted-telegram]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, "$1[redacted]")
    .replace(/(cf-aig-authorization["']?\s*[:=]\s*["']?)(Bearer\s+)?[A-Za-z0-9._-]{20,}/gi, "$1[redacted]")
    .replace(/(\/_ochost\/login\/)[A-Za-z0-9_-]+/g, "$1[redacted]");
}

/** Any thrown value → one redacted "Failed: … — fix: …" line and its exit code. */
export function toFailed(e: unknown): { line: string; code: number } {
  if (e instanceof CliError) return { line: redact(e.message), code: e.code };
  const cause = rootCause(e);
  const msg = (e instanceof Error ? e.message : String(e)) + (cause ? ` (${cause})` : "");
  if (/^Failed: .* — fix: /.test(msg)) {
    // errors from ui.ts / ai-gateway.ts carry their exit code as `exit` (D5: channels add without a token is 3)
    const x = e as { exit?: unknown; code?: unknown } | null;
    const c = Number(x?.exit ?? x?.code);
    return { line: redact(oneLine(msg)), code: Number.isInteger(c) && c > 0 ? c : EXIT.failed };
  }
  return {
    line: redact(
      `Failed: ${oneLine(msg) || "unknown error"} — fix: rerun with OCHOST_DEBUG=1 and report the output`,
    ),
    code: EXIT.failed,
  };
}

// ---------------------------------------------------------------- argv

export type FlagSpec = Record<string, { type: "boolean" | "string"; short?: string; multi?: boolean }>;
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Common flags of every command (§1.1). */
export const COMMON: FlagSpec = {
  dir: { type: "string" },
  json: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const all = { ...COMMON, ...spec };
  const flags: ParsedArgs["flags"] = {};
  const positionals: string[] = [];
  const byShort = new Map<string, string>();
  for (const [name, s] of Object.entries(all)) if (s.short) byShort.set(s.short, name);
  const put = (name: string, v: string) => {
    const s = all[name];
    if (s?.multi) flags[name] = [...((flags[name] as string[] | undefined) ?? []), v];
    else flags[name] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      inline = eq === -1 ? undefined : a.slice(eq + 1);
      if (!all[name] && name.startsWith("no-") && all[name.slice(3)]?.type === "boolean") {
        flags[name.slice(3)] = false;
        continue;
      }
      if (!all[name]) throw usage(`unknown flag --${name}`, "run ochost <command> -h");
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      name = byShort.get(a.slice(1));
      if (!name) throw usage(`unknown flag ${a}`, "run ochost <command> -h");
    } else {
      positionals.push(a);
      continue;
    }
    const s = all[name] as FlagSpec[string];
    if (s.type === "boolean") {
      if (inline !== undefined && !/^(true|false|1|0)$/.test(inline))
        throw usage(`--${name} takes no value`, `use --${name} or --no-${name}`);
      flags[name] = inline === undefined ? true : inline === "true" || inline === "1";
      continue;
    }
    if (inline === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-"))
        throw usage(`--${name} needs a value`, `pass --${name} <value>`);
      inline = next;
      i++;
    }
    put(name, inline);
  }
  return { positionals, flags };
}

export const flagStr = (p: ParsedArgs, n: string): string | undefined =>
  typeof p.flags[n] === "string" ? (p.flags[n] as string) : undefined;
export const flagBool = (p: ParsedArgs, n: string): boolean => p.flags[n] === true;

export function flagInt(p: ParsedArgs, n: string, dflt: number, min = 1, max = 1_000_000): number {
  const v = flagStr(p, n);
  if (v === undefined) return dflt;
  const x = Number(v);
  if (!Number.isInteger(x) || x < min || x > max)
    throw usage(`--${n} must be a whole number ${min}-${max}`, `pass --${n} <number>`);
  return x;
}

// ---------------------------------------------------------------- output

export interface Out {
  json: boolean;
  /** result text (stdout); not in --json mode */
  line(s: string): void;
  /** progress (stderr) */
  step(s: string): void;
  /** "WARN: …" (stderr) */
  warn(s: string): void;
  /** final JSON document (stdout); only in --json mode. `raw` skips the pattern redaction (login links). */
  result(v: unknown, o?: { raw?: boolean }): void;
  /** One line for the owner that must not be redacted (a login link). stdout, also in --json mode. */
  secretLine(s: string): void;
}

export interface Sink {
  stdout(s: string): void;
  stderr(s: string): void;
}
export const processSink: Sink = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

export function makeOut(json: boolean, sink: Sink = processSink): Out {
  return {
    json,
    line: (s) => {
      if (!json) sink.stdout(`${redact(s)}\n`);
    },
    step: (s) => sink.stderr(`${redact(s)}\n`),
    warn: (s) => sink.stderr(`WARN: ${redact(s)}\n`),
    result: (v, o) => {
      const t = JSON.stringify(v, null, 2);
      if (json) sink.stdout(`${o?.raw ? t : redact(t)}\n`);
    },
    secretLine: (s) => sink.stdout(`${s}\n`),
  };
}

/** Plain text table, columns sized to content. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

/** Two-column key/value block. */
export function kv(rows: [string, string][]): string {
  const w = Math.max(0, ...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n");
}

/** Age or time-left in short units: 45s, 12m, 3h, 2d. */
export function fmtDur(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export function fmtAgo(at: number | null | undefined, now: number): string {
  if (at == null || !Number.isFinite(at) || at <= 0) return "-";
  return at > now ? `in ${fmtDur(at - now)}` : `${fmtDur(now - at)} ago`;
}

export const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

export function fmtTime(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------- process runner and prompts

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (
  cmd: string,
  args: string[],
  o?: { input?: string; env?: Record<string, string | undefined>; cwd?: string },
) => Promise<RunResult>;

export const runProcess: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      stdout += d;
    });
    p.stderr.on("data", (d) => {
      stderr += d;
    });
    p.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    p.stdin.end(o.input ?? "");
  });

export interface Prompts {
  ask(q: string): Promise<string>;
  askHidden(q: string): Promise<string>;
}

export const ttyPrompts: Prompts = {
  async ask(q) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  },
  async askHidden(q) {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      process.stderr.write(q);
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: stdin });
      const line = await new Promise<string>((res) => rl.once("line", res).once("close", () => res("")));
      rl.close();
      process.stderr.write("\n");
      return line.trim();
    }
    return new Promise<string>((resolve, reject) => {
      let buf = "";
      const done = () => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
      };
      const onData = (d: Buffer) => {
        for (const ch of d.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            done();
            process.stderr.write("\n");
            resolve(buf.trim());
            return;
          }
          if (ch === "\u0003") {
            done();
            process.stderr.write("\n");
            reject(new CliError("interrupted", "run the command again", EXIT.interrupted));
            return;
          }
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else if (ch >= " ") buf += ch;
        }
      };
      // Echo off before the prompt shows, so input typed or pasted on the prompt never echoes.
      stdin.setRawMode(true);
      process.stderr.write(q);
      stdin.resume();
      stdin.on("data", onData);
    });
  },
};

// ---------------------------------------------------------------- context

export interface OpsCtx {
  dir: string;
  args: ParsedArgs;
  out: Out;
  fetch: typeof fetch;
  run: Runner;
  prompts: Prompts;
  env: Record<string, string | undefined>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Aborts follow/watch loops (SIGINT in the CLI, a counter in tests). */
  signal?: AbortSignal;
  nonInteractive: boolean;
}

export function makeCtx(argv: string[], spec: FlagSpec, over: Partial<OpsCtx> = {}, sink?: Sink): OpsCtx {
  const args = parseArgs(argv, spec);
  const json = flagBool(args, "json");
  return {
    dir: flagStr(args, "dir") ?? process.cwd(),
    args,
    out: makeOut(json, sink),
    fetch: globalThis.fetch,
    run: runProcess,
    prompts: ttyPrompts,
    env: process.env,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nonInteractive: flagBool(args, "non-interactive") || !process.stdin.isTTY,
    ...over,
  };
}

/** y/N question. --non-interactive without `yes` → exit 3 with the fix. */
export async function confirm(ctx: OpsCtx, q: string, yesFlag: string): Promise<boolean> {
  if (flagBool(ctx.args, yesFlag)) return true;
  if (ctx.nonInteractive) throw new CliError(`${q} needs a yes`, `rerun with --${yesFlag}`, EXIT.manual);
  const a = await ctx.prompts.ask(`${q} [y/N] `);
  return /^y(es)?$/i.test(a);
}

export const randomHex = (bytes = 32) => randomBytes(bytes).toString("hex");

// ---------------------------------------------------------------- install state and the owner token

export const STATE_DIR = ".oc-host";

export interface Install {
  url: string;
  inst: string;
  accountId: string;
  name: string;
  token: string;
  /** Raw state.json (other fields the init writes). */
  state: Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads `.oc-host/state.json` and the owner token. Token source, in order: env `OCHOST_CONTROL_TOKEN`,
 * `.oc-host/control-token` (mode 0600; a wider mode is a WARN).
 */
export function loadInstall(ctx: OpsCtx): Install {
  const sd = join(ctx.dir, STATE_DIR);
  const st = readJson(join(sd, "state.json"));
  const noInstall = new CliError(
    `no oc-host install in ${ctx.dir}`,
    "run ochost init, or ochost init --adopt",
  );
  if (!st || typeof st.url !== "string" || !st.url) throw noInstall;
  let token = ctx.env.OCHOST_CONTROL_TOKEN?.trim() ?? "";
  if (!token) {
    const tp = join(sd, "control-token");
    try {
      token = readFileSync(tp, "utf8").trim();
      const mode = statSync(tp).mode & 0o777;
      if (mode & 0o077) ctx.out.warn(`${tp} has mode ${mode.toString(8)} — fix: chmod 600 ${tp}`);
    } catch {
      throw new CliError(
        `no owner token at ${join(STATE_DIR, "control-token")}`,
        "run ochost init (it keeps the token), or ochost auth rotate --control",
      );
    }
  }
  if (!token) throw new CliError("the owner token file is empty", "run ochost auth rotate --control");
  registerSecret(token);
  const url = st.url.replace(/\/+$/, "");
  return {
    url: /^https?:\/\//.test(url) ? url : `https://${url}`,
    inst: String(st.inst ?? ""),
    accountId: String(st.accountId ?? ""),
    name: String(st.name ?? st.workerName ?? "oc-host"),
    token,
    state: st,
  };
}

/** `oc-host.jsonc` as plain data (comments and trailing commas removed); null when missing or bad. */
export function readHostConfig(dir: string): Record<string, any> | null {
  let t: string;
  try {
    t = readFileSync(join(dir, "oc-host.jsonc"), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(stripJsonc(t)) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Remove // and /* *\/ comments outside strings, and trailing commas. */
export function stripJsonc(t: string): string {
  let o = "";
  let i = 0;
  let str = false;
  while (i < t.length) {
    const ch = t[i] as string;
    if (str) {
      o += ch;
      if (ch === "\\") {
        o += t[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') str = false;
      i++;
      continue;
    }
    if (ch === '"') {
      str = true;
      o += ch;
      i++;
      continue;
    }
    if (ch === "/" && t[i + 1] === "/") {
      while (i < t.length && t[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && t[i + 1] === "*") {
      const end = t.indexOf("*/", i + 2);
      i = end === -1 ? t.length : end + 2;
      continue;
    }
    o += ch;
    i++;
  }
  return o.replace(/,(\s*[}\]])/g, "$1");
}

// ---------------------------------------------------------------- /ops client

export interface OpsRes<T = any> {
  status: number;
  body: T;
  ms: number;
}

export interface OpsClient {
  install: Install;
  call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    o?: { timeoutMs?: number; allow?: number[] },
  ): Promise<OpsRes<T>>;
}

/**
 * POST /ops/restart after a deploy waits up to 180 s for a pre-restart archive (worker ctl/control.ts
 * RESTART_ARCHIVE_WAIT_MS), then stops and starts. The call gets that much time and a margin.
 */
export const RESTART_CALL_MS = 240_000;

/** Tries per GET in the ops client when the network fails (see transientNetError). */
export const OPS_GET_TRIES = 3;

/** Codes of a network failure that a second try can fix (reset or closed socket, connect timeout, DNS). */
const TRANSIENT = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CLOSED",
]);

/** True when an error (or a cause in its chain) is a network failure worth one more try. */
export function transientNetError(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x instanceof Error && i < 6; x = x.cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT.has(code)) return true;
    if (x.name === "TypeError" && x.message === "terminated") return true; // body stream cut
  }
  return false;
}

/**
 * Owner calls to `<url>/ops/*` with `Authorization: Bearer <CONTROL_TOKEN>` (spec 08 §19.2). A status not in
 * `allow` (default: 2xx) becomes a CliError. The Worker answers 404 for a wrong token and for an unknown route.
 */
export function opsClient(ctx: OpsCtx, install: Install = loadInstall(ctx)): OpsClient {
  return {
    install,
    async call(method, path, body, o = {}) {
      const url = `${install.url}${path.startsWith("/") ? path : `/${path}`}`;
      const t0 = ctx.now();
      const route = `${method} ${path.split("?")[0]}`;
      let res: Response | undefined;
      let text = "";
      for (let attempt = 1; !res; attempt++) {
        try {
          const r = await ctx.fetch(url, {
            method,
            headers: {
              authorization: `Bearer ${install.token}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
          });
          text = await r.text();
          res = r;
        } catch (e) {
          if (ctx.env.OCHOST_DEBUG) ctx.out.step(`fetch ${method} ${url}: ${redact(causeChain(e))}`);
          // A GET is safe to repeat: a reset or closed socket (a lost keep-alive connection, a bad network)
          // is tried again. A POST is not (a restart must not run twice).
          if (method === "GET" && attempt < OPS_GET_TRIES && transientNetError(e)) {
            await ctx.sleep(1_000 * attempt);
            continue;
          }
          const why = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "did not answer";
          const cause = rootCause(e);
          throw new CliError(
            `${install.url} ${why} (${route}${cause ? `: ${cause}` : ""}${attempt > 1 ? `; ${attempt} tries` : ""})`,
            "check the network, then ochost status; ochost doctor lists the checks",
          );
        }
      }
      let parsed: any = text;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {}
      const r = { status: res.status, body: parsed, ms: ctx.now() - t0 };
      const ok = o.allow ? o.allow.includes(res.status) : res.status >= 200 && res.status < 300;
      if (!ok) throw opsError(method, path, r);
      return r;
    },
  };
}

export function opsError(method: string, path: string, r: { status: number; body: any }): CliError {
  const route = `${method} ${path.split("?")[0]}`;
  const err =
    typeof r.body === "object" && r.body ? String(r.body.error ?? "") : String(r.body).slice(0, 120);
  if (r.status === 404 && path.startsWith("/ops/status"))
    return new CliError(
      "the Worker refused the owner token (404 on /ops/status)",
      "check .oc-host/control-token; ochost auth rotate --control makes a new one",
    );
  if (r.status === 404)
    return new CliError(
      `${route} returned 404${err && err !== "not found" ? ` (${err})` : ""}`,
      "the Worker does not have this route yet; ochost deploy, or update oc-host",
    );
  if (r.status === 409 && err === "no-active-epoch")
    return new CliError("the install has no active epoch yet", "wait for provisioning; ochost status");
  if (r.status >= 500)
    return new CliError(
      `${route} returned ${r.status}${err ? ` (${err})` : ""}`,
      "rerun in 1 min; ochost logs --source ctl",
    );
  return new CliError(`${route} returned ${r.status}${err ? ` (${err})` : ""}`, "ochost status; ochost logs");
}

// ---------------------------------------------------------------- wrangler

/** `npx wrangler <args>` with the account of the install. */
export function wrangler(ctx: OpsCtx, install: Install, args: string[], input?: string): Promise<RunResult> {
  return ctx.run("npx", ["--no-install", "wrangler", ...args], {
    input,
    cwd: ctx.dir,
    env: {
      ...QUIET_ENV,
      ...jsonFormatEnv(args),
      ...(install.accountId ? { CLOUDFLARE_ACCOUNT_ID: install.accountId } : {}),
    },
  });
}

/** Set one Worker secret from stdin (the value never goes to argv). */
export async function putSecret(ctx: OpsCtx, install: Install, name: string, value: string): Promise<void> {
  registerSecret(value);
  const r = await wrangler(ctx, install, ["secret", "put", name, "--name", install.name], value);
  if (r.code !== 0)
    throw new CliError(
      `wrangler secret put ${name} failed: ${oneLine(redact(r.stderr || r.stdout)).slice(0, 200)}`,
      "run npx wrangler login, then rerun",
    );
}
