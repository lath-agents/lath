/**
 * The loop receipt's one network write: one `createAttestation` under the loop's committed pointer,
 * signed and paid for by the console's runtime key, at the address derived from the loop id. Kept apart
 * from `loop-receipt.ts`, which decides *when* (after a goal-reached stop's settle) and keeps the row,
 * so a suite can stand a fake in through `SolanaKeySeams.publishReceipt` and nothing under `tests/`
 * sends a devnet transaction.
 *
 * Re-entrant: an account already at the address that holds exactly this receipt, signed by the pointer's
 * key, is a success (a restart after a publish whose row write was lost); any other account there is a
 * refusal rather than a second create, which the System Program would refuse anyway.
 */
import { PublicKey, TransactionMessage, VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import {
  SAS_PROGRAM_ID,
  decodeSasAttestationAccount,
  loopReceiptAddress,
  loopReceiptBytes,
  loopReceiptNonce,
  type LoopReceipt,
  type LoopReceiptPointer,
} from "@lath/sdk";
import { createAttestationInstruction, decodeCredential, sasFailure } from "@lath/runtime/plugins";

const SAS = new PublicKey(SAS_PROGRAM_ID);

/**
 * `LATH_PROTOCOL_PLUGINS`: on for `1`, `on`, `true` or `yes`; anything else, or unset, is off. Read per call.
 * Whether this console offers SAS · receipt, the one protocol plugin in this build.
 */
export function protocolPluginsEnabled(): boolean {
  return /^(1|on|true|yes)$/i.test((process.env.LATH_PROTOCOL_PLUGINS ?? "").trim());
}

export interface PublishReceiptArgs {
  connection: Connection;
  signer: Keypair;
  pointer: LoopReceiptPointer;
  loopId: string;
  values: LoopReceipt;
}

export interface PublishedReceipt {
  /** The receipt's address. */
  attestation: string;
  /** The create's signature; absent when the receipt was found already there. */
  signature?: string;
  slot?: number;
  /** True when this call found the receipt already published and sent nothing. */
  found?: true;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Publishes one loop's receipt, or throws with the reason in words (never the RPC url). */
export async function publishLoopReceipt(args: PublishReceiptArgs): Promise<PublishedReceipt> {
  const { connection, signer, pointer, loopId, values } = args;
  if (signer.publicKey.toBase58() !== pointer.signer) {
    throw new Error(`the signing key is ${signer.publicKey.toBase58()}, not the policy's ${pointer.signer}`);
  }
  const data = loopReceiptBytes(values);
  const attestation = loopReceiptAddress(pointer, loopId);
  const address = new PublicKey(attestation);

  const [existing, credentialInfo] = await connection.getMultipleAccountsInfo(
    [address, new PublicKey(pointer.credential)],
    "confirmed"
  );
  if (existing) {
    const decoded = existing.owner.equals(SAS) ? decodeSasAttestationAccount(existing.data) : null;
    if (decoded && decoded.signer === pointer.signer && sameBytes(decoded.data, data)) {
      return { attestation, found: true };
    }
    throw new Error(`an account is already at ${attestation} and it is not this loop's receipt`);
  }
  // SAS refuses an unauthorized signer with 5; said here first, with what to run, rather than as a code.
  const credential = decodeCredential(credentialInfo as Parameters<typeof decodeCredential>[0]);
  if (!credential) throw new Error(`the credential ${pointer.credential} is not on devnet`);
  if (!credential.authorizedSigners.includes(pointer.signer)) {
    throw new Error(
      `the credential's issuer has not authorized ${pointer.signer} to sign receipts: ` +
        `npm run -s demo-attest:authorize -- --key ${pointer.signer}`
    );
  }

  const ix = createAttestationInstruction({
    payer: signer.publicKey,
    signer: signer.publicKey,
    credential: new PublicKey(pointer.credential),
    schema: new PublicKey(pointer.schema),
    nonce: new PublicKey(loopReceiptNonce(loopId)),
    data,
    // None: a receipt is a record of what the loop did, and does not lapse.
    expiry: BigInt(0),
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message()
  );
  tx.sign([signer]);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  } catch (e) {
    throw new Error(`the receipt did not simulate: ${sasFailure(e).words}`);
  }
  const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmed.value.err) {
    throw new Error(`SAS refused the receipt: ${sasFailure(confirmed.value.err).words} (${signature})`);
  }
  // Read back, so "published" means the account holds these bytes, not that a transaction confirmed.
  const back = await connection.getAccountInfo(address, "confirmed");
  const decoded = back?.owner.equals(SAS) ? decodeSasAttestationAccount(back.data) : null;
  if (!decoded || !sameBytes(decoded.data, data)) {
    throw new Error(`the receipt's transaction ${signature} confirmed, and ${attestation} does not hold it`);
  }
  const status = await connection.getSignatureStatuses([signature]).catch(() => null);
  const slot = status?.value?.[0]?.slot;
  return { attestation, signature, ...(typeof slot === "number" ? { slot } : {}) };
}
