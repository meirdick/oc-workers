// Vitest setup: back crypto.subtle HMAC-SHA256 and SHA-256 digest with sync node:crypto, so they
// resolve as microtasks. WebCrypto in Node resolves on the thread pool, which fake timers cannot
// drive; without this a fake-time advance runs ahead of every gate HMAC. Other algorithms fall
// through to the real implementation.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const subtle = (globalThis as unknown as { crypto: Crypto }).crypto.subtle;
type KeyUsage = Parameters<SubtleCrypto["importKey"]>[4][number];
type AlgorithmIdentifier = Parameters<SubtleCrypto["digest"]>[0];
const orig = {
  importKey: subtle.importKey.bind(subtle),
  sign: subtle.sign.bind(subtle),
  verify: subtle.verify.bind(subtle),
  digest: subtle.digest.bind(subtle),
};
const RAW = Symbol("rawHmacKey");
type K = CryptoKey & { [RAW]?: Buffer };

const buf = (d: BufferSource): Buffer =>
  d instanceof ArrayBuffer
    ? Buffer.from(d)
    : Buffer.from(
        (d as ArrayBufferView).buffer,
        (d as ArrayBufferView).byteOffset,
        (d as ArrayBufferView).byteLength,
      );
const ab = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const algName = (a: unknown) => (typeof a === "string" ? a : (a as { name: string }).name).toUpperCase();
const hashName = (a: unknown) => {
  const h = (a as { hash?: unknown }).hash;
  return h ? algName(h) : "SHA-256";
};

Object.assign(subtle, {
  importKey(format: string, data: BufferSource, alg: unknown, ext: boolean, uses: KeyUsage[]) {
    if (format === "raw" && algName(alg) === "HMAC" && hashName(alg) === "SHA-256") {
      const k = {
        type: "secret",
        extractable: ext,
        algorithm: { name: "HMAC", hash: { name: "SHA-256" } },
        usages: uses,
      } as K;
      k[RAW] = Buffer.from(buf(data));
      return Promise.resolve(k);
    }
    return orig.importKey(format as "raw", data, alg as AlgorithmIdentifier, ext, uses);
  },
  sign(alg: unknown, key: K, data: BufferSource) {
    if (key[RAW]) return Promise.resolve(ab(createHmac("sha256", key[RAW]).update(buf(data)).digest()));
    return orig.sign(alg as AlgorithmIdentifier, key, data);
  },
  verify(alg: unknown, key: K, sig: BufferSource, data: BufferSource) {
    if (key[RAW]) {
      const want = createHmac("sha256", key[RAW]).update(buf(data)).digest();
      const got = buf(sig);
      return Promise.resolve(got.length === want.length && timingSafeEqual(got, want));
    }
    return orig.verify(alg as AlgorithmIdentifier, key, sig, data);
  },
  digest(alg: unknown, data: BufferSource) {
    const n = algName(alg);
    if (n === "SHA-256" || n === "SHA-1" || n === "SHA-512")
      return Promise.resolve(ab(createHash(n.replace("-", "").toLowerCase()).update(buf(data)).digest()));
    return orig.digest(alg as AlgorithmIdentifier, data);
  },
});
