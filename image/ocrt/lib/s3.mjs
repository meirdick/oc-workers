// Minimal S3 client: SigV4 signer, ListObjectsV2, CreateBucket. No deps.
import { createHash, createHmac } from "node:crypto";

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

// RFC 3986 encode, as SigV4 needs.
export const uriEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Sign a request with AWS SigV4. Returns the headers to send (incl. authorization).
 * s3: true adds x-amz-content-sha256 (S3 needs it; the generic test suite does not use it).
 */
export function signV4({
  method,
  url,
  region,
  service = "s3",
  accessKey,
  secretKey,
  body = "",
  headers = {},
  now = new Date(),
  s3 = true,
}) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v);
  h.host = u.host;
  h["x-amz-date"] = amzDate;
  if (s3) h["x-amz-content-sha256"] = payloadHash;
  const names = Object.keys(h).sort();
  const signedHeaders = names.join(";");
  const canonHeaders = names.map((k) => `${k}:${h[k].trim().replace(/\s+/g, " ")}\n`).join("");
  const q = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)]);
  q.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonQuery = q.map(([k, v]) => `${k}=${v}`).join("&");
  const canonPath = u.pathname
    .split("/")
    .map((seg) => uriEncode(decodeURIComponent(seg)))
    .join("/");
  const creq = [method, canonPath || "/", canonQuery, canonHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(creq)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), "aws4_request");
  const sig = createHmac("sha256", kSigning).update(sts).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  delete h.host;
  return h;
}

const base = (cfg) => `${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}`;

async function s3fetch(cfg, method, url, { body = "", timeoutMs = 10_000 } = {}) {
  const headers = signV4({
    method,
    url,
    region: cfg.region,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    body,
  });
  return fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
const xmlUnescape = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** List all keys under prefix (ListObjectsV2). Throws on a non-2xx status. */
export async function listKeys(cfg, prefix, { max = 100_000 } = {}) {
  const keys = [];
  let token;
  do {
    const u = new URL(base(cfg));
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    if (token) u.searchParams.set("continuation-token", token);
    const r = await s3fetch(cfg, "GET", u.toString());
    const text = await r.text();
    if (!r.ok) throw new Error(`s3 list ${r.status}: ${text.slice(0, 200)}`);
    for (const k of xmlAll(text, "Key")) keys.push(xmlUnescape(k));
    token = /<IsTruncated>true<\/IsTruncated>/.test(text)
      ? xmlAll(text, "NextContinuationToken")[0]
      : undefined;
  } while (token && keys.length < max);
  return keys;
}

/** Create the bucket. 409 (exists) counts as success. */
export async function createBucket(cfg) {
  const r = await s3fetch(cfg, "PUT", base(cfg));
  const text = await r.text();
  if (!r.ok && r.status !== 409) throw new Error(`s3 create-bucket ${r.status}: ${text.slice(0, 200)}`);
  return r.status;
}

/**
 * Map Litestream 0.5 replica keys to DB relpaths.
 * Key form (seen on 0.5.17): <prefix><relpath>/<level, 4 digits>/<minTXID>-<maxTXID>.ltx  ->  <relpath>
 */
const LTX = /^(.+)\/\d{4}\/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/;
export function dbRelpathsFromKeys(keys, prefix) {
  const out = new Set();
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue;
    const m = LTX.exec(k.slice(prefix.length));
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}
