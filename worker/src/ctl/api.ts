// The Control DO RPC surface as a plain class: ControlCore (this builder) + GateLedger (gates builder) on one
// store. do.ts forwards each DO method here; tests and the scenario world can use it directly.
// Shapes follow core/types.ts ControlForRuntime (Runtime DO) and gates/ledger.ts GATE_CALLS (gates).
import type {
  BeginBootArgs,
  BeginBootResult,
  ControlForRuntime,
  MarkerPendingArgs,
  RtState,
  Severity,
  SleepInputs,
  SleptArgs,
  SnapshotHandle,
  StartedArgs,
  WakeReason,
} from "../core/types";
import { dispatchGateCall, GateLedger } from "../gates/ledger";
import { cfgOf } from "./archives";
import { boundsGuard, storageLimits } from "./bounds";
import { ControlCore, type OpsReq, type OpsRes } from "./control";
import type { Ctx } from "./ctx";
import type { ImageRef } from "./epochs";
import { runGc } from "./gc";
import { genRow } from "./gens";
import { notePhase } from "./progress";
import { type SettingsView, settingsView } from "./settings";

export class ControlApi implements ControlForRuntime {
  readonly core: ControlCore;
  readonly ledger: GateLedger;

  constructor(readonly c: Ctx) {
    this.core = new ControlCore(c);
    this.ledger = new GateLedger(c.db.store, {
      inst: c.inst,
      now: c.now,
      budgetScale: c.timers.budgetScale,
      archive: () => cfgOf(c),
      sandbox: () => c.settings().sandbox === "on" || c.settings().sandbox === "all",
      storage: () => storageLimits(c),
      files: () => {
        const f = c.settings().files;
        return { cap: f.capGb * 1e9, objectMax: f.maxObjectMb * 1e6 };
      },
    });
    this.ledger.migrate();
    this.core.ledger = this.ledger;
  }

  // ---- ControlForRuntime ----
  async epochStatus(epoch: number): Promise<{ status: "active" | "retiring" | "retired" | "none" }> {
    const r = this.c.db.one<{ status: "active" | "retiring" | "retired" }>(
      "SELECT status FROM epochs WHERE n = ?",
      epoch,
    );
    return { status: r?.status ?? "none" };
  }
  beginBoot(a: BeginBootArgs): Promise<BeginBootResult> {
    return this.core.beginBoot(a);
  }
  async endBoot(a: { gen: number; opId: string; why: string }): Promise<void> {
    this.core.genEnded(a.gen);
    this.core.ring("gen", "end-boot", a);
  }
  async onStarted(a: StartedArgs): Promise<void> {
    await this.core.onStarted({
      gen: a.gen,
      doctorRan: a.doctorRan,
      startupzMs: a.startupzMs,
      aliveMs: a.aliveMs ?? undefined,
    });
  }
  async onSlept(a: SleptArgs): Promise<void> {
    this.core.wakeSlept(a);
  }
  async snapshotSaved(h: SnapshotHandle): Promise<void> {
    this.core.snapshotSaved(h);
  }
  async snapshotMiss(id: string): Promise<{ state: "suspect" | "bad" | "unknown" }> {
    const s = this.core.snapshotMiss(id);
    return { state: s === "suspect" || s === "bad" ? s : "unknown" };
  }
  async markerPending(a: MarkerPendingArgs): Promise<{ id: string; ok?: boolean; error?: string }> {
    const r = this.core.markerPending({
      opId: a.opId,
      gen: a.gen,
      epoch: a.epoch,
      digest: a.digest,
      txidPerDb: a.txid,
      bytesPerDb: a.bytes,
      lastWriteAtPerDb: a.lastWriteAt,
    });
    return { id: r.id ?? "", ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  }
  async markerValid(a: { id: string; snapshotId: string }): Promise<void> {
    const m = this.c.db.one<{ op_id: string }>("SELECT op_id FROM markers WHERE id = ?", a.id);
    if (m) this.core.markerValid(m.op_id, a.snapshotId);
  }
  async markerVoid(a: { id: string; reason: string }): Promise<void> {
    this.core.markerVoid({ id: a.id }, a.reason);
  }
  async markReplicated(a: { upTo: number }): Promise<{ count: number }> {
    return { count: this.core.markReplicated(a.upTo) };
  }
  async inboxPending(): Promise<number> {
    return this.core.inboxCounts().pending;
  }
  async settingsView(): Promise<SettingsView> {
    return settingsView(this.c);
  }
  async sleepInputs(): Promise<SleepInputs> {
    return this.core.sleepInputs();
  }
  async bootHealthy(a: { gen: number; since: number }): Promise<boolean> {
    const r2 = await this.core.r2HealthyDuring(a.since);
    return r2 && this.ledger.helloServed(a.gen);
  }
  async r2Probe(): Promise<{ ok: boolean; ms?: number; err?: string }> {
    return (await this.core.r2Probe(true)) ?? { ok: false, err: "no-probe" };
  }
  async reslot(a: { epoch: number; why: string }): Promise<{ ok: boolean; epoch?: number }> {
    this.core.ring("epoch", "reslot-request", a);
    const r = await this.core.reslot(a.epoch);
    return { ok: r.ok, ...(r.to ? { epoch: r.to } : {}) };
  }
  async alert(a: { class: string; severity: Severity; detail?: string }): Promise<void> {
    this.core.alert(a.class, a.severity, a.detail ?? "");
  }
  async ring(a: { src: string; kind: string; detail?: unknown }): Promise<void> {
    this.core.ring(a.src, a.kind, a.detail);
  }

  // ---- gates (ledger) ----
  gateCall(m: string, args: unknown[]): unknown {
    // Control-side calls a gate may make besides the ledger's (heartbeat fields of §23, ingress-ready).
    if (m === "noteHeartbeat")
      return this.core.noteHeartbeat(args[0] as Parameters<ControlCore["noteHeartbeat"]>[0]);
    if (m === "ingressReady") return this.core.ingressReady(args[0] as number);
    if (m === "noteOutbound") {
      const o = (args[0] ?? {}) as { chatId?: string | number | null; at?: number; method?: string };
      return this.core.noteOutbound(o.chatId ?? null, Number(o.at) || this.c.now(), String(o.method ?? ""));
    }
    const out = dispatchGateCall(this.ledger, m, args);
    // F11: each completed archive runs verify + archive GC on the next alarm tick (not only daily).
    if (m === "archiveFinish" && args[1] === true) this.c.db.setMeta("archiveGcDue", 1);
    if (m === "event") {
      const gen = args[0] as number;
      const body = args[1] as { kind: string; reason?: string | null; detail?: unknown };
      if (body?.kind) notePhase(this.c, gen, body.kind);
      if (body?.kind === "ingress-ready") this.core.ingressReady(gen);
      if (body?.kind === "seeded") this.c.db.delMeta(`seeding:${gen}`);
    }
    return out;
  }

  // ---- Worker, cron, Runtime extras (this builder) ----
  /** Daily gen GC on demand (§13.4); fails closed. */
  async gc(o: { dryRun?: boolean } = {}) {
    // An explicit call finishes the backlog (20 gens per run, at most 10 runs); the daily path continues by alarm.
    let r = await runGc(this.c, o);
    const deleted = [...r.deleted];
    for (let i = 0; i < 9 && r.ok && r.more && !o.dryRun; i++) {
      r = await runGc(this.c, o);
      deleted.push(...r.deleted);
    }
    return { ...r, deleted };
  }
  /** Cron ensure. sec F2: storage caps first (hourly, or at once above STORAGE.soft), so ensure keeps working. */
  ensure(img?: ImageRef) {
    boundsGuard(this.c);
    return this.core.ensure(img);
  }
  status() {
    return this.core.status();
  }
  ownerView() {
    return this.core.ownerView();
  }
  ownerPanel(o: { origin: string | null; fresh?: boolean }) {
    return this.core.ownerPanel(o);
  }
  ops(r: OpsReq): Promise<OpsRes> {
    return this.core.ops(r);
  }
  tick() {
    boundsGuard(this.c);
    return this.core.tick();
  }
  nextAlarmAt() {
    return this.core.nextAlarmAt();
  }
  progressSent(chat: string, msg: number | null) {
    this.core.progressSent(chat, msg);
  }
  inboxPut(p: Parameters<ControlCore["inboxPut"]>[0], fresh?: Parameters<ControlCore["inboxPut"]>[1]) {
    return this.core.inboxPut(p, fresh);
  }
  hookSeen(id: string, kind: string) {
    this.core.hookSeen(id, kind);
  }
  kickDriver() {
    return this.core.kickDriver();
  }
  flushAlerts() {
    return this.core.flushAlerts();
  }
  webhookPrevOk() {
    return this.core.webhookPrevOk();
  }
  noteRtState(epoch: number, state: RtState) {
    this.core.noteRtState(epoch, state);
  }
  noteHeartbeat(h: Parameters<ControlCore["noteHeartbeat"]>[0]) {
    this.core.noteHeartbeat(h);
  }
  ingressReady(gen: number) {
    this.core.ingressReady(gen);
  }
  noteDoctorRequired(epoch: number) {
    this.core.noteDoctorRequired(epoch);
  }
  genVerify(gen: number, ok: boolean) {
    this.core.genVerify(gen, ok);
  }
  async wakePlan(x: { nextWakeAtMs: number | null; lastWakeAt?: number | null }) {
    return this.core.wakePlan(x);
  }
  sleepWorthIt(nextWakeAtMs: number | null) {
    return this.core.sleepWorthIt(nextWakeAtMs);
  }
  costCheck() {
    return this.core.costCheck();
  }
  imagesInUse() {
    return this.core.imagesInUse();
  }
  pruneAllowed(tag: string, digest: string) {
    return this.core.pruneAllowed(tag, digest);
  }
  snapshotAllowed(kind: string) {
    return this.core.snapshotAllowed(kind);
  }
  currentGen(epoch: number) {
    return this.core.currentGen(epoch);
  }
  epochOf(gen: number): number | null {
    return genRow(this.c, gen)?.epoch ?? null;
  }
  wake(reason: WakeReason) {
    return this.core.ops({
      action: "wake",
      method: "POST",
      sub: [],
      query: {},
      body: { reason },
      role: "owner",
    });
  }
}
