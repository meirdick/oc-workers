// Drill J (M4b): a Control DO whose storage was replaced (ctl-rewound) rebuilds its index from R2, so the install
// boots from its data and does not stop at restore-blocked:rewound. Sources: r/<inst>/g<gen>/ (gens and their
// DBs, from the LTX key names), a/<inst>/ (archives; index facts from the `<key>.json` sidecar, else the newest
// one is re-hashed), c/<inst>/config.json (config versions), c/<inst>/<seq>.json (creds, creds-copy.ts),
// meta/<inst>/installed (initialized) and meta/<inst>/hwm (gen counter, epoch). Snapshots and the inbox live only
// in the Control DO and are not rebuilt: the boot takes the newest verified archive plus the newest complete gen.
import { parseLtxKey } from "../core/contract";
import { randomHex } from "../core/ids";
import { sidecarKey } from "../gates/archive-policy";
import { shaDigest, shaInit, shaUpdate } from "../gates/sha256";
import { alert } from "./alerts";
import { VERIFY_MAX_BYTES } from "./archives";
import { type ConfigCopy, configCopyKey } from "./creds-copy";
import { type Ctx, ring, STATE_DB } from "./ctx";
import { hwmKey, installedKey } from "./gens";

export interface RebuildReport {
  at: number;
  gens: number;
  completeGens: number;
  newestGen: number | null;
  archives: number;
  archivesHashed: number;
  archivesNoSha: number;
  config: number;
  installed: boolean;
  epoch: number | null;
  ok: boolean;
  error?: string;
}

const PAGES = 100;

async function listAll(c: Ctx, prefix: string) {
  const out: { key: string; size: number; uploaded?: Date }[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < PAGES; p++) {
    const r = await c.bucket.list({ prefix, cursor, limit: 1000 });
    out.push(...r.objects);
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
}

/** `20261101T151159Z` at the start of an archive file name → ms. */
function keyTime(key: string): number | null {
  const m = /\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z[^/]*$/.exec(key);
  if (!m) return null;
  const n = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(n[0], n[1] - 1, n[2], n[3], n[4], n[5]);
  return Number.isFinite(t) ? t : null;
}

async function sha256Of(c: Ctx, key: string): Promise<{ sha: string; size: number } | null> {
  const o = await (
    c.bucket as unknown as {
      get(k: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
    }
  ).get(key);
  if (!o) return null;
  let st = shaInit();
  const rd = o.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    st = shaUpdate(st, value);
  }
  return { sha: shaDigest(st), size: o.size };
}

export async function rebuildIndex(c: Ctx): Promise<RebuildReport> {
  const now = c.now();
  const rep: RebuildReport = {
    at: now,
    gens: 0,
    completeGens: 0,
    newestGen: null,
    archives: 0,
    archivesHashed: 0,
    archivesNoSha: 0,
    config: 0,
    installed: false,
    epoch: null,
    ok: false,
  };
  try {
    // hwm and install marker.
    const h = await c.bucket.get(hwmKey(c.inst));
    const hwm = h ? (JSON.parse(await h.text()) as { gen?: number; epoch?: number }) : {};
    rep.installed = !!(await c.bucket.head(installedKey(c.inst)));

    // Gens from the LTX key names.
    type G = { dbs: Map<string, { max: number; bytes: number; last: number }>; first: number; last: number };
    const gens = new Map<number, G>();
    for (const o of await listAll(c, `r/${c.inst}/`)) {
      const k = parseLtxKey(o.key);
      if (!k) continue;
      const t = o.uploaded ? o.uploaded.getTime() : now;
      const g = gens.get(k.gen) ?? { dbs: new Map(), first: t, last: t };
      g.first = Math.min(g.first, t);
      g.last = Math.max(g.last, t);
      const d = g.dbs.get(k.db) ?? { max: 0, bytes: 0, last: t };
      d.max = Math.max(d.max, k.maxTxid);
      d.bytes += o.size;
      d.last = Math.max(d.last, t);
      g.dbs.set(k.db, d);
      gens.set(k.gen, g);
    }
    const epoch = hwm.epoch ?? (c.db.meta("pointer") === null ? 1 : Number(c.db.meta("pointer")));
    rep.epoch = epoch;

    // Archives and their sidecars.
    const objs = await listAll(c, `a/${c.inst}/`);
    const sidecars = new Map(objs.filter((o) => o.key.endsWith(".json")).map((o) => [o.key, o]));
    const tars = objs.filter((o) => o.key.endsWith(".tar.gz"));
    const cars = new Map<string, Record<string, any>>();
    for (const t of tars) {
      const sk = sidecarKey(t.key);
      if (!sidecars.has(sk)) continue;
      try {
        const o = await c.bucket.get(sk);
        if (o) cars.set(t.key, JSON.parse(await o.text()) as Record<string, any>);
      } catch {}
    }
    // Newest archive without a sidecar sha → re-hash it (one per rebuild; others stay out of the plan).
    const byTime = tars
      .map((t) => ({ t, at: (cars.get(t.key)?.created_at as number | undefined) ?? keyTime(t.key) ?? now }))
      .sort((a, b) => b.at - a.at);
    const hashed = new Map<string, string>();
    const newestNoSha = byTime.find((x) => !cars.get(x.t.key)?.sha256);
    if (newestNoSha && newestNoSha === byTime[0] && newestNoSha.t.size <= VERIFY_MAX_BYTES) {
      const r = await sha256Of(c, newestNoSha.t.key);
      if (r) hashed.set(newestNoSha.t.key, r.sha);
    }

    // Config copy.
    let cfg: ConfigCopy | null = null;
    try {
      const o = await c.bucket.get(configCopyKey(c.inst));
      if (o) cfg = JSON.parse(await o.text()) as ConfigCopy;
    } catch {}

    c.db.tx(() => {
      // Epoch: a wiped DO installed epoch 1; the hwm names the live one.
      const eps = c.db.all<{ n: number; reason: string | null }>("SELECT n, reason FROM epochs");
      const only = eps.length === 1 ? eps[0] : null;
      if (
        only &&
        only.reason === "install" &&
        only.n !== epoch &&
        !c.db.one("SELECT gen FROM gens LIMIT 1")
      ) {
        c.db.run("UPDATE epochs SET n = ? WHERE n = ?", epoch, only.n);
        c.db.setMeta("pointer", epoch);
      }
      for (const [gen, g] of [...gens.entries()].sort((a, b) => a[0] - b[0])) {
        if (c.db.one("SELECT gen FROM gens WHERE gen = ?", gen)) continue;
        const complete = g.dbs.has(STATE_DB);
        c.db.run(
          `INSERT INTO gens (gen, epoch, op_id, reason, mode, image_key, digest, secret, restore_gens, plan, plan_kind,
             state, unplanned, issued_at, complete_at, started_at, ended_at)
           VALUES (?, ?, ?, 'rebuild', 'prod', NULL, NULL, ?, '[]', '{}', 'rebuild', ?, 0, ?, ?, ?, ?)`,
          gen,
          epoch,
          `rebuild-g${gen}`,
          randomHex(32),
          complete ? "complete" : "abandoned",
          g.first,
          complete ? g.first : null,
          g.first,
          g.last,
        );
        for (const [db, d] of g.dbs)
          c.db.run(
            `INSERT INTO gendb (gen, db, in_boot_set, state, l0_max_txid, last_txid, bytes, last_write_at)
             VALUES (?, ?, 1, 'uploaded', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            gen,
            db,
            d.max,
            d.max,
            d.bytes,
            d.last,
          );
        rep.gens++;
        if (complete) {
          rep.completeGens++;
          rep.newestGen = Math.max(rep.newestGen ?? 0, gen);
        }
      }
      for (const { t, at } of byTime) {
        if (c.db.one("SELECT id FROM archives WHERE key = ?", t.key)) continue;
        const s = cars.get(t.key) ?? {};
        const sha = (s.sha256 as string | undefined) ?? hashed.get(t.key) ?? null;
        const id =
          (s.id as string | undefined) ?? `${t.key.split("/").pop()?.slice(0, 16)}-rb${randomHex(3)}`;
        c.db.run(
          `INSERT INTO archives (id, key, kind, state, sha256, size, parts, version, digest, state_schema, agent_schema,
             txid, plugins_ver, gen, created_at, completed_at, reason, ws_entries, ws_missing, src_write_at,
             verified_at, verified_by, bad_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          t.key,
          (s.kind as string | undefined) ?? "online",
          sha ? "complete" : "bad",
          sha,
          t.size,
          (s.parts as number | undefined) ?? null,
          (s.version as string | undefined) ?? null,
          (s.digest as string | undefined) ?? null,
          (s.state_schema as number | undefined) ?? null,
          (s.agent_schema as number | undefined) ?? null,
          (s.txid as string | undefined) ?? "{}",
          (s.plugins_ver as number | undefined) ?? null,
          (s.gen as number | undefined) ?? null,
          at,
          (s.completed_at as number | undefined) ?? at,
          (s.reason as string | undefined) ?? "rebuild",
          (s.ws_entries as number | undefined) ?? null,
          (s.ws_missing as number | undefined) ?? null,
          (s.src_write_at as number | undefined) ?? null,
          hashed.has(t.key) ? now : null,
          hashed.has(t.key) ? "rebuild" : null,
          sha ? null : "rebuild: no sidecar sha",
        );
        rep.archives++;
        if (hashed.has(t.key)) rep.archivesHashed++;
        if (!sha) rep.archivesNoSha++;
      }
      for (const r of cfg?.rows ?? []) {
        if (c.db.one("SELECT ver FROM config WHERE ver = ?", r.ver)) continue;
        c.db.run(
          `INSERT INTO config (ver, schema_sha, status, source, sha, dark_origin, base_ver, doc, good_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.ver,
          r.schema_sha,
          r.status,
          r.source,
          r.sha,
          r.dark_origin,
          r.base_ver,
          r.doc,
          r.good_digest,
          r.created_at,
        );
        rep.config++;
      }
      const maxGen = Math.max(hwm.gen ?? 0, ...gens.keys(), c.db.metaNum("genCounter", 0));
      c.db.setMeta("genCounter", maxGen);
      if (rep.installed) {
        c.db.setMeta("initialized", 1);
        c.db.setMeta("installMarker", "1");
      }
      // ok when this run put R2 data in the index (a rewound DO with nothing newer in R2 stays rewound).
      rep.ok = rep.completeGens > 0 || rep.archives - rep.archivesNoSha > 0;
      if (rep.ok) c.db.setMeta("ctlState", "ctl-rebuilt");
      c.db.setMeta("rebuild", rep);
    });
  } catch (e) {
    rep.error = String(e).slice(0, 200);
    ring(c, "rebuild", "error", rep.error);
    return rep;
  }
  ring(c, "rebuild", "done", rep);
  alert(
    c,
    "ctl-rebuilt",
    "high",
    rep.ok
      ? `index rebuilt from R2: ${rep.completeGens} gens (newest ${rep.newestGen}), ${rep.archives} archives, ${rep.config} config versions`
      : "Control DO rewound and R2 has no gen or archive to rebuild from",
  );
  return rep;
}
