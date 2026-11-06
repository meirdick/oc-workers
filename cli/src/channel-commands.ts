// ochost channels add telegram|list|remove and ochost pairing list|approve (docs/10-cli-spec.md §1.2, §4).
// Thin wrappers over channels.ts. Routes: /ops/config, /ops/restart, /ops/inbox, /ops/wake, and the W1/W8 gaps
// /ops/pairing, /ops/pairing/approve, /ops/telegram/webhook (a 404 there gives a fix line, never a crash).
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addTelegram, BOT_SECRET_NAME, waitPair } from "./channels.ts";
import { aigDeps, applyChange, looseOps, recordSecret, setBaseVersion, sub } from "./cmd-util.ts";
import {
  addHookChannel,
  HOOK_CHANNELS,
  hookChannelOf,
  SPECS,
  withoutChannel,
  workerSecretName,
} from "./hook-channels.ts";
import { dropRows } from "./inbox.ts";
import { currentConfig, proposeConfig } from "./model.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  type OpsCtx,
  opsClient,
  putSecret,
  STATE_DIR,
  table,
  usage,
} from "./ops-lib.ts";

export const channelsFlags: FlagSpec = {
  "token-file": { type: "string" },
  "wait-pair": { type: "boolean" },
  "pair-timeout": { type: "string" },
  force: { type: "boolean" },
  "no-wait": { type: "boolean" },
  "verify-timeout": { type: "string" },
  yes: { type: "boolean", short: "y" },
};

/** "10m", "90s", "600" (s) → ms. */
export function parseDuration(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const m = /^(\d+)(s|m|h)?$/.exec(v.trim());
  if (!m) throw usage(`bad duration ${v}`, "use 90s, 10m or 1h");
  const n = Number(m[1]);
  return n * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000);
}

async function saveState(ctx: OpsCtx, patch: Record<string, unknown>): Promise<void> {
  const p = join(ctx.dir, STATE_DIR, "state.json");
  let st: Record<string, unknown> = {};
  try {
    st = JSON.parse(await readFile(p, "utf8"));
  } catch {}
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete st[k];
  await writeFile(p, `${JSON.stringify({ ...st, ...patch }, null, 2)}\n`);
}

export async function channels(ctx: OpsCtx): Promise<number> {
  const s = sub(ctx, ["add", "list", "remove"], "list");
  if (s === "list") return channelsList(ctx);
  const ch = ctx.args.positionals[1];
  const hook = hookChannelOf(ch);
  if (hook) return s === "add" ? hookAdd(ctx, hook) : hookRemove(ctx, hook);
  if (ch !== "telegram")
    throw usage(
      ch ? `channel ${ch} is not supported in v1` : "no channel given",
      `ochost channels ${s} <telegram|${HOOK_CHANNELS.join("|")}> (sms = twilio)`,
    );
  return s === "add" ? channelsAdd(ctx) : channelsRemove(ctx);
}

async function channelsList(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const cur = await currentConfig(looseOps(ops));
  const chs = (cur.doc.channels ?? {}) as Record<string, any>;
  const rows = Object.entries(chs).map(([name, c]) => ({
    name,
    enabled: c?.enabled !== false,
    dmPolicy: String(c?.dmPolicy ?? "-"),
    webhook: c?.webhookUrl || c?.mode === "http" || c?.publicWebhookUrl ? "managed" : "-",
  }));
  if (ctx.out.json) ctx.out.result({ ok: true, configVer: cur.ver, channels: rows });
  else if (!rows.length) ctx.out.line("no channels. Add one: ochost channels add telegram");
  else
    ctx.out.line(
      table(
        ["CHANNEL", "ENABLED", "DM POLICY", "WEBHOOK"],
        rows.map((r) => [r.name, r.enabled ? "yes" : "no", r.dmPolicy, r.webhook]),
      ),
    );
  return EXIT.ok;
}

async function channelsAdd(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const install = ops.install;
  const d = aigDeps(ctx);
  const stored = install.state.telegramBotId;
  const r = await addTelegram(
    {
      origin: install.url,
      tokenFile: flagStr(ctx.args, "token-file"),
      nonInteractive: ctx.nonInteractive,
      waitPair: flagBool(ctx.args, "wait-pair"),
      pairTimeoutMs: parseDuration(flagStr(ctx.args, "pair-timeout"), 600_000),
      storedBotId: typeof stored === "number" ? stored : undefined,
      fake: install.state.fakeTelegram === true,
    },
    {
      fetch: ctx.fetch,
      env: ctx.env,
      askHidden: d.askHidden,
      readFile: async (f) => {
        const p = resolve(f);
        return { text: await readFile(p, "utf8"), mode: (await stat(p)).mode };
      },
      log: d.log,
      registerSecret: d.registerSecret,
      ops: looseOps(ops),
      putSecret: async (name, value) => {
        await putSecret(ctx, install, name, value);
        await recordSecret(ctx, name, value);
      },
      confirm: ctx.nonInteractive ? undefined : async (q) => /^y(es)?$/i.test(await ctx.prompts.ask(q)),
      now: ctx.now,
      sleep: ctx.sleep,
      telegramApi: ctx.env.OCHOST_TELEGRAM_API,
    },
  );
  await saveState(ctx, { telegramBotId: r.bot.id, telegramBot: r.bot.username });
  await setBaseVersion(ctx, r.configVer);
  if (ctx.out.json) ctx.out.result(r);
  else
    ctx.out.line(
      `Telegram bot @${r.bot.username} on (config version ${r.configVer}). Webhook URL: ${r.webhook.url}`,
    );
  return EXIT.ok;
}

/** Pure: the doc without the Telegram channel and its binding. */
export const withoutTelegram = (doc: Record<string, any>) => withoutChannel(doc, "telegram");

/** Slack, Discord, Twilio: secrets, HTTP-mode config, URL for the console, wait for the platform's call. */
async function hookAdd(ctx: OpsCtx, ch: (typeof HOOK_CHANNELS)[number]): Promise<number> {
  const ops = opsClient(ctx);
  const install = ops.install;
  const d = aigDeps(ctx);
  const timeout = flagBool(ctx.args, "no-wait")
    ? 0
    : ctx.nonInteractive && !flagStr(ctx.args, "verify-timeout")
      ? 0
      : parseDuration(flagStr(ctx.args, "verify-timeout"), 300_000);
  const r = await addHookChannel(
    ch,
    { origin: install.url, nonInteractive: ctx.nonInteractive, verifyTimeoutMs: timeout },
    {
      fetch: ctx.fetch,
      env: ctx.env,
      askHidden: d.askHidden,
      ask: ctx.nonInteractive ? undefined : (q) => ctx.prompts.ask(q),
      log: d.log,
      registerSecret: d.registerSecret,
      ops: looseOps(ops),
      putSecret: async (name, value) => {
        await putSecret(ctx, install, name, value);
        await recordSecret(ctx, name, value);
      },
      now: ctx.now,
      sleep: ctx.sleep,
    },
  );
  await setBaseVersion(ctx, r.configVer);
  const applied = await applyChange(ctx, ops, true);
  if (ctx.out.json) ctx.out.result({ ...r, applied });
  else ctx.out.line(`${SPECS[ch].label} on (config version ${r.configVer}). Webhook URL: ${r.url}`);
  return EXIT.ok;
}

async function hookRemove(ctx: OpsCtx, ch: (typeof HOOK_CHANNELS)[number]): Promise<number> {
  const spec = SPECS[ch];
  const ops = opsClient(ctx);
  const lo = looseOps(ops);
  const cur = await currentConfig(lo);
  if (!cur.doc.channels?.[spec.channel]) {
    if (ctx.out.json) ctx.out.result({ ok: true, removed: false });
    else ctx.out.line(`no ${spec.label} channel; nothing to remove`);
    return EXIT.ok;
  }
  const ib = await ops.call("GET", "/ops/inbox");
  const open = ((ib.body?.rows ?? []) as { route: string; state: string }[]).filter(
    (r) => r.route === spec.route && (r.state === "pending" || r.state === "held"),
  ).length;
  if (open > 0 && !flagBool(ctx.args, "force"))
    throw new CliError(
      `the inbox has ${open} ${spec.label} update(s) not yet handed to the gateway`,
      "wait for ochost status to show inbox pending 0 and held 0, or rerun with --force",
    );
  const v = await proposeConfig(lo, withoutChannel(cur.doc, spec.channel, spec.pluginDir), cur.ver);
  await setBaseVersion(ctx, v.ver);
  // With the channel gone its route answers 404: the rows left would block sleep (rule 5) for 23 h.
  const dropped = open > 0 ? await dropRows(ops, { all: true, channel: spec.channel }) : 0;
  if (dropped) ctx.out.warn(`dead-lettered ${dropped} ${spec.label} update(s) that were not delivered`);
  const applied = await applyChange(ctx, ops, true);
  const names = spec.fields.map(workerSecretName).filter((n): n is string => !!n);
  ctx.out.warn(
    `secrets ${names.join(", ")} stay on the Worker — fix: ${names.map((n) => `npx wrangler secret delete ${n} --name ${ops.install.name}`).join("; ")}, if you want them gone`,
  );
  if (ctx.out.json) ctx.out.result({ ok: true, removed: true, configVer: v.ver, applied, dropped });
  else ctx.out.line(`${spec.label} removed (config version ${v.ver})`);
  return EXIT.ok;
}

async function channelsRemove(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const lo = looseOps(ops);
  const cur = await currentConfig(lo);
  if (!cur.doc.channels?.telegram) {
    if (ctx.out.json) ctx.out.result({ ok: true, removed: false });
    else ctx.out.line("no Telegram channel; nothing to remove");
    return EXIT.ok;
  }
  // Updates already acked but not handed to the gateway would be lost.
  const ib = await ops.call("GET", "/ops/inbox");
  const c = ib.body?.counts ?? {};
  const open = Number(c.pending ?? 0) + Number(c.held ?? 0);
  if (open > 0 && !flagBool(ctx.args, "force"))
    throw new CliError(
      `the inbox has ${open} Telegram update(s) not yet handed to the gateway`,
      "wait for ochost status to show inbox pending 0 and held 0, or rerun with --force",
    );
  const v = await proposeConfig(lo, withoutTelegram(cur.doc), cur.ver);
  await setBaseVersion(ctx, v.ver);
  // add §2.2 "Removing Telegram": --force marks the rest dead and says how many.
  const dropped = open > 0 ? await dropRows(ops, { all: true, channel: "telegram" }) : 0;
  if (dropped) ctx.out.warn(`dead-lettered ${dropped} Telegram update(s) that were not delivered`);
  await saveState(ctx, { telegramBotId: undefined, telegramBot: undefined });
  const applied = await applyChange(ctx, ops, true);
  ctx.out.warn(
    `secret ${BOT_SECRET_NAME} stays on the Worker — fix: npx wrangler secret delete ${BOT_SECRET_NAME} --name ${ops.install.name}, if you want it gone`,
  );
  if (ctx.out.json) ctx.out.result({ ok: true, removed: true, configVer: v.ver, applied, dropped });
  else ctx.out.line(`Telegram removed (config version ${v.ver})`);
  return EXIT.ok;
}

// ---------------------------------------------------------------- pairing

export const pairingFlags: FlagSpec = {
  wait: { type: "boolean" },
  timeout: { type: "string" },
};

interface PairReq {
  code: string;
  id: string;
  name?: string;
  at?: number;
}

const noPairRoute = () =>
  new CliError(
    "this Worker has no pairing route (/ops/pairing, gap W1)",
    "approve the DM in the Control UI (ochost open), or update the Worker with ochost deploy",
  );

/** `pairing list [telegram]`, `pairing approve telegram <code>`, `pairing wait [telegram]`. */
export async function pairing(ctx: OpsCtx): Promise<number> {
  const s = sub(ctx, ["list", "approve", "wait"], "list");
  const ch = ctx.args.positionals[1] ?? "telegram";
  if (ch !== "telegram") throw usage(`channel ${ch} is not supported in v1`, `ochost pairing ${s} telegram`);
  const ops = opsClient(ctx);
  const lo = looseOps(ops);
  if (s === "list") {
    const r = await lo.get(`/ops/pairing?ch=${ch}`);
    if (r.status === 404) throw noPairRoute();
    if (r.status !== 200)
      throw new CliError(`GET /ops/pairing returned ${r.status}`, "ochost logs --source ctl");
    const reqs = ((r.body as { requests?: PairReq[] }).requests ?? []) as PairReq[];
    if (ctx.out.json) ctx.out.result({ ok: true, requests: reqs });
    else if (!reqs.length) ctx.out.line(`no pairing requests. DM the bot, then rerun`);
    else
      ctx.out.line(
        table(
          ["CODE", "ID", "NAME"],
          reqs.map((q) => [q.code, q.id, q.name ?? "-"]),
        ),
      );
    return EXIT.ok;
  }
  if (s === "approve") {
    const code = ctx.args.positionals[2];
    if (!code) throw usage("pairing approve needs a code", "ochost pairing approve telegram <code>");
    const r = await lo.post("/ops/pairing/approve", { ch, code });
    if (r.status === 404 && (r.body as { error?: string })?.error === "not found") throw noPairRoute();
    if (r.status !== 200)
      throw new CliError(
        `pairing approve returned ${r.status} ${(r.body as { error?: string })?.error ?? ""}`.trim(),
        "ochost pairing list shows the open codes",
      );
    if (ctx.out.json) ctx.out.result({ ok: true, ch, code, ...(r.body as object) });
    else ctx.out.line(`paired ${ch} code ${code}`);
    return EXIT.ok;
  }
  const d = aigDeps(ctx);
  const bot = String(ops.install.state.telegramBot ?? "your bot");
  const p = await waitPair(
    {
      pairTimeoutMs: parseDuration(flagStr(ctx.args, "timeout"), 600_000),
      nonInteractive: ctx.nonInteractive,
    },
    {
      fetch: ctx.fetch,
      env: ctx.env,
      log: d.log,
      registerSecret: d.registerSecret,
      ops: lo,
      putSecret: async () => {},
      confirm: ctx.nonInteractive ? undefined : async (q) => /^y(es)?$/i.test(await ctx.prompts.ask(q)),
      now: ctx.now,
      sleep: ctx.sleep,
    },
    bot,
  );
  if (ctx.out.json) ctx.out.result({ ok: true, paired: p });
  return EXIT.ok;
}
