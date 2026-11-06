// `ochost model list` and `ochost model set` (docs/10-cli-spec.md §1.2, §3.4, D13).
// list: Workers AI text-generation models from the API, filtered to function calling. Needs Workers AI Read.
// set: new OpenClaw config version with agents.defaults.model.primary and the cfgw provider entry.
import { type AigDeps, cfApi, DEFAULT_MODEL, errCode } from "./ai-gateway.ts";
import { isProviderModel, modelEntry } from "./config.ts";
import { CliError } from "./ui.ts";

/** D13 shortlist (09-llm-setup.md): the 6 candidates the bench measures. */
export const SHORTLIST = [
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/openai/gpt-oss-120b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/nvidia/nemotron-3-120b-a12b",
] as const;

/** Provider id in the OpenClaw config doc (spec §2.8). */
export const PROVIDER_ID = "cfgw";

/** Workers AI ids and `anthropic/<model>`. Other providers are not routed (no neurons to count, no BYOK path). */
export const MODEL_ID_RE = /^(@cf\/[a-z0-9._-]+\/[a-z0-9._-]+|anthropic\/[A-Za-z0-9._-]+)$/;

export interface ModelInfo {
  name: string;
  contextWindow: number | null;
  tools: boolean;
  reasoning: boolean;
  beta: boolean;
  createdAt: string;
  shortlist: boolean;
  primary: boolean;
}

interface RawModel {
  name: string;
  created_at?: string;
  properties?: { property_id: string; value: unknown }[];
}

const prop = (m: RawModel, k: string) => m.properties?.find((p) => p.property_id === k)?.value;

export function toInfo(m: RawModel, primary: string): ModelInfo {
  const cw = Number(prop(m, "context_window"));
  return {
    name: m.name,
    contextWindow: Number.isFinite(cw) && cw > 0 ? cw : null,
    tools: String(prop(m, "function_calling")) === "true",
    reasoning: String(prop(m, "reasoning")) === "true",
    beta: String(prop(m, "beta")) === "true",
    createdAt: m.created_at ?? "",
    shortlist: (SHORTLIST as readonly string[]).includes(m.name),
    primary: m.name === primary,
  };
}

/** GET /ai/models/search?task=Text Generation, all pages. `all` keeps models without function calling. */
export async function listModels(
  p: { acct: string; token: string; primary?: string; all?: boolean },
  d: Pick<AigDeps, "fetch" | "sleep">,
): Promise<ModelInfo[]> {
  const out: RawModel[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await cfApi<RawModel[]>(
      d,
      p.token,
      "GET",
      `/accounts/${p.acct}/ai/models/search?task=Text%20Generation&per_page=100&page=${page}`,
    );
    if (!r.json.success)
      throw new CliError(
        `cannot list Workers AI models (${errCode(r.json) ?? r.status})`,
        "the AI token needs Workers AI Read (the Workers AI template has it); ochost ai-gateway setup prints the steps",
      );
    out.push(...(r.json.result ?? []));
    const ti = r.json.result_info;
    if (!ti?.total_pages || page >= ti.total_pages || (r.json.result ?? []).length < 100) break;
  }
  const primary = p.primary ?? DEFAULT_MODEL;
  return out
    .map((m) => toInfo(m, primary))
    .filter((m) => p.all || m.tools)
    .sort(
      (a, b) =>
        Number(b.primary) - Number(a.primary) ||
        Number(b.shortlist) - Number(a.shortlist) ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

/** Table for the terminal. `*` = primary, `s` = D13 shortlist. */
export function formatModels(ms: ModelInfo[]): string {
  const rows = ms.map((m) => [
    `${m.primary ? "*" : " "}${m.shortlist ? "s" : " "}`,
    m.name,
    m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : "-",
    m.tools ? "tools" : "-",
    m.reasoning ? "reasoning" : "-",
    m.beta ? "beta" : "",
  ]);
  const w = rows.reduce<number[]>((acc, r) => r.map((c, i) => Math.max(acc[i] ?? 0, c.length)), []);
  const lines = rows.map((r) =>
    r
      .map((c, i) => c.padEnd(w[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  lines.push("* = primary, s = shortlist (D13). Bench them: ochost model bench");
  return lines.join("\n");
}

// ---------------------------------------------------------------- model set

/** Minimal /ops client (cfo api.ts shape). */
export interface OpsClient {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/** Read the newest config version: {ver, doc}. No version → {ver: 0, doc: {}}. */
export async function currentConfig(ops: OpsClient): Promise<{ ver: number; doc: Record<string, any> }> {
  const l = await ops.get("/ops/config");
  if (l.status !== 200)
    throw new CliError(`cannot read the config (/ops/config ${l.status})`, "run ochost status, then rerun");
  const vers = ((l.body as { versions?: { ver: number }[] }).versions ?? []).map((v) => v.ver);
  if (!vers.length) return { ver: 0, doc: {} };
  const ver = Math.max(...vers);
  const g = await ops.get(`/ops/config/${ver}`);
  if (g.status !== 200)
    throw new CliError(`cannot read config version ${ver} (${g.status})`, "run ochost status, then rerun");
  const doc = (g.body as { doc?: Record<string, any> }).doc ?? {};
  return { ver, doc };
}

/** Post a new config version on top of `baseVer`. 409/base mismatch → spec §5 line. */
export async function proposeConfig(
  ops: OpsClient,
  doc: Record<string, any>,
  baseVer: number,
): Promise<{ ver: number; same: boolean }> {
  const r = await ops.post("/ops/config", { doc, ...(baseVer > 0 ? { baseVer } : {}) });
  const b = (r.body ?? {}) as { ok?: boolean; ver?: number; same?: boolean; error?: string; path?: string };
  if (r.status === 409)
    throw new CliError(
      `config changed elsewhere (base ${baseVer}, current ${b.ver ?? "?"})`,
      "run ochost config pull, then set again",
    );
  if (r.status === 403 && b.error === "webhook-transport")
    throw new CliError(
      `the Worker refused the webhook URL at ${b.path}`,
      "update the Worker (ochost deploy), then rerun",
    );
  if (r.status !== 200 || b.ok === false)
    throw new CliError(
      `the Worker refused the config (${r.status} ${b.error ?? ""})`.trim(),
      "run ochost logs --source ctl",
    );
  return { ver: b.ver ?? baseVer + 1, same: !!b.same };
}

/**
 * Pure: the config doc with `id` as primary (and fallbacks). Adds the model to the cfgw provider list when it is
 * missing; keeps every other key. The provider block itself is rendered by init (spec §2.8).
 */
export function withPrimary(
  doc: Record<string, any>,
  id: string,
  fallbacks: string[] = [],
  info?: Pick<ModelInfo, "contextWindow">,
): Record<string, any> {
  const next = structuredClone(doc);
  const ref = (m: string) => `${PROVIDER_ID}/${m}`;
  next.agents ??= {};
  next.agents.defaults ??= {};
  const model: Record<string, unknown> = { ...(next.agents.defaults.model ?? {}), primary: ref(id) };
  if (fallbacks.length) model.fallbacks = fallbacks.map(ref);
  else delete model.fallbacks;
  next.agents.defaults.model = model;
  const prov = next.models?.providers?.[PROVIDER_ID];
  if (prov) {
    prov.models ??= [];
    for (const m of [id, ...fallbacks]) {
      if (prov.models.some((e: { id?: string }) => e.id === m)) continue;
      prov.models.push(modelEntry(m, m === id ? info?.contextWindow : null));
    }
  }
  return next;
}

export interface SetModelOpts {
  id: string;
  fallbacks?: string[];
  /** AI token; when given, the id is checked against the Workers AI list. */
  token?: string;
  acct?: string;
}

/** One chat call through the gate (POST /ops/gate/ai/v1/chat/completions). Never throws on HTTP status. */
export type GateHopFn = (model: string) => Promise<{ status: number; error?: string }>;

/**
 * `ochost model set <id>`: validate, run one call through the gate (a Workers AI model that does not exist, or
 * anthropic/<model> without a key in the gateway BYOK store, fails here, before the config changes), post a
 * config version. Without a hop function (no Worker answer) the id is checked against the model list when a
 * token is at hand.
 */
export async function setModel(
  o: SetModelOpts & { hop?: GateHopFn },
  ops: OpsClient,
  d: Pick<AigDeps, "fetch" | "sleep" | "log">,
): Promise<{ ver: number; same: boolean; primary: string }> {
  const all = [o.id, ...(o.fallbacks ?? [])];
  for (const m of all)
    if (!MODEL_ID_RE.test(m))
      throw new CliError(
        `bad model id ${m}`,
        "use @cf/<org>/<name> (ochost model list) or anthropic/<model> (key in the gateway BYOK store, docs/09)",
      );
  let info: ModelInfo | undefined;
  if (o.hop) {
    for (const m of all) {
      const r = await o.hop(m);
      if (r.status === 200) continue;
      if (r.status === 0 || r.status === 429) {
        d.log(
          `WARN: ${m} not checked (${r.status || "no answer"}) — fix: ochost doctor, then rerun if it fails`,
        );
        continue;
      }
      throw new CliError(
        `${m} did not answer through the gate (${r.status}${r.error ? ` ${r.error.slice(0, 160)}` : ""})`,
        isProviderModel(m)
          ? "store an Anthropic key in the gateway (dashboard > AI Gateway > your gateway > Provider Keys, alias default), then rerun; docs/09-llm-setup.md"
          : "ochost model list shows the ids; pick one marked tools",
      );
    }
  }
  if (o.token && o.acct) {
    const list = await listModels({ acct: o.acct, token: o.token, all: true }, d);
    for (const m of all.filter((x) => !isProviderModel(x))) {
      const hit = list.find((x) => x.name === m);
      if (!hit)
        throw new CliError(
          `model ${m} not found on Workers AI`,
          "run ochost model list, then ochost model set <id>",
        );
      if (!hit.tools)
        d.log(`WARN: ${m} has no function calling — fix: pick a model marked tools in ochost model list`);
      if (m === o.id) info = hit;
    }
  }
  const cur = await currentConfig(ops);
  const doc = withPrimary(cur.doc, o.id, o.fallbacks ?? [], info);
  const r = await proposeConfig(ops, doc, cur.ver);
  return { ...r, primary: o.id };
}
