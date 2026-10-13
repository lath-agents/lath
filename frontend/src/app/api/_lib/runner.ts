/**
 * What the server's runtime is made of, shared by `/api/run` (sessions) and `/api/agents`
 * (deployments): the keypair it holds, the keys it derives from it, the wallet-signature check,
 * and the small on-disk registry that maps a deployed agent's id back to the name its keys are
 * derived from.
 *
 * The split exists because an agent's `authority` on chain is whoever signed `register_agent`,
 * and only that key may append to its chain. A chat that runs server-side can therefore only
 * serve agents whose key this server holds — so deployment registers with a derived key here,
 * and the wallet's single transaction is the allowance that pays for it.
 *
 * Environment (server-side, never `NEXT_PUBLIC_`):
 *   LATH_RUNTIME_KEYPAIR     path to, or JSON array of, the keypair that owns the console agents
 *   LATH_CONSOLE_ORIGIN      the origin this console is served on (`https://console.example`),
 *                            which every signed message's domain and URI must name
 *                            (`verifyAuth`). Unset, the request's own `Host` header stands in — right
 *                            for `npm run dev:devnet` on localhost and the Playwright server, where
 *                            the browser and the server see the same host. Set it on any deployment
 *                            behind a proxy or reachable by address: `Host` is a header the client
 *                            sends, so whoever can reach the process other than through an edge
 *                            that pins it — by its address and port, or through a proxy that
 *                            forwards the client's `Host` as sent — can post a message signed for a
 *                            lookalike domain with a `Host` that matches it, and the check would
 *                            pass. One origin, scheme and port included, no path.
 *                            It is also the origin `src/middleware.ts` lets write to `/api/*`:
 *                            behind a proxy that rewrites `Host`, unset refuses the console's own pages,
 *                            and unset, a browser's write is taken only on a `Host` that is `localhost`
 *                            or an IP literal, never on a hostname DNS could rebind to this machine;
 *                            and the base a shared link's `og:image` resolves against
 *                            (`app/layout.tsx`), read when the pages build, so set it before `next build` too
 *   LATH_RPC_URL             ZK-compression RPC (defaults to NEXT_PUBLIC_RPC_URL)
 *   LATH_RPC_UNITS_PER_MINUTE  call units one address may send through `/api/rpc` a minute (default
 *                            1200; a program scan or a validity proof costs 10; `app/api/rpc/limits.ts`)
 *   LATH_TRUST_PROXY         `1` when a proxy this deployment controls sets `X-Forwarded-For`: only
 *                            then is a caller's address read, and every per-address limit keyed on it
 *                            (`callerIp`). Unset, every request is the one caller `local`
 *   LATH_LOCAL_CALLERS       how many callers' worth of each per-address limit on `/api/run` and
 *                            `/api/rpc` the shared `local` bucket holds when LATH_TRUST_PROXY is unset
 *                            (default 10): bounded, but one visitor cannot spend everybody's (`LOCAL_CALLERS`)
 *   LATH_PREPARES_PER_HOUR   prepared transactions the whole server signs for strangers an hour (default 200)
 *   LATH_PREPARES_PER_CALLER_PER_HOUR
 *                            of those, how many one address may take (default 40), only behind
 *                            LATH_TRUST_PROXY=1 (`prepareCeiling`)
 *   LATH_MAINNET_RPC         mainnet RPC for a sandbox's mainnet Solana sources; unset refuses them
 *   LATH_PHOTON_URL / LATH_PROVER_URL   overrides for a local Light stack
 *   LATH_TRACE_DIR           where traces, epoch blobs and `agents.json` are written
 *   LATH_SESSION_CAP_USDC    hard cap per session (default 0.25)
 *   LATH_MAX_STEPS           assistant turns per session (default 6)
 *   LATH_RETRIES_PER_HOUR    retries of a session's failed writes per caller (default 30); a
 *                            retry runs no model, so it is not one of the six sessions an hour
 *   LATH_RUN_READS_PER_HOUR  chain reads /api/run makes before deciding (a target's header, a signed
 *                            caller's allowance reads, GET ?agent= cache misses) per caller address
 *                            an hour (default 120); LATH_RUN_READS_PER_HOUR_SERVER the same for the
 *                            whole server (default 1200)
 *   LATH_UNBILLED_SESSIONS_PER_HOUR
 *                            sessions nobody is billed for (anonymous, or an owner before the
 *                            allowance lands), across the whole server an hour (default 60); a
 *                            charged session does not count
 *   LATH_LOOP_BUDGET_MAX_USDC  the most one loop's whole budget may be, in USDC (default 25; a start
 *                            asking for more is clamped to it). There is no per-step ceiling, and
 *                            `LATH_SESSION_CAP_USDC` does not bound a loop
 *   LATH_JEV_BUDGET_PERCENT  what Lath may spend on Jev per loop — verify decisions and goal checks,
 *                            by each call's actual voucher — as a percentage of the owner's loop
 *                            budget (default 15, bounded 0–100), frozen into the loop at its start;
 *                            spent, Jev's decisions are recorded unavailable, and the loop keeps
 *                            running. A malformed value here or in the line above is the default,
 *                            never "off"
 *   LATH_FALLBACK_MODEL      the model a loop's chat call is tried on after its own model got no
 *                            answer twice within one call. Frozen into a loop
 *                            at its start and committed in every step's policy as `fallbackModel`,
 *                            so the audit can hold each served call to it. Unset (or equal to the
 *                            loop's model) means no third attempt: a call is retried once on its own
 *                            model only, and no step's policy carries `fallbackModel`
 *   LATH_ANCHOR_FAIL         `--e2e` only: refuse the first journaled write's attempts on purpose,
 *                            so the FAILED badge and its retry can be exercised (`_lib/anchor.ts`)
 *   LATH_CONSOLE_TAG         suffix for the console's own agent names (default: first 6 chars of
 *                            the authority). Change it to start the console on fresh chains — an
 *                            old epoch whose blob was lost fails every later audit of that chain,
 *                            by design, and a fresh tag is how an operator moves on from it.
 *   LATH_TRACE_BACKEND       where epoch blobs and manifests are uploaded and anchored: `fs`
 *                            (default; `LATH_TRACE_DIR`, served by `/api/traces`) or `irys`
 *   LATH_IRYS_NETWORK        devnet | mainnet (default: mainnet on mainnet-beta, else devnet).
 *                            The Irys network is independent of the Solana cluster: a devnet chain
 *                            may anchor to mainnet Irys, which is what the demo does — mainnet
 *                            keeps the bytes for one payment and devnet deletes them after about
 *                            sixty days. Mainnet costs real SOL from the uploader's Irys balance
 *                            (this server's key, funded with `npm run irys -- fund`, the network
 *                            set the same way): quoted at ~1 928 lamports for one small item,
 *                            against ~38 987 quoted on devnet, which charges nothing below its free
 *                            tier. A quote is not a charge; the storage card on a loop's page shows
 *                            what each step's uploads actually took. Only the blobs move: every
 *                            Solana write stays on the cluster.
 *   LATH_IRYS_NODE           the Irys node uploads go to (default: the network's)
 *   LATH_IRYS_GATEWAY        the gateway reads go through (default: https://gateway.irys.xyz)
 *   LATH_UPLOAD_ATTEMPTS     tries an epoch blob's upload gets before it falls back to
 *                            `LATH_TRACE_DIR` (default 3; 1 disables the retry)
 *   LATH_UPLOAD_BACKOFF_MS   wait before the second try, doubling after it (default 1000). The
 *                            total wait for one epoch is capped at ten seconds either way, so a
 *                            backend that is down delays a session by that and no more.
 *   LATH_TEMPO_TREASURY      the operator's Tempo account that pays the provider, and the only
 *                            thing that can: a path to a file holding the 0x-prefixed private key,
 *                            or the key itself (`_lib/tempo.ts`). Never printed; only its address
 *                            is. Empty or unset means no session in this process can be billed at
 *                            all — every one runs scripted and unbilled, whatever a template
 *                            records, because there is no provider key to fall back to.
 *                            `scripts/dev-devnet.sh --e2e` and `playwright.config.ts` decide what
 *                            a suite run spends by setting or clearing it. Channel opens and
 *                            closes are serialised in this process; two console processes on one
 *                            treasury are unsupported. Mainnet money: keep it at or under
 *                            $10 USDC.e.
 *   LATH_TEMPO_DECISIONS_URL where a loop's verify call goes on the treasury's channel
 *                            (default https://openrouter.mpp.tempo.xyz/alpha/decisions, the
 *                            gateway's own path). With a dead host here the step reads
 *                            `unavailable` and memory still commits.
 *   LATH_TEMPO_LOOP_KEYS     `1`, `on`, `true` or `yes` gives every loop started from then on its
 *                            own Tempo access key, authorized on the treasury with a USDC.e limit of
 *                            the loop's budget plus its 15 % decision share, so Tempo itself refuses
 *                            a deposit past it whatever the console does (`_lib/tempo-keys.ts`).
 *                            Anything else, and unset, is off: no new key, and no loop started
 *                            then has a `tempoKey` in its policy. A loop started while it was on keeps
 *                            its key after it is turned off, until the loop is stopped, which
 *                            revokes it — turning it off is not how a live key is withdrawn. A start
 *                            whose key cannot be authorized is refused with Tempo's reason rather
 *                            than run treasury-signed, because its Genesis would commit a key its
 *                            payments never used
 *   LATH_TEMPO_KEY_DIR       where each loop's key file lives, `<loopId>.json`, mode 0600 in a 0700
 *                            directory (default `~/.lath/tempo-keys`). Never at or under
 *                            LATH_TRACE_DIR — `/api/traces` serves that tree, so a key there would
 *                            be one URL from anyone, and a key is refused if it is (real paths,
 *                            so a symlink does not hide it, and compared case-insensitively on
 *                            macOS and Windows, whose file systems fold case). Random keys, not derived from
 *                            LATH_RUNTIME_KEYPAIR: losing the directory loses no money, because the
 *                            treasury is every channel's payer and can force-close
 *   LATH_TEMPO_KEY_SCOPES    `0|off|false|no` authorizes the loop keys without call scopes. Anything
 *                            else, and unset, scopes each key to the escrow's open and topUp and
 *                            USDC.e transferWithMemo to the storage payee, so Tempo refuses any other
 *                            call it signs. The off switch is the escape hatch until the
 *                            `--case scopes` probe has passed
 *   LATH_PROTOCOL_PLUGINS    `1`, `on`, `true` or `yes` lets a loop start carry `receipt`, the pointer
 *                            SAS · receipt publishes under. Anything else, and unset, is off: a
 *                            start carrying one is refused (the signature binds it, so dropping it
 *                            would run what the owner did not sign), and no policy carries a
 *                            `receipt`. It does not enable protocol-plugin `grants`: they are not in
 *                            this build (`squads.pay` and `sas.attest` are on the roadmap), so every
 *                            start, deploy, *Run again* and template write carrying them is refused,
 *                            and a stored row that carries them takes no step, resume or Retry.
 *                            Devnet only; a deploy carrying a loop never takes a receipt
 *   LATH_DEMO_ATTEST         the SAS demo file `scripts/demo-attest/seed.ts` writes (default
 *                            `~/.lath/demo-attest/addresses.json`). With protocol plugins on and the
 *                            file present, `GET /api/loops` hands its issuer, credential, schema and
 *                            subjects to the form as `attestDemo`, with the `loop-receipt` schema and
 *                            this console's key as its `receipt` — the pointer SAS · receipt sends;
 *                            absent or malformed, `null`
 *   LATH_MARGIN              the operator's margin over the voucher delta the provider was paid
 *                            (default 0.10, the measured number — `runtime/src/billing.ts`)
 *   LATH_ZEROCLAW_BIN        the Lath-patched ZeroClaw every loop step runs in: the binary
 *                            `zeroclaw/build.sh` builds, whose build record
 *                            (`<binary>.sha256`) names its bytes and patch set. Unset means
 *                            `zeroclaw` on PATH. No working binary — none, not executable, a
 *                            `--version` that does not answer, not the Lath build — or a wrapper
 *                            that cannot start (`sandbox-exec` on macOS, `bwrap` with user
 *                            namespaces on Linux) and `POST /api/loops` refuses a start with the
 *                            reason, and a running loop's next step stops it with the same one.
 *                            There is no in-process fallback and no switch for one. Sessions
 *                            outside a loop (`/api/run`) do not use it.
 *   LATH_ZEROCLAW_HOME       the root of every loop's sandbox: `loops/<loopId>/work` (the workspace,
 *                            kept across steps) and a fresh `steps/<id>/` per session holding its
 *                            config and its two sockets (default `~/.lath/zc`). Never inside
 *                            LATH_TRACE_DIR — a loop is refused if it is — and short: a socket path
 *                            the binary can reach is under 104 bytes on macOS and 108 on Linux,
 *                            and a longer one fails the step before its sandbox is spawned.
 *   LATH_BETA_WALLETS        the closed beta's invited wallets, base58, separated by commas or
 *                            whitespace (`_lib/beta.ts`). With this or LATH_BETA_FILE set, only a
 *                            listed wallet may take an action the treasury or the server's SOL pays
 *                            for — a session (anonymous ones and those on the console's own agents
 *                            included), a deploy, a clone, a store write, a loop's
 *                            start, resume or retry — each refused 403 before
 *                            anything is signed, built or written, and a deploy or clone
 *                            again at its `confirm`, on the wallet its ticket names, so a ticket
 *                            does not outlive its wallet's place on the list. Reads and a loop
 *                            owner's stop, pause, archive and discard stay open, so an owner taken
 *                            off the list can still stop a running loop and settle
 *                            its channel. A loop already running keeps running. Neither set, and the
 *                            gate is off: nothing changes
 *   LATH_BETA_FILE           a file of invited wallets, one per line, `#` comments, joined with
 *                            LATH_BETA_WALLETS; re-read when it changes, so a wallet is added without
 *                            a restart. One that is named and cannot be read refuses everyone and
 *                            says why in the log: the gate fails closed, never open
 *   LATH_WAITLIST_URL        where a beta refusal points (default https://getlath.xyz). The connect
 *                            card's own closed-beta line is `NEXT_PUBLIC_LATH_CLOSED_BETA=1`, read
 *                            when the pages build, and links the default
 *   LATH_LIFECYCLE           `0`, `off`, `false` or `no` turns the lifecycle records off
 *                            (`_lib/lifecycle.ts`, `sdk/src/lifecycle.ts`). Anything else, and unset, is
 *                            on: a loop's start, pause, resume and stop and an agent's deploy, archive
 *                            and unarchive are each owed as a standalone Action on the agent's chain
 *                            (public documents through the plain store and Irys), written under the run
 *                            slot — a loop's first step waits for its `loop.start` — and a console whose
 *                            `loops.json` and `agents.json` are gone rebuilds its lists from them, as
 *                            read-only rows. Off, nothing is owed, written or rebuilt; a row that already
 *                            owes entries keeps them unwritten until it is on again. Each record costs
 *                            one Action and a few locator cells of the agent key's SOL
 *
 * Deployment requirement: run ONE instance. The console keeps its
 * nonces, rate limits and the run slot in process memory, so a second instance would give every
 * caller a second allowance, accept a nonce twice and run two sessions at once; more than one
 * instance is unsupported until that state moves out of process. `LATH_TRUST_PROXY=1` may be set
 * only behind an edge that strips the client's own `X-Forwarded-For`, or a caller chooses its
 * own rate-limit bucket.
 */
import { createPublicKey, randomBytes, verify as verifySignature } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRpc, Rpc } from "@lightprotocol/stateless.js";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import {
  AgentLogger,
  BillingClient,
  Bytes32,
  DEFAULT_UPLOAD_RETRY,
  EpochStore,
  FileEpochStore,
  FsLocatorBackend,
  IRYS_GATEWAY,
  IRYS_NODES,
  IrysBackend,
  IrysNetwork,
  LathClient,
  LocatorBackend,
  confirmByPolling,
  hex,
  idFromString,
  isSmallOrderEd25519Key,
  LocatorScheme,
  NameRecord,
  sha256,
  UploadRetryPolicy,
  utf8,
} from "@lath/sdk";
// Type only: `templates.ts` reads `TRACE_DIR` from this module, so a value import would be a cycle.
import type { TemplateLink } from "./templates";
// Type-only, and therefore erased: the loop modules behind `loops.ts` import values from here, and this must not be a
// runtime cycle.
import type { LoopStartBody } from "./loops";
// Type only, for the same reason: `lifecycle.ts` imports values from here.
import type { LifecycleState } from "./lifecycle";
import { readJsonOr, writeJsonAtomic } from "./json-store";
import { consoleOrigin } from "./origin";
import { withRetry } from "./retry";

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Empty means unset. `scripts/dev-devnet.sh` beats a local `.env.local` by exporting the
 * local-only Photon and prover urls as empty strings — Next only fills in variables the
 * environment does not already have — so `??` here would read that as "Photon lives at ''".
 */
export function env(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export const RPC_URL = env("LATH_RPC_URL", "NEXT_PUBLIC_RPC_URL");
export const PHOTON_URL = env("LATH_PHOTON_URL", "NEXT_PUBLIC_PHOTON_URL") || RPC_URL;
export const PROVER_URL = env("LATH_PROVER_URL", "NEXT_PUBLIC_PROVER_URL") || RPC_URL;
export const TRACE_DIR = env("LATH_TRACE_DIR") || path.join(process.cwd(), ".traces");
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
export const TREASURY_ADMIN = process.env.NEXT_PUBLIC_TREASURY_ADMIN ?? "";
export const SESSION_CAP_MICRO = BigInt(Math.round(Number(process.env.LATH_SESSION_CAP_USDC ?? "0.25") * 1_000_000));
export const MAX_STEPS = Number(process.env.LATH_MAX_STEPS ?? "6");

// ─── Admission: may this run spend, and against what ───────────────────────

/**
 * The largest single charge one metered record can carry, under a cap spread over `maxSteps`.
 *
 * Deliberately the same arithmetic as `perCallCeiling` in `_lib/tempo.ts`, where the `tempo`
 * rail sizes its deposit from the same number. It is repeated rather than imported because
 * `tempo.ts` imports `TRACE_DIR` from this module: importing back would make admission — which
 * every write route runs before it opens a stream — pull the rail's viem client in behind it.
 * The two are pinned equal by a case in `tests/console-admission.ts`, which is what notices if
 * one of them is ever changed alone.
 */
export function largestSingleCharge(capMicro: bigint, maxSteps: number): bigint {
  const share = capMicro / BigInt(Math.max(1, maxSteps));
  return share > 0n ? share : 1n;
}

/**
 * What admission reads off an `Allowance`. `reserved` is optional because a grant in the older
 * layout does not carry the field and decodes as `0` (`sdk/src/layout.ts`, `legacy`): such a
 * grant can hold nothing, so reading a missing field as zero is its real headroom, not a guess.
 */
export interface GrantHeadroom {
  cap: bigint;
  spent: bigint;
  reserved?: bigint;
  /** Unix **seconds**, as the account carries it. */
  expiresAt: bigint | number;
}

/**
 * Whether a grant may admit a run that is about to spend the operator's model key, and which
 * half is short when it may not.
 *
 * The obvious test, `grant.cap > grant.spent && spendable > 0n`, is two dust thresholds: one
 * micro-USDC of headroom and one micro-USDC in escrow would admit a session that then runs a full
 * cap of real inference on the operator's key, because charges are journaled rather than awaited
 * and the runtime counts a journaled charge as spent. And `spent` alone is not what the program
 * bounds — its own cap check is `spent + reserved` (`lath-billing/src/lib.rs`, `committed`) — so
 * a grant whose headroom is entirely held by outstanding `reserve`s would still read as live, and
 * fail only once the inference had been paid for off chain.
 *
 * So admission compares both halves against the largest charge the *first* metered record can
 * carry. That is the smallest honest floor: it is what must be payable for the run to get past
 * its first step, and a run that cannot pay its first step must not reach the model key at all.
 * It is deliberately not the whole cap — a wallet that has funded four of six steps is admitted
 * and stops when the money does, which is what the per-record charge is for.
 */
export function admitSpend(p: {
  grant: GrantHeadroom | null;
  /** `deposited − spent − reserved` for the wallet, as `BillingClient.spendable` reports it. */
  spendable: bigint;
  /** The session cap, or a loop's per-step budget: what this run is allowed in total. */
  cap: bigint;
  maxSteps: number;
  now?: number;
}): { ok: true; needed: bigint; headroom: bigint } | { refuse: string } {
  const needed = largestSingleCharge(p.cap, p.maxSteps);
  const usdc = (v: bigint) => `${(Number(v) / 1e6).toFixed(6)} USDC`;
  const first = `the first metered record can charge ${usdc(needed)}`;
  if (!p.grant) return { refuse: `there is no allowance from this wallet to this agent, and ${first}` };
  const now = p.now ?? Date.now();
  if (Number(p.grant.expiresAt) * 1000 <= now) {
    return { refuse: "this wallet's allowance to this agent has expired; grant a new one" };
  }
  const reserved = p.grant.reserved ?? 0n;
  const headroom = p.grant.cap - p.grant.spent - reserved;
  // Which of the two is short, named: the way out is a different transaction in each case —
  // raise the cap, or deposit more USDC — and a single "unfunded" told the caller neither.
  if (headroom < needed) {
    return {
      refuse:
        `the allowance is short: ${usdc(headroom)} of headroom left ` +
        `(cap ${usdc(p.grant.cap)} − spent ${usdc(p.grant.spent)} − held ${usdc(reserved)}) and ${first}`,
    };
  }
  if (p.spendable < needed) {
    return { refuse: `the escrow deposit is short: ${usdc(p.spendable)} spendable and ${first}` };
  }
  return { ok: true, needed, headroom };
}
/**
 * SOL on a child key is fee money and nothing else: its accounts are compressed and lock no
 * rent, a record costs 15,000 lamports and an epoch 10,000, so a whole session is on the order
 * of 60,000 lamports. The budget an agent runs on is its USDC allowance. Below `CHILD_MIN_SOL`
 * (about thirty sessions) a child is topped up to `CHILD_TOPUP_SOL` (about a hundred and fifty),
 * and `ensureFunded` runs before every session, so a busy agent is refilled as it goes.
 */
const CHILD_MIN_SOL = 0.002;
// Exported so a caller that registers several agents in one batch can know what the whole batch
// costs before it registers the first one — a run of SOL halfway through leaves a half-registered
// batch and `agent_id`s spent for good. Two copies of the numbers would be two things to keep in
// step.
export const CHILD_TOPUP_SOL = 0.01;
/** What the server keeps back for its own writes: it registers, publishes names and commits epochs too. */
export const SERVER_RESERVE_SOL = 0.02;

export function rpcFor(): Rpc {
  return createRpc(RPC_URL, PHOTON_URL, PROVER_URL, { commitment: "confirmed" });
}

// ─── Where epoch blobs go: the locator backend ──────────────────────────────

export const TRACE_BACKEND = env("LATH_TRACE_BACKEND") || "fs";
/**
 * What `createEpochCommitter` does with an upload that failed: try again while the error looks
 * transient, then write the blob to `TRACE_DIR` and commit the epoch unanchored. The cap on the
 * total wait is not configurable — it is the promise that one epoch can never hold a session for
 * longer than ten seconds, which a setting would turn into something an operator can accidentally
 * break.
 */
export const UPLOAD_RETRY: UploadRetryPolicy = {
  attempts: Math.max(1, Number(env("LATH_UPLOAD_ATTEMPTS") || DEFAULT_UPLOAD_RETRY.attempts)),
  backoffMs: Math.max(0, Number(env("LATH_UPLOAD_BACKOFF_MS") || DEFAULT_UPLOAD_RETRY.backoffMs)),
};
const IRYS_NETWORK = (env("LATH_IRYS_NETWORK") || (CLUSTER === "mainnet-beta" ? "mainnet" : "devnet")) as IrysNetwork;
const IRYS_NODE = env("LATH_IRYS_NODE");
/**
 * The gateway every Irys read on this server goes through. It is exported so a rebuild reading the
 * lifecycle records (`_lib/lifecycle.ts`) reads through the same gateway as everything else, rather
 * than restating the environment lookup.
 */
export const IRYS_GATEWAY_URL = env("LATH_IRYS_GATEWAY") || IRYS_GATEWAY;

/**
 * The Irys backend, built once per process and kept on `globalThis` for the same reason the
 * run slot is: Next may evaluate a route module twice, and the uploader's balance should be
 * read once, not once per copy. The runtime keypair is the uploader — it already pays the
 * chain's fees; Irys is its second balance.
 */
const IRYS_KEY = Symbol.for("lath.irysBackend");
function irysBackendFor(server: Keypair): Promise<IrysBackend> {
  const g = globalThis as any;
  if (!g[IRYS_KEY]) {
    g[IRYS_KEY] = (async () => {
      if (!RPC_URL)
        throw new Error("LATH_TRACE_BACKEND=irys needs an RPC url for Irys to price against (LATH_RPC_URL)");
      const backend = new IrysBackend({
        wallet: server,
        network: IRYS_NETWORK,
        rpc: RPC_URL,
        node: IRYS_NODE || undefined,
        gateway: IRYS_GATEWAY_URL,
      });
      // Refuse here, loudly, rather than at the first epoch: a trace store that quietly fell
      // back to the filesystem mid-run would be worse than one that never started.
      const balance = await backend.balance();
      if (balance === 0n) {
        throw new Error(
          `LATH_TRACE_BACKEND=irys, but the uploader ${await backend.address()} has no balance at Irys ` +
            `${IRYS_NETWORK} (${backend.node}). Fund it from its SOL with \`npm run irys -- fund <sol>\`, ` +
            `which resolves this same key the way this server did — LATH_RUNTIME_KEYPAIR, else ` +
            `frontend/.runtime-keypair.json — and prints the address it chose, so check that line says ` +
            `${await backend.address()} before you fund it. Or unset ` +
            `LATH_TRACE_BACKEND to anchor to ${TRACE_DIR}.`
        );
      }
      return backend;
    })();
    // A refusal is not cached: the operator funds the key and the next session tries again.
    (g[IRYS_KEY] as Promise<IrysBackend>).catch(() => (g[IRYS_KEY] = null));
  }
  return g[IRYS_KEY];
}

/**
 * The backend epoch blobs and manifests are uploaded to before their locator goes on chain —
 * one selector for `/api/run` and the loop scheduler, so the two cannot drift. `fs` is the
 * default and is what every test and seed script uses; `irys` refuses to *construct* without a
 * funded uploader, and once constructed carries the local fallback an upload failure mid-session
 * falls back to.
 */
export async function traceBackend(
  server: Keypair
): Promise<LocatorBackend & { fallback?: EpochStore; retry?: UploadRetryPolicy }> {
  if (TRACE_BACKEND === "fs") return new FsLocatorBackend(TRACE_DIR, { scheme: LocatorScheme.Raw, encoding: "hex" });
  if (TRACE_BACKEND === "irys") {
    // The fallback and the retry policy every `AnchoredEpochStore` built on this backend picks
    // up: an upload that fails is retried, and only then does the epoch blob go to the console's
    // own trace directory — the one `fs` mode anchors to — so the epoch is committed unanchored
    // instead of failing the session. Attached here so none of
    // the three call sites that build a store has to thread them through.
    return Object.assign(await irysBackendFor(server), {
      fallback: new FileEpochStore(TRACE_DIR),
      retry: UPLOAD_RETRY,
    });
  }
  throw new Error(`LATH_TRACE_BACKEND is ${JSON.stringify(TRACE_BACKEND)}; it is "fs" or "irys"`);
}

export type TraceBackendInfo =
  | { kind: "fs"; dir: string; scheme: number; encoding: "hex" }
  | {
      kind: "irys";
      network: IrysNetwork;
      node: string;
      gateway: string;
      scheme: number;
      encoding: "base64url";
      /** The uploader's address, and what it holds *at Irys* — not its SOL. */
      uploader: string | null;
      balanceSol: number | null;
      /** Why the backend cannot be used right now, when it cannot. */
      error: string | null;
    };

/**
 * The Irys settings a loop's sources are published with: the network, node and RPC the epochs'
 * `IrysBackend` is built with, so the sources are paid from the same balance, and the gateway
 * every Irys read goes through. `publish` is `true` only when the operator chose
 * `LATH_TRACE_BACKEND=irys`: a console anchoring to its own directory publishes nothing, and a loop
 * it starts commits no Irys id for its sources. The gateway is there either way, because restoring
 * another loop's sources is a read.
 */
export function irysSourcesSettings(): {
  publish: boolean;
  network: IrysNetwork;
  node: string;
  rpc: string;
  gateway: string;
} {
  return {
    publish: TRACE_BACKEND === "irys",
    network: IRYS_NETWORK,
    node: IRYS_NODE || IRYS_NODES[IRYS_NETWORK],
    rpc: RPC_URL,
    gateway: IRYS_GATEWAY_URL,
  };
}

/** What the server reports about its blob backend beside its SOL balance — `GET /api/run`. */
export async function traceBackendInfo(server: Keypair): Promise<TraceBackendInfo> {
  if (TRACE_BACKEND !== "irys") return { kind: "fs", dir: TRACE_DIR, scheme: LocatorScheme.Raw, encoding: "hex" };
  const base = {
    kind: "irys" as const,
    network: IRYS_NETWORK,
    node: IRYS_NODE || IRYS_NODES[IRYS_NETWORK],
    gateway: IRYS_GATEWAY_URL,
    scheme: LocatorScheme.Irys,
    encoding: "base64url" as const,
  };
  try {
    const backend = await irysBackendFor(server);
    return {
      ...base,
      uploader: await backend.address(),
      balanceSol: Number(await backend.balance()) / LAMPORTS_PER_SOL,
      error: null,
    };
  } catch (e: any) {
    return { ...base, uploader: server.publicKey.toBase58(), balanceSol: null, error: e?.message ?? String(e) };
  }
}

/**
 * Does the deployed program have `commit_epoch`? Its `epoch_head` hashes a literal
 * `"lattice.epoch"` tag, which is therefore in the program bytes — so the probe is a read of the
 * program-data account and a byte search, no guessing by program id. The tag is a frozen hash
 * input: it is bytes inside a program already deployed and inside every epoch head already
 * committed, so a search for any other spelling would find nothing. `LATH_EPOCHS=0|1` overrides.
 *
 * Cached per process, but only an answer read from the program's bytes. A first probe that threw
 * (a 429, a 5xx, a reset) or found no account (a node lagging behind the deploy), cached as
 * `false` for the life of the process, would refuse every loop step for a program "with no
 * commit_epoch" and run `/api/run` without epochs, until a restart. So such a probe **rejects**
 * for every caller waiting on it and drops out of the cache, and the next caller asks again. It
 * rejects rather than answering `false` because a loop step refuses on `false`, and a refusal
 * stops the loop for good (`afterStepFailure`): an RPC blip must read as the step failing, which
 * is retried, never as the program lacking epochs. A caller that can go on without epochs
 * (`/api/run`) catches it and does so for that one session.
 */
const epochProbe = new Map<string, Promise<boolean>>();
export function epochsSupported(rpc: Rpc, programId: PublicKey): Promise<boolean> {
  if (process.env.LATH_EPOCHS === "1") return Promise.resolve(true);
  if (process.env.LATH_EPOCHS === "0") return Promise.resolve(false);
  const key = programId.toBase58();
  let probe = epochProbe.get(key);
  if (!probe) {
    probe = (async () => {
      const [programData] = PublicKey.findProgramAddressSync(
        [programId.toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
      );
      const info = await rpc.getAccountInfo(programData);
      // An upgradeable program always has its program-data account, so none means this node has not
      // caught up (or the id is wrong) — no answer about the bytes, and not one to keep.
      if (!info) throw new Error(`the RPC found no program-data account for ${key}`);
      return info.data.includes(Buffer.from("lattice.epoch"));
    })();
    const mine = probe;
    // Removes this probe only: a later caller may already have put a fresh one in its place. The
    // rejection still reaches every caller holding `mine`; this branch only forgets it.
    mine.catch(() => {
      if (epochProbe.get(key) === mine) epochProbe.delete(key);
    });
    epochProbe.set(key, probe);
  }
  return probe;
}

/**
 * `epochsSupported` for a caller that can run without epochs (`/api/run`): a probe that could not
 * read the program answers `false` for this call only, logged, and the next call asks again.
 */
export async function epochsSupportedOrNot(rpc: Rpc, programId: PublicKey): Promise<boolean> {
  try {
    return await epochsSupported(rpc, programId);
  } catch (e: any) {
    console.warn(`[epochs] could not read whether ${programId.toBase58()} has commit_epoch: ${e?.message ?? e}`);
    return false;
  }
}

/** OpenRouter ids the server may ask for. Cheapest first; the frontier entries cost ~100× more
 * per token and need a session cap above the default (LATH_SESSION_CAP_USDC) to finish. */
export const MODELS = new Set([
  "deepseek/deepseek-v4.1-flash",
  // Not offered by the wizard, which offers v4.1, but still accepted: older agents carry it in
  // their policy and in their template hash, and a policy this set rejects falls back to the
  // default — which would run a model the record does not name.
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-chat",
  "moonshotai/kimi-k3",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-haiku-4.5",
  "meta-llama/llama-3.3-70b-instruct",
]);

/** `.runtime-keypair.json` next to the app is the default; it is gitignored. */
const DEFAULT_KEYPAIR = path.join(process.cwd(), ".runtime-keypair.json");

export function loadKeypair(): Keypair | null {
  const spec = process.env.LATH_RUNTIME_KEYPAIR ?? (fs.existsSync(DEFAULT_KEYPAIR) ? DEFAULT_KEYPAIR : undefined);
  if (!spec) return null;
  try {
    const raw = spec.trim().startsWith("[") ? spec : fs.readFileSync(spec.replace(/^~/, os.homedir()), "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return null;
  }
}

/**
 * One keypair per role, derived from the server key so a redeploy keeps the same agents.
 *
 * `lattice-console:` is the frozen derivation domain. It seeds the authority of every agent this
 * console has ever deployed, and only the key that signed `register_agent` may ever append to
 * that agent's chain — so a different domain would derive a different key for every one of them
 * and orphan the chains already on devnet. The same bytes are
 * copied verbatim into `scripts/seed.ts` (`consoleDerived`); the two must stay identical.
 */
export function derived(parent: Keypair, role: string): Keypair {
  return Keypair.fromSeed(sha256(utf8(`lattice-console:${role}:`), parent.secretKey.slice(0, 32)));
}

export interface Roles {
  tag: string;
  agent: { key: Keypair; name: string };
  coordinator: { key: Keypair; name: string };
  sentinel: { key: Keypair; name: string };
  verifier: { key: Keypair; name: string };
}

export function roles(server: Keypair): Roles {
  const tag = (process.env.LATH_CONSOLE_TAG ?? server.publicKey.toBase58().slice(0, 6)).toLowerCase();
  return {
    tag,
    agent: { key: server, name: `console-agent-${tag}` },
    coordinator: { key: derived(server, "coordinator"), name: `console-coordinator-${tag}` },
    sentinel: { key: derived(server, "sentinel"), name: `console-sentinel-${tag}` },
    verifier: { key: derived(server, "verifier"), name: `console-verifier-${tag}` },
  };
}

/**
 * The roles of one agent deployed through `/api/agents`. The keys are derived from the deployed
 * *name*, so the server can rebuild them from `agents.json` alone and never stores a secret.
 */
export function deployedRoles(server: Keypair, name: string): Roles {
  return {
    tag: name,
    agent: { key: derived(server, `owner:${name}`), name },
    coordinator: { key: derived(server, `coordinator:${name}`), name: `${name}-coordinator` },
    sentinel: { key: derived(server, `sentinel:${name}`), name: `${name}-sentinel` },
    verifier: { key: derived(server, `verifier:${name}`), name: `${name}-verifier` },
  };
}

// ─── Wallet proof: a signed nonce, checked with Node's Ed25519 ──────────────

/** How long a signed message is accepted for, and therefore how long a nonce is remembered. */
export const AUTH_WINDOW_MS = 5 * 60_000;
/** How far ahead of this server's clock a signed message may be stamped. */
export const AUTH_SKEW_MS = 30_000;

/**
 * Process-wide state that has to be one value however many times Next evaluates this module.
 *
 * On `globalThis` for the reason the run slot below is: Next compiles each route into its own
 * module graph, so a module-level `Map` here would be one map per route bundle. The server-wide
 * `prepareCeiling` would then be a ceiling per route — three routes, three times the budget — the
 * `loop starts` and `clones` buckets that two routes charge on purpose would be two buckets each,
 * and a nonce accepted by one route's `verifyAuth` would still be fresh to the next. A dev
 * recompile would forget all three. Keyed by `Symbol.for`, so every bundle in the process finds
 * the same slot.
 */
const NONCES_KEY = Symbol.for("lath.usedNonces");
const RATE_LIMITS_KEY = Symbol.for("lath.rateLimits");
const SWEPT_AT_KEY = Symbol.for("lath.sweptAt");
const BOOT_AT_KEY = Symbol.for("lath.bootAt");
function processGlobal<T>(key: symbol, make: () => T): T {
  const g = globalThis as any;
  if (g[key] === undefined) g[key] = make();
  return g[key] as T;
}

/**
 * How often the nonce map and the rate-limit map are swept of what has expired, and when each
 * last was. Swept in full on every call, every signed request and every metered one would cost the
 * size of the map: a template flood from fresh wallets leaves one key per wallet in
 * `recentByCaller`, and at 300k keys each `rateLimit()` call would spend ~80 ms walking them. A
 * call touches its own key and sweeps the rest at most once a minute, so the cost of a quiet map
 * is paid once a minute rather than per request. What a caller sees is the same either way: its
 * own stamps are still filtered by the window on every call, and an entry that outlives its window
 * by up to a minute is one the window check already refuses.
 * On `globalThis` with the maps, so two route bundles do not each believe a sweep is due.
 */
const SWEEP_EVERY_MS = 60_000;
const sweptAt = processGlobal(SWEPT_AT_KEY, () => ({ nonces: 0, rates: 0 }));
function sweepDue(which: keyof typeof sweptAt, now: number): boolean {
  if (now - sweptAt[which] < SWEEP_EVERY_MS) return false;
  sweptAt[which] = now;
  return true;
}

/**
 * Unix ms this server process started, fixed the first time any bundle evaluates this module — the
 * same value for every route. It is the floor a restart needs: nonces are remembered in memory, so
 * a restart forgets them, and a signed message issued before this moment carries a nonce this
 * process cannot say it has not already accepted. Stamped at load rather than on first ask, so a
 * process whose first request comes an hour after boot still has its real boot time.
 */
export function bootAt(): number {
  return processGlobal(BOOT_AT_KEY, () => Date.now());
}
bootAt();

const usedNonces = processGlobal(NONCES_KEY, () => new Map<string, number>());
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface SessionAuth {
  message: string;
  /** Base64 of the 64-byte Ed25519 signature the wallet produced over `message`. */
  signature: string;
}

/**
 * What the message is for. The statement line of the signed text opens with it, so a deploy
 * signature cannot be replayed as a session signature or the other way round.
 *
 * `"Lath agent"` is for the owner requests on `POST /api/agents/:id` that change a *record* and
 * nothing on chain — `useVersion`, archive, unarchive; `"Lath template"` is for template writes. Both
 * are their own purpose for the same reason the others are: a signature the wallet gave to edit a
 * record must not be replayable as one that spends the operator's SOL. Within a purpose, the action
 * and target on the statement line are what keep an archive signature from being an unarchive, or
 * agent A's from being B's.
 */
/**
 * The purpose vocabulary and the exact bytes signed, from `@lath/sdk` — one definition for
 * both ends of the contract. Re-exported here because every route imports its auth surface from
 * this module.
 */
export type { AuthBinding, AuthPurpose } from "@lath/sdk";
export { authMessage, loopAuthBinding } from "@lath/sdk";
import type { AuthBinding, AuthPurpose } from "@lath/sdk";
import { authMessage, isTransientRpcError, SIWS_SUFFIX } from "@lath/sdk";

/**
 * The fields of a signed console message as its lines carry them, or `null` when the text is not
 * even line-shaped like one. Nothing here is believed: `verifyAuth` rebuilds the canonical text
 * from exactly these and accepts the message only if the two are byte for byte the same, so a
 * second copy of a line, a trailing line or a line out of order is refused there, whichever copy
 * this read.
 *
 * The shape (`authMessage`, SIWS): line 0 is `<domain> wants you to sign in with your Solana
 * account:`, line 1 the address, line 3 the statement `<purpose>: <action> <target>`, and from
 * line 5 the `Name: value` fields.
 */
function parseAuthMessage(message: string): {
  domain: string;
  wallet: string;
  purpose: string;
  action: string;
  target: string;
  field: (name: string) => string | undefined;
} | null {
  const lines = message.split("\n");
  if (lines.length < 10 || !lines[0].endsWith(SIWS_SUFFIX)) return null;
  const statement = /^(.+?): (\S+) (\S+)$/.exec(lines[3] ?? "");
  if (!statement) return null;
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  return {
    domain: lines[0].slice(0, -SIWS_SUFFIX.length),
    wallet: lines[1],
    purpose: statement[1],
    action: statement[2],
    target: statement[3],
    field,
  };
}

/**
 * The wallet a signed message names, or `null` when the line is missing or not a key.
 *
 * Every signed route reads this off the message rather than off the body: `verifyAuth` proves
 * the signature covers these exact bytes, so the address line inside them is the only claim a
 * caller cannot swap after signing. A message in the older shape (`wallet: <key>` on its own
 * line) is still read, so that `verifyAuth` can tell its signer to reload rather than answer "no
 * wallet signature".
 */
export function walletIn(message: unknown): PublicKey | null {
  // A body is unchecked JSON, and every signed route calls this on `body.auth.message` before
  // `verifyAuth` looks at the type: an `auth` that is a string, or a `message` that is a number,
  // threw here and answered an unsigned request with a 500 rather than "no wallet signature".
  if (typeof message !== "string") return null;
  const parsed = parseAuthMessage(message);
  const line = parsed
    ? parsed.wallet
    : message
        .split("\n")
        .find((l) => l.startsWith("wallet: "))
        ?.slice(8);
  try {
    return line ? new PublicKey(line) : null;
  } catch {
    return null;
  }
}

/**
 * What a message signed by a console older than this one is told: the five-line text (no action,
 * no target) and the seven-line text (no domain, no URI) alike. Neither is accepted — the first
 * would reopen the replay the action-and-target binding closes, the second the phishing the domain
 * closes — and both are one reload from the current text.
 */
export const UNBOUND_AUTH_REASON =
  "this message was signed by an older console and names no domain; reload and sign again";

/**
 * Where this console is: `LATH_CONSOLE_ORIGIN`, else the request's `Host`. It lives in `./origin`,
 * which imports nothing, because `src/middleware.ts` runs in the edge runtime and must give the same
 * answer as `verifyAuth` when it refuses another site's writes; re-exported here for the
 * routes that already name it from this module.
 */
export { consoleOrigin };

/**
 * Returns the wallet that signed, or a reason it is not accepted. Checks: the message is ours,
 * byte for byte, for this purpose, this action, this target, this body when one is bound and this
 * cluster; names this console as the site asking, by domain and URI; names the wallet the body
 * claims; was issued within the window and after this process started; carries a nonce not seen
 * before; and the signature verifies against the wallet's key.
 *
 * `bound` is required rather than defaulted, so a route cannot accept a signature without saying
 * what the signature has to be for. A route that forgot would accept any action on any target
 * the wallet owns, which would make a signature a bearer token; as a required parameter it fails
 * `tsc`.
 *
 * `origin` is where this console is (`consoleOrigin(req)`), which the message's `domain` and `URI`
 * lines must name. A lookalike site can get an owner to sign this console's exact text and
 * post it here within the window; what it cannot do is make the owner's wallet sign a message that
 * names this console's domain while the page is its own, because the wallet shows the domain, and
 * what the server refuses here is a message naming any other. Defaulted to the environment alone,
 * so a caller with no request still refuses rather than skips the check.
 */
export function verifyAuth(
  auth: SessionAuth | undefined,
  claimed: PublicKey | null,
  purpose: AuthPurpose,
  bound: AuthBinding,
  origin: { domain: string; uri: string | null } | null = consoleOrigin()
): { wallet: PublicKey } | { reason: string } {
  if (!auth || !claimed || typeof auth.message !== "string") return { reason: "no wallet signature" };
  const lines = auth.message.split("\n");
  // Fails closed. A tab opened on an older console signs a text whose first line is the purpose
  // itself — seven lines or five — which names no domain; accepting it would reopen exactly the
  // phishing the domain line closes.
  if (lines[0] === purpose) return { reason: UNBOUND_AUTH_REASON };
  const parsed = parseAuthMessage(auth.message);
  if (!parsed) return { reason: "message is not in the form this console signs" };
  if (parsed.purpose !== purpose) return { reason: `not a ${purpose.toLowerCase()} message` };
  const { field } = parsed;
  // Rebuilt from its own fields and compared byte for byte. `field` takes the first line of each
  // name, so a message with a second `Nonce:` line, a trailing line or its lines out of order would
  // be read one way here and could be read another way by anything else that looks at it. Only
  // the one canonical text is accepted.
  let canonical: string | null;
  try {
    canonical = authMessage(purpose, {
      action: parsed.action,
      target: parsed.target,
      body: field("Request ID"),
      domain: parsed.domain,
      uri: field("URI") ?? "",
      cluster: field("Chain ID") ?? "",
      wallet: parsed.wallet,
      issued: field("Issued At") ?? "",
      nonce: field("Nonce") ?? "",
    });
  } catch {
    canonical = null;
  }
  if (canonical !== auth.message) return { reason: "message is not in the form this console signs" };
  // The site asking. Compared before anything about the request, because a message for another
  // site is not this console's whatever else it says.
  if (!origin) return { reason: "this console does not know its own origin; set LATH_CONSOLE_ORIGIN" };
  if (parsed.domain !== origin.domain) {
    return { reason: `message was signed for ${parsed.domain}, not for this console (${origin.domain})` };
  }
  const uri = field("URI") ?? "";
  let uriHost: string | null = null;
  try {
    uriHost = new URL(uri).host;
  } catch {
    uriHost = null;
  }
  if (origin.uri !== null ? uri !== origin.uri : uriHost !== origin.domain) {
    return { reason: `message was signed at ${uri}, not at this console` };
  }
  if (field("Chain ID") !== CLUSTER) {
    return { reason: `message is for ${field("Chain ID")}, this server is ${CLUSTER}` };
  }
  if (parsed.wallet !== claimed.toBase58()) return { reason: "message names a different wallet" };
  if (parsed.action !== bound.action) {
    return { reason: `message was signed to ${parsed.action}, not to ${bound.action}` };
  }
  if (parsed.target !== bound.target) return { reason: "message was signed for a different target" };
  // The body, for the verb that binds one: a start signed for one body and posted with another is
  // a harvested signature put to a start its owner never signed. A message carrying a `Request ID` for a verb that
  // binds none is refused too, since nothing this console signs looks like that.
  if (field("Request ID") !== bound.body) {
    return { reason: "message was signed for a different request body" };
  }
  const issued = Date.parse(field("Issued At") ?? "");
  const now = Date.now();
  // One-sided: a message may be a little ahead of this clock (skew) but not far ahead, or the
  // acceptance span is twice the window while the nonce is remembered for one.
  if (!Number.isFinite(issued) || now - issued > AUTH_WINDOW_MS) return { reason: "signature expired" };
  if (issued - now > AUTH_SKEW_MS) return { reason: "signature issued in the future" };
  // The restart floor. Used nonces live in memory, so a restart forgets every one, and a message
  // still inside its window that the previous process had already accepted would be fresh again.
  // Refusing whatever was issued before this process started closes that without writing nonces
  // to disk. The floor is `bootAt()` itself, not `bootAt()` less the skew: a message stamped in
  // that last half-minute is one the previous process could have been accepting while it shut
  // down, which is the replay this is for. The cost is that a message signed just before a
  // restart has to be signed again.
  if (issued < bootAt()) return { reason: "signed before this server restarted; sign again" };
  const nonce = field("Nonce") ?? "";
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return { reason: "bad nonce" };
  if (sweepDue("nonces", now)) for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  // A lookup, not a scan. An entry that outlives its expiry by up to a minute refuses only a later
  // message that picked the same random nonce, which is no honest client's; the message it was
  // remembered for is already outside the window above.
  if (usedNonces.has(nonce)) return { reason: "nonce already used" };
  // A small-order key "signs" for anyone: OpenSSL's Ed25519 accepts the all-zero signature for the
  // all-zero key (`1111…1111`) over about one message in four, so a caller grinding the nonce could act
  // as that address. It owns nothing here, but the lifecycle records carry these messages as the owner's
  // word, and `lath-audit` refuses such a key; refusing it here keeps the two answers the same.
  if (isSmallOrderEd25519Key(claimed.toBytes())) return { reason: "this address cannot sign" };
  let ok = false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(claimed.toBytes())]),
      format: "der",
      type: "spki",
    });
    ok = verifySignature(null, Buffer.from(auth.message, "utf8"), key, Buffer.from(auth.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) return { reason: "signature does not verify" };
  // Remembered until the message itself can no longer be accepted, not for a window from now.
  usedNonces.set(nonce, issued + AUTH_WINDOW_MS + AUTH_SKEW_MS);
  return { wallet: claimed };
}

// ─── One runtime at a time: the slot a session and a loop step share ────────

/**
 * This server runs one `AgentRuntime` at a time.
 *
 * A session is not the only thing that writes a chain. A loop step is the second, it starts from
 * a timer rather than a request, and the two can want the *same* chain — an owner chatting to the agent its loop is
 * running. Two writers on one chain race for the seq a checkpoint leaf commits to, so they take
 * turns instead, through this one slot.
 *
 * The slot lives on `globalThis` because Next may evaluate a route module more than once in a
 * process (dev, and route-group boundaries): a module-level flag would then be two flags, and
 * two writers would both hold "the" lock. The deadline is a crash guard — a holder that dies
 * without releasing frees the slot when its deadline passes, rather than wedging the server.
 */
const SLOT_KEY = Symbol.for("lath.runSlot");
interface RunSlotState {
  holder: string | null;
  /**
   * Who holds the slot, as one acquisition rather than one label. `holder` is a sentence for the
   * refusal ("a store write"), and two callers of the same route share it: matched on the label, a
   * store write that outlived its TTL would release — in its `finally` — the slot the next store
   * write had taken on the lapse, and a third writer would then run beside the second.
   */
  token?: symbol;
  expiresAt: number;
}
function slotState(): RunSlotState {
  const g = globalThis as any;
  if (!g[SLOT_KEY]) g[SLOT_KEY] = { holder: null, expiresAt: 0 } as RunSlotState;
  return g[SLOT_KEY] as RunSlotState;
}

export interface RunSlot {
  holder: string;
  /**
   * Pushes the crash guard out while the holder is demonstrably still alive.
   *
   * The TTL exists so a process that dies mid-session frees the slot; it is not a statement that
   * the session has stopped writing. `/api/run` abandons a session at its deadline but cannot
   * reach inside the anchor drain to stop it, so it keeps extending the slot until the session
   * really exits — a second writer that took the slot on a lapsed TTL would race the first one
   * for the seq the queue is holding.
   */
  extend(ttlMs: number): void;
  release(): void;
}

/**
 * Whether the holder's crash guard should be pushed out again, and whether it has held past the
 * point where something is wrong.
 *
 * A heartbeat that stopped at `3 × SESSION_DEADLINE_MS` and let the TTL lapse, so that a wedged
 * session cannot own the server for ever, would not work: `runSlotHolder` reads a lapsed TTL as
 * *free*, so that ceiling would hand the slot to a second writer while the first one's anchor
 * drain was still writing the same chain — two writers racing for the seq a checkpoint leaf
 * commits to, which is the exact fork the slot exists to prevent.
 *
 * Of the two ways to close that race, aborting the first drain at the ceiling is not available:
 * the drain is `AnchorQueue.drain`, it takes no signal, and a drain stopped mid-record is worse
 * than a slow one. So the ceiling is not a release but a *report*: the slot is extended
 * for as long as the work has not exited, and a holder past the ceiling is logged as wedged so
 * the operator sees a stuck process instead of a silently forked chain. A second caller meanwhile
 * gets the ordinary "another run is in progress" refusal, which is a retry, not a fork.
 *
 * The work always exits: every submit is bounded (`indexerWaitMs`, the confirmation poll and
 * `maxAttempts`), every tool call a model makes is bounded (`get`'s `FETCH_DEADLINE_MS` for the web
 * tools, `boundedTool`'s `TOOL_DEADLINE_MS` for every read — without them a server dripping a byte
 * at a time would hold a `web.fetch_page` call, and with it this slot, open for as long as it dripped),
 * and a process that dies takes the TTL with it, which is what the TTL is for.
 */
export function extendRunSlot(p: {
  /** Whether the session or retry that holds the slot has exited yet. */
  workRunning: boolean;
  heldMs: number;
  limitMs: number;
}): { extend: boolean; wedged: boolean } {
  if (!p.workRunning) return { extend: false, wedged: false };
  return { extend: true, wedged: p.heldMs > p.limitMs };
}

/** Who holds the slot, or null when it is free. A stale holder counts as free. */
export function runSlotHolder(): string | null {
  const state = slotState();
  if (state.holder && state.expiresAt > Date.now()) return state.holder;
  return null;
}

/** Takes the slot, or returns `null` when someone else has it. */
export function acquireRunSlot(holder: string, ttlMs: number): RunSlot | null {
  const state = slotState();
  if (runSlotHolder()) return null;
  const token = Symbol(holder);
  state.holder = holder;
  state.token = token;
  state.expiresAt = Date.now() + ttlMs;
  return {
    holder,
    extend(ms: number) {
      // Only the holder extends, for the same reason only the holder releases.
      if (state.token === token) state.expiresAt = Date.now() + ms;
    },
    release() {
      // Only the holder releases: a caller whose deadline passed must not free the slot the
      // next writer has since taken — even when that writer came through the same route and
      // carries the same label (`RunSlotState.token`).
      if (state.token === token) {
        state.holder = null;
        state.token = undefined;
        state.expiresAt = 0;
      }
    },
  };
}

/**
 * Holds `slot` until `work` exits — resolves or rejects — and releases it then, never sooner.
 *
 * Here, outside `/api/run`, so a test can hold it to its promise: the request's deadline stops the
 * *wait* for a session, not the session, and a session past its deadline can still be draining
 * records into its chain. Releasing on the deadline would hand the slot to a second writer beside
 * that drain. The heartbeat pushes the crash guard out every `beatMs` while the work runs, past
 * `limitMs` too (`extendRunSlot`), and
 * `onWedged` is told once when it has held that long. Resolves after the release; never rejects.
 */
export function holdRunSlot(
  slot: RunSlot,
  work: Promise<unknown>,
  p: { ttlMs: number; limitMs: number; beatMs: number; onWedged: () => void }
): Promise<void> {
  const heldFrom = Date.now();
  let running = true;
  let reportedWedged = false;
  const beat = setInterval(() => {
    const decision = extendRunSlot({ workRunning: running, heldMs: Date.now() - heldFrom, limitMs: p.limitMs });
    if (decision.extend) slot.extend(p.ttlMs);
    if (decision.wedged && !reportedWedged) {
      reportedWedged = true;
      p.onWedged();
    }
  }, p.beatMs);
  return work
    .then(
      () => {},
      () => {}
    )
    .finally(() => {
      running = false;
      clearInterval(beat);
      slot.release();
    });
}

// ─── Per-caller rate limit, shared by the session and deploy routes ─────────

/** One map for the whole process, not one per route bundle; see `processGlobal`. */
const recentByCaller = processGlobal(RATE_LIMITS_KEY, () => new Map<string, number[]>());

/**
 * Each deploy funds a fresh child key from the server's SOL, so one wallet gets a few per hour.
 *
 * Clones — a deploy that names a `templateId`, which is what `POST /api/agents/:id` with
 * `action: "clone"` and the wizard's `×N` expansion both are — count against their own
 * allowance, because N copies of one template is the point of that flow and would otherwise
 * spend the whole deploy budget on the sixth agent. A wallet's ceiling is therefore the two
 * numbers together, and both are per hour, per wallet.
 */
export const DEPLOYS_PER_HOUR = Number(process.env.LATH_DEPLOYS_PER_HOUR ?? 5);
export const CLONES_PER_HOUR = Number(process.env.LATH_CLONES_PER_HOUR ?? 16);

/**
 * At most `perHour` calls per caller key per hour. The caller's own stamps are filtered by the
 * window on every call; the rest of the map is swept at most once a minute (`sweepDue`), so keys
 * that went quiet do not accumulate for the life of the process and a call does not cost the
 * size of the map. Returns a refusal or null.
 */
export function rateLimit(what: string, key: string, perHour: number): string | null {
  const now = Date.now();
  if (sweepDue("rates", now)) {
    for (const [k, stamps] of recentByCaller) {
      const live = stamps.filter((t) => now - t < 3_600_000);
      if (live.length === 0) recentByCaller.delete(k);
      else recentByCaller.set(k, live);
    }
  }
  const stamps = (recentByCaller.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (stamps.length >= perHour) {
    // The filtered list is kept, so a refused caller's
    // entry still shrinks as its stamps age out rather than only when it is next allowed.
    if (stamps.length) recentByCaller.set(key, stamps);
    return `rate limit: ${perHour} ${what} per hour`;
  }
  stamps.push(now);
  recentByCaller.set(key, stamps);
  return null;
}

/**
 * `rateLimit`'s answer without stamping anything: the refusal it would give now, or null. For a
 * caller charging several buckets at once, which asks them all before it stamps any, so a request
 * refused by one has not spent the others (`chargeTemplateWrite` in `_lib/templates.ts`).
 */
export function rateLimited(what: string, key: string, perHour: number): string | null {
  const now = Date.now();
  const live = (recentByCaller.get(key) ?? []).filter((t) => now - t < 3_600_000);
  return live.length >= perHour ? `rate limit: ${perHour} ${what} per hour` : null;
}

/**
 * The caller's address for rate limiting, or `"local"` when nothing vouched for one.
 *
 * **Neither header is read unless the deployment says a proxy sets it** (`LATH_TRUST_PROXY=1`).
 * Read unconditionally, `x-real-ip` would let any client write a fresh value per request, get a
 * fresh bucket every time, and every per-caller limit on this server would bound nothing. That is the direction that
 * matters for the operator: `DEPLOYS_PER_HOUR` and `CLONES_PER_HOUR` exist
 * because a prepared transaction, once broadcast, spends the operator's SOL.
 *
 * Untrusted, every caller is `"local"` and the limits fall back to being per *wallet*. The address
 * is in the key so that naming somebody else's wallet cannot empty their bucket; with `local` on
 * both sides an attacker
 * naming a victim's wallet shares the victim's bucket again. Those are the two halves of one
 * trade-off and only a deployment behind a proxy it controls can have both — which is what the
 * flag is for, and why it is named after the thing it asserts.
 *
 * **Neither half bounds an attacker**, and it is worth being exact about why. The three `prepare`
 * entry points take `wallet` *unsigned*, so with `caller` pinned to `"local"` the whole key is a
 * string the caller chooses: a fresh keypair per request is a fresh bucket per request, and the
 * counter never moves. That is not a proxy problem and `LATH_TRUST_PROXY=1` does not fix it —
 * the address only ever appears alongside the attacker's own wallet. What bounds the operator's
 * exposure is `prepareCeiling` below, which counts prepared transactions for the whole server.
 */
export function callerIp(req: { headers: { get(name: string): string | null } }): string {
  if (process.env.LATH_TRUST_PROXY !== "1") return "local";
  const chain =
    req.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((s) => s.trim()) ?? [];
  // The last hop is the one the trusted proxy appended; earlier entries are client-supplied.
  const last = chain[chain.length - 1];
  if (last) return last;
  return req.headers.get("x-real-ip")?.trim() || "local";
}

/**
 * How many callers' worth a per-address limit holds for `"local"` (`LATH_LOCAL_CALLERS`, default 10).
 *
 * Without `LATH_TRUST_PROXY=1` every request is that one caller. Sized for one, the first anonymous
 * visitor's six sessions would refuse every other anonymous visitor for the hour; charged nothing,
 * `local` would leave the RPC quota every loop step and deploy runs on unmetered. One policy for
 * both routes: `local` is charged, in one bucket that is bounded but holds this many callers'
 * worth. On a laptop console that is one person with room to spare; on a console reachable by many
 * and not behind a proxy, it is a ceiling over all of them, and the server-wide buckets beside it
 * still apply. A malformed value is the default.
 */
export const LOCAL_CALLERS = ((n) => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10))(
  Number(process.env.LATH_LOCAL_CALLERS ?? 10)
);

/** The multiple of a per-address limit `caller`'s bucket holds: `LOCAL_CALLERS` for `"local"`, else one. */
export function callerShare(caller: string): number {
  return caller === "local" ? LOCAL_CALLERS : 1;
}

/**
 * One ceiling over every transaction this server signs for somebody else, whoever asks.
 *
 * The per-wallet counters are the fair-use limit and they do their job for honest callers. They
 * are not a bound on the operator's SOL, because a `prepare` needs no signature: the caller names
 * a wallet, and naming a fresh one mints a fresh bucket. A prepared deploy is broadcastable by
 * whoever holds it — this server is the fee payer and the transaction carries a `CHILD_TOPUP_SOL`
 * transfer out of the runtime key — so the cost of a rotation loop falls entirely on the operator
 * and the counter meant to stop it never moves.
 *
 * A ceiling keyed on nothing is the only key an unauthenticated caller cannot rotate. It is
 * deliberately generous — it is a backstop against a script, not a per-user limit, and the
 * per-wallet counters are still what a person meets — and it is the number to raise if a busy
 * console starts refusing honest prepares.
 *
 * It covers the **message-signed** deploy too. A per-wallet counter alone would guard nothing on
 * that branch, because a wallet is a keypair anyone can mint in a loop: the signature proves
 * control of a fresh Ed25519 key, not that the caller is a person who has ever paid for
 * anything. Its two costs are larger than a prepare's, not smaller — `ensureFunded` moves
 * `CHILD_TOPUP_SOL` out of the runtime key and `register_agent` spends an `agent_id` for good
 * (`close_agent` is terminal) — so the branch that signs *and sends* must not be the one with
 * the weaker bound. The name stays `prepareCeiling` because every route that imports it means
 * the same thing by it: the operator's budget for transactions a stranger asked for.
 *
 * **A ceiling keyed on nothing is also a ceiling one caller can spend for everybody**: 200
 * well-formed unsigned prepares from one address, about four RPC reads each, and every honest
 * deploy and clone on the box would be refused for the hour. So the caller's address has a
 * bucket of its own, `PREPARES_PER_CALLER`, asked before the server's — and the route's own
 * per-wallet bucket is asked before both, passed in as `first`. Every bucket is *asked* before any
 * is *stamped* (`rateLimited`, then `rateLimit`, with no `await` between), so a request one of them
 * refuses has spent none of the others: an address at its own limit takes nothing from the
 * server's hour, and a server at its ceiling takes nothing from a wallet's.
 *
 * The address bucket applies only where an address means something — behind a proxy the
 * deployment vouches for (`LATH_TRUST_PROXY=1`, `callerIp`). Untrusted, every caller is `"local"`,
 * and a bucket keyed on that would be a second server-wide ceiling smaller than this one, which is
 * the outage made cheaper rather than closed. That is also the limit of what this closes: an
 * attacker with `PREPARES_PER_HOUR / PREPARES_PER_CALLER` addresses still spends the hour, and a
 * bound past that needs a step a fresh key cannot pass for free.
 */
const PREPARES_PER_HOUR = Number(process.env.LATH_PREPARES_PER_HOUR ?? 200);
/**
 * One address's prepares an hour, across deploys and clones. An honest wallet's own
 * ceilings sum to 21 (`DEPLOYS_PER_HOUR` 5, `CLONES_PER_HOUR` 16), and an
 * address can be a household or an office behind one NAT, so the default sits above one wallet's
 * whole hour and five of them still cannot spend the server's.
 */
export const PREPARES_PER_CALLER = Number(process.env.LATH_PREPARES_PER_CALLER_PER_HOUR ?? 40);

/** A per-hour bucket a route charges together with the prepare ceiling, as `rateLimit` takes one. */
export type HourlyBucket = { what: string; key: string; perHour: number };

export function prepareCeiling(caller?: string, ...first: HourlyBucket[]): string | null {
  const server: HourlyBucket = { what: "prepared transactions", key: "prepare:server", perHour: PREPARES_PER_HOUR };
  const address: HourlyBucket[] =
    caller && caller !== "local"
      ? [{ what: "prepared transactions", key: `prepare:caller:${caller}`, perHour: PREPARES_PER_CALLER }]
      : [];
  const buckets = [...first, ...address, server];
  for (const b of buckets) {
    const refused = rateLimited(b.what, b.key, b.perHour);
    if (!refused) continue;
    if (b === server) return `${refused} for this server; the operator pays for every one that is broadcast`;
    return address.includes(b) ? `${refused} from one address` : refused;
  }
  for (const b of buckets) rateLimit(b.what, b.key, b.perHour);
  return null;
}

// ─── Who can pay: escrow evidence, and what a session may spend ─────────────

/**
 * Micro-USDC this wallet can still spend from the treasury's escrow, or `null` when this
 * deployment has no treasury and therefore no way to be paid by anyone.
 *
 * This is the one thing about a caller that a fresh keypair does not come with. A signature
 * proves control of a key; a deposit proves somebody moved real USDC into the escrow this
 * operator sweeps from. Every per-wallet counter on this server is rotatable around
 * (`callerIp` says why); a balance is not, which is what makes it the right evidence to ask for
 * before spending the operator's SOL or its model credits on a stranger.
 *
 * `null` is deliberately not `0n`: a deployment with no `NEXT_PUBLIC_TREASURY_ADMIN` cannot be
 * paid, so refusing everyone for not having paid would be an instruction nobody can follow.
 * Callers read it as "this check does not apply here" and fall back to the ceilings.
 */
export async function escrowFor(rpc: Rpc, wallet: PublicKey, signer: Keypair): Promise<bigint | null> {
  if (!TREASURY_ADMIN) return null;
  try {
    const reader = BillingClient.fromIdl(rpc, signer, { admin: new PublicKey(TREASURY_ADMIN) });
    return await reader.spendable(wallet);
  } catch {
    // No balance account is the same answer as an empty one, and an RPC that cannot be read
    // must not be a way to pass the check.
    return 0n;
  }
}

/**
 * What a session is allowed to spend: real inference the operator pays the provider for, or the
 * scripted transport, or nothing.
 *
 * `openrouter` means one thing — the provider is paid over MPP from the operator's Tempo treasury
 * — and is the name because it is what the route reports on screen and what `/api/run`'s
 * `inference` field calls a real model call.
 */
export type SessionSpend =
  | { model: "openrouter" }
  | { model: "scripted"; note: string }
  /** Why the session is not run at all. Shown to the caller verbatim. */
  | { refuse: string };

/**
 * Who the operator pays a provider for, decided before the session opens.
 *
 * A signature proves control of an Ed25519 key and nothing else. Gating real inference on it alone
 * would let a stranger mint a keypair, sign, and get real inference the operator pays for, on a
 * chain the operator's SOL pays to write, under a `wallet:<key>` rate-limit bucket that is fresh
 * every time because the key is — and for that caller there is no allowance: `chainBilling` has
 * already fallen back to `NoopBilling` with `billingState: "unfunded"`.
 *
 * What a billed session spends is the treasury's USDC.e on Tempo. So the money follows the
 * billing, exactly as a loop step's does (`_lib/loop-channel.ts`: "only a charged step is paid for"):
 *
 * - **anonymous** — a real chain, the scripted transport, nothing billed. This is the
 *   console's open demo and it is bounded by the anonymous bucket and the single run slot.
 * - **charged** — a live `Allowance` from this wallet to the agent's authority, with escrow
 *   behind it. The provider is paid over MPP and the wallet is debited on Solana in the same
 *   transaction as the event. The allowance is the user's cap and is what bounds both.
 * - **the owner of a deployed agent, not yet charged** — the agent runs, scripted and unbilled,
 *   and says so. The allowance is a second transaction on the API deploy path and may simply not
 *   have landed yet; refusing the owner their own chain would be the wrong half to cut.
 * - **anyone else who signed** — refused, with the reason and the two ways out. Signing says
 *   "bill me", and this server cannot.
 */
export function sessionSpend(p: {
  /** Whether a wallet signature verified for this session. */
  signed: boolean;
  /** What `chainBilling` found: a live allowance, none, or no wallet to look for one under. */
  billingState: "charged" | "unfunded" | "no-wallet";
  /** Whether the signer owns the deployed agent this session runs on. */
  ownsTarget: boolean;
  /** Whether this deployment has a treasury at all. */
  treasury: boolean;
  /** The key an allowance would have to be granted to, and the agent it writes for. */
  authority: string;
  agentId: string;
}): SessionSpend {
  if (!p.signed) return { model: "scripted", note: "anonymous: scripted inference, unbilled" };
  if (p.billingState === "charged") return { model: "openrouter" };
  if (!p.treasury) {
    return {
      model: "scripted",
      note: "this deployment has no treasury, so no session can be billed: scripted inference, unbilled",
    };
  }
  if (p.ownsTarget) {
    return {
      model: "scripted",
      note: `no live allowance from this wallet to ${p.authority}: scripted inference, unbilled`,
    };
  }
  return {
    refuse:
      `this wallet has no live allowance to ${p.authority}, so this server will not pay for the session: ` +
      `grant one at /agent/${p.agentId} (it needs USDC in escrow behind it), or send the ` +
      `session without a wallet signature — anonymous sessions write the same chain with the scripted ` +
      `transport, unbilled.`,
  };
}

// ─── Funding and registration ───────────────────────────────────────────────

/**
 * Gives a child key enough SOL to sign with, from the server's key.
 *
 * The top-up is the usual amount when the server has it and whatever the server can spare above
 * its own reserve when it does not, down to the child's minimum. Below that there is nothing
 * sensible to send, so the error names the key that needs SOL and how much — a `Transfer:
 * insufficient lamports` from the system program says neither. On devnet an airdrop is tried
 * first; the faucet is rate-limited and often refuses, which is not an error here.
 */
export async function ensureFunded(rpc: Rpc, from: Keypair, to: PublicKey): Promise<string | null> {
  const balance = await rpc.getBalance(to);
  const min = Math.round(CHILD_MIN_SOL * LAMPORTS_PER_SOL);
  if (balance >= min) return null;

  const reserve = Math.round(SERVER_RESERVE_SOL * LAMPORTS_PER_SOL);
  let have = await rpc.getBalance(from.publicKey);
  if (have - reserve < min && CLUSTER === "devnet") {
    try {
      const sig = await rpc.requestAirdrop(from.publicKey, LAMPORTS_PER_SOL);
      const { lastValidBlockHeight } = await rpc.getLatestBlockhash();
      await confirmByPolling(rpc, sig, lastValidBlockHeight);
      have = await rpc.getBalance(from.publicKey);
    } catch {
      // The faucet said no; the message below says what to fund by hand.
    }
  }
  const spare = have - reserve;
  if (spare < min) {
    throw new Error(
      `the server's runtime key ${from.publicKey.toBase58()} holds ${(have / LAMPORTS_PER_SOL).toFixed(4)} SOL and ` +
        `needs at least ${(min + reserve) / LAMPORTS_PER_SOL} SOL to fund a new agent ` +
        `(${CHILD_MIN_SOL} for the agent, ${SERVER_RESERVE_SOL} kept for its own writes). Send it SOL and deploy again.`
    );
  }
  const lamports = Math.min(Math.round(CHILD_TOPUP_SOL * LAMPORTS_PER_SOL), spare);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  const bh = await rpc.getLatestBlockhash();
  tx.feePayer = from.publicKey;
  tx.recentBlockhash = bh.blockhash;
  tx.sign(from);
  const sig = await rpc.sendRawTransaction(tx.serialize());
  await confirmByPolling(rpc, sig, bh.lastValidBlockHeight);
  return sig;
}

/**
 * Publishes a deployed agent's name so its page reads the name instead of "Unnamed" —
 * `usePublishedName` has nothing to resolve otherwise, since `agent_id = sha256(name)` is
 * one-way. Best effort: a deployment that registered is a deployment, so a failed name write
 * must not fail the request.
 *
 * Best effort is not one shot, though: stateless.js throws on a Photon 429 instead of waiting,
 * and a single rate-limited read here would leave the agent "Unnamed" for good. The
 * whole read-then-write is retried on transient errors, which is safe because a repeat reads the
 * name first and writes nothing once it is on chain. When nothing is missing this costs two
 * reads, which is why a re-confirm can call it to repair a name an earlier confirm lost.
 */
export async function publishDeployedName(client: LathClient, idBytes: Uint8Array, name: string): Promise<void> {
  try {
    await withRetry(async () => {
      const record = new NameRecord(client, idBytes);
      await record.ensureCreated();
      if ((await record.name()) !== name) await record.publish(name);
    });
  } catch (e) {
    console.warn("[agents] name not published for", name, e);
  }
}

export interface Registered {
  /** `sha256(name)` in hex — the agent id. */
  id: string;
  name: string;
  /** Base58 of the key this server derived from the name and registered the header with. */
  authority: string;
  /** The `register_agent` signature, or null when the header was already on chain. */
  signature: string | null;
}

/**
 * The chain half of a deploy: fund the key derived from the name, register the header, publish
 * the name. Shared by `POST /api/agents` and the clone action on `POST /api/agents/:id`, which
 * differ only in where the policy comes from and what template the record links to.
 *
 * A `conflict` is a name already registered on this cluster under an authority this server does
 * not hold. The id is `sha256(name)`, so that name is taken and the only answer is another name.
 */
export async function registerDeployed(server: Keypair, name: string): Promise<Registered | { conflict: string }> {
  const key = deployedRoles(server, name).agent.key;

  const idBytes = idFromString(name);
  const rpc = rpcFor();
  const client = LathClient.fromIdl(rpc, key);

  // A failed read throws rather than reading as "not registered", for the reason in
  // `prepareDeployTxOnce`: absent would fund the key and attempt `register_agent` blind.
  const state = await client.getAgentState(idBytes);
  if (state && !state.state.authority.equals(key.publicKey)) {
    return {
      conflict:
        `${name} is already registered on ${CLUSTER} under ${state.state.authority.toBase58()}; ` + `pick another name`,
    };
  }

  let signature: string | null = null;
  if (!state) {
    // The server pays for the header, so the key has to hold SOL before it signs.
    await ensureFunded(rpc, server, key.publicKey);
    signature = (await client.registerAgent(idBytes)).signature;
  }
  await publishDeployedName(client, idBytes, name);

  return { id: hex(idBytes), name, authority: key.publicKey.toBase58(), signature };
}

/** Registers the agent, its structures and its published name. Idempotent. */
export async function ensureAgent(client: LathClient, id: Uint8Array, name: string): Promise<void> {
  await new AgentLogger(client, id).ensureRegistered();
  const record = new NameRecord(client, id);
  await record.ensureCreated();
  if ((await record.name()) !== name) {
    try {
      await record.publish(name);
    } catch {
      // Already published under this id: `publish` proves first publication and refuses a repeat.
    }
  }
}

// ─── The registry of deployed agents ────────────────────────────────────────

export interface DeployedPolicy {
  model: string;
  tools: string[];
  budgetCapUsdc: string;
  expirationDays: number;
  /**
   * How the agent's inference is paid for. `"tempo"` on every row this server can sign a voucher
   * for; absent on an older row with no rail, and on one deployed with no treasury behind it
   * (`deployRailFields`). `"vault"` is readable and not written: the runtime normalises it away
   * before hashing, so a row with no rail and a `vault` row share a genesis hash.
   */
  payment?: "vault" | "tempo";
}

export interface DeployedAgent {
  name: string;
  /** Base58 of the key this server derived and registered the header with. */
  authority: string;
  /**
   * Base58 of the wallet that signed the deploy. Only its signature opens a session on this
   * agent: the chain is the owner's history, and anyone else appending to it would be writing
   * that history for them. Absent on records made before ownership was recorded; those cannot
   * be run until redeployed.
   */
  owner?: string;
  createdAt: number;
  policy: DeployedPolicy;
  /**
   * What this agent is for, in the deployer's words. Console-side only: nothing on chain commits
   * to it, and it is deliberately *not* the system prompt — the prompt lives in the template's
   * `config.prompt`, is hashed into `policy_version_hash` and has a preimage in the trace store
   * (`templateSystemPrompt`), while this is a label a list can show: the wizard asks for one, and
   * the tile grid shows it.
   *
   * Optional on read, because older rows have none, and absent rather than
   * empty when the deployer left the field blank — `normalizeDescription` is what decides that,
   * so the registry never holds `""`.
   */
  description?: string;
  /**
   * The template version this agent was deployed from — `{ id, version, hash }`, the console's
   * lineage key and not a chain fact. Written on every new record; absent on older records made
   * without a template, which is why nothing may require it.
   */
  template?: TemplateLink;
  /**
   * The agent this one was cloned from, when it was. The chain has no notion of a clone —
   * `agent_id = sha256(name)`, so a clone is a new name and a new chain — and this is what lets
   * the agent page say where it came from.
   *
   * `via: "market"` marks the copy as a launch off someone else's published offer rather than the
   * owner copying their own agent; the market is on the roadmap, so this build writes it on no
   * row. Absence reads as *the owner's own copy*, so nothing has to be migrated.
   *
   * A row launched from a listing on another console may also carry `listing`, the manifest's hash
   * and the `agent.offer` record's seq, and a copy registered for a team may carry `billedBy`, the
   * agent whose cap paid for it. Nothing in this build reads either: the market and teams are on
   * the roadmap, and the keys stay on disk as written.
   */
  clonedFrom?: { agentId: string; name: string; via?: "market" };
  /**
   * What an older row carries from when an agent on the `tempo` rail paid from a wallet of its own
   * (`_lib/tempo.ts` documents them; this build writes none of the first five). Every one is
   * optional on read: a row with no rail carries none, a `vault` row never gains any, and a current
   * row has none either — the treasury pays. The address is derived from the agent key and recorded
   * only so a screen can link it; no key is ever stored.
   */
  tempoAddress?: string;
  /** Older rows: lifetime total sent to that address, USDC.e base units as a decimal string. */
  tempoFunded?: string;
  /** Older rows: the last TIP-20 transfer that funded it. */
  tempoFundTx?: string;
  /** Older rows: what was returned from that wallet to the treasury, base units. */
  tempoDrained?: string;
  /** The TIP-20 transfer that drained it. */
  tempoDrainTx?: string;
  /** Why the agent runs on `vault` although its config asked for `tempo`. */
  tempoNote?: string;
  /**
   * Unix ms the record was archived. Archiving is off-chain and is not deletion: the header, the
   * `NameRecord` and the allowance stay, `lookupAgent` still resolves so verification and
   * `/api/traces` keep working, and only the console's lists and new sessions change.
   */
  archivedAt?: number;
  /**
   * The agent's lifecycle records on its own chain (`_lib/lifecycle.ts`): its `agent.deploy` and its
   * archive marks, written and owed, and whether the row was rebuilt from the chain. Absent on every
   * row deployed before the records or with `LATH_LIFECYCLE` off. Never served as is: the owed
   * documents carry the owner's signature and prompt, and `GET /api/agents` hands `chain` instead.
   */
  lifecycle?: LifecycleState;
}

/** The longest description the registry keeps. A tile shows two lines; this is the store's bound. */
export const MAX_DESCRIPTION = 200;

/**
 * What goes on the record for `description`, or `undefined` for anything that is not worth a key.
 *
 * Trimmed and clamped rather than refused: a description is a label, and a deploy is a
 * `register_agent` that spends an `agent_id` for good — failing one over a long sentence would
 * cost the deployer their name for nothing. Blank becomes absent, so a row a person left empty is
 * byte-identical to a row written before the field existed and every reader has one case, not two.
 */
export function normalizeDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().slice(0, MAX_DESCRIPTION);
  return trimmed || undefined;
}

const REGISTRY = () => path.join(TRACE_DIR, "agents.json");

/**
 * id (hex) → what was deployed under it. The file is the only thing that survives a restart; the
 * keys themselves are re-derived from the name, so losing it costs the mapping, not the chain.
 */
/**
 * A stored record is a `DeployedAgent` only if it has the keys the current code reads, and is
 * not another owner kind: a row with `kind: "swarm"` was registered under a different seed by a
 * different derived key, so treating it as an agent
 * would derive a key that owns nothing and, on the first session, register a second chain under
 * the same id. Such rows are dropped here, logged once per process.
 */
function isDeployedAgent(v: unknown): v is DeployedAgent {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.authority === "string" &&
    typeof r.createdAt === "number" &&
    !!r.policy &&
    typeof r.policy === "object" &&
    (r.kind === undefined || r.kind === "agent")
  );
}

const droppedAgents = new Set<string>();

/**
 * The rows `readRegistry` could not read, keyed by the map it returned, and merged back by
 * `writeRegistry` — the `unreadRows` of `loop-registry.ts`, for the same reason. Every write here is a
 * read-modify-write of the whole map, so a row this build does not read (an older shape, a hand
 * edit, another owner kind) would otherwise be erased by the next deploy or archive, though
 * nothing had asked to remove it.
 */
const unreadAgents = new WeakMap<object, Record<string, unknown>>();

/**
 * Throws when `agents.json` exists and cannot be read or parsed. Answering `{}` to any failure
 * would let the next `recordAgent` save that `{}` over the file: one `EMFILE` on the read plus one
 * deploy confirm would leave the registry holding only that deploy's agent. Only a
 * missing file is empty (`readJsonOr`); a read path that throws answers an error instead of an
 * empty list, and a write path never reaches its write.
 */
export function readRegistry(): Record<string, DeployedAgent> {
  const parsed = readJsonOr<unknown>(REGISTRY(), () => ({}));
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, DeployedAgent> = {};
  const unread: Record<string, unknown> = {};
  for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
    // `JSON.parse` makes `__proto__` an own key, and assigning it would set a map's prototype
    // rather than add a row (`readLoops`). No agent id is spelled so, so the key is dropped.
    if (id === "__proto__") continue;
    if (isDeployedAgent(rec)) out[id] = rec;
    else {
      unread[id] = rec;
      if (!droppedAgents.has(id)) {
        droppedAgents.add(id);
        console.warn(`[agents] ${id} in agents.json is not a current agent record; not read, and kept as it is`);
      }
    }
  }
  if (Object.keys(unread).length > 0) unreadAgents.set(out, unread);
  return out;
}

export function lookupAgent(id: string): DeployedAgent | null {
  const all = readRegistry();
  const key = id.toLowerCase();
  // An own key only: the registry is a plain object, so `all["constructor"]` is `Object` and
  // `all["__proto__"]` its prototype, and an id spelled that way would otherwise read as a deployed
  // agent named "Object". `Object.hasOwn` is ES2022 and both tsconfigs pin lib es2020.
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
}

/** Atomic: write beside the file and rename, so a crash never leaves half a registry. */
export function recordAgent(id: string, record: DeployedAgent): void {
  const all = readRegistry();
  all[id.toLowerCase()] = record;
  writeRegistry(all);
}

/**
 * The rows `readRegistry` could not read go back as they were (`unreadAgents`); a row the caller
 * holds under the same id wins, since it was written by this build.
 */
function writeRegistry(all: Record<string, DeployedAgent>): void {
  const unread = unreadAgents.get(all);
  writeJsonAtomic(REGISTRY(), unread ? { ...unread, ...all } : all);
}

/**
 * Changes one record and returns what was stored, or null when the id is unknown. The read and
 * the write are one call so two edits arriving together cannot each write a record built from
 * the same stale registry.
 */
export function updateAgent(id: string, change: (agent: DeployedAgent) => DeployedAgent): DeployedAgent | null {
  const all = readRegistry();
  const key = id.toLowerCase();
  const current = all[key];
  if (!current) return null;
  const next = change(current);
  all[key] = next;
  writeRegistry(all);
  return next;
}

/** Is this agent archived? What `/api/run` asks before it opens a session on one. */
export function isArchived(agent: DeployedAgent): boolean {
  return typeof agent.archivedAt === "number";
}

/**
 * Sets `archivedAt`, once: archiving twice keeps the first stamp, so the date the page shows is
 * when the owner archived the agent and not when they last pressed the button.
 */
export function archiveAgent(id: string, at: number = Date.now()): DeployedAgent | null {
  return updateAgent(id, (a) => (a.archivedAt ? a : { ...a, archivedAt: at }));
}

/**
 * Takes the stamp off, so the agent is in the lists again and `/api/run` accepts sessions on it.
 *
 * Archive is *not deletion*, and this verb is what makes that true: without it one click would
 * hide an agent from every list for good, so *archive* would mean delete for an agent while it
 * means "write a new version" for a template. The key is removed rather than set to a
 * sentinel, so a record that has been round-tripped is byte-identical to one that was never
 * archived — `isArchived` asks whether the key is a number.
 */
export function unarchiveAgent(id: string): DeployedAgent | null {
  return updateAgent(id, ({ archivedAt, ...rest }) => rest);
}

// ─── One-transaction deploy ─────────────────────────────────────────────────

/**
 * A deploy the wallet signs **once**, as one transaction.
 *
 * Writing the header first and asking for the allowance after leaves a state nothing should be
 * able to reach: an agent registered on chain, funded, and unpayable — after a clone, or when a
 * tab closes between the two steps. A single transaction makes it unrepresentable. Either the
 * agent exists with its allowance, or nothing happened.
 *
 * Three instructions, two signers, one signature from the person:
 *
 * - `transfer` — the server tops the agent's child key up for its own write fees;
 * - `register_agent` — signed by that child key, because on chain the `authority` is whoever
 *   signed the registration and only that key may ever append to the chain;
 * - `approve_agent` — signed by the wallet, because only it can delegate its own USDC.
 *
 * The server is the fee payer and partial-signs before the browser sees it, so the person still
 * pays no SOL. The name record is *not* in here: it is two more compressed writes with proofs of
 * their own, which would put the transaction over the size limit, and a missing published name
 * is cosmetic where a missing allowance is not. It is written server-side on confirm.
 */
type PreparedDeploy =
  | { transaction: string; message: string; authority: string; id: string; lastValidBlockHeight: number }
  | { conflict: string };

/** How many times `prepareDeployTx` asks again after a transient RPC failure, and how long it waits. */
const PREPARE_RPC_ATTEMPTS = 4;
const PREPARE_RPC_BACKOFF_MS = 750;

/**
 * Builds the deploy transaction, asking the RPC again on a transient failure (a 429, a 5xx, a
 * dropped socket, Photon's intermittent `Method not found` — `isTransientRpcError`).
 *
 * Retrying the whole build is safe because it writes nothing: it reads state, fetches a proof and
 * a blockhash, and partly signs bytes the wallet has not seen, so a second build simply replaces
 * the first. Without it, one 429 from the devnet RPC would reach the wizard as "HTTP error!
 * status: 429" and the deploy would have to be started over by hand.
 */
export async function prepareDeployTx(
  server: Keypair,
  name: string,
  p: { wallet: PublicKey; cap: bigint; expiresAt: bigint; policyVersionHash: Uint8Array }
): Promise<PreparedDeploy> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prepareDeployTxOnce(server, name, p);
    } catch (e) {
      if (attempt >= PREPARE_RPC_ATTEMPTS || !isTransientRpcError(e)) throw e;
      await new Promise((r) => setTimeout(r, PREPARE_RPC_BACKOFF_MS * attempt));
    }
  }
}

async function prepareDeployTxOnce(
  server: Keypair,
  name: string,
  p: { wallet: PublicKey; cap: bigint; expiresAt: bigint; policyVersionHash: Uint8Array }
): Promise<PreparedDeploy> {
  const key = deployedRoles(server, name).agent.key;

  // The whole safety of an unauthenticated `prepare` is that what it returns is *inert*: the
  // wallet's signature on `approve_agent` is the authorisation, and the server cannot supply it.
  // That holds only while the wallet is a key this server does not hold — and both of the keys it
  // does hold are public, the runtime key from `GET /api/run` and the derived authority from this
  // very response. Naming one of them as the allowance `user` collapses the missing signature onto
  // a signature the server is about to add, and `prepare` hands back a transaction anyone can
  // broadcast: the operator pays the fee, the child top-up and the allowance rent, and the name is
  // registered under an `owner` no wallet can ever prove, so it can never be run or reclaimed.
  if (p.wallet.equals(server.publicKey) || p.wallet.equals(key.publicKey)) {
    return { conflict: "the allowance has to be signed by a wallet this server does not hold" };
  }

  const idBytes = idFromString(name);
  const rpc = rpcFor();
  const client = LathClient.fromIdl(rpc, key);

  // `getAgentState` answers null for a header that is not there and throws when the read itself
  // failed. Only the null may mean "free": an RPC error read as absent skipped this conflict and
  // built `register_agent` for a name that may already be taken. The throw reaches
  // `prepareDeployTx`, which retries it if it is transient.
  const state = await client.getAgentState(idBytes);
  if (state && !state.state.authority.equals(key.publicKey)) {
    return {
      conflict: `${name} is already registered on ${CLUSTER} under ${state.state.authority.toBase58()}; pick another name`,
    };
  }
  if (state) return { conflict: `${name} is already registered on ${CLUSTER}` };

  const instructions: TransactionInstruction[] = [];

  // The child key pays for its own writes, so it needs lamports before it signs anything. The
  // top-up rides along here rather than as a transaction of its own.
  const balance = await rpc.getBalance(key.publicKey);
  const min = Math.round(CHILD_MIN_SOL * LAMPORTS_PER_SOL);
  if (balance < min) {
    const have = await rpc.getBalance(server.publicKey);
    const spare = have - Math.round(SERVER_RESERVE_SOL * LAMPORTS_PER_SOL);
    const lamports = Math.min(Math.round(CHILD_TOPUP_SOL * LAMPORTS_PER_SOL), spare);
    if (lamports < min) {
      throw new Error(
        `the server's runtime key ${server.publicKey.toBase58()} holds ${(have / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
          `and cannot fund a new agent. Send it SOL and deploy again.`
      );
    }
    instructions.push(SystemProgram.transfer({ fromPubkey: server.publicKey, toPubkey: key.publicKey, lamports }));
  }

  const { instructions: registerIx } = await client.registerAgentIx(idBytes);
  instructions.push(...registerIx);

  const billing = BillingClient.fromIdl(rpc, key, {
    admin: TREASURY_ADMIN ? new PublicKey(TREASURY_ADMIN) : undefined,
    lath: client,
  });
  instructions.push(
    await billing.approveAgentIx({
      agentAuthority: key.publicKey,
      cap: p.cap,
      expiresAt: p.expiresAt,
      policyVersionHash: p.policyVersionHash as Bytes32,
      user: p.wallet,
    })
  );

  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.add(...instructions);
  tx.feePayer = server.publicKey;
  tx.recentBlockhash = blockhash;
  // Both server-side signatures go on now; the wallet's is the only one still missing.
  tx.partialSign(server, key);

  // Fail closed rather than on the check above alone: whatever the instructions are, a prepared
  // transaction that is *already complete* is one this server has authorised by itself.
  if (tx.signatures.every((s) => s.signature !== null)) {
    throw new Error("the prepared transaction needs no wallet signature; refusing to hand it out");
  }

  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (wire.length > 1232) {
    throw new Error(
      `the deploy transaction is ${wire.length} bytes, over the 1232-byte limit; ` +
        `the registration proof and the allowance no longer fit together`
    );
  }

  return {
    transaction: Buffer.from(wire).toString("base64"),
    // The message bytes the wallet is about to sign, kept so `confirm` can recognise the
    // transaction that lands as *this* one. Never sent to the browser: it already has them,
    // inside `transaction`, and what makes them useful here is that the server remembers them.
    message: Buffer.from(tx.serializeMessage()).toString("base64"),
    authority: key.publicKey.toBase58(),
    id: hex(idBytes),
    lastValidBlockHeight,
  };
}

/** What a message-signed deploy hands back for the wallet to sign next: `approve_agent` alone. */
export interface PreparedAllowance {
  /** Base64 of the unsigned transaction. Fee payer and only signer: the wallet. */
  transaction: string;
  capMicroUsdc: string;
  expiresAt: string;
  policyVersionHash: string;
  lastValidBlockHeight: number;
}

/**
 * The allowance a message-signed deploy could not put in its transaction, built for the wallet
 * to sign as a second one.
 *
 * `registerDeployed` writes the header and nothing else, because the server holds no key that can
 * delegate the wallet's USDC. Every caller of that path — the specs and anything run from a terminal —
 * names a positive cap in its policy, and without this every one of them would be recorded with a
 * budget it does not have: a loop step is charged only against a live allowance from the owner to
 * the agent's authority, and an unbilled step is never handed the operator's model key
 * (`loops.ts`), so a terminal deploy would be answered from the scripted transport however good the
 * key was.
 *
 * The wallet has already proved itself by signing the deploy message, so this hands it the
 * instruction the browser's deploy carries inside its one transaction. Nothing here is signed by
 * the server: the wallet is the fee payer and the only signer `approve_agent` needs, so the bytes
 * are inert until it signs them, and the server pays for none of it — which is also why this
 * cannot fund the agent's child key the way `prepareDeployTx` does; `registerDeployed` already has.
 */
export async function prepareAllowanceTx(
  server: Keypair,
  name: string,
  p: { wallet: PublicKey; cap: bigint; expiresAt: bigint; policyVersionHash: Uint8Array }
): Promise<PreparedAllowance> {
  const key = deployedRoles(server, name).agent.key;
  const rpc = rpcFor();
  const billing = BillingClient.fromIdl(rpc, key, {
    admin: TREASURY_ADMIN ? new PublicKey(TREASURY_ADMIN) : undefined,
  });
  const ix = await billing.approveAgentIx({
    agentAuthority: key.publicKey,
    cap: p.cap,
    expiresAt: p.expiresAt,
    policyVersionHash: p.policyVersionHash as Bytes32,
    user: p.wallet,
  });
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.add(ix);
  tx.feePayer = p.wallet;
  tx.recentBlockhash = blockhash;
  return {
    transaction: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"),
    capMicroUsdc: p.cap.toString(),
    expiresAt: p.expiresAt.toString(),
    policyVersionHash: Buffer.from(p.policyVersionHash).toString("hex"),
    lastValidBlockHeight,
  };
}

/**
 * Did the transaction this server prepared actually land? Read the chain rather than believe the
 * browser: the record is written only when the header is really there under the key we derived.
 */
export async function deployLanded(server: Keypair, name: string): Promise<{ authority: string } | null> {
  const key = deployedRoles(server, name).agent.key;
  const client = LathClient.fromIdl(rpcFor(), key);
  const state = await client.getAgentState(idFromString(name)).catch(() => null);
  if (!state || !state.state.authority.equals(key.publicKey)) return null;
  return { authority: key.publicKey.toBase58() };
}

// ─── Deploy tickets ─────────────────────────────────────────────────────────

/**
 * What `prepare` remembers so `confirm` needs no second signature.
 *
 * The wallet signs one message and one transaction, and that is the whole ceremony. Sending the
 * same signed message again would be a replay, and `verifyAuth` refuses it by design (the nonce
 * is remembered) — so the prepared deploy hands back a ticket instead: a capability, held here,
 * naming the wallet that was already verified and the configuration that was already checked.
 * `confirm` presents the ticket, the server reads the chain, and only a header that is really
 * there becomes a record.
 *
 * Tickets live in memory and for ten minutes: long enough for a person to approve a transaction,
 * short enough that a forgotten one is gone. They are single-use.
 */
export interface DeployTicket {
  wallet: string;
  name: string;
  /** Base64 of the message bytes `prepare` built, which `confirm` requires the landed transaction
   * to be. Without it a ticket names a wallet and nothing binds that wallet to the transaction. */
  message: string;
  policy: DeployedPolicy;
  prompt?: string;
  /**
   * The description the deploy asked for, held across the two calls. `prepare` writes no record,
   * so anything the body carries and `confirm` does not read is simply lost.
   */
  description?: string;
  templateId?: string;
  version?: number;
  /**
   * What the deploy meant by its `templateId`: `append` when it carried a config of its own and
   * owns the template, `fork` when it asked for a lineage of its own. `confirm` cannot work this
   * out from the hashes — an older template may carry `payment: "vault"`, which `deployRailFields`
   * normalises away, so a plain *Run again* on it would look like an edit. Absent on a short clone
   * body and on an older ticket, which reads as neither.
   */
  append?: boolean;
  fork?: boolean;
  /**
   * *Run as agent loop*, when the deploy asked for one. The transaction this ticket is about carries
   * the allowance a loop spends against, and `confirm` proves the wallet signed it — so the loop
   * rides on that one authorisation instead of a second `"Lath loop"` prompt after a completed
   * deploy.
   */
  loop?: LoopStartBody;
  /** The caller's address at prepare, so the loop-start counter at confirm keys the same way. */
  caller?: string;
  expiresAt: number;
}

const TICKET_TTL_MS = 10 * 60_000;
// On `globalThis` for the reason `ticketStore` in `_lib/copy.ts` gives.
const ticketsHolder = globalThis as typeof globalThis & { __lathDeployTickets?: Map<string, DeployTicket> };
const tickets = (ticketsHolder.__lathDeployTickets ??= new Map<string, DeployTicket>());

export function issueDeployTicket(t: Omit<DeployTicket, "expiresAt">): string {
  const now = Date.now();
  for (const [id, held] of tickets) if (held.expiresAt < now) tickets.delete(id);
  const id = randomBytes(16).toString("hex");
  tickets.set(id, { ...t, expiresAt: now + TICKET_TTL_MS });
  return id;
}

/**
 * The ticket, still held.
 *
 * `confirm` reads it, asks the chain, and spends it only once the chain has answered — because
 * the transaction has *already landed* by the time confirm runs, and a ticket spent on an RPC
 * that had not caught up yet is a name burned: the header is on chain, no record was written,
 * and `prepareDeployTx` will refuse that name as `already registered` forever.
 */
export function peekDeployTicket(id: string | undefined): DeployTicket | null {
  if (!id) return null;
  const held = tickets.get(id);
  if (!held) return null;
  if (held.expiresAt < Date.now()) {
    tickets.delete(id);
    return null;
  }
  return held;
}

/** Spend it: the chain has answered, one way or the other. */
export function spendDeployTicket(id: string): void {
  tickets.delete(id);
}

/**
 * The seven steps every landed deploy shares: prove the transaction, tolerate an indexer that
 * has not caught up, and spend the ticket exactly once.
 *
 * Deploy and clone share this. They differ only in the noun in the error string, what they record
 * afterwards, and what rides on the answer — none of which is here.
 *
 * The two refusals are not the same kind and the difference is the whole point. `transient` says
 * a refusal is worth presenting the ticket for again, and a ticket is spent only on one that is
 * not: by the time a confirm runs the transaction has already landed, so a ticket burned because
 * one RPC node was a slot behind would leave a registered, funded agent with no record, under a
 * name `prepareDeployTx` refuses forever. Get this backwards and a retry loop spends the ticket on
 * a permanent refusal, and what finally surfaces to the user is "unknown
 * ticket" instead of what was actually wrong.
 *
 * The `deployLanded` miss is transient by construction: `deployTxSignedBy` has already proved
 * this transaction landed and succeeded, so a header that is not there yet is the
 * compressed-account indexer lagging the transaction it came from, which on devnet it routinely
 * does.
 */
export async function confirmLandedDeploy(opts: {
  /** The noun in the refusal: "deploy" or "clone". */
  noun: string;
  server: Keypair;
  name: string;
  signature: string;
  ticket: { message: string; wallet: string };
  /** Spends this ticket. Called exactly where the chain has answered, and nowhere else. */
  spend: () => void;
  /**
   * The two chain reads, injected so the spend rule above can be tested against a fake chain
   * (`tests/console-confirm.ts`) — the same seam `RequestPoll` uses in `_lib/loops.ts`. Neither
   * route passes them; production is the default.
   */
  chain?: {
    signedBy?: typeof deployTxSignedBy;
    landed?: typeof deployLanded;
  };
}): Promise<{ refused: Response } | { authority: string }> {
  const signedBy = opts.chain?.signedBy ?? deployTxSignedBy;
  const landedOn = opts.chain?.landed ?? deployLanded;
  const signed = await signedBy(opts.signature, { message: opts.ticket.message, wallet: opts.ticket.wallet });
  if ("reason" in signed) {
    if (!signed.transient) opts.spend();
    return {
      refused: Response.json(
        {
          error: `this ${opts.noun} is not confirmed: ${signed.reason}`,
          ...(signed.transient ? { transient: true } : {}),
        },
        { status: 409 }
      ),
    };
  }

  const landed = await landedOn(opts.server, opts.name);
  if (!landed) {
    return {
      refused: Response.json(
        {
          error: `no agent ${opts.name} on ${CLUSTER}: the ${opts.noun} transaction did not land`,
          transient: true,
        },
        { status: 409 }
      ),
    };
  }
  opts.spend();
  return { authority: landed.authority };
}

/**
 * Publishes the on-chain name, and does not fail the confirm if it cannot.
 *
 * Cosmetic and paid for by the server, which is why it is not in the transaction the wallet
 * signed: a name that does not publish leaves an agent that works and reads by id. By the time
 * this runs the record is written, so throwing here would lose a response for something that
 * already succeeded.
 */
export async function publishNameQuietly(server: Keypair, idBytes: Uint8Array, name: string): Promise<void> {
  await publishDeployedName(LathClient.fromIdl(rpcFor(), deployedRoles(server, name).agent.key), idBytes, name).catch(
    () => {
      /* the agent stands; only its published name is missing */
    }
  );
}

/**
 * Did the wallet sign the transaction this server prepared, and did that transaction land?
 *
 * This is the whole authorisation of a one-transaction deploy, so it is worth saying exactly
 * what it proves and what it does not.
 *
 * It does **not** ask the chain for an allowance from the wallet to the agent's authority, though
 * `approve_agent` is the wallet's own instruction: `approve_agent` takes `agent_authority` as a
 * plain argument (`programs/lath-billing`), so *anybody* can create an allowance PDA naming *any*
 * authority for the price of the rent — and `prepare` hands the authority out to an
 * unauthenticated caller. An attacker could therefore bank a ticket for a name someone else was
 * deploying, grant itself an allowance against that name's authority in advance, and confirm in
 * the gap: an allowance check would pass, and `recordAgent` would write the attacker as `owner` of
 * the victim's agent. The record is the authz root for `/api/run`, loops, clone and publish, so
 * that would be a full takeover.
 *
 * What this asks instead is the question an allowance check only looks like it is asking:
 *
 * - the signature names a transaction that is **on chain and succeeded**, and
 * - that transaction's message is **byte-for-byte the one `prepare` built for this ticket**, and
 * - the ticket's wallet is one of the signers that message requires.
 *
 * A landed transaction has valid signatures for every key its message requires, so the third
 * point is not a claim about a byte we were handed — it is the chain's. And because the message
 * is the prepared one, its `approve_agent` names the ticket's wallet as `user`: the wallet that
 * signed is the wallet the record is about to name as owner. Signing the prepared message
 * without broadcasting it proves nothing here, because the transaction has to have landed; and
 * presenting somebody else's signature fails on the message, whose `user` is their wallet and
 * not the ticket's.
 */
export async function deployTxSignedBy(
  signature: string,
  expect: { message: string; wallet: string }
): Promise<{ ok: true } | { reason: string; transient?: boolean }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(signature)) return { reason: "that is not a transaction signature" };
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(expect.wallet);
  } catch {
    return { reason: "the ticket names no readable wallet" };
  }

  const rpc = rpcFor();
  // The browser confirms before it calls `confirm`, but "confirmed" is a cluster-wide claim and
  // this node may be a slot or two behind it, so a miss is retried briefly before it is a no.
  let landed: VersionedTransactionResponse | null = null;
  for (let attempt = 0; attempt < 6 && !landed; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1_500));
    landed = await rpc
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
  }
  // Transient: "this node has not seen it" is not "it is not there", and the caller must keep its
  // ticket so a confirm that arrives ahead of the RPC can be retried.
  if (!landed) return { reason: `no transaction ${signature} on ${CLUSTER}: it did not land`, transient: true };
  if (landed.meta?.err) return { reason: `transaction ${signature} failed on chain` };

  const message = landed.transaction.message;
  if (Buffer.from(message.serialize()).toString("base64") !== expect.message) {
    return { reason: "that transaction is not the one this ticket prepared" };
  }
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
  if (!signers.some((k) => k.equals(wallet))) {
    return { reason: `${expect.wallet} did not sign that transaction` };
  }
  return { ok: true };
}
