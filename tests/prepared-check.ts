/**
 * What the browser will sign of a server-prepared deploy. No validator, no wallet: the
 * check is a pure function of the transaction's instructions, and the shapes below are the one
 * `prepareDeployTx` builds plus the ways a hostile server could widen it.
 *
 * The grant is built by the real `BillingClient.approveAgentIx` — the builder `prepareDeployTx`
 * calls — so the arg offsets the check decodes are the ones the IDL actually encodes, not a copy
 * of them. It needs no RPC: building an instruction derives two PDAs and encodes the args, and the
 * connection below points at a port nothing listens on.
 */
import { assert } from "chai";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BillingClient } from "../sdk/src/billing";
import { LATH_BILLING_IDL, LATH_IDL } from "../sdk/src/idl";
import {
  CLOCK_SLACK_SEC,
  checkPreparedTransaction,
  copyGrantExpectation,
  decodeApproveAgent,
  type ExpectedGrant,
} from "../frontend/src/lib/prepared-check";

const selector = (idl: any, names: string[]) =>
  Uint8Array.from(idl.instructions.find((i: any) => names.includes(i.name))?.discriminator ?? []);
const lathProgramId = new PublicKey(LATH_IDL.address);
const billingProgramId = new PublicKey(LATH_BILLING_IDL.address);
const approveAgentDiscriminator = selector(LATH_BILLING_IDL, ["approve_agent", "approveAgent"]);
const registerAgentDiscriminator = selector(LATH_IDL, ["register_agent", "registerAgent"]);
const ids = { lathProgramId, billingProgramId, approveAgentDiscriminator, registerAgentDiscriminator };

const wallet = Keypair.generate().publicKey;
const server = Keypair.generate().publicKey;
const agentKey = Keypair.generate();
const agent = agentKey.publicKey;
const billing = BillingClient.fromIdl(new Connection("http://127.0.0.1:9"), agentKey);

const CAP = 2_500_000n;
const EXPIRES = 1_900_000_000n;
const HASH = new Uint8Array(32).fill(9);
const expect: ExpectedGrant = { agentAuthority: agent, cap: CAP, expiresAt: EXPIRES, policyVersionHash: HASH };

const ix = (programId: PublicKey, keys: PublicKey[], data: number[] | Uint8Array = []) =>
  new TransactionInstruction({
    programId,
    keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.from(data),
  });
const approve = (
  p: Partial<{ agentAuthority: PublicKey; cap: bigint; expiresAt: bigint; hash: Uint8Array; user: PublicKey }> = {}
) =>
  billing.approveAgentIx({
    agentAuthority: p.agentAuthority ?? agent,
    cap: p.cap ?? CAP,
    expiresAt: p.expiresAt ?? EXPIRES,
    policyVersionHash: (p.hash ?? HASH) as any,
    user: p.user ?? wallet,
  });
/** `register_agent` as far as the check reads it: the selector, then `authority` as the first account. */
const register = (authority: PublicKey = agent) => ix(lathProgramId, [authority], [...registerAgentDiscriminator, 0]);

/** The deploy as `prepareDeployTx` builds it: top-up, budget, register, approve; server pays. */
async function deploy(
  opts: { grant?: TransactionInstruction; registrar?: PublicKey } = {},
  ...extra: TransactionInstruction[]
) {
  const tx = new Transaction();
  tx.feePayer = server;
  tx.add(
    SystemProgram.transfer({ fromPubkey: server, toPubkey: agent, lamports: 1 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    register(opts.registrar),
    opts.grant ?? (await approve()),
    ...extra
  );
  return tx;
}

describe("prepared transaction check", () => {
  it("passes the deploy prepareDeployTx builds", async () => {
    assert.isNull(checkPreparedTransaction(await deploy(), wallet, ids, expect));
  });

  it("decodes approve_agent at the IDL's offsets", async () => {
    const args = decodeApproveAgent((await approve()).data)!;
    assert.isTrue(args.agentAuthority.equals(agent));
    assert.equal(args.cap, CAP);
    assert.equal(args.expiresAt, EXPIRES);
    assert.deepEqual(Array.from(args.policyVersionHash), Array.from(HASH));
  });

  it("refuses a transfer out of the wallet riding along", async () => {
    const tx = await deploy({}, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: server, lamports: 1 }));
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /names your wallet in instruction 4/);
  });

  it("refuses another billing instruction that names the wallet (a deposit, say)", async () => {
    const tx = await deploy({}, ix(billingProgramId, [wallet], [1, 1, 1, 1, 1, 1, 1, 1]));
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /not the allowance/);
  });

  it("refuses a program outside the four", async () => {
    const tx = await deploy({}, ix(Keypair.generate().publicKey, [server]));
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /a program this app never uses/);
  });

  it("refuses a wallet-paid transaction", async () => {
    const tx = await deploy();
    tx.feePayer = wallet;
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /pay its fee/);
  });

  it("refuses no allowance and two allowances", async () => {
    const none = new Transaction();
    none.feePayer = server;
    none.add(register());
    assert.match(checkPreparedTransaction(none, wallet, ids, expect)!, /no allowance/);
    assert.match(checkPreparedTransaction(await deploy({}, await approve()), wallet, ids, expect)!, /more than one/);
  });

  it("fails closed when a selector is missing", async () => {
    const tx = await deploy();
    const r = checkPreparedTransaction(tx, wallet, { ...ids, approveAgentDiscriminator: new Uint8Array() }, expect);
    assert.match(r!, /cannot recognise an allowance/);
    const s = checkPreparedTransaction(tx, wallet, { ...ids, registerAgentDiscriminator: new Uint8Array() }, expect);
    assert.match(s!, /cannot recognise a registration/);
  });

  it("fails closed when the page names no cap or no expiry to hold the grant to", async () => {
    const tx = await deploy();
    assert.match(
      checkPreparedTransaction(tx, wallet, ids, { agentAuthority: agent, expiresAt: EXPIRES })!,
      /no cap or expiry/
    );
    assert.match(checkPreparedTransaction(tx, wallet, ids, { agentAuthority: agent, cap: CAP })!, /no cap or expiry/);
  });

  // The gap the verify wave found: the check matched only the selector, so every one of these
  // passed and the wallet signed a grant the user never saw.
  it("refuses an inflated cap", async () => {
    const tx = await deploy({ grant: await approve({ cap: 18_446_744_073_709_551_615n }) });
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /caps at .* not the 2\.50 USDC you approved/);
  });

  it("refuses a grant to a foreign agent authority", async () => {
    const attacker = Keypair.generate().publicKey;
    const tx = await deploy({ grant: await approve({ agentAuthority: attacker }) });
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, new RegExp(`is for ${attacker.toBase58()}`));
  });

  it("refuses an authority the page was told but register_agent does not register", async () => {
    const other = Keypair.generate().publicKey;
    const tx = await deploy({ grant: await approve({ agentAuthority: other }), registrar: agent });
    const r = checkPreparedTransaction(tx, wallet, ids, { ...expect, agentAuthority: other });
    assert.match(r!, /registers the agent under/);
  });

  it("refuses a wrong expiry", async () => {
    const tx = await deploy({ grant: await approve({ expiresAt: 99_999_999_999n }) });
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /expires on .* not the/);
  });

  it("refuses a different policy version hash", async () => {
    const tx = await deploy({ grant: await approve({ hash: new Uint8Array(32).fill(1) }) });
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /policy version hash/);
  });

  it("refuses the wallet anywhere but the grant's user slot", async () => {
    // The allowance is some other user's, with the wallet riding in the treasury slot.
    const real = await approve({ user: Keypair.generate().publicKey });
    const keys = real.keys.map((k, i) => (i === 1 ? { ...k, pubkey: wallet } : k));
    const tx = await deploy({ grant: new TransactionInstruction({ ...real, keys }) });
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /not granted by your wallet/);
  });

  it("refuses a grant whose data is not the 88 bytes approve_agent encodes", async () => {
    const real = await approve();
    const tx = await deploy({
      grant: new TransactionInstruction({ ...real, data: Buffer.concat([real.data, Buffer.from([0])]) }),
    });
    assert.match(checkPreparedTransaction(tx, wallet, ids, expect)!, /does not have the shape/);
  });

  describe("copy expectation (clone, launch)", () => {
    const now = 1_800_000_000;
    const reported = (cap: bigint, expiresAt: bigint) => ({
      authority: agent.toBase58(),
      allowance: {
        capMicroUsdc: cap.toString(),
        expiresAt: expiresAt.toString(),
        policyVersionHash: Buffer.from(HASH).toString("hex"),
      },
    });
    const thirtyDays = BigInt(now + 30 * 86400);

    it("passes a grant at the terms on screen", async () => {
      const e = copyGrantExpectation(reported(CAP, thirtyDays), { budgetCapUsdc: "2.50", expirationDays: 30 }, now);
      assert.notTypeOf(e, "string");
      const tx = await deploy({ grant: await approve({ expiresAt: thirtyDays }) });
      assert.isNull(checkPreparedTransaction(tx, wallet, ids, e as ExpectedGrant));
    });

    it("refuses a reported cap above the one on screen, even when the transaction matches the report", async () => {
      const big = 50_000_000n;
      const e = copyGrantExpectation(reported(big, thirtyDays), { budgetCapUsdc: "2.50", expirationDays: 30 }, now);
      const tx = await deploy({ grant: await approve({ cap: big, expiresAt: thirtyDays }) });
      assert.match(
        checkPreparedTransaction(tx, wallet, ids, e as ExpectedGrant)!,
        /above the 2\.50 USDC this page showed/
      );
    });

    it("refuses an expiry past the days on screen, and allows the clocks an hour", async () => {
      const late = BigInt(now + 30 * 86400 + CLOCK_SLACK_SEC + 1);
      const e = copyGrantExpectation(reported(CAP, late), { budgetCapUsdc: "2.50", expirationDays: 30 }, now);
      const tx = await deploy({ grant: await approve({ expiresAt: late }) });
      assert.match(checkPreparedTransaction(tx, wallet, ids, e as ExpectedGrant)!, /later than/);
      const skewed = BigInt(now + 30 * 86400 + CLOCK_SLACK_SEC);
      const ok = copyGrantExpectation(reported(CAP, skewed), { budgetCapUsdc: "2.50", expirationDays: 30 }, now);
      const tx2 = await deploy({ grant: await approve({ expiresAt: skewed }) });
      assert.isNull(checkPreparedTransaction(tx2, wallet, ids, ok as ExpectedGrant));
    });

    it("refuses a transaction that differs from the allowance the answer reported", async () => {
      const e = copyGrantExpectation(reported(CAP, thirtyDays), { budgetCapUsdc: "10", expirationDays: 30 }, now);
      const tx = await deploy({ grant: await approve({ cap: 5_000_000n, expiresAt: thirtyDays }) });
      assert.match(checkPreparedTransaction(tx, wallet, ids, e as ExpectedGrant)!, /not the 2\.50 USDC you approved/);
    });

    it("refuses when nothing was on screen, even an answer that reports its own terms", () => {
      // An answer's `terms` standing in for a page that showed none would hold the grant only to the
      // server's numbers; the launch panel keeps Launch off until it has terms.
      const withTerms = { ...reported(CAP, thirtyDays), terms: { budgetCapUsdc: "2.50", expirationDays: 30 } };
      assert.match(copyGrantExpectation(withTerms, null, now) as string, /no terms/);
      assert.match(copyGrantExpectation(reported(CAP, thirtyDays), null, now) as string, /no terms/);
      assert.match(copyGrantExpectation({ authority: agent.toBase58() }, null, now) as string, /did not say/);
    });
  });
});
