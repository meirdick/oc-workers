import assert from "node:assert/strict";
import { test } from "node:test";
import * as C from "../lib/contract.mjs";

const plan = (sqlite, extra = {}) => ({
  v: 1,
  mode: "prod",
  inst: "t1",
  epoch: 1,
  gen: 5,
  rootfs: { kind: "snapshot", snapshotId: "s1" },
  sqlite,
  dbs: [{ db: "state/openclaw.sqlite", lastTxid: 9, bytes: 100, state: "uploaded" }],
  runDoctor: false,
  lockMode: "auto",
  ...extra,
});

test("every sqlite plan kind validates", () => {
  const kinds = [
    { kind: "fresh" },
    { kind: "marker", markerId: "m1", snapshotId: "s1", gen: 4, txid: { "state/openclaw.sqlite": 9 } },
    { kind: "gen", gen: 4 },
    { kind: "gen", gen: 4, ts: "2026-10-31T00:00:00Z" },
    { kind: "archive", archiveId: "a1" },
    { kind: "snapshot" },
    { kind: "restore-blocked", reason: "restore-blocked:schema" },
  ];
  assert.deepEqual(
    kinds.map((k) => k.kind),
    [...new Set(C.SQLITE_KINDS)].flatMap((k) => (k === "gen" ? ["gen", "gen"] : [k])),
  );
  for (const k of kinds) assert.deepEqual(C.validate(C.BootRes, { status: "ok", plan: plan(k) }), [], k.kind);
});

test("bad plans are refused", () => {
  assert.ok(C.validate(C.BootPlan, plan({ kind: "marker" })).length > 0);
  assert.ok(C.validate(C.BootPlan, plan({ kind: "nope" })).length > 0);
  assert.ok(C.validate(C.BootPlan, plan({ kind: "gen", gen: 1 }, { mode: "dev" })).length > 0);
  assert.ok(
    C.validate(C.BootPlan, plan({ kind: "gen", gen: 1 }, { dbs: [{ db: "../etc/passwd" }] })).length > 0,
  );
  assert.deepEqual(C.validate(C.BootRes, { status: "reboot-detected" }), []);
});

test("exit code map follows plan §5.5 and amendments", () => {
  assert.equal(C.exitCodeFor("doctor-required"), 78);
  assert.equal(C.exitCodeFor("lock-blocked"), 78);
  assert.equal(C.exitCodeFor("stale"), 77);
  assert.equal(C.exitCodeFor("auto-restart"), 75);
  assert.equal(C.exitCodeFor("restore-blocked:infra"), 75);
  assert.equal(C.exitCodeFor("reap-failed:listen"), 70);
  assert.equal(C.exitCodeFor("sigterm:restore"), 0);
  assert.equal(C.exitCodeFor("whatever"), 70);
  assert.equal(C.classifyExit(75, "replica-down:infra").cls, "infra");
  assert.equal(C.classifyExit(75, "replica-down:local").esc, true);
  assert.equal(C.classifyExit(78, "doctor-required").esc, false);
  assert.equal(C.classifyExit(77, "stale").cls, "fenced");
});

test("heartbeat and ack shapes", () => {
  const hb = {
    inst: "t1",
    gen: 5,
    epoch: 1,
    bootId: "b",
    seq: 3,
    phase: "running",
    draining: false,
    litestream: {
      pid: 1,
      tier: "normal",
      dbs: [{ db: "state/openclaw.sqlite", localTxid: 10, remoteTxid: 9, lag: 1 }],
    },
  };
  assert.deepEqual(C.validate(C.HeartbeatReq, hb), []);
  assert.ok(C.validate(C.HeartbeatReq, { ...hb, phase: "zzz" }).length);
  assert.deepEqual(
    C.validate(C.HeartbeatAck, {
      ok: true,
      gen: 5,
      tier: "normal",
      replica: { gen: 5, dbs: { "state/openclaw.sqlite": { l0MaxTxid: 9 } } },
    }),
    [],
  );
});

test("routeFor matches exact before param routes", () => {
  assert.equal(C.routeFor("GET", "/v1/creds/manifest").path, "/v1/creds/manifest");
  assert.equal(C.routeFor("GET", "/v1/creds/whatsapp/creds.json").path, "/v1/creds/:path");
  assert.equal(C.routeFor("PUT", "/v1/config/proposal").path, "/v1/config/proposal");
  assert.equal(C.routeFor("POST", "/v1/nope"), null);
});

test("LTX keys, S3 ops and replica access", () => {
  const k = `r/t1/g5/state/openclaw.sqlite/0000/${"0".repeat(15)}1-${"0".repeat(14)}2a.ltx`;
  assert.deepEqual(C.parseLtxKey(k), {
    inst: "t1",
    gen: 5,
    db: "state/openclaw.sqlite",
    level: 0,
    minTxid: 1,
    maxTxid: 42,
  });
  assert.equal(C.ltxName(1, 42), `${"0".repeat(15)}1-${"0".repeat(14)}2a.ltx`);
  assert.equal(C.parseLtxKey("r/t1/g5/x.db"), null);
  const sp = (s) => new URLSearchParams(s);
  assert.equal(C.s3OpOf("GET", sp("list-type=2&prefix=r/")), "ListObjectsV2");
  assert.equal(C.s3OpOf("PUT", sp("partNumber=1&uploadId=u")), "UploadPart");
  assert.equal(C.s3OpOf("POST", sp("uploads=")), "CreateMultipartUpload");
  assert.equal(C.s3OpOf("POST", sp("delete=")), "DeleteObjects");
  const props = { inst: "t1", gen: 5, restoreGens: [4], mode: "prod" };
  assert.equal(C.replicaAccess(props, "PutObject", "r/t1/g5/a").allow, true);
  assert.equal(C.replicaAccess(props, "PutObject", "r/t1/g4/a").allow, false);
  assert.equal(C.replicaAccess(props, "GetObject", "r/t1/g4/a").allow, true);
  assert.equal(C.replicaAccess(props, "GetObject", "r/t1/g3/a").allow, false);
  assert.equal(C.replicaAccess(props, "ListObjectsV2", null, "r/t1/g4/").allow, true);
  assert.equal(C.replicaAccess({ ...props, mode: "canary" }, "PutObject", "r/t1/g5/a").allow, false);
});

test("seed class (amend §1.6 S1, S2)", () => {
  const p = (level, min) => ({ level, minTxid: min, maxTxid: 9 });
  assert.equal(C.seedClass(p(0, 1), 100, { l0Seen: false }), "seed");
  assert.equal(C.seedClass(p(0, 1), 100, { l0Seen: true }), "reseed");
  assert.equal(C.seedClass(p(9, 1), 100, {}), "seed");
  assert.equal(C.seedClass(p(1, 1), 100, { l0SeedBytes: 100, compactSeedBytes: 0 }), "seed");
  assert.equal(C.seedClass(p(1, 1), 100, { l0SeedBytes: 100, compactSeedBytes: 100 }), "other");
  assert.equal(C.seedClass(p(0, 5), 100, { l0Seen: true }), "other");
});

test("ctl request shape", () => {
  assert.deepEqual(C.validate(C.CtlReq, { op: "sleep-flush", opId: "op1" }), []);
  assert.ok(C.validate(C.CtlReq, { op: "rm-rf" }).length);
  assert.equal(C.replicaAccessKeyId(5, "ab"), "ocrt-g5-ab");
  assert.equal(C.replicaKeyMessage(5, "ab"), "oc-replica\x005\x00ab");
});
