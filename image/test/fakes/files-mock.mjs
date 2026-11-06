// Offline stand-in for the model and the ReplicaGate files key space (files-plugin test).
//   127.0.0.1:9101 OpenAI chat: call 1 asks for file_store save notes/hello.md, call 2 says SAW-OK if the tool
//                  result had "ok": true.
//   127.0.0.1:9102 S3 gate: SigV4 checked with the harness verifier (key from argv), the real contract rule
//                  (filesAccess, inst from argv), If-None-Match: *, ListObjectsV2. Objects in memory.
// On SIGTERM prints `LOG <json>` (requests) and `OBJS <json>` (keys and sizes).
import http from "node:http";
import * as C from "../../ocrt/lib/contract.mjs";
import { verifySigV4 } from "./gate-core.mjs";

const [inst, keyId, secret] = process.argv.slice(2);
const bucket = `oc-host-${inst}`;
const log = [];
const objs = new Map();
let n = 0;

const xml = (res, s, code) => {
  res.writeHead(s, { "content-type": "application/xml" });
  res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
};

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, "http://x");
      const segs = u.pathname.split("/").slice(1).map(decodeURIComponent);
      const key = segs.slice(1).join("/");
      const v = verifySigV4({
        method: req.method,
        rawPath: req.url,
        headers: req.headers,
        body,
        secretFor: (id) => (id === keyId ? secret : null),
      });
      const op = C.s3OpOf(req.method, u.searchParams);
      const acc = op
        ? C.filesAccess({ inst, mode: "prod" }, op, key || null, u.searchParams.get("prefix"))
        : null;
      log.push({ m: req.method, op, key, sig: v.ok, host: req.headers.host, allow: !!acc?.allow });
      if (!v.ok) return xml(res, 403, "SignatureDoesNotMatch");
      if (segs[0] !== bucket) return xml(res, 404, "NoSuchBucket");
      if (!acc?.allow) return xml(res, acc?.status ?? 501, "AccessDenied");
      if (op === "ListObjectsV2") {
        const pre = u.searchParams.get("prefix") ?? "";
        const keys = [...objs.keys()].filter((k) => k.startsWith(pre)).sort();
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${keys
            .map(
              (k) =>
                `<Contents><Key>${k}</Key><LastModified>2026-11-06T00:00:00.000Z</LastModified><Size>${objs.get(k).length}</Size></Contents>`,
            )
            .join("")}</ListBucketResult>`,
        );
      }
      if (op === "PutObject") {
        if (req.headers["if-none-match"] === "*" && objs.has(key)) return xml(res, 412, "PreconditionFailed");
        objs.set(key, body);
        res.writeHead(200, { etag: '"e"' });
        return res.end();
      }
      const o = objs.get(key);
      if (op === "HeadObject") {
        res.writeHead(o ? 200 : 404, o ? { "content-length": o.length, etag: '"e"' } : {});
        return res.end();
      }
      if (op === "GetObject") {
        if (!o) return xml(res, 404, "NoSuchKey");
        res.writeHead(200, { "content-length": o.length, etag: '"e"' });
        return res.end(o);
      }
      if (op === "DeleteObject") {
        objs.delete(key);
        res.writeHead(204);
        return res.end();
      }
      xml(res, 501, "NotImplemented");
    });
  })
  .listen(9102, "127.0.0.1");

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
      }
      if (!req.url.endsWith("/chat/completions")) {
        res.statusCode = 404;
        return res.end("{}");
      }
      const b = JSON.parse(raw);
      n++;
      const last = JSON.stringify(b.messages.at(-1));
      const tool = b.messages.some((m) => m.role === "tool");
      log.push({
        llm: n,
        tool,
        tools: (b.tools || []).map((t) => t.function?.name || t.name),
        last: last.slice(0, 400),
      });
      const msg = tool
        ? { role: "assistant", content: `done: ${/\\"ok\\": true/.test(last) ? "SAW-OK" : "NO-OK"}` }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call1",
                type: "function",
                function: {
                  name: "file_store",
                  arguments: JSON.stringify({
                    action: "save",
                    name: "notes/hello.md",
                    content: "FILE-MARKER",
                  }),
                },
              },
            ],
          };
      const id = `c${n}`;
      if (b.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ch = (delta, fin) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
        const d = msg.tool_calls
          ? { role: "assistant", tool_calls: msg.tool_calls.map((t, i) => ({ index: i, ...t })) }
          : { role: "assistant", content: msg.content };
        return res.end(`${ch(d, null) + ch({}, msg.tool_calls ? "tool_calls" : "stop")}data: [DONE]\n\n`);
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 1,
          model: "mock",
          choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  })
  .listen(9101, "127.0.0.1");

process.on("SIGTERM", () => {
  console.log(`LOG ${JSON.stringify(log)}`);
  console.log(
    `OBJS ${JSON.stringify([...objs].map(([k, v]) => [k, v.length, v.length < 200 ? v.toString() : ""]))}`,
  );
  process.exit(0);
});
