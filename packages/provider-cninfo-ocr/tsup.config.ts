import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@napi-rs/canvas",
    "@tesseract.js-data/chi_sim",
    "@verified-financial/provider-cninfo",
    "tesseract.js",
    "unpdf",
  ],
});
