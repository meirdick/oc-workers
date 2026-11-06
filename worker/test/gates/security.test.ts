// M3 fixes of the M2 security review (worker/test/results/M2-security-review.md). Each block names its finding.
// F1 has a property test over the A1 attack harness: random attacker uploads with the uid-1000-readable key never
// let the key delete a real LTX key that no legit, verified record covers.
import { describe, expect, it } from "vitest";
import { decodeSegs } from "../../src/gates/control";
import { helloMac } from "../../src/gates/crypto";
import { BOOT_BUDGET, BUDGET, CAPS, CRED_INLINE_MAX, HELLO_BURST, STORAGE } from "../../src/gates/ledger";
import { ltxFile, parseLtxHeader } from "../../src/gates/ltx";
import { handleReplicaGate } from "../../src/gates/replica";
import { BUCKET, ltxBody, ltxKey, path, rid, STATE_DB, sha, World } from "./harness";

const code = async (r: Response) => /<Code>([^<]+)<\/Code>/.exec(await r.text())?.[1];
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const delXml = (keys: string[]) =>
  `<Delete>${keys.map((k) => `<Object><Key>${k}</Key></Object>`).join("")}<Quiet>false</Quiet></Delete>`;
async function bound(o: ConstructorParameters<typeof World>[0] = {}) {
  const w = new World(o);
  expect((await w.boot()).status).toBe(200);
  return w;
}
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function deleted(w: World, keys: string[]): Promise<string[]> {
  const r = await w.s3("POST", `/${BUCKET}?delete`, { body: delXml(keys), mode: "hex" });
  const t = await r.text();
  return [...t.matchAll(/<Deleted><Key>([^<]+)<\/Key><\/Deleted>/g)].map((m) => m[1] as string);
}

describe("F1/F3 LTX header check (Litestream 0.5.17 bytes)", () => {
  it("parses the header layout seen in real 0.5.17 files; refuses junk, short, bad magic, txid name mismatch", () => {
    // the 100-byte header of a real L0 file (M1 image, litestream 0.5.17, file replica): TXID 2-2, page 4096
    const head = new Uint8Array(
      Buffer.from(
        "4c54583100000002000010000000004a00000000000000020000000000000002000001a19554b94b00000000000000000000000000004080000000000003c5a0661887cb7d60a83100000000000000000000000000000000000000000000000000000000",
        "hex",
      ),
    );
    expect(parseLtxHeader(head, 64678)).toMatchObject({ ok: true, minTxid: 2, maxTxid: 2, pageSize: 4096 });
    expect(parseLtxHeader(new TextEncoder().encode("x"), 1)).toEqual({ ok: false, why: "short-header" });
    expect(parseLtxHeader(ltxFile(1, 5).subarray(0, 100), 100)).toEqual({ ok: false, why: "short-file" });
    const bad = ltxFile(1, 5);
    bad[0] = 0;
    expect(parseLtxHeader(bad, bad.length)).toEqual({ ok: false, why: "magic" });
    const rev = ltxFile(9, 5);
    expect(parseLtxHeader(rev, rev.length)).toEqual({ ok: false, why: "txid" });
  });

  it("A1 (exact): a forged 1-byte covering L9 no longer lets the key delete the real chain", async () => {
    const w = await bound();
    const real = [ltxKey(1, STATE_DB, 0, 1, 5), ltxKey(1, STATE_DB, 0, 6, 6), ltxKey(1, STATE_DB, 0, 7, 9)];
    for (const [i, k] of real.entries())
      expect(
        (await w.s3("PUT", path(k), { body: ltxBody([1, 6, 7][i] as number, [5, 6, 9][i] as number) }))
          .status,
      ).toBe(200);
    const forged = ltxKey(1, STATE_DB, 9, 1, 0x7fffffff);
    expect((await w.s3("PUT", path(forged), { body: "x" })).status).toBe(200); // the object is written…
    expect(w.sql("SELECT * FROM ltx WHERE level = 9")).toEqual([]); // …but not recorded
    expect(w.sql("SELECT class FROM alerts WHERE class = 'replica-ltx-bad'")).toHaveLength(1);
    expect(await deleted(w, real)).toEqual([]);
    expect(w.r2.keys(`r/t1/g1/${STATE_DB}/0000/`)).toHaveLength(3);
  });

  it("A2 (exact): a junk L0 named …-ffffffffff no longer moves l0MaxTxid; a valid one with the wrong name neither", async () => {
    const w = await bound();
    expect((await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 5)), { body: ltxBody(1, 5) })).status).toBe(200);
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 6, 0xffffffffff)), { body: "junk" });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 6, 0xffffff)), { body: ltxBody(6, 7) });
    expect(w.ledger.replicaState(1).dbs[STATE_DB]?.l0MaxTxid).toBe(5);
    // junk bytes count as tier bytes, not seed (sec F4)
    expect(w.ledger.budget().tierBytes).toBeGreaterThan(0);
  });

  it("a junk re-put over a recorded key drops its record (no coverage from replaced bytes)", async () => {
    const w = await bound();
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 5)), { body: ltxBody(1, 5) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 6, 9)), { body: ltxBody(6, 9) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 1, 1, 9)), { body: ltxBody(1, 9) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 1, 1, 9)), { body: "junk" });
    expect(await deleted(w, [ltxKey(1, STATE_DB, 0, 1, 5)])).toEqual([]);
  });

  it("fork: a second L0 that overlaps the head freezes deletes of the gen/db and alerts replica-fork", async () => {
    const w = await bound();
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 5)), { body: ltxBody(1, 5) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 6, 1_000_000)), { body: ltxBody(6, 1_000_000) }); // attacker
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 6, 8)), { body: ltxBody(6, 8) }); // real Litestream
    expect(w.sql("SELECT class FROM alerts WHERE class = 'replica-fork'")).toHaveLength(1);
    expect(w.ledger.replicaState(1).dbs[STATE_DB]?.l0MaxTxid).toBe(8); // the lower head (sec F3)
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 9, 1, 8)), { body: ltxBody(1, 8) });
    expect(await deleted(w, [ltxKey(1, STATE_DB, 0, 1, 5), ltxKey(1, STATE_DB, 0, 6, 8)])).toEqual([]);
  });

  it("legit compaction still deletes: verified L1 over a contiguous verified L0 chain; L9 by a newer L9", async () => {
    const w = await bound();
    const l0 = [
      [1, 5],
      [6, 6],
      [7, 9],
    ] as const;
    for (const [a, b] of l0) await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, a, b)), { body: ltxBody(a, b) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 1, 1, 9)), { body: ltxBody(1, 9) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 9, 1, 5)), { body: ltxBody(1, 5) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 9, 1, 9)), { body: ltxBody(1, 9) });
    const keys = [...l0.map(([a, b]) => ltxKey(1, STATE_DB, 0, a, b)), ltxKey(1, STATE_DB, 9, 1, 5)];
    expect((await deleted(w, keys)).sort()).toEqual([...keys].sort());
  });

  it("property (A1 harness, 150 seeds): attacker uploads never make an uncovered real key deletable", async () => {
    const stats = { runs: 0, attacks: 0, realKeys: 0, deletedReal: 0, deletedIllegit: 0 };
    for (let seed = 1; seed <= 150; seed++) {
      const r = prng(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
      const w = await bound();
      // real Litestream chain: contiguous L0s, sometimes a legit L1 over a prefix
      const real: [number, number][] = [];
      let head = 0;
      for (let i = int(2, 6); i > 0; i--) {
        const a = head + 1;
        const b = a + int(0, 20);
        real.push([a, b]);
        head = b;
      }
      const put = (lv: number, a: number, b: number, body: Uint8Array | string) =>
        w.s3("PUT", path(ltxKey(1, STATE_DB, lv, a, b)), { body });
      for (const [a, b] of real) await put(0, a, b, ltxBody(a, b));
      const legit = new Set<string>();
      if (r() < 0.5) {
        const upto = real[int(0, real.length - 2)] as [number, number];
        await put(1, 1, upto[1], ltxBody(1, upto[1]));
        for (const [a, b] of real) if (b <= upto[1]) legit.add(ltxKey(1, STATE_DB, 0, a, b));
      }
      // attacker: uploads with the same key (uid 1000 reads it from litestream.yml)
      let forked = false;
      for (let i = int(1, 6); i > 0; i--) {
        stats.attacks++;
        const lv = [1, 2, 3, 9][int(0, 3)] as number;
        const big = int(head + 1, 0x7fffffff);
        switch (int(0, 4)) {
          case 0: // junk body under a covering name (A1)
            await put(lv, 1, big, r() < 0.5 ? "x" : new Uint8Array(int(1, 400)).fill(int(0, 255)));
            break;
          case 1: // valid header, name says more than the header
            await put(lv, 1, big, ltxBody(1, int(1, head)));
            break;
          case 2: // valid header and name, range past the real head
            await put(lv, 1, big, ltxBody(1, big));
            break;
          case 3: {
            // push the head up, then real Litestream writes its next L0 → fork
            await put(0, head + 1, big, ltxBody(head + 1, big));
            const n = head + int(1, 5);
            await put(0, head + 1, n, ltxBody(head + 1, n));
            forked = true;
            break;
          }
          case 4: {
            // overwrite a legit L1 with junk: its coverage must go
            if (legit.size) {
              const l1 = w.sql<{ max_txid: number }>(
                "SELECT max_txid FROM ltx WHERE level = 1 AND min_txid = 1",
              );
              for (const x of l1) await put(1, 1, x.max_txid, "junk");
              legit.clear();
            }
            break;
          }
        }
      }
      const realKeys = real.map(([a, b]) => ltxKey(1, STATE_DB, 0, a, b));
      const gone = await deleted(w, realKeys);
      stats.runs++;
      stats.realKeys += realKeys.length;
      stats.deletedReal += gone.length;
      const illegit = gone.filter((k) => forked || !legit.has(k));
      stats.deletedIllegit += illegit.length;
      if (illegit.length) throw new Error(`seed ${seed}: deleted without legit cover: ${illegit.join(" ")}`);
    }
    console.log(`F1 property ${JSON.stringify(stats)}`);
    expect(stats.deletedIllegit).toBe(0);
    expect(stats.deletedReal).toBeGreaterThan(0); // legit compaction still works in some runs
  }, 60_000);

  it("residual (documented): a structurally valid LTX file ending at the real head still covers", async () => {
    // Agent code can read the DB and the key, so it can write a well-formed L9 [1, head] of junk pages. The gate
    // cannot tell it from Litestream's own; the bound is the current gen (older gens are not writable, A7).
    const w = await bound();
    for (const [a, b] of [
      [1, 5],
      [6, 9],
    ] as const)
      await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, a, b)), { body: ltxBody(a, b) });
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 9, 1, 9)), { body: ltxBody(1, 9) });
    expect(await deleted(w, [ltxKey(1, STATE_DB, 0, 1, 5)])).toHaveLength(1);
  });
});

describe("F4 per-boot replica budget", () => {
  it("A4: a HEAD flood gets 429 + Retry-After past the per-boot share; the day ceiling is not reached", async () => {
    const scale = 1e-5; // day ceiling 10 requests; per-boot share 2.5
    const w = await bound({ scale });
    const st: number[] = [];
    let ra: string | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await w.s3("HEAD", path(`r/t1/g1/nope${i}`));
      st.push(r.status);
      if (r.status === 429) ra = r.headers.get("retry-after");
    }
    expect(st.filter((s) => s === 429).length).toBeGreaterThan(10);
    expect(ra).toBe("3600");
    expect(w.ledger.budget().ceiling).toBe(false);
    expect(w.sql("SELECT class FROM alerts WHERE class = 'replica-boot-budget'")).toHaveLength(1);
    // the next boot (new gen) has its own budget and is not stopped by the day ceiling
    w.addGen(2);
    w.props.gen = 2;
    w.iid = rid();
    expect((await w.boot()).status).toBe(200);
    const p = await w.s3("PUT", path(ltxKey(2, STATE_DB, 0, 1, 1)), { body: ltxBody(1, 1) });
    expect(p.status).toBe(200);
  });

  it("rate: more than BOOT_BUDGET.perMin requests in one minute → 429 SlowDown with the seconds left", async () => {
    const w = await bound();
    let last: Response | null = null;
    for (let i = 0; i <= BOOT_BUDGET.perMin; i++) last = await w.s3("HEAD", path(`r/t1/g1/n${i}`));
    expect([last?.status, await code(last as Response)]).toEqual([429, "SlowDown"]);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    w.clock.t += 60_000;
    expect((await w.s3("HEAD", path("r/t1/g1/n"))).status).toBe(404);
  });

  it("A3: non-LTX keys and L9 bytes past 2 × the seed count as tier bytes; the boot byte share caps writes", async () => {
    const scale = 1e-4; // bytes ceiling ≈ 6.4 MB; per-boot share ≈ 1.6 MB
    const w = await bound({ scale });
    const big = new Uint8Array(700_000).fill(7);
    expect((await w.s3("PUT", path("r/t1/g1/junk/blob.bin"), { body: big })).status).toBe(200);
    expect(w.ledger.budget().tierBytes).toBe(700_000);
    await w.s3("PUT", path(ltxKey(1, STATE_DB, 0, 1, 1)), { body: ltxBody(1, 1, 1000) });
    for (let i = 0; i < 2; i++)
      await w.s3("PUT", path(ltxKey(1, STATE_DB, 9, 1, 1)), { body: ltxBody(1, 1, 400_000 + i) });
    const st: number[] = [];
    for (let i = 0; i < 4; i++)
      st.push((await w.s3("PUT", path(`r/t1/g1/junk/b${i}.bin`), { body: big })).status);
    expect(st).toContain(429);
    expect(w.ledger.budget().ceiling).toBe(false);
  });

  it("budget constants: perMin × 1440 stays under the day request ceiling", () => {
    expect(BOOT_BUDGET.perMin * 1440).toBeLessThan(BUDGET.reqs.ceiling);
  });
});

describe("F5 hello priority", () => {
  const hello = (w: World, mac?: string, ch = rid() + rid()) =>
    handleReplicaGate(
      new Request("http://15.0.0.2/_ocrt/hello", {
        method: "POST",
        headers: mac ? { "x-ocrt-hello-mac": mac } : {},
        body: JSON.stringify({ challenge: ch }),
      }),
      w.deps(),
    );

  it("A5: one attacker hello per second no longer starves the proxy (token bucket)", async () => {
    const w = await bound();
    let ok = 0;
    for (let s = 0; s < 20; s++) {
      w.clock.t += 1000;
      await hello(w); // attacker
      w.clock.t += 300;
      if ((await hello(w)).status === 200) ok++; // proxy
    }
    expect(ok).toBe(20);
  });

  it("a 50/s flood starves unauthenticated hellos, but a hello with a valid MAC is always served", async () => {
    const w = await bound();
    for (let i = 0; i < 50 + HELLO_BURST; i++) await hello(w);
    expect((await hello(w)).status).toBe(429);
    const ch = rid() + rid();
    const good = await hello(w, await helloMac(w.props.bootSecret, "replica", ch), ch);
    expect(good.status).toBe(200);
    const forged = await hello(w, "0".repeat(64), ch);
    expect(forged.status).toBe(429);
    // a MAC for the control plane does not work on the replica plane
    const other = await hello(w, await helloMac(w.props.bootSecret, "control", ch), ch);
    expect(other.status).toBe(429);
  });
});

describe("F7 requests without the key", () => {
  it("A12: 25 forged signatures cost 0 replicaPre and 1 batched badSig call", async () => {
    const w = await bound();
    const calls: Record<string, number> = {};
    for (const m of ["replicaPre", "badSig", "replicaPost", "current"] as const) {
      const orig = w.ledger[m].bind(w.ledger) as (...a: unknown[]) => unknown;
      (w.ledger as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        calls[m] = (calls[m] ?? 0) + 1;
        return orig(...a);
      };
    }
    for (let i = 0; i < 25; i++) {
      const r = await w.s3("GET", path("r/t1/g1/x"), { secret: "f".repeat(64) });
      expect(r.status).toBe(403);
    }
    expect(calls).toEqual({ badSig: 1 });
  });
});

describe("F8 CredStore path", () => {
  it("A8b: ..%2Fx and other encoded traversal → 400; nothing stored", async () => {
    const w = await bound();
    for (const raw of ["..%2Fx", "a%2F..%2Fb", "a%2F%2Fb", "%2Fabs", "a%5C..%5Cb", ".%2Fx", "a%00b"]) {
      const r = await w.control(
        "PUT",
        `/v1/creds/${raw}`,
        w.env({ seq: 1, sha256: sha("v"), mode: 0o600, b64: b64("v") }),
        {
          iid: w.iid,
        },
      );
      expect([raw, r.status]).toEqual([raw, 400]);
    }
    expect(w.sql("SELECT path FROM creds")).toEqual([]);
    expect(decodeSegs("credentials/.hidden.json")).toBe("credentials/.hidden.json");
    expect(decodeSegs("credentials%2Fa.json")).toBe("credentials/a.json");
  });
});

describe("F9 heartbeat replay", () => {
  it("A6b: same or older seq → 200 replay:true, not applied to the Runtime DO", async () => {
    const w = await bound();
    const hb = (seq: number) =>
      w.control("POST", "/v1/heartbeat", w.env({ seq, phase: "running", draining: false }), { iid: w.iid });
    const out = [];
    for (const s of [5, 5, 1, 6]) {
      const r = await hb(s);
      out.push([r.status, ((await r.json()) as { replay?: boolean }).replay ?? false]);
    }
    expect(out).toEqual([
      [200, false],
      [200, true],
      [200, true],
      [200, false],
    ]);
    expect(w.rt.hb.map((x) => x.seq)).toEqual([5, 6]);
  });
});

describe("F2 Control DO storage bounds", () => {
  const putCred = (w: World, p: string, seq: number, d: string) =>
    w.control("PUT", `/v1/creds/${p}`, w.env({ seq, sha256: sha(d), mode: 0o600, b64: b64(d) }), {
      iid: w.iid,
    });

  it("A9: creds_hist keeps the newest 20 per path; a pruned ring row", async () => {
    const w = await bound();
    for (let i = 1; i <= 120; i++)
      expect((await putCred(w, "credentials/x.json", i, `${i}${"z".repeat(4000)}`)).status).toBe(200);
    expect(w.sql("SELECT COUNT(*) AS n, MIN(seq) AS lo FROM creds_hist")).toEqual([
      { n: CAPS.credsHistPerPath, lo: 101 },
    ]);
    expect(w.sql("SELECT class FROM alerts WHERE class = 'ctl-prune'")).toHaveLength(0); // a ring row, not an alert
    expect(w.sql("SELECT id FROM ring WHERE src = 'bounds' AND kind = 'pruned'").length).toBeGreaterThan(0);
  });

  it("new creds paths past CAPS.credPaths → 429 creds-cap; existing paths still update", async () => {
    const w = await bound();
    for (let i = 0; i < CAPS.credPaths; i++)
      w.st.sql.exec(
        "INSERT INTO creds (path, gen, seq, deleted, updated_at) VALUES (?, 1, 1, 0, 0)",
        `p/${i}`,
      );
    expect((await putCred(w, "credentials/new.json", 1, "v")).status).toBe(429);
    expect((await putCred(w, "p/1", 2, "v")).status).toBe(200);
  });

  it("A10: config keeps the newest 50 + LKG + versions live gens boot with; plugins the newest 20", async () => {
    const w = await bound();
    w.st.sql.exec(
      "INSERT INTO config (ver, status, sha, doc, created_at) VALUES (1, 'good', 'g', '{}', 0), (2, 'candidate', 'c', '{}', 0)",
    );
    w.st.sql.exec("UPDATE gens SET plan = json_set(plan, '$.configVer', 2) WHERE gen = 1");
    for (let i = 0; i < 60; i++) {
      const doc = { x: i, pad: "p".repeat(1000) };
      expect(
        (
          await w.control(
            "PUT",
            "/v1/config/proposal",
            w.env({ source: "ui", sha: sha(JSON.stringify(doc)), doc }),
            { iid: w.iid },
          )
        ).status,
      ).toBe(200);
      const m = { ver: 0, plugins: [{ id: `p${i}`, spec: `npm:p${i}@1` }] };
      expect(
        (await w.control("PUT", "/v1/plugins/manifest", w.env({ manifest: m }), { iid: w.iid })).status,
      ).toBe(200);
    }
    const vers = w.sql<{ ver: number }>("SELECT ver FROM config ORDER BY ver").map((r) => r.ver);
    expect(vers.length).toBe(CAPS.configRows + 2);
    expect(vers.slice(0, 2)).toEqual([1, 2]);
    expect(w.sql("SELECT COUNT(*) AS n FROM plugins")).toEqual([{ n: CAPS.pluginRows }]);
  });

  it("A11: new shadow names no longer pass at once: 12 per hour over all names", async () => {
    const w = await bound();
    const data = new Uint8Array(1000).fill(3);
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const r = await w.control("PUT", `/v1/shadow/state/f${i}.sqlite`, undefined, {
        iid: w.iid,
        raw: data,
        headers: { "x-ocrt-sha256": sha(data) },
      });
      if (r.status === 200) ok++;
    }
    expect(ok).toBe(12);
  });

  it("storage-full guard: above STORAGE.hard creds/config/plugins/shadow → 507 ctl-full; heartbeat and boot still work", async () => {
    let size = 0;
    const w = await bound();
    (w.ledger.o as { size?: () => number }).size = () => size;
    size = STORAGE.hard + 1;
    expect((await putCred(w, "credentials/a.json", 1, "v")).status).toBe(507);
    const doc = { y: 1 };
    expect(
      (
        await w.control("PUT", "/v1/config/proposal", w.env({ source: "ui", sha: sha("d"), doc }), {
          iid: w.iid,
        })
      ).status,
    ).toBe(507);
    expect(w.sql("SELECT class FROM alerts WHERE class = 'ctl-storage-full'")).toHaveLength(1);
    const hb = await w.control(
      "POST",
      "/v1/heartbeat",
      w.env({ seq: 1, phase: "running", draining: false }),
      { iid: w.iid },
    );
    expect(hb.status).toBe(200);
  });
});

describe("F10 inline creds", () => {
  it("a 600 KB cred goes to R2; the row holds no base64 (row well under 2 MB)", async () => {
    const w = await bound();
    const big = new Uint8Array(CRED_INLINE_MAX + 100_000).fill(9);
    const r = await w.control(
      "PUT",
      "/v1/creds/credentials/big.bin",
      w.env({ seq: 1, sha256: sha(big), mode: 0o600, b64: b64(big) }),
      { iid: w.iid },
    );
    expect(r.status).toBe(200);
    expect(w.sql("SELECT b64, r2_key FROM creds")).toEqual([{ b64: null, r2_key: `c/t1/blob/${sha(big)}` }]);
    expect(CRED_INLINE_MAX * (4 / 3)).toBeLessThan(1_000_000);
  });
});
