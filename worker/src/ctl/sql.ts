// Thin seam over ctx.storage.sql so Control DO logic runs on node:sqlite in vitest.
// Workers: SqlStorage.exec(query, ...bindings) → cursor with toArray()/one(). transactionSync(fn) has no await.

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface SqlLike {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] };
}
export interface StoreLike {
  sql: SqlLike;
  transactionSync<T>(fn: () => T): T;
}

export class Db {
  constructor(readonly store: StoreLike) {}

  all<T = Row>(q: string, ...b: SqlValue[]): T[] {
    return this.store.sql.exec(q, ...b.map(norm)).toArray() as T[];
  }
  one<T = Row>(q: string, ...b: SqlValue[]): T | null {
    return (this.all<T>(q, ...b)[0] as T | undefined) ?? null;
  }
  run(q: string, ...b: SqlValue[]): void {
    this.store.sql.exec(q, ...b.map(norm)).toArray();
  }
  tx<T>(fn: () => T): T {
    return this.store.transactionSync(fn);
  }

  /** Storage size in bytes (ctx.storage.sql.databaseSize on workerd), null when the store cannot tell. */
  size(): number | null {
    const v = (this.store.sql as { databaseSize?: number }).databaseSize;
    return typeof v === "number" ? v : null;
  }

  // meta singleton values (spec §3.1 `meta`)
  meta(k: string): string | null {
    return this.one<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v ?? null;
  }
  metaNum(k: string, d = 0): number {
    const v = this.meta(k);
    return v === null ? d : Number(v);
  }
  metaJson<T>(k: string, d: T): T {
    const v = this.meta(k);
    if (v === null) return d;
    try {
      return JSON.parse(v) as T;
    } catch {
      return d;
    }
  }
  setMeta(k: string, v: string | number | object | boolean): void {
    const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
    this.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, s);
  }
  delMeta(k: string): void {
    this.run("DELETE FROM meta WHERE k = ?", k);
  }
}

function norm(v: SqlValue | undefined | boolean): SqlValue {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export const j = (v: unknown): string => JSON.stringify(v ?? null);
export function pj<T>(s: SqlValue | undefined, d: T): T {
  if (typeof s !== "string") return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
}
