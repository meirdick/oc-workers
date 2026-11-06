// Fake fetch for the CLI tests: routes by "METHOD url-prefix", records every call.
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
export type Handler = (
  c: Call,
) =>
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | Promise<{ status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>;

export function fakeFetch(routes: [string, Handler][]) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const c: Call = { method, url, headers, body };
    calls.push(c);
    for (const [k, h] of routes) {
      const [m, prefix] = k.split(" ") as [string, string];
      if (m === method && url.startsWith(prefix)) {
        const r = await h(c);
        const text = r.text ?? JSON.stringify(r.json ?? {});
        return new Response(text, {
          status: r.status ?? 200,
          headers: { "content-type": "application/json", ...r.headers },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no route", url }), { status: 599 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const cf = (result: unknown, extra: Record<string, unknown> = {}) => ({
  json: { success: true, errors: [], result, ...extra },
});
export const cfErr = (code: number, status = 403) => ({
  status,
  json: { success: false, errors: [{ code, message: "err" }], result: null },
});

/** Fake /ops client with a config store like the Control DO. */
export function fakeOps(over: Record<string, (body: any) => { status: number; body: unknown }> = {}) {
  const versions: { ver: number; doc: any }[] = [];
  const calls: { method: string; path: string; body?: any }[] = [];
  const route = (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    const k = `${method} ${path.split("?")[0]}`;
    const o = over[k];
    if (o) return o(body);
    if (k === "GET /ops/config")
      return { status: 200, body: { versions: versions.map((v) => ({ ver: v.ver })) } };
    if (method === "GET" && path.startsWith("/ops/config/")) {
      const v = versions.find((x) => x.ver === Number(path.split("/").pop()));
      return v ? { status: 200, body: { ver: v.ver, doc: v.doc } } : { status: 404, body: {} };
    }
    if (k === "POST /ops/config") {
      const newest = versions.at(-1);
      if (body.baseVer !== undefined && newest && body.baseVer !== newest.ver)
        return { status: 409, body: { error: "base", ver: newest.ver } };
      const ver = (newest?.ver ?? 0) + 1;
      versions.push({ ver, doc: body.doc });
      return { status: 200, body: { ok: true, ver } };
    }
    return { status: 404, body: { error: "not found" } };
  };
  return {
    versions,
    calls,
    ops: {
      get: async (p: string) => route("GET", p),
      post: async (p: string, b?: unknown) => route("POST", p, b),
    },
  };
}

export const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklm"; // 51 chars, fake
