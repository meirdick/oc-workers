// ochost import: the plan (what goes where, what never leaves the laptop) and the command against the fake /ops
// server (uploads, config merge, apply, wait), including a rerun that sends nothing new.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPlan,
  configFromOld,
  cronFromRows,
  dedupeCase,
  excludedWhy,
  type ImportRules,
  mergeDoc,
  parseRules,
  rewritePaths,
  storeKey,
  type WsFile,
} from "../src/import-plan.ts";
import { runProcess } from "../src/ops-lib.ts";
import { FakeOps, installDir, type Req, run } from "./ops-fake.ts";

const OLD_CFG = {
  env: { vars: { GEMINI_API_KEY: "x" } },
  agents: {
    defaults: {
      model: { primary: "cf-workers-ai/kimi" },
      memorySearch: {
        sources: ["memory", "sessions"],
        extraPaths: ["projects"],
        provider: "gemini",
        query: { hybrid: {} },
      },
      compaction: {
        mode: "safeguard",
        memoryFlush: { enabled: true, softThresholdTokens: 40000, prompt: "p" },
      },
      contextPruning: { mode: "cache-ttl", ttl: "6h", keepLastAssistants: 3 },
      imageGenerationModel: { primary: "google/gemini-3-pro-image-preview" },
    },
    list: [
      { id: "main", identity: { name: "Ava", theme: "Owl", emoji: "🦉" } },
      { id: "voice", workspace: "/home/user/clawd" },
    ],
  },
  messages: { ackReactionScope: "group-mentions" },
  channels: { telegram: { botToken: "123:abc" } },
  gateway: { port: 1 },
};

function cronDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE cron_jobs (name TEXT, enabled INTEGER, schedule_kind TEXT, schedule_expr TEXT, schedule_tz TEXT,
    session_target TEXT, payload_kind TEXT, payload_message TEXT, payload_timeout_seconds INTEGER, delivery_mode TEXT,
    delivery_channel TEXT, delivery_to TEXT, agent_id TEXT)`);
  const ins = db.prepare("INSERT INTO cron_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  ins.run(
    "sunday-reflection",
    1,
    "cron",
    "0 14 * * 0",
    null,
    "isolated",
    "agentTurn",
    "Read ~/clawd/memory/ and reflect",
    null,
    "announce",
    "telegram",
    "42",
    null,
  );
  ins.run(
    "weekly-report",
    1,
    "cron",
    "0 14 * * 1",
    null,
    "isolated",
    "agentTurn",
    "cd ~/clawd/projects/app && node app_sync.mjs",
    180,
    "announce",
    "telegram",
    "42",
    "main",
  );
  ins.run(
    "app-daily-sync",
    1,
    "cron",
    "0 7 * * *",
    null,
    "isolated",
    "agentTurn",
    "sync",
    120,
    "none",
    null,
    null,
    "main",
  );
  db.close();
}

/** Owner rules like a real migration has them (--rules); none of this is in the code. */
const RULES: ImportRules = {
  source: "OpenClaw 2026.7 on a VM",
  vaults: ["projects/app/vault"],
  store: [{ from: "projects/app/records", to: "records/app", about: "records of the app" }],
  parkedSkills: ["voice-skill"],
  cronSkip: [{ name: "app-daily-sync", why: "moves to the app Worker" }],
  cronOff: [{ match: "app_sync|projects/app/", why: "needs the app Worker; turn on after it is live" }],
  notes: ["Not here: the app and its vault (moves to a separate Worker)."],
};

/** A small seed: home/ (state dir) and clawd/ (workspace), with the things that must never leave. */
function seed(): string {
  const s = mkdtempSync(join(tmpdir(), "ochost-seed-"));
  const w = (rel: string, data: string) => {
    mkdirSync(join(s, rel, ".."), { recursive: true });
    writeFileSync(join(s, rel), data);
  };
  w("home/openclaw.json", JSON.stringify(OLD_CFG));
  w("home/agents/main/sessions/a1.jsonl", '{"type":"message"}\n{"type":"message"}\n');
  w("home/agents/main/sessions/.a2.jsonl.tmp", "partial");
  w("home/agents/voice/sessions/v1.jsonl", "{}\n{}\n");
  mkdirSync(join(s, "home/state"), { recursive: true });
  cronDb(join(s, "home/state/openclaw.sqlite"));
  w("clawd/AGENTS.md", "agents");
  w("clawd/SOUL.md", "soul");
  w("clawd/memory/2026-01-31.md", "See ~/clawd/projects/app/README.md and /home/user/clawd for more.");
  w("clawd/config/app.env", "APP_SECRET=x");
  w("clawd/projects/app/vault/key", "k");
  w("clawd/projects/app/server.mjs", "// app");
  w("clawd/projects/app/records/2024/Report 2024 (final).pdf", "pdf");
  w("clawd/projects/app/records/2024/Report 2024 [final].pdf", "pdf2");
  w("clawd/skills/voice-skill/SKILL.md", "parked");
  w("clawd/skills/todo/SKILL.md", "todo");
  w("clawd/notes/leak.md", `token AIza${"a".repeat(35)}`);
  w("clawd/.git/HEAD", "ref");
  w("clawd/node_modules/x/index.js", "x");
  w("clawd/openclaw-workspace-state.json", "{}");
  return s;
}

describe("import plan", () => {
  const s = seed();
  const p = buildPlan({ seed: s }, new Date("2026-11-09T00:00:00Z"), RULES);
  const ws = p.workspace.map((x) => x.rel).sort();

  it("workspace: notes, memory and kept skills; no credentials, vault, records, parked skills, git or modules", () => {
    expect(ws).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "memory/2026-01-31.md",
      "projects/app/server.mjs",
      "skills/todo/SKILL.md",
    ]);
    expect(p.excluded.map((e) => [e.rel, e.why]).sort()).toEqual([
      ["config/app.env", "credential"],
      ["notes/leak.md", "looks like it holds a key"],
      ["openclaw-workspace-state.json", "old install state"],
      ["projects/app/vault/key", "vault"],
    ]);
    expect(p.workspace.find((x) => x.rel === "memory/2026-01-31.md")?.rewritten).toBe(true);
    expect(p.overwrite).toEqual(["AGENTS.md", "SOUL.md"]);
    expect(p.remove).toEqual(["BOOTSTRAP.md"]);
  });

  it("files: records with key-safe names (collisions get -2), transcripts per agent, parked skills; temp files skipped", () => {
    const keys = p.files.map((f) => `${f.group} ${f.key}`).sort();
    expect(keys).toEqual([
      "records records/app/2024/Report_2024_final_-2.pdf",
      "records records/app/2024/Report_2024_final_.pdf",
      "skills history/skills/voice-skill/SKILL.md",
      "transcripts history/sessions/main/a1.jsonl",
      "transcripts history/sessions/voice/v1.jsonl",
    ]);
    expect(p.files.find((f) => f.key.endsWith("final_.pdf"))?.original).toBe("2024/Report 2024 (final).pdf");
  });

  it("cron: a cronSkip job moves out; cronOff jobs come over off; paths rewritten; UTC when the old tz was empty", () => {
    expect(p.cronSkipped).toEqual([{ name: "app-daily-sync", why: "moves to the app Worker" }]);
    const [a, b] = [
      p.cron.find((j) => j.name === "sunday-reflection"),
      p.cron.find((j) => j.name === "weekly-report"),
    ];
    expect(a).toMatchObject({
      key: "import:sunday-reflection",
      enabled: true,
      tz: "UTC",
      message: "Read memory/ and reflect",
      announce: { channel: "telegram", to: "42" },
    });
    expect(b).toMatchObject({
      enabled: false,
      agent: "main",
      timeoutSeconds: 180,
      message: "cd projects/app && node app_sync.mjs",
    });
    expect(b?.description).toBe("Imported off: needs the app Worker; turn on after it is live");
  });

  it("config: only 2026.10.9 keys that are not oc-host's; the rest is listed with a reason", () => {
    expect(p.config.set).toEqual({
      agents: {
        entries: { main: { identity: { name: "Ava", theme: "Owl", emoji: "🦉" } } },
        defaults: {
          compaction: { mode: "safeguard", memoryFlush: { enabled: true, softThresholdTokens: 40000 } },
          contextPruning: { mode: "cache-ttl", ttl: "6h" },
        },
      },
      memory: { search: { sources: ["memory", "sessions"], extraPaths: ["projects"] } },
      messages: { ackReactionScope: "group-mentions" },
    });
    const dropped = p.config.dropped.map((d) => d.path);
    for (const k of [
      "env",
      "channels",
      "gateway",
      "agents.defaults.memorySearch.provider",
      "agents.defaults.imageGenerationModel",
    ])
      expect(dropped).toContain(k);
    expect(JSON.stringify(p.config.set)).not.toMatch(/GEMINI|123:abc|gemini/);
  });

  it("the note tells the agent where the history went", () => {
    expect(p.note.rel).toBe("memory/imported-history.md");
    expect(p.note.text).toMatch(/history\/sessions\/<agent>\/`: 2 raw transcript files/);
    expect(p.note.text).toMatch(/app-daily-sync: not re-created/);
    expect(p.note.text).toMatch(/`records\/app\/`: 2 files, records of the app/);
    expect(p.note.text).toMatch(/weekly-report \(0 14 \* \* 1 UTC\), off: needs the app Worker/);
    expect(p.note.text).toMatch(/OpenClaw 2026\.7 on a VM/);
    expect(p.note.text).toMatch(/Not here: the app and its vault/);
  });

  it("without rules: generic safety only; no vault, store, parked skill or cron rule", () => {
    const q = buildPlan({ seed: s }, new Date("2026-11-09T00:00:00Z"));
    const ex = q.excluded.map((e) => e.rel).sort();
    expect(ex).toEqual(["config/app.env", "notes/leak.md", "openclaw-workspace-state.json"]);
    expect(q.workspace.map((x) => x.rel)).toContain("projects/app/vault/key");
    expect(q.workspace.map((x) => x.rel)).toContain("skills/voice-skill/SKILL.md");
    expect(q.files.filter((f) => f.group === "records")).toEqual([]);
    expect(q.cronSkipped).toEqual([]);
    expect(q.cron.every((j) => j.enabled)).toBe(true);
    expect(q.note.text).not.toMatch(/records\//);
  });

  it("rules file: fields are checked, trailing slashes dropped", () => {
    expect(parseRules({ vaults: ["projects/app/vault/"] }).vaults).toEqual(["projects/app/vault"]);
    expect(parseRules({})).toEqual({});
    expect(() => parseRules([])).toThrow(/JSON object/);
    expect(() => parseRules({ vault: [] })).toThrow(/vault must be one of/);
    expect(() => parseRules({ vaults: ["../x"] })).toThrow(/relative paths/);
    expect(() => parseRules({ vaults: ["/abs"] })).toThrow(/relative paths/);
    expect(() => parseRules({ store: [{ from: "a", to: "a b" }] })).toThrow(/store\[0\]\.to/);
    expect(() => parseRules({ cronOff: [{ match: "(", why: "x" }] })).toThrow(/cronOff\[0\]\.match/);
    expect(() => parseRules({ cronSkip: [{ name: "x" }] })).toThrow(/cronSkip/);
    expect(() => parseRules({ olderSessions: { prefix: "a//b" } })).toThrow(/olderSessions\.prefix/);
  });

  it("case-only twins get -2 so openclaw backup create --verify accepts the workspace", () => {
    const f: WsFile[] = [
      { rel: "reports/report.csv", src: "a", bytes: 1 },
      { rel: "reports/REPORT.csv", src: "b", bytes: 1 },
      { rel: "reports/Report-2.csv", src: "c", bytes: 1 },
      { rel: "README", src: "d", bytes: 1 },
      { rel: "readme", src: "e", bytes: 1 },
    ];
    dedupeCase(f);
    expect(f.map((x) => x.rel)).toEqual([
      "reports/report-3.csv",
      "reports/REPORT.csv",
      "reports/Report-2.csv",
      "README",
      "readme-2",
    ]);
    expect(f[0]?.renamedFrom).toBe("reports/report.csv");
    expect(new Set(f.map((x) => x.rel.toLowerCase())).size).toBe(5);
  });

  it("helpers", () => {
    expect(rewritePaths("cd ~/clawd && ls /home/bob/clawd/x")).toBe("cd . && ls x");
    expect(excludedWhy("a/.env.local")).toBe("credential");
    expect(excludedWhy("a/notes.md")).toBeNull();
    expect(excludedWhy("projects/app/vault", ["projects/app/vault"])).toBe("vault");
    expect(excludedWhy("projects/app/vault2/x", ["projects/app/vault"])).toBeNull();
    const used = new Set<string>();
    expect(storeKey("m", "Été/a b.pdf", used)).toBe("m/Ete/a_b.pdf");
    expect(storeKey("m", ".hidden", used)).toBe("m/_hidden");
    expect(mergeDoc({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2], e: 3 } })).toEqual({
      a: { b: 1, c: [2], e: 3 },
      d: 1,
    });
    expect(cronFromRows([]).jobs).toEqual([]);
    expect(configFromOld({}).set).toEqual({});
  });
});

describe("ochost import against the fake /ops", () => {
  let f: FakeOps;
  const store = new Map<string, string>();
  let bundle: { id: string; bytes: number } | null = null;
  let applied: any = null;
  let configPosts = 0;
  let sandboxCalls = 0;
  beforeAll(async () => {
    f = await new FakeOps().start();
    f.routes.push((r: Req) => {
      const u = new URL(r.path, "http://x");
      const q = Object.fromEntries(u.searchParams);
      if (r.method === "GET" && u.pathname === "/ops/import/files") {
        const objects = [...store]
          .filter(([k]) => k.startsWith(q.prefix ?? ""))
          .map(([key, v]) => ({
            key,
            size: v.length,
            sha256: createHash("sha256").update(v).digest("hex"),
          }));
        return { status: 200, body: { objects, truncated: false, cursor: null } };
      }
      if (r.method === "PUT" && u.pathname === "/ops/import/file") {
        // The fake parses JSON bodies; INDEX.json comes back to its exact bytes (indent 1, same key order).
        const data = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 1);
        if (createHash("sha256").update(data).digest("hex") !== q.sha256)
          return { status: 400, body: { error: "sha" } };
        store.set(q.key as string, data);
        return { status: 200, body: { ok: true, key: q.key, bytes: data.length } };
      }
      if (r.method === "PUT" && u.pathname === "/ops/import/bundle") {
        bundle = { id: q.id as string, bytes: 0 };
        return { status: 200, body: { ok: true } };
      }
      if (r.method === "GET" && u.pathname === "/ops/config")
        return { status: 200, body: { versions: [{ ver: 1 }] } };
      if (r.method === "GET" && u.pathname === "/ops/config/1")
        return {
          status: 200,
          body: { ver: 1, doc: { memory: { search: { provider: "openai-compatible" } } } },
        };
      if (r.method === "POST" && u.pathname === "/ops/config") {
        configPosts++;
        expect(r.body.doc.memory.search).toMatchObject({
          provider: "openai-compatible",
          extraPaths: ["projects"],
        });
        return { status: 200, body: { ok: true, ver: 2 } };
      }
      if (r.method === "POST" && u.pathname === "/ops/import/apply") {
        applied = r.body;
        return { status: 202, body: { ok: true, request: { id: r.body.id, state: "pending" } } };
      }
      if (r.method === "POST" && u.pathname === "/ops/import/sandbox") {
        sandboxCalls++;
        return {
          status: 200,
          body: { ok: true, targets: [{ root: "/workspace/x/workspace", added: 5, replaced: 2, kept: 0 }] },
        };
      }
      if (r.method === "GET" && u.pathname === "/ops/import")
        return {
          status: 200,
          body: {
            request: {
              id: applied?.id,
              state: "done",
              result: {
                workspace: { added: 5, same: 0, replaced: 2, kept: 0, removed: 1 },
                cron: [{ name: "a", ok: true }],
              },
            },
          },
        };
      return undefined;
    });
  });
  afterAll(() => f.stop());

  it("dry run changes nothing; a run uploads, merges config, applies and waits; a rerun sends no file again", async () => {
    const s = seed();
    const dir = installDir(f.url);
    const rules = join(mkdtempSync(join(tmpdir(), "ochost-rules-")), "rules.json");
    writeFileSync(rules, JSON.stringify(RULES));
    const dry = await run("import", [s, "--dir", dir, "--rules", rules, "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out).summary.store).toMatch(/^2 files, .* → f\/<inst>\/records\/$/);
    expect(f.reqs.filter((r) => r.path.startsWith("/ops/import"))).toEqual([]);

    const r = await run("import", [s, "--dir", dir, "--rules", rules, "--yes", "--json"], {
      run: runProcess,
    });
    expect(r.code, r.err).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.files).toMatchObject({ sent: 6, skipped: 0 }); // 5 planned + history/INDEX.json
    expect(doc.workspace).toMatchObject({ ok: true });
    expect(applied).toMatchObject({ overwrite: ["AGENTS.md", "SOUL.md"], remove: ["BOOTSTRAP.md"] });
    expect(applied.id).toMatch(/^seed-[0-9a-f]{12}$/);
    expect(bundle?.id).toBe(applied.id);
    expect(applied.cron.map((j: { name: string }) => j.name).sort()).toEqual([
      "sunday-reflection",
      "weekly-report",
    ]);
    expect(configPosts).toBe(1);
    expect(sandboxCalls).toBe(1);
    expect(doc.workspace.sandbox).toMatchObject({ ok: true });
    expect(JSON.parse(store.get("history/INDEX.json") as string)).toMatchObject({
      "records/app/2024/Report_2024_final_.pdf": "records:2024/Report 2024 (final).pdf",
    });
    expect([...store.keys()].some((k) => /vault|\.env/.test(k))).toBe(false);

    const firstId = applied.id;
    const again = await run(
      "import",
      [s, "--dir", dir, "--rules", rules, "--yes", "--json", "--only", "files,workspace"],
      {
        run: runProcess,
      },
    );
    expect(again.code, again.err).toBe(0);
    expect(JSON.parse(again.out).files).toMatchObject({ sent: 0, skipped: 6 });
    expect(applied.id).toBe(firstId); // same bundle bytes → same id
  });

  it("a bad rules file is a usage error", async () => {
    const bad = join(mkdtempSync(join(tmpdir(), "ochost-rules-")), "rules.json");
    writeFileSync(bad, JSON.stringify({ vaults: "x" }));
    const r = await run("import", [seed(), "--dir", installDir(f.url), "--rules", bad, "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/rules: vaults/);
  });

  it("without --yes a non-interactive run refuses", async () => {
    const r = await run("import", [seed(), "--dir", installDir(f.url)]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/pass --yes/);
  });
});
