import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import { EventKind, hex, idFromString } from "../sdk/src";
import { AnchorFailed, AnchorQueue, MemoryAnchorJournal, NoopBilling } from "../runtime/src";
import {
  GATE_ASK_DEPOSIT_BASE,
  LoopRecord,
  channelsCommittedBase,
  jevFundedBudget,
  jevFundedRemaining,
  loopChannelSizing,
  loopDrainRefusal,
  loopKeyLimitBase,
  loopFundedHeadroom,
  treasuryShortfall,
} from "../frontend/src/app/api/_lib/loops";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";

/**
 * Two rules about money the operator puts up for a loop that nobody is going to pay back.
 *
 * A journaled `charge` entry drained through `NoopBilling` — an unbilled loop step, or a
 * settlement whose owner's allowance had lapsed — must not settle `verified` on an empty
 * signature, with no USDC moved. The queue refuses a charge that returns no signature, and the
 * loop's step asks `loopDrainRefusal` before it binds anything.
 *
 * A loop's channel ceiling and Lath's Jev budget are sized from what the owner's allowance and
 * escrow actually back, not from the declared budget, which nothing funds (one step's estimate in
 * escrow would unlock all of it), and a start counts what other loops' channels can still draw
 * from the treasury.
 */

void traceDir;

const AGENT = idFromString("c2-loop-charge-drain");
const USER = new PublicKey("11111111111111111111111111111112");

function queueOn(chain: FakeChain, billing: ConstructorParameters<typeof AnchorQueue>[0]["billing"]) {
  return new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
}

describe("a charge that moved no USDC is never settled", () => {
  it("fails a charge entry drained through NoopBilling at once, keeps it owed, and lets a paying retry send it", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    let backend: NoopBilling | RecordingBilling = new NoopBilling();
    const queue = queueOn(chain, () => backend);
    await queue.enqueue({ kind: "charge", agentId: hex(AGENT), user: USER.toBase58(), amountMicroUsdc: "250000" });

    let failed: unknown;
    await queue.drain(AGENT).catch((e) => (failed = e));
    assert.instanceOf(failed, AnchorFailed, "the drain reports the unpaid charge");
    const entry = (failed as AnchorFailed).entry;
    assert.equal(entry.state, "failed");
    assert.equal(entry.attempts, 1, "not retried inside the drain: the same backend answers the same way");
    assert.isUndefined(entry.signature, "no empty signature was recorded as a payment");
    assert.match(entry.error ?? "", /moved no USDC/);
    assert.lengthOf(await queue.carried(AGENT), 1, "the charge is still owed");

    const paying = new RecordingBilling();
    backend = paying;
    await queue.retry(AGENT);
    await queue.drain(AGENT);
    assert.deepEqual(paying.charges, [{ user: USER.toBase58(), amountMicroUsdc: "250000" }]);
    assert.lengthOf(await queue.carried(AGENT), 0, "settled once the money moved");
  });

  it("does not send a record whose charge-only backend moved nothing, so it never claims a debit", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const queue = queueOn(chain, new NoopBilling());
    await queue.logEvent(
      AGENT,
      {
        kind: EventKind.Action as const,
        toolId: "llm.step",
        argsHash: idFromString("a"),
        resultHash: idFromString("r"),
        statusCode: 200,
      },
      { timestamp: 1, charge: { user: USER, amountMicroUsdc: 3400n } }
    );
    let failed: unknown;
    await queue.drain(AGENT).catch((e) => (failed = e));
    assert.instanceOf(failed, AnchorFailed);
    assert.equal(chain.state(AGENT)!.seq, 0n, "the record did not land");
    const [owed] = await queue.carried(AGENT);
    assert.equal(owed.kind, "event");
    assert.isUndefined(
      owed.kind === "event" ? owed.charge?.signature : "x",
      "and its charge is not marked sent, so a paying retry charges it"
    );
  });

  it("refuses a loop step's drain only when journaled charges are owed and the allowance cannot pay", () => {
    const owed = { payers: [USER.toBase58()], microUsdc: 250_000n };
    const none = { payers: [], microUsdc: 0n };
    const refused = { refuse: "the escrow deposit is short: 0.000000 USDC spendable" };
    const ok = { ok: true as const, needed: 1n, headroom: 1n };
    assert.isNull(loopDrainRefusal(none, refused), "an unbilled step on a chain that owes nothing runs as before");
    assert.isNull(loopDrainRefusal(none, null), "and so does one on a console with no treasury");
    assert.isNull(loopDrainRefusal(owed, ok), "a billed step drains the debt for real");
    const why = loopDrainRefusal(owed, refused)!;
    assert.include(why, "0.250000 USDC of journaled charges");
    assert.include(why, "escrow deposit is short", "with which half was short");
    assert.include(why, "stay journaled");
    assert.include(loopDrainRefusal(owed, null)!, "no billing treasury");
  });
});

describe("Lath's side of a loop is sized from what the owner funded", () => {
  const T = 1_900_000_000_000;
  // The audit's case: a budget near the treasury's whole $10, 48 steps, one step's estimate in escrow.
  const loop = (over: Partial<LoopRecord> = {}): LoopRecord =>
    ({
      id: "loop-c3",
      agentId: hex(AGENT),
      owner: USER.toBase58(),
      prompt: "watch",
      intervalMs: 15_000,
      maxSteps: 48,
      budgetMicroUsdcPerStep: "0",
      budgetMicroUsdc: "8690000",
      jevBudgetBase: "1303500",
      jevSpentBase: "0",
      model: "deepseek/deepseek-v4.1-flash",
      createdAt: 0,
      status: "running",
      snapshot: { loopId: "loop-c3", steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
      history: [],
      ...over,
    } as unknown as LoopRecord);
  const grant = { cap: 8_690_000n, spent: 0n, expiresAt: 4_000_000_000 };
  const escrow = 190_000n;

  it("funds only the least of the remaining budget, the allowance's headroom and the escrow", () => {
    assert.equal(loopFundedHeadroom({ loop: loop(), grant, spendable: escrow, now: T }), escrow);
    assert.equal(
      loopFundedHeadroom({ loop: loop(), grant: { ...grant, cap: 50_000n }, spendable: 10_000_000n, now: T }),
      50_000n,
      "the allowance's headroom"
    );
    assert.equal(
      loopFundedHeadroom({ loop: loop(), grant: { ...grant, cap: 99_000_000n }, spendable: 99_000_000n, now: T }),
      8_690_000n,
      "never more than what is left of the budget"
    );
    assert.equal(loopFundedHeadroom({ loop: loop(), grant: null, spendable: escrow, now: T }), 0n);
    assert.equal(
      loopFundedHeadroom({ loop: loop(), grant: { ...grant, expiresAt: 1 }, spendable: escrow, now: T }),
      0n,
      "an expired grant funds nothing"
    );
  });

  it("opens the channel at what is funded plus Lath's share of it, not at the declared budget", () => {
    const declared = loopChannelSizing(loop());
    assert.equal(declared.maxDepositBase, 8_690_000n + 1_303_500n, "the old ceiling: ~the treasury's whole balance");
    const funded = loopChannelSizing(loop(), escrow);
    // 190 000 of the owner's, and 15% of it for Jev: 1 303 500 × 190 000 ÷ 8 690 000 = 28 500.
    assert.equal(funded.maxDepositBase, 190_000n + 28_500n);
    assert.isAtLeast(Number(funded.topUpBase), Number(GATE_ASK_DEPOSIT_BASE));
    // An owner who funded the whole budget sees exactly what they saw before.
    assert.deepEqual(loopChannelSizing(loop(), 8_690_000n), declared);
  });

  it("backs Lath's Jev share with what the owner has spent and funded, never above the frozen budget", () => {
    assert.equal(jevFundedBudget(loop(), escrow), 28_500n);
    const midway = loop({
      snapshot: {
        loopId: "loop-c3",
        steps: 10,
        status: "idle",
        totalCostMicroUsdc: "1000000",
        spentMicroUsdc: "1000000",
        consecutiveFailures: 0,
      } as any,
      jevSpentBase: "100000",
    });
    // (1 000 000 charged + 190 000 funded) × 15%.
    assert.equal(jevFundedBudget(midway, escrow), 178_500n);
    assert.equal(jevFundedRemaining(midway, escrow), 78_500n);
    assert.equal(jevFundedBudget(loop(), 99_000_000n), 1_303_500n, "the frozen budget is still the ceiling");
  });

  it("counts what other loops' channels can still top up against a start's deposit", () => {
    assert.equal(
      channelsCommittedBase([
        { cap: 1_000_000n, deposit: 400_000n, cumulative: 100_000n },
        { cap: 500_000n, cumulative: 200_000n },
        { cap: 300_000n },
        { cap: 100_000n, deposit: 100_000n },
      ]),
      600_000n + 300_000n + 300_000n,
      "the ceiling less what is deposited, or less the cumulative when the deposit is unknown"
    );
    const terms = { maxSteps: 10, budgetMicroUsdc: "1000000" };
    assert.isNull(treasuryShortfall(terms, 2_000_000n, 15, 0n));
    const why = treasuryShortfall(terms, 2_000_000n, 15, 900_000n)!;
    assert.isNotNull(why, "1.15 needed, 2.0 held, 0.9 of it already committed");
    assert.include(why, "0.900000 of it committed to other loops' open channels");
  });
});

/**
 * A loop's access key is authorized for what its channel may draw at start (docs/ARCHITECTURE.md
 * §7.3): the deposit `loopChannelSizing` gives a fresh run, from
 * that function and not a second formula, so the Tempo-enforced cap and the channel's ceiling agree.
 */
describe("a loop key's limit is the fresh run's channel ceiling", () => {
  it("equals loopChannelSizing's deposit over the declared budget and the frozen Jev share", () => {
    for (const [maxSteps, budget] of [
      [3, 150_000n],
      [10, 1_000_000n],
      [48, 25_000_000n],
    ] as const) {
      const fresh = {
        maxSteps,
        budgetMicroUsdc: budget.toString(),
        budgetMicroUsdcPerStep: (budget / BigInt(maxSteps)).toString(),
        jevBudgetBase: ((budget * 15n) / 100n).toString(),
        jevSpentBase: "0",
        snapshot: { loopId: "", steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
      } as unknown as LoopRecord;
      const limit = loopKeyLimitBase({
        maxSteps,
        budgetMicroUsdc: budget,
        budgetMicroUsdcPerStep: budget / BigInt(maxSteps),
      });
      assert.equal(limit, loopChannelSizing(fresh).maxDepositBase.toString());
      assert.equal(limit, (budget + (budget * 15n) / 100n).toString(), "the budget plus Lath's 15 %");
      // Every later open is sized from what is funded, which is never above the declared budget.
      assert.isAtMost(Number(loopChannelSizing(fresh, budget / 2n).maxDepositBase), Number(limit));
    }
  });
});
