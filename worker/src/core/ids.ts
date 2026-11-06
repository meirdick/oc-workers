// ULIDs and op ids (spec §7.1, cf-orbs journal.ts hashInputs).

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms time + 80 random bits, Crockford base32. Monotonic within one isolate. */
let lastMs = -1;
let lastRand: number[] = [];
export function ulid(now: number = Date.now()): string {
  let rand: number[];
  if (now === lastMs) {
    rand = [...lastRand];
    for (let i = rand.length - 1; i >= 0; i--) {
      rand[i] = ((rand[i] as number) + 1) % 32;
      if (rand[i] !== 0) break;
    }
  } else {
    const b = crypto.getRandomValues(new Uint8Array(16));
    rand = [...b].map((x) => x % 32);
  }
  lastMs = now;
  lastRand = rand;
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = B32[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  return t + rand.map((x) => B32[x]).join("");
}

export async function sha256Hex(s: string | Uint8Array): Promise<string> {
  const data = typeof s === "string" ? new TextEncoder().encode(s) : s;
  const h = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(h));
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** 32 random bytes, hex (boot secrets). */
export function randomHex(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Op id = sha256(kind, args, minute bucket), first 32 hex (cf-orbs journal.ts:30). Same inputs in one minute share an op. */
export async function hashInputs(kind: string, args: unknown, now: number): Promise<string> {
  const bucket = Math.floor(now / 60_000);
  return (await sha256Hex(JSON.stringify([kind, args ?? null, bucket]))).slice(0, 32);
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return toHex(new Uint8Array(sig));
}

/** Constant-time string compare (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
