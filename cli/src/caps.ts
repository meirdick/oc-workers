// ochost caps [set <verb> <n>]: the CapGate and SandboxGate daily budgets (docs/11 §4, docs/12 §6). GET/POST /ops/caps.
// `caps set storage <gb>` is the file storage cap (docs/11 §8): the setting files.capGb, not a daily budget.
import { settingsCommand } from "./config-commands.ts";
import { EXIT, type FlagSpec, kv, type OpsCtx, opsClient, table, usage } from "./ops-lib.ts";

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

export async function caps(ctx: OpsCtx): Promise<number> {
  const [sub, verb, n] = ctx.args.positionals;
  const ops = opsClient(ctx);
  if (!sub) {
    show(ctx, (await ops.call("GET", "/ops/caps")).body as View);
    return EXIT.ok;
  }
  if (sub !== "set") throw usage(`unknown caps command ${sub}`, "use ochost caps | caps set <verb> <n>");
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
