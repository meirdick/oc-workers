// LTX header check for ReplicaGate upload records (sec F1, F3; spec §18.4, §18.5). The gate records an upload
// only from the bytes it wrote itself: it reads the 100-byte LTX header of the object (from the request body
// on PutObject, from R2 after CompleteMultipartUpload) and keeps the record only when the header TXIDs equal
// the TXIDs in the key name. Format: Litestream 0.5.17 / ltx v0.5, read from real files made by the M1 image
// (big-endian): 0 "LTX1", 4 flags u32, 8 pageSize u32, 12 commit u32, 16 minTXID u64, 24 maxTXID u64,
// 32 timestamp ms i64. Header 100 bytes, trailer 16 bytes.
import type { LtxKey } from "../core/contract";

export const LTX_HEADER = 100;
export const LTX_TRAILER = 16;
const MAGIC = [0x4c, 0x54, 0x58, 0x31]; // "LTX1"
/** guess: flag bits ltx v0.5 defines (0x2 seen on every 0.5.17 file). Unknown bits → refused. */
const KNOWN_FLAGS = 0x0000_00ff;

/** What the gate learned from the bytes. `ok:false` → no record, no coverage. */
export type LtxCheck =
  | { ok: true; minTxid: number; maxTxid: number; pageSize: number; commit: number; ts: number }
  | { ok: false; why: string };

const u32 = (b: Uint8Array, o: number) =>
  (b[o] as number) * 2 ** 24 +
  ((b[o + 1] as number) << 16) +
  ((b[o + 2] as number) << 8) +
  (b[o + 3] as number);
/** u64 as a JS number; null above 2^53 (no real TXID gets there). */
function u64(b: Uint8Array, o: number): number | null {
  const hi = u32(b, o);
  const lo = u32(b, o + 4);
  if (hi >= 2 ** 21) return null;
  return hi * 2 ** 32 + lo;
}

/** Parse the first 100 bytes of an LTX file. `size` is the object size the gate wrote. */
export function parseLtxHeader(head: Uint8Array | null, size: number): LtxCheck {
  if (!head || head.length < LTX_HEADER) return { ok: false, why: "short-header" };
  if (size < LTX_HEADER + LTX_TRAILER) return { ok: false, why: "short-file" };
  for (let i = 0; i < 4; i++) if (head[i] !== MAGIC[i]) return { ok: false, why: "magic" };
  const flags = u32(head, 4);
  if ((flags & ~KNOWN_FLAGS) !== 0) return { ok: false, why: "flags" };
  const pageSize = u32(head, 8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0)
    return { ok: false, why: "page-size" };
  const commit = u32(head, 12);
  if (commit < 1) return { ok: false, why: "commit" };
  const minTxid = u64(head, 16);
  const maxTxid = u64(head, 24);
  if (minTxid === null || maxTxid === null || minTxid < 1 || maxTxid < minTxid)
    return { ok: false, why: "txid" };
  const ts = u64(head, 32) ?? 0;
  return { ok: true, minTxid, maxTxid, pageSize, commit, ts };
}

/** The record binding of F3: header TXIDs must equal the key-name TXIDs. */
export function ltxMatchesKey(c: LtxCheck, p: LtxKey): LtxCheck {
  if (!c.ok) return c;
  if (c.minTxid !== p.minTxid || c.maxTxid !== p.maxTxid) return { ok: false, why: "txid-name" };
  return c;
}

/** Keep the first `n` bytes of a stream while it passes through (PutObject bodies stream to R2). */
export class HeadTap {
  private buf = new Uint8Array(LTX_HEADER);
  private got = 0;
  bytes = 0;
  constructor(readonly n = LTX_HEADER) {}

  take(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    if (this.got >= this.n) return;
    const k = Math.min(this.n - this.got, chunk.length);
    this.buf.set(chunk.subarray(0, k), this.got);
    this.got += k;
  }
  head(): Uint8Array | null {
    return this.got >= this.n ? this.buf : null;
  }
  stream(): TransformStream<Uint8Array, Uint8Array> {
    return new TransformStream({
      transform: (chunk, ctl) => {
        this.take(chunk);
        ctl.enqueue(chunk);
      },
    });
  }
}

/** Test helper and reference writer: a minimal LTX v0.5 file (header + `pad` bytes + trailer). */
export function ltxFile(minTxid: number, maxTxid: number, pad = 64, pageSize = 4096): Uint8Array {
  const out = new Uint8Array(LTX_HEADER + pad + LTX_TRAILER);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, pageSize);
  dv.setUint32(12, 1);
  dv.setBigUint64(16, BigInt(minTxid));
  dv.setBigUint64(24, BigInt(maxTxid));
  dv.setBigUint64(32, BigInt(Date.UTC(2026, 9, 31)));
  return out;
}
