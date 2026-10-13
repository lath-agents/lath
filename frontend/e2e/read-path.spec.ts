import { expect, test } from "@playwright/test";
import { createHash } from "crypto";
import { openProof } from "./disclose";
import { connectWallet } from "./wallet";
// Every page sits behind the wallet gate (`components/WalletGate.tsx`): connect the E2E wallet
// once, and each later `page.goto` in the test reconnects it through `autoConnect`. It connects on
// the workspace's Tempo tab (`/?tab=tempo`) rather than on Yours, because Yours scans the wallet's
// agents the moment the gate lifts, and these specs read other pages.
//
// The agent page's records — the Data card's structures, the Events timeline and each record's
// trace — sit behind its one *Proof*, so the cases that read them open it first.
test.beforeEach(async ({ page }) => {
  await page.goto("/?tab=tempo");
  await connectWallet(page);
});

/** The ids `scripts/seed.ts` creates. `agent_id = sha256(name)`, so they are derivable. */
const id = (name: string) => createHash("sha256").update(name).digest("hex");
const AGENT = id("seed-agent-alpha");

/** Any uncaught exception in the page is a failure, whatever the DOM ends up looking like. */
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`uncaught in page: ${e.message}`);
  });
});

test("an agent's chain reads and verifies in the browser", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);

  // The badge is the whole test: producing it means the page fetched every record through
  // Photon, decoded 147-byte accounts, and replayed sha256 over them — client-side.
  // seed-agent-alpha carries closed cells, so the verifier re-syncs its head from ~50 history reads;
  // on devnet that takes about as long as the CLI audit (~35 s), past the 30 s expect default.
  await expect(page.getByTestId("chain-status")).toContainText(/verified on Solana/i, { timeout: 120_000 });

  await openProof(page);
  // Genesis, two actions, a delegation and a resolution, from the seed script.
  const rows = (kind: string) => page.locator(`[data-testid="timeline-record"][data-kind="${kind}"]`);
  await expect(rows("Genesis")).toHaveCount(1);
  await expect(rows("Resolution")).toHaveCount(1);
  await expect(rows("Action")).toHaveCount(2);
  await expect(page.getByTestId("timeline").getByText("504")).toBeVisible();
});

test("the nav names the deployment's chains without a wallet", async ({ browser, baseURL }) => {
  // The `beforeEach` connected the shared page, so the walletless reader is a fresh context: it has
  // no remembered wallet name in localStorage, so `autoConnect` has nothing to reconnect.
  // `browser.newContext()` does not inherit the config's `use`, hence the explicit `baseURL`.
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  try {
    await page.goto("/");
    // The page itself is behind the wallet gate, but the nav stays above it. Its _Solana · devnet_
    // and _Tempo · mainnet_ pills are the links to the Solana and Tempo views.
    await expect(page.getByTestId("wallet-gate")).toBeVisible({ timeout: 30_000 });
    // The workspace behind it is never mounted.
    await expect(page.getByTestId("workspace-yours")).toHaveCount(0);
    await expect(page.getByTestId("nav-solana")).toContainText("devnet");
    await expect(page.getByTestId("nav-tempo")).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("an unknown id is a 404", async ({ page }) => {
  await page.goto(`/agent/${id("nobody-registered-this")}`);
  await expect(page.getByTestId("not-found")).toBeVisible();
});

test("an agent's logs, maps and sets read off the chain", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);

  // Six structures from `scripts/seed.ts`: a Log, a Map, a Set and the consumable Log in
  // the shape of a mailbox — plus the locator registry that anchoring traces creates and the
  // profile the agent published its name in.
  // They sit in the Data card's *System structures* section, collapsed until opened, and the Data
  // card is inside the Proof.
  await openProof(page);
  await page.getByTestId("system-structures-toggle").click();
  const structures = page.getByTestId("structure-row");
  await expect(structures).toHaveCount(6);
  await expect(page.getByText("Locator Registry")).toBeVisible();
  await expect(page.getByText("Profile & Name Record")).toBeVisible();

  // Expanding one decodes its cells. The values are under 32 bytes, so the slot *is* the value
  // and a reader with no trace store still sees it.
  await structures.filter({ hasNotText: "Locator Registry" }).filter({ hasNotText: "Profile" }).first().click();
  await expect(page.getByText(/quarter summary drafted|claude-opus-5|http\.get/).first()).toBeVisible();
});

test("a trace resolves through the on-chain locator map and re-hashes", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);
  await openProof(page);
  const action = page.locator('[data-testid="timeline-record"][data-kind="Action"]').first();
  await action.getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("trace-panel").first()).toContainText("sha256 matches payload_hash");
  await expect(page.getByText("https://example.com")).toBeVisible();
});

test("the seeded agent's published name is read from the chain, with no name book", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);
  // The name is read from the registry on chain, with no local name book in play; no badge says
  // so, so the name itself is the claim.
  await expect(page.getByTestId("owner-name")).toHaveText("seed-agent-alpha");
});
