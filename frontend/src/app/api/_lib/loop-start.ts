/**
 * A loop's start, answered whole or as it goes.
 *
 * A start holds `POST /api/loops` through the check, the source fetch and the Irys upload — the
 * minute it can take — and a form waiting on a bare spinner tells its owner nothing. Both answers
 * run the same four steps in the same order (the route's comment says why each is where it is),
 * through `answerLoopStart`. A client asking for `text/event-stream` is told each stage as it
 * begins, and then the answer it would have had — `streamLoopStart` wraps the same call, so the two
 * cannot drift apart: the final event is the plain response's status and body, built by the same
 * code from the same values.
 *
 * Here and not in the route because a file that imports `next/server` cannot be loaded outside
 * `frontend/`, and the claim that the two answers agree is one a Node suite should be able to hold
 * (`tests/console-loop-start-stream.ts`).
 */
import { rateLimit, type SessionAuth } from "./runner";
import type { LoopStartOrigin } from "./lifecycle";
import { sse } from "./sse";
import { errorText } from "@lath/runtime";
import {
  LOOPS_PER_HOUR,
  checkLoopStart,
  planPreparedStart,
  prepareLoopStart,
  readLoop,
  startLoop,
  tellStage,
  zeroclawReadiness,
  type LoopRecord,
  type LoopStartBody,
  type LoopStartStage,
  type SandboxHooks,
  type StartHooks,
} from "./loops";
import type { LoopView } from "../../../types/loop";

/** What the route answers a start with: a status and the JSON body, which streamed is the final event. */
export interface LoopStartAnswer {
  status: number;
  body: { loop: LoopView } | { error: string; loop?: LoopView };
}

export interface LoopStartOptions {
  /** `wallet:ip`, the key the hourly start counter is held under. */
  caller: string;
  /** The route's `viewOf`: the public view, with the owner's texts for the signer. */
  view: (loop: LoopRecord) => LoopView;
  /** `prepareLoopStart`'s hooks — the treasury read in the route, stubs in a suite. */
  hooks?: StartHooks & SandboxHooks;
  /** `startLoop` by default; a suite records the loop without arming its clock. */
  start?: (loop: LoopRecord, home?: string, origin?: LoopStartOrigin) => void;
  /**
   * The `"Lath loop"` message the route verified this start with. Handed to the row's owed
   * `loop.start` (with the body less it, which its `Request ID` hashes) and persisted nowhere else.
   */
  auth?: SessionAuth;
  onStage?: (stage: LoopStartStage) => void;
}

/**
 * A signed start, from the sandbox check to the armed clock. Every refusal is returned as the route
 * answers it; a throw is left to the caller, which is where the route lets one go (a 500), and
 * where the stream turns it into a final event rather than a hung request.
 */
export async function answerLoopStart(
  body: LoopStartBody,
  wallet: string,
  opts: LoopStartOptions
): Promise<LoopStartAnswer> {
  const { view, onStage } = opts;
  const hooks = opts.hooks ?? {};
  tellStage(onStage, { stage: "checking" });
  // Every step of every loop runs in a sandbox, so a console without a working binary or wrapper
  // starts none and says why. First, because it is about this server, not about the loop asked for;
  // there is no in-process fallback to offer instead.
  const sandbox = (hooks.readiness ?? zeroclawReadiness)();
  if ("reason" in sandbox) return { status: 503, body: { error: sandbox.reason } };

  const allowed = checkLoopStart(body, wallet);
  if ("error" in allowed) {
    return {
      status: allowed.status,
      body: { error: allowed.error, ...(allowed.running ? { loop: view(allowed.running) } : {}) },
    };
  }
  const refused = rateLimit("loop starts", `loop-start:${opts.caller}`, LOOPS_PER_HOUR);
  if (refused) return { status: 429, body: { error: refused } };
  const prepared = await prepareLoopStart(body, wallet, { ...hooks, onStage });
  if ("error" in prepared) return { status: prepared.status, body: { error: prepared.error } };
  tellStage(onStage, { stage: "starting" });
  // `planPreparedStart` discards the fetch when the plan is refused or throws, so a start that
  // never runs leaves no files behind in `LATH_ZEROCLAW_HOME`.
  const planned = planPreparedStart(prepared, wallet, hooks.zeroclawHome);
  if ("error" in planned) {
    return {
      status: planned.status,
      body: { error: planned.error, ...(planned.running ? { loop: view(planned.running) } : {}) },
    };
  }
  const { auth: _signed, ...startBody } = body as LoopStartBody & { auth?: unknown };
  (opts.start ?? startLoop)(planned.loop, undefined, {
    ...(opts.auth ? { auth: opts.auth, startBody: startBody as Record<string, unknown> } : {}),
  });
  // Read back rather than the plan: `startLoop` is what sets the status and the first step's time.
  return { status: 200, body: { loop: view(readLoop(planned.loop.id) ?? planned.loop) } };
}

/**
 * The same start as a stream: a `stage` event as each stage begins, then one `result` event
 * carrying `{ status, body }` — exactly what the plain answer would have been — and the end.
 *
 * The HTTP status is 200 whatever the result: a refusal is known only after the headers are sent,
 * so its status travels in the final event, and a client reads it there. A throw, which unstreamed
 * is Next's bare 500, is a final event with status 500 and the reason, so the button never waits on
 * an event that is not coming.
 *
 * A client that goes away does not stop the start. The owner signed for it and it may already have
 * written a chain (the sources' locator cell); it runs to its end, and its loop is on the list for
 * the page the client comes back to. Only the sending stops.
 */
export function streamLoopStart(run: (onStage: (stage: LoopStartStage) => void) => Promise<LoopStartAnswer>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          closed = true;
        }
      };
      let answer: LoopStartAnswer;
      try {
        answer = await run((stage) => send("stage", stage));
      } catch (e) {
        answer = { status: 500, body: { error: errorText(e) } };
      }
      send("result", answer);
      try {
        controller.close();
      } catch {
        /* already closed by a client that left */
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** Whether a request asked for the streamed answer: its `Accept` names `text/event-stream`. */
export function wantsStartStream(req: { headers: { get(name: string): string | null } }): boolean {
  return /\btext\/event-stream\b/i.test(req.headers.get("accept") ?? "");
}
