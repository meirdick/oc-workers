// One-shot init (docs/20 §1): flags and questions become the setup commands the owner would run next.
import { describe, expect, it } from "vitest";
import { sandboxOf } from "../src/init.ts";
import { askPost, materializeToken, postOptionsOf, postSteps, runPost } from "../src/init-post.ts";
import { type Ctx, makeUi, parseArgs } from "../src/ui.ts";

const SPEC = {
  "telegram-token-file": { type: "string" },
  sandbox: { type: "string" },
  alerts: { type: "string" },
  "alerts-url": { type: "string" },
  "access-domain": { type: "string" },
  "access-token-file": { type: "string" },
} as const;
const args = (argv: string[]) => ({ args: parseArgs(argv, SPEC as never) });

describe("postOptionsOf", () => {
  it("reads the flags; refuses a bad --alerts and a webhook without a URL", () => {
    expect(
      postOptionsOf(
        args([
          "--telegram-token-file",
          "/t",
          "--alerts",
          "webhook",
          "--alerts-url",
          "https://h.example/x",
          "--access-domain",
          "oc.example.com",
          "--access-token-file",
          "/a",
        ]),
      ),
    ).toEqual({
      telegram: "/t",
      alerts: "webhook",
      alertsUrl: "https://h.example/x",
      accessDomain: "oc.example.com",
      accessTokenFile: "/a",
    });
    expect(postOptionsOf(args([]))).toEqual({});
    expect(() => postOptionsOf(args(["--alerts", "mail"]))).toThrow(/--alerts must be ntfy or webhook/);
    expect(() => postOptionsOf(args(["--alerts", "webhook"]))).toThrow(/needs --alerts-url/);
  });

  it("--sandbox on|all|off", () => {
    expect(sandboxOf("on")).toBe("on");
    expect(sandboxOf("all")).toBe("all");
    expect(sandboxOf(undefined)).toBeUndefined();
    expect(() => sandboxOf("yes")).toThrow(/not on, all or off/);
  });
});

describe("postSteps", () => {
  it("telegram, alerts, access, in that order; a test install skips Telegram", () => {
    const o = {
      telegram: "/t",
      alerts: "ntfy" as const,
      accessDomain: "oc.example.com",
      accessTokenFile: "/a",
    };
    expect(postSteps(o, false)).toEqual([
      { label: "telegram", name: "channels", argv: ["add", "telegram", "--token-file", "/t"] },
      { label: "alerts", name: "alerts", argv: ["setup", "--channel", "ntfy"] },
      { label: "access", name: "auth", argv: ["access", "--domain", "oc.example.com", "--token-file", "/a"] },
    ]);
    expect(postSteps(o, true).map((s) => s.label)).toEqual(["alerts", "access"]);
    expect(postSteps({ telegram: true }, false)).toEqual([
      { label: "telegram", name: "channels", argv: ["add", "telegram"] },
    ]);
    expect(postSteps({}, false)).toEqual([]);
  });
});

describe("askPost", () => {
  const ctxOf = (answers: string[], interactive = true) => {
    let err = "";
    const ctx = {
      ui: makeUi(
        { json: false, nonInteractive: !interactive },
        { err: { write: (s: string) => (err += s) }, out: { write: () => 0 } },
      ),
      interactive,
      prompt: { ask: async () => answers.shift() ?? "", askHidden: async () => "" },
    } as unknown as Ctx;
    return ctx;
  };
  it("asks once per open item; Enter skips; non-interactive asks nothing", async () => {
    const none = () => false;
    expect(await askPost(ctxOf(["", ""]), {}, false, none)).toEqual({});
    expect(await askPost(ctxOf(["123:abc", "oc.example.com", ""]), {}, false, none)).toEqual({
      telegram: "123:abc",
      accessDomain: "oc.example.com",
    });
    // a known file exists: Enter takes it, "-" skips, a path wins
    const all = () => true;
    const home = process.env.HOME ?? "";
    expect(await askPost(ctxOf(["", "oc.example.com", ""]), {}, false, all)).toEqual({
      telegram: `${home}/.config/oc-host/telegram.env`,
      accessDomain: "oc.example.com",
      accessTokenFile: `${home}/.config/oc-host/cf-access.env`,
    });
    expect(await askPost(ctxOf(["-", "oc.example.com", "-"]), {}, false, all)).toEqual({
      accessDomain: "oc.example.com",
    });
    expect(await askPost(ctxOf(["~/t.env", ""]), {}, false, all)).toEqual({ telegram: `${home}/t.env` });
    // alerts are flags only, never a question
    expect(await askPost(ctxOf(["", ""]), { telegram: "/t", alerts: "ntfy" }, false, none)).toEqual({
      telegram: "/t",
      alerts: "ntfy",
    });
    // a test install: no Telegram question
    expect(await askPost(ctxOf([""]), {}, true, none)).toEqual({});
    expect(await askPost(ctxOf(["x"], false), {}, false, none)).toEqual({});
  });
});

describe("materializeToken and runPost", () => {
  it("a pasted token becomes a temp file that the cleanup removes; a path stays a path", async () => {
    const removed: string[] = [];
    const io = {
      exists: (p: string) => p === "/exists",
      writeTemp: async () => "/tmp/x/telegram.env",
      remove: (p: string) => removed.push(p),
    };
    const a = await materializeToken({ telegram: "123:abc" }, io);
    expect(a.o.telegram).toBe("/tmp/x/telegram.env");
    a.cleanup();
    expect(removed).toEqual(["/tmp/x/telegram.env"]);
    const b = await materializeToken({ telegram: "/exists" }, io);
    expect(b.o.telegram).toBe("/exists");
  });

  it("runs each step; a failure prints the fix and the rest still runs", async () => {
    let err = "";
    const ctx = {
      ui: makeUi(
        { json: false, nonInteractive: true },
        { err: { write: (s: string) => (err += s) }, out: { write: () => 0 } },
      ),
      dir: "/d",
      interactive: false,
    } as unknown as Ctx;
    const calls: string[] = [];
    const r = await runPost(
      ctx,
      [
        { label: "telegram", name: "channels", argv: ["add", "telegram"] },
        { label: "alerts", name: "alerts", argv: ["setup"] },
      ],
      async (name, argv) => {
        calls.push(`${name} ${argv.join(" ")}`);
        return name === "channels" ? 4 : 0;
      },
    );
    expect(calls).toEqual(["channels add telegram", "alerts setup"]);
    expect(r).toEqual({ done: ["alerts"], failed: ["telegram"] });
    expect(err).toMatch(/telegram did not finish — fix: ochost channels add telegram/);
  });
});
