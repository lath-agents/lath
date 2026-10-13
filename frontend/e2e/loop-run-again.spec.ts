import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createHash } from "crypto";
import { deployBlankAgent, startLoopFromAgentPage, stepRows } from "./loop-flow";
import { openLoopTerms } from "./disclose";

/**
 * *Run again* and *Archive* on a loop, driven through the console with the E2E wallet.
 *
 * A run is produced once and never revived, so the thing to check is
 * that *Run again* is a **start**: the wizard deploys an agent, its page starts a loop, the loop is stopped
 * after its first step, and the button on `/loop/<id>` produces a second run with a new id, its
 * own history and a later `startedAt`, while the run it came from stays exactly as it ended.
 * What links the two is the template — `template.id` and `template.hash` are identical, which is
 * the console's lineage key and not a chain fact. Both runs' pages then carry the same
 * *from ‹template› v1* line.
 *
 * The second claim is the wallet ceiling: `LOOPS_PER_WALLET` counts *running* loops, so the
 * start above was accepted while the wallet still held the stopped one. What is asserted is the
 * `POST /api/loops` response the browser got (200, not 429) and the registry's own counts;
 * exhausting the ceiling would need `LOOPS_PER_WALLET + 1` runs, which is a run per step-minute
 * on devnet, so it is not attempted here.
 *
 * The third is archive: the loop page's *Archive* stops the run and takes it out of the list
 * while the record keeps answering — `GET /api/loops` omits it, `?archived=1` carries it, and
 * `?id=` still resolves with `archivedAt` set, so audit links into the run keep working. It
 * lives in this file because it needs a loop that is already here.
 *
 * The steps use the shortest interval and the fewest steps the loop form offers (1 min, 3), and
 * the run is stopped after the first wake rather than left to reach its ceiling: two loop starts
 * on devnet are minutes of wall clock either way.
 *
 * `GET /api/loops` is open, so the API reads here need no signature; the writes are the buttons.
 * The one text compared — the standing instruction — comes with every read: the console answers
 * every reader in full.
 */

/** Fresh names per run; `E2E_RUN=<suffix>` re-targets what an earlier run deployed. */
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const AGENT = `e2e-again-${RUN}`;
const id = (name: string) => createHash("sha256").update(name).digest("hex");

/** What case 1 established, for the two cases that read it. `mode: "serial"` makes this safe. */
const state: {
  first?: string;
  second?: string;
  /** The first run's status when *Run again* was posted, from `?id=`. */
  firstStatusAtStart?: string;
  /** The status code the browser's *Run again* `POST /api/loops` came back with. */
  runAgainStatus?: number;
} = {};

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, request }) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/**
 * `autoConnect` only reconnects a wallet the browser has already chosen, so the first connection
 * in a fresh context goes through the real modal — the path a person takes anyway.
 */
async function connectWallet(page: Page) {
  // The header's wallet button is a `dynamic(..., { ssr: false })` import (`components/Nav.tsx`),
  // so until that chunk arrives the header holds an `aria-hidden` placeholder and no button at
  // all. `count()` does not auto-wait, so branching on it against an un-hydrated header read 0,
  // skipped the connect, and let the `toHaveCount(0)` below pass vacuously; the deploy then sat
  // on a *Deploy agent* that stays disabled while `publicKey` is null until the case timed out.
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

/** One loop as `GET /api/loops?id=` has it. */
async function loopById(request: APIRequestContext, id: string) {
  // Once more on a reset: after the page has kept the test busy for a minute, the request
  // context's pooled socket may be one the server already closed, and the GET dies before it
  // reaches the console (ECONNRESET, nothing in its log).
  const get = () => request.get(`/api/loops?id=${encodeURIComponent(id)}`);
  const res = await get().catch((e: Error) =>
    /ECONNRESET|socket hang up/.test(e.message) ? get() : Promise.reject(e)
  );
  expect(res.status(), `GET /api/loops?id=${id}`).toBe(200);
  return (await res.json()).loop;
}

/** The list `GET /api/loops` answers with, archived runs in or out. */
async function loopList(request: APIRequestContext, archived = false) {
  const res = await request.get(archived ? "/api/loops?archived=1" : "/api/loops");
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body as {
    loops: { id: string; owner: string; status: string; archivedAt: number | null }[];
    limits: { loopsPerWallet: number };
  };
}

test("Run again starts a second run from the stopped run's template", async ({ page, request }) => {
  test.setTimeout(9 * 60_000);

  // 1. Deploy an agent with the wizard, then start its loop from the loop form the agent's
  //    *Run as agent loop* card links to: a deploy schedules nothing, and that form is where a
  //    loop begins.
  await deployBlankAgent(page, AGENT, connectWallet);
  const first = await startLoopFromAgentPage(page, id(AGENT), {
    prompt: "Read the cluster and replay your own chain.",
    interval: "1 min",
    steps: "3",
  });
  state.first = first;

  // 2. The first step lands at once and its leaf rebuilds in the browser. Pause before the
  //    second is due, then stop — the reason to pause first is that a paused loop schedules
  //    nothing while the stop is signed.
  const rows = stepRows(page);
  await expect(rows).toHaveCount(1, { timeout: 3 * 60_000 });
  // The Steps badge reads "verified on chain" once every leaf re-derives; the count it stands for
  // is its title.
  await expect(page.getByTitle("1/1 checkpoint leaves re-derived in this browser from the chain")).toHaveText(
    "verified on chain",
    { timeout: 60_000 }
  );
  await page.getByTestId("loop-pause").click();
  await expect(page.getByTestId("loop-resume")).toBeVisible();
  await page.getByTestId("loop-stop").click();
  // A stopped run offers no Stop at all.
  await expect(page.getByTestId("loop-stop")).toHaveCount(0);
  await expect(page.getByText(/^stopped/)).toBeVisible();

  const stopped = await loopById(request, first);
  expect(stopped.status).toBe("stopped");
  expect(stopped.template, "the run carries the template it was started from").not.toBeNull();
  // The step that was in flight when Stop landed finishes and writes its checkpoint, so wait
  // for the registry to be quiet before starting a second run on the same agent: the server
  // serialises chain writes, and one running loop per agent is the rule the start enforces.
  await expect
    .poll(async () => (await loopById(request, first)).stepping, { timeout: 3 * 60_000, intervals: [3_000] })
    .toBe(false);
  state.firstStatusAtStart = (await loopById(request, first)).status;

  // 3. *Run again*. Same template version, so this is the same config, not a resume: the
  //    button posts `{ action: "start", templateId, version }` and lands on the new run's page.
  //    A start is refused (409, "still settling its Tempo channel … try again in a minute") while
  //    the stopped run's channel settles, so the click is repeated until the
  //    settle is done, as a person would; the last start's status is the one recorded.
  const onPost = (r: import("@playwright/test").Response) => {
    if (r.url().includes("/api/loops") && r.request().method() === "POST") state.runAgainStatus = r.status();
  };
  page.on("response", onPost);
  await expect(async () => {
    if (page.url().endsWith(`/loop/${first}`)) await page.getByTestId("loop-run-again").click();
    await expect(page).not.toHaveURL(new RegExp(`/loop/${first}$`), { timeout: 20_000 });
  }).toPass({ timeout: 4 * 60_000, intervals: [10_000] });
  page.off("response", onPost);
  await expect(page).toHaveURL(/\/loop\/loop-/);
  const second = page.url().split("/loop/")[1];
  state.second = second;
  expect(second, "a run is never revived: Run again mints a new loop id").not.toBe(first);

  // 4. What the two runs share and what they do not, from the registry, the instruction itself
  //    included: every reader gets it.
  const before = await loopById(request, first);
  const after = await loopById(request, second);
  expect(after.prompt).toBe("Read the cluster and replay your own chain.");
  expect(after.template.id).toBe(before.template.id);
  expect(after.template.hash).toBe(before.template.hash);
  expect(after.template.version).toBe(before.template.version);
  expect(after.agentId).toBe(before.agentId);
  expect(after.prompt).toBe(before.prompt);
  expect(after.promptHash).toBe(before.promptHash);
  expect(after.intervalMs).toBe(before.intervalMs);
  expect(after.maxSteps).toBe(before.maxSteps);
  // `createdAt` is the run's start: it is `startedAt` in every one of its step manifests
  // (`api/_lib/loop-channel.ts` hands it to the runner), which is what makes two runs from one template
  // distinguishable on chain.
  expect(after.createdAt).toBeGreaterThan(before.createdAt);
  expect(after.status).toBe("running");
  expect(after.history).toHaveLength(0);
  expect(after.archivedAt).toBeNull();

  // 5. The run it came from is untouched: same status, same stop reason, same steps.
  const firstNow = await loopById(request, first);
  expect(firstNow.status).toBe("stopped");
  expect(firstNow.stopReason).toBe(before.stopReason);
  expect(firstNow.steps).toBe(before.steps);
  expect(firstNow.createdAt).toBe(before.createdAt);
  expect(firstNow.archivedAt).toBeNull();

  // 6. The workspace carries both runs under their one agent (`/loops` redirects to `/`): the new
  //    run is the agent's current one and the stopped one folds
  //    behind _1 earlier run_. `/loops?loop=<first>` lands on `/?run=<first>`, and a selected earlier
  //    run unfolds its agent's fold, which is the way to reach it without guessing which fold is whose.
  await page.goto(`/loops?loop=${first}`);
  await expect(page).toHaveURL(new RegExp(`/\\?run=${first}`));
  await connectWallet(page);
  const list = page.getByTestId("owners-spine");
  await expect(list).toBeVisible({ timeout: 60_000 });
  const rowFor = (id: string) => list.locator(`[data-testid="loop-row"][data-loop-id="${id}"]`);
  await expect(rowFor(second)).toHaveCount(1, { timeout: 60_000 });
  await expect(rowFor(first)).toHaveCount(1);
  await expect(rowFor(first).locator("button[aria-pressed]")).toHaveAttribute("aria-pressed", "true");
  await expect(rowFor(first)).toHaveAttribute("data-agent-id", id(AGENT));
  await expect(rowFor(second)).toHaveAttribute("data-agent-id", id(AGENT));
  // The workspace's rows carry no template line; each run's lineage is in its page's _Terms_ ⓘ, so
  // the two pages are compared there.
  const lineageOf = async (loopId: string) => {
    await page.goto(`/loop/${loopId}`);
    await connectWallet(page);
    return (await openLoopTerms(page)).getByTestId("loop-template").innerText();
  };
  const lineage = await lineageOf(first);
  expect(lineage).toMatch(/^from\s/);
  expect(await lineageOf(second)).toBe(lineage);
});

test("the wallet ceiling counts running loops, so a stopped run does not block a start", async ({ request }) => {
  test.setTimeout(60_000);
  test.skip(
    !state.second || state.firstStatusAtStart !== "stopped",
    "the first run did not reach a stopped state before Run again, so this claim was not exercised"
  );

  // The browser's own start, not a re-post: 429 is what `LOOPS_PER_WALLET` refuses with, and
  // the wallet held a stopped run of this agent at the time.
  expect(state.runAgainStatus).toBe(200);

  const { loops, limits } = await loopList(request);
  const owner = (await loopById(request, state.second!)).owner;
  const mine = loops.filter((l) => l.owner === owner);
  const running = mine.filter((l) => l.status === "running");
  expect(running.length).toBeLessThanOrEqual(limits.loopsPerWallet);
  // The stopped run is still listed and still owned by this wallet; what it no longer does is
  // count against the ceiling.
  expect(mine.length).toBeGreaterThan(running.length);
  expect(mine.map((l) => l.id)).toContain(state.first!);
});

test("Archive takes a run out of the list and leaves its record answering", async ({ page, request }) => {
  test.setTimeout(4 * 60_000);
  test.skip(!state.second, "no second run to archive");
  const second = state.second!;

  await page.goto(`/loop/${second}`);
  await connectWallet(page);
  await expect(page.getByTestId("loop-archive")).toBeEnabled({ timeout: 60_000 });
  // Archive asks first, because it stops a run that may be mid-schedule; Playwright dismisses a
  // dialog nobody handles, which would read as a cancelled archive.
  page.once("dialog", (d) => {
    expect(d.message()).toMatch(/Archive this run\?/);
    return d.accept();
  });
  await page.getByTestId("loop-archive").click();
  // Archive stops a running run first. The button an archived run offers is *Unarchive*, not a
  // disabled *Archived*: archive is not deletion and there is a verb that says so.
  await expect(page.getByTestId("loop-unarchive")).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId("loop-archive")).toHaveCount(0);

  const archived = await loopById(request, second);
  expect(archived.archivedAt, "the archive is stamped on the record").toBeGreaterThan(0);
  expect(archived.status).toBe("stopped");
  // Nothing is deleted: the lineage and the steps this run wrote are still on the record, which
  // is what every audit link into it needs.
  expect(archived.template.id).toBe((await loopById(request, state.first!)).template.id);

  const listed = await loopList(request);
  expect(listed.loops.map((l) => l.id)).not.toContain(second);
  const withArchived = await loopList(request, true);
  expect(withArchived.loops.map((l) => l.id)).toContain(second);
  expect(withArchived.loops.find((l) => l.id === second)!.archivedAt).toBe(archived.archivedAt);

  // The run it was started from is untouched by the archive, and the list still carries it.
  const firstNow = await loopById(request, state.first!);
  expect(firstNow.archivedAt).toBeNull();
  expect(listed.loops.map((l) => l.id)).toContain(state.first!);

  // The workspace agrees with the list the API answered with (`/loops` redirects to it): the
  // archived run has no row, and the run it came from is back to being its agent's current run, so
  // it is not folded.
  await page.goto("/loops");
  await connectWallet(page);
  await expect(page.getByTestId("owners-spine")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-testid="loop-row"][data-loop-id="${state.first!}"]`)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(`[data-testid="loop-row"][data-loop-id="${second}"]`)).toHaveCount(0);
});
