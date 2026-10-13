import { defineConfig } from "tsup";

export default defineConfig({
  // `plugins/index` is its own entry, `@lath/runtime/plugins`, so what it holds never reaches a bundle
  // that imports only the index: today that is SAS's builders for the loop receipt.
  entry: { index: "src/index.ts", "plugins/index": "src/plugins/index.ts" },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  // Consumers bring their own Lath/Solana stack (peer dependencies).
  external: ["@lath/sdk", "@solana/web3.js"],
});
