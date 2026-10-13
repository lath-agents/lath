"use client";

/**
 * The lifecycle records on screen (`sdk/src/lifecycle.ts`): a loop's start, pauses, resumes and stop
 * as its agent's chain holds them, and an agent's deploy. They are what lets a console rebuild its
 * lists from the chain and Irys alone, so the page shows them as the chain's, each with its seq and
 * its transaction, beside the console's status rather than in place of it.
 *
 * Every part renders nothing when the row carries no `chain`: a loop or agent written without lifecycle records, or a
 * row from a server that does not report them, draws no chain part. The words are `lib/chain-records.ts`'s, which
 * `tests/workspace.ts` holds.
 */
import { Badge, Card, ExplorerLink } from "@/components/ui";
import { SolanaMark } from "@/components/Tempo";
import { formatTimestampMs } from "@/lib/format";
import {
  REBUILT_LABEL,
  REBUILT_TITLE,
  chainOwes,
  chainRebuilt,
  chainRecordLines,
  deployRecord,
  owedText,
} from "@/lib/chain-records";
import type { LifecycleRef, LoopChainView, LoopView } from "@/types/loop";
import { loopStopReasonText } from "@/types/loop";

/** The read-only badge for a row rebuilt from the chain; nothing on any other row. */
export function RebuiltBadge({ chain, testId }: { chain: LoopChainView | undefined; testId: string }) {
  if (!chainRebuilt(chain)) return null;
  return (
    <span data-testid={testId} title={REBUILT_TITLE}>
      <Badge tone="compressed">{REBUILT_LABEL}</Badge>
    </span>
  );
}

/**
 * The quiet chip for what the console decided and has not written yet. Neutral, not amber: a pause
 * queued behind a step is the normal path, and the warning is kept for a write that failed (`error`).
 */
export function OwedChip({ owed, testId }: { owed: readonly string[] | undefined; testId: string }) {
  const text = owedText(owed);
  if (!text) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line/[0.1] bg-line/[0.04] px-2 py-0.5 text-2xs text-ink-3"
      data-testid={testId}
      title="The console has decided this and has not written its record on the agent's chain yet"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-spine-blue/70 motion-safe:animate-pulse" />
      {text}
    </span>
  );
}

/** The last owed write's error, in the page's warning words; nothing when there is none. */
function ChainError({ error, testId }: { error: string | undefined; testId: string }) {
  if (!error) return null;
  return (
    <p className="text-2xs leading-relaxed text-amber-300" data-testid={testId}>
      The last record&apos;s write failed and waits for its retry: {error}
    </p>
  );
}

/**
 * The loop page's _On Solana_ block: the run's lifecycle records oldest first, each with its seq and
 * its transaction on the console's cluster, the stop's reason on the stop that ended it. The chip and
 * the warning say what the chain does not have yet; a rebuilt row's badge is in the page's title, by
 * the controls it explains.
 */
export function LoopChainBlock({ loop }: { loop: LoopView }) {
  const chain = loop.chain;
  if (!chain) return null;
  // The reason only on a stopped run: a stop a resume undid ended nothing this row remembers.
  const stopReason =
    loop.status === "stopped" ? loopStopReasonText(loop) ?? loop.stopDetail ?? loop.stopReason ?? null : null;
  const lines = chainRecordLines(chain.records, { stopReason });
  const owes = chainOwes(chain);

  return (
    // Folded by default; the owed chip stays on the header, so a record still being written shows.
    <Card
      tone="blue"
      collapsible={{ testId: "loop-chain-fold" }}
      title={
        <>
          <SolanaMark size={16} />
          Solana
        </>
      }
      right={owes ? <OwedChip owed={chain.owed} testId="loop-chain-owed" /> : undefined}
      // One short line: the records under it say which ones there are.
      description="Lifecycle records on the agent's chain."
    >
      <div className="space-y-3" data-testid="loop-chain">
        <ChainError error={chain.error} testId="loop-chain-error" />
        {lines.length === 0 ? (
          <p className="text-2xs text-ink-3" data-testid="loop-chain-empty">
            {owes ? "No record on chain yet." : "This run has no lifecycle record on chain."}
          </p>
        ) : (
          <ol className="space-y-1.5">
            {lines.map((line) => (
              <li
                key={line.key}
                className="well flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
                data-testid="loop-chain-record"
                data-tool={line.tool}
                data-seq={line.seq}
              >
                <span className="font-medium text-ink-1">{line.label}</span>
                <span className="num text-2xs text-ink-3">seq {line.seq}</span>
                {line.signature && (
                  <ExplorerLink kind="tx" value={line.signature}>
                    {`${line.signature.slice(0, 8)}…`}
                  </ExplorerLink>
                )}
                <span suppressHydrationWarning className="num ml-auto text-2xs text-ink-3">
                  {formatTimestampMs(line.at)}
                </span>
                {line.detail && (
                  <span className="basis-full text-2xs text-ink-3" data-testid="loop-chain-stop-reason">
                    {line.detail}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

/**
 * A run row's marks in the workspace list: the read-only badge, and a small dot while the run owes
 * records. Test ids are the row's own (`run-chain-*`), since the run's panel beside the list draws the
 * loop's.
 */
export function RunChainMarks({ loop }: { loop: LoopView }) {
  const chain = loop.chain;
  if (!chain) return null;
  const owed = owedText(chain.owed);
  return (
    <>
      {owed && (
        <span
          className="ml-1 inline-flex items-center gap-1 text-2xs text-ink-3"
          data-testid="run-chain-owed"
          title={chain.error ? `${owed} — the last write failed: ${chain.error}` : owed}
        >
          {" · "}
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${chain.error ? "bg-amber-400" : "bg-spine-blue/70"}`}
          />
          recording on Solana…
        </span>
      )}
      {chainRebuilt(chain) && (
        <span className="ml-1.5 text-2xs text-ink-3" data-testid="run-chain-rebuilt" title={REBUILT_TITLE}>
          · read-only
        </span>
      )}
    </>
  );
}

/**
 * The tail of the agent panel's _On Solana_ row: _deployed_ linking the deploy transaction, then what
 * is owed and the last write's error the way a loop shows them. The row's label says Solana and its
 * head the record count, so neither is repeated here.
 * Nothing for an agent with no `chain`.
 */
export function AgentChainLine({
  chain,
}: {
  chain: { records: LifecycleRef[]; owed: string[]; error?: string } | undefined;
}) {
  if (!chain) return null;
  const deploy = deployRecord(chain.records);
  if (!deploy && !chainOwes(chain) && !chain.error) return null;
  return (
    <>
      {deploy && (
        <span className="inline-flex items-center gap-1" data-testid="agent-chain-deploy" data-seq={deploy.seq}>
          · deployed
          {deploy.signature && (
            <ExplorerLink kind="tx" value={deploy.signature}>
              {`${deploy.signature.slice(0, 8)}…`}
            </ExplorerLink>
          )}
        </span>
      )}
      <OwedChip owed={chain.owed} testId="agent-chain-owed" />
      <ChainError error={chain.error} testId="agent-chain-error" />
    </>
  );
}
