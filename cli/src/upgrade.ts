// ochost upgrade check | run [<version>|extended-stable] | rollback (docs/10-cli-spec.md §1.2, plan §8; M6 quick win).
// Smallest useful path: no dark/lit cutover, no canary DO. `run` builds the image FROM the new GHCR digest,
// runs the image contract in Docker (image/test/tests/_upgrade-contract.mjs), refuses a schema change, then
// redeploys through deployProject (pre-upgrade archive + skew gate), restarts, and watches /ops/status. A failure
// inside the watch window redeploys the previous pin. The pin lives in .oc-host/image.json (image-pin.ts).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import {
  cliVersion,
  deployProject,
  preUpgradeArchive,
  projectPaths,
  readState,
  sourceRoot,
} from "./deploy.ts";
import {
  buildVarsOf,
  effectivePin,
  type ImageFile,
  type ImagePin,
  pinOf,
  readImageFile,
  writeImageFile,
} from "./image-pin.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagInt,
  flagStr,
  type Install,
  kv,
  type OpsClient,
  type OpsCtx,
  opsClient,
  RESTART_CALL_MS,
  readHostConfig,
  STATE_DIR,
} from "./ops-lib.ts";
import { type Ctx, makeUi } from "./ui.ts";
import { runProcess as wranglerRun } from "./wrangler.ts";

export const upgradeFlags: FlagSpec = { to: { type: "string" }, timeout: { type: "string" } };

const NPM = "https://registry.npmjs.org";
const GHCR = "https://ghcr.io";
const REPO = "openclaw/openclaw";
export const notesUrl = (v: string) => `https://github.com/${REPO}/releases/tag/v${v}`;

// ---------------------------------------------------------------- versions and registries

/** Calendar versions 2026.10.9, 2026.10.10-beta.5. Negative: a is older. A prerelease is older than its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.split(/-(.+)/);
    return { n: main.split(".").map((x) => Number(x) || 0), pre: pre ?? "" };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) {
    const d = (x.n[i] ?? 0) - (y.n[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface Target {
  version: string;
  /** sha256:<hex> of the image index at ghcr.io/openclaw/openclaw:<version> */
  digest: string;
}

async function getJson(f: typeof fetch, url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new CliError(`${url.split("/").slice(0, 3).join("/")} did not answer`, "check the network, rerun");
  }
  if (!res.ok) throw new CliError(`${url} returned ${res.status}`, "check the version or tag name, rerun");
  return res.json();
}

/** Resolve `<version>` or a dist-tag (extended-stable) to the version and its GHCR index digest. */
export async function resolveTarget(f: typeof fetch, spec: string): Promise<Target> {
  let version = spec;
  if (!/^\d+\.\d+\.\d+/.test(spec)) {
    const tags = await getJson(f, `${NPM}/-/package/openclaw/dist-tags`);
    version = String(tags?.[spec] ?? "");
    if (!version) throw new CliError(`npm dist-tag ${spec} is not set on openclaw`, "use --to <version>");
  }
  // The version goes into the GHCR path and the Docker build args: release shape only.
  if (!/^\d+\.\d+\.\d+[\w.-]*$/.test(version))
    throw new CliError(
      `${version.slice(0, 60)} is not an OpenClaw version`,
      "use --to <version>, e.g. 2026.10.9",
    );
  const tok = (await getJson(f, `${GHCR}/token?scope=repository:${REPO}:pull`))?.token;
  const res = await f(`${GHCR}/v2/${REPO}/manifests/${version}`, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${tok}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
      ].join(", "),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const digest = res.headers.get("docker-content-digest") ?? "";
  if (res.status === 404)
    throw new CliError(`ghcr.io/${REPO}:${version} does not exist`, "pick a published version");
  if (!res.ok || !/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new CliError(`ghcr.io/${REPO}:${version} gave no digest (HTTP ${res.status})`, "rerun in 1 min");
  return { version, digest };
}

// ---------------------------------------------------------------- check

export type Delta = "newer" | "same" | "older" | "moved";

export function deltaOf(pinned: ImagePin, t: Target): Delta {
  const c = compareVersions(t.version, pinned.version);
  if (c > 0) return "newer";
  if (c < 0) return "older";
  return t.digest === pinned.digest ? "same" : "moved";
}

const short = (d: string | null | undefined) => (d ? `${d.slice(0, 19)}…` : "-");

export function trackOf(ctx: OpsCtx): string {
  return (
    flagStr(ctx.args, "to") ??
    ctx.args.positionals[1] ??
    readHostConfig(ctx.dir)?.upgrade?.track ??
    "extended-stable"
  );
}

async function pinned(ctx: OpsCtx): Promise<{ pin: ImagePin; from: string; source: string }> {
  const source = sourceRoot({ env: ctx.env });
  const file = await readImageFile(join(ctx.dir, STATE_DIR));
  const pin = await effectivePin(join(ctx.dir, STATE_DIR), source);
  if (!pin) throw new CliError("no base pin in image/Dockerfile", "update oc-host (git pull)");
  return { pin, from: file.current ? "image.json" : "image/Dockerfile", source };
}

export async function check(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const spec = trackOf(ctx);
  const [target, st, p] = await Promise.all([
    resolveTarget(ctx.fetch, spec),
    ops.call("GET", "/ops/status"),
    pinned(ctx),
  ]);
  const delta = deltaOf(p.pin, target);
  const epochDigest: string | null = st.body?.epoch?.digest ?? null;
  const rec = (await readImageFile(join(ctx.dir, STATE_DIR))).epochDigest;
  const drift = !!rec && !!epochDigest && rec !== epochDigest;
  const doc = {
    ok: true,
    track: spec,
    delta,
    target,
    pinned: { ...p.pin, from: p.from },
    deployed: {
      epoch: st.body?.epoch?.n ?? null,
      digest: epochDigest,
      codeVersion: st.body?.codeVersion ?? null,
    },
    notes: notesUrl(target.version),
    drift,
  };
  // Tell the install what this check found: the owner panel's install row shows it (the Worker has no CLI or pin data).
  await ops
    .call("POST", "/ops/upgrade-check", {
      cliVersion: await cliVersion().catch(() => null),
      pinned: { version: p.pin.version, digest: p.pin.digest },
      target: { version: target.version },
      delta,
    })
    .catch(() => undefined);
  if (ctx.out.json) ctx.out.result(doc);
  else {
    ctx.out.line(
      kv([
        ["track", `${spec} -> ${target.version}`],
        ["target", `${target.version}  ${short(target.digest)}`],
        ["pinned", `${p.pin.version}  ${short(p.pin.digest)}  (${p.from})`],
        ["deployed", `epoch ${doc.deployed.epoch ?? "-"}  ${short(epochDigest)}`],
        ["delta", deltaText(delta, p.pin, target)],
        ["notes", doc.notes],
      ]),
    );
    if (drift)
      ctx.out.warn(
        `the epoch image is not the one the last upgrade left (${short(rec)}); ochost status, ochost deploy`,
      );
  }
  return delta === "newer" || delta === "moved" ? EXIT.manual : EXIT.ok;
}

function deltaText(d: Delta, pin: ImagePin, t: Target): string {
  if (d === "newer") return `newer: ${pin.version} -> ${t.version}; ochost upgrade run`;
  if (d === "same") return "same";
  if (d === "older") return `older than the pin (${t.version} < ${pin.version}); no upgrade`;
  return `${t.version} has a new digest (${short(pin.digest)} -> ${short(t.digest)}); needs a human look`;
}

// ---------------------------------------------------------------- hooks (tests swap them)

export interface Hooks {
  /** Deploy through deployProject with the pin now in .oc-host/image.json. Throws a CliError on failure. */
  deploy(ctx: OpsCtx, install: Install): Promise<void>;
}

/**
 * The real deploy: deployProject and preUpgradeArchive (archive, wait, skew gate) take the init-style Ctx. A
 * deploy hash equal to the last one skips the deploy (and the archive), which is what a rollback needs when the
 * upgrade deploy never ran.
 */
/** The init-style Ctx deployProject takes, from an ops context. */
export function deployCtx(ctx: OpsCtx): Ctx {
  return {
    ui: makeUi({ json: false, nonInteractive: true }),
    args: { positionals: [], flags: {} },
    dir: ctx.dir,
    run: wranglerRun,
    fetch: ctx.fetch,
    env: ctx.env,
    sleep: ctx.sleep,
    now: ctx.now,
    prompt: { ask: async () => "", askHidden: async () => "" },
    interactive: false,
  };
}

export const realHooks: Hooks = {
  async deploy(ctx, install) {
    const p = projectPaths(ctx.dir);
    const state = await readState(p);
    const uiCtx = deployCtx(ctx);
    await deployProject(uiCtx, {
      config: await loadConfig(p.config),
      accountId: install.accountId,
      url: install.url,
      send: {},
      fakeTelegram: state.fakeTelegram,
      before: state.deployedAt ? () => preUpgradeArchive(uiCtx, install.url, install.token) : undefined,
    });
  },
};

// ---------------------------------------------------------------- docker and the contract

const tagOf = (v: string, prefix = "") => `ochost-upgrade:${prefix}${v.replace(/[^\w.-]/g, "_")}`;

async function dockerBuild(ctx: OpsCtx, source: string, pin: ImagePin, tag: string): Promise<void> {
  const args = ["build", "-q", "-t", tag, "--build-arg", "OCSUP_SHA=upgrade"];
  for (const [k, v] of Object.entries(buildVarsOf(pin))) args.push("--build-arg", `${k}=${v}`);
  args.push(join(source, "image"));
  ctx.out.step(`docker build ${tag} FROM ${pin.ref.slice(0, 45)}…`);
  const r = await ctx.run("docker", args);
  if (r.code !== 0)
    throw new CliError(
      `docker build failed for ${pin.version}: ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200)}`,
      "check the version exists and docker works (docker version)",
    );
}

interface ContractCheck {
  label: string;
  ok: boolean;
  measured?: unknown;
}
export interface ContractResult {
  status: string;
  checks: ContractCheck[];
  measured?: { schema?: { status?: string; found?: number; target?: number } };
  error?: string | null;
  blocked?: string | null;
}

/** Run image/test/run.mjs _upgrade-contract on the built candidate; returns its result JSON. */
export async function runContract(
  ctx: OpsCtx,
  source: string,
  target: Target,
  tag: string,
  prevTag: string,
): Promise<ContractResult> {
  const dir = await mkdtemp(join(tmpdir(), "ochost-contract-"));
  try {
    ctx.out.step("image contract in Docker (boot, Doctor, preflight, lock probe, SIGTERM; 5-10 min)");
    const r = await ctx.run(
      process.execPath,
      [
        join(source, "image", "test", "run.mjs"),
        "_upgrade-contract",
        "--no-build",
        "--image",
        tag,
        "--prev-image",
        prevTag,
        "--results",
        dir,
        "--date",
        "upgrade",
      ],
      { env: { OCM1_UC_VERSION: target.version, OCM1_VERBOSE: "0" } },
    );
    let res: ContractResult | null = null;
    try {
      res = JSON.parse(await readFile(join(dir, "upgrade", "_upgrade-contract.json"), "utf8"));
    } catch {}
    if (!res)
      throw new CliError(
        `the image contract did not run (exit ${r.code}): ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 200)}`,
        "needs a clone of oc-host and a working docker; rerun",
      );
    return res;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Throw the named reason when the contract result is not a pass. A schema change is named first. */
export function judgeContract(r: ContractResult, target: Target): void {
  const s = r.measured?.schema;
  if (s?.status && s.status !== "exact")
    throw new CliError(
      `${target.version} changes the state schema (database preflight ${s.status}, found ${s.found ?? "?"}, target ${s.target ?? "?"})`,
      "the dark/lit cutover is not built; stay on the pinned version",
    );
  if (r.status === "pass") return;
  const bad = r.checks.filter((c) => !c.ok).map((c) => c.label);
  const why = r.error ?? r.blocked ?? (bad.length ? bad.join("; ") : r.status);
  throw new CliError(
    `image contract failed for ${target.version}: ${why.slice(0, 300)}`,
    "see image/test/README.md; stay on the pinned version",
  );
}

// ---------------------------------------------------------------- watch

interface Snap {
  digest: string | null;
  channels: Map<string, number>;
}

function snapOf(body: any): Snap {
  const channels = new Map<string, number>();
  for (const c of body?.channels ?? []) channels.set(`${c.channel}/${c.account}`, Number(c.updatedAt) || 0);
  return { digest: body?.epoch?.digest ?? null, channels };
}

/**
 * Poll /ops/status until the install is `running` and healthy: heartbeat phase `running`, ladder level 0, not
 * degraded, the epoch digest moved off `from` (when given), and every channel seen before has a newer
 * heartbeat. Returns null on success, else the reason at the end of the window (or at restore-blocked).
 */
export async function watchBoot(
  ctx: OpsCtx,
  ops: OpsClient,
  before: Snap,
  o: { changeFrom?: string | null; timeoutMs: number },
): Promise<string | null> {
  const t0 = ctx.now();
  let why = "no status yet";
  while (ctx.now() - t0 < o.timeoutMs) {
    await ctx.sleep(5000);
    const r = await ops
      .call("GET", "/ops/status", undefined, { allow: [200, 500, 502, 503] })
      .catch(() => null);
    const b = r?.body;
    if (!b || r?.status !== 200) {
      why = `status ${r?.status ?? "unreachable"}`;
      continue;
    }
    const now = snapOf(b);
    const missing = [...before.channels]
      .filter(([k, at]) => (now.channels.get(k) ?? 0) <= at)
      .map(([k]) => k);
    if (b.state === "restore-blocked") return `restore-blocked (${b.gen?.reason ?? "see ochost logs"})`;
    if (b.state !== "running") why = `state ${b.state}`;
    else if (b.degraded || (b.ladder?.level ?? 0) > 0)
      why = `running but degraded (ladder level ${b.ladder?.level ?? 0})`;
    else if (b.rt?.hb?.phase !== "running") why = `heartbeat phase ${b.rt?.hb?.phase ?? "none"}`;
    else if (o.changeFrom && now.digest === o.changeFrom) why = "still on the old image digest";
    else if (missing.length) why = `channels not back: ${missing.join(", ")}`;
    else return null;
    ctx.out.step(`watch: ${why}, ${Math.round((ctx.now() - t0) / 1000)} s`);
  }
  return why;
}

// ---------------------------------------------------------------- run, rollback

/** Restart so the epoch adopts the deployed image, then watch. Returns null when healthy, else the reason. */
async function restartAndWatch(
  ctx: OpsCtx,
  ops: OpsClient,
  before: Snap,
  changeFrom: string | null,
  timeoutMs: number,
): Promise<string | null> {
  const r = await ops.call("POST", "/ops/restart", undefined, { timeoutMs: RESTART_CALL_MS });
  if (r.body?.start && r.body.start.ok === false) return `start refused (state ${r.body.start.state})`;
  ctx.out.step("restarted; watching /ops/status");
  return watchBoot(ctx, ops, before, { changeFrom, timeoutMs });
}

async function snapshot(ops: OpsClient): Promise<{ snap: Snap; state: string }> {
  const s = await ops.call("GET", "/ops/status");
  return { snap: snapOf(s.body), state: String(s.body?.state ?? "") };
}

/** Pin → deploy → restart → watch; on failure after the pin changed, put the old pin back and redeploy it. */
async function switchTo(
  ctx: OpsCtx,
  hooks: Hooks,
  ops: OpsClient,
  stateDir: string,
  next: ImageFile,
  old: ImageFile,
  verb: string,
): Promise<{ ok: boolean; rolledBack: boolean; why?: string }> {
  const timeoutMs = flagInt(ctx.args, "timeout", 600, 30, 7200) * 1000;
  const { snap: before } = await snapshot(ops);
  await writeImageFile(stateDir, { ...next, updatedAt: new Date(ctx.now()).toISOString() });
  let why: string | null;
  let deployed = false;
  try {
    ctx.out.step(`${verb}: deploy with pin ${next.current?.version}`);
    await hooks.deploy(ctx, ops.install);
    deployed = true;
    why = await restartAndWatch(ctx, ops, before, before.digest, timeoutMs);
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  if (!why) {
    const { snap } = await snapshot(ops);
    await writeImageFile(stateDir, {
      ...next,
      epochDigest: snap.digest ?? undefined,
      updatedAt: new Date(ctx.now()).toISOString(),
    });
    return { ok: true, rolledBack: false };
  }
  ctx.out.step(`${verb} failed: ${why}`);
  ctx.out.step(`rolling back to ${old.current?.version}: redeploy the previous image map`);
  await writeImageFile(stateDir, old);
  const cur = (await snapshot(ops).catch(() => ({ snap: before }))).snap;
  try {
    await hooks.deploy(ctx, ops.install);
    // A deploy that threw never restarted anything: the epoch still runs the old image, so no restart.
    const bad = deployed
      ? await restartAndWatch(ctx, ops, before, cur.digest === before.digest ? null : cur.digest, timeoutMs)
      : null;
    if (bad)
      throw new CliError(
        `rollback to ${old.current?.version} did not come up: ${bad}`,
        "ochost status; ochost logs --source rt; ochost backup list",
      );
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(
      `rollback redeploy failed: ${e instanceof Error ? e.message : e}`,
      "ochost deploy --force, then ochost status",
    );
  }
  return { ok: false, rolledBack: true, why };
}

export async function run(ctx: OpsCtx, hooks: Hooks): Promise<number> {
  const ops = opsClient(ctx);
  const stateDir = join(ctx.dir, STATE_DIR);
  const spec = trackOf(ctx);
  const [target, p] = await Promise.all([resolveTarget(ctx.fetch, spec), pinned(ctx)]);
  const delta = deltaOf(p.pin, target);
  if (delta !== "newer")
    throw new CliError(
      delta === "same"
        ? `already on ${p.pin.version} (${short(p.pin.digest)})`
        : delta === "older"
          ? `${target.version} is older than the pin ${p.pin.version}`
          : `${target.version} has a new digest (a moved tag); not upgrading by itself`,
      delta === "same"
        ? "nothing to do; ochost upgrade check"
        : "ochost upgrade check, then pick a newer version with --to",
      delta === "same" ? EXIT.ok : EXIT.failed,
    );
  const file = await readImageFile(stateDir);
  const old: ImageFile = { ...file, current: file.current ?? p.pin };
  const next: ImageFile = { current: pinOf(target.version, target.digest), previous: p.pin };

  const { state } = await snapshot(ops);
  ctx.out.step(`upgrade ${p.pin.version} -> ${target.version} (install ${state})`);
  const tag = tagOf(target.version);
  const prevTag = tagOf(p.pin.version, "pin-");
  await dockerBuild(ctx, p.source, next.current as ImagePin, tag);
  await dockerBuild(ctx, p.source, p.pin, prevTag);
  judgeContract(await runContract(ctx, p.source, target, tag, prevTag), target);
  ctx.out.step("contract passed");

  const r = await switchTo(ctx, hooks, ops, stateDir, next, old, "upgrade");
  if (ctx.out.json)
    ctx.out.result({
      ok: r.ok,
      rolledBack: r.rolledBack,
      from: p.pin.version,
      to: target.version,
      why: r.why ?? null,
    });
  if (r.ok) {
    ctx.out.line(`upgraded ${p.pin.version} -> ${target.version}; notes ${notesUrl(target.version)}`);
    return EXIT.ok;
  }
  ctx.out.line(`rolled back to ${p.pin.version} (upgrade failed: ${r.why})`);
  return EXIT.failed;
}

export async function rollback(ctx: OpsCtx, hooks: Hooks): Promise<number> {
  const ops = opsClient(ctx);
  const stateDir = join(ctx.dir, STATE_DIR);
  const file = await readImageFile(stateDir);
  if (!file.previous || !file.current)
    throw new CliError(
      "no previous image to go back to",
      "rollback follows an upgrade run; for code use git + ochost deploy",
    );
  const next: ImageFile = { current: file.previous, previous: file.current };
  const r = await switchTo(ctx, hooks, ops, stateDir, next, file, "rollback");
  if (ctx.out.json)
    ctx.out.result({ ok: r.ok, from: file.current.version, to: file.previous.version, why: r.why ?? null });
  if (!r.ok)
    throw new CliError(
      `rollback to ${file.previous.version} failed: ${r.why}; back on ${file.current.version}`,
      "ochost status; ochost logs --source rt",
    );
  ctx.out.line(`rolled back ${file.current.version} -> ${file.previous.version}`);
  return EXIT.ok;
}

export async function upgrade(ctx: OpsCtx, hooks: Hooks = realHooks): Promise<number> {
  const s = ctx.args.positionals[0] ?? "check";
  if (s === "check") return check(ctx);
  if (s === "run") return run(ctx, hooks);
  if (s === "rollback") return rollback(ctx, hooks);
  throw new CliError(`unknown subcommand ${s}`, "use one of: check, run, rollback", EXIT.usage);
}
