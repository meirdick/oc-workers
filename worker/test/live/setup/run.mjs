// Setup for the M4 sleep drills: install running, owner chat paired (DM → pairing code at the fake →
// `openclaw pairing approve`), one agent reply, then one forced sleep. Assumes POST /ops/config was done.
import {
  ensureRunning,
  exec,
  forceSleep,
  GW,
  now,
  rawFile,
  repliesSince,
  result,
  sends,
  sleep,
  status,
  update,
  waitFor,
} from "../lib.mjs";

rawFile("setup");
const t0 = now();
const s0 = await ensureRunning();
const u = process.env.CODE ? { t0: now(), status: 0 } : await update("hello pairing");
const code = await waitFor(async () => {
  const m = (await sends(u.t0)).map((e) => String(e.d?.text ?? "")).join("\n");
  return /<code>([A-Z0-9]{8})/.exec(m)?.[1] ?? process.env.CODE ?? null;
}, 180_000);
let approve = null;
if (code.v) {
  approve = await exec(
    [
      "setpriv",
      "--reuid=1000",
      "--regid=1000",
      "--init-groups",
      "env",
      "HOME=/home/node",
      `OPENCLAW_GATEWAY_PASSWORD=${GW}`,
      "node",
      "/app/openclaw.mjs",
      "pairing",
      "approve",
      "telegram",
      code.v,
    ],
    90_000,
  );
}
await sleep(5000);
const u2 = await update("first turn");
const rep = await waitFor(async () => ((await repliesSince(u2.t0)).length ? true : null), 180_000);
const slept = await forceSleep();
const s1 = await status();
result("setup", {
  startState: s0.state,
  ack: [u.status, u2.status],
  code: code.v,
  approve: approve && { ok: approve.ok, out: String(approve.stdout ?? approve.error ?? "").slice(0, 200) },
  replyMs: rep.v ? rep.ms : null,
  sleepMs: slept,
  endState: s1.state,
  gen: s1.gen?.gen,
  elapsedMs: now() - t0,
  checks: { paired: !!approve?.ok, reply: !!rep.v, asleep: s1.state === "asleep" },
});
