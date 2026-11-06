// Wake allowlist export (spec 08 §12.2, §23 `PUT /v1/wake-allow`; M3 fix O5). While asleep the Control DO
// holds Telegram updates from senders not on this list instead of waking. Source: the rendered OpenClaw
// config, `channels.telegram` and each `channels.telegram.accounts.<id>`: `allowFrom` (user ids),
// `groupAllowFrom` and the keys of `groups` (group chat ids). A wildcard or an open DM policy means any
// sender may talk to the agent, so no list is exported (the DO then treats the list as stale: every update
// wakes; fails toward delivery). Pairing-approved senders live in state/openclaw.sqlite
// (channel_pairing_allow_entries, 2026.10.9), not in the config: deps.pairedIds() adds them (M3 e2e: a paired
// owner's DM was held, not woken, and went dead).

const ID = /^-?\d{1,20}$/;
const norm = (v) =>
  String(v ?? "")
    .trim()
    .replace(/^(telegram|tg):/i, "");

/** Config doc → {userIds, groupChatIds} or null (do not export). Pure. */
export function wakeAllowFrom(doc) {
  const tg = doc?.channels?.telegram;
  if (!tg || tg.enabled === false) return null;
  const blocks = [tg, ...Object.values(tg.accounts || {})].filter((b) => b && typeof b === "object");
  const users = new Set();
  const groups = new Set();
  for (const b of blocks) {
    if (b.dmPolicy === "open") return null;
    for (const v of Array.isArray(b.allowFrom) ? b.allowFrom : []) {
      const s = norm(v);
      if (s === "*") return null;
      if (ID.test(s)) users.add(s);
    }
    for (const v of Array.isArray(b.groupAllowFrom) ? b.groupAllowFrom : []) {
      const s = norm(v);
      if (s === "*") return null;
      if (ID.test(s)) users.add(s); // group senders are user ids
    }
    for (const k of Object.keys(b.groups || {})) {
      const s = norm(k);
      if (s === "*") return null;
      if (ID.test(s)) groups.add(s);
    }
  }
  return { userIds: [...users].slice(0, 10_000), groupChatIds: [...groups].slice(0, 10_000) };
}

/**
 * Export once: read the config text, build the list, PUT it. deps: {readConfig() → text|null, put(body),
 * configVer, log}. Returns {ok, skipped?, n?}. Never throws (a failed export leaves the DO list stale).
 */
export async function exportWakeAllow(deps) {
  try {
    const text = await deps.readConfig();
    if (!text) return { ok: false, skipped: "no-config" };
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false, skipped: "config-not-json" };
    }
    const list = wakeAllowFrom(doc);
    if (!list) return { ok: true, skipped: "open" };
    const paired = deps.pairedIds ? await deps.pairedIds().catch(() => null) : [];
    if (paired === null) return { ok: false, skipped: "pairing-unreadable" }; // stale list: every update wakes
    const users = new Set(list.userIds);
    for (const v of paired) {
      const s = norm(v);
      if (ID.test(s)) users.add(s);
    }
    list.userIds = [...users].slice(0, 10_000);
    await deps.put({
      ...list,
      ...(Number.isInteger(deps.configVer) && deps.configVer >= 0 ? { configVer: deps.configVer } : {}),
    });
    return { ok: true, n: list.userIds.length + list.groupChatIds.length };
  } catch (e) {
    deps.log?.("wake-allow-failed", { err: String(e?.message || e).slice(0, 200) });
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
