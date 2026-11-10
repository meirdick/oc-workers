// Console half of channel adoption (ctl/adopt.ts): the Control DO adds `channels.adopt` to the panel JSON, and the
// Setup tab shows one row per channel that waits for adoption or was adopted. Kept apart so pages.ts and
// panel-actions.ts only call it.
import { heldCandidate } from "./adopt";
import { heldChannels } from "./adopt-spec";
import type { Ctx } from "./ctx";
import type { Panel } from "./panel";
import { pj } from "./sql";

export interface AdoptView {
  held: { id: string; label: string }[];
  adopted: { id: string; label: string; at: number }[];
}

/** Panel facts: channels with a credential in a held config, and channels already adopted. Names only. */
export function adoptView(c: Ctx): AdoptView {
  const h = heldCandidate(c);
  const held = h ? heldChannels(pj(h.doc, {})).map((s) => ({ id: s.id, label: s.label })) : [];
  const adopted = (["telegram", "slack", "discord", "twilio"] as const).flatMap((id) => {
    const m = c.db.metaJson<{ at: number } | null>(`adopted:${id}`, null);
    if (!m || held.some((x) => x.id === id)) return [];
    return [{ id, label: id === "twilio" ? "Twilio SMS" : id[0]?.toUpperCase() + id.slice(1), at: m.at }];
  });
  return { held, adopted };
}

export interface AdoptRow {
  group: "ch";
  name: string;
  state: string;
  result: "WARN" | "PASS";
  button?: string;
  todo: boolean;
}

/** Setup rows. `post` renders the form button (pages.ts). */
export function adoptRows(
  p: Panel,
  post: (act: string, fields: Record<string, string>, label: string) => string,
): AdoptRow[] {
  const v = (p.channels as { adopt?: AdoptView }).adopt;
  if (!v) return [];
  return [
    ...v.held.map((x) => ({
      group: "ch" as const,
      name: x.label,
      state: "Token in the UI config, waiting for adoption",
      result: "WARN" as const,
      button: post("adopt", { channel: x.id }, "Adopt"),
      todo: true,
    })),
    ...v.adopted.map((x) => ({
      group: "ch" as const,
      name: x.label,
      state: `${x.label}: adopted from the UI`,
      result: "PASS" as const,
      todo: false,
    })),
  ];
}
