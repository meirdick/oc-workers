// Property tests for the ReplicaGate SigV4 check (spec §18.2) over the Litestream 0.5.17 request shapes that
// M0 captured (spike/results/raw/T4/31-ev-replica-all.json: op + key of 4983 gate requests). A node:crypto
// reference signer signs each shape; the WebCrypto verifier must accept it, and must refuse every single
// mutation of a signed part. Unsigned headers may change freely.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonPathQuery, parseAuth, verifySigV4 } from "../../src/gates/sigv4";
import { hmacHex, rid, SECRET, sha, signRef } from "./harness";

interface Shape {
  op: string;
  key: string;
}
const RAW = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../spike/results/raw/T4/31-ev-replica-all.json",
);
function shapes(): Shape[] {
  const ev = (JSON.parse(readFileSync(RAW, "utf8")) as { events: { msg: string }[] }).events;
  return ev
    .map((e) => e.msg.split(" "))
    .filter((p) => p.length >= 2)
    .map((p) => ({ op: p[0] as string, key: p[2] ?? "" }));
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const GEN = 1;
const IID = "0123456789abcdef0123456789abcdef";
const KEY_SECRET = hmacHex(SECRET, `oc-replica\0${GEN}\0${IID}`);
const BUCKET = "oc-host-t1";
const ODD_AGENTS = ["main", "b100", "b1g", "a b", "x+y=z", "ünï", "q~_.-", "p%41"];

interface Req {
  method: string;
  target: string;
  headers: Record<string, string>; // as received (no host: the intercept URL host is 15.0.0.2)
  signed: string[];
}

function build(s: Shape, r: () => number): Req {
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)] as T;
  // Re-home the captured key and sometimes swap the agent id for an odd one (URL-encoding coverage).
  let key = s.key.replace(/^r\/[^/]+\/g\d+\//, `r/t1/g${GEN}/`);
  if (r() < 0.4) key = key.replace(/agents\/[^/]+\//, `agents/${pick(ODD_AGENTS)}/`);
  const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");
  const uploadId = `${rid()}~${rid().slice(0, 6)}.-_${pick(["", "=", "+/="])}`;
  const sdk = {
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": `attempt=${1 + Math.floor(r() * 3)}; max=3`,
  };
  const body = new TextEncoder().encode("x".repeat(Math.floor(r() * 300)));
  const payload = pick(["UNSIGNED-PAYLOAD", "STREAMING-UNSIGNED-PAYLOAD-TRAILER", sha(body)]);
  let method = "GET";
  let target = `/${BUCKET}/${enc(key)}`;
  const h: Record<string, string> = { ...sdk };
  switch (s.op) {
    case "ListObjectsV2": {
      const dir = `r/t1/g${GEN}/${pick(["state/openclaw.sqlite", "agents/b100/agent/openclaw-agent.sqlite"])}/${pick(["0000", "0001", "0009"])}/`;
      const q = new URLSearchParams({ "list-type": "2", prefix: dir });
      if (r() < 0.5) q.set("delimiter", "/");
      if (r() < 0.3) q.set("continuation-token", `${rid()}+/=`);
      if (r() < 0.3) q.set("start-after", `${dir}0000000000000001-0000000000000001.ltx`);
      target = `/${BUCKET}?${q.toString()}`;
      h["x-amz-content-sha256"] = sha("");
      break;
    }
    case "HeadObject":
      method = "HEAD";
      h["x-amz-content-sha256"] = sha("");
      break;
    case "GetObject":
      if (r() < 0.5) h.range = `bytes=${Math.floor(r() * 100)}-`;
      h["x-amz-content-sha256"] = sha("");
      break;
    case "PutObject":
    case "UploadPart":
      method = "PUT";
      if (s.op === "UploadPart")
        target += `?partNumber=${1 + Math.floor(r() * 9)}&uploadId=${encodeURIComponent(uploadId)}`;
      h["content-type"] = "application/octet-stream";
      h["content-length"] = String(body.length);
      h["x-amz-content-sha256"] = payload;
      if (payload.startsWith("STREAMING")) {
        h["content-encoding"] = "aws-chunked";
        h["x-amz-decoded-content-length"] = String(body.length);
        h["x-amz-trailer"] = "x-amz-checksum-crc32";
      }
      break;
    case "CreateMultipartUpload":
      method = "POST";
      target += "?uploads";
      h["x-amz-content-sha256"] = sha("");
      break;
    case "CompleteMultipartUpload":
      method = "POST";
      target += `?uploadId=${encodeURIComponent(uploadId)}`;
      h["content-type"] = "application/xml";
      h["x-amz-content-sha256"] = sha("<CompleteMultipartUpload/>");
      break;
    case "DeleteObjects":
      method = "POST";
      target = `/${BUCKET}?delete`;
      h["content-md5"] = "1B2M2Y8AsgTpgAmY7PhCfg==";
      h["x-amz-content-sha256"] = sha("<Delete/>");
      break;
    default:
      throw new Error(`unexpected op ${s.op}`);
  }
  const date = NOW + Math.floor((r() - 0.5) * 28 * 60_000);
  const signed = signRef({
    method,
    target,
    host: "127.0.0.1:18790",
    keyId: `ocrt-g${GEN}-${IID}`,
    secret: KEY_SECRET,
    payloadHash: h["x-amz-content-sha256"] as string,
    headers: h,
    date,
  });
  const names = parseAuth(signed.authorization ?? null)?.signed ?? [];
  const recv = {
    ...signed,
    "user-agent": "aws-sdk-go-v2/1.36 litestream/0.5.17",
    "accept-encoding": "identity",
  };
  delete (recv as Record<string, string>).host;
  return { method, target, headers: recv, signed: names };
}

async function verify(q: Req, secret = KEY_SECRET) {
  const auth = parseAuth(q.headers.authorization ?? null);
  if (!auth) return { ok: false, why: "no-auth" };
  return verifySigV4({
    method: q.method,
    rawPathAndQuery: q.target,
    headers: q.headers,
    auth,
    secret,
    hostCandidates: ["15.0.0.2", "127.0.0.1:18790"],
  });
}

type Mut = { name: string; f: (q: Req, r: () => number) => Req | null };
const clone = (q: Req): Req => ({ ...q, headers: { ...q.headers }, signed: [...q.signed] });
const MUTS: Mut[] = [
  { name: "method", f: (q) => ({ ...clone(q), method: q.method === "PUT" ? "POST" : "PUT" }) },
  {
    name: "path",
    f: (q) => {
      const u = new URL(q.target, "http://x");
      const p = u.pathname;
      const i = p.lastIndexOf("/") + 1;
      if (i >= p.length) return { ...clone(q), target: `${p}x${u.search}` };
      const c = p[i] === "a" ? "b" : "a";
      return { ...clone(q), target: `${p.slice(0, i)}${c}${p.slice(i + 1)}${u.search}` };
    },
  },
  {
    name: "query-add",
    f: (q) => ({ ...clone(q), target: `${q.target}${q.target.includes("?") ? "&" : "?"}x-id=PutObject` }),
  },
  {
    name: "query-value",
    f: (q) => {
      const u = new URL(q.target, "http://x");
      const k = [...u.searchParams.keys()].find((x) => u.searchParams.get(x) !== "");
      if (!k) return null;
      u.searchParams.set(k, `${u.searchParams.get(k)}1`);
      return { ...clone(q), target: `${u.pathname}?${u.searchParams.toString()}` };
    },
  },
  {
    name: "signed-header",
    f: (q, r) => {
      const names = q.signed.filter((n) => n !== "host" && n !== "x-amz-date");
      const n = names[Math.floor(r() * names.length)];
      if (!n) return null;
      const o = clone(q);
      o.headers[n] = `${o.headers[n] ?? ""}0`;
      return o;
    },
  },
  {
    name: "date",
    f: (q) => {
      const o = clone(q);
      const d = o.headers["x-amz-date"] as string;
      o.headers["x-amz-date"] = `${d.slice(0, 14)}${(Number(d[14]) + 1) % 10}Z`;
      return o;
    },
  },
  {
    name: "signature",
    f: (q) => {
      const o = clone(q);
      o.headers.authorization = (o.headers.authorization as string).replace(
        /Signature=([0-9a-f])/,
        (_, c: string) => `Signature=${c === "0" ? "1" : "0"}`,
      );
      return o;
    },
  },
];

describe("SigV4 verify over M0 Litestream shapes (property)", () => {
  const all = shapes();
  it("the M0 raw file has the 8 Litestream ops", () => {
    expect(new Set(all.map((s) => s.op))).toEqual(
      new Set([
        "UploadPart",
        "ListObjectsV2",
        "PutObject",
        "HeadObject",
        "GetObject",
        "DeleteObjects",
        "CreateMultipartUpload",
        "CompleteMultipartUpload",
      ]),
    );
  });

  it("accepts every signed shape and refuses every mutation of a signed part", async () => {
    const r = prng(20261031);
    // Stratified sample: 60 shapes per op (with replacement), deterministic.
    const byOp = new Map<string, Shape[]>();
    for (const s of all) byOp.set(s.op, [...(byOp.get(s.op) ?? []), s]);
    const sample: Shape[] = [];
    for (const ss of byOp.values())
      for (let i = 0; i < 60; i++) sample.push(ss[Math.floor(r() * ss.length)] as Shape);
    let checked = 0;
    let mutated = 0;
    const bad: string[] = [];
    for (const s of sample) {
      const q = build(s, r);
      const v = await verify(q);
      if (!v.ok) bad.push(`accept ${s.op} ${q.target}`);
      checked++;
      // unsigned headers may change
      const o = clone(q);
      o.headers["user-agent"] = "other";
      if (!(await verify(o)).ok) bad.push(`unsigned ${s.op}`);
      for (const m of MUTS) {
        const mq = m.f(q, r);
        if (!mq) continue;
        mutated++;
        if ((await verify(mq)).ok) bad.push(`mutation ${m.name} accepted: ${s.op} ${mq.target}`);
      }
      // a key of another gen or iid never verifies with this secret
      if ((await verify(q, hmacHex(SECRET, `oc-replica\0${GEN + 1}\0${IID}`))).ok)
        bad.push(`other-gen ${s.op}`);
    }
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(400);
    expect(mutated).toBeGreaterThanOrEqual(checked * 6);
  });

  it("canonical path keeps RFC 3986 encoding for odd agent ids", () => {
    expect(canonPathQuery("/b/agents/a%20b/x?uploads").path).toBe("/b/agents/a%20b/x");
    expect(canonPathQuery("/b?uploads").query).toBe("uploads=");
    expect(canonPathQuery("/b/k?b=2&a=1&a=0").query).toBe("a=0&a=1&b=2");
    expect(canonPathQuery("/b/x%2By").path).toBe("/b/x%2By");
  });

  it("host: as received, else the proxy host, else refused", async () => {
    const q = build(
      { op: "PutObject", key: "r/t1/g1/state/openclaw.sqlite/0000/0000000000000001-0000000000000001.ltx" },
      prng(7),
    );
    expect((await verify({ ...q, headers: { ...q.headers, host: "127.0.0.1:18790" } })).ok).toBe(true);
    expect((await verify({ ...q, headers: { ...q.headers } })).ok).toBe(true); // no host → candidates
    const auth = parseAuth(q.headers.authorization ?? null);
    const noFallback = await verifySigV4({
      method: q.method,
      rawPathAndQuery: q.target,
      headers: { ...q.headers, host: "15.0.0.2" },
      auth: auth as NonNullable<typeof auth>,
      secret: KEY_SECRET,
      hostCandidates: [],
    });
    expect(noFallback.ok).toBe(false);
    // signed for a host that is neither received nor a candidate → refused
    const evil = signRef({
      method: "PUT",
      target: q.target,
      host: "evil.example",
      keyId: `ocrt-g${GEN}-${IID}`,
      secret: KEY_SECRET,
      payloadHash: "UNSIGNED-PAYLOAD",
      date: NOW,
    });
    delete (evil as Record<string, string>).host;
    expect((await verify({ ...q, method: "PUT", headers: evil })).ok).toBe(false);
  });
});
