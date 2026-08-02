import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "provider-ths",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
