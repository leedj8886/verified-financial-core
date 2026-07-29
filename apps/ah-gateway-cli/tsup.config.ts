import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@verified-financial/local-gateway",
    "@verified-financial/schema",
    "@verified-financial/sdk",
  ],
});
