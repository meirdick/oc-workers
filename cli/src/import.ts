// ochost import <seed-dir> (docs/10-cli-spec.md §1.2): bring an old OpenClaw install into this one.
// Plan: import-plan.ts. Routes: GET /ops/import/files, PUT /ops/import/file, PUT /ops/import/bundle (Worker,
// ops-import.ts); GET /ops/config, POST /ops/config; POST /ops/import/apply, GET /ops/import (Control DO).
// Every step skips what is already there, so a rerun after a cut resumes; --dry-run prints the plan only.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildPlan,
  type ImportRules,
  loadRules,
  mergeDoc,
  type Plan,
  rewritePaths,
  sha256File,
} from "./import-plan.ts";
import {
  CliError,
  confirm,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  kv,
  type OpsCtx,
  opsClient,
  usage,
} from "./ops-lib.ts";

export const importFlags: FlagSpec = {
  rules: { type: "string" },
  feb: { type: "string" },
  media: { type: "string" },
  id: { type: "string" },
  only: { type: "string" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
};

export const IMPORT_HELP = [
  "  <seed-dir>   holds home/ (the old ~/.openclaw) and clawd/ (its workspace)",
  "  --rules <file.json>  owner rules for this old install (keep it outside the repo), all fields optional:",
  '               {"vaults": ["projects/app/vault"], "store": [{"from": "projects/app/records", "to": "records/app"}],',
  '                "parkedSkills": ["some-skill"], "cronSkip": [{"name": "app-sync", "why": "moves to another Worker"}],',
  '                "cronOff": [{"match": "projects/app/", "why": "needs the app Worker"}], "notes": ["Not here: ..."],',
  '                "source": "OpenClaw 2026.7 on a VM", "olderSessions": {"prefix": "history/sessions-old"}}',
  "  --feb <dir>  an older sessions dir: holds agents/<agent>/sessions/ (sessions from before the seed)",
  "  --media <dir> files sent to the old bot",
  "  --only files,workspace,config   run some steps (default: all)",
  "  --dry-run    print the plan; change nothing",
  "  Never copies credentials, .env files, keys, files that look like they hold a key, or the rules' vaults.",
].join("\n");

const STEPS = ["files", "workspace", "config"] as const;
type Step = (typeof STEPS)[number];
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

function summary(p: Plan): [string, string][] {
  const by = (g: string) => p.files.filter((f) => f.group === g);
  const sz = (xs: { bytes: number }[]) => mb(xs.reduce((a, x) => a + x.bytes, 0));
  const ex = new Map<string, number>();
  for (const e of p.excluded) ex.set(e.why, (ex.get(e.why) ?? 0) + 1);
  return [
    [
      "workspace",
      `${p.workspace.length} files, ${sz(p.workspace)} (${p.workspace.filter((w) => w.rewritten).length} with old paths rewritten)`,
    ],
    ["replace", p.overwrite.join(", ") || "-"],
    [
      "renamed",
      p.workspace
        .filter((w) => w.renamedFrom)
        .map((w) => `${w.renamedFrom} → ${w.rel}`)
        .join(", ") || "-",
    ],
    ["remove", p.remove.join(", ") || "-"],
    [
      "store",
      `${by("records").length} files, ${sz(by("records"))} → ${[...new Set(by("records").map((f) => `f/<inst>/${f.key.split("/")[0]}/`))].join(", ") || "-"}`,
    ],
    [
      "transcripts",
      `${by("transcripts").length} files, ${sz(by("transcripts"))} → f/<inst>/history/sessions/`,
    ],
    [
      "transcripts-old",
      `${by("transcripts-old").length} files, ${sz(by("transcripts-old"))} → f/<inst>/${p.olderPrefix}/`,
    ],
    ["media", `${by("media").length} files, ${sz(by("media"))} → f/<inst>/media/`],
    ["parked skills", `${by("skills").length} files → f/<inst>/history/skills/`],
    ["cron", p.cron.map((j) => `${j.name}${j.enabled ? "" : " (off)"}`).join(", ") || "-"],
    ["cron skipped", p.cronSkipped.map((s) => `${s.name}: ${s.why}`).join("; ") || "-"],
    ["config keys", Object.keys(flat(p.config.set)).join(", ") || "-"],
    ["config dropped", p.config.dropped.map((d) => d.path).join(", ") || "-"],
    ["not copied", [...ex].map(([w, n]) => `${n} ${w}`).join(", ") || "-"],
  ];
}

function flat(o: Record<string, unknown>, pre = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const p = pre ? `${pre}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v))
      Object.assign(out, flat(v as Record<string, unknown>, p));
    else out[p] = v;
  }
  return out;
}

export async function importCmd(ctx: OpsCtx): Promise<number> {
  const seed = ctx.args.positionals[0];
  if (!seed) throw usage("ochost import needs <seed-dir>", "run ochost import -h");
  const only = (flagStr(ctx.args, "only") ?? STEPS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of only)
    if (!(STEPS as readonly string[]).includes(s)) throw usage(`--only ${s}`, `use ${STEPS.join(",")}`);
  const want = (s: Step) => only.includes(s);
  let rules: ImportRules = {};
  const rulesFile = flagStr(ctx.args, "rules");
  if (rulesFile)
    try {
      rules = loadRules(rulesFile);
    } catch (e) {
      throw usage(String((e as Error).message), "fix the rules file; ochost import -h shows its fields");
    }
  let plan: Plan;
  try {
    plan = buildPlan(
      { seed, feb: flagStr(ctx.args, "feb"), media: flagStr(ctx.args, "media") },
      new Date(ctx.now()),
      rules,
    );
  } catch (e) {
    throw new CliError(String((e as Error).message), "point ochost import at a seed dir: home/ and clawd/");
  }
  const total = plan.files.reduce((a, f) => a + f.bytes, 0);
  if (flagBool(ctx.args, "dry-run")) {
    if (ctx.out.json)
      ctx.out.result({
        ok: true,
        dryRun: true,
        summary: Object.fromEntries(summary(plan)),
        plan: planJson(plan),
      });
    else ctx.out.line(kv(summary(plan)));
    return EXIT.ok;
  }
  if (!ctx.out.json) ctx.out.line(kv(summary(plan)));
  if (!flagBool(ctx.args, "yes")) {
    if (ctx.nonInteractive)
      throw usage("ochost import changes the install", "pass --yes, or --dry-run first");
    if (!(await confirm(ctx, `Import into this install (${mb(total)} to file storage)?`, "yes")))
      return EXIT.failed;
  }
  const ops = opsClient(ctx);
  const out: Record<string, unknown> = {};
  if (want("files")) out.files = await uploadFiles(ctx, ops.install, plan);
  if (want("config")) out.config = await mergeConfig(ctx, plan);
  if (want("workspace"))
    out.workspace = await applyWorkspace(ctx, ops.install, plan, flagStr(ctx.args, "id"));
  if (ctx.out.json) ctx.out.result({ ok: true, ...out });
  else
    ctx.out.line(
      "Import done. Check: ochost status; ask the agent about an old memory; file_store list history/.",
    );
  const ws = out.workspace as { ok?: boolean } | undefined;
  return ws && ws.ok === false ? EXIT.failed : EXIT.ok;
}

const planJson = (p: Plan) => ({
  workspace: p.workspace.map((w) => ({ rel: w.rel, bytes: w.bytes, rewritten: !!w.rewritten })),
  files: p.files.map((f) => ({ group: f.group, key: f.key, bytes: f.bytes })),
  excluded: p.excluded,
  cron: p.cron.map(({ message, ...j }) => ({ ...j, messageChars: message.length })),
  cronSkipped: p.cronSkipped,
  config: p.config,
  overwrite: p.overwrite,
  remove: p.remove,
});

// ---------------------------------------------------------------- files

type Install = ReturnType<typeof opsClient>["install"];

async function raw(ctx: OpsCtx, install: Install, method: string, path: string, body?: Uint8Array) {
  const r = await ctx.fetch(`${install.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${install.token}`,
      ...(body ? { "content-type": "application/octet-stream", "content-length": String(body.length) } : {}),
    },
    body: body as BodyInit | undefined,
    signal: AbortSignal.timeout(600_000),
  });
  const text = await r.text();
  let j: any = text;
  try {
    j = text ? JSON.parse(text) : {};
  } catch {}
  return { status: r.status, body: j };
}

/**
 * PUT with retries: a reset stream, a timeout or a 5xx/429 is tried again (4 tries, 2-16 s apart). Safe: the route
 * is idempotent (same sha256 → skipped). The last error comes back as status 0 for the failed list.
 */
async function putRetry(ctx: OpsCtx, install: Install, path: string, buf: Uint8Array) {
  let last: { status: number; body: any } = { status: 0, body: { error: "not tried" } };
  for (let t = 1; t <= 4; t++) {
    try {
      last = await raw(ctx, install, "PUT", path, buf);
      if (last.status !== 429 && last.status < 500) return last;
    } catch (e) {
      last = {
        status: 0,
        body: { error: String((e as Error)?.cause ?? (e as Error)?.message ?? e).slice(0, 120) },
      };
    }
    if (t < 4) await ctx.sleep(2_000 * 2 ** (t - 1));
  }
  return last;
}

async function existing(ctx: OpsCtx, install: Install, prefix: string): Promise<Map<string, string | null>> {
  const m = new Map<string, string | null>();
  let cursor: string | null = null;
  do {
    const q = `prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await raw(ctx, install, "GET", `/ops/import/files?${q}`);
    if (r.status !== 200)
      throw new CliError(
        `GET /ops/import/files: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
        "redeploy with this CLI (ochost deploy), then rerun",
      );
    for (const o of r.body.objects ?? []) m.set(o.key, o.sha256 ?? null);
    cursor = r.body.cursor ?? null;
  } while (cursor);
  return m;
}

async function uploadFiles(ctx: OpsCtx, install: Install, plan: Plan) {
  const have = new Map<string, string | null>();
  // Each top-level key dir of the plan, and history/ for INDEX.json.
  const tops = new Set(["history/", ...plan.files.map((f) => `${f.key.split("/")[0]}/`)]);
  for (const p of tops) for (const [k, v] of await existing(ctx, install, p)) have.set(k, v);
  let sent = 0;
  let skipped = 0;
  let bytes = 0;
  const failed: { key: string; why: string }[] = [];
  const todo = [...plan.files];
  const index = Object.fromEntries(plan.files.map((f) => [f.key, `${f.group}:${f.original}`]));
  const idx = new TextEncoder().encode(JSON.stringify(index, null, 1));
  const idxSrc = join(mkdtempSync(join(tmpdir(), "ochost-import-")), "INDEX.json");
  writeFileSync(idxSrc, idx);
  todo.push({
    group: "records",
    key: "history/INDEX.json",
    src: idxSrc,
    bytes: idx.length,
    original: "INDEX.json",
  });
  let i = 0;
  let last = ctx.now();
  const worker = async () => {
    for (;;) {
      const f = todo[i++];
      if (!f) return;
      const sha = await sha256File(f.src);
      const cur = have.get(f.key);
      if (cur === sha) {
        skipped++;
        continue;
      }
      const buf = readFileSync(f.src);
      const r = await putRetry(
        ctx,
        install,
        `/ops/import/file?key=${encodeURIComponent(f.key)}&sha256=${sha}`,
        buf,
      );
      if (r.status === 200) {
        if (r.body.skipped) skipped++;
        else {
          sent++;
          bytes += f.bytes;
        }
      } else if (r.status === 409 && f.key === "history/INDEX.json")
        // File storage never overwrites; an index from an earlier, different plan stays. The keys still match.
        ctx.out.warn("history/INDEX.json exists from an earlier import with other files; kept it");
      else failed.push({ key: f.key, why: `${r.status} ${String(r.body?.error ?? "").slice(0, 80)}` });
      if (ctx.now() - last > 10_000) {
        last = ctx.now();
        ctx.out.step(
          `files: ${sent} sent, ${skipped} already there, ${failed.length} failed of ${todo.length}`,
        );
      }
    }
  };
  // Two at a time: more parallel PUTs get HTTP/2 ENHANCE_YOUR_CALM from the edge (live check oc-m9-import).
  await Promise.all([worker(), worker()]);
  rmSync(dirname(idxSrc), { recursive: true, force: true });
  ctx.out.step(`files: ${sent} sent (${mb(bytes)}), ${skipped} already there, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed.slice(0, 5)) ctx.out.warn(`file ${f.key}: ${f.why}`);
    throw new CliError(
      `${failed.length} files did not upload`,
      "fix the cause shown above, then rerun ochost import (it resumes)",
    );
  }
  return { sent, skipped, bytes };
}

// ---------------------------------------------------------------- config

async function mergeConfig(ctx: OpsCtx, plan: Plan) {
  const ops = opsClient(ctx);
  const l = await ops.call("GET", "/ops/config");
  const vers: { ver: number }[] = l.body?.versions ?? [];
  if (!vers.length) throw new CliError("no config version yet", "finish ochost init first");
  const ver = Math.max(...vers.map((v) => v.ver));
  const cur = (await ops.call("GET", `/ops/config/${ver}`)).body?.doc ?? {};
  const next = mergeDoc(cur, plan.config.set);
  if (JSON.stringify(next) === JSON.stringify(cur)) {
    ctx.out.step(`config: v${ver} already has the imported keys`);
    return { ver, changed: false };
  }
  const r = await ops.call("POST", "/ops/config", { doc: next, baseVer: ver });
  const nv = r.body?.ver ?? null;
  ctx.out.step(
    `config: v${ver} → v${nv} (${Object.keys(flat(plan.config.set)).length} keys); applies at the next boot`,
  );
  return { ver: nv, changed: true };
}

// ---------------------------------------------------------------- workspace

/** Deterministic tar.gz of the workspace part (sorted names, fixed mtime and owner), so a rerun has the same id. */
async function bundle(
  ctx: OpsCtx,
  plan: Plan,
): Promise<{ file: string; dir: string; sha: string; bytes: number }> {
  const dir = mkdtempSync(join(tmpdir(), "ochost-import-"));
  const root = join(dir, "ws");
  for (const w of plan.workspace) {
    const dest = join(root, w.rel);
    await mkdir(dirname(dest), { recursive: true });
    const b = readFileSync(w.src);
    writeFileSync(dest, w.rewritten ? rewritePaths(b.toString("utf8")) : b);
  }
  const note = join(root, plan.note.rel);
  await mkdir(dirname(note), { recursive: true });
  writeFileSync(note, plan.note.text);
  const file = join(dir, "bundle.tar.gz");
  const r = await ctx.run(
    "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mode=u+rw,go+r",
      "-czf",
      file,
      "-C",
      root,
      ".",
    ],
    { env: { GZIP: "-n" } },
  );
  if (r.code !== 0) throw new CliError(`tar failed: ${r.stderr.slice(-200)}`, "install GNU tar, then rerun");
  return { file, dir, sha: await sha256File(file), bytes: statSync(file).size };
}

async function applyWorkspace(ctx: OpsCtx, install: Install, plan: Plan, idFlag?: string) {
  const ops = opsClient(ctx, install);
  const b = await bundle(ctx, plan);
  try {
    const id = idFlag ?? `seed-${b.sha.slice(0, 12)}`;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))
      throw usage(`--id ${id}`, "use lower-case letters, digits and -");
    const put = await putRetry(
      ctx,
      install,
      `/ops/import/bundle?id=${id}&sha256=${b.sha}`,
      readFileSync(b.file),
    );
    if (put.status !== 200)
      throw new CliError(
        `PUT /ops/import/bundle: HTTP ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`,
        "rerun ochost import",
      );
    ctx.out.step(`workspace: bundle ${id} ${put.body.skipped ? "already there" : `sent (${mb(b.bytes)})`}`);
    const a = await ops.call(
      "POST",
      "/ops/import/apply",
      { id, sha256: b.sha, bytes: b.bytes, overwrite: plan.overwrite, remove: plan.remove, cron: plan.cron },
      { allow: [202, 400, 409] },
    );
    if (a.status !== 202)
      throw new CliError(
        `POST /ops/import/apply: ${a.status} ${JSON.stringify(a.body).slice(0, 300)}`,
        "ochost import status shows the open request; rerun when it ends",
      );
    ctx.out.step(
      `workspace: request ${id} ${a.body.same ? "already open" : "queued"}; the install wakes and applies it`,
    );
    const t0 = ctx.now();
    for (;;) {
      const s = (await ops.call("GET", "/ops/import")).body?.request;
      if (s?.id === id && (s.state === "done" || s.state === "failed")) {
        const w = s.result?.workspace ?? {};
        const cron = (s.result?.cron ?? []) as { name: string; ok: boolean }[];
        ctx.out.step(
          `workspace: ${s.state}${s.why ? ` (${s.why})` : ""}; added ${w.added ?? 0}, same ${w.same ?? 0}, replaced ${w.replaced ?? 0}, kept ${w.kept ?? 0}, removed ${w.removed ?? 0}, skipped ${w.skipped ?? 0}; cron ${cron.filter((c) => c.ok).length}/${cron.length}`,
        );
        const sandbox = s.state === "done" ? await sandboxMerge(ctx, id) : null;
        return { ok: s.state === "done", id, result: s.result ?? null, why: s.why ?? null, sandbox };
      }
      if (ctx.now() - t0 > 20 * 60_000)
        throw new CliError(
          `import ${id} still ${s?.state ?? "unknown"} after 20 min`,
          "ochost status; ochost logs --source ocsup; rerun to wait again",
          EXIT.budget,
        );
      await ctx.sleep(5_000);
    }
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
}

/**
 * With the sandbox on, chats work in the sandbox's own copy of the workspace, seeded once (docs/12 §5). The Worker
 * merges the same bundle there (worker/src/sbx/import.ts). A sandbox never seeded is skipped: it seeds from the
 * gateway copy, which has the import.
 */
async function sandboxMerge(ctx: OpsCtx, id: string) {
  const ops = opsClient(ctx);
  const r = await ops.call(
    "POST",
    "/ops/import/sandbox",
    { id },
    { allow: [200, 404, 409, 502], timeoutMs: 900_000 },
  );
  if (r.status === 404) {
    ctx.out.warn(
      "this Worker has no /ops/import/sandbox; run ochost deploy, then ochost import --only workspace",
    );
    return { ok: false, why: "route missing" };
  }
  if (r.status !== 200) {
    ctx.out.warn(`sandbox merge: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return { ok: false, why: String(r.body?.why ?? r.body?.error ?? r.status) };
  }
  if (r.body.skipped) ctx.out.step(`sandbox: ${r.body.skipped}`);
  else {
    const t = (r.body.targets ?? []) as { added: number; replaced: number; kept: number }[];
    ctx.out.step(
      t.length
        ? `sandbox: merged into ${t.length} workspace(s); added ${t.reduce((a, x) => a + x.added, 0)}, replaced ${t.reduce((a, x) => a + x.replaced, 0)}, kept ${t.reduce((a, x) => a + x.kept, 0)}`
        : "sandbox: not seeded yet; its first use copies the imported workspace",
    );
  }
  return r.body;
}
