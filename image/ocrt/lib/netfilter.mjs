// Owner-match rule: only uid 0 reaches the gates at 15.0.0.0/30, except CapGate at 15.0.0.3 port 80 (any uid; docs/11)
// and SandboxGate at 15.0.0.4 port 80 (any uid; docs/12; outside the /30, listed so the rule stays explicit) (scope §1.1 row "ControlGate" [Z2.4];
// M0 T2 item 8: native nft `ip daddr 15.0.0.0/30 meta skuid != 0 drop` works on CF).
// uid-1000 Litestream reaches ReplicaGate through ocsup's replica proxy at 127.0.0.1:18790.
// Order and failure (review F-SEC-2): ocsup applies the rule right after cgroups, before any network
// use (gate boot, replica proxy). If nft fails, ocsup exits `netfilter-failed` (exit 70). No fallback.
import { spawnSync } from "node:child_process";
import { BIN } from "./bins.mjs";

export const GATE_NET = "15.0.0.0/30";
/** CapGate (D14): the one gate address any uid may reach; its budgets bound the spend. Accepted before the drop. */
export const CAP_GATE = "15.0.0.3";
/** SandboxGate (docs/12): the sandbox backend client runs as uid 1000 inside the gateway. */
export const SBX_GATE = "15.0.0.4";

/**
 * Destinations the rule covers: GATE_NET plus the IPv4 host of each gate URL outside it (a test env
 * may put the fakes on another /24, harness per-network runs). Non-IPv4 hosts are ignored.
 */
export function gateNets(urls = []) {
  const out = [GATE_NET];
  for (const u of urls) {
    let h = "";
    try {
      h = new URL(u).hostname;
    } catch {
      continue;
    }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m || m.slice(1).some((x) => Number(x) > 255)) continue;
    if (m[1] === "15" && m[2] === "0" && m[3] === "0" && Number(m[4]) < 4) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** nft script. Idempotent: the table is created, flushed and filled in one transaction. */
export function ruleset(net = GATE_NET) {
  const nets = Array.isArray(net) ? net : [net];
  const d = nets.length === 1 ? nets[0] : `{ ${nets.join(", ")} }`;
  return [
    "table inet ocrt {}",
    "flush table inet ocrt",
    "table inet ocrt {",
    "  chain out {",
    "    type filter hook output priority 0; policy accept;",
    // drop only: the CF microvm kernel (6.18.54-cloudflare-microvm) has no nft `reject` expression
    // ("Could not process rule: No such file or directory"), so a reject line failed the whole script
    // and every boot exited 70 netfilter-failed (M2 integration, oc-m2-int). A uid-1000 connect now
    // times out instead of getting a RST; the gate stays unreachable for non-root either way.
    `    ip daddr ${CAP_GATE} tcp dport 80 counter accept`,
    `    ip daddr ${SBX_GATE} tcp dport 80 counter accept`,
    `    ip daddr ${d} meta skuid != 0 counter drop`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Apply with `nft -f -`. Returns {ok, code, err, ms}. deps.spawnSync for tests. */
export function applyRules(o = {}) {
  const run = o.spawnSync || spawnSync;
  const t = Date.now();
  const r = run(o.nft || BIN.nft, ["-f", "-"], { input: ruleset(o.net), encoding: "utf8", timeout: 10_000 });
  return {
    ok: r.status === 0,
    code: r.status,
    err: (r.stderr || r.error?.code || "").toString().trim().slice(0, 300) || null,
    ms: Date.now() - t,
  };
}

/** Read back the table (for status and tests). */
export function listRules(o = {}) {
  const run = o.spawnSync || spawnSync;
  const r = run(o.nft || BIN.nft, ["list", "table", "inet", "ocrt"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout : null;
}
