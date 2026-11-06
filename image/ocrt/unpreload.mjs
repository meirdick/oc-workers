// Loaded by the gateway with `node --import` (plan §4.1, §6.1 row 4; amend §2 row 20; M3-1).
// 1. jemalloc is already mapped; children must not inherit it (Chromium, codex, MCP). Children DO keep
//    nodump.so: execve resets PR_SET_DUMPABLE, so without the preload a child's /proc/<pid>/environ is
//    readable by every uid-1000 process (M3-1 live: spawn-broker workers exposed the LLM key).
// 2. SecretRefs resolve in the gateway process only. Every child of the gateway gets a scrubbed env: no
//    OC_*, no OPENCLAW_GATEWAY_TOKEN/PASSWORD, no name ocsup lists in OCHOST_SCRUB, and no var whose value
//    holds one of those secret values (catches a copy into ANTHROPIC_API_KEY or "Bearer <key>").
//    Hooks: ChildProcess.prototype.spawn (spawn, exec, execFile, fork) and the 3 sync exports.
//    Children get NODE_OPTIONS=--import=<this file>, OCHOST_SCRUB and OCHOST_SCRUB_H (value hashes), so every
//    node descendant runs the same hooks: the spawn broker gets the gateway env over IPC and spawns with it.
//    M5: names in OCHOST_REFS (every SecretRef the rendered config uses) come back in the child as the
//    placeholder value "ochost-scrubbed", so an `openclaw` CLI run by the agent loads the config without
//    "missing env var OC_*". The real values never reach a child.
// 3. The CF intercept CA: Node's fetch (undici) uses the default CA store, so add the CA to it.
//    NODE_EXTRA_CA_CERTS stays set for child processes.
import cp from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

export const NODUMP = "/opt/ocrt/nodump.so";
export const SCRUB_VAR = "OCHOST_SCRUB";
/** sha256 (16 hex) of each secret value: a node descendant that never saw the values still drops copies. */
export const SCRUB_HASH_VAR = "OCHOST_SCRUB_H";
/** SecretRef names that a child gets as PLACEHOLDER (M5 agent env gap). */
export const REFS_VAR = "OCHOST_REFS";
export const PLACEHOLDER = "ochost-scrubbed";
/** Set by ocsup in its own CLI runs only (never in the gateway env): the CLI re-executes itself and the copy keeps the env. */
export const KEEP_VAR = "OCHOST_CLI_KEEP";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const SELF = fileURLToPath(import.meta.url);
const MIN_SECRET = 8;
const h16 = (v) => createHash("sha256").update(v).digest("hex").slice(0, 16);
const split = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const secretName = (k, listed) =>
  k.startsWith("OC_") || /^OPENCLAW_GATEWAY_(TOKEN|PASSWORD)$/.test(k) || listed.has(k);

/** Secret names, values and value hashes in an env (ocsup's gatewayEnv output, or a scrubbed child env). */
export function secretsOf(env) {
  const listed = new Set(split(env[SCRUB_VAR]));
  const hashes = new Set(split(env[SCRUB_HASH_VAR]));
  const refs = new Set(split(env[REFS_VAR]).filter((k) => NAME.test(k)));
  const values = [];
  for (const [k, v] of Object.entries(env)) {
    if (k === SCRUB_VAR || k === SCRUB_HASH_VAR || k === REFS_VAR || !secretName(k, listed)) continue;
    if (typeof v === "string" && v.length >= MIN_SECRET && v !== PLACEHOLDER) {
      values.push(v);
      hashes.add(h16(v));
    }
  }
  return { listed, hashes, values, refs };
}

/**
 * The env a child gets. nodump: preload path (null = none). self: this module, put in NODE_OPTIONS so every
 * node descendant (a broker that spawns with an env it got over IPC, M4 live: `pnpm root -g`) scrubs too.
 */
export function scrubEnv(env, sec, nodump = NODUMP, self = SELF) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined) continue;
    if (k === SCRUB_VAR || k === SCRUB_HASH_VAR || k === REFS_VAR || k === "MALLOC_CONF") continue;
    if (secretName(k, sec.listed)) continue;
    const s = String(v);
    if (sec.values.some((x) => s.includes(x))) continue;
    if (s.length >= MIN_SECRET && sec.hashes.has(h16(s))) continue;
    out[k] = s;
  }
  // Placeholders only for names a scrub removed (or never had): a non-secret name keeps its own value.
  for (const k of sec.refs || []) if (out[k] === undefined && secretName(k, sec.listed)) out[k] = PLACEHOLDER;
  if (sec.refs?.size) out[REFS_VAR] = [...sec.refs].join(",");
  if (sec.listed.size) out[SCRUB_VAR] = [...sec.listed].join(",");
  if (sec.hashes.size) out[SCRUB_HASH_VAR] = [...sec.hashes].join(",");
  if (self) {
    const flag = `--import=${self}`;
    const cur = out.NODE_OPTIONS || "";
    if (!cur.includes(self)) out.NODE_OPTIONS = `${flag} ${cur}`.trim();
  }
  if (nodump) {
    const pre = (out.LD_PRELOAD || "")
      .split(/[: ]+/)
      .filter((p) => p && !/libjemalloc/.test(p) && p !== nodump);
    out.LD_PRELOAD = [nodump, ...pre].join(":");
  } else delete out.LD_PRELOAD;
  return out;
}

const pairsToEnv = (pairs) => {
  const e = {};
  for (const p of pairs || []) {
    const i = String(p).indexOf("=");
    if (i > 0) e[String(p).slice(0, i)] = String(p).slice(i + 1);
  }
  return e;
};
const envToPairs = (e) => Object.entries(e).map(([k, v]) => `${k}=${v}`);

/** Index of the options object in a sync call's args (after the file and an optional args array). */
function optIndex(args) {
  let i = 1;
  if (Array.isArray(args[1])) i = 2;
  return i;
}

/** True when ocsup's CLI run (KEEP_VAR set) spawns node on its own entry script again. */
export function selfRespawn(env, options, execPath = process.execPath, entry = process.argv[1]) {
  if (env[KEEP_VAR] !== "1" || !entry || options.file !== execPath) return false;
  return Array.isArray(options.args) && options.args.slice(1).includes(entry);
}

/** Install the hooks on a child_process module. Returns the secrets in force (tests read it). */
export function installScrub(mod, env, { nodump = NODUMP, self = SELF } = {}) {
  const sec = secretsOf(env);
  const proto = mod.ChildProcess?.prototype;
  if (proto && !proto.__ochostScrub) {
    const orig = proto.spawn;
    proto.spawn = function spawn(options) {
      if (options && typeof options === "object" && selfRespawn(env, options)) {
        // M4b B1: `openclaw gateway call` re-executes node with the same entry (adds a flag). The copy needs
        // OPENCLAW_GATEWAY_PASSWORD or the call is unauthorized (trusted-proxy). ocsup CLI runs only.
      } else if (options && typeof options === "object") {
        const src = Array.isArray(options.envPairs) ? pairsToEnv(options.envPairs) : env;
        options.envPairs = envToPairs(scrubEnv(src, sec, nodump, self));
      }
      return orig.call(this, options);
    };
    proto.__ochostScrub = true;
  }
  for (const name of ["spawnSync", "execSync", "execFileSync"]) {
    const orig = mod[name];
    if (typeof orig !== "function" || orig.__ochostScrub) continue;
    const wrapped = function (...args) {
      const i = name === "execSync" ? 1 : optIndex(args);
      const o = args[i] && typeof args[i] === "object" && !Array.isArray(args[i]) ? { ...args[i] } : {};
      o.env = scrubEnv(o.env ?? env, sec, nodump, self);
      args[i] = o;
      return orig.apply(this, args);
    };
    wrapped.__ochostScrub = true;
    mod[name] = wrapped;
  }
  return sec;
}

// ---- run as the --import preload (not when a test imports this file) ----
if (process.env.OCHOST_UNPRELOAD_TEST !== "1") {
  delete process.env.LD_PRELOAD;
  delete process.env.MALLOC_CONF;
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  if (ca && typeof tls.setDefaultCACertificates === "function") {
    try {
      const pem = fs.readFileSync(ca, "utf8");
      tls.setDefaultCACertificates([...tls.getCACertificates("default"), pem]);
    } catch {}
  }
  installScrub(cp, process.env, { nodump: fs.existsSync(NODUMP) ? NODUMP : null });
  syncBuiltinESMExports();
}
