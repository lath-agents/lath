/**
 * What a loop's Jev calls cost and when they may be made: `decideWithin`'s deadline and the voucher it
 * keeps, what a paid Jev call adds to the loop's Jev spend, and the money bounds read from the
 * environment.
 *
 * The gated loop's runtime (`LoopGate`, the watch readers, the console's tick and its paid-ask
 * ceiling) is on the roadmap and not in this build. The cases here are the ones every verify
 * decision and goal check runs through.
 *
 * Node-only: no validator, no RPC, no key, and nothing that can spend money.
 */
import "./fixtures/trace-dir";
import { assert } from "chai";
import { decideWithin } from "../runtime/src/decide";
import { PaidCallFailed, type DecideRequest, type DecideResult, type TempoPayment } from "../runtime/src/openrouter";
import {
  JEV_BUDGET_SPENT,
  JEV_BUDGET_SPENT_DETAIL,
  JEV_BUDGET_UNREADABLE,
  boundedEnvNumber,
  jevMeteredTransport,
  loopNoAnswer,
  meterJevCall,
  readLoop,
  stepGoalCheckView,
  stepVerifyView,
  updateLoop,
  recordLoop,
  type LoopRecord,
} from "../frontend/src/app/api/_lib/loops";

const T0 = 1_758_700_000_000;

const PAYMENT = (before: number, after: number): TempoPayment => ({
  rail: "tempo",
  chainId: 4217,
  payer: "0x18fB000000000000000000000000000000000e0B",
  channelId: `0x${"aa".repeat(32)}`,
  cumulativeBefore: String(before),
  cumulativeAfter: String(after),
});

describe("decideWithin: what a timeout says about the voucher", () => {
  const req: DecideRequest = { model: "m", state: "s", questions: {} };
  const onAbort = (settle: (resolve: (r: DecideResult) => void, reject: (e: unknown) => void) => void) => ({
    decide: (_: DecideRequest, opts?: { signal?: AbortSignal }) =>
      new Promise<DecideResult>((resolve, reject) =>
        opts?.signal?.addEventListener("abort", () => settle(resolve, reject))
      ),
  });

  it("a call aborted after it was paid rejects with PaidCallFailed under the deadline's message", async () => {
    const d = onAbort((_, reject) => reject(new PaidCallFailed("aborted", PAYMENT(10, 52), 499)));
    const e = await decideWithin(d, req, 10, 1_000).then(
      () => assert.fail("resolved"),
      (x) => x
    );
    assert.isTrue(PaidCallFailed.is(e));
    assert.equal(e.message, "the decision did not come back in 10 ms");
    assert.deepEqual(e.payment, PAYMENT(10, 52));
  });

  it("a paid answer inside the grace is still late, and its voucher is kept", async () => {
    const d = onAbort((resolve) =>
      resolve({
        answers: { action: { choice: "step", confidence: 1 } },
        model: "m",
        id: "late",
        payment: PAYMENT(0, 42),
      })
    );
    const e = await decideWithin(d, req, 10, 1_000).then(
      () => assert.fail("a late answer is not acted on"),
      (x) => x
    );
    assert.isTrue(PaidCallFailed.is(e));
    assert.deepEqual(e.payment, PAYMENT(0, 42));
  });

  it("an unpaid refusal, or silence past the grace, is the plain timeout it always was", async () => {
    const refused = onAbort((_, reject) => reject(new Error("the decision was abandoned before it was paid for")));
    const e1 = await decideWithin(refused, req, 10, 1_000).catch((x) => x);
    assert.isFalse(PaidCallFailed.is(e1));
    assert.equal(e1.message, "the decision did not come back in 10 ms");
    const silent = { decide: () => new Promise<DecideResult>(() => undefined) };
    const started = Date.now();
    const e2 = await decideWithin(silent, req, 10, 30).catch((x) => x);
    assert.isFalse(PaidCallFailed.is(e2));
    assert.isBelow(Date.now() - started, 1_000, "bounded by the grace");
  });

  it("an answer inside the deadline is returned as it was", async () => {
    const r: DecideResult = { answers: {}, model: "m", id: "d", payment: PAYMENT(0, 42) };
    assert.strictEqual(await decideWithin({ decide: async () => r }, req, 1_000, 1_000), r);
  });
});

describe("a loop's Jev spend: what a paid Jev call adds to it", () => {
  function row(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
    return {
      id,
      agentId: "cd".repeat(32),
      agentName: "jev-meter",
      owner: "So11111111111111111111111111111111111111112",
      prompt: "Do whatever task.next says.",
      promptHash: "00".repeat(32),
      intervalMs: 60_000,
      maxSteps: 5,
      budgetMicroUsdc: "1000000",
      budgetMicroUsdcPerStep: "200000",
      jevBudgetBase: "150000",
      jevSpentBase: "0",
      model: "deepseek/deepseek-v4.1-flash",
      createdAt: T0,
      status: "running",
      snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
      history: [],
      ...over,
    };
  }
  const paid = (before: number, after: number) => ({
    answers: {},
    payment: { cumulativeBefore: String(before), cumulativeAfter: String(after) },
  });

  it("adds an answered call's voucher delta, and persists it at once", async () => {
    recordLoop(row("loop-jev-answered"));
    await meterJevCall("loop-jev-answered", async () => paid(1_000, 1_042));
    await meterJevCall("loop-jev-answered", async () => paid(1_042, 1_100));
    assert.equal(readLoop("loop-jev-answered")!.jevSpentBase, "100");
  });

  it("adds a call the channel paid for and that never answered, and still throws it", async () => {
    recordLoop(row("loop-jev-unanswered"));
    const payment = PAYMENT(500, 542);
    const failed = new PaidCallFailed("the decision timed out", payment);
    try {
      await meterJevCall("loop-jev-unanswered", async () => {
        throw failed;
      });
      assert.fail("the error is handed back");
    } catch (e) {
      assert.strictEqual(e, failed);
    }
    assert.equal(readLoop("loop-jev-unanswered")!.jevSpentBase, "42", "paid and discarded still counts");
    // A plain failure paid nothing and adds nothing.
    await meterJevCall("loop-jev-unanswered", async () => {
      throw new Error("refused before the voucher");
    }).catch(() => undefined);
    assert.equal(readLoop("loop-jev-unanswered")!.jevSpentBase, "42");
  });

  it("refuses a step's decision once the Jev budget is spent, without making the call", async () => {
    recordLoop(row("loop-jev-spent", { jevBudgetBase: "100", jevSpentBase: "99" }));
    let called = 0;
    const inner = {
      chat: async () => {
        throw new Error("no chat in this case");
      },
      decide: async () => {
        called++;
        return paid(0, 42) as unknown as DecideResult;
      },
    };
    const metered = jevMeteredTransport("loop-jev-spent", inner as any);
    try {
      await metered.decide!({ model: "m", state: "s", questions: {} } as DecideRequest);
      assert.fail("a spent Jev budget refuses the call");
    } catch (e) {
      assert.equal((e as Error).message, JEV_BUDGET_SPENT_DETAIL);
    }
    assert.equal(called, 0, "no voucher was signed");
    // With room left the same transport pays and counts.
    updateLoop("loop-jev-spent", (l) => ({ ...l, jevBudgetBase: "1000" }));
    await metered.decide!({ model: "m", state: "s", questions: {} } as DecideRequest);
    assert.equal(called, 1);
    assert.equal(readLoop("loop-jev-spent")!.jevSpentBase, "141");
  });

  it("holds a chat retry to Lath's share and counts what a lost attempt cost against it", () => {
    // An attempt that got no answer is Lath's to pay, so it is Lath's spend for the loop, and a retry
    // is admitted only while that share can still pay one more call — the rule a Jev call follows.
    recordLoop(row("loop-retry-share", { jevBudgetBase: "3000", jevSpentBase: "0" }));
    const policy = loopNoAnswer("loop-retry-share");
    assert.equal(policy.admitRetry!(), true);
    policy.onAbsorbed!(2470n);
    assert.equal(readLoop("loop-retry-share")!.jevSpentBase, "2470");
    assert.equal(policy.admitRetry!(), true, "one more call still fits under the share");
    policy.onAbsorbed!(2470n);
    assert.equal(readLoop("loop-retry-share")!.jevSpentBase, "4940", "the call that crosses is counted all the same");
    assert.match(String(policy.admitRetry!()), new RegExp(`^${JEV_BUDGET_SPENT}: .*not tried again`));
    // An unreadable record refuses rather than admitting a retry nobody could count.
    assert.match(String(loopNoAnswer("loop-retry-missing").admitRetry!()), new RegExp(`^${JEV_BUDGET_UNREADABLE}`));
  });

  it("refuses a step's decision when the loop's record cannot be read, rather than admitting it uncounted", async () => {
    let called = 0;
    const inner = {
      chat: async () => {
        throw new Error("no chat in this case");
      },
      decide: async () => {
        called++;
        return paid(0, 42) as unknown as DecideResult;
      },
    };
    // No such row: `readLoop` returns null, which is also what an unreadable registry reads as.
    const metered = jevMeteredTransport("loop-jev-unreadable", inner as any);
    try {
      await metered.decide!({ model: "m", state: "s", questions: {} } as DecideRequest);
      assert.fail("an unreadable record refuses the call");
    } catch (e) {
      assert.match((e as Error).message, new RegExp(`^${JEV_BUDGET_UNREADABLE}`));
    }
    assert.equal(called, 0, "no voucher was signed");
  });

  it("says Jev was not asked for budget reasons on the verify and goal views", () => {
    const verify = stepVerifyView({ verify: { unavailable: JEV_BUDGET_SPENT_DETAIL } }, false);
    assert.deepEqual(verify, { unavailable: JEV_BUDGET_SPENT_DETAIL, capped: JEV_BUDGET_SPENT });
    const outage = stepVerifyView({ verify: { unavailable: "timeout" } }, false);
    assert.deepEqual(outage, { unavailable: "timeout" }, "an ordinary outage carries no capped");
    const goal = stepGoalCheckView(
      { goalCheck: { outcome: "unavailable", claimed: false, bar: 0.5, reason: JEV_BUDGET_SPENT_DETAIL } },
      false
    );
    assert.equal(goal?.capped, JEV_BUDGET_SPENT);
    assert.equal(goal?.unavailable, JEV_BUDGET_SPENT_DETAIL);
  });
});

describe("a loop's money bounds from the environment", () => {
  // `Number(env ?? default)` would read a typo as NaN, and `n >= NaN` is false: the bound would be off.
  const warn = console.warn;
  let warned: string[] = [];
  beforeEach(() => {
    warned = [];
    console.warn = (m: string) => void warned.push(m);
  });
  afterEach(() => {
    console.warn = warn;
  });

  it("reads the loop's two money bounds by the same rule: malformed is the default, never off", () => {
    const percent = (raw: string | undefined) =>
      boundedEnvNumber("LATH_JEV_BUDGET_PERCENT", raw, 15, { min: 0, max: 100 });
    assert.equal(percent(undefined), 15);
    assert.equal(percent(""), 15);
    assert.equal(percent("20"), 20);
    assert.equal(percent("0"), 0, "zero is a choice: every Jev call goes to its outage path");
    assert.equal(percent("100"), 100);
    assert.equal(percent("12.5"), 12.5);
    assert.deepEqual(warned, []);
    for (const raw of ["fifteen", "NaN", "-1", "101", "Infinity"]) assert.equal(percent(raw), 15, raw);
    assert.lengthOf(warned, 5);
    assert.match(warned[0], /LATH_JEV_BUDGET_PERCENT="fifteen" .* using 15/);

    const cap = (raw: string | undefined) =>
      boundedEnvNumber("LATH_LOOP_BUDGET_MAX_USDC", raw, 25, { min: 0, minExclusive: true });
    assert.equal(cap("10"), 10);
    assert.equal(cap(undefined), 25);
    // Zero would cap every loop at nothing — a typo's worth of outage — so it is malformed here.
    for (const raw of ["0", "-5", "25 USDC", "Infinity"]) assert.equal(cap(raw), 25, raw);
  });
});
