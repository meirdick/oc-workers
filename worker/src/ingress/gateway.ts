// OpenClaw trusted-proxy settings that match the headers the Worker sets (plan §7 "Gateway (trusted-proxy)",
// oc docs/gateway/trusted-proxy-auth.md). The Control DO puts these in plan.managed (ctl/plan.ts); ocsup
// renders them (image/ocrt/lib/config.mjs managedKeys).

/** Identity header. Not an `x-forwarded-*` name: the Runtime DO proxy strips those and sets its own. */
export const GATEWAY_USER_HEADER = "x-ochost-user";
export const OWNER_IDENTITY = "owner";
/** getTcpPort source on CF (M0 T2 item 3, 1 instance; amend §2 row 7). */
export const CF_TRUSTED_PROXIES = ["10.1.0.0/32"];

/**
 * Origins of the Control UI. `publicOrigin` = the active one: the custom domain when Access is on
 * (ACCESS_DOMAIN), else workers.dev. `allowedOrigins` = both, so either entry passes OpenClaw's origin check.
 */
export function uiOrigins(o: { publicOrigin?: string; uiOrigin?: string }): {
  publicOrigin?: string;
  allowedOrigins?: string[];
} {
  const clean = (x?: string) => (x && /^https?:\/\/[^/\s]+\/?$/.test(x) ? x.replace(/\/$/, "") : undefined);
  const dev = clean(o.publicOrigin);
  const ui = clean(o.uiOrigin) ?? dev;
  if (!ui) return {};
  return { publicOrigin: ui, allowedOrigins: [...new Set([ui, ...(dev ? [dev] : [])])] };
}

/** `https://<host>` for ACCESS_DOMAIN, or undefined. */
export function accessOrigin(domain?: string): string | undefined {
  const d = domain?.trim().toLowerCase().replace(/\.$/, "");
  return d && /^[a-z0-9.-]+$/.test(d) ? `https://${d}` : undefined;
}

export function gatewayAuthManaged(
  o: { publicOrigin?: string; allowedOrigins?: string[]; trustedProxies?: string[] } = {},
) {
  const m: { path: string; value: unknown }[] = [
    { path: "gateway.auth.mode", value: "trusted-proxy" },
    {
      path: "gateway.trustedProxies",
      value: o.trustedProxies?.length ? o.trustedProxies : CF_TRUSTED_PROXIES,
    },
    { path: "gateway.auth.trustedProxy.userHeader", value: GATEWAY_USER_HEADER },
    { path: "gateway.auth.trustedProxy.requiredHeaders", value: ["x-forwarded-proto", "x-forwarded-host"] },
    { path: "gateway.auth.trustedProxy.allowUsers", value: [OWNER_IDENTITY] },
    { path: "gateway.auth.trustedProxy.allowLoopback", value: false },
    // One owner (D4): the cookie is the approval gate for the owner's browser devices (no host-side
    // pairing step). Default scopes; admin only as a session grant to the owner identity.
    { path: "gateway.auth.trustedProxy.deviceAutoApprove", value: { enabled: true } },
    { path: "gateway.auth.identityScopes", value: { [OWNER_IDENTITY]: ["operator.admin"] } },
  ];
  if (o.publicOrigin) m.push({ path: "gateway.publicOrigin", value: o.publicOrigin.replace(/\/$/, "") });
  // Without this list OpenClaw allows only publicOrigin; with Access on, workers.dev stays a valid entry too.
  if (o.allowedOrigins?.length)
    m.push({
      path: "gateway.controlUi.allowedOrigins",
      value: o.allowedOrigins.map((x) => x.replace(/\/$/, "")),
    });
  return m;
}
