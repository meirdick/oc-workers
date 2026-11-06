import { describe, expect, it } from "vitest";
import { gateEndpoint } from "../src/ai-gateway.ts";
import { assistantContentFor, BENCH_TASKS, benchTable, pct, runBench, runTurn } from "../src/bench.ts";
import { fakeFetch, type Handler, TOKEN } from "./fakes.ts";

const T = { acct: "a".repeat(32), gateway: "gw", token: TOKEN };
let clock = 0;
const now = () => (clock += 100);

/** A model that calls the right tool with good args, then answers from the tool result. */
const goodModel: Handler = (c) => {
  const msgs = c.body.messages as any[];
  const last = msgs.at(-1);
  if (last.role === "tool")
    return {
      json: { choices: [{ message: { content: `Result: ${last.content}` } }], usage: { neurons: 2 } },
    };
  const task = BENCH_TASKS.find((t) => t.prompt === last.content)!;
  const args: Record<string, string> = {
    get_weather: JSON.stringify({ city: last.content.match(/Lisbon|Tokyo|Nairobi/)?.[0] }),
    read_file: JSON.stringify({ path: last.content.match(/[\w/]+\.(txt|json|md)/)?.[0] }),
    calc: JSON.stringify({ expression: last.content.match(/\d[\d\s*+()]*\d\)?(\s*\*\s*\d+)?/)?.[0] }),
    search_notes: JSON.stringify({ query: /dentist/.test(last.content) ? "dentist" : "wifi password" }),
  };
  return {
    json: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: task.tool, arguments: args[task.tool] } },
            ],
          },
        },
      ],
      usage: { neurons: 3 },
    },
  };
};

describe("bench", () => {
  it("good model: 10/10 over all tasks; two calls per turn with tools and the tool result", async () => {
    const ff = fakeFetch([["POST https://gateway.ai.cloudflare.com/v1/", goodModel]]);
    const r = await runBench(
      { ...T, models: ["@cf/x/good"], turns: 10 },
      { fetch: ff.fetch, now, log: () => {} },
    );
    const s = r.summaries[0]!;
    expect(s).toMatchObject({ ok: 10, turns: 10, successRate: 1, toolCallRate: 1, neuronsPerTurn: 5 });
    expect(ff.calls).toHaveLength(20);
    expect(ff.calls[0]?.body.tools).toHaveLength(4);
    expect(ff.calls[1]?.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(benchTable(r)).toMatch(/\| `@cf\/x\/good` \| null \| 10\/10 \| 100% \|/);
  });
  it("through the gate (also a local wrangler dev): owner bearer to /ops/gate, no gateway token, same turns", async () => {
    const ff = fakeFetch([["POST http://127.0.0.1:8787/ops/gate/ai/v1/chat/completions", goodModel]]);
    const endpoint = gateEndpoint("http://127.0.0.1:8787", "owner-tok");
    const r = await runBench(
      { endpoint, gateway: "default", models: ["@cf/x/good"], turns: 3 },
      { fetch: ff.fetch, now, log: () => {} },
    );
    expect(r.summaries[0]).toMatchObject({ ok: 3, turns: 3 });
    expect(r.gateway).toBe("default");
    expect(ff.calls).toHaveLength(6);
    for (const c of ff.calls) {
      expect(c.headers.authorization).toBe("Bearer owner-tok");
      expect(c.headers["cf-aig-authorization"]).toBeUndefined();
    }
  });
  it("fail classes: no tool call, wrong tool, bad args, wrong answer, http", async () => {
    const mk = (h: Handler) => fakeFetch([["POST https://gateway.ai.cloudflare.com/v1/", h]]).fetch;
    const content = (s: string) => () => ({ json: { choices: [{ message: { content: s } }] } });
    const call = (name: string, args: string) => () => ({
      json: {
        choices: [
          { message: { tool_calls: [{ id: "x", type: "function", function: { name, arguments: args } }] } },
        ],
      },
    });
    const d = (h: Handler) => ({ fetch: mk(h), now });
    expect(await runTurn(T, "m", 0, d(content("It is sunny")))).toMatchObject({
      ok: false,
      fail: "no-tool-call",
    });
    expect(await runTurn(T, "m", 0, d(call("calc", "{}")))).toMatchObject({ fail: "wrong-tool" });
    expect(await runTurn(T, "m", 0, d(call("get_weather", '{"city":"Paris"}')))).toMatchObject({
      fail: "bad-args",
    });
    expect(await runTurn(T, "m", 0, d(call("get_weather", "not json")))).toMatchObject({ fail: "bad-args" });
    expect(
      await runTurn(
        T,
        "m",
        0,
        d(() => ({ status: 500, text: "x" })),
      ),
    ).toMatchObject({ fail: "http-500" });
    let n = 0;
    const thenWrong: Handler = () =>
      n++ === 0 ? call("get_weather", '{"city":"Lisbon"}')() : content("It is 30 degrees")();
    expect(await runTurn(T, "m", 0, d(thenWrong))).toMatchObject({ fail: "wrong-answer" });
    // object arguments (some Workers AI models) are accepted
    n = 0;
    const objArgs: Handler = () =>
      n++ === 0
        ? {
            json: {
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "x",
                        type: "function",
                        function: { name: "get_weather", arguments: { city: "Lisbon" } },
                      },
                    ],
                  },
                },
              ],
            },
          }
        : content("21 C and sunny")();
    expect(await runTurn(T, "m", 0, d(objArgs))).toMatchObject({ ok: true });
  });
  it("assistant content: auto = '' for string-content models, null for others; modes override", async () => {
    for (const [model, mode, want] of [
      ["m", undefined, null],
      ["@cf/openai/gpt-oss-120b", undefined, ""],
      ["@cf/qwen/qwen3-30b-a3b-fp8", "auto", ""],
      ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "null", null],
      ["m", "empty", ""],
    ] as const) {
      const ff = fakeFetch([["POST https://gateway.ai.cloudflare.com/v1/", goodModel]]);
      await runTurn(T, model, 0, { fetch: ff.fetch, now }, mode);
      expect(ff.calls[1]?.body.messages[2]).toMatchObject({ role: "assistant", content: want });
    }
    expect(assistantContentFor("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe("empty");
    expect(assistantContentFor("@cf/deepseek-ai/deepseek-v4.1-flash-1017")).toBe("null");
  });
  it("429 is sent again (counted in retries); a custom system prompt is used", async () => {
    let n = 0;
    const busy: Handler = (c) => (n++ === 0 ? { status: 429, text: '{"internalCode":3040}' } : goodModel(c));
    const ff = fakeFetch([["POST https://gateway.ai.cloudflare.com/v1/", busy]]);
    const r = await runTurn({ ...T, system: "LONG", retryWaitMs: 0 }, "m", 0, { fetch: ff.fetch, now });
    expect(r).toMatchObject({ ok: true, retries: 1 });
    expect(ff.calls).toHaveLength(3);
    expect(ff.calls[0]?.body.messages[0]).toEqual({ role: "system", content: "LONG" });
    let m = 0;
    const always: Handler = (c) => (m++ < 9 ? { status: 429, text: "busy" } : goodModel(c));
    const ff2 = fakeFetch([["POST https://gateway.ai.cloudflare.com/v1/", always]]);
    const r2 = await runTurn({ ...T, retryWaitMs: 0 }, "m", 0, { fetch: ff2.fetch, now });
    expect(r2).toMatchObject({ ok: false, fail: "http-429", retries: 2 });
  });
  it("pct", () => {
    expect(pct([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(pct([], 50)).toBe(0);
  });
});
