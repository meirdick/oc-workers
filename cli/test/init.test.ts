// init state machine with a fake wrangler runner and a fake fetch (spec 10 §2). No network, no Docker.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RENDER_VERSION, renderCapabilities } from "../src/config.ts";
import { failExit, type InitOptions, type InitProbes, initCommand, plan } from "../src/init.ts";
import { classifyDeployFailure, deployWithRetry, retryReason } from "../src/registry.ts";
import { planSecrets, sha256 } from "../src/secrets.ts";
import { type Ctx, EXIT, makeUi, parseArgs, redact, registerSecret } from "../src/ui.ts";
import type { RunOptions, RunResult, Wrangler } from "../src/wrangler.ts";

const ACCT = "a".repeat(32);

function opts(o: Partial<InitOptions> = {}): InitOptions {
  return {
    nonInteractive: true,
    name: "oc-m5-test",
    adopt: false,
    noOpen: true,
    skipAi: false,
    acceptLoss: false,
    ...o,
  };
}

function probes(p: Partial<InitProbes> = {}): InitProbes {
  return {
    nodeVersion: "26.13.0",
    docker: true,
    whoami: { loggedIn: true, accounts: [{ id: ACCT, name: "Test account" }] },
    accountId: ACCT,
    accountName: "Test account",
    bearer: true,
    paid: true,
    r2: true,
    subdomain: { kind: "has", subdomain: "sub" },
    worker: { exists: false },
    local: { state: false, controlToken: false },
    interactive: false,
    ...p,
  };
}

describe("plan()", () => {
  it("happy path: steps in order", () => {
    expect(plan(opts(), probes()).map((s) => s.kind)).toEqual([
      "account",
      "subdomain",
      "scaffold",
      "ai",
      "secrets",
      "r2",
      "deploy",
      "health",
      "aihop",
      "config",
      "start",
      "selftest",
      "login",
      "done",
    ]);
  });

  it("enforces the engines rule: Node 22.18 or later", () => {
    const fails = (v: string) =>
      plan(opts(), probes({ nodeVersion: v })).some(
        (s) => s.kind === "fail" && s.error.cause_ === "Node 22.18 or later is needed",
      );
    expect(fails("22.17.9")).toBe(true);
    expect(fails("21.9.0")).toBe(true);
    expect(fails("22.18.0")).toBe(false);
    expect(fails("23.0.0")).toBe(false);
    expect(fails("26.13.0")).toBe(false);
  });

  it("lists every failed precondition in one run; broken wins over manual", () => {
    const steps = plan(opts(), probes({ docker: false, nodeVersion: "20.1.0", paid: false }));
    const errs = steps.map((s) => (s.kind === "fail" ? s.error : null));
    expect(errs.every(Boolean)).toBe(true);
    expect(errs.map((e) => e?.cause_)).toEqual([
      "Node 22.18 or later is needed",
      "Docker is not running",
      "account is not on Workers Paid",
    ]);
    expect(failExit(errs as never)).toBe(EXIT.failed);
  });

  it("not logged in → exit 3", () => {
    const steps = plan(opts(), probes({ whoami: { loggedIn: false, accounts: [] }, accountId: undefined }));
    expect(steps).toHaveLength(1);
    const e = (steps[0] as { error: { exit: number; message: string } }).error;
    expect(e.exit).toBe(EXIT.manual);
    expect(e.message).toBe(
      "Failed: wrangler is not logged in — fix: run npx wrangler login, then rerun ochost init",
    );
  });

  it("many accounts, non-interactive, no --account-id → exit 3", () => {
    const whoami = {
      loggedIn: true,
      accounts: [
        { id: ACCT, name: "a" },
        { id: "b".repeat(32), name: "b" },
      ],
    };
    const steps = plan(opts(), probes({ whoami, accountId: undefined }));
    expect((steps[0] as { error: { message: string; exit: number } }).error.message).toContain(
      "2 Cloudflare accounts",
    );
  });

  it("zero-token: no AI token is ever needed or asked for, interactive or not", () => {
    for (const interactive of [false, true]) {
      const p = plan(opts({ nonInteractive: !interactive }), probes({ interactive }));
      expect(p.some((s) => s.kind === "fail")).toBe(false);
      expect(p.find((s) => s.kind === "ai")).toEqual({ kind: "ai", source: "default" });
    }
  });

  it("--ai-token-file is the opt-in: the ai step reads it; --skip-ai drops the ai steps and the hop", () => {
    expect(plan(opts({ aiTokenFile: "t.txt" }), probes()).find((s) => s.kind === "ai")).toEqual({
      kind: "ai",
      source: "file",
    });
    const skip = plan(opts({ skipAi: true }), probes()).map((s) => s.kind);
    expect(skip).not.toContain("ai");
    expect(skip).not.toContain("aihop");
  });

  it("Worker exists with no local state: exit 3, --adopt adopts, interactive asks", () => {
    const worker = { exists: true, vars: { OC_INST: "abc123" } };
    const a = plan(opts(), probes({ worker }));
    expect((a[0] as { error: { message: string } }).error.message).toContain("rerun with --adopt");
    expect(plan(opts({ adopt: true }), probes({ worker })).find((s) => s.kind === "adopt")).toEqual({
      kind: "adopt",
      confirm: false,
    });
    expect(
      plan(opts({ nonInteractive: false }), probes({ worker, interactive: true })).find(
        (s) => s.kind === "adopt",
      ),
    ).toEqual({ kind: "adopt", confirm: true });
  });

  it("a Worker of that name that is not an oc-host install: exit 3 with --name or delete, never adopt", () => {
    const worker = { exists: true, vars: { SOME_OTHER: "x" } };
    for (const o of [opts(), opts({ adopt: true }), opts({ nonInteractive: false })]) {
      const a = plan(o, probes({ worker, interactive: !o.nonInteractive }));
      expect((a[0] as { error: { message: string } }).error.message).toMatch(
        /not an oc-host install.*--name <other>/,
      );
      expect(a.find((s) => s.kind === "adopt")).toBeUndefined();
    }
  });

  it("R2 off: interactive waits for Enter; non-interactive exits 3", () => {
    expect(plan(opts(), probes({ r2: false, interactive: true })).some((s) => s.kind === "r2-enable")).toBe(
      true,
    );
    const e = (plan(opts(), probes({ r2: false }))[0] as { error: { exit: number; cause_: string } }).error;
    expect([e.exit, e.cause_]).toEqual([EXIT.manual, "R2 is not enabled on this account"]);
  });

  it("no subdomain: --subdomain registers; non-interactive without it exits 3", () => {
    const none = { kind: "none" } as const;
    expect(plan(opts({ subdomain: "me" }), probes({ subdomain: none }))[1]).toEqual({
      kind: "subdomain",
      action: "register",
      subdomain: "me",
    });
    expect((plan(opts(), probes({ subdomain: none }))[0] as { error: { exit: number } }).error.exit).toBe(
      EXIT.manual,
    );
  });
});

describe("registry retries", () => {
  it("classifies blob unknown, push timeout, 401 after push", () => {
    expect(classifyDeployFailure("PUT ... blob unknown to registry")).toBe("retry");
    expect(retryReason("blob unknown to registry")).toBe("blob unknown");
    expect(classifyDeployFailure("net/http: timeout awaiting response headers")).toBe("retry");
    expect(classifyDeployFailure("Pushed layer\nUnauthorized")).toBe("retry");
    expect(classifyDeployFailure("Unauthorized")).toBe("other");
    const reset = "write tcp 10.0.0.2:5555->104.18.8.144:443: write: connection reset by peer";
    expect(classifyDeployFailure(reset)).toBe("retry");
    expect(retryReason(reset)).toBe("connection reset");
    expect(classifyDeployFailure("write tcp 1.2.3.4:443: write: broken pipe")).toBe("retry");
    expect(retryReason("write: broken pipe")).toBe("broken pipe");
    expect(classifyDeployFailure("You need a Workers Paid plan")).toBe("paid");
  });

  it("retries 3 more times, then fails with the retry error", async () => {
    let calls = 0;
    const w: Wrangler = {
      run: async () => {
        calls++;
        return { code: 1, stdout: "", stderr: "blob unknown to registry" };
      },
    };
    const reasons: string[] = [];
    await expect(
      deployWithRetry(w, [], { sleep: async () => {}, onRetry: (_n, why) => reasons.push(why) }),
    ).rejects.toThrow("image push kept failing (3 retries)");
    expect(calls).toBe(4);
    expect(reasons).toEqual(["blob unknown", "blob unknown", "blob unknown"]);
  });

  it("passes on the second try", async () => {
    let calls = 0;
    const w: Wrangler = {
      run: async () =>
        ++calls === 1
          ? { code: 1, stdout: "", stderr: "timeout awaiting response headers" }
          : { code: 0, stdout: "Deployed", stderr: "" },
    };
    expect((await deployWithRetry(w, [], { sleep: async () => {} })).attempts).toBe(2);
  });
});

describe("planSecrets keep rule", () => {
  let n = 0;
  const gen = () => `gen${++n}`.padEnd(64, "0");
  it("first run generates all; webhook pair shares one value", () => {
    const sp = planSecrets({ onWorker: undefined, manifest: {}, adopt: false }, gen);
    expect(Object.keys(sp.send).sort()).toEqual([
      "CONTROL_TOKEN",
      "OC_SECRET_OC_GATEWAY_TOKEN",
      "OC_SECRET_OC_TELEGRAM_WEBHOOK_SECRET",
      "TELEGRAM_WEBHOOK_SECRET",
    ]);
    expect(sp.send.TELEGRAM_WEBHOOK_SECRET).toBe(sp.send.OC_SECRET_OC_TELEGRAM_WEBHOOK_SECRET);
  });
  it("re-run with all present sends nothing", () => {
    const ct = "c".repeat(64);
    const all = [
      "CONTROL_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "OC_SECRET_OC_TELEGRAM_WEBHOOK_SECRET",
      "OC_SECRET_OC_GATEWAY_TOKEN",
      "OC_SECRET_OC_CF_AI_TOKEN",
    ];
    const manifest = { CONTROL_TOKEN: { name: "CONTROL_TOKEN", sha256: sha256(ct), setAt: "" } };
    const sp = planSecrets({ onWorker: all, manifest, localControlToken: ct, adopt: false }, gen);
    expect(sp.send).toEqual({});
    expect(sp.controlToken).toBe(ct);
  });
  it("interrupted deploy: the local control token is re-sent, not replaced", () => {
    const ct = "d".repeat(64);
    const sp = planSecrets({ onWorker: [], manifest: {}, localControlToken: ct, adopt: false }, gen);
    expect(sp.send.CONTROL_TOKEN).toBe(ct);
  });
  it("adopt makes a new control token", () => {
    const sp = planSecrets({ onWorker: ["CONTROL_TOKEN"], manifest: {}, adopt: true }, gen);
    expect(sp.send.CONTROL_TOKEN).toMatch(/^gen/);
  });
});

describe("redact", () => {
  it("removes registered secrets, Telegram tokens and bearer values", () => {
    registerSecret("supersecretvalue123");
    expect(redact("x supersecretvalue123 y")).toBe("x [redacted] y");
    expect(redact(`bot 123456789:${"A".repeat(35)}`)).toBe("bot [redacted-telegram]");
    expect(redact(`authorization: Bearer ${"z".repeat(40)}`)).toBe("authorization: Bearer [redacted]");
  });
});

// ---------------------------------------------------------------- end to end with fakes

interface World {
  /** Status of anonymous GET / (the login form); default 200. */
  rootAnonymous?: number;
  workerExists: boolean;
  secrets: Set<string>;
  bucketExists: boolean;
  deploys: number;
  bulk: number;
  configs: { ver: number; sha: string; doc: unknown }[];
  starts: number;
  codes: number;
  state: string;
  deployFlakes: string[];
  calls: string[];
  /** zones on the account (GET /zones); none by default */
  zones?: string[];
  /** POST /ops/gate/ai/v1/chat/completions: request bearer and body */
  gate: { auth: string | undefined; body: Record<string, unknown> }[];
  gateReply?: () => Response;
}

function fakeRunner(w: World) {
  return async (cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> => {
    const a = args.filter((x) => !x.endsWith("wrangler.js") && x !== "--yes" && !x.startsWith("wrangler@"));
    const line = `${cmd.split("/").pop()} ${a.join(" ")}`;
    w.calls.push(line);
    if (cmd === "docker") return { code: 0, stdout: "29.9.2", stderr: "" };
    if (a[0]?.endsWith("code-version.mjs"))
      return { code: 0, stdout: `__CODE_VERSION__:"${"e".repeat(64)}"\n`, stderr: "" };
    const sub = a.slice(0, 2).join(" ");
    if (a[0] === "whoami")
      return {
        code: 0,
        stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: ACCT, name: "T" }] }),
        stderr: "",
      };
    if (sub === "auth token")
      return {
        code: 0,
        stdout: JSON.stringify({ type: "oauth", token: "oauth-bearer-xyz-123" }),
        stderr: "",
      };
    if (sub === "secret list")
      return {
        code: 0,
        stdout: JSON.stringify([...w.secrets].map((name) => ({ name, type: "secret_text" }))),
        stderr: "",
      };
    if (sub === "secret bulk") {
      const f = JSON.parse(await readFile(a[2] as string, "utf8")) as Record<string, string>;
      for (const k of Object.keys(f)) w.secrets.add(k);
      w.bulk++;
      return { code: 0, stdout: "ok", stderr: "" };
    }
    if (a.slice(0, 3).join(" ") === "r2 bucket create") {
      if (w.bucketExists)
        return { code: 1, stdout: "", stderr: "The bucket you tried to create already exists (10004)" };
      w.bucketExists = true;
      return { code: 0, stdout: "Created", stderr: "" };
    }
    if (a[0] === "deploy") {
      const flake = w.deployFlakes.shift();
      o.onOutput?.("Building image\nPushing\n");
      if (flake) return { code: 1, stdout: "", stderr: flake };
      const i = a.indexOf("--secrets-file");
      if (i !== -1) {
        const f = JSON.parse(await readFile(a[i + 1] as string, "utf8")) as Record<string, string>;
        for (const k of Object.keys(f)) w.secrets.add(k);
        const st = await stat(a[i + 1] as string);
        expect(st.mode & 0o777).toBe(0o600);
      }
      w.deploys++;
      w.workerExists = true;
      return { code: 0, stdout: "Uploaded\nCurrent Version ID: x", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `fake runner: no rule for ${line}` };
  };
}

function fakeFetch(w: World): typeof fetch {
  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const m = init.method ?? "GET";
    const path = url.pathname;
    w.calls.push(`${m} ${url.host}${path}`);
    if (url.host === "api.cloudflare.com") {
      if (path.endsWith("/containers/me")) return json({ success: true, limits: { total_vcpu: 1500 } });
      if (path.endsWith("/r2/buckets")) return json({ success: true, result: { buckets: [] } });
      if (path.endsWith("/zones"))
        return json({ success: true, result: (w.zones ?? []).map((name) => ({ name })) });
      if (path.endsWith("/workers/subdomain")) return json({ success: true, subdomain: "sub" });
      if (path.includes("/workers/scripts/"))
        return w.workerExists
          ? json({
              success: true,
              result: { bindings: [{ type: "plain_text", name: "OC_INST", text: "x" }] },
            })
          : json({ success: false, errors: [{ code: 10007, message: "not found" }] }, 404);
      if (path.endsWith("/tokens/verify"))
        return json({ success: true, result: { id: "t1", status: "active" } });
      if (path.endsWith("/ai-gateway/gateways")) {
        if (m === "GET") return json({ success: true, result: [{ id: "oc-host", authentication: true }] });
      }
      return json({ success: false, errors: [{ code: 1, message: `fake: ${m} ${path}` }] }, 400);
    }
    if (url.host === "gateway.ai.cloudflare.com")
      return json({ error: "init must not call the gateway" }, 500);
    // the Worker
    const auth = (init.headers as Record<string, string> | undefined)?.authorization;
    // Like the real Worker (docs/18, docs/15): anonymous `/` is the login form; a GET of the owner link is the
    // Continue page; the page's POST sets the cookie.
    if (path === "/" && !auth) {
      const cookie = (init.headers as Record<string, string> | undefined)?.cookie;
      return cookie
        ? new Response("<title>OpenClaw Control</title>", { status: 200 })
        : new Response('<h1>Sign in</h1><form method="post" action="/_ochost/login"></form>', {
            status: w.rootAnonymous ?? 200,
          });
    }
    if (path.startsWith("/_ochost/login/"))
      return m === "POST"
        ? new Response("<h1>Signed in</h1>", { status: 200, headers: { "set-cookie": "ochost=s1; Path=/" } })
        : new Response('<h1>Sign in</h1><form method="post"><button type="submit">Continue</button></form>', {
            status: 200,
          });
    if (path === "/_ochost/logout") return new Response(null, { status: 303 });
    if (!auth) return json({ error: "not found" }, 404);
    if (path === "/ops/status") return json({ inst: "x", state: w.state, epoch: w.starts ? { n: 1 } : null });
    if (path === "/ops/config" && m === "GET")
      return json({ versions: [...w.configs].reverse().map(({ ver, sha }) => ({ ver, sha })) });
    if (path === "/ops/config" && m === "POST") {
      const b = JSON.parse(String(init.body)) as { doc: unknown };
      const ver = w.configs.length + 1;
      w.configs.push({ ver, sha: sha256(JSON.stringify(b.doc)), doc: b.doc });
      return json({ ok: true, ver });
    }
    if (path === "/ops/start" && m === "POST") {
      w.starts++;
      w.state = "running";
      return json({ ensured: true, epoch: 1, state: "starting" });
    }
    if (path === "/ops/auth/code")
      return json({
        code: `${++w.codes}`.padStart(32, "c"),
        expiresAt: Date.now() + 5 * 60_000,
        url: `${url.origin}/_ochost/login/${`${w.codes}`.padStart(32, "c")}`,
      });
    if (path === "/ops/archive") return json({ ok: true }, 202);
    if (path === "/ops/gate/ai/v1/chat/completions" && m === "POST") {
      w.gate.push({ auth, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return (
        w.gateReply?.() ??
        json({ choices: [{ message: { content: "pong" } }], usage: { neurons: 3.3, prompt_tokens: 9 } })
      );
    }
    return json({ error: `fake: ${m} ${path}` }, 404);
  }) as typeof fetch;
}

describe("runInit end to end (fake wrangler + fake fetch)", () => {
  let dir: string;
  let w: World;
  const out: string[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ochost-test-"));
    w = {
      workerExists: false,
      secrets: new Set(),
      bucketExists: false,
      deploys: 0,
      bulk: 0,
      configs: [],
      starts: 0,
      codes: 0,
      state: "none",
      deployFlakes: [],
      calls: [],
      gate: [],
    };
    out.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctxFor = (argv: string[], env: Record<string, string> = {}): Ctx => ({
    ui: makeUi(
      { json: false, nonInteractive: true },
      { err: { write: (s: string) => out.push(s) }, out: { write: (s: string) => out.push(s) } },
    ),
    args: parseArgs(argv, {
      name: { type: "string" },
      "skip-ai": { type: "boolean" },
      "no-open": { type: "boolean" },
      "non-interactive": { type: "boolean" },
      bucket: { type: "string" },
      "fake-telegram": { type: "boolean" },
      gateway: { type: "string" },
    }),
    dir,
    run: fakeRunner(w),
    fetch: fakeFetch(w),
    env,
    sleep: async () => {},
    now: () => Date.now(),
    prompt: {
      ask: async () => {
        throw new Error("prompted");
      },
      askHidden: async () => {
        throw new Error("prompted");
      },
    },
    interactive: false,
  });

  it("first run does every step; second run changes nothing", async () => {
    w.deployFlakes = ["blob unknown to registry"];
    const argv = ["--name", "oc-m5-test", "--bucket", "oc-m5-test", "--non-interactive"];
    expect(await initCommand(ctxFor(argv))).toBe(0);
    expect(w.deploys).toBe(1);
    expect(w.calls.filter((c) => c.includes(" deploy ")).length).toBe(2); // 1 flake + 1 pass
    expect(w.bucketExists).toBe(true);
    expect([...w.secrets].sort()).toEqual([
      "CONTROL_TOKEN",
      "OC_SECRET_OC_GATEWAY_TOKEN",
      "OC_SECRET_OC_TELEGRAM_WEBHOOK_SECRET",
      "TELEGRAM_WEBHOOK_SECRET",
    ]);
    expect(w.configs).toHaveLength(1);
    const doc = JSON.stringify(w.configs[0]?.doc);
    expect(doc).toContain('"baseUrl":"http://15.0.0.3/ai/v1"');
    expect(doc).not.toMatch(/gateway\.ai\.cloudflare\.com|OC_CF_AI_TOKEN|cf-aig/);
    // the model hop ran through the gate with the owner bearer, after the deploy, and no token exists anywhere
    expect(w.gate).toHaveLength(1);
    expect(w.gate[0]?.auth).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(w.gate[0]?.body.model).toBe("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
    expect(w.calls.some((c) => c.includes("gateway.ai.cloudflare.com"))).toBe(false);
    expect(w.calls.some((c) => c.includes("ai-gateway"))).toBe(false); // no API call: gateway "default" is made on first use
    expect(out.join("")).toMatch(/\] model hop\s+\d+ ms/);
    expect(w.starts).toBe(1);
    const text = out.join("");
    expect(text).toContain("retry 1 of 3: blob unknown");
    expect(text).toMatch(/^\s+Login\s+https:\/\/oc-m5-test\.sub\.workers\.dev\/_ochost\/login\/\w+/m);
    const ct = await stat(join(dir, ".oc-host", "control-token"));
    expect(ct.mode & 0o777).toBe(0o600);
    const cfg = await readFile(join(dir, "oc-host.jsonc"), "utf8");
    expect(cfg).toContain('"bucket": "oc-m5-test"');
    expect(cfg).toMatch(/"alerts": \{ "channel": "none"/); // alerts off by default; no question asked
    const wr = await readFile(join(dir, ".oc-host", "wrangler.jsonc"), "utf8");
    expect(wr).toContain('"bucket_name": "oc-m5-test"');
    expect(wr).toContain('"OC_TEST": "0"');

    // second run: same inputs, nothing changes (the model hop repeats: it costs nothing to the install)
    out.length = 0;
    const before = { deploys: w.deploys, bulk: w.bulk, configs: w.configs.length, starts: w.starts };
    expect(await initCommand(ctxFor(argv))).toBe(0);
    expect({ deploys: w.deploys, bulk: w.bulk, configs: w.configs.length, starts: w.starts }).toEqual(before);
    expect(out.join("")).toMatch(/\[ ?8\/14\] deploy\s+no change, skipped/);
    expect(out.join("")).toMatch(/\] config\s+ver 1 is current/);
    expect(out.join("")).toMatch(/\] start\s+already running/);
  });

  it("prints the Access recommendation only when the account has a zone", async () => {
    const argv = ["--name", "oc-m5-test", "--bucket", "oc-m5-test", "--non-interactive"];
    expect(await initCommand(ctxFor(argv))).toBe(0);
    expect(out.join("")).not.toContain("Cloudflare Access");
    out.length = 0;
    w.zones = ["example.com"];
    expect(await initCommand(ctxFor(argv))).toBe(0);
    expect(out.join("")).toMatch(
      /Recommended: .*Cloudflare Access \(zone example\.com\): .* auth access --domain oc\.example\.com/,
    );
  });

  it("--fake-telegram deploys with OC_TEST=1 and sticks; --no-fake-telegram goes back and redeploys", async () => {
    const wr = () => readFile(join(dir, ".oc-host", "wrangler.jsonc"), "utf8");
    const st = async () => JSON.parse(await readFile(join(dir, ".oc-host", "state.json"), "utf8"));
    const base = ["--name", "oc-m5-test", "--non-interactive"];
    expect(await initCommand(ctxFor([...base, "--fake-telegram"]))).toBe(0);
    expect(await wr()).toContain('"OC_TEST": "1"');
    expect((await st()).fakeTelegram).toBe(true);
    expect(out.join("")).toMatch(/WARN: test install \(--fake-telegram\).*ochost init --no-fake-telegram/);
    expect(w.deploys).toBe(1);
    // rerun without the flag: still fake, nothing to deploy
    expect(await initCommand(ctxFor(base))).toBe(0);
    expect(await wr()).toContain('"OC_TEST": "1"');
    expect(w.deploys).toBe(1);
    // back to a real bot: OC_TEST=0 changes the deploy hash, so it deploys once
    expect(await initCommand(ctxFor([...base, "--no-fake-telegram"]))).toBe(0);
    expect(await wr()).toContain('"OC_TEST": "0"');
    expect((await st()).fakeTelegram).toBeUndefined();
    expect(w.deploys).toBe(2);
  });

  it("--json: stdout is one document with the summary facts; stderr is one JSON event per line", async () => {
    const out2: string[] = [];
    const err2: string[] = [];
    const ctx = ctxFor(["--name", "oc-m5-test", "--non-interactive", "--fake-telegram"]);
    ctx.ui = makeUi(
      { json: true, nonInteractive: true },
      { err: { write: (s: string) => err2.push(s) }, out: { write: (s: string) => out2.push(s) } },
    );
    expect(await initCommand(ctx)).toBe(0);
    const doc = JSON.parse(out2.join(""));
    expect(doc).toMatchObject({
      ok: true,
      url: "https://oc-m5-test.sub.workers.dev",
      fakeTelegram: true,
      bot: null,
      cost: { lightUsd: [7, 14], lightHighUsd: 25, alwaysOnUsd: [50, 69] },
    });
    expect(doc.nextCommands[0].cmd).toMatch(/channels add telegram/);
    // Alerts are off by default (alerts.channel "none"): the last next command says how to turn them on.
    expect(doc.nextCommands.at(-1)).toMatchObject({
      cmd: expect.stringMatching(/alerts setup/),
      why: "alerts are off (the default); this turns them on",
    });
    const events = err2
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const done = events.filter((e) => e.done);
    expect(done.map((e) => e.step)).toEqual([
      "preflight",
      "account",
      "subdomain",
      "files",
      "ai model",
      "secrets",
      "r2 bucket",
      "deploy",
      "health",
      "model hop",
      "config",
      "start",
      "self-test",
      "login",
    ]);
    expect(done.every((e) => typeof e.ms === "number" && e.total === 14)).toBe(true);
  });

  it("M8 F3: the self-test passes on a healthy install: login form at /, Continue page, session, no WARN", async () => {
    expect(await initCommand(ctxFor(["--name", "oc-m5-test", "--non-interactive"]))).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/anonymous sees the login form, UI opens/);
    expect(text).not.toMatch(/self-test:.*(returned|gave|no cookie|failed)/);
    expect(w.calls.filter((c) => /^POST \S+\/_ochost\/login\/c+\d$/.test(c))).toHaveLength(1);
  });

  it("the self-test still warns when anonymous / is not the login form", async () => {
    w.rootAnonymous = 404;
    expect(await initCommand(ctxFor(["--name", "oc-m5-test", "--non-interactive"]))).toBe(0);
    expect(out.join("")).toMatch(/self-test: anonymous GET \/ returned 404/);
  });

  it("a step that fails still prints its line, then the error is one Failed line", async () => {
    w.deployFlakes = ["Unauthorized"];
    await expect(initCommand(ctxFor(["--name", "oc-m5-test", "--non-interactive"]))).rejects.toThrow(
      /^Failed: /,
    );
    expect(out.join("")).toMatch(/\[ ?8\/14\] deploy\s+failed/);
  });

  it("DX-1 U5: interactive rerun never prompts; Next line names a command that runs", async () => {
    const argv = ["--name", "oc-m5-test", "--non-interactive"];
    expect(await initCommand(ctxFor(argv))).toBe(0);
    expect(out.join("")).toMatch(/^\s+(ochost|node \S+ochost\.js) channels add telegram .*one paste/m);
    out.length = 0;
    const ctx = ctxFor(["--name", "oc-m5-test", "--no-open"]);
    ctx.interactive = true; // prompt.askHidden throws "prompted" if called
    expect(await initCommand(ctx)).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/\] ai model\s+deepseek-v4\.1-flash-1017 via gateway default/);
    expect(text).not.toMatch(/Paste/);
    expect(w.bulk).toBe(0);
  });

  it("a pre-zero-token install: the old AI secret on the Worker is not re-sent and init says how to delete it", async () => {
    const argv = ["--name", "oc-m5-test", "--non-interactive"];
    expect(await initCommand(ctxFor(argv))).toBe(0);
    w.secrets.add("OC_SECRET_OC_CF_AI_TOKEN");
    out.length = 0;
    expect(await initCommand(ctxFor(argv))).toBe(0);
    expect(w.bulk).toBe(0);
    expect(out.join("")).toMatch(
      /still holds OC_SECRET_OC_CF_AI_TOKEN.*wrangler secret delete OC_SECRET_OC_CF_AI_TOKEN --name oc-m5-test/,
    );
  });

  it("the model hop failing names the fix: a gateway that does not exist → --gateway default", async () => {
    w.gateReply = () =>
      new Response(JSON.stringify({ error: { message: "gateway not found: mine" } }), { status: 400 });
    const ctx = ctxFor(["--name", "oc-m5-test", "--non-interactive", "--gateway", "mine"]);
    await expect(initCommand(ctx)).rejects.toThrow(
      /gateway mine does not exist: rerun with --gateway default/,
    );
  });

  it("--gateway none: the model runs without a gateway; init says logs are off", async () => {
    const ctx = ctxFor(["--name", "oc-m5-test", "--non-interactive", "--gateway", "none"]);
    expect(await initCommand(ctx)).toBe(0);
    expect(out.join("")).toMatch(/no AI Gateway: calls run without logs/);
    expect(await readFile(join(dir, ".oc-host", "wrangler.jsonc"), "utf8")).toContain('"OC_AI_GATEWAY": ""');
  });

  it("a config version from elsewhere is kept", async () => {
    const argv = ["--name", "oc-m5-test", "--non-interactive"];
    expect(await initCommand(ctxFor(argv))).toBe(0);
    w.configs.push({ ver: 2, sha: "other", doc: { channels: {} } });
    expect(await initCommand(ctxFor(argv))).toBe(0);
    expect(w.configs).toHaveLength(2);
    expect(out.join("")).toMatch(/\] config\s+ver 2 kept \(changed after init\)/);
  });

  it("--skip-ai posts an empty config doc (F9)", async () => {
    expect(await initCommand(ctxFor(["--name", "oc-m5-test", "--skip-ai", "--non-interactive"]))).toBe(0);
    // --skip-ai: the gate capabilities only, no model provider
    // storage location r2 on the install's bucket, prefix f/<inst> (docs/11 §8)
    const r2 = (w.configs[0]?.doc as any)?.storage?.locations?.r2;
    const inst = /^f\/([0-9a-f]{6})$/.exec(r2?.settings?.prefix)?.[1] as string;
    expect(inst).toBeTruthy();
    expect(r2.settings.bucket).toBe(`oc-host-${inst}`);
    expect(w.configs[0]?.doc).toEqual({
      ...renderCapabilities({ bucket: `oc-host-${inst}`, inst }),
      ochost: { renderVersion: RENDER_VERSION },
    });
    expect(JSON.stringify(w.configs[0]?.doc)).not.toContain("cfgw");
    expect(w.secrets.has("OC_SECRET_OC_CF_AI_TOKEN")).toBe(false);
    expect(w.gate).toEqual([]); // no model, no hop
  });

  it("Workers Paid off → exit 3 before any change", async () => {
    const f = fakeFetch(w);
    const ctx = ctxFor(["--name", "oc-m5-test", "--non-interactive"]);
    ctx.fetch = (async (i: string | URL | Request, init?: RequestInit) =>
      String(i).endsWith("/containers/me")
        ? new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 })
        : f(i, init)) as typeof fetch;
    await expect(initCommand(ctx)).rejects.toMatchObject({
      exit: EXIT.manual,
      cause_: "account is not on Workers Paid",
    });
    expect(w.deploys).toBe(0);
    await expect(stat(join(dir, "oc-host.jsonc"))).rejects.toThrow();
  });

  it("--ai-token-file (opt-in): finds the gateway through the API; the token is read, never sent to the Worker", async () => {
    const f = join(dir, "ai.txt");
    await writeFile(f, `${"q".repeat(53)}\n`, { mode: 0o644 });
    const ctx = ctxFor(["--name", "oc-m5-test", "--non-interactive"]);
    ctx.args.flags["ai-token-file"] = f;
    expect(await initCommand(ctx)).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/readable by others/);
    expect(text).toMatch(/\] ai model\s+deepseek-v4\.1-flash-1017 via gateway oc-host/);
    expect(w.calls.some((c) => c.includes("ai-gateway/gateways"))).toBe(true);
    expect([...w.secrets]).not.toContain("OC_SECRET_OC_CF_AI_TOKEN");
    expect(text).not.toContain("q".repeat(53));
    expect(JSON.stringify(w.gate)).not.toContain("q".repeat(53));
    expect(await readFile(join(dir, ".oc-host", "wrangler.jsonc"), "utf8")).toContain(
      '"OC_AI_GATEWAY": "oc-host"',
    );
  });
});
