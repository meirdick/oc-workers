import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fmtDue, lossFrom } from "../src/backup.ts";
import { gatewayOf, managedWebhook } from "../src/doctor.ts";
import { sourceOf } from "../src/logs.ts";
import { parseArgs, redact, registerSecret, stripJsonc } from "../src/ops-lib.ts";
import { setBlockKey, validProactive } from "../src/sleep.ts";
import { alternatives, costRange, sleepState, vmLine } from "../src/status.ts";
import { wranglerCommand } from "../src/wrangler.ts";
import { FakeOps, fakeClock, fakeRunner, installDir, OWNER, run, statusBody, T0 } from "./ops-fake.ts";

let f: FakeOps;
let dir: string;
beforeEach(async () => {
  f = await new FakeOps().start();
  dir = installDir(f.url);
});
afterEach(() => f.stop());

describe("status", () => {
  it("shows mode, state, gen, last activity, next wake, cost range and the VM line; GET only", async () => {
    const r = await run("status", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/state\s+asleep/);
    expect(r.out).toMatch(/mode\s+auto · prod · cost guard ok/);
    expect(r.out).toMatch(/gen\s+42 \(complete\) · epoch 3/);
    expect(r.out).toMatch(/last activity\s+25m ago/);
    expect(r.out).toMatch(/next wake\s+in 90m/);
    expect(r.out).toMatch(/cost\s+\$\d+\.\d\d-\$\d+\.\d\d this month/);
    expect(r.out).toMatch(
      /alternatives\s+always-on here \$\d+\.\d\d · Hetzner CX33 \$10\.43, \$12\.52 with backups \(guess\): /,
    );
    expect(r.out).toMatch(/inbox\s+pending 0 · held 1 · accepted 3 · dead 0/);
    expect(f.reqs.every((q) => q.method === "GET")).toBe(true);
    expect(f.reqs[0]?.auth).toBe(`Bearer ${OWNER}`);
  });

  it("shows the sleep state in words: asleep, awake with a countdown, blocked, held by the guard, off", async () => {
    const text = async (over: Record<string, unknown>, cfg?: string) => {
      f.status = statusBody(over);
      const d = cfg ? installDir(f.url, { hostConfig: cfg }) : dir;
      const r = await run("status", ["--dir", d]);
      return r.out;
    };
    expect(await text({})).toMatch(/^sleep\s+asleep; wakes on a message, a cron job or a login$/m);
    // idle timer 5 min, last activity 2 min ago -> 3 min left
    const running = {
      state: "running",
      blockers: ["3:idle"],
      rt: { hb: { lastActivityAt: T0 - 2 * 60_000 } },
    };
    expect(await text(running)).toMatch(/^sleep\s+awake; sleeps in about 3m if idle$/m);
    expect(await text(running)).toMatch(/^next wake\s+none; awake now$/m);
    expect(await text({ ...running, blockers: ["6:channels-unknown"] })).toMatch(
      /^sleep\s+awake: 6:channels-unknown keeps it on/m,
    );
    expect(await text({ ...running, costGuard: { holding: true } })).toMatch(
      /^sleep\s+awake: held by the cost guard$/m,
    );
    expect(await text(running, '{ "name": "x", "sleep": { "mode": "off" } }')).toMatch(
      /^sleep\s+off: always on/m,
    );
  });

  it("a full disk: the disk row and the degraded warning with its reason (plan §4.12)", async () => {
    f.status = statusBody({
      state: "running",
      degraded: true,
      degradedWhy: ["disk-full"],
      disk: { gen: 42, usedPct: 96.2, inodesPct: 2, at: T0 },
      alerts: [{ class: "disk-full", severity: "high" }],
    });
    const r = await run("status", ["--dir", dir]);
    expect(r.out).toMatch(/^disk\s+used 96\.2% · inodes 2%$/m);
    expect(r.out + r.err).toMatch(/the install is degraded \(disk-full\) — fix: ochost doctor/);
    const plain = await run("status", ["--dir", dir, "--json"]);
    expect(JSON.parse(plain.out)).toMatchObject({ degraded: true, degradedWhy: ["disk-full"] });
  });

  it("alternatives line: always-on here and the VM; with no usage data, an estimate for the cost", async () => {
    f.status = statusBody({ wake: undefined });
    const r = await run("status", ["--dir", dir]);
    expect(r.out).toMatch(/^cost\s+about \$7-14\/month at light use .*\(estimate; no usage data yet\)$/m);
    expect(r.out).toMatch(
      /^alternatives\s+Hetzner CX33 \$10\.43, \$12\.52 with backups \(guess\); no cost data yet$/m,
    );
    const a = alternatives(
      costRange({ monthUsd: 9.3, sleeps24: 20, awakeS24: 8640, alwaysOnMonthUsd: 47.6 }),
    );
    expect(a).toMatchObject({ alwaysOnUsd: 52.6, vm: { usd: 10.43 } });
    expect(a.line).toMatch(/^always-on here \$52\.60 · Hetzner CX33/);
    expect(
      sleepState({
        mode: "auto",
        state: "waking",
        blockers: [],
        costGuardHolding: false,
        lastActivityAt: null,
        idleMs: 0,
        now: 0,
      }).kind,
    ).toBe("waking");
  });

  it("--json gives one object with the derived fields", async () => {
    const r = await run("status", ["--dir", dir, "--json"]);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({
      ok: true,
      state: "asleep",
      mode: "auto",
      gen: 42,
      nextWakeAt: T0 + 90 * 60_000,
      sleep: { kind: "asleep" },
      alternatives: { vm: { usd: 10.43 } },
    });
    expect(j.cost.lowUsd).toBeLessThan(j.cost.highUsd);
    expect(r.err).toBe("");
  });

  it("no install → exit 1 with the init fix", async () => {
    const r = await run("status", ["--dir", "/nonexistent-ochost"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /^Failed: no oc-host install in \/nonexistent-ochost — fix: run ochost init, or ochost init --adopt/,
    );
  });

  it("wrong token → the Worker's 404 maps to a token fix, token never printed", async () => {
    const d = installDir(f.url, { token: "b".repeat(64) });
    const r = await run("status", ["--dir", d]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refused the owner token .* fix: check \.oc-host\/control-token/);
    expect(r.err + r.out).not.toContain("b".repeat(64));
  });

  it("unreachable Worker → one Failed line", async () => {
    const d = installDir("http://127.0.0.1:1");
    const r = await run("status", ["--dir", d]);
    expect(r.code).toBe(1);
    // the undici cause ("bad port" for port 1) is in the line, not only a bare "fetch failed"
    expect(r.err).toMatch(
      /^Failed: http:\/\/127\.0\.0\.1:1 did not answer \(GET \/ops\/status: .*bad port.*\) — fix: /,
    );
  });

  it("--watch polls until aborted", async () => {
    const ac = new AbortController();
    let n = 0;
    const r = await run("status", ["--dir", dir, "--watch"], {
      signal: ac.signal,
      sleep: async () => {
        if (++n === 2) ac.abort();
      },
    });
    expect(r.code).toBe(0);
    expect(f.calls("GET", "/ops/status").length).toBe(2);
  });

  it("cost range swaps the snapshot price for the low and high guess and adds the plan", () => {
    const c = costRange({ monthUsd: 9.3, sleeps24: 20, awakeS24: 8640, alwaysOnMonthUsd: 47.6 });
    // compute = 9.3 - 600*0.0045 = 6.6; low = 5 + 6.6 + 0.9; high = 5 + 6.6 + 14.4
    expect(c).toMatchObject({ lowUsd: 12.5, highUsd: 26, alwaysOnUsd: 52.6, awakePct: 10 });
    expect(vmLine(c)).toMatch(/about the same, the snapshot price decides/);
    expect(vmLine(costRange({ monthUsd: 1, sleeps24: 0 }))).toMatch(/costs less/);
    expect(vmLine(costRange({ monthUsd: 40, sleeps24: 0 }))).toMatch(/costs more/);
    expect(vmLine(null)).toMatch(/no cost data yet/);
  });
});

describe("logs", () => {
  beforeEach(() => {
    f.ring = [
      { id: 1, at: T0, src: "rt", kind: "state", detail: '{"to":"running"}' },
      { id: 2, at: T0 + 1000, src: "log", kind: "line", detail: "gateway listening on 18789" },
      {
        id: 3,
        at: T0 + 2000,
        src: "log",
        kind: "line",
        detail: "bot 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ok",
      },
      {
        id: 4,
        at: T0 + 3000,
        src: "archive",
        kind: "verify",
        detail: "Bearer abcdefghijklmnopqrstuvwxyz0123",
      },
    ];
  });

  it("prints the last N rows oldest first, redacted", async () => {
    const r = await run("logs", ["--dir", dir, "--lines", "3"]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/gate \s+gateway listening on 18789$/);
    expect(r.out).toContain("[redacted-telegram]");
    expect(r.out).toContain("Bearer [redacted]");
    expect(r.out).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(f.calls("GET", "/ops/logs?limit=3")).toHaveLength(1);
  });

  it("--source gate keeps only ControlGate log-sink lines", async () => {
    const r = await run("logs", ["--dir", dir, "--source", "gate"]);
    expect(r.out.trim().split("\n")).toHaveLength(2);
    expect(sourceOf("log")).toBe("gate");
    expect(sourceOf("ws")).toBe("rt");
    expect(sourceOf("archive")).toBe("ctl");
  });

  it("-f prints only new rows on each 2 s poll", async () => {
    const ac = new AbortController();
    let polls = 0;
    const r = await run("logs", ["--dir", dir, "-f", "-n", "2"], {
      signal: ac.signal,
      sleep: async (ms) => {
        expect(ms).toBe(2000);
        polls++;
        if (polls === 1) f.ring.push({ id: 5, at: T0 + 4000, src: "log", kind: "line", detail: "new line" });
        if (polls === 3) ac.abort();
      },
    });
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/new line$/);
  });

  it("bad --source → exit 2", async () => {
    const r = await run("logs", ["--dir", dir, "--source", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^Failed: --source must be one of ctl, rt, ocsup, gate, alert/);
  });
});

describe("open", () => {
  it("prints the link once and opens the browser", async () => {
    const fr = fakeRunner();
    const r = await run("open", ["--dir", dir], { run: fr.run });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${f.url}/_ochost/login/${"c0de".repeat(8)}`);
    expect(fr.calls.map((c) => c.cmd)).toEqual([process.platform === "darwin" ? "open" : "xdg-open"]);
  });

  it("--no-open --json gives openUrl unredacted and opens nothing", async () => {
    const fr = fakeRunner();
    const r = await run("open", ["--dir", dir, "--no-open", "--json"], { run: fr.run });
    expect(JSON.parse(r.out).openUrl).toBe(`${f.url}/_ochost/login/${"c0de".repeat(8)}`);
    expect(fr.calls).toHaveLength(0);
  });

  it("--qr pipes the link to qrencode, not argv", async () => {
    const fr = fakeRunner((c) => (c.cmd === "qrencode" ? { stdout: "QR\n" } : undefined));
    await run("open", ["--dir", dir, "--qr"], { run: fr.run });
    const q = fr.calls.find((c) => c.cmd === "qrencode");
    expect(q?.input).toContain("/_ochost/login/");
    expect(q?.args.join(" ")).not.toContain("login");
  });
});

describe("sleep", () => {
  it("now: 200 starts the sleep and waits for asleep", async () => {
    let n = 0;
    f.routes.push((q) => {
      if (q.path === "/ops/sleep") return { status: 200, body: { ok: true, opId: "op-1" } };
      if (q.path === "/ops/status")
        return {
          status: 200,
          body: statusBody({ state: ++n >= 3 ? "asleep" : "quiescing", rt: { ops: [{ kind: "sleep" }] } }),
        };
      return undefined;
    });
    const r = await run("sleep", ["now", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/asleep after 9 s/);
  });

  it("now: the op aborts later → exit 1 with the blockers", async () => {
    f.routes.push((q) => {
      if (q.path.startsWith("/ops/sleep")) return { status: 200, body: { ok: true, opId: "op-1" } };
      if (q.path === "/ops/status")
        return {
          status: 200,
          body: statusBody({ state: "running", blockers: ["6:config-recent"], rt: { ops: [] } }),
        };
      return undefined;
    });
    const r = await run("sleep", ["now", "--dir", dir, "--force"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the sleep stopped; still running \(blockers: 6:config-recent\)/);
  });

  it("now --no-wait returns at once", async () => {
    f.routes.push((q) =>
      q.path === "/ops/sleep" ? { status: 200, body: { ok: true, opId: "op-1" } } : undefined,
    );
    const r = await run("sleep", ["now", "--dir", dir, "--no-wait"]);
    expect(r.code).toBe(0);
    expect(f.calls("GET", "/ops/status")).toHaveLength(0);
  });

  it("now: 409 prints the rule and exits 1; --force adds ?force=1", async () => {
    f.routes.push((q) =>
      q.path.startsWith("/ops/sleep")
        ? { status: 409, body: { ok: false, reason: "inbox-busy" } }
        : undefined,
    );
    const r = await run("sleep", ["now", "--dir", dir, "--force"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /^Failed: the sleep gate refused: inbox-busy — fix: ochost status names the blockers/,
    );
    expect(f.calls("POST", "/ops/sleep?force=1")).toHaveLength(1);
  });

  it("status reads /ops/status and oc-host.jsonc", async () => {
    const r = await run("sleep", ["status", "--dir", dir]);
    expect(r.out).toMatch(/mode\s+auto/);
    expect(r.out).toMatch(/proactive\s+2h@08-22/);
    expect(r.out).toMatch(/awake 24 h\s+10\.9%/);
  });

  it("set edits oc-host.jsonc and keeps comments", async () => {
    const r = await run("sleep", ["set", "off", "--idle-minutes", "10", "--proactive", "1h", "--dir", dir]);
    expect(r.code).toBe(0);
    const t = readFileSync(join(dir, "oc-host.jsonc"), "utf8");
    expect(t).toContain('"mode": "off",                        // auto | off');
    expect(t).toContain('"idleMinutes": 10');
    expect(t).toContain('"proactive": "1h"');
    expect(JSON.parse(stripJsonc(t)).sleep).toEqual({ mode: "off", idleMinutes: 10, proactive: "1h" });
    expect(r.out).toMatch(/applies at the next op/);
    expect(f.settingsVer).toBe(1);
    expect(f.settings["sleep.idleMinutes"]).toBe(10);
  });

  it("set rejects bad values with exit 2", async () => {
    expect((await run("sleep", ["set", "sometimes", "--dir", dir])).code).toBe(2);
    expect((await run("sleep", ["set", "--proactive", "3h", "--dir", dir])).code).toBe(2);
    expect(validProactive("2h@08-22")).toBe(true);
    expect(validProactive("0 */2 * * *")).toBe(true);
    expect(validProactive("2h@22-08")).toBe(false);
    expect(setBlockKey('{"x":1}', "sleep", "mode", "off")).toBeNull();
    expect(setBlockKey('{"sleep": {}}', "sleep", "mode", "off")).toContain('"mode": "off"');
  });
});

describe("wake", () => {
  it("already running → exit 0 with no POST", async () => {
    f.status = statusBody({ state: "running" });
    const r = await run("wake", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(f.calls("POST", "/ops/wake")).toHaveLength(0);
  });

  it("asleep → long-poll returns running", async () => {
    f.routes.push((q) =>
      q.path === "/ops/wake?wait=1"
        ? { status: 200, body: { state: "running", waitedMs: 38000 } }
        : undefined,
    );
    const r = await run("wake", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/waking, about 45 s/);
  });

  it("budget passed → exit 4", async () => {
    const clock = fakeClock();
    f.routes.push((q) => {
      if (q.path !== "/ops/wake?wait=1") return undefined;
      clock.advance(120_000);
      return { status: 504, body: { state: "starting", timeout: true } };
    });
    const r = await run("wake", ["--dir", dir, "--timeout", "200"], { now: clock.now, sleep: clock.sleep });
    expect(r.code).toBe(4);
    expect(r.err).toMatch(
      /Failed: the install did not reach running in 200 s \(last: starting\) — fix: the wake goes on/,
    );
    expect(f.calls("POST", "/ops/wake")).toHaveLength(2);
  });
});

describe("restart", () => {
  it("POST /ops/restart, then polls status to running", async () => {
    let n = 0;
    f.routes.push((q) => {
      if (q.path === "/ops/restart")
        return { status: 200, body: { stop: { ok: true }, start: { ok: true, state: "starting" } } };
      if (q.path === "/ops/status")
        return { status: 200, body: statusBody({ state: ++n >= 2 ? "running" : "starting" }) };
      return undefined;
    });
    const r = await run("restart", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/running after 6 s/);
  });

  it("after a deploy the answer says it is an image boot and the archive state", async () => {
    f.routes.push((q) => {
      if (q.path === "/ops/restart")
        return {
          status: 200,
          body: { stop: { ok: true }, start: { ok: true }, redeploy: true, archive: "taken" },
        };
      if (q.path === "/ops/status") return { status: 200, body: statusBody({ state: "running" }) };
      return undefined;
    });
    const r = await run("restart", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /new deploy: workspace archive is current; stopping, then booting the newest image/,
    );
  });

  it("after a deploy a failed pre-restart archive is refused (409): one line with the fix, no status poll", async () => {
    f.routes.push((q) =>
      q.path === "/ops/restart"
        ? { status: 409, body: { error: "pre-restart archive failed", redeploy: true, archive: "failed" } }
        : undefined,
    );
    const r = await run("restart", ["--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Failed: pre-restart archive failed; .*restart did not run — fix: .*--hard/);
    expect(f.calls("GET", "/ops/status")).toHaveLength(0);
  });

  it("socket reset on the status poll after the restart POST (demo ECONNRESET): the GET is tried again", async () => {
    let n = 0;
    f.routes.push((q) => {
      if (q.path === "/ops/restart")
        return { status: 200, body: { stop: { ok: true }, start: { ok: true, state: "starting" } } };
      if (q.path === "/ops/status")
        return { status: 200, body: statusBody({ state: ++n >= 2 ? "running" : "starting" }) };
      return undefined;
    });
    let drops = 1;
    f.drop = (q) => q.method === "GET" && q.path === "/ops/status" && drops-- > 0;
    const r = await run("restart", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(f.calls("POST", "/ops/restart")).toHaveLength(1);
    expect(f.calls("GET", "/ops/status").length).toBeGreaterThanOrEqual(3);
  });

  it("socket closed on the restart POST: not sent twice; the line names the route and the cause", async () => {
    f.drop = (q) => q.method === "POST" && q.path === "/ops/restart";
    const r = await run("restart", ["--dir", dir]);
    expect(r.code).toBe(1);
    expect(f.calls("POST", "/ops/restart")).toHaveLength(1);
    expect(r.err).toMatch(/did not answer \(POST \/ops\/restart: .*other side closed/);
  });

  it("--hard without --yes in non-interactive → exit 3", async () => {
    const r = await run("restart", ["--dir", dir, "--hard"]);
    expect(r.code).toBe(3);
    expect(f.calls("POST", "/ops/restart")).toHaveLength(0);
  });
});

describe("backup", () => {
  const archives = [
    {
      id: "a-2",
      kind: "full",
      state: "complete",
      reason: "cadence",
      size: 12_500_000,
      created_at: T0 - 3_600_000,
      completed_at: T0 - 3_500_000,
      verified_at: T0 - 3_000_000,
    },
    {
      id: "a-1",
      kind: "full",
      state: "bad",
      reason: "cadence",
      size: 0,
      created_at: T0 - 86_400_000,
      bad_reason: "sha",
    },
  ];
  beforeEach(() => {
    f.routes.push((q) =>
      q.method === "GET" && q.path.startsWith("/ops/archive")
        ? {
            status: 200,
            body: {
              newestAgeMs: 3_600_000,
              archives,
              cfg: { everyMs: 21_600_000 },
              drill: { ok: true, at: T0 - 86_400_000 },
            },
          }
        : undefined,
    );
  });

  it("list shows the index", async () => {
    const r = await run("backup", ["list", "--dir", dir]);
    expect(r.out).toMatch(/newest\s+60m ago/);
    expect(r.out).toMatch(/a-2\s+complete\s+full\s+cadence\s+12\.5 MB\s+60m ago/);
    expect(r.out).toMatch(/a-1\s+bad \(sha\)/);
  });

  it("create posts reason owner with the note", async () => {
    f.routes.push((q) =>
      q.method === "POST" && q.path === "/ops/archive"
        ? { status: 202, body: { ok: true, request: { reason: "owner" } } }
        : undefined,
    );
    const r = await run("backup", ["create", "--reason", "before edit", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(f.calls("POST", "/ops/archive")[0]?.body).toEqual({ reason: "owner", note: "before edit" });
  });

  it("restore without --accept-loss in non-interactive → exit 3, nothing posted", async () => {
    const r = await run("backup", ["restore", "a-2", "--dir", dir]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/Writes after 2026-11-01 11:01:40 UTC \(58m ago\) are lost/);
    expect(f.calls("POST", "/ops/restore")).toHaveLength(0);
  });

  it("restore --accept-loss posts op l5", async () => {
    f.routes.push((q) =>
      q.path === "/ops/restore"
        ? { status: 202, body: { ok: true, opId: "l5-1", phase: "chosen" } }
        : undefined,
    );
    const r = await run("backup", ["restore", "a-2", "--accept-loss", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(f.calls("POST", "/ops/restore")[0]?.body).toEqual({ sqlite: "archive:a-2", acceptLoss: true });
  });

  it("restore of a bad or unknown archive fails before posting", async () => {
    expect((await run("backup", ["restore", "a-1", "--accept-loss", "--dir", dir])).err).toMatch(
      /is bad, not complete/,
    );
    expect((await run("backup", ["restore", "a-9", "--accept-loss", "--dir", dir])).err).toMatch(
      /no archive a-9/,
    );
    expect(lossFrom("pitr:2026-11-01T10:00:00Z", [])).toBe(Date.parse("2026-11-01T10:00:00Z"));
    expect(fmtDue({ due: false, why: "gap" })).toBe("no (gap)");
    expect(fmtDue(true)).toBe("yes");
  });
});

describe("snapshot", () => {
  it("falls back to the status chain fields on 404 (W5)", async () => {
    const r = await run("snapshot", ["list", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/newest sleep\s+s-10/);
    expect(r.out).toMatch(/chain length\s+4/);
    expect(r.err).toMatch(
      /WARN: the Worker has no \/ops\/snapshots, so this is the chain summary .* — fix: ochost deploy/,
    );
  });

  it("uses /ops/snapshots when present", async () => {
    f.routes.push((q) =>
      q.path === "/ops/snapshots"
        ? {
            status: 200,
            body: {
              snapshots: [
                {
                  id: "s-10",
                  kind: "sleep",
                  state: "valid",
                  parent: "s-9",
                  createdAt: T0 - 60_000,
                  expiresAt: T0 + 29 * 86_400_000,
                },
              ],
            },
          }
        : undefined,
    );
    const r = await run("snapshot", ["list", "--dir", dir]);
    expect(r.out).toMatch(/s-10\s+sleep\s+valid\s+s-9\s+-\s+60s ago\s+in 29d/);
  });
});

describe("auth", () => {
  it("sessions lists and revokes", async () => {
    f.routes.push((q) => {
      if (q.path === "/ops/auth/sessions")
        return {
          status: 200,
          body: {
            sessions: [
              {
                id: "0123456789ab",
                createdAt: T0 - 7_200_000,
                lastSeen: T0 - 60_000,
                userAgent: "Firefox",
                via: "code",
              },
            ],
          },
        };
      if (q.path === "/ops/auth/revoke") return { status: 200, body: { ok: true, ended: 1 } };
      return undefined;
    });
    const r = await run("auth", ["sessions", "--dir", dir]);
    expect(r.out).toMatch(/0123456789ab\s+2h ago\s+60s ago\s+code\s+Firefox/);
    await run("auth", ["sessions", "--revoke-all", "--dir", dir]);
    expect(f.calls("POST", "/ops/auth/revoke")[0]?.body).toEqual({ id: "0123456789ab" });
  });

  it("rotate --control sets the secret by stdin, then stores the new token 0600", async () => {
    const fr = fakeRunner((c) => {
      if (c.args.includes("secret")) f.token = String(c.input);
      return undefined;
    });
    const r = await run("auth", ["rotate", "--control", "--dir", dir], { run: fr.run });
    expect(r.code).toBe(0);
    const put = fr.calls[0];
    expect(put?.args.slice(-5)).toEqual(["secret", "put", "CONTROL_TOKEN", "--name", "oc-m5-test"]);
    expect(put?.input).toMatch(/^[0-9a-f]{64}$/);
    const p = join(dir, ".oc-host", "control-token");
    expect(readFileSync(p, "utf8").trim()).toBe(put?.input);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(r.out + r.err).not.toContain(String(put?.input));
    expect((await run("status", ["--dir", dir])).code).toBe(0);
  });

  it("rotate --webhook is refused until W10", async () => {
    const r = await run("auth", ["rotate", "--webhook", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/webhook secret rotation is not built yet/);
  });
});

describe("alerts", () => {
  it("setup ntfy → ALERT_URL by stdin, test alert, ack with the code", async () => {
    const fr = fakeRunner();
    f.routes.push((q) =>
      q.path === "/ops/alerts/test" ? { status: 200, body: { sent: 1, failed: 0 } } : undefined,
    );
    const r = await run("alerts", ["setup", "--channel", "ntfy", "--dir", dir], { run: fr.run });
    expect(r.code).toBe(0);
    const put = fr.calls.find((c) => c.args.includes("ALERT_URL"));
    expect(put?.input).toMatch(/^https:\/\/ntfy\.sh\/oc-host-a1b2c3-[0-9a-f]{16}$/);
    const rec = JSON.parse(readFileSync(join(dir, ".oc-host", "alerts.json"), "utf8"));
    expect(rec).toMatchObject({ channel: "ntfy", ackedAt: null });
    expect(f.calls("POST", "/ops/alerts/test")[0]?.body).toEqual({ code: rec.code });
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toContain('"channel": "ntfy"');
    expect((await run("alerts", ["ack", "zzzzzz", "--dir", dir])).code).toBe(1);
    const a = await run("alerts", ["ack", rec.code, "--dir", dir]);
    expect(a.code).toBe(0);
    expect(a.err).toMatch(/no \/ops\/alerts\/ack — fix: ochost deploy/);
    expect(JSON.parse(readFileSync(join(dir, ".oc-host", "alerts.json"), "utf8")).ackedAt).toBe(T0);
  });

  it("setup: sink refuses → subscribe still printed, exit 1 with the webhook fix", async () => {
    f.routes.push((q) =>
      q.path === "/ops/alerts/test" ? { status: 502, body: { sent: 0, failed: 1 } } : undefined,
    );
    const r = await run("alerts", ["setup", "--channel", "ntfy", "--dir", dir], { run: fakeRunner().run });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /subscribe in the ntfy app or browser: https:\/\/ntfy\.sh\/oc-host-a1b2c3-[0-9a-f]{16}/,
    );
    expect(r.err).toMatch(
      /Failed: the alert sink refused the test alert \(sent 0, failed 1\) — fix: .*--channel webhook/,
    );
  });

  it("test: sent 0 failed 0 → WARN W11 (DO has the old env)", async () => {
    f.routes.push((q) =>
      q.path === "/ops/alerts/test" ? { status: 200, body: { sent: 0, failed: 0 } } : undefined,
    );
    await run("alerts", ["setup", "--channel", "ntfy", "--dir", dir], { run: fakeRunner().run });
    const r = await run("alerts", ["test", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/WARN: the Control DO did not send it: .*\(W11\)/);
  });

  it("list warns when not set up", async () => {
    const r = await run("alerts", ["--dir", dir]);
    expect(r.out).toMatch(/channel: none/);
    expect(r.err).toMatch(/WARN: alerts: not set up — fix: ochost alerts setup/);
  });
});

describe("doctor", () => {
  // The Worker runs the checks (worker/test/ctl/panel.test.ts); the CLI fetches GET /ops/doctor and prints it.
  const ok = (name: string, detail: string) => ({ name, result: "PASS", detail });
  const doc = {
    agents: { defaults: { model: { primary: "cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017" } } },
    models: { providers: { cfgw: { baseUrl: "http://15.0.0.3/ai/v1", models: [] } } },
  };
  let panel: Record<string, unknown>;
  beforeEach(() => {
    panel = {
      inst: "a1b2c3",
      ok: true,
      fails: 0,
      warns: 1,
      checks: [
        ok("reach", "Control DO answered"),
        ok("state", "asleep"),
        ok("model hop", "200 in 412 ms (m) through the gate (cached 3m ago, install asleep)"),
        { name: "alerts", result: "WARN", detail: "not set up", fix: "ochost alerts setup" },
      ],
      connected: [ok("model", "x")],
    };
    f.routes.push((q) => {
      if (q.path === "/ops/doctor?fresh=1") return { status: 200, body: panel };
      if (q.path === "/ops/config") return { status: 200, body: { versions: [{ ver: 1, status: "good" }] } };
      if (q.path === "/ops/config/1") return { status: 200, body: { ver: 1, doc } };
      return undefined;
    });
  });

  it("prints the panel's checks and fix lines from one GET; never wakes", async () => {
    const r = await run("doctor", ["--dir", dir]);
    expect(r.code).toBe(0);
    for (const n of ["reach", "state", "model hop", "alerts"])
      expect(r.out).toMatch(new RegExp(`^${n}\\s+(PASS|WARN)`, "m"));
    expect(r.out).toMatch(/^model hop\s+PASS\s+200 in 412 ms .*install asleep\)/m);
    expect(r.out).toMatch(/alerts: not set up -> ochost alerts setup/);
    expect(r.out).toMatch(/4 checks: 3 PASS, 1 WARN, 0 FAIL/);
    expect(f.reqs.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /ops/doctor?fresh=1"]);
    expect(f.reqs[0]?.auth).toBe(`Bearer ${OWNER}`);
  });

  it("--json is the panel JSON as served, unchanged", async () => {
    const r = await run("doctor", ["--dir", dir, "--json"]);
    expect(JSON.parse(r.out)).toEqual(panel);
  });

  it("a FAIL in the panel exits 1", async () => {
    panel = {
      ...panel,
      ok: false,
      fails: 1,
      checks: [
        {
          name: "webhook",
          result: "FAIL",
          detail: "webhookUrl is not set",
          fix: "ochost channels add telegram",
        },
      ],
    };
    const r = await run("doctor", ["--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^webhook\s+FAIL/m);
    expect(r.out).toMatch(/webhook: webhookUrl is not set -> ochost channels add telegram/);
  });

  it("opt-in token file: a direct gateway hop PASS next to the panel's rows, token only in the headers", async () => {
    const tf = join(dir, "ai.token");
    writeFileSync(tf, "t".repeat(53), { mode: 0o600 });
    let seen: any = null;
    const fetchHop: typeof fetch = async (u, init) => {
      if (String(u).startsWith("https://gateway.ai.cloudflare.com/")) {
        seen = { u: String(u), h: init?.headers, b: JSON.parse(String(init?.body)) };
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      }
      return fetch(u, init);
    };
    const r = await run("doctor", ["--dir", dir, "--ai-token-file", tf], { fetch: fetchHop });
    expect(r.out).toMatch(/^model hop\s+PASS/m);
    expect(r.out).toMatch(
      /^gateway hop\s+PASS\s+200 in \d+ ms \(@cf\/deepseek-ai\/deepseek-v4\.1-flash-1017\) direct/m,
    );
    expect(seen.u).toBe(
      `https://gateway.ai.cloudflare.com/v1/${"0".repeat(32)}/default/workers-ai/v1/chat/completions`,
    );
    expect(seen.h["cf-aig-authorization"]).toBe(`Bearer ${"t".repeat(53)}`);
    expect(r.out + r.err).not.toContain("t".repeat(53));
  });

  it("D1: --ai-token-file takes a KEY=value line like init does", async () => {
    const tf = join(dir, "ai.env");
    writeFileSync(tf, `CF_AI_TOKEN=${"t".repeat(53)}\n`, { mode: 0o600 });
    let auth = "";
    const fetchHop: typeof fetch = async (u, init) => {
      if (String(u).startsWith("https://gateway.ai.cloudflare.com/")) {
        auth = String(((init?.headers ?? {}) as Record<string, string>)["cf-aig-authorization"]);
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      }
      return fetch(u, init);
    };
    const r = await run("doctor", ["--dir", dir, "--ai-token-file", tf], { fetch: fetchHop });
    expect(auth).toBe(`Bearer ${"t".repeat(53)}`);
    expect(r.out).toMatch(/^gateway hop\s+PASS/m);
  });

  it("unreachable → reach FAIL, exit 1", async () => {
    const d = installDir("http://127.0.0.1:1");
    const r = await run("doctor", ["--dir", d]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^reach\s+FAIL/m);
  });

  it("helpers", () => {
    expect(managedWebhook("https://x.dev", "https://x.dev/_ochost/hook/telegram/abc")).toBe(true);
    expect(managedWebhook("https://x.dev", "https://y.dev/telegram-webhook")).toBe(false);
    expect(gatewayOf(doc)).toMatchObject({
      model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      direct: false,
    });
    expect(gatewayOf({})).toBeNull();
  });
});

describe("destroy", () => {
  const answer = (c: { args: string[] }) => {
    const a = c.args.join(" ");
    if (a.includes("containers list"))
      return {
        stdout:
          'npm notice\n[{"id":"app1","name":"oc-m5-test-runtime"},{"id":"app2","name":"oc-m5-test-sandboxsession"},{"id":"x","name":"oc-demo-runtime"},{"id":"y","name":"oc-demo-sandboxsession"}]',
      };
    if (a.includes("images list"))
      return {
        stdout:
          '[{"name":"oc-m5-test-runtime-oc","tags":["t1","rootfs-snapshot-s"]},{"name":"oc-m5-test-sandboxsession-sbx","tags":["s1","s2"]},{"name":"oc-demo-runtime-oc","tags":["z"]},{"name":"oc-demo-sandboxsession-sbx","tags":["q"]}]',
      };
    return undefined;
  };

  it("--dry-run prints the plan and deletes nothing", async () => {
    const fr = fakeRunner(answer);
    const r = await run("destroy", ["--dir", dir, "--dry-run"], { run: fr.run });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/plan: delete Worker oc-m5-test/);
    expect(r.err).toMatch(/plan: delete container app oc-m5-test-sandboxsession \(app2\)/);
    expect(r.err).toMatch(/plan: delete 4 registry image tag\(s\)/);
    expect(r.err).toMatch(/plan: keep bucket oc-host-a1b2c3/);
    expect(fr.calls.some((c) => c.args.includes("delete"))).toBe(false);
  });

  it("non-interactive without --yes → exit 3", async () => {
    const fr = fakeRunner(answer);
    expect((await run("destroy", ["--dir", dir], { run: fr.run })).code).toBe(3);
  });

  it("--yes deletes Worker, both apps and own images (runtime and sandbox) only; keeps the bucket", async () => {
    const fr = fakeRunner(answer);
    const r = await run("destroy", ["--dir", dir, "--yes"], { run: fr.run });
    expect(r.code).toBe(0);
    const pre = wranglerCommand()[1].length; // the pinned wrangler prefix (bin path, or npx args)
    const dels = fr.calls.filter((c) => c.args.includes("delete")).map((c) => c.args.slice(pre).join(" "));
    expect(dels).toEqual([
      "delete oc-m5-test --force",
      "containers delete app1",
      "containers delete app2",
      "containers images delete oc-m5-test-runtime-oc:t1",
      "containers images delete oc-m5-test-runtime-oc:rootfs-snapshot-s",
      "containers images delete oc-m5-test-sandboxsession-sbx:s1",
      "containers images delete oc-m5-test-sandboxsession-sbx:s2",
    ]);
  });

  it("--delete-data needs the bucket name back", async () => {
    const fr = fakeRunner(answer);
    expect((await run("destroy", ["--dir", dir, "--yes", "--delete-data"], { run: fr.run })).code).toBe(3);
    const r = await run("destroy", ["--dir", dir, "--yes", "--delete-data", "--bucket", "oc-host-a1b2c3"], {
      run: fr.run,
    });
    expect(r.code).toBe(0);
    expect(fr.calls.some((c) => c.args.join(" ").includes("r2 bucket delete oc-host-a1b2c3"))).toBe(true);
  });

  it("--delete-data purges file storage f/<inst>/ through the Worker first, until done; without it files stay", async () => {
    let left = 2500;
    const order: string[] = [];
    f.routes.push((q) => {
      if (q.path !== "/ops/files/purge" || q.method !== "POST") return undefined;
      order.push("purge");
      const n = Math.min(left, 1000);
      left -= n;
      return { status: 200, body: { ok: true, deleted: n, more: left > 0 } };
    });
    const fr = fakeRunner((c) => {
      if (c.args.includes("delete")) {
        const pre = wranglerCommand()[1].length;
        order.push(c.args.slice(pre, pre + 2).join(" "));
      }
      return answer(c);
    });
    const dry = await run("destroy", ["--dir", dir, "--dry-run", "--delete-data"], { run: fr.run });
    expect(dry.err).toMatch(/plan: delete file storage f\/a1b2c3\/ \(storage location r2\)/);
    const r = await run("destroy", ["--dir", dir, "--yes", "--delete-data", "--bucket", "oc-host-a1b2c3"], {
      run: fr.run,
    });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/done: file storage f\/a1b2c3\/, 2500 object\(s\)/);
    expect(order.slice(0, 4)).toEqual(["purge", "purge", "purge", "delete oc-m5-test"]);
    expect(left).toBe(0);
  });

  it("without --delete-data no purge runs and the plan keeps the files", async () => {
    const fr = fakeRunner(answer);
    const r = await run("destroy", ["--dir", dir, "--yes"], { run: fr.run });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(
      /plan: keep bucket oc-host-a1b2c3 \(data, file storage f\/a1b2c3\/ and install marker\)/,
    );
    expect(f.calls("POST", "/ops/files/purge")).toHaveLength(0);
  });
});

describe("ci", () => {
  it("setup writes the workflow, sets CI_TOKEN and the repo secret by stdin, and checks the token", async () => {
    const fr = fakeRunner((c) => {
      if (c.args.includes("CI_TOKEN")) f.ciToken = String(c.input);
      return undefined;
    });
    const r = await run("ci", ["setup", "--repo", "me/oc", "--dir", dir], { run: fr.run });
    expect(r.code).toBe(0);
    const wf = readFileSync(join(dir, ".github/workflows/oc-host.yml"), "utf8");
    expect(wf).toContain("$OC_HOST_URL/ops/status");
    const gh = fr.calls.filter((c) => c.cmd === "gh");
    expect(gh[0]?.args).toEqual(["secret", "set", "OC_HOST_CI_TOKEN", "--repo", "me/oc"]);
    expect(gh[0]?.input).toBe(f.ciToken);
    expect(gh[1]?.args).toEqual(["variable", "set", "OC_HOST_URL", "--repo", "me/oc", "--body", f.url]);
    expect(f.calls("POST", "/ops/ci")[0]?.body).toMatchObject({ setup: true, repo: "me/oc" });
    expect(f.reqs.at(-1)?.auth).toBe(`Bearer ${f.ciToken}`);
    expect(r.err).not.toMatch(/WARN/);
  });

  it("no repo and no gh → exit 3", async () => {
    const fr = fakeRunner((c) => (c.cmd === "gh" ? { code: 1, stderr: "not a git repository" } : undefined));
    expect((await run("ci", ["setup", "--dir", dir], { run: fr.run })).code).toBe(3);
  });
});

describe("argv, help, redaction", () => {
  it("unknown flag → exit 2; -h → usage", async () => {
    expect((await run("status", ["--bogus"])).code).toBe(2);
    const h = await run("logs", ["-h"]);
    expect(h.code).toBe(0);
    expect(h.out).toMatch(/^ochost logs \[-f\]/);
    expect((await run("nope", [])).code).toBe(2);
  });

  it("parses repeat, inline and negated flags", () => {
    const p = parseArgs(["a", "--json", "--lines=5", "--no-open", "--", "-x"], {
      lines: { type: "string" },
      open: { type: "boolean" },
    });
    expect(p).toEqual({ positionals: ["a", "-x"], flags: { json: true, lines: "5", open: false } });
  });

  it("redacts registered secrets and known shapes", () => {
    registerSecret("s3cr3t-value-123");
    expect(redact("x s3cr3t-value-123 y")).toBe("x [redacted] y");
    expect(redact('"cf-aig-authorization": "Bearer abcdefghijklmnopqrstuvwxyz"')).not.toContain("abcdefghij");
  });
});
