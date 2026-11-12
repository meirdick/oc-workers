// M4b fixes in the Control DO: L3 (acked, no reply), N11 (wake-source filter), F1 (digest guard), N1 (PITR boot),
// drill J (index rebuild from R2).
import { describe, expect, it } from "vitest";
import { REPLY_ID_STEP, REPLY_WAIT_MS } from "../../src/ctl/inbox";
import { heartbeatDefault, wakeIgnore } from "../../src/ctl/schedule";
import { handleTelegram, TelegramState } from "../../src/gates/fakes";
import { handleTelegramGate } from "../../src/gates/telegram";
import { bootComplete, tg, type World, world } from "./world";

const put = (w: World, body: string) => w.api.inboxPut({ body, headers: { host: "oc.example.workers.dev" } });
const row = (w: World, key: string) =>
  w.db.one<{ state: string; replied_at: number | null; replays: number }>(
    "SELECT state, replied_at, replays FROM inbox WHERE platform_key = ?",
    key,
  );

function awake(w: World, gen = 1) {
  w.install();
  w.api.noteRtState(1, "running");
  w.rt(1).state = "running";
  w.db.run(
    `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
     VALUES (?, 1, ?, 'user', 'prod', 's', '[]', '{"sqlite":{"kind":"fresh"}}', 'fresh', 'booting', 0, 0)`,
    gen,
    `op-${gen}`,
  );
}
const started = (w: World, gen: number) =>
  w.api.onStarted({
    epoch: 1,
    gen,
    opId: `op-${gen}`,
    reason: "user",
    digest: "d",
    wakeAt: 0,
    aliveMs: 1,
    startupzMs: 1,
  });

describe("L3: accepted rows with no reply are replayed with a fresh update_id after a restart", () => {
  it("reply seen → no replay; no reply → one replay with update_id + step; settled after 10 min", async () => {
    const w = world();
    awake(w, 1);
    await started(w, 1);
    put(w, tg(101, 501));
    put(w, tg(102, 502));
    put(w, tg(103, 503));
    await w.api.kickDriver();
    expect(row(w, "101")?.state).toBe("accepted");
    // The gateway replies to chat 501 only (fake Telegram → Control DO).
    w.advance(1000);
    const sink = {
      gateEvent: () => {},
      outbound: (chat: string | number | null, at: number, m: string) =>
        void w.api.gateCall("noteOutbound", [{ chatId: chat, at, method: m }]),
    };
    await handleTelegram(
      new Request("https://api.telegram.org/botT/sendChatAction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: 502, action: "typing" }),
      }),
      sink,
      new TelegramState(),
      () => w.clock.t,
    );
    await handleTelegram(
      new Request("https://api.telegram.org/botT/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: 501, text: "hi" }),
      }),
      sink,
      new TelegramState(),
      () => w.clock.t,
    );
    expect(row(w, "101")?.replied_at).toBe(w.clock.t);
    expect(row(w, "102")?.replied_at).toBeNull(); // a typing action is not a reply
    // Row 103 is older than REPLY_WAIT_MS at the restart: settled, not replayed.
    w.db.run("UPDATE inbox SET accepted_at = ? WHERE platform_key = '103'", w.clock.t - REPLY_WAIT_MS - 1);
    // Crash; new gen; no marker.
    w.rt(1).delivered = [];
    w.advance(5000);
    w.db.run(
      `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
       VALUES (2, 1, 'op-2', 'ladder', 'prod', 's', '[]', '{"sqlite":{"kind":"gen","gen":1}}', 'gen', 'booting', 1, 0)`,
    );
    await started(w, 2);
    await w.api.kickDriver();
    const ids = w.rt(1).delivered.map((d) => JSON.parse(d.body).update_id);
    // 101 (replied) and 103 (settled) go with their own id (the 24 h at-least-once replay; OpenClaw dedupes);
    // 102 (no reply) goes with a fresh id.
    expect(ids).toContain(102 + REPLY_ID_STEP);
    expect(ids).not.toContain(102);
    expect(ids).not.toContain(101 + REPLY_ID_STEP);
    expect(ids).not.toContain(103 + REPLY_ID_STEP);
    expect(row(w, "102")?.replays).toBe(1);
    const replayed = w.rt(1).delivered.find((d) => JSON.parse(d.body).update_id === 102 + REPLY_ID_STEP);
    expect(JSON.parse(replayed?.body ?? "{}").message.message_id).toBe(102 + REPLY_ID_STEP); // dispatch dedupe key
    // A second restart does not replay it with a fresh id again (REPLAY_MAX 1).
    w.rt(1).delivered = [];
    w.advance(1000);
    w.db.run(
      `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
       VALUES (3, 1, 'op-3', 'ladder', 'prod', 's', '[]', '{"sqlite":{"kind":"gen","gen":2}}', 'gen', 'booting', 1, 0)`,
    );
    await started(w, 3);
    await w.api.kickDriver();
    const ids3 = w.rt(1).delivered.map((d) => JSON.parse(d.body).update_id);
    expect(ids3.filter((i) => i > REPLY_ID_STEP)).toEqual([102 + REPLY_ID_STEP]); // same fresh key, deduped
  });

  it("TelegramGate adds inline_query to the gateway's setWebhook list (docs/14 inline wake)", async () => {
    const sent: { ct: string; body: string }[] = [];
    const f = (async (r: Request) => {
      sent.push({ ct: r.headers.get("content-type") ?? "", body: await r.text() });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const sink = { outbound: () => undefined };
    const json = (m: string, body: unknown) =>
      new Request(`https://api.telegram.org/bot123:abc/${m}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const go = (r: Request) => handleTelegramGate(r, sink, () => undefined, f);
    await go(json("setWebhook", { url: "https://x/h", allowed_updates: ["message", "callback_query"] }));
    await go(json("setWebhook", { url: "https://x/h", allowed_updates: ["message", "inline_query"] }));
    await go(json("setWebhook", { url: "https://x/h" })); // no list: Telegram's default has inline_query
    await go(json("sendMessage", { chat_id: 7, allowed_updates: ["message"] })); // other methods: unchanged
    await go(
      new Request("https://api.telegram.org/bot123:abc/setWebhook", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ url: "https://x/h", allowed_updates: '["message"]' }).toString(),
      }),
    );
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      url: "https://x/h",
      allowed_updates: ["message", "callback_query", "inline_query"],
    });
    expect(JSON.parse(sent[1]?.body ?? "").allowed_updates).toEqual(["message", "inline_query"]);
    expect(JSON.parse(sent[2]?.body ?? "")).toEqual({ url: "https://x/h" });
    expect(JSON.parse(sent[3]?.body ?? "").allowed_updates).toEqual(["message"]);
    const form = new URLSearchParams(sent[4]?.body ?? "");
    expect(JSON.parse(form.get("allowed_updates") ?? "")).toEqual(["message", "inline_query"]);
    expect(form.get("url")).toBe("https://x/h");
  });

  it("TelegramGate passes the call through and notes 2xx send* calls only", async () => {
    const seen: [unknown, string][] = [];
    const calls: string[] = [];
    const f = (async (r: Request) => {
      calls.push(r.url);
      return new Response('{"ok":true}', { status: r.url.endsWith("/getMe") ? 200 : 200 });
    }) as unknown as typeof fetch;
    const waits: Promise<unknown>[] = [];
    const sink = { outbound: (c: string | number | null, _at: number, m: string) => void seen.push([c, m]) };
    const mk = (m: string, body: unknown) =>
      new Request(`https://api.telegram.org/bot123:abc/${m}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await handleTelegramGate(mk("sendMessage", { chat_id: 7, text: "x" }), sink, (p) => waits.push(p), f);
    await handleTelegramGate(mk("getMe", {}), sink, (p) => waits.push(p), f);
    await handleTelegramGate(mk("sendChatAction", { chat_id: 7 }), sink, (p) => waits.push(p), f);
    await Promise.all(waits);
    expect(calls).toEqual([
      "https://api.telegram.org/bot123:abc/sendMessage",
      "https://api.telegram.org/bot123:abc/getMe",
      "https://api.telegram.org/bot123:abc/sendChatAction",
    ]);
    expect(seen).toEqual([[7, "sendMessage"]]);
  });
});

describe("N11: wake-source filter list and heartbeat default", () => {
  const S = (proactive: string, wakeOn?: string[]) => ({
    sleep: {
      mode: "auto" as const,
      idleMinutes: 5,
      minSleepMinutes: 10,
      snapshotCostUsd: 0,
      proactive,
      wakeOn,
    },
  });
  it("heartbeat never wakes unless the owner keeps the OpenClaw cadence or lists it; proactive off → ignored", () => {
    expect(wakeIgnore(S("2h@08-22"))).toEqual(["heartbeat"]);
    expect(wakeIgnore(S("off"))).toEqual(["heartbeat", "proactive"]);
    expect(wakeIgnore(S("openclaw"))).toEqual([]);
    expect(wakeIgnore(S("2h@08-22", ["heartbeat"]))).toEqual([]);
    expect(wakeIgnore(S("off", ["proactive"]))).toEqual(["heartbeat"]);
  });

  it("the boot plan carries the list; an owner config gets heartbeat.every 0m unless set", async () => {
    const w = world();
    w.install();
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "op-n11", reason: "user" });
    expect(r.plan.wakeIgnore).toEqual(["heartbeat"]);
    const out = await w.api.ops({
      action: "config",
      method: "POST",
      sub: [],
      query: {},
      body: { doc: { agents: { defaults: { model: { primary: "x" } } } } },
      role: "owner",
    });
    expect(out.status).toBe(200);
    const doc = JSON.parse(
      (w.db.one<{ doc: string }>("SELECT doc FROM config ORDER BY ver DESC LIMIT 1") as { doc: string }).doc,
    );
    expect(doc.agents.defaults).toEqual({ model: { primary: "x" }, heartbeat: { every: "0m" } });
    // Owner set it → kept; OpenClaw cadence → untouched.
    expect(
      heartbeatDefault({ agents: { defaults: { heartbeat: { every: "1h" } } } }, S("2h@08-22")).set,
    ).toBe(false);
    expect(heartbeatDefault({}, S("openclaw")).set).toBe(false);
  });
});

describe("F1: digest guard", () => {
  const snap = (w: World, id: string, at: number, digest = "sha256:img1") =>
    w.db.run(
      `INSERT INTO snapshots (id, image_key, digest, kind, gen, epoch, created_at, state)
       VALUES (?, 'oc', ?, 'sleep', 1, 1, ?, 'ok')`,
      id,
      digest,
      at,
    );
  const arch = (w: World, id: string, at: number, wsEntries: number | null, wsMissing = 0) =>
    w.db.run(
      `INSERT INTO archives (id, key, kind, state, sha256, size, digest, txid, created_at, ws_entries, ws_missing)
       VALUES (?, ?, 'online', 'complete', 'ab', 10, 'sha256:img1', '{}', ?, ?, ?)`,
      id,
      `a/t1/${id}.tar.gz`,
      at,
      wsEntries,
      wsMissing,
    );
  const check = (w: World, body: Record<string, unknown>) =>
    w.api.ops({ action: "deploy-check", method: "POST", sub: [], query: {}, body, role: "owner" });

  it("skew gate: refuses a new digest until an archive with the workspace is newer than the newest snapshot", async () => {
    const w = world();
    w.install();
    w.rt(1).state = "asleep";
    arch(w, "a-first", w.clock.t, 0); // first-boot archive, no workspace (the F1 case)
    w.advance(60_000);
    snap(w, "s1", w.clock.t);
    let r = await check(w, { digest: "sha256:img2" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "archive-stale", why: "no archive with the workspace" });
    expect((await check(w, {})).status).toBe(200); // same image: no guard
    w.advance(60_000);
    arch(w, "a-pre", w.clock.t, 12); // pre-upgrade archive
    r = await check(w, { digest: "sha256:img2" });
    expect(r.status).toBe(200);
    expect((await check(w, { image: true })).status).toBe(200);
  });

  it("boot after a raw deploy: digest change deferred (snapshot path, pre-upgrade archive asked) until it is safe", async () => {
    const w = world();
    w.install();
    await bootComplete(w);
    arch(w, "a-first", w.clock.t, 0);
    w.advance(60_000);
    snap(w, "s1", w.clock.t);
    const r = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "op-f1",
      reason: "wake:webhook",
      liveImages: { oc: "registry/oc@sha256:img2" },
    });
    expect(r.plan.rootfs).toMatchObject({ kind: "snapshot", snapshotId: "s1" });
    expect(r.digest).toBe("sha256:img1");
    expect(w.db.metaJson<{ reason: string; state: string } | null>("archiveRequest", null)).toMatchObject({
      reason: "pre-upgrade",
      state: "pending",
    });
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'digest-deferred'")).not.toBeNull();
    // The archive with the workspace lands; the next boot takes the new digest (image path).
    w.advance(60_000);
    arch(w, "a-pre", w.clock.t, 12);
    const r2 = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "op-f1b",
      reason: "wake:webhook",
      liveImages: { oc: "registry/oc@sha256:img2" },
    });
    expect(r2.digest).toBe("sha256:img2");
    expect(r2.plan.rootfs.kind).toBe("image");
    expect(r2.plan.archive?.archiveId).toBe("a-pre");
  });
});

describe("N1: PITR boot path", () => {
  it("/ops/restore pitr:<ts> → restart, boot restores the gen at ts with cron off, loss window stated, op done", async () => {
    const w = world();
    w.install();
    const g1 = await bootComplete(w, { dbs: ["state/openclaw.sqlite", "memory/main.sqlite"] });
    w.rt(1).state = "running";
    w.advance(120_000);
    const ts = w.clock.t;
    w.advance(60_000);
    const bad = await w.api.ops({
      action: "restore",
      method: "POST",
      sub: [],
      query: {},
      body: { sqlite: `pitr:${new Date(ts).toISOString()}` },
      role: "owner",
    });
    expect(bad.status).toBe(400); // acceptLoss required
    const r = await w.api.ops({
      action: "restore",
      method: "POST",
      sub: [],
      query: {},
      body: { sqlite: `pitr:${new Date(ts).toISOString()}`, acceptLoss: true },
      role: "owner",
    });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ gen: g1.gen, ts: new Date(ts).toISOString(), lossWindowMs: 60_000 });
    expect(String((r.body as { lossWindow: string }).lossWindow)).toContain("are lost");
    expect((r.body as { restart: { stop: unknown; start: unknown } }).restart.start).toBeTruthy();
    // A ts before any complete gen → 404.
    const early = await w.api.ops({
      action: "restore",
      method: "POST",
      sub: [],
      query: {},
      body: { sqlite: `pitr:${ts - 3_600_000}`, acceptLoss: true },
      role: "owner",
    });
    expect(early.status).toBe(404);
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "op-pitr", reason: "user" });
    expect(b.plan.sqlite).toEqual({
      kind: "gen",
      gen: g1.gen,
      ts: new Date(ts).toISOString(),
      dbs: ["memory/main.sqlite", "state/openclaw.sqlite"],
    });
    expect(b.plan.dbs.every((d) => d.lastTxid === 0)).toBe(true);
    expect(b.restoreGens).toEqual([g1.gen]);
    expect(b.plan.overlay).toContainEqual({ path: "cron.enabled", value: false });
    await w.api.onStarted({
      epoch: 1,
      gen: b.gen,
      opId: "op-pitr",
      reason: "user",
      digest: b.digest,
      wakeAt: w.clock.t,
      aliveMs: 1,
      startupzMs: 1,
    });
    expect(w.db.meta("l5")).toBeNull();
    const op = w.db.one<{ state: string }>(
      "SELECT state FROM ops WHERE kind = 'l5' ORDER BY created_at DESC LIMIT 1",
    );
    expect(op?.state).toBe("done");
    // The next boot is a normal one (newest gen, cron on).
    const b2 = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "op-after", reason: "user" });
    expect(b2.plan.sqlite).toMatchObject({ kind: "gen" });
    expect((b2.plan.sqlite as { ts?: string }).ts).toBeUndefined();
    expect(b2.plan.overlay).toEqual([]);
  });
});

describe("drill J: index rebuild from R2 after the Control DO storage is replaced", () => {
  it("rebuilds gens, archives, config, creds, marker; boots newest archive + newest complete gen, not rewound", async () => {
    const { FakeStorage } = await import("../harness/storage");
    const { hwmKey } = await import("../../src/ctl/gens");
    const { sidecarKey } = await import("../../src/gates/archive-policy");
    const { shaDigest, shaInit, shaUpdate } = await import("../../src/gates/sha256");
    const w = world({ timers: { credsCopyMs: 1 } });
    w.install();
    const ltx = (gen: number, db: string, max: number) =>
      w.r2.put(
        `r/t1/g${gen}/${db}/0000/${(1).toString(16).padStart(16, "0")}-${max.toString(16).padStart(16, "0")}.ltx`,
        "x".repeat(200),
      );
    const g1 = await bootComplete(w);
    await ltx(g1.gen, "state/openclaw.sqlite", 5);
    await w.api.ops({
      action: "config",
      method: "POST",
      sub: [],
      query: {},
      body: { doc: { channels: {} } },
      role: "owner",
    });
    w.ledger.credsPut(g1.gen, "credentials/x.json", {
      seq: 1,
      sha256: "a".repeat(64),
      mode: 0o600,
      b64: btoa("x"),
    });
    w.advance(10);
    await w.core.credsCopyStep(); // creds copy + config copy
    w.advance(60_000);
    const g2 = await bootComplete(w);
    await ltx(g2.gen, "state/openclaw.sqlite", 9);
    await ltx(g2.gen, "memory/main.sqlite", 3);
    // Archive 1 (older): sidecar from the gate. Archive 2 (newer): no sidecar (pre-M4b), re-hashed.
    const bytes = (s: string) => new TextEncoder().encode(s);
    const sha = (s: string) => shaDigest(shaUpdate(shaInit(), bytes(s)));
    const k1 = "a/t1/20261101T100100Z-v1-aaaaaaaaaaaa.tar.gz";
    const k2 = "a/t1/20261101T100500Z-v1-aaaaaaaaaaaa.tar.gz";
    await w.r2.put(k1, "archive-one");
    await w.r2.put(
      sidecarKey(k1),
      JSON.stringify({
        v: 1,
        id: "A1",
        key: k1,
        sha256: sha("archive-one"),
        size: 11,
        ws_entries: 5,
        created_at: Date.parse("2026-11-01T10:01:00Z"),
        txid: "{}",
      }),
    );
    await w.r2.put(k2, "archive-two");
    await w.r2.put(hwmKey("t1"), JSON.stringify({ gen: g2.gen + 1, credsSeq: 1, epoch: 1, at: w.clock.t }));
    // Wipe: new Control DO over empty storage, same R2. The cron ensure installs epoch 1, checks the hwm.
    const w2 = world({ timers: { credsCopyMs: 1 }, storage: new FakeStorage(), r2: w.r2, clock: w.clock });
    w2.install();
    expect((await w2.core.hwmCheck()).rewound).toBe(true);
    await w2.core.credsCopyStep();
    const rep = w2.db.metaJson<{
      ok: boolean;
      completeGens: number;
      archives: number;
      archivesHashed: number;
      config: number;
    } | null>("rebuild", null);
    expect(rep).toMatchObject({ ok: true, completeGens: 2, archives: 2, archivesHashed: 1, config: 1 });
    expect(w2.db.meta("ctlState")).toBe("ctl-rebuilt");
    expect(w2.db.metaNum("initialized", 0)).toBe(1);
    expect(w2.ledger.credsGet("credentials/x.json")?.b64).toBe(btoa("x"));
    const b = await w2.api.beginBoot({ epoch: 1, mode: "prod", opId: "op-j", reason: "wake:cli" });
    expect(b.gen).toBe(g2.gen + 2); // above the hwm
    expect(b.plan.sqlite).toMatchObject({ kind: "gen", gen: g2.gen });
    expect(b.plan.dbs.map((d) => [d.db, d.lastTxid])).toEqual([
      ["memory/main.sqlite", 3],
      ["state/openclaw.sqlite", 9],
    ]);
    expect(b.plan.rootfs.kind).toBe("image");
    expect(b.plan.archive?.key).toBe(k2);
    expect(b.plan.archive?.sha256).toBe(sha("archive-two"));
    expect(b.plan.configVer).toBe(1);
  });
});
