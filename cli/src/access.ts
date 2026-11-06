// ochost auth access --domain <host> [--idp-hint id] [--email e] [--token-file f] [--workers-dev ops|webhooks]
// ochost auth access --off          (docs/15-access.md; opt-in Cloudflare Access front door)
// on:  zone check, Access app + allow policy for the owner's email (Cloudflare API), state.access, Worker redeploy
//      (custom_domain route + ACCESS_* vars), a planned restart when running (the gateway takes the custom domain
//      as gateway.publicOrigin at boot), then fetch the hostname and expect the Access login redirect.
// off: redeploy without the route and vars first (the custom domain is then closed), restart when running (origin
//      back to workers.dev), then delete the Access app.
// The wrangler OAuth login may lack Access scopes: --token-file takes an API token (Account: Access: Apps and
// Policies Edit; Zone: Zone Read). Without either, the exact dashboard steps are printed (exit 3), and
// `--team <t> --aud <a>` finishes the install from them.
import { readFileSync } from "node:fs";
import { applyChange } from "./cmd-util.ts";
import { loadConfig } from "./config.ts";
import { type AccessState, deployProject, projectPaths, readState, writeState } from "./deploy.ts";
import { open } from "./open.ts";
import {
  CliError,
  EXIT,
  flagBool,
  flagStr,
  type Install,
  loadInstall,
  type OpsCtx,
  opsClient,
  registerSecret,
  usage,
} from "./ops-lib.ts";
import { expandHome, tokenFromText } from "./ui.ts";
import { deployCtx } from "./upgrade.ts";
import { type CfClient, cfErrText, makeCf, makeWrangler, parseWhoami, wranglerBearer } from "./wrangler.ts";

export interface AccessHooks {
  /** Render and deploy the Worker (no pre-upgrade archive: the image does not change). */
  deploy(ctx: OpsCtx, install: Install): Promise<void>;
  /** The Control UI origin changed: planned restart when running; asleep → the next wake applies it. */
  restart(ctx: OpsCtx): Promise<string>;
  /** Does the Control DO report Access on this domain yet (GET /ops/doctor)? Tests answer at once. */
  accessSeen?(ctx: OpsCtx, domain: string): Promise<boolean>;
}

export const realAccessHooks: AccessHooks = {
  async deploy(ctx, install) {
    const p = projectPaths(ctx.dir);
    const uiCtx = deployCtx(ctx);
    const state = await readState(p);
    await deployProject(uiCtx, {
      config: await loadConfig(p.config),
      accountId: install.accountId,
      url: install.url,
      send: {},
      fakeTelegram: state.fakeTelegram,
    });
  },
  restart: (ctx) => applyChange(ctx, opsClient(ctx), true),
};

/** A failed restart does not undo the deploy: say how to finish it. */
async function restartFor(ctx: OpsCtx, hooks: AccessHooks): Promise<string> {
  try {
    return await hooks.restart(ctx);
  } catch (e) {
    ctx.out.warn(
      `restart failed (${(e as Error).message.slice(0, 80)}) — fix: ochost restart, so the gateway takes the new origin`,
    );
    return "failed";
  }
}

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const POLICY_NAME = "oc-host owner";
const ok = (r: { status: number; j: { success?: boolean } }) =>
  r.status >= 200 && r.status < 300 && r.j.success !== false;

interface App {
  id: string;
  aud: string;
  domain?: string;
}

export async function access(ctx: OpsCtx, hooks: AccessHooks = realAccessHooks): Promise<number> {
  if (flagBool(ctx.args, "off")) return off(ctx, hooks);
  const raw = flagStr(ctx.args, "domain");
  const install = loadInstall(ctx);
  const paths = projectPaths(ctx.dir);
  if (!raw) {
    const cur = (await readState(paths)).access;
    if (!cur) throw usage("auth access needs --domain <host>", "ochost auth access --domain oc.example.com");
    return status(ctx, cur);
  }
  const domain = raw.toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(domain))
    throw usage(`${JSON.stringify(raw)} is not a hostname`, "pass a host on your zone, e.g. oc.example.com");
  const workersDev = flagStr(ctx.args, "workers-dev") ?? "ops";
  if (workersDev !== "ops" && workersDev !== "webhooks")
    throw usage("--workers-dev must be ops or webhooks", "ops keeps /ops and webhooks on workers.dev");
  const idpHint = flagStr(ctx.args, "idp-hint");
  const w = makeWrangler(ctx.run, { accountId: install.accountId });

  const email = flagStr(ctx.args, "email") ?? parseWhoami((await w.run(["whoami", "--json"])).stdout).email;
  if (!email) throw usage("no owner email (wrangler is not logged in)", "pass --email <you@example.com>");

  let team = flagStr(ctx.args, "team")
    ?.replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  let app: { id?: string; aud: string; policyId?: string } | undefined;
  const aud = flagStr(ctx.args, "aud");
  if (team && aud) app = { aud };
  else if (aud || (team && !flagStr(ctx.args, "token-file")))
    throw usage("--team and --aud go together", "pass both, from the dashboard app");
  else {
    const tokenFile = flagStr(ctx.args, "token-file");
    let bearer: string | undefined;
    if (tokenFile) {
      try {
        bearer = tokenFromText(readFileSync(expandHome(tokenFile), "utf8"), [
          "CF_ACCESS_TOKEN",
          "CLOUDFLARE_API_TOKEN",
        ]);
      } catch {
        throw new CliError(`cannot read ${tokenFile}`, "pass --token-file <file with the API token>");
      }
      registerSecret(bearer);
    } else bearer = await wranglerBearer(w);
    if (!bearer) throw manual(domain, email, "wrangler has no login");
    const cf = makeCf(ctx.fetch, bearer, ctx.sleep);
    await zoneCheck(ctx, cf, install.accountId, domain);
    const org = await cf.call<{ auth_domain?: string }>(
      "GET",
      `/accounts/${install.accountId}/access/organizations`,
    );
    // A token with Apps and Policies only cannot read the org: --team names it.
    const noOrgScope = org.status === 401 || org.status === 403;
    if (noOrgScope && !team && tokenFile)
      throw new CliError(
        "the token can edit Access apps but cannot read the Zero Trust organization, so the team name is unknown",
        "rerun with --team <team>.cloudflareaccess.com (Zero Trust > Settings > Custom Pages shows it), or add Access: Organizations Read to the token",
        EXIT.manual,
      );
    if (noOrgScope && !team) throw manual(domain, email, "this login has no Access scope");
    team = team ?? org.j.result?.auth_domain;
    if ((!ok(org) && !noOrgScope) || !team)
      throw new CliError(
        `Zero Trust is not set up on this account (${cfErrText(org.j) || `HTTP ${org.status}`})`,
        "open https://one.dash.cloudflare.com, pick a team name and the Free plan, then rerun",
        EXIT.manual,
      );
    ctx.out.step(`access: team ${team}`);
    app = await ensureApp(ctx, cf, install, { domain, email, idpHint });
  }
  const next: AccessState = {
    domain,
    team: team as string,
    aud: app.aud,
    appId: app.id,
    policyId: app.policyId,
    email,
    idpHint,
    workersDev,
  };
  const state = await readState(paths);
  await writeState(paths, { ...state, access: next });
  ctx.out.step("access: redeploying the Worker with the custom domain and Access vars");
  try {
    await hooks.deploy(ctx, install);
  } catch (e) {
    await writeState(paths, state);
    throw e;
  }
  await waitForDo(ctx, hooks, next.domain);
  await restartFor(ctx, hooks);
  return verify(ctx, next);
}

/**
 * A deploy changes the Worker at once, but the Control DO that builds the boot plan picks up new code and vars up to
 * 5 min later. A restart before that boots the gateway with the old origin ("Browser origin not allowed" in the
 * Control UI). Wait until the DO reports the domain, up to 6 min.
 */
async function waitForDo(ctx: OpsCtx, hooks: AccessHooks, domain: string): Promise<void> {
  const seen = hooks.accessSeen ?? realAccessSeen;
  for (let i = 0; i < 36; i++) {
    if (await seen(ctx, domain)) return;
    if (i === 0) ctx.out.step("access: waiting for the Control DO to see the new domain (up to 5 min)");
    await ctx.sleep(10_000);
  }
  ctx.out.warn("the Control DO has not seen the domain yet — fix: ochost restart in a few minutes");
}

async function realAccessSeen(ctx: OpsCtx, domain: string): Promise<boolean> {
  try {
    const r = await opsClient(ctx).call("GET", "/ops/doctor", undefined, { timeoutMs: 30_000 });
    const rows = (r.body as { connected?: { name: string; detail?: string }[] }).connected ?? [];
    return rows.some((x) => x.name === "access" && (x.detail ?? "").includes(domain));
  } catch {
    return false;
  }
}

function manual(domain: string, email: string, why: string): CliError {
  const lines = [
    `${why}. Do this in the dashboard (or rerun with --token-file <file>; the API token needs Account > Access: Apps and Policies > Edit and Zone > Zone > Read):`,
    "  1. https://one.dash.cloudflare.com > Access > Applications > Add an application > Self-hosted.",
    `  2. Application domain: ${domain} (no path). Session duration: 24 hours.`,
    `  3. Policy: action Allow, include Emails ${email}. No Everyone rule, no other includes.`,
    "  4. Save. Copy the Application Audience (AUD) tag from the app's Overview.",
    "  5. Team domain: Settings > Custom Pages, or the host in the login page URL (<team>.cloudflareaccess.com).",
    `  6. ochost auth access --domain ${domain} --team <team>.cloudflareaccess.com --aud <AUD>`,
  ];
  return new CliError(lines.join("\n"), "follow the steps above", EXIT.manual);
}

/** The domain must be on a zone of this account; a token without Zone Read skips the check (wrangler checks later). */
async function zoneCheck(ctx: OpsCtx, cf: CfClient, accountId: string, domain: string): Promise<void> {
  const r = await cf.call<{ name: string }[]>("GET", `/zones?account.id=${accountId}&per_page=50`);
  if (!ok(r)) {
    ctx.out.warn("could not list zones (token has no Zone Read); skipping the zone check");
    return;
  }
  const names = (r.j.result ?? []).map((z) => z.name);
  if (!names.some((n) => domain === n || domain.endsWith(`.${n}`)))
    throw new CliError(
      `${domain} is not on a zone of this account (zones: ${names.join(", ") || "none"})`,
      "add the zone to Cloudflare first, or pick a host on one of those zones",
    );
}

async function ensureApp(
  ctx: OpsCtx,
  cf: CfClient,
  install: Install,
  o: { domain: string; email: string; idpHint?: string },
): Promise<{ id: string; aud: string; policyId?: string }> {
  const base = `/accounts/${install.accountId}/access/apps`;
  const list = await cf.call<App[]>("GET", `${base}?per_page=100`);
  if (list.status === 401 || list.status === 403)
    throw manual(o.domain, o.email, "this token has no Access scope");
  if (!ok(list))
    throw new CliError(`could not list Access apps (${cfErrText(list.j) || `HTTP ${list.status}`})`, "rerun");
  const body = {
    name: `oc-host ${install.name}`,
    type: "self_hosted",
    domain: o.domain,
    session_duration: "24h",
    app_launcher_visible: false,
    ...(o.idpHint ? { allowed_idps: [o.idpHint], auto_redirect_to_identity: true } : {}),
  };
  const have = (list.j.result ?? []).find((a) => a.domain?.toLowerCase() === o.domain);
  const r = have
    ? await cf.call<App>("PUT", `${base}/${have.id}`, body)
    : await cf.call<App>("POST", base, body);
  if (r.status === 401 || r.status === 403) throw manual(o.domain, o.email, "this token has no Access scope");
  const app = r.j.result;
  if (!ok(r) || !app?.id || !app.aud)
    throw new CliError(
      `could not ${have ? "update" : "create"} the Access app (${cfErrText(r.j) || `HTTP ${r.status}`})`,
      "rerun",
    );
  ctx.out.step(`access: app ${have ? "updated" : "created"} for ${o.domain}`);
  const pBase = `${base}/${app.id}/policies`;
  const pol = await cf.call<{ id: string; name: string }[]>("GET", pBase);
  const mine = (pol.j.result ?? []).find((p) => p.name === POLICY_NAME);
  const polBody = {
    name: POLICY_NAME,
    decision: "allow",
    include: [{ email: { email: o.email } }],
    precedence: 1,
  };
  const pr = mine
    ? await cf.call<{ id: string }>("PUT", `${pBase}/${mine.id}`, polBody)
    : await cf.call<{ id: string }>("POST", pBase, polBody);
  if (!ok(pr))
    throw new CliError(
      `could not set the allow policy (${cfErrText(pr.j) || `HTTP ${pr.status}`})`,
      "rerun; the app exists and denies everyone until a policy is set",
    );
  ctx.out.step(`access: allow policy for ${o.email}`);
  return { id: app.id, aud: app.aud, policyId: pr.j.result?.id };
}

/** Fetch the hostname; Access answers a request without a session with a redirect to the team login. */
async function verify(ctx: OpsCtx, a: AccessState): Promise<number> {
  let seen = "no answer";
  for (let i = 0; i < 12; i++) {
    try {
      const r = await ctx.fetch(`https://${a.domain}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const loc = r.headers.get("location") ?? "";
      if (
        [301, 302, 303, 307].includes(r.status) &&
        (loc.includes(a.team) || loc.includes("/cdn-cgi/access/"))
      ) {
        done(ctx, a, true);
        if (!ctx.out.json) await loginLink(ctx);
        return EXIT.ok;
      }
      seen = `HTTP ${r.status}${loc ? ` to ${loc.slice(0, 80)}` : ""}`;
    } catch (e) {
      seen = `fetch failed (${(e as Error).message.slice(0, 60)})`;
    }
    if (i < 11) await ctx.sleep(5000);
  }
  done(ctx, a, false);
  throw new CliError(
    `https://${a.domain}/ did not redirect to the Access login: ${seen}`,
    "DNS and the certificate can take a few minutes; rerun the same command (it only verifies), then open the URL in a browser",
  );
}

function done(ctx: OpsCtx, a: AccessState, verified: boolean) {
  if (ctx.out.json) ctx.out.result({ ok: verified, access: { ...a, verified } });
  else
    ctx.out.line(
      [
        `${verified ? "access on" : "access set, not verified"}: https://${a.domain}`,
        `team ${a.team}; allow ${a.email ?? "(dashboard policy)"}; workers.dev: ${a.workersDev === "ops" ? "webhooks and /ops" : "webhooks only"}`,
      ].join("\n"),
    );
}

/** After Access is on: a single-use login link (through Access, then the owner cookie), like `ochost open`. */
async function loginLink(ctx: OpsCtx): Promise<void> {
  try {
    ctx.out.line("login link (single use, 5 min; ochost open makes another):");
    await open(ctx);
  } catch (e) {
    ctx.out.warn(`no login link: ${(e as Error).message.slice(0, 80)} — fix: ochost open`);
  }
}

function status(ctx: OpsCtx, a: AccessState): number {
  if (ctx.out.json) ctx.out.result({ ok: true, access: a });
  else
    ctx.out.line(
      `access on: https://${a.domain} (team ${a.team}, allow ${a.email ?? "?"}, workers.dev ${a.workersDev})`,
    );
  return EXIT.ok;
}

async function off(ctx: OpsCtx, hooks: AccessHooks): Promise<number> {
  const install = loadInstall(ctx);
  const paths = projectPaths(ctx.dir);
  const state = await readState(paths);
  const cur = state.access;
  if (!cur) {
    if (ctx.out.json) ctx.out.result({ ok: true, access: null });
    else ctx.out.line("access is not on");
    return EXIT.ok;
  }
  // Worker first: it stops serving the custom domain. Then the app goes. A failed deploy leaves everything as is.
  const { access: _a, ...rest } = state;
  await writeState(paths, rest);
  ctx.out.step("access: redeploying the Worker without the custom domain");
  try {
    await hooks.deploy(ctx, install);
  } catch (e) {
    await writeState(paths, state);
    throw e;
  }
  await restartFor(ctx, hooks);
  let deleted = false;
  if (cur.appId) {
    const tokenFile = flagStr(ctx.args, "token-file");
    const w = makeWrangler(ctx.run, { accountId: install.accountId });
    let bearer: string | undefined;
    if (tokenFile) {
      try {
        bearer = readFileSync(tokenFile, "utf8").trim();
        registerSecret(bearer);
      } catch {}
    } else bearer = await wranglerBearer(w);
    if (bearer) {
      const r = await makeCf(ctx.fetch, bearer, ctx.sleep).call(
        "DELETE",
        `/accounts/${install.accountId}/access/apps/${cur.appId}`,
      );
      deleted = ok(r) || r.status === 404;
    }
  }
  if (ctx.out.json) ctx.out.result({ ok: true, access: null, appDeleted: deleted });
  else
    ctx.out.line(
      `access off; ${cur.domain} no longer routes to the Worker${deleted ? "; Access app deleted" : ""}`,
    );
  if (!deleted)
    ctx.out.warn(
      `the Access app for ${cur.domain} was not deleted — fix: Zero Trust > Access > Applications, delete it (or rerun with --token-file)`,
    );
  return EXIT.ok;
}
