"use client";

/**
 * What the *Start from* step can start from, and what picking one hands the wizard.
 *
 * Two halves. `sourceToDraft` is the rule — a deployed agent, a template version, a loop record
 * or a loop template, read into the `Draft` of `lib/draft.ts` — and `useBuilderSources` is the
 * read that offers the wallet its own rows. The rule is the half worth pinning, because it is
 * where the decisions live: a name is suffixed because names are ids, a pre-template
 * agent is synthesised from the policy the registry kept for it, and a row this wallet does not
 * own or has archived is refused rather than quietly filled in.
 *
 * **Nothing here imports `@tanstack/react-query`, `@lath/sdk/browser` or `@/…`.** The root
 * `tsconfig.json` that `tests/console-sources.ts` compiles under resolves none of the three, and
 * the rule above has to be checkable without a browser — the same constraint `lib/tiles.ts` and
 * `lib/owner-scan.ts` are written to. So the wallet's own rows are read with `fetch` and React
 * state rather than through the app's query hooks. A marketplace listing is not a source in this
 * build (the marketplace is on the roadmap); a `?from=offer:` link does not parse.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Draft, DraftLoop, DraftSandbox, DraftVerify, Lineage, SourceRef } from "./draft";
import { earlierBuildFeatures, type EarlierBuildFeature } from "../types/loop";

/** Which flow the picker is serving: `/create` or `/create?loop=1`. */
export type BuilderKind = "agent" | "loop";

/* ------------------------------------------------------------------------------------------ */
/* The rows, structurally                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** The config half of an agent, as both a registry policy and a template config carry it. */
export interface SourcePolicy {
  prompt?: string;
  model?: string;
  tools?: readonly string[];
  budgetCapUsdc?: string;
  expirationDays?: number;
}

/** A row of `GET /api/agents?owner=` (`DeployedAgent`), narrowed to what a draft reads. */
export interface SourceAgentRow {
  id: string;
  name?: string;
  owner?: string;
  description?: string;
  policy?: SourcePolicy;
  /** The template version this agent was deployed from; absent on every row that predates them. */
  template?: { id: string; version: number } | null;
  archivedAt?: number | null;
}

/** A row of `GET /api/templates?owner=` — `AgentTemplate` or `LoopTemplate`, one shape. */
export interface SourceTemplateRow {
  id: string;
  kind: "agent" | "loop";
  owner?: string;
  name: string;
  version: number;
  archivedAt?: number | null;
  createdAt?: number;
  /** How many versions the store holds, as the list route reports it. */
  versions?: number;
  config: SourcePolicy & Partial<SourceLoopTerms> & { coordinator?: { agentId?: string } | Record<string, unknown> };
}

/** The terms a loop runs on, shared by a `LoopView` and a loop template's config. */
export interface SourceLoopTerms {
  prompt: string;
  intervalMs: number;
  maxSteps: number;
  /**
   * The loop's one overall budget, micro-USDC: on every run's view (the console derives an older
   * row's) and on a loop template stored with one.
   */
  budgetMicroUsdc?: string;
  /**
   * The per-step budget, which an older template version carries alone. Optional
   * because a source that names `budgetMicroUsdc` is read by that, and this share is not a term.
   */
  budgetMicroUsdcPerStep?: string;
  model?: string;
  /** What the run works toward, on a source that has one. */
  goal?: string;
  /**
   * The judge, on a source that asked for one. `null` as well as absent,
   * because the two sides disagree on how they say *none*: a run's view carries `verify: null`
   * on purpose so the browser has a value to read, while a loop template's config leaves the key
   * out. Both mean the same thing here.
   */
  verify?: SourceVerify | null;
  /** Jev's goal check, on a source that ran with one; `null` for the reason `verify` gives. */
  goalCheck?: SourceVerify | null;
  /**
   * Terms a loop ran with that this build does not have — the trace audit, a team, a gate, an oracle
   * trigger, grants, all on the roadmap — on a loop template's config that stored one. Read only to name
   * them (`earlierBuildFeatures`), whatever their shape: a draft never carries them, and a start that
   * did would be refused. A run's view names them in `earlierBuild` instead.
   */
  traceAudit?: unknown;
  workers?: unknown;
  gate?: unknown;
  trigger?: { kind: string } | null;
  grants?: unknown;
  /**
   * The sandbox, as a loop template's config stores it (`SandboxConfig`): the
   * inputs as typed, never what they resolved to. A run's view wraps the same config with the
   * manifest's hash (`SourceSandboxRecord`), which is why `SourceLoopRow` names it apart.
   */
  sandbox?: DraftSandbox | null;
}

/**
 * The sandbox as a run's view carries it (`LoopSandboxRecord`): the config the run was started with and,
 * when it had sources, the hash of what they resolved to. Only `config` is carried into a draft —
 * the hash pins that run's fetch, and a second start fetches afresh and pins its own.
 */
export interface SourceSandboxRecord {
  config: DraftSandbox;
  sourcesHash?: string;
}

/**
 * The judge as either source carries it, which is `VerifyTerms` with both fields filled: the
 * server resolves the model and the bar once at the start and stores what it resolved, so a run's
 * view and a stored template version both carry the pair. Not widened to partials — `lib/tiles.ts`
 * reads the same rows for its *verified ≥ n* chip and would then have two shapes to render.
 */
export interface SourceVerify {
  model: string;
  minConfidence: number;
}

/** A row of `GET /api/loops?owner=` (`LoopView`), narrowed the same way. */
export interface SourceLoopRow extends Partial<Omit<SourceLoopTerms, "sandbox" | "prompt">> {
  prompt?: string;
  id: string;
  agentId: string;
  agentName?: string;
  owner?: string;
  template?: { id: string; version: number } | null;
  archivedAt?: number | null;
  status?: "running" | "paused" | "stopped";
  steps?: number;
  createdAt?: number;
  /** What this run ran with that this build does not have (`LoopView.earlierBuild`). */
  earlierBuild?: readonly EarlierBuildFeature[];
  /** The run's own sandbox, wrapped with its manifest's hash; absent on a run started without one. */
  sandbox?: SourceSandboxRecord | null;
}

/* ------------------------------------------------------------------------------------------ */
/* What a pick is                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * One pick, with the wallet it was picked under.
 *
 * The wallet rides along rather than being a second argument because ownership is what decides
 * whether a source may be read at all, and a rule that can be called without the thing it checks
 * is a rule that gets called without it.
 */
export type BuilderSource =
  | { kind: "agent"; wallet: string; row: SourceAgentRow; template?: SourceTemplateRow | null }
  | { kind: "template"; wallet: string; row: SourceTemplateRow }
  | { kind: "loop"; wallet: string; row: SourceLoopRow; template?: SourceTemplateRow | null }
  | { kind: "loop-template"; wallet: string; row: SourceTemplateRow };

/** Why a source was refused. Each one is a rule, not a failure of the read. */
export type RefusalReason =
  /** `owner !== wallet`: another wallet's asset is not a starting point. */
  | "foreign"
  /** The owner archived it; archived rows stay readable and are not offered as a starting point. */
  | "archived";

export class SourceRefused extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.name = "SourceRefused";
    this.reason = reason;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The rule                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const MAX_TOOLS_COPIED = 64;

/**
 * A pick, read into the draft the wizard opens with.
 *
 * Three things it decides:
 *
 * 1. **The name.** A deployed agent's name is its id (`agent_id = sha256(name)`), so starting from
 *    one has to propose a different name or the deploy is a 409 the user reads as a bug. `-2` is
 *    the suffix the clone path already uses. A template's name is *not* an id — it is the name of
 *    the first agent deployed from it — so it is offered as written and the
 *    server is the one that refuses a collision.
 * 2. **The prompt.** Only ever from a row this wallet owns: `mine` holds nothing
 *    else, and the refusals below are what keep that true when a deep link asks for something
 *    else. An agent that predates templates has no prompt to copy, and the draft says so by
 *    leaving the field unset rather than inventing one.
 * 3. **The lineage.** `templateId`/`version` come from the source's template link, which is what
 *    the deploy appends a version to; a source with no link carries the source id
 *    alone, and the review step then has a fork to mint rather than a version to append.
 */
export function sourceToDraft(source: BuilderSource): Draft {
  guardOwned(source);

  if (source.kind === "agent") return agentDraft(source.row, source.template ?? null);
  if (source.kind === "template") return templateDraft(source.row);
  if (source.kind === "loop") return loopDraft(source.row, source.template ?? null);
  return loopTemplateDraft(source.row);
}

/** The two refusals every source passes through first. */
function guardOwned(source: BuilderSource): void {
  const row = source.row as { owner?: string; archivedAt?: number | null; name?: string; id: string };
  const label = row.name || row.id;
  if (row.owner !== source.wallet) {
    throw new SourceRefused(
      "foreign",
      `${label} belongs to another wallet: only your own agents, templates and runs are a starting point`
    );
  }
  if (row.archivedAt) {
    throw new SourceRefused("archived", `${label} is archived: it stays readable, and is not a starting point`);
  }
}

function agentDraft(row: SourceAgentRow, template: SourceTemplateRow | null): Draft {
  const config = template?.kind === "agent" ? template.config : undefined;
  const policy = row.policy ?? {};
  return {
    // A deployed name is taken, on chain and for good: the wizard opens on the next one along.
    name: row.name ? `${row.name}-2` : undefined,
    prompt: trimmed(config?.prompt),
    description: trimmed(row.description),
    model: config?.model ?? policy.model,
    tools: tools(config?.tools ?? policy.tools),
    budgetCapUsdc: config?.budgetCapUsdc ?? policy.budgetCapUsdc,
    expirationDays: config?.expirationDays ?? policy.expirationDays,
    lineage: link({ kind: "agent", sourceId: row.id, sourceName: row.name ?? row.id }, row.template, template),
  };
}

function templateDraft(row: SourceTemplateRow): Draft {
  const config = row.config ?? {};
  return {
    name: row.name,
    prompt: trimmed(config.prompt),
    model: config.model,
    tools: tools(config.tools),
    budgetCapUsdc: config.budgetCapUsdc,
    expirationDays: config.expirationDays,
    lineage: { kind: "template", sourceId: row.id, sourceName: row.name, templateId: row.id, version: row.version },
  };
}

/**
 * A loop the wallet already ran, opened again with its terms in the form.
 *
 * `agentId` is kept: *Run again* runs on the agent that ran it, and the wizard's deploy step is
 * not what a loop from this source needs — the schedule is (the loop flow's second row).
 * The standing instruction is the loop's, so it lands in `loop.prompt` and not in the agent's
 * system prompt, which is a different field committed under a different hash.
 */
function loopDraft(row: SourceLoopRow, template: SourceTemplateRow | null): Draft {
  const config = template?.kind === "loop" ? template.config : undefined;
  return {
    model: row.model ?? config?.model,
    loop: loopTerms(row, config),
    lineage: link({ kind: "loop", sourceId: row.id, sourceName: row.agentName ?? row.id }, row.template, template),
  };
}

function loopTemplateDraft(row: SourceTemplateRow): Draft {
  const config = row.config ?? {};
  const coordinator = config.coordinator as { agentId?: string } | undefined;
  return {
    name: row.name,
    model: config.model,
    // `sandbox: undefined` after the spread: a template's config holds the sandbox bare, where a run's
    // row wraps it with the manifest's hash, so it is read from `config` below and not as a row's.
    loop: loopTerms({ id: row.id, agentId: coordinator?.agentId ?? "", ...config, sandbox: undefined }, config),
    lineage: {
      kind: "loop-template",
      sourceId: row.id,
      sourceName: row.name,
      templateId: row.id,
      version: row.version,
    },
  };
}

/** What `loopTerms` reads: a run's row, or a loop template's config dressed as one by `loopTemplateDraft`. */
function loopTerms(row: SourceLoopRow, config: Partial<SourceLoopTerms> | undefined): DraftLoop {
  const terms: DraftLoop = {
    prompt: trimmed(row.prompt ?? config?.prompt),
    // Picked like the rest of the terms rather than spread: a key this function does not name is
    // a key *Run again with edits* drops, and dropping the goal would silently turn a run that
    // knew when it was finished into an open-ended one.
    intervalMs: row.intervalMs ?? config?.intervalMs,
    maxSteps: row.maxSteps ?? config?.maxSteps,
  };
  // The whole-loop budget when the source names one, and otherwise the per-step budget an older
  // source stored — never both, so a draft carries exactly one reading of its money and
  // `draftLoopBudget` is what turns the old one into the new (`perStep × maxSteps`). The row's own
  // before its template's, like every term here: the row is what that run was started with.
  const whole = row.budgetMicroUsdc ?? config?.budgetMicroUsdc;
  if (whole) terms.budgetMicroUsdc = whole;
  else terms.budgetMicroUsdcPerStep = row.budgetMicroUsdcPerStep ?? config?.budgetMicroUsdcPerStep;
  // An empty `agentId` is what a loop template with a `{ template }` coordinator leaves behind;
  // absent says *the wizard deploys one* where `""` would say *this agent*, which is no agent.
  // Set only when there is one: a goal-less loop's draft has no `goal` key, so a draft written
  // without a goal compares equal to one from a source that never had the key.
  const goal = trimmed(row.goal ?? config?.goal);
  if (goal) terms.goal = goal;
  // The judge, under the same rule, and for the reason the comment above gives one key further on: a
  // judged run started again with only its goal edited would come out unjudged, and nothing on the
  // way through would say so. `??` rather than a merge — a row's own terms are what that run committed,
  // and a template's are the fallback for a source that is a template.
  const verify = verifyTerms(row.verify ?? config?.verify);
  if (verify) terms.verify = verify;
  // Jev's goal check, under the same rule: a *Run again* of a run Jev stopped
  // must not come back stopped by the agent's claim alone. Only beside a goal, which it asks about.
  if (goal && (row.goalCheck ?? config?.goalCheck)) terms.goalCheck = true;
  // What the source ran with that this build does not have — a team, a gate, the trace audit, an
  // oracle trigger, grants — named and never carried, for the reason the judge is carried: the form starts
  // the loop without them, and says so in one line rather than drop them in silence. A run's view names
  // them itself; a loop template's config, a run's template included, by its keys. Absent when there are
  // none, so a draft without them compares equal to one whose source never had them.
  const earlier = row.earlierBuild?.length ? [...row.earlierBuild] : earlierBuildFeatures(config ?? row);
  if (earlier.length) terms.earlierBuild = earlier;
  // The sandbox, under the same rule: a *Run again* whose sandboxes opened without their sources or
  // with the store switched back on would start a different loop, and nothing on the way through would
  // say so. A run's own config first, its template's as the fallback — the template a run minted holds
  // the sandbox it was started with.
  const sandbox = sandboxTerms(row.sandbox?.config ?? config?.sandbox);
  if (sandbox) terms.sandbox = sandbox;
  if (row.agentId) terms.agentId = row.agentId;
  if (row.agentName) terms.agentName = row.agentName;
  return terms;
}

/**
 * The sandbox a start can ask for again, or nothing.
 *
 * Picked key by key: a config written by hand, or a view from a
 * later build, may carry keys a start does not take, and the server refuses a `sandbox` with a key it
 * does not know rather than ignoring it. Each key is kept only when it says something — a switch
 * that is a boolean, a cap that is a positive whole number, a source list with a row in it — so a
 * config that says nothing leaves **no** `sandbox` key, and the draft of a run without a sandbox compares
 * equal to one written without a sandbox config (the absent-when-off rule).
 */
function sandboxTerms(source: DraftSandbox | null | undefined): DraftSandbox | undefined {
  if (!source || typeof source !== "object") return undefined;
  const terms: DraftSandbox = {};
  const tools: NonNullable<DraftSandbox["tools"]> = {};
  if (typeof source.tools?.chain === "boolean") tools.chain = source.tools.chain;
  if (typeof source.tools?.store === "boolean") tools.store = source.tools.store;
  if (Object.keys(tools).length) terms.tools = tools;
  for (const k of ["maxBytes", "maxFiles"] as const) {
    const cap = source[k];
    if (typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0) terms[k] = cap;
  }
  // The inputs as typed, each rebuilt from its own kind's fields, so a row carries nothing another
  // kind would read. The new start fetches them afresh and pins them again. A set restored
  // from another loop's sources on Irys is carried as the restore it was — the hash and whichever
  // of the agent and the index named it — so the new start reads the same set again and commits the
  // same hash, rather than dropping to a sandbox with no sources.
  const sources = (source.sources ?? []).flatMap((s): NonNullable<DraftSandbox["sources"]> => {
    if (s?.kind === "solana") return [{ kind: "solana", cluster: s.cluster, address: s.address }];
    if (s?.kind === "github" || s?.kind === "url") return [{ kind: s.kind, url: s.url }];
    // An attached file is carried whole, content and all, as the version stores it: the
    // owner signed those bytes, and the new start writes and commits them again — the same file, so
    // the same hash — where a URL is fetched afresh. Only the owner's own run or version has it: a
    // reader who is not the owner is served neither the sources nor their content.
    if (s?.kind === "text" && typeof s.name === "string" && typeof s.content === "string") {
      return [
        {
          kind: "text",
          name: s.name,
          content: s.content,
          ...(s.contentType !== undefined ? { contentType: s.contentType } : {}),
        },
      ];
    }
    if (s?.kind === "irys" && typeof s.sourcesHash === "string") {
      return [
        {
          kind: "irys",
          sourcesHash: s.sourcesHash,
          ...(typeof s.agent === "string" ? { agent: s.agent } : {}),
          ...(typeof s.index === "string" ? { index: s.index } : {}),
        },
      ];
    }
    return [];
  });
  if (sources.length) terms.sources = sources;
  return Object.keys(terms).length ? terms : undefined;
}

/**
 * The judge a start can ask for again, or nothing.
 *
 * `null` is what `publicLoop` puts on the wire for *this run asked for no judge*, and it has to
 * leave **no key** here rather than become `verify: null`: a draft of an unjudged loop is
 * compared — by a person reading the form, and by the two `deepEqual` cases that pin this — with
 * drafts written without a judge, and an explicit null is a key those do not have (the
 * absent-when-off rule).
 */
function verifyTerms(source: SourceVerify | null | undefined): DraftVerify | undefined {
  if (!source) return undefined;
  const terms: DraftVerify = {};
  const model = trimmed(source.model);
  if (model) terms.model = model;
  // A run's view always carries the bar; a config written by hand may not, and the server fills
  // the default for a key it does not see. Checked rather than coerced: the number reaches
  // `policy_version_hash`, so a string that happens to parse is a value nobody chose.
  if (typeof source.minConfidence === "number" && Number.isFinite(source.minConfidence)) {
    terms.minConfidence = source.minConfidence;
  }
  return terms;
}

/**
 * The lineage of a source that may or may not have a template behind it. A version the caller
 * resolved wins over the link's, because the link records the version the *run* used and the
 * picker offers the latest — appending to an older one would bury the versions in between.
 */
function link(
  base: { kind: "agent" | "loop"; sourceId: string; sourceName: string },
  linked: { id: string; version: number } | null | undefined,
  template: SourceTemplateRow | null
): Lineage {
  if (!linked) return base;
  return {
    ...base,
    templateId: linked.id,
    version: template && template.id === linked.id ? template.version : linked.version,
  };
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** A copy, not the source's array, and bounded: a draft is form state, not a config to trust. */
function tools(list: readonly string[] | undefined): string[] | undefined {
  return list && list.length ? list.slice(0, MAX_TOOLS_COPIED) : undefined;
}

/* ------------------------------------------------------------------------------------------ */
/* Deep links                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * The source a `?from=` names, or `null` while the reads have not found it.
 *
 * `template:‹id›` resolves against both template lists: a loop template and an agent template are
 * one store and one id space, and which flow the picker is in decides which list holds it, not
 * what the link says.
 */
export function resolveSourceRef(sources: BuilderSources, ref: SourceRef | null, wallet: string): BuilderSource | null {
  if (!ref || !wallet) return null;
  const id = ref.id.toLowerCase();
  const same = (value: string | undefined) => (value ?? "").toLowerCase() === id;

  if (ref.kind === "agent") {
    const row = sources.mine.agents.find((a) => same(a.id));
    return row ? { kind: "agent", wallet, row, template: templateFor(sources, row.template) } : null;
  }
  if (ref.kind === "loop") {
    const row = sources.mine.loops.find((l) => same(l.id));
    return row ? { kind: "loop", wallet, row, template: templateFor(sources, row.template) } : null;
  }
  const row = sources.mine.templates.find((t) => same(t.id));
  if (!row) return null;
  return row.kind === "loop" ? { kind: "loop-template", wallet, row } : { kind: "template", wallet, row };
}

function templateFor(
  sources: BuilderSources,
  linked: { id: string; version: number } | null | undefined
): SourceTemplateRow | null {
  if (!linked) return null;
  return sources.mine.templates.find((t) => t.id === linked.id) ?? null;
}

/* ------------------------------------------------------------------------------------------ */
/* The read                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface BuilderSources {
  mine: { agents: SourceAgentRow[]; templates: SourceTemplateRow[]; loops: SourceLoopRow[] };
}

export interface BuilderSourcesRead extends BuilderSources {
  loading: boolean;
  /** What the console answered when it would not list the wallet's rows. */
  error: string | null;
}

/**
 * The wallet's own rows.
 *
 * Own rows are three open GETs, filtered again here on `owner` and on `archivedAt`: the routes
 * filter already, and a picker that offered a row the deploy would refuse is worse than one read
 * twice. The agent flow lists deployed agents and agent templates; the loop flow lists the
 * wallet's agents as well, because attaching a schedule to an agent it already has is what the
 * loop entry has always opened on.
 *
 * With no wallet connected there is nothing to list — every row here is somebody's — so the hook
 * reads nothing rather than showing another wallet's console.
 */
export function useBuilderSources(wallet: string | null, kind: BuilderKind): BuilderSourcesRead {
  const [agents, setAgents] = useState<SourceAgentRow[]>([]);
  const [templates, setTemplates] = useState<SourceTemplateRow[]>([]);
  const [loops, setLoops] = useState<SourceLoopRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readJson = useCallback(async (url: string, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }, []);

  useEffect(() => {
    if (!wallet) {
      setAgents([]);
      setTemplates([]);
      setLoops([]);
      setError(null);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    // Drop the rows read for the previous wallet, so none stays pickable while the re-read is in flight.
    setAgents([]);
    setTemplates([]);
    setLoops([]);
    const owner = encodeURIComponent(wallet);
    Promise.all([
      readJson(`/api/agents?owner=${owner}`, abort.signal),
      readJson(`/api/templates?owner=${owner}`, abort.signal),
      readJson(`/api/loops?owner=${owner}`, abort.signal),
    ])
      .then(([a, t, l]) => {
        if (abort.signal.aborted) return;
        setAgents(((a.agents as SourceAgentRow[]) ?? []).filter((row) => owned(row, wallet)));
        setTemplates(((t.templates as SourceTemplateRow[]) ?? []).filter((row) => owned(row, wallet)));
        setLoops(((l.loops as SourceLoopRow[]) ?? []).filter((row) => owned(row, wallet)));
        setError(null);
      })
      .catch((err: unknown) => {
        // An aborted read is this effect being replaced, not a console that would not answer.
        if (abort.signal.aborted) return;
        setError(err instanceof Error ? err.message : "the console would not list this wallet's rows");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [wallet, readJson]);

  return useMemo(() => {
    const templatesOfKind = templates.filter((t) => (kind === "loop" ? t.kind === "loop" : t.kind === "agent"));
    return {
      mine: {
        agents,
        templates: templatesOfKind,
        // A loop is a schedule on an agent, so *run again with edits* is only offered in the flow
        // that builds one; the agent flow has nothing to do with a run that already exists.
        loops: kind === "loop" ? loops : [],
      },
      loading,
      error,
    };
  }, [agents, templates, loops, kind, loading, error]);
}

function owned(row: { owner?: string; archivedAt?: number | null }, wallet: string): boolean {
  return row.owner === wallet && !row.archivedAt;
}
