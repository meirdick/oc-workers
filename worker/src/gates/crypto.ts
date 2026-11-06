// WebCrypto helpers for the gates: HMAC-SHA256 hex, SHA-256 hex, constant-time compare, hex/b64.
// Keys follow docs/07-gate-contract.md §1 (domain-separated HMAC with key = bootSecret).
import { DOMAIN, replicaAccessKeyId, replicaKeyMessage } from "../core/contract";

const te = new TextEncoder();
export type Bytes = Uint8Array | ArrayBuffer | string;

export function u8(b: Bytes): Uint8Array {
  if (typeof b === "string") return te.encode(b);
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

export function hex(b: ArrayBuffer | Uint8Array): string {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of a) s += x.toString(16).padStart(2, "0");
  return s;
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hmacRaw(key: Bytes, msg: Bytes): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", u8(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, u8(msg)));
}

export async function hmacHex(key: Bytes, msg: Bytes): Promise<string> {
  return hex(await hmacRaw(key, msg));
}

export async function sha256Hex(b: Bytes): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", u8(b)));
}

/** Constant-time compare (length leak only). Empty strings never match. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** Hello proofs (gate §1). */
export const helloProof = (secret: string, challenge: string) =>
  hmacHex(secret, `${DOMAIN.hello}${challenge}`);
export const replicaHelloProof = (secret: string, challenge: string) =>
  hmacHex(secret, `${DOMAIN.replicaHello}${challenge}`);

/** Per-boot replica key pair (gate §1, spec §18.2): id ocrt-g<gen>-<iid>, secret HMAC hex. */
export async function replicaKey(bootSecret: string, gen: number, iid: string) {
  return { id: replicaAccessKeyId(gen, iid), secret: await hmacHex(bootSecret, replicaKeyMessage(gen, iid)) };
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Decoded byte length of a base64 string without decoding it. */
export function b64len(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/**
 * sec F5: hello priority. A caller that holds bootSecret (ocsup, root) may send `x-ocrt-hello-mac` =
 * HMAC(bootSecret, "oc-hello-mac\0" ‖ plane ‖ "\0" ‖ challenge). It proves the secret without sending it; a fake
 * gate learns a MAC over a random challenge in its own domain, no use as a proof or key. A valid MAC skips the
 * hello rate, so a uid-1000 hello flood through the replica proxy cannot starve ocsup's proofs.
 */
export const HELLO_MAC_HEADER = "x-ocrt-hello-mac";
export const helloMac = (secret: string, plane: "control" | "replica", challenge: string) =>
  hmacHex(secret, `oc-hello-mac\0${plane}\0${challenge}`);
export async function helloMacOk(
  secret: string,
  plane: "control" | "replica",
  challenge: string,
  mac: string | null,
): Promise<boolean> {
  if (!mac || !/^[0-9a-f]{64}$/.test(mac)) return false;
  return safeEqual(mac, await helloMac(secret, plane, challenge));
}
