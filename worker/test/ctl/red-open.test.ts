// Open red-team items a Telegram install hits (docs/research/red-team-reconciliation.md §8): Control DO side.
import { describe, expect, it } from "vitest";
import { alert, setAlertSink } from "../../src/ctl/alerts";
import { DEDUPE_ROWS, REPLAY_WINDOW_MS } from "../../src/ctl/driver";
import { planGc } from "../../src/ctl/gc";
import { bootComplete, tg, type World, world } from "./world";

const H = 3_600_000;
const put = (w: World, body: string) => w.api.inboxPut({ body, headers: { host: "oc.example.workers.dev" } });
const state = (w: World, key: string) =>
  w.db.one<{ state: string }>("SELECT state FROM inbox WHERE platform_key = ?", key)?.state;

function awake(w: World) {
  w.install();
  w.api.noteRtState(1, "running");
  w.rt(1).state = "running";
}
function gen(w: World, g: number, kind = "gen") {
  w.db.run(
    `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
     VALUES (?, 1, ?, 'ladder', 'prod', 's', '[]', ?, ?, 'booting', 1, 0)`,
    g,
    `op-${g}`,
    JSON.stringify({ sqlite: { kind } }),
    kind,
  );
}
const started = (w: World, g: number) =>
  w.api.onStarted({
    epoch: 1,
    gen: g,
    opId: `op-${g}`,
    reason: "user",
    digest: "d",
    wakeAt: 0,
    aliveMs: 1,
    startupzMs: 1,
  });
/** An accepted row with a settled reply (replied_at 0), so only the L6 plain replay can pick it. */
function accepted(w: World, key: number, receivedAgo: number, acceptedAgo = receivedAgo) {
  w.db.run(
    `INSERT INTO inbox (id, route, account, platform_key, received_at, sender_id, chat_id, headers, body, state,
       accepted_at, replied_at) VALUES (?, '/telegram-webhook', 'default', ?, ?, '7', '7', '{}', ?, 'accepted', ?, 0)`,
    `r${key}`,
    String(key),
    w.clock.t - receivedAgo,
    tg(key, 7),
    w.clock.t - acceptedAgo,
  );
}
async function crashBoot(w: World, g: number) {
  w.rt(1).delivered = [];
  gen(w, g);
  await started(w, g);
  await w.api.kickDriver();
  return w.rt(1).delivered.map((d) => JSON.parse(d.body).update_id as number);
}

describe("L6/S0.4: a restart replays only rows the gateway may lack", () => {
  it("replays rows after the last confirmed send or inside the window; settles the rest", async () => {
    const w = world();
    awake(w);
    gen(w, 1, "fresh");
    await started(w, 1);
    accepted(w, 101, 3 * H); // before the last send, outside the window → settled
    accepted(w, 102, 40 * 60_000); // after the last send → replayed
    accepted(w, 103, 60_000); // before the last send but inside the window → replayed
    accepted(w, 104, 25 * H); // older than 24 h → never replayed
    w.api.gateCall("noteOutbound", [{ chatId: 9, at: w.clock.t - 30_000, method: "sendMessage" }]);
    w.api.gateCall("noteOutbound", [{ chatId: 9, at: w.clock.t - 10_000, method: "sendChatAction" }]);
    expect(Number(w.db.meta("lastOutboundAt"))).toBe(w.clock.t - 30_000); // typing is not a send
    w.db.run("UPDATE inbox SET accepted_at = ? WHERE platform_key = '102'", w.clock.t - 20_000);
    const ids = await crashBoot(w, 2);
    expect(ids.sort()).toEqual([102, 103]);
    expect(state(w, "101")).toBe("replicated");
    expect(state(w, "104")).toBe("replicated");
    // A send after the re-accept, then the window passes: the next restart replays nothing.
    w.advance(1000);
    w.api.gateCall("noteOutbound", [{ chatId: 9, at: w.clock.t, method: "sendMessage" }]);
    w.advance(REPLAY_WINDOW_MS + 1);
    expect(await crashBoot(w, 3)).toEqual([]);
  });

  it("never replays a row past the gateway's dedupe horizon (newest DEDUPE_ROWS rows)", async () => {
    const w = world();
    awake(w);
    gen(w, 1, "fresh");
    await started(w, 1);
    // DEDUPE_ROWS + 1 rows, all after the last send (none seen), oldest first.
    for (let i = 0; i <= DEDUPE_ROWS; i++) accepted(w, 1000 + i, H - i * 1000);
    gen(w, 2);
    await started(w, 2);
    const n = (s: string) =>
      w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE state = ?", s)?.n ?? 0;
    expect(n("pending")).toBe(DEDUPE_ROWS);
    expect(state(w, "1000")).toBe("replicated");
    expect(state(w, "1001")).toBe("pending");
  });

  it("always-on: accepted rows go 24 h after receipt (no 10,000-row cap creep)", async () => {
    const w = world({ real: true });
    awake(w);
    accepted(w, 1, 25 * H);
    accepted(w, 2, H);
    await w.core.tick();
    expect(state(w, "1")).toBeUndefined();
    expect(state(w, "2")).toBe("accepted");
    put(w, tg(3, 7)); // still takes new rows
    expect(state(w, "3")).toBeDefined();
  });
});

describe("N7/Z0.m12: a gen is verified by a restore probe, once, and gen GC anchors on it", () => {
  const DAY = 24 * H;
  type V = { verified: boolean | null; why: string | null };
  function probe(w: World, answers: V[]) {
    const calls: { gen: number; dbs: string[] }[] = [];
    Object.assign(w.rt(1), {
      verifyGen: async (a: { gen: number; dbs: string[] }) => {
        calls.push({ gen: a.gen, dbs: a.dbs });
        return answers.shift() ?? { verified: true, why: null };
      },
    });
    return calls;
  }
  const genState = (w: World, g: number) =>
    w.db.one<{ state: string }>("SELECT state FROM gens WHERE gen = ?", g)?.state;

  it("pass → verified; the alarm does not probe the same gen again; asleep → no probe", async () => {
    const w = world();
    w.install();
    const { gen } = await bootComplete(w, {
      dbs: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
    });
    const calls = probe(w, [{ verified: true, why: null }]);
    w.api.noteRtState(1, "asleep");
    await w.core.tick();
    expect(calls).toEqual([]);
    w.api.noteRtState(1, "running");
    expect(w.core.nextAlarmAt()).toBe(w.clock.t + w.ctx.timers.opTickMs);
    await w.core.tick();
    expect(calls).toEqual([
      { gen, dbs: ["agents/main/agent/openclaw-agent.sqlite", "state/openclaw.sqlite"] },
    ]);
    expect(genState(w, gen)).toBe("verified");
    await w.core.tick();
    expect(calls.length).toBe(1);
  });

  it("a failed quick_check marks the gen bad with an alert; no verdict leaves it complete, not retried", async () => {
    const w = world();
    w.install();
    w.api.noteRtState(1, "running");
    const calls = probe(w, [
      { verified: false, why: "state/openclaw.sqlite quick_check *** in database main ***" },
      { verified: null, why: "restore-blocked:infra" },
    ]);
    const g1 = (await bootComplete(w)).gen;
    await w.core.tick();
    expect(genState(w, g1)).toBe("bad");
    expect(w.db.one<{ open: number }>("SELECT open FROM alerts WHERE class = 'gen-bad'")?.open).toBe(1);
    const g2 = (await bootComplete(w)).gen;
    await w.core.tick();
    await w.core.tick();
    expect(genState(w, g2)).toBe("complete");
    expect(calls.map((c) => c.gen)).toEqual([g1, g2]);
  });

  it("GC deletes a stale gen only below the newest verified gen", async () => {
    const w = world();
    w.install();
    const gens: number[] = [];
    for (let i = 0; i < 6; i++) {
      gens.push((await bootComplete(w)).gen);
      w.advance(2 * DAY);
    }
    w.db.run("UPDATE gens SET state = 'verified' WHERE gen = ?", gens[2] as number);
    w.advance(10 * DAY);
    const p = planGc(w.ctx);
    // gens 0-1: below the verified anchor; 3-4: newer than it, not verified → kept; 5 newest → kept.
    expect(p.delete).toEqual([gens[0], gens[1]]);
  });
});

describe("Z2.9/Z2.11: the dead-man is never silent", () => {
  it("daily heartbeat with a sink (sent past minSeverity high); no sink → alerts off, no alerts-none", async () => {
    const w = world({ settings: { alerts: { minSeverity: "high", dedupeMinutes: 60 } } as never });
    w.install();
    await w.core.dailyIfDue(true);
    await w.api.flushAlerts();
    expect(w.sent.some((x) => x.body.includes("daily heartbeat"))).toBe(true);
    const info = (
      await w.api.ops({ action: "alerts", method: "GET", sub: [], query: {}, body: {}, role: "owner" })
    ).body as { sink: { lastOkAt: number | null; failing: boolean; heartbeatAt: number | null } };
    expect(info.sink.lastOkAt).toBe(w.clock.t);
    expect(info.sink.heartbeatAt).toBe(w.clock.t);
    expect(info.sink.failing).toBe(false);
    const n = world({ alertUrl: null });
    n.install();
    await n.core.dailyIfDue(true);
    expect(n.db.one("SELECT open FROM alerts WHERE class = 'alerts-none'")).toBeNull();
    expect(n.db.one("SELECT open FROM alerts WHERE class = 'heartbeat'")).toBeNull();
  });

  it("alerts off: an alerts-none left open by an older version is closed; alerts are still recorded", async () => {
    const n = world({ alertUrl: null });
    n.install();
    alert(n.ctx, "alerts-none", "warn", "no alert sink");
    await n.core.dailyIfDue(true);
    expect(n.db.one<{ open: number }>("SELECT open FROM alerts WHERE class = 'alerts-none'")?.open).toBe(0);
    await n.api.alert({ class: "gate-down", severity: "high" });
    expect(await n.api.flushAlerts()).toEqual({ sent: 0, failed: 0 });
    expect(n.db.one<{ open: number }>("SELECT open FROM alerts WHERE class = 'gate-down'")?.open).toBe(1);
    // The console's Off button closes it too.
    alert(n.ctx, "alerts-none", "warn", "no alert sink");
    setAlertSink(n.ctx, "");
    expect(n.db.one<{ open: number }>("SELECT open FROM alerts WHERE class = 'alerts-none'")?.open).toBe(0);
  });

  it("a sink that refuses shows failing; deadman-silent 2 h after the last CI post", async () => {
    const w = world();
    w.install();
    w.setSink(500);
    await w.core.dailyIfDue(true);
    await w.api.flushAlerts();
    const st = (await w.core.status()) as { sink: { failing: boolean; lastOkAt: number | null } };
    expect(st.sink).toMatchObject({ failing: true, lastOkAt: null });
    await w.api.ops({
      action: "ci",
      method: "POST",
      sub: [],
      query: {},
      body: { deadman: "ok" },
      role: "ci",
    });
    w.advance(H);
    await w.core.tick();
    expect(w.db.one("SELECT 1 FROM alerts WHERE class = 'deadman-silent' AND open = 1")).toBeFalsy();
    w.advance(H + 1);
    await w.core.tick();
    expect(w.db.one("SELECT 1 FROM alerts WHERE class = 'deadman-silent' AND open = 1")).toBeTruthy();
  });

  it("deadman-silent reaches a minSeverity high sink once a day, not once an hour", async () => {
    const w = world({ settings: { alerts: { minSeverity: "high", dedupeMinutes: 60 } } as never });
    w.install();
    await w.api.ops({
      action: "ci",
      method: "POST",
      sub: [],
      query: {},
      body: { deadman: "ok" },
      role: "ci",
    });
    const sends = () => w.sent.filter((x) => x.body.includes("deadman-silent")).length;
    w.advance(2 * H + 1);
    for (let i = 0; i < 10; i++) {
      await w.core.tick();
      await w.api.flushAlerts();
      w.advance(H);
    }
    expect(sends()).toBe(1);
    w.advance(15 * H);
    await w.core.tick();
    await w.api.flushAlerts();
    expect(sends()).toBe(2);
    // The dead-man posts again: resolved, no more sends.
    await w.api.ops({
      action: "ci",
      method: "POST",
      sub: [],
      query: {},
      body: { deadman: "ok" },
      role: "ci",
    });
    await w.core.tick();
    expect(w.db.one("SELECT 1 FROM alerts WHERE class = 'deadman-silent' AND open = 1")).toBeFalsy();
  });
});

describe("F11: archive GC runs on each archive completion", () => {
  it("12 dirty-cadence archives in one day: completion verifies the newest and keeps the newest 8", async () => {
    const w = world();
    w.install();
    const ids: string[] = [];
    const body = new TextEncoder().encode("archive-bytes");
    const sha = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    for (let i = 0; i < 12; i++) {
      const id = `a${String(i).padStart(2, "0")}`;
      const key = `a/t1/${id}.tar.gz`;
      await w.r2.put(key, body);
      w.db.run(
        `INSERT INTO archives (id, key, kind, state, created_at) VALUES (?, ?, 'online', 'open', ?)`,
        id,
        key,
        w.clock.t,
      );
      w.api.gateCall("archiveFinish", [id, true, { sha256: sha, size: body.length, parts: 1 }]);
      ids.push(id);
      w.advance(15 * 60_000);
    }
    expect(w.db.meta("archiveGcDue")).toBe("1");
    expect(w.core.nextAlarmAt()).toBeLessThanOrEqual(w.clock.t + w.ctx.timers.opTickMs);
    w.db.setMeta("dailyDay", new Date(w.clock.t).toISOString().slice(0, 10)); // the daily job is not the trigger
    await w.core.tick();
    const live = w.db
      .all<{ id: string }>("SELECT id FROM archives WHERE state = 'complete' ORDER BY id")
      .map((r) => r.id);
    // Newest 8 (a04-a11; a11 is also the day's and week's keep); a00-a03 deleted from R2.
    expect(live).toEqual(ids.slice(4));
    expect(await w.r2.head("a/t1/a02.tar.gz")).toBeNull();
    expect(w.db.meta("archiveGcDue")).toBeNull();
  });
});

describe("S0.10: a group or stranger never wakes or holds the install", () => {
  it("awake: stranger and unlisted group delivered quietly, no wake, not counted by the sleep gate", async () => {
    const w = world();
    awake(w);
    w.api.gateCall("wakeAllow", [{ userIds: ["111"], groupChatIds: ["-5"] }]);
    expect(put(w, tg(1, 999, 999))).toMatchObject({ state: "pending", wake: false });
    expect(put(w, tg(2, 111, -9))).toMatchObject({ state: "pending", wake: false }); // owner in an unlisted group
    expect(put(w, tg(3, 999, -5))).toMatchObject({ state: "pending", wake: true }); // listed group
    expect((await w.api.sleepInputs()).inboxBusy).toBe(1);
    gen(w, 1, "fresh");
    await started(w, 1);
    await w.api.kickDriver();
    const quiet = w.rt(1).delivered.map((d) => [JSON.parse(d.body).update_id, !!d.quiet]);
    expect(quiet.sort()).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it("quiescing: a stranger's row is held (cannot abort the sleep); quiet pending rows go held at sleep", async () => {
    const w = world();
    awake(w);
    w.api.gateCall("wakeAllow", [{ userIds: ["111"], groupChatIds: [] }]);
    put(w, tg(1, 999, 999));
    w.api.noteRtState(1, "quiescing");
    expect(state(w, "1")).toBe("held");
    expect(put(w, tg(2, 999, -9))).toMatchObject({ state: "held", wake: false });
    expect(put(w, tg(3, 111, 111))).toMatchObject({ state: "pending", wake: true });
  });

  it("asleep: the init owner wakes from an unlisted group; a listed user there is held", () => {
    const w = world();
    w.install();
    w.api.gateCall("wakeAllow", [{ userIds: ["111"], groupChatIds: ["-5"] }]);
    w.api.noteRtState(1, "asleep");
    w.rt(1).state = "asleep";
    w.db.setMeta("ownerTelegramId", "222");
    expect(put(w, tg(1, 222, -9))).toMatchObject({ state: "pending", wake: true });
    expect(put(w, tg(2, 222, 222))).toMatchObject({ state: "pending", wake: true });
    expect(put(w, tg(3, 111, -9))).toMatchObject({ state: "held", wake: false });
    expect(put(w, tg(4, 999, 999))).toMatchObject({ state: "held", wake: false });
  });
});

describe("S1.11: pairing without --wait-pair", () => {
  const ops = (w: World, method: string, sub: string[], body: Record<string, unknown> = {}) =>
    w.api.ops({ action: "pairing", method, sub, query: { ch: "telegram" }, body, role: "owner" });
  function asleepWithTelegram(w: World) {
    w.install();
    w.db.run(
      "INSERT INTO config (ver, status, source, doc, created_at) VALUES (1, 'good', 'owner', ?, ?)",
      JSON.stringify({ channels: { telegram: { enabled: true, dmPolicy: "pairing" } } }),
      w.clock.t - 10,
    );
    w.api.gateCall("wakeAllow", [{ userIds: [], groupChatIds: [] }]);
    w.api.noteRtState(1, "asleep");
    w.rt(1).state = "asleep";
  }

  it("the owner's first DM wakes and is approved once; a stranger's DM stays listed for 24 h", async () => {
    const w = world({ real: true });
    asleepWithTelegram(w);
    expect((await ops(w, "POST", ["owner"], { id: "-1" })).status).toBe(400);
    expect((await ops(w, "POST", ["owner"], { id: "4242" })).status).toBe(200);
    // A stranger first: held, no wake, listed with a code.
    expect(put(w, tg(1, 999, 999))).toMatchObject({ state: "held", wake: false });
    w.advance(20 * H);
    const list = (await ops(w, "GET", [])).body as { requests: { id: string }[]; owner: string };
    expect(list.requests.map((q) => q.id)).toEqual(["999"]);
    expect(list.owner).toBe("4242");
    // The owner: wakes (on the wake list) and is approved without a code.
    expect(put(w, tg(2, 4242, 4242))).toMatchObject({ state: "pending", wake: true });
    await w.core.ownerApproving;
    const doc = JSON.parse(
      (w.db.one<{ doc: string }>("SELECT doc FROM config ORDER BY ver DESC LIMIT 1") as { doc: string }).doc,
    );
    expect(doc.channels.telegram.allowFrom).toEqual(["4242"]);
    const vers = w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM config")?.n;
    put(w, tg(3, 4242, 4242));
    await w.core.ownerApproving;
    expect(w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM config")?.n).toBe(vers);
    // Approved once: the marker stays.
    expect(w.db.meta("ownerApprovedAt")).not.toBeNull();
  });
});

describe("L4 and N6: CredStore fence and path cap", () => {
  const v = (seq: number) => ({ seq, sha256: "a".repeat(64), mode: 0o600, b64: "e30=" });
  it("L4: a gate write from a gen with no row (wiped DO) or an older gen is refused in the transaction", async () => {
    const w = world();
    w.install();
    expect(w.ledger.credsPut(7, "credentials/a.json", v(1), true)).toEqual({ ok: false, error: "stale" });
    const g1 = (await bootComplete(w)).gen;
    expect(w.ledger.credsPut(g1, "credentials/a.json", v(1), true)).toMatchObject({
      ok: true,
      applied: true,
    });
    const g2 = (await bootComplete(w)).gen;
    expect(w.ledger.credsPut(g1, "credentials/a.json", v(2), true)).toEqual({ ok: false, error: "stale" });
    expect(w.ledger.credsDelete(g1, "credentials/a.json", 3, true)).toEqual({ ok: false, error: "stale" });
    expect(w.ledger.credsPut(g2, "credentials/a.json", v(2), true)).toMatchObject({
      ok: true,
      applied: true,
    });
  });

  it("N6: tombstones do not count toward the 500-path cap; total rows stay under 2 × cap", async () => {
    const w = world();
    w.install();
    const g = (await bootComplete(w)).gen;
    const { CAPS } = await import("../../src/gates/ledger");
    for (let i = 0; i < CAPS.credPaths; i++) {
      expect(w.ledger.credsPut(g, `credentials/k${i}.json`, v(1), true).ok).toBe(true);
      w.ledger.credsDelete(g, `credentials/k${i}.json`, 2, true);
    }
    expect(w.ledger.credsPut(g, "credentials/new.json", v(1), true)).toMatchObject({
      ok: true,
      applied: true,
    });
    for (let i = 0; i < CAPS.credPaths - 1; i++) w.ledger.credsDelete(g, `credentials/t${i}.json`, 1, true);
    expect(w.ledger.credsPut(g, "credentials/over.json", v(1), true)).toEqual({
      ok: false,
      error: "creds-cap",
    }); // A day later the oldest tombstones go and new paths are taken again (Baileys pre-key churn).
    w.advance(25 * 3_600_000);
    expect(w.ledger.credsPut(g, "credentials/over.json", v(1), true)).toMatchObject({
      ok: true,
      applied: true,
    });
    const n = w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM creds")?.n ?? 0;
    expect(n).toBeLessThan(2 * CAPS.credPaths);
  });
});

describe("N4: the TTL guard never loops", () => {
  const snap = (w: World) =>
    w.db.run(
      `INSERT INTO snapshots (id, image_key, digest, kind, gen, epoch, created_at, state)
       VALUES ('s1', 'oc', 'sha256:img1', 'sleep', 1, 1, ?, 'ok')`,
      w.clock.t,
    );
  it("TTL 1 d + 25 min → guard half the TTL ahead; 30 d → ttlEnd − 2 d", () => {
    const short = world({ real: true, timers: { snapshotTtlMs: 24 * H + 25 * 60_000 } });
    short.install();
    snap(short);
    const g = short.api.core.wakePlan({ nextWakeAtMs: null, lastWakeAt: short.clock.t }).ttlGuard as number;
    expect(g).toBe(short.clock.t + (24 * H + 25 * 60_000) / 2);
    const long = world({ real: true });
    long.install();
    snap(long);
    const l = long.api.core.wakePlan({ nextWakeAtMs: null, lastWakeAt: long.clock.t }).ttlGuard;
    expect(l).toBe(long.clock.t + 28 * 24 * H);
  });
});
