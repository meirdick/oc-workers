// ocsup wiring (plan §4, §6.2; add §2.6, §2.9; amend 06). The modules hold the rules; this file
// connects them to real processes, files and the gates. Entry: ../ocsup.mjs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Archiver, ensureUid1000Dir } from "./archive.mjs";
import { BIN, hardenPath } from "./bins.mjs";
import { capTarget, FILES_PROXY_PORT, FILES_TARGET, startCapProxy } from "./cap-proxy.mjs";
import { setupCgroups } from "./cgroups.mjs";
import { EXIT, exitCodeFor, GATE, genPrefix, OCSUPCTL_SOCK, PV, parseLtxKey } from "./contract.mjs";
import { restoreCreds } from "./creds-restore.mjs";
import { CredSync } from "./credsync.mjs";
import { reconcileCron } from "./cron-reconcile.mjs";
import { startCtlServer } from "./ctl.mjs";
import { DiskWatch, isDiskFull } from "./diskwatch.mjs";
import { drain } from "./drain.mjs";
import { applyFault, takeFaults } from "./faults.mjs";
import { ensureFilesMarker, FILES_KEY_NAME, writeFilesKey } from "./files.mjs";
import { createGate } from "./gate.mjs";
import {
  buildCommand,
  CF_CA,
  cliNodeArgs,
  createGateway,
  gatewayEnv,
  nonDumpable,
  secretRefNames,
  UNPRELOAD,
} from "./gateway.mjs";
import { createRuntimeGuard, makeHeapReader, openclawCli } from "./guard.mjs";
import { configStep, doctorStep, netfilterStep, startConfigWatch } from "./guard-boot.mjs";
import { createHeartbeat } from "./heartbeat.mjs";
import { createImporter } from "./importer.mjs";
import { newIid, pinHostname, readBootIdentity, stepPidCounter, writeBootJson } from "./identity.mjs";
import { ADMIT_HOLD_CAP_MS, Litestream } from "./litestream.mjs";
import { LOCK_READER, runLockStep } from "./lock.mjs";
import { createLog, createStatusWriter } from "./log.mjs";
import { dbId, legacyMetaPath, metaPathFor } from "./ls-config.mjs";
import { faultStage } from "./ls-lag.mjs";
import {
  classifyDbs,
  markerCheck,
  pendingCheck,
  prestartWipe,
  restoreGen,
  verifyGen,
} from "./ls-restore.mjs";
import { MarkerGuard } from "./marker.mjs";
import { gateNets } from "./netfilter.mjs";
import { runOcio, tracked } from "./ocio-run.mjs";
import { applySupervisorOom } from "./oom.mjs";
import { planSteps, RESTORE_STEPS, restoreDeadlineMs, seedCapMs } from "./plan.mjs";
import { identity } from "./procs.mjs";
import { reap, termGatewayTree } from "./reaper.mjs";
import { startReplicaProxy } from "./replica-proxy.mjs";
import { fixRootOwners } from "./rootfs.mjs";
import { listKeys } from "./s3.mjs";
import { Shadow, shadowDue } from "./shadow.mjs";
import { channelsFromCli, createSleepOps } from "./sleep.mjs";
import { sqliteCheck } from "./sqlite-check.mjs";
import { exportWakeAllow } from "./wake-allow.mjs";
import { createWarmup, warmupMode } from "./warmup.mjs";
import { workspaceRestore, workspaceStep } from "./workspace.mjs";

const SKILL_SRC = "/opt/ocrt/skills/oc-workers-cloudflare/SKILL.md";

const RELOAD_LINE = /config change detected; evaluating reload/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export async function main() {
  const T0 = Date.now() - Math.round(process.uptime() * 1000);
  hardenPath(); // F-SEC-1: before any spawn (ocsup.mjs does it too)
  const SRC = { ...process.env };
  const C = {
    inst: SRC.OCRT_INST || "m1",
    epoch: num(SRC.OCRT_EPOCH, 1),
    gen: num(SRC.OCRT_GEN, 1),
    secret: SRC.OCRT_BOOT_SECRET || "",
    snapshotId: SRC.OCRT_SNAPSHOT_ID || null,
    state: SRC.OCRT_STATE || "/home/node/.openclaw",
    varDir: SRC.OCRT_VAR_DIR || "/var/lib/ocrt",
    runDir: SRC.OCRT_RUN_DIR || "/run/ocrt",
    gate: (SRC.OCRT_GATE_URL || GATE.control).replace(/\/+$/, ""),
    replica: (SRC.OCRT_REPLICA_URL || GATE.replica).replace(/\/+$/, ""),
    hostname: SRC.OCRT_HOSTNAME || "localhost",
    hbMs: num(SRC.OCRT_HB_MS, 30_000),
    fenceMs: num(SRC.OCRT_FENCE_MS, 150_000),
    jemalloc: SRC.OCRT_JEMALLOC !== "0",
    // No --auth flag: it overrides gateway.auth.mode, so the rendered trusted-proxy mode never applied
    // (M3 e2e: Control UI WS → 1008 token_missing). Mode comes from the rendered config.
    gwArgs: (SRC.OCRT_GW_ARGS || "--allow-unconfigured --bind lan --port 18789").split(/\s+/),
    testOps: SRC.OCRT_TEST === "1" || !!SRC.OCRT_TEST_FAKE_BOOT_ID,
    // Test-only Litestream knobs (harness H2, H3): level overrides and the M0 meta layout.
    lsLevels: {
      ...(SRC.OCRT_LS_LEVELS ? { levels: SRC.OCRT_LS_LEVELS.split(",") } : {}),
      ...(SRC.OCRT_LS_L0_RETENTION ? { l0Retention: SRC.OCRT_LS_L0_RETENTION } : {}),
      ...(SRC.OCRT_LS_L0_RETENTION_CHECK ? { l0Check: SRC.OCRT_LS_L0_RETENTION_CHECK } : {}),
    },
    lsLegacyMeta: SRC.OCRT_LS_LEGACY_META === "1",
    lsAdmitHold: SRC.OCRT_LS_ADMIT_HOLD !== "0",
    lsStopHold: SRC.OCRT_LS_STOP_HOLD === "1", // off by default until the sleep and drain tests ran with it
    fakeBootId: SRC.OCRT_TEST_FAKE_BOOT_ID || "",
    cg: "/sys/fs/cgroup",
  };
  // Infra vars leave ocsup's own env; children get explicit envs only (plan §4.2 "Rules").
  for (const k of Object.keys(process.env))
    if (k.startsWith("OCRT_") || k.startsWith("OC_") || k.startsWith("AWS_")) delete process.env[k];
  process.umask(0o077);
  fs.mkdirSync(C.varDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(C.runDir, { recursive: true, mode: 0o700 });
  // 0711: uid-1000 Litestream reaches its own config and meta dir by path; no listing (files stay 0600).
  fs.chmodSync(C.varDir, 0o711);
  fs.chmodSync(C.runDir, 0o711);

  const L = createLog({ file: path.join(C.varDir, "ocsup.log"), t0: T0 });
  const log = L.log;
  // Demo cutover 2026-11-05: "/" owned by uid 2346 on CF failed Doctor (exit 78). Before any uid-1000 child.
  const rootfs = fixRootOwners();
  if (rootfs.fixed.length) log("rootfs-owner", { level: "warn", fixed: rootfs.fixed });
  const writeStatusFile = createStatusWriter(path.join(C.varDir, "status.json"));
  const iid = newIid();
  const S = {
    pv: PV,
    inst: C.inst,
    epoch: C.epoch,
    gen: C.gen,
    iid,
    bootId: "",
    phase: "boot",
    phases: {},
    steps: [],
    plan: null,
    fenced: false,
    draining: false,
    exit: null,
    faults: [],
    seeding: false,
    rpo: "ok",
    lastConfigWriteAt: null,
    lastConfigReloadAt: null,
    lastActivityAt: null,
  };
  let phaseStart = Date.now();
  let sigtermSeen = false;
  let exiting = false;
  let hbOff = false;
  let prestartChild = null;
  let hangSigterm = false;
  let plan = null;
  let ls = null;
  let ctl = null;
  let proxy = null;
  let capProxy = null;
  let filesProxy = null;
  let CG = {};
  let hb = null;
  let guard = null;
  let sleepOps = null;
  let creds = null;
  let shadow = null;
  let archiver = null;
  let importer = null; // `ochost import` (lib/importer.mjs), prod mode only
  // A heartbeat ack can name the request before the importer exists (first heartbeats of a wake, live check
  // oc-m9-import): keep it and kick it when the importer is made. The Control DO hands it out once per take.
  let pendingImport = null;
  let disk = null;
  let cw = null; // config watcher
  let heapFault = null; // test fault `heap <pct>`
  const marker = new MarkerGuard();
  const bootCtx = {}; // guard-boot steps (config, doctor, config watch)
  // Auth mode of the rendered config. None (no config version) → `--auth token` as before; trusted-proxy →
  // the local password env for ocsup's own CLI calls (M3 e2e).
  const renderedAuthMode = () => bootCtx.cfg?.rendered?.doc?.gateway?.auth?.mode ?? null;
  const localPassword = () => renderedAuthMode() === "trusted-proxy";
  const dbsRemote = {}; // rel -> l0MaxTxid recorded by the gate

  const status = () => ({
    ...S,
    updatedAt: new Date().toISOString(),
    uptimeS: Math.round(process.uptime()),
    gateway: gwStatus(),
    litestream: ls ? ls.status() : null,
    heartbeat: hb?.state,
    sleepOp: sleepOps?.state() ?? null,
    proxy: proxy?.state ?? null,
    creds: creds?.status() ?? null,
    disk: disk?.last ?? null,
    admission: admission.state(),
    errors: L.errors(),
  });
  const writeStatus = () => writeStatusFile(status());
  function setPhase(p) {
    const now = Date.now();
    S.phases[S.phase] = (S.phases[S.phase] || 0) + (now - phaseStart);
    phaseStart = now;
    S.phase = p;
    log("phase", { phase: p });
    writeStatus();
  }
  async function finish(code, reason, { notify = true, detail, out } = {}) {
    if (exiting) return;
    exiting = true;
    S.exit = { code, reason, detail: detail ?? null, t: Date.now() - T0 };
    setPhase("exit");
    log("exit", { code, reason, detail });
    // Detail goes to the ring too (M3 e2e: a 0.4 s restore-blocked:infra exit left no trace off the box).
    const d = detail === undefined || detail === null ? {} : { detail: String(detail).slice(0, 300) };
    // M6 polish live: "doctor exit 1" alone was not diagnosable; the step's output tail goes with it.
    if (out) d.out = String(out).slice(-2048);
    if (notify && gate.proven) await gate.event("exit", { code, reason, ...d }, 2000);
    creds?.stop();
    ctl?.close();
    proxy?.close();
    capProxy?.close();
    filesProxy?.close();
    process.exit(code);
  }
  const fail = (reason, detail, out) => finish(exitCodeFor(reason), reason, { detail, out });

  // ---- 1. identity, hostname, cgroups, oom ----
  if (C.fakeBootId) {
    const f = path.join(C.runDir, "fake_boot_id");
    fs.writeFileSync(f, `${C.fakeBootId}\n`, { mode: 0o444 });
    fs.chmodSync(f, 0o444);
    const r = spawnSync(BIN.mount, ["--bind", f, "/proc/sys/kernel/random/boot_id"], { encoding: "utf8" });
    log("test-fake-boot-id", { ok: r.status === 0, err: r.stderr?.trim() });
  }
  const bid = readBootIdentity({ varDir: C.varDir });
  S.bootId = bid.bootId;
  S.newBoot = bid.newBoot;
  S.bootCount = bid.bootCount;
  log("start", {
    node: process.version,
    pid: process.pid,
    iid,
    gen: C.gen,
    epoch: C.epoch,
    inst: C.inst,
    ...bid,
  });
  S.hostname = pinHostname(C.hostname);
  log(S.hostname.pinned ? "hostname-pinned" : "hostname-unpinned", S.hostname);
  if (bid.newBoot) S.pidStep = stepPidCounter();
  const cg = setupCgroups({ delegate: [] });
  CG = cg.dirs || {};
  S.cgroups = { mode: cg.mode, why: cg.why ?? null, gwMax: cg.gwMax ?? null };
  log("cgroups", cg);
  S.oom = applySupervisorOom();
  // F-SEC-2: owner-match rule before any network use (gate boot, replica proxy, heartbeat). Fail closed:
  // no rule, no boot. The gate is not called (it is not proven yet); the exit code carries the reason.
  S.netfilter = netfilterStep({ log, nets: gateNets([C.gate, C.replica]) });
  if (!S.netfilter.ok) {
    const reason = "netfilter-failed";
    const detail = S.netfilter.err || `nft exit ${S.netfilter.code}`;
    S.exit = { code: exitCodeFor(reason), reason, detail, t: Date.now() - T0 };
    S.phase = "exit";
    log("exit", { level: "error", code: S.exit.code, reason, detail });
    writeStatusFile({ ...S, updatedAt: new Date().toISOString() });
    process.exit(S.exit.code);
  }
  writeBootJson(path.join(C.runDir, "boot.json"), { gen: C.gen, epoch: C.epoch, iid, secret: C.secret });

  // ---- 2. gate, heartbeat ----
  const gate = createGate({
    base: C.gate,
    secret: C.secret,
    iid,
    envelope: () => ({ inst: C.inst, epoch: C.epoch, gen: C.gen, bootId: S.bootId }),
    onStale: () => void selfFenceStale(),
  });
  let lastAckReplica = null;
  hb = createHeartbeat({
    gen: C.gen,
    fenceMs: C.fenceMs,
    send: (b) => gate.heartbeat(b),
    enabled: () => gate.proven && !hbOff && !exiting,
    body: () => hbBody(),
    onAck: (ack) => {
      if (ack.replica?.dbs) {
        lastAckReplica = ack.replica;
        for (const [db, v] of Object.entries(ack.replica.dbs)) setRemote(db, v.l0MaxTxid);
      }
      if (ls && ack.tier && ack.tier !== (ls.status().tier || "normal"))
        void ls.apply(ls.dbs, { tier: ack.tier });
      if (ack.import) {
        if (!importer) pendingImport = ack.import;
        else if (importer.kick(ack.import)) log("import-kick", { id: ack.import.id });
      }
    },
    onStale: () => void selfFenceStale(),
    onFence: () => void fence(),
    onUnfence: () => void unfence(),
    onStop: () => void onSigterm("stop"),
    log,
  });
  function guardHb() {
    try {
      const g = guard?.heartbeat();
      return g ? { mem: g.mem ?? null, cpuS: g.cpuS ?? null } : {};
    } catch {
      return {};
    }
  }
  function hbBody() {
    const g = gwStatus();
    return {
      phase: S.phase,
      draining: S.draining,
      fenced: S.fenced,
      uptimeS: Math.round(process.uptime()),
      gateway: {
        pid: g.pid,
        uptimeMs: g.uptimeMs,
        rss: null,
        startupz: g.startupz,
        restarts15m: g.restarts15m,
        lastExit: g.lastExit,
      },
      litestream: ls
        ? { pid: ls.pid(), tier: ls.status().tier || "normal", restarts: ls.restarts, dbs: ls.lag.report() }
        : undefined,
      sleepOp: sleepOps?.state() ?? null,
      lastActivityAt: S.lastActivityAt,
      errors: L.errors().map((e) => e.slice(0, 500)),
      rpo: S.seeding ? "seeding" : S.rpo,
      disk: disk?.hb() ?? null,
      ...guardHb(),
    };
  }

  // ---- 3. processes ----
  const trackedIds = () => new Set([...tracked].map((p) => identity(p)).filter(Boolean));
  const doReap = async (why) => {
    const r = await reap(why, { gwDir: CG.gw, tracked: trackedIds });
    log("reap", r);
    return r;
  };
  const cliEnvNow = () => {
    const e = gatewayEnv(SRC, {
      refs: S.secretRefs || [],
      caFile: CF_CA,
      localPassword: localPassword(),
      extra: { OCHOST_CLI_KEEP: "1" }, // M4b B1: the CLI's node self-respawn keeps the gateway password
    });
    // M4b B1: nodump.so would scrub the self-respawn's env at execve. Only the gateway tree gets that scrub.
    delete e.OCHOST_EXEC_SCRUB;
    return e;
  };
  const cliArgs = (args) => cliNodeArgs(args, fs.existsSync(UNPRELOAD) ? UNPRELOAD : null);
  /**
   * uid-1000 CLI child (role cli, oom +300) in the gateway cgroup, not tracked: reap() may kill it.
   * M5: same SecretRef env as the gateway (cliEnv, refs from the rendered config), and the same preload, so
   * the CLI's own children (npm for plugins, doctor) are scrubbed like the gateway's.
   */
  function runCli(args, { timeoutMs = 60_000, env } = {}) {
    const [cmd, argv] = buildCommand({
      cmd: BIN.node,
      args: cliArgs(args),
      cg: CG.gwMain,
      role: "cli",
      jemalloc: false,
      nodump: true,
    });
    const t0 = Date.now();
    return new Promise((resolve) => {
      const child = spawn(cmd, argv, {
        env: env || cliEnvNow(),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: "/home/node",
      });
      prestartChild = child;
      let out = "";
      const add = (d) => {
        if (out.length < 1_000_000) out += d;
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, timeoutMs);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (prestartChild === child) prestartChild = null;
        resolve({ code, signal, out, ms: Date.now() - t0 });
      });
      child.on("error", (e) => resolve({ code: -1, signal: null, out: String(e), ms: Date.now() - t0 }));
    });
  }
  const warmup = createWarmup({
    mode: warmupMode(SRC),
    runCli,
    canRun: () => !sigtermSeen && !exiting && !S.fenced && S.phase !== "quiescing",
    log,
  });
  const jsonOf = (out) => {
    const i = out.indexOf("{");
    try {
      return i >= 0 ? JSON.parse(out.slice(i)) : null;
    } catch {
      return null;
    }
  };
  const gwCall = async (method, params, timeoutMs = 20_000) => {
    const r = await runCli(
      [
        "/app/openclaw.mjs",
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
        "--timeout",
        String(timeoutMs - 5000),
      ],
      { timeoutMs },
    );
    return { ...r, json: jsonOf(r.out) };
  };
  /**
   * gateway.suspend.prepare answer (2026.10.9, harness H19): top level {status, reason, retryAfterMs,
   * suspensionId, blockers}; a conflict is {ok:false, error:{code, retryAfterMs}}.
   */
  const prepareOf = (r) => {
    const j = r.json?.result ?? r.json ?? {};
    const err = j.error && typeof j.error === "object" ? j.error : null;
    return {
      status: j.status === "ready" ? "ready" : "busy",
      suspensionId: j.suspensionId ?? null,
      retryAfterMs: j.retryAfterMs ?? err?.retryAfterMs ?? null,
      reason: j.reason ?? err?.code ?? (r.json ? null : `cli exit ${r.code}`),
      blockers: Array.isArray(j.blockers) ? j.blockers.slice(0, 8) : null,
    };
  };
  const suspendPrepare = async (requestId, extra = {}) =>
    prepareOf(
      await gwCall("gateway.suspend.prepare", { requestId, terminalPolicy: "preserve", ...extra }, 25_000),
    );
  /** gateway.suspend.resume takes {suspensionId} (H20). No id = nothing held. */
  const suspendResume = async (suspensionId) => {
    if (!suspensionId) return { ok: true, noop: true };
    const r = await gwCall("gateway.suspend.resume", { suspensionId }, 20_000);
    const j = r.json?.result ?? r.json;
    return { ok: r.code === 0 && j?.ok !== false, detail: j ?? r.out.slice(-200) };
  };

  /** M4b N1+N2: quick_check on the managed DBs (scan); logs and returns {ok, n, evidence}. */
  async function checkManaged(why) {
    const sc = await scanDbs();
    if (sc.error) return { ok: true, n: 0, skipped: `scan: ${sc.error}` };
    const r = await sqliteCheck({ state: C.state, rels: sc.managed || [], cg: CG.io });
    log("sqlite-check", { why, n: (sc.managed || []).length, ok: r.ok, evidence: r.evidence });
    return { ...r, n: (sc.managed || []).length };
  }

  const gw = createGateway({
    spawn: (c, a, o) => spawn(c, a, o),
    argv: () =>
      buildCommand({
        cmd: BIN.node,
        args: [
          "--import",
          "/opt/ocrt/unpreload.mjs",
          "/app/openclaw.mjs",
          "gateway",
          ...C.gwArgs,
          ...(renderedAuthMode() || SRC.OCRT_GW_ARGS ? [] : ["--auth", "token"]),
        ],
        cg: CG.gwMain,
        role: "gateway",
        jemalloc: C.jemalloc,
      }),
    env: () => gatewayEnv(SRC, { refs: S.secretRefs || [], caFile: CF_CA, localPassword: localPassword() }),
    fetch,
    canStart: () => !sigtermSeen && !exiting && !S.fenced && plan?.mode !== "files-only",
    beforeRestart: async (kind) => {
      const r = await doReap(`pre-start:${kind}`);
      if (!r.ok) return fail(r.reason);
      const l = await lockStep("in-container");
      if (!l.ok) return fail(l.reason);
      return { ok: true };
    },
    afterExit: async (why) => {
      const t = CG.gw ? await termGatewayTree(CG.gw) : null;
      const r = await doReap(why);
      if (!r.ok && !sigtermSeen) void fail(r.reason);
      return { ok: r.ok, reason: r.reason, tree: t };
    },
    onStarted: (ms) => {
      releaseLsHold("startupz");
      if (!sigtermSeen && S.phase !== "quiescing") setPhase(S.seeding ? "seeding" : "running");
      // Boot split for `ochost logs` (docs/13): readyMs = the gateway's own `ready` line; ms - readyMs is the
      // agent database admission; lsHold says if Litestream was down for it.
      const readyMs = gwReadyAt && gwReadyAt >= gw.state.startedAt ? gwReadyAt - gw.state.startedAt : null;
      void gate.event("startupz", { detail: { ms, readyMs, lsHold: lsHoldNote } });
      S.gwDumpable = nonDumpable(gw.state.pid);
      void guard?.onStartupz().catch((e) => log("guard-error", { err: String(e) }));
      log("gateway-dumpable", { nonDumpable: S.gwDumpable });
      admission.reset();
      if (admission.closed()) admission.reapply(); // a new gateway has no lease: close it again
      // M4 A1: each gateway start (boot, wake, resume after an aborted sleep) reconciles cron rows.
      void cronReconcile("gateway-start");
      // Cold reply: one tiny model call now, so the first user turn is warm.
      void warmup.run().catch(() => {});
    },
    onFatal: (reason) => {
      if (sigtermSeen) return;
      // M4b N1+N2: a gateway on a corrupt DB may print only "The CLI command failed" (Docker
      // m4b-sqlite-corrupt) and crash-loop. Check the managed DBs before the exit names a reason.
      if (reason !== "gateway-crash-loop") return void fail(reason);
      void checkManaged("crash-loop").then((r) =>
        r.ok
          ? fail(reason)
          : fail("sqlite-corrupt", `${r.evidence} | after gateway-crash-loop`.slice(0, 300)),
      );
    },
    // M4b N3: while the disk watch reports low or full space, a gateway exit is not a crash.
    diskFull: () => !!disk?.low || !!disk?.degraded,
    // M4b N1+N2: SQLite corruption or schema text in the exit log → quick_check; failure ends the boot.
    onSqliteSuspect: async (tail) => {
      if (sigtermSeen || exiting) return { fatal: false };
      const r = await checkManaged("gateway-exit");
      if (r.ok) return { fatal: false };
      void fail(
        "sqlite-corrupt",
        `${r.evidence} | log: ${tail.split("\n").slice(-2).join(" ")}`.slice(0, 300),
      );
      return { fatal: true };
    },
    onUnexpectedExit: () => {
      if (!sigtermSeen && !exiting) setPhase("gateway-restart");
    },
    onLine: (line) => {
      if (/\[gateway\] ready\s*$/.test(line)) gwReadyAt = Date.now();
      log("gw", { line: line.slice(0, 2000) });
      if (RELOAD_LINE.test(line)) S.lastConfigReloadAt = Date.now();
      cw?.onGatewayLine(line);
    },
    alert: (c, s, d) => void gate.alert(c, s, d),
    event: (k, x) => gate.event(k, x),
    log,
  });
  /** M4 A1: delete cron_jobs rows the gateway does not schedule (lib/cron-reconcile.mjs). */
  let cronBusy = null;
  function cronReconcile(why) {
    if (cronBusy) return cronBusy;
    const db = path.join(C.state, "state", "openclaw.sqlite");
    const liveKey = path.join(C.state, "cron", "jobs.json");
    cronBusy = reconcileCron(why, {
      liveKey,
      readRows: async () => {
        const r = await runOcio("cron-read", [db, "jobs"], { cg: CG.io, timeoutMs: 20_000 });
        return r.json?.ok ? r.json.rows : null;
      },
      listLive: async () => {
        const r = await gwCall("cron.list", { includeDisabled: true });
        return r.code === 0 ? r.json : null;
      },
      del: async (rows) => {
        const r = await runOcio("cron-fix", [db, "delete", liveKey], {
          cg: CG.io,
          timeoutMs: 20_000,
          stdin: JSON.stringify(rows),
        });
        return r.json ?? { ok: false, error: r.err || `exit ${r.code}` };
      },
      log,
      alert: (c, sv, d) => gate.alert(c, sv, d),
    })
      .then((r) => {
        S.cronReconcile = { why, at: Date.now(), ...r };
        return r;
      })
      .finally(() => {
        cronBusy = null;
      });
    return cronBusy;
  }
  function gwStatus() {
    const s = gw.state;
    return {
      pid: s.pid,
      uptimeMs: s.pid ? Date.now() - s.startedAt : 0,
      startupz: s.startupz,
      startupzMs: s.startupzMs,
      starts: s.starts,
      restarts15m: s.restarts.length,
      lastExit: s.lastExit,
      nonDumpable: S.gwDumpable ?? null,
    };
  }
  const waitStartupz = async (capMs) => {
    const end = Date.now() + capMs;
    while (Date.now() < end) {
      if (gw.state.startupz) return gw.state.startupzMs;
      if (!gw.running() && !gw.state.pendingRestart) return null;
      await sleep(250);
    }
    return null;
  };

  // ---- 4. lock step ----
  let recoverLockAvail = null;
  async function lockStep(kind) {
    let myNs = null;
    try {
      myNs = /\[(\d+)\]/.exec(fs.readlinkSync("/proc/self/ns/pid"))?.[1] ?? null;
    } catch {}
    const r = await runLockStep(plan?.lockMode || "auto", {
      me: { host: os.hostname(), bootId: S.bootId, pidNs: myNs },
      readOwners: async () => {
        const x = await runCli(["-e", LOCK_READER, C.state], { timeoutMs: 20_000 });
        return jsonOf(x.out.trim().split("\n").pop()) || { readErr: x.out.slice(-300) };
      },
      hasRecoverLock: async () => {
        if (recoverLockAvail === null) {
          const h = await runCli(["/app/openclaw.mjs", "gateway", "recover-lock", "--help"], {
            timeoutMs: 60_000,
          });
          recoverLockAvail = h.code === 0 && !/has no command/i.test(h.out);
        }
        return recoverLockAvail;
      },
      recoverLock: async () => {
        const j = await runCli(["/app/openclaw.mjs", "gateway", "recover-lock", "--json"], {
          timeoutMs: 120_000,
        });
        const fp = jsonOf(j.out)?.confirmation;
        if (!fp) return { ok: true, detail: "no confirmation (nothing to recover)" };
        const c = await runCli(["/app/openclaw.mjs", "gateway", "recover-lock", "--confirm", fp], {
          timeoutMs: 120_000,
        });
        return { ok: c.code === 0, detail: c.out.slice(-300) };
      },
      sleep,
      stopped: () => sigtermSeen,
      log,
    });
    S.lock = { kind, ...r, seen: undefined };
    log("lock", { kind, ...r });
    void gate.event("lock", { reason: r.action, detail: { cls: r.cls, ms: r.ms } });
    return r;
  }

  // ---- 5. Litestream, lag, start gate ----
  const s3 = {
    endpoint: `http://127.0.0.1:18790`,
    bucket: `oc-host-${C.inst}`,
    region: "auto",
    accessKey: `ocrt-g${C.gen}-${iid}`,
    secretKey: "",
  };
  {
    const { createHmac } = await import("node:crypto");
    const { replicaKeyMessage } = await import("./contract.mjs");
    s3.secretKey = createHmac("sha256", C.secret).update(replicaKeyMessage(C.gen, iid)).digest("hex");
  }
  function setRemote(db, txid) {
    dbsRemote[db] = Math.max(dbsRemote[db] || 0, txid || 0);
    if (ls?.dbs.includes(db)) ls.lag.setRemote(db, dbsRemote[db]);
  }
  async function refreshLocal() {
    if (!ls?.dbs.length) return;
    const dirs = Object.fromEntries(
      ls.dbs.map((r) => [dbId(r), C.lsLegacyMeta ? legacyMetaPath(C.state, r) : metaPathFor(C.gen, r)]),
    );
    const r = await runOcio("fsops", ["max-txid", JSON.stringify({ dirs })], {
      cg: CG.io,
      timeoutMs: 10_000,
    });
    const t = r.json?.txid || {};
    for (const rel of ls.dbs) if (Number.isFinite(t[dbId(rel)])) ls.lag.setLocal(rel, t[dbId(rel)]);
  }
  async function refreshRemote() {
    try {
      const st = await gate.replicaState();
      if (st?.dbs) lastAckReplica = st;
      for (const [db, v] of Object.entries(st?.dbs || {})) setRemote(db, v.l0MaxTxid);
      return;
    } catch {}
    // Fallback when the gate has no record route: list level-0 keys of this gen through the proxy.
    try {
      const keys = await listKeys(
        { ...s3, bucket: plan?.replica?.bucket || s3.bucket },
        genPrefix(C.inst, C.gen),
      );
      for (const k of keys) {
        const p = parseLtxKey(k);
        if (p && p.level === 0) setRemote(p.db, p.maxTxid);
      }
    } catch {}
  }
  let lsHold = null;
  let lsHoldNote = "none"; // none (no start gate), off, seeding, held
  let gwReadyAt = 0;
  /** End the admission hold (start-gate). A drain needs Litestream for its final sync, so SIGTERM ends it too. */
  const releaseLsHold = (why) => {
    if (!lsHold) return;
    clearTimeout(lsHold);
    lsHold = null;
    if (exiting || S.fenced) return;
    const pid = ls?.release(why) ?? null;
    log("ls-hold-release", { why, pid });
  };
  const lagTick = async () => {
    if (!ls) return;
    await refreshLocal().catch(() => {});
    await refreshRemote();
  };
  async function waitLag(capMs, pred) {
    const end = Date.now() + capMs;
    for (;;) {
      await lagTick();
      if (pred()) return { ok: true, lag: ls.lag.report() };
      if (Date.now() > end) return { ok: false, lag: ls.lag.report() };
      await sleep(500);
    }
  }
  const replica = {
    running: () => !!ls?.pid(),
    // A respawned Litestream (drain after SIGTERM-to-all) must read the WAL tail first: wait for
    // 2.5 s of uptime (2.5 sync intervals) before a lag of 0 counts (M1: 4-5 rows lost without it).
    waitLagZero: async (capMs) => {
      if (!ls) return { ok: true };
      if (ls.pid()) await ls.waitUp(2500, Math.min(capMs, 5000));
      return waitLag(capMs, () => ls.lag.caughtUp());
    },
    waitLagUnder: (capMs) =>
      ls
        ? waitLag(capMs, () => ls.lag.report().every((r) => r.lag !== null && r.lag <= 1))
        : Promise.resolve({ ok: true }),
    /** Admission hold around a gateway stop (sleep phase 4). null = nothing to hold. */
    hold: async (why) => (ls?.pid() ? ls.hold(why) : null),
    release: (why) => {
      const pid = ls?.release(why) ?? null;
      if (pid !== null) log("ls-hold-release", { why, pid });
      return pid;
    },
    stopFinal: async ({ capMs } = {}) => {
      if (!ls) return { clean: true, detail: "no litestream" };
      if (replica.final) return replica.final;
      const r = await ls.stopFinal("final");
      replica.final = { clean: r.clean, detail: r.reason, ms: r.ms, capMs };
      log("litestream-final", r);
      return replica.final;
    },
    start: async () => {
      replica.final = null;
      ls?.resume();
    },
    /** After the final sync: TXID per DB = max(local L0, gate-recorded L0) (the marker TXIDs). */
    perDb: async () => {
      await lagTick();
      const rep = ls ? ls.lag.report() : [];
      const remote = lastAckReplica?.dbs || {};
      // bytes = the DB file size (the set size the DO's seed gate reads, amend §1.6 S3), not the bytes
      // uploaded to the gen (about 2-3x the file: seed L0 + L9 + L1). Fallback: the gate's record.
      const sc = await scanDbs().catch(() => ({}));
      const size = Object.fromEntries((sc.scanRows || []).map((f) => [f.rel, f.size]));
      return {
        txid: Object.fromEntries(rep.map((r) => [r.db, Math.max(r.localTxid ?? 0, dbsRemote[r.db] ?? 0)])),
        bytes: Object.fromEntries(rep.map((r) => [r.db, size[r.db] ?? remote[r.db]?.bytes ?? 0])),
        lastWriteAt: Object.fromEntries(rep.map((r) => [r.db, remote[r.db]?.lastWriteAt ?? null])),
      };
    },
    final: null,
  };
  const scanAlerted = new Set();
  async function scanDbs() {
    const r = await runOcio("fsops", ["scan", JSON.stringify({ state: C.state })], {
      cg: CG.io,
      timeoutMs: 60_000,
    });
    if (!r.json || r.json.error)
      return { managed: [], shadow: [], alerts: [], error: r.json?.error || r.err };
    // shadowEntries: fsops scan rows ({rel, mtimeMs, size}) of the shadow set (Shadow.round input).
    const c = classifyDbs(r.json);
    // Discovery alerts (db-unclassified, db-set-cap, db-unsafe, db-scan-truncated): once per content.
    for (const a of c.alerts || []) {
      const key = `${a.class}:${a.detail}`;
      if (scanAlerted.has(key)) continue;
      scanAlerted.add(key);
      log("db-scan-alert", a);
      void gate.alert(a.class, a.severity, a.detail);
    }
    const sh = new Set(c.shadow);
    return {
      ...c,
      scanRows: r.json.sqlite || [],
      shadowEntries: (r.json.sqlite || []).filter((f) => sh.has(f.rel)),
    };
  }

  // ---- 5b. admission (ingress) close/open: credsync down 60 s, replica fault +5 s (H10) ----
  const admission = (() => {
    const why = new Set();
    let sid = null;
    let chain = Promise.resolve();
    const apply = () => {
      chain = chain
        .then(async () => {
          if (why.size && !sid && gw.running()) {
            const p = await suspendPrepare(`ocsup-admission-${iid}`, { drain: true });
            sid = p.suspensionId;
            log("admission-prepare", p);
          } else if (!why.size && sid) {
            const r = await suspendResume(sid);
            sid = null;
            log("admission-resume", r);
          }
        })
        .catch((e) => log("admission-error", { err: String(e) }));
      return chain;
    };
    return {
      close(w) {
        if (why.has(w)) return;
        why.add(w);
        log("admission-close", { reason: w });
        void gate.event("admission-close", { reason: w });
        void apply();
      },
      open(w) {
        if (!why.delete(w)) return;
        log("admission-open", { reason: w, left: [...why] });
        void gate.event("admission-open", { reason: w });
        void apply();
      },
      /** The gateway stopped: a held lease ended with it. */
      reset() {
        sid = null;
      },
      reapply: () => void apply(),
      closed: () => why.size > 0,
      state: () => ({ closed: [...why], suspensionId: sid }),
    };
  })();

  // ---- 6. sleep ops, ctl ----
  let sleepSid = null; // suspensionId held by the sleep op between prepare and cancel/resume
  /** creds dep for sleep and drain: CredSync.flush takes a number; read-only/no credsync = ok. */
  function credsDep() {
    return {
      flush: async ({ capMs } = {}) => {
        if (!creds) return { ok: true, why: "no-credsync" };
        const r = await creds.flush(capMs ?? 30_000);
        return { ...r, detail: r.why ?? null };
      },
      restart: () => {},
    };
  }
  /** Shadow round over the shadow-class files (15 min timer, sleep phase 5, ocsupctl shadow-backup). */
  let lastShadowAt = null; // C1: newest shadow round (plan.shadowAt at boot)
  async function shadowRound(why) {
    if (!shadow) return { ok: true, results: [] };
    // M4b N3: no shadow copies while free space is under the reserve.
    if (disk?.low) {
      log("shadow-backup", { why, skipped: "disk-low" });
      return { ok: true, skipped: "disk-low", results: [] };
    }
    lastShadowAt = Date.now();
    const c = await scanDbs();
    if (c.error) return { ok: false, detail: `scan: ${c.error}`, results: [] };
    const results = await shadow.round(c.shadowEntries || []);
    const bad = results.filter((r) => !r.ok && r.why !== "too-big");
    log("shadow-backup", { why, n: results.length, bad: bad.map((r) => `${r.rel}:${r.why}`) });
    for (const r of results) if (!r.ok && isDiskFull(r.why)) void disk?.onChildError(r.why);
    return {
      ok: bad.length === 0,
      detail: bad.map((r) => `${r.rel}:${r.why}`).join(", ") || null,
      results: results.filter((r) => r.why !== "too-big"),
    };
  }
  sleepOps = createSleepOps({
    draining: () => sigtermSeen,
    holdAtStop: C.lsStopHold,
    queryRows: async () => {
      const r = await runOcio(
        "sleep-read",
        [
          path.join(C.state, "state", "openclaw.sqlite"),
          String(Date.now()),
          JSON.stringify(plan?.wakeIgnore ?? []),
        ],
        { cg: CG.io, timeoutMs: 20_000 },
      );
      return r.json?.ok ? r.json : { error: r.json?.error || r.err || `exit ${r.code}` };
    },
    channelsStatus: async () => {
      // Throws with the CLI text on a failed call; check() reports it as channels-unknown (D2).
      return channelsFromCli(await gwCall("channels.status", {}));
    },
    seeding: () => S.seeding,
    replicaFault: () => (S.rpo === "down" ? "replica-down" : null),
    lastConfigChangeAt: () =>
      Math.max(
        S.lastConfigWriteAt || 0,
        S.lastConfigReloadAt || 0,
        cw?.state?.lastConfigWriteAt || 0,
        cw?.state?.lastConfigReloadAt || 0,
      ) || null,
    suspendPrepare: async () => {
      const p = await suspendPrepare(`ocsup-sleep-${iid}`);
      sleepSid = p.status === "ready" ? p.suspensionId : null;
      log("sleep-prepare-answer", p);
      return p;
    },
    suspendResume: async () => {
      const r = await suspendResume(sleepSid);
      sleepSid = null;
      return r;
    },
    gateway: {
      running: () => gw.running(),
      stop: (o) => gw.stop(o),
      start: (k) => gw.start(k),
      waitStartupz,
    },
    postExitRead: async () => {
      const r = await runOcio(
        "sleep-read",
        [
          path.join(C.state, "state", "openclaw.sqlite"),
          String(Date.now()),
          JSON.stringify(plan?.wakeIgnore ?? []),
        ],
        { cg: CG.io, timeoutMs: 20_000 },
      );
      if (!r.json?.ok) return { error: r.json?.error || r.err || `exit ${r.code}` };
      return {
        openRows: r.json.openIngress + r.json.pendingDelivery,
        eventJobs: r.json.eventJobs,
        nextWakeAtMs: r.json.nextWakeAtMs,
      };
    },
    replica,
    creds: credsDep(),
    shadowFlush: async () => shadowRound("sleep"),
    // §12.2 (M3 O5): the owner's Telegram ids for the Control DO's wake allowlist, at each sleep flush.
    exportWakeAllow: async () => {
      if (plan?.mode !== "prod" || !bootCtx.cfg?.file) return { ok: false, skipped: "mode" };
      const r = await exportWakeAllow({
        readConfig: async () => {
          const x = await runOcio("config-io", ["read", bootCtx.cfg.file], { cg: CG.io, timeoutMs: 10_000 });
          return x.json?.ok ? x.json.text : null;
        },
        pairedIds: async () => {
          const x = await runOcio("cron-read", [path.join(C.state, "state", "openclaw.sqlite"), "pairing"], {
            cg: CG.io,
            timeoutMs: 10_000,
          });
          if (!x.json?.ok) throw new Error(x.json?.error || "pairing read failed");
          return (x.json.rows || []).map((r) => r.entry);
        },
        put: (body) => gate.call("PUT", "/v1/wake-allow", body, { timeoutMs: 5000 }),
        configVer: plan.configVer,
        log,
      });
      log("wake-allow", r);
      return r;
    },
    marker,
    sync: async () => spawnSync(BIN.sync),
    alert: (c, s, d) => void gate.alert(c, s, d),
    event: (k, x) => void gate.event(k, x),
    log,
    setPhase,
  });

  const handlers = {
    status: async () => ({ ok: true, ...status() }),
    logs: async (req) => ({ ok: true, lines: L.tail(Math.min(Number(req.args?.n) || 200, 2000)) }),
    "restart-gateway": async () => {
      const s = await gw.stop({ capMs: 330_000, why: "ctl-restart" });
      const st = await gw.start("ctl-restart");
      return { ok: !!st.started, stop: s, start: st };
    },
    stop: async () => {
      if (S.planned) return { ok: true, state: S.planned.state };
      S.planned = { state: "stopping", at: Date.now() };
      void (async () => {
        const p = await gwCall(
          "gateway.suspend.prepare",
          { requestId: `ocsup-stop-${iid}`, terminalPolicy: "terminate", drain: true },
          60_000,
        );
        const g = await gw.stop({ capMs: 330_000, why: "planned" });
        const lag = await replica.waitLagZero(30_000);
        const f = await replica.stopFinal({ capMs: 10_000 });
        spawnSync(BIN.sync);
        const unclean = [!g.clean && "gateway", (!lag.ok || !f.clean) && "litestream"].filter(Boolean);
        S.planned = {
          state: unclean.length ? "failed" : "quiesced",
          unclean,
          prepare: p.json?.result?.status ?? null,
          at: Date.now(),
        };
        setPhase("asleep-ready");
      })();
      return { ok: true, state: "stopping" };
    },
    "stop-status": async () => ({ ok: true, ...(S.planned || { state: "none" }) }),
    "sleep-check": (r) => sleepOps.handle("sleep-check", r.opId),
    "sleep-prepare": (r) => sleepOps.handle("sleep-prepare", r.opId),
    "sleep-cancel": (r) => sleepOps.handle("sleep-cancel", r.opId),
    "sleep-stop-gateway": (r) => sleepOps.handle("sleep-stop-gateway", r.opId),
    "sleep-flush": (r) => sleepOps.handle("sleep-flush", r.opId),
    "resume-after-sleep": (r) => sleepOps.handle("resume-after-sleep", r.opId),
    dirty: async (r) => {
      // M4 A4: the Runtime DO's hourly checkpoint asks first; unknown (ocio error) answers dirty.
      const sinceMs = Number(r.args?.sinceMs) || 0;
      const x = await runOcio("fsops", ["dirty", JSON.stringify({ state: C.state, sinceMs })], {
        cg: CG.io,
        timeoutMs: 60_000,
      });
      if (!x.json || x.json.error)
        return { ok: true, dirty: true, unknown: true, detail: x.json?.error ?? x.err };
      return { ok: true, dirty: x.json.count > 0 || x.json.truncated, ...x.json };
    },
    // N7: restore probe of this boot's gen into a scratch dir; the Control DO marks the gen verified or bad.
    "verify-gen": async (r) => {
      const gen = Number(r.args?.gen);
      if (gen !== C.gen)
        return { ok: false, error: "bad-request", detail: `gen ${gen} is not this boot (${C.gen})` };
      const dbs = Array.isArray(r.args?.dbs) && r.args.dbs.length ? r.args.dbs.map(String) : ls?.dbs || [];
      if (!dbs.length) return { ok: false, error: "wrong-phase", detail: "no replicated DBs yet" };
      const v = await verifyGen({
        state: C.state,
        varDir: C.varDir,
        runDir: C.runDir,
        inst: C.inst,
        gen,
        dbs,
        s3: { ...s3, bucket: plan?.replica?.bucket || s3.bucket },
        cg: CG.sys,
        timeoutMs: Math.min(Number(r.args?.timeoutMs) || 40_000, 300_000),
        ocio: (n, a, o) => runOcio(n, a, { timeoutMs: 30_000, ...o, cg: CG.io }),
      });
      log("verify-gen", { gen, ok: v.ok, reason: v.reason, rel: v.rel });
      return {
        ok: true,
        gen,
        verified: v.ok,
        reason: v.reason ?? null,
        rel: v.rel ?? null,
        why: v.why ?? null,
        dbs: v.dbs ?? [],
      };
    },
    "import-status": async () => ({ ok: true, ...(importer ? importer.status() : { off: true }) }),
    "shadow-backup": async () => {
      if (!shadow) return { ok: false, error: "failed", detail: "shadow not running in this phase" };
      return await shadowRound("ctl");
    },
    archive: async (r) => {
      if (!archiver) return { ok: false, error: "failed", detail: "archive not running in this mode" };
      if (disk?.low) return { ok: false, error: "failed", class: "disk-full", why: "disk-low" };
      const kind = ["online", "clean", "offline"].includes(r.args?.kind) ? r.args.kind : "online";
      const a = await archiver.run(kind, String(r.args?.reason || "ctl").slice(0, 64));
      if (a && a.ok === false && isDiskFull(`${a.why ?? ""} ${a.detail ?? ""}`)) {
        await disk?.onChildError(`${a.why ?? ""} ${a.detail ?? ""}`);
        return { ok: false, error: "failed", class: "disk-full", ...a };
      }
      return a && a.ok === false ? { error: "failed", ...a, ok: false } : { ok: true, ...a };
    },
    fault: async (r) => {
      const rec = applyFault(
        {
          cmd: String(r.args?.line || "").split(/\s+/)[0],
          arg: String(r.args?.line || "").split(/\s+/)[1] ?? null,
          known: true,
        },
        faultHandlers,
      );
      S.faults.push(rec);
      return { ok: !rec.err, ...rec };
    },
  };
  ctl = startCtlServer({
    sock: SRC.OCSUPCTL_SOCK || OCSUPCTL_SOCK,
    handlers,
    draining: () => sigtermSeen,
    allowTest: C.testOps,
    log,
  });

  // ---- 7. faults (M0 hooks) ----
  const balloons = [];
  const faultHandlers = {
    "kill-gateway": () => {
      if (gw.state.pid) process.kill(-gw.state.pid, "SIGKILL");
      return { pid: gw.state.pid };
    },
    "kill-litestream": () => {
      const p = ls?.pid();
      if (p) process.kill(p, "SIGKILL");
      return { pid: p };
    },
    "balloon-vm": (a) => ({ pid: balloon(Number(a) || 1024, CG.io, false) }),
    "balloon-gw": (a) => ({ pid: balloon(Number(a) || 1024, CG.gwMain, true) }),
    "balloon-stop": () => {
      for (const b of balloons.splice(0))
        try {
          b.kill("SIGKILL");
        } catch {}
    },
    exit: (a) => {
      log("fault", { cmd: "exit", arg: a });
      process.exit(Number(a) || 1);
    },
    "hang-sigterm": () => {
      hangSigterm = true;
    },
    "heartbeat-off": () => {
      hbOff = true;
    },
    "heartbeat-on": () => {
      hbOff = false;
    },
    "gate-drop": () => {
      hbOff = true;
    },
    "gate-ok": () => {
      hbOff = false;
    },
    heap: (a) => {
      if (a === "off" || a === null) heapFault = null;
      else {
        const pct = Number(a);
        if (!Number.isFinite(pct) || pct < 0 || pct > 200) throw new Error("heap <usedPct>|off");
        const limit = 2240 * 1024 ** 2;
        heapFault = { used: Math.round((limit * pct) / 100), limit, at: Date.now() }; // this gateway only
      }
      return { heap: heapFault };
    },
  };
  function balloon(mib, cgDir, uid1000) {
    const code = `const a=[];for(let i=0;i<${mib};i++){a.push(Buffer.alloc(1048576,1))}console.log("balloon ${mib} MiB held");setInterval(()=>a.length,1e9)`;
    const [c, a] = buildCommand({
      cmd: BIN.node,
      args: ["--max-old-space-size=64", "-e", code],
      cg: cgDir,
      role: "cli",
      uid1000,
      jemalloc: false,
      nodump: false,
    });
    const child = spawn(c, a, { stdio: "ignore" });
    balloons.push(child);
    return child.pid;
  }
  setInterval(() => {
    for (const f of takeFaults(path.join(C.varDir, "faults"))) {
      const rec = applyFault(f, faultHandlers);
      S.faults.push(rec);
      log("fault", rec);
    }
  }, 1000).unref();

  // ---- 8. fence and stale ----
  let fenceStop = null;
  async function fence() {
    if (sigtermSeen || exiting) return;
    S.fenced = true;
    setPhase("fenced");
    void gate.alert("self-fence", "high", "no heartbeat ack for 150 s");
    fenceStop = gw.stop({ capMs: 15_000, why: "fence" });
    await fenceStop;
  }
  async function unfence() {
    if (!S.fenced || sigtermSeen || exiting) return;
    S.fenced = false;
    await fenceStop; // an ack can come back while the fence stop still runs
    void gate.event("unfence", {});
    if (plan && plan.mode !== "files-only") {
      setPhase("gateway-start");
      await gw.start("unfence");
    }
  }
  async function selfFenceStale() {
    if (exiting) return;
    log("self-fence", { why: "stale" });
    sigtermSeen = true;
    gw.killNow();
    await doReap("fence");
    await ls?.kill();
    creds?.stop();
    return finish(EXIT.fenced, "stale", { notify: false });
  }

  // ---- 9. SIGTERM ----
  async function onSigterm(sig) {
    if (hangSigterm) return log("signal", { sig, action: "ignored (fault hang-sigterm)" });
    if (sigtermSeen) return log("signal", { sig, action: "ignored (already draining)" });
    sigtermSeen = true; // synchronous (plan §4.2 "SIGTERM flag")
    guard?.stop();
    S.draining = true;
    releaseLsHold("sigterm");
    replica.release("sigterm"); // a sleep-stop hold: the drain needs Litestream for its final sync
    ls?.setDraining?.();
    shadow?.abort();
    archiver?.abort();
    cw?.stop?.();
    marker.void("sigterm");
    log("signal", { sig, phase: S.phase });
    const sigAt = Date.now();
    const r = await drain({
      phase: () => S.phase,
      event: (k, x) => gate.event(k, x),
      setPhase,
      log,
      abortPrestart: () => {
        if (prestartChild)
          try {
            prestartChild.kill("SIGKILL");
          } catch {}
        return { killed: !!prestartChild };
      },
      reap: doReap,
      gateway: { running: () => gw.running(), stop: (o) => gw.stop(o) },
      gatewayExitUnclean: () => {
        const e = gw.state.lastExit;
        return !!e && e.at >= sigAt - 5000 && (e.code !== 0 || !!e.signal) && e.signal !== "SIGTERM";
      },
      fenced: () => S.fenced,
      sleepInterrupt: () => sleepOps.interruptBySigterm(),
      replica,
      creds: credsDep(),
      sync: async () => ({ code: spawnSync(BIN.sync).status }),
      finalSnapshot: async (unclean) => {
        if (!gate.proven) return { ok: false, error: "gate not proven" };
        return gate.finalSnapshot(unclean);
      },
    });
    S.drain = r.steps;
    return finish(r.code, r.reason);
  }
  process.on("SIGTERM", () => void onSigterm("SIGTERM"));
  process.on("SIGINT", () => void onSigterm("SIGINT"));
  process.on("uncaughtException", (e) => {
    log("uncaught", { level: "error", err: String(e?.stack || e).slice(0, 2000) });
    void finish(EXIT.supervisor, "supervisor");
  });
  setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > 512 * 1024 ** 2) void finish(EXIT.supervisor, "supervisor", { detail: `rss ${rss}` });
  }, 10_000).unref();

  // ---- 10. boot ----
  let hbTimer = setInterval(() => void hb.tick(), C.hbMs);
  hbTimer.unref();
  setInterval(() => hb.check(), 1000).unref();
  setInterval(writeStatus, 5000).unref();
  writeStatus();

  const stopped = () => sigtermSeen || exiting;
  const boot = await gate.boot(
    {
      hostname: os.hostname(),
      hostnamePinned: !!S.hostname.pinned,
      newBoot: !!S.newBoot,
      ocsup: SRC.OCRT_OCSUP_SHA || "dev",
    },
    { stop: stopped },
  );
  if (stopped()) return;
  log("boot-answer", {
    status: boot.status,
    why: boot.why ?? null,
    mode: boot.plan?.mode,
    sqlite: boot.plan?.sqlite?.kind,
  });
  if (boot.status === "reboot-detected") return finish(75, "auto-restart");
  if (boot.status === "stale") return finish(EXIT.fenced, "stale", { notify: false });
  if (boot.status !== "ok") return fail("restore-blocked:infra", boot.why);
  plan = boot.plan;
  S.plan = {
    mode: plan.mode,
    rootfs: plan.rootfs.kind,
    sqlite: plan.sqlite.kind,
    dbs: (plan.dbs || []).length,
    runDoctor: plan.runDoctor,
  };
  // Plan timers win over the env defaults (contract §3; harness H13).
  if (plan.timers) {
    if (plan.timers.fenceMs) hb.setFenceMs(plan.timers.fenceMs);
    if (plan.timers.hbMs && plan.timers.hbMs !== C.hbMs) {
      clearInterval(hbTimer);
      hbTimer = setInterval(() => void hb.tick(), plan.timers.hbMs);
      hbTimer.unref();
    }
    log("plan-timers", plan.timers);
  }
  hb.armFence();
  void hb.tick();
  Object.assign(bootCtx, {
    gate,
    plan,
    runOcio: (n, a, o) => runOcio(n, a, { cg: CG.io, ...o }),
    runCli,
    cliEnv: cliEnvNow,
    envNames: Object.keys(SRC), // F9 default config: which SecretRefs the Worker passed
    state: C.state,
    runDir: C.runDir,
    log,
    alert: (c, sv, d) => void gate.alert(c, sv, d),
    cgIo: CG.io,
  });

  const ps = planSteps(plan, { startSnapshotId: C.snapshotId });
  if (ps.exit) return finish(ps.exit.code, ps.exit.reason, { detail: ps.exit.detail });
  log("plan-steps", { steps: ps.steps.map((s) => s.step), startGate: ps.startGate });

  proxy = startReplicaProxy({
    target: C.replica,
    secret: C.secret,
    log,
    onUnproven: (why) => log("replica-unproven", { why }),
  });

  // docs/11 §7: OpenClaw wants the firecrawl baseUrl private; the plugin gets this loopback port. OCRT_CAP_TARGET: test envs.
  capProxy = startCapProxy({ target: capTarget(SRC.OCRT_CAP_TARGET), log });

  // docs/11 §8 file storage: the ochost-storage plugin (uid 1000) talks S3 to the gate's files key space through a
  // second loopback port, signed with this gen's key from the key file. Best effort: a failure never blocks the boot.
  filesProxy = startCapProxy({
    port: FILES_PROXY_PORT,
    target: capTarget(SRC.OCRT_FILES_TARGET, FILES_TARGET),
    log,
  });
  try {
    writeFilesKey(path.join(C.runDir, FILES_KEY_NAME), s3);
  } catch (e) {
    log("files-key-error", { err: String(e) });
  }
  void ensureFilesMarker({ ...s3, bucket: plan?.replica?.bucket || s3.bucket }, C.inst)
    .then((r) => log("files-marker", { r }))
    .catch((e) => log("files-marker", { r: `error ${e?.cause?.code || e}` }));

  const planRels = (plan.dbs || []).map((d) => d.db);
  // F1: every restore step shares one deadline inside the DO's restore budget. A step past it ends the boot
  // with exit 75 `restore-timeout` (DO: next ladder step) instead of a silent stall until budget:restore.
  let restoreEnd = null;
  const restoreLeft = () => (restoreEnd === null ? 600_000 : Math.max(1000, restoreEnd - Date.now()));
  for (const st of ps.steps) {
    if (stopped()) return;
    const t0 = Date.now();
    let r;
    try {
      if (RESTORE_STEPS.has(st.step)) {
        restoreEnd ??= Date.now() + restoreDeadlineMs(plan);
        let timer;
        const left = restoreEnd - Date.now();
        const to = new Promise((res) => {
          timer = setTimeout(() => res({ timedOut: true }), Math.max(0, left));
          timer.unref?.();
        });
        r = (await Promise.race([runStep(st), to])) || {};
        clearTimeout(timer);
        if (r.timedOut) {
          log("restore-timeout", { level: "error", step: st.step, ms: Date.now() - t0 });
          return fail(
            "restore-timeout",
            `${st.step} after ${Date.now() - t0} ms (deadline ${restoreDeadlineMs(plan)} ms)`,
          );
        }
      } else r = (await runStep(st)) || {};
    } catch (e) {
      // A throw in a step is never "fresh": restore steps fail closed, others are supervisor faults.
      const reason = /^(wipe|sqlite-|archive|workspace)/.test(st.step)
        ? "restore-blocked:infra"
        : "supervisor";
      log("step-error", { level: "error", step: st.step, err: String(e?.message || e).slice(0, 500) });
      return fail(reason, `${st.step}: ${String(e?.message || e).slice(0, 300)}`);
    }
    S.steps.push({ step: st.step, ms: Date.now() - t0, ...r.rec });
    log("step", { step: st.step, ms: Date.now() - t0, ...r.rec });
    if (r.exit) return fail(r.exit, r.detail, r.out);
  }
  // Lag data on its own 2 s tick; the fault rule on a 250 ms tick reads the newest data. The stage times
  // (+5 s close, +15 s stop) run from Litestream's exit or the fault line, so the rule must not wait on
  // a lag sample (M1: one lagTick-then-rule chain every 2 s closed admission at +6.8-8.9 s).
  let lagBusy = false;
  setInterval(() => {
    if (lagBusy) return;
    lagBusy = true;
    void lagTick()
      .catch(() => {})
      .finally(() => {
        lagBusy = false;
      });
  }, 2000).unref();
  setInterval(
    () => void replicaFaultRule().catch((e) => log("fault-rule-error", { err: String(e) })),
    250,
  ).unref();
  setInterval(async () => {
    if (stopped() || !ls || S.phase === "quiescing" || S.phase === "asleep-ready") return;
    const c = await scanDbs();
    if (!c.error) await ls.apply(c.managed);
  }, 10_000).unref();

  async function runStep(st) {
    switch (st.step) {
      case "wipe": {
        setPhase("restore");
        // F1.2: a legacy meta dir sits beside every SQLite file the rootfs holds, listed in the plan
        // or not (a marker wake keeps the files; the plan may list none). Wipe beside all of them.
        const sc = await scanDbs();
        const rels = [...new Set([...planRels, ...(sc.managed || []), ...(sc.shadow || [])])];
        return {
          rec: await prestartWipe({
            state: C.state,
            varDir: C.varDir,
            rels,
            ocio: (n, a, o) => runOcio(n, a, { timeoutMs: Math.min(60_000, restoreLeft()), ...o, cg: CG.io }),
          }),
        };
      }
      case "archive-restore":
        return { exit: "restore-blocked:infra", detail: "archive restore not built in M1 core" };
      case "workspace-restore":
        return await workspaceRestore({
          gate,
          archive: st.archive,
          state: C.state,
          varDir: C.varDir,
          ocio: (n, a, o) => runOcio(n, a, { ...o, cg: CG.io }),
          timeoutMs: restoreLeft(),
          log,
        });
      case "workspace": {
        const r = await workspaceStep({
          state: C.state,
          db: path.join(C.state, "state", "openclaw.sqlite"),
          source: st.source,
          acceptLoss: st.acceptLoss,
          ocio: (n, a, o) => runOcio(n, a, { timeoutMs: Math.min(30_000, restoreLeft()), ...o, cg: CG.io }),
        });
        for (const a of r.alerts || []) void gate.alert(a.class, a.severity, a.detail);
        return r;
      }
      case "sqlite-fresh":
        return {};
      case "sqlite-marker": {
        const m = await markerCheck({ state: C.state, dbs: st.dbs });
        return m.ok
          ? { rec: { marker: st.markerId } }
          : // M4b N1+N2: a failed quick_check is SQLite evidence (named exit, DO l5-pending).
            { exit: "sqlite-corrupt", detail: `quick_check ${JSON.stringify(m.bad)}`.slice(0, 300) };
      }
      case "sqlite-gen": {
        const r = await restoreGen({
          state: C.state,
          varDir: C.varDir,
          runDir: C.runDir,
          inst: C.inst,
          gen: st.gen,
          dbs: st.dbs,
          lastTxid: st.lastTxid,
          ts: st.ts,
          s3: { ...s3, bucket: plan.replica?.bucket || s3.bucket },
          cg: CG.sys,
          stop: stopped,
          timeoutMs: restoreLeft(),
          ocio: (n, a, o) => runOcio(n, a, { timeoutMs: Math.min(120_000, restoreLeft()), ...o, cg: CG.io }),
        });
        if (r.reason === "sigterm") return {};
        return r.ok
          ? { rec: { dbs: r.dbs } }
          : { exit: r.reason, detail: `${r.rel ?? ""} ${r.why ?? r.out ?? ""}`.slice(0, 500) };
      }
      case "sqlite-pending": {
        const r = await pendingCheck({ state: C.state, dbs: st.dbs });
        for (const a of r.alerts) void gate.alert(a.class, a.severity, a.detail);
        return { rec: { keep: r.keep, lost: r.lost } };
      }
      case "sqlite-archive-check":
      case "sqlite-keep":
        return {};
      case "sqlite-check": {
        // M4b N1+N2: quick_check every managed DB on the rootfs before the gateway opens it.
        const r = await checkManaged("boot");
        return r.ok ? { rec: { checked: r.n } } : { exit: "sqlite-corrupt", detail: r.evidence };
      }
      case "lock": {
        setPhase("lock");
        const r = await doReap("pre-lock");
        if (!r.ok) return { exit: r.reason };
        const l = await lockStep(S.newBoot ? "new-boot" : "same-boot");
        return l.ok ? { rec: { cls: l.cls, action: l.action } } : { exit: l.reason, detail: l.detail };
      }
      case "ownership": {
        const r = await runOcio("fsops", ["safe", JSON.stringify({ state: C.state, rels: planRels })], {
          cg: CG.io,
          timeoutMs: 30_000,
        });
        if (r.json?.bad?.length)
          return { exit: "ownership", detail: JSON.stringify(r.json.bad).slice(0, 300) };
        return { rec: { checked: planRels.length } };
      }
      case "creds": {
        // credsync (plan §4.10): known = the CredStore manifest; the watcher reconciles at start.
        let man = null;
        try {
          man = await gate.call("GET", "/v1/creds/manifest", null, { timeoutMs: 15_000 });
        } catch (e) {
          log("creds-manifest-failed", { err: e.message });
        }
        // Plan §6.2 step 8: the store wins over the rootfs (archive, older snapshot) for every path it holds,
        // and its tombstones apply. Without it the reconcile scan rolled creds back (M4 loss drill).
        let restored = null;
        if (man) {
          restored = await restoreCreds({
            man,
            state: C.state,
            gate: { call: (m, r, b, o) => gate.call(m, r, b, o) },
            ocio: (n, a, o) => runOcio(n, a, { cg: CG.io, timeoutMs: 60_000, ...o }),
          });
          log("creds-restore", restored);
          if (!restored.ok)
            return { exit: "restore-blocked:infra", detail: `creds ${restored.why}`.slice(0, 300) };
        }
        const known = {};
        for (const f of man?.files || []) if (!f.deleted) known[f.path] = f.sha256;
        creds = new CredSync({
          root: C.state,
          gate: { call: (m, r, b, o) => gate.call(m, r, b, o) },
          mode: st.readOnly ? "read-only" : "write",
          varDir: C.varDir,
          known,
          seqBase: man?.seq ?? st.seq ?? 0,
          cgIo: CG.io,
          alert: (c, sv, d) => void gate.alert(c, sv, d),
          onIngress: (open) => (open ? admission.open("credsync-down") : admission.close("credsync-down")),
        });
        creds.on("watcher-exit", (e) => log("credsync-watcher-exit", e));
        creds.on("scan-done", (m) => log("credsync-scan", { n: m.n ?? null }));
        creds.on("ingress", (open) => log(open ? "credsync-up" : "credsync-down", {}));
        creds.start();
        return {
          rec: {
            mode: st.readOnly ? "read-only" : "write",
            known: Object.keys(known).length,
            put: restored?.put ?? null,
            del: restored?.del ?? null,
          },
        };
      }
      case "config": {
        const r = await configStep(bootCtx);
        if (bootCtx.cfg) {
          S.lastConfigWriteAt = bootCtx.cfg.writtenAt;
          // Non-OC_ SecretRef names of the rendered doc go to the gateway env (and its child scrub list).
          S.secretRefs = secretRefNames(bootCtx.cfg.rendered.doc);
        }
        return r;
      }
      case "doctor": {
        setPhase("doctor");
        const t0 = Date.now();
        const r = await doctorStep(bootCtx);
        log("doctor", {
          ms: Date.now() - t0,
          ...(r.rec || {}),
          exit: r.exit ?? null,
          detail: r.detail ?? null,
        });
        if (stopped()) return {};
        if (bootCtx.cfg) S.lastConfigWriteAt = bootCtx.cfg.writtenAt;
        return r;
      }
      case "litestream": {
        setPhase("replica");
        const c = await scanDbs();
        for (const a of c.alerts || []) void gate.alert(a.class, "warn", a.detail);
        ls = new Litestream({
          state: C.state,
          inst: C.inst,
          gen: C.gen,
          s3: { ...s3, bucket: plan.replica?.bucket || s3.bucket },
          cfgPath: path.join(C.runDir, "litestream.yml"),
          cgSys: CG.sys,
          tier: st.tier,
          levelsOverride: Object.keys(C.lsLevels).length ? C.lsLevels : undefined,
          legacyMeta: C.lsLegacyMeta || undefined,
        });
        ls.on("exit", (e) => log("litestream-exit", e));
        ls.on("start", (e) => {
          log("litestream-start", e);
          if (e.why !== "apply") marker.void(`litestream-start:${e.why}`);
        });
        ls.on("final", (e) => log("litestream-final-stop", e));
        ls.on("disk-full", (c) => void disk?.onChildError(c.line || "ENOSPC"));
        ls.on("fault", (f) => log("litestream-fault", f));
        // Classified Litestream lines (ltx-missing, sync-error, shutdown-sync-failed, disk-full, ...).
        // At most one per class per 10 s: a sync error repeats every second.
        const lineAt = {};
        ls.on("fault-line", (c) => {
          if (Date.now() - (lineAt[c.cls] || 0) < 10_000) return;
          lineAt[c.cls] = Date.now();
          log("litestream-line", {
            cls: c.cls,
            db: c.db,
            msg: c.msg,
            text: String(c.text || "").slice(0, 500),
          });
        });
        const pid = await ls.apply(c.managed || []);
        void gate.event("replica-set", { detail: { dbs: ls.dbs } });
        return { rec: { pid, dbs: ls.dbs } };
      }
      case "start-gate": {
        if (!ls?.dbs.length) return { rec: { skipped: "no dbs" } };
        if (!st.wait) {
          S.seeding = true;
          lsHoldNote = "seeding";
          setTimeout(() => seedWatch(seedCapMs(st.setBytes)), 0);
          return { rec: { seeding: true } };
        }
        const end = Date.now() + st.capMs;
        while (Date.now() < end && !stopped()) {
          await lagTick();
          if (ls.dbs.every((d) => (dbsRemote[d] || 0) > 0)) {
            // docs/13 "Wake database wait": the gen is seeded; Litestream stays down while the gateway admits
            // the agent database, and starts again at /startupz (onStarted), on SIGTERM or at the cap.
            if (C.lsAdmitHold && plan.replica?.admitHold !== false) {
              const r = await ls.hold("admit");
              lsHold = setTimeout(() => releaseLsHold("cap"), ADMIT_HOLD_CAP_MS);
              lsHold.unref?.();
              lsHoldNote = "held";
              log("ls-hold", { clean: r.clean, ms: r.ms, reason: r.reason });
            } else lsHoldNote = "off";
            return { rec: { seeded: true } };
          }
          await sleep(500);
        }
        if (stopped()) return {};
        return {
          exit:
            proxy.state.failures && !proxy.state.proofs ? "replica-blocked:infra" : "replica-blocked:local",
        };
      }
      case "gateway": {
        setPhase("gateway-start");
        const r = await doReap("pre-gateway");
        if (!r.ok) return { exit: r.reason };
        // D14: the oc-workers-cloudflare skill (what the gate gives the agent). Best effort: a failure never blocks boot.
        {
          const k = await runOcio(
            "skill-install",
            [
              JSON.stringify({
                src: SKILL_SRC,
                workspace: path.join(C.state, "workspace"),
                name: "oc-workers-cloudflare",
                remove: ["oc-host-cloudflare"],
              }),
            ],
            { cg: CG.io, timeoutMs: 10_000 },
          );
          if (!k.json?.ok)
            log("skill-install-failed", { err: k.json?.error || k.err?.slice(0, 200) || `exit ${k.code}` });
        }
        await gw.start("first");
        startStateTimers();
        cw = startConfigWatch(bootCtx, { canAct: () => !stopped() && !S.fenced });
        let gwRestart = null;
        guard = createRuntimeGuard({
          dirs: CG,
          plan,
          log,
          alert: (c, sv, d) => void gate.alert(c, sv, d),
          gatewayPid: () => gw.state.pid,
          gatewayUptimeMs: () => (gw.state.pid ? Date.now() - gw.state.startedAt : null),
          // One restart at a time; a hard kill during a graceful restart joins it (H21).
          restartGateway: ({ reason, hard }) => {
            if (gwRestart) return gwRestart;
            gwRestart = (async () => {
              await gw.stop({ capMs: hard ? 15_000 : 330_000, why: `guard:${reason}` });
              admission.reset();
              await gw.start(`guard:${reason}`);
            })().finally(() => {
              gwRestart = null;
            });
            return gwRestart;
          },
          beforeHardKill: () => gw.expectExit(),
          heapOverride: () => heapFault,
          heap: makeHeapReader(openclawCli(runCli, bootCtx.cliEnv), 2240 * 1024 ** 2),
          cliEnv: bootCtx.cliEnv,
          pluginManifest: bootCtx.cfg?.manifest ?? null,
          missingPlugins: bootCtx.cfg?.missingPlugins ?? [],
          isIdle: async () => {
            const b = await runOcio("cron-read", [path.join(C.state, "state", "openclaw.sqlite"), "busy"], {
              cg: CG.io,
              timeoutMs: 20_000,
            });
            const fresh = (b.json?.rows || []).filter(
              (r) => Date.now() - Number(r.started_at_ms) < 6 * 3600_000,
            );
            if (fresh.length) return { idle: false, why: "cron-running" };
            // Probe only: release the lease at once so a sleep prepare is not blocked (H22).
            const p = await suspendPrepare(`ocsup-guard-${iid}`);
            if (p.suspensionId) await suspendResume(p.suspensionId);
            if (p.status !== "ready") return { idle: false, why: `busy:${p.reason ?? ""}` };
            return { idle: true };
          },
          runCli: (args, o) => runCli(args, o),
          readProactive: async () => {
            const r = await runOcio(
              "cron-read",
              [path.join(C.state, "state", "openclaw.sqlite"), "proactive"],
              { cg: CG.io, timeoutMs: 20_000 },
            );
            return r.json?.ok ? r.json : null;
          },
          canAct: () =>
            !sigtermSeen &&
            !exiting &&
            !S.fenced &&
            !S.planned &&
            !["quiescing", "asleep-ready", "replica-down"].includes(S.phase),
        });
        guard.start();
        return { rec: { pid: gw.state.pid } };
      }
      default:
        return { exit: "supervisor", detail: `unknown step ${st.step}` };
    }
  }

  /** Shadow (15 min), archive (6 h, prod only), disk watch (30 s). Started after the gateway spawn. */
  function startStateTimers() {
    if (disk) return;
    disk = new DiskWatch({
      path: C.state,
      varDir: C.varDir,
      alert: (c, sv, d) => void gate.alert(c, sv, d),
      onDegraded: (on) => log("disk-degraded", { on }),
      // M4b N3: free < reserve → no archives, shadows or Litestream compaction; gateway stays up.
      onLow: (on, u) => {
        log("disk-low", { on, freeBytes: u?.freeBytes ?? null });
        if (on) void gate.alert("disk-full", "high", `free ${u?.freeBytes ?? "?"} B < reserve`);
        void ls?.setLowDisk(on).catch((e) => log("ls-lowdisk-error", { err: String(e) }));
      },
    });
    log("disk-reserve", disk.makeReserve());
    setInterval(() => {
      if (!stopped()) disk.check().catch((e) => log("disk-error", { err: String(e) }));
    }, 30_000).unref();
    // B3 (spec 08 §10.1 rule 3): gateway activity from the state DB (session events, channel traffic, cron
    // runs, deliveries; a running turn or job counts as now) → heartbeat lastActivityAt.
    let actBusy = false;
    const activityTick = async () => {
      // Only after /startupz: a reader on the state DB while the gateway creates or migrates it made every
      // CF boot exit 78 doctor-required (oc-m3-rt live, gens 1-13).
      if (actBusy || stopped() || S.fenced || !gw.running() || !gw.state.startupz) return;
      if (["quiescing", "asleep-ready", "draining"].includes(S.phase)) return;
      actBusy = true;
      try {
        const r = await runOcio(
          "sleep-read",
          [path.join(C.state, "state", "openclaw.sqlite"), String(Date.now())],
          { cg: CG.io, timeoutMs: 10_000 },
        );
        const at = r.json?.ok ? Number(r.json.lastActivityAtMs) : 0;
        if (at > 0 && at > (S.lastActivityAt || 0)) S.lastActivityAt = at;
        S.activeRuns = r.json?.ok ? (r.json.activeRuns ?? 0) : (S.activeRuns ?? 0);
      } catch (e) {
        log("activity-error", { err: String(e).slice(0, 200) });
      } finally {
        actBusy = false;
      }
    };
    setInterval(() => void activityTick(), Math.min(C.hbMs, 15_000)).unref();
    void activityTick();
    void disk.check().catch(() => {});
    shadow = new Shadow({
      state: C.state,
      varDir: C.varDir,
      cgIo: CG.io,
      putRaw: (route, buf, headers) => gate.putRaw(route, buf, headers),
      alert: (c, sv, d) => void gate.alert(c, sv, d),
    });
    // C1 (M4): the shadow clock counts from the newest shadow upload (plan.shadowAt), not from this ocsup
    // start, and a round runs at each gateway start when that one is older than SHADOW_EVERY_MS.
    lastShadowAt = Number.isInteger(plan?.shadowAt) ? plan.shadowAt : null;
    let shadowBusy = false;
    const shadowTick = () => {
      if (shadowBusy || stopped() || S.fenced || ["quiescing", "asleep-ready"].includes(S.phase)) return;
      if (!gw.state.startupz || !shadowDue(lastShadowAt, Date.now())) return;
      shadowBusy = true;
      void shadowRound(lastShadowAt === null ? "start" : "timer")
        .catch((e) => log("shadow-error", { err: String(e) }))
        .finally(() => {
          shadowBusy = false;
        });
    };
    setInterval(shadowTick, 15_000).unref();
    archiver = new Archiver({
      gate: { call: (m, r, b, o) => gate.call(m, r, b, o) },
      varDir: C.varDir,
      prepOut: (d) => ensureUid1000Dir(d), // root makes the uid-1000 output dir in its 0711 tree
      // L5: online archives read a shadow tree (bk-s), never the live DBs.
      shadow: async () => {
        const into = path.join(C.varDir, "bk-s");
        ensureUid1000Dir(into);
        const t = await runOcio(
          "shadow-tree",
          [JSON.stringify({ state: C.state, out: into, managed: ls?.dbs || [] })],
          { cg: CG.io, timeoutMs: 300_000 },
        );
        if (!t.json?.ok) return { ok: false, why: t.json?.why || `ocio exit ${t.code}` };
        if (ls?.dbs.length) {
          const v = await verifyGen({
            state: C.state,
            varDir: C.varDir,
            runDir: C.runDir,
            inst: C.inst,
            gen: C.gen,
            dbs: ls.dbs,
            into,
            s3: { ...s3, bucket: plan?.replica?.bucket || s3.bucket },
            cg: CG.sys,
            timeoutMs: 120_000,
            ocio: (n, a, o) => runOcio(n, a, { timeoutMs: 30_000, ...o, cg: CG.io }),
          });
          if (!v.ok)
            return { ok: false, why: `replica ${v.reason} ${v.rel ?? ""} ${v.why ?? ""}`.slice(0, 300) };
        }
        return {
          ok: true,
          env: { OPENCLAW_STATE_DIR: into, OPENCLAW_CONFIG_PATH: path.join(into, "openclaw.json") },
        };
      },
      shadowDone: () =>
        runOcio("fsops", ["empty", JSON.stringify({ dirs: [path.join(C.varDir, "bk-s")] })], {
          cg: CG.io,
          timeoutMs: 60_000,
        }).catch(() => undefined),
      cgIo: CG.io,
      alert: (c, sv, d) => void gate.alert(c, sv, d),
    });
    if (plan.mode === "prod")
      setInterval(() => {
        if (stopped() || S.fenced || ["quiescing", "asleep-ready"].includes(S.phase)) return;
        if (disk?.low) return; // M4b N3: no archive while free space is under the reserve
        if (archiver.due()) void archiver.run("online", "6h").then((a) => log("archive", a));
      }, 60_000).unref();
    if (plan.mode === "prod")
      importer = createImporter({
        gate: { fetchRaw: (r, x) => gate.fetchRaw(r, x), call: (m, r, b, x) => gate.call(m, r, b, x) },
        state: C.state,
        varDir: C.varDir,
        ocio: (n, a, x) => runOcio(n, a, { ...x, cg: CG.io }),
        cli: (a, x) => runCli(a, x),
        ready: () => !!gw.state.startupz && !stopped() && !S.fenced,
        chownForOcio: (f) => fs.chownSync(f, 0, 1000), // root's 0711 varDir; ocio reads it through group 1000
        log,
      });
    if (importer && pendingImport && importer.kick(pendingImport)) log("import-kick", { id: pendingImport.id, held: true });
    pendingImport = null;
  }

  async function seedWatch(capMs) {
    const end = Date.now() + capMs;
    while (Date.now() < end && !stopped()) {
      if (ls?.dbs.every((d) => (dbsRemote[d] || 0) > 0)) {
        S.seeding = false;
        void gate.event("seeded", {});
        if (S.phase === "seeding") setPhase("running");
        return;
      }
      await sleep(1000);
    }
    if (!stopped() && S.seeding) {
      S.seeding = false;
      S.rpo = "down";
      void gate.alert("replica-down", "high", "seed cap passed");
    }
  }

  let fault = { stage: "ok" };
  async function replicaFaultRule() {
    if (!ls || stopped() || S.seeding || S.phase === "quiescing" || S.phase === "asleep-ready") return;
    // A full disk is never replica-down (Z0.4): the disk path owns it.
    if (disk?.degraded || ls.lastExit?.cls === "disk-full") {
      if (fault.stage !== "disk-full") {
        log("replica-stage", { from: fault.stage, to: "disk-full" });
        fault = { stage: "disk-full", at: Date.now() };
        void disk?.onChildError("ENOSPC (litestream)");
      }
      return;
    }
    // H15: the fault clock runs from the first unplanned exit until Litestream stays up (not per spawn).
    const stage = faultStage(ls.lag.overdueMs(), {
      lsDown: ls.downForMs() > 0,
      downForMs: ls.downForMs(),
      at: plan?.timers?.replicaFault,
    });
    if (stage === fault.stage) return;
    log("replica-stage", { from: fault.stage, to: stage });
    const prev = fault.stage;
    fault = { stage, at: Date.now() };
    if (stage === "ok" || stage === "late") {
      if (prev !== "late") admission.open("replica-fault");
      if (S.rpo === "down" && stage === "ok") {
        S.rpo = "ok";
        void gate.event("replica-up", {});
        if (!gw.running() && !S.fenced) {
          setPhase("gateway-start");
          await gw.start("replica-up");
        }
      }
      return;
    }
    admission.close("replica-fault");
    if (stage === "gateway-stop") {
      S.rpo = "down";
      setPhase("replica-down");
      void gate.event("replica-down", {});
      await gw.stop({ capMs: 330_000, why: "replica-down" });
    }
    if (stage === "replica-down") {
      const infra = proxy.state.failures > 0 && proxy.state.lastWhy;
      return fail(infra ? "replica-down:infra" : "replica-down:local");
    }
  }
}
