// Replica proxy hello (1.2.3): each proof sends the hello MAC, so the gate does not count it toward hello-flood.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { REPLICA_HELLO_PATH, REPLICA_PROOF_MAX_AGE_MS } from "../lib/contract.mjs";
import { proveReplica, startReplicaProxy } from "../lib/replica-proxy.mjs";

const SECRET = "boot-secret";
// Written out here, not taken from the lib: the worker checks this exact message (worker/src/gates/crypto.ts).
const mac = (plane, ch) => createHmac("sha256", SECRET).update(`oc-hello-mac\0${plane}\0${ch}`).digest("hex");
const proof = (ch) => createHmac("sha256", SECRET).update(`oc-rhello\0${ch}`).digest("hex");

function fakeGate({ status = 200, good = true } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, headers: init.headers, body });
    return new Response(JSON.stringify({ proof: good ? proof(body.challenge) : "0".repeat(64) }), { status });
  };
  return { fetch, calls };
}

test("proveReplica sends the replica hello MAC and checks the proof", async () => {
  const g = fakeGate();
  assert.deepEqual(await proveReplica("http://g", SECRET, g.fetch), { ok: true });
  assert.equal(g.calls.length, 1);
  const c = g.calls[0];
  assert.equal(c.path, REPLICA_HELLO_PATH);
  assert.equal(c.headers["x-ocrt-hello-mac"], mac("replica", c.body.challenge));
  assert.notEqual(c.headers["x-ocrt-hello-mac"], mac("control", c.body.challenge));
  assert.equal(c.headers["x-ocrt-secret"], undefined);
  const bad = await proveReplica("http://g", SECRET, fakeGate({ good: false }).fetch);
  assert.equal(bad.ok, false);
  const rate = await proveReplica("http://g", SECRET, fakeGate({ status: 429 }).fetch);
  assert.equal(rate.ok, false);
});

test("proxy proves again only when the proof is older than 5 s, each time with a fresh MAC", async () => {
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const g = fakeGate();
  let t = 1_000_000;
  const p = startReplicaProxy({
    target: `http://127.0.0.1:${up.address().port}`,
    secret: SECRET,
    port: 0,
    now: () => t,
    fetch: g.fetch,
  });
  await new Promise((r) => p.server.once("listening", r));
  const get = () =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: p.server.address().port, path: "/b/k", agent: false }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        })
        .on("error", reject);
    });
  try {
    assert.equal(await get(), 200);
    t += REPLICA_PROOF_MAX_AGE_MS - 1;
    assert.equal(await get(), 200);
    assert.equal(g.calls.length, 1);
    t += 2;
    assert.equal(await get(), 200);
    assert.equal(g.calls.length, 2);
    assert.notEqual(g.calls[0].body.challenge, g.calls[1].body.challenge);
    for (const c of g.calls) assert.equal(c.headers["x-ocrt-hello-mac"], mac("replica", c.body.challenge));
    assert.equal(p.state.proofs, 2);
    assert.equal(p.state.forwarded, 3);
  } finally {
    p.close();
    up.close();
  }
});
