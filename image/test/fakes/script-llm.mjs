// Scripted OpenAI-compatible LLM for the Docker sandbox check (image/test/sandbox-check.mjs). :80 at 15.0.0.21.
// The last user message is `SCRIPT:<base64 JSON [{name, args}, ...]>`. Each /chat/completions call answers the
// next tool call of the script (count = tool results after that user message); when the script is done it
// answers text `FINAL <tool results as JSON>`, so the agent reply carries what the tools returned.
import http from "node:http";

const text = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => p?.text ?? "").join("")
      : JSON.stringify(c ?? "");

function next(messages) {
  let u = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "user" && text(messages[i].content).includes("SCRIPT:")) {
      u = i;
      break;
    }
  if (u < 0) return { text: "FINAL no script" };
  const m = /SCRIPT:([A-Za-z0-9+/=]+)/.exec(text(messages[u].content));
  const steps = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  const results = messages
    .slice(u + 1)
    .filter((x) => x.role === "tool")
    .map((x) => text(x.content));
  if (results.length < steps.length) return { call: steps[results.length], n: results.length };
  return { text: `FINAL ${JSON.stringify(results)}` };
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "script", object: "model" }] }));
      }
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404);
        return res.end();
      }
      const b = JSON.parse(raw || "{}");
      const r = next(b.messages || []);
      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const call = r.call && {
        index: 0,
        id: `call_${r.n}_${Date.now()}`,
        type: "function",
        function: { name: r.call.name, arguments: JSON.stringify(r.call.args) },
      };
      const msg = call
        ? { role: "assistant", content: null, tool_calls: [call] }
        : { role: "assistant", content: r.text };
      const fin = call ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          stream: !!b.stream,
          out: call ? call.function : r.text.slice(0, 200),
        }),
      );
      if (!b.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: b.model,
            choices: [{ index: 0, message: msg, finish_reason: fin }],
            usage,
          }),
        );
      }
      const chunk = (delta, finish, extra = {}) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: b.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(`${chunk(msg, null)}${chunk({}, fin, { usage })}data: [DONE]\n\n`);
    });
  })
  .listen(80, "0.0.0.0", () => console.log(JSON.stringify({ ev: "script-llm listening" })));
