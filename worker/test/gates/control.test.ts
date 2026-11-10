// ControlGate (spec §17; scenarios #8, #39, #70-#72 of §21.2). Every 2xx JSON answer is checked against the
// contract.mjs response schema of its route.
import { describe, expect, it } from "vitest";
import { routeFor, validate } from "../../src/core/contract";
import { shadowPathOk } from "../../src/gates/control";
import { HELLO_BURST } from "../../src/gates/ledger";
import { hmacHex, plan, rid, SECRET, sha, World } from "./harness";

async function ok(r: Response, method: string, path: string) {
  const body = (await r.json()) as Record<string, unknown>;
  expect(r.status, JSON.stringify(body)).toBeLessThan(300);
  const res = routeFor(method, path.split("?")[0] as string)?.res;
  if (res) expect(validate(res, body)).toEqual([]);
  return body;
}
async function bound() {
  const w = new World();
  expect((await w.boot()).status).toBe(200);
  return w;
}
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

describe("auth order (§17.1)", () => {
  it("404 route, hello without secret, 401 secret, 409 before boot binds an iid", async () => {
    const w = new World();
    expect((await w.control("GET", "/v1/nope")).status).toBe(404);
    const ch = rid() + rid();
    const h = await w.control("POST", "/v1/hello", { challenge: ch, pv: 1 }, { secret: null });
    const hb = await ok(h, "POST", "/v1/hello");
    expect(hb).toEqual({ proof: hmacHex(SECRET, `oc-hello\0${ch}`), pv: [1] });
    expect(
      (
        await w.control("POST", "/v1/heartbeat", w.env({ seq: 1, phase: "boot", draining: false }), {
          secret: "x".repeat(64),
        })
      ).status,
    ).toBe(401);
    const pre = await w.control("POST", "/v1/heartbeat", w.env({ seq: 1, phase: "boot", draining: false }));
    expect([pre.status, ((await pre.json()) as { error: string }).error]).toEqual([409, "stale"]);
  });

  it("shape 400, unknown fields ignored, envelope mismatch 409, wrong iid 409", async () => {
    const w = await bound();
    expect(
      (await w.control("POST", "/v1/event", w.env({ kind: "nope", ts: 1 }), { iid: w.iid })).status,
    ).toBe(400);
    expect(
      (
        await w.control("POST", "/v1/event", w.env({ kind: "startupz", ts: 1, extra: { x: 1 } }), {
          iid: w.iid,
        })
      ).status,
    ).toBe(200);
    expect(
      (await w.control("POST", "/v1/event", w.env({ kind: "startupz", ts: 1, gen: 9 }), { iid: w.iid }))
        .status,
    ).toBe(409);
    expect(
      (await w.control("POST", "/v1/event", w.env({ kind: "startupz", ts: 1 }), { iid: rid() })).status,
    ).toBe(409);
    expect(
      (await w.control("POST", "/v1/event", "{bad", { iid: w.iid, raw: new TextEncoder().encode("{bad") }))
        .status,
    ).toBe(400);
  });

  it("stale gen: 409 and nothing written to CredStore (#8)", async () => {
    const w = await bound();
    w.addGen(2);
    w.cache.current.clear();
    const r = await w.control(
      "PUT",
      "/v1/creds/a.json",
      w.env({ seq: 1, sha256: sha("x"), mode: 0o600, b64: b64("x") }),
      { iid: w.iid },
    );
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([409, "stale"]);
    expect(w.sql("SELECT * FROM creds")).toEqual([]);
  });

  it("Control DO down → 503 ctl-unavailable", async () => {
    const w = await bound();
    w.ctlDown = true;
    w.cache.current.clear();
    const r = await w.control("GET", "/v1/creds/manifest", undefined, { iid: w.iid });
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([503, "ctl-unavailable"]);
  });
});

describe("hello rate (#71)", () => {
  it("burst of HELLO_BURST then 4/s → 429; > 200 per boot → one hello-flood alert, proofs still served at 1/s", async () => {
    const w = new World();
    const ch = rid() + rid();
    const hello = () => w.control("POST", "/v1/hello", { challenge: ch, pv: 1 }, { secret: null });
    for (let i = 0; i < HELLO_BURST; i++) expect((await hello()).status).toBe(200);
    expect((await hello()).status).toBe(429);
    for (let i = 0; i < 205; i++) {
      w.clock.t += 1000;
      expect((await hello()).status).toBe(200);
    }
    expect(w.sql("SELECT class, count FROM alerts")).toEqual([{ class: "hello-flood", count: 1 }]);
    expect(w.ledger.helloServed(1)).toBe(true);
  });
});

describe("/v1/boot (#70)", () => {
  it("same iid → same plan; other iid → reboot-detected + gen abandoned; wrong pv → 409 pv", async () => {
    const w = new World();
    const a = await ok(await w.boot(), "POST", "/v1/boot");
    expect(a.status).toBe("ok");
    expect(w.rt.bound).toEqual([{ gen: 1, iid: w.iid }]);
    const b = await ok(await w.boot(), "POST", "/v1/boot");
    expect(b).toEqual(a);
    expect(w.rt.bound).toHaveLength(1);
    const pv = await w.control("POST", "/v1/boot", w.env({ iid: w.iid, pv: 2 }));
    expect([pv.status, ((await pv.json()) as { error: string }).error]).toEqual([409, "pv"]);
    const other = await ok(await w.boot(rid()), "POST", "/v1/boot");
    expect(other).toEqual({ status: "reboot-detected" });
    expect(w.sql("SELECT state FROM gens WHERE gen = 1")).toEqual([{ state: "abandoned" }]);
    // the abandoned gen is stale from now on
    const hb = await w.control("POST", "/v1/heartbeat", w.env({ seq: 1, phase: "boot", draining: false }), {
      iid: w.iid,
    });
    expect(hb.status).toBe(409);
  });

  it("plan from the gens row, with inst/epoch/gen filled", async () => {
    const w = new World({ gen: 5 });
    w.sql(
      "UPDATE gens SET plan = ? WHERE gen = 5",
      JSON.stringify(plan(5, { sqlite: { kind: "gen", gen: 4 }, restoreGens: [4] })),
    );
    const a = await ok(await w.boot(), "POST", "/v1/boot");
    expect(a.plan).toMatchObject({ gen: 5, inst: "t1", epoch: 1, sqlite: { kind: "gen", gen: 4 } });
  });
});

describe("heartbeat, event, alert", () => {
  it("ack {ok, gen, tier, at, replica}; stop:true from the Runtime DO; another rt gen → 409", async () => {
    const w = await bound();
    let seq = 0;
    const hb = () =>
      w.control(
        "POST",
        "/v1/heartbeat",
        w.env({ seq: ++seq, phase: "running", draining: false, lastActivityAt: 5, channels: [] }),
        { iid: w.iid },
      );
    const a = await ok(await hb(), "POST", "/v1/heartbeat");
    expect(a).toMatchObject({ ok: true, gen: 1, tier: "normal", at: w.now(), replica: { gen: 1, dbs: {} } });
    expect(a.stop).toBeUndefined();
    expect(w.rt.hb[0]).toMatchObject({ seq: 1, lastActivityAt: 5 });
    expect(w.notes[0]).toMatchObject({ gen: 1, channels: [], lastActivityAt: 5 });
    w.rtStop = true;
    expect((await ok(await hb(), "POST", "/v1/heartbeat")).stop).toBe(true);
    w.rtGen = 2;
    expect((await hb()).status).toBe(409);
  });

  it("event → ring + Runtime DO; seeded → gendb.seeded_at; alert dedupe 1 per class per hour", async () => {
    const w = await bound();
    w.ledger.recordUpload({
      key: "r/t1/g1/state/openclaw.sqlite/0000/0000000000000001-0000000000000002.ltx",
      bytes: 9,
    });
    await ok(
      await w.control("POST", "/v1/event", w.env({ kind: "seeded", ts: 1 }), { iid: w.iid }),
      "POST",
      "/v1/event",
    );
    expect(w.rt.ev.map((e) => e.kind)).toEqual(["seeded"]);
    expect(w.sql("SELECT seeded_at FROM gendb")).toEqual([{ seeded_at: w.now() }]);
    const al = () =>
      w.control("POST", "/v1/alert", w.env({ class: "disk-high", severity: "warn", detail: "90%" }), {
        iid: w.iid,
      });
    expect((await ok(await al(), "POST", "/v1/alert")).sent).toBe(true);
    expect((await ok(await al(), "POST", "/v1/alert")).sent).toBe(false);
    w.clock.t += 3_600_000;
    expect((await ok(await al(), "POST", "/v1/alert")).sent).toBe(true);
    expect(w.sql("SELECT count FROM alerts WHERE class = 'disk-high'")).toEqual([{ count: 3 }]);
  });
});

describe("/v1/log (#39)", () => {
  it("segments under l/<inst>/<day>/; over 20 MB → 429 + one log-cap alert; new day → new key", async () => {
    const w = await bound();
    const log = (lines: string[]) => w.control("POST", "/v1/log", w.env({ lines }), { iid: w.iid });
    await ok(await log(["a", "b"]), "POST", "/v1/log");
    expect(w.r2.keys("l/")).toEqual(["l/t1/2026-10-31/1-1.ndjson"]);
    w.sql("UPDATE budget_day SET log_bytes = 20000000");
    expect((await log(["c"])).status).toBe(429);
    expect((await log(["d"])).status).toBe(429);
    expect(w.sql("SELECT count FROM alerts WHERE class = 'log-cap'")).toEqual([{ count: 1 }]);
    w.clock.t += 86_400_000;
    w.cache.current.clear();
    await ok(await log(["e"]), "POST", "/v1/log");
    expect(w.r2.keys("l/")).toContain("l/t1/2026-11-01/1-2.ndjson");
    const big = await w.control("POST", "/v1/log", w.env({ lines: ["x".repeat(4000)] }), {
      iid: w.iid,
      raw: new TextEncoder().encode(JSON.stringify(w.env({ lines: Array(70).fill("x".repeat(4000)) }))),
    });
    expect(big.status).toBe(413);
  });
});

describe("snapshots (#72)", () => {
  it("final-snapshot: first → handle id, second → 409 done; maint-snapshot without a window → 403", async () => {
    const w = await bound();
    const f = () => w.control("POST", "/v1/final-snapshot", w.env({ kind: "final" }), { iid: w.iid });
    expect(await ok(await f(), "POST", "/v1/final-snapshot")).toEqual({
      ok: true,
      snapshotId: "snap-final-1",
    });
    const s = await f();
    expect([s.status, ((await s.json()) as { error: string }).error]).toEqual([409, "done"]);
    expect(
      (await w.control("POST", "/v1/maint-snapshot", w.env({ windowId: "w1" }), { iid: w.iid })).status,
    ).toBe(403);
  });
});

describe("creds (CredStore)", () => {
  it("put/get/manifest/delete; (gen, seq) order; sha check; big file → R2 blob; burst alert; canary 403", async () => {
    const w = await bound();
    const put = (p: string, seq: number, data: string | Uint8Array, shaOver?: string) =>
      w.control(
        "PUT",
        `/v1/creds/${p.split("/").map(encodeURIComponent).join("/")}`,
        w.env({ seq, sha256: shaOver ?? sha(data), mode: 0o600, b64: b64(data) }),
        { iid: w.iid },
      );
    await ok(await put("credentials/telegram.json", 2, "v2"), "PUT", "/v1/creds/x");
    await ok(await put("credentials/telegram.json", 1, "v1"), "PUT", "/v1/creds/x"); // older: ignored, still ok
    const g = await ok(
      await w.control("GET", "/v1/creds/credentials/telegram.json", undefined, { iid: w.iid }),
      "GET",
      "/v1/creds/x",
    );
    expect([g.seq, Buffer.from(g.b64 as string, "base64").toString()]).toEqual([2, "v2"]);
    expect((await put("a.json", 3, "z", sha("other"))).status).toBe(400);
    expect((await put("bad name.json", 3, "z")).status).toBe(400);
    expect((await put("../etc/passwd", 3, "z")).status).toBe(404); // URL parsing removes the dot segment
    const big = new Uint8Array(2_000_000).fill(7);
    await ok(await put("agents/main/agent/auth.json", 4, big), "PUT", "/v1/creds/x");
    expect(w.r2.keys("c/")).toEqual([`c/t1/blob/${sha(big)}`]);
    const gb = await ok(
      await w.control("GET", "/v1/creds/agents/main/agent/auth.json", undefined, { iid: w.iid }),
      "GET",
      "/v1/creds/x",
    );
    expect(sha(Buffer.from(gb.b64 as string, "base64"))).toBe(sha(big));
    const man = await ok(
      await w.control("GET", "/v1/creds/manifest", undefined, { iid: w.iid }),
      "GET",
      "/v1/creds/manifest",
    );
    expect(man.seq).toBe(4);
    expect((man.files as { path: string; size: number }[]).map((f) => [f.path, f.size])).toEqual([
      ["agents/main/agent/auth.json", 0],
      ["credentials/telegram.json", 2],
    ]);
    for (let i = 0; i < 21; i++)
      await ok(
        await w.control("DELETE", "/v1/creds/credentials/telegram.json", w.env({ seq: 10 + i }), {
          iid: w.iid,
        }),
        "DELETE",
        "/v1/creds/x",
      );
    expect(w.sql("SELECT class FROM alerts WHERE class = 'creds-burst'")).toHaveLength(1);
    expect(
      (await w.control("GET", "/v1/creds/credentials/telegram.json", undefined, { iid: w.iid })).status,
    ).toBe(404);
    expect(
      w.sql<{ n: number }>("SELECT COUNT(*) AS n FROM creds_hist WHERE path = 'credentials/telegram.json'")[0]
        ?.n,
    ).toBe(20); // sec F2: newest 20 versions per path (22 written)
    const cw = await w.control(
      "PUT",
      "/v1/creds/x.json",
      w.env({ seq: 99, sha256: sha("q"), mode: 0o600, b64: b64("q") }),
      { iid: w.iid, props: { mode: "canary" } },
    );
    expect(cw.status).toBe(403);
  });
});

describe("config and plugins", () => {
  it("proposal → candidate ver; GET; webhook transport refused; sensitive change alerts", async () => {
    const w = await bound();
    expect((await w.control("GET", "/v1/config/1", undefined, { iid: w.iid })).status).toBe(404);
    const doc = {
      gateway: { port: 18789 },
      channels: { telegram: { webhookUrl: "https://x.workers.dev/telegram-webhook" } },
    };
    const p = await ok(
      await w.control(
        "PUT",
        "/v1/config/proposal",
        w.env({ source: "ui", sha: sha(JSON.stringify(doc)), doc }),
        { iid: w.iid },
      ),
      "PUT",
      "/v1/config/proposal",
    );
    expect(p.ver).toBe(1);
    const g = await ok(
      await w.control("GET", "/v1/config/1", undefined, { iid: w.iid }),
      "GET",
      "/v1/config/1",
    );
    expect(g.doc).toEqual(doc);
    expect(w.sql("SELECT status, source FROM config")).toEqual([{ status: "candidate", source: "ui" }]);
    expect(w.sql("SELECT class FROM alerts WHERE class = 'config-sensitive'")).toHaveLength(1);
    // Doctor's own repair at boot: the ring row carries the keys, no alert (count stays 1).
    const doc2 = { ...doc, gateway: { auth: { mode: "token" } } };
    await ok(
      await w.control(
        "PUT",
        "/v1/config/proposal",
        w.env({ source: "doctor", sha: sha(JSON.stringify(doc2)), doc: doc2, baseVer: 1 }),
        { iid: w.iid },
      ),
      "PUT",
      "/v1/config/proposal",
    );
    expect(w.sql("SELECT count FROM alerts WHERE class = 'config-sensitive'")).toEqual([{ count: 1 }]);
    const bad = { channels: { slack: { webhookUrl: "https://evil" } } };
    const r = await w.control(
      "PUT",
      "/v1/config/proposal",
      w.env({ source: "ui", sha: sha("b"), doc: bad }),
      { iid: w.iid },
    );
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([403, "webhook-transport"]);
    const bad2 = { channels: { telegram: { webhookUrl: "https://x.workers.dev/other" } } };
    expect(
      (
        await w.control("PUT", "/v1/config/proposal", w.env({ source: "ui", sha: sha("c"), doc: bad2 }), {
          iid: w.iid,
        })
      ).status,
    ).toBe(403);
  });

  it("plugins manifest: new version and alert on change only", async () => {
    const w = await bound();
    expect(
      await ok(
        await w.control("GET", "/v1/plugins/manifest", undefined, { iid: w.iid }),
        "GET",
        "/v1/plugins/manifest",
      ),
    ).toEqual({ ver: 0, plugins: [] });
    const m = { ver: 0, plugins: [{ id: "x", spec: "npm:x@1" }] };
    const put = () => w.control("PUT", "/v1/plugins/manifest", w.env({ manifest: m }), { iid: w.iid });
    await ok(await put(), "PUT", "/v1/plugins/manifest");
    await ok(await put(), "PUT", "/v1/plugins/manifest");
    const g = await ok(
      await w.control("GET", "/v1/plugins/manifest", undefined, { iid: w.iid }),
      "GET",
      "/v1/plugins/manifest",
    );
    expect(g).toEqual({ ver: 1, plugins: m.plugins });
    expect(w.sql("SELECT count FROM alerts WHERE class = 'plugins-changed'")).toEqual([{ count: 1 }]);
  });

  it("wake-allow replaces the row; export → 403", async () => {
    const w = await bound();
    await ok(
      await w.control(
        "PUT",
        "/v1/wake-allow",
        w.env({ userIds: ["1", "2"], groupChatIds: [], configVer: 3 }),
        { iid: w.iid },
      ),
      "PUT",
      "/v1/wake-allow",
    );
    await ok(
      await w.control("PUT", "/v1/wake-allow", w.env({ userIds: ["9"], groupChatIds: ["-100"] }), {
        iid: w.iid,
      }),
      "PUT",
      "/v1/wake-allow",
    );
    expect(w.sql("SELECT user_ids, group_chat_ids, config_ver FROM wake_allow")).toEqual([
      { user_ids: '["9"]', group_chat_ids: '["-100"]', config_ver: null },
    ]);
    expect(
      (await w.control("POST", "/v1/export/x", undefined, { iid: w.iid, raw: new Uint8Array(1) })).status,
    ).toBe(403);
  });
});

describe("archives (multipart, hashed in order)", () => {
  const part = (n: number, size: number) => new Uint8Array(size).map((_, i) => (i + n * 13) & 255);

  it("start, parts in order (retry of the last allowed), complete with the sha; get returns the bytes", async () => {
    const w = await bound();
    const s = await ok(
      await w.control(
        "POST",
        "/v1/archive/start",
        w.env({ kind: "online", manifest: { version: "2026.9.36", digest: "sha256:0123456789abcdef" } }),
        { iid: w.iid },
      ),
      "POST",
      "/v1/archive/start",
    );
    expect(s.partMax).toBe(16 * 1024 * 1024);
    expect(s.key).toMatch(/^a\/t1\/\d{8}T\d{6}Z-2026\.9\.36-0123456789ab\.tar\.gz$/);
    const id = s.archiveId as string;
    const up = (n: number, b: Uint8Array) =>
      w.control("PUT", `/v1/archive/part?archiveId=${encodeURIComponent(id)}&n=${n}`, undefined, {
        iid: w.iid,
        raw: b,
      });
    const ps = [part(1, 5000), part(2, 7000), part(3, 100)];
    await ok(await up(1, ps[0] as Uint8Array), "PUT", "/v1/archive/part");
    await ok(await up(2, ps[1] as Uint8Array), "PUT", "/v1/archive/part");
    await ok(await up(2, ps[1] as Uint8Array), "PUT", "/v1/archive/part"); // retry of part 2
    expect((await up(4, part(4, 10))).status).toBe(409); // out of order
    await ok(await up(3, ps[2] as Uint8Array), "PUT", "/v1/archive/part");
    const all = Buffer.concat(ps);
    await ok(
      await w.control(
        "POST",
        "/v1/archive/complete",
        w.env({ archiveId: id, sha256: sha(all), size: all.length, parts: 3 }),
        { iid: w.iid },
      ),
      "POST",
      "/v1/archive/complete",
    );
    expect(w.sql("SELECT state, sha256, size, parts FROM archives")).toEqual([
      { state: "complete", sha256: sha(all), size: 12100, parts: 3 },
    ]);
    const g = await w.control("GET", `/v1/archive/get?archiveId=${encodeURIComponent(id)}`, undefined, {
      iid: w.iid,
    });
    expect(sha(new Uint8Array(await g.arrayBuffer()))).toBe(sha(all));
    expect(w.sql("SELECT * FROM multipart")).toEqual([]);
    // M4 verify-on-restore: the gate hashed what it streamed and matched the index.
    expect(w.sql("SELECT verified_by FROM archives")).toEqual([{ verified_by: "restore" }]);
  });

  it("M4 verify-on-restore: a corrupt R2 copy → state bad + alert; a size mismatch → 409 before any byte", async () => {
    const w = await bound();
    const put = async (bytes: Uint8Array) => {
      const s = await ok(
        await w.control(
          "POST",
          "/v1/archive/start",
          w.env({ kind: "online", manifest: { reason: "owner" } }),
          {
            iid: w.iid,
          },
        ),
        "POST",
        "/v1/archive/start",
      );
      const id = s.archiveId as string;
      await ok(
        await w.control("PUT", `/v1/archive/part?archiveId=${id}&n=1`, undefined, { iid: w.iid, raw: bytes }),
        "PUT",
        "/v1/archive/part",
      );
      await ok(
        await w.control(
          "POST",
          "/v1/archive/complete",
          w.env({ archiveId: id, sha256: sha(bytes), size: bytes.length, parts: 1 }),
          { iid: w.iid },
        ),
        "POST",
        "/v1/archive/complete",
      );
      return { id, key: s.key as string };
    };
    const a = await put(part(1, 3000));
    const flipped = part(1, 3000);
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    await w.r2.put(a.key, flipped);
    const g = await w.control("GET", `/v1/archive/get?archiveId=${a.id}`, undefined, { iid: w.iid });
    expect(g.status).toBe(200);
    await g.arrayBuffer();
    expect(w.sql("SELECT state FROM archives WHERE id = ?", a.id)).toEqual([{ state: "bad" }]);
    expect(w.sql("SELECT class FROM alerts WHERE class = 'archive-bad'").length).toBe(1);
    expect(
      (await w.control("GET", `/v1/archive/get?archiveId=${a.id}`, undefined, { iid: w.iid })).status,
    ).toBe(404);
    const b = await put(part(2, 2000));
    await w.r2.put(b.key, part(2, 1999));
    const g2 = await w.control("GET", `/v1/archive/get?archiveId=${b.id}`, undefined, { iid: w.iid });
    expect([g2.status, ((await g2.json()) as { error: string }).error]).toEqual([409, "archive-bad"]);
    expect(w.sql("SELECT state FROM archives WHERE id = ?", b.id)).toEqual([{ state: "bad" }]);
  });

  it("sha mismatch → 409 sha-mismatch and abort; one open per gen (409 busy); day cap → 429; abort route", async () => {
    const w = await bound();
    const start = () => w.control("POST", "/v1/archive/start", w.env({ kind: "online" }), { iid: w.iid });
    const s = await ok(await start(), "POST", "/v1/archive/start");
    const id = s.archiveId as string;
    await ok(
      await w.control("PUT", `/v1/archive/part?archiveId=${id}&n=1`, undefined, {
        iid: w.iid,
        raw: part(1, 100),
      }),
      "PUT",
      "/v1/archive/part",
    );
    const c = await w.control(
      "POST",
      "/v1/archive/complete",
      w.env({ archiveId: id, sha256: sha("nope"), size: 100, parts: 1 }),
      { iid: w.iid },
    );
    expect([c.status, ((await c.json()) as { error: string }).error]).toEqual([409, "sha-mismatch"]);
    expect(w.sql("SELECT state FROM archives")).toEqual([{ state: "aborted" }]);
    expect(w.r2.uploads.size).toBe(0);
    const abort = (archiveId: unknown) =>
      w.control("POST", "/v1/archive/abort", w.env({ archiveId }), { iid: w.iid });
    // M4: one open archive per gen; a second start while it is open → 409 busy.
    const open1 = await ok(await start(), "POST", "/v1/archive/start");
    const busy = await start();
    expect([busy.status, ((await busy.json()) as { error: string }).error]).toEqual([409, "busy"]);
    await abort(open1.archiveId);
    // Day cap (counts starts): reason ctl is forced, so perDay 24 + FORCED_EXTRA_PER_DAY 8. 2 used above.
    for (let i = 0; i < 29; i++)
      await abort((await ok(await start(), "POST", "/v1/archive/start")).archiveId);
    const last = await ok(await start(), "POST", "/v1/archive/start");
    await abort(last.archiveId);
    expect((await start()).status).toBe(429);
    expect(
      w.sql<{ state: string }>("SELECT state FROM archives WHERE id = ?", last.archiveId as string)[0]?.state,
    ).toBe("aborted");
  });

  it("part over 16 MiB → 413", async () => {
    const w = await bound();
    const s = await ok(
      await w.control("POST", "/v1/archive/start", w.env({ kind: "clean" }), { iid: w.iid }),
      "POST",
      "/v1/archive/start",
    );
    const r = await w.control("PUT", `/v1/archive/part?archiveId=${s.archiveId}&n=1`, undefined, {
      iid: w.iid,
      raw: new Uint8Array(16 * 1024 * 1024 + 1),
    });
    expect(r.status).toBe(413);
  });
});

describe("shadows", () => {
  it("put with header sha; 1 per DB per 10 min; mismatch 409; unclassified db ok; bad path 400", async () => {
    const w = await bound();
    const data = new Uint8Array(3000).fill(1);
    const put = (db: string, b: Uint8Array, h = sha(b)) =>
      w.control("PUT", `/v1/shadow/${db.split("/").map(encodeURIComponent).join("/")}`, undefined, {
        iid: w.iid,
        raw: b,
        headers: { "x-ocrt-sha256": h },
      });
    expect((await put("state/openclaw.sqlite", data, sha("x"))).status).toBe(409);
    const r = await put("state/openclaw.sqlite", data);
    expect(r.status).toBe(200);
    expect(w.r2.keys("s/")).toHaveLength(1);
    expect(w.r2.keys("s/")[0]).toMatch(/^s\/t1\/state\/openclaw\.sqlite\/\d{8}T\d{6}Z\.sqlite$/);
    expect((await put("state/openclaw.sqlite", data)).status).toBe(429);
    w.clock.t += 600_000;
    w.cache.current.clear();
    expect((await put("state/openclaw.sqlite", data)).status).toBe(200);
    // Shadows are for unclassified DBs (ocsup db-unclassified), so any safe *.sqlite path is accepted.
    expect((await put("state/openclaw-quarantine.sqlite", data)).status).toBe(200);
    expect((await put("workspace/team-reports/reports.sqlite", data)).status).toBe(200);
    expect((await put("state/x.db", data)).status).toBe(400);
    expect((await put("state//x.sqlite", data)).status).toBe(400);
    for (const bad of ["../x.sqlite", "state/./x.sqlite", "/abs.sqlite", "state/x.sqlite-wal", "a\0.sqlite"])
      expect([bad, shadowPathOk(bad)]).toEqual([bad, false]);
  });
});
