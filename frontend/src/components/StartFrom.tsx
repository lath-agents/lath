"use client";

/**
 * _Create from_, the top of the Agent loop form. Three choices, as cards:
 *
 * - **Existing agent**: one of this wallet's agents on a loop. The form below with blank terms; its
 *   agent select is the pick.
 * - **Existing loop**: a past run's or a loop template's terms, picked from tiles, open in the form.
 *   Starting from one appends a version to its loop template.
 * - **New**: nothing reused, an agent and its loop from scratch. `LoopEntry` draws the agent wizard,
 *   whose deploy continues to the form on the agent it made.
 *
 * Each choice is its own card, so agents, runs and templates are never mixed under one name. The agent
 * flow has no picker at all: an agent is always created from blank. `kind` stays for `useBuilderSources`, which reads per flow.
 *
 * The tiles are `Tile.tsx`'s, over `lib/tiles.ts`'s rows. A tile inside a pane is a *picker*, not a link: the
 * pane intercepts the click in the capture phase and `preventDefault` is what stops the `Link` inside
 * the tile from navigating — `next/link` skips a click whose default was already prevented. A modifier
 * click is let through on the rows that have a real page, so *open the record in a new tab* still works.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Button, Card, Empty, ErrorNote, Skeleton } from "@/components/ui";
import { TileGrid } from "@/components/Tile";
import { EMPTY_DESCRIPTION, TileRow, agoLabel, loopBudgetFoot, shortId, tileRows } from "@/lib/tiles";
import { useMyOwners, usePublishedNames } from "@/lib/queries";
import type { Draft, SourceRef } from "@/lib/draft";
import {
  BuilderKind,
  BuilderSource,
  SourceAgentRow,
  SourceLoopRow,
  SourceRefused,
  SourceTemplateRow,
  resolveSourceRef,
  sourceToDraft,
  useBuilderSources,
} from "@/lib/sources";

/** The three _Create from_ choices. */
export type CreateMode = "agent" | "loop" | "new";

const CHOICES: { mode: CreateMode; title: string; text: string }[] = [
  { mode: "agent", title: "Existing agent", text: "Put one of your agents on a loop." },
  { mode: "loop", title: "Existing loop", text: "Start from a past run's or a template's terms." },
  { mode: "new", title: "New", text: "A new agent and its loop, from scratch." },
];

export function StartFrom({
  kind,
  mode,
  onMode,
  initial,
  onPick,
}: {
  kind: BuilderKind;
  mode: CreateMode;
  onMode: (mode: CreateMode) => void;
  /** A `?from=` deep link: the pane opens on that source and picks it once the reads answer. */
  initial?: SourceRef | null;
  onPick: (draft: Draft) => void;
}) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [refused, setRefused] = useState<string | null>(null);
  // Whether the loop tiles are open: on while _Existing loop_ is being browsed, off once a pick filled
  // the form, so the form is the first thing under the cards. A second click on the card reopens them.
  const [browsing, setBrowsing] = useState(!initial);
  // Whether the form was last filled from a pick, so _Existing agent_ resets it to blank terms only
  // when there is something to reset, and never wipes what someone typed into a blank form.
  const [current, setCurrent] = useState<"blank" | "asset" | null>(initial ? null : "blank");

  const sources = useBuilderSources(wallet, kind);

  // Chain facts for the wallet's own agents: the same join the Agents tab draws, so seq and last
  // write on a picker tile are the ones the grid shows. Events are not read here — a picker is
  // not the place to spend a Photon query per row.
  const owners = useMyOwners(publicKey ?? null);
  const ids = useMemo(() => sources.mine.agents.map((a) => a.id), [sources.mine.agents]);
  const names = usePublishedNames(ids);
  const now = Date.now();
  const chainRows = useMemo(() => {
    const joined = tileRows({
      owners: owners.data?.owners,
      registry: { agents: sources.mine.agents },
      // A run always has one on the wire; the picker's row type keeps it optional because a
      // source is read for its terms, and a row with none is a run at rest as far as a chip goes.
      loops: sources.mine.loops.map((l) => ({ ...l, status: l.status ?? "stopped" })),
      names: names.data,
      now,
    });
    return new Map(joined.agents.map((row) => [row.agentId.toLowerCase(), row]));
    // `now` moves every render and would rebuild the map for nothing; the rows it feeds are
    // relative labels ("3 min ago") that a re-render refreshes anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owners.data, sources.mine.agents, sources.mine.loops, names.data]);

  const pick = useCallback(
    (source: BuilderSource) => {
      try {
        setRefused(null);
        onPick(sourceToDraft(source));
        setCurrent("asset");
        setBrowsing(false);
      } catch (err) {
        // A refusal is a rule of the form, not a fault: it is worth reading, so it is shown
        // rather than logged.
        setRefused(err instanceof SourceRefused ? err.message : "that source could not be read");
      }
    },
    [onPick]
  );

  // A `?from=` link picks once, when the rows it names have arrived. `useRef` rather than state:
  // the pick must not re-fire when the reads refresh underneath it and hand the wizard a second
  // draft over the user's edits.
  const consumed = useRef(false);
  useEffect(() => {
    if (!initial || consumed.current || !wallet || sources.loading) return;
    const source = resolveSourceRef(sources, initial, wallet);
    if (!source) return;
    consumed.current = true;
    pick(source);
  }, [initial, wallet, sources, pick]);

  const loopCount = sources.mine.loops.length + sources.mine.templates.length;

  const choose = (next: CreateMode) => {
    setRefused(null);
    if (next === "loop") setBrowsing(mode !== "loop" || !browsing);
    if (next === "agent" && current !== "blank") {
      // Blank terms on the agent the select names: the form drops a run's terms it was showing.
      setCurrent("blank");
      onPick({ lineage: { kind: "blank" } });
    }
    onMode(next);
  };
  return (
    <div className="space-y-3" data-testid="start-from">
      <div className="text-xs font-medium text-ink-2">Create from</div>
      <div role="radiogroup" aria-label="Create from" className="grid gap-2 sm:grid-cols-3">
        {CHOICES.map((c) => {
          const on = mode === c.mode;
          return (
            <button
              key={c.mode}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(c.mode)}
              data-testid={`create-from-${c.mode}`}
              className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                on
                  ? "border-accent/60 bg-accent/[0.06]"
                  : "border-line/[0.1] bg-surface-1 hover:border-line/[0.2] hover:bg-line/[0.03]"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-ink-1">
                {c.title}
                {c.mode === "loop" && wallet && (
                  // A dash while the reads are out, not a zero this wallet does not have.
                  <span className="rounded bg-line/[0.06] px-1 font-mono text-[10px] leading-4 text-ink-3">
                    {sources.loading ? "…" : loopCount}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-2xs text-ink-3">{c.text}</div>
            </button>
          );
        })}
      </div>
      {refused && <ErrorNote>{refused}</ErrorNote>}
      {mode === "loop" && browsing && (
        <Card title="Your loops" description="A past run or a loop template; its terms open in the form below.">
          <MinePane
            kind={kind}
            wallet={wallet}
            loading={sources.loading || owners.isLoading}
            error={sources.error}
            agents={[]}
            templates={sources.mine.templates}
            loops={sources.mine.loops}
            chainRows={chainRows}
            now={now}
            onPick={pick}
            loopsOnly
          />
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Panes                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function MinePane({
  kind,
  wallet,
  loading,
  error,
  agents,
  templates,
  loops,
  chainRows,
  now,
  onPick,
  loopsOnly = false,
}: {
  kind: BuilderKind;
  wallet: string | null;
  loading: boolean;
  error: string | null;
  agents: SourceAgentRow[];
  templates: SourceTemplateRow[];
  loops: SourceLoopRow[];
  chainRows: Map<string, TileRow>;
  now: number;
  onPick: (source: BuilderSource) => void;
  /** _Existing loop_: runs and loop templates only, no agents section. */
  loopsOnly?: boolean;
}) {
  if (!wallet) return <Empty>Connect a wallet to list what it has deployed here.</Empty>;
  if (loading && agents.length + templates.length + loops.length === 0) return <Skeleton rows={3} />;
  const agentRows = agents.map((row) => chainRows.get(row.id.toLowerCase()) ?? offlineAgentRow(row));
  const loopRows = loops.map((row) => loopSourceRow(row, now));
  const templateRows = templates.map((row) => templateSourceRow(row, now));

  const sections: { key: string; title: string; empty: string; rows: TileRow[]; pick: (row: TileRow) => void }[] = [
    {
      key: "agents",
      title: kind === "loop" ? "Agents to put on a schedule" : "Agents this wallet deployed",
      empty: "This wallet has deployed nothing here yet.",
      rows: agentRows,
      pick: (row) => {
        const source = agents.find((a) => a.id.toLowerCase() === row.agentId.toLowerCase());
        if (source) onPick({ kind: "agent", wallet, row: source, template: templateOf(templates, source.template) });
      },
    },
    ...(kind === "loop"
      ? [
          {
            key: "loops",
            title: "Runs to start again",
            empty: "This wallet has started no loop here yet.",
            rows: loopRows,
            pick: (row: TileRow) => {
              const source = loops.find((l) => l.id === row.loopId);
              if (source)
                onPick({ kind: "loop", wallet, row: source, template: templateOf(templates, source.template) });
            },
          },
        ]
      : []),
    {
      key: "templates",
      title: kind === "loop" ? "Loop templates" : "Templates",
      empty:
        kind === "loop"
          ? "No loop template yet: one is written the first time this wallet starts a loop."
          : "No template yet: one is written the first time this wallet deploys an agent.",
      rows: templateRows,
      pick: (row) => {
        const source = templates.find((t) => t.id === row.agentId);
        if (!source) return;
        onPick(
          source.kind === "loop"
            ? { kind: "loop-template", wallet, row: source }
            : { kind: "template", wallet, row: source }
        );
      },
    },
  ];

  const shown = loopsOnly ? sections.filter((section) => section.key !== "agents") : sections;
  return (
    <div className="space-y-5" data-testid="start-from-mine">
      {error && <ErrorNote>{error}</ErrorNote>}
      {shown.map((section) => (
        <section key={section.key} className="space-y-2">
          <h3 className="text-xs font-medium text-ink-2">{section.title}</h3>
          {section.rows.length === 0 ? (
            <Empty>{section.empty}</Empty>
          ) : (
            <PickerGrid rows={section.rows} onPick={section.pick} testId={`start-from-${section.key}`} />
          )}
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* A grid of tiles that pick rather than navigate                                              */
/* ------------------------------------------------------------------------------------------ */

function PickerGrid({ rows, onPick, testId }: { rows: TileRow[]; onPick: (row: TileRow) => void; testId: string }) {
  const rowByKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);

  /**
   * Which tile was clicked, read off the handles the tile already carries: `data-loop-id` on a
   * run and `data-agent-id` on everything else, which are the same attributes the Playwright
   * specs resolve rows by. No prop is added to `Tile` for this — the tab that owns a grid decides
   * what a click there means, and here it means *start from this one*.
   */
  const pickFrom = (target: EventTarget | null) => {
    const el =
      target instanceof Element
        ? target.closest<HTMLElement>('[data-testid="owner-row"], [data-testid="loop-row"]')
        : null;
    const key = el?.dataset.loopId ?? el?.dataset.agentId;
    const row = key ? rowByKey.get(key) : undefined;
    if (row) onPick(row);
  };

  /**
   * Whether a click or key landed on a control of its own rather than on the tile. The tile's ⓘ is
   * a button, and its card is portalled to the viewport but still bubbles here through the React
   * tree, so catching those as picks started from the row on a click meant to read the summary.
   * Only the tile's own pick controls are left to pick: the *Start from this* button and the name
   * link, the one anchor outside a card (its navigation is what the capture below stops).
   */
  const ownControl = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    const control = target.closest('button, a, [role="dialog"]');
    if (!control) return false;
    if (control.matches('[data-testid="start-from-pick"]')) return false;
    if (control.tagName === "A" && !control.closest('[role="dialog"]')) return false;
    return true;
  };

  return (
    <div
      data-testid={testId}
      // Capture phase, so the `Link` inside the tile sees a click whose default is already
      // prevented and stays put. A modifier click is left alone: the record's page is still one
      // ⌘-click away from here.
      onClickCapture={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || ownControl(e.target)) return;
        e.preventDefault();
        pickFrom(e.target);
      }}
      onKeyDownCapture={(e) => {
        if ((e.key !== "Enter" && e.key !== " ") || ownControl(e.target)) return;
        e.preventDefault();
        pickFrom(e.target);
      }}
    >
      <TileGrid
        rows={rows}
        actionsFor={() => (
          // The affordance, not the mechanism: the click is caught above whichever part of the
          // tile it landed on, so this button says what a click does rather than being the only
          // thing that does it.
          <Button variant="ghost" size="sm" testId="start-from-pick">
            Start from this
          </Button>
        )}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Rows the tile join does not build                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * An agent the console has a record of but the indexer has not answered for — a deploy from the
 * last few slots, or a scan this wallet's read could not finish. It is still a legitimate
 * thing to start from, so it is offered with its console facts and no chain claim at all.
 */
function offlineAgentRow(row: SourceAgentRow): TileRow {
  return {
    ...emptyRow(row.id, row.name ?? shortId(row.id), "owner-row"),
    href: `/agent/${row.id}`,
    kind: "agent",
    description: row.description ?? EMPTY_DESCRIPTION,
    descriptionPlaceholder: !row.description,
    footLeft: "not on the indexer yet",
    fields: policyFields(row.policy),
  };
}

function loopSourceRow(row: SourceLoopRow, now: number): TileRow {
  const steps = row.steps ?? 0;
  return {
    ...emptyRow(row.agentId, row.agentName ?? shortId(row.agentId), "loop-row"),
    kind: "loop",
    loopId: row.id,
    href: `/loop/${row.id}`,
    key: row.id,
    description: row.prompt || EMPTY_DESCRIPTION,
    descriptionPlaceholder: !row.prompt,
    statusLabel: row.status ?? "stopped",
    footLeft: `step ${steps}${row.maxSteps ? `/${row.maxSteps}` : ""} · ${agoLabel(row.createdAt ?? 0, now)}`,
    // The whole budget, derived from the per-step budget on a row that carries only that — the unit the
    // loop tiles quote.
    footRight: loopBudgetFoot(row) ?? "—",
    fields: [
      ...(row.model ? [{ label: "model", value: row.model, source: "console" as const }] : []),
      ...(row.template
        ? [
            {
              label: "template",
              value: `${shortId(row.template.id)} v${row.template.version}`,
              source: "console" as const,
              mono: true,
            },
          ]
        : []),
    ],
  };
}

/**
 * A template tile. Every field on it is the console's: a template points at nothing on chain, and
 * saying so on the tile is the same rule the hover cards follow.
 */
function templateSourceRow(row: SourceTemplateRow, now: number): TileRow {
  const loop = row.kind === "loop";
  return {
    ...emptyRow(row.id, row.name, loop ? "loop-row" : "owner-row"),
    kind: loop ? "loop" : "agent",
    // No `/templates` page exists to link to; the pane
    // intercepts the click anyway, and this keeps the tile's markup honest about where it goes.
    href: "#",
    description: row.config?.prompt?.trim() || EMPTY_DESCRIPTION,
    descriptionPlaceholder: !row.config?.prompt?.trim(),
    statusLabel: `v${row.version}`,
    footLeft: `v${row.version}${row.versions && row.versions > 1 ? ` of ${row.versions}` : ""} · ${agoLabel(
      row.createdAt ?? 0,
      now
    )}`,
    footRight: "template",
    fields: policyFields(row.config),
  };
}

function policyFields(policy: { model?: string; tools?: readonly string[]; budgetCapUsdc?: string } | undefined) {
  if (!policy) return [];
  return [
    ...(policy.model ? [{ label: "model", value: policy.model, source: "console" as const }] : []),
    ...(policy.tools?.length ? [{ label: "tools", value: policy.tools.join(", "), source: "console" as const }] : []),
    ...(policy.budgetCapUsdc
      ? [{ label: "budget", value: `${policy.budgetCapUsdc} USDC`, source: "console" as const, mono: true }]
      : []),
  ];
}

/** The fields a `TileRow` has to carry, with nothing claimed: a picker row states what it knows. */
function emptyRow(id: string, name: string, testId: "owner-row" | "loop-row"): TileRow {
  return {
    key: id,
    kind: "agent",
    agentId: id,
    href: "#",
    testId,
    name,
    nameSource: "console",
    unnamed: false,
    status: "idle",
    statusLabel: "idle",
    statusTone: "neutral",
    description: EMPTY_DESCRIPTION,
    descriptionSource: "console",
    descriptionPlaceholder: true,
    bins: null,
    eventCount: 0,
    footLeft: "—",
    footLeftSource: "console",
    footRight: "—",
    footRightSource: "console",
    relations: [],
    fields: [],
    sort: { lastWriteMs: 0, createdAtMs: 0, nextStepAtMs: null },
  };
}

function templateOf(
  templates: SourceTemplateRow[],
  linked: { id: string; version: number } | null | undefined
): SourceTemplateRow | null {
  return linked ? templates.find((t) => t.id === linked.id) ?? null : null;
}
