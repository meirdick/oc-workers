// M4b L2 live check (M4-STATUS §7 L2): the checkpoint clock restarted at each boot, so a crash loop with lives
// under checkpointMs never checkpointed. Install with OC_TEST timers (checkpointMs CK, sleep off). Steps:
// wake → running; one dirty write; wait for the first checkpoint (clock from the boot). Then N cycles: running →
// dirty write → wait LIFE ms → SIGKILL. LIFE < CK, so the old rule (from /startupz) makes 0 checkpoints in the
// loop; the new rule (from plan rootfs.at = the checkpoint snapshot time) makes them while the loop runs.
// usage: node run.mjs   env: U, T, RAW, CK (ms, default 180000), LIFE (ms, default 90000), N (default 5)
import { mkdirSync } from "node:fs";
import {
  det,
  exec,
  iso,
  now,
  ops,
  RAW,
  raw,
  result,
  running,
  runningNewGen,
  sigkill,
  sleep,
  status,
  waitFor,
} from "../loss-lib.mjs";

mkdirSync(RAW, { recursive: true });
const CK = Number(process.env.CK ?? 180_000);
const LIFE = Number(process.env.LIFE ?? 90_000);
const N = Number(process.env.N ?? 5);
const events = async (t0) =>
  ((await ops("GET", "/ops/events?limit=500")).json?.events ?? []).filter((e) => e.at >= t0).reverse();
const ckpts = async (t0) =>
  (await events(t0))
    .filter((e) => e.src === "rt" && /^checkpoint/.test(e.kind))
    .map((e) => ({ at: iso(e.at), kind: e.kind, d: det(e) }));
const write = (tag) =>
  exec([
    "setpriv",
    "--reuid=1000",
    "--regid=1000",
    "--init-groups",
    "/bin/sh",
    "-c",
    `mkdir -p /home/node/.openclaw/workspace && echo ${tag} $(date +%s%N) >> /home/node/.openclaw/workspace/m4b-l2.md`,
  ]);

const t0 = now();
const w = await ops("POST", "/ops/wake?wait=1", {});
raw("m4b-l2", { step: "wake", status: w.status });
const up = await running(900_000);
raw("m4b-l2", { step: "running", ms: up.ms });
await write("boot1");
const first = await waitFor(
  async () => ((await ckpts(t0)).some((c) => c.kind === "checkpoint") ? true : null),
  CK + 240_000,
  5000,
);
raw("m4b-l2", { step: "first-checkpoint", ms: first.ms, timeout: !!first.timeout });
const loopT0 = now();
const cycles = [];
for (let i = 1; i <= N; i++) {
  const s = await status();
  const gen0 = s.gen?.gen ?? null;
  await write(`cycle${i}`);
  await sleep(LIFE);
  const k = await sigkill();
  const r = await runningNewGen(gen0, 900_000);
  const s2 = await status();
  const c = {
    i,
    gen0,
    gen: s2.gen?.gen ?? null,
    kill: iso(k.at),
    killOk: k.ok,
    runningMs: r.ms,
    boot: s2.boot ?? s2.plan ?? null,
  };
  cycles.push(c);
  raw("m4b-l2", { step: "cycle", ...c });
}
await sleep(LIFE);
const loop = await ckpts(loopT0);
const made = loop.filter((c) => c.kind === "checkpoint");
const fin = await status();
result("m4b-l2", {
  ck: CK,
  life: LIFE,
  n: N,
  firstCheckpointMs: first.ms,
  cycles,
  checkpointsInLoop: made,
  skipsOrFails: loop.filter((c) => c.kind !== "checkpoint"),
  final: { state: fin.state, gen: fin.gen?.gen ?? null },
  checks: {
    firstCheckpoint: !first.timeout,
    killsOk: cycles.every((c) => c.killOk),
    checkpointsDuringLoop: made.length >= 2,
  },
});
