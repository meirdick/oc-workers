// SandboxGate wire (docs/12 §4). Same format as image/ocrt/plugins/ochost-sandbox/sbx.mjs.
// Request body: u32 BE header length, header JSON {v: 1, cmd}, then the command's stdin.
// Response body: frames of u8 type, u32 BE length, payload. Type 1 stdout, 2 stderr, 3 exit (JSON {code}).
export const OUT = 1;
export const ERR = 2;
export const EXIT = 3;
/** Header limit: the remote command is a short sh line; the SDK stages scripts over stdin. */
export const MAX_HEAD = 256 * 1024;

export interface ExecHead {
  v: 1;
  cmd: string;
}

export function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.byteLength);
  out.set(payload, 5);
  return out;
}

export const exitFrame = (code: number) => frame(EXIT, new TextEncoder().encode(JSON.stringify({ code })));

/**
 * Read the header off the front of `body`. Returns the header and a stream of the bytes after it (stdin).
 * Throws on a short body, a header over MAX_HEAD, bad JSON or a bad shape.
 */
export async function readHead(
  body: ReadableStream<Uint8Array>,
): Promise<{ head: ExecHead; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  const pull = async (n: number) => {
    while (buf.byteLength < n) {
      const r = await reader.read();
      if (r.done) throw new Error("short body");
      const next = new Uint8Array(buf.byteLength + r.value.byteLength);
      next.set(buf);
      next.set(r.value, buf.byteLength);
      buf = next;
    }
  };
  await pull(4);
  const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
  if (n === 0 || n > MAX_HEAD) throw new Error("bad header length");
  await pull(4 + n);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n))) as ExecHead;
  if (head?.v !== 1 || typeof head.cmd !== "string" || !head.cmd || head.cmd.includes("\0"))
    throw new Error("bad header");
  const left = buf.subarray(4 + n);
  const rest = new ReadableStream<Uint8Array>({
    start(c) {
      if (left.byteLength) c.enqueue(left);
    },
    async pull(c) {
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(why) {
      return reader.cancel(why);
    },
  });
  return { head, rest };
}

/** Encode a request body (tests, and any Worker-side caller). */
export function encodeRequest(cmd: string, stdin: Uint8Array = new Uint8Array(0)): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify({ v: 1, cmd }));
  const out = new Uint8Array(4 + h.byteLength + stdin.byteLength);
  new DataView(out.buffer).setUint32(0, h.byteLength);
  out.set(h, 4);
  out.set(stdin, 4 + h.byteLength);
  return out;
}

/** Decode a whole response body into stdout, stderr and the exit code (null = no exit frame). */
export function decodeFrames(b: Uint8Array): { stdout: string; stderr: string; code: number | null } {
  const dec = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  let i = 0;
  while (i + 5 <= b.byteLength) {
    const t = b[i] as number;
    const n = new DataView(b.buffer, b.byteOffset + i + 1).getUint32(0);
    if (i + 5 + n > b.byteLength) break;
    const p = b.subarray(i + 5, i + 5 + n);
    if (t === OUT) stdout += dec.decode(p);
    else if (t === ERR) stderr += dec.decode(p);
    else if (t === EXIT) code = Number((JSON.parse(dec.decode(p)) as { code: number }).code);
    i += 5 + n;
  }
  return { stdout, stderr, code };
}
