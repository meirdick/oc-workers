// Boot steps of the runtime guard set, in a form the core calls with one line each:
//   netfilterStep()            after cgroups, before any network use (owner-match rule; the caller
//                              exits netfilter-failed when ok is false: fail closed, F-SEC-2)
//   configStep(ctx)            plan step "config": plugin check, render, write openclaw.json (ocio)
//   doctorStep(ctx, cfg)       plan step "doctor": staged Doctor, re-render with the overlay, write
//   startConfigWatch(ctx, cfg) after the gateway spawn: 30 s check + gateway log lines
// ctx: {gate, plan, runOcio(name, args, o), runCli(args, o) (node args), cliEnv() (base env), state,
//       stageDir, log, alert, cgIo, runDir}
import fs from "node:fs";
import path from "node:path";
import { defaultVersion, deprecations, docSha, render, sensitiveChanges } from "./config.mjs";
import { createConfigWatch } from "./configwatch.mjs";
import { afterDoctor, doctorTail, runDoctorStaged } from "./doctor.mjs";
import { openclawCli } from "./guard.mjs";
import { applyRules } from "./netfilter.mjs";
import { checkAtBoot } from "./plugins.mjs";

export const STAGE_U = "/var/lib/ocrt/stage-u";

/** Apply the owner-match rule. Returns {ok, code, err, ms}. No alert: the gate is not reachable yet. */
export function netfilterStep({ log, nets, apply = applyRules } = {}) {
  const r = apply(nets ? { net: nets } : {});
  log?.("netfilter", { ...r, nets: nets ?? null });
  return r;
}

/**
 * A fresh uid-1000 stage dir in root's tree (root makes and chowns its own dir; ocio writes in it), with a
 * uid-1000 0700 `tmp` inside: Doctor's TMPDIR (demo cutover 2026-11-05: every ancestor of Doctor's temp
 * dirs must be uid 1000 or root).
 */
export function freshStageU(dir = STAGE_U, uid = 1000) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of [dir, path.join(dir, "tmp")]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chownSync(d, uid, uid);
  }
  return dir;
}

async function ocioWrite(ctx, file, text) {
  const r = await ctx.runOcio("config-io", ["write", file], { cg: ctx.cgIo, stdin: text, timeoutMs: 20_000 });
  if (!r.json?.ok) throw new Error(`config-io write ${file}: ${r.json?.error || r.code}`);
}
async function ocioRead(ctx, file) {
  const r = await ctx.runOcio("config-io", ["read", file], { cg: ctx.cgIo, timeoutMs: 20_000 });
  return r.json?.ok ? { text: r.json.text } : null;
}

/** Plan step "config". Returns {rec} or {exit, detail}. Stores the result in ctx.cfg for later steps. */
/** Plan §4.9 [Q1.2]: this boot's overlay patch in /run/ocrt/overlay.json (root, 0600). */
export function writeOverlay(ctx, rendered) {
  if (!ctx.runDir) return;
  const f = path.join(ctx.runDir, "overlay.json");
  try {
    fs.writeFileSync(`${f}.tmp`, `${JSON.stringify({ at: Date.now(), overlay: rendered.overlay })}\n`, {
      mode: 0o600,
    });
    fs.renameSync(`${f}.tmp`, f);
  } catch (e) {
    ctx.log?.("overlay-write-failed", { err: e.message });
  }
}

export async function configStep(ctx) {
  const cli = openclawCli(ctx.runCli, ctx.cliEnv);
  const plan = ctx.plan;
  let version;
  if (plan.configVer === null || plan.configVer === undefined) {
    // M4 F9: no config version (fresh install) → the default document, so the gateway gets its managed auth
    // keys and a model; the install works with zero posted config.
    version = defaultVersion(ctx.envNames || []);
  } else
    try {
      version = await ctx.gate.call("GET", `/v1/config/${plan.configVer}`, null, { timeoutMs: 15_000 });
    } catch (e) {
      return { exit: "restore-blocked:infra", detail: `config get: ${e.message}` };
    }
  let manifest = null;
  let plugins = { missing: [] };
  if (plan.pluginsVer !== null && plan.pluginsVer !== undefined) {
    try {
      manifest = await ctx.gate.call("GET", "/v1/plugins/manifest", null, { timeoutMs: 15_000 });
    } catch (e) {
      return { exit: "restore-blocked:infra", detail: `plugins manifest: ${e.message}` };
    }
    plugins = await checkAtBoot(manifest, { runCli: cli, alert: ctx.alert, log: ctx.log });
  }
  const rendered = render(version, plan, { missingPlugins: plugins.missing });
  const file = path.join(ctx.state, "openclaw.json");
  try {
    await ocioWrite(ctx, file, rendered.text);
  } catch (e) {
    return { exit: "ownership", detail: e.message };
  }
  ctx.cfg = { version, rendered, manifest, missingPlugins: plugins.missing, file, writtenAt: Date.now() };
  writeOverlay(ctx, rendered);
  ctx.log?.("config-render", {
    ver: version.ver,
    default: !!version.isDefault,
    sha: rendered.sha,
    overlay: rendered.overlay.map((o) => `${o.path}:${o.why}`),
    proposals: rendered.proposals,
    missingPlugins: plugins.missing,
  });
  for (const note of deprecations(version.doc)) ctx.log?.("config-deprecated", { note });
  return {
    rec: {
      ver: version.ver,
      ...(version.isDefault ? { default: true } : {}),
      sha: rendered.sha,
      overlay: rendered.overlay.length,
      missingPlugins: plugins.missing,
    },
  };
}

/** Plan step "doctor" (after "config"). Returns {rec} or {exit, detail}. */
export async function doctorStep(ctx) {
  const cfg = ctx.cfg;
  const cli = openclawCli(ctx.runCli, ctx.cliEnv);
  const stage = (ctx.freshStage || freshStageU)(ctx.stageDir || STAGE_U);
  const tmpDir = path.join(stage, "tmp");
  if (!cfg) {
    // No config version: plain Doctor on the file in place (first boot of an install).
    const r = await cli(["doctor", "--fix", "--non-interactive"], {
      env: { TMPDIR: tmpDir },
      timeoutMs: 600_000,
    });
    return r.code === 0
      ? { rec: { ms: r.ms, staged: false } }
      : { exit: "doctor-failed", detail: `doctor exit ${r.code}`, out: doctorTail(r.out) };
  }
  const staged = path.join(stage, "openclaw.json");
  const res = await runDoctorStaged(cfg.version, ctx.plan, {
    writeStaged: async (text) => {
      await ocioWrite({ ...ctx }, staged, text);
      return staged;
    },
    readStaged: async (p) => (await ocioRead(ctx, p))?.text ?? null,
    runCli: cli,
    log: ctx.log,
    tmpDir,
  });
  if (res.reason)
    return { exit: res.reason, detail: res.why || `doctor exit ${res.code}`, out: res.out ?? null };
  if (res.changed) {
    const v2 = afterDoctor(cfg.version, res);
    const rendered = render(v2, ctx.plan, { missingPlugins: cfg.missingPlugins });
    await ocioWrite(ctx, cfg.file, rendered.text);
    if (rendered.proposals) {
      const body = {
        source: "doctor",
        sha: docSha(res.doc),
        schemaSha: cfg.version.schemaSha,
        baseVer: cfg.version.ver,
        darkOrigin: false,
        doc: res.doc,
      };
      const sens = sensitiveChanges(cfg.version.doc || {}, res.doc);
      // Doctor's own changes are logged, not alerted: the gate's ring row carries them (ledger config-proposal).
      if (sens.length) ctx.log?.("config-sensitive-doctor", { keys: sens });
      try {
        await ctx.gate.call("PUT", "/v1/config/proposal", body, { timeoutMs: 15_000 });
      } catch (e) {
        ctx.log?.("config-proposal-failed", { source: "doctor", err: e.message });
      }
    } else ctx.log?.("config-proposal-suppressed", { source: "doctor", overlay: rendered.overlay.length });
    cfg.rendered = rendered;
    writeOverlay(ctx, rendered);
    cfg.baseVersion = v2; // the watcher compares with Doctor's doc, so it does not propose it twice
    cfg.writtenAt = Date.now();
  }
  return { rec: { ms: res.ms, staged: true, changed: !!res.changed } };
}

/** Start the config watcher (every 30 s). Returns the watcher; feed gateway lines to onGatewayLine. */
export function startConfigWatch(ctx, { everyMs = 30_000, canAct = () => true } = {}) {
  const cfg = ctx.cfg;
  if (!cfg) return null;
  const w = createConfigWatch(
    {
      readFile: () => ocioRead(ctx, cfg.file),
      propose: async (body) => {
        try {
          await ctx.gate.call("PUT", "/v1/config/proposal", body, { timeoutMs: 15_000 });
          return { status: 200 };
        } catch (e) {
          return { status: e.status ?? null };
        }
      },
      alert: ctx.alert,
      log: ctx.log,
    },
    cfg.rendered,
    cfg.baseVersion || cfg.version,
  );
  w.noteWrite(cfg.rendered.sha);
  const t = setInterval(() => {
    if (canAct()) w.check().catch((e) => ctx.log?.("configwatch-error", { err: String(e) }));
  }, everyMs);
  t.unref?.();
  w.stop = () => clearInterval(t);
  return w;
}
