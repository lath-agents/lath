/**
 * The home page's owner list does not fail whole when the indexer sheds load.
 *
 * No validator, no devnet, no browser: `frontend/src/lib/owner-scan.ts` is free of React and of
 * Node built-ins so the fan-out rules can be pinned here. The load in question is ~100 concurrent
 * scans, a share of them answered 429, where one rejection must not take the list with it.
 */
import { assert } from "chai";
import { backoffDelay, isRateLimited, settledPool, uniqueBy, withRateLimitRetry } from "../frontend/src/lib/owner-scan";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("console owner scan", () => {
  it("dedupes by key, keeping the first occurrence and the order", () => {
    const grants = [
      { a: "X", n: 1 },
      { a: "Y", n: 2 },
      { a: "X", n: 3 },
      { a: "Z", n: 4 },
      { a: "Y", n: 5 },
    ];
    assert.deepEqual(
      uniqueBy(grants, (g) => g.a).map((g) => g.n),
      [1, 2, 4]
    );
  });

  it("never has more than `limit` calls in flight, and runs every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 115 }, (_, i) => i);
    const results = await settledPool(items, 5, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return i * 2;
    });
    assert.equal(peak, 5);
    assert.lengthOf(results, 115);
    results.forEach((r, i) => assert.deepEqual(r, { status: "fulfilled", value: i * 2 }));
  });

  it("settles a rejection in place instead of failing the rest", async () => {
    const results = await settledPool([0, 1, 2, 3], 2, async (i) => {
      await tick();
      if (i === 1) throw new Error("429 Too Many Requests");
      return `row-${i}`;
    });
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected", "fulfilled", "fulfilled"]
    );
    assert.equal((results[3] as PromiseFulfilledResult<string>).value, "row-3");
  });

  it("handles an empty list and a limit wider than the list", async () => {
    assert.deepEqual(await settledPool([], 5, async () => 1), []);
    const r = await settledPool([1, 2], 50, async (x) => x);
    assert.deepEqual(
      r.map((x) => (x as PromiseFulfilledResult<number>).value),
      [1, 2]
    );
  });

  it("recognises a 429 by status or by message, and nothing else", () => {
    assert.isTrue(isRateLimited({ status: 429 }));
    assert.isTrue(isRateLimited(new Error("failed to get info: 429 Too Many Requests")));
    assert.isTrue(isRateLimited(new Error("Server responded with 429. Retrying after 500ms delay...")));
    assert.isTrue(isRateLimited(new Error("rate limit exceeded")));
    assert.isFalse(isRateLimited(new Error("Invalid param: WrongSize")));
    assert.isFalse(isRateLimited(new Error("slot 4290001 not found")));
    assert.isFalse(isRateLimited(undefined));
  });

  it("backs off exponentially, capped, with jitter only lengthening the wait", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 10].map((a) => backoffDelay(a)),
      [1000, 2000, 4000, 8000, 8000, 8000]
    );
    assert.equal(backoffDelay(1, 0.999), 2999);
  });

  it("retries a rate-limited call only, up to the budget", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let calls = 0;
    const ok = await withRateLimitRetry(
      async () => {
        if (++calls < 3) throw new Error("429 Too Many Requests");
        return "read";
      },
      2,
      sleep,
      () => 0
    );
    assert.equal(ok, "read");
    assert.deepEqual(waits, [1000, 2000]);

    calls = 0;
    try {
      await withRateLimitRetry(
        async () => {
          calls++;
          throw new Error("429");
        },
        2,
        sleep,
        () => 0
      );
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as Error).message, "429");
      assert.equal(calls, 3);
    }

    calls = 0;
    try {
      await withRateLimitRetry(
        async () => {
          calls++;
          throw new Error("Invalid param");
        },
        2,
        sleep
      );
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as Error).message, "Invalid param");
      assert.equal(calls, 1, "a real fault is not retried");
    }
  });
});
