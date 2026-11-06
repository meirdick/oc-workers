// Incremental SHA-256 with a state that survives JSON (spec §17.2 /v1/archive/*: the gate hashes parts in
// order and keeps the hash state in the Control DO between parts; WebCrypto has no incremental digest).
// State: {h: 8 words, tail: hex of < 64 pending bytes, n: total bytes}.

export interface ShaState {
  h: number[];
  tail: string;
  n: number;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export function shaInit(): ShaState {
  return { h: [...H0], tail: "", n: 0 };
}

const W = new Uint32Array(64);
function blocks(h: Uint32Array, b: Uint8Array, off: number, end: number): void {
  for (let p = off; p + 64 <= end; p += 64) {
    for (let i = 0; i < 16; i++) {
      const j = p + i * 4;
      W[i] =
        ((b[j] as number) << 24) |
        ((b[j + 1] as number) << 16) |
        ((b[j + 2] as number) << 8) |
        (b[j + 3] as number);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15] as number;
      const w2 = W[i - 2] as number;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = ((W[i - 16] as number) + s0 + (W[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let bb = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (W[i] as number)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + bb;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }
}

function fromHex(s: string): Uint8Array {
  const o = new Uint8Array(s.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return o;
}
function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Returns a new state; the input state is not changed. */
export function shaUpdate(st: ShaState, data: Uint8Array): ShaState {
  const h = Uint32Array.from(st.h);
  const tail = fromHex(st.tail);
  let buf: Uint8Array;
  if (tail.length) {
    buf = new Uint8Array(tail.length + data.length);
    buf.set(tail);
    buf.set(data, tail.length);
  } else buf = data;
  const full = buf.length - (buf.length % 64);
  blocks(h, buf, 0, full);
  return { h: [...h], tail: toHex(buf.subarray(full)), n: st.n + data.length };
}

export function shaDigest(st: ShaState): string {
  const tail = fromHex(st.tail);
  const padLen = tail.length < 56 ? 64 : 128;
  const b = new Uint8Array(padLen);
  b.set(tail);
  b[tail.length] = 0x80;
  const bits = st.n * 8;
  const hi = Math.floor(bits / 0x100000000);
  const lo = bits >>> 0;
  const dv = new DataView(b.buffer);
  dv.setUint32(padLen - 8, hi);
  dv.setUint32(padLen - 4, lo);
  const h = Uint32Array.from(st.h);
  blocks(h, b, 0, padLen);
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i] as number);
  return toHex(out);
}
