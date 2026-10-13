/**
 * What a template write is allowed to say.
 *
 * A template is a document, and its `hash` is the content address of exactly the bytes stored
 * (`_lib/templates.ts`). That is why nothing here coerces: `POST /api/agents` may fall back to
 * a default model or slice a tool list to 16, because the record it writes is a run and the run
 * is what actually happens; a template that silently rewrote the config would mint a hash over
 * bytes the owner never wrote, and the lineage key would point at a config nobody chose. So a
 * value outside the bounds is a refusal, not a correction.
 *
 * The bounds themselves are the run's, so that a template cannot describe a run the server
 * would refuse **on its numbers**: `TOOL_NAMES` and the 16-tool cap from `api/agents/route.ts`,
 * the interval, step and loop-budget bounds from `checkLoopRequest` in `_lib/loop-request.ts`, and
 * the model set from `_lib/runner.ts`. Two numbers have no exported constant and are duplicated
 * here with the source named.
 *
 * The one thing a stored template can still say that no start can honour is a `coordinator` that
 * is not `{ agentId }`: `checkAgentRef` still takes all three `AgentRef` shapes because that is the
 * stored shape and `loopStartTemplate` refuses the other two. That is a forward-compatible shape,
 * not a validation gap — but a loop template written with one is stored, listed, and permanently
 * unstartable.
 *
 * `members` is the one place where the forward-compatible shape would be a lie rather than a gap:
 * a template could describe four member slots, the runner has no member phase, and a blueprint
 * sold as a four-member loop would launch one agent without saying so. So a non-empty `members`
 * is refused. The key itself stays — `templateHash` is `sha256(canonicalJson(config))` and every
 * stored config carries `members: []`, so refusing must not change what is stored — reserved for
 * teams, which are on the roadmap.
 *
 * A key this file neither reads nor returns is a key a `PUT` **silently drops**, which is worse
 * than either storing or refusing it: a `PUT` of a loop template that carried a judge, with `verify`
 * dropped, would store version n+1 without one, and every later *Run again* from it would run
 * unjudged, with no 400 and nothing on screen. `verify` and `goal` are therefore checked here by the
 * same functions the start path uses (`_lib/loops.ts`), so a stored version and a typed start can
 * never disagree about what either means. `workers`, `gate`, `sandbox`, `goalCheck` and `traceAudit`
 * are read for the same reason; `workers`, `gate` and `traceAudit` name roadmap features, so they are
 * read only to be refused, never dropped.
 *
 * No `next/server` is imported, so the checks are exercised by `tests/console-templates-api.ts`
 * as plain functions.
 */
import type { AgentRef, AgentTemplateConfig, LoopTemplateConfig, Template } from "../_lib/templates";
import { MAX_EXPIRATION_DAYS, MIN_BUDGET_CAP_USDC } from "../_lib/templates";
import { MODELS } from "../_lib/runner";
import { roadmapStartRefusal } from "../_lib/roadmap";
import { canonicalJson } from "@lath/runtime";
import {
  LOOP_BUDGET_MAX_MICRO,
  MAX_INTERVAL_MS,
  MAX_STEPS,
  MIN_INTERVAL_MS,
  budgetFromPerStep,
  checkGoal,
  checkSandboxConfig,
  sandboxOf,
  checkGoalCheck,
  TRACE_AUDIT_START_REFUSAL,
  asksForTraceAudit,
  checkVerify,
  checkWorkersRequest,
  grantsRefusal,
} from "../_lib/loops";
import { OFFERED_TOOL_NAMES, TOOL_NAMES } from "../_lib/tools";

/** Either the config to store, or why the request is a 400. */
export type Checked<T> = { config: T } | { error: string };

/** Longest display name a template row is laid out for. */
export const MAX_NAME = 64;
/** The tool cap `api/agents/route.ts` slices a deploy's policy to. */
export const MAX_TOOLS = 16;
/** The prompt cap `api/agents/route.ts` and `checkLoopRequest` both apply. */
export const MAX_PROMPT = 2000;
/**
 * A loop's standing instruction has to say something; `checkLoopRequest`'s floor, which is 10 and
 * is the number that matters — a template stored under a lower one describes a run the server
 * would refuse to start, which is exactly what these bounds exist to prevent.
 */
export const MIN_LOOP_PROMPT = 10;
/** Re-exported: declared in `_lib/templates.ts`, the leaf, which `_lib/copy.ts` also reads it from. */
export { MIN_BUDGET_CAP_USDC };
/**
 * A hundred-year grant, the wizard's *Indefinite* (`CreatorWizard.tsx`, `INDEFINITE_DAYS`).
 * Duplicated rather than imported: that module is a React component.
 */
/** Re-exported: it is declared in `_lib/templates.ts`, the leaf, so a caller under
 * `validate.ts`'s own imports can reach it without joining their cycle. */
export { MAX_EXPIRATION_DAYS };

/**
 * What an `{ offer }` reference may say: an id, not a document. A listing is named by its agent's
 * 64-hex id, and `template.offer` (on the roadmap) has no id format yet, so this is the store key's
 * alphabet at twice its length rather than either exact shape.
 *
 * Bounded because `checkLoopConfig` stores the coordinator as written: with any non-empty string
 * taken, one signed write of a five-megabyte `offer` would be a five-megabyte `templates.json`, and
 * every anonymous `GET /api/templates`, deploy and loop start reads and parses the whole file. No
 * stored template carries an `{ offer }` ref — `loopStartTemplate` refuses one — so refusing a long
 * one moves no stored hash.
 */
export const OFFER_REF = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The most a stored config may weigh, in characters of the `canonicalJson` its `hash` is taken
 * over. Every free-text field has its own cap — the prompt, the goal, the team's and each slot's
 * prompt at 2 000, a name at 64 — and every one of them at its cap, with eight sources and a gate,
 * is about half of this. But not every field has one: a slot's `tools` may repeat a known name
 * without limit, a source's URL has no length, and a field added later will not have one until
 * someone remembers. This is the bound none of them can be forgotten under: a version
 * is at most this many characters on disk (three times as many bytes, at worst), and
 * `readTemplates` parses every one on every read.
 */
export const MAX_CONFIG_CHARS = 32 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The trimmed display name, or why it is not one. */
export function checkName(v: unknown): { name: string } | { error: string } {
  const name = typeof v === "string" ? v.trim() : "";
  if (!name) return { error: "a template needs a name" };
  if (name.length > MAX_NAME) return { error: `the name is too long (${MAX_NAME} characters)` };
  return { name };
}

/** A decimal USDC amount as the string it was written as; 6 places, the token's precision. */
function checkUsdc(v: unknown, field: string, min: number): { value: string } | { error: string } {
  const raw = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    return { error: `${field} must be a decimal number of USDC with at most 6 places` };
  }
  if (Number.parseFloat(raw) < min) return { error: `${field} must be at least ${min.toFixed(2)} USDC` };
  return { value: raw };
}

/**
 * A JSON number that is a whole number in range. `Number(v)` took `true` as 1 and `"7"`, `" 7 "` or
 * `[7]` as 7, so the stored config — and the `templateHash` over it — said a number the owner never
 * sent; every caller sends a number, so anything else is a refusal, like the rest of this file.
 */
function checkInt(v: unknown, field: string, min: number, max: number): { value: number } | { error: string } {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isInteger(n) || n < min || n > max)
    return { error: `${field} must be an integer between ${min} and ${max}` };
  return { value: n };
}

/** An optional prompt: absent, or trimmed text within the cap. An empty string is absent. */
function checkPrompt(v: unknown): { prompt?: string } | { error: string } {
  if (v === undefined || v === null || v === "") return {};
  if (typeof v !== "string") return { error: "prompt must be text" };
  const prompt = v.trim();
  if (!prompt) return {};
  if (prompt.length > MAX_PROMPT) return { error: `the prompt is too long (${MAX_PROMPT} characters)` };
  return { prompt };
}

/** One of the three `AgentRef` shapes, exactly one. */
export function checkAgentRef(v: unknown, field: string): { ref: AgentRef } | { error: string } {
  if (!isRecord(v)) return { error: `${field} must be an agent reference` };
  const keys = ["agentId", "template", "offer"].filter((k) => v[k] !== undefined);
  if (keys.length !== 1) {
    return { error: `${field} must name exactly one of agentId, template or offer` };
  }
  if (typeof v.agentId === "string") {
    const agentId = v.agentId.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(agentId)) return { error: `${field}.agentId must be 32 hex bytes` };
    return { ref: { agentId } };
  }
  if (typeof v.template === "string") {
    if (!/^tpl-[0-9a-f]{16}$/.test(v.template)) return { error: `${field}.template must be a template id` };
    const ref: { template: string; version?: number } = { template: v.template };
    if (v.version !== undefined) {
      const version = checkInt(v.version, `${field}.version`, 1, Number.MAX_SAFE_INTEGER);
      if ("error" in version) return version;
      ref.version = version.value;
    }
    // `count` expands one template into N *member* slots. With
    // members refused the only ref left is the coordinator, and a loop has exactly one of those.
    // Refused rather than dropped: this file stores what was written or says no, never both.
    if (v.count !== undefined) {
      return { error: `${field}.count cloned a template into member slots, which are not built yet` };
    }
    return { ref };
  }
  if (typeof v.offer === "string" && v.offer.trim()) {
    const offer = v.offer.trim();
    if (!OFFER_REF.test(offer)) {
      return { error: `${field}.offer must be a listing id: up to 128 letters, digits and . _ : -` };
    }
    return { ref: { offer } };
  }
  return { error: `${field} must name exactly one of agentId, template or offer` };
}

/** The config a deployed agent runs under (`AgentTemplate`). */
export function checkAgentConfig(v: unknown): Checked<AgentTemplateConfig> {
  if (!isRecord(v)) return { error: "config must be an object" };

  const prompt = checkPrompt(v.prompt);
  if ("error" in prompt) return prompt;

  const model = typeof v.model === "string" ? v.model : "";
  if (!MODELS.has(model)) return { error: `model must be one of ${[...MODELS].join(", ")}` };

  if (!Array.isArray(v.tools)) return { error: "tools must be an array" };
  if (v.tools.length > MAX_TOOLS) return { error: `at most ${MAX_TOOLS} tools` };
  const tools = v.tools.map(String);
  // A name the runtime does not ship would be dropped at session time, so a template that
  // carried it would describe an agent that cannot have it — the check `api/agents/route.ts`
  // makes for the same reason.
  const unknown = tools.filter((t) => !TOOL_NAMES.includes(t));
  if (unknown.length) {
    return { error: `unknown tools: ${unknown.join(", ")}; the runtime ships ${OFFERED_TOOL_NAMES.join(", ")}` };
  }

  const budget = checkUsdc(v.budgetCapUsdc, "budgetCapUsdc", MIN_BUDGET_CAP_USDC);
  if ("error" in budget) return budget;

  const days = checkInt(v.expirationDays, "expirationDays", 1, MAX_EXPIRATION_DAYS);
  if ("error" in days) return days;

  /**
   * Absent is the default and stays absent, so a config that never names `payment` and one that
   * names the default hash the same.
   *
   * `"vault"` is refused, and only here. This function validates a config on the way *in* — a
   * `POST` or a `PUT` writing a new template or offer version — and this server has no such rail:
   * it holds no provider key, so a config asking for it is asking for something no session can do,
   * and saying so beats storing a field that will be ignored. Records already published that name it
   * keep theirs: they are read back as written, an explicit `"vault"` hashes as absent, and they
   * launch and run like everything else.
   */
  if (v.payment === "vault") {
    return {
      error:
        'payment: "vault" is not offered — inference is paid over MPP from the operator\'s Tempo ' +
        'treasury. Leave `payment` out, or set it to "tempo".',
    };
  }
  const payment = v.payment === "tempo" ? ("tempo" as const) : undefined;
  if (v.payment !== undefined && !payment) return { error: 'payment must be "tempo" when given' };

  return {
    config: {
      ...prompt,
      model,
      tools,
      budgetCapUsdc: budget.value,
      expirationDays: days.value,
      ...(payment ? { payment } : {}),
    },
  };
}

/** The config a loop run is started from (`LoopTemplate`). */
export function checkLoopConfig(v: unknown): Checked<LoopTemplateConfig> {
  if (!isRecord(v)) return { error: "config must be an object" };

  const prompt = typeof v.prompt === "string" ? v.prompt.trim() : "";
  if (prompt.length < MIN_LOOP_PROMPT) {
    return { error: `a loop needs a standing instruction of at least ${MIN_LOOP_PROMPT} characters` };
  }
  if (prompt.length > MAX_PROMPT) return { error: `the standing instruction is too long (${MAX_PROMPT} characters)` };

  const intervalMs = checkInt(v.intervalMs, "intervalMs", MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  if ("error" in intervalMs) return intervalMs;

  const maxSteps = checkInt(v.maxSteps, "maxSteps", 1, MAX_STEPS);
  if ("error" in maxSteps) return maxSteps;

  /**
   * The loop's one budget, or — from an older client that sends only a per-step figure — the
   * per-step budget it is derived from, with the team's per-task share, exactly as a start
   * derives it (`checkLoopBudget`'s rule, `budgetFromPerStep`). Either way the version stores both
   * keys: the budget, and the per-step figure every older reader requires, derived as
   * `floor(budget / maxSteps)`. `checkLoopRequest` clamps an over-large budget because
   * it is starting a run and a clamped run is still the run asked for; a template is bytes with a
   * hash, so a value out of bounds is refused here instead.
   */
  const wholeMicro = (raw: unknown, field: string): bigint | { error: string } => {
    const text = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
    if (!/^\d+$/.test(text)) return { error: `${field} must be an integer number of micro-USDC` };
    const n = BigInt(text);
    return n > 0n ? n : { error: `${field} must be positive` };
  };
  let budget: bigint;
  if (v.budgetMicroUsdc !== undefined && v.budgetMicroUsdc !== null) {
    const asked = wholeMicro(v.budgetMicroUsdc, "budgetMicroUsdc");
    if (typeof asked !== "bigint") return asked;
    budget = asked;
  } else {
    const perStep = wholeMicro(v.budgetMicroUsdcPerStep, "budgetMicroUsdcPerStep");
    if (typeof perStep !== "bigint") return perStep;
    budget = budgetFromPerStep(perStep, maxSteps.value, v.workers ?? undefined);
  }
  if (budget > LOOP_BUDGET_MAX_MICRO) {
    return { error: `the loop budget must not exceed ${LOOP_BUDGET_MAX_MICRO} micro-USDC` };
  }
  if (budget < BigInt(maxSteps.value)) {
    return { error: "the loop budget must be at least one micro-USDC per step" };
  }

  let model: string | undefined;
  if (v.model !== undefined && v.model !== null && v.model !== "") {
    if (typeof v.model !== "string" || !MODELS.has(v.model)) {
      return { error: `model must be one of ${[...MODELS].join(", ")}` };
    }
    model = v.model;
  }

  const coordinator = checkAgentRef(v.coordinator, "coordinator");
  if ("error" in coordinator) return coordinator;

  // Absent and `[]` both store `[]`, which is what every config written before this check already
  // carries, so no stored template's hash moves. Anything *in* the array is refused, because
  // nothing downstream would run it.
  const rawMembers = v.members === undefined ? [] : v.members;
  if (!Array.isArray(rawMembers)) return { error: "members must be an array" };
  if (rawMembers.length > 0) {
    return { error: "Teams are not built yet; a loop runs one agent. Leave `members` empty." };
  }
  const members: LoopTemplateConfig["members"] = [];

  // The trace audit, refused with the start's sentence: it is not in this build
  // (`asksForTraceAudit`), and a version that stores it is one whose *Run again* `checkLoopRequest` refuses.
  if (asksForTraceAudit(v)) return { error: TRACE_AUDIT_START_REFUSAL };
  // A team, refused with the start's sentence (`checkWorkersRequest`): a
  // version that stores one is a version whose *Run again* `checkLoopRequest` refuses, and a template
  // nobody can start is the trap the `members` refusal above closed. `workers` is read rather than
  // dropped, for the reason in the header: a `PUT` that dropped it would store a teamless version silently.
  const team = checkWorkersRequest(v.workers);
  if (team) return team;

  // A gate, refused because gated loops are not in this build, with the start's
  // sentence: a version that stores one is a version whose *Run again* `checkLoopRequest` would refuse,
  // and a template nobody can start is the trap the `members` refusal above closed. A template carries
  // no trigger, so that has nothing to read here.
  const roadmap = roadmapStartRefusal({ gate: v.gate });
  if (roadmap) return { error: roadmap };
  // Nor grants, which this file never stored: a write carrying them is refused with the start's sentence
  // rather than silently dropped (the trap above), because protocol-plugin grants are not in this build
  // (`grantsRefusal`).
  const noGrants = grantsRefusal(v, "start");
  if (noGrants) return { error: noGrants };

  // The judge and the goal are terms of the run, so a version stores them or says why it cannot.
  // Both are checked by the functions the start path uses — `checkVerify` refuses a `~` alias
  // because `policy_version_hash` commits the model, `checkGoal` trims and caps — and both are
  // **absent** when off rather than `false` or `""`, which is what keeps every stored version that
  // names neither at the hash it has.
  const judge = checkVerify(v.verify);
  if (judge !== undefined && "error" in judge) return { error: (judge as { error: string }).error };
  const verify = judge as LoopTemplateConfig["verify"] | undefined;

  const goal = checkGoal(v.goal);
  if ("error" in goal) return goal;

  // Jev's goal check, through the start path's function for the reason in the header:
  // a `PUT` that dropped it would store a version whose *Run again* ends on the agent's claim alone.
  // Resolved against this version's own judge and goal, and absent when off or goal-less.
  const goalChecked = checkGoalCheck(v.goalCheck, goal.goal, verify);
  if (goalChecked !== undefined && "error" in goalChecked) return { error: (goalChecked as { error: string }).error };
  const goalCheck = goalChecked as LoopTemplateConfig["goalCheck"] | undefined;

  /**
   * The sandbox, through `checkSandboxConfig` — the start body's check — so a
   * `PUT` keeps what a run's _Save as template_ stored and a refusal reads the start's sentence.
   * It normalises before hashing: the host's defaults restated drop out, so a version that says
   * nothing a start without `sandbox` would not stores no key and keeps the hash it had. The sources
   * are stored as typed and fetched afresh by every start from the version, so nothing here fetches.
   */
  const sandbox = checkSandboxConfig(sandboxOf(v));
  if ("error" in sandbox) return sandbox;

  return {
    config: {
      prompt,
      intervalMs: intervalMs.value,
      maxSteps: maxSteps.value,
      budgetMicroUsdc: budget.toString(),
      budgetMicroUsdcPerStep: (budget / BigInt(maxSteps.value)).toString(),
      ...(model ? { model } : {}),
      coordinator: coordinator.ref,
      members,
      ...(verify ? { verify } : {}),
      ...(goal.goal ? { goal: goal.goal } : {}),
      ...(goalCheck ? { goalCheck } : {}),
      ...(sandbox.sandbox ? { sandbox: sandbox.sandbox } : {}),
    },
  };
}

/**
 * The config as `MAX_CONFIG_CHARS` measures it: every attached file's content (`text` sources)
 * emptied. A version stores that content — the owner signed it, and a *Run again* from
 * the version must attach the same bytes — but it is already held to its own bound
 * (`TEXT_SOURCE_MAX_BYTES` each, `TEXT_SOURCES_MAX_BYTES` together, by `parseSourceInputs`), and a
 * page of invoices would otherwise spend the cap every other field shares. What is stored is
 * unchanged; only the measure skips what has its own.
 */
function withoutAttachedContent<C extends object>(config: C): C {
  const sandbox = (config as { sandbox?: { sources?: unknown[] } }).sandbox;
  if (!sandbox?.sources?.some((s) => (s as { kind?: unknown })?.kind === "text")) return config;
  const sources = sandbox.sources.map((s) =>
    (s as { kind?: unknown }).kind === "text" ? { ...(s as object), content: "" } : s
  );
  return { ...config, sandbox: { ...sandbox, sources } };
}

/**
 * Dispatch on the kind a `POST` declared or an existing template already has, then hold the result
 * to `MAX_CONFIG_CHARS`. Measured on what would be stored — the checked config, defaults resolved
 * and absent keys dropped, exactly the bytes `templateHash` reads — so a body padded with keys this
 * file drops costs nothing and a config is refused only for what it would have written.
 */
export function checkConfig(
  kind: Template["kind"],
  config: unknown
): Checked<AgentTemplateConfig | LoopTemplateConfig> {
  const checked = kind === "agent" ? checkAgentConfig(config) : checkLoopConfig(config);
  if ("error" in checked) return checked;
  const size = canonicalJson(withoutAttachedContent(checked.config)).length;
  if (size > MAX_CONFIG_CHARS) {
    return { error: `the config is too large to store (${size} characters; ${MAX_CONFIG_CHARS} at most)` };
  }
  return checked;
}

/** Why a write is refused, with the status the route answers. */
export interface Refusal {
  error: string;
  status: number;
}

/**
 * Which template a write to an existing id lands on. A `PUT` and an archive both need the id to
 * exist and to belong to the signer; keeping the decision here rather than in the route is what
 * lets `tests/console-templates-api.ts` cover it without `next/server`.
 */
export function resolveWrite(latest: Template | null, wallet: string): { latest: Template } | Refusal {
  if (!latest) return { error: "no template with that id", status: 404 };
  if (latest.owner !== wallet) return { error: "this template belongs to another wallet", status: 403 };
  return { latest };
}

/** The `clonedFrom` a `POST` may carry: which template version this config was copied from. */
export function checkClonedFrom(v: unknown): { clonedFrom?: { id: string; version: number } } | { error: string } {
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) return { error: "clonedFrom must be { id, version }" };
  if (typeof v.id !== "string" || !/^tpl-[0-9a-f]{16}$/.test(v.id)) {
    return { error: "clonedFrom.id must be a template id" };
  }
  const version = checkInt(v.version, "clonedFrom.version", 1, Number.MAX_SAFE_INTEGER);
  if ("error" in version) return version;
  return { clonedFrom: { id: v.id, version: version.value } };
}
