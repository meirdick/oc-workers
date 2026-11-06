import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CredSync, credRoute } from "../lib/credsync.mjs";
import { spawnOcio } from "../lib/ocio-run.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(10);
  }
};
function fakeGate({ failFirst = 0 } = {}) {
  const calls = [];
  let fails = failFirst;
  return {
    calls,
    async call(method, route, body) {
      if (fails > 0) {
        fails--;
        throw new Error("503");
      }
      calls.push({ method, route, body, at: Date.now() });
      return { ok: true };
    },
  };
}
const live = [];

afterEach(() => {
  for (const c of live.splice(0)) c.stop();
});
function mk(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-"));
  const varDir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-"));
  fs.mkdirSync(path.join(root, "credentials"), { recursive: true });
  const gate = extra.gate || fakeGate();
  const cs = new CredSync({
    root,
    varDir,
    gate,
    files: ["codex-home/auth.json"],
    spawn: (a) => spawnOcio("credwatch", a, { asRoot: true }),
    ...extra,
  });
  live.push(cs);
  return { root, varDir, gate, cs };
}
const ready = (cs) => new Promise((r) => cs.once("scan-done", r));

describe("credsync", () => {
  it("route encodes each segment", () => {
    assert.equal(
      credRoute("credentials/wa/default/creds.json"),
      "/v1/creds/credentials/wa/default/creds.json",
    );
    assert.equal(credRoute("credentials/a b"), "/v1/creds/credentials/a%20b");
  });
  it("a change reaches the store in < 1 s with seq, sha256, mode; delete sends a tombstone", async () => {
    const { root, gate, cs } = mk();
    cs.start();
    await ready(cs);
    const f = path.join(root, "credentials/wa/default/creds.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const body = JSON.stringify({ noiseKey: "x", n: 1 });
    const t0 = Date.now();
    fs.writeFileSync(f, body, { mode: 0o600 });
    await until(() => gate.calls.some((c) => c.method === "PUT"));
    const put = gate.calls.find((c) => c.method === "PUT");
    const ms = put.at - t0;
    assert.ok(ms < 1000, `latency ${ms} ms`);
    assert.equal(put.route, "/v1/creds/credentials/wa/default/creds.json");
    assert.equal(put.body.sha256, sha(body));
    assert.equal(put.body.mode, 0o600);
    assert.equal(Buffer.from(put.body.b64, "base64").toString(), body);
    assert.ok(put.body.seq >= 1);
    console.log(`# credsync write→PUT latency ${ms} ms`);
    fs.unlinkSync(f);
    await until(() => gate.calls.some((c) => c.method === "DELETE"));
    const del = gate.calls.find((c) => c.method === "DELETE");
    assert.ok(del.body.seq > put.body.seq);
    cs.stop();
  });
  it("torn JSON waits; the complete file is sent once", async () => {
    const { root, gate, cs } = mk();
    cs.start();
    await ready(cs);
    const f = path.join(root, "credentials/creds.json");
    fs.writeFileSync(f, '{"a":');
    await sleep(500);
    assert.equal(gate.calls.length, 0);
    fs.writeFileSync(f, '{"a":1}');
    await until(() => gate.calls.length === 1);
    assert.equal(gate.calls[0].body.sha256, sha('{"a":1}'));
    cs.stop();
  });
  it("symlinks and hard links are never read (plan §4.13)", async () => {
    const { root, gate, cs } = mk();
    const skips = [];
    cs.on("skip", (s) => skips.push(s));
    cs.start();
    await ready(cs);
    const secret = path.join(os.tmpdir(), `secret-${process.pid}`);
    fs.writeFileSync(secret, "TOPSECRET");
    fs.symlinkSync(secret, path.join(root, "credentials/link.json"));
    fs.linkSync(secret, path.join(root, "credentials/hard.json"));
    await until(() => skips.length >= 2);
    await sleep(300);
    assert.equal(gate.calls.length, 0);
    assert.deepEqual(skips.map((s) => s.why).sort(), ["hardlink", "symlink"]);
    cs.stop();
    fs.unlinkSync(secret);
  });
  it("killed watcher respawns and reconciles a change made while down", async () => {
    const { root, gate, cs } = mk();
    cs.start();
    await ready(cs);
    fs.writeFileSync(path.join(root, "credentials/a.json"), '{"v":1}');
    await until(() => gate.calls.length === 1);
    cs.child.kill("SIGKILL");
    await until(() => !cs.child);
    fs.writeFileSync(path.join(root, "credentials/a.json"), '{"v":2}');
    fs.writeFileSync(path.join(root, "credentials/b.json"), '{"v":1}');
    await ready(cs); // respawn after 1 s, then the scan
    await until(() => gate.calls.length === 3);
    assert.deepEqual(
      gate.calls
        .slice(1)
        .map((c) => c.route)
        .sort(),
      ["/v1/creds/credentials/a.json", "/v1/creds/credentials/b.json"],
    );
    assert.equal(cs.stats.respawns, 1);
    cs.stop();
  });
  it("down > 30 s alerts, > 60 s closes ingress; reconciled watcher reopens it", async () => {
    let t = 1_000_000;
    const alerts = [];
    const ingress = [];
    let allow = false;
    const { cs } = mk({
      now: () => t,
      upOkMs: 50,
      alert: (c, s) => alerts.push([c, s]),
      onIngress: (open) => ingress.push(open),
      spawn: (a) =>
        allow
          ? spawnOcio("credwatch", a, { asRoot: true })
          : spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: ["pipe", "pipe", "pipe"] }),
    });
    cs.start();
    await until(() => !cs.child && cs.downSince !== null);
    t += 31_000;
    await until(() => alerts.length === 1, 2000);
    t += 30_000;
    await until(() => ingress.length === 1, 2000);
    assert.deepEqual(ingress, [false]);
    assert.deepEqual(alerts, [
      ["credsync-down", "warn"],
      ["credsync-down", "high"],
    ]);
    allow = true;
    await until(() => ingress.length === 2, 8000);
    assert.deepEqual(ingress, [false, true]);
    cs.stop();
  });
  it("flush = full scan + empty queue; gate errors retry; newest version wins", async () => {
    const gate = fakeGate({ failFirst: 2 });
    const { root, cs } = mk({ gate });
    cs.start();
    await ready(cs);
    fs.writeFileSync(path.join(root, "credentials/k.json"), '{"v":1}');
    await sleep(150);
    fs.writeFileSync(path.join(root, "credentials/k.json"), '{"v":2}');
    const r = await cs.flush();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(cs.acked.get("credentials/k.json"), sha('{"v":2}'));
    assert.equal(gate.calls.at(-1).body.sha256, sha('{"v":2}'));
    assert.ok(cs.stats.errors >= 2);
    cs.stop();
  });
  it("restored manifest = known: no re-PUT of equal files; read-only mode sends nothing", async () => {
    const { root, gate, cs } = mk({ known: { "credentials/x.json": sha('{"x":1}') } });
    fs.writeFileSync(path.join(root, "credentials/x.json"), '{"x":1}');
    cs.start();
    await ready(cs);
    await sleep(200);
    assert.equal(gate.calls.length, 0);
    cs.stop();
    const ro = mk({ mode: "read-only" });
    fs.writeFileSync(path.join(ro.root, "credentials/y.json"), '{"y":1}');
    ro.cs.start();
    await ready(ro.cs);
    await sleep(300);
    assert.equal(ro.gate.calls.length, 0);
    assert.equal((await ro.cs.flush()).why, "read-only");
    ro.cs.stop();
  });
  it("codex-home auth file is watched; pending journal holds paths only", async () => {
    const { root, varDir, gate, cs } = mk({ gate: { calls: [], call: () => new Promise(() => {}) } }); // never acks
    fs.mkdirSync(path.join(root, "codex-home"));
    cs.start();
    await ready(cs);
    fs.writeFileSync(path.join(root, "codex-home/auth.json"), '{"tok":"SECRET"}');
    await until(() => cs.backlog() === 1);
    const j = fs.readFileSync(path.join(varDir, "creds-pending"), "utf8");
    assert.ok(j.includes("codex-home/auth.json") || cs.inflight);
    assert.doesNotMatch(j, /SECRET/);
    void gate;
    cs.stop();
  });
});
