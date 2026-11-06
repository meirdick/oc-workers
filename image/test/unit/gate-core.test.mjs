import assert from "node:assert/strict";
import { test } from "node:test";
import * as C from "../../ocrt/lib/contract.mjs";
import { signV4 } from "../../ocrt/lib/s3.mjs";
import {
  control,
  decodeAwsChunked,
  hmacHex,
  lagOf,
  newState,
  replicaHello,
  replicaKeyId,
  replicaPost,
  replicaPre,
  replicaSecret,
  requestWake,
  setFaults,
  verifySigV4,
} from "../fakes/gate-core.mjs";

const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const IID = "a".repeat(32);
const IID2 = "b".repeat(32);
const st = () => newState({ inst: "m1", bootSecret: "bs", now: () => 1000 });
const H = (iid = IID) => ({ "x-ocrt-secret": "bs", "x-ocrt-iid": iid });
const B = (S, method, path, body, headers = H()) => control(S, { method, path, headers, body });
const envl = (S, extra = {}) => ({ inst: "m1", epoch: 1, gen: S.gen, bootId: "b1", ...extra });
const ltxKey = (g, lvl, a, b) => `r/m1/g${g}/state/openclaw.sqlite/${lvl}/${C.ltxName(a, b)}`;
const sp = (q = "") => new URLSearchParams(q);

test("decodeAwsChunked joins signed and unsigned chunks, ignores trailers", () => {
  const raw = Buffer.from(
    "5;chunk-signature=ab\r\nhello\r\n6\r\n world\r\n0\r\nx-amz-checksum-crc32:AAAA\r\n\r\n",
  );
  assert.equal(decodeAwsChunked(raw).toString(), "hello world");
  assert.throws(() => decodeAwsChunked(Buffer.from("a\r\nshort")));
});

test("verifySigV4 accepts a request signed by lib/s3.mjs and refuses a wrong secret", () => {
  const url = `http://15.0.0.2/oc-host-m1/${ltxKey(3, "0000", 1, 1)}`;
  const body = "ltx-bytes";
  const h = signV4({ method: "PUT", url, region: "auto", accessKey: "ocrt-g3-i1", secretKey: "sek", body });
  const headers = { ...lower(h), host: "15.0.0.2" };
  const rawPath = new URL(url).pathname;
  assert.equal(verifySigV4({ method: "PUT", rawPath, headers, body, secretFor: () => "sek" }).ok, true);
  assert.equal(verifySigV4({ method: "PUT", rawPath, headers, body, secretFor: () => "other" }).ok, false);
  assert.equal(
    verifySigV4({ method: "PUT", rawPath, headers, body: "tampered", secretFor: () => "sek" }).why,
    "payload-hash",
  );
});

test("hello proofs use the contract domains", () => {
  const S = st();
  const ch = "0".repeat(32);
  const h = B(S, "POST", "/v1/hello", { challenge: ch, pv: C.PV }, {});
  assert.equal(h.status, 200);
  assert.equal(h.body.proof, hmacHex("bs", `oc-hello\0${ch}`));
  assert.deepEqual(h.body.pv, [C.PV]);
  assert.equal(S.records.at(-1).contract, "ok");
  assert.equal(replicaHello(S, { challenge: ch }).body.proof, hmacHex("bs", `oc-rhello\0${ch}`));
});

test("boot: plan validates against BootPlan; same iid repeats; new iid -> reboot-detected; bad secret 401", () => {
  const S = st();
  S.gen = 3;
  assert.equal(B(S, "POST", "/v1/boot", envl(S, { iid: IID, pv: 1 }), { "x-ocrt-secret": "no" }).status, 401);
  S.plans.push({ sqlite: { kind: "gen", gen: 2 }, restoreGens: [2] });
  const b1 = B(S, "POST", "/v1/boot", envl(S, { iid: IID, pv: 1 }));
  assert.equal(b1.status, 200);
  assert.equal(b1.body.status, "ok");
  assert.deepEqual(C.validate(C.BootRes, b1.body), []);
  assert.deepEqual(b1.body.plan.sqlite, { kind: "gen", gen: 2 });
  assert.deepEqual(S.restoreGens, [2]);
  assert.deepEqual(B(S, "POST", "/v1/boot", envl(S, { iid: IID, pv: 1 })).body, b1.body);
  const b2 = B(S, "POST", "/v1/boot", envl(S, { iid: IID2, pv: 1 }));
  assert.deepEqual(b2.body, { status: "reboot-detected" });
});

test("heartbeat: ack validates; faults 409, status, drop, stop; stale gen and wrong iid -> 409", () => {
  const S = st();
  S.gen = 5;
  B(S, "POST", "/v1/boot", envl(S, { iid: IID, pv: 1 }));
  const hb = envl(S, { seq: 1, phase: "running", draining: false });
  const a = B(S, "POST", "/v1/heartbeat", hb);
  assert.equal(a.status, 200);
  assert.deepEqual(C.validate(C.HeartbeatAck, a.body), []);
  assert.equal(S.records.at(-1).contract, "ok");
  assert.equal(B(S, "POST", "/v1/heartbeat", { ...hb, gen: 4 }).status, 409);
  assert.equal(B(S, "POST", "/v1/heartbeat", hb, H(IID2)).status, 409);
  setFaults(S, { hb409: true });
  assert.equal(B(S, "POST", "/v1/heartbeat", hb).status, 409);
  setFaults(S, { clear: true, hbStop: true });
  assert.equal(B(S, "POST", "/v1/heartbeat", hb).body.stop, true);
  setFaults(S, { clear: true, hbDrop: true });
  assert.equal(B(S, "POST", "/v1/heartbeat", hb).drop, true);
});

test("invalid body is recorded; strict answers 400", () => {
  const S = st();
  S.gen = 1;
  B(S, "POST", "/v1/event", envl(S, { kind: "not-a-kind", ts: 1 }));
  assert.equal(S.records.at(-1).contract, "invalid");
  setFaults(S, { strict: true });
  assert.equal(B(S, "POST", "/v1/event", envl(S, { kind: "not-a-kind", ts: 1 })).status, 400);
  assert.equal(B(S, "POST", "/v1/nope", {}).status, 404);
});

test("final-snapshot stores the handle before the answer; refuse fault stores none", () => {
  const S = st();
  S.gen = 1;
  const r = B(S, "POST", "/v1/final-snapshot", envl(S, { kind: "final" }));
  assert.equal(r.status, 200);
  assert.deepEqual(C.validate(C.FinalSnapshotRes, r.body), []);
  assert.equal(S.finalSnapshots.length, 1);
  setFaults(S, { refuseFinalSnapshot: true });
  assert.equal(B(S, "POST", "/v1/final-snapshot", envl(S, { kind: "final" })).status, 503);
  assert.equal(S.finalSnapshots.length, 1);
});

test("creds: (gen, seq) newer only; GET and manifest match the contract", () => {
  const S = st();
  S.gen = 2;
  const sha = "1".repeat(64);
  const put = (seq, path = "credentials%2Fa.json") =>
    B(S, "PUT", `/v1/creds/${path}`, envl(S, { seq, sha256: sha, mode: 0o600, b64: "e30=" }));
  assert.equal(put(1).status, 200);
  assert.equal(put(1).status, 409);
  assert.equal(put(2).status, 200);
  assert.equal(B(S, "DELETE", "/v1/creds/credentials%2Fb.json", envl(S, { seq: 1 })).status, 200);
  const m = B(S, "GET", "/v1/creds/manifest", undefined);
  assert.deepEqual(C.validate(C.CredManifest, m.body), []);
  assert.deepEqual(
    m.body.files.map((f) => [f.path, !!f.deleted]),
    [
      ["credentials/a.json", false],
      ["credentials/b.json", true],
    ],
  );
  const g = B(S, "GET", "/v1/creds/credentials%2Fa.json", undefined);
  assert.deepEqual(C.validate(C.CredGetRes, g.body), []);
  assert.equal(g.body.b64, "e30=");
});

test("replica: access by gen/mode, 501 op, level refuse, reseed guard, lag from level 0 only, seed bytes", () => {
  const S = st();
  S.gen = 4;
  S.restoreGens = [3];
  const pre = (key, method = "PUT", q = "") =>
    replicaPre(S, { method, key, searchParams: sp(q), headers: {}, body: Buffer.alloc(0) });
  assert.equal(pre(ltxKey(3, "0000", 1, 1)).status, 403, "old gen not writable");
  assert.equal(pre(ltxKey(3, "0000", 1, 1), "GET").forward, true, "restore gen readable");
  assert.equal(pre(ltxKey(2, "0000", 1, 1), "GET").status, 403);
  assert.equal(pre("r/other/g4/x").status, 403);
  assert.equal(pre("x", "PATCH").status, 501);
  assert.equal(pre("", "GET", "list-type=2&prefix=r/m1/g4/").forward, true);
  assert.equal(pre(ltxKey(4, "0000", 1, 1)).forward, true);
  replicaPost(S, { method: "PUT", op: "PutObject", key: ltxKey(4, "0009", 1, 40), status: 200, bytes: 100 });
  assert.equal(lagOf(S, 4, "state/openclaw.sqlite", 40), 40, "L9 does not count");
  replicaPost(S, { method: "PUT", op: "PutObject", key: ltxKey(4, "0000", 1, 40), status: 200, bytes: 100 });
  assert.equal(lagOf(S, 4, "state/openclaw.sqlite", 40), 0);
  replicaPost(S, { method: "PUT", op: "PutObject", key: ltxKey(4, "0000", 41, 41), status: 200, bytes: 7 });
  assert.equal(S.seedBytes, 200);
  assert.equal(S.tierBytes, 7);
  assert.equal(pre(ltxKey(4, "0000", 1, 50)).status, 409, "second TXID-1 L0 key");
  assert.equal(S.alerts.at(-1).class, "replica-reseed");
  setFaults(S, { throttle: { refuseLevel: 0, status: 503 } });
  assert.equal(pre(ltxKey(4, "0000", 42, 42)).status, 503);
  assert.equal(pre(ltxKey(4, "0001", 1, 42)).forward, true);
  setFaults(S, { clear: true, throttle: { delayMs: 50 } });
  assert.equal(pre(ltxKey(4, "0000", 43, 43)).delayMs, 50);
  setFaults(S, { clear: true, enospc: true });
  assert.equal(pre(ltxKey(4, "0000", 44, 44)).status, 507);
  S.mode = "canary";
  setFaults(S, { clear: true });
  assert.equal(pre(ltxKey(4, "0000", 45, 45)).status, 403, "no writes outside prod");
});

test("replica: sigv4Strict checks the per-boot key from the contract", () => {
  const S = st();
  S.gen = 3;
  setFaults(S, { sigv4Strict: true });
  const key = ltxKey(3, "0000", 2, 2);
  const url = `http://15.0.0.2/oc-host-m1/${key}`;
  const sign = (secretKey) => ({
    ...lower(
      signV4({ method: "PUT", url, region: "auto", accessKey: replicaKeyId(3, IID), secretKey, body: "b" }),
    ),
    host: "15.0.0.2",
  });
  const run = (headers) =>
    replicaPre(S, {
      method: "PUT",
      key,
      searchParams: sp(),
      headers,
      body: Buffer.from("b"),
      rawPath: new URL(url).pathname,
    });
  assert.equal(run(sign(replicaSecret("bs", 3, IID))).forward, true);
  assert.equal(run(sign("wrong")).status, 403);
});

test("requestWake drop fault", () => {
  const S = st();
  setFaults(S, { dropRequestWake: 1 });
  assert.equal(requestWake(S, "webhook").status, 503);
  assert.equal(requestWake(S, "webhook").status, 200);
  assert.equal(S.wakes.length, 1);
});
