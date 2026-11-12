// Terminal UX: one line per step with elapsed time, the final summary block, --json events and result.
import { describe, expect, it } from "vitest";
import { COST_ALWAYS_ON, COST_LIGHT, nextCommands, type SummaryInput, summaryLines } from "../src/summary.ts";
import { CliError, fmtElapsed, makeUi, toFailedLine } from "../src/ui.ts";
import { makeWrangler, QUIET_ENV } from "../src/wrangler.ts";

function capture(opts: { json: boolean; verbose?: boolean }) {
  const err: string[] = [];
  const out: string[] = [];
  const ui = makeUi(
    { nonInteractive: true, ...opts },
    { err: { write: (s: string) => err.push(s) }, out: { write: (s: string) => out.push(s) } },
  );
  return { ui, err: () => err.join(""), out: () => out.join("") };
}

describe("step lines", () => {
  it("holds step() lines back and prints one line with the elapsed time", () => {
    const c = capture({ json: false });
    c.ui.begin();
    c.ui.step("deploy: pushing layer 3", "deploy");
    c.ui.step("deploy: done in 2 min 41 s (1 attempt(s))", "deploy");
    expect(c.err()).toBe("");
    c.ui.end({ n: 8, total: 13, label: "deploy", detail: "Worker and image deployed", ms: 161_000 });
    expect(c.err()).toBe("[ 8/13] deploy     Worker and image deployed  2 min 41 s\n");
  });

  it("a WARN, a note and say() are not held back", () => {
    const c = capture({ json: false });
    c.ui.begin();
    c.ui.warn("x is odd — fix: do y");
    c.ui.note("retry 1 of 3: blob unknown");
    c.ui.say("Open https://example.test");
    expect(c.err()).toBe(
      "WARN: x is odd — fix: do y\n  retry 1 of 3: blob unknown\nOpen https://example.test\n",
    );
  });

  it("without a detail, the last held line without its step prefix", () => {
    const c = capture({ json: false });
    c.ui.begin();
    c.ui.step("r2: bucket oc-x created", "r2");
    c.ui.end({ n: 2, total: 5, label: "r2 bucket", ms: 400 });
    expect(c.err()).toBe("[2/5] r2 bucket  bucket oc-x created  0.4 s\n");
  });

  it("--verbose prints every line; --json prints events and one done event per step", () => {
    const v = capture({ json: false, verbose: true });
    v.ui.begin();
    v.ui.step("a: one", "a");
    v.ui.step("a: two", "a");
    expect(v.err()).toBe("a: one\na: two\n");
    const j = capture({ json: true });
    j.ui.begin();
    j.ui.step("a: one", "a");
    j.ui.end({ n: 1, total: 2, label: "a", detail: "d", ms: 1500 });
    const ev = j
      .err()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ev[0]).toMatchObject({ step: "a", msg: "a: one" });
    expect(ev[1]).toMatchObject({ step: "a", done: true, n: 1, total: 2, ms: 1500, msg: "d" });
  });

  it("long details are cut to one terminal line", () => {
    const c = capture({ json: false });
    c.ui.begin();
    c.ui.end({ n: 1, total: 2, label: "x", detail: "y".repeat(200), ms: 1000 });
    expect(c.err().length).toBeLessThan(90);
    expect(c.err()).toContain("…");
  });

  it("fmtElapsed", () => {
    expect([fmtElapsed(40), fmtElapsed(900), fmtElapsed(12_400), fmtElapsed(161_000)]).toEqual([
      "0.0 s",
      "0.9 s",
      "12 s",
      "2 min 41 s",
    ]);
  });
});

describe("summary block", () => {
  const base: SummaryInput = {
    url: "https://oc-host.me.workers.dev",
    openUrl: "https://oc-host.me.workers.dev/_ochost/login/abc",
    openUrlMinutes: 5,
    fakeTelegram: false,
    model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    gateway: "oc-host",
    sleepMode: "auto",
    idleMinutes: 5,
    elapsedMs: 252_000,
    self: "ochost",
    dirArg: "",
  };

  it("UI, login, bot, model, mode, cost range and next commands", () => {
    const t = summaryLines(base).join("\n");
    expect(t).toContain("Up in 4 min 12 s.");
    expect(t).toMatch(/UI\s+https:\/\/oc-host\.me\.workers\.dev\n/);
    expect(t).toMatch(/Login\s+\S+\/_ochost\/login\/abc\s+\(single use, 5 min; ochost open makes another\)/);
    expect(t).toMatch(/Bot\s+none yet/);
    expect(t).toMatch(/Model\s+@cf\/deepseek-ai\/deepseek-v4\.1-flash-1017 via gateway oc-host/);
    expect(t).toMatch(/Mode\s+sleeps after 5 min idle/);
    expect(t).toContain(`about $${COST_LIGHT.lowUsd}-${COST_LIGHT.highUsd}/month at light use`);
    expect(t).toContain(`always-on would be $${COST_ALWAYS_ON.lowUsd}-${COST_ALWAYS_ON.highUsd}`);
    expect(t).toMatch(/Next:\n\s+ochost channels add telegram\s+one paste/);
    expect(t).toMatch(/ochost status\s+sleep state, next wake, cost/);
  });

  it("with a bot and a custom dir: no telegram hint, --dir on every command; fake bot is marked", () => {
    const i = { ...base, bot: "oc_host_test_bot", fakeTelegram: true, dirArg: " --dir /x y" };
    const t = summaryLines(i).join("\n");
    expect(t).toMatch(/Bot\s+@oc_host_test_bot \(fake, test install\)/);
    expect(nextCommands(i).map((n) => n.cmd)).toEqual([
      "ochost status --dir /x y",
      "ochost doctor --dir /x y",
      "ochost alerts setup --dir /x y",
    ]);
  });

  it("alerts off (the default): the last next command says so and how to turn them on; set: no such line", () => {
    expect(summaryLines({ ...base, alerts: "none" }).join("\n")).toMatch(
      /ochost alerts setup\s+alerts are off \(the default\); this turns them on$/,
    );
    for (const alerts of ["ntfy", "webhook"])
      expect(nextCommands({ ...base, alerts }).map((n) => n.cmd)).not.toContain("ochost alerts setup");
  });

  it("--skip-ai: no model, the next command is ai-gateway setup", () => {
    const i = { ...base, model: undefined, gateway: undefined };
    expect(summaryLines(i).join("\n")).toMatch(/Model\s+none \(--skip-ai\)/);
    expect(nextCommands(i)[1]?.cmd).toBe("ochost ai-gateway setup");
  });

  it("sleep off: always-on cost", () => {
    const t = summaryLines({ ...base, sleepMode: "off" }).join("\n");
    expect(t).toMatch(/Mode\s+always on/);
    expect(t).toMatch(/Cost\s+always-on: \$50-69\/month/);
  });
});

describe("error lines", () => {
  it("one line: Failed: <you see> — fix: <do this>, secrets redacted", () => {
    expect(toFailedLine(new CliError("no AI token\nat x", "open the link,\nrerun"))).toBe(
      "Failed: no AI token at x — fix: open the link, rerun",
    );
    expect(toFailedLine(new Error("boom"))).toBe(
      "Failed: boom — fix: rerun with OCHOST_DEBUG=1 and report the output",
    );
  });
});

describe("wrangler noise", () => {
  it("every wrangler call runs with the quiet environment", async () => {
    let env: Record<string, string | undefined> = {};
    const w = makeWrangler(
      async (_c, _a, o) => {
        env = o?.env ?? {};
        return { code: 0, stdout: "", stderr: "" };
      },
      { accountId: "a".repeat(32) },
    );
    await w.run(["whoami"]);
    expect(env).toMatchObject({ ...QUIET_ENV, CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) });
    expect(env.WRANGLER_LOG).toBe("error");
    expect(env.WRANGLER_HIDE_BANNER).toBe("true");
  });

  it("wrangler --format json runs with WRANGLER_LOG=log so stdout is not empty", async () => {
    const envs: Record<string, string | undefined>[] = [];
    const w = makeWrangler(async (_c, _a, o) => {
      envs.push(o?.env ?? {});
      return { code: 0, stdout: "", stderr: "" };
    });
    await w.run(["secret", "list", "--format", "json", "--name", "x"]);
    await w.run(["whoami"]);
    expect(envs[0]?.WRANGLER_LOG).toBe("log");
    expect(envs[1]?.WRANGLER_LOG).toBe("error");
  });
});

describe("token files", () => {
  it("tokenFromText: a bare token, or KEY=value lines with the named key first", async () => {
    const { tokenFromText, expandHome } = await import("../src/ui.ts");
    expect(tokenFromText("  123:abc \n")).toBe("123:abc");
    expect(tokenFromText("TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_OWNER_ID=5\n", ["TELEGRAM_BOT_TOKEN"])).toBe(
      "123:abc",
    );
    expect(tokenFromText('# c\nexport CF_ACCESS_TOKEN="tok"\n', ["CF_ACCESS_TOKEN"])).toBe("tok");
    expect(tokenFromText("OTHER=x\nTOKEN=y", ["TOKEN"])).toBe("y");
    expect(tokenFromText("OTHER=x", ["TOKEN"])).toBe("x"); // no named key: the first line
    expect(expandHome("~/a/b", "/home/u")).toBe("/home/u/a/b");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("/x", "/home/u")).toBe("/x");
  });
});
