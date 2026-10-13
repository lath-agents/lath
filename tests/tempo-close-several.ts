/**
 * A settlement transaction that closes several channels: the browser's close check
 * (`closeReceiptProblem`, `frontend/src/lib/tempo-close.ts`) must find *this* channel's
 * `ChannelClosed` wherever it sits on the receipt, as the SDK's `closedLogFor` does, and not judge
 * the second channel's honest close against the first channel's log — or the badge would read
 * FAILED where `lath-audit` reads VERIFIED. Node-only and network-free.
 */
import { assert } from "chai";
import {
  CHANNEL_CLOSED_TOPIC,
  TEMPO_ESCROW_ADDRESS,
  closeReceiptDetails,
  closeReceiptProblem,
  type RpcCloseReceipt,
} from "../frontend/src/lib/tempo-close";

const FIRST = `0x${"11".repeat(32)}`;
const SECOND = `0x${"22".repeat(32)}`;
const THIRD = `0x${"33".repeat(32)}`;
const PAYER = `0x${"aa".repeat(20)}`;
const PAYEE = `0x${"bb".repeat(20)}`;

const topicOf = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");

function closedLog(channelId: string, payer = PAYER, finalAmount = 5n, refund = 1n) {
  return {
    address: TEMPO_ESCROW_ADDRESS,
    topics: [CHANNEL_CLOSED_TOPIC, channelId, topicOf(payer), topicOf(PAYEE)],
    data: `0x${word(finalAmount)}${word(refund)}`,
  };
}

const receipt = (logs: RpcCloseReceipt["logs"]): RpcCloseReceipt => ({ status: "0x1", to: TEMPO_ESCROW_ADDRESS, logs });

describe("tempo close receipt closing several channels", () => {
  it("verifies the second channel's close on a receipt that closed two", () => {
    const r = receipt([closedLog(FIRST), closedLog(SECOND, PAYER, 9n, 0n)]);
    assert.isNull(closeReceiptProblem(r, FIRST, PAYER));
    assert.isNull(closeReceiptProblem(r, SECOND, PAYER));
    // And the problem and the details read the same log, so the page's figures are this channel's.
    assert.deepEqual(closeReceiptDetails(r, SECOND), {
      payee: PAYEE,
      finalAmountBase: "9",
      refundBase: "0",
    });
  });

  it("judges the payer on this channel's log, not the first one's", () => {
    const other = `0x${"cc".repeat(20)}`;
    const r = receipt([closedLog(FIRST, other), closedLog(SECOND, PAYER)]);
    assert.isNull(closeReceiptProblem(r, SECOND, PAYER));
    assert.include(closeReceiptProblem(r, FIRST, PAYER)!, other);
  });

  it("still names the channel the transaction closed when none is this one", () => {
    const got = closeReceiptProblem(receipt([closedLog(FIRST), closedLog(SECOND)]), THIRD, PAYER)!;
    assert.include(got, `closed channel ${FIRST}, not ${THIRD}`);
  });

  it("counts only the escrow's own logs, wherever this channel's sits", () => {
    const forged = { ...closedLog(SECOND), address: `0x${"dd".repeat(20)}` };
    const got = closeReceiptProblem(receipt([closedLog(FIRST), forged]), SECOND, PAYER)!;
    assert.include(got, `closed channel ${FIRST}, not ${SECOND}`);
  });
});
