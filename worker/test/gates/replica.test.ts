// ReplicaGate (spec §18; scenarios #8, #73-#79 of §21.2) against FakeR2 and the Control DO ledger.
import { describe, expect, it } from "vitest";
import { HELLO_BURST, tierOf } from "../../src/gates/ledger";
import {
  AGENT_DB,
  awsChunk,
  BUCKET,
  hmacHex,
  ltxBody,
  ltxKey,
  path,
  rid,
  SECRET,
  STATE_DB,
  sha,
  World,
} from "./harness";

const te = new TextEncoder();
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 7 + seed) & 255);

async function bound(o: ConstructorParameters<typeof World>[0] = {}) {
  const w = new World(o);
  const r = await w.boot();
  expect(r.status).toBe(200);
  return w;
}
const xmlCode = async (r: Response) => /<Code>([^<]+)<\/Code>/.exec(await r.text())?.[1];

describe("ReplicaGate hello", () => {
  it("answers the domain-separated proof, 1/s", async () => {
    const w = new World();
    const ch = rid() + rid();
    const hello = (c: string) =>
      import("../../src/gates/replica").then((m) =>
        m.handleReplicaGate(
          new Request("http://15.0.0.2/_ocrt/hello", {
            method: "POST",
            body: JSON.stringify({ challenge: c }),
          }),
          w.deps(),
        ),
      );
    const r = await hello(ch);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { proof: string }).proof).toBe(hmacHex(SECRET, `oc-rhello\0${ch}`));
    for (let i = 0; i < HELLO_BURST - 1; i++) expect((await hello(ch)).status).toBe(200); // burst (sec F5)
    expect((await hello(ch)).status).toBe(429);
    w.clock.t += 1000;
    expect((await hello(ch)).status).toBe(200);
    expect((await hello("zz")).status).toBe(400);
  });
});

describe("SigV4 at the gate (#73)", () => {
  const key = ltxKey(1, STATE_DB, 0, 1, 5);
  it("valid 200 / bad signature 403 / other gen 409 / other iid 409 / skewed 403 / presigned 403 / signed chunks 501", async () => {
    const w = await bound();
    const body = bytes(100);
    expect((await w.s3("PUT", path(key), { body })).status).toBe(200);
    const bad = await w.s3("PUT", path(key), {
      body,
      tamper: (h) => {
        h.authorization = (h.authorization as string).replace(
          /Signature=(.)/,
          (_, c: string) => `Signature=${c === "f" ? "0" : "f"}`,
        );
      },
    });
    expect([bad.status, await xmlCode(bad)]).toEqual([403, "SignatureDoesNotMatch"]);
    const og = await w.s3("PUT", path(key), { body, keyGen: 2 });
    expect([og.status, await xmlCode(og)]).toEqual([409, "Stale"]);
    const oi = await w.s3("PUT", path(key), { body, keyIid: rid() });
    expect([oi.status, await xmlCode(oi)]).toEqual([409, "Stale"]);
    const sk = await w.s3("PUT", path(key), { body, date: w.now() - 16 * 60_000 });
    expect([sk.status, await xmlCode(sk)]).toEqual([403, "RequestTimeTooSkewed"]);
    const pre = await w.s3(
      "GET",
      `${path(key)}?X-Amz-Credential=ocrt-g1-${w.iid}%2F20261031&X-Amz-Signature=00`,
      {
        unsigned: true,
      },
    );
    expect(pre.status).toBe(403);
    const sc = await w.s3("PUT", path(key), { body, payload: "STREAMING-AWS4-HMAC-SHA256-PAYLOAD" });
    expect(sc.status).toBe(501);
    const un = await w.s3("PUT", path(key), { body, unsigned: true });
    expect(un.status).toBe(403);
  });

  it("no bound iid → 403; stale gen → 409 and nothing written (#8)", async () => {
    const w = new World();
    const k = ltxKey(1, STATE_DB, 0, 1, 1);
    const r = await w.s3("PUT", path(k), { body: bytes(10) });
    expect([r.status, await xmlCode(r)]).toEqual([403, "AccessDenied"]);
    await w.boot();
    w.addGen(2); // a newer gen of the same epoch makes g1 stale
    const s = await w.s3("PUT", path(k), { body: bytes(10) });
    expect([s.status, await xmlCode(s)]).toEqual([409, "Stale"]);
    expect(w.r2.keys("r/")).toEqual([]);
    expect(w.sql("SELECT * FROM ltx")).toEqual([]);
  });

  it("10+ bad signatures count per gen; above 20 → alert replica-badsig", async () => {
    const w = await bound();
    for (let i = 0; i < 21; i++)
      await w.s3("GET", path(ltxKey(1, STATE_DB, 0, 1, 1)), {
        tamper: (h) => {
          h.authorization = (h.authorization as string).replace(
            /Signature=(.)/,
            (_, c: string) => `Signature=${c === "f" ? "0" : "f"}`,
          );
        },
      });
    // sec F7: counted per isolate; one Control DO write per BADSIG_FLUSH_MS (the first at once)
    expect(w.sql("SELECT n FROM gate_badsig WHERE gen = 1")).toEqual([{ n: 1 }]);
    w.clock.t += 10_000;
    await w.s3("GET", path(ltxKey(1, STATE_DB, 0, 1, 1)), { secret: "f".repeat(64) });
    expect(w.sql("SELECT n FROM gate_badsig WHERE gen = 1")).toEqual([{ n: 22 }]);
    expect(w.sql("SELECT class FROM alerts WHERE class = 'replica-badsig'")).toHaveLength(1);
  });
});

describe("payload modes (#74)", () => {
  it("aws-chunked body is stored decoded; a wrong hex sha256 → 400 and no object", async () => {
    const w = await bound();
    const k = ltxKey(1, STATE_DB, 0, 1, 3);
    const body = bytes(20_000, 3);
    expect((await w.s3("PUT", path(k), { body, mode: "trailer" })).status).toBe(200);
    const got = await w.r2.get(k);
    expect(sha(new Uint8Array(await (got as R2ObjectBody).arrayBuffer()))).toBe(sha(body));
    expect(w.r2.objs.get(k)?.data.length).toBe(20_000);
    const k2 = ltxKey(1, STATE_DB, 0, 4, 4);
    const r = await w.s3("PUT", path(k2), { body, payload: sha("other") });
    expect([r.status, await xmlCode(r)]).toEqual([400, "XAmzContentSHA256Mismatch"]);
    expect(w.r2.objs.has(k2)).toBe(false);
    expect((await w.s3("PUT", path(k2), { body, mode: "hex" })).status).toBe(200);
    expect(awsChunk(te.encode("ab"), 1).length).toBeGreaterThan(2);
  });
});

describe("access (#75)", () => {
  it("write outside g<gen>, read of a gen not in restoreGens, write in canary → 403; R2 unchanged", async () => {
    const w = await bound({ restoreGens: [] });
    await w.r2.put(ltxKey(7, STATE_DB, 0, 1, 1), "old");
    const before = w.r2.keys();
    const out = await w.s3("PUT", path(ltxKey(2, STATE_DB, 0, 1, 1)), { body: bytes(5) });
    expect(out.status).toBe(403);
    const rd = await w.s3("GET", path(ltxKey(7, STATE_DB, 0, 1, 1)));
    expect(rd.status).toBe(403);
    const ok = await w.s3("GET", path(ltxKey(7, STATE_DB, 0, 1, 1)), { props: { restoreGens: [7] } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("old");
    const cw = await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 1)), {
      body: bytes(5),
      props: { mode: "canary" },
    });
    expect(cw.status).toBe(403);
    const ls = await w.s3("GET", `/${BUCKET}?list-type=2&prefix=${encodeURIComponent("r/t1/")}`);
    expect(ls.status).toBe(403); // list prefix must be inside a readable gen
    expect(w.r2.keys()).toEqual(before);
    const nb = await w.s3("GET", `/other-bucket/${ltxKey(1, STATE_DB, 0, 1, 1)}`);
    expect(nb.status).toBe(404);
  });
});

describe("records (#76) and lastWriteAt per DB and level", () => {
  it("PutObject and multipart complete of L0 keys record ltx, gendb, gendb_level; gen complete with the boot set", async () => {
    const w = await bound();
    // boot set from ocsup's replica-set event (or beginBoot rows)
    w.ledger.event(1, { kind: "replica-set", detail: { dbs: [STATE_DB, AGENT_DB] } });
    const k1 = ltxKey(1, STATE_DB, 0, 1, 9);
    expect((await w.s3("PUT", path(k1), { body: ltxBody(1, 9, 1000) })).status).toBe(200);
    expect(w.sql("SELECT state FROM gens WHERE gen = 1")).toEqual([{ state: "booting" }]);
    // multipart for the agent DB L0 seed
    const k2 = ltxKey(1, AGENT_DB, 0, 1, 4);
    const cr = await w.s3("POST", `${path(k2)}?uploads`);
    expect(cr.status).toBe(200);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await cr.text())?.[1] as string;
    const etags: string[] = [];
    for (let n = 1; n <= 2; n++) {
      const pr = await w.s3("PUT", `${path(k2)}?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`, {
        body: n === 1 ? ltxBody(1, 4, 3000) : bytes(3000, n),
      });
      expect(pr.status).toBe(200);
      etags.push(pr.headers.get("etag") as string);
    }
    w.clock.t += 5000;
    const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const cp = await w.s3("POST", `${path(k2)}?uploadId=${encodeURIComponent(uploadId)}`, {
      body: xml,
      mode: "hex",
    });
    expect(cp.status).toBe(200);
    expect(w.sql("SELECT gen, db, level, min_txid, max_txid, bytes, seed FROM ltx ORDER BY db")).toEqual([
      { gen: 1, db: AGENT_DB, level: 0, min_txid: 1, max_txid: 4, bytes: 6000, seed: 1 },
      { gen: 1, db: STATE_DB, level: 0, min_txid: 1, max_txid: 9, bytes: 1000, seed: 1 },
    ]);
    const g = w.sql<{ db: string; state: string; l0_max_txid: number; last_write_at: number }>(
      "SELECT db, state, l0_max_txid, last_write_at FROM gendb WHERE gen = 1 ORDER BY db",
    );
    expect(g.map((x) => [x.db, x.state, x.l0_max_txid])).toEqual([
      [AGENT_DB, "uploaded", 4],
      [STATE_DB, "uploaded", 9],
    ]);
    expect(g[0]?.last_write_at).toBe(w.now());
    expect(w.sql("SELECT state FROM gens WHERE gen = 1")).toEqual([{ state: "complete" }]);
    // an L1 write: per-level lastWriteAt
    w.clock.t += 1000;
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 1, 1, 9)), { body: ltxBody(1, 9, 500) });
    const lv = w.ledger.levels(1).filter((x) => x.db === STATE_DB);
    expect(lv.map((x) => [x.level, x.maxTxid, x.lastWriteAt])).toEqual([
      [0, 9, w.now() - 6000],
      [1, 9, w.now()],
    ]);
    // ack/replica state for ocsup lag (gate §4)
    const st = await w.control("GET", "/v1/replica/state", undefined, { iid: w.iid });
    expect(
      ((await st.json()) as { dbs: Record<string, { l0MaxTxid: number; seeded: boolean }> }).dbs[STATE_DB],
    ).toMatchObject({
      l0MaxTxid: 9,
      seeded: true,
    });
  });

  it("an upload to a marker's gen at or after the marker voids it (late-upload, §14)", async () => {
    const w = await bound();
    w.st.sql.exec(
      `INSERT INTO markers (id, op_id, gen, epoch, digest, snapshot_id, txid, bytes, last_write_at, state, created_at, updated_at)
       VALUES ('m1', 'op-s', 1, 1, 'd', 'snap', '{}', '{}', '{}', 'valid', ?, ?)`,
      w.now(),
      w.now(),
    );
    w.clock.t += 10;
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 10, 10)), { body: ltxBody(10, 10) });
    expect(w.sql("SELECT state, void_reason FROM markers")).toEqual([
      { state: "void", void_reason: "late-upload" },
    ]);
    // same ms as the marker, and a pending marker, are void too; another gen's marker is kept
    for (const [id, gen, state] of [
      ["m2", 1, "pending"],
      ["m3", 1, "valid"],
      ["m4", 2, "valid"],
    ] as const)
      w.st.sql.exec(
        `INSERT INTO markers (id, op_id, gen, epoch, digest, snapshot_id, txid, bytes, last_write_at, state, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'd', 'snap', '{}', '{}', '{}', ?, ?, ?)`,
        id,
        `op-${id}`,
        gen,
        state,
        w.now(),
        w.now(),
      );
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 11, 11)), { body: ltxBody(11, 11) });
    expect(w.sql("SELECT id, state FROM markers WHERE id != 'm1' ORDER BY id")).toEqual([
      { id: "m2", state: "void" },
      { id: "m3", state: "void" },
      { id: "m4", state: "valid" },
    ]);
  });

  it("reads: Range GET 206, Head 404, List with delimiter, class A/B counters", async () => {
    const w = await bound();
    const k = ltxKey(1, STATE_DB, 0, 1, 2);
    await w.s3("PUT", path(k), { body: te.encode("hello world") });
    const g = await w.s3("GET", path(k), { headers: { range: "bytes=6-" } });
    expect([g.status, await g.text(), g.headers.get("content-range")]).toEqual([
      206,
      "world",
      "bytes 6-10/11",
    ]);
    expect((await w.s3("HEAD", path(ltxKey(1, STATE_DB, 0, 3, 3)))).status).toBe(404);
    const pre = "r/t1/g1/";
    const ls = await w.s3("GET", `/${BUCKET}?list-type=2&prefix=${encodeURIComponent(pre)}&delimiter=%2F`);
    expect(ls.status).toBe(200);
    expect(await ls.text()).toContain("<Prefix>r/t1/g1/state/</Prefix>");
    const d = w.ledger.replicaDay();
    expect([d.classA, d.classB]).toEqual([2, 2]); // Put + List / Get + Head
    expect(w.sql("SELECT replica_reqs FROM budget_day")).toEqual([{ replica_reqs: 4 }]);
  });

  it("Control DO down → 503, nothing written", async () => {
    const w = await bound();
    w.ctlDown = true;
    const r = await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 1)), { body: bytes(5) });
    expect(r.status).toBe(503);
    expect(w.r2.keys("r/")).toEqual([]);
  });
});

describe("delete rule (#77, §18.5)", () => {
  it("covered L0 204 / uncovered L0 403 + alert / old L9 with a newer L9 204", async () => {
    const w = await bound();
    const l0a = ltxKey(1, STATE_DB, 0, 1, 5);
    const l0b = ltxKey(1, STATE_DB, 0, 6, 6);
    const l0c = ltxKey(1, STATE_DB, 0, 7, 7);
    const l1 = ltxKey(1, STATE_DB, 1, 1, 6);
    const l9a = ltxKey(1, STATE_DB, 9, 1, 5);
    const l9b = ltxKey(1, STATE_DB, 9, 1, 6);
    for (const [k, lo, hi] of [
      [l0a, 1, 5],
      [l0b, 6, 6],
      [l0c, 7, 7],
      [l1, 1, 6],
      [l9a, 1, 5],
      [l9b, 1, 6],
    ] as const)
      expect((await w.s3("PUT", path(k), { body: ltxBody(lo, hi) })).status).toBe(200);
    expect((await w.s3("DELETE", path(l0b))).status).toBe(204);
    const un = await w.s3("DELETE", path(l0c));
    expect(un.status).toBe(403);
    expect(w.sql("SELECT class FROM alerts WHERE class = 'replica-delete-refused'")).toHaveLength(1);
    expect((await w.s3("DELETE", path(l9a))).status).toBe(204);
    expect(w.r2.objs.has(l0b) || w.r2.objs.has(l9a)).toBe(false);
    expect(w.r2.objs.has(l0c)).toBe(true);
    // the newest L9 itself is not covered
    expect((await w.s3("DELETE", path(l9b))).status).toBe(403);
    // DeleteObjects: each key checked; outside the gen refused
    const xml = `<Delete><Quiet>false</Quiet><Object><Key>${l0a}</Key></Object><Object><Key>${l0c}</Key></Object><Object><Key>${ltxKey(2, STATE_DB, 0, 1, 1)}</Key></Object></Delete>`;
    const r = await w.s3("POST", `/${BUCKET}?delete`, { body: xml, mode: "hex" });
    const t = await r.text();
    expect(r.status).toBe(200);
    expect(t).toContain(`<Deleted><Key>${l0a}</Key></Deleted>`);
    expect(t.match(/<Error>/g)).toHaveLength(2);
    expect(w.r2.objs.has(l0a)).toBe(false);
    expect(w.sql("SELECT replica_deletes FROM budget_day")).toEqual([{ replica_deletes: 3 }]);
    expect(w.sql("SELECT COUNT(*) AS n FROM ltx")).toEqual([{ n: 3 }]);
  });
});

describe("budget tiers and seed counters (#78, #79; amend §1.6)", () => {
  it("20 seed sets of 100 MB stay normal; 1.2 GiB non-seed → slow (÷10 limits); second TXID-1 L0 → 409 + replica-reseed", async () => {
    const w = await bound({ scale: 0.1 });
    const MB100 = 100_000_000;
    for (let g = 2; g <= 21; g++) {
      w.addGen(g, 1, "prod", "booting");
      w.ledger.recordUpload({ key: ltxKey(g, STATE_DB, 0, 1, 100), bytes: MB100 });
      w.ledger.recordUpload({ key: ltxKey(g, STATE_DB, 9, 1, 100), bytes: MB100 });
      w.ledger.recordUpload({ key: ltxKey(g, STATE_DB, 1, 1, 100), bytes: MB100 });
    }
    let b = w.ledger.budget();
    expect(b.seedBytes).toBe(60 * MB100);
    expect(b.tierBytes).toBe(0);
    expect(b.tier).toBe("normal");
    // L1 bytes above 1.5 × the L0 seed are not seed
    w.ledger.recordUpload({ key: ltxKey(21, STATE_DB, 1, 101, 200), bytes: 60 * 1_000_000 });
    expect(w.ledger.budget().tierBytes).toBe(60_000_000);
    for (let i = 0; i < 12; i++)
      w.ledger.recordUpload({ key: ltxKey(21, STATE_DB, 0, 201 + i, 201 + i), bytes: 0.1 * 1024 ** 3 });
    b = w.ledger.budget();
    expect(b.tier).toBe("slow");
    expect(w.sql("SELECT class FROM alerts WHERE class = 'replica-soft'")).toHaveLength(1);
    // reseed through the gate (current gen is 21 now: use a world whose gen 1 is current)
    const v = await bound({ scale: 0.1 });
    expect((await v.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 5)), { body: ltxBody(1, 5) })).status).toBe(200);
    expect((await v.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 5)), { body: ltxBody(1, 5) })).status).toBe(200); // retry of the same key
    const rs = await v.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 8)), { body: ltxBody(1, 8) });
    expect([rs.status, await xmlCode(rs)]).toEqual([409, "Reseed"]);
    expect(v.sql("SELECT class FROM alerts WHERE class = 'replica-reseed'")).toHaveLength(1);
    expect(v.r2.objs.has(ltxKey(1, STATE_DB, 0, 1, 8))).toBe(false);
  });

  it("tier from requests and bytes; hard → slower + replica-hard", () => {
    expect(tierOf(149_999, 0).tier).toBe("normal");
    expect(tierOf(150_000, 0).tier).toBe("slow");
    expect(tierOf(0, 30 * 1024 ** 3).tier).toBe("slower");
    expect(tierOf(1_000_000, 0).ceiling).toBe(true);
    expect(tierOf(0, 6 * 1024 ** 3, 0.1).ceiling).toBe(true);
  });

  it("ceiling: writes 503 SlowDown, GET and List still 200 (#79)", async () => {
    const w = await bound();
    const k = ltxKey(1, STATE_DB, 0, 1, 1);
    await w.s3("PUT", path(k), { body: bytes(5) });
    w.st.sql.exec("UPDATE budget_day SET replica_reqs = 1000000");
    const p = await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 2, 2)), { body: bytes(5) });
    expect([p.status, await xmlCode(p)]).toEqual([503, "SlowDown"]);
    expect((await w.s3("GET", path(k))).status).toBe(200);
    const ls = await w.s3("GET", `/${BUCKET}?list-type=2&prefix=${encodeURIComponent("r/t1/g1/")}`);
    expect(ls.status).toBe(200);
    // heartbeat ack carries the tier
    const hb = await w.control(
      "POST",
      "/v1/heartbeat",
      w.env({ seq: 1, phase: "running", draining: false }),
      { iid: w.iid },
    );
    expect(((await hb.json()) as { tier: string }).tier).toBe("slower");
  });
});

describe("exit event output tail (M6 polish live)", () => {
  it("the ocsup ring row keeps the failed step's output tail", async () => {
    const w = await bound();
    const out = `${"x".repeat(3000)}\nError: doctor said no`;
    w.ledger.event(1, { kind: "exit", reason: "doctor-failed", code: 78, detail: "doctor exit 1", out });
    const row = w.sql("SELECT detail FROM ring WHERE src = 'ocsup' AND kind = 'exit'")[0] as {
      detail: string;
    };
    const d = JSON.parse(row.detail);
    expect(d.detail).toBe("doctor exit 1");
    expect(d.out.length).toBe(2048);
    expect(d.out.endsWith("Error: doctor said no")).toBe(true);
  });
});
