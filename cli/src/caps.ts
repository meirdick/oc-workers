// ochost caps [set <verb> <n>]: the CapGate and SandboxGate daily budgets (docs/11 §4, docs/12 §6). GET/POST /ops/caps.
// `caps set storage <gb>` is the file storage cap (docs/11 §8): the setting files.capGb, not a daily budget.
// `caps recount` counts f/<inst>/ in R2 again (POST /ops/files/reconcile), for files written outside the gate.
import { settingsCommand } from "./config-commands.ts";
import { CliError, EXIT, type FlagSpec, kv, type OpsCtx, opsClient, table, usage } from "./ops-lib.ts";

export const capsFlags: FlagSpec = {};
const VERBS = ["browser", "neurons", "requests", "websearch", "exec", "sandbox"];
const UNIT: Record<string, string> = {
  browser: "s",
  neurons: "",
  requests: "",
  websearch: "",
  exec: "s",
  sandbox: "h",
};

interface Use {
  used: number;
  limit: number;
  pct: number;
}
interface View {
  day: string;
  resetsInS: number;
  verbs: Record<string, Use>;
  /** docs/11 §8: file storage bytes against files.capGb (not daily). Absent on an older Worker. */
  files?: { used: number; limit: number; objects: number; objectMax: number; pct: number };
}

const gb = (n: number) => `${(n / 1e9).toFixed(n < 1e8 ? 3 : 2)}GB`;

function show(ctx: OpsCtx, v: View): void {
  if (ctx.out.json) {
    ctx.out.result({ ok: true, ...v });
    return;
  }
  ctx.out.line(
    table(
      ["VERB", "USED", "LIMIT", "%"],
      // A Worker older than docs/12 has no exec/sandbox verbs: show what it has.
      VERBS.filter((k) => v.verbs[k]).map((k) => {
        const u = v.verbs[k] as Use;
        const used = UNIT[k] === "h" ? u.used.toFixed(2) : String(Math.round(u.used));
        return [k, `${used}${UNIT[k]}`, `${u.limit}${UNIT[k]}`, `${Math.round(u.pct * 100)}`];
      }),
    ),
  );
  const rows: [string, string][] = [["day", `${v.day} UTC, resets in ${Math.round(v.resetsInS / 60)} min`]];
  if (v.files)
    rows.push([
      "files",
      `${gb(v.files.used)} of ${gb(v.files.limit)} (${Math.round(v.files.pct * 100)}%), ${v.files.objects} object(s), max ${Math.round(v.files.objectMax / 1e6)}MB each; ochost caps set storage <n>`,
    ]);
  ctx.out.line(kv(rows));
}

interface Recount {
  ok: boolean;
  more: boolean;
  objects: number;
  added: number;
  resized: number;
  removed: number;
  error?: string;
  files?: View["files"];
}

/**
 * `ochost caps recount` (1.2.4): the Worker lists f/<inst>/ in R2 and fixes the file count, so files written straight
 * to R2 (not through the gate) count against files.capGb. Calls again while the Worker says `more` (max 10 calls).
 */
async function recount(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const sum = { calls: 0, objects: 0, added: 0, resized: 0, removed: 0 };
  let last: Recount | null = null;
  do {
    last = (await ops.call("POST", "/ops/files/reconcile", {}, { allow: [200, 502], timeoutMs: 120_000 }))
      .body as Recount;
    sum.calls++;
    sum.objects += last.objects ?? 0;
    sum.added += last.added ?? 0;
    sum.resized += last.resized ?? 0;
    sum.removed += last.removed ?? 0;
  } while (last.ok && last.more && sum.calls < 10);
  if (!last.ok)
    throw new CliError(
      `recount: ${last.error ?? "R2 list error"}`,
      "run ochost caps recount again; ochost logs --source ctl",
    );
  const done = !last.more;
  if (ctx.out.json) {
    ctx.out.result({ ok: true, done, ...sum, files: last.files ?? null });
    return EXIT.ok;
  }
  const rows: [string, string][] = [
    ["objects", `${sum.objects} listed${done ? "" : " (not complete; run it again)"}`],
    ["changes", `${sum.added} added, ${sum.resized} resized, ${sum.removed} removed`],
  ];
  if (last.files)
    rows.push([
      "files",
      `${gb(last.files.used)} of ${gb(last.files.limit)} (${Math.round(last.files.pct * 100)}%)`,
    ]);
  ctx.out.line(kv(rows));
  return EXIT.ok;
}

export async function caps(ctx: OpsCtx): Promise<number> {
  const [sub, verb, n] = ctx.args.positionals;
  const ops = opsClient(ctx);
  if (!sub) {
    show(ctx, (await ops.call("GET", "/ops/caps")).body as View);
    return EXIT.ok;
  }
  if (sub === "recount") return recount(ctx);
  if (sub !== "set")
    throw usage(`unknown caps command ${sub}`, "use ochost caps | caps set <verb> <n> | caps recount");
  if (verb === "storage") {
    if (n === undefined || !/^\d+$/.test(n))
      throw usage("caps set storage needs a whole number of GB", "ochost caps set storage 20");
    return settingsCommand({ ...ctx, args: { ...ctx.args, positionals: ["set", "files.capGb", n] } }, "set");
  }
  if (!verb || !VERBS.includes(verb) || n === undefined || !/^\d+(\.\d+)?$/.test(n))
    throw usage(
      "caps set needs a verb and a number",
      `ochost caps set <${[...VERBS, "storage"].join("|")}> <n>`,
    );
  show(ctx, (await ops.call("POST", "/ops/caps", { [verb]: Number(n) })).body as View);
  return EXIT.ok;
}
