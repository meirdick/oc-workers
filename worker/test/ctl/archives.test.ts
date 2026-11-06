// M4 archives: cadence (fresh/dirty/age), owner and pre-upgrade requests, sleep hold, A6 key, archive plan boot
// (A2, F3, F10), archive GC (create-before-delete, last verified copy kept), gen GC invariants, read-back verify,
// restore drill into a throw-away DO, /ops/archive.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  archiveDirty,
  archiveSleepBlockers,
  drillDue,
  ensurePreBootArchive,
  planArchiveGc,
  preBootSince,
  requestArchive,
  runArchiveGc,
  runDrill,
  verifyNewest,
} from "../../src/ctl/archives";
import { DAY } from "../../src/ctl/ctx";
import { drillRestoreInto, TarReader } from "../../src/ctl/drill";
import { planGc } from "../../src/ctl/gc";
import { Db } from "../../src/ctl/sql";
import { ARCHIVE_DEFAULTS, archiveDue, dayCap } from "../../src/gates/archive-policy";
import { FakeStorage } from "../harness/storage";
import { bootComplete, T0, type World, world } from "./world";

const DB = "state/openclaw.sqlite";
const MIN = 60_000;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---- tar.gz builder (ustar) ----
function hdr(name: string, size: number, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write("0000644\0", 100);
  h.write("0001750\0", 108);
  h.write("0001750\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
export function tgz(files: { path: string; data?: Uint8Array; dir?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const f of files) {
    if (f.dir) {
      parts.push(hdr(f.path, 0, "5"));
      continue;
    }
    const d = Buffer.from(f.data ?? new Uint8Array(0));
    if (f.path.length > 100) {
      const nm = Buffer.from(`${f.path}\0`);
      parts.push(hdr("././@LongLink", nm.length, "L"), nm, Buffer.alloc((512 - (nm.length % 512)) % 512));
    }
    parts.push(hdr(f.path, d.length), d, Buffer.alloc((512 - (d.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}
function sqliteBytes(rows = 3): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "m4-arch-"));
  try {
    const db = new DatabaseSync(join(dir, "x.sqlite"));
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < rows; i++) db.prepare("INSERT INTO t (v) VALUES (?)").run(`row ${i}`);
    db.close();
    return new Uint8Array(readFileSync(join(dir, "x.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ROOT = "20261101T100000Z-openclaw-backup/payload/posix/home/node/.openclaw";
function goodArchive(): Uint8Array {
  return tgz([
    { path: "20261101T100000Z-openclaw-backup/manifest.json", data: Buffer.from('{"v":1}') },
    { path: `${ROOT}/workspace`, dir: true },
    { path: `${ROOT}/workspace/AGENTS.md`, data: Buffer.from("# agent\n") },
    { path: `${ROOT}/workspace/memory/2026-11-01.md`, data: Buffer.from("note\n") },
    { path: `${ROOT}/state/openclaw.sqlite`, data: sqliteBytes() },
  ]);
}

/** Archive through the ledger as the gate would; the bytes land in fake R2. */
async function mkArchive(
  w: World,
  gen: number,
  o: { bytes?: Uint8Array; reason?: string; ws?: { entries: number; missing: number } } = {},
) {
  const s = w.ledger.archiveStart(gen, "online", {
    reason: o.reason ?? "ctl",
    ...(o.ws ? { workspace: o.ws } : {}),
  });
  if (!s.ok) throw new Error(`start ${s.error} ${s.why ?? ""}`);
  const bytes = o.bytes ?? goodArchive();
  await w.r2.put(s.key, bytes);
  w.ledger.archiveFinish(s.archiveId, true, { sha256: sha(bytes), size: bytes.length, parts: 1 });
  return { id: s.archiveId, key: s.key, bytes };
}
function upload(w: World, gen: number, txid: number) {
  const key = `r/${w.ctx.inst}/g${gen}/${DB}/0000/${txid.toString(16).padStart(16, "0")}-${txid.toString(16).padStart(16, "0")}.ltx`;
  w.ledger.recordUpload({ key, bytes: 100 });
}
async function booted(o: { settings?: Record<string, unknown>; digest?: string } = {}) {
  const w = world(o.settings ? { settings: o.settings as never } : {});
  w.install(o.digest);
  const b = await bootComplete(w);
  return { w, gen: b.gen };
}
const target = (w: World) => (name: string) => ({
  drillRestore: async (a: Parameters<typeof drillRestoreInto>[2]) => {
    expect(name.startsWith(`drill:${w.ctx.inst}:`)).toBe(true);
    const st = new FakeStorage();
    return drillRestoreInto(new Db(st as never), w.r2 as never, a, () => w.clock.t);
  },
});

describe("M4 archive cadence (ControlGate start)", () => {
  it("no archive → due; then fresh; dirty after minGap; age after 6 h; A6 key has the gen digest", async () => {
    const { w, gen } = await booted({ digest: `sha256:${"ab12".repeat(16)}` });
    const s1 = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    expect(s1.key).toMatch(/^a\/t1\/\d{8}T\d{6}Z-oc-ab12ab12ab12\.tar\.gz$/);
    expect(s1.key).not.toContain("000000000000");
    w.ledger.archiveFinish(s1.archiveId, true, { sha256: "a".repeat(64), size: 1, parts: 1 });
    w.advance(MIN);
    const f = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    expect(f).toMatchObject({ ok: false, error: "fresh", why: "fresh" });
    upload(w, gen, 9); // state changed after the archive
    w.advance(MIN);
    expect(w.ledger.archiveStart(gen, "online", { reason: "6h" })).toMatchObject({ ok: false, why: "gap" });
    w.advance(ARCHIVE_DEFAULTS.minGapMs);
    const s2 = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    w.ledger.archiveFinish(s2.archiveId, true, { sha256: "b".repeat(64), size: 1, parts: 1 });
    w.advance(ARCHIVE_DEFAULTS.everyMs);
    const s3 = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    expect(s3.ok).toBe(true);
    expect(
      w.db.one<{ reason: string }>("SELECT reason FROM archives WHERE id = ?", s2.archiveId)?.reason,
    ).toBe("6h");
  });

  it("owner/pre-upgrade reasons skip the cadence; busy while one is open or the Runtime DO quiesces", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    expect(w.ledger.archiveStart(gen, "online", { reason: "6h" })).toMatchObject({ error: "fresh" });
    const p = w.ledger.archiveStart(gen, "offline", { reason: "pre-upgrade" });
    expect(p.ok).toBe(true);
    expect(w.ledger.archiveStart(gen, "online", { reason: "owner" })).toMatchObject({
      error: "busy",
      why: "open",
    });
    if (p.ok) w.ledger.archiveFinish(p.archiveId, false, { why: "test" });
    w.db.setMeta("rtState", "quiescing");
    expect(w.ledger.archiveStart(gen, "online", { reason: "owner" })).toMatchObject({ error: "busy" });
  });

  it("an open row of an older gen is aborted at the next start; its upload is returned for abort", async () => {
    const { w, gen } = await booted();
    const s = w.ledger.archiveStart(gen, "online", { reason: "owner" });
    if (!s.ok) throw new Error("start");
    w.ledger.archiveOpened(s.archiveId, "up-1", s.key);
    const b = await bootComplete(w);
    const s2 = w.ledger.archiveStart(b.gen, "online", { reason: "owner" });
    expect(s2.ok).toBe(true);
    expect(s2.abortUploads).toEqual([{ key: s.key, uploadId: "up-1" }]);
    expect(w.db.one<{ state: string }>("SELECT state FROM archives WHERE id = ?", s.archiveId)?.state).toBe(
      "aborted",
    );
  });

  it("request: the next poll of any reason serves it; done on complete, pending again on a failure", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    const r = requestArchive(w.ctx, "pre-upgrade");
    const a = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.reason).toBe("pre-upgrade");
    w.ledger.archiveFinish(a.archiveId, false, { why: "part" });
    expect(w.db.metaJson<{ state: string }>("archiveRequest", { state: "" }).state).toBe("pending");
    const b = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    if (!b.ok) throw new Error("start b");
    w.ledger.archiveFinish(b.archiveId, true, { sha256: "c".repeat(64), size: 1, parts: 1 });
    expect(w.db.metaJson("archiveRequest", null)).toMatchObject({
      id: r.id,
      state: "done",
      archiveId: b.archiveId,
    });
  });
});

describe("archive request day cap and stall (oc-demo 2026-11-05)", () => {
  const today = (w: World) => new Date(w.clock.t).toISOString().slice(0, 10);
  const setStarted = (w: World, n: number) =>
    w.db.run(
      "INSERT INTO budget_day (day, archives) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET archives = excluded.archives",
      today(w),
      n,
    );
  const req = (w: World) => w.db.metaJson<Record<string, unknown> | null>("archiveRequest", null);
  const held = async (w: World) =>
    (await w.api.sleepInputs()).blockers.filter((b) => b.startsWith("archive-requested"));

  it("the cadence used the whole day cap: a pre-upgrade request still starts (forced extra)", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    w.advance(ARCHIVE_DEFAULTS.everyMs);
    setStarted(w, dayCap(ARCHIVE_DEFAULTS, false)); // live: 24 cadence starts by 19:52 UTC
    expect(w.ledger.archiveStart(gen, "online", { reason: "6h" })).toMatchObject({ ok: false, error: "cap" });
    requestArchive(w.ctx, "pre-upgrade");
    const s = w.ledger.archiveStart(gen, "online", { reason: "6h" }); // ocsup's next poll
    expect(s).toMatchObject({ ok: true, reason: "pre-upgrade" });
    if (!s.ok) return;
    w.ledger.archiveFinish(s.archiveId, true, { sha256: "d".repeat(64), size: 1, parts: 1 });
    expect(req(w)).toMatchObject({ state: "done", archiveId: s.archiveId, step: "complete" });
  });

  it("no progress for 15 min → failed with the last step, archive-stalled alert, sleep hold cleared", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    setStarted(w, dayCap(ARCHIVE_DEFAULTS, true));
    const r = requestArchive(w.ctx, "pre-upgrade");
    expect(await held(w)).toEqual([]); // no start left today: waiting only blocks the sleep
    setStarted(w, dayCap(ARCHIVE_DEFAULTS, true) - 1);
    expect(await held(w)).toEqual(["archive-requested:pre-upgrade"]);
    setStarted(w, dayCap(ARCHIVE_DEFAULTS, true));
    expect(w.ledger.archiveStart(gen, "online", { reason: "6h" })).toMatchObject({ error: "cap" });
    expect(req(w)).toMatchObject({ state: "pending", step: "start refused: cap 32/32 today" });
    w.advance(ARCHIVE_DEFAULTS.stallMs - 1);
    setStarted(w, 0);
    expect(await held(w)).toEqual(["archive-requested:pre-upgrade"]); // a refusal is not progress
    w.advance(1);
    expect(await held(w)).toEqual([]);
    expect(req(w)).toMatchObject({
      id: r.id,
      state: "failed",
      why: "stalled: start refused: cap 32/32 today",
    });
    const al = w.db.one<{ last_detail: string }>(
      "SELECT last_detail FROM alerts WHERE class = 'archive-stalled'",
    );
    expect(al?.last_detail).toContain("last step: start refused: cap 32/32 today");
    expect(w.db.one("SELECT id FROM ring WHERE src = 'archive' AND kind = 'stalled'")).toBeTruthy();
    // a new request starts a new attempt
    expect(requestArchive(w.ctx, "pre-upgrade")).toMatchObject({ state: "pending", step: "requested" });
  });

  it("parts are progress; a request with no ocsup start names that; a late complete still marks it done", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    requestArchive(w.ctx, "owner");
    w.advance(ARCHIVE_DEFAULTS.stallMs - MIN);
    const s = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    if (!s.ok) throw new Error("start");
    w.advance(10 * MIN);
    w.ledger.archiveOpened(s.archiveId, "up-1", s.key);
    w.ledger.archivePartDone(s.archiveId, 1, "{}", "e1", 10);
    w.advance(10 * MIN);
    expect(await w.api.sleepInputs()).toBeTruthy();
    expect(req(w)).toMatchObject({ state: "running", step: "part 1" });
    w.advance(5 * MIN);
    await w.api.sleepInputs();
    expect(req(w)).toMatchObject({ state: "failed", why: "stalled: part 1" });
    w.ledger.archiveFinish(s.archiveId, true, { sha256: "e".repeat(64), size: 10, parts: 1 });
    expect(req(w)).toMatchObject({ state: "done", why: null });

    // No poll at all after the request (ocsup down or old image): the step says so.
    const r2 = requestArchive(w.ctx, "owner");
    w.advance(ARCHIVE_DEFAULTS.stallMs);
    const st = await w.api.ops({
      action: "archive",
      method: "GET",
      sub: [],
      query: {},
      body: {},
      role: "owner",
    });
    expect((st.body as { request: Record<string, unknown> }).request).toMatchObject({
      id: r2.id,
      state: "failed",
      why: "stalled: requested, no start from ocsup",
    });
  });
});

describe("M4 sleep hold (rule 1 blockers)", () => {
  it("archive-open of this gen holds the sleep up to openHoldMs", async () => {
    const { w, gen } = await booted();
    const s = w.ledger.archiveStart(gen, "online", { reason: "owner" });
    expect(s.ok).toBe(true);
    expect((await w.api.sleepInputs()).blockers.some((b) => b.startsWith("archive-open:"))).toBe(true);
    w.advance(ARCHIVE_DEFAULTS.openHoldMs + 1);
    expect((await w.api.sleepInputs()).blockers.some((b) => b.startsWith("archive-open"))).toBe(false);
  });

  it("archive-due holds from the due point until ocsup tries a start, capped at dueHoldMs; no hold before a poll", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    w.advance(ARCHIVE_DEFAULTS.minGapMs + MIN);
    upload(w, gen, 20);
    // This gen polled before (the mkArchive start) → the due hold applies.
    expect(archiveSleepBlockers(w.ctx)).toEqual(["archive-due:dirty"]);
    // ocsup polls → archive starts → archive-open replaces archive-due
    const s = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    expect(s.ok).toBe(true);
    expect(archiveSleepBlockers(w.ctx)[0]).toMatch(/^archive-open:/);
    if (s.ok) w.ledger.archiveFinish(s.archiveId, false, { why: "test" });
    // still due, but the attempt is newer than the due point → no hold
    expect(archiveSleepBlockers(w.ctx)).toEqual([]);
    w.advance(1000);
    upload(w, gen, 21);
    expect(archiveSleepBlockers(w.ctx)).toEqual(["archive-due:dirty"]);
    w.advance(ARCHIVE_DEFAULTS.dueHoldMs + 1);
    expect(archiveSleepBlockers(w.ctx)).toEqual([]);
  });

  it("no due hold when this gen's ocsup never polled (old image); request holds; canary never holds", async () => {
    const { w, gen } = await booted();
    upload(w, gen, 30);
    expect(archiveSleepBlockers(w.ctx)).toEqual([]);
    requestArchive(w.ctx, "owner");
    expect(archiveSleepBlockers(w.ctx)).toEqual(["archive-requested:owner"]);
    w.db.run("UPDATE gens SET mode = 'canary' WHERE gen = ?", gen);
    expect(archiveSleepBlockers(w.ctx)).toEqual([]);
  });
});

describe("M4 archive plan boot (A2, F3, F10)", () => {
  it("A2: image + newest archive + newest gen; workspace from the archive", async () => {
    const { w, gen } = await booted();
    const a = await mkArchive(w, gen, { ws: { entries: 2, missing: 0 } });
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "l4", reason: "user", ladder: 4 });
    expect(b.plan.rootfs.kind).toBe("image");
    expect(b.plan.archive).toMatchObject({ archiveId: a.id, sha256: sha(a.bytes), size: a.bytes.length });
    expect(b.plan.sqlite).toMatchObject({ kind: "gen", gen });
    expect(b.plan.workspace).toEqual({ source: "archive" });
  });

  it("A2: an archive taken with an empty or missing workspace ranks below an older good one", async () => {
    const { w, gen } = await booted();
    const good = await mkArchive(w, gen, { ws: { entries: 3, missing: 0 } });
    w.advance(MIN);
    await mkArchive(w, gen, { ws: { entries: 0, missing: 1 } });
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "l4b", reason: "user", ladder: 4 });
    expect(b.plan.archive?.archiveId).toBe(good.id);
  });

  it("F3: replan cap (noSnapshot) ends in the archive plan when one exists, else restore-blocked", async () => {
    const { w, gen } = await booted();
    const none = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "f3a",
      reason: "wake:ui",
      noSnapshot: true,
      missed: ["s1", "s2", "s3"],
    });
    expect(none.plan.sqlite).toMatchObject({ kind: "restore-blocked" });
    const a = await mkArchive(w, gen);
    const b = await w.api.beginBoot({
      epoch: 1,
      mode: "prod",
      opId: "f3b",
      reason: "wake:ui",
      noSnapshot: true,
      missed: ["s1", "s2", "s3"],
    });
    expect(b.plan.rootfs.kind).toBe("image");
    expect(b.plan.archive?.archiveId).toBe(a.id);
    expect(b.plan.sqlite).toMatchObject({ kind: "gen" });
    expect(b.plan.workspace?.source).toBe("archive");
  });

  it("F10: image change (no same-digest snapshot) with an archive → image path, workspace from the archive", async () => {
    const { w, gen } = await booted();
    w.db.run(
      `INSERT INTO snapshots (id, image_key, digest, kind, gen, epoch, created_at, state) VALUES ('s-old', 'oc', 'sha256:img1', 'sleep', ?, 1, ?, 'ok')`,
      gen,
      w.clock.t,
    );
    const a = await mkArchive(w, gen);
    // new image digest on the active epoch (cutover stand-in)
    w.db.run("UPDATE epochs SET digest = 'sha256:img2' WHERE n = 1");
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "f10", reason: "user" });
    expect(b.plan.rootfs).toMatchObject({ kind: "image", digest: "sha256:img2" });
    expect(b.plan.archive?.archiveId).toBe(a.id);
    expect(b.plan.workspace?.source).toBe("archive");
    expect(b.plan.runDoctor).toBe(true);
  });

  it("a bad archive (verify failed) is never planned", async () => {
    const { w, gen } = await booted();
    const a = await mkArchive(w, gen);
    w.ledger.archiveVerify(a.id, false, "restore", "sha");
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "bad", reason: "user", ladder: 4 });
    expect(b.plan.archive).toBeNull();
    expect(b.plan.workspace?.source).toBe("none");
  });
});

describe("M4 archive GC (create-before-delete, last verified copy)", () => {
  it("nothing is deleted without a newer verified copy; after a verify, old ones outside the keep rules go", async () => {
    const { w, gen } = await booted();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push((await mkArchive(w, gen, { reason: "owner" })).id);
      w.advance((30 * DAY) / 12);
    }
    w.advance(20 * DAY);
    expect(planArchiveGc(w.ctx).delete).toEqual([]);
    const v = await verifyNewest(w.ctx, w.ledger);
    expect(v).toMatchObject({ id: ids[11], ok: true });
    const p = planArchiveGc(w.ctx);
    expect(p.newestVerified).toBe(ids[11]);
    expect(p.delete.length).toBeGreaterThan(0);
    expect(p.delete).not.toContain(ids[11]);
    const r = await runArchiveGc(w.ctx);
    expect(r.ok).toBe(true);
    for (const id of r.deleted) {
      const row = w.db.one<{ key: string; state: string }>(
        "SELECT key, state FROM archives WHERE id = ?",
        id,
      );
      expect(row?.state).toBe("deleted");
      expect(await w.r2.head(row?.key as string)).toBeNull();
    }
    const left = w.db
      .all<{ id: string }>("SELECT id FROM archives WHERE state = 'complete'")
      .map((x) => x.id);
    expect(left).toContain(ids[11]);
    expect(left.length).toBeGreaterThanOrEqual(8);
  });

  it("property: over random index states GC never deletes the newest verified archive or anything newer", async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 40; round++) {
      const w = world();
      w.install();
      const n = 1 + Math.floor(rnd() * 25);
      for (let i = 0; i < n; i++) {
        const verified = rnd() < 0.2 ? w.clock.t : null;
        w.db.run(
          `INSERT INTO archives (id, key, kind, state, sha256, size, created_at, verified_at, reason)
           VALUES (?, ?, 'online', ?, 'x', 1, ?, ?, ?)`,
          `a${i}`,
          `a/t1/${i}.tar.gz`,
          rnd() < 0.1 ? "bad" : "complete",
          w.clock.t,
          verified,
          rnd() < 0.1 ? "pre-upgrade" : "6h",
        );
        w.advance(Math.floor(rnd() * 3 * DAY));
      }
      const p = planArchiveGc(w.ctx);
      const nv = w.db.one<{ id: string; created_at: number }>(
        "SELECT id, created_at FROM archives WHERE state = 'complete' AND verified_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
      );
      if (!nv) {
        const completeDel = p.delete.filter(
          (id) =>
            w.db.one<{ state: string }>("SELECT state FROM archives WHERE id = ?", id)?.state === "complete",
        );
        expect(completeDel).toEqual([]);
        continue;
      }
      expect(p.delete).not.toContain(nv.id);
      for (const id of p.delete) {
        const r = w.db.one<{ created_at: number; state: string }>(
          "SELECT created_at, state FROM archives WHERE id = ?",
          id,
        );
        if (r?.state === "complete") expect(r.created_at).toBeLessThan(nv.created_at);
      }
    }
  });

  it("open multipart uploads older than 24 h are aborted; their rows end aborted", async () => {
    const { w, gen } = await booted();
    const s = w.ledger.archiveStart(gen, "online", { reason: "owner" });
    if (!s.ok) throw new Error("start");
    const up = await (
      w.r2 as unknown as { createMultipartUpload(k: string): Promise<{ uploadId: string }> }
    ).createMultipartUpload(s.key);
    w.ledger.archiveOpened(s.archiveId, up.uploadId, s.key);
    w.advance(DAY + 1);
    const r = await runArchiveGc(w.ctx);
    expect(r.aborted).toBe(1);
    expect(w.db.one<{ state: string }>("SELECT state FROM archives WHERE id = ?", s.archiveId)?.state).toBe(
      "aborted",
    );
    expect(w.db.all("SELECT * FROM multipart")).toEqual([]);
  });

  it("gen GC: the newest verified gen and the newest complete gen are always kept", async () => {
    const w = world();
    w.install();
    const gens: number[] = [];
    for (let i = 0; i < 8; i++) {
      gens.push((await bootComplete(w)).gen);
      w.advance(2 * DAY);
    }
    w.db.run("UPDATE gens SET state = 'verified' WHERE gen = ?", gens[1] as number);
    w.advance(10 * DAY);
    const p = planGc(w.ctx);
    expect(p.delete).not.toContain(gens[1]);
    expect(p.delete).not.toContain(gens[7]);
    for (const g of p.delete) expect(g).toBeLessThan(gens[7] as number);
  });
});

describe("M4 restore drill and verify", () => {
  it("tar reader: long names, dirs, end marker", () => {
    const files: string[] = [];
    const t = new TarReader({ entry: (p) => files.push(p), data: () => {}, end: () => {} });
    const long = `${"d/".repeat(60)}f.txt`;
    const raw = new Uint8Array(
      require("node:zlib").gunzipSync(
        tgz([
          { path: "a", dir: true },
          { path: long, data: Buffer.from("x") },
        ]),
      ),
    );
    for (let i = 0; i < raw.length; i += 77) t.push(raw.subarray(i, i + 77));
    expect(files).toEqual(["a", long]);
    expect(t.done).toBe(true);
  });

  it("drill restores the newest archive into a throw-away DO: workspace files, SQLite header, verified", async () => {
    const { w, gen } = await booted();
    const a = await mkArchive(w, gen, { ws: { entries: 2, missing: 0 } });
    const r = await runDrill(w.ctx, w.ledger, target(w));
    expect(r.ok).toBe(true);
    expect(r.report).toMatchObject({ shaOk: true, sizeOk: true, workspaceFiles: 2, files: 4, unsafe: 0 });
    expect(r.report?.dbs).toEqual([
      expect.objectContaining({ path: `${ROOT}/state/openclaw.sqlite`, headerOk: true, sizeOk: true }),
    ]);
    expect(r.report?.storedFiles).toBe(4);
    const row = w.db.one<{ verified_by: string }>("SELECT verified_by FROM archives WHERE id = ?", a.id);
    expect(row?.verified_by).toBe("drill");
    expect(w.db.metaJson("drillLast", null)).toMatchObject({ ok: true, archiveId: a.id });
  });

  it("drill on a corrupted R2 copy → archive bad, high alert; the next plan skips it", async () => {
    const { w, gen } = await booted();
    const old = await mkArchive(w, gen);
    w.advance(MIN);
    const a = await mkArchive(w, gen);
    const bad = a.bytes.slice();
    bad[bad.length - 10] = (bad[bad.length - 10] ?? 0) ^ 0xff;
    await w.r2.put(a.key, bad);
    const r = await runDrill(w.ctx, w.ledger, target(w));
    expect(r.ok).toBe(false);
    expect(r.report?.shaOk).toBe(false);
    expect(w.db.one<{ state: string }>("SELECT state FROM archives WHERE id = ?", a.id)?.state).toBe("bad");
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'archive-bad'")).toBeTruthy();
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'drill-failed'")).toBeTruthy();
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "afterbad", reason: "user", ladder: 4 });
    expect(b.plan.archive?.archiveId).toBe(old.id);
  });

  it("drill is due monthly (and a day after a failure); one try per day; none without archives", async () => {
    const { w, gen } = await booted();
    expect(drillDue(w.ctx)).toBe(false);
    await mkArchive(w, gen);
    expect(drillDue(w.ctx)).toBe(true);
    await runDrill(w.ctx, w.ledger, target(w));
    w.advance(DAY + 1);
    expect(drillDue(w.ctx)).toBe(false);
    w.advance(ARCHIVE_DEFAULTS.drillEveryMs);
    expect(drillDue(w.ctx)).toBe(true);
    // the alarm tick runs it
    w.ctx.drill = target(w);
    await w.api.tick();
    expect(w.db.metaJson<{ at: number }>("drillLast", { at: 0 }).at).toBe(w.clock.t);
  });

  it("/ops/archive: GET status; POST request wakes; POST /drill; GET /gc", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    w.ctx.drill = target(w);
    const ops = (method: string, sub: string[], body: Record<string, unknown> = {}) =>
      w.api.ops({ action: "archive", method, sub, query: {}, body, role: "owner" });
    const st = await ops("GET", []);
    expect(st.status).toBe(200);
    expect((st.body as { archives: unknown[] }).archives.length).toBe(1);
    expect((await ops("POST", [], { reason: "x" })).status).toBe(400);
    const rq = await ops("POST", [], { reason: "pre-upgrade" });
    expect(rq.status).toBe(202);
    expect(w.rt(1).wakes).toContain("cli");
    const d = await ops("POST", ["drill"]);
    expect([d.status, (d.body as { ok: boolean }).ok]).toEqual([200, true]);
    expect((await ops("GET", ["gc"])).status).toBe(200);
  });

  it("archiveDue reads the newest complete archive and the last gen write", async () => {
    const { w, gen } = await booted();
    const q = { one: <T>(s: string, ...b: (string | number | null)[]) => w.db.one<T>(s, ...b) };
    expect(archiveDue(q, w.clock.t, ARCHIVE_DEFAULTS).why).toBe("none");
    await mkArchive(w, gen);
    expect(archiveDue(q, w.clock.t, ARCHIVE_DEFAULTS)).toMatchObject({ due: false, why: "fresh" });
  });
});

describe("N8 pre-boot archive: a deploy since the last boot", () => {
  const seen = (w: World, version: string) => w.core.freshSecrets({ version });
  const NEW = "v-new";

  it("a Worker version that is not this DO's build marks the redeploy; the same version does not", async () => {
    const { w } = await booted();
    w.ctx.buildVersion = "v-old";
    seen(w, "v-old");
    expect(preBootSince(w.ctx)).toBeNull();
    w.advance(1000);
    seen(w, NEW);
    expect(preBootSince(w.ctx)).toBe(w.clock.t);
    const at = w.clock.t;
    w.advance(5000);
    seen(w, NEW); // the same new version again does not move the mark
    expect(preBootSince(w.ctx)).toBe(at);
  });

  it("writes after the newest archive + a redeploy → one forced archive request that holds the sleep", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    w.ctx.buildVersion = "v-old";
    w.advance(MIN);
    upload(w, gen, 40); // a write after the archive, inside minGap: the cadence says `gap`, not due
    expect(archiveDirty(w.ctx)).toBe(true);
    expect(archiveSleepBlockers(w.ctx)).toEqual([]);
    expect(ensurePreBootArchive(w.ctx)).toBe(false); // no redeploy seen yet
    seen(w, NEW);
    expect(ensurePreBootArchive(w.ctx)).toBe(true);
    expect(archiveSleepBlockers(w.ctx)).toEqual(["archive-requested:pre-upgrade"]);
    // once only: a pending request is not asked for again, and not within minGap after it
    expect(ensurePreBootArchive(w.ctx)).toBe(false);
    // the request is served by the next poll whatever the cadence says
    const a = w.ledger.archiveStart(gen, "online", { reason: "6h" });
    expect(a.ok && a.reason).toBe("pre-upgrade");
    if (a.ok) w.ledger.archiveFinish(a.archiveId, true, { sha256: "d".repeat(64), size: 1, parts: 1 });
    expect(archiveDirty(w.ctx)).toBe(false);
    expect(archiveSleepBlockers(w.ctx)).toEqual([]);
    expect(ensurePreBootArchive(w.ctx)).toBe(false);
    // the gateway writes on; one pre-boot archive per redeploy, the sleep op's N8 gate takes the next one
    w.advance(ARCHIVE_DEFAULTS.minGapMs + 1);
    upload(w, gen, 41);
    expect(archiveDirty(w.ctx)).toBe(true);
    expect(ensurePreBootArchive(w.ctx)).toBe(false);
    // a later redeploy asks once more
    w.advance(1000);
    seen(w, "v-newer");
    expect(ensurePreBootArchive(w.ctx)).toBe(true);
  });

  it("no ask when the newest archive already holds the last write; a boot after the redeploy clears the mark", async () => {
    const { w, gen } = await booted();
    await mkArchive(w, gen);
    w.ctx.buildVersion = "v-old";
    w.advance(MIN);
    seen(w, NEW);
    expect(archiveDirty(w.ctx)).toBe(false);
    expect(ensurePreBootArchive(w.ctx)).toBe(false);
    w.advance(MIN);
    await bootComplete(w);
    expect(preBootSince(w.ctx)).toBeNull();
  });

  it("restart after a deploy: fresh archive → no wait; dirty → waits for the request; not running → skipped", async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const { w, gen } = await booted();
      await mkArchive(w, gen);
      w.rt(1).state = "stopped";
      w.db.setMeta("rtState", "stopped");
      expect(await w.core.archiveBeforeRestart()).toBe("skipped");
      w.rt(1).state = "running";
      w.db.setMeta("rtState", "running");
      expect(await w.core.archiveBeforeRestart()).toBe("fresh");
      w.advance(MIN);
      upload(w, gen, 50);
      const p = w.core.archiveBeforeRestart();
      // ocsup serves the request at its next poll
      await vi.advanceTimersByTimeAsync(3000);
      const a = w.ledger.archiveStart(gen, "online", { reason: "6h" });
      if (!a.ok) throw new Error(`start ${a.error}`);
      w.ledger.archiveFinish(a.archiveId, true, { sha256: "e".repeat(64), size: 1, parts: 1 });
      await vi.advanceTimersByTimeAsync(2500);
      expect(await p).toBe("taken");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restart after a deploy: a failed pre-restart archive refuses (409, no stop); hard skips the wait", async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const { w, gen } = await booted();
      await mkArchive(w, gen);
      w.rt(1).state = "running";
      w.db.setMeta("rtState", "running");
      w.advance(MIN);
      upload(w, gen, 60); // a write after the newest archive
      const restart = (body: Record<string, unknown>) =>
        w.api.ops({ action: "restart", method: "POST", sub: [], query: {}, body, role: "owner" });
      const p = restart({ redeploy: true });
      await vi.advanceTimersByTimeAsync(3000);
      const cur = w.db.metaJson<Record<string, unknown>>("archiveRequest", {});
      w.db.setMeta("archiveRequest", { ...cur, state: "failed", why: "stalled: start refused" });
      await vi.advanceTimersByTimeAsync(2500);
      const r = await p;
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ redeploy: true, archive: "failed" });
      expect(w.rt(1).state).toBe("running"); // no stop: the new image would boot from the older archive
      const h = await restart({ redeploy: true, hard: true });
      expect(h.status).toBe(200);
      expect(h.body).toMatchObject({ redeploy: true, archive: "skipped" });
    } finally {
      vi.useRealTimers();
    }
  });
});
