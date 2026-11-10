// `ochost import` uploads (docs/10-cli-spec.md §1.2). They run in the Worker, next to the R2 binding, so a body
// up to files.maxObjectMb streams to R2 and never passes the Control DO:
//   PUT /ops/import/file?key=<rel>&sha256=<hex>   → f/<inst>/<rel>, caps and files_obj accounting in the ledger
//   PUT /ops/import/bundle?id=<id>&sha256=<hex>   → imp/<inst>/<id>.tar.gz (the workspace part)
//   GET /ops/import/files?prefix=<rel>&cursor=    → keys under f/<inst>/<prefix> with size and sha256
// Idempotent: an object that exists with the same sha256 is a 200 {skipped:true}; with another sha256 a 409
// (file storage never overwrites, docs/11 §8). R2 checks the sha256 the CLI sends (put option `sha256`).
import { filesPrefix } from "./core/contract";
import type { Env } from "./core/types";
import { IMPORT_BUNDLE_MAX, importBundleKey, importIdOk, keyOk } from "./gates/import-policy";

interface CtlGate {
  gateCall(m: string, args: unknown[]): Promise<unknown>;
}

const json = (b: unknown, status = 200) => Response.json(b, { status });
const SHA_RE = /^[0-9a-f]{64}$/;

export async function opsImportUpload(
  req: Request,
  env: Env,
  sub: string[],
  url: URL,
  ctl: CtlGate,
): Promise<Response> {
  const what = sub[0] ?? "";
  if (req.method === "GET" && what === "files") return listFiles(env, url);
  if (req.method !== "PUT" || (what !== "file" && what !== "bundle"))
    return json({ error: "not found" }, 404);
  const sha = url.searchParams.get("sha256") ?? "";
  if (!SHA_RE.test(sha)) return json({ error: "sha256 query required" }, 400);
  const len = Number(req.headers.get("content-length"));
  if (!Number.isInteger(len) || len < 0) return json({ error: "content-length required" }, 411);
  if (!req.body) return json({ error: "body required" }, 400);

  let key: string;
  if (what === "bundle") {
    const id = url.searchParams.get("id");
    if (!importIdOk(id)) return json({ error: "id" }, 400);
    if (len > IMPORT_BUNDLE_MAX) return json({ error: "bundle too large" }, 413);
    key = importBundleKey(env.OC_INST, id);
  } else {
    const rel = url.searchParams.get("key");
    if (!keyOk(rel)) return json({ error: "key: /-separated segments of letters, digits, . _ -" }, 400);
    key = `${filesPrefix(env.OC_INST)}${rel}`;
    const pre = (await ctl.gateCall("importFilePre", [{ key, bytes: len }])) as {
      refuse?: { status: number; code: string; message: string };
    };
    if (pre.refuse) return json({ error: pre.refuse.code, detail: pre.refuse.message }, pre.refuse.status);
  }

  const old = await env.BUCKET.head(key);
  if (old) {
    const same = old.customMetadata?.sha256 === sha;
    if (same || what === "file") {
      await req.body.cancel().catch(() => {});
      return same
        ? json({ ok: true, key, skipped: true })
        : json({ error: "exists", detail: "file storage never overwrites", key }, 409);
    }
  }
  // R2 stores only when the bytes hash to `sha256` (else it throws): a cut or changed upload never lands. A request
  // body with a content length is a known-length stream, which R2 takes as is.
  let o: R2Object | null;
  try {
    o = await env.BUCKET.put(key, req.body, {
      sha256: sha,
      customMetadata: { sha256: sha, src: "ochost-import" },
    });
  } catch (e) {
    return json({ error: "put-failed", detail: String((e as Error)?.message ?? e).slice(0, 200) }, 400);
  }
  if (!o) return json({ error: "put-failed" }, 500);
  if (what === "file")
    await ctl
      .gateCall("filesPost", [{ op: "PutObject", key, status: 200, bytes: len }])
      .catch(() => undefined);
  return json({ ok: true, key, bytes: len });
}

async function listFiles(env: Env, url: URL): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? "";
  if (prefix && !keyOk(prefix.replace(/\/$/, ""))) return json({ error: "prefix" }, 400);
  const base = filesPrefix(env.OC_INST);
  const l = await env.BUCKET.list({
    prefix: `${base}${prefix}`,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: 1000,
    include: ["customMetadata"],
  });
  return json({
    objects: l.objects.map((o) => ({
      key: o.key.slice(base.length),
      size: o.size,
      sha256: o.customMetadata?.sha256 ?? null,
    })),
    truncated: l.truncated,
    cursor: l.truncated ? l.cursor : null,
  });
}

interface SbxImport {
  importBundle(a: { key: string; id: string; overwrite: string[]; remove: string[] }): Promise<unknown>;
}
interface CtlOpsLike {
  ops(r: {
    action: string;
    method: string;
    sub: string[];
    query: Record<string, string>;
    body: Record<string, unknown>;
    role: "owner";
  }): Promise<{ status: number; body: unknown }>;
}

/**
 * POST /ops/import/sandbox {id}: after the container applied request `id`, merge the same bundle into the sandbox's
 * seeded workspaces (sbx/import.ts). No SANDBOX binding → {skipped}.
 */
export async function opsImportSandbox(
  env: Env,
  ctl: CtlOpsLike,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = body.id;
  if (!importIdOk(id)) return json({ error: "id" }, 400);
  if (!env.SANDBOX) return json({ ok: true, skipped: "no SANDBOX binding" });
  const g = await ctl.ops({ action: "import", method: "GET", sub: [], query: {}, body: {}, role: "owner" });
  const req = (
    g.body as { request?: { id: string; state: string; overwrite?: string[]; remove?: string[] } | null }
  ).request;
  if (!req || req.id !== id || req.state !== "done")
    return json(
      { error: "not-done", detail: `import ${id} must be done first (${req?.state ?? "none"})` },
      409,
    );
  const sb = env.SANDBOX.getByName(`sb:${env.OC_INST}`) as unknown as SbxImport;
  const r = await sb.importBundle({
    key: importBundleKey(env.OC_INST, id),
    id,
    overwrite: req.overwrite ?? [],
    remove: req.remove ?? [],
  });
  return json(r, (r as { ok?: boolean }).ok ? 200 : 502);
}
