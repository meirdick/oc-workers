// ochost sleep now|status|set (docs/10-cli-spec.md §1.2, addendum §5.2).
// now: POST /ops/sleep runs the sleep gate; 409 prints the rule that refused. status: GET /ops/status (never
// wakes). set auto|off [--idle-minutes N] [--proactive v]: writes oc-host.jsonc `sleep.*`.
// `set` writes oc-host.jsonc and the Worker's settings document (PUT /ops/settings); it applies at the next op.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTopLevelJsonc } from "./config.ts";
import { dropRows } from "./inbox.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  flagInt,
  flagStr,
  fmtAgo,
  kv,
  type OpsCtx,
  opsClient,
  readHostConfig,
  usage,
} from "./ops-lib.ts";
import { costRange } from "./status.ts";

export const sleepFlags: FlagSpec = {
  force: { type: "boolean" },
  "idle-minutes": { type: "string" },
  timeout: { type: "string" },
  "no-wait": { type: "boolean" },
  proactive: { type: "string" },
};

/** Proactive grammar (spec §2.5): off | openclaw | 30m | 1h | 2h[@HH-HH] | 5-field cron. */
export function validProactive(v: string): boolean {
  if (v === "off" || v === "openclaw") return true;
  const m = /^(30m|1h|2h)(@(\d{2})-(\d{2}))?$/.exec(v);
  if (m) return !m[2] || (Number(m[3]) < 24 && Number(m[4]) <= 24 && Number(m[3]) < Number(m[4]));
  return /^(\S+\s+){4}\S+$/.test(v.trim());
}

/**
 * Set `<block>.<key>` in the JSONC text, keeping comments. Replaces the value when the key exists in the
 * `"<block>": {` object, else inserts it after the brace. null when there is no such block.
 */
export function setBlockKey(
  text: string,
  blockName: string,
  key: string,
  value: string | number | object,
): string | null {
  const open = new RegExp(`"${blockName}"\\s*:\\s*\\{`).exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  let inStr = false;
  for (; i < text.length && depth > 0; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  const end = i - 1;
  const block = text.slice(start, end);
  const lit = JSON.stringify(value);
  const re = new RegExp(`("${key}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?[0-9.]+|true|false|null)`);
  if (re.test(block)) return text.slice(0, start) + block.replace(re, `$1${lit}`) + text.slice(end);
  return `${text.slice(0, start)}\n    "${key}": ${lit},${text.slice(start)}`;
}

/**
 * Set a dotted path (`sleep.idleMinutes`, `timezone`, `login.rateLimits.ipFail`) in the oc-host.jsonc text, keeping
 * comments. Creates a missing block. null when the text has no top-level object.
 */
export function setPathJsonc(text: string, path: string, value: string | number): string | null {
  const ks = path.split(".");
  if (ks.length === 1) return setTopLevelJsonc(text, path, value);
  const [top, ...rest] = ks as [string, ...string[]];
  const leaf = rest[rest.length - 1] as string;
  if (rest.length === 2) {
    // top.mid.leaf: the mid block inside top
    const inTop = setBlockKey(text, rest[0] as string, leaf, value);
    if (inTop !== null && new RegExp(`"${top}"\\s*:\\s*\\{`).test(text)) return inTop;
    if (new RegExp(`"${top}"\\s*:\\s*\\{`).test(text))
      return setBlockKey(text, top, rest[0] as string, { [leaf]: value });
    return setTopLevelJsonc(text, top, { [rest[0] as string]: { [leaf]: value } });
  }
  return setBlockKey(text, top, leaf, value) ?? setTopLevelJsonc(text, top, { [leaf]: value });
}

export async function sleep(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0] ?? "status";
  if (sub === "now") return sleepNow(ctx);
  if (sub === "status") return sleepStatus(ctx);
  if (sub === "set") return sleepSet(ctx);
  throw usage(`unknown sleep command ${sub}`, "use ochost sleep now|status|set");
}

async function sleepNow(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const force = flagBool(ctx.args, "force");
  const budgetMs = flagInt(ctx.args, "timeout", 120, 5, 3600) * 1000;
  let r = await ops.call("POST", `/ops/sleep${force ? "?force=1" : ""}`, undefined, { allow: [200, 409] });
  let dropped = 0;
  if (force && !(r.status === 200 && r.body?.ok) && String(r.body?.reason ?? "").startsWith("5:")) {
    // M7 F2: rows the gateway never takes hold rule 5 for 23 h. --force dead-letters the pending ones, then
    // sleeps. Held rows do not block sleep and stay.
    dropped = await dropRows(ops, { all: true, state: "pending" });
    ctx.out.warn(
      `dead-lettered ${dropped} pending inbox row(s) to pass rule 5; they will not be delivered (ochost inbox list)`,
    );
    r = await ops.call("POST", "/ops/sleep?force=1", undefined, { allow: [200, 409] });
  }
  if (!(r.status === 200 && r.body?.ok)) {
    const why = String(r.body?.reason ?? r.body?.error ?? "refused");
    if (ctx.out.json) ctx.out.result({ ok: false, reason: why });
    if (why === "no-active-epoch") throw new CliError("the install has no active epoch", "ochost status");
    const fix = why.startsWith("state ")
      ? "the install is not running; nothing to do"
      : "ochost status names the blockers; ochost sleep now --force skips rules 3, 4 and 7 and dead-letters pending inbox rows (rule 5)";
    throw new CliError(`the sleep gate refused: ${why}`, fix);
  }
  const opId = r.body.opId ?? null;
  if (flagBool(ctx.args, "no-wait")) {
    if (ctx.out.json) ctx.out.result({ ok: true, opId, waited: false, dropped });
    else ctx.out.line(`sleep op ${opId ?? "-"} started; ochost status shows the result`);
    return EXIT.ok;
  }
  // The gate passed; later sleep phases can still abort the op (live 2026-11-01: blocker 6:config-recent).
  ctx.out.step("sleeping");
  const t0 = ctx.now();
  let s: any = null;
  while (ctx.now() - t0 < budgetMs && !ctx.signal?.aborted) {
    await ctx.sleep(3000);
    s = (await ops.call("GET", "/ops/status")).body;
    const sleepOpen = (s?.rt?.ops ?? []).some((o: any) => o.kind === "sleep") || s?.state === "quiescing";
    if (s?.state === "asleep") {
      const waitedMs = ctx.now() - t0;
      if (ctx.out.json) ctx.out.result({ ok: true, opId, state: "asleep", waitedMs, dropped });
      else ctx.out.line(`asleep after ${Math.round(waitedMs / 1000)} s`);
      return EXIT.ok;
    }
    if (!sleepOpen && s?.state === "running" && ctx.now() - t0 >= 6000) {
      const b = (s?.blockers ?? []).join(", ") || "unknown";
      throw new CliError(
        `the sleep stopped; still running (blockers: ${b})`,
        "wait for the blocker to clear, then ochost sleep now",
      );
    }
  }
  if (ctx.signal?.aborted) return EXIT.interrupted;
  throw new CliError(
    `not asleep ${Math.round(budgetMs / 1000)} s after the sleep started (state ${s?.state ?? "unknown"})`,
    "the sleep goes on; ochost status",
    EXIT.budget,
  );
}

async function sleepStatus(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const s = (await ops.call("GET", "/ops/status")).body;
  const cfg = readHostConfig(ctx.dir);
  const now = ctx.now();
  const cost = costRange(s?.wake);
  const x = {
    mode: s?.sleepMode ?? cfg?.sleep?.mode ?? "auto",
    state: s?.state ?? "unknown",
    blockers: (s?.blockers ?? []) as string[],
    costGuard: s?.costGuard?.holding ? "holding awake" : "ok",
    nextWakeAt: s?.nextWakeAt ?? s?.rt?.sleep?.wakeAt ?? null,
    wakes24: s?.wake?.wakes24 ?? null,
    awakePct24: cost?.awakePct ?? null,
    idleMinutes: cfg?.sleep?.idleMinutes ?? null,
    proactive: cfg?.sleep?.proactive ?? null,
  };
  if (ctx.out.json) ctx.out.result({ ok: true, ...x });
  else
    ctx.out.line(
      kv([
        ["mode", String(x.mode)],
        ["state", String(x.state)],
        ["blockers", x.blockers.length ? x.blockers.join(", ") : "none"],
        ["cost guard", x.costGuard],
        ["next wake", x.nextWakeAt ? fmtAgo(x.nextWakeAt, now) : "on the next message or cron"],
        ["wakes 24 h", x.wakes24 === null ? "-" : String(x.wakes24)],
        ["awake 24 h", x.awakePct24 === null ? "-" : `${x.awakePct24}%`],
        ["idle timer", x.idleMinutes === null ? "-" : `${x.idleMinutes} min`],
        ["proactive", x.proactive === null ? "-" : String(x.proactive)],
      ]),
    );
  return EXIT.ok;
}

async function sleepSet(ctx: OpsCtx): Promise<number> {
  const mode = ctx.args.positionals[1];
  const idle = flagStr(ctx.args, "idle-minutes");
  const proactive = flagStr(ctx.args, "proactive");
  if (mode !== undefined && mode !== "auto" && mode !== "off")
    throw usage(`sleep mode must be auto or off, not ${mode}`, "use ochost sleep set auto|off");
  if (mode === undefined && idle === undefined && proactive === undefined)
    throw usage("nothing to set", "use ochost sleep set auto|off [--idle-minutes N] [--proactive v]");
  const changes: [string, string | number][] = [];
  if (mode) changes.push(["mode", mode]);
  if (idle !== undefined) {
    const n = Number(idle);
    if (!Number.isInteger(n) || n < 1 || n > 60)
      throw usage("--idle-minutes must be 1-60", "pass --idle-minutes 5 (default)");
    changes.push(["idleMinutes", n]);
  }
  if (proactive !== undefined) {
    if (!validProactive(proactive))
      throw usage(
        `--proactive ${proactive} is not valid`,
        "use off, openclaw, 30m, 1h, 2h, 2h@08-22 or a cron",
      );
    changes.push(["proactive", proactive]);
  }
  const path = join(ctx.dir, "oc-host.jsonc");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`no oc-host.jsonc in ${ctx.dir}`, "run ochost config pull, or ochost init");
  }
  for (const [k, v] of changes) {
    const next = setBlockKey(text, "sleep", k, v);
    if (next === null) throw new CliError("oc-host.jsonc has no sleep block", 'add "sleep": {} and rerun');
    text = next;
  }
  // The Worker's settings document applies at its next op: no deploy.
  const r = await opsClient(ctx).call(
    "PUT",
    "/ops/settings",
    { set: Object.fromEntries(changes.map(([k, v]) => [`sleep.${k}`, v])), source: "cli" },
    { allow: [200, 400, 409] },
  );
  if (r.status !== 200)
    throw new CliError(
      `the Worker refused the setting: ${String(r.body?.error ?? r.status)}`,
      "oc-host.jsonc is unchanged",
    );
  writeFileSync(path, text);
  if (ctx.out.json)
    ctx.out.result({ ok: true, set: Object.fromEntries(changes), applied: true, settingsVer: r.body?.ver });
  else {
    ctx.out.line(`oc-host.jsonc: ${changes.map(([k, v]) => `sleep.${k} = ${v}`).join(", ")}`);
    ctx.out.line(`applies at the next op (settings version ${r.body?.ver}); no deploy needed`);
  }
  return EXIT.ok;
}
