// Channel adoption (docs/20 section 2): pure rules, no storage. A UI config that holds a channel credential in
// clear is held; the owner adopts it; the Worker moves the credentials to its store and rewrites the channel to
// webhook mode on the managed route. The shapes mirror what `ochost channels add` renders (cli/src/channels.ts,
// cli/src/hook-channels.ts).

export interface AdoptSecret {
  /** Key in `channels.<config>`. */
  key: string;
  /** Gateway env NAME (the Worker secret is OC_SECRET_<NAME>). */
  env: string;
}
export interface AdoptSpec {
  /** Name the owner uses (`ochost channels adopt <id>`). */
  id: string;
  label: string;
  /** Key in `channels`. */
  config: string;
  secrets: AdoptSecret[];
  /** Plain keys that must be present. */
  plain: string[];
  /** One of these keys must be present. */
  anyOf?: string[];
  /** Where the platform calls the Worker; Telegram has a secret path instead. */
  hookPath?: string;
  pluginDir?: string;
}

export const ADOPT_SPECS: readonly AdoptSpec[] = [
  {
    id: "telegram",
    label: "Telegram",
    config: "telegram",
    secrets: [{ key: "botToken", env: "OC_TELEGRAM_BOT_TOKEN" }],
    plain: [],
  },
  {
    id: "slack",
    label: "Slack",
    config: "slack",
    secrets: [
      { key: "botToken", env: "OC_SLACK_BOT_TOKEN" },
      { key: "signingSecret", env: "OC_SLACK_SIGNING_SECRET" },
    ],
    plain: [],
    hookPath: "/_ochost/hook/slack",
    pluginDir: "/opt/oc-plugins/slack",
  },
  {
    id: "discord",
    label: "Discord",
    config: "discord",
    secrets: [
      { key: "token", env: "OC_DISCORD_BOT_TOKEN" },
      { key: "publicKey", env: "OC_DISCORD_PUBLIC_KEY" },
    ],
    plain: ["applicationId"],
    hookPath: "/_ochost/hook/discord",
  },
  {
    id: "twilio",
    label: "Twilio SMS",
    config: "sms",
    secrets: [{ key: "authToken", env: "OC_TWILIO_AUTH_TOKEN" }],
    plain: ["accountSid"],
    anyOf: ["fromNumber", "messagingServiceSid"],
    hookPath: "/_ochost/hook/twilio",
    pluginDir: "/opt/oc-plugins/sms",
  },
];

/** `sms` is the config name of Twilio. */
export const adoptSpecOf = (name: string | undefined): AdoptSpec | undefined =>
  ADOPT_SPECS.find((s) => s.id === name || s.config === name);

type Doc = Record<string, any>;

/** A credential in clear: a non-empty string that is not an env SecretRef (`${NAME}`). Object refs are not clear. */
export const isClear = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "" && !/^\$\{[A-Za-z0-9_]+\}$/.test(v.trim());

const block = (doc: unknown, s: AdoptSpec): Doc | null => {
  const b = (doc as Doc | null)?.channels?.[s.config];
  return b && typeof b === "object" ? b : null;
};

/** Specs whose channel block holds a credential in clear. */
export function heldChannels(doc: unknown): AdoptSpec[] {
  return ADOPT_SPECS.filter((s) => {
    const b = block(doc, s);
    return !!b && s.secrets.some((f) => isClear(b[f.key]));
  });
}

/** Why a candidate is held, or null. The text is for the owner (ring, CLI). */
export function heldReason(doc: unknown): string | null {
  const s = heldChannels(doc)[0];
  if (!s) return null;
  const key = s.secrets.find((f) => isClear(block(doc, s)?.[f.key]))?.key;
  const why =
    s.id === "telegram"
      ? "OpenClaw polls Telegram when a token is set, and polling keeps the install awake"
      : "the credential must not stay in the UI config";
  return `channels.${s.config}.${key} holds a credential in clear: ${why}. Adopt it (ochost channels adopt ${s.id}) or remove it`;
}

const ref = (id: string) => ({ source: "env", provider: "default", id });

export interface Adopted {
  doc: Doc;
  /** Gateway env NAME → value, to store. */
  secrets: Record<string, string>;
  /** Fields the channel still needs (not in the UI config, not in `extra`). */
  missing: string[];
}

/**
 * The held doc with the channel rewritten: credentials out (returned in `secrets`), SecretRefs in, webhook mode on
 * `hook` (the managed URL). `extra` supplies fields the UI config cannot hold (Discord public key). Pure.
 */
export function adoptDoc(
  doc: Doc,
  s: AdoptSpec,
  hook: string,
  extra: Record<string, string> = {},
): Adopted | null {
  const old = block(doc, s);
  if (!old) return null;
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of s.secrets) {
    const v = isClear(old[f.key]) ? old[f.key] : extra[f.key];
    if (isClear(v)) secrets[f.env] = v.trim();
    else missing.push(f.key);
  }
  const val = (k: string) => (typeof old[k] === "string" && old[k] ? old[k] : extra[k]);
  for (const k of s.plain) if (!val(k)) missing.push(k);
  if (s.anyOf && !s.anyOf.some((k) => val(k))) missing.push(s.anyOf.join(" or "));
  const next = structuredClone(doc);
  const dm = typeof old.dmPolicy === "string" ? old.dmPolicy : "pairing";
  let blk: Doc;
  switch (s.id) {
    case "telegram":
      blk = {
        ...old,
        enabled: true,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef, not a JS template
        botToken: "${OC_TELEGRAM_BOT_TOKEN}",
        dmPolicy: dm,
        streaming: old.streaming ?? { mode: "partial" },
        webhookUrl: hook,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef, not a JS template
        webhookSecret: "${OC_TELEGRAM_WEBHOOK_SECRET}",
        webhookPath: "/telegram-webhook",
      };
      break;
    case "slack": {
      // Socket-only keys go: an app-level token would start Socket Mode next to the HTTP route.
      const { appToken: _a, relay: _r, socketMode: _s, ...keep } = old;
      blk = {
        ...keep,
        enabled: true,
        mode: "http",
        webhookPath: "/slack/events",
        botToken: ref("OC_SLACK_BOT_TOKEN"),
        signingSecret: ref("OC_SLACK_SIGNING_SECRET"),
        dmPolicy: dm,
      };
      break;
    }
    case "discord": {
      const { publicKey: _p, ...keep } = old;
      blk = {
        ...keep,
        enabled: true,
        token: ref("OC_DISCORD_BOT_TOKEN"),
        applicationId: val("applicationId"),
        dmPolicy: dm,
      };
      break;
    }
    default:
      blk = {
        ...old,
        enabled: true,
        authToken: ref("OC_TWILIO_AUTH_TOKEN"),
        // Twilio signs the Worker URL; the Worker replays the original signature.
        publicWebhookUrl: hook,
        webhookPath: "/webhooks/sms",
        dmPolicy: dm,
      };
  }
  next.channels[s.config] = blk;
  if (s.pluginDir) {
    next.plugins ??= {};
    next.plugins.load ??= {};
    const paths: unknown[] = Array.isArray(next.plugins.load.paths) ? next.plugins.load.paths : [];
    if (!paths.includes(s.pluginDir)) next.plugins.load.paths = [...paths, s.pluginDir];
    next.plugins.entries ??= {};
    next.plugins.entries[s.config] = { ...(next.plugins.entries[s.config] ?? {}), enabled: true };
  }
  next.bindings ??= [];
  if (!(next.bindings as any[]).some((b) => b?.match?.channel === s.config))
    next.bindings.push({ agentId: "main", match: { channel: s.config, accountId: "default" } });
  return { doc: next, secrets, missing };
}
