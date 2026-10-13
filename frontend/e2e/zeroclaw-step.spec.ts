import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as path from "path";
import { openAdvanced } from "./disclose";
import { deployBlankAgent, fillLoopGoal, openLoopForm, openStartedLoop, type LoopTerms } from "./loop-flow";
import { resignStart } from "./wallet";

/**
 * A loop whose steps run in sandboxes, end to end on devnet.
 *
 * Two steps of one loop: the first writes a file into the loop's workspace with the sandbox's
 * `file_write`, the second reads it back with `file_read`. What the case holds:
 *
 * 1. each step's Actions on the agent's chain carry the sandbox's tool ids — `zc.file_write` in step
 *    one, `zc.file_read` in step two — read off the chain by the sandbox page, not off the console;
 * 2. `GET /api/zeroclaw` lists the loop's sandbox, naming the wrapper the step ran under and its `zc`
 *    count, and the sandbox page states the trademark line and its route once (`/zeroclaw` redirects
 *    to the workspace, where the run is a row of its agent's);
 * 3. the sandbox page says the air-gap sentence for its platform, and its _Verify_ re-hashes the
 *    posture to the hash the sandbox recorded;
 * 4. `lath-audit` from outside the console says VERIFIED for the agent;
 * 5. the loop carries one sandbox source, a small public file on GitHub sent
 *    as a URL source, and each step's sandbox page shows it on the Sources card: one source, the
 *    final URL, one file, and the manifest re-hashed in the browser to the posture's `sources.hash`,
 *    tagged `chain`. The form types no URL source (it attaches files only, ROADMAP.md), so the source
 *    is added to the start body on its way out, as an API client would send it, and _Check sources_
 *    is not walked here;
 * 6. the texts are every reader's: a read that signed nothing gets the loop and the sandbox in full —
 *    the instruction, the sources manifest and the replay record beside every hash.
 *
 * It needs `ZeroClawRuntime` behind `/api/loops`, a Lath-patched binary at `LATH_ZEROCLAW_BIN` on the
 * server, and devnet. Without a configured binary it skips,
 * saying so, rather than asserting about in-process steps that have no sandbox. Run it as every loop
 * spec runs: `--timeout=240000 --workers=1`.
 *
 * The form's _Files_ section offers files and nothing else, and it is on screen with no _Advanced_
 * box; opened here to see so.
 *
 * The model is what decides to call the tools, so the prompt names them and the file; a step that
 * answered without calling one fails the case at (1), which is the honest place for it to fail.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
const NAME = `e2e-sandbox-${RUN}`;
/** Repo root from `frontend/`, for `npm run audit`. */
const ROOT = path.resolve(process.cwd(), "..");
/** The word step one writes and step two must read back. */
const WORD = `LATH-${RUN.toUpperCase()}`;
/**
 * The sandbox's one source: a small public file on GitHub, fetched as a URL source. Not a file the
 * `:3112` gateway serves — the fetcher refuses private addresses — and not a GitHub repo source,
 * whose tree fetch is `sandbox-sources.spec.ts`'s and would make this case pay for a whole checkout.
 * Served `text/plain`, about 9 KiB, and raw.githubusercontent.com does not redirect it, so the
 * final URL is the input.
 */
const SOURCE_URL = "https://raw.githubusercontent.com/Squads-Protocol/v4/main/README.md";

/**
 * Words no ZeroClaw screen may say: the labour market's, and the claims the tab is forbidden — the
 * chain commits a posture, it does not show one applied.
 * Built from halves for the reason `loop-verify.spec.ts` gives: the repo is swept for these words.
 */
const RETIRED = new RegExp(
  `\\b(${["hi" + "re", "wor" + "ker", "provi" + "der", "pro" + "ven", "verified " + "correct"].join("|")})\\b`,
  "i"
);

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/** The header's wallet connect, waited for the way `loop-verify.spec.ts` explains. */
async function connectWallet(page: Page) {
  await expect(page.locator(".wallet-adapter-button-trigger").first()).toBeVisible({ timeout: 60_000 });
  const select = page.getByRole("button", { name: /select wallet/i });
  if (await select.count()) {
    await select.first().click();
    await page.getByRole("button", { name: /E2E Keypair/i }).click();
  }
  await expect(page.getByRole("button", { name: /select wallet/i })).toHaveCount(0);
}

/** The trace directory the server writes to, as the server reports it — never guessed. */
async function traceDir(request: APIRequestContext): Promise<string> {
  const run = await (await request.get("/api/run")).json();
  return run.traceBackend?.dir ?? path.join(ROOT, "frontend/.traces-devnet");
}

/** The RPC the CLI needs: the devnet one, never `api.devnet.solana.com`, which has no compression index. */
function rpcUrl(): string {
  if (process.env.LATH_DEVNET_RPC) return process.env.LATH_DEVNET_RPC;
  if (process.env.LATH_RPC_URL) return process.env.LATH_RPC_URL;
  const printed = execFileSync("solana", ["config", "get"], { encoding: "utf8" });
  return printed
    .split("\n")
    .find((l) => l.startsWith("RPC URL:"))!
    .split(/\s+/)[2];
}

/**
 * Opens step `step`'s sandbox page and waits until its Actions table has rendered. By its own URL,
 * not the bare one: the loop may already have run the next step, and the bare URL follows it.
 */
async function openSandbox(page: Page, loopId: string, step: number): Promise<void> {
  await page.goto(`/zeroclaw/${loopId}?step=${step}`);
  await expect(page.getByText(`step ${step}`, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("zeroclaw-actions")).toBeVisible({ timeout: 120_000 });
}

/**
 * `startLoopFromAgentPage` with the files section opened between the chips and _Start_. Local rather
 * than a hook on the shared helper, which the other loop specs call with no sandbox and should keep
 * calling unchanged. The URL source itself is added by the test's route (above the call).
 */
async function startLoopWithSource(page: Page, agentId: string, terms: LoopTerms): Promise<string> {
  // The loop form at `/create?loop=1&agent=<id>`, where the agent page's card links
  // (`loop-flow.ts` `openLoopForm`).
  const form = await openLoopForm(page, agentId);
  // The one Goal field with the check off: the instruction-only loop on the clock, the only trigger
  // the form offers.
  await fillLoopGoal(page, terms.prompt, { goalCheck: false });
  await form.getByRole("button", { name: terms.interval ?? "1 min", exact: true }).click();
  await form.getByRole("button", { name: terms.steps ?? "3", exact: true }).click();

  // The files section: collapsed and off until its toggle is pressed, on screen with every other
  // option. It attaches files and adds no other kind of source.
  await openAdvanced(form);
  await form.getByTestId("loop-sandbox-toggle").click();
  await expect(form.getByTestId("loop-sandbox-body")).toBeVisible();
  await expect(form.getByTestId("loop-sandbox-source-attach")).toBeVisible();
  await expect(form.getByTestId("loop-sandbox-source-add")).toHaveCount(0);

  await page.getByTestId("loop-start").click();
  return openStartedLoop(page);
}

/**
 * The sandbox page's Sources card for the step on screen: the one source as the sandbox was seeded with
 * it, and both comparisons the browser makes — the served manifest re-hashes to the posture's
 * `sources.hash`, and the sandbox's record names that same hash. The hash is tagged `chain` only when
 * it is read from the posture, which _Verify_ ties to the Genesis, so the tag is asserted too.
 */
async function expectSourcesCard(page: Page) {
  const card = page.getByTestId("zeroclaw-sources");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("zeroclaw-sources-missing")).toHaveCount(0);
  const source = card.getByTestId("zeroclaw-source");
  await expect(source).toHaveCount(1);
  await expect(source.getByText("url", { exact: true })).toHaveCount(1);
  // The final URL is the pin's link; the input beside the kind badge is plain text.
  await expect(source.locator(`a[href="${SOURCE_URL}"]`)).toHaveCount(1);
  await expect(source).toContainText("text/plain");
  await expect(source).toContainText(/(^|\D)1 file · /);
  const checks = card.getByTestId("zeroclaw-sources-checks");
  await expect(checks).toContainText(/match\s*manifest → posture sources\.hash/, { timeout: 60_000 });
  await expect(checks).toContainText(/match\s*sandbox record names the posture's sources/);
  await expect(checks).not.toContainText("mismatch");
  await expect(checks).not.toContainText("unavailable");
  await expect(card.locator('[data-testid="source-tag"][data-source="chain"]')).toHaveCount(1);
}

test("a two-step loop writes a file in its sandbox and reads it back, on chain and on the tab", async ({
  page,
  request,
}) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  const zeroclaw = await (await request.get("/api/zeroclaw")).json();
  test.skip(
    !zeroclaw.host?.configured,
    `no Lath-patched binary on the server (${
      zeroclaw.host?.note ?? "GET /api/zeroclaw did not answer"
    }): loop steps cannot run in a sandbox`
  );
  test.setTimeout(12 * 60_000);

  await deployBlankAgent(page, NAME, connectWallet, { timeout: 240_000 });

  // Two steps fifteen seconds apart: the chips offer neither, so the JSON is patched on its way out
  // and signed again with the wallet's own key (`resignStart`; a start's signature hashes its
  // body) — the same move `loop-verify.spec.ts` makes.
  await page.route("**/api/loops", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}");
    // The start only: any other action this route takes has a body that is not a loop's terms.
    if (body.action !== "start") return route.fallback();
    // The one URL source the form does not type, on the body as an API client sends it.
    expect(body.sandbox, "the form sent no sandbox: the section was opened and left empty").toBeUndefined();
    const sandbox = { sources: [{ kind: "url", url: SOURCE_URL }] };
    await route.continue({
      postData: JSON.stringify(
        resignStart({ ...body, maxSteps: 2, intervalMs: 15_000, sandbox }, route.request().url())
      ),
    });
  });
  const loopId = await startLoopWithSource(page, id(NAME), {
    prompt:
      `If the file notes.txt is not in your workspace, call file_write to create notes.txt containing exactly ${WORD}. ` +
      `If it is there, call file_read on notes.txt and answer with its contents. Use the file tools; do not guess.`,
  });

  // Step one on the loop page, then its sandbox: the Actions are read off the chain in the browser.
  const rows = page.getByTestId("loop-steps").locator(".step-row");
  await expect(rows).toHaveCount(1, { timeout: 6 * 60_000 });
  await openSandbox(page, loopId, 1);
  await expect(page.getByTestId("zeroclaw-action-zc").filter({ hasText: "zc.file_write" })).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(page.getByTestId("zeroclaw-actions-record")).toContainText("matches the chain");
  await expectSourcesCard(page);

  // The air gap, in the page's own words, for the platform the server runs on.
  await expect(page.getByTestId("zeroclaw-airgap")).toContainText(
    "could reach the metering proxy and Lath's host tools over two Unix sockets and nothing else"
  );
  await expect(page.getByTestId("zeroclaw-airgap")).toContainText(/on (macOS \(sandbox-exec\)|Linux \(bwrap\))/);
  await expect(page.getByTestId("zeroclaw-attribution")).toHaveText(
    "ZeroClaw is a trademark of ZeroClaw Labs; Lath runs a Lath-patched build of it."
  );
  await expect(page.getByTestId("zeroclaw-routes")).toContainText(`GET /api/zeroclaw/${loopId}`);

  // Verify: the posture's bytes re-hash, in the browser, to the hash the sandbox recorded; nothing
  // compared comes out as a mismatch (a check the page could not make says *unavailable*).
  await page.getByTestId("zeroclaw-posture-verify").click();
  const checks = page.getByTestId("zeroclaw-posture-checks");
  await expect(checks).toContainText(/match\s*posture bytes → posture hash/, { timeout: 120_000 });
  await expect(checks).not.toContainText("mismatch");
  await expect(page.locator("body")).not.toHaveText(RETIRED);

  // Step two reads it back.
  await page.goto(`/loop/${loopId}`);
  await expect(page.getByTestId("loop-steps").locator(".step-row")).toHaveCount(2, { timeout: 6 * 60_000 });
  await openSandbox(page, loopId, 2);
  await expect(page.getByTestId("zeroclaw-action-zc").filter({ hasText: "zc.file_read" })).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(page.getByTestId("zeroclaw-actions-record")).toContainText("matches the chain");
  // The same source in step two's sandbox: fetched once at start and copied into every sandbox of the
  // loop, so the card and its hash are step one's again.
  await expectSourcesCard(page);

  // (6) Whose texts they are: every reader's. A `request` that signed nothing and sends no header
  // reads the instruction, the sources manifest and the replay record beside the hashes that commit them.
  const loop = (await (await request.get(`/api/loops?id=${encodeURIComponent(loopId)}`)).json()).loop;
  expect(loop.prompt).toContain(WORD);
  expect(loop.promptHash).toMatch(/^[0-9a-f]{64}$/);
  const sandbox = (await (await request.get(`/api/zeroclaw/${encodeURIComponent(loopId)}?step=2`)).json()).sandbox;
  expect(sandbox.sources?.value?.manifest?.sources).toHaveLength(1);
  expect(sandbox.sources?.value?.hash).toMatch(/^[0-9a-f]{64}$/);
  if (sandbox.step?.replayable)
    expect(sandbox.replay?.value ?? null, "the replay record is on the wire").not.toBeNull();

  // The list. `/zeroclaw` redirects to the workspace, so the wrapper, the zc count and the host's
  // status are read from `GET /api/zeroclaw` (the route the sandbox page states, asserted above with
  // the trademark line), and the run is found where a person finds it: a row under its agent in the
  // workspace's _Yours_.
  const list = await (await request.get("/api/zeroclaw")).json();
  expect(list.host?.configured, "the host has a Lath-patched binary").toBe(true);
  expect(list.host?.wrapper, "and a wrapper for its platform").toMatch(/^(bwrap|sandbox-exec)$/);
  const listed = (list.sandboxes ?? []).find((z: { loopId: string }) => z.loopId === loopId);
  expect(listed, "the loop's sandbox is listed").toBeTruthy();
  expect(listed.sandboxed, "a step of it left a sandbox record").toBe(true);
  expect(listed.wrapper?.value?.kind).toMatch(/^(bwrap|sandbox-exec)$/);
  expect(listed.lastStep?.zcActions?.value, "its last step wrote zc Actions").toBeGreaterThanOrEqual(1);
  await page.goto("/zeroclaw");
  await connectWallet(page);
  await expect(page).toHaveURL(/\/(\?[^/]*)?$/, { timeout: 60_000 });
  await expect(page.getByTestId("owners-spine")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-testid="loop-row"][data-loop-id="${loopId}"]`)).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(page.locator("body")).not.toHaveText(RETIRED);

  // And from outside the console: the audit replays the chain, re-hashes the blobs the console wrote
  // in the clear, and exits 0 on VERIFIED with every memory link ok. No key: there is nothing to open.
  const dir = await traceDir(request);
  const printed = execFileSync(
    "npm",
    ["run", "--silent", "audit", "--", id(NAME), "--store", dir, "--epochs", dir, "--rpc", rpcUrl()],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000 }
  );
  expect(printed).toContain("VERIFIED");
  // N of N, whatever N the audit counts: step two resumed from what step one's checkpoint committed,
  // and a `mismatch` on either would print fewer ok than it counts.
  expect(printed).toMatch(/memory\s+(\d+) of \1 loop steps resumed/);
});
