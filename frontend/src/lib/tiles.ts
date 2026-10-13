/**
 * The join behind the tile grids on the Agents and Loops tabs.
 *
 * A tile shows the same facts the two tables show, laid out, plus a description and a 24 h
 * sparkline. Those facts come from four places — the chain headers (`useMyOwners`), the console's
 * registry (`GET /api/agents`), the loop records (`GET /api/loops?owner=`) and the published
 * `NameRecord`s — and the point of doing the join here rather than in the components is that the
 * rule for *which* source wins a field, and which tag that field carries on the hover card, is
 * one readable list instead of two component trees that drift.
 *
 * Nothing in this file is React, Anchor, or Node: every input is declared structurally, the way
 * `lib/spend.ts` declares `ChargeLike`, so `tests/tile-rows.ts` can import it under the root
 * `tsconfig.json`, which resolves neither `@/` nor `@lath/sdk/browser`. That also means the
 * formatting helpers here are small copies rather than imports of `lib/format.ts`, which does
 * reach for the SDK.
 *
 * `events` is optional on purpose: whether the sparkline is fed by a per-tile read behind the
 * owner-scan pool is a measurement to make, and the losing branch is this one prop, not a second
 * build. `bins` is `null` — not 24 zeros — when no events were
 * passed, so a tile can tell *not read* from *nothing happened*.
 */

import { draftLoopBudget } from "./draft";

/** Which half of the system a field is true of: the chain, or the console's own records. */
export type SourceKind = "chain" | "console";

export type TileKind = "agent" | "loop" | "zeroclaw";

/**
 * The status vocabulary of both tabs. `stepping` outranks everything for the same reason
 * `LoopStatusBadge` gives it: it is the thing happening now. `active` / `idle` are the agent
 * tab's only two when no loop is running, and they are a statement about `AgentState.updatedAt`.
 */
export type TileStatus = "stepping" | "running" | "paused" | "stopped" | "finished" | "active" | "idle";

/** The `Badge` tone the status dot takes, in `ui.tsx`'s vocabulary. */
export type TileTone = "good" | "warn" | "bad" | "neutral" | "cyan" | "blue" | "volt";

export type TileRelation = "signer" | "funded";

/** One line of the hover card: what it says, and which half of the system said it. */
export interface TileField {
  label: string;
  value: string;
  source: SourceKind;
  /** Hashes, ids and keys line up in the mono column. */
  mono?: boolean;
  /** The full value when `value` is truncated, or a sentence explaining the field. */
  title?: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Inputs — structural, so the node test and the browser can both hand them over               */
/* ------------------------------------------------------------------------------------------ */

/** Anything with a `toBase58()`: a `PublicKey` in the browser, a stub in the test. */
export interface Base58Like {
  toBase58(): string;
}

/** A chain header as `useMyOwners` returns it (`MyOwner`), named by what this file reads. */
export interface TileOwnerInput {
  address?: Base58Like;
  relations?: readonly TileRelation[];
  allowance?: { cap: bigint; spent: bigint; expiresAt: bigint } | null;
  state: {
    agentId: Uint8Array | readonly number[] | string;
    authority: Base58Like;
    seq: bigint | number;
    head?: Uint8Array | readonly number[] | string;
    createdAt: bigint | number;
    /** Unix **milliseconds**: the program multiplies the clock by 1000 before it writes. */
    updatedAt: bigint | number;
  };
}

/** A row of the console's registry (`DeployedAgentRow`, plus `description`). */
export interface TileRegistryAgent {
  id: string;
  name?: string;
  owner?: string;
  /**
   * The one-line description the wizard asks for (`CreatorWizard.tsx`). Optional here because a
   * record written without it has none.
   */
  description?: string;
  policy?: { model?: string; tools?: readonly string[]; budgetCapUsdc?: string; expirationDays?: number };
  template?: { id: string; version: number } | null;
  clonedFrom?: { agentId: string; name: string; via?: string } | null;
  /** Set when this row is archived. The list form (`archived`) is the one the GET returns. */
  archivedAt?: number | null;
}

/** What `GET /api/agents` hands back: the rows, and the ids that are archived. */
export interface TileRegistryInput {
  agents?: readonly TileRegistryAgent[];
  archived?: readonly string[];
}

/** A loop as `GET /api/loops` projects it (`LoopView`), narrowed to what a tile reads. */
export interface TileLoopInput {
  id: string;
  agentId: string;
  agentName?: string;
  owner?: string;
  /** The standing instruction. */
  prompt?: string;
  promptHash?: string;
  intervalMs?: number;
  maxSteps?: number;
  /** The loop's one overall budget; absent from an older console's row. */
  budgetMicroUsdc?: string;
  /** The per-step budget such a console sent alone, read as `perStep × maxSteps` (`loopBudgetFoot`). */
  budgetMicroUsdcPerStep?: string;
  model?: string;
  createdAt?: number;
  trigger?: { kind: string } | null;
  template?: { id: string; version: number } | null;
  archivedAt?: number | null;
  status: "running" | "paused" | "stopped";
  stopReason?: string | null;
  stopDetail?: string | null;
  steps?: number;
  lastStepAt?: number | null;
  nextStepAt?: number | null;
  stepping?: boolean;
  totalCostMicroUsdc?: string;
  /** The second model the run asked for, when it did; absent on every other loop. */
  verify?: { model: string; minConfidence: number } | null;
}

/** One chain record, narrowed to the field the sparkline folds over. */
export interface TileEventInput {
  /** Unix **milliseconds** (`EventRecord.timestamp`; SPEC §4.2 and `check_timestamp`). */
  timestamp: bigint | number;
}

export interface TileRowsInput {
  owners?: readonly TileOwnerInput[];
  registry?: TileRegistryInput | null;
  loops?: readonly TileLoopInput[];
  /** Published names by agent id, as `usePublishedNames` returns them. */
  names?: Record<string, string> | null;
  /** Records per agent id. **Absent means not read** — see the file header. */
  events?: Record<string, readonly TileEventInput[] | undefined> | null;
  /** Unix milliseconds. Passed in rather than read, so the join is a function of its arguments. */
  now: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Output                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface TileRow {
  /** Stable React key: the agent id for an agent tile, the loop id for a loop tile. */
  key: string;
  kind: TileKind;
  /** Hex agent id. A loop tile carries its agent's id too, which is what the chain facts are of. */
  agentId: string;
  /** Set on loop tiles only. */
  loopId?: string;
  /** `/agent/<id>` or `/loop/<id>` — the page that already exists (click is the record). */
  href: string;
  /** The handle the five existing Playwright specs resolve rows by. */
  testId: "owner-row" | "loop-row" | "explore-row" | "zeroclaw-row";

  name: string;
  nameSource: SourceKind;
  /** True when nothing named this agent and `name` is the *unnamed · ‹id›* fallback. */
  unnamed: boolean;

  status: TileStatus;
  statusLabel: string;
  statusTone: TileTone;

  description: string;
  descriptionSource: SourceKind;
  /** True when `description` is the empty-state sentence rather than anything anyone wrote. */
  descriptionPlaceholder: boolean;

  /** 24 hourly counts, oldest first — or `null` when no events were read for this row. */
  bins: number[] | null;
  /** Records inside the 24 h window. 0 with a non-null `bins` means a quiet day, not no data. */
  eventCount: number;

  footLeft: string;
  footLeftSource: SourceKind;
  footRight: string;
  footRightSource: SourceKind;

  /** Agent tiles only: how this wallet is related to the header. */
  relations: TileRelation[];
  /**
   * `spent 0.25 / 5 USDC` when the wallet approved this agent an allowance — the tile's answer to
   * *funded*, which on its own said nothing: every funded agent draws on the same balance, and what
   * tells two of them apart is how much of it each may spend and has. Absent otherwise.
   */
  allowanceLabel?: string;
  /**
   * `0.044245 of 1 USDC spent`: what the agent's loop has drawn against its one budget, on a tile
   * with no allowance line to show, in place of a bare `seq N`, which is the one thing a reader
   * weighing an agent's spend cannot use.
   */
  spendLabel?: string;
  spendTitle?: string;
  /** The sentence behind `allowanceLabel`, for its title: what the numbers are, and the expiry. */
  allowanceTitle?: string;

  /** The hover card, in order. Every line carries its tag. */
  fields: TileField[];

  /** What the bar sorts on. `spent` is not here: it comes from the wallet's charge history. */
  sort: {
    /** Unix ms of the last chain write, or of the last step for a loop. */
    lastWriteMs: number;
    createdAtMs: number;
    /** Unix ms the next step is due; `null` when none is. */
    nextStepAtMs: number | null;
  };
}

/** What a tile says when nobody has written a description for the agent. */
export const EMPTY_DESCRIPTION = "No description yet.";

/** An agent whose header has not been written to in this long reads as idle rather than active. */
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

/** Hours in the sparkline window. */
export const SPARKLINE_BINS = 24;

const HOUR_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------------------------------ */
/* The sparkline fold                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * 24 hourly bins over record timestamps, oldest first, the last bin ending at `now`.
 *
 * Records outside the window are dropped rather than clamped into the end bins: a tile that drew
 * a year of history as a spike in the last hour would be a lie about when the agent worked. An
 * absent or empty list gives 24 zeros, which is the honest drawing of *this agent did nothing
 * today* — the distinction between that and *we did not read* is carried by `TileRow.bins` being
 * `null`, not by this function.
 */
export function bins24(events: readonly TileEventInput[] | undefined | null, now: number): number[] {
  const bins = new Array<number>(SPARKLINE_BINS).fill(0);
  if (!events) return bins;
  const start = now - SPARKLINE_BINS * HOUR_MS;
  for (const e of events) {
    const ts = Number(e.timestamp);
    if (!Number.isFinite(ts) || ts < start || ts > now) continue;
    // `ts === now` would index one past the end; the last bin owns its own upper edge.
    const idx = Math.min(SPARKLINE_BINS - 1, Math.floor((ts - start) / HOUR_MS));
    bins[idx] += 1;
  }
  return bins;
}

/* ------------------------------------------------------------------------------------------ */
/* Status                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface TileStatusInput {
  kind: TileKind;
  /** Agent tiles: unix ms of the header's last write. */
  updatedAtMs?: number;
  /** Agent tiles: the loop running on this agent, when one is. Loop tiles: the loop itself. */
  loop?: {
    status: "running" | "paused" | "stopped";
    stepping?: boolean;
    steps?: number;
    maxSteps?: number;
    stopReason?: string | null;
  } | null;
  now: number;
}

/**
 * The status dot.
 *
 * Agents: a running loop speaks first — `stepping` while a step is in flight, else `running` —
 * because what the agent is doing right now outranks when it last wrote. With no running loop it
 * is `active` if the header moved within the hour and `idle` otherwise. A *paused* or *stopped*
 * loop deliberately says nothing here: the agent is still an agent, and the loop's own tile on
 * the other tab is where its state belongs.
 *
 * Loops: the record's own status, with `finished` split out of `stopped` for a run that reached
 * its cap — reaching `maxSteps` is the run doing what it was asked, not a failure — or its goal,
 * which is the same ending arrived at earlier, and `anchor-failed` kept as the warning `LoopStatusBadge`
 * already words as *not anchored*: the step ran and its output exists, what is missing is the transactions.
 */
export function statusOf(input: TileStatusInput): { status: TileStatus; label: string; tone: TileTone } {
  const loop = input.loop;
  if (input.kind === "agent") {
    if (loop && loop.status === "running") {
      return loop.stepping
        ? { status: "stepping", label: "stepping", tone: "cyan" }
        : { status: "running", label: "running", tone: "blue" };
    }
    const updated = input.updatedAtMs ?? 0;
    return updated > 0 && input.now - updated < ACTIVE_WINDOW_MS
      ? { status: "active", label: "active", tone: "good" }
      : { status: "idle", label: "idle", tone: "neutral" };
  }

  if (!loop) return { status: "idle", label: "idle", tone: "neutral" };
  if (loop.status === "running") {
    return loop.stepping
      ? { status: "stepping", label: "stepping", tone: "cyan" }
      : { status: "running", label: "running", tone: "blue" };
  }
  if (loop.status === "paused") return { status: "paused", label: "paused", tone: "blue" };
  // A goal loop that got there finished, and finished before its cap, so `isFinished` below —
  // which asks whether the run reached `maxSteps` — would call it *stopped: goal-reached*. It is
  // the same kind of ending as `max-steps` and reads as one.
  if (loop.stopReason === "goal-reached") return { status: "finished", label: "completed", tone: "volt" };
  // A run that took every step it was given is finished even when a console counted it short of the
  // cap, and a run its owner stopped, one that spent its budget or one with no reason recorded is
  // grey: none of them is a fault, and an owner's own Stop must not read *stopped: stopped* in rose. The
  // words are `LoopStatusBadge`'s, so the tile and the list agree.
  if (isFinished(loop) || loop.stopReason === "max-steps")
    return { status: "finished", label: "finished", tone: "neutral" };
  if (loop.stopReason === "stopped" || !loop.stopReason)
    return { status: "stopped", label: "stopped", tone: "neutral" };
  if (loop.stopReason === "budget") return { status: "stopped", label: "budget spent", tone: "neutral" };
  if (loop.stopReason === "anchor-failed") return { status: "stopped", label: "not anchored", tone: "warn" };
  return { status: "stopped", label: `stopped: ${loop.stopReason}`, tone: "bad" };
}

/**
 * A run is finished when it reached the cap it was given. `stopReason` alone is not enough — a
 * run stopped by its owner at the last step is stopped — and `steps === maxSteps` alone is not
 * either, so both are required.
 */
function isFinished(loop: { steps?: number; maxSteps?: number; stopReason?: string | null }): boolean {
  const steps = loop.steps ?? 0;
  const max = loop.maxSteps ?? 0;
  return max > 0 && steps >= max && loop.stopReason === "max-steps";
}

/* ------------------------------------------------------------------------------------------ */
/* The join                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Both tabs' rows from one set of reads.
 *
 * Agent tiles come from the chain headers, because the chain is the list of agents that exist;
 * the registry only adds what the chain cannot carry (a description, lineage, a policy) and
 * takes away what the owner archived. Loop tiles come from the loop records, because a loop is a
 * console object whose chain facts hang off its agent.
 *
 * An unreachable registry therefore hides nothing and claims nothing, which is the right way
 * round and the rule `OwnerList` already follows: a list showing fewer agents than the wallet
 * owns because a fetch failed is a worse answer than one showing an archived row.
 */
export function tileRows(input: TileRowsInput): { agents: TileRow[]; loops: TileRow[] } {
  const now = input.now;
  const archived = new Set((input.registry?.archived ?? []).map((id) => id.toLowerCase()));
  const registryById = new Map<string, TileRegistryAgent>();
  for (const row of input.registry?.agents ?? []) {
    const id = String(row.id).toLowerCase();
    if (row.archivedAt) archived.add(id);
    registryById.set(id, row);
  }

  // A loop still on its schedule is what makes an agent's chip say `loop`, so the live rows are
  // indexed by agent before either list is built. Archived runs are dropped from both.
  const liveLoops = (input.loops ?? []).filter((l) => !l.archivedAt);
  const loopByAgent = new Map<string, TileLoopInput>();
  for (const loop of liveLoops) {
    const id = String(loop.agentId).toLowerCase();
    const existing = loopByAgent.get(id);
    // The most interesting run wins the chip: a running one over a stopped one, then the newest.
    if (!existing || rankLoop(loop) > rankLoop(existing)) loopByAgent.set(id, loop);
  }

  const agents: TileRow[] = [];
  for (const owner of input.owners ?? []) {
    const id = toHexId(owner.state.agentId);
    if (archived.has(id.toLowerCase())) continue;
    agents.push(agentRow(owner, id, registryById, loopByAgent, input, now));
  }
  agents.sort((a, b) => b.sort.lastWriteMs - a.sort.lastWriteMs);

  const loops: TileRow[] = liveLoops.map((loop) => loopRow(loop, registryById, input, now));
  loops.sort((a, b) => b.sort.lastWriteMs - a.sort.lastWriteMs);

  return { agents, loops };
}

/** Running beats paused beats stopped; inside a rank, the newest run. */
function rankLoop(loop: TileLoopInput): number {
  const base = loop.status === "running" ? 3e15 : loop.status === "paused" ? 2e15 : 1e15;
  return base + (loop.createdAt ?? 0);
}

function agentRow(
  owner: TileOwnerInput,
  id: string,
  registryById: Map<string, TileRegistryAgent>,
  loopByAgent: Map<string, TileLoopInput>,
  input: TileRowsInput,
  now: number
): TileRow {
  const key = id.toLowerCase();
  const reg = registryById.get(key);
  const loop = loopByAgent.get(key);
  const updatedAtMs = Number(owner.state.updatedAt ?? 0);
  const seq = Number(owner.state.seq ?? 0);

  // The published `NameRecord` is a chain fact and the registry's name is the console's; an
  // unnamed agent shows its id once rather than twice (the rule `OwnerList` settled).
  const published = lookupName(input.names, id);
  const name = published ?? reg?.name ?? `unnamed · ${shortId(id)}`;
  const nameSource: SourceKind = published ? "chain" : "console";

  const description = reg?.description ?? EMPTY_DESCRIPTION;
  const placeholder = !reg?.description;

  const status = statusOf({ kind: "agent", updatedAtMs, loop, now });
  const bins = binsFor(input.events, id, now);

  const relations = [...(owner.relations ?? [])];

  const fields: TileField[] = [];
  if (reg?.policy?.model) fields.push({ label: "model", value: reg.policy.model, source: "console" });
  if (reg?.policy?.tools?.length)
    fields.push({ label: "tools", value: reg.policy.tools.join(", "), source: "console" });
  if (owner.allowance) {
    fields.push({
      label: "allowance",
      value: `${formatMicro(owner.allowance.spent)} / ${formatMicro(owner.allowance.cap)} USDC`,
      source: "chain",
      mono: true,
      title: "spent against the cap this wallet granted the agent's authority",
    });
  }
  // The seq is on the foot too, but the card is what a reader tags, so it carries the seq
  // as a chain fact beside the head it commits to.
  fields.push({ label: "seq", value: String(owner.state.seq), source: "chain", mono: true });
  if (owner.state.head) {
    const head = toHexId(owner.state.head);
    fields.push({ label: "head", value: shortId(head), source: "chain", mono: true, title: head });
  }
  const authority = owner.state.authority.toBase58();
  fields.push({ label: "authority", value: shortKey(authority), source: "chain", mono: true, title: authority });
  if (reg?.template) {
    fields.push({
      label: "template",
      value: `${shortId(reg.template.id)} v${reg.template.version}`,
      source: "console",
      mono: true,
      title: `${reg.template.id} v${reg.template.version}`,
    });
  }
  if (reg?.clonedFrom) {
    fields.push({
      label: "cloned from",
      value: reg.clonedFrom.name,
      source: "console",
      // A copy launched off another wallet's marketplace listing (a roadmap feature this build does
      // not write) says so in its record (`via: "market"`); it reads as a copy all the same, with no market badge.
      title: reg.clonedFrom.via === "market" ? "copied from another wallet's agent" : "copied by its owner",
    });
  }

  const allowance = owner.allowance ? allowanceText(owner.allowance, now) : null;
  const spend = !allowance && loop ? loopSpendText(loop) : null;

  return {
    key: id,
    kind: loop ? "loop" : "agent",
    agentId: id,
    href: `/agent/${id}`,
    testId: "owner-row",
    name,
    nameSource,
    unnamed: !published && !reg?.name,
    status: status.status,
    statusLabel: status.label,
    statusTone: status.tone,
    description,
    descriptionSource: "console",
    descriptionPlaceholder: placeholder,
    bins,
    eventCount: countOf(bins),
    footLeft: `seq ${seq} · ${agoLabel(updatedAtMs, now)}`,
    footLeftSource: "chain",
    footRight: relations.length ? relations.join(" · ") : "—",
    footRightSource: "console",
    relations,
    ...(allowance ? { allowanceLabel: allowance.label, allowanceTitle: allowance.title } : {}),
    ...(spend ? { spendLabel: spend, spendTitle: "spent by this agent's loop, against the loop's one budget" } : {}),
    fields,
    sort: { lastWriteMs: updatedAtMs, createdAtMs: Number(owner.state.createdAt ?? 0), nextStepAtMs: null },
  };
}

function loopRow(
  loop: TileLoopInput,
  registryById: Map<string, TileRegistryAgent>,
  input: TileRowsInput,
  now: number
): TileRow {
  const agentId = String(loop.agentId);
  const reg = registryById.get(agentId.toLowerCase());
  const status = statusOf({ kind: "loop", loop, now });
  const bins = binsFor(input.events, agentId, now);
  const steps = loop.steps ?? 0;
  const max = loop.maxSteps ?? 0;

  const fields: TileField[] = [];
  const model = loop.model ?? reg?.policy?.model;
  if (model) fields.push({ label: "model", value: model, source: "console" });
  if (loop.promptHash) {
    fields.push({
      label: "prompt hash",
      value: shortId(loop.promptHash),
      source: "console",
      mono: true,
      title: `${loop.promptHash} — committed inside the session's policy_version_hash`,
    });
  }
  if (loop.trigger?.kind) fields.push({ label: "trigger", value: loop.trigger.kind, source: "console" });
  if (loop.totalCostMicroUsdc !== undefined) {
    fields.push({
      label: "spent",
      value: `${formatMicro(loop.totalCostMicroUsdc)} USDC`,
      source: "console",
      mono: true,
      title: "the console's total over this run's steps",
    });
  }
  fields.push({
    label: "coordinator",
    value: loop.agentName || shortId(agentId),
    source: "console",
    title: agentId,
  });
  if (loop.template) {
    fields.push({
      label: "template",
      value: `${shortId(loop.template.id)} v${loop.template.version}`,
      source: "console",
      mono: true,
      title: `${loop.template.id} v${loop.template.version}`,
    });
  }

  // The interval is what a scheduled run is; a request-triggered one has none worth showing, so
  // it says what wakes it instead of a number that would not describe it. A gated run is the same
  // case: its `intervalMs` is how often it looks, and *every 1 min* on its tile would read
  // as a step a minute when most looks step nothing.
  const kind = loop.trigger?.kind;
  const cadence =
    kind === "request" ? "on request" : kind === "gate" ? "on a gate" : intervalLabel(loop.intervalMs ?? 0);
  // Spent against the budget where the row has both, the budget alone where it has no spend yet.
  const budget = loopSpendText(loop) ?? loopBudgetFoot(loop);

  const named = loop.agentName || shortId(agentId);

  return {
    key: loop.id,
    kind: "loop",
    agentId,
    loopId: loop.id,
    href: `/loop/${loop.id}`,
    testId: "loop-row",
    name: named,
    nameSource: "console",
    unnamed: !loop.agentName,
    status: status.status,
    statusLabel: status.label,
    statusTone: status.tone,
    description: loop.prompt || EMPTY_DESCRIPTION,
    descriptionSource: "console",
    descriptionPlaceholder: !loop.prompt,
    bins,
    eventCount: countOf(bins),
    footLeft: `step ${steps}${max ? `/${max}` : ""} · next ${untilLabel(loop.nextStepAt ?? null, now)}`,
    footLeftSource: "console",
    footRight: [cadence, budget, loop.verify ? `verified ≥ ${loop.verify.minConfidence}` : null]
      .filter(Boolean)
      .join(" · "),
    footRightSource: "console",
    relations: [],
    fields,
    sort: {
      lastWriteMs: loop.lastStepAt ?? loop.createdAt ?? 0,
      createdAtMs: loop.createdAt ?? 0,
      nextStepAtMs: loop.nextStepAt ?? null,
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* ZeroClaw sandboxes                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** A value, which half of the system said it, and why there is none when there is none. */
export interface TileSourced<T> {
  value: T | null;
  source: SourceKind;
  note?: string;
}

/**
 * A loop's sandbox as `GET /api/zeroclaw` projects it (`ZeroClawView` in `types/zeroclaw.ts`),
 * declared structurally for the reason every input here is: the node test imports this file
 * under the root `tsconfig.json`, which resolves no `@/`.
 */
export interface TileZeroClawInput {
  loopId: string;
  agentId: string;
  agentName?: string;
  loopStatus: "running" | "paused" | "stopped";
  stepping?: boolean;
  createdAt?: number;
  sandboxed: boolean;
  wrapper: TileSourced<{ kind: string; platform: string }>;
  binarySha256: TileSourced<string>;
  postureHash: TileSourced<string>;
  lastStep: {
    step: number;
    seq: TileSourced<string>;
    ranAt: TileSourced<number>;
    zcActions: TileSourced<number>;
    replayable: boolean;
    workspace: TileSourced<{ bytes: number; files: number; capBytes: number; capFiles: number }>;
    refused?: string;
  } | null;
}

export interface TileZeroClawRowsInput {
  sandboxes?: readonly TileZeroClawInput[];
  /**
   * Agent headers by hex id, when the page read them: the one chain fact a sandbox tile can carry
   * without reading events. Absent, or missing an agent, and the foot falls back to the console's
   * record of the last step and says so with its tag.
   */
  headers?: Record<string, { seq: bigint | number; updatedAtMs: number } | undefined> | null;
  now: number;
}

/** What a sandbox's tile says before any step of its loop has run in one. */
export const NOT_SANDBOXED_DESCRIPTION = "Not yet sandboxed: no step of this loop has run in a sandbox.";

/**
 * The ZeroClaw tab's tiles: one per loop, because in this build every loop step runs in a
 * sandbox of its own.
 *
 * Its own function rather than a third list out of `tileRows`, because the input is its own
 * read (`GET /api/zeroclaw`) and the Agents and Loops tabs should not have to hand over sandboxes
 * they never draw.
 *
 * The foot is the tab's summary, each side under one tag. The left is the chain's when the page
 * read the agent's header — `seq · last write`, the words an agent tile uses — and the console's
 * record of the last step otherwise. The right is the console's: the wrapper the last step ran
 * under, its `zc.*` Action count and the workspace against its cap. A field no step has produced
 * is left out of the foot and said as *not yet sandboxed*, never drawn as a zero.
 */
export function zeroclawTileRows(input: TileZeroClawRowsInput): TileRow[] {
  const now = input.now;
  const rows = (input.sandboxes ?? []).map((sandbox) => zeroclawRow(sandbox, input.headers ?? null, now));
  rows.sort((a, b) => b.sort.lastWriteMs - a.sort.lastWriteMs);
  return rows;
}

function zeroclawRow(sandbox: TileZeroClawInput, headers: TileZeroClawRowsInput["headers"], now: number): TileRow {
  const agentId = String(sandbox.agentId);
  const header = headers ? headers[agentId] ?? headers[agentId.toLowerCase()] : undefined;
  const step = sandbox.lastStep;
  const wrapper = sandbox.wrapper.value;

  // A sandbox exists only while a step runs, so *in a sandbox* is the one live state it has; a loop at
  // rest has no room to describe, and a stopped one is not a failure of the sandbox.
  const status: { status: TileStatus; label: string; tone: TileTone } = sandbox.stepping
    ? { status: "stepping", label: "in a sandbox", tone: "cyan" }
    : sandbox.loopStatus === "running"
    ? { status: "running", label: "running", tone: "blue" }
    : sandbox.loopStatus === "paused"
    ? { status: "paused", label: "paused", tone: "blue" }
    : { status: "stopped", label: "stopped", tone: "neutral" };

  const ranAtMs = step?.ranAt.value ?? 0;
  const footLeft = header
    ? `seq ${String(header.seq)} · ${agoLabel(header.updatedAtMs, now)}`
    : step?.seq.value
    ? `seq ${step.seq.value} · ${agoLabel(ranAtMs, now)}`
    : "no step yet";
  const footLeftSource: SourceKind = header ? "chain" : "console";

  const right: string[] = [];
  if (wrapper) right.push(wrapper.kind);
  if (step && step.zcActions.value !== null) right.push(sandboxActions(step.zcActions.value));
  if (step?.workspace.value) {
    const w = step.workspace.value;
    right.push(`${bytesLabel(w.bytes)}/${bytesLabel(w.capBytes)}`);
  }
  const footRight = right.length ? right.join(" · ") : sandbox.sandboxed ? "—" : "not yet sandboxed";

  const description = !sandbox.sandboxed
    ? NOT_SANDBOXED_DESCRIPTION
    : step?.refused
    ? `Step ${step.step} was refused by its sandbox: ${step.refused}`
    : wrapper
    ? `The last sandboxed step ran under ${wrapper.kind} on ${platformLabel(wrapper.platform)}.`
    : NOT_SANDBOXED_DESCRIPTION;

  const fields: TileField[] = [];
  fields.push(sourced("wrapper", sandbox.wrapper, (w) => `${w.kind} · ${platformLabel(w.platform)}`));
  fields.push(sourced("binary sha256", sandbox.binarySha256, (h) => shortId(h), true));
  fields.push(sourced("posture hash", sandbox.postureHash, (h) => shortId(h), true));
  if (header) fields.push({ label: "seq", value: String(header.seq), source: "chain", mono: true });
  if (step) {
    fields.push(sourced("last step seq", step.seq, (s) => s, true));
    fields.push(sourced("zc actions", step.zcActions, (n) => String(n), true));
    fields.push(
      sourced(
        "workspace",
        step.workspace,
        (w) => `${bytesLabel(w.bytes)} / ${bytesLabel(w.capBytes)} · ${w.files} files`
      )
    );
    fields.push({
      label: "replayable",
      value: step.replayable ? "yes" : "no",
      source: "console",
      title: step.replayable ? "the step committed a replay record" : "the step committed no replay record",
    });
  }
  fields.push({ label: "loop", value: shortId(sandbox.loopId), source: "console", mono: true, title: sandbox.loopId });

  return {
    key: sandbox.loopId,
    kind: "zeroclaw",
    agentId,
    loopId: sandbox.loopId,
    href: `/zeroclaw/${sandbox.loopId}`,
    testId: "zeroclaw-row",
    name: sandbox.agentName || shortId(agentId),
    nameSource: "console",
    unnamed: !sandbox.agentName,
    status: status.status,
    statusLabel: status.label,
    statusTone: status.tone,
    description,
    descriptionSource: "console",
    descriptionPlaceholder: !sandbox.sandboxed,
    bins: null,
    eventCount: 0,
    footLeft,
    footLeftSource,
    footRight,
    footRightSource: "console",
    relations: [],
    fields,
    sort: {
      lastWriteMs: header?.updatedAtMs ?? (ranAtMs || sandbox.createdAt || 0),
      createdAtMs: sandbox.createdAt ?? 0,
      nextStepAtMs: null,
    },
  };
}

/** A hover-card line from a sourced value: the value, or `—` with the reason as its title. */
function sourced<T>(label: string, field: TileSourced<T>, show: (v: T) => string, mono = false): TileField {
  if (field.value === null) return { label, value: "—", source: field.source, title: field.note };
  const value = show(field.value);
  const title = typeof field.value === "object" ? undefined : String(field.value);
  return { label, value, source: field.source, ...(mono ? { mono } : {}), ...(title ? { title } : {}) };
}

function platformLabel(platform: string): string {
  return platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : platform;
}

/** Bytes in binary units, because the workspace cap is `8 MiB`. */
export function bytesLabel(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** `null` when this row's events were not read at all — see the file header. */
function binsFor(events: TileRowsInput["events"], id: string, now: number): number[] | null {
  if (!events) return null;
  const records = events[id] ?? events[id.toLowerCase()];
  if (!records) return null;
  return bins24(records, now);
}

function countOf(bins: number[] | null): number {
  return bins ? bins.reduce((n, b) => n + b, 0) : 0;
}

function lookupName(names: Record<string, string> | null | undefined, id: string): string | undefined {
  if (!names) return undefined;
  return names[id] || names[id.toLowerCase()] || undefined;
}

/* ------------------------------------------------------------------------------------------ */
/* Formatting — small copies, because `lib/format.ts` reaches for the SDK                      */
/* ------------------------------------------------------------------------------------------ */

/** Hex of a 32-byte id, or the id itself when the caller already has hex. */
export function toHexId(value: Uint8Array | readonly number[] | string): string {
  if (typeof value === "string") return value;
  let out = "";
  for (const b of value) out += (b & 0xff).toString(16).padStart(2, "0");
  return out;
}

export function shortId(value: string, lead = 8, tail = 6): string {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function shortKey(value: string): string {
  return shortId(value, 4, 4);
}

/**
 * `0.044245 of 1 USDC spent`: a run's spend against its one budget, spent at full precision and the
 * budget trimmed, because it is a round figure someone chose. `null` when the row has
 * no spend or no budget to state it against.
 */
export function loopSpendText(loop: {
  totalCostMicroUsdc?: string;
  budgetMicroUsdc?: string;
  budgetMicroUsdcPerStep?: string;
  maxSteps?: number;
}): string | null {
  const budget = draftLoopBudget(loop);
  if (budget === undefined || loop.totalCostMicroUsdc === undefined) return null;
  return `${formatMicro(loop.totalCostMicroUsdc)} of ${trimUsdc(budget)} USDC spent`;
}

/**
 * `6 sandbox actions`: the count of a step's tool calls the sandbox recorded as its own (`zc.*`
 * Actions), in words rather than as `6 zc`, the tool prefix, which says nothing to a reader who does
 * not know the sandbox's tool names.
 */
export function sandboxActions(n: number): string {
  return `${n} sandbox ${n === 1 ? "action" : "actions"}`;
}

/** Micro-USDC to a fixed-point string. Never floats: a balance is exact or it is wrong. */
/**
 * A loop's money as a tile's foot says it: the whole budget, *0.600000 budget*, and an older row
 * that stores only a per-step budget read as `perStep × maxSteps` rather than as the
 * per-step figure it stored — every loop tile quotes the same unit. `null` when the row names none.
 * Shared with the builder's *Start from* rows (`StartFrom.tsx`), which read the same fields.
 */
export function loopBudgetFoot(loop: {
  budgetMicroUsdc?: string;
  budgetMicroUsdcPerStep?: string;
  maxSteps?: number;
}): string | null {
  const budget = draftLoopBudget(loop);
  return budget === undefined ? null : `${formatMicro(budget)} budget`;
}

export function formatMicro(micro: bigint | string | number, decimals = 6): string {
  let value: bigint;
  try {
    value = typeof micro === "bigint" ? micro : BigInt(String(micro).split(".")[0] || "0");
  } catch {
    return "—";
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const frac = (abs % unit).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${(abs / unit).toString()}.${frac}`;
}

/** `1.500000` → `1.5`, `0.000000` → `0`: an amount on a tile, not a balance in a ledger. */
export function trimUsdc(micro: bigint | string | number): string {
  const fixed = formatMicro(micro);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * The allowance, in the tile's words. `expiresAt` is unix **seconds** (the billing program's clock),
 * and an expired grant says so on the label rather than in a title nobody hovers: it can no longer
 * be charged, which is the thing a reader of *spent x / y* would otherwise assume it can.
 */
function allowanceText(a: { cap: bigint; spent: bigint; expiresAt: bigint }, now: number) {
  const expiresMs = Number(a.expiresAt) * 1000;
  const expired = expiresMs > 0 && expiresMs <= now;
  const label = `spent ${trimUsdc(a.spent)} / ${trimUsdc(a.cap)} USDC${expired ? " · expired" : ""}`;
  const until = expiresMs > 0 ? new Date(expiresMs).toISOString().slice(0, 10) : null;
  const title =
    `Spent so far of the allowance your wallet approved this agent from its balance` +
    (until ? `; ${expired ? "expired" : "expires"} ${until}.` : ".");
  return { label, title };
}

/** "3 min ago" / "just now" / "—" for a past unix-ms timestamp. */
export function agoLabel(atMs: number, now: number): string {
  if (!atMs || !Number.isFinite(atMs) || atMs <= 0) return "—";
  const delta = now - atMs;
  if (delta < 0) return "just now";
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} h ago`;
  return `${Math.round(delta / 86_400_000)} d ago`;
}

/** "in 2 min" / "now" / "—" for a step that may already be due. */
export function untilLabel(atMs: number | null, now: number): string {
  if (!atMs) return "—";
  const delta = atMs - now;
  if (delta <= 1000) return "now";
  if (delta < 60_000) return `in ${Math.round(delta / 1000)} s`;
  if (delta < 3_600_000) return `in ${Math.round(delta / 60_000)} min`;
  return `in ${(delta / 3_600_000).toFixed(1)} h`;
}

/** The same words `lib/loops.ts` uses, so the tile and the table read alike. */
export function intervalLabel(ms: number): string {
  if (!ms) return "—";
  if (ms < 60_000) return `every ${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `every ${Math.round(ms / 60_000)} min`;
  const hours = ms / 3_600_000;
  return `every ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}
