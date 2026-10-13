"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { hex } from "@lath/sdk/browser";
import type { OwnerHeader } from "@lath/sdk/browser";
import { Badge, Empty, Note, ReadFailed, Skeleton } from "@/components/ui";
import { Node, NodeState } from "@/components/Spine";
import { SplitView } from "@/components/Split";
import { TempoMark } from "@/components/Tempo";
import { LoopStatusBadge } from "@/components/LoopList";
import { RunChainMarks } from "@/components/LoopChain";
import { loopNode } from "@/components/LoopSpine";
import { WorkspaceAgentPanel, WorkspaceRunPanel } from "@/components/WorkspacePanels";
import { formatUsdc } from "@/lib/format";
import { ExploreRow, exploreRows, searchExplore, viewExplore } from "@/lib/explore";
import { loopBudgetFigures } from "@/lib/loop-money";
import { LoopView, useLoops } from "@/lib/loops";
import { RegistryAgent, useAgentsRegistry } from "@/lib/market";
import { useNameBook } from "@/lib/names";
import { MyOwner, OwnerRelation, useAllAgents, useMyOwners, usePublishedNames } from "@/lib/queries";
import { agoLabel, shortId, trimUsdc } from "@/lib/tiles";
import { runStatusLine } from "@/lib/run-status";
import {
  NestedAgent,
  NestedRun,
  WorkspaceParams,
  WorkspaceSelection,
  nestWorkspace,
  resolveSelection,
  runTempo,
  usdcEText,
} from "@/lib/workspace";

/** The names `NEXT_PUBLIC_LATH_FEATURED_AGENTS` lists, or none: then every agent is listed. */
const FEATURED_AGENTS = new Set(
  (process.env.NEXT_PUBLIC_LATH_FEATURED_AGENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * The workspace's Yours tab: one list of every agent this
 * wallet signs for, funds or deployed here, each with its loop runs nested under it — the live or
 * latest run as a sub-row, the older ones folded. The selected item opens beside the list, in place: an
 * agent's panel, or a run's.
 *
 * One list rather than three that show the same rows three ways. Its sources: `useMyOwners` for the
 * agents the wallet signs for
 * or funds, the console's registry for the ones it deployed here, `useLoops(wallet)` for its runs, and
 * the cluster scan for the headers of agents the wallet deployed but does not sign for — joined by
 * `exploreRows`, the Explore join, so the rule for *yours* is the one `tests/explore-rows.ts` holds.
 *
 * Reads only. Nothing in the list asks the wallet; the run panel's controls are `LoopControls`, one
 * signed message each, as on the run's own page.
 */

/** An agent row as the list knows it: the Explore join's row when the chain header is in, or the console's word. */
export interface WorkspaceAgent {
  agentId: string;
  activityMs: number;
  name: string;
  /** `exploreRows`' row, when the header has been read; `null` for an agent only the console or a loop names yet. */
  row: ExploreRow | null;
  /** The header with this wallet's relation and grant, when `useMyOwners` read it. */
  owner: MyOwner | null;
  /** The chain header, from either read. */
  header: OwnerHeader | null;
  registry: RegistryAgent | null;
}

type Nested = NestedAgent<WorkspaceAgent, LoopView>;

export function WorkspaceYours({
  query,
  onQuery,
  params,
  onSelect,
}: {
  query: string;
  onQuery: (query: string) => void;
  params: WorkspaceParams;
  onSelect: (selection: WorkspaceSelection) => void;
}) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const { nameOf } = useNameBook();

  const mine = useMyOwners(publicKey ?? null);
  const all = useAllAgents();
  const registry = useAgentsRegistry();
  const loops = useLoops(wallet);

  // Which agents are the wallet's at all, before any per-id read: the ones it signs for or funds, the
  // ones this console recorded it deploying, and the ones its runs are on. Only these are joined, so
  // the published-name read is a handful of ids and not every header on the program.
  const candidates = useMemo(() => {
    const ids = new Set<string>();
    for (const o of mine.data?.owners ?? []) ids.add(hex(o.state.agentId).toLowerCase());
    if (wallet) for (const r of registry.data?.agents ?? []) if (r.owner === wallet) ids.add(r.id.toLowerCase());
    for (const l of loops.data?.loops ?? []) ids.add(l.agentId.toLowerCase());
    return ids;
  }, [mine.data?.owners, registry.data?.agents, loops.data?.loops, wallet]);

  const headers = useMemo(() => {
    const byId = new Map<string, OwnerHeader>();
    for (const h of [...(all.data ?? []), ...(mine.data?.owners ?? [])]) {
      const id = hex(h.state.agentId).toLowerCase();
      if (candidates.has(id)) byId.set(id, h);
    }
    return byId;
  }, [all.data, mine.data?.owners, candidates]);

  const ids = useMemo(() => [...headers.keys()], [headers]);
  const published = usePublishedNames(ids);
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const name = published.data?.[id] ?? nameOf(id);
      if (name) out[id] = name;
    }
    return out;
  }, [ids, published.data, nameOf]);

  const ownerById = useMemo(() => {
    const out = new Map<string, MyOwner>();
    for (const o of mine.data?.owners ?? []) out.set(hex(o.state.agentId).toLowerCase(), o);
    return out;
  }, [mine.data?.owners]);
  const registryById = useMemo(() => {
    const out = new Map<string, RegistryAgent>();
    for (const r of registry.data?.agents ?? []) out.set(r.id.toLowerCase(), r);
    return out;
  }, [registry.data?.agents]);
  const archived = useMemo(
    () => new Set((registry.data?.archived ?? []).map((id) => id.toLowerCase())),
    [registry.data?.archived]
  );

  const exploreYours = useMemo(() => {
    const relations: Record<string, OwnerRelation[]> = {};
    const allowances: Record<string, { cap: bigint; spent: bigint; expiresAt: bigint } | undefined> = {};
    for (const o of mine.data?.owners ?? []) {
      relations[hex(o.state.agentId)] = o.relations;
      if (o.allowance) allowances[hex(o.state.agentId)] = o.allowance;
    }
    const rows = exploreRows({
      headers: [...headers.values()],
      registry: registry.data ?? null,
      loops: loops.data?.loops ?? [],
      names,
      wallet,
      relations,
      allowances,
      now: Date.now(),
    });
    return viewExplore(rows, "yours");
  }, [headers, registry.data, loops.data?.loops, names, wallet, mine.data?.owners]);

  /**
   * The rows: the Explore join's, plus an agent a run or the registry names whose header the scan has
   * not returned yet — an agent deployed a minute ago is listed by its console name until its header
   * reads, rather than missing. Archived agents stay out, as on every list.
   */
  const agents = useMemo(() => {
    const out: WorkspaceAgent[] = [];
    const listed = new Set<string>();
    for (const row of exploreYours) {
      const id = row.agentId.toLowerCase();
      listed.add(id);
      out.push({
        agentId: id,
        activityMs: row.sort.lastWriteMs,
        name: row.name,
        row,
        owner: ownerById.get(id) ?? null,
        header: headers.get(id) ?? null,
        registry: registryById.get(id) ?? null,
      });
    }
    for (const id of candidates) {
      if (listed.has(id) || archived.has(id)) continue;
      const reg = registryById.get(id) ?? null;
      const run = (loops.data?.loops ?? []).find((l) => l.agentId.toLowerCase() === id);
      out.push({
        agentId: id,
        activityMs: run?.lastStepAt ?? run?.createdAt ?? 0,
        name: reg?.name ?? run?.agentName ?? `unnamed · ${shortId(id)}`,
        row: null,
        owner: ownerById.get(id) ?? null,
        header: headers.get(id) ?? null,
        registry: reg,
      });
    }
    return out;
  }, [exploreYours, ownerById, headers, registryById, candidates, archived, loops.data?.loops]);

  const nested = useMemo(() => nestWorkspace(agents, loops.data?.loops ?? []), [agents, loops.data?.loops]);
  // A console that names featured agents (`NEXT_PUBLIC_LATH_FEATURED_AGENTS`, comma-separated names) lists
  // only those until a search, which still finds every agent: a demo console keeps its list to the agents
  // it shows, without archiving the rest on chain.
  const shown = useMemo(
    () => (FEATURED_AGENTS.size ? nested.filter((n) => FEATURED_AGENTS.has(n.agent.name)) : nested),
    [nested]
  );
  const byId = useMemo(() => new Map(agents.map((a) => [a.agentId, a])), [agents]);

  const visible = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return shown;
    const hits = new Set(
      searchExplore(
        agents.flatMap((a) => (a.row ? [a.row] : [])),
        q,
        (r) => headers.get(r.agentId.toLowerCase())?.state.authority.toBase58()
      ).map((r) => r.agentId.toLowerCase())
    );
    return nested.filter((n) => {
      if (hits.has(n.agentId) || n.agent.name.toLowerCase().includes(q) || n.agentId.includes(q)) return true;
      // A run id finds the agent the run is under.
      return [n.current, ...n.earlier].some((r) => !!r && r.loop.id.toLowerCase().includes(q));
    });
  }, [nested, shown, query, agents, headers]);

  const selection = useMemo(() => resolveSelection(visible, params), [visible, params]);

  // The URL is the selection's record: once the list resolves `/?run=L` (the `/loops?loop=L` redirect)
  // to L's agent, the agent goes into the URL too, so a reload or a copied link carries both.
  const { agentId: selAgent, runId: selRun } = selection;
  useEffect(() => {
    if (!selAgent) return;
    if (params.run && selRun === params.run && params.item !== selAgent) onSelect({ agentId: selAgent, runId: selRun });
  }, [selAgent, selRun, params.run, params.item, onSelect]);

  const loading = !!publicKey && (mine.isLoading || loops.isLoading || registry.isLoading) && agents.length === 0;
  const failed = mine.isError && all.isError && loops.isError;

  if (loading) return <Skeleton rows={4} />;
  if (failed)
    return (
      <ReadFailed
        error={mine.error}
        onRetry={() => void Promise.all([mine.refetch(), all.refetch(), loops.refetch()])}
      />
    );
  // An empty list is a claim about the chain only when the chain reads answered: with the wallet's
  // own scan or the agent read failed, *no agents yet* is what the read did not establish, so the
  // failure is said instead.
  if (nested.length === 0 && (mine.isError || all.isError))
    return (
      <ReadFailed
        error={mine.isError ? mine.error : all.error}
        onRetry={() => void Promise.all([mine.refetch(), all.refetch(), loops.refetch()])}
      />
    );
  if (nested.length === 0)
    return (
      <Empty
        action={
          <Link href="/create" className="link text-xs">
            Deploy an agent →
          </Link>
        }
      >
        This wallet has no agents yet. An agent is listed here once your wallet signs for it, funds it, or deploys it
        from this console.
      </Empty>
    );

  const unread = mine.data?.unreadAuthorities ?? 0;
  const selectedAgent = selection.agentId ? byId.get(selection.agentId) ?? null : null;
  const selectedRun = selection.runId ? (loops.data?.loops ?? []).find((l) => l.id === selection.runId) ?? null : null;

  return (
    <div className="space-y-3">
      {/* A partial read is said before the rows, not instead of them: the rows that were read are real,
          only the count is a floor. */}
      {unread > 0 && (
        <div data-testid="owners-partial">
          <Note tone="warn">
            The indexer did not answer for {unread} of the {mine.data?.fundedAuthorities ?? unread} agent authorit
            {(mine.data?.fundedAuthorities ?? unread) === 1 ? "y" : "ies"} this wallet funds, so the agents they sign
            for are missing from this list. Reload to read them again.
          </Note>
        </div>
      )}
      {mine.isError && (
        <div data-testid="owners-read-failed">
          <Note tone="warn">
            The chain read of the agents this wallet signs for or funds failed (
            {mine.error instanceof Error ? mine.error.message : "request failed"}), so only the agents this console
            recorded or runs a loop on are listed. Reload to read them again.
          </Note>
        </div>
      )}
      {loops.isError && (
        <Note tone="warn">
          The loop registry did not answer ({loops.error instanceof Error ? loops.error.message : "request failed"}), so
          no run is listed under its agent.
        </Note>
      )}
      <SplitView
        // `owners-spine` is the list; each agent row carries `owner-row` and `data-agent-id`, each run
        // row `loop-row` and `data-loop-id`.
        listTestId="owners-spine"
        listHeader={<ListHeader count={shown.length} query={query} onQuery={onQuery} />}
        list={
          visible.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-3">{`Nothing of yours matches "${query.trim()}".`}</p>
          ) : (
            visible.map((n) => (
              <AgentGroup
                key={n.agentId}
                entry={n}
                selection={selection}
                onSelect={onSelect}
                scanning={all.isLoading}
              />
            ))
          )
        }
        detail={
          selectedRun ? (
            <WorkspaceRunPanel key={selectedRun.id} loop={selectedRun} />
          ) : selectedAgent ? (
            <WorkspaceAgentPanel
              key={selectedAgent.agentId}
              agent={selectedAgent}
              runs={visible.find((n) => n.agentId === selectedAgent.agentId) ?? null}
            />
          ) : null
        }
      />
    </div>
  );
}

/**
 * The list's own header: its title and count, the search, and _Create_. Opposite the headline, top
 * right, they would read as the page's and not the list's; the search filters these rows and the
 * buttons add to them, so they sit on the list.
 */
function ListHeader({ count, query, onQuery }: { count: number; query: string; onQuery: (q: string) => void }) {
  // One row: the title, the search filling what the title and the buttons leave, then the buttons. On a narrow column the buttons wrap under, and the search keeps a
  // floor wide enough for its placeholder.
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="whitespace-nowrap text-sm font-semibold text-ink-1">
        Lath agents <span className="font-normal text-ink-3">· {count}</span>
      </h2>
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        // The name is what a person types; the box still matches an id or an authority too.
        placeholder="Agent name…"
        aria-label="Search your agents"
        data-testid="workspace-search"
        className="input h-8 min-w-[10rem] flex-1 text-xs"
      />
      {/* One way in, _Create_: `/create` asks whether it is an agent or an agent loop. A _Start a loop_
          button would read oddly on a list of agents; an agent's own _Run as a loop_ opens the loop form
          with it chosen. */}
      <Link
        href="/create"
        data-testid="landing-create"
        className="inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-accent px-3.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-accent-strong"
      >
        Create
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Rows                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * One row of the list, at a depth: an agent (0) or a run under it (1). The
 * markup is `SplitRow`'s with an indent, so a nested row reads as part of the one above it; `extra`
 * carries the data attributes the specs resolve rows by.
 */
function Row({
  depth,
  node,
  name,
  badge,
  sub,
  selected,
  onSelect,
  testId,
  buttonTestId,
  extra,
}: {
  depth: 0 | 1;
  node: NodeState;
  name: ReactNode;
  badge?: ReactNode;
  sub?: ReactNode;
  selected: boolean;
  onSelect: () => void;
  testId: string;
  buttonTestId?: string;
  extra: Record<string, string>;
}) {
  const indent = depth === 0 ? "pl-4" : "pl-9";
  return (
    <div
      role="listitem"
      data-testid={testId}
      data-depth={depth}
      {...extra}
      className={`transition-colors ${depth === 0 ? "border-t border-line/[0.07] first:border-t-0" : ""} ${
        selected ? "bg-accent/[0.06] shadow-[inset_2px_0_0_rgb(var(--accent))]" : "hover:bg-line/[0.025]"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        data-testid={buttonTestId}
        {...(buttonTestId ? extra : {})}
        className={`grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg py-2.5 pr-4 text-left ${indent}`}
      >
        <Node state={node} />
        <span className={`truncate ${depth === 0 ? "font-medium text-ink-1" : "text-sm text-ink-2"}`}>{name}</span>
        {badge ?? <span />}
        {sub && <span className="num col-start-2 col-end-4 truncate text-2xs text-ink-3">{sub}</span>}
      </button>
    </div>
  );
}

/** The agent's own node: its live run's, when it has one, else what its header says of the last hour. */
function agentNode(entry: Nested): NodeState {
  const loop = entry.current?.loop;
  if (loop && loop.status !== "stopped") return loopNode(loop);
  const status = entry.agent.row?.status;
  if (status === "stepping") return "now";
  if (status === "running") return "live";
  if (status === "active") return "ran";
  return "idle";
}

/**
 * The agent row's line: one sentence on where the agent stands, said by the run that speaks for it
 * (`current`), not what the wallet's grant has spent of its cap: a figure such as _spent 0.000412 of
 * 1 USDC_ tells a reader less than what the agent is doing. The grant's figures are in the panel; the run rows below keep their budgets. Seq and head are
 * folded into the panel's `Info`. The run's sentence is `runStatusLine`, which the agent page's
 * _Loops_ row says too.
 */
function agentSub(entry: Nested, scanning: boolean): string {
  const { agent, current } = entry;
  const now = Date.now();
  // Listed by the console's word or a run's before its header is read: say which, not a guess.
  if (!agent.header && !current) return scanning ? "Reading its chain…" : "No header on chain read yet";
  if (!current) return `Deployed, no loop run yet · last write ${agoLabel(agent.activityMs, now)}`;
  return runStatusLine(current.loop, now);
}

function AgentGroup({
  entry,
  selection,
  onSelect,
  scanning,
}: {
  entry: Nested;
  selection: WorkspaceSelection;
  onSelect: (s: WorkspaceSelection) => void;
  /** The cluster scan is still out, so a header-less row is a read in flight. */
  scanning: boolean;
}) {
  const { agent, current, earlier } = entry;
  const selectedEarlier = earlier.some((r) => r.loop.id === selection.runId);
  const [unfolded, setUnfolded] = useState(selectedEarlier);
  const open = unfolded || selectedEarlier;
  const live = current && current.loop.status !== "stopped";

  return (
    <>
      <Row
        depth={0}
        node={agentNode(entry)}
        testId="owner-row"
        buttonTestId="explore-row"
        extra={{ "data-agent-id": entry.agentId }}
        selected={selection.agentId === entry.agentId && !selection.runId}
        onSelect={() => onSelect({ agentId: entry.agentId, runId: null })}
        name={agent.name}
        badge={
          // No _idle_ badge on the row: the line under the name already
          // says where the agent stands, and the panel on the right keeps the badge.
          live ? (
            <LoopStatusBadge loop={current!.loop} />
          ) : agent.row?.status === "idle" ? null : agent.row ? (
            <Badge tone={agent.row.statusTone}>{agent.row.statusLabel}</Badge>
          ) : (
            <Badge tone="neutral">reading</Badge>
          )
        }
        sub={<span suppressHydrationWarning>{agentSub(entry, scanning)}</span>}
      />
      {current && <RunRows run={current} agentId={entry.agentId} selection={selection} onSelect={onSelect} />}
      {earlier.length > 0 && (
        <div role="listitem" className="pl-9">
          <button
            type="button"
            onClick={() => setUnfolded((v) => !v)}
            aria-expanded={open}
            data-testid="earlier-runs"
            className="flex w-full items-center gap-1.5 py-1.5 pr-4 text-left text-2xs text-ink-3 transition-colors hover:text-ink-1"
          >
            <span aria-hidden>{open ? "▾" : "▸"}</span>
            {earlier.length} earlier {earlier.length === 1 ? "run" : "runs"}
          </button>
        </div>
      )}
      {open &&
        earlier.map((run) => (
          <RunRows key={run.loop.id} run={run} agentId={entry.agentId} selection={selection} onSelect={onSelect} />
        ))}
    </>
  );
}

/**
 * A run's row: `step n/N · budget · [T] paid on Tempo`, with a live dot while its channel is open.
 * The Tempo figure is what the console's rows say the run's channel paid; there is no count
 * of calls, because no call count reaches the row (`runTempo`), so it says _paid on Tempo_ without one.
 */
function RunRows({
  run,
  agentId,
  selection,
  onSelect,
}: {
  run: NestedRun<LoopView>;
  agentId: string;
  selection: WorkspaceSelection;
  onSelect: (s: WorkspaceSelection) => void;
}) {
  const loop = run.loop;
  const budget = loopBudgetFigures(loop);
  const tempo = runTempo(loop);
  return (
    <>
      <Row
        depth={1}
        node={loopNode(loop)}
        testId="loop-row"
        extra={{ "data-loop-id": loop.id, "data-agent-id": agentId }}
        selected={selection.runId === loop.id}
        onSelect={() => onSelect({ agentId, runId: loop.id })}
        name={<span suppressHydrationWarning>Loop run · started {agoLabel(loop.createdAt, Date.now())}</span>}
        badge={<LoopStatusBadge loop={loop} />}
        sub={
          <span className="inline-flex items-center gap-1">
            step {loop.steps}/{loop.maxSteps} · {formatUsdc(budget.spent)} of {trimUsdc(budget.budget)} USDC
            <RunTempoLine loop={loop} tempo={tempo} />
            {/* Records the console owes the chain, and a row rebuilt from it: one small mark each,
              nothing on an older row written without them. */}
            <RunChainMarks loop={loop} />
          </span>
        }
      />
    </>
  );
}

function RunTempoLine({ loop, tempo }: { loop: LoopView; tempo: ReturnType<typeof runTempo> }) {
  if (tempo.scripted) return <> · not paid (scripted)</>;
  if (!tempo.onTempo) return null;
  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid="run-tempo"
      data-live={tempo.live ? "true" : undefined}
    >
      {" · "}
      <span className="text-accent">
        <TempoMark />
      </span>
      {tempo.paidBase !== null && tempo.paidBase > BigInt(0) ? `${usdcEText(tempo.paidBase)} USDC.e ` : ""}paid on Tempo
      {tempo.live && (
        <span
          className="ml-0.5 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_rgb(var(--accent)/0.8)] motion-safe:animate-pulse"
          title={`payment channel open since step ${loop.channel?.openedAtStep ?? "?"}`}
          aria-label="payment channel open"
        />
      )}
    </span>
  );
}
