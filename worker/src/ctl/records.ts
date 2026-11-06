// Replica records live in the gates' ledger (src/gates/ledger.ts runs inside the Control DO on these tables).
// The Control DO side only reads the day tier for the boot plan (spec §8.3 `replica.tier`, §18.6).
import type { Tier } from "../core/contract";
import { type Ctx, utcDay } from "./ctx";

/** Tier for today (resets at 00:00 UTC), as the ledger last wrote it. */
export function latestTier(c: Ctx): Tier {
  const t = c.db.one<{ tier: Tier }>("SELECT tier FROM budget_day WHERE day = ?", utcDay(c.now()))?.tier;
  return t === "slow" || t === "slower" ? t : "normal";
}
