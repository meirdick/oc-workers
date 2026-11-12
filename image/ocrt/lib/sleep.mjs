// Sleep op phases in ocsup (addendum §2.6, §2.9 "ocsup"; amend §1.5 F1.6, §1.6 S4, §3 rows
// "T7e row 11", "row 14", "row 19"). The Runtime DO drives the op; each phase is one idempotent
// ocsupctl call keyed by opId. Order: check -> prepare -> [cancel] -> stop-gateway -> flush.
// resume-after-sleep is the one abort path after phase 2. SIGTERM wins over every phase.

export const CONFIG_QUIET_MS = 60_000; // amend T7e row 19 (b)
export const FLUSH_LAG_CAP_MS = 60_000;
export const LS_EXIT_CAP_MS = 10_000;
export const CREDS_CAP_MS = 30_000;
export const STOP_GW_CAP_MS = 330_000;
const CHANNEL_UNSETTLED = new Set(["starting", "recovering"]);

// Transports that mean an inbound HTTP route and no socket: Telegram "webhook", Slack (mode "http"), and
// "interactions" for a Discord interactions route (guess: 2026.10.9 has none, so a live Discord account stays socket).
const WEBHOOK_MODES = new Set(["webhook", "http", "interactions"]);
// Channels with no socket transport at all. Their status snapshot carries no `mode` (SMS: Twilio webhook only).
const WEBHOOK_ONLY = new Set(["sms"]);

/** "webhook" for an account that only receives over an HTTP route (the inbox adapters can ack it), else as reported. */
export function transportOf(channel, a) {
  const t = a.transport ?? a.mode ?? (a.webhookUrl ? "webhook" : undefined);
  if (WEBHOOK_MODES.has(t)) return "webhook";
  if (t === undefined && WEBHOOK_ONLY.has(channel)) return "webhook";
  return t;
}

/**
 * channels.status reply (2026.10.9, read on oc-demo 2026-11-01): {channelAccounts: {<channel>: [account]}},
 * account {accountId, running, lifecycle, restartPending, mode: "webhook"|"polling", ...}. No channel
 * configured = {channelAccounts: {}} = []. Returns null when the reply has no channelAccounts map.
 */
export function channelAccountsOf(j) {
  if (!j || typeof j !== "object" || !j.channelAccounts || typeof j.channelAccounts !== "object") return null;
  const out = [];
  for (const [channel, list] of Object.entries(j.channelAccounts))
    for (const a of Array.isArray(list) ? list : Object.values(list || {}))
      out.push({
        channel,
        ...a,
        transport: transportOf(channel, a),
      });
  return out;
}

/** JSON object in CLI output that also holds stderr: try the first "{", then each line that opens one. */
function cliJson(out) {
  const s = String(out || "");
  const at = [];
  if (s.indexOf("{") >= 0) at.push(s.indexOf("{"));
  for (let i = s.indexOf("\n{"); i >= 0; i = s.indexOf("\n{", i + 1)) at.push(i + 1);
  for (const i of at)
    try {
      return JSON.parse(s.slice(i));
    } catch {}
  return null;
}

/**
 * Accounts from one `openclaw gateway call channels.status --json` run ({code, signal, out}).
 * Throws with the CLI text when the call failed or the reply has no channelAccounts: check() turns
 * that into channels-unknown. An empty list is a good answer (no channel), not a failure.
 */
export function channelsFromCli(r) {
  const j = cliJson(r?.out);
  const acc = channelAccountsOf(j?.result ?? j);
  if (acc) return acc;
  const tail =
    String(r?.out || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(-200) || "no output";
  const why =
    r?.code === 0
      ? "reply without channelAccounts"
      : `exit ${r?.code ?? "?"}${r?.signal ? ` ${r.signal}` : ""}`;
  throw new Error(`channels.status ${why}: ${tail}`);
}

/**
 * Channel blockers (amend T7e row 19 (a); add §2.6 phase 1). accounts: [{channel, accountId, running,
 * lifecycle, restartPending, transport}]. Missing fields on a running account = blocker (unknown).
 * The gateway stays up only for a running channel that needs a socket: [] (no channel) and
 * webhook-only accounts give no blocker. accounts not an array = the check failed: channels-unknown
 * with `error` as detail. managedWebhook(acc) -> true when the transport is the managed webhook route.
 */
export function channelBlockers(
  accounts,
  { managedWebhook = (a) => a.transport === "webhook", error = null } = {},
) {
  const out = [];
  if (!Array.isArray(accounts))
    return [{ kind: "channels-unknown", detail: error ? String(error).slice(0, 300) : "no channel status" }];
  for (const a of accounts) {
    const id = `${a.channel ?? "?"}:${a.accountId ?? "default"}`;
    if (a.running === false) continue;
    if (a.lifecycle === undefined || a.restartPending === undefined)
      out.push({ kind: "channel-unknown", detail: id });
    else if (CHANNEL_UNSETTLED.has(a.lifecycle) || a.restartPending === true)
      out.push({
        kind: "channel-unsettled",
        detail: `${id} ${a.lifecycle}${a.restartPending ? " restartPending" : ""}`,
      });
    if (!managedWebhook(a))
      out.push({ kind: "channel-socket", detail: `${id} transport ${a.transport ?? "unknown"}` });
  }
  return out;
}

/** Rule-6 rows and other local blockers (add §2.5 rule 6). rows from the read-only state query. */
export function rowBlockers(rows = {}) {
  const b = [];
  if (rows.cronRunning > 0) b.push({ kind: "cron-running", detail: rows.cronRunning });
  if (rows.openIngress > 0) b.push({ kind: "ingress-open", detail: rows.openIngress });
  if (rows.pendingDelivery > 0) b.push({ kind: "delivery-pending", detail: rows.pendingDelivery });
  if (rows.a2aWorking > 0) b.push({ kind: "a2a-working", detail: rows.a2aWorking });
  for (const j of rows.eventJobs || []) b.push({ kind: "event-job", detail: j.id ?? j });
  if (rows.error) b.push({ kind: "rows-unknown", detail: rows.error });
  return b;
}

const TERMINAL = new Set(["done", "aborted", "failed", "interrupted:sigterm"]);

/**
 * createSleepOps(deps). deps:
 *  draining() -> bool; now();
 *  queryRows() -> {cronRunning, openIngress, pendingDelivery, a2aWorking, eventJobs, nextWakeAtMs, error?}
 *  channelsStatus() -> accounts[] (throws when the check failed); event?(kind, {reason, detail}); seeding() -> bool; replicaFault() -> string|null;
 *  lastConfigChangeAt() -> ms|null;
 *  suspendPrepare() -> {status:"ready"|"busy", retryAfterMs}; suspendResume() -> {ok};
 *  gateway: {stop({capMs, why}) -> {clean, code, signal, ms}, start(kind), running(), waitStartupz(capMs) -> ms|null};
 *  postExitRead() -> {openRows, eventJobs, nextWakeAtMs};
 *  replica: {waitLagZero(capMs) -> {ok, lag}, stopFinal({capMs}) -> {clean, detail}, start({sameGen:true}),
 *            waitLagUnder(capMs) -> {ok}, perDb() -> {txid, bytes, lastWriteAt}};
 *  creds: {flush({capMs}) -> {ok, detail}, restart()}; shadowFlush() -> {ok, results}; sync();
 *  exportWakeAllow(); archiveIfDue(); marker?: MarkerGuard (lib/marker.mjs);
 *  alert(cls, sev, detail); log(ev, f); setPhase(name)
 */
export function createSleepOps(deps) {
  const now = deps.now || Date.now;
  let cur = null; // {opId, phase, state, results:{}, gwStopped, lsStopped, inflight: Promise|null}

  const setState = (x) => {
    if (cur && cur.state !== "interrupted:sigterm") cur.state = x;
  };
  const phaseTo = (x) => {
    if (cur?.state !== "interrupted:sigterm") deps.setPhase?.(x);
  };
  const busy = () => ({ ok: false, error: "busy", detail: { opId: cur?.opId, phase: cur?.phase } });
  const wrong = (want) => ({ ok: false, error: "wrong-phase", detail: { want, have: cur?.phase ?? null } });

  function open(opId) {
    // "done" (flushed, gateway down) holds until the DO destroys the container or resumes this op.
    // An op that only ran check holds nothing (no lease, gateway up): a new op id replaces it, so a DO
    // that dropped an op after its check cannot block the next one.
    const onlyChecked = cur && !cur.inflight && !cur.results.prepare && cur.state === "running";
    if (cur && cur.opId !== opId && !onlyChecked && (!TERMINAL.has(cur.state) || cur.state === "done"))
      return false;
    if (!cur || cur.opId !== opId)
      cur = {
        opId,
        phase: null,
        state: "running",
        results: {},
        gwStopped: false,
        lsStopped: false,
        at: now(),
      };
    return true;
  }
  async function run(phase, fn) {
    if (cur.results[phase]) return cur.results[phase]; // idempotent per op id
    if (cur.inflight) return busy();
    cur.phase = phase;
    phaseTo("quiescing");
    deps.log?.("sleep-phase", { opId: cur.opId, phase });
    cur.inflight = fn();
    let r;
    try {
      r = await cur.inflight;
    } catch (e) {
      r = { ok: false, error: "failed", detail: String(e?.message || e) };
    }
    cur.inflight = null;
    if (cur.state === "interrupted:sigterm") return { ok: false, error: "draining" };
    cur.results[phase] = r;
    return r;
  }

  async function check() {
    const blockers = [];
    const rows = (await deps.queryRows().catch((e) => ({ error: String(e?.message || e) }))) || {};
    blockers.push(...rowBlockers(rows));
    let chErr = null;
    const ch = await deps.channelsStatus().catch((e) => {
      chErr = String(e?.message || e);
      return null;
    });
    const cb = channelBlockers(ch, { error: chErr });
    const unknown = cb.find((b) => b.kind === "channels-unknown");
    if (unknown) {
      deps.log?.("sleep-check-channels", { error: unknown.detail });
      deps.event?.("sleep-check-channels", { reason: "channels-unknown", detail: { error: unknown.detail } });
    }
    blockers.push(...cb);
    if (deps.seeding?.()) blockers.push({ kind: "seeding" });
    const rf = deps.replicaFault?.();
    if (rf) blockers.push({ kind: "replica-fault", detail: rf });
    const cfg = deps.lastConfigChangeAt?.();
    if (cfg && now() - cfg < CONFIG_QUIET_MS) blockers.push({ kind: "config-recent", detail: now() - cfg });
    if (!deps.gateway.running()) blockers.push({ kind: "gateway-down" });
    const r = {
      ok: true,
      blockers,
      nextWakeAtMs: rows.nextWakeAtMs ?? null,
      eventJobs: rows.eventJobs || [],
      channels: ch || [],
    };
    if (blockers.length) setState("aborted"); // no change made; the DO aborts
    phaseTo("running"); // check changes nothing; quiescing starts at prepare
    return r;
  }

  async function prepare() {
    const r = await deps.suspendPrepare();
    if (r.status !== "ready") {
      setState("aborted");
      phaseTo("running");
      return { ok: true, status: "busy", retryAfterMs: r.retryAfterMs ?? null };
    }
    cur.prepared = true;
    return { ok: true, status: "ready", retryAfterMs: null };
  }

  async function stopGateway() {
    const s = await deps.gateway.stop({ capMs: STOP_GW_CAP_MS, why: "sleep" });
    cur.gwStopped = true;
    if (!s.clean) {
      setState("failed");
      deps.alert?.("sleep-unclean-exit", "warn", `code ${s.code} signal ${s.signal} capped ${!!s.capped}`);
      return {
        ok: false,
        error: "sleep-unclean-exit",
        clean: false,
        code: s.code,
        signal: s.signal,
        ms: s.ms,
      };
    }
    const pe = (await deps.postExitRead().catch((e) => ({ error: String(e?.message || e) }))) || {};
    const r = {
      ok: true,
      clean: true,
      code: s.code,
      signal: s.signal,
      ms: s.ms,
      openRows: pe.openRows ?? 0,
      eventJobs: pe.eventJobs || [],
      nextWakeAtMs: pe.nextWakeAtMs ?? null,
    };
    if (pe.error) Object.assign(r, { ok: false, error: "failed", detail: `post-exit read: ${pe.error}` });
    if (r.openRows > 0 || r.eventJobs.length) setState("aborted"); // DO aborts through resume-after-sleep
    return r;
  }

  async function flush() {
    const fail = (detail) => {
      setState("failed");
      deps.alert?.("sleep-flush-failed", "warn", detail);
      return { ok: false, error: "sleep-flush-failed", detail };
    };
    const lag = await deps.replica.waitLagZero(FLUSH_LAG_CAP_MS);
    if (!lag.ok)
      return fail(`litestream lag ${JSON.stringify(lag.lag ?? null)} after ${FLUSH_LAG_CAP_MS} ms`);
    const ls = await deps.replica.stopFinal({ capMs: LS_EXIT_CAP_MS });
    cur.lsStopped = true;
    if (!ls.clean) return fail(`litestream final: ${ls.detail ?? "unclean"}`);
    const cr = await deps.creds.flush({ capMs: CREDS_CAP_MS });
    if (!cr.ok) return fail(`creds: ${cr.detail ?? "cap"}`);
    let shadows = [];
    if (deps.shadowFlush) {
      const sh = await deps.shadowFlush();
      if (sh && sh.ok === false) return fail(`shadow: ${sh.detail ?? "failed"}`);
      shadows = sh?.results || [];
    }
    await deps.sync?.();
    if (deps.exportWakeAllow) await deps.exportWakeAllow();
    const archive = deps.archiveIfDue ? await deps.archiveIfDue() : null;
    if (archive && archive.ok === false) return fail(`archive: ${archive.detail ?? "failed"}`);
    const per = await deps.replica.perDb();
    let reply = {
      ok: true,
      nextWakeAtMs: cur.results["stop-gateway"]?.nextWakeAtMs ?? null,
      txidPerDb: per.txid,
      bytesPerDb: per.bytes,
      lastWriteAtPerDb: per.lastWriteAt,
      archive: archive || null,
    };
    if (deps.marker) {
      // Clean-marker guard (amend F1.6, F1.7): ok only on lag 0, clean final stop, creds, shadows.
      const m = deps.marker.flush({
        opId: cur.opId,
        lag: (lag.lag || []).map((d) => ({ ...d, localTxid: per.txid?.[d.db] ?? d.localTxid })),
        ls,
        creds: cr,
        shadows,
        bytesPerDb: per.bytes,
        lastWriteAtPerDb: per.lastWriteAt,
        nextWakeAtMs: reply.nextWakeAtMs,
        archive: reply.archive,
      });
      if (!m.ok) return fail(Array.isArray(m.detail) ? m.detail.join("; ") : String(m.detail));
      reply = m;
    }
    setState("done");
    phaseTo("asleep-ready");
    return reply;
  }

  /** Abort path (add §2.6). Same gen; no Doctor. */
  async function resume() {
    if (!cur) return { ok: true, noop: true };
    if (cur.inflight) await cur.inflight.catch(() => {});
    if (cur.state === "interrupted:sigterm") return { ok: false, error: "draining" };
    const t0 = now();
    if (!cur.gwStopped) {
      if (cur.prepared) await deps.suspendResume();
    } else {
      if (cur.lsStopped) {
        await deps.replica.start({ sameGen: true });
        const l = await deps.replica.waitLagUnder(60_000);
        if (!l.ok) deps.log?.("resume-lag", { ok: false });
      }
      deps.marker?.void("resume");
      deps.creds.restart?.();
      await deps.gateway.start("resume");
      // H25a: after a resume the gateway and Litestream run again; a later drain must stop both.
      cur.gwStopped = false;
      cur.lsStopped = false;
      cur.resumed = true;
      const ms = await deps.gateway.waitStartupz(330_000);
      if (ms === null) {
        setState("aborted");
        return { ok: false, error: "failed", detail: "no startupz after resume" };
      }
    }
    setState("aborted");
    phaseTo("running");
    deps.log?.("resume", { opId: cur.opId, ms: now() - t0 });
    return { ok: true, startupzMs: now() - t0 };
  }

  /** ocsupctl dispatch for the sleep ops. */
  async function handle(op, opId) {
    if (deps.draining()) return { ok: false, error: "draining" };
    if (!opId) return { ok: false, error: "bad-request", detail: "opId required" };
    if (op === "resume-after-sleep") {
      if (cur && cur.opId !== opId) return wrong("same opId");
      return run("resume", resume);
    }
    if (!open(opId)) return busy();
    const done = (p) => !!cur.results[p];
    switch (op) {
      case "sleep-check":
        return run("check", check);
      case "sleep-prepare":
        if (!done("check") || cur.results.check.blockers.length) return wrong("check");
        return run("prepare", prepare);
      case "sleep-cancel":
        if (!done("prepare") || cur.gwStopped) return wrong("prepare");
        return run("edge", async () => {
          await deps.suspendResume();
          setState("aborted");
          phaseTo("running");
          return { ok: true };
        });
      case "sleep-stop-gateway":
        if (cur.results.prepare?.status !== "ready" || cur.results.edge) return wrong("prepare");
        return run("stop-gateway", stopGateway);
      case "sleep-flush":
        if (!cur.results["stop-gateway"]?.ok) return wrong("stop-gateway");
        return run("flush", flush);
      default:
        return { ok: false, error: "unknown-op" };
    }
  }

  /**
   * SIGTERM during an op (amend §3 "T7e row 14"). Marks the op interrupted and tells the drain where
   * to start: {open, phase, gwStopped, lsStopped, flushed, inflight}.
   */
  function interruptBySigterm() {
    if (!cur || TERMINAL.has(cur.state)) {
      // Flushed only while the op still holds the flush (state done); a resume ends that (H25a).
      const flushed = cur?.state === "done" && !!cur.results.flush?.ok;
      return {
        open: false,
        flushed,
        gwStopped: !!cur?.gwStopped && flushed,
        lsStopped: !!cur?.lsStopped && flushed,
      };
    }
    const r = {
      open: true,
      phase: cur.phase,
      gwStopped: cur.gwStopped,
      lsStopped: cur.lsStopped,
      inflight: cur.inflight,
      flushed: false,
    };
    cur.state = "interrupted:sigterm";
    return r;
  }

  return {
    handle,
    interruptBySigterm,
    state: () => (cur ? { opId: cur.opId, phase: cur.phase, state: cur.state, at: cur.at } : null),
  };
}
