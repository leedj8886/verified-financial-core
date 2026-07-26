import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "schema",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
