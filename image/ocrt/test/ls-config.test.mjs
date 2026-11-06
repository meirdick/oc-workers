import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dbId, isManagedRel, metaPathFor, renderConfig } from "../lib/ls-config.mjs";

const S3 = {
  endpoint: "http://127.0.0.1:18790",
  bucket: "oc-host-x",
  region: "auto",
  accessKey: "ocrt-g7-ab",
  secretKey: "s",
};

describe("ls-config", () => {
  it("dbId is stable, path-safe and distinct per agent", () => {
    const a = dbId("agents/main/agent/openclaw-agent.sqlite");
    const b = dbId("agents/ma_in/agent/openclaw-agent.sqlite");
    assert.match(a, /^[A-Za-z0-9._-]+$/);
    assert.notEqual(a, b);
    assert.equal(a, dbId("agents/main/agent/openclaw-agent.sqlite"));
  });
  it("meta path is per gen (F1.1)", () => {
    const rel = "state/openclaw.sqlite";
    assert.notEqual(metaPathFor(5, rel), metaPathFor(6, rel));
    assert.ok(metaPathFor(6, rel).startsWith("/var/lib/ocrt/ls-meta/g6/"));
  });
  it("managed set is explicit", () => {
    assert.ok(isManagedRel("state/openclaw.sqlite"));
    assert.ok(isManagedRel("agents/a/agent/openclaw-agent.sqlite"));
    assert.ok(!isManagedRel("state/openclaw-quarantine.sqlite"));
    assert.ok(!isManagedRel("plugins/workboard/workboard.sqlite"));
    assert.ok(!isManagedRel("agents/a/b/agent/openclaw-agent.sqlite"));
  });
  it("renders meta-path, auto-recover false, gen prefix, lean levels", () => {
    const y = renderConfig({
      state: "/home/node/.openclaw",
      gen: 7,
      inst: "x",
      dbs: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
      s3: S3,
    });
    assert.equal((y.match(/meta-path: "\/var\/lib\/ocrt\/ls-meta\/g7\//g) || []).length, 2);
    assert.equal((y.match(/auto-recover: false/g) || []).length, 2);
    assert.match(y, /path: "r\/x\/g7\/state\/openclaw.sqlite"/);
    assert.match(y, /l0-retention-check-interval: 5m/);
    assert.match(y, /levels:\n {2}- interval: 5m\n/);
    assert.doesNotMatch(y, /if-replica-exists/);
    assert.doesNotMatch(y, /-litestream/);
  });
  it("default preset leaves Litestream defaults", () => {
    const y = renderConfig({
      state: "/s",
      gen: 1,
      inst: "x",
      dbs: ["state/openclaw.sqlite"],
      s3: S3,
      preset: "default",
    });
    assert.doesNotMatch(y, /levels:|l0-retention/);
  });
  it("refuses non-managed paths and a set over 32", () => {
    assert.throws(() => renderConfig({ state: "/s", gen: 1, inst: "x", dbs: ["../etc/x.sqlite"], s3: S3 }));
    const many = Array.from({ length: 33 }, (_, i) => `agents/a${i}/agent/openclaw-agent.sqlite`);
    assert.throws(() => renderConfig({ state: "/s", gen: 1, inst: "x", dbs: many, s3: S3 }), /cap/);
  });
});
