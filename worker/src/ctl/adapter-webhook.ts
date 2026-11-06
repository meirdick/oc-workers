// POST /_ochost/hook/<slack|discord|twilio> (add §2.2, §3). Same order as the Telegram webhook (ctl/webhook.ts):
// verify, store through the Control DO in one write, ack, then wake through waitUntil. The ack never waits for the
// container, so it is inside every platform's deadline (Slack 3 s, Discord 3 s, Twilio 15 s).
import type { InboxAdapter, PlatformSecrets } from "./adapters/types";
import { BODY_MAX } from "./inbox";
import type { PutOut } from "./webhook-types";

export interface AdapterCtl {
  /** The platform's own check passed (URL challenge, PING). `ochost channels add` waits for it. */
  hookSeen(id: string, kind: string): Promise<unknown>;
  inboxPut(p: {
    route: string;
    body: string;
    headers: Record<string, string>;
    meta: { platformKey: string; senderId: string | null; chatId: string | null; hold?: boolean };
  }): Promise<PutOut>;
}
export interface AdapterDeps {
  secrets: PlatformSecrets;
  ctl: AdapterCtl;
  wake(): Promise<unknown>;
  waitUntil(p: Promise<unknown>): void;
  now?: () => number;
}

const reply = (r: { status: number; body?: string; headers?: Record<string, string> }) =>
  new Response(r.body ?? null, { status: r.status, headers: r.headers });

export async function handleAdapter(req: Request, a: InboxAdapter, d: AdapterDeps): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? "0") > BODY_MAX) return new Response(null, { status: 413 });
  const body = req.method === "POST" ? await req.text() : "";
  if (body.length > BODY_MAX) return new Response(null, { status: 413 });
  const v = await a.receive(
    { method: req.method, url: req.url, headers: req.headers, body, now: (d.now ?? Date.now)() },
    d.secrets,
  );
  if (v.kind === "respond") {
    if (v.seen) d.waitUntil(d.ctl.hookSeen(a.id, v.seen).catch(() => undefined));
    return reply(v.res);
  }
  const headers = { ...v.headers, host: req.headers.get("host") ?? new URL(req.url).host };
  let r: PutOut;
  try {
    r = await d.ctl.inboxPut({
      route: a.route,
      body,
      headers,
      meta: { platformKey: v.platformKey, senderId: v.senderId, chatId: v.chatId, hold: v.hold },
    });
  } catch {
    return new Response(null, { status: 503 }); // the platform retries
  }
  if (r.status !== 200) return new Response(null, { status: r.status });
  if ("wake" in r && r.wake) d.waitUntil(d.wake().catch(() => undefined));
  return reply(v.ack);
}
