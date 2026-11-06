// M5 agent env gap: `openclaw` in the agent's exec printed "missing env var OC_*" (oc-demo, docs/09). Children of
// the gateway now get each SecretRef name back as a placeholder; the real values still never reach a child.
// ocsup's own CLI calls get the gateway's SecretRef env and the scrub preload.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cliNodeArgs, gatewayEnv, UNPRELOAD } from "../lib/gateway.mjs";

process.env.OCHOST_UNPRELOAD_TEST = "1";
const { scrubEnv, secretsOf, PLACEHOLDER, REFS_VAR } = await import("../unpreload.mjs");
delete process.env.OCHOST_UNPRELOAD_TEST;

const PRELOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "unpreload.mjs");
const AI = "cfut-ai-token-0123456789abcdef";
const BOT = "123456:bot-token-abcdefghijklmnop";
const PW = "gw-password-0123456789abcdef0123";

test("M5 gatewayEnv: OCHOST_REFS lists every OC_* name and the non-OC_ refs", () => {
  const e = gatewayEnv(
    { OC_CF_AI_TOKEN: AI, OC_TELEGRAM_BOT_TOKEN: BOT, OC_GATEWAY_TOKEN: PW, TG_X: BOT },
    { refs: ["OC_CF_AI_TOKEN", "TG_X", "MISSING"], localPassword: true, caExists: () => false },
  );
  assert.equal(e[REFS_VAR], "OC_CF_AI_TOKEN,OC_GATEWAY_TOKEN,OC_TELEGRAM_BOT_TOKEN,TG_X");
  assert.equal(e.OCHOST_SCRUB, "TG_X");
});

test("M5 scrubEnv: SecretRef names come back as the placeholder, values never; the list carries on", () => {
  const env = {
    PATH: "/usr/bin",
    OC_CF_AI_TOKEN: AI,
    OC_TELEGRAM_BOT_TOKEN: BOT,
    OPENCLAW_GATEWAY_PASSWORD: PW,
    TG_X: BOT,
    OCHOST_SCRUB: "TG_X",
    OCHOST_REFS: "OC_CF_AI_TOKEN,OC_TELEGRAM_BOT_TOKEN,TG_X,bad name",
    PLAIN: "keep",
  };
  const out = scrubEnv(env, secretsOf(env), null, null);
  assert.equal(out.OC_CF_AI_TOKEN, PLACEHOLDER);
  assert.equal(out.OC_TELEGRAM_BOT_TOKEN, PLACEHOLDER);
  assert.equal(out.TG_X, PLACEHOLDER);
  assert.equal(out.OPENCLAW_GATEWAY_PASSWORD, undefined, "the gateway password is not a SecretRef");
  assert.equal(out.PLAIN, "keep");
  assert.equal(out[REFS_VAR], "OC_CF_AI_TOKEN,OC_TELEGRAM_BOT_TOKEN,TG_X");
  for (const v of Object.values(out)) for (const s of [AI, BOT, PW]) assert.ok(!v.includes(s));
  // A grandchild: the placeholder is not a secret value (no value scrub of other vars that contain it).
  const sec2 = secretsOf({ ...out, NOTE: `x ${PLACEHOLDER} y` });
  assert.equal(sec2.values.length, 0);
  const again = scrubEnv({ ...out, NOTE: `x ${PLACEHOLDER} y` }, sec2, null, null);
  assert.equal(again.NOTE, `x ${PLACEHOLDER} y`);
  assert.equal(again.OC_CF_AI_TOKEN, PLACEHOLDER);
  // A non-secret name in OCHOST_REFS keeps its own value.
  const plain = { PATH: "/x", HOME_DIR: "/home/node", OCHOST_REFS: "HOME_DIR" };
  assert.equal(scrubEnv(plain, secretsOf(plain), null, null).HOME_DIR, "/home/node");
});

test("M5 preload: a child of the gateway sees OC_* as placeholders (agent exec), the gateway keeps values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocsup-m5env-"));
  const child = path.join(dir, "child.mjs");
  fs.writeFileSync(child, "process.stdout.write(JSON.stringify(process.env));\n");
  const parent = path.join(dir, "gw.mjs");
  fs.writeFileSync(
    parent,
    `import { execFileSync } from "node:child_process";
const c = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(child)}], { encoding: "utf8" }));
process.stdout.write(JSON.stringify({ gw: process.env.OC_CF_AI_TOKEN, child: c }));
`,
  );
  const env = gatewayEnv(
    { OC_CF_AI_TOKEN: AI, OC_TELEGRAM_BOT_TOKEN: BOT, OC_GATEWAY_TOKEN: PW },
    { refs: ["OC_CF_AI_TOKEN", "OC_TELEGRAM_BOT_TOKEN"], localPassword: true, caExists: () => false },
  );
  const out = JSON.parse(
    execFileSync(process.execPath, ["--import", PRELOAD, parent], {
      env: { ...env, PATH: process.env.PATH },
      encoding: "utf8",
    }),
  );
  assert.equal(out.gw, AI);
  assert.equal(out.child.OC_CF_AI_TOKEN, PLACEHOLDER);
  assert.equal(out.child.OC_TELEGRAM_BOT_TOKEN, PLACEHOLDER);
  assert.equal(out.child.OC_GATEWAY_TOKEN, PLACEHOLDER);
  const s = JSON.stringify(out.child);
  for (const x of [AI, BOT, PW]) assert.ok(!s.includes(x), "child leaks a secret");
});

test("M5 cliNodeArgs: ocsup CLI children load the scrub preload once", () => {
  assert.deepEqual(cliNodeArgs(["/app/openclaw.mjs", "cron", "list"]), [
    "--import",
    UNPRELOAD,
    "/app/openclaw.mjs",
    "cron",
    "list",
  ]);
  assert.deepEqual(cliNodeArgs(["-e", "1"], null), ["-e", "1"]);
  const once = cliNodeArgs(["x.mjs"]);
  assert.deepEqual(cliNodeArgs(once), once);
});
