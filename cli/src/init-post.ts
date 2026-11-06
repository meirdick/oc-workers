// One-shot init (docs/20 §1): after the install is up, init runs the setup commands the owner would run next, from
// flags or from short questions: Telegram, alerts, Cloudflare Access. Sandbox goes into oc-host.jsonc before the
// first deploy (init.ts updateConfigFile), so it costs no second deploy. Each step is the same ops command the owner
// can run alone; a failed step prints its fix line and init goes on with the next one.
import { existsSync } from "node:fs";
import { runOps } from "./ops-commands.ts";
import { CliError, type Ctx, expandHome, flagString } from "./ui.ts";

/** Known token files (`~/.config/oc-host/`). Offered as the default in the question; never used without a keypress. */
export const KNOWN_FILES = {
  telegram: "~/.config/oc-host/telegram.env",
  access: "~/.config/oc-host/cf-access.env",
};
const fileExists = (p: string) => existsSync(p);
const known = (p: string, exists: (p: string) => boolean = fileExists) =>
  exists(expandHome(p)) ? expandHome(p) : undefined;

export interface PostOptions {
  /** Telegram: a bot token file, or true to prompt for the token, or false to skip. */
  telegram?: string | boolean;
  /** Alerts: ntfy makes a topic; webhook needs alertsUrl. */
  alerts?: "ntfy" | "webhook";
  alertsUrl?: string;
  /** Cloudflare Access on this hostname (a zone on the account). */
  accessDomain?: string;
  /** A token with Access Apps and Policies edit; else the wrangler login must have the scope. */
  accessTokenFile?: string;
}

export interface PostStep {
  label: string;
  name: string;
  argv: string[];
}

export function postOptionsOf(ctx: Pick<Ctx, "args">): PostOptions {
  const f = (n: string) => flagString(ctx.args, n);
  const alerts = f("alerts");
  if (alerts !== undefined && alerts !== "ntfy" && alerts !== "webhook")
    throw new CliError(
      "--alerts must be ntfy or webhook",
      "pass --alerts ntfy, or --alerts webhook --alerts-url https://…",
    );
  if (alerts === "webhook" && !/^https:\/\//.test(f("alerts-url") ?? ""))
    throw new CliError("--alerts webhook needs --alerts-url https://…", "pass --alerts-url");
  const tf = f("telegram-token-file");
  const atf = f("access-token-file");
  return {
    ...(tf ? { telegram: expandHome(tf) } : {}),
    ...(alerts ? { alerts } : {}),
    ...(f("alerts-url") ? { alertsUrl: f("alerts-url") } : {}),
    ...(f("access-domain") ? { accessDomain: f("access-domain") } : {}),
    ...(atf ? { accessTokenFile: expandHome(atf) } : {}),
  };
}

/**
 * Fill what the flags left open with one question each: Telegram and Access. Enter skips. Alerts are flags only
 * (optional; `ochost alerts setup` later). Non-interactive: flags only. `fake`: a test install has a fake Telegram,
 * so no token question.
 */
export async function askPost(
  ctx: Ctx,
  o: PostOptions,
  fake: boolean,
  exists: (p: string) => boolean = fileExists,
): Promise<PostOptions> {
  if (!ctx.interactive) return o;
  const out = { ...o };
  const ask = (q: string) => ctx.prompt.ask(q);
  if (out.telegram === undefined && !fake) {
    const def = known(KNOWN_FILES.telegram, exists);
    const a = (
      await ask(
        def
          ? `Connect Telegram now? Enter uses ${KNOWN_FILES.telegram}; paste a token or a path instead; - skips:`
          : "Connect Telegram now? Paste the bot token, a file path, or Enter to skip:",
      )
    ).trim();
    if (a === "-") {
      // skip
    } else if (a) out.telegram = expandHome(a);
    else if (def) out.telegram = def;
  }
  if (out.accessDomain === undefined) {
    const a = (
      await ask(
        "Put the console behind Cloudflare Access on a hostname (e.g. oc.example.com), or Enter to skip:",
      )
    ).trim();
    if (a) out.accessDomain = a.toLowerCase();
  }
  if (out.accessDomain && out.accessTokenFile === undefined) {
    const def = known(KNOWN_FILES.access, exists);
    const a = (
      await ask(
        def
          ? `Access API token file: Enter uses ${KNOWN_FILES.access}; a path instead; - uses the wrangler login:`
          : "Access API token file (Enter to use the wrangler login):",
      )
    ).trim();
    if (a === "-") {
      // wrangler login
    } else if (a) out.accessTokenFile = expandHome(a);
    else if (def) out.accessTokenFile = def;
  }
  return out;
}

/** The ops commands to run, in order. Telegram first (the bot works), alerts, then Access last (it moves the origin). */
export function postSteps(o: PostOptions, fake: boolean): PostStep[] {
  const steps: PostStep[] = [];
  if (o.telegram && !fake) {
    const argv = ["add", "telegram"];
    if (typeof o.telegram === "string") argv.push("--token-file", o.telegram);
    steps.push({ label: "telegram", name: "channels", argv });
  }
  if (o.alerts === "ntfy")
    steps.push({ label: "alerts", name: "alerts", argv: ["setup", "--channel", "ntfy"] });
  if (o.alerts === "webhook" && o.alertsUrl)
    steps.push({
      label: "alerts",
      name: "alerts",
      argv: ["setup", "--channel", "webhook", "--url", o.alertsUrl],
    });
  if (o.accessDomain) {
    const argv = ["access", "--domain", o.accessDomain];
    if (o.accessTokenFile) argv.push("--token-file", o.accessTokenFile);
    steps.push({ label: "access", name: "auth", argv });
  }
  return steps;
}

/**
 * A pasted token is written to a temp file for `channels add --token-file`; the file goes right after. Returns the
 * steps with the path filled in and a cleanup.
 */
export async function materializeToken(
  o: PostOptions,
  io: {
    exists: (p: string) => boolean;
    writeTemp: (text: string) => Promise<string>;
    remove: (p: string) => void;
  },
): Promise<{ o: PostOptions; cleanup: () => void }> {
  if (typeof o.telegram !== "string" || io.exists(o.telegram)) return { o, cleanup: () => {} };
  const file = await io.writeTemp(`${o.telegram}\n`);
  return { o: { ...o, telegram: file }, cleanup: () => io.remove(file) };
}

/** Run the steps as ops commands in this directory. A failure prints the fix and the rest still runs. */
export async function runPost(
  ctx: Ctx,
  steps: PostStep[],
  run: (name: string, argv: string[]) => Promise<number> = (name, argv) =>
    runOps(name, [...argv, "--dir", ctx.dir, ...(ctx.interactive ? [] : ["--non-interactive"])]),
): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  let n = 0;
  for (const s of steps) {
    n++;
    ctx.ui.step(`setup ${n}/${steps.length}: ${s.label} (ochost ${s.name} ${s.argv.join(" ")})`, "setup");
    const code = await run(s.name, s.argv).catch((e) => {
      ctx.ui.warn(`${s.label}: ${(e as Error).message}`);
      return 1;
    });
    (code === 0 ? done : failed).push(s.label);
    if (code !== 0) ctx.ui.warn(`${s.label} did not finish — fix: ochost ${s.name} ${s.argv.join(" ")}`);
  }
  return { done, failed };
}
