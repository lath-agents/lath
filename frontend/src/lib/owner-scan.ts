/**
 * The fan-out behind the home page's owner list, kept free of React, of `@lath/sdk`
 * and of Node built-ins so it runs in the browser and pins in a node-only test.
 *
 * `useMyOwners` needs one Photon scan per agent authority the wallet funds. A wallet that has run
 * the Playwright suite funds more than a hundred, and firing every scan at once gets a share of
 * them answered with 429 by Helius. stateless.js does not retry, so read naively one rejection
 * would fail the whole list and the page would say "Could not reach the indexer" about an indexer
 * that had answered most of the questions. The three pieces here are what the read does instead.
 */

/**
 * One entry per distinct key, first occurrence kept, order preserved. Grants are per (user,
 * authority) and the same authority can reach the list more than once through old and new rows;
 * a scan answers per authority, so a second scan for the same one only spends rate budget.
 */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * `Promise.allSettled` over `items` with at most `limit` calls of `fn` in flight. Results come
 * back in input order, so a caller can pair each one with the item it was for. A rejection is a
 * `rejected` entry, never a thrown error: one authority the indexer would not answer must cost
 * that authority's rows, not the list.
 */
export async function settledPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Whether an RPC failure is the provider shedding load rather than a real fault. Matched on the
 * text as well as a status field because stateless.js surfaces a 429 as a plain `Error` whose
 * message carries the HTTP status, not as a typed error.
 */
export function isRateLimited(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  if (e.status === 429 || e.code === 429) return true;
  const text = typeof e.message === "string" ? e.message : String(err);
  return /\b429\b|too many requests|rate[- ]?limit/i.test(text);
}

/**
 * Exponential backoff for a rate-limited read: 1 s, 2 s, 4 s…, capped. `jitter` in [0, 1) spreads
 * retries from several scans that were refused in the same burst, which would otherwise come back
 * in the same burst and be refused again.
 */
export function backoffDelay(attempt: number, jitter = 0, baseMs = 1_000, capMs = 8_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp * (1 + 0.5 * jitter));
}

/**
 * Run `fn`, retrying only while it fails with a rate limit, at most `retries` more times. Any
 * other error is thrown at once: backing off does not fix a wrong address.
 */
export async function withRateLimitRetry<R>(
  fn: () => Promise<R>,
  retries: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => number = Math.random
): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRateLimited(err)) throw err;
      await sleep(backoffDelay(attempt, random()));
    }
  }
}
