// Shared scenario steps. Each step drives the system only through platform fakes, the Worker
// routes, DO RPC names from core/types.ts, and the fake ocsup. State is read by spec names only.
import { expect } from "vitest";
import { TEXT } from "../harness/texts";
import { freshSut, type Sut, World, type WorldOpts } from "../harness/world";

export { TEXT };

export const sutP = (await import("../harness/world")).loadSut();

/** A world at state `new` (nothing called yet), on a fresh module graph (new isolate). */
export async function fresh(_sut: Sut, o: WorldOpts = {}) {
  return new World(await freshSut(), o);
}

/** Install + first start through the cron path; returns at `running`. */
export async function toRunning(w: World, ms = 30_000) {
  await w.cron();
  await w.until(() => w.state() === "running", ms);
}

/** To `starting` and hold there: the gateway never reports started. */
export async function toStarting(w: World) {
  const o = w.rt().ocsup;
  o.readyAfterMs = 10 * 60_000;
  await w.cron();
  await w.until(() => w.state() === "starting" && !!o.boot?.plan, 5_000);
}

/** To `backoff` with a wait: monitor() resolves with no op and no drain → unknown-platform,
 * unconfirmed, nextStartAt = lastHb + unconfirmedWaitMs (§9.1, §9.2). */
export async function toBackoff(w: World) {
  if (w.state() !== "running") await toRunning(w);
  w.rt().c.exitClean();
  await w.until(() => w.state() === "backoff", 5_000);
}

/** Test-only write of the Runtime `rec` (§4), for rows whose guard reads a persisted field. */
export function patchRec(w: World, patch: Record<string, unknown>, epoch?: number) {
  const h = w.rt(epoch);
  const rec = { ...(h.kv("rec") ?? {}), ...patch };
  h.storage.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('rec', ?)", JSON.stringify(rec));
}

/** Test-only write of a Control epoch status (§3 epochs). */
export function setEpochStatus(w: World, n: number, status: string) {
  w.ctl().storage.sql.exec("UPDATE epochs SET status = ? WHERE n = ?", status, n);
}

/** To `waiting-capacity`: every start() throws the capacity text. */
export async function toWaitingCapacity(w: World) {
  w.rt().c.startDefault = { throw: TEXT.capacity };
  await w.cron();
  await w.until(() => w.state() === "waiting-capacity", 5_000);
}

/** To `asleep` (world must have sleep on). */
export async function toAsleep(w: World, ms = 60_000) {
  if (w.state() !== "running") await toRunning(w);
  await w.until(() => w.state() === "asleep", ms);
}

/** To `quiescing` and hold there: sleep-prepare answers busy forever. */
export async function toQuiescing(w: World) {
  const o = w.rt().ocsup;
  const prev = o.script;
  o.script = (op, id, a) =>
    op === "sleep-prepare" ? { ok: true, status: "busy", retryAfterMs: 200 } : prev(op, id, a);
  if (w.state() !== "running") await toRunning(w);
  await w.until(() => w.state() === "quiescing", 60_000);
  return () => {
    o.script = prev;
  };
}

/** To `asleep-unconfirmed`: sleep whose phase-8 destroy hangs. */
export async function toAsleepUnconfirmed(w: World) {
  if (w.state() !== "running") await toRunning(w);
  w.rt().c.destroyHang = 1;
  await w.until(() => w.state() === "asleep-unconfirmed", 60_000);
}

/** To `draining`: platform SIGTERM seen by ocsup. */
export async function toDraining(w: World) {
  if (w.state() !== "running") await toRunning(w);
  await w.rt().ocsup.sigterm();
  await w.until(() => w.state() === "draining", 5_000);
}

/** To `stopping` and hold: stop-status never reaches quiesced. */
export async function toStopping(w: World) {
  if (w.state() !== "running") await toRunning(w);
  const o = w.rt().ocsup;
  o.script = (op) => (op === "stop-status" ? { ok: true, state: "quiescing" } : undefined);
  void w.rt().call("ownerStop");
  await w.until(() => w.state() === "stopping", 5_000);
}

export async function toStopped(w: World) {
  if (w.state() !== "running") await toRunning(w);
  await w.rt().call("ownerStop");
  await w.until(() => w.state() === "stopped", 30_000);
}

export async function toRetired(w: World) {
  if (w.state() !== "running") await toRunning(w);
  await w.rt().call("retire");
  await w.until(() => w.state() === "retired", 10_000);
}

/** To `maintenance` and hold: the maint op's R2 probe (HEAD) takes 30 s. */
export async function toMaintenance(w: World) {
  if (w.state() !== "running") await toRunning(w);
  w.r2.headDelayMs = 30_000;
  await w.until(() => w.state() === "maintenance", 120_000, 200);
}

export function lastStop(w: World) {
  return w.stops().at(-1);
}

export function startCount(w: World, epoch?: number) {
  return w.rt(epoch).c.count("start");
}

/** Gens issued for this epoch, newest last. */
export function gensOf(w: World, epoch = w.epoch()) {
  return w.gens().filter((g) => g.epoch === epoch);
}

export function expectState(w: World, s: string, epoch?: number) {
  expect(w.state(epoch), `rec.state on e${epoch ?? w.epoch()}`).toBe(s);
}

export function openOps(w: World, kind?: string) {
  return w.ops_().filter((o) => o.state === "open" && (!kind || o.kind === kind));
}

/** afterEach: with SCEN_DEBUG=1, print a world summary for a failed test, then dispose. */
export function done(w: World | undefined, ctx: { task: { result?: { state?: string }; name: string } }) {
  if (!w) return;
  if (process.env.SCEN_DEBUG && ctx.task.result?.state === "fail") {
    const o = w.rt().ocsup;
    const out = {
      test: ctx.task.name,
      t: Date.now() - Date.parse("2026-11-02T10:00:00Z"),
      state: w.state(),
      epochs: w.epochs().map((e) => [e.n, e.status]),
      gens: w.gens().map((g) => [g.gen, g.state, g.plan_kind, g.reason]),
      stops: w.stops().map((s) => [s.cls, s.confirmed, s.state_fault]),
      ops: w.ops_().map((x) => [x.kind, x.reason, x.phase, x.state]),
      ctl: o.ctl.map((c) => c.op).slice(-20),
      ring: w
        .ring()
        .slice(-25)
        .map((r) => `${r.src}/${r.kind} ${String(r.detail).slice(0, 120)}`),
      alerts: w.alerts().map((a) => [a.class, a.severity, a.count]),
      ladder: w.ladder(),
      ocsupErrors: o.errors.slice(0, 5),
      alarmErrors: w.alarmErrors.slice(0, 3),
      calls: w
        .rt()
        .c.calls.slice(-15)
        .map((c) => `${c.op}${c.detail === undefined ? "" : ` ${JSON.stringify(c.detail).slice(0, 60)}`}`),
    };
    console.log(JSON.stringify(out, null, 1));
  }
  w.dispose();
}

/** Owner settings override the Control DO reads per call (meta `settings`, ctl/ctx.ts mergeSettings). */
export function setSettings(w: World, patch: Record<string, unknown>) {
  w.ctl().storage.sql.exec(
    "INSERT OR REPLACE INTO meta (k, v) VALUES ('settings', ?)",
    JSON.stringify(patch),
  );
}

/** Time of the last heartbeat the Runtime DO stored (kv `hb`). */
export function lastHbAt(w: World): number {
  return (w.rt().kv<{ at: number }>("hb")?.at ?? 0) as number;
}
