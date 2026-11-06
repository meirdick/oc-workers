// `ochost model bench` (docs/10-cli-spec.md §3.4, D13): agent-style turns with a tool schema through the install's
// gate (the Worker's AI binding, no token; also a local `wrangler dev`), or straight to the AI Gateway with the
// opt-in token (--direct). One turn = user prompt + tools → the model must call the right tool with the right
// arguments → tool result → the final answer must contain the fact from the result. Two gateway calls per turn.
// Output: success rate, p50/p95 turn latency, neurons per turn, USD. No install needed.
import {
  type AigDeps,
  type ChatMessage,
  type HopEndpoint,
  type HopResult,
  hop,
  type ToolCall,
  type ToolDef,
  USD_PER_1K_NEURONS,
} from "./ai-gateway.ts";
import { SHORTLIST } from "./model.ts";

export const BENCH_SYSTEM =
  "You are a personal assistant agent. Use a tool when the user asks for data you do not have. " +
  "After a tool result, answer in one short sentence with the fact the user asked for.";

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  }) as ToolDef;

export const BENCH_TOOLS: ToolDef[] = [
  fn(
    "get_weather",
    "Current weather for a city.",
    {
      city: { type: "string", description: "City name" },
      unit: { type: "string", enum: ["celsius", "fahrenheit"] },
    },
    ["city"],
  ),
  fn("read_file", "Read a text file from the user's workspace.", { path: { type: "string" } }, ["path"]),
  fn("calc", "Evaluate an arithmetic expression exactly.", { expression: { type: "string" } }, [
    "expression",
  ]),
  fn(
    "search_notes",
    "Full-text search in the user's notes.",
    { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
    ["query"],
  ),
];

export interface BenchTask {
  prompt: string;
  tool: string;
  args: (a: Record<string, unknown>) => boolean;
  result: string;
  expect: RegExp;
}

const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

export const BENCH_TASKS: BenchTask[] = [
  {
    prompt: "What's the weather in Lisbon right now, in celsius?",
    tool: "get_weather",
    args: (a) => /lisbon/i.test(s(a.city)),
    result: '{"city":"Lisbon","temp_c":21,"sky":"sunny"}',
    expect: /21/,
  },
  {
    prompt: "Read the file notes/todo.txt and tell me the first item.",
    tool: "read_file",
    args: (a) => /notes\/todo\.txt$/.test(s(a.path)),
    result: "1. renew passport\n2. call Dana\n3. buy coffee",
    expect: /passport/i,
  },
  {
    prompt: "What is 1234 * 5678? Use the calculator.",
    tool: "calc",
    args: (a) => /1234/.test(s(a.expression)) && /5678/.test(s(a.expression)),
    result: "7006652",
    expect: /7[,. ]?006[,. ]?652/,
  },
  {
    prompt: "Search my notes for 'dentist' and tell me the appointment date.",
    tool: "search_notes",
    args: (a) => /dentist/i.test(s(a.query)),
    result: '[{"title":"Dentist","date":"2026-11-14","text":"Dr. Ruiz, 09:30"}]',
    expect: /14|2026-11-14/,
  },
  {
    prompt: "Is it raining in Tokyo?",
    tool: "get_weather",
    args: (a) => /tokyo/i.test(s(a.city)),
    result: '{"city":"Tokyo","temp_c":14,"sky":"rain"}',
    expect: /\byes\b|rain/i,
  },
  {
    prompt: "Open config/app.json and tell me which port the app uses.",
    tool: "read_file",
    args: (a) => /config\/app\.json$/.test(s(a.path)),
    result: '{"name":"app","port":8443,"tls":true}',
    expect: /8443/,
  },
  {
    prompt: "Calculate (17 + 25) * 3 with the calculator.",
    tool: "calc",
    args: (a) => /17/.test(s(a.expression)) && /25/.test(s(a.expression)) && /3/.test(s(a.expression)),
    result: "126",
    expect: /126/,
  },
  {
    prompt: "Find the wifi password in my notes.",
    tool: "search_notes",
    args: (a) => /wi-?fi|password/i.test(s(a.query)),
    result: '[{"title":"Home wifi","text":"network: casa, password: tangerine-42"}]',
    expect: /tangerine-42/,
  },
  {
    prompt: "How warm is it in Nairobi in fahrenheit?",
    tool: "get_weather",
    args: (a) => /nairobi/i.test(s(a.city)),
    result: '{"city":"Nairobi","temp_f":75,"sky":"clouds"}',
    expect: /75/,
  },
  {
    prompt: "What is the project name in README.md?",
    tool: "read_file",
    args: (a) => /readme\.md$/i.test(s(a.path)),
    result: "# Bluefin\nA small tool to sync notes.",
    expect: /bluefin/i,
  },
];

export interface TurnResult {
  task: number;
  ok: boolean;
  /** Where it failed: http-<n>, no-tool-call, wrong-tool, bad-args, http2-<n>, empty-answer, wrong-answer. */
  fail?: string;
  ms: number;
  toolMs: number;
  neurons: number;
  /** Gateway cache hits in this turn (expected 0: the bench sends cf-aig-skip-cache). */
  cacheHits: number;
  /** Prompt tokens of the first call (system + user + tools). */
  promptTokens: number;
  /** Prompt tokens the model side served from its prefix cache, both calls. */
  cachedTokens: number;
  /** Calls sent again after 429 (capacity). */
  retries: number;
  detail?: string;
}

export interface ModelSummary {
  model: string;
  turns: number;
  ok: number;
  successRate: number;
  toolCallRate: number;
  p50Ms: number;
  p95Ms: number;
  p50ToolMs: number;
  neuronsPerTurn: number;
  neuronsTotal: number;
  usdPerTurn: number;
  cacheHits: number;
  p50PromptTokens: number;
  cachedTokens: number;
  retries: number;
  /** Assistant tool-call content form sent for this model. */
  assistantContent: "null" | "empty";
  fails: Record<string, number>;
}

export function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i] as number;
}

function parseArgs(tc: ToolCall): Record<string, unknown> | null {
  const raw = tc.function?.arguments as unknown;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? ""));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * How the assistant tool-call message carries an empty content. "null" is the OpenAI form; measured 2026-11-01:
 * gpt-oss-120b, llama-3.3-70b and qwen3-30b reject it (400, AiError 5006 "'string' not in 'null'") and need "".
 * A missing content also gives 400. Same on the gateway `compat` path. "auto" = "empty" for STRING_CONTENT_MODELS,
 * "null" for the rest (what OpenClaw sends by default: `content: null` unless
 * `compat.requiresAssistantAfterToolResult` is true).
 */
export type AssistantContent = "auto" | "null" | "empty";

/** Workers AI models whose input schema needs a string content on an assistant tool-call message. */
export const STRING_CONTENT_MODELS: ReadonlySet<string> = new Set([
  "@cf/openai/gpt-oss-120b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen3-30b-a3b-fp8",
]);

export function assistantContentFor(model: string, mode: AssistantContent = "auto"): "null" | "empty" {
  if (mode !== "auto") return mode;
  return STRING_CONTENT_MODELS.has(model) ? "empty" : "null";
}

export interface BenchTarget {
  /** The gate over HTTP (gateEndpoint). Set → acct and token are not used. */
  endpoint?: HopEndpoint;
  /** Direct gateway call (opt-in token). */
  acct?: string;
  token?: string;
  /** Gateway id, for the report (and the direct URL). */
  gateway: string;
  /** System prompt; default BENCH_SYSTEM. A long one models the OpenClaw prompt (13k tokens). */
  system?: string;
  /** reasoning_effort sent on every call (`model bench --role`). */
  effort?: string;
  /** Sends again after 429 (Workers AI "Capacity temporarily exceeded", 3040). Default 2, 1 s apart. */
  retries429?: number;
  /** Wait between 429 retries. Default 1000 ms. */
  retryWaitMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One agent-style turn. Never throws. */
export async function runTurn(
  t: BenchTarget,
  model: string,
  taskIx: number,
  d: Pick<AigDeps, "fetch" | "now">,
  assistantContent: AssistantContent = "auto",
): Promise<TurnResult> {
  const task = BENCH_TASKS[taskIx % BENCH_TASKS.length] as BenchTask;
  const msgs: ChatMessage[] = [
    { role: "system", content: t.system ?? BENCH_SYSTEM },
    { role: "user", content: task.prompt },
  ];
  const base = {
    endpoint: t.endpoint,
    acct: t.acct,
    gateway: t.gateway,
    token: t.token,
    model,
    reasoningEffort: t.effort,
    maxTokens: 4096,
    skipCache: true,
  };
  const now = d.now ?? Date.now;
  let retries = 0;
  // 429 = Workers AI capacity (3040). Send again like a client would; the wait counts in the turn time.
  const call = async (messages: ChatMessage[]): Promise<HopResult> => {
    const t0 = now();
    for (let i = 0; ; i++) {
      const r = await hop(d, { ...base, messages, tools: BENCH_TOOLS });
      if (r.status !== 429 || i >= (t.retries429 ?? 2)) return { ...r, ms: now() - t0 };
      retries++;
      await sleep(t.retryWaitMs ?? 1000);
    }
  };
  const r1 = await call([...msgs]);
  let r2: HopResult | null = null;
  const out = (ok: boolean, fail: string | undefined, ms: number, neurons: number, detail?: string) => ({
    task: taskIx % BENCH_TASKS.length,
    ok,
    ...(fail ? { fail } : {}),
    ms,
    toolMs: r1.ms,
    neurons,
    cacheHits: [r1, r2].filter((r) => r?.cache === "HIT").length,
    promptTokens: r1.promptTokens,
    cachedTokens: r1.cachedTokens + (r2?.cachedTokens ?? 0),
    retries,
    ...(detail ? { detail: detail.slice(0, 200) } : {}),
  });
  if (r1.status !== 200) return out(false, `http-${r1.status}`, r1.ms, r1.neurons, r1.error);
  const tc = r1.toolCalls[0];
  if (!tc) return out(false, "no-tool-call", r1.ms, r1.neurons, r1.content);
  if (tc.function?.name !== task.tool) return out(false, "wrong-tool", r1.ms, r1.neurons, tc.function?.name);
  const args = parseArgs(tc);
  if (!args || !task.args(args)) return out(false, "bad-args", r1.ms, r1.neurons, s(tc.function?.arguments));
  const id = tc.id || "call_0";
  msgs.push({
    role: "assistant",
    content: r1.content || (assistantContentFor(model, assistantContent) === "empty" ? "" : null),
    tool_calls: [{ id, type: "function", function: { name: tc.function.name, arguments: s(args) } }],
  });
  msgs.push({ role: "tool", tool_call_id: id, content: task.result });
  r2 = await call(msgs);
  const ms = r1.ms + r2.ms;
  const neurons = r1.neurons + r2.neurons;
  if (r2.status !== 200) return out(false, `http2-${r2.status}`, ms, neurons, r2.error);
  if (!r2.content) return out(false, r2.toolCalls.length ? "extra-tool-call" : "empty-answer", ms, neurons);
  if (!task.expect.test(r2.content)) return out(false, "wrong-answer", ms, neurons, r2.content);
  return out(true, undefined, ms, neurons);
}

export function summarize(model: string, rs: TurnResult[], mode: AssistantContent = "auto"): ModelSummary {
  const ok = rs.filter((r) => r.ok).length;
  // right tool with right arguments (step 1 passed)
  const called = rs.filter(
    (r) => !r.fail || !/^(http-|no-tool-call|wrong-tool|bad-args)/.test(r.fail),
  ).length;
  const neuronsTotal = rs.reduce((a, r) => a + r.neurons, 0);
  const fails: Record<string, number> = {};
  for (const r of rs) if (r.fail) fails[r.fail] = (fails[r.fail] ?? 0) + 1;
  const n = rs.length || 1;
  return {
    model,
    turns: rs.length,
    ok,
    successRate: ok / n,
    toolCallRate: called / n,
    p50Ms: pct(
      rs.map((r) => r.ms),
      50,
    ),
    p95Ms: pct(
      rs.map((r) => r.ms),
      95,
    ),
    p50ToolMs: pct(
      rs.map((r) => r.toolMs),
      50,
    ),
    neuronsPerTurn: neuronsTotal / n,
    neuronsTotal,
    usdPerTurn: (neuronsTotal / n / 1000) * USD_PER_1K_NEURONS,
    cacheHits: rs.reduce((a, r) => a + (r.cacheHits ?? 0), 0),
    p50PromptTokens: pct(
      rs.map((r) => r.promptTokens ?? 0),
      50,
    ),
    cachedTokens: rs.reduce((a, r) => a + (r.cachedTokens ?? 0), 0),
    retries: rs.reduce((a, r) => a + (r.retries ?? 0), 0),
    assistantContent: assistantContentFor(model, mode),
    fails,
  };
}

export interface BenchOpts extends BenchTarget {
  models?: string[];
  turns?: number;
  /** Models run at the same time (turns within one model stay sequential). Default 1. */
  concurrency?: number;
  assistantContent?: AssistantContent;
}

export interface BenchReport {
  at: string;
  gateway: string;
  turns: number;
  concurrency: number;
  assistantContent: AssistantContent;
  summaries: ModelSummary[];
  results: Record<string, TurnResult[]>;
}

export async function runBench(
  o: BenchOpts,
  d: Pick<AigDeps, "fetch" | "now" | "log">,
): Promise<BenchReport> {
  const models = o.models?.length ? o.models : [...SHORTLIST];
  const turns = o.turns ?? 20;
  const conc = Math.max(1, o.concurrency ?? 1);
  const results: Record<string, TurnResult[]> = {};
  const queue = [...models];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const rs: TurnResult[] = [];
      for (let i = 0; i < turns; i++) {
        const r = await runTurn(o, m, i, d, o.assistantContent);
        rs.push(r);
        d.log(`${m} turn ${i + 1}/${turns}: ${r.ok ? "ok" : r.fail} ${r.ms} ms`);
      }
      results[m] = rs;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, models.length) }, worker));
  const summaries = models.map((m) => summarize(m, results[m] ?? [], o.assistantContent));
  return {
    at: new Date((d.now ?? Date.now)()).toISOString(),
    gateway: o.gateway,
    turns,
    concurrency: conc,
    assistantContent: o.assistantContent ?? "auto",
    summaries,
    results,
  };
}

/** Markdown table for docs and the terminal. */
export function benchTable(r: BenchReport): string {
  const head =
    "| Model | Content | Success | Tool call ok | p50 turn | p95 turn | p50 tool step | Prompt tok | Neurons/turn | USD/turn | 429 retries | Fails |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = [...r.summaries]
    .sort((a, b) => b.successRate - a.successRate || a.p50Ms - b.p50Ms)
    .map(
      (x) =>
        `| \`${x.model}\` | ${x.assistantContent === "empty" ? '""' : "null"} | ${x.ok}/${x.turns} | ` +
        `${Math.round(x.toolCallRate * 100)}% | ${(x.p50Ms / 1000).toFixed(2)} s | ` +
        `${(x.p95Ms / 1000).toFixed(2)} s | ${(x.p50ToolMs / 1000).toFixed(2)} s | ${x.p50PromptTokens} | ` +
        `${x.neuronsPerTurn.toFixed(1)} | ${x.usdPerTurn.toFixed(5)} | ${x.retries} | ${
          Object.entries(x.fails)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "-"
        } |`,
    );
  return [head, ...rows].join("\n");
}
