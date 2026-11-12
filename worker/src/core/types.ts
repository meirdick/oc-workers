// Shared types for the oc-host Worker (spec docs/08-control-plane-spec.md). No runtime imports here.
// Owners add their own sections; keep each section small and append-only.

// ---- Env (wrangler.jsonc §2.2) ----
export interface Env {
  CONTROL: DurableObjectNamespace;
  RUNTIME: DurableObjectNamespace;
  BUCKET: R2Bucket;
  CF_VERSION?: { id: string; tag?: string; timestamp?: string };
  OC_INST: string;
  OC_INSTANCE?: string;
  OC_SETTINGS?: string;
  OC_TEST?: string;
  OC_TIMERS?: string;
  /** R2 bucket name Litestream puts in the S3 path. One source for plan.replica.bucket and ReplicaGate. */
  OC_BUCKET?: string;
  /** Workers Browser binding (wrangler `browser`). CapGate only; absent in test groups. */
  BROWSER?: Fetcher;
  /** Workers AI binding (wrangler `ai`). Every model call and web search goes through it (gates/ai.ts); no token. */
  AI?: Ai;
  /** AI Gateway id the binding routes through (`default` is created on its first request). Empty → no gateway. */
  OC_AI_GATEWAY?: string;
  CONTROL_TOKEN?: string;
  CI_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBHOOK_SECRET_PREV?: string;
  /** Alert sink: ntfy topic URL or other HTTPS webhook (plan §9, D9). Unset → ring + /ops/status only. */
  ALERT_URL?: string;
  /** Optional bearer for the alert sink (token-protected ntfy topic). */
  ALERT_TOKEN?: string;
  /** Telegram bot token (OpenClaw SecretRef OC_TELEGRAM_BOT_TOKEN). The Worker uses it only for W8 setWebhook. */
  OC_SECRET_OC_TELEGRAM_BOT_TOKEN?: string;
  /** Inbox adapter secrets (ctl/adapters, `ochost channels add slack|discord|twilio`). The gateway sees them without the prefix. */
  OC_SECRET_OC_SLACK_BOT_TOKEN?: string;
  OC_SECRET_OC_SLACK_SIGNING_SECRET?: string;
  OC_SECRET_OC_DISCORD_BOT_TOKEN?: string;
  OC_SECRET_OC_DISCORD_PUBLIC_KEY?: string;
  OC_SECRET_OC_TWILIO_ACCOUNT_SID?: string;
  OC_SECRET_OC_TWILIO_AUTH_TOKEN?: string;
  /** Cloudflare Access front door (ochost auth access). Unset = off. See ingress/access.ts. */
  ACCESS_AUD?: string;
  ACCESS_TEAM?: string;
  ACCESS_DOMAIN?: string;
  ACCESS_WORKERS_DEV?: string;
  /** docs/12: SandboxSession DOs (`sb:<inst>`). Absent in older deploys → SandboxGate answers 503. */
  SANDBOX?: DurableObjectNamespace;
}

// ---- R2 subset the Control DO uses (real R2Bucket satisfies it; tests use a fake) ----
export interface BucketObj {
  key: string;
  size: number;
  uploaded?: Date;
}
export interface BucketLike {
  head(key: string): Promise<BucketObj | null>;
  get(key: string): Promise<(BucketObj & { text(): Promise<string> }) | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<BucketObj | null>;
  delete(keys: string | string[]): Promise<void>;
  list(o: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: BucketObj[]; truncated: boolean; cursor?: string }>;
}

// ---- Names ----
export type Mode = "prod" | "canary" | "files-only";
export type WakeReason = "webhook" | "cron" | "ui" | "cli" | "maint" | "inbox";
export type Severity = "info" | "warn" | "high";

/** Runtime DO states (spec §5.1). */
export type RtState =
  | "new"
  | "starting"
  | "waiting-capacity"
  | "backoff"
  | "running"
  | "maintenance"
  | "draining"
  | "quiescing"
  | "asleep"
  | "asleep-unconfirmed"
  | "stopping"
  | "stopped"
  | "retired";

export const AWAKE_STATES: readonly RtState[] = [
  "starting",
  "running",
  "maintenance",
  "draining",
  "quiescing",
  "stopping",
  "asleep-unconfirmed",
];

export const rtName = (inst: string, epoch: number) => `rt:${inst}:e${epoch}`;
export const ctlName = (inst: string) => `ctl:${inst}`;

// ---- Boot plan (gate §3, spec §8.3) ----
export type SqlitePlan =
  | { kind: "fresh" }
  | { kind: "marker"; markerId: string; snapshotId: string; gen: number; txid: Record<string, number> }
  | { kind: "gen"; gen: number; ts?: string | null; dbs?: string[] }
  | { kind: "archive"; archiveId: string; txid: Record<string, number> }
  | { kind: "restore-blocked"; reason: string; detail?: string };

export interface DbPlan {
  db: string;
  lastTxid: number;
  bytes: number;
  state: "uploaded" | "pending";
}

export interface BootPlan {
  v: 1;
  mode: Mode;
  inst: string;
  epoch: number;
  gen: number;
  /** at (L2): rootfs time the checkpoint clock counts from; absent = the boot start. */
  rootfs: { kind: "snapshot" | "image"; snapshotId?: string; digest?: string; at?: number };
  sqlite: SqlitePlan;
  archive: { archiveId: string; key: string; sha256: string; size: number } | null;
  dbs: DbPlan[];
  restoreGens: number[];
  runDoctor: boolean;
  lockMode: "auto" | "recover-lock" | "heartbeat-wait" | "none";
  configVer: number | null;
  pluginsVer: number | null;
  credsSeq: number | null;
  channelsOff: boolean;
  /** C1: newest shadow upload (ms), null = none in the last hour. ocsup runs a shadow round when older. */
  shadowAt?: number | null;
  overlay: { path: string; value?: unknown }[];
  replica: { bucket: string; prefix: string; tier: "normal" | "slow" | "slower"; seedGateMaxBytes: number };
  timers: { hbMs: number; fenceMs: number; startGateMs: number; restoreMs?: number };
  trustedProxies: string[];
  /** B1: where the workspace files come from. ocsup never boots a gateway whose attested workspace is gone. */
  workspace?: { source: "snapshot" | "archive" | "none"; acceptLoss?: boolean };
  managed: { path: string; value?: unknown }[];
  runtime: {
    maintenanceHour: number;
    tz: string;
    maxUptimeHours: number;
    heapAborts: number[];
    sleepMode: "auto" | "off";
    proactive: string;
  };
  /** N11: cron job classes ocsup leaves out of nextWakeAtMs (ctl/schedule.ts wakeIgnore). */
  wakeIgnore?: string[];
  /** Hours in which a job class may wake the install (ctl/schedule.ts wakeHours): heartbeat active hours. */
  wakeHours?: { heartbeat?: { from: number; to: number; tz: string } };
  /** docs/12: true → ocsup renders the OpenClaw sandbox keys (backend ochost at SandboxGate). */
  sandbox?: boolean;
  /** OpenClaw sandbox mode: `non-main` (default: every channel chat, Telegram included; not the Control UI chat) or `all`. */
  sandboxMode?: "non-main" | "all";
  /** Active Control UI origin (custom domain when Access is on, else workers.dev) → gateway.publicOrigin. */
  publicOrigin?: string;
  /** Every origin the Control UI may load from → gateway.controlUi.allowedOrigins. */
  allowedOrigins?: string[];
}

/** Ladder level the Runtime DO passes to beginBoot (spec §9.3). */
export type LadderLevel = 1 | 2 | 3 | 4 | "slow";

export interface BeginBootArgs {
  epoch: number;
  mode: Mode;
  opId: string;
  reason: string;
  replan?: boolean;
  ladder?: LadderLevel;
  /** Doctor forced by the Runtime DO (doctor-required, §8.5). */
  runDoctor?: boolean;
  /** §8.5 M6: Doctor failed DOCTOR_SKIP_AFTER times on this digest; a boot on it runs without Doctor. */
  skipDoctorDigest?: string;
  /** Snapshot ids the start op already missed (§15.2); excluded from rootfs choice. */
  missed?: string[];
  /** L3: the snapshot L1 used; L3 picks an older consistent one. */
  l1SnapshotId?: string;
  /** Maintenance rebase boot (§15.4): image + archive + gen. */
  rebase?: boolean;
  /** F3: the op missed snapshotReplanCap snapshots; plan without a snapshot (archive or restore-blocked). */
  noSnapshot?: boolean;
  /** O1: the deployed image map (`ctx.container` images); the epoch digest follows its entry. */
  liveImages?: Record<string, string>;
}

export interface BeginBootResult {
  gen: number;
  secret: string;
  restoreGens: number[];
  plan: BootPlan;
  digest: string;
  imageKey: string;
  snapshotId?: string;
  markerId?: string;
  /** Channel credentials adopted from the UI (ctl/adopt.ts): gateway env NAME → value, for the start env. */
  adoptedEnv?: Record<string, string>;
  error?: string;
}

/** Snapshot handle the Runtime DO saves (spec §10.2 phase 7, §15). */
export interface SnapshotHandle {
  id: string;
  size: number;
  digest: string;
  imageKey: string;
  gen: number;
  epoch: number;
  kind: "checkpoint" | "maint" | "planned" | "final" | "sleep";
  opId?: string;
  /** Snapshot the boot restored from (chain parent), if any. */
  parentId?: string | null;
}

// ---- Control DO → Runtime DO RPC (implemented by the Runtime DO) ----
export interface RtStatusLite {
  state: RtState;
  desired?: string;
  gen?: number;
  degraded?: boolean;
  blockers?: string[];
  awakeReason?: string;
  [k: string]: unknown;
}

/** Control DO `ownerView()`: what the owner status page at `/` shows (ingress/routes.ts). */
export interface OwnerView {
  inst: string;
  state: string;
  /** When the current state began (ms), null = unknown. */
  stateAt: number | null;
  lastActivityAt: number | null;
  /** Next scheduled wake (cron) while asleep, or the next cron while awake. */
  nextWakeAt: number | null;
  snapshots: number;
  alerts: { class: string; severity: string; at: number | null; open: boolean }[];
  now: number;
  /** Runtime DO `desired` (running, stopped, retired): `stopped` = the owner stopped it. */
  desired?: string | null;
  /** Runtime DO ladder lastClass: `restore-blocked:*` = every boot is refused until the owner acts. */
  ladderClass?: string | null;
}

export interface RuntimeRpc {
  /** spec §10.7. */
  requestWake(reason: WakeReason): Promise<{ state: RtState; action: string }>;
  /** spec §11.3. */
  ensure(): Promise<{ state: RtState }>;
  status(): Promise<RtStatusLite>;
  /** Replay one inbox row through getTcpPort(18789) (spec §12.3). */
  deliver(req: {
    path: string;
    body: string;
    headers: Record<string, string>;
    /** Routes without the durable header (Slack HTTP): a 2xx is the accept. */
    okIsDurable?: boolean;
    /** S0.10: not on the wake list: the accept is not activity. */
    quiet?: boolean;
  }): Promise<{
    status: number;
    durable: boolean;
    error?: string;
  }>;
  /** N7: restore probe of the running gen; verified null = no verdict. Optional: fakes may lack it. */
  verifyGen?(a: {
    gen: number;
    dbs: string[];
    timeoutMs?: number;
  }): Promise<{ verified: boolean | null; why: string | null }>;
  /** /ops/sleep: run the sleep gate now; force skips rules 3, 4, 7. */
  sleepNow(o: { force: boolean }): Promise<{ ok: boolean; reason?: string; opId?: string }>;
  ownerStart(): Promise<{ ok: boolean; state: RtState }>;
  ownerStop(): Promise<{ ok: boolean; state: RtState }>;
  retire(): Promise<{ settled: boolean; lastHbAt?: number }>;
}

// ---- Runtime DO → Control DO RPC (implemented by the Control DO; owner: runtime builder) ----
/** Instance size passed to start() (OC_INSTANCE, spec C6). */
export type InstanceSpec = string | { vcpu: number; memoryMib: number; diskMb: number };

/** Sleep gate inputs the Control DO owns (spec §10.1 rules 1, 5, 9; §11.2 oldestHeld). */
export interface SleepInputs {
  /** settings.sleep.mode */
  mode: "auto" | "off";
  /** settings.sleep.idleMinutes in ms (adaptive idle base). */
  idleBaseMs?: number;
  /** settings.sleep.minAwakeMinutes in ms. */
  minAwakeMs?: number;
  /** Rule 1 blockers: socket/unknown channels, event jobs, seeding, live channel status. */
  blockers: string[];
  /** Rule 5: non-held pending rows + accepted rows not replicated. */
  inboxBusy: number;
  /** Rule 9 (§16.1). */
  costOk: boolean;
  costWhy?: string;
  /** Oldest held inbox row received_at, for maintenanceDue (§11.2). */
  oldestHeldAt?: number | null;
}

export interface MarkerPendingArgs {
  opId: string;
  gen: number;
  epoch: number;
  digest: string;
  txid: Record<string, number>;
  bytes: Record<string, number>;
  lastWriteAt: Record<string, number | null>;
}

export interface StartedArgs {
  epoch: number;
  gen: number;
  opId: string;
  reason: string;
  digest: string;
  snapshotId?: string | null;
  wakeAt: number;
  aliveMs: number | null;
  startupzMs: number;
  /** Doctor ran in this boot and the boot reached started (so it passed). */
  doctorRan?: boolean;
}

export interface SleptArgs {
  gen: number;
  sleptAt: number;
  snapshotBytes: number | null;
  sleepMs: number;
  cpuS: number | null;
}

export interface ControlForRuntime {
  /** Settings document values the Runtime DO applies (ctl/settings.ts). Optional: fakes may lack it. */
  settingsView?(): Promise<{ ver: number; t: Record<string, number>; rt: Record<string, number> }>;
  /** Epoch row status; "none" if unknown. */
  epochStatus(epoch: number): Promise<{ status: "active" | "retiring" | "retired" | "none" }>;
  /** spec §8.2. Idempotent by opId. */
  beginBoot(a: BeginBootArgs): Promise<BeginBootResult>;
  /** Start op ended without `started` (gen → abandoned unless complete). */
  endBoot(a: { gen: number; opId: string; why: string }): Promise<void>;
  /** spec §8.6 on-started: config good, initialized, install marker, wake log row, snapshot last_restored_at,
   * inbox driver bootStarted(gen). */
  onStarted(a: StartedArgs): Promise<void>;
  /** Close the wake log row (§16.2). */
  onSlept(a: SleptArgs): Promise<void>;
  /** Save a snapshot handle (§15). Must be durable before it returns. */
  snapshotSaved(h: SnapshotHandle): Promise<void>;
  /** §15.2: first miss → suspect, second → bad. */
  snapshotMiss(id: string): Promise<{ state: "suspect" | "bad" | "unknown" }>;
  /** §6.4. Idempotent by opId. */
  markerPending(a: MarkerPendingArgs): Promise<{ id: string }>;
  markerValid(a: { id: string; snapshotId: string }): Promise<void>;
  markerVoid(a: { id: string; reason: string }): Promise<void>;
  /** §10.2 phase 6: mark `replicated` every accepted row with accepted_at ≤ upTo. */
  markReplicated(a: { upTo: number }): Promise<{ count: number }>;
  /** Non-held pending inbox rows (edge check, §10.2 flags). */
  inboxPending(): Promise<number>;
  sleepInputs(): Promise<SleepInputs>;
  /** §9.3: R2 probe rows all ok since `since`, and a hello proof served for this gen. */
  bootHealthy(a: { gen: number; since: number }): Promise<boolean>;
  /** Maintenance op R2 probe (§11.4). */
  r2Probe(): Promise<{ ok: boolean; ms?: number; err?: string }>;
  /** §9.4: retire this epoch and flip to N+1 with the same image key and digest. */
  reslot(a: { epoch: number; why: string }): Promise<{ ok: boolean; epoch?: number }>;
  alert(a: { class: string; severity: Severity; detail?: string }): Promise<void>;
  ring(a: { src: string; kind: string; detail?: unknown }): Promise<void>;
  /** Runtime state on each transition (inbox `held`, wake retry). Optional: fire-and-forget. */
  noteRtState?(epoch: number, state: RtState): Promise<void> | void;
  /** Heartbeat fields the Control DO keeps (cpuS, channels, eventJobs, telegramSecretVersion, rpo). */
  noteHeartbeat?(h: {
    gen: number;
    cpuS?: number | null;
    telegramSecretVersion?: number | null;
    channels?: { channel: string; account: string; transport?: string; lifecycle?: string }[];
    rpo?: string | null;
    eventJobs?: { id: string; kind: string; name?: string }[];
  }): Promise<void> | void;
  /** A doctor-required exit (§8.5): the next plan runs Doctor. */
  noteDoctorRequired?(epoch: number): Promise<void> | void;
  /** §11.2 asleep alarm plan (lead from the wake log, maintenance hour, TTL guard). Optional. */
  wakePlan?(x: { nextWakeAtMs: number | null; lastWakeAt?: number | null }): Promise<{
    wakeAt: number;
    reason: "cron" | "maint" | "ttl";
    leadMs: number;
  }>;
}

/** ControlGate → Runtime DO RPC (implemented by the Runtime DO). */
export interface RuntimeGateRpc {
  /** Heartbeat body (contract HeartbeatReq). Returns the Runtime part of the ack. */
  onHeartbeat(body: Record<string, unknown>): Promise<{ ok: boolean; gen: number | null; stop?: boolean }>;
  /** Event body (contract EventReq). */
  onEvent(body: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** /v1/final-snapshot (§17.2). status 409 with error "done" on a second call. */
  finalSnapshot(body: Record<string, unknown>): Promise<{
    status: number;
    ok: boolean;
    snapshotId?: string;
    error?: string;
  }>;
  /** Gen check for the gates (§13.2): the persisted boot of this epoch. */
  currentBoot(): Promise<{ gen: number | null; mode: Mode | null; epochStatus: string; state: RtState }>;
  /** /v1/boot bound the iid (identity check uses it). */
  bootBound(a: { gen: number; iid: string }): Promise<void>;
}
