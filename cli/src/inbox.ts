// `ochost inbox list` and `ochost inbox drop <id|--all [--channel X]>` (M7 live F2: rows the gateway can never take
// kept rule 5 on and the container awake). Routes: GET /ops/inbox, POST /ops/inbox/drop (owner only). A dropped row
// becomes `dead` (reason `dropped`); the Worker deletes it 24 h after receipt like any dead row.
import { hookChannelOf, SPECS } from "./hook-channels.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  type OpsClient,
  type OpsCtx,
  opsClient,
  table,
  usage,
} from "./ops-lib.ts";

export const inboxFlags: FlagSpec = {
  all: { type: "boolean" },
  channel: { type: "string" },
  state: { type: "string" },
};

interface Row {
  id: string;
  route: string;
  platform_key: string;
  state: string;
  attempts: number;
  received_at: number;
  dead_reason: string | null;
}

/** Inbox route → channel name as `channels list` shows it. */
const CHANNEL_OF: Record<string, string> = {
  "/telegram-webhook": "telegram",
  ...Object.fromEntries(Object.values(SPECS).map((s) => [s.route, s.channel])),
};

/** The config channel name for a CLI name (`twilio` → `sms`); unknown names pass through for the Worker to refuse. */
export const channelName = (c: string) => {
  const h = hookChannelOf(c);
  return h ? SPECS[h].channel : c;
};

/** POST /ops/inbox/drop. Returns how many rows went dead. An older Worker without the route: fix line. */
export async function dropRows(
  ops: OpsClient,
  b: { id?: string; all?: boolean; channel?: string; state?: "pending" },
): Promise<number> {
  const body = { ...b, ...(b.channel ? { channel: channelName(b.channel) } : {}) };
  const r = await ops.call("POST", "/ops/inbox/drop", body, { allow: [200, 400, 404, 409] });
  const err = String(r.body?.error ?? "");
  if (r.status === 404 && err === "not found")
    throw new CliError("this Worker has no inbox drop route (/ops/inbox/drop)", "ochost deploy, then rerun");
  if (r.status === 404) throw new CliError(`no inbox row ${b.id}`, "ochost inbox list shows the ids");
  if (r.status === 409)
    throw new CliError(`inbox row ${b.id} is ${r.body?.state}, not pending or held`, "nothing to drop");
  if (r.status === 400)
    throw usage(
      `the Worker refused the drop: ${err}${r.body?.channel ? ` ${r.body.channel}` : ""}`,
      "ochost inbox drop <id> | --all [--channel telegram|slack|discord|sms]",
    );
  return Number(r.body?.dropped ?? 0);
}

export async function inbox(ctx: OpsCtx): Promise<number> {
  const s = ctx.args.positionals[0] ?? "list";
  if (s === "list") return inboxList(ctx);
  if (s === "drop") return inboxDrop(ctx);
  throw usage(`unknown inbox command ${s}`, "use ochost inbox list | drop <id|--all [--channel X]>");
}

async function inboxList(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const r = await ops.call("GET", "/ops/inbox");
  const want = flagStr(ctx.args, "channel");
  const ch = want ? channelName(want) : null;
  const rows = ((r.body?.rows ?? []) as Row[]).filter((x) => !ch || CHANNEL_OF[x.route] === ch);
  const counts = (r.body?.counts ?? {}) as Record<string, number>;
  if (ctx.out.json) {
    ctx.out.result({ ok: true, counts, rows });
    return EXIT.ok;
  }
  const c = ["pending", "held", "accepted", "replicated", "dead"].map((k) => `${k} ${counts[k] ?? 0}`);
  ctx.out.line(c.join(", "));
  if (!rows.length) return EXIT.ok;
  const now = ctx.now();
  ctx.out.line(
    table(
      ["ID", "CHANNEL", "KEY", "STATE", "ATTEMPTS", "AGE"],
      rows.map((x) => [
        x.id,
        CHANNEL_OF[x.route] ?? x.route,
        String(x.platform_key),
        x.state === "dead" && x.dead_reason ? `dead (${x.dead_reason})` : x.state,
        String(x.attempts ?? 0),
        age(now - x.received_at),
      ]),
    ),
  );
  if (rows.some((x) => x.state === "pending"))
    ctx.out.line("A row that never goes out: ochost inbox drop <id>, or --all --channel <name>");
  return EXIT.ok;
}

async function inboxDrop(ctx: OpsCtx): Promise<number> {
  const id = ctx.args.positionals[1];
  const all = flagBool(ctx.args, "all");
  const channel = flagStr(ctx.args, "channel");
  if (!id && !all)
    throw usage("inbox drop needs a row id or --all", "ochost inbox drop <id> | --all [--channel X]");
  if (id && (all || channel)) throw usage("give a row id or --all, not both", "ochost inbox drop <id>");
  const st = flagStr(ctx.args, "state");
  if (st && st !== "pending")
    throw usage(`bad --state ${st}`, "only --state pending (default: pending and held)");
  const ops = opsClient(ctx);
  const n = await dropRows(ops, id ? { id } : { all: true, channel, ...(st ? { state: "pending" } : {}) });
  if (ctx.out.json) ctx.out.result({ ok: true, dropped: n });
  else
    ctx.out.line(
      n
        ? `dead-lettered ${n} inbox row(s); they will not be delivered`
        : `no open row${channel ? ` for ${channelName(channel)}` : ""}; nothing to drop`,
    );
  return EXIT.ok;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
