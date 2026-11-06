// M6: ochost upgrade check | run | rollback against a fake registry (npm + GHCR), a fake docker/contract runner,
// a fake deploy hook and the fake /ops server. Nothing here touches Docker, Cloudflare or the network.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfigText, parseJsonc, validateConfig } from "../src/config.ts";
import { renderWranglerJsonc } from "../src/deploy.ts";
import { dockerfilePin } from "../src/image-pin.ts";
import { runOps } from "../src/ops-commands.ts";
import { makeCtx } from "../src/ops-lib.ts";
import {
  type ContractResult,
  compareVersions,
  type Hooks,
  resolveTarget,
  upgrade,
  upgradeFlags,
} from "../src/upgrade.ts";
import { FakeOps, fakeClock, installDir, type Req, statusBody } from "./ops-fake.ts";

const SOURCE = resolve(import.meta.dirname, "..", "..");
const PINNED = "sha256:1a2a3ce113e435039dbeac5ae261759bb4759908563d91c81059e896b38c5d98"; // image/Dockerfile
const d = (c: string) => `sha256:${c.repeat(64)}`;

let f: FakeOps;
let dir: string;
let tags: Record<string, string>; // npm dist-tags
let digests: Record<string, string>; // GHCR tag -> index digest
let contract: ContractResult;
let docker: { cmd: string; args: string[] }[];
let deploys: { current?: string; previous?: string }[];
let restarts: number;
/** what the fake Worker shows after each restart: [state, digest, channelUpdatedAt] */
let afterRestart: (n: number) => Record<string, unknown>;

const pass = (schema = { status: "exact", found: 20, target: 20 }): ContractResult => ({
  status: "pass",
  checks: [{ label: "cand: /startupz", ok: true }],
  measured: { schema },
});

const healthy = (digest: string, chAt: number) =>
  statusBody({
    state: "running",
    epoch: { n: 3, imageKey: "oc", digest, status: "active" },
    rt: { hb: { phase: "running", lastActivityAt: 1 } },
    channels: [{ channel: "telegram", account: "default", lifecycle: "started", updatedAt: chAt }],
  });

function registryFetch(): typeof fetch {
  return (async (i: string | URL | Request, init?: RequestInit) => {
    const url = String(i);
    if (url.startsWith("https://registry.npmjs.org/-/package/openclaw/dist-tags")) return Response.json(tags);
    if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "anon" });
    const m = /^https:\/\/ghcr\.io\/v2\/openclaw\/openclaw\/manifests\/(.+)$/.exec(url);
    if (m) {
      const dg = digests[m[1] as string];
      return dg
        ? new Response(null, { status: 200, headers: { "docker-content-digest": dg } })
        : new Response(null, { status: 404 });
    }
    return globalThis.fetch(i, init);
  }) as typeof fetch;
}

/** docker build succeeds; `node …/run.mjs` writes the contract result where --results says. */
async function fakeRun(cmd: string, args: string[]) {
  docker.push({ cmd, args });
  if (args[0]?.endsWith("run.mjs")) {
    const out = args[args.indexOf("--results") + 1] as string;
    await mkdir(join(out, "upgrade"), { recursive: true });
    await writeFile(join(out, "upgrade", "_upgrade-contract.json"), JSON.stringify(contract));
    return { code: contract.status === "pass" ? 0 : 1, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
}

const hooks: Hooks = {
  async deploy() {
    const img = JSON.parse(readFileSync(join(dir, ".oc-host", "image.json"), "utf8"));
    deploys.push({ current: img.current?.version, previous: img.previous?.version });
  },
};

async function go(sub: string[], over: { hooks?: Hooks } = {}) {
  let out = "";
  let err = "";
  const clock = fakeClock();
  const ctx = makeCtx(
    [...sub, "--dir", dir, "--non-interactive"],
    upgradeFlags,
    {
      env: { OCHOST_SOURCE: SOURCE },
      fetch: registryFetch(),
      run: fakeRun as never,
      now: clock.now,
      sleep: clock.sleep,
      nonInteractive: true,
    },
    { stdout: (s) => (out += s), stderr: (s) => (err += s) },
  );
  let code: number;
  try {
    code = await upgrade(ctx, over.hooks ?? hooks);
  } catch (e) {
    err += `${(e as Error).message}\n`;
    code = (e as { code?: number }).code ?? 1;
  }
  return { code, out, err };
}

function restartRoute(r: Req) {
  if (r.method === "POST" && r.path === "/ops/restart") {
    restarts++;
    f.status = afterRestart(restarts) as never;
    return { status: 200, body: { stop: {}, start: { ok: true } } };
  }
  return undefined;
}

beforeEach(async () => {
  f = await new FakeOps().start();
  f.routes.push(restartRoute);
  dir = installDir(f.url);
  tags = { "extended-stable": "2026.10.10", latest: "2026.10.10" };
  digests = { "2026.10.10": d("b"), "2026.10.9": PINNED, "2026.9.36": d("c") };
  contract = pass();
  docker = [];
  deploys = [];
  restarts = 0;
  f.status = healthy(d("1"), 100);
  afterRestart = () => healthy(d("2"), 200);
});
afterEach(() => f.stop());

describe("compareVersions", () => {
  it("orders calendar versions numerically, a prerelease before its release", () => {
    expect(compareVersions("2026.10.10", "2026.10.9")).toBe(1);
    expect(compareVersions("2026.9.36", "2026.10.9")).toBe(-1);
    expect(compareVersions("2026.10.10-beta.5", "2026.10.10")).toBe(-1);
    expect(compareVersions("2026.10.10-beta.5", "2026.10.9")).toBe(1);
    expect(compareVersions("2026.10.9", "2026.10.9")).toBe(0);
  });
});

describe("upgrade check", () => {
  it("newer: prints the delta, both digests and the notes URL, exit 3", async () => {
    const r = await go(["check"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("extended-stable -> 2026.10.10");
    expect(r.out).toMatch(/pinned\s+2026\.10\.9\s+sha256:1a2a3ce113e4…\s+\(image\/Dockerfile\)/);
    expect(r.out).toMatch(/deployed\s+epoch 3\s+sha256:111111111111…/);
    expect(r.out).toContain("newer: 2026.10.9 -> 2026.10.10");
    expect(r.out).toContain("https://github.com/openclaw/openclaw/releases/tag/v2026.10.10");
    // the install learns the result: the owner panel's install row shows it
    const post = f.reqs.find((q) => q.path === "/ops/upgrade-check");
    expect(post?.method).toBe("POST");
    expect(post?.body).toMatchObject({
      pinned: { version: "2026.10.9", digest: PINNED },
      target: { version: "2026.10.10" },
      delta: "newer",
    });
  });

  it("same version and digest: exit 0", async () => {
    tags["extended-stable"] = "2026.10.9";
    const r = await go(["check"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/delta\s+same/);
  });

  it("older track (extended-stable behind the pin): exit 0, says so", async () => {
    tags["extended-stable"] = "2026.9.36";
    const r = await go(["check"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/delta\s+older than the pin/);
  });

  it("same version, new digest (moved tag): exit 3, not 'newer'", async () => {
    tags["extended-stable"] = "2026.10.9";
    digests["2026.10.9"] = d("e");
    const r = await go(["check"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("new digest");
  });

  it("--json is one document; runs through the real dispatch table", async () => {
    let out = "";
    const code = await runOps(
      "upgrade",
      ["check", "--json", "--dir", dir],
      { env: { OCHOST_SOURCE: SOURCE }, fetch: registryFetch(), nonInteractive: true },
      { stdout: (s) => (out += s), stderr: () => {} },
    );
    expect(code).toBe(3);
    expect(JSON.parse(out)).toMatchObject({
      delta: "newer",
      target: { version: "2026.10.10", digest: d("b") },
      pinned: { version: "2026.10.9", digest: PINNED },
    });
  });

  it("reads the pin from image/Dockerfile", async () => {
    expect(await dockerfilePin(SOURCE)).toMatchObject({ version: "2026.10.9", digest: PINNED });
  });
});

describe("upgrade run", () => {
  it("refuses when check would not say newer; no docker, no deploy", async () => {
    tags["extended-stable"] = "2026.10.9";
    let r = await go(["run"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("already on 2026.10.9");
    tags["extended-stable"] = "2026.9.36";
    r = await go(["run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("older than the pin");
    expect(docker).toEqual([]);
    expect(deploys).toEqual([]);
  });

  it("happy path: build FROM the new digest, contract, deploy with the new pin, restart, watch", async () => {
    const r = await go(["run"]);
    expect(r.code).toBe(0);
    const builds = docker.filter((c) => c.cmd === "docker");
    const args = builds[0]?.args.join(" ") ?? "";
    expect(args).toContain(`BASE=ghcr.io/openclaw/openclaw@${d("b")}`);
    expect(args).toContain("OPENCLAW_VERSION=2026.10.10");
    expect(args).toContain(`BASE_DIGEST=${d("b")}`);
    expect(builds[1]?.args.join(" ")).toContain(`BASE=ghcr.io/openclaw/openclaw@${PINNED}`); // the pinned image for preflight
    const c = docker.find((x) => x.args[0]?.endsWith("run.mjs"));
    expect(c?.args).toContain("_upgrade-contract");
    expect(deploys).toEqual([{ current: "2026.10.10", previous: "2026.10.9" }]);
    expect(restarts).toBe(1);
    const img = JSON.parse(readFileSync(join(dir, ".oc-host", "image.json"), "utf8"));
    expect(img).toMatchObject({
      current: { version: "2026.10.10" },
      previous: { version: "2026.10.9" },
      epochDigest: d("2"),
    });
    expect(r.out).toContain("upgraded 2026.10.9 -> 2026.10.10");
  });

  it("accepts an explicit version", async () => {
    digests["2026.10.11"] = d("f");
    const r = await go(["run", "2026.10.11"]);
    expect(r.code).toBe(0);
    expect(deploys[0]?.current).toBe("2026.10.11");
  });

  it("refuses a schema change from the preflight, before any deploy", async () => {
    contract = {
      status: "fail",
      checks: [{ label: "database preflight is exact", ok: false }],
      measured: { schema: { status: "migration-required", found: 20, target: 21 } },
    };
    const r = await go(["run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "changes the state schema (database preflight migration-required, found 20, target 21)",
    );
    expect(deploys).toEqual([]);
    expect(restarts).toBe(0);
    expect(existsSync(join(dir, ".oc-host", "image.json"))).toBe(false);
  });

  it("names the failed contract checks", async () => {
    contract = {
      status: "fail",
      checks: [
        { label: "lock 1: no lock wait line", ok: false },
        { label: "x", ok: true },
      ],
    };
    const r = await go(["run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("image contract failed for 2026.10.10: lock 1: no lock wait line");
    expect(deploys).toEqual([]);
  });

  it("watch failure inside the window: redeploys the previous pin and says so", async () => {
    afterRestart = (k) =>
      k === 1
        ? statusBody({
            state: "running",
            degraded: true,
            ladder: { level: 2 },
            epoch: { n: 3, imageKey: "oc", digest: d("2"), status: "active" },
          })
        : healthy(d("1"), 300); // the rollback boot is fine
    const r = await go(["run", "--timeout", "60"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("rolled back to 2026.10.9 (upgrade failed: running but degraded");
    expect(deploys).toEqual([
      { current: "2026.10.10", previous: "2026.10.9" },
      { current: "2026.10.9", previous: undefined },
    ]);
    expect(restarts).toBe(2);
    expect(r.err).toContain("rolling back to 2026.10.9");
  });

  it("channels that were live must heartbeat again; a stale one counts as not back", async () => {
    afterRestart = (k) => (k === 1 ? healthy(d("2"), 100) : healthy(d("1"), 300)); // channel updatedAt did not move
    const r = await go(["run", "--timeout", "30"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("channels not back: telegram/default");
    expect(deploys).toHaveLength(2);
  });

  it("a failing deploy (archive-stale) puts the old pin back and redeploys it, without a restart", async () => {
    const bad: Hooks = {
      async deploy() {
        throw new Error("Failed: deploy refused: archive older — fix: ochost backup create");
      },
    };
    let calls = 0;
    const h: Hooks = { deploy: (c, i) => (calls++ === 0 ? bad.deploy(c, i) : hooks.deploy(c, i)) };
    afterRestart = () => healthy(d("1"), 100);
    const r = await go(["run"], { hooks: h });
    expect(r.code).toBe(1);
    expect(r.out).toContain("rolled back to 2026.10.9 (upgrade failed: Failed: deploy refused");
    expect(restarts).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".oc-host", "image.json"), "utf8")).current.version).toBe(
      "2026.10.9",
    );
  });
});

describe("upgrade rollback", () => {
  it("needs a previous image", async () => {
    const r = await go(["rollback"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no previous image to go back to");
  });

  it("after an upgrade: redeploys the previous pin, restarts, swaps current and previous", async () => {
    expect((await go(["run"])).code).toBe(0);
    deploys.length = 0;
    afterRestart = () => healthy(d("1"), 300);
    const r = await go(["rollback"]);
    expect(r.code).toBe(0);
    expect(deploys).toEqual([{ current: "2026.10.9", previous: "2026.10.10" }]);
    expect(r.out).toContain("rolled back 2026.10.10 -> 2026.10.9");
  });
});

describe("wrangler.jsonc", () => {
  it("carries the pin as images.oc.build_vars; none without a pin", () => {
    const cfg = validateConfig(
      parseJsonc(defaultConfigText({ name: "oc", inst: "a1b2c3", accountId: "0".repeat(32) })),
    );
    const base = { accountId: "0".repeat(32), url: "https://x.workers.dev", source: SOURCE };
    expect(renderWranglerJsonc(cfg, base)).not.toContain("build_vars");
    const vars = {
      BASE: `ghcr.io/openclaw/openclaw@${PINNED}`,
      OPENCLAW_VERSION: "2026.10.9",
      BASE_DIGEST: PINNED,
    };
    const doc = JSON.parse(renderWranglerJsonc(cfg, { ...base, buildVars: vars }).replace(/^\/\/.*\n/, ""));
    expect(doc.containers[0].images.oc.build_vars).toEqual(vars);
  });
});

describe("resolveTarget", () => {
  it("refuses a dist-tag that does not resolve to a release version, before any GHCR call", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(String(u));
      return Response.json({ evil: "1.2.3/../../x" });
    }) as unknown as typeof fetch;
    await expect(resolveTarget(f, "evil")).rejects.toThrow(/not an OpenClaw version/);
    expect(urls.every((u) => u.includes("registry.npmjs.org"))).toBe(true);
  });
});
