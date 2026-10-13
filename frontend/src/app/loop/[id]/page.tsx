"use client";

import { use, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge, Card, Copyable, Crumbs, ErrorNote, Info, Note, Proof, Skeleton } from "@/components/ui";
import { ComposeLoopLink } from "@/components/ComposeLoopLink";
import { LoopControls } from "@/components/LoopControls";
import {
  ArchiveLoopButton,
  LoopStatusBadge,
  RetryStepButton,
  DiscardAnchorButton,
  RunAgainButton,
  TemplateLine,
} from "@/components/LoopList";
import { LoopSteps } from "@/components/LoopSteps";
import { LoopReceipt } from "@/components/LoopReceipt";
import { LoopChainBlock, RebuiltBadge } from "@/components/LoopChain";
import { LoopStepSpine, NEUTRAL_STOPS } from "@/components/LoopSpine";
import { GOAL_CHECK_COPY, VERIFY_TERMS_COPY } from "@/components/loop-terms";
import {
  LOOP_STEP_BUDGET_STOP_TEXT,
  LOOP_STOP_REASON_TEXT,
  earlierBuildSentence,
  loopStopReasonText,
  stoppedOnStepBudget,
} from "@/types/loop";
import { DualRailPanel } from "@/components/DualRailPanel";
import { LoopRails } from "@/components/LoopRails";
import { AnswerSummary, LoopMoneyFlow, OpenChannel, TempoPaymentsCard } from "@/components/LoopTempoServices";
import { tempoKeyStopText } from "@/lib/tempo-key";
import { formatTimestampMs, formatUsdc, truncate } from "@/lib/format";
import { formatInterval, LoopView, useLoop } from "@/lib/loops";
import { lostStepsSentence } from "@/lib/loop-no-answer";
import { useDocumentTitle } from "@/lib/document-title";
import { useAgentsRegistry } from "@/lib/market";
import { loopBudgetFigures, loopMoney } from "@/lib/loop-money";
import { formatMicro, trimUsdc } from "@/lib/tiles";
import { triggerLabel, triggerOf } from "@/lib/loop-trigger";

/**
 * One loop: its standing terms, its controls, and every step it has written.
 *
 * The terms at the top are the server's; the steps below are the chain's, and each row says
 * whether its checkpoint leaf rebuilds. That pairing is the point of the page — the schedule is
 * a promise, and the leaves are what was actually kept.
 */
export default function LoopPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string; sandbox?: string; room?: string }>;
}) {
  const { id } = use(params);
  // The query `/zeroclaw/<id>` reads (`?step=`, `?sandbox=`), kept on the redirect below.
  use(searchParams);
  useSandboxRedirect(id);
  const query = useLoop(id);
  const loop = query.data?.loop;
  const registry = useAgentsRegistry();
  const publicDescription =
    registry.data?.agents
      .find((a) => String(a.id).toLowerCase() === loop?.agentId.toLowerCase())
      ?.description?.trim() || null;
  // The tab names the run's agent once it is read; until then the segment's static "Loop".
  useDocumentTitle(loop?.agentName);
  /**
   * Whether the page's `Proof` is open, which the steps table's proof columns follow. Told by the
   * disclosure's own body (`ProofOpenSignal`), and held here because a hook may not sit behind the
   * early returns.
   */
  const [proofOpen, setProofOpen] = useState(false);

  if (query.isLoading) return <Skeleton rows={6} />;
  if (!loop) {
    return (
      <div className="space-y-6">
        <Crumbs items={[{ label: "Agents", href: "/" }, { label: truncate(id, 10, 4) }]} />
        <ErrorNote>
          No loop with that id is running here. Loops live in this server&apos;s own registry, so a loop started against
          a different deployment will not be found by this one.
        </ErrorNote>
      </div>
    );
  }

  // The loop's one budget, what its steps and members have drawn from it and Lath's Jev share beside
  // it, read so a row written before loops had one budget still renders.
  const figures = loopBudgetFigures(loop);
  // The Goal and the instruction wells: a loop with a goal whose hash is its prompt's runs one text as
  // both — every loop the form starts with the goal check on — and shows one well.
  // Both hashes are `sha256` of the trimmed text (`goalHash`, `promptHashOf`), so equal hashes are
  // equal texts.
  const hasGoal = !!(loop.goal || loop.goalHash);
  const sameText = !!loop.goalHash && loop.goalHash === loop.promptHash;
  // Badge, figure and note from one reading of the row, so they cannot disagree.
  const money = loopMoney(loop);
  // What the spine under the money flow draws: its step rows only
  // while the run can still step, and the decision model's last answer unless the finish note says it.
  // Nothing at all when neither is left, so a finished run's card goes from the money flow to its report.
  const spineSteps = loop.status !== "stopped";
  const spineVerdict = !(loop.stopReason === "goal-reached" && loop.status !== "running");
  const spineShows =
    spineSteps || loop.history.length === 0 || (spineVerdict && loop.history.some((h) => !!h.goalCheck));

  // The page, top to bottom: where the run stands and
  // how it ended; what it spent and when it moves next; where the money went, Tempo first; the open
  // channel; the goal and the decision; the instruction; the controls; the report. Detail sits behind
  // an `Info` beside the thing it explains, and the proof material behind one `Proof` at the foot of
  // the steps, so the screen reads as the run rather than as its record.
  return (
    <div className="space-y-6">
      <Crumbs
        // Back to this run in the workspace, its agent's row open: `/?run=` selects the run and its agent.
        items={[{ label: "Agents", href: `/?run=${encodeURIComponent(id)}` }, { label: loop.agentName }]}
      />

      <div className="space-y-6" data-testid="loop-records">
        <Card
          tone="emerald"
          pageTitle
          title={
            <>
              <span>{loop.agentName}</span>
              <LoopStatusBadge loop={loop} />
              {/* A row this console rebuilt from the chain and did not start: beside the status, because it
                is why the controls below are disabled (`lib/chain-records.ts`). Nothing on any other row. */}
              <RebuiltBadge chain={loop.chain} testId="loop-chain-rebuilt" />
            </>
          }
          description={
            // The agent's public description when its deploy gave one. No _Runs on this agent's chain_
            // line under it: the Steps card's _verified on chain_ badge says it, and the breadcrumb links
            // the agent.
            publicDescription ? (
              <span className="block text-sm text-ink-2" data-testid="loop-public-description">
                {publicDescription}
              </span>
            ) : undefined
          }
          // No step count beside the name: the Steps card says _Steps n of m_, and two counts on one
          // page would say it twice.
        >
          <div className="space-y-5">
            <FinishNote loop={loop} figures={figures} />

            {/* A row that ran with a feature this build does not have — a team, a gate, an oracle
              trigger, the trace audit, grants — says so in one line, right under how the run stands,
              instead of a card for the feature. Nothing on any other run. */}
            <EarlierBuildNote loop={loop} />

            {/* The channel closed but its `loop.settlement` record was deferred, because the chain's
              journal still owed this run's earlier writes and a direct write would have taken one
              of their seqs. What is missing is the chain's record of the close, and Retry
              the step is what writes it. */}
            {loop.tempo?.recordOwed === true && (
              <div data-testid="loop-channel-record-owed">
                <Note tone="warn">
                  Settlement recorded after Retry: this run&apos;s <code>loop.settlement</code> record is not on chain
                  yet — its earlier chain writes had not landed, or the record&apos;s own write failed — and{" "}
                  <em>Retry the step</em> writes it.
                </Note>
              </div>
            )}
            {/* Why a step ran scripted, when one did: the rail on the row is sticky, so this says what
              happened rather than the steps silently disagreeing with it. */}
            {loop.tempoNote && <Note tone="warn">{loop.tempoNote}</Note>}

            {/* The owner's actions first, above the configuration: what a person came to press is the
              first thing under how the run stands. */}
            <div className="space-y-3">
              {/* What to do with the run: Pause and Stop are what a person on this page most often came
                to press. *Run again* is a start, so it gets a new id and its own history, and
                *Archive* deletes nothing: this page keeps answering. */}
              <LoopControls loop={loop}>
                {/* Exactly one of these two is offered on a stopped run: *Run again* starts a
                  successor, and is not offered when the writes of this run are still owed
                  (that would pay twice for work already done); *Retry the step* sends those
                  writes, and is offered for nothing else. */}
                <RunAgainButton loop={loop} />
                <RetryStepButton loop={loop} />
                <DiscardAnchorButton loop={loop} />
                {/* And the way to run it on different terms, or at all when *Run again* has nothing
                  to start from: a run recorded without a template carries no config. In the row, not
                  a ⋯ menu, so every action is visible. */}
                {loop.status !== "running" && <ComposeLoopLink agentId={loop.agentId} />}
                <ArchiveLoopButton loop={loop} />
                {loop.archivedAt && (
                  <span suppressHydrationWarning className="text-2xs text-ink-3">
                    archived {formatTimestampMs(loop.archivedAt)} — the lists no longer carry this run; its steps and
                    this page do not go away, and <em>Unarchive</em> puts it back
                  </span>
                )}
              </LoopControls>
            </div>

            {/* The goal and the decision: what *done* looks like, then the run on the spine, every
              step ending in the decision model's answer. The spine is the console's cache of each
              step; the Steps table further down is the chain's, and verifies each one.

              The goal's hash is what a reader needs to rebuild a step's manifest and reach `ok`. A run
              with no goal renders no well. */}
            {/* The run's configuration, on the page rather than behind an `Info` beside the name: what
              decides a step, how often, who judges it and on which model. No budget
              line: the money flow below is the budget and what it spent. Beside the goal on a wide screen
              (two columns, the goal the wider), above it on a narrow one; alone when the run has none. */}
            <div
              className={`grid gap-4 ${hasGoal ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : ""}`}
              data-testid="loop-configuration-goal"
            >
              <LoopConfiguration loop={loop} money={money} />
              {hasGoal && (
                <div className="well px-3 py-2.5" data-testid="loop-goal">
                  <div className="flex items-center gap-1.5">
                    <span className="eyebrow">Goal</span>
                    {loop.goalHash && (
                      <Info label="How the goal is committed" testId="loop-goal-hash-info">
                        <div className="text-2xs leading-relaxed text-ink-3" data-testid="loop-goal-hash">
                          committed as sha256 <Copyable value={loop.goalHash} display={truncate(loop.goalHash, 8, 6)} />{" "}
                          in every step&apos;s manifest, and the run stops itself when{" "}
                          {loop.goalCheck ? "the decision model judges it achieved" : "a step says it is reached"}
                          {sameText && (
                            <span data-testid="loop-goal-is-instruction">
                              . It is also the instruction every step runs, committed under the same hash as the prompt
                            </span>
                          )}
                        </div>
                      </Info>
                    )}
                  </div>
                  {loop.goal && <ClampedText text={loop.goal} testId="loop-goal-text" />}
                </div>
              )}
            </div>

            {/* No _Next step_ card: the spine's pending row already says a step is running and what it
              is doing, so a card saying "running now" would say it twice. No budget card: the money
              flow's first box is what the loop spent of its budget. */}

            {/* Where the money went: the owner's cap on Solana, Lath's treasury on Tempo, and
              OpenRouter paid through its Tempo gateway — every box linked to its explorer, live while
              a step pays. On a keyed loop the key's one linked line is its footer. */}
            <LoopMoneyFlow loop={loop} />
            {/* The channel the next call pays through, filling call by call. */}
            <OpenChannel loop={loop} />
            {/* Lath's two rails, side by side: what this run recorded on
              Solana and what it paid OpenRouter on Tempo, each with its links. */}
            <LoopRails loop={loop} />

            {spineShows && (
              <div className="min-w-0" data-testid="loop-hero">
                <div className="min-w-0" data-testid="loop-page-spine">
                  {/* A run stopped on its goal already says so in the note above, so the spine's own answer
                    box would say it twice. A stopped run draws no step rows either: each is a row of
                    the Steps table below, verified there. A live run keeps them, with the step running. */}
                  <LoopStepSpine loop={loop} all verdict={spineVerdict} steps={spineSteps} />
                </div>
              </div>
            )}

            {/* The instruction; its hash is the well's `Info`. With the form's one Goal field
              (`lib/loop-goal-field.ts`) a loop started with the goal check on sends one text as both its
              goal and its instruction, so the two hashes are equal and the well above already shows it:
              this well is then left out rather than printing the same paragraph twice. A loop whose two
              texts differ — a row written with a separate goal and instruction — keeps both, this one as
              _Instruction_; a loop with no goal shows its instruction here as its _Goal_, the field it
              was typed into. */}
            {!sameText && (
              <div className="well px-3 py-2.5" data-testid="loop-prompt">
                <div className="flex items-center gap-1.5">
                  <span className="eyebrow">{hasGoal ? "Instruction" : "Goal"}</span>
                  <Info label="How the instruction is committed" testId="loop-prompt-hash-info">
                    <div className="text-2xs leading-relaxed text-ink-3">
                      committed as sha256 <Copyable value={loop.promptHash} display={truncate(loop.promptHash, 8, 6)} />{" "}
                      in every step&apos;s manifest
                    </div>
                  </Info>
                </div>
                {/* A row rebuilt from the chain has no instruction text unless it was the goal's: the start
                  record carries only its hash. An empty paragraph under the eyebrow would read as an empty
                  instruction, so the well says what the chain holds instead. */}
                {loop.prompt ? (
                  <p
                    className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-1"
                    data-testid="loop-prompt-text"
                  >
                    {loop.prompt}
                  </p>
                ) : (
                  <p className="mt-1 text-xs leading-relaxed text-ink-3" data-testid="loop-prompt-off-chain">
                    The text is not on chain. The chain commits it as sha256{" "}
                    <Copyable value={loop.promptHash} display={truncate(loop.promptHash, 8, 6)} /> in every step&apos;s
                    manifest.
                  </p>
                )}
              </div>
            )}
          </div>
        </Card>

        <LoopSteps loop={loop} proofs={proofOpen}>
          {/* The page's one Proof: it opens the steps' proof columns above it and holds the sandbox
            proof. Closed, it mounts nothing, so none of their reads run until a reader asks. How the
            totals reconcile and what each step cost to keep are not spelled out here: the figures are
            in the steps' rows, the money flow and `lath-audit`. */}
          {/* No summary beside it: _Proof_ is the word, and what it holds is a click away. */}
          <Proof testId="loop-proof">
            <ProofOpenSignal onChange={setProofOpen} />
            <div className="space-y-4">
              {/* Every step runs in a sandbox: the posture it was confined by, its tool calls and its
                replay record are on the loop's ZeroClaw page. Last in the Proof, and named for the loop. */}
              <Link href={`/zeroclaw/${loop.id}`} className="link text-xs" data-testid="loop-zeroclaw-link">
                Agent Loop Sandbox proof
              </Link>
            </div>
          </Proof>
        </LoopSteps>

        {/* Every paid call as its Solana record beside its Tempo payment, open under the steps: the
          pairing is Lath's claim, so it is not behind the Proof. Refetched whenever a step lands: the
          step count and the last seq move together. */}
        <div data-testid="loop-costs">
          <DualRailPanel
            agentId={loop.agentId}
            title="Every model call: its Solana record and its Tempo payment"
            refreshOn={`${loop.steps}:${loop.lastSeq ?? ""}`}
          />
        </div>

        {/* Under the steps, each folded to its header, in the order the run happened on its rails:
          Solana records it, SAS attests it, Tempo paid for it. The steps are what a reader came for, and these three are the run's accounts of them.

          The run's lifecycle records on its agent's chain (`sdk/src/lifecycle.ts`): started, paused,
          resumed, stopped, each with its seq and transaction, and what is still being recorded. Nothing
          on a run from before the records. */}
        <LoopChainBlock loop={loop} />

        {/* The loop's receipt on SAS: waiting for Jev's achieved, then the attestation and its
          transaction, or why there is none. Nothing on a loop whose policy commits no receipt. No
          protocol plugins card (`components/LoopPlugins.tsx`): a row whose policy names grants says
          so in the one line under its status. */}
        <LoopReceipt loop={loop} />

        {/* Every way the treasury paid on Tempo for this run, whose
          cost each is, and the transactions. */}
        <TempoPaymentsCard loop={loop} />
      </div>
    </div>
  );
}

/**
 * Tells the page the `Proof` is open: it is a child of the disclosure's body, which mounts only while
 * open, so its mount and unmount are the open and the close. The page needs to know because the steps'
 * proof columns sit in the table above the body, not inside it, and `Proof` keeps its state to itself.
 */
function ProofOpenSignal({ onChange }: { onChange: (open: boolean) => void }) {
  useEffect(() => {
    onChange(true);
    return () => onChange(false);
  }, [onChange]);
  return null;
}

// `useLayoutEffect` so the goal's _more_ is there on the first paint; the server has no layout, and there it
// is the plain effect, which React never runs anyway.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The goal's text, clamped to two lines with a _more_ toggle: a goal is often a paragraph, and four
 * lines of it would push the money flow and the steps down the page. The
 * whole text stays in the document either way — the clamp is CSS — so a find in the page, a screen
 * reader and a spec reading the well all still have every word. The toggle shows only when the text
 * overflows the two lines, measured after layout and again on resize.
 */
function ClampedText({ text, testId }: { text: string; testId?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Measured while clamped: open, the box is as tall as its text and nothing overflows.
      if (!open) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, open]);
  return (
    <div className="mt-1">
      <p
        ref={ref}
        className={`whitespace-pre-wrap text-sm leading-relaxed text-ink-1 ${open ? "" : "line-clamp-2"}`}
        data-testid={testId}
      >
        {text}
      </p>
      {(overflows || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid={testId ? `${testId}-more` : undefined}
          className="mt-0.5 text-2xs text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink-1"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

/**
 * The finish note, one of the stop reasons in words, every one of them kept. A tempo-key stop is
 * drawn neutral: Tempo refusing a payment past the key's limit is the cap working, not a fault.
 */
function FinishNote({ loop, figures }: { loop: LoopView; figures: ReturnType<typeof loopBudgetFigures> }) {
  if (loop.status === "running") return null;
  // A run stopped on `anchor-failed` gets its own sentence, because the usual one would be wrong:
  // the step ran, the model answered, and its output is in the trace store under the hash the records
  // commit to. What did not happen is the writes, still in the server's journal waiting to be sent
  // again — so the thing to say is which half failed, and the thing to offer is Retry the step.
  if (loop.stopReason === "anchor-failed")
    return (
      <ErrorNote>
        Not anchored: the work of this run&apos;s last step was done and its chain writes were not. The step ran, the
        answer is in the trace store, and the records are held in this server&apos;s journal — nothing was lost and
        nothing has to be run again. <em>Retry the step</em> sends them, and the run goes back on its schedule if they
        land.
        {loop.stopDetail ? ` (${loop.stopDetail})` : ""}
        {/* After a Retry answered _head diverged_ the chain has moved where these records can never
          land, and the way out is to give them up — said here, before the button, with who pays. */}
        {loop.anchorDiverged && (
          <span className="mt-2 block" data-testid="loop-diverged-note">
            A Retry found this chain has moved where these records can never land: another write took the seq they were
            built for. <em>Discard</em> drops them, and they and the step&apos;s charge never reach the chain. The model
            calls were paid from Lath&apos;s treasury on Tempo, so the operator carries that cost, not you.
          </span>
        )}
      </ErrorNote>
    );
  if (loop.stopReason === "anchor-discarded")
    // A loss, and a decided one: what was dropped and whose money it was, in `discardDetail`'s words.
    return (
      <ErrorNote>
        <span data-testid="loop-discarded-note">Stopped: {LOOP_STOP_REASON_TEXT["anchor-discarded"]}</span>.
        {loop.stopDetail ? ` ${loop.stopDetail}` : ""}
      </ErrorNote>
    );
  if (loop.stopReason === "escalated")
    // The one stop reason whose code says nothing: a second model judged the last step outside the
    // loop's bounds and the runner obeyed it. The wording is `LOOP_STOP_REASON_TEXT`'s.
    return (
      <ErrorNote>
        <span data-testid="loop-escalated-note">Stopped: {LOOP_STOP_REASON_TEXT.escalated}</span>. The step that earned
        it is the last one below; its verdict and the confidence behind it are committed in the step&apos;s record and
        open from that row.
        {loop.stopDetail ? ` (${loop.stopDetail})` : ""}
      </ErrorNote>
    );
  if (loop.stopReason === "budget" && stoppedOnStepBudget(loop))
    // A row written before loops had one budget: its sessions commit a per-step `maxCost`, and one
    // step reached it.
    return (
      <Note tone="warn">
        <span data-testid="loop-budget-stop">Stopped: {LOOP_STEP_BUDGET_STOP_TEXT}</span> —{" "}
        <span className="num">{formatUsdc(figures.spent)}</span> USDC spent over {loop.steps} of {loop.maxSteps} steps.{" "}
        <em>Run again</em> starts a new loop with one budget for the whole run.
        {loop.stopDetail ? ` (${loop.stopDetail})` : ""}
      </Note>
    );
  if (loop.stopReason === "budget")
    // The loop drew its one budget down to nothing: not a failure, nothing owed.
    return (
      <Note tone="warn">
        <span data-testid="loop-budget-stop">Stopped: {LOOP_STOP_REASON_TEXT.budget}</span> —{" "}
        <span className="num">{formatUsdc(figures.spent)}</span> of{" "}
        <span className="num">{trimUsdc(figures.budget)}</span> USDC over {loop.steps} of {loop.maxSteps} steps.{" "}
        <em>Run again</em> starts a new loop with a budget of its own.
        {loop.stopDetail ? ` (${loop.stopDetail})` : ""}
        {lostStepsSentence(loop) && <span data-testid="loop-lost-steps">{lostStepsSentence(loop)}</span>}
      </Note>
    );
  if (tempoKeyStopText(loop.stopReason))
    // A stop the loop's Tempo access key caused: the cap doing its job, or the key past its expiry or
    // gone. Neutral, as the badge and the spine node are: nothing is owed and nothing failed.
    return (
      <Note>
        <span data-testid="loop-tempo-key-stop">Stopped: {tempoKeyStopText(loop.stopReason)}</span>.
        {loop.stopDetail ? ` (${loop.stopDetail})` : ""}
      </Note>
    );
  if (loop.stopReason === "goal-reached") {
    // The one ending that is good news: a step's answer said the goal was reached (or the decision
    // model judged it so), its `loop.step` carries 201, and the run stopped there. One line; the rest
    // is the title, since the Steps table shows each of those.
    const jev = jevAchieved(loop);
    return (
      <Note tone="volt">
        <span
          title={
            jev
              ? `The step the decision model judged is the last one below, at status 201, and its answer is committed in its record. The goal is committed in every step's manifest. Run: ${loop.steps} of ${loop.maxSteps} steps.`
              : `The step that said so is the last one below, at status 201; the goal it was judged against is committed in every step's manifest. Run: ${
                  loop.steps
                } of ${loop.maxSteps} steps.${
                  loop.stopDetail && !loop.stopDetail.startsWith("goal reached") ? ` ${loop.stopDetail}` : ""
                }`
          }
        >
          <span data-testid="loop-goal-reached">Goal reached at step {loop.steps}</span>
          {jev ? (
            <>
              {" "}
              —{" "}
              <span data-testid="loop-goal-jev">
                the decision model judged it achieved
                {typeof jev.confidence === "number" ? ` (${jev.confidence.toFixed(2)})` : ""}
              </span>
            </>
          ) : (
            " — the agent said so"
          )}
          .
          {/* The steps lost on the way: the model did not answer, the loop went
            on, and Lath paid for the lost calls. */}
          {lostStepsSentence(loop) && <span data-testid="loop-lost-steps">{lostStepsSentence(loop)}</span>}
        </span>
        {/* The answer in one sentence and the button to the whole of it, in a tab of its own, so the
          run's page stays where the reader was. */}
        <AnswerSummary loop={loop} />
      </Note>
    );
  }
  // The reason decides there is a sentence, not the detail: `max-steps` is the commonest ending and
  // the runner writes no `stopDetail` for it, so the count stands in for it.
  if (!loop.stopDetail && !loop.stopReason) return null;
  // A run that finished, or that its owner or its budget stopped, is not a failure.
  const body = (
    <>
      {loop.stopReason === "max-steps" || loop.stopReason === "goal-reached" ? "Finished: " : "Stopped: "}
      {loop.stopDetail ??
        (loop.stopReason === "max-steps"
          ? `${loop.steps} of ${loop.maxSteps} steps`
          : loopStopReasonText(loop) ?? loop.stopReason)}
      {lostStepsSentence(loop) && <span data-testid="loop-lost-steps"> ·{lostStepsSentence(loop)}</span>}
    </>
  );
  if (loop.stopReason === "max-steps") return <Note tone="good">{body}</Note>;
  if (loop.stopReason && NEUTRAL_STOPS.has(loop.stopReason)) return <Note>{body}</Note>;
  return <ErrorNote>{body}</ErrorNote>;
}

/**
 * The run's configuration, one short line each: what decides a step and how often, the model, and who
 * judges the steps. A term the run did not set (a template, a verifier) is left out
 * rather than said to be off; each line's longer explanation is its hover text. Every line is in each
 * step's policy hash.
 */
function LoopConfiguration({ loop, money }: { loop: LoopView; money: ReturnType<typeof loopMoney> }) {
  const trigger = triggerOf(loop);
  // A gated row's interval was its poll; the one line under the run's status names the gate
  // (`EarlierBuildNote`), and this row says only how often it looked.
  const polls = trigger.kind === "gate" || trigger.kind === "request";
  const every = formatInterval(
    trigger.kind === "gate" || trigger.kind === "request" ? trigger.pollMs : loop.intervalMs
  );
  // What decides a step, which is not the same question as how often: a request loop's interval is
  // how often it *looks*.
  const triggerHint =
    trigger.kind === "request"
      ? "steps when a pending oracle request names this agent's key"
      : trigger.kind === "feed"
      ? "steps on the interval, and publishes every step's value to this loop's one feed account"
      : "steps on the interval; nothing off this chain is written";
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "Runs",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2" title={triggerHint}>
          <span data-testid="loop-trigger">
            <Badge tone={trigger.kind === "schedule" ? "neutral" : "good"}>{triggerLabel(trigger)}</Badge>
          </span>
          <span className="num text-ink-1">
            {polls ? `polls ${every}` : every} · up to {loop.maxSteps} steps
          </span>
        </span>
      ),
    },
    {
      label: "Model",
      // Decided by the run's rail before the stored `inference` label: a loop that opened a Tempo
      // channel paid OpenRouter via Tempo whatever the server's model key was (`loop-money.ts`).
      value: (
        <span className="font-mono text-ink-1" title={money.note || undefined}>
          {loop.model}
        </span>
      ),
    },
    // Jev's goal check, on a goal run only.
    ...(loop.goalHash
      ? [
          {
            label: "Goal checked by",
            value: loop.goalCheck ? (
              <span className="font-mono text-ink-1" title={GOAL_CHECK_COPY} data-testid="loop-goal-check-terms">
                {loop.goalCheck.model} <span className="text-ink-3">&#8805; {loop.goalCheck.minConfidence}</span>
              </span>
            ) : (
              <span
                className="text-ink-3"
                title="this run ends when a step writes GOAL REACHED; the decision model was not asked to check it"
              >
                the agent itself
              </span>
            ),
          },
        ]
      : []),
    // What the verdict is and is not, as the hover, where the term is stated.
    ...(loop.verify
      ? [
          {
            label: "Verified by",
            value: (
              <span className="font-mono text-ink-1" title={VERIFY_TERMS_COPY} data-testid="loop-verify-terms">
                {loop.verify.model} <span className="text-ink-3">&#8805; {loop.verify.minConfidence}</span>
              </span>
            ),
          },
        ]
      : []),
    // The lineage key, and only that: what the chain commits per session is `policy_version_hash`,
    // built from what that session ran with.
    ...(loop.template
      ? [
          {
            label: "Template",
            value: (
              <span title="the config this run was started from; the console's lineage key, not a chain fact">
                <TemplateLine loop={loop} className="text-xs" />
              </span>
            ),
          },
        ]
      : []),
  ];
  return (
    <div className="well px-3 py-2.5" data-testid="loop-terms-section">
      <div className="flex items-center gap-1.5">
        <span className="eyebrow">Configuration</span>
      </div>
      <dl
        className="mt-1.5 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[7.5rem_minmax(0,1fr)]"
        data-testid="loop-terms"
      >
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-ink-3 sm:pt-px">{r.label}</dt>
            <dd className="min-w-0">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * `/loop/<id>#sandbox` is a link to the sandbox as a tab beside the records, which older sandbox
 * step links carry; the sandbox is its own page, so such a link lands there with its `?step=` /
 * `?sandbox=` query rather than on the records page.
 */
function useSandboxRedirect(id: string) {
  useEffect(() => {
    if (window.location.hash === "#sandbox") window.location.replace(`/zeroclaw/${id}${window.location.search}`);
  }, [id]);
}

/**
 * The one line a row that ran with a feature this build does not have carries (`earlierBuildSentence`):
 * a team, a gate, an oracle trigger, the trace audit or grants. This page draws no card for any of them;
 * what the run did with it is on its chain. Nothing on any other run, which is every run this build
 * starts.
 */
function EarlierBuildNote({ loop }: { loop: LoopView }) {
  const sentence = earlierBuildSentence(loop.earlierBuild);
  if (!sentence) return null;
  return (
    <div data-testid="loop-earlier-build" data-features={loop.earlierBuild?.join(" ")}>
      <Note>{sentence}</Note>
    </div>
  );
}

/**
 * The loop's one budget on its terms card: spent against the budget,
 * what is left, and the meter the allowance panels draw, amber once less than 15% is left.
 *
 * Lath's Jev share sits under it and not inside it, in its own unit: it is USDC.e the operator
 * pays on Tempo, never charged to the owner, so adding it to the owner's USDC
 * figure would put a cost on the owner's line that is not theirs. When it is spent the line says
 * what that changes — gate asks go scripted, verify and goal checks go unasked — and that the loop
 * keeps running, because the owner, not Lath's share, decides when it stops.
 */
function LoopBudgetMeter({
  figures,
  size = "md",
}: {
  figures: ReturnType<typeof loopBudgetFigures>;
  /** `lg` at the top of the page, where the budget is the figure the page leads with. */
  size?: "md" | "lg";
}) {
  const pct = Math.round(figures.fraction * 100);
  const left = figures.budget > 0n ? Number((figures.remaining * 100n) / figures.budget) : 0;
  return (
    <div className="min-w-[14rem] space-y-1.5" data-testid="loop-budget">
      {size === "lg" ? (
        // Spent large, the budget beside it and what is left under it, so the three figures fit the
        // narrow column at the top of the page without wrapping mid-sentence.
        <div className="space-y-0.5">
          <div className="num text-ink-1">
            <span className="text-xl" data-testid="loop-budget-spent">
              {formatUsdc(figures.spent)}
            </span>{" "}
            <span className="text-xs text-ink-3">USDC spent</span>
          </div>
          <div className="num text-xs text-ink-2">
            <span className="text-ink-3">of a </span>
            {trimUsdc(figures.budget)}
            <span className="text-ink-3"> USDC budget · </span>
            <span data-testid="loop-budget-remaining">{formatUsdc(figures.remaining)}</span>
            <span className="text-ink-3"> left</span>
          </div>
        </div>
      ) : (
        <div className="num text-xs text-ink-1">
          <span data-testid="loop-budget-spent">{formatUsdc(figures.spent)}</span>{" "}
          <span className="text-ink-3">USDC spent of a </span>
          {trimUsdc(figures.budget)}
          <span className="text-ink-3"> USDC budget · </span>
          <span data-testid="loop-budget-remaining">{formatUsdc(figures.remaining)}</span>
          <span className="text-ink-3"> left</span>
        </div>
      )}
      <div
        className={`${size === "lg" ? "h-1.5" : "h-1"} w-full overflow-hidden rounded-full bg-line/[0.08]`}
        role="meter"
        aria-label="loop budget spent"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className={`h-full transition-all duration-300 ${left < 15 ? "bg-amber-400" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* Lath's decision share is the budget's `Info` (`BudgetInfo`). */}
    </div>
  );
}

/**
 * Jev's goal answer on the step that ended the run, when Jev's check is what ended it: the last step of the history, and only when its answer was `achieved`.
 * `null` on a run stopped by the step's own claim, which keeps its own sentence.
 */
function jevAchieved(loop: LoopView): { confidence?: number } | null {
  const last = loop.history[loop.history.length - 1];
  const g = last?.goalCheck;
  return g && g.outcome === "achieved" ? { confidence: g.confidence } : null;
}
