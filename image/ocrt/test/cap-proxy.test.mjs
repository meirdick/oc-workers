import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { CAP_PROXY_PORT, CAP_PROXY_URL, capTarget, startCapProxy } from "../lib/cap-proxy.mjs";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

describe("cap proxy (loopback forwarder to CapGate)", () => {
  it("constants and target parsing", () => {
    assert.equal(CAP_PROXY_URL, `http://127.0.0.1:${CAP_PROXY_PORT}`);
    assert.deepEqual(capTarget(undefined), { host: "15.0.0.3", port: 80 });
    assert.deepEqual(capTarget("15.7.0.22:8080"), { host: "15.7.0.22", port: 8080 });
    assert.deepEqual(capTarget("nonsense"), { host: "15.0.0.3", port: 80 });
  });

  it("relays an HTTP POST both ways, with the body, to the fixed target only", async () => {
    const seen = [];
    const gate = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => {
        b += d;
      });
      req.on("end", () => {
        seen.push([req.method, req.url, b, req.headers.host]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { markdown: "# hi" } }));
      });
    });
    const gp = await listen(gate);
    const p = startCapProxy({ target: { host: "127.0.0.1", port: gp }, port: 0 });
    await new Promise((r) => p.server.once("listening", r));
    const port = p.server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/v2/scrape`, {
      method: "POST",
      body: '{"url":"http://example.com"}',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { success: true, data: { markdown: "# hi" } });
    assert.deepEqual(seen[0].slice(0, 3), ["POST", "/v2/scrape", '{"url":"http://example.com"}']);
    assert.equal(p.state.accepted, 1);
    p.close();
    gate.close();
  });

  it("a dead target closes the client socket and counts an error", async () => {
    const p = startCapProxy({ target: { host: "127.0.0.1", port: 1 }, port: 0 });
    await new Promise((r) => p.server.once("listening", r));
    const port = p.server.address().port;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/x`));
    assert.ok(p.state.errors >= 1);
    p.close();
  });
});
