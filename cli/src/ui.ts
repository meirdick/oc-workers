// User interface layer: errors with exit codes, redaction, output, prompts, argv parsing and the command
// context. Copied from cf-orbs cli (errors.ts, ui.ts, args.ts, context.ts) and merged into one file.
// Progress goes to stderr; results go to stdout (so --json stdout is pure JSON).
import { rmSync } from "node:fs";
import type { Fetch, Runner } from "./wrangler.ts";

// ---------------------------------------------------------------- errors

/** Exit codes (spec 10 §1.1). */
export const EXIT = { ok: 0, failed: 1, usage: 2, manual: 3, budget: 4, interrupted: 130 } as const;

/** One user-facing failure: "Failed: <cause> — fix: <action>", one line, with an exit code. */
export class CliError extends Error {
  readonly cause_: string;
  readonly fix: string;
  readonly exit: number;
  constructor(cause: string, fix: string, exit: number = EXIT.failed) {
    super(`Failed: ${oneLine(cause)} — fix: ${oneLine(fix)}`);
    this.name = "CliError";
    this.cause_ = cause;
    this.fix = fix;
    this.exit = exit;
  }
}

export function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

const secrets = new Set<string>();

/** Register a secret value so redact() removes it from every line the CLI prints. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

/** Remove registered secrets and secret-shaped strings (Telegram bot tokens, bearer values, login codes). */
export function redact(s: string): string {
  let out = s;
  for (const v of secrets) out = out.split(v).join("[redacted]");
  return out
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g, "[redacted-telegram]")
    .replace(/(Bearer\s+)[A-Za-z0-9_.-]{20,}/gi, "$1[redacted]")
    .replace(/(cf-aig-authorization["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[A-Za-z0-9_.-]{20,}/gi, "$1[redacted]");
}

/**
 * The cause chain of an error, one line: undici's bare "fetch failed" keeps the real reason (ECONNRESET,
 * ENOTFOUND, connect timeout, other side closed) in `cause`, and `stack` does not show it. Each link gives
 * name: message and the code, errno, syscall and address:port it has. An AggregateError (happy eyeballs: one
 * error per address) shows its errors too.
 */
export function causeChain(e: unknown, depth = 6): string {
  const parts: string[] = [];
  let x: unknown = e;
  for (let i = 0; x && i < depth; i++) {
    if (!(x instanceof Error)) {
      parts.push(String(x));
      break;
    }
    const o = x as Error & {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
      address?: unknown;
      port?: unknown;
      errors?: unknown;
    };
    const bits = [
      o.code !== undefined ? `code ${String(o.code)}` : "",
      o.errno !== undefined ? `errno ${String(o.errno)}` : "",
      o.syscall !== undefined ? `syscall ${String(o.syscall)}` : "",
      o.address !== undefined
        ? `address ${String(o.address)}${o.port !== undefined ? `:${String(o.port)}` : ""}`
        : "",
    ].filter(Boolean);
    let link = `${o.name}: ${o.message}${bits.length ? ` (${bits.join(", ")})` : ""}`;
    if (Array.isArray(o.errors) && o.errors.length)
      link += ` [${o.errors.map((y) => causeChain(y, 1)).join("; ")}]`;
    parts.push(link);
    x = o.cause;
  }
  return parts.join(" <- ");
}

/** The innermost cause of an error, for a one-line message ("" when there is no cause). */
export function rootCause(e: unknown): string {
  if (!(e instanceof Error) || e.cause === undefined) return "";
  const links = causeChain(e.cause).split(" <- ");
  return links[links.length - 1] ?? "";
}

/** Turn any thrown value into one redacted "Failed: … — fix: …" line. */
export function toFailedLine(e: unknown): string {
  if (e instanceof CliError) return redact(e.message);
  const cause = rootCause(e);
  const msg = (e instanceof Error ? e.message : String(e)) + (cause ? ` (${cause})` : "");
  if (/^Failed: .* — fix: /.test(msg)) return redact(oneLine(msg));
  return redact(
    `Failed: ${oneLine(msg) || "unknown error"} — fix: rerun with OCHOST_DEBUG=1 and report the output`,
  );
}

export function exitCodeOf(e: unknown): number {
  if (e instanceof CliError) return e.exit;
  // ai-gateway.ts CliFail and ops-lib.ts CliError carry exitCode / exit too
  const x = e as { exit?: unknown; exitCode?: unknown } | null;
  const c = Number(x?.exit ?? x?.exitCode);
  return Number.isInteger(c) && c > 0 ? c : EXIT.failed;
}

// ---------------------------------------------------------------- output

export interface Ui {
  json: boolean;
  nonInteractive: boolean;
  /** progress line (stderr). In --json mode: one JSON event {step, msg, at} per line. */
  step(line: string, step?: string): void;
  /** text the user must read, such as steps to follow (stderr); never folded into a step line */
  say(line: string): void;
  /** an event worth its own line even inside a step (a retry); stderr */
  note(line: string): void;
  /** start a numbered step: step() lines are held back (not in --json, not with --verbose) */
  begin(): void;
  /** finish it: one line "[n/total] label  detail  elapsed" (stderr); in --json one event with ms */
  end(s: { n: number; total: number; label: string; detail?: string; ms: number }): void;
  /** warning line (stderr) */
  warn(line: string): void;
  /** result text (stdout); suppressed in --json mode */
  out(line: string): void;
  /** final JSON document (stdout); only in --json mode */
  result(value: unknown): void;
  /** one-line progress that rewrites itself on a TTY ("deploy: pushing image, 42 s") */
  progress(line: string): void;
  /** end the progress line */
  progressDone(): void;
}

export interface UiStreams {
  err: { write(s: string): unknown; isTTY?: boolean };
  out: { write(s: string): unknown };
}

export function makeUi(
  opts: { json: boolean; nonInteractive: boolean; verbose?: boolean },
  io: UiStreams = { err: process.stderr, out: process.stdout },
): Ui {
  let live = false;
  let held: string[] | null = null;
  let lastPlain = 0;
  let lastText = "";
  const clear = () => {
    if (live) {
      io.err.write("\r\x1b[2K");
      live = false;
    }
  };
  return {
    json: opts.json,
    nonInteractive: opts.nonInteractive,
    step: (l, step) => {
      if (held && !opts.json && !opts.verbose) {
        held.push(l);
        return;
      }
      clear();
      if (opts.json)
        io.err.write(`${JSON.stringify({ step, msg: redact(l), at: new Date().toISOString() })}\n`);
      else io.err.write(`${redact(l)}\n`);
    },
    note: (l) => {
      clear();
      if (opts.json) io.err.write(`${JSON.stringify({ note: redact(l), at: new Date().toISOString() })}\n`);
      else io.err.write(`  ${redact(l)}\n`);
    },
    begin: () => {
      held = [];
    },
    end: (s) => {
      const last = held?.at(-1);
      held = null;
      clear();
      if (opts.json) {
        io.err.write(
          `${JSON.stringify({ step: s.label, done: true, n: s.n, total: s.total, ms: s.ms, msg: s.detail ? redact(s.detail) : undefined, at: new Date().toISOString() })}\n`,
        );
        return;
      }
      if (opts.verbose && !s.detail) return;
      const detail = shorten(s.detail ?? (last ?? "").replace(/^[\w-]+: /, ""), 52);
      const num = `[${String(s.n).padStart(String(s.total).length)}/${s.total}]`;
      io.err.write(`${redact(`${num} ${s.label.padEnd(10)} ${detail}`.trimEnd())}  ${fmtElapsed(s.ms)}\n`);
    },
    say: (l) => {
      clear();
      if (opts.json) io.err.write(`${JSON.stringify({ say: redact(l), at: new Date().toISOString() })}\n`);
      else io.err.write(`${redact(l)}\n`);
    },
    warn: (l) => {
      clear();
      if (opts.json) io.err.write(`${JSON.stringify({ warn: redact(l), at: new Date().toISOString() })}\n`);
      else io.err.write(`WARN: ${redact(l)}\n`);
    },
    out: (l) => {
      if (!opts.json) io.out.write(`${redact(l)}\n`);
    },
    result: (v) => {
      if (opts.json) io.out.write(`${redact(JSON.stringify(v, null, 2))}\n`);
    },
    progress: (l) => {
      const text = redact(l);
      if (io.err.isTTY && !opts.json) {
        io.err.write(`\r\x1b[2K${text}`);
        live = true;
        return;
      }
      // not a TTY: a plain line at most every 15 s, or when the phase text changes
      const now = Date.now();
      const phase = text.replace(/\d+/g, "");
      if (phase !== lastText || now - lastPlain >= 15_000) {
        lastPlain = now;
        lastText = phase;
        if (opts.json) io.err.write(`${JSON.stringify({ progress: text, at: new Date().toISOString() })}\n`);
        else io.err.write(`${text}\n`);
      }
    },
    progressDone: () => {
      if (live) io.err.write("\n");
      live = false;
      lastText = "";
    },
  };
}

/** Plain text table. Columns sized to content. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [fmt(headers), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

/** "0.4 s", "12 s", "2 min 41 s": the time shown at the end of a step line. */
export function fmtElapsed(ms: number): string {
  return ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : fmtSecs(ms);
}

/** Cut a line to n characters with an ellipsis. */
export function shorten(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function fmtSecs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// ---------------------------------------------------------------- prompts

export interface Prompter {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
}

/** Ask a question on the TTY. Returns the trimmed answer. */
export async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read a secret from the TTY without echo. Ctrl-C aborts with exit 130. Piped stdin: one line. */
export async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    process.stderr.write(question);
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: stdin });
    const line = await new Promise<string>((res) => rl.once("line", res).once("close", () => res("")));
    rl.close();
    process.stderr.write("\n");
    return line.trim();
  }
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          done();
          process.stderr.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === "\u0003") {
          done();
          process.stderr.write("\n");
          reject(new CliError("interrupted", "run the command again", EXIT.interrupted));
          return;
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    // Echo off before the prompt shows, so input typed or pasted on the prompt never echoes.
    stdin.setRawMode(true);
    process.stderr.write(question);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export const ttyPrompter: Prompter = { ask, askHidden };

// ---------------------------------------------------------------- interrupt cleanup

const cleanups = new Set<string>();

/** Register a temp path that the SIGINT handler deletes. Returns the unregister function. */
export function onInterruptRemove(path: string): () => void {
  cleanups.add(path);
  return () => cleanups.delete(path);
}

let sigintInstalled = false;
/** SIGINT: delete temp secret files, print "interrupted", exit 130 (spec 10 §1.1). */
export function installSigint(): void {
  if (sigintInstalled) return;
  sigintInstalled = true;
  process.on("SIGINT", () => {
    for (const p of cleanups) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {}
    }
    process.stderr.write("\ninterrupted\n");
    process.exit(EXIT.interrupted);
  });
}

// ---------------------------------------------------------------- argv

export type FlagSpec = Record<string, { type: "boolean" | "string"; short?: string }>;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Small argv parser: --flag, --flag=value, --flag value, --no-flag, -h, and "--" to end flags. */
export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const byShort = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) if (s.short) byShort.set(s.short, name);
  const usage = (cause: string, fix: string) => new CliError(cause, fix, EXIT.usage);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let inline: string | undefined = eq === -1 ? undefined : a.slice(eq + 1);
      let negated = false;
      if (!spec[name] && name.startsWith("no-") && spec[name.slice(3)]?.type === "boolean") {
        name = name.slice(3);
        negated = true;
      }
      const s = spec[name];
      if (!s) throw usage(`unknown flag --${name}`, "run ochost --help");
      if (s.type === "boolean") {
        if (inline !== undefined) {
          if (!/^(true|false|1|0)$/.test(inline)) throw usage(`--${name} takes no value`, `use --${name}`);
          flags[name] = negated !== (inline === "true" || inline === "1");
        } else flags[name] = !negated;
        continue;
      }
      if (negated) throw usage(`--no-${name} is not valid`, `pass --${name} <value>`);
      if (inline === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-"))
          throw usage(`--${name} needs a value`, `pass --${name} <value>`);
        inline = next;
        i++;
      }
      flags[name] = inline;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const name = byShort.get(a.slice(1));
      if (!name) throw usage(`unknown flag ${a}`, "run ochost --help");
      const s = spec[name];
      if (s?.type === "boolean") flags[name] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined) throw usage(`${a} needs a value`, `pass ${a} <value>`);
        flags[name] = next;
        i++;
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

export function flagString(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(p: ParsedArgs, name: string): boolean {
  return p.flags[name] === true;
}

// ---------------------------------------------------------------- command context

/** What every command gets. Injected so tests swap the process runner, fetch, prompts and clock. */
export interface Ctx {
  ui: Ui;
  args: ParsedArgs;
  /** project dir (absolute) */
  dir: string;
  run: Runner;
  fetch: Fetch;
  env: Record<string, string | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  prompt: Prompter;
  /** stdin is a TTY and --non-interactive is off */
  interactive: boolean;
  /** repo root with worker/ and image/ (tests and OCHOST_SOURCE override) */
  source?: string;
  /** open a URL in the browser (tests stub it) */
  openUrl?: (url: string) => Promise<void>;
}
