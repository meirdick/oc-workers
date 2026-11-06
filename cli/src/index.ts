// ochost CLI entry: command table, help, global flags (--dir, --json, --non-interactive). Pattern from
// cf-orbs cli/src/index.ts. init and deploy are here; every other spec 10 §1.2 command is in ops-commands.ts.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { cliVersion, deployCommand } from "./deploy.ts";
import { initCommand } from "./init.ts";
import { OPS_COMMANDS, opsHelp, runOps } from "./ops-commands.ts";
import {
  CliError,
  type Ctx,
  causeChain,
  EXIT,
  exitCodeOf,
  type FlagSpec,
  flagBool,
  flagString,
  installSigint,
  makeUi,
  type ParsedArgs,
  parseArgs,
  redact,
  toFailedLine,
  ttyPrompter,
  type Ui,
} from "./ui.ts";
import { runProcess } from "./wrangler.ts";

const GLOBAL: FlagSpec = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  verbose: { type: "boolean" },
  dir: { type: "string" },
};

export interface Command {
  usage: string;
  summary: string;
  flags: FlagSpec;
  details?: string[];
  /** first positional is the project dir (init [dir]) */
  dirPositional?: boolean;
  run: (ctx: Ctx) => Promise<number>;
}

export const COMMANDS: Record<string, Command> = {
  init: {
    usage: "init [dir]",
    summary: "Set up an install end to end: deploy, config, first start, login link. Re-run safe.",
    details: [
      "--account-id <id>        Cloudflare account (else CLOUDFLARE_ACCOUNT_ID, else the only one, else ask)",
      "--name <name>            Worker name (default oc-host); URL https://<name>.<sub>.workers.dev",
      "--subdomain <name>       workers.dev subdomain to register when the account has none",
      "--adopt                  manage an existing install from this dir (new control token, no image change)",
      "--gateway <id>           AI Gateway for logs and limits (default: default, made on first use; none = no gateway)",
      "--ai-token-file <file>   optional: a token with AI Gateway Read+Edit lets init find or create the gateway; not stored",
      "--model <id>             model (default @cf/deepseek-ai/deepseek-v4.1-flash-1017)",
      "--instance <v/G/D>       vcpu/GiB/GB (default 2/6/20)",
      "--bucket <name>          R2 bucket (default oc-host-<inst>)",
      "--skip-ai                no model now; the install comes up without one",
      "--no-open                print the login link; do not open the browser",
      "--accept-loss            allow a fresh install over existing data",
      "--verbose                print every detail line, not one line per step",
      "--fake-telegram          test install: OC_TEST=1, Telegram is a fake in the Worker (no real bot); --no-fake-telegram goes back",
      "--telegram-owner <id>    your Telegram user id: your first DM to the bot is approved, no pairing code",
    ],
    flags: {
      "account-id": { type: "string" },
      name: { type: "string" },
      subdomain: { type: "string" },
      adopt: { type: "boolean" },
      "ai-token-file": { type: "string" },
      gateway: { type: "string" },
      model: { type: "string" },
      instance: { type: "string" },
      bucket: { type: "string" },
      "skip-ai": { type: "boolean" },
      "no-open": { type: "boolean" },
      "accept-loss": { type: "boolean" },
      "fake-telegram": { type: "boolean" },
      "telegram-owner": { type: "string" },
    },
    dirPositional: true,
    run: initCommand,
  },
  deploy: {
    usage: "deploy [--force] [--require-archive]",
    summary: "Re-render .oc-host/wrangler.jsonc and deploy when the deploy hash changed.",
    flags: { force: { type: "boolean" }, "require-archive": { type: "boolean" } },
    run: deployCommand,
  },
};

export function helpText(version: string): string {
  const w = Math.max(
    ...Object.keys(COMMANDS).map((k) => k.length),
    ...Object.keys(OPS_COMMANDS).map((k) => k.length),
  );
  return [
    `ochost ${version}: a persistent OpenClaw on Cloudflare Containers. Community project, not affiliated with Cloudflare.`,
    "",
    "Usage: ochost <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(w)}  ${c.summary}`),
    opsHelp(undefined, w),
    "",
    "ochost <command> -h shows the subcommands and flags of one command.",
    "",
    "Global options:",
    "  --dir <path>        project directory (default: current directory)",
    "  --json              print one JSON document on stdout; progress events go to stderr",
    "  --non-interactive   never prompt; a missing answer exits 3 with the step to do",
    "  -h, --help          show help",
    "  -v, --version       show version",
    "",
    "Exit codes: 0 ok, 1 failed, 2 usage, 3 needs a manual step, 4 time budget passed, 130 interrupted.",
    "Start: npx wrangler login, then ochost init.",
  ].join("\n");
}

/** First positional, skipping the values of global string flags (--dir x). */
export function findCommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return argv[i + 1];
    if (a.startsWith("-")) {
      const name = a.replace(/^-+/, "");
      if (!a.includes("=") && GLOBAL[name]?.type === "string") i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function printError(ui: Ui, e: unknown): void {
  const line = toFailedLine(e);
  if (process.env.OCHOST_DEBUG && e instanceof Error && e.stack) process.stderr.write(`${e.stack}\n`);
  if (process.env.OCHOST_DEBUG && e instanceof Error && e.cause !== undefined)
    process.stderr.write(`cause: ${redact(causeChain(e.cause))}\n`);
  if (ui.json) ui.result({ ok: false, error: line, exit: exitCodeOf(e) });
  else process.stderr.write(`${line}\n`);
}

/** Open a URL in the default browser; quiet on failure (the link is printed anyway). */
async function openInBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

export async function main(argv: string[], over: Partial<Ctx> = {}): Promise<number> {
  const version = await cliVersion();
  const cmdName = findCommand(argv);
  if (cmdName && !COMMANDS[cmdName] && OPS_COMMANDS[cmdName]) {
    installSigint();
    const i = argv.indexOf(cmdName);
    return runOps(cmdName, [...argv.slice(0, i), ...argv.slice(i + 1)]);
  }
  const cmd = cmdName ? COMMANDS[cmdName] : undefined;
  const earlyUi = makeUi({ json: argv.includes("--json"), nonInteractive: true });
  let args: ParsedArgs;
  try {
    if (cmdName && !cmd) throw new CliError(`unknown command ${cmdName}`, "run ochost --help", EXIT.usage);
    args = parseArgs(argv, { ...GLOBAL, ...(cmd?.flags ?? {}) });
  } catch (e) {
    printError(earlyUi, e);
    return EXIT.usage;
  }
  if (flagBool(args, "version")) {
    process.stdout.write(flagBool(args, "json") ? `${JSON.stringify({ version })}\n` : `${version}\n`);
    return 0;
  }
  if (!cmd || flagBool(args, "help")) {
    const details = cmd?.details ? `\nOptions:\n${cmd.details.map((d) => `  ${d}`).join("\n")}\n` : "";
    process.stdout.write(
      `${cmd ? `Usage: ochost ${cmd.usage}\n\n${cmd.summary}\n${details}` : helpText(version)}\n`,
    );
    return 0;
  }
  args.positionals.shift(); // the command name
  const interactive = !flagBool(args, "non-interactive") && !process.env.CI && Boolean(process.stdin.isTTY);
  const ui =
    over.ui ??
    makeUi({
      json: flagBool(args, "json"),
      nonInteractive: !interactive,
      verbose: flagBool(args, "verbose") || Boolean(process.env.OCHOST_DEBUG),
    });
  let dir = flagString(args, "dir") ?? process.cwd();
  if (cmd.dirPositional && args.positionals[0]) dir = args.positionals.shift() as string;
  installSigint();
  const ctx: Ctx = {
    ui,
    args,
    dir: resolve(dir),
    run: runProcess,
    fetch: globalThis.fetch,
    env: process.env,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    prompt: ttyPrompter,
    interactive,
    openUrl: openInBrowser,
    ...over,
  };
  try {
    return await cmd.run(ctx);
  } catch (e) {
    printError(ui, e);
    return exitCodeOf(e);
  }
}
