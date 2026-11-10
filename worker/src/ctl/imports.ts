// `ochost import` in the Control DO: the owner routes GET /ops/import and POST /ops/import/apply, the sleep hold
// while a request is open, and the stall rule. Rules shared with the ledger: gates/import-policy.ts. Uploads
// (PUT /ops/import/file, PUT /ops/import/bundle, GET /ops/import/files) run in the Worker (ops.ts), next to R2.
import {
  IMPORT_META,
  type ImportRequest,
  importBundleKey,
  importStalled,
  newRequest,
} from "../gates/import-policy";
import { alert } from "./alerts";
import type { OpsReq, OpsRes } from "./control";
import { type Ctx, ring } from "./ctx";

const read = (c: Ctx) => c.db.metaJson<ImportRequest | null>(IMPORT_META, null);

/** An open request that went silent fails once (alert `import-stalled`), so it never holds the sleep for long. */
export function importStallCheck(c: Ctx): ImportRequest | null {
  const r = read(c);
  if (!r || !importStalled(r, c.now())) return r;
  const out: ImportRequest = { ...r, state: "failed", doneAt: c.now(), why: `stalled: ${r.state}` };
  c.db.setMeta(IMPORT_META, out);
  ring(c, "import", "stalled", { id: r.id, tries: r.tries });
  alert(c, "import-stalled", "warn", `import ${r.id}: no answer from the container (${r.state})`);
  return out;
}

/** Sleep gate rule: an open request keeps the install awake until it ends or stalls. */
export function importSleepBlockers(c: Ctx): string[] {
  const r = importStallCheck(c);
  return r && (r.state === "pending" || r.state === "running") ? [`import:${r.id}`] : [];
}

/**
 * GET /ops/import → {request}; POST /ops/import/apply {id, sha256, bytes, overwrite?, cron?} → 202 and a wake.
 * A new apply replaces a closed request; an open one with another id is a 409 (one at a time).
 */
export async function opsImport(c: Ctx, r: OpsReq, wake: () => Promise<boolean>): Promise<OpsRes> {
  const sub = r.sub[0] ?? "";
  if (r.method === "GET" && sub === "") return { status: 200, body: { request: importStallCheck(c) } };
  if (r.method !== "POST" || sub !== "apply") return { status: 404, body: { error: "not found" } };
  const n = newRequest(r.body, c.now());
  if ("error" in n) return { status: 400, body: { error: n.error } };
  const cur = importStallCheck(c);
  if (cur && (cur.state === "pending" || cur.state === "running") && cur.id !== n.req.id)
    return { status: 409, body: { error: "import-open", request: cur } };
  if (
    cur &&
    cur.id === n.req.id &&
    cur.state !== "failed" &&
    cur.sha256 === n.req.sha256 &&
    cur.state !== "done"
  )
    return { status: 202, body: { ok: true, request: cur, same: true, woke: await wake() } };
  const head = await c.bucket.head(importBundleKey(c.inst, n.req.id));
  if (!head) return { status: 409, body: { error: "bundle-missing", hint: "PUT /ops/import/bundle first" } };
  if (head.size !== n.req.bytes)
    return { status: 409, body: { error: "bundle-size", detail: `${head.size} != ${n.req.bytes}` } };
  c.db.setMeta(IMPORT_META, n.req);
  ring(c, "import", "request", { id: n.req.id, bytes: n.req.bytes, cron: n.req.cron.length });
  return { status: 202, body: { ok: true, request: n.req, woke: await wake() } };
}
