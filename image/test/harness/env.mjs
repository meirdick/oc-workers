// M1 local env, one per harness run (per-network lock). Run N gets docker network ocm1n<N>
// (15.N.0.0/24) and the name prefix ocm1n<N>- for every container, volume and snapshot tag, so runs
// can go in parallel. Addresses in run N (15.0.0.x on CF, 15.N.0.x here):
//   15.N.0.1   fake ControlGate (:80) + ReplicaGate backend (:8002) + harness control API (:9000)
//   15.N.0.2   ReplicaGate address (:80), a TCP relay to 15.N.0.1:8002
//   15.N.0.10  SeaweedFS 3.80 S3 (:8333), anonymous, behind the fake ReplicaGate only
//   15.N.0.20  fake Telegram Bot API (api.telegram.org, :443 TLS with the test CA, :80)
//   15.N.0.21  mock LLM (api.anthropic.com and api.openai.com, :443, :80)
// ocsup derives the owner-match nft set from OCRT_GATE_URL/OCRT_REPLICA_URL (lib/netfilter.mjs gateNets).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dk, dkOk, rm } from "./docker.mjs";

export const TEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const IMAGE_DIR = path.resolve(TEST_DIR, "..");
export const OCRT_DIR = path.join(IMAGE_DIR, "ocrt");
export const SIDECAR_IMG = "node:24-bookworm-slim";
export const S3_IMG = "chrislusf/seaweedfs:3.80";
/** Live bindings: set by useNet(n). Importers read the current value at call time. */
export let N = -1;
export let PFX = "ocm1n0";
export let NET = "ocm1n0";
export let SUBNET = "15.0.0.0/24";
export let CTL = "http://15.0.0.1:9000";
export const IP = {};
export const TLS_DIR = path.join(TEST_DIR, ".tls");
export const BOOT_SECRET = "m1-boot-secret-0123456789abcdef";
export const GW_TOKEN = "m1testtoken0123456789abcdef";
export const MAX_NET = 63;
/** A network with no container for this long is a crashed run's leftover (sidecars run all run long). */
export const STALE_NET_MS = 10 * 60_000;

/** Point the harness at run n: names, subnet, addresses. */
export function useNet(n) {
  N = n;
  PFX = `ocm1n${n}`;
  NET = PFX;
  SUBNET = `15.${n}.0.0/24`;
  Object.assign(IP, {
    gate: `15.${n}.0.1`,
    replica: `15.${n}.0.2`,
    s3: `15.${n}.0.10`,
    tg: `15.${n}.0.20`,
    llm: `15.${n}.0.21`,
  });
  CTL = `http://${IP.gate}:9000`;
}
useNet(0);

/**
 * Take a free run slot: create network ocm1n<N> on 15.N.0.0/24. Docker refuses a name that exists or a
 * subnet that overlaps (also the old shared `ocm1` network on 15.0.0.0/24), so the create is the lock
 * and it holds across sandboxes and hosts users. A leftover network (no container, older than
 * STALE_NET_MS) is removed and retried. `want` forces one N. Returns N; throws when none is free.
 */
export function acquireNet({ want = null, owner = `${os.hostname()}:${process.pid}` } = {}) {
  const ns = want === null ? [...Array(MAX_NET).keys()].map((i) => i + 1) : [Number(want)];
  for (const n of ns) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const name = `ocm1n${n}`;
      const r = dk([
        "network",
        "create",
        "--subnet",
        `15.${n}.0.0/24`,
        "--gateway",
        `15.${n}.0.254`,
        "--label",
        "oc-host.m1=harness",
        "--label",
        `oc-host.m1.owner=${owner}`,
        name,
      ]);
      if (r.code === 0) {
        useNet(n);
        return n;
      }
      if (attempt === 0 && /already exists/.test(r.err) && staleNet(name)) {
        envDown(n);
        continue;
      }
      break;
    }
  }
  throw new Error(`no free harness network (tried ${ns.length}); see docker network ls | grep ocm1n`);
}

function staleNet(name) {
  const r = dk(["network", "inspect", "-f", "{{.Created}}|{{len .Containers}}", name]);
  if (r.code !== 0) return false;
  const [created, n] = r.out.split("|");
  return Number(n) === 0 && Date.now() - Date.parse(created) > STALE_NET_MS;
}

const sh = (cmd) => spawnSync("sh", ["-c", cmd], { encoding: "utf8" });

/** Test CA + one leaf for the fake HTTPS hosts. Idempotent. */
export function ensureTls() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const ca = path.join(TLS_DIR, "ca.pem");
  if (fs.existsSync(ca) && fs.existsSync(path.join(TLS_DIR, "leaf.pem"))) return ca;
  const d = TLS_DIR;
  const r = sh(`set -e; cd '${d}'
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj '/CN=oc-host m1 test CA' 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj '/CN=m1-fakes' 2>/dev/null
printf 'subjectAltName=DNS:api.telegram.org,DNS:api.anthropic.com,DNS:api.openai.com,IP:15.0.0.20,IP:15.0.0.21\\nextendedKeyUsage=serverAuth\\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 30 -extfile leaf.ext 2>/dev/null
chmod 0644 ca.pem leaf.pem leaf.key`);
  if (r.status !== 0) throw new Error(`tls: ${r.stderr}`);
  return ca;
}

export function netUp() {
  if (dk(["network", "inspect", NET]).code === 0) return;
  throw new Error(`network ${NET} missing: call acquireNet() first`);
}

const sidecar = (name, ip, args, cmd) => {
  rm(name);
  dkOk([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    NET,
    "--ip",
    ip,
    "--label",
    "oc-host.m1=harness",
    ...args,
    ...cmd,
  ]);
};

/** Start all sidecars and wait for them. Returns when the control API answers. */
export async function envUp({ gateEnv = {} } = {}) {
  netUp();
  ensureTls();
  dk(["volume", "create", `${PFX}-gatelog`]);
  // SeaweedFS with no s3.config = anonymous access; only the fake ReplicaGate talks to it.
  sidecar(
    `${PFX}-s3`,
    IP.s3,
    [],
    [
      S3_IMG,
      "server",
      "-dir=/data",
      "-s3",
      "-s3.port=8333",
      "-master.volumeSizeLimitMB=64",
      "-volume.max=40",
    ],
  );
  const mounts = ["-v", `${TEST_DIR}:/t:ro`, "-v", `${OCRT_DIR}:/ocrt:ro`];
  const genv = Object.entries({
    OCM1_BOOT_SECRET: BOOT_SECRET,
    OCM1_S3: `http://${IP.s3}:8333`,
    ...gateEnv,
  }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  sidecar(
    `${PFX}-gate`,
    IP.gate,
    [...mounts, "-v", `${PFX}-gatelog:/log`, ...genv],
    [SIDECAR_IMG, "node", "/t/fakes/gate.mjs"],
  );
  sidecar(`${PFX}-replica`, IP.replica, mounts, [
    SIDECAR_IMG,
    "node",
    "/t/fakes/relay.mjs",
    "80",
    `${IP.gate}:8002`,
  ]);
  const xenv = ["-e", `OCM1_GATE_CTL=${CTL}`];
  sidecar(`${PFX}-tg`, IP.tg, [...mounts, ...xenv], [SIDECAR_IMG, "node", "/t/fakes/ext.mjs", "telegram"]);
  sidecar(`${PFX}-llm`, IP.llm, [...mounts, ...xenv], [SIDECAR_IMG, "node", "/t/fakes/ext.mjs", "llm"]);
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${CTL}/_ctl/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const j = await r.json();
        if (j.s3) return j;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("env: gate or s3 not ready in 120 s");
}

/** Remove run n's containers, volumes, snapshot tags (prefix ocm1n<n>-) and its network. */
export function envDown(n = N) {
  const pfx = `ocm1n${n}`;
  const names = dk(["ps", "-a", "--format", "{{.Names}}"])
    .out.split("\n")
    .filter((x) => x.startsWith(`${pfx}-`));
  if (names.length) rm(...names);
  const vols = dk(["volume", "ls", "--format", "{{.Name}}"])
    .out.split("\n")
    .filter((x) => x.startsWith(`${pfx}-`));
  if (vols.length) dk(["volume", "rm", ...vols]);
  const imgs = dk(["images", "--format", "{{.Repository}}:{{.Tag}}"])
    .out.split("\n")
    .filter((x) => x.startsWith(`${pfx}-snap:`));
  if (imgs.length) dk(["rmi", "-f", ...imgs]);
  dk(["network", "rm", pfx]);
}

// ---- harness control API client (fake gate :9000) ----
export async function ctl(route, body, { method } = {}) {
  const go = () =>
    fetch(`${CTL}${route}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  // One retry on a connection error (seen once: "fetch failed" right after a long docker commit).
  const r = await go().catch(async (e) => {
    await new Promise((res) => setTimeout(res, 1000));
    return go().catch((e2) => {
      throw new Error(`ctl ${route}: ${e2.message} (${e2.cause?.code || e.cause?.code || "?"})`);
    });
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ctl ${route}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
