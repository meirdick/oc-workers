// SandboxGate (gates/sbx.ts) on the real ledger: off, gen fence, exec and sandbox budgets, forwarding.
import { describe, expect, it } from "vitest";
import { handleSandboxGate, MAX_S_HEADER } from "../../src/gates/sbx";
import { decodeFrames, encodeRequest, exitFrame, frame, OUT, readHead } from "../../src/sbx/wire";
import { World } from "./harness";

function setup(o: { on?: boolean; binding?: boolean } = {}) {
  const w = new World();
  w.ledger.o.sandbox = () => o.on ?? true;
  const seen: { maxS: string | null; cmd: string; stdin: string }[] = [];
  const session = {
    async fetch(req: Request) {
      const h = await readHead(req.body as ReadableStream<Uint8Array>);
      seen.push({
        maxS: req.headers.get(MAX_S_HEADER),
        cmd: h.head.cmd,
        stdin: await new Response(h.rest).text(),
      });
      const out = new Uint8Array([...frame(OUT, new TextEncoder().encode("ok")), ...exitFrame(0)]);
      return new Response(out);
    },
  };
  const call = (cmd = "true", path = "/exec", method = "POST", p = w.props) =>
    handleSandboxGate(
      new Request(`http://15.0.0.4${path}`, {
        method,
        body: method === "POST" ? encodeRequest(cmd, new TextEncoder().encode("in")) : undefined,
      }),
      { props: p, ctl: w.ctlPort(), session: o.binding === false ? null : session },
    );
  return { w, seen, call };
}

describe("SandboxGate", () => {
  it("forwards to the session with the exec seconds left; output streams back unchanged", async () => {
    const s = setup();
    s.w.ledger.capsSet({ exec: 100 });
    s.w.ledger.capAdd("exec", 37.5);
    const r = await s.call("echo hi");
    expect(r.status).toBe(200);
    expect(decodeFrames(new Uint8Array(await r.arrayBuffer()))).toEqual({
      stdout: "ok",
      stderr: "",
      code: 0,
    });
    expect(s.seen).toEqual([{ maxS: "62", cmd: "echo hi", stdin: "in" }]);
    // Admission charges nothing: the session charges when the command ends.
    expect(s.w.ledger.capsView().verbs.exec.used).toBe(37.5);
  });

  it("sandbox off → 403 and the session is never reached", async () => {
    const s = setup({ on: false });
    const r = await s.call();
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "sandbox off" });
    expect(s.seen).toEqual([]);
  });

  it("a stale gen (newer gen issued) → 409", async () => {
    const s = setup();
    s.w.addGen(2);
    const r = await s.call();
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "stale", why: "newer-gen" });
    expect(s.seen).toEqual([]);
  });

  it("exec budget spent → 429 exec; sandbox hours spent → 429 sandbox; retry-after to UTC midnight", async () => {
    const s = setup();
    s.w.ledger.capsSet({ exec: 10, sandbox: 1 });
    s.w.ledger.capAdd("exec", 10);
    let r = await s.call();
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "budget", verb: "exec", limit: 10 });
    expect(Number(r.headers.get("retry-after"))).toBe(12 * 3600); // harness T0 is 12:00 UTC
    s.w.ledger.capsSet({ exec: 20 });
    s.w.ledger.capAdd("sandbox", 1.25);
    r = await s.call();
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ verb: "sandbox", used: 1.25, limit: 1 });
    expect(s.seen).toEqual([]);
  });

  it("other paths 404, GET 405, no SANDBOX binding 503", async () => {
    const s = setup();
    expect((await s.call("x", "/caps")).status).toBe(404);
    expect((await s.call("x", "/exec", "GET")).status).toBe(405);
    expect((await setup({ binding: false }).call()).status).toBe(503);
  });
});
