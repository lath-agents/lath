/**
 * The loop's Tempo access key (`_lib/loops.ts` re-exports it): the calls behind seams, the limit it is
 * authorized for, the channel rows it signed, and the revoke after a stop and the sweep of keys a
 * stopped or orphaned loop left. Opening a channel through it is `openThroughLoopKey` in
 * `loop-channel.ts`; creating one at a start is `withLoopKey` in `loop-request.ts`.
 *
 * Installs `_lib/tempo.ts`'s key-account hook and keyed-close listener at load.
 */
import * as fs from "fs";
import * as path from "path";
import { type LoopSnapshot, type TempoKeyPolicy, TEMPO_STORAGE_URL, type StoragePut } from "@lath/runtime";
import {
  type OpenChannelRow,
  base6,
  closeChannelById,
  openChannelLedger,
  readChannelLedger,
  setKeyAccountFor,
  setKeyedCloseListener,
  TEMPO_CHAIN_ID,
  TEMPO_USDC_E,
  tempoEnabled,
} from "./tempo";
import {
  authorizeLoopKey,
  createLoopKey,
  deleteLoopKeyFile,
  loopKeyAccount,
  loopKeyDir,
  loopKeyScopes,
  loopKeyScopesEnabled,
  loopKeysEnabled,
  reconcileLoopKeyLimit,
  revokeLoopKey,
  type LoopKeyChannelRow,
  type LoopTempoKey,
} from "./tempo-keys";
import { errorText, STEP_DEADLINE_MS } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { digits, jevBudgetOf } from "./loop-budget";
import { scheduler } from "./loop-state";
import { readLoop, readLoops, registryRow, updateLoop } from "./loop-registry";
import { loopChannelCaps, loopChannelSizing } from "./loop-channel-state";

// ─── The loop's Tempo access key ────────────────────────────────────────────
//
// A loop started with `LATH_TEMPO_LOOP_KEYS` on signs its owner-paid Tempo payments with its own
// access key, rooted on the treasury with a USDC.e limit sized from its budget, so Tempo itself
// refuses a deposit past that limit whatever the console does. The key is authorized at the end of the
// start, committed in every step's policy, reconciled before every open, and revoked once the loop has
// stopped and its channel has closed. `payment.payer` stays the treasury: an
// access-key account's `address` is the root's.
//
// Everything here keys off the row's `tempoKey`, not off the switch: the switch decides whether a
// *new* loop gets a key, and a loop that has one is held to it for its whole run even on a console
// restarted with the switch off — its Genesis committed `tempoKey`, and a treasury-signed channel
// under it would be a payment the policy says was never made, so there is no fallback to the
// treasury's key. A loop without one runs every path below on the treasury's key, untouched by any
// of this.
//
// The authorize, the reconcile and the revoke are root transactions that each take `withTreasury`
// themselves, so none of them is ever called from inside a `withTreasury` body — the queue would
// wait on itself. That is why the limit retry sits outside the transport's `chat` (whose first call
// opens the channel inside `withTreasury`) and catches the refusal only once that turn is let go,
// and why the revoke runs after the settle has returned rather than from inside the close.

/**
 * The `_lib/tempo-keys.ts` calls the loop modules make, behind one object so a suite can stand
 * fakes in: their real bodies send treasury transactions, and nothing under `tests/` may.
 */
export interface LoopKeySeams {
  /** Whether a new loop gets a key: the switch, on a console with a treasury to root it on. */
  enabled: () => boolean;
  create: typeof createLoopKey;
  authorize: typeof authorizeLoopKey;
  account: typeof loopKeyAccount;
  reconcile: typeof reconcileLoopKeyLimit;
  revoke: typeof revokeLoopKey;
  deleteFile: typeof deleteLoopKeyFile;
  /** Whether a new key is scoped to its own calls: `LATH_TEMPO_KEY_SCOPES`. */
  scopesEnabled: () => boolean;
  /** The storage gateway's payee, read from a free 402. The one network read a start makes for its scopes. */
  storagePayee: () => Promise<`0x${string}`>;
  /** The scopes for that payee. */
  scopes: typeof loopKeyScopes;
}

const DEFAULT_LOOP_KEY_SEAMS: LoopKeySeams = {
  // A console with no treasury bills nothing and has no root to authorize a key on, so a start there
  // gets no key rather than a refusal for a payment path it will never use.
  enabled: () => loopKeysEnabled() && tempoEnabled(),
  create: createLoopKey,
  authorize: authorizeLoopKey,
  account: loopKeyAccount,
  reconcile: reconcileLoopKeyLimit,
  revoke: revokeLoopKey,
  deleteFile: deleteLoopKeyFile,
  scopesEnabled: loopKeyScopesEnabled,
  storagePayee: () => readStoragePayee(),
  scopes: loopKeyScopes,
};

/**
 * The object the storage payee is read from: one flat key segment (a `/` gets an unpaid plain 404
 * before any challenge), and a name no loop's `storageKey` can take.
 */
const STORAGE_PAYEE_KEY = "lath-payee-check";

/**
 * The address Tempo's storage gateway is paid at: the `recipient` of the USDC.e `tempo`/`charge`
 * challenge an unpaid, empty PUT is answered with. A PUT rather than a GET because it is the call a
 * step's report pays for, so its challenge is the one the key's `transferWithMemo` scope must
 * admit; the GET's challenge names the same address.
 *
 * Nothing is paid and nothing is written: a bare `fetch` carries no credential, so the gateway stops
 * at the 402 (the charge transport is the only path that answers one, and it is not used here). The
 * gateway offers the same price in three tokens, one of them to another address, so only the USDC.e
 * challenge on Tempo's chain is read — the one `treasuryChargeTransport` would pay — and more than
 * one payee among those is refused rather than guessed between: a scope naming the wrong one fails
 * every storage charge of the loop with `CallNotAllowed`.
 */
export async function readStoragePayee(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<`0x${string}`> {
  const url = `${TEMPO_STORAGE_URL.replace(/\/+$/, "")}/${STORAGE_PAYEE_KEY}`;
  const res = await fetchImpl(url, { method: "PUT", body: "", signal: AbortSignal.timeout(15_000) });
  // The headers are all that is read; the problem body is let go so the socket is.
  void res.body?.cancel().catch(() => undefined);
  if (res.status !== 402) throw new Error(`${url} answered ${res.status}, not a 402 naming its price`);
  const { Challenge } = await dynamicImport("mppx");
  const challenges: any[] = Challenge.fromResponseList(res);
  const payees = new Set<string>();
  for (const c of challenges) {
    const req = c?.request ?? {};
    const details = req.methodDetails ?? {};
    const chain = details.chainId ?? req.chainId;
    if (c?.method !== "tempo" || c?.intent !== "charge") continue;
    if (String(req.currency ?? "").toLowerCase() !== TEMPO_USDC_E.toLowerCase()) continue;
    if (chain !== undefined && chain !== TEMPO_CHAIN_ID) continue;
    // A gateway that splits its price or names its own memo would have every charge of this loop
    // refused (`MppChargeTransport.priced`, with a `clientId`): splits pay recipients the key's
    // scope does not admit, and a memo replaces the attribution that names the loop. The start is
    // refused now, with the reason, rather than authorize a key no storage call could use.
    const splits = details.splits;
    if (splits !== undefined && splits !== null && (!Array.isArray(splits) || splits.length > 0)) {
      throw new Error(`${url} splits its USDC.e price to further recipients, which a scoped loop key cannot pay`);
    }
    if (details.memo !== undefined && details.memo !== null && details.memo !== "") {
      throw new Error(`${url} names a memo of its own, which would replace the loop's attribution memo`);
    }
    if (typeof req.recipient === "string") payees.add(req.recipient.toLowerCase());
  }
  if (payees.size !== 1) {
    throw new Error(
      payees.size === 0
        ? `${url} offered no USDC.e tempo/charge challenge on chain ${TEMPO_CHAIN_ID}`
        : `${url} named ${payees.size} USDC.e payees (${[...payees].join(", ")}), and a key can be scoped to one`
    );
  }
  const [payee] = payees;
  if (!/^0x[0-9a-f]{40}$/.test(payee)) throw new Error(`${url} named ${payee} as its payee, which is not an address`);
  return payee as `0x${string}`;
}

// A bare `import()` the bundler leaves alone, as `_lib/tempo.ts` loads mppx: it is ESM-only.
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

export let loopKeySeams: LoopKeySeams = DEFAULT_LOOP_KEY_SEAMS;

/** Replaces some of the key calls for a suite; `undefined` puts the real ones back. */
export function setLoopKeySeamsForTests(seams: Partial<LoopKeySeams> | undefined): void {
  loopKeySeams = seams ? { ...DEFAULT_LOOP_KEY_SEAMS, ...seams } : DEFAULT_LOOP_KEY_SEAMS;
}

// The close hook `_lib/tempo.ts` signs a keyed ledger row's close through (`keyAccountFor`):
// installed once per module evaluation, which is idempotent — every copy answers from the same file.
// Only a row with a `signer` reaches it, and only a loop with a key writes one, so with the switch off
// it is never called. Through `loopKeySeams` at call time, so a suite's fake answers it too.
setKeyAccountFor(async (row) => {
  if (!row.loopId) return null;
  // The key the loop committed, or the one the row says signed: a file holding any other is refused.
  const expected = readLoop(row.loopId)?.tempoKey?.address ?? row.signer;
  return loopKeySeams.account(row.loopId, expected);
});

// And the listener a close by id tells of a keyed channel it settled: the restart's recovery pass
// closes a row its loop could not settle, outside the loop's own settle, and the refund that close
// made goes back to the key only once it is written here. A close that reports no deposit and no
// amount is left out, and the channel counts its whole last-known deposit (`loopKeyRows`).
setKeyedCloseListener(({ loopId, channelId, deposit, spent, signed }) => {
  if (digits(deposit)) rememberKeyChannelClosed(loopId, channelId, deposit, spent, signed);
});

/** A key is authorized for thirty days. A loop still running then stops (`tempo-key-expired`). */
export const LOOP_KEY_LIFETIME_S = 30 * 24 * 60 * 60;

/**
 * Whether the owner's storage charges are signed with the loop's key, and so under its limit, or
 * stay treasury-signed. Should the storage service refuse a key-signed transfer, or the transfer
 * not count against the limit, flip it to `false` and the charges go back to the treasury's key, no
 * charge row enters a reconcile, and the screen says the cap covers the model channel.
 */
export const STORAGE_CHARGES_UNDER_KEY = true;

/**
 * How long before its key expires a loop stops, at a step boundary. The key must outlive the
 * channel's close, or the close has to be done by hand: so it covers the step about to run (up to
 * three step deadlines, the point `withRunSlot` calls a holder wedged), the longest a quiet channel
 * is held before its idle settle (an hour, `channelIdleMs`'s cap), and the longest a stopped run's
 * settle waits for the run slot (`SETTLE_SLOT_WAIT_MS`, three more deadlines). Two hours at the
 * default deadline: nothing against a thirty-day key.
 */
export const LOOP_KEY_EXPIRY_MARGIN_MS = 6 * STEP_DEADLINE_MS + 60 * 60_000;

/**
 * The key's limit for a run on these terms, raw USDC.e base units: exactly the `maxDeposit`
 * `loopChannelSizing` gives a fresh run's channel — the owner's whole budget plus Lath's Jev share
 * frozen at the rate `planLoopStart` freezes — so the cap and the channel's own ceiling cannot drift
 * apart. Over the declared budget, not a funded one: every later open is sized from what is funded
 * (`defaultOpenChannel`), which is never more than this.
 */
export function loopKeyLimitBase(terms: {
  maxSteps: number;
  budgetMicroUsdc: bigint | string;
  budgetMicroUsdcPerStep: bigint | string;
}): string {
  const budget = BigInt(terms.budgetMicroUsdc);
  return loopChannelSizing({
    maxSteps: terms.maxSteps,
    budgetMicroUsdc: budget.toString(),
    budgetMicroUsdcPerStep: BigInt(terms.budgetMicroUsdcPerStep).toString(),
    jevBudgetBase: jevBudgetOf(budget).toString(),
    jevSpentBase: "0",
    snapshot: {
      loopId: "",
      steps: 0,
      status: "idle",
      totalCostMicroUsdc: "0",
      spentMicroUsdc: "0",
      consecutiveFailures: 0,
    } as LoopSnapshot,
  }).maxDepositBase.toString();
}

/**
 * A key authorized for a start that `planLoopStart` then refused — the one window between the two,
 * which only a race can reach (another start on the agent landing in between). Revoked like any key
 * with no loop row (`revokeOrphanKey`): fired rather than awaited because `planPreparedStart` is
 * synchronous, and tried again on a backoff while Tempo refuses it.
 */
export function abandonLoopKey(key: LoopTempoKey): void {
  void revokeOrphanKey(key.loopId, key.address);
}

/**
 * The key as a step's policy commits it: addresses lower-case, absent without an authorize hash. Its
 * call scopes are passed as the row holds them, and `policyDocument` puts them in the one order and
 * case it hashes; absent on an unscoped key, whose policy is therefore the same bytes an older keyed
 * loop without scopes committed.
 */
export function tempoKeyPolicyOf(key: LoopTempoKey | undefined): TempoKeyPolicy | undefined {
  if (!key?.authorizeTx) return undefined;
  return {
    address: key.address.toLowerCase(),
    token: key.token.toLowerCase(),
    limitBase: key.limitBase,
    expiry: key.expiry,
    authorizeTx: key.authorizeTx.toLowerCase(),
    ...(key.scopes ? { scopes: key.scopes } : {}),
  };
}

/**
 * Every channel and charge the loop's key has signed, as the reconcile reads them, so the target
 * it sends is never above what the console can show:
 *
 * - the finished ones the row keeps (`tempoKeyClosed`): each closed channel with what its close paid,
 *   and each storage charge — the only rows whose refund goes back to the key;
 * - each channel still open — the ledger's rows for this loop, and the channel the row or this process
 *   names — with what it has deposited, or its ceiling or cumulative when the ledger does not say;
 * - each channel the key is known to have opened (`tempoKeyChannels`) that is neither of those: closed
 *   by some path that never reported its settle (a hand force-close, a close whose report was lost),
 *   so it counts its **whole** last-known deposit, as a closed row with no settled amount. A loop is
 *   starved by a settle nobody recorded, never handed a refund nobody saw.
 *
 * An open channel takes the larger of the ledger's deposit and the one last noted, for the same reason.
 */
export function loopKeyRows(
  loop: Pick<LoopRecord, "id" | "channel" | "tempoKeyClosed" | "tempoKeyChannels">
): LoopKeyChannelRow[] {
  const closed = loop.tempoKeyClosed ?? [];
  const finished = new Set(closed.map((r) => r.channelId));
  const ledger = openChannelLedger();
  const noted = new Map((loop.tempoKeyChannels ?? []).map((c) => [c.channelId, c.deposit]));
  const open = new Map<string, LoopKeyChannelRow>();
  const add = (channelId: string | undefined) => {
    if (!channelId || finished.has(channelId) || open.has(channelId)) return;
    const deposit = largerDeposit(openDepositOf(loop, channelId, ledger), noted.get(channelId));
    open.set(channelId, { channelId, deposit, closed: false });
  };
  for (const row of ledger) if (row.loopId === loop.id) add(row.channelId);
  add(loop.channel?.channelId);
  add(scheduler().channels.get(loop.id)?.channel.channelId);
  const unaccounted: LoopKeyChannelRow[] = [];
  for (const [channelId, deposit] of noted) {
    if (finished.has(channelId) || open.has(channelId)) continue;
    // No `settled`: `loopKeyLimitTarget` counts a closed row without one at its whole deposit.
    unaccounted.push({ channelId, deposit, closed: true });
  }
  return [...closed, ...open.values(), ...unaccounted];
}

/** The larger of two base-unit amounts, either of which may be missing or malformed. */
export function largerDeposit(a: string | undefined, b: string | undefined): string {
  const x = digits(a) ? BigInt(a) : 0n;
  const y = digits(b) ? BigInt(b) : 0n;
  return (x > y ? x : y).toString();
}

/**
 * Notes on a keyed loop's row every channel its key has open now, with the deposit last seen
 * (`tempoKeyChannels`): the ledger's rows for the loop, the channel its row names, the one this
 * process holds, and `extra` — a ledger row a restart hands in. Called wherever a channel of the
 * loop can be seen before something else might close it: after each step (`rememberLoopChannel`),
 * at the head of every settle (before it can be turned away for the slot, which is when the
 * restart's recovery closes the row by id instead), and before every reconcile. Deposits only grow
 * — a top-up raises one, nothing lowers it — so a stale read never shrinks what the key is charged
 * with. Writes nothing for a loop without a key, or when nothing changed.
 */
export function noteKeyChannels(id: string, extra?: { channelId: string }): void {
  const loop = readLoop(id);
  if (!loop?.tempoKey) return;
  const ledger = openChannelLedger();
  const seen = new Map<string, string>();
  const see = (channelId: string | undefined) => {
    if (channelId && !seen.has(channelId)) seen.set(channelId, openDepositOf(loop, channelId, ledger));
  };
  for (const row of ledger) if (row.loopId === id) see(row.channelId);
  see(loop.channel?.channelId);
  see(scheduler().channels.get(id)?.channel.channelId);
  see(extra?.channelId);
  if (seen.size === 0) return;
  try {
    updateLoop(id, (l) => {
      const kept = [...(l.tempoKeyChannels ?? [])];
      let changed = false;
      for (const [channelId, deposit] of seen) {
        const at = kept.findIndex((c) => c.channelId === channelId);
        if (at < 0) {
          kept.push({ channelId, deposit });
          changed = true;
        } else if (largerDeposit(kept[at].deposit, deposit) !== kept[at].deposit) {
          kept[at] = { channelId, deposit: largerDeposit(kept[at].deposit, deposit) };
          changed = true;
        }
      }
      return changed ? { ...l, tempoKeyChannels: kept } : l;
    });
  } catch (e) {
    console.warn(`[loops] ${id}: the key's channels were not noted: ${errorText(e)}`);
  }
}

/** What an open channel of this loop has deposited, base units, by the rule `loopKeyRows` states. */
export function openDepositOf(
  loop: Pick<LoopRecord, "id" | "channel">,
  channelId: string,
  ledger: OpenChannelRow[] = openChannelLedger()
): string {
  const recorded = ledger.find((r) => r.channelId === channelId)?.recovery?.deposit;
  if (digits(recorded)) return recorded;
  const held = scheduler().channels.get(loop.id);
  const cap = loopChannelCaps().get(loop.id);
  if (held?.channel.channelId === channelId && cap !== undefined) return cap.toString();
  if (loop.channel?.channelId === channelId && digits(loop.channel.cumulative)) return loop.channel.cumulative;
  return "0";
}

/**
 * How many reconciles in a row may fail to read the key before the loop stops `tempo-key-refused`:
 * three steps opened nothing and ran unbilled, which is long enough for a dropped RPC call to come
 * back and short enough that a dead one does not leave the loop stepping for nothing.
 */
export const KEY_READ_FAILURES_BEFORE_STOP = 3;

/**
 * A reconcile that could not read the key before sending anything (`LoopKeyReadFailedError`): not a
 * refusal and not a stop. The open it came before answers a degrade with this sentence, so the step
 * runs unbilled and the next one tries again.
 */
export class LoopKeyDeferred extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "LoopKeyDeferred";
  }
}

/** Whether an error is Tempo refusing a deposit or top-up past the key's limit (the probe's text). */
export function isSpendingLimitExceeded(e: unknown): boolean {
  let at: any = e;
  for (let depth = 0; at && depth < 6; depth++, at = at.cause) {
    if (/SpendingLimitExceeded/.test(String(at?.message ?? "")) || /SpendingLimitExceeded/.test(String(at))) {
      return true;
    }
  }
  return false;
}

/** The sentence a loop stopped `tempo-key-limit` shows, with the limit the last reconcile set when known. */
export function keyLimitDetail(reconciled: { target: string } | undefined, vouchered: boolean): string {
  return (
    "Tempo refused this loop's deposit past its access key's limit (SpendingLimitExceeded)" +
    (reconciled && digits(reconciled.target)
      ? `, with the limit reconciled to ${base6(BigInt(reconciled.target))} USDC.e left`
      : "") +
    (vouchered ? ", on a call that had already signed a voucher, which is recorded and charged as paid" : "") +
    ": the loop's budget plus its decision share is spent on Tempo, so it stopped"
  );
}

/**
 * The close a loop's channel gets when this process holds no session for it: `closeChannelById`,
 * told the loop on a keyed loop so a channel the ledger has no row for still finds its key through
 * the close hook (`opts.loopId`). A loop without a key passes no options.
 */
export function loopCloseById(
  loop: Pick<LoopRecord, "id" | "tempoKey">
): (channelId: string, payer: string) => Promise<{ txHash?: string; spent?: string }> {
  if (!loop.tempoKey) return closeChannelById;
  return (channelId, payer) => closeChannelById(channelId, payer, { loopId: loop.id });
}

/**
 * Why a running loop's key cannot carry another step, or `null`: it expires inside
 * `LOOP_KEY_EXPIRY_MARGIN_MS`. Asked at every step boundary — each tick, and each step however it was
 * started — so the loop settles while the key can still sign the close.
 */
export function loopKeyExpiryDetail(loop: Pick<LoopRecord, "tempoKey">, now: number = Date.now()): string | null {
  const key = loop.tempoKey;
  if (!key) return null;
  if (key.expiry * 1000 - now >= LOOP_KEY_EXPIRY_MARGIN_MS) return null;
  return (
    `this loop's Tempo access key ${key.address} expires at ${new Date(key.expiry * 1000).toISOString()}, ` +
    "before another step and its channel's close could finish, so the loop settled and stopped; " +
    "start it again for a new key"
  );
}

/** Writes a finished row of the key's onto the loop, replacing one with the same id. */
function rememberKeyRow(id: string, row: LoopKeyChannelRow): void {
  try {
    updateLoop(id, (l) =>
      l.tempoKey
        ? { ...l, tempoKeyClosed: [...(l.tempoKeyClosed ?? []).filter((r) => r.channelId !== row.channelId), row] }
        : l
    );
  } catch (e) {
    // The next reconcile then counts this channel as open with its deposit, if the ledger still has
    // it, or not at all: logged, because the second case hands its spend back to the key.
    console.error(`[loops] ${id}: the key's record of ${row.channelId} was not written: ${errorText(e)}`);
  }
}

/**
 * A channel of the key's that a settle closed: its deposit (read before the close, which takes the
 * ledger row away) and what it settled. Settled is never less than what was **signed** — the close
 * voucher's cumulative, `signed` — whatever the gateway's receipt says it spent: the payee can redeem
 * every voucher the key signed, so a receipt below it would hand back limit the key may yet owe. With
 * neither figure known the whole deposit counts as settled, more spent than less (`loopKeyRows`).
 * Never above the deposit, which is all the channel could pay.
 */
export function rememberKeyChannelClosed(
  id: string,
  channelId: string,
  deposit: string,
  spent: string | undefined,
  signed: string | undefined
): void {
  rememberKeyRow(id, { channelId, deposit, settled: keySettledOf(deposit, spent, signed), closed: true });
}

/** `rememberKeyChannelClosed`'s settled amount: the larger of the receipt and the signed cumulative, capped at the deposit. */
export function keySettledOf(deposit: string, spent: string | undefined, signed: string | undefined): string {
  if (!digits(spent) && !digits(signed)) return deposit;
  const settled = BigInt(largerDeposit(spent, signed));
  return digits(deposit) && BigInt(deposit) > 0n && settled > BigInt(deposit) ? deposit : settled.toString();
}

/** The cumulative the key has signed on a channel: the held transport's, the ledger's, or the row's, whichever is largest. */
export function signedCumulativeOf(loop: Pick<LoopRecord, "id" | "channel">, channelId: string): string | undefined {
  const held = scheduler().channels.get(loop.id)?.channel;
  const candidates = [
    held?.channelId === channelId ? held.cumulative : undefined,
    openChannelLedger().find((r) => r.channelId === channelId)?.recovery?.cumulative,
    loop.channel?.channelId === channelId ? loop.channel.cumulative : undefined,
  ].filter((v): v is string => digits(v));
  return candidates.length ? candidates.reduce((a, b) => largerDeposit(a, b)) : undefined;
}

/**
 * A storage charge the key signed: a closed row whose deposit and settled are the charge, never
 * restored. Every charge is a row of its own: `payment` is present exactly when a credential was
 * signed, receipted or not, and its `reference` is `""` for every `PaidChargeFailed` and every
 * answer whose receipt did not parse — so the row is keyed by the step and the object, and numbered
 * within them, never by the reference alone, which would collapse N such charges into one and hand
 * back N − 1.
 */
export function rememberKeyCharge(id: string, put: Pick<StoragePut, "ofStep" | "key" | "receipt">): void {
  const amount = put.receipt.payment?.amount;
  if (!digits(amount) || amount === "0") return;
  try {
    updateLoop(id, (l) => {
      if (!l.tempoKey) return l;
      const kept = l.tempoKeyClosed ?? [];
      const prefix = `charge:${put.ofStep}:${put.key}:`;
      const n = kept.filter((r) => r.channelId.startsWith(prefix)).length;
      const row: LoopKeyChannelRow = { channelId: `${prefix}${n}`, deposit: amount, settled: amount, closed: true };
      return { ...l, tempoKeyClosed: [...kept, row] };
    });
  } catch (e) {
    console.error(`[loops] ${id}: the key's record of a ${amount} storage charge was not written: ${errorText(e)}`);
  }
}

/**
 * Whether a stopped loop may still need its key: a run stopped `anchor-failed` that a Retry can put
 * back on its schedule (`retryUnderSlot`'s `resumable`), until a Discard turns it `anchor-discarded`,
 * an archive ends it, or a Retry leaves it stopped for another reason. Revoking such a key would let
 * the Retry resume a loop that can open nothing. Running and paused loops keep theirs as well.
 */
function keyStillNeeded(loop: LoopRecord): boolean {
  if (loop.status !== "stopped") return true;
  return loop.stopReason === "anchor-failed" && !loop.archivedAt && loop.snapshot.steps < loop.maxSteps;
}

/** Whether a loop's key has been revoked, or can only be by hand. */
export function keyDone(loop: Pick<LoopRecord, "tempoKeyRevoke">): boolean {
  return !!(loop.tempoKeyRevoke?.txHash || loop.tempoKeyRevoke?.byHand);
}

/**
 * How long after each failed revoke the next is tried: a minute, five, fifteen, then hourly. On a
 * timer rather than once per process, so a key Tempo refused to revoke at the stop is revoked when it
 * comes back, not at the next restart.
 */
const REVOKE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

let revokeBackoffMs: readonly number[] = REVOKE_BACKOFF_MS;

/** Shortens the revoke backoff for a suite; `undefined` puts the real one back. */
export function setRevokeBackoffForTests(ms: readonly number[] | undefined): void {
  revokeBackoffMs = ms && ms.length ? ms : REVOKE_BACKOFF_MS;
}

function retryRevokeLater(key: string, again: () => Promise<boolean>): void {
  const s = scheduler();
  const prior = s.revokeRetries.get(key);
  if (prior?.timer) clearTimeout(prior.timer);
  const attempt = (prior?.attempt ?? 0) + 1;
  const timer = setTimeout(async () => {
    // `again` is a revoke or a sweep, each documented never to throw; a throw anyway is caught and
    // re-armed rather than left as an unhandled rejection that also drops the retry for good.
    let done: boolean;
    try {
      done = await again();
    } catch (e) {
      console.warn(`[loops] the retry of ${key} threw, tried again later: ${errorText(e)}`);
      if (s.revokeRetries.get(key)?.timer === timer) retryRevokeLater(key, again);
      return;
    }
    if (done && s.revokeRetries.get(key)?.timer === timer) s.revokeRetries.delete(key);
  }, revokeBackoffMs[Math.min(attempt, revokeBackoffMs.length) - 1]);
  timer.unref?.();
  s.revokeRetries.set(key, { attempt, timer });
}

function revokeRetired(key: string): void {
  const s = scheduler();
  const prior = s.revokeRetries.get(key);
  if (prior?.timer) clearTimeout(prior.timer);
  s.revokeRetries.delete(key);
}

/**
 * Revokes a stopped loop's key once nothing it signed is still open (close first, then revoke) and
 * no Retry can resume the run (`keyStillNeeded`). Asked after every settle of the loop, after a
 * Retry, a Discard and an archive, at the console's first scheduler pass, and on a backoff after a
 * failure. Never throwing, and never holding the stop up: a failure is kept on the row
 * (`tempoKeyRevoke.error`) and tried again later. `revokedAt` is written only beside the
 * transaction that revoked it; a key whose file is gone is recorded as one to revoke by hand, with
 * its address. Answers whether there is nothing left to try.
 */
export async function revokeAfterStop(id: string): Promise<boolean> {
  let loop: LoopRecord | null;
  try {
    loop = readLoop(id);
  } catch (e) {
    // A registry that cannot be read says nothing about the key: something left to try, on the
    // backoff, rather than a throw out of a function every caller fires and forgets.
    console.warn(`[loops] ${id}: the registry could not be read to revoke its key, tried again later: ${errorText(e)}`);
    retryRevokeLater(id, () => revokeAfterStop(id));
    return false;
  }
  if (!loop?.tempoKey || keyDone(loop)) return true;
  if (keyStillNeeded(loop)) return true;
  const s = scheduler();
  if (s.revoking.has(id)) return false;
  // A channel still open, or a last settle whose close failed, may yet need the key's cooperative close.
  if (loop.channel || s.channels.has(id) || loop.snapshot.tempo?.closed === false) return false;
  // Read strictly: a ledger this read could not open may still hold the loop's row, and the
  // forgiving reader's `[]` would revoke the one key that row's cooperative close is signed with.
  // Unreadable is something left to try, as an open channel is: the next settle, Retry or boot pass
  // asks again.
  let ledger: OpenChannelRow[];
  try {
    ledger = readChannelLedger();
  } catch {
    return false;
  }
  if (ledger.some((r) => r.loopId === id)) return false;
  const address = loop.tempoKey.address;
  s.revoking.add(id);
  try {
    const txHash = await loopKeySeams.revoke(id);
    // The revoke has landed (or there was no file to revoke with) whatever happens to the row below:
    // a row write that throws is said in the log with the transaction, and is not a reason to revoke
    // again, which the catch further down would have scheduled.
    const record: NonNullable<LoopRecord["tempoKeyRevoke"]> = txHash
      ? { revokedAt: Date.now(), txHash }
      : {
          byHand: true,
          error: `the key file is gone, so ${address} must be revoked from the treasury by hand`,
          triedAt: Date.now(),
        };
    if (txHash) console.log(`[loops] ${id}: revoked its access key ${address} (${txHash})`);
    else console.error(`[loops] ${id}: ${record.error}`);
    try {
      updateLoop(id, (l) => ({ ...l, tempoKeyRevoke: record }));
    } catch (e) {
      console.error(
        `[loops] ${id}: the revoke of ${address} is not on the row (${errorText(e)}); record: ${JSON.stringify(record)}`
      );
    }
    revokeRetired(id);
    return true;
  } catch (e) {
    const error = errorText(e);
    console.warn(`[loops] ${id}: the access key ${address} was not revoked, tried again later: ${error}`);
    try {
      updateLoop(id, (l) => ({ ...l, tempoKeyRevoke: { error, triedAt: Date.now() } }));
    } catch {
      /* logged above */
    }
    retryRevokeLater(id, () => revokeAfterStop(id));
    return false;
  } finally {
    s.revoking.delete(id);
  }
}

/**
 * Revokes a key that has no loop row: one authorized for a start whose plan was then refused, or one
 * the console start's sweep finds (`sweepLoopKeys`). The address is logged on every action, since a
 * revoke that never lands leaves only a hand revoke from the treasury. Tried again on the backoff.
 */
async function revokeOrphanKey(loopId: string, address: string): Promise<boolean> {
  try {
    const txHash = await loopKeySeams.revoke(loopId);
    console.log(
      txHash
        ? `[loops] revoked the access key ${address} of ${loopId}, which has no loop (${txHash})`
        : `[loops] the access key ${address} of ${loopId} has no file left; if it is live, revoke it from the treasury by hand`
    );
    revokeRetired(`orphan:${loopId}`);
    return true;
  } catch (e) {
    console.error(
      `[loops] the access key ${address} of ${loopId}, which has no loop, was not revoked, tried again later: ${errorText(
        e
      )}`
    );
    retryRevokeLater(`orphan:${loopId}`, () => revokeOrphanKey(loopId, address));
    return false;
  }
}

/** How old a key file with no loop row must be before the sweep revokes it: a start in flight has one. */
const ORPHAN_KEY_AGE_MS = 15 * 60_000;

/**
 * The console start's sweep of `loopKeyDir()` (auditor 3 #2): every key file whose loop has no row —
 * older than `ORPHAN_KEY_AGE_MS`, so a start between its authorize and its record is left alone — and
 * every stopped loop whose key is no longer needed and was never revoked, revoked (never inside
 * `withTreasury`: each revoke takes it itself). `orphans: false` sweeps only keys with a row, which is
 * what the first scheduler pass does: rows are this console's own, whereas a key directory shared with
 * another trace directory (a suite on the same machine) holds keys this console has no rows for.
 */
export async function sweepLoopKeys(opts: { orphans?: boolean; now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  // Never rejects: it is fired with `void`. A registry it cannot read revokes nothing — least of all
  // the "orphans", which are only orphans next to rows this read did not get.
  let loops: Record<string, LoopRecord>;
  try {
    loops = readLoops();
  } catch (e) {
    console.warn(`[loops] the access key pass could not read the registry: ${errorText(e)}`);
    return;
  }
  for (const loop of Object.values(loops)) {
    if (loop.tempoKey && !keyDone(loop) && !keyStillNeeded(loop)) await revokeAfterStop(loop.id);
  }
  if (!opts.orphans) return;
  let names: string[] = [];
  try {
    names = fs.readdirSync(loopKeyDir());
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^(loop-[0-9a-f]{16})\.json$/.exec(name);
    if (!m || registryRow(loops, m[1])) continue;
    const file = path.join(loopKeyDir(), name);
    let address = "an unreadable key";
    try {
      if (now - fs.statSync(file).mtimeMs < ORPHAN_KEY_AGE_MS) continue;
      // The address only: the file's private key is never read here, and never logged.
      address = String(JSON.parse(fs.readFileSync(file, "utf8"))?.address ?? address);
    } catch {
      /* revoked below by id; the revoke reads the file itself */
    }
    console.warn(`[loops] the access key ${address} of ${m[1]} has no loop row; revoking it`);
    await revokeOrphanKey(m[1], address);
  }
}
