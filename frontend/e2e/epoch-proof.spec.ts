import { expect, Page, test } from "@playwright/test";
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
 * Epoch inclusion proofs, in the browser.
 *
 * The epoch panel already rebuilds the blob's Merkle root and compares it to the root
 * `EpochCommitted` carries. These two cases are the step-level half of that claim: one step's
 * sibling path re-hashed to the chain's root by the page itself, and — through the gateway's
 * `/__tamper/` seam — the same page refusing bytes that are not the epoch the chain named.
 *
 * The timeline is behind the agent page's one **Proof**; the chain badge above it stays in the
 * header.
 */

/** The id `scripts/seed.ts` creates. `agent_id = sha256(name)`, so it is derivable. */
const AGENT = createHash("sha256").update("seed-agent-alpha").digest("hex");
const GATEWAY = process.env.LATH_TRACE_GATEWAY ?? "http://127.0.0.1:3112";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`uncaught in page: ${e.message}`);
  });
});

/**
 * Opens the first epoch of the owner's timeline — epoch #1, the one ordered first by `startSeq` —
 * opening the Proof it sits in first. After a reload the Proof is open already (its toggle wrote
 * `?proof=1` into the URL), and `openProof` leaves an open one alone.
 */
async function openFirstEpoch(page: Page) {
  await openProof(page, "proof", 120_000);
  const row = page.getByTestId("timeline-epoch").first();
  // The timeline renders once the chain has verified, and every reload verifies again — the same ~35 s
  // re-sync the chain-status wait below allows for.
  await expect(row).toBeVisible({ timeout: 120_000 });
  await row.getByRole("button", { name: /open steps/i }).click();
}

test("a step's inclusion proof is rebuilt in the browser and checked against the chain's root", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);
  // seed-agent-alpha carries closed cells, so the verifier re-syncs its head from ~50 history reads;
  // on devnet that takes about as long as the CLI audit (~35 s), past the 30 s expect default.
  await expect(page.getByTestId("chain-status")).toContainText(/verified on Solana/i, { timeout: 120_000 });

  // A record is its own compressed account; the epoch row stands for a run of steps that have none.
  await openProof(page, "proof", 120_000);
  await expect(page.getByTestId("timeline-record").first().getByTestId("storage-tier")).toHaveText("record");
  await expect(page.getByTestId("timeline-epoch").first().getByTestId("storage-tier")).toHaveText("epoch #1");

  await openFirstEpoch(page);
  const panel = page.getByTestId("epoch-steps").first();
  await expect(panel).toContainText("Root rebuilt in this browser matches the chain");

  // Step 2 of the epoch: row index 1, which is seq `startSeq + 1` and Merkle leaf index 1.
  const step2 = panel.getByTestId("epoch-step").nth(1);
  await expect(step2.getByTestId("storage-tier")).toHaveText("epoch #1");
  await step2.getByTestId("epoch-step-prove").click();

  // The badge names what was computed: the leaf plus N siblings re-hashed to `epoch_root`.
  await expect(step2.getByTestId("proof-badge")).toContainText(/^proof verified · \d+-node path$/);
  await expect(step2.getByTestId("storage-tier")).toHaveText("epoch #1 · proof verified");

  // Only the proved row earns the second label — the others came from the same blob and say so.
  await expect(panel.getByTestId("epoch-step").nth(0).getByTestId("storage-tier")).toHaveText("epoch #1");
});

test("a gateway that serves the wrong bytes for an epoch is caught, not believed", async ({ page, request }) => {
  // The blob's name in the gateway is the locator id the chain published, which
  // `FsLocatorBackend` picked at random — so it is read off the request the page actually made,
  // recognised by the `"LEP1"` epoch-blob magic.
  const blobNames: string[] = [];
  page.on("response", async (res) => {
    if (!res.url().startsWith(GATEWAY)) return;
    try {
      const body = await res.body();
      if (body.subarray(0, 4).toString("utf8") === "LEP1") blobNames.push(new URL(res.url()).pathname.slice(1));
    } catch {
      // A response whose body is gone by the time we ask is not the one we are after.
    }
  });

  await page.goto(`/agent/${AGENT}`);
  await openFirstEpoch(page);
  await expect(page.getByTestId("epoch-steps").first()).toBeVisible();
  await expect.poll(() => blobNames.length).toBeGreaterThan(0);
  const name = blobNames[0];

  const tampered = await request.post(`${GATEWAY}/__tamper/${name}`);
  expect(tampered.status()).toBe(204);
  try {
    await page.reload();
    await openFirstEpoch(page);
    await expect(page.getByText(/Merkle root is not the one the chain folded/i)).toBeVisible();
    await expect(page.getByTestId("epoch-steps")).toHaveCount(0);
  } finally {
    await request.delete(`${GATEWAY}/__tamper/${name}`);
  }

  // And with the gateway honest again, the same row resolves.
  await page.reload();
  await openFirstEpoch(page);
  await expect(page.getByTestId("epoch-steps").first()).toContainText("Root rebuilt in this browser matches the chain");
});
