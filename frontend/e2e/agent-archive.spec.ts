import { expect, test, type Page } from "@playwright/test";
import { createHash } from "crypto";
import { agentAction, openAgentMenu } from "./disclose";
import { deployBlankAgent, startLoopFromAgentPage, stepRows } from "./loop-flow";

/**
 * Archiving a deployed agent that has a loop running on it, driven through the console with the
 * E2E wallet.
 *
 * Archive is the only thing *delete* can honestly mean here: the chain is append-only, so the
 * header, the published name and the allowance stay where they are and every trace the agent
 * wrote keeps resolving. What changes is off-chain — the run stops, the workspace's Yours list (`/`,
 * which `/agents` redirects to) drops the row, and a new session is refused. This file checks both
 * halves of that, and the second half is the one worth the wall clock: after the archive the loop's memory blob still comes back from
 * `/api/traces` and re-hashes to the id its step manifest committed, and the agent page still
 * replays the chain to its head.
 *
 * Needs the seed run with `--e2e-wallet` and a server with a runtime keypair. It deploys a fresh
 * agent per run, so `E2E_RUN` cannot be reused to re-target an earlier run's agent — the earlier one is archived, and a
 * second deploy of the same name is refused.
 *
 * The loop uses the shortest interval the loop form offers (one minute) and the archive lands
 * between the first and second step, so the first case takes a few minutes of wall clock.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
/** Fresh names per run; each run deploys and archives its own agent. */
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const AGENT = `e2e-arch-${RUN}`;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, request }) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/** `autoConnect` only reconnects a wallet the browser already chose, so the first one goes
 * through the real modal — the path a person takes anyway. */
async function connectWallet(page: Page) {
  // The header's wallet button is a `dynamic(..., { ssr: false })` import (`components/Nav.tsx`),
  // so until that chunk arrives the header holds an `aria-hidden` placeholder and no button at
  // all. `count()` does not auto-wait, so branching on it against an un-hydrated header reads 0,
  // skips the connect, and lets the `toHaveCount(0)` below pass vacuously; the deploy then sits
  // on a *Deploy agent* that stays disabled while `publicKey` is null until the case times out.
  // `.wallet-adapter-button-trigger` is the one element the header renders in both
  // states — *Select Wallet* and the truncated key — so waiting for it is what makes the branch
  // below a real either/or rather than a race the un-hydrated side always wins.
  await expect(page.locator(".wallet-adapter-button-trigger").first()).toBeVisible({ timeout: 60_000 });
  const select = page.getByRole("button", { name: /select wallet/i });
  if (await select.count()) {
    await select.first().click();
    await page.getByRole("button", { name: /E2E Keypair/i }).click();
  }
  await expect(page.getByRole("button", { name: /select wallet/i })).toHaveCount(0);
}

test("archiving an agent stops its loop and hides it while its traces still serve", async ({ page, request }) => {
  test.setTimeout(9 * 60_000);

  // 1. Deploy with the wizard, then start the loop, one minute apart, from the agent's own page —
  // a deploy never schedules anything, so these are two wallet prompts.
  await deployBlankAgent(page, AGENT, connectWallet);
  const loopId = await startLoopFromAgentPage(page, id(AGENT), {
    prompt: "Read the cluster and report its fee level.",
    interval: "1 min",
    steps: "3",
  });

  // 2. One wake, so the loop has a chain and a trace blob to keep serving after the archive.
  // The badge is `verifyStep` in the browser: the leaf the chain carries and the loop's own
  // terms agree. Three steps were asked for, so the loop is still running when we archive it.
  const rows = stepRows(page);
  await expect(rows).toHaveCount(1, { timeout: 4 * 60_000 });
  // The Steps badge reads "verified on chain" once every leaf re-derives; the count it stands for
  // is its title.
  await expect(page.getByTitle("1/1 checkpoint leaves re-derived in this browser from the chain")).toHaveText(
    "verified on chain",
    { timeout: 60_000 }
  );

  // The memory the step committed, read from the record the browser reads. It is
  // `sha256(memory)` and the trace store is keyed by it, so re-fetching it is a real check.
  const before = await (await request.get(`/api/loops?id=${loopId}`)).json();
  expect(before.loop.status).toBe("running");
  const blob = (before.loop.history as { memoryHash?: string }[]).map((h) => h.memoryHash).find(Boolean) as string;
  expect(blob).toMatch(/^[0-9a-f]{64}$/);

  // 3. The row is on the workspace's Yours list before the archive, so its absence afterwards means
  // the archive hid it and not that the list failed to load. `/agents` redirects to `/`, so this
  // also checks the redirect. The agent row is depth 0; with no team, nothing else
  // carries its id as an `owner-row`, but the depth says which row is meant.
  const row = page.locator(`[data-testid="owner-row"][data-depth="0"][data-agent-id="${id(AGENT)}"]`);
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/$/);
  await connectWallet(page);
  await expect(page.getByTestId("owners-spine")).toBeVisible({ timeout: 120_000 });
  await expect(row).toBeVisible({ timeout: 120_000 });

  // 4. Archive, from the owner's ⋯ menu on the agent page's header. It signs `"Lath agent"` — a record change, not a transaction — and the note it
  // renders under the header is the server's.
  await page.goto(`/agent/${id(AGENT)}`);
  await connectWallet(page);
  // Archive asks first, and names the loop it is about to stop. Playwright dismisses a dialog
  // nobody handles, which would read here as a cancelled archive.
  page.once("dialog", (d) => {
    expect(d.message()).toMatch(/Archive .*\?/);
    return d.accept();
  });
  await agentAction(page, "agent-archive");
  await expect(page.getByTestId("agent-actions-status").getByText(/Archived off-chain/)).toBeVisible({
    timeout: 60_000,
  });

  // 5. The loop stopped, and says why. `?id=` still resolves it: archiving an agent stops its
  // runs, it does not archive the runs, and the step history has to stay readable either way.
  const after = await (await request.get(`/api/loops?id=${loopId}`)).json();
  expect(after.loop.status).toBe("stopped");
  expect(after.loop.stopReason).toMatch(/archived/);
  expect(after.loop.history.length).toBeGreaterThanOrEqual(1);

  // 6. The registry drops it from `agents` and names it under `archived`.
  const registry = await (await request.get("/api/agents")).json();
  expect((registry.agents as { id: string }[]).map((a) => a.id)).not.toContain(id(AGENT));
  expect(registry.archived).toContain(id(AGENT));

  // 7. The workspace's Yours list now leaves it out (archived agents stay out of it). The poll is what makes the absence mean something: a list still
  // loading has no rows either.
  await page.goto("/");
  await connectWallet(page);
  await expect
    .poll(
      async () =>
        (await page.locator('[data-testid="owner-row"]').count()) > 0 ||
        (await page.getByText(/This wallet has no agents yet/).count()) > 0,
      { timeout: 120_000 }
    )
    .toBe(true);
  await expect(row).toHaveCount(0);

  // 8. The agent page still resolves — `lookupAgent` keeps answering for an archived id — and
  // says what it is. The chain badge is the browser replaying the hash chain to the header's
  // head, which is the honest form of "the audit still verifies".
  await page.goto(`/agent/${id(AGENT)}`);
  await connectWallet(page);
  await expect(page.getByTestId("owner-name")).toHaveText(AGENT, { timeout: 60_000 });
  // The header's badge, by the explanation it carries — "archived" alone is also the word the
  // lineage line and the stopped loop's card use.
  await expect(page.getByTitle(/Hidden from the console's lists/)).toBeVisible();
  await expect(page.getByTestId("agent-lineage")).toContainText("archived");
  // Archive is not deletion, and a verb says so: the item an archived agent's ⋯ menu offers is
  // *Unarchive*, not a disabled *Archived*. Its items exist only while it is
  // open, so the absence is read with it open.
  await openAgentMenu(page);
  await expect(page.getByTestId("agent-archive")).toHaveCount(0);
  await expect(page.getByTestId("agent-unarchive")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chain-status")).toContainText(/verified on Solana/i, { timeout: 60_000 });

  // 9. The blob the loop's step committed still comes back. Verification of what an archived
  // agent wrote depends on nothing the console lists. The console writes every blob in the clear,
  // so the bytes served re-hash to the id the chain committed, with no key.
  const served = await request.get(`/api/traces/${blob}`);
  expect(served.status()).toBe(200);
  const body = await served.body();
  expect(createHash("sha256").update(body).digest("hex")).toBe(blob);
});

test("a new session on the archived agent is refused with 409", async ({ page, request }) => {
  test.setTimeout(3 * 60_000);

  // Through the send box the page still renders: the wallet signs, the server refuses, and the
  // refusal is what the exchange shows — no chain write, so nothing to undo.
  // `#ask` opens the Ask card, which is folded by default.
  await page.goto(`/agent/${id(AGENT)}#ask`);
  await connectWallet(page);
  await page.getByTestId("chat-input").fill("Anything at all.");
  await page.getByTestId("chat-send").getByRole("button").click();
  await expect(page.getByTestId("chat-reply")).toContainText(/archived/i, { timeout: 60_000 });

  // And at the route, which is where the refusal is decided: before any signature is checked,
  // so an unsigned POST gets the same 409 rather than a 401 that would hide it.
  const refused = await request.post("/api/run", {
    data: { target: { kind: "agent", id: id(AGENT) }, prompt: "Anything at all." },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toMatch(/archived/);
});
