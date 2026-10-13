/**
 * Deployment. The wallet signs a message; the server registers the header.
 *
 * On chain an owner's `authority` is whoever signed `register_agent`, and only that key may
 * append to its chain. An agent registered by a browser wallet is therefore an agent no
 * server-side runtime can ever write — it would have a header and never a session. So the
 * server registers with a key it derives from the deployed name (never stored, always
 * re-derivable), pays the SOL for it, and the wallet's one transaction is the *allowance* that
 * lets that key meter inference against the wallet's escrow.
 *
 * That is also why a signature is required: registration spends the operator's SOL, so an
 * anonymous caller cannot ask for one. A signature alone is not enough for the branch where the
 * *server* signs and sends (`auth` without `prepare`), because minting a keypair to sign with is
 * free: that branch also asks for USDC in the treasury's escrow under the signing wallet, and
 * both branches are under one server-wide ceiling (`prepareCeiling`). What bounds this route is
 * therefore evidence of payment and a budget for the whole server, not a counter per wallet — a
 * wallet is the thing an attacker rotates.
 *
 * The mapping id → name lives in `LATH_TRACE_DIR/agents.json`; `/api/run` reads it to find
 * the keys again, and checks them against the header's on-chain authority before it writes.
 */
import { NextRequest } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import { hex, idFromString, LathClient } from "@lath/sdk";
import {
  CLONES_PER_HOUR,
  CLUSTER,
  DEPLOYS_PER_HOUR,
  DeployTicket,
  DeployedPolicy,
  MODELS,
  PreparedAllowance,
  RPC_URL,
  SessionAuth,
  callerIp,
  confirmLandedDeploy,
  consoleOrigin,
  deployTxSignedBy,
  deployedRoles,
  escrowFor,
  isArchived,
  issueDeployTicket,
  loadKeypair,
  lookupAgent,
  normalizeDescription,
  peekDeployTicket,
  prepareAllowanceTx,
  prepareCeiling,
  prepareDeployTx,
  publishDeployedName,
  publishNameQuietly,
  rateLimit,
  readRegistry,
  recordAgent,
  registerDeployed,
  rpcFor,
  spendDeployTicket,
  updateAgent,
  verifyAuth,
  walletIn,
} from "../_lib/runner";
import { FundedAgent, Rail, deployRailFields, tempoEnabled } from "../_lib/tempo";
import { betaRefused } from "../_lib/beta";
import {
  LOOPS_PER_HOUR,
  LOOPS_PER_WALLET,
  LoopStartBody,
  checkLoopRequest,
  loopToolRefusal,
  planPreparedStart,
  prepareLoopStart,
  treasuryHeld,
  treasuryShortfall,
  oweAgentDeploy,
  publicLoop,
  rebuildListsFromChain,
  runningLoopsFor,
  sandboxOf,
  startLoop,
  syncScheduler,
  zeroclawReadiness,
} from "../_lib/loops";
import { agentChainView } from "../_lib/lifecycle";
import { OFFERED_TOOL_NAMES, TOOL_NAMES } from "../_lib/tools";
import { allowancePolicyHash } from "../_lib/copy";
import { asBody, bodyTooLarge, readJsonCapped } from "../rpc/proxy";
import { MAX_EXPIRATION_DAYS } from "../templates/validate";
import {
  AgentTemplateConfig,
  Template,
  appendOrMint,
  implicitTemplate,
  lookupTemplate,
  templateLink,
} from "../_lib/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * How far a prepare's `allowance.expiresAt` may sit from `expirationDays` after this server's now.
 * The wizard computes it on the browser's clock a moment before it posts, so equality would refuse
 * every honest deploy; an hour covers a badly set clock and is nothing beside a grant counted in days.
 */
const PREPARE_EXPIRY_SKEW_S = 3600;

interface Body {
  name?: string;
  policy?: Partial<DeployedPolicy>;
  /**
   * The agent's standing instruction, when the caller has one. Today the system prompt is
   * hardcoded per context (`_lib/loops.ts`, `api/run/route.ts`), so this is
   * usually absent and the implicit template's config carries no prompt key at all.
   */
  prompt?: string;
  /**
   * What the agent is for, in the deployer's words — a label the console's lists show, clamped to
   * `MAX_DESCRIPTION` and dropped when blank. Not the system prompt: that is `prompt` above, which
   * goes into the template and therefore into `policy_version_hash`.
   */
  description?: string;
  /**
   * Deploy from a template of the signer's instead of from a `policy` in this body: the record
   * links to that version and the server writes no implicit template. This is also what the
   * wizard's `×N` sends, once per copy — hence the clone allowance.
   */
  templateId?: string;
  /** Which version of it; the latest when omitted. */
  version?: number;
  /**
   * Start a separate lineage from the named template instead of extending it: the deploy mints a
   * fresh template carrying `clonedFrom: { id, version }` and the named one is left where it was.
   * Off by default, and meaningful only beside a `policy` — there is nothing to fork into without a
   * configuration.
   */
  fork?: boolean;
  auth?: SessionAuth;
  /**
   * The one-transaction deploy, in two calls that are not two transactions.
   *
   * `prepare` returns a transaction the server has already signed with the runtime key and the
   * agent's own key — funding, `register_agent` and `approve_agent` together — for the wallet to
   * sign once and broadcast. `confirm` presents the ticket and the signature it got; the server
   * reads that transaction back off the chain, checks it is the one it prepared and that this
   * wallet signed it, and only then writes the record.
   * Neither call is a transaction of its own; the chain is touched exactly once, by the browser.
   *
   * A body with neither is the two-step path: the server registers, and the wallet signs a
   * separate allowance afterwards. The API's own callers (specs, scripts) still use it. Since
   * every one of them names a positive cap and the server cannot delegate the wallet's USDC, the
   * answer carries that allowance as an unsigned `allowance.transaction` for the caller to sign
   * and send; until it lands the agent is registered and unbilled, and a loop on it runs
   * scripted. The wizard does not reach this path: its Deploy needs a budget.
   */
  prepare?: boolean;
  confirm?: string;
  /** The ticket `prepare` issued; what `confirm` presents in place of a second signature. */
  ticket?: string;
  /** Who the prepared allowance is for. Unsigned: the transaction it goes into needs that wallet's
   * signature to do anything, so claiming an address here achieves nothing but a refused deploy. */
  wallet?: string;
  /** What `prepare` needs to build the allowance instruction; micro-USDC and a unix second. */
  allowance?: { capMicroUsdc?: string; expiresAt?: string; policyVersionHash?: string };
  /**
   * *Run as agent loop*, asked for as part of the deploy rather than after it.
   *
   * Deploying and then asking the wallet for a **second** signed `"Lath loop"` message would be a
   * surprise prompt after a completed deploy, for the one flow whose headline claim is that it
   * costs one. A standing permission to keep spending is not part of a deploy, which is a real
   * distinction and not one the person signing has: the rest of the product is held to one prompt
   * per user action.
   *
   * So the deploy can carry it. The transaction the wallet signs *is* the standing permission — it
   * contains the `approve_agent` whose cap and expiry are the only thing a loop can ever spend
   * against, and `confirm` proves that wallet signed it by reading the transaction back off the
   * chain, which is a stronger authorisation than the message the second prompt collected. The
   * request is checked at `prepare`, so a loop the server would refuse is refused before anything
   * is signed, and started at `confirm`, once the agent it runs exists.
   *
   * **The console does not send it**: `/create` deploys, and a loop is started from the agent's
   * page as its own action, with its own signed message. The field stays readable for a caller of
   * this route that sends it; nothing in `frontend/src` does.
   */
  loop?: LoopStartBody;
}

/** The same shape the browser derives its id from: lowercase, and nothing that is not a name. */
function sanitize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 40);
}

/** The wallet the signed message names, before anything is verified. */
/**
 * What this server operates, as the deploy flow recorded it.
 *
 * Archived agents are not in `agents`: archiving is what hides an agent from the console's lists.
 * Their ids are listed separately because the home list is built from
 * the *chain* — `listOwnersByAuthority`, not this registry — and needs to know which of the
 * headers it found are archived. Nothing here is a secret: the registry is already public, and
 * `lookupAgent` still resolves an archived id so verification and `/api/traces` keep working.
 *
 * `?owner=<wallet>` narrows both lists to that wallet's rows, the way `GET /api/loops?owner=` and
 * `GET /api/templates?owner=` already do. It is a filter and not a gate — the route is open, and
 * the unfiltered answer contains exactly the same rows — so it adds no authorisation and removes
 * none; what it removes is the client-side filtering every caller that wants one wallet's agents
 * writes for itself (`LoopEntry`, the wizard's *taken here* check). A row without an `owner` is
 * one written before ownership was recorded and matches no wallet, which is what it is.
 *
 * No prompt is returned by either shape, and none may be added: a row carries `policy` (model,
 * tools, budget, expiry) and a `template` link, not the template's `config.prompt`. The builder's
 * prompt is shown only to the owner, and this route has no signature to tell an owner by.
 */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  // A console with no registry at all is a fresh one — a new state directory, another machine — and
  // its lists are rebuilt from the chain's lifecycle records (`_lib/loops.ts` `rebuildFromChain`),
  // waited for a few seconds so this first answer can carry them. A rebuild that fails, or is slow,
  // is logged and never fails the list: it answers what the registry holds.
  if (Object.keys(readRegistry()).length === 0) await rebuildListsFromChain().catch(() => undefined);
  const registry = readRegistry();
  const entries = Object.entries(registry).filter(([, record]) => (owner ? record.owner === owner : true));
  const live = entries.filter(([, record]) => !isArchived(record));
  // No team fields: a row does not say which running loop has it on its roster, so this open,
  // unmetered list does not read `loops.json` at all, and a stranger cannot make it parse that file.
  return Response.json({
    cluster: CLUSTER,
    // `lifecycle` is the one key of a row never served: its owed documents carry the owner's signature
    // and prompt. `chain` says the same thing in public terms — refs, the tool ids owed, the error.
    agents: live.map(([id, { lifecycle, ...record }]) => ({
      id,
      ...record,
      ...(lifecycle ? { chain: agentChainView(lifecycle) } : {}),
    })),
    archived: entries.filter(([, record]) => isArchived(record)).map(([id]) => id),
  });
}

/**
 * What a row says about the `tempo` rail. An older row may carry an address of its own and what was
 * sent to it; a current row carries neither, because the operator's treasury is the payer and no
 * agent has a wallet. Null for an agent that has neither, which is every agent this build deploys.
 */
function tempoRow(row: FundedAgent | null): Record<string, string | null> | null {
  if (!row?.tempoAddress) return null;
  return {
    address: row.tempoAddress,
    fundedBase: row.tempoFunded ?? "0",
    txHash: row.tempoFundTx ?? null,
    drainedBase: row.tempoDrained ?? null,
    drainTxHash: row.tempoDrainTx ?? null,
    note: row.tempoNote ?? null,
  };
}

/**
 * The `tempo` rail's half of a deploy, which is one field.
 *
 * There is no funding step: the treasury signs every voucher, so an agent on the rail needs nothing
 * of its own and a deploy makes no Tempo transaction at all. What is written down is the rail,
 * and — on a deployment with no treasury — why its sessions will be scripted instead. It runs
 * after the record exists and can only change that record: a deploy that landed on chain is never
 * failed by a rail.
 */
function recordRail(id: string): void {
  const row = lookupAgent(id) as FundedAgent | null;
  if (!row) return;
  const fields = deployRailFields(row.policy.payment as Rail | undefined);
  updateAgent(id, (a) => ({
    ...a,
    policy: { ...a.policy, payment: fields.payment },
    ...(fields.tempoNote ? { tempoNote: fields.tempoNote } : {}),
  }));
}

/**
 * The template version a deploy's record links to, for both branches that write one.
 *
 * Three cases:
 *
 * - `append` — the body named a template of the caller's *and* carried its own configuration, so
 *   the deploy extends that lineage: version n+1 when the config differs, the named version when
 *   it does not, a fork when the review step asked for one.
 * - a `templateId` with no configuration — the clone body, re-running a stored version. The
 *   version is the run's config and nothing is written.
 * - neither — the implicit template every run has.
 *
 * Called *after* the header is on chain, where a refusal is no longer useful: every reason
 * `appendOrMint` can refuse (missing, wrong kind, another wallet's) was already checked in `POST`
 * against the same registry. A template that disappeared in between is not worth leaving a
 * registered agent with no record over — an orphan that cannot be adopted (see `POST`) — so the
 * deploy links an implicit template and the reason is logged.
 */
function templateForDeploy(o: {
  owner: string;
  name: string;
  policy: DeployedPolicy;
  prompt?: string;
  templateId?: string;
  version?: number;
  append: boolean;
  fork: boolean;
}): Template {
  const config: AgentTemplateConfig = { ...o.policy, ...(o.prompt ? { prompt: o.prompt } : {}) };
  if (o.templateId && !o.append) {
    const named = lookupTemplate(o.templateId, o.version);
    if (named && named.kind === "agent" && named.owner === o.owner) return named;
  }
  const resolved = appendOrMint(o.owner, o.append ? o.templateId : undefined, o.version, config, {
    kind: "agent",
    name: o.name,
    fork: o.fork,
  });
  if ("error" in resolved) {
    console.warn(`[api/agents] ${o.name}: ${resolved.error}; linking an implicit template instead`);
    return implicitTemplate({ kind: "agent", owner: o.owner, name: o.name, config });
  }
  return resolved.template;
}

/**
 * The second half of a one-transaction deploy. Nothing here trusts the browser: the ticket says
 * what was authorised, the chain says whether it happened, and the record follows the chain.
 */
async function confirmDeploy(
  server: Keypair,
  ticketId: string,
  ticket: DeployTicket,
  signature: string
): Promise<Response> {
  const name = ticket.name;
  const idBytes = idFromString(name);
  const id = hex(idBytes);

  // The authorisation, and the only one: the transaction the browser says it sent is fetched from
  // the chain and has to be the message this ticket's `prepare` built, landed and successful, with
  // the ticket's wallet among its signers (`deployTxSignedBy` says what that proves). Asking only
  // whether *an allowance PDA exists* would prove nothing about who signed this deploy: any wallet
  // can create one against any authority.
  const confirmed = await confirmLandedDeploy({
    noun: "deploy",
    server,
    name,
    signature,
    ticket,
    spend: () => spendDeployTicket(ticketId),
  });
  if ("refused" in confirmed) return confirmed.refused;

  // Already recorded — a retried confirm, or two tabs. The chain is the same either way.
  const already = lookupAgent(id);
  if (already) {
    // A confirm that recorded the agent can still have lost its name to a rate limit; the
    // retry is where that gets repaired, at the cost of two reads when nothing is missing.
    await publishNameQuietly(server, idBytes, name);
    return Response.json({ id, name: already.name, authority: already.authority, signature });
  }

  // The version is written here and not at `prepare`, and that is deliberate: `prepare` records
  // nothing, so a deploy whose wallet prompt is cancelled leaves no version behind. The append
  // rides the same rule.
  const intent = { append: ticket.append === true, fork: ticket.fork === true };
  const template = templateForDeploy({
    owner: ticket.wallet,
    name,
    policy: ticket.policy,
    prompt: ticket.prompt,
    templateId: ticket.templateId,
    version: ticket.version,
    append: intent.append,
    fork: intent.fork,
  });
  recordAgent(id, {
    name,
    authority: confirmed.authority,
    owner: ticket.wallet,
    createdAt: Date.now(),
    policy: ticket.policy,
    // Absent rather than empty when the deploy named none, so a row is byte-identical to one
    // written before the field existed (`normalizeDescription`).
    ...(ticket.description ? { description: ticket.description } : {}),
    template: templateLink(template),
  });
  await publishNameQuietly(server, idBytes, name);
  // Before the loop starts: its first step reads this row to decide which rail it pays on.
  recordRail(id);
  // The `agent.deploy` record, with the transaction the wallet just signed: owed now and written under
  // the run slot (and before a loop this deploy carries takes its first step), never failing the deploy.
  oweAgentDeploy(id, signature);
  const funded = lookupAgent(id) as FundedAgent | null;

  return Response.json({
    id,
    name,
    authority: confirmed.authority,
    signature,
    payment: funded?.policy.payment ?? "vault",
    tempo: tempoRow(funded),
    ...(await startTicketLoop(ticket, id, signature)),
  });
}

/**
 * *Run as agent loop*, started on the agent this confirm just recorded — the second half of the one
 * prompt.
 *
 * The wallet's authorisation is the transaction `deployTxSignedBy` has already matched against
 * this ticket's message, and the `approve_agent` inside it is the cap the loop will spend
 * against, so there is nothing further to ask for. The hourly loop-start counter is charged here
 * rather than at prepare because this is where a schedule actually starts.
 *
 * A loop the server refuses does **not** un-deploy the agent: the deploy landed, on chain, and
 * the transaction cannot be taken back. The refusal is reported beside a deployment that stands,
 * and the person was not asked to sign for it twice. A throw is reported the same way: by then the
 * agent is recorded and the ticket spent, so an unwrapped throw would answer 500 about a deploy that
 * had landed and been recorded.
 */
async function startTicketLoop(
  ticket: DeployTicket,
  id: string,
  deployTx: string
): Promise<{ loop?: unknown; loopError?: string }> {
  if (!ticket.loop) return {};
  try {
    return await startDeployedLoop(ticket, id, deployTx);
  } catch (e: any) {
    console.error(`[api/agents] the loop for ${ticket.name} did not start:`, e);
    return { loopError: e?.message ?? String(e) };
  }
}

/** `startTicketLoop`'s body, which may throw; only `startTicketLoop` calls it. */
async function startDeployedLoop(
  ticket: DeployTicket,
  id: string,
  deployTx: string
): Promise<{ loop?: unknown; loopError?: string }> {
  if (!ticket.loop) return {};
  syncScheduler();
  const refused = rateLimit("loop starts", `loop-start:${ticket.wallet}:${ticket.caller ?? ""}`, LOOPS_PER_HOUR);
  if (refused) return { loopError: refused };
  // Prepared here, at confirm, because the loop runs the agent this deploy's transaction has just
  // recorded; every refusal a start can earn without it was already given at `prepare`, before the
  // wallet signed (`checkLoopRequest`, a roadmap feature's among them).
  const prepared = await prepareLoopStart({ ...ticket.loop, agentId: id }, ticket.wallet, { treasuryHeld });
  if ("error" in prepared) return { loopError: prepared.error };
  // The plan through `planPreparedStart`, which discards a fetch the refused or thrown plan
  // leaves behind. A deploy's loop carries no sandbox today (`prepare` refuses one), so there is
  // none to discard; routed the same way as the other two starts so that stays true if it ever does.
  const planned = planPreparedStart(prepared, ticket.wallet);
  if ("error" in planned) return { loopError: planned.error };
  // Its `loop.start` names the deploy transaction as the owner's word: the wallet signed no message.
  startLoop(planned.loop, undefined, { deployTx });
  return { loop: publicLoop(planned.loop) };
}

export async function POST(req: NextRequest) {
  const server = loadKeypair();
  if (!server || !RPC_URL) {
    return Response.json({ error: "the server has no runtime keypair or RPC configured" }, { status: 503 });
  }

  // Read whole and capped before it is parsed or any signature is looked at, so an oversized body
  // costs nothing to refuse. What does not parse, or parses to something that is not an object, is an empty body.
  const read = await readJsonCapped(req);
  if (!read) return bodyTooLarge();
  const body: Body = asBody<Body>(read.json);

  // `confirm` is the second half of a deploy this server already authorised: it carries the
  // ticket `prepare` issued, not a fresh signature. Asking the wallet to sign again would be a
  // second prompt for one deploy, and re-sending the first message is a replay the nonce guard
  // refuses — which is exactly what it is for.
  if (body.confirm) {
    const ticket = peekDeployTicket(body.ticket);
    if (!ticket) {
      return Response.json({ error: "this deploy ticket is unknown or has expired; deploy again" }, { status: 409 });
    }
    // The closed beta, again, on the wallet the ticket names — the one `confirmLandedDeploy` then
    // requires among the transaction's signers. `prepare` already asked, and a ticket comes from
    // nowhere else; this is for a wallet taken off the list in the ten minutes a ticket lives. The
    // registration has landed by now and cannot be taken back, but what a confirm still spends is
    // not small: the name record's write and, for a deploy carrying a loop, the loop's whole
    // schedule. Asked before the ticket is spent, so putting the wallet back on the list within the
    // ticket's life lets the same confirm finish.
    const closed = betaRefused(ticket.wallet);
    if (closed) return closed;
    return confirmDeploy(server, body.ticket!, ticket, body.confirm);
  }

  // A prepared deploy needs no signed message. It writes nothing, and the transaction it returns
  // is inert until the wallet signs it — which is the authorisation, in the one prompt a deploy
  // should cost. `confirm` then fetches that transaction from the chain and requires it to be the
  // message prepared here, signed by this wallet. Every other path proves the wallet with a
  // message first.
  let walletKey: PublicKey;
  if (body.prepare) {
    try {
      walletKey = new PublicKey(body.wallet ?? "");
    } catch {
      return Response.json({ error: "a wallet address is required to prepare a deploy" }, { status: 400 });
    }
  } else {
    const verified = verifyAuth(
      body.auth,
      body.auth ? walletIn(body.auth.message) : null,
      "Lath deploy",
      {
        action: "deploy",
        target: sanitize(body.name ?? ""),
      },
      consoleOrigin(req)
    );
    if (!("wallet" in verified)) {
      return Response.json({ error: `a wallet signature is required to deploy: ${verified.reason}` }, { status: 401 });
    }
    walletKey = verified.wallet;
  }
  const wallet = walletKey.toBase58();

  // The closed beta (`_lib/beta.ts`), for both branches and before every other check: a `prepare`
  // is refused before the wallet is asked to sign anything, and the signed branch before the server
  // registers and funds an agent out of its own SOL. First, so the already-deployed answer — whose
  // signed form re-publishes a missing name on the server's SOL — is behind it too. `prepare` names
  // its wallet unsigned, so naming an invited one gets a stranger a transaction only that wallet
  // can sign, and `confirm` asks again on the wallet that did.
  const closed = betaRefused(wallet);
  if (closed) return closed;

  const caller = callerIp(req);
  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";

  // The wizard enforces this on the step that owns the name, but the wizard is not the only
  // caller and an id is spent for good once its header lands: an empty body prepared a real
  // transaction registering `sha256("")` on the cluster, permanently, under roles named
  // `-coordinator`/`-sentinel`/`-verifier`. Three is the floor `_lib/copy.ts` already applies to
  // a clone's name, so the deploy and copy paths now agree about what a name is.
  const name = sanitize(body.name ?? "");
  if (name.length < 3) {
    return Response.json({ error: "a name needs at least 3 characters the id can be taken from" }, { status: 400 });
  }

  // The config is the template's when one is named, and this body's otherwise. A template is
  // only deployable by the wallet that wrote it: it is the owner's document, and a run from it
  // spends the operator's SOL under that owner's name.
  //
  // A `templateId` beside a configuration of its own is the builder's *start from this and edit*:
  // the body is the config, the template is what it appends to, and the new agent points at the
  // version this deploy writes. A `templateId` with no configuration is the clone body — re-run the
  // stored version — and is untouched by any of this.
  const hasConfig = body.policy !== undefined || typeof body.prompt === "string";
  const appending = !!templateId && hasConfig;
  const fork = body.fork === true;
  if (fork && !appending) {
    return Response.json(
      { error: "fork needs a templateId and a policy to fork into: send the configuration with it" },
      { status: 400 }
    );
  }
  const source = templateId ? lookupTemplate(templateId, body.version) : null;
  if (templateId) {
    if (!source) {
      const which = body.version === undefined ? templateId : `${templateId} v${body.version}`;
      return Response.json({ error: `no template ${which}` }, { status: 404 });
    }
    if (source.kind !== "agent") return Response.json({ error: `${templateId} is a loop template` }, { status: 400 });
    if (source.owner !== wallet)
      return Response.json({ error: `${templateId} belongs to another wallet` }, { status: 403 });
    // An archived template refuses a *re-run* and accepts an *append*: writing a new version is
    // precisely what this refusal tells the owner to do, and the version this deploy carries is
    // that write. What stays refused is starting the archived config again unchanged.
    if (source.archivedAt && !appending) {
      return Response.json(
        { error: `${templateId} is archived; write a new version to deploy from it` },
        { status: 409 }
      );
    }
  }
  // Appending, the body is the configuration; otherwise the named template's config is.
  const asked = (
    appending ? body.policy ?? {} : source?.kind === "agent" ? source.config : body.policy ?? {}
  ) as Partial<AgentTemplateConfig>;

  // A deploy from a `templateId` has been through `templates/validate.ts`; one from a raw
  // `body.policy` has been through nothing, and both numbers are read back later by a path that
  // cannot refuse. `copyContext` computes `BigInt(Math.round(Number(budgetCapUsdc) * 1e6))` from
  // the *record*, outside its caller's `try`, so `"abc"` deployed here would become a `RangeError`
  // and an unhandled 500 on every later clone. `expirationDays: 0` survives `??` and makes a copy's
  // `expiresAt` equal to now, which `approve_agent`'s `require!(expires_at > now)` rejects on chain,
  // so the whole transaction reverts and the operator pays for the failure. Refused here, where
  // there is still a person to tell.
  const capUsdc = Number(asked.budgetCapUsdc ?? "1.00");
  if (!Number.isFinite(capUsdc) || capUsdc <= 0) {
    return Response.json({ error: "policy.budgetCapUsdc must be a positive number of USDC" }, { status: 400 });
  }
  const days = Number(asked.expirationDays ?? MAX_EXPIRATION_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRATION_DAYS) {
    return Response.json(
      { error: `policy.expirationDays must be a whole number of days between 1 and ${MAX_EXPIRATION_DAYS}` },
      { status: 400 }
    );
  }

  const policy: DeployedPolicy = {
    model: asked.model && MODELS.has(asked.model) ? asked.model : "deepseek/deepseek-v4.1-flash",
    tools: Array.isArray(asked.tools) ? asked.tools.map(String).slice(0, 16) : [],
    budgetCapUsdc: String(asked.budgetCapUsdc ?? "1.00"),
    // No expiry unless one was asked for: the cap is the bound that matters, and an allowance
    // that lapses unannounced is the worse surprise. `MAX_EXPIRATION_DAYS` is the hundred-year
    // grant the billing program needs in place of a "never" sentinel.
    expirationDays: days,
    // How this agent's inference is paid for, decided here per agent and not per process: `tempo`
    // only where this server holds the key *and* has a treasury, and **nothing** where it does not
    // — a deployment whose sessions no one can pay for records no rail, which is what an older chain
    // with no rail carries and what an explicit `vault` is normalised to before hashing. The form's
    // own answer is read for the note `deployRailFields` writes and decides nothing.
    // (`recordRail` writes the note itself once the header is on chain.)
    payment: deployRailFields((asked as { payment?: Rail }).payment).payment,
  };
  // A name the runtime does not ship would be dropped at session time; refusing it here keeps
  // the stored allow-list equal to what the agent will actually have.
  // The prompt belongs to the template, not to the record: nothing on chain commits to it yet.
  const rawPrompt = appending ? body.prompt : source?.kind === "agent" ? source.config.prompt : body.prompt;
  const prompt = typeof rawPrompt === "string" && rawPrompt.trim() ? rawPrompt.trim().slice(0, 2000) : undefined;
  // The label, from this body only: a description belongs to the agent a person is deploying, not
  // to the template it was deployed from, so N copies of one template are still told apart by it.
  const description = normalizeDescription(body.description);
  const unknown = policy.tools.filter((t) => !TOOL_NAMES.includes(t));
  if (unknown.length) {
    return Response.json(
      { error: `unknown tools: ${unknown.join(", ")}; the runtime ships ${OFFERED_TOOL_NAMES.join(", ")}` },
      { status: 400 }
    );
  }

  const idBytes = idFromString(name);
  const id = hex(idBytes);

  // Already deployed here: the same name derives the same keys, so this is the same agent.
  //
  // `existing` means *your* agent is already here. For anyone else it is a taken name, and answering
  // them with success too would show *Agent deployed* for a deploy that had dropped their policy,
  // prompt and cap without a word, and make the wizard's step-1 promise that "a deploy will still
  // refuse it if it is taken" false exactly when that check had errored. So another wallet's name is
  // a refusal — no id, no authority, no `existing` key — and a row written before owners were
  // recorded matches no wallet, which is what it is. It comes before the ceiling and the counters, so a
  // taken name costs the caller nothing.
  //
  // `prepare` takes its wallet unsigned, so a caller who names the owner's own address still gets
  // `existing: true`. That answer carries only what `GET /api/agents` already publishes; `owner`
  // is in it so the wizard can tell the person whether the agent is theirs.
  const existing = lookupAgent(id);
  if (existing) {
    if (existing.owner !== wallet) {
      return Response.json(
        {
          error: existing.owner
            ? `${name} is already deployed here by another wallet; pick another name`
            : `${name} was deployed here before ownership was recorded; pick another name`,
        },
        { status: 409 }
      );
    }
    // The published name is repaired on the signed branch only. It is a chain write this server pays
    // for, and an unsigned `prepare` naming the owner's wallet — anyone can — would otherwise buy one
    // per call, ahead of the ceiling and every counter. The prepare answer is the same
    // either way and the wizard's taken-name check reads the header, not the name record, so its
    // flow does not change and no prompt is added; a message-signed deploy of the same name
    // still repairs a name that is missing.
    if (!body.prepare) {
      try {
        const key = deployedRoles(server, name).agent.key;
        await publishDeployedName(LathClient.fromIdl(rpcFor(), key), idBytes, existing.name);
      } catch {
        /* the deployment still stands; only its published name is missing */
      }
    }
    return Response.json({
      id,
      name: existing.name,
      authority: existing.authority,
      owner: existing.owner,
      signature: null,
      existing: true,
    });
  }

  // A prepare's loop — its terms, and whether this console can run it at all — is a refusal that
  // creates nothing, so it is checked before the ceiling and the hourly counter below, as the name
  // and the tools are: a deploy-with-loop refused because this console has no ZeroClaw must not spend
  // one of the hour's prepares and one of the wallet's deploys. The allowance is parsed after them.
  if (body.prepare) {
    // The loop, checked before anything is signed. Checking it here is what makes the prompt
    // honest: a deploy that offers a loop it will then refuse would be a completed deploy with a
    // failure note. So everything knowable without the
    // agent is checked here — the request's own numbers, and the two limits that need only the
    // wallet. What genuinely has to wait for `planLoopStart` at confirm is the three that need
    // the agent to exist: it is yours, it is not archived, it has no loop already.
    if (body.loop) {
      // A deploy's loop is the typed config and never a stored template. `planLoopStart` resolves
      // a `templateId` to *that template's* coordinator and discards the `agentId` `confirmDeploy`
      // injects, so a ticket carrying one would start a billed schedule on a pre-existing agent while
      // the agent the wallet had just paid for got none. It would also break the reason a deploy may
      // carry a loop at all: the signed transaction is the standing permission only if the loop
      // spends the `approve_agent` inside it, and a loop on another agent spends an allowance from
      // some other transaction.
      if (body.loop.templateId) {
        return Response.json(
          { error: "a deploy's loop is its own config; start one from a template after the agent exists" },
          { status: 400 }
        );
      }
      // Nor does it carry a sandbox. A sandbox's sources are fetched by the host at start, into the
      // loop's directory, on the server's network and the operator's time — and here that start is
      // a confirm the wallet has already paid for, so a source that refuses would be a landed
      // deploy with a failure note, the outcome the paragraph above exists to prevent. A loop is
      // its own action, and the loop form, which offers _Check sources_ before its one signature,
      // is where a sandbox is added.
      if (sandboxOf(body.loop) != null) {
        return Response.json(
          { error: "a deploy's loop is its own config; add a sandbox when you start the loop" },
          { status: 400 }
        );
      }
      const checked = checkLoopRequest(
        { ...body.loop, agentId: id, model: body.loop.model ?? policy.model },
        policy.model,
        // The wallet, so a term that names somebody else's agents is refused here and not after the
        // deploy has landed: ownership is one of the things knowable without the agent, and this is
        // the paragraph above's rule applied to the loop's terms.
        walletKey.toBase58()
      );
      if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
      // The tools this agent's policy names, against the sandbox every step runs in — the check
      // `checkLoopStart` makes at confirm, asked here before the signature (`loopToolRefusal`).
      // Unasked here, a deploy carrying a loop with a `web.*` tool would be signed for, land, and
      // answer `loopError`. The policy is known now: it is the one this prepare's ticket will record.
      const tools = loopToolRefusal(policy.tools, name, checked);
      if (tools) return Response.json({ error: tools }, { status: 400 });
      // `LOOPS_PER_WALLET` needs nothing but the wallet, so leaving it to confirm would mean a wallet
      // already at its ceiling signs, pays, and is handed `loopError` beside a deploy that has
      // landed — exactly the outcome the paragraph above says this check exists to prevent.
      if (runningLoopsFor(walletKey.toBase58()).length >= LOOPS_PER_WALLET) {
        return Response.json(
          { error: `this wallet already has ${LOOPS_PER_WALLET} loops running; stop one first` },
          { status: 429 }
        );
      }
      // Whether this console can run a loop step at all — a Lath-patched binary that answers and a
      // wrapper that starts — asked here because `POST /api/loops` is not on this path, and without
      // it the wallet would sign, the deploy land, and the loop's first step be refused with this
      // very reason. Same status and body as `/api/loops`, so a
      // caller reads one refusal whichever route it started from. After the loop's own checks, so
      // a request that is wrong in itself is told so on any console; `planLoopStart` asks again at
      // confirm, for a binary removed between the two calls. There is no in-process fallback.
      const sandbox = zeroclawReadiness();
      if ("reason" in sandbox) return Response.json({ error: sandbox.reason }, { status: 503 });
      // Whether the treasury can hold the deposit this run opens with. `prepareLoopStart` asks it
      // again at confirm, but by then the wallet has signed and the agent has landed, and a
      // shortfall there is a deploy with a `loopError`. Last among the loop's checks because it is the
      // one that reads a network, and only on a console that bills over Tempo at all.
      if (tempoEnabled()) {
        const short = treasuryShortfall(checked, await treasuryHeld());
        if (short) return Response.json({ error: short }, { status: 409 });
      }
    }
  }

  // The allowance a prepare signs for, parsed **before** any counter is charged. Parsed after them,
  // `{"prepare":true,"name":"aaa","wallet":<any key>}` with no allowance — a 400 that builds nothing
  // and touches no RPC — would spend one of the server's 200 prepares an hour, and 200 of them would
  // refuse every honest deploy and clone on the box for the hour, at no cost.
  // Inside its own guard: `BigInt("1.5")` throws, and a malformed number in the body is a 400 about
  // the field, not a 500 about the server.
  //
  // Held to the policy this prepare's ticket records, not taken as sent. The record claims
  // `budgetCapUsdc` and `expirationDays`, and a grant carrying any other cap, expiry or hash would be
  // a wallet signing one thing while the console stored another. So the cap and the hash are derived
  // as the message-signed branch below derives them, and the body's must equal them: the wizard
  // checks the prepared transaction against its own numbers before the prompt, so the server's
  // cannot simply replace them. The expiry is the one figure the browser's clock picks, so it is
  // held to the policy's days within `PREPARE_EXPIRY_SKEW_S` rather than to the second.
  let grant: { cap: bigint; expiresAt: bigint; policyVersionHash: Uint8Array } | null = null;
  if (body.prepare) {
    let askedCap: bigint;
    let expiresAt: bigint;
    try {
      askedCap = BigInt(body.allowance?.capMicroUsdc ?? "0");
      expiresAt = BigInt(body.allowance?.expiresAt ?? "0");
    } catch {
      return Response.json(
        { error: "allowance.capMicroUsdc and allowance.expiresAt must be whole numbers" },
        { status: 400 }
      );
    }
    if (askedCap <= 0n) {
      return Response.json({ error: "a one-transaction deploy needs an allowance to sign for" }, { status: 400 });
    }
    let askedHash: Uint8Array;
    try {
      askedHash = Uint8Array.from(Buffer.from(body.allowance?.policyVersionHash ?? "", "hex"));
      if (askedHash.length !== 32) throw new Error("not 32 bytes");
    } catch {
      return Response.json({ error: "allowance.policyVersionHash must be 32 bytes of hex" }, { status: 400 });
    }
    const cap = BigInt(Math.round(capUsdc * 1e6));
    if (askedCap !== cap) {
      return Response.json(
        { error: `allowance.capMicroUsdc is ${askedCap}, but this policy's budgetCapUsdc is ${cap} µUSDC` },
        { status: 400 }
      );
    }
    const policyVersionHash = allowancePolicyHash({
      model: policy.model,
      tools: policy.tools,
      capMicroUsdc: cap,
      payment: policy.payment,
      prompt,
    });
    if (hex(askedHash) !== hex(policyVersionHash)) {
      return Response.json(
        { error: `allowance.policyVersionHash is not this policy's hash, ${hex(policyVersionHash)}` },
        { status: 400 }
      );
    }
    const due = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
    const skew = BigInt(PREPARE_EXPIRY_SKEW_S);
    if (expiresAt < due - skew || expiresAt > due + skew) {
      return Response.json(
        { error: `allowance.expiresAt is ${expiresAt}, not this policy's ${days} days from now (${due})` },
        { status: 400 }
      );
    }
    grant = { cap, expiresAt, policyVersionHash };
  }

  // The hourly counters, charged **last**: after the name, the template, the tools, the
  // already-deployed check and the allowance, every one of which is a refusal that creates nothing.
  // Charged first, a typo, a name someone already took or a body with an unknown tool would each
  // spend one of the hour's deploys without a chain write anywhere near it.
  //
  // "Last" means last *among the refusals this server can make by itself*. A wallet prompt the
  // person then cancels is still charged, and has to be: what this bounds is broadcastable
  // transactions, and the operator pays for one the moment it lands, which is not a moment this
  // route is present for. `copyContext` says the whole of it.
  //
  // A deploy from a template is the clone path, and clones have their own hourly allowance: N
  // copies of one template is what that flow is for, and it must not spend the deploy budget.
  // Keyed on the caller's address as well as the wallet. `prepare` takes an
  // unsigned `wallet`, so a bucket keyed on the wallet alone is a bucket anyone can empty: naming
  // someone else's address a few times an hour would leave them unable to deploy. An attacker's
  // own address gets its own bucket instead — which is fair use, and is **not** a bound on an
  // attacker, who simply takes a fresh address each time.
  //
  // In order, narrowest first: this wallet's bucket, then the caller's address across every
  // prepare, then the server's ceiling (`prepareCeiling`). The server's is last because it is
  // the one a single caller must not be able to spend for everybody; all three are asked before any
  // is stamped, so a refusal by one spends none of the others.
  //
  // Both branches, not just `prepare`. A signed message is a signature by a key the caller minted
  // a moment ago, so the wallet in the bucket key rotates exactly as freely as the unsigned one a
  // prepare names — and this branch's costs are the larger pair: `ensureFunded` sends
  // `CHILD_TOPUP_SOL` from the runtime key and `register_agent` spends an `agent_id` for good.
  // The rotation argument the `prepare` ceiling was written for is the same argument here.
  const refused = prepareCeiling(
    caller,
    templateId
      ? { what: "clones", key: `clone:${wallet}:${caller}`, perHour: CLONES_PER_HOUR }
      : { what: "deploys", key: `deploy:${wallet}:${caller}`, perHour: DEPLOYS_PER_HOUR }
  );
  if (refused) return Response.json({ error: refused }, { status: 429 });

  // ── The one-transaction deploy ───────────────────────────────────────────
  //
  // `prepare` writes nothing and records nothing: it hands back a transaction and a ticket. The
  // record is written by `confirm`, and only for a header the chain really has.
  if (grant) {
    try {
      const prepared = await prepareDeployTx(server, name, { wallet: walletKey, ...grant });
      if ("conflict" in prepared) return Response.json({ error: prepared.conflict }, { status: 409 });
      // The message stays here; the browser gets the transaction it is inside of.
      const { message, ...wire } = prepared;
      const ticket = issueDeployTicket({
        wallet,
        name,
        message,
        policy,
        prompt,
        description,
        templateId: templateId || undefined,
        // The version *resolved*, not the one asked for: `undefined` means "latest", and a PUT
        // between prepare and confirm would otherwise link the record to a version whose config
        // is not the `policy` this ticket was issued for.
        version: source ? source.version : body.version,
        loop: body.loop,
        caller,
        // What this deploy meant by its `templateId`, held for `confirm` and written by it. Nothing
        // is recorded here: a version for a transaction the wallet never signs would be a lineage
        // entry for a deploy that never happened.
        append: appending,
        fork,
      });
      return Response.json({ ...wire, ticket });
    } catch (e: any) {
      console.error("[api/agents] prepare failed:", e);
      return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
    }
  }

  /**
   * The evidence this branch was missing: somebody paid.
   *
   * `prepare` ends in a transaction the wallet signs, carrying the `approve_agent` that is how
   * this server gets paid for what it is about to run. This branch ends in a `register_agent`
   * the *server* signs and sends, funded out of the runtime key, with the allowance left as an
   * unsigned transaction the caller may simply never broadcast. So the one thing it
   * asks for is the one thing a fresh keypair does not come with: USDC in the treasury's escrow,
   * under the wallet that signed. A signature proves a key; a deposit proves a payer.
   *
   * `null` means this deployment has no treasury and therefore no way to be paid at all — then
   * the ceiling above is the whole bound.
   */
  const escrow = await escrowFor(rpcFor(), walletKey, server);
  if (escrow !== null && escrow <= 0n) {
    return Response.json(
      {
        error:
          `${wallet} has no USDC in this treasury's escrow. A deploy on this path registers a terminal ` +
          `agent id and funds its key out of the operator's SOL, so it is open to wallets that can pay ` +
          `for what they run: deposit at /billing and deploy again, or use the one-transaction deploy, ` +
          `whose \`approve_agent\` is the allowance itself.`,
      },
      { status: 402 }
    );
  }

  try {
    const registered = await registerDeployed(server, name);
    if ("conflict" in registered) return Response.json({ error: registered.conflict }, { status: 409 });

    // A header that was already on chain under *our own* derived key, with no record here, is an
    // orphan: a deploy whose transaction landed and whose confirm never did. It must not be
    // adoptable. `registerDeployed` treats it as success and returns a null signature, and writing
    // `owner: wallet` here would make the first wallet to post this name the owner of a chain
    // someone else had paid to register, and `owner` is the whole authorisation
    // root for sessions, loops, clone, useVersion, archive and publish. `existing` above cannot
    // catch it, because the orphan is precisely the case where there is no record to find.
    //
    // Nothing on chain names the wallet that funded the registration — the authority is this
    // server's derived key, and an allowance PDA can be opened against any authority by anyone
    // — so there is no evidence that would let the rightful owner be told from a claimant. Refusing
    // both is the only answer that is not a takeover, and recovering such an orphan stays open.
    if (!registered.signature) {
      return Response.json(
        {
          error:
            `${name} is registered on ${CLUSTER} but this console has no record of it, so it cannot be ` +
            `adopted — the wallet that deployed it cannot be told from any other. Deploy under another name.`,
        },
        { status: 409 }
      );
    }

    // Every run has a template, and which one is `templateForDeploy`'s
    // three cases: the version this deploy appended, the version it named, or an implicit one.
    const template = templateForDeploy({
      owner: wallet,
      name,
      policy,
      prompt,
      templateId: templateId || undefined,
      version: source ? source.version : body.version,
      append: appending,
      fork,
    });

    recordAgent(id, {
      name,
      authority: registered.authority,
      owner: wallet,
      createdAt: Date.now(),
      policy,
      ...(description ? { description } : {}),
      template: templateLink(template),
    });
    recordRail(id);
    // The `agent.deploy` record. This path's registration is the server's own transaction, so the
    // record names no `deployTx`.
    oweAgentDeploy(id);

    // The half of the deploy this path cannot sign for. The record above claims `budgetCapUsdc`,
    // and without this the claim would be false for every terminal deploy: the header lands, the
    // allowance never exists, and the first loop step runs unbilled and therefore scripted. The
    // transaction is the same `approve_agent` the browser's deploy carries, committing to the
    // same policy hash the wizard shows for this config — `allowancePolicyHash`, shared with a
    // clone. That is *not* the hash the agent's genesis writes: a session commits its own ceiling as
    // `maxCost`, the grant the whole cap. `payment` is in it because the wizard's and the clone's
    // are; leaving it out would make a `tempo` agent deployed from a script commit a grant no other
    // deploy path of the same config would.
    // Built after the record so a blockhash that cannot be fetched leaves a deploy that stands
    // with `allowance: null` and a note, not a 500 about an agent that is already on chain.
    let allowance: PreparedAllowance | null = null;
    let allowanceNote: string | undefined;
    try {
      const cap = BigInt(Math.round(capUsdc * 1e6));
      allowance = await prepareAllowanceTx(server, name, {
        wallet: walletKey,
        cap,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + days * 86400),
        policyVersionHash: allowancePolicyHash({
          model: policy.model,
          tools: policy.tools,
          capMicroUsdc: cap,
          payment: policy.payment,
          prompt,
        }),
      });
    } catch (e: any) {
      allowanceNote = `the allowance could not be prepared: ${e?.message ?? String(e)}; grant one at /agent/${id}`;
      console.warn("[api/agents] allowance not prepared for", name, e);
    }

    const funded = lookupAgent(id) as FundedAgent | null;
    return Response.json({
      id,
      name,
      authority: registered.authority,
      signature: registered.signature,
      allowance,
      payment: funded?.policy.payment ?? policy.payment,
      tempo: tempoRow(funded),
      ...(allowanceNote ? { allowanceNote } : {}),
    });
  } catch (e: any) {
    console.error("[api/agents] deployment failed:", e);
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
