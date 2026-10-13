import { expect, test } from "@playwright/test";
import { createHash } from "crypto";
import { openProof } from "./disclose";
import { connectWallet } from "./wallet";
// Every page sits behind the wallet gate (`components/WalletGate.tsx`): connect the E2E wallet
// once, and each later `page.goto` in the test reconnects it through `autoConnect`. It connects on
// the workspace's Tempo tab (`/?tab=tempo`) rather than on Yours, because Yours scans the wallet's
// agents the moment the gate lifts, and these specs read other pages.
test.beforeEach(async ({ page }) => {
  await page.goto("/?tab=tempo");
  await connectWallet(page);
});

/**
 * "Check it without this page", checked (`VerifyPanel.tsx`).
 *
 * The console's verification badges are only as good as a reader's trust in the console. What
 * removes it is the block under each trace: the gateway url the page fetched, the chain account
 * the fingerprint came out of, and a `curl … | shasum` line whose expected digest came off the
 * chain. So this spec does not assert that the block *renders* — it takes the link and the
 * digest the page printed, downloads the bytes from outside the browser, and hashes them here.
 * If the page ever prints a url and a hash that do not belong together, this fails.
 *
 * The events and _Verify offline_ are behind the agent page's one **Proof**, so each case opens
 * it first, as a reader would.
 */

/** The id `scripts/seed.ts` creates. `agent_id = sha256(name)`, so it is derivable. */
const AGENT = createHash("sha256").update("seed-agent-alpha").digest("hex");

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`uncaught in page: ${e.message}`);
  });
});

test("the link and the digest a trace prints agree, fetched outside the browser", async ({ page, request }) => {
  await page.goto(`/agent/${AGENT}`);
  await openProof(page, "proof", 120_000);
  const action = page.locator('[data-testid="timeline-record"][data-kind="Action"]').first();
  await action.getByRole("button", { name: "Open" }).click();

  const panel = page.getByTestId("trace-panel").first();
  await expect(panel).toContainText("sha256 matches payload_hash");

  const verify = panel.getByTestId("verify-block");
  await expect(verify).toBeVisible();

  // The block is collapsed until asked for: the offer is always on screen, the apparatus is not.
  // Opening it is the reader's first act, so it is this spec's too.
  await verify.getByTestId("verify-toggle").click();

  // The url is the anchor's href, not its text: what a reader clicks is what gets checked.
  const url = await verify.getByTestId("blob-link").getAttribute("href");
  expect(url).toBeTruthy();

  // The command carries the digest the chain committed, and quotes that same url.
  const command = await verify.getByTestId("verify-command").locator("pre").innerText();
  expect(command).toContain(`curl -sL "${url}"`);
  const expected = command.match(/# expect: ([0-9a-f]{64})/)?.[1];
  expect(expected).toBeTruthy();

  // Playwright's request context is not the page: this is the auditor's `curl`.
  const blob = await request.get(url!);
  expect(blob.status()).toBe(200);
  expect(
    createHash("sha256")
      .update(await blob.body())
      .digest("hex")
  ).toBe(expected);
});

test("the whole chain has a command a stranger can run", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);
  // The toggle sits in the Events toolbar and opens the panel as a row under it; the toolbar is
  // inside the Proof.
  await openProof(page, "proof", 120_000);
  await page.getByTestId("chain-verify-toggle").click();
  const offline = page.getByTestId("chain-verify");
  const command = await offline.getByTestId("audit-command").locator("pre").innerText();
  expect(command).toContain(`npm run -s audit -- ${AGENT}`);
  expect(command).toContain("--require-preimages");

  // The gateway in the line is the one that serves the chain's own locators, not whatever this
  // deployment writes with: the seed writes Raw ones and the raw gateway is what a green run
  // prints, while a chain on Irys has to print `gateway.irys.xyz` with the spelling that gateway
  // serves. Playwright never seeds an Irys chain — it would spend, and devnet Irys expires — so
  // the second branch is the nightly's; asserting the pair here
  // catches a reader that ever prints one without the other.
  const gateway = command.match(/--gateway (\S+)/)?.[1];
  expect(gateway).toBeTruthy();
  if (gateway === "https://gateway.irys.xyz") expect(command).toContain("--scheme 4 --encoding base64url");
  else expect(command).toContain("--scheme 0 --encoding hex");
});
