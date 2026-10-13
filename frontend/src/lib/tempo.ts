"use client";

import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { EventKind, type EventRecord, LOOP_SETTLEMENT_TOOL, hex, idFromString, subHashes } from "@lath/sdk/browser";
import {
  closeReceiptDetails,
  closeReceiptProblem,
  settlementCovering,
  settlementFromBlob,
  type CloseReceiptDetails,
  type RpcCloseReceipt,
  type TempoSettlementView,
} from "./tempo-close";
import { tracePartQuery, type TraceReaders } from "./traces";

/**
 * The browser's side of the `tempo` rail: what a record says about a payment, what the treasury
 * says about whose money it was, and the one verdict this page is allowed to claim.
 *
 * Two units live here and they are never added together: the **gateway
 * price** is what left the payer's account, USDC.e base units, the delta between two signed
 * vouchers; the **model cost** is OpenRouter's `usage.cost` in USD, recorded as information
 * because the gateway prices a request flat and the two never reconcile. The columns keep those
 * names on screen for that reason.
 *
 * Who the payer is depends on the record's version. A v2 record's `payment.payer` is the operator's
 * Tempo treasury, which signs every voucher; an older v1 record's is a per-agent address derived from
 * the agent's key, which does not spend. The two share one blob layout, so the address alone says which it
 * is, and `payerKind` below is that comparison and nothing more.
 *
 * Nothing here signs anything or holds a key. The only network call this module makes to Tempo is
 * one public `eth_getTransactionReceipt`, which is a read anybody can make; viem never reaches
 * the browser bundle.
 */

/**
 * What a row's `policy.payment` may carry. `"vault"` is readable because older records carry it;
 * nothing in this build writes it, and an agent whose row names it or names nothing runs on Tempo
 * like every other.
 */
export type Rail = "vault" | "tempo";

/** The `payment` object an Action's result blob carries on the `tempo` rail. */
export interface TempoPaymentView {
  rail: "tempo";
  chainId: number;
  payer: string;
  channelId: string;
  cumulativeBefore: string;
  cumulativeAfter: string;
  /** The gateway's `usage.cost` in USD, when the body carried one. Never a meter. */
  usageCost?: number;
}

// Defined beside the matching rule, which is React-free so `tests/console-reader.ts` can run it.
export type { CloseReceiptDetails, TempoSettlementView } from "./tempo-close";
export {
  TEMPO_ESCROW_ADDRESS,
  closeCoversCumulative,
  closeReceiptDetails,
  settlementFromBlob,
  settlementCovering,
} from "./tempo-close";

/**
 * A record that can carry a settlement: a Resolution, or a `loop.settlement` Action — found by its
 * on-chain `reference` (the tool id is `sha256(name)`), so picking them costs no read.
 */
export interface SettlementCarrier {
  record: EventRecord;
  /** The genesis of the record's session, whose bundle holds its blobs. */
  genesis?: Uint8Array;
}

const LOOP_SETTLEMENT_REF = hex(idFromString(LOOP_SETTLEMENT_TOOL));

const isLoopSettlement = (r: EventRecord) => r.kind === EventKind.Action && hex(r.reference) === LOOP_SETTLEMENT_REF;

/** The records of a chain that can carry a settlement, in seq order. */
export function settlementCarriers(
  records: readonly EventRecord[],
  genesisFor: (seq: string) => Uint8Array | undefined
): SettlementCarrier[] {
  return records
    .filter((r) => r.kind === EventKind.Resolution || isLoopSettlement(r))
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    .map((record) => ({ record, genesis: genesisFor(record.seq.toString()) }));
}

/**
 * How many carriers of each kind after a paid call are read to find its close. A session's close
 * is its own Resolution, the next one; a loop's is its `loop.settlement`, with a Resolution per
 * step in between that carries none. Three of each covers both without reading every Resolution
 * on a long chain for every block a reader opens.
 */
const CARRIERS_READ = 3;

/**
 * The settlement that covers a call paid at `afterSeq` on `channelId`, read off the chain the way
 * `DualRailPanel` reads it (a Resolution's output blob, a `loop.settlement`'s result blob) and
 * picked by `settlementCovering`, the audit's rule. `null` until a close is found, which the
 * block shows as PENDING: the channel is not closed yet, or this page cannot read its close.
 *
 * Every read goes through `tracePartQuery`'s key, so the blocks of one session share one fetch per
 * carrier, and so does the dual-rail panel on the same page.
 */
export function useChainSettlement(
  store: TraceReaders | null,
  carriers: readonly SettlementCarrier[],
  afterSeq: bigint | null,
  channelId: string | null | undefined,
  callGenesis?: Uint8Array
): TempoSettlementView | null {
  // A carrier whose session is not the paid call's (its genesis differs) is `laterSession` for
  // `settlementCovering`, which then stops taking Resolutions: a session that never resolved must
  // not be credited with the next session's close (the browser's side of `settlementCovering`'s rule).
  // Without the call's genesis nothing is marked and the rule falls back to the first Resolution being the
  // call's own.
  const otherSession = (c: SettlementCarrier) => !!callGenesis && !!c.genesis && hex(c.genesis) !== hex(callGenesis);
  const after = afterSeq === null || !channelId ? [] : carriers.filter((c) => c.record.seq > afterSeq);
  const picked = [
    ...after.filter((c) => isLoopSettlement(c.record)).slice(0, CARRIERS_READ),
    ...after.filter((c) => c.record.kind === EventKind.Resolution).slice(0, CARRIERS_READ),
  ].sort((a, b) => (a.record.seq < b.record.seq ? -1 : 1));

  const preimages = useQueries({
    queries: picked.map((c) => tracePartQuery(store, hex(c.record.payloadHash), true, c.genesis)),
  });
  // A Resolution's settlement is in its final-output blob (sub-hash 0); a `loop.settlement`
  // Action's is its result blob (sub-hash 1).
  const blobHashes = picked.map((c, i) => {
    const d = preimages[i]?.data;
    if (d?.status !== "ok" || !d.bytes) return null;
    const subs = subHashes(c.record.kind, d.bytes.slice(1));
    const h = c.record.kind === EventKind.Resolution ? subs[0] : subs[1];
    return h ? hex(h) : null;
  });
  const blobs = useQueries({
    queries: picked.map((c, i) => tracePartQuery(store, blobHashes[i], !!blobHashes[i], c.genesis)),
  });

  return settlementCovering(
    channelId,
    picked.map((c, i) => {
      const loop = isLoopSettlement(c.record);
      const laterSession = otherSession(c);
      if (!preimages[i]?.isFetched) return { loop, laterSession, settlement: undefined };
      if (!blobHashes[i]) return { loop, laterSession, settlement: null };
      const b = blobs[i];
      if (!b?.isFetched) return { loop, laterSession, settlement: undefined };
      return {
        loop,
        laterSession,
        settlement: b.data?.status === "ok" ? settlementFromBlob(b.data.bytes) : null,
      };
    })
  );
}

export const TEMPO_RPC_URL = "https://rpc.tempo.xyz";
export const TEMPO_EXPLORER = "https://explore.tempo.xyz";

export function tempoTxUrl(hash: string): string {
  return `${TEMPO_EXPLORER}/tx/${hash}`;
}

export function tempoAddressUrl(address: string): string {
  return `${TEMPO_EXPLORER}/address/${address}`;
}

/**
 * A TIP-20 token on the explorer (USDC.e, the fee token). It is the address page, on its token tab:
 * the explorer has no token page of its own, and `/token/<address>` answers a 307 to exactly this
 * url, so linking it directly saves the reader the redirect.
 */
export function tempoTokenUrl(address: string): string {
  return `${tempoAddressUrl(address)}?tab=token`;
}

/**
 * A block on the explorer, or `null` for anything that is not a block number. Takes the decimal
 * strings the console serves (`tempoSnapshot.treasury.block`, `services.*.block`) as well as a
 * JSON-RPC `0x…` quantity, and links the decimal form.
 *
 * Probed: `/block/42676796` answered 200 with the page titled
 * _Block 42676796 ⋅ Tempo Explorer_, and a block past the head answered 404, so this is a real page
 * and not the explorer's catch-all.
 */
export function tempoBlockUrl(block: string | number | bigint | null | undefined): string | null {
  if (block === null || block === undefined) return null;
  let n: bigint;
  try {
    if (typeof block === "string") {
      const s = block.trim();
      if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) return null;
      n = BigInt(s);
    } else if (typeof block === "number") {
      if (!Number.isSafeInteger(block)) return null;
      n = BigInt(block);
    } else n = block;
  } catch {
    return null;
  }
  return n < BigInt(0) ? null : `${TEMPO_EXPLORER}/block/${n.toString()}`;
}

/** Base units of USDC.e as a figure with its six decimals, the way the vault's USDC is shown. */
export function formatBaseUnits(value: string | bigint | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  let v: bigint;
  try {
    v = BigInt(value);
  } catch {
    return "—";
  }
  const unit = BigInt(1_000_000);
  const sign = v < BigInt(0) ? "-" : "";
  const abs = v < BigInt(0) ? -v : v;
  return `${sign}${abs / unit}.${(abs % unit).toString().padStart(6, "0")}`;
}

/** The voucher delta of one call: what this Action actually cost at the gateway. */
export function gatewayPrice(payment: TempoPaymentView): bigint {
  try {
    const before = BigInt(payment.cumulativeBefore || "0");
    const after = BigInt(payment.cumulativeAfter || "0");
    return after > before ? after - before : BigInt(0);
  } catch {
    return BigInt(0);
  }
}

export type Verdict = "verified" | "pending" | "failed";

/**
 * What this page may say about a payment, and no more.
 *
 * `pending` is the honest answer for a channel that is still open — the vouchers are signed and
 * the gateway served the completion, but nothing has settled on Tempo yet, and a closed channel
 * reads as zeros so its state cannot be the test either. `verified` means the settlement
 * receipt says the same three things `lath-audit verify-inference` checks, minus the amount: the
 * transaction succeeded, it was sent to the escrow, and the escrow's own `ChannelClosed` log
 * names this channel and this payer (`useTempoReceipt`, `closeReceiptProblem`); `status: 0x1`
 * alone would let a successful transaction to anything read VERIFIED. `failed` is a
 * close that did not happen, a reverted receipt, or one that closed something else. The amount —
 * the settled `finalAmount` covers the last voucher — is still only the audit's, which is why
 * the copy-pasteable line sits beside this badge rather than behind it.
 */
export function verdictFor(settlement: TempoSettlementView | null | undefined, receiptOk?: boolean): Verdict {
  if (!settlement || (!settlement.txHash && settlement.closed !== false)) return "pending";
  if (settlement.closed === false || settlement.error) return "failed";
  if (!settlement.txHash) return "pending";
  if (receiptOk === undefined) return "pending";
  return receiptOk ? "verified" : "failed";
}

export const VERDICT_LABEL: Record<Verdict, { text: string; tone: "good" | "warn" | "bad" }> = {
  verified: { text: "VERIFIED", tone: "good" },
  pending: { text: "PENDING", tone: "warn" },
  failed: { text: "FAILED", tone: "bad" },
};

/**
 * What the settlement receipt says about the close a record names. `ok` is what `verdictFor`
 * takes: `true` only when `problem` is null, `false` for a receipt that says the close failed or
 * closed something else, and absent when there is nothing to compare the close against — which
 * keeps the badge PENDING rather than calling either answer. `problem` is the badge's title.
 */
export interface TempoReceiptCheck {
  ok?: boolean;
  problem: string | null;
}

/**
 * The settlement transaction's receipt, read straight from a public Tempo endpoint, and checked
 * against the channel (and payer) the record says was settled.
 *
 * One JSON-RPC call by `fetch`, no client library: the receipt's status, its `to`, and the
 * escrow's `ChannelClosed` log are all plain hex (`closeReceiptProblem`). A row written before the
 * channel id was recorded has nothing to hold the log against, so it stays PENDING with a title
 * that says so — a VERIFIED there would be a status-only check under another name.
 */
export function useTempoReceipt(
  txHash: string | null | undefined,
  channelId: string | null | undefined,
  payer?: string | null
): UseQueryResult<TempoReceiptCheck | null> {
  return useQuery({
    ...receiptQuery(txHash),
    select: (receipt: RpcCloseReceipt | null) => (receipt ? receiptCheck(receipt, channelId, payer) : null),
  });
}

/**
 * The close receipt, as the RPC returned it: one fetch per transaction, shared by every hook that
 * reads it. The key is the hash alone so `useTempoReceipt` and `useTempoCloseDetails` on the same
 * close — the badge and the amount beside it — make one request, not two; what each concludes
 * from it is its `select`, which runs per channel and payer.
 */
function receiptQuery(txHash: string | null | undefined) {
  return {
    queryKey: ["tempo-receipt", txHash ?? ""],
    enabled: !!txHash,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<RpcCloseReceipt | null> => {
      const res = await fetch(TEMPO_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      });
      const body = await res.json().catch(() => null);
      // Not yet mined is not a failure: the query simply has no answer, and the badge stays
      // PENDING until it does.
      return (body?.result as RpcCloseReceipt | null | undefined) ?? null;
    },
  };
}

function receiptCheck(
  receipt: RpcCloseReceipt,
  channelId: string | null | undefined,
  payer?: string | null
): TempoReceiptCheck {
  if (!channelId) {
    // A reverted close is a failure whether or not there is a channel to compare against.
    if (receipt.status !== "0x1") return { ok: false, problem: closeReceiptProblem(receipt, "") };
    return { problem: "no channel id to check the close against" };
  }
  const problem = closeReceiptProblem(receipt, channelId, payer);
  return { ok: problem === null, problem };
}

/**
 * The receipt check, plus what the close paid out: `useTempoReceipt`'s verdict on the same
 * receipt, and `closeReceiptDetails` — the payee, `finalAmount` and refund the escrow's
 * `ChannelClosed` for this channel names, decoded in this browser.
 */
export interface TempoCloseCheck extends TempoReceiptCheck {
  /** `null` when the receipt carries no well-formed close of this channel (or no channel was named). */
  details: CloseReceiptDetails | null;
}

/**
 * What a settlement paid, read off its receipt in this browser: the line _OpenRouter received
 * X USDC.e · checked against Tempo in this browser_ is `details.finalAmountBase` shown while
 * `ok` is `true`. While `ok` is not `true` the figures are what the log says and not a checked
 * payment, and the caller says so or shows nothing — the same rule `verdictFor` holds the badge to.
 *
 * One public `eth_getTransactionReceipt`, shared with `useTempoReceipt` (`receiptQuery`). `data`
 * is `null` until the transaction is mined, and a failed read is the query's error state.
 */
export function useTempoCloseDetails(
  txHash: string | null | undefined,
  channelId: string | null | undefined,
  payer?: string | null
): UseQueryResult<TempoCloseCheck | null> {
  return useQuery({
    ...receiptQuery(txHash),
    select: (receipt: RpcCloseReceipt | null): TempoCloseCheck | null =>
      receipt
        ? {
            ...receiptCheck(receipt, channelId, payer),
            details: channelId ? closeReceiptDetails(receipt, channelId) : null,
          }
        : null,
  });
}

export interface TempoTreasuryInfo {
  /**
   * The route's own statement: `false` means no treasury is configured. It is also `false` when
   * the route could not be asked, and then `unreachable` says so.
   */
  enabled: boolean;
  /**
   * Set when the route did not answer — an HTTP status or the fetch's own error. Ours, not the
   * route's: whether the deployment has a treasury is then unknown.
   */
  unreachable?: string;
  address?: string;
  chainId?: number;
  token?: string;
  balanceBase?: string | null;
  balanceError?: string;
  /** Channels this console process currently holds open against the treasury. */
  openChannels?: number;
}

/**
 * Whose money pays this deployment's `tempo` rail.
 *
 * `enabled: false` is the route's statement that no treasury is configured; `unreachable` is ours
 * that we could not ask. Both leave `enabled` false — every caller that only needs to know
 * whether it can show an address reads it unchanged — but the two must never render the same
 * sentence: /billing saying *this deployment has no Tempo treasury configured* after a 502 would
 * be a configuration claim nothing established. Every field is optional for the same
 * reason, and no caller may assume an address is there.
 */
export function useTempoTreasury(): UseQueryResult<TempoTreasuryInfo> {
  return useQuery({
    queryKey: ["tempo-treasury"],
    staleTime: 30_000,
    queryFn: async (): Promise<TempoTreasuryInfo> => {
      let res: Response;
      try {
        res = await fetch("/api/tempo/treasury");
      } catch (e: any) {
        return { enabled: false, unreachable: e?.message ?? String(e) };
      }
      if (!res.ok) return { enabled: false, unreachable: `HTTP ${res.status}` };
      try {
        return (await res.json()) as TempoTreasuryInfo;
      } catch (e: any) {
        return { enabled: false, unreachable: `an unreadable answer (${e?.message ?? String(e)})` };
      }
    },
  });
}

/** One row of `GET /api/agents`, with the fields the rail adds. Every one is optional on read. */
export interface TempoAgentRow {
  id: string;
  name: string;
  owner?: string;
  policy: { model: string; payment?: Rail };
  /** v1 (legacy): the address derived from the agent's key. Not written by this build; never spends. */
  tempoAddress?: string;
  /** v1 (legacy): base units the treasury once transferred into that address. */
  tempoFunded?: string;
  /** v1 (legacy): the TIP-20 transfer that funded it. */
  tempoFundTx?: string;
  /** v1 (legacy): base units the operator's drain returned to the treasury. */
  tempoDrained?: string;
  /** v1 (legacy): the transfer the drain sent. */
  tempoDrainTx?: string;
  tempoNote?: string;
}

/**
 * The console's record of one agent, including the v1 wallet fields. `GET /api/agents/:id` reports
 * a fixed set of fields and those are not among them, so this reads the list route, which serves
 * rows whole.
 */
export function useTempoAgent(id: string | null | undefined): UseQueryResult<TempoAgentRow | null> {
  return useQuery({
    queryKey: ["tempo-agent-rows"],
    staleTime: 15_000,
    queryFn: async (): Promise<TempoAgentRow[]> => {
      const res = await fetch("/api/agents");
      if (!res.ok) return [];
      return (await res.json()).agents ?? [];
    },
    select: (rows: TempoAgentRow[]) => rows.find((r) => r.id === (id ?? "").toLowerCase()) ?? null,
    enabled: !!id,
  });
}

/**
 * The custody line, shown wherever an agent is on the `tempo` rail. It is a limit, not a footnote,
 * and a wide one on v2 records: the account that signs every voucher is the operator's treasury,
 * held by the server, and the two things that bound it are its own ceiling and the deposit one
 * session may commit.
 */
export const CUSTODY_LINE =
  "Every voucher is signed inside the runtime by the operator's Tempo treasury, a server-held account capped at " +
  "$10 USDC.e; a session can commit no more than its channel's maxDeposit. The agent's own Tempo identity exists " +
  "only on older records.";

/**
 * What closing an agent does to Tempo money, on both versions. `close_agent` closes a compressed
 * header; it moves no USDC.e. On v2 there is nothing at the agent to move, because the treasury
 * paid; on v1 the remainder comes back only because the operator runs the drain, which is an operator
 * action and not a refund.
 */
export const NO_REFUND_LINE =
  "Closing an agent moves no money on either version: on this rail the treasury pays, and what an older per-agent " +
  "wallet still holds comes back only when the operator drains it.";

/** Whose account signed a voucher, decided by the address alone. */
export type PayerKind = "treasury" | "agent-v1" | "unknown";

const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** True when this voucher was signed by the operator's treasury — a v2 record. */
export function isTreasuryPayer(payer: string | null | undefined, treasury: string | null | undefined): boolean {
  return sameAddress(payer, treasury);
}

/**
 * What to call the address in `payment.payer`.
 *
 * The treasury address is the only thing that distinguishes a v2 record from a v1 one, so when the
 * treasury route says `enabled: false` — an `--e2e` run, a console with no rail configured, a
 * route that did not answer — the honest answer is `unknown` and the caller shows the address
 * bare. `agent-v1` is claimed only against an address this console actually knows for the agent.
 */
export function payerKind(
  payer: string | null | undefined,
  treasury: string | null | undefined,
  agentAddress: string | null | undefined
): PayerKind {
  if (sameAddress(payer, treasury)) return "treasury";
  if (sameAddress(payer, agentAddress)) return "agent-v1";
  return "unknown";
}

export const PAYER_LABEL: Record<PayerKind, string> = {
  treasury: "the operator's Tempo treasury",
  "agent-v1": "agent wallet (v1)",
  unknown: "",
};
