"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { Badge, Card, Copyable, Empty, ErrorNote, ExplorerLink, PageHeader, Skeleton } from "@/components/ui";
import { TempoLink } from "@/components/Tempo";
import { DepositForm } from "@/components/DepositForm";
import { SpendChart } from "@/components/SpendChart";
import { useBilling } from "@/lib/clients";
import { NO_REFUND_LINE, formatBaseUnits, useTempoTreasury } from "@/lib/tempo";
import { config } from "@/lib/config";
import { e2eWalletPublicKey } from "@/lib/e2e-wallet";
import { formatTimestampSecs, formatUsdc, shortKey } from "@/lib/format";
import { spendable, useBalance, useChargeHistory, useTreasury } from "@/lib/queries";
import { useDeployedAgents } from "@/lib/market";

/** Tempo mainnet's chain id, as `_lib/tempo.ts` `TEMPO_CHAIN_ID` pins it server-side (a page cannot import that file). */
const TEMPO_MAINNET_CHAIN_ID = 4217;

/** The page's chips, one more than the vault popover's: the page has the width for 250. */
const PRESETS = ["5.00", "25.00", "100.00", "250.00"];

/**
 * The operator's two balances, side by side: what the escrow vault on Solana has collected and
 * may be swept out of it, and what the Tempo treasury — the account that signs every voucher —
 * has left to pay the gateway with.
 *
 * They are on this page because this page is where money is accounted for, and they are labelled
 * as the operator's because they are not the reader's: the figures above are the visitor's own
 * escrow, and nothing here is theirs to spend or withdraw.
 *
 * The point of showing them together is the float. Users pay in USDC on Solana; the model is paid
 * in USDC.e on Tempo; no route moves one into the other, so the operator moves it by hand. A
 * reader who is told that the two ledgers are separate can read the gap between these two numbers
 * for themselves, which a panel that showed only one of them would deny them.
 *
 * The open-channel count is what *this process* holds open, not a chain read, because a channel is
 * opened per session by this console and another console against the same treasury is unsupported;
 * saying so beside the number keeps it from reading as a global truth.
 */
function OperatorFloatPanel({ sweepable }: { sweepable: bigint | null }) {
  const treasury = useTempoTreasury();
  const t = treasury.data;
  const address = t?.enabled ? t.address : undefined;
  // Three answers, and each gets its own sentence. `enabled: false` is the route saying no
  // treasury is configured; `unreachable` is this page failing to ask, and a thrown query is the
  // same — neither establishes anything about the deployment, so neither may read as *no
  // treasury configured*. The test ids are what tempo-rail.spec.ts reads.
  const unreachable = t?.unreachable ?? (treasury.isError ? String((treasury.error as Error)?.message ?? "") : null);
  return (
    <Card
      title="The operator's float"
      description="Not your money. Your USDC is escrowed on Solana and metered there; the model is paid in USDC.e on Tempo, from the treasury below. These are the two ends of that float."
      right={
        // The network by name, its id for whoever checks it: a bare chain id is a number to look up.
        t?.enabled ? (
          <Badge tone="neutral" title={`Tempo chain id ${t.chainId}`}>
            {t.chainId === TEMPO_MAINNET_CHAIN_ID ? "Tempo mainnet" : `Tempo chain ${t.chainId}`}
          </Badge>
        ) : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2" data-testid="operator-float">
        <div className="space-y-1" data-testid="operator-vault">
          <div className="text-2xs uppercase tracking-wide text-ink-3">Escrow vault, Solana</div>
          {/* An unread figure is said as a muted sentence, never set in the figure's type as if the
              words were the number. tempo-rail.spec.ts reads the words. */}
          <div
            className={sweepable === null ? "text-sm text-ink-3" : "num text-lg text-ink-1"}
            data-testid="operator-vault-sweepable"
          >
            {sweepable === null ? "could not be read" : `${formatUsdc(sweepable)} USDC`}
          </div>
          <p className="text-2xs leading-relaxed text-ink-3">
            metered from users and not yet swept (<span className="font-mono">total_spent − total_swept</span>); the
            rest of the vault is depositors&apos; money
          </p>
        </div>
        <div className="space-y-1" data-testid="tempo-operator">
          <div className="text-2xs uppercase tracking-wide text-ink-3">Tempo treasury, USDC.e</div>
          <div
            className={
              !treasury.isLoading && t?.enabled && t.balanceBase !== null && t.balanceBase !== undefined
                ? "num text-lg text-ink-1"
                : "text-sm text-ink-3"
            }
            data-testid="tempo-operator-balance"
          >
            {treasury.isLoading
              ? "reading…"
              : t?.enabled && t.balanceBase !== null && t.balanceBase !== undefined
              ? formatBaseUnits(t.balanceBase)
              : "could not be read"}
          </div>
          <p className="text-2xs leading-relaxed text-ink-3">
            {treasury.isLoading ? (
              "reading…"
            ) : unreachable !== null ? (
              `the treasury route did not answer${
                unreachable ? ` (${unreachable})` : ""
              }; whether this deployment has a Tempo treasury is unknown`
            ) : address ? (
              <>
                {/* The full address as the label, so the reader sees which account the route answered
                    for and the link's name carries it (tempo-rail.spec.ts finds the link by it). */}
                <TempoLink kind="address" value={address} label={address} full testId="tempo-operator-address" /> ·{" "}
                <span data-testid="tempo-operator-channels" className="num">
                  {t?.openChannels ?? 0}
                </span>{" "}
                channels open from this console process
              </>
            ) : (
              "this deployment has no Tempo treasury configured, so no call can be billed: every session runs the scripted transport"
            )}
            {t?.balanceError ? ` · the Tempo RPC did not answer: ${t.balanceError}` : ""}
          </p>
        </div>
      </div>
      <p className="mt-3 max-w-prose text-2xs leading-relaxed text-ink-3" data-testid="operator-float-note">
        Nothing moves the left figure into the right one automatically: no USDC route between Solana and Tempo exists
        today, so the operator withdraws from the vault and funds the treasury <strong>by hand</strong>. Your cap and
        your debit are the Solana side and are unaffected by it. {NO_REFUND_LINE}
      </p>
    </Card>
  );
}

/**
 * The Activity table's Agent cell: the agent's name, linked to its page, when the console's
 * registry knows the authority; otherwise the short authority, linked to `/authority/<key>`. A
 * deposit names no authority and gets a dash.
 */
function AgentCell({
  authority,
  agents,
}: {
  authority: PublicKey | null;
  agents: Map<string, { id: string; name: string }>;
}) {
  if (!authority) return <>—</>;
  const key = authority.toBase58();
  const agent = agents.get(key);
  return agent ? (
    <Link href={`/agent/${agent.id}`} className="link" title={`authority ${key}`} data-testid="billing-agent">
      {agent.name}
    </Link>
  ) : (
    <Link href={`/authority/${key}`} className="link-mono" title={key} data-testid="billing-authority">
      {shortKey(key)}
    </Link>
  );
}

export default function BillingPage() {
  const { publicKey } = useWallet();
  /**
   * The operator's float is the operator's: shown to the treasury admin's wallet, and to the devnet
   * E2E keypair, whose runs — the specs and the recorded demo — are the operator's own and read these
   * figures. Every other wallet's page is about its own money only, and a panel that opened with
   * *Not your money* would be noise to them. The E2E wallet is matched by its public key, not by the
   * adapter's name, which any wallet may call itself.
   */
  const e2eKey = e2eWalletPublicKey();
  const operatorView =
    !!publicKey && (publicKey.equals(config.treasuryAdmin) || (!!e2eKey && publicKey.equals(e2eKey)));
  const billing = useBilling();

  const treasury = useTreasury();
  const history = useChargeHistory(publicKey ?? null);
  const balance = useBalance(publicKey ?? null);
  // A charge row names the authority that metered it, which is a key and not an agent to a reader.
  // The console's registry maps it back to the agent this console deployed under it, so the row says
  // _agent1_ and links its page. An authority it does not know —
  // an agent another console deployed, or one archived out of the list — keeps its short key, linked
  // to `/authority/<key>`, which finds the agents behind it on chain.
  const deployed = useDeployedAgents();
  const agentByAuthority = useMemo(
    () => new Map((deployed.data ?? []).map((a) => [a.authority, { id: a.id, name: a.name }] as const)),
    [deployed.data]
  );

  // What the operator may sweep out of the vault, which is the left half of the float panel below:
  // `total_spent − total_swept`, the same figure `BillingClient.sweepable()` computes. A treasury
  // account that did not read is null rather than zero — an unread balance is not an empty one.
  const sweepable = treasury.data ? treasury.data.totalSpent - treasury.data.totalSwept : null;

  // Every page sits behind `WalletGate`, so a page without a wallet is never mounted, and this page
  // has no no-wallet branch of its own. This only narrows the type.
  if (!publicKey) return null;

  return (
    <div className="space-y-8">
      {/* One line: what the page is. That the vault is
          deposit-only is said once, in the Deposit card, where the money is about to move. */}
      <PageHeader
        eyebrow={<span>Escrow vault</span>}
        title="Billing"
        description="The USDC your agents spend, escrowed on Solana under your own balance account."
      />

      {/* No balance tiles (Spendable, Deposited, Spent, Reserved): they are the vault popover's
          figures, and the popover is one click from every page. What is here is what only this page
          has. */}
      {/* `items-start`: the Deposit card is as tall as its form rather than stretched to the chart's
          height, which would leave it half empty. What you hold in the vault leads it, since that is the figure
          a deposit changes. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card
          title="Deposit into the vault"
          description="One-way: the vault has no withdrawal, so deposit what your agents will spend."
        >
          <div className="space-y-4">
            <div data-testid="billing-vault-balance">
              <div className="eyebrow">In the vault</div>
              <div className="num mt-1 text-lg font-semibold text-ink-1">
                {balance.isLoading ? (
                  <span className="text-sm font-normal text-ink-3">reading…</span>
                ) : balance.isError ? (
                  // An unread balance is not an empty one: said as a muted sentence, never as 0.
                  <span className="text-sm font-normal text-ink-3">could not be read</span>
                ) : (
                  <>
                    {formatUsdc(spendable(balance.data))}{" "}
                    <span className="text-sm font-normal text-ink-3">USDC spendable</span>
                  </>
                )}
              </div>
            </div>
            <DepositForm presets={PRESETS} testId="billing-deposit" />
          </div>
        </Card>

        <Card title="Spend by day" description="Metered charges from recent balance transactions, last 14 days.">
          {history.isLoading ? (
            <Skeleton rows={4} />
          ) : history.isError ? (
            // Never the empty state on a failed read: a balance that says it has spent, over a
            // chart that says nothing ever happened, is the one thing this page must not say.
            // The balance is account state and stands; this is a replay that failed.
            <ErrorNote>
              The charge history could not be read from the RPC, so this chart is empty rather than zero. Your balance,
              in the vault pill, is read from the account itself and is unaffected.
            </ErrorNote>
          ) : (
            <SpendChart activity={history.data ?? []} />
          )}
        </Card>
      </div>

      <Card
        title="Activity"
        // No parenthesis on withdrawals made before the vault was deposit-only: the Deposit card says
        // the vault is deposit-only, once, and such a row reads by its own badge.
        description="Deposits and charges, replayed from the balance account's transaction history."
        right={
          <span className="text-xs text-ink-3">
            balance account{" "}
            <Copyable
              value={billing.balanceAddress(publicKey).toBase58()}
              display={shortKey(billing.balanceAddress(publicKey))}
            />
          </span>
        }
      >
        {history.isLoading ? (
          <Skeleton rows={4} />
        ) : history.isError ? (
          <ErrorNote>
            The balance account&apos;s transaction history could not be read from the RPC
            {history.error instanceof Error ? `: ${history.error.message}` : ""}. This list is unread, not empty — your
            balance, in the vault pill, comes from the account itself.
          </ErrorNote>
        ) : history.data && history.data.length > 0 ? (
          // Ten rows tall, and the rest is scrolled to: a wallet with a few hundred charges would push
          // the operator's float off the bottom of the page, and that panel is the one thing on
          // /billing a reader cannot get anywhere else. The header stays put, so a row read
          // halfway down still has its columns.
          <div className="table-wrap max-h-[29rem] overflow-y-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="sticky top-0 z-10 border-b border-line/[0.08] bg-surface-1">
                <tr>
                  <th className="th pt-2">Event</th>
                  <th className="th text-right">Amount</th>
                  <th className="th">Agent</th>
                  <th className="th">When</th>
                  <th className="th">Signature</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/[0.06]">
                {history.data.map((row) => (
                  <tr key={`${row.signature}-${row.name}-${row.amount}`} className="row-hover">
                    <td className="td">
                      <Badge
                        // A charge is the allowance working as granted, not a warning: neutral, and
                        // amber stays for what needs a reader's attention.
                        tone={row.direction === "credit" ? "good" : "neutral"}
                        dot
                      >
                        {row.name}
                      </Badge>
                    </td>
                    <td
                      className={`td num text-right text-xs ${
                        row.direction === "credit"
                          ? "text-spine-green"
                          : row.direction === "debit"
                          ? "text-ink-1"
                          : "text-ink-2"
                      }`}
                    >
                      {row.direction === "credit" ? "+" : row.direction === "debit" ? "−" : "±"}
                      {formatUsdc(row.amount)}
                    </td>
                    <td className="td text-xs text-ink-2">
                      <AgentCell authority={row.agentAuthority} agents={agentByAuthority} />
                    </td>
                    <td className="td text-xs text-ink-2">{formatTimestampSecs(row.blockTime)}</td>
                    <td className="td">
                      <ExplorerLink kind="tx" value={row.signature} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No escrow activity yet. Deposits and agent charges will appear here.</Empty>
        )}
      </Card>

      {operatorView && <OperatorFloatPanel sweepable={sweepable} />}
    </div>
  );
}
