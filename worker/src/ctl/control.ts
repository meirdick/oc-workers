// Control DO core (`ctl:<inst>`, spec §3, §6, §11.3, §11.5). No container. The Durable Object class in do.ts
// wraps this class; everything here runs on node:sqlite in vitest.

import type { Severity } from "../core/contract";
import { filesPrefix } from "../core/contract";
import type {
  BeginBootArgs,
  BeginBootResult,
  OwnerView,
  RtState,
  RtStatusLite,
  SnapshotHandle,
  WakeReason,
} from "../core/types";
import type { GateLedger } from "../gates/ledger";
import { filesProbe } from "../gates/replica";
import { ADAPTERS, adapterByRoute } from "./adapters";
import { opsChannels } from "./adopt";
import {
  alert,
  alertAck,
  alertTest,
  dailyHeartbeat,
  deadmanCheck,
  flushAlerts,
  listAlerts,
  outboxSize,
  resolveAlert,
  setAlertSink,
  sinkInfo,
} from "./alerts";
import {
  archiveCanRun,
  archiveDirty,
  archiveFreshForRestart,
  archiveSleepBlockers,
  archiveStallAt,
  archiveStallCheck,
  archiveStatus,
  drillDue,
  ensurePreBootArchive,
  planArchiveGc,
  requestArchive,
  runArchiveGc,
  runDrill,
  verifyNewest,
} from "./archives";
import { markPruned, prunePlan, rebaseAtSleep, snapshotSummary } from "./chain";
import { configList, configMarkBad, configPropose, getConfig } from "./config";
import { credHistory, credManifest, credRestore } from "./creds";
import { copyConfigIfDue, copyCredsIfDue, restoreCredsFromCopy } from "./creds-copy";
import { type Ctx, DAY, ring, STATE_DB, utcDay } from "./ctx";
import { digestGuard } from "./digest";
import { type DiskHb, diskDegraded, lastDisk, noteDisk } from "./disk";
import {
  driverBootStarted,
  driverDueAt,
  driverIngressReady,
  driverResume,
  driverRetryNow,
  driverState,
  driverStop,
  pump,
} from "./driver";
import {
  activeEpoch,
  epochRow,
  type ImageRef,
  install,
  openEpochOps,
  pointer,
  runEpochOp,
  startEpochOp,
} from "./epochs";
import { planGc, runGc } from "./gc";
import {
  beginBoot,
  currentGen,
  genEnded,
  genRow,
  genVerify,
  hwmCheck,
  installedKey,
  onStarted,
  pinGen,
  pitrGen,
  secretHash,
} from "./gens";
import { importSleepBlockers, opsImport } from "./imports";
import {
  blocksSleep,
  chatSummary,
  counts,
  dropInbox,
  expireInbox,
  inboxPut,
  inboxRows,
  markReplicated,
  nextWakeRetryAt,
  noReplyCheck,
  noteOutbound,
  type PutIn,
  parseTelegram,
  putWakeAllow,
  quietToHeld,
  REPLY_METHODS,
  routeOfChannel,
} from "./inbox";
import { finishOp, getOp, openOp, openOps, pruneOps } from "./journal";
import { autoApproveOwner, listSnapshots, opsPairing, type PairingDeps, telegramInternal } from "./owner-ops";
import { ownerPanel, type Panel, type PanelDeps } from "./panel";
import { adoptView } from "./panel-adopt";
import {
  notePhase,
  progressDueAt,
  progressNoteOutbound,
  progressSent,
  progressStart,
  progressTick,
} from "./progress";
import { rebuildIndex } from "./rebuild";
import { latestTier } from "./records";
import { leadMs, sleepWorthIt, wakePlan } from "./schedule";
import { migrate } from "./schema";
import { putSettings, seedSettings, viewSettings } from "./settings";
import {
  chainLength,
  expireSnapshots,
  getSnapshot,
  imagesInUse,
  type MarkerInput,
  markerPending,
  markerValid,
  markerVoid,
  pruneAllowed,
  snapshotAbandon,
  snapshotAllowed,
  snapshotMiss,
  snapshotSaved,
} from "./snapshots";
import type { FaultRes, RawBucket, SoakPort } from "./soak/lib";
import { update as soakUpdate } from "./soak/lib";
import { dumpToR2, opsSoak, soakNextAt, soakTick } from "./soak/runner";
import { ensureSoak, noteSoakSend } from "./soak/store";
import { pj } from "./sql";
import { coldReplyChat, typingDueAt, typingTick, typingTrack } from "./typing";
import { costCheck, meter, pruneWakeLog, wakeCpu, wakeSlept } from "./wakelog";

const AWAKE_FOR_PROBE: RtState[] = [
  "starting",
  "running",
  "maintenance",
  "draining",
  "quiescing",
  "stopping",
];
const RUNNING: RtState[] = ["starting", "running", "maintenance"];
const DAILY_HOUR_UTC = 3;
/** `ochost restart` after a deploy waits this long for the pre-restart archive (N8). */
export const RESTART_ARCHIVE_WAIT_MS = 300_000;
/** A pre-restart archive request with no progress for this long is dead (an upload cut by the Worker swap, 1.1.0 live). */
export const RESTART_ARCHIVE_STALL_MS = 90_000;
/** N7: the restore probe's own cap (ocsup verify-gen); the RPC gets 10 s more. Under the 60 s tick cap. */
export const GEN_VERIFY_MS = 40_000;

export type OpsRole = "owner" | "ci";
export interface OpsReq {
  action: string;
  method: string;
  sub: string[];
  query: Record<string, string>;
  body: Record<string, unknown>;
  role: OpsRole;
  /** W11: the sink from the calling Worker isolate's env (newest secrets); absent in older callers and tests. */
  sink?: { url: string | null; token: string | null };
  /** M7 F1: adapter secrets from the calling Worker isolate's env (newest values); see freshSecrets. */
  fresh?: FreshSecrets;
}

/**
 * M7 F1: the Control DO reads its env once, when it is built. A secret-only version (`wrangler secret put` from
 * `channels add`) does not restart it, so the replay driver kept an empty OC_SLACK_SIGNING_SECRET until the next
 * code deploy. The Worker isolate of the new version has the new values: every /ops call and every hook call hands
 * them over. Only set values are taken: an older isolate still serving does not clear a newer value.
 */
export interface FreshSecrets {
  platform?: Record<string, string | undefined>;
  botToken?: string;
  /** The calling Worker isolate's version id (CF_VERSION). Newer than this DO's own → a deploy happened (N8, F1). */
  version?: string;
}
export interface OpsRes {
  status: number;
  body: unknown;
}

export class ControlCore {
  private hwmChecked = false;
  private pumping: Promise<unknown> | null = null;
  private rebuilding: Promise<unknown> | null = null;
  /** Set by ControlApi (gates ledger on the same store): archive verify marks. */
  ledger: GateLedger | null = null;

  constructor(readonly c: Ctx) {
    migrate(c.db);
    seedSettings(c.db, c.settingsSeed, c.now());
  }

  // ---------------------------------------------------------------- epochs

  install(img: ImageRef) {
    return install(this.c, img);
  }
  activeEpoch() {
    return activeEpoch(this.c);
  }
  epochStatus(n: number): { status: string; active: number | null } {
    return { status: epochRow(this.c, n)?.status ?? "retired", active: activeEpoch(this.c)?.n ?? null };
  }
  /** Stuck-slot escape (§9.4), called by the Runtime DO of epoch n. */
  async reslot(n: number): Promise<{ ok: boolean; error?: string; to?: number }> {
    const r = startEpochOp(this.c, `reslot-e${n}`, { from: n, reason: "reslot" });
    if ("error" in r) return { ok: false, error: r.error };
    this.c.db.run("UPDATE epochs SET hung_count = hung_count + 1 WHERE n = ?", n);
    const out = await runEpochOp(this.c, r.op.opId);
    return { ok: true, to: out.state === "done" ? (pointer(this.c) ?? undefined) : undefined };
  }
  /** /ops/epoch/roll: retire + flip with the current image map (code roll). */
  async roll(img?: ImageRef): Promise<{ ok: boolean; error?: string; state?: string }> {
    const ep = activeEpoch(this.c);
    if (!ep) return { ok: false, error: "no-active-epoch" };
    const r = startEpochOp(this.c, `roll-e${ep.n}`, { from: ep.n, reason: "code-roll", image: img });
    if ("error" in r) return { ok: false, error: r.error };
    const out = await runEpochOp(this.c, r.op.opId);
    return { ok: true, state: out.state };
  }

  // ---------------------------------------------------------------- gens and fence

  beginBoot(a: BeginBootArgs): Promise<BeginBootResult> {
    return beginBoot(this.c, a);
  }
  currentGen(epoch: number) {
    return currentGen(this.c, epoch);
  }
  /** `/startupz` started (§8.6). Also starts the replay driver in not-ready mode (§12.3). */
  async onStarted(s: { gen: number; doctorRan?: boolean; startupzMs?: number; aliveMs?: number }) {
    const r = await onStarted(this.c, s);
    const g = genRow(this.c, s.gen);
    if (r.ok && g) {
      driverBootStarted(this.c, s.gen, g.epoch, r.markerUsed);
      this.noteRtState(g.epoch, "running");
    }
    return r;
  }
  genVerify(gen: number, ok: boolean) {
    genVerify(this.c, gen, ok);
  }
  genEnded(gen: number) {
    genEnded(this.c, gen);
  }
  pinGen(gen: number, until: number) {
    pinGen(this.c, gen, until);
  }
  /** The last stop of this epoch was `doctor-required`: the next plan runs Doctor (§8.5). */
  noteDoctorRequired(epoch: number) {
    this.c.db.setMeta(`doctorRequired:${epoch}`, 1);
  }
  hwmCheck() {
    return hwmCheck(this.c);
  }

  // ---------------------------------------------------------------- Runtime DO state, heartbeat, events

  /** The Runtime DO reports its state on each transition; the Control DO caches it (inbox `held`, wake retry). */
  noteRtState(epoch: number, state: RtState): void {
    if (pointer(this.c) !== epoch) return;
    this.c.db.setMeta("rtState", state);
    this.c.db.setMeta("rtStateAt", this.c.now());
    if (state === "asleep") resolveAlert(this.c, "sleep-blocked"); // it slept: the block is over
    if (!RUNNING.includes(state)) {
      driverStop(this.c, state);
      if (["quiescing", "asleep", "asleep-unconfirmed"].includes(state)) quietToHeld(this.c);
      this.c.db.delMeta("wakePhase");
    } else if (driverResume(this.c, currentGen(this.c, epoch))) void this.kickDriver();
  }
  rtState(): RtState | null {
    return (this.c.db.meta("rtState") as RtState | null) ?? null;
  }

  /** Heartbeat fields the Control DO keeps (§12.5, §16, C23). */
  noteHeartbeat(h: {
    gen: number;
    cpuS?: number | null;
    telegramSecretVersion?: number | null;
    channels?: { channel: string; account: string; transport?: string; lifecycle?: string }[];
    rpo?: string | null;
    eventJobs?: { id: string; kind: string; name?: string }[];
    disk?: DiskHb | null;
  }): void {
    const c = this.c;
    if (h.eventJobs) c.db.setMeta("eventJobs", h.eventJobs.slice(0, 32));
    if (h.disk) noteDisk(c, h.gen, h.disk);
    if (typeof h.cpuS === "number") wakeCpu(c, h.gen, h.cpuS);
    if (h.telegramSecretVersion != null && h.telegramSecretVersion === c.db.metaNum("webhookSecretVer", 0))
      c.db.setMeta("webhookSecretPrevUntil", 0);
    if (h.rpo === "seeding") c.db.setMeta(`seeding:${h.gen}`, "1");
    else if (h.rpo) c.db.delMeta(`seeding:${h.gen}`);
    if (h.channels)
      for (const ch of h.channels)
        c.db.run(
          `INSERT INTO channels (channel, account, transport, class, source, live, updated_at) VALUES (?, ?, ?, ?, 'live', ?, ?)
           ON CONFLICT(channel, account, source) DO UPDATE SET transport = excluded.transport, class = excluded.class,
             live = excluded.live, updated_at = excluded.updated_at`,
          ch.channel,
          ch.account,
          ch.transport ?? null,
          ch.transport === "webhook" ? "sleep-ok" : ch.transport ? "socket" : "unknown",
          ch.lifecycle ?? null,
          c.now(),
        );
  }

  /** ControlGate `/v1/event` hooks the Control DO owns; the rest go to the ring. */
  event(gen: number, e: { kind: string; reason?: string | null; detail?: unknown }): void {
    ring(this.c, `g${gen}`, e.kind, { reason: e.reason, detail: e.detail });
    if (e.kind === "ingress-ready") driverIngressReady(this.c, gen);
    // Wake progress labels (progress.ts); noteRtState clears them when the runtime leaves the running states.
    notePhase(this.c, gen, e.kind);
    if (e.kind === "seeded") {
      this.c.db.run("UPDATE gendb SET seeded_at = COALESCE(seeded_at, ?) WHERE gen = ?", this.c.now(), gen);
      this.c.db.delMeta(`seeding:${gen}`);
    }
    if (e.kind === "doctor") this.c.db.setMeta("lastDoctorDigest", genRow(this.c, gen)?.digest ?? "");
  }

  ring(src: string, kind: string, detail?: unknown): void {
    ring(this.c, src, kind, detail);
  }
  alert(cls: string, severity: Severity, detail = ""): boolean {
    return alert(this.c, cls, severity, detail);
  }
  resolveAlert(cls: string) {
    resolveAlert(this.c, cls);
  }
  flushAlerts() {
    return flushAlerts(this.c);
  }

  tier() {
    return latestTier(this.c);
  }

  // ---------------------------------------------------------------- markers, snapshots, archives

  /** Sleep phase 6: marker pending + path A replicated marks (§10.2, §12.4). */
  markerPending(m: MarkerInput) {
    return this.c.db.tx(() => {
      const r = markerPending(this.c, m);
      if (r.ok) markReplicated(this.c, m.lastWriteAtPerDb[STATE_DB]);
      return r;
    });
  }
  /** L3: an outbound Bot API call to a chat marks its accepted rows replied. */
  chatSummary(): ReturnType<typeof chatSummary> {
    return chatSummary(this.c);
  }

  noteOutbound(chatId: string | number | null, at: number, method: string): number {
    progressNoteOutbound(this.c, chatId, at, method);
    const n = noteOutbound(this.c, chatId, at, method);
    if (n) ring(this.c, "inbox", "replied", { chatId, n, method });
    if (this.c.test && chatId != null && REPLY_METHODS.test(method)) {
      try {
        noteSoakSend(this.c.db, String(chatId), at);
      } catch {
        // soak tables not created yet: no plan ran
      }
    }
    return n;
  }
  /** §10.2 phase 6 (Runtime calls it separately): accepted rows with accepted_at ≤ upTo → replicated. */
  markReplicated(upTo: number): number {
    return markReplicated(this.c, upTo);
  }
  ingressReady(gen: number) {
    driverIngressReady(this.c, gen);
  }
  markerValid(opId: string, snapshotId: string) {
    return markerValid(this.c, opId, snapshotId);
  }
  markerVoid(by: { opId?: string; id?: string }, reason: string) {
    return markerVoid(this.c, by, reason);
  }
  snapshotSaved(h: SnapshotHandle) {
    return snapshotSaved(this.c, h);
  }
  snapshotMiss(id: string) {
    return snapshotMiss(this.c, id);
  }
  snapshotAllowed(kind: string) {
    return snapshotAllowed(this.c, kind);
  }
  snapshotAbandon(id: string) {
    return snapshotAbandon(this.c, id);
  }
  imagesInUse() {
    return imagesInUse(this.c);
  }
  pruneAllowed(tag: string, digest: string) {
    return pruneAllowed(this.c, tag, digest);
  }
  // ---------------------------------------------------------------- CredStore, config (owner side)

  credManifest() {
    return credManifest(this.c);
  }
  configMarkBad(ver: number) {
    configMarkBad(this.c, ver);
  }

  // ---------------------------------------------------------------- inbox

  /** M7 F1: take newer secret values from a Worker isolate's env. Returns the names that changed (no values). */
  freshSecrets(f: FreshSecrets): string[] {
    const c = this.c;
    const took: string[] = [];
    for (const [k, v] of Object.entries(f.platform ?? {})) {
      if (typeof v !== "string" || !v || c.secrets.platform?.[k] === v) continue;
      c.secrets.platform = { ...(c.secrets.platform ?? {}), [k]: v };
      took.push(k);
    }
    if (typeof f.botToken === "string" && f.botToken && f.botToken !== c.secrets.botToken) {
      c.secrets.botToken = f.botToken;
      took.push("OC_SECRET_OC_TELEGRAM_BOT_TOKEN");
    }
    // A Worker version that is not the one this DO was built with: the next boot may change the image digest.
    // Until a boot follows, a sleep first takes a fresh archive (N8; ctl/archives.ts preBootArchive).
    if (
      f.version &&
      c.buildVersion &&
      f.version !== c.buildVersion &&
      c.db.meta("redeployVersion") !== f.version
    ) {
      c.db.setMeta("redeployVersion", f.version);
      c.db.setMeta("redeployAt", c.now());
      ring(c, "epoch", "redeploy-seen", { version: f.version });
    }
    if (took.length) ring(c, "secrets", "fresh", { names: took });
    return took;
  }

  /**
   * POST /ops/inbox/drop (owner): dead-letter pending and held rows that cannot be delivered (a route the gateway
   * does not serve, a channel that was removed). Body `{id}` or `{all: true, channel?, state?}`. Rows become
   * `dead` (reason `dropped`); expireInbox deletes them 24 h after receipt like any dead row.
   */
  opsInboxDrop(b: Record<string, unknown>): OpsRes {
    const id = typeof b.id === "string" && b.id ? b.id : null;
    const channel = typeof b.channel === "string" && b.channel ? b.channel : null;
    const states = b.state === "pending" ? ["pending"] : ["pending", "held"];
    if (!id && b.all !== true)
      return {
        status: 400,
        body: { error: "need id or all", next: "POST /ops/inbox/drop {id} or {all:true}" },
      };
    let route: string | null = null;
    if (channel) {
      route = routeOfChannel(channel);
      if (!route) return { status: 400, body: { error: "unknown channel", channel } };
    }
    const r = dropInbox(this.c, { id, route, states, reason: "dropped" });
    if (id && !r.n) {
      const row = this.c.db.one<{ state: string }>("SELECT state FROM inbox WHERE id = ?", id);
      return row
        ? { status: 409, body: { error: "not-open", id, state: row.state } }
        : { status: 404, body: { error: "no such row", id } };
    }
    return { status: 200, body: { ok: true, dropped: r.n, ids: r.ids, route } };
  }

  /** ctl.inboxPut (§12.1). The caller acks first, then wakes (`wake`) via waitUntil. */
  inboxPut(p: Omit<PutIn, "asleep">, fresh?: FreshSecrets) {
    if (fresh) this.freshSecrets(fresh);
    const st = this.rtState();
    const r = inboxPut(this.c, {
      ...p,
      asleep: st === "asleep" || st === "asleep-unconfirmed",
      quiescing: st === "quiescing",
    });
    const a = p.route ? adapterByRoute(p.route) : undefined;
    if (a && r.status === 200 && !r.malformed) this.hookSeen(a.id, "event");
    if (r.status === 200 && !r.malformed && !r.dup && RUNNING.includes(st as RtState)) this.kickDriver();
    if (!a && r.status === 200 && !r.malformed && !r.dup) {
      const t = parseTelegram(p.body);
      if (t && t.fromId !== null && t.fromId === this.c.db.meta("ownerTelegramId"))
        this.ownerApproving = autoApproveOwner(this.c, t.fromId, t.chatId, this.pairingDeps()).catch((e) =>
          ring(this.c, "pairing", "owner-auto-error", String(e).slice(0, 200)),
        );
    }
    // Cold: the gateway cannot take the update yet. The Worker sends the first typing; the alarm repeats it.
    if (!a && r.status === 200 && !r.malformed && !r.dup && r.wake && this.gatewayCold(st)) {
      const chat = coldReplyChat(p.body);
      if (chat && this.c.secrets.botToken) {
        typingTrack(this.c, chat, r.id);
        r.typing = chat;
        // One progress message per chat per wake, only while the install is not running.
        if (st !== "running" && st !== "maintenance" && progressStart(this.c, chat)) r.progress = chat;
      }
    }
    return r;
  }
  private pairingDeps(): PairingDeps {
    const ep = activeEpoch(this.c);
    const rt = ep ? this.c.rt(ep.n) : null;
    return {
      rtState: async () => (rt ? ((await rt.status()).state ?? null) : this.rtState()),
      restart: async () => {
        if (!rt) return null;
        const s = await rt.ownerStop();
        return { stop: s, start: await rt.ownerStart() };
      },
      wake: () => this.wake("cli"),
    };
  }
  /** S1.11: the running owner auto-approve (tests await it). */
  ownerApproving: Promise<unknown> | null = null;

  /** No gateway can answer now: not running, or running with the driver not yet ingress-ready. */
  private gatewayCold(st: string | null): boolean {
    if (st !== "running" && st !== "maintenance") return true;
    const d = driverState(this.c);
    return !(d.active && d.ready);
  }
  /** The Worker sent the wake progress message (null = the send failed). */
  progressSent(chatId: string, msg: number | null) {
    progressSent(this.c, chatId, msg);
  }
  /** Last authentic call from a platform's webhook (adapter id → {at, kind}); shown by /ops/inbox. */
  hookSeen(id: string, kind: string) {
    this.c.db.setMeta(`hookSeen:${id}`, { at: this.c.now(), kind });
  }
  putWakeAllow(w: { userIds: string[]; groupChatIds: string[]; configVer?: number }) {
    putWakeAllow(this.c, w);
  }
  inboxCounts() {
    return counts(this.c);
  }
  /** Sleep gate rule 5 (§10.1). */
  inboxBlocksSleep() {
    return blocksSleep(this.c);
  }
  /** Webhook secret: is the previous secret still accepted (§12.5)? */
  webhookPrevOk(): boolean {
    return this.c.db.metaNum("webhookSecretPrevUntil", 0) > this.c.now();
  }
  /** M5 CLI rotation: previous secret accepted for 7 d or until a heartbeat reports the new version. */
  webhookRotated(): { ver: number; prevUntil: number } {
    const ver = this.c.db.metaNum("webhookSecretVer", 0) + 1;
    const prevUntil = this.c.now() + 7 * DAY;
    this.c.db.setMeta("webhookSecretVer", ver);
    this.c.db.setMeta("webhookSecretPrevUntil", prevUntil);
    return { ver, prevUntil };
  }

  /** Run the driver now (not awaited by callers that must answer fast). */
  kickDriver(): Promise<unknown> {
    if (this.pumping) return this.pumping;
    this.pumping = pump(this.c)
      .catch((e) => ring(this.c, "driver", "pump-error", String(e).slice(0, 200)))
      .finally(() => {
        this.pumping = null;
      });
    return this.pumping;
  }

  // ---------------------------------------------------------------- sleep support

  wakePlan(x: { nextWakeAtMs: number | null; lastWakeAt?: number | null }) {
    return wakePlan(this.c, x);
  }
  sleepWorthIt(nextWakeAtMs: number | null) {
    return sleepWorthIt(this.c, nextWakeAtMs);
  }
  costCheck() {
    return costCheck(this.c);
  }
  wakeSlept(x: Parameters<typeof wakeSlept>[1]) {
    wakeSlept(this.c, x);
    const g = genRow(this.c, x.gen);
    if (g) this.noteRtState(g.epoch, "asleep");
  }
  /** §9.3: R2 probes healthy since t (all rows ok and at least one). */
  r2HealthySince(t: number): boolean {
    const rows = this.c.db.all<{ ok: number }>("SELECT ok FROM r2probe WHERE at >= ?", t);
    return rows.length > 0 && rows.every((r) => r.ok === 1);
  }

  // ---------------------------------------------------------------- cron ensure, alarm

  /** `*\/5` cron (§11.3): install on first call, hwm check, rt(active).ensure(), inbox wake. */
  async ensure(img?: ImageRef): Promise<{ epoch: number | null; state: RtState | string; woke?: boolean }> {
    const c = this.c;
    if (!pointer(c)) install(c, img ?? { imageKey: "oc", digest: "unknown", codeVersion: c.codeVersion });
    if (!this.hwmChecked) this.hwmChecked = (await hwmCheck(c)).checked;
    await this.credsCopyStep().catch((e) => ring(c, "creds", "copy-error", String(e).slice(0, 200)));
    for (const op of openEpochOps(c)) await runEpochOp(c, op.opId);
    const ep = activeEpoch(c);
    if (!ep) return { epoch: null, state: "no-active-epoch" };
    let state: RtState | string = "unknown";
    try {
      state = (await c.rt(ep.n).ensure()).state;
      this.noteRtState(ep.n, state as RtState);
    } catch (e) {
      ring(c, "ensure", "rt-error", String(e).slice(0, 200));
    }
    let woke = false;
    if (counts(c).pending > 0 && !RUNNING.includes(state as RtState)) woke = await this.wake("inbox");
    return { epoch: ep.n, state, woke };
  }

  private async wake(reason: WakeReason): Promise<boolean> {
    const ep = activeEpoch(this.c);
    if (!ep) return false;
    try {
      const r = await this.c.rt(ep.n).requestWake(reason);
      this.noteRtState(ep.n, r.state);
      return true;
    } catch (e) {
      ring(this.c, "wake", "rt-error", String(e).slice(0, 200));
      return false;
    }
  }

  private async rtStatus(): Promise<RtStatusLite | null> {
    const ep = activeEpoch(this.c);
    if (!ep) return null;
    try {
      const s = await this.c.rt(ep.n).status();
      this.noteRtState(ep.n, s.state);
      return s;
    } catch (e) {
      ring(this.c, "status", "rt-error", String(e).slice(0, 200));
      return null;
    }
  }

  /**
   * Creds second copy (plan §6.1 row 2) and its restore (drill L, spec §13.3): a rewound Control DO loads the
   * newest `c/` copy into the CredStore once; otherwise write a new copy when due.
   */
  async credsCopyStep(): Promise<void> {
    const c = this.c;
    if (c.db.meta("ctlState") === "ctl-rewound") {
      if (!c.db.meta("credsRestoredFrom")) await restoreCredsFromCopy(c);
      // Drill J: rebuild gens, archives, config and the install marker from R2 (once per rewind).
      // One run at a time per isolate (live J: the owner start and the tick raced).
      if (!c.db.meta("rebuild")) {
        if (!this.rebuilding)
          this.rebuilding = rebuildIndex(c).finally(() => {
            this.rebuilding = null;
          });
        await this.rebuilding;
      }
      return;
    }
    await copyCredsIfDue(c);
    await copyConfigIfDue(c);
  }

  /** Alarm handler (§11.5). Never throws. Returns the next alarm time (null = none). */
  async tick(): Promise<number | null> {
    const c = this.c;
    const step = async (name: string, f: () => unknown) => {
      try {
        await f();
      } catch (e) {
        ring(c, "tick", `${name}-error`, String(e).slice(0, 300));
      }
    };
    await step("hwm", async () => {
      if (!this.hwmChecked) this.hwmChecked = (await hwmCheck(c)).checked;
    });
    await step("creds-copy", () => this.credsCopyStep());
    await step("epoch-ops", async () => {
      for (const op of openEpochOps(c)) await runEpochOp(c, op.opId);
    });
    await step("inbox-expire", () => expireInbox(c));
    await step("inbox-wake", async () => {
      const due = nextWakeRetryAt(c);
      if (due === null || c.now() < due) return;
      c.db.setMeta("inboxWakeTryAt", c.now());
      const st = await this.rtStatus();
      if (!st || !["starting", "running"].includes(st.state)) await this.wake("inbox");
    });
    await step("held-wake", async () => {
      // §11.2 / add §2.2: a held row replays before its dead line. The Runtime DO plans its alarm at sleep time;
      // a row held after that is covered here: wake `maint` at oldestHeld + heldMaxMs.
      const due = this.heldWakeAt();
      if (due === null || c.now() < due) return;
      c.db.setMeta("heldWakeAt", c.now());
      const st = await this.rtStatus();
      if (st && (st.state === "asleep" || st.state === "asleep-unconfirmed")) await this.wake("maint");
    });
    await step("no-reply", () => noReplyCheck(c, this.rtState() === "running"));
    await step("typing", () => typingTick(c));
    await step("progress", () => progressTick(c));
    await step("driver", () => this.kickDriver());
    await step("r2probe", () => this.r2Probe());
    await step("daily", () => this.dailyIfDue());
    await step("drill", async () => {
      if (!drillDue(c) || !this.ledger) return;
      c.db.setMeta("drillTriedAt", c.now());
      await runDrill(c, this.ledger, c.drill);
    });
    await step("gen-verify", () => this.genVerifyStep());
    await step("archive-stall", () => archiveStallCheck(c));
    await step("archive-gc", () => this.archiveGcStep());
    await step("gc-more", async () => {
      if (c.db.meta("gcMore") === "1") await runGc(c);
    });
    await step("deadman", () => deadmanCheck(c));
    await step("soak", () => soakTick(c, this.soakPort(), { dump: () => dumpToR2(c, this.soakPort()) }));
    await step("alerts", () => flushAlerts(c));
    return this.nextAlarmAt();
  }

  /**
   * `ochost restart` after a deploy: wait (≤ RESTART_ARCHIVE_WAIT_MS) for an archive that holds the latest writes.
   * ocsup serves a request at its next archive poll (≤ 60 s). Returns what happened, for the CLI line.
   */
  async archiveBeforeRestart(): Promise<"fresh" | "taken" | "failed" | "timeout" | "stalled" | "skipped"> {
    const c = this.c;
    if (this.rtState() !== "running") return "skipped";
    if (!archiveDirty(c) || archiveFreshForRestart(c)) return "fresh";
    const req = requestArchive(c, "pre-upgrade");
    const end = Date.now() + RESTART_ARCHIVE_WAIT_MS;
    for (;;) {
      const cur = c.db.metaJson<{ id?: string; state?: string; progressAt?: number; at?: number } | null>(
        "archiveRequest",
        null,
      );
      if (cur?.id === req.id && cur.state === "done") return "taken";
      if (cur?.id === req.id && cur.state === "failed") return "failed";
      const last = cur?.id === req.id ? (cur.progressAt ?? cur.at ?? 0) : 0;
      if (last && Date.now() - last > RESTART_ARCHIVE_STALL_MS) return "stalled";
      if (Date.now() >= end || this.rtState() !== "running") return "timeout";
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }

  /**
   * N7 (plan §6.1 row 1): `verified` = a restore of the gen's newest LTX set into a scratch DB passes
   * quick_check (ocsup verify-gen). Run for the current gen once it is `complete`, at most once per gen,
   * while the install runs. A verdict marks the gen `verified` or `bad` (alert); no verdict (asleep, R2 or gate
   * error, timeout) leaves it `complete`. Gen GC deletes only below the newest verified gen (ctl/gc.ts).
   */
  async genVerifyStep(): Promise<boolean | null> {
    const c = this.c;
    const ep = activeEpoch(c);
    const gen = ep ? currentGen(c, ep.n) : null;
    if (!ep || gen === null || genRow(c, gen)?.state !== "complete") return null;
    if (c.db.metaNum("genVerifyTried", 0) >= gen || this.rtState() !== "running") return null;
    const rt = c.rt(ep.n);
    if (!rt.verifyGen) return null;
    const dbs = c.db
      .all<{ db: string }>("SELECT db FROM gendb WHERE gen = ? AND l0_max_txid IS NOT NULL ORDER BY db", gen)
      .map((r) => r.db);
    if (!dbs.length) return null;
    c.db.setMeta("genVerifyTried", gen);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      rt.verifyGen({ gen, dbs, timeoutMs: GEN_VERIFY_MS }),
      new Promise<{ verified: null; why: string }>((ok) => {
        timer = setTimeout(() => ok({ verified: null, why: "rpc-timeout" }), GEN_VERIFY_MS + 10_000);
      }),
    ])
      .catch((e) => ({ verified: null, why: String(e).slice(0, 200) }))
      .finally(() => clearTimeout(timer));
    if (r.verified === null) {
      ring(c, "gen", "verify-none", { gen, why: r.why });
      return null;
    }
    genVerify(c, gen, r.verified);
    ring(c, "gen", r.verified ? "verified" : "verify-bad", { gen, dbs, why: r.why });
    if (!r.verified)
      alert(c, "gen-bad", "high", `gen ${gen} restore probe failed: ${r.why ?? ""}`.slice(0, 300));
    return r.verified;
  }

  /**
   * F11 (plan §6.1 row 7, §6.3): after each archive completion, read back the newest archive and GC by the keep
   * rules (newest 8, first of each of 14 days, first of each of 8 weeks, pre-upgrade). Create-before-delete holds:
   * only archives older than a verified one go.
   */
  async archiveGcStep(): Promise<boolean> {
    const c = this.c;
    if (c.db.meta("archiveGcDue") !== "1") return false;
    c.db.delMeta("archiveGcDue");
    if (this.ledger)
      await verifyNewest(c, this.ledger).catch((e) =>
        ring(c, "archive", "verify-error", String(e).slice(0, 200)),
      );
    await runArchiveGc(c);
    return true;
  }

  async r2Probe(force = false): Promise<{ ok: boolean; ms?: number; err?: string } | null> {
    const c = this.c;
    const st = this.rtState();
    const last = c.db.one<{ m: number | null }>("SELECT MAX(at) AS m FROM r2probe")?.m ?? 0;
    if (!force && (!AWAKE_FOR_PROBE.includes(st as RtState) || c.now() - last < c.timers.r2ProbeMs))
      return null;
    const t0 = Date.now();
    let ok = 1;
    let err: string | null = null;
    try {
      await c.bucket.head(installedKey(c.inst));
    } catch (e) {
      ok = 0;
      err = String(e).slice(0, 200);
    }
    c.db.run(
      "INSERT INTO r2probe (at, ok, ms, err) VALUES (?, ?, ?, ?) ON CONFLICT(at) DO UPDATE SET ok = excluded.ok",
      c.now(),
      ok,
      Date.now() - t0,
      err,
    );
    c.db.run("DELETE FROM r2probe WHERE at < ?", c.now() - 2 * 3_600_000);
    return { ok: ok === 1, ms: Date.now() - t0, ...(err ? { err } : {}) };
  }

  /**
   * §9.3 evidence: R2 probes healthy during the boot. With no probe row since `since`, probe once now.
   * The gate hello half of the rule is checked by the caller (ledger.helloServed).
   */
  async r2HealthyDuring(since: number): Promise<boolean> {
    const n = this.c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM r2probe WHERE at >= ?", since)?.n ?? 0;
    if (!n) await this.r2Probe(true);
    return this.r2HealthySince(since);
  }

  /** Sleep gate inputs the Control DO owns (§10.1 rules 1, 5, 9; §11.2 oldestHeld). */
  sleepInputs(): {
    mode: "auto" | "off";
    idleBaseMs: number;
    minAwakeMs: number;
    blockers: string[];
    inboxBusy: number;
    costOk: boolean;
    costWhy?: string;
    oldestHeldAt: number | null;
  } {
    const c = this.c;
    const s = c.settings();
    const blockers: string[] = [];
    for (const ch of c.db.all<{ channel: string; account: string; class: string }>(
      "SELECT channel, account, class FROM channels WHERE class IN ('socket', 'unknown')",
    ))
      blockers.push(`channel:${ch.channel}/${ch.account}:${ch.class}`);
    for (const j of c.db.metaJson<{ id: string; kind: string; name?: string }[]>("eventJobs", []))
      blockers.push(`event-job:${j.name ?? j.id}:${j.kind}`);
    if (c.db.one("SELECT k FROM meta WHERE k LIKE 'seeding:%' AND v = '1' LIMIT 1")) blockers.push("seeding");
    // Chain bound (ctl/chain.ts): a due rebase marks the next wake and may ask for an archive first.
    rebaseAtSleep(c);
    // M4: the sleep waits (capped) for an open, due or requested archive (gates/archive-policy.ts). A request
    // with no progress for stallMs fails first (archive-stalled), so it never holds the sleep past that.
    archiveStallCheck(c);
    // N8: a deploy since the last boot may make the next boot an archive-path boot; take an archive first.
    ensurePreBootArchive(c);
    blockers.push(...archiveSleepBlockers(c));
    blockers.push(...importSleepBlockers(c));
    const ib = blocksSleep(c);
    const cost = costCheck(c);
    const k = counts(c);
    return {
      mode: s.sleep.mode,
      idleBaseMs: c.timers.idleMs,
      minAwakeMs: c.timers.minAwakeMs,
      blockers,
      // Rule 5 counts pending rows only. Accepted rows become `replicated` in sleep phase 6 (path A, §12.4), so
      // blocking on them before the sleep starts would never let the container sleep while path B is off.
      inboxBusy: ib.pending,
      costOk: cost.allow,
      ...(cost.allow
        ? {}
        : {
            costWhy: `cost guard: spend24 ${cost.spend24.toFixed(4)} + cycle > always24 ${cost.always24.toFixed(4)}`,
          }),
      oldestHeldAt: k.oldestHeldAt,
    };
  }

  private dailyDueAt(): number {
    const now = this.c.now();
    const today = utcDay(now);
    const at = Date.parse(`${today}T0${DAILY_HOUR_UTC}:00:00Z`);
    return this.c.db.meta("dailyDay") === today ? at + DAY : at;
  }

  /** Daily job at 03:00 UTC (§11.5): GC, hwm check, TTL expiry, prunes. */
  async dailyIfDue(force = false): Promise<boolean> {
    const c = this.c;
    if (!force && c.now() < this.dailyDueAt()) return false;
    c.db.setMeta("dailyDay", utcDay(c.now()));
    await hwmCheck(c);
    expireSnapshots(c);
    dailyHeartbeat(c);
    await runGc(c);
    // M4 archives: read back the newest one (GC deletes only below a newer verified copy), then GC.
    if (this.ledger)
      await verifyNewest(c, this.ledger).catch((e) =>
        ring(c, "archive", "verify-error", String(e).slice(0, 200)),
      );
    await runArchiveGc(c).catch((e) => ring(c, "archive-gc", "error", String(e).slice(0, 200)));
    pruneOps(c);
    pruneWakeLog(c);
    await this.r2Probe(true);
    c.db.run("DELETE FROM budget_day WHERE day < ?", utcDay(c.now() - 60 * DAY));
    return true;
  }

  /** oldestHeld + heldMaxMs, unless a wake for it was already requested at or after that time. */
  private heldWakeAt(): number | null {
    const c = this.c;
    const oldest = c.db.one<{ m: number | null }>(
      "SELECT MIN(received_at) AS m FROM inbox WHERE state = 'held' AND quiet = 0",
    )?.m;
    if (oldest == null) return null;
    const due = oldest + c.timers.heldMaxMs;
    const last = c.db.metaNum("heldWakeAt", 0);
    return last >= due ? last + c.timers.inboxWakeEveryMs : due;
  }

  /** Soak runner hooks, set by the Control DO (do.ts) on test installs. */
  faultHook?: (body: {
    name: string;
    params?: Record<string, unknown>;
  }) => Promise<{ status: number; body: unknown }>;
  rawBucket?: RawBucket;
  private soakSeq = 0;

  /** What a soak step may touch (ctl/soak/lib.ts): status, owner ops, Runtime and Control DO faults, inbox injection. */
  soakPort(): SoakPort {
    const c = this.c;
    return {
      c,
      status: () => this.status(),
      ops: (action, method = "POST", body = {}, query = {}) =>
        this.ops({ action, method, sub: [], query, body, role: "owner" }),
      rtFault: async (name, params = {}) => {
        const ep = activeEpoch(c);
        if (!ep) return { ok: false, error: "no-active-epoch" };
        const rt = c.rt(ep.n) as unknown as {
          fault?(n: string, p: Record<string, unknown>): Promise<FaultRes>;
        };
        return rt.fault ? await rt.fault(name, params) : { ok: false, error: "no fault rpc" };
      },
      ctlFault: async (name, params = {}) =>
        this.faultHook ? this.faultHook({ name, params }) : { status: 404, body: { error: "no fault hook" } },
      inject: async (chat, text, who) => {
        const { upd, body } = soakUpdate(chat, text, c.now(), ++this.soakSeq);
        const r = this.inboxPut({ body, headers: { host: "soak.local" } });
        if (r.status === 200 && !r.malformed) {
          ensureSoak(c.db);
          c.db.run(
            "INSERT OR REPLACE INTO soak_chat (chat_id, plan, step, update_id, injected_at) VALUES (?, ?, ?, ?, ?)",
            String(chat),
            who.plan,
            who.step,
            String(upd),
            c.now(),
          );
          // Soak senders are strangers to the gateway's wake list (N11), so once a Telegram channel exports
          // one, their rows are held while asleep and never wake (live oc-m7-soak, 2026-11-10: s4 cycle held).
          // The soak measures the wake path, not the filter: on this test-only port the row wakes like an
          // allowed sender's.
          let wake = r.wake;
          if (!r.dup && r.state === "held") {
            c.db.run("UPDATE inbox SET state = 'pending', quiet = 0 WHERE id = ? AND state = 'held'", r.id);
            wake = true;
          }
          if (wake) await this.wake("webhook");
        }
        return r.status === 200 && !r.malformed
          ? { status: 200, id: r.id, dup: r.dup }
          : { status: r.status };
      },
      rawBucket: () => this.rawBucket ?? (c.bucket as unknown as RawBucket),
    };
  }

  nextAlarmAt(): number | null {
    const c = this.c;
    const now = c.now();
    const cands: (number | null)[] = [
      nextWakeRetryAt(c),
      driverDueAt(c),
      this.dailyDueAt(),
      this.heldWakeAt(),
      typingDueAt(c),
      progressDueAt(c),
      soakNextAt(c),
      archiveStallAt(c),
    ];
    if (openEpochOps(c).length || c.db.meta("gcMore") === "1" || c.db.meta("archiveGcDue") === "1")
      cands.push(now + c.timers.opTickMs);
    const ep = activeEpoch(c);
    const cg = ep ? currentGen(c, ep.n) : null;
    const verifyDue =
      cg !== null && c.db.metaNum("genVerifyTried", 0) < cg && genRow(c, cg)?.state === "complete";
    if (verifyDue && this.rtState() === "running") cands.push(now + c.timers.opTickMs);
    if (AWAKE_FOR_PROBE.includes(this.rtState() as RtState)) {
      const last = c.db.one<{ m: number | null }>("SELECT MAX(at) AS m FROM r2probe")?.m ?? 0;
      cands.push(Math.max(now, last + c.timers.r2ProbeMs));
    }
    if (outboxSize(c)) cands.push(now + 30_000);
    const oldest = c.db.one<{ m: number | null }>(
      "SELECT MIN(received_at) AS m FROM inbox WHERE state IN ('pending', 'held')",
    )?.m;
    if (oldest != null) cands.push(oldest + c.timers.inboxDeadMs);
    const keep = c.db.one<{ m: number | null }>(
      "SELECT MIN(received_at) AS m FROM inbox WHERE state IN ('accepted', 'replicated', 'dead')",
    )?.m;
    if (keep != null) cands.push(keep + c.timers.inboxKeepMs);
    const xs = cands.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return xs.length ? Math.max(now, Math.min(...xs)) : null;
  }

  // ---------------------------------------------------------------- status and /ops

  async status(): Promise<Record<string, unknown>> {
    const c = this.c;
    const ep = activeEpoch(c);
    const rt = await this.rtStatus();
    const gen = ep ? currentGen(c, ep.n) : null;
    const g = gen !== null ? genRow(c, gen) : null;
    const plan = g
      ? pj<{
          rootfs?: { kind?: string; snapshotId?: string };
          sqlite?: { kind: string; gen?: number };
          archive?: { archiveId?: string } | null;
          workspace?: { source?: string; acceptLoss?: boolean };
          runDoctor?: boolean;
        }>(g.plan, {})
      : {};
    const day = c.db.one<Record<string, unknown>>("SELECT * FROM budget_day WHERE day = ?", utcDay(c.now()));
    const blockers = [...(rt?.blockers ?? [])];
    const ib = blocksSleep(c);
    if (ib.pending) blockers.push("inbox-pending");
    if (ib.unreplicated) blockers.push("inbox-unreplicated");
    if (c.db.one("SELECT k FROM meta WHERE k LIKE 'seeding:%' AND v = '1' LIMIT 1")) blockers.push("seeding");
    if (c.db.meta("costHold") === "1") blockers.push("cost-guard");
    // Plan §4.12: a full disk sets degraded. ocsup reports it only as alert `disk-full`, so the Runtime DO flag
    // alone never showed it (M7 soak, disk-100). The reasons list says why.
    const rtWhy = Array.isArray(rt?.degradedWhy) ? (rt.degradedWhy as string[]) : [];
    const degradedWhy = [...new Set([...rtWhy, ...diskDegraded(c)])];
    return {
      inst: c.inst,
      codeVersion: c.codeVersion,
      initialized: c.db.metaNum("initialized", 0) === 1,
      ctlState: c.db.meta("ctlState") ?? "ok",
      epoch: ep ? { n: ep.n, imageKey: ep.image_key, digest: ep.digest, status: ep.status } : null,
      state: rt?.state ?? this.rtState(),
      desired: rt?.desired,
      degraded: (rt?.degraded ?? false) || degradedWhy.length > 0,
      degradedWhy,
      disk: lastDisk(c),
      awakeReason: rt?.awakeReason ?? (c.db.meta("costHold") === "1" ? "cost guard" : undefined),
      ladder: rt?.ladder,
      blockers,
      gen: g
        ? {
            gen: g.gen,
            state: g.state,
            mode: g.mode,
            reason: g.reason,
            planKind: g.plan_kind,
            iidBound: !!g.iid,
            secretHash: await secretHash(g.secret),
            restoreGens: pj<number[]>(g.restore_gens, []),
            // M4 live checks: which sources the boot plan named.
            plan: {
              rootfs: plan.rootfs?.kind ?? null,
              snapshotId: plan.rootfs?.snapshotId ?? null,
              sqlite: plan.sqlite?.kind ?? null,
              sqliteGen: plan.sqlite?.gen ?? null,
              archiveId: plan.archive?.archiveId ?? null,
              workspace: plan.workspace?.source ?? null,
              runDoctor: plan.runDoctor ?? null,
            },
          }
        : null,
      chainLength: chainLength(c, plan.rootfs?.snapshotId),
      // Registry growth (ctl/chain.ts): live chain, estimated tags and bytes, rebase and prune state.
      snapshots: snapshotSummary(c),
      // M6: channels the gateway reported in heartbeats; `ochost upgrade run` waits for them after a deploy.
      channels: c.db.all<{ channel: string; account: string; lifecycle: string | null; updatedAt: number }>(
        "SELECT channel, account, live AS lifecycle, updated_at AS updatedAt FROM channels WHERE source = 'live'",
      ),
      inbox: counts(c),
      driver: driverState(c),
      tier: latestTier(c),
      budget: day ?? null,
      rpo: c.db.one("SELECT k FROM meta WHERE k LIKE 'seeding:%' AND v = '1' LIMIT 1") ? "seeding" : "ok",
      wake: { ...meter(c), leadMs: leadMs(c) },
      costGuard: (() => {
        const r = costCheck(c);
        return { holding: r.holding, spend24: r.spend24, always24: r.always24, cycle: r.cycle };
      })(),
      alerts: listAlerts(c).filter((a) => a.open),
      sink: sinkInfo(c),
      deadman: deadmanCheck(c),
      openOps: openOps(c).map((o) => ({ opId: o.opId, kind: o.kind, phase: o.phase })),
      // Runtime DO detail for live checks (no secrets): last heartbeat, sleep record, open Runtime ops.
      rt: rt
        ? { row: rt.row, hb: rt.hb ?? null, sleep: rt.sleep, ops: rt.ops, codeVersion: rt.codeVersion }
        : null,
    };
  }

  /**
   * The owner status page at `/` (ingress/routes.ts): the few fields it shows, nothing else. Never wakes.
   * Alerts: the two newest by last time, open or not, class and severity only (no detail text).
   */
  async ownerView(): Promise<OwnerView> {
    const c = this.c;
    const rt = (await this.rtStatus()) as
      | (RtStatusLite & {
          stateAt?: number;
          lastActivityAt?: number;
          hb?: { lastActivityAt?: number | null } | null;
          sleep?: { wakeAt?: number | null; nextWakeAtMs?: number | null };
          ladder?: { lastClass?: string | null };
        })
      | null;
    const acts = [rt?.lastActivityAt ?? null, rt?.hb?.lastActivityAt ?? null].filter(
      (x): x is number => typeof x === "number" && x > 0,
    );
    const snaps = c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots WHERE state != 'pruned'");
    const alerts = c.db.all<{ class: string; severity: string; at: number | null; open: number }>(
      "SELECT class, severity, last_sent_at AS at, open FROM alerts ORDER BY last_sent_at DESC LIMIT 2",
    );
    return {
      inst: c.inst,
      state: rt?.state ?? this.rtState() ?? "unknown",
      stateAt: typeof rt?.stateAt === "number" ? rt.stateAt : null,
      lastActivityAt: acts.length ? Math.max(...acts) : null,
      nextWakeAt: rt?.sleep?.wakeAt ?? rt?.sleep?.nextWakeAtMs ?? null,
      snapshots: snaps?.n ?? 0,
      alerts: alerts.map((a) => ({ class: a.class, severity: a.severity, at: a.at, open: a.open === 1 })),
      now: c.now(),
      desired: rt?.desired ?? null,
      ladderClass: rt?.ladder?.lastClass ?? null,
    };
  }

  /** Set by the Control DO class: the probes that need bindings (gate hop, sandbox state) and env facts. */
  panelProbes?: Pick<PanelDeps, "hop" | "sandbox" | "env">;

  /** GET /ops/doctor and the owner panel: one JSON for the CLI and the page (ctl/panel.ts). Never wakes. */
  async ownerPanel(o: { origin: string | null; fresh?: boolean }): Promise<Panel> {
    const p = this.panelProbes;
    const panel = await ownerPanel(
      this.c,
      {
        status: () => this.status(),
        view: () => this.ownerView(),
        caps: () => this.ledger?.capsView() ?? null,
        sink: () => sinkInfo(this.c),
        hop: p?.hop ?? (async () => ({ status: 404, ms: 0 })),
        files: () => filesProbe(this.c.bucket, this.c.inst, this.c.now),
        filesView: () => this.ledger?.filesView() ?? null,
        sandbox: p?.sandbox ?? (async () => null),
        env: p?.env ?? { access: null, gateway: "" },
      },
      o,
    );
    // Channel adoption (ctl/panel-adopt.ts): the Setup tab row.
    return { ...panel, channels: { ...panel.channels, adopt: adoptView(this.c) } } as Panel;
  }

  /**
   * docs/11 §8 file storage. GET: usage against the cap. POST /ops/files/purge (`ochost destroy --delete-data`):
   * delete up to 10 000 objects under f/<inst>/ per call; `more` says call again.
   */
  private async opsFiles(r: OpsReq): Promise<OpsRes> {
    const c = this.c;
    if (!this.ledger) return { status: 503, body: { error: "no-ledger" } };
    if (r.method === "GET" && !r.sub[0]) return { status: 200, body: this.ledger.filesView() };
    if (r.method !== "POST" || r.sub[0] !== "purge") return { status: 404, body: { error: "not found" } };
    let deleted = 0;
    for (let i = 0; i < 10; i++) {
      const l = await c.bucket.list({ prefix: filesPrefix(c.inst), limit: 1000 });
      const keys = l.objects.map((o) => o.key);
      if (keys.length) await c.bucket.delete(keys);
      this.ledger.filesForget(keys);
      deleted += keys.length;
      if (!l.truncated) {
        this.ledger.filesForget(null);
        this.ring("files", "purge", { deleted });
        return { status: 200, body: { ok: true, deleted, more: false } };
      }
    }
    return { status: 200, body: { ok: true, deleted, more: true } };
  }

  /** /ops/* actions that the Control DO serves (ops.ts does auth and routing; spec §19.2). */
  async ops(r: OpsReq): Promise<OpsRes> {
    const c = this.c;
    const took = r.fresh ? this.freshSecrets(r.fresh) : [];
    if (r.sink) {
      if (
        (r.sink.url ?? undefined) !== c.secrets.alertUrl ||
        (r.sink.token ?? undefined) !== c.secrets.alertToken
      )
        ring(c, "alert", "sink-env", { from: !!c.secrets.alertUrl, to: !!r.sink.url });
      c.secrets.alertUrl = r.sink.url ?? undefined;
      c.secrets.alertToken = r.sink.token ?? undefined;
    }
    const ep = activeEpoch(c);
    const rt = ep ? c.rt(ep.n) : null;
    const noRt = { status: 409, body: { error: "no-active-epoch" } };
    // M3 e2e (live B7): a new Worker waited 10-15 min for its first */5 cron. An owner wake/start on a
    // never-installed install runs the cron's ensure() now (same install path), then serves the action.
    if ((r.action === "wake" || r.action === "start") && !ep && !pointer(c)) {
      const e = await this.ensure();
      ring(c, "ensure", "owner", JSON.stringify({ action: r.action, epoch: e.epoch, state: e.state }));
      if (e.epoch !== null) return { status: 200, body: { ensured: true, epoch: e.epoch, state: e.state } };
      return noRt;
    }
    switch (r.action) {
      case "status":
        return { status: 200, body: await this.status() };
      case "idle": {
        const st = this.rtState();
        return {
          status: 200,
          body: { asleep: st === "asleep", opOpen: openOps(c).length > 0, codeVersion: c.codeVersion },
        };
      }
      case "images-in-use":
        return { status: 200, body: { images: imagesInUse(c) } };
      case "ci":
        c.db.setMeta("ci", { ...r.body, at: c.now() });
        return { status: 200, body: { ok: true } };
      case "doctor":
        if (r.method !== "GET") return { status: 404, body: { error: "not found" } };
        return {
          status: 200,
          body: await this.ownerPanel({
            origin: /^https?:\/\/[^/]+$/.test(r.query.origin ?? "") ? (r.query.origin as string) : null,
            fresh: r.query.fresh === "1",
          }),
        };
      case "upgrade-check": {
        // `ochost upgrade check` tells the install what the CLI knows; the owner panel shows it (names and versions only).
        if (r.method !== "POST") return { status: 404, body: { error: "not found" } };
        const str = (v: unknown, n = 40) => (typeof v === "string" ? v.slice(0, n) : null);
        const pin = r.body.pinned as { version?: unknown; digest?: unknown } | undefined;
        const tgt = r.body.target as { version?: unknown } | undefined;
        c.db.setMeta("upgradeCheck", {
          at: c.now(),
          cliVersion: str(r.body.cliVersion),
          pinned:
            pin && str(pin.version) ? { version: str(pin.version), digest: str(pin.digest, 80) ?? "" } : null,
          target: tgt && str(tgt.version) ? { version: str(tgt.version) } : null,
          delta: str(r.body.delta, 12),
        });
        return { status: 200, body: { ok: true } };
      }
      case "render-check": {
        // The CLI's render version (cli/src/config.ts RENDER_VERSION). The panel shows "config render outdated" when the
        // newest config version's ochost.renderVersion is lower. Numbers only.
        if (r.method !== "POST") return { status: 404, body: { error: "not found" } };
        const v = r.body.renderVersion;
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1e6)
          return { status: 400, body: { error: "renderVersion must be a small integer" } };
        c.db.setMeta("cliRender", { at: c.now(), version: v });
        return { status: 200, body: { ok: true } };
      }
      case "deploy-check": {
        const head = String(r.body.head ?? r.query.head ?? "");
        const sleepOpen = (rt ? await rt.status().catch(() => null) : null)?.state === "quiescing";
        if (sleepOpen || openOps(c).length) return { status: 409, body: { error: "op-open" } };
        if (head && head !== c.codeVersion)
          return { status: 409, body: { error: "code-version", live: c.codeVersion } };
        // F1: a deploy with a new image digest needs an archive with the workspace newer than the newest
        // snapshot (the CLI takes a pre-upgrade archive first). `image: true` when the digest is not known yet.
        const digest = typeof r.body.digest === "string" ? r.body.digest : null;
        if ((digest && ep && digest !== ep.digest) || r.body.image === true) {
          const g = digestGuard(c, ep?.digest ?? null);
          if (!g.ok)
            return {
              status: 409,
              body: {
                error: "archive-stale",
                why: g.why,
                next: "POST /ops/archive {reason:pre-upgrade}",
                ...g,
              },
            };
        }
        return { status: 200, body: { ok: true, codeVersion: c.codeVersion } };
      }
      case "wake": {
        if (!rt || !ep) return noRt;
        const w = await rt.requestWake("cli");
        this.noteRtState(ep.n, w.state);
        return { status: 200, body: w };
      }
      case "start": {
        if (!rt) return noRt;
        return { status: 200, body: await rt.ownerStart() };
      }
      case "stop": {
        if (!rt) return noRt;
        return { status: 200, body: await rt.ownerStop() };
      }
      case "restart": {
        if (!rt) return noRt;
        // The Worker says the Runtime DO is older than the deploy: the restart recycles it and boots the newest
        // image from image + newest archive. Writes since that archive would be lost, so take one first (N8).
        // An archive that failed or did not finish in time refuses the restart (409): the new image would boot from
        // an older archive. `hard` (the owner accepted losing recent writes) skips the wait.
        const redeploy = r.body.redeploy === true;
        const archive = redeploy
          ? r.body.hard === true
            ? "skipped"
            : await this.archiveBeforeRestart()
          : undefined;
        if (archive === "failed" || archive === "timeout" || archive === "stalled")
          return {
            status: 409,
            body: {
              error: `pre-restart archive ${archive === "failed" ? "failed" : archive === "stalled" ? "made no progress for 90 s" : "not done in 5 min"}`,
              redeploy,
              archive,
            },
          };
        const s = await rt.ownerStop();
        const start = await rt.ownerStart();
        return { status: 200, body: { stop: s, start, ...(redeploy ? { redeploy, archive } : {}) } };
      }
      case "sleep": {
        if (!rt) return noRt;
        const force = r.query.force === "1" || r.body.force === true;
        const out = await rt.sleepNow({ force });
        return { status: out.ok ? 200 : 409, body: out };
      }
      case "epoch": {
        if (r.sub[0] !== "roll" || r.method !== "POST") return { status: 404, body: { error: "not found" } };
        // M2 rolls code only, with the live image map. A different image key needs its digest (M6 cutover);
        // without it the map has no such key → refused (§21 #33).
        const key = typeof r.body.imageKey === "string" ? r.body.imageKey : null;
        const digest = typeof r.body.digest === "string" ? r.body.digest : null;
        if (key && ep && key !== ep.image_key && !digest)
          return { status: 409, body: { error: "image-key-missing", imageKey: key } };
        const out = await this.roll(
          key && digest ? { imageKey: key, digest, codeVersion: c.codeVersion } : undefined,
        );
        return { status: out.ok ? 200 : 409, body: out };
      }
      case "restore":
        return await this.opsRestore(r.body);
      case "secrets-changed": {
        // The CLI calls this after `wrangler secret put`. The Worker env of this request is the newest one the
        // CLI can reach; `have` lists the adapter secrets it holds, so the CLI can retry until a new value shows.
        if (r.method !== "POST") return { status: 404, body: { error: "not found" } };
        const have = Object.entries(c.secrets.platform ?? {})
          .filter(([, v]) => !!v)
          .map(([k]) => k);
        if (took.length) {
          driverRetryNow(c);
          void this.kickDriver();
        }
        const known = ADAPTERS.flatMap((a) => a.secrets);
        return { status: 200, body: { ok: true, took, have, known, botToken: !!c.secrets.botToken } };
      }
      case "inbox":
        if (r.sub[0] === "drop") {
          if (r.method !== "POST") return { status: 404, body: { error: "not found" } };
          return this.opsInboxDrop(r.body);
        }
        if (r.sub[0]) return { status: 404, body: { error: "not found" } };
        return {
          status: 200,
          body: {
            counts: counts(c),
            rows: inboxRows(c),
            hooks: Object.fromEntries(
              ADAPTERS.map((a) => [
                a.id,
                c.db.metaJson<{ at: number; kind: string } | null>(`hookSeen:${a.id}`, null),
              ]),
            ),
          },
        };
      case "events":
      case "logs": {
        const limit = Math.min(500, Number(r.query.limit ?? 200) || 200);
        return {
          status: 200,
          body: { events: c.db.all("SELECT * FROM ring ORDER BY id DESC LIMIT ?", limit) },
        };
      }
      case "alerts":
        return this.opsAlerts(r);
      case "snapshots": {
        // /ops/snapshots/prune: GET the plan; POST {ids} marks the allowed ids pruned before the CLI deletes tags.
        if (r.sub[0] === "prune") {
          if (r.method === "GET") return { status: 200, body: prunePlan(c) };
          if (r.method !== "POST") return { status: 404, body: { error: "not found" } };
          const ids = Array.isArray(r.body.ids)
            ? r.body.ids.filter((x): x is string => typeof x === "string")
            : [];
          return { status: 200, body: markPruned(c, ids) };
        }
        return r.method === "GET" && !r.sub[0]
          ? listSnapshots(c, r.query)
          : { status: 404, body: { error: "not found" } };
      }
      case "pairing":
        return opsPairing(c, r, this.pairingDeps());
      case "channels":
        return opsChannels(c, r, this.pairingDeps());
      case "caps": {
        if (!this.ledger) return { status: 503, body: { error: "no-ledger" } };
        if (r.method === "GET")
          return { status: 200, body: { ...this.ledger.capsView(), files: this.ledger.filesView() } };
        if (r.method !== "POST") return { status: 404, body: { error: "not found" } };
        try {
          return { status: 200, body: this.ledger.capsSet(r.body) };
        } catch (e) {
          return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      case "files":
        return this.opsFiles(r);
      case "import":
        return opsImport(c, r, () => this.wake("cli"));
      case "sandbox-set": {
        // POST /ops/sandbox/set {value}: the console's choice, kept over the deploy value (settings() in do.ts).
        // The boot plan reads it, so a restart applies it; no deploy is needed.
        const v = r.body.value;
        if (r.method !== "POST" || (v !== "on" && v !== "all" && v !== "off"))
          return { status: 400, body: { error: "value must be off, on or all" } };
        c.db.setMeta("sandboxChoice", v);
        ring(c, "settings", "sandbox", { value: v });
        return {
          status: 200,
          body: { ok: true, sandbox: v, applied: c.db.meta("sandboxBooted") === v, next: "restart" },
        };
      }
      case "telegram-int":
        return telegramInternal(c, r);
      case "soak-plan":
        return opsSoak(c, this.soakPort(), r);
      case "config":
        return this.opsConfig(r);
      case "settings": {
        if (r.method === "GET") {
          const v = r.query.ver;
          return viewSettings(c, v === undefined ? undefined : Number(v));
        }
        if (r.method !== "PUT" && r.method !== "POST") return { status: 404, body: { error: "not found" } };
        return putSettings(c, {
          doc: r.body.doc,
          set: r.body.set as Record<string, unknown> | undefined,
          baseVer: typeof r.body.baseVer === "number" ? r.body.baseVer : undefined,
          source: typeof r.body.source === "string" ? r.body.source : "ops",
        });
      }
      case "creds":
        return this.opsCreds(r);
      case "archive":
        return this.opsArchive(r);
      case "gc": {
        if (r.method === "GET") {
          try {
            return { status: 200, body: planGc(c) };
          } catch (e) {
            return { status: 503, body: { error: String(e) } };
          }
        }
        return { status: 200, body: await runGc(c, { dryRun: r.query.dry === "1" }) };
      }
      default:
        return { status: 404, body: { error: "not found" } };
    }
  }

  /**
   * /ops/archive (M4): GET index + cadence + request + last drill; POST {reason} asks for an archive now
   * (pre-upgrade, owner) and wakes the install; POST /drill runs the restore drill; GET|POST /gc archive GC.
   */
  private async opsArchive(r: OpsReq): Promise<OpsRes> {
    const c = this.c;
    const sub = r.sub[0] ?? "";
    if (sub === "" && r.method === "GET") {
      archiveStallCheck(c); // the deploy wait polls here: show a stalled request as failed at once
      return { status: 200, body: archiveStatus(c, Number(r.query.limit ?? 20) || 20) };
    }
    // GET /ops/archive/can-run?withinMs=: can an archive run now (deploy asks before it waits for one)?
    if (sub === "can-run" && r.method === "GET") {
      const rt = await this.rtStatus();
      const within = Math.max(0, Number(r.query.withinMs ?? 600_000) || 0);
      return { status: 200, body: archiveCanRun(c, rt, within) };
    }
    if (sub === "" && r.method === "POST") {
      const reason = String(r.body.reason ?? "owner");
      if (!["owner", "pre-upgrade", "post-rollback"].includes(reason))
        return { status: 400, body: { error: "reason must be owner, pre-upgrade or post-rollback" } };
      const req = requestArchive(c, reason);
      const woke = await this.wake("cli");
      return { status: 202, body: { ok: true, request: req, woke } };
    }
    if (sub === "drill" && r.method === "POST") {
      if (!this.ledger) return { status: 503, body: { error: "no-ledger" } };
      c.db.setMeta("drillTriedAt", c.now());
      const out = await runDrill(c, this.ledger, c.drill, {
        archiveId: typeof r.body.archiveId === "string" ? r.body.archiveId : undefined,
      });
      return { status: out.ok ? 200 : 409, body: out };
    }
    if (sub === "verify" && r.method === "POST") {
      if (!this.ledger) return { status: 503, body: { error: "no-ledger" } };
      return { status: 200, body: { verified: await verifyNewest(c, this.ledger) } };
    }
    if (sub === "gc") {
      if (r.method === "GET") return { status: 200, body: planArchiveGc(c) };
      return { status: 200, body: await runArchiveGc(c, { dryRun: r.query.dry === "1" }) };
    }
    return { status: 404, body: { error: "not found" } };
  }

  /**
   * /ops/restore (§19.2, C5): manual L5 source. Op `l5` (pending → chosen → boot → done at `started`).
   * N1 (M4b): `pitr:<ts>` (ISO or ms) picks the newest complete gen whose first upload is at or before ts; the
   * next boot restores every managed DB of that gen with `litestream restore -timestamp ts` (ctl/plan.ts) and
   * runs with cron off. The answer states the loss window (writes after ts). The install restarts (or wakes)
   * now unless `restart: false`.
   */
  private async opsRestore(b: Record<string, unknown>): Promise<OpsRes> {
    const c = this.c;
    const src = String(b.sqlite ?? "");
    if (b.acceptLoss !== true) return { status: 400, body: { error: "acceptLoss:true required" } };
    if (b.workspace === "reset") {
      // B1 owner escape: the next boot may start a gateway whose attested workspace is gone; ocsup clears the
      // attestation (OpenClaw seeds a new workspace) and alerts. Single-use (cleared at onStarted).
      c.db.setMeta("workspaceReset", { at: c.now() });
      alert(c, "workspace-reset-requested", "high", "owner accepted workspace loss");
      return { status: 202, body: { ok: true, workspace: "reset", note: "applies to the next boot" } };
    }
    const m = /^(pitr|archive):(.+)$/.exec(src);
    if (!m) return { status: 400, body: { error: "sqlite must be pitr:<ts> or archive:<id>" } };
    if (
      m[1] === "archive" &&
      !c.db.one("SELECT id FROM archives WHERE id = ? AND state = 'complete'", m[2] as string)
    )
      return { status: 404, body: { error: "no-archive" } };
    let pitr: { gen: number; ts: number } | null = null;
    if (m[1] === "pitr") {
      const raw = m[2] as string;
      const ts = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(ts) || ts > c.now()) return { status: 400, body: { error: "bad-timestamp" } };
      const g = pitrGen(c, ts);
      if (!g) return { status: 404, body: { error: "no-gen-covers", ts: new Date(ts).toISOString() } };
      pitr = { gen: g, ts };
    }
    const opId = `l5-${c.now()}`;
    openOp(c, opId, "l5", { source: src, ...(pitr ?? {}) }, "pending");
    // Pin every complete gen for 30 d: the L5 source and the gens it replaces (§13.4).
    for (const g of c.db.all<{ gen: number }>("SELECT gen FROM gens WHERE state IN ('complete', 'verified')"))
      pinGen(c, g.gen, c.now() + 30 * DAY);
    c.db.setMeta("l5", { opId, source: src, at: c.now(), ...(pitr ? { kind: "pitr", ...pitr } : {}) });
    alert(c, "l5-requested", "high", `owner restore ${src}`);
    if (getOp(c, opId)) c.db.run("UPDATE ops SET phase = 'chosen' WHERE op_id = ?", opId);
    if (!pitr)
      // guess: the boot side of the archive source is not built (arch F-d); the op stays at `chosen`.
      return { status: 202, body: { ok: true, opId, phase: "chosen", note: "archive L5 boot not built" } };
    const lossWindowMs = c.now() - pitr.ts;
    const iso = new Date(pitr.ts).toISOString();
    let restart: unknown = null;
    if (b.restart !== false) {
      const ep = activeEpoch(c);
      const rt = ep ? c.rt(ep.n) : null;
      if (rt) {
        try {
          const st = (await rt.status()).state;
          restart = RUNNING.includes(st as RtState)
            ? { stop: await rt.ownerStop(), start: await rt.ownerStart() }
            : { wake: await rt.requestWake("cli") };
        } catch (e) {
          restart = { error: String(e).slice(0, 200) };
        }
      }
    }
    ring(c, "l5", "pitr-chosen", { opId, gen: pitr.gen, ts: iso, lossWindowMs });
    return {
      status: 202,
      body: {
        ok: true,
        opId,
        phase: "chosen",
        source: src,
        gen: pitr.gen,
        ts: iso,
        lossWindowMs,
        lossWindow: `managed SQLite writes after ${iso} (${Math.round(lossWindowMs / 1000)} s before this request, and any made until the restart) are lost; workspace and other files are not rolled back`,
        cron: "off for the restore boot",
        restart,
      },
    };
  }

  private opsAlerts(r: OpsReq): Promise<OpsRes> | OpsRes {
    const c = this.c;
    if (r.method === "GET")
      return { status: 200, body: { alerts: listAlerts(c), outbox: outboxSize(c), sink: sinkInfo(c) } };
    if (r.sub[0] === "test" && r.method === "POST") {
      // W4: the CLI's code goes in the alert text; `alerts ack <code>` confirms it arrived.
      const t = alertTest(c, r.body.code);
      if (!t.ok) return { status: 400, body: { error: t.error } };
      return flushAlerts(c).then((x) => ({
        status: x.failed ? 502 : 200,
        body: { ...x, code: t.code, sink: sinkInfo(c) },
      }));
    }
    if (r.sub[0] === "ack" && r.method === "POST") return alertAck(c, r.body.code);
    // The console saves the sink here: the Worker cannot set its own secret.
    if (r.sub[0] === "sink" && r.method === "POST") return setAlertSink(c, r.body.url);
    if (r.sub[0] === "resolve" && r.method === "POST" && typeof r.body.class === "string") {
      resolveAlert(c, r.body.class);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: "not found" } };
  }

  private async opsConfig(r: OpsReq): Promise<OpsRes> {
    const c = this.c;
    if (r.method === "GET" && !r.sub.length) return { status: 200, body: { versions: configList(c) } };
    if (r.method === "GET" && r.sub[0]) {
      const row = getConfig(c, Number(r.sub[0]));
      return row
        ? { status: 200, body: { ...row, doc: pj(row.doc, {}) } }
        : { status: 404, body: { error: "no-version" } };
    }
    if (r.method === "POST" && !r.sub.length) {
      if (r.body.doc === undefined) return { status: 400, body: { error: "doc required" } };
      const out = await configPropose(c, {
        source: "owner",
        doc: r.body.doc,
        schemaSha: typeof r.body.schemaSha === "string" ? r.body.schemaSha : undefined,
        baseVer: typeof r.body.baseVer === "number" ? r.body.baseVer : undefined,
      });
      return out;
    }
    if (r.method === "POST" && r.sub[1] === "bad") {
      configMarkBad(c, Number(r.sub[0]));
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: "not found" } };
  }

  private async opsCreds(r: OpsReq): Promise<OpsRes> {
    const c = this.c;
    if (r.method === "GET" && !r.sub.length) return { status: 200, body: credManifest(c) };
    if (r.method === "GET" && r.sub[0] === "history" && r.query.path)
      return { status: 200, body: { history: credHistory(c, r.query.path) } };
    if (r.method === "POST" && r.sub[0] === "restore") {
      const path = String(r.body.path ?? "");
      const seq = Number(r.body.seq);
      if (!path || !Number.isInteger(seq)) return { status: 400, body: { error: "path and seq required" } };
      return credRestore(c, path, seq);
    }
    return { status: 404, body: { error: "not found" } };
  }

  // ---------------------------------------------------------------- journal access for tests and ops
  openOps() {
    return openOps(this.c);
  }
  finishOp(opId: string, state: "done" | "failed" | "aborted") {
    finishOp(this.c, opId, state);
  }
  snapshot(id: string) {
    return getSnapshot(this.c, id);
  }
}
