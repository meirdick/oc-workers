// The file_store tool's actions (docs/11 §8). No OpenClaw import, so the node tests load this file alone.
import fs from "node:fs/promises";
import path from "node:path";
import { createBackend, PROVIDER_ID } from "./backend.mjs";

const PLUGIN_ID = "ochost-storage";
const DEFAULT_LOCATION = "r2";
/** Text the tool returns inline; larger reads go to a workspace file (`to`). */
const READ_INLINE_MAX = 200_000;
const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
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
  if (!k || Buffer.byteLength(k) > 512 || !KEY_RE.test(k) || k.split("/").some((s) => s === "." || s === ".."))
    throw new Error("name must be /-separated segments of letters, digits, '.', '_' or '-' (max 512 bytes), such as notes/2026-11-06.md");
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
  try {
    if (action === "save") {
      const key = checkKey(args.name);
      let bytes;
      if (typeof args.content === "string") bytes = Buffer.from(args.content, "utf8");
      else if (typeof args.path === "string") bytes = await fs.readFile(inWorkspace(o.workspaceDir, args.path));
      else throw new Error("save needs content or path");
      const r = await b.putObject(key, (async function* () { yield new Uint8Array(bytes); })(), { sizeBytes: bytes.length, signal });
      return { ok: true, action, location: loc.name, name: key, sizeBytes: r.sizeBytes };
    }
    if (action === "read") {
      const key = checkKey(args.name);
      const body = await b.getObject(key, { signal });
      if (!body) return { ok: false, action, location: loc.name, name: key, error: "not found" };
      const chunks = [];
      for await (const c of body) chunks.push(Buffer.from(c));
      const buf = Buffer.concat(chunks);
      if (typeof args.to === "string") {
        const dst = inWorkspace(o.workspaceDir, args.to);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.writeFile(dst, buf);
        return { ok: true, action, location: loc.name, name: key, sizeBytes: buf.length, to: args.to };
      }
      if (buf.length > READ_INLINE_MAX)
        return { ok: false, action, name: key, sizeBytes: buf.length, error: `above ${READ_INLINE_MAX} bytes; pass to: <workspace path>` };
      return { ok: true, action, location: loc.name, name: key, sizeBytes: buf.length, content: buf.toString("utf8") };
    }
    if (action === "list") {
      const prefix = args.prefix ? String(args.prefix) : "";
      if (prefix && !/^[A-Za-z0-9._\/-]+$/.test(prefix)) throw new Error("prefix has characters names cannot have");
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
    throw new Error("action must be save, read, list or delete");
  } finally {
    if (!o.backend) await b.close?.();
  }
}
