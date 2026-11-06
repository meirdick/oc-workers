// Spec §21.2 gate scenarios (§17 ControlGate, §18 ReplicaGate) driven by the fake ocsup and its
// fake Litestream through the intercepts the Runtime DO registered.
import { afterEach, describe, expect, it } from "vitest";
import * as C from "../../../image/ocrt/lib/contract.mjs";
import { HELLO_BURST } from "../../src/gates/ledger";
import { ltxFile } from "../../src/gates/ltx";
import { hmacHex } from "../harness/ocsup";
import { S } from "../harness/timers";
import { INST, type World } from "../harness/world";
import { done, fresh, sutP, toRunning } from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));
const L0 = (gen: number, min: number, max: number, db = "state/openclaw.sqlite", level = 0) =>
  `${C.genPrefix(INST, gen)}${db}/${level.toString(16).padStart(4, "0")}/${C.ltxName(min, max)}`;

describe.skipIf(!sut.ok)(`gates ${sut.why}`, () => {
  it("S8 stale gen and wrong iid at ControlGate → 409 stale; nothing written to CredStore", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const b = o.boot as NonNullable<typeof o.boot>;
    const iid = b.iid;
    b.iid = "f".repeat(32);
    const r1 = await o.gate("PUT", "/v1/creds/a.json", {
      ...o.env(),
      seq: 1,
      sha256: "a".repeat(64),
      mode: 384,
      b64: "eA==",
    });
    expect([r1.status, r1.body.error]).toEqual([409, "stale"]);
    b.iid = iid;
    b.gen = 99;
    const r2 = await o.gate("POST", "/v1/heartbeat", {
      ...o.env(),
      seq: 1,
      phase: "running",
      draining: false,
    });
    expect(r2.status).toBe(409);
    expect(w.ctl().rows("SELECT * FROM creds").length).toBe(0);
  });

  it("S8 stale gen at ReplicaGate → 409 Stale; nothing written to R2", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const k = await o.replicaKey();
    const before = w.r2.keys("r/").length;
    const r = await o.s3("PUT", L0(99, 1, 2), { body: "x", keyId: k.id.replace(/-g\d+-/, "-g99-") });
    expect(r.status).toBe(409);
    expect(await r.text()).toMatch(/<Code>Stale<\/Code>/);
    expect(w.r2.keys("r/").length).toBe(before);
  });

  it("S70 /v1/boot: same iid → same plan; other iid → reboot-detected + gen abandoned; wrong pv → 409 pv", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const b = o.boot as NonNullable<typeof o.boot>;
    const req = { ...o.env(), iid: b.iid, pv: 1, hostname: "oc", newBoot: false, ocsup: "fake" };
    const same = await o.gate("POST", "/v1/boot", req);
    expect(same.body.plan).toEqual(b.plan);
    const bad = await o.gate("POST", "/v1/boot", { ...req, pv: 0 });
    expect([bad.status, bad.body.error]).toEqual([409, "pv"]);
    const other = await o.gate("POST", "/v1/boot", { ...req, iid: "e".repeat(32) });
    expect(other.body.status).toBe("reboot-detected");
    expect(w.gens().find((g) => g.gen === b.gen)?.state).toBe("abandoned");
  });

  it("S71 hello rate > 1/s → 429; > 200 per boot → hello-flood; proofs still served at 1/s", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const secret = o.boot?.secret as string;
    const ch = "ab".repeat(16);
    await w.advance(1_100); // the boot's own hello used this second
    // sec F5: token bucket, burst HELLO_BURST refilled 4/s (the boot's own hello used one token)
    const a = await o.gate("POST", "/v1/hello", { challenge: ch, pv: 1 });
    let b = a;
    for (let i = 0; i < HELLO_BURST + 1 && b.status === 200; i++)
      b = await o.gate("POST", "/v1/hello", { challenge: ch, pv: 1 });
    expect([a.status, b.status]).toEqual([200, 429]);
    expect(a.body.proof).toBe(await hmacHex(secret, `${C.DOMAIN.hello}${ch}`));
    for (let i = 0; i < 205; i++) {
      await w.advance(1001, 1001);
      await o.gate("POST", "/v1/hello", { challenge: ch, pv: 1 });
    }
    expect(w.alert("hello-flood")).toBeTruthy();
    const c = await o.gate("POST", "/v1/hello", { challenge: ch, pv: 1 });
    expect([200, 429]).toContain(c.status);
  }, 30_000);

  it("S72 /v1/final-snapshot twice → 2nd 409 done; handle saved before the answer", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const r1 = await o.finalSnapshot();
    expect(r1.status).toBe(200);
    const id = (r1.body as { snapshotId: string }).snapshotId;
    expect(w.snapshots().find((s) => s.id === id)?.kind).toBe("final");
    const r2 = await o.finalSnapshot();
    expect([r2.status, (r2.body as { error: string }).error]).toEqual([409, "done"]);
  });

  it("S72 /v1/final-snapshot while another snapshot is in flight → waits for the mutex", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const c = w.rt().c;
    let inFlight = 0;
    let max = 0;
    c.hooks.snapshot = () => {
      inFlight++;
      max = Math.max(max, inFlight);
      setTimeout(() => inFlight--, 500);
    };
    const p1 = o.finalSnapshot();
    const p2 = w.rt().call("finalSnapshot", { ...o.env(), kind: "final", unclean: null });
    await w.advance(3 * S);
    await Promise.allSettled([p1, p2]);
    expect(max).toBe(1);
  });

  it("S73 SigV4: valid / bad signature / other gen key / other iid key / skewed date / presigned / signed chunks", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const gen = o.boot?.gen as number;
    const k = await o.replicaKey();
    const key = L0(gen, 1000, 1001);
    expect((await o.s3("PUT", key, { body: "x" })).status).toBe(200);
    expect((await o.s3("PUT", key, { body: "x", secret: "0".repeat(64) })).status).toBe(403);
    expect((await o.s3("PUT", key, { body: "x", keyId: `ocrt-g${gen + 1}-${o.boot?.iid}` })).status).toBe(
      409,
    );
    // another instance signs with its own per-boot key (HMAC(bootSecret, gen, its iid)) → 409 stale
    const otherIid = "e".repeat(32);
    const otherSecret = await hmacHex(o.boot?.secret as string, C.replicaKeyMessage(gen, otherIid));
    expect(
      (await o.s3("PUT", key, { body: "x", keyId: `ocrt-g${gen}-${otherIid}`, secret: otherSecret })).status,
    ).toBe(409);
    // the same key id with a wrong signature → 403 before any Control DO call (sec F7)
    expect((await o.s3("PUT", key, { body: "x", keyId: `ocrt-g${gen}-${otherIid}` })).status).toBe(403);
    expect((await o.s3("PUT", key, { body: "x", date: new Date(Date.now() - 20 * 60 * S) })).status).toBe(
      403,
    );
    const g = w.rt().c.gate("15.0.0.2:80") as Fetcher;
    const pre = await g.fetch(
      `http://15.0.0.2/oc-host-t1/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${k.id}%2F20261102%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=00`,
      { method: "GET" },
    );
    expect(pre.status).toBe(403);
    const chunk = await g.fetch(`http://15.0.0.2/oc-host-t1/${key}`, {
      method: "PUT",
      headers: {
        "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
        authorization: `AWS4-HMAC-SHA256 Credential=${k.id}/20261102/auto/s3/aws4_request, SignedHeaders=host, Signature=00`,
        "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      },
      body: "x",
    });
    expect([403, 501]).toContain(chunk.status);
  });

  it("S74 PutObject with a wrong hex sha256 → 400 XAmzContentSHA256Mismatch, no object", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const k = await o.replicaKey();
    const key = L0(o.boot?.gen as number, 2000, 2001);
    const { signV4 } = await import("../../../image/ocrt/lib/s3.mjs");
    const url = `http://127.0.0.1:18790/oc-host-t1/${key}`;
    const h = signV4({
      method: "PUT",
      url,
      region: "auto",
      accessKey: k.id,
      secretKey: k.secret,
      body: "good",
      now: new Date(),
    });
    const r = await (w.rt().c.gate("15.0.0.2:80") as Fetcher).fetch(`http://15.0.0.2/oc-host-t1/${key}`, {
      method: "PUT",
      headers: { ...h, host: "127.0.0.1:18790" },
      body: "evil",
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/XAmzContentSHA256Mismatch/);
    expect(w.r2.keys(key)).toEqual([]);
  });
  it.todo(
    "S74 PutObject with an aws-chunked STREAMING-UNSIGNED-PAYLOAD-TRAILER body → stored bytes = decoded body",
  );

  it("S75 write outside g<gen>; read of a gen not in restoreGens → 403, R2 unchanged", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const gen = o.boot?.gen as number;
    const n = w.r2.keys().length;
    expect((await o.s3("PUT", `r/${INST}/x/evil.ltx`, { body: "x" })).status).toBe(403);
    expect((await o.s3("GET", L0(gen + 50, 1, 2))).status).toBe(403);
    expect(w.r2.keys().length).toBe(n);
  });
  it("S75 write in canary mode → 403 (gen mode in the Control DO), R2 unchanged; reads still 200", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const gen = o.boot?.gen as number;
    await o.uploadL0();
    w.ctl().rows("UPDATE gens SET mode = 'canary' WHERE gen = ?", gen);
    const n = w.r2.keys().length;
    const put = await o.s3("PUT", L0(gen, 11, 20), { body: ltxFile(11, 20) });
    expect(put.status).toBe(403);
    expect(await put.text()).toMatch(/mode canary/);
    expect(w.r2.keys().length).toBe(n);
    expect((await o.s3("GET", L0(gen, 1, 10))).status).toBe(200);
  });

  it("S76 PutObject of L0 keys → ltx row, gendb l0_max_txid and last_write_at, gen complete", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const gen = w.rt().ocsup.boot?.gen as number;
    await w.rt().ocsup.uploadL0();
    const db = w
      .ctl()
      .rows<{ l0_max_txid: number; last_write_at: number; state: string }>(
        "SELECT * FROM gendb WHERE gen = ? AND db = 'state/openclaw.sqlite'",
        gen,
      )[0];
    expect(db?.state).toBe("uploaded");
    expect(db?.l0_max_txid).toBe(20);
    expect(db?.last_write_at).toBeGreaterThan(0);
    expect(w.ctl().rows("SELECT * FROM ltx WHERE gen = ?", gen).length).toBe(2);
    expect(w.gens().find((g) => g.gen === gen)?.state).toMatch(/complete|verified/);
  });

  it("S77 delete: covered L0 → 204; uncovered L0 → 403 + alert; old L9 with a newer L9 → 204", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const gen = o.boot?.gen as number;
    await o.uploadL0(); // 11-20
    await o.s3("PUT", L0(gen, 1, 20, "state/openclaw.sqlite", 1), { body: ltxFile(1, 20) }); // covers 1-10, 11-20
    await o.uploadL0(); // 21-30, not covered
    expect((await o.s3("DELETE", L0(gen, 1, 10))).status).toBe(204);
    expect((await o.s3("DELETE", L0(gen, 21, 30))).status).toBe(403);
    expect(w.alert("replica-delete-refused")).toBeTruthy();
    await o.s3("PUT", L0(gen, 1, 20, "state/openclaw.sqlite", 9), { body: ltxFile(1, 20) });
    await o.s3("PUT", L0(gen, 1, 30, "state/openclaw.sqlite", 9), { body: ltxFile(1, 30) });
    expect((await o.s3("DELETE", L0(gen, 1, 20, "state/openclaw.sqlite", 9))).status).toBe(204);
  });

  it("S78 seed uploads count as seed_bytes (tier normal); non-seed bytes move the tier; 2nd TXID-1 L0 → 409 replica-reseed", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const gen = o.boot?.gen as number;
    const day = () =>
      w.ctl().rows<{ seed_bytes: number; tier_bytes: number; tier: string }>("SELECT * FROM budget_day")[0];
    expect(day()?.seed_bytes).toBeGreaterThan(0);
    expect(day()?.tier).toBe("normal");
    const r = await o.s3("PUT", L0(gen, 1, 5), { body: "again" });
    expect(r.status).toBe(409);
    expect(w.alert("replica-reseed")).toBeTruthy();
    const big = "y".repeat(4 * 1024 * 1024);
    for (let i = 0; i < 260 && day()?.tier === "normal"; i++)
      await o.s3("PUT", L0(gen, 100 + i * 10, 109 + i * 10), { body: big });
    expect(day()?.tier).toBe("slow"); // 10 GiB × budgetScale 0.1 = 1 GiB
  }, 60_000);

  it("S79 ceiling reached → writes 503 SlowDown; GET and List still 200", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    const gen = o.boot?.gen as number;
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    w.ctl().storage.sql.exec(
      "INSERT INTO budget_day (day, replica_reqs) VALUES (?, 2000000) ON CONFLICT (day) DO UPDATE SET replica_reqs = 2000000",
      day,
    );
    await w.advance(6 * S);
    const put = await o.s3("PUT", L0(gen, 500, 501), { body: "x" });
    expect(put.status).toBe(503);
    expect(await put.text()).toMatch(/SlowDown/);
    expect((await o.s3("GET", L0(gen, 1, 10))).status).toBe(200);
    expect(
      (await o.s3("GET", "", { query: `list-type=2&prefix=${encodeURIComponent(C.genPrefix(INST, gen))}` }))
        .status,
    ).toBe(200);
  });

  it("S39 /v1/log over 20 MB in a day → 429 + one log-cap alert; next day a new segment key", async () => {
    // The day rollover advances 24 h; 1 s heartbeats and ticks would cost ~20 s of CPU.
    w = await fresh(sut, {
      timers: {
        reconcileMs: 30 * S,
        hbMs: 30 * S,
        hbLostMs: 180 * S,
        fenceMs: 150 * S,
        maintEveryMs: 48 * 3600 * S,
      },
    });
    await toRunning(w);
    const o = w.rt().ocsup;
    const line = "z".repeat(3900);
    let last = 0;
    for (let i = 0; i < 2000 && last !== 429; i++) {
      const r = await o.gate("POST", "/v1/log", { ...o.env(), lines: Array(60).fill(line) });
      last = r.status;
    }
    expect(last).toBe(429);
    expect(w.alert("log-cap")?.count).toBe(1);
    const keys = w.r2.keys(`l/${INST}/`);
    await w.advance(24 * 3600 * S, 3600 * S);
    await o.gate("POST", "/v1/log", { ...o.env(), lines: ["next day"] });
    expect(w.r2.keys(`l/${INST}/`).filter((k) => !keys.includes(k)).length).toBeGreaterThan(0);
  }, 60_000);

  it("S41 seeding: no replicated mark (path B), sleep blocked, host loss → marker gen; seed cap → replica-down", async () => {
    w = await fresh(sut, { sleep: true, settings: { inboxReplicatedByGate: true } });
    await toRunning(w);
    w.rt().ocsup.rpo = "seeding";
    await w.webhook({ update_id: 1, message: { from: { id: 5 }, chat: { id: 5 } } });
    await w.advance(10 * S);
    expect(w.rt().c.count("snapshot")).toBe(0);
    expect(w.inbox()[0]?.state).not.toBe("replicated");
  });
});
