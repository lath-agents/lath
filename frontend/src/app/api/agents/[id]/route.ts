/**
 * What an owner can do to a deployed agent after it exists: clone it, point it at another
 * version of its template, archive it, bring it back.
 *
 * None of them is a chain write on the agent itself, and that is the point of the split: the
 * chain is append-only, so *edit* and *delete* can only ever mean something off-chain. A clone is
 * a new name and therefore a new chain (`agent_id = sha256(name)`); `useVersion` changes what the
 * *next* session commits in `policy_version_hash` and nothing that is already on chain; archiving
 * hides the record and refuses new sessions while the header, the `NameRecord` and the allowance
 * stay exactly where they are, so every trace it wrote still verifies — and `unarchive` undoes
 * exactly that, because putting something away is not deleting it and a one-way button is a
 * delete by another name.
 *
 * `GET` is open, like `GET /api/agents` — the registry is public and the chain is the record of
 * truth. `useVersion`, `archive` and `unarchive` are owner-signed with `"Lath agent"`, their own
 * purpose so a signature given to edit a record cannot be replayed as one that spends SOL.
 *
 * `clone` is different, because it is the one action here that touches a chain. It is a
 * `prepare`/`confirm` pair over the same transaction the wizard's deploy uses (`_lib/copy.ts`,
 * `prepareDeployTx`): funding, `register_agent` and `approve_agent` in one transaction the wallet
 * signs once. A clone made by signing a `"Lath deploy"` message and letting the server register on
 * its say-so would leave the copy with **no allowance** — the registered, funded and unpayable
 * state the one-transaction deploy exists to make unrepresentable — and the agent page offers no
 * way to grant one. So there is no message-signed clone: a clone always has a budget to sign for,
 * because it copies one.
 *
 * Under the closed beta (`_lib/beta.ts`) only `clone` is gated, at its `prepare` and its `confirm`:
 * it is the one action here the server's SOL pays for. `useVersion`, `archive` and `unarchive`
 * edit an off-chain record, so an owner taken off the list can still put an agent away — which also
 * stops its loops.
 */
import { NextRequest } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import { idFromString } from "@lath/sdk";
import {
  DeployedAgent,
  RPC_URL,
  SessionAuth,
  archiveAgent,
  callerIp,
  confirmLandedDeploy,
  consoleOrigin,
  deployTxSignedBy,
  isArchived,
  loadKeypair,
  lookupAgent,
  prepareCeiling,
  prepareDeployTx,
  publishNameQuietly,
  unarchiveAgent,
  updateAgent,
  verifyAuth,
  walletIn,
} from "../../_lib/runner";
import type { AgentView } from "../../../../types/agent";
import {
  CopyTicket,
  cloneContext,
  cloneNote,
  issueCloneTicket,
  peekCloneTicket,
  publicCopyConfig,
  recordCopy,
  spendCloneTicket,
} from "../../_lib/copy";
import { templateLink, templateVersions, useVersionContext } from "../../_lib/templates";
import { oweAgentDeploy, oweAgentMark, readLoops, stopLoop } from "../../_lib/loops";
import { asBody, bodyTooLarge, readJsonCapped } from "../../rpc/proxy";
import { betaRefused } from "../../_lib/beta";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  action?: "clone" | "useVersion" | "archive" | "unarchive";
  /** `clone`: the new agent's name. A clone is a new name because the id is the hash of one. */
  name?: string;
  /** `useVersion`: which version of the record's own template to point at. */
  version?: number;
  auth?: SessionAuth;
  /** `clone`, the two halves of its one transaction. A clone with neither is refused. */
  prepare?: boolean;
  confirm?: string;
  ticket?: string;
  /**
   * `clone`: who the prepared allowance is for. Unsigned, like the deploy route's:
   * the transaction it goes into is inert until that wallet signs it, so claiming an address
   * here buys nothing but a refused clone. `confirm` is where the signature is proved.
   */
  wallet?: string;
}

/** The wallet the signed message names, before anything is verified. */
/**
 * What the browser reads about one deployed agent, plus what its template offers. No team fields:
 * which running loop has an agent on its roster, and whose cap pays for it, are a team's, and teams
 * are not in this build.
 */
function publicAgent(id: string, record: DeployedAgent): AgentView {
  const versions = record.template ? templateVersions(record.template.id) : [];
  const latest = versions[versions.length - 1];
  return {
    id,
    name: record.name,
    authority: record.authority,
    owner: record.owner ?? null,
    createdAt: record.createdAt,
    policy: record.policy,
    template: record.template ?? null,
    /** The template's display name and newest version, so the page can offer *use version n*. */
    templateName: latest?.name ?? null,
    latestVersion: latest?.version ?? null,
    templateArchived: !!latest?.archivedAt,
    clonedFrom: record.clonedFrom ?? null,
    archivedAt: record.archivedAt ?? null,
    tempoAddress: record.tempoAddress ?? null,
    tempoFunded: record.tempoFunded ?? null,
    tempoFundTx: record.tempoFundTx ?? null,
    tempoNote: record.tempoNote ?? null,
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const record = lookupAgent(id);
  // An archived agent still answers here: the page has to be able to say it is archived, and
  // verification of what it wrote must not depend on the console's lists.
  if (!record) return Response.json({ error: `no agent ${id} was deployed here` }, { status: 404 });
  return Response.json({ agent: publicAgent(id.toLowerCase(), record) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = raw.toLowerCase();

  // Read whole and capped before it is parsed or any signature is looked at, so an oversized body
  // costs nothing to refuse. What does not parse, or parses to something that is not an object, is an empty body.
  const read = await readJsonCapped(req);
  if (!read) return bodyTooLarge();
  const body: Body = asBody<Body>(read.json);

  // `confirm` is the second half of a clone this server already planned: it carries the ticket
  // `prepare` issued, not a fresh signature. The ticket says which wallet was checked as the
  // source's owner, and the chain says whether that wallet signed the transaction this server
  // built — which is why there is no `auth` on this path and no second prompt.
  if (body.confirm) {
    const server = loadKeypair();
    if (!server || !RPC_URL) {
      return Response.json({ error: "the server has no runtime keypair or RPC configured" }, { status: 503 });
    }
    const ticket = peekCloneTicket(body.ticket);
    if (!ticket) {
      return Response.json({ error: "this clone ticket is unknown or has expired; clone again" }, { status: 409 });
    }
    // The closed beta, again, on the ticket's wallet, for one taken off the list since its
    // `prepare`: the deploy's confirm says why it is asked here and before the ticket is spent.
    const closed = betaRefused(ticket.wallet);
    if (closed) return closed;
    return confirmClone(server, body.ticket!, ticket, body.confirm);
  }

  const action = body.action;
  if (action !== "clone" && action !== "useVersion" && action !== "archive" && action !== "unarchive") {
    return Response.json({ error: 'action is one of "clone", "useVersion", "archive", "unarchive"' }, { status: 400 });
  }

  const record = lookupAgent(id);
  if (!record) return Response.json({ error: `no agent ${id} was deployed here` }, { status: 404 });

  // A prepared clone needs no signed message. It writes nothing, and the transaction it returns
  // is inert until the wallet signs it — which is the authorisation, in the one prompt a copy
  // should cost. The ownership check runs against the claimed wallet and `confirm` proves it.
  if (action === "clone") return prepareClone(id, record, body, callerIp(req));

  const verified = verifyAuth(
    body.auth,
    body.auth ? walletIn(body.auth.message) : null,
    "Lath agent",
    {
      action,
      target: id,
    },
    consoleOrigin(req)
  );
  if (!("wallet" in verified)) {
    return Response.json({ error: `a wallet signature is required: ${verified.reason}` }, { status: 401 });
  }
  const wallet = verified.wallet.toBase58();
  // Records made before ownership was recorded have no owner, so there is nobody who can prove
  // they may edit them; they have to be redeployed, as a session on one does.
  if (record.owner !== wallet) {
    return Response.json(
      { error: record.owner ? `${record.name} belongs to another wallet` : `${record.name} has no recorded owner` },
      { status: 403 }
    );
  }

  if (action === "archive") return archive(id, record, body.auth);
  if (action === "unarchive") return unarchive(id, record, body.auth);
  return useVersion(id, record, body.version);
}

/**
 * Stops the agent's loops and sets `archivedAt`. The loops go first: a schedule left running
 * would keep spending on an agent the console no longer lists, and a paused one would only be
 * resumable into a session the server now refuses. A step already in flight finishes and writes
 * its checkpoint — `stopLoop` cancels the next one, never a write in progress.
 */
function archive(id: string, record: DeployedAgent, auth?: SessionAuth) {
  const stopped: string[] = [];
  for (const loop of Object.values(readLoops())) {
    // A rebuilt row is not this console's to stop (`stopLoop` leaves it as the chain has it).
    if (loop.agentId !== id || loop.status === "stopped" || loop.lifecycle?.rebuilt) continue;
    // The owner's archive is the owner's stop, with the signature it was posted with.
    stopLoop(loop.id, "agent archived", undefined, undefined, { by: "owner", auth });
    stopped.push(loop.id);
  }
  const wasArchived = isArchived(record);
  const after = archiveAgent(id);
  // The mark on chain, once: archiving twice keeps the first stamp, and so the first record.
  if (!wasArchived) oweAgentMark(id, "agent.archive", auth);
  return Response.json({
    agent: publicAgent(id, after ?? record),
    stoppedLoops: stopped,
    note:
      "Archived off-chain: the header, the published name and the allowance stay, every trace it wrote still " +
      "verifies, and the console refuses new sessions on it. Unarchive brings it back.",
  });
}

/**
 * Takes the stamp off again. Archive is *not deletion*, and without a verb to undo it that would be
 * true only of the record: one click would be final for an agent the way a new version is the only
 * way back for a template. So it is one verb on all three.
 *
 * The loops archiving stopped are **not** restarted. They were stopped with a reason on the
 * record and each one is a schedule of billed sessions; a button that quietly put hours of
 * spending back on the clock would be a worse surprise than the one this fixes. The answer says
 * which ones to look at.
 */
function unarchive(id: string, record: DeployedAgent, auth?: SessionAuth) {
  if (!isArchived(record)) {
    return Response.json({ error: `${record.name} is not archived`, agent: publicAgent(id, record) }, { status: 409 });
  }
  const stopped = Object.values(readLoops())
    .filter((l) => l.agentId === id && l.stopReason === "agent archived")
    .map((l) => l.id);
  const after = unarchiveAgent(id);
  oweAgentMark(id, "agent.unarchive", auth);
  return Response.json({
    agent: publicAgent(id, after ?? record),
    stoppedLoops: stopped,
    note: stopped.length
      ? `Back in the lists, and sessions on it are accepted again. ${stopped.length} loop` +
        `${stopped.length === 1 ? " it" : "s they"} stopped when it was archived ` +
        `${stopped.length === 1 ? "is" : "are"} still stopped; start ${stopped.length === 1 ? "it" : "them"} again ` +
        `if you want the schedule back.`
      : "Back in the lists, and sessions on it are accepted again.",
  });
}

/**
 * Points the record at another version of its own template. Nothing on chain changes now: the
 * next session commits the new `policy_version_hash`, and a version that only moved the budget
 * cap or the expiry changes no hash at all.
 */
function useVersion(id: string, record: DeployedAgent, version: number | undefined) {
  const resolved = useVersionContext(record.template, version);
  if ("error" in resolved) {
    // The route keeps the agent's name in the one sentence that is about the agent rather than
    // about the template.
    const error = resolved.status === 409 && !record.template ? `${record.name} ${resolved.error}` : resolved.error;
    return Response.json({ error }, { status: resolved.status });
  }
  const wanted = resolved.template;
  const after = updateAgent(id, (a) => ({
    ...a,
    // The record's `policy` is the pointer to the version in use, so it moves with the link.
    policy: {
      model: wanted.config.model,
      tools: wanted.config.tools,
      budgetCapUsdc: wanted.config.budgetCapUsdc,
      expirationDays: wanted.config.expirationDays,
      // A version that names no rail keeps the one the agent already pays on: moving the link must
      // not move the agent off `tempo` as a side effect.
      ...(wanted.config.payment ?? a.policy.payment ? { payment: wanted.config.payment ?? a.policy.payment } : {}),
    },
    template: templateLink(wanted),
  }));
  return Response.json({
    agent: publicAgent(id, after ?? record),
    note:
      `Linked to v${wanted.version}. Nothing on chain changed: the next session commits the new policy ` +
      `version hash, and a version that only moved the budget cap or the expiry commits the same hash as before.`,
  });
}

/**
 * The first half of a clone: a transaction, and a ticket that remembers what it was for.
 *
 * Every refusal a body can earn is `cloneContext` — ownership, the name, the collision, whether
 * there is a budget to sign for, and the hourly counter, which it charges last so a typo costs
 * nothing. What is left here is the chain: `prepareDeployTx` builds the funding, the registration
 * and the allowance as one transaction, signs the two halves the server holds, and hands back the
 * one signature that is missing — the caller's.
 *
 * Nothing is written and nothing is recorded. The message the wallet is about to sign stays on
 * the ticket; the browser gets the transaction it is inside of.
 */
async function prepareClone(id: string, record: DeployedAgent, body: Body, caller: string) {
  const server = loadKeypair();
  if (!server || !RPC_URL) {
    return Response.json({ error: "the server has no runtime keypair or RPC configured" }, { status: 503 });
  }
  if (!body.prepare) {
    return Response.json({ error: "a clone is `prepare: true`, then `confirm` with its ticket" }, { status: 400 });
  }
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(body.wallet ?? "");
  } catch {
    return Response.json({ error: "a wallet address is required to prepare a clone" }, { status: 400 });
  }
  // The closed beta (`_lib/beta.ts`), before the wallet is asked to sign the transaction that funds
  // and registers the copy on the server's SOL, and before `cloneContext` charges the hour's clone.
  const closed = betaRefused(wallet.toBase58());
  if (closed) return closed;

  const plan = cloneContext({
    agentId: id,
    source: record,
    wallet: wallet.toBase58(),
    name: String(body.name ?? ""),
    ip: caller,
  });
  if ("error" in plan) return Response.json({ error: plan.error }, { status: plan.status });

  // The server-wide ceiling on prepared transactions, charged **last**: after the wallet parse
  // and after `cloneContext` — ownership, the name, the collision, the budget and the hourly
  // counter — every one of which is a refusal that creates nothing. Charged first, an empty body, a
  // name someone already took or an agent belonging to another wallet would each spend one of the
  // hour's 200 prepares without a chain write anywhere near it, so 200 unauthenticated 400s would
  // take every deploy and clone on the box down for an hour. `/api/agents` charges it in the same
  // place for the same reason.
  //
  // "Last" means last *among the refusals this server can make by itself*. A wallet prompt the
  // person then cancels is still charged, and has to be: what this bounds is broadcastable
  // transactions, and the operator pays for one the moment it lands. It is the ceiling rather
  // than the per-wallet counter that bounds that, because `prepare` checks no signature and the
  // per-wallet key is a string the caller rotates. See `callerIp`. The caller's address has a
  // bucket of its own inside it, asked first, so one address cannot spend the server's hour for
  // every other caller; the clone counter `cloneContext` charged is the wallet's.
  const ceiling = prepareCeiling(caller);
  if (ceiling) return Response.json({ error: ceiling }, { status: 429 });

  try {
    const prepared = await prepareDeployTx(server, plan.name, {
      wallet,
      cap: BigInt(plan.allowance.capMicroUsdc),
      expiresAt: BigInt(plan.allowance.expiresAt),
      policyVersionHash: Uint8Array.from(Buffer.from(plan.allowance.policyVersionHash, "hex")),
    });
    if ("conflict" in prepared) return Response.json({ error: prepared.conflict }, { status: 409 });

    // The message stays on the ticket; the browser gets the transaction it is inside of.
    const { message, ...wire } = prepared;
    return Response.json({
      ...wire,
      ticket: issueCloneTicket(plan, wallet.toBase58(), message),
      name: plan.name,
      clonedFrom: { agentId: plan.source.agentId, name: plan.source.name },
      // What the copy will run under, so the page can say what is being copied before the wallet
      // is asked for anything — without its prompt. This prepare is unsigned and the
      // owner it checks is public, so anything in this answer is served to whoever names the
      // owner; the prompt stays behind the owner's signature, and its hash is what the genesis
      // commits. The ticket keeps the full config for `confirm`.
      config: publicCopyConfig(plan.config),
      allowance: plan.allowance,
      note: cloneNote(plan),
    });
  } catch (e: any) {
    console.error("[api/agents/:id] clone prepare failed:", e);
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

/**
 * The second half: the chain is read, and only a header that is really there becomes a record.
 *
 * The authorisation is the transaction, checked as one — `deployTxSignedBy` fetches the signature
 * the browser names and requires it to be the message this ticket's `prepare` built, landed,
 * successful, and signed by the wallet the ticket was issued to. That wallet was the source's
 * owner when the plan was made, and the `approve_agent` inside those bytes names it as `user`, so
 * the copy's allowance is the owner's own delegation. Nothing here trusts the browser.
 *
 * The ticket is spent only once the chain has answered, and never on "this node has not seen it
 * yet" — by the time `confirm` runs the transaction has already landed, and a ticket burned on an
 * RPC that was a slot behind would leave a registered, funded copy with no record under a name
 * `prepareDeployTx` refuses forever.
 */
async function confirmClone(server: Keypair, ticketId: string, ticket: CopyTicket, signature: string) {
  const idBytes = idFromString(ticket.name);

  const confirmed = await confirmLandedDeploy({
    noun: "clone",
    server,
    name: ticket.name,
    signature,
    ticket,
    spend: () => spendCloneTicket(ticketId),
  });
  if ("refused" in confirmed) return confirmed.refused;

  // Already recorded — a retried confirm, or two tabs. The chain is the same either way.
  const already = lookupAgent(ticket.id);
  if (already) {
    // The first confirm may have recorded the copy and then lost its name to a rate limit.
    // A re-confirm is the user saying the copy is not finished, so repair it: two reads when the
    // name is already on chain, one server-paid write when it is not.
    await publishNameQuietly(server, idBytes, ticket.name);
    return Response.json({
      id: ticket.id,
      name: already.name,
      authority: already.authority,
      signature,
      template: already.template ?? null,
      clonedFrom: already.clonedFrom ?? null,
    });
  }

  const { template, clonedFrom } = recordCopy(ticket, confirmed.authority);
  await publishNameQuietly(server, idBytes, ticket.name);
  // A clone is a deploy: its `agent.deploy` names the source in `clonedFrom` and the transaction the
  // wallet signed, owed now and written under the run slot.
  oweAgentDeploy(ticket.id, signature);

  const source = lookupAgent(ticket.sourceAgentId);
  return Response.json({
    id: ticket.id,
    name: ticket.name,
    authority: confirmed.authority,
    signature,
    template,
    clonedFrom,
    note: source && isArchived(source) ? "The agent it was cloned from is archived; the clone is not." : undefined,
  });
}
