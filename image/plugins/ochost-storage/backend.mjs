// Storage backend `ochost-r2` (docs/11 §8): the OpenClaw StorageBackend contract over the S3 subset of the oc-host
// ReplicaGate (files key space f/<inst>/). No dependency: a small SigV4 signer and fetch. No OpenClaw import, so the
// node tests load this file alone.
// Credentials: the per-gen gate key that ocsup writes for uid 1000 (keyFile, default /run/ocrt/files-key.json). It is
// not a secret in openclaw.json; the gate limits it to this install's prefixes and to the current gen.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export const PROVIDER_ID = "ochost-r2";
export const DEFAULTS = Object.freeze({
  endpoint: "http://127.0.0.1:18792",
  keyFile: "/run/ocrt/files-key.json",
});
/** The gate refuses a body above settings files.maxObjectMb (max 100 MB); the plugin stops reading there too. */
export const MAX_OBJECT_BYTES = 100_000_000;
const TIMEOUT_MS = 120_000;
const SEG = /^[A-Za-z0-9._-]+$/;

class OchostStorageError extends Error {}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();
const uriEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** SigV4 header signature (path style, region auto, UNSIGNED-PAYLOAD). Returns the headers to send. */
export function sign({ method, url, accessKeyId, secretAccessKey, headers = {}, now = new Date() }) {
  const u = new URL(url);
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amz.slice(0, 8);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v);
  h.host = u.host;
  h["x-amz-date"] = amz;
  h["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
  const names = Object.keys(h).sort();
  const q = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)]);
  q.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const path = u.pathname
    .split("/")
    .map((s) => uriEncode(decodeURIComponent(s)))
    .join("/");
  const creq = [
    method,
    path || "/",
    q.map(([k, v]) => `${k}=${v}`).join("&"),
    names.map((k) => `${k}:${h[k].trim().replace(/\s+/g, " ")}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amz, scope, sha256hex(creq)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), "auto"), "s3"), "aws4_request");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", key).update(sts).digest("hex")}`;
  delete h.host;
  return h;
}

/** null when the settings are usable, else a user-facing message. */
export function validateSettings(s) {
  if (!s || typeof s !== "object") return "ochost-r2 settings must be an object.";
  const extra = Object.keys(s).filter((k) => !["endpoint", "bucket", "prefix", "keyFile"].includes(k));
  if (extra.length) return `ochost-r2 settings only accept endpoint, bucket, prefix and keyFile (got ${extra[0]}).`;
  if (typeof s.bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(s.bucket))
    return "ochost-r2 bucket must be 3-63 lowercase letters, digits or hyphens.";
  if (typeof s.prefix !== "string" || !s.prefix || !s.prefix.split("/").every((p) => SEG.test(p) && p !== "." && p !== ".."))
    return "ochost-r2 prefix must be key-safe segments without leading or trailing /, such as f/<inst>.";
  if (s.endpoint !== undefined && (typeof s.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(s.endpoint)))
    return "ochost-r2 endpoint must be the loopback forwarder, such as http://127.0.0.1:18792.";
  if (s.keyFile !== undefined && (typeof s.keyFile !== "string" || !s.keyFile.startsWith("/")))
    return "ochost-r2 keyFile must be an absolute path.";
  return undefined;
}

export const describeTarget = (s) =>
  validateSettings(s) ? undefined : `r2://${s.bucket}/${s.prefix} (oc-host gate)`;

const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** One S3 error message for the user: the gate's own <Code> and <Message> (no credential in them). */
async function failure(res, op) {
  const t = await res.text().catch(() => "");
  const code = xmlAll(t, "Code")[0];
  const msg = xmlAll(t, "Message")[0];
  if (res.status === 412) return new OchostStorageError("Object already exists; use a new name.");
  if (code === "StorageCapExceeded" || code === "EntityTooLarge")
    return new OchostStorageError(`R2 ${op} refused: ${unesc(msg ?? code)}. The owner can raise it with \`ochost config set ${code === "EntityTooLarge" ? "files.maxObjectMb" : "files.capGb"} <n>\`.`);
  if (res.status === 409 && code === "Stale")
    return new OchostStorageError(`R2 ${op} refused: the gate key is from an older boot; retry after the restart.`);
  return new OchostStorageError(`R2 ${op} failed (${res.status}${code ? ` ${code}` : ""}${msg ? `: ${unesc(msg)}` : ""}).`);
}

/** createBackend(settings, {fetch?, readKey?, now?}) → StorageBackend. */
export function createBackend(settings, o = {}) {
  const bad = validateSettings(settings);
  if (bad) throw new OchostStorageError(bad);
  const f = o.fetch ?? fetch;
  const endpoint = (settings.endpoint ?? DEFAULTS.endpoint).replace(/\/+$/, "");
  const keyFile = settings.keyFile ?? DEFAULTS.keyFile;
  const readKey =
    o.readKey ??
    (() => {
      let k;
      try {
        k = JSON.parse(readFileSync(keyFile, "utf8"));
      } catch {
        throw new OchostStorageError(`File storage key ${keyFile} is missing; the oc-host runtime writes it at boot.`);
      }
      if (!k?.accessKeyId || !k?.secretAccessKey) throw new OchostStorageError(`File storage key ${keyFile} is not valid.`);
      return k;
    });
  const namespace = `${settings.prefix}/`;
  const objUrl = (key) => `${endpoint}/${settings.bucket}/${(namespace + key).split("/").map(uriEncode).join("/")}`;
  async function call(method, url, { headers = {}, body, signal } = {}) {
    const k = readKey(); // per request: a new boot writes a new key, and the gateway may outlive nothing else
    const h = sign({ method, url, accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, headers, now: (o.now ?? (() => new Date()))() });
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    return f(url, { method, headers: h, body, signal: sig });
  }
  async function* pages(prefix, signal) {
    let token;
    do {
      const u = new URL(`${endpoint}/${settings.bucket}`);
      u.searchParams.set("list-type", "2");
      u.searchParams.set("prefix", namespace + prefix);
      if (token) u.searchParams.set("continuation-token", token);
      const r = await call("GET", u.toString(), { signal });
      if (!r.ok) throw await failure(r, "list");
      const xml = await r.text();
      yield xml;
      const next = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlAll(xml, "NextContinuationToken")[0] : undefined;
      if (next !== undefined && unesc(next) === token) throw new OchostStorageError("R2 list did not advance; retry.");
      token = next === undefined ? undefined : unesc(next);
    } while (token);
  }
  return {
    displayTarget: describeTarget(settings),
    async probe(opts) {
      for await (const _ of pages("", opts?.signal)) break;
      return {};
    },
    async putObject(key, body, opts = {}) {
      opts.signal?.throwIfAborted();
      if (opts.sizeBytes !== undefined && opts.sizeBytes > MAX_OBJECT_BYTES)
        throw new OchostStorageError(`Object is above ${MAX_OBJECT_BYTES} bytes; split it.`);
      const chunks = [];
      let n = 0;
      for await (const c of body) {
        opts.signal?.throwIfAborted();
        n += c.byteLength;
        if (n > MAX_OBJECT_BYTES) throw new OchostStorageError(`Object is above ${MAX_OBJECT_BYTES} bytes; split it.`);
        chunks.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
      }
      if (opts.sizeBytes !== undefined && opts.sizeBytes !== n)
        throw new OchostStorageError("Object does not match its declared size.");
      // Never overwrite (storage contract): If-None-Match: * → the gate answers 412 on an existing key.
      const r = await call("PUT", objUrl(key), {
        headers: { "content-length": String(n), "if-none-match": "*" },
        body: Buffer.concat(chunks, n),
        signal: opts.signal,
      });
      if (!r.ok) throw await failure(r, "upload");
      await r.arrayBuffer().catch(() => undefined);
      return { sizeBytes: n };
    },
    async getObject(key, opts) {
      const r = await call("GET", objUrl(key), { signal: opts?.signal });
      if (r.status === 404) {
        await r.arrayBuffer().catch(() => undefined);
        return undefined;
      }
      if (!r.ok || !r.body) throw await failure(r, "download");
      const stream = r.body;
      return (async function* () {
        for await (const c of stream) yield c instanceof Uint8Array ? c : new Uint8Array(c);
      })();
    },
    async statObject(key, opts) {
      const r = await call("HEAD", objUrl(key), { signal: opts?.signal });
      if (r.status === 404) return undefined;
      if (!r.ok) throw new OchostStorageError(`R2 stat failed (${r.status}).`);
      const lm = r.headers.get("last-modified");
      return {
        key,
        sizeBytes: Number(r.headers.get("content-length") ?? 0),
        ...(lm ? { modifiedAt: Date.parse(lm) } : {}),
      };
    },
    async *listObjects(prefix, opts) {
      for await (const xml of pages(prefix, opts?.signal))
        for (const [, c] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const k = unesc(xmlAll(c, "Key")[0] ?? "");
          if (!k.startsWith(namespace + prefix)) throw new OchostStorageError("R2 list returned a key outside the prefix.");
          const lm = xmlAll(c, "LastModified")[0];
          yield {
            key: k.slice(namespace.length),
            sizeBytes: Number(xmlAll(c, "Size")[0] ?? 0),
            ...(lm ? { modifiedAt: Date.parse(lm) } : {}),
          };
        }
    },
    async deleteObject(key, opts) {
      const r = await call("DELETE", objUrl(key), { signal: opts?.signal });
      if (!r.ok && r.status !== 404) throw await failure(r, "delete");
      await r.arrayBuffer().catch(() => undefined);
    },
    async close() {},
  };
}
