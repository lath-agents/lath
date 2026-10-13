/**
 * What to say when a chain read fails, in one place, so every page says the same thing.
 *
 * Two failures look alike from a page and are not: a burst of reads the RPC throttled for a moment
 * (a 429 that the next attempt clears), and an RPC key whose plan has run out (Helius answers
 * `429 max usage reached` to every call until the quota resets). The second is not "could not
 * reach": the indexer answered, and no retry will change its answer, so a page should say so at
 * once instead of showing a skeleton through every retry.
 *
 * The words and the memory are the SDK's (`sdk/src/confirm.ts`), not a second copy: the SDK's read
 * retry and this page text must agree on what a spent plan is. That memory matters because a
 * Photon read through stateless.js fails with a bare `HTTP error! status: 429`, without the body
 * the RPC proxy passes through (`api/rpc/proxy.ts`); once a web3.js call has seen the words, such a
 * 429 is the same spent plan for a minute.
 */
import { isRpcQuotaError as sdkIsRpcQuotaError, RPC_QUOTA_ERROR } from "@lath/sdk/browser";

/** Whether a failed read is the RPC's plan having run out, which no retry clears. */
export function isRpcQuotaError(e: unknown): boolean {
  return sdkIsRpcQuotaError(e);
}

/** Whether a 429's body names a spent plan (`RPC_QUOTA_ERROR`); false for any other answer. */
export function quotaBody(text: string): boolean {
  return RPC_QUOTA_ERROR.test(text);
}

/** One sentence for a chain read that failed: why, when that is known, and that it is not an empty chain. */
export function chainReadErrorText(e: unknown): string {
  if (isRpcQuotaError(e)) {
    return "The Solana RPC this app reads through has used up its request quota, so chain data cannot be read until it resets.";
  }
  return "The ZK-compression indexer (Photon RPC) did not answer. This is not an empty chain; try again in a moment.";
}
