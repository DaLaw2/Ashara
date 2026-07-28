import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/development/test/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
