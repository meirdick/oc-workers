// Shadow backups of non-managed SQLite (plan §4.11 "Shadow", §6.1 row 5; scope §1.1 "Other SQLite").
// Every 15 min, each shadow-class file whose mtime or size (main file or -wal) changed is copied by ocio (node:sqlite
// backup API, uid 1000), streamed to ocsup, written root-only to /var/lib/ocrt/shadow/<id>.sqlite with a
// sha256 in the same pass, and sent as PUT /v1/shadow/<db> (header x-ocrt-sha256). The gate allows 1 per
// DB per 10 min; files > 64 MiB are not sent (alert shadow-too-big; guess: the contract has no shadow
// multipart route yet). Draining aborts a running copy.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HDR, SHADOW_SINGLE_MAX } from "./contract.mjs";
import { dbId } from "./ls-config.mjs";
import { runOcio } from "./ocio-run.mjs";

export const SHADOW_EVERY_MS = 15 * 60_000;

/** C1 (M4): a round is due when the newest shadow upload (plan.shadowAt, then each round) is that old. */
export const shadowDue = (lastAt, now, every = SHADOW_EVERY_MS) =>
  !Number.isFinite(lastAt) || lastAt === null || now - lastAt >= every;
export const shadowRoute = (rel) => `/v1/shadow/${rel.split("/").map(encodeURIComponent).join("/")}`;
const shadowId = (rel) =>
  dbId(
    rel
      .replace(/[^A-Za-z0-9/._-]/g, "_")
      .replace(/\.sqlite$/, "")
      .concat(".sqlite"),
  );

export class Shadow {
  /**
   * o: {state, varDir, putRaw(route, buf, headers) → Promise, ocio?, alert?, now?, tmpDir?, cgIo?, asRoot?}
   */
  constructor(o) {
    this.o = o;
    this.ocio = o.ocio || ((n, a, oo) => runOcio(n, a, { cg: o.cgIo, asRoot: o.asRoot, ...oo }));
    this.now = o.now || Date.now;
    this.seen = new Map(); // rel -> {key, sha256, at}; key = main and -wal mtime/size
    this.dir = path.join(o.varDir, "shadow");
    this.aborted = false;
    this.child = null;
  }

  /**
   * Files whose mtime/size changed since the last good copy, main file or -wal (N5: a WAL writer leaves the main
   * file alone until a checkpoint). scan = fsops scan entries for the shadow set.
   */
  changed(entries) {
    const k = (e) => `${e.mtimeMs}|${e.size}|${e.walMtimeMs ?? 0}|${e.walSize ?? 0}`;
    return entries.filter((e) => {
      const s = this.seen.get(e.rel);
      return !s || s.key !== k(e);
    });
  }

  /** Copy + upload one file. Returns {rel, ok, bytes?, sha256?, why?, ms}. */
  async one(entry) {
    const t0 = this.now();
    const rel = entry.rel;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const dest = path.join(this.dir, `${shadowId(rel)}`);
    const tmp = `${dest}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    const h = createHash("sha256");
    let bytes = 0;
    let over = false;
    const r = await this.ocio(
      "sqlite-backup",
      [JSON.stringify({ src: path.join(this.o.state, rel), tmpDir: this.o.tmpDir || "/tmp" })],
      {
        onData: (d) => {
          bytes += d.length;
          if (bytes > SHADOW_SINGLE_MAX) {
            over = true;
            return;
          }
          h.update(d);
          fs.writeSync(fd, d);
        },
        onChild: (c) => {
          this.child = c;
        },
        timeoutMs: 600_000,
      },
    );
    this.child = null;
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    let summary = null;
    try {
      summary = JSON.parse(r.err.trim().split("\n").pop());
    } catch {}
    const fail = (why) => {
      fs.rmSync(tmp, { force: true });
      return { rel, ok: false, why, ms: this.now() - t0 };
    };
    if (this.aborted) return fail("draining");
    if (r.code !== 0 || !summary?.ok) return fail(summary?.why || `ocio exit ${r.code}`);
    if (over) {
      this.o.alert?.("shadow-too-big", "warn", `${rel} ${bytes} B`);
      return fail("too-big");
    }
    if (summary.bytes !== bytes) return fail(`short read ${bytes}/${summary.bytes}`);
    fs.renameSync(tmp, dest); // keep only the newest local copy per DB
    const sha256 = h.digest("hex");
    try {
      await this.o.putRaw(shadowRoute(rel), fs.readFileSync(dest), { [HDR.sha256]: sha256 });
    } catch (e) {
      // Gate contract: ≤ 1 shadow per DB per 10 min, 429 {error:"rate"} past it. The shadow from < 10 min ago
      // stands, so this is not a failure; without this every sleep < 10 min after the last one aborted
      // with sleep-flush-failed (M2 integration, oc-m2-int). Not marked seen: the next round sends it again.
      if (e?.status === 429) return { rel, ok: true, skipped: "rate", bytes, sha256, ms: this.now() - t0 };
      return { rel, ok: false, why: `upload: ${e.message || e}`, bytes, sha256, ms: this.now() - t0 };
    }
    const key = `${entry.mtimeMs}|${entry.size}|${entry.walMtimeMs ?? 0}|${entry.walSize ?? 0}`;
    this.seen.set(rel, { key, sha256, at: this.now() });
    // M4b N2: the copy is in R2 now. A local copy left on the rootfs went into every checkpoint and sleep
    // snapshot as a whole new file (a shadow round runs right before each one).
    fs.rmSync(dest, { force: true });
    return { rel, ok: true, bytes, sha256, ms: this.now() - t0 };
  }

  /** One round over the changed files (15 min timer, sleep phase 5, before a checkpoint). */
  async round(entries) {
    this.aborted = false;
    const res = [];
    for (const e of this.changed(entries)) {
      if (this.aborted) break;
      res.push(await this.one(e));
    }
    return res;
  }

  /** Drain step 1: abort a running copy; the ocio helper ignores SIGTERM, so SIGKILL. */
  abort() {
    this.aborted = true;
    try {
      this.child?.kill("SIGKILL");
    } catch {}
  }
}
