import { expect, test } from "@playwright/test";
import { connectWallet } from "./wallet";
import { TEMPO_EXPLORER_HREF, openInfo, tempoHrefs } from "./disclose";

/**
 * The workspace's Tempo tab, read and nothing else.
 *
 * Everything on the tab is public — the treasury route reads Tempo's chain with no key — so this spec signs
 * nothing, starts nothing and never follows a link off the console: a Tempo link is checked by its
 * `href`, which is what a reader's click would open. It cannot spend on either chain.
 *
 * What it holds the tab to:
 *
 * the treasury's address is a link to its page on explore.tempo.xyz, the same address the treasury
 * route answers with, and so are the token and the escrow contract, and nothing on the tab links to
 * Tempo by another road.
 *
 * Run it against a console with a treasury; it skips itself when the route says there is none:
 *
 * ```bash
 * PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test e2e/tempo-tab.spec.ts --workers=1 --timeout=240000
 * ```
 */

interface Treasury {
  enabled: boolean;
  address?: string;
  token?: string;
  unreachable?: string;
}

let treasury: Treasury;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  treasury = await (await request.get("/api/tempo/treasury")).json();
});

test.beforeEach(async ({ page }) => {
  test.skip(!treasury?.enabled, "this console has no Tempo treasury, so the Tempo tab has nothing of its own to read");
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
  // The nav's Tempo tab is a link to `/?tab=tempo`; the spec arrives there the way a reader does, by
  // the tab, after the wallet gate lifts.
  await page.goto("/?tab=tempo");
  await connectWallet(page);
  await expect(page.getByTestId("nav-tempo")).toHaveAttribute("href", "/?tab=tempo");
  await expect(page.getByTestId("nav-tempo")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("tempo-tab")).toBeVisible({ timeout: 60_000 });
});

test("the treasury links to its own page on explore.tempo.xyz, with the token and the escrow", async ({ page }) => {
  test.setTimeout(2 * 60_000);

  const card = page.getByTestId("tempo-treasury");
  const address = card.getByTestId("tempo-treasury-address").getByRole("link");
  await expect(address).toBeVisible({ timeout: 60_000 });
  // The address the route serves, not just any address: the link is the treasury's.
  await expect(address).toHaveAttribute("href", `https://explore.tempo.xyz/address/${treasury.address}`);
  await expect(address).toHaveAttribute("target", "_blank");
  // The balance, or the RPC's reason it was not read — never a blank.
  await expect(card.getByTestId("tempo-treasury-balance")).toHaveText(/^[0-9]+\.[0-9]+ USDC\.e$|\S/);
  expect((await card.getByTestId("tempo-treasury-balance").innerText()).trim()).not.toBe("");
  // A token has no page of its own on the explorer; its contract's address page is where its
  // transfers are (`tempoTokenUrl`).
  if (treasury.token)
    await expect(card.getByTestId("tempo-token").getByRole("link")).toHaveAttribute(
      "href",
      `https://explore.tempo.xyz/address/${treasury.token}`
    );
  await expect(card.getByTestId("tempo-escrow").getByRole("link")).toHaveAttribute(
    "href",
    /^https:\/\/explore\.tempo\.xyz\/address\/0x[0-9a-fA-F]{40}$/
  );

  // The full value is in the link's Info, with its own copy of the explorer link — same page.
  await openInfo(card.getByTestId("tempo-treasury-address").getByRole("button").first());
  const popover = page.getByRole("dialog", { name: /on Tempo$/ });
  await expect(popover).toContainText(treasury.address!);
  await expect(popover.getByRole("link", { name: /explore\.tempo\.xyz/ })).toHaveAttribute(
    "href",
    `https://explore.tempo.xyz/address/${treasury.address}`
  );

  // And nothing on the tab links to a Tempo page by any other road.
  for (const href of await tempoHrefs(page.getByTestId("tempo-tab"))) expect(href).toMatch(TEMPO_EXPLORER_HREF);
});
