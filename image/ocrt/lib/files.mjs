// File storage (docs/11 §8): what ocsup does for the bundled ochost-storage plugin at each boot.
// 1. The key file: the per-gen ReplicaGate key (the one Litestream uses) for uid 1000, so the plugin signs its S3
//    requests. It is never in openclaw.json. The gate limits the key to r/<inst>/g<gen>/ and f/<inst>/.
// 2. The location marker: OpenClaw's storage core needs `openclaw-storage.json` at the location root before any
//    write and never makes it at runtime (`openclaw storage init`). ocsup writes it once, create-only, with
//    encryption "none" (the bytes stay in this install's R2 bucket behind the gate).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { filesPrefix } from "./contract.mjs";
import { headObject, putObject } from "./s3.mjs";

export const FILES_KEY_NAME = "files-key.json";
/** The marker key of OpenClaw 2026.10.9 storage core (src/storage/marker.ts STORAGE_MARKER_KEY). */
export const MARKER_NAME = "openclaw-storage.json";

/** Key file text: {accessKeyId, secretAccessKey}. */
export const filesKeyText = (s3) =>
  `${JSON.stringify({ accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey })}\n`;

/** Write the key file 0400, owner uid 1000 (asRoot: tests keep the owner). Same pattern as litestream.yml. */
export function writeFilesKey(p, s3, { asRoot = false } = {}) {
  fs.writeFileSync(`${p}.tmp`, filesKeyText(s3), { mode: 0o400 });
  if (!asRoot) fs.chownSync(`${p}.tmp`, 1000, 1000);
  fs.renameSync(`${p}.tmp`, p);
}

/** The marker OpenClaw's `storage init` writes for `encryption: "none"` (schema: version, locationId, createdAt, encryption). */
export const markerText = (now = Date.now()) =>
  `${JSON.stringify({ version: 1, locationId: randomUUID(), createdAt: now, encryption: "none" })}\n`;

/**
 * Make the marker when it is missing. s3: replica-proxy config (root path to the gate). Returns
 * "present" | "created" | "raced" (another writer made it first) | "error <status>".
 */
export async function ensureFilesMarker(s3, inst, o = {}) {
  const key = `${filesPrefix(inst)}${MARKER_NAME}`;
  const h = await (o.head || headObject)(s3, key);
  if (h === 200) return "present";
  if (h !== 404) return `error ${h}`;
  const p = await (o.put || putObject)(s3, key, markerText(o.now?.()), { createOnly: true });
  if (p === 200) return "created";
  return p === 412 ? "raced" : `error ${p}`;
}
