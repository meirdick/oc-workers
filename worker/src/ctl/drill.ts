// Restore drill (plan §1 F1 "a monthly drill restores the newest archive in a throw-away DO", §6.1 row 7).
// The throw-away DO (`drill:<inst>:<id>`, the Control class, no container) streams the archive from R2,
// checks size and sha256 against the index, gunzips it, unpacks the tar into its own SQLite storage
// (files in 1 MiB chunks), then checks what it stored: workspace files present, every SQLite file has a
// valid header and a page count that matches its size. The caller deletes the DO storage after the report.
// Deviation (guess, noted in the report): plan §9 "monthly drill" also boots a canary-mode container from the
// archive; that needs the Runtime canary mode (M6). The CF boot from image + archive + gen is the live drill.
import { shaDigest, shaInit, shaUpdate } from "../gates/sha256";
import type { Db } from "./sql";

/** The R2 calls the archive paths need (BucketLike plus the body stream and multipart abort). */
export interface ArchiveBucket {
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  delete(keys: string | string[]): Promise<void>;
  resumeMultipartUpload?(key: string, uploadId: string): { abort(): Promise<void> };
}

export interface DrillArgs {
  archiveId: string;
  key: string;
  sha256: string | null;
  size: number | null;
  /** Workspace entries ocsup saw at archive start (null = unknown). */
  wsEntries?: number | null;
}

export interface DrillDb {
  path: string;
  bytes: number;
  headerOk: boolean;
  pageSize: number;
  pages: number;
  sizeOk: boolean;
}

export interface DrillReport {
  ok: boolean;
  archiveId: string;
  key: string;
  why: string[];
  bytes: number;
  sizeOk: boolean;
  shaOk: boolean;
  tarBytes: number;
  files: number;
  dirs: number;
  links: number;
  unsafe: number;
  workspaceFiles: number;
  storedBytes: number;
  storedFiles: number;
  dbs: DrillDb[];
  ms: number;
}

export const DRILL_CHUNK = 1024 * 1024;
/** guess: a drill DO holds at most this many restored bytes; past it files are counted, not stored. */
export const DRILL_STORE_MAX = 1024 * 1024 * 1024;

const SQLITE_MAGIC = "SQLite format 3\0";
const WS_RE = /(^|\/)\.openclaw\/workspace\/./;

function octal(b: Uint8Array, off: number, len: number): number {
  // GNU base-256 for large sizes
  if ((b[off] ?? 0) & 0x80) {
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + (b[i] ?? 0);
    return v;
  }
  let s = "";
  for (let i = off; i < off + len; i++) {
    const c = b[i] ?? 0;
    if (c === 0 || c === 32) {
      if (s) break;
      continue;
    }
    s += String.fromCharCode(c);
  }
  return s ? Number.parseInt(s, 8) : 0;
}
function cstr(b: Uint8Array, off: number, len: number): string {
  let e = off;
  while (e < off + len && b[e] !== 0) e++;
  return new TextDecoder().decode(b.subarray(off, e));
}
function paxPath(b: Uint8Array): string | null {
  const t = new TextDecoder().decode(b);
  let i = 0;
  while (i < t.length) {
    const sp = t.indexOf(" ", i);
    if (sp < 0) break;
    const n = Number.parseInt(t.slice(i, sp), 10);
    if (!Number.isFinite(n) || n <= 0) break;
    const rec = t.slice(sp + 1, i + n - 1);
    const eq = rec.indexOf("=");
    if (rec.slice(0, eq) === "path") return rec.slice(eq + 1);
    i += n;
  }
  return null;
}

/** Minimal streaming tar reader (ustar, GNU long names, pax `path`). */
export class TarReader {
  private buf = new Uint8Array(0);
  private cur: { path: string; type: string; left: number; pad: number; meta: Uint8Array[] | null } | null =
    null;
  private longName: string | null = null;
  private zeros = 0;
  done = false;
  constructor(
    private readonly cb: {
      entry(path: string, type: string, size: number): void;
      data(chunk: Uint8Array): void;
      end(): void;
    },
  ) {}

  push(chunk: Uint8Array): void {
    if (this.done) return;
    const nb = new Uint8Array(this.buf.length + chunk.length);
    nb.set(this.buf, 0);
    nb.set(chunk, this.buf.length);
    this.buf = nb;
    let off = 0;
    for (;;) {
      if (this.cur) {
        if (this.cur.left > 0) {
          const take = Math.min(this.cur.left, this.buf.length - off);
          if (take <= 0) break;
          const part = this.buf.subarray(off, off + take);
          if (this.cur.meta) this.cur.meta.push(part.slice());
          else this.cb.data(part);
          this.cur.left -= take;
          off += take;
          if (this.cur.left > 0) break;
        }
        if (this.buf.length - off < this.cur.pad) break;
        off += this.cur.pad;
        const c = this.cur;
        this.cur = null;
        if (c.meta) {
          const all = concat(c.meta);
          if (c.type === "L") this.longName = cstr(all, 0, all.length);
          else if (c.type === "x") this.longName = paxPath(all) ?? this.longName;
        } else this.cb.end();
        continue;
      }
      if (this.buf.length - off < 512) break;
      const h = this.buf.subarray(off, off + 512);
      off += 512;
      if (h.every((x) => x === 0)) {
        if (++this.zeros >= 2) {
          this.done = true;
          break;
        }
        continue;
      }
      this.zeros = 0;
      const size = octal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 48);
      const magic = cstr(h, 257, 6);
      const prefix = magic.startsWith("ustar") ? cstr(h, 345, 155) : "";
      let name = cstr(h, 0, 100);
      if (prefix) name = `${prefix}/${name}`;
      const pad = (512 - (size % 512)) % 512;
      if (type === "L" || type === "x" || type === "g") {
        this.cur = { path: name, type, left: size, pad, meta: [] };
        continue;
      }
      const path = this.longName ?? name;
      this.longName = null;
      this.cb.entry(path, type, size);
      this.cur = { path, type, left: size, pad, meta: null };
    }
    this.buf = this.buf.slice(off);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const DRILL_DDL = [
  `CREATE TABLE IF NOT EXISTS drill_files (path TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL,
    stored INTEGER NOT NULL DEFAULT 0, head BLOB)`,
  "CREATE TABLE IF NOT EXISTS drill_chunks (path TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, n))",
];

/** Restore one archive into `db` (the throw-away DO's storage) and check it. Never throws. */
export async function drillRestoreInto(
  db: Db,
  bucket: ArchiveBucket,
  a: DrillArgs,
  now: () => number = Date.now,
  o: { storeMax?: number } = {},
): Promise<DrillReport> {
  const t0 = now();
  const storeMax = o.storeMax ?? DRILL_STORE_MAX;
  const r: DrillReport = {
    ok: false,
    archiveId: a.archiveId,
    key: a.key,
    why: [],
    bytes: 0,
    sizeOk: false,
    shaOk: false,
    tarBytes: 0,
    files: 0,
    dirs: 0,
    links: 0,
    unsafe: 0,
    workspaceFiles: 0,
    storedBytes: 0,
    storedFiles: 0,
    dbs: [],
    ms: 0,
  };
  const end = () => {
    r.ms = now() - t0;
    return r;
  };
  try {
    for (const q of DRILL_DDL) db.run(q);
    const obj = await bucket.get(a.key);
    if (!obj) {
      r.why.push("r2 object missing");
      return end();
    }
    r.sizeOk = a.size === null || obj.size === a.size;
    if (!r.sizeOk) r.why.push(`size ${obj.size} != index ${a.size}`);
    let st = shaInit();
    // per-file state
    let cur: {
      path: string;
      n: number;
      buf: Uint8Array[];
      len: number;
      head: Uint8Array | null;
      size: number;
      store: boolean;
    } | null = null;
    const flushChunk = () => {
      if (!cur?.len) return;
      const data = concat(cur.buf);
      if (cur.store)
        db.run("INSERT INTO drill_chunks (path, n, data) VALUES (?, ?, ?)", cur.path, cur.n, data);
      cur.n++;
      cur.buf = [];
      cur.len = 0;
    };
    const tar = new TarReader({
      entry(path, type, size) {
        const safe = !path.split("/").includes("..") && !path.startsWith("/");
        if (!safe) r.unsafe++;
        if (type === "5") r.dirs++;
        else if (type === "1" || type === "2") r.links++;
        if (type !== "0" && type !== "7") {
          cur = null;
          return;
        }
        r.files++;
        if (WS_RE.test(path)) r.workspaceFiles++;
        const store = safe && r.storedBytes + size <= storeMax;
        db.run(
          "INSERT INTO drill_files (path, type, size, stored) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size",
          path,
          type,
          size,
          store ? 1 : 0,
        );
        if (store) {
          r.storedBytes += size;
          r.storedFiles++;
        }
        cur = { path, n: 0, buf: [], len: 0, head: null, size, store };
      },
      data(chunk) {
        r.tarBytes += chunk.length;
        if (!cur) return;
        if (!cur.head) cur.head = chunk.slice(0, 100);
        else if (cur.head.length < 100) cur.head = concat([cur.head, chunk.slice(0, 100 - cur.head.length)]);
        if (!cur.store) return;
        cur.buf.push(chunk.slice());
        cur.len += chunk.length;
        if (cur.len >= DRILL_CHUNK) flushChunk();
      },
      end() {
        if (!cur) return;
        flushChunk();
        const head = cur.head ?? new Uint8Array(0);
        if (head.length) db.run("UPDATE drill_files SET head = ? WHERE path = ?", head, cur.path);
        if (head.length >= 32 && new TextDecoder().decode(head.subarray(0, 16)) === SQLITE_MAGIC) {
          const ps = ((head[16] ?? 0) << 8) | (head[17] ?? 0);
          const pageSize = ps === 1 ? 65536 : ps;
          const pages =
            (((head[28] ?? 0) << 24) >>> 0) +
            ((head[29] ?? 0) << 16) +
            ((head[30] ?? 0) << 8) +
            (head[31] ?? 0);
          r.dbs.push({
            path: cur.path,
            bytes: cur.size,
            headerOk: pageSize >= 512 && (pageSize & (pageSize - 1)) === 0,
            pageSize,
            pages,
            // header page count is valid when non-zero (SQLite ≥ 3.7.0 writes it); size = pages × pageSize
            sizeOk: pages === 0 || pages * pageSize === cur.size,
          });
        }
        cur = null;
      },
    });
    const hashed = obj.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          st = shaUpdate(st, chunk);
          r.bytes += chunk.length;
          c.enqueue(chunk);
        },
      }),
    );
    const plain = hashed.pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
    const rd = plain.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      tar.push(value);
    }
    const sha = shaDigest(st);
    r.shaOk = !a.sha256 || sha === a.sha256;
    if (!r.shaOk) r.why.push(`sha ${sha.slice(0, 16)} != index ${String(a.sha256).slice(0, 16)}`);
    if (!tar.done) r.why.push("tar: no end marker");
    // Read back what the DO stored: every stored file has its bytes.
    const back = db.all<{ path: string; size: number; got: number | null }>(
      `SELECT f.path, f.size, (SELECT SUM(LENGTH(c.data)) FROM drill_chunks c WHERE c.path = f.path) AS got
       FROM drill_files f WHERE f.stored = 1`,
    );
    const short = back.filter((x) => (x.got ?? 0) !== x.size);
    if (short.length) r.why.push(`stored short: ${short.length} files (${short[0]?.path})`);
    if (r.files === 0) r.why.push("no files");
    if (r.unsafe) r.why.push(`unsafe paths: ${r.unsafe}`);
    if (!r.dbs.length) r.why.push("no SQLite file");
    const badDb = r.dbs.filter((d) => !d.headerOk || !d.sizeOk);
    if (badDb.length)
      r.why.push(
        `bad SQLite: ${badDb
          .map((d) => d.path)
          .join(", ")
          .slice(0, 200)}`,
      );
    if ((a.wsEntries ?? 0) > 0 && r.workspaceFiles === 0) r.why.push("workspace empty, index says not");
    r.ok = r.why.length === 0;
  } catch (e) {
    r.why.push(`error: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  return end();
}
