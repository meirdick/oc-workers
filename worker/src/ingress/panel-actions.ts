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

export const PANEL_ACTS = ["ack", "raise", "archive", "drill", "approve"] as const;
export type PanelAct = (typeof PANEL_ACTS)[number];

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[^A-Za-z0-9 :._-]/g, "")
    .slice(0, 60);

/** Runs one button. Returns the notice for `/?n=…`: a code and an optional short reason. */
export async function panelAct(
  act: PanelAct,
  form: URLSearchParams,
  ops: PanelOps,
): Promise<{ code: string; why?: string }> {
  const bad = (why: unknown) => ({ code: "panel-failed", why: clean(why) });
  try {
    if (act === "ack") {
      const cls = form.get("class") ?? "";
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(cls)) return bad("bad alert class");
      const r = await ops({ action: "alerts", method: "POST", sub: ["resolve"], body: { class: cls } });
      return r.status === 200 ? { code: "acked" } : bad(`alerts ${r.status}`);
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
