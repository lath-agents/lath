/**
 * The workspace's pure half: what its URL says,
 * where the retired list routes land, how a wallet's loop runs nest under their agents, which item
 * a URL selects, and what a run row may say about its Tempo payments.
 *
 * No React, no Next and no import at all, so `tests/workspace.ts` runs these under the root
 * `tsconfig.json` and the pages that redirect (`app/agents`, `app/loops`, `app/zeroclaw`) and the
 * middleware run the same mapping on the server that the test holds.
 */

/**
 * The workspace's three tabs, in the order the nav and the page draw them. The marketplace is on the
 * roadmap and has no tab in this build: a `?tab=market` link reads as an unknown tab, which is Yours.
 */
export type WorkspaceTab = "yours" | "solana" | "tempo";

/**
 * What `/?tab=…&item=…&run=…` selects. `item` is an agent id (hex, lowercased so a pasted id in
 * either case finds its row) and `run` a loop id, which is the agent's run under it. Both are what
 * the URL says, not what the list holds: `resolveSelection` decides what is shown.
 */
export interface WorkspaceParams {
  tab: WorkspaceTab;
  item: string | null;
  run: string | null;
}

/** The query shapes the callers have: the browser's search string, Next's `searchParams`, or a map. */
export type WorkspaceQuery =
  | string
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function readParam(query: WorkspaceQuery, key: string): string | null {
  if (query === null || query === undefined) return null;
  let value: string | null | undefined;
  if (typeof query === "string") value = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).get(key);
  else if (query instanceof URLSearchParams) value = query.get(key);
  else {
    const raw = query[key];
    // Next hands a repeated parameter over as an array; the first is the one a link meant.
    value = Array.isArray(raw) ? raw[0] : raw;
  }
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function isTab(value: string | null): value is WorkspaceTab {
  return value === "yours" || value === "solana" || value === "tempo";
}

/** The URL's selection. An unknown or absent `tab` is Yours, which is what `/` opens on. */
export function parseWorkspaceParams(query: WorkspaceQuery): WorkspaceParams {
  const tab = readParam(query, "tab");
  const item = readParam(query, "item");
  return {
    tab: isTab(tab) ? tab : "yours",
    item: item ? item.toLowerCase() : null,
    run: readParam(query, "run"),
  };
}

/**
 * `/` with the parameters given, in the order `tab`, `item`, `run`. A parameter left out or `null`
 * is left off rather than written empty, so `/?item=X` — the `/agents?agent=X` redirect — stays the
 * short link it is meant to be.
 */
export function workspaceHref(params: Partial<WorkspaceParams> = {}): string {
  const out = new URLSearchParams();
  if (params.tab) out.set("tab", params.tab);
  if (params.item) out.set("item", params.item.toLowerCase());
  if (params.run) out.set("run", params.run);
  const query = out.toString();
  return query ? `/?${query}` : "/";
}

/**
 * Where a retired list route lands, or `null` for a path that is not one of them. The four
 * routes redirect on the server with this (`middleware.ts` answers all four; three also have a page
 * that does the same; `/market` has none, the marketplace being on the roadmap), so every link into them that
 * exists — a bookmark, a doc, a page this package does not own — still lands somewhere that shows
 * what it pointed at.
 *
 * `/loops?loop=L` needs L's agent for `item`. The server holds no registry read at that point, so
 * without `agentOfLoop` it sends `/?run=L` and the workspace finds the agent from the loop list it
 * reads anyway (`resolveSelection`); with one, the agent goes into the URL as well.
 */
export function legacyRedirect(
  pathname: string,
  query: WorkspaceQuery,
  agentOfLoop?: (loopId: string) => string | null | undefined
): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/agents") {
    const agent = readParam(query, "agent");
    return agent ? workspaceHref({ item: agent }) : "/";
  }
  if (path === "/loops") {
    const loop = readParam(query, "loop");
    if (!loop) return "/";
    const agent = agentOfLoop?.(loop) ?? null;
    return workspaceHref({ item: agent, run: loop });
  }
  // `/market` is the marketplace's route, which this build does not serve; a link to it lands on the
  // workspace rather than on a 404.
  if (path === "/zeroclaw" || path === "/market") return "/";
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Runs under their agents                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** What nesting needs of a loop run. `LoopView` is one. */
export interface NestLoop {
  id: string;
  agentId: string;
  status: "running" | "paused" | "stopped";
  createdAt: number;
  archivedAt?: number | null;
  lastStepAt?: number | null;
}

/** What nesting needs of an agent row: its id and when it last did anything (Unix ms). */
export interface NestAgent {
  agentId: string;
  activityMs: number;
}

/**
 * One run under its agent. Teams are not in this build, so a row that carries a team lists its
 * members as agents of their own rather than nested here.
 */
export interface NestedRun<L extends NestLoop> {
  loop: L;
}

/** One row of the Yours list: an agent, its live or latest run, and the runs before that. */
export interface NestedAgent<A extends NestAgent, L extends NestLoop> {
  agent: A;
  /** Lowercase hex. */
  agentId: string;
  /** The run that speaks for the agent: running over paused over stopped, then the newest. */
  current: NestedRun<L> | null;
  /** Every other run, newest first: what _N earlier runs_ folds. */
  earlier: NestedRun<L>[];
  /** The current run is running or paused. */
  live: boolean;
  /** What the list sorts by: the agent's own activity or its current run's, whichever is later. */
  activityMs: number;
}

/** Running beats paused beats stopped; inside a rank, the newest — the rule `tileRows` picks a tile's run by. */
export function runRank(loop: Pick<NestLoop, "status" | "createdAt">): number {
  const base = loop.status === "running" ? 3e15 : loop.status === "paused" ? 2e15 : 1e15;
  return base + (loop.createdAt ?? 0);
}

/**
 * The Yours list, nested: one row per agent, its live or latest run under it, the older runs
 * folded.
 *
 * - Archived runs are left out, as every list leaves them out.
 * - Order: live rows first, then by `activityMs`, newest first. Stable on ties, so the caller's
 *   own order (curated before fixture, for example) survives where nothing else decides.
 * - An agent appears once, under the first spelling of its id; a loop whose agent is not in
 *   `agents` gets no row — the caller decides which agents are the wallet's.
 */
export function nestWorkspace<A extends NestAgent, L extends NestLoop>(
  agents: readonly A[],
  loops: readonly L[]
): NestedAgent<A, L>[] {
  const byAgent = new Map<string, L[]>();
  for (const loop of loops) {
    if (loop.archivedAt) continue;
    const key = loop.agentId.toLowerCase();
    const list = byAgent.get(key);
    if (list) list.push(loop);
    else byAgent.set(key, [loop]);
  }

  const seen = new Set<string>();
  const unique: A[] = [];
  for (const agent of agents) {
    const key = agent.agentId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(agent);
  }

  // Each agent's runs, current first.
  const runsOf = new Map<string, L[]>();
  for (const agent of unique) {
    const key = agent.agentId.toLowerCase();
    const runs = [...(byAgent.get(key) ?? [])];
    if (runs.length === 0) continue;
    runs.sort((a, b) => runRank(b) - runRank(a));
    const [current, ...rest] = runs;
    rest.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    runsOf.set(key, [current, ...rest]);
  }

  const rows: NestedAgent<A, L>[] = [];
  for (const agent of unique) {
    const key = agent.agentId.toLowerCase();
    const runs = runsOf.get(key) ?? [];
    const nested = runs.map((loop) => ({ loop }));
    const current = nested[0] ?? null;
    const live = !!current && current.loop.status !== "stopped";
    const runActivity = current ? current.loop.lastStepAt ?? current.loop.createdAt ?? 0 : 0;
    rows.push({
      agent,
      agentId: key,
      current,
      earlier: nested.slice(1),
      live,
      activityMs: Math.max(agent.activityMs || 0, runActivity || 0),
    });
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.live !== b.row.live) return a.row.live ? -1 : 1;
      return b.row.activityMs - a.row.activityMs || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** What the workspace shows: an agent's panel (`runId` null) or one of its runs'. */
export interface WorkspaceSelection {
  agentId: string | null;
  runId: string | null;
}

/**
 * The item a URL selects, against the rows the list holds.
 *
 * - `run` wins when the list holds it, and brings its agent with it, whatever `item` says: a run
 *   belongs to one agent, and `/?run=L` (the `/loops?loop=L` redirect) names no agent at all.
 * - Else `item`, when it is a row.
 * - Else the first row's agent. A run or an agent the list does not hold (archived, another wallet's)
 *   falls back the same way, as the `/agents` and `/loops` panels did: the panel always shows
 *   something the list is showing.
 */
export function resolveSelection<A extends NestAgent, L extends NestLoop>(
  rows: readonly NestedAgent<A, L>[],
  params: Pick<WorkspaceParams, "item" | "run">
): WorkspaceSelection {
  if (params.run) {
    for (const row of rows) {
      for (const run of [row.current, ...row.earlier]) {
        if (run && run.loop.id === params.run) return { agentId: row.agentId, runId: run.loop.id };
      }
    }
  }
  const item = params.item?.toLowerCase() ?? null;
  if (item) {
    for (const row of rows) {
      if (row.agentId === item) return { agentId: item, runId: null };
    }
  }
  const first = rows[0];
  return first ? { agentId: first.agentId, runId: null } : { agentId: null, runId: null };
}

/* ------------------------------------------------------------------------------------------ */
/* What a run row says about Tempo                                                             */
/* ------------------------------------------------------------------------------------------ */

/** How many steps of history the console keeps per loop (`HISTORY_KEPT` in `_lib/loop-terms.ts`). */
export const HISTORY_KEPT = 50;

/** What a run row and its panel read about the run's Tempo payments. `LoopView` is one. */
export interface RunTempoInput {
  status: "running" | "paused" | "stopped";
  steps: number;
  rail?: "vault" | "tempo" | null;
  inference?: "openrouter" | "scripted" | null;
  tempo?: { txHash?: string } | null;
  channel?: { cumulative?: string } | null;
  history: readonly { tempoSpent?: string }[];
}

export interface RunTempo {
  /**
   * What the run's channel paid, USDC.e base units: the sum of every kept step's `tempoSpent`.
   * `null` when no kept step says anything, which is not the same as zero.
   */
  paidBase: bigint | null;
  /** The run pays over Tempo: its rail says so, a step paid on it, or it opened a channel or settled one. */
  onTempo: boolean;
  /** Nothing was paid because the steps ran scripted. */
  scripted: boolean;
  /** Its channel is open and paying now: running, with a cumulative on the open channel. */
  live: boolean;
  /** The console kept only the last `HISTORY_KEPT` steps, so `paidBase` is of those, not of the run. */
  capped: boolean;
}

/**
 * The run's Tempo line, from the row alone. There is no call count here on purpose: vouchers never
 * reach the loop row, so a number of calls would be one this page made up (the row says _paid on
 * Tempo_ instead, and the loop page counts calls from the chain).
 */
export function runTempo(loop: RunTempoInput): RunTempo {
  let paid: bigint | null = null;
  for (const h of loop.history ?? []) {
    const spent = h.tempoSpent;
    if (!spent || !/^\d+$/.test(spent)) continue;
    paid = (paid ?? BigInt(0)) + BigInt(spent);
  }
  const live = loop.status === "running" && !!loop.channel && !!loop.channel.cumulative;
  const onTempo = loop.rail === "tempo" || (paid !== null && paid > BigInt(0)) || !!loop.channel || !!loop.tempo;
  const scripted = !onTempo && loop.inference === "scripted";
  const capped = (loop.history?.length ?? 0) >= HISTORY_KEPT && loop.steps > (loop.history?.length ?? 0);
  return { paidBase: paid, onTempo, scripted, live, capped };
}

/**
 * USDC.e base units as a person reads them: `104000` is `0.104`, at least two decimals, the zeros
 * past them dropped — the digits `usdcEOfBase` in `lib/tempo-services.ts` prints, restated here so
 * this file stays import-free.
 */
export function usdcEText(base: bigint): string {
  const unit = BigInt(1_000_000);
  const neg = base < BigInt(0);
  const abs = neg ? -base : base;
  let frac = (abs % unit).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${abs / unit}.${frac}`;
}

/**
 * Who a line of the Solana tab's _What it records and charges_ is paid by. Nothing the tab lists is
 * paid by a loop's own key: the receipt, the one plugin line, is Lath's.
 */
export type SolanaPayer = "you" | "Lath";

/** One line of the Solana tab's _What it records and charges_ (`WorkspaceSolana`). */
export interface SolanaRecordLine {
  /** Stable, for the tab's test ids and this file's test; never shown. */
  key: "records" | "model-calls" | "receipt";
  label: string;
  who: SolanaPayer;
  how: string;
}

/**
 * The SAS · receipt's account and rent (tests/sas-receipt.ts sizes it), restated here because this
 * file imports nothing. Rent is the cluster's quote for 416 bytes, measured on devnet; the tab rounds
 * it to four places.
 */
export const RECEIPT_ACCOUNT_BYTES = 416;
export const RECEIPT_RENT_LAMPORTS = 2_763_520;

/**
 * What Lath writes on Solana, and who pays for each, in the order the tab lists them.
 *
 * The plugin the form offers is SAS · receipt, one per loop, which the console's own key signs and
 * pays for (`sas.attest`, a per-attestation line, is on the roadmap). It says the receipt points at the
 * records, never that it proves them: it is the console's claim about the loop, and the records are the
 * evidence.
 *
 * There is no _Loop keys_ line: only a loop granted a payment or attestation plugin gets a Solana key
 * of its own, and no grant plugin is in this build (the receipt is not a grant item).
 *
 * The model-call line carries no OpenRouter mark, because the line is the debit on Solana, not the
 * payment to OpenRouter, which is the Tempo tab's. Nor does it say _in the same transaction as the
 * record_, which is wrong for every loop step: with epochs on, each model
 * call's charge is a transaction of its own, journaled ahead of the epoch that holds the record
 * (`recordLlmStep` in runtime/src/runtime.ts, SPEC §15); only a record written on its own carries its
 * charge (`chargeAndLog`). _Call by call_ is true of both.
 */
export const SOLANA_RECORDS: readonly SolanaRecordLine[] = [
  {
    key: "records",
    label: "Agent records",
    who: "Lath",
    // One sentence for a first-time reader; the four kinds are SPEC §3's.
    how: "Every action is a compressed record in the agent's hash chain; Lath pays the fees.",
  },
  {
    key: "model-calls",
    label: "Model calls and report storage",
    who: "you",
    how: "USDC from your capped allowance, debited call by call",
  },
  {
    key: "receipt",
    label: "Loop receipt on SAS",
    who: "Lath",
    how: "one per loop, published when the goal check says achieved and the loop stops: a 416 B attestation that points at the loop's records, about 0.0028 SOL of rent plus a 5 000-lamport fee, paid by the console's key",
  },
];
