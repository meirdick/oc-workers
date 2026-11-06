// SigV4 header-signature check for ReplicaGate (spec §18.2). Port of image/test/fakes/gate-core.mjs
// verifySigV4 (5027 Litestream 0.5.17 requests verified "ok" in M1) to WebCrypto.
// Canonical request: method, URI-encoded path, sorted query, signed headers as received, payload hash =
// x-amz-content-sha256. Presigned query auth is not accepted (403 at the caller).
import { hex, hmacRaw, sha256Hex } from "./crypto";

export interface SigV4Auth {
  keyId: string;
  date: string; // yyyymmdd from the credential scope
  region: string;
  service: string;
  signed: string[];
  signature: string;
}

const AUTH_RE =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/;

export function parseAuth(h: string | null): SigV4Auth | null {
  const m = AUTH_RE.exec((h ?? "").trim());
  if (!m) return null;
  return {
    keyId: m[1] as string,
    date: m[2] as string,
    region: m[3] as string,
    service: m[4] as string,
    signed: (m[5] as string).split(";"),
    signature: m[6] as string,
  };
}

export const isPresigned = (q: URLSearchParams) =>
  q.has("X-Amz-Signature") || q.has("X-Amz-Credential") || q.has("X-Amz-Algorithm");

/** RFC 3986 encode as SigV4 needs. */
export const uriEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Canonical URI and query for a raw request target ("/bucket/key?x=y"). */
export function canonPathQuery(rawPathAndQuery: string): { path: string; query: string } {
  const u = new URL(rawPathAndQuery, "http://x");
  const path =
    u.pathname
      .split("/")
      .map((seg) => uriEncode(safeDecode(seg)))
      .join("/") || "/";
  const q = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  q.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return { path, query: q.map(([k, v]) => `${k}=${v}`).join("&") };
}

/** x-amz-date (yyyymmddThhmmssZ) → epoch ms, or NaN. */
export function amzDateMs(s: string | null | undefined): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s ?? "");
  if (!m) return Number.NaN;
  return Date.UTC(
    +(m[1] as string),
    +(m[2] as string) - 1,
    +(m[3] as string),
    +(m[4] as string),
    +(m[5] as string),
    +(m[6] as string),
  );
}

export async function signingKey(secret: string, date: string, region: string, service: string) {
  let k = await hmacRaw(`AWS4${secret}`, date);
  k = await hmacRaw(k, region);
  k = await hmacRaw(k, service);
  return hmacRaw(k, "aws4_request");
}

export interface VerifyIn {
  method: string;
  /** Path and query exactly as received (URL.pathname + URL.search). */
  rawPathAndQuery: string;
  /** Lower-case header map as received. */
  headers: Record<string, string>;
  auth: SigV4Auth;
  secret: string;
  /** Values tried for a signed `host` header when the received one does not verify (spec §18.2 guess). */
  hostCandidates?: string[];
}

export interface VerifyOut {
  ok: boolean;
  why: "ok" | "signature" | "no-payload-hash";
  host?: string;
}

/** Signature check. The payload hash is the declared x-amz-content-sha256 (the caller checks a hex hash). */
export async function verifySigV4(v: VerifyIn): Promise<VerifyOut> {
  const payloadHash = v.headers["x-amz-content-sha256"];
  if (!payloadHash) return { ok: false, why: "no-payload-hash" };
  const { path, query } = canonPathQuery(v.rawPathAndQuery);
  const scope = `${v.auth.date}/${v.auth.region}/${v.auth.service}/aws4_request`;
  const key = await signingKey(v.secret, v.auth.date, v.auth.region, v.auth.service);
  const hosts = [v.headers.host, ...(v.hostCandidates ?? [])].filter(
    (h, i, a): h is string => typeof h === "string" && a.indexOf(h) === i,
  );
  const tries = v.auth.signed.includes("host") && hosts.length ? hosts : [v.headers.host ?? ""];
  for (const host of tries) {
    const h: Record<string, string> = { ...v.headers, host };
    const canonHeaders = v.auth.signed
      .map(
        (n) =>
          `${n}:${String(h[n] ?? "")
            .trim()
            .replace(/\s+/g, " ")}\n`,
      )
      .join("");
    const creq = [v.method, path, query, canonHeaders, v.auth.signed.join(";"), payloadHash].join("\n");
    const sts = ["AWS4-HMAC-SHA256", v.headers["x-amz-date"] ?? "", scope, await sha256Hex(creq)].join("\n");
    const want = hex(await hmacRaw(key, sts));
    if (constEq(want, v.auth.signature)) return { ok: true, why: "ok", host };
  }
  return { ok: false, why: "signature" };
}

function constEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** Payload modes (spec §18.2). */
export type PayloadMode = "unsigned" | "streaming-unsigned-trailer" | "hex" | "signed-chunks" | "bad";
export function payloadMode(declared: string | undefined): PayloadMode {
  if (!declared) return "bad";
  if (declared === "UNSIGNED-PAYLOAD") return "unsigned";
  if (declared === "STREAMING-UNSIGNED-PAYLOAD-TRAILER") return "streaming-unsigned-trailer";
  if (/^STREAMING-/.test(declared)) return "signed-chunks";
  if (/^[0-9a-f]{64}$/.test(declared)) return "hex";
  return "bad";
}

/** Lower-case header map from a Headers object. */
export function headerMap(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => {
    o[k.toLowerCase()] = v;
  });
  return o;
}
