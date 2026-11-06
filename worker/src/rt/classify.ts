// Stop classifier (spec 08 §9.1, C9, C15). Pure. Input: monitor() outcome + text + exitCode, the last
// `exit` event from ocsup, the open op, the drain record. Exit codes map through contract classifyExit().
import { classifyExit } from "../core/contract";

export type Esc = false | true | "evidence";
export type Table = "none" | "zero" | "capacity" | "infra" | "fault" | "slow";

export interface StopClass {
  cls: string;
  esc: Esc;
  table: Table;
  /** true = confirmed stop (no 200 s wait). */
  confirmed: boolean;
  /** Alert to raise with this class (high for schema, disk-full, image key; info for others). */
  alert?: { class: string; severity: "info" | "warn" | "high" };
  /** Next boot gets a new plan with runDoctor (doctor-required). */
  runDoctor?: boolean;
  /** Replan in the same op (snapshot-lost). */
  replan?: boolean;
  code: number | null;
  reason: string | null;
  text: string;
}

export interface SettleInput {
  outcome: "resolved" | "rejected" | "none";
  err?: unknown;
  /** Last `exit` event from ocsup for this boot. */
  exitEvent?: { code: number; reason?: string | null } | null;
  /** Kind of the open op when the settle came. */
  openOp?: string | null;
  /** A sigterm event or a draining heartbeat was seen for this boot. */
  draining?: boolean;
  /** We called destroy() for this boot (the op may already be closed). */
  destroyed?: boolean;
  /** exitCodeConfirms flag (C15), false until T1. */
  exitCodeConfirms?: boolean;
  /** Epoch status for `fenced`. */
  epochRetired?: boolean;
}

export const CAPACITY_RE = /no container instance|capacity/i;
export const SNAPSHOT_RE = /Snapshot ".*" was not found/;
export const SIGNALLED_RE = /runtime signalled the container to exit/i;
export const ALREADY_RE = /already running/i;
const PLANNED_OPS = new Set(["sleep", "stop", "retire", "replace", "destroy"]);
const EXIT_RE = /exit(?:ed)?(?:\s+with)?(?:\s+unexpected)?(?:\s+exit)?\s+(?:status|code)[:\s=]*(-?\d+)/i;

/** Full text of an error, including name, message and cause (spike rt/classify.ts). */
export function errorText(e: unknown): string {
  if (e === undefined || e === null) return "";
  if (e instanceof Error) {
    const parts = [e.message];
    if (e.cause !== undefined) parts.push(`cause: ${errorText(e.cause)}`);
    return parts.join(" ").slice(0, 4000);
  }
  try {
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function exitCodeOf(err: unknown, text: string): number | null {
  const prop = (err as { exitCode?: unknown } | undefined)?.exitCode;
  if (typeof prop === "number") return prop;
  const m = EXIT_RE.exec(text);
  return m ? Number(m[1]) : null;
}

const mk = (o: Partial<StopClass> & Pick<StopClass, "cls" | "table">): StopClass => ({
  esc: false,
  confirmed: false,
  code: null,
  reason: null,
  text: "",
  ...o,
});

/** Class of one stop (§9.1). */
export function classifyStop(i: SettleInput): StopClass {
  const text = errorText(i.err);
  if (i.outcome === "rejected" && CAPACITY_RE.test(text))
    return mk({ cls: "capacity", table: "capacity", confirmed: true, text });
  if (i.outcome === "rejected" && SNAPSHOT_RE.test(text))
    return mk({ cls: "snapshot-lost", table: "zero", confirmed: true, replan: true, text });
  // Exit code: the ocsup `exit` event wins over a code parsed from text (§9.1 last line).
  const parsed = i.outcome === "rejected" ? exitCodeOf(i.err, text) : null;
  const code = i.exitEvent ? i.exitEvent.code : parsed;
  const reason = i.exitEvent?.reason ?? null;
  const plannedOp = !!(i.openOp && PLANNED_OPS.has(i.openOp));
  if (i.destroyed || (plannedOp && (i.outcome !== "rejected" || code === null || code === 0)))
    return mk({ cls: "planned", table: "none", confirmed: true, code, reason, text });
  if (i.outcome === "rejected" && SIGNALLED_RE.test(text))
    return mk({ cls: "platform", table: "zero", confirmed: true, text });
  if (i.outcome === "none") {
    if (i.draining) return mk({ cls: "platform", table: "zero", confirmed: true, text });
    // amend §2 row 2: no settle, no open op = lost (inactivity-stop shape).
    return mk({
      cls: "lost",
      table: "infra",
      confirmed: false,
      alert: { class: "inactivity?", severity: "high" },
      text,
    });
  }
  if (i.outcome === "resolved" || code === 0) {
    if (i.draining) return mk({ cls: "platform", table: "zero", confirmed: true, code, reason, text });
    return mk({
      cls: "unknown-platform",
      table: "infra",
      confirmed: false,
      code,
      reason,
      text,
      alert: { class: "unknown-platform", severity: "warn" },
    });
  }
  if (code === null)
    return mk({
      cls: "unknown-platform",
      table: "infra",
      confirmed: false,
      text,
      alert: { class: "unknown-platform", severity: "warn" },
    });
  // C15: an exitCode reject is confirmed only after a signalled drain or with exitCodeConfirms.
  const confirmed = !!i.exitCodeConfirms || !!i.draining;
  const base = { code, reason, text, confirmed };
  const ce = classifyExit(code, reason);
  switch (ce.cls) {
    case "oom?":
    case "heap-abort":
      return mk({ ...base, cls: ce.cls, esc: "evidence", table: "fault" });
    case "fenced":
      return mk({ ...base, cls: "fenced", table: i.epochRetired ? "none" : "infra" });
    case "supervisor":
      return mk({
        ...base,
        cls: "supervisor",
        table: "infra",
        alert: { class: "supervisor", severity: "warn" },
      });
    case "auto-restart":
      return mk({ ...base, cls: "auto-restart", table: "zero" });
    case "disk-full":
      return mk({
        ...base,
        cls: "disk-full",
        table: "infra",
        alert: { class: "disk-full", severity: "high" },
      });
    case "infra":
      return mk({ ...base, cls: "infra", table: "infra" });
    case "restore-blocked:schema":
      return mk({
        ...base,
        cls: ce.cls,
        table: "slow",
        alert: { class: "restore-blocked:schema", severity: "high" },
      });
    case "doctor-required":
      return mk({ ...base, cls: "doctor-required", table: "zero", runDoctor: true });
    case "lock-blocked":
      return mk({ ...base, cls: "lock-blocked", table: "infra" });
    default:
      break;
  }
  if (code === 75 && reason === "restore-blocked:rewound")
    return mk({ ...base, cls: reason, table: "slow", alert: { class: "ctl-rewound", severity: "high" } });
  if (ce.esc === true) return mk({ ...base, cls: ce.cls, esc: true, table: "fault" });
  return mk({ ...base, cls: ce.cls, esc: "evidence", table: "fault" });
}
