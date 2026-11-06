// --json on every command (spec 10 §1.1): stdout is exactly one JSON document, also when the command fails.
// A failure is {ok:false, error:"Failed: <you see> — fix: <do this>", exit:<code>} and the same line is on stderr.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPS_COMMANDS } from "../src/ops-commands.ts";
import { FakeOps, installDir, run } from "./ops-fake.ts";

let f: FakeOps;
beforeAll(async () => {
  f = await new FakeOps().start();
});
afterAll(async () => {
  await f.stop();
});

/** One typical call per command or subcommand. The bare fake server answers many with 404, so failures count too. */
const CALLS: [string, string[]][] = [
  ["status", []],
  ["logs", []],
  ["open", ["--no-open"]],
  ["sleep", ["status"]],
  ["sleep", ["now"]],
  ["sleep", ["set", "auto"]],
  ["inbox", ["list"]],
  ["wake", []],
  ["restart", ["--no-wait"]],
  ["backup", ["list"]],
  ["backup", ["create"]],
  ["snapshot", ["list"]],
  ["auth", ["sessions"]],
  ["auth", ["rotate", "--control"]],
  ["alerts", ["list"]],
  ["alerts", ["test"]],
  ["alerts", ["ack", "abc"]],
  ["alerts", ["setup", "--channel", "none"]],
  ["doctor", []],
  ["destroy", ["--dry-run"]],
  ["channels", ["list"]],
  ["pairing", ["list"]],
  ["model", ["list"]],
  ["model", ["set", "@cf/a/b"]],
  ["ai-gateway", ["setup"]],
  ["config", ["get"]],
  ["config", ["list"]],
  ["config", ["pull"]],
  ["config", ["set", "a", "1"]],
  ["secrets", ["list"]],
  ["secrets", ["set", "X"]],
  ["upgrade", ["check"]],
  ["upgrade", ["run"]],
  ["advanced", ["inbox"]],
  ["advanced", ["events"]],
  ["advanced", ["creds"]],
  ["advanced", ["prune"]],
  ["ci", ["setup"]],
  ["soak", ["status"]],
  ["settings", []],
  ["caps", []],
  ["caps", ["set", "requests", "3"]],
  ["sandbox", []],
  ["sandbox", ["on"]],
  ["sandbox", ["sleep"]],
  ["status", ["--bogus"]],
  ["channels", ["add", "slack"]],
];

describe("--json", () => {
  it("the table covers every ops command", () => {
    expect(new Set(CALLS.map(([c]) => c))).toEqual(new Set(Object.keys(OPS_COMMANDS)));
  });

  it.each(CALLS)("%s %s: one JSON document on stdout", async (cmd, args) => {
    const dir = installDir(f.url);
    const r = await run(cmd, [...args, "--dir", dir, "--json"]);
    const doc = JSON.parse(r.out);
    expect(typeof doc).toBe("object");
    if (r.code === 0) expect(doc.ok === false).toBe(false);
    else {
      expect(doc).toMatchObject({ ok: false, exit: r.code });
      expect(doc.error).toMatch(/^Failed: .+ — fix: .+/);
      expect(r.err).toContain(doc.error);
    }
  });

  it("no install: a failure is JSON too", async () => {
    const r = await run("status", ["--dir", "/nonexistent-ochost", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, exit: 1 });
  });
});
