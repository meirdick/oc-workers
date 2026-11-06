// `ochost config render` and the render step of `ochost deploy`: old installs keep the capability keys they were
// created with. Merge the CLI's current renderCapabilities() into the live config as a new version.
// Render keys win, every other key stays. The document records `ochost.renderVersion` (cli/src/config.ts).
import { RENDER_VERSION, renderCapabilities, renderModelRoles } from "./config.ts";

/** What the merge needs from the Worker: GET and POST of /ops/config (an ops client or a plain fetch). */
export interface ConfigIo {
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Render keys win; objects merge, anything else (arrays too) is replaced by the render's value. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return structuredClone(over);
  const out: Record<string, any> = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

export function renderVersionOf(doc: Record<string, any> | undefined): number {
  const v = doc?.ochost?.renderVersion;
  return typeof v === "number" ? v : 0;
}

export interface RenderDiff {
  added: string[];
  changed: string[];
  same: string[];
}

/** Pure: the doc with the current render merged in, and which top-level keys it added or changed. */
export function mergeRender(
  doc: Record<string, any>,
  files?: { bucket: string; inst: string },
): { doc: Record<string, any>; diff: RenderDiff } {
  const render = { ...renderCapabilities(files), ochost: { renderVersion: RENDER_VERSION } };
  const next = renderModelRoles(deepMerge(doc, render) as Record<string, any>);
  const diff: RenderDiff = { added: [], changed: [], same: [] };
  for (const k of Object.keys(next).sort()) {
    if (!(k in doc)) diff.added.push(k);
    else if (JSON.stringify(doc[k]) !== JSON.stringify(next[k])) diff.changed.push(k);
    else if (k in render) diff.same.push(k);
  }
  return { doc: next, diff };
}

export interface RenderResult {
  /** none: nothing to merge (no config yet, or already current); dry: not posted; merged: new version posted */
  action: "none" | "dry" | "merged";
  from: number;
  ver: number;
  docRenderVersion: number;
  diff: RenderDiff;
}

/**
 * Merge the render into the newest config version. `onlyIfOlder` (deploy): do nothing unless the document's
 * renderVersion is lower than the CLI's. Without it (`config render`): always merge; the Worker answers `same`
 * when the result equals the version.
 */
export async function renderIntoConfig(
  io: ConfigIo,
  o: { dryRun?: boolean; onlyIfOlder?: boolean; files?: { bucket: string; inst: string } } = {},
): Promise<RenderResult> {
  const empty: RenderDiff = { added: [], changed: [], same: [] };
  const l = await io.get("/ops/config");
  const vers = ((l.body?.versions ?? []) as { ver: number }[]).map((v) => v.ver);
  if (l.status !== 200 || !vers.length)
    return { action: "none", from: 0, ver: 0, docRenderVersion: 0, diff: empty };
  const from = Math.max(...vers);
  const g = await io.get(`/ops/config/${from}`);
  if (g.status !== 200) throw new Error(`cannot read config version ${from} (${g.status})`);
  const doc = (g.body?.doc ?? {}) as Record<string, any>;
  const docRenderVersion = renderVersionOf(doc);
  if (o.onlyIfOlder && docRenderVersion >= RENDER_VERSION)
    return { action: "none", from, ver: from, docRenderVersion, diff: empty };
  const m = mergeRender(doc, o.files);
  if (o.dryRun) return { action: "dry", from, ver: from, docRenderVersion, diff: m.diff };
  const r = await io.post("/ops/config", { doc: m.doc, baseVer: from });
  if (r.status === 409)
    throw new Error(`config changed elsewhere (base ${from}, current ${r.body?.ver ?? "?"})`);
  if (r.status !== 200 || r.body?.ok === false)
    throw new Error(`the Worker refused the config (${r.status} ${r.body?.error ?? ""})`.trim());
  return {
    action: r.body?.same ? "none" : "merged",
    from,
    ver: r.body?.ver ?? from + 1,
    docRenderVersion,
    diff: m.diff,
  };
}

export function diffLine(d: RenderDiff): string {
  const part = (label: string, ks: string[]) => (ks.length ? `${label} ${ks.join(", ")}` : "");
  return [part("added", d.added), part("changed", d.changed), part("same", d.same)]
    .filter(Boolean)
    .join("; ");
}
