/**
 * A gateway read from the browser that ends: a deadline over the headers and the body, and a byte
 * cap that stops reading the moment it is passed.
 *
 * The pages read blobs from gateways nobody here runs — Irys, a raw trace directory — and re-hash
 * what comes back, so a gateway is never trusted for the bytes, only for being up. A bare
 * `fetch(url)` then `arrayBuffer()` trusted it for two more things: to answer at all (one that
 * accepted the connection and never answered left a panel loading, or an export's button busy,
 * for as long as the socket lived), and to send a sane amount (the whole body was held before any
 * size check could refuse it). Pure and browser-safe — no Node built-ins — so client components
 * import it and a Node suite tests it (`tests/capped-fetch.ts`).
 */

/**
 * The deadline for one gateway read, headers and body together, ms: the SDK's
 * `GATEWAY_READ_TIMEOUT_MS` (`sdk/src/locator.ts`), which the trace panels' own reads through
 * `HttpGatewayBackend` already get. Spelled here rather than imported because `@lath/sdk/browser`
 * resolves to the built bundle, and a page must not depend on that bundle having been rebuilt.
 */
export const GATEWAY_FETCH_TIMEOUT_MS = 15_000;

/** The read passed its deadline. */
export class ReadTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer within ${Math.round(timeoutMs / 1000)} s`);
    this.name = "ReadTimeoutError";
  }
}

/** The body is longer than the caller's cap — announced by `Content-Length`, or found while reading. */
export class ReadCapError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the response is over ${maxBytes} bytes`);
    this.name = "ReadCapError";
  }
}

/** What a capped read saw: the status, and the body only when the status was ok. */
export interface CappedResponse {
  ok: boolean;
  status: number;
  bytes: Uint8Array | null;
}

export interface CappedFetchOptions {
  maxBytes: number;
  /** `GATEWAY_FETCH_TIMEOUT_MS` unless set. */
  timeoutMs?: number;
  /** A caller's own signal; aborting it aborts the read as well. */
  signal?: AbortSignal;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/**
 * `GET url`, held to `maxBytes` and `timeoutMs`. A status that is not ok resolves with `bytes: null`
 * and its body unread, so a caller can still tell a 404 from a failure. A network error, the
 * deadline (`ReadTimeoutError`) and the cap (`ReadCapError`) all reject — each site already has a
 * path for a fetch that threw, and these land on it.
 */
export async function fetchCapped(url: string, opts: CappedFetchOptions): Promise<CappedResponse> {
  const timeoutMs = opts.timeoutMs ?? GATEWAY_FETCH_TIMEOUT_MS;
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  // A controller and a timer rather than `AbortSignal.timeout` / `AbortSignal.any`, for the reason
  // `HttpGatewayBackend.download` gives: the timer is cleared the moment the read ends, and the same
  // code runs in a browser that predates both.
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
  const onCaller = () => abort.abort();
  if (opts.signal?.aborted) abort.abort();
  else opts.signal?.addEventListener("abort", onCaller, { once: true });
  try {
    const res = await fetchImpl(url, { signal: abort.signal });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, bytes: null };
    }
    const announced = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(announced) && announced > opts.maxBytes) {
      void res.body?.cancel().catch(() => undefined);
      throw new ReadCapError(opts.maxBytes);
    }
    return { ok: true, status: res.status, bytes: await readBodyCapped(res, opts.maxBytes) };
  } catch (e) {
    if (timedOut && !(e instanceof ReadCapError)) throw new ReadTimeoutError(timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCaller);
  }
}

/**
 * A response's body, read chunk by chunk and abandoned — the reader cancelled, so the connection is
 * let go — as soon as it passes `maxBytes`. `Content-Length` alone is not enough: it can be absent,
 * or describe a compressed body that decodes to far more.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new ReadCapError(maxBytes);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ReadCapError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * `promise`, or a `ReadTimeoutError` once `ms` have passed — for a read whose inner calls take no
 * signal (an RPC walk, a query-cache fetch), where the caller can stop waiting but not stop the
 * work. What it was doing carries on and lands wherever it would have; only the wait is bounded.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeoutError(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
