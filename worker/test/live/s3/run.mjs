// M4 S3 (add §6): wake with R2 down → `*-blocked:infra`, L1 retries; the inbox keeps acking; replay after
// recovery; no row dead. Fault r2-down (Control DO bucket throws, ReplicaGate 503) while asleep.
import { readFileSync } from "node:fs";
import {
  fault,
  now,
  ops,
  rawFile,
  repliesSince,
  result,
  ring,
  sleep,
  status,
  toAsleep,
  update,
  waitFor,
  waitState,
} from "../lib.mjs";

rawFile("s3");
/** Pass rules. The plan path ends `restore-blocked:infra` in the Control DO (hwm write, spec 08 §8.2 step 4),
 * so no container starts: the class shows in gen/end-boot (why "infra"), not in an ocsup exit. Two queued DMs from
 * one chat may be answered in one merged turn, so "replayed" = both rows replicated and ≥ 1 reply. */
function checksOf(x) {
  const pendingMid = x.mid.inbox?.pending ?? 0;
  const replicatedDelta = (x.inbox.counts?.replicated ?? 0) - (x.before.inbox?.replicated ?? 0);
  return {
    acked: x.u1.status === 200 && x.u2.status === 200,
    infraClass:
      (x.exits.length > 0 || x.endBoots.length > 0) &&
      x.exits.every((e) => /:infra$/.test(e.reason ?? "")) &&
      x.endBoots.every((w) => w === "infra"),
    l1Only: x.ladderRows.length === 0 && (x.before.ladder?.level ?? 1) === 1,
    inboxHeldPending: pendingMid >= 1,
    runningAfterUp: !!x.run.v,
    replayed: replicatedDelta >= 2 && (x.inbox.counts?.pending ?? 0) === 0 && x.replies >= 1,
    notDuplicated: x.replies <= 2,
    noDead: (x.inbox.counts?.dead ?? x.after.inbox?.dead ?? 0) === 0,
  };
}
if (process.env.RECHECK) {
  // Re-evaluate a recorded result with the rules above (no live calls).
  const r = JSON.parse(readFileSync(new URL("./result.json", import.meta.url), "utf8"));
  const x = {
    u1: { status: r.acks[0] },
    u2: { status: r.acks[1] },
    exits: r.exits,
    endBoots: r.endBoots,
    ladderRows: r.ladderAlerts,
    before: r.beforeUp,
    run: { v: r.upToRunningMs !== null },
    replies: r.replies,
    inbox: { counts: r.inboxCounts },
    after: r.after,
    mid: r.midState,
  };
  const { drill: _d, at: _a, target: _t, pass: _p, checks: old, ...rest } = r;
  result("s3", { ...rest, recheckedAt: new Date().toISOString(), checksFirstRun: old, checks: checksOf(x) });
  process.exit(0);
}
const DOWN_MS = Number(process.env.DOWN_MS ?? 6 * 60_000);
await toAsleep();
const t0 = now();
const down = await fault("r2-down", { ms: DOWN_MS + 10 * 60_000 });
const u1 = await update("s3 u1 while r2 down");
// Let the wake fail and retry for DOWN_MS; one more update in the middle.
await sleep(DOWN_MS / 2);
const u2 = await update("s3 u2 while r2 down");
const mid = await status();
await sleep(DOWN_MS / 2);
const before = await status();
const evDown = await ring(t0);
const _up = await fault("r2-up");
const _tUp = now();
const run = await waitState("running", 900_000, 3000);
const _rep = await waitFor(async () => ((await repliesSince(u1.t0)).length >= 1 ? true : null), 300_000);
await sleep(15_000);
await sleep(10_000);
const after = await status();
const inbox = (await ops("GET", "/ops/inbox")).json ?? {};
const ev = await ring(t0);
const exits = evDown
  .filter((e) => e.src === "ocsup" && e.kind === "exit")
  .map((e) => ({
    at: e.at,
    gen: e.d?.gen,
    reason: e.d?.reason,
    detail: String(e.d?.detail ?? "").slice(0, 120),
  }));
const endBoots = evDown.filter((e) => e.src === "gen" && e.kind === "end-boot").map((e) => e.d?.why);
const ladderRows = ev.filter((e) => e.src === "alert" && /ladder/.test(e.kind)).map((e) => e.kind);
const replies = (await repliesSince(u1.t0)).length;
result("s3", {
  downMs: DOWN_MS,
  armed: down.json,
  acks: [u1.status, u2.status],
  ackMs: [u1.ackMs, u2.ackMs],
  midState: { state: mid.state, ladder: mid.ladder, inbox: mid.inbox },
  beforeUp: { state: before.state, ladder: before.ladder, inbox: before.inbox },
  exits,
  endBoots,
  ladderAlerts: ladderRows,
  upToRunningMs: run.ms,
  after: {
    state: after.state,
    gen: after.gen?.gen,
    plan: after.gen?.planKind,
    ladder: after.ladder,
    inbox: after.inbox,
  },
  inboxCounts: inbox.counts,
  replies,
  checks: checksOf({ u1, u2, exits, endBoots, ladderRows, before, run, replies, inbox, after, mid }),
});
