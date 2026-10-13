/**
 * What the *Start from* step hands the wizard. The picker
 * (`lib/sources.ts`, `StartFrom.tsx`) produces one; `CreatorWizard` and `LoopStartForm` consume
 * one. The type lives on its own so the two sides can be built apart and meet on a shape neither
 * owns.
 *
 * Every field is optional: a blank start is `{ lineage: { kind: "blank" } }`, and a source that
 * predates templates fills only what its deployed policy carries. Amounts are the wizard's own
 * units — `budgetCapUsdc` is the decimal string the budget field shows, `budgetMicroUsdc` the
 * micro-USDC string a loop record stores — so a draft is applied to the form without arithmetic,
 * with one exception: an older source carries only a per-step budget, and
 * `draftLoopBudget` is the one place its whole-loop budget is derived.
 */
export interface Draft {
  /** Suffixed `-2` by the picker when it comes from a deployed agent, because names are ids. */
  name?: string;
  /** ≤ `MAX_PROMPT` (2000); enters `promptHash` and therefore `policy_version_hash` when set. */
  prompt?: string;
  description?: string;
  model?: string;
  tools?: string[];
  budgetCapUsdc?: string;
  expirationDays?: number;
  /**
   * Set when the source was a loop or a loop template. Read by `LoopEntry` and `LoopStartForm`
   * only: the wizard deploys an agent and never starts a loop.
   */
  loop?: DraftLoop;
  lineage: Lineage;
}

export interface DraftLoop {
  prompt?: string;
  /**
   * The goal a picked run or loop template was working toward, carried so that *Run again with
   * edits* keeps it rather than silently starting an open-ended loop. Absent on every source that
   * has none, including older loops written without a goal.
   */
  goal?: string;
  intervalMs?: number;
  maxSteps?: number;
  /**
   * The loop's one overall budget, micro-USDC, on a source that names it — every run and loop
   * template written with an overall budget, and every preset.
   */
  budgetMicroUsdc?: string;
  /**
   * The per-step budget of an older source without an overall one, carried as the source said it and
   * never written by a new one: `draftLoopBudget` reads it as `perStep × maxSteps` when there is no
   * `budgetMicroUsdc`. Kept rather than converted where the draft is built so a draft still says
   * what its source stored, and the derivation lives in one function instead of in every builder.
   */
  budgetMicroUsdcPerStep?: string;
  /**
   * The judge the picked run or loop template asked for, carried for the reason `goal` is: a
   * second run of a judged build that arrives unjudged is not the same build, and nothing on the
   * way through says the judge was dropped. Absent on every source that asked for none —
   * `publicLoop` puts `verify: null` on the wire for that, and `null` must not become a key here.
   */
  verify?: DraftVerify;
  /**
   * Whether the picked run or loop template had _Jev checks the goal_ on, carried for the reason
   * `verify` is. `true` or absent — absent on a source that had it off or had no goal, and on an
   * older source written without the check.
   */
  goalCheck?: true;
  /**
   * What the picked run or loop template was written with that is not in this build — a team, a
   * gate, the trace audit, an oracle trigger, grants (`earlierBuildFeatures` in `types/loop.ts`).
   * Named, never carried: the form starts the loop without them and says so in one line, for the
   * reason `verify` is carried. Absent on every source without one.
   */
  earlierBuild?: string[];
  /**
   * The sandbox the picked run or loop template opened: the tool switches
   * and the sources as typed, carried for the reason `verify` is — a *Run again with edits* whose
   * sandboxes arrived without their sources would start a loop that reads from memory what the first
   * one read from files, and nothing on the way through would say they were dropped. The sources
   * are fetched afresh by the new start. Absent on every source without one.
   */
  sandbox?: DraftSandbox;
  /** The agent a loop from *Your assets* keeps running on; absent when the wizard deploys a new one. */
  agentId?: string;
  agentName?: string;
}

/**
 * The judge, as `StartLoopRequest.verify` asks for it: the model and the
 * bar, either of which the server fills when the key is missing. Both optional because a loop
 * template's config is written by hand and a run's view is not the only source.
 */
export interface DraftVerify {
  model?: string;
  minConfidence?: number;
}

/**
 * The sandbox, as `StartLoopRequest.sandbox` asks for one: structurally `SandboxConfig` in `types/loop.ts`,
 * declared here rather than imported because `lib/sources.ts` builds one and is compiled by
 * `tests/console-sources.ts` under the root `tsconfig.json`, which resolves neither `@/…` nor the app's
 * runtime deps.
 */
export interface DraftSandbox {
  tools?: { chain?: boolean; store?: boolean };
  maxBytes?: number;
  maxFiles?: number;
  sources?: (
    | { kind: "github"; url: string }
    | { kind: "url"; url: string }
    | { kind: "solana"; cluster: "devnet" | "mainnet"; address: string }
    /** A file the owner attached: carried with its content, which is what the next start signs again. */
    | { kind: "text"; name: string; content: string; contentType?: "application/json" | "text/plain" | "text/markdown" }
    /** Another loop's sources restored from Irys: the list's only entry when it is there. */
    | { kind: "irys"; agent?: string; index?: string; sourcesHash: string }
  )[];
}

/**
 * Where a draft came from, which is what the review step says and what the deploy carries:
 * a template lineage appends `v‹n+1›` to `templateId` unless `fork` is ticked. `agent` and
 * `loop` sources resolve to their template when they have one, so `templateId`/`version` are the
 * fields the server reads; the source id is kept for the sentence on screen.
 */
export type Lineage =
  | { kind: "blank" }
  | {
      kind: "agent" | "template" | "loop" | "loop-template";
      sourceId: string;
      /** The name to say *appends v‹n+1› to ‹name›* with (the template keeps its first agent's name). */
      sourceName: string;
      templateId?: string;
      version?: number;
    };

/**
 * A draft's whole-loop budget, micro-USDC, or `undefined` when it names none: `budgetMicroUsdc`
 * when the source has it, and an older per-step-only source read as `perStep × maxSteps` —
 * the most that loop could ever have spent. The form snaps the result to its chips, so the team's
 * old per-task share is not added here: it would move a figure that is rounded to 1, 5, 10 or 25
 * USDC anyway, and the server derives an old *row's* budget with that share itself.
 */
export function draftLoopBudget(
  loop: Pick<DraftLoop, "budgetMicroUsdc" | "budgetMicroUsdcPerStep" | "maxSteps"> | undefined
): string | undefined {
  if (!loop) return undefined;
  if (loop.budgetMicroUsdc && /^\d+$/.test(loop.budgetMicroUsdc)) return loop.budgetMicroUsdc;
  const per = loop.budgetMicroUsdcPerStep;
  const steps = loop.maxSteps;
  if (!per || !/^\d+$/.test(per) || !steps || !Number.isInteger(steps) || steps < 1) return undefined;
  return (BigInt(per) * BigInt(steps)).toString();
}

/**
 * The `?from=` deep link a tile's hover card offers: `agent:‹id›`, `template:‹id›`, `loop:‹id›`.
 * An `offer:‹id›` link, which names a marketplace listing (on the roadmap), parses to nothing and the
 * builder opens blank.
 */
export type SourceRef = { kind: "agent" | "template" | "loop"; id: string };

export function parseSourceRef(from: string | null | undefined): SourceRef | null {
  if (!from) return null;
  const m = /^(agent|template|loop):([A-Za-z0-9_-]{1,80})$/.exec(from);
  return m ? { kind: m[1] as SourceRef["kind"], id: m[2] } : null;
}
