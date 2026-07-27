import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "provider-contract",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
