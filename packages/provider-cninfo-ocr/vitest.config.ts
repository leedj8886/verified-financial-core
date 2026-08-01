import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "provider-cninfo-ocr",
    include: ["src/**/*.test.ts"],
  },
});
