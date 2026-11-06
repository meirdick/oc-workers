// ochost snapshot list|prune (docs/10-cli-spec.md §1.2). GET /ops/snapshots (gap W5); while the Worker has no such
// route (404), it shows the chain fields of GET /ops/status: the newest snapshot, chain length, rootfs source.
import { createHash } from "node:crypto";
import { parseJson } from "./destroy.ts";
import {
  CliError,
  confirm,
  EXIT,
  type FlagSpec,
  flagBool,
  fmtAgo,
  kv,
  type OpsCtx,
  oneLine,
  opsClient,
  redact,
  table,
  usage,
  wrangler,
} from "./ops-lib.ts";

export const snapshotFlags: FlagSpec = {
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
};

/** Registry tag of a snapshot: `rootfs-snapshot-<sha256(snapshot id)>` (spike T2-T3 raw/19, two samples). */
export const snapshotTag = (id: string) => `rootfs-snapshot-${createHash("sha256").update(id).digest("hex")}`;

/**
 * ochost snapshot prune [--dry-run] [--yes]: delete the registry tags of old chains. The Control DO plan
 * (GET /ops/snapshots/prune) lists only snapshots of chains older than the live root, and only after one wake
 * from that root worked. Order: the DO marks the ids `pruned` first (it rechecks the plan), then the tags go.
 * guess: the `rootfs-set-<sha256(set id)>` tag of each snapshot stays; the set id is not in the snapshot handle.
 */
async function prune(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const i = ops.install;
  const plan = (await ops.call("GET", "/ops/snapshots/prune")).body ?? {};
  const ids: string[] = Array.isArray(plan.ids) ? plan.ids : [];
  const repo = `${i.name}-runtime-`;
  const repos = parseJson<{ name: string; tags: string[] }[]>(
    (await wrangler(ctx, i, ["containers", "images", "list", "--json", "--filter", repo])).stdout,
    [],
  ).filter((r) => r.name.startsWith(repo));
  const want = new Map(ids.map((id) => [snapshotTag(id), id]));
  const found = repos.flatMap((r) =>
    r.tags.filter((t) => want.has(t)).map((t) => ({ ref: `${r.name}:${t}`, id: want.get(t) as string })),
  );
  const summary = `${ids.length} snapshot(s) of old chains, ${found.length} tag(s) in the registry`;
  if (!plan.ready || !ids.length) {
    if (ctx.out.json) ctx.out.result({ ok: true, ready: !!plan.ready, why: plan.why, deleted: [] });
    else ctx.out.line(`nothing to prune: ${plan.why ?? "no plan"}`);
    return EXIT.ok;
  }
  if (flagBool(ctx.args, "dry-run")) {
    if (ctx.out.json) ctx.out.result({ ok: true, dryRun: true, ids, tags: found.map((f) => f.ref) });
    else ctx.out.line([`plan: ${summary}`, ...found.map((f) => `  delete ${f.ref}`)].join("\n"));
    return EXIT.ok;
  }
  if (!(await confirm(ctx, `delete ${found.length} registry tag(s) of old snapshot chains?`, "yes")))
    return EXIT.ok;
  const mark = (await ops.call("POST", "/ops/snapshots/prune", { ids })).body ?? {};
  const ok = new Set<string>(Array.isArray(mark.pruned) ? mark.pruned : []);
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const f of found.filter((x) => ok.has(x.id))) {
    const r = await wrangler(ctx, i, ["containers", "images", "delete", f.ref], "y\n");
    if (r.code === 0) deleted.push(f.ref);
    else failed.push(`${f.ref}: ${oneLine(redact(r.stderr || r.stdout)).slice(0, 160)}`);
    ctx.out.step(`${r.code === 0 ? "deleted" : "FAILED"}: ${f.ref}`);
  }
  if (ctx.out.json) ctx.out.result({ ok: !failed.length, deleted, failed, refused: mark.refused ?? [] });
  else
    ctx.out.line(
      `deleted ${deleted.length} tag(s); ${(mark.refused ?? []).length} refused by the Control DO`,
    );
  if (failed.length)
    throw new CliError(`${failed.length} tag delete(s) failed: ${failed[0]}`, "rerun ochost snapshot prune");
  return EXIT.ok;
}

export interface SnapRow {
  id: string;
  kind?: string;
  state?: string;
  parent?: string | null;
  chainBase?: string | null;
  createdAt?: number;
  expiresAt?: number | null;
}

export async function snapshot(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0] ?? "list";
  if (sub === "prune") return prune(ctx);
  if (sub !== "list") throw usage(`unknown snapshot command ${sub}`, "use ochost snapshot list or prune");
  const ops = opsClient(ctx);
  const now = ctx.now();
  const r = await ops.call("GET", "/ops/snapshots", undefined, { allow: [200, 404] });
  if (r.status === 200 && Array.isArray(r.body?.snapshots)) {
    const rows: SnapRow[] = r.body.snapshots;
    if (ctx.out.json) ctx.out.result({ ok: true, source: "snapshots", snapshots: rows });
    else
      ctx.out.line(
        rows.length
          ? table(
              ["ID", "KIND", "STATE", "PARENT", "CHAIN BASE", "AGE", "TTL LEFT"],
              rows.map((s) => [
                s.id,
                s.kind ?? "-",
                s.state ?? "-",
                s.parent ?? "-",
                s.chainBase ?? "-",
                fmtAgo(s.createdAt, now),
                s.expiresAt ? fmtAgo(s.expiresAt, now) : "-",
              ]),
            )
          : "no snapshots yet",
      );
    return EXIT.ok;
  }
  const s = (await ops.call("GET", "/ops/status")).body ?? {};
  const x = {
    newest: s.rt?.sleep?.snapshotId ?? null,
    bootFrom: s.gen?.plan?.snapshotId ?? null,
    rootfs: s.gen?.plan?.rootfs ?? null,
    chainLength: s.chainLength ?? null,
  };
  if (ctx.out.json) ctx.out.result({ ok: true, source: "status", ...x });
  else {
    ctx.out.line(
      kv([
        ["newest sleep", x.newest ?? "none"],
        ["boot source", x.rootfs ? `${x.rootfs}${x.bootFrom ? ` ${x.bootFrom}` : ""}` : "-"],
        ["chain length", x.chainLength === null ? "-" : String(x.chainLength)],
      ]),
    );
    ctx.out.warn(
      "the Worker has no /ops/snapshots, so this is the chain summary from /ops/status — fix: ochost deploy",
    );
  }
  return EXIT.ok;
}
