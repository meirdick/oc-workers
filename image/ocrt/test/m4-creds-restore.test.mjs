// M4 loss drill finding: boot-time creds restore from the CredStore (plan §6.2 step 8). Real ocio creds-io
// (asRoot = the test uid) on a temp $STATE; the gate is a fake store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { restoreCreds } from "../lib/creds-restore.mjs";
import { runOcio } from "../lib/ocio-run.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const ocio = (n, a, o) => runOcio(n, a, { ...o, asRoot: true, timeoutMs: 20_000 });
const CD = "credentials/whatsapp/default";

function world() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ocsup-creds-"));
  const store = new Map(); // path -> {bytes, deleted}
  const put = (p, s) => store.set(p, { bytes: s, deleted: false });
  const gets = [];
  const gate = {
    call: async (_m, route) => {
      const p = decodeURIComponent(route.slice("/v1/creds/".length));
      gets.push(p);
      const r = store.get(p);
      if (!r || r.deleted) throw new Error("404");
      return {
        path: p,
        seq: 1,
        sha256: sha(r.bytes),
        mode: 0o600,
        b64: Buffer.from(r.bytes).toString("base64"),
      };
    },
  };
  const man = () => ({
    seq: store.size,
    files: [...store].map(([p, r]) => ({
      path: p,
      seq: 1,
      sha256: sha(r.bytes),
      mode: 0o600,
      deleted: r.deleted,
    })),
  });
  const local = (rel, s) => {
    fs.mkdirSync(path.dirname(path.join(state, rel)), { recursive: true });
    fs.writeFileSync(path.join(state, rel), s);
  };
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(state, rel), "utf8");
    } catch {
      return null;
    }
  };
  return { state, store, put, gate, man, local, read, gets };
}

test("creds restore: older rootfs → store bytes win, missing files written, tombstones removed", async () => {
  const w = world();
  w.put(`${CD}/creds.json`, '{"identity":"A","k":9}');
  w.put(`${CD}/pre-key-9.json`, '{"k":9}');
  w.store.set(`${CD}/pre-key-1.json`, { bytes: '{"k":1}', deleted: true });
  // rootfs from an older snapshot: older creds.json, pre-key-1 not yet deleted, pre-key-9 missing, one unknown
  w.local(`${CD}/creds.json`, '{"identity":"A","k":1}');
  w.local(`${CD}/pre-key-1.json`, '{"k":1}');
  w.local(`${CD}/local-only.json`, '{"x":1}');
  const r = await restoreCreds({ man: w.man(), state: w.state, gate: w.gate, ocio });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.put, 2);
  assert.equal(r.del, 1);
  assert.equal(w.read(`${CD}/creds.json`), '{"identity":"A","k":9}');
  assert.equal(w.read(`${CD}/pre-key-9.json`), '{"k":9}');
  assert.equal(w.read(`${CD}/pre-key-1.json`), null);
  assert.equal(w.read(`${CD}/local-only.json`), '{"x":1}', "a path the store does not know stays");
  const st = fs.statSync(path.join(w.state, `${CD}/creds.json`));
  assert.equal(st.mode & 0o777, 0o600);
});

test("creds restore: image rootfs with no credentials dir → every live path written", async () => {
  const w = world();
  w.put(`${CD}/creds.json`, '{"identity":"B"}');
  w.put("credentials/telegram/x.json", "{}");
  const r = await restoreCreds({ man: w.man(), state: w.state, gate: w.gate, ocio });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.put, 2);
  assert.equal(w.read(`${CD}/creds.json`), '{"identity":"B"}');
  assert.equal(fs.statSync(path.join(w.state, CD)).mode & 0o777, 0o700);
});

test("creds restore: disk equal to the store → no GET, no write (marker wake path)", async () => {
  const w = world();
  w.put(`${CD}/creds.json`, '{"identity":"C"}');
  w.local(`${CD}/creds.json`, '{"identity":"C"}');
  const r = await restoreCreds({ man: w.man(), state: w.state, gate: w.gate, ocio });
  assert.deepEqual([r.ok, r.put, r.del, w.gets.length], [true, 0, 0, 0]);
});

test("creds restore: a gate error blocks the boot (ok:false), the disk is untouched", async () => {
  const w = world();
  w.put(`${CD}/creds.json`, '{"identity":"D"}');
  w.local(`${CD}/creds.json`, "old");
  const gate = { call: async () => Promise.reject(new Error("gate 503")) };
  const r = await restoreCreds({ man: w.man(), state: w.state, gate, ocio });
  assert.equal(r.ok, false);
  assert.match(r.why, /gate 503/);
  assert.equal(w.read(`${CD}/creds.json`), "old");
});

test("creds-io apply refuses a path outside credentials/ and bytes that do not match sha256", async () => {
  const w = world();
  const r = await ocio("creds-io", ["apply", JSON.stringify({ state: w.state })], {
    stdin: JSON.stringify({
      put: [
        { rel: "workspace/x.md", b64: Buffer.from("x").toString("base64"), sha256: sha("x"), mode: 384 },
        { rel: `${CD}/a.json`, b64: Buffer.from("x").toString("base64"), sha256: sha("y"), mode: 384 },
      ],
      del: ["state/openclaw.sqlite"],
    }),
  });
  assert.deepEqual(
    r.json.bad.map((b) => b.why),
    ["scope", "sha256"],
  );
  assert.deepEqual([r.json.written, r.json.deleted], [[], []]);
});
