// `ochost model list` and `ochost model set` (docs/10-cli-spec.md §1.2, §3.4, D13).
// list: Workers AI text-generation models from the API, filtered to function calling. Needs Workers AI Read.
// set: new OpenClaw config version with agents.defaults.model.primary and the cfgw provider entry.

import { type AigDeps, cfApi, DEFAULT_MODEL, errCode } from "./ai-gateway.ts";
import { type Catalog, type CatalogModel, SHIPPED_CATALOG } from "./catalog.ts";
import { canDisableThinking, isProviderModel, modelEntry, renderModelRoles } from "./config.ts";
import { CliError } from "./ui.ts";

/** D13 shortlist (09-llm-setup.md): the 6 candidates the bench measures. */
export const SHORTLIST = [
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/openai/gpt-oss-120b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/zai-org/glm-5.3",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-4.7-flash",
] as const;

/** Model roles `ochost model set --role` writes (docs/research/models-2026-11.md §3). Default: main. */
export const ROLES = ["main", "utility", "compaction"] as const;
export type ModelRole = (typeof ROLES)[number];

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
  /** planned_deprecation_date from the catalogue; null when none. */
  deprecated: string | null;
  createdAt: string;
  shortlist: boolean;
  primary: boolean;
}

export interface RawModel {
  name: string;
  created_at?: string;
  planned_deprecation_date?: string | null;
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
    deprecated: String(m.planned_deprecation_date ?? prop(m, "planned_deprecation_date") ?? "") || null,
    createdAt: m.created_at ?? "",
    shortlist: (SHORTLIST as readonly string[]).includes(m.name),
    primary: m.name === primary,
  };
}

/**
 * GET /ai/models/search?task=Text Generation, all pages. The API pages like every v4 list: `result_info` is
 * {count, page, per_page, total_count} (no total_pages), and the server may cap per_page below the asked 100. So the
 * loop goes on until the list holds total_count models, a page is empty, or a page adds no new name.
 */
async function fetchRaw(
  p: { acct: string; token: string },
  d: Pick<AigDeps, "fetch" | "sleep">,
): Promise<RawModel[]> {
  const out = new Map<string, RawModel>();
  for (let page = 1; page <= 20; page++) {
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
    const before = out.size;
    for (const m of r.json.result ?? []) out.set(m.name, m);
    const ti = r.json.result_info;
    if (out.size === before) break; // empty page, or a server that ignores `page`
    if (ti?.total_count !== undefined && out.size >= ti.total_count) break;
    if (ti?.total_pages !== undefined && page >= ti.total_pages) break;
  }
  return [...out.values()];
}

/** `all` keeps models without function calling. */
export async function listModels(
  p: { acct: string; token: string; primary?: string; all?: boolean },
  d: Pick<AigDeps, "fetch" | "sleep">,
): Promise<ModelInfo[]> {
  const out = await fetchRaw(p, d);
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

/** USD per M tokens from the catalogue `price` property ([{unit: "per M input tokens", price}]). */
const priceOf = (m: RawModel, unit: "input" | "output"): number | null => {
  const v = prop(m, "price");
  const hit = Array.isArray(v)
    ? v.find((x) => typeof x?.unit === "string" && x.unit.includes(`M ${unit}`))
    : undefined;
  const n = Number(hit?.price);
  return Number.isFinite(n) && hit ? n : null;
};

/**
 * Pure: the catalogue snapshot from the raw API list: function calling, no planned deprecation. The API list has no
 * effort enum and no image flag; those two come from the shipped snapshot for a known id (a new id: none, text only).
 */
export function toCatalog(raw: RawModel[], date: string): Catalog {
  const known = new Map(SHIPPED_CATALOG.models.map((m) => [m.id, m]));
  const models: CatalogModel[] = raw
    .map((m) => ({ m, i: toInfo(m, "") }))
    .filter(({ i }) => i.tools && !i.deprecated)
    .map(({ m, i }): CatalogModel => {
      const k = known.get(m.name);
      return {
        id: m.name,
        contextWindow: i.contextWindow ?? k?.contextWindow ?? 131_072,
        supportsReasoning: i.reasoning || !!k?.supportsReasoning,
        efforts: k?.efforts ?? [],
        vision: k?.vision ?? String(prop(m, "vision")) === "true",
        priceInPerM: priceOf(m, "input") ?? k?.priceInPerM ?? null,
        priceOutPerM: priceOf(m, "output") ?? k?.priceOutPerM ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { date, source: "Workers AI API /ai/models/search (ochost model list --refresh)", models };
}

/** `ochost model list --refresh`: the live catalogue as a snapshot. */
export async function fetchCatalog(
  p: { acct: string; token: string; date: string },
  d: Pick<AigDeps, "fetch" | "sleep">,
): Promise<Catalog> {
  return toCatalog(await fetchRaw(p, d), p.date);
}

/** Table for the terminal. `*` = primary, `s` = D13 shortlist. */
export function formatModels(ms: ModelInfo[]): string {
  const rows = ms.map((m) => [
    `${m.primary ? "*" : " "}${m.shortlist ? "s" : " "}`,
    m.name,
    m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : "-",
    m.tools ? "tools" : "-",
    m.reasoning ? "reasoning" : "-",
    [m.beta ? "beta" : "", m.deprecated ? `deprecated ${m.deprecated.slice(0, 10)}` : ""]
      .filter(Boolean)
      .join(" "),
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

/** Pure: model and thinking level of each role in a doc. A role that is not set shows an empty model. */
export function modelRoles(doc: Record<string, any>): { role: ModelRole; model: string; thinking: string }[] {
  const dd = doc.agents?.defaults ?? {};
  const refs: Record<ModelRole, unknown> = {
    main: dd.model?.primary,
    utility: dd.utilityModel,
    compaction: dd.compaction?.model,
  };
  return ROLES.map((role) => {
    const ref = typeof refs[role] === "string" ? (refs[role] as string) : "";
    const thinking =
      role === "compaction"
        ? (dd.compaction?.thinkingLevel ?? "")
        : String(dd.models?.[ref]?.params?.thinking ?? (role === "main" ? (dd.thinkingDefault ?? "") : ""));
    return {
      role,
      model: ref.startsWith(`${PROVIDER_ID}/`) ? ref.slice(PROVIDER_ID.length + 1) : ref,
      thinking,
    };
  });
}

/** Thinking effort the gate gets for a role: `low` for the main turn, `none` for the rest where the model allows. */
export const roleEffort = (role: ModelRole, id: string) =>
  role === "main" || !canDisableThinking(id) ? "low" : "none";

/** Pure: the doc with `id` as the utility or compaction model. The cfgw entry and thinking level follow. */
export function withRole(
  doc: Record<string, any>,
  role: Exclude<ModelRole, "main">,
  id: string,
  info?: Pick<ModelInfo, "contextWindow">,
): Record<string, any> {
  const next = structuredClone(doc);
  next.agents ??= {};
  next.agents.defaults ??= {};
  const dd = next.agents.defaults;
  const ref = `${PROVIDER_ID}/${id}`;
  if (role === "utility") dd.utilityModel = ref;
  else {
    dd.compaction = { ...(dd.compaction ?? {}), model: ref };
    delete dd.compaction.thinkingLevel; // the render picks the level for the new model
  }
  const prov = next.models?.providers?.[PROVIDER_ID];
  if (prov) {
    prov.models ??= [];
    if (!prov.models.some((e: { id?: string }) => e.id === id))
      prov.models.push(modelEntry(id, info?.contextWindow));
  }
  return renderModelRoles(next);
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
  return renderModelRoles(next);
}

export interface SetModelOpts {
  id: string;
  fallbacks?: string[];
  /** Which role gets the model. Default main. Fallbacks apply to main only. */
  role?: ModelRole;
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
      if (hit.deprecated)
        throw new CliError(
          `model ${m} is deprecated (planned ${hit.deprecated.slice(0, 10)})`,
          "pick another model: ochost model list",
        );
      if (!hit.tools)
        d.log(`WARN: ${m} has no function calling — fix: pick a model marked tools in ochost model list`);
      if (m === o.id) info = hit;
    }
  } else if (all.some((x) => !isProviderModel(x)))
    d.log(
      "WARN: deprecation date not checked (no AI token) — fix: rerun with --ai-token-file <f> (Workers AI Read) or check ochost model list",
    );
  const cur = await currentConfig(ops);
  if (o.role && o.role !== "main") {
    const r = await proposeConfig(ops, withRole(cur.doc, o.role, o.id, info), cur.ver);
    return { ...r, primary: o.id };
  }
  const doc = withPrimary(cur.doc, o.id, o.fallbacks ?? [], info);
  const r = await proposeConfig(ops, doc, cur.ver);
  return { ...r, primary: o.id };
}
