import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Plain vitest in Node. `cloudflare:workers` is a shim; the platform pieces are fakes (test/harness).
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/shims/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    pool: "threads",
    setupFiles: ["./test/harness/sync-crypto.ts"],
    // @cloudflare/sandbox imports `cloudflare:workers`: inline it so the alias above applies.
    server: { deps: { inline: ["@cloudflare/sandbox"] } },
    // A restarted fake DO's old promise chains fail on revoked storage (test/harness/world.ts).
    // On the platform that code is simply gone, so these rejections are not test failures.
    onUnhandledError: (e) => !String((e as Error)?.message ?? e).includes("Durable Object reset (fake)"),
  },
});
