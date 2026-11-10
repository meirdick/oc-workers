// `ochost import` (docs/10-cli-spec.md §1.2, docs/research/migration-plan.md): the rules the Control DO
// (owner routes, ctl/imports.ts) and the ledger (ControlGate side) share. One open request per install, kept
// in meta `importRequest`. The owner uploads a workspace bundle to `imp/<inst>/<id>.tar.gz` and files to
// `f/<inst>/`; ocsup sees the request in the heartbeat ack, fetches the bundle, applies it once and reports.
// Pure: no I/O.
import { IMPORT_ID_RE } from "../../../image/ocrt/lib/contract.mjs";

export const IMPORT_META = "importRequest";
/** The bundle is the workspace part only (records and transcripts go to f/<inst>/), so 200 MB is plenty. */
export const IMPORT_BUNDLE_MAX = 200 * 1000 * 1000;
/** A request with no answer from ocsup for this long fails (`import-stalled`); the sleep hold ends with it. */
export const IMPORT_STALL_MS = 30 * 60_000;
/** ocsup may try again after this long without `done` (a boot died mid-apply; the apply is idempotent). */
export const IMPORT_RETRY_MS = 10 * 60_000;
export const IMPORT_CRON_MAX = 50;

export const importBundleKey = (inst: string, id: string) => `imp/${inst}/${id}.tar.gz`;
export const importIdOk = (id: unknown): id is string => typeof id === "string" && IMPORT_ID_RE.test(id);

/** One OpenClaw cron job, re-created by ocsup with `openclaw cron add --declaration-key` (idempotent). */
export interface ImportCron {
  key: string;
  name: string;
  cron: string;
  tz?: string;
  message: string;
  session?: "isolated" | "main";
  agent?: string;
  enabled: boolean;
  timeoutSeconds?: number;
  announce?: { channel: string; to: string };
  description?: string;
}

export interface ImportRequest {
  id: string;
  sha256: string;
  bytes: number;
  /** workspace paths (relative) the bundle may replace; others are only added when missing */
  overwrite: string[];
  /** workspace paths to move into the import backup (BOOTSTRAP.md: the old install finished its first run) */
  remove: string[];
  cron: ImportCron[];
  state: "pending" | "running" | "done" | "failed";
  at: number;
  /** last time ocsup took it (heartbeat ack) and with which gen */
  takenAt?: number;
  takenGen?: number;
  tries: number;
  doneAt?: number;
  why?: string;
  result?: unknown;
}

/** Same rule as the file_store tool (image/plugins/ochost-storage/tool.mjs KEY_RE), so the agent can read it. */
const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export const keyOk = (p: unknown): p is string =>
  typeof p === "string" &&
  p.length <= 480 &&
  KEY_RE.test(p) &&
  p.split("/").every((s) => s !== "." && s !== "..");
/** A workspace path in `overwrite`: relative, no `.`/`..` segment, no NUL or newline. */
export const relOk = (p: unknown): p is string =>
  typeof p === "string" &&
  p.length > 0 &&
  p.length <= 512 &&
  !p.startsWith("/") &&
  !/[\0\n\r]/.test(p) &&
  p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
/** 5 or 6 fields (OpenClaw accepts both), each a plain cron token. */
const CRON_RE = /^[0-9A-Za-z*/,?#-]{1,32}( [0-9A-Za-z*/,?#-]{1,32}){4,5}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const DECL_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/** Shape check of one cron entry; returns the reason or null. Values go to argv (no shell), so length caps only. */
export function cronProblem(j: unknown): string | null {
  const x = j as ImportCron;
  if (!x || typeof x !== "object") return "not an object";
  if (!DECL_RE.test(String(x.key))) return "key";
  if (!NAME_RE.test(String(x.name))) return "name";
  if (typeof x.cron !== "string" || !CRON_RE.test(x.cron)) return "cron";
  if (x.tz !== undefined && !TZ_RE.test(String(x.tz))) return "tz";
  if (typeof x.message !== "string" || !x.message.trim() || x.message.length > 8000) return "message";
  if (x.session !== undefined && x.session !== "isolated" && x.session !== "main") return "session";
  if (x.agent !== undefined && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(x.agent))) return "agent";
  if (typeof x.enabled !== "boolean") return "enabled";
  if (
    x.timeoutSeconds !== undefined &&
    !(Number.isInteger(x.timeoutSeconds) && x.timeoutSeconds >= 0 && x.timeoutSeconds <= 3600)
  )
    return "timeoutSeconds";
  if (x.announce !== undefined) {
    const a = x.announce;
    if (!a || !/^[a-z][a-z0-9-]{0,31}$/.test(String(a.channel)) || !/^-?[0-9]{1,20}$/.test(String(a.to)))
      return "announce";
  }
  if (x.description !== undefined && (typeof x.description !== "string" || x.description.length > 500))
    return "description";
  return null;
}

/** Validate POST /ops/import/apply. Returns the new request or {error}. */
export function newRequest(
  body: Record<string, unknown>,
  now: number,
): { req: ImportRequest } | { error: string } {
  if (!importIdOk(body.id)) return { error: "id must match [a-z0-9][a-z0-9-]{0,62}" };
  if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) return { error: "sha256" };
  const bytes = Number(body.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > IMPORT_BUNDLE_MAX) return { error: "bytes" };
  const overwrite = Array.isArray(body.overwrite) ? body.overwrite : [];
  if (overwrite.length > 200 || !overwrite.every(relOk)) return { error: "overwrite" };
  const remove = Array.isArray(body.remove) ? body.remove : [];
  if (remove.length > 50 || !remove.every(relOk)) return { error: "remove" };
  const cron = Array.isArray(body.cron) ? body.cron : [];
  if (cron.length > IMPORT_CRON_MAX) return { error: "cron: too many" };
  for (const [i, j] of cron.entries()) {
    const p = cronProblem(j);
    if (p) return { error: `cron[${i}]: ${p}` };
  }
  return {
    req: {
      id: body.id,
      sha256: body.sha256,
      bytes,
      overwrite: overwrite as string[],
      remove: remove as string[],
      cron: cron as ImportCron[],
      state: "pending",
      at: now,
      tries: 0,
    },
  };
}

/** True when an open request has gone silent past IMPORT_STALL_MS (measured from the last take, else the ask). */
export const importStalled = (r: ImportRequest | null, now: number) =>
  !!r && (r.state === "pending" || r.state === "running") && now - (r.takenAt ?? r.at) > IMPORT_STALL_MS;

/**
 * Heartbeat side: the request ocsup should run now, or null. A pending request is handed out; a running one only
 * again after IMPORT_RETRY_MS (the boot that took it may be gone). The caller stores the returned `next`.
 */
export function takeForHeartbeat(
  r: ImportRequest | null,
  gen: number,
  now: number,
): { give: ImportRequest; next: ImportRequest } | null {
  if (!r || importStalled(r, now)) return null;
  if (
    r.state === "pending" ||
    (r.state === "running" && (r.takenGen !== gen || now - (r.takenAt ?? 0) > IMPORT_RETRY_MS))
  ) {
    const next: ImportRequest = { ...r, state: "running", takenAt: now, takenGen: gen, tries: r.tries + 1 };
    return { give: next, next };
  }
  return null;
}

/** Fields the heartbeat ack carries (contract docs/07 §4). */
export const ackOf = (r: ImportRequest) => ({
  id: r.id,
  sha256: r.sha256,
  bytes: r.bytes,
  overwrite: r.overwrite,
  remove: r.remove ?? [],
  cron: r.cron,
});
