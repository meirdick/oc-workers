// ochost logs [-f] [--lines N] [--source ctl|rt|ocsup|gate|alert] (docs/10-cli-spec.md §1.2).
// GET /ops/logs?limit=N reads the Control DO ring. Container log lines come in through the ControlGate log sink
// (POST /v1/log → ring src "log"); the other rows are Control/Runtime events. Redacted. -f polls every 2 s.
import {
  EXIT,
  type FlagSpec,
  flagBool,
  flagInt,
  flagStr,
  fmtTime,
  type OpsCtx,
  opsClient,
  redact,
  usage,
} from "./ops-lib.ts";

export const logsFlags: FlagSpec = {
  follow: { type: "boolean", short: "f" },
  lines: { type: "string", short: "n" },
  source: { type: "string" },
};

export interface RingRow {
  id: number;
  at: number;
  src: string;
  kind: string;
  detail: string | null;
}

export const SOURCES = ["ctl", "rt", "ocsup", "gate", "alert"] as const;
export type Source = (typeof SOURCES)[number];

/** Ring `src` → CLI source. `log` rows are the ControlGate log sink (container stdout/stderr tail). */
export function sourceOf(src: string): Source {
  if (src === "log" || src === "gate") return "gate";
  if (src === "rt" || src === "ws" || src === "alarm") return "rt";
  if (src === "ocsup") return "ocsup";
  if (src === "alert") return "alert";
  return "ctl";
}

export function fmtRow(r: RingRow): string {
  const d = r.detail ?? "";
  const body = r.src === "log" ? d : `${r.kind}${d ? ` ${d}` : ""}`;
  return redact(`${fmtTime(r.at)}  ${sourceOf(r.src).padEnd(5)}  ${body}`.replace(/[\r\n]+/g, " "));
}

const POLL_MS = 2000;

export async function logs(ctx: OpsCtx): Promise<number> {
  const lines = flagInt(ctx.args, "lines", 200, 1, 500);
  const src = flagStr(ctx.args, "source");
  if (src !== undefined && !(SOURCES as readonly string[]).includes(src))
    throw usage(`--source must be one of ${SOURCES.join(", ")}`, "pass --source gate for container lines");
  const follow = flagBool(ctx.args, "follow");
  const ops = opsClient(ctx);
  const keep = (r: RingRow) => !src || sourceOf(r.src) === src;
  let lastId = 0;
  const fetchRows = async (limit: number): Promise<RingRow[]> => {
    const r = await ops.call<{ events?: RingRow[] }>("GET", `/ops/logs?limit=${limit}`);
    const rows = Array.isArray(r.body?.events) ? r.body.events : [];
    return rows.filter((x) => typeof x?.id === "number").sort((a, b) => a.id - b.id);
  };
  const emit = (rows: RingRow[]) => {
    const shown = rows.filter((r) => r.id > lastId);
    for (const r of shown) {
      if (!keep(r)) continue;
      if (ctx.out.json)
        ctx.out.result({ ...r, source: sourceOf(r.src), detail: r.detail && redact(r.detail) });
      else ctx.out.line(fmtRow(r));
    }
    if (shown.length) lastId = Math.max(lastId, ...shown.map((r) => r.id));
  };
  const first = await fetchRows(src ? 500 : lines);
  const firstKept = first.filter(keep).slice(-lines);
  // Start after the newest row the filter dropped, so the first page is exactly the last N kept rows.
  lastId = firstKept.length ? (firstKept[0] as RingRow).id - 1 : (first.at(-1)?.id ?? 0);
  if (ctx.out.json && !follow) {
    ctx.out.result({
      ok: true,
      events: firstKept.map((r) => ({ ...r, source: sourceOf(r.src), detail: r.detail && redact(r.detail) })),
    });
    return EXIT.ok;
  }
  emit(firstKept);
  lastId = Math.max(lastId, first.at(-1)?.id ?? 0);
  if (!follow) return EXIT.ok;
  while (!ctx.signal?.aborted) {
    await ctx.sleep(POLL_MS);
    if (ctx.signal?.aborted) break;
    const rows = await fetchRows(500);
    // The ring keeps 500 rows; a gap means rows were dropped between polls.
    if (rows.length && (rows[0] as RingRow).id > lastId + 1 && lastId > 0)
      ctx.out.warn(
        `${(rows[0] as RingRow).id - lastId - 1} log rows dropped between polls — fix: ochost logs --lines 500 shows what is left`,
      );
    emit(rows);
  }
  return EXIT.ok;
}
