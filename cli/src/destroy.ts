// ochost destroy [--yes] [--delete-data] [--dry-run] (docs/10-cli-spec.md §1.2; was `uninstall` [chg]).
// Prints the plan first. Deletes the Worker, the container apps `<name>-runtime` and `<name>-sandboxsession` (docs/12;
// M7 live F5: the sandbox app and its image tags were left behind) and their registry images. Keeps
// the bucket oc-host-<inst> and its install marker unless --delete-data (asks the bucket name back).
// guess: deleting the Worker leaves the container app and images, so they are deleted one by one.
// docs/11 §8: --delete-data first deletes the file storage objects f/<inst>/ through the Worker (POST /ops/files/purge),
// while the Worker still exists; without --delete-data they stay in the bucket with the archives and the replica.
// `images list --filter` takes no `^` anchor (live 2026-11-01: `^name-` matched nothing); the prefix is checked here.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  CliError,
  confirm,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  type Install,
  loadInstall,
  type OpsCtx,
  oneLine,
  opsClient,
  redact,
  STATE_DIR,
  wrangler,
} from "./ops-lib.ts";

export const destroyFlags: FlagSpec = {
  yes: { type: "boolean", short: "y" },
  "delete-data": { type: "boolean" },
  "dry-run": { type: "boolean" },
  bucket: { type: "string" },
};

export interface DestroyPlan {
  worker: string;
  app: { id: string; name: string } | null;
  /** The SandboxSession container app; null when `sandbox on` never ran. */
  sandboxApp: { id: string; name: string } | null;
  images: string[];
  bucket: string;
  inst: string;
  deleteData: boolean;
}

export const bucketOf = (i: Install) => String(i.state.bucket ?? `oc-host-${i.inst}`);

export function parseJson<T>(s: string, dflt: T): T {
  const i = s.search(/[[{]/);
  if (i < 0) return dflt;
  try {
    return JSON.parse(s.slice(i)) as T;
  } catch {
    return dflt;
  }
}

export async function planDestroy(ctx: OpsCtx, i: Install, deleteData: boolean): Promise<DestroyPlan> {
  const appName = `${i.name}-runtime`;
  const sbxName = `${i.name}-sandboxsession`;
  const apps = parseJson<{ id: string; name: string }[]>(
    (await wrangler(ctx, i, ["containers", "list", "--json", "--per-page", "100"])).stdout,
    [],
  );
  const app = apps.find((a) => a.name === appName) ?? null;
  const sandboxApp = apps.find((a) => a.name === sbxName) ?? null;
  const images: string[] = [];
  // Image tags outlive their app, so both prefixes are listed whether or not the app is still there.
  for (const prefix of [`${appName}-`, `${sbxName}-`]) {
    const repos = parseJson<{ name: string; tags: string[] }[]>(
      (await wrangler(ctx, i, ["containers", "images", "list", "--json", "--filter", prefix])).stdout,
      [],
    );
    images.push(
      ...repos.filter((r) => r.name.startsWith(prefix)).flatMap((r) => r.tags.map((t) => `${r.name}:${t}`)),
    );
  }
  return { worker: i.name, app, sandboxApp, images, bucket: bucketOf(i), inst: i.inst, deleteData };
}

export function planLines(p: DestroyPlan): string[] {
  return [
    `delete Worker ${p.worker}`,
    p.app ? `delete container app ${p.app.name} (${p.app.id})` : "no container app found",
    ...(p.sandboxApp ? [`delete container app ${p.sandboxApp.name} (${p.sandboxApp.id})`] : []),
    `delete ${p.images.length} registry image tag(s)`,
    ...(p.deleteData ? [`delete file storage f/${p.inst}/ (storage location r2)`] : []),
    p.deleteData
      ? `delete bucket ${p.bucket} and all install data`
      : `keep bucket ${p.bucket} (data, file storage f/${p.inst}/ and install marker)`,
  ];
}

export async function destroy(ctx: OpsCtx): Promise<number> {
  const i = loadInstall(ctx);
  const deleteData = flagBool(ctx.args, "delete-data");
  const p = await planDestroy(ctx, i, deleteData);
  const lines = planLines(p);
  for (const l of lines) ctx.out.step(`plan: ${l}`);
  if (flagBool(ctx.args, "dry-run")) {
    if (ctx.out.json) ctx.out.result({ ok: true, dryRun: true, plan: p });
    return EXIT.ok;
  }
  if (!(await confirm(ctx, `Destroy ${p.worker}?`, "yes"))) {
    ctx.out.line("cancelled");
    return EXIT.failed;
  }
  if (deleteData) {
    const typed =
      flagStr(ctx.args, "bucket") ??
      (ctx.nonInteractive
        ? ""
        : await ctx.prompts.ask(`Type the bucket name (${p.bucket}) to delete the data: `));
    if (typed !== p.bucket)
      throw new CliError(
        "the bucket name does not match",
        `rerun with --bucket ${p.bucket}`,
        ctx.nonInteractive ? EXIT.manual : EXIT.failed,
      );
  }
  const done: string[] = [];
  const failed: string[] = [];
  const step = async (what: string, args: string[], input?: string) => {
    const r = await wrangler(ctx, i, args, input);
    if (r.code === 0) done.push(what);
    else failed.push(`${what}: ${oneLine(redact(r.stderr || r.stdout)).slice(0, 160)}`);
    ctx.out.step(`${r.code === 0 ? "done" : "FAILED"}: ${what}`);
  };
  // File storage first: the purge runs in the Worker (R2 binding), so it must happen before the Worker goes.
  if (deleteData) {
    const what = `file storage f/${p.inst}/`;
    try {
      const ops = opsClient(ctx, i);
      let n = 0;
      for (let k = 0; k < 100; k++) {
        const r = await ops.call("POST", "/ops/files/purge", {}, { allow: [200, 404], timeoutMs: 120_000 });
        if (r.status === 404) break; // a Worker older than docs/11 §8 has no files
        n += Number(r.body?.deleted ?? 0);
        if (!r.body?.more) break;
      }
      done.push(`${what} (${n} object(s))`);
      ctx.out.step(`done: ${what}, ${n} object(s)`);
    } catch (e) {
      failed.push(`${what}: ${oneLine(redact(String((e as Error).message ?? e))).slice(0, 160)}`);
      ctx.out.step(`FAILED: ${what}`);
    }
  }
  await step(`Worker ${p.worker}`, ["delete", p.worker, "--force"], "y\n");
  for (const a of [p.app, p.sandboxApp])
    if (a) await step(`container app ${a.name}`, ["containers", "delete", a.id], "y\n");
  for (const img of p.images) await step(`image ${img}`, ["containers", "images", "delete", img], "y\n");
  if (deleteData) await step(`bucket ${p.bucket}`, ["r2", "bucket", "delete", p.bucket], "y\n");
  const st = join(ctx.dir, STATE_DIR, "state.json");
  if (!failed.length && existsSync(st)) renameSync(st, join(ctx.dir, STATE_DIR, "state.destroyed.json"));
  if (ctx.out.json)
    ctx.out.result({ ok: failed.length === 0, done, failed, keptBucket: deleteData ? null : p.bucket });
  else if (!deleteData) ctx.out.line(`bucket ${p.bucket} kept; ochost init in this dir restores from it`);
  if (failed.length)
    throw new CliError(
      `${failed.length} delete step(s) failed: ${failed[0]}`,
      "rerun ochost destroy (done steps are skipped)",
    );
  return EXIT.ok;
}
