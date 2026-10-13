/**
 * The agent's Tempo key is derived from its Solana key.
 *
 * `payer` in every Action blob on the `tempo` rail is the address this derivation yields, and
 * `verifyInference` checks a record's `payer` against the agent that wrote it by re-deriving,
 * never by a table. The domain string is therefore ABI: the vector
 * below is a literal, and a change to the domain, the byte order or the counter fails it.
 *
 * Node-only: no network, no key that was ever funded.
 */
import { createHash } from "crypto";
import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  SECP256K1_N,
  TEMPO_CHAIN_ID,
  TEMPO_KEY_DOMAIN,
  maxDepositBase,
  perCallCeiling,
  railFor,
  tempoAccountFor,
  tempoPrivateKeyFor,
} from "../frontend/src/app/api/_lib/tempo";

/** A fixed seed: bytes 1..32. Not a key anyone holds money at. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

describe("the Tempo key of an agent", () => {
  it("is derived under exactly this domain", () => {
    // A frozen derivation input, not the product name: this domain derives the treasury address
    // that already holds USDC.e, so its bytes never change — it is one of the `lattice` literals
    // docs/ARCHITECTURE.md §13 lists as frozen. Pinned as a digest rather than as the string: a
    // rename sweep rewrites a spelled-out literal on both sides of an `assert.equal` and the test
    // still passes, but it cannot rewrite a hex digest. The value is sha256 of the domain,
    // computed outside this codebase.
    assert.equal(
      createHash("sha256").update(TEMPO_KEY_DOMAIN, "utf8").digest("hex"),
      "dbeb0d0df9bd654dd6f40f866ee3f097a95316fc859564f0dbb31cc57417406f"
    );
    assert.equal(TEMPO_CHAIN_ID, 4217);
  });

  it("maps a fixed 32-byte secret to a fixed address", () => {
    const kp = Keypair.fromSeed(SEED);
    const a = tempoAccountFor(kp);
    assert.equal(a.index, 0);
    // The pinned vector. `payer` on a record written by this key is this string; the test is
    // the literal, not a re-derivation.
    assert.equal(a.address, "0x749d38880f1974de12E841B5D4a23FC980a89117");
    assert.equal(
      Buffer.from(tempoPrivateKeyFor(SEED).key).toString("hex"),
      "ab4d9d666a8975a67288fac712ccb29e7960947c338328d65bd808ccf8f3fd6a"
    );
  });

  it("uses the seed half of the Solana secret only, so a sealed agent secret keeps the address", () => {
    const kp = Keypair.fromSeed(SEED);
    const fromSeed = tempoPrivateKeyFor(SEED).key;
    const fromKeypair = tempoPrivateKeyFor(kp.secretKey.slice(0, 32)).key;
    assert.deepEqual(Buffer.from(fromSeed), Buffer.from(fromKeypair));
  });

  it("walks the counter when the digest is not below the curve order", () => {
    // With the real order the loop ends at i = 0 with probability 1 − 2^-128, so it is exercised
    // by lowering the order to the first digest itself: k < order then fails and i = 1 is taken.
    const first = tempoPrivateKeyFor(SEED, SECP256K1_N);
    let k = BigInt(0);
    for (const b of first.key) k = (k << BigInt(8)) | BigInt(b);
    assert.isTrue(k > BigInt(0) && k < SECP256K1_N);
    const next = tempoPrivateKeyFor(SEED, k);
    assert.equal(next.index, 1);
    assert.equal(
      Buffer.from(next.key).toString("hex"),
      "6b0696d4203acb0280ce71d3098364dfcefc315bab5c3fc8c029c5574b38d102"
    );
    assert.notDeepEqual(Buffer.from(next.key), Buffer.from(first.key));
  });

  it("rejects a secret that is not 32 bytes", () => {
    assert.throws(() => tempoPrivateKeyFor(new Uint8Array(31)), /32-byte/);
  });
});

describe("the rail an agent runs on", () => {
  const saved = process.env.LATH_TEMPO_TREASURY;
  afterEach(() => {
    if (saved === undefined) delete process.env.LATH_TEMPO_TREASURY;
    else process.env.LATH_TEMPO_TREASURY = saved;
  });

  it("is scripted whatever the record says while the treasury is empty (the --e2e pin)", () => {
    // `tempoTreasury()` memoises per process, so this suite can only observe the state the
    // process started in: the pin is the one every node-only suite runs under.
    //
    // `scripted`, not `vault`: the deployment holds no model API key, so there is no rail to fall
    // back to. An empty treasury is therefore not a choice of rail but the absence of anything that
    // can pay, which is what the `--e2e` pin has to guarantee — a suite must not be able to spend
    // mainnet money through a record it seeded, and there is no second way to spend the operator's
    // money either.
    process.env.LATH_TEMPO_TREASURY = "";
    assert.equal(railFor("tempo", true), "scripted");
    assert.equal(railFor(undefined, true), "scripted");
    assert.equal(railFor("vault", true), "scripted");
    // No key this server holds, so no voucher it could sign: a wallet-authority agent is scripted
    // whatever the treasury holds.
    assert.equal(railFor("tempo", false), "scripted");
  });
});

/**
 * The deposit a session asks the treasury to hold is `maxCostBase × (maxSteps + 1)`, and
 * `maxCostBase` is one call's ceiling — so the number a caller hands over is not the session's
 * budget. Handing over the budget would ask for a deposit no treasury holds; these are the
 * arithmetic of that mistake and of the right figure, with the measured call price beside them.
 */
describe("what one tempo session asks the treasury to hold", () => {
  /** The console's session defaults: 0.25 USDC over six assistant turns. */
  const CAP = BigInt(250_000);
  const STEPS = 6;

  it("wants 1.75 USDC.e if the session cap is passed as a call's ceiling", () => {
    assert.equal(maxDepositBase(CAP, STEPS).toString(), "1750000");
  });

  it("wants a little over the cap once the cap is shared across the turns", () => {
    const perCall = perCallCeiling(CAP, STEPS);
    assert.equal(perCall.toString(), "41666");
    const deposit = maxDepositBase(perCall, STEPS);
    assert.equal(deposit.toString(), "291662");
    // The property that matters: the deposit still covers the whole session, so a channel cannot
    // run out inside it, and it is within a treasury holding 1 322 131 (a measured balance).
    assert.isTrue(deposit >= CAP);
    assert.isTrue(deposit < BigInt(1_322_131));
    // And it is many calls' worth at the measured price of deepseek-v4.1-flash.
    assert.isTrue(perCall > BigInt(1_500));
  });

  it("never asks for a zero deposit, whatever the cap", () => {
    assert.equal(perCallCeiling(BigInt(0), STEPS).toString(), "1");
    assert.equal(perCallCeiling(BigInt(3), STEPS).toString(), "1");
    // A step count of zero is not a session; the divisor is floored rather than throwing.
    assert.equal(perCallCeiling(CAP, 0).toString(), "250000");
  });

  it("is what a loop passes: a per-step budget", () => {
    // `_lib/loops.ts` hands `budgetMicroUsdcPerStep` straight over — 3 000 a step needs 21 000
    // held, which a treasury holds.
    assert.equal(maxDepositBase(BigInt(3_000), STEPS).toString(), "21000");
  });
});
