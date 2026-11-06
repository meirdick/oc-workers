// Worker secrets (spec 10 §2.3): which ones init generates, the keep rule, the local manifest (names and
// sha256 only, never values), the temp secrets file for `wrangler deploy --secrets-file` / `secret bulk`.
// withSecretsFile is copied from cf-orbs cli/src/project.ts.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onInterruptRemove, registerSecret } from "./ui.ts";

export const TEMP_PREFIX = "oc-host-";

/** Names init generates. The webhook secret has two names with one value (Worker check + gateway SecretRef). */
export const GENERATED = [
  "CONTROL_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "OC_SECRET_OC_TELEGRAM_WEBHOOK_SECRET",
  "OC_SECRET_OC_GATEWAY_TOKEN",
] as const;
/** Before the zero-token install the AI token was a Worker secret. Now unused; init warns when it is still there. */
export const AI_SECRET = "OC_SECRET_OC_CF_AI_TOKEN";
const WEBHOOK_PAIR = ["TELEGRAM_WEBHOOK_SECRET", "OC_SECRET_OC_TELEGRAM_WEBHOOK_SECRET"] as const;

export interface ManifestEntry {
  name: string;
  sha256: string;
  setAt: string;
}
export type Manifest = Record<string, ManifestEntry>;

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

export async function readManifest(path: string): Promise<Manifest> {
  try {
    const j = JSON.parse(await readFile(path, "utf8")) as ManifestEntry[];
    return Object.fromEntries(j.map((e) => [e.name, e]));
  } catch {
    return {};
  }
}

export async function writeManifest(path: string, m: Manifest): Promise<void> {
  const rows = Object.values(m)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, sha256: e.sha256, setAt: e.setAt }));
  await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`);
}

/** Record the values just sent to the Worker. */
export function updateManifest(m: Manifest, sent: Record<string, string>, now: Date): Manifest {
  const out = { ...m };
  for (const [name, v] of Object.entries(sent))
    out[name] = { name, sha256: sha256(v), setAt: now.toISOString() };
  return out;
}

export interface SecretPlanInput {
  /** names on the Worker (wrangler secret list); undefined = no Worker yet */
  onWorker: string[] | undefined;
  manifest: Manifest;
  /** CONTROL_TOKEN from .oc-host/control-token, if any */
  localControlToken?: string;
  /** adopt: the old CONTROL_TOKEN is unknown here, so make a new one */
  adopt: boolean;
}

export interface SecretPlan {
  /** name → value to send now */
  send: Record<string, string>;
  /** names kept on the Worker as they are */
  keep: string[];
  /** CONTROL_TOKEN value to write to .oc-host/control-token (new or reused) */
  controlToken: string;
}

/**
 * Keep rule (spec 10 §2.3, cf-orbs init.ts:168-196): generate only names missing on the Worker. A value the
 * CLI holds (control token file) is re-sent, not replaced, when the Worker lacks it (interrupted deploy).
 */
export function planSecrets(i: SecretPlanInput, gen: () => string = generateSecret): SecretPlan {
  const have = new Set(i.onWorker ?? []);
  const send: Record<string, string> = {};
  const keep: string[] = [];
  // CONTROL_TOKEN
  let controlToken = i.localControlToken;
  if (i.adopt || !controlToken) controlToken = gen();
  const ctSha = sha256(controlToken);
  if (!have.has("CONTROL_TOKEN") || i.manifest.CONTROL_TOKEN?.sha256 !== ctSha)
    send.CONTROL_TOKEN = controlToken;
  else keep.push("CONTROL_TOKEN");
  // webhook secret pair: both or neither
  if (WEBHOOK_PAIR.every((n) => have.has(n))) keep.push(...WEBHOOK_PAIR);
  else {
    const v = gen();
    for (const n of WEBHOOK_PAIR) send[n] = v;
  }
  if (have.has("OC_SECRET_OC_GATEWAY_TOKEN")) keep.push("OC_SECRET_OC_GATEWAY_TOKEN");
  else send.OC_SECRET_OC_GATEWAY_TOKEN = gen();
  return { send, keep, controlToken };
}

/**
 * Write secrets to a temp JSON file (0600, in a fresh 0700 temp dir), run fn, delete in finally.
 * SIGINT also deletes it (ui.installSigint).
 */
export async function withSecretsFile<T>(
  secrets: Record<string, string>,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  await chmod(dir, 0o700);
  const unregister = onInterruptRemove(dir);
  const file = join(dir, "secrets.json");
  try {
    for (const v of Object.values(secrets)) registerSecret(v);
    await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
    unregister();
  }
}

/** Delete stale oc-host-* temp dirs older than 1 h (left by a kill -9). Returns how many. */
export async function sweepTemp(now = Date.now(), dir = tmpdir()): Promise<number> {
  let n = 0;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (s.isDirectory() && now - s.mtimeMs > 3_600_000) {
        await rm(p, { recursive: true, force: true });
        n++;
      }
    } catch {}
  }
  return n;
}

/** Read a token file. Warns (via the callback) when the mode is wider than 0600. */
export async function readTokenFile(path: string, warn: (l: string) => void): Promise<string> {
  const s = await stat(path);
  if ((s.mode & 0o077) !== 0)
    warn(`${path} is readable by others (mode ${(s.mode & 0o777).toString(8)}) — fix: chmod 600 ${path}`);
  const raw = (await readFile(path, "utf8")).trim();
  // accept a bare token or one KEY=value line (env file)
  const m = /^(?:export\s+)?[A-Z0-9_]+=["']?([^"'\s]+)["']?$/m.exec(raw);
  return m ? (m[1] as string) : raw;
}

export async function writeControlToken(path: string, dir: string, token: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  registerSecret(token);
}

export async function readControlToken(path: string): Promise<string | undefined> {
  try {
    const t = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(t)) return undefined;
    registerSecret(t);
    return t;
  } catch {
    return undefined;
  }
}
