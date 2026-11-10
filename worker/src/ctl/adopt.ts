// Channel adoption (docs/20 section 2), Control DO side. A UI config with a channel credential in clear is held
// (gates/ledger.ts configPropose). POST /ops/channels/adopt {channel}, owner only, takes the held candidate:
//   1. Telegram: setWebhook on the managed route (a wrong token fails here, nothing else changed yet).
//   2. The credentials go to the creds store under `adopted/<ENV NAME>` (a Worker cannot run `wrangler secret put`).
//      The gate never serves those rows to the container; the boot hands them over in the start env (beginBoot,
//      rt/core.ts), the same way the OC_SECRET_* values arrive. A Worker secret of the same name wins.
//   3. The channel is rewritten to webhook mode and accepted as an owner version; the held row is closed.
//   4. The gateway restarts when it runs, so the new version applies.

import { hookUrl } from "../ingress/telegram";
import { MESSAGE_UPDATES } from "../ops-telegram";
import { adapterByChannel } from "./adapters";
import { adoptDoc, adoptSpecOf, heldChannels } from "./adopt-spec";
import { type ConfigRow, configPropose, newestConfig } from "./config";
import { ADOPTED_PREFIX, credPutText, credTexts } from "./creds";
import { type Ctx, ring } from "./ctx";
import type { PairingDeps } from "./owner-ops";
import { pj } from "./sql";
import { tgCall } from "./typing";

type Res = { status: number; body: unknown };

/** The newest held candidate, while no later version exists (a later one means the owner moved on). */
export function heldCandidate(c: Ctx): ConfigRow | null {
  const h = c.db.one<ConfigRow>("SELECT * FROM config WHERE status = 'held' ORDER BY ver DESC LIMIT 1");
  const n = newestConfig(c);
  return h && (!n || h.ver > n.ver) ? h : null;
}

/** Adopted credentials as gateway env (NAME → value), for the boot. */
export const adoptedEnv = (c: Ctx): Record<string, string> => credTexts(c, ADOPTED_PREFIX);

/** Make the stored credentials visible to this DO: the replay driver and the cold-path typing read c.secrets. */
export function seedAdopted(c: Ctx): void {
  const env = adoptedEnv(c);
  if (!Object.keys(env).length) return;
  const platform = { ...(c.secrets.platform ?? {}) };
  for (const [k, v] of Object.entries(env)) {
    if (k === "OC_TELEGRAM_BOT_TOKEN") c.secrets.botToken ??= v;
    else if (!platform[k]) platform[k] = v;
  }
  c.secrets.platform = platform;
}

export async function opsChannels(
  c: Ctx,
  r: { method: string; sub: string[]; body: Record<string, unknown> },
  d: PairingDeps,
): Promise<Res> {
  if (r.method === "GET" && r.sub[0] === "adopted" && r.sub.length === 1)
    return { status: 200, body: { env: Object.keys(adoptedEnv(c)) } };
  if (r.method !== "POST" || r.sub[0] !== "adopt") return { status: 404, body: { error: "not found" } };
  const spec = adoptSpecOf(typeof r.body.channel === "string" ? r.body.channel : undefined);
  if (!spec) return { status: 400, body: { error: "channel must be telegram, slack, discord or twilio" } };
  const held = heldCandidate(c);
  const doc = pj<Record<string, any>>(held?.doc, {});
  if (!held || !heldChannels(doc).some((s) => s.id === spec.id))
    return {
      status: 404,
      body: { error: "nothing-to-adopt", hint: `no ${spec.label} credential in a held config` },
    };
  const origin = c.settings().publicOrigin?.replace(/\/$/, "");
  if (!origin) return { status: 409, body: { error: "no-origin", hint: "publicOrigin is not set" } };
  let hook: string;
  if (spec.id === "telegram") {
    if (!c.secrets.webhookSecret)
      return {
        status: 409,
        body: { error: "no-webhook-secret", hint: "Worker secret TELEGRAM_WEBHOOK_SECRET is not set" },
      };
    hook = await hookUrl(origin, c.secrets.webhookSecret);
  } else hook = origin + (spec.hookPath ?? adapterByChannel(spec.config)?.hookPath ?? "");
  const extra: Record<string, string> = {};
  const given = r.body.fields;
  if (given && typeof given === "object")
    for (const [k, v] of Object.entries(given as Record<string, unknown>))
      if (typeof v === "string") extra[k] = v;
  const out = adoptDoc(doc, spec, hook, extra);
  if (!out) return { status: 404, body: { error: "nothing-to-adopt" } };
  if (out.missing.length)
    return {
      status: 409,
      body: { error: "missing-fields", missing: out.missing, hint: `ochost channels adopt ${spec.id}` },
    };
  if (spec.id === "telegram") {
    // Never the token in a ring row or an answer: only the HTTP status and Telegram's description.
    let description: string | null = null;
    const status = await tgCall(
      c.fetch,
      out.secrets.OC_TELEGRAM_BOT_TOKEN as string,
      "setWebhook",
      {
        url: hook,
        secret_token: c.secrets.webhookSecret,
        allowed_updates: MESSAGE_UPDATES,
        drop_pending_updates: false,
      },
      (j) => {
        const x = j as { ok?: boolean; description?: string } | null;
        description = x?.ok === true ? null : (x?.description ?? "no answer");
      },
    );
    if (status !== 200 || description !== null) {
      ring(c, "adopt", "refused", { channel: spec.id, http: status, description });
      return { status: 502, body: { ok: false, error: "set-webhook-failed", http: status, description } };
    }
  }
  for (const [env, value] of Object.entries(out.secrets))
    await credPutText(c, `${ADOPTED_PREFIX}${env}`, value);
  const prop = await configPropose(c, { source: "owner", doc: out.doc, baseVer: newestConfig(c)?.ver });
  if (prop.status !== 200) {
    // Keep the stored credentials: a retry or an `ochost config` fix can still use them.
    ring(c, "adopt", "config-refused", { channel: spec.id, status: prop.status });
    return prop;
  }
  const ver = Number(prop.body.ver);
  c.db.run("UPDATE config SET status = 'rejected' WHERE status = 'held'");
  c.db.setMeta(`adopted:${spec.id}`, { at: c.now(), ver, held: held.ver });
  seedAdopted(c);
  let applied: "restart" | "next-boot" = "next-boot";
  const st = await d.rtState().catch(() => null);
  if (st === "running" || st === "starting" || st === "maintenance") {
    await d.restart();
    applied = "restart";
  }
  ring(c, "adopt", "done", { channel: spec.id, ver, secrets: Object.keys(out.secrets), applied });
  return {
    status: 200,
    body: {
      ok: true,
      channel: spec.id,
      configVer: ver,
      secrets: Object.keys(out.secrets),
      applied,
      hook: spec.id === "telegram" ? `${origin}/_ochost/hook/telegram/[redacted]` : hook,
    },
  };
}
