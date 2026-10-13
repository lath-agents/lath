/**
 * The browser's RPC, served from this origin so the operator's endpoint never reaches a page.
 *
 * A ZK-compression RPC is a paid service and its url carries the key (`?api-key=…` at Helius). Handed
 * to the browser through a `NEXT_PUBLIC_` variable, which Next inlines into every client chunk, that
 * url — the same one the server writes every chain with — would let any visitor copy the key out of
 * devtools and spend the quota the console's own loop steps and deploys run on. So the browser posts
 * JSON-RPC here, and the route forwards it to `LATH_RPC_URL` (Solana JSON-RPC) or the Photon url,
 * holding the key server-side.
 *
 * A forwarder that forwarded anything would only move the problem: a stranger could still spend the
 * quota, now through us. So it forwards what the app itself sends and nothing else —
 *
 * - POST only, and not from another site's page (`Sec-Fetch-Site: cross-site`);
 * - a method allowlist per role, built from every call the client code reaches (below);
 * - a JSON-RPC batch only on the Solana role and only up to `MAX_BATCH` entries, each allowlisted;
 * - a request body of at most `MAX_BODY_BYTES`, and the request re-serialised from what was checked,
 *   so a body the upstream parses differently (a duplicated `method` key) cannot slip one past;
 * - `getProgramAccounts` only on the programs the app scans, and only with a filter;
 * - an upstream deadline, so a hung endpoint cannot hold the handler open;
 * - an answer of at most `MAX_ANSWER_BYTES`, counted as it arrives, so one request cannot make this
 *   process buffer whatever the upstream sends;
 * - per caller, a token bucket of call units, with the expensive calls weighted (`CALL_WEIGHT`),
 *   charged only for a request that passed every check above and is about to go upstream;
 * - no upstream header reaches the browser, an upstream error body is reduced to its JSON-RPC code
 *   and message, and every body is scrubbed of the url's credentials before it is returned.
 *
 * The prover is not proxied. stateless.js's `Rpc` never calls it — the indexer's `getValidityProof`
 * returns the proof, and only the test `TestRpc` posts to `<prover>/prove` — so a route for it would
 * be an unused door onto the most expensive thing the endpoint does.
 *
 * Pure: no Next import and no environment read, so `tests/console-rpc-proxy.ts` drives it with a
 * fake upstream and its own clock. The routes under `app/api/rpc/[cluster]/` supply the urls, the
 * program ids, the caller and the buckets (`./limits.ts`).
 */

export type RpcRole = "rpc" | "photon";

/**
 * Solana JSON-RPC methods the browser sends, traced from every `Connection` call in
 * `frontend/src` (outside `app/api`) and `sdk/src` (outside the CLI), stateless.js's `Rpc`, and the
 * wallet adapters. Each is here because a named caller needs it:
 *
 * - `getAccountInfo` — the billing reads, the ATA checks, `getAddressLookupTable` in stateless.js's
 *   state-tree lookup; `getBalance`, `getTokenAccountBalance` — the wallet and vault pills;
 * - `getLatestBlockhash`, `sendTransaction` (`sendRawTransaction`), `getSignatureStatuses`,
 *   `getBlockHeight` — a wallet-signed write and `confirmByPolling`, which is why no websocket is
 *   needed; the wallet adapter's `prepareTransaction` asks for a blockhash too;
 * - `getTransaction` — `getParsedTransaction` in the audit, `SendTransactionError.getLogs` in
 *   `lib/writes.ts`, and the charge history's `getTransactions`, the one batch the app sends;
 * - `getSignaturesForAddress` — charge history; `getProgramAccounts` — the allowance scan;
 *   `getRecentPrioritizationFees` — the SDK's fee estimate on a write.
 *
 * `simulateTransaction` is deliberately absent: nothing in the app calls it (a wallet's preview runs
 * on the wallet's own RPC), and a new caller that needs it is refused with its name on screen.
 */
export const SOLANA_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getLatestBlockhash",
  "getProgramAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTokenAccountBalance",
  "getTransaction",
  "sendTransaction",
]);

/**
 * Photon methods the SDK's browser reads reach through stateless.js. The browser build of
 * stateless.js 0.23.3 is compiled for V2 and appends `V2` to most names (`it()` in its bundle), the
 * node build does not, so both spellings are served — the same read either way.
 */
const PHOTON_BASE = [
  "getCompressedAccount",
  "getCompressedAccountsByOwner",
  "getMultipleCompressedAccounts",
  "getCompressedAccountProof",
  "getMultipleCompressedAccountProofs",
  "getCompressionSignaturesForAddress",
  "getValidityProof",
  "getIndexerHealth",
  "getIndexerSlot",
];
export const PHOTON_METHODS: ReadonlySet<string> = new Set(PHOTON_BASE.flatMap((m) => [m, `${m}V2`]));

/**
 * The largest body forwarded. A signed transaction is at most 1232 bytes (about 1.7 KB in base64),
 * and a full batch of `MAX_BATCH` `getTransaction` calls is about 20 KB; anything past 64 KiB is not
 * something the app sends.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * A batch's most entries: the per-batch cap `BillingClient.activity` already slices to, and what the
 * upstream enforces anyway. Past it the answer is a 413 carrying `-32413`, which `isBatchRefusal`
 * (`sdk/src/billing.ts`) reads as "ask one at a time" rather than as a failure.
 */
export const MAX_BATCH = 100;

/**
 * The largest upstream answer passed on. An answer read with `res.text()` and no bound, then scrubbed
 * and re-encoded — about three copies — lets a 13 KB request for a large account or an unfiltered
 * scan take the console from 264 MB to over 1 GB, and a few in parallel would end the process.
 *
 * Sized from what the app actually reads. The largest answer it asks for is the agent list, one
 * `getCompressedAccountsByOwnerV2` page of every header (`LathClient.listAgents`): measured on
 * devnet at 440 719 bytes for 622 headers, about 710 bytes a header, so Photon's
 * 1 000-item page is about 0.7 MB however many agents there are, and an event page about the same.
 * The other large one is the charge history's batch of `MAX_BATCH` `getTransaction` calls, about
 * 1 MB at 10 KB a transaction. 8 MiB is more than eight times either, and past it the answer is
 * not one the app asked for; at three copies it bounds one request to about 24 MB.
 */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/**
 * Call units a method costs against the caller's bucket; anything not named costs one. The two
 * named are the ones a provider prices highest and the ones a stranger would choose to drain a
 * quota with: a program scan is the upstream reading every account the program owns, and a
 * validity proof is the prover's work. The app sends few of either — two scans for a wallet's
 * allowances, one proof per write — so the weight costs a person almost nothing.
 */
export const CALL_WEIGHT: Readonly<Record<string, number>> = {
  getProgramAccounts: 10,
  getValidityProof: 10,
  getValidityProofV2: 10,
};

/** The units a request costs: a batch costs the sum of its calls. */
export function weightOf(calls: readonly { method: string }[]): number {
  return calls.reduce((n, c) => n + (CALL_WEIGHT[c.method] ?? 1), 0);
}

/**
 * Per-caller token buckets: `perMinute` units refill a minute, up to `burst` held at once. A token
 * bucket rather than `rateLimit`'s hour of timestamps, because a page of the app sends dozens of
 * calls in a second and thousands an hour, and a timestamp per call per caller is memory the
 * caller decides. `take` answers `null` and spends the units, or the whole seconds until they would
 * be there and spends nothing. The route keeps one set on `globalThis` (`./limits.ts`), so the
 * Solana and Photon routes — two module graphs — share one bucket per caller; a bucket that has
 * refilled is dropped at the next sweep, at most once a minute, so quiet callers do not accumulate.
 */
export type RpcBuckets = { take(key: string, units: number, now?: number): number | null };

export function tokenBuckets(
  perMinute: number,
  burst: number = perMinute,
  store: Map<string, { tokens: number; at: number }> = new Map()
): RpcBuckets {
  const perMs = perMinute / 60_000;
  let sweptAt = 0;
  return {
    take(key, units, now = Date.now()) {
      if (now - sweptAt >= 60_000) {
        sweptAt = now;
        for (const [k, b] of store) if (b.tokens + (now - b.at) * perMs >= burst) store.delete(k);
      }
      const held = store.get(key);
      const tokens = held ? Math.min(burst, held.tokens + (now - held.at) * perMs) : burst;
      // A request larger than the whole burst could never pass; it is charged the burst instead, so
      // a full batch is slow rather than impossible.
      const cost = Math.min(units, burst);
      if (tokens < cost) {
        store.set(key, { tokens, at: now });
        return Math.max(1, Math.ceil((cost - tokens) / perMs / 1000));
      }
      store.set(key, { tokens: tokens - cost, at: now });
      return null;
    },
  };
}

/** How long one upstream call may take before the browser is told 504 and may ask again. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

export type ProxyTarget = {
  role: RpcRole;
  /** The upstream url, credentials and all; empty when the server has none configured. */
  upstream: string;
  /** The cluster in the request path, and the one this server runs on. */
  cluster: string;
  servedCluster: string;
  /**
   * The programs `getProgramAccounts` may name: the billing program (`listAllowancesByUser`), the
   * only scan the browser makes. Absent, any program, for a caller that has no list to give.
   */
  programIds?: ReadonlySet<string>;
};

export type ProxyOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxAnswerBytes?: number;
  /** The caller's bucket key and the buckets it is charged in; either absent, nothing is charged. */
  caller?: string;
  buckets?: RpcBuckets;
  now?: number;
};

type JsonRpcId = string | number | null;
type Call = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown };

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

/** A JSON-RPC error of ours, with the HTTP status that says what kind of refusal it is. */
function refuse(
  status: number,
  code: number,
  message: string,
  id: JsonRpcId = null,
  extra?: Record<string, string>
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status,
    headers: { ...JSON_HEADERS, ...(extra ?? {}) },
  });
}

/**
 * The parts of an upstream url that are credentials: userinfo, every query value, and any path
 * segment long enough to be a token (QuickNode and Alchemy put the key in the path). Short values
 * are left alone so that scrubbing cannot eat an ordinary word out of a response.
 */
export function upstreamSecrets(upstream: string): string[] {
  const out = new Set<string>();
  try {
    const u = new URL(upstream);
    out.add(upstream);
    if (u.username) out.add(decodeURIComponent(u.username));
    if (u.password) out.add(decodeURIComponent(u.password));
    for (const v of u.searchParams.values()) out.add(v);
    for (const seg of u.pathname.split("/")) if (seg.length >= 16) out.add(decodeURIComponent(seg));
  } catch {
    out.add(upstream);
  }
  // Longest first, so the whole url goes before the key inside it.
  return [...out].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join("…");
  return out;
}

/**
 * A request's or an upstream answer's body, or `null` when it is longer than `max` — counted as it
 * arrives, not trusted from a header. A declared length past the cap is refused before a byte is
 * read, and a stream that runs past it is cancelled there, so no more than `max` is ever held.
 */
export async function readCapped(msg: Request | Response, max: number): Promise<string | null> {
  const declared = Number(msg.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await msg.body?.cancel().catch(() => {});
    return null;
  }
  if (!msg.body) return "";
  const reader = msg.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * What a write route's body may weigh when the route names no smaller bound: `/api/run`'s 256 KiB,
 * which leaves room for any body the console's own pages send — a deploy carrying a loop with eight
 * sources, a template's whole config — and none for a disk-filler.
 */
export const WRITE_BODY_BYTES = 256 * 1024;

/**
 * A write route's JSON body, read through `readCapped` before anything parses it or looks at a
 * signature: `null` when it is longer than `max` (the route answers `bodyTooLarge`), else the parsed
 * value, or `undefined` for a body that is not JSON.
 *
 * An app-router handler has no body limit and there is no middleware that sets one, so with
 * `req.json()` as the reader an unsigned body of hundreds of megabytes would be buffered and parsed
 * before the route could refuse it. `/api/run`, the deploy and clone routes, the store write and the
 * template writes read it here; the bound is counted as the bytes arrive, so a body that lies in its
 * `Content-Length`, or sends none, is cut where it crosses `max`.
 */
export async function readJsonCapped(req: Request, max = WRITE_BODY_BYTES): Promise<{ json: unknown } | null> {
  const raw = await readCapped(req, max);
  if (raw === null) return null;
  try {
    return { json: JSON.parse(raw) };
  } catch {
    return { json: undefined };
  }
}

/** The 413 a body past `readJsonCapped`'s bound is answered with. */
export function bodyTooLarge(max = WRITE_BODY_BYTES): Response {
  return Response.json({ error: `the request is too large (${Math.round(max / 1024)} KiB at most)` }, { status: 413 });
}

/**
 * A parsed body as the object a route reads fields off: anything that is not a plain object is `{}`,
 * which is what a body that did not parse always is on these routes. A `null` or an array reaching
 * `body.confirm` or `body.auth` as itself would throw a 500 on the first field read.
 */
export function asBody<T extends object>(json: unknown): Partial<T> {
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Partial<T>) : {};
}

function idOf(x: unknown): JsonRpcId {
  const id = (x as { id?: unknown } | null)?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** One call, checked and rebuilt from its checked fields; or the reason it is refused. */
function check(
  x: unknown,
  allowed: ReadonlySet<string>,
  programIds?: ReadonlySet<string>
): Call | { status: number; code: number; message: string } {
  if (typeof x !== "object" || x === null || Array.isArray(x))
    return { status: 400, code: -32600, message: "invalid request: not a JSON-RPC call" };
  const o = x as Record<string, unknown>;
  if (o.jsonrpc !== "2.0") return { status: 400, code: -32600, message: 'invalid request: jsonrpc must be "2.0"' };
  if (typeof o.method !== "string") return { status: 400, code: -32600, message: "invalid request: no method" };
  const id = o.id === undefined ? null : o.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number")
    return { status: 400, code: -32600, message: "invalid request: id must be a string or number" };
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null))
    return { status: 400, code: -32602, message: "invalid request: params must be an array or object" };
  // Deliberately not -32601 "Method not found": the SDK retries that one as a load balancer's
  // hiccup (`TRANSIENT_RPC_ERROR`), and a refusal here will not change on the next attempt.
  if (!allowed.has(o.method))
    return { status: 403, code: -32050, message: `${o.method.slice(0, 64)} is not served by this console's RPC proxy` };
  // A program scan is the upstream reading every account a program owns. The app scans one program,
  // the billing program, always with a `dataSize` and a `memcmp`; a scan of another program, or one
  // with no filter, is a 150 MB answer, not a read the app makes.
  if (o.method === "getProgramAccounts" && programIds) {
    const params = Array.isArray(o.params) ? o.params : [];
    if (typeof params[0] !== "string" || !programIds.has(params[0]))
      return { status: 403, code: -32050, message: "getProgramAccounts is served for this console's programs only" };
    const filters = (params[1] as { filters?: unknown } | null | undefined)?.filters;
    if (!Array.isArray(filters) || filters.length === 0)
      return { status: 403, code: -32050, message: "getProgramAccounts is served with a filter only" };
  }
  return {
    jsonrpc: "2.0",
    id: id as JsonRpcId,
    method: o.method,
    ...(o.params === undefined ? {} : { params: o.params }),
  };
}

/**
 * The upstream's error, reduced to what a JSON-RPC client reads: a numeric code and a message, both
 * scrubbed. Anything else about it — its headers, an HTML error page, a stack trace naming the url —
 * stays here. The code and message are kept because the client acts on them: `isBatchRefusal` reads
 * `-32403`/`-32413` to fall back to single calls, and a 429 keeps its status so the client backs off.
 */
function upstreamError(status: number, text: string, secrets: readonly string[], id: JsonRpcId): Response {
  let code = -32000;
  let message = `upstream RPC answered ${status}`;
  try {
    const parsed = JSON.parse(text);
    const err = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (err && typeof err.code === "number") code = err.code;
    if (err && typeof err.message === "string")
      message = `upstream RPC answered ${status}: ${err.message.slice(0, 300)}`;
  } catch {
    // Not JSON. On a 429 a short line of plain words is kept, because it is what tells a client a
    // spent plan from a throttled burst: Helius answers `max usage reached` as bare text to every
    // call once a key's quota is gone (`lib/read-error.ts`). Only words — no markup, no slashes, so
    // no error page and no url — and nothing on any other status: the generic message stands.
    const line = text.trim();
    if (status === 429 && line.length <= 120 && /^[A-Za-z0-9 .,;:'()-]+$/.test(line)) {
      message = `upstream RPC answered ${status}: ${line}`;
    }
  }
  return refuse(status, code, scrub(message, secrets), id);
}

export async function proxyRpc(req: Request, target: ProxyTarget, opts: ProxyOptions = {}): Promise<Response> {
  if (req.method !== "POST") return refuse(405, -32600, "the RPC proxy answers POST only", null, { allow: "POST" });
  // A browser marks a request another site's page makes; this route serves this site's pages. A
  // client outside a browser sends no such header and is bounded by the allowlist instead.
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return refuse(403, -32600, "the RPC proxy serves this site's pages only");
  // A path naming another cluster is refused rather than answered from this one's: the wallet adapter
  // picks the chain a transaction is signed for from this path (`getChainForEndpoint`).
  if (target.cluster !== target.servedCluster)
    return refuse(404, -32600, `this console runs on ${target.servedCluster}, not ${target.cluster}`);
  if (!target.upstream)
    return refuse(
      503,
      -32000,
      target.role === "rpc"
        ? "no RPC is configured on this server (LATH_RPC_URL)"
        : "no Photon url is configured on this server (LATH_PHOTON_URL or LATH_RPC_URL)"
    );

  const max = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const raw = await readCapped(req, max);
  if (raw === null) return refuse(413, -32413, `request body is larger than ${max} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse(400, -32700, "parse error: the body is not JSON");
  }

  const allowed = target.role === "rpc" ? SOLANA_METHODS : PHOTON_METHODS;
  let forward: Call | Call[];
  let replyId: JsonRpcId = null;
  if (Array.isArray(parsed)) {
    // stateless.js never batches a Photon call, so a batch there is not the app.
    if (target.role !== "rpc") return refuse(400, -32600, "batch requests are not served on the Photon route");
    if (parsed.length === 0) return refuse(400, -32600, "invalid request: empty batch");
    if (parsed.length > MAX_BATCH)
      return refuse(413, -32413, `batch is too large: ${parsed.length} calls, at most ${MAX_BATCH}`);
    const calls: Call[] = [];
    for (const x of parsed) {
      const c = check(x, allowed, target.programIds);
      if (!("jsonrpc" in c)) return refuse(c.status, c.code, c.message, idOf(x));
      calls.push(c);
    }
    forward = calls;
  } else {
    const c = check(parsed, allowed, target.programIds);
    if (!("jsonrpc" in c)) return refuse(c.status, c.code, c.message, idOf(parsed));
    forward = c;
    replyId = c.id;
  }

  // Charged only now, for a request every check above passed: a refusal costs the caller nothing,
  // and what is counted is exactly what is about to go upstream. 429 with `Retry-After`, which
  // web3.js's `Connection` already backs off on; the message carries nothing `lib/read-error.ts`
  // would read as the provider's spent plan, because the plan is not spent — this caller's share is.
  if (opts.caller && opts.buckets) {
    const wait = opts.buckets.take(opts.caller, weightOf(Array.isArray(forward) ? forward : [forward]), opts.now);
    if (wait !== null)
      return refuse(
        429,
        -32429,
        `rate limit: this console's RPC serves one caller only so many calls a minute; retry in ${wait} s`,
        replyId,
        { "retry-after": String(wait) }
      );
  }

  const secrets = upstreamSecrets(target.upstream);
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(target.upstream, {
      method: "POST",
      // Nothing of the browser's request goes upstream but the checked body: no cookie, no origin,
      // no forwarded-for that would tie a visitor to the operator's account at the provider.
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
      // A redirect would be followed with the key still in the url, to wherever it points.
      redirect: "error",
    });
  } catch (e) {
    const timedOut = (e as { name?: string } | null)?.name === "TimeoutError";
    // The fetch error is not echoed: undici's `cause` can carry the url it failed to reach.
    return timedOut
      ? refuse(504, -32000, "upstream RPC did not answer in time", replyId)
      : refuse(502, -32000, "upstream RPC could not be reached", replyId);
  }

  const maxAnswer = opts.maxAnswerBytes ?? MAX_ANSWER_BYTES;
  let text: string | null;
  try {
    text = await readCapped(res, maxAnswer);
  } catch {
    return refuse(502, -32000, "upstream RPC answer was cut off", replyId);
  }
  // Past the cap the rest is not read: `readCapped` cancelled the stream where it crossed it.
  if (text === null) return refuse(502, -32000, `upstream RPC answer is larger than ${maxAnswer} bytes`, replyId);
  if (!res.ok) return upstreamError(res.status, text, secrets, replyId);
  return new Response(scrub(text, secrets), { status: 200, headers: JSON_HEADERS });
}
