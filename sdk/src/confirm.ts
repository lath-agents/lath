import type { Connection } from "@solana/web3.js";

/**
 * RPC failures that say nothing about the transaction being asked about: a rate limit, a gateway
 * error, a dropped socket. They are the provider's state, not the chain's, so a poll that meets
 * one asks again rather than turning it into a verdict on the write.
 *
 * `Method not found` (JSON-RPC -32601) is here too. A ZK-compression endpoint behind a load
 * balancer answers it now and then for a Photon method it serves on the next request: a loop step
 * can meet `failed to get info for compressed account …: Method not found` while the next step,
 * on the same url, reads the same accounts. An endpoint with no compression index at all
 * (`api.devnet.solana.com`, which cannot serve compressed reads) fails after the bounded retries
 * rather than on the first answer; it still fails.
 */
export const TRANSIENT_RPC_ERROR =
  /fetch failed|econnreset|etimedout|socket hang up|network error|method not found|-32601|\b(429|500|502|503|504)\b/i;

/**
 * An RPC key whose plan has run out: Helius answers `429 max usage reached` to every call until the
 * quota resets. A 429 by its status, so `TRANSIENT_RPC_ERROR` matches it and the write paths keep
 * treating it as the provider's state (a confirmation poll must not give up early). Only
 * `withTransientReadRetries` tells it apart: a read asked again meets the same refusal, and
 * retrying it only holds a page on its skeleton before it can say why.
 *
 * The one list of a spent plan's words: the app's read-error text (`frontend/src/lib/read-error.ts`)
 * and its 429 back-off (`lib/clients.ts`) test this same expression, so a body one of them calls a
 * spent plan is never a hiccup to the other.
 */
export const RPC_QUOTA_ERROR = /max usage reached|quota|credits? (exhausted|exceeded)|usage limit/i;

/**
 * How long a spent plan, once seen, colours a bare 429. stateless.js 0.23.3's `rpcRequest` throws
 * `HTTP error! status: 429` without the body, so a Photon read (`getCompressedAccount*`) never
 * carries the words `RPC_QUOTA_ERROR` looks for, while a web3.js `Connection` call through the
 * same key does. A plan does not come back within a minute, so for that long a bare 429 is read as
 * the same spent plan rather than a burst; past it a 429 is a hiccup again until the words are
 * seen anew. A minute of not retrying a real burst is the price, and it is bounded.
 */
export const RPC_QUOTA_MEMORY_MS = 60_000;

let quotaSeenAt: number | undefined;

/**
 * Remember that the RPC said its plan is spent (`RPC_QUOTA_ERROR`), for `RPC_QUOTA_MEMORY_MS`.
 * `isRpcQuotaError` calls it whenever an error carries the words; a client that reads them from a
 * 429's body itself (the app's `fetch` wrapper) calls it too. It is the hook a caller outside the
 * SDK uses, so the SDK never imports anything of theirs.
 */
export function noteRpcQuotaSpent(at: number = Date.now()): void {
  quotaSeenAt = at;
}

/** Whether a spent plan was seen within `RPC_QUOTA_MEMORY_MS` before `now`. */
export function rpcQuotaSpentRecently(now: number = Date.now()): boolean {
  return quotaSeenAt !== undefined && now >= quotaSeenAt && now - quotaSeenAt < RPC_QUOTA_MEMORY_MS;
}

/** Forget a spent plan seen earlier. For tests, which share this module's memory. */
export function forgetRpcQuotaSpent(): void {
  quotaSeenAt = undefined;
}

/** A 429 by its status and nothing more: what stateless.js throws for every 429, quota or burst. */
const BARE_429 = /\b429\b/;

/**
 * True when `e` is a spent RPC plan: its text names one (`RPC_QUOTA_ERROR`), which is remembered,
 * or it is a bare 429 while a spent plan seen moments ago is still fresh (`rpcQuotaSpentRecently`).
 * Only the read paths ask this; the write confirmations keep treating every 429 as transient.
 */
export function isRpcQuotaError(e: unknown): boolean {
  const err = e as any;
  const text = typeof e === "string" ? e : [err?.message, err?.toString?.()].join(" ");
  if (RPC_QUOTA_ERROR.test(text)) {
    noteRpcQuotaSpent();
    return true;
  }
  return BARE_429.test(text) && rpcQuotaSpentRecently();
}

/** True when `e` is one of `TRANSIENT_RPC_ERROR`'s failures, by message, string form or logs. */
export function isTransientRpcError(e: unknown): boolean {
  const err = e as any;
  const text = [err?.message, err?.toString?.(), JSON.stringify(err?.logs ?? [])].join(" ");
  return TRANSIENT_RPC_ERROR.test(text);
}

/**
 * How long an RPC may answer nothing but transient errors before the confirmation is given up
 * as unknown. 180 s is at least twice the 150-block validity window at 400–600 ms per block, so
 * by the time this throws the transaction can no longer land: a caller that rebuilds after it
 * cannot double-write. Failing faster would bring that risk back — a 429 while polling, read as a
 * failure, turns a landed `commit_epoch` into a second commit.
 */
export const CONFIRM_MAX_WAIT_MS = 180_000;

type SignatureStatusLike = { err: unknown; confirmationStatus?: string } | null | undefined;

/**
 * Confirmation without a websocket. `confirmTransaction` subscribes to the signature over the
 * RPC's websocket, and that socket is the one thing on the write path that can fail on its own:
 * a proxy that speaks only HTTP, an idle close, or — on a rate-limited endpoint — a `429` on
 * the upgrade that the client logs as `ws error` and then retries forever. Nothing here needs a
 * push. The status is polled until the cluster reports it, or until the blockhash the
 * transaction was signed with can no longer be included, which is the same window
 * `confirmTransaction` watches. Throws with the same "block height exceeded" wording, so the
 * SDK's retry predicate treats an expiry as it always has.
 *
 * A transient RPC error during a poll is swallowed and the poll repeats: one 429 thrown here as a
 * failed confirmation, for a transaction that had landed, would have the caller send it again. A
 * status with `err`, and any error that is not transient, still throws.
 * When the RPC has answered only transient errors for `maxWaitMs`, this throws an error flagged
 * `confirmationUnknown: true` whose message says so and does not claim the blockhash expired —
 * whether the transaction landed is exactly what is not known.
 *
 * `anyRpcError` widens "transient" to every RPC failure a poll meets, for a sender that has
 * nothing on chain to make a rebuild exclusive. A poll's verdicts are returned, never thrown, so
 * whatever a poll throws is the RPC's failure and says nothing about the transaction — but by
 * default one that does not look transient (`failed to get block height information: Internal
 * error`, a JSON-RPC -32603 carrying no status code) is rethrown at once, while the transaction it
 * was asked about may still land. A chain write survives that: its rebuild spends the same state
 * hash, so at most one of the two lands. A billing `charge` takes no nonce, and a caller that
 * rebuilds on that throw sends a second debit beside the one in flight. With the option
 * set, such a poll is asked again like a 429, and the wait ends only on the cluster's word, an
 * expired blockhash, or `maxWaitMs` of nothing else — each of which leaves the first transaction
 * unable to land unseen.
 */
export async function confirmByPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  opts: { intervalMs?: number; maxWaitMs?: number; anyRpcError?: boolean } = {}
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1500;
  const maxWaitMs = opts.maxWaitMs ?? CONFIRM_MAX_WAIT_MS;
  const landed = (s: SignatureStatusLike) =>
    !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
  const failed = (s: { err: unknown }) => new Error(`Transaction ${signature} failed: ${JSON.stringify(s.err)}`);

  // One poll. The verdicts are returned, not thrown, so that only the RPC's own failures reach
  // the transient check below — a failed transaction's error JSON must never read as a 429.
  const poll = async (): Promise<"confirmed" | "pending" | Error> => {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const status = value[0];
    if (status?.err) return failed(status);
    if (landed(status)) return "confirmed";
    const height = await connection.getBlockHeight("confirmed");
    if (height <= lastValidBlockHeight) return "pending";
    // The transaction can confirm between the status read above and the height read, so one more
    // look — over history this time — before calling it expired. Without it a write that landed
    // in that gap is reported dead and sent again.
    const { value: final } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const last = final[0];
    if (last?.err) return failed(last);
    if (landed(last)) return "confirmed";
    return new Error(`Signature ${signature} has expired: block height exceeded.`);
  };

  // The last moment the RPC answered a whole poll. The wait is measured from there, so an RPC
  // that answers normally is bounded by the blockhash's validity window, not by `maxWaitMs`.
  let answeredAt = Date.now();
  for (;;) {
    let verdict: "confirmed" | "pending" | Error;
    try {
      verdict = await poll();
    } catch (e) {
      if (!opts.anyRpcError && !isTransientRpcError(e)) throw e;
      if (Date.now() - answeredAt >= maxWaitMs) {
        const last = (e as any)?.message ?? String(e);
        const what = opts.anyRpcError ? "errors" : "transient errors";
        throw Object.assign(
          new Error(
            `confirmation of ${signature} unknown: the RPC answered only ${what} for ${maxWaitMs} ms (last: ${last})`
          ),
          { confirmationUnknown: true }
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (verdict === "confirmed") return;
    if (verdict instanceof Error) throw verdict;
    answeredAt = Date.now();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** The indexer and proof reads a Lath client makes directly; each is safe to ask again. */
export const RETRIED_RPC_READS = [
  "getCompressedAccount",
  "getCompressedAccountsByOwner",
  "getMultipleCompressedAccounts",
  "getCompressedAccountProof",
  "getCompressionSignaturesForAddress",
  "getValidityProof",
  "getValidityProofV0",
  "getStateTreeInfos",
] as const;

/**
 * `rpc` with its indexer and proof reads retried on a transient failure (`isTransientRpcError`),
 * `attempts` in all with a doubling delay; every other member is the original, bound to it.
 *
 * Reads are asked again here, once, rather than at each call site: a devnet endpoint can answer a
 * share of `getCompressedAccount` calls through stateless.js with `Method not found`, and reads
 * with no retry of their own (`getCellAt`, `cellStateAt`, `getHeader`) would crash a loop step on
 * one; `getAgentState` and the writes carry their own. A read
 * changes nothing, so asking again cannot double anything; a write that re-reads inside
 * `withRetry` just gets one more bounded layer.
 */
export function withTransientReadRetries<T extends object>(rpc: T, attempts = 4, delayMs = 250): T {
  const retried = new Set<PropertyKey>(RETRIED_RPC_READS);
  return new Proxy(rpc, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!retried.has(prop)) return value.bind(target);
      return async (...args: unknown[]) => {
        for (let i = 1; ; i++) {
          try {
            return await value.apply(target, args);
          } catch (e) {
            // A spent plan is not a hiccup: the next attempt is refused the same way (`isRpcQuotaError`).
            if (i >= attempts || !isTransientRpcError(e) || isRpcQuotaError(e)) throw e;
            await new Promise((r) => setTimeout(r, delayMs * 2 ** (i - 1)));
          }
        }
      };
    },
  });
}
