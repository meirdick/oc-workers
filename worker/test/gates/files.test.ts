// docs/11 §8: the files key space of the ReplicaGate (f/<inst>/), its caps and alerts, the doctor probe, and the owner
// routes /ops/caps, /ops/files/purge and the doctor row.
import { afterEach, describe, expect, it } from "vitest";
import { GateLedger } from "../../src/gates/ledger";
import { FILES_PROBE, filesProbe } from "../../src/gates/replica";
import { FakeR2 } from "../harness/r2";
import { type World as SutWorld, INST as WINST } from "../harness/world";
import { done, fresh, sutP } from "../scenarios/helpers";
import { INST, path, rid, World } from "./harness";

const te = new TextEncoder();
const FILES_HOST = "127.0.0.1:18792";
const xmlCode = async (r: Response) => /<Code>([^<]+)<\/Code>/.exec(await r.text())?.[1];
const k = (name: string) => `f/${INST}/${name}`;

async function bound(o: ConstructorParameters<typeof World>[0] = {}) {
  const w = new World(o);
  expect((await w.boot()).status).toBe(200);
  return w;
}
/** Swap in a ledger with small file caps (the ctl port reads w.ledger on each call). */
function caps(w: World, cap: number, objectMax: number) {
  w.ledger = new GateLedger(w.st, { inst: INST, now: w.now, files: () => ({ cap, objectMax }) });
  w.ledger.migrate();
}
const put = (w: World, key: string, body: string, headers: Record<string, string> = {}) =>
  w.s3("PUT", path(key), { body, host: FILES_HOST, headers });
const alertOf = (w: World, cls: string) =>
  w.sql<{ severity: string; count: number }>("SELECT severity, count FROM alerts WHERE class = ?", cls)[0];

describe("files key space: auth and prefix", () => {
  it("the gen key signed for the files forwarder writes and reads f/<inst>/; bad signature, other gen, other iid refused", async () => {
    const w = await bound();
    expect((await put(w, k("a.txt"), "hello")).status).toBe(200);
    expect(w.r2.objs.get(k("a.txt"))?.data).toEqual(te.encode("hello"));
    const g = await w.s3("GET", path(k("a.txt")), { host: FILES_HOST });
    expect([g.status, await g.text()]).toEqual([200, "hello"]);
    // the replica proxy host signs too (same key, either forwarder)
    expect((await w.s3("HEAD", path(k("a.txt")))).status).toBe(200);
    const bad = await w.s3("GET", path(k("a.txt")), {
      host: FILES_HOST,
      tamper: (h) => {
        h.authorization = (h.authorization as string).replace(
          /Signature=(.)/,
          (_, c) => `Signature=${c === "0" ? "1" : "0"}`,
        );
      },
    });
    expect([bad.status, await xmlCode(bad)]).toEqual([403, "SignatureDoesNotMatch"]);
    const og = await w.s3("GET", path(k("a.txt")), { host: FILES_HOST, keyGen: 2 });
    expect([og.status, await xmlCode(og)]).toEqual([409, "Stale"]);
    const oi = await w.s3("GET", path(k("a.txt")), { host: FILES_HOST, keyIid: rid() });
    expect([oi.status, await xmlCode(oi)]).toEqual([409, "Stale"]);
    const anon = await w.s3("GET", path(k("a.txt")), { unsigned: true });
    expect(anon.status).toBe(403);
  });

  it("only this install's prefix: another inst, the bare prefix, and a list of f/ are 403", async () => {
    const w = await bound();
    for (const [m, t] of [
      ["PUT", path(`f/other/x`)],
      ["GET", path(`f/other/x`)],
      ["PUT", path(`f/${INST}/`)],
      ["GET", `/oc-host-${INST}?list-type=2&prefix=f%2F`],
      ["GET", `/oc-host-${INST}?list-type=2&prefix=f%2Fother%2F`],
    ] as const) {
      const r = await w.s3(m, t, { host: FILES_HOST, ...(m === "PUT" ? { body: "x" } : {}) });
      expect([m, t, r.status, await xmlCode(r)]).toEqual([m, t, 403, "AccessDenied"]);
    }
    expect([...w.r2.objs.keys()].filter((x) => x.startsWith("f/"))).toEqual([]);
  });

  it("the replica rule is unchanged: the gen key cannot write outside r/<inst>/g<gen>/ and f/<inst>/", async () => {
    const w = await bound();
    const r = await w.s3("PUT", path(`r/${INST}/g2/state/x`), { body: "x" });
    expect(r.status).toBe(403);
    const a = await w.s3("PUT", path(`a/${INST}/x.tar.gz`), { body: "x", host: FILES_HOST });
    expect(a.status).toBe(403);
  });

  it("files are stable across gens: gen 2 reads what gen 1 wrote; the gen 1 key is then stale", async () => {
    const w = await bound();
    expect((await put(w, k("keep.md"), "v1")).status).toBe(200);
    w.addGen(2);
    w.props.gen = 2;
    const oldIid = w.iid;
    w.iid = rid();
    expect((await w.boot()).status).toBe(200);
    const g = await w.s3("GET", path(k("keep.md")), { host: FILES_HOST });
    expect([g.status, await g.text()]).toEqual([200, "v1"]);
    const stale = await w.s3("GET", path(k("keep.md")), { host: FILES_HOST, keyGen: 1, keyIid: oldIid });
    expect(stale.status).toBe(409);
  });

  it("canary mode cannot write files, can read", async () => {
    const w = await bound();
    expect((await put(w, k("c"), "1")).status).toBe(200);
    const r = await w.s3("PUT", path(k("d")), { body: "1", host: FILES_HOST, props: { mode: "canary" } });
    expect(r.status).toBe(403);
    expect((await w.s3("GET", path(k("c")), { host: FILES_HOST, props: { mode: "canary" } })).status).toBe(
      200,
    );
  });
});

describe("files key space: ops", () => {
  it("Head, Get with range, Delete, ListObjectsV2 with prefix and continuation", async () => {
    const w = await bound();
    for (const n of ["d/1", "d/2", "d/3", "e/1"]) expect((await put(w, k(n), `body-${n}`)).status).toBe(200);
    const h = await w.s3("HEAD", path(k("d/2")), { host: FILES_HOST });
    expect([h.status, h.headers.get("content-length")]).toEqual([200, "8"]);
    const rg = await w.s3("GET", path(k("d/2")), { host: FILES_HOST, headers: { range: "bytes=5-7" } });
    expect([rg.status, await rg.text()]).toEqual([206, "d/2"]);
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix: k("d/"), "max-keys": "2" });
      if (token) q.set("continuation-token", token);
      const r = await w.s3("GET", `/oc-host-${INST}?${q}`, { host: FILES_HOST });
      expect(r.status).toBe(200);
      const x = await r.text();
      seen.push(...[...x.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1] as string));
      token = /<IsTruncated>true/.test(x) ? /<NextContinuationToken>([^<]+)</.exec(x)?.[1] : undefined;
      pages++;
    } while (token);
    expect(seen).toEqual([k("d/1"), k("d/2"), k("d/3")]);
    expect(pages).toBe(2);
    expect((await w.s3("DELETE", path(k("d/1")), { host: FILES_HOST })).status).toBe(204);
    expect(w.r2.objs.has(k("d/1"))).toBe(false);
    expect((await w.s3("GET", path(k("d/1")), { host: FILES_HOST })).status).toBe(404);
  });

  it("If-None-Match: * never overwrites (412); a plain PUT replaces", async () => {
    const w = await bound();
    expect((await put(w, k("once"), "a", { "if-none-match": "*" })).status).toBe(200);
    const r = await put(w, k("once"), "b", { "if-none-match": "*" });
    expect([r.status, await xmlCode(r)]).toEqual([412, "PreconditionFailed"]);
    expect(w.r2.objs.get(k("once"))?.data).toEqual(te.encode("a"));
    expect((await put(w, k("once"), "bb")).status).toBe(200);
    expect(w.r2.objs.get(k("once"))?.data).toEqual(te.encode("bb"));
  });

  it("If-Match (file_store update): the read ETag replaces; a change from outside is 412 and keeps it; * needs the object; If-None-Match with If-Match is 400", async () => {
    const w = await bound();
    expect((await put(w, k("doc.md"), "v1", { "if-none-match": "*" })).status).toBe(200);
    const g = await w.s3("GET", path(k("doc.md")), { host: FILES_HOST });
    const etag = g.headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const u = await put(w, k("doc.md"), "v2", { "if-match": etag });
    expect(u.status).toBe(200);
    const etag2 = u.headers.get("etag") as string;
    expect(etag2).not.toBe(etag);
    // the owner's sync writes straight to R2
    await w.r2.put(k("doc.md"), "v2-laptop");
    const c = await put(w, k("doc.md"), "v3", { "if-match": etag2 });
    expect([c.status, await xmlCode(c)]).toEqual([412, "PreconditionFailed"]);
    expect(w.r2.objs.get(k("doc.md"))?.data).toEqual(te.encode("v2-laptop"));
    // a bare ETag (no quotes) works too
    const bare = (await w.s3("HEAD", path(k("doc.md")), { host: FILES_HOST })).headers.get("etag") as string;
    expect((await put(w, k("doc.md"), "v4", { "if-match": bare.replace(/"/g, "") })).status).toBe(200);
    expect((await put(w, k("doc.md"), "v5", { "if-match": "*" })).status).toBe(200);
    expect(w.r2.objs.get(k("doc.md"))?.data).toEqual(te.encode("v5"));
    const nf = await put(w, k("nope.md"), "x", { "if-match": "*" });
    expect([nf.status, await xmlCode(nf)]).toEqual([404, "NoSuchKey"]);
    expect(w.r2.objs.has(k("nope.md"))).toBe(false);
    const both = await put(w, k("doc.md"), "x", { "if-match": "*", "if-none-match": "*" });
    expect([both.status, await xmlCode(both)]).toEqual([400, "InvalidArgument"]);
    // an overwrite counts the new size only
    expect(w.ledger.filesView()).toMatchObject({ used: 2, objects: 1 });
  });

  it("If-Match race: R2 refuses the put when the object changed after the gate's check (412)", async () => {
    const w = await bound();
    expect((await put(w, k("r.md"), "v1")).status).toBe(200);
    const etag = (await w.s3("HEAD", path(k("r.md")), { host: FILES_HOST })).headers.get("etag") as string;
    const head = w.r2.head.bind(w.r2);
    w.r2.head = async (key: string) => {
      const o = await head(key);
      await w.r2.put(k("r.md"), "changed between head and put");
      return o;
    };
    const r = await put(w, k("r.md"), "v2", { "if-match": etag });
    expect([r.status, await xmlCode(r)]).toEqual([412, "PreconditionFailed"]);
    expect(new TextDecoder().decode(w.r2.objs.get(k("r.md"))?.data)).toBe("changed between head and put");
  });

  it("multipart is refused with 501; a batch delete (replica rule) deletes no file", async () => {
    const w = await bound();
    expect((await put(w, k("x"), "keep")).status).toBe(200);
    const c = await w.s3("POST", `${path(k("big"))}?uploads`, { host: FILES_HOST, body: "" });
    expect([c.status, await xmlCode(c)]).toEqual([501, "NotImplemented"]);
    const p = await w.s3("PUT", `${path(k("big"))}?partNumber=1&uploadId=x`, { host: FILES_HOST, body: "x" });
    expect(p.status).toBe(501);
    const d = await w.s3("POST", `/oc-host-${INST}?delete`, {
      host: FILES_HOST,
      body: `<Delete><Object><Key>${k("x")}</Key></Object></Delete>`,
    });
    expect(d.status).toBe(200);
    expect(await d.text()).toMatch(/<Error><Key>f\/t1\/x<\/Key><Code>AccessDenied<\/Code>/);
    expect(w.r2.objs.has(k("x"))).toBe(true);
    expect(w.r2.uploads.size).toBe(0);
  });
});

describe("files caps and storage-cap alerts", () => {
  it("per-object cap: 400 EntityTooLarge before R2", async () => {
    const w = await bound();
    caps(w, 1_000_000, 10);
    const r = await put(w, k("x"), "12345678901");
    expect([r.status, await xmlCode(r)]).toEqual([400, "EntityTooLarge"]);
    expect(w.r2.objs.has(k("x"))).toBe(false);
    expect((await put(w, k("x"), "1234567890")).status).toBe(200);
  });

  it("per-install cap: warn at 80 %, refuse and high alert at 100 %; overwrite counts the new size; delete frees", async () => {
    const w = await bound();
    caps(w, 100, 100);
    expect((await put(w, k("a"), "x".repeat(70))).status).toBe(200);
    expect(alertOf(w, "storage-cap-80")).toBeUndefined();
    expect((await put(w, k("b"), "x".repeat(15))).status).toBe(200); // 85 %
    expect(alertOf(w, "storage-cap-80")?.severity).toBe("warn");
    const r = await put(w, k("c"), "x".repeat(20)); // 105 % → refused
    expect([r.status, await xmlCode(r)]).toEqual([403, "StorageCapExceeded"]);
    expect(w.r2.objs.has(k("c"))).toBe(false);
    expect(alertOf(w, "storage-cap-100")?.severity).toBe("high");
    // overwrite a (70) with 85 bytes: 85 + 15 = 100, exactly at the cap → allowed, and the 100 % alert counts again
    expect((await put(w, k("a"), "x".repeat(85))).status).toBe(200);
    expect(w.ledger.filesView()).toMatchObject({ used: 100, limit: 100, objects: 2 });
    expect(alertOf(w, "storage-cap-100")?.count).toBe(2);
    expect((await put(w, k("d"), "x")).status).toBe(403);
    expect((await w.s3("DELETE", path(k("a")), { host: FILES_HOST })).status).toBe(204);
    expect(w.ledger.filesView()).toMatchObject({ used: 15, objects: 1 });
    expect((await put(w, k("d"), "x")).status).toBe(200);
  });
});

describe("filesProbe (doctor row)", () => {
  it("PUT, GET, DELETE of 1 byte under f/<inst>/ leaves nothing", async () => {
    const r2 = new FakeR2();
    const r = await filesProbe(r2 as never, "ab12cd");
    expect(r.ok).toBe(true);
    expect(r2.ops.map((o) => `${o.op} ${o.key}`)).toEqual([
      `put f/ab12cd/${FILES_PROBE}`,
      `get f/ab12cd/${FILES_PROBE}`,
      `delete f/ab12cd/${FILES_PROBE}`,
      `head f/ab12cd/${FILES_PROBE}`,
    ]);
    expect(r2.objs.size).toBe(0);
  });
  it("an R2 error is a failed probe with the error, never a throw", async () => {
    const r2 = new FakeR2(() => 10);
    r2.failUntil = 100;
    const r = await filesProbe(r2 as never, "ab12cd");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/);
  });
});

const sut = await sutP;
describe.skipIf(!sut.ok)(`owner routes ${sut.why}`, () => {
  let w: SutWorld;
  afterEach((ctx) => done(w, ctx));

  it("/ops/caps shows the files cap; /ops/files/purge deletes f/<inst>/ only; doctor row PASS with location r2", async () => {
    w = await fresh(sut);
    for (let i = 0; i < 3; i++) await w.r2.put(`f/${WINST}/n${i}`, "abc");
    await w.r2.put(`f/other/x`, "z");
    await w.r2.put(`a/${WINST}/arch.tar.gz`, "z");
    const c = await w.ops("caps");
    expect(c.status).toBe(200);
    expect(c.body.files).toMatchObject({ limit: 5e9, objectMax: 100e6 });
    const p = await w.ops("files/purge", {});
    expect(p).toMatchObject({ status: 200, body: { ok: true, deleted: 3, more: false } });
    expect([...w.r2.objs.keys()].sort()).toEqual([`a/${WINST}/arch.tar.gz`, "f/other/x"]);

    const doc = {
      storage: {
        locations: {
          r2: {
            provider: "ochost-r2",
            settings: {
              endpoint: "http://127.0.0.1:18792",
              bucket: `oc-host-${WINST}`,
              prefix: `f/${WINST}`,
            },
            encryption: "none",
          },
        },
      },
    };
    expect((await w.ops("config", { doc })).status).toBe(200);
    const d = await w.ops("doctor?fresh=1");
    const row = (d.body.checks as { name: string; result: string; detail: string }[]).find(
      (x) => x.name === "file storage",
    );
    expect(row).toMatchObject({ result: "PASS" });
    expect(row?.detail).toMatch(/^on, location r2, put\+get\+delete \d+ ms; 0 B of 5\.0 GB used$/);
    expect([...w.r2.objs.keys()].some((x) => x.includes(FILES_PROBE))).toBe(false);
  });
});
