"use client";

import { Badge, Card, ExplorerLink, Facts, Info, Skeleton } from "@/components/ui";
import { SolanaMark } from "@/components/Tempo";
import { useBilling } from "@/lib/clients";
import { config } from "@/lib/config";
import { formatUsdc, truncate } from "@/lib/format";
import { useTreasury } from "@/lib/queries";
import { SOLANA_RECORDS, type SolanaPayer } from "@/lib/workspace";
import { solText, useSolanaInfo } from "@/lib/solana-info";

/**
 * The workspace's Solana tab, built as the
 * Tempo tab is: one sentence under the workspace's headline and one card, _Lath on Solana_, in three
 * columns — what is on chain (the programs, the vault's totals, the fee payer, the indexer), what Lath
 * records and who is charged for each, and how one write runs.
 *
 * Everything on it is public: the addresses are `config`'s (the deployment modal's), the vault's totals
 * are the billing program's `Treasury` account read from the chain (`useTreasury`), and the fee payer
 * and indexer come from `GET /api/solana`, which keeps the RPC url and its key on the server. No
 * wallet figure is shown: the vault pill has those.
 */
export function WorkspaceSolana() {
  return (
    <div className="space-y-5" data-testid="solana-tab">
      <header>
        {/* Not "in the same transaction": a loop step's model calls are
            batched into an epoch, so each one's charge is its own transaction, journaled ahead of it
            (SPEC §15, `recordLlmStep`). Only a record written on its own shares its charge's transaction. */}
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
          {/* _Budget_, not _cap_: the word the agent page's row uses. */}
          Every action your Lath agent takes is a record on Solana, and each paid call is debited from your agent budget
          in USDC, call by call.
        </p>
      </header>
      <LathOnSolanaCard />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

/** One write, from the charge to the audit. */
const STEPS: { name: string; text: string }[] = [
  {
    name: "Charge",
    text: "The call's USDC is debited from the budget you set for the agent. Past it, the billing program refuses.",
  },
  {
    // The step's records land together in one epoch after their charges, not beside each one.
    name: "Record",
    text: "The action is appended to the agent's chain and folded into its head. A loop step's records land together in one epoch, after their charges.",
  },
  {
    name: "Trace",
    text: "The full trace is stored off chain. The record holds its SHA-256, so the trace cannot change unseen.",
  },
  {
    name: "Audit",
    text: "Anyone can replay the chain from its records with lath-audit and re-hash each trace against it.",
  },
];

// The lines themselves live in `lib/workspace.ts` (`SOLANA_RECORDS`), so `tests/workspace.ts` holds
// the receipt's figures and the charge wording without rendering this card.
const WHO_TONE: Record<SolanaPayer, "blue" | "neutral"> = { you: "blue", Lath: "neutral" };

function LathOnSolanaCard() {
  const info = useSolanaInfo();
  const treasury = useTreasury();
  const billing = useBilling();
  const i = info.data;
  const t = treasury.data;

  const address = (value: string, testId?: string) => (
    <span data-testid={testId}>
      <ExplorerLink kind="address" value={value}>
        {truncate(value, 4, 4)}
      </ExplorerLink>
    </span>
  );
  const usdc = (micro: bigint) => `${formatUsdc(micro)} USDC`;
  const vaultMissing = treasury.isLoading ? "…" : treasury.isError ? "could not be read" : "no vault at this admin";

  return (
    <Card
      tone="emerald"
      title={
        <>
          <SolanaMark /> Lath on Solana
          <Info label="What runs on Solana">
            <p>
              Two programs: <span className="font-mono">lath</span> keeps each agent&apos;s hash chain of records, and{" "}
              <span className="font-mono">lath-billing</span> holds the USDC vault and the budget each agent spends
              from. Both are public, and every figure here links to Solana&apos;s explorer.
            </p>
          </Info>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-3" data-testid="solana-lath">
        <section className="space-y-2" aria-label="On Solana">
          <h3 className="eyebrow">On Solana</h3>
          <Facts
            items={[
              {
                label: "Network",
                value: `Solana ${i?.cluster ?? config.cluster}${
                  i?.slot ? ` · slot ${i.slot.toLocaleString("en-US")}` : ""
                }`,
              },
              {
                label: "Lath program",
                value: address(config.lathProgramId.toBase58(), "solana-lath-program"),
                source: "chain",
              },
              {
                label: "Billing program",
                value: address(config.billingProgramId.toBase58(), "solana-billing-program"),
                source: "chain",
              },
              {
                label: "Vault (USDC)",
                value: t ? address(billing.vaultAddress().toBase58(), "solana-vault") : vaultMissing,
                source: "chain",
              },
              ...(t
                ? [
                    {
                      label: "Deposited, all time",
                      value: usdc(t.totalDeposited),
                      source: "chain" as const,
                      mono: true,
                    },
                    {
                      label: "Charged, all time",
                      value: usdc(t.totalSpent),
                      source: "chain" as const,
                      mono: true,
                      title: "every debit from an allowance, model calls and report storage",
                    },
                    {
                      label: "Swept to the operator",
                      value: usdc(t.totalSwept),
                      source: "chain" as const,
                      mono: true,
                    },
                    {
                      label: "Sweepable now",
                      value: usdc(t.totalSpent - t.totalSwept),
                      source: "chain" as const,
                      mono: true,
                      title: "charged less swept: the only USDC the operator may move out of the vault",
                    },
                  ]
                : []),
              {
                label: "Treasury admin",
                value: address(config.treasuryAdmin.toBase58()),
                source: "chain",
              },
              {
                label: "Fee payer",
                value: info.isLoading ? (
                  "…"
                ) : !i || i.unreachable ? (
                  "the console did not answer"
                ) : !i.feePayer ? (
                  "none: this console holds no runtime key"
                ) : (
                  <span className="inline-flex items-center gap-1.5" data-testid="solana-fee-payer">
                    {address(i.feePayer.address)}
                    <span className="num text-2xs text-ink-2">
                      {i.feePayer.lamports !== null ? solText(i.feePayer.lamports) : "balance not read"}
                    </span>
                  </span>
                ),
                source: "console",
                // No "and funds each loop key from": no grant plugin is in this build.
                title: "the key this console pays Solana fees from",
              },
              {
                label: "Indexer",
                value: info.isLoading ? (
                  "…"
                ) : !i || i.unreachable || !i.indexer ? (
                  "not read"
                ) : (
                  <span data-testid="solana-indexer">
                    <Badge tone={i.indexer.healthy ? "good" : "warn"}>
                      {i.indexer.healthy ? "healthy" : `not healthy${i.indexer.error ? `: ${i.indexer.error}` : ""}`}
                    </Badge>
                  </span>
                ),
                source: "console",
                title: "the ZK-compression indexer every agent read goes through",
              },
            ]}
          />
        </section>

        <section className="space-y-2" aria-label="What it records" data-testid="solana-records">
          <h3 className="eyebrow">What it records and charges</h3>
          <ul className="space-y-2.5">
            {SOLANA_RECORDS.map((r) => (
              <li key={r.key} className="space-y-0.5" data-testid={`solana-record-${r.key}`}>
                <div className="flex items-center justify-between gap-2 text-sm text-ink-1">
                  {r.label}
                  <Badge tone={WHO_TONE[r.who]}>{r.who}</Badge>
                </div>
                <p className="text-2xs leading-relaxed text-ink-3">{r.how}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2" aria-label="How a write runs" data-testid="solana-steps">
          <h3 className="eyebrow">How a write runs</h3>
          <ol className="space-y-2.5">
            {STEPS.map((s, n) => (
              <li key={s.name} className="flex gap-2.5">
                <span className="num mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border border-line/[0.12] text-2xs text-ink-2">
                  {n + 1}
                </span>
                <p className="text-2xs leading-relaxed text-ink-3">
                  <span className="font-medium text-ink-1">{s.name}.</span> {s.text}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {info.isLoading && treasury.isLoading && <Skeleton rows={2} />}
    </Card>
  );
}
