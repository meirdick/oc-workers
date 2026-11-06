// `ochost channels add slack|discord|twilio` (docs/14-webhook-channels.md). These platforms call a webhook, so the
// Worker's inbox adapter (worker/src/ctl/adapters) verifies, stores and acks inside the platform's deadline and
// the container can sleep. The CLI: asks for the platform secrets, stores them as Worker secrets, renders the
// OpenClaw channel config in HTTP mode (never socket), prints the URL for the platform console, and waits until
// the platform has called it (`hooks` in GET /ops/inbox).
import type { ChannelDeps } from "./channels.ts";
import { currentConfig, proposeConfig } from "./model.ts";
import { CliError } from "./ui.ts";

export type HookChannel = "slack" | "discord" | "twilio";

export interface Field {
  /** Key in the answers. */
  key: string;
  /** Env var the CLI reads first (and tells you about when it is missing). */
  env: string;
  prompt: string;
  hidden: boolean;
  re: RegExp;
  shape: string;
  /** Worker secret name (OC_SECRET_<NAME>; the gateway sees env NAME). Absent: not a secret, goes in the config. */
  secret?: string;
}

export interface HookSpec {
  id: HookChannel;
  label: string;
  /** OpenClaw channel id in `channels.<id>`. */
  channel: string;
  /** Worker path the platform calls. */
  hookPath: string;
  /** OpenClaw's own route for the replay (worker/src/ctl/adapters/*.ts `route`). */
  route: string;
  /** Platform ack deadline, s. */
  ackS: number;
  fields: Field[];
  /** What the platform's console needs (terse lines; {url} is the webhook URL). */
  console: string[];
  /** What proves the URL works. */
  proof: string;
  /** Pure: channel config from the answers. */
  render(a: Record<string, string>, url: string): Record<string, any>;
  warn?: string;
  /**
   * Where the image bakes the channel plugin (image/Dockerfile). OpenClaw 2026.10.9 does not bundle Slack or SMS:
   * without the load path the channel has no owner and its route answers 404 (M7 live F2).
   */
  pluginDir?: string;
}

export const SLACK_PLUGIN_DIR = "/opt/oc-plugins/slack";
export const SMS_PLUGIN_DIR = "/opt/oc-plugins/sms";

const ref = (id: string) => ({ source: "env", provider: "default", id });

export const SPECS: Record<HookChannel, HookSpec> = {
  slack: {
    id: "slack",
    label: "Slack",
    channel: "slack",
    hookPath: "/_ochost/hook/slack",
    route: "/slack/events",
    ackS: 3,
    fields: [
      {
        key: "botToken",
        env: "SLACK_BOT_TOKEN",
        prompt: "Slack bot token (xoxb-…, OAuth & Permissions)",
        hidden: true,
        re: /^xoxb-[A-Za-z0-9-]{10,}$/,
        shape: "xoxb-…",
        secret: "OC_SLACK_BOT_TOKEN",
      },
      {
        key: "signingSecret",
        env: "SLACK_SIGNING_SECRET",
        prompt: "Slack signing secret (Basic Information)",
        hidden: true,
        re: /^[A-Za-z0-9]{16,64}$/,
        shape: "16-64 letters and digits",
        secret: "OC_SLACK_SIGNING_SECRET",
      },
    ],
    console: [
      "Slack app > Event Subscriptions > Enable Events > Request URL: {url}",
      "Slack checks it at once and the Worker answers the challenge. Add the bot events you use (message.im, app_mention).",
      "Slash commands and Interactivity use the same URL.",
    ],
    proof: "Slack's url_verification challenge",
    pluginDir: SLACK_PLUGIN_DIR,
    render: () => ({
      enabled: true,
      mode: "http",
      webhookPath: "/slack/events",
      botToken: ref("OC_SLACK_BOT_TOKEN"),
      signingSecret: ref("OC_SLACK_SIGNING_SECRET"),
      dmPolicy: "pairing",
    }),
  },
  discord: {
    id: "discord",
    label: "Discord",
    channel: "discord",
    hookPath: "/_ochost/hook/discord",
    route: "/discord/interactions",
    ackS: 3,
    fields: [
      {
        key: "token",
        env: "DISCORD_BOT_TOKEN",
        prompt: "Discord bot token (Bot page)",
        hidden: true,
        re: /^[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/,
        shape: "three dot-separated parts",
        secret: "OC_DISCORD_BOT_TOKEN",
      },
      {
        key: "publicKey",
        env: "DISCORD_PUBLIC_KEY",
        prompt: "Discord application public key (General Information)",
        hidden: true,
        re: /^[0-9a-fA-F]{64}$/,
        shape: "64 hex characters",
        secret: "OC_DISCORD_PUBLIC_KEY",
      },
      {
        key: "applicationId",
        env: "DISCORD_APPLICATION_ID",
        prompt: "Discord application id (General Information)",
        hidden: false,
        re: /^\d{15,25}$/,
        shape: "digits",
      },
    ],
    console: [
      "Discord developer portal > your app > General Information > Interactions Endpoint URL: {url}",
      "Discord sends a PING and signed probes when you save; the Worker answers them.",
      "A follow-up after the 15 min interaction token needs the bot REST path (the bot token above), not the interaction webhook.",
    ],
    proof: "Discord's PING",
    warn: "OpenClaw 2026.10.9 has no HTTP interactions route: its Discord account runs on the gateway socket and keeps the install awake. The Worker stores and replays interactions to {route}, which answers 404 until OpenClaw adds one.",
    render: (a) => ({
      enabled: true,
      token: ref("OC_DISCORD_BOT_TOKEN"),
      applicationId: a.applicationId,
      dmPolicy: "pairing",
    }),
  },
  twilio: {
    id: "twilio",
    label: "Twilio SMS",
    channel: "sms",
    hookPath: "/_ochost/hook/twilio",
    route: "/webhooks/sms",
    ackS: 15,
    fields: [
      {
        key: "accountSid",
        env: "TWILIO_ACCOUNT_SID",
        prompt: "Twilio Account SID (AC…)",
        hidden: false,
        re: /^AC[0-9a-fA-F]{32}$/,
        shape: "AC + 32 hex",
      },
      {
        key: "authToken",
        env: "TWILIO_AUTH_TOKEN",
        prompt: "Twilio Auth Token",
        hidden: true,
        re: /^[0-9a-fA-F]{32}$/,
        shape: "32 hex",
        secret: "OC_TWILIO_AUTH_TOKEN",
      },
      {
        key: "sender",
        env: "TWILIO_PHONE_NUMBER",
        prompt: "Twilio number (+15551234567) or Messaging Service SID (MG…)",
        hidden: false,
        re: /^(\+[1-9]\d{6,14}|MG[0-9a-fA-F]{32})$/,
        shape: "+E.164 number or MG + 32 hex",
      },
    ],
    console: [
      "Twilio console > Phone Numbers > your number > Messaging > A message comes in: Webhook, POST, {url}",
      "Twilio has no check button. Text the number; the first signed call is the proof.",
    ],
    proof: "the first signed request from Twilio",
    pluginDir: SMS_PLUGIN_DIR,
    render: (a, url) => ({
      enabled: true,
      accountSid: a.accountSid,
      authToken: ref("OC_TWILIO_AUTH_TOKEN"),
      ...(a.sender?.startsWith("MG") ? { messagingServiceSid: a.sender } : { fromNumber: a.sender }),
      // Twilio signs this URL. The Worker replays the original signature, so the gateway checks against it too.
      publicWebhookUrl: url,
      webhookPath: "/webhooks/sms",
      dmPolicy: "pairing",
    }),
  },
};

export const HOOK_CHANNELS = Object.keys(SPECS) as HookChannel[];
/** Other names the CLI takes: `sms` is the Twilio channel's name in config and in `channels list` (M7 live F4). */
export const HOOK_ALIASES: Record<string, HookChannel> = { sms: "twilio" };
/** The hook channel for a name or an alias; undefined for anything else. */
export const hookChannelOf = (s: string | undefined): HookChannel | undefined =>
  !s ? undefined : (HOOK_CHANNELS as string[]).includes(s) ? (s as HookChannel) : HOOK_ALIASES[s];
export const isHookChannel = (s: string | undefined): s is HookChannel => !!hookChannelOf(s);

export const hookUrl = (origin: string, s: HookSpec) => origin.replace(/\/$/, "") + s.hookPath;

/** Worker secret name for a field (OC_SECRET_ + container env NAME). */
export const workerSecretName = (f: Field) => (f.secret ? `OC_SECRET_${f.secret}` : null);

/** Pure: config doc with the channel in HTTP mode and its binding. Existing keys of the channel are kept. */
export function withHookChannel(
  doc: Record<string, any>,
  s: HookSpec,
  a: Record<string, string>,
  url: string,
): Record<string, any> {
  const next = structuredClone(doc);
  next.channels ??= {};
  const old = next.channels[s.channel] ?? {};
  // Socket-only keys go: an app-level token would start a Socket Mode connection next to the HTTP route.
  const { appToken: _a, relay: _r, socketMode: _s, ...keep } = old;
  next.channels[s.channel] = { ...keep, ...s.render(a, url) };
  if (s.pluginDir) {
    next.plugins ??= {};
    next.plugins.load ??= {};
    const paths: unknown[] = Array.isArray(next.plugins.load.paths) ? next.plugins.load.paths : [];
    if (!paths.includes(s.pluginDir)) next.plugins.load.paths = [...paths, s.pluginDir];
    next.plugins.entries ??= {};
    next.plugins.entries[s.channel] = { ...(next.plugins.entries[s.channel] ?? {}), enabled: true };
  }
  next.bindings ??= [];
  const has = (next.bindings as any[]).some((b) => b?.match?.channel === s.channel);
  if (!has) next.bindings.push({ agentId: "main", match: { channel: s.channel, accountId: "default" } });
  return next;
}

/** Pure: the doc without a channel and its bindings (and its baked plugin's load path and entry, if given). */
export function withoutChannel(
  doc: Record<string, any>,
  channel: string,
  pluginDir?: string,
): Record<string, any> {
  const next = structuredClone(doc);
  if (next.channels) delete next.channels[channel];
  if (next.channels && !Object.keys(next.channels).length) delete next.channels;
  if (Array.isArray(next.bindings)) {
    next.bindings = next.bindings.filter((b: any) => b?.match?.channel !== channel);
    if (!next.bindings.length) delete next.bindings;
  }
  if (pluginDir && next.plugins) {
    const l = next.plugins.load;
    if (Array.isArray(l?.paths)) {
      l.paths = l.paths.filter((p: unknown) => p !== pluginDir);
      if (!l.paths.length) delete l.paths;
      if (!Object.keys(l).length) delete next.plugins.load;
    }
    if (next.plugins.entries) {
      delete next.plugins.entries[channel];
      if (!Object.keys(next.plugins.entries).length) delete next.plugins.entries;
    }
    if (!Object.keys(next.plugins).length) delete next.plugins;
  }
  return next;
}

export interface AddHookOpts {
  origin: string;
  nonInteractive?: boolean;
  /** Wait for the platform's call. 0 = do not wait. */
  verifyTimeoutMs: number;
}
export interface AddHookDeps extends ChannelDeps {
  /** Plain (visible) question; absent → non-interactive. */
  ask?: (q: string) => Promise<string>;
}
export interface AddHookResult {
  ok: boolean;
  channel: HookChannel;
  url: string;
  configVer: number;
  secrets: string[];
  verified: boolean | null;
  lastCall?: { at: number; kind: string };
}

async function answers(s: HookSpec, o: AddHookOpts, d: AddHookDeps): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of s.fields) {
    let v = d.env[f.env]?.trim() ?? "";
    if (!v) {
      const ask = f.hidden ? d.askHidden : d.ask;
      if (o.nonInteractive || !ask)
        throw new CliError(
          `no ${s.label} ${f.prompt.split(" (")[0]?.replace(s.label, "").trim()} (${f.env} is unset)`,
          `rerun with ${s.fields.map((x) => x.env).join(", ")} set`,
          3,
        );
      v = (await ask(`${f.prompt}${f.hidden ? " (input is hidden)" : ""}: `)).trim();
    }
    if (f.hidden) d.registerSecret(v);
    if (!f.re.test(v))
      throw new CliError(
        `the ${f.env} value has the wrong shape (expected ${f.shape})`,
        `copy it from the ${s.label} console again; rerun with ${f.env} set`,
      );
    out[f.key] = v;
  }
  return out;
}

/** How long `signalSecrets` waits for the new Worker version to serve the new secrets. */
export const SECRETS_WAIT_MS = 60_000;

/**
 * M7 F1: the Control DO and the Runtime DO hold the env they were built with; `wrangler secret put` does not
 * restart them, so the replay driver could not sign Slack replays until the next code deploy. POST
 * /ops/secrets-changed hands the Worker's newer env to both. A new version takes a few seconds to serve, so this
 * retries until the Worker holds every new name the driver reads (`known`). An older Worker (404): one WARN line.
 */
export async function signalSecrets(d: ChannelDeps, names: string[]): Promise<boolean> {
  const now = d.now ?? Date.now;
  const wait = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const want = names.map((n) => n.replace(/^OC_SECRET_/, ""));
  const t0 = now();
  for (;;) {
    const r = await d.ops.post("/ops/secrets-changed", { names: want }).catch(() => null);
    if (r?.status === 404) {
      d.log("WARN: this Worker has no /ops/secrets-changed; replay starts after the next ochost deploy");
      return false;
    }
    const b = (r?.status === 200 ? r.body : {}) as { have?: string[]; known?: string[] };
    const need = want.filter((n) => (b.known ?? []).includes(n));
    if (r?.status === 200 && need.every((n) => (b.have ?? []).includes(n))) return true;
    if (now() - t0 >= SECRETS_WAIT_MS) {
      d.log(
        `WARN: the Worker does not serve ${need.join(", ") || "the new secrets"} yet; replay waits for them. Fix: ochost deploy`,
      );
      return false;
    }
    await wait(3_000);
  }
}

/** The last call the Worker saw from this platform, from GET /ops/inbox `hooks`. */
async function lastCall(d: ChannelDeps, s: HookSpec): Promise<{ at: number; kind: string } | null> {
  const r = await d.ops.get("/ops/inbox");
  if (r.status !== 200) return null;
  const h = (r.body as { hooks?: Record<string, { at: number; kind: string } | null> }).hooks;
  return h?.[s.id] ?? null;
}

export async function addHookChannel(
  ch: HookChannel,
  o: AddHookOpts,
  d: AddHookDeps,
): Promise<AddHookResult> {
  const s = SPECS[ch];
  const now = d.now ?? Date.now;
  const wait = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const a = await answers(s, o, d);
  const url = hookUrl(o.origin, s);
  // The Worker refuses a hook route it has no adapter for: GET it first so an old Worker gives a clear line.
  const probe = await d.fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!probe || probe.status === 404)
    throw new CliError(
      `this Worker has no ${s.label} webhook route (${s.hookPath})`,
      "ochost deploy, then rerun",
    );
  const names: string[] = [];
  for (const f of s.fields)
    if (f.secret) {
      const n = `OC_SECRET_${f.secret}`;
      await d.putSecret(n, a[f.key] as string);
      names.push(n);
    }
  await signalSecrets(d, names);
  const cur = await currentConfig(d.ops);
  const ver = await proposeConfig(d.ops, withHookChannel(cur.doc, s, a, url), cur.ver);
  d.log(`config version ${ver.ver}${ver.same ? " (no change)" : ""}, ${s.label} in HTTP mode`);
  if (s.warn) d.log(`WARN: ${s.warn.replace("{route}", s.route)}`);
  d.log(`${s.label} webhook URL: ${url}`);
  for (const l of s.console) d.log(`  ${l.replace("{url}", url)}`);
  d.log(`  The Worker acks inside ${s.ackS} s; the container does not need to be up.`);
  const res: AddHookResult = {
    ok: true,
    channel: ch,
    url,
    configVer: ver.ver,
    secrets: names,
    verified: null,
  };
  if (o.verifyTimeoutMs <= 0) {
    d.log(`${s.label} is on. Verify later: ochost channels list`);
    return res;
  }
  d.log(`Waiting up to ${Math.round(o.verifyTimeoutMs / 60_000)} min for ${s.proof}.`);
  const t0 = now();
  for (;;) {
    const c = await lastCall(d, s);
    if (c && c.at >= t0 - 5_000) {
      res.verified = true;
      res.lastCall = c;
      d.log(`${s.label} called the webhook (${c.kind}): verified`);
      return res;
    }
    if (now() - t0 >= o.verifyTimeoutMs)
      throw new CliError(
        `${s.label} has not called ${s.hookPath} in ${Math.round(o.verifyTimeoutMs / 60_000)} min (${s.proof})`,
        `paste ${url} in the ${s.label} console, then rerun ochost channels add ${ch}; ochost logs --source ctl`,
        4,
      );
    await wait(3_000);
  }
}
