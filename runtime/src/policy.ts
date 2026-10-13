import {
  Bytes32,
  canonicalJson,
  hex,
  sha256,
  utf8,
  type GateConfig,
  loopReceiptPointerDocument,
  type GrantItem,
  type Grants,
  type LoopReceiptPointer,
  type SquadsGrantItem,
  type TraceAuditConfig,
  type WatchSource,
} from "@lath/sdk";
// Type-only: `posture.ts` imports `canonicalJson` from here, so a value import back would be a cycle.
import type { LathPosture } from "./zeroclaw/posture";

/**
 * Which rail pays the inference provider. `vault` is the operator's OpenRouter key, with the user debited on Solana in
 * the same transaction as the event; `tempo` is the agent paying OpenRouter's MPP gateway per call from its own Tempo
 * wallet, with the user still debited on Solana. The user's side of the ledger is the same on both.
 */
export type PaymentRail = "vault" | "tempo";

/**
 * Clean agent configuration interface.

 * Temperature is intentionally not exposed in primary config (defaults to 0.2 internally).
 */
export interface AgentConfig {
  /** OpenRouter model slug, e.g. `anthropic/claude-3.7-sonnet`. */
  model: string;
  /** Spend ceiling for the session, in micro-USDC (default: 5,000,000 micro-USDC = $5.00). */
  maxCost?: number;
  /** Tool names the agent is allowed to call. */
  tools?: string[];
  /** Alias for tools. */
  toolAllowList?: string[];
  /** Optional internal temperature override (defaults to 0.2). */
  temperature?: number;
  /** `sha256(system prompt)` in hex; see `RuntimePolicy.promptHash`. */
  promptHash?: string;
  /** Which rail pays for inference; see `RuntimePolicy.payment`. */
  payment?: PaymentRail;
}

/**
 * What `policy_version_hash` commits to (SPEC §3, kind 0). Everything here changes the
 * agent's behaviour, so a change must change the hash: an auditor comparing two sessions'
 * genesis records can tell whether they ran under the same rules without holding the trace.
 */
export interface RuntimePolicy {
  /** OpenRouter model slug, e.g. `anthropic/claude-3.7-sonnet`. */
  model: string;
  /** Internal temperature (defaults to 0.2 if not specified). */
  temperature?: number;
  /** Tool names the session may call, in any order — canonicalised by sorting. */
  toolAllowList: string[];
  /** Hard spend ceiling for the session, in micro-USDC. */
  maxCost: number;
  /**
   * `sha256(system prompt)` in hex, when the prompt is a configured one — a template's
   * `config.prompt`. Absent when the caller's system prompt is hardcoded, and `canonicalJson` drops
   * `undefined`, so a session with no configured prompt hashes exactly as it would without the key:
   * the genesis hashes of agents deployed without a template do not move.
   *
   * The hash, not the prompt: the policy document is published to a `PolicyRegistry` cell and
   * the prompt can be any length. The preimage goes to the trace store under the same
   * `sha256`, so an auditor resolves it the way any other payload hash resolves.
   */
  promptHash?: string;
  /**
   * The rail that paid for inference, and **only** when it is `tempo`. An agent on that rail
   * makes a weaker atomicity claim than a vault agent does — the provider is paid before the
   * event is anchored — so it is part of the rules a genesis event commits to rather than a
   * deployment detail.
   *
   * Absent and an explicit `"vault"` are the same policy and must hash identically:
   * `toRuntimePolicy` normalises `"vault"` away before anything sees it, so every genesis hash
   * written without the key stays where it is.
   */
  payment?: PaymentRail;
  /**
   * The second model that judges each step's output before it becomes memory, when the loop asks
   * for one: the pinned model slug and the confidence a verdict must reach to be acted on. Part of
   * the rules a genesis event commits to, not a runtime knob — a change of judge or of threshold
   * changes what the loop will remember.
   *
   * Absent when verify is off, and `canonicalJson` drops `undefined`, so a loop without it hashes
   * its policy exactly as it would without the key and no genesis hash on devnet moves —
   * the same reason `promptHash` and `payment` are optional.
   */
  verify?: VerifyPolicy;
  /**
   * Jev's goal check: after each step of a goal loop, the pinned decision model answers whether
   * the goal is achieved, and an `achieved` at or above `minConfidence` stops
   * the loop in place of the agent's own `GOAL REACHED`. Policy and not a knob, because it changes
   * when the loop ends. On a loop with the verify seat both values are the seat's (one call asks
   * both); without it the bar is the committed default, 0.5.
   *
   * A sibling of `verify` rather than a key inside it: a loop can have the check without the seat,
   * and every reader of `verify` — the runner, the console, the team message — reads its presence
   * as *the seat is on*. Absent when the check is off, and `toRuntimePolicy` spreads it the way it
   * spreads `gate`, so a policy without it has no `goalCheck` key and hashes as it would without it.
   */
  goalCheck?: VerifyPolicy;
  /**
   * The trace audit: after each step, Jev reads the step's trace and says, per behaviour the owner
   * picked, how likely it is present; a `stop` behaviour at its bar that the loop's own model
   * confirms keeps the step out of memory and stops the loop. Policy and not a knob, because it
   * changes what the loop remembers and when it ends.
   *
   * A sibling of `verify` and `goalCheck`, for the reason `goalCheck` is one: every reader of
   * `verify` reads its presence as *the seat is on*. No model for the confirm: it is the audited
   * session's own, which this policy already commits. Absent when off, spread by `toRuntimePolicy`
   * the way `goalCheck` is, so a policy without it hashes as it would without the key.
   *
   * The trace audit is on the roadmap and this build runs none: the key stays so an older policy
   * committed with it hashes as it did, and `LoopRunner.step` takes no step under one.
   */
  traceAudit?: TraceAuditConfig;
  /**
   * The team this agent's steps may hand work to, when it is the orchestrator of a loop that has
   * one: which agents, on which model, under which per-task ceiling. Part of the rules a genesis
   * event commits to rather than a runtime knob — a step's
   * `policy_version_hash` is what names *who was allowed to do its work*, which is the half the
   * manifest's `members` (what they actually did) cannot supply on its own.
   *
   * Absent when the loop has no team, and `canonicalJson` drops `undefined`, so every loop
   * without one hashes its policy exactly as it would without the key — the same reason
   * `promptHash`, `payment` and `verify` are optional.
   */
  workers?: WorkersPolicy;
  /**
   * The gate in front of every step of a gated loop: the pinned decision model, the bar in basis
   * points, the watch list, the fail mode and the heartbeat. Policy and not a runtime knob, because
   * the question is fixed once by the owner: a change of watch list or bar changes when the loop
   * thinks, so it must change the hash every genesis commits, and the auditor reads the bar it
   * recomputes each ask against from here.
   *
   * Absent on every loop that is not gated, and `canonicalJson` drops `undefined`, so no other
   * policy hash moves — the same reason `verify` and `workers` are optional.
   */
  gate?: GateConfig;
  /**
   * The jail every step of a sandboxed loop runs in: the host-generated ZeroClaw posture — its risk and runtime
   * profile, the workspace cap, the environment, the `sandbox-exec` or `bwrap` template, the binary's `sha256` and the
   * patch set — from `lathPosture`. Policy and not a deployment detail: an operator who loosened the jail between two
   * steps of one loop would otherwise leave no record of it, and `max_tool_iterations` (the runtime's `maxSteps`) is
   * committed nowhere else. It holds no token, path or instant, so every step under one policy commits the same bytes.
   *
   * Absent on every session that is not a sandboxed loop step, and `canonicalJson` drops
   * `undefined`, so no other policy hash moves — the same reason `gate` is optional.
   */
  sandbox?: SandboxPolicy;
  /**
   * The loop's Tempo access key: the key every owner-paid payment of the loop is signed with, the
   * token and limit the treasury authorized it for, its expiry and the authorizing transaction, so an
   * auditor can read the key's terms off one receipt and hold every channel's `authorizedSigner` to
   * it. Policy and not a manifest key, because the terms are fixed for the whole loop.
   *
   * Absent unless `LATH_TEMPO_LOOP_KEYS` was on when the loop started, and spread only when set,
   * so every policy without it hashes byte-for-byte as it would without the key — the pattern
   * `goalCheck` and `traceAudit` follow.
   */
  tempoKey?: TempoKeyPolicy;
  /**
   * The one other model a chat call of this session may be served by: the operator's
   * `LATH_FALLBACK_MODEL`, asked only after the policy's own model got no answer twice in one call.
   * Policy and not a knob, because it is a model the session's records may show, and the audit holds
   * every `llm.*` request to `model` or this (`verifyInference`, `audit`): a record never names a
   * model the Genesis did not allow.
   *
   * Absent when no fallback is configured — and `toRuntimePolicy` drops one equal to `model` or
   * empty — so every policy without it hashes byte for byte as it would without the key, and no
   * Genesis on devnet moves.
   */
  fallbackModel?: string;
  /**
   * The protocol plugins the owner permits this loop, within bounds: the grants the "Lath loop"
   * message binds through `Request ID`, with each item's `spendingLimit` filled at prepare. Grants are
   * on the roadmap and no start on this build carries any, so this is set only on an older loop row
   * started with grants; spread only when set, so every policy without it hashes byte for byte as it
   * would without the key, the pattern `tempoKey` follows, and such a loop's settlement commits the
   * bytes its Genesis did. `policyDocument` writes it picked key by key (`grantsDocument`).
   */
  grants?: Grants;
  /**
   * The loop's own Solana key: a random keypair in a 0600 file, the spending limit's only
   * member and the signer of every plugin transaction. Set at prepare, after the signature, as
   * `tempoKey` is; present exactly when `grants` is.
   */
  solanaKey?: SolanaKeyPolicy;
  /**
   * Where the loop's receipt goes when Jev says its goal is reached, and which key signs it: the SAS
   * credential, the `loop-receipt` schema and the console's runtime key. Absent unless
   * `LATH_PROTOCOL_PLUGINS` was on and the start body asked for a receipt, and spread only when set, so
   * every policy without it hashes byte for byte as it would without the key. Not a grant item: a
   * grant needs the loop's own Solana key, and the receipt is signed by the console's.
   */
  receipt?: LoopReceiptPointer;
}

/** A loop's Solana key as its policy commits it. */
export interface SolanaKeyPolicy {
  /** Base58. */
  address: string;
  /** Unix seconds. */
  createdAt: number;
}

/** A loop's access key as its policy commits it. Strings and integers only; addresses lower-case hex. */
export interface TempoKeyPolicy {
  /** The key's address: every loop channel's `authorizedSigner`. */
  address: string;
  /** The TIP-20 token of the limit: USDC.e. */
  token: string;
  /** The limit the treasury authorized, raw base units, decimal string. */
  limitBase: string;
  /** Unix seconds. */
  expiry: number;
  /** The treasury's authorize transaction hash. */
  authorizeTx: string;
  /**
   * The calls the key may make: absent for an unscoped key. `policyDocument` writes them normalised — addresses and
   * selectors lower-case, sorted by address then selector, each `recipients` sorted — so two writers of one key's terms
   * hash alike.
   */
  scopes?: TempoKeyScope[];
}

/**
 * One call scope of a loop key, as viem's `authorize` takes it (`ox/tempo` `KeyAuthorization.Scope`):
 * the contract, optionally one 4-byte selector on it, and for a TIP-20 transfer the recipients it may
 * pay. A call outside every scope is refused by Tempo with `CallNotAllowed`.
 */
export interface TempoKeyScope {
  address: string;
  selector?: string;
  recipients?: string[];
}

/** The committed ZeroClaw posture; `runtime/src/zeroclaw/posture.ts` generates it and says what each key is. */
export type SandboxPolicy = LathPosture;

/** The pinned judge and the bar its confidence must clear. `model` is never a moving alias. */
export interface VerifyPolicy {
  model: string;
  minConfidence: number;
}

/** The roster, the one model it runs on, and what one task of it may cost. */
export interface WorkersPolicy {
  /**
   * 1–4 agent ids, hex, **in roster order** — the order tasks are handed out in and the order
   * the results enter the memory in, so it is data and not a set. Unlike `toolAllowList` it is
   * therefore never sorted: two rosters with the same members in a different order are two
   * different rosters and must hash differently.
   */
  agentIds: string[];
  /** The team default, and what fills any slot that names no model of its own. */
  model: string;
  /** Per-task ceiling in micro-USDC, as a decimal string — each member's session `maxCost`. */
  budgetMicroUsdcPerTask: string;
  /**
   * One entry per member, **in roster order**, when the team runs more than one policy. Each slot's `policyHash` is the
   * `sha256` of that member's own policy document, so the orchestrator's `policy_version_hash` names which model and
   * which rules each member ran under — the half `agentIds` (who) and the manifest's `members` (what they did) cannot
   * supply between them.
   *
   * Absent when a team runs one model, and an empty array is dropped before hashing, so every
   * team template written without slots keeps its hash.
   */
  slots?: WorkerSlotPolicy[];
  /**
   * The step runs a second orchestrator session that folds the team's answers into the plan.
   * `false` is absent before hashing, for the same reason: a team written without this key never
   * asked for one and its template hash must not move.
   */
  synthesize?: boolean;
}

/** One member's own model and rules, as the orchestrator's policy names them. */
export interface WorkerSlotPolicy {
  /** The roster name, when the slot has one. Absent on a slot the console has not named yet. */
  name?: string;
  model: string;
  /** `sha256(policyDocument(that member's policy))`, hex — checked against that member's Genesis. */
  policyHash?: string;
}

/**
 * Normalizes an AgentConfig or RuntimePolicy into a canonical RuntimePolicy.
 */
export function toRuntimePolicy(p: AgentConfig | RuntimePolicy): RuntimePolicy {
  return {
    model: p.model,
    temperature: p.temperature ?? 0.2,
    toolAllowList: (p as any).toolAllowList ?? (p as any).tools ?? [],
    maxCost: p.maxCost ?? 5_000_000,
    promptHash: p.promptHash,
    // Not `p.payment ?? "tempo"`, and `"vault"` is still normalised away rather than refused: a
    // default would put the key in every policy document and move every genesis hash on devnet,
    // and older templates and offers carry an explicit `"vault"` that has always hashed as absent.
    // No billed call runs on that rail — every one is paid over MPP — but their records must keep
    // verifying, so the normalisation stays exactly as it is and the unnamed policy is what an
    // old chain committed.
    payment: p.payment === "tempo" ? "tempo" : undefined,
    // Only from a `RuntimePolicy`; `AgentConfig` has no verify, because verify is a property of a
    // loop rather than of a single session.
    verify: (p as RuntimePolicy).verify,
    // Only from a `RuntimePolicy`, for the same reason `verify` is: a team is a property of a
    // loop and not of a single session.
    workers: (p as RuntimePolicy).workers,
    // Spread for the reason `gate` below is: a policy with no goal check has no `goalCheck` key
    // at all.
    ...((p as RuntimePolicy).goalCheck ? { goalCheck: (p as RuntimePolicy).goalCheck } : {}),
    // The trace audit, spread for the same reason.
    ...((p as RuntimePolicy).traceAudit ? { traceAudit: (p as RuntimePolicy).traceAudit } : {}),
    // Only from a `RuntimePolicy`, for the reason `verify` is: a gate is a property of a loop.
    // Spread rather than set to `undefined`, so an ungated policy object has no `gate` key at all,
    // for any caller that compares or serialises it without dropping `undefined`.
    ...((p as RuntimePolicy).gate ? { gate: (p as RuntimePolicy).gate } : {}),
    // Last, and spread for the reason `gate` is: a policy with no sandbox has no `sandbox` key at
    // all. Only from a `RuntimePolicy`: the posture is generated by the host for a loop step, never
    // configured on an agent.
    ...((p as RuntimePolicy).sandbox ? { sandbox: (p as RuntimePolicy).sandbox } : {}),
    // The loop's Tempo access key, spread for the reason `gate` is: a loop started with
    // `LATH_TEMPO_LOOP_KEYS` off has no `tempoKey` key at all. Only from a `RuntimePolicy`: the key
    // is authorized by the console for a loop, never configured on an agent.
    ...((p as RuntimePolicy).tempoKey ? { tempoKey: (p as RuntimePolicy).tempoKey } : {}),
    // The fallback model, spread for the reason `gate` is, and only when it names a model other
    // than the policy's own: a fallback equal to `model` is no second model, and committing it
    // would move the hash for a policy that allows nothing more than it did.
    ...(fallbackOf(p) ? { fallbackModel: fallbackOf(p) } : {}),
    // The protocol plugins' grants and the loop's Solana key, spread for the reason `tempoKey` is: a
    // policy without grants has neither key at all. Only from a `RuntimePolicy`: the owner signs
    // grants for a loop, and the console makes the key at prepare, never on an agent.
    ...((p as RuntimePolicy).grants ? { grants: (p as RuntimePolicy).grants } : {}),
    ...((p as RuntimePolicy).solanaKey ? { solanaKey: (p as RuntimePolicy).solanaKey } : {}),
    // The receipt's pointer, spread for the reason `grants` is.
    ...((p as RuntimePolicy).receipt ? { receipt: (p as RuntimePolicy).receipt } : {}),
  };
}

/** `fallbackModel`, trimmed, when it names a model other than `model`; undefined otherwise. */
function fallbackOf(p: AgentConfig | RuntimePolicy): string | undefined {
  const f = (p as RuntimePolicy).fallbackModel;
  const t = typeof f === "string" ? f.trim() : "";
  return t && t !== p.model ? t : undefined;
}

/** A hex string as the policy commits it: lower-case, so a checksummed and a plain address are one key. */
function lowerHex(v: unknown): string {
  return String(v ?? "").toLowerCase();
}

/**
 * The `tempoKey` member as `policyDocument` writes it: exactly the five named keys, plus `scopes`
 * when the key has them, extras dropped, the two addresses and the transaction hash lower-case,
 * `limitBase` a decimal string and `expiry` an integer. Two writers — the console that authorized
 * the key and an auditor rebuilding the document from a `loops.json` row, a checksummed viem address
 * or a bigint limit — must produce the same bytes, or the Genesis names a policy nobody can reproduce.
 *
 * `limitBase` goes through `BigInt` rather than `String` so `"1000"`, `1000` and `1000n` agree and
 * a leading zero cannot fork the hash; it stays a string because a limit is a `uint256` on Tempo
 * and JSON has no integer that wide. `expiry` is Unix seconds, which a JS number holds exactly, and
 * is truncated so `1.7e9` and `"1700000000"` are one instant. Not validated beyond that — the
 * console refuses terms it cannot authorize, and a document is only ever the bytes of what it was given.
 */
function tempoKeyDocument(k: TempoKeyPolicy): TempoKeyPolicy {
  return {
    address: lowerHex(k.address),
    token: lowerHex(k.token),
    limitBase: BigInt(k.limitBase as unknown as string | number | bigint).toString(),
    expiry: Math.trunc(Number(k.expiry)),
    authorizeTx: lowerHex(k.authorizeTx),
    // Spread, never written as `undefined` and left to `canonicalJson`: an unscoped key's member must be exactly the
    // five keys, and a spread says so where it is read. An empty list is kept, not dropped: ox reads `scopes: []` as
    // "scoped, no calls allowed" and an absent one as unrestricted, so the two are different keys on Tempo and must
    // hash apart.
    ...(Array.isArray(k.scopes) ? { scopes: tempoKeyScopesDocument(k.scopes) } : {}),
  };
}

/**
 * A key's call scopes as the policy commits them: each scope with exactly `address`, `selector?` and
 * `recipients?`, every one lower-case hex, `recipients` sorted, and the list sorted by address and then
 * selector, a scope with no selector (the whole contract) first.
 *
 * Sorted because order means nothing on Tempo — ox groups the flat list by address into the
 * keychain's `allowedCalls` and the keychain answers `getAllowedCalls` in its own order — so the
 * console that authorized the key, the audit rebuilding it from `getAllowedCalls` and an older loop
 * row must all land on one document. An empty `recipients` is dropped for the same reason: ox writes
 * no recipient rule for it, so it and an absent list are one key.
 */
function tempoKeyScopesDocument(scopes: TempoKeyScope[]): TempoKeyScope[] {
  const docs = scopes.map((s): TempoKeyScope => {
    const recipients = Array.isArray(s.recipients) ? s.recipients.map(lowerHex).sort() : [];
    return {
      address: lowerHex(s.address),
      ...(s.selector ? { selector: lowerHex(s.selector) } : {}),
      ...(recipients.length > 0 ? { recipients } : {}),
    };
  });
  return docs.sort((a, b) => {
    if (a.address !== b.address) return a.address < b.address ? -1 : 1;
    if (a.selector === b.selector) return 0;
    if (a.selector === undefined) return -1;
    if (b.selector === undefined) return 1;
    return a.selector < b.selector ? -1 : 1;
  });
}

/**
 * One watch source with exactly the keys its kind names, in the order the caller gave the list.
 * Extras are dropped so two writers of the same source hash alike; the list itself is never
 * sorted, because `watchSlots` order is the order every ask's `refs` are committed in.
 */
function watchSourceDoc(w: WatchSource): WatchSource {
  if (w.kind === "store") return { kind: "store", keys: [...w.keys] };
  if (w.kind === "agent") {
    // `routineCalls` absent is no count rule for the source, and it drops out rather than being
    // written as `null`, so a source without one hashes as if the key did not exist.
    return { kind: "agent", agentId: w.agentId, label: w.label, routineCalls: w.routineCalls };
  }
  // Its own branch, never the fall-through below: a `solana` source written as a `pyth` one
  // would commit a feed nobody named under the policy hash.
  if (w.kind === "solana") return { kind: "solana", address: w.address, label: w.label };
  return { kind: "pyth", feedId: w.feedId, label: w.label, minMoveBps: w.minMoveBps };
}

/**
 * Deterministic JSON — keys sorted, `undefined` dropped, no whitespace, arrays in the caller's
 * order — is the SDK's `canonicalJson` (`sdk/src/market.ts`), the one function under every hash
 * of a JSON object: a policy, an offer manifest, a posture, a replay record. Re-exported here
 * because every runtime module and the console import it from `policy`. Re-exported rather than
 * copied: a copy of a hash input is a second place for the bytes to drift, and nothing would notice
 * until a chain failed to verify.
 */
export { canonicalJson };

/** `sha256(prompt)` in hex — what `RuntimePolicy.promptHash` carries. */
export function promptHash(prompt: string): string {
  return hex(sha256(utf8(prompt)));
}

/**
 * The policy document: canonical JSON `{model, temperature, toolAllowList, maxCost, payment?,
 * promptHash?, verify?, goalCheck?, traceAudit?, workers?, gate?, sandbox?, tempoKey?, fallbackModel?, grants?,
 * solanaKey?}`. `promptHash` is absent unless the policy names one, and `payment` unless the
 * policy runs on the `tempo` rail (SPEC §3). These are the exact bytes `policyVersionHash`
 * hashes *and* the bytes the runtime publishes to its `PolicyRegistry`, from one function so
 * the two cannot drift: a published document that omitted a key the hash carries (`payment` on a
 * `tempo`-rail agent, say) would leave `registry.has(policyVersionHash)` never true, and every
 * session after the first would re-create the same cell and fail with "address already exists".
 */
export function policyDocument(p: AgentConfig | RuntimePolicy): string {
  const norm = toRuntimePolicy(p);
  return canonicalJson({
    model: norm.model,
    temperature: norm.temperature,
    toolAllowList: [...norm.toolAllowList].sort(),
    maxCost: norm.maxCost,
    payment: norm.payment,
    promptHash: norm.promptHash,
    // Normalised rather than spread: an object with extra keys, or with the two in the other
    // order, must hash as the same policy. `canonicalJson` sorts keys, and a `verify` that is
    // absent drops out of the document entirely.
    verify: norm.verify ? { model: norm.verify.model, minConfidence: norm.verify.minConfidence } : undefined,
    // The goal check, normalised the way `verify` is — the two named keys, extras dropped — and
    // absent when off, so `canonicalJson` writes the document every loop without it always wrote.
    goalCheck: norm.goalCheck
      ? { model: norm.goalCheck.model, minConfidence: norm.goalCheck.minConfidence }
      : undefined,
    // The trace audit, normalised the way `goalCheck` is: `model`, and each behaviour's `bar` (a
    // number, so `"0.5"` and `0.5` are one policy) and `onPresent`, extras dropped; `canonicalJson`
    // sorts the ids. Absent when off. Not validated here — the runner refuses terms it cannot run,
    // and a document is only ever the bytes of what it was given.
    traceAudit: norm.traceAudit ? traceAuditDocument(norm.traceAudit) : undefined,
    // Normalised the way `verify` is — three named keys, extras dropped, absent when there is no
    // team — but `agentIds` is copied in order rather than sorted: the roster's order is what
    // decides which member gets the first task line and where its answer lands in the memory.
    workers: norm.workers
      ? {
          agentIds: [...norm.workers.agentIds],
          model: norm.workers.model,
          budgetMicroUsdcPerTask: norm.workers.budgetMicroUsdcPerTask,
          // Absent when the team runs one model — not an empty array, which `canonicalJson`
          // would write as `[]` and move the policy hash of every team written without slots. Slots
          // keep their order for the same reason `agentIds` does: the roster's order is data.
          slots: norm.workers.slots?.length
            ? norm.workers.slots.map((s) => ({ name: s.name, model: s.model, policyHash: s.policyHash }))
            : undefined,
          // `false` and absent are the same team and must hash alike, the way `payment: "vault"`
          // normalises away: a loop that does not synthesize is a team written without the key.
          synthesize: norm.workers.synthesize ? true : undefined,
        }
      : undefined,
    // Five named keys, extras dropped, absent on an ungated loop. The bar and the heartbeat are
    // integers, so the bytes do not depend on how a JSON writer prints a float.
    gate: norm.gate
      ? {
          model: norm.gate.model,
          barBps: norm.gate.barBps,
          watch: norm.gate.watch.map(watchSourceDoc),
          failMode: norm.gate.failMode,
          heartbeatMs: norm.gate.heartbeatMs,
        }
      : undefined,
    // Whole, not picked key by key the way `verify` and `gate` are: the posture is generated by
    // `lathPosture`, never written by a person, and every key of it is part of the jail, so a key
    // added later must move the hash rather than be dropped by a normaliser that predates it.
    // `canonicalJson` still sorts its keys; its arrays (the tool list, sorted when generated, and
    // the wrapper template, whose order is the profile's) keep their order.
    sandbox: norm.sandbox,
    // Picked key by key, the way `verify` and `gate` are and unlike `sandbox`: the terms come from a
    // loop row and a viem receipt, written by code that can add fields or change case, and only the
    // five named keys and `scopes` are rules. Absent when the loop has no key, so `canonicalJson`
    // writes the document a policy without one always writes.
    tempoKey: norm.tempoKey ? tempoKeyDocument(norm.tempoKey) : undefined,
    // The one other model a chat call may be served by; absent unless the operator set one, so
    // `canonicalJson` writes the document a policy without one always writes.
    fallbackModel: norm.fallbackModel,
    // The protocol plugins, picked key by key the way `tempoKey` is: the grants come from a start
    // body and a loop row, written by code that can add fields, and only the named keys are rules.
    // Absent when the loop has none, so `canonicalJson` writes the document a policy without them
    // always writes.
    grants: norm.grants ? grantsDocument(norm.grants) : undefined,
    solanaKey: norm.solanaKey ? solanaKeyDocument(norm.solanaKey) : undefined,
    // The receipt's pointer, picked key by key the way `solanaKey` is; absent when the loop asked for
    // none, so `canonicalJson` writes the document a policy without one always writes.
    receipt: norm.receipt ? loopReceiptPointerDocument(norm.receipt) : undefined,
  });
}

/**
 * The `grants` member as `policyDocument` writes it: exactly the named keys of the document and of
 * each item and payee, extras dropped, `spendingLimit` only when the console has filled it, `items` and
 * `payees` in the order given — the owner's order, which is the order a reader is shown them in and
 * not a set `canonicalJson` may sort. Values are copied, not coerced: `validateGrants` refused anything
 * that is not already the right type before the start body was signed, and coercing here would let two
 * different documents the owner could have signed commit the same bytes.
 *
 * Exported because this form is the one a granted loop's rule runs against, and no other: a runner
 * checks the grants it is handed against these bytes, and the auditor replays every verdict from the
 * policy document, extras and all dropped the same way. This build steps no granted loop (grants are
 * on the roadmap); the function stays so a policy that names grants hashes as its Genesis did.
 */
export function grantsDocument(g: Grants): Grants {
  return {
    v: g.v,
    cluster: g.cluster,
    mandate: g.mandate,
    barBps: g.barBps,
    maxPerStep: g.maxPerStep,
    expiresAt: g.expiresAt,
    items: (g.items ?? []).map((i): GrantItem => {
      // One branch per plugin. Copying one plugin's keys for every item would silently drop another's — an SAS item
      // would lose its credential, its schema and its subjects from the policy hash, the runner's copy and the
      // auditor's alike.
      if (i.plugin === "sas") {
        return {
          id: i.id,
          plugin: i.plugin,
          action: i.action,
          credential: i.credential,
          schema: i.schema,
          subjects: (i.subjects ?? []).map((s) => ({ name: s.name, address: s.address })),
          maxTotal: i.maxTotal,
          expiresInDays: i.expiresInDays,
        };
      }
      // Squads, and anything else: the bytes every existing policy fixture pins.
      const q = i as SquadsGrantItem;
      return {
        id: q.id,
        plugin: q.plugin,
        action: q.action,
        multisig: q.multisig,
        vaultIndex: q.vaultIndex,
        mint: q.mint,
        // Absent in the start body and filled at prepare: spread so an unfilled item has no key at all, rather than one
        // `canonicalJson` would have to drop.
        ...(q.spendingLimit !== undefined ? { spendingLimit: q.spendingLimit } : {}),
        payees: (q.payees ?? []).map((p) => ({ name: p.name, address: p.address })),
        maxPerAction: q.maxPerAction,
        maxTotal: q.maxTotal,
        uniqueRef: q.uniqueRef,
      };
    }),
  };
}

/**
 * The `solanaKey` member as `policyDocument` writes it: the two named keys, extras dropped, the
 * address as given (base58 is case-sensitive, so it is not lower-cased the way a Tempo address is) and
 * `createdAt` truncated to an integer, so `1.7e9` and `"1700000000"` are one instant, as `tempoKey`'s
 * `expiry` is.
 */
export function solanaKeyDocument(k: SolanaKeyPolicy): SolanaKeyPolicy {
  return { address: String(k.address ?? ""), createdAt: Math.trunc(Number(k.createdAt)) };
}

/** The `traceAudit` key as `policyDocument` writes it. */
function traceAuditDocument(t: TraceAuditConfig): TraceAuditConfig {
  const behaviours: TraceAuditConfig["behaviours"] = {};
  for (const [id, term] of Object.entries(t.behaviours ?? {})) {
    behaviours[id] = { bar: Number(term.bar), onPresent: term.onPresent };
  }
  return { model: t.model, behaviours };
}

/** `sha256(policyDocument(p))`. */
export function policyVersionHash(p: AgentConfig | RuntimePolicy): Bytes32 {
  return sha256(utf8(policyDocument(p)));
}
