// Fake ControlGate + ReplicaGate logic for the M1 harness. Pure functions and one state object, no I/O,
// so unit tests (image/test/unit) can drive it. fakes/gate.mjs wires it to HTTP and SeaweedFS.
// Contract: image/ocrt/lib/contract.mjs (docs/07-gate-contract.md). Every request body and every answer
// is checked with contract.validate(); records carry contract:"ok"|"invalid" and the errors.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as C from "../../ocrt/lib/contract.mjs";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();
export const hmacHex = (k, s) => createHmac("sha256", k).update(s).digest("hex");
export const replicaSecret = (bootSecret, gen, iid) => hmacHex(bootSecret, C.replicaKeyMessage(gen, iid));
export const replicaKeyId = C.replicaAccessKeyId;
export const parseLtxKey = C.parseLtxKey;

// ---------------- aws-chunked ----------------
/** Decode an aws-chunked body ("<hex>[;chunk-signature=..]\r\n<data>\r\n ... 0\r\n[trailers]\r\n"). */
export function decodeAwsChunked(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", i);
    if (nl < 0) throw new Error("aws-chunked: no header end");
    const size = Number.parseInt(buf.subarray(i, nl).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("aws-chunked: bad size");
    i = nl + 2;
    if (size === 0) break;
    if (i + size > buf.length) throw new Error("aws-chunked: short body");
    out.push(buf.subarray(i, i + size));
    i += size + 2;
  }
  return Buffer.concat(out);
}
export const isAwsChunked = (h) =>
  /aws-chunked/i.test(h["content-encoding"] || "") || /^STREAMING-/i.test(h["x-amz-content-sha256"] || "");

// ---------------- SigV4 verify ----------------
const uriEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Verify a header-signed SigV4 request. headers: lower-case names. Returns {ok, keyId, why}. */
export function verifySigV4({ method, rawPath, headers, body, secretFor }) {
  const auth = headers.authorization || "";
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!m) return { ok: false, keyId: null, why: "no-sigv4" };
  const [, keyId, date, region, service, signed, sig] = m;
  const secret = secretFor(keyId);
  if (!secret) return { ok: false, keyId, why: "unknown-key" };
  const u = new URL(rawPath, "http://x");
  const names = signed.split(";");
  const canonHeaders = names
    .map(
      (n) =>
        `${n}:${String(headers[n] ?? "")
          .trim()
          .replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const q = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)]);
  q.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonQuery = q.map(([k, v]) => `${k}=${v}`).join("&");
  const canonPath = u.pathname
    .split("/")
    .map((seg) => uriEncode(decodeURIComponent(seg)))
    .join("/");
  const declared = headers["x-amz-content-sha256"];
  const payloadHash = declared || sha256hex(body || "");
  if (declared && !/^(UNSIGNED-PAYLOAD|STREAMING-)/.test(declared) && body && sha256hex(body) !== declared)
    return { ok: false, keyId, why: "payload-hash" };
  const creq = [method, canonPath || "/", canonQuery, canonHeaders, signed, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", headers["x-amz-date"] || "", scope, sha256hex(creq)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
  const want = createHmac("sha256", kSigning).update(sts).digest();
  const got = Buffer.from(sig, "hex");
  return { ok: got.length === want.length && timingSafeEqual(got, want), keyId, why: "signature" };
}

// ---------------- state ----------------
export function newState({ inst = "m1", bootSecret = "", now = Date.now } = {}) {
  return {
    inst,
    bootSecret,
    now,
    seq: 0,
    records: [],
    faults: {},
    plans: [],
    gen: 0, // current gen; the harness (as the DO) issues it before each start
    epoch: 1,
    mode: "prod",
    restoreGens: [],
    genIid: {}, // gen -> iid bound at /v1/boot
    genPlan: {}, // gen -> plan given (same iid gets the same plan)
    uploads: {}, // gen -> db -> {l0MaxTxid, l0Seen, l0SeedBytes, compactSeedBytes, seedBytes, bytes, keys, levels}
    tierBytes: 0,
    seedBytes: 0,
    creds: {}, // path -> {seq, gen, sha256, mode, b64, deleted, at}
    credSeq: 0,
    credHist: [],
    config: { ver: 1, doc: {}, schemaSha: undefined, proposals: [] },
    plugins: { ver: 0, plugins: [], puts: [] },
    finalSnapshots: [],
    alerts: [],
    wakes: [],
  };
}

export function record(S, rec) {
  const r = { seq: ++S.seq, ts: S.now(), ...rec };
  S.records.push(r);
  if (S.records.length > 200_000) S.records.splice(0, 50_000);
  return r;
}

/** Fault flags (POST /_ctl/faults; {clear:true} first resets). All optional:
 *  hb409            every heartbeat answers 409 stale
 *  hbStatus         every heartbeat answers this status (500, 503)
 *  hbDrop           heartbeat socket closed with no answer
 *  hbStop           heartbeat ack carries stop:true (asleep-unconfirmed)
 *  refuseFinalSnapshot  true (503) or a status: final-snapshot refused, no handle stored
 *  hangFinalSnapshot    ms to wait before the final-snapshot answer (handle stored first)
 *  throttle {delayMs, status, refuseLevel, untilTs}  ReplicaGate writes: delay, or answer status (503
 *                   SlowDown), or refuse only keys of one level (0 = L0, for lag-level). untilTs ends it.
 *  dropRequestWake  n: the next n requestWake calls are dropped (503, no wake)
 *  strict           unknown routes 404 and contract violations 400 (default: lenient, recorded)
 *  sigv4Strict      ReplicaGate refuses a request whose SigV4 does not verify (403)
 *  creds500         /v1/creds PUT/DELETE answer 500 (credsync backlog)
 *  enospc           ReplicaGate PUTs answer 507 InsufficientStorage (guess of the R2-side shape)
 *  tier             tier in the heartbeat ack (normal|slow|slower)
 *  readDelayMs      ReplicaGate reads (GET, HEAD, List) wait this long (slows a restore phase)
 */
export function setFaults(S, f) {
  if (f.clear) S.faults = {};
  for (const [k, v] of Object.entries(f)) if (k !== "clear") S.faults[k] = v;
  record(S, { plane: "harness", route: "faults", body: S.faults });
  return S.faults;
}

export function defaultPlan(S, gen) {
  return {
    v: 1,
    mode: S.mode,
    inst: S.inst,
    epoch: S.epoch,
    gen,
    rootfs: { kind: "image" },
    sqlite: { kind: "fresh" },
    dbs: [],
    restoreGens: S.restoreGens,
    runDoctor: false,
    lockMode: "auto",
    configVer: null,
    credsSeq: S.credSeq,
    channelsOff: false,
    overlay: [],
    replica: {
      bucket: `oc-host-${S.inst}`,
      prefix: C.genPrefix(S.inst, gen),
      tier: "normal",
      seedGateMaxBytes: 200e6,
    },
    timers: { hbMs: 30_000, fenceMs: 150_000, startGateMs: 120_000 },
    trustedProxies: ["10.1.0.0/32"],
  };
}

function check(schema, value) {
  if (!schema) return "noschema";
  const e = C.validate(schema, value);
  return e.length ? e : null;
}

function replicaView(S, gen) {
  const dbs = {};
  for (const [db, u] of Object.entries(S.uploads[gen] || {}))
    dbs[db] = {
      l0MaxTxid: u.l0MaxTxid,
      seeded: u.l0Seen,
      bytes: u.bytes,
      lastWriteAt: u.lastWriteAt ?? null,
    };
  return { gen: Math.max(1, gen), dbs };
}

/** ControlGate request. Returns {status, body, delayMs?, drop?}. headers: lower-case. */
export function control(S, { method, path, headers = {}, body }) {
  const url = new URL(path, "http://x");
  const route = url.pathname;
  const spec = C.routeFor(method, route);
  const reqErr = spec?.body ? check(spec.body, body) : null;
  const rec0 = {
    plane: "control",
    route,
    method,
    iid: headers[C.HDR.iid] || undefined,
    contract: !spec ? "unknown-route" : reqErr ? "invalid" : "ok",
    errors: Array.isArray(reqErr) ? reqErr.slice(0, 10) : undefined,
  };
  const done = (status, resBody, extra = {}) => {
    const resErr = status >= 200 && status < 300 && spec?.res ? check(spec.res, resBody) : null;
    record(S, {
      ...rec0,
      status,
      body,
      res: resBody,
      resErrors: Array.isArray(resErr) ? resErr : undefined,
      ...extra,
    });
    return { status, body: resBody, ...(extra.delayMs ? { delayMs: extra.delayMs } : {}) };
  };
  if (!spec && S.faults.strict) return done(404, { error: "not found" });
  if (Array.isArray(reqErr) && S.faults.strict) return done(400, { error: "shape", errors: reqErr });
  if (method === "POST" && route === "/v1/hello") {
    if (typeof body?.challenge !== "string") return done(400, { error: "shape" });
    return done(200, { proof: hmacHex(S.bootSecret, `${C.DOMAIN.hello}${body.challenge}`), pv: [C.PV] });
  }
  const secret = headers[C.HDR.secret] || (headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (S.bootSecret && secret !== S.bootSecret) return done(401, { error: "unauthorized" });
  const gen = Number(body?.gen ?? S.gen);
  const iidHdr = headers[C.HDR.iid];
  if (method === "POST" && route === "/v1/boot") {
    const iid = String(body?.iid ?? "");
    if (gen < S.gen) return done(409, { error: "stale" });
    if (S.genIid[gen] && S.genIid[gen] !== iid)
      return done(200, { status: "reboot-detected" }, { why: "reboot-detected" });
    S.gen = Math.max(S.gen, gen);
    if (!S.genPlan[gen]) {
      S.genIid[gen] = iid;
      const p = S.plans.shift() || {};
      S.genPlan[gen] = { ...defaultPlan(S, gen), ...p, gen };
      if (Array.isArray(S.genPlan[gen].restoreGens)) S.restoreGens = S.genPlan[gen].restoreGens;
      if (S.genPlan[gen].mode) S.mode = S.genPlan[gen].mode;
    }
    return done(200, { status: "ok", plan: S.genPlan[gen] });
  }
  // Every route after /v1/boot: stale gen or wrong iid -> 409 stale.
  const staleIid = iidHdr && S.genIid[S.gen] && iidHdr !== S.genIid[S.gen];
  if (route !== "/v1/boot" && (gen < S.gen || staleIid))
    return done(409, { error: "stale" }, { why: staleIid ? "iid" : "gen" });
  if (method === "POST" && route === "/v1/heartbeat") {
    if (S.faults.hbDrop) {
      record(S, { ...rec0, status: "dropped", body });
      return { drop: true };
    }
    if (S.faults.hb409) return done(409, { error: "stale" }, { why: "fault" });
    if (S.faults.hbStatus) return done(S.faults.hbStatus, { error: "fault" });
    const ack = {
      ok: true,
      at: S.now(),
      gen: Math.max(1, S.gen),
      tier: S.faults.tier || "normal",
      replica: replicaView(S, S.gen),
    };
    if (S.faults.hbStop) ack.stop = true;
    return done(200, ack);
  }
  if (method === "GET" && route === "/v1/replica/state") return done(200, replicaView(S, S.gen));
  if (method === "POST" && route === "/v1/final-snapshot") {
    const f = S.faults.refuseFinalSnapshot;
    if (f) return done(f === true ? 503 : f, { error: "container not running" }, { why: "refused" });
    // The DO stores the handle before it answers (amend §2 row 21a).
    const h = {
      id: `snap-final-${S.finalSnapshots.length + 1}`,
      gen,
      at: S.now(),
      unclean: body?.unclean ?? null,
    };
    S.finalSnapshots.push(h);
    return done(
      200,
      { ok: true, snapshotId: h.id },
      { handle: h, delayMs: Number(S.faults.hangFinalSnapshot) || 0 },
    );
  }
  if (method === "POST" && route === "/v1/maint-snapshot")
    return done(200, { ok: true, snapshotId: `snap-maint-${S.seq}` });
  if (route.startsWith("/v1/creds/")) {
    const rest = route.slice("/v1/creds/".length);
    if (method === "GET" && rest === "manifest") {
      const files = Object.entries(S.creds).map(([p, v]) => ({
        path: p,
        seq: v.seq,
        sha256: v.sha256,
        mode: v.mode ?? 0o600,
        ...(v.deleted ? { deleted: true } : {}),
        size: v.b64 ? Buffer.from(v.b64, "base64").length : 0,
      }));
      return done(200, { seq: S.credSeq, files });
    }
    const p = decodeURIComponent(rest);
    if (method === "GET") {
      const v = S.creds[p];
      if (!v || v.deleted) return done(404, { error: "not found" });
      return done(200, { path: p, seq: v.seq, sha256: v.sha256, mode: v.mode ?? 0o600, b64: v.b64 || "" });
    }
    if (S.faults.creds500) return done(500, { error: "fault" });
    const prev = S.creds[p];
    const seq = Number(body?.seq ?? 0);
    if (prev && (gen < prev.gen || (gen === prev.gen && seq <= prev.seq)))
      return done(409, { error: "not-newer" }, { path: p });
    const v = {
      seq,
      gen,
      sha256: body?.sha256 ?? sha256hex(""),
      mode: body?.mode ?? 0o600,
      b64: method === "DELETE" ? null : (body?.b64 ?? ""),
      deleted: method === "DELETE",
      at: S.now(),
    };
    S.creds[p] = v;
    S.credSeq++;
    S.credHist.push({ path: p, seq, gen, sha256: v.sha256, deleted: v.deleted, at: v.at });
    return done(200, { ok: true }, { path: p, body: { seq, gen, sha256: v.sha256, deleted: v.deleted } });
  }
  if (method === "GET" && route.startsWith("/v1/config/"))
    return done(200, {
      ver: S.config.ver,
      doc: S.config.doc,
      ...(S.config.schemaSha ? { schemaSha: S.config.schemaSha } : {}),
    });
  if (method === "GET" && route === "/v1/plugins/manifest")
    return done(200, { ver: S.plugins.ver, plugins: S.plugins.plugins });
  if (method === "PUT" && route === "/v1/plugins/manifest") {
    S.plugins.puts.push({ at: S.now(), manifest: body?.manifest });
    return done(200, { ok: true });
  }
  if (method === "PUT" && route === "/v1/config/proposal") {
    S.config.proposals.push({ at: S.now(), ...body });
    return done(200, { ok: true });
  }
  if (method === "POST" && route === "/v1/alert") {
    S.alerts.push({ at: S.now(), ...body });
    return done(200, { ok: true });
  }
  if (method === "POST" && route === "/v1/event") return done(200, { ok: true });
  if (method === "POST" && route === "/v1/log") return done(200, { ok: true });
  if (method === "POST" && route === "/v1/archive/start")
    return done(200, { archiveId: `ar-${S.seq}`, partMax: C.ARCHIVE_PART_MAX });
  if (method === "PUT" && route === "/v1/archive/part") return done(200, { etag: `e-${S.seq}` });
  if (
    route.startsWith("/v1/archive/") ||
    route.startsWith("/v1/shadow/") ||
    route.startsWith("/v1/export/") ||
    route === "/v1/plugins/manifest"
  )
    return done(200, { ok: true });
  if (S.faults.strict) return done(404, { error: "not found" });
  return done(200, { ok: true, lenient: true }, { why: "unknown-route-lenient" });
}

/** ReplicaGate hello (/_ocrt/hello). */
export function replicaHello(S, body) {
  const proof = hmacHex(S.bootSecret, `${C.DOMAIN.replicaHello}${body?.challenge ?? ""}`);
  record(S, { plane: "replica", route: "hello", status: 200 });
  return { status: 200, body: { proof } };
}

const props = (S) => ({ inst: S.inst, gen: S.gen, restoreGens: S.restoreGens, mode: S.mode });

/**
 * ReplicaGate pre-check for one S3 request (before forwarding). searchParams: URLSearchParams.
 * Returns {forward:true, op, delayMs?, sig} or {status, code, message, op, sig} to answer at once.
 */
export function replicaPre(S, { method, key, searchParams, headers, body, rawPath }) {
  const op = C.s3OpOf(method, searchParams);
  const kid = /Credential=([^/,\s]+)\//.exec(headers.authorization || "")?.[1] || null;
  let sig = "unchecked";
  const gm = /^ocrt-g(\d+)-(.+)$/.exec(kid || "");
  if (gm && S.bootSecret) {
    const v = verifySigV4({
      method,
      rawPath,
      headers,
      body,
      secretFor: () => replicaSecret(S.bootSecret, Number(gm[1]), gm[2]),
    });
    sig = v.ok ? "ok" : `bad:${v.why}`;
  } else if (kid) sig = `foreign-key:${kid}`;
  const no = (status, code, message) => ({ status, code, message, op, sig });
  if (!op) return no(501, "NotImplemented", `${method} not in the S3 subset`);
  if (S.faults.sigv4Strict && sig !== "ok") return no(403, "AccessDenied", `sigv4 ${sig}`);
  const a = C.replicaAccess(props(S), op, key, searchParams.get("prefix"));
  if (!a.allow) return no(a.status, a.status === 501 ? "NotImplemented" : "AccessDenied", `access ${a.why}`);
  if (a.scope === "read" && S.faults.readDelayMs)
    return { forward: true, op, delayMs: S.faults.readDelayMs, sig };
  if (a.scope === "write") {
    const ltx = key ? C.parseLtxKey(key) : null;
    if (S.faults.enospc && (op === "PutObject" || op === "UploadPart"))
      return no(507, "InsufficientStorage", "fault: enospc");
    const t = S.faults.throttle;
    if (t && (!t.untilTs || S.now() < t.untilTs)) {
      const lvl = t.refuseLevel === undefined ? null : Number(t.refuseLevel);
      if (lvl !== null) {
        if (ltx && ltx.level === lvl && (op === "PutObject" || op === "CreateMultipartUpload"))
          return no(t.status || 503, "SlowDown", "fault: level refused");
      } else if (t.status) return no(t.status, "SlowDown", "fault: throttle");
      else if (t.delayMs) return { forward: true, op, delayMs: t.delayMs, sig };
    }
    // Seed guard (amend §1.6 S2): a second level-0 key with min TXID 1 in one gen.
    if (
      ltx &&
      ltx.level === 0 &&
      ltx.minTxid === 1 &&
      (op === "PutObject" || op === "CreateMultipartUpload")
    ) {
      const u = S.uploads[ltx.gen]?.[ltx.db];
      if (u?.l0Seen && u.l0SeedKey !== key) {
        S.alerts.push({ at: S.now(), class: "replica-reseed", severity: "warn", detail: key });
        return no(409, "Reseed", "second TXID-1 L0 key in this gen");
      }
    }
  }
  return { forward: true, op, sig };
}

/** Record a finished ReplicaGate request (after the backend answered). */
export function replicaPost(S, { method, key, prefix, op, status, bytes, sig, ms }) {
  const ltx = key ? C.parseLtxKey(key) : null;
  // Multipart: the parts carry the bytes, CompleteMultipartUpload has none. Sum parts per key.
  if (key && status >= 200 && status < 300) {
    S.mpBytes ??= {};
    if (op === "CreateMultipartUpload") S.mpBytes[key] = 0;
    else if (op === "UploadPart") S.mpBytes[key] = (S.mpBytes[key] || 0) + (bytes || 0);
    else if (op === "CompleteMultipartUpload") {
      bytes = S.mpBytes[key] || 0;
      delete S.mpBytes[key];
    }
  }
  const done =
    status >= 200 && status < 300 && (op === "PutObject" || op === "CompleteMultipartUpload") && ltx;
  let cls;
  if (done) {
    S.uploads[ltx.gen] ??= {};
    S.uploads[ltx.gen][ltx.db] ??= {
      l0MaxTxid: 0,
      l0Seen: false,
      l0SeedKey: null,
      l0SeedBytes: 0,
      compactSeedBytes: 0,
      seedBytes: 0,
      firstL0At: null,
      lastWriteAt: null,
      bytes: 0,
      keys: 0,
      levels: {},
    };
    const u = S.uploads[ltx.gen][ltx.db];
    cls = C.seedClass(ltx, bytes || 0, u);
    u.keys++;
    u.levels[ltx.level] = (u.levels[ltx.level] || 0) + 1;
    u.bytes += bytes || 0;
    u.lastWriteAt = S.now();
    if (ltx.level === 0) {
      u.l0MaxTxid = Math.max(u.l0MaxTxid, ltx.maxTxid);
      u.firstL0At ??= S.now();
      if (ltx.minTxid === 1 && !u.l0Seen) {
        u.l0Seen = true;
        u.l0SeedKey = key;
        u.l0SeedBytes = bytes || 0;
      }
    }
    if (cls === "seed") {
      u.seedBytes += bytes || 0;
      S.seedBytes += bytes || 0;
      if (ltx.level >= 1 && ltx.level <= 3) u.compactSeedBytes += bytes || 0;
    } else S.tierBytes += bytes || 0;
  }
  return record(S, {
    plane: "replica",
    route: op || method,
    method,
    key,
    prefix,
    status,
    bytes,
    sig,
    ms,
    ltx: ltx || undefined,
    seed: cls,
  });
}

/** Lag in TXIDs per amend §1.5: local L0 max minus the gate-recorded level-0 max for (gen, db). */
export function lagOf(S, gen, db, localL0Max) {
  return localL0Max - (S.uploads[gen]?.[db]?.l0MaxTxid || 0);
}

export function requestWake(S, reason) {
  if (S.faults.dropRequestWake > 0) {
    S.faults.dropRequestWake--;
    record(S, { plane: "harness", route: "requestWake", status: 503, body: { reason }, why: "dropped" });
    return { status: 503, body: { error: "dropped" } };
  }
  S.wakes.push({ at: S.now(), reason });
  record(S, { plane: "harness", route: "requestWake", status: 200, body: { reason } });
  return { status: 200, body: { ok: true, n: S.wakes.length } };
}
