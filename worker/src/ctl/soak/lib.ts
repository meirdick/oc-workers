// What a soak step sees (the port) and the helpers every step uses. The port is the only way a step touches
// the install: Control status, owner /ops actions, Runtime and Control DO faults, inbox injection. In the
// Control DO it is built from ControlCore (control.ts soakPort); vitest builds the same one on the World.
import type { Ctx } from "../ctx";
import { PROBE, ST } from "./scripts";
import type { PlanRow, StepRow } from "./store";
import type { Measure, StepSpec } from "./types";

export interface FaultRes {
  ok?: boolean;
  error?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface SoakPort {
  c: Ctx;
  status(): Promise<Record<string, any>>;
  /** Owner /ops action through the Control DO (wake, sleep, stop, start, archive, restore, settings, ...). */
  ops(
    action: string,
    method?: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
  /** Runtime DO fault (sigkill, destroy, signal, abort, exec, ...). */
  rtFault(name: string, params?: Record<string, unknown>): Promise<FaultRes>;
  /** Control DO fault (r2-down, r2-up, replica-throttle, replica-unthrottle, ctl-wipe, r2-usage, rows). */
  ctlFault(name: string, params?: Record<string, unknown>): Promise<{ status: number; body: any }>;
  /** One fake Telegram update from `chat` through the inbox path the webhook uses, then the wake. */
  inject(
    chat: number,
    text: string,
    who: { plan: string; step: string },
  ): Promise<{ status: number; id?: string; dup?: boolean }>;
  /** Raw R2 (not the r2-down wrapper): the soak copies and the empty-replica drill. */
  rawBucket(): RawBucket;
}

export interface RawBucket {
  list(o: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, v: string | ArrayBuffer): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface StepCtx {
  port: SoakPort;
  plan: PlanRow;
  step: StepRow;
  spec: StepSpec;
  /** Step params. */
  p: Record<string, any>;
  /** Persisted between calls; handlers mutate it. */
  d: Record<string, any>;
  phase: string;
  now: number;
  /** Persist phase and data now (a step that is about to lose the DO, like ctl-wipe). */
  save?(phase: string): void;
  /** Write the soak tables to R2 `soak-resume/dump.json` (ctl-wipe). */
  dumpSoak?(): Promise<void>;
}

export type StepOut =
  | { wait: number; phase?: string }
  | {
      done: true;
      checks?: Record<string, boolean>;
      measures?: Measure[];
      data?: Record<string, unknown>;
      error?: string;
      skipped?: string;
    };

export type Handler = (x: StepCtx) => Promise<StepOut>;

export const SEC = 1000;
export const MIN = 60_000;
export const HOUR = 3_600_000;

export const wait = (ms: number, phase?: string): StepOut => ({ wait: ms, phase });
export const finish = (o: Omit<Extract<StepOut, { done: true }>, "done"> = {}): StepOut => ({
  done: true,
  ...o,
});

/** Bounds from docs/01-plan.md §1 and M4-STATUS §5. `ms` values in ms. */
export const BOUND = {
  sqliteMs: 3000,
  nonManagedMs: 15 * MIN,
  credsMs: 30 * SEC,
  bulkMs: 60 * MIN,
};

export const measure = (
  item: string,
  name: string,
  value: number,
  unit: string,
  bound: string,
  max?: number,
  min?: number,
): Measure => ({
  item,
  name,
  value,
  unit,
  bound,
  ...(max !== undefined ? { max } : {}),
  ...(min !== undefined ? { min } : {}),
});

// ---- container exec ----
const AS1000 = ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups"];

export async function exec(port: SoakPort, cmd: string[], timeoutMs = 60_000): Promise<FaultRes> {
  return port.rtFault("exec", { cmd, timeoutMs });
}
export const sh = (port: SoakPort, script: string, timeoutMs?: number) =>
  exec(port, ["sh", "-c", script], timeoutMs);

/** Run a node ESM snippet as uid 1000 (or root); returns the last stdout line parsed, or {err}. */
export async function nodeJs(
  port: SoakPort,
  js: string,
  args: (string | number)[] = [],
  o: { root?: boolean; timeoutMs?: number } = {},
): Promise<Record<string, any>> {
  const b64 = btoa(js);
  const script = `echo ${b64} | base64 -d > /tmp/soak-$$.mjs && /usr/local/bin/node --no-warnings /tmp/soak-$$.mjs "$@"; rc=$?; rm -f /tmp/soak-$$.mjs; exit $rc`;
  const cmd = ["sh", "-c", script, "soak", ...args.map(String)];
  const r = await exec(port, o.root ? cmd : [...AS1000, ...cmd], o.timeoutMs ?? 60_000);
  try {
    return JSON.parse(
      String(r.stdout ?? "")
        .trim()
        .split("\n")
        .pop() ?? "",
    );
  } catch {
    return { err: String(r.stderr ?? r.error ?? JSON.stringify(r)).slice(0, 300), exit: r.exitCode };
  }
}

/** Start a detached uid-1000 node process from a snippet (writer, churn). */
export async function nodeBg(port: SoakPort, name: string, js: string, args: (string | number)[]) {
  const b64 = btoa(js);
  const script = `echo ${b64} | base64 -d > /tmp/soak-${name}.mjs && (setsid nohup /usr/local/bin/node --no-warnings /tmp/soak-${name}.mjs ${args.join(" ")} >>/tmp/soak-${name}.log 2>&1 < /dev/null & echo started)`;
  const r = await exec(port, [...AS1000, "sh", "-c", script], 30_000);
  return /started/.test(String(r.stdout ?? ""));
}

export const probe = (port: SoakPort) => nodeJs(port, PROBE);

// ---- status helpers ----
export const genOf = (s: Record<string, any>): number | null => s.gen?.gen ?? null;
export const running = (s: Record<string, any>) => s.state === "running";

/** Telegram update body (same shape as the drills'). */
export function update(chat: number, text: string, now: number, seq: number) {
  const upd = 900_000_000 + (Math.floor(now / 100) % 10_000_000) * 10 + (seq % 10);
  return {
    upd,
    body: JSON.stringify({
      update_id: upd,
      message: {
        message_id: upd % 2_000_000_000,
        date: Math.floor(now / 1000),
        chat: { id: chat, type: "private", first_name: "soak" },
        from: { id: chat, is_bot: false, first_name: "soak", username: `soak_${chat}` },
        text,
      },
    }),
  };
}

export const pct = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))] ?? null;
};

export { ST };
