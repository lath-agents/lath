import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/browser.ts", "src/cli.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  // The IDL JSON is inlined into the bundle so the package is self-contained.
  loader: { ".json": "json" },
  // Consumers bring their own Solana/Anchor stack (peer dependencies).
  external: ["@coral-xyz/anchor", "@lightprotocol/stateless.js", "@solana/web3.js"],
});
