// Loopback forwarder to CapGate: 127.0.0.1:18791 -> 15.0.0.3:80 (docs/11 §7).
// OpenClaw 2026.10.9 refuses a firecrawl baseUrl that is a public IP ("must target a private or internal
// self-hosted endpoint"), and 15.0.0.3 is public to its address check; loopback passes (M7 live core, check 4).
// The plugin's web_fetch calls go to this port as uid 1000; ocsup (root) relays the bytes. The target is fixed,
// so this is no wider than the nft rule that already lets uid 1000 reach CapGate (netfilter.mjs). Plain TCP pipe:
// HTTP, keep-alive and upgrades pass unchanged.
import net from "node:net";

export const CAP_PROXY_PORT = 18791;
export const CAP_PROXY_URL = `http://127.0.0.1:${CAP_PROXY_PORT}`;
const CAP_TARGET = { host: "15.0.0.3", port: 80 };
/** A socket with no byte either way for this long is closed (an idle keep-alive, a hung peer). */
export const CAP_IDLE_MS = 120_000;

/** "host:port" (OCRT_CAP_TARGET, a test env) → {host, port}; unset or malformed → CapGate. */
export function capTarget(v) {
  const m = /^([0-9.]+|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(String(v ?? ""));
  return m ? { host: m[1], port: Number(m[2]) } : CAP_TARGET;
}

/** startCapProxy({target?, port?, host?, idleMs?, log?}) -> {close(), state, server}. state: {accepted, errors}. */
export function startCapProxy(o = {}) {
  const t = o.target || CAP_TARGET;
  const st = { accepted: 0, errors: 0 };
  const idleMs = o.idleMs ?? CAP_IDLE_MS;
  const server = net.createServer((c) => {
    st.accepted++;
    const up = net.connect({ host: t.host, port: t.port });
    for (const s of [c, up]) {
      s.setTimeout(idleMs, () => s.destroy());
      s.on("error", () => {
        st.errors++;
        c.destroy();
        up.destroy();
      });
      s.on("close", () => {
        c.destroy();
        up.destroy();
      });
    }
    c.pipe(up);
    up.pipe(c);
  });
  server.on("error", (e) => o.log?.("cap-proxy-error", { err: String(e) }));
  server.listen(o.port ?? CAP_PROXY_PORT, o.host || "127.0.0.1");
  return { close: () => server.close(), state: st, server };
}
