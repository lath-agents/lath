/**
 * Loops: start one on a deployed agent, list what this server is running,
 * pause/resume/stop/archive.
 *
 * A start carries either the long body or `{ templateId, version? }`, which is the same body
 * read back out of a stored loop template — what *Run again* posts. Both together are *run again
 * with edits*: the long body is the run's terms and the template is what they are appended to as
 * a new version, rather than a second lineage for one asset. A loop is stepped by the clock: a body
 * naming an oracle `trigger` or a `gate` is refused, since neither is in this build. Archive is an
 * action on this POST rather than a `DELETE`, for the reason there is no `DELETE`: nothing is deleted. An
 * archived run keeps its record, its steps and its `?id=`; it leaves the list. `unarchive` is its
 * inverse, because a one-way button is a delete by another name — it brings the record back and
 * restarts nothing, since a stopped run gets a successor through *Run again* and never a revival.
 * `retry` is the one action that is neither: a run stopped because its chain writes would not
 * land has its records put back on the writer queue and, if they land this time, goes back on its
 * schedule. It re-runs nothing — the work is done and in the trace store, and only the
 * transactions are owed.
 *
 * A loop is an agent that keeps running, so everything ownership-shaped about `/api/run` holds
 * here too: a deployed agent's chain is its owner's history, and only the wallet that deployed
 * it may make it write. The signature purpose is its own — `"Lath loop"` — so a session or a
 * deploy signature cannot be replayed into starting a loop that spends an allowance for hours.
 *
 * `GET` is open, and answers every reader the same: what is running, how far each loop has got,
 * its terms and texts, and the per-step summaries the console renders. The browser checks the steps
 * themselves against the chain (`sdk/src/loops.ts`, `verifyStep`), so nothing here has to be believed.
 *
 * The scheduler lives in `../_lib/loops.ts`; this file is the door to it.
 */
import { NextRequest } from "next/server";
import {
  CLUSTER,
  RPC_URL,
  SESSION_CAP_MICRO,
  SessionAuth,
  callerIp,
  consoleOrigin,
  loadKeypair,
  loopAuthBinding,
  rateLimit,
  verifyAuth,
  walletIn,
} from "../_lib/runner";
import {
  JEV_BUDGET_PERCENT,
  LOOP_BUDGET_MAX_MICRO,
  LOOPS_PER_WALLET,
  MAX_STEPS,
  MIN_INTERVAL_MS,
  archiveLoop,
  boundedEnvNumber,
  checkSourcesAction,
  pauseLoop,
  treasuryHeld,
  publicLoop,
  readLoop,
  readLoops,
  resumeLoop,
  retryLoopAnchor,
  discardLoopAnchor,
  loopReceiptView,
  pluginsListFields,
  attestListFields,
  resumeRefusal,
  retryRefusalNow,
  stopLoop,
  syncScheduler,
  unarchiveLoop,
  type LoopRecord,
  type LoopStartStage,
} from "../_lib/loops";
import { REBUILT_REFUSAL, type LifecycleActorContext } from "../_lib/lifecycle";
import { answerLoopStart, streamLoopStart, wantsStartStream } from "../_lib/loop-start";
import { readCapped } from "../rpc/proxy";
import { betaRefused } from "../_lib/beta";
import { loopKeyState, loopKeysEnabled, type LoopKeyState } from "../_lib/tempo-keys";
import type { LoopTempoKeyView, LoopView } from "../../../types/loop";
import type { CheckSourcesResponse } from "../../../lib/loops";

/**
 * How long a loop page's read waits on Tempo for its key's state, and how long an answer is reused.
 * The page polls `?id=` every two to ten seconds, and a Tempo that is slow or down must neither
 * hold the whole answer — budget, steps, controls — behind one RPC read nor be asked again on every
 * poll; a limit that moves at most once per deposit reads the same for a quarter of a minute.
 *
 * The read itself is cached, not its answer: the promise goes into the map the moment it is made,
 * so N anonymous GETs of the same keyed loop that arrive together share one Tempo read rather than
 * firing N from the console's address — the paid-read exposure `tempo/treasury/route.ts` closes
 * the same way. The cached promise never rejects (a throw resolves to `null`), and a `null` is dropped
 * once it settles, so the next poll asks again rather than reading _not readable_ for the window;
 * calls in flight together still share the one read. The 4 s race is per caller, on the shared
 * promise, so a slow Tempo bounds every waiter without starting a second read.
 */
const TEMPO_KEY_READ_MS = 4_000;
const TEMPO_KEY_CACHE_MS = 15_000;
const tempoKeyStates = new Map<string, { at: number; state: Promise<LoopKeyState | null> }>();

/** `loopKeyState`, bounded in time and reused briefly; `null` when Tempo did not answer, a throw included. */
async function keyStateOf(key: NonNullable<LoopRecord["tempoKey"]>): Promise<LoopKeyState | null> {
  const id = `${key.address.toLowerCase()}:${key.token.toLowerCase()}`;
  let hit = tempoKeyStates.get(id);
  if (!hit || Date.now() - hit.at >= TEMPO_KEY_CACHE_MS) {
    // An RPC error and a console whose key module is not built read alike: the page says _not
    // readable_ beside the committed terms, which stand on their own.
    const state = Promise.resolve()
      .then(() => loopKeyState({ address: key.address, token: key.token }))
      .catch(() => null);
    const entry = { at: Date.now(), state };
    tempoKeyStates.set(id, entry);
    // Drop a failed read once it settles, but only if it is still the entry in the map.
    void state.then((s) => {
      if (s === null && tempoKeyStates.get(id) === entry) tempoKeyStates.delete(id);
    });
    hit = entry;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      hit.state,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TEMPO_KEY_READ_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The loop's access key for its page: the terms the
 * row committed, which are the policy's `tempoKey` and public on both chains, and what Tempo says of
 * the key now. Everyone reads it, like the budget. `null` on a loop started without a key. Built
 * field by field, so nothing the row may later carry reaches the wire unasked; the row holds no key
 * file path (`LoopRecord.tempoKey`), and this never adds one.
 */
async function tempoKeyViewOf(loop: LoopRecord): Promise<LoopTempoKeyView | null> {
  const key = loop.tempoKey;
  if (!key) return null;
  const state = await keyStateOf(key);
  return {
    address: key.address,
    token: key.token,
    limitBase: key.limitBase,
    // The committed expiry, not Tempo's: it is what the policy hash covers, and it reads when
    // Tempo does not.
    expiry: key.expiry,
    ...(key.authorizeTx ? { authorizeTx: key.authorizeTx } : {}),
    // The committed scopes, as the policy carries them: what the page says the key can call.
    ...(key.scopes ? { scopes: key.scopes } : {}),
    remaining: state ? state.remaining : null,
    isRevoked: state ? state.isRevoked : null,
  };
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Two limits, not one. `LOOPS_PER_HOUR` is `_lib/loop-terms.ts`'s, because a deploy that carries a loop
 * charges the same counter. Pause, resume, stop, archive and unarchive only write a JSON row, and
 * a person watching a loop uses several of them per start; counting both against eight would
 * refuse the next *Run again* because the last run was paused twice. Separate keys, so neither
 * spends the other's budget.
 */
// Bounded like `_lib/loop-terms.ts`'s own limits: a malformed value is the default, not a `NaN` that no
// count is ever over.
const LOOP_COMMANDS_PER_HOUR = Math.floor(
  boundedEnvNumber("LATH_LOOP_COMMANDS_PER_HOUR", process.env.LATH_LOOP_COMMANDS_PER_HOUR, 60, { min: 0 })
);

/** Every verb that is not `start`, so an unrecognised one can be refused by name rather than
 * falling through to whichever branch the ternary chain happens to end on. */
const LOOP_COMMANDS = ["pause", "resume", "stop", "archive", "unarchive", "retry", "discard"] as const;

/**
 * The commands the closed beta asks about (`_lib/beta.ts`): the ones that start paid work on a
 * loop that already exists. A start is asked separately, and every other verb is the owner's
 * whatever the list says — see where `POST` asks.
 */
const BETA_GATED_COMMANDS: ReadonlySet<string> = new Set(["resume", "retry"]);

/** The wallet the signed message names, before anything is verified. */
export async function GET(req: NextRequest) {
  // Every request is also the heartbeat: a server that restarted picks its loops back up here.
  syncScheduler();
  const id = req.nextUrl.searchParams.get("id");
  const owner = req.nextUrl.searchParams.get("owner");
  const agent = req.nextUrl.searchParams.get("agent")?.toLowerCase();
  // Archived runs are hidden from the list and nowhere else: `?id=` below resolves one, so a
  // loop page, its step history and any audit link into it keep working after an archive.
  const withArchived = req.nextUrl.searchParams.get("archived") === "1";

  const limits = {
    minIntervalMs: MIN_INTERVAL_MS,
    maxSteps: MAX_STEPS,
    loopsPerWallet: LOOPS_PER_WALLET,
    sessionCapMicroUsdc: SESSION_CAP_MICRO.toString(),
    // The most one loop's whole budget may be, and Lath's Jev share of a budget, so the form's
    // budget field and its _Jev: up to n% of it, paid by Lath_ line say what the server applies.
    // Additive: an older page reads neither.
    loopBudgetMaxMicroUsdc: LOOP_BUDGET_MAX_MICRO.toString(),
    jevBudgetPercent: JEV_BUDGET_PERCENT,
    // Whether each new loop pays through its own Tempo access key (`LATH_TEMPO_LOOP_KEYS`), so the Tempo
    // tab can say so as a fact rather than "a loop can". Additive: an older page reads `undefined` and
    // says neither.
    tempoLoopKeys: loopKeysEnabled(),
  };

  if (id) {
    const loop = readLoop(id);
    if (!loop) return Response.json({ error: "no loop with that id" }, { status: 404 });
    // The key on the one-loop read only: a list would make one Tempo read per row on every poll,
    // and no list draws a key. Added after `publicLoop`, so every other field is the one it was. The read
    // is bounded in time, so a slow Tempo never holds the answer up.
    const tempoKey = await tempoKeyViewOf(loop);
    // The receipt from the row alone: no chain read, so nothing to wait on.
    const view: LoopView = { ...publicLoop(loop), tempoKey, receipt: loopReceiptView(loop) };
    return Response.json({ cluster: CLUSTER, limits, loop: view });
  }

  const loops = Object.values(readLoops())
    .filter((l) => (withArchived ? true : !l.archivedAt))
    .filter((l) => (owner ? l.owner === owner : true))
    .filter((l) => (agent ? l.agentId === agent : true))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => publicLoop(l));
  // Whether this console takes protocol plugins on a start (`LATH_PROTOCOL_PLUGINS`), so the form offers
  // the _Protocol plugins_ section only where a start carrying them would not be refused, and — when on
  // and the seed script has run — the demo issuer whose `receipt` is the pointer SAS · receipt sends
  // (`attestDemo`, `null` when off or not seeded).
  return Response.json({ cluster: CLUSTER, limits, loops, ...pluginsListFields(), ...attestListFields() });
}

interface Body {
  action?: "start" | "pause" | "resume" | "stop" | "archive" | "unarchive" | "retry" | "discard" | "check-sources";
  /** `check-sources` only: the inputs to resolve. Shape-checked by the fetcher (`parseSourceInputs`). */
  sources?: unknown;
  /**
   * The sandbox every step opens: tool switches, the workspace cap, sources.
   * Typed as the wire shape and checked in `checkSandboxConfig`, for the reason every other term here is.
   */
  sandbox?: unknown;
  id?: string;
  /**
   * Start from a stored loop template instead of the long body, or — with the long body beside it —
   * the template this start's terms are appended to, which is *run again with edits*.
   * `planLoopStart` decides which of the two a body is and owns every refusal either can earn.
   */
  templateId?: string;
  /** Which version of it; the latest when omitted. */
  version?: number;
  /** Fork the named template into a new lineage instead of appending to it. */
  fork?: boolean;
  agentId?: string;
  prompt?: string;
  intervalMs?: number;
  maxSteps?: number;
  /**
   * The loop's one overall budget, micro-USDC. An older client sends `budgetMicroUsdcPerStep`
   * instead, and `checkLoopBudget` derives the budget.
   */
  budgetMicroUsdc?: string;
  budgetMicroUsdcPerStep?: string;
  model?: string;
  /**
   * What decides a step: `{ kind: "schedule" }`, the default and the only one
   * this build starts; a `request`, `feed` or `gate` trigger is refused. Typed as the wire shape and
   * checked in `checkLoopRequest`, because the rules that refuse a start all live where a test can
   * reach them (`_lib/loops.ts`).
   */
  trigger?: unknown;
  /**
   * Ask for a second model to judge every step before its output becomes memory: `true` for the
   * defaults, `{ model?, minConfidence? }` to pin either, absent for a loop without a judge. Typed as
   * the wire shape and checked in `checkVerify`, because the rules that refuse a start all live where a
   * test can reach them (`_lib/loops.ts`).
   */
  verify?: unknown;
  /**
   * The team a run would hand each step's tasks to: agents the wallet already holds, a blueprint and
   * a count, or a policy and a count, with one model for the team and a per-task budget. Teams are on
   * the roadmap, so `checkWorkersRequest` refuses any; typed as the wire shape and checked there,
   * because the rules that refuse a start all live where a test can reach them (`_lib/loops.ts`).
   */
  workers?: unknown;
  /**
   * What a `gate` trigger watches. Gated loops are not in this build, so
   * `checkLoopRequest` refuses a body carrying one rather than drop a term the signature binds.
   */
  gate?: unknown;
  /**
   * Protocol-plugin grants, which an older client may still send, bound by the signature with the rest
   * of the body (`Request ID`). Typed as the wire shape and refused by `checkGrants` whatever
   * LATH_PROTOCOL_PLUGINS says, rather than dropped: they are not in this build. A start only: no other
   * verb reads it.
   */
  grants?: unknown;
  auth?: SessionAuth;
}

/** The most `POST` reads of a request body before it refuses it; `/api/run` reads 256 KiB too. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Why a loop command is refused on the loop record alone, or `null` — the preconditions `POST`
 * checks before it charges the command counter. Only reads the record and whether the
 * scheduler is stepping it: a check that needs the chain belongs after the charge.
 */
function commandRefusedLocally(action: string, loop: LoopRecord): string | null {
  // A row rebuilt from the chain is another console's run as its chain tells it (`_lib/lifecycle.ts`):
  // nothing here steps it, so nothing here may move it either — a status written here would be one the
  // chain does not have. Archive of a stopped one only hides it, and unarchive shows it again.
  if (loop.lifecycle?.rebuilt && !["archive", "unarchive"].includes(action)) return REBUILT_REFUSAL;
  if (loop.lifecycle?.rebuilt && action === "archive" && loop.status !== "stopped") return REBUILT_REFUSAL;
  // Stopped, out of steps, out of budget, or a resume the start's own rules
  // would refuse — another loop running on the agent, another run's settle, the wallet's
  // cap — each read from the loop store, so refused here, before the command is charged.
  if (action === "resume") {
    const refused = resumeRefusal(loop);
    if (refused) return refused;
  }
  // A stop is one way out, taken once. A second one would rewrite the first's reason — `goal-reached`,
  // which owes the run its receipt, or `anchor-failed`, which Discard reads below — to `stopped`
  // (`stopLoop` keeps it too, for the stops the server makes on its own).
  if (action === "stop" && loop.status === "stopped") return "this loop is already stopped";
  if (action === "discard" && (loop.status === "running" || loop.stopReason !== "anchor-failed")) {
    return "only a run stopped on anchor-failed has journaled writes to discard";
  }
  return null;
}

export async function POST(req: NextRequest) {
  syncScheduler();
  if (!loadKeypair() || !RPC_URL) {
    return Response.json({ error: "the server has no runtime keypair or RPC configured" }, { status: 503 });
  }

  // Read whole and capped before it is parsed, as `/api/run` reads its own: this runs before the
  // signature and before any bucket, and `req.json()` would parse whatever Next's body clone let
  // through — 10 MB of `[{},{},…]` is seconds of a blocked event loop and hundreds of MB
  // of heap per anonymous request, every step, SSE stream and heartbeat waiting behind it. The
  // largest real body — a 2 000-character instruction and goal, eight sources, a team's slot
  // prompts, a gate and a signature — is a few tens of KiB.
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === null) {
    return Response.json({ error: `the request is too large (${MAX_BODY_BYTES / 1024} KiB at most)` }, { status: 413 });
  }
  // What does not parse is an empty body, and so is a value that is not an object.
  let body: Body = {};
  try {
    const parsed = JSON.parse(raw);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    body = {};
  }

  // _Check sources_, before the signature check and unsigned on purpose:
  // it starts nothing, spends nothing and keeps nothing, and asking for a `"Lath loop"` message here
  // would be a second wallet prompt in front of the one the start asks for — the prompt the check
  // exists to make safe to sign. What bounds a stranger making this server fetch is the
  // per-caller limit and the fetcher's own SSRF rules (`_lib/sources.ts`), which the start's fetch
  // follows too. Answered as `CheckSourcesResponse`, a refusal included, so the form can put it
  // against the row it names; never a 401.
  if (body.action === "check-sources") {
    const answer = await checkSourcesAction(body.sources, callerIp(req));
    return Response.json(answer.body satisfies CheckSourcesResponse, { status: answer.status });
  }

  const verified = verifyAuth(
    body.auth,
    body.auth ? walletIn(body.auth.message) : null,
    "Lath loop",
    loopAuthBinding(body),
    consoleOrigin(req)
  );
  if (!("wallet" in verified)) {
    return Response.json(
      { error: `a wallet signature is required to run a loop: ${verified.reason}` },
      { status: 401 }
    );
  }
  const wallet = verified.wallet.toBase58();
  const action = body.action ?? "start";
  const caller = `${wallet}:${callerIp(req)}`;

  if (action !== "start") {
    // A verb this server does not know is refused by name rather than falling through to `stopLoop`,
    // where a typo — or a newer front end talking to an older server — would stop a running, billed
    // schedule and be answered 200. The sibling routes refuse an unknown action the same way, and
    // this refuses before the counter, because a refusal obtains nothing.
    if (!(LOOP_COMMANDS as readonly string[]).includes(action)) {
      return Response.json(
        { error: `unknown action: ${action}; expected ${LOOP_COMMANDS.join(", ")}` },
        { status: 400 }
      );
    }
    const loop = body.id ? readLoop(body.id) : null;
    if (!loop) return Response.json({ error: "no loop with that id" }, { status: 404 });
    if (loop.owner !== wallet) return Response.json({ error: "this loop belongs to another wallet" }, { status: 403 });
    // The closed beta (`_lib/beta.ts`), on the verbs that start paid work on a loop the signer
    // owns: a resume puts its schedule back on the clock, and a retry does too once its writes land.
    // Before the command counter, so a refusal costs nothing. The verbs that
    // end or tidy a run — stop, pause, archive, unarchive, discard — are not asked: an owner taken
    // off the list must still be able to stop a running loop, which is what settles its channel and
    // revokes its key. A loop already running when the gate turns on keeps running.
    if (BETA_GATED_COMMANDS.has(action)) {
      const closed = betaRefused(wallet);
      if (closed) return closed;
    }
    // The same refusal `POST /api/agents/:id` gives for an agent that is not archived. A 200 for
    // a no-op cannot be told apart from "I un-archived it", which is the distinction the agent
    // route bothered to draw, and the two verbs are one action on screen.
    if (action === "unarchive" && !loop.archivedAt) {
      return Response.json({ error: `${loop.agentName}'s run is not archived` }, { status: 409 });
    }
    // The rest of the refusals a command can earn from the loop record alone, for the same reason:
    // a resume of a loop that is not paused or has taken all its steps, and a discard of a run that
    // did not stop on `anchor-failed`, obtain nothing. Each repeats the check its own verb makes below,
    // which stays — the record can move between here and there — so these only decide who is charged,
    // never what a verb does. `resumeLoop` answers a refused resume with the loop unchanged, and
    // `discardLoopAnchor` with the same words as here.
    // A Retry on a run that is not stopped, or owes nothing, would only clear the scheduler's `halted`
    // mark and re-run a step that already landed. It reads the anchor journal too — this
    // console's own disk, not the chain — so it is asked here rather than in `commandRefusedLocally`;
    // `retryLoopAnchor` asks again under the slot.
    const early = commandRefusedLocally(action, loop) ?? (action === "retry" ? await retryRefusalNow(loop) : null);
    if (early) {
      // A discard's refusal carries the loop, as `discardLoopAnchor`'s own 409 does.
      const extra = action === "discard" ? { loop: publicLoop(loop) } : {};
      return Response.json({ ...extra, error: early }, { status: 409 });
    }
    // The counter comes after the id, the owner and every local precondition above are checked: a
    // command on a loop that does not exist, on another wallet's, or that its own record already
    // refuses obtains nothing and must not spend one of the owner's hourly commands. Those are reads of
    // the local loop store and the scheduler, so nothing costly runs before the charge. What is left
    // behind it is what needs the chain or the writer queue: `retry`'s drain and `discard`'s re-check
    // against the chain.
    const refused = rateLimit("loop commands", `loop-cmd:${caller}`, LOOP_COMMANDS_PER_HOUR);
    if (refused) return Response.json({ error: refused }, { status: 429 });
    // *Retry the step*: the records this run built and could not send go back on the writer
    // queue, and the run goes back on its schedule only if they land (`_lib/loops.ts`). Nothing
    // is re-run — the session already happened — so this is not *Run again* and does not get a
    // start's counter. A drain that fails is a 409 carrying the loop as it still stands: stopped,
    // with its journal intact, retriable again later.
    // The owner's own word on every transition the verb writes, for the lifecycle record it owes:
    // the `"Lath loop"` message this request was verified with (`sdk/src/lifecycle.ts`).
    const actor: LifecycleActorContext = { by: "owner", auth: body.auth };
    if (action === "retry") {
      const { loop: after, error } = await retryLoopAnchor(loop.id, { actor });
      const body = { loop: publicLoop(after ?? loop) };
      return error ? Response.json({ ...body, error }, { status: 409 }) : Response.json(body);
    }
    // *Discard*: the way out of a run whose journal the chain has moved away from. The
    // queue re-checks the chain and refuses anything a Retry could still land, which answers 409
    // with the run unchanged; a discard that goes through leaves it stopped on `anchor-discarded`.
    if (action === "discard") {
      const { loop: after, error } = await discardLoopAnchor(loop.id, { actor });
      const body = { loop: publicLoop(after ?? loop) };
      return error ? Response.json({ ...body, error }, { status: 409 }) : Response.json(body);
    }

    const after =
      action === "pause"
        ? pauseLoop(loop.id, actor)
        : action === "resume"
        ? resumeLoop(loop.id, actor)
        : action === "archive"
        ? archiveLoop(loop.id, undefined, undefined, actor)
        : action === "unarchive"
        ? unarchiveLoop(loop.id)
        : stopLoop(loop.id, undefined, undefined, undefined, actor);
    if (action === "resume" && after?.status !== "running") {
      // The record moved between the check above and the resume: say what refused it now.
      return Response.json(
        {
          error: resumeRefusal(after ?? loop) ?? "this loop cannot resume: it is stopped or has taken all its steps",
        },
        { status: 409 }
      );
    }
    return Response.json({ loop: publicLoop(after ?? loop) });
  }

  // Every step of every loop runs in a sandbox — a Lath-patched ZeroClaw under the host's wrapper —
  // so a console without a working binary or wrapper starts none, and says why. That check, and the
  // four steps below, are `answerLoopStart`'s (`_lib/loop-start.ts`), in this order and for these
  // reasons:
  //
  // 1. `checkLoopStart` — every refusal a start can earn without a chain write: the orchestrator
  //    and a stored template are this wallet's, the terms are in bounds, nothing is running on
  //    the agent, the wallet is under its cap. In `_lib/loops.ts` for the reason `copyContext`
  //    is in `_lib/copy.ts`: a route that imports `next/server` cannot be loaded outside
  //    `frontend/`. It is also what a deploy that carries a loop is planned by, so *Run as a
  //    loop* in the wizard and a start from here go through exactly the same rules.
  // 2. The hourly counter, after every one of those — a refusal that registers nothing obtains
  //    nothing, so it costs nothing: eight clicks on *Run again* beside a stopped run
  //    must not lock the wallet out for an hour having started none — and **before** step 3,
  //    because step 3 is where a start spends the operator's SOL.
  // 3. `prepareLoopStart` — the part of a start that writes a chain or spends the treasury: the
  //    sandbox's sources are fetched, and then the loop's access key is authorized. After every
  //    refusal, so a start on another wallet's agent writes nothing before something asks whose
  //    agent it is; and a source that refuses refuses the start before any key is authorized, so
  //    it costs nothing on chain.
  // 4. `planLoopStart`, which is synchronous because a deploy and a launch call it from inside
  //    a transaction that has already landed, and then the record and the clock.
  //
  // A client that sends `Accept: text/event-stream` gets the same start streamed: each stage as it
  // begins, then the status and body below as the last event. Without the header the answer is a
  // plain JSON response, so a client that does not stream reads it as it reads any other.
  //
  // The closed beta comes before all of it (`_lib/beta.ts`): a start is the action the treasury
  // pays for longest, and it has no `prepare` — the `"Lath loop"` message is its one signature, so
  // this is the first point the wallet is known. Before the stream too, so the refusal is the
  // plain 403 a client reads as it reads a bad signature's 401.
  const closed = betaRefused(wallet);
  if (closed) return closed;
  const run = (onStage?: (stage: LoopStartStage) => void) =>
    answerLoopStart(body, wallet, {
      caller,
      view: (l) => publicLoop(l),
      hooks: { treasuryHeld },
      onStage,
      // The signature just verified, for the `loop.start` the row owes; kept nowhere else.
      auth: body.auth,
    });
  if (wantsStartStream(req)) return streamLoopStart(run);
  const answer = await run();
  return Response.json(answer.body, { status: answer.status });
}
