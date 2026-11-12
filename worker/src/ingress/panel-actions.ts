// The owner panel's POST buttons (`/_ochost/panel/<act>`, routes.ts checks the owner cookie and the origin first).
// Each one calls the same /ops action the CLI uses: alerts resolve, caps, archive, archive/drill, pairing/approve.
import { raiseTo } from "../ctl/panel-checks";
import { CAP_DEFAULTS, CAP_MAX, isVerb } from "../gates/caps";

export type PanelOps = (r: {
  action: string;
  method: "GET" | "POST";
  sub?: string[];
  body?: Record<string, unknown>;
}) => Promise<{ status: number; body: unknown }>;

export const PANEL_ACTS = [
  "ack",
  "close",
  "raise",
  "archive",
  "drill",
  "approve",
  "sandbox",
  "alerts",
  "model",
  "adopt",
] as const;
export type PanelAct = (typeof PANEL_ACTS)[number];

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[^A-Za-z0-9 :._-]/g, "")
    .slice(0, 60);

/** The install runs → restart it (the same /ops/restart the CLI calls); asleep → the next start applies the change. */
async function applyByRestart(ops: PanelOps): Promise<{ code: string; why?: string }> {
  const st = await ops({ action: "status", method: "GET" });
  if ((st.body as { state?: string } | null)?.state !== "running") return { code: "saved-next" };
  const r = await ops({ action: "restart", method: "POST" });
  return r.status === 200 ? { code: "saved-restart" } : { code: "saved-next", why: `restart ${r.status}` };
}

/** Runs one button. Returns the notice for `/?n=…`: a code and an optional short reason. */
export async function panelAct(
  act: PanelAct,
  form: URLSearchParams,
  ops: PanelOps,
): Promise<{ code: string; why?: string }> {
  const bad = (why: unknown) => ({ code: "panel-failed", why: clean(why) });
  try {
    if (act === "ack" || act === "close") {
      // Close (1.2.5): the same op as `ochost alerts close <class>`; it logs a ring event. `ack` is the old name.
      const cls = form.get("class") ?? "";
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(cls)) return bad("bad alert class");
      const r = await ops({
        action: "alerts",
        method: "POST",
        sub: ["close"],
        body: { class: cls, by: "console" },
      });
      if (r.status === 404) return { code: "closed", why: "it was already closed" };
      return r.status === 200 ? { code: "closed" } : bad(`alerts ${r.status}`);
    }
    if (act === "raise") {
      const verb = form.get("verb") ?? "";
      if (!isVerb(verb)) return bad("bad cap");
      const cur = await ops({ action: "caps", method: "GET" });
      const limit = Number(
        (cur.body as { verbs?: Record<string, { limit?: number }> })?.verbs?.[verb]?.limit,
      );
      if (cur.status !== 200 || !Number.isFinite(limit)) return bad(`caps ${cur.status}`);
      // The form carries the limit the page showed: a second click (or a stale tab) does not double it again.
      const from = form.get("from");
      if (from !== null && Number(from) !== limit) return bad(`${verb} is already ${limit}: reload`);
      const next = raiseTo(limit, CAP_DEFAULTS[verb], CAP_MAX);
      if (next <= limit) return bad(`${verb} is at the highest limit`);
      const r = await ops({ action: "caps", method: "POST", body: { [verb]: next } });
      return r.status === 200 ? { code: "raised", why: `${verb} is now ${next}` } : bad(`caps ${r.status}`);
    }
    if (act === "sandbox") {
      // Same op as `ochost sandbox on|off|all`: POST /ops/sandbox/set, then a planned restart (no deploy: the
      // boot plan reads the setting).
      const value = form.get("value") ?? "";
      if (!["off", "on", "all"].includes(value)) return bad("bad sandbox value");
      const r = await ops({ action: "sandbox-set", method: "POST", body: { value } });
      if (r.status !== 200) return bad(`sandbox ${r.status}`);
      return applyByRestart(ops);
    }
    if (act === "alerts") {
      const how = form.get("do") ?? "";
      if (how === "test") {
        const code = Array.from(
          crypto.getRandomValues(new Uint8Array(6)),
          (b) => "23456789abcdefghjkmnpqrstuvwxyz"[b % 31],
        ).join("");
        const r = await ops({ action: "alerts", method: "POST", sub: ["test"], body: { code } });
        const sent = Number((r.body as { sent?: number } | null)?.sent ?? 0);
        if (r.status === 200 && sent > 0) return { code: "alerts-test", why: code };
        return bad(r.status === 200 ? "no alert channel is set" : `the channel refused it (${r.status})`);
      }
      if (how === "off") {
        const r = await ops({ action: "alerts", method: "POST", sub: ["sink"], body: { url: "" } });
        return r.status === 200 ? { code: "alerts-off" } : bad(`alerts ${r.status}`);
      }
      if (how !== "save") return bad("bad alerts action");
      const url = (form.get("url") ?? "").trim();
      if (!/^https:\/\/[^\s]{4,480}$/.test(url)) return bad("enter an https URL");
      const r = await ops({ action: "alerts", method: "POST", sub: ["sink"], body: { url } });
      return r.status === 200 ? { code: "alerts-saved" } : bad(`alerts ${r.status}`);
    }
    if (act === "model") {
      // Same path as `ochost model set`: a new config version (source owner) with the main model changed.
      const id = form.get("id") ?? "";
      const list = await ops({ action: "config", method: "GET" });
      const vers = ((list.body as { versions?: { ver: number }[] } | null)?.versions ?? []).map((v) => v.ver);
      if (list.status !== 200 || !vers.length) return bad(`config ${list.status}`);
      const ver = Math.max(...vers);
      const cur = await ops({ action: "config", method: "GET", sub: [String(ver)] });
      const doc = (cur.body as { doc?: Record<string, any> } | null)?.doc;
      if (cur.status !== 200 || !doc) return bad(`config ${cur.status}`);
      const known = (doc.models?.providers?.cfgw?.models ?? []).map((m: { id?: unknown }) => m?.id);
      if (!known.includes(id)) return bad("not in the model list");
      const next = structuredClone(doc);
      next.agents ??= {};
      next.agents.defaults ??= {};
      next.agents.defaults.model = { ...(next.agents.defaults.model ?? {}), primary: `cfgw/${id}` };
      const r = await ops({ action: "config", method: "POST", body: { doc: next, baseVer: ver } });
      const b = (r.body ?? {}) as { ok?: boolean; same?: boolean; error?: string };
      if (r.status === 409) return bad("config changed elsewhere: reload");
      if (r.status !== 200 || b.ok === false) return bad(`config ${r.status} ${b.error ?? ""}`);
      return b.same ? { code: "model-same" } : applyByRestart(ops);
    }
    if (act === "archive") {
      const r = await ops({ action: "archive", method: "POST", body: { reason: "owner" } });
      return r.status === 202 ? { code: "archive" } : bad(`archive ${r.status}`);
    }
    if (act === "drill") {
      const r = await ops({ action: "archive", method: "POST", sub: ["drill"] });
      if (r.status === 200) return { code: "drill-ok" };
      const e = (r.body as { error?: unknown; why?: unknown } | null) ?? {};
      return { code: "drill-failed", why: clean(e.error ?? e.why ?? `status ${r.status}`) };
    }
    if (act === "adopt") {
      const channel = form.get("channel") ?? "";
      if (!/^[a-z]{3,10}$/.test(channel)) return bad("bad channel");
      const r = await ops({ action: "channels", method: "POST", sub: ["adopt"], body: { channel } });
      const why = (r.body as { error?: unknown; description?: unknown } | null) ?? {};
      return r.status === 200
        ? { code: "adopted" }
        : bad(why.description ?? why.error ?? `channels ${r.status}`);
    }
    const code = form.get("code") ?? "";
    if (!/^[a-z0-9]{4,12}$/i.test(code)) return bad("bad code");
    const r = await ops({
      action: "pairing",
      method: "POST",
      sub: ["approve"],
      body: { ch: "telegram", code },
    });
    return r.status === 200 ? { code: "approved" } : bad(`pairing ${r.status}`);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "error");
  }
}
