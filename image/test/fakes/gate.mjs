// Fake ControlGate (:80) + ReplicaGate backend (:8002) + harness control API (:9000), one process, one state.
// Runs in the ocm1-gate sidecar (node:24). Mounts: /t = image/test (ro), /ocrt = image/ocrt (ro), /log.
// ReplicaGate forwards allowed S3 calls to SeaweedFS (anonymous) at OCM1_S3 (default http://15.0.0.10:8333).
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import {
  control,
  decodeAwsChunked,
  isAwsChunked,
  newState,
  record,
  replicaHello,
  replicaPost,
  replicaPre,
  requestWake,
  setFaults,
} from "./gate-core.mjs";

const S3 = process.env.OCM1_S3 || "http://15.0.0.10:8333";
const LOG = process.env.OCM1_LOG || "/log/gate.jsonl";
let S = newState({ inst: process.env.OCM1_INST || "m1", bootSecret: process.env.OCM1_BOOT_SECRET || "" });
const contractInfo = { loaded: true, pv: (await import("../../ocrt/lib/contract.mjs")).PV };

const logRec = (r) => {
  try {
    fs.appendFileSync(LOG, `${JSON.stringify(r)}\n`);
  } catch {}
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
const sendJson = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Delete every object of the bucket (tests must not see an earlier test's gens). Returns the count. */
async function wipeBucket() {
  const b = `${S3}/oc-host-${S.inst}`;
  let n = 0;
  for (let round = 0; round < 50; round++) {
    let xml;
    try {
      const r = await fetch(`${b}?list-type=2&max-keys=1000`, { signal: AbortSignal.timeout(10_000) });
      xml = await r.text();
      if (!r.ok) return n;
    } catch {
      return n;
    }
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    if (!keys.length) return n;
    for (let i = 0; i < keys.length; i += 32)
      await Promise.all(
        keys.slice(i, i + 32).map((k) =>
          fetch(`${b}/${k.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" })
            .then((r) => r.text())
            .catch(() => {}),
        ),
      );
    n += keys.length;
  }
  return n;
}

async function ensureBucket() {
  try {
    const r = await fetch(`${S3}/oc-host-${S.inst}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
    await r.text();
    return r.status === 200 || r.status === 409;
  } catch {
    return false;
  }
}

// ---- ControlGate :80 ----
http
  .createServer(async (req, res) => {
    const raw = await readBody(req).catch(() => Buffer.alloc(0));
    let body = null;
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
    } catch {
      body = { _raw: raw.toString("utf8").slice(0, 200) };
    }
    const before = S.seq;
    const r = control(S, {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body,
    });
    for (let i = S.records.length - 1; i >= 0 && S.records[i].seq > before; i--)
      logRec({ ...S.records[i], from: req.socket.remoteAddress });
    if (r.drop) return req.socket.destroy();
    if (r.delayMs) await sleep(r.delayMs);
    sendJson(res, r.status, r.body);
  })
  .listen(80, "0.0.0.0");

// ---- ReplicaGate backend :8002 (reached as 15.0.0.2:80) ----
const S3_ERR = (code, msg) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${msg}</Message></Error>`;
http
  .createServer(async (req, res) => {
    const t0 = Date.now();
    let raw = await readBody(req).catch(() => Buffer.alloc(0));
    const u = new URL(req.url, "http://x");
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const bucket = parts[0] || "";
    const key = parts.slice(1).join("/");
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    if (req.method === "POST" && u.pathname === "/_ocrt/hello") {
      let b = {};
      try {
        b = JSON.parse(raw.toString("utf8"));
      } catch {}
      const r = replicaHello(S, b);
      return sendJson(res, r.status, r.body);
    }
    const pre = replicaPre(S, {
      method: req.method,
      key,
      searchParams: u.searchParams,
      headers,
      body: raw,
      rawPath: req.url,
    });
    if (!pre.forward) {
      const rec = replicaPost(S, {
        method: req.method,
        key,
        op: pre.op,
        status: pre.status,
        bytes: raw.length,
        sig: pre.sig,
        ms: 0,
      });
      logRec({ ...rec, refused: pre.message });
      res.writeHead(pre.status, { "content-type": "application/xml" });
      return res.end(S3_ERR(pre.code, pre.message));
    }
    if (pre.delayMs) await sleep(pre.delayMs);
    if (isAwsChunked(headers)) {
      try {
        raw = decodeAwsChunked(raw);
      } catch (e) {
        res.writeHead(400, { "content-type": "application/xml" });
        return res.end(S3_ERR("InvalidRequest", String(e.message)));
      }
    }
    const fwdHeaders = {};
    for (const k of ["content-type", "range", "if-none-match", "if-match", "content-md5"])
      if (headers[k]) fwdHeaders[k] = headers[k];
    let up;
    try {
      up = await fetch(
        `${S3}/${encodeURIComponent(bucket)}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}${u.search}`,
        {
          method: req.method,
          headers: fwdHeaders,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : raw,
          signal: AbortSignal.timeout(300_000),
        },
      );
    } catch (e) {
      const rec = replicaPost(S, {
        method: req.method,
        key,
        op: pre.op,
        status: 502,
        bytes: raw.length,
        sig: pre.sig,
        ms: Date.now() - t0,
      });
      logRec({ ...rec, err: String(e.cause?.code || e) });
      res.writeHead(502, { "content-type": "application/xml" });
      return res.end(S3_ERR("InternalError", "backend"));
    }
    const out = Buffer.from(await up.arrayBuffer());
    const rec = replicaPost(S, {
      method: req.method,
      key,
      prefix: u.searchParams.get("prefix") ?? undefined,
      op: pre.op,
      status: up.status,
      bytes: req.method === "GET" ? out.length : raw.length,
      sig: pre.sig,
      ms: Date.now() - t0,
    });
    logRec(rec);
    const h = {};
    for (const k of [
      "content-type",
      "etag",
      "last-modified",
      "content-range",
      "accept-ranges",
      "x-amz-request-id",
    ]) {
      const v = up.headers.get(k);
      if (v) h[k] = v;
    }
    h["content-length"] = String(out.length);
    res.writeHead(up.status, h);
    res.end(req.method === "HEAD" ? undefined : out);
  })
  .listen(8002, "0.0.0.0");

// ---- harness control API :9000 ----
http
  .createServer(async (req, res) => {
    const raw = await readBody(req).catch(() => Buffer.alloc(0));
    let b = {};
    try {
      b = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {}
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/_ctl/health")
      return sendJson(res, 200, { ok: true, s3: await ensureBucket(), contract: contractInfo, gen: S.gen });
    if (p === "/_ctl/reset") {
      S = newState({ inst: b.inst || S.inst, bootSecret: b.bootSecret ?? S.bootSecret });
      if (b.gen) S.gen = b.gen;
      if (b.mode) S.mode = b.mode;
      const s3 = await ensureBucket();
      const wiped = b.keepS3 ? 0 : await wipeBucket();
      return sendJson(res, 200, { ok: true, s3, wiped });
    }
    if (p === "/_ctl/gen") {
      S.gen = Number(b.gen);
      if (Array.isArray(b.restoreGens)) S.restoreGens = b.restoreGens;
      if (b.mode) S.mode = b.mode;
      if (b.epoch) S.epoch = b.epoch;
      record(S, { plane: "harness", route: "gen", body: b });
      return sendJson(res, 200, { gen: S.gen });
    }
    if (p === "/_ctl/plan") {
      S.plans.push(b.plan || b);
      return sendJson(res, 200, { queued: S.plans.length });
    }
    if (p === "/_ctl/faults") return sendJson(res, 200, setFaults(S, b));
    if (p === "/_ctl/config") {
      Object.assign(S.config, b);
      return sendJson(res, 200, { ver: S.config.ver });
    }
    if (p === "/_ctl/plugins") {
      Object.assign(S.plugins, b);
      return sendJson(res, 200, { ver: S.plugins.ver });
    }
    if (p === "/_ctl/creds") {
      // Seed the CredStore: {path, b64, seq?, mode?}
      const sha = createHash("sha256")
        .update(Buffer.from(b.b64 || "", "base64"))
        .digest("hex");
      S.creds[b.path] = {
        seq: b.seq ?? 1,
        gen: S.gen,
        sha256: sha,
        mode: b.mode ?? 0o600,
        b64: b.b64 || "",
        deleted: false,
        at: Date.now(),
      };
      S.credSeq++;
      return sendJson(res, 200, { ok: true, sha256: sha });
    }
    if (p === "/_ctl/record") {
      const r = record(S, b);
      logRec(r);
      return sendJson(res, 200, { seq: r.seq });
    }
    if (p === "/_ctl/requestWake") {
      const r = requestWake(S, b.reason || "test");
      return sendJson(res, r.status, r.body);
    }
    if (p === "/_ctl/records") {
      const since = Number(u.searchParams.get("since") || 0);
      const plane = u.searchParams.get("plane");
      const route = u.searchParams.get("route");
      const out = S.records.filter(
        (r) => r.seq > since && (!plane || r.plane === plane) && (!route || String(r.route).includes(route)),
      );
      return sendJson(res, 200, out);
    }
    if (p === "/_ctl/state")
      return sendJson(res, 200, {
        inst: S.inst,
        gen: S.gen,
        seq: S.seq,
        genIid: S.genIid,
        uploads: S.uploads,
        seedBytes: S.seedBytes,
        tierBytes: S.tierBytes,
        mode: S.mode,
        restoreGens: S.restoreGens,
        creds: Object.fromEntries(
          Object.entries(S.creds).map(([k, v]) => [k, { ...v, b64: v.b64 ? `${v.b64.length} chars` : null }]),
        ),
        credsFull: u.searchParams.get("full") ? S.creds : undefined,
        config: S.config,
        finalSnapshots: S.finalSnapshots,
        alerts: S.alerts,
        faults: S.faults,
        wakes: S.wakes,
      });
    sendJson(res, 404, { error: "no route" });
  })
  .listen(9000, "0.0.0.0", () =>
    console.log(JSON.stringify({ ev: "fake-gate listening", ports: [80, 8002, 9000] })),
  );
