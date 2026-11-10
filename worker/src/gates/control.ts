// ControlGate at 15.0.0.1:80 (spec §17, gate contract §2). Narrow authenticated API from ocsup to the
// Control DO (GatePort → ledger.ts) and the Runtime DO (RtGatePort). Auth order of spec §17.1:
// route → hello (no secret) → secret → envelope → current gen → bound iid → prod-only writes.
import {
  ARCHIVE_PART_MAX,
  HDR,
  LOG_MAX_BODY,
  PATTERNS,
  PV,
  type Route,
  routeFor,
  SHADOW_SINGLE_MAX,
  validate,
} from "../core/contract";
import { sidecarKey } from "./archive-policy";
import {
  b64decode,
  b64encode,
  b64len,
  HELLO_MAC_HEADER,
  helloMacOk,
  helloProof,
  safeEqual,
  sha256Hex,
} from "./crypto";
import { CRED_INLINE_MAX, HELLO_BURST, HELLO_REFILL_MS, type HeartbeatNote } from "./ledger";
import { type ShaState, shaDigest, shaInit, shaUpdate } from "./sha256";
import type { GateDeps } from "./types";

export class GateFail extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, ...extra }, status);

/** Routes that do not need prod mode (spec §17.1 step 6: heartbeat, event, alert, log; reads; boot; snapshots). */
const NOT_WRITES = new Set([
  "/v1/hello",
  "/v1/boot",
  "/v1/heartbeat",
  "/v1/event",
  "/v1/alert",
  "/v1/log",
  "/v1/final-snapshot",
  "/v1/maint-snapshot",
]);
export const isWrite = (r: Route) => r.m !== "GET" && !NOT_WRITES.has(r.path);

/** JSON body cap for non-log routes: a creds PUT carries up to 2.7 M base64 chars (contract CredPut). */
const JSON_MAX = 3 * 1024 * 1024;

/** Errors of contract validate() that are about unknown fields: a gate ignores those (gate §0 rules). */
export function shapeErrors(schema: Route["body"], body: unknown): string[] {
  if (!schema) return [];
  return validate(schema, body).filter((e) => !e.endsWith(": unknown field"));
}

async function rpc<T>(p: Promise<T>, what: "ctl" | "rt"): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GateFail) throw e;
    throw new GateFail(503, {
      error: `${what}-unavailable`,
      detail: String((e as Error)?.message ?? e).slice(0, 200),
    });
  }
}

async function r2<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new GateFail(503, { error: "r2", detail: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}

/** Current-gen check with the 5 s isolate cache; a negative cached answer is checked again uncached. */
export async function currentOf(d: GateDeps, fresh = false) {
  const { epoch, gen } = d.props;
  const k = `${epoch}:${gen}`;
  const hit = d.cache.current.get(k);
  if (!fresh && hit && d.now() - hit.at < d.cache.ttlMs && hit.v.current && hit.v.iid) return hit.v;
  const v = await rpc(d.ctl.current(epoch, gen), "ctl");
  d.cache.current.set(k, { at: d.now(), v });
  return v;
}

/** sec F5: per-isolate token bucket (HELLO_BURST, +1 per HELLO_REFILL_MS). */
function isolateRate(d: GateDeps, plane: string): boolean {
  const k = `${plane}:${d.props.gen}`;
  const now = d.now();
  const b = d.cache.hello.get(k);
  const tokens =
    b === undefined ? HELLO_BURST : Math.min(HELLO_BURST, b.tokens + (now - b.at) / HELLO_REFILL_MS);
  if (tokens < 1) {
    d.cache.hello.set(k, { at: now, tokens });
    return false;
  }
  d.cache.hello.set(k, { at: now, tokens: tokens - 1 });
  return true;
}

/**
 * Hello rate (spec §17.1 step 2; sec F5): a token bucket per isolate and per gen in the Control DO. A caller
 * with a valid hello MAC (bootSecret holder) is never limited. A DO error does not block the proof.
 */
export async function helloAllowed(
  d: GateDeps,
  plane: "control" | "replica",
  o: { challenge?: string; mac?: string | null } = {},
): Promise<boolean> {
  const authed = !!o.challenge && (await helloMacOk(d.props.bootSecret, plane, o.challenge, o.mac ?? null));
  if (!authed && !isolateRate(d, plane)) return false;
  try {
    return (await d.ctl.hello(d.props.gen, plane, authed)).allow;
  } catch {
    return true;
  }
}

/**
 * Decode a path tail and check every segment *after* decoding (sec F8: `..%2Fx` decoded inside one segment
 * to `../x`). No empty, `.`, `..` segment, no NUL, no backslash, no leading `/`.
 */
export function decodeSegs(rest: string): string | null {
  let p: string;
  try {
    p = rest.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export async function handleControlGate(req: Request, d: GateDeps): Promise<Response> {
  try {
    return await route(req, d);
  } catch (e) {
    if (e instanceof GateFail) return json(e.body, e.status);
    return fail(500, "internal", { detail: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}

async function route(req: Request, d: GateDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const r = routeFor(req.method, path);
  if (!r) return fail(404, "not found");
  const P = d.props;

  // 2. hello: no secret
  if (r.path === "/v1/hello") {
    const body = await req.json().catch(() => null);
    const errs = shapeErrors(r.body, body);
    if (errs.length) return fail(400, "shape", { detail: errs.slice(0, 5) });
    const challenge = (body as { challenge: string }).challenge;
    if (!(await helloAllowed(d, "control", { challenge, mac: req.headers.get(HELLO_MAC_HEADER) })))
      return fail(429, "rate");
    return json({
      proof: await helloProof(P.bootSecret, (body as { challenge: string }).challenge),
      pv: [PV],
    });
  }

  // 3. secret
  if (!safeEqual(req.headers.get(HDR.secret) ?? "", P.bootSecret)) return fail(401, "unauthorized");

  // body: JSON routes parse and validate; raw routes stream later
  let body: Record<string, unknown> = {};
  let text = "";
  if (r.body && !r.raw) {
    const cap = r.path === "/v1/log" ? LOG_MAX_BODY : JSON_MAX;
    const cl = Number(req.headers.get("content-length") ?? "0");
    if (cl > cap) return fail(413, "too-large");
    text = await req.text();
    if (text.length > cap) return fail(413, "too-large");
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return fail(400, "bad-json");
    }
    const errs = shapeErrors(r.body, body);
    if (errs.length) return fail(400, "shape", { detail: errs.slice(0, 5) });
    // 5. envelope must equal props
    if (body.inst !== P.inst || body.gen !== P.gen || (body.epoch !== undefined && body.epoch !== P.epoch))
      return fail(409, "stale", { why: "envelope" });
  }

  // 6. current gen (5 s cache)
  let cur = await currentOf(d);
  if (!cur.current) return fail(409, "stale", { why: cur.why });

  // 4. bound iid after /v1/boot
  if (r.path !== "/v1/boot") {
    const iid = req.headers.get(HDR.iid) ?? "";
    if (!cur.iid || !safeEqual(iid, cur.iid)) {
      cur = await currentOf(d, true);
      if (!cur.current || !cur.iid || !safeEqual(iid, cur.iid)) return fail(409, "stale", { why: "iid" });
    }
  }
  if (isWrite(r) && P.mode !== "prod") return fail(403, "mode");

  return dispatch(r, req, url, body, d);
}

async function dispatch(
  r: Route,
  req: Request,
  url: URL,
  body: Record<string, unknown>,
  d: GateDeps,
): Promise<Response> {
  const P = d.props;
  const { ctl, rt, bucket } = d;
  const key = `${r.m} ${r.path}`;
  switch (key) {
    case "POST /v1/boot": {
      const b = body as { iid: string; pv: number; hostname?: string };
      const res = await rpc(
        ctl.boot(P.epoch, P.gen, { iid: b.iid, pv: b.pv, hostname: b.hostname }, [PV]),
        "ctl",
      );
      if ("error" in res) return res.error === "pv" ? fail(409, "pv") : fail(409, "stale", { why: res.why });
      if (res.status === "reboot-detected") {
        d.cache.current.delete(`${P.epoch}:${P.gen}`);
        return json({ status: "reboot-detected" });
      }
      if (res.bound) {
        d.cache.current.delete(`${P.epoch}:${P.gen}`);
        try {
          await rt.bootBound({ gen: P.gen, iid: b.iid });
        } catch {
          // the Runtime DO reads gens.iid on its identity check; the bind itself is durable in the Control DO
        }
      }
      return json({ status: "ok", plan: res.plan });
    }
    case "POST /v1/heartbeat": {
      const b = body as Partial<HeartbeatNote> & { seq: number };
      // sec F9: (gen, seq) must grow. A replay (same or older seq, or ocsup's retry after a lost answer) gets
      // the ack without being applied, so an old heartbeat cannot keep a dead boot "alive".
      const fresh = await rpc(ctl.hbSeq(P.gen, b.seq), "ctl");
      if (!fresh.fresh) {
        const info = await rpc(ctl.heartbeatInfo(P.gen), "ctl");
        return json({
          ok: true,
          gen: P.gen,
          tier: info.tier,
          at: d.now(),
          replica: info.replica,
          replay: true,
        });
      }
      // §23 fields go to the Control DO (channels, event jobs, secret version); advisory, never fails the ack.
      const note = ctl
        .noteHeartbeat({
          gen: P.gen,
          cpuS: b.cpuS,
          telegramSecretVersion: b.telegramSecretVersion,
          channels: b.channels,
          rpo: b.rpo,
          eventJobs: b.eventJobs,
          lastActivityAt: b.lastActivityAt,
          disk: b.disk,
        })
        .catch(() => undefined);
      const [a, info] = await Promise.all([
        rpc(rt.onHeartbeat(body), "rt"),
        rpc(ctl.heartbeatInfo(P.gen), "ctl"),
        note,
      ]);
      if (a.gen !== null && a.gen !== undefined && a.gen !== P.gen)
        return fail(409, "stale", { why: "rt-gen" });
      return json({
        ok: true,
        gen: P.gen,
        tier: info.tier,
        at: d.now(),
        replica: info.replica,
        ...(a.stop ? { stop: true } : {}),
        ...(info.import ? { import: info.import } : {}),
      });
    }
    case "POST /v1/event": {
      await rpc(ctl.event(P.gen, body as { kind: string }), "ctl");
      await rpc(rt.onEvent(body), "rt");
      return json({ ok: true });
    }
    case "POST /v1/alert": {
      const b = body as { class: string; severity: "info" | "warn" | "high"; detail?: string };
      const res = await rpc(ctl.alert(b.class, b.severity, b.detail ?? null), "ctl");
      return json({ ok: true, sent: res.sent });
    }
    case "POST /v1/log": {
      const lines = (body.lines as string[]) ?? [];
      const bytes = new TextEncoder().encode(JSON.stringify(lines)).length;
      const res = await rpc(ctl.logReserve(P.gen, bytes, lines.slice(-20)), "ctl");
      if (!res.ok) return fail(429, "log-cap");
      const at = d.now();
      await r2(bucket.put(res.key, lines.map((line) => JSON.stringify({ at, gen: P.gen, line })).join("\n")));
      return json({ ok: true });
    }
    case "GET /v1/replica/state":
      return json(await rpc(ctl.replicaState(P.gen), "ctl"));
    case "POST /v1/final-snapshot": {
      const res = await rpc(rt.finalSnapshot(body), "rt");
      const { status, ...rest } = res;
      return json(rest, status || (res.ok ? 200 : 500));
    }
    case "POST /v1/maint-snapshot": {
      if (!rt.maintSnapshot) return fail(403, "no-window");
      const res = await rpc(rt.maintSnapshot(body), "rt");
      const { status, ...rest } = res;
      return json(rest, status || (res.ok ? 200 : 500));
    }
    case "GET /v1/creds/manifest":
      return json(await rpc(ctl.credsManifest(), "ctl"));
    case "GET /v1/creds/:path":
    case "PUT /v1/creds/:path":
    case "DELETE /v1/creds/:path":
      return creds(r.m, url, body, d);
    case "GET /v1/config/:ver": {
      const v = url.pathname.slice("/v1/config/".length);
      if (!/^\d{1,9}$/.test(v)) return fail(400, "ver");
      const c = await rpc(ctl.configGet(Number(v)), "ctl");
      return c ? json(c) : fail(404, "not-found");
    }
    case "PUT /v1/config/proposal": {
      const res = await rpc(
        ctl.configPropose(P.gen, body as { source: string; sha: string; doc: unknown }),
        "ctl",
      );
      if (!res.ok)
        return res.error === "ctl-full"
          ? fail(507, "ctl-full")
          : fail(403, res.error, { detail: res.detail });
      return json({ ok: true, ver: res.ver });
    }
    case "GET /v1/plugins/manifest":
      return json(await rpc(ctl.pluginsGet(), "ctl"));
    case "PUT /v1/plugins/manifest": {
      const res = await rpc(ctl.pluginsPut(P.gen, body.manifest as { plugins?: unknown[] }), "ctl");
      if (!res.ok) return fail(507, res.error);
      return json({ ok: true, ver: res.ver });
    }
    case "PUT /v1/wake-allow": {
      await rpc(
        ctl.wakeAllow(body as { userIds: string[]; groupChatIds: string[]; configVer?: number }),
        "ctl",
      );
      return json({ ok: true });
    }
    case "POST /v1/archive/start":
    case "PUT /v1/archive/part":
    case "POST /v1/archive/complete":
    case "POST /v1/archive/abort":
    case "GET /v1/archive/get":
      return archive(r.path, req, url, body, d);
    case "PUT /v1/shadow/:db":
      return shadow(req, url, d);
    case "GET /v1/import/bundle":
      return importBundle(url, d);
    case "POST /v1/import/done": {
      const res = await rpc(
        ctl.importDone(P.gen, body as { id: string; ok: boolean; why?: string; result?: unknown }),
        "ctl",
      );
      return res.ok ? json({ ok: true }) : fail(404, res.why ?? "no-request");
    }
    case "POST /v1/export/:path":
      return fail(403, "mode", { detail: "files-only is v1.1" });
  }
  return fail(404, "not found");
}

async function creds(
  method: string,
  url: URL,
  body: Record<string, unknown>,
  d: GateDeps,
): Promise<Response> {
  const P = d.props;
  const p = decodeSegs(url.pathname.slice("/v1/creds/".length));
  if (!p || !PATTERNS.credPath.test(p)) return fail(400, "path");
  if (method === "GET") {
    const c = await rpc(d.ctl.credsGet(p), "ctl");
    if (!c || c.deleted) return fail(404, "not-found");
    let b64 = c.b64;
    if (b64 === null && c.r2Key) {
      const o = await r2(d.bucket.get(c.r2Key));
      if (!o) return fail(503, "r2", { detail: "blob missing" });
      b64 = b64encode(new Uint8Array(await o.arrayBuffer()));
    }
    return json({ path: p, seq: c.seq, sha256: c.sha256, mode: c.mode, b64: b64 ?? "" });
  }
  if (method === "DELETE") {
    const del = await rpc(d.ctl.credsDelete(P.gen, p, body.seq as number, true), "ctl");
    if (!del.ok) return fail(409, "stale", { why: "gen" });
    return json({ ok: true });
  }
  const b = body as { seq: number; sha256: string; mode: number; b64: string };
  const bytes = b64decode(b.b64);
  if ((await sha256Hex(bytes)) !== b.sha256) return fail(400, "sha256");
  let r2Key: string | null = null;
  let inline: string | null = b.b64;
  if (b64len(b.b64) > CRED_INLINE_MAX) {
    r2Key = `c/${P.inst}/blob/${b.sha256}`;
    await r2(d.bucket.put(r2Key, bytes));
    inline = null;
  }
  const res = await rpc(
    d.ctl.credsPut(P.gen, p, { seq: b.seq, sha256: b.sha256, mode: b.mode, b64: inline, r2Key }, true),
    "ctl",
  );
  if (!res.ok)
    return res.error === "ctl-full"
      ? fail(507, res.error)
      : res.error === "stale"
        ? fail(409, "stale", { why: "gen" })
        : fail(429, res.error);
  return json({ ok: true });
}

/** Read a raw body with a byte cap; null when over the cap. */
async function readCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  const cl = req.headers.get("content-length");
  if (cl !== null && Number(cl) > cap) return null;
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  const rd = req.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > cap) {
      await rd.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function archive(
  path: string,
  req: Request,
  url: URL,
  body: Record<string, unknown>,
  d: GateDeps,
): Promise<Response> {
  const P = d.props;
  const { ctl, bucket } = d;
  if (path === "/v1/archive/start") {
    const s = await rpc(
      ctl.archiveStart(P.gen, body.kind as string, body.manifest as Record<string, unknown> | undefined),
      "ctl",
    );
    // Uploads of dead open rows (older gen, or past openMaxMs): abort in R2, best effort.
    for (const u of s.abortUploads ?? [])
      await bucket
        .resumeMultipartUpload(u.key, u.uploadId)
        .abort()
        .catch(() => {});
    if (!s.ok)
      return s.error === "cap"
        ? fail(429, "archive-cap")
        : fail(409, s.error, s.why ? { why: s.why } : undefined);
    let up: R2MultipartUpload;
    try {
      up = await bucket.createMultipartUpload(s.key);
    } catch (e) {
      await rpc(ctl.archiveFinish(s.archiveId, false, { why: "r2-create" }), "ctl");
      throw new GateFail(503, { error: "r2", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    await rpc(ctl.archiveOpened(s.archiveId, up.uploadId, s.key), "ctl");
    return json({ archiveId: s.archiveId, key: s.key, partMax: ARCHIVE_PART_MAX });
  }
  if (path === "/v1/archive/part") {
    const id = url.searchParams.get("archiveId") ?? "";
    const n = Number(url.searchParams.get("n"));
    if (!id || !Number.isInteger(n) || n < 1 || n > 10_000) return fail(400, "query");
    const bytes = await readCapped(req, ARCHIVE_PART_MAX);
    if (!bytes) return fail(413, "part-too-large");
    const b = await rpc(ctl.archivePartBegin(id, n, bytes.length), "ctl");
    if (!b.ok) return fail(b.status, b.error);
    const st = shaUpdate(JSON.parse(b.state) as ShaState, bytes);
    const part = await r2(bucket.resumeMultipartUpload(b.key, b.uploadId).uploadPart(n, bytes));
    await rpc(ctl.archivePartDone(id, n, JSON.stringify(st), part.etag, bytes.length), "ctl");
    return json({ etag: part.etag });
  }
  if (path === "/v1/archive/complete") {
    const b = body as { archiveId: string; sha256: string; size: number; parts: number };
    const c = await rpc(ctl.archiveCompleteBegin(b.archiveId), "ctl");
    if (!c.ok) return fail(c.status, c.error);
    const sha = shaDigest(JSON.parse(c.state) as ShaState);
    const up = bucket.resumeMultipartUpload(c.key, c.uploadId);
    if (sha !== b.sha256 || c.bytes !== b.size || c.parts.length !== b.parts) {
      await up.abort().catch(() => {});
      const why = sha !== b.sha256 ? "sha" : c.bytes !== b.size ? "size" : "parts";
      await rpc(ctl.archiveFinish(b.archiveId, false, { why: `mismatch:${why}` }), "ctl");
      await rpc(ctl.alert("archive-failed", "warn", `${b.archiveId} ${why} mismatch`), "ctl");
      return fail(409, "sha-mismatch", { why });
    }
    await r2(up.complete(c.parts));
    await rpc(
      ctl.archiveFinish(b.archiveId, true, { sha256: sha, size: c.bytes, parts: c.parts.length }),
      "ctl",
    );
    // Drill J: the index facts next to the object, so a wiped Control DO rebuilds the row (ctl/rebuild.ts).
    // Best effort: a missing sidecar only means the rebuild re-hashes the archive.
    try {
      const row = await ctl.archiveSidecar(b.archiveId);
      if (row) await bucket.put(sidecarKey(c.key), JSON.stringify({ v: 1, ...row }));
    } catch {}
    return json({ ok: true });
  }
  if (path === "/v1/archive/abort") {
    const a = await rpc(ctl.archiveAbort(body.archiveId as string), "ctl");
    if (a.key && a.uploadId && a.state === "open")
      await bucket
        .resumeMultipartUpload(a.key, a.uploadId)
        .abort()
        .catch(() => {});
    return json({ ok: true });
  }
  // GET /v1/archive/get — verify on restore: the R2 size must equal the index, and the gate hashes the bytes
  // it streams; at the end the Control DO marks the archive verified or `bad` (the plan then skips it).
  // ocsup checks the same sha256 against its plan before it extracts (workspace.mjs).
  const id = url.searchParams.get("archiveId") ?? "";
  const f = id ? await rpc(ctl.archiveFacts(id), "ctl") : null;
  if (!f) return fail(404, "not-found");
  const o = await r2(bucket.get(f.key));
  if (!o) {
    await rpc(ctl.archiveVerify(id, false, "restore", "r2 object missing"), "ctl");
    return fail(404, "not-found");
  }
  if (f.size !== null && o.size !== f.size) {
    await o.body.cancel().catch(() => {});
    await rpc(ctl.archiveVerify(id, false, "restore", `size ${o.size} != ${f.size}`), "ctl");
    return fail(409, "archive-bad", { why: "size" });
  }
  return new Response(
    verifyStream(o.body, f.sha256, (ok, why) => ctl.archiveVerify(id, ok, "restore", why)),
    {
      headers: { "content-type": "application/octet-stream", "content-length": String(o.size) },
    },
  );
}

/**
 * `ochost import` bundle (gates/import-policy.ts): only the open request's object; size checked here, sha256 by
 * ocsup on its copy (the Worker hashed it on upload with R2's own sha256 check).
 */
async function importBundle(url: URL, d: GateDeps): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  const f = await rpc(d.ctl.importFacts(id), "ctl");
  if (!f) return fail(404, "no-request");
  const o = await r2(d.bucket.get(f.key));
  if (!o) return fail(404, "not-found", { detail: "bundle missing in R2" });
  if (o.size !== f.bytes) {
    await o.body.cancel().catch(() => {});
    return fail(409, "bundle-bad", { why: `size ${o.size} != ${f.bytes}` });
  }
  return new Response(o.body, {
    headers: { "content-type": "application/octet-stream", "content-length": String(o.size) },
  });
}

/** Pass bytes through; hash them; report once at the end (or never, when the reader stops early). */
export function verifyStream(
  body: ReadableStream<Uint8Array>,
  want: string | null,
  report: (ok: boolean, why?: string) => Promise<unknown>,
): ReadableStream<Uint8Array> {
  let st = shaInit();
  let n = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        st = shaUpdate(st, chunk);
        n += chunk.length;
        ctl.enqueue(chunk);
      },
      async flush() {
        if (!want) return;
        const got = shaDigest(st);
        await report(
          got === want,
          got === want ? undefined : `sha ${got.slice(0, 16)} != ${want.slice(0, 16)} (${n} B)`,
        ).catch(() => {});
      },
    }),
  );
}

/**
 * Shadow DB path (gate §2 `PUT /v1/shadow/<db>`): an *unclassified* `*.sqlite` under the state tree (ocsup
 * shadow.mjs, M1 item 9), so not the managed-DB `relpath` set. Relative, no `.`/`..`/empty segment, no NUL,
 * ≤ 512 chars, ends in `.sqlite`. Was `PATTERNS.relpath`: every shadow PUT got 400 "db" and each sleep
 * aborted with sleep-flush-failed (M2 integration, local loop).
 */
export function shadowPathOk(db: string): boolean {
  if (db.length > 512 || db.includes("\0") || db.startsWith("/") || !db.endsWith(".sqlite")) return false;
  return db.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

async function shadow(req: Request, url: URL, d: GateDeps): Promise<Response> {
  const P = d.props;
  const db = decodeSegs(url.pathname.slice("/v1/shadow/".length));
  if (!db || !shadowPathOk(db)) return fail(400, "db");
  const want = req.headers.get(HDR.sha256) ?? "";
  if (!/^[0-9a-f]{64}$/.test(want)) return fail(400, "sha256-header");
  const rate = await rpc(d.ctl.shadowCheck(db), "ctl");
  if (!rate.ok)
    return rate.why === "ctl-full"
      ? fail(507, "ctl-full")
      : fail(429, "rate", { retryAfterMs: rate.retryAfterMs, ...(rate.why ? { why: rate.why } : {}) });
  const bytes = await readCapped(req, SHADOW_SINGLE_MAX);
  if (!bytes) return fail(413, "too-large", { detail: "use the archive routes above 64 MiB" });
  if ((await sha256Hex(bytes)) !== want) return fail(409, "sha-mismatch");
  const key = `s/${P.inst}/${db}/${stamp(d.now())}.sqlite`;
  await r2(d.bucket.put(key, bytes));
  await rpc(d.ctl.shadowDone(db, key, bytes.length), "ctl");
  return json({ ok: true, key });
}
