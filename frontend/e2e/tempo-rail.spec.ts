import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import * as path from "path";
import { connectWallet } from "./wallet";
import { TEMPO_EXPLORER_HREF, openInfo, openProof, tempoHrefs } from "./disclose";
// Every page sits behind the wallet gate (`components/WalletGate.tsx`): connect the E2E wallet
// once, and each later `page.goto` in the test reconnects it through `autoConnect`. It connects on
// the workspace's Tempo tab (`/?tab=tempo`) rather than on Yours, because Yours scans the wallet's
// agents the moment the gate lifts, and these specs read other pages.
test.beforeEach(async ({ page }) => {
  await page.goto("/?tab=tempo");
  await connectWallet(page);
});

/**
 * The `tempo` rail as a reader sees it: the screens that spend nothing.
 *
 * It reads those screens off chains already on devnet, against a console with a treasury, and
 * writes nothing: no session starts and no launch is signed, so it cannot spend on either chain.
 * What spends (a new paid session, a loop) is elsewhere — `--e2e` keeps the treasury too, so the
 * specs that start them bill for real; this file is the read-only half.
 *
 * Run it against a console with a treasury — it skips itself when the treasury route says there is
 * none, which is the only way a call can go unbilled:
 *
 * ```bash
 * PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test e2e/tempo-rail.spec.ts --workers=1
 * ```
 *
 * Every Tempo object on the loop page is a link to Tempo's explorer, and the last case holds that:
 * each such link's `href` is read — never followed — and must be a transaction, an address or a
 * block on explore.tempo.xyz. The workspace's Tempo tab has its own spec, `tempo-tab.spec.ts`.
 *
 * The chains it reads are named below by id. They are devnet records, so they stay; if they are
 * ever replaced, the ids here are the only thing to change.
 */

/** tempo-v2-0916a: a v2 agent, owned by the E2E wallet, with two loops paid from the treasury. */
const V2 = "71b91db0b25cf5e510fac2d50438208e71b7c1f9bca6556428246957bdfc57d1";
const V2_LOOPS = ["loop-dc6bce0b90381575", "loop-66c574a151ad43ca"];
/** tempo-v2-0916b: the second v2 agent, the one-glance confirmation. */
const V2B = "b7cd05ac3f3cf86450f416755f27cdf4461f724164728ec516e808a53e11e08c";
/** tempo-walk-0916a: an older agent whose policy gave it a Tempo wallet of its own. */
const V1 = "83962776e32e655e376e15d57b5bba164be1f99b70ff246b8c192b02a5f4f88d";
const V1_LOOP = "loop-f0e8ed358026d714";
/**
 * `vault-v2-0916a`: an older chain written on a vault rail this build does not have, kept as the
 * control for an agent that was never billed over MPP.
 */
const NEVER_BILLED = "eae44ec9a57b8ac51f96628b923aa4e9e1063dbe47659def4a2c098b3362cb94";
/** a23: a chat session paid two calls, 0 → 750 → 1 500, at seqs 25 and 28 of the epoch 25–29. */
const A23 = "9ef87905207eafeced71da38a9226071fc4621e55e4268b13123fe8ea3c68d54";
const A23_SEQ = 25;
const A23_CHANNEL = "0x455d31ec";
/**
 * a23 again, a session on the `irys` backend: seq 33 of the epoch 33–37, paid 0 → 1 500 on a
 * channel whose epoch blob and session bundle are at Irys and not on this disk. The first trace
 * case reads an fs-backed record, so this one covers a verify line that must not lean on a disk.
 */
const A23_IRYS_SEQ = 33;
const A23_IRYS_CHANNEL = "0x88628381";

/** Words no tempo screen may say: the labour market's, and a claim the rail cannot make. */
const RETIRED = /\b(hire|hired|worker|provider|dispute)\b/i;

interface Treasury {
  enabled: boolean;
  address?: string;
  balanceBase?: string | null;
  openChannels?: number;
}

let treasury: Treasury;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  treasury = await (await request.get("/api/tempo/treasury")).json();
});

test.beforeEach(async ({ page }) => {
  test.skip(!treasury?.enabled, "this console has no Tempo treasury, so there is no billed rail to read");
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/** A header the indexer may be a beat behind on: reload until the page has read the rail row. */
async function openAgent(page: Page, agentId: string, suffix = "") {
  await expect(async () => {
    await page.goto(`/agent/${agentId}${suffix}`);
    await expect(
      page.getByTestId("agent-lineage").or(page.getByText("verified on Solana", { exact: true }))
    ).toBeVisible({
      timeout: 20_000,
    });
  }).toPass({ timeout: 150_000, intervals: [3_000, 5_000, 10_000] });
}

/** `formatBaseUnits` in `lib/tempo.ts`, restated so the test does not take the page's word for it. */
function usdcE(base: string | bigint): string {
  const v = BigInt(base);
  return `${v / BigInt(1_000_000)}.${(v % BigInt(1_000_000)).toString().padStart(6, "0")}`;
}

test("the operator panel shows both balances and says the float is moved by hand", async ({ page }) => {
  test.setTimeout(2 * 60_000);

  // The two ends of the float, side by side: what the vault has metered
  // and not yet swept on Solana, and what the treasury has left on Tempo. Nothing moves one into
  // the other, and the panel has to say so — a reader who sees two balances and no explanation
  // will read them as one ledger.
  await page.goto("/billing");
  const float = page.getByTestId("operator-float");
  await expect(float).toBeVisible({ timeout: 60_000 });
  await expect(float.getByTestId("operator-vault-sweepable")).toHaveText(/[0-9]+\.[0-9]{6} USDC/, { timeout: 60_000 });
  await expect(float.getByTestId("tempo-operator-balance")).toHaveText(/^[0-9]+\.[0-9]{6}$/);
  await expect(page.getByTestId("operator-float-note")).toContainText("by hand");
  await expect(page.getByTestId("operator-float-note")).toContainText("no USDC route between Solana and Tempo");
});

test("the treasury route and the operator panel on /billing agree to the base unit", async ({ page, request }) => {
  test.setTimeout(2 * 60_000);

  expect(treasury.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(treasury.balanceBase, "the Tempo RPC answered").toMatch(/^[0-9]+$/);

  // No wallet: the operator's money is not the reader's, so the panel does not wait for one.
  await page.goto("/billing");
  const panel = page.getByTestId("tempo-operator");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole("link", { name: treasury.address! })).toBeVisible();

  // Read the route again beside the panel: a session elsewhere may have moved it in between, and
  // the claim is that the two agree, not that the balance stood still.
  await expect(async () => {
    const now: Treasury = await (await request.get("/api/tempo/treasury")).json();
    await expect(page.getByTestId("tempo-operator-balance")).toHaveText(usdcE(now.balanceBase!), { timeout: 5_000 });
    await expect(page.getByTestId("tempo-operator-channels")).toHaveText(String(now.openChannels ?? 0), {
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });

  const copy = await page.locator("main").innerText();
  expect(copy).not.toMatch(RETIRED);
  // The panel is the operator's account, not a per-agent ledger: nothing about agents funded or a cap.
  expect(await panel.innerText()).not.toMatch(/funded|top.?up|\bcap\b/i);
});

test("a treasury route that does not answer is said to be unreachable, not unconfigured", async ({ page }) => {
  test.setTimeout(2 * 60_000);

  // A 502 is not `enabled: false`: read as *this deployment has no Tempo treasury configured*, it
  // would be a configuration claim nothing had established. The route is failed in the browser
  // only; nothing on the server changes.
  await page.route("**/api/tempo/treasury", (route) => route.fulfill({ status: 502, body: "bad gateway" }));
  await page.goto("/billing");
  const panel = page.getByTestId("tempo-operator");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel).toContainText("did not answer", { timeout: 30_000 });
  await expect(panel).not.toContainText("no Tempo treasury configured");
  await expect(panel.getByTestId("tempo-operator-balance")).toHaveText("could not be read");
});

test("/create states the one rail and offers no choice of it", async ({ page }) => {
  test.setTimeout(2 * 60_000);

  await page.goto("/create?kind=agent");
  // The wizard is on screen from the start.
  await page.getByPlaceholder("e.g. agent-sentinel-v2").fill("tempo-rail-spec-never-deployed");
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();

  // The policy step has no *Paying for inference*: the rail is not a choice, and the review step's
  // *Model calls* row states it once, where the deploy is signed.
  await expect(page.getByRole("button", { name: "Review and deploy", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Paying for inference", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("deploy-rail-line")).toHaveCount(0);
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  const line = page.getByTestId("deploy-rail");
  // "OpenRouter via Tempo" is said wherever a model call is paid; MPP is in the Info that explains it.
  await expect(line).toContainText("OpenRouter via Tempo");
  // The treasury that will open the channel is a link to its page on Tempo's explorer, not a copy.
  if (treasury.address)
    await expect(line.getByTestId("deploy-rail-treasury").getByRole("link")).toHaveAttribute(
      "href",
      `https://explore.tempo.xyz/address/${treasury.address}`
    );
  // No button picks a rail, and the word *atomic* about the model payment is absent: there is one
  // rail, and a claim it cannot make is not restated to be denied.
  await expect(page.getByTestId("deploy-rail-tempo")).toHaveCount(0);
  await expect(page.getByTestId("deploy-rail-vault")).toHaveCount(0);
  expect(await line.innerText()).not.toMatch(/\batomic\b/i);
  // Words of a per-agent wallet the line must not use: a wallet of the agent's own, a cap to fund, a top-up.
  expect(await line.innerText()).not.toMatch(/wallet of its own|top.?up|\bfund (it|the agent)\b/i);
});

test("an agent's page carries no rail card, and an agent that was never billed shows no paid calls", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);

  // The agent page has no *Paying for inference* card: there is one rail, and /billing names the
  // treasury that pays it, so an older agent's own wallet is not drawn either.
  for (const agent of [V2, V2B, V1]) {
    await openAgent(page, agent);
    await expect(page.getByText("verified on Solana", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("agent-rail")).toHaveCount(0);
    await expect(page.getByText("Paying for inference", { exact: true })).toHaveCount(0);
  }

  // `vault-v2-0916a` was written on a vault rail, so nothing on its chain was ever paid over MPP.
  // The panel is absent rather than empty: a row reports "not paid" both for a record with no
  // payment and for a blob this page has no key for, so a sentence claiming the chain never paid
  // would be a claim the page cannot make. No rows and no panel is what a chain with nothing to
  // show looks like.
  await openAgent(page, NEVER_BILLED);
  await expect(page.getByText("verified on Solana", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("No paid call has been anchored on this chain yet.")).toHaveCount(0);
  await expect(page.getByTestId("dual-rail")).toHaveCount(0);
  await expect(page.getByTestId("dual-rail-row")).toHaveCount(0);
});

test("a paid call's trace shows the voucher, the treasury as payer, and a verify line that verifies as printed", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);

  // The step is batched into an epoch, so it is reached the way a shared link reaches it.
  await openAgent(page, A23, `?prove=${A23_SEQ}`);
  const step = page.locator(`[data-testid="epoch-step"][data-proved="true"]`);
  await expect(step.getByTestId("proof-badge")).toContainText("proof verified", { timeout: 120_000 });
  await step.locator("button.link-mono").first().click();

  const block = page.getByTestId("tempo-payment");
  await expect(block).toBeVisible({ timeout: 90_000 });
  await expect(block.getByTestId("tempo-channel")).toContainText(A23_CHANNEL.slice(0, 10));
  await expect(block.getByTestId("tempo-payer")).toHaveAttribute("data-payer-kind", "treasury");
  await expect(block.getByTestId("tempo-gateway-price")).toContainText("0.000750");
  // Present or honestly absent, never a zero standing in for "not reported".
  await expect(block.getByTestId("tempo-model-cost")).toContainText(/\$[0-9.]+ USD|not reported by the gateway/);

  const printed = (await block.getByTestId("tempo-verify-command").innerText()).trim();
  expect(printed).toMatch(/^T="https:\/\/rpc\.tempo\.xyz"$/m);
  expect(printed).toContain(`verify-inference ${A23} ${A23_SEQ}`);
  expect(printed).toContain(`--payer ${treasury.address}`);

  expect(runAsPrinted(printed), "the printed verify line, run as printed").toBe("VERIFIED");
});

test("an irys-backed paid call's verify line verifies as printed, with no directory of this console's", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);
  await openAgent(page, A23, `?prove=${A23_IRYS_SEQ}`);
  const step = page.locator(`[data-testid="epoch-step"][data-proved="true"]`);
  await expect(step.getByTestId("proof-badge")).toContainText("proof verified", { timeout: 120_000 });
  await step.locator("button.link-mono").first().click();

  const block = page.getByTestId("tempo-payment");
  await expect(block).toBeVisible({ timeout: 90_000 });
  await expect(block.getByTestId("tempo-channel")).toContainText(A23_IRYS_CHANNEL);
  await expect(block.getByTestId("tempo-payer")).toHaveAttribute("data-payer-kind", "treasury");

  const printed = (await block.getByTestId("tempo-verify-command").innerText()).trim();
  expect(printed).toContain(`verify-inference ${A23} ${A23_IRYS_SEQ}`);
  // The line names gateways, never a directory: `--store` would verify here and nowhere else.
  // The development console prints its own `/api/traces` as the raw
  // gateway, for the chain's fs-era locators; the CLI reads scheme 4 through Irys regardless.
  expect(printed).toMatch(/--gateway \S+ --scheme [04] --encoding/);
  expect(printed).not.toContain("--store");
  expect(runAsPrinted(printed), "the printed verify line, run as printed").toBe("VERIFIED");
  // And the same line with this console unreachable: the epoch blob and the session bundle the
  // voucher lives in are at Irys, so a reader with no access to this machine gets the same verdict.
  const elsewhere = printed.replace(
    /--gateway http:\/\/localhost:\d+\/api\/traces/,
    "--gateway http://127.0.0.1:9/api/traces"
  );
  expect(runAsPrinted(elsewhere), "the printed verify line, run where this console cannot be reached").toBe("VERIFIED");
});

/**
 * Runs a printed verify line as a stranger would paste it. The one substitution is the one a
 * reader makes anyway: their own RPC for the redacted `R=` placeholder. The page prints the repo's
 * own `npm run -s audit --`, since the package is not published. Every flag the page printed is
 * kept verbatim — which is the point: a flag the page leaves out is a verdict the reader cannot
 * reach. Returns the last line, the verdict.
 */
function runAsPrinted(printed: string): string {
  const repo = path.resolve(process.cwd(), "..");
  const rpc = execSync("solana config get", { encoding: "utf8" }).match(/RPC URL: (\S+)/)![1];
  const script = printed
    .split("\n")
    .map((l) => (l.startsWith("R=") ? `R="${rpc}"` : l))
    .join("\n");
  let out: string;
  try {
    out = execSync(script, { cwd: repo, shell: "/bin/bash", encoding: "utf8", timeout: 240_000 });
  } catch (e: any) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const verdict = out.trim().split("\n").pop() ?? "";
  return verdict === "VERIFIED" ? verdict : `${verdict}\n${out}`;
}

// The agent page has no rails card and a chat has no loop page, so the claim that the dual-rail
// panel is rebuilt from the chain after a reload is held by the next case, on the loop page, which
// rebuilds from the chain on every load; a23's two vouchers are covered by the two trace cases above.

test("a v2 loop's dual-rail panel pays every call from the treasury and closes with a settlement", async ({ page }) => {
  test.setTimeout(6 * 60_000);

  for (const loop of V2_LOOPS) {
    await page.goto(`/loop/${loop}`);
    // The panel is open under the steps, in the Costs card.
    const costs = page.getByTestId("loop-costs");
    await expect(costs).toBeAttached({ timeout: 120_000 });
    const panel = page.getByTestId("dual-rail");
    await expect(panel).toBeVisible({ timeout: 120_000 });
    const rows = panel.getByTestId("dual-rail-row");
    // Each row is an epoch blob fetched and re-hashed in the browser; on a rate-limited devnet RPC
    // the first can take well over the default wait.
    await expect(rows.first()).toBeVisible({ timeout: 180_000 });
    // Rows fill in as their epoch blobs resolve; wait until none is still "…".
    await expect(panel.getByTestId("dual-rail-delta").filter({ hasText: "…" })).toHaveCount(0, { timeout: 120_000 });

    const payers = panel.getByTestId("dual-rail-payer");
    const n = await payers.count();
    expect(n, `${loop} has paid rows`).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(payers.nth(i)).toHaveAttribute("data-payer-kind", "treasury");
    await expect(page.getByTestId("dual-rail-settlement").first()).toBeVisible({ timeout: 60_000 });
    // The panel has no column for what the wallet was charged, so it says where that number is,
    // and the sentence is asserted so it cannot drift into promising one. It is the card's
    // description in an Info on its title, word for word.
    await openInfo(costs.getByRole("button", { name: "What this table shows" }));
    await expect(page.getByRole("dialog", { name: "What this table shows" })).toContainText(
      "The wallet's USDC debit is not a column here"
    );
    expect(await page.locator("main").innerText()).not.toMatch(RETIRED);
  }
});

test("a v1 loop whose step never landed says no paid call is anchored, rather than inventing a row", async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);

  // The only v1 loop on devnet (`tempo-walk-0916a`) ran one step whose chain writes failed to land,
  // so its chain holds no paid Action and no row to be read from. What the panel must do then is
  // show nothing: a payer column filled in without a record behind it would be the console's word,
  // which is what the panel exists not to be. Nor does the page say "No paid call has been anchored
  // on this chain yet.": a row reports "not paid" both for a record with no payment and for a blob
  // the page holds no key for, so the sentence would be a claim the page cannot make. The page
  // still has to say the step never landed; that is the header.
  await page.goto(`/loop/${V1_LOOP}`);
  await expect(page.getByRole("heading", { name: /not anchored/i })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText("No step has been written yet.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("No paid call has been anchored on this chain yet.")).toHaveCount(0);
  await expect(page.getByTestId("dual-rail")).toHaveCount(0);
  await expect(page.getByTestId("dual-rail-row")).toHaveCount(0);
});

/**
 * Every Tempo object on the loop page is a link to Tempo's explorer:
 * the money flow's treasury, settlement and payee, the Paid on Tempo card's transactions, each
 * step's settlement in the Cost cell, a keyed loop's key, a channel's open block, and — inside the
 * Proof — the Solana record · Tempo payment table's payers and settlement. The hrefs are read and
 * never followed: a click opens explore.tempo.xyz in a new tab, and this checks that is where it goes.
 */
test("every Tempo link on a v2 loop's page opens its page on explore.tempo.xyz", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const TX = /^https:\/\/explore\.tempo\.xyz\/tx\/0x[0-9a-fA-F]{64}$/;
  const ADDRESS = /^https:\/\/explore\.tempo\.xyz\/address\/0x[0-9a-fA-F]{40}$/;
  const treasuryPage = `https://explore.tempo.xyz/address/${treasury.address!.toLowerCase()}`;

  for (const loop of V2_LOOPS) {
    await page.goto(`/loop/${loop}`);
    const flow = page.getByTestId("money-flow");
    await expect(flow).toBeVisible({ timeout: 120_000 });
    // The steps' proofs link their settlements once the chain's rows are read.
    await expect(page.getByTestId("loop-steps")).toBeVisible({ timeout: 180_000 });

    // The money flow's Tempo boxes by role: the treasury that paid, the close that settled it, and
    // the payee the close paid, each where the console's row recorded one.
    const payer = flow.getByTestId("money-flow-payer").getByRole("link");
    if (await payer.count()) expect((await payer.getAttribute("href"))?.toLowerCase()).toBe(treasuryPage);
    const settled = flow.getByTestId("money-flow-settlement").getByRole("link");
    if (await settled.count()) await expect(settled).toHaveAttribute("href", TX);
    const payee = flow.getByTestId("money-flow-payee").getByRole("link");
    if (await payee.count()) await expect(payee).toHaveAttribute("href", ADDRESS);
    // A keyed loop's key is one linked line under the flow: its address one click from the explorer.
    const key = page.getByTestId("loop-tempo-key-address").getByRole("link");
    if (await key.count()) await expect(key).toHaveAttribute("href", ADDRESS);
    // Then every one on the page — each step's proof and the Proof's table — once its rows have
    // resolved. The page's Proof opens every step's proof, where its settlement link is.
    const proof = await openProof(page, "loop-proof", 120_000);
    for (const cell of await page.getByTestId("step-tempo-settlement").all())
      await expect(cell.getByRole("link")).toHaveAttribute("href", TX);
    const panel = proof.getByTestId("dual-rail");
    await expect(panel.getByTestId("dual-rail-row").first()).toBeVisible({ timeout: 180_000 });
    await expect(panel.getByTestId("dual-rail-delta").filter({ hasText: "…" })).toHaveCount(0, { timeout: 120_000 });

    const hrefs = await tempoHrefs(page.locator("main"));
    expect(hrefs.length, `${loop} links its Tempo objects`).toBeGreaterThan(0);
    for (const href of hrefs) expect(href, `${loop}: a Tempo link`).toMatch(TEMPO_EXPLORER_HREF);
    // The treasury paid every call, so its own page is among them.
    expect(hrefs.map((h) => h.toLowerCase())).toContain(treasuryPage);
  }
});
