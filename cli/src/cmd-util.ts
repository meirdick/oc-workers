// Shared parts of the thin /ops commands added in M5b (model, ai-gateway, channels, pairing, config, secrets,
// upgrade, advanced): the loose /ops adapter for model.ts and channels.ts, AI Gateway deps from an OpsCtx,
// the local secrets manifest, edits of oc-host.jsonc, and "apply now or at the next start".
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AigDeps } from "./ai-gateway.ts";
import { setTopLevelJsonc } from "./config.ts";
import type { OpsClient as LooseOps } from "./model.ts";
import {
  CliError,
  EXIT,
  flagBool,
  flagStr,
  type OpsClient,
  type OpsCtx,
  RESTART_CALL_MS,
  readHostConfig,
  registerSecret,
  STATE_DIR,
} from "./ops-lib.ts";
import { readManifest, readTokenFile, updateManifest, writeManifest } from "./secrets.ts";
import { registerSecret as registerUiSecret } from "./ui.ts";

const ANY_STATUS = Array.from({ length: 500 }, (_, i) => i + 100);

/** model.ts / channels.ts take a client that never throws on HTTP status. */
export function looseOps(c: OpsClient): LooseOps {
  return {
    get: (p) => c.call("GET", p, undefined, { allow: ANY_STATUS }),
    post: (p, b) => c.call("POST", p, b ?? {}, { allow: ANY_STATUS }),
  };
}

/** Register with both redact() tables (ops-lib and ui). */
export function registerBoth(v: string): void {
  registerSecret(v);
  registerUiSecret(v);
}

/** AI Gateway deps from an ops context. No hidden prompt in non-interactive mode. */
export function aigDeps(ctx: OpsCtx): AigDeps {
  return {
    fetch: ctx.fetch,
    env: ctx.env,
    askHidden: ctx.nonInteractive ? undefined : (q) => ctx.prompts.askHidden(q),
    readFile: async (f) => {
      const p = resolve(f);
      return { text: await readTokenFile(p, () => {}), mode: (await stat(p)).mode };
    },
    log: (l) => (l.startsWith("WARN: ") ? ctx.out.warn(l.slice(6)) : ctx.out.step(l)),
    registerSecret: registerBoth,
    now: ctx.now,
    sleep: ctx.sleep,
  };
}

/**
 * The AI token for commands that call Cloudflare from the laptop (model list, model set check, model bench).
 * Opt-in (--ai-token-file or env OC_CF_AI_TOKEN). The CLI keeps no copy and the install holds none.
 */
export async function laptopAiToken(ctx: OpsCtx, required: boolean): Promise<string | undefined> {
  const f = flagStr(ctx.args, "ai-token-file");
  let t = "";
  if (f) {
    try {
      t = await readTokenFile(resolve(f), (l) => ctx.out.warn(l));
    } catch (e) {
      throw new CliError(`cannot read ${f} (${(e as Error).message})`, "check the path, then rerun");
    }
  } else t = ctx.env.OC_CF_AI_TOKEN?.trim() ?? "";
  if (t) {
    registerBoth(t);
    return t;
  }
  if (!required) return undefined;
  throw new CliError(
    "no AI token on this machine (the CLI keeps none; the install needs none)",
    "rerun with --ai-token-file <f>, or set OC_CF_AI_TOKEN",
    EXIT.manual,
  );
}

export const manifestPath = (dir: string) => join(dir, STATE_DIR, "secrets.json");

/** Record a secret just set on the Worker (name + sha256, never the value). */
export async function recordSecret(ctx: OpsCtx, name: string, value: string): Promise<void> {
  const p = manifestPath(ctx.dir);
  const m = await readManifest(p);
  await writeManifest(p, updateManifest(m, { [name]: value }, new Date(ctx.now())));
}

/** Set top-level `llm` fields in oc-host.jsonc (comments kept elsewhere). No file → no change. */
export async function patchLlm(
  ctx: OpsCtx,
  patch: { gateway?: string; primary?: string; fallbacks?: string[]; spendLimitUsd?: number },
): Promise<boolean> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = join(ctx.dir, "oc-host.jsonc");
  const cfg = readHostConfig(ctx.dir);
  if (!cfg) return false;
  const llm = { ...(cfg.llm ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (JSON.stringify(llm[k]) !== JSON.stringify(v)) {
      llm[k] = v;
      changed = true;
    }
  }
  if (!changed) return false;
  await writeFile(path, setTopLevelJsonc(await readFile(path, "utf8"), "llm", llm));
  return true;
}

export async function setBaseVersion(ctx: OpsCtx, ver: number): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = join(ctx.dir, "oc-host.jsonc");
  const cfg = readHostConfig(ctx.dir);
  if (!cfg || cfg.baseVersion === ver) return;
  await writeFile(path, setTopLevelJsonc(await readFile(path, "utf8"), "baseVersion", ver));
}

/**
 * A config version or a secret takes effect when the gateway starts. Asleep → the next wake applies it.
 * Running → restart when asked (`restart`), else say how. Returns what happened.
 */
export async function applyChange(
  ctx: OpsCtx,
  ops: OpsClient,
  restart: boolean,
): Promise<"next-wake" | "restarted" | "next-start"> {
  const s = await ops.call("GET", "/ops/status", undefined, { allow: ANY_STATUS });
  const state = String(s.body?.state ?? "");
  if (/^(asleep.*|stopped)$/.test(state)) {
    ctx.out.step(`install is ${state}; the change applies at the next wake`);
    return "next-wake";
  }
  if (restart) {
    await ops.call("POST", "/ops/restart", undefined, { timeoutMs: RESTART_CALL_MS });
    ctx.out.step("planned restart requested; ochost status shows when it is running");
    return "restarted";
  }
  ctx.out.step("the change applies at the next start; ochost restart applies it now");
  return "next-start";
}

/** First positional as a subcommand, checked against a list. */
export function sub(ctx: OpsCtx, allowed: string[], dflt?: string): string {
  const s = ctx.args.positionals[0] ?? dflt;
  if (!s || !allowed.includes(s))
    throw new CliError(
      s ? `unknown subcommand ${s}` : "no subcommand",
      `use one of: ${allowed.join(", ")}`,
      EXIT.usage,
    );
  return s;
}

export const wantRestart = (ctx: OpsCtx) => flagBool(ctx.args, "restart");
