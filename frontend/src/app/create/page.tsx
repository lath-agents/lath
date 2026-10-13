"use client";

import { Suspense, use } from "react";
import Link from "next/link";
import { CreatorWizard } from "@/components/CreatorWizard";
import { LoopEntry } from "@/components/LoopEntry";
import { Crumbs, PageHeader, Skeleton } from "@/components/ui";
import { Draft, parseSourceRef } from "@/lib/draft";
import { LoopPresetContext, loopPreset } from "@/lib/loop-presets";

/**
 * `/create` builds an agent; `?loop=1` starts a loop on an agent this wallet already deployed — a
 * deploy never starts one — and `?agent=<id>` alongside it names the agent that loop runs on — the
 * deep link *Compose a loop* uses from an agent's own page, so the form opens on that agent instead
 * of asking which.
 *
 * The agent flow is the blank wizard and nothing above it: an agent is always created from blank.
 * *Start from*, whose *Your assets* pane fills the form from an agent or template this wallet has
 * and appends a version to its template, is the loop flow's alone; a `?from=` link on the agent flow
 * opens the blank form.
 *
 * `?from=template:‹id›` / `loop:‹id›` on the loop flow is the same choice made by a link, so a tile's
 * hover card elsewhere in the console can offer *New from this*: the picker opens on that pane and
 * picks the row once the reads resolve it. `offer:‹id›` does not parse (the marketplace is not in
 * this build), so such a link opens the blank form.
 *
 * `?preset=<id>` on the loop flow (`?loop=1&agent=<id>&preset=protocol-audit`) opens the form on a
 * named set of terms from `lib/loop-presets.ts`. Provided as context because the form sits under
 * `LoopEntry`, which owns the agent pick and the form's remount; an id this console does not know
 * is ignored, so a stale link opens the ordinary blank form rather than an error.
 */
/** The agent flow's only draft: blank, with no lineage to append a template version to. */
const BLANK: Draft = { lineage: { kind: "blank" } };

export default function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ loop?: string; agent?: string; from?: string; preset?: string }>;
}) {
  const sp = use(searchParams);
  const loop = sp.loop === "1";
  const from = parseSourceRef(sp.from);
  const preset = loop ? loopPreset(sp.preset) : null;

  return (
    <div className="space-y-8">
      <PageHeader
        // The workspace's *Yours* tab, which `/agents` redirects to.
        eyebrow={<Crumbs items={[{ label: "Agents", href: "/" }, { label: "Create" }]} />}
        // The title names what the choice below creates, and there is no line under it: the form says
        // what it asks, and the runtime key, the policy hash and the one-loop-per-agent rule are in
        // its ⓘs.
        title={loop ? "Create Agent Loop" : "Create Agent"}
      />
      {/* What to create, at the top: the workspace's one _Create_ button lands here, so the page
          asks. Each choice is its own URL, `/create` and `/create?loop=1`, so a link to either
          opens it and Back steps between them. */}
      <div className="segmented" role="tablist" aria-label="What to create">
        <Link
          href="/create"
          role="tab"
          aria-selected={!loop}
          className="segmented-item"
          data-testid="create-pick-agent"
        >
          Agent
        </Link>
        <Link
          href="/create?loop=1"
          role="tab"
          aria-selected={loop}
          className="segmented-item"
          data-testid="create-pick-loop"
        >
          Agent loop
        </Link>
      </div>
      <Suspense fallback={<Skeleton rows={6} />}>
        {loop ? (
          // The loop flow keeps the entry it has and wraps `StartFrom` above it, so `?from=` is
          // the same deep link in both flows and `LoopEntry` decides what a pick means there.
          // Keyed on the preset, so following a preset link from _Start from_ (a client navigation to
          // the same page) mounts the form afresh: it reads its terms in `useState` initialisers
          // only, and the blank form it showed must not stay on screen under the preset's URL. Keyed on
          // `?agent=` too, for the same reason: the wizard's _Continue to the loop_ navigates here from
          // _New_ with the agent it deployed, and the entry picks its agent in a `useState` initialiser.
          <LoopPresetContext.Provider value={preset}>
            <LoopEntry key={`${preset?.id ?? ""}:${sp.agent ?? ""}`} agentId={sp.agent} from={from} />
          </LoopPresetContext.Provider>
        ) : (
          <CreatorWizard draft={BLANK} />
        )}
      </Suspense>
    </div>
  );
}
