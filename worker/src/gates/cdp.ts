// Browser binding helpers for CapGate (docs/11 §4, research part A row 1b). env.BROWSER is a Fetcher. The protocol
// is @cloudflare/puppeteer's: POST https://fake.host/v1/devtools/browser?keep_alive=<ms> → {sessionId}; then
// GET /v1/devtools/browser/<sessionId> with Upgrade: websocket → a CDP socket. content/markdown drive that socket
// with a minimal CDP client (flat sessions), so no puppeteer dependency lands in the Worker.
const FAKE = "https://fake.host";

export const KEEP_ALIVE_MS = 120_000;

export interface BrowserSession {
  id: string;
  ws: WebSocket;
}

/** Acquire a session and open its CDP socket. Throws with the binding's status and text on failure. */
export async function openBrowser(browser: Fetcher, keepAliveMs = KEEP_ALIVE_MS): Promise<BrowserSession> {
  const acq = await browser.fetch(`${FAKE}/v1/devtools/browser?keep_alive=${keepAliveMs}`, {
    method: "POST",
  });
  const text = await acq.text();
  if (acq.status !== 200) throw new Error(`browser acquire ${acq.status}: ${text.slice(0, 200)}`);
  const id = (JSON.parse(text) as { sessionId?: string }).sessionId;
  if (!id) throw new Error("browser acquire: no sessionId");
  const res = await browser.fetch(`${FAKE}/v1/devtools/browser/${id}`, { headers: { Upgrade: "websocket" } });
  const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`browser connect ${res.status}: no websocket`);
  ws.accept();
  return { id, ws };
}

/** Best effort: end the session so it stops billing before keep_alive runs out. */
export async function closeBrowser(browser: Fetcher, id: string): Promise<void> {
  await browser.fetch(`${FAKE}/v1/devtools/browser/${id}`, { method: "DELETE" }).then(
    (r) => r.body?.cancel(),
    () => undefined,
  );
}

type Waiter = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/** Minimal CDP client over one socket. */
export class Cdp {
  private n = 0;
  private pending = new Map<number, Waiter>();
  private events: { method: string; sessionId?: string; params: Record<string, unknown> }[] = [];
  private waiting: { method: string; resolve: () => void }[] = [];
  closed = false;

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e: MessageEvent) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (typeof m.id === "number") {
        const w = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (!w) return;
        if (m.error) w.reject(new Error(`cdp ${JSON.stringify(m.error).slice(0, 200)}`));
        else w.resolve((m.result as Record<string, unknown>) ?? {});
      } else if (typeof m.method === "string") {
        this.events.push({
          method: m.method,
          sessionId: m.sessionId as string | undefined,
          params: (m.params as Record<string, unknown>) ?? {},
        });
        for (const w of this.waiting.filter((x) => x.method === m.method)) w.resolve();
      }
    });
    const gone = () => {
      this.closed = true;
      for (const w of this.pending.values()) w.reject(new Error("cdp socket closed"));
      this.pending.clear();
      for (const w of this.waiting) w.resolve();
    };
    ws.addEventListener("close", gone);
    ws.addEventListener("error", gone);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error("cdp socket closed"));
    const id = ++this.n;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Resolves when an event `method` has arrived (also one that came before the call), or after timeoutMs. */
  waitEvent(method: string, timeoutMs: number): Promise<void> {
    if (this.events.some((e) => e.method === method) || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiting.push({
        method,
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
      });
    });
  }
}

/** In-page script: DOM → markdown (headings, links, lists, code, quotes, images). Returns {title, text}. */
export const MARKDOWN_JS = `(() => {
  const skip = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG","IFRAME","HEAD"]);
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
  const walk = (n, ctx) => {
    if (n.nodeType === 3) return ctx.pre ? n.nodeValue : n.nodeValue.replace(/\\s+/g, " ");
    if (n.nodeType !== 1 || skip.has(n.tagName.toUpperCase())) return "";
    const t = n.tagName.toLowerCase();
    const kids = (c) => Array.from(n.childNodes).map((k) => walk(k, c || ctx)).join("");
    if (/^h[1-6]$/.test(t)) return "\\n\\n" + "#".repeat(Number(t[1])) + " " + kids().trim() + "\\n\\n";
    if (t === "p" || t === "div" || t === "section" || t === "article" || t === "main") return "\\n\\n" + kids().trim() + "\\n\\n";
    if (t === "br") return "\\n";
    if (t === "hr") return "\\n\\n---\\n\\n";
    if (t === "a") { const h = n.getAttribute("href"); const x = kids().trim(); return h && x ? "[" + x + "](" + abs(h) + ")" : x; }
    if (t === "img") { const s = n.getAttribute("src"); return s ? "![" + (n.getAttribute("alt") || "") + "](" + abs(s) + ")" : ""; }
    if (t === "strong" || t === "b") return "**" + kids().trim() + "**";
    if (t === "em" || t === "i") return "*" + kids().trim() + "*";
    if (t === "pre") return "\\n\\n\`\`\`\\n" + n.textContent.replace(/\\n$/, "") + "\\n\`\`\`\\n\\n";
    if (t === "code") return ctx.pre ? kids() : "\`" + n.textContent + "\`";
    if (t === "blockquote") return "\\n\\n" + kids().trim().split("\\n").map((l) => "> " + l).join("\\n") + "\\n\\n";
    if (t === "ul" || t === "ol") {
      let i = 0;
      return "\\n\\n" + Array.from(n.children).filter((c) => c.tagName === "LI").map((c) => {
        i++; return (t === "ol" ? i + ". " : "- ") + walk(c, ctx).trim().replace(/\\n/g, "\\n  ");
      }).join("\\n") + "\\n\\n";
    }
    if (t === "li") return kids();
    if (t === "tr") return "\\n" + Array.from(n.children).map((c) => walk(c, ctx).trim().replace(/\\|/g, "/")).join(" | ");
    return kids();
  };
  const text = walk(document.body || document.documentElement, {}).replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  return JSON.stringify({ title: document.title, text, url: location.href });
})()`;

/**
 * Open `url` in a new tab, wait for load, evaluate `expression` (a string result) and return it.
 * The caller closes the socket and the session.
 */
export async function evalPage(
  cdp: Cdp,
  url: string,
  expression: string,
  o: { loadMs?: number; settleMs?: number } = {},
): Promise<string> {
  const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as {
    targetId: string;
  };
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
    sessionId: string;
  };
  await cdp.send("Page.enable", {}, sessionId);
  const nav = (await cdp.send("Page.navigate", { url }, sessionId, 30_000)) as { errorText?: string };
  if (nav.errorText) throw new Error(`navigate: ${nav.errorText}`);
  await cdp.waitEvent("Page.loadEventFired", o.loadMs ?? 25_000);
  if (o.settleMs) await new Promise((r) => setTimeout(r, o.settleMs));
  const r = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (r.exceptionDetails) throw new Error("page script failed");
  return String(r.result?.value ?? "");
}
