import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
    sequence: {
      concurrent: false,
    },
  },
});
