import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "schema",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
