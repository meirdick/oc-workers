// M4 archive runner: Control DO cadence answers (fresh/busy/cap) are skips, not failures; poll timing;
// workspace facts in the start manifest (the boot plan ranks empty-workspace archives last, live A A2).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ARCHIVE_CAP_BACKOFF_MS, ARCHIVE_POLL_MS, ARCHIVE_RETRY_MS, Archiver } from "../lib/archive.mjs";
import { GateError } from "../lib/gate.mjs";
import { runOcio } from "../lib/ocio-run.mjs";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "state-fx");
const cli = ["node", path.join(FX, "fake-openclaw.mjs")];
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ocio =
  (env = {}) =>
  (n, a, o = {}) =>
    runOcio(n, a, { ...o, asRoot: true, env: { ...process.env, ...env } });

function gateAnswering(status, body) {
  const calls = [];
  return {
    calls,
    async call(method, route, b) {
      calls.push({ method, route, body: b });
      if (route === "/v1/archive/start" && status) throw new GateError(route, status, JSON.stringify(body));
      if (route === "/v1/archive/start") return { archiveId: "a1" };
      return { ok: true, etag: "e" };
    },
  };
}

describe("M4 archive cadence answers", () => {
  it("a cap answer backs off less than the Control DO stall window (15 min), so a later request is served", () => {
    assert.ok(ARCHIVE_CAP_BACKOFF_MS < 15 * 60_000);
  });
  for (const [status, body, skipped, wait] of [
    [409, { error: "fresh", why: "fresh" }, "fresh", ARCHIVE_POLL_MS],
    [409, { error: "busy", why: "open" }, "busy", ARCHIVE_POLL_MS],
    [429, { error: "archive-cap" }, "cap", ARCHIVE_CAP_BACKOFF_MS],
  ]) {
    it(`${status} ${body.error} → skipped ${skipped}, no CLI run, no abort, next poll after ${wait} ms`, async () => {
      let t = 1_000_000;
      let ran = false;
      const gate = gateAnswering(status, body);
      const a = new Archiver({
        gate,
        varDir: tmp("m4a-"),
        cli,
        now: () => t,
        workspaceFacts: false,
        ocio: async () => {
          ran = true;
          return { code: 0, err: "" };
        },
      });
      const r = await a.run("online", "6h");
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.skipped, skipped);
      assert.equal(ran, false);
      assert.deepEqual(
        gate.calls.map((c) => c.route),
        ["/v1/archive/start"],
      );
      assert.equal(a.due(t + wait - 1), false);
      assert.equal(a.due(t + wait), true);
      t += 1;
    });
  }

  it("a stale/other gate error is a failure: retry after ARCHIVE_RETRY_MS", async () => {
    const a = new Archiver({
      gate: gateAnswering(503, { error: "ctl-unavailable" }),
      varDir: tmp("m4a-"),
      cli,
      now: () => 5_000_000,
      workspaceFacts: false,
      ocio: async () => ({ code: 0, err: "" }),
    });
    const r = await a.run("online", "6h");
    assert.equal(r.ok, false);
    assert.match(r.why, /start: .*503/);
    assert.equal(a.due(5_000_000 + ARCHIVE_RETRY_MS - 1), false);
    assert.equal(a.due(5_000_000 + ARCHIVE_RETRY_MS), true);
  });
});

describe("M4 workspace facts in the start manifest", () => {
  it("attested workspace with files → {attested, entries, missing:0}; missing dir → missing 1", async () => {
    const state = tmp("m4ws-");
    fs.mkdirSync(path.join(state, "state"), { recursive: true });
    const ws = path.join(state, "workspace");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# a\n");
    fs.writeFileSync(path.join(ws, "SOUL.md"), "# s\n");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"));
    db.exec(`CREATE TABLE workspace_setup_state (workspace_key TEXT, workspace_path TEXT, version INTEGER,
      bootstrap_seeded_at INTEGER, setup_completed_at INTEGER, updated_at INTEGER, attested_at_ms INTEGER)`);
    db.prepare("INSERT INTO workspace_setup_state VALUES ('main', ?, 1, 1, 1, 1, 1)").run(ws);
    db.close();
    const run = async () => {
      const gate = gateAnswering(409, { error: "fresh" });
      const a = new Archiver({ gate, varDir: tmp("m4a-"), cli, state, ocio: ocio() });
      await a.run("online", "6h");
      return gate.calls[0].body.manifest;
    };
    assert.deepEqual(await run(), { reason: "6h", workspace: { attested: 1, entries: 2, missing: 0 } });
    fs.rmSync(ws, { recursive: true });
    assert.deepEqual(await run(), { reason: "6h", workspace: { attested: 1, entries: 0, missing: 1 } });
  });

  it("no state DB (fresh install) → no workspace field", async () => {
    const gate = gateAnswering(409, { error: "fresh" });
    const a = new Archiver({ gate, varDir: tmp("m4a-"), cli, state: tmp("m4empty-"), ocio: ocio() });
    await a.run("online", "6h");
    assert.deepEqual(gate.calls[0].body.manifest, { reason: "6h" });
  });
});
