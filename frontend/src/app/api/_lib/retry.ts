/**
 * Bounded retry for the server's own best-effort chain reads and writes.
 *
 * `@lightprotocol/stateless.js` does not retry a Photon call that answers 429 — it throws
 * `HTTP error! status: 429` — so without a retry one rate-limited read inside a name publish would
 * leave a registered agent "Unnamed" for good. This module is pure (no SDK, no Node built-ins, an
 * injectable sleep) so the rule can be tested without an RPC.
 */

export interface RetryPolicy {
  /** Total attempts including the first. */
  attempts: number;
  /** Wait before the second attempt; each later wait doubles, up to `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Five attempts over about 7.5 s of waiting: long enough to outlast a Helius per-second rate
 * window, short enough that a confirm still answers while the user is looking at the dialog.
 */
const NAME_PUBLISH_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 500, maxDelayMs: 4_000 };

/**
 * Whether an RPC error is worth another attempt: a 408/429, any 5xx, or a transport failure.
 *
 * Deliberately narrower than the SDK's upload classifier, which treats an unknown error as
 * transient. Here the unknown errors are the program's and the SDK's own refusals — a name that
 * does not hash to the id, a first publication proved twice — and those fail identically every
 * time, so retrying them only delays a response.
 *
 * The status is read from the error object when the HTTP client sets one, and otherwise from the
 * message, because stateless.js reports the status only as text.
 */
export function isRetryableRpcError(e: unknown): boolean {
  const err = e as any;
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status ?? NaN);
  const fromMessage = /\bstatus:?\s*(\d{3})\b/i.exec(String(err?.message ?? err ?? ""));
  const code = Number.isFinite(status) ? status : fromMessage ? Number(fromMessage[1]) : NaN;
  if (Number.isFinite(code)) return code === 408 || code === 429 || code >= 500;
  if (
    /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(String(err?.code ?? ""))
  )
    return true;
  const cause = err?.cause;
  if (cause && cause !== err && isRetryableRpcError(cause)) return true;
  return /fetch failed|too many requests|socket hang up|network error|timed? ?out/i.test(
    String(err?.message ?? err ?? "")
  );
}

/** The wait before attempt `n + 1` (n counts from 1): base · 2^(n-1), capped. */
export function backoffDelay(policy: RetryPolicy, n: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (n - 1));
}

/**
 * Runs `fn` until it resolves, the error is not retryable, or the attempts are spent; the last
 * error is rethrown, so the caller decides whether a final failure is loud or quiet.
 *
 * `fn` is re-run whole, so it must be safe to repeat — which the name publish is, because it
 * reads the name back before writing and writes nothing when it is already there.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = NAME_PUBLISH_RETRY,
  opts: { retryable?: (e: unknown) => boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const retryable = opts.retryable ?? isRetryableRpcError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (n >= policy.attempts || !retryable(e)) throw e;
      await sleep(backoffDelay(policy, n));
    }
  }
}
