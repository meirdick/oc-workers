// Offline stand-in for the model and the CapGate (webfetch-plugin test). One server on 127.0.0.1:9101:
//   OpenAI chat: call 1 asks for web_fetch http://example.com, call 2 echoes SAW-MARKER if the tool result had the gate's text.
//   POST /v2/scrape, /v2/search: the Firecrawl-shaped answer the Worker CapGate gives (worker/src/gates/cap.ts).
// On SIGTERM prints one line `LOG <json>` with every request seen.
import http from "node:http";

const log = [];
let n = 0;
http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const u = req.url;
      if (u.endsWith("/v2/scrape")) {
        // fake gate
        log.push({ gate: u, body: raw });
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            success: true,
            data: {
              markdown: "# Example Domain\n\nGATE-SERVED-MARKER",
              metadata: { title: "Example Domain", sourceURL: "http://example.com/" },
            },
          }),
        );
      }
      if (u.endsWith("/browser/status")) {
        log.push({ gate: u, body: raw });
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ on: true, used: 40, limit: 3600, ok: true, retryAfterS: 100 }));
      }
      if (u.endsWith("/search")) {
        log.push({ gate: u, body: raw });
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            success: true,
            data: {
              web: [{ url: "https://example.com/a", title: "Result A", description: "GATE-SEARCH-MARKER" }],
            },
          }),
        );
      }
      if (u.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
      }
      if (u.endsWith("/chat/completions")) {
        const b = JSON.parse(raw);
        n++;
        const last = JSON.stringify(b.messages.at(-1));
        const search = JSON.stringify(b.messages.filter((m) => m.role === "user").at(0) ?? "");
        const wantSearch = /search for/.test(search);
        const tool = b.messages.some((m) => m.role === "tool");
        log.push({
          llm: n,
          tool,
          tools: (b.tools || []).map((t) => t.function?.name || t.name),
          last: last.slice(0, 300),
        });
        const id = `c${n}`,
          created = 1;
        const msg = tool
          ? {
              role: "assistant",
              content: `done: ${/GATE-(SERVED|SEARCH)-MARKER/.test(last) ? "SAW-MARKER" : "NO-MARKER"}`,
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call1",
                  type: "function",
                  function: {
                    name: wantSearch ? "web_search" : "web_fetch",
                    arguments: JSON.stringify(
                      wantSearch ? { query: "cloudflare web search" } : { url: "http://example.com" },
                    ),
                  },
                },
              ],
            };
        if (b.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const ch = (delta, fin) =>
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "mock", choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
          const d = msg.tool_calls
            ? { role: "assistant", tool_calls: msg.tool_calls.map((t, i) => ({ index: i, ...t })) }
            : { role: "assistant", content: msg.content };
          return res.end(`${ch(d, null) + ch({}, msg.tool_calls ? "tool_calls" : "stop")}data: [DONE]\n\n`);
        }
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: "mock",
            choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
      res.statusCode = 404;
      res.end("{}");
    });
  })
  .listen(9101, "127.0.0.1");
process.on("SIGTERM", () => {
  console.log(`LOG ${JSON.stringify(log)}`);
  process.exit(0);
});
