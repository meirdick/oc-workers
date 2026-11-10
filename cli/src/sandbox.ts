// ochost sandbox [status] | on [--all] | off | sleep (docs/12 §7). on|off writes oc-host.jsonc `sandbox`; the Worker reads it
// from OC_SETTINGS (like sleep set, gap W8), and ocsup renders the OpenClaw sandbox keys at the next gateway boot.
// status: GET /ops/sandbox (never wakes the sandbox). sleep: POST /ops/sandbox/sleep (back up, then stop).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccessHooks, realAccessHooks } from "./access.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  fmtAgo,
  kv,
  loadInstall,
  type OpsCtx,
  opsClient,
  usage,
} from "./ops-lib.ts";

export const sandboxFlags: FlagSpec = { all: { type: "boolean" }, apply: { type: "boolean" } };

/** Set the top-level `"sandbox": "on|all|off"` in the JSONC text, keeping comments; insert it after `{` when absent. */
export function setSandboxKey(text: string, v: "on" | "all" | "off"): string {
  const re = /("sandbox"\s*:\s*)"(?:on|all|off)"/;
  if (re.test(text)) return text.replace(re, `$1"${v}"`);
  const i = text.indexOf("{");
  if (i < 0) throw new CliError("oc-host.jsonc is not an object", "run ochost config pull, or ochost init");
  return `${text.slice(0, i + 1)}\n  "sandbox": "${v}",                       // off | on (every channel chat, Telegram too; not the Control UI chat) | all: exec and file tools in a Cloudflare sandbox${text.slice(i + 1)}`;
}

interface Use {
  used: number;
  limit: number;
  pct: number;
}

export async function sandbox(ctx: OpsCtx, hooks: AccessHooks = realAccessHooks): Promise<number> {
  const sub = ctx.args.positionals[0] ?? "status";
  if (sub === "on" || sub === "off")
    return sandboxSet(ctx, sub === "on" && ctx.args.flags.all === true ? "all" : sub, hooks);
  const ops = opsClient(ctx);
  if (sub === "sleep") {
    const r = (await ops.call("POST", "/ops/sandbox/sleep")).body as { slept?: boolean; why?: string };
    if (ctx.out.json) ctx.out.result({ ok: true, ...r });
    else ctx.out.line(r.slept ? "sandbox asleep (workspace backed up)" : `not slept: ${r.why ?? "unknown"}`);
    return EXIT.ok;
  }
  if (sub !== "status")
    throw usage(`unknown sandbox command ${sub}`, "use ochost sandbox [status|on|off|sleep]");
  const s = (await ops.call("GET", "/ops/sandbox")).body as Record<string, any>;
  if (ctx.out.json) {
    ctx.out.result({ ok: true, ...s });
    return EXIT.ok;
  }
  const pct = (u: Use | undefined, unit: string, f = 0) =>
    u ? `${u.used.toFixed(f)}${unit} of ${u.limit}${unit} today (${Math.round(u.pct * 100)}%)` : "-";
  const now = ctx.now();
  ctx.out.line(
    kv([
      ["state", String(s.state ?? "unknown")],
      ["last use", s.lastUseAt ? fmtAgo(s.lastUseAt, now) : "never"],
      ["last backup", s.lastBackupAt ? fmtAgo(s.lastBackupAt, now) : "none"],
      ["last sleep", String(s.lastSleep ?? "-")],
      ["wakes", String(s.wakes ?? 0)],
      ["exec", pct(s.exec, "s")],
      ["sandbox", pct(s.sandbox, "h", 2)],
    ]),
  );
  return EXIT.ok;
}

async function sandboxSet(ctx: OpsCtx, v: "on" | "all" | "off", hooks: AccessHooks): Promise<number> {
  const path = join(ctx.dir, "oc-host.jsonc");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`no oc-host.jsonc in ${ctx.dir}`, "run ochost config pull, or ochost init");
  }
  writeFileSync(path, setSandboxKey(text, v));
  if (flagBool(ctx.args, "apply")) {
    if (!ctx.out.json) ctx.out.line(`oc-host.jsonc: sandbox = ${v}`);
    try {
      await hooks.deploy(ctx, loadInstall(ctx));
    } catch (e) {
      throw new CliError(
        `deploy failed: ${(e as Error).message.slice(0, 120)}`,
        "oc-host.jsonc is changed; fix the cause, then ochost deploy and ochost restart",
      );
    }
    let restarted: string;
    try {
      restarted = await hooks.restart(ctx);
    } catch (e) {
      ctx.out.warn(
        `restart failed (${(e as Error).message.slice(0, 80)}) — fix: ochost restart, so the gateway renders its sandbox config`,
      );
      restarted = "failed";
    }
    if (ctx.out.json)
      ctx.out.result({ ok: true, sandbox: v, applied: true, deployed: true, restart: restarted });
    else ctx.out.line(`deployed; restart: ${restarted}`);
    return EXIT.ok;
  }
  const next =
    "ochost deploy, then ochost restart (the gateway renders its sandbox config at boot), or run again with --apply";
  if (ctx.out.json) ctx.out.result({ ok: true, sandbox: v, applied: false, next });
  else {
    ctx.out.line(`oc-host.jsonc: sandbox = ${v}`);
    ctx.out.line(`next: ${next}`);
  }
  return EXIT.ok;
}
