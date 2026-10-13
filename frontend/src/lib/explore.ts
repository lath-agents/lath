/**
 * The join behind the Explore tab: one tile per agent header on the
 * program, whoever signs for it.
 *
 * It is `tileRows` over a wider set of headers, not a second join. The Agents tab passes the
 * wallet's headers with their relations; this passes every header `listAgents()` found, marks the
 * wallet's own as `signer`, and adds the three facts a reader browsing other people's chains needs
 * that a reader of their own list does not: which ever wrote a `loop.step` checkpoint (a loop
 * this console does not run is still a loop, and the chain says so), and which are machine-named
 * fixtures that belong below the fold.
 *
 * No React, Anchor or Node here for the reason `lib/tiles.ts` gives: `tests/explore-rows.ts`
 * loads it under the root `tsconfig.json`.
 */

import {
  TileField,
  TileLoopInput,
  TileOwnerInput,
  TileRegistryInput,
  TileRelation,
  TileRow,
  tileRows,
  toHexId,
} from "./tiles";

/**
 * The three prefixes machines write under, and why each exists:
 *
 * - `e2e-` — the Playwright suite, which deploys and publishes under a fresh machine name on every
 *   run.
 * - `mv2-` — scripted marketplace test runs on devnet, e.g. `mv2-0911-src`.
 * - `walk-` — manual test runs.
 *
 * A demo is never seeded under any of them, so the prefixes are reserved in the one direction that
 * matters: a curated agent will not be named this way by accident. Explore uses the rule to order
 * fixtures after curated rows.
 */
const FIXTURE_PREFIX = /^(e2e-|mv2-|walk-)/;

/**
 * A trailing run suffix — six lowercase base-36 characters after a hyphen, the shape
 * `idFromString`-derived run ids print in (`e2e-pub-x7jhtn`, `e2e-seller-rmsw01`).
 *
 * It will also match a real six-letter word after a hyphen. That is deliberate rather than
 * overlooked: tightening it (requiring a digit, say) would miss `yscmjf` and `jhtnqs`, and the
 * cost of a miss is a fixture on the fold while the cost of a false hit is a curated row one
 * place lower. None of the five seeded names — `slot-watcher`, `fee-reporter`, `chain-auditor`,
 * `balance-monitor`, `web-researcher` — has a six-character last segment.
 */
const FIXTURE_RUN_SUFFIX = /-[0-9a-z]{6}$/;

/**
 * Was this name written by a test, a manual test run or a seed script rather than chosen for a reader?
 *
 * Pure and total: anything that is not a string is not a fixture, so an unnamed row sorts by the
 * rule for unnamed rows rather than being pushed down for having no name at all. An ordering and
 * never a filter: a false positive moves a row down the grid, it never makes one disappear.
 */
export function isFixtureName(name: string | undefined | null): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  return FIXTURE_PREFIX.test(trimmed) || FIXTURE_RUN_SUFFIX.test(trimmed);
}

export interface ExploreRowsInput {
  headers?: readonly TileOwnerInput[];
  registry?: TileRegistryInput | null;
  loops?: readonly TileLoopInput[];
  names?: Record<string, string> | null;
  /** Agent ids with at least one `loop.step` Action on their chain. */
  checkpointed?: ReadonlySet<string> | readonly string[] | null;
  /** The connected wallet, base58. Its headers get the `signer` relation, as on the Agents tab. */
  wallet?: string | null;
  /**
   * The wallet's relations by agent id, as `useMyOwners` read them — `funded` is the half a scan
   * of headers cannot see, because a console agent is signed for by a key the server derives, not
   * by the wallet that pays for it.
   */
  relations?: Record<string, readonly TileRelation[]> | null;
  /** The allowance the wallet approved each funded agent, by agent id (`MyOwner.allowance`). */
  allowances?: Record<string, { cap: bigint; spent: bigint; expiresAt: bigint } | undefined> | null;
  now: number;
}

export interface ExploreRow extends TileRow {
  /**
   * The agent is the connected wallet's: it signs for it, funds it, or started it through this
   * console (the registry row or a loop names the wallet as owner). What the *Yours* scope shows.
   */
  mine: boolean;
  /** The chain holds a `loop.step` checkpoint for this agent. */
  checkpointed: boolean;
  /** Named like a test fixture (`isFixtureName`), which orders it after everything else. */
  fixture: boolean;
  /** The header's `seq`: how many records the chain holds, which the *records* sort ranks by. */
  records: number;
}

/**
 * The one control over the home grid: three views of the wallet's own rows — all of them, its
 * agents, its loops. A fourth, **Public**, listed every agent anyone had published as a launchable
 * offer, and left with the marketplace; an agent is still on chain and still has its page.
 */
export type ExploreView = "yours" | "agents" | "loops";

export type ExploreSort = "featured" | "last-write" | "newest" | "records";

/**
 * Every header as a tile, in the order Explore opens on: described rows, then other
 * chosen names, then fixture names, then unnamed headers, each tier by last write. Archived agents stay hidden here as on the Agents tab — archiving is the
 * owner saying *not on the list*, and Explore is a list.
 */
export function exploreRows(input: ExploreRowsInput): ExploreRow[] {
  const wallet = input.wallet ?? null;
  const known = lowerKeys(input.relations ?? {});
  const approved = lowerKeys(input.allowances ?? {});
  const owners: TileOwnerInput[] = (input.headers ?? []).map((h) => {
    const id = toHexId(h.state.agentId).toLowerCase();
    const relations = new Set<TileRelation>(known.get(id) ?? []);
    if (wallet && h.state.authority.toBase58() === wallet) relations.add("signer");
    return { ...h, relations: [...relations], allowance: approved.get(id) ?? null };
  });

  // What this console recorded the wallet as owning: agents it deployed, and agents its loops run.
  const startedHere = new Set<string>();
  if (wallet) {
    for (const row of input.registry?.agents ?? []) if (row.owner === wallet) startedHere.add(row.id.toLowerCase());
    for (const loop of input.loops ?? []) if (loop.owner === wallet) startedHere.add(loop.agentId.toLowerCase());
  }

  const { agents } = tileRows({
    owners,
    registry: input.registry,
    loops: input.loops,
    names: input.names,
    now: input.now,
  });

  const checkpointed = new Set([...(input.checkpointed ?? [])].map((id) => id.toLowerCase()));
  const seqById = new Map<string, number>();
  for (const h of input.headers ?? []) seqById.set(toHexId(h.state.agentId).toLowerCase(), Number(h.state.seq ?? 0));

  const rows = agents.map((row): ExploreRow => {
    const key = row.agentId.toLowerCase();
    const onChainLoop = checkpointed.has(key);
    const fields: TileField[] = [...row.fields];
    if (onChainLoop) {
      fields.unshift({
        label: "kind",
        value: "loop",
        source: "chain",
        title: "this chain holds at least one loop.step checkpoint",
      });
    }
    return {
      ...row,
      kind: row.kind === "loop" || onChainLoop ? "loop" : "agent",
      testId: "explore-row",
      fields,
      mine: row.relations.length > 0 || startedHere.has(key),
      checkpointed: onChainLoop,
      fixture: isFixtureName(row.unnamed ? null : row.name),
      records: seqById.get(key) ?? 0,
    };
  });

  // Stable, so each tier keeps `tileRows`' last-write order. A row that says what it does — a
  // description — opens the page; a bare name follows it, then fixture names, then unnamed
  // headers. Unnamed goes last rather than with the curated rows: on a grid of every chain they
  // are almost all test runs, and an id is not something a visitor can choose by.
  const tier = (r: ExploreRow) => (r.unnamed ? 3 : r.fixture ? 2 : !r.descriptionPlaceholder ? 0 : 1);
  return rows.sort((a, b) => tier(a) - tier(b));
}

/** The rows a view shows: the wallet's own, all of them or one kind. */
export function viewExplore(rows: readonly ExploreRow[], view: ExploreView): ExploreRow[] {
  return rows.filter((r) => {
    if (!r.mine) return false;
    return view === "agents" ? r.kind === "agent" : view === "loops" ? r.kind === "loop" : true;
  });
}

/** The search box, applied. `query` matches name, id and authority, as on the Agents tab. */
export function searchExplore(
  rows: readonly ExploreRow[],
  query: string,
  authorityOf?: (row: ExploreRow) => string | undefined
): ExploreRow[] {
  const q = query.toLowerCase().trim();
  return rows.filter((row) => {
    if (!q) return true;
    const name = row.unnamed ? "" : row.name.toLowerCase();
    const authority = authorityOf?.(row)?.toLowerCase() ?? "";
    return row.agentId.toLowerCase().includes(q) || name.includes(q) || authority.includes(q);
  });
}

/**
 * The sort, applied to a copy. `featured` is the order `exploreRows` returned — curated before
 * fixtures — so choosing it again after another sort puts the page back where it opened.
 */
export function sortExplore(rows: readonly ExploreRow[], sort: ExploreSort): ExploreRow[] {
  if (sort === "featured") return [...rows];
  return [...rows].sort((a, b) => {
    if (sort === "newest") return b.sort.createdAtMs - a.sort.createdAtMs;
    if (sort === "records") return b.records - a.records || b.sort.lastWriteMs - a.sort.lastWriteMs;
    return b.sort.lastWriteMs - a.sort.lastWriteMs;
  });
}

function lowerKeys<V>(record: Record<string, V>): Map<string, V> {
  return new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
}
