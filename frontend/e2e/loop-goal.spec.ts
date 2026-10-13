import { expect, test, type Page } from "@playwright/test";
import { createHash } from "crypto";
import { closeInfo, openInfo, openLoopTerms, openProof } from "./disclose";
import { fillLoopGoal, openLoopForm, openStartedLoop } from "./loop-flow";
import { resignStart } from "./wallet";

/**
 * A loop that is given a goal, reaches it, and stops itself saying so.
 *
 * Two cases, and the claim of the pair is: a goal loop stops on the chain's word rather than the
 * clock, and a loop without a goal is a plain clock-driven loop.
 *
 * **Case 1 costs real money** — each step is a paid chat call on the treasury's channel — so it
 * is skipped without `LATH_TEMPO_TREASURY`, the way `loop-verify.spec.ts` gates its billed case.
 * The gate is not only about the bill: without a treasury the console runs every session on the
 * scripted transport, whose answer is a fixture that will never end
 * with the terminal line, so the case would sit through three steps and assert nothing about a
 * goal. It costs one step where a plain loop costs three, which is the feature.
 *
 * **Case 2 spends three steps** and asserts the absence: no goal at the top, no Plan panel, the
 * run ends on `max-steps` and the page reads *Finished:*.
 *
 * The loop page folds its detail: the goal's hash is the goal well's `Info`, the terms are the
 * title's *Terms* `Info`, and the steps' memory column is behind the page's one `Proof` — each
 * opened here before it is read. Case 2 deploys its own agent rather than reading an old loop,
 * because a run with no goal has to be one this suite started to say what it does and does not
 * carry.
 *
 * Neither case asserts anything about *what the model said*. The goal is written so that one
 * step is enough ("answer with the word ready and declare the goal reached"), and what is
 * checked is the mechanism around it: status 201 on the row, `stopReason: "goal-reached"` on the
 * wire, the parsed plan on screen, and one settlement on the channel.
 *
 * `goalHash`, `parseGoalPlan` and the manifest key order are the SDK's, and `tests/loop-goal.ts`
 * owns them; the default standing instruction and the absent-when-empty rule are the server's,
 * and `tests/console-loops.ts` owns those. What is only checkable in a browser is here.
 *
 * Devnet, and slow: run it with `--timeout=240000 --workers=1`.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Fresh names per run; `E2E_RUN=<suffix>` re-targets what an earlier run deployed. */
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const GOAL_AGENT = `e2e-goal-${RUN}`;
const PLAIN_AGENT = `e2e-nogoal-${RUN}`;

/**
 * One step is enough to reach it, which is the point: the run is meant to stop at 1 of 3, so the
 * assertion below distinguishes a loop that got there from one that merely ran out of steps.
 * `goalHash` is the sha256 of the *trimmed* bytes, and this string has no
 * edge whitespace, so the hash on screen is the hash of exactly this.
 */
const GOAL = "Answer with the word ready and declare the goal reached";

/**
 * Words no loop screen may say: the labour market's, and the three claims this project does not
 * make about a model's output.
 *
 * Built from halves rather than written out, because the repo is swept for these words and a
 * spec that spells them is a hit every sweep has to be told to ignore.
 */
const RETIRED = new RegExp(
  `\\b(${[
    "hi" + "re",
    "hi" + "red",
    "wor" + "ker",
    "provi" + "der",
    "determin" + "istic",
    "guaran" + "tee",
    "pro" + "ven",
  ].join("|")})\\b`,
  "i"
);

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, request }) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

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

/** Deploys a blank agent through the wizard — the one path that grants the allowance, so the steps are billable. */
async function deploy(page: Page, name: string) {
  await page.goto("/create?kind=agent");
  await connectWallet(page);
  // The wizard is on screen from the start: an agent is created from blank, with no _Start from_.
  await page.getByPlaceholder("e.g. agent-sentinel-v2").fill(name);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: 240_000 });
}

/**
 * The shortest interval the server accepts is 15 s and the form's smallest chip is a minute, so
 * the body is patched on its way out and signed again with the wallet's own key (`resignStart`):
 * a start's signature hashes its body, so a patched body is a new body to sign, and the spec
 * holds the key that signs it. 15 000 ms is exactly
 * `MIN_INTERVAL_MS`, so the server accepts it and no step waits a minute for the next.
 */
async function patchInterval(page: Page) {
  await page.route("**/api/loops", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}");
    // The start only: any other action this route takes has a body that is not a loop's terms.
    if (body.action !== "start") return route.fallback();
    await route.continue({
      postData: JSON.stringify(resignStart({ ...body, intervalMs: 15_000 }, route.request().url())),
    });
  });
}

/*
 * The filter for the first listed loop whose agent has no loop running is in
 * `loop-verify.spec.ts`, and deliberately not here: both cases
 * below deploy their own agent through the wizard, because only that path grants the allowance
 * that makes their steps billable, so neither ever picks a loop out of the registry. A case
 * added to this file that does pick one must copy the filter with it.
 */

test("a goal loop stops at the step that reaches it, and the chain says so", async ({ page, request }) => {
  test.skip(
    !process.env.LATH_TEMPO_TREASURY,
    "no LATH_TEMPO_TREASURY: this case opens a channel and spends USDC.e, and the scripted transport never says GOAL REACHED"
  );
  test.setTimeout(15 * 60_000);

  await deploy(page, GOAL_AGENT);

  // The loop form on this agent (`/create?loop=1&agent=<id>`, where the agent page links). It has one
  // Goal field, sent as the instruction and, with _Jev checks the goal_ on (the default), as the goal
  // too (`lib/loop-goal-field.ts`): what the chain commits as `promptHash` and as `goalHash` is the one
  // text typed here. The default instruction is the server's for an API client that sends a goal
  // alone; the form does not fill it.
  const form = await openLoopForm(page, id(GOAL_AGENT));
  await expect(page.getByTestId("loop-goal-input")).toHaveValue("");
  await fillLoopGoal(page, GOAL);
  await form.getByRole("button", { name: "1 min", exact: true }).click();
  await form.getByRole("button", { name: "3", exact: true }).click();
  await patchInterval(page);
  await page.getByTestId("loop-start").click();
  const loopId = await openStartedLoop(page);

  // The goal at the top, and its hash beside it, the hash of exactly the bytes typed. The text is
  // public, and every console read answers in full to every reader, so it shows with nothing to open
  // first.
  await expect(page.getByTestId("loop-goal")).toContainText(GOAL, { timeout: 60_000 });
  // The hash is the goal well's `Info`, portalled to the body while open.
  await openInfo(page.getByTestId("loop-goal").getByRole("button", { name: "How the goal is committed" }));
  await expect(page.getByTestId("loop-goal-hash")).toContainText(sha256(GOAL).slice(0, 8));
  await closeInfo(page);
  // One text as both: the instruction's well is left out rather than printing the same words twice.
  await expect(page.getByTestId("loop-prompt")).toHaveCount(0);

  // One step, not three. The wait is generous because the first step on devnet is a deploy's
  // worth of confirmations behind it, and the claim is what the *page* says the run did: a
  // finish, not a stop, and the count it reached out of the count it was allowed.
  const rows = page.getByTestId("loop-steps").locator(".step-row");
  await expect(rows).toHaveCount(1, { timeout: 8 * 60_000 });
  // The finish note says _Goal reached at step n_ on one line; the count out of the allowance is
  // the note's title.
  const reached = page.getByTestId("loop-goal-reached");
  await expect(reached).toContainText(/Goal reached at step 1\b/, { timeout: 6 * 60_000 });
  await expect(reached.locator("xpath=..")).toHaveAttribute("title", /Run: 1 of 3 steps/);

  // The row itself: status 201 reads *completed* — the word the spine and the status badge use
  // for it — and not *failed* (the whole of the 201 decision, on screen), and the memory the plan
  // was written into re-hashes from the store. Beside a goal chip the row drops the status chip,
  // and _goal: achieved_ says it instead.
  await expect(rows.nth(0)).toContainText(/goal: achieved|completed/i);
  await expect(rows.nth(0)).not.toContainText(/\bfailed\b/i);

  // The console writes every blob in the clear, the memory included, so the memory re-hashes to
  // *memory verified* from the store with nothing to open first. The memory column is a proof
  // column, shown once the page's Proof is open.
  await openProof(page, "loop-proof");
  await expect(page.getByTestId("step-memory").nth(0)).toBeVisible();
  await expect(page.getByTestId("step-memory").nth(0)).toContainText(/memory verified/i);

  // The plan is the memory, and the memory cell above is where it is read: a separate Plan panel
  // would repeat those bytes parsed into three lists, the same thing said twice, so the loop page
  // draws none. The agent page's loop card has it.
  await expect(page.getByTestId("loop-goal-plan")).toHaveCount(0);

  // And off the page: the stop reason as the registry has it, which is what a reader of
  // `GET /api/loops` sees without opening a browser at all.
  const one = await (await request.get(`/api/loops?id=${encodeURIComponent(loopId)}`)).json();
  expect(one.loop.stopReason).toBe("goal-reached");
  expect(one.loop.status).toBe("stopped");
  expect(one.loop.goalHash).toBe(sha256(GOAL));
  // And the texts with it, to a reader who signed nothing: the one Goal field sent the same words as
  // goal and instruction.
  expect(one.loop.goal).toBe(GOAL);
  expect(one.loop.prompt).toBe(GOAL);
  const owned = await (await request.get(`/api/loops?owner=${encodeURIComponent(one.loop.owner)}`)).json();
  const listed = (owned.loops ?? []).find((l: { id: string }) => l.id === loopId);
  expect(listed, "the owner's list carries the run").toBeTruthy();
  expect(listed.stopReason).toBe("goal-reached");

  // The channel settles on a goal-reached stop exactly as it does on `max-steps`: one settlement
  // row, not a channel left open because the run ended by an unfamiliar door. The loop page has no
  // Tempo channel card (the home page states the treasury once), so the settlement is read from the
  // run's own row.
  await expect
    .poll(
      async () => (await (await request.get(`/api/loops?id=${encodeURIComponent(loopId)}`)).json()).loop?.tempo?.txHash,
      { timeout: 4 * 60_000, intervals: [5_000] }
    )
    .toBeTruthy();
  await expect(page.locator("body")).not.toHaveText(RETIRED);
});

test("a loop with no goal runs its three steps and finishes as it always did", async ({ page, request }) => {
  test.setTimeout(15 * 60_000);

  await deploy(page, PLAIN_AGENT);

  // The same form, the goal check off: the one Goal field goes out as the instruction alone, and an
  // absent goal is *absent* on the wire, so this run's manifests carry no tenth key and hash
  // exactly as older manifests written without the goal key do.
  const form = await openLoopForm(page, id(PLAIN_AGENT));
  await expect(page.getByTestId("loop-goal-input")).toHaveValue("");
  await fillLoopGoal(page, "Read the cluster and replay your own chain, then say what changed.", { goalCheck: false });
  await form.getByRole("button", { name: "1 min", exact: true }).click();
  await form.getByRole("button", { name: "3", exact: true }).click();
  await patchInterval(page);
  await page.getByTestId("loop-start").click();
  const loopId = await openStartedLoop(page);

  // Nothing about goals is on this page: not the goal block, not its hash, not the Plan panel. The
  // terms are the title's _Terms_ `Info`, and with no goal they carry no _Goal checked by_ row.
  await expect(await openLoopTerms(page, 60_000)).toBeVisible();
  await expect(page.getByTestId("loop-goal-check-terms")).toHaveCount(0);
  await closeInfo(page);
  await expect(page.getByTestId("loop-goal")).toHaveCount(0);
  await expect(page.getByTestId("loop-goal-hash")).toHaveCount(0);
  await expect(page.getByTestId("loop-goal-plan")).toHaveCount(0);

  // Three steps and the ceiling, which is the only way this run can end.
  const rows = page.getByTestId("loop-steps").locator(".step-row");
  await expect(rows).toHaveCount(3, { timeout: 12 * 60_000 });
  await expect(page.getByText(/Finished:/)).toBeVisible({ timeout: 4 * 60_000 });
  await expect(page.getByText(/goal reached/i)).toHaveCount(0);

  const one = await (await request.get(`/api/loops?id=${encodeURIComponent(loopId)}`)).json();
  expect(one.loop.stopReason).toBe("max-steps");
  // `goalHash` is the test: `goal` is absent on a read with no token whether or not one was typed.
  expect(one.loop.goal, "the goal check was off, so no goal was recorded").toBeFalsy();
  expect(one.loop.goalHash).toBeFalsy();
  await expect(page.locator("body")).not.toHaveText(RETIRED);
});
