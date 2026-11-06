// Self-tests of the scenario harness. These run before the M2 modules exist.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as C from "../../image/ocrt/lib/contract.mjs";
import { FakeContainer } from "./fake-container";
import { FakeOcsup, hmacHex } from "./harness/ocsup";
import { FakeR2 } from "./harness/r2";
import { FakeStorage } from "./harness/storage";
import { TEXT } from "./harness/texts";

afterEach(() => {
  vi.useRealTimers();
});

describe("FakeStorage", () => {
  it("runs schema, binds, rolls back a failed transactionSync and keeps data across instances", () => {
    const s = new FakeStorage();
    s.sql.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE b (x BLOB)");
    s.sql.exec("INSERT INTO kv VALUES (?, ?)", "a", JSON.stringify({ n: 1 }));
    expect(() =>
      s.transactionSync(() => {
        s.sql.exec("INSERT INTO kv VALUES (?, ?)", "b", "2");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.sql.exec("SELECT k FROM kv").toArray()).toEqual([{ k: "a" }]);
    expect(() => s.sql.exec("SELECT * FROM kv WHERE k = ?", true)).toThrow(/unsupported type/);
    s.sql.exec("INSERT INTO b VALUES (?)", new Uint8Array([1, 2]).buffer);
    expect(s.sql.exec("SELECT x FROM b").one().x).toBeInstanceOf(ArrayBuffer);
    expect(() => s.sql.exec("SELECT k FROM kv WHERE k = 'zz'").one()).toThrow(/exactly one/);
    expect(s.rows("SELECT * FROM nope")).toEqual([]);
    expect(s.rowsWritten).toBe(2);
  });
  it("nests transactionSync with savepoints", () => {
    const s = new FakeStorage();
    s.sql.exec("CREATE TABLE t (x INTEGER)");
    s.transactionSync(() => {
      s.sql.exec("INSERT INTO t VALUES (1)");
      try {
        s.transactionSync(() => {
          s.sql.exec("INSERT INTO t VALUES (2)");
          throw new Error("inner");
        });
      } catch {}
    });
    expect(s.sql.exec("SELECT x FROM t").toArray()).toEqual([{ x: 1 }]);
  });
});

describe("FakeContainer", () => {
  const mk = () => new FakeContainer(() => Date.now());
  it("destroy() resolves monitor() with no text (m0 T7c(4))", async () => {
    const c = mk();
    c.start({ image: "x", labels: { gen: "1" } });
    const m = c.monitor();
    await c.destroy();
    await expect(m).resolves.toBeUndefined();
    expect(c.running).toBe(false);
  });
  it("crash() rejects with the m0 text and exitCode; without exitCode on request", async () => {
    const c = mk();
    c.start({ image: "x" });
    const m = c.monitor();
    c.crash(137);
    await expect(m).rejects.toMatchObject({ message: TEXT.exit137, exitCode: 137 });
    c.start({ image: "x" });
    const m2 = c.monitor();
    c.crash(137, false);
    const e = await m2.catch((x) => x);
    expect(e.exitCode).toBeUndefined();
  });
  it("unknown snapshot rejects monitor() asynchronously; throws from start() when set", async () => {
    const c = mk();
    c.start({ containerSnapshot: { id: "gone" } });
    await expect(c.monitor()).rejects.toThrow('Snapshot "gone" was not found.');
    c.snapshotMissThrows = true;
    expect(() => c.start({ containerSnapshot: { id: "gone" } })).toThrow(/was not found/);
  });
  it("scripts capacity throw, monitor reject, already running, hangs and vanish", async () => {
    vi.useFakeTimers();
    const c = mk();
    c.startScript = [{ throw: TEXT.capacity }, { monitorReject: TEXT.capacity }];
    expect(() => c.start({ image: "x" })).toThrow(/capacity/);
    c.start({ image: "x" });
    await expect(c.monitor()).rejects.toThrow(/capacity/);
    c.start({ image: "x" });
    expect(() => c.start({ image: "x" })).toThrow(TEXT.alreadyRunning);
    c.destroyHang = 1;
    let done = false;
    void c.destroy().then(
      () => (done = true),
      () => (done = true),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    c.inspectHang = 1;
    let got = false;
    void c.inspect().catch(() => (got = true));
    c.releaseAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBe(true);
    let settled = false;
    void c.monitor().finally(() => (settled = true));
    c.vanish();
    await vi.advanceTimersByTimeAsync(10);
    expect(c.running).toBe(false);
    expect(settled).toBe(false);
  });
  it("hung start: exec never answers until aborted", async () => {
    const c = mk();
    c.startScript = ["hang"];
    c.start({ image: "x" });
    const ac = new AbortController();
    const p = c.exec(["true"], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
  });
  it("records setInactivityTimeout, intercepts and snapshots", async () => {
    const c = mk();
    await c.interceptOutboundHttp("15.0.0.1:80", {} as Fetcher);
    c.start({ image: "x" });
    await c.setInactivityTimeout(21_600_000);
    c.snapshotFail = ["boom"];
    await expect(c.snapshotContainer({ name: "s" })).rejects.toThrow("boom");
    const s = await c.snapshotContainer({ name: "s" });
    expect(c.snapshots.has(s.id)).toBe(true);
    expect(c.calls.map((x) => x.op)).toEqual(["intercept", "start", "snapshot", "snapshot"]);
    expect(c.inactivity[0]?.ms).toBe(21_600_000);
  });
});

describe("FakeR2", () => {
  it("write-once onlyIf, sha256 check, fault window, list errors, multipart", async () => {
    let t = 0;
    const b = new FakeR2(() => t);
    expect(await b.put("meta/t1/installed", "1", { onlyIf: { etagDoesNotMatch: "*" } })).not.toBeNull();
    expect(await b.put("meta/t1/installed", "2", { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
    expect(await (await b.get("meta/t1/installed"))?.text()).toBe("1");
    await expect(b.put("k", "x", { sha256: "00".repeat(32) })).rejects.toThrow(/SHA-256/);
    b.failUntil = 10;
    await expect(b.head("k")).rejects.toThrow(/500/);
    t = 10;
    b.listFail = 1;
    await expect(b.list({ prefix: "r/" })).rejects.toThrow();
    const u = await b.createMultipartUpload("a/x");
    const p1 = await u.uploadPart(1, "ab");
    const p2 = await u.uploadPart(2, "cd");
    await u.complete([p1, p2]);
    expect(await (await b.get("a/x"))?.text()).toBe("abcd");
    expect(b.keys()).toEqual(["a/x", "meta/t1/installed"]);
  });
});

describe("FakeOcsup", () => {
  it("boots through a gate with valid contract shapes, beats, answers ocsupctl and the port", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const c = new FakeContainer(() => Date.now());
    const o = new FakeOcsup(c);
    o.litestream = false;
    const seen: { path: string; body: Record<string, unknown> }[] = [];
    const secret = "ab".repeat(32);
    const gate = {
      fetch: async (input: string, init: RequestInit) => {
        const path = new URL(input).pathname;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        seen.push({ path, body });
        if (path === "/v1/hello")
          return Response.json({
            proof: await hmacHex(secret, `${C.DOMAIN.hello}${body.challenge}`),
            pv: [1],
          });
        if (path === "/v1/boot")
          return Response.json({
            status: "ok",
            plan: {
              v: 1,
              mode: "prod",
              gen: 1,
              rootfs: { kind: "image" },
              sqlite: { kind: "fresh" },
              dbs: [],
              runDoctor: false,
              lockMode: "auto",
              timers: { hbMs: 1000, fenceMs: 5000, startGateMs: 5000 },
            },
          });
        if (path === "/v1/heartbeat") return Response.json({ ok: true, gen: 1, tier: "normal" });
        return Response.json({ ok: true });
      },
    } as unknown as Fetcher;
    await c.interceptOutboundHttp("15.0.0.1:80", gate);
    c.start({
      image: "x",
      env: { OCRT_INST: "t1", OCRT_GEN: "1", OCRT_EPOCH: "1", OCRT_BOOT_SECRET: secret },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(o.errors).toEqual([]);
    expect(seen.map((x) => x.path).slice(0, 3)).toEqual(["/v1/hello", "/v1/boot", "/v1/heartbeat"]);
    expect(seen.filter((x) => x.path === "/v1/event").map((x) => x.body.kind)).toEqual([
      "startupz",
      "ingress-ready",
    ]);
    const r = await c.getTcpPort(18789).fetch("http://container/startupz");
    expect(await r.json()).toEqual({ status: "started" });
    const p = await c.exec(["ocsupctl", "sleep-prepare", "--op-id", "s1", "--json"]);
    expect(JSON.parse(new TextDecoder().decode((await p.output()).stdout))).toMatchObject({
      status: "ready",
    });
    await o.sigterm();
    const p2 = await c.exec(["ocsupctl", "sleep-flush", "--op-id", "s1", "--json"]);
    expect(JSON.parse(new TextDecoder().decode((await p2.output()).stdout))).toEqual({
      ok: false,
      error: "draining",
    });
    const m = c.monitor();
    await o.exit(0, "sigterm");
    await expect(m).rejects.toThrow(/exit code: 0/);
    expect(seen.at(-1)?.body).toMatchObject({ kind: "exit", code: 0, reason: "sigterm" });
  });
});
