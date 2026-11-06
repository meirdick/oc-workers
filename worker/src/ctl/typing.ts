// Cold-path typing indicator. A webhook update that lands while the gateway cannot take it (asleep, starting,
// ingress not ready) gets `sendChatAction typing` at once from the Worker; the Control DO alarm repeats it every
// 4 s until the row has a reply, goes dead, or 60 s pass. Telegram clears the action after 5 s. The bot token is
// the Worker secret OC_SECRET_OC_TELEGRAM_BOT_TOKEN; it is never logged.
import { type Ctx, ring } from "./ctx";

export const TYPING_EVERY_MS = 4_000;
export const TYPING_MAX_MS = 60_000;
const API = "https://api.telegram.org";

interface Entry {
  row: string;
  until: number;
  next: number;
}
type Book = Record<string, Entry>;

/** Bot API call with a JSON body. Returns the HTTP status; 0 on a network error. `reply` gets the parsed body. */
export async function tgCall(
  f: typeof fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  reply?: (j: unknown) => void,
): Promise<number> {
  try {
    const res = await f(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (reply) reply(await res.json().catch(() => null));
    else await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

/** POST sendChatAction typing. Returns the HTTP status; 0 on a network error. */
export async function sendTyping(
  f: typeof fetch,
  token: string,
  chatId: string | number,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const res = await f(`${API}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      signal,
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

/** Content fields of a user's message. Service messages (bot added, title changed, pin) carry none of them. */
const CONTENT = [
  "text",
  "caption",
  "photo",
  "voice",
  "audio",
  "video",
  "video_note",
  "document",
  "sticker",
  "animation",
  "location",
  "contact",
  "poll",
];

/**
 * The chat a cold-path typing or progress message may go to: only a chat where a person just wrote to the bot (a
 * `message` with content) or pressed one of its buttons (`callback_query`). Never for my_chat_member, chat_member,
 * reactions, join requests or service messages, so the Worker never writes first into a chat (bot added to a group).
 */
export function coldReplyChat(body: string): string | null {
  let u: any;
  try {
    u = JSON.parse(body);
  } catch {
    return null;
  }
  const m = u?.message ?? u?.callback_query?.message;
  const from = u?.message ? u.message.from : u?.callback_query?.from;
  if (!m || typeof m !== "object" || !from || from.is_bot) return null;
  if (u.message && !CONTENT.some((k) => k in m)) return null;
  const id = m.chat?.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

/** Track a chat for repeats. The Worker sends the first action itself, so the first repeat is 4 s out. */
export function typingTrack(c: Ctx, chatId: string, rowId: string): void {
  if (!c.secrets.botToken) return;
  const book = c.db.metaJson<Book>("typing", {});
  const now = c.now();
  book[chatId] = { row: rowId, until: now + TYPING_MAX_MS, next: now + TYPING_EVERY_MS };
  c.db.setMeta("typing", book);
}

/** Next repeat time, or null when no chat is tracked. */
export function typingDueAt(c: Ctx): number | null {
  const xs = Object.values(c.db.metaJson<Book>("typing", {})).map((e) => e.next);
  return xs.length ? Math.min(...xs) : null;
}

/** Send every due repeat; drop chats that are done (replied, dead, held, 60 s over) or refused (4xx but 429). */
export async function typingTick(c: Ctx): Promise<void> {
  const token = c.secrets.botToken;
  const book = c.db.metaJson<Book>("typing", {});
  const now = c.now();
  const done = new Map<string, { row: string; next: number | null }>();
  for (const [chat, e] of Object.entries(book)) {
    if (e.next > now) continue;
    const row = c.db.one<{ state: string; replied_at: number | null }>(
      "SELECT state, replied_at FROM inbox WHERE id = ?",
      e.row,
    );
    const live = !!row && (row.state === "pending" || row.state === "accepted") && row.replied_at === null;
    if (!token || !live || now >= e.until) {
      done.set(chat, { row: e.row, next: null });
      continue;
    }
    const st = await sendTyping(c.fetch, token, chat);
    const refused = st >= 400 && st < 500 && st !== 429;
    if (refused) ring(c, "typing", "refused", { chat, status: st });
    done.set(chat, { row: e.row, next: refused ? null : c.now() + TYPING_EVERY_MS });
  }
  if (!done.size) return;
  // A webhook may have re-tracked a chat while the sends were in flight: only touch entries still on our row.
  const fresh = c.db.metaJson<Book>("typing", {});
  for (const [chat, d] of done) {
    const e = fresh[chat];
    if (!e || e.row !== d.row) continue;
    if (d.next === null) delete fresh[chat];
    else e.next = d.next;
  }
  c.db.setMeta("typing", fresh);
}
