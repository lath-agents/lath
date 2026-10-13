"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ComputeBudgetProgram, SendTransactionError, Transaction, TransactionInstruction } from "@solana/web3.js";
import { LATH_BILLING_IDL, LATH_IDL, confirmByPolling } from "@lath/sdk/browser";
import { config } from "./config";
import { useSolana } from "./clients";
import { BILLING_ERRORS, explainProgramError, type ErrorHint, type ErrorTable } from "./program-errors";
import { checkPreparedTransaction, type ExpectedGrant } from "./prepared-check";
import { base58, broadcastPrepared, browserNetworkErrorsTransient, type Broadcast } from "./broadcast";

/**
 * Anchor's 8-byte selector for `approve_agent`, read from the IDL `npm run sdk:sync` regenerates.
 * The JSON names it `approve_agent` and the generated type says `approveAgent`, so both are
 * matched; if neither is found the selector is empty and `checkPreparedTransaction` refuses.
 */
const APPROVE_AGENT_DISCRIMINATOR = Uint8Array.from(
  LATH_BILLING_IDL.instructions.find((i) => ["approve_agent", "approveAgent"].includes(i.name as string))
    ?.discriminator ?? []
);

/** `register_agent`'s selector, found the same way, so the check can read which key the header is for. */
const REGISTER_AGENT_DISCRIMINATOR = Uint8Array.from(
  LATH_IDL.instructions.find((i) => ["register_agent", "registerAgent"].includes(i.name as string))?.discriminator ?? []
);

/**
 * The program whose custom errors have user copy, with its IDL's error list — Anchor
 * numbers them from 6000 in declaration order, so the offset *is* the ABI, and the IDL is what
 * `npm run sdk:sync` regenerates from the enum. The rule that picks one is `explainProgramError`
 * (`lib/program-errors.ts`).
 */
const PROGRAM_ERROR_TABLES: Record<ErrorHint, ErrorTable> = {
  billing: {
    programId: config.billingProgramId.toBase58(),
    errors: LATH_BILLING_IDL.errors ?? [],
    copy: BILLING_ERRORS,
  },
};

/**
 * The best sentence we can put in front of a user for a failed transaction.
 *
 * `expect` names the program the caller's transaction was sent to, and is read only when the
 * error names no program — the on-chain failure path, which carries `{"Custom": n}` and nothing
 * else. It never overrides a program the logs name.
 */
export function explainError(e: unknown, expect?: ErrorHint): string {
  const err = e as any;
  const text = [err?.message, err?.toString?.(), JSON.stringify(err?.logs ?? [])].join(" ");

  /**
   * The cluster mismatch, which is the one failure whose message never says what it is.
   *
   * Anchor's `AccountNotInitialized` (3012) on an account this app derived means the PDA is
   * absent from the cluster the transaction was simulated against — and the usual reason is
   * that the wallet is on devnet or mainnet while the app is pointed at a local validator, so
   * the treasury it is looking for was never created there. Checked before the program-error
   * rule below, which would otherwise read it by name and lose the reason.
   */
  if (/AccountNotInitialized|custom program error: 0xbc4|Error Number: 3012/i.test(text))
    return `An account this transaction needs does not exist on ${config.cluster}. Check your wallet is on the same network as the app, and that the treasury has been initialised here.`;

  const program = explainProgramError(text, PROGRAM_ERROR_TABLES, expect);
  if (program) return program;

  if (/user rejected|request rejected|declined/i.test(text)) return "You declined the transaction in your wallet.";

  // "Unexpected error" is what Phantom returns for the cluster mismatch above when it cannot
  // simulate at all.
  if (/unexpected error/i.test(text))
    return `Your wallet could not process this transaction. The usual cause is a network mismatch — the app is on ${config.cluster}, so the wallet has to be too.`;

  /**
   * An empty fee payer. The runtime spells this "attempt to debit an account but found no
   * record of a prior credit", which describes the ledger's position rather than the user's:
   * the account has never been credited on this cluster, so it holds nothing to debit. It is
   * the expected state of a wallet the first time it is pointed at a local validator.
   */
  if (/no record of a prior credit|AccountNotFound|could not find account/i.test(text))
    return `This wallet holds no SOL on ${config.cluster}, so it cannot pay the fee or the rent for the allowance account. Fund it there and try again.`;
  if (/insufficient (lamports|funds)/i.test(text)) return "Not enough SOL to pay the transaction fee and rent.";
  if (/blockhash not found|block height exceeded/i.test(text))
    return "The transaction expired before it landed. Try again.";
  return err?.message ?? "The transaction failed.";
}

export interface SendOptions {
  /**
   * Compute-unit limit. Only Lath (compressed) writes need one — proof verification does not
   * fit in the 200k default. Billing writes are ordinary Solana accounts and cost ~10k, so
   * asking for more just makes them compete for block space.
   */
  computeUnits?: number;
}

/**
 * Builds, signs, sends and confirms a transaction through the connected wallet.
 *
 * The confirmation deserves a word: `confirmTransaction` gives up at the blockhash's last valid
 * block height, and "gave up waiting" is not "failed" — the transaction may already have
 * landed. So a timeout falls through to one signature-status check before anything is reported
 * to the user, which is the difference between a scary error and a slow deposit.
 */
export function useSendTransaction() {
  const connection = useSolana();
  const { publicKey, signTransaction, sendTransaction } = useWallet();

  return useCallback(
    async (instructions: TransactionInstruction[], opts: SendOptions = {}): Promise<string> => {
      if (!publicKey) throw new Error("connect a wallet first");

      const tx = new Transaction();
      if (opts.computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }));
      tx.add(...instructions);

      const latest = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = latest.blockhash;

      /**
       * Sign in the wallet, broadcast from here.
       *
       * `adapter.sendTransaction` hands the whole transaction to the wallet's
       * `signAndSendTransaction`, and the wallet then simulates and broadcasts on *whatever
       * network it is set to* — the `connection` we pass is used to fill in a blockhash the
       * wallet is about to ignore. Against a local validator that fails twice over: the
       * treasury, agent and allowance PDAs do not exist on the wallet's cluster, so its
       * simulation reverts, and a localnet blockhash is not a blockhash there either, so the
       * send fails even if the user clicks through the warning.
       *
       * Splitting the two puts this app's RPC back in charge of where the transaction goes,
       * which is the only arrangement under which `config.rpcUrl` means anything. The wallet
       * may still show a simulation warning when its own network differs from ours — that is
       * its preview, not our send — but the transaction lands on the cluster the app is on.
       */
      let signature: string;
      try {
        signature = signTransaction
          ? await connection.sendRawTransaction((await signTransaction(tx)).serialize(), {
              preflightCommitment: "confirmed",
            })
          : await sendTransaction(tx, connection, { preflightCommitment: "confirmed" });
      } catch (e) {
        // A failed preflight arrives with `logs: null` and a message that says to go and fetch
        // them; the program's own error is in those logs, so without this every on-chain
        // rejection reads as the same generic "simulation failed". `getLogs` is best-effort —
        // if it cannot recover them the original error is still what gets thrown.
        if (e instanceof SendTransactionError && !e.logs) {
          try {
            await e.getLogs(connection);
          } catch {
            /* the original error is the better one to report */
          }
        }
        throw e;
      }
      try {
        // The SDK's polling confirmation, the same one the server runtime uses: no websocket. A
        // browser's dropped request is asked again like any transient failure, rather than reported
        // as a failed write for a transaction that may have landed (`lib/broadcast.ts`).
        await confirmByPolling(browserNetworkErrorsTransient(connection), signature, latest.lastValidBlockHeight);
      } catch (e) {
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        const value = status.value;
        if (!value || (value.confirmationStatus !== "confirmed" && value.confirmationStatus !== "finalized")) throw e;
        if (value.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(value.err)}`);
      }
      return signature;
    },
    [connection, publicKey, signTransaction, sendTransaction]
  );
}

/**
 * The second half of a one-transaction write — a deploy, a clone or a launch — presented until
 * the server can answer it, or until it says the answer will not change.
 *
 * By the time this runs the transaction has **landed**, or was broadcast and this browser could not
 * read whether it did (`useSendPrepared`'s `landed: false`). That is the whole reason it retries: the
 * server keeps the ticket alive when its own RPC has not caught up (`peekDeployTicket`),
 * and a browser that gives up on the first 409 throws that ticket away — leaving a registered,
 * funded agent with no record, under a name `prepareDeployTx` refuses forever. Photon indexes a
 * compressed account a beat behind the transaction that wrote it, and on devnet that beat is
 * routinely longer than one round trip, so this is the ordinary case rather than the rare one.
 *
 * It retries **only** what the server marks `transient`. A permanent refusal — the signature is
 * not the prepared message, the transaction failed on chain — spends the ticket on the first
 * attempt, so retrying it replaces a true reason with "this ticket is unknown or has expired"
 * after the twenty seconds the loop below takes.
 *
 * Shared by the three callers so all three close the same gap the same way. `onWaiting` is how a component
 * says so on screen.
 */
export async function confirmPrepared(
  url: string,
  body: Record<string, unknown>,
  opts: { tries?: number; delayMs?: number; onWaiting?: (attempt: number, of: number) => void } = {}
): Promise<any> {
  // Six over twenty seconds: Photon's lag behind the transaction it indexes is usually a beat
  // and occasionally much worse, and the ticket it is racing lives ten minutes.
  const tries = opts.tries ?? 6;
  const delayMs = opts.delayMs ?? 4000;
  let answer: any = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    // A dropped connection and a body that is not JSON are the two failures this helper existed
    // to survive and did not: `fetch` rejecting propagated straight out of the loop with no
    // retry, and `await res.json()` on a proxy's 502 or an empty 500 threw
    // `SyntaxError: Unexpected end of JSON input` before `answer` was ever assigned. Either one
    // discarded a ticket that had nine and a half minutes left, on the *first* round trip, and
    // reported a parse error as the reason a landed deploy could not be recorded. Both are
    // transient by nature, so both are retried like one.
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      answer = { error: `the console could not be reached: ${e?.message ?? String(e)}`, transient: true };
      if (attempt === tries) break;
      opts.onWaiting?.(attempt + 1, tries);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    try {
      answer = await res.json();
    } catch {
      answer = { error: `the console answered ${res.status} with no readable body`, transient: !res.ok };
      if (res.ok) break;
    }
    if (res.ok) return answer;
    if (!answer?.transient || attempt === tries) break;
    opts.onWaiting?.(attempt + 1, tries);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(answer?.error ?? "the server could not record this write");
}

/**
 * Signs and broadcasts a transaction the **server** built and already partly signed — the
 * one-transaction deploy (`api/agents` `prepare`). The wallet adds the one missing signature;
 * the fee payer is the server's runtime key, so the person spends no SOL for it.
 *
 * `sendTransaction` is not an option here: it re-signs and would drop the signatures already on
 * the transaction. So this needs a wallet that can `signTransaction`, and says so when it cannot.
 *
 * `expect` is the grant the page is asking the user to approve — its own inputs for a deploy, the
 * terms it showed for a copy (`copyGrantExpectation`) — and it is required: the transaction's
 * `approve_agent` is held to it before the prompt, because the wallet shows none of those numbers.
 *
 * Once the transaction is broadcast it resolves with its signature unless the chain gave a verdict
 * against it (`broadcastPrepared`): a send that got no answer is settled like a sent one, since it
 * may have been forwarded, and `landed: false` means the confirmation could not be read, and the
 * caller still presents its ticket, because a ticket thrown away on a network blip orphans a write
 * that lands a moment later.
 */
export function useSendPrepared() {
  const connection = useSolana();
  const { publicKey, signTransaction } = useWallet();

  return useCallback(
    async (base64: string, lastValidBlockHeight: number, expect: ExpectedGrant): Promise<Broadcast> => {
      if (!publicKey) throw new Error("connect a wallet first");
      if (!signTransaction) throw new Error("this wallet cannot sign a prepared transaction");

      const tx = Transaction.from(Buffer.from(base64, "base64"));
      // Refuse before the wallet prompt, not after: the bytes came from the server, and the
      // prompt is the user's one chance to catch an instruction the button did not describe.
      const refused = checkPreparedTransaction(
        tx,
        publicKey,
        {
          lathProgramId: config.lathProgramId,
          billingProgramId: config.billingProgramId,
          approveAgentDiscriminator: APPROVE_AGENT_DISCRIMINATOR,
          registerAgentDiscriminator: REGISTER_AGENT_DISCRIMINATOR,
        },
        expect
      );
      if (refused) throw new Error(refused);
      const signed = await signTransaction(tx);
      // The id is the fee payer's signature, which is on the transaction once every key has signed:
      // read here, before the send, so a send whose answer is lost still leaves a ticket to present.
      if (!signed.signature) throw new Error("the signed transaction carries no fee-payer signature");
      const signature = base58(signed.signature);
      // Serialized before the send so a missing signature throws here, as itself, rather than inside
      // `send` where it would read as an unanswered broadcast and wait out the blockhash.
      const wire = signed.serialize();
      return broadcastPrepared(
        signature,
        async () => {
          try {
            await connection.sendRawTransaction(wire, { preflightCommitment: "confirmed" });
          } catch (e) {
            if (e instanceof SendTransactionError && !e.logs) {
              try {
                await e.getLogs(connection);
              } catch {
                /* the original error is the better one to report */
              }
            }
            throw e;
          }
        },
        // Raised only from a JSON-RPC error the node returned about this transaction. A proxy 502/504
        // or a dropped fetch arrives as a plain `Error`/`TypeError` and may have been forwarded.
        (e) => e instanceof SendTransactionError,
        () => confirmByPolling(browserNetworkErrorsTransient(connection), signature, lastValidBlockHeight),
        async () => (await connection.getSignatureStatus(signature, { searchTransactionHistory: true })).value
      );
    },
    [connection, publicKey, signTransaction]
  );
}
