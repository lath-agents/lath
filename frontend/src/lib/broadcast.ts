/**
 * What a broadcast prepared transaction's confirmation said, read so that only a verdict ends the
 * flow without presenting its ticket.
 *
 * A deploy, a clone and a launch are each one transaction the server prepares, the wallet signs and
 * this browser broadcasts; the console records it only when the ticket `prepare` issued comes back
 * with the signature (`confirmPrepared`). Ending the flow on any failure of the confirmation poll
 * would orphan transactions: a browser's dropped request rejects with `Failed to fetch` (Chrome),
 * `Load failed` (Safari) or `NetworkError when attempting to fetch resource.` (Firefox) — none of
 * which the SDK's `TRANSIENT_RPC_ERROR` names, since it knows Node's `fetch failed` — so one blip on
 * the first poll would end it, a status read a second later would find nothing yet, and a
 * transaction that landed moments after would leave a registered, funded agent with no record under
 * a name every later prepare refuses (the server cannot adopt it).
 *
 * So the flow ends without the ticket only on an answer about the transaction itself: it failed on
 * chain, or its blockhash expired with no status anywhere in history. Anything else — a poll error
 * that is not a verdict, an RPC that answered only transient errors, a status read that failed — is
 * `landed: false`, and the caller presents the ticket anyway: the console reads the transaction
 * itself, keeps the ticket while it cannot see it (`deployTxSignedBy` answers that as transient),
 * and refuses for good what failed. Presenting a ticket asks the wallet for nothing, so it is still
 * one prompt per action.
 *
 * No imports, so the node suite (`tests/read-retry.ts`) runs it against the SDK's real
 * `confirmByPolling` over a fake cluster; `lib/writes.ts` cannot be imported there.
 */

/** A browser's own words for a request that never got an answer: Chrome, Safari, Firefox. */
export const BROWSER_NETWORK_ERROR = /failed to fetch|load failed|networkerror/i;

/**
 * `connection` with every rejection that is a browser network failure re-thrown in words the SDK's
 * poll treats as transient (`network error`, in `TRANSIENT_RPC_ERROR`), so a blip is asked again for
 * as long as any other transient failure would be rather than ending the poll at once. Every other
 * rejection, and every answer, passes through untouched.
 */
export function browserNetworkErrorsTransient<T extends object>(connection: T): T {
  return new Proxy(connection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = value.apply(target, args);
        if (!out || typeof (out as Promise<unknown>).then !== "function") return out;
        return (out as Promise<unknown>).catch((e: unknown) => {
          const said = (e as Error)?.message ?? String(e);
          if (!BROWSER_NETWORK_ERROR.test(said)) throw e;
          throw Object.assign(new Error(`network error: ${said}`), { cause: e });
        });
      };
    },
  });
}

/** A broadcast transaction, and whether this browser saw it land. */
export interface Broadcast {
  signature: string;
  /**
   * `true` when the poll or the status read after it saw the transaction confirmed. `false` when
   * neither could say — whether it landed is not known here, and the caller presents its ticket
   * and lets the console read the chain.
   */
  landed: boolean;
}

type StatusLike = { err: unknown; confirmationStatus?: string | null } | null;

/**
 * The poll's two verdicts about the transaction, in `confirmByPolling`'s own words: it failed on
 * chain (`Transaction <sig> failed: …`), or its blockhash expired and a last look over history
 * found nothing (`… block height exceeded`). Anything else it throws is about the RPC.
 */
function isVerdict(e: unknown): boolean {
  const said = (e as Error)?.message ?? String(e);
  return /block height exceeded/i.test(said) || /^Transaction \S+ failed:/.test(said);
}

/**
 * Settles a transaction already broadcast: `confirm` is the SDK's poll, `readStatus` one status
 * read over history. A status with an error, or a verdict from the poll, throws; a confirmed status
 * resolves `landed: true`; everything else resolves `landed: false` rather than throwing the
 * signature away.
 */
export async function settleBroadcast(
  signature: string,
  confirm: () => Promise<void>,
  readStatus: () => Promise<StatusLike | undefined>
): Promise<Broadcast> {
  try {
    await confirm();
    return { signature, landed: true };
  } catch (e) {
    // `undefined` when the read itself failed: that is no answer, and must not end the flow.
    const status = await readStatus().catch(() => undefined);
    if (status?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return { signature, landed: true };
    }
    if (isVerdict(e)) throw e;
    return { signature, landed: false };
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Bitcoin-alphabet base58, the encoding of a Solana signature. Here rather than `bs58` because this
 * file takes no imports (the node suite runs it) and the frontend does not declare `bs58`.
 */
export function base58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

/**
 * Broadcasts a signed prepared transaction and settles it, keeping the ticket when the send itself
 * could not be answered.
 *
 * `signature` is the transaction's own first signature, known before the send because a signed
 * transaction's id is its fee payer's signature — so the flow never depends on the send's answer to
 * learn it. A rejected `sendRawTransaction` is not proof the transaction did not land: the RPC proxy
 * answers 504 when Helius is slow and 502 when its answer is cut off, both after the transaction may
 * already have been forwarded, and a browser's fetch can drop after the request left. Throwing there
 * would let the fully signed transaction land with no ticket presented — the same orphan
 * `settleBroadcast` prevents for the confirmation poll.
 *
 * So only `sendVerdict` — an answer about the transaction (web3.js's `SendTransactionError`, which it
 * raises only from a JSON-RPC error the node returned: a failed preflight, an unknown blockhash) — is
 * thrown at once. Any other rejection falls through to `settleBroadcast`, which resolves `landed:
 * false` unless the chain says otherwise. If the poll's verdict is that the blockhash expired with the
 * transaction nowhere in history, it never left, and the send's own error is the better reason to
 * report, so that is what is thrown.
 */
export async function broadcastPrepared(
  signature: string,
  send: () => Promise<unknown>,
  sendVerdict: (e: unknown) => boolean,
  confirm: () => Promise<void>,
  readStatus: () => Promise<StatusLike | undefined>
): Promise<Broadcast> {
  let unanswered: { error: unknown } | null = null;
  try {
    await send();
  } catch (e) {
    if (sendVerdict(e)) throw e;
    unanswered = { error: e };
  }
  try {
    return await settleBroadcast(signature, confirm, readStatus);
  } catch (e) {
    if (unanswered && /block height exceeded/i.test((e as Error)?.message ?? String(e))) throw unanswered.error;
    throw e;
  }
}

/**
 * The error a caller throws when the console could not record a broadcast write: the console's own
 * reason, then what is known of the transaction. Seen landed, the record and the chain disagree and
 * only the operator can close the gap; not seen, it is said that it may have landed, with the
 * signature to look it up, rather than either claim.
 */
export function unrecordedWriteError(err: unknown, sent: Broadcast, subject: string): Error {
  const reason = (err as Error)?.message ?? String(err);
  return new Error(
    sent.landed
      ? `${reason} — but the transaction ${sent.signature} landed, so the ${subject} is registered on chain under ` +
        `this name. The console has no record of it; that has to be repaired by the operator.`
      : `${reason} — the transaction ${sent.signature} was sent, but whether it landed could not be read from ` +
        `here. If it did, the ${subject} is registered on chain under this name and the console has no record ` +
        `of it; that has to be repaired by the operator.`
  );
}
