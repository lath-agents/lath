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
 * A reloaded agent page shows the sessions its chain already answered.
 *
 * A transcript held in React state alone would empty on a reload, and the page would say "Nothing
 * asked yet" directly above an Events card listing the records of every session it had run. The
 * conversation is rebuilt from the traces instead: a session's question is the
 * input payload its Genesis commits to and its answer is the final output its Resolution commits
 * to, each re-hashed against the chain's hash before it is drawn (`lib/traces.ts`).
 *
 * One anonymous session on the agent this server writes by default — scripted inference, unbilled,
 * a real chain — because the claim is about what a *reload* can rebuild, not about who paid.
 */

test("a reload rebuilds the conversation from the chain, not from the tab", async ({ page, request }) => {
  test.setTimeout(11 * 60_000);

  const runner = await (await request.get("/api/run")).json();
  test.skip(!runner.ready, `the server cannot run sessions: ${runner.reason}`);
  const agent = runner.agents?.find((a: any) => a.role === "agent");
  expect(agent, "the runtime names an agent it writes").toBeTruthy();

  page.on("pageerror", (e) => {
    if (!/hydrat/i.test(e.message)) throw new Error(`uncaught in page: ${e.message}`);
  });

  // A session and a loop step share this server's one run slot (`runSlotHolder`, read back as
  // `GET /api/run`'s `busy`). In a full run a file before this one can leave a loop
  // stepping a minute apart, and a session that answered keeps the slot while its writes land, so a
  // send in either window is answered "another run is in progress" and the transcript never anchors.
  // Wait until no loop is running and the slot is free before asking.
  await expect
    .poll(
      async () => {
        const loops = ((await (await request.get("/api/loops")).json()).loops ?? []) as {
          status: string;
          stepping?: boolean;
        }[];
        const running = loops.filter((l) => l.status === "running" || l.stepping).length;
        const busy = (await (await request.get("/api/run")).json()).busy ?? null;
        return running === 0 && busy === null;
      },
      { timeout: 5 * 60_000, intervals: [10_000] }
    )
    .toBe(true);

  const asked = "Report the cluster slot and fee level, then verify your own chain.";
  // `#ask` opens the Ask card, which is folded by default.
  await page.goto(`/agent/${agent.id}#ask`);
  // The E2E wallet neither owns the console's demo agent nor holds an allowance to it, so the chat
  // runs the anonymous session with no signature, and says how to run it on a real model.
  await expect(page.getByTestId("chat-anon-note")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("chat-input").fill(asked);
  await page.getByTestId("chat-send").getByRole("button").click();

  // The answer arrives before the writes do, and the records this test reads back are written
  // after it — so wait for the session to be done, not merely answered.
  await expect(page.getByTestId("chat-transcript")).toContainText(/anchored|verified to seq/i, { timeout: 4 * 60_000 });

  // The reload: everything the tab remembered is gone, and what comes back came from the chain.
  await page.reload();
  const past = page.getByTestId("past-exchange");
  await expect(past.first()).toBeVisible({ timeout: 3 * 60_000 });

  // The question is a leaf of the Genesis, so it is the one turn whose text this test knows
  // exactly. A blob this deployment cannot read says so in its own row rather than going missing,
  // which is the state the assertion below would otherwise silently accept.
  const last = past.last();
  await expect(last.getByTestId("past-asked")).toBeVisible();
  await expect(last.getByTestId("past-answered")).toBeVisible();
  const askedRow = last.getByTestId("past-asked");
  // The row says *reading the trace…* while its blob is fetched and re-hashed; read it once that
  // settles, or the check below races a devnet read.
  await expect(askedRow).not.toContainText("reading the trace", { timeout: 2 * 60_000 });
  const text = await askedRow.innerText();
  expect(
    text.includes(asked) || /No locator on chain/.test(text),
    `the asked row says what it read, or why it could not: ${text.slice(0, 200)}`
  ).toBe(true);

  // And the empty-state sentence is gone, because this chain has been asked something.
  await expect(page.getByText("Nothing asked yet")).toHaveCount(0);
});
