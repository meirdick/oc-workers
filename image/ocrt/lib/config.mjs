// Config render and write-back rules (plan §4.9 as cut by scope §1.1 rows "Config versions" and
// "Plugins"). The Control DO owns the versions; ocsup renders one per boot:
//   openclaw.json = selected version doc + managed keys + this boot's overlay.
// Scope cut: no three-way merge. The watcher sends a proposal only on a lit `prod` boot with no
// overlay. A proposal = the file with every managed key set back to the selected version's value.
// `auth.password` and `auth.token` never go into the file (Z2.5); CLI calls get the password by env.
import crypto from "node:crypto";

/** M4 F9: model of the default config document (the M3 e2e doc, checked by `openclaw config validate`). */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * M4 F9: the config document of an install with no config version (fresh install, no `POST /ops/config`).
 * Model + provider key SecretRef (when the Worker passes OC_ANTHROPIC_KEY); render() adds the managed gateway
 * auth keys (trusted-proxy, and the gateway token as the local password by env). Version `ver` is null: the
 * first proposal (UI edit) becomes Control DO version 1.
 */
export function defaultVersion(envNames = []) {
  const doc = { agents: { defaults: { model: { primary: DEFAULT_MODEL } } } };
  if (envNames.includes("OC_ANTHROPIC_KEY"))
    doc.models = { providers: { anthropic: { apiKey: `\${OC_ANTHROPIC_KEY}` } } };
  return { ver: null, schemaSha: null, doc, isDefault: true };
}

/** Read a dotted path. Missing → undefined. */
export function getPath(obj, p) {
  let o = obj;
  for (const k of p.split(".")) {
    if (o === null || typeof o !== "object" || !Object.hasOwn(o, k)) return undefined;
    o = o[k];
  }
  return o;
}

/** Set a dotted path (value undefined = delete). Makes objects on the way. Mutates obj. */
export function setPath(obj, p, value) {
  const ks = p.split(".");
  let o = obj;
  for (const k of ks.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== "object" || Array.isArray(o[k])) {
      if (value === undefined) return obj;
      o[k] = {};
    }
    o = o[k];
  }
  const last = ks.at(-1);
  if (value === undefined) delete o[last];
  else o[last] = value;
  return obj;
}

/** Stable JSON (sorted keys), so equal docs give equal sha. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const docSha = (doc) => sha256(canon(doc));

/**
 * Managed keys (plan §4.9 "Render", scope Z2.5, Z2.7). value undefined = the key is removed.
 * plan.managed[] ({path, value}) from the DO is applied after these defaults and wins.
 * guess: the trusted-proxy user header name; M3 sets it.
 */
export function managedKeys(plan = {}, base = {}) {
  const m = [
    { path: "gateway.bind", value: "lan" },
    { path: "gateway.port", value: 18789 },
    { path: "gateway.auth.mode", value: "trusted-proxy" },
    { path: "gateway.auth.password", value: undefined },
    { path: "gateway.auth.token", value: undefined },
    {
      path: "gateway.trustedProxies",
      value: plan.trustedProxies?.length ? plan.trustedProxies : ["10.1.0.0/32"],
    },
    // trusted-proxy mode without trustedProxy.userHeader → the gateway refuses to start (2026.10.9:
    // "no trustedProxy config was provided"). Same values as the Worker's ingress/gateway.ts; plan.managed wins.
    { path: "gateway.auth.trustedProxy.userHeader", value: "x-ochost-user" },
    { path: "gateway.auth.trustedProxy.requiredHeaders", value: ["x-forwarded-proto", "x-forwarded-host"] },
    { path: "gateway.auth.trustedProxy.allowUsers", value: ["owner"] },
    { path: "gateway.auth.trustedProxy.allowLoopback", value: false },
    // CLI bookkeeping (ochost.renderVersion, cli/src/render-config.ts): OpenClaw rejects unknown root keys.
    { path: "ochost", value: undefined },
    ...capabilitiesKeys(base),
    ...(plan.sandbox === true ? sandboxKeys(base, plan.sandboxMode) : sandboxOffKeys(base)),
    ...originKeys(plan),
  ];
  for (const x of plan.managed || []) {
    const i = m.findIndex((y) => y.path === x.path);
    if (i >= 0) m[i] = x;
    else m.push(x);
  }
  return dropBundledPaths(m, base);
}

/**
 * Cold-reply regression (docs/13): cf-web-search was a bundled extension (firecrawl too, until 1.2)
 * (/app/dist/extensions). Loaded by path they were untrusted, which cost ~6 s of gateway boot. A config version from
 * before that still lists their old dirs in plugins.load.paths; the dirs are gone, so take them out at render time.
 */
export const LEGACY_PLUGIN_DIRS = ["/opt/oc-plugins/firecrawl", "/opt/oc-plugins/cf-web-search"];
function dropBundledPaths(m, base) {
  const i = m.findIndex((y) => y.path === "plugins.load.paths");
  const cur = i >= 0 ? m[i].value : getPath(base, "plugins.load.paths");
  if (!Array.isArray(cur) || !cur.some((p) => LEGACY_PLUGIN_DIRS.includes(p))) return m;
  const value = cur.filter((p) => !LEGACY_PLUGIN_DIRS.includes(p));
  if (i >= 0) m[i] = { ...m[i], value };
  else m.push({ path: "plugins.load.paths", value });
  return m;
}

/** docs/11 §11: the entry of the plugin cf-capabilities, and of its former id (cf-web-search, search only). */
const CAPS_ENTRY = "plugins.entries.cf-capabilities";
const OLD_SEARCH_ENTRY = "plugins.entries.cf-web-search";
const FIRECRAWL_ENTRY = "plugins.entries.firecrawl";
const FETCH_PROVIDER = "tools.web.fetch.provider";
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const mergeObj = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? mergeObj(out[k], v) : v;
  return out;
};

/**
 * Compatibility for installs whose config still has plugins.entries.cf-web-search: the image has no plugin of that id
 * any more, so its entry becomes the entry of cf-capabilities (an entry already there wins) and the old one is removed.
 * The search provider id (cloudflare-web-search) did not change, so tools.web.search.provider keeps working.
 *
 * Same for the firecrawl package (gone from the image in 1.2): `tools.web.fetch.provider = firecrawl` renders as
 * `cloudflare-web-fetch` (the cf-capabilities provider, served by the gate), and `plugins.entries.firecrawl` is removed.
 * Another fetch provider the owner chose stays.
 */
export function capabilitiesKeys(base = {}) {
  const keys = [];
  const old = getPath(base, OLD_SEARCH_ENTRY);
  if (old !== undefined) {
    const cur = getPath(base, CAPS_ENTRY);
    keys.push(
      { path: CAPS_ENTRY, value: mergeObj(isObj(old) ? old : {}, isObj(cur) ? cur : {}) },
      { path: OLD_SEARCH_ENTRY, value: undefined },
    );
  }
  if (getPath(base, FETCH_PROVIDER) === "firecrawl")
    keys.push({ path: FETCH_PROVIDER, value: "cloudflare-web-fetch" });
  if (getPath(base, FIRECRAWL_ENTRY) !== undefined) keys.push({ path: FIRECRAWL_ENTRY, value: undefined });
  return keys;
}

/**
 * Deprecation lines for a config version that still uses what cf-capabilities replaced. The boot logs them;
 * `ochost config render` (render version 3) moves the version to cf-capabilities.
 */
export function deprecations(base = {}) {
  const out = [];
  if (getPath(base, OLD_SEARCH_ENTRY) !== undefined)
    out.push(
      `${OLD_SEARCH_ENTRY} is now ${CAPS_ENTRY}; rendered from the old entry. Run: ochost config render`,
    );
  if (getPath(base, FETCH_PROVIDER) === "firecrawl" || getPath(base, FIRECRAWL_ENTRY) !== undefined)
    out.push(
      "the firecrawl package is not in the image any more; web_fetch is rendered as cloudflare-web-fetch (cf-capabilities). Run: ochost config render",
    );
  return out;
}

/**
 * Control UI origin (plan.publicOrigin: the custom domain when Access is on, else workers.dev). OpenClaw refuses a
 * browser origin that is not publicOrigin or in controlUi.allowedOrigins; the list holds both entries.
 */
export function originKeys(plan = {}) {
  const ok = (o) => typeof o === "string" && /^https?:\/\/[^/\s]+$/.test(o.replace(/\/$/, ""));
  if (!ok(plan.publicOrigin)) return [];
  const pub = plan.publicOrigin.replace(/\/$/, "");
  const list = [pub, ...(Array.isArray(plan.allowedOrigins) ? plan.allowedOrigins : [])]
    .filter(ok)
    .map((o) => o.replace(/\/$/, ""));
  return [
    { path: "gateway.publicOrigin", value: pub },
    { path: "gateway.controlUi.allowedOrigins", value: [...new Set(list)] },
  ];
}

/** SandboxGate (docs/12). uid 1000 reaches it (lib/netfilter.mjs). */
export const SANDBOX_GATE = "http://15.0.0.4";
export const SANDBOX_PLUGIN_DIR = "/opt/ocrt/plugins/ochost-sandbox";
export const SANDBOX_ROOT = "/workspace";
const SANDBOX_BACKEND = "ochost";
/**
 * Tools a sandboxed session may still call on the gateway side. OpenClaw's sandbox tool policy allows only
 * exec, files, process, github and sessions by default and denies `browser`; with mode "all" every session is
 * sandboxed, so web search, web fetch, the browser, memory, media and the message tool vanished (demo, 2026-11-06).
 * These run in the gateway container and reach the gate, not the sandbox, so they are safe to allow.
 */
export const SANDBOX_ALSO_ALLOW = [
  "group:web",
  "group:memory",
  "group:media",
  "group:messaging",
  "browser",
  "file_store",
];
/** Earlier renders of the same list; `sandbox off` removes these too. */
const OLD_ALSO_ALLOW = [["group:web", "group:memory", "group:media", "group:messaging", "browser"]];

/**
 * docs/12 §5: plan.sandbox → sessions sandboxed on backend `ochost` (the bundled plugin), remote root /workspace in
 * the SandboxSession container. Mode `non-main` (default) keeps only the Control UI chat on the gateway: OpenClaw 2026.10.9 classifies a channel DM
 * by a per-peer policy key (`resolveRuntimePolicySessionKey`), so a Telegram DM is sandboxed even in the main session.
 * As OpenClaw's
 * own example does; `all` sandboxes every session. load.paths keeps the user's entries and adds ours.
 */
export function sandboxKeys(base = {}, mode = "non-main") {
  const paths = getPath(base, "plugins.load.paths");
  const keep = Array.isArray(paths) ? paths.filter((p) => p !== SANDBOX_PLUGIN_DIR) : [];
  return [
    { path: "agents.defaults.sandbox.mode", value: mode === "all" ? "all" : "non-main" },
    { path: "agents.defaults.sandbox.backend", value: "ochost" },
    { path: "agents.defaults.sandbox.scope", value: "agent" },
    { path: "agents.defaults.sandbox.workspaceAccess", value: "rw" },
    { path: "agents.defaults.sandbox.ssh.workspaceRoot", value: SANDBOX_ROOT },
    { path: "tools.sandbox.tools.alsoAllow", value: SANDBOX_ALSO_ALLOW },
    { path: "plugins.load.paths", value: [...keep, SANDBOX_PLUGIN_DIR] },
    { path: "plugins.entries.ochost-sandbox.enabled", value: true },
    {
      path: "plugins.entries.ochost-sandbox.config",
      value: { gateUrl: SANDBOX_GATE, workspaceRoot: SANDBOX_ROOT },
    },
  ];
}

/**
 * Sandbox off: take out what sandboxKeys wrote. The doctor (or an owner save) can copy the managed keys into the
 * owner config version, so they would stay after `ochost sandbox off`. Only a block on backend `ochost` goes; a
 * user's own sandbox block (docker, ssh) stays.
 */
export function sandboxOffKeys(base = {}) {
  const out = [];
  if (getPath(base, "agents.defaults.sandbox.backend") === SANDBOX_BACKEND)
    out.push({ path: "agents.defaults.sandbox", value: undefined });
  if (getPath(base, "plugins.entries.ochost-sandbox") !== undefined)
    out.push({ path: "plugins.entries.ochost-sandbox", value: undefined });
  const also = getPath(base, "tools.sandbox.tools.alsoAllow");
  if (
    Array.isArray(also) &&
    [SANDBOX_ALSO_ALLOW, ...OLD_ALSO_ALLOW].some((l) => JSON.stringify(also) === JSON.stringify(l))
  )
    out.push({ path: "tools.sandbox.tools.alsoAllow", value: undefined });
  const paths = getPath(base, "plugins.load.paths");
  if (Array.isArray(paths) && paths.includes(SANDBOX_PLUGIN_DIR))
    out.push({ path: "plugins.load.paths", value: paths.filter((p) => p !== SANDBOX_PLUGIN_DIR) });
  return out;
}

/**
 * Overlay entries of this boot, in order: plan.overlay[] from the DO, channels off (canary, dark
 * phase), skipped plugins. Each → {path, value, why}.
 */
export function overlayEntries(doc, plan = {}, local = {}) {
  const out = [];
  for (const o of plan.overlay || []) out.push({ path: o.path, value: o.value, why: o.why || "plan" });
  if (plan.channelsOff || plan.mode === "canary") {
    for (const ch of Object.keys(doc?.channels || {}))
      if (doc.channels[ch] && typeof doc.channels[ch] === "object")
        out.push({ path: `channels.${ch}.enabled`, value: false, why: "channels-off" });
    out.push({ path: "cron.enabled", value: false, why: "channels-off" });
  }
  for (const id of local.missingPlugins || [])
    out.push({ path: `plugins.entries.${id}.enabled`, value: false, why: "plugin-missing" });
  return out;
}

/**
 * Render. Returns {doc, text, sha, overlay: [{path, userValue, overlayValue, why}], managed,
 * proposals: bool}. The input doc is not changed.
 */
export function render(version, plan = {}, local = {}) {
  const base = structuredClone(version.doc || {});
  const doc = structuredClone(base);
  const managed = managedKeys(plan, base);
  for (const k of managed) setPath(doc, k.path, k.value);
  const overlay = [];
  for (const o of overlayEntries(base, plan, local)) {
    overlay.push({ path: o.path, userValue: getPath(base, o.path), overlayValue: o.value, why: o.why });
    setPath(doc, o.path, o.value);
  }
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  return {
    ver: version.ver,
    schemaSha: version.schemaSha,
    doc,
    text,
    sha: sha256(text),
    overlay,
    managed,
    proposals: proposalsAllowed(plan, overlay),
  };
}

/** Scope cut: proposals only on a lit prod boot with no overlay. */
export function proposalsAllowed(plan, overlay) {
  return plan.mode === "prod" && !plan.channelsOff && overlay.length === 0;
}

/**
 * Keys whose change gives alert `config-sensitive` (scope §1.1 row "Config versions"; no hold in v1).
 */
export const SENSITIVE = [
  "models.providers",
  "channels",
  "hooks",
  "plugins",
  "gateway.auth",
  "tools",
  "mcp",
  "commands",
];

/** Sensitive top paths that differ between two docs. */
export function sensitiveChanges(a, b) {
  return SENSITIVE.filter((p) => canon(getPath(a, p) ?? null) !== canon(getPath(b, p) ?? null));
}

/**
 * Build a proposal from the file the gateway (or the UI) wrote. Managed keys go back to the selected
 * version's value. Returns null when the result equals the version (nothing to propose).
 * source: "ui" (file changed while running), "doctor" (after a Doctor pre-step), "unknown".
 */
export function proposalFrom(fileDoc, rendered, version, source = "ui") {
  const doc = structuredClone(fileDoc);
  for (const k of rendered.managed) setPath(doc, k.path, getPath(version.doc || {}, k.path));
  // Drop parents a managed key made (e.g. gateway.auth.trustedProxy) that are now empty and that the
  // version does not have, so a file equal to the version up to managed keys gives no proposal.
  for (const k of rendered.managed) {
    const ks = k.path.split(".");
    for (let i = ks.length - 1; i > 0; i--) {
      const p = ks.slice(0, i).join(".");
      const o = getPath(doc, p);
      if (
        o &&
        typeof o === "object" &&
        !Array.isArray(o) &&
        Object.keys(o).length === 0 &&
        getPath(version.doc || {}, p) === undefined
      )
        setPath(doc, p, undefined);
      else break;
    }
  }
  if (canon(doc) === canon(version.doc || {})) return null;
  return {
    source,
    sha: docSha(doc),
    schemaSha: version.schemaSha,
    baseVer: version.ver,
    darkOrigin: false,
    doc,
    sensitive: sensitiveChanges(version.doc || {}, doc),
  };
}

/** The gateway log line that marks a config hot reload (amend §3 row "T7e row 19" (b)). */
export const RELOAD_LINE = /config change detected; evaluating reload/;
