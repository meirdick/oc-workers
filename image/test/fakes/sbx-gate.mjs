// Fake SandboxGate for the Docker sandbox check (image/test/sandbox-check.mjs). Listens on :80 at 15.0.0.4 and
// runs each /exec in THIS container, which stands in for the SandboxSession container. Same wire as the real gate
// (docs/12 §4): request = u32 BE header length + JSON {v, cmd} + stdin; response = frames (1 out, 2 err, 3 exit).
// Logs one JSON line per exec (cmd, stdin head) to /log/sbx.jsonl. Mode file /log/sbx-mode: ok | 429 | 403.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";

const LOG = "/log/sbx.jsonl";
const mode = () => {
  try {
    return fs.readFileSync("/log/sbx-mode", "utf8").trim() || "ok";
  } catch {
    return "ok";
  }
};
const frame = (t, b) => {
  const h = Buffer.alloc(5);
  h[0] = t;
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/exec") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"error":"not found"}');
    }
    const m = mode();
    if (m !== "ok") {
      res.writeHead(Number(m), { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: m === "429" ? "budget" : "sandbox off", verb: "exec" }));
    }
    let buf = Buffer.alloc(0);
    let child = null;
    let input = "";
    const t0 = Date.now();
    req.on("data", (d) => {
      if (child) {
        if (input.length < 4000) input += d.toString("utf8");
        return child.stdin.write(d);
      }
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) return;
      const head = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
      const rest = buf.subarray(4 + n);
      res.writeHead(200, { "content-type": "application/x-ochost-sbx" });
      child = spawn("/bin/sh", ["-c", head.cmd], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      if (rest.length) {
        input += rest.toString("utf8");
        child.stdin.write(rest);
      }
      child.stdout.on("data", (b) => res.write(frame(1, b)));
      child.stderr.on("data", (b) => res.write(frame(2, b)));
      child.on("close", (code) => {
        const rec = {
          ts: new Date().toISOString(),
          cmd: head.cmd.slice(0, 2000),
          stdin: input.slice(0, 4000),
          code,
          ms: Date.now() - t0,
        };
        fs.appendFileSync(LOG, `${JSON.stringify(rec)}\n`);
        res.end(frame(3, Buffer.from(JSON.stringify({ code: code ?? 137 }))));
      });
    });
    req.on("end", () => child?.stdin.end());
  })
  .listen(80, "0.0.0.0", () => console.log(JSON.stringify({ ev: "fake-sbx-gate listening" })));
