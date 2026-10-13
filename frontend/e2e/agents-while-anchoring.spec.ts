import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

/**
 * The read surfaces hold while a writer queue is still in flight.
 *
 * What it proves. A session answers before its records are confirmed (`console.spec.ts`, case 2),
 * so between the answer and the drain there is a window in which the console's journal knows a
 * higher tip than the chain does. Two claims are checked inside that window:
 *
 *   1. the owner list still reads — `/agents` redirects to the workspace (`/`),
 *      the wallet's rows render in its Yours list, and nothing throws in the page;
 *   2. the seq the agent header's badge verified to (`data-seq`) is the chain's number, never the journal's.
 *
 * The second is the one a provenance badge on this header leans on: such a badge must read the
 * chain the way this header already does, so a spec that pins the property is what keeps a change
 * to the header checkable.
 *
 * Why two pages. The window only exists while one session is anchoring, and a reader looking at
 * the list or the header is a *different* tab — the same tab would be the one holding the stream,
 * and its header is re-rendered by the session it is running. Page A drives the session; page B
 * is the reader, and connects the E2E wallet because the owner list on `/` is that wallet's.
 *
 * Why two contexts. Page A starts in a context in which no wallet has been chosen, so it sees the
 * wallet gate every page sits behind; A first checks the gate, then connects the E2E wallet like B
 * does. `sessionSpend` refuses a signed session with no live allowance with a 402, so the chat signs
 * only for the agent's owner or a wallet with a live allowance to its authority (`AgentChat.tsx`);
 * the target is console-owned and the E2E wallet has neither, so A's session is the anonymous one
 * (`chat-anon-note` says so). A keeps a context of its own so its stream and B's reads stay two
 * independent tabs.
 *
 * A's session is therefore scripted and unbilled, even though the suite runs against a Tempo
 * treasury (`scripts/dev-devnet.sh --e2e`): the rail pays for a signed owner's calls, and
 * an anonymous session has no allowance to charge. This file spends nothing on either chain
 * beyond the records it writes.
 *
 * Which badge state. `AnchorState` is `pending | verified | failed` (`lib/console-stream.tsx`) —
 * there is no `anchoring` state; *anchoring v/t* is the **text** `anchorLabel` gives `pending`.
 * So the wait is on `data-state="pending"`, which is also the state that is easy to catch: it is
 * set as soon as the first record is journaled, i.e. before the answer, and on devnet it holds
 * for the whole drain. Waiting for the answer instead would have been the weaker of the two.
 *
 * What the header is compared against, and why that is the chain and not the journal:
 *   - N0, the header's seq read on B *before* the session — the chain's baseline;
 *   - N2, the header's seq read on B after A's badge turns `verified` — the chain, drained;
 *   - and `session:answer.seq` from A's own SSE, which is documented as "the seq the record
 *     *will* have" — the journaled, unconfirmed tip. `commit_epoch` sets `state.seq = end_seq`
 *     (programs/lath/src/lib.rs) and every other write appends one, so the chain's seq can
 *     never run past that tip. N1 ≤ answer.seq is therefore exactly the claim: the header did
 *     not render the local tip.
 *
 * Serial, like everything else through this console: the session holds its one run slot.
 * Run: PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test e2e/agents-while-anchoring.spec.ts --workers=1 --timeout=240000
 */

/** `event: x\ndata: {...}` blocks, in order. Same reader `console.spec.ts` uses. */
function frames(sse: string): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = [];
  for (const block of sse.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(block)?.[1]?.trim();
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event && data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

/**
 * `autoConnect` only reconnects a wallet the browser has already chosen, so the first connection
 * in a fresh context goes through the real modal. The list on `/` is
 * the wallet's own agents, so page B has to be connected before there is anything to render.
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
  // The page mounts only once the gate lifts, and the modal's own heading lingers while it fades.
  await expect(page.getByTestId("wallet-gate")).toHaveCount(0);
  await expect(page.locator(".wallet-adapter-modal")).toHaveCount(0, { timeout: 15_000 });
}

/**
 * The header's own number, once it has resolved. The badge reads _verified on Solana_ and carries the seq it verified to as `data-seq` (and in its hover, `chain verified to seq N`).
 */
async function headerSeq(page: Page, timeout = 90_000): Promise<number> {
  const status = page.getByTestId("chain-status");
  await expect(status).toContainText(/verified on Solana/i, { timeout });
  const seq = await status.locator("[data-seq]").getAttribute("data-seq");
  expect(seq, `the header says which seq it verified to, not "${(await status.innerText()).trim()}"`).toBeTruthy();
  return Number(seq);
}

/** Page A's own context, closed after the case whether it passed or not. */
let anonymous: BrowserContext | undefined;
test.afterEach(async () => {
  await anonymous?.close();
  anonymous = undefined;
});

/**
 * Waits for the console's single run slot to be free. A loop step or a session left in flight by
 * an earlier file (`templates-api.spec.ts` case 5 starts a loop and archives it, but its first
 * step still runs to the end) holds the slot for tens of seconds, and a session sent into that
 * window is refused with 429 "another run is in progress" — a failure of ordering, not of the
 * claim under test.
 */
async function waitForRunSlot(request: APIRequestContext) {
  await expect
    .poll(async () => (await (await request.get("/api/run")).json()).busy ?? null, {
      message: "the console's run slot frees before a session is sent",
      timeout: 120_000,
      intervals: [2_000, 5_000],
    })
    .toBeNull();
}

test("the list and the header read the chain while a session is still anchoring", async ({
  page,
  browser,
  baseURL,
  request,
}) => {
  test.setTimeout(360_000);

  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  const agent = runner.agents?.find((a: any) => a.role === "agent");
  expect(agent, "the runtime names an agent it writes").toBeTruthy();

  // Uncaught exceptions on either page are failures, except React's hydration warning — the dev
  // server can serve a client chunk compiled against a different `NEXT_PUBLIC_CLUSTER` than the
  // one it renders with, which has nothing to do with what this test reads (`console.spec.ts`).
  const crashes: string[] = [];
  const watch = (p: Page, label: string) =>
    p.on("pageerror", (e) => {
      if (!/hydrat/i.test(e.message)) crashes.push(`${label}: ${e.message}`);
    });

  // B is the fixture's page, in the context whose wallet it connects. A gets a context of its
  // own (see "Why two contexts" above).
  // `browser.newContext()` does not inherit the config's `use`, hence the explicit `baseURL`.
  anonymous = await browser.newContext({ baseURL });
  const a = await anonymous.newPage();
  const b = page;
  watch(a, "page A (the session)");
  watch(b, "page B (the reader)");

  // The chain's baseline, read before anything is journaled. B connects here so the wallet is
  // already chosen when it comes back to `/` mid-session — a modal click then would be the test
  // racing the session rather than reading it. A console started under a fresh tag has an agent
  // with no chain at all until its first session registers it, and the page says so instead of
  // rendering a header; that baseline is seq 0, not a failure.
  await b.goto(`/agent/${agent.id}`);
  await connectWallet(b);
  const unregistered = b.getByText(/not yet on chain/i);
  await expect(unregistered.or(b.getByTestId("chain-status"))).toBeVisible({ timeout: 90_000 });
  const n0 = (await unregistered.count()) > 0 ? 0 : await headerSeq(b);

  // A drives the session. The SSE body is buffered on its way to the page, unchanged, so the
  // journaled tip can be read back from the server's own stream after the drain.
  const streamed = new Promise<string>((resolve) => {
    a.on("response", (res) => {
      if (res.request().method() === "POST" && res.url().includes("/api/run")) void res.text().then(resolve);
    });
  });

  await waitForRunSlot(request);
  // `#ask` opens the Ask card, which is folded by default.
  await a.goto(`/agent/${agent.id}#ask`);
  // With no wallet chosen the page is the gate and nothing of the agent's; the coverage of a
  // connected non-owner *not* reading the owner's texts needs a second test wallet, which the
  // suite does not have.
  await expect(a.getByTestId("wallet-gate")).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId("chat-input")).toHaveCount(0);
  await connectWallet(a);
  // The E2E wallet neither owns this console agent nor holds an allowance to it, so the chat runs
  // the anonymous session with no signature, and says how to run it on a real model.
  await expect(a.getByTestId("chat-anon-note")).toBeVisible({ timeout: 60_000 });
  await a.getByTestId("chat-input").fill("Report the cluster slot.");
  await a.getByTestId("chat-send").getByRole("button").click();

  const badge = a.getByTestId("anchor-badge");
  await expect(badge).toHaveAttribute("data-state", "pending", { timeout: 170_000 });
  await expect(badge).toContainText(/anchoring \d+\/\d+/);

  // 1. The list, mid-flight. `/agents` is what is opened, and it redirects to the workspace,
  //    whose Yours list (`owners-spine`) is the wallet's
  //    agents, each an `owner-row` with its id.
  await b.goto("/agents");
  await expect(b).toHaveURL(/\/$/);
  await expect(b.getByTestId("workspace-yours")).toBeVisible({ timeout: 60_000 });
  const rows = b.getByTestId("owners-spine").getByTestId("owner-row");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  expect(await rows.count(), "the wallet's agents rendered while the queue was draining").toBeGreaterThan(0);
  for (const id of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-agent-id"))))
    expect(id, "every row names the agent it stands for").toMatch(/^[0-9a-f]{64}$/i);

  // 2. The header, mid-flight. Read first, then confirm the queue had not finished — in that
  //    order, so a drain that lands between the two reads cannot turn a correct number into a
  //    failure. `still` is informational: what it guards is the *interpretation* of n1.
  await b.goto(`/agent/${agent.id}`);
  const n1 = await headerSeq(b);
  const still = await badge.getAttribute("data-state");

  expect(n1, "the header never reads behind the chain's baseline").toBeGreaterThanOrEqual(n0);

  // 3. The drain, and the same header afterwards.
  await expect(badge).toHaveAttribute("data-state", "verified", { timeout: 170_000 });
  await expect(badge).toContainText("verified to seq");

  const answer = frames(await streamed).find((f) => f.event === "session:answer")?.data;
  expect(answer, "the session answered").toBeTruthy();
  if (answer.seq !== null) {
    // The journal's tip. If n1 had come from the journal it could equal this while records were
    // still unconfirmed; coming from the chain it cannot exceed it, because no write raises seq
    // past the last record journaled (`commit_epoch` sets seq = end_seq, it does not add to it).
    expect(
      n1,
      `the header showed the chain (${n1}), not the journaled tip (${answer.seq}); badge was ${still}`
    ).toBeLessThanOrEqual(Number(answer.seq));
  }

  await b.reload();
  const n2 = await headerSeq(b);
  expect(n2, "the header caught up once the queue drained").toBeGreaterThanOrEqual(n1);
  expect(n2, "the session did write to this chain").toBeGreaterThan(n0);

  expect(crashes, "nothing threw in either page").toEqual([]);
});
