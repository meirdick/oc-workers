// AI Gateway and model access (docs/09-llm-setup.md "Zero-token install", D13). Model calls run on the Worker's
// Workers AI binding through the CapGate, so init needs no token. A token (--ai-token-file or OC_CF_AI_TOKEN) is an
// opt-in for direct gateway calls from this machine: it lets setup list and create gateways, and `model bench`,
// `model list` and `doctor` call the gateway or the API directly. The CLI never stores it and never sends it to the
// Worker or the container. Every value goes through redact().

export const CF_API = "https://api.cloudflare.com/client/v4";
export const GATEWAY_HOST = "https://gateway.ai.cloudflare.com";
/** Gateway setup creates (with a token) or selects when the user names none. */
export const MANAGED_GATEWAY = "oc-host";
export const DEFAULT_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
/** Workers AI price, USD per 1000 neurons (developers.cloudflare.com/workers-ai/platform/pricing). */
export const USD_PER_1K_NEURONS = 0.011;
export { DEFAULT_GATEWAY, NO_GATEWAY };

import { DEFAULT_GATEWAY, NO_GATEWAY } from "./config.ts";
import { CliError, tokenFromText } from "./ui.ts";

export type Fetch = typeof fetch;

/** I/O the setup needs. Tests pass fakes; index.ts passes the real ones (ui.ts askHidden, errors.ts redact). */
export interface AigDeps {
  fetch: Fetch;
  env: Record<string, string | undefined>;
  /** Hidden prompt (no echo). Absent → non-interactive. */
  askHidden?: (question: string) => Promise<string>;
  /** Read a file; returns its text and mode (for the 0600 check). */
  readFile?: (path: string) => Promise<{ text: string; mode: number }>;
  /** Progress and WARN lines (stderr). */
  log: (line: string) => void;
  /** Instruction lines the user must read (token steps). Absent → log. */
  show?: (line: string) => void;
  /** Register a secret with redact() before any other use. */
  registerSecret: (value: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number; total_count?: number };
}

/** Cloudflare API call with 3 tries on 429/5xx (1 s, 2 s, 4 s; spec §2.2). Returns status and envelope. */
export async function cfApi<T>(
  d: Pick<AigDeps, "fetch" | "sleep">,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: CfEnvelope<T> }> {
  const wait = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last: { status: number; json: CfEnvelope<T> } | null = null;
  for (let i = 0; i < 4; i++) {
    if (i > 0) await wait(1000 * 2 ** (i - 1));
    let res: Response;
    try {
      res = await d.fetch(`${CF_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (i < 3) continue;
      throw new CliError(
        `cannot reach api.cloudflare.com (${(e as Error).message})`,
        "check your network, then rerun",
      );
    }
    let json: CfEnvelope<T>;
    try {
      json = (await res.json()) as CfEnvelope<T>;
    } catch {
      json = { success: false, errors: [{ code: res.status, message: "not JSON" }], result: null as T };
    }
    last = { status: res.status, json };
    if (res.status !== 429 && res.status < 500) return last;
  }
  return last as { status: number; json: CfEnvelope<T> };
}

export function errCode(j: CfEnvelope<unknown>): number | undefined {
  return j.errors?.[0]?.code;
}

// ---------------------------------------------------------------- optional token (direct gateway calls)

/** Run permission for direct gateway calls. */
export const RUN_PERMISSION = "AI Gateway: Run";
/** Optional: lets setup list and create gateways. Without them it probes by request (pickGateway). */
export const OPTIONAL_PERMISSIONS = "AI Gateway: Read and AI Gateway: Edit";

/** guess: 40-60 chars (one measured token = 53). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{40,60}$/;

export type TokenSource = "file" | "env";

/**
 * The opt-in token: `--ai-token-file` (a bare token or one KEY=value line), else env OC_CF_AI_TOKEN when
 * `useEnv`. No token → null; there is no prompt.
 */
export async function resolveAiToken(
  o: { tokenFile?: string; useEnv?: boolean },
  d: AigDeps,
): Promise<{ token: string; source: TokenSource } | null> {
  let token = "";
  let source: TokenSource = "file";
  if (o.tokenFile) {
    if (!d.readFile) throw new CliError("cannot read files here", "pass the token in OC_CF_AI_TOKEN");
    let f: { text: string; mode: number };
    try {
      f = await d.readFile(o.tokenFile);
    } catch (e) {
      throw new CliError(
        `cannot read ${o.tokenFile} (${(e as Error).message})`,
        "check the path, then rerun",
      );
    }
    if ((f.mode & 0o077) !== 0)
      d.log(`WARN: ${o.tokenFile} is readable by others — fix: chmod 600 ${o.tokenFile}`);
    token = tokenFromText(f.text, ["OC_CF_AI_TOKEN", "CF_AI_TOKEN"]);
  } else if (o.useEnv && d.env.OC_CF_AI_TOKEN?.trim()) {
    token = d.env.OC_CF_AI_TOKEN.trim();
    source = "env";
  } else return null;
  d.registerSecret(token);
  if (!TOKEN_RE.test(token))
    throw new CliError(
      "the AI token has the wrong shape (expected 40-60 letters, digits, _ or -)",
      "copy the whole token from the Cloudflare page, then rerun",
    );
  return { token, source };
}

export interface VerifyResult {
  kind: "account" | "user";
  id: string;
  status: string;
  expiresOn?: string;
}

/** §3.3 step 3: account endpoint first; on 1000 the user endpoint (CF_AI_TOKEN is a user token, measured). */
export async function verifyAiToken(acct: string, token: string, d: AigDeps): Promise<VerifyResult> {
  type V = { id: string; status: string; expires_on?: string };
  const a = await cfApi<V>(d, token, "GET", `/accounts/${acct}/tokens/verify`);
  let kind: "account" | "user" = "account";
  let r = a;
  if (!a.json.success) {
    r = await cfApi<V>(d, token, "GET", "/user/tokens/verify");
    kind = "user";
  }
  if (!r.json.success || !r.json.result)
    throw new CliError(
      `the AI token is not valid (${errCode(r.json) ?? r.status})`,
      "make a new token with AI Gateway: Run (dashboard > My Profile > API Tokens), or rerun without --ai-token-file",
    );
  if (r.json.result.status !== "active")
    throw new CliError(
      `the AI token is not active (${r.json.result.status})`,
      "make a new token with AI Gateway: Run (dashboard > My Profile > API Tokens), or rerun without --ai-token-file",
    );
  if (r.json.result.expires_on)
    d.log(
      `WARN: the AI token expires on ${r.json.result.expires_on} — fix: make a token with no end date before then`,
    );
  return { kind, id: r.json.result.id, status: r.json.result.status, expiresOn: r.json.result.expires_on };
}

// ---------------------------------------------------------------- gateways (§3.3 steps 4-6)

export interface Gateway {
  id: string;
  authentication?: boolean;
  collect_logs?: boolean;
}

/** Body for POST /ai-gateway/gateways. Required fields per `cf schema ai-gateway gateways create`. */
export function gatewayCreateBody(id: string): Record<string, unknown> {
  return {
    id,
    authentication: true,
    collect_logs: true,
    cache_ttl: 0,
    cache_invalidate_on_update: true,
    rate_limiting_interval: 0,
    rate_limiting_limit: 0,
  };
}

/**
 * A token without AI Gateway Read cannot list gateways (10000). With --gateway the hop test decides (WARN).
 * Else ask by request: `oc-host`, then `default` (created on the first authenticated request, docs; guess).
 * A 200 means the gateway exists and the token has Run. 401 means no Run. Anything else: next candidate.
 */
async function probeGateway(
  acct: string,
  token: string,
  want: string | undefined,
  d: AigDeps,
): Promise<string | null> {
  if (want) {
    d.log(
      `WARN: the token cannot list AI gateways (10000); using gateway ${want} (from --gateway or oc-host.jsonc); the hop test checks it`,
    );
    return want;
  }
  for (const id of [MANAGED_GATEWAY, "default"]) {
    const r = await hop(d, {
      acct,
      gateway: id,
      token,
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
      timeoutMs: 30_000,
    });
    if (r.status === 200) {
      d.log(`gateway ${id} answered (the token cannot list gateways, so ochost found it by request)`);
      return id;
    }
    if (r.status === 401 || r.status === 403)
      throw new CliError(
        `gateway hop returned ${r.status}`,
        `the token lacks ${RUN_PERMISSION}; add it, or rerun without --ai-token-file`,
      );
  }
  return null;
}

export interface GatewayPick {
  id: string;
  action: "selected" | "created" | "assumed";
  authentication: boolean | null;
}

/**
 * Select or create (needs the opt-in token). Order: --gateway (must exist), else `oc-host` if it exists, else create `oc-host`.
 * [chg vs spec §3.3 step 4] A token with Run only cannot list gateways (10000, measured for CF_AI_TOKEN). With an
 * explicit --gateway this is a WARN and the hop test decides; without one it fails.
 */
export async function pickGateway(
  acct: string,
  token: string,
  want: string | undefined,
  d: AigDeps,
  oauthToken?: string,
): Promise<GatewayPick & { via: "oauth" | "token" }> {
  // OAuth first: if the wrangler login can read gateways (it cannot in wrangler 4.156: 10000), use it for
  // select/create so the pasted token only needs Run. Else the pasted token does it.
  let via: "oauth" | "token" = "token";
  let list = null as Awaited<ReturnType<typeof cfApi<Gateway[]>>> | null;
  if (oauthToken) {
    const o = await cfApi<Gateway[]>(
      d,
      oauthToken,
      "GET",
      `/accounts/${acct}/ai-gateway/gateways?per_page=50`,
    );
    if (o.json.success) {
      list = o;
      via = "oauth";
      token = oauthToken;
    }
  }
  list ??= await cfApi<Gateway[]>(d, token, "GET", `/accounts/${acct}/ai-gateway/gateways?per_page=50`);
  if (!list.json.success) {
    const code = errCode(list.json);
    if (code === 10000 || list.status === 403) {
      // A Run-only token (template + AI Gateway: Run) cannot list or create gateways. Find one by request.
      const probe = await probeGateway(acct, token, want, d);
      if (probe) return { id: probe, action: "assumed", authentication: null, via };
    }
    throw new CliError(
      `the token cannot read AI Gateway (${code ?? list.status}) and no gateway answered`,
      `add ${OPTIONAL_PERMISSIONS} to the token, or rerun with --gateway <existing gateway id>`,
    );
  }
  const gws = list.json.result ?? [];
  const found = gws.find((g) => g.id === (want ?? MANAGED_GATEWAY));
  if (found) {
    if (found.authentication === false)
      d.log(
        `WARN: gateway ${found.id} has authentication off — fix: turn it on in the dashboard, or rerun with --gateway ${MANAGED_GATEWAY}`,
      );
    return { id: found.id, action: "selected", authentication: found.authentication ?? null, via };
  }
  if (want && want !== MANAGED_GATEWAY)
    throw new CliError(
      `gateway ${want} does not exist`,
      `rerun without --gateway to create ${MANAGED_GATEWAY}`,
    );
  const c = await cfApi<Gateway>(
    d,
    token,
    "POST",
    `/accounts/${acct}/ai-gateway/gateways`,
    gatewayCreateBody(MANAGED_GATEWAY),
  );
  if (!c.json.success)
    throw new CliError(
      `cannot create gateway ${MANAGED_GATEWAY} (${errCode(c.json) ?? c.status} ${c.json.errors?.[0]?.message ?? ""})`.trim(),
      `add AI Gateway: Edit to the token, or rerun with --gateway <existing gateway id>`,
    );
  return { id: MANAGED_GATEWAY, action: "created", authentication: true, via };
}

// ---------------------------------------------------------------- model hop (§3.3 step 7; bench uses it too)

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface HopResult {
  status: number;
  ms: number;
  content: string;
  toolCalls: ToolCall[];
  neurons: number;
  promptTokens: number;
  completionTokens: number;
  /** usage.prompt_tokens_details.cached_tokens (model-side prefix cache); 0 when absent. */
  cachedTokens: number;
  /** cf-aig-cache-status (HIT, MISS, ...); empty when absent. */
  cache: string;
  error?: string;
}

export function gatewayChatUrl(acct: string, gateway: string): string {
  return `${GATEWAY_HOST}/v1/${acct}/${gateway}/workers-ai/v1/chat/completions`;
}

/** Strip the `<ds_safety>` tag that DeepSeek leaks into content (09-llm-setup.md). */
export function cleanContent(s: string | null | undefined): string {
  return (s ?? "").replace(/<\/?ds_safety>[^<]*(<\/ds_safety>)?/g, "").trim();
}

/** Where `hop` sends the call: the gateway directly with the opt-in token, or the Worker's gate. */
export interface HopEndpoint {
  url: string;
  headers: Record<string, string>;
}

/** The install's gate over HTTP: owner bearer on `/ops/gate/ai/v1/chat/completions` (worker/src/index.ts). */
export function gateEndpoint(workerUrl: string, controlToken: string): HopEndpoint {
  return {
    url: `${workerUrl.replace(/\/+$/, "")}/ops/gate/ai/v1/chat/completions`,
    headers: { authorization: `Bearer ${controlToken}` },
  };
}

/**
 * One OpenAI-style chat completion. With `endpoint` it goes there (the gate: no token, the Worker's AI binding
 * runs it); else straight to the gateway with the opt-in token. Never throws on HTTP errors; the caller decides.
 */
export async function hop(
  d: Pick<AigDeps, "fetch" | "now">,
  p: {
    endpoint?: HopEndpoint;
    acct?: string;
    gateway?: string;
    token?: string;
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    maxTokens?: number;
    timeoutMs?: number;
    /** Send cf-aig-skip-cache on a direct gateway call (bench: every call must reach the model). */
    skipCache?: boolean;
    /** reasoning_effort for the call (bench --role). Absent: the model's own default. */
    reasoningEffort?: string;
  },
): Promise<HopResult> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const body: Record<string, unknown> = {
    model: p.model,
    messages: p.messages,
    max_tokens: p.maxTokens ?? 2048,
  };
  if (p.tools?.length) body.tools = p.tools;
  if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
  const empty = {
    content: "",
    toolCalls: [],
    neurons: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cache: "",
  };
  const to = p.endpoint ?? {
    url: gatewayChatUrl(p.acct as string, p.gateway as string),
    headers: {
      authorization: `Bearer ${p.token}`,
      "cf-aig-authorization": `Bearer ${p.token}`,
      ...(p.skipCache ? { "cf-aig-skip-cache": "true" } : {}),
    },
  };
  let res: Response;
  try {
    res = await d.fetch(to.url, {
      method: "POST",
      headers: { ...to.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(p.timeoutMs ?? 120_000),
    });
  } catch (e) {
    return { status: 0, ms: now() - t0, ...empty, error: (e as Error).message };
  }
  const text = await res.text();
  const ms = now() - t0;
  const cache = res.headers.get("cf-aig-cache-status") ?? "";
  if (res.status !== 200) return { status: res.status, ms, ...empty, cache, error: errorText(text) };
  try {
    const j = JSON.parse(text) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        neurons?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const m = j.choices?.[0]?.message ?? {};
    return {
      status: 200,
      ms,
      content: cleanContent(m.content),
      toolCalls: m.tool_calls ?? [],
      neurons: j.usage?.neurons ?? 0,
      promptTokens: j.usage?.prompt_tokens ?? 0,
      completionTokens: j.usage?.completion_tokens ?? 0,
      cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cache,
    };
  } catch {
    return { status: 200, ms, ...empty, cache, error: `not JSON: ${text.slice(0, 120)}` };
  }
}

/** The gate answers `{error: {message}}`; the gateway and API answer other shapes. Keep the message. */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    const m = typeof j.error === "string" ? j.error : j.error?.message;
    if (m) return m.slice(0, 300);
  } catch {}
  return text.slice(0, 300);
}

/**
 * Init step "model hop" and `ai-gateway setup`: one ping through the gate. Pass = 200 and non-empty content.
 * 429 and 5xx are tried 3 times; anything else that is not 200 fails with the cause and the fix.
 */
export async function gateSmoke(
  p: { endpoint: HopEndpoint; model: string; gateway: string },
  d: Pick<AigDeps, "fetch" | "now" | "sleep" | "log">,
): Promise<{ ok: boolean; ms: number; neurons: number; content: string; warn?: string }> {
  const wait = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let r: HopResult | null = null;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await wait(1000 * 2 ** (i - 1));
    r = await hop(d, {
      endpoint: p.endpoint,
      model: p.model,
      messages: [{ role: "user", content: "Reply with the word pong only." }],
      maxTokens: 256,
    });
    if (r.status !== 0 && r.status !== 429 && r.status < 500) break;
  }
  const h = r as HopResult;
  if (h.status === 404 || h.status === 401)
    throw new CliError(
      `the gate did not answer (${h.status}); the Worker lacks the AI gate`,
      "ochost deploy (updates the Worker), then rerun",
    );
  if (h.status >= 400 && h.status < 500 && h.status !== 429)
    throw new CliError(
      `model ${p.model} failed through the gate (${h.status} ${h.error ?? ""})`.trim(),
      /gateway/i.test(h.error ?? "")
        ? `gateway ${p.gateway} does not exist: rerun with --gateway default (made on first use), or --gateway none`
        : "run ochost model list, then ochost model set <id>",
    );
  if (h.status === 502 && /gateway/i.test(h.error ?? ""))
    throw new CliError(
      `gateway ${p.gateway} refused the call (${h.error})`,
      "create it in the dashboard (AI > AI Gateway), or rerun with --gateway default or --gateway none",
    );
  if (h.status !== 200) {
    const warn = `WARN: model hop returned ${h.status || "no answer"} after 3 tries — fix: ochost doctor; ochost logs --source ctl`;
    d.log(warn);
    return { ok: false, ms: h.ms, neurons: 0, content: "", warn };
  }
  if (!h.content) {
    const warn = `WARN: model hop returned an empty reply from ${p.model} — fix: run ochost model bench, then pick another model`;
    d.log(warn);
    return { ok: false, ms: h.ms, neurons: h.neurons, content: "", warn };
  }
  return { ok: true, ms: h.ms, neurons: h.neurons, content: h.content };
}

// ---------------------------------------------------------------- the command (init step "ai", ai-gateway setup)

export interface SetupOpts {
  accountId: string;
  gateway?: string;
  model?: string;
  /** --ai-token-file: opt-in, lets setup list and create gateways. */
  tokenFile?: string;
  /** Also read env OC_CF_AI_TOKEN (commands only; init takes the file flag alone). */
  useEnv?: boolean;
  /** wrangler OAuth bearer; tried first for gateway list/create when a token is given. */
  oauthToken?: string;
}

export interface SetupResult {
  gateway: string;
  gatewayAction: GatewayPick["action"] | "default" | "none" | "given";
  tokenSource?: TokenSource;
  tokenKind?: VerifyResult["kind"];
  model: string;
  warnings: string[];
}

/**
 * Which gateway the Worker's AI binding uses. No token: the --gateway value, else `default` (AI Gateway makes it
 * on the first request, so there is no API call and nothing to select). With the opt-in token: verify it, then
 * select or create the gateway through the API (pickGateway). The token is not kept.
 */
export async function chooseGateway(o: SetupOpts, d: AigDeps): Promise<SetupResult> {
  const warnings: string[] = [];
  const dd: AigDeps = {
    ...d,
    log: (l) => {
      if (l.startsWith("WARN")) warnings.push(l);
      d.log(l);
    },
  };
  const model = o.model ?? DEFAULT_MODEL;
  const t = await resolveAiToken(o, dd);
  if (!t) {
    const gateway = o.gateway ?? DEFAULT_GATEWAY;
    if (gateway === NO_GATEWAY)
      dd.log(
        "WARN: no AI Gateway: calls run without logs or a spend limit — fix: ochost ai-gateway setup --gateway default",
      );
    return {
      gateway,
      gatewayAction: gateway === NO_GATEWAY ? "none" : o.gateway ? "given" : "default",
      model,
      warnings,
    };
  }
  const v = await verifyAiToken(o.accountId, t.token, dd);
  const gw = await pickGateway(o.accountId, t.token, o.gateway, dd, o.oauthToken);
  dd.log(`AI Gateway: ${gw.id} (${gw.action}${gw.via === "oauth" ? " with the wrangler login" : ""})`);
  return {
    gateway: gw.id,
    gatewayAction: gw.action,
    tokenSource: t.source,
    tokenKind: v.kind,
    model,
    warnings,
  };
}
