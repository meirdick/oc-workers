import { describe, expect, it } from "vitest";
import { handleLlm, nextScript } from "../../src/gates/fakes.js";

const script = (steps: unknown) => `SCRIPT:${btoa(JSON.stringify(steps))}`;
const steps = [
  { name: "exec", args: { command: "uname -a" } },
  { name: "read", args: { path: "a" } },
];

describe("scripted mock LLM", () => {
  it("answers tool_use per step then FINAL", () => {
    const u = { role: "user", content: [{ type: "text", text: script(steps) }] };
    expect(nextScript([u])).toMatchObject({ call: steps[0], n: 0 });
    const a = { role: "assistant", content: [{ type: "tool_use" }] };
    const r = (t: string) => ({
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text: t }] }],
    });
    expect(nextScript([u, a, r("x")])).toMatchObject({ call: steps[1], n: 1 });
    expect(nextScript([u, a, r("x"), a, r("y")])).toEqual({ text: 'FINAL ["x","y"]' });
    // The user text re-appended after the results does not restart the script.
    expect(nextScript([u, a, r("x"), { role: "user", content: script(steps) }])).toMatchObject({
      call: steps[1],
      n: 1,
    });
    expect(nextScript([{ role: "user", content: "hi" }])).toBeNull();
  });
  it("handleLlm streams a tool_use block", async () => {
    const body = { model: "m", stream: true, messages: [{ role: "user", content: script(steps) }] };
    const res = await handleLlm(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(body) }),
      { gateEvent: async () => {} } as never,
      "plain",
    );
    const t = await res.text();
    expect(t).toContain('"type":"tool_use"');
    expect(t).toContain('"stop_reason":"tool_use"');
    expect(t).toContain("input_json_delta");
  });
});
