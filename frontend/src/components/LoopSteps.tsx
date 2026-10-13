"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { hex, toBytes32 } from "@lath/sdk/browser";
import { Badge, Card, Copyable, Empty, ExplorerLink, Facts, Info, ReadFailed, Skeleton } from "@/components/ui";
import { TempoLink, TempoMark } from "@/components/Tempo";
import { goalCheckChip, verifyChip, verifyChipLabel } from "@/components/loop-terms";
import { VerifyDecisionBlock } from "@/components/TracePanel";
import { SourcesNoteLine } from "@/components/SourcesNote";
import { StepReport, StorageChip } from "@/components/LoopTempoServices";
import { formatTimestampMs, formatUsdc, truncate } from "@/lib/format";
import { jevCostBase, traceCostBase, usdcEFigure } from "@/lib/loop-money";
import { baseOf, usdcEOfBase } from "@/lib/tempo-services";
import { TraceReaders, useTraceStore } from "@/lib/traces";
import { NO_ANSWER_BADGE, isNoAnswerStep, noAnswerLine } from "@/lib/loop-no-answer";
import { useNow } from "@/lib/live";
import { PendingStep, nextPendingStep, pendingStepLabel } from "@/lib/loop-pending";
import {
  LoopStepSummary,
  LoopView,
  VerifiedStep,
  StepMemory,
  LeftMemory,
  loopStepsOf,
  useLoopSteps,
  useVerifiedSteps,
  verdictLabel,
} from "@/lib/loops";

/**
 * What a step's session did, as the `status` on its `loop.step` record says — except a failure the
 * console knows was a model that did not answer (`noAnswer`): the record
 * still says failed, and the badge says why, in amber, because the loop simply went on.
 */
function StepOutcome({ code, jev, noAnswer }: { code: number; jev?: boolean; noAnswer?: boolean }) {
  if (code === 200) return <Badge tone="good">success</Badge>;
  // 201 is a success that was also the last step: the answer parsed as a plan that said the goal
  // was reached, so the runner stopped there. It reads in the good tone and not as an unknown code,
  // which is what the fall-through below would make it. With Jev's goal check it was Jev's
  // `achieved`, not the claim, that stopped it.
  if (code === 201)
    return (
      // Worded and coloured as the spine and the status badge say it: one state, one word.
      <Badge
        tone="volt"
        title={
          jev
            ? "the decision model judged the goal achieved at this step, and the run stopped there"
            : "this step's answer said the goal was reached, and the run stopped there"
        }
      >
        completed
      </Badge>
    );
  if (code === 499) return <Badge tone="warn">aborted</Badge>;
  if (noAnswer)
    return (
      <Badge
        tone="warn"
        title="every attempt of a model call got no answer; the record says failed, and the owner was not charged for the lost attempts"
      >
        {NO_ANSWER_BADGE}
      </Badge>
    );
  return <Badge tone="bad">failed</Badge>;
}

/** One wording per verdict, shared by both halves of the cell so *left* and *from* cannot drift. */
const MEMORY_VERDICT: Record<StepMemory["verdict"], { text: string; tone: "good" | "bad" | "warn" | "neutral" }> = {
  ok: { text: "memory verified", tone: "good" },
  unlinked: { text: "memory not committed", tone: "bad" },
  unreported: { text: "resume unreported", tone: "warn" },
  mismatch: { text: "memory bytes differ", tone: "bad" },
  missing: { text: "memory not served", tone: "warn" },
  // Not a failure: the bytes were written encrypted. Never drawn (`MemoryBadge`).
  encrypted: { text: "encrypted", tone: "neutral" },
  unchecked: { text: "memory unchecked", tone: "warn" },
};

/**
 * What a step resumed from, and what it left.
 *
 * "from #2 · memory verified" means three checks passed in the browser: the server named step 2,
 * step 2's own verified manifest commits to that memory hash, and the bytes the gateway serves
 * under it re-hash to it. Anything less says which check did not.
 *
 * "fresh" is only ever shown when no verified step before this one committed a memory. When one
 * did and the server said nothing about resuming, the row reads *resume unreported*: the chain
 * says there was something to stand on, and the server declined to say whether it was used.
 *
 * The `left` line underneath is the other direction and is independent of both: this step's own
 * manifest's `memoryHash`, and what came back from the store under it.
 */
/**
 * A memory verdict's badge. `encrypted` draws nothing: a run written encrypted shows its sealed cells
 * empty (privacy is a roadmap item).
 */
function MemoryBadge({ verdict, title }: { verdict: StepMemory["verdict"]; title?: string }) {
  if (verdict === "encrypted") return null;
  const v = MEMORY_VERDICT[verdict];
  return (
    <Badge tone={v.tone} title={title}>
      {v.text}
    </Badge>
  );
}

function MemoryCell({ memory, committed, left }: { memory?: StepMemory; committed?: string; left?: LeftMemory }) {
  if (!memory) {
    return (
      <>
        <span className="text-ink-3">fresh</span>
        {committed && <Committed hash={committed} left={left} />}
      </>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="num text-xs text-ink-1">
          {memory.verdict === "unreported" ? "after" : "from"} #{memory.fromStep}
        </span>
        <MemoryBadge verdict={memory.verdict} title={memory.hash} />
      </div>
      {memory.verdict === "unreported" && (
        <div className="mt-1 max-w-[22rem] text-2xs text-ink-3">
          step #{memory.fromStep} committed a memory; the server did not say whether this step resumed from it
        </div>
      )}
      {memory.text && (
        <div className="mt-1 max-w-[22rem] truncate text-2xs text-ink-3" title={memory.text}>
          {memory.text}
        </div>
      )}
      {committed && <Committed hash={committed} left={left} />}
    </>
  );
}

/**
 * The memory this step left, and what the browser found under it.
 *
 * Not the hash alone: a step's own memory is otherwise fetched only by the step *after* it, so the
 * last step of a run — the one a goal loop writes `GOAL REACHED` into — would have its plan
 * committed on chain and never read. The badge is the same fetch-and-re-hash the
 * resumed-from cell does, worded from the same table, so "left … memory verified" means the
 * manifest this row verified commits that hash and the bytes served under it re-hash to it.
 */
function Committed({ hash, left }: { hash: string; left?: LeftMemory }) {
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3" data-testid="step-memory-left">
      <span>
        left <Copyable value={hash} display={truncate(hash, 6, 4)} />
      </span>
      {left && <MemoryBadge verdict={left.verdict} title={hash} />}
    </div>
  );
}

/**
 * One row per step, read from the chain and checked in the browser.
 *
 * The rows are `listByTool(agentId, "loop.step")` — not the server's list — and the badge on each
 * is `verifyStep`: it rebuilds `sha256(agent_id ‖ seq_le ‖ head)` from the seq the record occupies
 * and the head the write before it produced, then re-derives the record's `payload_hash` from
 * that leaf and the loop's manifest. *leaf verified* means the record on chain commits to exactly
 * the leaf this chain implies, and that the loop's terms on screen are the terms it committed to.
 */
export function LoopSteps({
  loop,
  proofs = false,
  children,
}: {
  loop: LoopView;
  /**
   * Whether every step's proof is open: the page's one `Proof` disclosure decides. Shut, each step
   * still opens its own from its row.
   */
  proofs?: boolean;
  /** Under the steps: the page's `Proof`, which opens every step's proof and holds the rest of it. */
  children?: ReactNode;
}) {
  const steps = useLoopSteps(loop.agentId);
  const verified = useVerifiedSteps(loop, steps.data);
  // The same readers the memory cells are fetched through, so a decision blob sealed into its
  // step's session bundle is answered out of a bundle this page has already downloaded.
  const readers = useTraceStore(loop.agentId);
  const rows = verified.data ?? [];
  // What the chain has that is not this run's, counted at both ends so the note can say so. Both ends
  // are filtered: a later run of the same agent numbered into this loop's manifest would read *leaf
  // mismatch* and make the badge below say "3/6 leaves verified" about a run whose every step verified.
  const { before: earlier, after: later } = loopStepsOf(loop, steps.data);
  // Each step is a card: what it concluded, how it was judged and what it
  // cost on the row; the leaf, the epoch, the verify seat, the memory link and the Tempo payment in the
  // proof under it, opened from the row or by the page's `Proof`. Shut, the proof stays in the page with
  // `hidden` rather than leaving it, so its text is still the document's and a spec reading it finds it.
  const verifiedCount = rows.filter((r) => r.verification.verdict === "ok").length;
  // The rows on screen while the chain moved and the new list is being re-derived are the last
  // check's (`useVerifiedSteps`' placeholder): they are kept so no card closes or vanishes, but the
  // badge must not call the run _verified on chain_ while a step that just landed is still unchecked.
  const reverifying = verified.isPlaceholderData;

  return (
    <Card
      id="steps"
      title={
        <>
          <span>Steps</span>
          <span className="num text-xs font-normal text-ink-3">
            {rows.length} of {loop.maxSteps}
          </span>
        </>
      }
      // No subtitle while the proof is shut: the column heads say what
      // a row holds. The sentence on what a step is, in proof terms, comes with the proof columns.
      description={
        proofs
          ? "Each step is one session — genesis, its tool calls in one epoch, a resolution — closed by one checkpoint record whose manifest also commits to the memory the step left for the next one."
          : undefined
      }
      right={
        rows.length > 0 ? (
          reverifying ? (
            <Badge
              tone="cyan"
              title={`the chain moved: re-deriving every checkpoint leaf in this browser; ${verifiedCount}/${rows.length} verified at the last check`}
            >
              verifying…
            </Badge>
          ) : (
            <Badge
              tone={verifiedCount === rows.length ? "good" : "warn"}
              title={`${verifiedCount}/${rows.length} checkpoint leaves re-derived in this browser from the chain`}
            >
              {verifiedCount === rows.length
                ? `${verifiedCount}/${rows.length} verified on chain`
                : `${verifiedCount}/${rows.length} verified`}
            </Badge>
          )
        ) : undefined
      }
    >
      <PendingStepRow loop={loop} rows={rows} />
      {/* The first verification too, not only the chain read: until it answers there are no rows, and
        _No step has been written yet_ about a run with steps on chain would be false for the ~35 s a
        leaf takes on devnet. Later re-checks keep the rows they had (`useVerifiedSteps`). */}
      {steps.isLoading || verified.isLoading ? (
        <Skeleton rows={3} />
      ) : steps.isError ? (
        <ReadFailed error={steps.error} onRetry={() => void steps.refetch()} />
      ) : rows.length === 0 ? (
        <Empty>
          No step has been written yet. The first one appears here the moment its checkpoint record lands.
          <OtherRunsNote loop={loop} earlier={earlier} later={later} />
        </Empty>
      ) : (
        <div>
          {earlier + later > 0 && (
            <p className="mb-2 text-2xs text-ink-3">
              <OtherRunsNote loop={loop} earlier={earlier} later={later} />
            </p>
          )}
          <div
            className="divide-y divide-line/[0.06] overflow-hidden rounded-lg border border-line/[0.08]"
            data-testid="loop-steps"
          >
            {rows.map((row) => (
              <StepRow key={row.chain.seq.toString()} loop={loop} row={row} readers={readers} proofs={proofs} />
            ))}
          </div>
        </div>
      )}
      {children && <div className="mt-4 border-t border-line/[0.08] pt-3">{children}</div>}
    </Card>
  );
}

/**
 * The step the console is running and the chain does not show yet: _step 3 · model call 2 ·
 * 0:34_, its clock ticking each second. Above the list and not a card in it, because the list's
 * cards are the chain's — every one a checkpoint that verified or did not — and the loop specs count
 * `.step-row` as steps written. It stays until a card of that step's index is in the list, or for
 * `PENDING_GRACE_MS` after the step stops running, so the checkpoint's wait on the indexer is not
 * a moment where the list shows nothing happening.
 */
function PendingStepRow({ loop, rows }: { loop: LoopView; rows: VerifiedStep[] }) {
  const lastRowIndex = rows.reduce((max, r) => Math.max(max, r.index), 0);
  const recorded = loop.history.length ? loop.history[loop.history.length - 1] : undefined;
  const [pending, setPending] = useState<PendingStep | null>(null);
  // Ticking only while there is something to time, so a loop at rest re-renders nothing.
  const now = useNow(pending || (loop.stepping && loop.stepStartedAt) ? 1_000 : null);
  useEffect(() => {
    setPending((prev) =>
      nextPendingStep(prev, {
        stepping: loop.stepping,
        stepStartedAt: loop.stepStartedAt,
        stepStage: loop.stepStage,
        steps: loop.steps,
        lastRecordedStartedAt: recorded?.startedAt,
        lastRowIndex,
        now,
      })
    );
  }, [loop.stepping, loop.stepStartedAt, loop.stepStage, loop.steps, recorded?.startedAt, lastRowIndex, now]);
  if (!pending) return null;
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2 rounded border border-line/[0.08] px-3 py-2 text-xs"
      data-testid="loop-step-pending"
      data-stage={pending.endedAt !== undefined ? "landing" : pending.stage ?? "running"}
    >
      <Badge tone="cyan" dot pulse>
        {pending.endedAt !== undefined ? "landing" : "running"}
      </Badge>
      <span suppressHydrationWarning className="num text-ink-1">
        {pendingStepLabel(pending, now)}
      </span>
      <span className="text-2xs text-ink-3">
        from the console; its card below is written when the step&apos;s checkpoint lands
      </span>
    </div>
  );
}

/**
 * The agent was run as a loop before this run, or after it, or both; those checkpoints are on its
 * timeline and not in this table. Saying which side they are on is the point: a reader who counts
 * nine `loop.step` records on the agent's page and three rows here is owed the difference, and the
 * later ones are set aside rather than numbered into this run.
 */
function OtherRunsNote({ loop, earlier, later }: { loop: LoopView; earlier: number; later: number }) {
  const total = earlier + later;
  if (total === 0) return null;
  const sides = [earlier > 0 ? `${earlier} before it` : null, later > 0 ? `${later} after it` : null].filter(Boolean);
  return (
    <>
      {" "}
      {total} {total === 1 ? "step" : "steps"} on this agent&apos;s chain ({sides.join(", ")}){" "}
      {total === 1 ? "belongs" : "belong"} to another run of it and {total === 1 ? "is" : "are"} not counted here;{" "}
      <Link href={`/agent/${loop.agentId}`} className="link">
        the timeline
      </Link>{" "}
      has {total === 1 ? "it" : "them"}.
    </>
  );
}

/**
 * What the step concluded: the memory it left, which is the step's own output, cut to its first
 * lines. The whole text is the title and the proof columns' memory cell.
 */
function StepAnswer({ left }: { left?: LeftMemory }) {
  if (!left) return <span className="text-ink-3">—</span>;
  // An answer written encrypted: a dash, as a step with no answer.
  if (!left.text && left.verdict === "encrypted") return <span className="text-ink-3">—</span>;
  if (!left.text) return <MemoryBadge verdict={left.verdict} title={left.hash} />;
  // One sentence in the cell and the first few on hover: the row is
  // read at a glance, and the whole text stays in the proof columns' memory cell and the report.
  const sentences = answerSentences(left.text);
  const first = sentences[0] ?? left.text;
  const hover = sentences.slice(0, ANSWER_HOVER_SENTENCES).join(" ");
  return (
    <div
      className="line-clamp-2 max-w-[28rem] text-2xs text-ink-2"
      title={hover.length > ANSWER_HOVER_CHARS ? `${hover.slice(0, ANSWER_HOVER_CHARS - 1)}…` : hover}
      data-testid="step-answer-text"
    >
      {first}
    </div>
  );
}

/** How many of the answer's sentences its hover shows, and the most characters it may run to. */
const ANSWER_HOVER_SENTENCES = 3;
const ANSWER_HOVER_CHARS = 600;

/**
 * An answer's sentences as plain text: heading lines and a short bold lead label (`**Squads v4.**`, six
 * words at most) dropped, bold and code marks taken out, line breaks folded. A sentence ends at `.`, `!` or `?` followed by a space and a capital, digit or opening mark, so
 * a path such as `account.json` or a slot number does not end one. An abbreviation followed by a capital
 * still does; the hover joins the first few back together, so that costs a short first sentence at most.
 */
export function answerSentences(text: string): string[] {
  const plain = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/^\s*\*\*(?:[^*\s]+\s+){0,5}[^*\s]+\*\*\s*/, ""))
    .join(" ")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain
    .split(/(?<=[.!?])\s+(?=[A-Z0-9("'[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function StepRow({
  loop,
  row,
  readers,
  proofs,
}: {
  loop: LoopView;
  row: VerifiedStep;
  readers: TraceReaders;
  proofs: boolean;
}) {
  const { chain, summary, verification } = row;
  const verdict = verdictLabel(verification);
  const chip = verifyChip(summary?.verify, loop.verify?.minConfidence);
  // Jev's goal answer: beside the step's outcome, because it is what decided whether this step was
  // the last one. With what Jev's answer cost on the channel, from the open row.
  const jevBase = jevCostBase(summary);
  const goalChip = goalCheckChip(summary?.goalCheck, jevBase);
  // This step's Tempo spend, in its own currency beside the USDC Cost and never added to it.
  const tempoSpent = usdcEFigure(summary?.tempoSpent);
  // The decision model's share of it, said apart: Lath pays for it and charges the owner nothing, so
  // a reader must not take it for part of the Cost above. On a step record that carries a trace audit,
  // the audit's calls were the decision model's too, and are in the same figure.
  const lathBase = (baseOf(jevBase) ?? BigInt(0)) + (baseOf(traceCostBase(summary)) ?? BigInt(0));
  const jevPaid = lathBase > BigInt(0) ? usdcEFigure(lathBase.toString()) : null;
  // The loop's channel close, from the loop row this page already holds: every step of a run rides
  // its one channel and it settles once, so the close covers each step's vouchers. A close
  // that did not land, or has not happened, leaves the figure plain rather than linking nothing.
  const settledTx = loop.tempo?.closed && loop.tempo.txHash ? loop.tempo.txHash : null;
  const verifyHash = summary?.verify?.verifyHash;
  // The blob the decision row opens: the verify seat's (which carries the goal answer too, when the
  // check is on), or the goal check's own on a run with no seat.
  const goalOnlyHash = verifyHash ? undefined : summary?.goalCheck?.goalCheckHash;
  const decisionHash = verifyHash ?? goalOnlyHash;
  // Collapsed by default, and one row per step while it is: the decision is a second paid call's
  // worth of bytes off this page, and fetching one per step on load would be a download a reader
  // did not ask for. It is also what keeps the step table's row count the number of steps.
  const [open, setOpen] = useState(false);
  const epoch = summary?.epochs?.[0];
  const steps = summary ? `${summary.steps}` : "—";
  const leaf = verification.leaf ?? verification.expectedLeaf;
  // The storage chip's clock: ticking only while this row could still
  // be waiting on its PUT, so a finished table re-renders nothing.
  const now = useNow(summary && !summary.tempoStorage && loop.rail === "tempo" ? 5_000 : null);
  // The Cost cell's split: the owner's model calls are the step's channel spend
  // less Lath's decisions, as `tempoServiceLines` reads them for the whole run.
  const spentBase = baseOf(summary?.tempoSpent) ?? BigInt(0);
  const modelPaid = spentBase > lathBase ? usdcEFigure((spentBase - lathBase).toString()) : null;
  const storage = summary?.tempoStorage;
  const storageTx = storage?.reference ?? null;
  const storagePaid = storageTx ? usdcEOfBase(storage?.amount) : null;
  const absorbed = usdcEFigure(summary?.absorbedBase);
  // This step's proof, opened from its row; the page's `Proof` opens every step's at once.
  const [proofOpen, setProofOpen] = useState(false);
  const showProof = proofs || proofOpen;
  // The report's first paragraph, opened from the _report_ chip; a fetch, so only on request.
  const [reportOpen, setReportOpen] = useState(false);

  // What the Outcome cell holds behind its `Info`, in reading order. Each piece keeps its test id and
  // its toggle, which opens its row under this one.
  const details: ReactNode[] = [];
  // What the step's sandbox was told had moved on chain since the sources were pinned.
  if (summary?.sourcesNote) details.push(<SourcesNoteLine key="sources" note={summary.sourcesNote} />);
  if (summary && isNoAnswerStep(summary))
    // The cause in words and what the loop did next, in amber rather than a fault's red, and
    // the runner's full sentence — every attempt and how it ended — under it.
    details.push(
      <div key="no-answer" className="space-y-0.5" data-testid="step-no-answer">
        <div className="text-amber-300">
          {noAnswerLine(loop, row.index)}
          {absorbed ? ` · Lath paid the lost calls (${absorbed} USDC.e), not the owner` : ""}
        </div>
        {summary.reason && <div className="text-ink-3">{summary.reason}</div>}
      </div>
    );
  else if (summary?.reason)
    details.push(
      <div key="reason" className="text-ink-3">
        {summary.reason}
      </div>
    );
  if (summary?.workError)
    details.push(
      <div key="work" className="break-words text-ink-3">
        {summary.workError}
      </div>
    );

  // What the step paid on Tempo, part by part and whose each part is: the Cost cell's one ⓘ.
  const costSplit = (
    <>
      <div className="text-xs font-medium text-ink-1">This step on Tempo</div>
      <Facts
        items={[
          ...(modelPaid
            ? [
                {
                  label: "your model calls",
                  value: `${modelPaid} USDC.e`,
                  source: "console" as const,
                  mono: true,
                },
              ]
            : []),
          ...(jevPaid
            ? [
                {
                  label: "decision model",
                  value: <span data-testid="step-jev-paid">{jevPaid} USDC.e · paid by Lath</span>,
                  source: "console" as const,
                  mono: true,
                },
              ]
            : []),
          ...(storagePaid
            ? [
                {
                  label: "report storage",
                  value: storageTx ? (
                    <TempoLink kind="tx" value={storageTx} label={`${storagePaid} · yours`} />
                  ) : (
                    `${storagePaid} · yours`
                  ),
                  source: "console" as const,
                  mono: true,
                },
              ]
            : []),
          ...(absorbed
            ? [
                {
                  label: "calls that got no answer",
                  value: `${absorbed} USDC.e · paid by Lath`,
                  source: "console" as const,
                  mono: true,
                },
              ]
            : []),
        ]}
      />
      <p className="text-2xs leading-relaxed text-ink-3">
        The treasury pays every part on Tempo. Your model calls are debited to you in USDC on Solana (the figure above);
        the decision model is Lath&apos;s and charged to nobody.
        {settledTx ? " The link is the loop channel's close, which covers this step's payments." : ""}
      </p>
    </>
  );

  // The dot beside the step's number is its checkpoint leaf, re-derived in this browser: the proof under
  // the row says it in words.
  const dot = verdict.tone === "good" ? "bg-spine-green" : verdict.tone === "bad" ? "bg-rose-400" : "bg-amber-300";
  const answered = !!row.left?.text || (!!row.left && row.left.verdict !== "encrypted");
  // The rows a step opens under itself, indented to its text where there is room for it.
  const under = "mt-3 sm:ml-9";

  return (
    // `#step-<n>`: the loop page's spine links each step here, to the card that verifies it.
    <div id={`step-${row.index}`} data-step={row.index} className="step-row row-hover scroll-mt-20 px-3 py-3 sm:px-4">
      <div className="flex gap-3">
        <div className="flex w-6 flex-none items-start gap-1.5 pt-px">
          <span className={`mt-[0.4rem] h-1.5 w-1.5 flex-none rounded-full ${dot}`} title={verdict.text} aria-hidden />
          <span className="num text-sm text-ink-1">{row.index}</span>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* What the step concluded, when there is a text to show; nothing at all otherwise. */}
          <div className={answered ? "text-xs" : "hidden"} data-testid="step-answer">
            <StepAnswer left={row.left} />
          </div>
          {/* The step's chips: how it ended, how it was judged, the report it published, and one `Info`
              for the rest — the sources note, the reason and the no-answer detail. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* No _success_ or _completed_ beside a goal chip: _goal:
              continue_ and _goal: achieved_ say the step ran and how it ended. Every other status — failed,
              aborted, no answer — stays, because the goal chip does not say it. */}
            {!(goalChip && (chain.statusCode === 200 || chain.statusCode === 201)) && (
              <StepOutcome
                code={chain.statusCode}
                jev={summary?.goalCheck?.outcome === "achieved"}
                noAnswer={!!summary && isNoAnswerStep(summary)}
              />
            )}
            {summary?.workError && (
              // A fault stays on the row: the session resolved and the leaf verifies, so the chips read
              // clean, and this is the step's extra chain work that did not finish.
              <span data-testid="step-work-error">
                <Badge tone="bad" title={summary.workError}>
                  work failed
                </Badge>
              </span>
            )}
            {goalChip && (
              <span
                className="inline-flex flex-wrap items-center gap-1.5"
                data-testid="step-goal-check"
                data-goal={summary?.goalCheck?.outcome}
              >
                <Badge tone={goalChip.tone} title={goalChip.title}>
                  {goalChip.text}
                </Badge>
                {goalOnlyHash && (
                  <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    data-testid="step-goal-check-open"
                    className="text-2xs text-ink-2 underline decoration-dotted underline-offset-2"
                  >
                    {open ? "hide the decision" : "the decision"}
                  </button>
                )}
              </span>
            )}
            {chip && (
              <span data-testid="step-verify-chip" data-verify={summary?.verify?.outcome}>
                <Badge tone={chip.tone} title={chip.title}>
                  {verifyChipLabel(chip)}
                </Badge>
              </span>
            )}
            {/* The report the step published to Tempo storage: that conclusion's file, paid for and
                committed by the step's storage.put record. Its chip opens the first paragraph under the
                card; what it cost is in the proof's Tempo line. */}
            <StorageChip
              loop={loop}
              summary={summary}
              now={now}
              open={reportOpen}
              onToggle={() => setReportOpen(!reportOpen)}
            />
            {details.length > 0 && (
              <Info label={`Step ${row.index} details`} wide testId="step-details" triggerTestId="step-details-open">
                <div className="space-y-2 text-2xs">{details}</div>
              </Info>
            )}
          </div>
        </div>
        <div className="flex flex-none flex-col items-end gap-1 text-right">
          {/* What the owner was charged for the step, in USDC on Solana; what it paid on Tempo is in its proof. */}
          <span className="num text-xs text-ink-1" data-testid="step-cost">
            {summary ? `${formatUsdc(BigInt(summary.costMicroUsdc))} USDC` : "—"}
          </span>
          <button
            type="button"
            aria-expanded={showProof}
            disabled={proofs}
            onClick={() => setProofOpen(!proofOpen)}
            data-testid="step-proof-toggle"
            className="inline-flex items-center gap-1 text-2xs text-ink-3 transition-colors hover:text-ink-1 disabled:cursor-default disabled:hover:text-ink-3 aria-expanded:text-ink-2"
          >
            proof <span aria-hidden>{showProof ? "▾" : "▸"}</span>
          </button>
        </div>
      </div>

      {reportOpen && storage?.key && (
        <div className={under}>
          <StepReport readers={readers} storageKey={storage.key} />
        </div>
      )}

      {/* The step's proof: in the page either way, shown when its row or the page's `Proof` opens it. */}
      <div className={showProof ? under : "hidden"} data-testid="step-proof">
        <dl className="grid gap-x-4 gap-y-2 rounded-md border border-line/[0.06] bg-line/[0.02] p-3 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-ink-3">Checkpoint leaf</dt>
          <dd className="min-w-0">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge tone={verdict.tone} title={verification.expectedLeaf}>
                {verdict.text}
              </Badge>
              {leaf ? <Copyable value={leaf} display={truncate(leaf, 8, 6)} /> : <span className="text-ink-3">—</span>}
            </span>
            <div suppressHydrationWarning className="mt-0.5 text-2xs text-ink-3">
              over seq {chain.seq.toString()} ‖ head {chain.priorHead ? truncate(hex(chain.priorHead), 6, 4) : "?"} ·{" "}
              {formatTimestampMs(chain.timestamp)}
              {chain.signature && (
                <>
                  {" · "}
                  <ExplorerLink kind="tx" value={chain.signature} />
                </>
              )}
            </div>
          </dd>

          <dt className="text-ink-3">Epoch</dt>
          <dd className="min-w-0 text-ink-2">
            {epoch ? (
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                <Copyable value={epoch.root} display={truncate(epoch.root, 8, 6)} />
                <ExplorerLink kind="tx" value={epoch.signature} />
                <span className="num text-2xs text-ink-3">
                  seqs {epoch.startSeq}–{Number(epoch.endSeq) - 1} · step at {chain.seq.toString()} · tool calls {steps}
                  {summary ? ` / ${summary.batchedSteps} batched` : ""}
                </span>
              </span>
            ) : (
              // A dash, not "no epoch": the epoch comes from this console's row of the step, and a row that
              // names none (or a run this console did not start) does not show the chain has none.
              <span
                className="num text-2xs text-ink-3"
                title="not in this console's row of the step; the chain alone does not name a step's epoch"
              >
                — · step at #{chain.seq.toString()}
              </span>
            )}
          </dd>

          {/* What the second model said, when the loop asked one. A run that asked for none says a dash
            rather than *unverified*: nothing was asked and nothing failed. */}
          {/* The row's label names the check, so the chip says only its outcome: a _verified:_ in front of
            it would read _verified: unverified_ on an outage row. */}
          <dt className="text-ink-3">Verify</dt>
          <dd className="min-w-0" data-testid="step-verify">
            {chip ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={chip.tone} title={chip.title}>
                    {chip.text}
                  </Badge>
                  {typeof summary?.verify?.followedPlan === "number" && (
                    <span className="text-2xs text-ink-3">
                      followed the prompt <span className="num">{summary.verify.followedPlan.toFixed(2)}</span>
                    </span>
                  )}
                  {verifyHash && (
                    // The blob itself, on request: the hash is committed either way, and this is the
                    // one control on the row that costs a fetch.
                    <button
                      type="button"
                      onClick={() => setOpen(!open)}
                      data-testid="step-verify-open"
                      className="text-2xs text-ink-2 underline decoration-dotted underline-offset-2"
                    >
                      {open ? "hide the decision" : "the decision"}
                    </button>
                  )}
                </div>
                {summary?.verify?.unavailable && (
                  <div className="mt-1 max-w-[28rem] text-2xs text-ink-3" title={summary.verify.unavailable}>
                    {summary.verify.unavailable}
                  </div>
                )}
              </>
            ) : (
              <span className="text-ink-3">—</span>
            )}
          </dd>

          <dt className="text-ink-3">Memory</dt>
          <dd className="min-w-0" data-testid="step-memory">
            <MemoryCell memory={row.memory} committed={verification.manifest?.memoryHash} left={row.left} />
          </dd>

          {tempoSpent && (
            <>
              {/* What this step's channel paid OpenRouter, in USDC.e on Tempo: a different token on a
                different chain from the USDC on the row, which is what the owner was charged on Solana.
                It links to the loop channel's close once there is one — every step rides the loop's one
                channel and it settles once — and the split of it, with who paid each part, is the
                `Info` beside it. */}
              <dt className="text-ink-3">Paid on Tempo</dt>
              <dd className="min-w-0">
                <div className="flex flex-wrap items-center gap-1 text-ink-2" data-testid="step-tempo">
                  {settledTx ? (
                    <TempoLink
                      kind="tx"
                      value={settledTx}
                      label={`${tempoSpent} USDC.e to OpenRouter`}
                      testId="step-tempo-settlement"
                      details={costSplit}
                    />
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <TempoMark /> {tempoSpent} USDC.e to OpenRouter
                    </span>
                  )}
                  {/* With the close linked, the split rides in the link's own ⓘ: one ⓘ, not two.
                    Unsettled, it keeps an ⓘ of its own. */}
                  {!settledTx && (
                    <Info label={`What step ${row.index} paid on Tempo`} testId="step-cost-split">
                      {costSplit}
                    </Info>
                  )}
                </div>
              </dd>
            </>
          )}

          <dt className="text-ink-3">Sandbox</dt>
          <dd className="min-w-0">
            <Link
              href={`/zeroclaw/${loop.id}?step=${row.index}`}
              className="link text-xs"
              data-testid="step-sandbox-link"
            >
              Agent Loop Sandbox proof
            </Link>
          </dd>
        </dl>
      </div>

      {open && decisionHash && (
        <div className={under} data-testid="step-verify-decision-row">
          <VerifyDecisionBlock
            store={readers}
            hash={decisionHash}
            genesis={summary?.genesisPayloadHash ? toBytes32(summary.genesisPayloadHash) : undefined}
          />
        </div>
      )}
    </div>
  );
}
