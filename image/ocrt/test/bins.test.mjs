// F-SEC-1 regression (security review): root never resolves a binary through PATH, and root's PATH has
// no uid-1000-writable dir. Static scan of every root spawn site plus a dynamic check of the spawn
// wrappers with plants first on PATH. The Docker test `path-plants` proves it in the image.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BIN, hardenPath, SAFE_PATH } from "../lib/bins.mjs";
import { buildCommand } from "../lib/gateway.mjs";
import { wrapArgv } from "../lib/ocio-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = [
  "ocsup.mjs",
  "ocsupctl.mjs",
  "unpreload.mjs",
  "dumpable-check.mjs",
  ...fs.readdirSync(path.join(ROOT, "lib")).map((f) => `lib/${f}`),
  ...fs.readdirSync(path.join(ROOT, "ocio")).map((f) => `ocio/${f}`),
].filter((f) => f.endsWith(".mjs"));

describe("F-SEC-1 absolute binaries", () => {
  it("BIN paths are absolute and SAFE_PATH has only root dirs", () => {
    for (const [k, v] of Object.entries(BIN)) assert.ok(path.isAbsolute(v), `${k}: ${v}`);
    assert.equal(SAFE_PATH, "/usr/sbin:/usr/bin:/sbin:/bin");
    const env = hardenPath({ PATH: "/home/node/.local/bin:/usr/bin" });
    assert.equal(env.PATH, SAFE_PATH);
  });

  it("no spawn site in ocrt passes a bare command name", () => {
    const bad = [];
    // child_process calls (not this.#spawn or db.exec), argv tuples and `cmd:` options.
    const re = /(?<![#.\w])(spawn|spawnSync|execFile|execFileSync)\(\s*(["'`])([^"'`]*)\2/g;
    const NAMES = "sh|setpriv|env|node|tini|litestream|nft|sync|mount|hostname|fallocate";
    for (const f of SRC) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const m of text.matchAll(re)) if (!m[3].startsWith("/")) bad.push(`${f}: ${m[0]}`);
      for (const m of text.matchAll(new RegExp(`\\b(cmd|bin): "(${NAMES})"`, "g"))) bad.push(`${f}: ${m[0]}`);
      for (const m of text.matchAll(new RegExp(`(return|argv =) \\[\\s*"(${NAMES})"`, "g")))
        bad.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(bad, []);
  });

  it("spawn wrappers start /bin/sh and exec absolute paths only", () => {
    const w = wrapArgv("/usr/local/bin/litestream", ["replicate"], { cg: "/x", oom: -800 });
    assert.equal(w[0], "/bin/sh");
    const after = w[1].slice(3); // [-c, script, "sh", ...exec argv]
    assert.equal(after[0], BIN.setpriv);
    assert.ok(after.includes("/usr/local/bin/litestream"));
    const g = buildCommand({ cmd: BIN.node, args: ["/app/openclaw.mjs"], exists: () => true });
    assert.equal(g[0], "/bin/sh");
    const ga = g[1].slice(3);
    assert.equal(ga[0], BIN.setpriv);
    assert.ok(ga.includes(BIN.env));
    const r = buildCommand({ cmd: BIN.node, args: [], uid1000: false, exists: () => true });
    assert.equal(r[1].slice(3)[0], BIN.env);
  });

  it("with plants first on PATH, the wrappers never run a plant (control: a bare name does)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocrt-plants-"));
    const log = path.join(dir, "hits");
    fs.writeFileSync(log, "");
    for (const n of ["sh", "setpriv", "env", "node", "true"]) {
      fs.writeFileSync(path.join(dir, n), `#!/bin/sh\necho ${n} >> ${log}\nexit 0\n`, { mode: 0o755 });
    }
    const env = { PATH: `${dir}:${SAFE_PATH}` };
    const saved = process.env.PATH;
    process.env.PATH = env.PATH; // Node resolves the file with the PARENT's PATH (review probe)
    try {
      const [c, a] = wrapArgv("/bin/true", [], { asRoot: true });
      assert.equal(spawnSync(c, a, { env }).status, 0);
      const [c2, a2] = buildCommand({ cmd: "/bin/true", uid1000: false, jemalloc: false, nodump: false });
      assert.equal(spawnSync(c2, a2, { env }).status, 0);
      assert.equal(fs.readFileSync(log, "utf8"), "");
      spawnSync("sh", ["-c", "exit 0"], { env }); // control: a bare name resolves to the plant
      assert.equal(fs.readFileSync(log, "utf8"), "sh\n");
    } finally {
      process.env.PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Dockerfile: absolute ENTRYPOINT, image PATH without /home", () => {
    const df = fs.readFileSync(path.join(ROOT, "..", "Dockerfile"), "utf8");
    const ep = JSON.parse(/^ENTRYPOINT (\[.*\])$/m.exec(df)[1]);
    assert.equal(ep[0], "/usr/bin/tini");
    assert.equal(ep[3], "/usr/local/bin/node");
    const p = /^ENV PATH=(\S+)$/m.exec(df)?.[1];
    assert.ok(p && !/\/home/.test(p), p);
    assert.doesNotMatch(df, /oc-host\.openclaw\.version="2026/);
  });
});
