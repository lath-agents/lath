import { expect, Page, test } from "@playwright/test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
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
 * Shareable verification links, and the bundle that survives the browser being closed.
 *
 * `e2e/epoch-proof.spec.ts` covers the proof itself. This file covers the three things that
 * make a proof *transferable*: a url that lands on a step with its inclusion proof already
 * computed, a copy button that produces that url, and an export that writes the same evidence
 * to a file `scripts/verify-bundle.ts` can replay with no chain and no gateway.
 *
 * The events, their epochs, Prove and _Export verification_ sit behind the agent page's one
 * **Proof**. A link into it — `?seq=`,
 * `?prove=` — opens it on load, which is part of what a transferable link has to do; a bare
 * `/agent/<id>` lands with it closed, so the cases that arrive that way open it as a reader would.
 */

/** The id `scripts/seed.ts` creates. `agent_id = sha256(name)`, so it is derivable. */
const AGENT = createHash("sha256").update("seed-agent-alpha").digest("hex");

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`uncaught in page: ${e.message}`);
  });
});

/** Opens epoch #1 the ordinary way and returns the seq of its second step. */
async function secondStepSeq(page: Page): Promise<string> {
  await openProof(page, "proof", 120_000);
  const row = page.getByTestId("timeline-epoch").first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /open steps/i }).click();
  const step = page.getByTestId("epoch-steps").first().getByTestId("epoch-step").nth(1);
  await expect(step).toBeVisible();
  const seq = (await step.locator("td").first().innerText()).trim().replace(/^#/, "");
  expect(seq).toMatch(/^\d+$/);
  return seq;
}

test("?prove= opens the epoch, proves the step and shows the path, with no clicks", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);
  const seq = await secondStepSeq(page);

  // Same page, arrived at cold through the link a reader would have been sent.
  await page.goto(`/agent/${AGENT}?prove=${seq}`);

  // The epoch row is the focused one — the step has no row of its own in the timeline.
  const focused = page.locator("tr[data-focused]");
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute("data-testid", "timeline-epoch");

  // …and the panel opened itself, with the named step already proved against the chain's root.
  const panel = page.getByTestId("epoch-steps").first();
  await expect(panel).toContainText("Root rebuilt in this browser matches the chain");
  const step = panel.locator(`[data-testid="epoch-step"][data-proved="true"]`);
  await expect(step).toHaveCount(1);
  await expect(step.locator("td").first()).toContainText(`#${seq}`);
  await expect(step.getByTestId("proof-badge")).toContainText(/^proof verified · \d+-node path$/);
  await expect(step.getByTestId("storage-tier")).toHaveText("epoch #1 · proof verified");

  // No Prove button is left on that row, and the others still have theirs untouched.
  await expect(step.getByTestId("epoch-step-prove")).toHaveCount(0);
  await expect(panel.getByTestId("epoch-step").nth(0).getByTestId("epoch-step-prove")).toBeVisible();
});

test("?prove= on a record falls back to ?seq= and opens its trace", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);
  await openProof(page, "proof", 120_000);
  const first = page.getByTestId("timeline-record").first();
  await expect(first).toBeVisible();
  const seq = (await first.getAttribute("id"))!.replace("seq-", "");

  await page.goto(`/agent/${AGENT}?prove=${seq}`);
  const focused = page.locator("tr[data-focused]");
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute("data-testid", "timeline-record");
  await expect(focused).toHaveAttribute("id", `seq-${seq}`);
  // A record's evidence is its trace, so the panel is open: the toggle now offers to hide it.
  await expect(focused.getByRole("button", { name: "Hide" })).toBeVisible();

  // `?seq=` is untouched by any of this: it focuses and opens nothing in the timeline. It does open
  // the Proof, because the row it names is inside it, but the trace under that row stays closed.
  await page.goto(`/agent/${AGENT}?seq=${seq}`);
  await expect(page.getByTestId("proof-toggle")).toHaveAttribute("aria-expanded", "true", { timeout: 120_000 });
  await expect(page.locator("tr[data-focused]")).toHaveCount(1);
  await expect(page.locator("tr[data-focused]").getByRole("button", { name: "Open" })).toBeVisible();
});

test("the copy button on a row yields ?seq=, and on a step ?prove=", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  await page.goto(`/agent/${AGENT}`);
  await openProof(page, "proof", 120_000);
  const record = page.getByTestId("timeline-record").first();
  const recordSeq = (await record.getAttribute("id"))!.replace("seq-", "");
  await record.getByTestId("copy-link").click();
  expect(await clipboard()).toBe(`${new URL(page.url()).origin}/agent/${AGENT}?seq=${recordSeq}`);

  const seq = await secondStepSeq(page);
  const step = page.getByTestId("epoch-steps").first().getByTestId("epoch-step").nth(1);
  await step.getByTestId("copy-link").click();
  expect(await clipboard()).toBe(`${new URL(page.url()).origin}/agent/${AGENT}?prove=${seq}`);

  // And the copied link does what it says, the Proof it lands in included: `?prove=` opens it.
  await page.goto(await clipboard());
  await expect(page.locator(`[data-testid="epoch-step"][data-proved="true"]`).getByTestId("proof-badge")).toContainText(
    /proof verified/
  );
});

test("Export verification downloads a bundle holding the records, the epochs and the proofs", async ({ page }) => {
  await page.goto(`/agent/${AGENT}`);
  // The export button sits in the Events toolbar, which is inside the Proof.
  await openProof(page, "proof", 120_000);
  await expect(page.getByTestId("timeline-count")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-verification").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^lath-agent-[0-9a-f]{12}\.verification\.json$/);
  const bundle = JSON.parse(readFileSync((await download.path())!, "utf8"));

  // Version 3: an operation can also be a `policy` rewrite.
  expect(bundle.version).toBe(3);
  expect(bundle.id).toBe(AGENT);
  expect(bundle.kind).toBe("agent");
  expect(bundle.header.seq).toMatch(/^\d+$/);
  expect(bundle.header.head).toMatch(/^[0-9a-f]{64}$/);

  // Every row the timeline showed is in the file, and seqs are decimal strings, not numbers.
  const rows = await page.getByTestId("timeline-record").count();
  expect(bundle.records).toHaveLength(rows);
  for (const r of bundle.records) {
    expect(r.seq).toMatch(/^\d+$/);
    expect(r.head).toMatch(/^[0-9a-f]{64}$/);
    expect(r.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  }

  // The seeded chain has an epoch whose blob the local gateway serves, so its steps and their
  // sibling paths are in the bundle — and nothing is claimed for an epoch that had no blob.
  expect(bundle.epochs.length).toBeGreaterThan(0);
  const withSteps = bundle.epochs.filter((e: { steps?: unknown[] }) => e.steps);
  expect(withSteps.length).toBeGreaterThan(0);
  for (const e of withSteps) {
    expect(e.steps).toHaveLength(Number(e.endSeq) - Number(e.startSeq));
    expect(e.root).toMatch(/^[0-9a-f]{64}$/);
    for (const s of e.steps) {
      expect(s.leaf).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(s.proof)).toBe(true);
      expect(typeof s.index).toBe("number");
    }
  }
  // The deploy's own writes — a create_struct and the NameRecord cell — are in the file, which is
  // what lets the checker fold across seq 0 instead of reporting a gap there.
  expect(bundle.operationsStatus).toBe("scanned");
  for (const o of bundle.operations) {
    expect(o.seq).toMatch(/^\d+$/);
    expect(["struct", "cell", "policy"]).toContain(o.type);
    if (o.type === "cell") expect(o.head).toMatch(/^[0-9a-f]{64}$/);
  }

  const unavailable: number[] = bundle.unavailable;
  expect(unavailable).toEqual(
    bundle.epochs.filter((e: { steps?: unknown[] }) => !e.steps).map((e: { ordinal: number }) => e.ordinal)
  );
});
