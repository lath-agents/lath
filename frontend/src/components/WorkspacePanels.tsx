"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { hex } from "@lath/sdk/browser";
import { ArrowIcon, Badge, Copyable, FactRow, Facts, Fact, Info, Proof, SOURCE_TITLE } from "@/components/ui";
import { SplitDetail, SplitSection } from "@/components/Split";
import { LoopMoneyFlow } from "@/components/LoopTempoServices";
import { LoopStatusBadge, RetryStepButton, RunAgainButton } from "@/components/LoopList";
import { LoopStepSpine } from "@/components/LoopSpine";
import { LoopControls } from "@/components/LoopControls";
import { AgentChainLine, RebuiltBadge } from "@/components/LoopChain";
import { toolDisplayName } from "@/components/OwnerHeaderCard";
import { TempoMark } from "@/components/Tempo";
import type { WorkspaceAgent } from "@/components/WorkspaceYours";
import { formatTimestampMs, formatUsdc, isNoExpiry, relativeToNow, shortKey, truncate } from "@/lib/format";
import { loopBudgetFigures } from "@/lib/loop-money";
import { LoopView, formatInterval, untilStep, useLoopSteps, useVerifiedSteps } from "@/lib/loops";
import { useDeployedAgents } from "@/lib/market";
import { trimUsdc } from "@/lib/tiles";
import { runStatusLine } from "@/lib/run-status";
import { NestedAgent, runTempo, usdcEText } from "@/lib/workspace";

/**
 * The workspace's two inline panels: an agent's and a
 * run's, beside the Yours list. Each is the short version of its full page, which it links to; the
 * ids, hashes and seqs fold into one `Info`, and the run's long proof material into one `Proof`; the
 * agent's records are on its page.
 *
 * Every figure here is one a read already holds — the chain header and the wallet's grant, the
 * console's loop row, the agent's records — and says which on hover (`data-source` and a title,
 * rather than an inline tag). A figure none of them hold is not
 * drawn: no call counts, no balance guessed from a budget.
 */

const PANEL_LINK =
  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-2 transition-colors hover:bg-line/[0.05] hover:text-ink-1";
/** The landing page's filled button, a size down: the agent panel's one primary action. */
const PANEL_PRIMARY =
  "inline-flex h-8 items-center rounded-lg bg-accent px-3 text-xs font-semibold text-neutral-950 transition-colors hover:bg-accent-strong";

/* ------------------------------------------------------------------------------------------ */
/* The agent                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export function WorkspaceAgentPanel({
  agent,
  runs,
}: {
  agent: WorkspaceAgent;
  /** The agent's own row in the list, with its runs. */
  runs: NestedAgent<WorkspaceAgent, LoopView> | null;
}) {
  const { publicKey } = useWallet();
  const deployed = useDeployedAgents();
  const id = agent.agentId;
  const href = `/agent/${id}`;
  const header = agent.header;
  const owner = agent.owner;
  const row = agent.row;
  const reg = agent.registry;
  // _Run as a loop_ is the deployer's, as the loop form is: a step is billed to the wallet that
  // deployed the agent here, and `/api/loops` refuses anyone else (`ComposeLoopLink`'s rule).
  const deployedRow = deployed.data?.find((a) => a.id === id) ?? null;
  const canLoop = !!publicKey && !!deployedRow && deployedRow.owner === publicKey.toBase58();
  const latestRun = runs?.current?.loop ?? null;

  const facts: Fact[] = [
    { label: "Agent id", value: <Copyable value={id} display={truncate(id, 8, 6)} />, source: "chain", mono: true },
  ];
  if (header) {
    const authority = header.state.authority.toBase58();
    facts.push({
      label: "Authority",
      value: <Copyable value={authority} display={shortKey(authority)} href={`/authority/${authority}`} />,
      source: "chain",
      mono: true,
    });
    facts.push({ label: "Records (seq)", value: header.state.seq.toString(), source: "chain", mono: true });
    if (header.state.head) {
      const head = hex(header.state.head);
      facts.push({ label: "Head", value: <Copyable value={head} display={truncate(head, 6, 4)} />, source: "chain" });
    }
    facts.push({ label: "Since", value: formatTimestampMs(header.state.createdAt), source: "chain" });
  }
  if (owner?.relations.length)
    facts.push({
      label: "Your wallet",
      value: owner.relations.map((r) => (r === "signer" ? "signs for it" : "funds it")).join(" · "),
      source: "chain",
    });
  // The model and the tools are the panel's _Model_ row, so the ⓘ does not list them.
  const model = reg?.policy?.model ?? null;
  const tools = reg?.policy?.tools ?? [];
  if (reg?.template)
    facts.push({
      label: "Template",
      value: `${truncate(reg.template.id, 8, 4)} v${reg.template.version}`,
      source: "console",
      mono: true,
      title: `${reg.template.id} v${reg.template.version}`,
    });
  if (reg?.clonedFrom)
    facts.push({
      // A copy launched off another wallet's marketplace listing (`via: "market"` on its record; the
      // marketplace is not in this build) reads as a copy, with no market badge.
      label: reg.clonedFrom.via === "market" ? "Copied from" : "Cloned from",
      value: (
        <Link href={`/agent/${reg.clonedFrom.agentId}`} className="link">
          {reg.clonedFrom.name}
        </Link>
      ),
      source: "console",
    });

  const seq = header ? BigInt(header.state.seq.toString()) : null;

  return (
    <SplitDetail
      testId="owner-spine"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link href={href} className="transition-colors hover:text-accent-strong">
            {agent.name}
          </Link>
          <Info label={`About ${agent.name}`} triggerTestId="agent-info" testId="agent-info-body" wide>
            <Facts items={facts} />
          </Info>
        </span>
      }
      badges={
        <>
          {latestRun && latestRun.status !== "stopped" ? (
            <LoopStatusBadge loop={latestRun} />
          ) : row ? (
            <Badge tone={row.statusTone}>{row.statusLabel}</Badge>
          ) : null}
        </>
      }
      action={
        // _Agent details_, not _Open page_, and top right by the name rather than in the footer: it says
        // what is behind it, where a reader looks for the way to the full page.
        <Link href={href} className={PANEL_LINK} data-testid="agent-open">
          Agent details <ArrowIcon />
        </Link>
      }
      sub={row && !row.descriptionPlaceholder ? <p className="text-sm text-ink-2">{row.description}</p> : null}
      footer={
        // No _Ask_ here. _Run as a loop_ is the panel's one filled button, the thing to do next from it,
        // alone in the footer.
        canLoop ? (
          <Link
            href={`/create?loop=1&agent=${id}`}
            className={PANEL_PRIMARY}
            data-testid="compose-loop"
            title="Open the loop form with this agent chosen: a standing instruction, an interval, a step count and one budget for the whole loop"
          >
            Run as a loop
          </Link>
        ) : undefined
      }
    >
      {/* Labelled rows, one fact each. The agent's page holds everything else, so _Agent details_ is
          the one way there, and the only link in the rows is the deploy's transaction, which leaves the
          app. The _Loops_ row's sentence says how the latest run stands. */}
      <dl className="space-y-3 text-sm">
        {model && (
          <FactRow label="Model" testId="agent-model">
            <span className="font-mono text-xs" data-source="console" title={SOURCE_TITLE.console}>
              {model}
            </span>
            {tools.length > 0 && (
              <span className="text-xs text-ink-3" title={tools.map(toolDisplayName).join(", ")}>
                · {tools.length} {tools.length === 1 ? "tool" : "tools"}
              </span>
            )}
          </FactRow>
        )}
        <FactRow label="Budget" testId="agent-allowance">
          <AllowanceMeter owner={owner} />
        </FactRow>
        <FactRow label="Loops" testId="agent-loops-row">
          <AgentLoopsLine runs={runs} />
        </FactRow>
        <FactRow label="Tempo" testId="agent-tempo">
          <AgentTempoLine runs={runs} />
        </FactRow>
        <FactRow label="Solana" testId="agent-chain">
          <span className="num" data-source="chain" title={SOURCE_TITLE.chain}>
            {seq === null ? "reading its header…" : `${seq} ${seq === BigInt(1) ? "record" : "records"}`}
          </span>
          {/* The agent's deploy as its chain records it (`agent.deploy`), with what is still owed. Nothing
            for an older agent deployed without the records or read from a console that does not send them. */}
          <AgentChainLine chain={reg?.chain} />
        </FactRow>
      </dl>
    </SplitDetail>
  );
}

/**
 * What the wallet's grant has spent of its cap, a short meter and the expiry, on one line. The figure
 * leaves out the word _spent_: the row says _Budget_ and the hover says what the two numbers are.
 */
function AllowanceMeter({ owner }: { owner: WorkspaceAgent["owner"] }) {
  const grant = owner?.allowance;
  if (!grant) return <span className="text-ink-3">no grant from this wallet</span>;
  const pct = grant.cap > BigInt(0) ? Math.min(100, Number((grant.spent * BigInt(100)) / grant.cap)) : 100;
  const expired = Number(grant.expiresAt) * 1000 < Date.now() && !isNoExpiry(grant.expiresAt);
  return (
    <>
      <span className="num" title="spent so far, of the cap this wallet granted the agent's authority on Solana">
        {formatUsdc(grant.spent)} <span className="text-xs text-ink-3">of {trimUsdc(grant.cap)} USDC</span>
      </span>
      <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-line/[0.08]">
        <span
          className={`block h-full ${expired ? "bg-rose-400" : pct > 85 ? "bg-amber-400" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span suppressHydrationWarning className={`text-xs ${expired ? "text-rose-300" : "text-ink-3"}`}>
        {expired
          ? `expired ${relativeToNow(grant.expiresAt)}`
          : isNoExpiry(grant.expiresAt)
          ? "no expiry"
          : `expires ${relativeToNow(grant.expiresAt)}`}
      </span>
    </>
  );
}

/** The agent's runs as the list nested them: the one that speaks for it, then the rest. */
function runsOf(runs: NestedAgent<WorkspaceAgent, LoopView> | null): LoopView[] {
  if (!runs) return [];
  return [...(runs.current ? [runs.current.loop] : []), ...runs.earlier.map((r) => r.loop)];
}

/**
 * How many runs the agent has and how the one that speaks for it stands, in the Yours list's own
 * sentence (`runStatusLine`): _3 runs · Last run reached its goal · 2 h ago_.
 */
function AgentLoopsLine({ runs }: { runs: NestedAgent<WorkspaceAgent, LoopView> | null }) {
  const all = runsOf(runs);
  if (all.length === 0) return <span className="text-ink-3">none yet</span>;
  return (
    <span suppressHydrationWarning data-source="console" title={SOURCE_TITLE.console}>
      <span className="text-ink-3">
        {all.length} {all.length === 1 ? "run" : "runs"} ·{" "}
      </span>
      {runStatusLine(all[0], Date.now())}
    </span>
  );
}

/**
 * What Lath Tempo paid OpenRouter for this agent's runs, summed from the console's run rows
 * (`runTempo`). It is the console's tally: each run's page checks its payments on Tempo itself, which
 * the hover says. A run whose row kept only its last steps makes the sum a floor, said as _at least_.
 */
function AgentTempoLine({ runs }: { runs: NestedAgent<WorkspaceAgent, LoopView> | null }) {
  const all = runsOf(runs);
  const tempo = all.map(runTempo);
  const paid = tempo.reduce((sum, t) => sum + (t.paidBase ?? BigInt(0)), BigInt(0));
  const onTempo = tempo.filter((t) => t.onTempo).length;
  if (onTempo === 0) return <span className="text-ink-3">nothing paid yet</span>;
  const floor = tempo.some((t) => t.capped);
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1"
      data-source="console"
      title="The console's tally of each run's vouchers; each run's page checks its payments on Tempo"
    >
      <TempoMark />
      <span className="num">
        {floor ? "at least " : ""}
        {usdcEText(paid)} USDC.e
      </span>
      <span className="text-ink-3">
        paid to OpenRouter across {onTempo} {onTempo === 1 ? "run" : "runs"}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The run                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** "every 15 min", or what a trigger that is not the clock steps on. */
function cadence(loop: LoopView): string {
  const trigger = loop.trigger ?? { kind: "schedule" };
  if (trigger.kind === "gate") return `gated, looks ${formatInterval(trigger.pollMs)}`;
  if (trigger.kind === "request") return "steps on request";
  if (trigger.kind === "feed") return `feed, ${formatInterval(loop.intervalMs)}`;
  return formatInterval(loop.intervalMs);
}

export function WorkspaceRunPanel({ loop }: { loop: LoopView }) {
  const budget = loopBudgetFigures(loop);
  const pct = Math.round(budget.fraction * 100);
  const decision = [...(loop.history ?? [])].reverse().find((h) => h.goalCheck);
  const href = `/loop/${loop.id}`;

  return (
    <SplitDetail
      testId="loop-spine"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link href={href} className="transition-colors hover:text-accent-strong">
            {loop.agentName}
          </Link>
          <span className="text-sm font-normal text-ink-3">loop run</span>
          <Info label="About this run" triggerTestId="run-info" testId="run-info-body" wide>
            <Facts
              items={[
                { label: "Run", value: <Copyable value={loop.id} display={truncate(loop.id, 10, 4)} />, mono: true },
                {
                  label: "Agent",
                  value: (
                    <Copyable
                      value={loop.agentId}
                      display={truncate(loop.agentId, 8, 4)}
                      href={`/agent/${loop.agentId}`}
                    />
                  ),
                  source: "chain",
                },
                { label: "Model", value: loop.model, source: "console", mono: true, title: loop.model },
                { label: "Cadence", value: cadence(loop), source: "console" },
                ...(loop.lastHead
                  ? [
                      {
                        label: "Head",
                        value: <Copyable value={loop.lastHead} display={truncate(loop.lastHead, 6, 4)} />,
                        source: "console" as const,
                        title: "the head after the last step, as the console recorded it; the run's page checks it",
                      },
                    ]
                  : []),
                ...(loop.template
                  ? [
                      {
                        label: "Template",
                        value: `${truncate(loop.template.id, 8, 4)} v${loop.template.version}`,
                        source: "console" as const,
                        mono: true,
                      },
                    ]
                  : []),
                { label: "Started", value: formatTimestampMs(loop.createdAt), source: "console" },
              ]}
            />
          </Info>
        </span>
      }
      badges={
        <>
          <LoopStatusBadge loop={loop} />
          {/* Why its controls below are disabled, on a run rebuilt from the chain; nothing otherwise. */}
          <RebuiltBadge chain={loop.chain} testId="run-panel-chain-rebuilt" />
        </>
      }
      sub={
        <span suppressHydrationWarning>
          step {loop.steps} of {loop.maxSteps} · {cadence(loop)}
          {loop.status === "running" && !loop.stepping && (
            <>
              {" "}
              · next step {loop.trigger?.kind === "gate" ? "when the decision model says" : untilStep(loop.nextStepAt)}
            </>
          )}
          {loop.stepping && <> · a step is running</>}
        </span>
      }
      action={
        // _Run details_, top right, as the agent panel's _Agent details_: the one link to the run's page.
        <Link href={href} className={PANEL_LINK} data-testid="run-open">
          Run details <ArrowIcon />
        </Link>
      }
    >
      <div className="space-y-4">
        <div className="well px-3 py-2.5" data-testid="run-budget">
          <div className="flex items-baseline justify-between gap-2">
            {/* The console's figure, said on hover rather than by a tag. */}
            <span className="eyebrow" data-source="console" title={SOURCE_TITLE.console}>
              Loop budget
            </span>
            <span className="num text-xs text-ink-2">
              {formatUsdc(budget.spent)} <span className="text-ink-3">of {trimUsdc(budget.budget)} USDC</span>
            </span>
          </div>
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/[0.08]"
            role="meter"
            aria-label="Loop budget spent"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div className={`h-full ${pct > 85 ? "bg-amber-400" : "bg-accent"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        <RunMoneyFlow loop={loop} />

        {(loop.goal || decision?.goalCheck) && (
          <div className="space-y-1 text-sm text-ink-2" data-testid="run-goal">
            {loop.goal && <ClampedGoal goal={loop.goal} />}
            {decision?.goalCheck && (
              <p className="text-xs" data-testid="run-decision">
                <span className="text-ink-3">Latest decision, after step {decision.step}:</span>{" "}
                {decision.goalCheck.outcome === "unavailable"
                  ? "the decision model did not answer"
                  : decision.goalCheck.outcome === "achieved"
                  ? "achieved — the goal is met"
                  : "continue"}
                {decision.goalCheck.confidence !== undefined && decision.goalCheck.outcome !== "unavailable"
                  ? ` · ${Math.round(decision.goalCheck.confidence * 100)}% sure`
                  : ""}
              </p>
            )}
          </div>
        )}

        <SplitSection title="Last answer">
          <RunLastAnswer loop={loop} />
        </SplitSection>

        <LoopControls loop={loop}>
          <RunAgainButton loop={loop} size="sm" />
          <RetryStepButton loop={loop} size="sm" />
        </LoopControls>

        <Proof summary={stepsKept((loop.history ?? []).length)} testId="run-proof">
          <div className="space-y-3">
            <LoopStepSpine loop={loop} verdict={false} />
            <Link href={href} className="link text-xs" data-testid="run-proof-open">
              Run details → every step verified against the chain
            </Link>
          </div>
        </Proof>
      </div>
    </SplitDetail>
  );
}

/** "1 step kept by the console", "3 steps …", never "1 steps". */
function stepsKept(n: number): string {
  return `${n} ${n === 1 ? "step" : "steps"} kept by the console`;
}

/**
 * The goal, two lines and a _more_: a loop's standing instruction runs to a paragraph, and in full it
 * would push the answer and the controls below the fold. The toggle
 * is drawn only when the clamp actually cut something, measured after layout.
 */
function ClampedGoal({ goal }: { goal: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setCut(el.scrollHeight > el.clientHeight + 1);
  }, [goal, open]);
  return (
    <div>
      <p ref={ref} className={open ? "" : "line-clamp-2"} data-testid="run-goal-text">
        <span className="text-ink-3">Goal:</span> {goal}
      </p>
      {(cut || open) && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-xs text-ink-3 underline decoration-dotted underline-offset-2 transition-colors hover:text-ink-1"
          data-testid="run-goal-more"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

/**
 * The money flow, compact: the loop page's own `LoopMoneyFlow` in its compact form, so the
 * workspace and the loop page draw the same figures from one code path — the settlement checked
 * against Tempo's receipt in this browser (`useTempoCloseDetails`), the escrow and treasury links and
 * the open channel's split included. Its boxes carry `money-flow-*` testids; `run-money-flow` stays on
 * this wrapper for the panel's own selectors.
 *
 * One line is the panel's, because the compact flow leaves it out: the console's 50-row history cap, which makes a long run's
 * figures a floor rather than its total — `runTempo` is what knows that, and the flow does not ask.
 */
function RunMoneyFlow({ loop }: { loop: LoopView }) {
  const { capped } = runTempo(loop);
  return (
    <div className="space-y-1.5" data-testid="run-money-flow">
      <LoopMoneyFlow loop={loop} variant="compact" />
      {/* No who-pays sentence, as under the loop page's flow; the history cap is said, because without
          it a long run's figures read as its total. */}
      {capped && (
        <p className="text-2xs leading-relaxed text-ink-3" data-testid="run-money-flow-capped">
          The figures cover the last 50 steps per loop the console keeps.
        </p>
      )}
    </div>
  );
}

/**
 * The run's newest answer: the memory its newest verified step left, re-hashed against that step's
 * manifest — the read the loop page's Plan and Steps table make (`useVerifiedSteps`), under the same
 * cache keys.
 */
function RunLastAnswer({ loop }: { loop: LoopView }) {
  const steps = useLoopSteps(loop.agentId);
  const verified = useVerifiedSteps(loop, steps.data);
  if (steps.isLoading || verified.isLoading) return <p className="text-sm text-ink-3">Reading the run&apos;s steps…</p>;
  if (steps.isError || verified.isError)
    return <p className="text-sm text-ink-3">Could not read this run&apos;s steps from the chain.</p>;
  const latest = [...(verified.data ?? [])].reverse().find((r) => r.left && r.left.verdict !== "missing");
  if (!latest?.left) return <p className="text-sm text-ink-3">No step has left a verified answer yet.</p>;
  const left = latest.left;
  // An answer written encrypted: a dash, as the Steps table draws it.
  if (left.verdict === "encrypted") return <p className="text-sm text-ink-3">—</p>;
  if (left.verdict !== "ok" || !left.text)
    return (
      <p className="text-sm text-ink-3">
        Step {latest.index}&apos;s answer could not be checked here ({left.verdict}); the run&apos;s page says why.
      </p>
    );
  return (
    <div data-testid="run-last-answer">
      <div className="line-clamp-4 whitespace-pre-line text-sm text-ink-2" title={left.text}>
        {left.text}
      </div>
      <div className="mt-1 text-2xs text-ink-3" data-source="chain" title={SOURCE_TITLE.chain}>
        step {latest.index} · re-hashed against its manifest
      </div>
    </div>
  );
}
