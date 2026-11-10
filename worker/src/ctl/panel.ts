// ownerPanel(): every fact the owner page and `ochost doctor` show, assembled in the Control DO (one JSON).
// Never wakes the install. The gate hop and Telegram getWebhookInfo run at most once a minute (cached in meta);
// while the install is asleep the cached values are shown and the row says so. No secret value is read into the
// answer: names, states, counts and ages only.
import type { OwnerView } from "../core/types";
import { CAP_DEFAULTS, CAP_MAX, type CapsView, type CapVerb } from "../gates/caps";
import { redactHook } from "../ops-telegram";
import { archiveStatus } from "./archives";
import { snapshotSummary } from "./chain";
import type { Ctx } from "./ctx";
import { chatSummary, counts, getWakeAllow, noReplyCount } from "./inbox";
import { pairRequests } from "./owner-ops";
import {
  alertFix,
  type Check,
  checkAlerts,
  checkArchive,
  checkBudget,
  checkDeadman,
  checkFiles,
  checkHop,
  checkReplica,
  checkState,
  checkWebhook,
  checkWebhookLive,
  dur,
  type FilesProbe,
  fail,
  gatewayOf,
  type HopInfo,
  pass,
  raiseTo,
  type Sink,
  type WebhookInfo,
  warn,
} from "./panel-checks";
import { maintenanceDue } from "./schedule";
import { pj } from "./sql";
import { meter } from "./wakelog";

export const PROBE_TTL_MS = 60_000;
const UNIT: Record<string, string> = { browser: "s", exec: "s", sandbox: "h" };

/** What the Control DO class hands in; tests pass fakes. */
export interface PanelDeps {
  status(): Promise<Record<string, any>>;
  view(): Promise<OwnerView>;
  caps(): CapsView | null;
  sink(): Sink;
  /** One chat call through the gate. Never throws. */
  hop(model: string): Promise<{ status: number; ms: number; error?: string }>;
  /** File storage probe: PUT, GET, DELETE of 1 byte under f/<inst>/ (gates/replica.ts filesProbe). Never throws. */
  files?(): Promise<{ ok: boolean; ms: number; error?: string }>;
  /** File storage usage against files.capGb (ledger filesView). */
  filesView?(): { used: number; limit: number } | null;
  /** SandboxSession state; null when the binding is absent. Never starts it. */
  sandbox(): Promise<Record<string, any> | null>;
  env: { access: { domain: string | null; team: string | null } | null; gateway: string };
}

export interface AlertItem {
  class: string;
  severity: string;
  result: "PASS" | "WARN" | "FAIL";
  at: number | null;
  count: number;
  detail: string;
  fix: string;
}

export type EventKind = "wake" | "sleep" | "archive" | "restart";
/** Gen reasons that are restarts, not wakes from sleep (owner, ladder, replace, upgrade, epoch roll). */
const RESTART =
  /^(restart|ladder|auto-restart|replace|upgrade|owner-force|code-roll|reslot|cutover|rollback)/;

export interface UpgradeCheck {
  at: number;
  cliVersion: string | null;
  pinned: { version: string; digest: string } | null;
  target: { version: string } | null;
  delta: string | null;
}

/** The config document's render version against the CLI's (reported by deploy and `config render`). */
export interface RenderState {
  docVersion: number;
  cliVersion: number | null;
  outdated: boolean;
}

export interface Panel {
  inst: string;
  now: number;
  view: OwnerView;
  /** `outdated`: the CLI's render is newer than the document's; fix `ochost config render`. */
  render: RenderState;
  /** The probes' freshness: `asleep` = the cached values are shown. */
  probes: { asleep: boolean; hopAt: number | null; webhookAt: number | null };
  ok: boolean;
  fails: number;
  warns: number;
  /** The doctor checks (the CLI table). */
  checks: Check[];
  connected: Check[];
  /** `closed`: the newest closed alerts (Alerts tab, below the open ones). */
  alerts: { open: AlertItem[]; closed: AlertItem[]; doctorTail: string | null };
  budgets: {
    verb: string;
    used: number;
    limit: number;
    pct: number;
    unit: string;
    next: number;
    row: Check;
  }[];
  backups: { rows: Check[]; nextMaintenanceAt: number | null };
  /** docs/11 §8: storage location r2 (null: off, no location in the config). Bytes from the ledger. */
  files: { prefix: string; used: number; limit: number } | null;
  channels: {
    wake: { userIds: string[]; groupChatIds: string[] };
    pairing: { code: string; id: string; name: string; count: number; held: number }[];
    heldInbox: number;
  };
  /** Wake-log spend (wakelog.ts meter): 24 h, the 30-day projection at that pace, always-on. `holding` = cost guard. */
  cost: {
    spend24Usd: number;
    monthUsd: number;
    alwaysOnMonthUsd: number;
    savedPct: number;
    wakes24: number;
    holding: boolean;
  };
  /** The values behind the Setup tab's three controls (sandbox, alerts, model). */
  toggles?: {
    sandbox: { value: "off" | "on" | "all"; pending: boolean };
    alerts: { source: string; kind: string | null };
    model: { primary: string | null; choices: string[] };
  };
  /** Newest first: wakes, sleeps, archives and restarts. `ms`: how long the event took (ready, sleep op, upload). */
  events: { at: number; kind: EventKind; text: string; ms: number | null }[];
  /** Webhook messages per UTC day (7, oldest first) and the last chat times (inbox.ts chatSummary). */
  chat: {
    days: { day: string; received: number; replied: number }[];
    lastInAt: number | null;
    lastInRoute: string | null;
    lastOutAt: number | null;
  };
}

/** The newest config version the install would boot (good or candidate). */
/** `ochost.renderVersion` of the newest good or candidate version that carries the CLI's `ochost` block; 0 if none. */
function renderVersionOf(c: Ctx): number {
  for (const r of c.db.all<{ doc: string }>(
    "SELECT doc FROM config WHERE status IN ('good', 'candidate') ORDER BY ver DESC LIMIT 20",
  )) {
    const v = pj<any>(r.doc, null)?.ochost?.renderVersion;
    if (Number.isInteger(v)) return v as number;
  }
  return 0;
}

function configDoc(c: Ctx): any {
  const r = c.db.one<{ doc: string }>(
    "SELECT doc FROM config WHERE status IN ('good', 'candidate') ORDER BY ver DESC LIMIT 1",
  );
  return r ? pj<any>(r.doc, null) : null;
}

/** Telegram getWebhookInfo with the Worker's bot token. The token and the URL's secret segment never leave. */
export async function webhookProbe(c: Ctx): Promise<WebhookInfo | null> {
  const tok = c.secrets.botToken;
  if (!tok) return null;
  const at = c.now();
  try {
    const r = await c.fetch(`https://api.telegram.org/bot${tok}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { url?: string; pending_update_count?: number; last_error_message?: string };
    };
    return {
      at,
      ok: j.ok === true,
      url: redactHook(j.result?.url ?? ""),
      pending: Number(j.result?.pending_update_count ?? 0),
      lastError: j.result?.last_error_message
        ? redactHook(String(j.result.last_error_message)).slice(0, 120)
        : null,
    };
  } catch {
    return { at, ok: false, url: "", pending: 0, lastError: null, error: "no answer" };
  }
}

const onOff = (v: unknown) => !!v;

export async function ownerPanel(
  c: Ctx,
  d: PanelDeps,
  o: { origin: string | null; fresh?: boolean },
): Promise<Panel> {
  const now = c.now();
  const [s, view] = await Promise.all([d.status(), d.view()]);
  const state = String(s.state ?? "unknown");
  const awake = state === "running";
  const doc = configDoc(c);
  const gw = gatewayOf(doc);
  const tgOn = !!doc?.channels?.telegram && doc.channels.telegram.enabled !== false;

  // Probes: at most one a minute; asleep → cached, unless the owner asked (`doctor` sends fresh=1).
  const mayProbe = awake || o.fresh === true;
  let hop = c.db.metaJson<HopInfo | null>("panelHop", null);
  if (gw && !gw.direct && mayProbe && (!hop || now - hop.at >= PROBE_TTL_MS)) {
    const r = await d.hop(gw.model);
    hop = { at: now, model: gw.model, status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}) };
    c.db.setMeta("panelHop", hop);
  }
  let wh = c.db.metaJson<WebhookInfo | null>("panelWebhook", null);
  if (tgOn && mayProbe && (!wh || now - wh.at >= PROBE_TTL_MS)) {
    const r = await webhookProbe(c);
    if (r) {
      wh = r;
      c.db.setMeta("panelWebhook", wh);
    }
  }
  // File storage: R2 only, no container, so it runs asleep too (cached one minute; doctor sends fresh=1).
  const filesOn = doc?.storage?.locations?.r2?.provider === "ochost-r2";
  let fp = c.db.metaJson<FilesProbe | null>("panelFiles", null);
  if (filesOn && d.files && (!fp || o.fresh === true || now - fp.at >= PROBE_TTL_MS)) {
    fp = { at: now, ...(await d.files()) };
    c.db.setMeta("panelFiles", fp);
  }
  const stale = (at: number | null | undefined, row: Check): Check =>
    !awake && at && o.fresh !== true
      ? { ...row, detail: `${row.detail} (cached ${dur(now - at)} ago, install asleep)` }
      : row;

  const archive = archiveStatus(c, 1) as any;
  const sink = d.sink();
  const hopRow = stale(hop?.at, checkHop(doc, hop));
  const checks: Check[] = [pass("reach", "Control DO answered"), checkState(s)];
  if (!doc) checks.push(warn("config", "no config version", "rerun ochost init (it posts version 1)"));
  checks.push(checkWebhook(o.origin, doc, s));
  const live = checkWebhookLive(o.origin, wh);
  if (live) checks.push(stale(wh?.at, live));
  const fv = d.filesView?.() ?? null;
  const filesRow = checkFiles(doc, fp, fv, Math.min(10_000, Math.ceil(((fv?.limit ?? 5e9) / 1e9) * 2)));
  checks.push(hopRow, checkReplica(s), checkArchive(archive, state), checkAlerts(s, sink), checkDeadman(s));
  if (doc) checks.push(filesRow);
  const fails = checks.filter((x) => x.result === "FAIL").length;
  const warns = checks.filter((x) => x.result === "WARN").length;

  // Budgets
  const caps = d.caps();
  const budgets = caps
    ? (Object.keys(caps.verbs) as CapVerb[]).map((verb) => {
        const u = caps.verbs[verb];
        const next = raiseTo(u.limit, CAP_DEFAULTS[verb], CAP_MAX);
        const unit = UNIT[verb] ?? "";
        return {
          verb,
          used: u.used,
          limit: u.limit,
          pct: u.pct,
          unit,
          next,
          row: checkBudget(verb, u.used, u.limit, unit, next),
        };
      })
    : [];
  const use = (verb: string) => {
    const b = budgets.find((x) => x.verb === verb);
    return b ? `${b.row.detail.replace(/ \(.*/, "")} today` : "no budget data";
  };
  const worst = (...verbs: string[]): Check["result"] => {
    const rs = verbs.map((v) => budgets.find((x) => x.verb === v)?.row.result ?? "PASS");
    return rs.includes("FAIL") ? "FAIL" : rs.includes("WARN") ? "WARN" : "PASS";
  };
  const capRow = (name: string, on: boolean, extra: string, verbs: string[], offFix: string): Check => {
    if (!on) return warn(name, "off", offFix);
    const r = worst(...verbs);
    const first = verbs.map((v) => budgets.find((x) => x.verb === v)).find((b) => b && b.row.result === r);
    return {
      name,
      result: r,
      detail: `on${extra ? `, ${extra}` : ""}; ${verbs.map(use).join("; ")}`,
      ...(r !== "PASS" && first ? { fix: first.row.fix } : {}),
    };
  };
  const initFix = "ochost init (re-run safe; posts the capabilities)";
  const mediaOn = {
    speech: onOff(doc?.tts?.providers),
    transcription: onOff(doc?.tools?.media?.models?.length),
    image: onOff(doc?.agents?.defaults?.mediaModels?.image?.primary),
  };
  const media = Object.entries(mediaOn)
    .map(([k, v]) => `${k} ${v ? "on" : "off"}`)
    .join(", ");

  // Connected
  const connected: Check[] = [];
  connected.push({
    name: "model",
    result: hopRow.result,
    detail: `${gw ? `${gw.provider}, ${gw.model}` : "none"}, gateway ${d.env.gateway || "none"}, last hop ${hop ? `${hop.ms} ms` : "none"}`,
    ...(hopRow.fix ? { fix: hopRow.fix } : {}),
  });
  connected.push(
    capRow("web search", onOff(doc?.tools?.web?.search?.provider), "", ["websearch"], initFix),
    filesRow,
    capRow(
      "browser and web fetch",
      onOff(doc?.browser?.enabled) && onOff(doc?.tools?.web?.fetch?.provider),
      "",
      ["browser", "requests"],
      initFix,
    ),
    mediaOn.speech && mediaOn.transcription && mediaOn.image
      ? { ...pass("media", media), detail: `${media}; ${use("neurons")} neurons` }
      : warn("media", media, initFix),
  );
  const sbxOn = c.settings().sandbox === "on" || c.settings().sandbox === "all";
  const sbx = sbxOn ? await d.sandbox().catch(() => null) : null;
  if (!sbxOn) connected.push({ ...pass("sandbox", "off (opt-in)"), fix: "ochost sandbox on" });
  else {
    const r = worst("exec", "sandbox");
    const sb = budgets.find((x) => x.verb === "sandbox");
    connected.push({
      name: "sandbox",
      result: r,
      detail: `on, ${sbx ? String(sbx.state ?? "unknown") : "no state"}; ${use("exec")}; ${use("sandbox")}`,
      ...(r !== "PASS" && sb ? { fix: sb.row.fix } : {}),
    });
  }
  // Channels: config names merged with what the gateway reported (transport, class).
  const live2 = c.db.all<{ channel: string; transport: string | null; class: string | null }>(
    "SELECT channel, transport, class FROM channels WHERE source = 'live'",
  );
  const names = [...new Set([...Object.keys(doc?.channels ?? {}), ...live2.map((x) => x.channel)])].filter(
    (n) => doc?.channels?.[n]?.enabled !== false,
  );
  for (const n of names) {
    const lv = live2.find((x) => x.channel === n);
    const transport = lv?.transport ?? (n === "telegram" ? "webhook" : "not reported");
    const blocks = lv ? lv.class !== "sleep-ok" : false;
    const seen = c.db.metaJson<{ at: number } | null>(`hookSeen:${n}`, null);
    let hook: string;
    let err = "none";
    let result: Check["result"] = "PASS";
    let fix: string | undefined;
    let noReply = "";
    if (n === "telegram") {
      const row = checkWebhook(o.origin, doc, s);
      hook = row.result === "PASS" ? "set" : "not set";
      if (wh?.lastError) err = wh.lastError;
      if (row.result !== "PASS") ({ result, fix } = row);
      else if (live && live.result !== "PASS") ({ result, fix } = live);
      // no-reply (1.2): accepted messages the gateway did not answer in NO_REPLY_ALERT_MS, while it runs.
      const nr = s.state === "running" ? noReplyCount(c) : 0;
      if (nr) {
        noReply = `, ${nr} message${nr === 1 ? "" : "s"} without a reply`;
        if (result === "PASS") {
          result = "WARN";
          fix = "ochost logs --source gateway (the gateway runs but did not answer)";
        }
      }
    } else hook = seen ? `seen ${dur(now - seen.at)} ago` : "not seen yet";
    if (result === "PASS" && blocks) {
      result = "WARN";
      fix = "ochost sleep status (a socket channel keeps the install awake)";
    }
    connected.push({
      name: `channel ${n}`,
      result,
      detail: `transport ${transport}, webhook ${hook}, last error ${err}, blocks sleep ${blocks ? "yes" : "no"}${noReply}`,
      ...(fix ? { fix } : {}),
    });
  }
  const acc = d.env.access;
  connected.push(
    acc
      ? { ...pass("access", `on, domain ${acc.domain ?? "-"}, team ${acc.team ?? "-"}`) }
      : { ...pass("access", "off"), fix: "ochost auth access (opt-in, recommended on a custom domain)" },
  );
  connected.push(
    !sink.configured
      ? warn("alerts sink", "not configured", "ochost alerts setup")
      : sink.ackedAt
        ? pass("alerts sink", `${sink.kind ?? "sink"}, configured, acked ${dur(now - sink.ackedAt)} ago`)
        : warn(
            "alerts sink",
            `${sink.kind ?? "sink"}, configured, test not acked`,
            "ochost alerts test, then ochost alerts ack <code>",
          ),
  );
  const up = c.db.metaJson<UpgradeCheck | null>("upgradeCheck", null);
  const digest = s.epoch?.digest ? String(s.epoch.digest).slice(0, 19) : "-";
  const newer = up?.delta === "newer" || up?.delta === "moved";
  connected.push({
    name: "install",
    result: newer ? "WARN" : "PASS",
    detail: `CLI ${up?.cliVersion ?? "unknown"}, image ${digest}, OpenClaw ${up?.pinned?.version ?? "unknown"}, ${
      up
        ? newer
          ? `upgrade available (${up.target?.version ?? "?"}; checked ${dur(now - up.at)} ago)`
          : `no upgrade (checked ${dur(now - up.at)} ago)`
        : "no upgrade check yet"
    }`,
    ...(newer
      ? { fix: "ochost upgrade check, then ochost upgrade run" }
      : up
        ? {}
        : { fix: "ochost upgrade check" }),
  });

  const cli = c.db.metaJson<{ at: number; version: number } | null>("cliRender", null);
  // The render version lives in the CLI's `ochost` block. A version the container proposed (Doctor rewrote the
  // file; OpenClaw rejects unknown root keys, so the block is gone) carries the same rendered keys: read the newest
  // version that has the block, not the newest version.
  const docVer = renderVersionOf(c);
  const render: RenderState = {
    docVersion: docVer,
    cliVersion: cli?.version ?? null,
    outdated: !!doc && cli !== null && cli.version > docVer,
  };
  if (doc)
    connected.push(
      render.outdated
        ? warn(
            "config render",
            `outdated: config has render ${docVer}, CLI ${cli?.version}`,
            "ochost config render, then ochost restart",
          )
        : pass(
            "config render",
            `render ${docVer}${cli ? `, CLI ${cli.version}` : ", CLI version not reported yet"}`,
          ),
    );

  // Alerts
  const rows = c.db.all<{
    class: string;
    severity: string;
    last_sent_at: number | null;
    count: number;
    last_detail: string | null;
  }>(
    "SELECT class, severity, last_sent_at, count, last_detail FROM alerts WHERE open = 1 ORDER BY last_sent_at DESC",
  );
  const item = (a: (typeof rows)[number]): AlertItem => ({
    class: a.class,
    severity: a.severity,
    result: a.severity === "high" ? "FAIL" : a.severity === "warn" ? "WARN" : "PASS",
    at: a.last_sent_at,
    count: a.count,
    detail: (a.last_detail ?? "").slice(0, 500),
    fix: alertFix(a.class),
  });
  const open = rows.map(item);
  const closed = c.db
    .all<(typeof rows)[number]>(
      "SELECT class, severity, last_sent_at, count, last_detail FROM alerts WHERE open = 0 AND last_sent_at IS NOT NULL ORDER BY last_sent_at DESC LIMIT 10",
    )
    .map(item);
  const df = open.find((a) => a.class === "doctor-failed");
  const doctorTail = df ? (/without Doctor: (.*)$/s.exec(df.detail)?.[1] ?? df.detail).slice(-400) : null;

  // Backups
  const snap = snapshotSummary(c);
  const newestDone = (archive.archives as any[] | undefined)?.find((a) => a.state === "complete");
  const arch = checkArchive(archive, state);
  const verified = newestDone ? newestDone.verified_at !== null : false;
  const archRow: Check = {
    ...arch,
    name: "archive",
    detail: `${arch.detail}; ${newestDone ? (verified ? "verified" : "not verified yet") : "none"}`,
  };
  const snapRow: Check = snap.warn
    ? warn(
        "snapshots",
        `${snap.indexed} snapshots, chain ${snap.chainLength}; ${snap.warn}`,
        "ochost snapshot prune",
      )
    : pass("snapshots", `${snap.indexed} snapshots, chain ${snap.chainLength}`);
  const k = counts(c);
  const lastWake = c.db.one<{ m: number | null }>("SELECT MAX(wake_at) AS m FROM wake_log")?.m ?? null;
  const maint = maintenanceDue(c, { lastWakeAt: lastWake, oldestHeldAt: k.oldestHeldAt });
  const nextMaintenanceAt = Number.isFinite(maint) ? maint : null;
  const replica = checkReplica(s);
  const backups = {
    rows: [
      archRow,
      snapRow,
      { ...replica, name: "replica lag" },
      pass(
        "next maintenance",
        nextMaintenanceAt
          ? `${nextMaintenanceAt > now ? "in" : "due"} ${dur(nextMaintenanceAt - now)}`
          : "none scheduled",
      ),
    ],
    nextMaintenanceAt,
  };
  if (archive.drill && (archive.drill as any).ok === false)
    backups.rows.push(fail("restore drill", "the last drill failed", "ochost logs --source ctl"));

  // Channels and wake
  const w = getWakeAllow(c);
  const pairing = (await pairRequests(c)).map((p) => ({
    code: p.code,
    id: p.id,
    name: p.name,
    count: p.count,
    held: p.held,
  }));

  // Cost and events
  const m = meter(c);
  const cost = {
    spend24Usd: m.spend24Usd,
    monthUsd: m.monthUsd,
    alwaysOnMonthUsd: m.alwaysOnMonthUsd,
    savedPct: m.savedPct,
    wakes24: m.wakes24,
    holding: c.db.meta("costHold") === "1",
  };
  const events: Panel["events"] = [];
  for (const r of c.db.all<{
    reason: string;
    wake_at: number;
    startupz_ms: number | null;
    slept_at: number | null;
    awake_s: number | null;
    sleep_ms: number | null;
  }>(
    "SELECT reason, wake_at, startupz_ms, slept_at, awake_s, sleep_ms FROM wake_log ORDER BY id DESC LIMIT 20",
  )) {
    if (r.slept_at !== null)
      events.push({
        at: r.slept_at,
        kind: "sleep",
        text: `Slept after ${dur((r.awake_s ?? 0) * 1000)} awake`,
        ms: r.sleep_ms,
      });
    const why = r.reason.replace(/^wake:/, "");
    const restart = RESTART.test(why);
    events.push({
      at: r.wake_at,
      kind: restart ? "restart" : "wake",
      text: restart ? `Restarted (${why})` : `Woke on ${why}`,
      ms: r.startupz_ms,
    });
  }
  for (const a of c.db.all<{
    kind: string;
    state: string;
    size: number | null;
    created_at: number;
    completed_at: number | null;
  }>("SELECT kind, state, size, created_at, completed_at FROM archives ORDER BY created_at DESC LIMIT 10"))
    events.push({
      at: a.created_at,
      kind: "archive",
      text: `Archive (${a.kind}), ${a.state}${a.size ? `, ${Math.max(1, Math.round(a.size / 1e6))} MB` : ""}`,
      ms: a.completed_at ? a.completed_at - a.created_at : null,
    });
  events.sort((a, b) => b.at - a.at);

  return {
    inst: c.inst,
    now,
    view,
    render,
    probes: { asleep: !awake, hopAt: hop?.at ?? null, webhookAt: wh?.at ?? null },
    ok: fails === 0,
    fails,
    warns,
    checks,
    connected,
    alerts: { open, closed, doctorTail },
    budgets,
    backups,
    files:
      doc?.storage?.locations?.r2?.provider === "ochost-r2"
        ? {
            prefix: `${String(doc.storage.locations.r2.settings?.prefix ?? `f/${c.inst}`)}/`,
            used: fv?.used ?? 0,
            limit: fv?.limit ?? 0,
          }
        : null,
    channels: {
      wake: { userIds: w?.userIds ?? [], groupChatIds: w?.groupChatIds ?? [] },
      pairing,
      heldInbox: k.held,
    },
    cost,
    toggles: {
      sandbox: {
        value: c.settings().sandbox ?? "off",
        pending: (c.settings().sandbox ?? "off") !== (c.db.meta("sandboxBooted") ?? "off"),
      },
      alerts: { source: String(sink.source ?? "none"), kind: (sink.kind as string | null) ?? null },
      model: {
        // The catalogue the render wrote (models.providers.cfgw.models); the main model leads the list.
        primary: gw?.provider === "cfgw" ? gw.model : null,
        choices: (Array.isArray(doc?.models?.providers?.cfgw?.models) ? doc.models.providers.cfgw.models : [])
          .map((m: { id?: unknown }) => m?.id)
          .filter((id: unknown): id is string => typeof id === "string" && id.length < 120),
      },
    },
    events: events.slice(0, 40),
    chat: chatSummary(c),
  };
}
