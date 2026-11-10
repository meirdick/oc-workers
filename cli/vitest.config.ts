import { defineConfig } from "vitest/config";

// CLI tests run in plain Node. The root config lists this file as a project.
export default defineConfig({
  test: { name: "cli", include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
