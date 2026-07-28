import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "provider-cninfo",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
