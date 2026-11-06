// M3 entry fixes of the M2 blockers (worker/test/results/M2-STATUS.md §1, §7): F2 /ops/restart from
// `stopping`, F3 replan cap, F1 restore budget → next ladder step, B1 workspace source, B2 rule 7 lead,
// O1 epoch digest from the live image map, driver delivery timeout.
import { afterEach, describe, expect, it } from "vitest";
import type { World } from "../harness/world";
import { done, fresh, gensOf, startCount, sutP, toAsleep, toRunning, toStopping } from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));

const plans = (x: World, epoch?: number) =>
  x
    .rt(epoch)
    .ocsup.boots.map((b) => b.plan)
    .filter(Boolean) as Record<string, any>[];
const lastPlan = (x: World, epoch?: number) => plans(x, epoch).at(-1) as Record<string, any>;

describe("F2 /ops/restart", () => {
  it("restart from running → stopped then started, one new gen, desired running", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const g0 = gensOf(w).length;
    const r = await w.ops("restart");
    expect(r.status).toBe(200);
    await w.until(() => w.state() === "running" && gensOf(w).length === g0 + 1, 30_000);
    expect(w.rt().kv<{ desired: string }>("rec")?.desired).toBe("running");
    expect(w.ring("restart-after-stop").length).toBe(1);
  });

  it("owner start while `stopping` → the stop ends, then a start op runs (no lost start)", async () => {
    w = await fresh(sut);
    await toStopping(w);
    const s = await w.rt().call("ownerStart");
    expect(s).toMatchObject({ ok: true, state: "stopping" });
    w.rt().ocsup.script = () => undefined; // stop-status reaches quiesced now
    await w.until(() => w.state() === "running", 60_000);
    expect(w.rt().kv<{ desired: string }>("rec")?.desired).toBe("running");
  });

  it("plain stop still ends stopped with desired stopped", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.ops("stop");
    await w.until(() => w.state() === "stopped", 30_000);
    await w.advance(5_000);
    expect(w.state()).toBe("stopped");
    expect(w.rt().kv<{ desired: string }>("rec")?.desired).toBe("stopped");
  });
});

describe("restart after a deploy boots the new image (M7 sandbox F1, N8)", () => {
  it("platform keeps the old image map in a live DO: deploy + restart → stop, recycle, image-path boot of the new digest, new gen", async () => {
    w = await fresh(sut, { sleep: true });
    w.staleImages = true; // ctx.container.images is as old as the DO instance
    await toRunning(w);
    const g0 = gensOf(w).length;
    const boots0 = plans(w).length;
    // A complete archive newer than the last write: the pre-restart archive step finds nothing to take (it is
    // covered in ctl/archives.test.ts), and the new digest has the archive its image-path boot restores from.
    w.ctl().storage.sql.exec(
      `INSERT INTO archives (id, key, kind, state, sha256, size, digest, txid, gen, created_at, completed_at, ws_entries)
       VALUES ('ar1', 'a/t1/x.tar.gz', 'online', 'complete', ?, 10, 'sha256:aaaa', '{}', 1, ?, ?, 3)`,
      "a".repeat(64),
      Date.now(),
      Date.now(),
    );
    // The deploy: a newer Worker version and a new digest in the platform's map (the old DO does not see it).
    (w.env as { CF_VERSION: { id: string } }).CF_VERSION = { id: "v-test-2" };
    w.rt().c.imageMap.oc = NEW_IMAGE;
    const r = await w.ops("restart");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ redeploy: true });
    await w.until(() => w.state() === "running" && plans(w).length === boots0 + 1, 120_000);
    const p = lastPlan(w);
    expect([p.rootfs.kind, p.rootfs.digest]).toEqual(["image", "sha256:bbbb"]);
    expect(gensOf(w).length).toBe(g0 + 1);
    expect(w.ring("recycle").length).toBe(1);
    expect(
      w.ring("digest-change").at(-1) && JSON.parse(w.ring("digest-change").at(-1)?.detail as string).to,
    ).toBe("sha256:bbbb");
  });

  it("no deploy since the DO was built: restart is the ordinary restart (no recycle)", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const r = await w.ops("restart");
    expect((r.body as { redeploy?: boolean }).redeploy).toBeFalsy();
    await w.until(() => w.state() === "running" && gensOf(w).length === 2, 30_000);
    expect(w.ring("recycle").length).toBe(0);
  });
});

describe("B2 sleep rule 7 counts leadMs", () => {
  it("job due in minSleepMs + 0.5 s (test timers: minSleep 5 s, lead 1 s) → no sleep: the pre-wake is 4.5 s away", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.script = (op) =>
      op === "sleep-check"
        ? { ok: true, blockers: [], nextWakeAtMs: Date.now() + 5_500, eventJobs: [], channels: [] }
        : undefined;
    await w.advance(30_000, 200);
    expect(w.rt().c.count("snapshot")).toBe(0);
    expect(w.state()).toBe("running");
  });

  it("job due in minSleepMs + leadMs + 2 s → sleeps; alarm at due − leadMs", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const at = Date.now() + 60_000;
    w.rt().ocsup.nextWakeAtMs = at;
    await w.until(() => w.state() === "asleep", 30_000);
    expect(w.rt().alarmAt()).toBe(at - 1_000);
  });

  it("job time already past → does not block sleep", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.script = (op) =>
      op === "sleep-check"
        ? { ok: true, blockers: [], nextWakeAtMs: Date.now() - 60_000, eventJobs: [], channels: [] }
        : undefined;
    w.rt().ocsup.nextWakeAtMs = Date.now() - 60_000; // the flush reply carries the same stale time
    await w.until(() => w.state() === "asleep", 30_000);
    // No alarm in the past: no sleep/wake thrash (live oc-m3-rt woke 80 ms after each sleep).
    const starts = startCount(w);
    await w.advance(20_000, 200);
    expect(startCount(w)).toBe(starts);
    expect(w.state()).toBe("asleep");
  });
});

describe("driver delivery timeout (§12.3, sec F6)", () => {
  const upd = (id: number) => ({
    update_id: id,
    message: { message_id: id, from: { id: 5 }, chat: { id: 5 }, text: "x" },
  });
  it("a delivery that never answers ends at deliverTimeoutMs; the row is retried and accepted; the queue moves", async () => {
    w = await fresh(sut);
    const o = w.rt().ocsup;
    o.replayAnswers = [() => new Promise<Response>(() => {})];
    await toRunning(w);
    await w.webhook(upd(1));
    await w.webhook(upd(2));
    await w.until(() => w.inbox().every((r) => r.state === "accepted"), 30_000);
    expect(w.inbox().length).toBe(2);
    expect(w.ring("deliver-timeout").length).toBeGreaterThanOrEqual(1);
  });
});

const NEW_IMAGE = "registry.cloudflare.com/acct/oc-host@sha256:bbbb";

describe("O1 epoch digest from the deployed image map", () => {
  it("first boot sets the epoch digest from the map (no 'unknown')", async () => {
    w = await fresh(sut);
    await toRunning(w);
    expect(w.epochs()[0]?.digest).toBe("sha256:aaaa");
    expect(lastPlan(w).rootfs).toEqual({ kind: "image", digest: "sha256:aaaa" });
  });

  it("image deploy (map digest changes) while asleep → wake boots the image path + gen + Doctor; old snapshot unused", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const snap = w.snapshots().at(-1)?.id as string;
    // F1 (M4b): the digest change needs an archive with the workspace (else it is deferred; m4b-ctl.test.ts).
    const at = (w.snapshots().at(-1) as { created_at: number }).created_at - 1000;
    w.ctl().storage.sql.exec(
      `INSERT INTO archives (id, key, kind, state, sha256, size, digest, txid, gen, created_at, completed_at, ws_entries)
       VALUES ('ar1', 'a/t1/x.tar.gz', 'online', 'complete', ?, 10, 'sha256:aaaa', '{}', 1, ?, ?, 3)`,
      "a".repeat(64),
      at,
      at,
    );
    w.rt().c.imageMap.oc = NEW_IMAGE;
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 30_000);
    const p = lastPlan(w);
    expect([p.rootfs.kind, p.rootfs.digest, p.sqlite.kind, p.runDoctor]).toEqual([
      "image",
      "sha256:bbbb",
      "gen",
      true,
    ]);
    expect(p.workspace).toEqual({ source: "archive" });
    expect(w.epochs()[0]?.digest).toBe("sha256:bbbb");
    // unknown → aaaa at the first boot, aaaa → bbbb at this wake.
    expect(w.ring("digest-change").map((r) => JSON.parse(r.detail).to)).toEqual([
      "sha256:aaaa",
      "sha256:bbbb",
    ]);
    expect(
      w
        .rt()
        .c.calls.filter((c) => c.op === "start")
        .at(-1)?.detail,
    ).not.toContain(snap);
  });
});

describe("B1 workspace source in the plan", () => {
  it("wake from a sleep snapshot → workspace source snapshot", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 30_000);
    expect(lastPlan(w).rootfs.kind).toBe("snapshot");
    expect(lastPlan(w).workspace).toEqual({ source: "snapshot" });
  });

  it("image path with a complete archive → gen + archive, workspace source archive", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const snap = w.snapshots().at(-1) as { id: string; created_at: number };
    w.ctl().storage.sql.exec(
      `INSERT INTO archives (id, key, kind, state, sha256, size, digest, state_schema, agent_schema, txid, gen, created_at, completed_at)
       VALUES ('ar1', 'a/t1/x.tar.gz', 'online', 'complete', ?, 10, 'sha256:aaaa', 0, 0, '{}', 1, ?, ?)`,
      "a".repeat(64),
      snap.created_at - 1000,
      snap.created_at - 1000,
    );
    w.rt().c.imageMap.oc = NEW_IMAGE; // no snapshot of the new digest → image path
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 30_000);
    const p = lastPlan(w);
    expect([p.rootfs.kind, p.sqlite.kind, p.archive?.archiveId, p.workspace?.source]).toEqual([
      "image",
      "gen",
      "ar1",
      "archive",
    ]);
  });

  it("ocsup refuses a missing workspace (exit 75 mismatch) → ladder, no reply; owner reset → next boot has acceptLoss, then cleared", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    // No usable snapshot left (else F1 defers the digest change and boots the snapshot).
    w.ctl().storage.sql.exec("UPDATE snapshots SET state = 'superseded'");
    w.rt().c.imageMap.oc = NEW_IMAGE;
    const o = w.rt().ocsup;
    let refuse = true;
    o.onBoot = (plan: Record<string, any>) =>
      refuse && plan.workspace?.source === "none" && !plan.workspace?.acceptLoss
        ? { exit: [75, "restore-blocked:mismatch"] }
        : undefined;
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.stops().some((x) => x.cls === "restore-blocked:mismatch"), 30_000);
    const r = await w.ops("restore", { workspace: "reset", acceptLoss: true });
    expect(r.status).toBe(202);
    refuse = false;
    await w.until(() => w.state() === "running", 60_000);
    expect(lastPlan(w).workspace).toEqual({ source: "none", acceptLoss: true });
    expect(w.ctl().meta("workspaceReset")).toBeUndefined();
  });
});

describe("F3 snapshot replan cap", () => {
  it("every snapshot missing: 3 misses in one op → no-snapshot replan → restore-blocked + snapshots-lost alert; no start-loop", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    for (let i = 0; i < 3; i++) {
      await w.rt().call("requestWake", "cli");
      await w.until(() => w.state() === "running", 30_000);
      await w.until(() => w.state() === "asleep", 60_000);
    }
    const snaps = w.snapshots().map((x) => x.id);
    expect(snaps.length).toBeGreaterThanOrEqual(3);
    for (const id of snaps) w.rt().c.snapshots.delete(id);
    w.rt().c.snapshotMissThrows = true;
    const starts0 = startCount(w);
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "backoff", 30_000);
    expect(startCount(w) - starts0).toBe(3); // three snapshot start() calls, none for the blocked plan
    expect(w.stops().at(-1)?.cls).toBe("restore-blocked:mismatch");
    expect(w.stops().some((x) => x.cls === "start-loop")).toBe(false);
    expect(w.alert("snapshots-lost")?.severity).toBe("high");
    expect(lastPlan(w)?.sqlite?.kind).not.toBe("restore-blocked"); // ocsup never got the blocked plan
  });
});

describe("F1 restore stall → next ladder step", () => {
  it("ocsup exit 75 restore-timeout with healthy R2 → ladder L2 at once (not after 3 in 30 min)", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.rt().ocsup.exit(75, "restore-timeout");
    await w.until(() => (w.ladder()?.level ?? 1) === 2, 30_000);
    expect(w.stops().at(-1)?.cls).toBe("restore-timeout");
  });

  it("DO budget:restore (ocsup stuck in phase restore) → destroy, ladder L2", async () => {
    w = await fresh(sut);
    const o = w.rt().ocsup;
    o.stallPhase = "restore";
    await w.cron();
    await w.until(() => w.stops().some((x) => x.cls === "budget:restore"), 60_000);
    expect(w.ladder()?.level).toBe(2);
  });
});

describe("doctor-required loop (oc-m3-rt live finding)", () => {
  it("78 doctor-required on every boot → the Doctor boot's failure is doctor-failed (escalates), not another doctor-required", async () => {
    w = await fresh(sut);
    w.rt().ocsup.onBoot = () => ({ exit: [78, "doctor-required"] });
    await w.cron();
    await w.until(() => w.stops().some((x) => x.cls === "doctor-failed"), 60_000);
    const cls = w.stops().map((x) => x.cls);
    expect(cls.slice(0, 2)).toEqual(["doctor-required", "doctor-failed"]);
    expect(lastPlan(w).runDoctor).toBe(true);
  });
});

describe("Doctor fails on every boot of a new digest (oc-m6-polish live)", () => {
  it("2 doctor-failed on the same digest → one doctor-failed alert, next boot runs without Doctor and starts", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const at = (w.snapshots().at(-1) as { created_at: number }).created_at - 1000;
    w.ctl().storage.sql.exec(
      `INSERT INTO archives (id, key, kind, state, sha256, size, digest, txid, gen, created_at, completed_at, ws_entries)
       VALUES ('ar1', 'a/t1/x.tar.gz', 'online', 'complete', ?, 10, 'sha256:aaaa', '{}', 1, ?, ?, 3)`,
      "a".repeat(64),
      at,
      at,
    );
    w.rt().ocsup.onBoot = (plan) => (plan.runDoctor ? { exit: [78, "doctor-failed"] } : undefined);
    w.rt().c.imageMap.oc = NEW_IMAGE;
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 120_000);
    const doctorStops = w.stops().filter((x) => x.cls === "doctor-failed");
    expect(doctorStops.length).toBe(2);
    expect(lastPlan(w).runDoctor).toBe(false);
    expect(lastPlan(w).rootfs.digest).toBe("sha256:bbbb");
    expect(w.alert("doctor-failed")?.count).toBe(1);
    expect((w.ladder() as { doctorFailDigest?: string } | null)?.doctorFailDigest).toBe("sha256:bbbb");
  });
});
