"use client";

import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Allowance,
  BillingActivity,
  Cell,
  ChainVerification,
  EpochRecord,
  EventRecord,
  hex,
  NameRecord,
  OwnerHeader,
  StructHeader,
  toBytes32,
  Treasury,
  UserBalance,
} from "@lath/sdk/browser";
import { useBilling, useLath, useSolana } from "./clients";
import { config } from "./config";
import { backoffDelay, isRateLimited, settledPool, uniqueBy, withRateLimitRetry } from "./owner-scan";

/**
 * Query keys. Ids are hex and keys are base58 — never `Uint8Array` or `PublicKey`, which do not
 * compare structurally and would silently give every render its own cache entry.
 */
export const keys = {
  treasury: () => ["treasury", config.treasuryAdmin.toBase58()] as const,
  balance: (user?: string) => ["balance", user] as const,
  walletUsdc: (user?: string) => ["wallet-usdc", user] as const,
  owners: (authority?: string) => ["owners", authority] as const,
  myOwners: (wallet?: string) => ["my-owners", wallet] as const,
  allowances: (user?: string) => ["allowances", user] as const,
  allowance: (user?: string, agent?: string) => ["allowance", user, agent] as const,
  events: (id: string) => ["events", id] as const,
  ownerState: (id: string) => ["owner-state", id] as const,
  chain: (id: string) => ["chain", id] as const,
  epochs: (id: string) => ["epochs", id] as const,
  structs: (id: string) => ["structs", id] as const,
  history: (user?: string) => ["history", user] as const,
  publishedName: (id: string) => ["published-name", id] as const,
  publishedNames: (ids: string[]) => ["published-names", ids.join(",")] as const,
  allAgents: () => ["all-agents"] as const,
};

export function useTreasury(): UseQueryResult<Treasury | null> {
  const billing = useBilling();
  return useQuery({ queryKey: keys.treasury(), queryFn: () => billing.getTreasury(), staleTime: 60_000 });
}

/**
 * The user's escrow balance.
 *
 * Kept live by the app-wide account subscription in `lib/live.ts` (`useBalanceWatch`), which
 * writes this same cache entry: a confirmed transaction and an updated account are not the same
 * moment, and the websocket is the one that actually knows. Every reader here — the vault pill,
 * the billing page, the fund modal — shares that one subscription.
 */
export function useBalance(user: PublicKey | null): UseQueryResult<UserBalance | null> {
  const billing = useBilling();
  return useQuery({
    queryKey: keys.balance(user?.toBase58()),
    queryFn: () => billing.getBalance(user!),
    enabled: !!user,
  });
}

export function spendable(balance: UserBalance | null | undefined): bigint {
  return balance ? balance.deposited - balance.spent - balance.reserved : 0n;
}

/** The USDC sitting in the wallet itself — what a top-up can draw on. */
export function useWalletUsdc(user: PublicKey | null): UseQueryResult<{ ata: PublicKey; amount: bigint | null }> {
  const connection = useSolana();
  return useQuery({
    queryKey: keys.walletUsdc(user?.toBase58()),
    enabled: !!user,
    // A wallet holding no USDC is sent to fund it elsewhere — the deposit form's faucet link opens
    // in a new tab — and comes back to a form that refuses every amount against this read. Nothing
    // else refreshes it (the app turns focus refetches off and `lib/live.ts` does not watch it), so
    // Deposit would stay disabled until the page remounted. Re-read on focus while the read says the
    // wallet can deposit nothing; "always" rather than `true` because a faucet round trip can be
    // shorter than the 15 s stale time. It is one `getAccountInfo` (and one balance read), not a
    // Photon scan, and once the wallet holds USDC focus no longer re-reads it.
    refetchOnWindowFocus: (query) => {
      const amount = query.state.data?.amount;
      return amount === null || amount === 0n ? "always" : false;
    },
    queryFn: async () => {
      const ata = getAssociatedTokenAddressSync(config.usdcMint, user!);
      const info = await connection.getAccountInfo(ata);
      // `amount: null` means "no token account yet". The deposit transaction creates one when it
      // is missing, but a deposit drawn from an account it just created has nothing to transfer,
      // so the form refuses every amount until the account is funded. Zero and absent are
      // different states and the UI says so.
      if (!info) return { ata, amount: null };
      const balance = await connection.getTokenAccountBalance(ata);
      return { ata, amount: BigInt(balance.value.amount) };
    },
  });
}

export function useOwnersByAuthority(authority: PublicKey | null): UseQueryResult<OwnerHeader[]> {
  const lath = useLath();
  return useQuery({
    queryKey: keys.owners(authority?.toBase58()),
    enabled: !!authority,
    queryFn: () => lath.listOwnersByAuthority(authority!),
  });
}

export function useAllowance(
  user: PublicKey | null,
  agentAuthority: PublicKey | null
): UseQueryResult<Allowance | null> {
  const billing = useBilling();
  return useQuery({
    queryKey: keys.allowance(user?.toBase58(), agentAuthority?.toBase58()),
    enabled: !!user && !!agentAuthority,
    queryFn: () => billing.getAllowance(user!, agentAuthority!),
  });
}

/** How this wallet is related to an owner: it signs for it, it funds it, or both. */
export type OwnerRelation = "signer" | "funded";

export interface MyOwner extends OwnerHeader {
  relations: OwnerRelation[];
  /** The grant that makes this "funded", when there is one. */
  allowance?: Allowance;
}

/** What `useMyOwners` read, and how much of it it could not. */
export interface MyOwnersRead {
  owners: MyOwner[];
  /**
   * Funded authorities whose scan the indexer refused even after retries. Non-zero means `owners`
   * is a floor, not the list: the page must say so rather than show a count, or "no agents", that
   * nothing on chain supports.
   */
  unreadAuthorities: number;
  /** Distinct funded authorities this read tried to scan. */
  fundedAuthorities: number;
}

/**
 * Funded-authority scans in flight at once. Helius refused 63 of ~100 concurrent
 * `getCompressedAccountsByOwnerV2` calls on the first burst; a handful at a time keeps a
 * wallet that funds a hundred agents under the limit and costs a few seconds, once per stale time.
 */
const OWNER_SCAN_CONCURRENCY = 5;
/** Retries per scan when the answer is a 429, before that one authority is counted unread. */
const OWNER_SCAN_RETRIES = 2;

/**
 * "My agents" — the union of the two halves of the identity model:
 *
 * 1. headers whose `authority` is the wallet, which the wallet signs for itself;
 * 2. headers whose authority the wallet *funds* through an `Allowance`.
 *
 * The second half is why this cannot be one query: an allowance names an agent **authority**,
 * not an agent, so each grant costs a second scan to find the headers that authority owns. Those
 * scans are deduped by authority, run a few at a time and settled one by one (`lib/owner-scan.ts`):
 * a refused scan drops that authority's rows and is counted, so the list degrades to a partial
 * read the page names instead of failing whole.
 */
export function useMyOwners(wallet: PublicKey | null): UseQueryResult<MyOwnersRead> {
  const lath = useLath();
  const billing = useBilling();
  return useQuery({
    queryKey: keys.myOwners(wallet?.toBase58()),
    enabled: !!wallet,
    // The two reads that are not per-grant still fail the query — without them there is no list
    // to be partial about. A 429 there is load shedding, not a dead indexer, so it gets a backoff
    // and a few more tries than the one immediate retry every other query has; any other error
    // keeps that one.
    retry: (failures, err) => failures < (isRateLimited(err) ? 4 : 1),
    retryDelay: (attempt) => backoffDelay(attempt, Math.random()),
    queryFn: async (): Promise<MyOwnersRead> => {
      const [mine, grants] = await Promise.all([
        withRateLimitRetry(() => lath.listOwnersByAuthority(wallet!), OWNER_SCAN_RETRIES),
        withRateLimitRetry(() => billing.listAllowancesByUser(wallet!), OWNER_SCAN_RETRIES),
      ]);

      const merged = new Map<string, MyOwner>();
      const add = (header: OwnerHeader, relation: OwnerRelation, allowance?: Allowance) => {
        const key = header.address.toBase58();
        const existing = merged.get(key);
        if (existing) {
          if (!existing.relations.includes(relation)) existing.relations.push(relation);
          existing.allowance ??= allowance;
          return;
        }
        merged.set(key, { ...header, relations: [relation], allowance });
      };

      for (const header of mine) add(header, "signer");
      const distinct = uniqueBy(grants, (g) => g.allowance.agentAuthority.toBase58());
      const funded = await settledPool(distinct, OWNER_SCAN_CONCURRENCY, (g) =>
        withRateLimitRetry(() => lath.listOwnersByAuthority(g.allowance.agentAuthority), OWNER_SCAN_RETRIES)
      );
      let unreadAuthorities = 0;
      funded.forEach((result, i) => {
        if (result.status === "rejected") {
          unreadAuthorities++;
          return;
        }
        for (const header of result.value) add(header, "funded", distinct[i].allowance);
      });

      return {
        owners: [...merged.values()].sort((a, b) => Number(b.state.updatedAt - a.state.updatedAt)),
        unreadAuthorities,
        fundedAuthorities: distinct.length,
      };
    },
  });
}

/**
 * The owner's header. One `getCompressedAccount`, which is why this is the read `useOwnerWatch`
 * polls: `refetchInterval` is exposed so the watcher can drive this exact query rather than open
 * a second one beside it (`lib/live.ts`). Left `false`, it behaves as it always did.
 */
export function useOwnerState(id: string, enabled = true, refetchInterval: number | false = false) {
  const lath = useLath();
  return useQuery({
    queryKey: keys.ownerState(id),
    enabled,
    refetchInterval,
    queryFn: () => lath.getAgentState(toBytes32(id)),
  });
}

export function useEvents(id: string, enabled = true): UseQueryResult<EventRecord[]> {
  const lath = useLath();
  return useQuery({
    queryKey: keys.events(id),
    enabled,
    queryFn: () => lath.listEvents(toBytes32(id)),
  });
}

export function useChainVerification(id: string, enabled = true): UseQueryResult<ChainVerification> {
  const lath = useLath();
  return useQuery({
    queryKey: keys.chain(id),
    enabled,
    queryFn: () => lath.verifyChain(toBytes32(id)),
  });
}

/**
 * Every epoch this owner committed, from `EpochCommitted` events in its transaction history.
 * A walk over history rather than a Photon scan, so it is asked for once per page and cached.
 */
export function useEpochs(id: string, enabled = true): UseQueryResult<EpochRecord[]> {
  const lath = useLath();
  return useQuery({
    queryKey: keys.epochs(id),
    enabled,
    staleTime: 60_000,
    queryFn: () => lath.listEpochs(toBytes32(id)),
  });
}

/** A structure header together with the live cells that belong to it. */
export interface StructureView {
  header: StructHeader;
  cells: Cell[];
}

/**
 * Every `Log`, `Map` and `Set` this owner has, with their cells — two Photon scans over the
 * same owner-id filter, grouped client-side. Closed cells are gone from the tree, so what comes
 * back is the live state, not the history: the history is the owner's event chain.
 */
export function useStructures(id: string, enabled = true): UseQueryResult<StructureView[]> {
  const lath = useLath();
  return useQuery({
    queryKey: keys.structs(id),
    enabled,
    queryFn: async () => {
      const client = lath;
      const ownerId = toBytes32(id);
      const headers = await client.listStructs(ownerId);
      if (headers.length === 0) return [];
      const cells = await client.listOwnerCells(ownerId, headers);
      return headers.map((header) => ({
        header,
        cells: cells.filter((c) => hex(c.structId) === hex(header.structId)),
      }));
    },
  });
}

export function useChargeHistory(user: PublicKey | null): UseQueryResult<BillingActivity[]> {
  const billing = useBilling();
  return useQuery({
    queryKey: keys.history(user?.toBase58()),
    enabled: !!user,
    queryFn: () => billing.chargeHistory(user!, { limit: 100 }),
  });
}

export function idOf(header: OwnerHeader): string {
  return hex(header.state.agentId);
}

/**
 * The name the owner published about itself, verified by re-hashing (`NameRecord`).
 *
 * `agent_id = sha256(name)` is one-way, so the chain cannot hand you a name — but the owner can
 * publish its own *preimage*, and a wrong one is arithmetically wrong. That is why this needs no
 * registry service and no signature check: there is no claim here anyone has to be trusted for.
 * `null` covers both "nothing published" and "published something that does not hash to this
 * owner", because an unverifiable name is not a name.
 */
export function usePublishedName(id: string, enabled = true): UseQueryResult<string | null> {
  const client = useLath();
  return useQuery({
    queryKey: keys.publishedName(id),
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => new NameRecord(client, toBytes32(id)).name(),
  });
}

/**
 * The same read for a list. Each name is one account fetch at a derived address, so this is N
 * parallel point reads rather than a scan — which is what makes it reasonable to ask for every
 * row of a table. `null` entries are owners that published nothing (or something that does not
 * hash to them, which is the same answer — see `usePublishedName`).
 *
 * Keyed on the joined ids so a changing list does not serve a stale map.
 */
export function usePublishedNames(ids: string[]): UseQueryResult<Record<string, string>> {
  const client = useLath();
  const sorted = [...ids].sort();
  return useQuery({
    queryKey: keys.publishedNames(sorted),
    enabled: sorted.length > 0,
    staleTime: 5 * 60_000,
    // Pooled and settled, because Explore asks for every header on the program at once: a burst of
    // ~100 point reads is what Helius sheds, and one refused read should cost that row its
    // name, not every row theirs.
    queryFn: async () => {
      const found = await settledPool(sorted, NAME_READ_CONCURRENCY, (id) =>
        withRateLimitRetry(() => new NameRecord(client, toBytes32(id)).name(), OWNER_SCAN_RETRIES)
      );
      const out: Record<string, string> = {};
      found.forEach((result, i) => {
        if (result.status === "fulfilled" && result.value) out[sorted[i]] = result.value;
      });
      return out;
    },
  });
}

/**
 * Name reads in flight at once. Ten drew 429s from Helius on Explore's ~470 ids; the
 * owner pool's five is the width already measured to stay under the limit.
 */
const NAME_READ_CONCURRENCY = 5;

/**
 * Every agent header on the program — the Explore grid's rows.
 *
 * One header-only scan (`LathClient.listAgents`), measured at 1.8 s on devnet. It is
 * the slowest read on the page and the one nothing else waits on, so it is cached for a minute:
 * a header that moved since is one refresh away, and the tile's hover reads its events live.
 */
export function useAllAgents(): UseQueryResult<OwnerHeader[]> {
  const lath = useLath();
  return useQuery({
    queryKey: keys.allAgents(),
    staleTime: 60_000,
    retry: (failures, err) => failures < (isRateLimited(err) ? 4 : 1),
    retryDelay: (attempt) => backoffDelay(attempt, Math.random()),
    queryFn: () => lath.listAgents(),
  });
}
