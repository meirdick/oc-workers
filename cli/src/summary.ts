// The block `ochost init` ends with (and its --json twin): where to click, which bot, which model, what it costs,
// what to run next. Pure: init.ts passes the facts. Cost text is the addendum §5.3 line; `ochost status` shows the
// measured range once the install has run.
import { fmtElapsed } from "./ui.ts";

/** Duty-cycle at light use, 2/6/20 (addendum §1.2: low/mid/high snapshot guess, about $7-14, up to about $25). */
export const COST_LIGHT = { lowUsd: 7, highUsd: 14, snapshotHighUsd: 25 };
/** Always-on, when a channel needs a socket (addendum §1.2: $50-69). */
export const COST_ALWAYS_ON = { lowUsd: 50, highUsd: 69 };

export const costLine = (): string =>
  `about $${COST_LIGHT.lowUsd}-${COST_LIGHT.highUsd}/month at light use (up to $${COST_LIGHT.snapshotHighUsd} if snapshot storage is priced high); always-on would be $${COST_ALWAYS_ON.lowUsd}-${COST_ALWAYS_ON.highUsd}`;

export interface SummaryInput {
  url: string;
  openUrl?: string;
  /** minutes the login link lives */
  openUrlMinutes?: number;
  /** @handle of the Telegram bot, when one is on */
  bot?: string;
  fakeTelegram: boolean;
  model?: string;
  gateway?: string;
  sleepMode: string;
  idleMinutes: number;
  elapsedMs: number;
  /** how to call this CLI in a hint (`ochost` or `node …/ochost.js`) */
  self: string;
  /** printed after the command: `--dir <d>` when the install is not the current dir */
  dirArg: string;
  /** alerts.channel, or the --alerts flag; "none" or unset = alerts off (the default) */
  alerts?: string;
}

/** The commands the summary suggests, in order. Also the `nextCommands` field of the init JSON. */
export function nextCommands(
  i: Pick<SummaryInput, "self" | "dirArg" | "bot" | "model" | "alerts">,
): { cmd: string; why: string }[] {
  const c = (s: string) => `${i.self} ${s}${i.dirArg}`;
  return [
    ...(i.bot ? [] : [{ cmd: c("channels add telegram"), why: "one paste: the bot token from @BotFather" }]),
    ...(i.model ? [] : [{ cmd: c("ai-gateway setup"), why: "no model yet (--skip-ai)" }]),
    { cmd: c("status"), why: "sleep state, next wake, cost" },
    { cmd: c("doctor"), why: "health checks" },
    ...(i.alerts && i.alerts !== "none"
      ? []
      : [{ cmd: c("alerts setup"), why: "alerts are off (the default); this turns them on" }]),
  ];
}

export function summaryLines(i: SummaryInput): string[] {
  const rows: [string, string][] = [["UI", i.url]];
  if (i.openUrl)
    rows.push([
      "Login",
      `${i.openUrl}  (single use${i.openUrlMinutes ? `, ${i.openUrlMinutes} min` : ""}; ${i.self} open makes another)`,
    ]);
  rows.push([
    "Bot",
    i.bot
      ? `@${i.bot.replace(/^@/, "")}${i.fakeTelegram ? " (fake, test install)" : ""}`
      : i.fakeTelegram
        ? "none yet (test install: Telegram is a fake)"
        : "none yet",
  ]);
  rows.push([
    "Model",
    i.model
      ? `${i.model} via ${i.gateway === "none" ? "no gateway" : `gateway ${i.gateway ?? "-"}`}`
      : "none (--skip-ai)",
  ]);
  rows.push([
    "Mode",
    i.sleepMode === "auto"
      ? `sleeps after ${i.idleMinutes} min idle, wakes on a message`
      : "always on (sleep is off)",
  ]);
  rows.push([
    "Cost",
    i.sleepMode === "auto"
      ? costLine()
      : `always-on: $${COST_ALWAYS_ON.lowUsd}-${COST_ALWAYS_ON.highUsd}/month`,
  ]);
  const w = Math.max(...rows.map(([k]) => k.length));
  const next = nextCommands(i);
  const cw = Math.max(...next.map((n) => n.cmd.length));
  return [
    "",
    `Up in ${fmtElapsed(i.elapsedMs)}.`,
    "",
    ...rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`),
    "",
    "Next:",
    ...next.map((n) => `  ${n.cmd.padEnd(cw)}  ${n.why}`),
  ];
}
