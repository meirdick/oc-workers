// ochost backup list|create|restore (docs/10-cli-spec.md §1.2). Routes: GET /ops/archive (index, cadence,
// last drill), POST /ops/archive {reason} (archive now; wakes the install), POST /ops/restore (op l5).
// restore prints the loss window first and needs --accept-loss or a y/N.
import {
  CliError,
  confirm,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  fmtAgo,
  fmtTime,
  kv,
  type OpsCtx,
  opsClient,
  table,
  usage,
} from "./ops-lib.ts";

export const backupFlags: FlagSpec = {
  reason: { type: "string" },
  yes: { type: "boolean", short: "y" },
  "accept-loss": { type: "boolean" },
  sqlite: { type: "string" },
  limit: { type: "string" },
};

export interface ArchiveRow {
  id: string;
  kind?: string;
  state: string;
  reason?: string | null;
  size?: number | null;
  created_at: number;
  completed_at?: number | null;
  verified_at?: number | null;
  bad_reason?: string | null;
}

const fmtSize = (n: number | null | undefined) =>
  n == null
    ? "-"
    : n >= 1e9
      ? `${(n / 1e9).toFixed(2)} GB`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${Math.round(n / 1e3)} kB`;

/** archiveDue() is a boolean or {due, why}. */
export function fmtDue(d: unknown): string {
  if (typeof d === "boolean") return d ? "yes" : "no";
  if (d && typeof d === "object") {
    const o = d as { due?: boolean; why?: string };
    return `${o.due ? "yes" : "no"}${o.why ? ` (${o.why})` : ""}`;
  }
  return "-";
}

export async function backup(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0] ?? "list";
  if (sub === "list") return list(ctx);
  if (sub === "create") return create(ctx);
  if (sub === "restore") return restore(ctx);
  throw usage(`unknown backup command ${sub}`, "use ochost backup list|create|restore <id>");
}

async function list(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const lim = Number(flagStr(ctx.args, "limit") ?? 20) || 20;
  const b = (await ops.call("GET", `/ops/archive?limit=${lim}`)).body ?? {};
  const now = ctx.now();
  const rows: ArchiveRow[] = Array.isArray(b.archives) ? b.archives : [];
  if (ctx.out.json) {
    ctx.out.result({ ok: true, ...b });
    return EXIT.ok;
  }
  const everyH =
    typeof b.cfg?.everyMs === "number" ? `${Math.round(b.cfg.everyMs / 3_600_000)} h while awake` : "-";
  ctx.out.line(
    kv([
      ["newest", b.newestAgeMs == null ? "none yet" : `${fmtAgo(now - b.newestAgeMs, now)}`],
      ["cadence", everyH],
      ["due", fmtDue(b.due)],
      [
        "last drill",
        b.drill
          ? `${b.drill.ok ? "pass" : "FAIL"} ${fmtAgo(b.drill.at ?? b.drill.finishedAt, now)}`
          : "never",
      ],
      ["request", b.request ? `${b.request.reason ?? "owner"} ${fmtAgo(b.request.at, now)}` : "none"],
    ]),
  );
  if (!rows.length) {
    ctx.out.line("no archives yet — ochost backup create makes one");
    return EXIT.ok;
  }
  ctx.out.line("");
  ctx.out.line(
    table(
      ["ID", "STATE", "KIND", "REASON", "SIZE", "AGE", "VERIFIED"],
      rows.map((r) => [
        r.id,
        r.state + (r.bad_reason ? ` (${r.bad_reason})` : ""),
        r.kind ?? "-",
        r.reason ?? "-",
        fmtSize(r.size),
        fmtAgo(r.created_at, now),
        r.verified_at ? fmtAgo(r.verified_at, now) : "no",
      ]),
    ),
  );
  return EXIT.ok;
}

async function create(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  // The Worker takes reason owner|pre-upgrade|post-rollback; free text goes in `note` (kept in the ring).
  const note = flagStr(ctx.args, "reason");
  const r = await ops.call("POST", "/ops/archive", { reason: "owner", ...(note ? { note } : {}) });
  const woke = r.body?.woke?.body ?? r.body?.woke;
  if (ctx.out.json) ctx.out.result({ ok: true, request: r.body?.request ?? null, woke: woke ?? null });
  else {
    ctx.out.line("archive requested; the install is awake for it");
    ctx.out.line("next: ochost backup list (the new archive shows as complete in a few minutes)");
  }
  return EXIT.ok;
}

/** Loss window: writes after this time are lost by the restore. */
export function lossFrom(src: string, archives: ArchiveRow[]): number | null {
  const m = /^(pitr|archive):(.+)$/.exec(src);
  if (!m) return null;
  if (m[1] === "pitr") {
    const t = /^\d+$/.test(m[2] as string) ? Number(m[2]) : Date.parse(m[2] as string);
    return Number.isFinite(t) ? t : null;
  }
  const a = archives.find((x) => x.id === m[2]);
  return a ? (a.completed_at ?? a.created_at) : null;
}

async function restore(ctx: OpsCtx): Promise<number> {
  const id = ctx.args.positionals[1];
  const src = flagStr(ctx.args, "sqlite") ?? (id ? `archive:${id}` : undefined);
  if (!src)
    throw usage(
      "backup restore needs an archive id",
      "run ochost backup list, then ochost backup restore <id>",
    );
  if (!/^(pitr|archive):.+$/.test(src))
    throw usage("--sqlite must be pitr:<time> or archive:<id>", "for example --sqlite archive:a-123");
  const ops = opsClient(ctx);
  const idx = (await ops.call("GET", "/ops/archive?limit=200")).body ?? {};
  const archives: ArchiveRow[] = Array.isArray(idx.archives) ? idx.archives : [];
  if (src.startsWith("archive:")) {
    const a = archives.find((x) => x.id === src.slice(8));
    if (!a) throw new CliError(`no archive ${src.slice(8)}`, "run ochost backup list for the ids");
    if (a.state !== "complete")
      throw new CliError(`archive ${a.id} is ${a.state}, not complete`, "pick a complete archive");
  }
  const now = ctx.now();
  const from = lossFrom(src, archives);
  const window = from
    ? `Writes after ${fmtTime(from)} UTC (${fmtAgo(from, now)}) are lost.`
    : "The loss window is not known.";
  ctx.out.step(`Restore ${src}. ${window}`);
  const ok =
    flagBool(ctx.args, "accept-loss") || (await confirm(ctx, "Restore and accept this loss?", "accept-loss"));
  if (!ok) {
    ctx.out.line("cancelled");
    return EXIT.failed;
  }
  const r = await ops.call("POST", "/ops/restore", { sqlite: src, acceptLoss: true });
  if (ctx.out.json) ctx.out.result({ ok: true, lossFrom: from, ...r.body });
  else {
    ctx.out.line(`restore op ${r.body?.opId ?? "-"} ${r.body?.phase ?? ""}`.trim());
    if (r.body?.note) ctx.out.warn(String(r.body.note));
    ctx.out.line("next: ochost status");
  }
  return EXIT.ok;
}
