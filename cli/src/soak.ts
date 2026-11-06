// ochost soak start|status|stop|report (docs/17-soak-engine.md). Test installs only (OC_TEST=1): the Worker answers
// 404 on /ops/soak-plan elsewhere. report writes a markdown file from the results the Worker keeps in R2.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PlanView, SoakSummary, StepResult, SummaryItem } from "../../worker/src/ctl/soak/types.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  fmtAgo,
  fmtTime,
  type OpsCtx,
  opsClient,
  table,
  usage,
} from "./ops-lib.ts";

export const soakFlags: FlagSpec = {
  params: { type: "string" },
  plan: { type: "string" },
  out: { type: "string" },
  date: { type: "string" },
  strict: { type: "boolean" },
};

export interface PlanResults {
  plan: string;
  summary: SoakSummary | null;
  steps: StepResult[];
}

const NOT_TEST = new CliError(
  "not a test install (OC_TEST=1)",
  "deploy a test install: ochost init --fake-telegram",
);
const SOAK = "/ops/soak-plan";

export async function soak(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0];
  if (sub === "start") return soakStart(ctx);
  if (sub === "status") return soakStatus(ctx);
  if (sub === "stop") return soakStop(ctx);
  if (sub === "report") return soakReport(ctx);
  throw usage(
    `unknown soak command ${sub ?? ""}`.trim(),
    "use ochost soak start <plan>|all | status | stop [<plan>] | report",
  );
}

async function soakStart(ctx: OpsCtx): Promise<number> {
  const plan = ctx.args.positionals[1];
  if (!plan) throw usage("no plan named", "use ochost soak start <plan>|all [--params '<json>']");
  const raw = flagStr(ctx.args, "params");
  let params: object | undefined;
  if (raw !== undefined) {
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("not an object");
      params = p;
    } catch {
      throw usage("--params is not a JSON object", `pass --params '{"key": 1}'`);
    }
  }
  const r = await opsClient(ctx).call(
    "POST",
    SOAK,
    { plan, ...(params ? { params } : {}) },
    { allow: [202, 400, 404, 409] },
  );
  if (r.status === 404) throw NOT_TEST;
  if (r.status === 400)
    throw new CliError(
      `unknown plan ${plan} (${String(r.body?.error ?? "rejected")})`,
      "ochost soak status lists the plans",
    );
  if (r.status === 409)
    throw new CliError(
      `plan ${plan} is active (${String(r.body?.error ?? "plan-active")})`,
      "ochost soak stop <plan>, or wait for it",
    );
  const queued: string[] = r.body?.queued ?? [];
  if (ctx.out.json) ctx.out.result({ ok: true, queued });
  else {
    ctx.out.line(`queued: ${queued.join(", ") || "-"}`);
    ctx.out.line("ochost soak status");
  }
  return EXIT.ok;
}

interface StatusBody {
  now: number;
  plans: PlanView[];
  catalog: { name: string; steps: number; about: string }[];
}

/** Status text: one row per queued plan, then the catalog names not queued. */
export function renderStatus(b: StatusBody): string {
  const rows = b.plans.map((p) => [
    p.plan,
    p.state,
    `${p.done}/${p.total}`,
    String(p.failed),
    p.current ? [p.current.id, p.current.type, p.current.phase].filter(Boolean).join(" ") : "-",
    fmtAgo(p.nextAt, b.now),
  ]);
  const out: string[] = [];
  if (rows.length) out.push(table(["plan", "state", "done", "failed", "current", "next"], rows));
  else out.push("no plans queued");
  const queued = new Set(b.plans.map((p) => p.plan));
  const rest = b.catalog.filter((c) => !queued.has(c.name));
  if (rest.length) out.push(`not queued: ${rest.map((c) => c.name).join(", ")}`);
  return out.join("\n");
}

async function soakStatus(ctx: OpsCtx): Promise<number> {
  const r = await opsClient(ctx).call("GET", SOAK, undefined, { allow: [200, 404] });
  if (r.status === 404) throw NOT_TEST;
  if (ctx.out.json) ctx.out.result(r.body);
  else ctx.out.line(renderStatus(r.body as StatusBody));
  return EXIT.ok;
}

async function soakStop(ctx: OpsCtx): Promise<number> {
  const plan = ctx.args.positionals[1];
  const q = plan ? `?plan=${encodeURIComponent(plan)}` : "";
  const r = await opsClient(ctx).call("DELETE", `${SOAK}${q}`, undefined, { allow: [200, 404] });
  if (r.status === 404) throw NOT_TEST;
  const stopped: string[] = r.body?.stopped ?? [];
  if (ctx.out.json) ctx.out.result({ ok: true, stopped });
  else ctx.out.line(stopped.length ? `stopped: ${stopped.join(", ")}` : "nothing to stop");
  return EXIT.ok;
}

// ---------------------------------------------------------------- report

/** 1300 ms → "1.3 s"; 90000 ms → "1.5 min". Other units keep their text. */
export function fmtMeasure(v: number | null, unit: string): string {
  if (v === null || v === undefined) return "-";
  if (unit === "ms") {
    if (Math.abs(v) < 1000) return `${Math.round(v)} ms`;
    if (Math.abs(v) < 120_000) return `${+(v / 1000).toFixed(1)} s`;
    return `${+(v / 60_000).toFixed(1)} min`;
  }
  return `${+v.toFixed(2)}${unit ? ` ${unit}` : ""}`;
}

export const itemFails = (i: SummaryItem) => i.over > 0 || !i.pass;
const planFails = (s: SoakSummary) => s.pass === false || s.failed > 0 || s.items.some(itemFails);

export function planVerdict(s: SoakSummary): "PASS" | "FAIL" | "RUNNING" {
  if (planFails(s)) return "FAIL";
  return s.state === "done" && s.pass === true ? "PASS" : "RUNNING";
}

export function overallVerdict(results: PlanResults[]): "PASS" | "FAIL" | "RUNNING" {
  if (results.some((r) => r.summary && planVerdict(r.summary) === "FAIL")) return "FAIL";
  if (results.length && results.every((r) => r.summary && planVerdict(r.summary) === "PASS")) return "PASS";
  return "RUNNING";
}

export function renderReport(results: PlanResults[], now: number, url = ""): string {
  const md = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const L: string[] = ["# Soak report", ""];
  L.push(`${url ? `${url} · ` : ""}generated ${fmtTime(now)} UTC`, "");
  L.push(md(["item", "bound", "n", "p50", "max", "over", "result"]));
  L.push(md(["---", "---", "---:", "---:", "---:", "---:", "---"]));
  const items = results.flatMap((r) => r.summary?.items ?? []);
  for (const i of items)
    L.push(
      md([
        i.item,
        i.bound,
        String(i.n),
        fmtMeasure(i.p50, i.unit),
        fmtMeasure(i.max, i.unit),
        String(i.over),
        itemFails(i) ? "FAIL" : "PASS",
      ]),
    );
  if (!items.length) L.push(md(["no items", "", "", "", "", "", ""]));
  for (const r of results) {
    L.push("", `## ${r.plan}`, "");
    const s = r.summary;
    if (!s) {
      L.push("not run");
      continue;
    }
    L.push(`state ${s.state} · ${planVerdict(s)} · ${s.done}/${s.total} done · ${s.failed} failed`);
    for (const f of s.failedSteps) L.push(`- ${f.id}: ${f.checks.length ? f.checks.join(", ") : "failed"}`);
    for (const k of s.skipped ?? []) L.push(`- not run ${k.id}: ${k.why}`);
  }
  L.push("", `Overall: ${overallVerdict(results)}`, "");
  return L.join("\n");
}

/** Repo root: the nearest parent holding worker/test/results, or null. */
export function findResultsDir(from: string): string | null {
  let d = resolve(from);
  for (;;) {
    const p = join(d, "worker", "test", "results");
    if (existsSync(p)) return p;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

async function soakReport(ctx: OpsCtx): Promise<number> {
  const plan = flagStr(ctx.args, "plan");
  const date = flagStr(ctx.args, "date") ?? new Date(ctx.now()).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw usage("--date is not YYYY-MM-DD", "pass --date 2026-11-05");
  const ops = opsClient(ctx);
  const r = await ops.call(
    "GET",
    `${SOAK}/results${plan ? `?plan=${encodeURIComponent(plan)}` : ""}`,
    undefined,
    {
      allow: [200, 404],
    },
  );
  if (r.status === 404) throw NOT_TEST;
  const results: PlanResults[] = r.body?.plans ?? [];
  const text = renderReport(results, ctx.now(), ops.install.url);
  const given = flagStr(ctx.args, "out");
  const file = given ? resolve(ctx.dir, given) : join(findResultsDir(ctx.dir) ?? ctx.dir, `SOAK-${date}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const overall = overallVerdict(results);
  const failed = results.some((x) => x.summary && planVerdict(x.summary) === "FAIL");
  if (ctx.out.json) ctx.out.result({ ok: true, file, overall, plans: results });
  else {
    ctx.out.line(`wrote ${file}`);
    ctx.out.line(`Overall: ${overall}`);
  }
  return flagBool(ctx.args, "strict") && failed ? EXIT.failed : EXIT.ok;
}
