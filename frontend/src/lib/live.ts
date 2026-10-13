"use client";

import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { hex } from "@lath/sdk/browser";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBilling } from "./clients";
import { keys, useOwnerState } from "./queries";

/**
 * Live updates.
 *
 * Two kinds of account, two mechanisms. `UserBalance` is a regular Solana account, so the
 * validator will push every change over the websocket and there is nothing to poll. An
 * `AgentState` header is a ZK-compressed account: it lives in a Merkle tree, its data comes from
 * Photon, and no subscription exists for it — the only way to notice that someone else's session
 * advanced the chain is to ask again.
 *
 * So the header is polled, and the poll is kept as cheap and as quiet as it can be:
 *
 * - one `getCompressedAccount` per tick, never a scan (the events list is a Photon scan and is
 *   refetched only when the header proves it moved);
 * - nothing at all while the tab is hidden;
 * - `seq`/`head` are compared before anything is invalidated, so a page that is idle costs one
 *   point read every few seconds and no more.
 */

/**
 * The header poll while the tab is in front. Sessions write an event every few seconds, so 5s is
 * about one tick per step: fast enough that a running session visibly moves the page, slow enough
 * that an idle page open all afternoon is 12 point reads a minute rather than a Photon bill.
 */
export const HEADER_POLL_MS = 5_000;

/** How long "updated" stays on screen after the header moved. Long enough to notice, short
 *  enough that it is gone before the next step lands. */
export const FLASH_MS = 4_000;

/** The clock for "checked Ns ago". One second, because that is the unit it is displayed in. */
const TICK_MS = 1_000;

/* -------------------------------------------------------------------------- */
/* Tab visibility                                                              */
/* -------------------------------------------------------------------------- */

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function readVisible(): boolean {
  return document.visibilityState === "visible";
}

/** The server renders no tab at all; it is treated as visible so the markup matches the common
 *  case and the first client render does not have to change it. */
function serverVisible(): boolean {
  return true;
}

export function useTabVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, readVisible, serverVisible);
}

/* -------------------------------------------------------------------------- */
/* Watch status, shared with whatever wants to display it                      */
/* -------------------------------------------------------------------------- */

export interface WatchStatus {
  /** The tab is hidden, so the header is not being read. */
  paused: boolean;
  /** When the header last came back successfully. 0 before the first one. */
  checkedAt: number;
  /** When `seq`/`head` last changed under us. 0 if it has not, this mount. */
  changedAt: number;
}

const statuses = new Map<string, WatchStatus>();
const statusListeners = new Set<() => void>();

function statusKey(id: string): string {
  return `agent:${id}`;
}

function announce() {
  for (const listener of statusListeners) listener();
}

function patchStatus(key: string, patch: Partial<WatchStatus>) {
  const current = statuses.get(key) ?? { paused: false, checkedAt: 0, changedAt: 0 };
  const next = { ...current, ...patch };
  if (current.paused === next.paused && current.checkedAt === next.checkedAt && current.changedAt === next.changedAt) {
    return;
  }
  statuses.set(key, next);
  announce();
}

function dropStatus(key: string) {
  if (statuses.delete(key)) announce();
}

function subscribeStatus(onChange: () => void): () => void {
  statusListeners.add(onChange);
  return () => void statusListeners.delete(onChange);
}

/* -------------------------------------------------------------------------- */
/* The owner watch                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything on an owner page that a new event invalidates.
 *
 * Deliberately *not* `ownerState`: the watcher's own poll is that query, so by the time this
 * runs it already holds the header we are reacting to, and invalidating it would spend a second
 * read on data we have. Everything else here is derived from the chain and is now stale by
 * definition.
 */
export function invalidateOwner(queryClient: QueryClient, id: string) {
  for (const key of [keys.events(id), keys.epochs(id), keys.chain(id)]) {
    queryClient.invalidateQueries({ queryKey: key });
  }
}

/**
 * Follow one owner's header and pull the rest of its page along behind it.
 *
 * Call it once near the top of an owner page. It shares the page's own `ownerState` query rather
 * than opening a second one, so the header the card renders and the header this compares are the
 * same value, fetched once.
 *
 * The first header it sees is the baseline, not a change: a page that has just loaded has already
 * fetched everything, and invalidating on arrival would refetch the lot for nothing.
 */
export function useOwnerWatch(id: string) {
  const queryClient = useQueryClient();
  const visible = useTabVisible();
  const key = statusKey(id);

  // A header that reads back as `null` for an id never seen with one is an owner that does not
  // exist — the page is showing "not found" and there is nothing to follow, so stop asking. For an
  // id this watch has seen a header for, a null is the indexer between a write's nullify and its
  // append, not an owner that went away: the page keeps the last header on screen, and the poll
  // keeps going so the next tick brings the new one. Stopping there froze the page on the old
  // header for good, since nothing else asks again.
  const [missing, setMissing] = useState(false);
  const query = useOwnerState(id, true, visible && !missing ? HEADER_POLL_MS : false);

  const state = query.data?.state;
  const stamp = state ? `${state.seq}:${hex(state.head)}` : null;
  const { isSuccess, data, dataUpdatedAt } = query;

  // The header moved. Compare before invalidating: most ticks return the same account.
  const seen = useRef<{ key: string; stamp: string } | null>(null);

  useEffect(() => {
    // A read that answered null carries no stamp, so `seen` here is what earlier reads left.
    setMissing(isSuccess && data === null && seen.current?.key !== key);
  }, [isSuccess, data, key]);

  useEffect(() => {
    if (!stamp) return;
    if (seen.current?.key !== key) {
      seen.current = { key, stamp };
      return;
    }
    if (seen.current.stamp === stamp) return;
    seen.current = { key, stamp };
    invalidateOwner(queryClient, id);
    patchStatus(key, { changedAt: Date.now() });
  }, [stamp, key, id, queryClient]);

  // Coming back to the tab, ask straight away rather than waiting out an interval that was not
  // running. `refetchOnWindowFocus` is off app-wide, so nothing else does this.
  const refetch = useRef(query.refetch);
  useEffect(() => {
    refetch.current = query.refetch;
  });
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) void refetch.current();
    wasVisible.current = visible;
  }, [visible]);

  // Publish what the indicator draws, and take it down on unmount so nothing claims to be
  // watching a page that is gone.
  useEffect(() => {
    patchStatus(key, { paused: !visible, checkedAt: dataUpdatedAt });
  }, [key, visible, dataUpdatedAt]);

  useEffect(() => () => dropStatus(key), [key]);
}

/** What the header card draws: seconds since the last successful read, and the two states that
 *  are not "live". `null` means nothing is watching this owner, and the indicator says nothing. */
export interface LiveStatus {
  paused: boolean;
  /** Whole seconds since the header last came back, or `null` before the first one. */
  checkedAgo: number | null;
  /** True for `FLASH_MS` after `seq`/`head` moved. */
  flash: boolean;
}

export function useLiveStatus(id: string): LiveStatus | null {
  const key = statusKey(id);
  const read = useCallback(() => statuses.get(key) ?? null, [key]);
  const status = useSyncExternalStore(subscribeStatus, read, () => null);

  // Only tick while there is something to tick for: an unwatched page runs no timer.
  const now = useNow(status ? TICK_MS : null);
  if (!status) return null;

  return {
    paused: status.paused,
    checkedAgo: status.checkedAt ? Math.max(0, Math.round((now - status.checkedAt) / 1000)) : null,
    flash: status.changedAt > 0 && now - status.changedAt < FLASH_MS,
  };
}

/**
 * `Date.now()`, re-read on an interval. `null` stops the clock. Exported for the loop page's
 * one-second clocks, which want the same stoppable tick this file's own watch uses.
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* -------------------------------------------------------------------------- */
/* The balance watch                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Follow the connected wallet's `UserBalance`.
 *
 * A poll, on purpose. The SDK offers `watchBalance` over `connection.onAccountChange`, but that
 * is a websocket, and in a browser the websocket is the one thing on this site that fails on
 * its own — an idle close, a proxy without upgrade — and fails as a console error nothing can
 * catch. Every other live number here polls, so the balance does too: every 8 s while a wallet
 * is connected, and at once after any write (`writes.ts` invalidates the same key). Charge
 * history is a `getSignaturesForAddress` walk, so it is refetched only when the balance moved.
 *
 * Mounted once for the whole app (`app/providers.tsx`), so every reader of `keys.balance` — the
 * vault pill, the billing page, the fund modal — follows the same poll.
 */
export function useBalanceWatch(user: PublicKey | null) {
  const queryClient = useQueryClient();
  const key = user?.toBase58();

  useEffect(() => {
    if (!key) return;
    let stopped = false;
    const tick = async () => {
      const before = JSON.stringify(queryClient.getQueryData(keys.balance(key)), (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      );
      await queryClient.invalidateQueries({ queryKey: keys.balance(key) });
      if (stopped) return;
      const after = JSON.stringify(queryClient.getQueryData(keys.balance(key)), (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      );
      if (after !== before) queryClient.invalidateQueries({ queryKey: keys.history(key) });
    };
    const timer = setInterval(() => void tick(), 8_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [queryClient, key]);
}

/**
 * The app-wide mount point for the balance watch. Renders nothing; it exists so the subscription
 * is tied to the provider tree rather than to whichever component happens to be showing a number.
 */
export function BalanceWatcher(): null {
  const { publicKey } = useWallet();
  useBalanceWatch(publicKey ?? null);
  return null;
}
