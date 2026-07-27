import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "provider-eastmoney",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
