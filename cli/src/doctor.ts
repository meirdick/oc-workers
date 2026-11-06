// ochost doctor (docs/10-cli-spec.md §1.2, addendum §5.2). PASS/FAIL/WARN per check with a fix line. A thin client:
// GET /ops/doctor is the same JSON the owner panel shows (worker/src/ctl/panel.ts), so the CLI and the page agree.
// The Worker runs the checks (gate hop, Telegram getWebhookInfo, replica, archive, alerts) and never wakes the install;
// `fresh=1` lets the probes run while it sleeps. Only the opt-in direct gateway hop (--ai-token-file) runs here.

import type { Check, Result } from "../../worker/src/ctl/panel-checks.ts";
import { fail, gatewayOf, managedWebhook, pass, warn } from "../../worker/src/ctl/panel-checks.ts";
import { DEFAULT_GATEWAY, hop, NO_GATEWAY } from "./ai-gateway.ts";
import {
  EXIT,
  type FlagSpec,
  flagStr,
  type OpsCtx,
  opsClient,
  readHostConfig,
  registerSecret,
  table,
} from "./ops-lib.ts";
import { readTokenFile } from "./secrets.ts";

export const doctorFlags: FlagSpec = { "ai-token-file": { type: "string" } };

export type { Check, Result };
export { gatewayOf, managedWebhook };

/** Opt-in (--ai-token-file or OC_CF_AI_TOKEN): the same call straight to the gateway, as the old flow made it. */
async function checkDirectHop(ctx: OpsCtx, doc: any): Promise<Check | null> {
  const tf = flagStr(ctx.args, "ai-token-file");
  let token = ctx.env.OC_CF_AI_TOKEN?.trim() ?? "";
  if (!tf && !token) return null;
  const gw = gatewayOf(doc);
  const model = gw?.model || readHostConfig(ctx.dir)?.llm?.primary || "";
  const gateway = readHostConfig(ctx.dir)?.llm?.gateway ?? DEFAULT_GATEWAY;
  if (!model || gateway === NO_GATEWAY)
    return warn(
      "gateway hop",
      "this install runs without a gateway",
      "ochost ai-gateway setup --gateway default",
    );
  if (tf) {
    try {
      token = await readTokenFile(tf, (l) => ctx.out.warn(l));
    } catch {
      return fail("gateway hop", `cannot read ${tf}`, "pass a readable --ai-token-file");
    }
  }
  registerSecret(token);
  const install = opsClient(ctx).install;
  const r = await hop(ctx, {
    acct: install.accountId,
    gateway,
    token,
    model,
    messages: [{ role: "user", content: "Reply with the word pong only." }],
    maxTokens: 256,
    timeoutMs: 30_000,
  });
  if (r.status === 200 && r.content) return pass("gateway hop", `200 in ${r.ms} ms (${model}) direct`);
  if (r.status === 401)
    return fail(
      "gateway hop",
      "401",
      "the token lacks AI Gateway: Run; or rerun without the token (the gate needs none)",
    );
  if (r.status === 404)
    return fail("gateway hop", `404 for ${model}`, "ochost model list, then ochost model set <id>");
  return warn("gateway hop", `${r.status || "no answer"} in ${r.ms} ms`, "rerun in 1 min");
}

/** The panel JSON (worker/src/ctl/panel.ts Panel) as far as the CLI reads it; the rest is passed through to --json. */
interface Doc {
  ok: boolean;
  fails: number;
  warns: number;
  checks: Check[];
  [k: string]: unknown;
}

export async function doctor(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  let body: Doc;
  try {
    body = (await ops.call("GET", "/ops/doctor?fresh=1", undefined, { timeoutMs: 90_000 })).body as Doc;
  } catch (e) {
    if (ctx.out.json) throw e;
    const err = (e as Error).message;
    const checks = [
      fail(
        "reach",
        err.replace(/^Failed: /, "").split(" — fix: ")[0] ?? "",
        err.split(" — fix: ")[1] ?? "ochost status",
      ),
    ];
    return show(ctx, { ok: false, fails: 1, warns: 0, checks });
  }
  const wantsDirect = flagStr(ctx.args, "ai-token-file") || ctx.env.OC_CF_AI_TOKEN?.trim();
  const direct = wantsDirect ? await checkDirectHop(ctx, await configDoc(ops).catch(() => null)) : null;
  if (direct) {
    body.checks = [...body.checks, direct];
    body.fails = body.checks.filter((c) => c.result === "FAIL").length;
    body.warns = body.checks.filter((c) => c.result === "WARN").length;
    body.ok = body.fails === 0;
  }
  return show(ctx, body);
}

function show(ctx: OpsCtx, doc: Doc): number {
  const { checks, fails, warns } = doc;
  if (ctx.out.json) ctx.out.result(doc);
  else {
    ctx.out.line(
      table(
        ["CHECK", "RESULT", "DETAIL"],
        checks.map((c) => [c.name, c.result, c.detail]),
      ),
    );
    const fixes = checks.filter((c) => c.fix);
    if (fixes.length) {
      ctx.out.line("");
      for (const c of fixes) ctx.out.line(`${c.name}: ${c.detail} -> ${c.fix}`);
    }
    ctx.out.line("");
    ctx.out.line(
      `${checks.length} checks: ${checks.length - fails - warns} PASS, ${warns} WARN, ${fails} FAIL`,
    );
  }
  return fails ? EXIT.failed : EXIT.ok;
}

async function configDoc(ops: ReturnType<typeof opsClient>): Promise<any> {
  const v = await ops.call("GET", "/ops/config", undefined, { allow: [200, 404] });
  const versions: any[] = Array.isArray(v.body?.versions) ? v.body.versions : [];
  const newest = versions
    .filter((x) => x.status === "good" || x.status === "candidate")
    .sort((a, b) => b.ver - a.ver)[0];
  if (!newest) return null;
  const r = await ops.call("GET", `/ops/config/${newest.ver}`, undefined, { allow: [200, 404] });
  return r.status === 200 ? (r.body?.doc ?? null) : null;
}
