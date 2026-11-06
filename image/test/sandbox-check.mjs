#!/usr/bin/env node
// Docker check for the sandbox backend (docs/12 §8). The gateway runs the OpenClaw base image with the config
// ocsup renders for plan.sandbox=true and the bundled plugin at its image path. A fake SandboxGate at 15.0.0.4
// runs in the sandbox image (image/sandbox) and stands in for the SandboxSession container. In real
// agent turns driven by a scripted model (fakes/script-llm.mjs) the check runs exec, write and read, then asserts:
//   1. every command reached the gate (gate log), and ran there (hostname = the gate container);
//   2. files the tools wrote exist in the gate container and not in the gateway container;
//   3. with the gate refusing (403 off, 429 budget) exec fails and nothing runs in the gateway (fail closed).
// Usage: node image/test/sandbox-check.mjs [--keep]. Needs Docker. Network ocsbx, 15.0.0.0/24.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, SANDBOX_PLUGIN_DIR } from "../ocrt/lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.resolve(HERE, "..");
const BASE =
  process.env.OCSBX_BASE ??
  "ghcr.io/openclaw/openclaw@sha256:1a2a3ce113e435039dbeac5ae261759bb4759908563d91c81059e896b38c5d98";
const SBX_IMAGE = "oc-sbx:test";
const NET = "ocsbx";
const TOKEN = "ocsbx-test-token";
const GW_IP = "15.0.0.10";
const LLM_IP = "15.0.0.21";
const keep = process.argv.includes("--keep");

const sh = (args, o = {}) => execFileSync("docker", args, { encoding: "utf8", ...o }).trim();
const quiet = (args, timeout = 60_000) => {
  try {
    return sh(args, { stdio: ["ignore", "pipe", "ignore"], timeout });
  } catch {
    return null;
  }
};
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const down = () => {
  for (const c of ["ocsbx-gw", "ocsbx-gate", "ocsbx-llm"]) quiet(["rm", "-f", c]);
  quiet(["network", "rm", NET]);
};

/** The openclaw.json ocsup renders with plan.sandbox, plus test-only token auth and a scripted model at 15.0.0.21. */
export function testConfig() {
  const plan = {
    mode: "prod",
    sandbox: true,
    managed: [
      { path: "gateway.auth.mode", value: "token" },
      { path: "gateway.auth.trustedProxy", value: undefined },
      { path: "gateway.trustedProxies", value: undefined },
    ],
  };
  const doc = {
    tools: { profile: "coding" },
    agents: { defaults: { model: { primary: "script/script" } } },
    models: {
      providers: {
        script: {
          baseUrl: `http://${LLM_IP}/v1`,
          api: "openai-completions",
          apiKey: "x",
          models: [{ id: "script", name: "script", input: ["text"], contextWindow: 65536, maxTokens: 4096 }],
        },
      },
    },
  };
  return render({ ver: 1, doc }, plan);
}

/**
 * One agent turn: the scripted model calls `steps` in order, then replies `FINAL <tool results>`.
 * /tools/invoke cannot be used: its HTTP surface never builds the coding tools (read, write, exec).
 */
let turn = 0;
function agent(steps) {
  const s = Buffer.from(JSON.stringify(steps)).toString("base64");
  const out =
    quiet(
      [
        "exec",
        "ocsbx-gw",
        "node",
        "openclaw.mjs",
        "agent",
        "--session-key",
        `agent:main:sbx${++turn}`,
        "--message",
        `SCRIPT:${s}`,
        "--json",
      ],
      180_000,
    ) ?? "";
  const i = out.indexOf("{");
  try {
    const j = JSON.parse(out.slice(i));
    const find = (o, k) =>
      o && typeof o === "object"
        ? k in o
          ? o[k]
          : Object.values(o)
              .map((v) => find(v, k))
              .find((v) => v !== undefined)
        : undefined;
    return {
      ok: true,
      reply: String(find(j, "terminalReply")?.text ?? ""),
      tools: find(j, "toolSummary") ?? null,
    };
  } catch {
    return { ok: false, reply: "", tools: null, raw: out.slice(-600) };
  }
}
const gateLog = (dir) => {
  try {
    return fs
      .readFileSync(path.join(dir, "sbx.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

async function main() {
  down();
  if (quiet(["network", "inspect", "ocm1"]))
    throw new Error("network ocm1 uses 15.0.0.0/24; run image/test/run.mjs --down");
  sh(["build", "-q", "-t", SBX_IMAGE, path.join(IMAGE_DIR, "sandbox")]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocsbx-"));
  const log = path.join(tmp, "log");
  const state = path.join(tmp, "state");
  fs.mkdirSync(log);
  fs.mkdirSync(path.join(state, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(state, "workspace", "SEED.md"), "seeded from the gateway workspace\n");
  const cfg = testConfig();
  fs.writeFileSync(path.join(state, "openclaw.json"), cfg.text);
  fs.chmodSync(tmp, 0o777);
  for (const d of [log, state, path.join(state, "workspace")]) fs.chmodSync(d, 0o777);
  fs.chmodSync(path.join(state, "openclaw.json"), 0o666);

  sh(["network", "create", "--subnet", "15.0.0.0/24", NET]);
  sh([
    "run",
    "-d",
    "--name",
    "ocsbx-gate",
    "--hostname",
    "ocsbx-sandbox",
    "--network",
    NET,
    "--ip",
    "15.0.0.4",
    "-v",
    `${path.join(HERE, "fakes")}:/f:ro`,
    "-v",
    `${log}:/log`,
    SBX_IMAGE,
    "node",
    "/f/sbx-gate.mjs",
  ]);
  sh([
    "run",
    "-d",
    "--name",
    "ocsbx-llm",
    "--network",
    NET,
    "--ip",
    LLM_IP,
    "-v",
    `${path.join(HERE, "fakes")}:/f:ro`,
    SBX_IMAGE,
    "node",
    "/f/script-llm.mjs",
  ]);
  sh([
    "run",
    "-d",
    "--name",
    "ocsbx-gw",
    "--hostname",
    "ocsbx-gateway",
    "--network",
    NET,
    "--ip",
    GW_IP,
    "-e",
    `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
    "-e",
    "OPENCLAW_NO_AUTO_UPDATE=1",
    "-v",
    `${state}:/home/node/.openclaw`,
    "-v",
    `${path.join(IMAGE_DIR, "ocrt", "plugins", "ochost-sandbox")}:${SANDBOX_PLUGIN_DIR}:ro`,
    BASE,
    "node",
    "openclaw.mjs",
    "gateway",
    "--allow-unconfigured",
    "--bind",
    "lan",
    "--port",
    "18789",
    "--auth",
    "token",
  ]);

  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 180_000) {
    try {
      const r = await fetch(`http://${GW_IP}:18789/startupz`, { signal: AbortSignal.timeout(3000) });
      if (r.ok && (await r.json()).status === "started") {
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  check("gateway /startupz", up, { s: Math.round((Date.now() - t0) / 1000) });
  if (!up) throw new Error(sh(["logs", "--tail", "60", "ocsbx-gw"], { stdio: ["ignore", "pipe", "pipe"] }));
  const plugins = quiet(["exec", "ocsbx-gw", "node", "openclaw.mjs", "plugins", "list", "--enabled"]) ?? "";
  check("plugin ochost-sandbox loaded", plugins.includes("ochost-sandbox"));

  const marker = `sbx-${Date.now()}`;
  const t1 = agent([
    { name: "exec", args: { command: `hostname; pwd; echo ${marker} > made-by-exec.txt; cat SEED.md` } },
    { name: "write", args: { path: "made-by-write.txt", content: `${marker}\n` } },
    { name: "read", args: { path: "made-by-exec.txt" } },
  ]);
  check(
    "agent turn ran 3 tools",
    t1.ok && t1.tools?.calls === 3 && t1.tools?.failures === 0,
    t1.tools ?? t1.raw,
  );
  check(
    "exec ran in the sandbox (hostname)",
    t1.reply.includes("ocsbx-sandbox") && !t1.reply.includes("ocsbx-gateway"),
    t1.reply.slice(0, 300),
  );
  check(
    "exec cwd under /workspace",
    /\/workspace\/[^\s"\\]+\/workspace/.test(t1.reply),
    t1.reply.slice(0, 300),
  );
  check("gateway workspace seeded into the sandbox", t1.reply.includes("seeded from the gateway workspace"));
  check("read sees the exec file", t1.reply.split(marker).length >= 2, t1.reply.slice(0, 400));

  const remote = quiet(["exec", "ocsbx-gate", "sh", "-c", "ls /workspace/*/workspace/"]) ?? "";
  check(
    "files exist in the sandbox container",
    remote.includes("made-by-exec.txt") && remote.includes("made-by-write.txt"),
    remote,
  );
  const local =
    quiet(["exec", "ocsbx-gw", "sh", "-c", "find / -xdev -name 'made-by-*' 2>/dev/null | head -5"]) ?? "";
  check("no tool output file in the gateway container", local === "", local);
  const log1 = gateLog(log);
  check(
    "exec went through the gate",
    log1.some((r) => `${r.cmd}${r.stdin}`.includes(marker)),
    { execs: log1.length },
  );
  check(
    "file tools went through the gate",
    log1.some((r) => r.cmd.includes("made-by-write.txt") || r.cmd.includes("openclaw-sandbox-fs")),
    { execs: log1.length },
  );

  for (const m of ["403", "429"]) {
    fs.writeFileSync(path.join(log, "sbx-mode"), m);
    const before = gateLog(log).length;
    const proof = `local-${m}-${Date.now()}`;
    const r = agent([
      { name: "exec", args: { command: `echo ${proof} > /tmp/${proof}; echo ran-${proof}` } },
    ]);
    const here = quiet(["exec", "ocsbx-gw", "sh", "-c", `ls /tmp/${proof} 2>/dev/null`]) ?? "";
    check(`gate ${m}: exec fails closed`, !r.reply.includes(`ran-${proof}`) && here === "", {
      reply: r.reply.slice(0, 300),
      tools: r.tools,
    });
    check(`gate ${m}: nothing ran in the sandbox`, gateLog(log).length === before);
  }
  fs.writeFileSync(path.join(log, "sbx-mode"), "ok");

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks ok`);
  if (!keep) down();
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(String(e?.stack ?? e).slice(0, 4000));
    if (!keep) down();
    process.exit(1);
  });
