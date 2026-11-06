// oc-host.jsonc: defaults, load, validate, edit (spec 10 §2.5), and the OpenClaw config ver 1 that init
// posts to /ops/config (§2.8). JSONC helpers copied from cf-orbs cli/src/config.ts (:92-296).
import { readFile } from "node:fs/promises";
import {
  checkRelations,
  checkValue,
  defaultsFlat,
  fileOf,
  flatten,
  SPECS,
  specOfFile,
} from "../../worker/src/core/tunables.ts";
import { CliError } from "./ui.ts";

export const CONFIG_FILE = "oc-host.jsonc";
const FIX = `edit ${CONFIG_FILE}, then rerun ochost deploy`;

// ---------- JSONC ----------

/** Remove // and /* *\/ comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas: a comma followed only by whitespace and then } or ]
  let res = "";
  for (let j = 0; j < out.length; j++) {
    const c = out[j] as string;
    if (c === '"') {
      const end = stringEnd(out, j);
      res += out.slice(j, end);
      j = end - 1;
      continue;
    }
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k] as string)) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }
    res += c;
  }
  return res;
}

/** Index just past the closing quote of the string starting at i. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === '"') return j + 1;
    else j++;
  }
  return text.length;
}

export function parseJsonc(text: string, file = CONFIG_FILE): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new CliError(`${file} is not valid JSONC (${(e as Error).message})`, `fix the syntax in ${file}`);
  }
}

/**
 * Set a top-level key in a JSONC object text, keeping comments elsewhere.
 * Replaces the value if the key exists, else inserts it before the closing brace.
 */
export function setTopLevelJsonc(text: string, key: string, value: unknown, indent = "  "): string {
  const json = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
  const span = findTopLevelValue(text, key);
  if (span) return text.slice(0, span.start) + json + text.slice(span.end);
  const close = text.lastIndexOf("}");
  if (close === -1)
    throw new CliError(
      `${CONFIG_FILE} has no top-level object`,
      `delete ${CONFIG_FILE} and rerun ochost init (it writes the defaults)`,
    );
  // find last non-space, non-comment char before close to decide on a comma
  const before = stripJsonc(text.slice(0, close)).trimEnd();
  const needComma = !before.endsWith("{") && !before.endsWith(",");
  let head = text.slice(0, close).replace(/\s*$/, "");
  if (needComma) head = insertCommaAfterLastValue(head);
  return `${head}\n${indent}${JSON.stringify(key)}: ${json}\n${text.slice(close)}`;
}

function insertCommaAfterLastValue(head: string): string {
  // walk back over trailing line comments to put the comma after the last value, not inside a comment
  const lines = head.split("\n");
  for (let li = lines.length - 1; li >= 0; li--) {
    const code = stripJsonc(lines[li] as string).trimEnd();
    if (code === "") continue;
    const line = lines[li] as string;
    // position of the end of the code part in the original line
    const idx = codeEndIndex(line);
    lines[li] = `${line.slice(0, idx)},${line.slice(idx)}`;
    return lines.join("\n");
  }
  return `${head},`;
}

function codeEndIndex(line: string): number {
  let i = 0;
  let last = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '"') {
      i = stringEnd(line, i);
      last = i;
    } else if (c === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) break;
    else {
      if (!/\s/.test(c)) last = i + 1;
      i++;
    }
  }
  return last;
}

/** Locate the value of a top-level key: [start, end) in the original text. */
export function findTopLevelValue(text: string, key: string): { start: number; end: number } | undefined {
  let depth = 0;
  let i = 0;
  const n = text.length;
  let expectKey = false;
  while (i < n) {
    const c = text[i] as string;
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"') {
      const end = stringEnd(text, i);
      if (depth === 1 && expectKey) {
        const k = JSON.parse(text.slice(i, end)) as string;
        let j = skipWs(text, end);
        if (text[j] === ":" && k === key) {
          j = skipWs(text, j + 1);
          return { start: j, end: valueEnd(text, j) };
        }
      }
      i = end;
      expectKey = false;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      expectKey = c === "{" && depth === 1;
    } else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 1) expectKey = true;
    i++;
  }
  return undefined;
}

function skipWs(text: string, i: number): number {
  let j = i;
  for (;;) {
    while (j < text.length && /\s/.test(text[j] as string)) j++;
    if (text[j] === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
    } else if (text[j] === "/" && text[j + 1] === "*") {
      const e = text.indexOf("*/", j + 2);
      j = e === -1 ? text.length : e + 2;
    } else return j;
  }
}

function valueEnd(text: string, start: number): number {
  const c = text[start];
  if (c === '"') return stringEnd(text, start);
  if (c === "{" || c === "[") {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e === -1 ? text.length : e + 2;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && !/[,}\]\s/]/.test(text[i] as string)) i++;
  return i;
}

// ---------- oc-host.jsonc ----------

export interface Instance {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}

export interface OcHostConfig {
  baseVersion?: number;
  name: string;
  inst: string;
  accountId?: string;
  /** "vcpu/GiB/GB" or an object */
  instance: string | Instance;
  /** R2 bucket; default oc-host-<inst>. Test groups set oc-m5-<group>. */
  bucket?: string;
  timezone: string;
  sleep: {
    mode: "auto" | "off";
    idleMinutes: number;
    minAwakeMinutes: number;
    minSleepMinutes: number;
    uiIdleMinutes: number;
    uiMaxMinutes: number;
    maxAwakeHours: number;
    costGuard: "auto" | "off";
    snapshotCostUsd: number;
    proactive: string;
  };
  /** maxUptimeHours is the old name of sleep.maxAwakeHours; it still counts when that key is absent. */
  maintenance: { hour: number; maxUptimeHours?: number };
  /** Cold-path Telegram messages (docs/13-cold-reply.md). */
  telegram?: { wakeProgress?: "delete" | "ready" | "off" };
  /** docs/12: agent exec and file tools in the SandboxSession container. Absent = off. */
  sandbox?: "on" | "off";
  upgrade: { track: string; auto: boolean };
  alerts: { channel: "ntfy" | "webhook" | "none"; dedupeMinutes?: number; minSeverity?: string };
  llm: {
    gateway: string;
    primary: string;
    fallbacks: string[];
    spendLimitUsd: number | null;
  };
  checkpoint?: { intervalMinutes?: number; maxPerDay?: number };
  snapshots?: { maxPerDay?: number };
  archive?: { everyHours?: number; minGapMinutes?: number; maxPerDay?: number; drillEveryDays?: number };
  chain?: { rebaseAfterHours?: number; rebaseAfterSnapshots?: number; tagWarn?: number };
  gens?: { churnPerDay?: number };
  storage?: { pruneAtMb?: number; refuseAtMb?: number };
  cost?: { releaseBelowPct?: number };
  login?: {
    sessionDays?: number;
    maxSessions?: number;
    codeMinutes?: number;
    rateLimits?: {
      windowMinutes?: number;
      ipFail?: number;
      ipTry?: number;
      allFail?: number;
      maxCodes?: number;
    };
  };
  idle?: { doubleCapMinutes?: number };
  cron?: { tailSeconds?: number; leadSeconds?: number };
  inbox?: { holdHours?: number; deadHours?: number };
}

export const DEFAULT_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
/** The gateway the Worker's AI binding uses. AI Gateway creates `default` on its first request; no API call. */
export const DEFAULT_GATEWAY = "default";
/** llm.gateway value for "no gateway": the binding runs without one (no logs, no spend limit). */
export const NO_GATEWAY = "none";
export const DEFAULT_INSTANCE = "2/6/20";

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The file init writes when none exists. Comments explain each key (spec 10 §2.5). */
export function defaultConfigText(o: {
  name: string;
  inst: string;
  accountId: string;
  instance?: string;
  bucket?: string;
  timezone?: string;
  gateway?: string;
  model?: string;
}): string {
  const bucketLine = o.bucket
    ? `\n  "bucket": ${JSON.stringify(o.bucket)},                // R2 bucket (default oc-host-<inst>)`
    : "";
  return `{
  // Generated by ochost init. Comments are kept on edit. Never edit .oc-host/wrangler.jsonc.
  "baseVersion": 0,                        // set by the CLI
  "name": ${JSON.stringify(o.name)},                       // Worker name; URL https://<name>.<sub>.workers.dev
  "inst": ${JSON.stringify(o.inst)},                       // 6 hex, random at init${o.bucket ? "" : "; bucket oc-host-<inst>"}
  "accountId": ${JSON.stringify(o.accountId)},${bucketLine}
  "instance": ${JSON.stringify(o.instance ?? DEFAULT_INSTANCE)},                    // vcpu/GiB/GB or {vcpu, memoryMib, diskMb}; floor 2/6/16 (D3)
  "timezone": ${JSON.stringify(o.timezone ?? defaultTimezone())},          // from the laptop; for proactive and maintenance
  "sandbox": "off",                        // on | off: agent exec and file tools in a Cloudflare sandbox (docs/12)
  "sleep": {
    "mode": "auto",                        // auto | off
    "idleMinutes": 5,                      // doubles after a quick re-wake, up to idle.doubleCapMinutes. Each extra awake minute: $0.000984 at 2/6/20
    "minAwakeMinutes": 2,                  // stay awake at least this long after boot
    "minSleepMinutes": 10,                 // no sleep when the next wake is closer
    "uiIdleMinutes": 15,                   // UI socket closes after this long without input
    "uiMaxMinutes": 60,                    // ...or this long without a chat message
    "maxAwakeHours": 16,                   // uptime limit: a restart when idle past it (6-72)
    "costGuard": "auto",                   // auto | off
    "snapshotCostUsd": 0.0045,             // per sleep, guess until the invoice
    "proactive": "2h@08-22"                // every 2 h, 08-22 local. off | openclaw | 30m | 1h | 2h[@HH-HH] | cron
  },
  "maintenance": { "hour": 4 },
  "telegram": { "wakeProgress": "delete" },   // message while it wakes: delete | ready ("Ready in N s") | off
  "upgrade": { "track": "extended-stable", "auto": false },  // auto is not built (M6): true is refused
  "alerts": { "channel": "none", "dedupeMinutes": 60, "minSeverity": "high" },  // channel: ntfy | webhook | none; set by ochost alerts setup
  "checkpoint": { "intervalMinutes": 60, "maxPerDay": 30 },
  "snapshots": { "maxPerDay": 40 },
  "archive": { "everyHours": 6, "minGapMinutes": 15, "maxPerDay": 24, "drillEveryDays": 30 },
  "chain": { "rebaseAfterHours": 24, "rebaseAfterSnapshots": 40, "tagWarn": 100 },
  "gens": { "churnPerDay": 10 },
  "storage": { "pruneAtMb": 1024, "refuseAtMb": 2048 },
  "cost": { "releaseBelowPct": 80 },
  "login": {
    "sessionDays": 30,
    "maxSessions": 20,
    "codeMinutes": 5,
    "rateLimits": { "windowMinutes": 10, "ipFail": 5, "ipTry": 20, "allFail": 30, "maxCodes": 10 }
  },
  "idle": { "doubleCapMinutes": 60 },
  "cron": { "tailSeconds": 120, "leadSeconds": 120 },
  "inbox": { "holdHours": 20, "deadHours": 23 },
  "llm": {
    "gateway": ${JSON.stringify(o.gateway ?? DEFAULT_GATEWAY)},                  // AI Gateway id for logs and limits; "default" is created on first use, "none" = no gateway
    "primary": ${JSON.stringify(o.model ?? DEFAULT_MODEL)},
    "fallbacks": [],
    "spendLimitUsd": null                  // monthly cap; ochost ai-gateway setup prints the dashboard step
  }
  // Channels: ochost channels list (they live in the Control DO).
}
`;
}

function fail(cause: string, fix = FIX): never {
  throw new CliError(cause, fix);
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INST_RE = /^[0-9a-f]{6}$|^[a-z0-9][a-z0-9-]{0,30}$/;
export const MODEL_RE = /^@cf\/[a-z0-9._-]+\/[A-Za-z0-9._-]+$|^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/;
const PROACTIVE_RE = /^(off|openclaw|(30m|1h|2h|3h|4h|6h|12h)(@([01]\d|2[0-3])-([01]\d|2[0-4]))?|cron)$/;

/** "2/6/20" → {vcpu 2, memoryMib 6144, diskMb 20000}. Checks the custom limits (D3; spec 10 §2.5). */
export function parseInstance(v: string | Instance): Instance {
  let i: Instance;
  if (typeof v === "string") {
    const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(v.trim());
    if (!m) fail(`instance ${JSON.stringify(v)} is not vcpu/GiB/GB (example 2/6/20)`);
    i = { vcpu: Number(m[1]), memoryMib: Number(m[2]) * 1024, diskMb: Number(m[3]) * 1000 };
  } else i = v;
  if (!Number.isInteger(i.vcpu) || i.vcpu < 1 || i.vcpu > 4) fail(`instance vcpu must be 1-4, got ${i.vcpu}`);
  if (i.memoryMib < i.vcpu * 3072) fail("instance needs at least 3 GiB per vCPU");
  if (i.memoryMib > 12 * 1024) fail("instance memory is at most 12 GiB");
  if (i.diskMb > 20_000) fail("instance disk is at most 20 GB");
  if (i.vcpu < 2 || i.memoryMib < 6144 || i.diskMb < 16_000)
    fail("instance is below the floor 2/6/16 (D3)", `set "instance": "2/6/20" in ${CONFIG_FILE}`);
  return i;
}

export function validateConfig(raw: unknown): OcHostConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${CONFIG_FILE} is not an object`);
  const c = raw as Partial<OcHostConfig> & Record<string, unknown>;
  if (typeof c.name !== "string" || !NAME_RE.test(c.name)) fail(`name must match ${NAME_RE}`);
  if (typeof c.inst !== "string" || !INST_RE.test(c.inst)) fail("inst must be 6 hex");
  if (c.bucket !== undefined && (typeof c.bucket !== "string" || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(c.bucket)))
    fail("bucket must be 3-63 chars a-z, 0-9, -");
  parseInstance((c.instance ?? DEFAULT_INSTANCE) as string | Instance);
  const s = c.sleep;
  if (!s || (s.mode !== "auto" && s.mode !== "off")) fail("sleep.mode must be auto or off");
  if (!PROACTIVE_RE.test(String(s.proactive)))
    fail(`sleep.proactive ${JSON.stringify(s.proactive)} is not valid`);
  if (c.sandbox !== undefined && c.sandbox !== "on" && c.sandbox !== "off") fail("sandbox must be on or off");
  const llm = c.llm;
  if (c.upgrade?.auto === true)
    fail(
      "upgrade.auto is true; automatic upgrades are not built yet (M6)",
      `set "auto": false in ${CONFIG_FILE}; upgrade by hand with ochost upgrade run`,
    );
  if (llm && llm.spendLimitUsd != null && !(typeof llm.spendLimitUsd === "number" && llm.spendLimitUsd > 0))
    fail("llm.spendLimitUsd must be a number above 0, or null");
  checkTunables(c);
  if (!llm || typeof llm.gateway !== "string" || !NAME_RE.test(llm.gateway))
    fail("llm.gateway must be a gateway id");
  if (typeof llm.primary !== "string" || !MODEL_RE.test(llm.primary))
    fail("llm.primary must be @cf/<org>/<name> or <provider>/<model>");
  return c as OcHostConfig;
}

/** Values of the tunable keys that the file sets, by file path. */
export function fileValues(c: unknown): Record<string, unknown> {
  const flat = flatten(c);
  const out: Record<string, unknown> = {};
  for (const sp of SPECS) {
    const f = fileOf(sp);
    if (flat[f] !== undefined) out[f] = flat[f];
  }
  return out;
}

/** Range, enum and relation checks of every tunable key the file sets (the Worker applies the same table). */
function checkTunables(c: unknown): void {
  const vals = fileValues(c);
  for (const [f, v] of Object.entries(vals)) {
    const bad = checkValue(specOfFile(f) as NonNullable<ReturnType<typeof specOfFile>>, v);
    if (bad) fail(bad);
  }
  const eff: Record<string, unknown> = { ...defaultsFlat() };
  for (const [f, v] of Object.entries(vals)) eff[(specOfFile(f) as { path: string }).path] = v;
  const rel = checkRelations(eff);
  if (rel[0]) fail(rel[0]);
}

export async function loadConfig(path: string): Promise<OcHostConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`${path} not found`, "run ochost init in this directory");
  }
  return validateConfig(parseJsonc(text));
}

export function bucketOf(c: Pick<OcHostConfig, "inst" | "bucket">): string {
  return c.bucket ?? `oc-host-${c.inst}`;
}

/**
 * OC_SETTINGS: the first value of the Worker's settings document, plus the fields only deploy knows. After
 * the first run the Worker keeps its own versioned copy: later edits go through `ochost config set <key>`
 * (PUT /ops/settings), not through a deploy. Keys the file omits are left out, so the Worker defaults apply.
 */
export function workerSettings(c: OcHostConfig, publicOrigin: string): Record<string, unknown> {
  const out: Record<string, any> = { publicOrigin };
  const set = (path: string, v: unknown) => {
    const ks = path.split(".");
    let cur = out;
    for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
    cur[ks[ks.length - 1] as string] = v;
  };
  const vals = fileValues(c);
  // maintenance.maxUptimeHours is the old name of sleep.maxAwakeHours
  if (vals["sleep.maxAwakeHours"] === undefined && c.maintenance?.maxUptimeHours !== undefined)
    vals["sleep.maxAwakeHours"] = c.maintenance.maxUptimeHours;
  for (const sp of SPECS) {
    const v = vals[fileOf(sp)];
    if (v !== undefined) set(sp.path, v);
  }
  // the file always sends these (the Worker has no way to know the zone)
  set("runtime.tz", c.timezone);
  // env-owned keys (not in the settings document): a change needs ochost deploy
  set("telegram.wakeProgress", c.telegram?.wakeProgress ?? "delete");
  set("sandbox", c.sandbox ?? "off");
  return out;
}

// ---------- OpenClaw config ver 1 (spec 10 §2.8; oc-demo cfg1.json) ----------

export const MODEL_NAMES: Record<string, string> = {
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": "DeepSeek V4.1 Flash (Workers AI)",
};

// ---------- Capability gate (docs/11 §4; D14) ----------

/**
 * Version of what renderCapabilities() writes. Bump it when a render change must reach old installs: `ochost deploy`
 * merges the new render into the live config when the document's `ochost.renderVersion` is lower (render-config.ts).
 * ocsup removes the `ochost` key before it writes openclaw.json (OpenClaw rejects unknown root keys).
 */
export const RENDER_VERSION = 1;

/** CapGate address inside the container. The only gate uid 1000 reaches. */
export const CAP_URL = "http://15.0.0.3";
/**
 * ocsup's loopback forwarder to CapGate (image/ocrt/lib/cap-proxy.mjs). OpenClaw 2026.10.9 refuses a firecrawl
 * baseUrl that is a public IP, and 15.0.0.3 is one to it; loopback passes. Same port as CAP_PROXY_PORT there.
 */
export const FETCH_URL = "http://127.0.0.1:18791";
export const EMBED_MODEL = "@cf/baai/bge-m3";
export const TTS_MODEL = "@cf/myshell-ai/melotts";
export const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const DOCS_MCP_URL = "https://docs.mcp.cloudflare.com/mcp";
/** The gate takes no credential. OpenClaw wants a non-empty key for OpenAI-compatible endpoints. */
const GATE_KEY = "capgate";

/**
 * OpenClaw config for the Cloudflare capabilities: every key points at the gate, so these are the only
 * browser, fetch, embedding and media providers the agent has. guess: the memory.search.model, tts and
 * tools.media key names follow the OpenClaw docs read on 2026-11-01 (docs/research/agent-capabilities-research.md);
 * the live check in docs/11 §5 confirms them.
 */
export function renderCapabilities(): Record<string, any> {
  const ai = `${CAP_URL}/ai/v1`;
  return {
    browser: {
      enabled: true,
      defaultProfile: "cf",
      profiles: { cf: { cdpUrl: `${CAP_URL.replace("http", "ws")}/browser/devtools` } },
    },
    tools: {
      web: { fetch: { provider: "firecrawl" }, search: { provider: "cloudflare-web-search" } },
      media: { models: [{ provider: "openai", model: STT_MODEL, baseUrl: ai }] },
    },
    plugins: {
      // firecrawl (web_fetch) and cf-web-search (web_search, image/plugins/cf-web-search) are bundled extensions of
      // the image (/app/dist/extensions): no load path, no npm in Doctor, and no untrusted-plugin boot cost (docs/13).
      // The plugin keeps only the host of baseUrl and posts to <host>/v2/scrape, so no path here.
      entries: {
        firecrawl: { enabled: true, config: { webFetch: { baseUrl: FETCH_URL } } },
        "cf-web-search": { enabled: true, config: { webSearch: { baseUrl: CAP_URL } } },
      },
    },
    memory: {
      search: {
        provider: "openai-compatible",
        model: EMBED_MODEL,
        remote: { baseUrl: ai, apiKey: GATE_KEY },
      },
    },
    tts: { providers: { openai: { baseUrl: ai, apiKey: GATE_KEY, model: TTS_MODEL } } },
    agents: { defaults: { mediaModels: { image: { primary: `openai/${IMAGE_MODEL}` } } } },
    models: {
      providers: {
        openai: {
          baseUrl: ai,
          api: "openai-completions",
          apiKey: GATE_KEY,
          models: [{ id: IMAGE_MODEL, name: "FLUX.1 schnell (Workers AI)", input: ["text"] }],
        },
      },
    },
    mcp: { servers: { "cloudflare-docs": { url: DOCS_MCP_URL, transport: "streamable-http" } } },
  };
}

/** `anthropic/<model>`: run on the binding with the provider key from the gateway BYOK store (docs/09). */
export const isProviderModel = (id: string) => id.startsWith("anthropic/");

/** One entry of the cfgw provider's model list. reasoning false: show `content` only (docs/09 quirks). */
export function modelEntry(id: string, contextWindow?: number | null): Record<string, unknown> {
  const provider = isProviderModel(id);
  return {
    id,
    name:
      MODEL_NAMES[id] ??
      (provider ? `${id.slice(10)} (Anthropic, gateway key)` : `${id.split("/").pop()} (Workers AI)`),
    reasoning: false,
    input: ["text"],
    contextWindow: Math.min(contextWindow || (provider ? 200_000 : 131_072), 262_144),
    maxTokens: 8192,
  };
}

/**
 * The doc init posts as config ver 1. Without any version the gateway runs `--auth token` and the UI
 * cannot connect (M3 F9), so --skip-ai still posts a doc (empty). Managed keys (gateway.auth, trusted
 * proxy, publicOrigin) are rendered by the Control DO, not here. The gate capabilities are always in it.
 */
export function renderOpenclawDoc(o: { model: string } | null): Record<string, unknown> {
  const caps: Record<string, any> = { ...renderCapabilities(), ochost: { renderVersion: RENDER_VERSION } };
  if (!o) return caps;
  return {
    ...caps,
    agents: { defaults: { ...caps.agents.defaults, model: { primary: `cfgw/${o.model}` } } },
    models: {
      providers: {
        ...caps.models.providers,
        // Every model call goes to the CapGate, which runs it on the Worker's AI binding. No token, no header.
        cfgw: {
          baseUrl: `${CAP_URL}/ai/v1`,
          api: "openai-completions",
          apiKey: GATE_KEY,
          models: [modelEntry(o.model)],
        },
      },
    },
  };
}
