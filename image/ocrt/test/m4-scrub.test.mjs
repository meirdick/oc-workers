// M4 M3-1: the gateway preload scrubs secrets from every child env and keeps nodump.so on children.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gatewayEnv } from "../lib/gateway.mjs";

process.env.OCHOST_UNPRELOAD_TEST = "1";
const { scrubEnv, secretsOf } = await import("../unpreload.mjs");
delete process.env.OCHOST_UNPRELOAD_TEST;

const PRELOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "unpreload.mjs");
const KEY = "sk-ant-test-0123456789abcdef";
const PW = "gw-password-0123456789abcdef0123";
const BOT = "123456:bot-token-abcdefghijklmnop";

test("M3-1 secretsOf/scrubEnv: OC_*, gateway token/password, listed refs and copies of their values go", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/node",
    OC_ANTHROPIC_KEY: KEY,
    OPENCLAW_GATEWAY_PASSWORD: PW,
    TELEGRAM_BOT_TOKEN: BOT,
    OCHOST_SCRUB: "TELEGRAM_BOT_TOKEN",
    ANTHROPIC_API_KEY: KEY,
    AUTH_HEADER: `Bearer ${KEY}`,
    LD_PRELOAD: "/usr/lib/x86_64-linux-gnu/libjemalloc.so.2",
    MALLOC_CONF: "background_thread:true",
    NODE_EXTRA_CA_CERTS: "/etc/ca.crt",
  };
  const sec = secretsOf(env);
  const out = scrubEnv(env, sec, "/opt/ocrt/nodump.so", "/opt/ocrt/unpreload.mjs");
  assert.deepEqual(Object.keys(out).sort(), [
    "HOME",
    "LD_PRELOAD",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "OCHOST_SCRUB",
    "OCHOST_SCRUB_H",
    "PATH",
  ]);
  assert.equal(out.LD_PRELOAD, "/opt/ocrt/nodump.so");
  assert.equal(out.NODE_OPTIONS, "--import=/opt/ocrt/unpreload.mjs");
  assert.equal(out.OCHOST_SCRUB, "TELEGRAM_BOT_TOKEN");
  for (const v of Object.values(out)) for (const x of [KEY, PW, BOT]) assert.ok(!v.includes(x));
  assert.equal(scrubEnv(env, sec, null).LD_PRELOAD, undefined);
  // A descendant with only the scrubbed env still drops a copy it gets later (IPC), by name or value hash.
  const sec2 = secretsOf(out);
  assert.equal(sec2.values.length, 0);
  const again = scrubEnv(
    { ...out, OC_X: "y".repeat(20), COPY: KEY, TELEGRAM_BOT_TOKEN: BOT, OK: "1" },
    sec2,
    null,
    null,
  );
  assert.equal(again.OK, "1");
  for (const k of ["OC_X", "COPY", "TELEGRAM_BOT_TOKEN"]) assert.equal(again[k], undefined, k);
});

test("M3-1 gatewayEnv lists non-OC_ refs in OCHOST_SCRUB", () => {
  const e = gatewayEnv(
    { OC_GATEWAY_TOKEN: PW, OC_ANTHROPIC_KEY: KEY, TG_TOKEN: BOT },
    { refs: ["TG_TOKEN", "OC_ANTHROPIC_KEY", "MISSING"], localPassword: true, caExists: () => false },
  );
  assert.equal(e.OCHOST_SCRUB, "TG_TOKEN");
  assert.equal(e.OPENCLAW_GATEWAY_PASSWORD, PW);
});

// A real node process with the preload spawns children every way Node allows; each child prints its env.
test("M3-1 preload: spawn, exec, execFile, fork, spawnSync, execSync, execFileSync, explicit env → no secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocsup-scrub-"));
  const child = path.join(dir, "child.mjs");
  fs.writeFileSync(child, "process.stdout.write(JSON.stringify(process.env));\n");
  const parent = path.join(dir, "parent.mjs");
  fs.writeFileSync(
    parent,
    `import cp from "node:child_process";
import { spawn, exec, execFile, fork, spawnSync, execSync, execFileSync } from "node:child_process";
const N = process.execPath, C = ${JSON.stringify(child)};
const got = {};
const collect = (name, p) => new Promise((r) => { let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => { got[name] = JSON.parse(o); r(); }); });
await collect("spawn", spawn(N, [C]));
await collect("spawnExplicit", spawn(N, [C], { env: { ...process.env, ANTHROPIC_API_KEY: process.env.OC_ANTHROPIC_KEY } }));
await collect("cpSpawn", cp.spawn(N, [C]));
await new Promise((r) => exec(N + " " + C, (e, o) => { got.exec = JSON.parse(o); r(); }));
await new Promise((r) => execFile(N, [C], (e, o) => { got.execFile = JSON.parse(o); r(); }));
await collect("fork", fork(C, [], { silent: true }));
got.spawnSync = JSON.parse(spawnSync(N, [C]).stdout);
got.spawnSyncEnv = JSON.parse(spawnSync(N, [C], { env: { ...process.env } }).stdout);
got.execSync = JSON.parse(execSync(N + " " + C));
got.execFileSync = JSON.parse(execFileSync(N, [C]));
got.cpExecFileSync = JSON.parse(cp.execFileSync(N, [C], { env: { X_COPY: process.env.OPENCLAW_GATEWAY_PASSWORD, KEEP: "1" } }));
got.parentHasKey = process.env.OC_ANTHROPIC_KEY === ${JSON.stringify(KEY)};
process.stdout.write(JSON.stringify(got));
`,
  );
  const out = execFileSync(process.execPath, ["--import", PRELOAD, parent], {
    env: {
      PATH: process.env.PATH,
      OC_ANTHROPIC_KEY: KEY,
      OPENCLAW_GATEWAY_PASSWORD: PW,
      TG_TOKEN: BOT,
      OCHOST_SCRUB: "TG_TOKEN",
      LD_PRELOAD: "",
      KEEP_ME: "yes",
    },
    encoding: "utf8",
  });
  const got = JSON.parse(out);
  assert.equal(got.parentHasKey, true, "SecretRefs still resolve in the gateway process");
  const ways = Object.keys(got).filter((k) => k !== "parentHasKey");
  assert.equal(ways.length, 11);
  for (const w of ways) {
    const s = JSON.stringify(got[w]);
    for (const secret of [KEY, PW, BOT]) assert.ok(!s.includes(secret), `${w} leaks a secret`);
    assert.ok(/--import=\S*unpreload\.mjs/.test(got[w].NODE_OPTIONS ?? ""), `${w} lacks the hook`);
  }
  assert.equal(got.spawn.KEEP_ME, "yes");
  assert.equal(got.cpExecFileSync.KEEP, "1");
});

// M4 live: the spawn broker (a gateway child) gets the gateway env over IPC and spawns `pnpm root -g` with it.
test("M3-1 broker shape: child gets the full env over stdin and spawns with it → grandchild has no secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocsup-scrub-ipc-"));
  const gc = path.join(dir, "gc.mjs");
  fs.writeFileSync(gc, "process.stdout.write(JSON.stringify(process.env));\n");
  const broker = path.join(dir, "broker.mjs");
  fs.writeFileSync(
    broker,
    `import { spawnSync } from "node:child_process";
let b = ""; for await (const d of process.stdin) b += d;
const env = JSON.parse(b);
process.stdout.write(spawnSync(process.execPath, [${JSON.stringify(gc)}], { env }).stdout);
`,
  );
  const parent = path.join(dir, "gw.mjs");
  fs.writeFileSync(
    parent,
    `import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [${JSON.stringify(broker)}], { input: JSON.stringify({ ...process.env, ANTHROPIC_API_KEY: process.env.OC_ANTHROPIC_KEY }) });
process.stdout.write(r.stdout);
`,
  );
  const out = execFileSync(process.execPath, ["--import", PRELOAD, parent], {
    env: {
      PATH: process.env.PATH,
      OC_ANTHROPIC_KEY: KEY,
      OPENCLAW_GATEWAY_PASSWORD: PW,
      TG_TOKEN: BOT,
      OCHOST_SCRUB: "TG_TOKEN",
    },
    encoding: "utf8",
  });
  const env = JSON.parse(out);
  const s = JSON.stringify(env);
  for (const secret of [KEY, PW, BOT]) assert.ok(!s.includes(secret), "grandchild leaks a secret");
  assert.equal(env.PATH, process.env.PATH);
});

test("M4b B1 selfRespawn: only an ocsup CLI run (KEEP) re-executing node on its own entry keeps the env", async () => {
  const { selfRespawn } = await import("../unpreload.mjs");
  const node = "/usr/local/bin/node";
  const entry = "/app/openclaw.mjs";
  const opt = {
    file: node,
    args: [node, "--disable-warning=X", "--import", "/opt/ocrt/unpreload.mjs", entry, "gateway"],
  };
  assert.equal(selfRespawn({ OCHOST_CLI_KEEP: "1" }, opt, node, entry), true);
  assert.equal(selfRespawn({}, opt, node, entry), false, "gateway env has no marker");
  assert.equal(selfRespawn({ OCHOST_CLI_KEEP: "1" }, { ...opt, file: "/usr/bin/npm" }, node, entry), false);
  assert.equal(
    selfRespawn({ OCHOST_CLI_KEEP: "1" }, { file: node, args: [node, "/tmp/other.mjs"] }, node, entry),
    false,
  );
});
