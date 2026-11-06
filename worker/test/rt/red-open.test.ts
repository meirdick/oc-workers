// Open red-team items a Telegram install hits (docs/research/red-team-reconciliation.md §8): Runtime DO side.
import { describe, expect, it } from "vitest";
import { world } from "./world";

describe("N7: verifyGen asks ocsup for a restore probe of the running gen", () => {
  it("pass and quick_check failure are verdicts; infra failure, another gen or not running are not", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    const gen = w.core.boot()?.gen as number;
    const seen: unknown[] = [];
    const answers: Record<string, unknown>[] = [
      { ok: true, gen, verified: true, dbs: [] },
      { ok: true, gen, verified: false, reason: "bad", rel: "state/openclaw.sqlite", why: "quick_check x" },
      { ok: true, gen, verified: false, reason: "infra", why: "connection refused" },
    ];
    w.ocsup.ctl["verify-gen"] = ({ json }) => {
      seen.push(json);
      return answers.shift();
    };
    const dbs = ["state/openclaw.sqlite"];
    expect(await w.core.verifyGen({ gen, dbs })).toEqual({ verified: true, why: null });
    expect(seen[0]).toMatchObject({ gen, dbs });
    expect(await w.core.verifyGen({ gen, dbs })).toEqual({
      verified: false,
      why: "state/openclaw.sqlite quick_check x",
    });
    expect((await w.core.verifyGen({ gen, dbs })).verified).toBeNull();
    expect((await w.core.verifyGen({ gen: gen + 1, dbs })).verified).toBeNull();
    expect(seen.length).toBe(3);
  });
});

describe("S0.3: a row is held while the gateway restarts", () => {
  it("heartbeat phase gateway-restart → 503 without a delivery; running again → delivered", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    const gen = w.core.boot()?.gen;
    let hits = 0;
    w.c.portHandler = (req) => {
      if (new URL(req.url).pathname !== "/telegram-webhook") return Response.json({ status: "started" });
      hits++;
      return new Response("", { status: 200, headers: { "x-openclaw-delivery-accepted": "durable" } });
    };
    const hb = (phase: string) =>
      w.core.store.put("hb", { at: w.clock.now() + 1, seq: 1, phase, draining: false, gen });
    hb("gateway-restart");
    expect(await w.core.deliver({ path: "/telegram-webhook", body: "{}", headers: {} })).toMatchObject({
      status: 503,
      error: "gateway-stopping",
    });
    expect(hits).toBe(0);
    hb("running");
    expect(await w.core.deliver({ path: "/telegram-webhook", body: "{}", headers: {} })).toEqual({
      status: 200,
      durable: true,
    });
  });
});

describe("S0.10: a quiet row's accept is not activity", () => {
  it("lastActivityAt moves for a normal accept, not for a quiet one", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    w.c.portHandler = (req) =>
      new URL(req.url).pathname === "/telegram-webhook"
        ? new Response("", { status: 200, headers: { "x-openclaw-delivery-accepted": "durable" } })
        : Response.json({ status: "started" });
    const t0 = w.core.rec().lastActivityAt;
    w.clock.t += 60_000;
    await w.core.deliver({ path: "/telegram-webhook", body: "{}", headers: {}, quiet: true });
    expect(w.core.rec().lastActivityAt).toBe(t0);
    await w.core.deliver({ path: "/telegram-webhook", body: "{}", headers: {} });
    expect(w.core.rec().lastActivityAt).toBe(w.clock.now());
  });
});
