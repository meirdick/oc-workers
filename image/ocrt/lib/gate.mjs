// ControlGate client (contract §1-§5). No secret leaves before a good /v1/hello proof.
// deps.fetch is injectable for tests. A 409 {error:"stale"} calls onStale() once and throws StaleError.
import { createHmac, randomBytes } from "node:crypto";
import { BootRes, DOMAIN, HDR, HelloRes, PV, validate } from "./contract.mjs";

export class StaleError extends Error {
  constructor(route) {
    super(`stale at ${route}`);
    this.name = "StaleError";
  }
}
export class GateError extends Error {
  constructor(route, status, body) {
    super(`${route}: ${status ?? "network"} ${String(body ?? "").slice(0, 200)}`);
    this.name = "GateError";
    this.status = status ?? null;
  }
}

export const helloProof = (secret, challenge, domain = DOMAIN.hello) =>
  createHmac("sha256", secret).update(`${domain}${challenge}`).digest("hex");

/**
 * createGate({base, secret, iid, envelope: () => ({inst, epoch, gen, bootId}), fetch, onStale, pv})
 */
export function createGate(o) {
  const f = o.fetch || globalThis.fetch;
  const pv = o.pv ?? PV;
  let proven = false;
  let bound = false;
  let staleSeen = false;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function call(
    method,
    route,
    body,
    { timeoutMs = 5000, auth = true, raw = false, headers: extra } = {},
  ) {
    if (auth && !proven) throw new GateError(route, null, "gate not proven");
    const headers = {
      "content-type": raw ? "application/octet-stream" : "application/json",
      ...(extra || {}),
    };
    if (auth) headers[HDR.secret] = o.secret;
    if (auth && bound) headers[HDR.iid] = o.iid;
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (method !== "GET" && method !== "HEAD")
      init.body = raw
        ? body
        : JSON.stringify({ ...(auth && o.envelope ? o.envelope() : {}), ...(body || {}) });
    let r;
    try {
      r = await f(`${o.base}${route}`, init);
    } catch (e) {
      throw new GateError(route, null, e?.cause?.code || e?.name || String(e));
    }
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (r.status === 409 && json?.error === "stale") {
      if (!staleSeen) {
        staleSeen = true;
        o.onStale?.(route);
      }
      throw new StaleError(route);
    }
    if (r.status < 200 || r.status >= 300) throw new GateError(route, r.status, text);
    return json;
  }

  /** POST /v1/hello. Returns {ok, pvs} or {ok:false, why}. Sets `proven` on a good proof. */
  async function hello() {
    const challenge = randomBytes(32).toString("hex");
    let res;
    try {
      res = await call("POST", "/v1/hello", { challenge, pv }, { auth: false });
    } catch (e) {
      return { ok: false, why: e.message };
    }
    if (validate(HelloRes, res).length) return { ok: false, why: "bad hello shape" };
    if (res.proof !== helloProof(o.secret, challenge)) return { ok: false, why: "bad proof" };
    if (!res.pv.includes(pv)) return { ok: false, why: `pv ${pv} not in [${res.pv}]`, pvs: res.pv };
    proven = true;
    return { ok: true, pvs: res.pv };
  }

  /**
   * POST /v1/boot with the same iid until the gate answers (cap capMs, default 120 s; plan §6.2 step 1).
   * Returns {status:"ok", plan} | {status:"reboot-detected"} | {status:"unreachable", why} | {status:"stale"}.
   */
  async function boot(extra = {}, { capMs = 120_000, stop = () => false } = {}) {
    const end = Date.now() + capMs;
    let delay = 500;
    let last = "";
    while (Date.now() < end && !stop()) {
      if (!proven) {
        const h = await hello();
        if (!h.ok) {
          last = h.why;
          if (h.pvs) return { status: "unreachable", why: last };
          await sleep(delay);
          delay = Math.min(delay * 2, 5000);
          continue;
        }
      }
      try {
        const res = await call("POST", "/v1/boot", { iid: o.iid, pv, ...extra }, { timeoutMs: 10_000 });
        const errs = validate(BootRes, res);
        if (errs.length) return { status: "unreachable", why: `bad plan: ${errs.slice(0, 3).join("; ")}` };
        if (res.status === "ok") bound = true;
        return res;
      } catch (e) {
        if (e instanceof StaleError) return { status: "stale" };
        last = e.message;
        if (e.status === 400 || e.status === 401 || e.status === 403)
          return { status: "unreachable", why: last };
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
    return { status: "unreachable", why: last || "stopped" };
  }

  /** Authenticated GET with a streamed body (archive download). Returns the Response; the caller reads it. */
  async function fetchRaw(route, { timeoutMs = 300_000 } = {}) {
    if (!proven) throw new GateError(route, null, "gate not proven");
    const headers = { [HDR.secret]: o.secret };
    if (bound) headers[HDR.iid] = o.iid;
    try {
      return await f(`${o.base}${route}`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new GateError(route, null, e?.cause?.code || e?.name || String(e));
    }
  }

  return {
    hello,
    boot,
    fetchRaw,
    get proven() {
      return proven;
    },
    bindIid() {
      bound = true;
    },
    heartbeat: (b) => call("POST", "/v1/heartbeat", b, { timeoutMs: 5000 }),
    event: (kind, extra = {}, timeoutMs = 5000) =>
      call("POST", "/v1/event", { kind, ts: Date.now(), ...extra }, { timeoutMs }).catch((e) => ({
        error: e.message,
      })),
    alert: (cls, severity, detail = "") =>
      call("POST", "/v1/alert", {
        class: cls,
        severity,
        detail: String(detail).slice(0, 2000),
        ts: Date.now(),
      }).catch((e) => ({ error: e.message })),
    log: (lines) => call("POST", "/v1/log", { lines }, { timeoutMs: 5000 }),
    replicaState: () => call("GET", "/v1/replica/state", null, { timeoutMs: 5000 }),
    finalSnapshot: (unclean) =>
      call("POST", "/v1/final-snapshot", { kind: "final", unclean: unclean || null }, { timeoutMs: 120_000 }),
    call,
    /** Raw body PUT with extra headers (shadow upload: x-ocrt-sha256). */
    putRaw: (route, buf, headers, timeoutMs = 120_000) =>
      call("PUT", route, buf, { raw: true, headers, timeoutMs }),
  };
}
