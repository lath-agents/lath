"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EventKind, EventRecord, EpochRecord, hex, subHashes } from "@lath/sdk/browser";
import { Badge, Card, Info, Skeleton } from "@/components/ui";
import { TempoLink, TempoMark } from "@/components/Tempo";
import {
  ChannelRef,
  CloseReceived,
  PaymentTermsInfo,
  paidCallErrorFromBlob,
  paymentFromBlob,
} from "@/components/TracePanel";
import { truncate } from "@/lib/format";
import { useEpochSteps, useTracePart, useTraceStore, type TraceReaders } from "@/lib/traces";
import { keys, useEpochs, useEvents } from "@/lib/queries";
import {
  PAYER_LABEL,
  type PayerKind,
  TempoSettlementView,
  VERDICT_LABEL,
  formatBaseUnits,
  gatewayPrice,
  payerKind,
  settlementFromBlob,
  useTempoAgent,
  useTempoReceipt,
  useTempoTreasury,
  verdictFor,
} from "@/lib/tempo";

/**
 * The two rails of one run, side by side: Solana on the left, Tempo on the right.
 *
 * Left is what the chain proves — the seq, the head it folded, and whether the record landed.
 * Right is what the gateway was paid for that same call: the voucher delta, in USDC.e. The
 * channel id is stated once, because there is one channel per session and per loop, and the
 * settlement row closes the list with the transaction that paid the channel out.
 *
 * Two numbers a reader looks for are deliberately *not* here, and the description says where they
 * are instead, so it never promises a charge no column carries. The
 * wallet's USDC debit is the vault's charge: the payment blob a row is built from carries the
 * voucher cumulative and the gateway's `usage.cost`, not the micro-USDC debited, so a column for
 * it would be a Solana read per row for a number the run already states in the chat's session
 * footer. The Action's transaction signature is not on an `EventRecord` either — a record read as
 * a compressed account carries its address, not the signature that wrote it — which is why the
 * Events timeline links a transaction on an epoch and not on a record.
 *
 * The payer is per row rather than per panel, because one chain can straddle the two versions of
 * the rail: older seqs name a payer address derived from the agent's key, newer ones name the
 * operator's treasury. Which is which is decided
 * by comparing the address in the blob against `GET /api/tempo/treasury`, and when that route says
 * there is no rail the address is shown as it is rather than guessed at.
 *
 * Two sources, one table. A run happening in front of the reader fills it from the SSE kinds
 * `/api/run` emits (`live`); a page loaded afterwards rebuilds it from the blobs the records
 * already commit to, which is the same data read the slower way — and the only one available for
 * a loop, whose steps are batched into epochs. Neither source is the console's word for it: every
 * row on the right came out of bytes this browser re-hashed against the chain.
 */

export interface LiveVoucher {
  seq: string;
  cumulativeBefore: string;
  cumulativeAfter: string;
  usageCost?: number;
}

export interface LiveRail {
  payer?: string;
  channelId?: string;
  vouchers: LiveVoucher[];
  settlement?: TempoSettlementView | null;
}

/** One row: a seq on the chain, and what left the wallet for it. */
interface RailRow {
  seq: string;
  head?: string;
  status?: string;
  /** Base units of USDC.e; `null` while the blob behind this seq has not resolved. */
  delta: bigint | null;
  usageCost?: number;
  channelId?: string;
  /** The address in the blob's `payment.payer`, verbatim. */
  payer?: string;
  /** The blob's `error`, when the call was paid and its answer never arrived. */
  failed?: string | null;
}

/** Says which version of the rail an address belongs to; see the panel's note above. */
type DescribePayer = (payer: string | undefined) => PayerKind;

/**
 * The panel's name when the caller gives none: _Solana record · Tempo payment_, the
 * two halves it puts side by side, in the words the rest of the screen uses for them.
 */
export const DUAL_RAIL_TITLE = "Solana record · Tempo payment";

export function DualRailPanel({
  agentId,
  live,
  title = DUAL_RAIL_TITLE,
  refreshOn,
  nested = false,
}: {
  agentId: string;
  /** A run streaming right now. Omitted on a page that is only reading what happened. */
  live?: LiveRail;
  title?: string;
  /**
   * Anything that changes when a new record lands — the loop page passes its step count and last
   * seq. The panel's reads are cached and never polled, so without this a loop's rows would stop
   * at the step the page was opened on and only a reload would show the next one.
   */
  refreshOn?: string | number;
  /** Drawn as a section of an enclosing card (the loop page's _Costs_) rather than a card of its own. */
  nested?: boolean;
}) {
  const queryClient = useQueryClient();
  // Refetch on a change, not on mount: the first render already reads everything below.
  const seen = useRef(refreshOn);
  useEffect(() => {
    if (refreshOn === undefined || seen.current === refreshOn) return;
    seen.current = refreshOn;
    void queryClient.invalidateQueries({ queryKey: keys.events(agentId) });
    void queryClient.invalidateQueries({ queryKey: keys.epochs(agentId) });
    void queryClient.invalidateQueries({ queryKey: ["tempo-agent-rows"] });
  }, [refreshOn, agentId, queryClient]);
  const row = useTempoAgent(agentId);
  const treasury = useTempoTreasury();
  const treasuryAddress = treasury.data?.enabled ? treasury.data.address : undefined;
  const describePayer: DescribePayer = (payer) => payerKind(payer, treasuryAddress, row.data?.tempoAddress);

  // No "is this agent on the rail" question: there is one rail, every billed call is paid on it,
  // and an agent with no paid call is one that has never been billed — a chain to read, not a panel
  // to hide. Hiding it on the agent row would make the table appear a beat after the page did, and a
  // reader could not tell an unbilled agent from a slow read. Both render the same table.
  const events = useEvents(agentId, true);
  const epochs = useEpochs(agentId, true);
  const store = useTraceStore(agentId);

  const records = events.data ?? [];
  const genesisFor = useMemo(() => sessionGenesis(records), [records]);

  const actions = records.filter((r) => r.kind === EventKind.Action);
  // What each row below has learned about its record: `undefined` while its blobs are still
  // being read, then whether a payment was behind them. The rows decide for themselves whether
  // to render, so without this the parent could only count records, and a chain whose Actions
  // were all scripted, or older records with no payment, or whose blobs this console cannot
  // serve, would render a table with a header and nothing under it. The panel waits for every
  // row to settle and is drawn only when one of them found a payment.
  const [reports, setReports] = useState<Record<string, boolean | undefined>>({});
  const report = useCallback<RowReport>(
    (key, paid) => setReports((r) => (key in r && r[key] === paid ? r : { ...r, [key]: paid })),
    []
  );
  const expected = [...actions.map((r) => `a-${r.seq}`), ...(epochs.data ?? []).map((e) => `e-${hex(e.epochRoot)}`)];
  const settled = expected.every((k) => reports[k] !== undefined);
  const anyPaid = expected.some((k) => reports[k] === true);
  // A settlement lives on the Resolution that closed a session, or on the `loop.settlement`
  // Action a loop writes on its way out. Both are read from the last few records rather than the
  // whole chain: a page shows the run it is about, not every run this agent ever had.
  const closers = [...records]
    .filter((r) => r.kind === EventKind.Resolution || r.kind === EventKind.Action)
    .sort((a, b) => (a.seq > b.seq ? -1 : 1))
    .slice(0, 8);

  // Nothing to show is nothing rendered, not an empty sentence claiming *this chain has never paid
  // for a call*, which it cannot know: a row reports "not paid" both when the record carries no
  // payment and when the blob behind it is ciphertext this page has no key for, so on such a page a
  // chain that paid for every step would say it had paid for none. A card that is absent until it
  // has a row to show says less and nothing false.
  const nothingToShow = !live?.vouchers.length && (expected.length === 0 || (settled && !anyPaid));
  if (nothingToShow) return null;

  return (
    <Card
      nested={nested}
      // The description behind the title's ⓘ: it is what the columns mean, and it is the longest
      // text on the card.
      title={
        <>
          <span>{title}</span>
          <Info label="What this table shows" wide>
            <p className="text-2xs leading-relaxed text-ink-3">
              One row per LLM call: what the chain folded on the left, what was paid to OpenRouter via Tempo on the
              right. The wallet&apos;s USDC debit is not a column here — a run states it in the chat&apos;s session
              footer — and the transaction it landed in is linked in Events, on the epoch that committed these records.
            </p>
          </Info>
        </>
      }
      tone="emerald"
      right={
        <Badge tone="neutral">
          <TempoMark /> tempo
        </Badge>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
          {live?.channelId && (
            <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="dual-rail-channel">
              payment channel <ChannelRef channelId={live.channelId} />
            </span>
          )}
          {/* The panel's own payer, for a run in flight: the rows below have none until their
              blobs resolve, and a run streaming now is the one case where the address is known
              before any record exists. */}
          {live?.payer && <PayerCell payer={live.payer} kind={describePayer(live.payer)} />}
        </div>

        {events.isLoading && !live ? (
          <Skeleton rows={3} />
        ) : (
          <div className="table-wrap">
            <table className="w-full min-w-[34rem] text-sm" data-testid="dual-rail">
              <thead className="border-b border-line/[0.08]">
                <tr>
                  <th className="th">Seq</th>
                  <th className="th">Head</th>
                  <th className="th">Status</th>
                  <th className="th">Payer</th>
                  <th className="th text-right">
                    <span className="inline-flex items-center gap-1">
                      This call&apos;s payment <PaymentTermsInfo />
                    </span>
                  </th>
                  <th
                    className="th text-right"
                    title="what OpenRouter's response reported the call cost (its usage.cost), in US dollars; a third figure, not a ledger here"
                  >
                    Model cost (USD)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/[0.06]">
                {/* Live first, because a run in flight has vouchers before it has records. */}
                {(live?.vouchers ?? []).map((v) => (
                  <Row
                    key={`live-${v.seq}`}
                    row={{
                      seq: v.seq,
                      status: "in flight",
                      delta: delta(v.cumulativeBefore, v.cumulativeAfter),
                      usageCost: v.usageCost,
                      payer: live?.payer,
                    }}
                    describePayer={describePayer}
                  />
                ))}
                {!live &&
                  actions.map((record) => (
                    <ChainRow
                      key={`a-${record.seq}`}
                      record={record}
                      store={store}
                      genesis={genesisFor.get(record.seq.toString())}
                      describePayer={describePayer}
                      report={report}
                    />
                  ))}
                {!live &&
                  (epochs.data ?? []).map((epoch) => (
                    <EpochRows
                      key={hex(epoch.epochRoot)}
                      epoch={epoch}
                      store={store}
                      describePayer={describePayer}
                      report={report}
                    />
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {live?.settlement ? (
          <SettlementRow settlement={live.settlement} />
        ) : (
          !live &&
          closers.map((record) => (
            <ChainSettlement
              key={`s-${record.seq}`}
              record={record}
              store={store}
              genesis={genesisFor.get(record.seq.toString())}
            />
          ))
        )}

        {/* The card's own description already says that the record ties the two ledgers. The
            order of the payments, voucher custody and what closing an agent does are documentation,
            not four more sentences under every panel: they are in docs/ARCHITECTURE.md §7 and on
            /billing, where an operator reads them once. */}
      </div>
    </Card>
  );
}

function delta(before: string, after: string): bigint {
  try {
    const b = BigInt(before || "0");
    const a = BigInt(after || "0");
    return a > b ? a - b : BigInt(0);
  } catch {
    return BigInt(0);
  }
}

/** The genesis that opened each record's session, which names the bundle its blobs are in. */
function sessionGenesis(records: EventRecord[]): Map<string, Uint8Array> {
  const bySeq = new Map<string, Uint8Array>();
  let current: Uint8Array | undefined;
  for (const record of [...records].sort((a, b) => (a.seq < b.seq ? -1 : 1))) {
    if (record.kind === EventKind.Genesis) current = record.payloadHash;
    if (current) bySeq.set(record.seq.toString(), current);
  }
  return bySeq;
}

/**
 * The address that signed this row's vouchers, named rather than only shown.
 *
 * `unknown` is the answer whenever the console cannot prove which account it is — no rail
 * configured, the treasury route unreachable, an address that is neither the treasury nor the one
 * this agent was deployed with. In that case the address stands alone: a guess here would be a
 * claim about whose money paid, which is exactly what the reader came to check.
 */
function PayerCell({ payer, kind }: { payer: string; kind: PayerKind }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="dual-rail-payer" data-payer-kind={kind}>
      <TempoLink kind="address" value={payer} />
      {PAYER_LABEL[kind] && <span className="text-2xs text-ink-3">{PAYER_LABEL[kind]}</span>}
    </span>
  );
}

function Row({ row, describePayer }: { row: RailRow; describePayer: DescribePayer }) {
  return (
    <tr className="row-hover" data-testid="dual-rail-row" data-seq={row.seq}>
      <td className="td num text-xs text-ink-1">#{row.seq}</td>
      <td className="td font-mono text-2xs text-ink-3">{row.head ? truncate(row.head, 8, 6) : "—"}</td>
      <td className="td text-xs text-ink-2">
        {row.status ?? "on chain"}
        {/* Paid, and no answer: the gateway was paid for this call whether or not the body
            arrived, so the row stays in the table with its price and says it failed. */}
        {row.failed && (
          <span className="ml-1.5" data-testid="dual-rail-failed">
            <Badge tone="warn" title={row.failed}>
              failed after payment
            </Badge>
          </span>
        )}
      </td>
      <td className="td text-xs text-ink-2">
        {row.payer ? <PayerCell payer={row.payer} kind={describePayer(row.payer)} /> : "—"}
      </td>
      <td className="td num text-right text-xs text-ink-1" data-testid="dual-rail-delta">
        {row.delta === null ? "…" : `${formatBaseUnits(row.delta)} USDC.e`}
      </td>
      <td className="td num text-right text-xs text-ink-2">
        {typeof row.usageCost === "number" ? `$${row.usageCost.toFixed(6)}` : "—"}
      </td>
    </tr>
  );
}

/**
 * One Action of the chain: its payment is inside the result blob the record's preimage points at,
 * so two reads — the preimage, then the result. Both are memoised per hash and shared with the
 * timeline on the same page, so opening a record below costs nothing extra.
 */
function ChainRow({
  record,
  store,
  genesis,
  describePayer,
  report,
}: {
  record: EventRecord;
  store: TraceReaders | null;
  genesis?: Uint8Array;
  describePayer: DescribePayer;
  report: RowReport;
}) {
  const { payment, failed, settled } = useChainPayment(record, store, genesis);
  const key = `a-${record.seq}`;
  useEffect(() => report(key, settled ? !!payment : undefined), [report, key, settled, payment]);
  if (!payment) return null;
  return (
    <Row
      row={{
        seq: record.seq.toString(),
        head: hex(record.head),
        status: "on chain",
        delta: gatewayPrice(payment),
        usageCost: payment.usageCost,
        payer: payment.payer,
        failed,
      }}
      describePayer={describePayer}
    />
  );
}

/** The Actions an epoch batched: a loop's paid calls are all here rather than in their own rows. */
function EpochRows({
  epoch,
  store,
  describePayer,
  report,
}: {
  epoch: EpochRecord;
  store: TraceReaders | null;
  describePayer: DescribePayer;
  report: RowReport;
}) {
  const steps = useEpochSteps(store, epoch, true);
  const resolved = steps.data;
  const open = resolved?.status === "ok" && !!resolved.steps;
  // One report per epoch, folded from its steps: settled once the epoch itself resolved (or
  // failed to) and every step has reported; paid if any step was.
  const [stepReports, setStepReports] = useState<Record<string, boolean | undefined>>({});
  const stepReport = useCallback<RowReport>(
    (key, paid) => setStepReports((r) => (key in r && r[key] === paid ? r : { ...r, [key]: paid })),
    []
  );
  const key = `e-${hex(epoch.epochRoot)}`;
  const stepKeys = open ? resolved.steps!.map((s) => s.seq.toString()) : [];
  const stepsSettled = stepKeys.every((k) => stepReports[k] !== undefined);
  const paid: boolean | undefined = !steps.isFetched
    ? undefined
    : !open
    ? false
    : stepsSettled
    ? stepKeys.some((k) => stepReports[k] === true)
    : undefined;
  useEffect(() => report(key, paid), [report, key, paid]);
  if (!open) return null;
  return (
    <>
      {resolved.steps!.map((step) => (
        <EpochStepRow
          key={step.seq.toString()}
          seq={step.seq}
          payloadHash={step.input.payloadHash}
          store={store}
          describePayer={describePayer}
          report={stepReport}
        />
      ))}
    </>
  );
}

function EpochStepRow({
  seq,
  payloadHash,
  store,
  describePayer,
  report,
}: {
  seq: bigint;
  payloadHash: Uint8Array;
  store: TraceReaders | null;
  describePayer: DescribePayer;
  report: RowReport;
}) {
  const { payment, failed, settled } = usePaymentBehind(hex(payloadHash), EventKind.Action, store, undefined);
  const key = seq.toString();
  useEffect(() => report(key, settled ? !!payment : undefined), [report, key, settled, payment]);
  if (!payment) return null;
  return (
    <Row
      row={{
        seq: seq.toString(),
        status: "in epoch",
        delta: gatewayPrice(payment),
        usageCost: payment.usageCost,
        payer: payment.payer,
        failed,
      }}
      describePayer={describePayer}
    />
  );
}

function useChainPayment(record: EventRecord, store: TraceReaders | null, genesis?: Uint8Array) {
  return usePaymentBehind(hex(record.payloadHash), record.kind, store, genesis);
}

/**
 * The payment behind a payload hash: fetch the preimage, read the `result_hash` out of it at the
 * offsets `subHashes` knows, fetch that, and parse. Returns null for everything that is not a
 * paid Action — a scripted or anonymous session's records, and every older record that carries no
 * payment.
 */
function usePaymentBehind(payloadHash: string, kind: number, store: TraceReaders | null, genesis?: Uint8Array) {
  const preimage = useTracePart(store, payloadHash, true, genesis);
  const bytes = preimage.data?.status === "ok" ? preimage.data.bytes : undefined;
  const resultHash = bytes ? subHashes(kind, bytes.slice(1))[1] : undefined;
  const result = useTracePart(store, resultHash ? hex(resultHash) : null, !!resultHash, genesis);
  const resultBytes = result.data?.status === "ok" ? result.data.bytes : undefined;
  // Memoised so a settled row reports once rather than on every render with a fresh object.
  const payment = useMemo(() => (resultBytes ? paymentFromBlob(resultBytes) : null), [resultBytes]);
  // A paid call whose body never arrived is `{ error, payment }`: the payment reads the
  // same, and the error is what tells the row it is not a completion.
  const failed = useMemo(() => paidCallErrorFromBlob(resultBytes), [resultBytes]);
  // Settled when the preimage read ended without a result hash to follow, or the result read
  // ended too — whatever either returned. `null` payment before that is "not yet", after it "no".
  const settled = preimage.isFetched && (!resultHash || result.isFetched);
  return { payment, failed, settled };
}

/** How a row tells the panel what it found: `undefined` until its blobs are read, then paid or not. */
type RowReport = (key: string, paid: boolean | undefined) => void;

/** A Resolution or a `loop.settlement` Action, when its blob carries a settlement. */
function ChainSettlement({
  record,
  store,
  genesis,
}: {
  record: EventRecord;
  store: TraceReaders | null;
  genesis?: Uint8Array;
}) {
  const preimage = useTracePart(store, hex(record.payloadHash), true, genesis);
  const bytes = preimage.data?.status === "ok" ? preimage.data.bytes : undefined;
  // A Resolution's settlement is in its final-output blob (sub-hash 0); a `loop.settlement`
  // Action's is its result blob (sub-hash 1). Whichever exists is the one to read.
  const subs = bytes ? subHashes(record.kind, bytes.slice(1)) : [];
  const hash = record.kind === EventKind.Resolution ? subs[0] : subs[1];
  const blob = useTracePart(store, hash ? hex(hash) : null, !!hash, genesis);
  const settlement = blob.data?.status === "ok" ? settlementFromBlob(blob.data.bytes) : null;
  if (!settlement) return null;
  return <SettlementRow settlement={settlement} seq={record.seq.toString()} />;
}

function SettlementRow({ settlement, seq }: { settlement: TempoSettlementView; seq?: string }) {
  // The close is held against the channel and payer the settlement itself names; a settlement
  // written without a channel id stays PENDING with a title that says why.
  const receipt = useTempoReceipt(settlement.txHash ?? null, settlement.channelId, settlement.payer);
  const verdict = verdictFor(settlement, receipt.data ? receipt.data.ok : undefined);
  const badge = VERDICT_LABEL[verdict];
  return (
    <div
      className="space-y-1.5 rounded-md border border-line/[0.08] bg-line/[0.02] px-3 py-2 text-xs"
      data-testid="dual-rail-settlement"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-ink-3">payment channel settled on Tempo{seq ? ` at seq #${seq}` : ""}</span>
          <Badge tone={badge.tone} dot={verdict === "verified"} title={receipt.data?.problem ?? undefined}>
            {badge.text}
          </Badge>
          {settlement.spent && <span className="num text-ink-1">{formatBaseUnits(settlement.spent)} USDC.e</span>}
        </span>
        {settlement.txHash ? (
          <TempoLink kind="tx" value={settlement.txHash} testId="dual-rail-settlement-tx" />
        ) : (
          <span className="text-amber-300/80">{settlement.error ?? "not closed yet"}</span>
        )}
      </div>
      {settlement.channelId && (
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
          payment channel <ChannelRef channelId={settlement.channelId} />
        </div>
      )}
      {/* What the close paid, decoded from the receipt the badge already read. */}
      <CloseReceived txHash={settlement.txHash} channelId={settlement.channelId} payer={settlement.payer} />
    </div>
  );
}
