// Fake ControlGate at 15.0.0.1:80 for local ocsup tests. Logs every request as JSON to stdout and /log/gate.jsonl.
// Mode file /log/mode: ok (200, default) | fail (500) | stale (409) | drop (close the socket).
import fs from "node:fs";
import http from "node:http";

const LOG = "/log/gate.jsonl";
const mode = () => {
  try {
    return fs.readFileSync("/log/mode", "utf8").trim() || "ok";
  } catch {
    return "ok";
  }
};
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const m = mode();
      let j = null;
      try {
        j = JSON.parse(body);
      } catch {}
      const status = m === "fail" ? 500 : m === "stale" ? 409 : 200;
      const rec = {
        ts: new Date().toISOString(),
        from: req.socket.remoteAddress,
        route: req.url,
        mode: m,
        status: m === "drop" ? "dropped" : status,
        auth: req.headers.authorization ? "bearer" : null,
        body: j && {
          inst: j.inst,
          epoch: j.epoch,
          gen: j.gen,
          boot_id: j.boot_id,
          uptime: j.uptime,
          rss: j.rss,
          kind: j.kind,
          phase: j.phase,
          draining: j.draining,
          code: j.code,
          reason: j.reason,
        },
      };
      const line = `${JSON.stringify(rec)}\n`;
      process.stdout.write(line);
      fs.appendFileSync(LOG, line);
      if (m === "drop") return req.socket.destroy();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          status === 409 ? { error: "stale" } : { ok: true, gen: j?.gen ?? null, tier: "normal" },
        ),
      );
    });
  })
  .listen(80, "0.0.0.0", () => console.log(JSON.stringify({ ev: "fake-gate listening" })));
