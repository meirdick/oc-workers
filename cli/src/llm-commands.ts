// ochost model list|set|bench and ochost ai-gateway setup (docs/10-cli-spec.md §1.2, §3, D13).
// Thin wrappers over model.ts, bench.ts and ai-gateway.ts. Zero-token: set and bench run through the install's
// gate (the Worker's AI binding). `model list` uses the wrangler login. --ai-token-file or OC_CF_AI_TOKEN is the
// opt-in for direct calls (bench --direct, list, gateway create); the CLI keeps it nowhere.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chooseGateway, DEFAULT_GATEWAY, DEFAULT_MODEL, gateEndpoint, gateSmoke, hop } from "./ai-gateway.ts";
import { benchTable, runBench } from "./bench.ts";
import {
  aigDeps,
  applyChange,
  laptopAiToken,
  looseOps,
  patchLlm,
  registerBoth,
  setBaseVersion,
  sub,
  wantRestart,
} from "./cmd-util.ts";
import { renderOpenclawDoc } from "./config.ts";
import { currentConfig, formatModels, listModels, PROVIDER_ID, proposeConfig, setModel } from "./model.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  flagInt,
  flagStr,
  loadInstall,
  type OpsCtx,
  opsClient,
  readHostConfig,
  usage,
} from "./ops-lib.ts";
import { makeWrangler, wranglerBearer } from "./wrangler.ts";

// ---------------------------------------------------------------- model

export const modelFlags: FlagSpec = {
  all: { type: "boolean" },
  "ai-token-file": { type: "string" },
  fallback: { type: "string", multi: true },
  restart: { type: "boolean" },
  models: { type: "string" },
  turns: { type: "string" },
  gateway: { type: "string" },
  concurrency: { type: "string" },
  out: { type: "string" },
  /** bench: call the gateway directly with the opt-in token instead of the gate */
  direct: { type: "boolean" },
  /** bench: the gate of another Worker, e.g. a local `wrangler dev` (token: env OCHOST_CONTROL_TOKEN) */
  "gate-url": { type: "string" },
};

export async function model(ctx: OpsCtx): Promise<number> {
  const s = sub(ctx, ["list", "set", "bench"], "list");
  if (s === "list") return modelList(ctx);
  if (s === "set") return modelSet(ctx);
  return modelBench(ctx);
}

async function modelList(ctx: OpsCtx): Promise<number> {
  const install = loadInstall(ctx);
  // the opt-in token, else the wrangler login (it reads Workers AI; docs/09)
  const token = (await laptopAiToken(ctx, false)) ?? (await loginBearer(ctx, install.accountId));
  const primary = readHostConfig(ctx.dir)?.llm?.primary ?? DEFAULT_MODEL;
  const ms = await listModels(
    { acct: install.accountId, token, primary, all: flagBool(ctx.args, "all") },
    aigDeps(ctx),
  );
  if (ctx.out.json) ctx.out.result({ ok: true, primary, models: ms });
  else ctx.out.line(formatModels(ms));
  return EXIT.ok;
}

/** The wrangler OAuth bearer, for read-only Workers AI calls. */
async function loginBearer(ctx: OpsCtx, accountId: string): Promise<string> {
  const t = await wranglerBearer(makeWrangler(ctx.run, { accountId }));
  if (t) return t;
  throw new CliError(
    "no wrangler login on this machine",
    "run npx wrangler login, or pass --ai-token-file <f> (Workers AI Read)",
    EXIT.manual,
  );
}

async function modelSet(ctx: OpsCtx): Promise<number> {
  const id = ctx.args.positionals[1];
  if (!id)
    throw usage("model set needs a model id", "ochost model set @cf/<org>/<name> or anthropic/<model>");
  const ops = opsClient(ctx);
  const token = await laptopAiToken(ctx, false);
  const fallbacks = (ctx.args.flags.fallback as string[] | undefined) ?? [];
  const d = aigDeps(ctx);
  const ep = gateEndpoint(ops.install.url, ops.install.token);
  const hopFn = async (model: string) => {
    const r = await hop(d, {
      endpoint: ep,
      model,
      messages: [{ role: "user", content: "Reply pong." }],
      maxTokens: 64,
    });
    return { status: r.status, error: r.error };
  };
  const r = await setModel({ id, fallbacks, token, acct: ops.install.accountId, hop: hopFn }, looseOps(ops), {
    fetch: d.fetch,
    sleep: d.sleep,
    log: d.log,
  });
  await setBaseVersion(ctx, r.ver);
  await patchLlm(ctx, { primary: id, fallbacks });
  const applied = r.same ? "none" : await applyChange(ctx, ops, wantRestart(ctx));
  if (ctx.out.json) ctx.out.result({ ok: true, primary: id, fallbacks, ver: r.ver, same: r.same, applied });
  else ctx.out.line(`model ${id}: config version ${r.ver}${r.same ? " (no change)" : ""}`);
  return EXIT.ok;
}

async function modelBench(ctx: OpsCtx): Promise<number> {
  const gateway = flagStr(ctx.args, "gateway") ?? readHostConfig(ctx.dir)?.llm?.gateway ?? DEFAULT_GATEWAY;
  let target: Parameters<typeof runBench>[0];
  if (flagBool(ctx.args, "direct")) {
    const install = loadInstall(ctx);
    const token = (await laptopAiToken(ctx, true)) as string;
    target = { acct: install.accountId, gateway, token };
  } else {
    // through the gate: the install's Worker, or --gate-url (a local wrangler dev) with OCHOST_CONTROL_TOKEN
    const url = flagStr(ctx.args, "gate-url");
    const envTok = ctx.env.OCHOST_CONTROL_TOKEN?.trim();
    if (envTok) registerBoth(envTok);
    const w = url && envTok ? { url, token: envTok } : loadInstall(ctx);
    target = { endpoint: gateEndpoint(url ?? w.url, w.token), gateway };
  }
  const models = flagStr(ctx.args, "models")
    ?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const d = aigDeps(ctx);
  const rep = await runBench(
    {
      ...target,
      models,
      turns: flagInt(ctx.args, "turns", 20, 1, 200),
      concurrency: flagInt(ctx.args, "concurrency", 1, 1, 10),
    },
    { fetch: d.fetch, now: d.now, log: d.log },
  );
  const date = new Date(ctx.now()).toISOString().slice(0, 10);
  const out = flagStr(ctx.args, "out") ?? join(ctx.dir, "bench", "results", `model-${date}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(rep, null, 2)}\n`);
  if (ctx.out.json) ctx.out.result({ ok: true, file: out, summaries: rep.summaries });
  else ctx.out.line(`${benchTable(rep)}\nresults: ${out}`);
  return EXIT.ok;
}

// ---------------------------------------------------------------- ai-gateway

export const aiGatewayFlags: FlagSpec = {
  "ai-token-file": { type: "string" },
  gateway: { type: "string" },
  model: { type: "string" },
  "spend-limit-usd": { type: "string" },
  restart: { type: "boolean" },
};

/**
 * `ai-gateway setup`: which gateway the Worker's AI binding uses, and a model hop through the gate. No token
 * needed. --ai-token-file (or OC_CF_AI_TOKEN) is the opt-in that lets it list or create the gateway through the
 * API; the token is not kept. A changed gateway is a Worker var: `ochost deploy` applies it.
 */
export async function aiGateway(ctx: OpsCtx): Promise<number> {
  sub(ctx, ["setup"], "setup");
  const ops = opsClient(ctx);
  const install = ops.install;
  const host = readHostConfig(ctx.dir);
  const lo = looseOps(ops);
  const cur = await currentConfig(lo);
  // The live config doc wins over the local mirror in oc-host.jsonc (config set may have changed it).
  const docPrimary = String(cur.doc.agents?.defaults?.model?.primary ?? "");
  const livePrimary = docPrimary.startsWith(`${PROVIDER_ID}/`)
    ? docPrimary.slice(PROVIDER_ID.length + 1)
    : undefined;
  const spendRaw = flagStr(ctx.args, "spend-limit-usd");
  const spend = spendRaw === undefined ? (host?.llm?.spendLimitUsd ?? null) : Number(spendRaw);
  if (spend !== null && !(Number.isFinite(spend) && spend > 0))
    throw usage("--spend-limit-usd must be a number above 0", "use --spend-limit-usd 20");
  const cfgGw = (host?.llm?.gateway as string | undefined) ?? DEFAULT_GATEWAY;
  const r = await chooseGateway(
    {
      accountId: install.accountId,
      gateway: flagStr(ctx.args, "gateway") ?? (cfgGw !== DEFAULT_GATEWAY ? cfgGw : undefined),
      model: flagStr(ctx.args, "model") ?? livePrimary ?? host?.llm?.primary ?? DEFAULT_MODEL,
      tokenFile: flagStr(ctx.args, "ai-token-file"),
      useEnv: true,
    },
    aigDeps(ctx),
  );
  const gatewayChanged = r.gateway !== cfgGw;
  await patchLlm(ctx, {
    gateway: r.gateway,
    primary: r.model,
    ...(spendRaw !== undefined && spend !== null ? { spendLimitUsd: spend } : {}),
  });
  if (gatewayChanged)
    ctx.out.warn(`gateway is now ${r.gateway}; the Worker still uses ${cfgGw} — fix: ochost deploy`);
  // The gateway API takes spend_limits only with a token that can edit the gateway; the install holds none
  // (zero-token install), so this is a dashboard step.
  if (spend !== null)
    ctx.out.warn(
      `spend limit $${spend} is not set by the CLI. Set it in the dashboard: AI > AI Gateway > ${r.gateway} > Settings > Spend limits > add a rule: cost ${spend} USD, 30-day window`,
    );
  const hopRes = await gateSmoke(
    { endpoint: gateEndpoint(install.url, install.token), model: r.model, gateway: cfgGw },
    { ...aigDeps(ctx), log: (l) => ctx.out.warn(l.replace(/^WARN: /, "")) },
  );
  if (hopRes.ok)
    ctx.out.step(
      `model hop: ${r.model} answered through the gate in ${hopRes.ms} ms (${hopRes.neurons.toFixed(2)} neurons)`,
    );
  // Config: render the cfgw provider for this model, keep every other key.
  const want = renderOpenclawDoc({ model: r.model }) as any;
  const doc = structuredClone(cur.doc);
  doc.models ??= {};
  doc.models.providers ??= {};
  const oldProv = doc.models.providers[PROVIDER_ID];
  const newProv = want.models.providers[PROVIDER_ID];
  if (oldProv?.models?.length) {
    const ids = new Set(oldProv.models.map((m: { id?: string }) => m.id));
    newProv.models = [...oldProv.models, ...newProv.models.filter((m: { id: string }) => !ids.has(m.id))];
  }
  // replaces baseUrl, apiKey and headers: a token-era provider block loses its cf-aig-authorization header
  doc.models.providers[PROVIDER_ID] = newProv;
  doc.agents ??= {};
  doc.agents.defaults ??= {};
  doc.agents.defaults.model = { ...(doc.agents.defaults.model ?? {}), primary: `${PROVIDER_ID}/${r.model}` };
  const v = await proposeConfig(lo, doc, cur.ver);
  await setBaseVersion(ctx, v.ver);
  const applied = !v.same ? await applyChange(ctx, ops, wantRestart(ctx)) : "none";
  if (ctx.out.json)
    ctx.out.result({
      ok: hopRes.ok,
      gateway: r.gateway,
      gatewayAction: r.gatewayAction,
      gatewayChanged,
      model: r.model,
      configVer: v.ver,
      configSame: v.same,
      applied,
      hop: { ok: hopRes.ok, ms: hopRes.ms, neurons: hopRes.neurons },
      warnings: r.warnings,
    });
  else
    ctx.out.line(
      `AI Gateway ${r.gateway} (${r.gatewayAction}), model ${r.model}; config version ${v.ver}${v.same ? " (no change)" : ""}`,
    );
  if (!hopRes.ok)
    throw new CliError("the model hop did not pass", "see the WARN line above; ochost doctor repeats it");
  return EXIT.ok;
}
