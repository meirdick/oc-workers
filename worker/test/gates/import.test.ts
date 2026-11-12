// `ochost import`: the shared rules (gates/import-policy.ts), the ControlGate side (heartbeat ack, bundle, done)
// and the owner routes (PUT /ops/import/file|bundle, GET /ops/import/files, POST /ops/import/apply, GET /ops/import).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  cronProblem,
  IMPORT_RETRY_MS,
  IMPORT_STALL_MS,
  type ImportRequest,
  importStalled,
  keyOk,
  newRequest,
  relOk,
  takeForHeartbeat,
} from "../../src/gates/import-policy";
import { type World as SutWorld, INST as WINST } from "../harness/world";
import { done, fresh, sutP } from "../scenarios/helpers";
import { INST, World } from "./harness";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const job = {
  key: "import:sunday-reflection",
  name: "sunday-reflection",
  cron: "0 14 * * 0",
  tz: "UTC",
  message: "Ask the owner for the weekly reflection.",
  session: "isolated",
  enabled: true,
  announce: { channel: "telegram", to: "100000001" },
};
const body = (o: Record<string, unknown> = {}) => ({
  id: "seed-1",
  sha256: sha("bundle"),
  bytes: 6,
  overwrite: ["AGENTS.md"],
  remove: ["BOOTSTRAP.md"],
  cron: [job],
  ...o,
});

describe("import policy", () => {
  it("newRequest accepts a good body and names the first bad field", () => {
    const ok = newRequest(body(), 5);
    expect("req" in ok && ok.req).toMatchObject({
      id: "seed-1",
      state: "pending",
      at: 5,
      tries: 0,
      remove: ["BOOTSTRAP.md"],
    });
    expect(newRequest(body({ id: "Seed_1" }), 0)).toMatchObject({ error: expect.stringMatching(/^id/) });
    expect(newRequest(body({ sha256: "x" }), 0)).toEqual({ error: "sha256" });
    expect(newRequest(body({ bytes: 0 }), 0)).toEqual({ error: "bytes" });
    expect(newRequest(body({ overwrite: ["../etc/passwd"] }), 0)).toEqual({ error: "overwrite" });
    expect(newRequest(body({ remove: ["/abs"] }), 0)).toEqual({ error: "remove" });
    expect(newRequest(body({ cron: [{ ...job, cron: "every day" }] }), 0)).toEqual({
      error: "cron[0]: cron",
    });
  });

  it("cron entries: argv-bound values are capped and typed", () => {
    expect(cronProblem(job)).toBeNull();
    expect(cronProblem({ ...job, cron: "0 0 1 1 * 2026" })).toBeNull(); // 6 fields
    expect(cronProblem({ ...job, key: "Import X" })).toBe("key");
    expect(cronProblem({ ...job, message: "" })).toBe("message");
    expect(cronProblem({ ...job, session: "current" })).toBe("session");
    expect(cronProblem({ ...job, tz: "UTC; rm -rf /" })).toBe("tz");
    expect(cronProblem({ ...job, announce: { channel: "telegram", to: "@me" } })).toBe("announce");
    expect(cronProblem({ ...job, enabled: "yes" })).toBe("enabled");
  });

  it("keys follow the file_store rule; overwrite paths stay relative", () => {
    expect(keyOk("records/app/2024/report_2024.pdf")).toBe(true);
    expect(keyOk("my docs/a b+c #1 100%.pdf")).toBe(true);
    expect(keyOk("café/résumé.pdf")).toBe(true);
    for (const k of ["/a", "a//b", "a/../b", "./a", "", "a\\b", "a\nb", "a/"])
      expect([k, keyOk(k)]).toEqual([k, false]);
    expect(relOk("projects/My File.md")).toBe(true);
    for (const k of ["/a", "a/../b", "a//b", "a\nb"]) expect([k, relOk(k)]).toEqual([k, false]);
  });

  it("a request goes out once per take; again only to another gen or after the retry window; stalls end it", () => {
    const r = (newRequest(body(), 0) as { req: ImportRequest }).req;
    const t1 = takeForHeartbeat(r, 3, 10);
    expect(t1?.give).toMatchObject({ state: "running", takenGen: 3, takenAt: 10, tries: 1 });
    const run = t1?.next as ImportRequest;
    expect(takeForHeartbeat(run, 3, 20)).toBeNull();
    expect(takeForHeartbeat(run, 4, 20)?.give.tries).toBe(2);
    expect(takeForHeartbeat(run, 3, 10 + IMPORT_RETRY_MS + 1)?.give.tries).toBe(2);
    expect(importStalled(run, 10 + IMPORT_STALL_MS + 1)).toBe(true);
    expect(takeForHeartbeat(run, 3, 10 + IMPORT_STALL_MS + 1)).toBeNull();
    expect(takeForHeartbeat({ ...run, state: "done" }, 4, 20)).toBeNull();
  });
});

describe("ControlGate: heartbeat ack, bundle, done", () => {
  async function setup(mode = "prod") {
    const w = new World({ mode } as never);
    expect((await w.boot()).status).toBe(200);
    const req = (newRequest(body(), w.now()) as { req: ImportRequest }).req;
    w.sql("INSERT INTO meta (k, v) VALUES ('importRequest', ?)", JSON.stringify(req));
    await w.r2.put(`imp/${INST}/seed-1.tar.gz`, "bundle");
    let seq = 0;
    const hb = async () =>
      (await (
        await w.control(
          "POST",
          "/v1/heartbeat",
          w.env({ seq: ++seq, phase: "running", draining: false, lastActivityAt: 1, channels: [] }),
          { iid: w.iid },
        )
      ).json()) as Record<string, any>;
    return { w, hb };
  }
  const meta = (w: World) =>
    JSON.parse(w.sql<{ v: string }>("SELECT v FROM meta WHERE k = 'importRequest'")[0]?.v ?? "null");

  it("the ack names the request once; the bundle streams for that id only; done closes it", async () => {
    const { w, hb } = await setup();
    const a1 = await hb();
    expect(a1.import).toMatchObject({
      id: "seed-1",
      sha256: sha("bundle"),
      bytes: 6,
      remove: ["BOOTSTRAP.md"],
    });
    expect(a1.import.cron[0]).toMatchObject({ name: "sunday-reflection" });
    expect(meta(w)).toMatchObject({ state: "running", tries: 1 });
    expect((await hb()).import).toBeUndefined();

    const g = await w.control("GET", "/v1/import/bundle?id=seed-1", undefined, { iid: w.iid });
    expect([g.status, await g.text()]).toEqual([200, "bundle"]);
    expect((await w.control("GET", "/v1/import/bundle?id=other", undefined, { iid: w.iid })).status).toBe(
      404,
    );
    const d = await w.control(
      "POST",
      "/v1/import/done",
      w.env({ id: "seed-1", ok: true, result: { n: 1 } }),
      {
        iid: w.iid,
      },
    );
    expect(d.status).toBe(200);
    expect(meta(w)).toMatchObject({ state: "done", result: { n: 1 } });
    expect((await w.control("GET", "/v1/import/bundle?id=seed-1", undefined, { iid: w.iid })).status).toBe(
      404,
    );
    expect((await hb()).import).toBeUndefined();
  });

  it("a failed import ends the request with an alert; a size mismatch in R2 is a 409", async () => {
    const { w, hb } = await setup();
    await hb();
    await w.r2.put(`imp/${INST}/seed-1.tar.gz`, "bundle-changed");
    expect((await w.control("GET", "/v1/import/bundle?id=seed-1", undefined, { iid: w.iid })).status).toBe(
      409,
    );
    const d = await w.control(
      "POST",
      "/v1/import/done",
      w.env({ id: "seed-1", ok: false, why: "apply: tar 2" }),
      {
        iid: w.iid,
      },
    );
    expect(d.status).toBe(200);
    expect(meta(w)).toMatchObject({ state: "failed", why: "apply: tar 2" });
    expect(w.sql("SELECT class FROM alerts WHERE class = 'import-failed'")).toHaveLength(1);
  });

  it("a canary gen never takes the request", async () => {
    const { hb } = await setup("canary");
    expect((await hb()).import).toBeUndefined();
  });
});

const sut = await sutP;
describe.skipIf(!sut.ok)(`owner routes ${sut.why}`, () => {
  let w: SutWorld;
  afterEach((ctx) => done(w, ctx));
  const put = (path: string, data: string) =>
    w.fetch(path, { method: "PUT", body: data, headers: { "content-length": String(data.length) } });

  it("file: stored once with its sha256, counted in file storage; same bytes skip, other bytes 409, bad sha 400", async () => {
    w = await fresh(sut);
    const f = await put(`/ops/import/file?key=records/a.pdf&sha256=${sha("pdf")}`, "pdf");
    expect([f.status, await f.json()]).toEqual([
      200,
      { ok: true, key: `f/${WINST}/records/a.pdf`, bytes: 3 },
    ]);
    expect(w.r2.objs.get(`f/${WINST}/records/a.pdf`)?.customMetadata).toMatchObject({ sha256: sha("pdf") });
    expect((await w.ops("caps")).body.files).toMatchObject({ used: 3, objects: 1 });
    const again = await put(`/ops/import/file?key=records/a.pdf&sha256=${sha("pdf")}`, "pdf");
    expect(await again.json()).toMatchObject({ skipped: true });
    expect((await put(`/ops/import/file?key=records/a.pdf&sha256=${sha("PDF")}`, "PDF")).status).toBe(409);
    expect((await put(`/ops/import/file?key=records/b.pdf&sha256=${sha("x")}`, "y")).status).toBe(400);
    expect(w.r2.objs.has(`f/${WINST}/records/b.pdf`)).toBe(false);
    expect((await put(`/ops/import/file?key=records/../b.pdf&sha256=${sha("x")}`, "x")).status).toBe(400);
    const l = await w.fetch("/ops/import/files?prefix=records/");
    expect(await l.json()).toEqual({
      objects: [{ key: "records/a.pdf", size: 3, sha256: sha("pdf") }],
      truncated: false,
      cursor: null,
    });
    expect((await w.fetch("/ops/import/files?prefix=x", { token: "ci" })).status).toBe(404);
  });

  it("bundle + apply: the request waits for the bundle, holds the sleep, and one open request at a time", async () => {
    w = await fresh(sut);
    const b = body();
    expect((await w.ops("import/apply", b)).body).toMatchObject({ error: "bundle-missing" });
    expect((await put(`/ops/import/bundle?id=seed-1&sha256=${sha("bundle")}`, "bundle")).status).toBe(200);
    expect(w.r2.objs.has(`imp/${WINST}/seed-1.tar.gz`)).toBe(true);
    const a = await w.ops("import/apply", b);
    expect(a.status).toBe(202);
    expect(a.body.request).toMatchObject({ id: "seed-1", state: "pending" });
    expect((await w.ops("import/apply", b)).body).toMatchObject({ same: true });
    expect((await w.ops("import/apply", { ...b, id: "seed-2" })).status).toBe(409);
    expect((await w.ops("import")).body.request).toMatchObject({ id: "seed-1" });
    const si = (await w.ctl().call("sleepInputs")) as { blockers: string[] };
    expect(si.blockers).toContain("import:seed-1");
    expect((await w.ops("import/apply", { ...b, cron: [{ ...job, cron: "x" }] })).status).toBe(400);
    // The sandbox merge waits for the container's apply; a bad id is a 400.
    const sb = await w.ops("import/sandbox", { id: "seed-1" });
    expect([200, 409]).toContain(sb.status);
    if (sb.status === 200) expect(sb.body).toMatchObject({ skipped: "no SANDBOX binding" });
    else expect(sb.body).toMatchObject({ error: "not-done" });
    expect((await w.ops("import/sandbox", { id: "../x" })).status).toBe(400);
  });
});
