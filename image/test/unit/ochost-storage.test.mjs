// docs/11 §8: the ochost-storage plugin (backend.mjs, tool.mjs) and ocsup's files.mjs against a mock S3 endpoint
// that checks SigV4 with the harness verifier (fakes/gate-core.mjs), keeps objects in memory, honours
// If-None-Match: * and If-Match (404 when absent, 412 on another etag, like the gate) and pages ListObjectsV2.
// One test goes through the real loopback forwarder (cap-proxy.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { FILES_PROXY_PORT, startCapProxy } from "../../ocrt/lib/cap-proxy.mjs";
import { ensureFilesMarker, filesKeyText, writeFilesKey } from "../../ocrt/lib/files.mjs";
import { createBackend, describeTarget, validateSettings } from "../../plugins/ochost-storage/backend.mjs";
import { locationOf, runFileStore } from "../../plugins/ochost-storage/tool.mjs";
import { verifySigV4 } from "../fakes/gate-core.mjs";

const KEY = { accessKeyId: "ocrt-g7-0123456789abcdef0123456789abcdef", secretAccessKey: "s".repeat(64) };
const BUCKET = "oc-host-ab12cd";
const PREFIX = "f/ab12cd";

/** Mock S3: path style /<bucket>/<key>. LIST pages 2 keys at a time. */
function mockS3() {
  const objs = new Map();
  const log = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const v = verifySigV4({
        method: req.method,
        rawPath: req.url,
        headers: req.headers,
        body,
        secretFor: (id) => (id === KEY.accessKeyId ? KEY.secretAccessKey : null),
      });
      const u = new URL(req.url, "http://x");
      const segs = u.pathname.split("/").slice(1).map(decodeURIComponent);
      const key = segs.slice(1).join("/");
      log.push({
        m: req.method,
        key,
        sig: v.ok,
        inm: req.headers["if-none-match"] ?? null,
        im: req.headers["if-match"] ?? null,
      });
      const etagOf = (k) => createHash("md5").update(objs.get(k)).digest("hex");
      const err = (s, code) => {
        res.writeHead(s, { "content-type": "application/xml" });
        res.end(`<Error><Code>${code}</Code><Message>${code} msg</Message></Error>`);
      };
      if (!v.ok) return err(403, "SignatureDoesNotMatch");
      if (segs[0] !== BUCKET) return err(404, "NoSuchBucket");
      if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
        const pre = u.searchParams.get("prefix") ?? "";
        const all = [...objs.keys()].filter((k) => k.startsWith(pre)).sort();
        const tok = u.searchParams.get("continuation-token");
        const from = tok ? all.indexOf(tok) : 0;
        const page = all.slice(from, from + 2);
        const next = all[from + 2];
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<ListBucketResult><IsTruncated>${!!next}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${page
            .map(
              (k) =>
                `<Contents><Key>${k}</Key><LastModified>2026-11-06T00:00:00.000Z</LastModified><Size>${objs.get(k).length}</Size></Contents>`,
            )
            .join("")}</ListBucketResult>`,
        );
      }
      if (req.method === "PUT") {
        if (key === `${PREFIX}/big`) return err(403, "StorageCapExceeded");
        if (req.headers["if-none-match"] === "*" && objs.has(key)) return err(412, "PreconditionFailed");
        const im = req.headers["if-match"];
        if (im !== undefined && !objs.has(key)) return err(404, "NoSuchKey");
        if (im !== undefined && im !== "*" && im.replace(/"/g, "") !== etagOf(key))
          return err(412, "PreconditionFailed");
        objs.set(key, body);
        res.writeHead(200, { etag: `"${etagOf(key)}"` });
        return res.end();
      }
      const o = objs.get(key);
      const meta = () => ({ etag: `"${etagOf(key)}"`, "last-modified": new Date(0).toUTCString() });
      if (req.method === "HEAD") {
        res.writeHead(o ? 200 : 404, o ? { "content-length": o.length, ...meta() } : {});
        return res.end();
      }
      if (req.method === "GET") {
        if (!o) return err(404, "NoSuchKey");
        res.writeHead(200, meta());
        return res.end(o);
      }
      if (req.method === "DELETE") {
        objs.delete(key);
        res.writeHead(204);
        return res.end();
      }
      err(501, "NotImplemented");
    });
  });
  return { srv, objs, log };
}

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};
const once = (b) =>
  (async function* () {
    yield new Uint8Array(Buffer.from(b));
  })();

describe("ochost-storage backend against a mock S3 gate", () => {
  let m;
  let settings;
  let ws;
  before(async () => {
    m = mockS3();
    const port = await listen(m.srv);
    settings = { endpoint: `http://127.0.0.1:${port}`, bucket: BUCKET, prefix: PREFIX };
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  });
  after(() => m.srv.close());

  it("settings: the rendered shape is valid; a credential key, a public endpoint or a bad prefix is refused", () => {
    assert.equal(validateSettings({ ...settings, endpoint: "http://127.0.0.1:18792" }), undefined);
    assert.match(validateSettings({ ...settings, accessKeyId: "x" }), /only accept/);
    assert.match(validateSettings({ ...settings, endpoint: "http://15.0.0.2" }), /loopback/);
    assert.match(validateSettings({ ...settings, prefix: "f/ab12cd/" }), /prefix/);
    assert.equal(describeTarget(settings), "r2://oc-host-ab12cd/f/ab12cd (oc-host gate)");
  });

  it("put, stat, get, list (paged), delete: signed with the key file's key, keys under the prefix", async () => {
    const b = createBackend(settings, { readKey: () => KEY });
    for (const n of ["a/1", "a/2", "a/3", "b/1"])
      assert.deepEqual(await b.putObject(n, once(`v-${n}`), { sizeBytes: 5 }), { sizeBytes: 5 });
    assert.ok(m.log.every((x) => x.sig));
    assert.ok(m.log.filter((x) => x.m === "PUT").every((x) => x.inm === "*"));
    assert.deepEqual([...m.objs.keys()].sort(), [
      "f/ab12cd/a/1",
      "f/ab12cd/a/2",
      "f/ab12cd/a/3",
      "f/ab12cd/b/1",
    ]);
    const md5 = (s) => createHash("md5").update(s).digest("hex");
    assert.deepEqual(await b.statObject("a/2"), {
      key: "a/2",
      sizeBytes: 5,
      modifiedAt: 0,
      etag: md5("v-a/2"),
    });
    assert.equal(await b.statObject("nope"), undefined);
    assert.equal(Buffer.concat(await collect(await b.getObject("a/3"))).toString(), "v-a/3");
    assert.equal(await b.getObject("nope"), undefined);
    const listed = await collect(b.listObjects("a/"));
    assert.deepEqual(
      listed.map((x) => x.key),
      ["a/1", "a/2", "a/3"],
    );
    await b.deleteObject("a/1");
    assert.equal(m.objs.has("f/ab12cd/a/1"), false);
    await b.probe();
  });

  it("never overwrites: a second put of the same key fails with 'already exists'", async () => {
    const b = createBackend(settings, { readKey: () => KEY });
    await b.putObject("once", once("1"), {});
    await assert.rejects(b.putObject("once", once("2"), {}), /already exists/);
    assert.equal(m.objs.get("f/ab12cd/once").toString(), "1");
  });

  it("replaceObject: If-Match with the etag replaces; another etag is 'conflict', a missing key 'not-found'; putObject sends no If-Match", async () => {
    const b = createBackend(settings, { readKey: () => KEY });
    const c = await b.createObject("doc.md", once("v1"), {});
    assert.match(c.etag, /^[0-9a-f]{32}$/);
    const r = await b.readObject("doc.md");
    assert.equal(r.etag, c.etag);
    assert.equal(r.modifiedAt, 0);
    assert.equal(Buffer.concat(await collect(r.body)).toString(), "v1");
    const u = await b.replaceObject("doc.md", once("v2"), { ifMatch: c.etag });
    assert.equal(u.sizeBytes, 2);
    assert.notEqual(u.etag, c.etag);
    assert.equal(m.log.at(-1).im, `"${c.etag}"`);
    await assert.rejects(
      b.replaceObject("doc.md", once("v3"), { ifMatch: c.etag }),
      (e) => e.code === "conflict",
    );
    assert.equal(m.objs.get("f/ab12cd/doc.md").toString(), "v2");
    await assert.rejects(
      b.replaceObject("gone.md", once("x"), { ifMatch: "*" }),
      (e) => e.code === "not-found",
    );
    await b.replaceObject("doc.md", once("v4"), { ifMatch: "*" });
    assert.equal(m.log.at(-1).im, "*");
    assert.equal(m.objs.get("f/ab12cd/doc.md").toString(), "v4");
    await assert.rejects(b.replaceObject("doc.md", once("v5"), {}), /ifMatch/);
    assert.ok(m.log.filter((x) => x.m === "PUT" && x.inm === "*").every((x) => x.im === null));
  });

  it("file_store update: save, read for the etag, update; a change from outside is a conflict with the current etag; save of a used name says to update", async () => {
    const cfg = {
      storage: { locations: { r2: { provider: "ochost-r2", settings, encryption: "none" } } },
      plugins: { entries: { "ochost-storage": { config: { location: "r2" } } } },
    };
    const backend = createBackend(settings, { readKey: () => KEY });
    const run = (a) => runFileStore(a, { cfg, workspaceDir: ws, backend });
    const s = await run({ action: "save", name: "synced/todo.md", content: "- a" });
    assert.equal(s.ok, true);
    const again = await run({ action: "save", name: "synced/todo.md", content: "- b" });
    assert.deepEqual([again.ok, again.exists], [false, true]);
    assert.match(again.error, /read it, then update with the etag/);
    const r = await run({ action: "read", name: "synced/todo.md" });
    assert.equal(r.etag, s.etag);
    assert.equal(r.modifiedAt, new Date(0).toISOString());
    const u = await run({ action: "update", name: "synced/todo.md", content: "- a\n- b", etag: r.etag });
    assert.equal(u.ok, true);
    assert.equal(u.sizeBytes, 7);
    // the laptop sync writes straight to R2 (not through the gate)
    m.objs.set("f/ab12cd/synced/todo.md", Buffer.from("- a\n- c"));
    const c = await run({ action: "update", name: "synced/todo.md", content: "- a\n- b\n- d", etag: u.etag });
    assert.equal(c.ok, false);
    assert.equal(c.conflict, true);
    assert.equal(c.currentEtag, createHash("md5").update("- a\n- c").digest("hex"));
    assert.match(c.error, /Nothing was written\. Read it again/);
    assert.equal(m.objs.get("f/ab12cd/synced/todo.md").toString(), "- a\n- c");
    const r2 = await run({ action: "read", name: "synced/todo.md" });
    assert.equal(r2.etag, c.currentEtag);
    const u2 = await run({
      action: "update",
      name: "synced/todo.md",
      content: "- a\n- c\n- d",
      etag: r2.etag,
    });
    assert.equal(u2.ok, true);
    fs.writeFileSync(path.join(ws, "todo.md"), "from path");
    assert.equal(
      (await run({ action: "update", name: "synced/todo.md", path: "todo.md", etag: "*" })).ok,
      true,
    );
    assert.equal(m.objs.get("f/ab12cd/synced/todo.md").toString(), "from path");
    await assert.rejects(
      run({ action: "update", name: "synced/todo.md", content: "x" }),
      /update needs etag/,
    );
    await assert.rejects(
      run({ action: "update", name: "synced/todo.md", etag: "*" }),
      /update needs content or path/,
    );
    assert.match(
      (await run({ action: "update", name: "nope.md", content: "x", etag: "*" })).error,
      /use save/,
    );
  });

  it("a cap refusal names the setting to raise; a wrong key is a clear error; a declared size must match", async () => {
    const b = createBackend(settings, { readKey: () => KEY });
    await assert.rejects(b.putObject("big", once("x"), {}), /files\.capGb/);
    const bad = createBackend(settings, { readKey: () => ({ ...KEY, secretAccessKey: "t".repeat(64) }) });
    await assert.rejects(bad.putObject("z", once("x"), {}), /403 SignatureDoesNotMatch/);
    await assert.rejects(b.putObject("z2", once("xy"), { sizeBytes: 5 }), /declared size/);
    const nokey = createBackend({ ...settings, keyFile: "/nonexistent/files-key.json" });
    await assert.rejects(nokey.statObject("a"), /files-key\.json is missing/);
  });

  it("reads the key file ocsup writes (0400) on each request", async () => {
    const p = path.join(ws, "files-key.json");
    writeFilesKey(p, { accessKey: KEY.accessKeyId, secretKey: KEY.secretAccessKey }, { asRoot: true });
    assert.equal(fs.statSync(p).mode & 0o777, 0o400);
    assert.equal(
      fs.readFileSync(p, "utf8"),
      filesKeyText({ accessKey: KEY.accessKeyId, secretKey: KEY.secretAccessKey }),
    );
    const b = createBackend({ ...settings, keyFile: p });
    await b.putObject("from-file", once("k"), {});
    assert.equal(m.objs.get("f/ab12cd/from-file").toString(), "k");
  });

  it("file_store tool: save text and a workspace file, list hides the marker, read inline and to a path, delete", async () => {
    const cfg = {
      storage: { locations: { r2: { provider: "ochost-r2", settings, encryption: "none" } } },
      plugins: { entries: { "ochost-storage": { config: { location: "r2" } } } },
    };
    m.objs.set("f/ab12cd/openclaw-storage.json", Buffer.from("{}"));
    const backend = createBackend(settings, { readKey: () => KEY });
    const run = (a) => runFileStore(a, { cfg, workspaceDir: ws, backend });
    assert.deepEqual(await run({ action: "save", name: "notes/today.md", content: "hello" }), {
      ok: true,
      action: "save",
      location: "r2",
      name: "notes/today.md",
      sizeBytes: 5,
      etag: createHash("md5").update("hello").digest("hex"),
    });
    fs.writeFileSync(path.join(ws, "img.bin"), Buffer.from([1, 2, 3]));
    assert.equal((await run({ action: "save", name: "notes/img.bin", path: "img.bin" })).sizeBytes, 3);
    const l = await run({ action: "list", prefix: "notes/" });
    assert.deepEqual(
      l.files.map((f) => f.name),
      ["notes/img.bin", "notes/today.md"],
    );
    const all = await run({ action: "list" });
    assert.ok(!all.files.some((f) => f.name === "openclaw-storage.json"));
    assert.equal((await run({ action: "read", name: "notes/today.md" })).content, "hello");
    await run({ action: "read", name: "notes/img.bin", to: "out/img.bin" });
    assert.deepEqual([...fs.readFileSync(path.join(ws, "out/img.bin"))], [1, 2, 3]);
    await assert.rejects(run({ action: "save", name: "x", path: "../etc/passwd" }), /inside the workspace/);
    await assert.rejects(run({ action: "save", name: "../x", content: "1" }), /segments/);
    await assert.rejects(run({ action: "save", name: "openclaw-storage.json", content: "1" }), /reserved/);
    assert.equal((await run({ action: "delete", name: "notes/today.md" })).ok, true);
    assert.equal((await run({ action: "read", name: "notes/today.md" })).error, "not found");
    assert.throws(() => locationOf({}), /ochost config render/);
  });
});

describe("ocsup side: files forwarder and location marker", () => {
  it("the forwarder on a second port relays S3 to the target; the plugin signs for its host", async () => {
    assert.equal(FILES_PROXY_PORT, 18792);
    const m = mockS3();
    const port = await listen(m.srv);
    const p = startCapProxy({ target: { host: "127.0.0.1", port }, port: 0 });
    await new Promise((r) => p.server.once("listening", r));
    const b = createBackend(
      { endpoint: `http://127.0.0.1:${p.server.address().port}`, bucket: BUCKET, prefix: PREFIX },
      { readKey: () => KEY },
    );
    await b.putObject("via-proxy", once("p"), {});
    assert.equal(m.objs.get("f/ab12cd/via-proxy").toString(), "p");
    assert.equal(p.state.accepted >= 1, true);
    p.close();
    m.srv.close();
  });

  it("ensureFilesMarker: creates the 'none' marker once, create-only; present after; another status is an error", async () => {
    const puts = [];
    let have = false;
    const o = {
      head: async () => (have ? 200 : 404),
      put: async (_s3, key, body, opt) => {
        puts.push({ key, body: JSON.parse(body), opt });
        have = true;
        return 200;
      },
      now: () => 42,
    };
    assert.equal(await ensureFilesMarker({}, "ab12cd", o), "created");
    assert.equal(puts[0].key, "f/ab12cd/openclaw-storage.json");
    assert.deepEqual(puts[0].opt, { createOnly: true });
    assert.equal(puts[0].body.version, 1);
    assert.equal(puts[0].body.encryption, "none");
    assert.equal(puts[0].body.createdAt, 42);
    assert.match(puts[0].body.locationId, /^[0-9a-f-]{36}$/);
    assert.equal(await ensureFilesMarker({}, "ab12cd", o), "present");
    assert.equal(puts.length, 1);
    assert.equal(await ensureFilesMarker({}, "ab12cd", { ...o, head: async () => 403 }), "error 403");
    assert.equal(
      await ensureFilesMarker({}, "ab12cd", { head: async () => 404, put: async () => 412 }),
      "raced",
    );
  });
});

describe("file names with spaces, Unicode, + # % (1.2.5)", () => {
  let m;
  let settings;
  before(async () => {
    m = mockS3();
    const port = await listen(m.srv);
    settings = { endpoint: `http://127.0.0.1:${port}`, bucket: BUCKET, prefix: PREFIX };
  });
  after(() => m.srv.close());

  it("save, read, list and update keep the exact name; every request is signed right (RFC 3986 per segment)", async () => {
    const cfg = {
      storage: { locations: { r2: { provider: "ochost-r2", settings, encryption: "none" } } },
      plugins: { entries: { "ochost-storage": { config: { location: "r2" } } } },
    };
    const backend = createBackend(settings, { readKey: () => KEY });
    const run = (a) => runFileStore(a, { cfg, backend });
    const names = [
      "my notes/plan 2026.md",
      "naïve café/résumé.txt",
      "a+b/c+d.md",
      "hash/#1 item.md",
      "pct/100% done.md",
      "mix/ü ö+#%(x)!'*.md",
      "日本語/メモ.md",
    ];
    for (const n of names) {
      const s = await run({ action: "save", name: n, content: `body of ${n}` });
      assert.equal(s.ok, true, n);
      assert.ok(m.objs.has(`${PREFIX}/${n}`), n);
      const r = await run({ action: "read", name: n });
      assert.equal(r.content, `body of ${n}`, n);
      const u = await run({ action: "update", name: n, content: "v2", etag: r.etag });
      assert.equal(u.ok, true, n);
    }
    const all = (await run({ action: "list" })).files.map((f) => f.name).sort();
    assert.deepEqual(all, [...names].sort());
    assert.deepEqual(
      (await run({ action: "list", prefix: "my notes/" })).files.map((f) => f.name),
      ["my notes/plan 2026.md"],
    );
    assert.ok(
      m.log.every((x) => x.sig),
      "every request verified",
    );
    for (const bad of ["a//b.md", "a/./b.md", "a\\b.md", "a/\u0001.md", "x/../y"])
      await assert.rejects(run({ action: "save", name: bad, content: "1" }), /segments/, bad);
  });
});
