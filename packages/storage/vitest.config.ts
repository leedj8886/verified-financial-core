import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "storage",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
