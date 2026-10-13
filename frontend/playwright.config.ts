import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke test against devnet, seeded:
 *
 * ```bash
 * npx ts-node -P ../tsconfig.json ../scripts/seed.ts --devnet --e2e-wallet > .env.devnet.e2e
 * npm run test:e2e
 * ```
 *
 * The point is not the UI. It is that the whole read path — Photon queries, the compressed
 * account decoders, the hash-chain replay — runs *in a browser*, with whatever polyfills the
 * bundler ended up supplying. That is the one thing no Node test can tell us, and it is why
 * this drives a real page rather than calling the SDK.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3111",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    // The trace gateway: a static server over the directory the seed script filled. It runs
    // whether or not the app is ours to start, because the app reads it from the browser.
    {
      command: "node e2e/serve-traces.mjs",
      url: "http://127.0.0.1:3112/",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    ...(process.env.PLAYWRIGHT_BASE_URL
      ? []
      : [
          {
            command: "npx next dev -p 3111",
            url: "http://127.0.0.1:3111",
            reuseExistingServer: true,
            timeout: 120_000,
            // This server sources no env file, so anything in the shell reaches the app under
            // test. Blobs are still pinned to the directory — a suite must not leave chains on
            // Irys that expire — but the Tempo treasury is passed through rather than blanked: it
            // is the only rail a billed call is paid on, so a console without one runs everything
            // scripted and the billed cases check nothing. A run therefore spends real USDC.e, at
            // well under twenty cents a run. Set it in the shell (or leave it
            // to `.tempo-treasury.key` via `dev-devnet.sh`, which is how the app is normally
            // started for the suite).
            env: {
              LATH_TEMPO_TREASURY: process.env.LATH_TEMPO_TREASURY ?? "",
              LATH_TRACE_BACKEND: "fs",
            },
          },
        ]),
  ],
});
