/**
 * The OpenRouter wire format Lath meters against: chat completions with `usage.include`, the
 * SSE reader, and the normalisation into the body a record hashes.
 *
 * Everything goes through `ChatTransport`, so the runtime can be driven from recorded
 * fixtures with no network (`tests/fixtures/recorded-transport.ts`).
 *
 * `chatCore` is what ships: the POST, the stream reader and the body. Its only caller in the
 * console and the runtime is `transport/mpp.ts`, which hands it a `fetch` that signs a TIP-1034
 * voucher — every billed call is paid over MPP from the operator's Tempo treasury and nothing here
 * reads an API key.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Assistant turns that call tools. */
  tool_calls?: ToolCall[];
  /** Present on `role: "tool"` replies. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  /** Always `{ include: true }` — `usage.cost` is the billing meter. */
  usage: { include: true };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Credits spent on this generation, in USD. The meter. */
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    audio_tokens?: number;
    video_tokens?: number;
  };
  cost_details?: Record<string, number>;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: { index?: number; message: ChatMessage; finish_reason?: string }[];
  usage?: ChatUsage;
}

/**
 * What an agent paid for one call on the `tempo` rail, as the transport observed it around one
 * `fetch`. The runtime merges this into the result blob before
 * `result_hash` is taken, so the Solana record commits to the Tempo payment that bought the
 * completion it records.
 *
 * `cumulativeBefore`/`cumulativeAfter` are the channel's signed cumulative in USDC.e base units,
 * as decimal strings because they are `uint96` on Tempo and JSON has no integer that wide. Their
 * difference is what left the wallet for this call — the meter. It is the gateway's flat
 * per-request quote, not the token cost: `usageCost` is the body's own `usage.cost` in USD
 * when the gateway returned one, recorded beside it as information and never reconciled with it.
 *
 * There is no `reference`: mppx's `receipt.reference` is the channel id, not a transaction hash.
 * The settlement hash comes from `session.close()` and belongs to the session, not to a
 * call.
 */
export interface TempoPayment {
  rail: "tempo";
  /** Tempo mainnet. Pinned rather than read, so a record names the chain it was paid on. */
  chainId: number;
  /** The agent's Tempo address: the account that signed the vouchers. */
  payer: string;
  /** The TIP-1034 channel the vouchers were signed against. */
  channelId: string;
  cumulativeBefore: string;
  cumulativeAfter: string;
  /** The body's `usage.cost` in USD, when the gateway returned one. */
  usageCost?: number;
  /**
   * The access key that signed the vouchers, when the account was a loop's key rooted on the payer
   * (`account.accessKeyAddress`); `payer` is then still the root. Absent on a treasury-signed record,
   * which therefore carries no `signer` key at all.
   */
  signer?: string;
  /** The Tempo block the channel opened in, decimal, when known: bounds an audit's `ChannelOpened` read. */
  openBlock?: string;
}

export interface ChatResult {
  /** HTTP status; logged verbatim as the action's `status_code`. */
  status: number;
  /** Identical in shape whether the reply was streamed or buffered — `resultHash` commits to it. */
  body: ChatResponse;
  /** Set only when the reply arrived as an SSE stream. Not part of the hashed body. */
  streamed?: boolean;
  /**
   * Set only on the `tempo` rail. `OpenRouterClient` leaves it undefined, so a keyed call's result
   * carries no payment bytes at all.
   */
  payment?: TempoPayment;
}

/**
 * A call the gateway was paid for whose answer never arrived: a stream cut short, a mid-stream
 * `error` frame, an abort after the headers.
 *
 * mppx advances the channel's cumulative when it *signs* the voucher, before the paid request is
 * even sent, and restores it only for a request that fails before a 2xx — a fetch that throws, or
 * a non-2xx with no receipt. A body that dies after its 2xx headers is therefore paid for, and a
 * transport that let the plain error through would hand the runtime nothing to record: no Action,
 * no voucher, and the next record's `cumulativeBefore` would jump over this one, which
 * `verifyChannels` reads as a non-contiguous channel.
 *
 * So the transport raises this instead, carrying the voucher bracket exactly as a successful
 * call's `payment` would (no `usageCost`: there is no body to have one), and the runtime records
 * it as a failed `llm.*` Action before resolving the session. Declared here, beside `TempoPayment`,
 * because it is part of what any `ChatTransport` may say, not a detail of the MPP one.
 */
export class PaidCallFailed extends Error {
  /**
   * @param status The HTTP status, only when the gateway answered with a failure status and kept
   *   the voucher anyway. Absent for a failure after 2xx headers, whose 200 says nothing about
   *   the call — the runtime records those as 502.
   * @param timedOut True when what cut the call was the transport's own deadline (`NoAnswerTimeout`)
   *   rather than the caller's signal or the stream itself: the model got no answer out in time.
   *   Absent otherwise, so a `PaidCallFailed` without it reads as a plain paid failure.
   */
  constructor(message: string, readonly payment: TempoPayment, readonly status?: number, readonly timedOut?: boolean) {
    super(message);
    this.name = "PaidCallFailed";
  }

  /**
   * By name as well as by class: the console loads the runtime from its bundle and a test from
   * source, and an error thrown by one copy of the class is not an `instanceof` the other.
   */
  static is(e: unknown): e is PaidCallFailed {
    return e instanceof PaidCallFailed || (e as { name?: unknown } | null)?.name === "PaidCallFailed";
  }
}

/**
 * The transport's own deadline ran out before the model's answer did (`transport/mpp.ts`): the
 * whole call's, or the first-data one a streamed attempt is given. Its own class, so the runtime
 * tells "the model never answered" — which it may retry, and which the owner is not billed for —
 * from a refusal, a 4xx or the caller walking away, none of which it may.
 */
export class NoAnswerTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAnswerTimeout";
  }

  /** By name as well as by class, for the reason `PaidCallFailed.is` gives. */
  static is(e: unknown): e is NoAnswerTimeout {
    return e instanceof NoAnswerTimeout || (e as { name?: unknown } | null)?.name === "NoAnswerTimeout";
  }
}

export interface ChatStreamOptions {
  /** Content deltas in order. When set, the request is sent with `stream: true`. */
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  /**
   * The instant (epoch ms) this attempt must be over by, all of it — read by a transport that
   * keeps deadlines (`MppOpenRouterTransport`) in place of its own default, and ignored by one that
   * does not. Absolute rather than a length because the call may wait in the transport's queue
   * first, and what binds is ZeroClaw's 120 s per request, which started before that wait.
   */
  deadlineAt?: number;
  /**
   * How long a streamed attempt may go without its first `data:` frame, ms, once it is sent. A
   * stream that is producing frames is not hung however long it takes, so this, and not a short
   * total, is what tells a stalled model from a slow one. Ignored on a buffered call.
   */
  firstDataMs?: number;
  /** Which attempt this is, for the transport's log line (`attempt 2 of 3, <model>`). */
  attempt?: string;
}

export interface ChatTransport {
  chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult>;
  /**
   * The Decisions API, when this transport has one. Optional so that a transport without one — the
   * recorded-fixture one, the console's scripted one — needs nothing for it, and a caller that wants
   * a decision tests for it rather than assuming it.
   */
  decide?(req: DecideRequest): Promise<DecideResult>;
}

/**
 * What a rail adds to `ChatStreamOptions`. Both rails share `chatCore` below, and the only thing
 * they disagree about is the frame that ends a stream.
 */
export interface ChatCoreOptions extends ChatStreamOptions {
  /**
   * `"done"` is OpenRouter's own `data: [DONE]` and is the default, which is what a keyed call to
   * `openrouter.ai` sends. `"receipt"` is the MPP gateway, which sends no `[DONE]`: a stream
   * there ends on `event: payment-receipt`, or on EOF after a chunk that carried a
   * `finish_reason`.
   */
  terminal?: StreamTerminal;
  /** The parsed `payment-receipt` frame, when the gateway sent one. Never part of the body. */
  onReceipt?: (receipt: Record<string, unknown>) => void;
  /**
   * Called once, at the first `data:` frame of a completion — the model has started answering. An
   * SSE comment (`: OPENROUTER PROCESSING`) is not one: it is what the gateway sends while it is
   * still waiting, which is exactly the hang a first-data deadline exists to see.
   */
  onFirstData?: () => void;
}

export type StreamTerminal = "done" | "receipt";

/** One SSE chunk of a streamed completion. Every field is optional: a chunk carries only what changed. */
interface ChatStreamChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: { role?: string; content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: ChatUsage;
  error?: unknown;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * The keyed, OpenRouter-native Decisions path. The MPP gateway proxies the same API one segment
 * higher, at `/alpha/decisions`, and 404s this one. Nothing billed uses it.
 */
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export class OpenRouterError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`OpenRouter request failed (${status}): ${body.slice(0, 400)}`);
    this.name = "OpenRouterError";
  }
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  /** Sent as `HTTP-Referer` / `X-Title`; OpenRouter uses them for attribution only. */
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}

/**
 * One POST, one normalisation, both rails. `openrouter.ai` with a bearer key and
 * `openrouter.mpp.tempo.xyz` with a payment channel differ in the URL, the headers and the frame
 * that ends a stream, and in nothing else — so the body a record hashes is assembled here for
 * both, and a chain written on one rail audits exactly like a chain written on the other.
 *
 * `fetchImpl` is what makes the `tempo` rail possible without a second reader: mppx's
 * `session.fetch` is a `fetch` that signs a voucher before it sends, and the transport passes it
 * in here. Nothing is ever sent twice: a refused voucher or a provider error is raised to the
 * runtime, which resolves the session, rather than being paid for a second time.
 */
export async function chatCore(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  req: ChatRequest,
  opts?: ChatCoreOptions
): Promise<ChatResult> {
  // Without `onToken` the request is unchanged: no `stream` field in the body, so a buffered session sends the bare
  // request, and streaming does not touch its `argsHash`. `usage: { include: true }` is already on every request, which
  // is what makes OpenRouter put `usage` in the final chunk of a streamed one.
  const streaming = !!opts?.onToken;
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(streaming ? { ...req, stream: true } : req),
    signal: opts?.signal,
  });
  if (streaming) return readStream(res, opts!);

  const text = await res.text();
  if (!res.ok) throw new OpenRouterError(res.status, text);
  let body: ChatResponse;
  try {
    body = JSON.parse(text) as ChatResponse;
  } catch {
    // A 200 with an HTML or empty body (a gateway page, a cut connection) is a provider
    // error, and the status and body are what a reader needs to see.
    throw new OpenRouterError(res.status, text);
  }
  return { status: res.status, body };
}

/**
 * Reassembles an SSE completion into the `ChatResponse` a buffered request would have
 * returned. `argsHash`/`resultHash` commit to that body, so a chain written from a streamed
 * session has to audit exactly like one written from a buffered session — which is why the
 * merge rules below are exact rather than good-enough-for-display.
 */
async function readStream(res: Response, opts: ChatCoreOptions): Promise<ChatResult> {
  if (!res.ok) throw new OpenRouterError(res.status, await res.text());
  if (!res.body) throw new OpenRouterError(res.status, "streamed response carried no body");
  const onToken = opts.onToken!;
  const terminal: StreamTerminal = opts.terminal ?? "done";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // A network chunk can split a `data:` line anywhere, including inside a JSON escape, so a
  // line is parsed only once its newline has arrived; `buffer` is what is still incomplete.
  let buffer = "";
  let raw = "";
  let done = false;

  let id: string | undefined;
  let model: string | undefined;
  let content: string | undefined;
  let finishReason: string | undefined;
  let usage: ChatUsage | undefined;
  const toolCalls = new Map<number, ToolCall>();
  // The name of the SSE event the next `data:` line belongs to. The gateway names every frame
  // (`event: message`, `event: payment-receipt`); OpenRouter names none, so it stays undefined.
  let event: string | undefined;
  let sawData = false;

  const consume = (line: string): void => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    // A blank line closes an SSE event, so its name does not leak onto the next one.
    if (!trimmed) {
      event = undefined;
      return;
    }
    // `: OPENROUTER PROCESSING` keep-alives are SSE comments, not data.
    if (trimmed.startsWith(":")) return;
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice("event:".length).trim();
      return;
    }
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    if (event === "payment-receipt") {
      // The gateway's session receipt: the terminal frame on the `tempo` rail, and never
      // a completion chunk, so it is not merged into the body. A receipt that does not parse
      // still ends the stream — the completion in front of it is complete either way.
      if (terminal !== "receipt") return;
      done = true;
      try {
        opts.onReceipt?.(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        /* the frame is the signal; its contents are information */
      }
      return;
    }
    let chunk: ChatStreamChunk;
    try {
      chunk = JSON.parse(payload) as ChatStreamChunk;
    } catch {
      throw new OpenRouterError(res.status, raw);
    }
    if (!sawData) {
      sawData = true;
      opts.onFirstData?.();
    }
    // A mid-stream `error` object is how a provider failure is reported once the 200 headers
    // are already sent. It never becomes a completion, so it has to raise rather than be
    // assembled into a short reply that would then be anchored as if it were the answer.
    if (chunk.error) throw new OpenRouterError(res.status, JSON.stringify(chunk.error));
    if (id === undefined && chunk.id) id = chunk.id;
    if (model === undefined && chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content = (content ?? "") + delta.content;
      onToken(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      // Deltas for several calls interleave; `index` is the only thing that ties them together.
      const at = tc.index ?? 0;
      const call = toolCalls.get(at) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (tc.id) call.id = tc.id;
      if (tc.type) call.type = tc.type;
      if (tc.function?.name) call.function.name = tc.function.name;
      // Arguments arrive as JSON fragments and are only valid concatenated in arrival order.
      if (tc.function?.arguments !== undefined) call.function.arguments += tc.function.arguments;
      toolCalls.set(at, call);
    }
  };

  try {
    for (;;) {
      // A caller that has stopped waiting must not keep a body draining: on the `tempo` rail the
      // channel behind it is open and has already signed for the call. A `fetch` that honours
      // the signal rejects the read instead; this covers one that does not.
      if (opts.signal?.aborted) throw new OpenRouterError(res.status, "the stream was aborted by its caller");
      const next = await reader.read();
      if (next.done) break;
      // Decoded once — decoding the same bytes twice with `stream: true` would desynchronise
      // the decoder's multi-byte state.
      const text = decoder.decode(next.value, { stream: true });
      raw += text;
      buffer += text;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        consume(line);
      }
      if (done) break;
    }
    // A well-formed stream ends on its terminal frame, so a trailing line with no newline behind
    // it only happens on a cut one; it is still read, because it may carry that frame itself.
    if (!done && buffer) consume(buffer);
  } finally {
    // The connection is finished with either way; cancelling a drained reader is a no-op.
    await reader.cancel().catch(() => undefined);
  }

  // The MPP gateway sends no `[DONE]` and may close the connection as soon as the receipt is
  // written, so a chunk carrying a `finish_reason` plus EOF is a complete reply there.
  if (!done && terminal === "receipt" && finishReason !== undefined) done = true;
  // No terminal frame at all means the stream was cut: the message may be missing its tail, and
  // anchoring a truncated result as though it were the whole answer is the failure this closes.
  if (!done) throw new OpenRouterError(res.status, raw);

  const message: ChatMessage = {
    role: "assistant",
    // A tool-call-only reply has no content deltas at all, and the buffered form of that is
    // `content: null` — not `""`, which would hash to a different body.
    content: content ?? null,
  };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.keys()].sort((a, b) => a - b).map((i) => toolCalls.get(i)!);
  }
  const body: ChatResponse = {
    id: id ?? "",
    model: model ?? "",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) body.usage = usage;
  return { status: res.status, body, streamed: true };
}

/**
 * A bearer-key transport over `chatCore`, with no caller left in the console or the runtime.
 *
 * It stays in the tree for one reason: `tests/tempo-inference.ts` builds one over a fake `fetch`
 * to produce the body an MPP-paid call is compared against, byte for byte, and that suite is the
 * proof that the rail is invisible to the chain. No route, no script and no runtime path
 * constructs it — nothing here reads `OPENROUTER_API_KEY`, and a billed call is paid over MPP. It
 * can go once that suite and `tests/openrouter-stream.ts` read `chatCore` directly.
 */
export class OpenRouterClient implements ChatTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenRouterOptions) {
    if (!opts.apiKey) throw new Error("OpenRouterClient needs an apiKey");
    this.baseUrl = (opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("no fetch implementation available; pass fetchImpl");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.opts.referer) h["HTTP-Referer"] = this.opts.referer;
    if (this.opts.title) h["X-Title"] = this.opts.title;
    return h;
  }

  /** `chatCore` with a bearer key, `[DONE]` as the terminal frame, and no `payment`. */
  async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult> {
    return chatCore(this.fetchImpl, `${this.baseUrl}/chat/completions`, this.headers(), req, opts);
  }

  /**
   * `decideCore` with the same bearer key, for symmetry and for tests. No `payment`: this rail
   * pays with a key rather than a voucher, and nothing billed constructs this client.
   *
   * The URL is derived from `baseUrl` — the Decisions API is a sibling of `/v1`, not a path under
   * it — so a test that points `baseUrl` at a fake host reaches the same fake host here.
   */
  async decide(req: DecideRequest): Promise<DecideResult> {
    const url = this.baseUrl.endsWith("/v1")
      ? `${this.baseUrl.slice(0, -"/v1".length)}/alpha/decisions`
      : OPENROUTER_DECISIONS_URL;
    return (await decideCore(this.fetchImpl, url, this.headers(), req)).body;
  }
}

/**
 * OpenRouter's Decisions API (alpha), which is not a chat model: TypeSafe's Jev takes a `state`
 * and a set of typed `questions` and answers each one with a `confidence`. Lath uses it for one
 * thing — a second model judging a loop step's output before it becomes memory.
 *
 * A decision is **not** an Action and writes no record. It is committed through the step's
 * `loop.step` manifest as `verifyHash`, the hash of the decision blob in the trace store, so the
 * verdict, its confidence, the model build that gave it and the voucher that paid for it are all
 * inside bytes the step already commits. Adding a record per decision would put a second leaf in
 * a step that the chain defines as one leaf.
 */
export interface DecideRequest {
  /** Pinned, never the moving `~typesafe/jev-latest` alias: `policy_version_hash` commits it. */
  model: string;
  /** Everything the judge is shown, as one string under fixed labels (`verifyState` in the SDK). */
  state: string;
  /** The typed questions, keyed by answer name. Shaped by the caller; the wire takes them as-is. */
  questions: Record<string, unknown>;
}

/**
 * One answer per question. Which of `noul` / `choice` / `score` is present follows the question's
 * type, and `confidence` is on every one of them — it is what the runtime thresholds.
 */
export type DecideAnswers = Record<
  string,
  {
    noul?: number;
    choice?: string;
    score?: number;
    confidence: number;
    probabilities?: Record<string, number>;
  }
>;

/** The gateway's answer body, plus the payment when the call was paid over MPP. */
export interface DecideResult {
  answers: DecideAnswers;
  /** The dated build the gateway resolved, e.g. `typesafe/jev-1.13-20260917`. */
  model: string;
  id: string;
  provider?: string;
  usage?: ChatUsage;
  /** Set only on the `tempo` rail, exactly as `ChatResult.payment` is. */
  payment?: TempoPayment;
}

/** Separate from `chat`: a decision is a different endpoint, a different body, and never a stream. */
export interface DecideTransport {
  decide(req: DecideRequest): Promise<DecideResult>;
}

/**
 * One POST, no stream reader: nothing on `/alpha/decisions` streams, so sharing `chatCore`'s SSE machinery would only
 * make a decision look like a completion. Non-200 and a body that is not JSON both raise `OpenRouterError`, as a
 * buffered `chatCore` call does, so a caller tells "the verifier was unavailable" from "the verifier answered" on one
 * exception type.
 */
export async function decideCore(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  req: DecideRequest
): Promise<{ status: number; body: DecideResult }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: req.model, state: req.state, questions: req.questions }),
  });
  const text = await res.text();
  if (!res.ok) throw new OpenRouterError(res.status, text);
  let body: DecideResult;
  try {
    body = JSON.parse(text) as DecideResult;
  } catch {
    throw new OpenRouterError(res.status, text);
  }
  return { status: res.status, body };
}
