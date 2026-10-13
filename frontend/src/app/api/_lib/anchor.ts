/**
 * The server's one writer queue (`runtime/src/anchor.ts`).
 *
 * A session answers from a journal: every record is built and head-computed the instant it
 * exists, appended to `TRACE_DIR/pending/<agentId>.json`, and drained against the chain in seq
 * order afterwards. That only holds if there is exactly **one** writer per chain in this
 * process — two queues on one agent is the fork rule 3 of the queue exists to detect rather
 * than to allow — so the queue here is a module singleton and everything that anchors
 * (`/api/run`, `/api/loops`) goes through `anchorQueue()`.
 *
 * A queue is built once and lives for the life of the process, but the key that signs a write
 * is per chain: a console agent, a deployed agent and a loop member each have their own
 * `LathClient`. So the queue is given a *dispatching* client, and a caller says which client
 * and billing backend belong to a chain with `bindAnchorChain` before it journals anything on
 * it. The four methods below are the whole of what `AnchorQueue` asks a client for, and each
 * takes the agent id first, which is what makes the dispatch possible at all.
 *
 * Billing dispatches the same way. `charge` and `chargeIx` name a wallet and an amount, not a
 * chain, so charging every drained entry through the backend bound last would be right only while
 * the process writes one chain and drains it before the next is bound. Neither holds: a journal
 * entry left behind by an earlier session is drained after some other agent has been bound, and on
 * a dual-rail deployment that pays the wrong rail. So the queue asks which backend a chain uses at
 * each charge site (`BillingResolver`), and the answer comes from the same `chains` map as the key
 * that signs.
 */
import { AnchorEntry, AnchorEvent, AnchorQueue, ComposableBilling, FileAnchorJournal } from "@lath/runtime";
import { TransactionInstruction } from "@solana/web3.js";
import { LathClient, EventInput, Bytes32, hex, toBytes32 } from "@lath/sdk";
import { TRACE_DIR } from "./runner";

/** Attempts an entry gets before it is `failed` and its agent's queue halts. */
const ANCHOR_MAX_ATTEMPTS = 3;

interface Binding {
  client: LathClient;
  billing?: ComposableBilling;
}

/**
 * Everything this module remembers, pinned to the process rather than to the module.
 *
 * Next's dev server re-evaluates a route module whenever something it depends on is recompiled,
 * and navigating the console is enough to cause that. Module-level state does not survive it: a
 * second `AnchorQueue` would be built over the same journal, which is **two writers on one
 * chain** — the fork the header above says rule 3 exists to detect rather than to allow — and
 * the fault budget would re-arm, so the FAILED badge could never be exercised in a browser at all:
 * every click of *not anchored* would meet a freshly armed fault and fail again.
 *
 * `globalThis` outlives the module, so the queue built by the first evaluation is the queue every
 * later one uses, and a fault spent stays spent. Nothing here is per-request; it is per-process
 * by intent, and this is what makes that true in dev as well as in a build.
 */
interface AnchorState {
  chains: Map<string, Binding>;
  subscribers: Map<string, Set<(e: AnchorEvent) => void>>;
  /**
   * Per chain, the payers whose parked charges a drain of it may resend (`drainOwed`, rule 4a of
   * the queue). Absent for a chain no admission has scoped — a loop's, whose one payer is its
   * owner — which the queue reads as every payer.
   */
  parkedScope?: Map<string, readonly string[]>;
  queue?: AnchorQueue;
  /** Submits still to be failed on purpose; `-1` until `faultBudget()` has been read once. */
  faults: number;
}

const g = globalThis as typeof globalThis & { __lathAnchor?: AnchorState };
const state: AnchorState = (g.__lathAnchor ??= {
  chains: new Map(),
  subscribers: new Map(),
  faults: -1,
});

const chains = state.chains;
const subscribers = state.subscribers;
// Filled in rather than declared above: a process whose state was built by an earlier evaluation
// of this module (dev's hot reload) has no such map yet.
const parkedScope = (state.parkedScope ??= new Map());

/**
 * Under `--e2e` only: the number of submits still to be failed on purpose, so the `FAILED` badge
 * and its retry can be exercised in a browser without waiting for devnet to break. `1` means "fail
 * one entry all the way out", which is `ANCHOR_MAX_ATTEMPTS` submits; a larger number is taken
 * as the count of submits to fail. Never armed outside an E2E run: the fault is read once, here,
 * and `NEXT_PUBLIC_E2E_WALLET_SECRET` is set only by `dev-devnet.sh --e2e`.
 */
function faultBudget(): number {
  if (!process.env.NEXT_PUBLIC_E2E_WALLET_SECRET) return 0;
  const asked = Number(process.env.LATH_ANCHOR_FAIL ?? "0");
  if (!Number.isFinite(asked) || asked <= 0) return 0;
  return asked <= 1 ? ANCHOR_MAX_ATTEMPTS : Math.floor(asked);
}

/** Throws for the first N submits of an armed E2E run, and is a no-op in every other build. */
function injectFailure(what: string): void {
  if (state.faults < 0) state.faults = faultBudget();
  if (state.faults <= 0) return;
  state.faults -= 1;
  throw new Error(`LATH_ANCHOR_FAIL: ${what} was refused on purpose (${state.faults} more to go)`);
}

function bound(agentId: Bytes32): LathClient {
  const key = hex(agentId);
  const found = chains.get(key);
  // A chain nobody bound has no key to sign with. Failing here rather than signing with some
  // other agent's key is the point: the wrong authority is rejected by the program anyway, and
  // this says which chain was never bound.
  if (!found) throw new Error(`no client is bound for agent ${key.slice(0, 16)}…; bind it before anchoring`);
  return found.client;
}

/**
 * The client the queue writes through: every call is forwarded to the client bound for the agent
 * the call names. Only these four are used by `AnchorQueue`; anything else it grows would fail
 * loudly here rather than quietly write with the wrong key.
 */
const dispatcher = {
  getAgentState: (agentId: Bytes32) => bound(agentId).getAgentState(agentId),
  eventAddress: (agentId: Bytes32, seq: bigint) => bound(agentId).eventAddress(agentId, seq),
  logEventInput: (agentId: Bytes32, input: EventInput, compact: boolean, instructions?: TransactionInstruction[]) => {
    injectFailure("log_event");
    return bound(agentId).logEventInput(agentId, input, compact, instructions);
  },
  commitEpoch: (agentId: Bytes32, root: Bytes32, startSeq: bigint, endSeq: bigint) => {
    injectFailure("commit_epoch");
    return bound(agentId).commitEpoch(agentId, root, startSeq, endSeq);
  },
} as unknown as LathClient;

/**
 * The charges of one chain, sent through the backend that chain was bound to. The queue calls
 * this for every entry it is about to pay for, naming the entry's own agent — so a journaled
 * record drained long after its session ended still pays on its own rail, and a second agent
 * bound in between changes nothing. A chain with a binding but no backend is a chain
 * whose caller never meant to meter: that is an error here, not a free call.
 */
const billing = (agentId: Bytes32): ComposableBilling => {
  const key = hex(agentId);
  const backendOf = (): ComposableBilling | undefined => chains.get(key)?.billing;
  return {
    charge: (user, amount) => {
      const backend = backendOf();
      if (!backend?.charge) throw new Error(`no billing backend is bound for agent ${key.slice(0, 16)}…`);
      return backend.charge(user, amount);
    },
    chargeIx: async (user, amount) => {
      const backend = backendOf();
      if (!backend?.chargeIx)
        throw new Error(`the billing backend bound for agent ${key.slice(0, 16)}… cannot compose a charge instruction`);
      return backend.chargeIx(user, amount);
    },
    // Forwarded for the same reason `chargeIx` is, and preferred by the queue when present:
    // `BillingClient.chargeIxs` puts the legacy-grant repair in front of the debit, and a bare
    // `chargeIx` against an `Allowance` in the older layout fails every attempt of the entry and
    // halts the chain. A bound backend without it falls back to its own `chargeIx`, so a
    // backend that composes a single instruction still charges with that one instruction.
    chargeIxs: async (user, amount) => {
      const backend = backendOf();
      if (backend?.chargeIxs) return backend.chargeIxs(user, amount);
      if (!backend?.chargeIx)
        throw new Error(`the billing backend bound for agent ${key.slice(0, 16)}… cannot compose a charge instruction`);
      return [await backend.chargeIx(user, amount)];
    },
    // Part of the backend interface and not part of this path: the queue holds an `EventInput`,
    // not the payload `chargeAndLog` needs, which is why a journaled record's debit rides along as
    // an instruction instead. Forwarded rather than stubbed so the object is not a half-backend.
    // Resolved from `req.agentId` rather than the closure: the request names its own chain, and
    // the two agree on every path the queue has.
    chargeAndLog: (req) => {
      const backend = chains.get(hex(req.agentId))?.billing;
      if (!backend) throw new Error(`no billing backend is bound for agent ${hex(req.agentId).slice(0, 16)}…`);
      return backend.chargeAndLog(req);
    },
    // The in-doubt question (did a charge whose answer was lost land?), asked of the chain's own
    // backend. One that cannot ask — `NoopBilling` — answers "unknown", and the queue then holds the
    // charge rather than resend it.
    chargeLanded: async (signature) => {
      const backend = backendOf();
      return backend?.chargeLanded ? backend.chargeLanded(signature) : "unknown";
    },
  };
};

/**
 * Says which key signs for a chain, and which backend its charges go through. Called before a
 * session, a loop step or a retry journals anything: the queue outlives all three, and a record
 * left in the journal by an earlier process is only sendable once somebody has bound the chain
 * it belongs to again.
 */
export function bindAnchorChain(agentId: Bytes32 | string, b: Binding): void {
  chains.set(typeof agentId === "string" ? agentId.toLowerCase() : hex(agentId), b);
}

/** One queue per process, journalling to `TRACE_DIR/pending/`, built on first use. */
export function anchorQueue(): AnchorQueue {
  if (state.queue) return state.queue;
  state.queue = new AnchorQueue({
    client: dispatcher,
    journal: new FileAnchorJournal(TRACE_DIR),
    billing,
    maxAttempts: ANCHOR_MAX_ATTEMPTS,
    parkedScope: (agentId) => parkedScope.get(hex(agentId)) ?? "all",
    onEvent: (e) => {
      // A parked charge is a debt with no screen of its own: the operator's record of it is this
      // line and the journal it stays in (`TRACE_DIR/pending/<agentId>.json`, state `parked`).
      if (e.state === "parked") {
        console.warn(
          `[anchor] parked a ${e.amountMicroUsdc ?? "?"} µUSDC charge owed by ${e.payer ?? "?"} on ${e.agentId.slice(
            0,
            16
          )}… (${e.id}): ${e.error ?? "refused"}. The chain keeps landing; only that wallet's admission waits on it.`
        );
      }
      // The browser knows three states and no fourth (`lib/console-stream.tsx`). To the payer whose
      // message it is, a parked charge is a debit that did not land, which is what `failed` says
      // there — and its Retry is answered by that payer's own admission, 402 until they can pay.
      const seen: AnchorEvent = e.state === "parked" ? { ...e, state: "failed" } : e;
      for (const fn of subscribers.get(e.agentId.toLowerCase()) ?? []) {
        try {
          fn(seen);
        } catch {
          // A stream that has already closed must not stop the writer.
        }
      }
    },
  });
  return state.queue;
}

/**
 * Every state transition on one chain, for as long as the returned function is not called. The
 * queue emits for whatever it is draining, including records journaled by a session that has
 * already answered and closed its stream, so a subscriber is per request and never a listener
 * left behind.
 */
export function subscribe(agentId: Bytes32 | string, fn: (e: AnchorEvent) => void): () => void {
  const key = typeof agentId === "string" ? agentId.toLowerCase() : hex(agentId);
  const set = subscribers.get(key) ?? new Set();
  set.add(fn);
  subscribers.set(key, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(key);
  };
}

/**
 * The USDC a drain of this chain would move, and whose it is.
 *
 * A journal entry can carry money: an `event` with a `charge` pays for itself in the same
 * transaction, and a `charge` entry is a debit of its own. Both name the **payer** — the wallet
 * whose `Allowance` the program will check — so whether a caller may drain this chain is a
 * question with an answer on disk, before anything is bound or sent.
 */
function chargesOwed(entries: AnchorEntry[]): { payers: string[]; microUsdc: bigint } {
  const payers = new Set<string>();
  let microUsdc = 0n;
  for (const e of entries) {
    if (e.state === "verified") continue;
    const owed =
      e.kind === "charge"
        ? { user: e.user, amountMicroUsdc: e.amountMicroUsdc }
        : e.kind === "event"
        ? e.charge
        : undefined;
    if (!owed) continue;
    payers.add(owed.user);
    microUsdc += BigInt(owed.amountMicroUsdc);
  }
  return { payers: [...payers], microUsdc };
}

/**
 * The same question asked of the queue, journal included: `carried` loads the chain's journal,
 * which is what makes this answerable in a process that never ran the session that wrote it —
 * the case a retry after a restart is.
 *
 * Every payer's debt, parked charges included: this is the owner's chain's question —
 * a loop step or a loop Retry is refused while its owner owes and cannot pay, and a parked charge
 * is owed as much as a failed one. A chain many wallets pay on asks `drainOwed` instead.
 */
export async function carriedCharges(agentId: Bytes32 | string): Promise<{ payers: string[]; microUsdc: bigint }> {
  const id = toBytes32(typeof agentId === "string" ? agentId.toLowerCase() : hex(agentId));
  const queue = anchorQueue();
  return chargesOwed([...(await queue.carried(id)), ...(await queue.parked(id))]);
}

/**
 * What a drain of this chain on behalf of `payer` would carry: everything still owed to the chain,
 * whoever pays it, and of the parked charges (the ones the billing program refused) only that
 * payer's own.
 *
 * A charge refused because its payer revoked, let expire, overran or underfunded their grant must
 * not fail, halt the chain and name that payer as the only wallet allowed to drain it — on the
 * console's own agents, which every caller shares, that would be one wallet locking everybody else
 * out, across restarts. So the queue parks such a charge (rule 4a of `runtime/src/anchor.ts`) and
 * lets the chain's records land; this keeps the debt in front of the one admission it belongs to.
 * The payer who owes it is still refused here until their allowance can pay — the owner's rule,
 * kept for their own debt — and when it can, their drain sends it: passing `payer` also scopes the queue's
 * next `retry` of this chain to that wallet's parked charges, and to nobody else's.
 *
 * `payer` is the wallet whose signature verified, or `null` for an unsigned caller, who resends no
 * parked charge at all. Omitted, the scope the last admission on this chain set is read, which is
 * what a later step of the same request asks.
 */
export async function drainOwed(
  agentId: Bytes32 | string,
  payer?: string | null
): Promise<{ payers: string[]; microUsdc: bigint }> {
  const key = typeof agentId === "string" ? agentId.toLowerCase() : hex(agentId);
  if (payer !== undefined) parkedScope.set(key, payer ? [payer] : []);
  const scope = parkedScope.get(key);
  const queue = anchorQueue();
  const id = toBytes32(key);
  const own = (await queue.parked(id)).filter((e) => !scope || scope.includes(e.user));
  return chargesOwed([...(await queue.carried(id)), ...own]);
}

/**
 * Who may drain a chain that owes somebody money, and with what status a refusal is answered.
 *
 * A retry authenticated by the target check alone, where the owner gate fires only for a
 * *deployed* agent, would let `POST /api/run {"action":"retry"}` on one of the console's own agents
 * drain with no wallet at all. With no wallet `chainBilling` returns `NoopBilling`, whose `charge`
 * returns `null`; a queue that read a `charge` entry's missing signature as sent would settle a
 * wallet's pending USDC debit to `verified` with no transaction: the operator had paid OpenRouter,
 * the console would say the record was anchored and billed, and the money never moved. Anonymous
 * *carried* drains are the same hole reached without an explicit retry, and a loop step or
 * settlement whose owner's allowance had lapsed is the same hole again (`loopDrainRefusal` in
 * `_lib/loop-budget.ts`). The queue itself refuses a charge that returns no signature
 * (`ChargeUnpaid`): the entry fails and stays owed. This gate is still the answer a caller gets,
 * because it says whose debt it is before anything is bound or sent.
 *
 * So money makes the drain owned. A chain that owes nothing is drained anonymously — a retry moves
 * no money and needs no wallet, and that is most of them. A chain that owes something is drained
 * only by a payer of what it owes, signed, and only through a backend that can actually charge;
 * `NoopBilling` is never a valid answer for an entry that carries a charge, which is the
 * invariant this function exists to state.
 *
 * `owed` is `drainOwed`'s answer on a chain many wallets pay on: a charge the billing program
 * refused is parked, not owed to the chain, so it reaches this gate only for the payer who owes it.
 * Another wallet, or an unsigned caller, is not refused over it.
 */
export function drainAdmission(p: {
  owed: { payers: string[]; microUsdc: bigint };
  /** The wallet whose signature verified for this request, base58, or null when unsigned. */
  user: string | null;
  /** Why a supplied signature was not accepted, when one was supplied. */
  authNote: string | null;
  /** What `chainBilling` found for `user` on this chain. */
  billingState: "charged" | "unfunded" | "no-wallet";
  /** Why the allowance did not admit, when `chainBilling` said which half was short. */
  shortfall?: string | null;
}): { ok: true; billed: boolean } | { status: number; refuse: string } {
  const { payers, microUsdc } = p.owed;
  if (payers.length === 0) return { ok: true, billed: false };
  const owes = `this chain has ${(Number(microUsdc) / 1e6).toFixed(6)} USDC of journaled charges owed by ${payers.join(
    ", "
  )}`;
  if (!p.user) {
    return {
      status: 401,
      refuse: `${owes}, so only that wallet may drain it: sign the request${p.authNote ? ` (${p.authNote})` : ""}`,
    };
  }
  if (!payers.includes(p.user)) {
    return { status: 403, refuse: `${owes}, and this is another wallet` };
  }
  if (p.billingState !== "charged") {
    // 402: the caller is who they say they are and owns the debt; what is missing is the money,
    // and the entries stay journaled until it is there. Draining them now would be laundering —
    // a charge marked verified that no transaction ever carried.
    return {
      status: 402,
      refuse:
        `${owes}, and this wallet's allowance can no longer pay it` +
        `${p.shortfall ? `: ${p.shortfall}` : ""}. The records stay journaled; top the allowance up and retry.`,
    };
  }
  return { ok: true, billed: true };
}

/**
 * What a chain still owes, for a `session:done` summary. `parked` counts the refused charges its
 * payers still owe (rule 4a): they hold no record back, so `pending: 0, failed: 0` is still a
 * fully anchored session, and the count is here so the debt is not invisible beside it.
 */
export async function anchorSummary(
  agentId: Bytes32
): Promise<{ pending: number; failed: number; parked: number; seq: string; head: string }> {
  const q = anchorQueue();
  const tip = await q.tip(agentId);
  return {
    pending: q.pending(agentId).length,
    failed: q.failed(agentId).length,
    parked: (await q.parked(agentId)).length,
    seq: tip.seq.toString(),
    head: hex(tip.head),
  };
}
