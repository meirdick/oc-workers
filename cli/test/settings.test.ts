// oc-host.jsonc tunable keys: validation, OC_SETTINGS render, `config set <key>` (no deploy), spend limit text.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultsFlat, expand, SPECS } from "../../worker/src/core/tunables.ts";
import { defaultConfigText, parseJsonc, validateConfig, workerSettings } from "../src/config.ts";
import { stripJsonc } from "../src/ops-lib.ts";
import { FakeOps, installDir, run } from "./ops-fake.ts";

const base = () =>
  parseJsonc(defaultConfigText({ name: "oc", inst: "a1b2c3", accountId: "0".repeat(32) })) as any;
const cfgWith = (over: (c: any) => void) => {
  const c = base();
  over(c);
  return c;
};

describe("default file and validation", () => {
  it("the default file carries every tunable key with the Worker default", () => {
    const c = validateConfig(base());
    const vals = workerSettings(c, "https://x");
    // same values as the Worker table, except tz (from the machine)
    const want = expand(defaultsFlat()) as any;
    delete want.runtime.tz;
    delete (vals as any).runtime.tz;
    delete (vals as any).publicOrigin;
    // env-owned keys (not in the settings document): deploy sends them
    expect((vals as any).sandbox).toBe("off");
    expect((vals as any).telegram).toEqual({ wakeProgress: "delete" });
    delete (vals as any).sandbox;
    delete (vals as any).telegram;
    expect(vals).toEqual(want);
    expect(SPECS.length).toBeGreaterThan(30);
  });

  it.each([
    [
      "checkpoint.intervalMinutes below the floor",
      (c: any) => (c.checkpoint.intervalMinutes = 5),
      /checkpoint.intervalMinutes must be 10 to 1440/,
    ],
    [
      "archive.maxPerDay above the cap",
      (c: any) => (c.archive.maxPerDay = 500),
      /archive.maxPerDay must be 1 to 96/,
    ],
    [
      "alerts.minSeverity not a level",
      (c: any) => (c.alerts.minSeverity = "loud"),
      /minSeverity must be info or warn or high/,
    ],
    ["sleep.idleMinutes not whole", (c: any) => (c.sleep.idleMinutes = 2.5), /whole number/],
    ["login.rateLimits.ipFail zero", (c: any) => (c.login.rateLimits.ipFail = 0), /ipFail must be 1 to 1000/],
    ["storage refuse below prune", (c: any) => (c.storage.refuseAtMb = 500), /refuseAtMb must be above/],
    ["inbox hold past dead", (c: any) => (c.inbox.holdHours = 30), /holdHours must be below/],
    ["upgrade.auto true", (c: any) => (c.upgrade.auto = true), /not built yet \(M6\)/],
    ["spendLimitUsd negative", (c: any) => (c.llm.spendLimitUsd = -1), /spendLimitUsd/],
  ])("refuses %s", (_n, mut, re) => {
    expect(() => validateConfig(cfgWith(mut))).toThrow(re);
  });

  it("accepts a file with only some keys and the old maintenance.maxUptimeHours name", () => {
    const c = validateConfig({
      name: "oc",
      inst: "a1b2c3",
      sleep: { mode: "auto", proactive: "off" },
      maintenance: { hour: 3, maxUptimeHours: 20 },
      llm: { gateway: "oc-host", primary: "@cf/a/b" },
    });
    const w = workerSettings(c, "https://x") as any;
    expect(w.sleep.maxAwakeHours).toBe(20);
    expect(w.runtime.maintenanceHour).toBe(3);
    expect(w.archive).toBeUndefined();
  });
});

describe("config set <oc-host key>", () => {
  let f: FakeOps;
  let dir: string;
  beforeEach(async () => {
    f = await new FakeOps().start();
    dir = installDir(f.url, {
      hostConfig: defaultConfigText({ name: "oc-m5-test", inst: "a1b2c3", accountId: "0".repeat(32) }),
    });
  });
  afterEach(() => f.stop());

  it("writes the settings document and oc-host.jsonc; no deploy, no OpenClaw config version", async () => {
    const r = await run("config", ["set", "sleep.idleMinutes", "12", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/settings version 1: sleep.idleMinutes = 12/);
    expect(r.out).toMatch(/no deploy needed/);
    expect(f.settings).toEqual({ "sleep.idleMinutes": 12 });
    const text = readFileSync(join(dir, "oc-host.jsonc"), "utf8");
    expect(JSON.parse(stripJsonc(text)).sleep.idleMinutes).toBe(12);
    expect(text).toContain("// doubles after a quick re-wake"); // comments kept
    expect(f.reqs.map((q) => `${q.method} ${q.path}`)).toEqual(["PUT /ops/settings"]);
  });

  it("reaches a nested key (login.rateLimits.ipFail) and a top-level key (timezone)", async () => {
    await run("config", ["set", "login.rateLimits.ipFail", "9", "--dir", dir]);
    await run("config", ["set", "timezone", "Europe/Berlin", "--dir", dir]);
    const c = JSON.parse(stripJsonc(readFileSync(join(dir, "oc-host.jsonc"), "utf8")));
    expect(c.login.rateLimits).toMatchObject({ ipFail: 9, ipTry: 20 });
    expect(c.timezone).toBe("Europe/Berlin");
    expect(f.settings).toEqual({ "login.rateLimits.ipFail": 9, "runtime.tz": "Europe/Berlin" });
  });

  it("refuses an out-of-range value before the call and leaves the file alone", async () => {
    const before = readFileSync(join(dir, "oc-host.jsonc"), "utf8");
    const r = await run("config", ["set", "chain.tagWarn", "5", "--dir", dir]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/chain.tagWarn must be 10 to 2000/);
    expect(f.reqs).toHaveLength(0);
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toBe(before);
  });

  it("keeps the file when the Worker refuses a relation between keys", async () => {
    const before = readFileSync(join(dir, "oc-host.jsonc"), "utf8");
    const r = await run("config", ["set", "inbox.holdHours", "23", "--dir", dir]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/holdHours must be below/);
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toBe(before);
  });

  it("--unset puts the default back; get and settings read the live values", async () => {
    await run("config", ["set", "archive.everyHours", "12", "--dir", dir]);
    expect((await run("config", ["get", "archive.everyHours", "--dir", dir])).out.trim()).toBe("12");
    await run("config", ["set", "archive.everyHours", "--unset", "--dir", dir]);
    expect((await run("config", ["get", "archive.everyHours", "--dir", dir])).out.trim()).toBe("6");
    expect(f.settings).toEqual({});
    const s = await run("config", ["settings", "--dir", dir]);
    expect(s.out).toMatch(/archive.everyHours\s+6\s+default/);
  });

  it("settings push sends the file's tuning keys as the whole document; omitted keys fall back to defaults", async () => {
    await run("config", ["set", "archive.everyHours", "12", "--dir", dir]);
    // hand edit, then push
    const file = join(dir, "oc-host.jsonc");
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replace('"idleMinutes": 5,', '"idleMinutes": 9,')
        .replace('"everyHours": 12', '"everyHours": 6'),
    );
    const r = await run("settings", ["push", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/pushed oc-host.jsonc/);
    expect(f.settings["sleep.idleMinutes"]).toBe(9);
    expect(f.settings["archive.everyHours"]).toBe(6);
    expect(f.settings.publicOrigin).toBeUndefined();
    expect(f.reqs.at(-1)?.body.doc.sleep.idleMinutes).toBe(9);
    expect((await run("settings", ["push", "--dir", dir])).out).toMatch(/\(no change\)/);
  });
});
