// Boot-time credential restore from the CredStore (plan §6.2 step 8; §6.1 row 2 "never restored from a
// snapshot or archive when the store holds the path"). Runs before credsync starts. For each live manifest
// path whose local bytes differ (or are missing), the store version is written by ocio; each tombstoned path
// present on disk is removed. Paths the store does not know stay (credsync uploads them as new).
// M4 loss drill: without this step a rootfs older than the store (archive, older snapshot) made the reconcile
// scan tombstone the newer files and re-upload the old bytes (creds rolled back; creds.json lost → relink).
import { credRoute } from "./credsync.mjs";

/**
 * o: {man: {seq, files:[{path, sha256, mode, deleted}]}, state, gate: {call(m, route, body, opts)},
 *     ocio(name, args, opts) → {json, code, err}}
 * Returns {ok, put, del, bad, why?}. ok:false → the caller blocks the boot (restore-blocked:infra).
 */
export async function restoreCreds(o) {
  const files = o.man?.files || [];
  const live = files.filter((f) => !f.deleted);
  const dead = files.filter((f) => f.deleted).map((f) => f.path);
  if (!files.length) return { ok: true, put: 0, del: 0, bad: [] };
  const s = await o.ocio("creds-io", [
    "shas",
    JSON.stringify({ state: o.state, rels: live.map((f) => f.path) }),
  ]);
  if (!s.json?.sha) return { ok: false, why: `shas: ${s.json?.error || s.err || s.code}`.slice(0, 200) };
  const need = live.filter((f) => s.json.sha[f.path] !== f.sha256);
  const put = [];
  for (const f of need) {
    let g;
    try {
      g = await o.gate.call("GET", credRoute(f.path), null, { timeoutMs: 15_000 });
    } catch (e) {
      return { ok: false, why: `get ${f.path}: ${String(e.message || e).slice(0, 120)}` };
    }
    if (!g || typeof g.b64 !== "string") return { ok: false, why: `get ${f.path}: no body` };
    put.push({ rel: f.path, b64: g.b64, sha256: g.sha256, mode: f.mode });
  }
  if (!put.length && !dead.length) return { ok: true, put: 0, del: 0, bad: [] };
  const r = await o.ocio("creds-io", ["apply", JSON.stringify({ state: o.state })], {
    stdin: JSON.stringify({ put, del: dead }),
  });
  if (!r.json || r.json.error)
    return { ok: false, why: `apply: ${r.json?.error || r.err || r.code}`.slice(0, 200) };
  return {
    ok: r.json.bad.length === 0,
    put: r.json.written.length,
    del: r.json.deleted.length,
    bad: r.json.bad,
    why: r.json.bad.length ? `bad ${JSON.stringify(r.json.bad).slice(0, 160)}` : undefined,
  };
}
