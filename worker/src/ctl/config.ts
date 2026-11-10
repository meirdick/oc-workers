// Config document versions and candidates (plan §4.9, spec §17.2 `/v1/config/*`), plugin manifests.
import { sha256Hex } from "../core/ids";
import { CAPS, pruneConfigRows } from "../gates/ledger";
import { hookPath } from "../ingress/telegram";
import { heldReason } from "./adopt-spec";
import { alert } from "./alerts";
import { type Ctx, ring } from "./ctx";
import { heartbeatDefault } from "./schedule";
import { pj } from "./sql";

export type ConfigStatus = "candidate" | "good" | "bad" | "held" | "rejected";
export interface ConfigRow {
  ver: number;
  schema_sha: string | null;
  status: ConfigStatus;
  source: string | null;
  sha: string | null;
  dark_origin: number;
  base_ver: number | null;
  doc: string;
  good_digest: string | null;
  created_at: number;
}

/**
 * guess: keys whose change alerts `config-sensitive` (plan §4.9 managed keys and auth surfaces). M5 makes the
 * list a CI output per release.
 */
export const SENSITIVE_PATHS = [
  "gateway.auth",
  "gateway.bind",
  "gateway.port",
  "gateway.trustedProxies",
  "gateway.controlUi",
  "browser.executablePath",
  "tools.exec",
];

function get(o: unknown, path: string): unknown {
  let x: any = o;
  for (const k of path.split(".")) {
    if (x == null || typeof x !== "object") return undefined;
    x = x[k];
  }
  return x;
}

/** Secret hook path shape (ingress/telegram.ts): `/_ochost/hook/telegram/<32 hex>`. */
export const HOOK_PATH_RE = /^\/_ochost\/hook\/telegram\/[0-9a-f]{32}$/;

/**
 * Webhook transport rule (plan §4.9, spec §17.2): refuse any channel or account with a `webhookUrl` other than
 * the managed Telegram route. Managed = `<origin>/telegram-webhook` (legacy) or the secret hook URL (W2, M5):
 * `<origin>` + one of `hookPaths` (current and previous secret). No `hookPaths` known → any hook path of the
 * right shape on the origin. guess: transport keys are `webhookUrl` under `channels.<ch>` and
 * `channels.<ch>.accounts.<id>`; CI lists them per release in M5.
 */
export function webhookViolation(
  doc: unknown,
  publicOrigin?: string,
  hookPaths: string[] = [],
): string | null {
  const ch = get(doc, "channels");
  if (!ch || typeof ch !== "object") return null;
  const origin = publicOrigin ? publicOrigin.replace(/\/$/, "") : null;
  const pathOk = (p: string) =>
    p === "/telegram-webhook" || (hookPaths.length ? hookPaths.includes(p) : HOOK_PATH_RE.test(p));
  const okUrl = (name: string, v: unknown) => {
    if (name !== "telegram" || typeof v !== "string") return false;
    const m = /^(https:\/\/[^/?#]+)(\/[^?#]*)$/.exec(v);
    if (!m) return false;
    if (origin && m[1] !== origin) return false;
    return pathOk(m[2] as string);
  };
  for (const [name, cfg] of Object.entries(ch as Record<string, any>)) {
    if (!cfg || typeof cfg !== "object") continue;
    const units: [string, any][] = [[name, cfg]];
    if (cfg.accounts && typeof cfg.accounts === "object")
      for (const [id, acc] of Object.entries(cfg.accounts as Record<string, any>))
        units.push([`${name}.${id}`, acc]);
    for (const [label, u] of units) {
      if (!u || typeof u !== "object") continue;
      const url = u.webhookUrl;
      if (url !== undefined && url !== null && url !== "" && !okUrl(name, url))
        return `channels.${label}.webhookUrl`;
    }
  }
  return null;
}

/** Hook paths of the current and previous webhook secret (W2). */
export async function managedHookPaths(c: Ctx): Promise<string[]> {
  const out: string[] = [];
  for (const s of [c.secrets.webhookSecret, c.secrets.webhookSecretPrev]) if (s) out.push(await hookPath(s));
  return out;
}

export function getConfig(c: Ctx, ver: number): ConfigRow | null {
  return c.db.one<ConfigRow>("SELECT * FROM config WHERE ver = ?", ver);
}

/** The newest version an owner op may build on. A `held` candidate (a UI token waiting for adoption) is not one. */
export function newestConfig(c: Ctx): ConfigRow | null {
  return c.db.one<ConfigRow>("SELECT * FROM config WHERE status <> 'held' ORDER BY ver DESC LIMIT 1");
}

/**
 * Version for a boot (plan §4.9): newest `good` or `candidate` for the image schema; LKG (newest `good`) when
 * `lkg` (ladder L2-L4). Unknown schemaSha matches every version.
 */
export function configForBoot(c: Ctx, schemaSha: string | null, lkg: boolean): number | null {
  const rows = c.db.all<ConfigRow>("SELECT ver, schema_sha, status FROM config ORDER BY ver DESC");
  const sameSchema = (r: ConfigRow) => !schemaSha || !r.schema_sha || r.schema_sha === schemaSha;
  const good = rows.find((r) => r.status === "good" && sameSchema(r));
  if (lkg) return good?.ver ?? null;
  const pick = rows.find((r) => (r.status === "good" || r.status === "candidate") && sameSchema(r));
  return pick?.ver ?? null;
}

export interface Proposal {
  source: string;
  sha?: string;
  schemaSha?: string;
  darkOrigin?: boolean;
  baseVer?: number;
  doc: unknown;
}

/** Store a candidate (ocsup proposal or owner edit). Same sha as the newest version → no new version. */
export async function configPropose(
  c: Ctx,
  p: Proposal,
  o: { mode?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (o.mode && o.mode !== "prod") return { status: 403, body: { error: "mode" } };
  // N11 / U2: an owner config without a heartbeat setting gets the OpenClaw heartbeat off.
  if (p.source === "owner") {
    const hb = heartbeatDefault(p.doc, c.settings());
    if (hb.set) {
      p = { ...p, doc: hb.doc, sha: undefined };
      ring(c, "config", "heartbeat-default-off", {});
    }
  }
  const bad = webhookViolation(p.doc, c.settings().publicOrigin, await managedHookPaths(c));
  if (bad) {
    alert(c, "config-rejected", "warn", `webhook transport at ${bad}`);
    return { status: 403, body: { error: "webhook-transport", path: bad } };
  }
  const text = JSON.stringify(p.doc);
  const sha = p.sha ?? (await sha256Hex(text));
  const newest = newestConfig(c);
  if (newest && newest.sha === sha) return { status: 200, body: { ok: true, ver: newest.ver, same: true } };
  // Channel adoption: a gateway (UI) candidate with a channel credential in clear is held, not offered to a boot.
  // The owner adopts it (POST /ops/channels/adopt) or removes the token; the gateway keeps the last good config.
  const reason = p.source === "owner" ? null : heldReason(p.doc);
  if (reason) {
    const held = c.db.one<{ ver: number }>("SELECT ver FROM config WHERE status = 'held' AND sha = ?", sha);
    if (held) return { status: 200, body: { ok: true, ver: held.ver, held: true, same: true, reason } };
    const hv = (c.db.one<{ m: number | null }>("SELECT MAX(ver) AS m FROM config")?.m ?? 0) + 1;
    c.db.run(
      `INSERT INTO config (ver, schema_sha, status, source, sha, dark_origin, base_ver, doc, created_at)
       VALUES (?, ?, 'held', ?, ?, 0, ?, ?, ?)`,
      hv,
      p.schemaSha ?? null,
      p.source,
      sha,
      p.baseVer ?? newest?.ver ?? null,
      text,
      c.now(),
    );
    c.db.setMeta("configChangedAt", c.now());
    ring(c, "config", "held", { ver: hv, source: p.source, reason });
    return { status: 200, body: { ok: true, ver: hv, held: true, reason } };
  }
  const base = p.baseVer !== undefined ? getConfig(c, p.baseVer) : newest;
  const baseDoc = base ? pj<unknown>(base.doc, {}) : {};
  const changed = SENSITIVE_PATHS.filter(
    (k) => JSON.stringify(get(baseDoc, k)) !== JSON.stringify(get(p.doc, k)),
  );
  const ver = (c.db.one<{ m: number | null }>("SELECT MAX(ver) AS m FROM config")?.m ?? 0) + 1;
  c.db.run(
    `INSERT INTO config (ver, schema_sha, status, source, sha, dark_origin, base_ver, doc, created_at)
     VALUES (?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`,
    ver,
    p.schemaSha ?? null,
    p.source,
    sha,
    p.darkOrigin ? 1 : 0,
    p.baseVer ?? base?.ver ?? null,
    text,
    c.now(),
  );
  c.db.setMeta("configChangedAt", c.now());
  const pruned = pruneConfigRows(c.db.store);
  if (pruned) ring(c, "config", "pruned", { rows: pruned, newest: CAPS.configRows });
  // An owner change of an auth surface is the owner's doing: a ring row. From the gateway (ui) it is an alert.
  if (base && changed.length) {
    if (p.source === "owner") ring(c, "config", "sensitive", { ver, changed });
    else alert(c, "config-sensitive", "warn", `ver ${ver} changes ${changed.join(", ")}`);
  }
  ring(c, "config", "candidate", { ver, source: p.source });
  return { status: 200, body: { ok: true, ver } };
}

/** On `started` in a lit prod boot: the booted version becomes `good` on this digest (plan §4.9 Promotion). */
export function configMarkGood(c: Ctx, ver: number | null, digest: string, lit: boolean): void {
  if (ver === null || !lit) return;
  const r = getConfig(c, ver);
  if (!r || r.status === "bad") return;
  c.db.run("UPDATE config SET status = 'good', good_digest = ?, dark_origin = 0 WHERE ver = ?", digest, ver);
}

export function configMarkBad(c: Ctx, ver: number): void {
  c.db.run("UPDATE config SET status = 'bad' WHERE ver = ?", ver);
}

export function configGetWire(c: Ctx, ver: number): { status: number; body: unknown } {
  const r = getConfig(c, ver);
  if (!r) return { status: 404, body: { error: "no-version" } };
  return { status: 200, body: { ver: r.ver, schemaSha: r.schema_sha ?? undefined, doc: pj(r.doc, {}) } };
}

export function configList(c: Ctx): Omit<ConfigRow, "doc">[] {
  return c.db.all<Omit<ConfigRow, "doc">>(
    "SELECT ver, schema_sha, status, source, sha, dark_origin, base_ver, good_digest, created_at FROM config ORDER BY ver DESC LIMIT 100",
  );
}
