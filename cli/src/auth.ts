// ochost auth rotate|sessions|access (docs/10-cli-spec.md §1.2, §2.3).
// rotate --control: new CONTROL_TOKEN as a Worker secret (wrangler; the old token is dead once the new version
//   is live), then .oc-host/control-token (0600). The new token is written to control-token.new first, so a
//   failed run never loses it.
// rotate --cookie: POST /ops/auth/rotate (new cookie key, every owner session ends).
// rotate --webhook: not built (needs a Worker route for the dual-secret window; gap W10).
// access --domain <host> | --off: opt-in Cloudflare Access front door (access.ts).
// sessions [--revoke <id>|--revoke-all]: GET /ops/auth/sessions, POST /ops/auth/revoke {id}.
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { access } from "./access.ts";
import {
  CliError,
  confirm,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  fmtAgo,
  type OpsCtx,
  opsClient,
  putSecret,
  randomHex,
  registerSecret,
  STATE_DIR,
  table,
  usage,
} from "./ops-lib.ts";

export const authFlags: FlagSpec = {
  control: { type: "boolean" },
  cookie: { type: "boolean" },
  webhook: { type: "boolean" },
  all: { type: "boolean" },
  revoke: { type: "string" },
  "revoke-all": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  // auth access (access.ts)
  domain: { type: "string" },
  "idp-hint": { type: "string" },
  email: { type: "string" },
  "token-file": { type: "string" },
  "workers-dev": { type: "string" },
  team: { type: "string" },
  aud: { type: "string" },
  off: { type: "boolean" },
};

export async function auth(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0];
  if (sub === "rotate") return rotate(ctx);
  if (sub === "sessions") return sessions(ctx);
  if (sub === "access") return access(ctx);
  throw usage(`unknown auth command ${sub ?? ""}`.trim(), "use ochost auth rotate|sessions|access");
}

async function rotate(ctx: OpsCtx): Promise<number> {
  const all = flagBool(ctx.args, "all");
  const want = {
    control: all || flagBool(ctx.args, "control"),
    cookie: all || flagBool(ctx.args, "cookie"),
    webhook: flagBool(ctx.args, "webhook"),
  };
  if (!want.control && !want.cookie && !want.webhook)
    throw usage("auth rotate needs what to rotate", "pass --control, --cookie, --webhook or --all");
  if (want.webhook)
    throw new CliError(
      "webhook secret rotation is not built yet (W10: the Worker needs the dual-secret route)",
      "rotate --control or --cookie now; the webhook secret stays valid",
    );
  const ops = opsClient(ctx);
  const done: Record<string, unknown> = {};
  if (want.cookie) {
    if (!(await confirm(ctx, "Every browser session ends. Go on?", "yes"))) return EXIT.failed;
    const r = await ops.call("POST", "/ops/auth/rotate");
    done.cookie = r.body ?? { ok: true };
    ctx.out.step("cookie key rotated; every owner session ended");
  }
  if (want.control) {
    const next = randomHex(32);
    registerSecret(next);
    const dir = join(ctx.dir, STATE_DIR);
    const tmp = join(dir, "control-token.new");
    writeFileSync(tmp, `${next}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    ctx.out.step("setting CONTROL_TOKEN on the Worker (wrangler)");
    await putSecret(ctx, ops.install, "CONTROL_TOKEN", next);
    // The secret change deploys a new Worker version; wait until it takes the new token.
    const t0 = ctx.now();
    const fresh = opsClient(ctx, { ...ops.install, token: next });
    let live = false;
    while (ctx.now() - t0 < 60_000) {
      const r = await fresh.call("GET", "/ops/status", undefined, { allow: [200, 404] }).catch(() => null);
      if (r?.status === 200) {
        live = true;
        break;
      }
      await ctx.sleep(2000);
    }
    renameSync(tmp, join(dir, "control-token"));
    done.control = { ok: true, live, waitedMs: ctx.now() - t0 };
    if (!live)
      ctx.out.warn("the Worker did not take the new token in 60 s — fix: wait 1 min, then ochost status");
    ctx.out.step("CONTROL_TOKEN rotated; the old token is dead");
  }
  if (ctx.out.json) ctx.out.result({ ok: true, ...done });
  else ctx.out.line(`rotated: ${Object.keys(done).join(", ")}`);
  return EXIT.ok;
}

interface Session {
  id: string;
  createdAt?: number;
  lastSeen?: number;
  userAgent?: string;
  ip?: string;
  via?: string;
}

async function sessions(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const revoke = flagStr(ctx.args, "revoke");
  const list = async (): Promise<Session[]> => {
    const b = (await ops.call("GET", "/ops/auth/sessions")).body;
    return Array.isArray(b?.sessions) ? b.sessions : [];
  };
  if (revoke) {
    await ops.call("POST", "/ops/auth/revoke", { id: revoke });
    if (ctx.out.json) ctx.out.result({ ok: true, revoked: [revoke] });
    else ctx.out.line(`revoked ${revoke}`);
    return EXIT.ok;
  }
  if (flagBool(ctx.args, "revoke-all")) {
    const ss = await list();
    for (const s of ss) await ops.call("POST", "/ops/auth/revoke", { id: s.id });
    if (ctx.out.json) ctx.out.result({ ok: true, revoked: ss.map((s) => s.id) });
    else ctx.out.line(`revoked ${ss.length} session(s)`);
    return EXIT.ok;
  }
  const ss = await list();
  const now = ctx.now();
  if (ctx.out.json) ctx.out.result({ ok: true, sessions: ss });
  else
    ctx.out.line(
      ss.length
        ? table(
            ["ID", "CREATED", "LAST SEEN", "VIA", "USER AGENT"],
            ss.map((s) => [
              s.id,
              fmtAgo(s.createdAt, now),
              fmtAgo(s.lastSeen, now),
              s.via ?? "-",
              String(s.userAgent ?? "-").slice(0, 60),
            ]),
          )
        : "no owner sessions",
    );
  return EXIT.ok;
}
