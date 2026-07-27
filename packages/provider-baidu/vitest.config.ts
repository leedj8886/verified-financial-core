import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "provider-baidu",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
