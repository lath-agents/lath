"use client";

/**
 * The loop page's Tempo side: the money flow under the budget, the open payment channel filling call by call,
 * the _Paid on Tempo_ card per service and payer with every transaction linked, the treasury's
 * balance per step, the _Check it yourself_ commands, the storage chip on each step row and _Open
 * report_. Every piece renders nothing on a loop with no Tempo payment — the vault rail, and a
 * scripted run — so those pages draw no Tempo side.
 *
 * The figures are `lib/tempo-services.ts`'s, pure functions a node suite holds
 * (`tests/loop-money-flow.ts`); this file lays them out and tags each with where it was read, since a
 * console record beside a Tempo read must not borrow Tempo's authority.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { EventKind, hashPayload, hex, toBytes32 } from "@lath/sdk/browser";
import {
  Badge,
  Button,
  Card,
  Copyable,
  EXTERNAL_LINK_CLASS,
  ExplorerLink,
  ExternalIcon,
  Facts,
  Info,
  Note,
} from "@/components/ui";
import { OpenRouterMark, TempoLink, TempoMark, tempoLinkHref } from "@/components/Tempo";
import { MoneyFlow, type MoneyFlowBox } from "@/components/MoneyFlow";
import { CommandBox } from "@/components/VerifyPanel";
import { LoopTempoKey } from "@/components/LoopTempoKey";
import { useBilling, useLath } from "@/lib/clients";
import { formatUsdc, truncate } from "@/lib/format";
import { useTracePart, type ResolvedTrace, type TraceReaders, type TraceVia } from "@/lib/traces";
import { trimUsdc } from "@/lib/tiles";
import { loopBudgetFigures } from "@/lib/loop-money";
import { TEMPO_ESCROW_ADDRESS, tempoBlockUrl, useTempoCloseDetails } from "@/lib/tempo";
import { verifyChannelCommand, verifyChargeCommand } from "@/lib/verify";
import {
  checkLoopReport,
  usdcEOfBase,
  lastPublishedReport,
  moneyFlowFigures,
  openChannelFill,
  reportFirstParagraph,
  reportHashOf,
  storageChipOf,
  tempoPayments,
  treasurySeries,
  type LoopReportAnswer,
  type LoopReportCheck,
  type TempoPaymentRow,
  type TreasuryPoint,
} from "@/lib/tempo-services";
import type { LoopStepSummary, LoopView } from "@/types/loop";

/** `0.0112`, the figure without its unit, for a line that names the unit once: _X of Y USDC.e_. */
function usdcENumber(base: bigint | string | null | undefined): string {
  const s = usdcEOfBase(base ?? undefined);
  return s ? s.replace(/ USDC\.e$/, "") : "—";
}

/** A block number as a link to its explorer page, or plain when it is not one (`tempoBlockUrl`). */
export function TempoBlockLink({ block, testId }: { block: string; testId?: string }) {
  const url = tempoBlockUrl(block);
  if (!url) return <span className="num text-ink-2">{block}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="num text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink-1"
      data-testid={testId}
      aria-label={`Block ${block} on the Tempo explorer`}
    >
      {block}
    </a>
  );
}

/**
 * The step's report as published to Tempo storage, one chip in its card's row: _publishing_ while its
 * PUT is in flight, then _report_ — a button that opens the report's first paragraph under the card
 * (`StepReport`) — with the Tempo transaction that paid it, or the
 * failure the `storage.put` record carries. What it cost is the chip's hover and the step's proof (its
 * Tempo split). The amount is the committed PUT's and is the owner's: it is the only PUT a step makes.
 */
export function StorageChip({
  loop,
  summary,
  now,
  open = false,
  onToggle,
}: {
  loop: LoopView;
  summary?: LoopStepSummary;
  now: number;
  /** Whether the report's first paragraph is open under the card. */
  open?: boolean;
  onToggle?: () => void;
}) {
  const chip = storageChipOf(summary, loop, now);
  if (!chip) return null;
  if (chip.state === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs" data-testid="step-storage" data-state="pending">
        <Badge tone="cyan" title="The step's report is being PUT to Tempo storage from the treasury, after its leaf">
          publishing report
        </Badge>
      </span>
    );
  }
  if (chip.state === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs" data-testid="step-storage" data-state="failed">
        <Badge
          tone="bad"
          title={`Tempo storage · ${chip.error}${chip.seq ? ` · recorded failed at #${chip.seq}` : ""}`}
        >
          report not published
        </Badge>
        {chip.reference && <StorageTxLink reference={chip.reference} />}
      </span>
    );
  }
  const price = usdcEOfBase(chip.amount);
  // A run whose report was written encrypted, which this console does not open: the chip says there
  // is one and opens nothing.
  if (!onToggle || !loop.plainTraces) {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs" data-testid="step-storage" data-state="published">
        <Badge tone="good">report</Badge>
        {chip.reference && <StorageTxLink reference={chip.reference} />}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs" data-testid="step-storage" data-state="published">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="step-report-open"
        title={`${open ? "Hide" : "Read"} the report's first paragraph: ${chip.bytes.toLocaleString(
          "en-US"
        )} bytes on Tempo storage${price ? ` for ${price}` : ""}, committed by the step's storage.put record${
          chip.seq ? ` at seq ${chip.seq}` : " once the next runner writes it"
        }; charged to the owner`}
        className="rounded-full transition-opacity hover:opacity-80"
      >
        <Badge tone="good">
          report <span aria-hidden>{open ? "▾" : "▸"}</span>
        </Badge>
      </button>
      {chip.reference && <StorageTxLink reference={chip.reference} />}
    </span>
  );
}

/** Where served bytes came from, in the words a reader can go and check (`TraceVia`). */
const REPORT_VIA: Record<TraceVia, string> = {
  chain: "under the locator the chain names",
  bundle: "inside the step's session bundle",
  hash: "by hash from the trace gateway",
};

/**
 * Why a step's report shows no text, one line per answer of the read (`ResolvedTrace`), because they
 * are different facts: bytes that came back and do not re-hash to the committed hash are a broken
 * commitment and say so, as a memory whose bytes differ does on the same card; a report written
 * encrypted is a dash, as every encrypted cell on this page is (no privacy wording: that is a roadmap
 * item); and a report the read found nothing for is _not served_, which on a fresh step usually means
 * its storage.put record has not landed yet. `null` when the bytes re-hashed — the text is shown then.
 */
function reportMiss(
  data: ResolvedTrace | undefined,
  error: unknown
): { text: string; tone: "bad" | "neutral"; url?: string } | null {
  if (error)
    return { text: `The report could not be read: ${(error as Error)?.message ?? String(error)}`, tone: "neutral" };
  if (!data || data.status === "ok") return null;
  if (data.status === "encrypted") return { text: "—", tone: "neutral" };
  if (data.mismatch) {
    const url = data.bundle?.url ?? data.url;
    return {
      text: `The bytes served ${
        data.via ? REPORT_VIA[data.via] : "here"
      } do not hash to the sha256 the step's storage.put record commits, so none of them is shown.`,
      tone: "bad",
      ...(url ? { url } : {}),
    };
  }
  if (data.status === "unconfigured")
    return { text: "This console has no trace store to read the report from.", tone: "neutral" };
  if (data.status === "not-anchored")
    return {
      text: "The report is not served yet: nothing on chain names its bytes, which on a fresh step means its storage.put record has not landed. Reopen it to read again.",
      tone: "neutral",
    };
  return {
    text: "The report's bytes were not served here; the chain names where they are stored, and the step's record commits their hash.",
    tone: "neutral",
    ...(data.url ? { url: data.url } : {}),
  };
}

/**
 * The first paragraph of the report a step published, opened from its card's _report_ chip: the
 * step's `storage.put` result blob, read through the agent's trace store by the hash the record commits
 * and re-hashed in this browser before a word of it is shown (`useTracePart`). Nothing but bytes that
 * matched is ever drawn; every other answer is one line saying which (`reportMiss`). The whole report,
 * checked against the chain record and read back from Tempo storage, is _Open report_ on a finished run.
 */
export function StepReport({ readers, storageKey }: { readers: TraceReaders; storageKey: string }) {
  const hash = reportHashOf(storageKey);
  const part = useTracePart(readers, hash, !!hash);
  if (!hash) return null;
  const status = part.data?.status;
  const text = status === "ok" && part.data?.bytes ? new TextDecoder().decode(part.data.bytes) : null;
  const first = text ? reportFirstParagraph(text) : "";
  // A cached miss is re-read on every open (`tracePartQuery`'s stale time), and while it is, the old
  // miss is not the answer: the line says the report is being opened instead.
  const opening = part.isLoading || (part.isFetching && status !== "ok");
  const miss = opening ? null : reportMiss(part.data, part.error);
  return (
    <div className="well px-3 py-2.5" data-testid="step-report" data-status={opening ? "opening" : status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Report</span>
        {text && (
          <Badge tone="good" title={`sha256 ${hash}, the hash the step's storage.put record commits`}>
            re-hashed in this browser
          </Badge>
        )}
        {miss?.tone === "bad" && (
          <Badge tone="bad" title={`sha256 ${hash}, the hash the step's storage.put record commits`}>
            report bytes differ
          </Badge>
        )}
      </div>
      {opening ? (
        <p className="mt-1 text-2xs text-ink-3">Opening the report…</p>
      ) : first ? (
        <p className="mt-1 text-sm leading-relaxed text-ink-1" data-testid="step-report-text">
          {first}
        </p>
      ) : miss ? (
        <p
          className={`mt-1 text-2xs ${miss.tone === "bad" ? "text-rose-300" : "text-ink-3"}`}
          data-testid="step-report-miss"
        >
          {miss.text}
          {/* The url this browser read, so a reader can fetch the same bytes and hash them without us. */}
          {miss.url && (
            <span className="mt-0.5 block">
              at <span className="num break-all text-ink-2">{miss.url}</span>
            </span>
          )}
        </p>
      ) : (
        <p className="mt-1 text-2xs text-ink-3">The report is empty.</p>
      )}
    </div>
  );
}

/** The PUT's Tempo transaction as one small mark beside the chip: no popover, which the step's details have. */
function StorageTxLink({ reference }: { reference: string }) {
  return (
    <a
      href={tempoLinkHref("tx", reference)}
      target="_blank"
      rel="noreferrer"
      aria-label={`The report's storage transaction ${truncate(reference, 6, 4)} on the Tempo explorer`}
      title="The report's storage transaction on Tempo"
      className={`${EXTERNAL_LINK_CLASS} text-2xs`}
      data-testid="step-storage-tx"
    >
      <TempoMark />
      <ExternalIcon />
    </a>
  );
}

// ─── The money flow ──────────────────────────────────────────────────────────

/**
 * The three linked boxes for one loop: the owner's cap on Solana, what Lath's
 * treasury paid on Tempo, and what OpenRouter received through its Tempo gateway.
 *
 * - **Loop Budget.** Spent of the budget in USDC, the figures the meter reads (`loopBudgetFigures`),
 *   with the billing vault as an explorer link on a billed run: it is where the debits land. The
 *   vault's address is derived from this deployment's treasury admin, so it is the page's own, not a
 *   guess; an unbilled run shows no link because nothing it did moved through the vault.
 * - **Lath treasury.** What the loop's payment channel has paid (`moneyFlowFigures`), with the
 *   treasury's address and the settlement transaction once there is one. The channel's open
 *   transaction is not recorded anywhere this page reads, so it is not offered.
 * - **OpenRouter.** Once settled, what the close paid out, decoded from the receipt in this browser
 *   (`useTempoCloseDetails`) and shown as _received_ only while the receipt check passes,
 *   with the payee linked; until then the console's figure, said as the console's. While the channel
 *   is open, the running share so far, split into the owner's model calls and Lath's decisions.
 *
 * `full` adds, on a keyed loop, the key's one linked line. No who-pays lines under the flow: the cost
 * line on the form and the Paid on Tempo card say who pays.
 */
export function LoopMoneyFlow({ loop, variant = "full" }: { loop: LoopView; variant?: "full" | "compact" }) {
  const billing = useBilling();
  const figures = loopBudgetFigures(loop);
  const flow = moneyFlowFigures(loop);
  const close = useTempoCloseDetails(flow.settleTx ?? null, flow.channelId ?? null, flow.payer ?? null);
  const full = variant === "full";
  const billed = loop.billing === "charged";

  const cap: MoneyFlowBox = {
    figure: (
      <>
        {formatUsdc(figures.spent)} <Verb>of</Verb> {trimUsdc(figures.budget)} USDC <Verb>spent</Verb>
      </>
    ),
    // A few words under each figure: the box's title already names
    // the chain, and the links say where to look.
    sub: billed ? "from your allowance" : "not billed: no live allowance, nothing is debited",
    links: billed
      ? [
          <ExplorerLink key="vault" kind="address" value={billing.vaultAddress().toBase58()}>
            escrow
          </ExplorerLink>,
        ]
      : [],
  };

  const paid = flow.channelPaid === null ? null : usdcEOfBase(flow.channelPaid);
  const treasury: MoneyFlowBox = {
    figure: flow.scripted ? (
      "not paid (scripted)"
    ) : paid ? (
      <>
        {paid} <Verb>paid</Verb>
      </>
    ) : (
      "—"
    ),
    sub: flow.scripted
      ? "no model key was accepted, so the steps ran on fixtures"
      : flow.state === "open"
      ? `on a payment channel open since step ${flow.openedAtStep}`
      : flow.state === "settled"
      ? "settled on Tempo"
      : paid
      ? "the steps' recorded payments"
      : "no model call paid on Tempo yet",
    links: [
      ...(flow.payer
        ? [<TempoLink key="payer" kind="address" value={flow.payer} label="treasury" testId="money-flow-payer" />]
        : []),
      ...(flow.settleTx
        ? [<TempoLink key="settled" kind="tx" value={flow.settleTx} label="settled" testId="money-flow-settlement" />]
        : []),
    ],
    // The key that signed this box's payments, in the box rather than a line under all three: it is the
    // treasury's key for this loop, so it belongs with the treasury.
    extra: full && loop.tempoKey ? <LoopTempoKey loop={loop} /> : undefined,
  };

  const details = close.data?.ok === true ? close.data.details : null;
  const openrouter: MoneyFlowBox =
    flow.state === "settled"
      ? details
        ? {
            figure: (
              <>
                {usdcEOfBase(details.finalAmountBase)} <Verb>received</Verb>
              </>
            ),
            // Three words; the refund the close sent back is behind the payee's ⓘ.
            sub: <span data-testid="money-flow-checked">checked in this browser</span>,
            links: [
              <TempoLink
                key="payee"
                kind="address"
                value={details.payee}
                label="payee"
                testId="money-flow-payee"
                details={
                  <p className="text-2xs leading-relaxed text-ink-3" data-testid="money-flow-refund">
                    The close&apos;s receipt, read from Tempo in this browser: OpenRouter received{" "}
                    {usdcEOfBase(details.finalAmountBase)}
                    {details.refundBase !== "0"
                      ? ` and ${usdcEOfBase(details.refundBase)} went back to the treasury`
                      : ", and nothing was left to refund"}
                    .
                  </p>
                }
              />,
            ],
          }
        : {
            figure: paid ? (
              <>
                {paid} <Verb>settled</Verb>
              </>
            ) : (
              "settled"
            ),
            sub: close.isLoading
              ? "reading Tempo's receipt in this browser…"
              : `the console's record; ${close.data?.problem ?? "Tempo's receipt was not read"}`,
          }
      : flow.state === "open"
      ? {
          figure: paid ? (
            <>
              {paid} <Verb>so far</Verb>
            </>
          ) : (
            "—"
          ),
          sub: `your model calls ${usdcENumber(flow.model)} · Lath's decisions ${usdcENumber(flow.decisions)} USDC.e`,
          links: [
            <TempoLink
              key="escrow"
              kind="address"
              value={TEMPO_ESCROW_ADDRESS}
              label="in escrow"
              details={<ChannelIdFact channelId={flow.channelId} />}
            />,
          ],
        }
      : {
          figure: flow.scripted ? (
            "not paid (scripted)"
          ) : paid ? (
            <>
              {paid} <Verb>paid</Verb>
            </>
          ) : (
            "—"
          ),
          sub: flow.scripted ? "nothing reached OpenRouter" : paid ? "no settlement recorded" : "nothing paid yet",
        };

  return (
    <div className="space-y-2">
      <MoneyFlow variant={variant} live={loop.stepping} cap={cap} treasury={treasury} openrouter={openrouter} />
    </div>
  );
}

/** A box figure's word after its amount, in the quiet weight, so the three boxes read alike. */
function Verb({ children }: { children: ReactNode }) {
  return <span className="font-normal text-ink-3">{children}</span>;
}

function ChannelIdFact({ channelId }: { channelId?: string }) {
  return (
    <>
      {channelId && (
        <Facts
          items={[{ label: "channel", value: <Copyable value={channelId} display={truncate(channelId, 8, 6)} /> }]}
        />
      )}
      <p className="text-2xs leading-relaxed text-ink-3">
        A payment channel: funds locked in Tempo&apos;s escrow contract. The channel id is a bytes32 inside it, not an
        address of its own, so the escrow&apos;s page is where its opened and closed events are. Closing it pays
        OpenRouter and refunds the rest.
      </p>
    </>
  );
}

// ─── The open channel ────────────────────────────────────────────────────────

/**
 * _Payment channel open since step k · X of Y USDC.e used_, with a bar that moves on each poll while
 * a step pays. Hidden when no channel is open. The used figure is the console's record and the
 * deposit Tempo's escrow as read after a step, and each is tagged so (`openChannelFill`).
 */
export function OpenChannel({ loop }: { loop: LoopView }) {
  const fill = openChannelFill(loop);
  if (!fill) return null;
  const pct = fill.fraction === null ? null : Math.round(fill.fraction * 100);
  return (
    <div className="well space-y-2 px-4 py-3" data-testid="open-channel">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
        <TempoMark />
        <span className="text-ink-1">Payment channel open since step {fill.openedAtStep}</span>
        <span className="text-ink-3">·</span>
        <span className="num" data-testid="open-channel-used">
          <span className="text-ink-1">{usdcENumber(fill.usedBase)}</span>
          {fill.deposit ? (
            <>
              <span className="text-ink-3"> of </span>
              <span className="text-ink-1">{usdcENumber(fill.depositBase)}</span>
            </>
          ) : null}{" "}
          USDC.e used
        </span>
        <Info label="Where the channel's figures come from" wide>
          <Facts
            items={[
              {
                label: "used",
                value: fill.used,
                source: "console",
                title: "the cumulative after the last paid call, the console's record of the vouchers it signed",
              },
              ...(fill.deposit
                ? [
                    {
                      label: "deposit",
                      value: fill.deposit,
                      source: "tempo" as const,
                      title: "what Tempo's escrow held for the channel when the console read it",
                    },
                  ]
                : []),
              ...(fill.settledBase !== null
                ? [{ label: "settled so far", value: usdcEOfBase(fill.settledBase), source: "tempo" as const }]
                : []),
              ...(fill.depositBlock
                ? [
                    {
                      label: "read at block",
                      value: <TempoBlockLink block={fill.depositBlock} />,
                      source: "tempo" as const,
                    },
                  ]
                : []),
            ]}
          />
          <p className="text-2xs leading-relaxed text-ink-3">
            Each call&apos;s payment is a signed voucher on the channel, and the difference between two vouchers is the
            call&apos;s price. The deposit is read from Tempo after each step
            {fill.depositOfStep !== undefined ? ` (last after step ${fill.depositOfStep})` : ""}; the used figure moves
            with every call the console pays.
          </p>
        </Info>
        <TempoLink
          kind="address"
          value={TEMPO_ESCROW_ADDRESS}
          label="in escrow"
          testId="open-channel-escrow"
          details={<ChannelIdFact channelId={fill.channelId} />}
        />
      </div>
      {pct !== null && (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-line/[0.08]"
          role="meter"
          aria-label="payment channel deposit used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          data-testid="open-channel-bar"
        >
          <div className="h-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

// ─── Paid on Tempo ───────────────────────────────────────────────────────────

const ROW_LABEL: Record<TempoPaymentRow["id"], ReactNode> = {
  model: (
    <>
      <OpenRouterMark /> OpenRouter via Tempo
    </>
  ),
  jev: "Decision model",
  trace: "Trace audit",
  storage: "Tempo storage",
  rpc: "Tempo RPC",
};

const ROW_HINT: Record<TempoPaymentRow["id"], string> = {
  model:
    "Your agent's model calls, each paid to OpenRouter's Tempo gateway with Tempo's Machine Payments Protocol and debited to you in USDC on Solana.",
  jev: "The decision model that judges each step: paid by Lath on the same channel, and charged to nobody.",
  trace: "The decision model's trace audit of each step: paid by Lath on the same channel, and charged to nobody.",
  storage: "Each step's report, PUT to Tempo storage: paid by the treasury and debited to you in USDC on Solana.",
  rpc: "Lath's paid Tempo RPC session for the loop's reads. It buys nothing the free endpoint does not serve; Lath pays it.",
};

/**
 * The _Paid on Tempo_ card: one row per service, who it is billed to, the amount in USDC.e and each
 * transaction linked; behind its ⓘ, the read and close blocks linked and the treasury's balance per
 * step; and the two commands that check it all without this page. Nothing on a loop with no Tempo
 * payment.
 */
export function TempoPaymentsCard({ loop }: { loop: LoopView }) {
  const payments = tempoPayments(loop);
  if (!payments) return null;
  const points = treasurySeries(loop);
  return (
    <div data-testid="tempo-payments">
      {/* Folded by default; its ⓘ sits on the right, since the
        title is the fold's button and a button cannot hold another. */}
      <Card
        id="tempo"
        tone="cyan"
        collapsible={{ testId: "tempo-payments-card" }}
        title={
          <span className="inline-flex items-center gap-1.5">
            <TempoMark /> Tempo
          </span>
        }
        right={
          <Info label="What the Tempo card shows" wide testId="tempo-payments-info">
            <div className="space-y-2">
              <p className="text-xs leading-relaxed text-ink-2">
                Lath&apos;s treasury pays each of this loop&apos;s services on Tempo, from one balance. Each row says
                whose cost it is, what it came to in USDC.e and the Tempo transactions that paid it. USDC.e on Tempo is
                a different token on a different chain from your USDC on Solana, so the two are never added.
              </p>
              {/* The blocks the figures were read and settled at, and the treasury's balance per step, behind
                this ⓘ rather than as the card's footer: they are where the
                rows come from, read on request, and _Check it yourself_ stays in the card. */}
              {(payments.readBlock || payments.closeBlock) && (
                <div className="space-y-1 text-2xs text-ink-3">
                  {payments.readBlock && (
                    <p data-testid="tempo-read-block">
                      read from Tempo at block <TempoBlockLink block={payments.readBlock.block} /> (after step{" "}
                      {payments.readBlock.ofStep})
                    </p>
                  )}
                  {payments.closeBlock && (
                    <p data-testid="tempo-close-block">
                      settled at block <TempoBlockLink block={payments.closeBlock} />
                      {loop.tempo?.txHash && (
                        <>
                          {" "}
                          · <TempoLink kind="tx" value={loop.tempo.txHash} />
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}
              {points.length > 0 && <TreasurySparkline points={points} />}
            </div>
          </Info>
        }
      >
        <div className="space-y-4">
          <ul className="divide-y divide-line/[0.06] text-xs" data-testid="loop-tempo-services">
            {payments.rows.map((r) => (
              <PaymentRow key={r.id} row={r} />
            ))}
          </ul>
          {/* _Check it yourself_ is in the Tempo box at the top of the page, beside the figure it checks
              (`LoopRails`), not in this card. */}
        </div>
      </Card>
    </div>
  );
}

function PaymentRow({ row }: { row: TempoPaymentRow }) {
  const testId = `tempo-line-${row.id}`;
  // A paid model call with no settlement yet is still paid: the vouchers are signed. The row says
  // _not settled yet_ rather than offering a link to nothing.
  const shown = row.txs.slice(0, 4);
  const more = row.txs.length - shown.length;
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0" data-testid={testId}>
      <span className="inline-flex w-44 flex-none items-center gap-1.5 text-ink-1">
        {ROW_LABEL[row.id]}
        <Info label={`About ${row.id === "model" ? "OpenRouter via Tempo" : String(ROW_LABEL[row.id])}`}>
          <p className="text-xs leading-relaxed text-ink-2">{ROW_HINT[row.id]}</p>
        </Info>
      </span>
      <Badge
        tone={row.payer === "owner" ? "blue" : "neutral"}
        title={row.payer === "owner" ? "billed to you" : "Lath's cost, billed to nobody"}
      >
        {row.payer === "owner" ? "yours" : "Lath's"}
      </Badge>
      <span className="num w-28 text-ink-1">{row.amount ?? "—"}</span>
      <span className="text-2xs text-ink-3">{row.note}</span>
      {shown.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {shown.map((t) => (
            <TempoLink key={`${t.kind}-${t.hash}`} kind="tx" value={t.hash} label={t.label} testId={`${testId}-tx`} />
          ))}
          {more > 0 && <span className="text-2xs text-ink-3">and {more} more</span>}
        </span>
      )}
    </li>
  );
}

/**
 * The treasury's USDC.e after each step, one point per step, as the console read it from
 * Tempo. A 2 px line in the accent, a dot on the last read, the first and last figures as text and
 * the whole series as a table in the `Info`, so nothing is told by the line alone. One point draws
 * no line, only its figure.
 */
export function TreasurySparkline({ points }: { points: TreasuryPoint[] }) {
  const W = 120;
  const H = 28;
  const pad = 4;
  const values = points.map((p) => Number(p.usdcEBase));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xy = points.map((p, i) => {
    const x = points.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (points.length - 1);
    const y = max === min ? H / 2 : pad + ((max - Number(p.usdcEBase)) * (H - 2 * pad)) / span;
    return [x, y] as const;
  });
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <div className="flex flex-wrap items-center gap-3 text-2xs text-ink-3" data-testid="tempo-treasury-sparkline">
      {points.length > 1 && (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={`The treasury's balance after steps ${first.step} to ${last.step}: from ${usdcEOfBase(
            first.usdcEBase
          )} to ${usdcEOfBase(last.usdcEBase)}`}
          className="flex-none text-accent"
        >
          <polyline
            points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r={3} fill="currentColor" />
        </svg>
      )}
      <span>
        the treasury&apos;s balance, read from Tempo at each step:{" "}
        {points.length > 1 && (
          <>
            <span className="num text-ink-2">{usdcENumber(first.usdcEBase)}</span> after step {first.step} →{" "}
          </>
        )}
        <span className="num text-ink-2">{usdcEOfBase(last.usdcEBase)}</span> after step {last.step}
      </span>
      <Info label="The treasury's balance at each step" wide>
        <table className="w-full text-2xs">
          <thead>
            <tr className="text-ink-3">
              <th className="pb-1 text-left font-normal">step</th>
              <th className="pb-1 text-left font-normal">block</th>
              <th className="pb-1 text-right font-normal">USDC.e</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.step}>
                <td className="num py-0.5 text-ink-2">{p.step}</td>
                <td className="py-0.5">{p.block ? <TempoBlockLink block={p.block} /> : "—"}</td>
                <td className="num py-0.5 text-right text-ink-1">{usdcENumber(p.usdcEBase)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-2xs text-ink-3">
          The whole treasury, which pays every loop of this deployment: other loops&apos; payments move it too.
        </p>
      </Info>
    </div>
  );
}

/**
 * _Check it yourself_: the two `lath-audit` lines that hold this loop's Tempo payments to
 * Tempo without this page — every channel's vouchers against what its close paid out, and every
 * storage payment against its transfer — each copyable, with the sentence of what it checks.
 */
export function TempoCheckItYourself({ loop }: { loop: LoopView }) {
  const keyed = !!loop.tempoKey;
  const payer = loop.tempo?.payer ?? loop.channel?.payer ?? null;
  const channel = verifyChannelCommand(loop.agentName, { key: keyed, payer });
  const charge = verifyChargeCommand(loop.agentName, { payer });
  const anyStorage = loop.history.some((h) => !!h.tempoStorage?.reference);
  return (
    <details className="group" data-testid="tempo-check-yourself">
      <summary className="cursor-pointer list-none text-xs text-ink-2 underline decoration-line/20 underline-offset-[3px] hover:text-ink-1">
        Check it yourself <span aria-hidden>▸</span>
      </summary>
      <div className="mt-2 space-y-3">
        <div className="space-y-1">
          <p className="text-2xs leading-relaxed text-ink-3">{channel.checks}</p>
          <CommandBox command={channel.command} testId="tempo-check-channel" />
        </div>
        {anyStorage && (
          <div className="space-y-1">
            <p className="text-2xs leading-relaxed text-ink-3">{charge.checks}</p>
            <CommandBox command={charge.command} testId="tempo-check-charge" />
          </div>
        )}
      </div>
    </details>
  );
}

// ─── The report ──────────────────────────────────────────────────────────────

async function subtleSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

/**
 * A finished run's report as _Open report_ shows it: the console's copy, re-hashed in this browser and
 * held to the `storage.put` record on the agent's chain. The goal line's summary reads it the same way,
 * so it shows nothing this check has not passed.
 */
async function readCheckedReport(
  loop: Pick<LoopView, "id" | "agentId">,
  lath: ReturnType<typeof useLath>
): Promise<{ answer: LoopReportAnswer; check: LoopReportCheck }> {
  const res = await fetch(`/api/loops/${encodeURIComponent(loop.id)}/report`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `the console answered ${res.status}`);
  const answer = body as LoopReportAnswer;
  // `null` only when the chain holds no record at that seq, which the check calls `no-record`; a
  // read that failed throws to the caller, which says so rather than giving that verdict.
  const record = await lath.getEvent(toBytes32(loop.agentId), BigInt(answer.seq));
  const check = await checkLoopReport(answer, {
    digest: subtleSha256,
    payloadHashOf: (p) =>
      hex(
        hashPayload({
          kind: EventKind.Action,
          toolId: p.toolId,
          argsHash: toBytes32(p.argsHash),
          resultHash: toBytes32(p.resultHash),
          statusCode: p.statusCode,
        })
      ),
    record: record ? { payloadHash: hex(record.payloadHash) } : null,
  });
  return { answer, check };
}

/**
 * Under the goal line of a finished run: the answer in one sentence, then the button that opens the
 * whole answer in a tab of its own. The sentence is the report's first line, which a goal that asks
 * for a summary puts there, and it shows only once the report has passed the same check as _Open
 * report_; the button shows either way, since the page it opens says what the check found.
 */
export function AnswerSummary({ loop }: { loop: LoopView }) {
  const report = lastPublishedReport(loop.history);
  const lath = useLath();
  const opens = !!report && loop.status !== "running" && !!loop.plainTraces;
  const read = useQuery({
    queryKey: ["loop-report", loop.id, report?.hash],
    enabled: opens,
    staleTime: Infinity,
    retry: 1,
    queryFn: () => readCheckedReport(loop, lath),
  });
  if (!opens) return null;
  const check = read.data?.check;
  const summary = check?.verdict === "ok" ? summaryOf(check.text) : null;
  const put = loop.history.find((h) => h.step === report?.step)?.tempoStorage?.reference;
  return (
    <div className="mt-2 space-y-2" data-testid="loop-answer-summary">
      {summary && (
        <p className="text-sm leading-relaxed text-ink-1" data-testid="loop-answer-summary-text">
          {summary}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={`/loop/${encodeURIComponent(loop.id)}/report`}
          target="_blank"
          rel="noreferrer"
          data-testid="loop-goal-answer"
          className="inline-flex h-7 select-none items-center gap-1 whitespace-nowrap rounded-lg border border-line/[0.12] bg-surface-3 px-2.5 text-xs font-semibold text-ink-1 transition-colors hover:border-line/[0.2] hover:bg-surface-3/80"
        >
          Read the answer
          <ExternalIcon />
        </a>
        {/* The answer itself lives on Tempo storage, written by a paid MPP call; the write is its proof. */}
        {put && <TempoLink kind="tx" value={put} label="Stored on Tempo storage" testId="loop-answer-stored" />}
      </div>
    </div>
  );
}

/**
 * The answer a report opens with, in at most two sentences: its first paragraph that is not a heading,
 * without a bold label such as _Answer:_ and without Markdown's marks, so the line reads as prose under
 * the goal line. An agent asked to open with the answer may still put a title above it. Only a label
 * that names itself as one is cut, since an answer may open with a clause that ends in a colon.
 */
export function summaryOf(text: string): string | null {
  const paragraph = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#"));
  if (!paragraph) return null;
  const prose = paragraph
    .replace(/^\*\*[^*]{1,60}?:\*\*\s*/, "")
    .replace(/^(?:Answer|Short answer|Summary)\b[^:]{0,24}:\s+/i, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = prose.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const two = sentences.slice(0, 2).join(" ");
  return two.length <= 480 ? two : `${two.slice(0, 479)}…`;
}

type Opened =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "checked"; answer: LoopReportAnswer; check: LoopReportCheck };

/**
 * _Open report_, on a finished loop that published one. The console fetches it — only the treasury
 * can read Tempo storage — and this browser re-hashes the bytes and rebuilds the step's
 * `storage.put` record against the chain before a word of it is shown. The PUT that stored it and,
 * when the console had to read it back from Tempo, the read it paid for are both Tempo transactions,
 * linked.
 */
export function OpenReport({ loop, autoOpen = false }: { loop: LoopView; autoOpen?: boolean }) {
  const report = lastPublishedReport(loop.history);
  const lath = useLath();
  const [opened, setOpened] = useState<Opened>({ state: "idle" });
  // A run whose report was written encrypted, which this console does not open: no block at all,
  // since privacy is a roadmap item.
  const opens = !!report && loop.status !== "running" && !!loop.plainTraces;

  const open = async () => {
    setOpened({ state: "loading" });
    try {
      const { answer, check } = await readCheckedReport(loop, lath);
      setOpened({ state: "checked", answer, check });
    } catch (e) {
      setOpened({ state: "error", error: String((e as any)?.message ?? e) });
    }
  };

  // The answer page (`/loop/<id>/report`) exists to show the note, so it opens the report on arrival
  // rather than behind a second click; the re-hash against the chain's record runs all the same.
  useEffect(() => {
    if (autoOpen && opens && opened.state === "idle") void open();
  }, [autoOpen, opens]);

  if (!report || !opens) return null;
  const put = loop.history.find((h) => h.step === report.step)?.tempoStorage?.reference;

  return (
    <div className="well space-y-2 px-3 py-2.5 text-xs" data-testid="loop-report">
      {/* One short line, the hash and the PUT behind its ⓘ:
        what a reader wants first is whose report this is and where it lives. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Report</span>
        <span className="text-2xs text-ink-3">step {report.step}&apos;s, stored on Tempo</span>
        <Info label="Where the report is and what commits it">
          <div className="space-y-1.5 text-2xs leading-relaxed text-ink-2">
            <p>
              Committed as sha256 <Copyable value={report.hash} display={truncate(report.hash, 8, 6)} />
              {report.seq ? ` by its storage.put record at seq ${report.seq}` : ""}.
            </p>
            {put && (
              // The words are the link: _Stored on Tempo by this PUT_ would name an HTTP verb a reader need
              // not know, and the transaction is one click either way.
              <p className="inline-flex items-center gap-1">
                <TempoLink kind="tx" value={put} label="Stored on Tempo" testId="loop-report-put-tx" />
              </p>
            )}
          </div>
        </Info>
      </div>
      {opened.state === "checked" ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={open}
            loading={opened.state === "loading"}
            testId="loop-report-open"
          >
            Open report
          </Button>
          <Info label="How the report is opened">
            <p className="text-xs leading-relaxed text-ink-2">
              The console hands over the copy it keeps of what the step stored, or reads it back from Tempo storage, and
              this browser re-hashes it against the chain&apos;s record before showing it.
            </p>
          </Info>
        </div>
      )}
      {opened.state === "error" && (
        <Note tone="warn">
          <span data-testid="loop-report-error">The report was not opened: {opened.error}</span>
        </Note>
      )}
      {opened.state === "checked" && <CheckedReport answer={opened.answer} check={opened.check} />}
    </div>
  );
}

function CheckedReport({ answer, check }: { answer: LoopReportAnswer; check: LoopReportCheck }) {
  if (check.verdict !== "ok") {
    const why =
      check.verdict === "bytes-mismatch"
        ? `the bytes Tempo storage answered hash to ${truncate(check.hash, 8, 6)}, and the step committed ${truncate(
            check.want,
            8,
            6
          )} — ${answer.fetchedKey} does not hold the committed report`
        : check.verdict === "no-record"
        ? `the chain's indexer has no record at seq ${answer.seq} to check it against yet`
        : `the record at seq ${answer.seq} is not the storage.put these hashes rebuild`;
    return (
      <div
        className="rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2.5 text-xs text-rose-200"
        data-testid="loop-report-refused"
        data-verdict={check.verdict}
      >
        Not shown: {why}. Nothing on this page was taken from it.
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="loop-report-verified">
      <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-3">
        <Badge tone="good" title={check.hash}>
          re-hashed in this browser
        </Badge>
        {/* One sentence, the particulars behind the ⓘ. */}
        <span>It matches the hash committed on Solana.</span>
        <Info label="How this report was checked">
          <div className="space-y-1.5 text-2xs leading-relaxed text-ink-2">
            <p>
              {answer.path} · {answer.size.toLocaleString("en-US")} bytes · sha256 {truncate(check.hash, 8, 6)} matches
              the storage.put at seq {answer.seq}.
            </p>
            <p>
              {answer.from === "store"
                ? "The console's own copy of what the step stored on Tempo, checked by this browser"
                : `Fetched by the console from ${answer.fetchedKey}`}
              {answer.payment ? `, a ${usdcEOfBase(answer.payment.amount)} read paid by Lath` : ""}.
            </p>
            {answer.payment?.reference && (
              <TempoLink kind="tx" value={answer.payment.reference} label="the read" testId="loop-report-read-tx" />
            )}
          </div>
        </Info>
      </div>
      <pre
        className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded border border-line/[0.08] bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-1"
        data-testid="loop-report-text"
      >
        {check.text}
      </pre>
    </div>
  );
}
