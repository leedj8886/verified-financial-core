import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "provider-tencent",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
