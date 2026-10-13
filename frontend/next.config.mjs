/**
 * The Solana stack was written for Node and ported to the browser by way of shims. webpack 5
 * removed the automatic polyfills and does not honour a package's `browser` field the way
 * esbuild and Vite do, so the two things `@solana/web3.js` and Anchor still reach for have to
 * be supplied here:
 *
 * - `Buffer`, used as a global (never imported) throughout web3.js, including inside
 *   `PublicKey` — so it is needed by any page that so much as parses an address;
 * - `crypto`/`stream`, reached for by transitive dependencies on paths we do not take.
 *
 * The Lath SDK itself needs none of this: `@lath/sdk/browser` is the entry point without
 * the filesystem-backed trace stores, and its decoders are `DataView` and `@noble/hashes`.
 * See `sdk/src/browser.ts`.
 *
 * @type {import("next").NextConfig}
 */
import path from "path";

const nextConfig = {
  reactStrictMode: true,
  // Two `next dev` on one checkout corrupt each other's `.next`, so one checkout runs one dev
  // server. A second console that must coexist with a running one — the
  // Playwright server on another port, say — sets NEXT_DIST_DIR so its build output lands
  // somewhere else and neither server rewrites the other's chunks. Unset, nothing changes.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // The floating "N" badge Next renders in development. It opens a route/build panel that is of
  // no use while reviewing the app, and it sits over the bottom-left of every page.
  devIndicators: false,
  env: {
    // The app ships its own read-only blob gateway (`src/app/api/traces`), and the console writes
    // traces where that route serves them from — so unless an operator points at another
    // gateway, the default is the built-in one rather than "chain-only".
    NEXT_PUBLIC_TRACE_GATEWAY: process.env.NEXT_PUBLIC_TRACE_GATEWAY ?? "/api/traces",
  },
  // The repo root has its own lockfile; say which one is this app's so Next stops guessing.
  outputFileTracingRoot: import.meta.dirname,
  // Four response headers on every route, each closing one failure. Deploy and launch are one wallet signature over an `autoConnect`ed wallet, so a page of
  // ours framed by someone else's — `/create?loop=1&agent=…` under a transparent overlay — is a
  // clickjacked signature: `frame-ancestors 'none'` refuses the frame, and `X-Frame-Options`
  // says the same to browsers that predate the CSP directive. `nosniff` keeps a served trace blob
  // from being run as a script because of what it looks like, since `/api/traces` serves bytes we
  // did not write. `strict-origin-when-cross-origin` keeps an agent id, a loop id or a read token
  // in our query string out of the Referer a wallet or RPC host sees. No `script-src` policy here:
  // the wallet adapters and the RPC origins make that a separate, hand-checked step, not a line.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  // The SDK is a symlinked workspace package shipping ESM+CJS; let Next compile it with the app
  // so its `export *` surface tree-shakes instead of being treated as an opaque CJS module.
  transpilePackages: ["@lath/sdk", "@lath/runtime"],
  webpack: (config, { isServer, webpack }) => {
    // The SDK and runtime are compiled from source (`transpilePackages`, tsconfig `paths`), and
    // their own imports of the Solana stack would otherwise resolve to the *root* node_modules
    // while the app's resolve to this one — two `PublicKey` classes, and every `instanceof` in
    // the SDK silently false. One copy for everyone.
    for (const pkg of ["@solana/web3.js", "@coral-xyz/anchor", "@lightprotocol/stateless.js", "bn.js", "buffer"]) {
      config.resolve.alias[pkg] = path.resolve(import.meta.dirname, "node_modules", pkg);
    }
    if (!isServer) {
      // Irys's *uploader* is node-only by construction: it signs with a keypair, and the SDK
      // documents it as such (`sdk/src/irys.ts`). The browser only ever *reads* Irys, through
      // `HttpGatewayBackend` over the public gateway. But `sdk/src/index.ts` re-exports the
      // uploader, `runtime/src` imports that entry, and `/create` imports the runtime — so
      // webpack follows the chain into `@irys/upload`, which drags `inquirer` and `node:path`
      // into a client bundle and fails the build. Cut it here rather than reshaping the SDK's
      // node surface: nothing in the browser can reach the dynamic import behind it.
      for (const pkg of ["@irys/upload", "@irys/upload-solana"]) config.resolve.alias[pkg] = false;
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
      };
      config.plugins.push(new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }));
    }
    return config;
  },
};

export default nextConfig;
