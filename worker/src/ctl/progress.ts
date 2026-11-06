// Wake progress message. An update that lands while the install is not running gets one Telegram message
// ("Waking up, about 30 s") from the Worker; the Control DO alarm edits it with the wake phase and elapsed
// seconds, and when the gateway's first outbound send to that chat is seen (gates/telegram.ts → noteOutbound)
// it deletes the message or edits it to "Ready in N s" (`telegram.wakeProgress`: delete | ready | off).
// One message per chat per wake: later updates to the same chat share it. Bot token as in typing.ts.
import { type Ctx, ring } from "./ctx";
import { REPLY_METHODS } from "./inbox";
import { tgCall } from "./typing";

export const WAKE_ETA_S = 30;
export const PROGRESS_EVERY_MS = 5_000;
export const PROGRESS_MAX_MS = 180_000;
/** A reply seen before the Worker reported the message id: wait this long for the id, then forget. */
const ID_WAIT_MS = 15_000;

export type ProgressMode = "delete" | "ready" | "off";
interface Entry {
  /** Telegram message_id; null until the Worker reports the send. */
  msg: number | null;
  startedAt: number;
  next: number;
  lastText: string;
  /** Time of the gateway's first outbound send to the chat; set → finish at the next tick. */
  doneAt?: number;
}
type Book = Record<string, Entry>;
const KEY = "progress";

export const firstText = () => `Waking up, about ${WAKE_ETA_S} s`;
export const modeOf = (c: Ctx): ProgressMode => c.settings().telegram?.wakeProgress ?? "delete";

/** Called at arrival for a non-running install. Returns true when this update must send the message. */
export function progressStart(c: Ctx, chatId: string): boolean {
  if (!c.secrets.botToken || modeOf(c) === "off") return false;
  const book = c.db.metaJson<Book>(KEY, {});
  const e = book[chatId];
  if (e && !e.doneAt && c.now() - e.startedAt < PROGRESS_MAX_MS) return false;
  const now = c.now();
  book[chatId] = { msg: null, startedAt: now, next: now + PROGRESS_EVERY_MS, lastText: firstText() };
  c.db.setMeta(KEY, book);
  return true;
}

/** The Worker's send finished: store the message id, or drop the entry when the send failed. */
export function progressSent(c: Ctx, chatId: string, msg: number | null): void {
  const book = c.db.metaJson<Book>(KEY, {});
  const e = book[chatId];
  if (!e) return;
  if (msg === null) delete book[chatId];
  else e.msg = msg;
  c.db.setMeta(KEY, book);
}

/** The gateway sent to this chat. Marks the entry done (the tick finishes it). */
export function progressNoteOutbound(
  c: Ctx,
  chatId: string | number | null,
  at: number,
  method: string,
): void {
  if (chatId === null || !REPLY_METHODS.test(method)) return;
  const book = c.db.metaJson<Book>(KEY, {});
  const e = book[String(chatId)];
  if (!e || e.doneAt || at < e.startedAt) return;
  e.doneAt = at;
  c.db.setMeta(KEY, book);
}

export function progressDueAt(c: Ctx): number | null {
  const xs = Object.values(c.db.metaJson<Book>(KEY, {})).map((e) =>
    e.doneAt ? (e.msg !== null ? 0 : e.doneAt + ID_WAIT_MS) : e.next,
  );
  return xs.length ? Math.min(...xs) : null;
}

/** ocsup event → wake phase label (set on the way in: ControlCore.event, and ControlApi.gateCall for the gate route). */
export function notePhase(c: Ctx, gen: number, kind: string): void {
  const label =
    kind === "gateway-starting" ? "starting gateway" : kind === "startupz" ? "almost ready" : null;
  if (label) c.db.setMeta("wakePhase", { gen, label, at: c.now() });
}

/** Wake phase label from the events of the current boot (control.ts event()). */
export function phaseLabel(c: Ctx): string {
  return c.db.metaJson<{ label: string }>("wakePhase", { label: "restoring" }).label;
}

/** Edit due messages, finish done ones, drop entries past the limit. */
export async function progressTick(c: Ctx): Promise<void> {
  const token = c.secrets.botToken;
  const book = c.db.metaJson<Book>(KEY, {});
  const now = c.now();
  const mode = modeOf(c);
  const out = new Map<string, Entry | null>();
  for (const [chat, e] of Object.entries(book)) {
    const done = !!e.doneAt;
    if (!done && e.next > now) continue;
    if (done && e.msg === null && now < (e.doneAt as number) + ID_WAIT_MS) continue;
    const over = now - e.startedAt >= PROGRESS_MAX_MS;
    if (e.msg === null) {
      // No id yet: the Worker send is in flight or lost. Done or over → forget it; else look again later.
      out.set(chat, done || over ? null : { ...e, next: now + PROGRESS_EVERY_MS });
      continue;
    }
    if (!token) {
      out.set(chat, null);
      continue;
    }
    if (done || over) {
      const secs = Math.round(((e.doneAt ?? now) - e.startedAt) / 1000);
      const st =
        done && mode === "ready"
          ? await tgCall(c.fetch, token, "editMessageText", {
              chat_id: chat,
              message_id: e.msg,
              text: `Ready in ${secs} s`,
            })
          : await tgCall(c.fetch, token, "deleteMessage", { chat_id: chat, message_id: e.msg });
      if (st >= 400) ring(c, "progress", "finish-failed", { chat, status: st });
      out.set(chat, null);
      continue;
    }
    const text = `Waking up: ${phaseLabel(c)} (${Math.round((now - e.startedAt) / 1000)} s)`;
    const st = await tgCall(c.fetch, token, "editMessageText", { chat_id: chat, message_id: e.msg, text });
    if (st >= 400 && st < 500 && st !== 429) {
      ring(c, "progress", "edit-refused", { chat, status: st });
      out.set(chat, null);
    } else out.set(chat, { ...e, lastText: text, next: c.now() + PROGRESS_EVERY_MS });
  }
  if (!out.size) return;
  const fresh = c.db.metaJson<Book>(KEY, {});
  for (const [chat, e] of out) {
    const cur = fresh[chat];
    if (!cur || cur.startedAt !== book[chat]?.startedAt) continue; // restarted meanwhile
    if (e === null) delete fresh[chat];
    else fresh[chat] = { ...cur, lastText: e.lastText, next: e.next };
  }
  c.db.setMeta(KEY, fresh);
}
