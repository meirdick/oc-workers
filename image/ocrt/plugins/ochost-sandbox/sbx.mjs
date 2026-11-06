#!/usr/bin/env node
// Transport client for the ochost sandbox backend (docs/12). Runs as uid 1000 in the gateway container.
// OpenClaw's remote-shell backend spawns `node sbx.mjs <gateUrl> <remoteCommand>` and talks /bin/sh over
// this process's stdin/stdout. Nothing of the command runs here: it runs in the SandboxSession container.
// Wire (SandboxGate POST /exec): request body = u32 BE header length, header JSON {v:1, cmd}, then stdin.
// Response 200 = frames: u8 type (1 stdout, 2 stderr, 3 exit), u32 BE length, payload. Exit payload JSON
// {code}. Any other status: JSON {error, ...}; exit 125 with the error on stderr.
const [gate, cmd] = process.argv.slice(2);
if (!gate || cmd === undefined) {
  process.stderr.write("usage: sbx.mjs <gateUrl> <remoteCommand>\n");
  process.exit(2);
}

const head = Buffer.from(JSON.stringify({ v: 1, cmd }));
const len = Buffer.alloc(4);
len.writeUInt32BE(head.length);
const ac = new AbortController();
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => ac.abort(new Error(s)));

const body = new ReadableStream({
  start(c) {
    c.enqueue(new Uint8Array(Buffer.concat([len, head])));
    process.stdin.on("data", (d) => c.enqueue(new Uint8Array(d)));
    process.stdin.on("end", () => c.close());
    process.stdin.on("error", () => c.close());
  },
});

const fail = (msg) => {
  process.stderr.write(`ochost sandbox: ${msg}\n`);
  process.exit(125);
};

let res;
try {
  res = await fetch(`${gate.replace(/\/+$/, "")}/exec`, {
    method: "POST",
    headers: { "content-type": "application/x-ochost-sbx" },
    body,
    duplex: "half",
    signal: ac.signal,
  });
} catch (e) {
  fail(`gate unreachable: ${e?.cause?.code ?? e?.message ?? e}`);
}
if (res.status !== 200) {
  const t = await res.text().catch(() => "");
  fail(`gate ${res.status} ${t.slice(0, 300)}`);
}

let buf = Buffer.alloc(0);
let code = null;
const write = (stream, b) => new Promise((r) => (stream.write(b) ? r() : stream.once("drain", r)));
try {
  for await (const chunk of res.body) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) break;
      const t = buf[0];
      const p = buf.subarray(5, 5 + n);
      buf = buf.subarray(5 + n);
      if (t === 1) await write(process.stdout, p);
      else if (t === 2) await write(process.stderr, p);
      else if (t === 3) code = Number(JSON.parse(p.toString("utf8")).code);
    }
  }
} catch (e) {
  fail(`stream cut: ${e?.message ?? e}`);
}
if (code === null || !Number.isInteger(code)) fail("no exit frame");
process.exit(code);
