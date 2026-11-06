// ochost restart [--hard] [--timeout 300] (docs/10-cli-spec.md §1.2). POST /ops/restart = planned stop + start
// (spec 08 §19.2: always ends `running`). Then polls GET /ops/status to `running`; budget → exit 4.
// --hard asks y/N. gap W9: the Worker has no hard stop yet; it gets {hard:true} and runs the planned restart.
import {
  CliError,
  confirm,
  EXIT,
  type FlagSpec,
  flagBool,
  flagInt,
  type OpsCtx,
  opsClient,
  RESTART_CALL_MS,
} from "./ops-lib.ts";

export const restartFlags: FlagSpec = {
  hard: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  timeout: { type: "string" },
  "no-wait": { type: "boolean" },
};

export async function restart(ctx: OpsCtx): Promise<number> {
  const hard = flagBool(ctx.args, "hard");
  const budgetMs = flagInt(ctx.args, "timeout", 300, 5, 3600) * 1000;
  const ops = opsClient(ctx);
  if (
    hard &&
    !(await confirm(ctx, "Hard restart skips the sleep flush; recent writes can be lost. Go on?", "yes"))
  ) {
    ctx.out.line("cancelled");
    return EXIT.failed;
  }
  const t0 = ctx.now();
  const r = await ops.call("POST", "/ops/restart", hard ? { hard: true } : undefined, {
    timeoutMs: RESTART_CALL_MS,
    allow: [200, 409],
  });
  if (r.status === 409)
    throw new CliError(
      `${r.body?.error ?? "restart refused"}; the new deploy boots from the newest archive, so the restart did not run`,
      "ochost restart again in a few minutes (ochost backup lists archives); ochost restart --hard skips the archive and loses writes since the last one",
    );
  if (hard)
    ctx.out.warn("the Worker has no hard stop yet (W9), so it ran a planned restart — fix: none needed");
  if (r.body?.start && r.body.start.ok === false)
    throw new CliError(
      `start after stop refused (state ${r.body.start.state})`,
      "ochost status; ochost logs --source rt",
    );
  // The Worker saw a deploy since the Runtime DO was built: the stop is followed by a boot of the newest image (N8).
  if (r.body?.redeploy)
    ctx.out.line(
      `new deploy: ${
        r.body.archive === "taken" || r.body.archive === "fresh"
          ? "workspace archive is current"
          : `archive ${r.body.archive ?? "skipped"}`
      }; stopping, then booting the newest image (image path, new gen, Doctor); a few minutes`,
    );
  ctx.out.step("restarting");
  if (flagBool(ctx.args, "no-wait")) {
    if (ctx.out.json) ctx.out.result({ ok: true, waited: false, restart: r.body });
    return EXIT.ok;
  }
  let state = "";
  while (ctx.now() - t0 < budgetMs && !ctx.signal?.aborted) {
    await ctx.sleep(3000);
    const s = await ops.call("GET", "/ops/status", undefined, { allow: [200, 500, 502, 503] });
    state = String(s.body?.state ?? s.status);
    if (state === "running") {
      const waitedMs = ctx.now() - t0;
      if (ctx.out.json) ctx.out.result({ ok: true, state, waitedMs });
      else ctx.out.line(`running after ${Math.round(waitedMs / 1000)} s`);
      return EXIT.ok;
    }
  }
  if (ctx.signal?.aborted) return EXIT.interrupted;
  throw new CliError(
    `not running ${Math.round(budgetMs / 1000)} s after the restart (state ${state || "unknown"})`,
    "the start goes on; ochost status; ochost logs --source rt",
    EXIT.budget,
  );
}
