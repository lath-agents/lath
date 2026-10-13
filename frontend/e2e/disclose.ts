import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The disclosures the console folds its detail behind, opened the way a person opens them.
 *
 * Not a spec file (Playwright only collects `*.spec.ts`). Every helper here opens a box only when it
 * is closed and leaves an open one alone, so a spec may call it twice — once on the way in, once
 * after a reload — without toggling the box shut. The specs open the disclosure rather than loosen
 * an assertion: what sits behind a fold is still asserted, one click further in.
 *
 * - **`Proof`** (`components/ui.tsx`): a button `<id>-toggle` with `aria-expanded`, and a body
 *   `<id>-body` that mounts only while open. The agent page's is `proof`, the loop page's
 *   `loop-proof`, the workspace run panel's `run-proof`. `?proof=1`, and on the agent page `?seq`,
 *   `?at` and `?prove`, open it on load.
 * - **`Info`** (`components/ui.tsx`): a ⓘ button with `aria-expanded` whose popover is portalled to
 *   `document.body`, so its body is found from `page`, not from the trigger's card. A click pins it
 *   open; a second click on a pinned one closes it, which is why these helpers read `aria-expanded`
 *   before they click. Any press outside closes it.
 * - **The agent page's ⋯ menu** (`OwnerHeaderCard.tsx`): `agent-actions-menu`, whose items —
 *   `agent-clone`, `agent-use-version`, `agent-archive`, `agent-unarchive` — render
 *   only while it is open, and choosing one closes it.
 * - **The loop form's options** (`LoopStartForm.tsx`): `loop-advanced-body`. It is not a disclosure:
 *   every option is on screen, and `openAdvanced` only waits for the section.
 */

/** Opens a `Proof` disclosure if it is closed, and returns its body. */
export async function openProof(page: Page, testId = "proof", timeout = 60_000): Promise<Locator> {
  const toggle = page.getByTestId(`${testId}-toggle`).first();
  await expect(toggle).toBeVisible({ timeout });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return page.getByTestId(`${testId}-body`).first();
}

/**
 * Opens an `Info` popover from its trigger, pinned, if it is not open already. The popover's own
 * `testId`, when it has one, is then found with `page.getByTestId`, since it is portalled.
 */
export async function openInfo(trigger: Locator, timeout = 60_000): Promise<void> {
  await expect(trigger).toBeVisible({ timeout });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

/** Closes whatever `Info` is open: Escape closes one from anywhere. */
export async function closeInfo(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

/** The loop page's _Configuration_ section (on the page, not an `Info`); returns its list (`loop-terms`). */
export async function openLoopTerms(page: Page, timeout = 120_000): Promise<Locator> {
  const terms = page.getByTestId("loop-terms");
  await expect(terms).toBeVisible({ timeout });
  return terms;
}

/** Opens the agent page's ⋯ menu if it is closed. Its items exist only while it is open. */
export async function openAgentMenu(page: Page, timeout = 60_000): Promise<void> {
  const menu = page.getByTestId("agent-actions-menu");
  await expect(menu).toBeVisible({ timeout });
  if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  await expect(page.getByTestId("agent-actions-list")).toBeVisible();
}

/**
 * One owner action from the ⋯ menu: opens the menu, waits for the item to be enabled (an action
 * that is running disables every item), and chooses it, which closes the menu.
 */
export async function agentAction(
  page: Page,
  testId: "agent-clone" | "agent-use-version" | "agent-archive" | "agent-unarchive",
  timeout = 60_000
): Promise<void> {
  await openAgentMenu(page, timeout);
  const item = page.getByTestId(testId);
  await expect(item).toBeEnabled({ timeout });
  await item.click();
}

/**
 * The loop form's options section, with every option in the open. It is named after the section's
 * test id, `loop-advanced-body`.
 */
export async function openAdvanced(scope: Page | Locator, timeout = 60_000): Promise<Locator> {
  const body = scope.getByTestId("loop-advanced-body");
  await expect(body).toBeVisible({ timeout });
  return body;
}

/**
 * Every link to the Tempo explorer inside `scope`, with its `href`, read and never followed. A
 * `TempoLink` carries `data-tempo-kind`; a block number is a plain anchor to the same explorer, so
 * both are collected by the host in the `href`.
 */
export async function tempoHrefs(scope: Page | Locator): Promise<string[]> {
  const links = scope.locator('a[data-tempo-kind], a[href*="tempo.xyz"]');
  return links.evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""));
}

/**
 * The one shape a Tempo explorer link may have: explore.tempo.xyz, and a transaction, an address or
 * a block on it (`lib/tempo.ts` `tempoTxUrl`, `tempoAddressUrl`, `tempoTokenUrl`, `tempoBlockUrl`).
 */
export const TEMPO_EXPLORER_HREF =
  /^https:\/\/explore\.tempo\.xyz\/(tx\/0x[0-9a-fA-F]{64}|address\/0x[0-9a-fA-F]{40}|block\/[0-9]+)$/;
