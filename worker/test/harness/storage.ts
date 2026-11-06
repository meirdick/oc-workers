// Fake DurableObjectStorage for a SQLite-backed DO: sql.exec on node:sqlite, transactionSync,
// the KV API and one alarm. One FakeStorage outlives DO restarts (the world keeps it).
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Row = Record<string, unknown>;

/** Split a multi-statement string on top-level semicolons (no triggers in the schema). */
function splitSql(q: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of q) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ";") {
      if (cur.trim()) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function bindValue(v: unknown, i: number, q: string): unknown {
  if (v === null || typeof v === "string" || typeof v === "number") return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  // The platform accepts only ArrayBuffer | string | number | null. Fail like it does.
  throw new TypeError(`sql binding ${i} has unsupported type ${typeof v} in: ${q.slice(0, 80)}`);
}

function outValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  if (typeof v === "bigint") return Number(v);
  return v;
}

export class FakeCursor<T extends Row = Row> implements Iterable<T> {
  private i = 0;
  constructor(
    private rows: T[],
    public readonly columnNames: string[],
    public readonly rowsRead: number,
    public readonly rowsWritten: number,
  ) {}
  next(): IteratorResult<T, undefined> {
    if (this.i < this.rows.length) return { done: false, value: this.rows[this.i++] as T };
    return { done: true, value: undefined };
  }
  toArray(): T[] {
    const r = this.rows.slice(this.i);
    this.i = this.rows.length;
    return r;
  }
  one(): T {
    const r = this.toArray();
    if (r.length !== 1) throw new Error(`Expected exactly one result from SQL query, but got ${r.length}`);
    return r[0] as T;
  }
  *raw<U extends unknown[]>(): IterableIterator<U> {
    for (const r of this.toArray()) yield this.columnNames.map((c) => r[c]) as U;
  }
  [Symbol.iterator](): Iterator<T> {
    return { next: () => this.next() as IteratorResult<T> };
  }
}

export class FakeStorage {
  readonly db = new DatabaseSync(":memory:");
  readonly kvMap = new Map<string, unknown>();
  alarmAt: number | null = null;
  /** Row writes through sql.exec, for the §3.2 cost check. */
  rowsWritten = 0;
  /** Set to make every storage call throw (DO storage outage). */
  failAll: Error | null = null;
  /** Called after every sql write with the statement and bindings (tests use it to cut at a phase). */
  onWrite: ((q: string, b: unknown[]) => void) | null = null;
  private inTx = 0;
  private afterCommit: (() => void)[] = [];
  /** Run fn now, or after the outermost transactionSync commits (rolled back → dropped). */
  whenCommitted(fn: () => void) {
    if (this.inTx > 0) this.afterCommit.push(fn);
    else fn();
  }
  private stmts = new Map<string, StatementSync>();

  readonly sql = {
    exec: <T extends Row = Row>(query: string, ...bindings: unknown[]): FakeCursor<T> =>
      this.exec<T>(query, bindings),
    get databaseSize() {
      return 0;
    },
  };

  private check() {
    if (this.failAll) throw this.failAll;
  }

  private exec<T extends Row>(query: string, bindings: unknown[]): FakeCursor<T> {
    this.check();
    const parts = splitSql(query);
    if (parts.length > 1) {
      if (bindings.length) throw new Error("sql.exec: bindings with several statements");
      for (const p of parts.slice(0, -1)) this.db.exec(p);
    }
    const last = parts[parts.length - 1] ?? "";
    let st = this.stmts.get(last);
    if (!st) {
      st = this.db.prepare(last);
      this.stmts.set(last, st);
    }
    const args = bindings.map((v, i) => bindValue(v, i, last)) as never[];
    const cols = st.columns().map((c) => c.name);
    if (cols.length) {
      const rows = (st.all(...args) as Row[]).map((r) => {
        const o: Row = {};
        for (const k of Object.keys(r)) o[k] = outValue(r[k]);
        return o as T;
      });
      // RETURNING statements also write.
      const w = /^\s*(insert|update|delete|replace)/i.test(last) ? rows.length : 0;
      this.rowsWritten += w;
      if (w && this.onWrite) this.onWrite(last, bindings);
      return new FakeCursor<T>(rows as T[], cols, rows.length, w);
    }
    const r = st.run(...args);
    const w = Number(r.changes);
    this.rowsWritten += w;
    if (w && this.onWrite) this.onWrite(last, bindings);
    return new FakeCursor<T>([], [], 0, w);
  }

  transactionSync<R>(fn: () => R): R {
    this.check();
    const sp = `sp${this.inTx++}`;
    const w0 = this.rowsWritten;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      if (r && typeof (r as { then?: unknown }).then === "function")
        throw new Error("transactionSync callback returned a promise");
      this.db.exec(`RELEASE ${sp}`);
      if (this.inTx === 1) for (const f of this.afterCommit.splice(0)) queueMicrotask(f);
      return r;
    } catch (e) {
      if (this.inTx === 1) this.afterCommit.length = 0;
      this.db.exec(`ROLLBACK TO ${sp}`);
      this.rowsWritten = w0;
      this.db.exec(`RELEASE ${sp}`);
      throw e;
    } finally {
      this.inTx--;
    }
  }

  async transaction<R>(fn: (txn: FakeStorage) => Promise<R>): Promise<R> {
    return fn(this);
  }

  // KV API (also present on SQLite-backed DOs).
  async get<T = unknown>(key: string | string[]): Promise<T | Map<string, T> | undefined> {
    this.check();
    if (Array.isArray(key)) {
      const m = new Map<string, T>();
      for (const k of key) if (this.kvMap.has(k)) m.set(k, structuredClone(this.kvMap.get(k)) as T);
      return m;
    }
    return structuredClone(this.kvMap.get(key)) as T | undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    this.check();
    if (typeof key === "string") this.kvMap.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.kvMap.set(k, structuredClone(v));
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    this.check();
    if (Array.isArray(key)) return key.filter((k) => this.kvMap.delete(k)).length;
    return this.kvMap.delete(key);
  }
  async list<T = unknown>(o: { prefix?: string } = {}): Promise<Map<string, T>> {
    this.check();
    const m = new Map<string, T>();
    for (const k of [...this.kvMap.keys()].sort())
      if (!o.prefix || k.startsWith(o.prefix)) m.set(k, structuredClone(this.kvMap.get(k)) as T);
    return m;
  }
  async deleteAll(): Promise<void> {
    this.kvMap.clear();
    this.alarmAt = null;
  }
  async getAlarm(): Promise<number | null> {
    this.check();
    return this.alarmAt;
  }
  async setAlarm(at: number | Date): Promise<void> {
    this.check();
    this.alarmAt = typeof at === "number" ? at : at.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
  async sync(): Promise<void> {}

  /** Test read helper: all rows of a query, [] when the table does not exist yet. */
  rows<T extends Row = Row>(q: string, ...b: unknown[]): T[] {
    try {
      return this.exec<T>(q, b).toArray();
    } catch (e) {
      if (/no such table/.test(String(e))) return [];
      throw e;
    }
  }
}
