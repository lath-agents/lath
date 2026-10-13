import { expect, test } from "@playwright/test";
import { openInfo } from "./disclose";
import { connectWallet } from "./wallet";

/**
 * The workspace (`/`): the wallet's agents with their runs nested under them, the selected one open
 * beside the list, and Solana and Tempo as tabs of the same page, the tab and the selection in the
 * URL.
 *
 * Nothing lists other wallets' agents, so the cases are the workspace's own: the tabs are in the
 * URL, the list routes `/agents`, `/loops` and `/market` land on it, the headline's ⓘ holds the
 * Record / Pay / Verify strip and the team's figures, and an agent row selects its panel, whose
 * *Agent details* is the link to the agent page.
 *
 * Read-only. Without a wallet every page is blurred behind the wallet gate. Devnet is slow
 * and the wallet's reads are a header scan plus the decorating reads, so the waits are generous and
 * the suite is run `--timeout=240000 --workers=1`.
 */

const LIST_READY = 120_000;

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

test("without a wallet, every page is blurred behind one prompt to connect, and the nav stays usable", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // `/agents`, `/loops` and `/market` are server redirects into the workspace; each lands, gated, on
  // `/`, so an old link to one lands rather than 404s.
  for (const [path, landed] of [
    ["/", /\/$/],
    ["/agents", /\/$/],
    ["/loops", /\/$/],
    ["/market", /\/$/],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(landed);
    await expect(page.getByTestId("wallet-gate")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("wallet-gated")).toHaveAttribute("aria-hidden", "true");
    // No tabs: the Lath mark is Agents, and the two chain pills are the other views.
    await expect(page.getByTestId("nav-home")).toHaveAttribute("href", "/");
    await expect(page.getByTestId("nav-solana")).toHaveAttribute("href", "/?tab=solana");
    await expect(page.getByTestId("nav-tempo")).toHaveAttribute("href", "/?tab=tempo");
  }
});

test("connected, the workspace leads with what Lath is for, opens on Yours, and keeps its tab in the URL", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await connectWallet(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Every action recorded on Solana, every model call paid on Tempo"
  );
  // `/` is the Agents view, which has no tab, so the nav lights none.
  await expect(page.locator('[data-testid^="nav-"][aria-current="page"]')).toHaveCount(0);
  await expect(page.getByTestId("workspace-yours")).toBeVisible({ timeout: LIST_READY });
  // One _Create_; `/create` asks agent or agent loop.
  await expect(page.getByTestId("landing-create")).toHaveAttribute("href", "/create");

  // The Record / Pay / Verify strip is behind the headline's ⓘ, with the team's figures under it. The figures are read only once the popover mounts.
  await openInfo(page.getByTestId("landing-info"));
  const how = page.getByTestId("landing-info-body");
  await expect(how.getByTestId("landing-steps").getByRole("listitem")).toHaveCount(3);
  await expect(how.getByTestId("team-activity")).toBeVisible({ timeout: LIST_READY });
  await page.keyboard.press("Escape");

  // Each tab is `/?tab=…`, lit in the nav and drawn as its own section.
  await page.getByTestId("nav-solana").click();
  await expect(page).toHaveURL(/[?&]tab=solana/);
  await expect(page.getByTestId("nav-solana")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("workspace-solana")).toBeVisible({ timeout: LIST_READY });

  await page.getByTestId("nav-tempo").click();
  await expect(page).toHaveURL(/[?&]tab=tempo/);
  await expect(page.getByTestId("nav-tempo")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("workspace-tempo")).toBeVisible({ timeout: LIST_READY });

  // Back to Agents by the Lath mark, the view's way in.
  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("workspace-yours")).toBeVisible({ timeout: LIST_READY });
});

test("an agent row selects its panel, whose Agent details links to the agent page, and /agents?agent= lands on it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await connectWallet(page);
  // An agent row is `owner-row` at depth 0 (a team member's row is `owner-row` too, at depth 2 under
  // its run); its select button is `explore-row`, which carries the agent id.
  const spine = page.getByTestId("owners-spine");
  await expect(spine).toBeVisible({ timeout: LIST_READY });
  const row = spine.locator('[data-testid="owner-row"][data-depth="0"]').first();
  await expect(row).toBeVisible({ timeout: LIST_READY });
  const id = await row.getAttribute("data-agent-id");
  expect(id).toMatch(/^[0-9a-f]+$/);
  const select = row.getByTestId("explore-row");
  await expect(select).toHaveAttribute("data-agent-id", id!);

  // Selecting is not a navigation: the panel opens beside the list and the URL records the item.
  await select.click();
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id}`));
  const panel = page.getByTestId("owner-spine");
  await expect(panel).toBeVisible();
  const open = panel.getByTestId("agent-open");
  await expect(open).toHaveAttribute("href", `/agent/${id}`);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/agent/${id}$`));

  // The `/agents?agent=` deep link lands on the same agent, selected.
  await page.goto(`/agents?agent=${id}`);
  await expect(page).toHaveURL(new RegExp(`/\\?item=${id}$`));
  await connectWallet(page);
  await expect(page.getByTestId("workspace-yours")).toBeVisible({ timeout: LIST_READY });
  await expect(
    page.locator(`[data-testid="owner-row"][data-depth="0"][data-agent-id="${id}"]`).getByTestId("explore-row")
  ).toHaveAttribute("aria-pressed", "true", { timeout: LIST_READY });
  await expect(page.getByTestId("owner-spine").getByTestId("agent-open")).toHaveAttribute("href", `/agent/${id}`);
});
