import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { openInfo, openProof } from "./disclose";
import { deployBlankAgent, startLoopFromAgentPage, stepRows } from "./loop-flow";

/**
 * The builder behind *New agent* and *New loop*.
 *
 * Three claims: start from your own agent → deploy → the new agent's page says it was deployed
 * from v‹n+1› of the same template; start from a run → run again with a changed interval; the Blank
 * pane is the wizard for an agent, and — since a deploy never starts a loop — the empty loop form,
 * never the wizard, for a loop.
 *
 * What the file is careful about, and why:
 *
 * - **Lineage is asserted relatively, never as "v2".** A blank wizard deploy links to the
 *   *owner's* template with the same config hash (`implicitTemplate`), so the fixture deployed
 *   here may well land on a template an earlier spec wrote, at v7. The claim is therefore
 *   `latest + 1` against the version read a moment before the deploy — which is exactly what the
 *   review step promises in words (`appends v‹n+1› to ‹name›`) and what the server writes
 *   (`appendOrMint`). The same rule holds for the loop template.
 * - **The version a pick appends to is the template's latest, not the source row's.** The picker
 *   resolves a source's template link against `GET /api/templates?owner=`, which carries latest
 *   versions only (`lib/sources.ts`, `link()`), so the version read here comes from
 *   `GET /api/templates?id=` and not from the agent or loop record.
 * - **The one-wallet-prompt claim is not re-litigated here.** The E2E adapter signs without a
 *   dialog, so counting prompts in this file would assert nothing; that claim is checked by hand.
 *
 * Cases 1 and 2 deploy two agents; case 2 runs two billed sessions; case 3 starts a loop, whose
 * first step fires at once, and stops it again. Budget a few cents of USDC.e at the gateway and
 * about fifteen minutes of devnet wall clock, and run the file `--timeout=240000 --workers=1`
 * like every other spec here.
 *
 * Case 3 skips itself, in words, when devnet holds nothing for it: a wallet with no startable run
 * of its own (it deploys one rather than skipping, and only skips if that deploy cannot be made).
 *
 * The loop form's essentials — instruction, goal, the interval, steps and budget chips — are the
 * ones this file touches (the form has no _Advanced_ disclosure: every option is on screen); on the
 * agent page the event timeline is behind the **Proof**, which the genesis read opens.
 */

const id = (name: string) => createHash("sha256").update(name).digest("hex");
/** Fresh names per run; `E2E_RUN=<suffix>` re-targets what an earlier run deployed. */
const RUN = process.env.E2E_RUN ?? Date.now().toString(36).slice(-6);
/** The agent case 1 starts *from*, and the copy it deploys. */
const SOURCE = `e2e-builder-${RUN}`;
const COPY = `${SOURCE}-2`;
/** The agent case 3 falls back to deploying when the wallet has no run to start again. */
const LOOP_AGENT = `e2e-builder-loop-${RUN}`;
/** The env file the seed writes under `--e2e-wallet`; the browser's wallet is this keypair. */
const E2E_ENV = process.env.E2E_ENV_FILE ?? path.join(process.cwd(), ".env.devnet.e2e");

/** The owner scan the picker's tiles wait on is 10–20 s on this wallet. */
const PICKER_READY = 120_000;

test.describe.configure({ mode: "serial" });

/** What case 1 leaves for case 2, which compares the two chains' policy hashes. */
const state: { sourceTemplate?: { id: string; name: string; version: number }; copyVersion?: number } = {};

test.beforeEach(async ({ page, request }) => {
  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* The wallet, and the console's own lists                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * `autoConnect` only reconnects a wallet the browser has already chosen, so the first connection
 * in a fresh context goes through the real modal — the path a person takes anyway.
 */
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

/**
 * The E2E wallet's public key, read from the file `dev-devnet.sh --e2e` sources. Only the API
 * reads need it — the browser holds the same key through the adapter — and it is read here rather
 * than scraped off the page because the wallet's address is the key every `?owner=` read is
 * scoped by.
 */
function e2eWallet(): string | null {
  try {
    const line = readFileSync(E2E_ENV, "utf8")
      .split("\n")
      .find((l) => l.startsWith("NEXT_PUBLIC_E2E_WALLET_SECRET="));
    if (!line) return null;
    const raw = line
      .slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[])).publicKey.toBase58();
  } catch {
    return null;
  }
}

interface AgentRecord {
  id: string;
  name: string;
  owner: string | null;
  template: { id: string; version: number; hash: string } | null;
  templateName: string | null;
  latestVersion: number | null;
}

interface TemplateRow {
  id: string;
  kind: "agent" | "loop";
  name: string;
  version: number;
  hash: string;
  config: Record<string, unknown>;
}

interface LoopRow {
  id: string;
  agentId: string;
  agentName?: string;
  owner: string;
  status: "running" | "paused" | "stopped";
  archivedAt: number | null;
  intervalMs: number;
  maxSteps: number;
  /** Sent to every reader: the console writes a run's terms in the clear. */
  prompt: string;
  createdAt: number;
  stepping?: boolean;
  template: { id: string; version: number; hash: string } | null;
  /** Present when the run's sandbox read sources; `sourcesHash` commits them. */
  sandbox?: { sourcesHash?: string } | null;
}

async function agentRecord(request: APIRequestContext, agentId: string): Promise<AgentRecord> {
  const res = await request.get(`/api/agents/${agentId}`);
  expect(res.status(), `GET /api/agents/${agentId}`).toBe(200);
  return (await res.json()).agent;
}

/** The latest version of one template, and the versions behind it, texts included for every reader. */
async function templateById(request: APIRequestContext, templateId: string) {
  const res = await request.get(`/api/templates?id=${encodeURIComponent(templateId)}`);
  expect(res.status(), `GET /api/templates?id=${templateId}`).toBe(200);
  const body = await res.json();
  return { latest: body.template as TemplateRow, versions: (body.versions ?? []) as TemplateRow[] };
}

async function loops(request: APIRequestContext, query = ""): Promise<LoopRow[]> {
  const res = await request.get(`/api/loops${query}`);
  expect(res.status(), `GET /api/loops${query}`).toBe(200);
  return ((await res.json()).loops ?? []) as LoopRow[];
}

async function loopById(request: APIRequestContext, loopId: string): Promise<LoopRow> {
  const res = await request.get(`/api/loops?id=${encodeURIComponent(loopId)}`);
  expect(res.status(), `GET /api/loops?id=${loopId}`).toBe(200);
  return (await res.json()).loop as LoopRow;
}

/* ------------------------------------------------------------------------------------------ */
/* The wizard and the picker                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * One _Create from_ choice on the Agent loop form (three cards). The _Existing loop_ card carries a
 * count badge.
 */
async function pickPane(page: Page, pane: "agent" | "loop" | "new") {
  const card = page.getByTestId(`create-from-${pane}`);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.click();
  await expect(card).toHaveAttribute("aria-checked", "true");
}

/** The wizard, all three steps, for an agent with the default policy and the prompt given. */
async function deployAgent(page: Page, name: string, prompt?: string) {
  await page.goto("/create?kind=agent");
  await connectWallet(page);
  // The wizard is on screen from the start: an agent is created from blank, with no _Start from_.
  await page.getByPlaceholder("e.g. agent-sentinel-v2").fill(name);
  if (prompt) await page.getByTestId("agent-prompt").fill(prompt);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: 120_000 });
}

/* ------------------------------------------------------------------------------------------ */
/* 1. Blank — the wizard for an agent, the loop form for a loop                                 */
/* ------------------------------------------------------------------------------------------ */

test("the Blank pane opens the wizard for an agent and the empty loop form for a loop, with no lineage", async ({
  page,
}) => {
  test.setTimeout(3 * 60_000);

  // The agent flow. The blank wizard and nothing above it: an agent is always created from blank, so there is no _Start from_ (`create/page.tsx`).
  await page.goto("/create");
  await connectWallet(page);
  await expect(page.getByTestId("start-from")).toHaveCount(0);

  const name = page.getByPlaceholder("e.g. agent-sentinel-v2");
  await expect(name).toBeVisible();
  await expect(name).toHaveValue("");
  // The prompt field is empty on a blank start, which keeps the prompt key out of a blank deploy's
  // policy, so its `policy_version_hash` is byte for byte that of a policy without one.
  await expect(page.getByTestId("agent-prompt")).toHaveValue("");
  // No lineage: there is nothing to append a version to, so the review step has no sentence to
  // say and no fork to offer. The wizard will not leave step 1 without a name, so a
  // throwaway one is typed here; nothing is deployed.
  await name.fill(`e2e-builder-blank-${RUN}`);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
  await expect(page.getByTestId("lineage-line")).toHaveCount(0);
  await expect(page.getByTestId("lineage-fork")).toHaveCount(0);

  // The loop flow's _Existing agent_ is the loop form with nothing prefilled, on the first agent this
  // wallet owns (a loop starts on an agent that exists); _New_ is the wizard for the agent the
  // loop will run on, which this E2E wallet does not need.
  await page.goto("/create?loop=1");
  await connectWallet(page);
  await expect(page.getByTestId("start-from")).toBeVisible({ timeout: 60_000 });
  await pickPane(page, "agent");
  const form = page.getByTestId("loop-start-form");
  await expect(form.or(page.getByTestId("loop-no-agent"))).toBeVisible({ timeout: 60_000 });
  await expect(page.getByPlaceholder("e.g. agent-sentinel-v2")).toHaveCount(0);
  if (await form.count()) {
    // The one Goal field: empty.
    await expect(page.getByTestId("loop-goal-input")).toHaveValue("");
    await expect(page.getByTestId("loop-lineage")).toHaveCount(0);
  }
  // Deliberately not started: this case is about the form the picker opens, and a start here
  // would spend the treasury to assert nothing case 5 does not assert better.
});

/* ------------------------------------------------------------------------------------------ */
/* 2. Your assets — an agent, edited, deployed                                                 */
/* ------------------------------------------------------------------------------------------ */

test("starting from this wallet's own agent appends a version and deploys from it", async ({ page, request }) => {
  test.setTimeout(12 * 60_000);
  // The agent flow has no _Start from_ (an agent is always created from blank), so there is no pick
  // to make. Kept, skipped, for an agent flow that offers a pick; case 3 skips with it.
  test.skip(true, "agent creation is always blank: no Start from on the agent flow");

  // The fixture is deployed here rather than picked off devnet, because the case is about a
  // source whose template version is known at the moment of the pick — and every agent the
  // suite has left under this wallet shares a handful of templates that other files also append
  // to (`templates-lineage.spec.ts` writes versions of one of them).
  await deployAgent(page, SOURCE, `You watch this cluster and report only what moved. (${RUN})`);

  const source = await agentRecord(request, id(SOURCE));
  expect(source.owner, "the fixture is owned by the E2E wallet").toBe(e2eWallet());
  expect(source.template, "every deploy links to a template").not.toBeNull();
  const templateId = source.template!.id;
  // The picker appends to the template's *latest* version, not to the one this agent runs.
  const before = (await templateById(request, templateId)).latest;
  state.sourceTemplate = { id: templateId, name: before.name, version: before.version };

  // The pick, through the pane a person uses: the wallet's own agents, as tiles, resolved by the
  // `data-agent-id` handle the tile carries for exactly this.
  await page.goto("/create");
  await connectWallet(page);
  await pickPane(page, "agent");
  const tile = page.getByTestId("start-from-agents").locator(`[data-agent-id="${id(SOURCE)}"]`);
  await expect(tile.first()).toBeVisible({ timeout: PICKER_READY });
  // The agent's prompt comes from its template, whose texts the console sends in full to every
  // reader, so the pick needs no signature before it.
  await tile.first().click();

  // The draft the pick handed over: a free name (a deployed name is an id, and taken for good)
  // and the source's prompt, which is the field that makes configuring from an asset mean
  // anything.
  const name = page.getByPlaceholder("e.g. agent-sentinel-v2");
  await expect(name).toHaveValue(COPY, { timeout: 60_000 });
  await expect(page.getByTestId("agent-prompt")).toHaveValue(new RegExp(RUN));

  const edited = `You watch this cluster and report the fee level only. (${RUN})`;
  await page.getByTestId("agent-prompt").fill(edited);
  await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
  await page.getByRole("button", { name: "Review and deploy", exact: true }).click();

  // What the review step promises, in its own words — and the fork checkbox is present and off:
  // a deploy appends unless the owner forks.
  const expected = before.version + 1;
  const lineage = page.getByTestId("lineage-line");
  await expect(lineage).toBeVisible();
  await expect(lineage).toContainText(`appends v${expected} to`);
  await expect(lineage).toContainText(before.name);
  await expect(page.getByTestId("lineage-fork")).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  await expect(page.getByText("Agent deployed on Solana")).toBeVisible({ timeout: 120_000 });

  // What the server wrote: version n+1 of the *same* template, keeping the name its first agent
  // gave it, with the earlier version still readable beside it.
  const copy = await agentRecord(request, id(COPY));
  expect(copy.template!.id).toBe(templateId);
  expect(copy.template!.version).toBe(expected);
  expect(copy.template!.hash).not.toBe(before.hash);
  state.copyVersion = expected;

  const after = await templateById(request, templateId);
  expect(after.latest.version).toBe(expected);
  expect(after.latest.name).toBe(before.name);
  expect(after.versions.map((v) => v.version)).toContain(before.version);
  expect(after.versions.find((v) => v.version === before.version)!.hash).toBe(before.hash);
  // The prompt the wizard was edited with is what the new version carries; the old one is
  // untouched, which is the whole of "append, don't fork".
  expect((after.latest.config as { prompt?: string }).prompt).toBe(edited);

  // And the page says it: the Agent details ⓘ's _Deployed from_ row.
  await page.goto(`/agent/${id(COPY)}`);
  await openInfo(page.getByTestId("agent-details-toggle"), 120_000);
  const onPage = page.getByTestId("agent-template");
  await expect(onPage).toContainText(`v${expected}`, { timeout: 120_000 });
  await expect(onPage).toContainText(copy.templateName ?? templateId);
});

/* ------------------------------------------------------------------------------------------ */
/* 3. The chain half of the same claim                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * The `policy_version_hash` of the newest genesis on a chain, read off the page — the same read
 * `templates-lineage.spec.ts` makes, and for the same reason: what an agent *was* when it ran has
 * to come off the screen, not out of a recomputation. The drawer resolves the payload preimage
 * from the trace store and prints the hash at its fixed offset inside it; the console writes every
 * trace in the clear, so the drawer opens it with no signature.
 */
async function newestGenesisPolicyHash(page: Page, agentId: string, expected: number): Promise<string> {
  await page.goto(`/agent/${agentId}`);
  await connectWallet(page);
  // `.last()`: `EventTimeline` sorts ascending by seq, so `.first()` is the oldest genesis. The
  // timeline is inside the agent page's Proof.
  await openProof(page, "proof", 120_000);
  const rows = page.locator('[data-testid="timeline-record"][data-kind="Genesis"]');
  await expect(rows).toHaveCount(expected, { timeout: 120_000 });
  const genesis = rows.last();
  await expect(genesis).toBeVisible({ timeout: 120_000 });
  await genesis.getByRole("button", { name: /^Open$/ }).click();
  const commitment = page.getByTestId("commitment-policy-version");
  await expect(commitment).toBeVisible({ timeout: 60_000 });
  const hash = await commitment.getAttribute("data-hash");
  expect(hash, "the drawer prints the policy version hash the genesis committed").toMatch(/^[0-9a-f]{64}$/);
  return hash!;
}

/**
 * One session through the chat the console offers, after waiting for its single run slot: a file
 * run before this one can leave a loop step in flight, and a session sent then is refused with
 * 429.
 */
async function runSession(page: Page, agentId: string, ask: string) {
  await expect
    .poll(async () => (await (await page.request.get("/api/run")).json()).busy ?? null, {
      message: "the console's run slot frees before a session is sent",
      timeout: 120_000,
      intervals: [2_000, 5_000],
    })
    .toBeNull();
  // `#ask` opens the Ask card, which is folded by default.
  await page.goto(`/agent/${agentId}#ask`);
  await connectWallet(page);
  await page.getByTestId("chat-input").fill(ask);
  await page.getByTestId("chat-send").getByRole("button").click();
  const reply = page.getByTestId("chat-reply");
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(reply).not.toHaveText("thinking…", { timeout: 170_000 });
  await expect(page.getByTestId("anchor-badge").last()).toHaveAttribute("data-state", "verified", { timeout: 240_000 });
  await expect(reply).not.toBeEmpty();
}

test("the copy's genesis commits a different policy version hash from the source's", async ({ page }) => {
  test.setTimeout(14 * 60_000);
  test.skip(!state.copyVersion, "the deploy from an own asset did not run, so there are no two chains to compare");

  // The half of the lineage claim a spec can hold: the prompt moved between the source and the copy,
  // `policyVersionHash` takes a `promptHash` key, so the two chains cannot commit the same value
  // — and both values are read off the page rather than recomputed here.
  await runSession(page, id(SOURCE), "Report the cluster slot.");
  const sourceHash = await newestGenesisPolicyHash(page, id(SOURCE), 1);

  await runSession(page, id(COPY), "Report the cluster slot.");
  const copyHash = await newestGenesisPolicyHash(page, id(COPY), 1);

  expect(copyHash).not.toBe(sourceHash);
  // Nothing about either chain is harmed by sharing a template: each verifies on its own.
  await expect(page.getByTestId("chain-status")).toContainText(/verified on Solana/i, { timeout: 60_000 });
});

/* ------------------------------------------------------------------------------------------ */
/* 4. Your assets — a run, started again with a changed interval                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * A run this wallet can start again: not running, not archived, linked to a loop template, and on
 * an agent that has no running loop (one running loop per agent is what a start is refused for).
 *
 * Devnet holds plenty under the E2E wallet, so the common path is a read. When it holds none, the
 * fallback is `loop-run-again.spec.ts`'s own fixture sequence — deploy an agent, start a loop on
 * it from its page, let the first step land, pause, stop — which is minutes of wall clock and is why it is a fallback.
 */
async function startableRun(page: Page, request: APIRequestContext, wallet: string): Promise<LoopRow | null> {
  const all = await loops(request);
  const running = new Set(all.filter((l) => l.status === "running").map((l) => l.agentId));
  // The agent has to be one the console still lists for this wallet: `LoopEntry`'s select is fed
  // by the registry, so a run whose agent was archived since would open the form on a *different*
  // agent, and a start there would append the source's terms to a schedule on another chain.
  const listed = await request.get(`/api/agents?owner=${encodeURIComponent(wallet)}`);
  const live = new Set((((await listed.json()).agents ?? []) as { id: string }[]).map((a) => a.id.toLowerCase()));
  // And a run without sandbox sources: a start re-fetches them, and another run on this wallet may
  // read a mainnet address, which a host without LATH_MAINNET_RPC refuses — a refusal about the host, not about the append this case checks.
  const mine = all.filter(
    (l) =>
      l.owner === wallet &&
      !l.archivedAt &&
      l.template &&
      !l.sandbox?.sourcesHash &&
      !running.has(l.agentId) &&
      live.has(l.agentId)
  );
  // Newest first: a recent run is likelier to be on an agent the current registry still carries.
  const candidate = mine.sort((a, b) => b.createdAt - a.createdAt)[0];
  if (candidate) return candidate;

  // Deploy, then start the loop from the agent's page: the wizard deploys and nothing else, so the
  // fixture is two wallet prompts.
  await deployBlankAgent(page, LOOP_AGENT, connectWallet);
  const first = await startLoopFromAgentPage(page, id(LOOP_AGENT), {
    prompt: "Read the cluster and replay your own chain.",
    interval: "1 min",
    steps: "3",
  });

  // Pause before the second step is due, then stop — a paused loop schedules nothing while the
  // stop is signed. The step in flight when Stop lands still writes its checkpoint, so the
  // registry has to be quiet before the run is used as a source.
  await expect(stepRows(page)).toHaveCount(1, { timeout: 3 * 60_000 });
  await page.getByTestId("loop-pause").click();
  await expect(page.getByTestId("loop-resume")).toBeVisible();
  await page.getByTestId("loop-stop").click();
  // A stopped run offers no Stop at all.
  await expect(page.getByTestId("loop-stop")).toHaveCount(0);
  await expect
    .poll(async () => (await loopById(request, first)).stepping, { timeout: 3 * 60_000, intervals: [3_000] })
    .toBe(false);
  const started = await loopById(request, first);
  return started.template ? started : null;
}

/** Stop a run this file started, so the treasury is not paying for a schedule nobody reads. */
async function stopRun(page: Page, loopId: string) {
  await page.goto(`/loop/${loopId}`);
  await connectWallet(page);
  await page.getByTestId("loop-pause").click();
  await expect(page.getByTestId("loop-resume")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("loop-stop").click();
  await expect(page.getByTestId("loop-stop")).toHaveCount(0, { timeout: 60_000 });
}

test("starting from a run this wallet owns appends a loop-template version with the edited terms", async ({
  page,
  request,
}) => {
  test.setTimeout(16 * 60_000);
  const wallet = e2eWallet();
  test.skip(!wallet, `no E2E wallet secret in ${E2E_ENV}; seed with --e2e-wallet`);

  const source = await startableRun(page, request, wallet!);
  test.skip(
    !source,
    "this wallet has no run that can be started again and none could be deployed for it, so there is nothing to edit"
  );
  const templateId = source!.template!.id;
  // Again the *latest* version, which is what the picker resolves and what the start appends to.
  const before = (await templateById(request, templateId)).latest;
  const coordinator = (before.config as { coordinator?: { agentId?: string } }).coordinator?.agentId;

  await page.goto("/create?loop=1");
  await connectWallet(page);
  await pickPane(page, "loop");
  const tile = page.getByTestId("start-from-loops").locator(`[data-loop-id="${source!.id}"]`);
  await expect(tile.first()).toBeVisible({ timeout: PICKER_READY });
  // A run's instruction comes with the row to every reader, so the pick needs no signature first.
  await tile.first().click();

  // The terms arrive in the form, still editable — *run again with edits* is the point — and the
  // lineage sentence says what the start will write before anything is signed.
  const form = page.getByTestId("loop-start-form");
  await expect(form).toBeVisible({ timeout: 60_000 });
  // The pick names the agent the schedule goes back on, which is the select `LoopEntry` asks with:
  // a run again runs on the agent that ran it.
  await expect(page.getByTestId("loop-agent-select")).toHaveValue(source!.agentId);
  await expect(page.getByTestId("loop-lineage")).toContainText(`v${before.version + 1}`);

  // The one edit: a different interval, which is what makes this an append rather than a re-run
  // of the stored version (`appendOrMint` writes nothing when the config hashes the same).
  // The form offers 10 s, 1 min and 5 min; a source on another cadence snaps to one.
  const other = source!.intervalMs === 5 * 60_000 ? "1 min" : "5 min";
  await page.getByRole("button", { name: other, exact: true }).click();

  const started = page.waitForResponse((r) => r.url().includes("/api/loops") && r.request().method() === "POST");
  await page.getByTestId("loop-start").click();
  // Streamed: the HTTP status goes before the start is decided, so the answer is the last event's.
  const answer = await (await started).text();
  expect(answer, "the start was accepted").toMatch(/event: result\ndata: \{"status":200,/);
  // A start from _New loop_ goes to the loop's page itself rather than stopping on a link.
  await expect(page).toHaveURL(/\/loop\/loop-/, { timeout: 60_000 });

  // The run the start made, found by the agent it runs on: a start is one signed message, and
  // the record it wrote is what carries the lineage.
  const mine = (await loops(request, `?owner=${encodeURIComponent(wallet!)}`)).filter(
    (l) => l.agentId === source!.agentId && l.createdAt > source!.createdAt
  );
  const fresh = mine.sort((a, b) => b.createdAt - a.createdAt)[0];
  expect(fresh, "the start left a run on the source's agent").toBeTruthy();
  expect(fresh.template!.id).toBe(templateId);
  expect(fresh.template!.version).toBe(before.version + 1);
  expect(fresh.intervalMs).toBe(other === "1 min" ? 60_000 : 5 * 60_000);

  // The version that was appended: the edited terms, the template's own name, and the same
  // coordinator — a run again is the same agent on new terms, never a schedule moved to another
  // chain.
  const after = await templateById(request, templateId);
  expect(after.latest.version).toBe(before.version + 1);
  expect(after.latest.name).toBe(before.name);
  expect((after.latest.config as { coordinator?: { agentId?: string } }).coordinator?.agentId).toBe(
    coordinator ?? source!.agentId
  );
  expect((after.latest.config as { intervalMs?: number }).intervalMs).toBe(fresh.intervalMs);
  expect(after.versions.map((v) => v.version)).toContain(before.version);

  // Stopped rather than left running: the first step fires at once, and every step after it is
  // treasury money spent on a run this file has already read what it needed from.
  await stopRun(page, fresh.id);
});

/* ------------------------------------------------------------------------------------------ */
/* 5. A name the console already holds — refused for another wallet, stated for the owner     */
/* ------------------------------------------------------------------------------------------ */

/**
 * The `existing` answer to a deploy. The server answers it for a name it holds, whoever holds it,
 * and a wizard that read it as a deploy of its own would show *Agent deployed on Solana*,
 * confirmed, over another wallet's agent, with this form's prompt, policy and cap dropped.
 *
 * Step 1 disables a taken name, so the branch is reached only when the name check errors (common
 * on devnet), on a race, or by a direct call. Reaching it here by making the name check fail
 * would mean failing the page's Photon reads, which every other read on the page shares, so the
 * prepare answer itself is fulfilled instead: a fresh name passes step 1, and the route answers
 * as it does for a held name. Nothing is signed and nothing is written — what is under test is
 * the wizard's reading of the answer. The server's half, a 409 for another wallet's name, is
 * `tests/console-agents.ts`'s.
 */
test("an existing name owned by another wallet is refused, and the owner's own is not called a deploy", async ({
  page,
}) => {
  test.setTimeout(3 * 60_000);
  const wallet = e2eWallet();
  test.skip(!wallet, `no E2E wallet in ${E2E_ENV}: run the seed with --e2e-wallet`);
  const name = `e2e-builder-held-${RUN}`;
  const other = Keypair.generate().publicKey.toBase58();

  let owner = other;
  await page.route("**/api/agents", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (route.request().method() !== "POST" || !body.prepare) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: id(name), name, authority: other, signature: null, existing: true, owner }),
    });
  });

  const review = async () => {
    await page.goto("/create?kind=agent");
    await connectWallet(page);
    await page.getByPlaceholder("e.g. agent-sentinel-v2").fill(name);
    await page.getByRole("button", { name: "Budget and policy", exact: true }).click();
    await page.getByRole("button", { name: "Review and deploy", exact: true }).click();
    await page.getByRole("button", { name: /^Deploy agent$/ }).click();
  };

  // Another wallet's name: a refusal, and no success card.
  await review();
  await expect(page.getByText(/already registered by another wallet/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Agent deployed on Solana")).toHaveCount(0);

  // The same name answered as this wallet's: a neutral note, and no confirmed badge.
  owner = wallet!;
  await review();
  await expect(page.getByTestId("deploy-already-yours")).toContainText(`You already have an agent called ${name}`, {
    timeout: 60_000,
  });
  await expect(page.getByText("Agent deployed on Solana")).toHaveCount(0);
  await expect(page.getByText("confirmed", { exact: true })).toHaveCount(0);
});
