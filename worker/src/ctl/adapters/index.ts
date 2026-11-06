// Registry of inbox adapters and the Worker secrets they read.
import { discord } from "./discord";
import { slack } from "./slack";
import { twilio } from "./twilio";
import type { InboxAdapter, PlatformSecrets } from "./types";

export type { InboxAdapter, PlatformSecrets, Verdict } from "./types";

export const ADAPTERS: readonly InboxAdapter[] = [slack, discord, twilio];

export const adapterByChannel = (channel: string) => ADAPTERS.find((a) => a.channel === channel);
export const adapterByRoute = (route: string) => ADAPTERS.find((a) => a.route === route);
export const adapterByPath = (path: string) => ADAPTERS.find((a) => a.hookPath === path);

/** Worker secret OC_SECRET_<NAME> holds the value; the gateway sees env NAME. */
export const SECRET_PREFIX = "OC_SECRET_";

/** The adapters' secrets from a Worker env. */
export function platformSecrets(env: object): PlatformSecrets {
  const e = env as Record<string, unknown>;
  const out: PlatformSecrets = {};
  for (const a of ADAPTERS)
    for (const n of a.secrets) {
      const v = e[SECRET_PREFIX + n];
      out[n] = typeof v === "string" && v ? v : undefined;
    }
  return out;
}
