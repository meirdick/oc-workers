// ocsupctl unix socket (contract §8). Root only, mode 0600. One JSON line in, one JSON line out.
import fs from "node:fs";
import net from "node:net";
import { CTL_OPS, CtlReq, validate } from "./contract.mjs";

export const MAX_REQ = 64 * 1024;

/**
 * Dispatch one request (pure apart from the handlers). handlers: {op: async (req) -> res}.
 * draining() -> bool: every mutating op and every sleep op gets {ok:false, error:"draining"}.
 */
export async function dispatch(req, { handlers, draining = () => false, allowTest = false }) {
  const errs = validate(CtlReq, req);
  if (errs.length)
    return {
      ok: false,
      error: req && CTL_OPS[req.op] === undefined ? "unknown-op" : "bad-request",
      detail: errs.slice(0, 3),
    };
  const spec = CTL_OPS[req.op];
  if (spec.test && !allowTest) return { ok: false, error: "unknown-op" };
  if ((spec.mutating || spec.sleep) && draining()) return { ok: false, error: "draining" };
  const h = handlers[req.op];
  if (!h) return { ok: false, error: "unknown-op" };
  try {
    return (await h(req)) ?? { ok: true };
  } catch (e) {
    return { ok: false, error: "failed", detail: String(e?.message || e).slice(0, 500) };
  }
}

/** Start the server. Returns {close()}. */
export function startCtlServer({ sock, handlers, draining, allowTest, log }) {
  try {
    fs.unlinkSync(sock);
  } catch {}
  const server = net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", async (d) => {
      buf += d;
      if (buf.length > MAX_REQ)
        return c.end(`${JSON.stringify({ ok: false, error: "bad-request", detail: "too big" })}\n`);
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = "";
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        return c.end(`${JSON.stringify({ ok: false, error: "bad-request", detail: "json" })}\n`);
      }
      const res = await dispatch(req, { handlers, draining, allowTest });
      log?.("ctl", { op: req.op, opId: req.opId ?? null, ok: res.ok, error: res.error ?? null });
      c.end(`${JSON.stringify(res)}\n`);
    });
    c.on("error", () => {});
  });
  const old = process.umask(0o177);
  server.listen(sock, () => {
    try {
      fs.chmodSync(sock, 0o600);
    } catch {}
  });
  process.umask(old);
  server.on("error", (e) => log?.("ctl-error", { err: String(e) }));
  return { close: () => server.close(), server };
}

/** Client: send one request, return the parsed answer. */
export function ctlRequest(sock, req, timeoutMs = 360_000) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = "";
    const t = setTimeout(() => {
      c.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    c.setEncoding("utf8");
    c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
    c.on("data", (d) => {
      buf += d;
    });
    c.on("end", () => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {
        reject(new Error(`bad answer: ${buf.slice(0, 200)}`));
      }
    });
    c.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
