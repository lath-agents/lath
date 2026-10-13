import { assert } from "chai";
import { LATH_BILLING_IDL, LATH_IDL, TEMPO_ESCROW } from "@lath/sdk";
import { chainBadge } from "../frontend/src/lib/chain-badge";
import {
  CHANNEL_CLOSED_TOPIC,
  TEMPO_ESCROW_ADDRESS,
  closeReceiptProblem,
  settlementCovering,
  settlementFromBlob,
} from "../frontend/src/lib/tempo-close";
import {
  BILLING_ERRORS,
  explainProgramError,
  programErrorOf,
  type ErrorHint,
  type ErrorTable,
} from "../frontend/src/lib/program-errors";

/**
 * The reader's rules, pure: what the console's pages may say about what they read, checked
 * without React, a wallet or a network. The synthesis row's rule belongs to a team's step rows,
 * which are not in this build.
 *
 * Each module under test is DOM-free on purpose — the component that renders it imports it, and
 * this suite imports the same function. Node-only: no validator, no RPC, nothing that spends.
 */

describe("chain badge", () => {
  const n = (xs: number[]) => xs.map((x) => BigInt(x));

  it("reads verified with no gaps", () => {
    const b = chainBadge({ ok: true, headReached: true, missingSeqs: [], seq: BigInt(12) });
    assert.deepEqual(b, {
      text: "chain verified to seq 12",
      tone: "good",
      title: b.title,
    });
  });

  it("reads verified *with gaps* when the fold resumed across missing seqs, and names them", () => {
    const b = chainBadge({ ok: true, headReached: true, missingSeqs: n([5, 6, 7]), seq: BigInt(12) });
    assert.equal(b.tone, "warn");
    // The prefix the e2e specs match by regex stays.
    assert.match(b.text, /^chain verified to seq 12/);
    assert.include(b.text, "with gaps");
    assert.include(b.title!, "5, 6, 7");
    assert.include(b.title!, "was not recomputed across the gap");
    // Only a compact write history names keeps `ok`; pruned history takes the not-verified
    // arm, so this title must not offer it as an explanation.
    assert.include(b.title!, "compact events");
    assert.notInclude(b.title!, "no longer returns");
  });

  it("reads head not reached, with the last gap seqs, when nothing disagreed and the tail is missing", () => {
    const b = chainBadge({ ok: false, headReached: false, missingSeqs: n([3, 8, 9, 10]), seq: BigInt(10) });
    assert.deepEqual(b, { text: "head not reached (gap at seq 8, 9, 10, …)", tone: "warn" });
  });

  it("reads broken at the first bad seq", () => {
    const b = chainBadge({
      ok: false,
      headReached: true,
      firstBadSeq: BigInt(4),
      missingSeqs: [],
      seq: BigInt(10),
    });
    assert.deepEqual(b, { text: "chain broken at seq 4", tone: "bad" });
  });

  it("reads not verified, not broken, for a gap nothing accounts for", () => {
    const b = chainBadge({
      ok: false,
      headReached: true,
      missingSeqs: n([5, 6]),
      unexplainedGaps: n([6]),
      seq: BigInt(10),
    });
    assert.equal(b.text, "chain not verified: gaps not accounted for");
    assert.equal(b.tone, "warn");
    assert.match(b.title!, /at seq 6;/);
  });
});

describe("tempo close receipt", () => {
  const CHANNEL = `0x${"11".repeat(32)}`;
  const OTHER = `0x${"22".repeat(32)}`;
  const PAYER = "0x749d38880f1974de12e841b5d4a23fc980a89117";
  const PAYEE = "0xca4e000000000000000000000000000000000000";
  const pad = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  const closeLog = (channel = CHANNEL, payer = PAYER, address = TEMPO_ESCROW_ADDRESS) => ({
    address,
    topics: [CHANNEL_CLOSED_TOPIC, channel, pad(payer), pad(PAYEE)],
  });
  const receipt = (over: Record<string, unknown> = {}) => ({
    status: "0x1",
    to: TEMPO_ESCROW_ADDRESS,
    logs: [closeLog()],
    ...over,
  });

  it("accepts a receipt that closed this channel at the escrow against this payer", () => {
    assert.isNull(closeReceiptProblem(receipt(), CHANNEL, PAYER));
    // Hex case is not a difference: RPCs return checksummed addresses.
    assert.isNull(closeReceiptProblem(receipt(), CHANNEL.toUpperCase().replace("0X", "0x"), PAYER.toUpperCase()));
    // No payer to compare is not a failure: the channel and the escrow still have to match.
    assert.isNull(closeReceiptProblem(receipt(), CHANNEL));
  });

  it("says a reverted close reverted", () => {
    assert.match(closeReceiptProblem(receipt({ status: "0x0" }), CHANNEL, PAYER)!, /reverted/);
  });

  it("says a transaction sent anywhere but the escrow was not sent to the escrow", () => {
    const got = closeReceiptProblem(receipt({ to: PAYEE }), CHANNEL, PAYER)!;
    assert.include(got, "not to the escrow");
  });

  it("does not count a ChannelClosed topic some other contract emitted", () => {
    const got = closeReceiptProblem(receipt({ logs: [closeLog(CHANNEL, PAYER, PAYEE)] }), CHANNEL, PAYER)!;
    assert.include(got, "no ChannelClosed");
  });

  it("names both channels when the close was of another one", () => {
    const got = closeReceiptProblem(receipt({ logs: [closeLog(OTHER)] }), CHANNEL, PAYER)!;
    assert.include(got, `closed channel ${OTHER}, not ${CHANNEL}`);
  });

  it("names both payers when the channel was closed against another", () => {
    const got = closeReceiptProblem(receipt({ logs: [closeLog(CHANNEL, PAYEE)] }), CHANNEL, PAYER)!;
    assert.include(got, PAYEE);
    assert.include(got, PAYER);
  });

  it("uses the SDK's escrow address", () => {
    // The topic is pinned against viem in tests/tempo-verify.ts; the address needs no viem.
    assert.equal(TEMPO_ESCROW_ADDRESS, TEMPO_ESCROW.toLowerCase());
  });
});

describe("which settlement covers a payment block", () => {
  const CH = "0x" + "ab".repeat(32);
  const OTHER = "0x" + "cd".repeat(32);
  const TX = "0x" + "11".repeat(32);
  const TX2 = "0x" + "22".repeat(32);

  it("reads both blob shapes: a Resolution's output and a loop.settlement's result", () => {
    const utf8 = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    assert.equal(settlementFromBlob(utf8({ output: "x", settlement: { txHash: TX, spent: "5" } }))?.txHash, TX);
    assert.equal(settlementFromBlob(utf8({ channelId: CH, closed: true, txHash: TX }))?.channelId, CH);
    assert.isNull(settlementFromBlob(utf8({ output: "done" })));
  });

  it("takes the first close naming this channel, case-insensitively, past one naming another", () => {
    const got = settlementCovering(CH, [
      { loop: false, settlement: null },
      { loop: true, settlement: { channelId: OTHER, txHash: TX2, closed: true } },
      { loop: true, settlement: { channelId: CH.toUpperCase().replace("0X", "0x"), txHash: TX, closed: true } },
    ]);
    assert.equal(got?.txHash, TX);
  });

  it("accepts a session's close that names no channel", () => {
    assert.equal(settlementCovering(CH, [{ loop: false, settlement: { txHash: TX, spent: "9" } }])?.txHash, TX);
  });

  it("stays pending while an earlier candidate is unread, or a loop.settlement cannot be opened", () => {
    const later = { loop: true, settlement: { channelId: CH, txHash: TX } };
    assert.isNull(settlementCovering(CH, [{ loop: false, settlement: undefined }, later]));
    assert.isNull(settlementCovering(CH, [{ loop: true, settlement: null }, later]));
  });

  it("returns a close that did not land only when it names this channel", () => {
    const failed = { channelId: CH, closed: false, error: "rpc down" };
    assert.equal(settlementCovering(CH, [{ loop: true, settlement: failed }])?.error, "rpc down");
    assert.isNull(settlementCovering(CH, [{ loop: false, settlement: { closed: false } }]));
    assert.isNull(settlementCovering(null, [{ loop: true, settlement: { channelId: CH, txHash: TX } }]));
  });

  // As `verifyInference` step 3 reads it: a Resolution settles only its own session.
  describe("only the call's own session's Resolution", () => {
    it("finds the close the call's own Resolution names", () => {
      const own = { loop: false, settlement: { txHash: TX, spent: "9" } };
      assert.equal(settlementCovering(CH, [own, { loop: false, settlement: { txHash: TX2 } }])?.txHash, TX);
      assert.equal(settlementCovering(CH, [{ ...own, settlement: { ...own.settlement, channelId: CH } }])?.txHash, TX);
    });

    it("does not pin the next session's close on a call whose own close failed", () => {
      // Session N resolved with no settlement (its close failed); session N+1's Resolution names
      // its own close with no channel, as an older Resolution does. That is not N's close.
      const next = { loop: false, settlement: { txHash: TX2, spent: "4" } };
      assert.isNull(settlementCovering(CH, [{ loop: false, settlement: null }, next]));
      assert.isNull(settlementCovering(CH, [{ loop: false, settlement: { closed: false } }, next]));
      // Session N never resolved: the first Resolution past the next Genesis is still another's,
      // even while it is unread — it can never be the answer, so it does not hold the walk.
      assert.isNull(settlementCovering(CH, [{ ...next, laterSession: true }]));
      assert.isNull(settlementCovering(CH, [{ loop: false, settlement: undefined, laterSession: true }]));
      // A loop step's Resolution carries none, and the loop's settlement later still covers it.
      const loopClose = { loop: true, settlement: { channelId: CH, txHash: TX, closed: true }, laterSession: true };
      assert.equal(settlementCovering(CH, [{ loop: false, settlement: null }, next, loopClose])?.txHash, TX);
    });

    it("never matches a Resolution that names another channel, and ends the session at it", () => {
      const other = { loop: false, settlement: { channelId: OTHER, txHash: TX2, spent: "3" } };
      assert.isNull(settlementCovering(CH, [other]));
      assert.isNull(settlementCovering(CH, [other, { loop: false, settlement: { txHash: TX } }]));
      assert.isNull(settlementCovering(CH, [{ loop: true, settlement: { channelId: OTHER, txHash: TX2 } }]));
    });
  });
});

describe("program errors", () => {
  const BILLING = LATH_BILLING_IDL.address;
  const LATH = LATH_IDL.address;
  /** The Light system program, which sits in the same 6000+ range. */
  const LIGHT = "SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7";
  const tables: Record<ErrorHint, ErrorTable> = {
    billing: { programId: BILLING, errors: LATH_BILLING_IDL.errors, copy: BILLING_ERRORS },
  };
  const failed = (program: string, code: number) =>
    `Program ${program} failed: custom program error: 0x${code.toString(16)}`;

  it("attributes a failed log line to the program that wrote it", () => {
    const text = `Program log: AnchorError occurred. Error Code: InvalidBatchSize. ${failed(LATH, 6005)}`;
    assert.deepEqual(programErrorOf(text), { programId: LATH, code: 6005, name: "InvalidBatchSize" });
  });

  it("attributes a nested failure to the first program that failed, where the error originated", () => {
    const text = [failed(LIGHT, 6043), failed(LATH, 6043)].join(" ");
    assert.deepEqual(programErrorOf(text), { programId: LIGHT, code: 6043 });
  });

  it("reads the code off the on-chain failure path, which names no program", () => {
    const text = `transaction failed on-chain: {"InstructionError":[1,{"Custom":6005}]}`;
    assert.deepEqual(programErrorOf(text), { code: 6005 });
  });

  it("gives billing copy only for the billing program", () => {
    assert.equal(explainProgramError(failed(BILLING, 0x1775), tables), BILLING_ERRORS.InsufficientBalance);
    // The caller's hint never overrides a program the logs name: lath's 6005 is not billing's.
    const named = explainProgramError(failed(LATH, 0x1775), tables, "billing")!;
    assert.include(named, "error 6005");
    assert.notEqual(named, BILLING_ERRORS.InsufficientBalance);
  });

  it("never falls back to billing copy by number alone", () => {
    const got = explainProgramError(failed(LIGHT, 0x1775), tables)!;
    assert.include(got, "error 6005");
    assert.notEqual(got, BILLING_ERRORS.InsufficientBalance);
    const deploy = explainProgramError(failed(LATH, 0x1775), tables)!;
    assert.notInclude(Object.values(BILLING_ERRORS), deploy);
  });

  it("uses the caller's hint when the error names no program", () => {
    const text = `transaction failed on-chain: {"InstructionError":[0,{"Custom":6005}]}`;
    assert.equal(explainProgramError(text, tables, "billing"), BILLING_ERRORS.InsufficientBalance);
    assert.include(explainProgramError(text, tables)!, "error 6005");
  });

  it("returns nothing for text that carries no program error", () => {
    assert.isNull(explainProgramError("User rejected the request.", tables));
  });

  it("keys every sentence to a variant the program's IDL declares", () => {
    const billing = new Set(LATH_BILLING_IDL.errors.map((e) => e.name as string));
    for (const name of Object.keys(BILLING_ERRORS)) assert.isTrue(billing.has(name), `billing: ${name}`);
  });

  it("pins the billing codes the copy was written against", () => {
    const code = (name: string) => LATH_BILLING_IDL.errors.find((e) => (e.name as string) === name)?.code;
    // The number-keyed table this replaced read 6007 as a sweep error; it is `BalanceRequired`.
    assert.equal(code("InsufficientBalance"), 6005);
    assert.equal(code("BalanceRequired"), 6007);
    assert.equal(code("SweepExceedsSpent"), 6009);
  });
});
