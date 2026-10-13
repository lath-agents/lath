/**
 * The model socket (`m.sock`): the one door a sandboxed ZeroClaw step has to a model, and the
 * place its model calls become Lath records (`zeroclaw/CONTRACT.md` §2).
 *
 * The binary speaks upstream's `custom` provider over a Unix socket: `POST /v1/chat/completions`
 * with `stream: false`, the step's token as the bearer. This listener answers exactly that and
 * nothing else. It is **the payer's front door, not a forwarder**: it holds no key and pays
 * nothing itself — `chat` is bound by the host to `AgentRuntime.paidChat`, so every request that
 * gets past the checks below is one admitted, paid, recorded and ceiling-checked call, written by
 * the same statements as a call the ReAct loop makes (`recordLlmStep`, the charge in the same
 * transaction, `checkCeiling`, the record of a paid call whose body was lost).
 *
 * What it enforces before anything is paid:
 * - the bearer, so only the sandbox this step was spawned into can spend against this session's cap;
 * - the model, which the Genesis commits: a request naming another is a 400 (CONTRACT §2);
 * - the clock and the host: the binary is told the step's instant through `ZEROCLAW_NOW` and to
 *   leave the host out through `ZEROCLAW_OMIT_HOST`; a request that shows another instant or a host
 *   fact is refused, not rewritten. A rewrite that never fires is code that can only hide a
 *   regression, and a request carrying the wall clock is a step whose replay cannot match.
 *
 * What it records beside the model calls: ZeroClaw's own `file_read` and `file_write` run inside
 * the sandbox, where the host cannot see them. Their arguments are in the
 * model's reply and their results in the next request, byte for byte, and both cross this socket,
 * so the file calls of reply _i_ are handed to `onToolCalls` — to become `zc.file_read` /
 * `zc.file_write` Actions — when request _i+1_ arrives and **before** it is paid, so on the chain
 * each tool call sits between the model call that asked for it and the one that read its result.
 * The host tools the step allows (`hostTools`) are not recorded here: they cross the tools socket
 * (`host-tools.ts`), which writes their Actions as they run, and recording them twice would put
 * one call on the chain as two.
 *
 * Every other name a reply calls is one the model invented — a tool the sandbox's registry does not
 * hold, which ZeroClaw answers `Unknown tool` without running anything. It is recorded the same
 * way, from the next request, as a **404** Action under `unknown:<the name the model gave>`: that
 * is how the in-process runtime anchors an unknown tool (`callTool`), and the attempt
 * is the fact worth committing. The prefix is what keeps an invented `loop.step` or `storage.put`
 * off the ids the host writes and readers act on. Nothing the model asks for is left off the chain.
 *
 * One request at a time: the chain is a sequence and the meter is read after each call, so two
 * calls in flight would race both. A one-shot `agent -m` never sends two at once; a sandbox that did
 * would only wait.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ChatMessage, ChatRequest, ChatResult, ToolCall } from "../openrouter";
import { PaidCallFailed } from "../openrouter";
import { errorText } from "../errors";
import { CHAT_CALL_BUDGET_MS, ModelNoAnswer, undeclaredToolId } from "../runtime";
import { socketPathOk } from "./posture";

/** ZeroClaw's own tools, by the name the model calls them, to the id their Action carries. */
export const ZC_FILE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  file_read: "zc.file_read",
  file_write: "zc.file_write",
});

/**
 * A tool call seen in a model reply that the host does not run: one of ZeroClaw's own file tools,
 * or a name the model invented. `args` is the model's argument string parsed the way
 * `AgentRuntime.runToolCall` parses one (unparseable text becomes `{ _raw }`), so the args blob of
 * the Action is built exactly like every other tool Action's.
 */
export interface ObservedToolCall {
  /** The id the call carried in the reply, which its result names as `tool_call_id`. */
  callId: string;
  /** What the model called: `file_read`, `file_write`, or the invented name. */
  name: string;
  /** What the chain records: `zc.file_read` / `zc.file_write`, or `unknown:<invented name>`. */
  toolId: string;
  /** `file`: ZeroClaw ran it in the sandbox. `unknown`: nothing ran it; the sandbox answered `Unknown tool`. */
  kind: "file" | "unknown";
  args: unknown;
}

/**
 * An observed call with its result, ready to be one Action: `result` is the text ZeroClaw handed
 * back to the model verbatim. For a file tool `statusCode` is 500 when that text is one of
 * ZeroClaw's two error forms (`tool_execution.rs`: `Error: …` for a tool that returned a failure,
 * `Error executing <tool>: …` for one that raised), 200 otherwise — the split `runToolCall` makes
 * between a tool that returned and one that threw. An invented name is always 404.
 */
export interface ObservedToolAction extends ObservedToolCall {
  result: string;
  statusCode: number;
}

export interface ModelProxyOptions {
  /** Absolute path of the socket to create. It must not exist: a step's sandbox is fresh. */
  socketPath: string;
  /** The step's bearer token, minted when the sandbox was laid out. */
  token: string;
  /** The model the policy commits. Every request is sent with it; one naming another is a 400. */
  model: string;
  /** The temperature the policy commits. Every request is sent with it, whatever the sandbox asked. */
  temperature: number;
  /** What the host told the binary. `now` is the `ZEROCLAW_NOW` instant, RFC 3339 or a Date. */
  expect: { now: Date | string };
  /**
   * The wire names of the host tools this step allows (`store_get`, `solana_slot`, …): the calls a
   * reply makes to these are the tools socket's to record, and are skipped here. Required, because
   * a proxy that did not know them would record every host call a second time, as an invented one.
   */
  hostTools: readonly string[];
  /**
   * The paid call. The host binds it to `AgentRuntime.paidChat` for the session this step is, so
   * a request through here is recorded, charged and ceiling-checked by the same code as any call.
   * A throw fails the step: the reply is a non-2xx and `failure()` keeps the throw. `signal`
   * aborts when the sandbox closes the request, so a call nobody is waiting for stops holding
   * the queue.
   */
  chat: (req: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>;
  /**
   * The calls of reply _i_ that request _i+1_ resolved — file tools and invented names — in the
   * order reply _i_ made them, awaited before request _i+1_ is paid. The host binds it to
   * `AgentRuntime.recordToolAction`.
   */
  onToolCalls: (calls: ObservedToolAction[]) => Promise<void>;
  /** Largest request body accepted, bytes. Default 8 MiB — a system prompt and a step's history. */
  maxBodyBytes?: number;
  /** How long a call may outlive the sandbox before the step is failed for it, ms. Default `CLOSE_SETTLE_MS`. */
  closeSettleMs?: number;
}

export interface ModelProxy {
  readonly socketPath: string;
  /**
   * Observed calls a reply made whose results no later request carried: the sandbox stopped (its
   * iteration cap, a crash, a refusal) after asking for them. The host decides what they become;
   * they are not on the chain yet.
   */
  pending(): ObservedToolCall[];
  /**
   * What failed the step, when something did: the first refusal of an authenticated request, or
   * the first throw from `chat` / `onToolCalls`, kept as thrown so a `BudgetExceeded` still
   * resolves the session `aborted` when the host rethrows it. Once set, every later request is
   * refused unpaid — a step that has failed buys nothing more.
   */
  failure(): unknown;
  /** Requests that reached `chat`, paid or failed. */
  calls(): number;
  /**
   * Stops serving, then waits for the call in flight, if any, to be recorded, however long that takes
   * (`CLOSE_SETTLE_MS`), so the host reads `failure()` and `pending()` after every paid call of the
   * step is on its records.
   */
  close(): Promise<void>;
}

/** Why a request was refused before `chat`; carried as the step's failure. */
export class ProxyRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProxyRefused";
  }
}

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

export async function startModelProxy(opts: ModelProxyOptions): Promise<ModelProxy> {
  // Computed once and up front: a bad instant is the host's mistake, and it should stop the step
  // before a sandbox is spawned against a proxy that would refuse its first request.
  const clock = expectedClock(opts.expect.now);
  const hostTools = new Set(opts.hostTools);
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const serial = serialiser();
  let pending: ObservedToolCall[] = [];
  let failed: { error: unknown } | undefined;
  let calls = 0;
  // Set by `close()`: the sandbox has exited, so a request still queued behind the one in flight
  // has nobody to answer and buys nothing.
  let closing = false;

  const fail = (error: unknown) => {
    if (!failed) failed = { error };
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // The bearer first, before the path says anything: a caller without the step's token learns
    // nothing about what this socket serves, and does not fail the step it is not part of.
    if (!bearerMatches(req.headers.authorization, opts.token)) {
      return sendJson(res, 401, errorBody("this socket answers the step it was made for"));
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      return sendJson(res, 404, errorBody(`${req.method} ${req.url} is not served here`));
    }
    // ZeroClaw giving up (its provider timeout, or the process exiting) closes the connection
    // before a response is written; the paid call is told, rather than holding both queues —
    // this one and the transport's — for a reply nobody will read.
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) gone.abort(new Error("the sandbox closed the request before the model answered"));
    });
    let body: any;
    try {
      body = await readJsonBody(req, maxBody);
    } catch (e) {
      const status = (e as ProxyRefused).status ?? 400;
      // A body cut off because the sandbox went away (killed at its wall clock, or exited) is not the
      // sandbox's mistake: failing the step here would make "aborted" or "not JSON" the step's
      // reason, and the proxy's failure wins over the exit's, hiding the wall clock that ended it.
      // An oversized body also stops reading early, so 413 stays a refusal.
      if (closing || req.aborted || (!req.complete && status !== 413)) return;
      return refuse(res, status, errorText(e));
    }

    await serial(async () => {
      if (closing) return sendJson(res, 503, errorBody("the step is over: its sandbox has exited"));
      if (failed) {
        // Nothing after a failure is paid for: the step is over, whatever the sandbox does next.
        return sendJson(res, 503, errorBody(`the step has already failed: ${errorText(failed.error)}`));
      }
      // The error texts below avoid the phrases ZeroClaw's provider reads as "this endpoint
      // does not take tools" or "drop reasoning_effort" (`compatible.rs`, `lib.rs`
      // `rejects_tools_with_reasoning_effort`): on a 400 either would send a second, different
      // request for the same turn instead of failing it.
      if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
        return refuse(res, 400, "the body is not a chat completion request");
      }
      if (body.model !== opts.model) {
        return refuse(res, 400, `model ${JSON.stringify(body.model)} is not the model this step commits`);
      }
      if (body.stream === true) {
        return refuse(res, 409, "this socket answers with one JSON body; streaming is off for a step");
      }
      const clockRefusal = checkClock(body.messages, clock);
      if (clockRefusal) return refuse(res, 409, clockRefusal);

      // Reply i's observed calls, resolved by this request i+1, recorded before this request is paid.
      const { resolved, unresolved } = resolveToolCalls(pending, body.messages);
      if (resolved.length) {
        try {
          await opts.onToolCalls(resolved);
        } catch (e) {
          fail(e);
          return sendJson(res, 502, errorBody(`recording the sandbox's tool calls failed: ${errorText(e)}`));
        }
      }
      pending = unresolved;

      // Pinned in place, so the request the gateway sees and `args_hash` commits is ZeroClaw's
      // own, key for key, with the policy's model and temperature and the usage flag the meter
      // reads — which is the ReAct loop's request shape for the same fields.
      const request = { ...body, model: opts.model, temperature: opts.temperature, usage: { include: true } };
      calls++;
      let result: ChatResult;
      try {
        result = await opts.chat(request as ChatRequest, gone.signal);
      } catch (e) {
        fail(e);
        // A paid call that lost its body is already on the chain (`paidChat`); the sandbox is told
        // the call failed and the step fails with it. So is a call whose every attempt got no
        // answer: each paid attempt is on the chain already, and the step
        // fails with `ModelNoAnswer` as thrown, which is how its row says the model did not answer.
        // Anything else — the ceiling, a charge that did not land, an admission refusal — likewise
        // ends the step.
        const status = PaidCallFailed.is(e) || ModelNoAnswer.is(e) ? 502 : 503;
        return sendJson(res, status, errorBody(errorText(e)));
      }
      pending = [...pending, ...observedToolCalls(result.body?.choices?.[0]?.message, hostTools)];
      // The body as the model sent it, `usage` verbatim (ZeroClaw calibrates its context trimming
      // on it); the voucher is on `result.payment`, beside the body, and never enters the sandbox.
      sendRaw(res, 200, JSON.stringify(result.body));
    });
  };

  const refuse = (res: http.ServerResponse, status: number, message: string) => {
    fail(new ProxyRefused(status, message));
    sendJson(res, status, errorBody(message));
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      fail(e);
      if (!res.headersSent) sendJson(res, 500, errorBody(errorText(e)));
    });
  });
  await listenOnSocket(server, opts.socketPath);

  return {
    socketPath: opts.socketPath,
    pending: () => pending.map((c) => ({ ...c })),
    failure: () => failed?.error,
    calls: () => calls,
    close: async () => {
      closing = true;
      await closeSocketServer(server, opts.socketPath);
      const ms = opts.closeSettleMs ?? CLOSE_SETTLE_MS;
      if (!(await settleQueue(serial, ms))) {
        // The step fails for it, and still waits: the call was paid for, so its record is owed, and
        // it must land before the host resolves the session (see `CLOSE_SETTLE_MS`).
        fail(new Error(`a model call was still running ${ms / 1000} s after the sandbox exited`));
        await serial.idle();
      }
    },
  };
}

/** What the binary writes for the step's instant under `TZ=UTC` (patch 0001, `clock::now()`). */
export interface ExpectedClock {
  /** The user message's prefix: `[YYYY-MM-DD HH:MM:SS +00:00]` (`loop_.rs`, `%Y-%m-%d %H:%M:%S %Z`). */
  prefix: string;
  /** The line under `## Current Date`: `YYYY-MM-DD (+00:00)` (`system_prompt.rs`). */
  currentDate: string;
}

export function expectedClock(now: Date | string): ExpectedClock {
  const d = typeof now === "string" ? new Date(now) : now;
  if (!(d instanceof Date) || Number.isNaN(d.getTime()))
    throw new Error(`expect.now is not an instant: ${String(now)}`);
  // Truncated, not rounded, to the second: chrono's `%S` drops the fraction the same way.
  const iso = d.toISOString();
  const date = iso.slice(0, 10);
  return { prefix: `[${date} ${iso.slice(11, 19)} +00:00]`, currentDate: `${date} (+00:00)` };
}

const DATED = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[^\]\n]*)\]/;
const HOST_FACT = /(?:^|\| )(Host|OS|Shell):/;

/**
 * The reason to refuse a request whose clock or host is not what the host set, or
 * nothing. Checked, never rewritten.
 *
 * A user message with no date prefix passes: it leaks no clock. One with a prefix must carry the
 * step's instant exactly. In the system prompt the **last** `## Current Date` and `## Runtime`
 * sections are the ones read, because ZeroClaw writes them after the workspace's bootstrap files
 * (`system_prompt.rs` §5 before §6 and §7): a `MEMORY.md` the model wrote with a heading of the
 * same name comes earlier and must neither pass nor fail a step. `OS:` is checked with `Host:` and
 * `Shell:` because `ZEROCLAW_OMIT_HOST` drops the two together, so either one showing means the
 * variable did not take.
 */
export function checkClock(messages: ChatMessage[], clock: ExpectedClock): string | undefined {
  for (const m of messages) {
    const text = contentText(m?.content);
    if (m?.role === "user") {
      const dated = DATED.exec(text);
      if (dated && `[${dated[1]}]` !== clock.prefix) {
        return `the user message is dated [${dated[1]}], not the step's ${clock.prefix}`;
      }
    } else if (m?.role === "system") {
      const date = lastSectionLine(text, "## Current Date");
      if (date !== undefined && date !== clock.currentDate) {
        return `the system prompt's current date is "${date}", not the step's "${clock.currentDate}"`;
      }
      const runtime = lastSectionLine(text, "## Runtime");
      const fact = runtime !== undefined ? HOST_FACT.exec(runtime) : null;
      if (fact) return `the system prompt's runtime line names the host (${fact[1]}:); the step omits it`;
    }
  }
  return undefined;
}

/** The first line of the last `heading` section, trimmed; undefined when there is none. */
function lastSectionLine(text: string, heading: string): string | undefined {
  const marker = `${heading}\n\n`;
  const at = text.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = text.slice(at + marker.length);
  const end = rest.indexOf("\n");
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  // A content-parts array (OpenAI's multimodal shape): the text parts, in order.
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

/**
 * The calls in one assistant message the host does not run, in the order it made them: the file
 * tools, and every name that is neither a file tool nor one of the step's host tools. A call with
 * no id cannot be paired with its result and is skipped; so is one with no name, which is not a
 * call the sandbox could answer under any name.
 */
export function observedToolCalls(
  message: ChatMessage | undefined,
  hostTools: ReadonlySet<string>
): ObservedToolCall[] {
  const out: ObservedToolCall[] = [];
  for (const call of (message?.tool_calls ?? []) as ToolCall[]) {
    const name = call?.function?.name ?? "";
    if (!name || typeof call.id !== "string" || hostTools.has(name)) continue;
    const file = ZC_FILE_TOOLS[name];
    out.push({
      callId: call.id,
      name,
      // An invented name is recorded under the prefix, never as given: a model calling
      // `loop_step` or `loop.step` must not write a record readers take for the host's own.
      toolId: file ?? undeclaredToolId(name),
      kind: file ? "file" : "unknown",
      args: parseArgs(call.function?.arguments),
    });
  }
  return out;
}

/** As `AgentRuntime.runToolCall` parses a call's arguments, so the args blob is built the same way. */
function parseArgs(raw: string | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw ?? null };
  }
}

/**
 * Pairs each pending call with its result in this request: the **last** `role: "tool"` message
 * naming its id, because the newest results are at the end and ZeroClaw re-mints an id a model
 * repeats, so an earlier turn's message with the same id is an earlier call. Resolved calls keep
 * their reply order; a call with no result here stays pending.
 */
export function resolveToolCalls(
  pending: ObservedToolCall[],
  messages: ChatMessage[]
): { resolved: ObservedToolAction[]; unresolved: ObservedToolCall[] } {
  const resolved: ObservedToolAction[] = [];
  const unresolved: ObservedToolCall[] = [];
  for (const call of pending) {
    let reply: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "tool" && m.tool_call_id === call.callId) {
        reply = m;
        break;
      }
    }
    if (!reply) {
      unresolved.push(call);
      continue;
    }
    const result = contentText(reply.content);
    resolved.push({ ...call, result, statusCode: observedStatus(call, result) });
  }
  return { resolved, unresolved };
}

/**
 * The status an observed call's Action carries, from the text the sandbox handed the model: 404 for
 * an invented name whatever the text says (nothing ran), 500 for a file tool's error forms, 200
 * otherwise. Shared with the host's end-of-step path, which reads the same text out of the trace.
 */
export function observedStatus(call: Pick<ObservedToolCall, "kind">, result: string): number {
  if (call.kind === "unknown") return 404;
  return result.startsWith("Error: ") || result.startsWith("Error executing ") ? 500 : 200;
}

// ── Socket plumbing, shared with `host-tools.ts` ─────────────────────────────────────────────

/**
 * Listens on a fresh Unix socket, readable and writable by this user only. A path that already
 * exists is refused rather than unlinked: a sandbox's directory is new, so something there is either
 * another step's socket or a stale one this process should not be the one to remove.
 *
 * The length limit is `socketPathOk`'s, the one `ZeroClawRuntime` checks before it spawns anything
 * (103 bytes on macOS, 107 on Linux). A stricter limit here (103 everywhere, say) would let a Linux
 * path of 104–107 bytes pass that pre-spawn check and then fail every step here, after its Genesis,
 * as a plain Error rather than a `SandboxRefused` — so the loop would run on and pay for it. This
 * check is the backstop for a caller that did not run the pre-spawn one.
 */
export async function listenOnSocket(server: http.Server, socketPath: string): Promise<void> {
  if (!socketPathOk(socketPath, process.platform)) {
    throw new Error(
      `socket path is ${Buffer.byteLength(socketPath)} bytes, longer than a ${
        process.platform
      } socket allows: ${socketPath}`
    );
  }
  if (fs.existsSync(socketPath)) throw new Error(`socket path already exists: ${socketPath}`);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
}

/** Stops serving, drops any connection still open, and removes the socket file. */
export async function closeSocketServer(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  try {
    fs.unlinkSync(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** `Bearer <token>`, compared in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The body as JSON; a `ProxyRefused` (413 or 400) when it is too large or not JSON. */
export async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ProxyRefused(413, `the body is over ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProxyRefused(400, "the body is not JSON");
  }
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  sendRaw(res, status, JSON.stringify(value));
}

function sendRaw(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** OpenAI's error shape, which ZeroClaw's provider reads `error.message` out of. */
function errorBody(message: string): { error: { message: string } } {
  return { error: { message } };
}

/** A one-at-a-time queue, and `idle()`: resolves once nothing queued on it is still running. */
export type Serialiser = (<T>(fn: () => Promise<T>) => Promise<T>) & { idle(): Promise<void> };

/** Runs the functions it is given one at a time, in arrival order; one that throws does not stop the next. */
export function serialiser(): Serialiser {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = (<T>(fn: () => Promise<T>) => {
    const run = tail.then(() => fn());
    // The queue waits on each run whatever it came to; the caller still sees its own rejection.
    tail = run.catch(() => undefined);
    return run;
  }) as Serialiser;
  serial.idle = async () => {
    // Re-read after each wait: a handler that was still reading its body when the wait began can
    // have queued behind it since.
    for (let seen = tail; ; seen = tail) {
      await seen;
      if (seen === tail) return;
    }
  };
  return serial;
}

/**
 * How long a socket's `close()` waits for the call it was serving before it fails the step for it,
 * ms. It is not a cap on the wait: `close()` returns only once that call has finished and written
 * its record, because a call that has started has done something the chain must name — a model call
 * holds a voucher, a `store.set` has written its cell — and a record written after `close()`
 * returned lands after the session's Resolution, at a seq the loop's checkpoint may already hold.
 * Refusing that record instead would leave the voucher or the cell with no Action.
 *
 * What bounds the wait is each call's own deadline. Closing drops the connection, which aborts a
 * model call (`gone`), and the transport gives up within its abort grace, or at worst at
 * `CHAT_CALL_BUDGET_MS`. A host tool is bounded by the RPC and confirmation budgets of the client it
 * reads or writes through; it takes no abort signal (`ToolDefinition.execute`), so a tool whose
 * request never returns holds the step, which is the place it should be fixed. Past this many ms
 * the step is failed, so a session that waited this long is never reported as a clean one.
 */
export const CLOSE_SETTLE_MS = CHAT_CALL_BUDGET_MS + 10_000;

/**
 * Waits until `serial` is idle, for at most `ms`. True when it went idle. `close()` uses it to tell a
 * call that outlived `CLOSE_SETTLE_MS` — and fails the step for it — before waiting the rest out.
 * Without the wait, a socket closed by a sandbox that exited mid-call (its wall clock, an abort)
 * would leave `paidChat` running: the host would read `failure()` before the call threw and resolve
 * the session, and the call's paid record would be journaled after the Resolution, its debit after
 * the loop had stopped counting the session.
 */
export async function settleQueue(serial: Serialiser, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([serial.idle().then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}
