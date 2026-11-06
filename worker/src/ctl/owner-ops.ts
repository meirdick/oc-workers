// Owner routes added for the ochost CLI (M5, docs/10-cli-spec.md §1.3 W1, W5, W8; M5-STATUS §7).
// W5 GET /ops/snapshots: the snapshot index with kind, size, age, chain and TTL.
// W1 GET /ops/pairing?ch=telegram: recent Telegram senders in the inbox that no allowlist knows (owner id
//    capture); POST /ops/pairing/approve {ch, code|id}: add the id to channels.telegram.allowFrom (new config
//    version) and to the wake allowlist, release its held updates, then apply (restart when awake).
// W8 (Control DO half): the Worker-side setWebhook (ops-telegram.ts) records here and, in test mode, talks to
//    a fake that keeps its state in meta.
import { sha256Hex } from "../core/ids";
import type { RtState } from "../core/types";
import { configPropose, newestConfig } from "./config";
import { type Ctx, ring } from "./ctx";
import { getWakeAllow, putWakeAllow, ROUTE_TG } from "./inbox";
import { ttlEnd } from "./snapshots";
import { pj } from "./sql";

type Res = { status: number; body: unknown };

// ---------------------------------------------------------------- W5 snapshots

interface SnapListRow {
  id: string;
  size: number | null;
  image_key: string;
  digest: string;
  kind: string;
  gen: number;
  epoch: number;
  parent_id: string | null;
  chain_base: string | null;
  created_at: number;
  last_restored_at: number | null;
  state: string;
}

/** GET /ops/snapshots[?limit=N&all=1]. Default: every state but `expired`, newest first, 50 rows. */
export function listSnapshots(c: Ctx, q: Record<string, string>): Res {
  const limit = Math.min(500, Math.max(1, Number(q.limit ?? 50) || 50));
  const all = q.all === "1";
  const rows = c.db.all<SnapListRow>(
    `SELECT id, size, image_key, digest, kind, gen, epoch, parent_id, chain_base, created_at, last_restored_at,
       state FROM snapshots ${all ? "" : "WHERE state != 'expired'"} ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
  // Chain length per row: walk parents in the index (bounded; a cycle cannot occur but is capped anyway).
  const parentOf = new Map<string, string | null>();
  for (const r of c.db.all<{ id: string; parent_id: string | null }>("SELECT id, parent_id FROM snapshots"))
    parentOf.set(r.id, r.parent_id);
  const chainLen = (id: string) => {
    let n = 0;
    let cur: string | null | undefined = id;
    while (cur && n < 1000) {
      n++;
      cur = parentOf.get(cur);
    }
    return n;
  };
  const now = c.now();
  const snapshots = rows.map((r) => {
    const exp = ttlEnd(c, r);
    return {
      id: r.id,
      kind: r.kind,
      state: r.state,
      size: r.size,
      gen: r.gen,
      epoch: r.epoch,
      imageKey: r.image_key,
      digest: r.digest.slice(0, 19),
      parent: r.parent_id,
      chainBase: r.chain_base,
      chainLength: chainLen(r.id),
      createdAt: r.created_at,
      ageMs: now - r.created_at,
      lastRestoredAt: r.last_restored_at,
      expiresAt: exp,
      ttlLeftMs: Math.max(0, exp - now),
    };
  });
  const tot = c.db.one<{ n: number; b: number | null }>(
    "SELECT COUNT(*) AS n, SUM(size) AS b FROM snapshots WHERE state IN ('ok', 'suspect')",
  );
  return {
    status: 200,
    body: {
      snapshots,
      live: { count: tot?.n ?? 0, bytes: tot?.b ?? 0 },
      newest: snapshots[0]?.id ?? null,
      ttlMs: c.timers.snapshotTtlMs,
    },
  };
}

// ---------------------------------------------------------------- W1 pairing (owner Telegram id capture)

const ID = /^-?\d{1,20}$/;
const norm = (v: unknown) =>
  String(v ?? "")
    .trim()
    .replace(/^(telegram|tg):/i, "");
const PAIR_WINDOW_MS = 24 * 3_600_000;
const ABC = "23456789abcdefghjkmnpqrstuvwxyz";

/** 6-char code for a sender id, stable per install (no storage; no look-alike chars). */
export async function pairCode(inst: string, id: string): Promise<string> {
  const h = await sha256Hex(`oc-host:pair:${inst}:${id}`);
  let out = "";
  for (let i = 0; i < 6; i++) out += ABC[Number.parseInt(h.slice(i * 2, i * 2 + 2), 16) % ABC.length];
  return out;
}

/** Ids the install already knows: config allowFrom (channel and accounts) and the wake allowlist. */
function knownIds(c: Ctx): Set<string> {
  const out = new Set<string>();
  const doc = pj<Record<string, any>>(newestConfig(c)?.doc, {});
  const tg = doc?.channels?.telegram;
  if (tg && typeof tg === "object") {
    const blocks = [tg, ...Object.values(tg.accounts ?? {})].filter((b) => b && typeof b === "object");
    for (const b of blocks as Record<string, unknown>[])
      for (const k of ["allowFrom", "groupAllowFrom"])
        for (const v of Array.isArray(b[k]) ? (b[k] as unknown[]) : []) out.add(norm(v));
  }
  for (const v of getWakeAllow(c)?.userIds ?? []) out.add(norm(v));
  return out;
}

export interface PairRequest {
  code: string;
  id: string;
  name: string;
  username: string | null;
  chatId: string | null;
  chatType: string | null;
  text: string | null;
  count: number;
  firstAt: number;
  lastAt: number;
  held: number;
}

/** Unknown senders in the inbox of the last 24 h, newest first (max 20). */
export async function pairRequests(c: Ctx): Promise<PairRequest[]> {
  const known = knownIds(c);
  const rows = c.db.all<{
    sender_id: string | null;
    chat_id: string | null;
    body: string;
    received_at: number;
    state: string;
  }>(
    `SELECT sender_id, chat_id, body, received_at, state FROM inbox WHERE route = ? AND received_at >= ?
     AND sender_id IS NOT NULL ORDER BY received_at DESC LIMIT 500`,
    ROUTE_TG,
    c.now() - PAIR_WINDOW_MS,
  );
  const by = new Map<string, PairRequest>();
  for (const r of rows) {
    const id = norm(r.sender_id);
    if (!ID.test(id) || known.has(id)) continue;
    let from: Record<string, any> = {};
    let chat: Record<string, any> = {};
    let text: string | null = null;
    try {
      const u = JSON.parse(r.body) as Record<string, any>;
      const m = u.message ?? u.edited_message ?? u.callback_query?.message ?? {};
      from = u.message?.from ?? u.edited_message?.from ?? u.callback_query?.from ?? {};
      chat = m.chat ?? {};
      text = typeof m.text === "string" ? m.text.slice(0, 60) : null;
    } catch {}
    if (from.is_bot === true) continue;
    const have = by.get(id);
    if (have) {
      have.count++;
      have.firstAt = Math.min(have.firstAt, r.received_at);
      if (r.state === "held") have.held++;
      continue;
    }
    const name = [from.first_name, from.last_name].filter((x) => typeof x === "string").join(" ");
    by.set(id, {
      code: await pairCode(c.inst, id),
      id,
      name: name || (typeof from.username === "string" ? `@${from.username}` : ""),
      username: typeof from.username === "string" ? from.username : null,
      chatId: r.chat_id,
      chatType: typeof chat.type === "string" ? chat.type : null,
      text,
      count: 1,
      firstAt: r.received_at,
      lastAt: r.received_at,
      held: r.state === "held" ? 1 : 0,
    });
  }
  return [...by.values()].slice(0, 20);
}

export interface PairingDeps {
  rtState(): Promise<RtState | null>;
  restart(): Promise<unknown>;
  wake(): Promise<unknown>;
}

export async function opsPairing(
  c: Ctx,
  r: { method: string; sub: string[]; query: Record<string, string>; body: Record<string, unknown> },
  d: PairingDeps,
): Promise<Res> {
  const ch = String(r.query.ch ?? r.body.ch ?? "telegram");
  if (ch !== "telegram") return { status: 400, body: { error: "ch must be telegram" } };
  if (r.method === "GET" && !r.sub.length) {
    const requests = await pairRequests(c);
    return {
      status: 200,
      body: { ch, requests, windowMs: PAIR_WINDOW_MS, owner: c.db.meta("ownerTelegramId") },
    };
  }
  // S1.11: the owner's Telegram id from init / channels add: its first DM is approved without a code.
  if (r.method === "POST" && r.sub[0] === "owner") {
    const id = norm(r.body.id);
    if (!ID.test(id) || id.startsWith("-"))
      return { status: 400, body: { error: "id must be a numeric Telegram user id" } };
    c.db.setMeta("ownerTelegramId", id);
    ring(c, "pairing", "owner", { id });
    return { status: 200, body: { ok: true, owner: id, approved: knownIds(c).has(id) } };
  }
  if (r.method !== "POST" || (r.sub[0] !== "approve" && r.sub[0] !== "allow"))
    return { status: 404, body: { error: "not found" } };
  const code = typeof r.body.code === "string" ? r.body.code.trim().toLowerCase() : "";
  const idIn = r.body.id === undefined ? "" : norm(r.body.id);
  if (!code && !idIn) return { status: 400, body: { error: "code or id required" } };
  if (idIn && !ID.test(idIn)) return { status: 400, body: { error: "id must be a numeric Telegram id" } };
  const reqs = await pairRequests(c);
  const hit = code ? reqs.find((q) => q.code === code) : reqs.find((q) => q.id === idIn);
  if (code && !hit)
    return { status: 404, body: { error: "no-request", hint: "GET /ops/pairing?ch=telegram" } };
  const id = hit?.id ?? idIn;
  const newest = newestConfig(c);
  const doc = pj<Record<string, any>>(newest?.doc, {});
  const tg = doc?.channels?.telegram;
  if (!newest || !tg || typeof tg !== "object")
    return { status: 409, body: { error: "no-telegram-channel", hint: "ochost channels add telegram" } };
  const next = structuredClone(doc);
  const t = next.channels.telegram as Record<string, unknown>;
  const allow = (Array.isArray(t.allowFrom) ? (t.allowFrom as unknown[]) : []).map(String);
  if (!allow.map(norm).includes(id)) allow.push(id);
  t.allowFrom = allow;
  if (r.body.dmPolicy === "allowlist" || r.body.dmPolicy === "pairing") t.dmPolicy = r.body.dmPolicy;
  const prop = await configPropose(c, { source: "owner", doc: next, baseVer: newest.ver });
  if (prop.status !== 200) return prop;
  const ver = Number(prop.body.ver);
  // The wake allowlist is written after the config version, so it is fresh for allowFresh() (same ms is ok).
  const w = getWakeAllow(c);
  // Keep the config's numeric ids too: with no export yet, a list of only `id` would hold the others' DMs.
  const users = [...new Set([...(w?.userIds ?? []), ...allow.map(norm).filter((x) => ID.test(x)), id])];
  putWakeAllow(c, { userIds: users, groupChatIds: w?.groupChatIds ?? [], configVer: ver });
  const held =
    c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE state = 'held' AND sender_id = ?", id)
      ?.n ?? 0;
  if (held) c.db.run("UPDATE inbox SET state = 'pending' WHERE state = 'held' AND sender_id = ?", id);
  // Config applies at boot: restart when awake, wake when updates wait, else the next boot takes it.
  let applied: "restart" | "wake" | "next-boot" | "none" = "next-boot";
  const st = await d.rtState().catch(() => null);
  if (r.body.restart === false) applied = "none";
  else if (st === "running" || st === "starting" || st === "maintenance") {
    await d.restart();
    applied = "restart";
  } else if (held) {
    await d.wake();
    applied = "wake";
  }
  ring(c, "pairing", "approve", { ch, ver, released: held, applied, same: prop.body.same === true });
  return {
    status: 200,
    body: {
      ok: true,
      ch,
      id,
      name: hit?.name ?? null,
      configVer: ver,
      same: prop.body.same === true,
      wakeAllow: users.length,
      released: held,
      applied,
    },
  };
}

// ---------------------------------------------------------------- W8 (Control DO half)

interface FakeHook {
  url: string;
  allowed_updates: string[] | null;
  secret: boolean;
  at: number;
}

/** Internal action `telegram-int` (never routed from /ops): ring notes, managed URL in config, test fake. */
export async function telegramInternal(
  c: Ctx,
  r: { sub: string[]; body: Record<string, unknown> },
): Promise<Res> {
  const what = r.sub[0] ?? "";
  if (what === "note") {
    ring(c, "telegram", String(r.body.kind ?? "note"), r.body.detail ?? null);
    return { status: 200, body: { ok: true } };
  }
  if (what === "managed-url") {
    // The gateway calls setWebhook with channels.telegram.webhookUrl at each boot: keep it on the same URL.
    const url = String(r.body.url ?? "");
    const newest = newestConfig(c);
    const doc = pj<Record<string, any>>(newest?.doc, {});
    const tg = doc?.channels?.telegram;
    if (!newest || !tg || typeof tg !== "object")
      return { status: 200, body: { changed: false, why: "no-telegram-channel" } };
    if (tg.webhookUrl === url) return { status: 200, body: { changed: false, configVer: newest.ver } };
    const next = structuredClone(doc);
    next.channels.telegram.webhookUrl = url;
    const p = await configPropose(c, { source: "owner", doc: next, baseVer: newest.ver });
    if (p.status !== 200) return { status: p.status, body: { changed: false, ...p.body } };
    return { status: 200, body: { changed: true, configVer: p.body.ver } };
  }
  if (what === "fake") {
    if (!c.test) return { status: 404, body: { error: "not found" } };
    const method = String(r.body.method ?? "");
    const p = (r.body.params ?? {}) as Record<string, unknown>;
    const cur = c.db.metaJson<FakeHook | null>("tgFakeHook", null);
    let out: unknown;
    if (method === "setWebhook") {
      const h: FakeHook = {
        url: String(p.url ?? ""),
        allowed_updates: Array.isArray(p.allowed_updates) ? (p.allowed_updates as string[]) : null,
        secret: typeof p.secret_token === "string" && p.secret_token.length > 0,
        at: c.now(),
      };
      c.db.setMeta("tgFakeHook", h);
      out = { ok: true, result: true, description: "Webhook was set" };
    } else if (method === "getWebhookInfo") {
      const pending =
        c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE state = 'pending'")?.n ?? 0;
      out = {
        ok: true,
        result: {
          url: cur?.url ?? "",
          has_custom_certificate: false,
          pending_update_count: pending,
          ...(cur?.allowed_updates ? { allowed_updates: cur.allowed_updates } : {}),
        },
      };
    } else if (method === "deleteWebhook") {
      c.db.delMeta("tgFakeHook");
      out = { ok: true, result: true, description: "Webhook was deleted" };
    } else out = { ok: false, error_code: 404, description: "Not Found" };
    ring(c, "telegram", `fake ${method}`, { worker: true });
    return { status: 200, body: out };
  }
  return { status: 404, body: { error: "not found" } };
}

/**
 * S1.11: a DM from the owner's Telegram id (POST /ops/pairing/owner) that no allowlist knows yet is approved like
 * `ochost pairing approve`, once. Returns the approve answer, or null when it does not apply.
 */
export async function autoApproveOwner(
  c: Ctx,
  fromId: string | null,
  chatId: string | null,
  d: PairingDeps,
): Promise<Res | null> {
  const owner = c.db.meta("ownerTelegramId");
  if (!owner || fromId !== owner || chatId !== owner || knownIds(c).has(owner)) return null;
  if (c.db.meta("ownerApprovedAt")) return null;
  c.db.setMeta("ownerApprovedAt", c.now());
  const out = await opsPairing(
    c,
    { method: "POST", sub: ["approve"], query: {}, body: { ch: "telegram", id: owner } },
    d,
  );
  if (out.status !== 200) c.db.delMeta("ownerApprovedAt"); // e.g. no telegram channel yet: try at the next DM
  ring(c, "pairing", "owner-auto", { id: owner, status: out.status });
  return out;
}
