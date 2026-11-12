// Control-plane contract between ocsup (container) and the Worker gates (ControlGate, ReplicaGate).
// Single source of truth for M1 (ocsup) and M2 (Worker). Doc: docs/07-gate-contract.md.
// Plain ESM, no deps. Shapes are small JSON-schema-like objects checked by validate().
// Change rules: add fields as optional; bump PV only for a breaking change; keep the doc in step.

/** Protocol version ocsup speaks. The gate answers the list it accepts in /v1/hello. */
export const PV = 1;

export const GATE = Object.freeze({
  control: "http://15.0.0.1",
  replica: "http://15.0.0.2",
  replicaProxy: "http://127.0.0.1:18790",
});

export const HDR = Object.freeze({
  secret: "x-ocrt-secret",
  iid: "x-ocrt-iid",
  sha256: "x-ocrt-sha256",
  seq: "x-ocrt-seq",
  /** Hello MAC (sec F5): HMAC(bootSecret, helloMacMessage(plane, challenge)). The gate does not rate-limit it. */
  helloMac: "x-ocrt-hello-mac",
});

/** HMAC-SHA256 domain prefixes (key = bootSecret). Output hex. */
export const DOMAIN = Object.freeze({
  hello: "oc-hello\0",
  replicaHello: "oc-rhello\0",
  replicaKey: "oc-replica\0",
  helloMac: "oc-hello-mac\0",
});

/** Message for the hello MAC. plane: "control" | "replica". */
export const helloMacMessage = (plane, challenge) => `${DOMAIN.helloMac}${plane}\0${challenge}`;

export const replicaAccessKeyId = (gen, iid) => `ocrt-g${gen}-${iid}`;
/** Message for the replica secret: HMAC(bootSecret, replicaKeyMessage(gen, iid)). */
export const replicaKeyMessage = (gen, iid) => `${DOMAIN.replicaKey}${gen}\0${iid}`;

// ---------------------------------------------------------------------------------------------
// Exit codes and reasons (plan §5.5, amendments §2 row 19, §3)

export const EXIT = Object.freeze({ ok: 0, supervisor: 70, blocked: 75, fenced: 77, config: 78 });

/** reason -> exit code. Reasons with a `:` suffix family are listed in full. */
export const EXIT_REASONS = Object.freeze({
  sigterm: 0, // drain done (any phase)
  stopped: 0, // planned stop quiesced and the DO destroyed nothing yet (not used by v1; reserved)
  supervisor: 70,
  "reap-failed:cgroup": 70,
  "reap-failed:uid1000": 70,
  "reap-failed:listen": 70,
  "reap-failed:dstate": 70, // D-state pids left after the 30 s D cap (lib/reaper.mjs)
  "gateway-crash-loop": 70,
  "netfilter-failed": 70, // owner-match nft rule not applied; ocsup stops before any network use (F-SEC-2)
  "restore-blocked:infra": 75,
  "restore-blocked:mismatch": 75,
  "restore-blocked:schema": 75,
  "restore-blocked:rewound": 75,
  "restore-timeout": 75, // M3 F1: a restore step passed its share of plan.timers.restoreMs; DO: next ladder step // spec 08 C24: Control DO below the R2 hwm; the DO never starts this plan
  "replica-blocked:infra": 75,
  "replica-blocked:local": 75,
  "replica-down:infra": 75,
  "replica-down:local": 75,
  "auto-restart": 75,
  "sqlite-corrupt": 75, // M4b: quick_check failed at boot or after a gateway exit (DO: SQLite evidence, l5-pending)
  "disk-full": 75, // guess: plan §4.12 names the class, not the code
  stale: 77,
  "config-blocked": 78,
  "doctor-failed": 78,
  "doctor-required": 78, // gateway exit 78 (maintenance_required) -> at once, no restart (amend §2 row 19)
  ownership: 78,
  "lock-blocked": 78,
});

export function exitCodeFor(reason) {
  if (Object.hasOwn(EXIT_REASONS, reason)) return EXIT_REASONS[reason];
  if (/^sigterm(:|$)/.test(reason)) return 0;
  return EXIT.supervisor;
}

/** DO side: class of a monitor() exitCode + reason (plan §5.5). esc: may escalate the ladder. */
export function classifyExit(code, reason) {
  if (code === 0) return { cls: "planned-or-drain", esc: false };
  if (code === 137) return { cls: "oom?", esc: "evidence" };
  if (code === 134) return { cls: "heap-abort", esc: "evidence" };
  if (code === 77) return { cls: "fenced", esc: false };
  if (code === 70)
    return reason === "supervisor" ? { cls: "supervisor", esc: false } : { cls: "exit:70", esc: "evidence" };
  if (code === 75) {
    if (reason === "auto-restart") return { cls: "auto-restart", esc: false };
    if (reason === "disk-full") return { cls: "disk-full", esc: false };
    if (/:infra$/.test(reason || "")) return { cls: "infra", esc: false };
    if (reason === "restore-blocked:schema") return { cls: reason, esc: false };
    return { cls: reason || "exit:75", esc: true };
  }
  if (code === 78) return { cls: reason || "exit:78", esc: reason !== "doctor-required" };
  return { cls: `exit:${code}`, esc: "evidence" };
}

// ---------------------------------------------------------------------------------------------
// Mini schema validator. Schema forms:
//   {t:"string", enum?, re?, max?}  {t:"int", min?, max?}  {t:"num"}  {t:"bool"}  {t:"any"}
//   {t:"obj", req?:[...], p:{k:schema}, extra?:true}  {t:"arr", items, max?}  {t:"map", v:schema}
//   {t:"one", of:[schema...]}  any schema may add nullable:true

export function validate(schema, value, path = "$") {
  const errs = [];
  check(schema, value, path, errs);
  return errs;
}
export function assertValid(schema, value, what = "value") {
  const errs = validate(schema, value);
  if (errs.length) throw new Error(`${what} invalid: ${errs.slice(0, 5).join("; ")}`);
  return value;
}
function check(s, v, p, errs) {
  if (v === null && s.nullable) return;
  if (v === undefined) return errs.push(`${p}: missing`);
  switch (s.t) {
    case "any":
      return;
    case "string":
      if (typeof v !== "string") return errs.push(`${p}: want string`);
      if (s.enum && !s.enum.includes(v)) return errs.push(`${p}: not in [${s.enum.join(",")}]`);
      if (s.re && !s.re.test(v)) return errs.push(`${p}: bad format`);
      if (s.max !== undefined && v.length > s.max) errs.push(`${p}: longer than ${s.max}`);
      return;
    case "int":
      if (!Number.isInteger(v)) return errs.push(`${p}: want int`);
      if (s.min !== undefined && v < s.min) errs.push(`${p}: < ${s.min}`);
      if (s.max !== undefined && v > s.max) errs.push(`${p}: > ${s.max}`);
      return;
    case "num":
      if (typeof v !== "number" || !Number.isFinite(v)) errs.push(`${p}: want number`);
      return;
    case "bool":
      if (typeof v !== "boolean") errs.push(`${p}: want bool`);
      return;
    case "arr":
      if (!Array.isArray(v)) return errs.push(`${p}: want array`);
      if (s.max !== undefined && v.length > s.max) errs.push(`${p}: more than ${s.max} items`);
      for (let i = 0; i < v.length; i++) check(s.items, v[i], `${p}[${i}]`, errs);
      return;
    case "map":
      if (!v || typeof v !== "object" || Array.isArray(v)) return errs.push(`${p}: want object`);
      for (const [k, x] of Object.entries(v)) check(s.v, x, `${p}.${k}`, errs);
      return;
    case "obj": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return errs.push(`${p}: want object`);
      for (const k of s.req || []) if (v[k] === undefined) errs.push(`${p}.${k}: missing`);
      for (const [k, x] of Object.entries(v)) {
        const ps = s.p?.[k];
        if (ps) {
          if (x !== undefined) check(ps, x, `${p}.${k}`, errs);
        } else if (!s.extra) errs.push(`${p}.${k}: unknown field`);
      }
      return;
    }
    case "one": {
      for (const o of s.of) if (!validate(o, v, p).length) return;
      errs.push(`${p}: matches no variant`);
      return;
    }
    default:
      errs.push(`${p}: bad schema type ${s.t}`);
  }
}

// shorthands
const str = (o = {}) => ({ t: "string", ...o });
const int = (o = {}) => ({ t: "int", ...o });
const num = { t: "num" };
const bool = { t: "bool" };
const any = { t: "any" };
const obj = (p, req = [], o = {}) => ({ t: "obj", p, req, ...o });
const arr = (items, o = {}) => ({ t: "arr", items, ...o });
const map = (v) => ({ t: "map", v });
const nul = (s) => ({ ...s, nullable: true });
const lit = (v) => str({ enum: [v] });

const RE = {
  hex64: /^[0-9a-f]{64}$/,
  iid: /^[0-9a-f]{32}$/,
  relpath: /^(state\/openclaw\.sqlite|agents\/[^/\0]{1,128}\/agent\/openclaw-agent\.sqlite)$/,
  inst: /^[a-z0-9][a-z0-9-]{0,30}$/,
  credPath: /^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]{0,511}$/,
};
export const PATTERNS = RE;

export const MODES = ["prod", "canary", "files-only"];
export const ROOTFS_KINDS = ["snapshot", "image"];
/** plan.sqlite.kind (plan §6.2 step 6, §4.14; `snapshot` = keep the snapshot copy as is, files-only). */
export const SQLITE_KINDS = ["fresh", "marker", "gen", "archive", "snapshot", "restore-blocked"];
export const LOCK_MODES = ["auto", "recover-lock", "heartbeat-wait", "none"];
export const TIERS = ["normal", "slow", "slower"];
export const SYNC_INTERVAL = Object.freeze({ normal: "1s", slow: "10s", slower: "60s" });

// ---------------------------------------------------------------------------------------------
// ControlGate (15.0.0.1:80). Every route except /v1/hello needs HDR.secret; after /v1/boot also HDR.iid.
// Every request body carries the envelope {inst, epoch, gen, bootId}. 409 {error:"stale"} -> self-fence.

export const Envelope = obj(
  { inst: str({ re: RE.inst }), epoch: int({ min: 1 }), gen: int({ min: 1 }), bootId: str({ max: 64 }) },
  ["inst", "gen"],
);
const env = (p, req = []) => obj({ ...Envelope.p, ...p }, ["inst", "gen", ...req]);

export const HelloReq = obj({ challenge: str({ re: /^[0-9a-f]{32,128}$/ }), pv: int({ min: 0 }) }, [
  "challenge",
  "pv",
]);
export const HelloRes = obj({ proof: str({ re: RE.hex64 }), pv: arr(int()) }, ["proof", "pv"]);

export const DbPlan = obj(
  {
    db: str({ re: RE.relpath }),
    lastTxid: int({ min: 0 }),
    bytes: int({ min: 0 }),
    state: str({ enum: ["uploaded", "pending"] }),
  },
  ["db"],
);

export const SqlitePlan = {
  t: "one",
  of: [
    obj({ kind: lit("fresh") }, ["kind"]),
    obj(
      {
        kind: lit("marker"),
        markerId: str({ max: 64 }),
        snapshotId: str({ max: 128 }),
        gen: int({ min: 1 }),
        txid: map(int({ min: 0 })),
      },
      ["kind", "markerId", "snapshotId", "gen"],
    ),
    obj(
      {
        kind: lit("gen"),
        gen: int({ min: 1 }),
        ts: nul(str({ max: 40 })),
        dbs: arr(str({ re: RE.relpath }), { max: 32 }),
      },
      ["kind", "gen"],
    ),
    obj({ kind: lit("archive"), archiveId: str({ max: 128 }), txid: map(int({ min: 0 })) }, [
      "kind",
      "archiveId",
    ]),
    obj({ kind: lit("snapshot") }, ["kind"]),
    obj(
      {
        kind: lit("restore-blocked"),
        reason: str({ re: /^restore-blocked:(infra|mismatch|schema)$/ }),
        detail: str({ max: 500 }),
      },
      ["kind", "reason"],
    ),
  ],
};

export const BootPlan = obj(
  {
    v: int({ min: 1 }),
    mode: str({ enum: MODES }),
    inst: str({ re: RE.inst }),
    epoch: int({ min: 1 }),
    gen: int({ min: 1 }),
    rootfs: obj(
      // at (M4 L2): rootfs time the Runtime DO counts the checkpoint clock from.
      {
        kind: str({ enum: ROOTFS_KINDS }),
        snapshotId: str({ max: 128 }),
        digest: str({ max: 80 }),
        at: int({ min: 0 }),
      },
      ["kind"],
    ),
    sqlite: SqlitePlan,
    archive: nul(
      obj(
        {
          archiveId: str({ max: 128 }),
          key: str({ max: 512 }),
          sha256: str({ re: RE.hex64 }),
          size: int({ min: 0 }),
        },
        ["archiveId", "sha256"],
      ),
    ),
    dbs: arr(DbPlan, { max: 32 }),
    restoreGens: arr(int({ min: 1 }), { max: 16 }),
    runDoctor: bool,
    lockMode: str({ enum: LOCK_MODES }),
    configVer: nul(int({ min: 0 })),
    pluginsVer: nul(int({ min: 0 })),
    credsSeq: nul(int({ min: 0 })),
    channelsOff: bool,
    // M4 C1: newest shadow upload (ms); ocsup runs a shadow round at gateway start when it is older than 15 min.
    shadowAt: nul(int({ min: 0 })),
    overlay: arr(obj({ path: str({ max: 256 }), value: any }, ["path"]), { max: 64 }),
    replica: obj(
      {
        bucket: str({ max: 63 }),
        prefix: str({ max: 256 }),
        tier: str({ enum: TIERS }),
        seedGateMaxBytes: int({ min: 0 }),
      },
      ["bucket", "prefix"],
    ),
    timers: obj({
      hbMs: int({ min: 1000 }),
      fenceMs: int({ min: 1000 }),
      startGateMs: int({ min: 0 }),
      // Restore phase budget the DO enforces (spec 08 §8.6); ocsup ends each restore step before it.
      restoreMs: int({ min: 1000 }),
      // Test mode (harness): replication fault stages, defaults 5 s / 15 s / 10 min (plan §4.8).
      replicaFault: obj({ closeMs: int({ min: 0 }), stopMs: int({ min: 0 }), downMs: int({ min: 0 }) }),
    }),
    trustedProxies: arr(str({ max: 64 }), { max: 8 }),
    // Workspace source (spec 08 §8.3 B1). snapshot: the rootfs holds it; archive: files from plan.archive;
    // none: no source. acceptLoss: owner reset (an attested but missing workspace is re-seeded, alert).
    workspace: obj({ source: str({ enum: ["snapshot", "archive", "none"] }), acceptLoss: bool }, ["source"]),
    // Runtime guard settings (lib/maint.mjs, lib/proactive.mjs, lib/config.mjs). All optional.
    managed: arr(obj({ path: str({ max: 256 }), value: any }, ["path"]), { max: 32 }),
    // Hours in which a cron job class may wake the install (ocio sleep-read): the heartbeat's active hours.
    wakeHours: obj({
      heartbeat: obj({ from: int({ min: 0, max: 23 }), to: int({ min: 1, max: 24 }), tz: str({ max: 64 }) }, [
        "from",
        "to",
        "tz",
      ]),
    }),
    // docs/12: true → render the OpenClaw sandbox keys (backend ochost, SandboxGate 15.0.0.4).
    sandbox: bool,
    // Control UI origin: the custom domain when Access is on, else workers.dev; allowedOrigins = both.
    publicOrigin: str({ max: 256 }),
    allowedOrigins: arr(str({ max: 256 }), { max: 4 }),
    runtime: obj({
      maintenanceHour: int({ min: 0, max: 23 }),
      tz: str({ max: 64 }),
      maxUptimeHours: int({ min: 6, max: 72 }),
      heapAborts: arr(int(), { max: 32 }),
      sleepMode: str({ enum: ["auto", "off"] }),
      proactive: str({ re: /^(off|openclaw|\d{1,2}h@\d{2}-\d{2})$/ }),
    }),
  },
  ["v", "mode", "gen", "rootfs", "sqlite", "dbs", "runDoctor", "lockMode"],
  { extra: true },
);

export const BootReq = env(
  {
    iid: str({ re: RE.iid }),
    pv: int({ min: 0 }),
    hostname: str({ max: 255 }),
    hostnamePinned: bool,
    newBoot: bool,
    ocsup: str({ max: 64 }),
  },
  ["iid", "pv"],
);
export const BootRes = {
  t: "one",
  of: [
    obj({ status: lit("ok"), plan: BootPlan }, ["status", "plan"]),
    obj({ status: lit("reboot-detected") }, ["status"]),
  ],
};

export const DbHb = obj(
  {
    db: str({ re: RE.relpath }),
    localTxid: nul(int({ min: 0 })), // max TXID of local level-0 files
    remoteTxid: nul(int({ min: 0 })), // max level-0000 TXID the gate recorded (from the ack)
    lag: nul(int({ min: 0 })), // null = infinite (fault)
    lagSinceMs: nul(int({ min: 0 })),
    fault: nul(str({ max: 200 })),
  },
  ["db"],
);

export const SleepOpState = obj(
  {
    opId: str({ max: 128 }),
    phase: str({ enum: ["check", "prepare", "edge", "stop-gateway", "flush", "done", "resume"] }),
    state: str({ enum: ["running", "ok", "failed", "aborted", "interrupted:sigterm"] }),
    at: int(),
  },
  ["opId", "phase", "state"],
);

export const OCSUP_STATES = [
  "boot",
  "restore",
  "doctor",
  "lock",
  "replica",
  "gateway-start",
  "running",
  "gateway-restart",
  "seeding",
  "fenced",
  "replica-down",
  "quiescing",
  "asleep-ready",
  "resuming",
  "draining",
  "drained",
  "exit",
];

export const HeartbeatReq = env(
  {
    seq: int({ min: 0 }),
    phase: str({ enum: OCSUP_STATES }),
    draining: bool,
    fenced: bool,
    uptimeS: int({ min: 0 }),
    gateway: obj(
      {
        pid: int({ min: 0 }),
        uptimeMs: int({ min: 0 }),
        rss: nul(int()),
        startupz: bool,
        restarts15m: int({ min: 0 }),
        lastExit: nul(any),
      },
      [],
      { extra: true },
    ),
    litestream: obj(
      {
        pid: int({ min: 0 }),
        tier: str({ enum: TIERS }),
        dbs: arr(DbHb, { max: 32 }),
        restarts: int({ min: 0 }),
      },
      [],
      {
        extra: true,
      },
    ),
    mem: nul(any),
    disk: nul(obj({ usedPct: num, inodesPct: num }, [], { extra: true })),
    cpuS: nul(num),
    lastActivityAt: nul(int()),
    // spec 08 §23 (all optional, PV stays 1)
    telegramSecretVersion: nul(int({ min: 0 })),
    channels: arr(
      obj(
        {
          channel: str({ max: 64 }),
          account: str({ max: 128 }),
          transport: str({ max: 32 }),
          lifecycle: str({ max: 32 }),
          restartPending: bool,
        },
        ["channel"],
        { extra: true },
      ),
      { max: 64 },
    ),
    eventJobs: arr(obj({ id: str({ max: 128 }), kind: str({ max: 64 }), name: str({ max: 128 }) }, ["id"]), {
      max: 64,
    }),
    sleepOp: nul(SleepOpState),
    peers: arr(str({ max: 64 }), { max: 16 }),
    errors: arr(str({ max: 500 }), { max: 5 }),
    rpo: nul(str({ enum: ["ok", "seeding", "down"] })),
  },
  ["seq", "phase", "draining"],
);

export const DbRemote = obj(
  { l0MaxTxid: int({ min: 0 }), seeded: bool, bytes: int({ min: 0 }), lastWriteAt: nul(int()) },
  ["l0MaxTxid"],
);
export const ReplicaState = obj({ gen: int({ min: 1 }), dbs: map(DbRemote) }, ["gen", "dbs"]);

export const HeartbeatAck = obj(
  {
    ok: bool,
    at: int(),
    gen: int({ min: 1 }),
    tier: str({ enum: TIERS }),
    stop: bool,
    replica: nul(ReplicaState),
  },
  ["ok", "gen", "tier"],
  { extra: true },
);

export const EVENT_KINDS = [
  "sigterm",
  "drained",
  "gateway-starting",
  "gateway-exit",
  "startupz",
  "ingress-ready",
  "replica-set",
  "replica-down",
  "replica-up",
  "seeded",
  "self-fence",
  "unfence",
  "hostname-unpinned",
  "lock",
  "doctor",
  "config-held",
  "sleep-phase",
  "resume",
  "exit",
  "admission-close", // ingress closed: credsync down 60 s, replica fault +5 s (reason says which)
  "admission-open",
];
export const EventReq = env(
  {
    kind: str({ enum: EVENT_KINDS }),
    ts: int(),
    phase: str({ max: 40 }),
    code: nul(int()),
    reason: nul(str({ max: 200 })),
    unclean: nul(arr(str({ enum: ["litestream", "gateway", "creds"] }))),
    detail: any,
    // exit: the failed step's output tail (Doctor), at most 2048 bytes (M6 polish live).
    out: nul(str({ max: 2100 })),
  },
  ["kind", "ts"],
);
export const OkRes = obj({ ok: bool }, ["ok"], { extra: true });

export const ALERT_SEVERITY = ["info", "warn", "high"];
export const AlertReq = env(
  {
    class: str({ re: /^[a-z0-9:-]{1,64}$/ }),
    severity: str({ enum: ALERT_SEVERITY }),
    detail: str({ max: 2000 }),
    ts: int(),
  },
  ["class", "severity"],
);

export const FinalSnapshotReq = env({ kind: str({ enum: ["final"] }), unclean: nul(arr(str())) }, ["kind"]);
export const FinalSnapshotRes = obj(
  { ok: bool, snapshotId: nul(str({ max: 128 })), error: str({ max: 200 }) },
  ["ok"],
);
export const MaintSnapshotReq = env({ windowId: str({ max: 64 }) }, ["windowId"]);

export const LogReq = env({ lines: arr(str({ max: 4000 }), { max: 500 }) }, ["lines"]);
export const LOG_MAX_BODY = 256 * 1024;

export const CredPut = env(
  {
    seq: int({ min: 0 }),
    sha256: str({ re: RE.hex64 }),
    mode: int({ min: 0, max: 0o777 }),
    b64: str({ max: 2_700_000 }),
  },
  ["seq", "sha256", "mode", "b64"],
);
export const CredDel = env({ seq: int({ min: 0 }) }, ["seq"]);
export const CredManifest = obj(
  {
    seq: int({ min: 0 }),
    files: arr(
      obj(
        {
          path: str({ re: RE.credPath }),
          seq: int(),
          sha256: str({ re: RE.hex64 }),
          mode: int(),
          deleted: bool,
          size: int(),
        },
        ["path", "seq", "sha256"],
      ),
    ),
  },
  ["seq", "files"],
);
export const CredGetRes = obj(
  { path: str(), seq: int(), sha256: str({ re: RE.hex64 }), mode: int(), b64: str() },
  ["path", "sha256", "b64"],
);

export const ConfigGetRes = obj({ ver: int({ min: 0 }), schemaSha: str({ max: 80 }), doc: any }, [
  "ver",
  "doc",
]);
export const ConfigProposal = env(
  {
    source: str({ enum: ["ui", "doctor", "plugin", "migrate", "unknown"] }),
    sha: str({ re: RE.hex64 }),
    schemaSha: str({ max: 80 }),
    darkOrigin: bool,
    baseVer: int(),
    doc: any,
  },
  ["source", "sha", "doc"],
);

export const PluginManifest = obj(
  {
    ver: int({ min: 0 }),
    plugins: arr(
      obj({ id: str({ max: 128 }), spec: str({ max: 512 }), flags: arr(str({ max: 128 }), { max: 8 }) }, [
        "id",
        "spec",
      ]),
      {
        max: 64,
      },
    ),
  },
  ["ver", "plugins"],
);

export const ArchiveStart = env({ kind: str({ enum: ["online", "clean", "offline"] }), manifest: any }, [
  "kind",
]);
export const ArchiveStartRes = obj({ archiveId: str({ max: 128 }), key: str({ max: 512 }), partMax: int() }, [
  "archiveId",
]);
export const ArchiveComplete = env(
  { archiveId: str(), sha256: str({ re: RE.hex64 }), size: int({ min: 0 }), parts: int({ min: 1 }) },
  ["archiveId", "sha256", "size", "parts"],
);
export const ArchiveAbort = env({ archiveId: str() }, ["archiveId"]);
// `ochost import` (docs/10 §1.2): ocsup reports the outcome of the import request the heartbeat ack named.
export const IMPORT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ImportDone = env(
  {
    id: str({ re: IMPORT_ID_RE }),
    ok: bool,
    why: str({ max: 500 }),
    result: any,
  },
  ["id", "ok"],
);
// spec 08 §12.2, §23: wake allowlist export (owner Telegram user ids, allowed group chats).
export const WakeAllowReq = env(
  {
    userIds: arr(str({ max: 32 }), { max: 10_000 }),
    groupChatIds: arr(str({ max: 32 }), { max: 10_000 }),
    configVer: int({ min: 0 }),
  },
  ["userIds", "groupChatIds"],
);
export const ARCHIVE_PART_MAX = 16 * 1024 * 1024;
export const SHADOW_SINGLE_MAX = 64 * 1024 * 1024;

/**
 * Route table. body: request schema (JSON); raw: binary body; res: 2xx response schema.
 * auth: none | secret | secret+iid. once: per-boot or per-window limit noted for the gate.
 */
export const ROUTES = Object.freeze([
  { m: "POST", path: "/v1/hello", auth: "none", body: HelloReq, res: HelloRes, rate: "1/s" },
  {
    m: "POST",
    path: "/v1/boot",
    auth: "secret",
    body: BootReq,
    res: BootRes,
    once: "per gen (same iid repeats)",
  },
  { m: "POST", path: "/v1/heartbeat", auth: "secret+iid", body: HeartbeatReq, res: HeartbeatAck },
  { m: "POST", path: "/v1/event", auth: "secret+iid", body: EventReq, res: OkRes },
  { m: "POST", path: "/v1/alert", auth: "secret+iid", body: AlertReq, res: OkRes },
  { m: "POST", path: "/v1/log", auth: "secret+iid", body: LogReq, res: OkRes },
  { m: "GET", path: "/v1/replica/state", auth: "secret+iid", res: ReplicaState },
  {
    m: "POST",
    path: "/v1/final-snapshot",
    auth: "secret+iid",
    body: FinalSnapshotReq,
    res: FinalSnapshotRes,
    once: "per boot",
    timeoutMs: 120_000,
  },
  {
    m: "POST",
    path: "/v1/maint-snapshot",
    auth: "secret+iid",
    body: MaintSnapshotReq,
    res: FinalSnapshotRes,
    once: "per window",
  },
  { m: "GET", path: "/v1/creds/manifest", auth: "secret+iid", res: CredManifest },
  { m: "GET", path: "/v1/creds/:path", auth: "secret+iid", res: CredGetRes },
  { m: "PUT", path: "/v1/creds/:path", auth: "secret+iid", body: CredPut, res: OkRes },
  { m: "DELETE", path: "/v1/creds/:path", auth: "secret+iid", body: CredDel, res: OkRes },
  { m: "GET", path: "/v1/config/:ver", auth: "secret+iid", res: ConfigGetRes },
  { m: "PUT", path: "/v1/config/proposal", auth: "secret+iid", body: ConfigProposal, res: OkRes },
  { m: "GET", path: "/v1/plugins/manifest", auth: "secret+iid", res: PluginManifest },
  {
    m: "PUT",
    path: "/v1/plugins/manifest",
    auth: "secret+iid",
    body: env({ manifest: any }, ["manifest"]),
    res: OkRes,
  },
  { m: "POST", path: "/v1/archive/start", auth: "secret+iid", body: ArchiveStart, res: ArchiveStartRes },
  {
    m: "PUT",
    path: "/v1/archive/part",
    auth: "secret+iid",
    raw: true,
    query: ["archiveId", "n"],
    res: obj({ etag: str() }, ["etag"]),
  },
  { m: "POST", path: "/v1/archive/complete", auth: "secret+iid", body: ArchiveComplete, res: OkRes },
  { m: "POST", path: "/v1/archive/abort", auth: "secret+iid", body: ArchiveAbort, res: OkRes },
  { m: "GET", path: "/v1/archive/get", auth: "secret+iid", raw: true, query: ["archiveId"] },
  { m: "PUT", path: "/v1/shadow/:db", auth: "secret+iid", raw: true, rate: "1 per DB per 10 min" },
  { m: "POST", path: "/v1/export/:path", auth: "secret+iid", raw: true, modes: ["files-only"] },
  { m: "PUT", path: "/v1/wake-allow", auth: "secret+iid", body: WakeAllowReq, res: OkRes, modes: ["prod"] },
  { m: "GET", path: "/v1/import/bundle", auth: "secret+iid", raw: true, query: ["id"] },
  { m: "POST", path: "/v1/import/done", auth: "secret+iid", body: ImportDone, res: OkRes, modes: ["prod"] },
]);

export function routeFor(method, pathname) {
  for (const r of ROUTES) {
    if (r.m !== method) continue;
    const pre = r.path.split("/:")[0];
    if (
      r.path.includes("/:")
        ? pathname.startsWith(`${pre}/`) && pathname.length > pre.length + 1
        : pathname === r.path
    ) {
      // exact routes win over param routes with the same prefix
      const exact = ROUTES.find((x) => x.m === method && x.path === pathname);
      return exact || r;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// ReplicaGate (15.0.0.2:80). S3 subset for Litestream 0.5.17, path style, SigV4 with per-boot keys.

export const ReplicaHelloReq = obj({ challenge: str({ re: /^[0-9a-f]{32,128}$/ }) }, ["challenge"]);
export const ReplicaHelloRes = obj({ proof: str({ re: RE.hex64 }) }, ["proof"]);
export const REPLICA_HELLO_PATH = "/_ocrt/hello";
export const REPLICA_PROOF_MAX_AGE_MS = 5000;

/** S3 operations the gate serves. Anything else -> 501 NotImplemented. */
export const S3_OPS = Object.freeze([
  { op: "ListObjectsV2", m: "GET", q: "list-type=2", scope: "read" },
  { op: "GetObject", m: "GET", scope: "read" },
  { op: "HeadObject", m: "HEAD", scope: "read" },
  { op: "PutObject", m: "PUT", scope: "write", records: true },
  { op: "CreateMultipartUpload", m: "POST", q: "uploads", scope: "write" },
  { op: "UploadPart", m: "PUT", q: "partNumber&uploadId", scope: "write" },
  { op: "CompleteMultipartUpload", m: "POST", q: "uploadId", scope: "write", records: true },
  { op: "AbortMultipartUpload", m: "DELETE", q: "uploadId", scope: "write" },
  { op: "DeleteObject", m: "DELETE", scope: "write" },
  { op: "DeleteObjects", m: "POST", q: "delete", scope: "write" },
]);

export function s3OpOf(method, searchParams) {
  const q = (k) => searchParams.has(k);
  if (method === "GET") return q("list-type") ? "ListObjectsV2" : "GetObject";
  if (method === "HEAD") return "HeadObject";
  if (method === "PUT") return q("partNumber") && q("uploadId") ? "UploadPart" : "PutObject";
  if (method === "POST")
    return q("uploads")
      ? "CreateMultipartUpload"
      : q("uploadId")
        ? "CompleteMultipartUpload"
        : q("delete")
          ? "DeleteObjects"
          : null;
  if (method === "DELETE") return q("uploadId") ? "AbortMultipartUpload" : "DeleteObject";
  return null;
}

export const genPrefix = (inst, gen) => `r/${inst}/g${gen}/`;

/** Litestream 0.5.17 key: <prefix><relpath>/<level 4 hex>/<minTXID 16 hex>-<maxTXID 16 hex>.ltx */
const LTX_KEY = /^r\/([a-z0-9-]+)\/g(\d+)\/(.+)\/([0-9a-f]{4})\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/;
export function parseLtxKey(key) {
  const m = LTX_KEY.exec(key);
  if (!m) return null;
  return {
    inst: m[1],
    gen: Number(m[2]),
    db: m[3],
    level: Number.parseInt(m[4], 16),
    minTxid: Number.parseInt(m[5], 16),
    maxTxid: Number.parseInt(m[6], 16),
  };
}
export const ltxName = (minTxid, maxTxid) =>
  `${minTxid.toString(16).padStart(16, "0")}-${maxTxid.toString(16).padStart(16, "0")}.ltx`;

/**
 * Gate decision for one S3 request (pure; Worker and fakes share it).
 * props: {inst, gen, restoreGens[], mode}. Returns {allow, status?, why?, scope}.
 */
export function replicaAccess(props, op, key, prefixParam) {
  const spec = S3_OPS.find((o) => o.op === op);
  if (!spec) return { allow: false, status: 501, why: "op" };
  const own = genPrefix(props.inst, props.gen);
  const readable = [own, ...(props.restoreGens || []).map((g) => genPrefix(props.inst, g))];
  const target = op === "ListObjectsV2" ? prefixParam || "" : key || "";
  if (spec.scope === "write") {
    if (props.mode !== "prod") return { allow: false, status: 403, why: "mode", scope: "write" };
    if (op === "DeleteObjects") return { allow: true, scope: "write", checkEach: own };
    return target.startsWith(own)
      ? { allow: true, scope: "write" }
      : { allow: false, status: 403, why: "prefix", scope: "write" };
  }
  return readable.some((p) => target.startsWith(p))
    ? { allow: true, scope: "read" }
    : { allow: false, status: 403, why: "prefix", scope: "read" };
}

/**
 * File storage (docs/11 §8): the OpenClaw storage location `r2` lives under f/<inst>/, stable across gens. Same
 * per-gen key as the replica. Ops: Put, Get, Head, Delete, ListObjectsV2. No multipart: the ochost-storage plugin
 * sends one PUT per object (per-object cap, settings files.maxObjectMb).
 */
export const filesPrefix = (inst) => `f/${inst}/`;
export const FILES_OPS = Object.freeze([
  "PutObject",
  "GetObject",
  "HeadObject",
  "DeleteObject",
  "ListObjectsV2",
]);
/** A request in the files key space: a key, or a list prefix, under f/. */
export const isFilesTarget = (op, key, prefixParam) =>
  (op === "ListObjectsV2" ? prefixParam || "" : key || "").startsWith("f/");

/** Gate decision for one files request (pure). Returns {allow, status?, why?, scope}. */
export function filesAccess(props, op, key, prefixParam) {
  const spec = S3_OPS.find((o) => o.op === op);
  if (!spec || !FILES_OPS.includes(op)) return { allow: false, status: 501, why: "op" };
  const target = op === "ListObjectsV2" ? prefixParam || "" : key || "";
  const own = filesPrefix(props.inst);
  if (!target.startsWith(own) || (op !== "ListObjectsV2" && target.length === own.length))
    return { allow: false, status: 403, why: "prefix", scope: spec.scope };
  if (spec.scope === "write" && props.mode !== "prod")
    return { allow: false, status: 403, why: "mode", scope: "write" };
  return { allow: true, scope: spec.scope };
}

/** Seed classes (amend §1.6 S1). l0SeedBytes = bytes of the level-0 key with minTxid 1 in this gen. */
export function seedClass(parsed, bytes, state) {
  if (!parsed) return "other";
  if (parsed.level === 0 && parsed.minTxid === 1) return state.l0Seen ? "reseed" : "seed";
  if (parsed.level === 9) return "seed";
  if (
    parsed.level >= 1 &&
    parsed.level <= 3 &&
    state.compactSeedBytes + bytes <= 1.5 * (state.l0SeedBytes || 0)
  )
    return "seed";
  return "other";
}

// ---------------------------------------------------------------------------------------------
// ocsupctl: root-only unix socket, one JSON line in, one JSON line out.

export const OCSUPCTL_SOCK = "/run/ocrt/ocsupctl.sock";

export const CTL_OPS = Object.freeze({
  status: { mutating: false },
  logs: { mutating: false },
  "restart-gateway": { mutating: true },
  stop: { mutating: true }, // planned stop: returns at once, poll with stop-status
  "stop-status": { mutating: false },
  "sleep-check": { mutating: false, sleep: "check" },
  "sleep-prepare": { mutating: true, sleep: "prepare" },
  "sleep-cancel": { mutating: true, sleep: "edge" },
  "sleep-stop-gateway": { mutating: true, sleep: "stop-gateway" },
  "sleep-flush": { mutating: true, sleep: "flush" },
  "resume-after-sleep": { mutating: true, sleep: "resume" },
  "shadow-backup": { mutating: true },
  // M4 A4: rootfs bulk changed since args.sinceMs? (hourly dirty-only checkpoint, plan §4.12 "Dirty source")
  dirty: { mutating: false },
  archive: { mutating: true },
  // N7: restore probe of the current gen into a scratch dir (never the live DBs)
  "verify-gen": { mutating: false },
  fault: { mutating: false, test: true },
});

export const CtlReq = obj({ op: str({ enum: Object.keys(CTL_OPS) }), opId: str({ max: 128 }), args: any }, [
  "op",
]);
/** Error codes in {ok:false, error}. */
export const CTL_ERRORS = [
  "draining",
  "busy",
  "bad-request",
  "unknown-op",
  "wrong-phase",
  "sleep-unclean-exit",
  "sleep-flush-failed",
  "failed",
];
export const CtlRes = obj({ ok: bool, error: str({ enum: CTL_ERRORS }), detail: any }, ["ok"], {
  extra: true,
});

/** Sleep-phase result shapes (addendum §2.6, amend §3 row "T7e row 19"). */
export const SleepCheckRes = obj(
  {
    ok: bool,
    blockers: arr(obj({ kind: str({ max: 64 }), detail: any }, ["kind"])),
    nextWakeAtMs: nul(int()),
    eventJobs: arr(any),
    channels: arr(any),
  },
  ["ok", "blockers"],
  { extra: true },
);
export const SleepPrepareRes = obj(
  { ok: bool, status: str({ enum: ["ready", "busy"] }), retryAfterMs: nul(int()) },
  ["ok", "status"],
  { extra: true },
);
export const SleepStopRes = obj(
  {
    ok: bool,
    clean: bool,
    code: nul(int()),
    signal: nul(str()),
    ms: int(),
    openRows: int(),
    eventJobs: arr(any),
    nextWakeAtMs: nul(int()),
  },
  ["ok", "clean"],
  { extra: true },
);
export const SleepFlushRes = obj(
  {
    ok: bool,
    nextWakeAtMs: nul(int()),
    txidPerDb: map(int()),
    bytesPerDb: map(int()), // DB file size at flush (seed-gate set size, amend §1.6 S3), not uploaded bytes
    lastWriteAtPerDb: map(nul(int())),
    archive: nul(any),
  },
  ["ok", "txidPerDb"],
  { extra: true },
);

// ---------------------------------------------------------------------------------------------
// Status file (/var/lib/ocrt/status.json, root 0600) and boot.json (/run/ocrt/boot.json).

export const BootJson = obj({ gen: int(), epoch: int(), iid: str(), secretHash: str({ re: RE.hex64 }) }, [
  "gen",
  "epoch",
  "iid",
  "secretHash",
]);
export const StatusFile = obj(
  {
    pv: int(),
    inst: str(),
    gen: int(),
    epoch: int(),
    iid: str(),
    bootId: str(),
    phase: str({ enum: OCSUP_STATES }),
    updatedAt: str(),
  },
  ["pv", "phase", "updatedAt"],
  { extra: true },
);
