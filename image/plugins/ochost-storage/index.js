// oc-host file storage (docs/11 §8). Plain ESM, no build step; bundled like cf-web-search (/app/dist/extensions).
// 1. Storage provider `ochost-r2`: OpenClaw storage locations (storage.locations.<name>, provider ochost-r2) on the
//    install's R2 bucket under f/<inst>/, through ocsup's loopback forwarder to the ReplicaGate. No credential in the
//    config: the backend reads the per-gen gate key ocsup writes for uid 1000 (backend.mjs).
// 2. Tool `file_store`: the agent saves, reads, lists and deletes files in that location. Files are durable on write
//    and live outside the snapshot chain and the archives.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { createBackend, describeTarget, PROVIDER_ID, validateSettings } from "./backend.mjs";
import { runFileStore } from "./tool.mjs";

const PLUGIN_ID = "ochost-storage";

export const storageProvider = {
  id: PROVIDER_ID,
  label: "Cloudflare R2 (oc-host)",
  validateSettings,
  describeTarget,
  async open(params) {
    params.signal?.throwIfAborted();
    return createBackend(params.settings);
  },
};

export function createTool(ctx) {
  return {
    name: "file_store",
    label: "File storage (R2)",
    description:
      "Durable file storage on Cloudflare R2 (storage location r2). save: name + content (text) or path (a workspace file). read: name, returns text, or writes to `to` (a workspace path). list: optional prefix. delete: name. Saved files survive restarts and are not in snapshots or backups. Names never overwrite: save to a new name.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "read", "list", "delete"] },
        name: { type: "string", description: "File name in the location, such as reports/2026-11.md." },
        content: { type: "string", description: "save: UTF-8 text to store." },
        path: { type: "string", description: "save: workspace file to store instead of content." },
        to: { type: "string", description: "read: workspace path to write the file to." },
        prefix: { type: "string", description: "list: only names that start with this." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (_id, params, signal) => {
      try {
        return jsonResult(await runFileStore(params, { cfg: ctx?.config, workspaceDir: ctx?.workspaceDir, signal }));
      } catch (e) {
        return jsonResult({ ok: false, action: params?.action, error: String(e?.message ?? e) });
      }
    },
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Cloudflare R2 via oc-workers",
  description: "Storage location r2 on the install's R2 bucket through the oc-host gate. No credential in the config.",
  register(api) {
    api.registerStorageProvider(storageProvider);
    api.registerTool((ctx) => createTool(ctx), { name: "file_store" });
  },
});
