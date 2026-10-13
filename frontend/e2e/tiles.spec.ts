import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { connectWallet, e2eKeypair } from "./wallet";

/**
 * The workspace's Yours list: one list of the wallet's agents, each loop run nested under its
 * agent, the selected item open beside it.
 *
 * `/agents` and `/loops` redirect to `/`, and the list's rows are an agent row (`owner-row`,
 * depth 0, its select button `explore-row`) with its runs under it (`loop-row`, depth 1,
 * `data-loop-id` and the agent's `data-agent-id`), the older runs folded behind `earlier-runs`. The
 * claims are made of that list: it is one list beside the selected item with no view toggle, the
 * pick is in the URL (`item`, `run`) and survives a reload, a run's row says what its loop record
 * says, and the agent panel links to its page.
 *
 * Nothing here deploys, starts a loop or signs anything. The list is a **view** over rows the
 * wallet already owns, so the way to test it is to read what devnet already holds under the E2E
 * wallet rather than to write a fixture for it — which also keeps this file out of the way of the
 * specs that do write (`loop-run-again`) when the suite runs in order. The consequence is that each
 * case skips itself when the wallet holds no row of the kind it is about, and says so; a wallet
 * seeded by `scripts/seed.ts --devnet --e2e-wallet` and used by the suite holds plenty.
 *
 * Devnet is slow — the owner scan alone is 10–20 s on this wallet — so every wait here is generous
 * and the suite is run `--timeout=240000 --workers=1`.
 */

/** The owner scan plus the registry and loop reads behind a first full list (7.7–19.4 s measured). */
const LIST_READY = 120_000;

test.beforeEach(async ({ page }) => {
  // No `GET /api/run` gate: these cases read the console's own lists and never open a session,
  // so a server that cannot run one is still a server that can answer this.
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/**
 * Wait for the Yours list to have *answered*, which is not the same as having rows: an empty list
 * and a list still scanning look identical, and asserting a count on the second is how a read spec
 * passes for the wrong reason.
 */
async function agentsAnswered(page: Page) {
  await expect
    .poll(
      async () =>
        (await page.getByTestId("owner-row").count()) > 0 ||
        (await page.getByText(/This wallet has no agents yet/).count()) > 0 ||
        (await page.getByTestId("owners-partial").count()) > 0,
      { timeout: LIST_READY, intervals: [2_000] }
    )
    .toBe(true);
}

/**
 * How many unarchived runs the registry holds for the E2E wallet. The workspace lists agents as soon
 * as their headers read and nests runs once the loop read answers, so an agent row on screen says
 * nothing about whether the runs have arrived; the registry's own count is what a case skips on, and
 * what it waits for the list to show.
 */
async function walletRuns(request: APIRequestContext): Promise<number> {
  const owner = e2eKeypair().publicKey.toBase58();
  const res = await request.get(`/api/loops?owner=${owner}`);
  expect(res.status()).toBe(200);
  return ((await res.json()).loops as unknown[]).length;
}

/** Wait for the list to nest the runs: a run row, or the note that the registry did not answer. */
async function runsAnswered(page: Page) {
  await expect
    .poll(
      async () =>
        (await page.getByTestId("loop-row").count()) > 0 ||
        (await page.getByText(/The loop registry did not answer/).count()) > 0,
      { timeout: LIST_READY, intervals: [2_000] }
    )
    .toBe(true);
}

/** Unfold every agent's _N earlier runs_, so every run of the wallet has its row. */
async function unfoldEarlierRuns(page: Page) {
  const folds = page.locator('[data-testid="earlier-runs"][aria-expanded="false"]');
  while ((await folds.count()) > 0) await folds.first().click();
}

/* ------------------------------------------------------------------------------------------ */

// The list is the workspace's: `/agents` redirects to `/`. The rows carry the `owner-row` /
// `data-agent-id` handles the specs that count or resolve rows look them up by.
test("the Yours list is one list beside the selected agent, with no view toggle", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/$/);
  await connectWallet(page);
  await agentsAnswered(page);

  const rows = page.getByTestId("owner-row");
  test.skip((await rows.count()) === 0, "this wallet owns no agents on this cluster, so there is no list to read");

  await expect(page.getByTestId("owners-spine")).toBeVisible();
  // An empty selection opens the first agent, so a panel is always beside the list.
  await expect(page.getByTestId("owner-spine")).toBeVisible();
  // Every row is in the list, so the list's rows are all the rows on the page.
  await expect(page.getByTestId("owners-spine").getByTestId("owner-row")).toHaveCount(await rows.count());
  await expect(page.getByRole("tablist", { name: "Agents view" })).toHaveCount(0);
  await expect(page.getByTestId("owners-grid")).toHaveCount(0);
  await expect(page.getByTestId("explore-grid")).toHaveCount(0);
  await expect(page.locator("table")).toHaveCount(0);
});

test("the Yours list keeps the selected agent across a reload", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await connectWallet(page);
  await agentsAnswered(page);

  // Agent rows only: a team member's row is an `owner-row` too, at depth 2 under its run.
  const rows = page.getByTestId("owners-spine").locator('[data-testid="owner-row"][data-depth="0"]');
  test.skip((await rows.count()) < 2, "fewer than two agents, so no pick differs from the default");

  // The second row, because the first is what an empty selection shows anyway.
  const id = await rows.nth(1).getAttribute("data-agent-id");
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  const pick = page
    .locator(`[data-testid="owner-row"][data-depth="0"][data-agent-id="${id}"]`)
    .getByTestId("explore-row");
  await pick.click();
  await expect(pick).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id}`));

  await page.reload();
  await connectWallet(page);
  await agentsAnswered(page);
  await expect(pick).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
});

// `/loops` redirects to `/`, and each run is a row under its agent in the one list, with the
// `loop-row` / `data-loop-id` handles; no separate `loop-list` is drawn.
test("each run is a row under its agent in the same list, and selecting it opens the run beside it", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  test.skip((await walletRuns(request)) === 0, "this wallet has started no loops on this cluster");
  await page.goto("/loops");
  await expect(page).toHaveURL(/\/$/);
  await connectWallet(page);
  await runsAnswered(page);
  await unfoldEarlierRuns(page);

  const spine = page.getByTestId("owners-spine");
  const rows = page.getByTestId("loop-row");
  // Every run row is in the one list, nested under an agent row that carries its agent's id.
  await expect(spine.getByTestId("loop-row")).toHaveCount(await rows.count());
  const first = rows.first();
  const loopId = await first.getAttribute("data-loop-id");
  const agentId = await first.getAttribute("data-agent-id");
  expect(loopId).toMatch(/^loop-/);
  await expect(spine.locator(`[data-testid="owner-row"][data-depth="0"][data-agent-id="${agentId}"]`)).toHaveCount(1);
  await expect(first).toHaveAttribute("data-depth", "1");
  await expect(page.getByTestId("loop-list")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Loops view" })).toHaveCount(0);

  await first.locator("button[aria-pressed]").click();
  await expect(page).toHaveURL(new RegExp(`[?&]run=${loopId}`));
  await expect(page).toHaveURL(new RegExp(`[?&]item=${agentId}`));
  await expect(page.getByTestId("loop-spine")).toBeVisible();
  await expect(page.getByTestId("loop-spine").getByTestId("run-open")).toHaveAttribute("href", `/loop/${loopId}`);
  await expect(page.locator("table")).toHaveCount(0);
});

test("the selected run survives a reload, and /loops?loop= lands on it", async ({ page, request }) => {
  test.setTimeout(240_000);
  test.skip((await walletRuns(request)) === 0, "this wallet has started no loops on this cluster");
  await page.goto("/");
  await connectWallet(page);
  await runsAnswered(page);

  // Any run differs from the default: an empty selection opens the first agent, never a run.
  const id = await page.getByTestId("loop-row").first().getAttribute("data-loop-id");
  expect(id).toMatch(/^loop-/);
  const row = page.locator(`[data-testid="loop-row"][data-loop-id="${id}"]`);
  const pick = row.locator("button[aria-pressed]");
  await pick.click();
  await expect(pick).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(new RegExp(`[?&]run=${id}`));

  await page.reload();
  await connectWallet(page);
  await runsAnswered(page);
  await expect(pick).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  // The `/loops?loop=` deep link: the server sends `/?run=L`, and the workspace finds L's agent.
  await page.goto(`/loops?loop=${id}`);
  await expect(page).toHaveURL(new RegExp(`/\\?run=${id}`));
  await connectWallet(page);
  await runsAnswered(page);
  await expect(pick).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(page.getByTestId("loop-spine")).toBeVisible();
});

test("a run's row says what its record says: the status word and the step count", async ({ page, request }) => {
  test.setTimeout(240_000);
  test.skip((await walletRuns(request)) === 0, "this wallet has started no loops on this cluster");
  await page.goto("/");
  await connectWallet(page);
  await runsAnswered(page);

  const spine = page.getByTestId("owners-spine");
  const rows = spine.getByTestId("loop-row");
  const loopId = await rows.first().getAttribute("data-loop-id");
  expect(loopId, "a run row carries the id the row-resolving specs look it up by").toMatch(/^loop-/);
  const tile = spine.locator(`[data-testid="loop-row"][data-loop-id="${loopId}"]`);
  await expect(tile).toHaveCount(1);

  /**
   * The record and the row are read together on every poll rather than once each: a running loop
   * takes a step while the case runs, and a step count read a second before the render it is
   * compared with is a race, not a claim. A stopped run settles on the first iteration.
   */
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/loops?id=${encodeURIComponent(loopId!)}`);
        expect(res.status()).toBe(200);
        const loop = (await res.json()).loop as {
          status: "running" | "paused" | "stopped";
          stopReason: string | null;
          steps: number;
          maxSteps: number;
        };
        const text = await tile.innerText();
        // The row's badge is `LoopStatusBadge`: a gated run between steps waits for the decision
        // model, and a stopped run is worded by its reason (*finished*, *completed*, *budget
        // spent*, *not anchored*, a Tempo key's stop) rather than by the record's bare word.
        const expected =
          loop.status === "running"
            ? /\b(running|waiting for the decision model)\b/
            : loop.status === "paused"
            ? /\bpaused\b/
            : /\b(stopped|finished|not anchored|completed|budget spent|Tempo limit reached|Tempo key (expired|missing|refused))\b/;
        // The sub-line is `step n/N · X of Y USDC`.
        const foot = new RegExp(`step\\s+${loop.steps}${loop.maxSteps ? `/${loop.maxSteps}` : ""}\\b`);
        return expected.test(text) && foot.test(text);
      },
      { timeout: 90_000, intervals: [3_000] }
    )
    .toBe(true);
});

test("the agent panel's Agent details lands on that agent's page", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await connectWallet(page);
  await agentsAnswered(page);

  const rows = page.getByTestId("owners-spine").locator('[data-testid="owner-row"][data-depth="0"]');
  test.skip((await rows.count()) === 0, "this wallet owns no agents on this cluster");

  const id = await rows.first().getAttribute("data-agent-id");
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  // Selecting a row never leaves the tab (`Split.tsx`); the panel's link, *Agent details*, is the
  // way to the page.
  await rows.first().getByTestId("explore-row").click();
  const detail = page.getByTestId("owner-spine");
  await detail.getByTestId("agent-open").click();
  await expect(page).toHaveURL(new RegExp(`/agent/${id}$`), { timeout: 60_000 });
});
