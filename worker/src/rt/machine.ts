// Runtime DO state machine as data (spec 08 §5.2). Handlers look rows up by id; the coverage script
// (test/coverage-rows.mjs) lists every id. `next` "*" = decided by the action (several targets).
import type { RtState } from "../core/types";

export interface Row {
  id: number;
  state: RtState | "any" | "any-but-retired";
  event: string;
  guard: string;
  action: string;
  next: RtState | "*";
}

const r = (
  id: number,
  state: Row["state"],
  event: string,
  guard: string,
  action: string,
  next: Row["next"],
) => ({ id, state, event, guard, action, next }) as Row;

export const ROWS: readonly Row[] = Object.freeze([
  r(1, "new", "ensure|wake", "epoch active", "desired=running; start op user/wake:r", "starting"),
  r(2, "new", "rpc", "epoch retiring/retired", "none", "retired"),
  r(3, "starting", "op:start-ok", "/startupz started", "on-started steps", "running"),
  r(4, "starting", "op:capacity", "", "gen kept; nextStartAt = capacity backoff", "waiting-capacity"),
  r(5, "waiting-capacity", "tick", "now >= nextStartAt", "resume start op phase start", "starting"),
  r(6, "waiting-capacity", "retire|stop", "", "pre-empt op (aborted); gen abandoned", "*"),
  r(7, "starting", "op:snapshot-lost", "", "snapshot miss; replan in same op", "starting"),
  r(8, "starting", "op:already-running", "labels match", "adopt; continue at armed", "starting"),
  r(9, "starting", "op:already-running", "labels differ", "destroy(stale); failed start", "backoff"),
  r(
    10,
    "starting",
    "op:plan-blocked",
    "plan restore-blocked",
    "no start(); class = reason; alert",
    "backoff",
  ),
  r(11, "starting", "settle|budget|hb-gap", "", "record stop; ladder", "backoff"),
  r(12, "starting", "ev:sigterm", "", "persist drain.sigtermAt", "draining"),
  r(13, "backoff", "tick|ensure", "now >= nextStartAt, desired=running", "start op ladder", "starting"),
  r(
    14,
    "backoff",
    "tick|ensure",
    "now >= nextStartAt, desired=asleep",
    "start op wake:<pending>",
    "starting",
  ),
  r(15, "backoff", "wake", "", "set wakeRequested", "backoff"),
  r(16, "running", "tick", "epoch retiring/retired", "destroy(retired)", "retired"),
  r(17, "running", "tick", "hb age > hbLostMs", "class lost; destroy; unconfirmed wait", "backoff"),
  r(18, "running", "tick", "identity mismatch", "class stale; destroy(stale); L1", "backoff"),
  r(19, "running", "tick", "identity exec fails", "retry next tick", "running"),
  r(20, "running", "tick", "5 /healthz fails", "restart-gateway; exec fail → replace exit:70", "*"),
  r(21, "running", "tick", "running=false, no settle", "class from journal", "backoff"),
  r(22, "running", "settle", "", "record stop; ladder or class rule", "*"),
  r(23, "running", "ev:sigterm|hb draining", "", "persist drain.sigtermAt", "draining"),
  r(24, "running", "tick", "sleep gate holds", "journal op sleep", "quiescing"),
  r(25, "running", "tick", "maintenance due", "journal op maint", "maintenance"),
  r(26, "running", "stop", "", "planned stop op", "stopping"),
  r(27, "running", "wake", "", "clear wakeRequested; record activity", "running"),
  r(28, "running", "retire", "", "pre-empt; destroy(retired); settle", "retired"),
  r(29, "running", "ev:exit 77 + settle", "epoch active", "class fenced; L1", "backoff"),
  r(30, "maintenance", "op:maint-done", "", "sleep gate may follow", "running"),
  r(31, "maintenance", "settle", "", "as row 22", "backoff"),
  r(
    32,
    "draining",
    "tick",
    "running=false or settle",
    "class platform, confirmed; nextStartAt=now",
    "backoff",
  ),
  r(33, "draining", "tick", "now - sigtermAt > drainCapMs", "class lost; destroy; unconfirmed", "backoff"),
  r(34, "draining", "tick", "else", "nothing", "draining"),
  r(35, "draining", "constructor", "running=false", "record platform; nextStartAt=now", "backoff"),
  r(36, "draining", "settle", "open sleep op", "§10.5 platform SIGTERM", "*"),
  r(37, "quiescing", "op:sleep-done", "settled", "", "asleep"),
  r(38, "quiescing", "op:sleep-done", "destroy timeout", "", "asleep-unconfirmed"),
  r(39, "quiescing", "op:sleep-aborted", "", "resume-after-sleep done", "running"),
  r(40, "quiescing", "wake", "", "set wakeRequested only", "quiescing"),
  r(41, "quiescing", "ev:sigterm", "", "stop ocsupctl; op interrupted:sigterm", "draining"),
  r(42, "quiescing", "settle", "before phase destroy", "op fails; marker void; record stop", "backoff"),
  r(43, "asleep", "wake", "no start op queued", "start op wake:r", "starting"),
  r(44, "asleep", "tick", "now >= wakeAt", "start op, reason from due item", "starting"),
  r(45, "asleep", "ensure", "now >= wakeAt + 2 min", "start op wake:cron (lost alarm)", "starting"),
  r(46, "asleep", "ensure", "non-held pending inbox row", "start op wake:inbox", "starting"),
  r(47, "asleep", "ensure", "else", "re-arm alarm if missing", "asleep"),
  r(48, "asleep", "constructor", "running=true", "zombie: destroy(stale)", "asleep-unconfirmed"),
  r(49, "asleep-unconfirmed", "tick", "settled or running=false", "", "asleep"),
  r(
    50,
    "asleep-unconfirmed",
    "tick",
    "else",
    "monitor, getState, destroy again; zombie alert",
    "asleep-unconfirmed",
  ),
  r(51, "asleep-unconfirmed", "hb", "from that boot", "ack stop:true", "asleep-unconfirmed"),
  r(52, "asleep-unconfirmed", "wake", "", "flag; start after row 49 or lastHb + 200 s", "*"),
  r(53, "stopping", "op:stop-done", "settled", "", "stopped"),
  r(54, "stopping", "op:stop-done", "destroy timeout", "stop unconfirmed", "stopped"),
  r(
    55,
    "stopped",
    "start|tick|ensure|wake",
    "owner start, or open start op / desired=running",
    "desired=running; start op user",
    "starting",
  ),
  r(56, "stopped", "ensure|wake", "desired=stopped, no start op", "none", "stopped"),
  r(57, "any-but-retired", "retire", "", "pre-empt; destroy; settle", "retired"),
  r(58, "any", "constructor", "epoch retiring/retired and running", "destroy(retired)", "retired"),
]);

export function row(id: number): Row {
  const x = ROWS[id - 1];
  if (!x || x.id !== id) throw new Error(`no machine row ${id}`);
  return x;
}
