// OpenClaw sandbox backend "ochost" (docs/12-sandbox-design.md). Registered with registerSandboxBackend;
// built on the SDK's remote-shell backend, which owns workspace seeding, skills, workdir checks and the
// file bridge. Every remote shell goes through sbx.mjs to SandboxGate (15.0.0.4), which runs it in this
// install's SandboxSession container. The gateway container holds no credential for it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createRemoteShellSandboxBackend,
  createRemoteShellSandboxSession,
  registerSandboxBackend,
} from "openclaw/plugin-sdk/sandbox";

export const BACKEND_ID = "ochost";
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "sbx.mjs");
const DEFAULTS = { gateUrl: "http://15.0.0.4", workspaceRoot: "/workspace" };

const configSchema = {
  safeParse(value) {
    if (value === undefined) return { success: true, data: undefined };
    const bad = (message) => ({ success: false, error: { issues: [{ path: [], message }] } });
    if (!value || typeof value !== "object" || Array.isArray(value)) return bad("expected config object");
    for (const [k, v] of Object.entries(value)) {
      if (!(k in DEFAULTS)) return bad(`unknown key ${k}`);
      if (typeof v !== "string" || !v) return bad(`${k} must be a non-empty string`);
    }
    return { success: true, data: value };
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: { gateUrl: { type: "string" }, workspaceRoot: { type: "string" } },
  },
};

/** argv for one remote shell. The local env carries only PATH; the remote env is staged by the SDK. */
export function transport(gateUrl, remoteCommand) {
  return {
    argv: [process.execPath, CLIENT, gateUrl, remoteCommand],
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  };
}

export default definePluginEntry({
  id: "ochost-sandbox",
  name: "oc-host sandbox",
  description: "Runs sandboxed exec and file tools in the install's Cloudflare sandbox container.",
  configSchema,
  register(api) {
    if (api.registrationMode !== "full") return;
    const cfg = { ...DEFAULTS, ...(api.pluginConfig ?? {}) };
    const session = () =>
      createRemoteShellSandboxSession({
        buildCommand: ({ remoteCommand }) => transport(cfg.gateUrl, remoteCommand),
        formatFailure: (stderr, code) => stderr.trim() || `sandbox command exited ${code}`,
      });
    const unregister = registerSandboxBackend(BACKEND_ID, {
      factory: (params) =>
        createRemoteShellSandboxBackend(params, {
          backendId: BACKEND_ID,
          configLabel: cfg.gateUrl,
          configLabelKind: "Gate",
          createSession: async () => session(),
        }),
      manager: {
        // The SandboxSession DO owns the container; asleep is a normal state, so report running.
        async describeRuntime() {
          return { running: true, configLabelMatch: true };
        },
        // `openclaw sandbox recreate`: drop the per-scope root; the next use seeds it again.
        async removeRuntime({ entry }) {
          const root = path.posix.join(cfg.workspaceRoot, entry.containerName);
          const t = transport(cfg.gateUrl, `rm -rf -- '${root.replaceAll("'", "'\\''")}'`);
          spawnSync(t.argv[0], t.argv.slice(1), { env: t.env, input: "", timeout: 120_000 });
        },
      },
    });
    api.lifecycle?.registerRuntimeLifecycle?.({
      id: "ochost-sandbox-cleanup",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (sessionKey !== undefined || runId !== undefined) return;
        if (reason === "disable" || reason === "restart") unregister();
      },
    });
  },
});
