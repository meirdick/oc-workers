// SandboxGate at 15.0.0.4:80 (docs/12 §4). The sandbox backend client (image/ocrt/plugins/ochost-sandbox/sbx.mjs)
// runs as uid 1000 in the gateway and posts each remote shell here; nft lets uid 1000 reach this address
// (image/ocrt/lib/netfilter.mjs). No credential in the container: the address exists only inside this install's
// container, the gen fence stops a stale gateway, and the budgets bound a steered agent.
//   POST /exec   wire of sbx/wire.ts → forwarded to the SandboxSession DO `sb:<inst>`
// Refusals: 403 sandbox off, 409 gen not current, 429 exec or sandbox budget spent, 503 no SANDBOX binding.
import type { GatePort } from "./ledger";
import type { GateProps } from "./types";

export const SBX_ADDR = "15.0.0.4:80";
/** Header the gate sets for the DO: seconds left in today's exec budget (the per-command limit). */
export const MAX_S_HEADER = "x-sbx-max-s";

export interface SbxGateDeps {
  props: Pick<GateProps, "inst" | "epoch" | "gen">;
  ctl: Pick<GatePort, "sbxAdmit" | "ring">;
  /** SandboxSession DO stub for this install; null when the Worker has no SANDBOX binding. */
  session: { fetch(req: Request): Promise<Response> } | null;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

export async function handleSandboxGate(req: Request, d: SbxGateDeps): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (path !== "/exec") return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!req.body) return json({ error: "body required" }, 400);
  try {
    const a = await d.ctl.sbxAdmit(d.props.epoch, d.props.gen);
    if (!a.on) return json({ error: "sandbox off" }, 403);
    if (!a.current.current) return json({ error: "stale", why: a.current.why ?? null }, 409);
    for (const t of [a.exec, a.sandbox])
      if (!t.ok)
        return json(
          { error: "budget", verb: t.verb, used: Math.round(t.used * 100) / 100, limit: t.limit },
          429,
          { "retry-after": String(t.retryAfterS) },
        );
    if (!d.session) return json({ error: "no sandbox binding" }, 503);
    const left = Math.max(1, Math.floor(a.exec.limit - a.exec.used));
    return await d.session.fetch(
      new Request("http://sbx/exec", {
        method: "POST",
        headers: { [MAX_S_HEADER]: String(left), "content-type": "application/x-ochost-sbx" },
        body: req.body,
        duplex: "half",
      } as RequestInit),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void d.ctl.ring("sbx", "gate-error", { msg: msg.slice(0, 300) }).catch(() => undefined);
    return json({ error: "gate", detail: msg.slice(0, 200) }, 502);
  }
}
