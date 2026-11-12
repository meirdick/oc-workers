// The file_store tool's actions (docs/11 §8). No OpenClaw import, so the node tests load this file alone.
import fs from "node:fs/promises";
import path from "node:path";
import { createBackend, PROVIDER_ID } from "./backend.mjs";

const PLUGIN_ID = "ochost-storage";
const DEFAULT_LOCATION = "r2";
/** Text the tool returns inline; larger reads go to a workspace file (`to`). */
const READ_INLINE_MAX = 200_000;
/** No control characters or backslash; segments not empty, "." or "..". Spaces, Unicode, + # % are fine (1.2.5). */
const badChar = (s) => s.includes("\\") || [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const MARKER = "openclaw-storage.json";

/** The location the tool uses: plugin config `location`, settings of storage.locations.<it>. */
export function locationOf(cfg) {
  const name = cfg?.plugins?.entries?.[PLUGIN_ID]?.config?.location ?? DEFAULT_LOCATION;
  const loc = cfg?.storage?.locations?.[name];
  if (!loc || loc.provider !== PROVIDER_ID)
    throw new Error(`Storage location "${name}" is not configured with provider ${PROVIDER_ID}; the owner runs \`ochost config render\`.`);
  return { name, settings: loc.settings };
}

function checkKey(key) {
  const k = String(key ?? "").trim();
  if (!k || Buffer.byteLength(k) > 512 || badChar(k) || k.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new Error("name must be /-separated segments without control characters or backslash, no empty, '.' or '..' segment (max 512 bytes), such as notes/2026 plan.md");
  if (k === MARKER) throw new Error(`${MARKER} is reserved`);
  return k;
}

/** Resolve a workspace-relative path; refuse anything outside the workspace. */
function inWorkspace(ws, p) {
  if (!ws) throw new Error("no workspace for this run; use content instead of path");
  const abs = path.resolve(ws, String(p));
  if (abs !== ws && !abs.startsWith(ws + path.sep)) throw new Error("path must be inside the workspace");
  return abs;
}

/** One action of the tool. o: {cfg, workspaceDir, signal, backend?} (backend: tests). */
export async function runFileStore(args, o) {
  const action = args?.action;
  const loc = locationOf(o.cfg);
  const b = o.backend ?? createBackend(loc.settings);
  const signal = o.signal;
  const bodyOf = async () => {
    let bytes;
    if (typeof args.content === "string") bytes = Buffer.from(args.content, "utf8");
    else if (typeof args.path === "string") bytes = await fs.readFile(inWorkspace(o.workspaceDir, args.path));
    else throw new Error(`${action} needs content or path`);
    return { bytes, iter: (async function* () { yield new Uint8Array(bytes); })() };
  };
  try {
    if (action === "save") {
      const key = checkKey(args.name);
      const { bytes, iter } = await bodyOf();
      let r;
      try {
        r = await b.createObject(key, iter, { sizeBytes: bytes.length, signal });
      } catch (e) {
        if (e?.code !== "exists") throw e;
        return { ok: false, action, location: loc.name, name: key, exists: true, error: `${key} exists. To change it: read it, then update with the etag from the read.` };
      }
      return { ok: true, action, location: loc.name, name: key, sizeBytes: r.sizeBytes, ...(r.etag ? { etag: r.etag } : {}) };
    }
    if (action === "update") {
      const key = checkKey(args.name);
      const etag = typeof args.etag === "string" ? args.etag.trim() : "";
      if (!etag) throw new Error('update needs etag: the etag from your last read or save of this file, or "*" to replace any version');
      const { bytes, iter } = await bodyOf();
      try {
        const r = await b.replaceObject(key, iter, { sizeBytes: bytes.length, ifMatch: etag, signal });
        return { ok: true, action, location: loc.name, name: key, sizeBytes: r.sizeBytes, ...(r.etag ? { etag: r.etag } : {}) };
      } catch (e) {
        if (e?.code === "not-found")
          return { ok: false, action, location: loc.name, name: key, error: "not found; use save to create it" };
        if (e?.code !== "conflict") throw e;
        const now = await b.statObject(key, { signal }).catch(() => undefined);
        return {
          ok: false,
          action,
          location: loc.name,
          name: key,
          conflict: true,
          ...(now?.etag ? { currentEtag: now.etag } : {}),
          ...(Number.isFinite(now?.modifiedAt) ? { modifiedAt: new Date(now.modifiedAt).toISOString() } : {}),
          error: `${key} changed since your read (someone else wrote it). Nothing was written. Read it again, make your change on the new text, then update with the new etag.`,
        };
      }
    }
    if (action === "read") {
      const key = checkKey(args.name);
      const got = await b.readObject(key, { signal });
      if (!got) return { ok: false, action, location: loc.name, name: key, error: "not found" };
      const chunks = [];
      for await (const c of got.body) chunks.push(Buffer.from(c));
      const buf = Buffer.concat(chunks);
      const meta = {
        ...(got.etag ? { etag: got.etag } : {}),
        ...(Number.isFinite(got.modifiedAt) ? { modifiedAt: new Date(got.modifiedAt).toISOString() } : {}),
      };
      if (typeof args.to === "string") {
        const dst = inWorkspace(o.workspaceDir, args.to);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.writeFile(dst, buf);
        return { ok: true, action, location: loc.name, name: key, sizeBytes: buf.length, ...meta, to: args.to };
      }
      if (buf.length > READ_INLINE_MAX)
        return { ok: false, action, name: key, sizeBytes: buf.length, ...meta, error: `above ${READ_INLINE_MAX} bytes; pass to: <workspace path>` };
      return { ok: true, action, location: loc.name, name: key, sizeBytes: buf.length, ...meta, content: buf.toString("utf8") };
    }
    if (action === "list") {
      const prefix = args.prefix ? String(args.prefix) : "";
      if (prefix && badChar(prefix)) throw new Error("prefix has characters names cannot have");
      const files = [];
      for await (const x of b.listObjects(prefix, { signal })) {
        if (x.key === MARKER || x.key.startsWith(".")) continue;
        files.push({ name: x.key, sizeBytes: x.sizeBytes, ...(x.modifiedAt ? { modifiedAt: new Date(x.modifiedAt).toISOString() } : {}) });
        if (files.length >= 1000) break;
      }
      return { ok: true, action, location: loc.name, files };
    }
    if (action === "delete") {
      const key = checkKey(args.name);
      await b.deleteObject(key, { signal });
      return { ok: true, action, location: loc.name, name: key };
    }
    throw new Error("action must be save, update, read, list or delete");
  } finally {
    if (!o.backend) await b.close?.();
  }
}
