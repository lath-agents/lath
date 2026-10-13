/**
 * Copying a deployed agent under a new name, and the clone half of `POST /api/agents/:id`.
 *
 * A **clone** is the owner copying its own agent. A marketplace **launch**, a copy made by someone who
 * does not own the source, is on the roadmap and not in this build; older records of the copies a
 * launch made are ordinary agents of their owner's, and carry `clonedFrom.via`, which the pages read
 * as a copy, and `clonedFrom.listing`, which nothing reads.
 *
 * Here rather than in a route for the reason `loopStartAgent` is in `_lib`: a route that imports
 * `next/server` cannot be loaded outside `frontend/`, and these are the rules worth testing
 * (`tests/console-clone.ts`).
 *
 * **A copy is one transaction.** A clone that registered and funded a new agent on a signed message
 * and stopped there would have no allowance, because an allowance is per `(user, agent_authority)`
 * and the copy's authority is new. That is the registered-funded-and-unpayable state the
 * one-transaction deploy (`prepareDeployTx`) exists to make unrepresentable: the copy's first session
 * would be refused and its page would offer no way to grant one. So a clone is `prepare` then
 * `confirm`, the shape the wizard's deploy has, the allowance rides in the same transaction as the
 * registration, and the *Clone* button costs one wallet prompt.
 */
import { randomBytes } from "crypto";
import { hex, idFromString } from "@lath/sdk";
import { policyVersionHash, promptHash } from "@lath/runtime";
import {
  CLONES_PER_HOUR,
  DeployedAgent,
  DeployedPolicy,
  lookupAgent,
  rateLimit,
  recordAgent,
  isArchived,
} from "./runner";
import {
  AgentTemplateConfig,
  MAX_EXPIRATION_DAYS,
  MIN_BUDGET_CAP_USDC,
  Template,
  TemplateLink,
  lookupTemplate,
  recordTemplate,
  templateLink,
} from "./templates";

/** A refusal with the status the route answers. The twin of `_lib/loop-terms.ts`'s. */
export type Refusal = { error: string; status: number };

/** The same shape `POST /api/agents` derives its id from: lowercase, and nothing that is not a name. */
export function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 40);
}

/**
 * What a copy is about to do, once everything that can refuse it has not: the agent being
 * copied, the name and id the copy gets, the config it will run, and the allowance the one
 * signature grants to the key it is registered under.
 */
export interface CopyPlan {
  source: {
    agentId: string;
    name: string;
    record: DeployedAgent;
    template: Template | null;
  };
  /** The copy: the caller's name for it and the id that name hashes to. */
  name: string;
  id: string;
  config: AgentTemplateConfig;
  policy: DeployedPolicy;
  /** What the `approve_agent` instruction in the copy's transaction commits to. */
  allowance: { capMicroUsdc: string; expiresAt: string; policyVersionHash: string };
}

/**
 * The `policy_version_hash` a deploy's `approve_agent` commits: the agent's configured policy, with
 * `maxCost` set to the **whole budget cap** the grant is for.
 *
 * It is not, and cannot be, the hash a session's genesis writes. A session commits the policy it ran,
 * and its `maxCost` is that session's ceiling — `SESSION_CAP_MICRO` or less on `/api/run`,
 * `budgetMicroUsdcPerStep` on a loop step — so one agent's genesis hashes already differ from each
 * other, and none of them equals a grant sized for the agent's lifetime. Nothing compares the two:
 * `lath-billing` stores the field and reads it nowhere, and `lath-audit` never opens an `Allowance`. So
 * the grant's hash is a claim about what the wallet approved, and the relation that does hold is the
 * one this pins — the same document as a genesis under the same config, differing in `maxCost` alone.
 *
 * One builder for every server-side deploy path, because two builders drift: a terminal deploy in
 * `/api/agents` that leaves `payment` out makes a `tempo` agent deployed from a script commit a grant
 * no browser deploy of the same config would. The wizard's `browserPolicyHash` builds the same
 * document in the browser, and cannot import this file.
 */
export function allowancePolicyHash(p: {
  model: string;
  tools: string[];
  capMicroUsdc: bigint;
  payment?: DeployedPolicy["payment"];
  prompt?: string;
}): Uint8Array {
  const prompt = p.prompt?.trim();
  return policyVersionHash({
    model: p.model,
    temperature: 0.2,
    toolAllowList: [...p.tools].sort(),
    maxCost: Number(p.capMicroUsdc),
    payment: p.payment,
    promptHash: prompt ? promptHash(prompt) : undefined,
  });
}

/**
 * The config a copy of `record` runs, and the template version it is read from.
 *
 * The linked template version's, and the record's `policy` when the source has no template: there
 * is no template for the copy to point back at, and the copy still has to run.
 */
export function copiedConfig(record: DeployedAgent): { template: Template | null; config: AgentTemplateConfig } {
  const found = record.template ? lookupTemplate(record.template.id, record.template.version) : null;
  const template = found && found.kind === "agent" ? found : null;
  const config: AgentTemplateConfig = template
    ? template.config
    : {
        model: record.policy.model,
        tools: record.policy.tools,
        budgetCapUsdc: record.policy.budgetCapUsdc,
        expirationDays: record.policy.expirationDays,
      };
  return { template, config };
}

const U64_MAX = (1n << 64n) - 1n;

/** Micro-USDC exactly as `planCopy` encodes a cap, so the ceiling is checked on the number it sends. */
const capMicro = (raw: string): bigint => BigInt(Math.round(Number(raw) * 1_000_000));

/**
 * Why a taker's own allowance terms cannot be used, or `null`. The rules `/api/agents` holds a
 * deploy to, and for its reasons: both numbers are read back by paths that cannot refuse, and
 * `expirationDays: 0` reverts on chain.
 */
export function copyTermsRefusal(
  terms: { budgetCapUsdc?: unknown; expirationDays?: unknown } | undefined
): Refusal | null {
  const askedCap = terms?.budgetCapUsdc;
  if (askedCap !== undefined) {
    // A deploy's rule (`checkUsdc` in `../templates/validate`): plain decimal, six places, at least
    // the wizard's floor. `Number(x) > 0` took `"0.000001"`, `"0x10"` and `"1e2"`, and `"1e300"`
    // threw at the u64 encode after the clone counter was charged — so the ceiling is u64 too.
    const raw = typeof askedCap === "string" ? askedCap.trim() : "";
    if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
      return { error: "the budget cap must be a decimal number of USDC with at most 6 places", status: 400 };
    }
    if (Number.parseFloat(raw) < MIN_BUDGET_CAP_USDC) {
      return { error: `the budget cap must be at least ${MIN_BUDGET_CAP_USDC.toFixed(2)} USDC`, status: 400 };
    }
    if (capMicro(raw) > U64_MAX) return { error: "the budget cap is larger than an allowance can hold", status: 400 };
  }
  const askedDays = terms?.expirationDays;
  if (askedDays !== undefined) {
    // A number and nothing that coerces to one, as a deploy's `checkInt` holds it: `Number(true)` is
    // 1 and `Number("7")` is 7, and the copy would then grant an expiry the taker never sent.
    const n = typeof askedDays === "number" ? askedDays : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_EXPIRATION_DAYS) {
      return { error: `the expiry must be a whole number of days between 1 and ${MAX_EXPIRATION_DAYS}`, status: 400 };
    }
  }
  return null;
}

/**
 * The plan for a copy, or why there is none.
 *
 * The order of the refusals is load-bearing, and it is worth being exact about what it buys.
 * Everything the server can refuse on its own — a name too short, a name already taken, a source
 * that publishes no budget — is refused **before** the hourly counter is charged. A typo or a name someone else took therefore
 * costs nothing. The counter is the last gate: past it the caller gets a transaction it can
 * broadcast.
 *
 * What it does **not** cover is a wallet prompt the person cancels. That is charged, because the
 * counter is what bounds how many broadcastable transactions a wallet can obtain in an hour, and
 * the operator's SOL is spent the moment one of them lands — a decision the server is not present
 * for. Moving the charge to `confirm` would bound nothing: by then the transaction has already
 * landed and the SOL is already gone. So a cancelled prompt spends one of the hour's copies, on
 * purpose.
 */
export function copyContext(p: {
  /** Hex `agent_id` of the agent being copied, and the record this console holds for it. */
  sourceAgentId: string;
  source: DeployedAgent;
  /** Base58 of whoever is taking the copy: the owner, for a clone. */
  wallet: string;
  /** The caller's name for the copy; a copy is a new name because the id is the hash of one. */
  name: string;
  /**
   * The hourly budget this copy spends, charged last. Absent, nothing is charged here and the
   * caller charges its own counter once its own later refusals have passed.
   */
  limit?: { what: string; key: string; perHour: number };
  /**
   * The taker's own allowance terms, when they set them rather than taking the source's: the cap
   * the one signature grants and how long it lasts. They are the copy's terms, not the blueprint's,
   * so they land on the copy's record and its `approve_agent` and leave `config` — and with it the
   * template the copy links to — as the source has it. The cap is `maxCost` in the copy's
   * `policy_version_hash`, which is the copy's own hash; nothing already on chain moves.
   */
  terms?: { budgetCapUsdc?: unknown; expirationDays?: unknown };
}): CopyPlan | Refusal {
  const record = p.source;
  const name = sanitizeName(p.name ?? "");
  if (name.length < 3) return { error: "a copy needs a name of its own", status: 400 };
  if (name === record.name) return { error: `${name} is the name of the agent being copied`, status: 409 };

  const id = hex(idFromString(name));
  if (lookupAgent(id)) return { error: `${name} is already deployed here`, status: 409 };

  // The config is the linked template version's, or the record's `policy` (`copiedConfig`).
  const { template, config } = copiedConfig(record);

  // The rail is part of the config being copied: a template version names it when it was written
  // with one, and a record written by a deploy always does. Dropping it would make a clone of a
  // `tempo` agent a `vault` agent with a different genesis hash, and a clone of a `vault` agent a row
  // that no longer equals its source.
  const payment = config.payment ?? record.policy.payment;
  const badTerms = copyTermsRefusal(p.terms);
  if (badTerms) return badTerms;
  const askedCap = p.terms?.budgetCapUsdc;
  const askedDays = p.terms?.expirationDays;
  const policy: DeployedPolicy = {
    model: config.model,
    tools: config.tools,
    budgetCapUsdc: askedCap !== undefined ? String(askedCap).trim() : config.budgetCapUsdc,
    expirationDays: askedDays !== undefined ? Number(askedDays) : Number(config.expirationDays ?? MAX_EXPIRATION_DAYS),
    ...(payment ? { payment } : {}),
  };
  const cap = capMicro(policy.budgetCapUsdc);
  if (!(cap > 0n)) {
    return { error: `${record.name} carries no budget, so there is no allowance to sign for`, status: 409 };
  }

  // Last, and only once nothing else can refuse this: see the note above.
  const refused = p.limit ? rateLimit(p.limit.what, p.limit.key, p.limit.perHour) : null;
  if (refused) return { error: refused, status: 429 };

  return {
    source: {
      agentId: p.sourceAgentId,
      name: record.name,
      record,
      template,
    },
    name,
    id,
    config,
    policy,
    allowance: {
      capMicroUsdc: cap.toString(),
      expiresAt: String(Math.floor(Date.now() / 1000) + policy.expirationDays * 86400),
      // The config being copied, with the grant's whole cap as `maxCost` — so the document a
      // genesis of the copy hashes except for that one field, which a session sets to its own
      // ceiling (`allowancePolicyHash`). The billing program treats the allowance's hash as
      // advisory, so this is a claim about what was approved, not a constraint on what runs.
      policyVersionHash: hex(
        allowancePolicyHash({
          model: policy.model,
          tools: policy.tools,
          capMicroUsdc: cap,
          payment: policy.payment,
          prompt: config.prompt,
        })
      ),
    },
  };
}

/**
 * What a prepared copy remembers, so the confirming half needs no second signature.
 *
 * The caller signs one transaction and that is the whole ceremony; the ticket is a capability
 * held here, naming the wallet whose authorisation was checked and the configuration that was
 * checked with it. `confirm` presents the ticket, the server reads the chain, and only a header
 * that is really there becomes a record. Tickets are single-use and short-lived, for the reasons
 * `DeployTicket` gives.
 */
export interface CopyTicket {
  wallet: string;
  name: string;
  /** Base64 of the message bytes `prepare` built. `confirm` requires the transaction that landed
   * to be exactly this, signed by `wallet`; see `deployTxSignedBy` in `_lib/runner.ts`. */
  message: string;
  id: string;
  policy: DeployedPolicy;
  config: AgentTemplateConfig;
  sourceAgentId: string;
  sourceName: string;
  /** The template version copied, when the source had one. */
  sourceTemplate?: { id: string; version: number };
  expiresAt: number;
}

export const COPY_TICKET_TTL_MS = 10 * 60_000;

/**
 * One in-memory store of short-lived, single-use tickets.
 *
 * `peek` rather than `claim` is what a confirm uses: by the time `confirm` runs the transaction
 * has already landed, so a ticket spent because this RPC node was a slot behind leaves a
 * registered agent with no record, under a name `prepareDeployTx` refuses forever. The
 * ticket is spent only once the chain has answered.
 *
 * The default TTL is a literal and not `COPY_TICKET_TTL_MS`, deliberately. A caller may call this at
 * module scope while these modules form a cycle, and a `const` read across a cycle that has not
 * finished evaluating is a TDZ `ReferenceError` that only webpack's module graph produces — node's
 * own resolution order in `ts-mocha` does not, so no test here would catch it.
 *
 * `name` puts the map on `globalThis`, for the reason `_lib/anchor.ts` gives: Next re-evaluates a
 * route's modules when it recompiles them, and a map built by the evaluation that issued a ticket
 * is not the one the confirm reads. The wallet has signed by then, so a lost ticket is a landed
 * registration with no record and a name nobody can adopt, and a recompile between a prepare and a
 * confirm only milliseconds apart is enough to lose one that way.
 */
export function ticketStore<T extends { expiresAt: number }>(ttlMs: number = 10 * 60_000, name?: string) {
  // Loud rather than silent, and at import time. A caller that runs this at module scope while
  // these modules are in a cycle sees a default argument that reads a binding from this module's
  // own scope is `undefined` under node's CJS emit (every ticket expires the instant it is
  // issued) and a TDZ `ReferenceError` under webpack's (every route 500s). Neither is a thing to
  // discover in production; the check turns both into one failure at load.
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`ticketStore needs a positive TTL, got ${ttlMs}; a module cycle read it before it was set`);
  }
  const g = globalThis as typeof globalThis & { __lathTickets?: Map<string, Map<string, unknown>> };
  const shared = name ? (g.__lathTickets ??= new Map()) : null;
  const held = (shared?.get(name!) ?? new Map<string, T>()) as Map<string, T>;
  if (shared) shared.set(name!, held);
  return {
    issue(t: Omit<T, "expiresAt">): string {
      const now = Date.now();
      for (const [id, t] of held) if (t.expiresAt < now) held.delete(id);
      const id = randomBytes(16).toString("hex");
      held.set(id, { ...t, expiresAt: now + ttlMs } as T);
      return id;
    },
    /** The ticket, still held. */
    peek(id: string | undefined): T | null {
      if (!id) return null;
      const t = held.get(id);
      if (!t) return null;
      if (t.expiresAt < Date.now()) {
        held.delete(id);
        return null;
      }
      return t;
    },
    /** Spend it: the chain has answered, one way or the other. */
    spend(id: string): void {
      held.delete(id);
    },
  };
}

/**
 * The records a landed copy leaves: a copy of the template under the new owner, and the agent
 * linked to it. Same config and therefore the same `hash` — a copy is lineage, not a new
 * configuration — and `clonedFrom` on both, so the template says which template it came from and
 * the agent says which agent.
 */
export function recordCopy(
  ticket: CopyTicket,
  authority: string
): {
  template: TemplateLink;
  clonedFrom: { agentId: string; name: string; via?: "market" };
} {
  const source = ticket.sourceTemplate ? lookupTemplate(ticket.sourceTemplate.id, ticket.sourceTemplate.version) : null;
  const template = recordTemplate({
    kind: "agent",
    owner: ticket.wallet,
    name: source?.name ?? ticket.name,
    config: ticket.config,
    ...(source ? { clonedFrom: { id: source.id, version: source.version } } : {}),
  });
  // No `via` and no `listing`: a clone is the owner copying its own agent, so its record is
  // byte-identical to the clones already in `agents.json`. Only a marketplace launch wrote either
  // key, and the copies it made keep them; the type still names `via` because the pages read such a
  // copy as one (`OwnerHeaderCard` `Lineage`).
  const clonedFrom: { agentId: string; name: string; via?: "market" } = {
    agentId: ticket.sourceAgentId,
    name: ticket.sourceName,
  };
  recordAgent(ticket.id, {
    name: ticket.name,
    authority,
    owner: ticket.wallet,
    createdAt: Date.now(),
    policy: ticket.policy,
    template: templateLink(template),
    clonedFrom,
  });
  return { template: templateLink(template), clonedFrom };
}

/** The ticket a prepared copy hands out, from `issueCopyTicket` to `spendCopyTicket`. */
export function copyTicketFrom(plan: CopyPlan, wallet: string, message: string): Omit<CopyTicket, "expiresAt"> {
  return {
    wallet,
    name: plan.name,
    message,
    id: plan.id,
    policy: plan.policy,
    config: plan.config,
    sourceAgentId: plan.source.agentId,
    sourceName: plan.source.name,
    ...(plan.source.template
      ? { sourceTemplate: { id: plan.source.template.id, version: plan.source.template.version } }
      : {}),
  };
}

// ─── The clone action ───────────────────────────────────────────────────────

/**
 * May this wallet clone this agent, and what would the copy be? The plan, or why not.
 *
 * A clone is the owner copying its own agent, so the rule a clone adds to `copyContext` is
 * ownership — and it is the same rule `/api/run`, loop start and every other write on a record
 * applies: the chain is the owner's history, and a record made before ownership was recorded has
 * nobody who can prove they may edit it.
 *
 * The wallet is **unsigned** here, as `prepare` on the deploy route takes one: the
 * transaction this plan becomes is inert until that wallet signs it, so claiming an address
 * cannot make a copy nobody signed for. What it does obtain is the prepare's answer, and the owner
 * is public in `GET /api/agents` — so whatever that answer carries is served to anyone who names
 * the owner (and one of the owner's hourly clones is spent, the trade-off `callerIp` states). The
 * route therefore answers with `publicCopyConfig`, never the plan's config. What the
 * wallet actually signed is checked at `confirm`, off the chain, by `deployTxSignedBy` — a stronger
 * proof than a signed message, because the message in the landed transaction is the one this
 * server built and its `approve_agent` names that wallet.
 */
export function cloneContext(p: {
  /** Hex `agent_id` of the agent being cloned, and the record for it. */
  agentId: string;
  source: DeployedAgent | null;
  /** Base58 of the caller, unsigned. */
  wallet: string;
  name: string;
  /** The caller's address, so one wallet's hourly allowance is not spent from everywhere. */
  ip?: string;
}): CopyPlan | Refusal {
  const agentId = String(p.agentId ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(agentId)) return { error: "agentId must be 32 hex bytes", status: 400 };
  const record = p.source;
  if (!record) return { error: `no agent ${agentId} was deployed here`, status: 404 };
  if (!record.owner) return { error: `${record.name} has no recorded owner`, status: 403 };
  if (record.owner !== p.wallet) return { error: `${record.name} belongs to another wallet`, status: 403 };

  return copyContext({
    sourceAgentId: agentId,
    source: record,
    wallet: p.wallet,
    name: p.name,
    // The same key `POST /api/agents` uses for a deploy from a template, so the two routes share
    // one hourly budget instead of a wallet getting `CLONES_PER_HOUR` on each — and keyed on the
    // caller as well as the wallet, so naming someone else's address cannot empty their bucket.
    // That is the whole of what this key is: fair use between honest callers. It bounds nobody
    // who is willing to use a fresh address, because `prepare` never checks a signature — the
    // bound on the operator's SOL is `prepareCeiling` in `_lib/runner.ts`.
    limit: { what: "clones", key: `clone:${p.wallet}:${p.ip ?? ""}`, perHour: CLONES_PER_HOUR },
  });
}

/**
 * The config a clone's `prepare` answers with: everything the copy will run under except the
 * prompt, which is replaced by its hash.
 *
 * That prepare is unsigned and the owner it checks against is public, so its answer is served to
 * whoever names the owner. Were it to carry the source template's whole config, prompt included, a
 * fresh unregistered name — which is free — would be all it took to read another wallet's prompt. The prompt stays behind the owner's signature; `promptHash` is what the copy's genesis
 * commits (`policy_version_hash`), so a page can still say which prompt the copy will run without
 * serving it. Nothing on chain moves: the allowance is still built from the full config in
 * `copyContext`, and the ticket `confirm` writes from keeps it.
 */
export function publicCopyConfig(
  config: AgentTemplateConfig
): Omit<AgentTemplateConfig, "prompt"> & { promptHash?: string } {
  const { prompt, ...rest } = config;
  const trimmed = prompt?.trim();
  return { ...rest, ...(trimmed ? { promptHash: promptHash(trimmed) } : {}) };
}

/** An archived source is cloneable — the copy is not archived — and the answer says so. */
export function cloneNote(plan: CopyPlan): string | undefined {
  return isArchived(plan.source.record) ? "The agent it was cloned from is archived; the clone is not." : undefined;
}

const cloneTickets = ticketStore<CopyTicket>(undefined, "clone");

export function issueCloneTicket(plan: CopyPlan, wallet: string, message: string): string {
  return cloneTickets.issue(copyTicketFrom(plan, wallet, message));
}
export const peekCloneTicket = (ticket: string | undefined) => cloneTickets.peek(ticket);
export const spendCloneTicket = (ticket: string) => cloneTickets.spend(ticket);
