import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as path from "path";
import { closeInfo, openAdvanced, openLoopTerms, openProof } from "./disclose";
import { fillLoopGoal, openLoopForm, openStartedLoop } from "./loop-flow";
import { e2eKeypair, resignStart } from "./wallet";

/**
 * A loop whose every step is judged by a second model, driven through the console.
 *
 * Two cases, and only one of them spends anything.
 *
 * **Case 1 costs real money** — a loop step is a paid chat call on the treasury's channel and
 * each verdict is 42 more base units on the same channel — so it is skipped unless
 * `LATH_TEMPO_TREASURY` is set, the way `tempo-rail.spec.ts` gates its billed cases on the
 * treasury route answering `enabled`. Without a treasury the console runs every session on the
 * scripted transport, the verdict is a fixture, and a case
 * that asserted a 42-unit voucher against it would be asserting about nothing.
 *
 * **Case 2 spends nothing**: it starts no loop at all. It reads the start form and the step
 * table of what is already there. The form has no verify toggle — every step is verified by
 * default — so its claim is that a run which asked for no verdict still reads *off* with no verdict
 * chip on its steps, and that the form says, in one line above Start, that the run it starts will
 * be verified at 0.5.
 *
 * The two questions and the threshold are the SDK's and the server's, and `tests/loop-verify.ts`
 * and `tests/console-loops.ts` own them. What is only checkable in a browser is here: that the
 * verdict reaches the row, that the decision blob opens from the row and re-hashes, and that the
 * hash the row opened is the one `lath-audit verify-step` reads off the chain.
 *
 * The form has no verify toggle, only the `loop-verify-always` line, the run's terms are the loop
 * page's _Terms_ `Info`, and the verify seat is a proof column behind the page's one `Proof`; the
 * run list the second case starts on is the workspace at `/`.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const JUDGED = `e2e-judged-${RUN}`;
/** The server's registry directory, as `runner.ts` resolves it. */
const TRACE_DIR = process.env.LATH_TRACE_DIR || path.join(process.cwd(), ".traces");
/** Repo root from `frontend/`, for `npm run audit`. */
const ROOT = path.resolve(process.cwd(), "..");

/**
 * Words no loop screen may say: the labour market's, and the three claims a probabilistic verdict
 * cannot make.
 *
 * Built from halves rather than written out, because the repo is swept for these words and a
 * spec that spells them is a hit every sweep has to be told to ignore. Reading the assembled
 * source is the only way to know what it forbids, which is the trade this comment pays for.
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

test.beforeEach(async ({ page }) => {
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

/**
 * The first listed loop whose **agent** has no loop running.
 *
 * The loop form (`/create?loop=1&agent=<id>`) renders `loop-start-form` only for an agent that is
 * free: one whose loop is still stepping gets *‹name› already has a loop running* in its place, so
 * a case that picked `loops.loops[0]` blind would wait 60 s for a form that is never going to
 * render and report a UI regression that is not one. The registry lists newest first, so the pick
 * stays "whatever the seed left" — only busy agents, and agents the registry does not list for this
 * wallet (`listedAgents`), are skipped.
 *
 * Kept in this file rather than in a shared helper: `loop-goal.spec.ts` deploys its own agents and
 * never picks a loop out of the registry.
 */
function idleAgentLoop(loops: any[], live: Set<string>): any {
  const busy = new Set(loops.filter((l) => l.status === "running").map((l) => l.agentId));
  return loops.find((l) => !busy.has(l.agentId) && live.has(l.agentId));
}

/**
 * The agents the registry still lists for the E2E wallet. An archived agent's page offers no start
 * form either, and `agent-archive.spec.ts` leaves its loop's agent archived at the head of the
 * list, so a pick has to come from this set as well as skip the busy ones.
 */
async function listedAgents(request: APIRequestContext): Promise<Set<string>> {
  const owner = e2eKeypair().publicKey.toBase58();
  const listed = await (await request.get(`/api/agents?owner=${encodeURIComponent(owner)}`)).json();
  return new Set(((listed.agents ?? []) as { id: string }[]).map((a) => a.id.toLowerCase()));
}

test("a verified loop commits each verdict, opens its decision blob, and audits", async ({ page, request }) => {
  test.skip(
    !process.env.LATH_TEMPO_TREASURY,
    "no LATH_TEMPO_TREASURY: this case opens a channel and spends USDC.e, and the scripted transport would verify nothing"
  );
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  test.setTimeout(10 * 60_000);

  // Deploy the agent the loop runs, through the wizard — the one path that grants the allowance
  // in the same transaction, so the steps below are billable.
  await page.goto("/create?kind=agent");
  await connectWallet(page);
  await page.getByPlaceholder("e.g. agent-sentinel-v2").fill(JUDGED);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: 240_000 });

  // The loop form on this agent, where the agent page's card links. Verify is on with nothing
  // pressed: the form offers no toggle and says so in one line above Start, at the default bar.
  const form = await openLoopForm(page, id(JUDGED));
  await openAdvanced(form);
  await expect(page.getByTestId("loop-verify-toggle")).toHaveCount(0);
  await expect(page.getByTestId("loop-verify-always")).toContainText("minimum confidence of 0.5");
  // A plan-shaped prompt, because the verdict's confidence is the model's reading of how well
  // the output carried the prompt out: a plan like this one drew 0.90–0.91, and a one-line prompt
  // drew 0.30 and 0.67, around the 0.5 bar. It goes in the form's one Goal field with the goal check
  // off: the instruction-only loop this case's verdicts were measured on.
  await fillLoopGoal(
    page,
    "Goal: keep a short note on Solana transaction fees. Plan: 1) state the base fee per signature in lamports; " +
      "2) say whether priority fees are optional; 3) end with one line: FEE_NOTE=<one sentence>.",
    { goalCheck: false }
  );
  await form.getByRole("button", { name: "1 min", exact: true }).click();
  await form.getByRole("button", { name: "3", exact: true }).click();

  // `maxSteps: 2` and a 15 s interval are this case's terms and the chips offer neither — the
  // shortest is a minute and the smallest count is three — so the JSON is patched on its way out
  // and signed again with the wallet's own key (`resignStart`): a start's signature hashes its
  // body, and this spec holds the key that signs it. It is also two
  // paid steps instead of three. 15 000 ms is exactly `MIN_INTERVAL_MS`.
  await page.route("**/api/loops", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}");
    expect(body.verify, "the form sends the threshold and lets the server pin the model").toEqual({
      minConfidence: 0.5,
    });
    await route.continue({
      postData: JSON.stringify(resignStart({ ...body, maxSteps: 2, intervalMs: 15_000 }, route.request().url())),
    });
  });
  await page.getByTestId("loop-start").click();
  await openStartedLoop(page);
  // The terms the run committed, on the agent page's card that is now watching it, and from it to
  // the run's page as a person would.
  await page.goto(`/agent/${id(JUDGED)}`);
  await expect(page.getByTestId("loop-live")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("loop-live-verify")).toContainText("verified by typesafe/jev-1.13");
  await page.getByTestId("loop-live-open").click();
  const loopId = await openStartedLoop(page);

  // Both steps, each with its leaf verified in the browser and its verdict beside it. The chip
  // reads *accepted 0.9x* on a prompt the model can follow — the probe measured `verdict` at
  // 0.90–0.91 across three calls, which is what the regex allows.
  const rows = page.getByTestId("loop-steps").locator(".step-row");
  await expect(rows).toHaveCount(2, { timeout: 6 * 60_000 });
  // Two minutes, not one: a leaf verifies in ~35 s on devnet, two in turn.
  await expect(page.getByTitle("2/2 checkpoint leaves re-derived in this browser from the chain")).toHaveText(
    "2/2 verified on chain",
    { timeout: 120_000 }
  );
  // What the case asserts is the mechanism, not the model's mood: four runs of this prompt drew
  // `accept` at 0.30, 0.56, 0.79 and 0.96 for the same step, so a row is *accepted* or *retried*
  // with its confidence, never *unverified*, and the audit below holds whichever it was against the
  // memory. The verify seat is a proof column, so the page's one Proof is opened first.
  await openProof(page, "loop-proof");
  const verify = page.getByTestId("step-verify");
  // The proof row's label names the check (_Verify_), so its chip is the outcome alone; the card's chip
  // reads _verify: accepted 0.9x_ (`verifyChipLabel`).
  await expect(verify.nth(0)).toContainText(/(accepted|retry|retried) 0\.\d\d/);
  await expect(verify.nth(1)).toContainText(/(accepted|retry|retried) 0\.\d\d/);
  await expect(rows.nth(0).getByTestId("step-verify-chip")).toContainText(/^verify: (accepted|retry|retried) 0\.\d\d/);
  await expect(page.getByText("unverified")).toHaveCount(0);
  await openLoopTerms(page);
  await expect(page.getByTestId("loop-verify-terms")).toContainText("typesafe/jev-1.13");
  await closeInfo(page);

  // The console writes every blob in the clear, the decision blob included, so the row below and
  // the audit after it read the same bytes from the store with no key.

  // The decision itself: the row opens the blob under the manifest's `verifyHash`, the browser
  // re-hashes it before it is decoded (`useTracePart`), and what it shows is the dated build the
  // gateway resolved and the 42 base units the verdict cost on this loop's channel.
  // The verify seat and the memory are proof columns, opened above with the page's Proof.
  await verify.nth(0).getByTestId("step-verify-open").click();
  const decision = page.getByTestId("verify-decision");
  await expect(decision).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("verify-decision-model")).toHaveText(/^typesafe\/jev-1\.13-\d{8}$/);
  await expect(page.getByTestId("verify-answer-verdict")).toContainText(/accept|retry/);
  await expect(page.getByTestId("verify-answer-followed_plan")).toContainText(/^0\.\d\d/);
  await expect(page.getByTestId("verify-decision-price")).toHaveText(/0\.000042 USDC\.e/);
  const channel = await page.getByTestId("verify-decision-channel").innerText();
  expect(channel).toMatch(/0x/);
  await expect(page.locator("body")).not.toHaveText(RETIRED);

  // And the same verdict from outside the console: `verify-step` fetches the blob itself,
  // re-hashes it, checks the verdict against what the step did with its memory, and checks the
  // voucher rode this loop's channel. Exit 0 is VERIFIED; anything else throws here.
  const registry = await (await request.get(`/api/loops?id=${loopId}`)).json();
  const seq = registry.loop.history[0].seq;
  expect(seq, "the first step's checkpoint seq").toBeTruthy();
  const printed = execFileSync(
    "npm",
    [
      "run",
      "--silent",
      "audit",
      "--",
      "verify-step",
      id(JUDGED),
      String(seq),
      "--store",
      TRACE_DIR,
      "--epochs",
      TRACE_DIR,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 }
  );
  expect(printed).toContain("VERIFIED");
  expect(printed).toContain("typesafe/jev-1.13");
});

test("a run that asked for no verdict still reads off, and the form verifies every step", async ({ page, request }) => {
  test.setTimeout(3 * 60_000);

  // Any agent this wallet owns will do — the case starts nothing and spends nothing, so it uses
  // whatever the seed left rather than deploying one of its own.
  await page.goto("/");
  await connectWallet(page);
  const loops = await (await request.get("/api/loops")).json();
  const existing = idleAgentLoop(loops.loops ?? [], await listedAgents(request));
  test.skip(!existing, "no loop whose agent is free: run the seed first, or wait for a run to stop");

  // The list: a run that asked for no second model carries no verify line at all, and *off* is
  // the absence of one rather than a chip that says so. The list is the workspace's _Yours_, whose
  // run rows carry no terms line for any run; the run's terms are checked below.
  if (!existing.verify) await expect(page.getByTestId("loop-verify-terms")).toHaveCount(0);

  // The run's own page: the terms carry no verifier, every step row's verify cell is empty, and
  // nothing the page says about the run has changed.
  await page.goto(`/loop/${existing.id}`);
  const terms = await openLoopTerms(page, 60_000);
  await expect(terms).toBeVisible();
  if (!existing.verify) {
    await expect(terms).not.toContainText("Verified by");
    await expect(page.getByTestId("loop-verify-terms")).toHaveCount(0);
    await closeInfo(page);
    // The verify cells are a proof column, read with the page's Proof open.
    await openProof(page, "loop-proof");
    const verify = page.getByTestId("step-verify");
    const n = await verify.count();
    for (let i = 0; i < n; i++) await expect(verify.nth(i)).toHaveText("—");
    await expect(page.getByTestId("step-verify-open")).toHaveCount(0);
  }
  await expect(page.locator("body")).not.toHaveText(RETIRED);

  // The start form: there is no toggle and no threshold field to switch off. The
  // one line above Start names the bar the start will sign — 0.5 on an agent's own form, which
  // carries no run's bar — so the owner reads that every step is verified before the signature.
  const form = await openLoopForm(page, existing.agentId);
  await openAdvanced(form);
  await expect(page.getByTestId("loop-verify-toggle")).toHaveCount(0);
  await expect(page.getByTestId("loop-verify-threshold")).toHaveCount(0);
  const always = page.getByTestId("loop-verify-always");
  await expect(always).toBeVisible();
  await expect(always).toContainText("minimum confidence of 0.5");
  await expect(always).toContainText("Lath pays for it");
  await expect(form).not.toHaveText(RETIRED);
});
