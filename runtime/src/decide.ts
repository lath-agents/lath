/**
 * One decision on the loop's channel, and what is kept of it when it was paid for and never
 * answered.
 *
 * Its own module, apart from `loop.ts`, so that every seat that calls the second model — the
 * verdict, a member's verdict, a routing choice — goes through one path. They are the same request
 * on the same channel under the same alpha endpoint, and two copies of the deadline or of the
 * paid-but-unanswered voucher rule are how two callers come to bound or account differently.
 */
import { Bytes32, hex, utf8, type DecisionBlob, type TempoPaymentRecord } from "@lath/sdk";
import { PaidCallFailed } from "./openrouter";
import type { DecideRequest, DecideResult, DecideTransport } from "./openrouter";
import { canonicalJson } from "./policy";

/**
 * On an `unavailable` verdict that was paid for all the same: the blob recording the
 * voucher, and what it came to. Neither is committed — the manifest keeps no `verifyHash` for a
 * decision that did not answer, so the chain says *not verified* as it does for any outage — but
 * the blob is in the step's store, and so in its bundle, next to every other voucher of the step.
 */
export interface UnansweredPaid {
  paidHash?: string;
  costBase?: string;
}

/**
 * The blob a decision the channel paid for and never answered is stored as. No
 * `answers`, so `decodeDecisionBlob` refuses it and nothing reads it as a verdict; `unanswered`
 * says so in the bytes, and `payment` is the voucher bracket `PaidCallFailed` carried, in the
 * shape every other voucher blob has it.
 */
export interface UnansweredDecisionBlob {
  request: DecisionBlob["request"];
  unanswered: true;
  error: string;
  payment: TempoPaymentRecord;
}

/**
 * Stores what a paid, unanswered decision cost, when the failure was one — `undefined` for every
 * other failure, which bought nothing. Never throws: a store that will not take the blob costs
 * the record of the voucher, not the step.
 */
export async function storeUnanswered(
  put: ((bytes: Uint8Array) => Promise<Bytes32>) | undefined,
  request: UnansweredDecisionBlob["request"],
  e: unknown
): Promise<UnansweredPaid> {
  if (!put || !PaidCallFailed.is(e)) return {};
  const payment = e.payment as TempoPaymentRecord;
  const blob: UnansweredDecisionBlob = { request, unanswered: true, error: e.message, payment };
  const costBase = (BigInt(payment.cumulativeAfter) - BigInt(payment.cumulativeBefore)).toString();
  try {
    return { paidHash: hex(await put(utf8(canonicalJson(blob)))), costBase };
  } catch {
    return { costBase };
  }
}

/**
 * A `DecideTransport` that also hears about the deadline.
 *
 * The optional second argument is what the MPP transport reads; the scripted and key-bearing
 * transports ignore it, as JavaScript ignores any argument a function did not declare, and the
 * `Promise.race` below still bounds them. Declared here rather than on `DecideTransport` so the
 * published transport interface keeps a shape that a transport without a signal parameter
 * already satisfies.
 */
export interface AbortableDecider extends DecideTransport {
  decide(req: DecideRequest, opts?: { signal?: AbortSignal }): Promise<DecideResult>;
}

/**
 * How long a decision the deadline abandoned is given to say whether it was paid for. The abort
 * reaches the MPP transport's fetch at once, and the transport answers within a read of the
 * counter — `PaidCallFailed` when the voucher had moved, a plain error when it had not — so this
 * bounds a transport that never hears the signal, not the normal case.
 */
export const DECIDE_PAID_GRACE_MS = 2_000;

/**
 * One decision, bounded, with the deadline aborting the request and not only losing the race.
 * Racing alone would leave the call running: the voucher is signed before the fetch, so a
 * decision that landed late would have been paid for on the loop's channel and then discarded, and
 * the channel would pay out more than the chain's blobs bought.
 *
 * The deadline then waits up to `graceMs` for the aborted call to settle, because what it settles
 * with is the only word on whether the voucher was signed. Rejecting with a plain `Error` the
 * moment the deadline fired would leave a call aborted after its 2xx headers — paid, and raising
 * `PaidCallFailed` a moment later — recorded nowhere: `storeUnanswered` needs the voucher bracket,
 * and its delta would never join `costBase`. So a timed-out call that was paid for rejects with
 * `PaidCallFailed` carrying its voucher, under the deadline's message, so every caller's
 * *unavailable* reason reads the same and gains the paid record. A call that answered inside the
 * grace is still late: it is not returned — the caller has already stopped waiting, and a verdict
 * that arrives past the deadline is not one the step may act on — but its voucher is kept the same
 * way. A call still silent at the end of the grace, or one that failed unpaid, is a plain timeout.
 *
 * Shared by every caller — the step's verdict, a member's verdict, a routing choice — because they
 * are the same request on the same channel under the same alpha endpoint, and one of them keeping
 * its own deadline is how they come to bound differently.
 */
export async function decideWithin(
  decider: AbortableDecider,
  req: DecideRequest,
  timeoutMs: number,
  graceMs: number = DECIDE_PAID_GRACE_MS
): Promise<DecideResult> {
  const abort = new AbortController();
  const call = decider.decide(req, { signal: abort.signal });
  // The call may settle after every race below has stopped listening; its rejection is read
  // (or deliberately dropped) here rather than surfacing as an unhandled one.
  call.catch(() => undefined);
  const late = Symbol("late");
  const after = <T>(ms: number, v: T) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(v), ms);
    });
    return { p, clear: () => clearTimeout(timer) };
  };

  const deadline = after(timeoutMs, late);
  let first: DecideResult | typeof late;
  try {
    first = await Promise.race([call, deadline.p]);
  } finally {
    deadline.clear();
  }
  if (first !== late) return first;

  abort.abort();
  const message = `the decision did not come back in ${timeoutMs} ms`;
  const grace = after(graceMs, late);
  let settled: { ok: DecideResult } | { err: unknown } | typeof late;
  try {
    settled = await Promise.race([
      call.then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err })
      ),
      grace.p,
    ]);
  } finally {
    grace.clear();
  }
  if (settled !== late) {
    if ("err" in settled && PaidCallFailed.is(settled.err)) {
      throw new PaidCallFailed(message, settled.err.payment, settled.err.status);
    }
    if ("ok" in settled && settled.ok.payment) {
      const p = settled.ok.payment;
      if (BigInt(p.cumulativeAfter) > BigInt(p.cumulativeBefore)) throw new PaidCallFailed(message, p);
    }
  }
  throw new Error(message);
}
