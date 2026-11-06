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
/**
 * docs/11 §8: the same forwarder on a second port to ReplicaGate's files key space (f/<inst>/), for the bundled
 * ochost-storage plugin. uid 1000 cannot reach 15.0.0.2 (netfilter.mjs: only CapGate and SandboxGate); this port can,
 * which is no wider than the replica proxy at 127.0.0.1:18790 that uid-1000 Litestream already uses. The gate checks
 * the SigV4 key of the current gen on every request.
 */
export const FILES_PROXY_PORT = 18792;
export const FILES_PROXY_URL = `http://127.0.0.1:${FILES_PROXY_PORT}`;
export const FILES_TARGET = Object.freeze({ host: "15.0.0.2", port: 80 });
/** A socket with no byte either way for this long is closed (an idle keep-alive, a hung peer). */
export const CAP_IDLE_MS = 120_000;

/** "host:port" (OCRT_CAP_TARGET, OCRT_FILES_TARGET: test envs) → {host, port}; unset or malformed → `dflt`. */
export function capTarget(v, dflt = CAP_TARGET) {
  const m = /^([0-9.]+|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(String(v ?? ""));
  return m ? { host: m[1], port: Number(m[2]) } : dflt;
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
