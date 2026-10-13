import { expect, type Locator, type Page } from "@playwright/test";
import { closeInfo, openInfo } from "./disclose";

/**
 * The two halves of a scheduled agent, as the console splits them: the wizard at `/create` deploys
 * an agent and nothing else, and a loop is started on that agent from the loop form,
 * `/create?loop=1&agent=<id>`, which the agent page's *Run as agent loop* card links to. Two wallet
 * prompts — the deploy's transaction, then the start's `"Lath loop"` message — and one job per screen.
 *
 * Not a spec file (Playwright only collects `*.spec.ts`), so the specs that deploy an agent and then
 * loop it share one copy of the path rather than six. The loop page's step rows are here too
 * (`stepRows`, `openStepDetails`, `findStepWithDetail`): each row's extra chips are one `Info`, and
 * every loop spec reads them the same way.
 */

/** The terms the form's chips offer, by their labels. Only what the specs actually vary. */
export interface LoopTerms {
  /**
   * The standing instruction, typed into the one Goal field with the goal check off; at least
   * `LOOP_PROMPT_MIN` (10) characters, or Start stays disabled.
   */
  prompt: string;
  /** An interval chip's label; the shortest, so a spec's wall clock is steps, not waiting. */
  interval?: "10 s" | "1 min" | "5 min";
  /** A step-count chip's label. */
  /** A steps chip (3, 6 or 12), or any other count typed into the steps field. */
  steps?: string;
}

/**
 * Deploys a blank agent through the wizard and leaves the page on its done state. The agent flow
 * opens on the blank wizard, so the helper waits for the name field and fills it. The wizard is
 * the one path that grants the allowance in the same transaction, which is what makes the loop's
 * steps billable.
 *
 * `connect` is the calling spec's own wallet connect: each spec carries one, and they differ in
 * nothing that matters here, so the helper takes it rather than growing a seventh copy.
 *
 * `here`: the page is already on `/create` with the wallet connected — the recorded demo's shot 1
 * opens there — so the helper goes on from it rather than loading the same page again, which on
 * video is a blink between shot 1 and shot 2.
 */
export async function deployBlankAgent(
  page: Page,
  name: string,
  connect: (page: Page) => Promise<void>,
  opts: { timeout?: number; here?: boolean } = {}
) {
  if (!opts.here) {
    await page.goto("/create");
    await connect(page);
  }
  // `/create` is the blank agent form with nothing above it.
  const nameField = page.getByPlaceholder("e.g. agent-sentinel-v2");
  await expect(nameField).toBeVisible({ timeout: 60_000 });
  await nameField.fill(name);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  // A deploy never schedules anything, so the confirmation names the agent and nothing else.
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: opts.timeout ?? 120_000 });
}

/**
 * Opens the loop form on `agentId` and returns it: `/create?loop=1&agent=<id>`, where the agent page's
 * _Run as a loop_ links. The agent page's *Run as agent loop* card is a pointer to this page, so
 * every spec that starts a loop "on the agent's page" opens the same `LoopStartForm` here.
 *
 * `LoopEntry` falls back to the wallet's first agent while the registry has not listed a fresh deploy
 * yet, so the select is held to this agent — a form on another agent would start a loop there just as
 * happily — and the page loads again until the list has caught up (`sandbox-sources.spec.ts`'s wait).
 * A full load each time: the wizard reaches its done state by client navigation, and a list fetched
 * before this agent was registered would never refetch.
 */
export async function openLoopForm(page: Page, agentId: string): Promise<Locator> {
  const url = `/create?loop=1&agent=${agentId}`;
  await expect(async () => {
    await page.goto(url);
    await expect(page.getByTestId("loop-agent-select")).toHaveValue(agentId, { timeout: 15_000 });
  }).toPass({ timeout: 180_000, intervals: [3_000, 5_000, 10_000] });
  const form = page.getByTestId("loop-start-form");
  await expect(form).toBeVisible({ timeout: 120_000 });
  return form;
}

/**
 * After _Start_ on `/create?loop=1`: the form goes to the run's own page on success, where the
 * leaves are verified. Returns the loop id from its url.
 */
export async function openStartedLoop(page: Page, timeout = 90_000): Promise<string> {
  await expect(page).toHaveURL(/\/loop\/loop-/, { timeout });
  return page.url().split("/loop/")[1];
}

/**
 * Starts a loop on `agentId` from the loop form (`openLoopForm`), then returns the id of the run whose
 * page the form opened. The name says where a reader starts: the agent page's _Run as a loop_.
 *
 * Every loop the form starts is a clock-driven run, which is every loop these specs describe; the
 * text goes in the one Goal field with the goal check off (`fillLoopGoal`), so the run is an
 * instruction-only loop.
 */
export async function startLoopFromAgentPage(page: Page, agentId: string, terms: LoopTerms): Promise<string> {
  const form = await openLoopForm(page, agentId);
  // The instruction is the form's one Goal field, with _Jev checks the goal_ switched off: the
  // instruction-only loop on the clock these specs describe (`lib/loop-goal-field.ts`).
  await fillLoopGoal(page, terms.prompt, { goalCheck: false });
  await form.getByRole("button", { name: terms.interval ?? "1 min", exact: true }).click();
  const steps = terms.steps ?? "3";
  if (["3", "6", "12"].includes(steps)) await form.getByRole("button", { name: steps, exact: true }).click();
  else await form.getByTestId("loop-steps-custom").fill(steps);
  await page.getByTestId("loop-start").click();
  return openStartedLoop(page);
}

/**
 * Types `text` into the loop form's one Goal field (`loop-goal-input`) and sets its two switches. The
 * form has no separate instruction: the text is always sent as the instruction, and as the goal too
 * while _Jev checks the goal_ is on (the default) or, with it off, while _The agent says when it is
 * done_ is on (`lib/loop-goal-field.ts`). So:
 *
 * - `goalCheck: true` (default) — a goal loop Jev judges, the text as both goal and instruction;
 * - `goalCheck: false` — the instruction-only loop, with no goal;
 * - `goalCheck: false, selfStop: true` — the goal loop stopped by the agent's own `GOAL REACHED`.
 *
 * The form has no trigger picker: every loop it starts is on the clock.
 */
export async function fillLoopGoal(
  page: Page,
  text: string,
  opts: { goalCheck?: boolean; selfStop?: boolean } = {}
): Promise<void> {
  const form = page.getByTestId("loop-start-form");
  await form.getByTestId("loop-goal-input").fill(text);
  const check = page.getByTestId("loop-goal-check-toggle");
  const wantCheck = opts.goalCheck ?? true;
  if ((await check.getAttribute("aria-pressed")) !== String(wantCheck)) await check.click();
  await expect(check).toHaveAttribute("aria-pressed", String(wantCheck));
  if (wantCheck) return;
  const self = page.getByTestId("loop-goal-self-stop-toggle");
  const wantSelf = opts.selfStop ?? false;
  if ((await self.getAttribute("aria-pressed")) !== String(wantSelf)) await self.click();
  await expect(self).toHaveAttribute("aria-pressed", String(wantSelf));
}

/**
 * The loop page's step cards: `.step-row`, one per checkpoint, each holding what it opens under
 * itself (its proof and the decision, and on a row that carries them the team, the gate log and the
 * trace audit's answer).
 */
export function stepRows(page: Page): Locator {
  return page.getByTestId("loop-steps").locator(".step-row");
}

/**
 * Opens one step row's details `Info` (`step-details-open`) and returns its popover. The Outcome
 * cell keeps the status and goal chips and folds the rest — the trace audit, the team, the wake, the
 * reason — into it. The popover
 * is portalled to the body, so it is found from `page`, and only one is open at a time. Its buttons
 * still open the rows under the step; a click elsewhere on the page closes it, and the rows stay.
 */
export async function openStepDetails(page: Page, row: Locator, timeout = 60_000): Promise<Locator> {
  await openInfo(row.getByTestId("step-details-open"), timeout);
  return page.getByTestId("step-details");
}

/**
 * The first step row whose details hold `testId` — left with its details open — or `null` when
 * none does. A row with no details has no trigger and is passed over.
 *
 * A `filter({ has })` would retry until its assertion's timeout; a scan of popovers cannot be a locator,
 * so this one passes over the rows again every two seconds until `timeout` (a row's summary arrives
 * with the registry's next read, after the row itself). `timeout: 0` is one pass, for a caller that
 * asserts there is none.
 */
export async function findStepWithDetail(
  page: Page,
  testId: string,
  timeout = 60_000
): Promise<{ row: Locator; details: Locator } | null> {
  const until = Date.now() + timeout;
  for (;;) {
    const rows = stepRows(page);
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      if (!(await row.getByTestId("step-details-open").count())) continue;
      const details = await openStepDetails(page, row);
      if (await details.getByTestId(testId).count()) return { row, details };
      await closeInfo(page);
    }
    if (Date.now() >= until) return null;
    await page.waitForTimeout(2_000);
  }
}
