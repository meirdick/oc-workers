// ReplicaGate at 15.0.0.2:80 (spec §18, gate contract §7): the S3 subset Litestream 0.5.17 uses, served from
// the R2 binding. Path style /<bucket>/<key>. Order: hello → SigV4 parse (presigned 403, key form, gen 409) →
// date skew → payload mode → current gen + bound iid (Control DO, uncached; other iid 409) → signature with
// the derived per-boot key (403) → bucket → replicaAccess() → ceiling, reseed guard → R2 → record → answer.
import { REPLICA_HELLO_PATH, replicaAccess, s3OpOf } from "../core/contract";
import { awsChunkedDecoder } from "./chunked";
import { helloAllowed } from "./control";
import { HELLO_MAC_HEADER, replicaHelloProof, replicaKey, sha256Hex } from "./crypto";
import { HeadTap, LTX_HEADER, type LtxCheck, parseLtxHeader } from "./ltx";
import {
  completeXml,
  deleteResult,
  etagQ,
  initiateXml,
  listXml,
  parseDelete,
  parseParts,
  parseRange,
  s3Error,
} from "./s3xml";
import { amzDateMs, headerMap, isPresigned, parseAuth, payloadMode, verifySigV4 } from "./sigv4";
import type { GateDeps } from "./types";

export const SKEW_MS = 15 * 60_000;
/** Host values tried for the signed `host` header (spec §18.2 guess, L-2): as received, then the proxy's. */
export const PROXY_HOST = "127.0.0.1:18790";
const KEY_RE = /^ocrt-g(\d+)-([0-9a-f]{32})$/;

interface Ctx {
  d: GateDeps;
  op: string;
  key: string;
  status?: number;
  /** LTX header check of the written object (sec F1/F3). */
  ltx?: LtxCheck;
}

/** sec F7: flush the isolate's bad-signature count to the Control DO at most this often. */
export const BADSIG_FLUSH_MS = 10_000;

/** Result of the auth stage, or a Response to send. */
type Mode = ReturnType<typeof payloadMode>;
interface KeyOk {
  mode: Mode;
  kIid: string;
  auth: NonNullable<ReturnType<typeof parseAuth>>;
}

/** Checks that need no Control DO call: presigned, header form, key form and gen, date skew, payload mode. */
function parseKey(url: URL, h: Record<string, string>, d: GateDeps): Response | KeyOk {
  const P = d.props;
  const res = url.pathname;
  if (isPresigned(url.searchParams))
    return s3Error(403, "AccessDenied", "presigned requests are not accepted", res);
  const auth = parseAuth(h.authorization ?? null);
  if (!auth) return s3Error(403, "AccessDenied", "SigV4 header signature required", res);
  const km = KEY_RE.exec(auth.keyId);
  if (!km) return s3Error(403, "InvalidAccessKeyId", "unknown access key id", res);
  const kGen = Number(km[1]);
  if (kGen !== P.gen) return s3Error(409, "Stale", `key of gen ${kGen}, gate gen ${P.gen}`, res);
  const t = amzDateMs(h["x-amz-date"]);
  if (!Number.isFinite(t) || Math.abs(t - d.now()) > SKEW_MS || h["x-amz-date"]?.slice(0, 8) !== auth.date)
    return s3Error(403, "RequestTimeTooSkewed", "x-amz-date outside ±15 min", res);
  const mode = payloadMode(h["x-amz-content-sha256"]);
  if (mode === "signed-chunks")
    return s3Error(501, "NotImplemented", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD is not supported", res);
  if (mode === "bad") return s3Error(400, "InvalidRequest", "x-amz-content-sha256 missing or unknown", res);
  return { mode, kIid: km[2] as string, auth };
}

/**
 * Signature with the per-boot key of the key's iid (spec §18.2). The key is HMAC(bootSecret, gen, iid), so no
 * Control DO call is needed to check it (sec F7): a request without the key costs one HMAC and no DO work. The
 * bound-iid check comes after (other iid → 409). Bad signatures are counted per isolate and flushed in a batch.
 */
async function checkSig(req: Request, url: URL, h: Record<string, string>, k: KeyOk, d: GateDeps) {
  const P = d.props;
  const { secret } = await replicaKey(P.bootSecret, P.gen, k.kIid);
  const v = await verifySigV4({
    method: req.method,
    rawPathAndQuery: `${url.pathname}${url.search}`,
    headers: h,
    auth: k.auth,
    secret,
    hostCandidates: [url.host, PROXY_HOST],
  });
  if (v.ok) return null;
  const now = d.now();
  const c = d.cache.badSig.get(P.gen) ?? { n: 0, flushedAt: 0 };
  c.n++;
  d.cache.badSig.set(P.gen, c);
  if (now - c.flushedAt >= BADSIG_FLUSH_MS) {
    const n = c.n;
    c.n = 0;
    c.flushedAt = now;
    const p = d.ctl.badSig(P.gen, n).catch(() => undefined);
    if (d.waitUntil) d.waitUntil(p);
    else await p;
  }
  return s3Error(403, "SignatureDoesNotMatch", "signature does not match", url.pathname);
}

export async function handleReplicaGate(req: Request, d: GateDeps): Promise<Response> {
  const url = new URL(req.url);
  const P = d.props;
  if (req.method === "POST" && url.pathname === REPLICA_HELLO_PATH) {
    const b = (await req.json().catch(() => null)) as { challenge?: unknown } | null;
    if (typeof b?.challenge !== "string" || !/^[0-9a-f]{32,128}$/.test(b.challenge))
      return Response.json({ error: "shape" }, { status: 400 });
    const challenge = (b as { challenge: string }).challenge;
    if (!(await helloAllowed(d, "replica", { challenge, mac: req.headers.get(HELLO_MAC_HEADER) })))
      return Response.json({ error: "rate" }, { status: 429 });
    return Response.json({ proof: await replicaHelloProof(P.bootSecret, challenge) });
  }
  const h = headerMap(req.headers);
  const a = parseKey(url, h, d);
  if (a instanceof Response) return a;
  const kIid = a.kIid;
  const bad = await checkSig(req, url, h, a, d);
  if (bad) return bad;

  const segs = url.pathname.split("/").slice(1);
  let bucketName = "";
  let key = "";
  try {
    bucketName = decodeURIComponent(segs[0] ?? "");
    key = segs.length > 1 ? segs.slice(1).map(decodeURIComponent).join("/") : "";
  } catch {
    return s3Error(400, "InvalidURI", "bad path encoding", url.pathname);
  }
  const op = s3OpOf(req.method, url.searchParams);
  if (!op)
    return s3Error(
      501,
      "NotImplemented",
      `${req.method} ${url.search} is not in the S3 subset`,
      url.pathname,
    );
  const acc = replicaAccess(P, op, key || null, url.searchParams.get("prefix"));
  if (!acc.allow && acc.status === 501) return s3Error(501, "NotImplemented", op, url.pathname);
  const write = acc.scope === "write";

  // Current gen + bound iid (uncached; every write must see it, spec §18.3), tier, ceiling, reseed guard.
  let pre: Awaited<ReturnType<GateDeps["ctl"]["replicaPre"]>>;
  try {
    pre = await d.ctl.replicaPre({ epoch: P.epoch, gen: P.gen, op, write, key: key || null });
  } catch {
    return s3Error(503, "ServiceUnavailable", "ctl-unavailable", url.pathname);
  }
  if (pre.r2Down) return s3Error(503, "ServiceUnavailable", "r2-down (test fault)", url.pathname);
  if (pre.slowMs && write) await new Promise((r) => setTimeout(r, pre.slowMs));
  if (!pre.current)
    return s3Error(409, "Stale", `gen ${P.gen} is not current (${pre.why ?? "?"})`, url.pathname);
  if (!pre.iid) return s3Error(403, "AccessDenied", "no iid bound for this gen yet", url.pathname);
  if (pre.iid !== kIid) return s3Error(409, "Stale", "key of another instance id", url.pathname);
  if (bucketName !== d.bucketName) return s3Error(404, "NoSuchBucket", `bucket ${bucketName}`, url.pathname);
  if (!acc.allow) return s3Error(403, "AccessDenied", `access: ${acc.why}`, key || url.pathname);
  // S75 (spec §18.3): a write needs prod in the props (replicaAccess) and in the Control DO's gen row.
  if (write && pre.mode && pre.mode !== "prod")
    return s3Error(403, "AccessDenied", `access: mode ${pre.mode}`, key || url.pathname);
  if (pre.limited) {
    const r = s3Error(429, "SlowDown", `per-boot replica budget: ${pre.limited.why}`, key || url.pathname);
    r.headers.set("retry-after", String(pre.limited.retryAfterS));
    return r;
  }
  if (write && pre.ceiling) return s3Error(503, "SlowDown", "daily replica ceiling reached", key);
  if (pre.reseed) return s3Error(409, "Reseed", "second TXID-1 level-0 key in this gen", key);

  const c: Ctx = { d, op, key };
  let res: Response;
  let bytes: number | undefined;
  try {
    const out = await serve(req, url, h, a.mode, c, acc.checkEach);
    res = out.res;
    bytes = out.bytes;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res = /NoSuchUpload|upload.*not.*found|does not exist/i.test(msg)
      ? s3Error(404, "NoSuchUpload", msg, key)
      : s3Error(500, "InternalError", msg, key);
  }
  if (c.status === -1) return res; // answered before R2 (refused); not counted
  if (c.op === "CompleteMultipartUpload" && res.status >= 200 && res.status < 300) c.ltx = await headOf(c);
  await post(c, res.status, bytes);
  return res;
}

/** LTX header of a completed multipart object: one ranged R2 read of the first 100 bytes (sec F1/F3). */
async function headOf(c: Ctx): Promise<LtxCheck> {
  try {
    const o = await c.d.bucket.get(c.key, { range: { offset: 0, length: LTX_HEADER } });
    if (!o) return { ok: false, why: "gone" };
    const head = new Uint8Array(await o.arrayBuffer());
    return parseLtxHeader(head.subarray(0, LTX_HEADER), o.size);
  } catch (e) {
    return { ok: false, why: `read: ${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
}

/** Count the request and record a completed upload; retry the record 3× (spec §18.4). */
async function post(c: Ctx, status: number, bytes?: number): Promise<void> {
  const { d } = c;
  for (let i = 0; i < 3; i++) {
    try {
      await d.ctl.replicaPost({
        gen: d.props.gen,
        op: c.op,
        status,
        key: c.key || null,
        bytes,
        ltx: c.ltx ?? null,
      });
      return;
    } catch {
      // retry
    }
  }
  if (status >= 200 && status < 300 && (c.op === "PutObject" || c.op === "CompleteMultipartUpload"))
    await d.ctl.alert("replica-record-lost", "high", c.key).catch(() => undefined);
}

function refused(c: Ctx, r: Response): { res: Response } {
  c.status = -1;
  return { res: r };
}

async function serve(
  req: Request,
  url: URL,
  h: Record<string, string>,
  mode: Mode,
  c: Ctx,
  checkEach?: string,
): Promise<{ res: Response; bytes?: number }> {
  const { d, op, key } = c;
  const b = d.bucket;
  const q = url.searchParams;
  switch (op) {
    case "ListObjectsV2": {
      const prefix = q.get("prefix") ?? "";
      const max = Math.min(Math.max(Number(q.get("max-keys") ?? "1000") || 1000, 1), 1000);
      const token = q.get("continuation-token") ?? undefined;
      const delimiter = q.get("delimiter") ?? undefined;
      const startAfter = q.get("start-after") ?? undefined;
      const r = await b.list({
        prefix,
        cursor: token,
        limit: max,
        delimiter,
        startAfter: token ? undefined : startAfter,
      });
      return {
        res: listXml({
          bucket: d.bucketName,
          prefix,
          max,
          delimiter,
          urlEnc: q.get("encoding-type") === "url",
          token,
          startAfter,
          objects: r.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded })),
          prefixes: r.delimitedPrefixes ?? [],
          truncated: r.truncated,
          next: r.truncated ? r.cursor : undefined,
        }),
      };
    }
    case "HeadObject": {
      const o = await b.head(key);
      if (!o) return { res: new Response(null, { status: 404 }) };
      return { res: new Response(null, { status: 200, headers: objHeaders(o, o.size) }) };
    }
    case "GetObject": {
      const range = parseRange(h.range ?? null);
      if (range === "bad") return { res: s3Error(416, "InvalidRange", "bad range", key) };
      const o = await b.get(key, range ? { range } : undefined);
      if (!o) return { res: s3Error(404, "NoSuchKey", "no such key", key) };
      if (!range)
        return { res: new Response(o.body, { status: 200, headers: objHeaders(o, o.size) }), bytes: o.size };
      let offset: number;
      let length: number;
      if ("suffix" in range) {
        length = Math.min(range.suffix, o.size);
        offset = o.size - length;
      } else {
        offset = range.offset;
        length = Math.min(range.length ?? o.size - offset, o.size - offset);
      }
      if (offset >= o.size) return { res: s3Error(416, "InvalidRange", "range not satisfiable", key) };
      const hd = objHeaders(o, length);
      hd["content-range"] = `bytes ${offset}-${offset + length - 1}/${o.size}`;
      return { res: new Response(o.body, { status: 206, headers: hd }), bytes: length };
    }
    case "PutObject":
    case "UploadPart": {
      if (h["x-amz-copy-source"])
        return refused(c, s3Error(501, "NotImplemented", "copy is not supported", key));
      const tap = op === "PutObject" ? new HeadTap() : null;
      const body = await readBody(req, h, mode, tap);
      if (body === "mismatch")
        return refused(c, s3Error(400, "XAmzContentSHA256Mismatch", "payload hash does not match", key));
      if (op === "UploadPart") {
        const part = await b
          .resumeMultipartUpload(key, q.get("uploadId") as string)
          .uploadPart(Number(q.get("partNumber")), body.value);
        return {
          res: new Response(null, { status: 200, headers: { etag: etagQ(part.etag) } }),
          bytes: body.bytes,
        };
      }
      const o = await b.put(key, body.value);
      if (tap) c.ltx = parseLtxHeader(tap.head(), tap.bytes);
      return {
        res: new Response(null, { status: 200, headers: { etag: etagQ(o?.etag ?? "") } }),
        bytes: body.bytes,
      };
    }
    case "CreateMultipartUpload": {
      const u = await b.createMultipartUpload(key);
      return { res: initiateXml(d.bucketName, key, u.uploadId) };
    }
    case "CompleteMultipartUpload": {
      const parts = parseParts(await req.text());
      if (parts.length === 0) return refused(c, s3Error(400, "MalformedXML", "no parts", key));
      const o = await b.resumeMultipartUpload(key, q.get("uploadId") as string).complete(parts);
      return { res: completeXml(d.bucketName, key, o.etag), bytes: o.size };
    }
    case "AbortMultipartUpload": {
      await b.resumeMultipartUpload(key, q.get("uploadId") as string).abort();
      return { res: new Response(null, { status: 204 }) };
    }
    case "DeleteObject": {
      const { allow } = await d.ctl.deleteCheck(d.props.gen, [key]);
      if (!allow[0])
        return refused(c, s3Error(403, "AccessDenied", "delete refused: key not covered (§18.5)", key));
      await b.delete(key);
      await d.ctl.deleteDone(d.props.gen, [key]);
      return { res: new Response(null, { status: 204 }) };
    }
    case "DeleteObjects": {
      const { keys, quiet } = parseDelete(await req.text());
      if (keys.length === 0 || keys.length > 1000)
        return refused(c, s3Error(400, "MalformedXML", "1-1000 keys", url.pathname));
      const own = keys.filter((k) => checkEach && k.startsWith(checkEach));
      const { allow } = own.length ? await d.ctl.deleteCheck(d.props.gen, own) : { allow: [] as boolean[] };
      const ok = own.filter((_, i) => allow[i]);
      const errors = keys
        .filter((k) => !ok.includes(k))
        .map((k) => ({
          key: k,
          code: "AccessDenied",
          message: own.includes(k) ? "delete refused: key not covered" : "key outside the current gen",
        }));
      if (ok.length) {
        await b.delete(ok);
        await d.ctl.deleteDone(d.props.gen, ok);
      }
      return { res: deleteResult(quiet, ok, errors) };
    }
  }
  return refused(c, s3Error(501, "NotImplemented", op, key));
}

function objHeaders(o: R2Object, len: number): Record<string, string> {
  return {
    etag: etagQ(o.etag),
    "content-length": String(len),
    "content-type": "application/octet-stream",
    "last-modified": o.uploaded.toUTCString(),
    "accept-ranges": "bytes",
  };
}

/**
 * Body by payload mode (spec §18.2): aws-chunked decoded (trailer ignored); unsigned streamed with a known
 * length; a hex sha256 is buffered and checked before anything is written.
 */
async function readBody(
  req: Request,
  h: Record<string, string>,
  mode: Mode,
  tap: HeadTap | null = null,
): Promise<{ value: ReadableStream | ArrayBuffer; bytes: number } | "mismatch"> {
  const src = req.body;
  if (!src) return { value: new ArrayBuffer(0), bytes: 0 };
  const chunked = /aws-chunked/i.test(h["content-encoding"] ?? "") || mode === "streaming-unsigned-trailer";
  const decoded = chunked ? src.pipeThrough(awsChunkedDecoder()) : src;
  // The tap sees the decoded bytes R2 stores (the LTX header for the record check, sec F1/F3).
  const stream = tap ? decoded.pipeThrough(tap.stream()) : decoded;
  if (mode === "hex") {
    const ab = await new Response(stream).arrayBuffer();
    if ((await sha256Hex(ab)) !== h["x-amz-content-sha256"]) return "mismatch";
    return { value: ab, bytes: ab.byteLength };
  }
  const lenH = chunked ? h["x-amz-decoded-content-length"] : h["content-length"];
  const len = lenH !== undefined ? Number(lenH) : Number.NaN;
  const FLS = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  if (FLS && Number.isFinite(len)) return { value: stream.pipeThrough(new FLS(len)), bytes: len };
  const ab = await new Response(stream).arrayBuffer();
  return { value: ab, bytes: ab.byteLength };
}
