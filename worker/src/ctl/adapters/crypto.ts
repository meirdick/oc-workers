// WebCrypto helpers for the adapters: HMAC-SHA256 hex, HMAC-SHA1 base64, Ed25519 verify, constant-time compare.
const enc = new TextEncoder();

async function hmac(hash: "SHA-256" | "SHA-1", key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

export async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  return [...(await hmac("SHA-256", key, msg))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha1B64(key: string, msg: string): Promise<string> {
  return btoa(String.fromCharCode(...(await hmac("SHA-1", key, msg))));
}

export function hexBytes(h: string): Uint8Array<ArrayBuffer> | null {
  if (h.length % 2 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Discord: Ed25519 over timestamp + body. A malformed key or signature is a failed check, not a throw. */
export async function ed25519Verify(pubHex: string, sigHex: string, msg: string): Promise<boolean> {
  const pub = hexBytes(pubHex);
  const sig = hexBytes(sigHex);
  if (!pub || !sig || pub.length !== 32 || sig.length !== 64) return false;
  try {
    const k = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, sig, enc.encode(msg));
  } catch {
    return false;
  }
}

/** Constant-time string compare (length leaks, content does not). */
export function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
