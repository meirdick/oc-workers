// OC_SECRET_* Worker secrets as the gateway's env (SecretRefs). Own module so ops.ts can hand them to the Runtime DO
// without importing the DO class.
import type { Env } from "./types";

/**
 * Secrets that stay on the Worker. The AI token of installs made before the zero-token flow (docs/09) is one:
 * model calls go through CapGate and the binding, so the container never gets a Cloudflare credential.
 */
const WORKER_ONLY = new Set(["OC_SECRET_OC_CF_AI_TOKEN"]);

/** OC_* SecretRefs for the gateway (LLM keys, bot token): every env key starting with OC_SECRET_. */
export function secretEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (k.startsWith("OC_SECRET_") && !WORKER_ONLY.has(k) && typeof v === "string")
      out[k.slice("OC_SECRET_".length)] = v;
  }
  return out;
}
