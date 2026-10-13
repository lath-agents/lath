import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

/**
 * The grant the page expects `approve_agent` to carry, compared field by field before the wallet
 * is asked.
 *
 * Each bound is either exact (`cap`, `expiresAt`) or a ceiling (`maxCap`, `maxExpiresAt`), and at
 * least one of each pair has to be given: a caller that named neither would be back to signing
 * whatever grant the server chose, so that fails closed rather than passing. A ceiling exists for
 * the copies, where the page shows the terms it read from the same console and an honest answer
 * can legitimately come back lower (a listing's template version, an older record),
 * but never higher than what was on screen.
 */
export interface ExpectedGrant {
  /** The agent key the grant is to: the prepare answer's `authority`, and register_agent's signer. */
  agentAuthority: PublicKey;
  cap?: bigint;
  maxCap?: bigint;
  expiresAt?: bigint;
  maxExpiresAt?: bigint;
  /** 32 bytes, when the page computed or was told the hash it is approving. */
  policyVersionHash?: Uint8Array;
}

/** `approve_agent`'s Anchor args after the selector: pubkey, u64, i64, [u8; 32] — 88 bytes in all. */
const APPROVE_DATA_LEN = 8 + 32 + 8 + 8 + 32;

/** The args of one `approve_agent`, read at the offsets `sdk/src/idl/lath-billing.json` fixes. */
export function decodeApproveAgent(data: Uint8Array): {
  agentAuthority: PublicKey;
  cap: bigint;
  expiresAt: bigint;
  policyVersionHash: Uint8Array;
} | null {
  if (data.length !== APPROVE_DATA_LEN) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    agentAuthority: new PublicKey(data.slice(8, 40)),
    cap: view.getBigUint64(40, true),
    expiresAt: view.getBigInt64(48, true),
    policyVersionHash: data.slice(56, 88),
  };
}

/** How far the server's clock may run ahead of the browser's before an expiry reads as longer than shown. */
export const CLOCK_SLACK_SEC = 3600;

/** USDC as the page shows it ("2.50") to the micro-units a grant carries, rounded as every caller rounds. */
const micro = (usdc: string | number) => BigInt(Math.round(Number(usdc) * 1_000_000));

/**
 * The expectation for a copy — a clone or a market launch — whose grant the server computes.
 *
 * The page did not choose these numbers, so the exact values are the ones the prepare answer
 * reported (`allowance`), and what the page *showed* bounds them: the cap may not exceed the cap on
 * screen, nor the expiry the days on screen counted from now (plus an hour for the two clocks).
 * With nothing on screen (`shown` null) it refuses: falling back to the terms the same answer
 * reports would hold the grant only to the server's own numbers for a launch whose source this
 * console had not listed yet, with the cap first appearing on screen while the wallet prompt was
 * already open. The launch panel keeps *Launch* off until it has terms to show, so nothing passes
 * null. Returns a sentence when the answer cannot be held to what was shown.
 */
export function copyGrantExpectation(
  prepared: {
    authority?: unknown;
    allowance?: { capMicroUsdc?: unknown; expiresAt?: unknown; policyVersionHash?: unknown } | null;
  },
  shown: { budgetCapUsdc: string; expirationDays: number } | null,
  nowSec: number = Math.floor(Date.now() / 1000)
): ExpectedGrant | string {
  const a = prepared.allowance;
  let authority: PublicKey;
  let cap: bigint;
  let expiresAt: bigint;
  let hash: Uint8Array;
  try {
    authority = new PublicKey(String(prepared.authority));
    cap = BigInt(String(a?.capMicroUsdc));
    expiresAt = BigInt(String(a?.expiresAt));
    hash = Uint8Array.from(Buffer.from(String(a?.policyVersionHash), "hex"));
    if (hash.length !== 32) throw new Error("not 32 bytes");
  } catch {
    return "the console did not say which allowance it prepared; refusing to sign";
  }
  // Only what the page showed bounds the grant; the answer's own `terms` are not a substitute,
  // because the server choosing them is the case this check exists for.
  const bound = shown;
  if (!bound || !Number.isFinite(Number(bound.budgetCapUsdc)) || !Number.isFinite(bound.expirationDays)) {
    return "this page has no terms to hold the prepared allowance to; refusing to sign";
  }
  return {
    agentAuthority: authority,
    cap,
    maxCap: micro(bound.budgetCapUsdc),
    expiresAt,
    maxExpiresAt: BigInt(nowSec + Math.round(bound.expirationDays * 86400) + CLOCK_SLACK_SEC),
    policyVersionHash: hash,
  };
}

const usdc = (m: bigint) => `${(Number(m) / 1_000_000).toFixed(2)} USDC`;
const date = (s: bigint) => {
  const d = new Date(Number(s) * 1000);
  return Number.isNaN(d.getTime()) ? String(s) : d.toISOString().slice(0, 10);
};

/**
 * What a transaction the server prepared may ask the wallet to sign.
 *
 * Deploy, clone and market launch each hand the browser a transaction the server built and has
 * already partly signed (`prepareDeployTx`), and the wallet adds the one signature still missing.
 * The wallet shows the user little it can check, so without this the page signs whatever bytes the
 * server returns: a compromised or impersonated server could put a `SystemProgram.transfer` from
 * the wallet, or a `deposit` that moves its USDC, next to the deploy and get it signed in the same
 * prompt.
 *
 * The rule is the shape `prepareDeployTx` builds and nothing wider: every top-level instruction is
 * lath, lath-billing, System or ComputeBudget, the wallet is not the fee payer (the server's
 * runtime key pays), and the wallet appears in exactly one instruction, lath-billing's
 * `approve_agent`, in its `user` slot. Checking where the wallet appears, rather than decoding
 * every instruction, is what keeps this small: an instruction that does not name the wallet cannot
 * spend from it, whatever else it does.
 *
 * The one instruction that does name it is decoded, because its arguments *are* the spending: a
 * grant is `agent_authority`, `cap` and `expires_at`, and a re-grant resets `spent` to zero, so an
 * `approve_agent` with the server's numbers rather than the page's would let the server's key charge
 * whatever it liked for as long as it liked in the one prompt the user thought was the deploy. So
 * the args are held to `expect`, and the agent authority also to the key `register_agent` names as
 * the new header's authority — the grant goes to the agent being created, not to a key beside it.
 *
 * Pure and free of `@/` imports so a Node suite can load it (`tests/prepared-check.ts`).
 */
export function checkPreparedTransaction(
  tx: Transaction,
  wallet: PublicKey,
  p: {
    lathProgramId: PublicKey;
    billingProgramId: PublicKey;
    approveAgentDiscriminator: Uint8Array;
    registerAgentDiscriminator: Uint8Array;
  },
  expect: ExpectedGrant
): string | null {
  // An empty selector would match every billing instruction (`every` over nothing is true), so an
  // IDL that lost `approve_agent` fails closed here instead of waving a `deposit` through.
  if (p.approveAgentDiscriminator.length !== 8) return "this app cannot recognise an allowance; refusing to sign";
  if (p.registerAgentDiscriminator.length !== 8) return "this app cannot recognise a registration; refusing to sign";
  if (
    (expect.cap === undefined && expect.maxCap === undefined) ||
    (expect.expiresAt === undefined && expect.maxExpiresAt === undefined)
  ) {
    return "this page has no cap or expiry to hold the allowance to; refusing to sign";
  }
  const allowed = [p.lathProgramId, p.billingProgramId, SystemProgram.programId, ComputeBudgetProgram.programId];
  if (tx.feePayer?.equals(wallet)) {
    return "the prepared transaction makes your wallet pay its fee; this app never asks for that";
  }
  const selects = (data: Uint8Array, sel: Uint8Array) => data.length >= 8 && sel.every((b, j) => data[j] === b);
  let grant: TransactionInstruction | null = null;
  let grants = 0;
  const registrars: PublicKey[] = [];
  for (const [i, ix] of tx.instructions.entries()) {
    if (!allowed.some((id) => id.equals(ix.programId))) {
      return `the prepared transaction calls ${ix.programId.toBase58()} (instruction ${i}), a program this app never uses`;
    }
    if (ix.programId.equals(p.lathProgramId) && selects(ix.data, p.registerAgentDiscriminator)) {
      // `register_agent`'s one named account is `authority`, the signer the header records.
      if (ix.keys[0]) registrars.push(ix.keys[0].pubkey);
    }
    if (!ix.keys.some((k) => k.pubkey.equals(wallet))) continue;
    const isGrant = ix.programId.equals(p.billingProgramId) && selects(ix.data, p.approveAgentDiscriminator);
    if (!isGrant) {
      return `the prepared transaction names your wallet in instruction ${i}, which is not the allowance you are approving`;
    }
    grant = ix;
    grants++;
  }
  if (grants !== 1 || !grant) {
    return grants === 0
      ? "the prepared transaction has no allowance for your wallet to approve"
      : "the prepared transaction asks your wallet to approve more than one allowance";
  }

  // `user` is the grant's first account: the wallet anywhere else in it would be an allowance
  // somebody else grants, with the wallet along for a signature it was never meant to give.
  if (!grant.keys[0]?.pubkey.equals(wallet)) {
    return "the prepared allowance is not granted by your wallet (it is not in the user slot)";
  }
  const args = decodeApproveAgent(grant.data);
  if (!args) return "the prepared allowance does not have the shape this app builds; refusing to sign";
  if (!args.agentAuthority.equals(expect.agentAuthority)) {
    return `the prepared allowance is for ${args.agentAuthority.toBase58()}, not the agent ${expect.agentAuthority.toBase58()} being created`;
  }
  if (registrars.length !== 1 || !registrars[0].equals(expect.agentAuthority)) {
    return registrars.length === 1
      ? `the prepared transaction registers the agent under ${registrars[0].toBase58()}, not the key the allowance is for`
      : "the prepared transaction does not register exactly one agent";
  }
  if (expect.cap !== undefined && args.cap !== expect.cap) {
    return `the prepared allowance caps at ${usdc(args.cap)}, not the ${usdc(expect.cap)} you approved`;
  }
  if (expect.maxCap !== undefined && args.cap > expect.maxCap) {
    return `the prepared allowance caps at ${usdc(args.cap)}, above the ${usdc(expect.maxCap)} this page showed`;
  }
  if (expect.expiresAt !== undefined && args.expiresAt !== expect.expiresAt) {
    return `the prepared allowance expires on ${date(args.expiresAt)}, not the ${date(expect.expiresAt)} you approved`;
  }
  if (expect.maxExpiresAt !== undefined && args.expiresAt > expect.maxExpiresAt) {
    return `the prepared allowance expires on ${date(args.expiresAt)}, later than the ${date(
      expect.maxExpiresAt
    )} this page showed`;
  }
  if (
    expect.policyVersionHash &&
    (expect.policyVersionHash.length !== 32 ||
      !expect.policyVersionHash.every((b, j) => args.policyVersionHash[j] === b))
  ) {
    return "the prepared allowance commits a different policy version hash from the one this page computed";
  }
  return null;
}
