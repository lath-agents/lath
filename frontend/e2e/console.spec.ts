import { expect, test } from "@playwright/test";
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
 * The console's budget and signals, driven through a real session.
 *
 * One anonymous session — scripted inference, unbilled, and a real chain — run from the browser
 * against the agent this server writes by default. The E2E wallet is connected (the pages are
 * gated) but neither owns that agent nor holds an allowance to it, so the chat does not sign the
 * session. The SSE stream is teed on its way to the page, so the test can hold the server's own numbers next to the ones the page rendered
 * and check they are the same number rather than two plausible ones.
 */

interface Frame {
  event: string;
  data: any;
}

/** `event: x\ndata: {...}` blocks, in order. */
function frames(sse: string): Frame[] {
  const out: Frame[] = [];
  for (const block of sse.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(block)?.[1]?.trim();
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event && data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

test("a session prints its epoch trigger, the signals it sampled and the fees it paid", async ({ page, request }) => {
  test.setTimeout(180_000);

  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  const agent = runner.agents?.find((a: any) => a.role === "agent");
  expect(agent, "the runtime names an agent it writes").toBeTruthy();

  // Read the session's own stream alongside the page: the page streams it as it always does,
  // and the body is buffered here so the test can compare the server's numbers with the
  // rendered ones. Nothing about the request is changed.
  const streamed = new Promise<string>((resolve) => {
    page.on("response", (res) => {
      if (res.request().method() === "POST" && res.url().includes("/api/run")) void res.text().then(resolve);
    });
  });

  // Any uncaught exception is a failure, except React's hydration warning: the dev server can
  // serve a client chunk compiled against a different `NEXT_PUBLIC_CLUSTER` than the one it
  // renders with, which has nothing to do with the numbers this test is about.
  // `read-path.spec.ts` keeps the strict no-page-errors property.
  const crashes: string[] = [];
  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) crashes.push(e.message);
  });

  // `#ask` opens the Ask card, which is folded by default.
  await page.goto(`/agent/${agent.id}#ask`);
  // The E2E wallet neither owns the console's demo agent nor holds an allowance to it, so the chat
  // runs the anonymous session with no signature, and says how to run it on a real model.
  await expect(page.getByTestId("chat-anon-note")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("chat-input").fill("Report the cluster slot and fee level, then verify your own chain.");
  await page.getByTestId("chat-send").getByRole("button").click();

  // The reply lands when the session resolved; everything below is that session's own numbers.
  // The bubble says "thinking…" until there is text, and the text now arrives before the writes
  // do — so the numbers this test compares are read after `session:done`, not after the reply.
  await expect(page.getByTestId("chat-reply")).not.toContainText("thinking…", { timeout: 170_000 });
  await page.getByTestId("chat-details").click();
  await expect(page.getByTestId("fees-paid")).toBeVisible({ timeout: 170_000 });

  const sse = await streamed;
  const init = frames(sse).find((f) => f.event === "session:init")!.data;
  const done = frames(sse).find((f) => f.event === "session:done")!.data;
  const epochs = frames(sse).filter((f) => f.event === "runtime" && f.data.type === "epoch");

  // 1. The stream carries what the batcher sampled and why each epoch closed.
  expect(init.signals.priorityFeeMicroLamports, "a fee estimate was sampled at session start").toBeGreaterThanOrEqual(
    0
  );
  expect(init.signals.payerBalanceLamports).toBeGreaterThan(0);
  expect(init.startLamports).toBeGreaterThan(0);
  expect(epochs.length, "the session committed at least one epoch").toBeGreaterThan(0);
  for (const e of epochs) expect(["count", "time", "fee", "manual"]).toContain(e.data.trigger);

  // 2. The fee stat is the payer's balance delta, and it is the server's own number.
  const balanceReads = frames(sse).filter((f) => f.event === "session:fees");
  expect(balanceReads.length, "the payer's balance was read after a confirmed write").toBeGreaterThan(0);
  for (const r of balanceReads) expect(r.data.lamportsSpent).toBe(r.data.startLamports - r.data.lamports);
  // The acceptance check: the fee number is the payer's balance either side of the session.
  expect(done.startLamports).toBe(init.startLamports);
  expect(done.lamportsSpent).toBe(done.startLamports - done.endLamports);
  expect(done.lamportsSpent).toBeGreaterThan(0);

  // 3. The page shows the same numbers, in words that say where they came from.
  await expect(page.getByTestId("epoch-trigger").first()).toContainText(
    /flushed: (batch full|fee at floor|timer|milestone)/
  );
  await expect(page.getByTestId("epoch-trigger").first()).toHaveAttribute("data-trigger", epochs[0].data.trigger);

  await expect(page.getByTestId("session-signals")).toContainText("sampled from the cluster at session start");
  const digits = async (id: string) => (await page.getByTestId(id).innerText()).replace(/[^0-9]/g, "");
  expect(await digits("signal-fee")).toBe(String(init.signals.priorityFeeMicroLamports));
  expect(await digits("signal-balance")).toBe(String(init.signals.payerBalanceLamports));

  const fees = page.getByTestId("fees-paid");
  await expect(fees).toHaveAttribute("data-lamports", String(done.lamportsSpent));
  await expect(fees).toContainText(`${(done.lamportsSpent / 1e9).toFixed(6)} SOL`);
  await expect(fees).toContainText("balance delta, measured");

  expect(crashes, "nothing threw in the page").toEqual([]);
});

/**
 * Answer first, chain after.
 *
 * The claim being tested is an ordering: the reply is in the stream before any of the records it
 * describes have been confirmed, and the badge beside the message then follows the writer queue
 * from `pending` to `verified`. The audit runs after the drain, so it still replays a whole chain.
 */
test("the answer arrives before the chain does, and the badge follows the writer queue", async ({ page, request }) => {
  test.setTimeout(240_000);

  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  const agent = runner.agents?.find((a: any) => a.role === "agent");
  expect(agent, "the runtime names an agent it writes").toBeTruthy();

  const streamed = new Promise<string>((resolve) => {
    page.on("response", (res) => {
      if (res.request().method() === "POST" && res.url().includes("/api/run")) void res.text().then(resolve);
    });
  });

  // `#ask` opens the Ask card, which is folded by default.
  await page.goto(`/agent/${agent.id}#ask`);
  // The E2E wallet neither owns the console's demo agent nor holds an allowance to it, so the chat
  // runs the anonymous session with no signature, and says how to run it on a real model.
  await expect(page.getByTestId("chat-anon-note")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("chat-input").fill("Report the cluster slot, then verify your own chain.");
  await page.getByTestId("chat-send").getByRole("button").click();

  // The reply lands when the resolution is journaled — not when it is confirmed.
  await expect(page.getByTestId("chat-reply")).not.toContainText("thinking…", { timeout: 170_000 });
  // …and the badge is already there, saying how much of the message is on chain.
  await expect(page.getByTestId("anchor-badge")).toBeVisible();

  const sse = await streamed;
  const f = frames(sse);
  const at = (pred: (x: Frame) => boolean) => f.findIndex(pred);

  const answer = at((x) => x.event === "session:answer");
  const done = at((x) => x.event === "session:done");
  expect(answer, "the session answered").toBeGreaterThanOrEqual(0);
  expect(answer, "the answer precedes the closing summary").toBeLessThan(done);
  expect(f[answer].data.output.length, "the answer carries the session's output").toBeGreaterThan(0);

  // Nothing this session wrote had landed when it answered: a journaled record's signature is
  // empty, and the first real signature belongs to an anchor transition after the answer.
  const firstConfirmed = at(
    (x) => x.event === "runtime" && typeof x.data.signature === "string" && x.data.signature.length > 0
  );
  expect(firstConfirmed, "a record was confirmed").toBeGreaterThanOrEqual(0);
  expect(answer, "the answer came before the first confirmation").toBeLessThan(firstConfirmed);

  // Tokens only exist with a real model key; an anonymous session runs the scripted transport.
  const firstToken = at((x) => x.event === "session:token");
  if (firstToken >= 0)
    expect(firstToken, "the first token preceded the first confirmation").toBeLessThan(firstConfirmed);

  // The queue's transitions, and what it left behind.
  const anchors = f.filter((x) => x.event === "runtime" && x.data.type === "anchor");
  expect(anchors.length, "the writer queue reported its work").toBeGreaterThan(0);
  const summary = f[done].data.anchor;
  expect(summary, "the closing summary says what the queue left").toBeTruthy();
  expect(summary.pending, "nothing was left pending").toBe(0);
  expect(summary.failed, "nothing failed to anchor").toBe(0);
  expect(f[done].data.anchorError ?? null).toBeNull();

  // The audit is the real one and it ran after the drain, so it replayed the whole chain.
  const audit = f.find((x) => x.event === "session:audit")!;
  expect(audit.data.report.ok, "the chain this session wrote verifies").toBe(true);
  expect(
    at((x) => x.event === "session:audit"),
    "the audit follows the answer"
  ).toBeGreaterThan(answer);

  const badge = page.getByTestId("anchor-badge");
  await expect(badge).toHaveAttribute("data-state", "verified", { timeout: 170_000 });
  await expect(badge).toContainText("verified to seq");
});

/**
 * The `FAILED` badge and its retry, walked without waiting for devnet to break: the app is
 * started with `LATH_ANCHOR_FAIL=1` (`--e2e` only, `frontend/src/app/api/_lib/anchor.ts`),
 * which refuses the first entry's whole attempt budget on purpose. Skipped otherwise, because a
 * normal run has nothing to retry.
 */
test("a write that will not land says so, and the badge writes it again", async ({ page, request }) => {
  test.setTimeout(240_000);
  test.skip(!process.env.LATH_ANCHOR_FAIL, "run the app with LATH_ANCHOR_FAIL=1 --e2e to walk the FAILED path");

  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  const agent = runner.agents?.find((a: any) => a.role === "agent");

  // `#ask` opens the Ask card, which is folded by default.
  await page.goto(`/agent/${agent.id}#ask`);
  // The E2E wallet neither owns the console's demo agent nor holds an allowance to it, so the chat
  // runs the anonymous session with no signature, and says how to run it on a real model.
  await expect(page.getByTestId("chat-anon-note")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("chat-input").fill("Report the cluster slot.");
  await page.getByTestId("chat-send").getByRole("button").click();

  // The answer is given even though the write is refused: that is the whole claim of the state.
  await expect(page.getByTestId("chat-reply")).not.toContainText("thinking…", { timeout: 170_000 });
  const badge = page.getByTestId("anchor-badge");
  await expect(badge).toHaveAttribute("data-state", "failed", { timeout: 170_000 });
  await expect(badge).toContainText("not anchored");
  // And it says what failed, in the words that keep it honest.
  await expect(page.getByTestId("anchor-failed-note")).toContainText("The blockchain write failed");
  await expect(page.getByTestId("anchor-failed-note")).toContainText("The answer above");

  // The seal is a chain write too, so it did not happen — and the log says *that* rather than
  // `sealing: n blobs`, which would be untrue on exactly this path.
  // The log is behind *details*, so a reader who wants it opens it; so does this.
  await page.getByTestId("chat-details").click();
  const log = page.getByTestId("console-line");
  await expect(log.filter({ hasText: "not sealed:" })).toHaveCount(1, { timeout: 170_000 });
  await expect(log.filter({ hasText: "sealing:" })).toHaveCount(0);

  // The badge is a button, and not before the session's own stream has closed: until then the
  // session still holds the run slot and a retry sent then is refused as a run in progress.
  const retry = page.getByTestId("anchor-retry");
  await expect(retry).toHaveAttribute("title", /Re-queue this message's records/);
  await expect(retry).toBeEnabled({ timeout: 170_000 });

  // The click re-queues the same records; the fault budget is spent, so they land.
  await retry.click();
  await expect(badge).toHaveAttribute("data-state", "verified", { timeout: 170_000 });
  await expect(badge).toContainText("verified to seq");

  // And the retry pays the seal this message left owed, in the same log. The badge turns green
  // when the records verify, which is one event before the seal, so this waits past it.
  await expect(log.filter({ hasText: "retrying:" })).toHaveCount(1, { timeout: 170_000 });
  await expect(log.filter({ hasText: "this message left owed" })).toHaveCount(1, { timeout: 170_000 });
});
