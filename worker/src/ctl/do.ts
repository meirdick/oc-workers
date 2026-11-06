// Control Durable Object (`ctl:<inst>`). Thin wrapper: storage, env, alarm, RPC forwarding to ControlApi.

import { DurableObject } from "cloudflare:workers";
import { bucketName } from "../core/bucket";
import { timersFrom } from "../core/timers";
import { flatten, timerOverlay } from "../core/tunables";
import type { BucketLike, Env, RuntimeRpc } from "../core/types";
import { rtName } from "../core/types";
import { CODE_VERSION } from "../core/version";
import { type AiBinding, chat } from "../gates/ai";
import { accessOrigin } from "../ingress/gateway";
import { sbxName } from "../sbx/core";
import { platformSecrets } from "./adapters";
import { ControlApi } from "./api";
import { type Ctx, DEFAULT_SETTINGS, mergeSettings, normalizeSettings, ring, type Settings } from "./ctx";
import { type ArchiveBucket, type DrillArgs, type DrillReport, drillRestoreInto } from "./drill";
import { latestSettings, withoutTunables } from "./settings";
import type { RawBucket } from "./soak/lib";
import { resumeSoak } from "./soak/runner";
import { Db } from "./sql";
import { testTelegramFetch } from "./test-telegram";

type A = ControlApi;

/** sec F11: the longest one Control DO tick may hold the alarm chain. */
export const TICK_CAP_MS = 60_000;
/** sec F11: a watchdog alarm at most this far out, so the chain never ends after a bad tick. */
export const WATCHDOG_MS = 5 * 60_000;

export class Control extends DurableObject<Env> {
  readonly api: ControlApi;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = new Db(ctx.storage);
    // OC_SETTINGS keeps the deploy-owned fields (origin, bucket); its tunable keys only seed settings version 1.
    const envRaw = normalizeSettings(safeJson(env.OC_SETTINGS));
    const base = mergeSettings(DEFAULT_SETTINGS, withoutTunables(envRaw));
    // One bucket-name source for the plan and ReplicaGate (issue I-2).
    const bucket = bucketName(env);
    if (bucket) (base as { bucket?: string }).bucket = bucket;
    // Access on → the Control UI lives on the custom domain (gateway.publicOrigin in the boot plan).
    const ui = accessOrigin(env.ACCESS_DOMAIN);
    if (ui) base.uiOrigin = ui;
    // The newest settings version over the base, rebuilt only when the version changes.
    let cached: { key: string; s: Settings } | null = null;
    const settings = (): Settings => {
      const row = latestSettings(db);
      const legacy = db.meta("settings");
      const key = `${row?.ver ?? 0}|${row?.created_at ?? 0}|${legacy ?? ""}`;
      if (cached?.key !== key) {
        const doc = row ? safeJson(row.doc) : null;
        cached = { key, s: mergeSettings(mergeSettings(base, doc), safeJson(legacy ?? undefined)) };
      }
      return cached.s;
    };
    const timers0 = timersFrom(env);
    this.api = new ControlApi({
      db,
      inst: env.OC_INST,
      now: () => Date.now(),
      // Settings values over the base timers; read on each use so a new version applies at the next op.
      get timers() {
        const s = settings();
        return { ...timers0, ...timerOverlay(flatten(s), env.OC_TEST === "1").t };
      },
      settingsSeed: envRaw,
      bucket:
        env.OC_TEST === "1"
          ? faultBucket(env.BUCKET as unknown as BucketLike, () => r2Down(db))
          : (env.BUCKET as unknown as BucketLike),
      rt: (n) => env.RUNTIME.getByName(rtName(env.OC_INST, n)) as unknown as RuntimeRpc,
      settings,
      secrets: {
        webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
        webhookSecretPrev: env.TELEGRAM_WEBHOOK_SECRET_PREV,
        alertUrl: env.ALERT_URL,
        alertToken: env.ALERT_TOKEN,
        botToken: env.OC_SECRET_OC_TELEGRAM_BOT_TOKEN,
        // Seed only: a secret put later reaches this DO through freshSecrets (ctl/control.ts, M7 F1).
        platform: platformSecrets(env),
      },
      test: env.OC_TEST === "1",
      instance: env.OC_INSTANCE,
      codeVersion: CODE_VERSION,
      buildVersion: env.CF_VERSION?.id,
      fetch:
        env.OC_TEST === "1"
          ? testTelegramFetch(
              (i, o) => fetch(i, o),
              (src, kind, detail) => ring({ db, now: () => Date.now() } as unknown as Ctx, src, kind, detail),
            )
          : (i, o) => fetch(i, o),
      // M4 restore drill: a throw-away instance of this class (no container, own storage, deleted after).
      drill: (name) =>
        env.CONTROL.getByName(name) as unknown as { drillRestore(a: DrillArgs): Promise<DrillReport> },
    });
    if (env.OC_TEST === "1") {
      // SoakPlan (ctl/soak): fault route and raw R2 for the steps; a plan survives the `ctl-wipe` step through R2.
      this.api.core.faultHook = (b) => this.fault(b as Record<string, unknown>);
      this.api.core.rawBucket = env.BUCKET as unknown as RawBucket;
    }
    this.api.core.panelProbes = {
      // One chat call through the gate, as `ochost doctor` made it from the laptop; charged to today's neurons.
      hop: async (model) => {
        if (!env.AI) return { status: 404, ms: 0 };
        const t0 = Date.now();
        const r = await chat(
          { model, messages: [{ role: "user", content: "Reply with the word pong only." }], max_tokens: 256 },
          {
            ai: env.AI as unknown as AiBinding,
            gateway: env.OC_AI_GATEWAY,
            now: Date.now,
            charge: async (n) => this.api.ledger.capAdd("neurons", n),
          },
        ).catch(() => null);
        const ms = Date.now() - t0;
        if (!r) return { status: 0, ms };
        const j = (await r.json().catch(() => null)) as {
          choices?: { message?: { content?: string } }[];
          error?: { message?: string };
        } | null;
        if (r.status === 200 && j?.choices?.[0]?.message?.content) return { status: 200, ms };
        return {
          status: r.status === 200 ? 502 : r.status,
          ms,
          error: String(j?.error?.message ?? "").slice(0, 160),
        };
      },
      sandbox: async () =>
        env.SANDBOX
          ? await (
              env.SANDBOX.getByName(sbxName(env.OC_INST)) as unknown as {
                status(): Promise<Record<string, any>>;
              }
            ).status()
          : null,
      env: {
        access: env.ACCESS_AUD ? { domain: env.ACCESS_DOMAIN ?? null, team: env.ACCESS_TEAM ?? null } : null,
        gateway: env.OC_AI_GATEWAY ?? "",
      },
    };
    if (!this.isDrill())
      ctx.blockConcurrencyWhile(async () => {
        if (env.OC_TEST === "1")
          await resumeSoak(this.api.c, env.BUCKET as unknown as Parameters<typeof resumeSoak>[1]);
        await this.arm();
      });
  }

  /** A throw-away drill instance (`drill:<inst>:<ts>`): no alarm, no install, storage wiped after one call. */
  private isDrill(): boolean {
    const name = (this.ctx.id as { name?: string } | undefined)?.name;
    if (typeof name === "string") return name.startsWith("drill:");
    try {
      return this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k = 'drill'").toArray().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Drill RPC (on the throw-away instance): restore the archive into this DO's storage, check it, report, then
   * delete all storage and the alarm. The Control DO of the install records the result (ctl/archives.ts).
   */
  async drillRestore(a: DrillArgs): Promise<DrillReport> {
    const db = new Db(this.ctx.storage);
    try {
      db.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      db.setMeta("drill", 1);
      return await drillRestoreInto(db, this.env.BUCKET as unknown as ArchiveBucket, a);
    } finally {
      await this.ctx.storage.deleteAlarm().catch(() => undefined);
      await this.ctx.storage.deleteAll().catch(() => undefined);
    }
  }

  /** Set the alarm to the next due time (keeps an earlier one). */
  private async arm(): Promise<void> {
    if (this.isDrill()) return;
    const next = this.api.nextAlarmAt();
    if (next === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || next < cur) await this.ctx.storage.setAlarm(next);
  }

  /** After an RPC: re-arm and flush the alert sink without delaying the answer. */
  private after<T>(v: T): T {
    this.ctx.waitUntil(this.arm().then(() => this.api.flushAlerts().then(() => undefined)));
    return v;
  }
  private async afterP<T>(p: Promise<T>): Promise<T> {
    return this.after(await p);
  }

  /**
   * sec F11 (Control DO side): the alarm chain must survive a tick that throws or never settles (an RPC to a
   * hung Runtime DO has no timeout). A watchdog alarm is set before the tick; the tick is raced against
   * TICK_CAP_MS; the next alarm is set in `finally`. A tick still running from an earlier alarm is not started
   * again (no overlap), but the alarm is still re-armed.
   */
  private ticking: Promise<number | null> | null = null;

  override async alarm(): Promise<void> {
    if (this.isDrill()) {
      // A drill instance left behind (evicted mid-drill): never run install logic here.
      await this.ctx.storage.deleteAlarm().catch(() => undefined);
      await this.ctx.storage.deleteAll().catch(() => undefined);
      return;
    }
    const now = Date.now();
    let next: number | null = now + WATCHDOG_MS;
    try {
      await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
      if (this.ticking) {
        next = now + WATCHDOG_MS;
        return;
      }
      const t = this.api.tick().finally(() => {
        this.ticking = null;
      });
      this.ticking = t;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = await Promise.race([
        t,
        new Promise<"cap">((r) => {
          timer = setTimeout(() => r("cap"), TICK_CAP_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (capped === "cap") {
        this.api.core.ring("alarm", "tick-cap", { ms: TICK_CAP_MS });
        next = Date.now() + 1000;
      } else next = capped;
    } catch (e) {
      try {
        this.api.core.ring("alarm", "tick-error", String(e).slice(0, 300));
      } catch {
        // storage refused; the finally still re-arms
      }
      next = Date.now() + WATCHDOG_MS;
    } finally {
      const at = next === null ? now + WATCHDOG_MS : next;
      await this.ctx.storage.setAlarm(Math.min(at, now + WATCHDOG_MS)).catch(() => undefined);
    }
  }

  // ---- ControlForRuntime (Runtime DO) ----
  epochStatus(n: number) {
    return this.api.epochStatus(n);
  }
  beginBoot(a: Parameters<A["beginBoot"]>[0]) {
    return this.afterP(this.api.beginBoot(a));
  }
  endBoot(a: Parameters<A["endBoot"]>[0]) {
    return this.afterP(this.api.endBoot(a));
  }
  onStarted(a: Parameters<A["onStarted"]>[0]) {
    return this.afterP(this.api.onStarted(a)).then((x) => {
      this.ctx.waitUntil(this.api.kickDriver());
      return x;
    });
  }
  onSlept(a: Parameters<A["onSlept"]>[0]) {
    return this.afterP(this.api.onSlept(a));
  }
  snapshotSaved(h: Parameters<A["snapshotSaved"]>[0]) {
    return this.api.snapshotSaved(h);
  }
  snapshotMiss(id: string) {
    return this.api.snapshotMiss(id);
  }
  markerPending(a: Parameters<A["markerPending"]>[0]) {
    return this.api.markerPending(a);
  }
  markerValid(a: Parameters<A["markerValid"]>[0]) {
    return this.api.markerValid(a);
  }
  markerVoid(a: Parameters<A["markerVoid"]>[0]) {
    return this.api.markerVoid(a);
  }
  markReplicated(a: Parameters<A["markReplicated"]>[0]) {
    return this.api.markReplicated(a);
  }
  inboxPending() {
    return this.api.inboxPending();
  }
  sleepInputs() {
    return this.afterP(this.api.sleepInputs());
  }
  bootHealthy(a: Parameters<A["bootHealthy"]>[0]) {
    return this.api.bootHealthy(a);
  }
  r2Probe() {
    return this.api.r2Probe();
  }
  reslot(a: Parameters<A["reslot"]>[0]) {
    return this.afterP(this.api.reslot(a));
  }
  alert(a: Parameters<A["alert"]>[0]) {
    return this.afterP(this.api.alert(a));
  }
  ring(a: Parameters<A["ring"]>[0]) {
    return this.api.ring(a);
  }

  // ---- gates ----
  gateCall(m: string, args: unknown[]) {
    const out = this.api.gateCall(m, args);
    // M4 S3 fault: ReplicaGate answers 503 while R2 is "down" (test groups only).
    if (
      m === "replicaPre" &&
      this.env.OC_TEST === "1" &&
      out &&
      typeof out === "object" &&
      r2Down(this.dbt())
    )
      return this.after({ ...(out as object), r2Down: true });
    if (m === "replicaPre" && this.env.OC_TEST === "1" && out && typeof out === "object") {
      const slow = replicaSlow(this.dbt());
      if (slow) return this.after({ ...(out as object), slowMs: slow });
    }
    if (m === "event") this.ctx.waitUntil(this.api.kickDriver());
    return this.after(out);
  }

  // ---- Worker, cron, Runtime extras ----
  gc(o?: { dryRun?: boolean }) {
    return this.afterP(this.api.gc(o));
  }
  ensure(img?: Parameters<A["ensure"]>[0]) {
    return this.afterP(this.api.ensure(img));
  }
  status() {
    return this.api.status();
  }
  /** Owner status page at `/` (ingress/routes.ts). */
  ownerView() {
    return this.api.ownerView();
  }
  /** Owner panel facts, same JSON as GET /ops/doctor (ctl/panel.ts). */
  ownerPanel(o: { origin: string | null; fresh?: boolean }) {
    return this.api.ownerPanel(o);
  }
  ops(r: Parameters<A["ops"]>[0]) {
    if (r.action === "fault" && this.env.OC_TEST === "1") return this.fault(r.body);
    return this.afterP(this.api.ops(r));
  }

  private dbt(): Db {
    return new Db(this.ctx.storage);
  }

  /** M4 drill faults on the Control DO (OC_TEST only; ops.ts sends non-Runtime names here). */
  private async fault(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const name = String(body.name ?? "");
    const p = (body.params ?? {}) as Record<string, unknown>;
    const db = this.dbt();
    const now = Date.now();
    switch (name) {
      case "r2-down": {
        const until = now + (typeof p.ms === "number" ? p.ms : 10 * 60_000);
        db.setMeta("fault:r2DownUntil", until);
        await this.api.ring({ src: "fault", kind: "r2-down", detail: { until } });
        return { status: 200, body: { ok: true, until } };
      }
      case "r2-up":
        db.delMeta("fault:r2DownUntil");
        await this.api.ring({ src: "fault", kind: "r2-up", detail: { at: now } });
        return { status: 200, body: { ok: true } };
      case "replica-throttle": {
        // Soak: ReplicaGate delays each write by `delayMs` for `ms` (Litestream throttle).
        const until = now + (typeof p.ms === "number" ? p.ms : 5 * 60_000);
        const delayMs = Math.min(typeof p.delayMs === "number" ? p.delayMs : 3000, 20_000);
        db.setMeta("fault:replicaSlow", { until, delayMs });
        await this.api.ring({ src: "fault", kind: "replica-throttle", detail: { until, delayMs } });
        return { status: 200, body: { ok: true, until, delayMs } };
      }
      case "replica-unthrottle":
        db.delMeta("fault:replicaSlow");
        await this.api.ring({ src: "fault", kind: "replica-unthrottle", detail: { at: now } });
        return { status: 200, body: { ok: true } };
      case "ctl-reset": {
        // S5: the Control DO restarts (in-memory state lost; storage and alarm kept).
        await this.api.ring({ src: "fault", kind: "ctl-reset", detail: { at: now } });
        const alarm = await this.ctx.storage.getAlarm();
        setTimeout(() => this.ctx.abort("ctl-reset fault"), 100);
        return { status: 200, body: { ok: true, alarmBefore: alarm } };
      }
      case "ctl-wipe": {
        // Drill L: Control DO storage replaced. Every table and the alarm go; the DO restarts on the next call
        // (constructor: migrate + arm). R2 and the Runtime DOs are kept.
        const alarm = await this.ctx.storage.getAlarm();
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        setTimeout(() => this.ctx.abort("ctl-wipe fault"), 100);
        return { status: 200, body: { ok: true, wipedAt: now, alarmBefore: alarm } };
      }
      case "rows": {
        // Drill read: the newest snapshots, gens, markers, archives and wake log rows.
        const n = Math.min(Number(p.limit ?? 30) || 30, 500);
        const q = (sql: string) => db.all<Record<string, unknown>>(sql, n);
        return {
          status: 200,
          body: {
            snapshots: q(
              "SELECT id, size, kind, gen, parent_id, chain_base, digest, state, misses, created_at, last_restored_at FROM snapshots ORDER BY created_at DESC LIMIT ?",
            ),
            gens: q(
              "SELECT gen, reason, plan_kind, state, issued_at, complete_at, started_at, ended_at FROM gens ORDER BY gen DESC LIMIT ?",
            ),
            markers: q("SELECT * FROM markers ORDER BY created_at DESC LIMIT ?"),
            archives: q(
              "SELECT id, kind, state, size, gen, created_at FROM archives ORDER BY created_at DESC LIMIT ?",
            ),
            wakeLog: q("SELECT * FROM wake_log ORDER BY id DESC LIMIT ?"),
            meta: { lastRebaseAt: db.meta("lastRebaseAt"), r2DownUntil: db.meta("fault:r2DownUntil") },
          },
        };
      }
      case "ctl-alarm":
        return { status: 200, body: { alarm: await this.ctx.storage.getAlarm(), now } };
      case "r2-usage": {
        // S4: bytes per top-level prefix in the bucket (real binding, no fault wrapper).
        const by: Record<string, { n: number; bytes: number }> = {};
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const r = await this.env.BUCKET.list({ cursor, limit: 1000 });
          for (const o of r.objects) {
            const k = o.key.split("/")[0] ?? "";
            by[k] ??= { n: 0, bytes: 0 };
            by[k].n++;
            by[k].bytes += o.size;
          }
          if (!r.truncated) break;
          cursor = r.cursor;
        }
        const total = Object.values(by).reduce((a, b) => a + b.bytes, 0);
        return { status: 200, body: { ok: true, total, by } };
      }
      default:
        return { status: 404, body: { error: `unknown fault ${name}` } };
    }
  }
  inboxPut(p: Parameters<A["inboxPut"]>[0], fresh?: Parameters<A["inboxPut"]>[1]) {
    return this.after(this.api.inboxPut(p, fresh));
  }
  progressSent(chat: string, msg: number | null) {
    this.api.progressSent(chat, msg);
    return this.after(undefined);
  }
  hookSeen(id: string, kind: string) {
    return this.after(this.api.hookSeen(id, kind));
  }
  webhookPrevOk() {
    return this.api.webhookPrevOk();
  }
  noteRtState(epoch: number, state: Parameters<A["noteRtState"]>[1]) {
    this.api.noteRtState(epoch, state);
    return this.after(undefined);
  }
  noteHeartbeat(h: Parameters<A["noteHeartbeat"]>[0]) {
    this.api.noteHeartbeat(h);
  }
  ingressReady(gen: number) {
    this.api.ingressReady(gen);
    this.ctx.waitUntil(this.api.kickDriver());
  }
  noteDoctorRequired(epoch: number) {
    this.api.noteDoctorRequired(epoch);
  }
  genVerify(gen: number, ok: boolean) {
    this.api.genVerify(gen, ok);
  }
  wakePlan(x: Parameters<A["wakePlan"]>[0]) {
    return this.api.wakePlan(x);
  }
  sleepWorthIt(nextWakeAtMs: number | null) {
    return this.api.sleepWorthIt(nextWakeAtMs);
  }
  settingsView() {
    return this.api.settingsView();
  }
  costCheck() {
    return this.after(this.api.costCheck());
  }
  imagesInUse() {
    return this.api.imagesInUse();
  }
  pruneAllowed(tag: string, digest: string) {
    return this.api.pruneAllowed(tag, digest);
  }
  snapshotAllowed(kind: string) {
    return this.api.snapshotAllowed(kind);
  }
}

function safeJson(s: string | undefined): unknown {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** M4 S3: the R2 fault flag in Control DO meta. */
function r2Down(db: Db): boolean {
  try {
    return Number(db.meta("fault:r2DownUntil") ?? 0) > Date.now();
  } catch {
    return false;
  }
}

/** Soak test fault: ReplicaGate write delay in ms while the throttle flag is set, else 0. */
function replicaSlow(db: Db): number {
  try {
    const v = db.metaJson<{ until: number; delayMs: number } | null>("fault:replicaSlow", null);
    return v && v.until > Date.now() ? v.delayMs : 0;
  } catch {
    return 0;
  }
}

/** Bucket that throws while the R2 fault flag is set (test groups only). */
function faultBucket(b: BucketLike, down: () => boolean): BucketLike {
  const chk = () => {
    if (down()) throw new Error("R2 fault: r2-down (test)");
  };
  return {
    head: async (k) => {
      chk();
      return b.head(k);
    },
    get: async (k) => {
      chk();
      return b.get(k);
    },
    put: async (k, v) => {
      chk();
      return b.put(k, v);
    },
    delete: async (k) => {
      chk();
      return b.delete(k);
    },
    list: async (o) => {
      chk();
      return b.list(o);
    },
  };
}
