// S3 XML answers for ReplicaGate (from spike/worker/src/gates/replica.ts). Path style only.

export const XML = { "content-type": "application/xml" };
export const NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
const ENT: Record<string, string> = { "<": "lt", ">": "gt", "&": "amp", "'": "apos", '"': "quot" };

export const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&${ENT[c]};`);
export const xmlUnescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");

export function s3Error(status: number, code: string, message: string, resource = ""): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><Resource>${xmlEscape(resource)}</Resource></Error>`,
    { status, headers: XML },
  );
}

export const etagQ = (e: string) => (e.startsWith('"') ? e : `"${e}"`);
export const unq = (e: string) => e.replace(/^"|"$/g, "");

export function parseParts(xml: string): { partNumber: number; etag: string }[] {
  const out: { partNumber: number; etag: string }[] = [];
  for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const blk = m[1] ?? "";
    const n = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(blk)?.[1];
    const e = /<ETag>([\s\S]*?)<\/ETag>/.exec(blk)?.[1];
    if (n && e) out.push({ partNumber: Number(n), etag: unq(xmlUnescape(e.trim())) });
  }
  return out.sort((a, b) => a.partNumber - b.partNumber);
}

export function parseDelete(xml: string): { keys: string[]; quiet: boolean } {
  return {
    quiet: /<Quiet>\s*true\s*<\/Quiet>/i.test(xml),
    keys: [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => xmlUnescape(m[1] ?? "")),
  };
}

export function deleteResult(
  quiet: boolean,
  deleted: string[],
  errors: { key: string; code: string; message: string }[],
): Response {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult ${NS}>` +
    (quiet ? "" : deleted.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join("")) +
    errors
      .map(
        (e) =>
          `<Error><Key>${xmlEscape(e.key)}</Key><Code>${e.code}</Code><Message>${xmlEscape(e.message)}</Message></Error>`,
      )
      .join("") +
    "</DeleteResult>";
  return new Response(body, { headers: XML });
}

export function parseRange(
  h: string | null,
): { offset: number; length?: number } | { suffix: number } | undefined | "bad" {
  if (!h) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return "bad";
  const [, a, b] = m;
  if (a === "" && b === "") return "bad";
  if (a === "") return { suffix: Number(b) };
  const offset = Number(a);
  if (b === "") return { offset };
  if (Number(b) < offset) return "bad";
  return { offset, length: Number(b) - offset + 1 };
}

export interface ListedObj {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
}

export function listXml(o: {
  bucket: string;
  prefix: string;
  max: number;
  delimiter?: string;
  urlEnc: boolean;
  token?: string;
  startAfter?: string;
  objects: ListedObj[];
  prefixes: string[];
  truncated: boolean;
  next?: string;
}): Response {
  const enc = (s: string) => xmlEscape(o.urlEnc ? encodeURIComponent(s).replace(/%2F/g, "/") : s);
  const contents = o.objects
    .map(
      (x) =>
        `<Contents><Key>${enc(x.key)}</Key><LastModified>${x.uploaded.toISOString()}</LastModified><ETag>${xmlEscape(etagQ(x.etag))}</ETag><Size>${x.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  const cps = o.prefixes.map((p) => `<CommonPrefixes><Prefix>${enc(p)}</Prefix></CommonPrefixes>`).join("");
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult ${NS}>` +
    `<Name>${xmlEscape(o.bucket)}</Name><Prefix>${enc(o.prefix)}</Prefix>` +
    `<KeyCount>${o.objects.length + o.prefixes.length}</KeyCount><MaxKeys>${o.max}</MaxKeys>` +
    (o.delimiter ? `<Delimiter>${enc(o.delimiter)}</Delimiter>` : "") +
    (o.urlEnc ? "<EncodingType>url</EncodingType>" : "") +
    `<IsTruncated>${o.truncated}</IsTruncated>` +
    (o.token ? `<ContinuationToken>${xmlEscape(o.token)}</ContinuationToken>` : "") +
    (o.truncated && o.next ? `<NextContinuationToken>${xmlEscape(o.next)}</NextContinuationToken>` : "") +
    (o.startAfter ? `<StartAfter>${enc(o.startAfter)}</StartAfter>` : "") +
    contents +
    cps +
    "</ListBucketResult>";
  return new Response(body, { headers: XML });
}

export const initiateXml = (bucket: string, key: string, uploadId: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<InitiateMultipartUploadResult ${NS}><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(uploadId)}</UploadId></InitiateMultipartUploadResult>`,
    { headers: XML },
  );

export const completeXml = (bucket: string, key: string, etag: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUploadResult ${NS}><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etagQ(etag))}</ETag></CompleteMultipartUploadResult>`,
    { headers: XML },
  );
