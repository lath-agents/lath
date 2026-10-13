/**
 * The tools socket (`t.sock`): how a sandboxed ZeroClaw step calls Lath's host tools
 * (`zeroclaw/CONTRACT.md` §3).
 *
 * The Lath build compiles `store_get`, `store_set`, `solana_slot`, `solana_fees`, `solana_balance`
 * and `lath_verify_chain` into its registry as thin clients of this socket: each POSTs the
 * arguments the model gave to `/tools/<tool id>` — the dotted id, never the wire name — and hands
 * the answer back as the tool's result. On this side the call is dispatched to a callback the host
 * binds to `AgentRuntime.callTool`, which runs the tool and writes its Action, so a host tool
 * called from inside the sandbox is **one Action with 200 / 400 / 404 / 500, written by the same code
 * as an in-process call** (`runToolCall`). The arguments are forwarded as the model gave them and are
 * not checked here: `callTool` holds them to the tool's schema, once for both paths. Nothing is
 * recorded here itself, and the model socket (`proxy.ts`) records none of these calls, so each lands
 * on the chain once.
 *
 * Only ids in `allow` — the policy's host tools — are dispatched. The binary's registry is built
 * from the same list, so an id outside it is a sandbox asking for more than the host configured. It
 * never reaches a tool: it is answered **403** and anchored as a 403 Action under the id asked for,
 * because the attempt is the fact worth committing — _every rejection is itself anchored_. A body
 * that is not JSON stays a 400 with no Action: the binary re-serialises arguments it parsed, so
 * there is no call to name.
 *
 * One call at a time, for the reason the model socket serialises: the chain is a sequence.
 */
import * as http from "node:http";
import { errorText } from "../errors";
import {
  ProxyRefused,
  bearerMatches,
  CLOSE_SETTLE_MS,
  closeSocketServer,
  listenOnSocket,
  readJsonBody,
  sendJson,
  serialiser,
  settleQueue,
} from "./proxy";

export interface HostToolsOptions {
  /** Absolute path of the socket to create. It must not exist. */
  socketPath: string;
  /** The step's bearer token (`[lath] tools_token` in the sandbox's config). */
  token: string;
  /** The dotted ids this step may call: the policy's host tools. */
  allow: readonly string[];
  /**
   * Runs one tool and writes its Action. The host binds it to `AgentRuntime.callTool` for the
   * session this step is. A throw — the Action did not land — fails the step: the sandbox gets a 500
   * and `failure()` keeps the throw.
   */
  call: (toolId: string, args: unknown) => Promise<{ result: unknown; statusCode: number }>;
  /**
   * Writes the 403 Action for an id outside `allow`. The host binds it to
   * `AgentRuntime.recordToolAction`. A throw — the Action did not land — fails the step, as a throw
   * from `call` does.
   */
  onRefused: (toolId: string, args: unknown, error: string) => Promise<void>;
  /** Largest arguments body accepted, bytes. Default 1 MiB: a `store.set` value is a cell's worth. */
  maxBodyBytes?: number;
  /** How long a call may outlive the sandbox before the step is failed for it, ms. Default `CLOSE_SETTLE_MS`. */
  closeSettleMs?: number;
}

export interface HostToolsServer {
  readonly socketPath: string;
  /** The first throw from `call`, when there was one; once set, every later call is refused. */
  failure(): unknown;
  /** Calls that reached `call`. */
  calls(): number;
  /** Stops serving, then waits for the call in flight to write its Action, however long (`CLOSE_SETTLE_MS`). */
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const PREFIX = "/tools/";
/**
 * What an id must look like to be anchored at all: printable ASCII with no space, at most 64 bytes.
 * A refused id is written onto the chain as a tool id, and a path segment of any length or bytes is
 * not something a sandbox should be able to make the host write; what fails this is a 404 with no
 * Action, like any other path this socket does not serve.
 */
const TOOL_ID = /^[\x21-\x7e]{1,64}$/;

export async function startHostTools(opts: HostToolsOptions): Promise<HostToolsServer> {
  const allow = new Set(opts.allow);
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const serial = serialiser();
  let failed: { error: unknown } | undefined;
  let calls = 0;
  // Set by `close()`: a call still queued has no sandbox to answer, so it runs nothing.
  let closing = false;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!bearerMatches(req.headers.authorization, opts.token)) {
      return sendJson(res, 401, { error: "this socket answers the step it was made for" });
    }
    const url = req.url ?? "";
    if (req.method !== "POST" || !url.startsWith(PREFIX)) {
      return sendJson(res, 404, { error: `${req.method} ${url} is not served here` });
    }
    let toolId: string;
    try {
      toolId = decodeURIComponent(url.slice(PREFIX.length));
    } catch {
      return sendJson(res, 404, { error: "the tool id is not a valid path segment" });
    }
    if (!TOOL_ID.test(toolId)) {
      return sendJson(res, 404, { error: "the tool id is not one this socket could name" });
    }
    let args: unknown;
    try {
      args = await readJsonBody(req, maxBody);
    } catch (e) {
      // Not a call the model made: the binary re-serialises arguments it already parsed, so a body
      // that is not JSON never came from a model turn and is not an Action.
      return sendJson(res, (e as ProxyRefused).status ?? 400, { error: errorText(e) });
    }

    await serial(async () => {
      if (closing) return sendJson(res, 503, { error: "the step is over: its sandbox has exited" });
      if (failed) {
        return sendJson(res, 503, { error: `the step has already failed: ${errorText(failed.error)}` });
      }
      if (!allow.has(toolId)) {
        const error = `the tool "${toolId}" is not one this step's policy allows`;
        try {
          await opts.onRefused(toolId, args, error);
        } catch (e) {
          failed = { error: e };
          return sendJson(res, 500, { error: errorText(e) });
        }
        return sendJson(res, 403, { error });
      }
      calls++;
      let outcome: { result: unknown; statusCode: number };
      try {
        outcome = await opts.call(toolId, args);
      } catch (e) {
        failed = { error: e };
        return sendJson(res, 500, { error: errorText(e) });
      }
      const { result, statusCode } = outcome;
      if (statusCode >= 200 && statusCode < 300) return sendJson(res, 200, { result: result ?? null });
      // `callTool` answers 404, 400 or 500 with `{ error }`; the sandbox's tool returns that text as
      // its error, which is what the model reads, exactly as `runToolCall` shows it the same object.
      // A 400 — arguments the tool's schema refuses, checked in `callTool` so this socket and
      // the ReAct loop share one check — goes over the wire as a 500, because the binary reads only
      // 200, 404 and 500 as a tool's answer (CONTRACT §3) and anything else as a failed call. The
      // Action already carries the 400.
      const error = typeof (result as any)?.error === "string" ? (result as any).error : JSON.stringify(result ?? null);
      return sendJson(res, statusCode === 404 ? 404 : 500, { error });
    });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!failed) failed = { error: e };
      if (!res.headersSent) sendJson(res, 500, { error: errorText(e) });
    });
  });
  await listenOnSocket(server, opts.socketPath);

  return {
    socketPath: opts.socketPath,
    failure: () => failed?.error,
    calls: () => calls,
    close: async () => {
      closing = true;
      await closeSocketServer(server, opts.socketPath);
      const ms = opts.closeSettleMs ?? CLOSE_SETTLE_MS;
      if (!(await settleQueue(serial, ms))) {
        // Failed for it, and still waited out: a tool that ran has done something its Action must
        // name before the session resolves (`CLOSE_SETTLE_MS`).
        if (!failed) {
          failed = { error: new Error(`a host tool call was still running ${ms / 1000} s after the sandbox exited`) };
        }
        await serial.idle();
      }
    },
  };
}
