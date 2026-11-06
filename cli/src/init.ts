// ochost init [dir]: zero to a live install (spec 10 §2). plan() is pure (options + probes → steps);
// runInit() executes them. Pattern from cf-orbs cli/src/commands/init.ts.
// Re-run safe: each step checks before it acts; a second run with nothing changed makes no deploy, no
// secret change and no restart. State goes to .oc-host/state.json after each step.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chooseGateway, gateEndpoint, gateSmoke } from "./ai-gateway.ts";
import {
  bucketOf,
  DEFAULT_GATEWAY,
  DEFAULT_MODEL,
  defaultConfigText,
  loadConfig,
  MODEL_RE,
  NO_GATEWAY,
  type OcHostConfig,
  parseInstance,
  parseJsonc,
  renderOpenclawDoc,
  setTopLevelJsonc,
} from "./config.ts";
import {
  deployProject,
  ensureGitignore,
  type ProjectPaths,
  projectPaths,
  readState,
  type State,
  writeState,
} from "./deploy.ts";
import { askPost, materializeToken, postOptionsOf, postSteps, runPost } from "./init-post.ts";
import {
  AI_SECRET,
  planSecrets,
  readControlToken,
  readManifest,
  readTokenFile,
  sha256,
  sweepTemp,
  writeControlToken,
} from "./secrets.ts";
import { dirArg, nextCommand, selfCommand } from "./self.ts";
import { COST_ALWAYS_ON, COST_LIGHT, nextCommands, type SummaryInput, summaryLines } from "./summary.ts";
import { CliError, type Ctx, EXIT, flagBool, flagString, fmtSecs, registerSecret } from "./ui.ts";
import {
  type Account,
  bucketCreate,
  type CfClient,
  checkSubdomain,
  dockerOk,
  makeCf,
  makeWrangler,
  r2Active,
  r2NotEnabled,
  registerSubdomain,
  type SubdomainCheck,
  secretNames,
  suggestSubdomain,
  type WhoAmI,
  type WorkerInfo,
  whoami,
  workerInfo,
  workersPaid,
  wranglerBearer,
} from "./wrangler.ts";

const STEP_LABEL: Record<InitStep["kind"], string> = {
  fail: "preflight",
  account: "account",
  "r2-enable": "r2 enable",
  adopt: "adopt",
  subdomain: "subdomain",
  scaffold: "files",
  ai: "ai model",
  aihop: "model hop",
  secrets: "secrets",
  r2: "r2 bucket",
  deploy: "deploy",
  health: "health",
  config: "config",
  start: "start",
  selftest: "self-test",
  login: "login",
  done: "done",
};

export const PROVISION_BUDGET_MS = 10 * 60_000;
export const HEALTH_BUDGET_MS = 90_000;

export interface InitOptions {
  nonInteractive: boolean;
  accountId?: string;
  name: string;
  subdomain?: string;
  adopt: boolean;
  aiTokenFile?: string;
  gateway?: string;
  model?: string;
  instance?: string;
  /** R2 bucket override (test groups: oc-m5-<group>); default oc-host-<inst> */
  bucket?: string;
  noOpen: boolean;
  skipAi: boolean;
  acceptLoss: boolean;
  /** true: deploy with OC_TEST=1 (fake Telegram); false: back to real; undefined: keep what state.json has */
  fakeTelegram?: boolean;
  /** S1.11: the owner's Telegram user id; its first DM is approved without a code. */
  telegramOwner?: string;
  /** docs/20 §1: the sandbox setting goes into oc-host.jsonc before the first deploy. */
  sandbox?: "on" | "all" | "off";
}

export interface InitProbes {
  nodeVersion: string;
  docker: boolean;
  whoami: WhoAmI;
  /** resolved account (flag, the only one, or picked); undefined when not resolvable */
  accountId?: string;
  accountName?: string;
  /** wrangler gave an API bearer */
  bearer: boolean;
  paid: boolean | "unknown";
  r2: boolean | "unknown";
  subdomain: SubdomainCheck;
  worker: WorkerInfo | "unknown";
  local: {
    /** .oc-host/state.json has a URL (this dir manages an install) */
    state: boolean;
    controlToken: boolean;
    inst?: string;
  };
  interactive: boolean;
}

/** "file": the opt-in --ai-token-file picks or creates the gateway through the API. "default": no token. */
export type AiSource = "file" | "default";

export type InitStep =
  | { kind: "fail"; error: CliError }
  | { kind: "account"; accountId: string; accountName?: string }
  | { kind: "r2-enable" }
  | { kind: "adopt"; confirm: boolean }
  | { kind: "subdomain"; action: "has" | "register" | "ask"; subdomain?: string }
  | { kind: "scaffold" }
  | { kind: "ai"; source: AiSource }
  | { kind: "secrets" }
  | { kind: "r2" }
  | { kind: "deploy" }
  | { kind: "health" }
  | { kind: "aihop" }
  | { kind: "config" }
  | { kind: "start" }
  | { kind: "selftest" }
  | { kind: "login" }
  | { kind: "done" };

/** True when v is at least 22.18, the rule in package.json engines. */
export function nodeOk(v: string): boolean {
  const [major = 0, minor = 0] = v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  return major > 22 || (major === 22 && minor >= 18);
}

/** Pure planner. Every failed precondition shows in one run; then the plan is only the failures. */
export function plan(o: InitOptions, p: InitProbes): InitStep[] {
  const fails: CliError[] = [];
  const steps: InitStep[] = [];
  if (!nodeOk(p.nodeVersion))
    fails.push(new CliError("Node 22.18 or later is needed", "install Node 22.18+, then rerun"));
  if (!p.docker)
    fails.push(new CliError("Docker is not running", "start Docker, check docker info, then rerun"));
  if (!p.whoami.loggedIn) {
    fails.push(
      new CliError(
        "wrangler is not logged in",
        "run npx wrangler login, then rerun ochost init",
        EXIT.manual,
      ),
    );
  } else if (
    o.accountId &&
    p.whoami.accounts.length &&
    !p.whoami.accounts.some((a) => a.id === o.accountId)
  ) {
    fails.push(
      new CliError(
        `account ${o.accountId} is not in wrangler whoami`,
        "pass an account id that npx wrangler whoami lists",
      ),
    );
  } else if (p.whoami.accounts.length === 0 && !o.accountId) {
    fails.push(
      new CliError(
        "wrangler whoami lists no accounts",
        "run npx wrangler login with an account on Workers Paid",
        EXIT.manual,
      ),
    );
  } else if (!p.accountId) {
    fails.push(
      new CliError(
        `this login has ${p.whoami.accounts.length} Cloudflare accounts`,
        "rerun with --account-id <id>",
        EXIT.manual,
      ),
    );
  }
  if (p.accountId) {
    steps.push({ kind: "account", accountId: p.accountId, accountName: p.accountName });
    if (!p.bearer)
      fails.push(
        new CliError("wrangler gave no API token", "run npx wrangler login again, then rerun", EXIT.manual),
      );
    if (p.paid === false)
      fails.push(
        new CliError(
          "account is not on Workers Paid",
          "upgrade at https://dash.cloudflare.com/?to=/:account/workers/plans ($5/month), then rerun",
          EXIT.manual,
        ),
      );
    if (p.r2 === false) {
      if (p.interactive) steps.push({ kind: "r2-enable" });
      else fails.push(r2NotEnabled());
    }
    if (p.worker !== "unknown" && p.worker.exists && !p.local.state && !p.worker.vars?.OC_INST) {
      // A Worker of that name that is not ours (no OC_INST var): never adopt it.
      fails.push(
        new CliError(
          `a Worker named ${o.name} exists on this account, and it is not an oc-host install`,
          `rerun with --name <other>, or delete it: npx wrangler delete --name ${o.name}`,
          EXIT.manual,
        ),
      );
    } else if (p.worker !== "unknown" && p.worker.exists && !p.local.state) {
      if (o.adopt) steps.push({ kind: "adopt", confirm: false });
      else if (p.interactive) steps.push({ kind: "adopt", confirm: true });
      else
        fails.push(
          new CliError(
            `an oc-host install already runs as ${o.name}`,
            "rerun with --adopt to manage it from here",
            EXIT.manual,
          ),
        );
    }
    if (p.subdomain.kind === "has")
      steps.push({ kind: "subdomain", action: "has", subdomain: p.subdomain.subdomain });
    else if (p.subdomain.kind === "unknown")
      fails.push(new CliError("could not read the workers.dev subdomain", "check your network, then rerun"));
    else if (o.subdomain) steps.push({ kind: "subdomain", action: "register", subdomain: o.subdomain });
    else if (p.interactive) steps.push({ kind: "subdomain", action: "ask" });
    else fails.push(new CliError("no workers.dev subdomain", "rerun with --subdomain <name>", EXIT.manual));
  }
  // Zero-token: model calls run on the Worker's AI binding. --ai-token-file is an opt-in to pick or create a
  // gateway through the API; without it the gateway is `default` (made on first use) or --gateway.
  const ai: AiSource | undefined = o.skipAi ? undefined : o.aiTokenFile ? "file" : "default";
  if (fails.length) return fails.map((error) => ({ kind: "fail", error }));
  steps.push({ kind: "scaffold" });
  if (ai) steps.push({ kind: "ai", source: ai });
  steps.push(
    { kind: "secrets" },
    { kind: "r2" },
    { kind: "deploy" },
    { kind: "health" },
    ...(ai ? [{ kind: "aihop" } as const] : []),
    { kind: "config" },
    { kind: "start" },
    { kind: "selftest" },
    { kind: "login" },
    { kind: "done" },
  );
  return steps;
}

/** Exit code for a list of failures: 1 if any is "broken", else 3 (needs a human), else the max. */
export function failExit(errors: CliError[]): number {
  if (errors.some((e) => e.exit === EXIT.failed)) return EXIT.failed;
  return Math.max(...errors.map((e) => e.exit));
}

// ---------------------------------------------------------------- probes

export interface Gathered {
  probes: InitProbes;
  cf?: CfClient;
  /** wrangler OAuth bearer (never printed); ai-gateway tries it first for the gateway list */
  bearer?: string;
  /** time the probes took; shown as step 1 */
  preflightMs?: number;
}

export async function gatherProbes(ctx: Ctx, o: InitOptions): Promise<Gathered> {
  const p = projectPaths(ctx.dir);
  const w = makeWrangler(ctx.run);
  const [docker, who, state, ct] = await Promise.all([
    dockerOk(ctx.run),
    whoami(w),
    readState(p),
    readControlToken(p.controlToken),
  ]);
  let inst = state.inst;
  if (!inst && existsSync(p.config)) {
    try {
      inst = (parseJsonc(await readFile(p.config, "utf8")) as { inst?: string }).inst;
    } catch {}
  }
  let accountId = o.accountId ?? state.accountId;
  if (accountId && who.accounts.length && !who.accounts.some((a) => a.id === accountId) && !o.accountId)
    accountId = undefined;
  if (!accountId && who.accounts.length === 1) accountId = (who.accounts[0] as Account).id;
  if (!accountId && who.accounts.length > 1 && ctx.interactive && !o.nonInteractive) {
    for (const [i, a] of who.accounts.entries()) ctx.ui.step(`  ${i + 1}) ${a.name} (${a.id})`);
    const ans = await ctx.prompt.ask(`Cloudflare account [1-${who.accounts.length}]: `);
    const pick = who.accounts[Number.parseInt(ans, 10) - 1];
    if (!pick)
      throw new CliError(
        `no account number ${JSON.stringify(ans)}`,
        "rerun and type a number from the list, or pass --account-id",
      );
    accountId = pick.id;
  }
  const accountName = who.accounts.find((a) => a.id === accountId)?.name;
  const probes: InitProbes = {
    nodeVersion: process.versions.node,
    docker,
    whoami: who,
    accountId,
    accountName,
    bearer: false,
    paid: "unknown",
    r2: "unknown",
    subdomain: { kind: "unknown" },
    worker: "unknown",
    local: {
      state: Boolean(state.url),
      controlToken: Boolean(ct),
      inst,
    },
    interactive: ctx.interactive && !o.nonInteractive,
  };
  if (!accountId || !who.loggedIn) return { probes };
  const bearer = await wranglerBearer(makeWrangler(ctx.run, { accountId }));
  if (!bearer) return { probes };
  const cf = makeCf(ctx.fetch, bearer, ctx.sleep);
  const [paid, r2, subdomain, worker] = await Promise.all([
    workersPaid(cf, accountId),
    r2Active(cf, accountId),
    checkSubdomain(cf, accountId),
    workerInfo(cf, accountId, o.name),
  ]);
  return { probes: { ...probes, bearer: true, paid, r2, subdomain, worker }, cf, bearer };
}

/** Name of the first zone on the account, or undefined (no zone, no scope, no answer). */
async function firstZone(cf: CfClient, accountId: string): Promise<string | undefined> {
  try {
    const r = await cf.call<{ name: string }[]>("GET", `/zones?account.id=${accountId}&per_page=1`);
    return r.status === 200 ? r.j.result?.[0]?.name : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- Worker /ops client

interface OpsResponse {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

export function makeOps(ctx: Ctx, url: string, token: string | undefined) {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<OpsResponse> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await ctx.fetch(`${url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch (e) {
      return { status: 0, body: {}, text: (e as Error).message };
    }
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object") parsed = j as Record<string, unknown>;
    } catch {}
    return { status: res.status, body: parsed, text };
  };
  return {
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown) => call("POST", p, b ?? {}),
  };
}

// ---------------------------------------------------------------- executor

export interface InitResult {
  ok: true;
  url: string;
  openUrl?: string;
  openUrlExpiresAt?: string;
  inst: string;
  mode: string;
  model?: string;
  gateway?: string;
  adopted: boolean;
  fakeTelegram: boolean;
  bot: string | null;
  cost: { lightUsd: [number, number]; lightHighUsd: number; alwaysOnUsd: [number, number] };
  nextCommands: { cmd: string; why: string }[];
  deploy: string;
  timings: Record<string, number>;
  next: string;
}

function randomInst(): string {
  return randomBytes(3).toString("hex");
}

async function saveStep(p: ProjectPaths, patch: Partial<State>): Promise<State> {
  const s = { ...(await readState(p)), ...patch };
  await writeState(p, s);
  return s;
}

/** Set llm.gateway / llm.primary / instance in oc-host.jsonc when they changed. */
async function updateConfigFile(
  path: string,
  c: OcHostConfig,
  patch: { gateway?: string; model?: string; instance?: string; sandbox?: "on" | "all" | "off" },
) {
  let text = await readFile(path, "utf8");
  let changed = false;
  if (patch.instance && patch.instance !== c.instance) {
    text = setTopLevelJsonc(text, "instance", patch.instance);
    changed = true;
  }
  if (patch.sandbox && patch.sandbox !== (c.sandbox ?? "off")) {
    text = setTopLevelJsonc(text, "sandbox", patch.sandbox);
    changed = true;
  }
  const llm = { ...c.llm };
  if (patch.gateway && patch.gateway !== llm.gateway) llm.gateway = patch.gateway;
  if (patch.model && patch.model !== llm.primary) llm.primary = patch.model;
  if (llm.gateway !== c.llm.gateway || llm.primary !== c.llm.primary) {
    text = setTopLevelJsonc(text, "llm", llm);
    changed = true;
  }
  if (changed) await writeFile(path, text);
  return changed;
}

export async function runInit(ctx: Ctx, o: InitOptions, steps: InitStep[], g: Gathered): Promise<InitResult> {
  const { ui } = ctx;
  const p = projectPaths(ctx.dir);
  const fails = steps.filter((s): s is Extract<InitStep, { kind: "fail" }> => s.kind === "fail");
  if (fails.length) {
    for (const f of fails.slice(0, -1)) ui.step(f.error.message);
    const last = (fails[fails.length - 1] as { error: CliError }).error;
    throw new CliError(last.cause_, last.fix, failExit(fails.map((f) => f.error)));
  }
  const t0 = ctx.now();
  const timings: Record<string, number> = {};
  let state = await readState(p);
  let accountId = "";
  let accountName: string | undefined;
  let subdomain = "";
  let config: OcHostConfig | undefined;
  let url = state.url ?? "";
  let ai: { gateway: string; model: string } | undefined;
  let adopted = Boolean(state.adopted);
  let adoptInfo: WorkerInfo | undefined;
  let send: Record<string, string> = {};
  let controlToken: string | undefined;
  let deployAction = "none";
  let openUrl: string | undefined;
  let openUrlExpiresAt: string | undefined;
  let openUrlMinutes: number | undefined;
  let firstInstall = !state.configVer && !state.adopted && !o.adopt;
  const fakeTelegram = o.fakeTelegram ?? state.fakeTelegram ?? false;
  const cf = g.cf;
  const w = () => makeWrangler(ctx.run, { accountId });

  const summaryOf = (cfg: OcHostConfig): SummaryInput => ({
    url,
    openUrl,
    openUrlMinutes,
    bot: state.telegramBot,
    fakeTelegram,
    model: o.skipAi && !ai ? undefined : (ai?.model ?? cfg.llm.primary),
    gateway: o.skipAi && !ai ? undefined : (ai?.gateway ?? cfg.llm.gateway),
    sleepMode: cfg.sleep.mode,
    idleMinutes: cfg.sleep.idleMinutes,
    elapsedMs: ctx.now() - t0,
    self: selfCommand(),
    dirArg: dirArg(ctx.dir),
  });
  const total = steps.filter((x) => x.kind !== "done").length + 1;
  ui.end({
    n: 1,
    total,
    label: "preflight",
    detail: "node, docker, wrangler login, plan",
    ms: g.preflightMs ?? 0,
  });
  let n = 1;
  for (const s of steps) {
    const st = ctx.now();
    const numbered = s.kind !== "done";
    let detail: string | undefined;
    if (numbered) {
      n++;
      ui.begin();
    }
    let finished = false;
    try {
      switch (s.kind) {
        case "fail":
          throw s.error;
        case "account":
          accountId = s.accountId;
          accountName = s.accountName;
          ui.step(
            `account: ${accountName ?? ""} (${accountId}); Workers Paid ${g.probes.paid === true ? "ok" : "not checked (probe failed)"}`,
            "account",
          );
          detail = `${accountName ?? accountId}, Workers Paid ${g.probes.paid === true ? "ok" : "not checked"}`;
          break;
        case "r2-enable": {
          ui.say(
            "R2 is not enabled on this account. Open this link, select Purchase R2 / Enable (no charge under the free tier):",
          );
          ui.say("  https://dash.cloudflare.com/?to=/:account/r2/overview");
          for (;;) {
            await ctx.prompt.ask("Press Enter when R2 is on: ");
            if (cf && (await r2Active(cf, accountId)) === true) break;
            ui.say("R2 is still off. Enable it in the dashboard, then press Enter.");
          }
          detail = "R2 enabled";
          break;
        }
        case "adopt": {
          if (s.confirm) {
            const a = await ctx.prompt.ask(
              `Worker ${o.name} already runs an oc-host install. Manage it from here (new control token)? [y/N] `,
            );
            if (!/^y(es)?$/i.test(a))
              throw new CliError(
                `an oc-host install already runs as ${o.name}`,
                "rerun with --adopt, or pick another --name",
                EXIT.manual,
              );
          }
          adopted = true;
          const wi = g.probes.worker;
          adoptInfo = wi !== "unknown" ? wi : undefined;
          ui.step(
            `adopt: Worker ${o.name} (inst ${adoptInfo?.vars?.OC_INST ?? "?"}); a new control token replaces the old one`,
            "adopt",
          );
          detail = `adopting Worker ${o.name}`;
          break;
        }
        case "subdomain": {
          if (s.action === "has") subdomain = s.subdomain as string;
          else {
            let name = s.subdomain;
            if (s.action === "ask") {
              const def = suggestSubdomain(accountName);
              name =
                (await ctx.prompt.ask(`This account has no workers.dev subdomain. Name for it [${def}]: `)) ||
                def;
            }
            if (!cf) throw new Error("init bug: no CF client");
            await registerSubdomain(cf, accountId, name as string);
            subdomain = name as string;
            ui.step(`workers.dev subdomain: registered ${subdomain}.workers.dev`, "subdomain");
          }
          url = `https://${o.name}.${subdomain}.workers.dev`;
          ui.step(`url: ${url}`, "subdomain");
          detail = url;
          break;
        }
        case "scaffold": {
          await mkdir(p.stateDir, { recursive: true });
          if (!existsSync(p.config)) {
            const inst = adoptInfo?.vars?.OC_INST ?? state.inst ?? randomInst();
            const bucket = o.bucket ?? adoptInfo?.bucket ?? adoptInfo?.vars?.OC_BUCKET;
            await writeFile(
              p.config,
              defaultConfigText({
                name: o.name,
                inst,
                accountId,
                instance: o.instance,
                bucket: bucket && bucket !== `oc-host-${inst}` ? bucket : undefined,
                gateway: o.gateway,
                model: o.model,
              }),
            );
            ui.step(`scaffold: wrote oc-host.jsonc (inst ${inst})`, "scaffold");
          }
          config = await loadConfig(p.config);
          if (config.name !== o.name)
            throw new CliError(
              `oc-host.jsonc has name ${config.name}, but --name is ${o.name}`,
              "use the same --name, or init another install in an empty dir",
            );
          if (
            await updateConfigFile(p.config, config, {
              instance: o.instance,
              gateway: o.gateway,
              model: o.model,
              sandbox: o.sandbox,
            })
          ) {
            config = await loadConfig(p.config);
            ui.step("scaffold: updated oc-host.jsonc from flags", "scaffold");
          }
          await ensureGitignore(p);
          detail = "oc-host.jsonc and .oc-host/ in place";
          state = await saveStep(p, {
            step: "scaffold",
            url,
            inst: config.inst,
            accountId,
            name: config.name,
            bucket: bucketOf(config),
            adopted,
            fakeTelegram: fakeTelegram || undefined,
          });
          if (fakeTelegram)
            ui.warn(
              "test install (--fake-telegram): the Worker runs with OC_TEST=1 and Telegram is a fake; a real bot will not work — fix: ochost init --no-fake-telegram",
            );
          break;
        }
        case "ai": {
          ai = await runAiStep(ctx, o, {
            accountId,
            config: config as OcHostConfig,
            bearer: g.bearer,
          });
          if (
            await updateConfigFile(p.config, config as OcHostConfig, { gateway: ai.gateway, model: ai.model })
          )
            config = await loadConfig(p.config);
          state = await saveStep(p, { step: "ai", gateway: ai.gateway, model: ai.model });
          detail = `${ai.model.split("/").pop()} via ${ai.gateway === NO_GATEWAY ? "no gateway" : `gateway ${ai.gateway}`}`;
          break;
        }
        case "secrets": {
          const manifest = await readManifest(p.manifest);
          const existsOnCf = adopted || (g.probes.worker !== "unknown" && g.probes.worker.exists);
          const onWorker = existsOnCf ? await secretNames(w(), o.name) : undefined;
          if (existsOnCf && onWorker === undefined)
            throw new CliError(
              "could not list the Worker secrets (wrangler secret list)",
              "rerun ochost init",
            );
          const local = await readControlToken(p.controlToken);
          const sp = planSecrets({
            onWorker,
            manifest,
            localControlToken: local,
            adopt: adopted && !local,
          });
          if (onWorker?.includes(AI_SECRET))
            ui.warn(
              `the Worker still holds ${AI_SECRET}; it is not used and never reaches the container now — fix: npx wrangler secret delete ${AI_SECRET} --name ${o.name}`,
            );
          controlToken = sp.controlToken;
          if (controlToken !== local) await writeControlToken(p.controlToken, p.stateDir, controlToken);
          send = sp.send;
          ui.step(
            `secrets: ${Object.keys(send).length ? `send ${Object.keys(send).join(", ")}` : "none to send"}${sp.keep.length ? `; keep ${sp.keep.length}` : ""}`,
            "secrets",
          );
          detail = Object.keys(send).length
            ? `sent ${Object.keys(send).length}, kept ${sp.keep.length}`
            : `none to send, kept ${sp.keep.length}`;
          state = await saveStep(p, { step: "secrets" });
          break;
        }
        case "r2": {
          const bucket = bucketOf(config as OcHostConfig);
          const r = await bucketCreate(w(), bucket);
          ui.step(`r2: bucket ${bucket} ${r === "created" ? "created" : "exists"}`, "r2");
          detail = `bucket ${bucket} ${r === "created" ? "created" : "exists"}`;
          state = await saveStep(p, { step: "r2" });
          break;
        }
        case "deploy": {
          if (adopted && !state.deployHash) {
            // adopt: no image change; only the new secrets go to the Worker
            const r = await deployProject(ctx, {
              config: config as OcHostConfig,
              accountId,
              url,
              send,
              secretsOnly: true,
              fakeTelegram,
            });
            deployAction = r.action;
          } else {
            const r = await deployProject(ctx, {
              config: config as OcHostConfig,
              accountId,
              url,
              send,
              fakeTelegram,
            });
            deployAction = r.action;
          }
          detail =
            deployAction === "none"
              ? "no change, skipped"
              : deployAction === "secrets"
                ? "secrets sent, code unchanged"
                : "Worker and image deployed";
          state = await saveStep(p, { step: "deploy" });
          break;
        }
        case "health": {
          const ops = makeOps(ctx, url, controlToken);
          const until = ctx.now() + HEALTH_BUDGET_MS;
          for (;;) {
            const r = await ops.get("/ops/status");
            if (r.status === 200) {
              ui.step(`health: /ops/status 200 (state ${String(r.body.state ?? "not started")})`, "health");
              break;
            }
            // a new secret takes some seconds to reach every isolate (adopt measured: 404, then 200)
            if (ctx.now() >= until && r.status === 404 && adopted)
              throw new CliError(
                "the Worker refused the new control token",
                "rerun ochost init --adopt",
                EXIT.budget,
              );
            if (ctx.now() >= until)
              throw new CliError(
                `health check failed after ${fmtSecs(HEALTH_BUDGET_MS)} (HTTP ${r.status})`,
                "run ochost status in a minute; rerun ochost init (safe)",
                EXIT.budget,
              );
            ui.progress(`health: waiting for ${url} (HTTP ${r.status}), ${fmtSecs(ctx.now() - st)}`);
            await ctx.sleep(3_000);
          }
          ui.progressDone();
          detail = "Worker answers";
          break;
        }
        case "aihop": {
          const cfg = config as OcHostConfig;
          const gateway = ai?.gateway ?? cfg.llm.gateway;
          const model = ai?.model ?? cfg.llm.primary;
          const r = await gateSmoke(
            { endpoint: gateEndpoint(url, controlToken as string), model, gateway },
            {
              fetch: ctx.fetch,
              now: ctx.now,
              sleep: ctx.sleep,
              log: (l) => ui.warn(l.replace(/^WARN: /, "")),
            },
          );
          if (r.ok) {
            ui.step(
              `ai: ${model} answered through the gate in ${r.ms} ms (${r.neurons.toFixed(2)} neurons)`,
              "aihop",
            );
            detail = `${r.ms} ms`;
          } else detail = "no answer (warned)";
          break;
        }
        case "config": {
          const cfg = config as OcHostConfig;
          const doc = renderOpenclawDoc(
            ai || (!o.skipAi && state.gateway) ? { model: ai?.model ?? cfg.llm.primary } : null,
            { bucket: bucketOf(cfg), inst: cfg.inst },
          );
          const sha = sha256(JSON.stringify(doc));
          const ops = makeOps(ctx, url, controlToken);
          const list = await ops.get("/ops/config");
          if (list.status !== 200)
            throw new CliError(`GET /ops/config: HTTP ${list.status}`, "rerun ochost init");
          const versions = (list.body.versions ?? []) as { ver: number; sha: string }[];
          const newest = versions[0];
          let ver: number | undefined = newest?.ver;
          if (newest && newest.sha === sha) {
            ui.step(`config: ver ${newest.ver} is current`, "config");
            detail = `ver ${newest.ver} is current`;
          } else if (!newest || (state.configSha && newest.sha === state.configSha)) {
            const r = await ops.post("/ops/config", newest ? { doc, baseVer: newest.ver } : { doc });
            if (r.status !== 200)
              throw new CliError(
                `POST /ops/config: HTTP ${r.status} ${r.text.slice(0, 200)}`,
                "rerun ochost init",
              );
            ver = Number(r.body.ver);
            ui.step(`config: posted ver ${ver}`, "config");
            detail = `posted ver ${ver}`;
          } else {
            ui.step(
              `config: ver ${newest.ver} kept (changed after init; use ochost config to edit)`,
              "config",
            );
            detail = `ver ${newest.ver} kept (changed after init)`;
          }
          if (ver !== undefined) {
            const text = await readFile(p.config, "utf8");
            if ((config as OcHostConfig).baseVersion !== ver)
              await writeFile(p.config, setTopLevelJsonc(text, "baseVersion", ver));
          }
          const ours =
            !newest ||
            newest.sha === sha ||
            (state.configSha !== undefined && newest.sha === state.configSha);
          // S1.11: the owner's first DM to the bot is approved without a pairing code.
          if (o.telegramOwner) {
            const r = await ops.post("/ops/pairing/owner", { id: o.telegramOwner });
            if (r.status === 200)
              ui.step(`telegram: owner ${o.telegramOwner} approved on first DM`, "config");
            else
              ui.warn(
                `telegram owner not set (HTTP ${r.status}) — fix: ochost init --telegram-owner ${o.telegramOwner}`,
              );
          }
          state = await saveStep(p, {
            step: "config",
            configVer: ver,
            configSha: ours ? sha : state.configSha,
          });
          break;
        }
        case "start": {
          detail = await firstStart(ctx, makeOps(ctx, url, controlToken));
          state = await saveStep(p, { step: "start" });
          break;
        }
        case "selftest": {
          detail = await selfTest(ctx, url, makeOps(ctx, url, controlToken), firstInstall);
          firstInstall = false;
          state = await saveStep(p, { step: "selftest" });
          break;
        }
        case "login": {
          const r = await makeOps(ctx, url, controlToken).post("/ops/auth/code");
          if (r.status !== 200 || typeof r.body.url !== "string")
            throw new CliError(`POST /ops/auth/code: HTTP ${r.status}`, "run ochost open");
          openUrl = r.body.url;
          // not registered: openUrl is the result (sensitive, but the owner needs it)
          const exp = r.body.expiresAt ?? r.body.exp;
          openUrlExpiresAt =
            typeof exp === "number" ? new Date(exp).toISOString() : typeof exp === "string" ? exp : undefined;
          const left =
            typeof exp === "number" ? Math.max(1, Math.round((exp - ctx.now()) / 60_000)) : undefined;
          openUrlMinutes = left;
          detail = `single-use link${left ? `, ${left} min` : ""}`;
          if (!o.noOpen && ctx.interactive && ctx.openUrl) await ctx.openUrl(openUrl).catch(() => {});
          state = await saveStep(p, { step: "login" });
          break;
        }
        case "done": {
          const cfg = config as OcHostConfig;
          for (const l of summaryLines(summaryOf(cfg))) ui.out(l);
          // Opt-in, recommended: the account has a zone, so the UI can sit behind Cloudflare Access (docs/15-access.md).
          const zone = state.access || !cf ? undefined : await firstZone(cf, accountId);
          if (zone)
            ui.out(
              `Recommended: put the UI behind Cloudflare Access (zone ${zone}): ${selfCommand()} auth access --domain oc.${zone}`,
            );
          state = await saveStep(p, { step: "done" });
          break;
        }
      }
      finished = true;
    } finally {
      if (numbered && !finished)
        ui.end({ n, total, label: STEP_LABEL[s.kind], detail: "failed", ms: ctx.now() - st });
    }
    if (numbered) ui.end({ n, total, label: STEP_LABEL[s.kind], detail, ms: ctx.now() - st });
    timings[s.kind] = ctx.now() - st;
  }
  timings.total = ctx.now() - t0;
  const cfg = config as OcHostConfig;
  return {
    ok: true,
    url,
    openUrl,
    openUrlExpiresAt,
    inst: cfg.inst,
    mode: cfg.sleep.mode,
    model: o.skipAi ? undefined : (ai?.model ?? cfg.llm.primary),
    gateway: o.skipAi ? undefined : (ai?.gateway ?? cfg.llm.gateway),
    adopted,
    fakeTelegram,
    bot: state.telegramBot ?? null,
    cost: {
      lightUsd: [COST_LIGHT.lowUsd, COST_LIGHT.highUsd],
      lightHighUsd: COST_LIGHT.snapshotHighUsd,
      alwaysOnUsd: [COST_ALWAYS_ON.lowUsd, COST_ALWAYS_ON.highUsd],
    },
    nextCommands: nextCommands(summaryOf(cfg)),
    deploy: deployAction,
    timings,
    next: nextCommand(ctx.dir),
  };
}

// ---------------------------------------------------------------- step 7: AI Gateway (spec 10 §3.3)

/**
 * Step "ai": which gateway and model. No API call without the opt-in --ai-token-file (the gateway is `default`,
 * made by AI Gateway on its first request); with it, chooseGateway lists or creates through the API. The model
 * hop runs after deploy, through the gate (step "aihop").
 */
async function runAiStep(
  ctx: Ctx,
  o: InitOptions,
  c: { accountId: string; config: OcHostConfig; bearer?: string },
): Promise<{ gateway: string; model: string }> {
  const { ui } = ctx;
  const model = o.model ?? c.config.llm.primary ?? DEFAULT_MODEL;
  const r = await chooseGateway(
    {
      accountId: c.accountId,
      // a gateway from the old flow (oc-host) stays; `default` is the zero-token default
      gateway: o.gateway ?? (c.config.llm.gateway !== DEFAULT_GATEWAY ? c.config.llm.gateway : undefined),
      model,
      tokenFile: o.aiTokenFile,
      oauthToken: c.bearer,
    },
    {
      fetch: ctx.fetch,
      env: {},
      readFile: async (f) => ({ text: await readTokenFile(f, () => {}), mode: (await stat(f)).mode }),
      log: (l) => (l.startsWith("WARN: ") ? ui.warn(l.slice(6)) : ui.step(`ai: ${l}`, "ai")),
      registerSecret,
      now: ctx.now,
      sleep: ctx.sleep,
    },
  );
  ui.step(
    r.gateway === NO_GATEWAY
      ? `ai: no gateway; ${model} runs on the Worker's AI binding (no logs)`
      : `ai: ${model} on the Worker's AI binding, gateway ${r.gateway} (${r.gatewayAction}); no token`,
    "ai",
  );
  return { gateway: r.gateway, model };
}

// ---------------------------------------------------------------- step 12: first start

const RUNNING = new Set(["running"]);
const SETTLED = new Set(["running", "asleep", "sleeping", "quiescing"]);

/** Start a new install and wait for `running` with a progress line; budget 10 min → exit 4. */
export async function firstStart(ctx: Ctx, ops: ReturnType<typeof makeOps>): Promise<string> {
  const { ui } = ctx;
  const t0 = ctx.now();
  const st = await ops.get("/ops/status");
  const state0 = String(st.body.state ?? "");
  if (st.status === 200 && st.body.epoch && SETTLED.has(state0)) {
    ui.step(`start: install is ${state0}; no start needed`, "start");
    return `already ${state0}`;
  }
  const r = await ops.post("/ops/start");
  ui.step(`start: POST /ops/start → HTTP ${r.status}${r.body.ensured ? " (first install)" : ""}`, "start");
  let restarted = false;
  let last = state0;
  for (;;) {
    const s = await ops.get("/ops/status");
    const state = String(s.body.state ?? (s.status === 409 ? "no-active-epoch" : `HTTP ${s.status}`));
    if (s.status === 200 && RUNNING.has(state)) break;
    const elapsed = ctx.now() - t0;
    if (elapsed >= PROVISION_BUDGET_MS) {
      ui.progressDone();
      throw new CliError(
        "the install did not start in 10 min",
        "ochost status; rerun ochost init (safe)",
        EXIT.budget,
      );
    }
    // ensure() made the epoch but the Runtime has not begun: start it once more
    if (
      !restarted &&
      elapsed > 20_000 &&
      s.status === 200 &&
      s.body.epoch &&
      /^(stopped|idle|none|)$/.test(state)
    ) {
      restarted = true;
      await ops.post("/ops/start");
    }
    if (state !== last) last = state;
    const left = Math.max(1, Math.ceil((PROVISION_BUDGET_MS - elapsed) / 60_000));
    ui.progress(
      `start: ${state}, ${fmtSecs(elapsed)}; provisioning (a first start takes 1-2 min; budget ${left} min left)`,
    );
    await ctx.sleep(5_000);
  }
  ui.progressDone();
  ui.step(`start: running after ${fmtSecs(ctx.now() - t0)}`, "start");
  return `running after ${fmtSecs(ctx.now() - t0)}`;
}

// ---------------------------------------------------------------- step 13: self-test

export async function selfTest(
  ctx: Ctx,
  url: string,
  ops: ReturnType<typeof makeOps>,
  first: boolean,
): Promise<string> {
  const { ui } = ctx;
  const done: string[] = [];
  const anon = makeOps(ctx, url, undefined);
  const a = await anon.get("/");
  if (a.status === 404) {
    ui.step("self-test: anonymous GET / → 404 (no wake)", "selftest");
    done.push("anonymous 404");
  } else ui.warn(`self-test: anonymous GET / returned ${a.status}, expected 404 — fix: ochost doctor`);
  // owner login link → session cookie → the Control UI page through the proxy
  const code = await ops.post("/ops/auth/code");
  const link = typeof code.body.url === "string" ? code.body.url : undefined;
  if (link) {
    registerSecret(String(code.body.code ?? ""));
    try {
      const r1 = await ctx.fetch(link, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const r2 = cookie
        ? await ctx.fetch(`${url}/`, { headers: { cookie }, signal: AbortSignal.timeout(60_000) })
        : undefined;
      const body = r2 ? await r2.text() : "";
      if (r2?.status === 200 && /OpenClaw/i.test(body)) {
        ui.step("self-test: owner link → session → Control UI 200", "selftest");
        done.push("UI opens");
      } else
        ui.warn(
          `self-test: owner link gave ${r1.status}, UI ${r2?.status ?? "no cookie"} — fix: ochost open, then ochost doctor`,
        );
      // end this test session so it does not hold the install awake
      if (cookie)
        await ctx
          .fetch(`${url}/_ochost/logout`, { method: "POST", headers: { cookie }, redirect: "manual" })
          .catch(() => {});
    } catch (e) {
      ui.warn(`self-test: owner link check failed (${(e as Error).message}) — fix: ochost open`);
    }
  } else ui.warn(`self-test: POST /ops/auth/code returned ${code.status} — fix: ochost doctor`);
  if (first) {
    const r = await ops.post("/ops/archive", { reason: "owner" });
    if (r.status === 202 || r.status === 200) {
      ui.step("self-test: first archive requested", "selftest");
      done.push("first backup asked");
    } else ui.warn(`self-test: archive request returned ${r.status} — fix: ochost backup create`);
  }
  return done.join(", ");
}

// ---------------------------------------------------------------- command

export function initOptions(ctx: Ctx, existingName?: string): InitOptions {
  const f = (n: string) => flagString(ctx.args, n);
  const instance = f("instance");
  if (instance) parseInstance(instance);
  const model = f("model");
  if (model && !MODEL_RE.test(model))
    throw new CliError(
      `--model ${model} is not @cf/<org>/<name> or <provider>/<model>`,
      "pass --model @cf/<org>/<name>",
      EXIT.usage,
    );
  const name = f("name") ?? existingName ?? "oc-host";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
    throw new CliError(`--name ${name} is not valid (a-z, 0-9, -)`, "pass --name <a-z0-9->", EXIT.usage);
  return {
    nonInteractive: flagBool(ctx.args, "non-interactive") || !ctx.interactive,
    accountId: f("account-id") ?? ctx.env.CLOUDFLARE_ACCOUNT_ID,
    name,
    subdomain: f("subdomain"),
    adopt: flagBool(ctx.args, "adopt"),
    aiTokenFile: f("ai-token-file"),
    gateway: f("gateway"),
    model,
    instance,
    bucket: f("bucket"),
    noOpen: flagBool(ctx.args, "no-open"),
    skipAi: flagBool(ctx.args, "skip-ai"),
    acceptLoss: flagBool(ctx.args, "accept-loss"),
    fakeTelegram:
      typeof ctx.args.flags["fake-telegram"] === "boolean" ? ctx.args.flags["fake-telegram"] : undefined,
    telegramOwner: telegramOwnerOf(f("telegram-owner")),
    sandbox: sandboxOf(f("sandbox")),
  };
}

/** --sandbox on|all|off (docs/12; `on` = every session but the owner's main chat). */
export function sandboxOf(v: string | undefined): "on" | "all" | "off" | undefined {
  if (v === undefined) return undefined;
  if (v === "on" || v === "all" || v === "off") return v;
  throw new CliError(`--sandbox ${v} is not on, all or off`, "pass --sandbox on", EXIT.usage);
}

/** S1.11: --telegram-owner <numeric Telegram user id>. */
export function telegramOwnerOf(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const id = v.trim().replace(/^(telegram|tg):/i, "");
  if (!/^\d{1,20}$/.test(id))
    throw new CliError(
      `--telegram-owner ${v} is not a Telegram user id`,
      "pass the numeric id (message @userinfobot)",
      EXIT.usage,
    );
  return id;
}

export async function initCommand(ctx: Ctx): Promise<number> {
  const p = projectPaths(ctx.dir);
  await mkdir(ctx.dir, { recursive: true });
  const swept = await sweepTemp();
  if (swept) ctx.ui.step(`removed ${swept} stale temp dir(s)`);
  let existingName: string | undefined;
  if (existsSync(p.config)) {
    try {
      existingName = (parseJsonc(await readFile(p.config, "utf8")) as { name?: string }).name;
    } catch {}
  }
  const o = initOptions(ctx, existingName);
  const post0 = postOptionsOf(ctx);
  ctx.ui.step(`ochost init in ${ctx.dir} (Worker ${o.name})`, "init");
  const t0 = ctx.now();
  const g = await gatherProbes(ctx, o);
  g.preflightMs = ctx.now() - t0;
  const steps = plan(o, g.probes);
  const r = await runInit(ctx, o, steps, g);
  ctx.ui.result(r);
  // docs/20 §1: the setup the owner would run next, from flags, or one question each on a fresh install only
  // (U5: a rerun never prompts).
  const fresh = !g.probes.local.state;
  const post = fresh ? await askPost(ctx, post0, r.fakeTelegram) : post0;
  const { o: withFile, cleanup } = await materializeToken(post, {
    exists: existsSync,
    writeTemp: async (text) => {
      const dir = await mkdtemp(join(tmpdir(), "ochost-"));
      const file = join(dir, "telegram.env");
      await writeFile(file, text, { mode: 0o600 });
      return file;
    },
    remove: (f) => rmSync(dirname(f), { recursive: true, force: true }),
  });
  try {
    const list = postSteps(withFile, r.fakeTelegram);
    if (list.length) {
      const { failed } = await runPost(ctx, list);
      if (withFile.accessDomain && !failed.includes("access"))
        ctx.ui.out(`Console: https://${withFile.accessDomain} (behind Cloudflare Access)`);
      if (failed.length) ctx.ui.out(`Not finished: ${failed.join(", ")}. Run the command printed above.`);
    }
  } finally {
    cleanup();
  }
  return 0;
}
