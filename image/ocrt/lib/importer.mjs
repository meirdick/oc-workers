// `ochost import` in the container (docs/10-cli-spec.md §1.2, docs/07 §4 heartbeat ack `import`). The Control DO
// names an open request in the heartbeat ack; ocsup (prod mode only) then:
//   1. downloads the workspace bundle (GET /v1/import/bundle), checks size and sha256;
//   2. merges it into <state>/workspace with ocio `import apply` (uid 1000; add, keep, or replace listed files);
//   3. re-creates the cron jobs with `openclaw cron add --declaration-key` (idempotent per key);
//   4. answers POST /v1/import/done.
// Every step can run again: the apply skips identical files and the declaration key makes cron add an upsert.
// The request waits for a started gateway (cron needs it); after RETRY_MS without that it reports a failure.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IMPORT_READY_WAIT_MS = 5 * 60_000;

/** argv for `openclaw cron add` of one job (no shell; `--opt=value` so a value starting with '-' stays a value). */
export function cronArgs(j) {
  const a = [
    "cron",
    "add",
    `--declaration-key=${j.key}`,
    `--name=${j.name}`,
    `--cron=${j.cron}`,
    `--message=${j.message}`,
    `--session=${j.session || "isolated"}`,
    "--json",
  ];
  if (j.tz) a.push(`--tz=${j.tz}`);
  if (j.agent) a.push(`--agent=${j.agent}`);
  if (!j.enabled) a.push("--disabled");
  if (j.timeoutSeconds) a.push(`--timeout-seconds=${j.timeoutSeconds}`);
  if (j.description) a.push(`--description=${j.description}`);
  if (j.announce) a.push("--announce", `--channel=${j.announce.channel}`, `--to=${j.announce.to}`);
  else a.push("--no-deliver");
  return a;
}

/**
 * o: {gate:{fetchRaw, call}, state, varDir, ocio(name,args,opts) → {json, code, err}, cli(args,opts) → {code, out},
 *     ready() → bool (gateway started), chownForOcio(file), log(ev, o), now?}
 */
export function createImporter(o) {
  const now = o.now || Date.now;
  let busy = null;
  let last = null;
  const done = new Set();

  async function download(req) {
    const file = path.join(o.varDir, `import-${req.id}.tgz`);
    fs.rmSync(file, { force: true });
    const res = await o.gate.fetchRaw(`/v1/import/bundle?id=${encodeURIComponent(req.id)}`, { timeoutMs: 600_000 });
    if (res.status !== 200 || !res.body) throw new Error(`bundle: HTTP ${res.status}`);
    const h = createHash("sha256");
    let size = 0;
    const fd = fs.openSync(file, "w", 0o640);
    fs.fchmodSync(fd, 0o640); // ocsup's umask 077 would leave 0600; ocio (uid 1000) reads it through the group
    try {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk);
        h.update(b);
        size += b.length;
        fs.writeSync(fd, b);
      }
    } finally {
      fs.closeSync(fd);
    }
    const sha = h.digest("hex");
    if (size !== req.bytes || sha !== req.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error(`bundle: ${size} B sha ${sha.slice(0, 12)} != ${req.bytes} B ${String(req.sha256).slice(0, 12)}`);
    }
    o.chownForOcio?.(file);
    return file;
  }

  async function addCron(jobs) {
    const out = [];
    for (const j of jobs || []) {
      const r = await o.cli(["/app/openclaw.mjs", ...cronArgs(j)], { timeoutMs: 60_000 });
      const ok = r.code === 0;
      out.push({ key: j.key, name: j.name, enabled: j.enabled, ok, ...(ok ? {} : { out: String(r.out).slice(-300) }) });
    }
    return out;
  }

  async function run(req) {
    const t0 = now();
    while (!o.ready()) {
      if (now() - t0 > IMPORT_READY_WAIT_MS) throw new Error("gateway not started");
      await new Promise((r) => setTimeout(r, 2000));
    }
    const file = await download(req);
    let ws;
    try {
      const x = await o.ocio(
        "import",
        [
          "apply",
          JSON.stringify({
            archive: file,
            workspace: path.join(o.state, "workspace"),
            stage: path.join(o.state, `.ochost-import-stage-${req.id}`),
            id: req.id,
            overwrite: req.overwrite || [],
            remove: req.remove || [],
          }),
        ],
        { timeoutMs: 600_000 },
      );
      ws = x.json;
      if (!ws?.ok) throw new Error(`apply: ${ws?.error || x.err || `ocio exit ${x.code}`}`.slice(0, 300));
    } finally {
      fs.rmSync(file, { force: true });
    }
    const cron = await addCron(req.cron);
    const { lists, ...counts } = ws;
    return {
      workspace: counts,
      kept: lists?.kept ?? [],
      replaced: lists?.replaced ?? [],
      removed: lists?.removed ?? [],
      cron,
      ms: now() - t0,
    };
  }

  async function serve(req) {
    let ok = true;
    let why;
    let result = null;
    try {
      result = await run(req);
      const bad = result.cron.filter((c) => !c.ok);
      if (bad.length) {
        ok = false;
        why = `cron add failed: ${bad.map((c) => c.name).join(", ")}`;
      }
    } catch (e) {
      ok = false;
      why = String(e?.message || e).slice(0, 400);
    }
    last = { id: req.id, ok, why: why ?? null, at: now(), result };
    o.log?.("import", { id: req.id, ok, why: why ?? null, workspace: result?.workspace ?? null });
    try {
      await o.gate.call("POST", "/v1/import/done", { id: req.id, ok, ...(why ? { why } : {}), result }, { timeoutMs: 15_000 });
      done.add(req.id);
    } catch (e) {
      // The Control DO hands the request out again after its retry window; the apply is idempotent.
      o.log?.("import-done-error", { id: req.id, err: String(e?.message || e).slice(0, 200) });
    }
  }

  return {
    /** From the heartbeat ack. One request at a time; a request this boot already answered is ignored. */
    kick(req) {
      if (!req || typeof req.id !== "string" || busy || done.has(req.id)) return false;
      busy = serve(req).finally(() => {
        busy = null;
      });
      return true;
    },
    status: () => ({ busy: !!busy, last }),
    wait: () => busy ?? Promise.resolve(),
  };
}
