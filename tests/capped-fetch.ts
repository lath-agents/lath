import { assert } from "chai";
import { fetchCapped, ReadCapError, ReadTimeoutError, withDeadline } from "../frontend/src/lib/capped-fetch";

/**
 * The browser's gateway reads (`frontend/src/lib/capped-fetch.ts`): a deadline over the headers and
 * the body, and a byte cap that stops reading once passed. Each case injects a `fetch`, so nothing
 * here touches the network.
 */
describe("capped fetch", () => {
  /** A `fetch` that answers once its signal aborts, the way the platform's does, and never otherwise. */
  const hanging: typeof fetch = (_url, init) =>
    new Promise((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  /** An endless body, counting how many chunks were pulled and whether the reader was cancelled. */
  function endless(chunk: number) {
    const seen = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        seen.pulls++;
        c.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    return { body, seen };
  }

  it("returns the body under the cap", async () => {
    const got = await fetchCapped("x", {
      maxBytes: 8,
      fetch: async () => new Response(new Uint8Array([1, 2, 3])),
    });
    assert.deepEqual(got, { ok: true, status: 200, bytes: new Uint8Array([1, 2, 3]) });
  });

  it("answers a status that is not ok without its body, so a 404 stays a 404", async () => {
    const got = await fetchCapped("x", { maxBytes: 8, fetch: async () => new Response("gone", { status: 404 }) });
    assert.deepEqual(got, { ok: false, status: 404, bytes: null });
  });

  it("refuses a Content-Length over the cap before reading", async () => {
    const { body, seen } = endless(4);
    const err = await fetchCapped("x", {
      maxBytes: 8,
      fetch: async () => new Response(body, { headers: { "content-length": "9" } }),
    }).catch((e) => e);
    assert.instanceOf(err, ReadCapError);
    assert.equal(err.maxBytes, 8);
    assert.isAtMost(seen.pulls, 1, "nothing past the stream's own first fill was read");
  });

  it("stops reading an unannounced body at the cap and cancels it", async () => {
    const { body, seen } = endless(4);
    const err = await fetchCapped("x", { maxBytes: 10, fetch: async () => new Response(body) }).catch((e) => e);
    assert.instanceOf(err, ReadCapError);
    assert.isTrue(seen.cancelled);
    // 4 + 4 + 4 passes 10 on the third chunk; the stream may have queued one more ahead, no further.
    assert.isAtMost(seen.pulls, 4);
  });

  it("gives up on a gateway that never answers", async () => {
    const started = Date.now();
    const err = await fetchCapped("x", { maxBytes: 8, timeoutMs: 50, fetch: hanging }).catch((e) => e);
    assert.instanceOf(err, ReadTimeoutError);
    assert.isBelow(Date.now() - started, 2_000);
  });

  it("gives up on a body that answers and then stalls", async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(2));
          // What the platform does to a body whose request's signal aborts.
          signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body);
    };
    const err = await fetchCapped("x", { maxBytes: 1024, timeoutMs: 50, fetch: fetchImpl }).catch((e) => e);
    assert.instanceOf(err, ReadTimeoutError);
    assert.isFalse(cancelled, "the stall ended by the abort, not by the cap");
  });

  it("aborts with the caller's signal, and says it was not the deadline", async () => {
    const caller = new AbortController();
    const pending = fetchCapped("x", { maxBytes: 8, timeoutMs: 10_000, signal: caller.signal, fetch: hanging });
    caller.abort();
    const err = await pending.catch((e) => e);
    assert.notInstanceOf(err, ReadTimeoutError);
    assert.equal(err.name, "AbortError");
  });

  it("bounds a wait whose work takes no signal", async () => {
    assert.equal(await withDeadline(Promise.resolve(7), 50), 7);
    const err = await withDeadline(new Promise(() => undefined), 20).catch((e) => e);
    assert.instanceOf(err, ReadTimeoutError);
  });
});
