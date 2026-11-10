// `ochost import` plan (docs/10-cli-spec.md §1.2, docs/research/migration-plan.md §5). Reads an old OpenClaw
// install laid out like a seed (`<seed>/home` = the old ~/.openclaw state dir, `<seed>/clawd` = its workspace)
// and decides, file by file, where each thing goes on oc-host. No network; the command (import.ts) runs it.
//   workspace  → the bundle that ocsup merges into <state>/workspace (add missing, keep the install's, replace
//                only the bootstrap files)
//   files      → R2 file storage f/<inst>/ (records, raw transcripts, media, parked skills), keys file_store reads
//   cron       → jobs ocsup re-creates with `openclaw cron add --declaration-key import:<name>`
//   config     → keys merged into the newest config version (only keys OpenClaw 2026.10.9 has)
// Never copied: credentials, .env files, keys, the vault paths of the rules file, the old SQLite DBs (schema and
// gen table differ).
//
// Rules that belong to one owner's old install come from an optional JSON file (`--rules <file>`), never from code.
// Every field is optional. Example:
//   {
//     "source": "OpenClaw 2026.7.1 on a VM, history 2026-01 to 2026-09",
//     "vaults": ["projects/app/vault"],
//     "store": [{ "from": "projects/app/records", "to": "records/app", "about": "records of the app" }],
//     "parkedSkills": ["some-skill"],
//     "cronSkip": [{ "name": "app-sync", "why": "moves to a separate Worker" }],
//     "cronOff": [{ "match": "app-sync|projects/app/", "why": "needs the app Worker; turn on after it is live" }],
//     "olderSessions": { "prefix": "history/sessions-old", "about": "from before the seed" },
//     "notes": ["Not here: the app and its vault (moves to a separate Worker)."]
//   }
//   vaults        workspace paths (a dir or a file) that never leave the laptop
//   store         workspace dirs that go to file storage <to>/ instead of the workspace
//   parkedSkills  skills that need a tool the install does not have; files go to history/skills/
//   cronSkip      cron jobs not re-created, by name
//   cronOff       cron jobs re-created off when the message matches `match` (regex, case-insensitive)
//   olderSessions key prefix and note text for the --feb sessions
//   source, notes text for the generated note memory/imported-history.md
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const IMPORT_FILE_MAX = 100 * 1000 * 1000; // files.maxObjectMb default
/** Files the new install seeds with defaults; the old install's own versions replace them (old kept in backup). */
export const BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "TOOLS.md",
  "MEMORY.md",
];
/** The first-run ritual of a fresh install; the old install finished it long ago. */
export const REMOVE_FILES = ["BOOTSTRAP.md"];
/** Owner rules for one old install (`--rules <file>`); see the header. */
export interface ImportRules {
  source?: string;
  vaults?: string[];
  store?: { from: string; to: string; about?: string }[];
  parkedSkills?: string[];
  cronSkip?: { name: string; why: string }[];
  cronOff?: { match: string; why: string }[];
  olderSessions?: { prefix?: string; about?: string };
  notes?: string[];
}
const OLDER_PREFIX = "history/sessions-old";

const relSafe = (x: unknown): x is string =>
  typeof x === "string" &&
  x !== "" &&
  !x.startsWith("/") &&
  x.split("/").every((s) => s !== "" && s !== "." && s !== "..");
const keySafe = (x: unknown): x is string =>
  typeof x === "string" && x !== "" && x.split("/").every((s) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s));
const strs = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === "string");

/** Checks a parsed rules file; throws with the first bad field. Trailing slashes on paths are dropped. */
export function parseRules(doc: unknown): ImportRules {
  const bad = (f: string, want: string) => new Error(`rules: ${f} must be ${want}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw bad("the file", "a JSON object");
  const d = doc as Record<string, any>;
  const known = [
    "source",
    "vaults",
    "store",
    "parkedSkills",
    "cronSkip",
    "cronOff",
    "olderSessions",
    "notes",
  ];
  for (const k of Object.keys(d)) if (!known.includes(k)) throw bad(k, `one of ${known.join(", ")}`);
  const trim = (x: string) => x.replace(/\/+$/, "");
  const r: ImportRules = {};
  if (d.source !== undefined) {
    if (typeof d.source !== "string") throw bad("source", "a string");
    r.source = d.source;
  }
  if (d.vaults !== undefined) {
    if (!strs(d.vaults)) throw bad("vaults", "a list of paths");
    r.vaults = d.vaults.map(trim);
    for (const v of r.vaults ?? []) if (!relSafe(v)) throw bad("vaults", `relative paths (${v})`);
  }
  if (d.store !== undefined) {
    if (!Array.isArray(d.store)) throw bad("store", "a list");
    r.store = d.store.map((e: any, i: number) => {
      const from = typeof e?.from === "string" ? trim(e.from) : e?.from;
      const to = typeof e?.to === "string" ? trim(e.to) : e?.to;
      if (!relSafe(from)) throw bad(`store[${i}].from`, "a relative workspace path");
      if (!keySafe(to)) throw bad(`store[${i}].to`, "a key prefix of [A-Za-z0-9._-] segments");
      if (e.about !== undefined && typeof e.about !== "string") throw bad(`store[${i}].about`, "a string");
      return { from, to, ...(e.about ? { about: e.about } : {}) };
    });
  }
  if (d.parkedSkills !== undefined) {
    if (!strs(d.parkedSkills)) throw bad("parkedSkills", "a list of skill names");
    r.parkedSkills = d.parkedSkills;
  }
  if (d.cronSkip !== undefined) {
    if (
      !Array.isArray(d.cronSkip) ||
      !d.cronSkip.every((e: any) => typeof e?.name === "string" && typeof e?.why === "string")
    )
      throw bad("cronSkip", "a list of {name, why}");
    r.cronSkip = d.cronSkip.map((e: any) => ({ name: e.name, why: e.why }));
  }
  if (d.cronOff !== undefined) {
    if (
      !Array.isArray(d.cronOff) ||
      !d.cronOff.every((e: any) => typeof e?.match === "string" && typeof e?.why === "string")
    )
      throw bad("cronOff", "a list of {match, why}");
    r.cronOff = d.cronOff.map((e: any, i: number) => {
      try {
        new RegExp(e.match, "i");
      } catch {
        throw bad(`cronOff[${i}].match`, "a valid regex");
      }
      return { match: e.match, why: e.why };
    });
  }
  if (d.olderSessions !== undefined) {
    const o = d.olderSessions;
    if (!o || typeof o !== "object" || Array.isArray(o)) throw bad("olderSessions", "an object");
    if (o.prefix !== undefined && !keySafe(typeof o.prefix === "string" ? trim(o.prefix) : o.prefix))
      throw bad("olderSessions.prefix", "a key prefix of [A-Za-z0-9._-] segments");
    if (o.about !== undefined && typeof o.about !== "string") throw bad("olderSessions.about", "a string");
    r.olderSessions = {
      ...(o.prefix !== undefined ? { prefix: trim(o.prefix) } : {}),
      ...(o.about !== undefined ? { about: o.about } : {}),
    };
  }
  if (d.notes !== undefined) {
    if (!strs(d.notes)) throw bad("notes", "a list of lines");
    r.notes = d.notes;
  }
  return r;
}

/** Reads and checks a rules file. */
export function loadRules(file: string): ImportRules {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`rules file ${file}: ${(e as Error).message}`);
  }
  return parseRules(doc);
}

export interface Sources {
  seed: string;
  /** an older sessions dir with agents/<agent>/sessions/ (for example a copy of an older host's state prefix) */
  feb?: string;
  /** GCS `media/` copied locally (files sent to the bot) */
  media?: string;
}
export interface WsFile {
  rel: string;
  src: string;
  bytes: number;
  /** path rewrite applied (old VM path → workspace-relative) */
  rewritten?: boolean;
  /** original path when the file was renamed to avoid a case-only collision */
  renamedFrom?: string;
}
export interface StoreFile {
  group: "records" | "transcripts" | "transcripts-old" | "media" | "skills";
  key: string;
  src: string;
  bytes: number;
  original: string;
}
export interface CronJob {
  key: string;
  name: string;
  cron: string;
  tz?: string;
  message: string;
  session?: "isolated" | "main";
  agent?: string;
  enabled: boolean;
  timeoutSeconds?: number;
  announce?: { channel: string; to: string };
  description?: string;
}
export interface Plan {
  workspace: WsFile[];
  files: StoreFile[];
  excluded: { rel: string; why: string }[];
  cron: CronJob[];
  cronSkipped: { name: string; why: string }[];
  config: { set: Record<string, unknown>; dropped: { path: string; why: string }[] };
  overwrite: string[];
  remove: string[];
  /** generated workspace file that tells the agent where the old history went */
  note: { rel: string; text: string };
  /** key prefix of the --feb sessions */
  olderPrefix: string;
}

// ---------------------------------------------------------------- rules

const SKIP_DIRS = new Set([".git", "node_modules", ".clawhub", ".clawdhub", ".openclaw", "logs", ".cache"]);
const SECRET_RE =
  /(^|\/)(\.env(\..*)?|[^/]*\.env|client_secret[^/]*\.json|[^/]*credentials?[^/]*\.json|[^/]*\.pem|[^/]*\.key|id_(rsa|ed25519)[^/]*|tokens?\.enc|[^/]*\.p12|auth-profiles[^/]*)$/i;
const TEXT_EXT = /\.(md|txt|json|jsonl|ya?ml|sh|mjs|js|ts|py|toml|csv|html)$/i;
/** Key shapes (Google, OpenAI-style, Telegram bot, GitHub, Slack, bank API access tokens, PEM keys). */
export const KEY_SHAPES =
  /AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{33}|ghp_[A-Za-z0-9]{36}|xox[abp]-[A-Za-z0-9-]{20,}|access-(production|development|sandbox)-[0-9a-f]{8}-|-----BEGIN [A-Z ]*PRIVATE KEY/;

const under = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}/`);

/** Why a workspace path never leaves the laptop, or null. `vaults` come from the rules file. */
export function excludedWhy(rel: string, vaults: readonly string[] = []): string | null {
  if (vaults.some((v) => under(rel, v))) return "vault";
  if (SECRET_RE.test(rel)) return "credential";
  if (rel === "openclaw-workspace-state.json") return "old install state";
  return null;
}

/** Old VM paths → workspace-relative. `~/clawd/x` and `/home/<u>/clawd/x` → `x`; the bare dir → `.`. */
export function rewritePaths(s: string): string {
  return s.replace(/(~|\/home\/[a-z0-9_-]+)\/clawd\//g, "").replace(/(~|\/home\/[a-z0-9_-]+)\/clawd\b/g, ".");
}

/** A key the file_store tool accepts (segments of [A-Za-z0-9._-]); `used` resolves collisions with -2, -3, … */
export function storeKey(prefix: string, rel: string, used: Set<string>): string {
  const segs = rel.split("/").map((s) => {
    const x = s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[.]+/, "_")
      .replace(/_+/g, "_");
    return x === "" || x === "_" ? "_" : x.slice(0, 120);
  });
  let key = `${prefix}/${segs.join("/")}`;
  if (used.has(key)) {
    const dot = key.lastIndexOf(".");
    const slash = key.lastIndexOf("/");
    const [base, ext] = dot > slash ? [key.slice(0, dot), key.slice(dot)] : [key, ""];
    let n = 2;
    while (used.has(`${base}-${n}${ext}`)) n++;
    key = `${base}-${n}${ext}`;
  }
  used.add(key);
  return key;
}

function walk(root: string, onFile: (rel: string, bytes: number) => void, skipDir = (_rel: string) => false) {
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !skipDir(rel)) rec(p);
      } else if (e.isFile()) onFile(rel, lstatSync(p).size);
    }
  };
  rec(root);
}

// ---------------------------------------------------------------- cron

interface CronRow {
  name: string;
  enabled: number;
  schedule_kind: string | null;
  schedule_expr: string | null;
  schedule_tz: string | null;
  session_target: string | null;
  payload_kind: string | null;
  payload_message: string | null;
  payload_timeout_seconds: number | null;
  delivery_mode: string | null;
  delivery_channel: string | null;
  delivery_to: string | null;
  agent_id: string | null;
}

/** OpenClaw 2026.7 cron_jobs rows → jobs for 2026.10.9. `cronSkip` and `cronOff` come from the rules file. */
export function cronFromRows(
  rows: CronRow[],
  rules: Pick<ImportRules, "cronSkip" | "cronOff"> = {},
): { jobs: CronJob[]; skipped: { name: string; why: string }[] } {
  const jobs: CronJob[] = [];
  const skipped: { name: string; why: string }[] = [];
  const skip = new Map((rules.cronSkip ?? []).map((s) => [s.name, s.why]));
  const off = (rules.cronOff ?? []).map((o) => ({ re: new RegExp(o.match, "i"), why: o.why }));
  for (const r of rows) {
    const moved = skip.get(r.name);
    if (moved) {
      skipped.push({ name: r.name, why: moved });
      continue;
    }
    if (r.schedule_kind !== "cron" || !r.schedule_expr) {
      skipped.push({ name: r.name, why: `schedule ${r.schedule_kind ?? "?"} not imported` });
      continue;
    }
    if (r.payload_kind !== "agentTurn" || !r.payload_message) {
      skipped.push({ name: r.name, why: `payload ${r.payload_kind ?? "?"} not imported` });
      continue;
    }
    const message = rewritePaths(r.payload_message);
    const offWhy = off.find((o) => o.re.test(message))?.why;
    const j: CronJob = {
      key: `import:${r.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
      name: r.name,
      cron: r.schedule_expr,
      // The old VM ran on UTC; an empty tz meant the host zone.
      tz: r.schedule_tz || "UTC",
      message,
      session: r.session_target === "main" ? "main" : "isolated",
      enabled: r.enabled === 1 && !offWhy,
    };
    if (r.agent_id) j.agent = r.agent_id;
    if (r.payload_timeout_seconds) j.timeoutSeconds = r.payload_timeout_seconds;
    if (r.delivery_mode === "announce" && r.delivery_channel && r.delivery_to)
      j.announce = { channel: r.delivery_channel, to: String(r.delivery_to) };
    if (offWhy) j.description = `Imported off: ${offWhy}`;
    jobs.push(j);
  }
  return { jobs, skipped };
}

export function readCron(stateDb: string): CronRow[] {
  if (!existsSync(stateDb)) return [];
  // Read-only and immutable: the seed is a backup, never written.
  const db = new DatabaseSync(`file:${stateDb}?immutable=1`, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT name, enabled, schedule_kind, schedule_expr, schedule_tz, session_target, payload_kind,
                payload_message, payload_timeout_seconds, delivery_mode, delivery_channel, delivery_to, agent_id
         FROM cron_jobs ORDER BY name`,
      )
      .all() as unknown as CronRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- config

const get = (o: any, p: string) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function put(o: Record<string, any>, p: string, v: unknown) {
  const ks = p.split(".");
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks[ks.length - 1] as string] = v;
}

/**
 * Old openclaw.json (2026.7.x) → keys that exist in OpenClaw 2026.10.9 and do not belong to oc-host (models,
 * gateway, channels, capabilities). Everything else is listed in `dropped` with the reason.
 */
export function configFromOld(old: any): Plan["config"] {
  const set: Record<string, unknown> = {};
  const dropped: { path: string; why: string }[] = [];
  const main = (Array.isArray(old?.agents?.list) ? old.agents.list : []).find((a: any) => a?.id === "main");
  const idn = main?.identity;
  if (idn && typeof idn === "object") {
    const keep = Object.fromEntries(
      ["name", "theme", "emoji"].filter((k) => typeof idn[k] === "string").map((k) => [k, idn[k]]),
    );
    if (Object.keys(keep).length) put(set, "agents.entries.main.identity", keep);
  }
  const d = old?.agents?.defaults ?? {};
  const copy = (from: string, to: string) => {
    const v = get(d, from);
    if (v !== undefined) put(set, to, v);
  };
  copy("compaction.mode", "agents.defaults.compaction.mode");
  copy("compaction.memoryFlush.enabled", "agents.defaults.compaction.memoryFlush.enabled");
  copy(
    "compaction.memoryFlush.softThresholdTokens",
    "agents.defaults.compaction.memoryFlush.softThresholdTokens",
  );
  copy("contextPruning.mode", "agents.defaults.contextPruning.mode");
  copy("contextPruning.ttl", "agents.defaults.contextPruning.ttl");
  copy("memorySearch.sources", "memory.search.sources");
  copy("memorySearch.extraPaths", "memory.search.extraPaths");
  copy("memorySearch.experimental.sessionMemory", "memory.search.experimental.sessionMemory");
  const ack = old?.messages?.ackReactionScope;
  if (typeof ack === "string") put(set, "messages.ackReactionScope", ack);

  const why: [string, string][] = [
    ["env", "credentials stay out (M6: Workers AI instead of Gemini and ElevenLabs keys)"],
    ["auth", "provider auth not needed (oc-host model through AI Gateway)"],
    ["models", "oc-host default model (M4)"],
    ["agents.defaults.model", "oc-host default model (M4)"],
    ["agents.defaults.memorySearch.provider", "embeddings: Workers AI @cf/baai/bge-m3 (rendered)"],
    ["agents.defaults.memorySearch.query", "query.hybrid is not in OpenClaw 2026.10.9"],
    ["agents.defaults.imageGenerationModel", "images: Workers AI flux-1-schnell (rendered)"],
    ["agents.defaults.compaction.memoryFlush.prompt", "no such key in OpenClaw 2026.10.9"],
    ["agents.defaults.contextPruning.keepLastAssistants", "no such key in OpenClaw 2026.10.9"],
    ["agents.defaults.heartbeat", "oc-host sleep.proactive owns the heartbeat"],
    [
      "agents.list",
      "2026.10.9 uses agents.entries; only main's identity is kept, agent voice is not imported",
    ],
    ["tools", "web search, fetch and transcription come from CapGate (Workers AI whisper)"],
    ["channels", "the owner re-adds Telegram groups on the new bot (M2)"],
    ["session.sendPolicy", "channel rules come back with the channels"],
    ["gateway", "managed by oc-host"],
    ["hooks", "hook token is a secret; hooks are re-made on oc-host if needed"],
    ["skills.entries", "skill API keys are secrets"],
    ["plugins", "bundled in 2026.10.9 or replaced by CapGate"],
  ];
  for (const [p, w] of why) if (get(old, p) !== undefined) dropped.push({ path: p, why: w });
  return { set, dropped };
}

/** Deep merge: objects merge, arrays and scalars replace. Returns a new object. */
export function mergeDoc(base: any, add: any): any {
  if (!add || typeof add !== "object" || Array.isArray(add)) return add;
  const out: Record<string, any> =
    base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(add)) out[k] = mergeDoc(out[k], v);
  return out;
}

// ---------------------------------------------------------------- plan

export function buildPlan(src: Sources, now = new Date(), rules: ImportRules = {}): Plan {
  const ws = join(src.seed, "clawd");
  const home = join(src.seed, "home");
  if (!existsSync(ws) || !existsSync(home))
    throw new Error(`${src.seed} must hold home/ (the old ~/.openclaw) and clawd/ (its workspace)`);
  const workspace: WsFile[] = [];
  const files: StoreFile[] = [];
  const excluded: { rel: string; why: string }[] = [];
  const used = new Set<string>();
  const addStore = (group: StoreFile["group"], prefix: string, root: string, rel: string, bytes: number) => {
    if (bytes > IMPORT_FILE_MAX) {
      excluded.push({ rel: `${prefix}/${rel}`, why: `above ${IMPORT_FILE_MAX / 1e6} MB per object` });
      return;
    }
    files.push({ group, key: storeKey(prefix, rel, used), src: join(root, rel), bytes, original: rel });
  };

  const vaults = rules.vaults ?? [];
  const parked = new Set(rules.parkedSkills ?? []);
  const store = rules.store ?? [];
  walk(ws, (rel, bytes) => {
    const why = excludedWhy(rel, vaults);
    if (why) {
      excluded.push({ rel, why });
      return;
    }
    const st = store.find((x) => rel.startsWith(`${x.from}/`));
    if (st) {
      addStore("records", st.to, join(ws, st.from), rel.slice(st.from.length + 1), bytes);
      return;
    }
    const sk = /^skills\/([^/]+)\//.exec(rel)?.[1];
    if (sk && parked.has(sk)) {
      addStore("skills", "history/skills", join(ws, "skills"), rel.slice(7), bytes);
      return;
    }
    if (bytes > IMPORT_FILE_MAX) {
      excluded.push({ rel, why: `above ${IMPORT_FILE_MAX / 1e6} MB` });
      return;
    }
    let rewritten = false;
    if (TEXT_EXT.test(rel) && bytes < 5_000_000) {
      const t = readFileSync(join(ws, rel), "utf8");
      if (KEY_SHAPES.test(t)) {
        excluded.push({ rel, why: "looks like it holds a key" });
        return;
      }
      rewritten = rewritePaths(t) !== t;
    }
    workspace.push({ rel, src: join(ws, rel), bytes, ...(rewritten ? { rewritten } : {}) });
  });

  // Raw transcripts of every agent (jsonl, trajectories, resets). Hidden temp files are partial writes.
  const agents = join(home, "agents");
  if (existsSync(agents))
    for (const a of readdirSync(agents)) {
      const sd = join(agents, a, "sessions");
      if (!existsSync(sd)) continue;
      walk(sd, (rel, bytes) => {
        if (rel.split("/").some((s) => s.startsWith("."))) return;
        addStore("transcripts", `history/sessions/${a}`, sd, rel, bytes);
      });
    }
  const olderPrefix = rules.olderSessions?.prefix ?? OLDER_PREFIX;
  if (src.feb) {
    const fa = join(src.feb, "agents");
    if (!existsSync(fa)) throw new Error(`--feb ${src.feb} must hold agents/<agent>/sessions/`);
    for (const a of readdirSync(fa)) {
      const sd = join(fa, a, "sessions");
      if (!existsSync(sd)) continue;
      walk(sd, (rel, bytes) => {
        if (rel.split("/").some((s) => s.startsWith("."))) return;
        addStore("transcripts-old", `${olderPrefix}/${a}`, sd, rel, bytes);
      });
    }
  }
  if (src.media) {
    if (!existsSync(src.media)) throw new Error(`--media ${src.media} does not exist`);
    walk(src.media, (rel, bytes) => addStore("media", "media", src.media as string, rel, bytes));
  }

  const { jobs, skipped } = cronFromRows(readCron(join(home, "state", "openclaw.sqlite")), rules);
  let oldCfg: unknown = {};
  try {
    oldCfg = JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8"));
  } catch {}
  const config = configFromOld(oldCfg);
  dedupeCase(workspace);
  const present = new Set(workspace.map((w) => w.rel));
  const overwrite = BOOTSTRAP_FILES.filter((f) => present.has(f));
  return {
    workspace,
    files,
    excluded,
    cron: jobs,
    cronSkipped: skipped,
    config,
    overwrite,
    remove: REMOVE_FILES.filter((f) => !present.has(f)),
    olderPrefix,
    note: {
      rel: "memory/imported-history.md",
      text: noteText(now, files, jobs, skipped, rules, { feb: !!src.feb, media: !!src.media }),
    },
  };
}

function noteText(
  now: Date,
  files: StoreFile[],
  jobs: CronJob[],
  skipped: { name: string; why: string }[],
  rules: ImportRules,
  had: { feb: boolean; media: boolean },
) {
  const n = (g: StoreFile["group"]) => files.filter((f) => f.group === g).length;
  const inStore = (to: string) =>
    files.filter((f) => f.group === "records" && f.key.startsWith(`${to}/`)).length;
  const older = rules.olderSessions ?? {};
  return [
    "# Imported history",
    "",
    `Imported on ${now.toISOString().slice(0, 10)} from the old OpenClaw install${rules.source ? ` (${rules.source})` : ""}.`,
    "The workspace files and memory/ notes came over as they were; old paths under ~/clawd now point at this",
    "workspace.",
    "",
    "Raw files are in file storage (tool `file_store`, action `list` with a prefix, then `read`):",
    "",
    `- \`history/sessions/<agent>/\`: ${n("transcripts")} raw transcript files of the old install (jsonl).`,
    ...(had.feb
      ? [
          `- \`${older.prefix ?? OLDER_PREFIX}/<agent>/\`: ${n("transcripts-old")} older transcript files${older.about ? ` ${older.about}` : ""}.`,
        ]
      : []),
    ...(rules.store ?? []).map(
      (s) => `- \`${s.to}/\`: ${inStore(s.to)} files${s.about ? `, ${s.about}` : ""}.`,
    ),
    ...(had.media ? [`- \`media/\`: ${n("media")} files sent to the old bot.`] : []),
    ...(n("skills")
      ? [`- \`history/skills/\`: ${n("skills")} files of skills that need tools this install does not have.`]
      : []),
    "- `history/INDEX.json`: old file name for each key (names were made key-safe).",
    "",
    ...(rules.notes?.length ? [...rules.notes, ""] : []),
    "Cron jobs re-created:",
    ...jobs.map(
      (j) =>
        `- ${j.name} (${j.cron} ${j.tz ?? ""})${j.description ? `, ${j.description.replace(/^Imported off: /, "off: ")}` : j.enabled ? "" : ", off"}`,
    ),
    ...skipped.map((s) => `- ${s.name}: not re-created, ${s.why}`),
    "",
  ].join("\n");
}

/**
 * `openclaw backup create --verify` refuses an archive with two paths that differ only in case ("portable path
 * collision"; live check oc-m9-import: two files like reports/A.csv and reports/a.csv), and every
 * later archive of the install then fails. The first path (sorted) keeps its name; later ones get -2, -3, ….
 */
export function dedupeCase(files: WsFile[]): void {
  const taken = new Set<string>();
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    let rel = f.rel;
    if (taken.has(rel.toLowerCase())) {
      const slash = rel.lastIndexOf("/");
      const dot = rel.lastIndexOf(".");
      const [base, ext] = dot > slash + 1 ? [rel.slice(0, dot), rel.slice(dot)] : [rel, ""];
      let n = 2;
      while (taken.has(`${base}-${n}${ext}`.toLowerCase())) n++;
      rel = `${base}-${n}${ext}`;
      f.renamedFrom = f.rel;
      f.rel = rel;
    }
    taken.add(rel.toLowerCase());
  }
}

/** sha256 of a file, streamed. */
export function sha256File(p: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(p)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}
