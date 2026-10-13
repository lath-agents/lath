/**
 * What a Tempo close paid out, decoded in the browser from the receipt the badge already
 * fetches (`closeReceiptDetails`, `frontend/src/lib/tempo-close.ts`), held against the SDK's own
 * viem decoder (`channelClosuresIn`, `sdk/src/tempo.ts`) so the two cannot read one log differently.
 *
 * The fixture is a real mainnet close, as `eth_getTransactionReceipt` on rpc.tempo.xyz returned it,
 * trimmed to the fields a reader looks at. The
 * rest are built with viem from the SDK's `ESCROW_ABI`. Node-only and network-free: nothing is read
 * from Tempo here, and nothing spends.
 */
import { assert } from "chai";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { CHANNEL_CLOSED_SIGNATURE, ESCROW_ABI, TEMPO_ESCROW, channelClosuresIn } from "../sdk/src";
import {
  CHANNEL_CLOSED_TOPIC,
  closeCoversCumulative,
  closeReceiptDetails,
  closeReceiptProblem,
  type RpcCloseReceipt,
} from "../frontend/src/lib/tempo-close";

/** https://explore.tempo.xyz/tx/0x9c0eb80273a5021a09d2c157764cfd303a374ea16dd9296d40e4f81d154227dc */
const REAL_CLOSE: RpcCloseReceipt & { transactionHash: string } = {
  transactionHash: "0x9c0eb80273a5021a09d2c157764cfd303a374ea16dd9296d40e4f81d154227dc",
  status: "0x1",
  to: "0x4d50500000000000000000000000000000000000",
  logs: [
    // The USDC.e transfer the close made, escrow → payee: same receipt, not the escrow's event.
    {
      address: "0x20c000000000000000000000b9537d11c60e8b50",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000004d50500000000000000000000000000000000000",
        "0x000000000000000000000000ca4e835f803cb0b7c428222b3a3b98518d4779fe",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000003e8",
    },
    {
      address: "0x4d50500000000000000000000000000000000000",
      topics: [
        "0x5613aed96d5bf39f928408dbe1d4143490b9bb5957eac2dd8e69b5dc4b2206e6",
        "0x31a142270f1dc5312e4c045f107048581b0d1c15887933f4a989a32f7b1e90bb",
        "0x00000000000000000000000018fbe5e0a83dca440072059f91d1a23babe6e0b0",
        "0x000000000000000000000000ca4e835f803cb0b7c428222b3a3b98518d4779fe",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000000",
    },
    // The fee, paid in the fee token by the fee payer.
    {
      address: "0x20c0000000000000000000000000000000000000",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x00000000000000000000000058aa7ce42e1d13b2919e2ac7e006c4fbc171442c",
        "0x000000000000000000000000feec000000000000000000000000000000000000",
      ],
      data: "0x000000000000000000000000000000000000000000000000000000000000002f",
    },
  ],
};
const REAL_CHANNEL = "0x31a142270f1dc5312e4c045f107048581b0d1c15887933f4a989a32f7b1e90bb";
const REAL_PAYER = "0x18fbe5e0a83dca440072059f91d1a23babe6e0b0";
const REAL_PAYEE = "0xca4e835f803cb0b7c428222b3a3b98518d4779fe";

const PAYER = "0x749d38880f1974de12E841B5D4a23FC980a89117";
const PAYEE = "0xca4e000000000000000000000000000000000000";
const CHANNEL = `0x${"11".repeat(32)}`;
const SECOND = `0x${"33".repeat(32)}`;

/** A `ChannelClosed` log as the escrow emits it, encoded by viem from the SDK's ABI. */
function closedLog(channelId: string, finalAmount: bigint, refund: bigint, address: string = TEMPO_ESCROW) {
  return {
    address,
    topics: encodeEventTopics({
      abi: ESCROW_ABI as any,
      eventName: "ChannelClosed",
      args: { channelId, payer: PAYER, payee: PAYEE },
    } as any) as string[],
    data: encodeAbiParameters([{ type: "uint96" }, { type: "uint96" }], [finalAmount, refund] as any) as string,
  };
}

const receipt = (logs: RpcCloseReceipt["logs"], status = "0x1"): RpcCloseReceipt => ({
  status,
  to: TEMPO_ESCROW,
  logs,
});

/** What the SDK's viem decoder reads off the same logs, in the browser's units. */
async function sdkDetails(r: RpcCloseReceipt, channelId: string) {
  const all = await channelClosuresIn((r.logs ?? []) as any);
  const c = all.find((x) => x.channelId.toLowerCase() === channelId.toLowerCase());
  return c
    ? { payee: c.payee.toLowerCase(), finalAmountBase: c.finalAmount.toString(), refundBase: c.refund.toString() }
    : null;
}

describe("the close's amount, decoded in the browser", () => {
  it("reads the payee, finalAmount and refund off a real mainnet close receipt", async () => {
    const got = closeReceiptDetails(REAL_CLOSE, REAL_CHANNEL);
    assert.deepEqual(got, { payee: REAL_PAYEE, finalAmountBase: "1000", refundBase: "0" });
    // The same receipt passes the badge's check, so the page shows these figures as checked.
    assert.isNull(closeReceiptProblem(REAL_CLOSE, REAL_CHANNEL, REAL_PAYER));
    // And the SDK's decoder, viem over `ESCROW_ABI`, reads the same three things.
    assert.deepEqual(got, await sdkDetails(REAL_CLOSE, REAL_CHANNEL));
  });

  it("decodes the event the SDK names, under the topic the badge compares", () => {
    assert.equal(CHANNEL_CLOSED_SIGNATURE, "ChannelClosed(bytes32,address,address,uint96,uint96)");
    const [topic0] = closedLog(CHANNEL, BigInt(1), BigInt(0)).topics;
    assert.equal(topic0.toLowerCase(), CHANNEL_CLOSED_TOPIC);
  });

  it("agrees with the SDK's decoder over viem-encoded closes, up to uint96's largest", async () => {
    const max = (BigInt(1) << BigInt(96)) - BigInt(1);
    for (const [finalAmount, refund] of [
      [BigInt(0), BigInt(0)],
      [BigInt(104_000), BigInt(241_000)],
      [max, BigInt(1)],
      [BigInt(1), max],
    ]) {
      const r = receipt([closedLog(CHANNEL, finalAmount, refund)]);
      const got = closeReceiptDetails(r, CHANNEL);
      assert.deepEqual(got, { payee: PAYEE, finalAmountBase: finalAmount.toString(), refundBase: refund.toString() });
      assert.deepEqual(got, await sdkDetails(r, CHANNEL));
    }
  });

  it("answers with the close of the channel asked for when one transaction closes several", async () => {
    const r = receipt([
      // A lookalike another contract emitted first: anyone may emit the topic.
      closedLog(SECOND, BigInt(1), BigInt(0), PAYEE),
      closedLog(CHANNEL, BigInt(750), BigInt(250)),
      closedLog(SECOND, BigInt(900), BigInt(100)),
    ]);
    assert.equal(closeReceiptDetails(r, SECOND)?.finalAmountBase, "900");
    assert.equal(closeReceiptDetails(r, CHANNEL.toUpperCase().replace("0X", "0x"))?.refundBase, "250");
    assert.deepEqual(closeReceiptDetails(r, SECOND), await sdkDetails(r, SECOND));
  });

  it("says nothing for a close that is not there, reverted, or not the escrow's", () => {
    assert.isNull(closeReceiptDetails(REAL_CLOSE, CHANNEL), "another channel's close is not this one's");
    assert.isNull(closeReceiptDetails({ ...REAL_CLOSE, status: "0x0" }, REAL_CHANNEL), "a reverted close paid nobody");
    assert.isNull(closeReceiptDetails(receipt([closedLog(CHANNEL, BigInt(5), BigInt(0), PAYEE)]), CHANNEL));
    assert.isNull(closeReceiptDetails(receipt([]), CHANNEL));
    assert.isNull(closeReceiptDetails(receipt(null), CHANNEL));
    assert.isNull(closeReceiptDetails(REAL_CLOSE, ""), "no channel, nothing to look for");
  });

  it("refuses a log whose data is not two uint96 words, rather than print a number nobody paid", () => {
    const good = closedLog(CHANNEL, BigInt(10), BigInt(0));
    const words = good.data.slice(2);
    // One word short, one word long, and no data at all.
    for (const data of [`0x${words.slice(0, 64)}`, `0x${words}${"0".repeat(64)}`, undefined, "0x"]) {
      assert.isNull(closeReceiptDetails(receipt([{ ...good, data }]), CHANNEL), String(data));
    }
    // A word with its high bytes set is not an encoded uint96.
    const wide = `0x${"f".repeat(40)}${words.slice(40)}`;
    assert.isNull(closeReceiptDetails(receipt([{ ...good, data: wide }]), CHANNEL));
    // Three topics: no payee to read.
    assert.isNull(closeReceiptDetails(receipt([{ ...good, topics: good.topics.slice(0, 3) }]), CHANNEL));
  });

  it("leaves the badge's rule exactly as it was", () => {
    // `closeReceiptProblem` reads this channel's ChannelClosed (topics only) and needs no data at all.
    const r = receipt([{ ...closedLog(CHANNEL, BigInt(1), BigInt(0)), data: undefined }]);
    assert.isNull(closeReceiptProblem(r, CHANNEL, PAYER));
    assert.isNull(closeReceiptDetails(r, CHANNEL));
  });
});

describe("the close against the chain's last voucher", () => {
  const details = { payee: PAYEE, finalAmountBase: "1000", refundBase: "0" };

  it("covers a cumulative at or under finalAmount, and not one over it", () => {
    assert.isTrue(closeCoversCumulative(details, "1000"));
    assert.isTrue(closeCoversCumulative(details, BigInt(999)));
    assert.isFalse(closeCoversCumulative(details, "1001"));
  });

  it("says nothing when either side is missing or unreadable", () => {
    assert.isNull(closeCoversCumulative(null, "1"));
    assert.isNull(closeCoversCumulative(details, undefined));
    assert.isNull(closeCoversCumulative(details, ""));
    assert.isNull(closeCoversCumulative(details, "not a number"));
  });
});
