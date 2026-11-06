// Child processes (wrangler, docker) and the Cloudflare API calls init makes with wrangler's own login.
// Runner and makeWrangler are copied from cf-orbs cli/src/wrangler.ts; subdomain calls from cf-orbs
// cli/src/subdomain.ts. Everything is injectable so tests use a fake runner and a fake fetch.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CliError, EXIT, registerSecret } from "./ui.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** called with each output chunk (stdout and stderr) as it arrives */
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

export type Runner = (cmd: string, args: string[], o?: RunOptions) => Promise<RunResult>;
export type Fetch = typeof fetch;

/** Spawn without a shell; stdin closed so wrangler runs non-interactive (its confirms take the fallback). */
export const runProcess: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (o.timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), o.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      o.onOutput?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      o.onOutput?.(s);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

export const WRANGLER_VERSION = "4.156.0";

/** Keeps wrangler and npx quiet: no banner, no colour, no update notice, errors only. Output is piped anyway. */
export const QUIET_ENV: Record<string, string> = {
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG: "error",
  WRANGLER_HIDE_BANNER: "true",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  NO_UPDATE_NOTIFIER: "1",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
};

/** [command, ...prefix args] that runs the pinned wrangler. Prefers the CLI's own dependency over npx. */
export function wranglerCommand(): [string, string[]] {
  try {
    const req = createRequire(import.meta.url);
    const bin = join(dirname(req.resolve("wrangler/package.json")), "bin", "wrangler.js");
    if (existsSync(bin)) return [process.execPath, [bin]];
  } catch {}
  return [process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", `wrangler@${WRANGLER_VERSION}`]];
}

export interface Wrangler {
  run(args: string[], o?: RunOptions): Promise<RunResult>;
}

/** The first two argv entries of every wrangler call (tests match on args after them). */
/**
 * `--format json` and `containers images list --json` print through the log level, so WRANGLER_LOG=error would leave
 * stdout empty (M8 live: destroy planned "0 registry image tag(s)" and left 35 behind).
 */
export function jsonFormatEnv(args: string[]): Record<string, string> {
  const i = args.indexOf("--format");
  if (i >= 0 && args[i + 1] === "json") return { WRANGLER_LOG: "log" };
  return args.includes("--json") ? { WRANGLER_LOG: "log" } : {};
}

export const WRANGLER_PREFIX_LEN = wranglerCommand()[1].length;

export function makeWrangler(
  run: Runner = runProcess,
  base: { configPath?: string; accountId?: string } = {},
): Wrangler {
  const [cmd, prefix] = wranglerCommand();
  return {
    run(args, o = {}) {
      const full = [...prefix, ...args];
      if (base.configPath && !args.includes("--config")) full.push("--config", base.configPath);
      return run(cmd, full, {
        ...o,
        env: {
          ...QUIET_ENV,
          ...jsonFormatEnv(args),
          ...(base.accountId ? { CLOUDFLARE_ACCOUNT_ID: base.accountId } : {}),
          ...o.env,
        },
      });
    },
  };
}

// ---------------------------------------------------------------- wrangler output parsing

export interface Account {
  id: string;
  name: string;
}

export interface WhoAmI {
  loggedIn: boolean;
  email?: string;
  accounts: Account[];
}

/** Parse `wrangler whoami --json`. */
export function parseWhoami(stdout: string): WhoAmI {
  const start = stdout.indexOf("{");
  if (start === -1) return { loggedIn: false, accounts: [] };
  try {
    const j = JSON.parse(stdout.slice(start)) as {
      loggedIn?: boolean;
      email?: string;
      accounts?: { id: string; name: string }[];
    };
    return {
      loggedIn: j.loggedIn === true,
      email: j.email,
      accounts: (j.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
    };
  } catch {
    return { loggedIn: false, accounts: [] };
  }
}

export async function whoami(w: Wrangler): Promise<WhoAmI> {
  const r = await w.run(["whoami", "--json"], { timeoutMs: 60_000 });
  if (r.code !== 0) return { loggedIn: false, accounts: [] };
  return parseWhoami(r.stdout);
}

export async function dockerOk(run: Runner): Promise<boolean> {
  const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  return r.code === 0;
}

/** Bearer for the Cloudflare API from `wrangler auth token --json` (OAuth or API token). Never printed. */
export async function wranglerBearer(w: Wrangler): Promise<string | undefined> {
  const r = await w.run(["auth", "token", "--json"], { timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf("{")))) as { token?: string };
    if (typeof j.token !== "string" || !j.token) return undefined;
    registerSecret(j.token);
    return j.token;
  } catch {
    return undefined;
  }
}

/** Secret names on the Worker (`wrangler secret list --format json`). undefined = no Worker or no answer. */
export async function secretNames(w: Wrangler, name: string): Promise<string[] | undefined> {
  const r = await w.run(["secret", "list", "--format", "json", "--name", name], { timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf("[")))) as { name: string }[];
    return j.map((s) => s.name);
  } catch {
    return undefined;
  }
}

/** `wrangler secret bulk <file>`: puts all secrets in the file in one request (one new Worker version). */
export async function secretBulk(w: Wrangler, name: string, file: string): Promise<void> {
  const r = await w.run(["secret", "bulk", file, "--name", name], { timeoutMs: 120_000 });
  if (r.code !== 0)
    throw new CliError(
      `wrangler secret bulk failed: ${lastLine(`${r.stdout}\n${r.stderr}`)}`,
      "rerun ochost init; nothing else changed",
    );
}

/** `wrangler r2 bucket create <name>`; an existing bucket is ok. */
export async function bucketCreate(w: Wrangler, bucket: string): Promise<"created" | "exists"> {
  const r = await w.run(["r2", "bucket", "create", bucket], { timeoutMs: 120_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0) return "created";
  if (/already exists|10004/i.test(out)) return "exists";
  if (/10042|NotEntitled|R2 subscription|enable R2/i.test(out)) throw r2NotEnabled();
  throw new CliError(`could not create R2 bucket ${bucket}: ${lastLine(out)}`, "rerun ochost init");
}

export function lastLine(output: string): string {
  const clean = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /\[ERROR\]/.test(l));
  const pick = err
    ? err.replace(/^.*\[ERROR\]\s*/, "")
    : [...lines].reverse().find((l) => !/Logs were written/.test(l));
  return (pick ?? "no output").slice(0, 300);
}

// ---------------------------------------------------------------- Cloudflare API

export const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfEnvelope<T = unknown> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
  [k: string]: unknown;
}

export interface CfResponse<T = unknown> {
  status: number;
  j: CfEnvelope<T>;
}

export interface CfClient {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<CfResponse<T>>;
}

/** CF API client. 429 and 5xx get 3 tries with 1 s, 2 s, 4 s waits (spec 10 §2.2). */
export function makeCf(
  f: Fetch,
  bearer: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): CfClient {
  return {
    async call<T>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
      let last: CfResponse<T> = { status: 0, j: {} };
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
        let res: Response;
        try {
          res = await f(`${CF_API}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${bearer}`,
              accept: "application/json",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20_000),
          });
        } catch (e) {
          last = { status: 0, j: { errors: [{ message: (e as Error).message }] } };
          continue;
        }
        let j: CfEnvelope<T> = {};
        try {
          j = (await res.json()) as CfEnvelope<T>;
        } catch {}
        last = { status: res.status, j };
        if (res.status !== 429 && res.status < 500) return last;
      }
      return last;
    },
  };
}

export function cfErrCodes(j: CfEnvelope): number[] {
  return (j.errors ?? []).map((e) => Number(e.code ?? 0));
}

export function cfErrText(j: CfEnvelope): string {
  return (j.errors ?? [])
    .map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim())
    .join("; ")
    .slice(0, 200);
}

const ok = (r: CfResponse) => r.status >= 200 && r.status < 300 && r.j.success !== false;

/**
 * Workers Paid probe (spec 10 §2.4 step 2): GET /containers/me. Measured on a paid account:
 * {"success":true,"limits":{"total_vcpu":1500,...}} (limits at the top level, not in result).
 * guess: a Free account answers an error or zero limits.
 */
export async function workersPaid(cf: CfClient, accountId: string): Promise<boolean | "unknown"> {
  const r = await cf.call<{ limits?: { total_vcpu?: number } }>(
    "GET",
    `/accounts/${accountId}/containers/me`,
  );
  if (r.status === 0) return "unknown";
  const limits = (r.j.limits ?? r.j.result?.limits) as { total_vcpu?: number } | undefined;
  return ok(r) && Number(limits?.total_vcpu ?? 0) > 0;
}

/** R2 probe (spec 10 §2.7). 10042 NotEntitled = R2 not enabled on the account. */
export async function r2Active(cf: CfClient, accountId: string): Promise<boolean | "unknown"> {
  const r = await cf.call("GET", `/accounts/${accountId}/r2/buckets?per_page=1`);
  if (r.status === 0) return "unknown";
  if (cfErrCodes(r.j).includes(10042)) return false;
  return ok(r) ? true : "unknown";
}

export function r2NotEnabled(): CliError {
  return new CliError(
    "R2 is not enabled on this account",
    "open https://dash.cloudflare.com/?to=/:account/r2/overview, enable R2 (no charge under the free tier), then rerun",
    EXIT.manual,
  );
}

export type SubdomainCheck = { kind: "has"; subdomain: string } | { kind: "none" } | { kind: "unknown" };

export async function checkSubdomain(cf: CfClient, accountId: string): Promise<SubdomainCheck> {
  const r = await cf.call<{ subdomain?: string }>("GET", `/accounts/${accountId}/workers/subdomain`);
  // measured: {"success":true,"subdomain":"mdick85"}; the API docs put it in result
  const sub = r.j.result?.subdomain ?? (r.j.subdomain as string | undefined);
  if (ok(r) && typeof sub === "string" && sub) return { kind: "has", subdomain: sub };
  if (r.status === 404 || /subdomain/i.test(cfErrText(r.j))) return { kind: "none" };
  return { kind: "unknown" };
}

export const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export async function registerSubdomain(cf: CfClient, accountId: string, name: string): Promise<void> {
  const fix = "pick another name and rerun ochost init --subdomain <name>";
  if (!SUBDOMAIN_RE.test(name))
    throw new CliError(
      `workers.dev subdomain ${JSON.stringify(name)} is not valid (a-z, 0-9, -; max 63)`,
      fix,
    );
  const r = await cf.call("PUT", `/accounts/${accountId}/workers/subdomain`, { subdomain: name });
  if (!ok(r))
    throw new CliError(
      `could not register workers.dev subdomain ${name} (HTTP ${r.status} ${cfErrText(r.j)})`,
      fix,
    );
}

/** Default subdomain from the account name: lowercase, [a-z0-9-], max 63. */
export function suggestSubdomain(accountName: string | undefined): string {
  const s = (accountName ?? "")
    .toLowerCase()
    .replace(/'s account$/, "")
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return s || "oc-host";
}

export interface WorkerInfo {
  exists: boolean;
  /** plain-text vars from the Worker settings (adopt reads OC_INST and the bucket) */
  vars?: Record<string, string>;
  bucket?: string;
}

/** Does Worker <name> exist; if so, read its bindings (vars and the BUCKET R2 binding). */
export async function workerInfo(
  cf: CfClient,
  accountId: string,
  name: string,
): Promise<WorkerInfo | "unknown"> {
  const r = await cf.call<{
    bindings?: { type: string; name: string; text?: string; bucket_name?: string }[];
  }>("GET", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`);
  if (r.status === 404 || cfErrCodes(r.j).includes(10007)) return { exists: false };
  if (!ok(r)) return "unknown";
  const vars: Record<string, string> = {};
  let bucket: string | undefined;
  for (const b of r.j.result?.bindings ?? []) {
    if (b.type === "plain_text" && typeof b.text === "string") vars[b.name] = b.text;
    if (b.type === "r2_bucket" && b.name === "BUCKET") bucket = b.bucket_name;
  }
  return { exists: true, vars, bucket };
}
