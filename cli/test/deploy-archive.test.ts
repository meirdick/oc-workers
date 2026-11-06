// ochost deploy pre-upgrade archive (dogfood row 14): ask /ops/archive/can-run first; skip the 10 min wait on an
// install that cannot wake; --require-archive refuses instead. Against the fake /ops server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preUpgradeArchive } from "../src/deploy.ts";
import { toFailed } from "../src/ops-lib.ts";
import type { Ctx } from "../src/ui.ts";
import { causeChain, makeUi, toFailedLine } from "../src/ui.ts";
import { FakeOps, fakeClock, OWNER } from "./ops-fake.ts";

let ops: FakeOps;
beforeEach(async () => {
  ops = await new FakeOps().start();
});
afterEach(() => ops.stop());

function ctxOf(flags: Record<string, unknown> = {}) {
  let err = "";
  const clock = fakeClock();
  const ctx = {
    ui: makeUi(
      { json: false, nonInteractive: true },
      { err: { write: (s: string) => (err += s) }, out: { write: () => 0 } },
    ),
    args: { positionals: [], flags },
    dir: "/nonexistent",
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    fetch,
    env: {},
    sleep: clock.sleep,
    now: clock.now,
    prompt: { ask: async () => "", askHidden: async () => "" },
    interactive: false,
  } as unknown as Ctx;
  return { ctx, err: () => err, clock };
}

const canRun = (body: Record<string, unknown>) => (r: { method: string; path: string }) =>
  r.method === "GET" && r.path.startsWith("/ops/archive/can-run") ? { status: 200, body } : undefined;
const archiveRoutes = (state: { done: boolean }) => (r: { method: string; path: string }) => {
  if (r.method === "POST" && r.path === "/ops/archive")
    return { status: 202, body: { ok: true, request: { id: "req-1", state: "pending" } } };
  if (r.method === "GET" && r.path === "/ops/archive")
    return { status: 200, body: { request: { id: "req-1", state: state.done ? "done" : "running" } } };
  return undefined;
};
const stale = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === "/ops/deploy-check"
    ? {
        status: 409,
        body: { error: "archive-stale", why: "newest archive is older than the newest snapshot" },
      }
    : undefined;
const okCheck = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === "/ops/deploy-check" ? { status: 200, body: { ok: true } } : undefined;

describe("deploy pre-upgrade archive", () => {
  it("install in backoff: skips the archive at once with the state and archive age, then continues", async () => {
    ops.routes.push(canRun({ canRun: false, state: "backoff", newestAgeMs: 95 * 60_000 }), stale);
    const t = ctxOf();
    await preUpgradeArchive(t.ctx, ops.url, OWNER);
    expect(t.err()).toMatch(
      /pre-upgrade archive skipped: install cannot wake \(state backoff\); the newest archive is 95 min old/,
    );
    expect(ops.calls("POST", "/ops/archive")).toHaveLength(0);
    expect(t.clock.now() - Date.parse("2026-11-01T12:00:00Z")).toBe(0); // no wait
    expect(ops.calls("POST", "/ops/deploy-check")).toHaveLength(1);
  });

  it("restore-blocked with --require-archive: refuses the deploy", async () => {
    ops.routes.push(canRun({ canRun: false, state: "restore-blocked:mismatch", newestAgeMs: null }));
    const t = ctxOf({ "require-archive": true });
    await expect(preUpgradeArchive(t.ctx, ops.url, OWNER)).rejects.toThrow(
      /pre-upgrade archive required but cannot run: install cannot wake \(state restore-blocked:mismatch\); the newest archive is missing/,
    );
    expect(ops.calls("POST", "/ops/archive")).toHaveLength(0);
    expect(ops.calls("POST", "/ops/deploy-check")).toHaveLength(0);
  });

  it("asleep install that can wake: asks for the archive and waits until done", async () => {
    const st = { done: false };
    ops.routes.push(canRun({ canRun: true, state: "asleep", newestAgeMs: 0 }), archiveRoutes(st), okCheck);
    const t = ctxOf();
    const p = preUpgradeArchive(t.ctx, ops.url, OWNER);
    setTimeout(() => {
      st.done = true;
    }, 30);
    await p;
    expect(ops.calls("POST", "/ops/archive")).toHaveLength(1);
    expect(t.err()).toMatch(/pre-upgrade archive done/);
    expect(t.err()).not.toMatch(/skipped/);
  });

  it("install falls into backoff while we wait: stops waiting and skips", async () => {
    let n = 0;
    ops.routes.push(
      (r) => {
        if (r.method !== "GET" || !r.path.startsWith("/ops/archive/can-run")) return undefined;
        n++;
        return {
          status: 200,
          body:
            n === 1
              ? { canRun: true, state: "asleep" }
              : { canRun: false, state: "backoff", newestAgeMs: 60_000 },
        };
      },
      archiveRoutes({ done: false }),
      stale,
    );
    const t = ctxOf();
    await preUpgradeArchive(t.ctx, ops.url, OWNER);
    expect(t.err()).toMatch(
      /skipped: install cannot wake \(state backoff\); the newest archive is 1 min old/,
    );
    expect(t.clock.now() - Date.parse("2026-11-01T12:00:00Z")).toBeLessThan(60_000);
  });

  it("socket closed on POST /ops/archive (the demo bare 'fetch failed'): tried again, the archive runs", async () => {
    const st = { done: true };
    ops.routes.push(canRun({ canRun: true, state: "running", newestAgeMs: 0 }), archiveRoutes(st), okCheck);
    let drops = 1;
    ops.drop = (r) => r.method === "POST" && r.path === "/ops/archive" && drops-- > 0;
    const t = ctxOf();
    await preUpgradeArchive(t.ctx, ops.url, OWNER);
    expect(ops.calls("POST", "/ops/archive")).toHaveLength(2);
    expect(t.err()).toMatch(/POST \/ops\/archive failed \(.*other side closed.*\); retry 1 of 2/);
    expect(t.err()).toMatch(/pre-upgrade archive done/);
  });

  it("the network stays down: fails with the route, the tries and the undici cause", async () => {
    ops.routes.push(
      canRun({ canRun: true, state: "running", newestAgeMs: 0 }),
      archiveRoutes({ done: true }),
    );
    ops.drop = (r) => r.method === "POST" && r.path === "/ops/archive";
    const t = ctxOf();
    const e = await preUpgradeArchive(t.ctx, ops.url, OWNER).catch((x) => x);
    expect(ops.calls("POST", "/ops/archive")).toHaveLength(3);
    expect(toFailedLine(e)).toMatch(
      /^Failed: http:\/\/127\.0\.0\.1:\d+ did not answer \(POST \/ops\/archive, 3 tries\): .*other side closed.* — fix: check the network/,
    );
    expect(ops.calls("POST", "/ops/deploy-check")).toHaveLength(0);
  });

  it("POST /ops/archive answers 503: the step prints the HTTP status", async () => {
    ops.routes.push(
      canRun({ canRun: true, state: "running", newestAgeMs: 0 }),
      (r) =>
        r.method === "POST" && r.path === "/ops/archive"
          ? { status: 503, body: { error: "no-ledger" } }
          : undefined,
      okCheck,
    );
    const t = ctxOf();
    await preUpgradeArchive(t.ctx, ops.url, OWNER);
    expect(t.err()).toMatch(/pre-upgrade archive request refused: HTTP 503 no-ledger/);
  });

  it("an older Worker without /ops/archive/can-run (404): old behaviour, the stale gate still refuses", async () => {
    ops.routes.push(archiveRoutes({ done: false }), stale);
    const t = ctxOf();
    await expect(preUpgradeArchive(t.ctx, ops.url, OWNER)).rejects.toThrow(/deploy refused/);
    expect(ops.calls("POST", "/ops/archive")).toHaveLength(1);
  });
});

describe("fetch cause chain", () => {
  it("a bare undici 'fetch failed' shows its cause: code, errno, syscall, address", () => {
    const sock = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      address: "127.0.0.1",
      port: 9,
    });
    const bare = new TypeError("fetch failed", { cause: sock });
    expect(causeChain(bare)).toBe(
      "TypeError: fetch failed <- Error: connect ECONNREFUSED 127.0.0.1:9 (code ECONNREFUSED, errno -111, syscall connect, address 127.0.0.1:9)",
    );
    expect(toFailedLine(bare)).toMatch(
      /^Failed: fetch failed \(Error: connect ECONNREFUSED .*code ECONNREFUSED/,
    );
    expect(toFailed(bare).line).toMatch(/^Failed: fetch failed \(Error: connect ECONNREFUSED/);
    expect(toFailedLine(new Error("boom"))).toBe(
      "Failed: boom — fix: rerun with OCHOST_DEBUG=1 and report the output",
    );
  });
});
