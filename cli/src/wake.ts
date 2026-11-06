// ochost wake [--timeout 120] (docs/10-cli-spec.md §1.2). Journaled wake: POST /ops/wake?wait=1 long-polls to
// `running` (the Worker waits ≤ 120 s per call). Loops until --timeout, then exit 4 (the wake goes on).
import { CliError, EXIT, type FlagSpec, flagInt, type OpsCtx, opsClient } from "./ops-lib.ts";

export const wakeFlags: FlagSpec = { timeout: { type: "string" } };

/** Seconds a sleeping install needs to answer (oc-demo start→running 37.6 s; spec §2.4 step 12). */
export const WAKE_HINT_S = 45;

export async function wake(ctx: OpsCtx): Promise<number> {
  const budgetMs = flagInt(ctx.args, "timeout", 120, 5, 3600) * 1000;
  const ops = opsClient(ctx);
  const t0 = ctx.now();
  const s0 = await ops.call("GET", "/ops/status");
  if (s0.body?.state === "running") {
    if (ctx.out.json) ctx.out.result({ ok: true, state: "running", waitedMs: 0, already: true });
    else ctx.out.line("running (it was awake)");
    return EXIT.ok;
  }
  ctx.out.step(`waking, about ${WAKE_HINT_S} s`);
  let last: any = null;
  while (ctx.now() - t0 < budgetMs && !ctx.signal?.aborted) {
    const left = budgetMs - (ctx.now() - t0);
    const r = await ops.call("POST", "/ops/wake?wait=1", undefined, {
      timeoutMs: Math.min(left, 130_000) + 5_000,
      allow: [200, 409, 502, 503, 504],
    });
    last = r.body;
    if (r.status === 200 && r.body?.state === "running") {
      const waitedMs = ctx.now() - t0;
      if (ctx.out.json) ctx.out.result({ ok: true, state: "running", waitedMs });
      else ctx.out.line(`running after ${Math.round(waitedMs / 1000)} s`);
      return EXIT.ok;
    }
    if (r.status === 409 && r.body?.error === "no-active-epoch")
      ctx.out.step("provisioning: no active epoch yet");
    else ctx.out.step(`state ${r.body?.state ?? r.status}, ${Math.max(0, Math.round(left / 1000))} s left`);
    // A 200 without `running` (ensure on a new install, or no epoch to poll) answers at once: wait a bit.
    if (r.status !== 504) await ctx.sleep(5000);
  }
  if (ctx.signal?.aborted) return EXIT.interrupted;
  throw new CliError(
    `the install did not reach running in ${Math.round(budgetMs / 1000)} s (last: ${last?.state ?? last?.error ?? "unknown"})`,
    "the wake goes on; ochost status, or ochost wake --timeout 600",
    EXIT.budget,
  );
}
