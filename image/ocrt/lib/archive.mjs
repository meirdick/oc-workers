// Archive runner (plan §4.11 "Archives", §6.1 row 7; contract /v1/archive/*).
// `openclaw backup create --verify --json` runs as uid 1000 (ocio/archive-create.mjs) and streams the file
// to ocsup; ocsup cuts 16 MiB parts, hashes in the same pass (no root copy on disk) and sends them through
// ControlGate multipart. Any failure or a drain → /v1/archive/abort.
// M4 cadence: ocsup polls `POST /v1/archive/start {reason:"6h"}` about once a minute while awake; the Control
// DO decides (worker/src/gates/archive-policy.ts): 409 `fresh` (nothing changed since the newest archive, or
// inside the min gap), 409 `busy` (one open, or the DO is quiescing), 429 `archive-cap`, else it opens the
// archive. A pending owner/pre-upgrade request is served by the next poll (≤ 5 min after a cap answer). The DO holds the sleep while an
// archive is open (capped), so an online archive completes during the awake period (M3 e2e F10, live A A2).
// The manifest carries the workspace facts at start (attested paths, entries, missing): the boot plan ranks
// archives with an empty or missing workspace last.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { ARCHIVE_PART_MAX } from "./contract.mjs";
import { runOcio } from "./ocio-run.mjs";

/**
 * Root side of the archive output dir: make it (0700) if missing, then hand it to uid 1000. An existing dir
 * (e.g. a mount) is kept, never removed; ocio archive-create empties it. A non-directory throws.
 */
export function ensureUid1000Dir(dir, uid = 1000) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== uid) fs.chownSync(dir, uid, uid);
}

export const ARCHIVE_EVERY_MS = 6 * 3_600_000; // the Control DO's age rule (kept for reference)
/** Poll interval: the Control DO answers `fresh` cheaply; main.mjs ticks every 60 s. */
export const ARCHIVE_POLL_MS = 60_000;
export const ARCHIVE_RETRY_MS = 5 * 60_000; // guess: after a failed archive
/**
 * After 429 archive-cap. The cap is per reason: an owner/pre-upgrade request made later gets its own starts
 * (archive-policy.ts dayCap), so poll again soon. It was 1 h: a request waited behind it and stalled.
 */
export const ARCHIVE_CAP_BACKOFF_MS = 5 * 60_000;

export class Archiver {
  /**
   * o: {gate: {call}, varDir, ocio?, cli?, partMax?, now?, cgIo?, asRoot?, alert?, prepOut?(dir), state?,
   *     workspaceFacts?: false, shadow?: () => Promise<{ok, env?, why?}>, shadowDone?: () => Promise}
   */
  constructor(o) {
    this.o = o;
    this.ocio = o.ocio || ((n, a, oo) => runOcio(n, a, { cg: o.cgIo, asRoot: o.asRoot, ...oo }));
    this.now = o.now || Date.now;
    this.running = null;
    this.child = null;
    this.aborted = false;
    this.last = null; // {kind, at, ok, ...}
  }

  /** Time to poll the Control DO again? (It decides whether an archive is due.) */
  due(now = this.now()) {
    if (this.running) return false;
    if (!this.last) return true;
    const wait =
      this.last.skipped === "cap"
        ? ARCHIVE_CAP_BACKOFF_MS
        : this.last.ok
          ? ARCHIVE_POLL_MS
          : ARCHIVE_RETRY_MS;
    return now - this.last.at >= wait;
  }

  /** Workspace facts at start (ocio workspace check, uid 1000). null when unknown. */
  async #workspaceFacts() {
    const state = this.o.state || process.env.OCRT_STATE || "/home/node/.openclaw";
    try {
      const r = await this.ocio(
        "workspace",
        ["check", JSON.stringify({ db: `${state}/state/openclaw.sqlite`, state })],
        { timeoutMs: 10_000 },
      );
      const j = r.json;
      if (!j?.ok || !Array.isArray(j.attested) || j.attested.length === 0) return null;
      return {
        attested: j.attested.length,
        entries: j.attested.reduce((n, a) => n + Math.max(0, Number(a.entries) || 0), 0),
        missing: Array.isArray(j.missing) ? j.missing.length : 0,
      };
    } catch {
      return null;
    }
  }

  /** Run one archive. kind: online | clean | offline. reason: "6h" | "pre-upgrade" | ... */
  run(kind = "online", reason = "6h", manifest = {}) {
    if (this.running) return this.running;
    this.aborted = false;
    this.running = this.#run(kind, reason, manifest).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async #run(kind, reason, manifest) {
    const t0 = this.now();
    const gate = this.o.gate;
    const partMax = this.o.partMax || ARCHIVE_PART_MAX;
    const outDir = `${this.o.varDir}/bk-u`;
    // M3 e2e: /var/lib/ocrt is root 0711, so uid 1000 could not make bk-u and every archive failed in
    // ~50 ms ("ocio exit 1"); with no archive an image change then blocked every boot (workspace-missing).
    try {
      this.o.prepOut?.(outDir);
    } catch (e) {
      return this.#done({ kind, reason, ok: false, why: `prep: ${e.message || e}`, ms: this.now() - t0 });
    }
    const workspace = this.o.workspaceFacts === false ? null : await this.#workspaceFacts();

    let start;
    try {
      start = await gate.call("POST", "/v1/archive/start", {
        kind,
        manifest: { reason, ...(workspace ? { workspace } : {}), ...manifest },
      });
    } catch (e) {
      // Cadence answers are not failures: nothing to archive now (fresh), one is open or the DO is going to
      // sleep (busy), or the day cap (cap; poll again in an hour).
      const msg = String(e?.message || e);
      if (e?.status === 409 && /"error":"(fresh|busy)"/.test(msg))
        return this.#done({
          kind,
          reason,
          ok: true,
          skipped: /"busy"/.test(msg) ? "busy" : "fresh",
          ms: this.now() - t0,
        });
      if (e?.status === 429 && /archive-cap/.test(msg))
        return this.#done({ kind, reason, ok: true, skipped: "cap", ms: this.now() - t0 });
      return this.#done({ kind, reason, ok: false, why: `start: ${msg}`, ms: this.now() - t0 });
    }
    const id = start.archiveId;
    // L5 (M4 loss): an online archive never reads the live DBs under a write lock (5.95 s writer stall). It
    // runs on a shadow tree: managed DBs restored from the replica, other SQLite by the backup API. Built only
    // after the DO opened the archive (most polls answer fresh).
    let env = null;
    if (kind === "online" && this.o.shadow) {
      const sh = await this.o.shadow().catch((e) => ({ ok: false, why: String(e?.message || e) }));
      if (!sh?.ok) {
        try {
          await gate.call("POST", "/v1/archive/abort", { archiveId: id });
        } catch {}
        await this.o.shadowDone?.();
        this.o.alert?.("archive-failed", "warn", `${kind} shadow: ${sh?.why ?? "failed"}`);
        return this.#done({
          kind,
          reason,
          ok: false,
          archiveId: id,
          why: `shadow: ${sh?.why ?? "failed"}`,
          ms: this.now() - t0,
        });
      }
      env = sh.env;
      // A drain that came while the shadow was built (no child to kill yet): do not start the CLI.
      if (this.aborted) {
        await this.o.shadowDone?.();
        try {
          await gate.call("POST", "/v1/archive/abort", { archiveId: id });
        } catch {}
        return this.#done({ kind, reason, ok: false, archiveId: id, why: "draining", ms: this.now() - t0 });
      }
    }
    const h = createHash("sha256");
    let size = 0;
    let n = 0;
    let buf = [];
    let bufLen = 0;
    let chain = Promise.resolve();
    let upErr = null;
    const send = (chunk) => {
      const num = ++n;
      chain = chain.then(async () => {
        if (upErr) return;
        try {
          await gate.call("PUT", `/v1/archive/part?archiveId=${encodeURIComponent(id)}&n=${num}`, chunk, {
            raw: true,
            timeoutMs: 120_000,
          });
        } catch (e) {
          upErr = e;
          try {
            this.child?.kill("SIGKILL");
          } catch {}
        }
      });
    };
    const r = await this.ocio(
      "archive-create",
      [JSON.stringify({ outDir, cli: this.o.cli, ...(env ? { env } : {}) })],
      {
        onChild: (c) => {
          this.child = c;
        },
        onData: (d) => {
          h.update(d);
          size += d.length;
          buf.push(d);
          bufLen += d.length;
          while (bufLen >= partMax) {
            const all = Buffer.concat(buf);
            send(all.subarray(0, partMax));
            buf = [all.subarray(partMax)];
            bufLen = all.length - partMax;
          }
        },
        timeoutMs: 1_200_000,
      },
    );
    this.child = null;
    if (bufLen > 0) send(Buffer.concat(buf));
    await chain;
    let summary = null;
    try {
      summary = JSON.parse(r.err.trim().split("\n").pop());
    } catch {}
    const abort = async (why) => {
      await this.o.shadowDone?.();
      try {
        await gate.call("POST", "/v1/archive/abort", { archiveId: id });
      } catch {}
      this.o.alert?.("archive-failed", "warn", `${kind} ${why}`);
      return this.#done({ kind, reason, ok: false, archiveId: id, why, ms: this.now() - t0 });
    };
    if (this.aborted) return abort("draining");
    if (upErr) return abort(`part: ${upErr.message || upErr}`);
    if (r.code !== 0 || !summary?.ok) {
      // Keep the CLI's stderr tail: ENOSPC shows only there (disk-full class, Z0.4).
      const why = summary?.why || `ocio exit ${r.code}`;
      const tail = String(summary?.tail || r.err || "").slice(-300);
      return abort(/ENOSPC|no space left/i.test(tail) ? `${why}: ENOSPC ${tail}` : why);
    }
    if (summary.bytes !== size || n === 0) return abort(`short stream ${size}/${summary.bytes}`);
    await this.o.shadowDone?.();
    const sha256 = h.digest("hex");
    try {
      await gate.call(
        "POST",
        "/v1/archive/complete",
        { archiveId: id, sha256, size, parts: n },
        { timeoutMs: 60_000 },
      );
    } catch (e) {
      return abort(`complete: ${e.message || e}`);
    }
    return this.#done({
      kind,
      reason,
      ok: true,
      archiveId: id,
      sha256,
      size,
      parts: n,
      createMs: summary.createMs,
      ms: this.now() - t0,
    });
  }

  #done(rec) {
    this.last = { ...rec, at: this.now() };
    return this.last;
  }

  /** Drain step 1: abort the runner; #run then calls /v1/archive/abort. */
  abort() {
    this.aborted = true;
    try {
      this.child?.kill("SIGKILL");
    } catch {}
  }
}
