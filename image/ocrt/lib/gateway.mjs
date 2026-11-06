// Gateway spawn and supervision (plan §4.2, §4.7; amend §2 rows 19, 20, 22; M0 setpriv/preload fix).
// argv: sh -c '<prelude>; exec "$@"' sh setpriv --reuid=1000 ... -- env LD_PRELOAD=... node --import unpreload ...
// The preload goes AFTER the uid drop: setpriv aborts (SIGABRT) when jemalloc with background_thread
// is preloaded into it (M0). New session (setsid via detached) in cgroup ocrt/gw/main, oom +500.
import fs from "node:fs";
import { BIN } from "./bins.mjs";
import { gatewayExitClass } from "./lock.mjs";
import { spawnPrelude } from "./oom.mjs";
import { SQLITE_SUSPECT_RE } from "./sqlite-check.mjs";

export const GW_PORT = 18789;
export const JEMALLOC = "/usr/lib/x86_64-linux-gnu/libjemalloc.so.2";
export const MALLOC_CONF = "background_thread:true,dirty_decay_ms:10000,muzzy_decay_ms:10000";
export const NODUMP = "/opt/ocrt/nodump.so"; // scope §1.1 "Image": prctl(PR_SET_DUMPABLE,0) preload
export const CF_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const BACKOFF_S = [1, 2, 5, 10, 30];
export const CRASH_LOOP = { n: 5, windowMs: 15 * 60_000 };
/** M4b N3: wait between gateway starts while the disk is full (not counted as crashes). */
export const DISK_FULL_RETRY_MS = 30_000;
export const STOP_CAP_MS = 330_000;
export const UNPRELOAD = "/opt/ocrt/unpreload.mjs";

/** Node args for an ocsup CLI child: the scrub preload first (M5), unless already there or absent. */
export function cliNodeArgs(args, preload = UNPRELOAD) {
  if (!preload || args.includes(preload) || args.includes(`--import=${preload}`)) return args;
  return ["--import", preload, ...args];
}

/** Names of env SecretRefs in a rendered config: {source:"env", id} objects and "${VAR}" strings. */
export function secretRefNames(doc) {
  const out = new Set();
  const walk = (v, d) => {
    if (d > 40 || v === null || v === undefined) return;
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([A-Z_][A-Z0-9_]{0,127})\}/g)) out.add(m[1]);
      return;
    }
    if (typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, d + 1);
      return;
    }
    if (v.source === "env" && typeof v.id === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.id))
      out.add(v.id);
    for (const x of Object.values(v)) walk(x, d + 1);
  };
  walk(doc, 0);
  return [...out].sort();
}

/**
 * Gateway env (plan §4.2 "Rules", amend §2 row 20). src = ocsup's env snapshot taken at start (before
 * OCRT_* were deleted). Passes: base vars, every OC_* (SecretRef env set by the DO), the names the
 * rendered config references (refs), OPENCLAW_GATEWAY_TOKEN alias, and NODE_EXTRA_CA_CERTS when the
 * CF intercept CA exists. Never OCRT_* or AWS_*. localPassword (rendered auth mode trusted-proxy):
 * OPENCLAW_GATEWAY_PASSWORD = the gateway token instead of OPENCLAW_GATEWAY_TOKEN. OCHOST_SCRUB = the
 * non-OC_ ref names; the gateway's preload drops them (and OC_*, the gateway token/password) from its children.
 * OCHOST_REFS = all SecretRef names (OC_* and refs); children get each back as a placeholder value (M5).
 */
export function gatewayEnv(
  src,
  { refs = [], caFile = CF_CA, caExists = (f) => fs.existsSync(f), extra = {}, localPassword = false } = {},
) {
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: src.LANG || "C.UTF-8",
    TZ: src.TZ || "UTC",
    NODE_ENV: "production",
    HOME: "/home/node",
    USER: "node",
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
  for (const [k, v] of Object.entries(src)) if (k.startsWith("OC_")) env[k] = v;
  for (const k of refs)
    if (src[k] !== undefined && !k.startsWith("OCRT_") && !k.startsWith("AWS_")) env[k] = src[k];
  if (localPassword) {
    // trusted-proxy (M3 e2e, 2026.10.9): the gateway refuses to start with a shared token set ("trusted-proxy
    // and token auth are mutually exclusive"), and a local client must use the password. Same secret.
    delete env.OPENCLAW_GATEWAY_TOKEN;
    if (env.OC_GATEWAY_TOKEN) env.OPENCLAW_GATEWAY_PASSWORD = env.OC_GATEWAY_TOKEN;
  } else if (env.OC_GATEWAY_TOKEN && !env.OPENCLAW_GATEWAY_TOKEN)
    env.OPENCLAW_GATEWAY_TOKEN = env.OC_GATEWAY_TOKEN;
  if (caFile && caExists(caFile)) env.NODE_EXTRA_CA_CERTS = caFile;
  // M3-1: unpreload.mjs scrubs these names (plus OC_*, OPENCLAW_GATEWAY_*) from every gateway child.
  const scrub = refs.filter((k) => env[k] !== undefined && !k.startsWith("OC_"));
  if (scrub.length) env.OCHOST_SCRUB = scrub.join(",");
  // M5: children get these names back as a placeholder (unpreload.mjs), so `openclaw` in the agent's exec
  // loads the config without "missing env var". Every OC_* plus the rendered refs.
  const names = [...new Set([...Object.keys(env).filter((k) => k.startsWith("OC_")), ...scrub])].sort();
  if (names.length) env.OCHOST_REFS = names.join(",");
  // M4b S1/S2: nodump.so scrubs every exec*()/posix_spawn*() env in the gateway and all its descendants
  // (node-pty and spawn paths the unpreload.mjs hook does not see). ocsup's own env never has it.
  env.OCHOST_EXEC_SCRUB = "1";
  return { ...env, ...extra };
}

/** Full spawn argv for the gateway (and for uid-1000 CLI children with role "cli"). Absolute sh, setpriv,
 *  env (F-SEC-1); `cmd` must be absolute too (callers pass BIN.node). */
export function buildCommand({
  cmd,
  args = [],
  cg,
  role = "gateway",
  uid1000 = true,
  jemalloc = true,
  nodump = true,
  exists = (f) => fs.existsSync(f),
}) {
  const pre = [...spawnPrelude({ cg, role }), uid1000 ? "umask 022" : "umask 077"];
  let argv = [cmd, ...args];
  const preload = [];
  if (jemalloc && exists(JEMALLOC)) preload.push(JEMALLOC);
  if (nodump && exists(NODUMP)) preload.push(NODUMP);
  if (preload.length) {
    const e = [`LD_PRELOAD=${preload.join(":")}`];
    if (preload.includes(JEMALLOC)) e.push(`MALLOC_CONF=${MALLOC_CONF}`);
    argv = [BIN.env, ...e, ...argv];
  }
  if (uid1000) argv = [BIN.setpriv, "--reuid=1000", "--regid=1000", "--init-groups", "--", ...argv];
  return [BIN.sh, ["-c", `${pre.join("; ")}; exec "$@"`, "sh", ...argv]];
}

/** True when /proc/<pid>/environ is root-owned while the process runs as uid 1000 (non-dumpable). */
export function nonDumpable(pid, procRoot = "/proc") {
  try {
    const st = fs.statSync(`${procRoot}/${pid}/environ`);
    const uid = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`${procRoot}/${pid}/status`, "utf8"))?.[1];
    return uid === "1000" ? st.uid === 0 : null;
  } catch {
    return null;
  }
}

/** startupz body check: plan §5.3 wants status=="started"; 2026.10.9 also answers {"ok":true}. */
export const startupzOk = (status, body) =>
  status === 200 && (/"status"\s*:\s*"started"/.test(body) || /"ok"\s*:\s*true/.test(body));

/**
 * createGateway(deps) -> {start, stop, state}. deps:
 *  spawn(cmd, argv, opts) -> child; argv() -> [cmd, args]; env() -> env; fetch; now; sleep; log;
 *  event(kind, extra); canStart() -> bool (sigtermSeen/fenced/quiescing check);
 *  onFatal(reason) (exit path: doctor-required, gateway-crash-loop); onStarted(ms);
 *  afterExit() -> Promise (termTree + reap; returns {ok, reason}); kill(pid, sig).
 */
export function createGateway(deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const kill = deps.kill || ((pid, sig) => process.kill(pid, sig));
  const st = {
    pid: 0,
    child: null,
    startedAt: 0,
    starts: 0,
    restarts: [],
    startupz: false,
    startupzMs: null,
    lastExit: null,
    stopping: false,
    tail: [],
    pendingRestart: null,
  };
  let exitWaiters = [];

  function pushTail(line) {
    st.tail.push(line);
    if (st.tail.length > 40) st.tail.shift();
  }

  async function start(kind = "first") {
    if (st.child || !deps.canStart()) return { started: false, why: st.child ? "running" : "blocked" };
    if (kind !== "first" && deps.beforeRestart) {
      const r = await deps.beforeRestart(kind);
      if (r && r.ok === false) return { started: false, why: r.reason };
      if (!deps.canStart()) return { started: false, why: "blocked" };
    }
    void deps.event?.("gateway-starting", { reason: kind });
    const [cmd, args] = deps.argv();
    const child = deps.spawn(cmd, args, {
      env: deps.env(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      cwd: "/home/node",
    });
    st.child = child;
    st.pid = child.pid;
    st.startedAt = now();
    st.starts++;
    st.startupz = false;
    st.tail = [];
    st.stopping = false;
    deps.log?.("gateway-start", { kind, pid: child.pid });
    for (const s of [child.stdout, child.stderr]) {
      if (!s) continue;
      let buf = "";
      s.on("data", (d) => {
        buf += d;
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) {
            pushTail(line.slice(0, 2000));
            deps.onLine?.(line);
          }
          i = buf.indexOf("\n");
        }
      });
    }
    child.on("exit", (code, signal) => onExit(child, code, signal));
    if (deps.fetch) void pollStartupz(child);
    return { started: true, pid: child.pid };
  }

  async function pollStartupz(child) {
    while (st.child === child && !st.startupz) {
      try {
        const r = await deps.fetch(`http://127.0.0.1:${GW_PORT}/startupz`, {
          signal: AbortSignal.timeout(1000),
        });
        const b = await r.text();
        if (startupzOk(r.status, b)) {
          st.startupz = true;
          st.startupzMs = now() - st.startedAt;
          deps.log?.("startupz", { ms: st.startupzMs });
          deps.onStarted?.(st.startupzMs);
          return;
        }
      } catch {}
      await sleep(250);
    }
  }

  function onExit(child, code, signal) {
    if (st.child !== child) return;
    const uptimeMs = now() - st.startedAt;
    st.child = null;
    st.pid = 0;
    const cls = gatewayExitClass({ code, signal, tail: st.tail.join("\n"), uptimeMs });
    st.lastExit = { code, signal, uptimeMs, cls: cls.kind, at: now() };
    deps.log?.("gateway-exit", st.lastExit);
    void deps.event?.("gateway-exit", { code, reason: cls.kind });
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const w of waiters) w(st.lastExit);
    if (st.stopping) return;
    // unexpected exit
    if (cls.kind === "doctor-required") {
      // A schema error can end in exit 78: check the DBs first, so corruption exits `sqlite-corrupt`.
      const t = st.tail.join("\n");
      if (deps.onSqliteSuspect && SQLITE_SUSPECT_RE.test(t))
        return void deps.onSqliteSuspect(t).then((r) => (r?.fatal ? null : deps.onFatal("doctor-required")));
      return deps.onFatal("doctor-required");
    }
    let waitMs;
    // M4b N3: disk full (exit text, or the disk watch says so): restart slowly, never count to the crash loop,
    // so ocsup keeps the container (and its rootfs writes) up until space is back.
    const diskFull = cls.kind === "disk-full" || !!deps.diskFull?.();
    if (cls.kind === "lock-wait")
      waitMs = cls.waitMs; // not a crash (M0 fix)
    else if (diskFull) {
      waitMs = DISK_FULL_RETRY_MS;
      deps.log?.("gateway-exit-disk-full", { waitMs });
    } else {
      st.restarts.push(now());
      st.restarts = st.restarts.filter((t) => now() - t < CRASH_LOOP.windowMs);
      if (st.restarts.length >= CRASH_LOOP.n) return deps.onFatal("gateway-crash-loop");
      waitMs = BACKOFF_S[Math.min(st.restarts.length - 1, BACKOFF_S.length - 1)] * 1000;
      if (cls.kind === "heap-abort") deps.alert?.("heap-abort", "warn", `gateway ${code ?? signal}`);
    }
    st.pendingRestart = { at: now() + waitMs, why: cls.kind };
    deps.onUnexpectedExit?.(st.lastExit, waitMs);
    const tail = st.tail.join("\n");
    void (async () => {
      await (deps.afterExit ? deps.afterExit("gateway-exit") : null);
      // M4b N1+N2: SQLite corruption or schema text in the log → quick_check before any restart.
      if (deps.onSqliteSuspect && SQLITE_SUSPECT_RE.test(tail)) {
        const r = await deps.onSqliteSuspect(tail);
        if (r?.fatal) {
          st.pendingRestart = null;
          return;
        }
      }
      await sleep(waitMs);
      st.pendingRestart = null;
      if (deps.canStart()) await start(cls.kind === "lock-wait" ? "lock-retry" : "restart");
    })();
  }

  /** Graceful stop: SIGTERM the pid, wait (cap), SIGKILL the group on cap; then afterExit (tree + reap). */
  async function stop({ capMs = STOP_CAP_MS, why = "stop" } = {}) {
    st.stopping = true;
    const child = st.child;
    const t0 = now();
    deps.log?.("gateway-stop", { why, pid: child?.pid ?? 0 });
    if (!child) {
      const r = deps.afterExit ? await deps.afterExit(`stop:${why}`) : { ok: true };
      return {
        clean: true,
        code: st.lastExit?.code ?? null,
        signal: st.lastExit?.signal ?? null,
        ms: 0,
        wasRunning: false,
        reap: r,
      };
    }
    const exited = new Promise((r) => exitWaiters.push(r));
    try {
      kill(child.pid, "SIGTERM");
    } catch {}
    let timer;
    const res = await Promise.race([exited, new Promise((r) => (timer = setTimeout(() => r(null), capMs)))]);
    clearTimeout(timer);
    let ex = res;
    if (!ex) {
      try {
        kill(-child.pid, "SIGKILL");
      } catch {}
      ex = await Promise.race([exited, sleep(5000).then(() => null)]);
    }
    const r = deps.afterExit ? await deps.afterExit(`stop:${why}`) : { ok: true };
    const clean = !!res && res.code === 0 && !res.signal;
    return {
      clean,
      capped: !res,
      code: ex?.code ?? null,
      signal: ex?.signal ?? null,
      ms: now() - t0,
      wasRunning: true,
      reap: r,
    };
  }

  /** SIGKILL the whole process group now (self-fence on stale). */
  function killNow() {
    st.stopping = true;
    if (st.child)
      try {
        kill(-st.child.pid, "SIGKILL");
      } catch {}
  }

  /** The next exit is planned (memwatch hard kill): no crash count, no auto restart. */
  function expectExit() {
    st.stopping = true;
  }

  return { start, stop, killNow, expectExit, state: st, running: () => !!st.child };
}
