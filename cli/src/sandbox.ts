// ochost sandbox [status] | on | off | sleep (docs/12 §7). on|off writes oc-host.jsonc `sandbox`; the Worker reads it
// from OC_SETTINGS (like sleep set, gap W8), and ocsup renders the OpenClaw sandbox keys at the next gateway boot.
// status: GET /ops/sandbox (never wakes the sandbox). sleep: POST /ops/sandbox/sleep (back up, then stop).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT, type FlagSpec, fmtAgo, kv, type OpsCtx, opsClient, usage } from "./ops-lib.ts";

export const sandboxFlags: FlagSpec = {};

/** Set the top-level `"sandbox": "on|off"` in the JSONC text, keeping comments; insert it after `{` when absent. */
export function setSandboxKey(text: string, v: "on" | "off"): string {
  const re = /("sandbox"\s*:\s*)"(?:on|off)"/;
  if (re.test(text)) return text.replace(re, `$1"${v}"`);
  const i = text.indexOf("{");
  if (i < 0) throw new CliError("oc-host.jsonc is not an object", "run ochost config pull, or ochost init");
  return `${text.slice(0, i + 1)}\n  "sandbox": "${v}",                       // on | off: agent exec and file tools in a Cloudflare sandbox (docs/12)${text.slice(i + 1)}`;
}

interface Use {
  used: number;
  limit: number;
  pct: number;
}

export async function sandbox(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0] ?? "status";
  if (sub === "on" || sub === "off") return sandboxSet(ctx, sub);
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

function sandboxSet(ctx: OpsCtx, v: "on" | "off"): number {
  const path = join(ctx.dir, "oc-host.jsonc");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`no oc-host.jsonc in ${ctx.dir}`, "run ochost config pull, or ochost init");
  }
  writeFileSync(path, setSandboxKey(text, v));
  const next = "ochost deploy, then ochost restart (the gateway renders its sandbox config at boot)";
  if (ctx.out.json) ctx.out.result({ ok: true, sandbox: v, applied: false, next });
  else {
    ctx.out.line(`oc-host.jsonc: sandbox = ${v}`);
    ctx.out.line(`next: ${next}`);
  }
  return EXIT.ok;
}
