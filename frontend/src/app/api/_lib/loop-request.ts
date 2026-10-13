/**
 * A loop's start (`_lib/loops.ts` re-exports it): the request's checks, shared with the route and
 * `templates/validate.ts`; the preparation (the deposit check, the sources, the access key); and the
 * plan that becomes the row. `startLoop` in `loop-scheduler.ts` puts the row on the clock, and
 * `_lib/loop-start.ts` answers the route.
 */
import { toBytes32, type LoopReceiptPointer } from "@lath/sdk";
import type { LoopSnapshot, TempoKeyScope } from "@lath/runtime";
import type { SandboxConfig } from "../../../types/loop";
import {
  type LoopTemplate,
  type LoopTemplateConfig,
  type Template,
  type TemplateLink,
  appendOrMint,
  implicitTemplate,
  lookupTemplate,
  templateForAppend,
  templateLink,
} from "./templates";
import { anchorQueue } from "./anchor";
import { tempoEnabled } from "./tempo";
import type { LoopTempoKey } from "./tempo-keys";
import { roadmapStartRefusal } from "./roadmap";
import { STORE_TOOL_NAMES } from "./tools";
import { type DeployedAgent, MODELS, SESSION_CAP_MICRO, isArchived, lookupAgent } from "./runner";
import {
  asksForTraceAudit,
  checkGoal,
  checkGoalCheck,
  checkGrants,
  checkVerify,
  checkWorkersRequest,
  type ConsoleLoopTrigger,
  DEFAULT_GOAL_PROMPT,
  errorText,
  fallbackModelFor,
  goalHashOf,
  grantsRefusal,
  LOOP_BUDGET_MAX_MICRO,
  LOOPS_PER_WALLET,
  MAX_INTERVAL_MS,
  MAX_STEPS,
  MIN_INTERVAL_MS,
  promptHashOf,
  type Refusal,
  TRACE_AUDIT_START_REFUSAL,
  type VerifyTerms,
} from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { budgetFromPerStep, jevBudgetOf } from "./loop-budget";
import { readLoops } from "./loop-registry";
import {
  checkSandboxConfig,
  discardFetchedSources,
  sandboxOf,
  sandboxToolNames,
  sandboxToolRefusal,
  storeSwitchRefusal,
  zeroclawReadiness,
} from "./loop-sandbox";
import { fetchLoopSources, mintLoopId, type ResolvedLoopSources, type SandboxHooks } from "./loop-sources";
import { checkReceipt } from "./loop-receipt";
import { loopSettling, treasuryShortfall } from "./loop-channel-state";
import { abandonLoopKey, LOOP_KEY_LIFETIME_S, loopKeyLimitBase, loopKeySeams } from "./loop-key";

/**
 * What a start's preparation is handed besides the request: the Tempo treasury's USDC.e, for the
 * deposit check at a start (`treasuryShortfall`). Only the routes pass it (`treasuryHeld`): a test
 * that prepares a start without it is not asking this process's real treasury, whose balance is not
 * the test's to depend on.
 */
export interface StartHooks {
  treasuryHeld?: () => Promise<bigint | null>;
}

/**
 * The key a start carries to `planLoopStart`: created and authorized here, at the very end of
 * `prepareLoopStart` — after every refusal a start can earn and after the owner's signature, so no
 * start a later check refuses leaves an authorized key on the treasury. The loop id is minted here
 * when no fetch minted it, because the key's file is named by it.
 *
 * A failure refuses the start with Tempo's reason and leaves no file behind (`authorizeLoopKey`
 * deletes its own; this deletes one a throw from `createLoopKey` might leave). There is no fallback
 * to a treasury-signed channel: the Genesis would commit a key the payments never used.
 */
async function withLoopKey(
  body: LoopStartBody,
  allowed: CheckedLoopStart,
  resolvedSandbox: ResolvedLoopSources | undefined,
  home: string | undefined
): Promise<LoopStartBody | Refusal> {
  const keys = loopKeySeams;
  if (!keys.enabled()) return body;
  const loopId = resolvedSandbox?.loopId ?? mintLoopId(allowed.agentId, Date.now());
  const limitBase = loopKeyLimitBase(allowed.checked);
  const expiry = Math.floor(Date.now() / 1000) + LOOP_KEY_LIFETIME_S;
  let refusal: string | null = null;
  let tempoKey: LoopTempoKey | undefined;
  // The key's call scopes, built before the key exists: the storage payee is the one thing in them
  // read off the network, and a gateway that cannot name it refuses the start here, where nothing has
  // been written or sent yet. No fallback to an unscoped key — that is
  // what `LATH_TEMPO_KEY_SCOPES=off` says on purpose, and a start does not decide it for the operator.
  let scopes: TempoKeyScope[] | undefined;
  if (keys.scopesEnabled()) {
    try {
      scopes = keys.scopes(await keys.storagePayee());
    } catch (e) {
      if (resolvedSandbox) discardFetchedSources(resolvedSandbox.loopId, home);
      return {
        error:
          `Tempo's storage gateway did not name the address it is paid at, so this loop's access key could not ` +
          `be scoped and the loop was not started: ${errorText(e)}`,
        status: 502,
      };
    }
  }
  try {
    // Three arguments when unscoped: an unscoped key is created without a scopes argument at all.
    const created = scopes ? keys.create(loopId, limitBase, expiry, scopes) : keys.create(loopId, limitBase, expiry);
    const authorized = await keys.authorize(created);
    // Never the file: the row this lands on is what the API reads (contract, `LoopRecord.tempoKey`).
    const { file: _file, ...kept } = authorized;
    if (!kept.authorizeTx) refusal = "the treasury's authorize transaction came back without a hash";
    // The scopes the key was authorized with are the ones the row — and so every step's policy —
    // commits; an unscoped key's row carries none, so its policy hashes as a keyed one without scopes.
    else tempoKey = scopes ? { ...kept, scopes } : kept;
  } catch (e) {
    refusal = errorText(e);
  }
  if (refusal || !tempoKey) {
    try {
      keys.deleteFile(loopId);
    } catch (e) {
      console.warn(`[loops] the key file of refused start ${loopId} was not removed: ${errorText(e)}`);
    }
    // Nothing will run on these files either.
    if (resolvedSandbox) discardFetchedSources(resolvedSandbox.loopId, home);
    return {
      error: `Tempo did not authorize this loop's access key, so the loop was not started: ${refusal}`,
      status: 502,
    };
  }
  return { ...body, resolvedTempoKey: tempoKey };
}

// ─── Validation, shared with the route ──────────────────────────────────────

/**
 * May this wallet start a loop from this template? The template and the agent it coordinates, or
 * why not.
 *
 * Here rather than in the route for the reason `copyContext` is in `_lib/copy.ts`: a route
 * that imports `next/server` cannot be loaded outside `frontend/`, and these are the rules worth
 * testing (`tests/console-loops.ts`).
 *
 * Archive means the same on both routes: `POST /api/agents` refuses a deploy from an archived
 * template, and so does a loop start — otherwise the same stamp would mean two different things
 * depending on which route read it. It means one thing: **a retired id starts nothing new.** Not a retired
 * *configuration* — the ad-hoc branch of `planLoopStart` hashes the same bytes, finds no live
 * template to reuse (`ownedTemplates` filters archived rows out) and mints a second id for them,
 * which starts. That is the way back from an archive (a new version), reached
 * by a different door; what archive does not do is take a configuration out of circulation.
 */
export function loopStartTemplate(
  template: Template | null,
  wallet: string
): { template: LoopTemplate; agentId: string } | Refusal {
  if (!template || template.kind !== "loop") return { error: "no loop template with that id and version", status: 404 };
  // Starting a run from a template is a write on the owner's chain, so the signer has to be the
  // wallet that wrote the template.
  if (template.owner !== wallet) return { error: "this template belongs to another wallet", status: 403 };
  if (template.archivedAt) {
    return { error: `${template.id} is archived; write a new version to start a loop from it`, status: 409 };
  }
  const coordinator = template.config.coordinator;
  if (!("agentId" in coordinator)) {
    return {
      error: "this template's coordinator is not a deployed agent, which is all a loop start resolves today",
      status: 400,
    };
  }
  return { template, agentId: coordinator.agentId };
}

/**
 * May this wallet run a loop on this agent? The agent, or why not.
 *
 * A loop runs a deployed agent, and only for the wallet that deployed it — the same rule
 * `/api/run` applies to a session, for the same reason: the chain is the owner's history. And the
 * same archive rule, for the same reason: a loop is a schedule of sessions, so an archived agent
 * that `/api/run` refuses one session on must not be handed a hundred through *Run again* on a
 * stopped run — billed, scheduled, and hidden from every list.
 */
export function loopStartAgent(agent: DeployedAgent | null, wallet: string): { agent: DeployedAgent } | Refusal {
  if (!agent) return { error: "no agent with that id was deployed here", status: 404 };
  if (!agent.owner) {
    return {
      error: "this agent was deployed before ownership was recorded; redeploy it under a wallet to loop it",
      status: 403,
    };
  }
  if (agent.owner !== wallet) return { error: "this agent belongs to another wallet", status: 403 };
  if (isArchived(agent)) return { error: `${agent.name} is archived; a loop would open sessions on it`, status: 409 };
  return { agent };
}

/** What a start asks for, in the shape both `POST /api/loops` and a deploy's `loop` take. */
export interface LoopStartBody {
  agentId?: string;
  prompt?: string;
  intervalMs?: number;
  maxSteps?: number;
  /**
   * The loop's one overall budget, micro-USDC as a whole number. Absent on an older body, template
   * or listing that names only a per-step figure, whose budget is derived from
   * `budgetMicroUsdcPerStep` (and its team's per-task budget) by `checkLoopRequest`.
   */
  budgetMicroUsdc?: string;
  /** The per-step budget an older caller sends; read only when `budgetMicroUsdc` is absent. */
  budgetMicroUsdcPerStep?: string;
  model?: string;
  /**
   * What decides a step: `schedule`, the default and the only one this build starts. A `request`,
   * `feed` or `gate` trigger (on the roadmap) is refused by
   * `checkLoopRequest`, never dropped. Unchecked here — `checkLoopTrigger` is what reads it.
   */
  trigger?: unknown;
  /**
   * Ask for a second model to judge each step before its output becomes memory: `true` for the resolved
   * defaults, `{ model?, minConfidence? }` to pin either, `false` or absent for the loop that exists today.
   * Unchecked here — `checkVerify` is what reads it, for the reason `trigger` is unchecked here.
   */
  verify?: unknown;
  /**
   * What the loop is working toward. Unchecked here — `checkGoal` is
   * what reads it, for the reason `trigger` and `verify` are unchecked here. A body that carries
   * one and no `prompt` gets the default standing instruction from `checkLoopRequest`.
   */
  goal?: string;
  /**
   * Ask Jev whether the goal is achieved after each step: `true`, or absent
   * and `false` for the goal loop that exists today. Ignored without a goal. Unchecked here —
   * `checkGoalCheck` is what reads it.
   */
  goalCheck?: unknown;
  /**
   * The trace audit, which is not in this build: absent, `null` or `false` is
   * the loop that exists today, and anything else is refused by `checkLoopRequest` (`asksForTraceAudit`).
   * Typed here so a body that sends it is read, and refused, rather than dropped.
   */
  traceAudit?: unknown;
  /**
   * A team (on the roadmap), which this build refuses whatever it holds:
   * `checkWorkersRequest` is what reads it, so a body or a stored version that asks for one is
   * told so rather than started without it.
   */
  workers?: unknown;
  /**
   * The gate a `gate` trigger looks through. Gated loops are not in this
   * build: a body carrying one is refused by `checkLoopRequest`, never dropped, because a start's
   * signature binds its terms.
   */
  gate?: unknown;
  /**
   * The sandbox every step opens: the tool switches, the workspace cap and
   * the sources. Unchecked here — `checkSandboxConfig` is what reads it, for the reason `workers` and
   * `gate` are unchecked here.
   */
  sandbox?: unknown;
  /** `sandbox` under the name older clients send, read through `sandboxOf` and never written. */
  room?: unknown;
  /**
   * The sources `prepareLoopStart` fetched, handed in because the fetch is async and
   * `planLoopStart` is not. The loop id is minted with the fetch because the
   * fetched directory is named by it. Never taken from a caller: `prepareLoopStart` drops any a
   * body arrives with before it sets its own.
   */
  resolvedSandbox?: ResolvedLoopSources;
  /**
   * The loop's Tempo access key, authorized by `prepareLoopStart` at its very end when
   * `LATH_TEMPO_LOOP_KEYS` is on, for the reason
   * `resolvedSandbox` is handed in: the authorize is a treasury transaction and `planLoopStart` is
   * synchronous. Its `loopId` is the loop's id. Never taken from a caller: `prepareLoopStart` drops
   * any a body arrives with, so a start cannot name a key it did not get.
   */
  resolvedTempoKey?: LoopTempoKey;
  /**
   * Protocol-plugin grants, which an older client may still send. Not in this build: `checkGrants` refuses a start that
   * carries any, and `checkLoopRequest` a deploy, a listing and *Run again* (`grantsRefusal`). Never
   * stored in a template version.
   */
  grants?: unknown;
  /**
   * The loop receipt's pointer, signed with the rest of the body.
   * Unchecked here — `checkReceipt` reads it. Refused on a deploy and a listing.
   */
  receipt?: unknown;
  /**
   * Start from a stored loop template instead of the long body — or, when the long body is here
   * too, the template this start's terms are appended to: *run again with edits* extends the
   * lineage it came from rather than minting a second one.
   */
  templateId?: string;
  /** Which version of it; the latest when omitted. */
  version?: number;
  /**
   * Append into a fresh template carrying `clonedFrom` instead of extending the named one.
   * Meaningful only beside the long body: there is nothing to fork into otherwise.
   */
  fork?: boolean;
}

/**
 * The half of a start that writes a chain, run after every refusal and before the half that
 * writes a record.
 *
 * `planLoopStart` is synchronous, and has to stay so: three routes call it from inside a deploy
 * or a launch that has already landed, where an `await` would be a second round trip between a
 * transaction and the record that names it. Fetching the sources and authorizing the loop's key
 * are async, so they happen here and what they produced is handed to `planLoopStart` on the body.
 *
 * **Every refusal first**. `checkLoopStart` runs before anything is fetched or written: the
 * agent is this wallet's and not archived, a stored template is this wallet's, the terms are in
 * bounds (a team among them, which this build refuses), the agent has no loop running and the
 * wallet is under `LOOPS_PER_WALLET`.
 *
 * Returns the body to pass on, so a caller is one `await` and one call rather than a branch.
 */
export async function prepareLoopStart(
  body: LoopStartBody,
  wallet: string,
  hooks: StartHooks & SandboxHooks = {}
): Promise<LoopStartBody | Refusal> {
  // A fetch is this function's to make and to name; one a caller wrote into the body is dropped
  // before anything reads it, so a start cannot point its sandboxes at a directory it chose.
  const { resolvedSandbox: _unasked, resolvedTempoKey: _unaskedKey, ...clean } = body;
  body = clean;
  const allowed = checkLoopStart(body, wallet);
  if ("error" in allowed) return { error: allowed.error, status: allowed.status };

  // The anchor queue's half of `owingRunOf`, which needs a read `checkLoopStart` cannot
  // make: writes still journaled for this chain, from a run or a session that stopped before they
  // landed. Asked before anything below writes — the sources' locator cell is a direct write and
  // would take the seq the first journaled entry was built for. Pending entries are a writer still
  // draining; failed ones are a run's Retry or Discard to settle.
  const journaled = await anchorQueue().carried(toBytes32(allowed.agentId));
  if (journaled.length > 0) {
    return {
      error: journaled.some((e) => e.state === "failed")
        ? owingRunRefusal(allowed.deployed.name)
        : `${allowed.deployed.name}'s chain has ${journaled.length} write${
            journaled.length === 1 ? "" : "s"
          } still landing; try again in a minute`,
      status: 409,
    };
  }

  // Whether the treasury can hold this run's Tempo deposit, asked before any source is fetched. Short of it
  // every step runs scripted and unbilled (`tempoCanCover`), which the owner would learn only from a server
  // log line after signing — and would need a stop and a restart to fix. On a deploy's or a
  // launch's confirm the wallet has already signed by now, so their prepares ask it first
  // (`api/agents/route.ts`, `launchLoopRefusal`) and this is the second ask, for a treasury drawn down in
  // between. Only on a console with a treasury: one without it bills nothing anyway.
  if (hooks.treasuryHeld && tempoEnabled()) {
    const short = treasuryShortfall(allowed.checked, await hooks.treasuryHeld());
    if (short) return { error: short, status: 409 };
  }

  // The sources, fetched before the key is authorized below.
  let resolvedSandbox: LoopStartBody["resolvedSandbox"];
  let home: string | undefined = hooks.zeroclawHome;
  const sourced = allowed.checked.sandbox?.sources;
  if (sourced && sourced.length > 0) {
    // Whether this console can run a step, asked before the fetch writes into its home. A deploy
    // and a launch reach here without `POST /api/loops`'s own check, and the fetch lands under
    // `LATH_ZEROCLAW_HOME`: a home inside `LATH_TRACE_DIR` would put the files in clear in the
    // store the blob route serves, and a console with no binary would fetch for a loop whose
    // first step it must refuse.
    const ready = (hooks.readiness ?? zeroclawReadiness)();
    if ("reason" in ready) return { error: ready.reason, status: 503 };
    home ??= ready.home;
    const fetched = await fetchLoopSources(sourced, allowed.agentId, allowed.deployed, {
      ...hooks,
      zeroclawHome: home,
    });
    if ("error" in fetched) return fetched;
    resolvedSandbox = fetched;
  }
  const withFetched = resolvedSandbox ? { ...body, resolvedSandbox } : body;

  // The access key last of all: after every refusal and every chain write a start makes, so a
  // start refused here or before leaves no authorized key on the treasury.
  return withLoopKey(withFetched, allowed, resolvedSandbox, home);
}

/**
 * `planLoopStart` on what `prepareLoopStart` handed back, with the fetch discarded when the plan
 * is refused or throws — the step all three start routes take after the prepare, in one place so none of them
 * can forget that a start that is not going to run has files in `LATH_ZEROCLAW_HOME` nothing else will remove.
 * Only the plan: once `startLoop` has the record, the directory is the loop's.
 */
export function planPreparedStart(
  prepared: LoopStartBody,
  wallet: string,
  home?: string
): ReturnType<typeof planLoopStart> {
  const fetched = prepared.resolvedSandbox;
  // And the key the prepare authorized, which nothing will pay through once the plan is refused.
  const key = prepared.resolvedTempoKey;
  let planned: ReturnType<typeof planLoopStart>;
  try {
    planned = planLoopStart(prepared, wallet);
  } catch (e) {
    if (fetched) discardFetchedSources(fetched.loopId, home);
    if (key) abandonLoopKey(key);
    throw e;
  }
  if ("error" in planned) {
    if (fetched) discardFetchedSources(fetched.loopId, home);
    if (key) abandonLoopKey(key);
  }
  return planned;
}

/** What a start resolves to once nothing about it can be refused: `checkLoopStart`'s answer. */
export interface CheckedLoopStart {
  /** The terms the run is built from — the body itself, or the stored config on a plain *Run again*. */
  start: LoopStartBody;
  checked: LoopRequest;
  deployed: DeployedAgent;
  /** Hex id of the agent the loop runs, lowercased. */
  agentId: string;
  /** The template version a plain *Run again* links to, and writes nothing for. */
  fromTemplate: TemplateLink | null;
  /** The template a start carrying its own terms appends a version to (*run again with edits*). */
  appendTo: Template | null;
  /** The receipt's pointer the body asked for, checked (`checkReceipt`); absent when it asked for none. */
  receipt?: LoopReceiptPointer;
}

/**
 * May this wallet start this run? Every refusal a start can earn without a chain write, in the
 * order `planLoopStart` has always given them — or what the run is built from.
 *
 * Pure, and that is what it is for: it writes no template and registers nothing, so
 * `POST /api/loops` can ask it before the hourly counter and `prepareLoopStart` before a team's
 * copies exist. `planLoopStart` is this plus the roster, the template writes and the record, so
 * the three cannot disagree about what a start is refused for.
 *
 * The one refusal it does not make is *this team's members are registered before the run starts*:
 * that asks whether the caller ran `prepareLoopStart`, which is exactly what this is asked before.
 */
export function checkLoopStart(
  body: LoopStartBody,
  wallet: string
): CheckedLoopStart | (Refusal & { running?: LoopRecord }) {
  let start: LoopStartBody = body;
  let fromTemplate: TemplateLink | null = null;
  // The template this start appends a version to, when it named one *and* carried its own terms.
  // That is *run again with edits*: the body is the
  // configuration, so none of the stored config is read, and what the template gets is the next
  // version rather than a fresh id beside it. A `templateId` alone still re-runs the stored
  // version and writes nothing, which is what *Run again* has always done.
  let appendTo: Template | null = null;
  const editing =
    body.prompt !== undefined ||
    body.intervalMs !== undefined ||
    body.maxSteps !== undefined ||
    body.budgetMicroUsdc !== undefined ||
    body.budgetMicroUsdcPerStep !== undefined ||
    // A goal is one of the run's terms, so *Run again* with a new one appends a version rather
    // than re-running the stored config under a goal the template never recorded.
    body.goal !== undefined ||
    // A team is a term too, and the one whose absence has to mean something: a body that named
    // its own terms and no team describes a run with no team, not one that quietly inherits the
    // stored version's roster.
    body.workers !== undefined ||
    // And the gate, which is policy the way the judge and the goal are.
    body.gate !== undefined ||
    // And the sandbox, whose switches and sources reach every step's posture.
    sandboxOf(body) !== undefined ||
    // And the model, the judge, Jev's goal check and the trace audit: each is a term a version stores
    // (the stored path below copies all four), so a body that names one is describing its own run.
    // Left out, a signed `{ templateId, model }` would run the stored model under a signature that
    // named another one. Such a body has to carry the rest of its terms, as every other edit does.
    body.model !== undefined ||
    body.verify !== undefined ||
    body.goalCheck !== undefined ||
    body.traceAudit !== undefined;
  if (body.templateId && body.fork && !editing) {
    return { error: "fork needs the terms to fork into: post the long body with it", status: 400 };
  }
  if (body.templateId) {
    const version = body.version === undefined ? undefined : Math.round(Number(body.version));
    if (version !== undefined && (!Number.isFinite(version) || version < 1)) {
      return { error: "version must be a positive integer", status: 400 };
    }
    if (editing) {
      // Ownership before anything else, and the same refusal the stored-template path gives: a
      // template belongs to the wallet that wrote it, and another wallet's asset reaches a start
      // through an offer, never by having its id typed.
      const target = templateForAppend(wallet, String(body.templateId), version, "loop");
      if ("error" in target) return target;
      appendTo = target.template;
      // The coordinator is the body's `agentId`, not the stored one, and the conflict refusal
      // below does not apply: a start that carries its own terms is describing the run it wants,
      // and the version it appends records that agent as the coordinator. A deploy's loop cannot
      // reach this — `POST /api/agents` refuses a `loop.templateId` outright — so the ticket path
      // still cannot be pointed at some other wallet's schedule.
      start = body;
    } else {
      const resolved = loopStartTemplate(lookupTemplate(String(body.templateId), version), wallet);
      if ("error" in resolved) return resolved;
      // A template names the agent it coordinates, so a caller that names one too is describing two
      // different runs. Taking the template's silently would override `confirmDeploy`, which forces
      // `agentId` to the agent it has just registered: a deploy carrying `loop.templateId` would start
      // a billed schedule on the template's *existing* coordinator and leave the agent the wallet had
      // just paid for with no loop and no message. It would also undo the deploy's standing
      // permission — the transaction the wallet signed is that permission only if the loop spends
      // against the `approve_agent` inside it.
      const asked = String(body.agentId ?? "").toLowerCase();
      if (asked && asked !== resolved.agentId) {
        return {
          error: `this template coordinates another agent; start it without a templateId to run ${asked.slice(0, 8)}…`,
          status: 409,
        };
      }
      const config = resolved.template.config;
      start = {
        agentId: resolved.agentId,
        prompt: config.prompt,
        intervalMs: config.intervalMs,
        maxSteps: config.maxSteps,
        // The whole budget when the version names one; an older version names only
        // the per-step figure, and `checkLoopRequest` derives the budget from it and its team.
        ...(config.budgetMicroUsdc !== undefined ? { budgetMicroUsdc: config.budgetMicroUsdc } : {}),
        budgetMicroUsdcPerStep: config.budgetMicroUsdcPerStep,
        model: config.model,
        // The trigger is the caller's, not the template's: a loop template stores the terms a run
        // is metered by, and nothing in it names the oracle. So *Run again* on a request loop
        // starts a scheduled run unless the caller asks for the trigger again.
        trigger: body.trigger,
        // The gate is a term, like the judge, so a version stored with one carries it
        // here — and `checkLoopRequest` refuses it (gated loops are not in this build) rather than a
        // *Run again* quietly starting the version without the gate it was stored with.
        gate: config.gate,
        // The judge, unlike the trigger, *is* part of the terms a version stores, so a clone or
        // a *Run again* runs under the same judge and the same bar — and a template without one
        // starts a run without one, because `config.verify` is then absent rather than false.
        verify: config.verify,
        // The team is a term the same way, carried so a version stored with one is refused by
        // `checkLoopRequest` with the build's sentence rather than re-run without it.
        workers: config.workers,
        // The goal is a term the same way: a template stored with one starts a run with it, and
        // one stored without leaves `goal` absent, which `checkLoopRequest` reads as *no goal*.
        goal: config.goal,
        // Jev's goal check is a term of the version the way the judge is: stored resolved, and
        // re-resolved against the version's own judge by `checkGoalCheck`.
        goalCheck: config.goalCheck,
        // The trace audit, carried so `checkLoopRequest` refuses a version that stores one rather than
        // starting it without the term (`asksForTraceAudit`).
        traceAudit: config.traceAudit,
        // The sandbox is a term too: *Run again* opens the same sandboxes and
        // fetches the same inputs afresh — a new loop, so a new fetch, pinned again at its start.
        sandbox: config.sandbox,
      };
      fromTemplate = templateLink(resolved.template);
    }
  }

  // A loop runs a deployed agent, and only for the wallet that deployed it — the same rule
  // `/api/run` applies to a session, for the same reason: the chain is the owner's history.
  const agentId = String(start.agentId ?? "").toLowerCase();
  const resolvedAgent = loopStartAgent(/^[0-9a-f]{64}$/.test(agentId) ? lookupAgent(agentId) : null, wallet);
  if ("error" in resolvedAgent) return resolvedAgent;
  const deployed = resolvedAgent.agent;

  // The grants are checked on their own, off the signed `body` — a template stores none, so a plain
  // *Run again* has only what the form sent — and taken off what `checkLoopRequest` reads. Both refuse
  // any, since protocol-plugin grants are not in this build (`grantsRefusal`); this one in the start's
  // words, with the status a start's refusal carries.
  const { grants: _grants, receipt: _receipt, ...terms } = start;
  const checkedRequest = checkLoopRequest(terms, deployed.policy?.model, wallet);
  if ("error" in checkedRequest) return { error: checkedRequest.error, status: 400 };
  const noGrants = checkGrants(body);
  if (noGrants) return noGrants;
  const receipted = checkReceipt(body);
  if ("error" in receipted) return receipted;

  // Every step runs in a sandbox, and a sandbox holds the chain reads and the store and nothing
  // else: a policy naming a web tool or the older `lattice.verify_chain` alias is refused here, naming
  // the tool, rather than at its first step.
  const toolRefusal =
    sandboxToolRefusal(deployed.policy?.tools, deployed.name) ??
    // The sandbox's store switch, held to the agent's deployed policy: it narrows, never widens.
    storeSwitchRefusal(checkedRequest.sandbox?.tools, deployed.policy?.tools, deployed.name) ??
    null;
  if (toolRefusal) return { error: toolRefusal, status: 400 };
  const checked = withoutDeployedStore(checkedRequest, deployed);
  // A receipt is published only on Jev's `achieved`: a loop with no goal check can
  // never earn one, so a start asking for both is refused rather than signed for a receipt that cannot come.
  if (receipted.receipt && !checked.goalCheck) {
    return {
      error: "receipt: a receipt is published when Jev's goal check says achieved; give the loop a goal and the check",
      status: 400,
    };
  }

  const busy = loopRunRefusal(agentId, deployed.name, wallet);
  if (busy) return busy;
  const owing = owingRunOf(agentId);
  if (owing) return { error: owingRunRefusal(deployed.name), status: 409 };

  return {
    start,
    checked,
    deployed,
    agentId,
    fromTemplate,
    appendTo,
    ...(receipted.receipt ? { receipt: receipted.receipt } : {}),
  };
}

/**
 * A stopped run of `agentId` that still owes this chain a write Retry makes — the checkpoint of
 * the step its failed writes interrupted, or its `loop.settlement` record — or `undefined`.
 * A start beside one writes onto a chain whose next seqs are spoken for: its sources' locator cell
 * is a direct write, outside the anchor queue, and the journal's entries carry precomputed heads, so
 * the cell at their seq would make the old run's Retry fail _head diverged_ and the new run's first
 * step, which drains that journal, stop `anchor-failed` too — both ending in Discard, whose records
 * and charges the treasury had already paid OpenRouter for. A run stopped `anchor-failed` that owes no
 * plan (a Retry left it waiting for room to resume) owes the chain nothing and is not one.
 */
function owingRunOf(agentId: string): LoopRecord | undefined {
  return Object.values(readLoops()).find(
    (l) =>
      l.agentId === agentId &&
      l.status !== "running" &&
      (!!l.snapshot.tempo?.recordOwed ||
        (l.stopReason === "anchor-failed" && l.history.some((h) => h.deferredCheckpoint)))
  );
}

function owingRunRefusal(agentName: string): string {
  return (
    `${agentName}'s last run still owes this agent's chain writes that did not land; Retry or Discard it first, ` +
    "since a new run would write at the seqs those records were built for"
  );
}

/**
 * Why one more loop of `agentId` may not be running for `wallet` now, or `null`: the start's rules
 * on the agent and the wallet, in one place, because a Resume and a Retry that puts a run back on
 * its schedule set a loop running as surely as a start does. Checking only the run's own status,
 * steps and budget would let a wallet start three loops, pause one, start a fourth, resume, and
 * repeat — one process-wide run slot held for N loops, one escrow counted N times in the channels
 * committed against the treasury — and a paused loop with no channel would let a second loop start
 * on its agent and then resume beside it: two schedulers on one chain.
 *
 * `except` is the run being resumed, which is not "another" loop on its agent nor one more for the
 * wallet.
 *
 * An Improve still working on the agent (on the roadmap) holds nothing here: nothing in this build
 * moves an Improve on, so a row left mid-Improve would otherwise hold its agent for good.
 */
export function loopRunRefusal(
  agentId: string,
  agentName: string,
  wallet: string,
  opts: { except?: string } = {}
): (Refusal & { running?: LoopRecord }) | null {
  const resuming = opts.except !== undefined;
  const loops = Object.values(readLoops());
  const others = loops.filter((l) => l.id !== opts.except);
  // One running loop per agent: two schedulers on one chain would race for the seq each
  // checkpoint leaf commits to, which is exactly what the leaf exists to make checkable.
  const existing = others.find((l) => l.agentId === agentId && l.status === "running");
  if (existing) {
    return {
      error: resuming
        ? `${agentName} already has another loop running; stop it before resuming this one`
        : `${agentName} already has a loop running`,
      status: 409,
      running: existing,
    };
  }
  // Nor beside a run that has stopped but not yet settled. Its `loop.settlement` record is still to
  // be written on this same chain — a Stop fires the settle and answers the click at once — and a new
  // run's first step would journal against the seq that record is about to take: the new run would
  // then stop `anchor-failed` with a journal only Discard could clear. A channel still on a row is that
  // settle's work not yet done, or one that could not be done now and waits for the next restart; a paused run
  // holds its channel until it goes idle. A resumed run's own channel is the one it carries on with, so only
  // the others count.
  const unsettled = others.find((l) => l.agentId === agentId && (loopSettling(l.id) || !!l.channel));
  if (unsettled) {
    return {
      error:
        unsettled.status === "paused"
          ? `${agentName} has ${resuming ? "another" : "a"} paused loop holding a Tempo channel; stop it first, then ${
              resuming ? "resume this one" : "start again"
            }`
          : `${agentName}'s last loop is still settling its Tempo channel, whose record goes on this ` +
            "agent's chain; try again in a minute (a channel that cannot be settled now is settled when " +
            "this console restarts)",
      status: 409,
    };
  }
  if (others.filter((l) => l.owner === wallet && l.status === "running").length >= LOOPS_PER_WALLET) {
    return { error: `this wallet already has ${LOOPS_PER_WALLET} loops running; stop one first`, status: 429 };
  }
  return null;
}

/**
 * The checked request with a store switch that says only what the agent was deployed with taken
 * out, so it hashes as a start that never touched the switch. The form sends the switch whenever
 * the box is set, and a box ticked and unticked again — or ticked on an agent deployed with the
 * store — describes today's sandbox: kept, it would mint a second template lineage for the same
 * posture, and *Run again* would no longer find the run it repeats.
 *
 * A team's members once kept the switch where it still narrowed one of them; this build starts no
 * team (`checkWorkersRequest`), so the agent's own deployed policy is the only thing it is held to.
 */
function withoutDeployedStore(checked: LoopRequest, deployed: DeployedAgent): LoopRequest {
  const store = checked.sandbox?.tools?.store;
  if (store === undefined) return checked;
  // `sandboxToolNames` cannot throw here: `checkLoopStart` has already asked `sandboxToolRefusal`.
  const deployedStore = sandboxToolNames(deployed.policy?.tools, deployed.name).some((n) =>
    STORE_TOOL_NAMES.includes(n)
  );
  if (store !== deployedStore) return checked;
  const { store: _same, ...tools } = checked.sandbox!.tools!;
  const { tools: _old, ...rest } = checked.sandbox!;
  const sandbox: SandboxConfig = { ...rest, ...(Object.keys(tools).length ? { tools } : {}) };
  const { sandbox: _sandbox, ...request } = checked;
  return Object.keys(sandbox).length ? { ...request, sandbox } : request;
}

/**
 * The run a start would produce, or why there is none — every refusal `POST /api/loops` can
 * answer with, in one place.
 *
 * Here rather than in the route because a deploy can carry a loop: asking the wallet for a
 * **second** signature after a completed deploy would make the one thing the wizard claims — one
 * prompt — true of a deploy and false of the thing the wizard actually offers. The deploy's
 * transaction is a stronger authorisation than the message a second prompt would collect, and
 * `confirmDeploy` has it, so the loop starts from there and the rules are reachable from both.
 *
 * A start is either the long body or a template id. The template path rebuilds the same body from
 * the stored config and puts it through the same checks: a stored config is not more trusted than
 * a typed one, and the limits (interval floor, step ceiling, loop budget bound) may have moved since
 * the template was written.
 *
 * `config.members` is not read here, and a template carrying `workers` is refused by
 * `checkLoopRequest`: this build starts one agent and no team.
 *
 * It is `checkLoopStart` — every refusal, in the order they have always been given — plus the
 * template writes and the record.
 *
 * The record is returned, not scheduled: `startLoop` is the caller's, so a plan can be checked
 * without putting a step on the clock. The one refusal that carries a record is *already has a
 * loop running*, because the useful thing to show there is the run that is in the way.
 */
export function planLoopStart(
  body: LoopStartBody,
  wallet: string
): { loop: LoopRecord } | (Refusal & { running?: LoopRecord }) {
  const allowed = checkLoopStart(body, wallet);
  if ("error" in allowed) return allowed;
  const { checked, deployed, agentId, fromTemplate, appendTo } = allowed;

  // The sources, fetched by `prepareLoopStart` and handed in because the fetch is async. A start
  // with sources that reached here without them skipped the fetch, and is refused by name:
  // starting anyway would open sandboxes with none of what the owner asked them to read.
  const fetched = checked.sandbox?.sources?.length ? body.resolvedSandbox : undefined;
  if (checked.sandbox?.sources?.length && !fetched) {
    return { error: "this loop's sources are fetched before the run starts, and these were not", status: 409 };
  }

  // The ad-hoc start gets an implicit template, so every run points at one. Reuse is by config
  // hash: starting the same loop again links both runs to one template. `coordinator` is the agent
  // the loop runs; `members` is empty, since teams are on the roadmap.
  // A start that named a template links to that version and writes nothing new: the template is
  // this run's config, and a second row would only be a second lineage for the same bytes.
  // A start that carried both a template and its own terms appends a version to that template
  // instead — same id, same name, one lineage — and links
  // the run to it. Written here, after every refusal above, so a start that is turned away
  // leaves no version behind.
  const config: LoopTemplateConfig = {
    prompt: checked.prompt,
    intervalMs: checked.intervalMs,
    maxSteps: checked.maxSteps,
    // The whole budget, and beside it the derived per-step figure every older reader requires. A
    // version that names only the per-step figure is different bytes, so a start with the whole
    // budget mints its own implicit template rather than reusing such a version.
    budgetMicroUsdc: checked.budgetMicroUsdc.toString(),
    budgetMicroUsdcPerStep: checked.budgetMicroUsdcPerStep.toString(),
    model: checked.model,
    coordinator: { agentId },
    members: [],
    // Absent when the start asked for no judge: `templateHash` drops `undefined`, so a loop
    // without verify reuses the template every earlier ad-hoc start of the same terms minted.
    ...(checked.verify ? { verify: checked.verify } : {}),
    // Normalised to absent before hashing, for the same reason and by `checkGoal`: a start that
    // sent `goal: "   "` and one that sent nothing describe the same loop and must reuse the one
    // implicit template, not mint a second lineage for the same bytes.
    ...(checked.goal ? { goal: checked.goal } : {}),
    // Absent when off, by the same rule: a goal loop started without the check reuses the
    // implicit template every earlier start of the same terms minted.
    ...(checked.goalCheck ? { goalCheck: checked.goalCheck } : {}),
    // The sandbox as the start named it — the inputs, never what they resolved to — so a *Run again*
    // fetches afresh and pins again. Absent when the start named none, by the same rule, so a loop
    // template that names no sandbox keeps its hash.
    ...(checked.sandbox ? { sandbox: checked.sandbox } : {}),
  };
  let template: TemplateLink | undefined;
  if (fromTemplate) {
    template = fromTemplate;
  } else if (appendTo) {
    const appended = appendOrMint(wallet, appendTo.id, appendTo.version, config, {
      kind: "loop",
      // A fork is a new lineage and takes this run's agent for its name; an append keeps the
      // template's own, which `appendOrMint` takes from its first version.
      name: body.fork === true ? `${deployed.name}-loop` : appendTo.name,
      fork: body.fork === true,
    });
    // Unreachable: `templateForAppend` above answered the same three questions against the same
    // registry. Answered rather than cast, because a refusal read as a plan is how a run ends up
    // pointing at a template it was refused.
    if ("error" in appended) return appended;
    template = templateLink(appended.template);
  } else {
    template = templateLink(implicitTemplate({ kind: "loop", owner: wallet, name: `${deployed.name}-loop`, config }));
  }

  const now = Date.now();
  const loop: LoopRecord = {
    // The id the fetch was made under when there was one: the fetched directory is named by it.
    // Else the one the access key was authorized under, whose file is named by it (the two are one
    // id when both exist: `withLoopKey` takes the fetch's).
    id: fetched?.loopId ?? body.resolvedTempoKey?.loopId ?? mintLoopId(agentId, now),
    agentId,
    agentName: deployed.name,
    owner: wallet,
    prompt: checked.prompt,
    promptHash: promptHashOf(checked.prompt),
    intervalMs: checked.intervalMs,
    maxSteps: checked.maxSteps,
    budgetMicroUsdc: checked.budgetMicroUsdc.toString(),
    // Derived, and written because an older reader's `isLoopRecord` requires it.
    budgetMicroUsdcPerStep: checked.budgetMicroUsdcPerStep.toString(),
    // Frozen here, at the rate set now: a later change of `LATH_JEV_BUDGET_PERCENT` does not
    // retro-apply to a loop already running.
    jevBudgetBase: jevBudgetOf(checked.budgetMicroUsdc).toString(),
    jevSpentBase: "0",
    model: checked.model,
    // Frozen here like the Jev rate: every step commits it, so it cannot follow the setting mid-run.
    ...(fallbackModelFor(checked.model) ? { fallbackModel: fallbackModelFor(checked.model) } : {}),
    createdAt: now,
    // Recorded at the start, so a row says how its blobs were written whatever build reads it later.
    plainTraces: true as const,
    trigger: checked.trigger,
    ...(checked.verify ? { verify: checked.verify } : {}),
    // Both keys or neither: `goalHash` is what the chain carries and `goal` is what the console
    // shows its owner, and a record with one and not the other would say the run committed to
    // something nobody can read back, or the reverse.
    ...(checked.goal ? { goal: checked.goal, goalHash: goalHashOf(checked.goal) } : {}),
    ...(checked.goalCheck ? { goalCheck: checked.goalCheck } : {}),
    // The sandbox, on a loop started with one; `sourcesHash` is what every step reads the manifest
    // back by (`loopSources`) and what every step's posture commits. Absent otherwise, so a loop
    // without a sandbox config carries no `sandbox` key at all.
    // Where the sources are on Irys goes beside the hash when they are there, and nowhere else:
    // it is hashed into nothing, and a loop whose console published nothing keeps the row it had.
    ...(checked.sandbox
      ? {
          sandbox: {
            config: checked.sandbox,
            ...(fetched ? { sourcesHash: fetched.sourcesHash } : {}),
            ...(fetched?.irys ? { irys: fetched.irys } : {}),
          },
        }
      : {}),
    ...(template ? { template } : {}),
    // The access key the prepare authorized, on a loop started with the switch on; the source of
    // every step's policy `tempoKey`. Absent otherwise, so a loop without one carries no such key.
    ...(body.resolvedTempoKey ? { tempoKey: body.resolvedTempoKey } : {}),
    // The receipt's pointer, on a start that asked for one; the source of every step's policy
    // `receipt`. Absent otherwise, so every other loop carries no such key.
    ...(allowed.receipt ? { receipt: allowed.receipt } : {}),
    status: "running",
    snapshot: {
      loopId: "",
      steps: 0,
      status: "idle",
      totalCostMicroUsdc: "0",
      spentMicroUsdc: "0",
      consecutiveFailures: 0,
    } as LoopSnapshot,
    history: [],
  };
  loop.snapshot.loopId = loop.id;
  return { loop };
}

export interface LoopRequest {
  agentId: string;
  prompt: string;
  intervalMs: number;
  maxSteps: number;
  /** The loop's one overall budget, micro-USDC, clamped to `LOOP_BUDGET_MAX_MICRO`. */
  budgetMicroUsdc: bigint;
  /** `budgetMicroUsdc / maxSteps`, floored: the compatibility figure every writer still emits. */
  budgetMicroUsdcPerStep: bigint;
  model: string;
  /** Always set, so every new row has one: `{ kind: "schedule" }`, the one trigger this build starts. */
  trigger: ConsoleLoopTrigger;
  /** The resolved judge, or `undefined` when the start asked for none — never `false`. */
  verify?: VerifyTerms;
  /** The trimmed goal, or `undefined` when the start named none — never an empty string. */
  goal?: string;
  /** Jev's goal check, resolved; `undefined` when off or when there is no goal — never `false`. */
  goalCheck?: VerifyTerms;
  /** The normalised sandbox config (`checkSandboxConfig`), or `undefined` when it is the host's default. */
  sandbox?: SandboxConfig;
}

/**
 * The trigger a body asked for, or a sentence saying why it is not one.
 *
 * Absent is `{ kind: "schedule" }` rather than a refusal, because that is what a caller that names
 * no trigger means. Only `schedule` is a trigger this
 * build starts: `checkLoopRequest` refuses a `request`, `feed` or `gate` one before this is asked
 * (`removedFeatureOf`), with the sentence that says the feature is not in this build, so what
 * reaches here naming one of them is a kind this build does not start either.
 */
export function checkLoopTrigger(v: unknown): ConsoleLoopTrigger | { error: string } {
  if (v === undefined || v === null) return { kind: "schedule" };
  if (typeof v !== "object") return { error: "trigger must be an object naming a kind" };
  const kind = (v as Record<string, unknown>).kind;
  if (kind === "schedule" || kind === undefined) return { kind: "schedule" };
  return { error: `trigger.kind must be schedule, not ${JSON.stringify(kind)}` };
}

/**
 * The loop budget a start asks for, micro-USDC, or a sentence saying why it is not one.
 *
 * - `budgetMicroUsdc`, a whole number, is the budget.
 * - Without it, an older body — an old client, a template version, a listing's terms — names
 *   `budgetMicroUsdcPerStep`, and the budget is what those terms bounded the run to:
 *   `budgetFromPerStep`, the step budget times the steps, with the team's per-task share.
 * - With neither, the default a body with no budget gets — a session cap a step — over its steps.
 *
 * Clamped to `LOOP_BUDGET_MAX_MICRO`, as a per-step budget over the session cap is: a start
 * is the run it asked for, bounded. Refused below one micro-USDC a step, because the per-step
 * figure every writer still emits (`floor(budget / maxSteps)`) must stay a positive number for the
 * readers that require it.
 */
export function checkLoopBudget(body: any, maxSteps: number): { budget: bigint } | { error: string } {
  const whole = (v: unknown, field: string): bigint | { error: string } => {
    const raw = typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v).trim() : "";
    if (!/^\d+$/.test(raw)) return { error: `${field} must be a whole number of micro-USDC` };
    const n = BigInt(raw);
    return n > 0n ? n : { error: `${field} must be positive` };
  };
  let budget: bigint;
  if (body?.budgetMicroUsdc !== undefined && body?.budgetMicroUsdc !== null) {
    const asked = whole(body.budgetMicroUsdc, "budgetMicroUsdc");
    if (typeof asked !== "bigint") return asked;
    budget = asked;
  } else if (body?.budgetMicroUsdcPerStep !== undefined && body?.budgetMicroUsdcPerStep !== null) {
    const perStep = whole(body.budgetMicroUsdcPerStep, "budgetMicroUsdcPerStep");
    if (typeof perStep !== "bigint") return perStep;
    budget = budgetFromPerStep(perStep, maxSteps, body?.workers ?? undefined);
  } else {
    budget = SESSION_CAP_MICRO * BigInt(maxSteps);
  }
  if (budget > LOOP_BUDGET_MAX_MICRO) budget = LOOP_BUDGET_MAX_MICRO;
  if (budget < BigInt(maxSteps)) {
    return { error: `a loop budget must be at least one micro-USDC per step (${maxSteps} for ${maxSteps} steps)` };
  }
  return { budget };
}

/**
 * Returns the checked request, or a sentence saying why it is refused.
 *
 * `_wallet` is read by nothing in this build: it is for teams (on the roadmap), to tell whether a
 * picked member is the caller's own agent. Kept in its place so callers that pass it are unchanged.
 */
export function checkLoopRequest(body: any, deployedModel?: string, _wallet?: string): LoopRequest | { error: string } {
  const agentId = String(body?.agentId ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(agentId)) return { error: "agentId must be 32 hex bytes" };

  // Protocol-plugin grants are not in this build (`grantsRefusal`), on any path: this check is also the
  // deploy's (`POST /api/agents` at prepare) and *Run again*'s, so a body carrying grants there is refused
  // here, before anything is signed. A start from the loop's page is refused the same way by `checkGrants`.
  const noGrants = grantsRefusal(body, "start");
  if (noGrants) return { error: noGrants };
  // A receipt the same way: it rides only on a start from the loop's page.
  if (body?.receipt !== undefined) {
    return {
      error:
        "a receipt is not supported on a deploy or a listing: deploy the agent, then start the loop from its page " +
        "with SAS · receipt",
    };
  }
  // The trace audit (`asksForTraceAudit`), a team (`checkWorkersRequest`), and gated and oracle-woken
  // loops (`_lib/roadmap.ts`): none is in this build. Here, before anything else is read, because this is
  // every start's check — a loop's own page, a deploy and *Run again* of a stored version — and a version
  // that carries one of them is refused with the same sentence as a typed body. Refused, never dropped: a
  // start's signature binds its terms. A body naming a `gate` and no trigger is a gated start too.
  if (asksForTraceAudit(body)) return { error: TRACE_AUDIT_START_REFUSAL };
  const team = checkWorkersRequest(body?.workers);
  if (team) return team;
  const roadmap = roadmapStartRefusal(body);
  if (roadmap) return { error: roadmap };

  const askedGoal = checkGoal(body?.goal);
  if ("error" in askedGoal) return { error: askedGoal.error };
  const goal = askedGoal.goal;

  // A start that names a goal and no standing instruction gets the default one **here**, before
  // the floor below and before `promptHashOf`: the hash every step's manifest commits to has to
  // name the instruction this server ran, not whatever the form happened to show. A start that
  // names both keeps its own.
  const typed = String(body?.prompt ?? "").trim();
  const prompt = typed || (goal ? DEFAULT_GOAL_PROMPT : "");
  // 10 is also the wizard's floor (`LOOP_PROMPT_MIN` in `CreatorWizard.tsx`); the two are kept
  // equal so the console never offers a deploy the API would refuse, or refuse one it offered.
  if (prompt.length < 10) return { error: "a loop needs a standing instruction of at least 10 characters" };
  if (prompt.length > 2000) return { error: "the standing instruction is too long (2000 characters)" };

  const trigger = checkLoopTrigger(body?.trigger);
  if ("error" in trigger) return { error: trigger.error };

  const intervalMs = Math.round(Number(body?.intervalMs));
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    return { error: `intervalMs must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}` };
  }

  const maxSteps = Math.round(Number(body?.maxSteps));
  if (!Number.isFinite(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS) {
    return { error: `maxSteps must be between 1 and ${MAX_STEPS}` };
  }

  const budgeted = checkLoopBudget(body, maxSteps);
  if ("error" in budgeted) return budgeted;
  const budget = budgeted.budget;

  const asked = typeof body?.model === "string" ? body.model : undefined;
  const model =
    asked && MODELS.has(asked)
      ? asked
      : deployedModel && MODELS.has(deployedModel)
      ? deployedModel
      : "deepseek/deepseek-v4.1-flash";

  const judge = checkVerify(body?.verify);
  if (judge !== undefined && "error" in judge) return { error: (judge as { error: string }).error };
  const verify = judge as VerifyTerms | undefined;
  const goalChecked = checkGoalCheck(body?.goalCheck, goal, verify);
  if (goalChecked !== undefined && "error" in goalChecked) return { error: (goalChecked as { error: string }).error };
  const goalCheck = goalChecked as VerifyTerms | undefined;

  const sandboxAsked = checkSandboxConfig(sandboxOf(body));
  if ("error" in sandboxAsked) return { error: sandboxAsked.error };
  const sandbox = sandboxAsked.sandbox;

  return {
    agentId,
    prompt,
    intervalMs,
    maxSteps,
    budgetMicroUsdc: budget,
    budgetMicroUsdcPerStep: budget / BigInt(maxSteps),
    model,
    trigger,
    // Spread rather than `verify: undefined`, so the absent case leaves no key for a caller to
    // copy into a record or a template config (the absent-when-off rule).
    ...(verify ? { verify } : {}),
    ...(goal ? { goal } : {}),
    ...(goalCheck ? { goalCheck } : {}),
    // Absent when the start named none or only the host's defaults (`checkSandboxConfig`).
    ...(sandbox ? { sandbox } : {}),
  };
}
