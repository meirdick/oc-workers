import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Archiver } from "../lib/archive.mjs";
import { runOcio } from "../lib/ocio-run.mjs";
import { Shadow, shadowRoute } from "../lib/shadow.mjs";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "state-fx");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ocio =
  (env = {}) =>
  (n, a, o = {}) =>
    runOcio(n, a, { ...o, asRoot: true, env: { ...process.env, ...env } });
const mkdb = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("create table if not exists t(x)");
  for (let i = 0; i < rows; i++) db.exec(`insert into t values (${i})`);
  db.close();
};
const stat = (state, rel) => {
  const st = fs.statSync(path.join(state, rel));
  return { rel, mtimeMs: Math.round(st.mtimeMs), size: st.size };
};

describe("shadow", () => {
  it("copies a changed DB with the backup API, sends it with its sha256, skips unchanged", async () => {
    const state = tmp("sh-");
    const varDir = tmp("shv-");
    const rel = "plugins/team-reports/reports.sqlite";
    mkdb(path.join(state, rel), 100);
    const puts = [];
    const s = new Shadow({
      state,
      varDir,
      ocio: ocio(),
      putRaw: async (route, buf, h) => puts.push({ route, buf, h }),
    });
    const r1 = await s.round([stat(state, rel)]);
    assert.equal(r1[0].ok, true, JSON.stringify(r1));
    assert.equal(puts[0].route, shadowRoute(rel));
    assert.equal(puts[0].h["x-ocrt-sha256"], sha(puts[0].buf));
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const copy = path.join(tmp("shc-"), "c.sqlite");
    fs.writeFileSync(copy, puts[0].buf);
    assert.equal(new DatabaseSync(copy, { readOnly: true }).prepare("select count(*) n from t").get().n, 100);
    // M4b N2: the local copy is gone once the upload is done (it went into every snapshot).
    assert.deepEqual(fs.readdirSync(path.join(varDir, "shadow")), []);
    assert.equal((await s.round([stat(state, rel)])).length, 0);
    await new Promise((r) => setTimeout(r, 20));
    mkdb(path.join(state, rel), 1);
    const r3 = await s.round([stat(state, rel)]);
    assert.equal(r3.length, 1);
    assert.equal(puts.length, 2);
    console.log(`# shadow copy+upload ${r1[0].bytes} B in ${r1[0].ms} ms`);
  });
  it("a symlinked source is refused; an upload error keeps the file due", async () => {
    const state = tmp("sh-");
    const varDir = tmp("shv-");
    fs.mkdirSync(path.join(state, "x"));
    mkdb(path.join(state, "real.sqlite"), 1);
    fs.symlinkSync(path.join(state, "real.sqlite"), path.join(state, "x/l.sqlite"));
    const s = new Shadow({
      state,
      varDir,
      ocio: ocio(),
      putRaw: async () => {
        throw new Error("503");
      },
    });
    const r = await s.round([{ rel: "x/l.sqlite", mtimeMs: 1, size: 1 }, stat(state, "real.sqlite")]);
    assert.equal(r[0].ok, false);
    assert.equal(r[0].why, "symlink");
    assert.equal(r[1].ok, false);
    assert.match(r[1].why, /upload/);
    assert.equal(s.changed([stat(state, "real.sqlite")]).length, 1);
  });
  it("429 rate (gate: 1 per DB per 10 min) is skipped, not a failure; the file stays due", async () => {
    const state = tmp("sh-");
    const varDir = tmp("shv-");
    mkdb(path.join(state, "q.sqlite"), 1);
    const s = new Shadow({
      state,
      varDir,
      ocio: ocio(),
      putRaw: async () => {
        throw Object.assign(new Error('/v1/shadow/q.sqlite: 429 {"error":"rate"}'), { status: 429 });
      },
    });
    const r = await s.round([stat(state, "q.sqlite")]);
    assert.equal(r[0].ok, true);
    assert.equal(r[0].skipped, "rate");
    assert.equal(s.changed([stat(state, "q.sqlite")]).length, 1);
  });
});

function fakeGate({ failPart = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, route, body) {
      calls.push({ method, route, body });
      if (route === "/v1/archive/start") return { archiveId: "a1" };
      if (route.startsWith("/v1/archive/part") && failPart && route.endsWith(`n=${failPart}`))
        throw new Error("part 500");
      return { ok: true, etag: "e" };
    },
  };
}
const cli = ["node", path.join(FX, "fake-openclaw.mjs")];

describe("archive", () => {
  it("streams the archive in parts with a running sha256 and completes", async () => {
    const gate = fakeGate();
    const varDir = tmp("ar-");
    const a = new Archiver({
      gate,
      varDir,
      cli,
      partMax: 100_000,
      ocio: ocio({ FAKE_ARCHIVE_BYTES: "350000" }),
    });
    const r = await a.run("online", "6h");
    assert.equal(r.ok, true, JSON.stringify(r));
    const parts = gate.calls.filter((c) => c.route.startsWith("/v1/archive/part"));
    assert.deepEqual(
      parts.map((p) => p.body.length),
      [100_000, 100_000, 100_000, 50_000],
    );
    assert.equal(sha(Buffer.concat(parts.map((p) => p.body))), r.sha256);
    const done = gate.calls.at(-1);
    assert.equal(done.route, "/v1/archive/complete");
    assert.deepEqual(done.body, { archiveId: "a1", sha256: r.sha256, size: 350_000, parts: 4 });
    assert.deepEqual(fs.readdirSync(path.join(varDir, "bk-u")), []); // no copy left
    assert.equal(a.due(), false);
    assert.equal(a.due(Date.now() + 6 * 3_600_000), true);
  });
  it("M3 e2e: root prepares bk-u before ocio runs (uid 1000 cannot mkdir in the 0711 var dir)", async () => {
    const varDir = tmp("ar-");
    const seen = [];
    const a = new Archiver({
      gate: fakeGate(),
      varDir,
      cli,
      partMax: 100_000,
      prepOut: (d) => {
        seen.push(d);
        fs.mkdirSync(d, { recursive: true });
      },
      ocio: ocio({ FAKE_ARCHIVE_BYTES: "1000" }),
    });
    assert.equal((await a.run("online", "6h")).ok, true);
    assert.deepEqual(seen, [path.join(varDir, "bk-u")]);
    let ran = false;
    const b = new Archiver({
      gate: fakeGate(),
      varDir,
      cli,
      prepOut: () => {
        throw new Error("EACCES");
      },
      ocio: async () => {
        ran = true;
        return { code: 0, err: "" };
      },
    });
    const r = await b.run("online", "6h");
    assert.equal(r.ok, false);
    assert.match(r.why, /prep: EACCES/);
    assert.equal(ran, false);
  });
  it("failed part, failed CLI or two outputs → /v1/archive/abort, no complete", async () => {
    for (const [env, failPart, why] of [
      [{}, 2, /part/],
      [{ FAKE_ARCHIVE: "fail" }, 0, /exit 4/],
      [{ FAKE_ARCHIVE: "two" }, 0, /found 2/],
    ]) {
      const gate = fakeGate({ failPart });
      const a = new Archiver({
        gate,
        varDir: tmp("ar-"),
        cli,
        partMax: 100_000,
        ocio: ocio({ FAKE_ARCHIVE_BYTES: "350000", ...env }),
      });
      const r = await a.run("online", "pre-upgrade");
      assert.equal(r.ok, false);
      assert.match(r.why, why);
      assert.equal(gate.calls.at(-1).route, "/v1/archive/abort");
      assert.ok(!gate.calls.some((c) => c.route === "/v1/archive/complete"));
    }
  });
});

describe("L5: online archive reads a shadow tree, never the live DBs", () => {
  it("ocio shadow-tree: copies state minus workspace and managed DBs; other SQLite by backup API, with a writer open", async () => {
    const state = tmp("st-");
    const out = tmp("bks-");
    mkdb(path.join(state, "state/openclaw.sqlite"), 3);
    mkdb(path.join(state, "plugins/p/store.sqlite"), 0);
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const w = new DatabaseSync(path.join(state, "plugins/p/store.sqlite"));
    w.exec("pragma journal_mode=wal; insert into t values (41), (42)"); // committed in the WAL only
    fs.mkdirSync(path.join(state, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(state, "workspace/notes.md"), "x");
    fs.mkdirSync(path.join(state, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(state, "credentials/a.json"), "{}");
    fs.writeFileSync(path.join(state, "openclaw.json"), JSON.stringify({ agents: { defaults: {} } }));
    const r = await ocio()("shadow-tree", [
      JSON.stringify({ state, out, managed: ["state/openclaw.sqlite"] }),
    ]);
    w.close();
    assert.equal(r.json?.ok, true, r.err);
    assert.equal(fs.existsSync(path.join(out, "workspace")), false);
    assert.equal(fs.existsSync(path.join(out, "state/openclaw.sqlite")), false); // restored from the replica
    assert.equal(fs.statSync(path.join(out, "state")).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(out, "credentials/a.json"), "utf8"), "{}");
    assert.equal(fs.existsSync(path.join(out, "plugins/p/store.sqlite-wal")), false);
    const c = new DatabaseSync(path.join(out, "plugins/p/store.sqlite"), { readOnly: true });
    assert.equal(c.prepare("select count(*) n from t").get().n, 2);
    c.close();
    const cfg = JSON.parse(fs.readFileSync(path.join(out, "openclaw.json"), "utf8"));
    assert.equal(cfg.agents.defaults.workspace, path.join(state, "workspace"));
  });

  it("Archiver: shadow only after the DO opens an archive; CLI gets its state dir; failure aborts", async () => {
    const varDir = tmp("ar5-");
    const sh = tmp("sh5-");
    let built = 0;
    let cleaned = 0;
    const shadow = async () => {
      built++;
      return { ok: true, env: { OPENCLAW_STATE_DIR: sh } };
    };
    const fresh = {
      calls: [],
      async call(m, route) {
        this.calls.push(route);
        throw Object.assign(new Error('409 {"error":"fresh"}'), { status: 409 });
      },
    };
    const o = { varDir, cli, partMax: 100_000, ocio: ocio({ FAKE_ARCHIVE_BYTES: "1000" }) };
    const a0 = new Archiver({ ...o, gate: fresh, shadow });
    assert.equal((await a0.run("online", "6h")).skipped, "fresh");
    assert.equal(built, 0);
    const a = new Archiver({ ...o, gate: fakeGate(), shadow, shadowDone: async () => void cleaned++ });
    assert.equal((await a.run("online", "6h")).ok, true);
    assert.equal(built, 1);
    assert.equal(fs.existsSync(path.join(sh, ".seen")), true);
    assert.equal(cleaned, 1);
    const gate = fakeGate();
    const b = new Archiver({ ...o, gate, shadow: async () => ({ ok: false, why: "replica infra" }) });
    const r = await b.run("online", "6h");
    assert.equal(r.ok, false);
    assert.match(r.why, /shadow: replica infra/);
    assert.deepEqual(
      gate.calls.map((c) => c.route),
      ["/v1/archive/start", "/v1/archive/abort"],
    );
    // A drain during the shadow build: no CLI run, the shadow is cleaned, the archive is aborted.
    let ran = 0;
    let done = 0;
    const g2 = fakeGate();
    const c = new Archiver({
      ...o,
      gate: g2,
      ocio: async (name, ...rest) => {
        if (name === "archive-create") ran++;
        return o.ocio(name, ...rest);
      },
      shadow: async () => {
        c.abort();
        return { ok: true, env: { OPENCLAW_STATE_DIR: sh } };
      },
      shadowDone: async () => void done++,
    });
    const r2 = await c.run("online", "6h");
    assert.equal(r2.ok, false);
    assert.equal(r2.why, "draining");
    assert.equal(ran, 0);
    assert.equal(done, 1);
    assert.deepEqual(
      g2.calls.map((x) => x.route),
      ["/v1/archive/start", "/v1/archive/abort"],
    );
  });
});

describe("N5: a WAL DB with an open writer is shadowed again after each write", () => {
  it("scan reports -wal mtime/size; changed() picks the DB when only its -wal moved", async () => {
    const state = tmp("n5-");
    const rel = "plugins/p/store.sqlite";
    mkdb(path.join(state, rel), 1);
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const w = new DatabaseSync(path.join(state, rel));
    w.exec("pragma journal_mode=wal; pragma wal_autocheckpoint=0; insert into t values (1)");
    const scan = async () => (await ocio()("fsops", ["scan", JSON.stringify({ state })])).json.sqlite[0];
    const s = new Shadow({ state, varDir: tmp("n5v-"), putRaw: async () => {}, ocio: ocio() });
    const e1 = await scan();
    assert.ok(e1.walSize > 0);
    const r1 = await s.round([e1]);
    assert.equal(r1[0].ok, true);
    assert.equal(s.changed([await scan()]).length, 0);
    await new Promise((r) => setTimeout(r, 20));
    w.exec("insert into t values (2), (3)");
    const e2 = await scan();
    assert.equal(e2.size, e1.size); // main file untouched
    assert.equal(s.changed([e2]).length, 1);
    w.close();
  });
});
