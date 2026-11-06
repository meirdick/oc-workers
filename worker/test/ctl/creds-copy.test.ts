// Drill L (scope §4 M4, [Z1.9, Z2.1]): CredStore second copy `c/<inst>/<seq>.json`, hwm credsSeq, and the
// restore into a Control DO whose storage was replaced.
import { describe, expect, it } from "vitest";
import { credsCopyKey } from "../../src/ctl/creds-copy";
import { hwmKey } from "../../src/ctl/gens";
import { FakeStorage } from "../harness/storage";
import { world } from "./world";

const sha = (c: string) => c.repeat(64);
const put = (w: ReturnType<typeof world>, path: string, seq: number, v: string, gen = 1) =>
  w.ledger.credsPut(gen, path, { seq, sha256: sha(v), mode: 0o600, b64: btoa(v) });
const WA = "credentials/whatsapp/default/creds.json";
const PK = "credentials/whatsapp/default/pre-key-1.json";

describe("drill L: creds second copy in R2", () => {
  it("writes c/<inst>/<seq>.json with every row (tombstones too) and the hwm credsSeq, at most every credsCopyMs", async () => {
    const w = world({ timers: { credsCopyMs: 60_000 } });
    w.install();
    put(w, WA, 1, "a");
    put(w, PK, 2, "k");
    w.ledger.credsDelete(1, PK, 3);
    await w.core.credsCopyStep();
    const doc = JSON.parse(await (await w.r2.get(credsCopyKey("t1", 3)))!.text());
    expect(doc.seq).toBe(3);
    expect(doc.rows.map((r: { path: string; deleted: number }) => [r.path, r.deleted])).toEqual([
      [WA, 0],
      [PK, 1],
    ]);
    expect(JSON.parse(await (await w.r2.get(hwmKey("t1")))!.text()).credsSeq).toBe(3);
    // Not due again inside credsCopyMs; due after it; unchanged → no copy.
    put(w, WA, 4, "b");
    await w.core.credsCopyStep();
    expect(await w.r2.get(credsCopyKey("t1", 4))).toBeNull();
    w.advance(61_000);
    await w.core.credsCopyStep();
    expect(await w.r2.get(credsCopyKey("t1", 4))).not.toBeNull();
    w.advance(61_000);
    await w.core.credsCopyStep();
    const keys = (await w.r2.list({ prefix: "c/t1/" })).objects.map((o) => o.key);
    expect(keys).toEqual([credsCopyKey("t1", 3), credsCopyKey("t1", 4)]);
  });

  it("the hwm gen part is never lowered by a creds copy", async () => {
    const w = world({ timers: { credsCopyMs: 1 } });
    w.install();
    await w.r2.put(hwmKey("t1"), JSON.stringify({ gen: 40, credsSeq: 0, at: 1 }));
    w.db.setMeta("genCounter", 40);
    put(w, WA, 1, "a");
    w.advance(10);
    await w.core.credsCopyStep();
    expect(JSON.parse(await (await w.r2.get(hwmKey("t1")))!.text())).toMatchObject({ gen: 40, credsSeq: 1 });
  });

  it("storage replaced → ctl-rewound → creds restored from the newest copy (no relink), once; newer rows kept", async () => {
    const w = world({ timers: { credsCopyMs: 1 } });
    w.install();
    put(w, WA, 1, "id-v1");
    put(w, PK, 2, "k1");
    w.advance(10);
    await w.core.credsCopyStep();
    put(w, WA, 3, "id-v2");
    w.advance(10);
    await w.core.credsCopyStep();
    await w.r2.put(hwmKey("t1"), JSON.stringify({ gen: 7, credsSeq: 3, at: w.clock.t }));
    // Storage replaced: a new Control DO over empty storage, same R2.
    const w2 = world({ timers: { credsCopyMs: 1 }, storage: new FakeStorage(), r2: w.r2, clock: w.clock });
    w2.install();
    const h = await w2.core.hwmCheck();
    expect(h.rewound).toBe(true);
    await w2.core.credsCopyStep();
    const man = (
      await w2.api.ops({ action: "creds", method: "GET", sub: [], query: {}, body: {}, role: "owner" })
    ).body as { seq: number; files: { path: string; seq: number; sha256: string }[] };
    expect(man.seq).toBe(3);
    expect(man.files.map((f) => [f.path, f.seq, f.sha256])).toEqual([
      [WA, 3, sha("id-v2")],
      [PK, 2, sha("k1")],
    ]);
    expect(w2.ledger.credsGet(WA)?.b64).toBe(btoa("id-v2"));
    expect(w2.db.meta("credsRestoredFrom")).toBe(credsCopyKey("t1", 3));
    expect(w2.db.one("SELECT class FROM alerts WHERE class = 'creds-restored-c'")).toBeTruthy();
    // Prod boots stay blocked (spec §13.3); gens are not reissued below the hwm.
    expect(w2.db.metaNum("genCounter")).toBe(7);
    const b = await w2.api.beginBoot({ epoch: 1, mode: "prod", opId: "after-wipe", reason: "user" });
    expect(b.plan.sqlite).toMatchObject({ kind: "restore-blocked", reason: "restore-blocked:rewound" });
    // Once: a later newer write is not overwritten by the copy on the next tick.
    put(w2, WA, 9, "id-v3", 8);
    await w2.core.credsCopyStep();
    expect(w2.ledger.credsGet(WA)?.seq).toBe(9);
  });

  it("rewound with no copy in R2 → ring restore-c-none, store untouched", async () => {
    const w = world();
    w.install();
    await w.r2.put(hwmKey("t1"), JSON.stringify({ gen: 3, credsSeq: 5, at: 1 }));
    await w.core.hwmCheck();
    await w.core.credsCopyStep();
    expect(w.db.one("SELECT id FROM ring WHERE src = 'creds' AND kind = 'restore-c-none'")).toBeTruthy();
    expect(w.db.all("SELECT path FROM creds")).toEqual([]);
  });
});
