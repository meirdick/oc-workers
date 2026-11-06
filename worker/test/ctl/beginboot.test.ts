// Spec §6.2, §8.2, §8.3, §13.3, §14, §15.2; scenarios §21 #4, #5, #7, #21-#24, #65, #80.
import { describe, expect, it } from "vitest";
import { hwmKey, installedKey } from "../../src/ctl/gens";
import { bootComplete, opId, world } from "./world";

const DB = "state/openclaw.sqlite";

describe("beginBoot and gens", () => {
  it("issues gen 1 with a fresh plan on a new install; hwm written before return", async () => {
    const w = world();
    w.install();
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.gen).toBe(1);
    expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.plan.sqlite).toEqual({ kind: "fresh" });
    expect(r.plan.rootfs).toEqual({ kind: "image", digest: "sha256:img1" });
    expect(r.plan.replica.prefix).toBe("r/t1/");
    // restoreMs: the image-path restore budget (test value), so ocsup bounds its restore steps (F1).
    expect(r.plan.timers).toEqual({ hbMs: 1000, fenceMs: 5000, startGateMs: 5000, restoreMs: 15000 });
    expect(r.plan.workspace).toEqual({ source: "none" });
    const hwm = JSON.parse(await (await w.r2.get(hwmKey("t1")))!.text());
    expect(hwm.gen).toBe(1);
  });

  it("M3 e2e: plan.managed carries the trusted-proxy keys and publicOrigin (ingress/gateway.ts)", async () => {
    const w = world({ settings: { publicOrigin: "https://x.example.dev/" } });
    w.install();
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    const m = Object.fromEntries(r.plan.managed.map((x) => [x.path, x.value]));
    expect(m["gateway.auth.mode"]).toBe("trusted-proxy");
    expect(m["gateway.trustedProxies"]).toEqual(r.plan.trustedProxies);
    expect(m["gateway.auth.trustedProxy.userHeader"]).toBe("x-ochost-user");
    expect(m["gateway.auth.trustedProxy.allowUsers"]).toEqual(["owner"]);
    expect(m["gateway.publicOrigin"]).toBe("https://x.example.dev");
  });

  it("#7 same opId after a Control DO restart: 1 gen, 1 secret", async () => {
    const w = world();
    w.install();
    const a = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    const w2 = w.restart();
    const b = await w2.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(b.gen).toBe(a.gen);
    expect(b.secret).toBe(a.secret);
    expect(w2.db.metaNum("genCounter")).toBe(1);
  });

  it("C13 replan keeps gen and secret, recomputes the plan", async () => {
    const w = world();
    w.install();
    const a = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user", replan: true });
    expect([b.gen, b.secret]).toEqual([a.gen, a.secret]);
  });

  it("refuses a non-active epoch in prod", async () => {
    const w = world();
    w.install();
    w.db.run("UPDATE epochs SET status = 'retiring' WHERE n = 1");
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.error).toBe("epoch-not-active");
  });

  it("hwm write error → plan restore-blocked:infra (no container start)", async () => {
    const w = world();
    w.install();
    w.r2.failUntil = w.clock.t + 10;
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.plan.sqlite).toMatchObject({ kind: "restore-blocked", reason: "restore-blocked:infra" });
  });

  it("#21 initialized=1 and empty replica → restore-blocked:mismatch", async () => {
    const w = world();
    w.install();
    w.db.setMeta("initialized", 1);
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.plan.sqlite).toMatchObject({ kind: "restore-blocked", reason: "restore-blocked:mismatch" });
  });

  it("#22 new Control DO with an existing install marker → adopt, no fresh", async () => {
    const w = world();
    w.install();
    await w.r2.put(installedKey("t1"), "{}");
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.plan.sqlite.kind).toBe("restore-blocked");
    expect(r.plan.sqlite).toMatchObject({ reason: "restore-blocked:mismatch" });
    expect(w.db.metaNum("initialized")).toBe(1);
  });

  it("#22b new Control DO with foreign gens in R2 → adopt", async () => {
    const w = world();
    w.install();
    await w.r2.put("r/t1/g7/state/openclaw.sqlite/0000/x.ltx", "x");
    await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(w.db.metaNum("initialized")).toBe(1);
  });

  it("#23 first-install crash before started → next plan is fresh again", async () => {
    const w = world();
    w.install();
    const a = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    // Litestream of the failed fresh boot uploaded something.
    await w.r2.put(`r/t1/g${a.gen}/state/openclaw.sqlite/0000/0000000000000001-0000000000000001.ltx`, "x");
    await w.api.endBoot({ gen: a.gen, opId: "s1", why: "crash" });
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s2", reason: "ladder" });
    expect(b.plan.sqlite).toEqual({ kind: "fresh" });
  });

  it("R2 list error on a fresh check → restore-blocked:infra", async () => {
    const w = world();
    w.install();
    w.r2.listFail = 1;
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.plan.sqlite).toMatchObject({ reason: "restore-blocked:infra" });
  });

  it("#80 gen plan lists uploaded DBs only; pending DBs omitted; restoreGens = [gen]", async () => {
    const w = world();
    w.install();
    const a = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    w.ledger.recordUpload({
      key: `r/t1/g${a.gen}/${DB}/0000/0000000000000001-0000000000000009.ltx`,
      bytes: 10,
    });
    w.db.run(
      "INSERT INTO gendb (gen, db, in_boot_set, state) VALUES (?, 'agents/a/agent/openclaw-agent.sqlite', 1, 'pending')",
      a.gen,
    );
    w.db.run("UPDATE gens SET state = 'complete' WHERE gen = ?", a.gen);
    await w.api.onStarted({
      epoch: 1,
      gen: a.gen,
      opId: "s1",
      reason: "user",
      digest: "d",
      wakeAt: 0,
      aliveMs: 1,
      startupzMs: 2,
    });
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s2", reason: "ladder" });
    expect(b.plan.sqlite).toMatchObject({ kind: "gen", gen: a.gen, dbs: [DB] });
    expect(b.plan.dbs).toEqual([{ db: DB, lastTxid: 9, bytes: 10, state: "uploaded" }]);
    expect(b.restoreGens).toEqual([a.gen]);
  });

  it("#80 schema-newer gens are skipped; all newer → restore-blocked:schema", async () => {
    const w = world();
    w.install();
    w.db.setMeta("image:sha256:img1", { stateSchema: 3, agentSchema: 3 });
    const a = await bootComplete(w);
    w.db.run("UPDATE gens SET state_schema = 9 WHERE gen = ?", a.gen);
    w.db.setMeta("initialized", 1);
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s2", reason: "ladder" });
    expect(b.plan.sqlite).toMatchObject({ kind: "restore-blocked", reason: "restore-blocked:schema" });
  });

  it("#80 archive plan when no usable gen", async () => {
    const w = world();
    w.install();
    w.db.setMeta("initialized", 1);
    w.db.run(
      `INSERT INTO archives (id, key, kind, state, sha256, size, digest, txid, created_at)
       VALUES ('a1', 'a/t1/x.tar.gz', 'clean', 'complete', ?, 10, 'sha256:img1', '{"state/openclaw.sqlite":42}', ?)`,
      "a".repeat(64),
      w.clock.t,
    );
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.plan.sqlite).toEqual({ kind: "archive", archiveId: "a1", txid: { [DB]: 42 } });
    expect(r.plan.rootfs.kind).toBe("image");
    expect(r.plan.archive).toMatchObject({ archiveId: "a1", key: "a/t1/x.tar.gz" });
  });

  it("#24 Control DO rewound below the hwm → ctl-rewound, restore-blocked:rewound, genCounter = hwm.gen", async () => {
    const w = world();
    w.install();
    await w.r2.put(hwmKey("t1"), JSON.stringify({ gen: 40, credsSeq: 0, at: 1 }));
    const h = await w.api.core.hwmCheck();
    expect(h.rewound).toBe(true);
    expect(w.db.meta("ctlState")).toBe("ctl-rewound");
    expect(w.db.metaNum("genCounter")).toBe(40);
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.gen).toBe(41);
    expect(r.plan.sqlite).toMatchObject({ reason: "restore-blocked:rewound" });
    expect(
      w.db.one<{ severity: string }>("SELECT severity FROM alerts WHERE class = 'ctl-rewound'")?.severity,
    ).toBe("high");
  });

  it("hwm read error keeps the old state", async () => {
    const w = world();
    w.install();
    w.r2.readFail = 1;
    expect(await w.api.core.hwmCheck()).toEqual({ checked: false, rewound: false });
  });

  it("gen-churn alert above 10 unplanned gens in a UTC day", async () => {
    const w = world();
    w.install();
    for (let i = 0; i < 11; i++)
      await w.api.beginBoot({ epoch: 1, mode: "prod", opId: `l${i}`, reason: "ladder" });
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'gen-churn'")).toBeTruthy();
    expect(w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM gens WHERE state = 'abandoned'")?.n).toBe(10);
  });

  it("onStarted: initialized, install marker in R2 (write-once), config good, wake log startupz", async () => {
    const w = world();
    w.install();
    await w.api.core.c.db.run(
      "INSERT INTO config (ver, status, source, doc, created_at) VALUES (1, 'candidate', 'seed', '{}', 1)",
    );
    const a = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(a.plan.configVer).toBe(1);
    await w.api.onStarted({
      epoch: 1,
      gen: a.gen,
      opId: "s1",
      reason: "user",
      digest: "x",
      wakeAt: 0,
      aliveMs: 5,
      startupzMs: 900,
    });
    expect(w.db.metaNum("initialized")).toBe(1);
    expect(await w.r2.head(installedKey("t1"))).toBeTruthy();
    expect(
      w.db.one<{ status: string; good_digest: string }>(
        "SELECT status, good_digest FROM config WHERE ver = 1",
      ),
    ).toEqual({
      status: "good",
      good_digest: "sha256:img1",
    });
    expect(
      w.db.one<{ startupz_ms: number }>("SELECT startupz_ms FROM wake_log WHERE gen = ?", a.gen)?.startupz_ms,
    ).toBe(900);
  });
});

describe("marker and snapshots in plans", () => {
  async function sleepCycle(w: ReturnType<typeof world>, gen: number, snap: string, op = opId("sleep")) {
    const m = await w.api.markerPending({
      opId: op,
      gen,
      epoch: 1,
      digest: "sha256:img1",
      txid: { [DB]: 5 },
      bytes: { [DB]: 1000 },
      lastWriteAt: { [DB]: w.clock.t },
    });
    w.advance(10);
    await w.api.snapshotSaved({
      id: snap,
      size: 100,
      digest: "sha256:img1",
      imageKey: "oc",
      gen,
      epoch: 1,
      kind: "sleep",
    });
    await w.api.markerValid({ id: m.id, snapshotId: snap });
    return m.id;
  }

  it("#65 marker consumed in beginBoot; a second boot from the same snapshot gets `gen`", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    const mid = await sleepCycle(w, a.gen, "snap-1");
    w.advance(1000);
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w1", reason: "wake:webhook" });
    expect(b.plan.rootfs).toMatchObject({ kind: "snapshot", snapshotId: "snap-1" });
    expect(b.plan.sqlite).toMatchObject({ kind: "marker", markerId: mid, snapshotId: "snap-1", gen: a.gen });
    expect(
      w.db.one<{ state: string; consumed_by_gen: number }>(
        "SELECT state, consumed_by_gen FROM markers WHERE id = ?",
        mid,
      ),
    ).toEqual({
      state: "consumed",
      consumed_by_gen: b.gen,
    });
    const c = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w2", reason: "ladder" });
    expect(c.plan.rootfs).toMatchObject({ snapshotId: "snap-1" });
    expect(c.plan.sqlite).toMatchObject({ kind: "gen", gen: a.gen });
  });

  it("#65 late upload to marker.gen voids a valid marker", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    const mid = await sleepCycle(w, a.gen, "snap-1");
    w.advance(1000);
    w.ledger.recordUpload({
      key: `r/t1/g${a.gen}/${DB}/0000/0000000000000006-0000000000000006.ltx`,
      bytes: 5,
    });
    expect(
      w.db.one<{ state: string; void_reason: string }>(
        "SELECT state, void_reason FROM markers WHERE id = ?",
        mid,
      ),
    ).toEqual({
      state: "void",
      void_reason: "late-upload",
    });
  });

  it("marker refused when unclean or not prod; idempotent by opId", async () => {
    const w = world();
    w.install();
    const c = w.api.core;
    const base = {
      opId: "o1",
      gen: 1,
      epoch: 1,
      digest: "d",
      txidPerDb: {},
      bytesPerDb: {},
      lastWriteAtPerDb: {},
    };
    expect(c.markerPending({ ...base, unclean: ["litestream"] }).ok).toBe(false);
    expect(c.markerPending({ ...base, mode: "canary" }).ok).toBe(false);
    const a = c.markerPending(base);
    const b = c.markerPending(base);
    expect(a.id).toBe(b.id);
    expect(w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM markers")?.n).toBe(1);
  });

  it("#4 snapshot miss: suspect, replan in the same op picks the next snapshot, marker void, no new gen", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    await sleepCycle(w, a.gen, "snap-old");
    w.advance(1000);
    const mid = await sleepCycle(w, a.gen, "snap-new");
    w.advance(1000);
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w1", reason: "wake:cron" });
    expect(b.plan.sqlite).toMatchObject({ kind: "marker", markerId: mid });
    expect(await w.api.snapshotMiss("snap-new")).toEqual({ state: "suspect" });
    const c = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "w1",
      reason: "wake:cron",
      replan: true,
      missed: ["snap-new"],
    });
    expect(c.gen).toBe(b.gen);
    expect(c.plan.rootfs).toMatchObject({ snapshotId: "snap-old" });
    expect(c.plan.sqlite).toMatchObject({ kind: "gen" });
    expect(w.db.one<{ state: string }>("SELECT state FROM markers WHERE id = ?", mid)?.state).toBe("void");
    expect(await w.api.snapshotMiss("snap-new")).toEqual({ state: "bad" });
  });

  it("#5 newest snapshot not found while a newer archive exists → archive path", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    await sleepCycle(w, a.gen, "snap-1");
    w.advance(5000);
    w.db.run(
      `INSERT INTO archives (id, key, kind, state, sha256, size, txid, created_at)
       VALUES ('a9', 'a/t1/9.tar.gz', 'clean', 'complete', ?, 1, '{}', ?)`,
      "b".repeat(64),
      w.clock.t,
    );
    await w.api.snapshotMiss("snap-1");
    const b = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "w1",
      reason: "wake:ui",
      missed: ["snap-1"],
    });
    expect(b.plan.rootfs.kind).toBe("image");
    expect(b.plan.archive?.archiveId).toBe("a9");
    expect(b.plan.sqlite).toMatchObject({ kind: "gen", gen: a.gen });
  });

  it("L3 picks an older consistent snapshot and supersedes newer ones; L2+ voids markers", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    await sleepCycle(w, a.gen, "s1");
    w.advance(1000);
    const mid = await sleepCycle(w, a.gen, "s2");
    w.advance(1000);
    const r = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "l3",
      reason: "ladder",
      ladder: 3,
      l1SnapshotId: "s2",
    });
    expect(r.plan.rootfs).toMatchObject({ snapshotId: "s1" });
    expect(r.plan.runDoctor).toBe(false);
    expect(w.api.core.snapshot("s2")?.state).toBe("superseded");
    expect(w.db.one<{ state: string }>("SELECT state FROM markers WHERE id = ?", mid)?.state).toBe("void");
  });

  it("L2 and L4 run Doctor and force LKG config", async () => {
    const w = world();
    w.install();
    w.db.run("INSERT INTO config (ver, status, source, doc, created_at) VALUES (1, 'good', 'seed', '{}', 1)");
    w.db.run(
      "INSERT INTO config (ver, status, source, doc, created_at) VALUES (2, 'candidate', 'ui', '{}', 2)",
    );
    const r1 = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "x1", reason: "user" });
    expect(r1.plan.configVer).toBe(2);
    const r2 = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "x2", reason: "ladder", ladder: 2 });
    expect([r2.plan.configVer, r2.plan.runDoctor]).toEqual([1, true]);
    const r4 = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "x4", reason: "ladder", ladder: 4 });
    expect([r4.plan.rootfs.kind, r4.plan.runDoctor]).toEqual(["image", true]);
  });

  it("held rows become pending at a wake start", async () => {
    const w = world();
    w.install();
    w.db.run(
      "INSERT INTO inbox (id, route, account, platform_key, received_at, headers, body, state) VALUES ('x', '/telegram-webhook', 'default', '1', 1, '{}', '{}', 'held')",
    );
    await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w", reason: "wake:cron" });
    expect(w.db.one<{ state: string }>("SELECT state FROM inbox WHERE id = 'x'")?.state).toBe("pending");
  });
});

describe("rebase and maintenance schedule", () => {
  it("#67 rebase plan: image + newest archive + newest gen; snapshots stay ok (no supersede)", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    await w.api.snapshotSaved({
      id: "s1",
      size: 1,
      digest: "sha256:img1",
      imageKey: "oc",
      gen: a.gen,
      epoch: 1,
      kind: "sleep",
    });
    w.db.run(
      `INSERT INTO archives (id, key, kind, state, sha256, size, txid, created_at)
       VALUES ('a1', 'a/t1/1.tar.gz', 'clean', 'complete', ?, 1, '{}', ?)`,
      "c".repeat(64),
      w.clock.t,
    );
    const r = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "rb",
      reason: "maint-rebase",
      rebase: true,
    });
    expect(r.plan.rootfs.kind).toBe("image");
    expect(r.plan.archive?.archiveId).toBe("a1");
    expect(r.plan.sqlite).toMatchObject({ kind: "gen", gen: a.gen });
    expect(w.api.core.snapshot("s1")?.state).toBe("ok");
  });

  it("maintenance wake snaps to maintenanceHour inside the next 4 h", () => {
    const w = world({
      real: true,
      settings: { runtime: { maintenanceHour: 4, tz: "UTC" } },
    });
    w.install();
    // last wake 2026-11-01T02:30Z → due 2026-11-02T02:30Z → snapped to 04:00Z
    const last = Date.parse("2026-11-01T02:30:00Z");
    const p = w.api.core.wakePlan({ nextWakeAtMs: null, lastWakeAt: last });
    expect(new Date(p.wakeAt).toISOString()).toBe("2026-11-02T04:00:00.000Z");
    expect(p.reason).toBe("maint");
  });
});
