import { expect, type Page } from "@playwright/test";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authMessage, loopAuthBinding, type AuthBinding, type AuthPurpose } from "@lath/sdk";

/**
 * The E2E wallet, both ways a spec holds it. In the browser, `connectWallet` (at the end) connects
 * it through the header the way a person would. In Node, the rest is what a spec needs when it is
 * the wallet itself rather than driving the browser's — an API call signed the way the browser
 * signs, or a start body changed on its way out and signed again.
 *
 * Not a spec file (Playwright only collects `*.spec.ts`), so the specs that sign share one copy of
 * the key reader and the signer rather than six. A signed message names the site asking for it,
 * and a loop start's names the hash of the body it is posted with, so the two things these specs
 * do — sign for a `{ action, target }` pair, and patch terms into a start the chips do not offer
 * after the browser signed it — both need this: the first must say which console it is for, and
 * the second must sign the patched body again, because the route refuses a start whose body is not
 * the one its signature hashes. That refusal is the point of the binding; a spec holding the
 * wallet's own key is not what it is for.
 */

/**
 * The console the specs post to: `playwright.config.ts`'s `baseURL`, restated because a helper
 * cannot read the config's resolved value outside a test fixture. The server under test has no
 * `LATH_CONSOLE_ORIGIN` (`scripts/dev-devnet.sh --e2e` sets none), so it checks a message's domain
 * against the request's own `Host`, which for a request to this URL is this URL's host.
 */
export const CONSOLE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3111";

/** The domain and URI a message for `url` carries: its host and origin, the way `window.location` gives them. */
export function consoleOrigin(url: string = CONSOLE_URL): { domain: string; uri: string } {
  const u = new URL(url);
  return { domain: u.host, uri: u.origin };
}

/**
 * The E2E wallet's secret, as the seed script prints it into `frontend/.env.devnet.e2e`. The browser
 * holds the same key through the adapter (`lib/e2e-wallet.ts`); a spec needs it to sign in Node.
 */
export function e2eKeypair(): Keypair {
  const file = process.env.E2E_ENV_FILE ?? path.join(process.cwd(), ".env.devnet.e2e");
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith("NEXT_PUBLIC_E2E_WALLET_SECRET="));
  if (!line) throw new Error(`${file} has no NEXT_PUBLIC_E2E_WALLET_SECRET; seed with --e2e-wallet`);
  const raw = line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

/**
 * A write route's `auth`: the SDK's `authMessage` — the function the browser and `verifyAuth` both
 * call — signed with the wallet's ed25519 seed. A 64-byte web3.js secret key is `seed ‖ pubkey` and
 * ed25519 signs with the seed. Each nonce is single-use server-side, so every call gets a fresh
 * one; `bound` is the request the signature is for, which the route compares against its own,
 * and `origin` the console it is for.
 */
export function signAuth(
  purpose: AuthPurpose,
  bound: AuthBinding,
  opts: { keypair?: Keypair; cluster?: string; origin?: { domain: string; uri: string } } = {}
): { message: string; signature: string } {
  const keypair = opts.keypair ?? e2eKeypair();
  const message = authMessage(purpose, {
    ...bound,
    ...(opts.origin ?? consoleOrigin()),
    cluster: opts.cluster ?? process.env.NEXT_PUBLIC_CLUSTER ?? "devnet",
    wallet: keypair.publicKey.toBase58(),
    issued: new Date().toISOString(),
    nonce: randomBytes(16).toString("hex"),
  });
  const signature = ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32));
  return { message, signature: Buffer.from(signature).toString("base64") };
}

/**
 * A `/api/loops` start body the browser signed, with terms changed and signed again for the console
 * at `url` (the request's own, from `route.request().url()`): the `auth` the browser attached is
 * dropped — its hash is the old body's — and the wallet signs the new body's binding. For use in a
 * `page.route` handler, where a spec patches `maxSteps`, `intervalMs` or a trigger the form's chips
 * do not offer; the body it hands on is the one the server starts, so assert on it, not on the
 * browser's.
 */
export function resignStart(body: Record<string, unknown>, url: string): Record<string, unknown> {
  const { auth, ...terms } = body;
  // An unsigned POST on the same route (`check-sources`) carries nothing to sign again.
  if (!auth) return terms;
  const binding = loopAuthBinding(terms);
  return { ...terms, auth: signAuth("Lath loop", binding, { cluster: clusterOf(auth), origin: consoleOrigin(url) }) };
}

/** The cluster the browser's own message named, so the re-signed one agrees with the server it is for. */
function clusterOf(auth: unknown): string | undefined {
  const message = auth && typeof auth === "object" ? (auth as { message?: unknown }).message : undefined;
  if (typeof message !== "string") return undefined;
  return message
    .split("\n")
    .find((l) => l.startsWith("Chain ID: "))
    ?.slice("Chain ID: ".length);
}

/**
 * Connects the devnet E2E keypair (`lib/e2e-wallet.ts`) through the header's *Select Wallet*, the
 * way every wallet-holding spec does inline. Every page sits behind the wallet gate
 * (`components/WalletGate.tsx`) until a wallet connects, so a spec that only reads needs it too.
 * The gate's own button is a second *Select Wallet*; `.first()` is the header's, which comes first
 * in the document.
 *
 * `.wallet-adapter-button-trigger` is waited for first because the header's button is a
 * `dynamic(..., { ssr: false })` import: until it arrives `count()` reads 0 and the branch below
 * would skip the connect.
 */
export async function connectWallet(page: Page): Promise<void> {
  await expect(page.locator(".wallet-adapter-button-trigger").first()).toBeVisible({ timeout: 60_000 });
  const select = page.getByRole("button", { name: /select wallet/i });
  if (await select.count()) {
    await select.first().click();
    await page.getByRole("button", { name: /E2E Keypair/i }).click();
  }
  await expect(page.getByRole("button", { name: /select wallet/i })).toHaveCount(0);
  await expect(page.getByTestId("wallet-gate")).toHaveCount(0);
  // The adapter's modal fades out after the connect, and until it unmounts its own `<h1>` sits in
  // the document beside the page's, so a spec's `getByRole("heading", { level: 1 })` hits two
  // elements and fails strict mode.
  await expect(page.locator(".wallet-adapter-modal")).toHaveCount(0, { timeout: 15_000 });
}
