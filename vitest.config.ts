import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["worker/test/**/*.test.ts", "cli/test/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
