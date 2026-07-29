import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "local-gateway",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
