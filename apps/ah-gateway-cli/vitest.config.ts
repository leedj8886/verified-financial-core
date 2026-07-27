import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ah-gateway-cli",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
