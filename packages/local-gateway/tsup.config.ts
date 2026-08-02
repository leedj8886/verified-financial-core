import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@verified-financial/provider-baidu",
    "@verified-financial/provider-cninfo",
    "@verified-financial/provider-contract",
    "@verified-financial/provider-eastmoney",
    "@verified-financial/provider-hkex",
    "@verified-financial/provider-tencent",
    "@verified-financial/provider-ths",
    "@verified-financial/sdk",
    "@verified-financial/storage",
  ],
});
