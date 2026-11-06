// aws-chunked body decoder (from spike/worker/src/gates/replica.ts): "<hex>[;chunk-signature=..]\r\n<data>\r\n
// ... 0\r\n<trailers>\r\n\r\n". Trailer checksums are ignored (spec §18.2).

export function isAwsChunked(h: Record<string, string>): boolean {
  return (
    /aws-chunked/i.test(h["content-encoding"] ?? "") || /^STREAMING-/i.test(h["x-amz-content-sha256"] ?? "")
  );
}

export function awsChunkedDecoder(): TransformStream<Uint8Array, Uint8Array> {
  let buf = new Uint8Array(0);
  let mode: "header" | "data" | "crlf" | "done" = "header";
  let remaining = 0;
  const cat = (a: Uint8Array, b: Uint8Array) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a);
    o.set(b, a.length);
    return o;
  };
  return new TransformStream({
    transform(chunk, ctl) {
      buf = cat(buf, chunk);
      for (;;) {
        if (mode === "done") {
          buf = new Uint8Array(0);
          return;
        }
        if (mode === "header") {
          let i = -1;
          for (let j = 0; j + 1 < buf.length; j++)
            if (buf[j] === 13 && buf[j + 1] === 10) {
              i = j;
              break;
            }
          if (i < 0) return;
          const line = new TextDecoder().decode(buf.subarray(0, i));
          buf = buf.subarray(i + 2);
          const size = Number.parseInt(line.split(";")[0] ?? "", 16);
          if (!Number.isFinite(size) || size < 0) {
            ctl.error(new Error(`bad aws-chunked header: ${line.slice(0, 80)}`));
            return;
          }
          if (size === 0) mode = "done";
          else {
            remaining = size;
            mode = "data";
          }
        } else if (mode === "data") {
          const take = Math.min(remaining, buf.length);
          if (take === 0) return;
          ctl.enqueue(buf.slice(0, take));
          buf = buf.subarray(take);
          remaining -= take;
          if (remaining === 0) mode = "crlf";
        } else {
          if (buf.length < 2) return;
          buf = buf.subarray(2);
          mode = "header";
        }
      }
    },
    flush(ctl) {
      if (mode === "data" || mode === "crlf") ctl.error(new Error("aws-chunked body ended early"));
    },
  });
}

/** Whole-buffer decode (tests and small bodies). */
export async function decodeAwsChunked(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b]).stream().pipeThrough(awsChunkedDecoder());
  return new Uint8Array(await new Response(s).arrayBuffer());
}
