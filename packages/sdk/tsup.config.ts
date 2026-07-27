import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@verified-financial/core",
    "@verified-financial/provider-contract",
    "@verified-financial/schema",
    "@verified-financial/storage",
  ],
});
