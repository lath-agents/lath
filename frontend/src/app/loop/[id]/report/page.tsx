"use client";

import { use } from "react";
import Link from "next/link";
import { Crumbs, ErrorNote, Note, Skeleton } from "@/components/ui";
import { LoopMoneyFlow, OpenReport, TempoPaymentsCard } from "@/components/LoopTempoServices";
import { LoopRails } from "@/components/LoopRails";
import { LoopReceipt } from "@/components/LoopReceipt";
import { LoopChainBlock } from "@/components/LoopChain";
import { DualRailPanel } from "@/components/DualRailPanel";
import { LoopSourcesCard } from "@/components/ZeroClawSandbox";
import { truncate } from "@/lib/format";
import { useLoop } from "@/lib/loops";
import { useDocumentTitle } from "@/lib/document-title";
import { lastPublishedReport } from "@/lib/tempo-services";

/**
 * The answer of a finished loop on a page of its own, which the goal-reached line on the loop's page
 * opens in a new tab: the question the run was given, how it ended, and the report its last step
 * stored, opened on arrival and re-hashed in this browser against the record that committed it. Under
 * it, the evidence: the files the answer was read from, where the money went, what the run recorded on
 * Solana and paid on Tempo, every model call as its record beside its payment, and the receipt.
 */
export default function LoopAnswerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const query = useLoop(id);
  const loop = query.data?.loop;
  useDocumentTitle(loop ? `${loop.agentName} · answer` : null);

  if (query.isLoading) return <Skeleton rows={4} />;
  if (!loop) {
    return (
      <div className="space-y-6">
        <Crumbs items={[{ label: "Agents", href: "/" }, { label: truncate(id, 10, 4) }]} />
        <ErrorNote>No loop with that id is on this console, so it has no answer to show.</ErrorNote>
      </div>
    );
  }

  const question = questionOf(loop.goal);
  // The decision that stopped the run is the last step's, not the first that had one.
  const jev =
    loop.stopReason === "goal-reached" ? [...loop.history].reverse().find((h) => h.goalCheck)?.goalCheck : undefined;
  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="loop-answer-page">
      <Crumbs
        items={[
          { label: "Agents", href: `/?run=${encodeURIComponent(id)}` },
          { label: loop.agentName, href: `/loop/${encodeURIComponent(id)}` },
          { label: "Answer" },
        ]}
      />
      {question && (
        <p className="text-sm leading-relaxed text-ink-1" data-testid="loop-answer-question">
          {question}
        </p>
      )}
      {loop.stopReason === "goal-reached" && (
        <Note tone="volt">
          Goal reached at step {loop.steps}
          {jev?.outcome === "achieved"
            ? ` — the decision model judged it achieved${
                typeof jev.confidence === "number" ? ` (${jev.confidence.toFixed(2)})` : ""
              }`
            : ""}
          .
        </Note>
      )}
      {lastPublishedReport(loop.history) && loop.plainTraces && loop.status !== "running" ? (
        <OpenReport loop={loop} autoOpen />
      ) : (
        <Note tone="warn">
          {loop.status === "running" ? "The run is still stepping; its answer opens here once it stops." : ""}
          {loop.status !== "running" ? "No step of this run stored a report, so there is no answer to open." : ""}
        </Note>
      )}
      <section className="space-y-4 pt-4" data-testid="loop-answer-evidence">
        <div className="space-y-1">
          <h2 className="eyebrow">Evidence</h2>
          <p className="text-xs leading-relaxed text-ink-3">
            The files the answer was read from, pinned before the run started; what it spent and where the money went;
            every model call as its record on Solana beside its payment on Tempo; and the receipt.
          </p>
        </div>
        <LoopSourcesCard id={id} />
        <LoopMoneyFlow loop={loop} />
        <LoopRails loop={loop} />
        <LoopReceipt loop={loop} />
        <DualRailPanel
          agentId={loop.agentId}
          title="Every model call: its Solana record and its Tempo payment"
          refreshOn={`${loop.steps}:${loop.lastSeq ?? ""}`}
        />
        <LoopChainBlock loop={loop} />
        <TempoPaymentsCard loop={loop} />
        <div className="flex flex-wrap gap-4 text-xs">
          <Link href={`/zeroclaw/${encodeURIComponent(id)}`} className="link" data-testid="loop-answer-sandbox">
            Agent Loop Sandbox proof
          </Link>
          <Link href={`/loop/${encodeURIComponent(id)}`} className="link" data-testid="loop-answer-back">
            The run&apos;s page
          </Link>
        </div>
      </section>
    </div>
  );
}

/**
 * The question a goal opens with, when it opens with one: everything up to its first `?`, if that comes
 * within the goal's first few sentences. A goal written as a task has none, and the page shows no line.
 */
function questionOf(goal: string | null | undefined): string | null {
  const text = goal?.trim();
  if (!text) return null;
  const end = text.indexOf("?");
  if (end < 0 || end > 400) return null;
  return text.slice(0, end + 1);
}
