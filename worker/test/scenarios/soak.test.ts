// SoakPlan runner (ctl/soak): routes, bounds computed in the Worker, reply counting, and every step type run on
// the World (Control DO + Runtime DO + fake container, fake clock). The fake container answers the in-container
// scripts with canned JSON; what is asserted is that each step executes, records a result in R2 and that the
// bound logic gives the right verdict on inputs that differ at the boundary.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLANS } from "../../src/ctl/soak/plans";
import { PITR_WRITE, STATE_DB } from "../../src/ctl/soak/scripts";
import { HANDLERS } from "../../src/ctl/soak/steps";
import type { SoakSummary, StepResult } from "../../src/ctl/soak/types";
import type { World } from "../harness/world";
import { done, fresh, sutP, toRunning } from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));

interface Fake {
  /** Offset of the newest surviving managed row before the kill, ms. */
  windowMs: number;
  killedAt: number;
}

/** The container answers each in-container script by what it contains. */
function fakeContainer(world: World, f: Fake) {
  const c = world.rt().c;
  c.signal = (n: number) => {
    if (n === 9) {
      f.killedAt = Date.now();
      c.crash(137);
    }
  };
  c.execHandler = (cmd) => {
    const line = cmd.join(" ");
    const b64 = /echo (\S+) \| base64 -d/.exec(line)?.[1];
    const js = b64 ? Buffer.from(b64, "base64").toString() : "";
    const out = (o: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(o)}\n` });
    if (/setsid nohup/.test(line)) return { exitCode: 0, stdout: "started\n" };
    // pgrep -f sees the `sh -c` running it: a pattern that matches its own command line is "alive" (M7 soak).
    const pg = /pgrep -f '?([^' ]+)'?/.exec(line);
    if (pg) return { exitCode: 0, stdout: new RegExp(pg[1] as string).test(line) ? "alive\n" : "dead\n" };
    if (/SCRUB|ps -eo/.test(line))
      return { exitCode: 0, stdout: "SCRUB 11|openclaw gateway|1|1\nSCRUB 12|ocio helper|1|1\n" };
    if (/df -B1/.test(line)) return { exitCode: 0, stdout: "100000 50000\n" };
    if (/FROM soak_w/.test(js)) {
      const ts = f.killedAt ? f.killedAt - f.windowMs : Date.now() - 500;
      return out({
        now: Date.now(),
        sql: { maxId: 100, maxTs: ts, n: 100 },
        nm: { maxId: 10, maxTs: ts, n: 10 },
        ws: { k: 3, ts },
      });
    }
    if (/INSERT INTO soak_pitr/.test(js)) return out({ n: 100, max: Date.now() });
    if (/sum\(phase='a'\)/.test(js)) return out({ a: 100, b: 0, n: 100 });
    if (/999999/.test(js)) return out({ before: 20, after: 999999 });
    if (/user_version/.test(js)) return out({ uv: 20 });
    if (/soak_g\b/.test(js)) return out({ ok: true });
    if (/createHash/.test(js)) return out({ now: Date.now(), files: { "creds.json": "abc" } });
    return { exitCode: 0, stdout: "" };
  };
}

async function setup(o: { windowMs?: number; noBot?: boolean } = {}) {
  // A test install with its fake Telegram channel added (ochost channels add telegram sets the token).
  w = await fresh(sut, o.noBot ? {} : { vars: { OC_SECRET_OC_TELEGRAM_BOT_TOKEN: "123:fake" } });
  await toRunning(w);
  const f: Fake = { windowMs: o.windowMs ?? 700, killedAt: 0 };
  fakeContainer(w, f);
  return f;
}

const r2json = async <T>(key: string): Promise<T | null> => {
  const o = await w.r2.get(key);
  return o ? (JSON.parse(await o.text()) as T) : null;
};
const view = async () =>
  (await w.ops("soak-plan")).body as {
    plans: { plan: string; state: string; done: number; total: number }[];
    catalog: { name: string; steps: number }[];
  };

/** Advance fake time until the plan is done or stopped. */
async function finish(name: string, maxMs: number, each?: () => Promise<void> | void) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await w.advance(2000, 1000);
    await each?.();
    const p = (await view()).plans.find((x) => x.plan === name);
    if (p && (p.state === "done" || p.state === "stopped")) return p;
  }
  throw new Error(`plan ${name} not finished in ${maxMs} ms`);
}

describe("soak-plan routes", () => {
  it("is 404 without OC_TEST, 400 for an unknown plan, 409 for a running one, and lists the catalog", async () => {
    w = await fresh(sut, { vars: { OC_TEST: "0" } });
    expect((await w.ops("soak-plan")).status).toBe(404);
    w.dispose();
    await setup();
    // Owner only: the CI token and no token get 404 on a test install too.
    for (const token of ["ci", "none"] as const) {
      expect((await w.fetch("/ops/soak-plan", { token })).status).toBe(404);
      const post = { method: "POST", token, body: JSON.stringify({ plan: "smoke" }) };
      expect((await w.fetch("/ops/soak-plan", post)).status).toBe(404);
    }
    expect((await w.ops("soak-plan", { plan: "nope" })).status).toBe(400);
    const ok = await w.ops("soak-plan", { plan: "smoke" });
    expect(ok.status).toBe(202);
    expect(ok.body.queued).toEqual(["smoke"]);
    expect((await w.ops("soak-plan", { plan: "smoke" })).status).toBe(409);
    const v = await view();
    expect(v.catalog.map((c) => c.name)).toEqual(PLANS.map((p) => p.name));
    expect(v.catalog.find((c) => c.name === "sqlite-loss")?.steps).toBe(17);
    expect(v.catalog.find((c) => c.name === "smoke")?.steps).toBe(3);
  });

  it("`all` queues the catalog in order, without smoke; DELETE stops and the summary says stopped", async () => {
    await setup();
    const r = await w.ops("soak-plan", { plan: "all" });
    expect(r.body.queued).toEqual(PLANS.filter((p) => p.all).map((p) => p.name));
    expect(r.body.queued).not.toContain("smoke");
    const d = await w.fetch("/ops/soak-plan", { method: "DELETE" });
    expect(((await d.json()) as { stopped: string[] }).stopped.length).toBe(
      PLANS.filter((p) => p.all).length,
    );
    const s = await r2json<SoakSummary>("results/scrub-live/summary.json");
    expect(s?.state).toBe("stopped");
    expect(s?.pass).toBe(false);
  });
});

describe("soak bounds", () => {
  it("sqlite-loss: windows 0.7 s pass the 3 s bound; a 3.5 s window fails that kill and the item", async () => {
    const f = await setup({ windowMs: 700 });
    await w.ops("soak-plan", { plan: "sqlite-loss", params: { kills: 2, upMs: 3000 } });
    await finish("sqlite-loss", 40 * 60_000);
    const s = await r2json<SoakSummary>("results/sqlite-loss/summary.json");
    const item = s?.items.find((i) => i.item === "sqlite-loss");
    expect(item).toMatchObject({ n: 2, over: 0, pass: true });
    expect(item?.max).toBeCloseTo(0.7, 1);
    const k1 = await r2json<StepResult>("results/sqlite-loss/kill-01.json");
    expect(k1?.checks).toMatchObject({ faultOk: true, restarted: true, probeOk: true });
    expect(s?.pass).toBe(true);

    f.windowMs = 3500;
    await w.ops("soak-plan", { plan: "sqlite-loss", params: { kills: 2, upMs: 3000 } });
    await finish("sqlite-loss", 40 * 60_000);
    const s2 = await r2json<SoakSummary>("results/sqlite-loss/summary.json");
    expect(s2?.items.find((i) => i.item === "sqlite-loss")).toMatchObject({ n: 2, over: 2, pass: false });
    expect(s2?.pass).toBe(false);
    expect(s2?.failedSteps[0]?.checks).toContain("bound:sqlite-loss");
  }, 120_000);

  it("telegram-60: one chat with no reply is 1 unreplied; a chat replied twice is 1 duplicate", async () => {
    await setup();
    await w.ops("soak-plan", { plan: "telegram-60", params: { n: 4, kills: 0, gapMs: 1000 } });
    const sent = new Set<string>();
    const sendOne = async (chat: string, n: number) => {
      for (let i = 0; i < n; i++)
        await w
          .ctl()
          .call("gateCall", "noteOutbound", [{ chatId: chat, at: Date.now(), method: "sendMessage" }]);
    };
    await finish("telegram-60", 40 * 60_000, async () => {
      const chats = w
        .ctl()
        .rows<{ chat_id: string; update_id: string }>(
          "SELECT chat_id, update_id FROM soak_chat ORDER BY chat_id",
        );
      for (const [i, c] of chats.entries()) {
        if (sent.has(c.chat_id) || i === 0) continue; // chat 0 never gets a reply
        sent.add(c.chat_id);
        await sendOne(c.chat_id, i === 1 ? 2 : 1);
      }
    });
    const r = await r2json<StepResult>("results/telegram-60/batch.json");
    expect(r?.data).toMatchObject({ updates: 4, acked: 4, unreplied: 1, duplicates: 1 });
    expect(r?.checks.unreplied0).toBe(false);
    expect(r?.ok).toBe(false);
  }, 120_000);
});

describe("soak runner", () => {
  it("a plan survives a Control DO wipe through R2 and goes on with the next step", async () => {
    await setup();
    await w.ops("soak-plan", {
      plan: "custom",
      steps: [
        { id: "first", type: "note", params: { why: "before" } },
        { id: "wipe", type: "ctl-wipe", params: { timeoutMs: 150_000 } },
        { id: "after", type: "note", params: { why: "after the wipe" } },
      ],
    });
    await finish("custom", 60 * 60_000);
    const after = await r2json<StepResult>("results/custom/after.json");
    expect(after?.skipped).toBe("after the wipe");
    const s = await r2json<SoakSummary>("results/custom/summary.json");
    expect(s?.done).toBe(3);
    expect(s?.skipped.map((x) => x.id)).toEqual(["first", "after"]);
  }, 120_000);

  it("every step type executes and records a result", async () => {
    await setup();
    const t = { timeoutMs: 90_000 };
    const steps = [
      { id: "note", type: "note", params: { why: "x" } },
      { id: "wait", type: "wait", params: { ms: 2000 } },
      { id: "awake", type: "awake" },
      { id: "up", type: "up" },
      { id: "writer", type: "writer", params: { lifeMs: 60_000 } },
      { id: "scrub", type: "scrub" },
      { id: "disk-fill", type: "disk-fill", params: { pct: 96, waitMs: 5000, ...t } },
      { id: "disk-free", type: "disk-free", params: { waitMs: 5000, ...t } },
      { id: "throttle", type: "throttle", params: { holdMs: 5000, ...t } },
      { id: "churn-hold", type: "churn-hold", params: { ms: 5000, sampleMs: 1000, ...t } },
      { id: "creds-compare", type: "creds-compare", params: { settleMs: 5000, ...t } },
      {
        id: "kill",
        type: "kill",
        params: { upMs: 3000, arch: true, items: { sql: "k", nm: "k2", ws: "k3" }, ...t },
      },
      {
        id: "tg-batch",
        type: "tg-batch",
        params: { n: 2, kills: 1, killEvery: 1, gapMs: 1000, settleMs: 20_000, ...t },
      },
      { id: "cycles", type: "cycles", params: { n: 1, ...t } },
      { id: "r2-mark", type: "r2-mark" },
      { id: "s4-final", type: "s4-final" },
      { id: "pitr", type: "pitr", params: t },
      { id: "poison", type: "poison", params: { watchMs: 20_000, ...t } },
      { id: "drill-a", type: "drill-a", params: t },
      { id: "drill-g", type: "drill-g", params: t },
      { id: "r2-outage", type: "r2-outage", params: { ms: 10_000, ...t } },
      { id: "drill-e", type: "drill-e", params: t },
      { id: "ctl-wipe", type: "ctl-wipe", params: t },
    ];
    expect(new Set(steps.map((s) => s.type))).toEqual(new Set(Object.keys(HANDLERS)));
    expect((await w.ops("soak-plan", { plan: "custom", steps })).status).toBe(202);
    await finish("custom", 6 * 60 * 60_000);
    const got: StepResult[] = [];
    for (const s of steps) {
      const r = await r2json<StepResult>(`results/custom/${s.id}.json`);
      expect(r, s.id).not.toBeNull();
      if (r) got.push(r);
    }
    for (const r of got) {
      expect(r.type).toBe(steps.find((s) => s.id === r.id)?.type);
      expect(r.error ?? "", r.id).not.toMatch(/handler:|unknown step/);
    }
    const byId = Object.fromEntries(got.map((r) => [r.id, r]));
    // steps whose fake world answers fully check out
    expect(byId.note?.skipped).toBe("x");
    expect(byId.wait?.ok).toBe(true);
    expect(byId.scrub?.checks).toMatchObject({
      foundGateway: true,
      foundOcio: true,
      environDenied: true,
      memDenied: true,
    });
    expect(byId.writer?.ok).toBe(true);
  }, 300_000);
});

describe("M7 soak findings (docs/research/soak-m7-findings.md)", () => {
  const custom = async (steps: unknown[], maxMs = 60 * 60_000) => {
    expect((await w.ops("soak-plan", { plan: "custom", steps })).status).toBe(202);
    await finish("custom", maxMs);
  };
  const res = (id: string) => r2json<StepResult>(`results/custom/${id}.json`);

  it("churn starts (pgrep does not match its own shell); no lag when the stores never match", async () => {
    await setup();
    const t = { timeoutMs: 90_000 };
    await custom([
      { id: "churn", type: "churn-hold", params: { ms: 5000, sampleMs: 1000, ...t } },
      { id: "compare", type: "creds-compare", params: { settleMs: 5000, ...t } },
    ]);
    const churn = await res("churn");
    expect(churn?.checks.churned).toBe(true);
    expect((churn?.data as { restarts?: number } | undefined)?.restarts ?? 0).toBeGreaterThanOrEqual(1);
    const cmp = await res("compare");
    expect(cmp?.checks.credStoreEqualsDisk).toBe(false); // fake disk has creds.json, the store has none
    expect(cmp?.measures).toEqual([]); // the wait cap is not reported as a lag
  }, 120_000);

  it("reply-counting steps fail at once with no Telegram channel", async () => {
    await setup({ noBot: true });
    await custom([
      { id: "tg", type: "tg-batch", params: { n: 2, kills: 0 } },
      { id: "a", type: "drill-a" },
      { id: "cy", type: "cycles", params: { n: 1 } },
    ]);
    for (const id of ["tg", "a", "cy"]) {
      const r = await res(id);
      expect(r?.checks, id).toEqual({ telegramChannel: false });
    }
  }, 120_000);

  it("a refused force sleep keeps the gate rule in the step data", async () => {
    await setup(); // World default: sleep.mode off → rule 1:mode-off
    await custom([{ id: "cy", type: "cycles", params: { n: 1, timeoutMs: 60 * 60_000 } }]);
    const r = await res("cy");
    expect(r?.checks.sleptEveryCycle).toBe(false);
    const refused = (r?.data as { refused?: Record<string, number> } | undefined)?.refused ?? {};
    expect(Object.keys(refused)).toContain("1:mode-off");
  }, 120_000);

  it("each fill step writes its own file; a step that starts above 80 % expects no new disk-high", async () => {
    await setup();
    const lines: string[] = [];
    const c = w.rt().c;
    const prev = c.execHandler;
    const used = 85;
    c.execHandler = (cmd, opts) => {
      const line = cmd.join(" ");
      lines.push(line);
      if (/df -B1/.test(line)) return { exitCode: 0, stdout: `100000 ${100000 - used * 1000}\n` };
      return prev(cmd, opts);
    };
    await custom([{ id: "d96", type: "disk-fill", params: { pct: 96, waitMs: 5000, timeoutMs: 90_000 } }]);
    expect(lines.some((l) => /soak-fill\/f96\b/.test(l))).toBe(true);
    const r = await res("d96");
    expect(r?.checks).not.toHaveProperty("diskHighAlert");
    expect(r?.checks).toHaveProperty("diskFullAlert");
    expect(r?.data).toMatchObject({ usedBefore: 85 });
  }, 120_000);

  it("s4 R2 bound is growth over the plan; R2 over state is info only", async () => {
    await setup();
    await custom([
      { id: "r2-start", type: "r2-mark" },
      { id: "final", type: "s4-final" },
    ]);
    const r = await res("final");
    expect(r?.checks).toMatchObject({ usageRead: true, r2StartRead: true });
    const g = r?.measures.find((m) => m.item === "s4-r2-growth");
    expect(g).toMatchObject({ unit: "x", max: 1.5 });
    expect(g?.value).toBeCloseTo(1, 1);
    expect(r?.measures.find((m) => m.item === "s4-r2-bytes")?.max).toBeUndefined();
    expect(
      PLANS.find((p) => p.name === "s4-500")
        ?.build({})
        .map((s) => s.type),
    ).toContain("r2-mark");
  }, 120_000);

  it("PITR_WRITE takes phase and count from argv[2] and argv[3]", () => {
    const dir = mkdtempSync(join(tmpdir(), "soak-pitr-"));
    const f = join(dir, "w.mjs");
    writeFileSync(f, PITR_WRITE.replace(JSON.stringify(STATE_DB), JSON.stringify(join(dir, "s.sqlite"))));
    const out = execFileSync(process.execPath, ["--no-warnings", f, "b", "3"], { encoding: "utf8" });
    expect(JSON.parse(out.trim())).toMatchObject({ n: 3 });
  });
});
