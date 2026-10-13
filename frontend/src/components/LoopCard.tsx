"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ArrowIcon, Badge, Button, Card, FactRow, Skeleton } from "@/components/ui";
import { GoalPlan } from "@/components/GoalPlan";
import { LoopMoneyFlow } from "@/components/LoopTempoServices";
import { LoopControls } from "@/components/LoopControls";
import { LoopStatusBadge, RunAgainButton } from "@/components/LoopList";
import { verifyTermsLabel } from "@/components/loop-terms";
import { relativeToNow, truncate } from "@/lib/format";
import { LoopView, useLoops, useLoopsOfAgent } from "@/lib/loops";
import { loopBudgetFigures } from "@/lib/loop-money";
import { agoLabel, trimUsdc } from "@/lib/tiles";
import { triggerLabel, triggerOf } from "@/lib/loop-trigger";
import { runStatusLine } from "@/lib/run-status";
import { useDeployedAgents } from "@/lib/market";

/**
 * The agent page's _Loops_ row and its buttons. A loop is a schedule attached to an agent, not a
 * second kind of thing, so the agent's header says how its loops stand on one line, and the buttons
 * sit under the rows rather than in a card of their own, which for an agent with no runs would hold
 * one button and nothing saying so.
 *
 * While a run is live the row carries its controls under the sentence — pause, stop, how far it is,
 * what it last remembered — and the loop's own page (`/loop/[id]`) is the full record with every step
 * verified. With nothing running the row is the last run's sentence (`runStatusLine`, the Yours list's
 * words) and its link, and the buttons are _Run as a loop_, which opens the loop form at
 * `/create?loop=1&agent=<id>` with this agent chosen (the form is not inline on the agent page), and
 * _Run again_, which starts a new run on the last run's terms.
 *
 * Only the wallet that deployed the agent sees either: a step is a session signed on that wallet's
 * behalf and billed to its allowance, exactly like a message sent from the Ask card. One running loop
 * per agent is the server's rule, so the row never has to show two runs.
 */
function useAgentLoops(id: string) {
  const { publicKey } = useWallet();
  const deployed = useDeployedAgents();
  const row = deployed.data?.find((a) => a.id === id.toLowerCase()) ?? null;
  const wallet = publicKey?.toBase58() ?? null;
  // This agent's runs, newest first. Archived ones are not in the answer, so the last run named
  // here is the last one the owner still cares about.
  const loops = useLoops(wallet);
  const mine = (loops.data?.loops ?? []).filter((l) => l.agentId === id.toLowerCase() && l.owner === wallet);
  // The run the row is about while one is live: running or paused. A stopped run is history, and
  // history offers *Run again* beside *Run as a loop* rather than controls that can do nothing.
  const live = mine.find((l) => l.status === "running" || l.status === "paused") ?? null;
  // Not deployed here (a console agent, or someone else's chain): nothing to schedule.
  const owned = !!row && !!wallet && row.owner === wallet;
  return { row, owned, live, lastRun: mine[0] ?? null, reading: loops.isLoading };
}

/** The _Loops_ row: the run's sentence, its link, and a live run's controls under it. */
export function LoopRow({ id }: { id: string }) {
  const { owned, live, lastRun, reading } = useAgentLoops(id);
  if (!owned) return null;
  const run = live ?? lastRun;
  return (
    <FactRow label="Loops" id="loop" className="scroll-mt-20" testId="loop-row">
      {reading ? (
        <span className="text-ink-3">reading…</span>
      ) : !run ? (
        <span className="text-ink-3" data-testid="loop-card-idle">
          none yet
        </span>
      ) : (
        <>
          <span suppressHydrationWarning data-testid={live ? undefined : "loop-card-last-run"}>
            {runStatusLine(run, Date.now())}
          </span>
          {/* What woke that run's steps, said only when it was not the clock. A trigger is the
              caller's on every start, not part of a template's stored config, so *Run again*
              starts a scheduled run; the one exception is a gate, which is a term of the run and
              starts gated again. */}
          {triggerOf(run).kind !== "schedule" && <Badge tone="good">{triggerLabel(triggerOf(run))}</Badge>}
          {!live && (
            <Link href={`/loop/${run.id}`} className="link text-xs" title={run.id}>
              Open run →
            </Link>
          )}
        </>
      )}
      {live && (
        <div className="w-full pt-3">
          <LiveRun loop={live} />
        </div>
      )}
    </FactRow>
  );
}

/**
 * _Run as a loop_ and _Run again_, the header's button row; nothing while a run is live, whose
 * controls are in the _Loops_ row above. The agent page lists its loop runs rather than drawing a
 * chat, so _Ask this agent_ is not in this row.
 */
export function LoopActions({ id }: { id: string }) {
  const { row, owned, live, lastRun } = useAgentLoops(id);
  if (!owned || !row || live) return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2" data-testid="agent-actions">
      <Link
        href={`/create?loop=1&agent=${row.id}`}
        data-testid="loop-card-compose"
        title="Open the loop form with this agent chosen: a goal, an interval, a step count and one budget for the whole loop"
      >
        <Button size="sm">Run as a loop</Button>
      </Link>
      {/* The cheapest way to run this agent again is the terms it ran on last time.
          `RunAgainButton` draws itself only where a run can be started again from them. */}
      {lastRun && <RunAgainButton loop={lastRun} size="sm" />}
    </div>
  );
}

/**
 * Every loop run of this agent, newest first, on the agent page. A run is named by its goal, or its standing
 * instruction when it has none, and reads its status, how far it got, what it spent of its budget and when it started;
 * the row is the link to the run's page, where every step is verified.
 *
 * Always drawn, for every wallet, with _No loop runs yet._ when there are none: it reads the agent's runs, not the
 * wallet's (`useLoopsOfAgent`), so another wallet's agent, and one deployed before ownership was recorded, list theirs
 * too. Archived runs are not in the registry's list.
 */
export function AgentLoopList({ id }: { id: string }) {
  const runs = useLoopsOfAgent(id);
  const list = runs.data ?? [];
  const now = Date.now();
  return (
    <Card
      title="Loop runs"
      right={runs.data ? <span className="text-xs text-ink-3">{list.length}</span> : undefined}
      id="loops"
    >
      {runs.isLoading ? (
        <Skeleton rows={3} />
      ) : runs.isError ? (
        <p className="text-sm text-ink-3">The console did not answer for this agent&apos;s loop runs.</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-3" data-testid="agent-loops-empty">
          No loop runs yet.
        </p>
      ) : (
        <ul className="-mx-2 divide-y divide-line/[0.06]" data-testid="agent-loops">
          {list.map((loop) => {
            const budget = loopBudgetFigures(loop);
            const what = loop.goal ?? loop.prompt ?? null;
            return (
              <li key={loop.id}>
                <Link
                  href={`/loop/${loop.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2.5 transition-colors hover:bg-line/[0.03]"
                  data-testid="agent-loop-row"
                  data-loop-id={loop.id}
                >
                  <LoopStatusBadge loop={loop} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-1" title={what ?? loop.id}>
                    {what ?? <span className="font-mono text-ink-3">{truncate(loop.id, 10, 4)}</span>}
                  </span>
                  <span suppressHydrationWarning className="num text-xs text-ink-3">
                    {loop.steps} of {loop.maxSteps} steps · {trimUsdc(budget.spent)} of {trimUsdc(budget.budget)} USDC ·{" "}
                    {agoLabel(loop.createdAt, now)}
                  </span>
                  <ArrowIcon />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * The run, in the _Loops_ row: where it is, when it moves next, what it has spent and where that money
 * went, what it last remembered, and the controls. Every number here is the registry's — the chain's version of the
 * same run, each step verified against its leaf, is one click away on the loop's page.
 */
function LiveRun({ loop }: { loop: LoopView }) {
  return (
    <div className="space-y-4" data-testid="loop-live">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Steps">
          <span className="num text-ink-1">{loop.steps}</span> <span className="text-ink-3">of {loop.maxSteps}</span>
        </Stat>
        <Stat label="Next step">
          {loop.stepping
            ? "running now"
            : loop.status === "paused"
            ? "paused"
            : loop.nextStepAt
            ? relativeToNow(loop.nextStepAt / 1000)
            : "—"}
        </Stat>
      </div>

      {/* What the run has spent, as the money flow: the cap on Solana,
          the treasury on Tempo and OpenRouter via Tempo, compact, in place of a lone spent figure. */}
      <LoopMoneyFlow loop={loop} variant="compact" />

      {/* The standing instruction the run committed to: what every step is doing. A row rebuilt from
          the chain has only its hash (the start record carries no text), so the line says that rather
          than drawing an empty paragraph. */}
      {loop.prompt ? (
        <p className="text-sm leading-relaxed text-ink-2" title={`sha256 ${loop.promptHash}`}>
          {loop.prompt}
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-ink-3" data-testid="loop-live-prompt-off-chain">
          The instruction is not on chain. The chain commits it as sha256{" "}
          <span className="font-mono" title={loop.promptHash}>
            {truncate(loop.promptHash, 8, 6)}
          </span>{" "}
          in every step&apos;s manifest.
        </p>
      )}

      {/* What the run is for, when it was given one, as on the loop's own page. */}
      {loop.goal && (
        <p
          className="text-sm leading-relaxed text-ink-1"
          title={`sha256 ${loop.goalHash}`}
          data-testid="loop-live-goal"
        >
          Goal: {loop.goal}
        </p>
      )}

      {/* The plan the run is keeping as its memory, the same panel the loop's page renders and
          from the same verified bytes. Nothing on a run with no goal. */}
      <GoalPlan loop={loop} testId="loop-live-plan" />

      {/* The terms every step of this run is judged on, when it asked for any. They are part of
          what the run committed, not a console setting, so they belong beside the instruction. */}
      {loop.verify && (
        <p className="text-2xs text-ink-3" data-testid="loop-live-verify">
          {verifyTermsLabel(loop.verify)}
        </p>
      )}

      {loop.lastMemoryHash && (
        <p className="text-2xs text-ink-3" data-testid="loop-live-memory">
          Remembered after step {loop.lastMemoryStep ?? loop.steps}: sha256{" "}
          <span className="font-mono text-ink-2">{truncate(loop.lastMemoryHash, 8, 6)}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <LoopControls loop={loop} />
        <Link
          href={`/loop/${loop.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-1 underline"
          data-testid="loop-live-open"
        >
          Every step, verified <ArrowIcon />
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-0.5 text-sm text-ink-1">{children}</div>
    </div>
  );
}
