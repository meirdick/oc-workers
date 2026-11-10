import { defineConfig } from "vitest/config";

// Worker tests need their own config (cloudflare:workers alias, sync-crypto setup).
// CLI tests run plain Node.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ["worker/vitest.config.ts", "cli/vitest.config.ts"],
  },
});
