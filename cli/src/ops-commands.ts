// The ops commands as one table, for cli/src/index.ts to route (docs/10-cli-spec.md §1.2). runOps() builds the
// context, prints help, maps errors to one "Failed: … — fix: …" line and returns the exit code (§1.1).
import { alerts, alertsFlags } from "./alerts.ts";
import { auth, authFlags } from "./auth.ts";
import { backup, backupFlags } from "./backup.ts";
import { caps, capsFlags } from "./caps.ts";
import { channels, channelsFlags, pairing, pairingFlags } from "./channel-commands.ts";
import { ci, ciFlags } from "./ci.ts";
import {
  ADVANCED_HELP,
  advanced,
  advancedFlags,
  config,
  configFlags,
  secrets,
  secretsFlags,
  settings,
} from "./config-commands.ts";
import { destroy, destroyFlags } from "./destroy.ts";
import { doctor, doctorFlags } from "./doctor.ts";
import { inbox, inboxFlags } from "./inbox.ts";
import { aiGateway, aiGatewayFlags, model, modelFlags } from "./llm-commands.ts";
import { logs, logsFlags } from "./logs.ts";
import { open, openFlags } from "./open.ts";
import {
  EXIT,
  type FlagSpec,
  flagBool,
  makeCtx,
  type OpsCtx,
  processSink,
  redact,
  type Sink,
  toFailed,
} from "./ops-lib.ts";
import { restart, restartFlags } from "./restart.ts";
import { sandbox, sandboxFlags } from "./sandbox.ts";
import { sleep, sleepFlags } from "./sleep.ts";
import { snapshot, snapshotFlags } from "./snapshot.ts";
import { soak, soakFlags } from "./soak.ts";
import { status, statusFlags } from "./status.ts";
import { causeChain } from "./ui.ts";
import { upgrade, upgradeFlags } from "./upgrade.ts";
import { wake, wakeFlags } from "./wake.ts";

export interface OpsCommand {
  flags: FlagSpec;
  run: (ctx: OpsCtx) => Promise<number>;
  usage: string;
  does: string;
  /** Not in `ochost --help` (spec §1.2: advanced is hidden from first-week help). */
  hidden?: boolean;
  /** Extra help lines for `ochost <cmd> -h`. */
  more?: string;
}

export const OPS_COMMANDS: Record<string, OpsCommand> = {
  status: {
    flags: statusFlags,
    run: status,
    usage: "status [--watch]",
    does: "sleep state, next wake, last activity, cost range, alternatives",
  },
  logs: {
    flags: logsFlags,
    run: logs,
    usage: "logs [-f] [--lines N] [--source ctl|rt|ocsup|gate|alert]",
    does: "ring events and container lines, redacted",
  },
  open: {
    flags: openFlags,
    run: open,
    usage: "open [--no-open] [--qr]",
    does: "single-use login link",
  },
  sleep: {
    flags: sleepFlags,
    run: sleep,
    usage:
      "sleep now [--force] [--timeout 120] [--no-wait] | status | set auto|off [--idle-minutes N] [--proactive v]",
    does: "sleep gate and settings",
    more: "--force skips rules 3, 4 and 7; on rule 5 it dead-letters pending inbox rows first (printed).",
  },
  wake: { flags: wakeFlags, run: wake, usage: "wake [--timeout 120]", does: "wake and wait for running" },
  restart: {
    flags: restartFlags,
    run: restart,
    usage: "restart [--hard] [--timeout 300] [--no-wait]",
    does: "planned stop + start",
  },
  backup: {
    flags: backupFlags,
    run: backup,
    usage: "backup list | create [--reason t] | restore <id> [--sqlite src] [--accept-loss]",
    does: "archives",
  },
  snapshot: {
    flags: snapshotFlags,
    run: snapshot,
    usage: "snapshot list | prune [--dry-run] [--yes]",
    does: "sleep snapshots and chain; prune old chains' registry tags",
  },
  auth: {
    flags: authFlags,
    run: auth,
    usage:
      "auth rotate --control|--cookie|--all | sessions [--revoke id|--revoke-all] | access --domain <host> [--idp-hint id] [--token-file f] | access --off",
    does: "owner token, cookie key, sessions, optional Cloudflare Access",
  },
  alerts: {
    flags: alertsFlags,
    run: alerts,
    usage: "alerts list | setup [--channel ntfy|webhook|none] [--url u] | test | ack <code>",
    does: "alert channel",
  },
  caps: {
    flags: capsFlags,
    run: caps,
    usage: "caps | set <browser|neurons|requests|websearch|exec|sandbox> <n>",
    does: "daily budgets for the agent's Cloudflare tools",
  },
  sandbox: {
    flags: sandboxFlags,
    run: sandbox,
    usage: "sandbox [status] | on [--all] | off | sleep",
    does: "tool sandbox: state, budgets, on/off",
  },
  doctor: {
    flags: doctorFlags,
    run: doctor,
    usage: "doctor [--ai-token-file f]",
    does: "PASS/WARN/FAIL checks; never wakes",
  },
  destroy: {
    flags: destroyFlags,
    run: destroy,
    usage: "destroy [--dry-run] [--yes] [--delete-data [--bucket name]]",
    does: "delete the Worker, app and images",
  },
  channels: {
    flags: channelsFlags,
    run: channels,
    usage:
      "channels add telegram [--token-file f] [--wait-pair] [--pair-timeout 10m] | add slack|discord|twilio|sms [--no-wait] [--verify-timeout 5m] | list | remove <channel> [--force]",
    does: "Telegram bot: secret, config version, webhook, pairing",
    more: "sms is twilio. remove --force dead-letters the channel's undelivered inbox rows.",
  },
  inbox: {
    flags: inboxFlags,
    run: inbox,
    usage: "inbox list [--channel X] | drop <id> | drop --all [--channel X] [--state pending]",
    does: "webhook rows the Worker stored: list, dead-letter the ones that never go out",
  },
  pairing: {
    flags: pairingFlags,
    run: pairing,
    usage: "pairing list [telegram] | approve telegram <code> | wait [telegram] [--timeout 10m]",
    does: "approve a DM pairing request",
  },
  model: {
    flags: modelFlags,
    run: model,
    usage:
      "model [list [--all]] | set <id> [--role main|utility|compaction] [--fallback <id>]... [--restart] | bench [--role r] [--models a,b] [--turns 20] [--gate-url u] [--direct --ai-token-file f]",
    does: "models: show each role, list (Workers AI), set a role (default the primary; @cf/... or anthropic/...), bench through the gate",
  },
  "ai-gateway": {
    flags: aiGatewayFlags,
    run: aiGateway,
    usage: "ai-gateway setup [--ai-token-file f] [--gateway id] [--model id] [--restart]",
    does: "AI Gateway choice and a model hop through the gate; no token needed",
  },
  config: {
    flags: configFlags,
    run: config,
    usage: "config get [path] [--ver N] | set <path> <json>|--unset [--restart] [--force] | pull | list",
    does: "OpenClaw config versions",
  },
  settings: {
    flags: {},
    run: settings,
    usage: "settings [show | push]",
    does: "Worker settings document: show it, or push oc-host.jsonc to it (no deploy)",
  },
  secrets: {
    flags: secretsFlags,
    run: secrets,
    usage: "secrets set <NAME> [--from-file f] [--no-restart] | list",
    does: "Worker secrets OC_SECRET_<NAME>, seen by the gateway as env NAME",
  },
  upgrade: {
    flags: upgradeFlags,
    run: upgrade,
    usage: "upgrade check | run [<version>|extended-stable] [--timeout 600] | rollback",
    does: "check the track (exit 3: newer), upgrade the image, roll back",
  },
  advanced: {
    flags: advancedFlags,
    run: advanced,
    usage: "advanced creds|prune|inbox|events",
    does: "low-level views",
    hidden: true,
    more: ADVANCED_HELP,
  },
  soak: {
    flags: soakFlags,
    run: soak,
    usage:
      "soak start <plan>|all [--params '<json>'] | status | stop [<plan>] | report [--plan p] [--out f] [--date YYYY-MM-DD] [--strict]",
    does: "soak plans on a test install (OC_TEST=1)",
    hidden: true,
  },
  ci: {
    flags: ciFlags,
    run: ci,
    usage: "ci setup [--repo owner/name] [--force]",
    does: "GitHub dead-man and CI_TOKEN",
  },
};

const COMMON_HELP = "common: --dir <path> --json --non-interactive -h";

export function opsHelp(name?: string, width = 0): string {
  const c = name ? OPS_COMMANDS[name] : undefined;
  if (c) return `ochost ${c.usage}\n${c.does}\n${c.more ? `${c.more}\n` : ""}${COMMON_HELP}`;
  const shown = Object.entries(OPS_COMMANDS).filter(([, x]) => !x.hidden);
  const w = Math.max(width, ...shown.map(([k]) => k.length));
  return shown.map(([k, c]) => `  ${k.padEnd(w)}  ${c.does}`).join("\n");
}

/** Run one ops command. `over` swaps parts of the context, `sink` the output streams (tests). */
export async function runOps(
  name: string,
  argv: string[],
  over: Partial<OpsCtx> = {},
  sink: Sink = processSink,
): Promise<number> {
  const cmd = OPS_COMMANDS[name];
  const err = (s: string) => sink.stderr(`${s}\n`);
  if (!cmd) {
    err(`Failed: unknown command ${name} — fix: run ochost -h`);
    return EXIT.usage;
  }
  let ctx: OpsCtx;
  try {
    ctx = makeCtx(argv, cmd.flags, over, sink);
  } catch (e) {
    const f = toFailed(e);
    // a usage error is still a result: --json callers read stdout
    if (argv.includes("--json"))
      sink.stdout(`${JSON.stringify({ ok: false, error: f.line, exit: f.code }, null, 2)}\n`);
    err(f.line);
    return f.code;
  }
  if (flagBool(ctx.args, "help")) {
    ctx.out.line(opsHelp(name));
    return EXIT.ok;
  }
  try {
    return await cmd.run(ctx);
  } catch (e) {
    const f = toFailed(e);
    if (ctx.out.json) ctx.out.result({ ok: false, error: f.line, exit: f.code });
    ctx.out.step(f.line);
    if (ctx.env.OCHOST_DEBUG && e instanceof Error && e.stack) ctx.out.step(e.stack);
    if (ctx.env.OCHOST_DEBUG && e instanceof Error && e.cause !== undefined)
      ctx.out.step(`cause: ${redact(causeChain(e.cause))}`);
    return f.code;
  }
}
