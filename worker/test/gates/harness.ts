// Gate test world: Control DO SQLite (node:sqlite FakeStorage + ctl/schema DDL + GATE_DDL), GateLedger behind
// a structured-clone "RPC", FakeR2, a scripted Runtime DO, and an independent node:crypto SigV4 signer.
import { createHash, createHmac } from "node:crypto";
import { DDL } from "../../src/ctl/schema";
import { handleControlGate } from "../../src/gates/control";
import { dispatchGateCall, GateLedger, gatePort } from "../../src/gates/ledger";
import { ltxFile } from "../../src/gates/ltx";
import { handleReplicaGate } from "../../src/gates/replica";
import { GateCache, type GateDeps, type GateProps, type RtGatePort } from "../../src/gates/types";
import { FakeR2 } from "../harness/r2";
import { FakeStorage } from "../harness/storage";

export const INST = "t1";
export const SECRET = "a".repeat(64);
export const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

export const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
export const hmacHex = (k: string, m: string) => createHmac("sha256", k).update(m).digest("hex");
export const rid = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface RtCalls {
  hb: Record<string, unknown>[];
  ev: Record<string, unknown>[];
  bound: { gen: number; iid: string }[];
  final: number;
}

export function plan(gen: number, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    mode: "prod",
    gen,
    rootfs: { kind: "image" },
    sqlite: { kind: "fresh" },
    dbs: [],
    runDoctor: false,
    lockMode: "auto",
    ...extra,
  };
}

export class World {
  clock = { t: T0 };
  now = () => this.clock.t;
  st = new FakeStorage();
  ledger: GateLedger;
  r2 = new FakeR2(() => this.clock.t);
  rt: RtCalls = { hb: [], ev: [], bound: [], final: 0 };
  rtStop = false;
  rtGen: number | null = null;
  ctlDown = false;
  cache = new GateCache();
  props: GateProps;
  iid = rid();
  notes: Record<string, unknown>[] = [];

  constructor(
    o: {
      gen?: number;
      epoch?: number;
      mode?: "prod" | "canary";
      restoreGens?: number[];
      scale?: number;
    } = {},
  ) {
    for (const q of DDL) this.st.sql.exec(q);
    this.ledger = new GateLedger(this.st, { inst: INST, now: this.now, budgetScale: o.scale ?? 1 });
    this.ledger.migrate();
    const epoch = o.epoch ?? 1;
    this.st.sql.exec(
      "INSERT INTO epochs (n, image_key, digest, code_version, status, created_at) VALUES (?, 'oc', 'sha256:d', 'cv', 'active', ?)",
      epoch,
      T0,
    );
    this.props = {
      v: 1,
      inst: INST,
      epoch,
      gen: o.gen ?? 1,
      mode: o.mode ?? "prod",
      bootSecret: SECRET,
      restoreGens: o.restoreGens ?? [],
    };
    this.addGen(this.props.gen, epoch, o.mode ?? "prod");
  }

  addGen(gen: number, epoch = this.props.epoch, mode = "prod", state = "booting", p = plan(gen)) {
    this.st.sql.exec(
      `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
       VALUES (?, ?, ?, 'user', ?, ?, '[]', ?, ?, ?, 0, ?)`,
      gen,
      epoch,
      `op-${gen}`,
      mode,
      SECRET,
      JSON.stringify(p),
      (p.sqlite as { kind: string }).kind,
      state,
      this.now(),
    );
  }

  sql<T = Record<string, unknown>>(q: string, ...b: (string | number | null)[]): T[] {
    return this.st.sql.exec(q, ...b).toArray() as T[];
  }

  /** RPC stand-in: arguments and results go through structuredClone, as DO RPC serializes them. */
  ctlPort() {
    return gatePort(async (m, a) => {
      if (this.ctlDown) throw new Error("Durable Object reset (fake)");
      if (m === "noteHeartbeat") {
        this.notes.push(a[0] as Record<string, unknown>);
        return null;
      }
      return structuredClone(dispatchGateCall(this.ledger, m, structuredClone(a)));
    });
  }

  rtPort(): RtGatePort {
    return {
      onHeartbeat: async (b) => {
        this.rt.hb.push(b);
        return { ok: true, gen: this.rtGen ?? this.props.gen, ...(this.rtStop ? { stop: true } : {}) };
      },
      onEvent: async (b) => {
        this.rt.ev.push(b);
        return { ok: true };
      },
      bootBound: async (a) => {
        this.rt.bound.push(a);
      },
      finalSnapshot: async () => {
        if (this.rt.final++ > 0) return { status: 409, ok: false, error: "done" };
        return { status: 200, ok: true, snapshotId: "snap-final-1" };
      },
    };
  }

  deps(props: Partial<GateProps> = {}): GateDeps {
    return {
      props: { ...this.props, ...props },
      ctl: this.ctlPort(),
      rt: this.rtPort(),
      bucket: this.r2 as unknown as R2Bucket,
      bucketName: `oc-host-${INST}`,
      now: this.now,
      cache: this.cache,
    };
  }

  env(extra: Record<string, unknown> = {}) {
    return { inst: INST, epoch: this.props.epoch, gen: this.props.gen, bootId: "b1", ...extra };
  }

  /** ControlGate call as ocsup makes it (lib/gate.mjs): secret, iid after boot, envelope in JSON bodies. */
  async control(
    method: string,
    path: string,
    body?: unknown,
    o: {
      secret?: string | null;
      iid?: string | null;
      raw?: Uint8Array;
      headers?: Record<string, string>;
      props?: Partial<GateProps>;
    } = {},
  ): Promise<Response> {
    const h: Record<string, string> = {
      "content-type": o.raw ? "application/octet-stream" : "application/json",
      ...(o.headers ?? {}),
    };
    if (o.secret !== null) h["x-ocrt-secret"] = o.secret ?? SECRET;
    if (o.iid !== null && o.iid !== undefined) h["x-ocrt-iid"] = o.iid;
    const init: RequestInit = { method, headers: h };
    if (method !== "GET" && method !== "HEAD") init.body = o.raw ?? JSON.stringify(body ?? {});
    return handleControlGate(new Request(`http://15.0.0.1${path}`, init), this.deps(o.props));
  }

  /** hello + boot; returns the boot answer. Advances the clock 1 s so the hello rate allows the next one. */
  async boot(iid = this.iid): Promise<Response> {
    this.clock.t += 1000;
    return this.control("POST", "/v1/boot", this.env({ iid, pv: 1 }), { iid: null });
  }

  /** ReplicaGate call signed like Litestream through the replica proxy (host 127.0.0.1:18790). */
  async s3(
    method: string,
    target: string,
    o: {
      body?: Uint8Array | string;
      mode?: "hex" | "unsigned" | "trailer";
      keyGen?: number;
      keyIid?: string;
      secret?: string;
      date?: number;
      headers?: Record<string, string>;
      tamper?: (h: Record<string, string>) => void;
      props?: Partial<GateProps>;
      unsigned?: boolean;
      /** Declared x-amz-content-sha256 (overrides the mode). */
      payload?: string;
      /** Signed host (default the replica proxy; the files forwarder is 127.0.0.1:18792). */
      host?: string;
    } = {},
  ): Promise<Response> {
    const gen = o.keyGen ?? this.props.gen;
    const iid = o.keyIid ?? this.iid;
    const secret = o.secret ?? hmacHex(SECRET, `oc-replica\0${gen}\0${iid}`);
    const raw = typeof o.body === "string" ? new TextEncoder().encode(o.body) : o.body;
    const mode = o.mode ?? "unsigned";
    let wire = raw;
    const extra: Record<string, string> = { ...(o.headers ?? {}) };
    let payload = "UNSIGNED-PAYLOAD";
    if (mode === "hex") payload = sha(raw ?? new Uint8Array());
    if (mode === "trailer" && raw) {
      payload = "STREAMING-UNSIGNED-PAYLOAD-TRAILER";
      wire = awsChunk(raw);
      extra["content-encoding"] = "aws-chunked";
      extra["x-amz-decoded-content-length"] = String(raw.length);
      extra["x-amz-trailer"] = "x-amz-checksum-crc32";
    }
    if (o.payload) payload = o.payload;
    if (wire && method !== "GET" && method !== "HEAD") extra["content-length"] = String(wire.length);
    const h = o.unsigned
      ? { ...extra }
      : signRef({
          method,
          target,
          host: o.host ?? "127.0.0.1:18790",
          keyId: `ocrt-g${gen}-${iid}`,
          secret,
          payloadHash: payload,
          headers: extra,
          date: o.date ?? this.now(),
        });
    o.tamper?.(h);
    const hh = { ...h };
    delete hh.host; // the Request carries host from its URL; signRef signed 127.0.0.1:18790
    return handleReplicaGate(
      new Request(`http://15.0.0.2${target}`, {
        method,
        headers: hh,
        body: method === "GET" || method === "HEAD" ? undefined : wire,
      }),
      this.deps(o.props),
    );
  }
}

/** aws-chunked encoding with a CRC trailer, as aws-sdk-go-v2 sends STREAMING-UNSIGNED-PAYLOAD-TRAILER. */
export function awsChunk(b: Uint8Array, size = 8192): Uint8Array {
  const parts: Uint8Array[] = [];
  const te = new TextEncoder();
  for (let i = 0; i < b.length; i += size) {
    const c = b.subarray(i, i + size);
    parts.push(te.encode(`${c.length.toString(16)}\r\n`), c, te.encode("\r\n"));
  }
  parts.push(te.encode("0\r\nx-amz-checksum-crc32:AAAAAA==\r\n\r\n"));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const uriEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Reference SigV4 signer (node:crypto, independent of the WebCrypto verifier). Returns all headers to send. */
export function signRef(a: {
  method: string;
  target: string;
  host: string;
  keyId: string;
  secret: string;
  payloadHash: string;
  headers?: Record<string, string>;
  date: number;
  region?: string;
  signOnly?: string[];
}): Record<string, string> {
  const u = new URL(a.target, "http://x");
  const amz = new Date(a.date).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amz.slice(0, 8);
  const region = a.region ?? "auto";
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.headers ?? {})) h[k.toLowerCase()] = v;
  h.host = a.host;
  h["x-amz-date"] = amz;
  h["x-amz-content-sha256"] = a.payloadHash;
  const names = (a.signOnly ?? Object.keys(h)).map((x) => x.toLowerCase()).sort();
  const canonHeaders = names
    .map(
      (k) =>
        `${k}:${String(h[k] ?? "")
          .trim()
          .replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const q = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)]);
  q.sort((x, y) =>
    x[0] === y[0]
      ? (x[1] as string) < (y[1] as string)
        ? -1
        : 1
      : (x[0] as string) < (y[0] as string)
        ? -1
        : 1,
  );
  const canonQuery = q.map(([k, v]) => `${k}=${v}`).join("&");
  const canonPath = u.pathname
    .split("/")
    .map((s) => uriEncode(decodeURIComponent(s)))
    .join("/");
  const creq = [a.method, canonPath || "/", canonQuery, canonHeaders, names.join(";"), a.payloadHash].join(
    "\n",
  );
  const scope = `${day}/${region}/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amz, scope, sha(creq)].join("\n");
  const hm = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
  const kSig = hm(hm(hm(hm(`AWS4${a.secret}`, day), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", kSig).update(sts).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${a.keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
  return h;
}

export const ltxKey = (gen: number, db: string, level: number, min: number, max: number) =>
  `r/${INST}/g${gen}/${db}/${level.toString(16).padStart(4, "0")}/${min.toString(16).padStart(16, "0")}-${max.toString(16).padStart(16, "0")}.ltx`;
/** A valid LTX v0.5 object of `size` bytes whose header TXIDs match a key (the gate records only those). */
export const ltxBody = (min: number, max: number, size = 200) => ltxFile(min, max, Math.max(0, size - 116));
export const STATE_DB = "state/openclaw.sqlite";
export const AGENT_DB = "agents/main/agent/openclaw-agent.sqlite";
export const BUCKET = `oc-host-${INST}`;
export const path = (key: string) => `/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
