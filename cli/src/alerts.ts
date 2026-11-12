// ochost alerts [list]|setup|test|ack <code>|close <class> (docs/10-cli-spec.md §1.2; not part of init [chg]).
// setup --channel ntfy|webhook|none [--url]: ntfy gets a random topic; secrets ALERT_URL (and ALERT_TOKEN for a
//   webhook with a token) through wrangler; then a test alert with a 6-char code; the owner confirms it with
//   `ochost alerts ack <code>`. State in .oc-host/alerts.json (no secret values).
// ack asks the Worker (POST /ops/alerts/ack): the Control DO holds the test alert and its code. The local record
//   only helps when the Worker has no ack route (404, an old deploy). 1.2.5: the CLI no longer refuses from local
//   state alone (a test sent from the console, or from another laptop, has no local record).
// close <class>: POST /ops/alerts/close, closes one open alert (a stale hello-flood of an old gen).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagStr,
  fmtAgo,
  type Install,
  type OpsCtx,
  opsClient,
  putSecret,
  randomHex,
  registerSecret,
  STATE_DIR,
  table,
  usage,
  wrangler,
} from "./ops-lib.ts";
import { setBlockKey } from "./sleep.ts";
import { expandHome, tokenFromText } from "./ui.ts";

export const alertsFlags: FlagSpec = {
  channel: { type: "string" },
  url: { type: "string" },
  "token-file": { type: "string" },
};

export interface AlertsRecord {
  channel: "ntfy" | "webhook" | "none";
  setAt: number;
  code: string | null;
  sentAt: number | null;
  ackedAt: number | null;
  /** ntfy subscribe URL (the topic is not a secret but is hard to guess). */
  subscribe?: string | null;
}

export function readAlertsRecord(dir: string): AlertsRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, STATE_DIR, "alerts.json"), "utf8")) as AlertsRecord;
  } catch {
    return null;
  }
}

function writeAlertsRecord(dir: string, r: AlertsRecord): void {
  writeFileSync(join(dir, STATE_DIR, "alerts.json"), `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
}

/** 6 chars, no look-alikes (0/O, 1/l/I). */
export function ackCode(): string {
  const abc = "23456789abcdefghjkmnpqrstuvwxyz";
  const b = Buffer.from(randomHex(6), "hex");
  return [...b].map((x) => abc[x % abc.length]).join("");
}

export async function alerts(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0] ?? "list";
  if (sub === "list") return list(ctx);
  if (sub === "setup") return setup(ctx);
  if (sub === "test") return test(ctx);
  if (sub === "ack") return ack(ctx);
  if (sub === "close") return close(ctx);
  throw usage(`unknown alerts command ${sub}`, "use ochost alerts list|setup|test|ack <code>|close <class>");
}

async function list(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const b = (await ops.call("GET", "/ops/alerts")).body ?? {};
  const rec = readAlertsRecord(ctx.dir);
  const rows: any[] = Array.isArray(b.alerts) ? b.alerts : [];
  const now = ctx.now();
  if (ctx.out.json) {
    ctx.out.result({ ok: true, channel: rec?.channel ?? "none", acked: !!rec?.ackedAt, ...b });
    return EXIT.ok;
  }
  // "none" (the default) is alerts off: a normal state, not a warning. Alerts are still recorded and listed here.
  const off = !rec || rec.channel === "none";
  ctx.out.line(
    `channel: ${rec?.channel ?? "none"}${off ? " (alerts off; ochost alerts setup turns them on)" : rec.ackedAt ? " (test confirmed)" : " (test not confirmed)"} · outbox ${b.outbox ?? 0}`,
  );
  if (!rows.length) ctx.out.line("no alerts");
  else
    ctx.out.line(
      table(
        ["CLASS", "SEVERITY", "OPEN", "COUNT", "LAST", "DETAIL"],
        rows.map((a) => [
          String(a.class),
          String(a.severity ?? "-"),
          a.open ? "yes" : "no",
          String(a.count ?? "-"),
          fmtAgo(a.last_sent_at, now),
          String(a.last_detail ?? "").slice(0, 60),
        ]),
      ),
    );
  return EXIT.ok;
}

async function sendTest(ctx: OpsCtx, install: Install, rec: AlertsRecord): Promise<AlertsRecord> {
  const ops = opsClient(ctx, install);
  const code = ackCode();
  const r = await ops.call("POST", "/ops/alerts/test", { code }, { allow: [200, 502] });
  if (r.status === 502)
    // Live 2026-11-01: ntfy.sh answered the Worker with 429, then timed out; the same POST from a laptop got 200.
    throw new CliError(
      `the alert sink refused the test alert (sent ${r.body?.sent ?? 0}, failed ${r.body?.failed ?? "?"})`,
      "ochost logs --source alert shows the sink error; use --channel webhook, or ntfy on your own server with --url",
    );
  const next = { ...rec, code, sentAt: ctx.now(), ackedAt: null };
  writeAlertsRecord(ctx.dir, next);
  if (!r.body?.sent)
    ctx.out.warn(
      "the Control DO did not send it: it has not picked up ALERT_URL yet (W11) — fix: ochost alerts test in 1 min",
    );
  return next;
}

async function setup(ctx: OpsCtx): Promise<number> {
  const channel = flagStr(ctx.args, "channel") ?? (ctx.nonInteractive ? undefined : "ntfy");
  if (channel !== "ntfy" && channel !== "webhook" && channel !== "none")
    throw usage(
      "--channel must be ntfy, webhook or none",
      "pass --channel webhook --url <https URL> (ntfy.sh refuses Workers; use ntfy only with your own server and --url)",
    );
  const ops = opsClient(ctx);
  const install = ops.install;
  let url: string | null = null;
  let subscribe: string | null = null;
  if (channel === "ntfy") {
    const base = (flagStr(ctx.args, "url") ?? "https://ntfy.sh").replace(/\/+$/, "");
    const topic = `oc-host-${install.inst || "x"}-${randomHex(8)}`;
    url = `${base}/${topic}`;
    subscribe = url;
  } else if (channel === "webhook") {
    url = flagStr(ctx.args, "url") ?? null;
    if (!url || !/^https:\/\//.test(url))
      throw usage("--channel webhook needs --url https://…", "pass --url");
  }
  if (url) {
    registerSecret(url.split("/").pop());
    ctx.out.step("setting ALERT_URL on the Worker (wrangler)");
    await putSecret(ctx, install, "ALERT_URL", url);
    const tf = flagStr(ctx.args, "token-file");
    if (channel === "webhook" && tf) {
      const tok = tokenFromText(readFileSync(expandHome(tf), "utf8"), ["ALERT_TOKEN"]);
      await putSecret(ctx, install, "ALERT_TOKEN", tok);
    }
  } else {
    const r = await wrangler(ctx, install, ["secret", "delete", "ALERT_URL", "--name", install.name], "y\n");
    if (r.code !== 0 && !/not found|does not exist/i.test(r.stderr + r.stdout))
      ctx.out.warn("could not delete ALERT_URL — fix: npx wrangler secret delete ALERT_URL");
  }
  // Keep oc-host.jsonc in step (alerts.channel); a missing file or block is not an error.
  try {
    const p = join(ctx.dir, "oc-host.jsonc");
    const t = setBlockKey(readFileSync(p, "utf8"), "alerts", "channel", channel);
    if (t) writeFileSync(p, t);
  } catch {}
  let rec: AlertsRecord = { channel, setAt: ctx.now(), code: null, sentAt: null, ackedAt: null, subscribe };
  writeAlertsRecord(ctx.dir, rec);
  let testErr: unknown = null;
  if (channel !== "none") {
    // A secret change makes a new Worker version; give the DOs a moment to pick it up.
    await ctx.sleep(3000);
    try {
      rec = await sendTest(ctx, install, rec);
    } catch (e) {
      testErr = e;
    }
  }
  if (ctx.out.json) {
    if (testErr) throw testErr;
    ctx.out.result(
      {
        ok: true,
        channel,
        subscribe,
        testSent: !!rec.sentAt,
        next: rec.sentAt ? "ochost alerts ack <code>" : null,
      },
      { raw: true },
    );
    return EXIT.ok;
  }
  if (channel === "none") {
    ctx.out.line("alerts off");
    return EXIT.ok;
  }
  if (subscribe) {
    // The topic is the only key to the alerts: printed once for the owner, redacted everywhere else.
    ctx.out.secretLine(`subscribe in the ntfy app or browser: ${subscribe}`);
    const q = await ctx.run("qrencode", ["-t", "ANSIUTF8", "-m", "1"], { input: subscribe });
    if (q.code === 0) ctx.out.secretLine(q.stdout.trimEnd());
  }
  if (testErr) throw testErr;
  ctx.out.line("a test alert was sent. When it arrives, run: ochost alerts ack <code from the alert>");
  ctx.out.line(`the code is ${rec.code}; it is in the alert text`);
  return EXIT.ok;
}

async function test(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const rec = readAlertsRecord(ctx.dir);
  if (!rec || rec.channel === "none") throw new CliError("alerts are off", "run ochost alerts setup");
  const next = await sendTest(ctx, ops.install, rec);
  if (ctx.out.json) ctx.out.result({ ok: true, sentAt: next.sentAt });
  else ctx.out.line(`test alert sent; ochost alerts ack ${next.code} when it arrives`);
  return EXIT.ok;
}

async function ack(ctx: OpsCtx): Promise<number> {
  const code = ctx.args.positionals[1];
  if (!code) throw usage("alerts ack needs the code", "ochost alerts ack <code from the test alert>");
  const rec = readAlertsRecord(ctx.dir);
  const ops = opsClient(ctx);
  // The Control DO decides: it holds the waiting test alert and its code.
  const r = await ops.call("POST", "/ops/alerts/ack", { code }, { allow: [200, 404, 409] });
  if (r.status === 409) {
    const why = (r.body as { error?: string } | null)?.error;
    if (why === "code-mismatch")
      throw new CliError(
        "the code does not match the last test alert",
        "copy it again, or ochost alerts test",
      );
    throw new CliError("no test alert is waiting", "run ochost alerts test");
  }
  if (r.status === 404) {
    // An old Worker without the route: fall back to the local record.
    if (!rec?.code) throw new CliError("no test alert is waiting", "run ochost alerts test");
    if (code.toLowerCase() !== rec.code)
      throw new CliError(
        "the code does not match the last test alert",
        "copy it again, or ochost alerts test",
      );
    ctx.out.warn("the Worker has no /ops/alerts/ack — fix: ochost deploy; the ack is kept here only");
  }
  if (rec) writeAlertsRecord(ctx.dir, { ...rec, ackedAt: ctx.now() });
  if (ctx.out.json) ctx.out.result({ ok: true, worker: r.status === 200 });
  else ctx.out.line("alerts confirmed");
  return EXIT.ok;
}

/** `ochost alerts close <class>`: close one open alert (POST /ops/alerts/close). */
async function close(ctx: OpsCtx): Promise<number> {
  const cls = ctx.args.positionals[1];
  if (!cls || !/^[A-Za-z0-9._:-]{1,64}$/.test(cls))
    throw usage(
      "alerts close needs the alert class",
      "ochost alerts close <class> (ochost alerts list shows them)",
    );
  const ops = opsClient(ctx);
  const r = await ops.call("POST", "/ops/alerts/close", { class: cls, by: "cli" }, { allow: [200, 404] });
  if (r.status === 404) {
    const notOpen = (r.body as { error?: string } | null)?.error === "not-open";
    throw new CliError(
      notOpen ? `no open alert ${cls}` : "the Worker has no /ops/alerts/close",
      notOpen ? "ochost alerts list shows the open ones" : "ochost deploy",
    );
  }
  if (ctx.out.json) ctx.out.result({ ok: true, class: cls });
  else ctx.out.line(`closed alert ${cls}`);
  return EXIT.ok;
}
