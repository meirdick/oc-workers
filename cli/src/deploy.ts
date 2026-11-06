// Project layout, .oc-host/state.json, .oc-host/wrangler.jsonc (spec 10 §2.6), the deploy hash and
// `ochost deploy`. Pattern from cf-orbs cli/src/project.ts, wrangler-template.ts and commands/deploy.ts.
//
// <dir>/
//   oc-host.jsonc            user config (working copy; values live in the Control DO)
//   .gitignore               keeps .oc-host/ out of git
//   .oc-host/
//     wrangler.jsonc         generated on every run; never edit
//     state.json             {step, url, inst, accountId, name, deployHash, gateway, ...}; never tokens
//     control-token          CONTROL_TOKEN, mode 0600
//     secrets.json           manifest {name, sha256, setAt}; never values
//     logs/deploy-*.log      redacted wrangler output
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bucketOf,
  CONFIG_FILE,
  loadConfig,
  NO_GATEWAY,
  type OcHostConfig,
  parseInstance,
  RENDER_VERSION,
  workerSettings,
} from "./config.ts";
import { buildVarsOf, readImageFile } from "./image-pin.ts";
import { runOps } from "./ops-commands.ts";
import { deployPhase, deployWithRetry } from "./registry.ts";
import { diffLine, type RenderResult, renderIntoConfig } from "./render-config.ts";
import { readControlToken, readManifest, updateManifest, withSecretsFile, writeManifest } from "./secrets.ts";
import { CliError, type Ctx, causeChain, fmtSecs, redact, rootCause } from "./ui.ts";
import { makeWrangler, secretBulk } from "./wrangler.ts";

export const STATE_DIR = ".oc-host";

export interface ProjectPaths {
  dir: string;
  config: string;
  stateDir: string;
  wrangler: string;
  state: string;
  controlToken: string;
  manifest: string;
  logs: string;
  gitignore: string;
}

export function projectPaths(dir: string): ProjectPaths {
  const d = resolve(dir);
  const s = join(d, STATE_DIR);
  return {
    dir: d,
    config: join(d, CONFIG_FILE),
    stateDir: s,
    wrangler: join(s, "wrangler.jsonc"),
    state: join(s, "state.json"),
    controlToken: join(s, "control-token"),
    manifest: join(s, "secrets.json"),
    logs: join(s, "logs"),
    gitignore: join(d, ".gitignore"),
  };
}

/** `ochost auth access` (docs/15-access.md). Ids, never tokens. */
export interface AccessState {
  /** custom domain the Access app protects */
  domain: string;
  /** team domain, <team>.cloudflareaccess.com */
  team: string;
  /** Access app AUD tag */
  aud: string;
  appId?: string;
  policyId?: string;
  email?: string;
  idpHint?: string;
  /** "ops" (default): workers.dev serves webhooks and /ops. "webhooks": webhooks only. */
  workersDev: "ops" | "webhooks";
}

export interface State {
  /** last init step done */
  step?: string;
  url?: string;
  inst?: string;
  accountId?: string;
  name?: string;
  bucket?: string;
  deployHash?: string;
  deployedAt?: string;
  gateway?: string;
  model?: string;
  adopted?: boolean;
  /** config version init posted, and its sha (a later version from elsewhere is never overwritten) */
  configVer?: number;
  configSha?: string;
  cliVersion?: string;
  /** deployed with OC_TEST=1: Telegram is a fake inside the Worker (init --fake-telegram) */
  fakeTelegram?: boolean;
  /** set by channels add telegram; kept here so a rerun of init does not drop them */
  telegramBot?: string;
  telegramBotId?: number;
  /** set by `ochost auth access`; deploy renders the route and the ACCESS_* vars from it */
  access?: AccessState;
}

const STATE_KEYS: (keyof State)[] = [
  "step",
  "url",
  "inst",
  "accountId",
  "name",
  "bucket",
  "deployHash",
  "deployedAt",
  "gateway",
  "model",
  "adopted",
  "configVer",
  "configSha",
  "cliVersion",
  "fakeTelegram",
  "telegramBot",
  "telegramBotId",
  "access",
];

export async function readState(p: ProjectPaths): Promise<State> {
  try {
    return JSON.parse(await readFile(p.state, "utf8")) as State;
  } catch {
    return {};
  }
}

export async function writeState(p: ProjectPaths, s: State): Promise<void> {
  await mkdir(p.stateDir, { recursive: true });
  // whitelist fields so a token can never land here by accident
  const clean: Record<string, unknown> = {};
  for (const k of STATE_KEYS) if (s[k] !== undefined) clean[k] = s[k];
  await writeFile(p.state, `${JSON.stringify(clean, null, 2)}\n`);
}

export const GITIGNORE_LINES = [".oc-host/", ".wrangler/", "node_modules/"];

/** Add the oc-host lines to <dir>/.gitignore, keeping existing lines. */
export async function ensureGitignore(p: ProjectPaths): Promise<void> {
  let cur = "";
  try {
    cur = await readFile(p.gitignore, "utf8");
  } catch {}
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (add.length === 0) return;
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
  const header = cur.includes("# oc-host") ? "" : "# oc-host (generated)\n";
  await writeFile(p.gitignore, `${cur}${sep}${header}${add.join("\n")}\n`);
}

// ---------------------------------------------------------------- source (worker/ and image/)

/**
 * Root that holds worker/ and image/. OCHOST_SOURCE overrides; then a source checkout (two dirs up from cli/src
 * or cli/dist); then the npm package's templates/ (cli/scripts/sync-templates.mjs, run by `npm pack`).
 */
export function sourceRoot(ctx: Pick<Ctx, "source" | "env">): string {
  const cands = [
    ctx.source,
    ctx.env.OCHOST_SOURCE,
    resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates"),
  ].filter((x): x is string => Boolean(x));
  for (const c of cands)
    if (existsSync(join(c, "worker", "src", "index.ts")) && existsSync(join(c, "image", "Dockerfile")))
      return c;
  throw new CliError(
    "the oc-workers Worker and image sources are missing",
    "reinstall oc-workers (npm install -g oc-workers), or set OCHOST_SOURCE=<clone of github.com/meirdick/oc-workers>",
  );
}

export const COMPAT_DATE = "2026-10-30";

/** .oc-host/wrangler.jsonc (spec 10 §2.6; from oc-demo wr/wrangler.jsonc). Absolute paths into the source. */
export function renderWranglerJsonc(
  c: OcHostConfig,
  o: {
    accountId: string;
    url: string;
    source: string;
    fakeTelegram?: boolean;
    buildVars?: Record<string, string>;
    access?: AccessState;
  },
): string {
  const inst = parseInstance(c.instance);
  const bucket = bucketOf(c);
  const schema = [
    join(o.source, "node_modules", "wrangler", "config-schema.json"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "wrangler", "config-schema.json"),
  ].find((p) => existsSync(p));
  const doc = {
    ...(schema ? { $schema: schema } : {}),
    name: c.name,
    account_id: o.accountId,
    main: join(o.source, "worker", "src", "index.ts"),
    compatibility_date: COMPAT_DATE,
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true },
    workers_dev: true,
    preview_urls: false,
    containers: [
      {
        class_name: "Runtime",
        scheduling_policy: "durable_object",
        images: {
          oc: {
            dockerfile: join(o.source, "image", "Dockerfile"),
            build_context: join(o.source, "image"),
            // M6: the base pinned by `ochost upgrade` (.oc-host/image.json); none = the Dockerfile defaults
            ...(o.buildVars ? { build_vars: o.buildVars } : {}),
          },
        },
      },
      // docs/12: the tool sandbox. Always declared, so `ochost sandbox on|off` never changes the DO classes.
      {
        class_name: "SandboxSession",
        scheduling_policy: "durable_object",
        images: {
          sbx: {
            dockerfile: join(o.source, "image", "sandbox", "Dockerfile"),
            build_context: join(o.source, "image", "sandbox"),
          },
        },
      },
    ],
    durable_objects: {
      bindings: [
        { name: "CONTROL", class_name: "Control" },
        { name: "RUNTIME", class_name: "Runtime" },
        { name: "AUTH", class_name: "Auth" },
        { name: "SANDBOX", class_name: "SandboxSession" },
      ],
    },
    exports: {
      Control: { type: "durable-object", storage: "sqlite" },
      Runtime: { type: "durable-object", storage: "sqlite" },
      Auth: { type: "durable-object", storage: "sqlite" },
      SandboxSession: { type: "durable-object", storage: "sqlite" },
    },
    version_metadata: { binding: "CF_VERSION" },
    r2_buckets: [{ binding: "BUCKET", bucket_name: bucket }],
    // CapGate (D14): Browser Run for /browser/*. Billed per browser-hour past the plan's included hours.
    browser: { binding: "BROWSER" },
    // Zero-token install (docs/09): every model call and CapGate /v2/search (env.AI.websearch()) run on the Workers
    // AI binding, authenticated as the account.
    ai: { binding: "AI" },
    triggers: { crons: ["*/5 * * * *"] },
    // Opt-in Access front door: the custom domain; the Worker checks the Access JWT on it (docs/15-access.md).
    ...(o.access ? { routes: [{ pattern: o.access.domain, custom_domain: true }] } : {}),
    vars: {
      ...(o.access
        ? {
            ACCESS_TEAM: o.access.team,
            ACCESS_AUD: o.access.aud,
            ACCESS_DOMAIN: o.access.domain,
            ACCESS_WORKERS_DEV: o.access.workersDev,
          }
        : {}),
      OC_INST: c.inst,
      OC_BUCKET: bucket,
      // The AI Gateway the binding routes through; "" = none (llm.gateway "none": no logs, no spend limit).
      OC_AI_GATEWAY: c.llm.gateway === NO_GATEWAY ? "" : c.llm.gateway,
      OC_INSTANCE: JSON.stringify(inst),
      OC_SETTINGS: JSON.stringify(workerSettings(c, o.url)),
      OC_TEST: o.fakeTelegram ? "1" : "0",
    },
  };
  return `// Generated by ochost from ${CONFIG_FILE}. Do not edit: every ochost run rewrites it.\n${JSON.stringify(doc, null, 2)}\n`;
}

/** sha256 over a tree, sorted, by relative path and content. Skips node_modules, test dirs and *.md. */
export function treeHash(root: string, h = createHash("sha256")): ReturnType<typeof createHash> {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n === "test" || n === ".wrangler" || n.endsWith(".md")) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  files.sort();
  for (const f of files) {
    h.update(relative(root, f));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h;
}

/**
 * Deploy hash (spec 10 §2.4 step 9): CLI version, the rendered wrangler.jsonc, worker/src + its scripts,
 * image/. Secrets are not in it: they go with `secret bulk` when nothing else changed.
 */
export function deployHash(o: { cliVersion: string; wranglerText: string; source: string }): string {
  const h = createHash("sha256");
  h.update(`cli ${o.cliVersion}\0`);
  h.update(o.wranglerText);
  h.update("\0worker\0");
  treeHash(join(o.source, "worker", "src"), h);
  treeHash(join(o.source, "worker", "scripts"), h);
  h.update("\0image\0");
  treeHash(join(o.source, "image"), h);
  return h.digest("hex");
}

export async function cliVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { version?: string };
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** `__CODE_VERSION__:"<hex>"` from worker/scripts/code-version.mjs (spec 08 §2.2). */
export async function codeVersionDefine(ctx: Ctx, source: string): Promise<string> {
  const r = await ctx.run(
    process.execPath,
    [join(source, "worker", "scripts", "code-version.mjs"), "--define"],
    {
      timeoutMs: 30_000,
    },
  );
  const out = r.stdout.trim();
  if (r.code !== 0 || !/^__CODE_VERSION__:"[0-9a-f]{64}"$/.test(out))
    throw new CliError(
      `code-version.mjs failed: ${r.stderr.trim().slice(0, 200)}`,
      "check the oc-host source clone",
    );
  return out;
}

export interface DeployOutcome {
  /** "deploy" = wrangler deploy ran; "secrets" = only secret bulk; "none" = nothing changed */
  action: "deploy" | "secrets" | "none";
  attempts: number;
  ms: number;
  sent: string[];
  hash: string;
}

/**
 * Write .oc-host/wrangler.jsonc, then deploy only when the deploy hash changed (or force). New or changed
 * secrets go with the deploy (--secrets-file) or alone (secret bulk). Writes the manifest and state.
 */
export async function deployProject(
  ctx: Ctx,
  o: {
    config: OcHostConfig;
    accountId: string;
    url: string;
    send: Record<string, string>;
    force?: boolean;
    /** adopt: never deploy code or image here; send secrets only */
    secretsOnly?: boolean;
    /** OC_TEST=1: the Worker answers Telegram calls with its own fake (test installs only) */
    fakeTelegram?: boolean;
    /** F1 (M4b): runs right before wrangler deploy (ochost deploy: pre-upgrade archive + skew gate). */
    before?: () => Promise<void>;
  },
): Promise<DeployOutcome> {
  const p = projectPaths(ctx.dir);
  const source = sourceRoot(ctx);
  const pin = (await readImageFile(p.stateDir)).current;
  let state = await readState(p);
  const text = renderWranglerJsonc(o.config, {
    access: state.access,
    accountId: o.accountId,
    url: o.url,
    source,
    fakeTelegram: o.fakeTelegram,
    buildVars: pin ? buildVarsOf(pin) : undefined,
  });
  await mkdir(p.stateDir, { recursive: true });
  await writeFile(p.wrangler, text);
  const version = await cliVersion();
  const hash = deployHash({ cliVersion: version, wranglerText: text, source });
  const w = makeWrangler(ctx.run, { configPath: p.wrangler, accountId: o.accountId });
  const sent = Object.keys(o.send);
  const t0 = ctx.now();
  const saveManifest = async () => {
    if (!sent.length) return;
    await writeManifest(
      p.manifest,
      updateManifest(await readManifest(p.manifest), o.send, new Date(ctx.now())),
    );
  };

  if ((state.deployHash === hash && !o.force) || o.secretsOnly) {
    if (!sent.length) {
      ctx.ui.step(
        o.secretsOnly
          ? "deploy: skipped (adopt: no code or image change)"
          : "deploy: no change (same deploy hash), skipped",
        "deploy",
      );
      return { action: "none", attempts: 0, ms: 0, sent, hash };
    }
    ctx.ui.step(
      `deploy: code unchanged; sending ${sent.length} secret(s) with wrangler secret bulk`,
      "deploy",
    );
    await withSecretsFile(o.send, (f) => secretBulk(w, o.config.name, f));
    await saveManifest();
    return { action: "secrets", attempts: 1, ms: ctx.now() - t0, sent, hash };
  }

  if (o.before) await o.before();
  const define = await codeVersionDefine(ctx, source);
  await mkdir(p.logs, { recursive: true });
  const logFile = join(p.logs, `deploy-${new Date(ctx.now()).toISOString().replace(/[:.]/g, "-")}.log`);
  let output = "";
  let attempt = 1;
  const tick = setInterval(() => {
    ctx.ui.progress(`deploy: ${deployPhase(output)}, ${fmtSecs(ctx.now() - t0)} (try ${attempt})`);
  }, 1000);
  try {
    const run = async (secretsFile?: string) => {
      const args = ["--define", define, "--containers-rollout=immediate"];
      if (secretsFile) args.push("--secrets-file", secretsFile);
      return deployWithRetry(w, args, {
        logFile,
        sleep: ctx.sleep,
        onOutput: (s) => {
          output += s;
          void appendFile(logFile, redact(s)).catch(() => {});
        },
        onRetry: (n, why) => {
          attempt = n + 1;
          output = "";
          ctx.ui.progressDone();
          ctx.ui.note(`retry ${n} of 3: ${why}`);
        },
      });
    };
    const r = sent.length ? await withSecretsFile(o.send, (f) => run(f)) : await run();
    ctx.ui.progressDone();
    const ms = ctx.now() - t0;
    ctx.ui.step(
      `deploy: done in ${fmtSecs(ms)} (${r.attempts} attempt(s); log ${relative(ctx.dir, logFile)})`,
      "deploy",
    );
    await saveManifest();
    state = {
      ...(await readState(p)),
      deployHash: hash,
      deployedAt: new Date(ctx.now()).toISOString(),
      cliVersion: version,
    };
    await writeState(p, state);
    return { action: "deploy", attempts: r.attempts, ms, sent, hash };
  } finally {
    clearInterval(tick);
    ctx.ui.progressDone();
  }
}

/** `ochost deploy [--force]`: re-render and deploy when the deploy hash changed. */
export async function deployCommand(ctx: Ctx): Promise<number> {
  const p = projectPaths(ctx.dir);
  const state = await readState(p);
  if (!state.url || !state.accountId)
    throw new CliError(`no oc-host install in ${ctx.dir}`, "run ochost init, or ochost init --adopt");
  const config = await loadConfig(p.config);
  if (!(await readControlToken(p.controlToken)))
    throw new CliError(`no control token in ${p.controlToken}`, "run ochost init in this directory");
  const token = await readControlToken(p.controlToken);
  const url = state.url;
  const r = await deployProject(ctx, {
    config,
    accountId: state.accountId,
    url,
    send: {},
    force: ctx.args.flags.force === true,
    fakeTelegram: state.fakeTelegram,
    before: state.deployedAt ? () => preUpgradeArchive(ctx, url, String(token)) : undefined,
  });
  ctx.ui.result({ ok: true, url: state.url, action: r.action, attempts: r.attempts, ms: r.ms });
  ctx.ui.out(r.action === "none" ? "nothing to deploy" : `deployed ${state.url}`);
  await warnTokenEra(ctx, url, String(token));
  await renderStep(ctx, url, String(token), { bucket: bucketOf(config), inst: config.inst });
  await pruneStep(ctx, url, String(token));
  return 0;
}

/**
 * After a deploy: when the Control DO has a prune plan (snapshots of chains older than the live root, one wake
 * from that root done), delete their registry tags now. The registry cap is 50 GB per account; waiting for the
 * owner to run `ochost snapshot prune` let one install reach 344 tags (M8 live). Best effort, never fails the deploy.
 */
export async function pruneStep(ctx: Ctx, url: string, token: string): Promise<void> {
  try {
    const res = await ctx.fetch(`${url}/ops/snapshots/prune`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const plan = (await res.json().catch(() => ({}))) as { ready?: boolean; ids?: string[] };
    if (!res.ok || !plan.ready || !Array.isArray(plan.ids) || !plan.ids.length) return;
    ctx.ui.step(`prune: ${plan.ids.length} snapshot(s) of old chains; deleting their registry tags`, "prune");
    const code = await runOps("snapshot", ["prune", "--yes"], { dir: ctx.dir, fetch: ctx.fetch });
    if (code !== 0) ctx.ui.warn(`prune: exit ${code}; run ochost snapshot prune`);
  } catch (e) {
    ctx.ui.warn(`prune skipped: ${redact(rootCause(e))}; run ochost snapshot prune`);
  }
}

/**
 * After a deploy: when the live config's render version is older than this CLI's, merge the current render into it
 * (render keys win, owner keys stay; cli/src/render-config.ts). The running gateway keeps the old config until the
 * next start, so say so. Best effort: a failure warns and never fails the deploy.
 */
export async function renderStep(
  ctx: Ctx,
  url: string,
  token: string,
  files?: { bucket: string; inst: string },
): Promise<RenderResult | null> {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await ctx.fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {}
    return { status: res.status, body: parsed };
  };
  try {
    // Tell the install which render this CLI has: the owner panel's "config render" row compares it.
    await call("POST", "/ops/render-check", { renderVersion: RENDER_VERSION }).catch(() => undefined);
    const r = await renderIntoConfig(
      { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) },
      { onlyIfOlder: true, files },
    );
    if (r.action === "merged")
      ctx.ui.warn(
        `config render ${r.docRenderVersion} -> ${RENDER_VERSION}: new config version ${r.ver} (${diffLine(r.diff)}); applies at the next start — fix: ochost restart`,
      );
    return r;
  } catch (e) {
    ctx.ui.warn(`config render skipped: ${(e as Error).message} — fix: ochost config render`);
    return null;
  }
}

/** A config from before the zero-token Worker: the provider calls the AI Gateway with `${OC_CF_AI_TOKEN}`. */
export function tokenEraConfig(doc: unknown): boolean {
  return /\$\{OC_CF_AI_TOKEN\}|gateway\.ai\.cloudflare\.com/.test(JSON.stringify(doc ?? {}));
}

/**
 * The zero-token Worker never passes the old AI token to the container (rt/runtime.ts WORKER_ONLY), so a
 * token-era config loses its model at the next boot. Warn after a deploy. Best effort: a read failure is silent.
 */
export async function warnTokenEra(ctx: Ctx, url: string, token: string): Promise<boolean> {
  const get = async (path: string): Promise<any> => {
    const res = await ctx.fetch(`${url}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? res.json() : null;
  };
  try {
    const vers = ((await get("/ops/config"))?.versions ?? []).map((v: { ver: number }) => v.ver);
    if (!vers.length) return false;
    if (!tokenEraConfig((await get(`/ops/config/${Math.max(...vers)}`))?.doc)) return false;
    ctx.ui.warn(
      "the OpenClaw config still calls the AI Gateway with the old AI token, which the container no longer gets — fix: ochost ai-gateway setup --restart",
    );
    return true;
  } catch {
    return false;
  }
}

/** Pre-upgrade archive wait cap. Also the window in which a ladder start counts as "can wake". */
export const ARCHIVE_WAIT_MS = 10 * 60_000;

/** Tries per /ops call in the pre-upgrade archive step (a network error is tried again). */
export const ARCHIVE_CALL_TRIES = 3;

/**
 * F1 (M4 sleep): a new image digest boots from image + newest archive. Before a deploy of a live install: ask
 * the Control DO whether an archive can run now (`GET /ops/archive/can-run`: container up, asleep, or a ladder
 * start inside the wait cap). If it can, ask for a pre-upgrade archive (it wakes the install) and wait until it
 * is done (10 min cap). If it cannot (backoff, restore-blocked, no container), skip the archive and continue,
 * unless --require-archive. Then ask the skew gate (`/ops/deploy-check {image:true}`). A 409 `archive-stale`
 * stops the deploy unless --force, or unless the archive was skipped: the boot then keeps the old digest until
 * an archive exists (ctl/digest.ts deferDigest), so the workspace is safe.
 */
export async function preUpgradeArchive(ctx: Ctx, url: string, token: string): Promise<void> {
  // Every call here is safe to repeat (POST /ops/archive gives back the open request). A network error (reset
  // socket, connect timeout: undici throws a bare "fetch failed") is tried again; the last one names the route
  // and the cause.
  const call = async (method: string, path: string, body?: unknown) => {
    const route = `${method} ${path.split("?")[0]}`;
    let res: Response | undefined;
    for (let attempt = 1; !res; attempt++) {
      try {
        res = await ctx.fetch(`${url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        const cause = redact(rootCause(e) || (e instanceof Error ? e.message : String(e)));
        if (ctx.env.OCHOST_DEBUG) ctx.ui.note(`${route}: ${redact(causeChain(e))}`);
        if (attempt >= ARCHIVE_CALL_TRIES)
          throw new CliError(
            `${url} did not answer (${route}, ${attempt} tries): ${cause}`,
            "check the network, then ochost status; rerun ochost deploy",
          );
        ctx.ui.note(`${route} failed (${cause}); retry ${attempt} of ${ARCHIVE_CALL_TRIES - 1}`);
        await ctx.sleep(2_000 * attempt);
      }
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  };
  const force = ctx.args.flags.force === true;
  const require = ctx.args.flags["require-archive"] === true;
  // A Worker without the route (404) answers nothing: keep the old behaviour (ask and wait).
  const canRun = async () => {
    const r = await call("GET", `/ops/archive/can-run?withinMs=${ARCHIVE_WAIT_MS}`);
    return r.status === 200 && r.json && typeof r.json.canRun === "boolean" ? r.json : null;
  };
  const skip = (c: { state?: string; newestAgeMs?: number | null }) => {
    const age =
      typeof c.newestAgeMs === "number"
        ? `${Math.round(c.newestAgeMs / 60_000)} min old`
        : "missing (none yet)";
    const line = `pre-upgrade archive skipped: install cannot wake (state ${c.state ?? "unknown"}); the newest archive is ${age}`;
    if (require)
      throw new CliError(
        line.replace("skipped", "required but cannot run"),
        "fix the install first (ochost status, ochost doctor), or deploy without --require-archive",
      );
    ctx.ui.step(`deploy: ${line}`, "deploy");
  };
  let skipped = false;
  const first = await canRun();
  if (first && !first.canRun) {
    skip(first);
    skipped = true;
  } else {
    ctx.ui.step("deploy: pre-upgrade archive (wakes the install)", "deploy");
    const req = await call("POST", "/ops/archive", { reason: "pre-upgrade" });
    if (req.status >= 300)
      ctx.ui.step(
        `deploy: pre-upgrade archive request refused: HTTP ${req.status}${req.json?.error ? ` ${req.json.error}` : ""}`,
        "deploy",
      );
    const id = req.json?.request?.id;
    const t0 = ctx.now();
    let done = false;
    while (req.status < 300 && ctx.now() - t0 < ARCHIVE_WAIT_MS) {
      const st = await call("GET", "/ops/archive");
      const r = st.json?.request;
      if (r && (!id || r.id === id) && r.state === "done") {
        done = true;
        break;
      }
      // The Control DO marks a request with no progress for 15 min failed (archive-stalled): stop waiting.
      if (r && (!id || r.id === id) && r.state === "failed") {
        ctx.ui.step(`deploy: pre-upgrade archive failed: ${r.why ?? "unknown"}`, "deploy");
        break;
      }
      // The install can fall into backoff while we wait: stop waiting then.
      const c = first ? await canRun() : null;
      if (c && !c.canRun) {
        skip(c);
        skipped = true;
        break;
      }
      await ctx.sleep(10_000);
    }
    if (!skipped)
      ctx.ui.step(
        `deploy: pre-upgrade archive ${done ? "done" : "not done"} in ${fmtSecs(ctx.now() - t0)}`,
        "deploy",
      );
  }
  const chk = await call("POST", "/ops/deploy-check", { image: true });
  if (chk.status !== 200 && !(chk.status === 409 && chk.json?.error === "archive-stale"))
    ctx.ui.note(`deploy-check answered HTTP ${chk.status}${chk.json?.error ? ` ${chk.json.error}` : ""}`);
  if (chk.status === 409 && chk.json?.error === "archive-stale" && !force) {
    if (skipped) {
      ctx.ui.note("the next boot keeps the old image digest until an archive with the workspace exists");
      return;
    }
    throw new CliError(
      `deploy refused: ${chk.json?.why ?? "archive older than the newest snapshot"}`,
      "wait for the archive (ochost backup list), or ochost deploy --force (the workspace since the archive is lost)",
    );
  }
}
