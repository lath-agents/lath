/**
 * The vault popover's _Paid for you on Tempo_: what
 * Lath's treasury paid on Tempo for one wallet's loops, the owner's half only (model calls and
 * stored reports), and the cap label when a loop's history is at the console's row limit.
 *
 * Node-only, network-free: it reads loop rows built here.
 */
import { expect } from "chai";
import { HISTORY_ROWS_KEPT, paidOnTempo } from "../frontend/src/lib/tempo-paid";
import type { LoopStepSummary, LoopView } from "../frontend/src/types/loop";

function row(step: number, over: Partial<LoopStepSummary> = {}): LoopStepSummary {
  return {
    step,
    status: "success",
    steps: 1,
    batchedSteps: 1,
    costMicroUsdc: "0",
    startedAt: 0,
    endedAt: 0,
    ...over,
  } as LoopStepSummary;
}

function loop(history: LoopStepSummary[], tempo: LoopView["tempo"] = null): Pick<LoopView, "history" | "tempo"> {
  return { history, tempo };
}

const TX = "0x" + "ab".repeat(32);

describe("console: paid for you on Tempo", () => {
  it("sums the model calls across loops and leaves Lath's decision spend out", () => {
    const a = loop([
      row(1, { tempoSpent: "3000" }),
      // 4 000 on the channel, of which Jev's goal check was 500 and its trace audit 250: Lath's, not the owner's.
      row(2, {
        tempoSpent: "4000",
        goalCheck: { costBase: "500" } as LoopStepSummary["goalCheck"],
        traceAudit: { costBase: "250" } as LoopStepSummary["traceAudit"],
      }),
    ]);
    const b = loop([row(1, { tempoSpent: "1000" })]);
    const paid = paidOnTempo([a, b]);
    expect(paid.model).to.equal(BigInt(3000 + 4000 - 500 - 250 + 1000));
    expect(paid.storage).to.equal(BigInt(0));
    expect(paid.total).to.equal(paid.model);
    expect(paid.paidLoops).to.equal(2);
    expect(paid.capped).to.equal(false);
  });

  it("adds a committed report PUT and skips one whose receipt names no transaction", () => {
    const l = loop([
      row(1, {
        tempoSpent: "2000",
        tempoStorage: { key: "k", path: "report/a.md", bytes: 10, statusCode: 200, amount: "200", reference: TX },
      }),
      row(2, {
        tempoSpent: "2000",
        tempoStorage: { key: "k2", path: "report/b.md", bytes: 10, statusCode: 402, amount: "200" },
      }),
    ]);
    const paid = paidOnTempo([l]);
    expect(paid.model).to.equal(BigInt(4000));
    expect(paid.storage).to.equal(BigInt(200));
    expect(paid.total).to.equal(BigInt(4200));
  });

  it("counts a loop that paid nothing as no loop, and an empty list as zero", () => {
    expect(paidOnTempo([]).total).to.equal(BigInt(0));
    const paid = paidOnTempo([loop([row(1)]), loop([row(1, { tempoSpent: "10" })])]);
    expect(paid.paidLoops).to.equal(1);
    expect(paid.total).to.equal(BigInt(10));
  });

  it("is labelled capped when a history is at the console's row limit", () => {
    const full = loop(Array.from({ length: HISTORY_ROWS_KEPT }, (_, i) => row(i + 1, { tempoSpent: "1" })));
    expect(paidOnTempo([full]).capped).to.equal(true);
    expect(paidOnTempo([loop([row(1, { tempoSpent: "1" })])]).capped).to.equal(false);
  });
});
