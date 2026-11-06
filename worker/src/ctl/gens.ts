// Gen table and the generation fence (spec §6.2, §8.2, §13.1-§13.3), install marker (§6.6).
import { randomHex, sha256Hex } from "../core/ids";
import type { BeginBootArgs, BeginBootResult, BootPlan, Mode } from "../core/types";
import { imageDigestOf } from "../core/version";
import { alert, resolveAlert } from "./alerts";
import { rebaseAtWake } from "./chain";
import { configMarkGood } from "./config";
import { maxCredSeq } from "./creds";
import { type Ctx, ring, STATE_DB, utcDay } from "./ctx";
import { deferDigest } from "./digest";
import { epochRow } from "./epochs";
import { heldToPending } from "./inbox";
import { buildPlan, type FreshFacts } from "./plan";
import { snapshotRestored, supersedeNewerThan } from "./snapshots";
import { j, pj } from "./sql";

export type GenState = "booting" | "complete" | "verified" | "bad" | "abandoned" | "deleted";
export interface GenRow {
  gen: number;
  epoch: number;
  op_id: string;
  reason: string;
  mode: Mode;
  image_key: string | null;
  digest: string | null;
  state_schema: number | null;
  agent_schema: number | null;
  secret: string;
  iid: string | null;
  restore_gens: string;
  plan: string;
  plan_kind: string;
  state: GenState;
  unplanned: number;
  issued_at: number;
  bound_at: number | null;
  complete_at: number | null;
  started_at: number | null;
  verified_at: number | null;
  pinned_until: number | null;
  ended_at: number | null;
}

export const installedKey = (inst: string) => `meta/${inst}/installed`;
export const hwmKey = (inst: string) => `meta/${inst}/hwm`;
const UNPLANNED = /^(ladder|auto-restart|replace)/;

export function genRow(c: Ctx, gen: number): GenRow | null {
  return c.db.one<GenRow>("SELECT * FROM gens WHERE gen = ?", gen);
}

/** The epoch's current gen (§13.2), mirrored at beginBoot. */
export function currentGen(c: Ctx, epoch: number): number | null {
  const v = c.db.meta(`cur:${epoch}`);
  return v === null ? null : Number(v);
}

/** R2 facts for the `fresh` rule (Z2.2). Any R2 error → `error`. */
export async function freshFacts(c: Ctx): Promise<FreshFacts> {
  try {
    const installed = !!(await c.bucket.head(installedKey(c.inst)));
    const a = await c.bucket.list({ prefix: `a/${c.inst}/`, limit: 1 });
    const gens = new Set<number>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await c.bucket.list({ prefix: `r/${c.inst}/`, cursor, limit: 1000 });
      for (const o of r.objects) {
        const m = /^r\/[^/]+\/g(\d+)\//.exec(o.key);
        if (m) gens.add(Number(m[1]));
      }
      if (!r.truncated) break;
      cursor = r.cursor;
    }
    return { installed, archives: a.objects.length > 0, r2Gens: [...gens] };
  } catch (e) {
    return { installed: false, archives: false, r2Gens: [], error: String(e).slice(0, 200) };
  }
}

function rebaseDue(c: Ctx, a: BeginBootArgs): boolean {
  if (a.mode !== "prod" || (a.ladder ?? 1) !== 1 || a.replan || !String(a.reason ?? "").startsWith("wake:"))
    return false;
  if (c.db.metaNum("initialized", 0) !== 1) return false;
  // Chain bound (ctl/chain.ts): marked by the last sleep, or a maintenance wake with the policy due.
  return rebaseAtWake(c, String(a.reason));
}

function resultOf(g: GenRow): BeginBootResult {
  const plan = pj<BootPlan>(g.plan, {} as BootPlan);
  return {
    gen: g.gen,
    secret: g.secret,
    restoreGens: pj<number[]>(g.restore_gens, []),
    plan,
    digest: g.digest ?? "",
    imageKey: g.image_key ?? "",
    snapshotId: plan.rootfs?.snapshotId,
    markerId: plan.sqlite?.kind === "marker" ? plan.sqlite.markerId : undefined,
  };
}

/**
 * ctl.beginBoot (§8.2). Idempotent by opId: a gen with this op, state booting and no iid is returned again
 * (with `replan`, the plan is recomputed in the same row). Else a new gen = genCounter + 1, written to the R2
 * hwm before it is returned; an hwm write error turns the plan into restore-blocked:infra.
 */
export async function beginBoot(c: Ctx, a: BeginBootArgs): Promise<BeginBootResult> {
  const ep0 = epochRow(c, a.epoch);
  if (!ep0) return { error: "no-epoch" } as BeginBootResult;
  // O1: the epoch digest follows the deployed image map. A change forces the image path: §8.3 step 3 takes
  // only snapshots with digest == epoch digest, and Doctor runs (lastDoctorDigest differs).
  const live = imageDigestOf(a.liveImages?.[ep0.image_key]);
  // F1: keep the old digest (snapshot path) until an archive with the workspace exists (ctl/digest.ts).
  const deferred =
    !!live && live !== ep0.digest && ep0.status === "active" && deferDigest(c, ep0.digest, live);
  if (live && live !== ep0.digest && ep0.status === "active" && !deferred) {
    c.db.run("UPDATE epochs SET digest = ? WHERE n = ?", live, ep0.n);
    c.db.setMeta(`digestChangedAt:${ep0.n}`, c.now());
    ring(c, "epoch", "digest-change", { n: ep0.n, from: ep0.digest, to: live });
  }
  const ep = live && live !== ep0.digest && !deferred ? (epochRow(c, a.epoch) ?? ep0) : ep0;
  if (a.mode === "prod" && ep.status !== "active") return { error: "epoch-not-active" } as BeginBootResult;
  const prior = c.db.one<GenRow>("SELECT * FROM gens WHERE op_id = ?", a.opId);
  if (prior && !(a.replan && prior.state === "booting" && !prior.iid)) return resultOf(prior);
  const facts = c.db.metaNum("initialized", 0) === 1 ? null : await freshFacts(c);
  // Rebase (add §2.8, ctl/chain.ts): a prod L1 wake boots image + newest archive + gen, so the next sleep
  // snapshot is a new chain base.
  if (!a.rebase && rebaseDue(c, a)) {
    a = { ...a, rebase: true };
    c.db.setMeta("lastRebaseAt", c.now());
    ring(c, "gen", "rebase", { opId: a.opId, reason: a.reason });
  }

  const out = c.db.tx(() => {
    const p2 = c.db.one<GenRow>("SELECT * FROM gens WHERE op_id = ?", a.opId);
    if (p2 && !(a.replan && p2.state === "booting" && !p2.iid)) return { res: resultOf(p2), fresh: false };
    const gen = p2 ? p2.gen : c.db.metaNum("genCounter", 0) + 1;
    if (p2) {
      // Replan: a consumed marker of the old plan goes void (§14: quick_check failure or snapshot miss).
      c.db.run(
        "UPDATE markers SET state = 'void', void_reason = 'replan', updated_at = ? WHERE consumed_by_gen = ? AND state = 'consumed'",
        c.now(),
        gen,
      );
    }
    if ((a.ladder ?? 1) !== 1 || a.mode !== "prod")
      c.db.run(
        "UPDATE markers SET state = 'void', void_reason = ?, updated_at = ? WHERE state IN ('pending', 'valid')",
        a.mode !== "prod" ? "mode" : "ladder",
        c.now(),
      );
    const po = buildPlan(c, a, ep, facts);
    if (po.adopt) {
      c.db.setMeta("initialized", 1);
      ring(c, "install", "adopt", { gen });
    }
    const plan: BootPlan = { ...po.plan, gen };
    if (po.supersedeAfter !== undefined) supersedeNewerThan(c, ep.digest, po.supersedeAfter);
    if (po.markerId)
      c.db.run(
        "UPDATE markers SET state = 'consumed', consumed_by_gen = ?, updated_at = ? WHERE id = ? AND state = 'valid'",
        gen,
        c.now(),
        po.markerId,
      );
    const unplanned = UNPLANNED.test(a.reason) ? 1 : 0;
    if (p2) {
      c.db.run(
        "UPDATE gens SET plan = ?, plan_kind = ?, restore_gens = ? WHERE gen = ?",
        j(plan),
        plan.sqlite.kind,
        j(po.restoreGens),
        gen,
      );
      c.db.run("DELETE FROM gendb WHERE gen = ? AND state = 'pending'", gen);
    } else {
      c.db.setMeta("genCounter", gen);
      // Older gens of this epoch that never completed are abandoned: their start op ended (§6.2).
      c.db.run(
        "UPDATE gens SET state = 'abandoned', ended_at = ? WHERE epoch = ? AND state = 'booting' AND gen < ?",
        c.now(),
        a.epoch,
        gen,
      );
      c.db.run(
        `INSERT INTO gens (gen, epoch, op_id, reason, mode, image_key, digest, state_schema, agent_schema, secret,
           restore_gens, plan, plan_kind, state, unplanned, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booting', ?, ?)`,
        gen,
        a.epoch,
        a.opId,
        a.reason,
        a.mode,
        ep.image_key,
        ep.digest,
        c.db.metaJson<{ stateSchema?: number }>(`image:${ep.digest}`, {}).stateSchema ?? null,
        c.db.metaJson<{ agentSchema?: number }>(`image:${ep.digest}`, {}).agentSchema ?? null,
        randomHex(32),
        j(po.restoreGens),
        j(plan),
        plan.sqlite.kind,
        unplanned,
        c.now(),
      );
      const today = utcDay(c.now());
      c.db.run("INSERT INTO budget_day (day) VALUES (?) ON CONFLICT(day) DO NOTHING", today);
      const d = c.db.one<{ day: string; gens_unplanned: number }>(
        "SELECT day, gens_unplanned FROM budget_day WHERE day = ?",
        today,
      ) as { day: string; gens_unplanned: number };
      c.db.run(
        "UPDATE budget_day SET gens = gens + 1, gens_unplanned = gens_unplanned + ? WHERE day = ?",
        unplanned,
        d.day,
      );
      if (unplanned && d.gens_unplanned + 1 > c.settings().gens.churnPerDay)
        alert(c, "gen-churn", "warn", `${d.gens_unplanned + 1} unplanned gens on ${utcDay(c.now())}`);
      // Wake start: held rows become pending; a wake log row opens (§12.2, §16.2).
      heldToPending(c);
      c.db.run("INSERT INTO wake_log (gen, reason, wake_at) VALUES (?, ?, ?)", gen, a.reason, c.now());
    }
    // A fresh plan has no DB list; the state DB always exists, so it is the boot set (gen completes on its
    // first L0, §6.3). Other DBs join through the `replica-set` event or their first record.
    if (plan.sqlite.kind === "fresh")
      c.db.run(
        "INSERT INTO gendb (gen, db, in_boot_set, state) VALUES (?, ?, 1, 'pending') ON CONFLICT DO NOTHING",
        gen,
        STATE_DB,
      );
    for (const d of plan.dbs)
      c.db.run(
        "INSERT INTO gendb (gen, db, in_boot_set, state) VALUES (?, ?, 1, 'pending') ON CONFLICT DO NOTHING",
        gen,
        d.db,
      );
    if (plan.sqlite.kind === "marker" && plan.dbs.some((d) => d.bytes > plan.replica.seedGateMaxBytes))
      c.db.setMeta(`seeding:${gen}`, "1");
    c.db.setMeta(`cur:${a.epoch}`, gen);
    return { res: resultOf(c.db.one<GenRow>("SELECT * FROM gens WHERE gen = ?", gen) as GenRow), fresh: !p2 };
  });
  if (out.fresh || a.replan) {
    try {
      await c.bucket.put(
        hwmKey(c.inst),
        j({ gen: out.res.gen, credsSeq: maxCredSeq(c), epoch: a.epoch, at: c.now() }),
      );
    } catch (e) {
      const plan: BootPlan = {
        ...out.res.plan,
        sqlite: {
          kind: "restore-blocked",
          reason: "restore-blocked:infra",
          detail: `hwm write: ${String(e).slice(0, 120)}`,
        },
      };
      c.db.run("UPDATE gens SET plan = ?, plan_kind = 'restore-blocked' WHERE gen = ?", j(plan), out.res.gen);
      out.res.plan = plan;
    }
  }
  return out.res;
}

/**
 * ctl.onStarted (§8.6): config good on this digest, lastDoctorDigest, initialized + install marker (once, prod),
 * snapshot last_restored_at, wake log startupz, gen started_at. Returns whether the boot used a marker.
 */
export async function onStarted(
  c: Ctx,
  s: { gen: number; doctorRan?: boolean; startupzMs?: number; aliveMs?: number },
): Promise<{ ok: boolean; markerUsed: boolean; error?: string }> {
  const g = genRow(c, s.gen);
  if (!g) return { ok: false, markerUsed: false, error: "no-gen" };
  const plan = pj<BootPlan>(g.plan, {} as BootPlan);
  const lit = g.mode === "prod" && !plan.channelsOff;
  const needMarker = g.mode === "prod" && c.db.metaNum("initialized", 0) === 0;
  c.db.tx(() => {
    c.db.run("UPDATE gens SET started_at = COALESCE(started_at, ?) WHERE gen = ?", c.now(), s.gen);
    configMarkGood(c, plan.configVer ?? null, g.digest ?? "", lit);
    if (s.doctorRan || plan.runDoctor) c.db.setMeta("lastDoctorDigest", g.digest ?? "");
    // The gen started: the start-time alerts are over. doctor-failed only when Doctor ran and passed.
    resolveAlert(c, "upgrade-regression");
    resolveAlert(c, "memwatch-restart");
    resolveAlert(c, "workspace-missing"); // the gateway started, so the attested workspaces are there
    if (s.doctorRan) resolveAlert(c, "doctor-failed");
    // B1: an owner workspace reset is single-use; the boot that carried it has started.
    if (plan.workspace?.acceptLoss) c.db.delMeta("workspaceReset");
    // N1: the PITR boot has started; the l5 op is done (single use).
    const l5 = c.db.metaJson<{ opId?: string; kind?: string; gen?: number } | null>("l5", null);
    if (l5?.kind === "pitr" && plan.sqlite?.kind === "gen" && plan.sqlite.ts && plan.sqlite.gen === l5.gen) {
      c.db.delMeta("l5");
      c.db.setMeta("l5Done", { ...l5, bootGen: s.gen, at: c.now() });
      if (l5.opId)
        c.db.run(
          "UPDATE ops SET state = 'done', phase = 'booted', updated_at = ? WHERE op_id = ? AND state = 'open'",
          c.now(),
          l5.opId,
        );
      ring(c, "l5", "pitr-booted", { opId: l5.opId, gen: s.gen, from: l5.gen, ts: plan.sqlite.ts });
    }
    c.db.delMeta(`doctorRequired:${g.epoch}`);
    if (g.mode === "prod") {
      c.db.setMeta("initialized", 1);
      c.db.setMeta("served", 1);
    }
    if (plan.rootfs?.kind === "snapshot" && plan.rootfs.snapshotId)
      snapshotRestored(c, plan.rootfs.snapshotId);
    c.db.run(
      `UPDATE wake_log SET startupz_ms = COALESCE(?, startupz_ms), alive_ms = COALESCE(?, alive_ms)
       WHERE id = (SELECT MAX(id) FROM wake_log WHERE gen = ?)`,
      s.startupzMs ?? null,
      s.aliveMs ?? null,
      s.gen,
    );
  });
  if (needMarker || c.db.meta("installMarker") !== "1") {
    if (g.mode === "prod") {
      try {
        if (!(await c.bucket.head(installedKey(c.inst))))
          await c.bucket.put(installedKey(c.inst), j({ inst: c.inst, gen: s.gen, at: c.now() }));
        c.db.setMeta("installMarker", "1");
      } catch (e) {
        ring(c, "install", "marker-write-failed", String(e).slice(0, 200));
      }
    }
  }
  return { ok: true, markerUsed: plan.sqlite?.kind === "marker" };
}

/** Gen verify probe result (§6.2): complete → verified, or → bad. */
export function genVerify(c: Ctx, gen: number, ok: boolean): void {
  if (ok)
    c.db.run(
      "UPDATE gens SET state = 'verified', verified_at = ? WHERE gen = ? AND state = 'complete'",
      c.now(),
      gen,
    );
  else c.db.run("UPDATE gens SET state = 'bad' WHERE gen = ? AND state IN ('complete', 'verified')", gen);
}

/** The start op for this gen ended without `complete` (§6.2). */
export function genEnded(c: Ctx, gen: number): void {
  c.db.run(
    "UPDATE gens SET state = CASE WHEN state = 'booting' THEN 'abandoned' ELSE state END, ended_at = ? WHERE gen = ?",
    c.now(),
    gen,
  );
}

export function pinGen(c: Ctx, gen: number, until: number): void {
  c.db.run("UPDATE gens SET pinned_until = MAX(COALESCE(pinned_until, 0), ?) WHERE gen = ?", until, gen);
}

/**
 * High-water mark check (§13.3) at the first request and daily. hwm.gen > genCounter or hwm.credsSeq > max seq
 * → ctl-rewound (no prod boots, high alert, genCounter = hwm.gen). An R2 error keeps the state; retried later.
 */
export async function hwmCheck(c: Ctx): Promise<{ checked: boolean; rewound: boolean }> {
  let hwm: { gen?: number; credsSeq?: number } | null = null;
  try {
    const o = await c.bucket.get(hwmKey(c.inst));
    hwm = o ? (JSON.parse(await o.text()) as { gen?: number; credsSeq?: number }) : null;
  } catch (e) {
    ring(c, "hwm", "read-failed", String(e).slice(0, 200));
    return { checked: false, rewound: c.db.meta("ctlState") === "ctl-rewound" };
  }
  c.db.setMeta("hwmCheckedAt", c.now());
  if (!hwm) return { checked: true, rewound: c.db.meta("ctlState") === "ctl-rewound" };
  const counter = c.db.metaNum("genCounter", 0);
  const seq = maxCredSeq(c);
  if ((hwm.gen ?? 0) > counter || (hwm.credsSeq ?? 0) > seq) {
    c.db.tx(() => {
      c.db.setMeta("ctlState", "ctl-rewound");
      c.db.setMeta("hwmGen", hwm?.gen ?? 0);
      c.db.setMeta("genCounter", Math.max(counter, hwm?.gen ?? 0));
    });
    alert(
      c,
      "ctl-rewound",
      "high",
      `Control DO below the R2 hwm (hwm gen ${hwm.gen}, counter ${counter}; credsSeq ${hwm.credsSeq}, have ${seq})`,
    );
    return { checked: true, rewound: true };
  }
  return { checked: true, rewound: c.db.meta("ctlState") === "ctl-rewound" };
}

export async function secretHash(secret: string): Promise<string> {
  return sha256Hex(secret);
}

/**
 * N1: the gen a PITR restore at `ts` reads: the newest complete (or verified) gen whose boot set completed at or
 * before ts (its first L0 holds the state at gen start, so `restore -timestamp ts` has a base).
 */
export function pitrGen(c: Ctx, ts: number): number | null {
  return (
    c.db.one<{ gen: number }>(
      `SELECT gen FROM gens WHERE state IN ('complete', 'verified') AND complete_at IS NOT NULL AND complete_at <= ?
       ORDER BY gen DESC LIMIT 1`,
      ts,
    )?.gen ?? null
  );
}
