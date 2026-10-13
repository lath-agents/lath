/**
 * The Tempo side of the console: which agents may pay for inference over MPP, out of whose money,
 * and through which channel.
 *
 * **The operator's treasury account signs the vouchers.** An agent on the `tempo` rail pays
 * OpenRouter's MPP gateway per call through a TIP-1034 channel, and the treasury is the payer. A
 * Tempo wallet per agent, funded from the treasury, would cost gas on every funding transfer and
 * strand whatever the agent did not spend; the user needs nothing on Tempo either way, so there is
 * no such wallet.
 *
 * `tempoAccountFor` stays for older records whose `payer` is such a per-agent wallet: it re-derives
 * the address they name, and `drainPlan` is the rule for sending what one still holds back to the
 * treasury. Nothing spends from it.
 *
 * **One account, many channels.** A channel open and close are management credentials POSTed to
 * the gateway, which submits the transaction as fee payer, so no treasury nonce moves and nothing
 * on chain needs serialising. `withTreasury` is ordering: one open or close at a time keeps the
 * open-channel count and the ledger consistent with what the gateway has actually done. Vouchers
 * are not in it. The map and the ledger are per process, so a second console process on the same
 * treasury is **refused** rather than tolerated: the treasury lock below is a file beside the
 * ledger naming the pid that holds it, and a restart settles every channel the ledger still names
 * before it opens a new one.
 *
 * **The only billed rail.** There is no operator OpenRouter key paying the provider: nothing in the
 * console or the runtime reads `OPENROUTER_API_KEY`. What a session that cannot reach this rail
 * gets is the scripted transport, which writes the same chain and pays nobody. The user's side is
 * separate: escrow, a capped `Allowance` and a `charge` per Action are what bound what a session
 * may spend, and the operator moves USDC from the vault to this treasury by hand.
 *
 * Environment (server-side, documented in `runner.ts`'s block): `LATH_TEMPO_TREASURY` is the
 * operator account that pays — file or literal, never printed — and an empty value means no
 * session can be billed at all, whatever a template or an offer says. That rule is what makes the
 * `--e2e` pin in `scripts/dev-devnet.sh` and `playwright.config.ts` a guarantee rather than a
 * default: a suite cannot spend mainnet money through a record it seeded.
 */ import * as fs from "fs";
import * as os from "os";
import { Keypair } from "@solana/web3.js";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { LOG_RANGE_REFUSED, logSearchRanges, sha256, utf8 } from "@lath/sdk";
import {
  MppChargeTransport,
  MppOpenRouterTransport,
  MppRpcSession,
  type ChatRequest,
  type ChatResult,
  type ChatStreamOptions,
  type ChatTransport,
  type DecideRequest,
  type DecideResult,
  type MppChannelRecovery,
} from "@lath/runtime";
import { TRACE_DIR, type DeployedAgent } from "./runner";
import { readJsonOr, syncDirSync, writeFlushedSync } from "./json-store";
import * as path from "path";

/** Tempo mainnet, as `eth_chainId` at `TEMPO_RPC_URL` answers it (`0x1079`). */
export const TEMPO_CHAIN_ID = 4217;
export const TEMPO_RPC_URL = "https://rpc.tempo.xyz";
/** USDC.e on Tempo: the `currency` of the gateway's `intent="session"` challenge. */
export const TEMPO_USDC_E = "0x20c000000000000000000000b9537d11c60e8b50" as const;
/** The TIP-1034 escrow precompile the gateway's session challenge names (`escrowContract`). */
export const TEMPO_ESCROW = "0x4d50500000000000000000000000000000000000" as const;
/** OpenRouter's MPP gateway; no key, the channel is the credential. */
export const TEMPO_GATEWAY_URL = "https://openrouter.mpp.tempo.xyz/v1/chat/completions";
/** USDC.e has six decimals, the same base unit as the Solana vault's micro-USDC. */
export const TEMPO_DECIMALS = 6;

/**
 * The derivation domain, a frozen input: it derives the treasury's private key, so changing its
 * spelling would derive a different account and strand the USDC.e the funded one holds.
 */
export const TEMPO_KEY_DOMAIN = "lattice-tempo:v1:";
/** The order of secp256k1; a derived scalar must be in `(0, n)` to be a private key. */
export const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

/**
 * What a template, an offer or an `agents.json` row may *say* about the rail. `"vault"` is
 * readable and not writable on a new record (`templates/validate.ts`): there is no such billed rail,
 * an explicit `"vault"` hashes as absent, and a record carrying one runs
 * on `tempo` like everything else.
 */
export type Rail = "vault" | "tempo";

/**
 * What a session actually gets, which is a different question from what its record says. There is
 * one billed rail and one fallback: `tempo` pays OpenRouter's MPP gateway from the treasury, and
 * `scripted` answers from a fixed script, writes the same chain and pays nobody.
 */
export type RailOutcome = "tempo" | "scripted";

function scalar(bytes: Uint8Array): bigint {
  let n = BigInt(0);
  for (const b of bytes) n = (n << BigInt(8)) | BigInt(b);
  return n;
}

/**
 * `k = sha256(utf8("lattice-tempo:v1:") ‖ secret ‖ u8(i))` for the smallest `i ≥ 0` with
 * `0 < k < n`. The counter is there so the function is total; with a real curve order it is
 * reached with probability about 2^-128, so `order` is a parameter only so the loop can be
 * tested at all (`tests/tempo-key.ts` passes one below the first digest).
 */
export function tempoPrivateKeyFor(
  secret: Uint8Array,
  order: bigint = SECP256K1_N
): { key: Uint8Array; index: number } {
  if (secret.length !== 32) throw new Error(`tempoPrivateKeyFor: a 32-byte secret, got ${secret.length}`);
  const domain = utf8(TEMPO_KEY_DOMAIN);
  for (let i = 0; i < 256; i++) {
    const key = sha256(domain, secret, Uint8Array.of(i));
    const k = scalar(key);
    if (k > BigInt(0) && k < order) return { key, index: i };
  }
  // Unreachable with a real order; stated rather than looped forever.
  throw new Error("tempoPrivateKeyFor: no scalar below the curve order in 256 tries");
}

export interface TempoAccount {
  /** The viem account the transport signs vouchers with. */
  account: PrivateKeyAccount;
  /** The address a record commits as `payer`. */
  address: `0x${string}`;
  /** Which counter value produced the key; 0 in practice. */
  index: number;
}

/**
 * The Tempo account of an agent whose Solana `Keypair` the server holds. `secretKey[0..32]` is
 * the Ed25519 seed, the same bytes `derived()` in `runner.ts` folds into child keys, so a sealed
 * agent secret keeps this address.
 */
export function tempoAccountFor(agentKey: Keypair): TempoAccount {
  const { key, index } = tempoPrivateKeyFor(agentKey.secretKey.slice(0, 32));
  const account = privateKeyToAccount(`0x${Buffer.from(key).toString("hex")}`);
  return { account, address: account.address, index };
}

// ─── The treasury, and the pin ──────────────────────────────────────────────

/**
 * `LATH_TEMPO_TREASURY` the way `LATH_RUNTIME_KEYPAIR` is read: a path to a file holding
 * the 0x-prefixed private key, or the key itself. Empty or unset is "the rail is off". The key
 * is never logged; `tempoTreasuryAddress()` is what a screen may show.
 */
export function tempoTreasurySpec(): string {
  return process.env.LATH_TEMPO_TREASURY?.trim() ?? "";
}

let treasury: PrivateKeyAccount | null | undefined;
let loggedOff = false;

/** The operator's Tempo account, or `null` when the rail is off. Logged once per process either way. */
export function tempoTreasury(): PrivateKeyAccount | null {
  if (treasury !== undefined) return treasury;
  const spec = tempoTreasurySpec();
  if (!spec) {
    if (!loggedOff) {
      loggedOff = true;
      console.log("tempo: off (LATH_TEMPO_TREASURY empty); every session runs scripted and unbilled");
    }
    return (treasury = null);
  }
  const raw = spec.startsWith("0x") ? spec : fs.readFileSync(spec.replace(/^~/, os.homedir()), "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw))
    throw new Error("LATH_TEMPO_TREASURY is not a 32-byte 0x-prefixed key or a file holding one");
  treasury = privateKeyToAccount(raw as `0x${string}`);
  console.log(`tempo: on, treasury ${treasury.address} (chain ${TEMPO_CHAIN_ID})`);
  return treasury;
}

export function tempoTreasuryAddress(): `0x${string}` | null {
  return tempoTreasury()?.address ?? null;
}

/** Whether any session may be billed in this process. */
export function tempoEnabled(): boolean {
  return tempoTreasury() !== null;
}

/**
 * What an agent's inference is paid with, computed per agent and the one decision point
 * for it. `serverHeld` is whether this server holds the agent's signing key.
 *
 * Two conditions, both about whether a voucher can be signed at all: a treasury in this process
 * (the `--e2e` pin), and a key this server holds — a wallet-authority agent has none here, so no
 * voucher can be signed for it. When either fails the answer is `scripted`, never a keyed call:
 * there is no provider key to fall back to.
 *
 * `recorded` — what the template, offer or row says — decides nothing, because there is no second
 * billed rail for it to choose. It stays in the signature because the log line and
 * the notes beside a degraded session name what the record asked for, and because a reader of
 * either wants to see that an old `"vault"` row was not honoured.
 */
export function railFor(recorded: Rail | undefined, serverHeld: boolean): RailOutcome {
  void recorded;
  if (!tempoEnabled()) return "scripted";
  if (!serverHeld) return "scripted";
  return "tempo";
}

/**
 * The account every `tempo`-rail session signs its vouchers with. Throws when the rail is off,
 * because a caller only reaches it after `railFor` has answered `tempo`, and a missing treasury
 * there is a bug in this module rather than a state a session should degrade from.
 */
export function treasuryAccount(): PrivateKeyAccount {
  const account = tempoTreasury();
  if (!account) throw new Error("the tempo rail is off: LATH_TEMPO_TREASURY is empty");
  return account;
}

// ─── Reading Tempo, and moving USDC.e on it ─────────────────────────────────

/**
 * Why the raw JSON-RPC below rather than viem's wallet actions: this tree compiles with
 * `strict: false`, under which viem's action parameter types collapse and every optional field
 * reads as required. The shape is `encodeFunctionData` plus a `request`-style call, with the
 * transport reduced to one function so a test can hand it a fake instead of a network.
 */
const ERC20: Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

/** One JSON-RPC call. The seam a test replaces; `httpRpc` is the only implementation that ships. */
export type JsonRpc = (method: string, params: unknown[]) => Promise<any>;

/**
 * How long one JSON-RPC call may take before it is abandoned. A bare `fetch` has no deadline of its
 * own, and every money decision here reads through this function — `tempoCanCover` before a
 * session, `escrowState` and `recoveryFromChain` before a close, the loop keys' reads — so an
 * upstream that accepts the connection and then stalls would hold a request, a channel open or a
 * close for as long as it liked. A log scan is the one call that can honestly take longer: it
 * walks a range of blocks, and `recoveryFromChain` searches back as far as `OPEN_SEARCH_HORIZON`.
 */
export const TEMPO_RPC_TIMEOUT_MS = 10_000;
export const TEMPO_RPC_LOGS_TIMEOUT_MS = 30_000;

export function httpRpc(
  url: string = TEMPO_RPC_URL,
  opts: { timeoutMs?: number; logsTimeoutMs?: number } = {}
): JsonRpc {
  let id = 0;
  const timeoutMs = opts.timeoutMs ?? TEMPO_RPC_TIMEOUT_MS;
  const logsTimeoutMs = opts.logsTimeoutMs ?? TEMPO_RPC_LOGS_TIMEOUT_MS;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      // Covers the body too: a server that trickles bytes is cut off at the same deadline.
      signal: AbortSignal.timeout(method === "eth_getLogs" ? logsTimeoutMs : timeoutMs),
    });
    // `any`, because the two compilers this file is read by type `Response.json()` differently
    // (the DOM's `any` against Node's `unknown`) and a JSON-RPC envelope is untyped either way.
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(`${method} failed (${res.status})`);
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  };
}

/** USDC.e held by an address, base units. */
export async function usdcBalance(rpc: JsonRpc, address: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [address] });
  const raw = (await rpc("eth_call", [{ to: TEMPO_USDC_E, data }, "latest"])) as Hex;
  return decodeFunctionResult({ abi: ERC20, functionName: "balanceOf", data: raw }) as bigint;
}

/** Base units as a human USDC.e figure, for a sentence a person reads. */
export function base6(v: bigint): string {
  const unit = BigInt(1_000_000);
  return `${v / unit}.${(v % unit).toString().padStart(6, "0")}`;
}

/** Just enough of a viem account for a transfer: an address, and something that signs. */
export interface Signer {
  address: string;
  signTransaction(tx: any): Promise<Hex>;
}

/** The least gas a TIP-20 transfer is sent with; above the 271 584 the chain asks for a first-time recipient. */
export const TRANSFER_GAS_FLOOR = BigInt(600_000);

/**
 * What a transfer's gas costs in USDC.e base units. The fee is paid in the token itself, which
 * has six decimals where the gas price has eighteen, so the wei product is scaled down by the
 * twelve between them — rounded up, because a fee one unit short is a transfer that does not
 * mine. Pinned against a measurement: 530 430 gas at 0.6 gwei cost 319 base units.
 */
export function gasFeeBase(gasLimit: bigint, gasPriceWei: bigint): bigint {
  const scale = BigInt(10) ** BigInt(12);
  const wei = gasLimit * gasPriceWei;
  return (wei + scale - BigInt(1)) / scale;
}

/**
 * The gas limit a TIP-20 transfer is sent with: what the node estimates, half again on top,
 * floored above the cost a first-time recipient asks for. Estimated rather than fixed because a
 * transfer sent with a 120 000 limit is refused with "call gas cost (271584) exceeds the gas limit
 * (120000)" — a transfer into an address that has never held the token costs far more on Tempo
 * than an ERC-20 transfer does elsewhere, and the node estimates 540k for the same call. Unused
 * gas is not charged, so the margin costs nothing.
 */
export async function estimateTransferGas(rpc: JsonRpc, from: string, to: string, amount: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] });
  const estimateHex = await rpc("eth_estimateGas", [{ from, to: TEMPO_USDC_E, data }]).catch(() => null);
  const estimated = estimateHex ? (BigInt(estimateHex as string) * BigInt(3)) / BigInt(2) : BigInt(0);
  return estimated > TRANSFER_GAS_FLOOR ? estimated : TRANSFER_GAS_FLOOR;
}

/**
 * One TIP-20 `transfer(to, amount)`, signed locally, sent raw, and waited for. The sender pays the
 * gas, in USDC.e, out of the same balance it is sending from — which is why a drain subtracts the
 * fee before it sends (`drainPlan`) and passes the same `gas` and `gasPrice` it subtracted for.
 *
 * A receipt whose `status` is not `0x1` is an error: a transfer that reverted moved nothing, and
 * recording it as if it had would leave a row saying money is somewhere it is not.
 */
export async function transferUsdc(
  rpc: JsonRpc,
  from: Signer,
  to: string,
  amount: bigint,
  opts: {
    chainId?: number;
    waitMs?: number;
    gas?: bigint;
    gasPrice?: bigint;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<string> {
  const chainId = opts.chainId ?? TEMPO_CHAIN_ID;
  const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] });
  const nonceHex = await rpc("eth_getTransactionCount", [from.address, "pending"]);
  const gasPrice = opts.gasPrice ?? BigInt((await rpc("eth_gasPrice", [])) as string);
  const gas = opts.gas ?? (await estimateTransferGas(rpc, from.address, to, amount));
  const signed = await from.signTransaction({
    type: "legacy",
    chainId,
    to: TEMPO_USDC_E,
    data,
    value: BigInt(0),
    nonce: Number(BigInt(nonceHex)),
    gas,
    gasPrice,
  });
  const txHash = (await rpc("eth_sendRawTransaction", [signed])) as string;

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  for (;;) {
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`the transfer ${txHash} reverted`);
      return txHash;
    }
    if (Date.now() >= deadline) throw new Error(`the transfer ${txHash} was not mined in time`);
    await sleep(1500);
  }
}

// ─── The pool: one treasury, serialised opens and closes ────────────────────

/**
 * The in-process ordering of opens and closes: no nonce is at stake, the count and the ledger are.
 * One chain of promises, never reset: a rejected body still lets the next caller through, and
 * `fn`'s own error stays the caller's.
 *
 * On `globalThis`, with the open-channel count, for the reason `_lib/anchor.ts` gives: Next
 * compiles each route into its own module graph, so a module-level `let` here is one lock per route
 * and one counter per route — the treasury route would count the loops scheduler's channels as
 * zero, and two routes could race each other. Per process by intent; two console processes on one
 * treasury remain unsupported.
 */
interface TempoPoolState {
  lock: Promise<unknown>;
  channelsOpen: number;
  /** The heartbeat that keeps this process's claim on the treasury lock fresh, once claimed. */
  heartbeat?: ReturnType<typeof setInterval>;
  /** The one recovery pass of the ledger this process makes; every open waits for it. */
  recovery?: Promise<RecoveryReport>;
  /** How a ledger row with a `signer` gets its key's account (`setKeyAccountFor`). */
  keyAccountFor?: KeyAccountFor;
  /** Who is told when `closeChannelById` settles a loop key's channel (`setKeyedCloseListener`). */
  keyedClosed?: KeyedCloseListener;
  /**
   * Channels whose `tempo-key-missing` line this process has printed. Once per channel per process,
   * because a kept row is retried by every settle and every recovery pass, and the procedure the line
   * names does not change between them.
   */
  keyMissingLogged?: Set<string>;
}
const g = globalThis as typeof globalThis & { __lathTempoPool?: TempoPoolState };
const pool: TempoPoolState = (g.__lathTempoPool ??= { lock: Promise.resolve(), channelsOpen: 0 });

export function withTreasury<T>(fn: () => Promise<T>): Promise<T> {
  const next = pool.lock.then(fn, fn);
  // The chain itself must swallow the outcome, or one failed open would fail every later one.
  pool.lock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * An account that signs Tempo payments from the treasury: the treasury's own key, or a loop's
 * access key rooted on it (`_lib/tempo-keys.ts`). An access-key account's `address` is the root's —
 * the treasury — so every `payer` a record names stays the treasury; `accessKeyAddress` is the key,
 * which a channel opened through it names as `authorizedSigner`. Structural, so this module carries
 * no `viem/tempo` type (it is loaded through `import()`, `_lib/tempo-keys.ts`).
 */
export type TempoSigningAccount =
  | PrivateKeyAccount
  | { readonly address: `0x${string}`; readonly accessKeyAddress: `0x${string}`; readonly [k: string]: unknown };

/**
 * The account a ledger row's close must be signed with when the row names a `signer` (a loop key),
 * or `null` when that key is unavailable — its file gone, expired or revoked. Injected by the loop
 * wiring (`setKeyAccountFor`) so this module does not import `_lib/tempo-keys.ts`.
 */
export type KeyAccountFor = (row: OpenChannelRow) => Promise<TempoSigningAccount | null>;

/**
 * The access key an account signs with, or `undefined` for the treasury's own key. Read
 * structurally, since a `PrivateKeyAccount` has no such field and an access-key account is a
 * `viem/tempo` type this module does not name.
 */
export function accessKeyOf(account: TempoSigningAccount): string | undefined {
  const k = (account as { accessKeyAddress?: unknown }).accessKeyAddress;
  return typeof k === "string" && k ? k : undefined;
}

/**
 * Refuses an account that is not the treasury or a key rooted on it. Every row and record names the
 * account's `address` as `payer`, and the audit allows one payer per chain, so an account rooted
 * anywhere else would write a payer no audit accepts — and the deposit would be drawn from a wallet
 * this console does not settle. A wiring bug, so a throw rather than a degrade: a degrade would run
 * a keyed loop scripted, and the Genesis would commit a key its payments never used.
 */
function assertRootedOnTreasury(account: TempoSigningAccount, treasury: PrivateKeyAccount, what: string): void {
  if (account.address.toLowerCase() !== treasury.address.toLowerCase()) {
    throw new Error(
      `tempo: ${what} was handed an account rooted on ${account.address}, not on the treasury ${treasury.address}; ` +
        `refused, because every payer this console records is the treasury`
    );
  }
}

/** Installs (or, with `undefined`, removes) the hook `closeChannelById` and recovery use for keyed rows. */
export function setKeyAccountFor(fn: KeyAccountFor | undefined): void {
  pool.keyAccountFor = fn;
}

/** The installed hook, if any. */
export function keyAccountForHook(): KeyAccountFor | undefined {
  return pool.keyAccountFor;
}

/**
 * A loop key's channel that `closeChannelById` settled: the loop, the deposit the escrow held under
 * it and what the close paid. The loop's reconcile hands a channel's refund back to its key only
 * for a settle it can show, and a close by id — the restart's recovery pass closing a row its loop
 * could not settle, or any other caller — happens outside the loop's own settle, so it is told
 * here.
 */
export interface KeyedChannelClosed {
  loopId: string;
  channelId: string;
  /** Base units, decimal: what the escrow held deposited under the channel before the close. */
  deposit: string;
  /** Base units, decimal, when the close's receipt said; absent, the loop counts the whole deposit. */
  spent?: string;
  /**
   * Base units, decimal: the larger of the cumulative the close was signed at and what the escrow had
   * already settled. What the payee can redeem whatever the receipt says, so the loop never records a
   * settle below it.
   */
  signed?: string;
}
export type KeyedCloseListener = (closed: KeyedChannelClosed) => void;

/**
 * Installs (or, with `undefined`, removes) the listener told of every keyed close by id. Injected by
 * the loop wiring for the reason `setKeyAccountFor` is, so this module does not import the loops.
 */
export function setKeyedCloseListener(fn: KeyedCloseListener | undefined): void {
  pool.keyedClosed = fn;
}

/** Channels this process holds open on the treasury. What `GET /api/tempo/treasury` reports. */
export function openChannelCount(): number {
  return pool.channelsOpen;
}

/**
 * The ledger of channels opened and not yet closed, on disk beside `agents.json`
 * (`tempo-channels.json`), so a channel outlives the process that opened it in a form the next
 * process can close. The chain cannot be that form: a step killed mid-flight has its Action
 * journaled or batched and not yet landed, so a close that read the chain would answer "nothing to
 * settle" for a channel that is open with the treasury's deposit in it. Written when a channel
 * opens, removed when it closes; a row still here after a restart is exactly what
 * `recoverOpenChannels` settles first. There is no manual close route: the restart is the recovery
 * path.
 */
export interface OpenChannelRow {
  agentId: string;
  channelId: string;
  payer: string;
  openedAt: number;
  /**
   * The loop this channel belongs to, when a loop opened it. A loop holds one channel for its whole
   * run, so the row a recovery reads is as likely to be a loop's as a chat session's — and a loop's
   * is also on its own registry row, which is what the close route consults first for one
   * (`openLoopChannels` in `_lib/loop-channel-state.ts`).
   */
  loopId?: string;
  /**
   * The access key that signed the channel (its `authorizedSigner`), when a loop key did; absent
   * for a treasury-signed channel, which the treasury closes with its own key. A row with a
   * `signer` is closed with that key's account (`KeyAccountFor`), and kept with a
   * `tempo-key-missing` line when it has none.
   */
  signer?: string;
  /** The Tempo block the channel opened in, decimal: where a `ChannelOpened` read starts. */
  openBlock?: string;
  /**
   * What a close of this channel needs when this process is gone: the descriptor, the last
   * signed cumulative, the endpoint and the gateway's last challenge. Written by the transport's
   * `onChannel` at open and refreshed on every voucher, so the row is never behind the gateway.
   * **An older row may have none.** Such a row is not dropped and not guessed at:
   * `closeChannelById` reads the channel's `ChannelOpened` log off the escrow for the descriptor
   * and closes at what the escrow says is settled; a row whose log cannot be found is reported as
   * failed and stays, because a row that cannot be closed must say so rather than disappear — a
   * row pruned as though settled strands its deposit in escrow with nothing left naming it.
   */
  recovery?: MppChannelRecovery;
}
const LEDGER = () => path.join(TRACE_DIR, "tempo-channels.json");

/**
 * The ledger's rows, read strictly: only a missing file is an empty ledger, and any other read
 * error — `EMFILE`, `EIO`, a file a kill or `ENOSPC` left half-written — throws (the rule
 * `_lib/json-store.ts` states for `agents.json`). This file is the only record of a chat session's
 * or a paid-RPC session's channel, and the one `recoverOpenChannels` settles from. A read that
 * answered `[]` to any failure would let the very next voucher's `rememberOpenChannel` write its
 * own row over the file: one failed read would erase the row of every other open channel, and
 * their deposits would stay in escrow with nothing left naming them. What changes the ledger reads
 * through this; only what merely shows it may use the forgiving `openChannelLedger`.
 */
export function readChannelLedger(): OpenChannelRow[] {
  const parsed = readJsonOr<unknown>(LEDGER(), () => []);
  // Not a list is a file somebody has to look at, not one to overwrite, for the reason a parse
  // error is.
  if (!Array.isArray(parsed)) throw new Error(`${LEDGER()} is not a list of channel rows`);
  return parsed.filter((r) => r && typeof r.channelId === "string");
}
/**
 * The ledger's rows, or `[]` when it cannot be read. Only for a caller that only shows the rows
 * or sizes something by them; never as the base of a write, which is `readChannelLedger`'s job.
 */
export function openChannelLedger(): OpenChannelRow[] {
  try {
    return readChannelLedger();
  } catch {
    return [];
  }
}
/**
 * JSON beside `file` and a rename over it, mode 0600: a crash or `ENOSPC` mid-write leaves the
 * old file whole, never a truncated one that the next read would refuse forever. A plain
 * `writeFileSync` truncates the target first. Kept here rather than in `json-store.ts`, whose
 * writer is for files anyone on the box may read: a ledger row carries the channel's descriptor
 * and last signed cumulative. The temp name carries the pid for that module's reason.
 */
function writePrivateJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // Flushed before the rename and the directory after it, as `writeJsonAtomic` does and for its reason.
  writeFlushedSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // `mode` applies only when the file is created; a temp file a crash left behind keeps its own.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  syncDirSync(path.dirname(file));
}
function writeLedger(rows: OpenChannelRow[]): void {
  try {
    writePrivateJsonAtomic(LEDGER(), rows);
  } catch (e) {
    // The ledger is a convenience for recovery, never a condition of the step.
    console.warn(`tempo: the open-channel ledger was not written: ${(e as any)?.message ?? e}`);
  }
}
/** The ledger to change, or `undefined` (said out loud) when it cannot be read, so the change is skipped. */
function ledgerToChange(change: string): OpenChannelRow[] | undefined {
  try {
    return readChannelLedger();
  } catch (e) {
    console.warn(
      `tempo: the open-channel ledger could not be read, so ${change} was skipped rather than written over every ` +
        `other row: ${(e as any)?.message ?? e}`
    );
    return undefined;
  }
}
/**
 * Writes a channel's row, merging over the row it already has: the transport reports the
 * channel several times as it learns more (open, then each voucher, then the challenge), and a
 * later write that knows less — the pooled transport's own, which has no `recovery` of its own to
 * add — must not erase what an earlier one wrote. The first write's `openedAt` is kept.
 *
 * A ledger that cannot be read is left as it is. This row is missed until the next voucher writes
 * it again, which costs less than erasing every other channel's row.
 */
export function rememberOpenChannel(row: OpenChannelRow): void {
  const rows = ledgerToChange(`channel ${row.channelId}'s row`);
  if (!rows) return;
  const prior = rows.find((r) => r.channelId === row.channelId);
  const merged: OpenChannelRow = { ...prior, ...row, openedAt: prior?.openedAt ?? row.openedAt };
  if (!row.recovery && prior?.recovery) merged.recovery = prior.recovery;
  writeLedger([...rows.filter((r) => r.channelId !== row.channelId), merged]);
}
/**
 * Takes a closed channel's row off. On a ledger that cannot be read the row stays, and that
 * costs nothing: `closeChannelById` reads the escrow before it closes, and drops a row whose
 * channel holds no deposit without posting anything.
 */
export function forgetOpenChannel(channelId: string): void {
  const rows = ledgerToChange(`the removal of channel ${channelId}'s row`);
  if (rows?.some((r) => r.channelId === channelId)) writeLedger(rows.filter((r) => r.channelId !== channelId));
}

// ─── The treasury lock, and what a restart settles first ─────────────────────
//
// Two console processes on one treasury would each hold channels the other cannot see or close and
// each run a recovery from a ledger missing the other's rows. Nothing on chain stops it — opens and
// closes are management credentials the gateway submits, so there is no nonce to collide on — which
// is why the refusal has to be here, on the ledger's own directory: a lock file beside
// `tempo-channels.json` naming the pid that holds it, refreshed on a heartbeat, claimed at server
// start (`frontend/src/instrumentation.ts`) and again, idempotently, by the first channel this
// process opens, so a process that skipped the hook cannot open one.
//
// A lock is stale — and taken over — when its pid is gone or its heartbeat is older than
// `LOCK_STALE_MS`, which is what a crashed console leaves behind. It is not released on exit on
// purpose: a process that dies without settling its channels leaves both the lock and the ledger
// rows, and the next one takes the lock, reads the rows and settles them before it opens a channel
// of its own. `process.kill(pid, 0)` is the liveness check on the machines this runs on; a lock
// written by another machine on a shared directory is not a case this supports.

/** The lock, beside the ledger. Read by `claimTreasury`; a person reads it to see who holds it. */
export interface TreasuryLock {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}
const LOCK = () => path.join(TRACE_DIR, "tempo-channels.lock");
export const LOCK_HEARTBEAT_MS = 10_000;
export const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS;

export function readTreasuryLock(): TreasuryLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK(), "utf8"));
    return parsed && typeof parsed.pid === "number" && typeof parsed.heartbeatAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}
function writeTreasuryLock(lock: TreasuryLock): void {
  // Atomic for the ledger's reason. `readTreasuryLock` takes a torn file for no lock at all, so a
  // heartbeat cut off mid-write would let a second console claim a treasury that the first still
  // held.
  writePrivateJsonAtomic(LOCK(), lock);
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM is a live process this user may not signal; anything else is no such process.
    return e?.code === "EPERM";
  }
}

/** Thrown by `claimTreasury` when another live process holds the ledger. The message is the reason. */
export class TreasuryHeldError extends Error {
  constructor(readonly holder: TreasuryLock) {
    super(
      `another console process (pid ${holder.pid}, heartbeat ${Math.round(
        (Date.now() - holder.heartbeatAt) / 1000
      )} s ago) ` +
        `holds the Tempo treasury's channel ledger at ${LOCK()}; two processes on one treasury are refused. ` +
        `Stop that process, or point this one at another LATH_TRACE_DIR and treasury.`
    );
    this.name = "TreasuryHeldError";
  }
}

/**
 * Claims the treasury for this process, or throws `TreasuryHeldError` naming the process that
 * has it. Idempotent: a second call in the same process only refreshes the heartbeat. `opts`
 * exist for the test suite, which cannot fork a second console; the app passes none.
 */
export function claimTreasury(
  opts: { pid?: number; now?: number; alive?: (pid: number) => boolean } = {}
): TreasuryLock {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? pidAlive;
  const held = readTreasuryLock();
  if (held && held.pid !== pid && alive(held.pid) && now - held.heartbeatAt < LOCK_STALE_MS) {
    throw new TreasuryHeldError(held);
  }
  const lock: TreasuryLock = { pid, startedAt: held?.pid === pid ? held.startedAt : now, heartbeatAt: now };
  writeTreasuryLock(lock);
  if (!pool.heartbeat && opts.pid === undefined) {
    pool.heartbeat = setInterval(() => {
      const current = readTreasuryLock();
      // Only the holder refreshes; a lock another process took over (this one was judged dead,
      // which a stopped debugger can cause) is left to its new holder rather than fought over.
      // A refresh that fails (`ENOSPC`) is said and tried again next beat. Thrown from a timer, it
      // would be an uncaught exception in the console process.
      try {
        if (!current || current.pid === pid) writeTreasuryLock({ ...lock, heartbeatAt: Date.now() });
      } catch (e) {
        console.warn(`tempo: the treasury lock's heartbeat was not written: ${(e as any)?.message ?? e}`);
      }
    }, LOCK_HEARTBEAT_MS);
    // A heartbeat must not hold the process open on its own.
    pool.heartbeat.unref?.();
  }
  return lock;
}

/** Test seam: forgets this process's claim, so a suite can play the second process. */
export function releaseTreasuryForTests(): void {
  if (pool.heartbeat) clearInterval(pool.heartbeat);
  pool.heartbeat = undefined;
  pool.recovery = undefined;
  try {
    fs.rmSync(LOCK(), { force: true });
  } catch {
    // Nothing to release.
  }
}

/** What one recovery pass did with the ledger, for the log and the suite. */
export interface RecoveryReport {
  settled: string[];
  /** Rows a loop owns, handed to `settleLoop`; the loop's own machinery writes their record. */
  loops: string[];
  /** Rows whose close threw; they stay in the ledger for the next pass or the close route. */
  failed: { channelId: string; error: string }[];
}

export interface RecoveryHooks {
  /** Settles a chat session's row. Default `closeChannelById`. */
  closeById?: (channelId: string, payer: string) => Promise<unknown>;
  /**
   * Settles a loop's row. The loop scheduler passes `settleLoopChannel(loopId, "restart")`,
   * which writes the `loop.settlement` record through the loop's own runner; with no settler a
   * loop's row is left for its scheduler, which settles it before that loop's next step.
   */
  settleLoop?: (loopId: string, row: OpenChannelRow) => Promise<unknown>;
}

/**
 * Settles every channel the ledger names, once per process, before this process opens one of its
 * own. A row is a channel some process opened and never closed — a crash, a kill mid-loop, a
 * restart — and its deposit is the treasury's until the treasury's key closes it. The first caller
 * runs the pass and every later caller awaits the same promise, so an open that arrives during
 * recovery waits for it rather than racing it.
 *
 * Never throws: a close that fails leaves its row for the next restart, and is reported rather
 * than blocking every session behind it.
 *
 * A row a loop key signed (`signer`) is closed with that key: `closeChannelById` asks the
 * `keyAccountFor` hook for it. When the key is gone the close throws, so the row lands in `failed`
 * and stays — never in `settled`, because nothing settled — and a `tempo-key-missing` line names
 * the treasury's force-close, once per channel however many passes see the row.
 */
export function recoverOpenChannels(hooks: RecoveryHooks = {}): Promise<RecoveryReport> {
  if (pool.recovery) return pool.recovery;
  // A ledger that could not be read settles nothing. That pass is not kept as this process's
  // recovery, so the next open reads the ledger again: one `EMFILE` at start must not mean that the
  // rows a crash left are never settled while this process lives.
  let unread = false;
  const pass = (async () => {
    const report: RecoveryReport = { settled: [], loops: [], failed: [] };
    let rows: OpenChannelRow[];
    try {
      rows = readChannelLedger();
    } catch (e: any) {
      unread = true;
      console.warn(
        `tempo: recovery could not read the open-channel ledger, so it settled nothing and will read it again: ` +
          `${e?.message ?? String(e)}`
      );
      return report;
    }
    for (const row of rows) {
      try {
        if (row.loopId) {
          if (!hooks.settleLoop) continue;
          // Whether the loop settled it is read off the ledger, not off the return value: a settle
          // that closes the channel prunes the row, and one that finds nothing to settle leaves it.
          // Counting the row that was left as handled would let the loop's next step open a second
          // channel on top of one still holding a deposit. An unsettled row is closed here instead,
          // the way a chat session's is. Read strictly: a ledger that cannot be read here is
          // neither "settled" nor "still open". The throw reports the row as failed and leaves it,
          // rather than counting it handled.
          await hooks.settleLoop(row.loopId, row);
          if (readChannelLedger().some((r) => r.channelId === row.channelId)) {
            await (hooks.closeById ?? closeChannelById)(row.channelId, row.payer);
            forgetOpenChannel(row.channelId);
            report.settled.push(row.channelId);
            continue;
          }
          report.loops.push(row.channelId);
          continue;
        }
        await (hooks.closeById ?? closeChannelById)(row.channelId, row.payer);
        forgetOpenChannel(row.channelId);
        report.settled.push(row.channelId);
      } catch (e: any) {
        report.failed.push({ channelId: row.channelId, error: e?.message ?? String(e) });
      }
    }
    if (report.settled.length || report.loops.length || report.failed.length) {
      console.log(
        `tempo: recovery settled ${report.settled.length} channel(s), handed ${report.loops.length} to their loops, ` +
          `${report.failed.length} failed${
            report.failed.length ? `: ${report.failed.map((f) => `${f.channelId} (${f.error})`).join("; ")}` : ""
          }`
      );
    }
    return report;
  })();
  pool.recovery = pass;
  void pass.then(() => {
    // Every caller already holding `pass` still gets its report; only the next one reads again.
    if (unread && pool.recovery === pass) pool.recovery = undefined;
  });
  return pass;
}

/**
 * A `MppOpenRouterTransport` whose two on-chain moments go through `withTreasury`.
 *
 * The transport takes any account; what it cannot know is that the account is shared. Its channel
 * is opened by the first `session.fetch()` inside the first `chat`, and settled by `close()`, and
 * those are the only two calls that spend a nonce — so the first `chat` and `close` are serialised
 * here and every later voucher runs free.
 */
export class PooledTempoTransport implements ChatTransport {
  private counted = false;
  /**
   * `agentId` (hex) names the row the open-channel ledger keeps for this session, and `loopId` the
   * loop that holds it for its whole run — absent for a chat session, which holds one channel per
   * `start()`. `signer` is the loop's access key when one signs the channel, so the row this
   * transport writes names it as `openTempoChannel`'s does; absent for the treasury.
   */
  constructor(
    private readonly inner: MppOpenRouterTransport,
    private readonly agentId?: string,
    private readonly loopId?: string,
    private readonly signer?: string
  ) {}

  /** The address every record of this session names as `payer`: the treasury's. */
  get payer(): string {
    return this.inner.payer;
  }
  get channelId(): string | undefined {
    return this.inner.channelId;
  }
  get opened(): boolean {
    return this.inner.opened;
  }
  /** The channel's cumulative after the last paid call, base units; undefined before the first. */
  get cumulative(): string | undefined {
    return this.inner.cumulative;
  }

  async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult> {
    return this.paid(() => this.inner.chat(req, opts));
  }

  /**
   * A loop's verify call, on the same channel as its chat calls. It can be the request that opens
   * the channel — a step whose model answered from a scripted turn still gets a paid decision — so
   * it takes the same treasury turn and bookkeeping `chat` does.
   */
  async decide(req: DecideRequest, opts?: { signal?: AbortSignal }): Promise<DecideResult> {
    // The runner's deadline has to reach the transport: dropped here, a timed-out decision would
    // stay queued behind whatever held the channel, and still be bought if it freed.
    return this.paid(() => this.inner.decide(req, opts));
  }

  private async paid<T>(call: () => Promise<T>): Promise<T> {
    if (this.inner.opened) return call();
    const res = await withTreasury(call);
    if (this.inner.opened && !this.counted) {
      this.counted = true;
      pool.channelsOpen += 1;
      if (this.inner.channelId) {
        rememberOpenChannel({
          agentId: this.agentId ?? "",
          channelId: this.inner.channelId,
          payer: this.inner.payer,
          openedAt: Date.now(),
          ...(this.loopId ? { loopId: this.loopId } : {}),
          ...(this.signer ? { signer: this.signer } : {}),
          ...(this.inner.recovery?.openBlock ? { openBlock: this.inner.recovery.openBlock } : {}),
          ...(this.inner.recovery ? { recovery: this.inner.recovery } : {}),
        });
      }
    }
    return res;
  }

  async close(): Promise<{ txHash?: string; spent?: string }> {
    let receipt: { txHash?: string; spent?: string };
    try {
      receipt = await withTreasury(() => this.inner.close());
    } finally {
      // Counted down whatever the receipt says: a close that threw has still left this process with
      // nothing to settle, and the next restart's recovery is what re-reads a channel that outlived it.
      if (this.counted) {
        this.counted = false;
        pool.channelsOpen = Math.max(0, pool.channelsOpen - 1);
      }
    }
    // Only after a close that returned. One that threw, a close with no receipt among them, keeps
    // the row for the restart's recovery, which is the only process left that can settle it.
    if (this.inner.channelId) forgetOpenChannel(this.inner.channelId);
    return receipt;
  }
}

/** What one `tempo`-rail session needs the treasury to hold: the channel's whole deposit. */
export function maxDepositBase(maxCostBase: bigint, maxSteps: number): bigint {
  return maxCostBase * BigInt(maxSteps + 1);
}

/**
 * How a channel is sized, in one of two shapes (`mppChannelSizing` in the transport holds the same
 * two): **per call** — `maxCostBase` and `maxSteps`, the deposit `maxDepositBase` above, which is
 * every chat session — or **explicit** — a caller that sized its own deposit and top-up unit, which
 * is a loop (what is left of the owner's budget plus what is left of Lath's Jev budget,
 * `loopChannelSizing` in `_lib/loop-channel-state.ts`). A loop's policy `maxCost` is its whole
 * budget, so the per-call formula would ask the treasury to hold it once per step.
 */
export type ChannelSizing =
  | { maxCostBase: bigint; maxSteps: number; maxDepositBase?: undefined; topUpBase?: undefined }
  | { maxDepositBase: bigint; topUpBase: bigint; maxCostBase?: undefined; maxSteps?: undefined };

/** The deposit a sizing asks the treasury to hold, base units. */
export function channelDepositBase(sizing: ChannelSizing): bigint {
  return sizing.maxDepositBase !== undefined
    ? sizing.maxDepositBase
    : maxDepositBase(sizing.maxCostBase, sizing.maxSteps);
}

/** The sizing as the transport takes it: exactly the keys of the shape the caller chose. */
function transportSizing(sizing: ChannelSizing) {
  return sizing.maxDepositBase !== undefined
    ? { maxDepositBase: sizing.maxDepositBase, topUpBase: sizing.topUpBase }
    : { maxCostBase: sizing.maxCostBase, maxSteps: sizing.maxSteps };
}

/**
 * One call's ceiling, from the ceiling the whole session is metered against.
 *
 * `maxCostBase` is a **per-call** number (`MppOpenRouterOptions`: "the session's per-step
 * ceiling"), and the deposit it sizes is that times `maxSteps + 1`. A caller that hands over the
 * session's whole budget therefore asks the treasury to hold that budget `maxSteps + 1` times:
 * the console's 0.25 USDC session cap over six steps would want 1.75 USDC.e held against calls that
 * cost 1 500 base units each, so every chat session would find the treasury short and run scripted.
 * A loop passes an explicit sizing instead (`ChannelSizing`).
 *
 * Sharing the cap across the turns keeps the deposit at `cap × (n + 1) / n`: still above the
 * session's own cap, which is the bound the escrow charge meters to, plus one call of headroom.
 *
 * Never 0 — a cap smaller than its own step count still buys one call, and a zero deposit is
 * refused by the gateway rather than by this function.
 */
export function perCallCeiling(capBase: bigint, maxSteps: number): bigint {
  const share = capBase / BigInt(Math.max(1, maxSteps));
  return share > 0n ? share : BigInt(1);
}

/**
 * Whether the treasury can cover one session's whole deposit, or why it cannot.
 *
 * Split out of `openTempoChannel` so the console can answer *before* a session whether it will be
 * billed, under the same rule the session itself will apply, so the header and the session cannot
 * disagree about whether it is billed.
 */
export async function tempoCanCover(
  opts: ChannelSizing & {
    rpc?: JsonRpc;
  }
): Promise<{ ok: true } | { degrade: string }> {
  const treasury = treasuryAccount();
  const needed = channelDepositBase(opts);
  let held: bigint;
  try {
    held = await usdcBalance(opts.rpc ?? httpRpc(), treasury.address);
  } catch (e: any) {
    // A balance nobody could read is not a balance: the session is not put on a channel whose
    // deposit may be refused three calls in.
    return { degrade: `the operator's Tempo treasury could not be read: ${e?.message ?? String(e)}` };
  }
  if (held < needed) {
    return {
      degrade:
        `the operator's Tempo treasury holds ${base6(held)} USDC.e and this session needs ${base6(needed)}; ` +
        `it runs scripted and unbilled instead`,
    };
  }
  return { ok: true };
}

/**
 * The channel a session pays through, or why it runs scripted instead.
 *
 * The treasury is read against the session's whole `maxDeposit` before the first call: a channel
 * that cannot cover the session stalls mid-step, and a scripted session that writes its chain and
 * charges nobody is the better failure. A short treasury degrades the session; it never fails a
 * deploy, a launch or a run.
 */
export async function openTempoChannel(
  opts: ChannelSizing & {
    rpc?: JsonRpc;
    /** The agent (hex) whose session this is, for the open-channel ledger. */
    agentId?: string;
    /** The loop that will hold this channel for its whole run; absent for a chat session. */
    loopId?: string;
    /** How the ledger's leftover rows are settled first; the loop scheduler passes its settler. */
    recovery?: RecoveryHooks;
    /** The account the channel is signed with: a loop's access key, or (default) the treasury. */
    account?: TempoSigningAccount;
  }
): Promise<{ channel: PooledTempoTransport } | { degrade: string }> {
  const treasury = treasuryAccount();
  // A loop's access key, rooted on the treasury, or the treasury itself. The key's `address` is the
  // root's, so `payer` below is the treasury either way; what a key adds is `signer`, the address the
  // channel names as `authorizedSigner` and the one a close must be signed by.
  const account: TempoSigningAccount = opts.account ?? treasury;
  assertRootedOnTreasury(account, treasury, "openTempoChannel");
  const signer = accessKeyOf(account);
  // The lock and the recovery before the first deposit: a process that skipped the start hook still
  // refuses a held treasury — as a degrade with the reason, since the process is already up — and
  // never opens on top of rows it has not settled.
  try {
    claimTreasury();
  } catch (e: any) {
    if (e instanceof TreasuryHeldError) return { degrade: e.message };
    throw e;
  }
  await recoverOpenChannels(opts.recovery);
  const covered = await tempoCanCover(opts);
  if ("degrade" in covered) return covered;
  return {
    channel: new PooledTempoTransport(
      new MppOpenRouterTransport({
        account,
        ...transportSizing(opts),
        // Only for pointing a test run at a dead host, to exercise the decision seat's outage path;
        // the default is the gateway's own decisions path.
        ...(process.env.LATH_TEMPO_DECISIONS_URL ? { decisionsUrl: process.env.LATH_TEMPO_DECISIONS_URL } : {}),
        // The row is written the moment mppx has a descriptor — before the first paid request goes
        // out — and rewritten on every voucher, so a kill at any point leaves a row the next
        // process can close. A closed channel is not remembered: `close()` forgets it. One line per
        // paid call, so a call that hangs or fails shows in the console log with how long it took.
        log: (line) => console.log(`${line}${opts.loopId ? ` (${opts.loopId})` : ""}`),
        onChannel: (recovery) => {
          if (!recovery.opened) return;
          // `signer` and `openBlock` are spread in only when there is one, so a treasury row with
          // no open block carries neither key, as older rows do not.
          rememberOpenChannel({
            agentId: opts.agentId ?? "",
            channelId: recovery.channelId,
            payer: account.address,
            openedAt: Date.now(),
            ...(opts.loopId ? { loopId: opts.loopId } : {}),
            ...(signer ? { signer } : {}),
            ...(recovery.openBlock ? { openBlock: recovery.openBlock } : {}),
            recovery,
          });
        },
      }),
      opts.agentId,
      opts.loopId,
      signer
    ),
  };
}

/**
 * The most one storage call may cost, base units: $0.01, fifty times the $0.0002 a 1.5 KB PUT was
 * measured at. The gateway prices by size and states no schedule, so the ceiling is set to let a
 * report of a few hundred KB through and to refuse a re-pricing that would make one step's report
 * cost more than its model calls.
 */
export const STORAGE_CALL_CEILING_BASE = BigInt(10_000);

/**
 * The treasury's charge client: one Tempo transfer per call, priced by the challenge, refused above
 * `maxCostBase` and in anything but USDC.e before a credential is signed. Not serialised through
 * `withTreasury`: a charge signs with an expiring nonce and a challenge-bound memo, so it neither
 * waits on nor collides with a channel open or another charge.
 */
export function treasuryChargeTransport(
  maxCostBase: bigint = STORAGE_CALL_CEILING_BASE,
  /** A loop's access key, when its storage charges are under its cap; default the treasury. */
  account?: TempoSigningAccount,
  /**
   * `clientId`: the loop id, on a keyed loop's charges only.
   * `expectedRecipients`: the storage payee a keyed, scoped loop's key may pay, so a challenge
   * naming anyone else is refused before the key signs a transfer its scopes would not admit.
   */
  opts: { clientId?: string; expectedRecipients?: readonly string[] } = {}
): MppChargeTransport {
  const treasury = treasuryAccount();
  // A key's payment still names the treasury as `payer` (its `address` is the root's); the transfer
  // is signed by the key, so Tempo counts it against the key's limit. Still not under `withTreasury`:
  // the expiring nonce above is the transaction's, whichever key signs it.
  if (account) assertRootedOnTreasury(account, treasury, "treasuryChargeTransport");
  return new MppChargeTransport({
    account: account ?? treasury,
    maxCostBase,
    currency: TEMPO_USDC_E,
    // Spread so a charge without a loop id passes no `clientId`: mppx then writes the anonymous
    // zeros into the memo, and with the switch off every transfer is byte-identical to an unkeyed
    // one.
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
    // Spread for the same reason: only a scoped loop pins, and every other charge is built unpinned.
    ...(opts.expectedRecipients ? { expectedRecipients: opts.expectedRecipients } : {}),
  });
}

/**
 * The paid RPC session's deposit and top-up unit, base units: $0.02 and $0.01. A call is $0.001 and
 * a snapshot three calls, so the deposit carries six steps before its first top-up; the close
 * returns what was not spent.
 */
export const RPC_DEPOSIT_BASE = BigInt(20_000);
export const RPC_TOPUP_BASE = BigInt(10_000);

/**
 * The treasury's session to `rpc.mpp.tempo.xyz`, for one loop's Tempo reads. Paid by Lath, like
 * Jev's decisions: nothing it spends is metered into an owner's debit.
 *
 * Its channel is written to the open-channel ledger the moment mppx has a descriptor and forgotten
 * when it closes, like a model channel's, so a kill mid-loop leaves a row the restart's
 * recovery closes through `closeChannelById`. The row names no `loopId`: recovery hands a loop's rows
 * to the loop's settle, which closes the loop's model channel and has no handle on this one.
 *
 * Not serialised through `withTreasury`, for the charge client's reason: the open signs with an
 * expiring nonce, so it waits on nothing — and a 5.9 s open queued in front of a step's first model
 * call would put the very delay on the step's clock that opening it beside the step is meant to
 * avoid.
 */
export function treasuryRpcSession(agentId?: string): MppRpcSession {
  const account = treasuryAccount();
  return new LedgeredRpcSession({
    account,
    maxDepositBase: RPC_DEPOSIT_BASE,
    topUpBase: RPC_TOPUP_BASE,
    onChannel: (recovery) => {
      if (!recovery.opened) return;
      rememberOpenChannel({
        agentId: agentId ?? "",
        channelId: recovery.channelId,
        payer: account.address,
        openedAt: Date.now(),
        recovery,
      });
    },
  });
}

/**
 * A session whose close takes its row off the ledger, as `PooledTempoTransport.close` does: only
 * after a close that returned, so one that threw (no receipt) leaves the row for recovery.
 */
class LedgeredRpcSession extends MppRpcSession {
  async close(): Promise<{ txHash?: string; spent?: string }> {
    const receipt = await super.close();
    if (this.channelId) forgetOpenChannel(this.channelId);
    return receipt;
  }
}

/** What `closeChannelById` hands its closer: the key, and everything the row (or the chain) knew. */
export interface ChannelClosePlan {
  channelId: string;
  account: TempoSigningAccount;
  recovery: MppChannelRecovery;
  /** Where the descriptor came from: the ledger row, or the escrow's `ChannelOpened` log. */
  source: "ledger" | "chain";
}

/**
 * Settles a channel this process holds no mppx session for: one a restart, a crash or another route
 * left open. Every recovery path comes through here — `recoverOpenChannels` for a chat row,
 * `settleLoopChannel` for a loop's. There is no manual close route.
 *
 * **Closes the channel the row names.** A fresh `SessionManager` cannot: mppx documents its
 * `close()` as closing that manager's *active* channel, and a manager built here has none, so it
 * would answer `undefined`, touch no chain, and the row would be pruned as though settled. An id
 * cannot be turned into a close: the escrow derives the id *from* the descriptor, and a close
 * credential names the descriptor and a voucher at the final cumulative, posted to the URL the
 * channel was challenged on. So the ledger row carries those (`OpenChannelRow.recovery`), and the
 * close rehydrates a manager onto them the way mppx's own CLI does for `mppx sessions close`
 * (`cli/sessions/Manager.js`: `getSessionManagerInternals(manager).rehydrate(…)`, then `close()`).
 * The hook is mppx-internal and not on its export map, so it is loaded by file path from wherever
 * `mppx/client` resolves; a version bump that moves it fails here, loudly, with the row kept.
 *
 * An older row may have no descriptor. It is not guessed at: the descriptor is read off the
 * escrow's `ChannelOpened` log for that id, and the close is signed at what the escrow says the
 * payee has already settled. A gateway holding a higher voucher answers with its snapshot and mppx
 * refuses to sign above the local cumulative, so that close fails and says so.
 *
 * Ordered with every other open and close this process makes so the ledger row is pruned against
 * the close that actually returned. The receipt is the only evidence a close landed: without one
 * the row stays and the caller is told.
 */
/**
 * How old a ledger row must be before an all-zero escrow read drops it as never opened or already
 * closed. Tempo's blocks are well under a second, so a lagging node is behind by seconds; minutes
 * is the margin, and a row the kill-in-the-open window left behind is dropped one restart later.
 */
export const ZERO_READ_TRUST_AGE_MS = 5 * 60_000;

export async function closeChannelById(
  channelId: string,
  payer: string,
  opts: {
    /**
     * The account to close with, taken as given. Without it a channel a loop key signed closes with
     * that key (through `keyAccountFor`) and every other channel with the treasury.
     */
    account?: TempoSigningAccount;
    /**
     * The loop the channel belongs to, when the caller knows it and the ledger may not: a channel
     * whose descriptor comes off the chain names its key but not its loop, and the key is found by
     * loop. A ledger row's own `loopId` wins.
     */
    loopId?: string;
    /** The close itself, replaced by tests; the default posts the close credential to the gateway. */
    close?: (plan: ChannelClosePlan) => Promise<{ txHash?: string; spent?: bigint | string } | undefined>;
    /** How the descriptor of a row without one is found; the default reads the escrow's log over `rpc`. */
    fromChain?: (channelId: string, payer: string) => Promise<MppChannelRecovery | undefined>;
    /** What the escrow holds under the id; the default is `getChannelState` over `rpc`. */
    escrow?: (channelId: string) => Promise<EscrowState>;
    rpc?: JsonRpc;
    /** The clock a row's age is read against; tests pin it. */
    now?: number;
  } = {}
): Promise<{ txHash?: string; spent?: string }> {
  // The payer every channel this console opened names: the treasury, whichever key signed it (a
  // loop key's `address` is its root's). Which key *closes* is settled below, once the descriptor
  // says who the channel's `authorizedSigner` is.
  const root = opts.account ?? treasuryAccount();
  // The treasury is the only key this process holds; an older channel paid by a per-agent derived
  // account is the caller's to pass that account for, since only it can know the channel is one.
  // Said out loud rather than refused: a close by the wrong account finds no channel and reports
  // it.
  if (!opts.account && payer && payer.toLowerCase() !== root.address.toLowerCase()) {
    console.warn(`tempo: channel ${channelId} names payer ${payer}; settling it as the treasury ${root.address}`);
  }
  // The escrow first. mppx writes its store entry — and so the row — when it *signs* the open,
  // before the gateway has submitted the transaction; a kill in that window leaves a row for a
  // channel the escrow has never held a deposit under. Nothing is committed, so there is nothing to
  // close, and a close credential for it would only fail at every restart with the row kept
  // forever. The same reading covers a row that outlived its own close. Not a receipt, so no
  // `txHash`: the caller records "closed, nothing settled", which is what `LoopRunner` writes for a
  // channel that never opened.
  const held = await (opts.escrow ?? ((id) => escrowState(id, opts.rpc)))(channelId);
  const rowOf = () => openChannelLedger().find((r) => r.channelId.toLowerCase() === channelId.toLowerCase());
  if (held.deposit === BigInt(0) && held.settled === BigInt(0)) {
    // But a channel opened a moment ago reads zeros too, from a node a block behind the one the open
    // landed on, and dropping its row forgets a live deposit (the reason `SETTLED_MEMO_AGE_MS` in
    // `tempo-stats.ts` will not trust a fresh zero). A young row is kept and the close is reported
    // as failed, which every caller already treats as "try again later".
    const young = rowOf();
    const age = young ? (opts.now ?? Date.now()) - young.openedAt : Infinity;
    if (age < ZERO_READ_TRUST_AGE_MS) {
      throw new Error(
        `tempo: channel ${channelId} reads no deposit on the escrow, but it opened ${Math.round(age / 1000)} s ago ` +
          `and the node may be behind the open; the row is kept and the close is tried again later`
      );
    }
    console.log(
      `tempo: channel ${channelId} holds no deposit on the escrow (never opened, or already closed); its row is dropped`
    );
    forgetOpenChannel(channelId);
    return {};
  }
  const row = rowOf();
  let recovery: MppChannelRecovery;
  let source: ChannelClosePlan["source"];
  if (row?.recovery) {
    recovery = row.recovery;
    source = "ledger";
  } else {
    const recovered = await (opts.fromChain ?? ((id, p) => recoveryFromChain(id, p, opts.rpc)))(
      channelId,
      root.address
    );
    if (!recovered) {
      throw new Error(
        `tempo: channel ${channelId} cannot be closed: its ledger row keeps no ` +
          `descriptor, and the escrow has no ChannelOpened log for it in the range read. The row is kept.`
      );
    }
    recovery = recovered;
    source = "chain";
  }
  const account = opts.account ?? (await keyedCloseAccount(channelId, row, recovery, opts.loopId, treasuryAccount()));
  const plan: ChannelClosePlan = { channelId, account, recovery, source };
  const receipt = await withTreasury(() => (opts.close ?? closeThroughGateway)(plan));
  if (!receipt?.txHash) {
    throw new Error(
      `tempo: close of channel ${channelId} returned no receipt, so nothing is known to have settled. ` +
        `The ledger row is kept.`
    );
  }
  forgetOpenChannel(channelId);
  const spent = receipt.spent === undefined ? undefined : String(receipt.spent);
  // A loop key's channel is reported to its loop, which keeps what the key has settled; a row the
  // treasury signed has no `signer` and no descriptor key, and is reported to no one.
  const signer = row?.signer ?? keyedSignerOf(recovery.descriptor);
  const ofLoop = row?.loopId ?? opts.loopId;
  if (signer && ofLoop && pool.keyedClosed) {
    try {
      pool.keyedClosed({
        loopId: ofLoop,
        channelId,
        deposit: held.deposit.toString(),
        ...(spent !== undefined ? { spent } : {}),
        signed: (/^\d+$/.test(recovery.cumulative ?? "") && BigInt(recovery.cumulative) > held.settled
          ? BigInt(recovery.cumulative)
          : held.settled
        ).toString(),
      });
    } catch (e: any) {
      // The close landed either way; a loop that did not hear of it counts the whole deposit.
      console.warn(`tempo: the loop ${ofLoop} was not told of the close of ${channelId}: ${e?.message ?? e}`);
    }
  }
  return { txHash: receipt.txHash, spent };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The access key a channel's descriptor names as `authorizedSigner`, or `undefined` when the payer
 * signs its own vouchers (mppx's `resolveAuthorizedSigner` answers the account's own address for a
 * key that is not an access key). This is what makes a channel keyed when its row predates the
 * `signer` field or the descriptor came off the chain: the escrow takes a close voucher only from
 * the `authorizedSigner`, so a treasury-signed close of such a channel could never land.
 */
function keyedSignerOf(d: MppChannelRecovery["descriptor"]): string | undefined {
  const s = d?.authorizedSigner;
  if (typeof s !== "string" || !s || s.toLowerCase() === ZERO_ADDRESS) return undefined;
  return s.toLowerCase() === String(d.payer).toLowerCase() ? undefined : s;
}

/**
 * The account a close with no explicit one is signed by: the treasury for a channel the treasury
 * signed — every row without a `signer` and an unkeyed descriptor — and the loop's own key for one
 * a key signed, through the hook the loop wiring installs (`setKeyAccountFor`).
 *
 * When that key cannot be had — no hook, the file gone, the key expired or revoked — this throws
 * and the row is **kept**. Dropping it would strand the deposit with no record that it is there;
 * signing with the treasury instead is not a fallback, because the escrow refuses a voucher from
 * anyone but the `authorizedSigner`. The treasury can still get the deposit back, as the channel's
 * payer, by force-closing it by hand, which the `tempo-key-missing` line spells out. A hook account
 * for some other key is refused for the same reason: it would sign a close the escrow cannot
 * accept.
 */
async function keyedCloseAccount(
  channelId: string,
  row: OpenChannelRow | undefined,
  recovery: MppChannelRecovery,
  loopId: string | undefined,
  treasury: PrivateKeyAccount
): Promise<TempoSigningAccount> {
  const signer = row?.signer ?? keyedSignerOf(recovery.descriptor);
  if (!signer) return treasury;
  const ofLoop = row?.loopId ?? loopId;
  const keyRow: OpenChannelRow = {
    ...(row ?? { agentId: "", channelId, payer: treasury.address, openedAt: 0 }),
    ...(ofLoop ? { loopId: ofLoop } : {}),
    signer,
  };
  // A descriptor read off the chain names the key and not its loop; with no row and no loop to look
  // the key up by, there is nothing to ask the hook, and the row is kept for the hand procedure.
  const hook = keyAccountForHook();
  const askable = row !== undefined || ofLoop !== undefined;
  let account: TempoSigningAccount | null = null;
  let why = !hook
    ? "no key hook is installed in this process"
    : !askable
    ? "its descriptor came off the chain with no loop to find the key by"
    : "the key is unavailable (its file gone, or the key expired or revoked)";
  if (hook && askable) {
    // A hook that throws (an unreadable key file) is the same answer as one that returns `null`:
    // the key cannot sign, and the row must be kept and said, not lost to an unexplained error.
    account = await hook(keyRow).catch((e: any) => {
      why = `the key could not be loaded: ${e?.message ?? String(e)}`;
      return null;
    });
  }
  if (!account) {
    logKeyMissing(channelId, signer, why);
    throw new Error(
      `tempo: channel ${channelId} was signed by the loop key ${signer}, and ${why}; the ledger row is kept ` +
        `for the treasury's force-close`
    );
  }
  const key = accessKeyOf(account);
  if (!key || key.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(
      `tempo: channel ${channelId} was signed by the loop key ${signer}, and the key hook answered ` +
        `${key ?? `the root account ${account.address}`}; refused, and the ledger row is kept`
    );
  }
  assertRootedOnTreasury(account, treasury, "closeChannelById");
  return account;
}

/**
 * One line, once per channel per process, saying a loop key's channel cannot be closed by this
 * console and how the operator closes it by hand. The marker `tempo-key-missing` is what to grep for.
 */
function logKeyMissing(channelId: string, signer: string, why: string): void {
  const logged = (pool.keyMissingLogged ??= new Set<string>());
  const id = channelId.toLowerCase();
  if (logged.has(id)) return;
  logged.add(id);
  console.warn(
    `tempo-key-missing: channel ${channelId} was signed by the loop key ${signer} and ${why}, so this console ` +
      `cannot close it; its ledger row is kept. Close it from the treasury by hand: the escrow's ` +
      `requestClose, then withdraw once the escrow's grace period has passed, with ` +
      `scripts/tempo-access-key-probe.ts --root-treasury --case p4 --channel ${channelId}`
  );
}

/** The `ChannelOpened` event of the TIP-1034 escrow: the whole descriptor, for a row that lost it. */
const CHANNEL_OPENED: Abi = [
  {
    type: "event",
    name: "ChannelOpened",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "authorizedSigner", type: "address", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
      { name: "expiringNonceHash", type: "bytes32", indexed: false },
      { name: "deposit", type: "uint96", indexed: false },
    ],
  },
];
/** `keccak256("ChannelOpened(bytes32,address,address,address,address,address,bytes32,bytes32,uint96)")`. */
const CHANNEL_OPENED_TOPIC = "0xdebaba36f0e9c7978f536fed432d9360b1f9646d7ca88531c34c3eae43f154a7";
const CHANNEL_STATE: Abi = [
  {
    type: "function",
    name: "getChannelState",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "settled", type: "uint96" },
          { name: "deposit", type: "uint96" },
          { name: "closeRequestedAt", type: "uint32" },
        ],
      },
    ],
  },
];

export interface EscrowState {
  settled: bigint;
  deposit: bigint;
  closeRequestedAt: number;
}
/** `getChannelState(channelId)` on the escrow: what it holds and has paid out under an id. */
export async function escrowState(channelId: string, rpc: JsonRpc = httpRpc()): Promise<EscrowState> {
  const data = encodeFunctionData({ abi: CHANNEL_STATE, functionName: "getChannelState", args: [channelId] });
  const raw = (await rpc("eth_call", [{ to: TEMPO_ESCROW, data }, "latest"])) as Hex;
  const s = decodeFunctionResult({ abi: CHANNEL_STATE, functionName: "getChannelState", data: raw }) as any;
  return { settled: BigInt(s.settled), deposit: BigInt(s.deposit), closeRequestedAt: Number(s.closeRequestedAt) };
}

/**
 * The `recovery` of a row without one, from the chain: the descriptor off the `ChannelOpened` log
 * and the amounts off `getChannelState`. The log is searched back from the head in ranges the RPC
 * serves (`logSearchRanges` in the SDK's `tempo.ts`: `LOG_SEARCH_CHUNK` blocks each, as far as
 * `OPEN_SEARCH_HORIZON`), because the RPC caps a `eth_getLogs` range at 100 000 blocks and a row
 * can be days old: one wide window (500 000 or 5 000 000 blocks) is refused every time, and a row
 * older than the first narrow one would never be recovered. A channel opened before the horizon is
 * not found and the caller says so. A range the RPC refuses as too wide moves the search on; a read
 * that fails for any other reason — a timeout, a 429 — throws, because `undefined` is the claim
 * that the escrow has no log for the channel. `cumulative` is what the payee has already settled —
 * the least the gateway will accept and the most this key is sure it signed.
 */
export async function recoveryFromChain(
  channelId: string,
  payer: string,
  rpc: JsonRpc = httpRpc()
): Promise<MppChannelRecovery | undefined> {
  const head = BigInt(await rpc("eth_blockNumber", []));
  let log: any;
  for (const [from, to] of logSearchRanges(head)) {
    const logs = await rpc("eth_getLogs", [
      {
        address: TEMPO_ESCROW,
        topics: [CHANNEL_OPENED_TOPIC, channelId],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ]).catch((e) => {
      if (LOG_RANGE_REFUSED.test(String(e?.message ?? e))) return [];
      throw e;
    });
    if (Array.isArray(logs) && logs.length) {
      log = logs[0];
      break;
    }
  }
  if (!log) return undefined;
  const { args } = decodeEventLog({ abi: CHANNEL_OPENED, data: log.data, topics: log.topics }) as any;
  if (String(args.payer).toLowerCase() !== payer.toLowerCase()) {
    throw new Error(
      `tempo: channel ${channelId} was opened by ${args.payer}, not by ${payer}; it is not ours to close`
    );
  }
  const state = await escrowState(channelId, rpc);
  return {
    channelId,
    chainId: TEMPO_CHAIN_ID,
    escrow: TEMPO_ESCROW,
    descriptor: {
      payer: args.payer,
      payee: args.payee,
      operator: args.operator,
      token: args.token,
      salt: args.salt,
      authorizedSigner: args.authorizedSigner,
      expiringNonceHash: args.expiringNonceHash,
    },
    deposit: String(state.deposit),
    cumulative: String(state.settled),
    spent: String(state.settled),
    endpoint: TEMPO_GATEWAY_URL,
    opened: true,
  };
}

/**
 * A fresh `tempo/session` challenge from the endpoint: a bare POST is answered 402 with one, and
 * costs nothing. Used when the row was written before the first response came back.
 */
async function freshChallenge(endpoint: string): Promise<any> {
  const { Challenge } = await dynamicImport("mppx");
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const found = res.status === 402 ? Challenge.fromResponseList(res).find(isSessionChallenge) : undefined;
  if (!found)
    throw new Error(`tempo: ${endpoint} answered ${res.status} with no tempo/session challenge to close against`);
  return found;
}
const isSessionChallenge = (c: any) => c?.method === "tempo" && c?.intent === "session";

/**
 * The challenge must be for the channel's own scope, or the close would be signed for one
 * payee and posted to another (the check mppx's CLI makes before it rehydrates).
 */
function assertChallengeScope(challenge: any, r: MppChannelRecovery): void {
  const req = challenge?.request ?? {};
  const details = req.methodDetails ?? {};
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  if (details.chainId !== undefined && details.chainId !== r.chainId)
    throw new Error("the close challenge names another chain");
  if (!same(req.recipient, r.descriptor.payee)) throw new Error("the close challenge names another payee");
  if (!same(req.currency, r.descriptor.token)) throw new Error("the close challenge names another token");
  if (details.escrowContract !== undefined && !same(details.escrowContract, r.escrow)) {
    throw new Error("the close challenge names another escrow");
  }
}

/** mppx's private session-manager hooks, by file path: see `closeChannelById`. */
async function mppxSessionInternals(): Promise<{
  getSessionManagerInternals: (m: unknown) => { rehydrate: (p: unknown) => void };
}> {
  const { createRequire } = await dynamicImport("node:module");
  const { pathToFileURL } = await dynamicImport("node:url");
  const client: string = createRequire(path.join(process.cwd(), "package.json")).resolve("mppx/client");
  const file = path.join(path.dirname(client), "..", "tempo", "session", "client", "internal", "SessionManager.js");
  return dynamicImport(pathToFileURL(file).href);
}

/** The default closer: rehydrate a manager onto the channel and post the close credential. */
async function closeThroughGateway(plan: ChannelClosePlan) {
  const r = plan.recovery;
  const { tempo } = await dynamicImport("mppx/client");
  const internals = await mppxSessionInternals();
  // A loop key closes only the channel that names it. mppx would sign the close voucher with
  // whatever key it is handed and the escrow would refuse it, so the mismatch is said here, before
  // anything is posted, with the row kept by the caller. A treasury close is not checked: an older
  // channel paid by a per-agent wallet fails at the gateway, which says why.
  const key = accessKeyOf(plan.account);
  if (key && key.toLowerCase() !== String(r.descriptor.authorizedSigner).toLowerCase()) {
    throw new Error(
      `tempo: channel ${r.channelId} names ${r.descriptor.authorizedSigner} as its signer, not the key ${key}; ` +
        `the close is refused and the row kept`
    );
  }
  const challenge = r.challenge ?? (await freshChallenge(r.endpoint));
  assertChallengeScope(challenge, r);
  // The account goes to mppx untouched: an access-key account signs the close voucher with its key
  // and names the root as the channel's payer, which is how the channel was opened.
  const manager = tempo.session.manager({
    account: plan.account,
    rpcUrl: { [r.chainId]: TEMPO_RPC_URL },
    allowedChainIds: [r.chainId],
    escrow: r.escrow,
    bootstrap: false,
  });
  internals.getSessionManagerInternals(manager).rehydrate({
    channel: {
      channelId: r.channelId,
      cumulativeAmount: BigInt(r.cumulative),
      deposit: BigInt(r.deposit),
      descriptor: r.descriptor,
      escrow: r.escrow,
      chainId: r.chainId,
      opened: true,
    },
    challenge,
    input: r.endpoint,
    spent: BigInt(r.spent),
  });
  const receipt = await manager.close();
  console.log(
    `tempo: closed channel ${r.channelId} (descriptor from the ${plan.source}) in ${receipt?.txHash ?? "no tx"}, ` +
      `spent ${receipt?.spent ?? "?"} of ${r.deposit} deposited`
  );
  return receipt;
}

/**
 * `import()` survives the CommonJS transform only when the compiler cannot see it: `mppx` is
 * ESM-only and this tree is CommonJS, the same trick `runtime/src/transport/mpp.ts` uses.
 */
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

// ─── Older rows' per-agent wallets, and what a drain leaves on them ─────────

/**
 * The Tempo fields a row may carry. The first three describe a per-agent wallet and are never
 * written: an agent deployed on the pool has a rail and no address of its own. They stay readable
 * because older rows on devnet have them, and `tempoDrained` / `tempoDrainTx` record a drain that
 * sent such a wallet's remainder back to the treasury.
 *
 * `tempoNote` is the one field this console writes: why an agent's sessions are scripted and
 * unbilled rather than paid over MPP.
 */
export interface TempoFunding {
  /** Older rows only: the agent's own Tempo address, derived, never stored as a key. */
  tempoAddress?: string;
  /** Older rows only: lifetime total sent to that address, USDC.e base units as a decimal string. */
  tempoFunded?: string;
  /** Older rows only: the last TIP-20 transfer that funded it. */
  tempoFundTx?: string;
  /** What the drain sent back to the treasury from that address, base units as a decimal string. */
  tempoDrained?: string;
  /** The TIP-20 transfer the drain made. */
  tempoDrainTx?: string;
  /** Why this agent's sessions are scripted and unbilled rather than paid over MPP. */
  tempoNote?: string;
}

export type FundedAgent = DeployedAgent & TempoFunding;

/**
 * What a drain sends from one per-agent wallet, or why it sends nothing. Pure, so the rule is
 * testable without a chain: the wallet pays its own gas in USDC.e, so the fee comes out of the
 * amount, and a balance that cannot cover the fee is left where it is rather than burned trying.
 */
export function drainPlan(p: {
  balanceBase: bigint;
  gasLimit: bigint;
  gasPriceWei: bigint;
}): { transfer: bigint; feeBase: bigint } | { skip: string } {
  if (p.balanceBase <= BigInt(0)) return { skip: "the wallet is empty" };
  const feeBase = gasFeeBase(p.gasLimit, p.gasPriceWei);
  if (p.balanceBase <= feeBase) {
    return { skip: `${base6(p.balanceBase)} USDC.e does not cover the ${base6(feeBase)} its gas costs` };
  }
  return { transfer: p.balanceBase - feeBase, feeBase };
}

/**
 * The rail a deploy or a launch records, and the note that says why a session on it will not be
 * billed.
 *
 * There is nothing to choose: the row records `tempo` wherever this deployment can sign a voucher,
 * so its genesis commits the rail its sessions will actually pay on. Where it cannot, the row
 * records **nothing** — absent is what a chain written before the rail existed carries, it hashes
 * exactly as an explicit `"vault"` does, and naming a rail the deployment has no treasury for would
 * put a claim in `policy_version_hash` that no session of that agent can keep. The reason goes
 * beside it, as a short treasury's does: the header is already on chain by then, and a deploy that
 * stands is not failed by a rail.
 *
 * `recorded` is what the config asked for, kept for the note and ignored for the decision.
 */
export function deployRailFields(recorded: Rail | undefined): { payment?: Rail; tempoNote?: string } {
  if (railFor(recorded, true) === "tempo") return { payment: "tempo" };
  return {
    tempoNote: "this deployment has no Tempo treasury configured, so its sessions run scripted and unbilled",
  };
}
