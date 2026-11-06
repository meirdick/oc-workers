// ochost auth access: fake wrangler runner, fake Cloudflare API (+ the custom domain), fake deploy hook.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type AccessHooks, access } from "../src/access.ts";
import { authFlags } from "../src/auth.ts";
import { defaultConfigText, parseJsonc, validateConfig } from "../src/config.ts";
import { type AccessState, renderWranglerJsonc } from "../src/deploy.ts";
import { makeCtx } from "../src/ops-lib.ts";
import { type Call, cf, cfErr, fakeFetch } from "./fakes.ts";
import { fakeClock, fakeRunner, installDir } from "./ops-fake.ts";

const ACCT = "0".repeat(32);
const TEAM = "acme.cloudflareaccess.com";
const DOMAIN = "oc.example.com";
const SOURCE = resolve(import.meta.dirname, "..", "..");

let dir: string;
let deploys: { access: AccessState | undefined }[];
let deployFails = false;
/** Order of hook calls: "deploy" and "restart" (the origin moves, so the gateway must boot again). */
let order: string[];
let restartFails = false;
const hooks: AccessHooks = {
  async deploy(ctx) {
    if (deployFails) throw new Error("deploy boom");
    const st = JSON.parse(readFileSync(join(ctx.dir, ".oc-host", "state.json"), "utf8"));
    deploys.push({ access: st.access });
    order.push("deploy");
  },
  async restart() {
    order.push("restart");
    if (restartFails) throw new Error("ops down");
    return "restarted";
  },
};
const stateOf = () => JSON.parse(readFileSync(join(dir, ".oc-host", "state.json"), "utf8"));

interface ApiOpts {
  orgs?: ReturnType<typeof cf> | ReturnType<typeof cfErr>;
  apps?: unknown[];
  policies?: unknown[];
  zones?: string[];
  site?: { status: number; location?: string };
}
function api(o: ApiOpts = {}) {
  const f = fakeFetch([
    [
      "GET https://api.cloudflare.com/client/v4/zones",
      () => cf((o.zones ?? ["example.com"]).map((name) => ({ name }))),
    ],
    [
      "GET https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/organizations",
      () => o.orgs ?? cf({ auth_domain: TEAM }),
    ],
    [
      "GET https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/apps/app-1/policies",
      () => cf(o.policies ?? []),
    ],
    ["GET https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/apps", () => cf(o.apps ?? [])],
    [
      "POST https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/apps/app-1/policies",
      () => cf({ id: "pol-1" }),
    ],
    [
      "PUT https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/apps/app-1/policies/",
      () => cf({ id: "pol-1" }),
    ],
    [
      "POST https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/apps",
      () => cf({ id: "app-1", aud: "aud-tag-1", domain: DOMAIN }),
    ],
    [
      "PUT https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/apps/app-1",
      () => cf({ id: "app-1", aud: "aud-tag-1", domain: DOMAIN }),
    ],
    [
      "DELETE https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/access/apps/app-1",
      () => cf({ id: "app-1" }),
    ],
    [
      "GET https://" + DOMAIN,
      () => {
        const s = o.site ?? { status: 302, location: `https://${TEAM}/cdn-cgi/access/login/${DOMAIN}?kid=x` };
        return { status: s.status, json: {}, headers: s.location ? { location: s.location } : undefined };
      },
    ],
  ]);
  return f;
}

function wr() {
  return fakeRunner((c) => {
    if (c.args.includes("token"))
      return { stdout: JSON.stringify({ token: "oauth-token-fake-0123456789abcdef" }) };
    if (c.args.includes("whoami"))
      return { stdout: JSON.stringify({ loggedIn: true, email: "me@example.com", accounts: [] }) };
    return undefined;
  });
}

async function go(argv: string[], over: { fetch?: typeof fetch; run?: ReturnType<typeof wr>["run"] } = {}) {
  let out = "";
  let err = "";
  const clock = fakeClock();
  const ctx = makeCtx(
    [...argv, "--dir", dir, "--non-interactive"],
    authFlags,
    {
      fetch: over.fetch,
      run: over.run ?? wr().run,
      now: clock.now,
      sleep: clock.sleep,
      nonInteractive: true,
      env: {},
    },
    { stdout: (s) => (out += s), stderr: (s) => (err += s) },
  );
  let code: number;
  try {
    code = await access(ctx, hooks);
  } catch (e) {
    err += `${(e as Error).message}\n`;
    code = (e as { code?: number }).code ?? 1;
  }
  return { code, out, err };
}
const call = (calls: Call[], m: string, tail: string) =>
  calls.find((c) => c.method === m && c.url.endsWith(tail));

beforeEach(() => {
  dir = installDir("https://oc-test.example.workers.dev");
  writeFileSync(
    join(dir, ".oc-host", "state.json"),
    JSON.stringify({
      url: "https://oc-test.example.workers.dev",
      inst: "a1b2c3",
      accountId: ACCT,
      name: "oc-m5-test",
    }),
  );
  deploys = [];
  deployFails = false;
  order = [];
  restartFails = false;
});

describe("auth access --domain", () => {
  it("creates the app and an owner-only allow policy, stores state, deploys, verifies the redirect", async () => {
    const a = api();
    const r = await go(["access", "--domain", "OC.Example.com"], { fetch: a.fetch });
    expect(r.code).toBe(0);
    const app = call(a.calls, "POST", "/access/apps");
    expect(app?.body).toMatchObject({ type: "self_hosted", domain: DOMAIN, app_launcher_visible: false });
    expect(app?.body.allowed_idps).toBeUndefined();
    expect(app?.headers.authorization).toBe("Bearer oauth-token-fake-0123456789abcdef");
    const pol = call(a.calls, "POST", "/access/apps/app-1/policies");
    expect(pol?.body).toMatchObject({ decision: "allow", include: [{ email: { email: "me@example.com" } }] });
    expect(JSON.stringify(pol?.body)).not.toMatch(/everyone|any_valid/i);
    expect(stateOf().access).toEqual({
      domain: DOMAIN,
      team: TEAM,
      aud: "aud-tag-1",
      appId: "app-1",
      policyId: "pol-1",
      email: "me@example.com",
      workersDev: "ops",
    });
    // the Worker is redeployed after the app exists, and sees the state
    expect(deploys).toHaveLength(1);
    expect(deploys[0]?.access?.aud).toBe("aud-tag-1");
    expect(r.out).toContain("access on: https://oc.example.com");
  });

  it("restarts after the deploy so the gateway takes the custom domain as its origin", async () => {
    const r = await go(["access", "--domain", DOMAIN], { fetch: api().fetch });
    expect(r.code).toBe(0);
    expect(order).toEqual(["deploy", "restart"]);
  });

  it("a failed restart warns with the fix and keeps Access on (the deploy stands)", async () => {
    restartFails = true;
    const r = await go(["access", "--domain", DOMAIN], { fetch: api().fetch });
    expect(r.code).toBe(0);
    expect(r.err).toContain("ochost restart");
    expect(stateOf().access.domain).toBe(DOMAIN);
  });

  it("--token-file is the bearer and wrangler's login is not asked for a token", async () => {
    const tf = join(mkdtempSync(join(tmpdir(), "ochost-tok-")), "t");
    writeFileSync(tf, "api-token-from-file-0123456789\n");
    const a = api();
    const w = wr();
    const r = await go(["access", "--domain", DOMAIN, "--token-file", tf], { fetch: a.fetch, run: w.run });
    expect(r.code).toBe(0);
    expect(call(a.calls, "POST", "/access/apps")?.headers.authorization).toBe(
      "Bearer api-token-from-file-0123456789",
    );
    expect(w.calls.some((c) => c.args.includes("token"))).toBe(false);
    expect(r.out + r.err).not.toContain("api-token-from-file");
  });

  it("--token-file with --team: an org read refused (403) still creates the app", async () => {
    const tf = join(mkdtempSync(join(tmpdir(), "ochost-tok-")), "t");
    writeFileSync(tf, "api-token-from-file-0123456789\n");
    const a = api({ orgs: cfErr(10000) });
    const r = await go(["access", "--domain", DOMAIN, "--token-file", tf, "--team", TEAM], {
      fetch: a.fetch,
    });
    expect(r.code).toBe(0);
    expect(call(a.calls, "POST", "/access/apps")).toBeDefined();
    expect(stateOf().access).toMatchObject({ team: TEAM, appId: "app-1" });
  });

  it("--idp-hint allows only that IdP and skips the login chooser; --workers-dev webhooks is stored", async () => {
    const a = api();
    await go(["access", "--domain", DOMAIN, "--idp-hint", "idp-123", "--workers-dev", "webhooks"], {
      fetch: a.fetch,
    });
    expect(call(a.calls, "POST", "/access/apps")?.body).toMatchObject({
      allowed_idps: ["idp-123"],
      auto_redirect_to_identity: true,
    });
    expect(stateOf().access).toMatchObject({ idpHint: "idp-123", workersDev: "webhooks" });
  });

  it("a rerun updates the existing app and policy instead of adding a second one", async () => {
    const a = api({
      apps: [{ id: "app-1", aud: "aud-tag-1", domain: DOMAIN }],
      policies: [{ id: "pol-1", name: "oc-host owner" }],
    });
    const r = await go(["access", "--domain", DOMAIN], { fetch: a.fetch });
    expect(r.code).toBe(0);
    expect(call(a.calls, "POST", "/access/apps")).toBeUndefined();
    expect(call(a.calls, "PUT", "/access/apps/app-1")).toBeDefined();
    expect(call(a.calls, "PUT", "/access/apps/app-1/policies/pol-1")).toBeDefined();
    expect(call(a.calls, "POST", "/access/apps/app-1/policies")).toBeUndefined();
  });

  it("no Access scope (403): prints the dashboard steps, exit 3, nothing changed, no deploy", async () => {
    const a = api({ orgs: cfErr(10000) });
    const r = await go(["access", "--domain", DOMAIN], { fetch: a.fetch });
    expect(r.code).toBe(3);
    expect(r.err).toContain("Self-hosted");
    expect(r.err).toContain("--token-file");
    expect(r.err).toContain(`--team <team>.cloudflareaccess.com --aud <AUD>`);
    expect(r.err).toContain("me@example.com");
    expect(deploys).toHaveLength(0);
    expect(stateOf().access).toBeUndefined();
  });

  it("--team and --aud from the dashboard finish the install with no Access API call", async () => {
    const a = api();
    const r = await go(["access", "--domain", DOMAIN, "--team", `https://${TEAM}/`, "--aud", "dash-aud"], {
      fetch: a.fetch,
    });
    expect(r.code).toBe(0);
    expect(a.calls.some((c) => c.url.includes("/access/"))).toBe(false);
    expect(stateOf().access).toMatchObject({ team: TEAM, aud: "dash-aud" });
    expect(deploys).toHaveLength(1);
  });

  it("a host that is not on one of the account's zones is refused before anything is created", async () => {
    const a = api({ zones: ["other.org"] });
    const r = await go(["access", "--domain", DOMAIN], { fetch: a.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not on a zone");
    expect(call(a.calls, "POST", "/access/apps")).toBeUndefined();
  });

  it("a hostname that does not redirect to Access fails (state and deploy stay, rerun verifies)", async () => {
    const a = api({ site: { status: 200 } });
    const r = await go(["access", "--domain", DOMAIN], { fetch: a.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not redirect to the Access login");
    expect(stateOf().access.domain).toBe(DOMAIN);
  });

  it("a failed deploy restores the previous state", async () => {
    deployFails = true;
    const a = api();
    const r = await go(["access", "--domain", DOMAIN], { fetch: a.fetch });
    expect(r.code).toBe(1);
    expect(stateOf().access).toBeUndefined();
  });

  it("rejects a bad hostname and a lone --aud", async () => {
    expect((await go(["access", "--domain", "not a host"])).code).toBe(2);
    expect((await go(["access", "--domain", DOMAIN, "--aud", "x"])).code).toBe(2);
  });
});

describe("auth access --off", () => {
  it("redeploys without Access first, then deletes the app, then clears state", async () => {
    const a = api();
    await go(["access", "--domain", DOMAIN], { fetch: a.fetch });
    deploys.length = 0;
    const r = await go(["access", "--off"], { fetch: a.fetch });
    expect(r.code).toBe(0);
    expect(deploys).toEqual([{ access: undefined }]);
    expect(call(a.calls, "DELETE", "/access/apps/app-1")).toBeDefined();
    expect(stateOf().access).toBeUndefined();
    expect(r.out).toContain("Access app deleted");
    // the origin goes back to workers.dev: restart after the deploy
    expect(order.slice(-2)).toEqual(["deploy", "restart"]);
  });
  it("is a no-op when Access is not on", async () => {
    const r = await go(["access", "--off"], { fetch: api().fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain("access is not on");
    expect(deploys).toHaveLength(0);
    expect(order).toEqual([]);
  });
  it("without Access scope the Worker is still closed and the leftover app is reported", async () => {
    await go(["access", "--domain", DOMAIN, "--team", TEAM, "--aud", "dash-aud"], { fetch: api().fetch });
    // manual install has no appId: nothing to delete, a warning names the dashboard step only when an id exists
    const r = await go(["access", "--off"], { fetch: api().fetch });
    expect(r.code).toBe(0);
    expect(stateOf().access).toBeUndefined();
  });
  it("a failed deploy keeps Access on", async () => {
    await go(["access", "--domain", DOMAIN], { fetch: api().fetch });
    deployFails = true;
    order = [];
    const r = await go(["access", "--off"], { fetch: api().fetch });
    expect(r.code).toBe(1);
    expect(stateOf().access.domain).toBe(DOMAIN);
    expect(order).toEqual([]);
  });
});

describe("wrangler.jsonc render", () => {
  const cfg = validateConfig(
    parseJsonc(defaultConfigText({ name: "oc-x", inst: "a1b2c3", accountId: ACCT })),
  );
  const o = { accountId: ACCT, url: "https://oc-x.example.workers.dev", source: SOURCE };
  it("adds the custom domain route and ACCESS_* vars only when Access is on", () => {
    const off = JSON.parse(renderWranglerJsonc(cfg, o).split("\n").slice(1).join("\n"));
    expect(off.routes).toBeUndefined();
    expect(off.vars.ACCESS_AUD).toBeUndefined();
    const on = JSON.parse(
      renderWranglerJsonc(cfg, {
        ...o,
        access: { domain: DOMAIN, team: TEAM, aud: "aud-1", workersDev: "ops" },
      })
        .split("\n")
        .slice(1)
        .join("\n"),
    );
    expect(on.routes).toEqual([{ pattern: DOMAIN, custom_domain: true }]);
    expect(on.vars).toMatchObject({
      ACCESS_TEAM: TEAM,
      ACCESS_AUD: "aud-1",
      ACCESS_DOMAIN: DOMAIN,
      ACCESS_WORKERS_DEV: "ops",
    });
    expect(on.workers_dev).toBe(true);
    // the Telegram webhook origin stays workers.dev
    expect(JSON.parse(on.vars.OC_SETTINGS).publicOrigin).toBe(o.url);
  });
});
