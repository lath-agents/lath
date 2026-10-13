/**
 * The browser entry point: everything in the SDK except the trace stores that need `fs` and
 * Node's `crypto`.
 *
 * ```ts
 * import { LathClient, decodeAgentState } from "@lath/sdk/browser";
 * ```
 *
 * Nothing here reaches for a Node built-in, so a bundler needs no `fs`, `path` or `crypto`
 * fallback for it — verified by bundling this entry with `--platform=browser`.
 *
 * `Buffer` is a separate matter and is not ours: `@solana/web3.js` uses it everywhere,
 * including inside `PublicKey`, so it comes in with the very first import. Bundlers that honour
 * a package's `browser` field (esbuild, Vite, Rollup) substitute the `buffer` shim by
 * themselves; webpack 5 — and therefore Next.js — does not, and needs `resolve.fallback.buffer`
 * plus a `ProvidePlugin`. See `frontend/next.config.mjs`.
 */
export * from "./idl";
export * from "./hash";
export * from "./signer";
export * from "./events";
export * from "./trace-store";
export * from "./cells";
export * from "./layout";
export * from "./confirm";
export * from "./client";
export * from "./structures";
export * from "./abstractions";
export * from "./store";
export * from "./locator";
export * from "./bundle";
export * from "./logger";
export * from "./handoff";
export * from "./audit";
export * from "./billing";
export * from "./market";
export * from "./storage";
export * from "./rollup";
export * from "./goal";
export * from "./team";
export * from "./loops";
export * from "./lifecycle";
export * from "./verify";
export * from "./gate";
export * from "./trace-audit";
export * from "./decision-pricing";
export * from "./plugins";
export * from "./receipt";
