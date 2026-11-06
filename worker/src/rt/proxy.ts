// Proxy to the gateway on 18789 (spec 08 §19.1, plan §7) and the WS bridge (spike rt/ws-bridge.ts).
// Both WS ends are accepted in the DO. 1005/1006 cannot be sent, so they map to 1000 (F14).
// M4: each bridge carries its owner session and frame times (rt/bridge-policy.ts).
import { type BridgeMeta, noteFrame, type WatchedBridge } from "./bridge-policy";

export function safeCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005 || code === 1006 || code === 1015) return 1000;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1001 && code <= 1014 && code !== 1004) return code;
  return 1000;
}

/** Headers the gateway must not see (§19.1). `authorization` carries CONTROL_TOKEN in M2: never forwarded. */
const DROP = new Set([
  "host",
  "forwarded",
  "x-real-ip",
  "x-openclaw-scopes",
  "authorization",
  "x-ochost-sid",
  "x-ochost-sid-exp",
]);
/** Owner session id the Worker sets on a proxied request (ingress/routes.ts); never reaches the gateway. */
export const SID_HEADER = "x-ochost-sid";
export const WS_MAX_MESSAGE = 32 * 1024 * 1024;

/** Request headers to send to the gateway. */
export function gatewayHeaders(src: Headers): Headers {
  const h = new Headers();
  for (const [k, v] of src) {
    if (DROP.has(k) || k.startsWith("x-forwarded-") || k.startsWith("cf-access-")) continue;
    h.set(k, v);
  }
  const ip = src.get("cf-connecting-ip");
  if (ip) h.set("x-forwarded-for", ip);
  h.set("x-forwarded-proto", "https");
  const host = src.get("host");
  if (host) h.set("x-forwarded-host", host);
  return h;
}

export type BridgeLog = (msg: string, data?: unknown) => void;

/** Open bridged WS pairs of one DO (sleep gate rule 2; close 1012 on stop/sleep). */
export class Bridges {
  private open = new Set<WatchedBridge>();
  get count() {
    return this.open.size;
  }
  add(x: WatchedBridge) {
    this.open.add(x);
    return () => this.open.delete(x);
  }
  list(): WatchedBridge[] {
    return [...this.open];
  }
  closeAll(code: number, reason: string) {
    for (const x of [...this.open]) x.close(code, reason);
    this.open.clear();
  }
  /** Close every bridge of one owner session (revoke, rotate, logout). */
  closeSession(sid: string, code: number, reason: string): number {
    let n = 0;
    for (const x of [...this.open])
      if (x.meta.sid === sid) {
        x.close(code, reason);
        n++;
      }
    return n;
  }
}

export interface BridgeOpts {
  sid?: string | null;
  now?: () => number;
  /** A user-intent client frame (activity for the idle timer, add §2.5 rule 3). */
  onIntent?: () => void;
}

/** Proxy one request to the gateway. A WebSocket upgrade becomes a bridged pair. */
export async function proxyToGateway(
  req: Request,
  port: Fetcher,
  bridges: Bridges,
  log: BridgeLog,
  o: BridgeOpts = {},
): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://container${url.pathname}${url.search}`;
  const headers = gatewayHeaders(req.headers);
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return port.fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
  }
  const up = await port.fetch(target, { headers });
  const upWs = up.webSocket;
  if (!upWs) {
    log("ws upstream refused", { status: up.status });
    return new Response(`gateway refused the WebSocket (${up.status})`, { status: 502 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  upWs.accept();
  let closed = false;
  const closeBoth = (code: number | undefined, reason: string, from: string) => {
    if (closed) return;
    closed = true;
    remove();
    const c = safeCloseCode(code);
    log("ws close", { from, code, sent: c });
    for (const ws of [server, upWs]) {
      try {
        ws.close(c, reason.slice(0, 120));
      } catch {
        // already closed
      }
    }
  };
  const now = o.now ?? Date.now;
  const t0 = now();
  const meta: BridgeMeta = { sid: o.sid ?? null, openedAt: t0, lastIntentAt: t0, lastChatAt: t0 };
  const remove = bridges.add({ meta, close: (code, reason) => closeBoth(code, reason, "do") });
  const size = (d: unknown) =>
    typeof d === "string" ? d.length : d instanceof ArrayBuffer ? d.byteLength : 0;
  const pipe = (from: WebSocket, to: WebSocket, name: string) => {
    from.addEventListener("message", (e) => {
      if (size(e.data) > WS_MAX_MESSAGE) return closeBoth(1009, "message too big", name);
      if (name === "client" && noteFrame(meta, e.data, now()) !== "poll") o.onIntent?.();
      try {
        to.send(e.data);
      } catch (err) {
        closeBoth(1011, `send failed: ${err instanceof Error ? err.message : String(err)}`, name);
      }
    });
    from.addEventListener("close", (e) => closeBoth(e.code, e.reason, name));
    from.addEventListener("error", () => closeBoth(1011, "error", name));
  };
  pipe(server, upWs, "client");
  pipe(upWs, server, "gateway");
  const proto = up.headers.get("sec-websocket-protocol");
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: proto ? { "sec-websocket-protocol": proto } : undefined,
  });
}

/** Answer for a proxied path while the Runtime is not `running` (§19.1). */
export function wakingResponse(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") return Response.json({ ok: false, status: "waking" }, { status: 503 });
  const ws = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  if (ws) return new Response("waking", { status: 503 });
  const html = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  return new Response(html ? "OpenClaw is waking up. Reload in a few seconds." : "waking", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
  });
}
