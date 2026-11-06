// Intercept registration (spec §8.4) with the fake container, and the gate entrypoints wired through env
// (Control DO gateCall, Runtime DO stub, R2). The fakes answer only with OC_TEST=1 and props.test.
import { describe, expect, it } from "vitest";
import { FakeClock, FakeContainer } from "../../src/core/fake-container";
import type { Env } from "../../src/core/types";
import { CapGate, ControlGate, LlmMock, ReplicaGate, SandboxGate, TelegramFake } from "../../src/gates/entry";
import {
  CAP_ADDR,
  CONTROL_ADDR,
  gateFactories,
  gateProps,
  interceptTargets,
  LLM_HOST,
  REPLICA_ADDR,
  registerIntercepts,
  SBX_ADDR,
  TELEGRAM_HOST,
} from "../../src/gates/intercepts";
import { dispatchGateCall } from "../../src/gates/ledger";
import type { GateProps } from "../../src/gates/types";
import { hmacHex, rid, SECRET, World } from "./harness";

function envOf(w: World, test: boolean): Env {
  return {
    CONTROL: {
      getByName: () => ({
        gateCall: async (m: string, a: unknown[]) => structuredClone(dispatchGateCall(w.ledger, m, a)),
      }),
    },
    RUNTIME: { getByName: () => w.rtPort() },
    BUCKET: w.r2,
    OC_INST: "t1",
    OC_TEST: test ? "1" : "0",
  } as unknown as Env;
}
const ctxOf = (props: GateProps) =>
  ({ props, waitUntil: () => {}, passThroughOnException: () => {} }) as never;

/** ctx.exports stand-in: each factory builds the real entrypoint class with the given env. */
function exportsOf(env: Env) {
  const mk =
    (C: new (ctx: never, env: Env) => { fetch(r: Request): Promise<Response> }) =>
    ({ props }: { props: GateProps }) =>
      ({ fetch: (r: Request) => new C(ctxOf(props), env).fetch(r) }) as unknown as Fetcher;
  return {
    ControlGate: mk(ControlGate),
    ReplicaGate: mk(ReplicaGate),
    CapGate: mk(CapGate),
    SandboxGate: mk(SandboxGate),
    TelegramFake: mk(TelegramFake),
    LlmMock: mk(LlmMock),
  };
}

type F = { fetch(r: Request): Promise<Response> };
const f = (x: unknown) => x as F;

class HttpsContainer extends FakeContainer {
  https = new Map<string, Fetcher>();
  async interceptOutboundHttps(addr: string, t: Fetcher) {
    this.calls.push(`intercepts:${addr}`);
    this.https.set(addr, t);
  }
}

describe("intercept registration (§8.4)", () => {
  it("registers ControlGate, ReplicaGate and CapGate before start(); the registered target serves hello", async () => {
    const w = new World();
    const env = envOf(w, false);
    const c = new FakeContainer(new FakeClock());
    const props = gateProps(
      { inst: "t1", epoch: 1, gen: 1, mode: "prod", bootSecret: SECRET, restoreGens: [] },
      env,
    );
    expect(props.test).toBeUndefined();
    const r = await registerIntercepts(c, gateFactories(exportsOf(env), false), props);
    expect(r.ok).toBe(true);
    await c.start({ source: { image: "oc" } } as never);
    expect(c.calls.slice(0, 5)).toEqual([
      `intercept:${CONTROL_ADDR}`,
      `intercept:${REPLICA_ADDR}`,
      `intercept:${CAP_ADDR}`,
      `intercept:${SBX_ADDR}`,
      "start",
    ]);
    // A Worker whose exports lack SandboxGate (older build) still registers the required gates and starts.
    const { SandboxGate: _, ...old } = exportsOf(env);
    const c2 = new FakeContainer(new FakeClock());
    const r2 = await registerIntercepts(c2, gateFactories(old, false), props);
    expect(r2.ok).toBe(true);
    expect(r2.results[SBX_ADDR]?.ok).toBe(false);
    const ch = rid() + rid();
    const res = await f(c.intercepts.get(CONTROL_ADDR)).fetch(
      new Request("http://15.0.0.1/v1/hello", {
        method: "POST",
        body: JSON.stringify({ challenge: ch, pv: 1 }),
      }),
    );
    expect(((await res.json()) as { proof: string }).proof).toBe(hmacHex(SECRET, `oc-hello\0${ch}`));
  });

  it("test mode adds the Telegram and LLM fakes over HTTPS; a port without HTTPS intercepts fails closed", async () => {
    const w = new World();
    const env = envOf(w, true);
    const props = gateProps(
      { inst: "t1", epoch: 1, gen: 1, mode: "prod", bootSecret: SECRET, restoreGens: [] },
      env,
    );
    expect(props.test).toBe(true);
    expect(interceptTargets(true).map((t) => t.addr)).toEqual([
      CONTROL_ADDR,
      REPLICA_ADDR,
      CAP_ADDR,
      SBX_ADDR,
      TELEGRAM_HOST,
      LLM_HOST,
    ]);
    const plain = new FakeContainer(new FakeClock());
    const bad = await registerIntercepts(plain, gateFactories(exportsOf(env), true), props);
    expect(bad.ok).toBe(false);
    expect(bad.failed).toEqual([TELEGRAM_HOST, LLM_HOST]);
    const c = new HttpsContainer(new FakeClock());
    const good = await registerIntercepts(c, gateFactories(exportsOf(env), true), props);
    expect(good.ok).toBe(true);
    expect(c.calls).toEqual([
      `intercept:${CONTROL_ADDR}`,
      `intercept:${REPLICA_ADDR}`,
      `intercept:${CAP_ADDR}`,
      `intercept:${SBX_ADDR}`,
      `intercepts:${TELEGRAM_HOST}`,
      `intercepts:${LLM_HOST}`,
    ]);
    // fake Telegram: sendMessage recorded in the Control DO ring, bot token not logged
    const tg = f(c.https.get(TELEGRAM_HOST));
    const sm = await tg.fetch(
      new Request("https://api.telegram.org/bot123:SECRETTOKEN/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: 42, text: "hi" }),
      }),
    );
    expect(((await sm.json()) as { ok: boolean }).ok).toBe(true);
    const ring = w.sql<{ src: string; kind: string; detail: string }>(
      "SELECT src, kind, detail FROM ring WHERE src = 'telegram'",
    );
    expect(ring.map((x) => x.kind)).toEqual(["sendMessage"]);
    expect(ring[0]?.detail).not.toContain("SECRETTOKEN");
    const llm = await f(c.https.get(LLM_HOST)).fetch(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "m", stream: false }),
      }),
    );
    expect(((await llm.json()) as { content: { text: string }[] }).content[0]?.text).toBe("oc mock reply");
  });

  it("a failed required target is reported and the rest are still tried", async () => {
    const w = new World();
    const env = envOf(w, false);
    const c = new FakeContainer(new FakeClock());
    let n = 0;
    c.interceptOutboundHttp = async (addr: string) => {
      c.calls.push(`intercept:${addr}`);
      if (n++ === 0) throw new Error("intercept refused (fake)");
    };
    const props = gateProps(
      { inst: "t1", epoch: 1, gen: 1, mode: "prod", bootSecret: SECRET, restoreGens: [] },
      env,
    );
    const r = await registerIntercepts(c, gateFactories(exportsOf(env), false), props);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual([CONTROL_ADDR]);
    expect(r.results[REPLICA_ADDR]?.ok).toBe(true);
    expect(() => gateFactories({ ControlGate: () => ({}) }, false)).toThrow(/ReplicaGate/);
  });
});

describe("fakes behind the TEST flag", () => {
  it("TelegramFake and LlmMock answer 404 without OC_TEST=1 or without props.test", async () => {
    const w = new World();
    const props = gateProps(
      { inst: "t1", epoch: 1, gen: 1, mode: "prod", bootSecret: SECRET, restoreGens: [] },
      { OC_TEST: "1" },
    );
    const getMe = new Request("https://api.telegram.org/bot1:x/getMe");
    expect((await new TelegramFake(ctxOf(props), envOf(w, false)).fetch(getMe.clone())).status).toBe(404);
    expect(
      (await new TelegramFake(ctxOf({ ...props, test: undefined }), envOf(w, true)).fetch(getMe.clone()))
        .status,
    ).toBe(404);
    expect((await new TelegramFake(ctxOf(props), envOf(w, true)).fetch(getMe.clone())).status).toBe(200);
    const m = new Request("https://api.anthropic.com/v1/models");
    expect((await new LlmMock(ctxOf(props), envOf(w, false)).fetch(m.clone())).status).toBe(404);
    expect((await new LlmMock(ctxOf(props), envOf(w, true)).fetch(m.clone())).status).toBe(200);
  });

  it("ReplicaGate entry: hello through env wiring", async () => {
    const w = new World();
    const props = gateProps(
      { inst: "t1", epoch: 1, gen: 1, mode: "prod", bootSecret: SECRET, restoreGens: [] },
      {},
    );
    const ch = rid() + rid();
    const r = await new ReplicaGate(ctxOf(props), envOf(w, false)).fetch(
      new Request("http://15.0.0.2/_ocrt/hello", { method: "POST", body: JSON.stringify({ challenge: ch }) }),
    );
    expect(((await r.json()) as { proof: string }).proof).toBe(hmacHex(SECRET, `oc-rhello\0${ch}`));
  });
});
