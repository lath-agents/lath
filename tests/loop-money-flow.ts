/**
 * The loop page's Tempo side as figures:
 * the money flow (`moneyFlowFigures`), the open channel's fill (`openChannelFill`), the _Paid on
 * Tempo_ rows per service and payer (`tempoPayments`) and the treasury's balance per step
 * (`treasurySeries`). Pure functions over a `LoopView` the page already holds.
 *
 * Node-only, network-free, key-free.
 */
import { expect } from "chai";
import { moneyFlowFigures, openChannelFill, tempoPayments, treasurySeries } from "../frontend/src/lib/tempo-services";
import type { LoopStepSummary, LoopView } from "../frontend/src/types/loop";

const CH = "0x" + "c1".repeat(32);
const OLD_CH = "0x" + "0d".repeat(32);
const PAYER = "0x" + "aa".repeat(20);
const CLOSE = "0x" + "ce".repeat(32);
const PUT1 = "0x" + "01".repeat(32);
const PUT2 = "0x" + "02".repeat(32);
const RPC_CLOSE = "0x" + "9c".repeat(32);

function row(step: number, over: Partial<LoopStepSummary> = {}): LoopStepSummary {
  return {
    step,
    status: "success",
    steps: 1,
    batchedSteps: 1,
    costMicroUsdc: "0",
    startedAt: 0,
    endedAt: 0,
    leafOk: true,
    epochs: [],
    ...over,
  } as LoopStepSummary;
}

type Snap = NonNullable<LoopStepSummary["tempoSnapshot"]>;
function snap(ofStep: number, over: Partial<Snap> = {}): Snap {
  return { ofStep, takenAt: 0, rpc: {}, ...over };
}

function loop(over: Partial<LoopView>): LoopView {
  return { history: [], tempo: null, channel: null, inference: "openrouter", ...over } as unknown as LoopView;
}

describe("loop money flow", () => {
  describe("openChannelFill", () => {
    it("is null with no open channel: the vault rail, before the first paid call, and once settled", () => {
      expect(openChannelFill(loop({}))).to.equal(null);
      const settled = loop({
        channel: { channelId: CH, payer: PAYER, openedAt: 0, openedAtStep: 1, cumulative: "500" },
        tempo: { payer: PAYER, channelId: CH, closed: true, txHash: CLOSE },
      });
      expect(openChannelFill(settled), "a closed channel is not open, even while the row lingers").to.equal(null);
    });

    it("takes used from the console and the deposit from the newest snapshot of this same channel", () => {
      const fill = openChannelFill(
        loop({
          channel: { channelId: CH, payer: PAYER, openedAt: 0, openedAtStep: 2, cumulative: "62000" },
          history: [
            // A snapshot of a channel the loop closed before must not size this one.
            row(1, { tempoSnapshot: snap(1, { block: "90", channel: { id: OLD_CH, deposit: "999999999" } }) }),
            row(2, {
              tempoSnapshot: snap(2, {
                block: "100",
                channel: { id: CH.toUpperCase().replace("0X", "0x"), deposit: "300000", cumulative: "40000" },
              }),
            }),
            row(3, {
              tempoSnapshot: snap(3, {
                block: "120",
                channel: { id: CH, deposit: "345000", settled: "0", cumulative: "50000" },
              }),
            }),
          ],
        })
      )!;
      expect(fill.openedAtStep).to.equal(2);
      expect(fill.usedBase).to.equal(BigInt(62000));
      expect(fill.depositBase).to.equal(BigInt(345000));
      expect(fill.settledBase).to.equal(BigInt(0));
      expect(fill.depositBlock).to.equal("120");
      expect(fill.depositOfStep).to.equal(3);
      expect(fill.used).to.equal("0.062 USDC.e");
      expect(fill.deposit).to.equal("0.345 USDC.e");
      expect(fill.fraction).to.be.closeTo(62000 / 345000, 1e-9);
    });

    it("draws no bar without a deposit, and caps a fill past it at one", () => {
      const none = openChannelFill(
        loop({ channel: { channelId: CH, payer: PAYER, openedAt: 0, openedAtStep: 1, cumulative: "10" } })
      )!;
      expect(none.depositBase).to.equal(null);
      expect(none.fraction).to.equal(null);
      expect(none.deposit).to.equal(null);
      const over = openChannelFill(
        loop({
          channel: { channelId: CH, payer: PAYER, openedAt: 0, openedAtStep: 1, cumulative: "500" },
          history: [row(1, { tempoSnapshot: snap(1, { channel: { id: CH, deposit: "400" } }) })],
        })
      )!;
      expect(over.fraction).to.equal(1);
    });
  });

  describe("treasurySeries", () => {
    it("one point per step in step order, the stop's last snapshot included, unreadable balances skipped", () => {
      const pts = treasurySeries(
        loop({
          history: [
            row(2, { tempoSnapshot: snap(2, { block: "200", treasury: { usdcE: "2400000" } }) }),
            row(1, { tempoSnapshot: snap(1, { block: "100", treasury: { usdcE: "2500000" } }) }),
            row(3, { tempoSnapshot: snap(3, { block: "300", treasury: {} }) }),
          ],
          tempo: {
            payer: PAYER,
            closed: true,
            services: { lastSnapshot: snap(4, { block: "400", treasury: { usdcE: "2300000" } }) },
          },
        })
      );
      expect(pts.map((p) => p.step)).to.deep.equal([1, 2, 4]);
      expect(pts.map((p) => p.usdcEBase)).to.deep.equal([BigInt(2500000), BigInt(2400000), BigInt(2300000)]);
      expect(pts[0].block).to.equal("100");
    });
  });

  describe("tempoPayments", () => {
    it("is null on a loop that paid nothing on Tempo", () => {
      expect(tempoPayments(loop({ history: [row(1)] }))).to.equal(null);
    });

    it("splits by service and payer, and links the close, each committed PUT and the RPC close", () => {
      const p = tempoPayments(
        loop({
          history: [
            row(1, {
              tempoSpent: "11200",
              goalCheck: { outcome: "continue", costBase: "1200" } as any,
              traceAudit: { outcome: "clean", costBase: "300" } as any,
              tempoStorage: { key: "k1", path: "r.md", bytes: 10, statusCode: 200, amount: "200", reference: PUT1 },
              tempoSnapshot: snap(1, { block: "100", rpc: { cumulative: "50" } }),
            }),
            row(2, {
              tempoSpent: "5000",
              tempoStorage: { key: "k2", path: "r.md", bytes: 10, statusCode: 200, amount: "200", reference: PUT2 },
            }),
          ],
          tempo: {
            payer: PAYER,
            channelId: CH,
            closed: true,
            txHash: CLOSE,
            services: { closeBlock: "150", rpc: { closed: true, txHash: RPC_CLOSE, spent: "80" } },
          },
        })
      )!;
      const byId = Object.fromEntries(p.rows.map((r) => [r.id, r]));
      expect(p.rows.map((r) => r.id)).to.deep.equal(["model", "jev", "trace", "storage", "rpc"]);
      expect(byId.model.payer).to.equal("owner");
      expect(byId.model.amountBase).to.equal(BigInt(16200 - 1200 - 300));
      expect(byId.model.txs).to.deep.equal([{ hash: CLOSE, label: "settled", kind: "settlement" }]);
      expect(byId.jev.payer).to.equal("lath");
      expect(byId.jev.amountBase).to.equal(BigInt(1200));
      expect(byId.trace.amountBase).to.equal(BigInt(300));
      expect(byId.storage.payer).to.equal("owner");
      expect(byId.storage.amount).to.equal("0.0004 USDC.e");
      expect(byId.storage.txs.map((t) => [t.hash, t.label])).to.deep.equal([
        [PUT1, "step 1"],
        [PUT2, "step 2"],
      ]);
      expect(byId.rpc.payer).to.equal("lath");
      expect(byId.rpc.amountBase).to.equal(BigInt(80));
      expect(byId.rpc.txs).to.deep.equal([{ hash: RPC_CLOSE, label: "settled", kind: "rpc" }]);
      expect(p.closeBlock).to.equal("150");
      expect(p.readBlock).to.deep.equal({ block: "100", ofStep: 1 });
    });

    it("gives a loop from before the services its channel rows, with no trace-audit row and no links while open", () => {
      const p = tempoPayments(loop({ history: [row(1, { tempoSpent: "3000" })] }))!;
      expect(p.rows.map((r) => r.id)).to.deep.equal(["model", "jev", "storage", "rpc"]);
      expect(p.rows[0].amountBase).to.equal(BigInt(3000));
      expect(p.rows[0].txs).to.deep.equal([]);
      expect(p.rows[0].note).to.equal("on the loop's payment channel");
      expect(p.rows[3].amount).to.equal(null);
    });
  });

  describe("moneyFlowFigures", () => {
    it("reads an open channel's cumulative, which leads the step rows while a step pays", () => {
      const f = moneyFlowFigures(
        loop({
          channel: { channelId: CH, payer: PAYER, openedAt: 0, openedAtStep: 1, cumulative: "9000" },
          history: [row(1, { tempoSpent: "6000", goalCheck: { outcome: "continue", costBase: "1000" } as any })],
        })
      );
      expect(f.state).to.equal("open");
      expect(f.channelPaid).to.equal(BigInt(9000));
      expect(f.model).to.equal(BigInt(5000));
      expect(f.decisions).to.equal(BigInt(1000));
      expect(f.openedAtStep).to.equal(1);
      expect(f.payer).to.equal(PAYER);
      expect(f.scripted).to.equal(false);
    });

    it("reads a settled channel's spent and close, and the steps' sum when the close named no spent", () => {
      const settled = moneyFlowFigures(
        loop({
          history: [row(1, { tempoSpent: "4000" }), row(2, { tempoSpent: "0" })],
          tempo: { payer: PAYER, channelId: CH, closed: true, txHash: CLOSE, spent: "4100" },
        })
      );
      expect(settled.state).to.equal("settled");
      expect(settled.channelPaid).to.equal(BigInt(4100));
      expect(settled.settleTx).to.equal(CLOSE);
      expect(settled.paidSteps).to.equal(1);
      const noSpent = moneyFlowFigures(
        loop({ history: [row(1, { tempoSpent: "4000" })], tempo: { payer: PAYER, closed: true, txHash: CLOSE } })
      );
      expect(noSpent.channelPaid).to.equal(BigInt(4000));
    });

    it("says scripted for a run that paid nothing for want of a model key, and nothing yet otherwise", () => {
      const scripted = moneyFlowFigures(loop({ history: [row(1)], inference: "scripted" }));
      expect(scripted.state).to.equal("none");
      expect(scripted.scripted).to.equal(true);
      expect(scripted.channelPaid).to.equal(null);
      const fresh = moneyFlowFigures(loop({ history: [] }));
      expect(fresh.scripted).to.equal(false);
      expect(fresh.channelPaid).to.equal(null);
    });
  });
});
