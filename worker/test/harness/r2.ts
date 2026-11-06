// In-memory R2Bucket subset (grown from spike/worker/test/fake-bucket.ts) with fault hooks:
// a 5xx window, list errors, write-once onlyIf, and the sha256 put check.

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

async function bytes(v: PutValue): Promise<Uint8Array> {
  if (v === null) return new Uint8Array();
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(await new Response(v as BodyInit).arrayBuffer());
}
async function sha256Hex(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

interface Obj {
  data: Uint8Array;
  key: string;
  etag: string;
  uploaded: Date;
  customMetadata: Record<string, string>;
  httpMetadata: R2HTTPMetadata;
}

export class FakeR2 {
  objs = new Map<string, Obj>();
  uploads = new Map<string, { key: string; parts: Map<number, { data: Uint8Array; etag: string }> }>();
  ops: { op: string; key: string }[] = [];
  /** Every call throws a 5xx-like error while now() < failUntil. */
  failUntil = 0;
  /** Number of next list() calls that throw. */
  listFail = 0;
  /** Number of next head()/get() calls that throw. */
  readFail = 0;
  /** head() waits this long (fake time) before it answers (holds an R2 probe open). */
  headDelayMs = 0;
  constructor(private now: () => number = () => Date.now()) {}

  private gate(op: string, key: string) {
    this.ops.push({ op, key });
    if (this.now() < this.failUntil) throw new Error(`R2 ${op} failed: 500 InternalError (fake)`);
  }
  private meta(o: Obj): R2Object {
    return {
      key: o.key,
      version: o.etag,
      size: o.data.length,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      uploaded: o.uploaded,
      checksums: { toJSON: () => ({}) },
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      storageClass: "Standard",
      writeHttpMetadata: () => {},
    } as unknown as R2Object;
  }
  private body(o: Obj, d: Uint8Array): R2ObjectBody {
    return {
      ...this.meta(o),
      body: new Response(d).body,
      bodyUsed: false,
      arrayBuffer: async () => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength),
      bytes: async () => d,
      text: async () => new TextDecoder().decode(d),
      json: async () => JSON.parse(new TextDecoder().decode(d)),
      blob: async () => new Blob([d]),
    } as unknown as R2ObjectBody;
  }

  async put(key: string, v: PutValue, o: R2PutOptions = {}): Promise<R2Object | null> {
    this.gate("put", key);
    const data = await bytes(v);
    const prev = this.objs.get(key);
    const only = o.onlyIf as R2Conditional | undefined;
    if (only && "etagDoesNotMatch" in only && only.etagDoesNotMatch === "*" && prev) return null;
    if (only && "etagMatches" in only && (!prev || prev.etag !== only.etagMatches)) return null;
    const want = o.sha256;
    if (want) {
      const got = await sha256Hex(data);
      const w = typeof want === "string" ? want : await sha256Hex(new Uint8Array(want as ArrayBuffer));
      if (got !== w) throw new Error("put: The SHA-256 checksum you specified did not match (10037)");
    }
    const obj: Obj = {
      key,
      data,
      etag: (await sha256Hex(data)).slice(0, 32),
      uploaded: new Date(this.now()),
      customMetadata: { ...(o.customMetadata ?? {}) },
      httpMetadata: (o.httpMetadata as R2HTTPMetadata) ?? {},
    };
    this.objs.set(key, obj);
    return this.meta(obj);
  }
  async get(key: string, o: R2GetOptions = {}): Promise<R2ObjectBody | null> {
    this.gate("get", key);
    if (this.readFail > 0) {
      this.readFail--;
      throw new Error("R2 get failed: 500 (fake)");
    }
    const x = this.objs.get(key);
    if (!x) return null;
    let d = x.data;
    const r = o.range as { offset?: number; length?: number; suffix?: number } | undefined;
    if (r) {
      if (r.suffix !== undefined) d = d.slice(d.length - r.suffix);
      else d = d.slice(r.offset ?? 0, r.length ? (r.offset ?? 0) + r.length : undefined);
    }
    return this.body(x, d);
  }
  async head(key: string): Promise<R2Object | null> {
    this.gate("head", key);
    if (this.headDelayMs) await new Promise((r) => setTimeout(r, this.headDelayMs));
    if (this.readFail > 0) {
      this.readFail--;
      throw new Error("R2 head failed: 500 (fake)");
    }
    const x = this.objs.get(key);
    return x ? this.meta(x) : null;
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      this.gate("delete", k);
      this.objs.delete(k);
    }
  }
  async list(o: R2ListOptions = {}): Promise<R2Objects> {
    this.gate("list", o.prefix ?? "");
    if (this.listFail > 0) {
      this.listFail--;
      throw new Error("R2 list failed: 500 (fake)");
    }
    const all = [...this.objs.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
    const after = o.cursor ?? o.startAfter;
    const keys = after ? all.filter((k) => k > after) : all;
    const objects: R2Object[] = [];
    const prefixes = new Set<string>();
    let last: string | undefined;
    let i = 0;
    for (; i < keys.length && objects.length + prefixes.size < (o.limit ?? 1000); i++) {
      const k = keys[i] as string;
      last = k;
      if (o.delimiter) {
        const rest = k.slice((o.prefix ?? "").length);
        const j = rest.indexOf(o.delimiter);
        if (j >= 0) {
          prefixes.add((o.prefix ?? "") + rest.slice(0, j + 1));
          continue;
        }
      }
      objects.push(this.meta(this.objs.get(k) as Obj));
    }
    const truncated = i < keys.length;
    return truncated
      ? ({ objects, truncated: true, cursor: last as string, delimitedPrefixes: [...prefixes] } as R2Objects)
      : ({ objects, truncated: false, delimitedPrefixes: [...prefixes] } as R2Objects);
  }
  async createMultipartUpload(key: string): Promise<R2MultipartUpload> {
    this.gate("mpu-create", key);
    const uploadId = `up-${this.uploads.size + 1}-${this.now()}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    const parts = () => {
      const p = this.uploads.get(uploadId);
      if (!p) throw new Error("NoSuchUpload: upload does not exist");
      return p.parts;
    };
    return {
      key,
      uploadId,
      uploadPart: async (n: number, v: PutValue) => {
        this.gate("mpu-part", key);
        const data = await bytes(v);
        const etag = (await sha256Hex(data)).slice(0, 32);
        parts().set(n, { data, etag });
        return { partNumber: n, etag };
      },
      complete: async (list: R2UploadedPart[]) => {
        this.gate("mpu-complete", key);
        const p = parts();
        const chunks = list.map((x) => {
          const got = p.get(x.partNumber);
          if (!got || got.etag !== x.etag) throw new Error(`invalid part ${x.partNumber}`);
          return got.data;
        });
        const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
        let off = 0;
        for (const c of chunks) {
          all.set(c, off);
          off += c.length;
        }
        this.uploads.delete(uploadId);
        return (await this.put(key, all)) as R2Object;
      },
      abort: async () => {
        this.gate("mpu-abort", key);
        parts();
        this.uploads.delete(uploadId);
      },
    } as unknown as R2MultipartUpload;
  }

  keys(prefix = ""): string[] {
    return [...this.objs.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async putJson(key: string, v: unknown) {
    const t = this.failUntil;
    this.failUntil = 0;
    await this.put(key, JSON.stringify(v));
    this.failUntil = t;
  }
  json<T = unknown>(key: string): T | undefined {
    const x = this.objs.get(key);
    return x ? (JSON.parse(new TextDecoder().decode(x.data)) as T) : undefined;
  }
}
