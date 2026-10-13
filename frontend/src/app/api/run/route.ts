/**
 * The session runner. Runs a real `AgentRuntime` against the configured cluster with a keypair
 * this server holds, and streams every chain write back as server-sent events.
 *
 * Everything the stream reports is something the chain can confirm: each event carries the seq,
 * head and signature the SDK got back from the transaction, and the closing audit is
 * `lath-audit` run against the indexer. Nothing here is simulated. What *can* vary is
 * inference: a session the operator's Tempo treasury can pay for runs a real model, paid per call
 * over MPP; every other session gets a scripted transport that walks the tools in a fixed order,
 * and the stream says so. This server holds no provider API key.
 *
 * Who may spend what: a caller proves control of a wallet by signing a short message (nonce,
 * timestamp, cluster, wallet) — the SIWS shape without the library. That signature is the *first*
 * half of the answer and never the whole of it, because a keypair is free to mint: it says which
 * wallet to look for an allowance under, and the allowance is what decides.
 *
 * - **Anonymous** — no signature. A real chain, the scripted transport, nothing billed.
 * - **Signed and charged** — a live on-chain `Allowance` from that wallet to this agent's
 *   authority, with escrow behind it. The provider is paid from the operator's treasury over MPP
 *   and the wallet is debited in the same transaction as the event it pays for.
 * - **Signed, and the owner of the agent, with no allowance yet** — the session runs, scripted
 *   and unbilled, and `inferenceNote` says so.
 * - **Signed, anybody else, no allowance** — refused (402), with the reason on screen. Signing
 *   says "bill me"; this server cannot, and it will not pay for the session out of its own.
 *
 * `sessionSpend` in `../_lib/runner.ts` is that decision in one place, and `_lib/loops.ts` makes
 * the same one for a loop step.
 *
 * Which chain it writes: without `target`, the console's own agents (`console-agent-<tag>` and
 * friends). With one, any agent this server operates — the console roles, or something
 * deployed through `/api/agents`, whose keys are re-derived from the name in `agents.json` and
 * checked against the header's on-chain `authority` before a single write.
 *
 * When the answer comes first: the top agent's runtime journals its records instead of sending
 * them (`runtime/src/anchor.ts`), so the model's tokens stream as `session:token`, the reply is
 * `session:answer` the moment the resolution is computed, and the writer queue's transitions
 * arrive afterwards as `runtime` events with `type: "anchor"`. A record that will not land after
 * three attempts means the blockchain write failed, not that the answer was lost; `{ action:
 * "retry" }` re-queues those records under the head check. Delegated child agents still anchor
 * synchronously.
 *
 * The environment it reads is documented in `../_lib/runner.ts`.
 */
import { NextRequest } from "next/server";
import { templateSystemPrompt } from "../_lib/templates";
import { MAX_PROMPT } from "../templates/validate";
import { asBody, bodyTooLarge, readJsonCapped } from "../rpc/proxy";
import { sse } from "../_lib/sse";
import {
  CHAIN_TOOL_NAMES,
  CellWriter,
  OPT_IN_TOOL_NAMES,
  TOOL_NAMES,
  consoleTools,
  scriptedTransport,
  scriptedTurns,
} from "../_lib/tools";
import { createRpc, Rpc } from "@lightprotocol/stateless.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  AnchoredEpochStore,
  audit,
  BillingClient,
  EventKind,
  FileTraceStore,
  formatReport,
  hex,
  idFromString,
  LathClient,
  LocatorRegistry,
  RecordingTraceStore,
  ChainSignals,
  DEFAULT_AGENT_DYNAMIC_CONFIG,
  DEFAULT_MIN_PAYER_LAMPORTS,
} from "@lath/sdk";
import {
  AgentRuntime,
  AnchorFailed,
  AnchorQueue,
  ChatTransport,
  NoopBilling,
  RuntimeEvent,
  TempoChannel,
  ToolDefinition,
  retiredHireTool,
} from "@lath/runtime";
import {
  AUTH_WINDOW_MS,
  CLUSTER,
  DeployedPolicy,
  MAX_STEPS,
  MODELS,
  PHOTON_URL,
  PROVER_URL,
  RPC_URL,
  Roles,
  SESSION_CAP_MICRO,
  SessionAuth,
  TRACE_DIR,
  TREASURY_ADMIN,
  acquireRunSlot,
  admitSpend,
  callerIp,
  callerShare,
  consoleOrigin,
  deployedRoles,
  ensureAgent,
  ensureFunded,
  epochsSupportedOrNot,
  holdRunSlot,
  isArchived,
  loadKeypair,
  lookupAgent,
  rateLimit,
  rateLimited,
  roles,
  runSlotHolder,
  SessionSpend,
  sessionSpend,
  traceBackend,
  traceBackendInfo,
  verifyAuth,
} from "../_lib/runner";
import { anchorQueue, anchorSummary, bindAnchorChain, drainAdmission, drainOwed, subscribe } from "../_lib/anchor";
import { betaRefused } from "../_lib/beta";
import { Rail, RailOutcome, openTempoChannel, perCallCeiling, railFor, tempoCanCover } from "../_lib/tempo";
import { deferSeal, sealDeferred } from "../_lib/unsealed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── Rate limiting: one session at a time, a handful per hour per caller ────

const PER_HOUR = 6;
/**
 * A retry of a session's failed writes runs no model and moves no money — it sends records the
 * caller already paid for — so it does not spend the session budget. Its own bucket exists so a
 * caller cannot use the FAILED badge to hold the run slot indefinitely.
 */
const RETRIES_PER_HOUR = Number(process.env.LATH_RETRIES_PER_HOUR ?? 30);
/** A session that has not finished by then is abandoned, so one hung RPC or provider call
 * cannot hold the single-flight slot for the life of the process. */
const SESSION_DEADLINE_MS = Number(process.env.LATH_SESSION_DEADLINE_MS ?? 15 * 60_000);

/**
 * Sessions the operator pays for in full, across the whole server, an hour. An unbilled
 * session — anonymous, or an owner's own agent before its allowance lands — writes a real chain
 * on the server's SOL, through its RPC quota and, on Irys, its upload balance, and nobody is
 * debited for any of it. `PER_HOUR` bounds one caller, but a caller is an address behind
 * `LATH_TRUST_PROXY=1`, and addresses are cheap; without this bucket the only server-wide bound
 * would be the single run slot, which is a rate that moves with how fast devnet confirms. A charged
 * session is not counted: its wallet pays, and a stranger filling this bucket must not be able to
 * turn paying callers away.
 */
const UNBILLED_SESSIONS_PER_HOUR_SERVER = Number(process.env.LATH_UNBILLED_SESSIONS_PER_HOUR ?? 60);

/**
 * The chain reads a caller can make this server pay for before anything has been decided: the
 * header read on `GET /api/run?agent=` and on a targeted `POST`, and the allowance and escrow
 * reads `chainBilling` makes for a signed one. None of them is behind the session counter, by
 * design — that counter is charged only once every refusal has passed — so without these buckets
 * each would be a read anyone could ask for as often as they liked, on the RPC quota every loop
 * step and deploy runs on. Two buckets, the caller's address and the whole server, both asked
 * before either is stamped (`chargeTemplateWrite`'s shape), so a caller its own bucket refuses has
 * not spent the server's. Per caller it is well above what an honest one spends — six sessions and thirty
 * retries an hour, plus a header read per agent page the cache below has not answered — and the
 * server's is ten callers' worth. A request costs at most three reads (each retried on a
 * transient failure, as every SDK read is), so the server's bucket is also a ceiling of about
 * 3 600 reads an hour from this route's admission.
 */
const READS_PER_HOUR = Number(process.env.LATH_RUN_READS_PER_HOUR ?? 120);
const READS_PER_HOUR_SERVER = Number(process.env.LATH_RUN_READS_PER_HOUR_SERVER ?? 1200);

/**
 * Both read buckets, asked before either is stamped. A refusal, or null once both are charged. An
 * unproxied caller's bucket is shared by everyone, so it holds `callerShare`'s many callers' worth.
 */
function chargeReads(ip: string): string | null {
  const buckets: [string, string, number][] = [
    ["chain reads on this server", "run-reads:server", READS_PER_HOUR_SERVER],
    ["chain reads from this address", `run-reads:${ip}`, READS_PER_HOUR * callerShare(ip)],
  ];
  for (const [what, key, perHour] of buckets) {
    const refused = rateLimited(what, key, perHour);
    if (refused) return `${refused}; try again later`;
  }
  for (const [what, key, perHour] of buckets) rateLimit(what, key, perHour);
  return null;
}

/** `share` is how many callers' worth `caller`'s bucket holds: more than one for the shared `local`. */
function allow(caller: string, retrying = false, unbilled = false, share = 1): string | null {
  // The slot is shared with loop steps (`_lib/runner.ts`): this server writes one chain at a time.
  const held = runSlotHolder();
  if (held) return `another run is in progress (${held}); try again in a minute`;
  if (retrying) return rateLimit("retries", caller, RETRIES_PER_HOUR * share);
  // The server's bucket is asked first and stamped last, so a caller out of its own six has not
  // spent one of the server's, and a server at its ceiling says so instead of blaming the caller.
  if (unbilled) {
    const full = rateLimited(
      "unbilled sessions on this server",
      "sessions:unbilled",
      UNBILLED_SESSIONS_PER_HOUR_SERVER
    );
    if (full) return `${full}; a session billed to a wallet's allowance still runs`;
  }
  const refused = rateLimit("sessions", caller, PER_HOUR * share);
  if (refused) return refused;
  if (unbilled) rateLimit("unbilled sessions on this server", "sessions:unbilled", UNBILLED_SESSIONS_PER_HOUR_SERVER);
  return null;
}

// ─── What a request may carry ───────────────────────────────────────────────

/**
 * The body, read whole before it is parsed. An app-router handler has no body limit and there is
 * no middleware, so `req.json()` would buffer whatever was sent — and every copy of the prompt in
 * it lands on disk: the Genesis input, each turn's request blob, the bundle. A real body is a
 * prompt, eight earlier turns and a signature; 256 KiB leaves room for eight long answers in the
 * history and none for a disk-filler. `readJsonCapped` is the RPC proxy's, which counts the bytes
 * as they arrive rather than trusting `Content-Length`; the deploy, clone, store and template
 * routes read their bodies through it too.
 */
const MAX_BODY_BYTES = 256 * 1024;
/** Earlier turns a session folds in: what the chat sends and what `withHistory` keeps. */
const MAX_HISTORY_TURNS = 8;

/**
 * Why a session's text is refused (400), or null. The prompt is what a person typed, so it gets
 * the 2 000 characters every other prompt on this server gets (`MAX_PROMPT`), and a longer one is
 * refused rather than cut: a genesis must commit the prompt that was sent. The history is
 * checked for shape and length only; its turns are cut in `withHistory`, because half of them are
 * the agent's own answers, which a template may make long, and refusing those would break the
 * next message of an honest chat.
 */
function textRefusal(body: Body): string | null {
  if (body.prompt !== undefined && body.prompt !== null && typeof body.prompt !== "string")
    return "prompt must be a string";
  if (typeof body.prompt === "string" && body.prompt.trim().length > MAX_PROMPT)
    return `the prompt is too long (${MAX_PROMPT} characters)`;
  if (body.history !== undefined && body.history !== null) {
    if (!Array.isArray(body.history)) return "history must be a list of earlier turns";
    if (body.history.length > MAX_HISTORY_TURNS)
      return `history is at most ${MAX_HISTORY_TURNS} earlier turns; the session folds in no more`;
  }
  return null;
}

/**
 * Header reads `GET /api/run?agent=` has already made, by agent id. Every agent page asks
 * the question, and so does every focus of a stale tab, while the answer moves only when an agent
 * registers or an authority is handed over (`set_authority`, an SDK call the console does not
 * make) — and for an id this server operates, a header that is not there yet and one that names
 * this server's key read the same: operated. Five minutes stale is therefore harmless, and it
 * means only an id nobody has asked about lately costs a read, which is the one an enumerating
 * caller has to pay the read buckets for. A failed read is not kept, so an RPC blip is not
 * remembered for five minutes. The `POST` never reads through this: it is about to write the
 * chain, and checks the header live.
 */
const AUTHORITY_TTL_MS = 5 * 60_000;
const AUTHORITY_CACHE_MAX = 1024;
const authorityCache = new Map<string, { at: number; authority: PublicKey | null }>();

/**
 * The server-wide half of `GET /api/run`'s answer — the runtime key's SOL, whether the Tempo
 * treasury can cover a session, the blob backend's balance — shared for a few seconds by every
 * caller. None of it is about the caller, all of it would be a read per request (a Solana
 * `getBalance`, a Tempo `balanceOf`, and two Irys calls on that backend), and the page polls it.
 * Fifteen seconds is half the browser's own `staleTime` for the same query, so nothing on screen
 * is older than it already was; the run slot (`busy`) is still read live, because it is memory.
 */
const INFO_TTL_MS = 15_000;
let infoCache: {
  key: string;
  at: number;
  value: Promise<{
    balance: number;
    covered: Awaited<ReturnType<typeof tempoCanCover>> | null;
    traceBackend: Awaited<ReturnType<typeof traceBackendInfo>>;
  }>;
} | null = null;

// ─── Tools: real reads against the cluster ──────────────────────────────────

/**
 * `self` is the agent these tools are being built for, so `lath.verify_chain` can default to
 * it. Nothing in a session tells a model its own id, so a required `agentId` would make "verify
 * your own chain" — the one thing this console asks an agent to do about itself — unanswerable
 * for a model, and only the scripted transport, which passes the id itself, could do it. The
 * parameter stays, so verifying *another* agent still works.
 */
// ─── Which chain a request runs on ──────────────────────────────────────────

/** An agent this server can write: the roles to run it under, and the key that must be the
 * header's `authority` for a write to be accepted at all. */
interface Target {
  name: string;
  kind: "agent";
  roles: Roles;
  key: Keypair;
  policy?: DeployedPolicy;
  source: "console" | "deployed";
  /** The deploying wallet, for a deployed target. */
  owner?: string;
}

function resolveTarget(server: Keypair, id: string): Target | null {
  const wanted = id.toLowerCase();
  const r = roles(server);
  const idOf = (name: string) => hex(idFromString(name));
  for (const who of [r.agent, r.coordinator, r.sentinel, r.verifier]) {
    if (wanted === idOf(who.name))
      return { name: who.name, kind: "agent", roles: { ...r, agent: who }, key: who.key, source: "console" };
  }
  const record = lookupAgent(wanted);
  if (!record) return null;
  const derivedRoles = deployedRoles(server, record.name);
  return {
    name: record.name,
    kind: "agent",
    roles: derivedRoles,
    key: derivedRoles.agent.key,
    policy: record.policy,
    source: "deployed",
    owner: record.owner,
  };
}

/**
 * The rail an agent's own record asks for, when it names one.
 *
 * Read through a cast rather than off `DeployedPolicy`, because writing `payment` onto a
 * deployed agent's row is the deploy form's half of this module and not this route's: what a row
 * with no rail says is nothing, which `railFor` reads as "the default". A console agent has no
 * row at all and is likewise defaulted.
 */
function recordedRail(target: Target | null): Rail | undefined {
  const named = (target?.policy as { payment?: string } | undefined)?.payment;
  return named === "tempo" || named === "vault" ? named : undefined;
}

/** The header's `authority` as the chain has it, or null when nothing is registered yet. */
async function onChainAuthority(rpc: Rpc, signer: Keypair, id: string) {
  const client = LathClient.fromIdl(rpc, signer);
  const state = await client.getAgentState(Uint8Array.from(Buffer.from(id, "hex"))).catch(() => null);
  return state?.state.authority ?? null;
}

/**
 * `onChainAuthority`, with a failed read told apart from an empty header: the GET caches what it
 * learns, and an RPC that did not answer has taught it nothing.
 */
async function readAuthority(
  rpc: Rpc,
  signer: Keypair,
  id: string
): Promise<{ ok: boolean; authority: PublicKey | null }> {
  const client = LathClient.fromIdl(rpc, signer);
  try {
    const state = await client.getAgentState(Uint8Array.from(Buffer.from(id, "hex")));
    return { ok: true, authority: state?.state.authority ?? null };
  } catch {
    return { ok: false, authority: null };
  }
}

/** `GET /api/run`'s server-wide reads, shared for `INFO_TTL_MS` (see `infoCache`). Never throws. */
function serverInfo(server: Keypair, rpc: Rpc, rail: RailOutcome) {
  const key = `${server.publicKey.toBase58()}:${rail}`;
  const now = Date.now();
  if (infoCache && infoCache.key === key && now - infoCache.at < INFO_TTL_MS) return infoCache.value;
  const value = (async () => {
    const [balance, covered, traceBackend] = await Promise.all([
      rpc.getBalance(server.publicKey).catch(() => 0),
      // `GET` says why this is the question it asks. A throw is a degrade, not a cached rejection
      // that would fail every caller's GET for the next fifteen seconds.
      rail === "tempo"
        ? tempoCanCover({ maxCostBase: perCallCeiling(SESSION_CAP_MICRO, MAX_STEPS), maxSteps: MAX_STEPS }).catch(
            (e: any): { degrade: string } => ({
              degrade: `the operator's Tempo treasury could not be read: ${e?.message ?? String(e)}`,
            })
          )
        : Promise.resolve(null),
      traceBackendInfo(server),
    ]);
    return { balance, covered, traceBackend };
  })();
  infoCache = { key, at: now, value };
  return value;
}

// ─── Chain signals: what the epoch batcher looks at ─────────────────────────

/** What the batcher refused on, in the numbers it refused with. */
interface Refusal {
  code: "InsufficientPayerBalance";
  /** Lamports the payer held when the batcher looked. */
  balance: number;
  /** Lamports an epoch commit plus its locator cell plus one record need. */
  required: number;
  payer: string;
}

/**
 * The fee and balance probes the epoch batcher acts on — `LathClient.chainSignals()`, so the
 * numbers the stream reports are the same reads the batcher makes, not a second opinion — with
 * the balance probe wrapped so a refusal is reportable as numbers rather than a message. The
 * balance is only ever read when a new epoch opens, which is exactly when a refusal happens.
 */
function sessionSignals(client: LathClient, payer: PublicKey, onRefusal: (r: Refusal) => void): ChainSignals {
  const base = client.chainSignals();
  const required = DEFAULT_MIN_PAYER_LAMPORTS;
  return {
    ...base,
    minPayerLamports: required,
    payerBalance: async () => {
      const balance = await base.payerBalance!();
      if (balance < required)
        onRefusal({ code: "InsufficientPayerBalance", balance, required, payer: payer.toBase58() });
      return balance;
    },
  };
}

// ─── The session ────────────────────────────────────────────────────────────

interface Body {
  /**
   * `retry` re-queues the records a session journaled and could not write, and streams the
   * queue's transitions instead of running a model. It is what the `FAILED` badge clicks.
   */
  action?: "retry";
  /** `retry` only: the chain whose writes failed. */
  agentId?: string;
  /** Which chain to run on. Absent: the console's own agents. */
  target?: { kind?: "agent"; id?: string };
  /** Earlier turns of the same chat, folded into the prompt. The session itself is single-shot. */
  history?: { role: "user" | "agent"; text: string }[];
  prompt?: string;
  model?: string;
  user?: string;
  budgetCapMicroUsdc?: string;
  auth?: SessionAuth;
}

/** Earlier turns as plain text ahead of the new one. The chain records exactly what it always
 * records: one session, one genesis, one prompt — this is what that prompt says. Each turn is cut
 * to `MAX_PROMPT` characters (`textRefusal` says why cut and not refused), so the folded
 * prompt is at most nine prompts long whatever the body held. */
function withHistory(prompt: string, history: Body["history"]): string {
  const turns = (history ?? [])
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .slice(-MAX_HISTORY_TURNS);
  if (turns.length === 0) return prompt;
  const cut = (text: string) => (text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT)}…` : text);
  const transcript = turns.map((t) => `${t.role === "agent" ? "agent" : "user"}: ${cut(t.text.trim())}`).join("\n");
  return `Earlier in this conversation:\n${transcript}\n\nNow: ${prompt}`;
}

export async function GET(req: NextRequest) {
  const server = loadKeypair();
  if (!server || !RPC_URL) {
    return Response.json({ ready: false, reason: "LATH_RUNTIME_KEYPAIR and an RPC url are required on the server" });
  }
  const r = roles(server);
  const rpc = createRpc(RPC_URL, PHOTON_URL, PROVER_URL, { commitment: "confirmed" });
  const programId = LathClient.fromIdl(rpc, server).programId;

  // `?agent=<hex>` asks one further question: can this server write *that* chain?
  const wanted = req.nextUrl.searchParams.get("agent");
  let target: unknown = null;
  let resolved: Target | null = null;
  if (wanted && /^[0-9a-f]{64}$/i.test(wanted)) {
    resolved = resolveTarget(server, wanted);
    // An id this server does not know could still be a chain someone else operates, so the
    // header is read whether or not `resolveTarget` recognised it — which is why this read, and
    // not the cheap lookup above it, is what the read buckets stand in front of: any 64 hex
    // characters are an id, and each new one would be a Photon read for free.
    const id = wanted.toLowerCase();
    const now = Date.now();
    const cached = authorityCache.get(id);
    let chainAuthority: PublicKey | null;
    if (cached && now - cached.at < AUTHORITY_TTL_MS) {
      chainAuthority = cached.authority;
    } else {
      const refused = chargeReads(callerIp(req));
      if (refused) return Response.json({ ready: false, reason: refused, error: refused }, { status: 429 });
      const read = await readAuthority(rpc, server, id);
      chainAuthority = read.authority;
      if (read.ok) {
        // Oldest first out: a `Map` iterates in insertion order, and a re-read is re-inserted.
        authorityCache.delete(id);
        if (authorityCache.size >= AUTHORITY_CACHE_MAX) authorityCache.delete(authorityCache.keys().next().value!);
        authorityCache.set(id, { at: now, authority: chainAuthority });
      }
    }
    const operated = !!resolved && (!chainAuthority || chainAuthority.equals(resolved.key.publicKey));
    target = {
      id: wanted.toLowerCase(),
      name: resolved?.name ?? null,
      kind: resolved?.kind ?? null,
      authority: (operated ? resolved!.key.publicKey : chainAuthority)?.toBase58() ?? null,
      operated,
      policy: resolved?.policy ?? null,
      source: resolved?.source ?? null,
      owner: resolved?.owner ?? null,
    };
  }

  /**
   * What inference this agent's next session gets, which is a question about money and not about
   * a key: this server holds no provider key, so a session is real only if the treasury can pay
   * for it.
   *
   * The treasury is asked the same question `openTempoChannel` will ask when the session opens —
   * can it cover the whole deposit — so a header that says `openrouter` is a header a session can
   * keep. The answer is the server's, not the agent's (`railFor` does not read the record), so it
   * is shared by every caller for `INFO_TTL_MS` with the balances beside it (`serverInfo`).
   */
  const rail = railFor(recordedRail(resolved), true);
  const { balance, covered, traceBackend } = await serverInfo(server, rpc, rail);
  const gateway = !!covered && "ok" in covered;
  const inference: "openrouter" | "scripted" = gateway ? "openrouter" : "scripted";
  /** Why, in the words a reader needs. */
  const inferenceNote = gateway
    ? "OpenRouter's MPP gateway is paid per call from the operator's Tempo treasury; this server holds no model key"
    : covered && "degrade" in covered
    ? covered.degrade
    : "this deployment has no Tempo treasury configured, so every session runs scripted and unbilled";

  return Response.json({
    ready: true,
    cluster: CLUSTER,
    programId: programId.toBase58(),
    // `false` too when the probe could not read the program this time: the field stays a boolean for
    // the clients that read it, and the next status call probes again.
    epochs: await epochsSupportedOrNot(rpc, programId),
    authority: server.publicKey.toBase58(),
    balanceSol: balance / LAMPORTS_PER_SOL,
    /** Who holds the run slot right now (a session, a loop step or a publish), or null. */
    busy: runSlotHolder(),
    /** Where epoch blobs are anchored, and — on Irys — the uploader's second balance. */
    traceBackend,
    inference,
    inferenceNote,
    /**
     * What a session gets, by what is behind it. `model` is what a **billed** session gets — a
     * signature alone does not reach it (`sessionSpend`): a signed session with no live
     * allowance is refused unless it is the owner running their own agent, in which case it is
     * scripted. `anonymous` is the console's open path.
     */
    signedSessions: { model: inference, anonymous: "scripted", windowMs: AUTH_WINDOW_MS },
    sessionCapUsdc: Number(SESSION_CAP_MICRO) / 1e6,
    maxSteps: MAX_STEPS,
    target,
    agents: [
      {
        role: "agent",
        name: r.agent.name,
        id: hex(idFromString(r.agent.name)),
        authority: r.agent.key.publicKey.toBase58(),
      },
      {
        role: "coordinator",
        name: r.coordinator.name,
        id: hex(idFromString(r.coordinator.name)),
        authority: r.coordinator.key.publicKey.toBase58(),
      },
      {
        role: "sentinel",
        name: r.sentinel.name,
        id: hex(idFromString(r.sentinel.name)),
        authority: r.sentinel.key.publicKey.toBase58(),
      },
      {
        role: "verifier",
        name: r.verifier.name,
        id: hex(idFromString(r.verifier.name)),
        authority: r.verifier.key.publicKey.toBase58(),
      },
    ],
  });
}

export async function POST(req: NextRequest) {
  const server = loadKeypair();
  if (!server || !RPC_URL) {
    return Response.json({ error: "the server has no runtime keypair or RPC configured" }, { status: 503 });
  }
  // Read whole and capped before it is parsed. What does not parse is an empty body — the
  // console's default session — and so is anything that parses to a value that is not an object,
  // which would otherwise reach `body.action` as `null` and throw.
  const read = await readJsonCapped(req, MAX_BODY_BYTES);
  if (!read) return bodyTooLarge(MAX_BODY_BYTES);
  const body: Body = asBody<Body>(read.json);
  const badText = textRefusal(body);
  if (badText) return Response.json({ error: badText }, { status: 400 });

  /**
   * A retry writes the same chain a session writes, so it is authenticated the same way, rate
   * limited the same way and takes the same run slot; all it skips is the model. Saying that
   * here — one target, one set of checks — is what keeps the two from drifting apart.
   */
  const retrying = body.action === "retry";
  if (retrying) {
    const id = String(body.agentId ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return Response.json({ error: "retry needs the agentId whose writes failed" }, { status: 400 });
    }
    body.target = { kind: "agent", id };
  }

  // Without a target the console's own agents run.
  let target: Target | null = null;
  let targetId = "";
  if (body.target?.id) {
    const id = String(body.target.id).toLowerCase();
    targetId = id;
    if (!/^[0-9a-f]{64}$/.test(id)) return Response.json({ error: "target id must be 32 hex bytes" }, { status: 400 });
    target = resolveTarget(server, id);
    if (!target) return Response.json({ error: "no agent with that id was deployed here" }, { status: 404 });
    // An archived agent keeps its record so audits resolve, but runs no new sessions.
    const deployed = lookupAgent(id);
    if (deployed && isArchived(deployed)) {
      return Response.json({ error: `${deployed.name} is archived; no new sessions run on it` }, { status: 409 });
    }
    // Whether this server still holds the header's `authority` is a chain read, so it is asked
    // below, behind the owner gate and the read buckets, and not here: here it would be a Photon
    // read that any unsigned caller could make for any deployed id, as often as they liked, and
    // then be told 401.
  }

  const asked = (body.prompt ?? "").trim() || "Report the cluster's slot, fee level and verify your own chain.";
  const prompt = withHistory(asked, body.history);
  const model =
    body.model && MODELS.has(body.model)
      ? body.model
      : target?.policy?.model && MODELS.has(target.policy.model)
      ? target.policy.model
      : "deepseek/deepseek-v4.1-flash";
  let claimed: PublicKey | null = null;
  try {
    claimed = body.user ? new PublicKey(body.user) : null;
  } catch {
    claimed = null;
  }
  // The wallet is only believed when it signed for this session. Unsigned, the session is
  // anonymous: a real chain, scripted inference, no billing.
  const verified = verifyAuth(
    body.auth,
    claimed,
    "Lath console session",
    {
      action: retrying ? "retry" : "session",
      target: body.target?.id ? String(body.target.id).toLowerCase() : "console",
    },
    consoleOrigin(req)
  );
  const user = "wallet" in verified ? verified.wallet : null;
  const authNote = "reason" in verified && body.auth ? verified.reason : null;

  // The closed beta (`_lib/beta.ts`), on the wallet the signature just proved, before anything
  // reads the chain, takes the run slot or opens a channel. Every session is asked, the anonymous
  // one on the console's own agents included: it bills nobody, but it writes a real chain on the
  // server's SOL, and with no wallet to rotate it is the cheapest request there is to repeat. A
  // signature that was sent and refused leaves `user` null, so its reason rides on the refusal —
  // an invited wallet whose message expired should be told that, not that it is not invited.
  //
  // A retry is not asked. It runs no model and creates no record: it sends ones an admitted session
  // or step already journaled, and the next admitted session on that chain would send them anyway.
  // Refusing it would only leave an owner taken off the list unable to clear their FAILED badge.
  if (!retrying) {
    const closed = betaRefused(
      user ? user.toBase58() : null,
      authNote && `the signature sent was refused: ${authNote}`
    );
    if (closed) return closed;
  }

  // A deployed agent's chain is its owner's history. The console's own agents stay open to
  // anonymous callers; anything deployed through the wizard runs only for the wallet that
  // signed the deploy, and never for a record that predates ownership.
  if (target?.source === "deployed") {
    if (!target.owner) {
      return Response.json(
        { error: "this agent was deployed before ownership was recorded; redeploy it under a wallet to run it" },
        { status: 403 }
      );
    }
    if (!user) {
      return Response.json(
        { error: `only the owner's wallet may run this agent: ${"reason" in verified ? verified.reason : "unsigned"}` },
        { status: 401 }
      );
    }
    if (user.toBase58() !== target.owner) {
      return Response.json({ error: "this agent belongs to another wallet" }, { status: 403 });
    }
  }

  let cap = SESSION_CAP_MICRO;
  if (body.budgetCapMicroUsdc !== undefined && body.budgetCapMicroUsdc !== null && body.budgetCapMicroUsdc !== "") {
    try {
      cap = BigInt(body.budgetCapMicroUsdc);
    } catch {
      return Response.json({ error: "budgetCapMicroUsdc must be an integer number of micro-USDC" }, { status: 400 });
    }
    if (cap <= 0n) return Response.json({ error: "budgetCapMicroUsdc must be positive" }, { status: 400 });
    if (cap > SESSION_CAP_MICRO) cap = SESSION_CAP_MICRO;
  }

  // Only the run slot is asked here, before the allowance read: a server that is busy writing a
  // chain says so without an RPC round trip. The hourly counter itself is charged below, once the
  // 402 and the drain gate have had their say.
  const busy = runSlotHolder();
  if (busy)
    return Response.json({ error: `another run is in progress (${busy}); try again in a minute` }, { status: 429 });

  /**
   * Everything above is memory and disk; from here a request may cost chain reads — the header
   * below when it names a target, then `chainBilling`'s allowance and escrow reads when a wallet
   * signed and there is a treasury to bill through — and none of them may be free to ask for again
   * and again. So the read buckets are charged here, once per request that will read, after every
   * check that needs no read and before the first one. An anonymous session on the console's own
   * agents reads nothing before its counter and is not charged. The buckets are not the session
   * counter: that is still charged only once every refusal below has passed, so a 402 costs a read
   * and not one of the hour's sessions.
   */
  if (target || (user && TREASURY_ADMIN)) {
    const readsRefused = chargeReads(callerIp(req));
    if (readsRefused) return Response.json({ error: readsRefused }, { status: 429 });
  }
  if (target) {
    const authority = await onChainAuthority(
      createRpc(RPC_URL, PHOTON_URL, PROVER_URL, { commitment: "confirmed" }),
      server,
      targetId
    );
    if (authority && !authority.equals(target.key.publicKey)) {
      return Response.json({ error: "not operated by this runtime" }, { status: 400 });
    }
  }

  /**
   * What this session may spend, read off the chain before the stream opens.
   *
   * Here rather than inside `runSession` so a refusal is an HTTP status a caller can act on
   * rather than an error event inside a 200 — and so the allowance is read once: the same
   * `billing` backend is handed down, because it is the queue, not the session, that sends a
   * metered record's charge and it must be the backend the allowance was checked on.
   *
   * A retry runs no model, so it reads no allowance *for itself*. What it is not exempt from is
   * the money already journaled on the chain it is about to drain: see `owed` below.
   */
  let billed: Awaited<ReturnType<typeof chainBilling>> | null = null;
  let spend: SessionSpend = { model: "scripted", note: "anonymous: scripted inference, unbilled" };
  const rpc = createRpc(RPC_URL, PHOTON_URL, PROVER_URL, { commitment: "confirmed" });
  const top = (target ? target.roles : roles(server)).agent;
  const topClient = LathClient.fromIdl(rpc, top.key);
  if (!retrying) {
    billed = await chainBilling(rpc, topClient, top.key, user, cap);
    spend = sessionSpend({
      signed: !!user,
      billingState: billed.billingState,
      ownsTarget: !!user && target?.source === "deployed" && target.owner === user.toBase58(),
      treasury: !!TREASURY_ADMIN,
      authority: top.key.publicKey.toBase58(),
      agentId: hex(idFromString(top.name)),
    });
    // 402: the session is well formed and the caller is who they say they are; what is missing is
    // the money. Nothing has been written and no slot has been taken.
    if ("refuse" in spend) return Response.json({ error: spend.refuse }, { status: 402 });
  }

  /**
   * Whose money the next drain of this chain would move, and whether this caller may move it.
   *
   * Both paths that drain a journal come through here: an explicit `{action:"retry"}`, and an
   * ordinary session, because `AgentRuntime.start` retries and drains whatever the chain still
   * owes before it writes anything of its own. Unasked, on a console agent — which has no owner
   * gate, by design, because it is the open demo — an anonymous caller would bind `NoopBilling`
   * and settle another wallet's pending USDC charges to `verified` with no transaction behind
   * them. A chain that owes nothing is drained anonymously; that is the common case and the
   * FAILED badge's own case.
   *
   * `drainOwed`, not every payer's debt: a charge the billing program refused (a revoked or
   * lapsed grant) is parked and counts only against the wallet that owes it, which also scopes
   * this request's drain to that wallet's parked charges. Counted against everyone, one wallet's
   * refused charge would name it the only caller who could drain the console's shared agents.
   */
  const owed = await drainOwed(idFromString(top.name), user ? user.toBase58() : null);
  if (owed.payers.length > 0) {
    // Read here for a retry only: a session has already read its own allowance above, and its
    // answer is the same one — the drain must go through a backend that can really charge.
    if (retrying && user) billed = await chainBilling(rpc, topClient, top.key, user, cap);
    const gate = drainAdmission({
      owed,
      user: user ? user.toBase58() : null,
      authNote,
      billingState: billed?.billingState ?? "no-wallet",
      shortfall: billed?.shortfall ?? null,
    });
    if ("status" in gate) return Response.json({ error: gate.refuse }, { status: gate.status });
  }

  // The hourly session (or retry) counter, charged only once every refusal above has passed.
  // Charged before the allowance is read, a signed caller told 402 — no live allowance, nothing
  // written, no slot taken — would have spent one of the hour's sessions on it, the same ordering
  // `/api/agents` keeps for its counters. Charging after the read leaves the two RPC reads of
  // `chainBilling` behind no per-wallet counter, which would bound nothing there anyway: the key
  // is a wallet the caller signs for, and a fresh keypair signs for free. What bounds those reads
  // is the read buckets above, keyed on the address and the server. A session nobody is billed
  // for also takes one of the server's unbilled sessions for the hour.
  const ip = callerIp(req);
  const refused = allow(
    user ? `wallet:${user.toBase58()}` : `ip:${ip}`,
    retrying,
    spend.model === "scripted",
    user ? 1 : callerShare(ip)
  );
  if (refused) return Response.json({ error: refused }, { status: 429 });

  const slot = acquireRunSlot(retrying ? "an anchor retry" : "a console session", SESSION_DEADLINE_MS);
  if (!slot) return Response.json({ error: "another run is in progress; try again in a minute" }, { status: 429 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          closed = true;
        }
      };
      let deadline: ReturnType<typeof setTimeout> | undefined;
      /**
       * What must be let go of when this request ends, whichever way it ends: the anchor
       * subscription outlives the answer it was opened for, and the queue keeps emitting for a
       * chain long after the stream that asked about it has closed.
       */
      const cleanups: (() => void)[] = [];
      const onEnd = (fn: () => void) => cleanups.push(fn);
      /**
       * The deadline's other half. `Promise.race` abandons the *wait*; it does not stop the work,
       * and the work here writes a hash chain. What the signal reaches is the model call — the
       * transport is wrapped with it, so an in-flight completion is cut and the next step throws
       * before it starts — and the session's own tail, which stops before the seal and the audit.
       *
       * It does not reach the anchor drain: that lives in `_lib/anchor.ts` behind
       * `queue.drain()`, which takes no signal, and a drain interrupted mid-record is the one
       * thing worse than a slow one. So the drain is allowed to finish, and the slot is held
       * until it does — see `hold` below.
       */
      const abandon = new AbortController();
      const work = retrying
        ? retryAnchor({ server, target, billed, send })
        : runSession({
            prompt,
            model,
            user,
            authNote,
            cap,
            server,
            target,
            send,
            onEnd,
            billed: billed!,
            spend,
            signal: abandon.signal,
          });
      /**
       * The slot is released when the session *exits*, not when this request stops waiting for
       * it. Releasing it in the `finally` below would let the deadline hand the slot to a second
       * writer while the first was still draining records into the same chain, which is the race
       * the single-flight slot exists to prevent.
       *
       * The heartbeat is the other half: the slot's TTL is a crash guard, so a holder that is
       * demonstrably alive pushes it out rather than letting a second writer in on a lapsed one.
       *
       * Stopping it at `HOLD_LIMIT_MS` — 45 minutes — so that a wedged session cannot own the
       * server for ever would not work: `runSlotHolder` reads a lapsed TTL as *free*, so that
       * ceiling would hand the slot to a second session while this one's anchor drain was still
       * writing the same chain: two writers, one chain, racing for the seq a checkpoint leaf
       * commits to. The other way to close that race — abort the first drain at the ceiling — is
       * not available: `AnchorQueue.drain` takes no signal, and a drain stopped mid-record is
       * worse than a slow one (the comment above `abandon` says why).
       *
       * So the ceiling is a report, not a release (`extendRunSlot` in `_lib/runner.ts`): the
       * slot is held for as long as `work` has not exited, and a holder past the ceiling is
       * logged as wedged so an operator sees a stuck process instead of a forked chain. A second
       * caller meanwhile gets the ordinary 429, which is a retry rather than a race.
       */
      const HOLD_LIMIT_MS = 3 * SESSION_DEADLINE_MS;
      // `holdRunSlot` (`_lib/runner.ts`) holds the slot, in its own function so a test pins it.
      const hold = holdRunSlot(slot, work, {
        ttlMs: SESSION_DEADLINE_MS,
        limitMs: HOLD_LIMIT_MS,
        beatMs: Math.max(15_000, Math.round(SESSION_DEADLINE_MS / 4)),
        onWedged: () =>
          console.error(
            `[api/run] ${slot.holder} has held the run slot for over ${Math.round(HOLD_LIMIT_MS / 60_000)} min ` +
              "and has not exited; the slot stays held so nothing else writes this chain beside it"
          ),
      });
      try {
        await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              abandon.abort();
              reject(new Error(`session abandoned after ${Math.round(SESSION_DEADLINE_MS / 1000)} s`));
            }, SESSION_DEADLINE_MS);
          }),
        ]);
      } catch (e: any) {
        console.error("[api/run] session failed:", e);
        send("session:error", { error: e?.message ?? String(e) });
      } finally {
        if (deadline) clearTimeout(deadline);
        for (const fn of cleanups) fn();
        // Not awaited: the stream closes now and the session finishes on its own. `hold` is what
        // keeps the slot until it does.
        void hold;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * The transport, wired to the request's deadline.
 *
 * `AgentRuntime.start` takes no signal — the runtime is not this route's to change — but the
 * transport is ours and the step loop's only suspension point is `chat`. So the signal reaches
 * the session here: an in-flight completion is cut (`ChatStreamOptions.signal` goes through to
 * `fetch`), and the next step throws before it opens a socket. The runtime turns the throw into
 * a failed resolution, which is a record, which is the point — an abandoned session ends on
 * chain rather than simply stopping.
 */
function abandonable(inner: ChatTransport, signal: AbortSignal): ChatTransport {
  return {
    chat(req, opts) {
      if (signal.aborted) throw new Error("session abandoned: the deadline passed before this step");
      return inner.chat(req, { ...opts, signal });
    },
  };
}

async function runSession(p: {
  prompt: string;
  model: string;
  /** The wallet that signed for this session, or null for an anonymous one. */
  user: PublicKey | null;
  /** Why a supplied signature was not accepted, when one was supplied. */
  authNote: string | null;
  cap: bigint;
  server: Keypair;
  /** The chain to run on, or null for the console's own agents. */
  target: Target | null;
  send: (event: string, data: unknown) => void;
  /** Registers a teardown the request runs when its stream ends, however it ends. */
  onEnd: (fn: () => void) => void;
  /** The allowance this session was admitted on, read once by the handler. */
  billed: Awaited<ReturnType<typeof chainBilling>>;
  /** What it may spend: the operator's model key, or the scripted transport. A refusal never
   * reaches here — the handler answers it with a 402 before the stream opens. */
  spend: Exclude<SessionSpend, { refuse: string }>;
  /** Aborted when the request's deadline passes. The model call and the session's tail stop on it. */
  signal: AbortSignal;
}) {
  const { prompt, model, server } = p;
  const r = p.target ? p.target.roles : roles(server);
  const rpc = createRpc(RPC_URL, PHOTON_URL, PROVER_URL, { commitment: "confirmed" });
  // Epoch blobs go to the configured locator backend (`runner.ts`: the trace directory, or
  // Irys); trace preimages stay in the directory `/api/traces` serves by hash.
  const backend = await traceBackend(server);
  // The blobs on disk, keyed by the hash the chain commits, in the clear: every blob the runtime
  // puts — the prompt, each tool's args and result, the final output — re-hashes to its name.
  const stored = new FileTraceStore(TRACE_DIR);

  // A deployed agent may allow fewer tools than the runtime ships. Anything it named that does
  // not exist here is dropped. A policy that named tools and kept none of them gets none: an
  // allow-list that fails open would hand a restricted agent the whole catalogue.
  const named = p.target?.policy?.tools;
  const toolNames = named && named.length > 0 ? named.filter((t) => TOOL_NAMES.includes(t)) : undefined;

  const top = r.agent;
  /**
   * How this session pays the provider, decided **per agent** and here, where the agent's
   * `Keypair` is a local.
   *
   * Two gates. `railFor` is the first: with no `LATH_TEMPO_TREASURY` there is nothing that can
   * sign a voucher and nothing else to fall back to, so the answer is `scripted` whatever an
   * agent's row says — which is what makes the `--e2e` pin a guarantee rather than a default. The
   * second is this route's own admission rule: only a session with a live allowance behind it
   * spends the operator's money on inference. An anonymous or
   * unbilled session would otherwise spend the treasury's USDC.e, so it stays scripted.
   */
  const rail = p.spend.model === "openrouter" ? railFor(recordedRail(p.target), true) : "scripted";
  /**
   * The channel the session pays through, on the `tempo` rail. One per `start()`, opened lazily
   * by the transport on its first call and closed once by the runtime at the Resolution — never
   * scoped to the run slot, which lapses on a TTL under a wedged drain. The ceiling and
   * the step cap are the ones the vault meters against, so the deposit cannot outlive the
   * session's own budget.
   */
  const opened =
    rail === "tempo"
      ? await openTempoChannel({
          // Per call, not per session: the deposit this sizes is `× (MAX_STEPS + 1)`, and handing
          // over the session's whole cap would ask the treasury for seven times it.
          maxCostBase: perCallCeiling(p.cap, MAX_STEPS),
          maxSteps: MAX_STEPS,
          agentId: hex(idFromString(top.name)),
        })
      : null;
  const channel = opened && "channel" in opened ? opened.channel : null;
  /**
   * Why a session that was admitted to spend is scripted after all: a treasury that cannot cover
   * the whole deposit, or one that could not be read. Reported on `session:init` and never fatal
   * — the session runs and the records are written; only the model is a script.
   */
  const tempoNote = opened && "degrade" in opened ? opened.degrade : null;

  /**
   * Why this session's inference is what it is, in one sentence for the caller. The order is the
   * order the decisions were made in: admission first (`sessionSpend`), then whether the treasury
   * could actually pay. A billed session that has a channel needs no explanation and gets none.
   */
  const inferenceNote =
    p.authNote && !p.user
      ? `anonymous (${p.authNote}): scripted inference, unbilled`
      : p.spend.model === "scripted"
      ? p.spend.note
      : tempoNote ??
        (channel
          ? null
          : // Admitted to spend, no channel and no reason recorded: the treasury is off, which is
            // the whole of the answer, since there is no model key behind it.
            "this deployment has no Tempo treasury configured: scripted inference, unbilled");

  const topId = idFromString(top.name);
  const topClient = LathClient.fromIdl(rpc, top.key);
  // A probe that could not read the program runs this one session without epochs, but is not
  // remembered: the next session asks again.
  const epochs = await epochsSupportedOrNot(rpc, topClient.programId);
  const registry = new LocatorRegistry(topClient, topId);
  /**
   * The session's trace store, wrapped so that everything it writes can be sealed into one
   * bundle when the session ends (`sdk/src/bundle.ts`). The blobs still land in the directory
   * `/api/traces` serves; the bundle is a second copy, made once, for readers who are not this
   * console — one upload and one cell instead of one of each per blob.
   */
  const session = new RecordingTraceStore(stored, { backend, registry });

  // The gateway is OpenRouter itself and therefore real inference — it simply takes a payment
  // channel where a keyed call took a bearer token. Read off the channel rather than the rail: a
  // session the treasury could not cover has no channel, and there is nothing else to run on.
  const inference = channel ? "openrouter" : "scripted";

  // The batcher's own probes, built once here so the fee and balance on screen are the reads the
  // batcher will act on. The top agent's key is what pays for its epochs.
  const refused: { at: Refusal | null } = { at: null };
  const topSignals = sessionSignals(topClient, top.key.publicKey, (r) => (refused.at = r));
  // Sampled through the plain probes: this read is what the console prints, and a low balance
  // here is not yet a refusal — the batcher reads again when it opens its first epoch, and only
  // that read is reported as one.
  const probes = topClient.chainSignals();
  const [feeSample, topBalance] = await Promise.all([
    probes.priorityFee!().catch(() => null),
    probes.payerBalance!().catch(() => null),
  ]);
  // Fees are measured on the server key, which pays for the writes. When that key *is* the top
  // agent's, one read serves both.
  const startLamports =
    top.key.publicKey.equals(server.publicKey) && topBalance !== null
      ? topBalance
      : await rpc.getBalance(server.publicKey);

  // Billing: real when the user funded this authority; otherwise unbilled, and said so. Read by
  // the handler, not here: it is the same read that decided whether this session may run at all
  // (`sessionSpend`), and reading it twice could answer differently the second time.
  const { billing, billingState } = p.billed;

  /**
   * The writer queue this session journals into, and the chain it is about to write. The queue
   * outlives the request — it is what drains a record after the answer has been given — so the
   * key that signs for this chain and the backend its charges go through are handed to it here.
   */
  const queue = anchorQueue();
  bindAnchorChain(topId, { client: topClient, billing });

  /**
   * Fees as they are paid. Every event that carries a signature is a transaction that has
   * confirmed, so one balance read after it turns `startLamports − balance` into a measured
   * number rather than an estimate. The reads are chained so late samples cannot overtake
   * earlier ones, and a failed read simply leaves the last number standing.
   */
  let feeTail: Promise<void> = Promise.resolve();
  /**
   * What this session has spent on the `tempo` rail, USDC.e base units, summed from the vouchers
   * the records commit. It rides on `session:fees` rather than in a second total of its own: a
   * session has one bill, and the two currencies behind it are two columns of it — the lamports
   * the chain writes cost and the USDC.e the provider was paid.
   */
  let tempoSpent = 0n;
  /** The channel is announced once, on the first voucher that names it. */
  let tempoAnnounced = false;
  const send = (event: string, data: any) => {
    p.send(event, data);
    // A journaled record carries an empty signature until the queue lands it, and nothing has
    // been paid for a transaction that has not been sent: the anchor event that follows is what
    // moves the balance, and it carries the real signature.
    if (typeof data?.signature !== "string" || data.signature === "") return;
    feeTail = feeTail.then(async () => {
      const lamports = await rpc.getBalance(server.publicKey).catch(() => null);
      if (lamports === null) return;
      p.send("session:fees", {
        payer: server.publicKey.toBase58(),
        startLamports,
        lamports,
        lamportsSpent: Math.max(0, startLamports - lamports),
        // Absent on the vault rail, where nothing was paid on Tempo at all.
        ...(channel ? { tempoPayer: channel.payer, tempoBaseUnits: tempoSpent.toString() } : {}),
      });
    });
  };

  /**
   * Every transition of this chain's writer queue, as a `runtime` event of its own kind. The
   * subscription is dropped when this request ends: the queue outlives it, and a stream that has
   * closed must not keep a listener alive.
   */
  p.onEnd(subscribe(topId, (e) => send("runtime", { type: "anchor", agentName: top.name, ...e })));

  send("session:init", {
    cluster: CLUSTER,
    programId: topClient.programId.toBase58(),
    epochs,
    inference,
    inferenceNote: inferenceNote ?? null,
    /** Null unless the `tempo` rail was asked for and could not be used; see `tempoNote` above. */
    tempoNote,
    auth: p.user ? "wallet" : "anonymous",
    model,
    billing: billingState,
    user: p.user?.toBase58() ?? null,
    capMicroUsdc: p.cap.toString(),
    authority: server.publicKey.toBase58(),
    /** Lamports the fee-paying key held before the first write; `session:done` reads it again. */
    startLamports,
    /**
     * What the cluster said when the session opened, sampled with the same `chainSignals()`
     * probes the epoch batcher uses: the median of the recent prioritization fees, and the
     * lamports the agent's own key holds. `minPayerLamports` is the floor below which the
     * batcher refuses to open an epoch at all.
     */
    signals: {
      priorityFeeMicroLamports: feeSample,
      payerBalanceLamports: topBalance,
      payer: top.key.publicKey.toBase58(),
      minPayerLamports: epochs ? DEFAULT_MIN_PAYER_LAMPORTS : null,
      sampledAt: Date.now(),
    },
    agents: {
      top: { name: top.name, id: hex(topId), authority: top.key.publicKey.toBase58() },
    },
  });

  // Setup: funding, registration, names. Each of these is a real write the first time only.
  if (!top.key.publicKey.equals(server.publicKey)) {
    send("session:setup", { phase: "funding", detail: top.name });
    const sig = await ensureFunded(rpc, server, top.key.publicKey);
    if (sig) send("session:setup", { phase: "funded", detail: top.name, signature: sig });
  }
  send("session:setup", { phase: "registering", detail: `${top.name} on ${CLUSTER}` });
  await ensureAgent(topClient, topId, top.name);

  /**
   * Every runtime event, as SSE. An `epoch` event also carries `anchorAttempts`: how many uploads
   * its blob took before it was anchored or fell back, read off the store that made them. It is
   * read here rather than carried on the event because the retry lives in the SDK's committer and
   * the runtime's `epoch` event predates it; the store counts the same `put` calls the committer
   * made, so the two numbers are the same number.
   */
  const forward =
    (agentName: string, epochs?: AnchoredEpochStore, answers = false) =>
    (e: RuntimeEvent) => {
      const attempts = e.type === "epoch" && e.epochRoot && epochs ? epochs.uploadAttempts(e.epochRoot) : undefined;
      send("runtime", { ...e, agentName, ...(attempts ? { anchorAttempts: attempts } : {}) });
      // The `tempo` rail, as it happens. The channel is announced from the first voucher rather
      // than from the transport, because the transport has no channel until the first call opens
      // one; the voucher itself is per Action and carries exactly what that record commits, so a
      // reader can check the panel against the chain.
      if (e.payment) {
        if (!tempoAnnounced) {
          tempoAnnounced = true;
          p.send("session:tempo:channel", { payer: e.payment.payer, channelId: e.payment.channelId });
        }
        const delta = BigInt(e.payment.cumulativeAfter) - BigInt(e.payment.cumulativeBefore);
        tempoSpent += delta > 0n ? delta : 0n;
        p.send("session:tempo:voucher", {
          seq: e.seq ?? null,
          cumulativeBefore: e.payment.cumulativeBefore,
          cumulativeAfter: e.payment.cumulativeAfter,
          usageCost: e.payment.usageCost,
        });
      }
      // The reply again, now with the resolution's seq and head: the first `session:answer`
      // went out from `onAnswer` before the closing epoch flush, because that flush drains the
      // queue (the epoch's locator cell must land before the resolution can be journaled) and
      // the answer must not wait for it.
      if (answers && e.type === "resolution") {
        p.send("session:answer", {
          output: e.output ?? "",
          seq: e.seq ?? null,
          head: e.head ?? null,
          status: e.status ?? null,
        });
      }
    };

  // The session's system prompt: the deployed agent's template when it carries one, which is
  // what puts `promptHash` in this genesis and the prompt bytes in the trace store. A console
  // agent, and a deployed agent whose template has no prompt, run the prompt below unhashed —
  // hashing it would move the genesis hash of every chain that ran without a template prompt.
  const { system, promptHash } = await templateSystemPrompt(
    p.target?.source === "deployed" ? lookupAgent(hex(topId)) : null,
    session,
    `You are an autonomous agent running on Solana ${CLUSTER}; every tool call you make is anchored on that cluster's chain. ` +
      "Use the tools to answer, then reply in two sentences. If you need the web, use web.search and web.fetch_page; " +
      "if a tool you need is not offered, say so plainly."
  );

  const makeRuntime = (
    who: { key: Keypair; name: string },
    client: LathClient,
    transport: ChatTransport,
    extra: {
      delegates?: any[];
      bill?: NoopBilling | BillingClient;
      toolNames?: string[];
      signals?: ChainSignals;
      /** Tools kept for the policies that name them, offered under the same condition they were. */
      retired?: ToolDefinition[];
      /**
       * Journal this agent's records and anchor them in the background. Only the top agent gets
       * one: a delegate's records are written synchronously, because the parent's Delegation
       * commits to a child chain that has already landed.
       */
      anchor?: { queue: AnchorQueue; drain: boolean };
      /**
       * The Tempo channel this agent pays through, on that rail. The top agent only: a delegate
       * runs on the vault rail in this build, because the channel is the session's and a child
       * session would need one of its own.
       */
      tempo?: TempoChannel;
    }
  ) => {
    const id = idFromString(who.name);
    const registry = new LocatorRegistry(client, id);
    // Built before the runtime so the event forwarder can read its upload counts.
    const epochStore = epochs ? new AnchoredEpochStore(backend, registry) : undefined;
    let self: AgentRuntime | undefined;
    // A store write mid-session goes through the runtime, which lands the journal ahead of it.
    const writeCell: CellWriter = (w) => (self ? self.writeCell(w) : w());
    const all = [...consoleTools(rpc, client, id, "session", writeCell), ...(extra.retired ?? [])];
    // A policy that names no tools gets every tool, which must not include the opt-in ones: the
    // pre-rename aliases exist only to answer a stored allow-list that still asks for them, and
    // the store tools would move the policy hash of every agent deployed without them.
    const picked = extra.toolNames
      ? all.filter((t) => extra.toolNames!.includes(t.name))
      : all.filter((t) => !OPT_IN_TOOL_NAMES.includes(t.name));
    self = new AgentRuntime({
      client,
      agentId: id,
      transport,
      store: session,
      storePayloads: true,
      billing: extra.bill ?? new NoopBilling(),
      maxSteps: MAX_STEPS,
      rollup: epochStore
        ? {
            store: epochStore,
            batchSize: DEFAULT_AGENT_DYNAMIC_CONFIG.standardBatchSize,
            // Fee- and balance-aware: commit early when fees are low, refuse to open an epoch
            // the payer cannot fund — and report the numbers a refusal was made on.
            signals: extra.signals ?? sessionSignals(client, who.key.publicKey, (r) => (refused.at = r)),
          }
        : undefined,
      onEvent: forward(who.name, epochStore, !!extra.anchor),
      anchor: extra.anchor,
      tempo: extra.tempo,
      policy: {
        model,
        temperature: 0.2,
        toolAllowList: [...picked.map((t) => t.name), ...(extra.delegates?.length ? ["delegate"] : [])],
        maxCost: Number(p.cap),
        promptHash,
        // Part of `policy_version_hash` only on the `tempo` rail: the atomicity claim a session
        // makes is different there, so a genesis event commits which of
        // the two it ran under. `vault` is normalised away by `toRuntimePolicy`, so no hash
        // already on devnet moves.
        ...(extra.tempo ? { payment: "tempo" as const } : {}),
      },
      tools: picked,
      delegates: extra.delegates,
      system,
    });
    return self;
  };

  /**
   * The tools that are gone but still named by policies already deployed
   * (`runtime/src/retired-tools.ts`). A session's `policy_version_hash` commits to the tool list it ran
   * with, so the retired entry is offered under exactly the condition the live one was — a
   * deployed agent running for its owner's signed wallet — and an existing agent's hash does
   * not move because the tool behind the name stopped working.
   */
  const retiredTools = () =>
    p.target?.source === "deployed" && p.user && TREASURY_ADMIN ? [retiredHireTool()] : undefined;

  const transport = abandonable(
    // The channel or a script, and nothing in between: a session the treasury cannot pay for has
    // no other way to reach a model.
    channel ??
      scriptedTransport(
        // Every chain tool, unfiltered: the script is the same three turns for every session, and
        // `toolNames` below is what decides which of them the runtime will actually run.
        scriptedTurns(CHAIN_TOOL_NAMES, hex(topId), "Read the slot and fee level; every step above is anchored."),
        "call"
      ),
    p.signal
  );
  const runtimeTop = makeRuntime(top, topClient, transport, {
    bill: billing,
    toolNames,
    signals: topSignals,
    retired: retiredTools(),
    tempo: channel ?? undefined,
    // `drain: false`: this session answers and then the queue writes. The drain is below, after
    // the bundle is sealed and before the audit, which can only replay what has landed.
    anchor: { queue, drain: false },
  });

  /**
   * Whose records the drain below is about to carry. `AgentRuntime.start` re-queues and drains
   * any journal this chain left behind before it writes a genesis — a record that never landed
   * at seq N blocks N + 1 — and does it silently: unannounced, the browser would see
   * `registering` and then a session whose first anchor events were for seqs it had never heard
   * of. The explicit retry says *retrying — n records re-queued* and this is the same sentence
   * for the same work, sent where the badge of the session that failed can still be on screen.
   */
  const carried = await queue.carried(topId);
  if (carried.length > 0) {
    send("session:setup", { phase: "retrying", detail: `${carried.length} records re-queued` });
  }

  send("session:setup", { phase: "running", detail: prompt });
  const result = await runtimeTop.start({
    user: p.user ?? server.publicKey,
    prompt,
    onToken: (delta, step) => p.send("session:token", { delta, step }),
    onAnswer: (a) => p.send("session:answer", { output: a.output, seq: null, head: null, status: a.status }),
    // The same deadline `abandonable` wraps the transport with, passed to `start()` too: the step
    // loop's only suspension point is the model call either way, and a session
    // past its deadline must stop paying for a reply nobody is reading.
    signal: p.signal,
  });

  // What became of the channel. A close that did not land is a receipt that is missing and not a
  // failed session — every call it paid for carries its own voucher in its own record — so it is
  // said here, with the channel id a retry needs, and the session goes on to its audit.
  if (result.tempo) {
    send("session:tempo:settled", {
      payer: result.tempo.payer,
      channelId: result.tempo.channelId ?? null,
      closed: result.tempo.closed,
      txHash: result.tempo.txHash ?? null,
      spent: result.tempo.spent ?? null,
      error: result.tempo.error ?? null,
    });
  }

  // A session the batcher stopped for want of lamports reports the numbers it stopped on, not a
  // sentence. The runtime turns the throw into a failed resolution, so the reason is on chain
  // too; this is the same refusal with the balance and the floor intact.
  if (refused.at && result.status !== "success") {
    send("session:error", {
      ...refused.at,
      error: result.reason ?? "the payer cannot fund an epoch",
      cluster: CLUSTER,
    });
  }

  /**
   * The chain, now. Everything above this line happened without waiting for a transaction: the
   * records are journaled with their heads computed locally, and this is where they are actually
   * written, one indexer read and one proof per record. A rejection is not a failed session —
   * the answer was given and the records are still in the journal for the `FAILED` badge to
   * re-queue — so it is reported rather than thrown.
   */
  send("session:setup", { phase: "anchoring", detail: `${queue.pending(topId).length} records queued` });
  let anchorError: string | null = null;
  try {
    await queue.drain(topId);
  } catch (e) {
    anchorError = e instanceof AnchorFailed ? e.message : (e as any)?.message ?? String(e);
  }

  /**
   * The seal: everything this session wrote, in one blob, under one cell keyed by the genesis's
   * `payload_hash` — which is what a reader holding any record of the session derives the key
   * from, so no second map is needed to find it.
   *
   * After the drain, because the seal is a chain write — the bundle registry's structure on the
   * first session and the locator cell on every one — and a cell written while this session's
   * records are still journaled takes the seq the genesis is holding. Skipped when the drain
   * failed, for the same reason: the blobs are in the trace directory and the seal can be run once
   * the records have landed.
   * Never fatal otherwise: a session that has resolved on chain is not failed by the copy made
   * for readers.
   */
  const genesis = result.events.find((e) => e.input.kind === EventKind.Genesis);

  /**
   * The abandoned session's last safe point. The records are on chain (or journaled for the
   * retry, which is the same guarantee), and everything after this line is work done *for a
   * reader* — the bundle, the seals another session owes, and an audit that re-reads the whole
   * chain. Nobody is listening: the stream closed when the deadline fired, and a session that has
   * been abandoned must stop holding the run slot for reads.
   *
   * The seal is deferred rather than dropped, exactly as a failed drain defers it, so the next
   * session or the explicit retry on this chain pays it.
   */
  if (p.signal.aborted) {
    if (genesis) {
      await deferSeal(hex(topId), {
        genesisPayloadHash: hex(genesis.input.payloadHash),
        hashes: [...session.hashes],
        at: Date.now(),
      }).catch(() => {
        /* the blobs are content-addressed in TRACE_DIR either way */
      });
    }
    send("session:setup", {
      phase: "abandoned",
      detail: `the session deadline passed; ${
        anchorError ? "its records are journaled for a retry" : "its records are on chain"
      } and the seal is deferred`,
    });
    return;
  }

  // The phase is the decision, not the intention. Sent before the `if` below, a session whose
  // drain failed would announce `sealing: n blobs` and then say nothing more — and the one reading
  // a person takes from that is the only one that is false.
  send(
    "session:setup",
    anchorError
      ? { phase: "not sealed", detail: `${session.entries.length} blobs wait for the records to land` }
      : { phase: "sealing", detail: `${session.entries.length} blobs` }
  );
  if (anchorError && genesis) {
    // The skip is not the end of it. What a deferred seal needs is the key and the blob hashes —
    // the bytes themselves are content-addressed in `TRACE_DIR` and outlive this process — so the
    // note goes on disk beside the journal and the retry below pays it once the records land.
    await deferSeal(hex(topId), {
      genesisPayloadHash: hex(genesis.input.payloadHash),
      hashes: [...session.hashes],
      at: Date.now(),
    });
  }
  const sealed: Awaited<ReturnType<typeof session.seal>> = anchorError
    ? { error: "not sealed: the session's records are not on chain yet; the retry seals it when they land" }
    : genesis
    ? await session.seal(genesis.input.payloadHash)
    : { error: "this session logged no genesis, so its bundle has no key" };
  const bundle = sealed.error
    ? { error: sealed.error }
    : {
        scheme: sealed.locator!.scheme,
        id: hex(sealed.locator!.id),
        count: sealed.count!,
        bytes: sealed.bytes!,
      };
  send("session:bundle", bundle);
  // `session:bundle` is data for a caller; this is the same fact as a line, because the chat
  // renders `session:setup` and has never rendered a bundle.
  if (!anchorError) {
    send(
      "session:setup",
      sealed.error
        ? { phase: "not sealed", detail: sealed.error }
        : { phase: "sealed", detail: `${sealed.count} blobs in one bundle` }
    );
  }

  /**
   * Any seal an *earlier* session on this chain deferred. This session's drain is what landed
   * those records — `AgentRuntime.start` re-queues a journal before it writes a genesis — so the
   * condition the skip was waiting on is met here exactly as it is on the explicit retry, and a
   * failed session that is followed by another rather than clicked should not be the one case
   * that stays unsealed for good.
   */
  if (!anchorError) {
    // A bundle is a second copy of the bytes the backend holds.
    const owed = await sealDeferred(hex(topId), { backend, registry, store: stored }).catch((e) => {
      // The session has answered and its records are on chain; a copy made for readers must not
      // be able to break the stream that is still reporting them.
      send("session:bundle", { error: `a deferred seal did not run: ${(e as any)?.message ?? e}` });
      return [];
    });
    for (const { result: r } of owed) {
      send(
        "session:bundle",
        r.error
          ? { error: r.error }
          : { scheme: r.locator!.scheme, id: hex(r.locator!.id), count: r.count!, bytes: r.bytes! }
      );
      send(
        "session:setup",
        r.error
          ? { phase: "still not sealed", detail: r.error }
          : { phase: "sealed", detail: `${r.count} blobs an earlier session left owed` }
      );
    }
  }

  // The audit is the real one, against the indexer, opening the epoch blobs it just wrote. After
  // the drain, because the indexer only knows the records that landed.
  send("session:setup", { phase: "auditing", detail: top.name });
  const report = await audit(topClient, topId, {
    epochs: new AnchoredEpochStore(backend, registry),
    store: session,
    recover: true,
  });
  send("session:audit", { report, formatted: formatReport(report) });

  const endLamports = await rpc.getBalance(server.publicKey);
  send("session:done", {
    status: result.status,
    reason: result.reason ?? null,
    output: result.output,
    steps: result.steps,
    batchedSteps: result.batchedSteps,
    epochs: result.epochs.map((e) => ({
      startSeq: e.startSeq.toString(),
      endSeq: e.endSeq.toString(),
      root: hex(e.epochRoot),
      signature: e.signature,
      /**
       * False when the blob is not where the chain would point: the upload failed and the bytes
       * went to the console's trace directory instead, so the epoch is committed with no locator
       * (`anchorError` says why). The live `epoch` event carries the same two fields; these are
       * here so the closing summary does not contradict it.
       */
      anchored: e.anchored,
      anchorError: e.anchorError ?? null,
      /** Uploads the blob took: 1 normally, more when a transient failure was retried. */
      anchorAttempts: e.anchorAttempts ?? 1,
    })),
    records: result.events.map((e) => ({
      seq: e.seq.toString(),
      kind: e.input.kind,
      signature: e.signature,
      head: hex(e.head),
    })),
    costMicroUsdc: result.costMicroUsdc.toString(),
    costUsd: result.costUsd,
    billing: billingState,
    /** The fee payer's balance either side of the session. `lamportsSpent` is the difference. */
    startLamports,
    endLamports,
    lamportsSpent: Math.max(0, startLamports - endLamports),
    head: hex(result.head),
    /**
     * Where every blob this session wrote can be fetched from by somebody who is not us: the
     * locator of the one bundle, or why there is none. `error` does not make the session
     * anything other than what it was — the chain is unchanged either way.
     */
    bundle,
    delegations: [],
    /** What the writer queue left behind: 0 pending and 0 failed is a fully anchored session. */
    anchor: await anchorSummary(topId),
    /**
     * Why a record did not land, when one did not. The answer above stands either way: it is in
     * the trace store and in this stream. What failed is the blockchain write, and the records
     * are still journaled for a retry.
     */
    anchorError,
  });
}

/**
 * Billing for one chain: real when the wallet funded an allowance for this agent's authority,
 * otherwise unbilled and said so. A session and a retry both build it, because the queue — not
 * the session — is what sends a metered record's charge, and a retry must offer it the same
 * backend the session had.
 */
async function chainBilling(
  rpc: Rpc,
  client: LathClient,
  agent: Keypair,
  user: PublicKey | null,
  cap: bigint = SESSION_CAP_MICRO
): Promise<{
  billing: NoopBilling | BillingClient;
  billingState: "charged" | "unfunded" | "no-wallet";
  /** Which half of the allowance was short, when one was: shown with the 402. */
  shortfall: string | null;
}> {
  if (!user || !TREASURY_ADMIN) return { billing: new NoopBilling(), billingState: "no-wallet", shortfall: null };
  const admin = new PublicKey(TREASURY_ADMIN);
  const reader = BillingClient.fromIdl(rpc, agent, { admin, lath: client });
  const grant = await reader.getAllowance(user, agent.publicKey);
  const spendable = await reader.spendable(user).catch(() => 0n);
  // `admitSpend` (`_lib/runner.ts`) rather than a local predicate: `cap > spent && spendable > 0n`
  // is a dust threshold that also ignores `reserved`, and the session route, the loop step and the
  // loop retry must agree. One function, one floor, three sites.
  const admitted = admitSpend({ grant, spendable, cap, maxSteps: MAX_STEPS });
  return "ok" in admitted
    ? { billing: reader, billingState: "charged", shortfall: null }
    : { billing: new NoopBilling(), billingState: "unfunded", shortfall: admitted.refuse };
}

/**
 * The `FAILED` badge's click: put every failed record for this chain back to pending and drain
 * it, under the head check that keeps a lost confirmation from becoming a duplicate record. No
 * model runs and nothing new is journaled — the records being written are the ones a session
 * already computed and already answered from.
 */
async function retryAnchor(p: {
  server: Keypair;
  target: Target | null;
  /**
   * The backend the handler admitted this retry on, or null when the chain owes no money. It is
   * not re-read here: the wallet was checked against the payers of what the journal owes before
   * the slot was taken, and building a fresh backend at this point would let an unsigned retry
   * fall back to `NoopBilling`.
   */
  billed: Awaited<ReturnType<typeof chainBilling>> | null;
  send: (event: string, data: unknown) => void;
}) {
  const r = p.target ? p.target.roles : roles(p.server);
  const top = r.agent;
  const topId = idFromString(top.name);
  const rpc = createRpc(RPC_URL, PHOTON_URL, PROVER_URL, { commitment: "confirmed" });
  const topClient = LathClient.fromIdl(rpc, top.key);
  const billing = p.billed?.billing ?? new NoopBilling();

  const queue = anchorQueue();
  /**
   * The last word on the invariant, in the place that binds: a journal entry carrying a charge
   * is never drained through a backend that cannot charge. The handler refuses such a retry with
   * a status before it gets here, so this throws only if a future caller reaches `retryAnchor`
   * by another road — and a throw leaves the entries journaled, which is the safe half.
   */
  const owed = await drainOwed(topId);
  if (owed.payers.length > 0 && !(billing instanceof BillingClient)) {
    throw new Error(
      `this chain owes ${(Number(owed.microUsdc) / 1e6).toFixed(6)} USDC and no billing backend is bound for it; ` +
        "the records stay journaled rather than settle unpaid"
    );
  }
  bindAnchorChain(topId, { client: topClient, billing });
  const unsubscribe = subscribe(topId, (e) => p.send("runtime", { type: "anchor", agentName: top.name, ...e }));
  try {
    let anchorError: string | null = null;
    try {
      // `retry` first, then the count: a journal written by a process that is gone is only read
      // when the queue is asked about that chain, so before this the queue knows of no records.
      await queue.retry(topId);
      p.send("session:setup", { phase: "retrying", detail: `${queue.pending(topId).length} records re-queued` });
      await queue.drain(topId);
    } catch (e) {
      anchorError = e instanceof AnchorFailed ? e.message : (e as any)?.message ?? String(e);
    }

    /**
     * The seal the failed session could not write. Only after a clean drain, because that is the
     * condition it was waiting on: a locator cell written while a record is still journaled takes
     * the seq that record is holding. The blobs are read back out of the trace directory
     * by the hashes the note carries, so this is the same bundle the session would have made.
     *
     * Reported as `session:bundle`, the event the browser already renders for a seal, so the
     * *not sealed* line on the failed message turns into a locator without a new surface.
     */
    if (!anchorError) {
      const server = loadKeypair();
      const owed = server
        ? await sealDeferred(hex(topId), {
            backend: await traceBackend(server),
            registry: new LocatorRegistry(topClient, topId),
            store: new FileTraceStore(TRACE_DIR),
          }).catch((e) => {
            // The records are on chain, which is what the retry was for. A seal that could not be
            // run is reported and tried again next time, never thrown at a retry that succeeded.
            p.send("session:bundle", { error: `a deferred seal did not run: ${(e as any)?.message ?? e}` });
            return [];
          })
        : [];
      for (const { result } of owed) {
        p.send(
          "session:bundle",
          result.error
            ? { error: result.error }
            : {
                scheme: result.locator!.scheme,
                id: hex(result.locator!.id),
                count: result.count!,
                bytes: result.bytes!,
              }
        );
        p.send(
          "session:setup",
          result.error
            ? { phase: "still not sealed", detail: result.error }
            : { phase: "sealed", detail: `${result.count} blobs this message left owed` }
        );
      }
    }

    const summary = await anchorSummary(topId);
    p.send("session:done", {
      // A retry writes; it does not answer. The status is the queue's, and the session's own
      // status stays whatever the session said it was.
      status: summary.failed > 0 ? "anchor-failed" : "anchored",
      retry: true,
      anchor: summary,
      anchorError,
    });
  } finally {
    unsubscribe();
  }
}
