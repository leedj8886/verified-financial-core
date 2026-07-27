import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "adapters/*/vitest.config.ts",
    ],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/**/*.ts",
        "packages/schema/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/src/index.ts",
        "**/src/test-fixtures.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
