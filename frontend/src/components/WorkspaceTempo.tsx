"use client";

import { ReactNode } from "react";
import { Badge, Card, Empty, Facts, Info, Skeleton } from "@/components/ui";
import { OpenRouterMark, TempoLink, TempoMark } from "@/components/Tempo";
import { TEMPO_ESCROW_ADDRESS, formatBaseUnits, useTempoTreasury } from "@/lib/tempo";
import { useLoops } from "@/lib/loops";
import { useTempoStats } from "@/lib/tempo-stats";
import { tempoStatsLine } from "@/lib/tempo-commands";
import { CommandBox } from "@/components/VerifyPanel";

/**
 * The workspace's Tempo tab: Lath's treasury on
 * Tempo, shown to every wallet because all of it is public — where it is, what it holds, what it pays
 * and who is charged for each, and how one payment runs.
 *
 * Not here: a _Check it yourself_ list (the loop page has its own, `LoopTempoServices`) and the
 * wallet's own share (each loop's Costs card shows that loop's Tempo lines).
 *
 * What it cannot say, and so does not: how many model calls the channels paid (vouchers never reach
 * Tempo; the Solana records count them), or whose loops spent the treasury — it is the treasury's,
 * whoever ran the loops, which on this deployment so far is the Lath team.
 */
export function WorkspaceTempo() {
  const loopKeysOn = useLoops().data?.limits?.tempoLoopKeys === true;
  return (
    <div className="space-y-5" data-testid="tempo-tab">
      {/* No heading of its own: the workspace's h1 is the page's one title on every tab, and this
          sentence sits under it. */}
      {/* About Tempo, not Solana: the cap on Solana is the Solana tab's. The key clause rides on
          `limits.tempoLoopKeys`, the console's own `LATH_TEMPO_LOOP_KEYS`: said as a fact when it is on,
          left out when it is off or the console does not send it. */}
      <header>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2" data-testid="tempo-tab-lead">
          {/* _Lath Tempo_, the treasury's name on this tab. */}
          Lath Tempo pays OpenRouter{loopKeysOn ? ", each loop through its own capped key" : ""}.
        </p>
      </header>
      <TreasuryCard loopKeysOn={loopKeysOn} />
      <TreasuryRecord />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

/** What the treasury pays for, and who it is charged to. The decision model's 15 % is the loop budget's. */
const PAYS: { label: ReactNode; who: "you" | "Lath"; how?: string }[] = [
  {
    label: (
      <span className="inline-flex items-center gap-1">
        <OpenRouterMark /> Model calls on OpenRouter via Tempo
      </span>
    ),
    who: "you",
    // "Call by call", not "in the same transaction as the record": a loop step's charges are their
    // own transactions, journaled ahead of the epoch (SPEC §15).
    how: "debited from your allowance in USDC on Solana, call by call",
  },
  { label: "Report storage", who: "you", how: "debited in USDC on Solana with the step that stored it" },
  // _Jev decision model_, with no line under it, and RPC reads with none either: the _Lath_ badge says
  // who pays, and a line would only say it again less clearly.
  { label: "Jev decision model", who: "Lath" },
  // No _Trace audit_ row: it is a roadmap feature this build refuses.
  { label: "RPC reads", who: "Lath" },
];

/**
 * One payment, from the loop's key to the channel's close. _Key_ leads, as a step of its own, only on
 * a console that gives each new loop its own key (`limits.tempoLoopKeys`); elsewhere the treasury
 * signs and the steps start at _Open_.
 */
const KEY_STEP = {
  name: "Key",
  text: "Each loop gets its own Tempo access key; Tempo refuses any spend past its limit, the loop's budget plus the decision model's share.",
};

const STEPS: { name: string; text: string }[] = [
  {
    name: "Open",
    text: "A run opens a payment channel and its deposit is locked in the escrow contract. On a loop, the deposit is the loop's budget plus the decision model's share.",
  },
  {
    name: "Voucher",
    text: "Each model call is paid by a signed voucher for the running total. Vouchers stay off chain; the Solana record of the call commits the payment.",
  },
  {
    name: "Close",
    text: "The close pays OpenRouter what the last voucher says and refunds the rest of the deposit to the treasury, on Tempo, where anyone can read it.",
  },
];

function TreasuryCard({ loopKeysOn }: { loopKeysOn: boolean }) {
  const treasury = useTempoTreasury();
  const t = treasury.data;
  return (
    <Card
      tone="cyan"
      title={
        <>
          <TempoMark /> Lath Tempo
          <Info label="What the treasury is">
            <p>
              One Tempo account this deployment pays from. It opens a payment channel per run, signs a voucher for each
              call — this call&apos;s payment — and the channel&apos;s close pays OpenRouter and refunds the rest. It is
              shared by every user of the deployment.
            </p>
          </Info>
        </>
      }
    >
      <div data-testid="tempo-treasury">
        {treasury.isLoading ? (
          <Skeleton rows={3} />
        ) : !t || t.unreachable ? (
          <Empty>
            The console did not answer for its treasury{t?.unreachable ? ` (${t.unreachable})` : ""}, so its address and
            balance are not shown.
          </Empty>
        ) : !t.enabled || !t.address ? (
          <Empty>This console has no Tempo treasury configured, so nothing here is paid on Tempo.</Empty>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <section className="space-y-2" aria-label="On Tempo">
              <h3 className="eyebrow">On Tempo</h3>
              <Facts
                items={[
                  {
                    label: "Network",
                    value: `Tempo mainnet${t.chainId ? ` · chain ${t.chainId}` : ""}`,
                  },
                  {
                    label: "Address",
                    value: <TempoLink kind="address" value={t.address} testId="tempo-treasury-address" />,
                    source: "tempo",
                  },
                  {
                    label: "Balance",
                    value: (
                      <span data-testid="tempo-treasury-balance">
                        {t.balanceBase ? `${formatBaseUnits(t.balanceBase)} USDC.e` : t.balanceError ?? "not read"}
                      </span>
                    ),
                    source: "tempo",
                    mono: true,
                  },
                  ...(t.token
                    ? [
                        {
                          label: "Token",
                          value: <TempoLink kind="token" value={t.token} label="USDC.e" testId="tempo-token" />,
                        },
                      ]
                    : []),
                  {
                    label: "Escrow contract",
                    value: (
                      <TempoLink kind="address" value={TEMPO_ESCROW_ADDRESS} label="escrow" testId="tempo-escrow" />
                    ),
                    title: "where each payment channel's funds are locked until it closes",
                  },
                  {
                    label: "Channels open now",
                    value: String(t.openChannels ?? 0),
                    source: "console",
                    title: "payment channels this console holds open against the treasury",
                  },
                ]}
              />
            </section>

            <section className="space-y-2" aria-label="What it pays" data-testid="tempo-treasury-pays">
              <h3 className="eyebrow">What it pays</h3>
              <ul className="space-y-2.5">
                {PAYS.map((p, i) => (
                  <li key={i} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2 text-sm text-ink-1">
                      {p.label}
                      <Badge tone={p.who === "you" ? "blue" : "neutral"}>{p.who === "you" ? "you" : "Lath"}</Badge>
                    </div>
                    {p.how && <p className="text-2xs leading-relaxed text-ink-3">{p.how}</p>}
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2" aria-label="How a payment runs" data-testid="tempo-treasury-steps">
              <h3 className="eyebrow">How a payment runs</h3>
              <ol className="space-y-2.5">
                {(loopKeysOn ? [KEY_STEP, ...STEPS] : STEPS).map((s, i) => (
                  <li key={s.name} className="flex gap-2.5">
                    <span className="num mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border border-line/[0.12] text-2xs text-ink-2">
                      {i + 1}
                    </span>
                    <p className="text-2xs leading-relaxed text-ink-3">
                      <span className="font-medium text-ink-1">{s.name}.</span> {s.text}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * What the treasury has paid on Tempo mainnet, from `GET /api/tempo/stats` (the same reads as
 * `npm run -s tempo:stats`): the console's mainnet record. Whose loops spent
 * it is not the treasury's to say, so the line says the deployment's, and the README says who ran them.
 */
function TreasuryRecord() {
  const stats = useTempoStats();
  const s = stats.data?.stats;
  if (stats.isLoading) {
    return (
      <Card
        tone="cyan"
        title={
          <>
            <TempoMark /> Paid on Tempo mainnet
          </>
        }
      >
        <Skeleton rows={2} />
      </Card>
    );
  }
  // Nothing at all when the console serves no figures: the treasury card above already says why.
  if (!s || !s.since) return null;
  const since = new Date(s.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const stat = (label: string, value: ReactNode, testId: string, sub?: ReactNode) => (
    <div className="well space-y-1 px-4 py-3" data-testid={testId}>
      <div className="eyebrow">{label}</div>
      <div className="num text-xl text-ink-1">{value}</div>
      {sub && <div className="text-2xs text-ink-3">{sub}</div>}
    </div>
  );
  return (
    <Card
      tone="cyan"
      title={
        <>
          <TempoMark /> Paid on Tempo mainnet
        </>
      }
      description={`Since ${since}: every payment channel this treasury opened, read from Tempo's public feed and its escrow.`}
    >
      <div className="space-y-4" data-testid="tempo-record">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stat("Payment channels", s.channels.opened, "tempo-record-channels", "one per loop or session")}
          {stat(
            "Settled",
            s.channels.settled,
            "tempo-record-settled",
            s.channels.open ? `${s.channels.open} still open` : "none left open"
          )}
          {stat(
            "Paid to MPP services",
            <>
              {formatBaseUnits(s.paidBase)} <span className="text-sm text-ink-2">USDC.e</span>
            </>,
            "tempo-record-paid",
            <span className="inline-flex items-center gap-1">
              <OpenRouterMark /> OpenRouter&apos;s gateway, and {s.storage.count} Tempo storage writes
            </span>
          )}
          {stat("Days", s.days, "tempo-record-days", "on Tempo mainnet")}
        </div>
        <p className="text-2xs leading-relaxed text-ink-3">
          These are the treasury&apos;s payments, for every agent and loop this deployment ran
          {s.approximate ? "; a channel's state could not be read, so its deposit is counted as paid" : ""}. How many
          model calls they paid is counted on Solana, where each call is a record. Anyone can read the same figures:
        </p>
        <CommandBox command={tempoStatsLine({ address: s.treasury }).command} testId="tempo-record-command" />
      </div>
    </Card>
  );
}
