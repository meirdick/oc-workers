// ochost status [--watch] (docs/10-cli-spec.md §1.2, addendum §5.2). GET /ops/status only: never wakes.
// Shows mode, state, gen, last activity, next wake, blockers, the month cost range and the VM line.

import {
  EXIT,
  type FlagSpec,
  flagBool,
  fmtAgo,
  fmtDur,
  fmtUsd,
  kv,
  type OpsCtx,
  opsClient,
  readHostConfig,
} from "./ops-lib.ts";
import { costLine } from "./summary.ts";

export const statusFlags: FlagSpec = { watch: { type: "boolean", short: "w" } };

/** Workers Paid plan per month. */
export const PLAN_USD = 5;
/** Snapshot storage per sleep, low and high guess (addendum §1.2: $0.0015 to $0.024). */
export const SNAP_LOW = 0.0015;
export const SNAP_HIGH = 0.024;
/** Snapshot cost the Worker uses when the config has none (worker/src/core/cost.ts SNAP_COST_DEFAULT). */
export const SNAP_DEFAULT = 0.0045;
/** VM prices read 2026-10-30 (addendum §1.3). */
export const VM = { name: "Hetzner CX33", usd: 10.43, withBackupsUsd: 12.52 };

export interface WakeMeter {
  spend24Usd?: number;
  awakeS24?: number;
  sleeps24?: number;
  monthUsd?: number;
  alwaysOnMonthUsd?: number;
  savedPct?: number;
  wakes24?: number;
}

export interface CostRange {
  lowUsd: number;
  highUsd: number;
  alwaysOnUsd: number | null;
  awakePct: number | null;
  basis: string;
}

/**
 * Month projection as a range (addendum §5.2 "cost month to date and projection as a range"). The Worker
 * projects the last 24 h × 30 with one snapshot price; this swaps that price for the low and high guess and
 * adds the $5 plan. guess: the last 24 h stand for the month.
 */
export function costRange(w: WakeMeter | undefined, snapCost = SNAP_DEFAULT): CostRange | null {
  if (!w || typeof w.monthUsd !== "number") return null;
  const sleepsMonth = (w.sleeps24 ?? 0) * 30;
  const compute = Math.max(0, w.monthUsd - sleepsMonth * snapCost);
  return {
    lowUsd: round2(PLAN_USD + compute + sleepsMonth * SNAP_LOW),
    highUsd: round2(PLAN_USD + compute + sleepsMonth * SNAP_HIGH),
    alwaysOnUsd: typeof w.alwaysOnMonthUsd === "number" ? round2(PLAN_USD + w.alwaysOnMonthUsd) : null,
    awakePct: typeof w.awakeS24 === "number" ? Math.round((w.awakeS24 / 86_400) * 1000) / 10 : null,
    basis: "last 24 h x 30, $5 plan included, snapshot price guess",
  };
}

/** One line against an always-on VM (addendum §1.3). */
export function vmLine(r: CostRange | null): string {
  const vm = `${VM.name} ${fmtUsd(VM.usd)}, ${fmtUsd(VM.withBackupsUsd)} with backups (guess)`;
  if (!r) return `${vm}; no cost data yet`;
  let verdict: string;
  if (r.highUsd < VM.usd) verdict = "this install costs less";
  else if (r.lowUsd > VM.withBackupsUsd) verdict = "this install costs more";
  else if (r.lowUsd < VM.withBackupsUsd && r.highUsd > VM.usd)
    verdict = "about the same, the snapshot price decides";
  else verdict = "about the same";
  return `${vm}: ${verdict}`;
}

/** Always-on on Cloudflare and a VM, side by side with this install (addendum §1.3). */
export function alternatives(r: CostRange | null) {
  const vm = { name: VM.name, usd: VM.usd, withBackupsUsd: VM.withBackupsUsd };
  const alwaysOn = r?.alwaysOnUsd ?? null;
  const line = `${alwaysOn !== null ? `always-on here ${fmtUsd(alwaysOn)} · ` : ""}${vmLine(r)}`;
  return { alwaysOnUsd: alwaysOn, vm, line };
}

/**
 * What the sleep gate is doing now, in words. `idleMs` is the idle timer from oc-host.jsonc (sleep.idleMinutes).
 * guess: the Worker sleeps `idleMinutes` after the last activity; a blocker or the cost guard holds it awake.
 */
export function sleepState(o: {
  mode: string;
  state: string;
  blockers: string[];
  costGuardHolding: boolean;
  lastActivityAt: number | null;
  idleMs: number;
  now: number;
}): { kind: "off" | "asleep" | "waking" | "going-to-sleep" | "blocked" | "guard" | "awake"; text: string } {
  if (o.mode === "off") return { kind: "off", text: "off: always on (ochost sleep set auto turns it on)" };
  if (/^asleep/.test(o.state))
    return { kind: "asleep", text: "asleep; wakes on a message, a cron job or a login" };
  if (/^(waking|starting|restoring)/.test(o.state))
    return { kind: "waking", text: `${o.state}; about 1 min` };
  if (/^(quiescing|sleeping)/.test(o.state)) return { kind: "going-to-sleep", text: `${o.state}` };
  if (o.state !== "running") return { kind: "awake", text: o.state };
  if (o.costGuardHolding) return { kind: "guard", text: "awake: held by the cost guard" };
  const real = o.blockers.filter((b) => !/^\d+:idle$/.test(b));
  if (real.length)
    return { kind: "blocked", text: `awake: ${real.join(", ")} keeps it on (ochost sleep status)` };
  if (o.lastActivityAt) {
    const left = o.lastActivityAt + o.idleMs - o.now;
    if (left > 0) return { kind: "awake", text: `awake; sleeps in about ${fmtDur(left)} if idle` };
  }
  return { kind: "awake", text: "awake; sleeps at the next idle check" };
}

/** Registry growth from /ops/status `snapshots` (Worker ctl/chain.ts); null on an older Worker. */
export function snapshotsOf(x: any) {
  if (!x || typeof x !== "object" || typeof x.tags !== "number") return null;
  return {
    chainLength: Number(x.chainLength ?? 0),
    chainAgeMs: typeof x.chainAgeMs === "number" ? x.chainAgeMs : null,
    tags: x.tags as number,
    bytes: Number(x.bytes ?? 0),
    rebase: (x.rebase?.pending ? "pending" : x.rebase?.due ? "due" : "not due") as string,
    prunable: Number(x.prune?.count ?? 0),
    warn: typeof x.warn === "string" ? (x.warn as string) : null,
  };
}

const fmtMb = (b: number) => `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The fields status shows, from the /ops/status body and oc-host.jsonc. */
export function summarize(s: any, cfg: Record<string, any> | null, now: number) {
  const hb = s?.rt?.hb ?? null;
  const sleepMode: string = s?.sleepMode ?? cfg?.sleep?.mode ?? "auto";
  const snap = typeof cfg?.sleep?.snapshotCostUsd === "number" ? cfg.sleep.snapshotCostUsd : SNAP_DEFAULT;
  const lastActivityAt: number | null = s?.lastActivityAt ?? hb?.lastActivityAt ?? null;
  const nextWakeAt: number | null = s?.nextWakeAt ?? s?.rt?.sleep?.wakeAt ?? null;
  const cost = costRange(s?.wake, snap);
  const state = String(s?.state ?? "unknown");
  const blockers = Array.isArray(s?.blockers) ? (s.blockers as string[]) : [];
  const idleMin = typeof cfg?.sleep?.idleMinutes === "number" ? cfg.sleep.idleMinutes : 5;
  const sleep = sleepState({
    mode: sleepMode,
    state,
    blockers,
    costGuardHolding: !!s?.costGuard?.holding,
    lastActivityAt,
    idleMs: idleMin * 60_000,
    now,
  });
  const alerts: any[] = Array.isArray(s?.alerts) ? s.alerts : [];
  return {
    inst: s?.inst ?? null,
    state: String(s?.state ?? "unknown"),
    desired: s?.desired ?? null,
    mode: sleepMode,
    bootMode: s?.gen?.mode ?? null,
    costGuard: s?.costGuard?.holding ? "holding awake" : "ok",
    gen: s?.gen?.gen ?? null,
    genState: s?.gen?.state ?? null,
    epoch: s?.epoch?.n ?? null,
    digest: s?.epoch?.digest ?? null,
    codeVersion: s?.codeVersion ?? null,
    blockers: Array.isArray(s?.blockers) ? (s.blockers as string[]) : [],
    lastActivityAt,
    lastActivity: fmtAgo(lastActivityAt, now),
    nextWakeAt,
    sleep,
    nextWake: nextWakeAt
      ? fmtAgo(nextWakeAt, now)
      : state === "running"
        ? "none; awake now"
        : "on the next message or cron",
    wakes24: s?.wake?.wakes24 ?? null,
    inbox: s?.inbox ?? null,
    alerts: alerts.map((a) => ({ class: a.class, severity: a.severity })),
    cost,
    vm: vmLine(cost),
    alternatives: alternatives(cost),
    degraded: !!s?.degraded,
    snapshots: snapshotsOf(s?.snapshots),
    model: (cfg?.llm?.primary as string | undefined) ?? null,
    gateway: (cfg?.llm?.gateway as string | undefined) ?? null,
  };
}

export function render(x: ReturnType<typeof summarize>, url: string): string {
  const rows: [string, string][] = [
    ["url", url],
    ["state", x.desired && x.desired !== x.state ? `${x.state} (to ${x.desired})` : x.state],
    ["mode", `${x.mode}${x.bootMode ? ` · ${x.bootMode}` : ""} · cost guard ${x.costGuard}`],
    [
      "gen",
      x.gen === null ? "-" : `${x.gen}${x.genState ? ` (${x.genState})` : ""} · epoch ${x.epoch ?? "-"}`,
    ],
    ["sleep", x.sleep.text],
    ["last activity", x.lastActivity],
    ["next wake", x.nextWake],
  ];
  if (x.model || x.gateway) rows.push(["model", `${x.model ?? "-"} via gateway ${x.gateway ?? "-"}`]);
  if (x.blockers.length) rows.push(["blockers", x.blockers.join(", ")]);
  if (x.inbox && typeof x.inbox === "object") {
    const i = x.inbox as Record<string, unknown>;
    rows.push(["inbox", ["pending", "held", "accepted", "dead"].map((k) => `${k} ${i[k] ?? 0}`).join(" · ")]);
  }
  rows.push([
    "alerts",
    x.alerts.length ? x.alerts.map((a) => `${a.class} (${a.severity})`).join(", ") : "none open",
  ]);
  if (x.cost) {
    const c = x.cost;
    rows.push([
      "cost",
      `${fmtUsd(c.lowUsd)}-${fmtUsd(c.highUsd)} this month (${c.basis})` +
        (c.awakePct !== null ? ` · awake ${c.awakePct}%` : "") +
        (c.alwaysOnUsd !== null ? ` · always-on ${fmtUsd(c.alwaysOnUsd)}` : ""),
    ]);
  } else rows.push(["cost", `${costLine().replace(/;.*/, "")} (estimate; no usage data yet)`]);
  if (x.snapshots) {
    const n = x.snapshots;
    rows.push([
      "snapshots",
      `chain ${n.chainLength}${n.chainAgeMs !== null ? ` (root ${fmtDur(n.chainAgeMs)} old)` : ""} · about ${n.tags} registry tags, ${fmtMb(n.bytes)} (estimate) · rebase ${n.rebase}` +
        (n.prunable ? ` · ${n.prunable} prunable` : ""),
    ]);
  }
  rows.push(["alternatives", x.alternatives.line]);
  rows.push(["version", `${x.codeVersion ?? "-"}${x.digest ? ` · ${String(x.digest).slice(0, 19)}` : ""}`]);
  return kv(rows);
}

export async function status(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const watch = flagBool(ctx.args, "watch");
  for (let i = 0; ; i++) {
    const r = await ops.call("GET", "/ops/status");
    const x = summarize(r.body, readHostConfig(ctx.dir), ctx.now());
    if (ctx.out.json) ctx.out.result({ ok: true, url: ops.install.url, ...x });
    else {
      if (i > 0) ctx.out.line("");
      ctx.out.line(render(x, ops.install.url));
      if (x.degraded) ctx.out.warn("the install is degraded — fix: ochost doctor");
      if (x.snapshots?.warn) ctx.out.warn(`${x.snapshots.warn} — the registry cap is 50 GB per account`);
    }
    if (!watch || ctx.signal?.aborted) return EXIT.ok;
    await ctx.sleep(5000);
    if (ctx.signal?.aborted) return EXIT.ok;
  }
}
