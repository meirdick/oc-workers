// Replica proxy (plan §3.1 row "Replica proxy"): Litestream's S3 endpoint at 127.0.0.1:18790.
// Forwards a request to ReplicaGate only while a hello proof is < 5 s old; proves again first when
// older. A failed proof -> 503, no byte forwarded, state `replica-unproven`. Headers pass unchanged
// (Host included), so the gate checks the SigV4 signature Litestream made for 127.0.0.1:18790.
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import { DOMAIN, REPLICA_HELLO_PATH, REPLICA_PROOF_MAX_AGE_MS } from "./contract.mjs";

export const PROXY_PORT = 18790;
export const UPSTREAM_IDLE_MS = 60_000;

/** Prove ReplicaGate. Returns {ok, why?}. */
export async function proveReplica(base, secret, fetchFn = fetch) {
  const challenge = randomBytes(32).toString("hex");
  try {
    const r = await fetchFn(`${base}${REPLICA_HELLO_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => null);
    const want = createHmac("sha256", secret).update(`${DOMAIN.replicaHello}${challenge}`).digest("hex");
    if (r.status !== 200 || j?.proof !== want)
      return { ok: false, why: `status ${r.status} proof ${j?.proof ? "bad" : "none"}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e?.cause?.code || e?.name || String(e) };
  }
}

/**
 * startReplicaProxy({target: "http://15.0.0.2", secret, port, host, now, log, onUnproven, fetch})
 * -> {close(), state}. state: {provenAt, proofs, failures, forwarded, refused, lastWhy}
 */
export function startReplicaProxy(o) {
  const now = o.now || Date.now;
  const t = new URL(o.target);
  const st = { provenAt: 0, proofs: 0, failures: 0, forwarded: 0, refused: 0, lastWhy: null };
  let proving = null;
  async function ensureProof() {
    if (now() - st.provenAt < REPLICA_PROOF_MAX_AGE_MS) return true;
    if (!proving)
      proving = proveReplica(o.target, o.secret, o.fetch).then((r) => {
        proving = null;
        if (r.ok) {
          st.provenAt = now();
          st.proofs++;
          st.lastWhy = null;
        } else {
          st.failures++;
          st.lastWhy = r.why;
          o.onUnproven?.(r.why);
        }
        return r.ok;
      });
    return proving;
  }
  const server = http.createServer(async (req, res) => {
    req.pause();
    const ok = await ensureProof();
    if (!ok) {
      st.refused++;
      req.resume();
      res.writeHead(503, { "content-type": "application/xml" });
      return res.end("<Error><Code>ServiceUnavailable</Code><Message>replica-unproven</Message></Error>");
    }
    const up = http.request(
      {
        host: t.hostname,
        port: t.port || 80,
        method: req.method,
        path: req.url,
        headers: req.headers,
        setHost: false,
      },
      (ur) => {
        res.writeHead(ur.statusCode || 502, ur.headers);
        ur.pipe(res);
      },
    );
    // F1: a gate request that stops answering must not hang Litestream (restore had no bound): idle 60 s →
    // 504, Litestream sees an error and the restore step fails inside its budget.
    up.setTimeout(o.upstreamIdleMs ?? UPSTREAM_IDLE_MS, () =>
      up.destroy(Object.assign(new Error("upstream idle"), { code: "ETIMEDOUT" })),
    );
    up.on("error", (e) => {
      if (!res.headersSent)
        res.writeHead(e?.code === "ETIMEDOUT" ? 504 : 502, { "content-type": "application/xml" });
      res.end(`<Error><Code>BadGateway</Code><Message>${String(e.code || e)}</Message></Error>`);
    });
    st.forwarded++;
    req.pipe(up);
    req.resume();
  });
  server.keepAliveTimeout = 30_000;
  server.listen(o.port ?? PROXY_PORT, o.host || "127.0.0.1");
  server.on("error", (e) => o.log?.("replica-proxy-error", { err: String(e) }));
  return { close: () => server.close(), state: st, server };
}
