"use client";

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LathMark } from "@/components/LathMark";
import { SolanaMark, TempoMark } from "@/components/Tempo";
import { Info, SOURCE_TITLE } from "@/components/ui";
import { WorkspaceSolana } from "@/components/WorkspaceSolana";
import { WorkspaceTempo } from "@/components/WorkspaceTempo";
import { WorkspaceYours } from "@/components/WorkspaceYours";
import { formatUsdc } from "@/lib/format";
import { loopBudgetFigures } from "@/lib/loop-money";
import { useLoops } from "@/lib/loops";
import { useAgentsRegistry } from "@/lib/market";
import { WorkspaceParams, WorkspaceSelection, parseWorkspaceParams } from "@/lib/workspace";

/**
 * The workspace (`/`): the one page a visit
 * starts on and mostly stays on. A line of headline, the two ways on, a search box, and the tab the
 * URL names — Yours, Solana or Tempo, which the nav's tabs link to.
 *
 * The URL is the state (`/?tab=…&item=…&run=…`): the nav writes the tab by navigating, and selecting
 * a row rewrites `item` and `run` with `history.replaceState`, because
 * selecting is not a navigation and Back should leave the page rather than step through every row.
 * Next keeps `useSearchParams` in step with `replaceState`, so the page reads the one place it writes.
 */
export function Workspace() {
  const search = useSearchParams();
  const params = useMemo(() => parseWorkspaceParams(search ? new URLSearchParams(search.toString()) : null), [search]);
  const [query, setQuery] = useState("");

  const select = useCallback((next: WorkspaceSelection) => {
    writeParams({ tab: "yours", item: next.agentId, run: next.runId });
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight text-ink-1 sm:text-xl">
          {/* The Solana and Tempo tabs have their own headlines; Agents keeps the product's, one line a
              judge reads at a glance. */}
          <span className="min-w-0">
            {params.tab === "tempo" ? (
              "Tempo OpenRouter agent payments"
            ) : params.tab === "solana" ? (
              "Solana agent records and agent budget"
            ) : (
              // The Lath mark stands for the product's name, so it carries "Lath" as its accessible name.
              // The Solana and Tempo marks each ride in a no-wrap span with their name, so a narrow screen
              // never breaks the line between a logo and its word, and are decorative: the name follows.
              <>
                <LathMark size={20} title="Lath" className="mr-2 inline-block align-[-0.2em]" />
                Every action recorded on{" "}
                <span className="whitespace-nowrap">
                  <SolanaMark size={16} className="mr-1" />
                  Solana
                </span>
                , every model call paid on{" "}
                <span className="whitespace-nowrap">
                  <TempoMark className="mr-1" />
                  Tempo
                </span>
              </>
            )}
          </span>
          <Info label="How Lath works" wide triggerTestId="landing-info" testId="landing-info-body">
            <HowItWorks />
          </Info>
        </h1>
        {/* The search and _Create_ sit on the agents list (`ListHeader` in `WorkspaceYours.tsx`): the
            headline has the row to itself. */}
      </div>

      <section aria-label={TAB_LABEL[params.tab]} data-testid={`workspace-${params.tab}`}>
        {params.tab === "solana" ? (
          <WorkspaceSolana />
        ) : params.tab === "tempo" ? (
          <WorkspaceTempo />
        ) : (
          <WorkspaceYours query={query} onQuery={setQuery} params={params} onSelect={select} />
        )}
      </section>
    </div>
  );
}

const TAB_LABEL: Record<WorkspaceParams["tab"], string> = {
  yours: "Your agents and loops",
  solana: "Solana",
  tempo: "Tempo",
};

/**
 * `tab`, `item` and `run` into the current URL, every other parameter kept (`?proof=1` among them), a
 * `null` deleting its key. Not a navigation: the selection changed, the page did not.
 */
function writeParams(next: Partial<WorkspaceParams>) {
  try {
    const url = new URL(window.location.href);
    for (const key of ["tab", "item", "run"] as const) {
      const value = next[key];
      if (value === undefined) continue;
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    // `null`, not `history.state`: Next marks its own entries (`__NA`), and a replaceState carrying that
    // marker is taken for Next's own and not synced into `useSearchParams` — the URL would change and the
    // page, which reads only `useSearchParams`, would keep the old selection (a run row would open
    // nothing). Next copies its internal state into the entry itself.
    window.history.replaceState(null, "", url);
  } catch {
    // The selection still changed on screen; only the reload-keeps-it part is lost.
  }
}

/**
 * What happens to every action, in order — recorded, paid for, checkable — and what this deployment
 * has run, folded behind the headline's ⓘ.
 */
function HowItWorks() {
  return (
    <div className="space-y-3">
      <ol className="space-y-2" data-testid="landing-steps">
        {LANDING_STEPS.map((step) => (
          <li key={step.label} className="space-y-0.5">
            <div className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-3">{step.label}</div>
            <p className="text-xs leading-snug text-ink-1">{step.text}</p>
          </li>
        ))}
      </ol>
      <TeamActivity />
    </div>
  );
}

const LANDING_STEPS = [
  {
    label: "Record",
    text: "Every model call, tool call and loop step is a record in the agent's hash chain on Solana.",
  },
  {
    label: "Pay",
    // Not "in the transaction that records it": a loop step's calls are
    // batched into an epoch, so each charge is its own transaction journaled ahead of it (SPEC §15).
    text: "Each call is debited in USDC from a capped allowance on Solana, call by call; the model is paid over Tempo.",
  },
  {
    label: "Verify",
    text: "Anyone can replay the chain, re-hash the traces it commits to and check each payment on Tempo.",
  },
];

/**
 * What this deployment has run, from its own registry: agents deployed, loops started, steps run and
 * the USDC the loops spent. Said as the team's: every agent and loop on it so far
 * was started by the Lath team, test runs included. The figures are the console's records, tagged so.
 * Read only while the ⓘ is open, since the popover mounts its body then.
 */
function TeamActivity() {
  const loops = useLoops(null);
  const agents = useAgentsRegistry();
  if (!loops.data || !agents.data)
    return <p className="text-2xs text-ink-3">Reading this deployment&apos;s activity…</p>;
  const rows = loops.data.loops;
  const steps = rows.reduce((n, l) => n + (l.steps ?? 0), 0);
  const spent = rows.reduce((sum, l) => sum + loopBudgetFigures(l).spent, BigInt(0));
  const completed = rows.filter((l) => l.stopReason === "goal-reached").length;
  const figures = [
    { n: String(agents.data.agents.length), label: "agents" },
    { n: String(rows.length), label: "loops" },
    { n: String(completed), label: "reached their goal" },
    { n: String(steps), label: "steps run" },
    { n: formatUsdc(spent), label: "USDC spent by loops" },
  ];
  return (
    <div className="border-t border-line/[0.08] pt-2 text-2xs text-ink-3" data-testid="team-activity">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {figures.map((f) => (
          <span key={f.label}>
            <span className="num text-xs text-ink-1">{f.n}</span> {f.label}
          </span>
        ))}
      </div>
      {/* The console's figures, said on hover rather than by a tag. */}
      <div className="mt-1" data-source="console" title={SOURCE_TITLE.console}>
        run by the Lath team on devnet, test runs included
      </div>
    </div>
  );
}
