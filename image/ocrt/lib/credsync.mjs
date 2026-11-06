// credsync, root side (plan §4.10, §6.1 row 2; add §2.6 phase 5, §2.8; scope §1.1 rows "credsync",
// "Reap and helpers"). The ocio watcher (ocio/credwatch.mjs, uid 1000) reads the files; ocsup only
// sends what it streams. Event-driven PUT /v1/creds/<path> {seq, sha256, mode, b64}; tombstones by
// DELETE. Reconcile scan at boot, after each watcher respawn, and in flush (sleep phase 5, drain step 5).
// Watcher down > 30 s: alert credsync-down; > 60 s: close channel ingress until it is back and reconciled.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { lineSplitter } from "./ls-log.mjs";
import { spawnOcio } from "./ocio-run.mjs";

export const BACKOFF_S = [1, 2, 5, 10, 30];
export const DOWN_ALERT_MS = 30_000;
export const DOWN_CLOSE_MS = 60_000;
export const FLUSH_CAP_MS = 30_000;
export const RECONCILE_MS = 30_000;
/** A respawned watcher counts as up after this long without an exit. */
export const UP_OK_MS = 10_000;

export const credRoute = (rel) => `/v1/creds/${rel.split("/").map(encodeURIComponent).join("/")}`;

export class CredSync extends EventEmitter {
  /**
   * o: {root, trees?, files?, gate: {call(method, route, body)}, mode: "write"|"read-only",
   *     varDir, known?: {path: sha256} (restored manifest), seqBase?, spawn?, cgIo?, asRoot?,
   *     alert?(cls, sev, detail), onIngress?(open:boolean), now?}
   */
  constructor(o) {
    super();
    this.o = { trees: ["credentials"], files: [], mode: "write", ...o };
    this.now = o.now || Date.now;
    this.acked = new Map(Object.entries(o.known || {}));
    this.queue = new Map(); // path -> event (latest wins)
    this.inflight = null;
    this.seq = o.seqBase || 0;
    this.child = null;
    this.downSince = this.now();
    this.backoff = 0;
    this.stopped = false;
    this.ingressClosed = false;
    this.alerted = false;
    this.scanWaiters = [];
    this.reconciled = false;
    this.stats = { puts: 0, dels: 0, errors: 0, skips: 0, lastPutMs: null, respawns: 0 };
    this.journal = o.varDir ? path.join(o.varDir, "creds-pending") : null;
    this.tick = setInterval(() => this.#downCheck(), 1000);
    this.tick.unref?.();
    // Periodic reconcile catches missed events (plan §4.10).
    this.recon = setInterval(() => this.#scan(), o.reconcileMs || RECONCILE_MS);
    this.recon.unref?.();
  }

  start() {
    this.#spawn();
    return this;
  }

  #spawn() {
    if (this.stopped) return;
    const arg = JSON.stringify({ root: this.o.root, trees: this.o.trees, files: this.o.files });
    const child = (
      this.o.spawn || ((a) => spawnOcio("credwatch", a, { cg: this.o.cgIo, asRoot: this.o.asRoot }))
    )([arg]);
    this.child = child;
    this.reconciled = false;
    child.stdout.on(
      "data",
      lineSplitter((l) => this.#msg(l), 4 * 1024 * 1024),
    );
    child.stderr?.on("data", () => {});
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(this.upTimer);
      this.upTimer = null;
      if (this.downSince === null) this.downSince = this.now(); // a crash loop keeps the first down time
      this.emit("watcher-exit", { code, signal });
      if (this.stopped) return;
      const wait = BACKOFF_S[Math.min(this.backoff++, BACKOFF_S.length - 1)];
      this.stats.respawns++;
      setTimeout(() => this.#spawn(), wait * 1000).unref?.();
    });
  }

  #scan() {
    try {
      this.child?.stdin.write(`${JSON.stringify({ cmd: "scan", known: Object.fromEntries(this.acked) })}\n`);
    } catch {}
  }

  #downCheck() {
    if (this.stopped || this.downSince === null) return;
    const down = this.now() - this.downSince;
    if (down > DOWN_ALERT_MS && !this.alerted) {
      this.alerted = true;
      this.o.alert?.("credsync-down", "warn", `watcher down ${Math.round(down / 1000)} s`);
    }
    if (down > DOWN_CLOSE_MS && !this.ingressClosed) {
      this.ingressClosed = true;
      this.o.alert?.("credsync-down", "high", "ingress closed");
      this.o.onIngress?.(false);
      this.emit("ingress", false);
    }
  }

  #msg(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.op === "ready") {
      this.#scan();
      return;
    }
    if (m.op === "scan-done") {
      this.reconciled = true;
      // A watcher that ran before counts as up only after UP_OK_MS without an exit: a crash loop
      // with fast reconciles keeps the down clock (alert 30 s, ingress closed 60 s). First start: at once.
      if (this.downSince !== null && !this.upTimer) {
        const child = this.child;
        const up = () => {
          this.upTimer = null;
          if (this.child !== child || this.stopped) return;
          this.downSince = null;
          this.alerted = false;
          this.backoff = 0;
          if (this.ingressClosed) {
            this.ingressClosed = false;
            this.o.onIngress?.(true);
            this.emit("ingress", true);
          }
        };
        if (this.stats.respawns === 0) up();
        else {
          this.upTimer = setTimeout(up, this.o.upOkMs ?? UP_OK_MS);
          this.upTimer.unref?.();
        }
      }
      for (const w of this.scanWaiters.splice(0)) w(m);
      this.emit("scan-done", m);
      return;
    }
    if (m.op === "skip") {
      this.stats.skips++;
      this.emit("skip", m);
      return;
    }
    if (m.op === "put") {
      if (this.acked.get(m.path) === m.sha256 && !this.queue.has(m.path)) return;
      this.#enqueue(m.path, { op: "put", ...m, at: this.now() });
    } else if (m.op === "del") {
      if (!this.acked.has(m.path) && !this.queue.has(m.path)) return;
      this.#enqueue(m.path, { op: "del", path: m.path, at: this.now() });
    }
  }

  #enqueue(p, ev) {
    if (this.o.mode !== "write") return; // read-only (canary, dark phase): watch, never send
    this.queue.set(p, ev);
    this.#journal();
    this.#pump();
  }

  #journal() {
    if (!this.journal) return;
    try {
      fs.writeFileSync(`${this.journal}.tmp`, JSON.stringify({ paths: [...this.queue.keys()] }), {
        mode: 0o600,
      });
      fs.renameSync(`${this.journal}.tmp`, this.journal);
    } catch {}
  }

  async #pump() {
    if (this.inflight || this.stopped) return;
    const next = this.queue.entries().next();
    if (next.done) {
      this.emit("idle");
      return;
    }
    const [p, ev] = next.value;
    this.queue.delete(p);
    this.inflight = ev;
    const seq = ++this.seq;
    try {
      if (ev.op === "put") {
        await this.o.gate.call("PUT", credRoute(p), { seq, sha256: ev.sha256, mode: ev.mode, b64: ev.b64 });
        this.acked.set(p, ev.sha256);
        this.stats.puts++;
        this.stats.lastPutMs = this.now() - ev.at;
      } else {
        await this.o.gate.call("DELETE", credRoute(p), { seq });
        this.acked.delete(p);
        this.stats.dels++;
      }
      this.emit("sent", { path: p, op: ev.op, seq, ms: this.now() - ev.at });
    } catch (e) {
      this.stats.errors++;
      if (e?.name === "StaleError") {
        this.stopped = true;
        this.inflight = null;
        return;
      }
      if (!this.queue.has(p)) this.queue.set(p, ev); // a newer event for p wins
      this.emit("send-error", { path: p, error: String(e?.message || e) });
      this.inflight = null;
      setTimeout(() => this.#pump(), 1000).unref?.();
      return;
    }
    this.inflight = null;
    this.#journal();
    this.#pump();
  }

  backlog() {
    return this.queue.size + (this.inflight ? 1 : 0);
  }

  /**
   * Flush: full reconcile scan, then an empty queue (cap 30 s). Sleep phase 5 and drain step 5.
   * Returns {ok, ms, backlog, why?}.
   */
  async flush(capMs = FLUSH_CAP_MS) {
    const t0 = this.now();
    if (this.o.mode !== "write") return { ok: true, ms: 0, backlog: 0, why: "read-only" };
    if (!this.child) return { ok: false, ms: 0, backlog: this.backlog(), why: "watcher-down" };
    const end = Date.now() + capMs;
    const scanned = new Promise((r) => this.scanWaiters.push(r));
    this.#scan();
    const to = (ms) => new Promise((r) => setTimeout(() => r("timeout"), Math.max(0, ms)));
    if ((await Promise.race([scanned, to(end - Date.now())])) === "timeout")
      return { ok: false, ms: this.now() - t0, backlog: this.backlog(), why: "scan-timeout" };
    while (this.backlog() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const ok = this.backlog() === 0;
    return { ok, ms: this.now() - t0, backlog: this.backlog(), why: ok ? null : "cap" };
  }

  status() {
    return {
      up: !!this.child,
      downMs: this.downSince === null ? 0 : this.now() - this.downSince,
      backlog: this.backlog(),
      acked: this.acked.size,
      ingressClosed: this.ingressClosed,
      ...this.stats,
    };
  }

  /** Kill the watcher, keep the queue (self-fence: no final sync). */
  stop() {
    this.stopped = true;
    clearTimeout(this.upTimer);
    clearInterval(this.tick);
    clearInterval(this.recon);
    try {
      this.child?.kill("SIGKILL");
    } catch {}
  }
}
