// The plan catalog. A plan is a list of steps (steps.ts types) with params; `all` runs the catalog in order
// (destructive plans last). Bounds: docs/01-plan.md §1 and worker/test/results/M4-STATUS.md §5.
import { DRAIN_WAIT_MS, HOUR, MIN, POISON_WATCH_MS, SEC } from "./lib";
import type { StepSpec } from "./types";

type P = Record<string, any>;
const num = (p: P, k: string, d: number) => (typeof p[k] === "number" && p[k] > 0 ? p[k] : d);

export interface PlanDef {
  name: string;
  about: string;
  /** In `all`. */
  all: boolean;
  build(p: P): StepSpec[];
}

const hold: StepSpec[] = [
  { id: "awake", type: "awake" },
  { id: "up", type: "up" },
];

/** A deterministic spread of awake times, 30-200 s (the M4 loss50 shape). */
const spread = (i: number) => (30 + ((i * 37) % 170)) * SEC;

export const PLANS: PlanDef[] = [
  {
    name: "scrub-live",
    about: "uid-1000 reads of gateway and ocio env and mem must be denied",
    all: true,
    build: () => [...hold, { id: "scrub", type: "scrub" }],
  },
  {
    name: "sqlite-loss",
    about: "15 kills with a writer, 3 in an in-flight archive; sqlite loss per kill",
    all: true,
    build: (p) => {
      const n = num(p, "kills", 15);
      const arch = new Set([5, 10, 15].filter((k) => k <= n));
      const steps: StepSpec[] = [...hold];
      for (let i = 1; i <= n; i++)
        steps.push({
          id: `kill-${String(i).padStart(2, "0")}`,
          type: "kill",
          params: {
            fault: "sigkill",
            upMs: num(p, "upMs", spread(i)),
            arch: arch.has(i),
            items: { sql: "sqlite-loss", rows: "sqlite-rows-lost", run: "kill-to-running" },
          },
        });
      return steps;
    },
  },
  {
    name: "non-managed-sqlite",
    about: "20 min, 3 kills, shadow age of a non-managed SQLite file",
    all: true,
    build: (p) => {
      const n = num(p, "kills", 3);
      const steps: StepSpec[] = [...hold];
      for (let i = 1; i <= n; i++)
        steps.push({
          id: `kill-${i}`,
          type: "kill",
          params: { fault: "sigkill", upMs: num(p, "upMs", 5 * MIN), items: { nm: "non-managed-sqlite" } },
        });
      return steps;
    },
  },
  {
    name: "crash-loop",
    about: "5 kills in 10 min, then bulk and shadow ages",
    all: true,
    build: (p) => {
      const n = num(p, "kills", 5);
      const steps: StepSpec[] = [...hold];
      for (let i = 1; i <= n; i++)
        steps.push({
          id: `kill-${i}`,
          type: "kill",
          params: {
            fault: "sigkill",
            // the first life writes; later lives are short and write nothing, so the ages show what survived the loop
            writer: i === 1,
            upMs: i === 1 ? num(p, "firstUpMs", 90 * SEC) : num(p, "upMs", 10 * SEC),
            items: { nm: "crash-loop-shadow", ws: "crash-loop-bulk" },
          },
        });
      return steps;
    },
  },
  {
    name: "telegram-60",
    about: "60 fake updates, 6 kills between accept and send; unreplied 0, duplicates counted",
    all: true,
    build: (p) => [
      ...hold,
      {
        id: "batch",
        type: "tg-batch",
        params: {
          n: num(p, "n", 60),
          kills: typeof p.kills === "number" ? p.kills : 6,
          killEvery: num(p, "killEvery", 10),
          gapMs: num(p, "gapMs", 5 * SEC),
        },
      },
    ],
  },
  {
    name: "pitr-boot",
    about: "write rows, restore to a timestamp, boot flag set, rows match",
    all: true,
    build: () => [...hold, { id: "pitr", type: "pitr" }],
  },
  {
    name: "fault-mix",
    about: "each fault primitive once: sigkill, destroy, signal 15, deploy stand-in, throttle, disk fill",
    all: true,
    build: (p) => {
      const up = num(p, "upMs", 30 * SEC);
      const k = (id: string, params: P): StepSpec => ({
        id,
        type: "kill",
        params: { upMs: up, items: { run: "fault-to-running" }, ...params },
      });
      // Restart faults also measure the SQLite window: M7 soak gen 32 lost 30 s of rows here (stale marker)
      // and no bound saw it.
      const loss = { run: "fault-to-running", sql: "fault-mix-sqlite", rows: "fault-mix-rows-lost" };
      return [
        ...hold,
        k("sigkill", { fault: "sigkill", items: loss }),
        k("destroy", { fault: "destroy", items: loss }),
        // SIGTERM = platform drain (plan §4.5): drain, final snapshot, exit, new gen.
        k("signal-15", { fault: "signal", sig: 15, newGen: true, items: loss }),
        k("deploy-abort", { fault: "abort", ms: 2000, settleMs: 3 * MIN }),
        { id: "throttle", type: "throttle", params: { delayMs: 3000, holdMs: 2 * MIN } },
        { id: "disk-82", type: "disk-fill", params: { pct: 82 } },
        { id: "disk-96", type: "disk-fill", params: { pct: 96 } },
        { id: "disk-100", type: "disk-fill", params: { pct: 100 } },
        { id: "disk-free", type: "disk-free" },
      ];
    },
  },
  {
    name: "drill-a",
    about: "drill A: destroy() mid-chat, snapshot path",
    all: true,
    build: () => [...hold, { id: "drill-a", type: "drill-a" }],
  },
  {
    name: "drill-g",
    about: "drill G: new agent DB killed before its first upload",
    all: true,
    build: () => [...hold, { id: "drill-g", type: "drill-g" }],
  },
  {
    name: "drill-ch",
    about: "drills C and H: R2 down 30 min in a crash loop; L1 only, older complete gen",
    all: true,
    build: (p) => [...hold, { id: "outage", type: "r2-outage", params: { ms: num(p, "ms", 30 * MIN) } }],
  },
  {
    name: "drill-i",
    about: "drill I: L5 within 2 h after a cutover",
    all: true,
    build: () => [
      {
        id: "drill-i",
        type: "note",
        params: { why: "needs a second image digest (M6 cutover) and L5 after it; not scripted" },
      },
    ],
  },
  {
    name: "s4-500",
    about: "500 sleep/wake cycles, one update each; R2 bytes, snapshot sizes, rebase count",
    all: true,
    build: (p) => {
      const total = num(p, "cycles", 500);
      const per = num(p, "perStep", 10);
      const steps: StepSpec[] = [
        { id: "awake-off", type: "awake", params: { on: false } },
        { id: "up", type: "up" },
        // Leftover updates of earlier plans hold the install awake (sleep rule 5): wait them out first.
        { id: "inbox-drain", type: "inbox-drain", params: { ms: num(p, "drainMs", DRAIN_WAIT_MS) } },
        { id: "r2-start", type: "r2-mark" },
      ];
      for (let i = 0; i * per < total; i++)
        steps.push({
          id: `cycles-${String(i).padStart(3, "0")}`,
          type: "cycles",
          params: { n: Math.min(per, total - i * per) },
        });
      steps.push({ id: "final", type: "s4-final" });
      return steps;
    },
  },
  {
    name: "baileys-24h",
    about: "credential churn for 24 h; CredStore equals disk",
    all: true,
    build: (p) => [
      ...hold,
      {
        id: "churn",
        type: "churn-hold",
        params: { ms: num(p, "hours", 24) * HOUR, sampleMs: num(p, "sampleMs", HOUR) },
      },
      { id: "compare", type: "creds-compare" },
    ],
  },
  {
    name: "drill-d",
    about: "drill D: poisoned SQLite, l5-pending, pitr restore",
    all: true,
    build: (p) => [
      ...hold,
      // l5-pending needs 2 h in `slow` (timers l5PendingMs) after the ladder gets there; 45 min never could.
      { id: "poison", type: "poison", params: { watchMs: num(p, "watchMs", POISON_WATCH_MS) } },
    ],
  },
  {
    name: "drill-e",
    about: "drill E: empty replica prefix, restore-blocked (objects moved out and back)",
    all: true,
    build: () => [...hold, { id: "drill-e", type: "drill-e" }],
  },
  {
    name: "drill-jl",
    about: "drills J and L: Control DO wipe through the test route; index rebuilt from R2",
    all: true,
    build: () => [...hold, { id: "ctl-wipe", type: "ctl-wipe" }],
  },
  {
    name: "smoke",
    about: "3 steps, no faults: wait, up, scrub (not in all)",
    all: false,
    build: () => [
      { id: "wait", type: "wait", params: { ms: 3000 } },
      { id: "up", type: "up" },
      { id: "scrub", type: "scrub" },
    ],
  },
];

export const planByName = (n: string) => PLANS.find((p) => p.name === n);
export const catalog = () => PLANS.map((p) => ({ name: p.name, about: p.about, all: p.all }));
