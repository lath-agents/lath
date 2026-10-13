/**
 * The live check behind per-loop access keys (docs/ARCHITECTURE.md §7.3): can Tempo itself cap a
 * loop's spend, by signing the loop's MPP session with an **access key** whose USDC.e limit is the
 * loop's budget? The code says yes in principle (mppx 0.10.1 signs a session with an access-key
 * account; the TIP-1034 escrow checks vouchers against `authorizedSigner`; Tempo's source counts
 * escrow deposits against the key's limit), which leaves two questions only mainnet can answer:
 *
 * - does mainnet count a channel deposit against the key's limit (Tempo's AccountKeychain docs say
 *   `transferFrom` is not limited, its source says the escrow's pull is)?
 * - does the hosted gateway accept a fee-sponsored open, and vouchers, signed through the keychain?
 *
 * Run by a person, spending mainnet USDC.e, at most about $0.05:
 *
 * ```bash
 * LATH_TEMPO_TREASURY=<key or file> npm run -s tempo:access-key-probe -- --out probe.json
 * ```
 *
 * By default the treasury is not the root of a test key. It funds a throwaway **root** account
 * (0.03 USDC.e), whose key is written to `.tempo-access-key-probe.key` (mode 0600, gitignored)
 * *before* any money moves, so a crash halfway can be resumed (`--resume`) or swept by hand.
 * `--root-treasury` makes the treasury itself the root instead, as loops use it: no root file, no
 * funding and no sweep, and each key it
 * authorizes on the treasury's keychain is limited to a few thousandths and expires within the
 * hour. Then:
 *
 * - **Case A, the cap.** Key A is authorized with a limit of 0.005 USDC.e and pays two calls on
 *   `rpc.mpp.tempo.xyz` with a 0.01 top-up. `mppx` opens at the gateway's `suggestedDeposit`
 *   (0.001), not at `maxDeposit` — so a channel opened that way stays inside key A's limit and
 *   tests nothing — so the deposit is pushed past the limit by the second call's
 *   top-up of 0.009 against 0.004 remaining, the same path case B's session takes. Expected: the
 *   top-up fails on the limit.
 * - **Case B, the session.** Key B is authorized with a limit of 0.01, opens a 0.01 channel, pays
 *   for two RPC calls and closes. Expected: the vouchers are accepted, the remaining limit reads 0
 *   after the open, and the close refunds the unspent deposit to the root.
 *
 * At the end the root's balance, less the transfer's gas, goes back to the treasury (`--keep`
 * skips that; `--sweep-only` does only that, from an existing root key file, for a run whose sweep
 * did not happen). `--only-a` skips case B. Both keys expire after an hour. Stop any console on the
 * treasury first (the treasury lock): the funding and the sweep are transfers signed with the treasury's
 * sequential nonce. The lock checked is the one under `LATH_TRACE_DIR`, so pass the console's —
 * `frontend/.traces-devnet` for `dev:devnet` — or the check reads an empty `./.traces`.
 *
 * **The cases.** The runs above settle that a key caps a session; per-loop keys rest on five more
 * answers only mainnet gives, and on one shot at the cap with a loop's own key. Each is
 * `--case <name>`, runs on the
 * treasury root only (`--root-treasury`; a case without it is refused), and prints one JSON object:
 * the transactions as explorer links, the values read, the treasury's balance before and after,
 * and an `answer` line saying what it settled. Each key a case authorizes lives in memory only, is
 * limited to a few thousandths and expires within the hour. Root transactions (authorize, update,
 * revoke, requestClose, withdraw) use the treasury's sequential nonce, so every case but two
 * refuses while a console holds the lock, as above. `loop-key` and `loop-key-scope` run beside a
 * live console, so the shots are taken without stopping the loop: their
 * only expected transactions are signed by the loop's key on an expiring nonce, which never takes a
 * treasury nonce. `loop-key`'s fallback does take one, so while the lock is held it sends nothing
 * from the treasury and prints the `p4 --channel` command to run once the console is stopped.
 *
 * - **`p1`**, an owner-paid storage charge signed by the key: one storage PUT paid by a charge the key signs, through the
 *   `MppChargeTransport` the console's storage path builds, with only the account changed. Did the
 *   gateway take it, and did the key's limit fall by the charge?
 * - **`p2`**, the limit-update formula: open at 0.001 and close, then `updateSpendingLimit` to 0.0025. The
 *   remaining limit reads 0.0025 if the update sets what is left, 0.0015 if it sets a total the
 *   spend is counted against. The `SpendingLimitUpdated` event is printed decoded and raw, for
 *   the audit's check (c), on the roadmap.
 * - **`p3`**, the revoke-on-stop order: one call, a top-up so the next call needs only a voucher,
 *   the key revoked with the channel open, then that voucher and a close signed by the key.
 * - **`p4`**, the lost-key hand procedure: a channel opened by a key that is never written down, closed by
 *   the treasury's `requestClose`, the escrow's grace period waited out on the chain's clock, then
 *   `withdraw`. It measures the grace period and takes about 15 minutes, so it runs last.
 *   `--channel <id>` runs only the close half on an existing channel: the procedure for a real lost
 *   key.
 * - **`p5`**, expiring nonces: authorize, `updateSpendingLimit` and revoke each tried on an expiring nonce
 *   (`nonceKey: 'expiring'`), falling back to the sequential one with the refusal recorded, and each
 *   receipt's gas and fee kept for the cost figures (docs/ARCHITECTURE.md §11).
 * - **`loop-key --loop <id>`**, the cap shot: reads the loop's key file under
 *   `LATH_TEMPO_KEY_DIR` (read only), and has that key sign an escrow `open` 0.001 past its remaining
 *   limit. A direct open, not a session: a session pays a call before any top-up can ask for more,
 *   and this shot must cost nothing when Tempo refuses it with `SpendingLimitExceeded`. If Tempo
 *   mines it instead, the script says so loudly and force-closes the channel as `p4` does.
 * - **`scopes`**, call scopes: a key authorized with
 *   `loopKeyScopes(<storage payee>)` — the console's own scopes, imported, not copied — at 0.003.
 *   The payee is read off a free 402 of the storage gateway, as a loop's start reads it, and
 *   `getAllowedCalls` is printed after the authorize and at the end. The key then pays one paid-RPC
 *   session (open, one call, close: the RPC service's payee is not the storage payee, but the key
 *   only calls the escrow for it, which is in scope), one storage PUT through `MppChargeTransport`
 *   as `p1` does, and last signs two USDC.e payments of 0.0001 to the treasury itself, outside its
 *   scopes: a plain `transfer` (a selector it was never given) and a `transferWithMemo` (its own
 *   selector, to a recipient it was not given). Both are expected refused with `CallNotAllowed` at
 *   submission, nothing mined; the treasury is the recipient so that a Tempo which mines one anyway
 *   moves nothing but the fee, and the script says so loudly. Until this case passes, a console
 *   runs with `LATH_TEMPO_KEY_SCOPES=off`.
 * - **`loop-key-scope --loop <id>`**, the scope shot, `loop-key`'s
 *   sibling: reads the loop's key file as `loop-key` does (read only, held to this treasury and to its
 *   own address) and its committed `scopes` — a file with none is refused, "this loop's key is
 *   unscoped" — prints `getAllowedCalls(treasury, key)` beside them, then has the loop's own key sign
 *   the two out-of-scope payments `scopes` fires, each on an expiring nonce. Expected: both refused
 *   with `CallNotAllowed`, nothing mined. A mined one paid only the treasury, less the fee, and is
 *   said loudly. A dry run with no key file stands in a throwaway key scoped as a loop's.
 *
 * `--dry-run` builds a case's calls — the signed key authorization, the calldata, the channel plan —
 * and sends nothing. It signs with a throwaway key in the treasury's place, so it needs no treasury
 * and no network, and names every chain read it stubbed. `--case all` is accepted with it.
 *
 * ```bash
 * LATH_TRACE_DIR=frontend/.traces-devnet LATH_TEMPO_TREASURY=<key or file> \
 *   npm run -s tempo:access-key-probe -- --root-treasury --case p2 --out p2.json
 * ```
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createClient,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  http,
  parseEventLogs,
  toHex,
  type Abi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempo as tempoMainnet } from "viem/chains";
import { MppChargeTransport, TEMPO_STORAGE_URL } from "@lath/runtime";
import { TempoRpcReader } from "../sdk/src";
import { loopKeyScopes } from "../frontend/src/app/api/_lib/tempo-keys";
import {
  STORAGE_CALL_CEILING_BASE,
  TEMPO_CHAIN_ID,
  TEMPO_ESCROW,
  TEMPO_GATEWAY_URL,
  TEMPO_RPC_URL,
  TEMPO_USDC_E,
  escrowState,
  estimateTransferGas,
  gasFeeBase,
  httpRpc,
  readTreasuryLock,
  recoveryFromChain,
  transferUsdc,
  treasuryAccount,
  usdcBalance,
  type JsonRpc,
} from "../frontend/src/app/api/_lib/tempo";

const RPC_SERVICE = "https://rpc.mpp.tempo.xyz";
const EXPLORER = "https://explore.tempo.xyz/tx/";
const ROOT_KEY_FILE = path.join(__dirname, "..", ".tempo-access-key-probe.key");
/** What the root is funded with: case B's 0.01 deposit, two key authorizations' fees, and slack. */
const FUNDING = BigInt(30_000);
const LIMIT_A = BigInt(5_000);
const LIMIT_B = BigInt(10_000);
const DEPOSIT = "0.01";

// `viem/tempo` goes through `import()` like `mppx`: required as CommonJS it pulls in `ox`, which
// tsconfig.json maps to its `.d.ts` files for the type checker and `tsconfig-paths/register` then
// maps at run time too, so the script died on import. The ESM resolver is not hooked.
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;
const usd = (base: bigint) => formatUnits(base, 6);
const short = (e: any) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 500);

/** The root key: read when resuming, else made and written before anything is funded. */
function rootKey(resume: boolean): `0x${string}` {
  if (fs.existsSync(ROOT_KEY_FILE)) {
    if (!resume) {
      throw new Error(
        `${ROOT_KEY_FILE} exists: a previous run may hold funds there. Pass --resume to reuse it, or sweep and remove it`
      );
    }
    return fs.readFileSync(ROOT_KEY_FILE, "utf8").trim() as `0x${string}`;
  }
  const key = generatePrivateKey();
  fs.writeFileSync(ROOT_KEY_FILE, key + "\n", { mode: 0o600 });
  return key;
}

/**
 * The treasury's private key, read by `LATH_TEMPO_TREASURY`'s rule (a file or the key itself) as
 * `tempoTreasury()` reads it. That keeps the raw key out of `_lib/tempo.ts`'s exports, where the
 * console could reach it; only `Account.fromSecp256k1` here needs the key rather than an account.
 */
function treasuryKey(): `0x${string}` {
  const spec = process.env.LATH_TEMPO_TREASURY?.trim() ?? "";
  const raw = spec.startsWith("0x") ? spec : fs.readFileSync(spec.replace(/^~/, os.homedir()), "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("LATH_TEMPO_TREASURY is not a 32-byte 0x-prefixed key");
  return raw as `0x${string}`;
}

/** One session on the paid RPC through `mppx`, signed by `account`, as the console opens a loop's. */
async function session(account: any, maxDeposit: string) {
  const { tempo } = await dynamicImport("mppx/client");
  const s = tempo.session.manager({
    account,
    rpcUrl: { [TEMPO_CHAIN_ID]: TEMPO_RPC_URL },
    allowedChainIds: [TEMPO_CHAIN_ID],
    maxDeposit,
    topUpAmount: maxDeposit,
  });
  const call = async (method: string) => {
    const before = BigInt(s.cumulative ?? 0);
    const t0 = Date.now();
    try {
      const res = await s.fetch(RPC_SERVICE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      });
      const text = await res.text();
      return {
        method,
        status: res.status,
        ms: Date.now() - t0,
        delta: usd(BigInt(s.cumulative ?? 0) - before),
        result: text.slice(0, 120),
      };
    } catch (e) {
      return { method, error: short(e), ms: Date.now() - t0 };
    }
  };
  return { s, call };
}

// ─── The --case probes ──────────────────────────────────────────────────────

const CASES = ["p1", "p2", "p3", "p4", "p5", "loop-key", "scopes", "loop-key-scope"] as const;
/**
 * The cases whose only transactions are signed by a loop's key on an expiring nonce, so they run
 * beside a console holding the treasury lock (see the header).
 */
const KEY_SIGNED_CASES: readonly string[] = ["loop-key", "loop-key-scope"];
type CaseName = (typeof CASES)[number];
/** Every key a case authorizes dies within the hour, as the default run's do. */
const KEY_TTL_S = 3600;
/** P1: room for one storage PUT (measured at 0.0002) and nothing more. */
const P1_LIMIT = BigInt(2_000);
/**
 * P2: authorized at 0.003, one 0.001 open spends it to 0.002, then the update sets 0.0025. The
 * three readings it can leave are distinct: 0.0025 if the update sets the remaining amount, 0.0015
 * if it sets a total the 0.001 already spent is counted against, 0.002 if it did nothing.
 */
const P2_LIMIT = BigInt(3_000);
const P2_SET = BigInt(2_500);
/** P3: the 0.001 open, a 0.001 top-up so a second voucher needs no deposit, and nothing over. */
const P3_LIMIT = BigInt(3_000);
const P4_LIMIT = BigInt(2_000);
/** P5 never spends through its key; the limit and the update only have to be values. */
const P5_LIMIT = BigInt(1_000);
const P5_SET = BigInt(500);
/** How far past the loop key's remaining limit the cap shot's deposit asks. */
const LOOP_KEY_OVER = BigInt(1_000);
/** `scopes`: one 0.001 open, one storage PUT (about 0.0002) and room left, so no refusal is the limit's. */
const SCOPES_LIMIT = BigInt(3_000);
/** `scopes`: each out-of-scope payment, 0.0001 — far inside what the key has left when it is sent. */
const OUT_OF_SCOPE_AMOUNT = BigInt(100);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const STUB_PAYEE = "0x000000000000000000000000000000000000dEaD";
const ZERO32 = `0x${"00".repeat(32)}` as `0x${string}`;
const POLL_MS = 30_000;
/** One paid-RPC call, and the deposit a session opens at: the gateway's suggested 0.001. */
const ONE_CALL = "0.001";

/**
 * The slice of the TIP-1034 escrow the cases call themselves. Copied from mppx 0.10.1's
 * `tempo/session/precompile/escrow.abi.js` rather than imported, because that file is not on
 * mppx's export map — `_lib/tempo.ts` copies `ChannelOpened` and `getChannelState` for the same
 * reason.
 */
const DESCRIPTOR = {
  name: "descriptor",
  type: "tuple",
  components: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "operator", type: "address" },
    { name: "token", type: "address" },
    { name: "salt", type: "bytes32" },
    { name: "authorizedSigner", type: "address" },
    { name: "expiringNonceHash", type: "bytes32" },
  ],
} as const;
const ESCROW_ABI: Abi = [
  {
    type: "function",
    name: "CLOSE_GRACE_PERIOD",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payee", type: "address" },
      { name: "operator", type: "address" },
      { name: "token", type: "address" },
      { name: "deposit", type: "uint96" },
      { name: "salt", type: "bytes32" },
      { name: "authorizedSigner", type: "address" },
    ],
    outputs: [{ name: "channelId", type: "bytes32" }],
  },
  { type: "function", name: "requestClose", stateMutability: "nonpayable", inputs: [DESCRIPTOR], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [DESCRIPTOR], outputs: [] },
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
  {
    type: "event",
    name: "CloseRequested",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "closeGraceEnd", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelClosed",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "settledToPayee", type: "uint96", indexed: false },
      { name: "refundedToPayer", type: "uint96", indexed: false },
    ],
  },
];

/** The loop key file the console writes (`_lib/tempo-keys.ts`); `loop-key` only reads it. */
interface LoopKeyFile {
  v: 1;
  loopId: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  root: `0x${string}`;
  token: `0x${string}`;
  limitBase: string;
  expiry: number;
  authorizeTx?: `0x${string}`;
  /** The key's call scopes, when the console authorized it scoped; printed, not used. */
  scopes?: { address: string; selector?: string; recipients?: string[] }[];
  createdAt: number;
}

/** A call scope as `loopKeyScopes` builds it and the policy commits it. */
type Scope = { address: string; selector?: string; recipients?: string[] };

/** Everything a case touches. In a dry run `root` is a throwaway and nothing reaches the network. */
interface Ctx {
  dry: boolean;
  argv: string[];
  rpc: JsonRpc;
  client: any;
  root: any;
  address: `0x${string}`;
  tempo: any;
  actions: any;
  expiry: number;
  txs: Record<string, string>;
  /** What a dry run could not build without the chain, and the value it used instead. */
  stubbed: string[];
  /** In a dry run, each call the case would make, with its target and calldata or payload. */
  plan: Record<string, unknown>;
}

/** The console's treasury lock, when its heartbeat is fresh enough that a console is still running. */
function treasuryHolder(): { pid: number } | null {
  const lock = readTreasuryLock();
  return lock && Date.now() - lock.heartbeatAt < 30_000 ? lock : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const arg = (argv: string[], name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
/** Every layer of a viem error, because the keychain's reason sits in `details` or the cause. */
const why = (e: any) =>
  [e?.shortMessage, e?.details, e?.cause?.shortMessage, e?.cause?.details, e?.message]
    .filter((x, i, all) => typeof x === "string" && x && all.indexOf(x) === i)
    .join(" | ")
    .slice(0, 900);
const limitShaped = (s: string | undefined) => /SpendingLimitExceeded/i.test(s ?? "");
const progress = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);
const stub = <T>(ctx: Ctx, what: string, value: T): T => {
  ctx.stubbed.push(what);
  return value;
};

function newKey(ctx: Ctx): any {
  // In memory only. No case writes a key it authorizes anywhere: each expires within the hour,
  // holds a limit of a few thousandths, and the treasury is the payer of every channel it opens.
  return ctx.tempo.Account.fromSecp256k1(generatePrivateKey(), { access: ctx.root });
}

/**
 * A root transaction authorizing `key`, on the sequential nonce unless `extra` says otherwise.
 * `scopes` only for the `scopes` case: every other case authorizes unscoped, with no `scopes` key
 * at all.
 */
async function authorizeKey(
  ctx: Ctx,
  label: string,
  key: any,
  limit: bigint,
  extra: Record<string, unknown> = {},
  scopes?: Scope[]
) {
  const limits = [{ token: TEMPO_USDC_E, limit }];
  const scoped = scopes ? { scopes } : {};
  if (ctx.dry) {
    // The key authorization is signed offline, exactly as `authorizeSync` signs it before sending.
    const keyAuthorization = await ctx.tempo.Actions.accessKey.signAuthorization(ctx.client, {
      account: ctx.root,
      chainId: TEMPO_CHAIN_ID,
      accessKey: key,
      expiry: ctx.expiry,
      limits,
      ...scoped,
    });
    ctx.plan[label] = {
      send: "a Tempo transaction from the root carrying keyAuthorization",
      key: key.accessKeyAddress,
      limitBase: limit,
      expiry: ctx.expiry,
      ...scoped,
      nonce: extra.nonceKey ?? "sequential",
      keyAuthorization,
    };
    stub(ctx, `${label}: the nonce, gas and fee are read at send time; not read`, null);
    return { receipt: null as any };
  }
  const r = await ctx.tempo.Actions.accessKey.authorizeSync(
    ctx.client as any,
    {
      accessKey: key,
      expiry: ctx.expiry,
      limits,
      ...scoped,
      ...extra,
    } as any
  );
  ctx.txs[label] = r.receipt.transactionHash;
  return r;
}

/** `updateSpendingLimit` or `revokeKey` on the keychain, from the root. */
async function keychainWrite(
  ctx: Ctx,
  label: string,
  fn: "updateLimit" | "revoke",
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  const action = ctx.tempo.Actions.accessKey[fn];
  if (ctx.dry) {
    const call = action.call(args);
    ctx.plan[label] = {
      to: call.address,
      functionName: call.functionName,
      args: call.args,
      data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }),
      nonce: extra.nonceKey ?? "sequential",
    };
    stub(ctx, `${label}: the nonce, gas and fee are read at send time; not read`, null);
    return { receipt: null as any };
  }
  const r = await ctx.tempo.Actions.accessKey[`${fn}Sync`](ctx.client as any, { ...args, ...extra } as any);
  ctx.txs[label] = r.receipt.transactionHash;
  return r;
}

async function remainingOf(ctx: Ctx, key: any, dryValue: bigint): Promise<bigint> {
  if (ctx.dry) return stub(ctx, `getRemainingLimit(${key.accessKeyAddress ?? key}): read as ${dryValue}`, dryValue);
  const r = await ctx.tempo.Actions.accessKey.getRemainingLimit(ctx.client as any, {
    account: ctx.address,
    accessKey: key,
    token: TEMPO_USDC_E,
  });
  return r.remaining as bigint;
}

async function balanceOf(ctx: Ctx): Promise<bigint | null> {
  if (ctx.dry) return null;
  return usdcBalance(ctx.rpc, ctx.address);
}

/** A root transaction to the escrow (requestClose, withdraw): sequential nonce, waited for. */
async function escrowWrite(ctx: Ctx, label: string, functionName: string, args: unknown[]) {
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName, args });
  if (ctx.dry) {
    ctx.plan[label] = { to: TEMPO_ESCROW, functionName, args, data, nonce: "sequential" };
    stub(ctx, `${label}: the nonce, gas and fee are read at send time; not read`, null);
    return null;
  }
  const receipt = await ctx.actions.sendTransactionSync(
    ctx.client as any,
    {
      calls: [{ to: TEMPO_ESCROW, data }],
      throwOnReceiptRevert: true,
    } as any
  );
  ctx.txs[label] = receipt.transactionHash;
  return receipt;
}

async function escrowRead(ctx: Ctx, functionName: string, args: unknown[], dryValue: unknown): Promise<any> {
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName, args });
  if (ctx.dry) {
    ctx.plan[`read ${functionName}`] = { to: TEMPO_ESCROW, data };
    return stub(ctx, `${functionName}(): read as ${String(dryValue)}`, dryValue);
  }
  const raw = await ctx.rpc("eth_call", [{ to: TEMPO_ESCROW, data }, "latest"]);
  return decodeFunctionResult({ abi: ESCROW_ABI, functionName, data: raw });
}

/** A receipt by hash over the plain RPC, waited for: a charge's or a gateway-sent close's. */
async function receiptOf(ctx: Ctx, hash: string, waitMs = 30_000): Promise<any | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await ctx.rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    if (Date.now() >= deadline) return null;
    await sleep(1500);
  }
}

/** The named events in a receipt's logs, decoded, with the raw topics and data kept beside. */
function eventsIn(receipt: any, abi: Abi, eventName: string) {
  if (!receipt?.logs) return [];
  return parseEventLogs({ abi, logs: receipt.logs, eventName } as any).map((l: any) => ({
    event: l.eventName,
    address: l.address,
    topics: l.topics,
    data: l.data,
    args: l.args,
  }));
}

/** What a root transaction cost: the receipt's gas at its effective price, in USDC.e. */
function gasOf(receipt: any) {
  if (!receipt) return null;
  const gasUsed = BigInt(receipt.gasUsed);
  const price = BigInt(receipt.effectiveGasPrice ?? 0);
  const fee = gasFeeBase(gasUsed, price);
  return {
    gasUsed,
    effectiveGasPrice: price,
    feeBase: fee,
    fee: usd(fee),
    ...(receipt.feeToken ? { feeToken: receipt.feeToken } : {}),
    ...(receipt.feePayer ? { feePayer: receipt.feePayer } : {}),
  };
}

/** The descriptor of a channel the treasury paid for, off the escrow's `ChannelOpened` log. */
async function descriptorOf(ctx: Ctx, channelId: string, signer: string) {
  if (ctx.dry) {
    return stub(ctx, `the descriptor of ${channelId}: a placeholder, not read from ChannelOpened`, {
      payer: ctx.address,
      payee: STUB_PAYEE,
      operator: ZERO_ADDRESS,
      token: TEMPO_USDC_E,
      salt: ZERO32,
      authorizedSigner: signer,
      expiringNonceHash: ZERO32,
    });
  }
  const recovery = await recoveryFromChain(channelId, ctx.address, ctx.rpc);
  if (!recovery)
    throw new Error(`no ChannelOpened log for ${channelId} in the range read; pass a channel opened later`);
  return recovery.descriptor;
}

/**
 * The lost-key hand procedure: the payer's `requestClose`, the escrow's grace period waited out on the
 * chain's clock, then `withdraw`. The wait is measured, not assumed: the grace is read from
 * `CLOSE_GRACE_PERIOD()`, the end from the `CloseRequested` event, and a `withdraw` refused as early
 * is retried every 30 s, so `waitedSeconds` is what the escrow actually held the channel for. The
 * payee may still settle its last voucher inside the grace period, and if it closes the channel
 * itself there is nothing left to withdraw; that is reported rather than treated as a failure.
 */
async function forceClose(ctx: Ctx, channelId: string, signer: string, prefix: string) {
  const out: Record<string, any> = { channelId };
  const descriptor = await descriptorOf(ctx, channelId, signer);
  out.descriptor = descriptor;
  out.authorizedSigner = descriptor.authorizedSigner;
  const grace = BigInt(await escrowRead(ctx, "CLOSE_GRACE_PERIOD", [], BigInt(900)));
  out.graceSecondsOnChain = grace;
  const before = ctx.dry
    ? stub(ctx, "getChannelState: read as deposit 0.001, settled 0", {
        deposit: BigInt(1_000),
        settled: BigInt(0),
        closeRequestedAt: 0,
      })
    : await escrowState(channelId, ctx.rpc);
  out.stateBefore = {
    deposit: usd(before.deposit),
    settled: usd(before.settled),
    closeRequestedAt: before.closeRequestedAt,
  };
  if (!ctx.dry && before.deposit === BigInt(0) && before.settled === BigInt(0)) {
    out.answer = "the escrow holds nothing under this id: never opened, or already closed";
    return out;
  }
  if (before.closeRequestedAt === 0) {
    const rc = await escrowWrite(ctx, `${prefix}RequestClose`, "requestClose", [descriptor]);
    out.requestClose = { gas: gasOf(rc), events: eventsIn(rc, ESCROW_ABI, "CloseRequested") };
  } else {
    out.requestClose = `already requested at ${before.closeRequestedAt}; not sent again`;
  }
  if (ctx.dry) {
    await escrowWrite(ctx, `${prefix}Withdraw`, "withdraw", [descriptor]);
    out.wait = `poll the latest block's timestamp every ${
      POLL_MS / 1000
    } s until closeRequestedAt + grace, then withdraw`;
    return out;
  }
  const requested = await escrowState(channelId, ctx.rpc);
  const requestedAt = BigInt(requested.closeRequestedAt || Math.floor(Date.now() / 1000));
  const graceEnd = requestedAt + grace;
  out.closeRequestedAt = requestedAt;
  out.graceEnd = graceEnd;
  const t0 = Date.now();
  for (;;) {
    const block = await ctx.rpc("eth_getBlockByNumber", ["latest", false]);
    const now = BigInt(block.timestamp);
    const st = await escrowState(channelId, ctx.rpc);
    if (st.deposit === BigInt(0) && st.settled === BigInt(0)) {
      out.closedByPayeeDuringGrace = true;
      out.answer = `the payee closed the channel inside the grace period; nothing left to withdraw`;
      out.waitedSeconds = Math.round((Date.now() - t0) / 1000);
      return out;
    }
    if (now >= graceEnd) break;
    progress(
      `${prefix}: ${graceEnd - now} s of the grace period left (chain time ${now}, end ${graceEnd}); settled ${usd(
        st.settled
      )} of ${usd(st.deposit)}`
    );
    await sleep(Number(graceEnd - now) * 1000 < POLL_MS ? Number(graceEnd - now) * 1000 + 2000 : POLL_MS);
  }
  const attempts: any[] = [];
  let receipt: any = null;
  for (let i = 0; i < 10 && !receipt; i++) {
    try {
      receipt = await escrowWrite(ctx, `${prefix}Withdraw`, "withdraw", [descriptor]);
    } catch (e) {
      attempts.push({ at: new Date().toISOString(), error: why(e) });
      progress(`${prefix}: withdraw refused (${why(e).slice(0, 160)}); retrying in ${POLL_MS / 1000} s`);
      await sleep(POLL_MS);
    }
  }
  out.withdrawAttempts = attempts;
  out.waitedSeconds = Math.round((Date.now() - t0) / 1000);
  if (!receipt) {
    out.answer = `withdraw was refused ${attempts.length} times after the grace period; rerun --case p4 --channel ${channelId}`;
    return out;
  }
  out.withdraw = { gas: gasOf(receipt), events: eventsIn(receipt, ESCROW_ABI, "ChannelClosed") };
  const after = await escrowState(channelId, ctx.rpc);
  out.stateAfter = { deposit: usd(after.deposit), settled: usd(after.settled) };
  const closed = out.withdraw.events[0]?.args;
  out.answer =
    `force-closed after ${out.waitedSeconds} s (grace ${grace} s on chain): ` +
    (closed
      ? `${usd(BigInt(closed.refundedToPayer))} refunded to the treasury, ${usd(
          BigInt(closed.settledToPayee)
        )} settled to the payee`
      : "withdraw mined with no ChannelClosed event; read the receipt");
  return out;
}

/** The paid-RPC session a case pays through, or in a dry run the plan of one. */
async function sessionFor(ctx: Ctx, label: string, key: any, maxDeposit: string) {
  if (ctx.dry) {
    ctx.plan[label] = {
      service: RPC_SERVICE,
      client: "mppx tempo.session.manager",
      payer: ctx.address,
      authorizedSigner: key.accessKeyAddress,
      maxDeposit,
      topUpAmount: maxDeposit,
    };
    stub(ctx, `${label}: mppx builds the open from the gateway's 402 challenge; not fetched`, null);
    return null;
  }
  return session(key, maxDeposit);
}

async function closeSession(ctx: Ctx, label: string, s: any) {
  if (!s?.opened) return { skipped: "no channel was opened" };
  try {
    const r = await s.close();
    if (r?.txHash) ctx.txs[label] = r.txHash;
    return { txHash: r?.txHash ?? null, spent: r?.spent !== undefined ? usd(BigInt(r.spent)) : null };
  } catch (e) {
    return { error: why(e) };
  }
}

/**
 * P1: one storage PUT paid by a charge the key signs, through the same `MppChargeTransport`
 * `treasuryChargeTransport` builds — only the account differs. Accepted means a paid 2xx; counted
 * means the key's remaining limit fell by exactly the charge's amount. The charge's transaction
 * (the receipt's `reference`) is read for the keychain's `AccessKeySpend` event as well.
 */
async function caseP1(ctx: Ctx, out: Record<string, any>) {
  const key = newKey(ctx);
  out.key = key.accessKeyAddress;
  out.limit = usd(P1_LIMIT);
  await authorizeKey(ctx, "authorize", key, P1_LIMIT);
  const transport = new MppChargeTransport({
    account: key,
    maxCostBase: STORAGE_CALL_CEILING_BASE,
    currency: TEMPO_USDC_E,
  });
  out.chargePayer = transport.payer;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const objectKey = `lath-probe-key-p1-${stamp}`;
  const body = `lath access-key probe P1 ${stamp}: a storage PUT paid by a charge an access key signed\n`;
  const url = `${TEMPO_STORAGE_URL}/${objectKey}`;
  const init = { method: "PUT", headers: { "content-type": "text/plain" }, body };
  out.put = { url, bytes: Buffer.byteLength(body), maxCostBase: STORAGE_CALL_CEILING_BASE };
  const before = await remainingOf(ctx, key, P1_LIMIT);
  out.remainingBefore = usd(before);
  if (ctx.dry) {
    ctx.plan.put = { ...out.put, method: "PUT", account: { payer: transport.payer, signer: key.accessKeyAddress } };
    stub(ctx, "put: the charge is priced by the storage gateway's 402 challenge; not fetched", null);
    out.answer = "dry run: the key, its authorization and the charge transport were built; nothing was sent";
    return;
  }
  let res: any;
  try {
    res = await transport.fetch(url, init);
    out.put.status = res.status;
    out.put.payment = res.payment ?? null;
  } catch (e: any) {
    out.put.error = why(e);
    out.put.payment = e?.payment ?? null;
  }
  const after = await remainingOf(ctx, key, BigInt(0));
  out.remainingAfter = usd(after);
  const amount = out.put.payment?.amount ? BigInt(out.put.payment.amount) : null;
  const ref = out.put.payment?.reference;
  if (ref && /^0x[0-9a-fA-F]{64}$/.test(ref)) {
    ctx.txs.charge = ref;
    const receipt = await receiptOf(ctx, ref);
    out.chargeReceipt = receipt
      ? {
          status: receipt.status,
          from: receipt.from,
          spend: eventsIn(receipt, ctx.tempo.Abis.accountKeychain, "AccessKeySpend"),
        }
      : "not found within 30 s";
  }
  const accepted = res && res.status >= 200 && res.status < 300 && !!out.put.payment;
  const counted = amount !== null && before - after === amount;
  out.accepted = !!accepted;
  out.countedAgainstLimit = counted;
  out.answer = accepted
    ? counted
      ? `a key-signed storage charge holds: the storage gateway accepted a charge signed by the key (status ${
          res.status
        }), and the key's limit fell by the charge's ${usd(amount)}`
      : `the gateway accepted the key's charge (status ${res.status}) but the limit fell by ${usd(
          before - after
        )}, not the charge's ${amount === null ? "unknown amount" : usd(amount)}; a key-signed charge is not clean`
    : `a key-signed storage charge does not hold: the storage PUT signed by the key was not accepted (${
        out.put.error ?? `status ${res?.status}`
      }); storage stays treasury-signed`;
}

/** P2: what `updateSpendingLimit` sets, read before and after, and its event's layout. */
async function caseP2(ctx: Ctx, out: Record<string, any>) {
  const key = newKey(ctx);
  out.key = key.accessKeyAddress;
  out.limit = usd(P2_LIMIT);
  out.set = usd(P2_SET);
  await authorizeKey(ctx, "authorize", key, P2_LIMIT);
  const sess = await sessionFor(ctx, "session", key, ONE_CALL);
  if (sess) {
    out.call = await sess.call("eth_blockNumber");
    out.channelId = sess.s.channelId ?? null;
    out.remainingAfterOpen = usd(await remainingOf(ctx, key, BigInt(0)));
    out.close = await closeSession(ctx, "close", sess.s);
  }
  const before = await remainingOf(ctx, key, P2_LIMIT - BigInt(1_000));
  out.remainingBeforeUpdate = usd(before);
  const spent = P2_LIMIT - before;
  const r = await keychainWrite(ctx, "updateLimit", "updateLimit", {
    accessKey: key,
    token: TEMPO_USDC_E,
    limit: P2_SET,
  });
  const after = await remainingOf(ctx, key, P2_SET);
  out.remainingAfterUpdate = usd(after);
  out.updateGas = gasOf(r.receipt);
  out.event = eventsIn(r.receipt, ctx.tempo.Abis.accountKeychain, "SpendingLimitUpdated");
  if (ctx.dry) {
    out.answer = "dry run: the authorization and the updateSpendingLimit calldata were built; nothing was sent";
    return;
  }
  out.answer =
    spent === BigInt(0)
      ? `inconclusive: nothing was spent before the update (remaining ${usd(
          before
        )}), so remaining and total read the same`
      : after === P2_SET
      ? `updateSpendingLimit sets the remaining amount: after ${usd(spent)} spent, setting ${usd(
          P2_SET
        )} left exactly ${usd(after)} remaining`
      : after === P2_SET - spent
      ? `updateSpendingLimit sets a total: after ${usd(spent)} spent, setting ${usd(P2_SET)} left ${usd(
          after
        )} remaining`
      : `unclear: ${usd(spent)} spent, set ${usd(P2_SET)}, ${usd(after)} remaining; read the event`;
}

/** P3, the revoke-on-stop order: revoke with a channel open, then a voucher, then a close. */
async function caseP3(ctx: Ctx, out: Record<string, any>) {
  const key = newKey(ctx);
  out.key = key.accessKeyAddress;
  out.limit = usd(P3_LIMIT);
  await authorizeKey(ctx, "authorize", key, P3_LIMIT);
  const sess = await sessionFor(ctx, "session", key, "0.002");
  if (!sess) {
    ctx.plan.topUp = { amount: ONE_CALL, note: "mppx SessionManager.topUp, so the second voucher needs no deposit" };
    await keychainWrite(ctx, "revoke", "revoke", { accessKey: key });
    ctx.plan.voucherAfterRevoke = { service: RPC_SERVICE, note: "one more paid call on the open channel" };
    ctx.plan.closeAfterRevoke = { note: "mppx SessionManager.close, the close credential signed by the revoked key" };
    out.answer = "dry run: the authorization and the revokeKey calldata were built; nothing was sent";
    return;
  }
  out.firstCall = await sess.call("eth_blockNumber");
  out.channelId = sess.s.channelId ?? null;
  try {
    const t = await sess.s.topUp(ONE_CALL);
    out.topUp = { ok: true, txHash: t?.txHash ?? null };
    if (t?.txHash) ctx.txs.topUp = t.txHash;
  } catch (e) {
    out.topUp = { ok: false, error: why(e), note: "the second call will need a top-up, signed by the revoked key" };
  }
  out.remainingBeforeRevoke = usd(await remainingOf(ctx, key, BigInt(0)));
  const cumulativeBeforeRevoke = BigInt(sess.s.cumulative ?? 0);
  out.cumulativeBeforeRevoke = usd(cumulativeBeforeRevoke);
  // A failed revoke still goes on to the close, so the case never leaves its channel open.
  try {
    const rv = await keychainWrite(ctx, "revoke", "revoke", { accessKey: key });
    out.revokeGas = gasOf(rv.receipt);
  } catch (e) {
    out.revokeError = why(e);
  }
  out.voucherAfterRevoke = await sess.call("eth_chainId");
  const voucherAccepted = out.voucherAfterRevoke.status === 200 && Number(out.voucherAfterRevoke.delta) > 0;
  out.close = await closeSession(ctx, "close", sess.s);
  let settled: bigint | null = null;
  if (out.close.txHash) {
    const receipt = await receiptOf(ctx, out.close.txHash);
    out.closeEvents = eventsIn(receipt, ESCROW_ABI, "ChannelClosed");
    const ev = out.closeEvents[0]?.args;
    if (ev) settled = BigInt(ev.settledToPayee);
  } else if (out.channelId) {
    const st = await escrowState(out.channelId, ctx.rpc).catch(() => null);
    out.stateAfterFailedClose = st ? { deposit: usd(st.deposit), settled: usd(st.settled) } : null;
    if (st) settled = st.settled;
    out.recovery = `--case p4 --channel ${out.channelId} (the treasury's requestClose, then withdraw)`;
  }
  out.settled = settled === null ? null : usd(settled);
  const settledBefore = settled !== null && settled >= cumulativeBeforeRevoke;
  out.answer =
    (out.revokeError ? `INCONCLUSIVE, the revoke failed (${out.revokeError.slice(0, 200)}); with the key live: ` : "") +
    `after revoking with the channel open: a new voucher was ${voucherAccepted ? "ACCEPTED" : "refused"}` +
    `${voucherAccepted ? "" : ` (${out.voucherAfterRevoke.error ?? `status ${out.voucherAfterRevoke.status}`})`}; ` +
    `the cooperative close signed by the key ${
      out.close.txHash ? "worked" : `failed (${out.close.error ?? out.close.skipped})`
    }; ` +
    `vouchers accepted before the revoke (${usd(cumulativeBeforeRevoke)}) ${
      settled === null
        ? "are not known to have settled"
        : settledBefore
        ? `settled (${usd(settled)} to the payee)`
        : `did not all settle (${usd(settled)} settled)`
    }`;
}

/** P4: a channel whose key is never written down, closed by the treasury alone. */
async function caseP4(ctx: Ctx, out: Record<string, any>) {
  const given = arg(ctx.argv, "--channel");
  let channelId: string;
  let signer: string = ZERO_ADDRESS;
  if (given) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(given)) throw new Error("--channel takes a 32-byte 0x channel id");
    channelId = given;
    out.mode = "existing channel: requestClose, wait, withdraw";
  } else {
    // The key lives in this function's frame and nowhere else; once the channel is open it is
    // not used again, which is the state a lost key file leaves a loop's channel in.
    const key = newKey(ctx);
    signer = key.accessKeyAddress;
    out.key = signer;
    out.keySaved = false;
    out.limit = usd(P4_LIMIT);
    await authorizeKey(ctx, "authorize", key, P4_LIMIT);
    const sess = await sessionFor(ctx, "session", key, ONE_CALL);
    if (sess) {
      out.call = await sess.call("eth_blockNumber");
      if (!sess.s.opened || !sess.s.channelId) {
        out.answer = `the session did not open a channel (${
          out.call.error ?? `status ${out.call.status}`
        }); nothing to force-close`;
        return;
      }
      channelId = sess.s.channelId;
    } else {
      channelId = stub(ctx, "the channel id: a placeholder, since no channel is opened in a dry run", ZERO32);
    }
  }
  out.channelId = channelId;
  try {
    out.forceClose = await forceClose(ctx, channelId, signer, "p4");
  } catch (e) {
    // The requestClose may already be on chain (its link is in `txs`); the close half reruns alone.
    out.recovery = `--case p4 --channel ${channelId}`;
    throw e;
  }
  out.answer = ctx.dry
    ? `dry run: ${
        given ? "" : "the authorization, "
      }the requestClose and withdraw calldata were built; nothing was sent`
    : out.forceClose.answer;
}

/** P5: the expiring nonce on each root keychain transaction, and what each costs. */
async function caseP5(ctx: Ctx, out: Record<string, any>) {
  const key = newKey(ctx);
  out.key = key.accessKeyAddress;
  const expiring = { nonceKey: "expiring" };
  const attempt = async (label: string, run: (extra: Record<string, unknown>) => Promise<any>) => {
    const row: Record<string, any> = {};
    try {
      const r = await run(expiring);
      row.nonce = "expiring";
      row.gas = gasOf(r.receipt);
      return { row, ok: true };
    } catch (e) {
      row.expiringRefused = why(e);
      progress(`p5: ${label} with an expiring nonce refused: ${row.expiringRefused.slice(0, 200)}`);
      return { row, ok: false };
    }
  };
  const fallback = async (
    label: string,
    row: Record<string, any>,
    run: (extra: Record<string, unknown>) => Promise<any>
  ) => {
    const r = await run({});
    row.nonce = "sequential (fallback)";
    row.gas = gasOf(r.receipt);
  };

  const auth = await attempt("authorize", (x) => authorizeKey(ctx, "authorizeExpiring", key, P5_LIMIT, x));
  if (!auth.ok && !ctx.dry) {
    // A refusal can come after the transaction landed (a timeout waiting for it); authorizing the
    // same key again would then fail with KeyAlreadyExists, so the keychain is asked first.
    const meta = await ctx.tempo.Actions.accessKey
      .getMetadata(ctx.client as any, { account: ctx.address, accessKey: key })
      .catch(() => null);
    if (meta && BigInt(meta.expiry ?? 0) > BigInt(0)) auth.row.landedDespiteError = true;
    else await fallback("authorize", auth.row, (x) => authorizeKey(ctx, "authorizeSequential", key, P5_LIMIT, x));
  }
  out.authorize = auth.row;

  const updArgs = { accessKey: key, token: TEMPO_USDC_E, limit: P5_SET };
  const upd = await attempt("updateLimit", (x) => keychainWrite(ctx, "updateLimitExpiring", "updateLimit", updArgs, x));
  if (!upd.ok && !ctx.dry)
    await fallback("updateLimit", upd.row, (x) =>
      keychainWrite(ctx, "updateLimitSequential", "updateLimit", updArgs, x)
    );
  out.updateLimit = upd.row;
  out.remainingAfterUpdate = usd(await remainingOf(ctx, key, P5_SET));

  // Revoke is a root transaction too, so it is tried the same way.
  const rv = await attempt("revoke", (x) => keychainWrite(ctx, "revokeExpiring", "revoke", { accessKey: key }, x));
  if (!rv.ok && !ctx.dry)
    await fallback("revoke", rv.row, (x) => keychainWrite(ctx, "revokeSequential", "revoke", { accessKey: key }, x));
  out.revoke = rv.row;

  if (ctx.dry) {
    out.answer =
      "dry run: authorize, updateSpendingLimit and revokeKey were built with nonceKey 'expiring'; nothing was sent";
    return;
  }
  const said = (label: string, row: any) =>
    `${label} ${row.nonce === "expiring" ? "accepts" : "refuses"} an expiring nonce${
      row.gas ? ` (gas ${row.gas.gasUsed}, fee ${row.gas.fee})` : ""
    }`;
  out.answer = `${said("authorize", out.authorize)}; ${said("updateSpendingLimit", out.updateLimit)}; ${said(
    "revokeKey",
    out.revoke
  )}`;
}

/**
 * The cap shot: the loop's own key signs an escrow `open` whose deposit
 * is past the key's remaining limit. A direct open rather than a session, so nothing is paid to
 * reach it: an mppx session opens at the gateway's suggested deposit and pays a call before a
 * top-up can ask for more. Sent on an expiring nonce, so it can never take a treasury nonce. The
 * payee is the model gateway's, read off a free 402, so the open is scoped like a loop's channel.
 */
async function caseLoopKey(ctx: Ctx, out: Record<string, any>) {
  const { kf, key } = loadLoopKey(ctx, out, "loop-key");
  // A scoped key's open is still inside its scopes (the escrow's `open` is one of them), so a
  // refusal the shot meets is the limit's and never `CallNotAllowed`.
  if (kf.scopes) out.scopes = kf.scopes;
  if (kf.authorizeTx) out.authorizeTx = `${EXPLORER}${kf.authorizeTx}`;
  if (!ctx.dry) {
    const meta = await ctx.tempo.Actions.accessKey
      .getMetadata(ctx.client as any, { account: ctx.address, accessKey: kf.address })
      .catch((e: any) => ({ error: why(e) }));
    out.keychain = meta;
  }
  const remaining = await remainingOf(ctx, kf.address, BigInt(kf.limitBase));
  const deposit = remaining + LOOP_KEY_OVER;
  out.remainingBefore = usd(remaining);
  out.deposit = usd(deposit);
  const balance = await balanceOf(ctx);
  if (balance !== null && balance < deposit) {
    out.answer =
      `not attempted: the treasury holds ${usd(balance)}, less than the ${usd(deposit)} deposit, so a refusal ` +
      `would show the balance, not the key's limit`;
    return;
  }
  const challenge = ctx.dry
    ? stub(ctx, `the payee: ${STUB_PAYEE}, not read from ${TEMPO_GATEWAY_URL}'s 402`, {
        request: { recipient: STUB_PAYEE, methodDetails: {} },
      })
    : await gatewayChallenge();
  const payee = challenge.request.recipient;
  const operator = challenge.request.methodDetails?.operator ?? ZERO_ADDRESS;
  const salt = toHex(randomBytes(32));
  const args = [payee, operator, TEMPO_USDC_E, deposit, salt, kf.address];
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: "open", args });
  // Read now and again at the fallback: a console may start while the shot is in flight.
  const holderBefore = treasuryHolder();
  const recoveryCommand = (id: string) =>
    `LATH_TRACE_DIR=<the console's> LATH_TEMPO_TREASURY=<key or file> npm run -s tempo:access-key-probe -- --root-treasury --case p4 --channel ${id}`;
  if (ctx.dry) {
    ctx.plan.ifAccepted = holderBefore
      ? `the lock is held (pid ${holderBefore.pid}): no treasury transaction; print ${recoveryCommand("<channelId>")}`
      : "forceClose from the treasury: requestClose, wait out the grace period, withdraw";
    ctx.plan.open = {
      to: TEMPO_ESCROW,
      functionName: "open",
      args,
      data,
      signer: kf.address,
      payer: kf.root,
      nonce: "expiring",
    };
    out.answer = "dry run: the over-limit open was built and signed by nobody; nothing was sent";
    return;
  }
  try {
    const receipt = await ctx.actions.sendTransactionSync(
      ctx.client as any,
      {
        account: key,
        calls: [{ to: TEMPO_ESCROW, data }],
        nonceKey: "expiring",
        throwOnReceiptRevert: true,
      } as any
    );
    ctx.txs.overLimitOpen = receipt.transactionHash;
    out.accepted = true;
    const opened = eventsIn(receipt, ESCROW_ABI, "ChannelOpened")[0]?.args;
    out.opened = opened ?? null;
    const channelId: string = opened?.channelId ?? "<channelId from the ChannelOpened log of overLimitOpen>";
    const holder = treasuryHolder() ?? holderBefore;
    const banner = `!!! TEMPO ACCEPTED AN OPEN PAST THE LOOP KEY'S LIMIT: ${usd(deposit)} against ${usd(
      remaining
    )} remaining (${EXPLORER}${receipt.transactionHash}), channel ${channelId}.`;
    if (holder) {
      // The force-close is root transactions on the sequential nonce, which the running console's
      // own transfers use too (the treasury lock). The deposit is safe in the escrow, whose payer is the
      // treasury, until the close is run by hand.
      const command = recoveryCommand(channelId);
      console.error(
        `\n${banner}\nA console (pid ${holder.pid}) holds the treasury, so nothing was sent from it.` +
          ` Once the console is stopped, run:\n  ${command}\n`
      );
      out.recovery = { channelId, command, notRun: `a console (pid ${holder.pid}) holds the treasury lock` };
      out.answer = `THE CAP DID NOT HOLD: Tempo mined an open of ${usd(deposit)} signed by the loop key with ${usd(
        remaining
      )} remaining; the channel ${channelId} is open, and with the console holding the treasury nothing was sent to close it: stop the console, then run ${command}`;
    } else {
      console.error(`\n${banner} Force-closing it from the treasury now (about 15 min).\n`);
      if (opened?.channelId) out.recovery = await forceClose(ctx, opened.channelId, kf.address, "loopKey");
      out.answer = `THE CAP DID NOT HOLD: Tempo mined an open of ${usd(deposit)} signed by the loop key with ${usd(
        remaining
      )} remaining; ${out.recovery?.answer ?? `close it with ${recoveryCommand(channelId)}`}`;
    }
  } catch (e) {
    out.accepted = false;
    out.refusal = why(e);
    out.remainingAfter = usd(await remainingOf(ctx, kf.address, remaining));
    out.answer = limitShaped(out.refusal)
      ? `the cap held: Tempo refused the loop key's ${usd(deposit)} open against ${usd(
          remaining
        )} remaining with SpendingLimitExceeded`
      : `refused, but not by the limit: ${out.refusal.slice(0, 300)}`;
  }
}

/**
 * The loop's own key file under `LATH_TEMPO_KEY_DIR`, read only, held to this treasury and to its own
 * address, as `loop-key` and `loop-key-scope` both need it. A dry run with no file stands a throwaway
 * key in for it — scoped as a loop's would be when `dryScopes` is passed — and says so in `stubbed`.
 */
function loadLoopKey(ctx: Ctx, out: Record<string, any>, caseName: string, dryScopes?: Scope[]) {
  const loopId = arg(ctx.argv, "--loop") ?? (ctx.dry ? "dry-run-loop" : undefined);
  if (!loopId) throw new Error(`--case ${caseName} needs --loop <loopId>`);
  const dir = process.env.LATH_TEMPO_KEY_DIR || path.join(os.homedir(), ".lath", "tempo-keys");
  const file = path.join(dir, `${loopId}.json`);
  out.loopId = loopId;
  out.keyFile = file;
  let kf: LoopKeyFile;
  if (fs.existsSync(file)) {
    kf = JSON.parse(fs.readFileSync(file, "utf8"));
    if (kf.v !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(kf.privateKey ?? ""))
      throw new Error(`${file} is not a v1 loop key file`);
    if (kf.loopId !== loopId) throw new Error(`${file} names loop ${kf.loopId}, not ${loopId}`);
  } else if (ctx.dry) {
    const pk = generatePrivateKey();
    kf = stub(ctx, `${file} does not exist: a throwaway key stands in for it`, {
      v: 1,
      loopId,
      address: privateKeyToAccount(pk).address,
      privateKey: pk,
      root: ctx.address,
      token: TEMPO_USDC_E,
      limitBase: "5000",
      expiry: ctx.expiry,
      ...(dryScopes ? { scopes: dryScopes } : {}),
      createdAt: Date.now(),
    } as LoopKeyFile);
  } else {
    throw new Error(`${file} does not exist`);
  }
  if (kf.root.toLowerCase() !== ctx.address.toLowerCase()) {
    if (!ctx.dry) throw new Error(`the key in ${file} is rooted on ${kf.root}, not on the treasury ${ctx.address}`);
    stub(ctx, `the key file's root ${kf.root} is not this dry run's throwaway root; not compared`, null);
  }
  const key = ctx.tempo.Account.fromSecp256k1(kf.privateKey, { access: kf.root });
  if (key.accessKeyAddress.toLowerCase() !== kf.address.toLowerCase()) {
    throw new Error(`${file}'s privateKey is the key ${key.accessKeyAddress}, not the ${kf.address} it names`);
  }
  out.key = kf.address;
  out.limitBase = kf.limitBase;
  out.expiry = kf.expiry;
  return { kf, key, file };
}

/**
 * Whether `scopes` allow a call to `to` with `data`, read as the keychain reads them: the target, then
 * the selector when the scope names one, then — when it names recipients — the call's first ABI
 * address argument. Used only to check offline that the case's calls fall where it expects; mainnet
 * is the judge.
 */
function allowedBy(scopes: Scope[], to: string, data: string): boolean {
  const selector = data.slice(0, 10).toLowerCase();
  const firstAddress = `0x${data.slice(34, 74)}`.toLowerCase();
  return scopes.some(
    (s) =>
      s.address.toLowerCase() === to.toLowerCase() &&
      (!s.selector || s.selector.toLowerCase() === selector) &&
      (!s.recipients?.length || s.recipients.some((r) => r.toLowerCase() === firstAddress))
  );
}

/** `getAllowedCalls(root, key)` off the keychain, flattened to the scopes' own shape and compared with them. */
async function allowedCallsOf(ctx: Ctx, label: string, key: string, authorized: Scope[]) {
  const keychain = ctx.tempo.Addresses.accountKeychain as string;
  const abi = ctx.tempo.Abis.accountKeychain as Abi;
  const data = encodeFunctionData({ abi, functionName: "getAllowedCalls", args: [ctx.address, key] });
  if (ctx.dry) {
    ctx.plan[`read ${label}`] = { to: keychain, functionName: "getAllowedCalls", args: [ctx.address, key], data };
    stub(ctx, `${label}: getAllowedCalls is read off the keychain; not read`, null);
    return { read: "not read (dry run)" };
  }
  try {
    const raw = await ctx.rpc("eth_call", [{ to: keychain, data }, "latest"]);
    const [isScoped, targets] = decodeFunctionResult({ abi, functionName: "getAllowedCalls", data: raw }) as any;
    // A target with no selector rules allows any call on it; a rule with no recipients allows any
    // recipient — both are the scope without that field, as `loopKeyScopes` writes it.
    const flat: Scope[] = [];
    for (const t of targets as any[]) {
      const address = String(t.target).toLowerCase();
      if (!t.selectorRules?.length) flat.push({ address });
      for (const r of t.selectorRules ?? []) {
        const recipients = (r.recipients ?? []).map((x: string) => x.toLowerCase()).sort();
        flat.push({
          address,
          selector: String(r.selector).toLowerCase(),
          ...(recipients.length ? { recipients } : {}),
        });
      }
    }
    const key2 = (x: Scope) => `${x.address}|${x.selector ?? ""}|${(x.recipients ?? []).join(",")}`;
    const sorted = (xs: Scope[]) => xs.map(key2).sort();
    return {
      isScoped,
      scopes: flat,
      matchesAuthorized: !!isScoped && JSON.stringify(sorted(flat)) === JSON.stringify(sorted(authorized)),
    };
  } catch (e) {
    return { error: why(e) };
  }
}

/**
 * The storage gateway's payee, off the 402 the same PUT is answered with unpaid. The source of truth
 * is the console's `readStoragePayee` (`frontend/src/app/api/_lib/loop-key.ts`), and this is its filter
 * replicated, not imported: importing `loop-key.ts` installs the console's key-account hook and keyed-close
 * listener at module load, which a probe has no business doing. Kept in step with it by hand:
 *
 * - only `tempo`/`charge` challenges in USDC.e (`TEMPO_USDC_E`) on Tempo's chain (`TEMPO_CHAIN_ID`,
 *   4217) — the gateway offers the same price in three tokens, one of them to another address, and
 *   the first challenge is not necessarily the one `treasuryChargeTransport` pays;
 * - exactly one payee among those, an address, else refused rather than guessed between.
 *
 * And one rule of the probe's own: a matching challenge carrying `methodDetails.splits` or
 * `methodDetails.memo` is refused. Splits add transfers to other recipients, which the scope refuses
 * by design, and a fixed memo replaces the attribution memo a loop's charge carries; either way
 * the PUT would not be the call a loop pays, so it could not settle the scopes.
 */
async function storagePayee(url: string, init: RequestInit): Promise<`0x${string}`> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  // The headers are all that is read; the problem body is let go so the socket is.
  void res.body?.cancel().catch(() => undefined);
  if (res.status !== 402) throw new Error(`${url} answered ${res.status}, not a 402 naming its price`);
  const { Challenge } = await dynamicImport("mppx");
  const challenges: any[] = Challenge.fromResponseList(res);
  const payees = new Set<string>();
  for (const c of challenges) {
    const req = c?.request ?? {};
    const chain = req.methodDetails?.chainId ?? req.chainId;
    if (c?.method !== "tempo" || c?.intent !== "charge") continue;
    if (String(req.currency ?? "").toLowerCase() !== TEMPO_USDC_E.toLowerCase()) continue;
    if (chain !== undefined && chain !== TEMPO_CHAIN_ID) continue;
    if (req.methodDetails?.splits?.length || req.methodDetails?.memo) {
      throw new Error(
        `${url}'s USDC.e challenge carries ${req.methodDetails?.splits?.length ? "splits" : "a fixed memo"}, ` +
          `so its charge is not the one a loop pays`
      );
    }
    if (typeof req.recipient === "string") payees.add(req.recipient.toLowerCase());
  }
  if (payees.size !== 1) {
    throw new Error(
      payees.size === 0
        ? `${url} offered no USDC.e tempo/charge challenge on chain ${TEMPO_CHAIN_ID}`
        : `${url} named ${payees.size} USDC.e payees (${[...payees].join(", ")}), and a key can be scoped to one`
    );
  }
  const [payee] = payees;
  if (!/^0x[0-9a-f]{40}$/.test(payee)) throw new Error(`${url} named ${payee} as its payee, which is not an address`);
  return payee as `0x${string}`;
}

/**
 * The two payments outside a loop key's scopes, both paying the treasury itself 0.0001: a plain
 * `transfer`, a selector no loop key is given, and a `transferWithMemo`, the key's own selector to a
 * recipient it was not given. The treasury as recipient means a Tempo that mines one anyway moves
 * nothing but the fee.
 */
function outOfScopeShots(ctx: Ctx) {
  const tip20 = ctx.tempo.Abis.tip20 as Abi;
  return [
    {
      label: "outOfScopeTransfer",
      why: "transfer: a selector the key was never given",
      data: encodeFunctionData({ abi: tip20, functionName: "transfer", args: [ctx.address, OUT_OF_SCOPE_AMOUNT] }),
    },
    {
      label: "outOfScopeTransferWithMemo",
      why: "transferWithMemo: the key's own selector, to a recipient it was not given",
      data: encodeFunctionData({
        abi: tip20,
        functionName: "transferWithMemo",
        args: [ctx.address, OUT_OF_SCOPE_AMOUNT, ZERO32],
      }),
    },
  ];
}

/**
 * Has `key` sign each shot, each on an expiring nonce so none can take the treasury's sequential one
 * — which is also why `loop-key-scope` may fire them beside a console holding the lock. A refusal
 * at submission is the expected answer; a mined shot, reverted or not, is said loudly.
 */
async function fireShots(ctx: Ctx, key: any, shots: ReturnType<typeof outOfScopeShots>) {
  const results: Record<string, any> = {};
  for (const shot of shots) {
    const row: Record<string, any> = {
      why: shot.why,
      to: TEMPO_USDC_E,
      recipient: ctx.address,
      amount: usd(OUT_OF_SCOPE_AMOUNT),
    };
    results[shot.label] = row;
    if (ctx.dry) {
      ctx.plan[shot.label] = { to: TEMPO_USDC_E, data: shot.data, signer: key.accessKeyAddress, nonce: "expiring" };
      continue;
    }
    try {
      const receipt = await ctx.actions.sendTransactionSync(
        ctx.client as any,
        {
          account: key,
          calls: [{ to: TEMPO_USDC_E, data: shot.data }],
          nonceKey: "expiring",
          throwOnReceiptRevert: true,
        } as any
      );
      ctx.txs[shot.label] = receipt.transactionHash;
      row.mined = true;
      row.status = receipt.status;
      console.error(
        `\n!!! TEMPO MINED A CALL OUTSIDE THE KEY'S SCOPES (${shot.why}): ${EXPLORER}${receipt.transactionHash}. ` +
          `It paid the treasury itself, so only the fee moved, but a leaked loop key could pay anyone.\n`
      );
    } catch (e: any) {
      row.refusal = why(e);
      // A revert is a mined transaction that paid its fee: a different answer from a refusal at
      // submission, so its hash is kept and said.
      const reverted = e?.receipt?.transactionHash ?? e?.cause?.receipt?.transactionHash;
      row.mined = !!reverted;
      if (reverted) ctx.txs[shot.label] = reverted;
      row.callNotAllowed = /CallNotAllowed/i.test(row.refusal);
    }
  }
  return results;
}

/** What the shots came to, as one clause of an answer, and whether Tempo refused both as the scopes say. */
function shotsVerdict(results: Record<string, any>) {
  const rows = Object.values(results);
  const minedAny = rows.some((r) => r.mined);
  const refusedRight = rows.every((r) => !r.mined && r.callNotAllowed);
  const clause = minedAny
    ? "TEMPO MINED A CALL OUTSIDE THE SCOPES (it paid the treasury itself, so only the fee moved)"
    : refusedRight
    ? "both out-of-scope payments were refused with CallNotAllowed, nothing mined"
    : `the out-of-scope payments were refused, but not with CallNotAllowed (${rows
        .map((r) => r.refusal?.slice(0, 120))
        .join(" / ")})`;
  return { minedAny, refusedRight, clause };
}

/**
 * The scope shot, the sibling of `loop-key`'s cap shot: a running
 * loop's own key, read from its file, signs the two out-of-scope payments `scopes` fires, and
 * `getAllowedCalls` is printed beside the scopes the file — and the loop's policy — committed. Only
 * the key signs, on expiring nonces, so like `loop-key` it runs beside a console holding the lock
 * and never sends a treasury transaction.
 */
async function caseLoopKeyScope(ctx: Ctx, out: Record<string, any>) {
  const { kf, key, file } = loadLoopKey(ctx, out, "loop-key-scope", loopKeyScopes(STUB_PAYEE));
  if (!kf.scopes?.length) throw new Error(`this loop's key is unscoped: ${file} carries no scopes`);
  const scopes = kf.scopes as Scope[];
  out.committedScopes = scopes;
  if (kf.authorizeTx) out.authorizeTx = `${EXPLORER}${kf.authorizeTx}`;
  out.allowedCalls = await allowedCallsOf(ctx, "allowedCalls", kf.address, scopes);

  // A shot inside the committed scopes would test nothing — a loop whose storage payee is the
  // treasury, say — so it is refused here, before anything is signed.
  const shots = outOfScopeShots(ctx);
  const inside = shots.filter((s) => allowedBy(scopes, TEMPO_USDC_E, s.data)).map((s) => s.label);
  if (inside.length) throw new Error(`the committed scopes allow ${inside.join(", ")}; nothing to test`);

  // A refusal must be the scopes', not the limit's: the remaining limit is read and said.
  const remaining = await remainingOf(ctx, kf.address, BigInt(kf.limitBase));
  out.remainingBefore = usd(remaining);
  out.shots = await fireShots(ctx, key, shots);
  if (ctx.dry) {
    out.answer =
      "dry run: both out-of-scope payments were built for the loop's key and fall outside its committed scopes; " +
      "nothing was sent";
    return;
  }
  out.remainingAfter = usd(await remainingOf(ctx, kf.address, remaining));
  const verdict = shotsVerdict(out.shots);
  const allowed = out.allowedCalls;
  const readBack = allowed?.matchesAuthorized
    ? "getAllowedCalls reads back the committed scopes"
    : `getAllowedCalls ${
        allowed?.error ? `could not be read (${allowed.error.slice(0, 120)})` : "DIFFERS from the committed scopes"
      }`;
  out.holds = !!allowed?.matchesAuthorized && verdict.refusedRight;
  out.answer = `${
    out.holds ? "the loop key's scopes held" : verdict.minedAny ? "THE LOOP KEY'S SCOPES DID NOT HOLD" : "not settled"
  }: ${readBack}; ${verdict.clause}${
    remaining < OUT_OF_SCOPE_AMOUNT ? `; note the key had only ${usd(remaining)} left, below each shot` : ""
  }`;
}

/**
 * The scopes probe: a key scoped as a loop's is, used for everything a loop uses
 * it for, then for two payments outside its scopes. See the header for what each step settles.
 */
async function caseScopes(ctx: Ctx, out: Record<string, any>) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const objectKey = `lath-probe-key-scopes-${stamp}`;
  const body = `lath access-key probe scopes ${stamp}: a storage PUT paid by a charge a scoped access key signed\n`;
  const url = `${TEMPO_STORAGE_URL}/${objectKey}`;
  const init = { method: "PUT", headers: { "content-type": "text/plain" }, body };

  // The payee off a free 402 of the very PUT the key pays below, so the scope names whoever
  // that call pays.
  const payee = ctx.dry
    ? stub(
        ctx,
        `the storage payee: ${STUB_PAYEE}, not read from ${TEMPO_STORAGE_URL}'s 402`,
        STUB_PAYEE as `0x${string}`
      )
    : await storagePayee(url, init);
  const scopes = loopKeyScopes(payee);
  out.storagePayee = payee;
  out.scopes = scopes;

  const key = newKey(ctx);
  out.key = key.accessKeyAddress;
  out.limit = usd(SCOPES_LIMIT);
  await authorizeKey(ctx, "authorize", key, SCOPES_LIMIT, {}, scopes);
  out.allowedCallsAfterAuthorize = await allowedCallsOf(
    ctx,
    "allowedCallsAfterAuthorize",
    key.accessKeyAddress,
    scopes
  );

  // The calls the case expects in and out of scope, checked offline first: a scope set that does
  // not cover the cap shot or the charge, or that lets either shot through, is a bug here, and the
  // case stops before sending anything.
  const capShotOpen = encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: "open",
    args: [STUB_PAYEE, ZERO_ADDRESS, TEMPO_USDC_E, BigInt(1_000), ZERO32, key.accessKeyAddress],
  });
  const tip20 = ctx.tempo.Abis.tip20 as Abi;
  const charge = encodeFunctionData({
    abi: tip20,
    functionName: "transferWithMemo",
    args: [payee, BigInt(200), ZERO32],
  });
  const shots = outOfScopeShots(ctx);
  out.localScopeCheck = {
    capShotOpen: allowedBy(scopes, TEMPO_ESCROW, capShotOpen),
    storageCharge: allowedBy(scopes, TEMPO_USDC_E, charge),
    ...Object.fromEntries(shots.map((s) => [s.label, allowedBy(scopes, TEMPO_USDC_E, s.data)])),
  };
  const expected = {
    capShotOpen: true,
    storageCharge: true,
    outOfScopeTransfer: false,
    outOfScopeTransferWithMemo: false,
  };
  if (JSON.stringify(out.localScopeCheck) !== JSON.stringify(expected)) {
    throw new Error(`the scopes do not fall as loopKeyScopes says: ${JSON.stringify(out.localScopeCheck)}`);
  }

  // The paid-RPC session: open and close are the escrow's, and its payee needs no recipient rule.
  const sess = await sessionFor(ctx, "session", key, ONE_CALL);
  if (sess) {
    out.call = await sess.call("eth_blockNumber");
    out.channelId = sess.s.channelId ?? null;
    out.close = await closeSession(ctx, "close", sess.s);
  }

  // One storage PUT, signed by the key, pinned to the payee the scopes name.
  const transport = new MppChargeTransport({
    account: key,
    maxCostBase: STORAGE_CALL_CEILING_BASE,
    currency: TEMPO_USDC_E,
    expectedRecipients: [payee],
  });
  out.put = { url, bytes: Buffer.byteLength(body), maxCostBase: STORAGE_CALL_CEILING_BASE };
  if (ctx.dry) {
    ctx.plan.put = { ...out.put, method: "PUT", account: { payer: transport.payer, signer: key.accessKeyAddress } };
    stub(ctx, "put: the charge is priced by the storage gateway's 402 challenge; not fetched", null);
  } else {
    try {
      const res = await transport.fetch(url, init);
      out.put.status = res.status;
      out.put.payment = res.payment ?? null;
      if (res.payment?.reference && /^0x[0-9a-fA-F]{64}$/.test(res.payment.reference)) {
        ctx.txs.charge = res.payment.reference;
      }
    } catch (e: any) {
      out.put.error = why(e);
      out.put.payment = e?.payment ?? null;
    }
  }

  // The two shots, on an expiring nonce so neither can take the treasury's sequential one.
  out.remainingBeforeShots = usd(await remainingOf(ctx, key, SCOPES_LIMIT - BigInt(1_200)));
  const results = await fireShots(ctx, key, shots);
  out.shots = results;
  out.allowedCallsAtEnd = await allowedCallsOf(ctx, "allowedCallsAtEnd", key.accessKeyAddress, scopes);

  if (ctx.dry) {
    out.answer =
      "dry run: the scoped authorization, the session and charge plans and both out-of-scope payments were built, " +
      "and every call falls where loopKeyScopes says; nothing was sent";
    return;
  }
  const allowed = out.allowedCallsAfterAuthorize;
  const sessionPaid = out.call?.status === 200 && Number(out.call?.delta) > 0;
  const putPaid = out.put.status >= 200 && out.put.status < 300 && !!out.put.payment;
  const rows = Object.values(results);
  const minedAny = rows.some((r) => r.mined);
  const refusedRight = rows.every((r) => !r.mined && r.callNotAllowed);
  const parts = [
    allowed?.matchesAuthorized
      ? "getAllowedCalls reads back the scopes authorized"
      : `getAllowedCalls ${
          allowed?.error ? `could not be read (${allowed.error.slice(0, 120)})` : "DIFFERS from the scopes authorized"
        }`,
    sessionPaid
      ? "the paid-RPC session opened, paid and closed through the key"
      : `the session did NOT pay (${out.call?.error ?? `status ${out.call?.status}`})`,
    putPaid
      ? "the storage PUT was paid by the key"
      : `the storage PUT was NOT paid (${out.put.error ?? `status ${out.put.status}`})`,
    minedAny
      ? "TEMPO MINED A CALL OUTSIDE THE SCOPES"
      : refusedRight
      ? "both out-of-scope payments were refused with CallNotAllowed, nothing mined"
      : `the out-of-scope payments were refused, but not with CallNotAllowed (${rows
          .map((r) => r.refusal?.slice(0, 120))
          .join(" / ")})`,
  ];
  const holds = !!allowed?.matchesAuthorized && sessionPaid && putPaid && refusedRight;
  out.holds = holds;
  out.answer = `${
    holds ? "the scopes hold on mainnet" : minedAny ? "THE SCOPES DID NOT HOLD" : "the scopes are not settled"
  }: ${parts.join("; ")}`;
}

/** A `tempo/session` challenge from the model gateway: a bare POST answers 402 with one, unpaid. */
async function gatewayChallenge(): Promise<any> {
  const { Challenge } = await dynamicImport("mppx");
  const res = await fetch(TEMPO_GATEWAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const found =
    res.status === 402
      ? Challenge.fromResponseList(res).find((c: any) => c?.method === "tempo" && c?.intent === "session")
      : undefined;
  if (!found) throw new Error(`${TEMPO_GATEWAY_URL} answered ${res.status} with no tempo/session challenge`);
  return found;
}

/**
 * One `--case`, or in a dry run `--case all`. Live, the treasury lock is checked first and refuses
 * as the default run does, for every case but the key-signed two (see the header); a dry run sends nothing,
 * so it only reports the lock, and it signs with
 * a throwaway key in the treasury's place, so it runs with no treasury configured at all.
 */
async function runCase(argv: string[]): Promise<number> {
  const name = arg(argv, "--case");
  const dry = argv.includes("--dry-run");
  if (!argv.includes("--root-treasury")) {
    console.error("--case runs on the treasury root only; pass --root-treasury");
    return 2;
  }
  if (!name || (!CASES.includes(name as CaseName) && !(dry && name === "all"))) {
    console.error(`--case takes one of ${CASES.join(", ")}${dry ? ", or all with --dry-run" : ""}`);
    return 2;
  }
  for (const f of ["--resume", "--sweep-only", "--only-a", "--keep"]) {
    if (argv.includes(f)) {
      console.error(`${f} belongs to the default run, not to --case`);
      return 2;
    }
  }
  if (argv.includes("--channel") && name !== "p4") {
    console.error("--channel is p4's");
    return 2;
  }
  if (argv.includes("--loop") && !KEY_SIGNED_CASES.includes(name) && name !== "all") {
    console.error(`--loop is ${KEY_SIGNED_CASES.join("'s and ")}'s`);
    return 2;
  }
  // Every case but the key-signed two sends root transactions on the treasury's sequential nonce.
  // loop-key's one expected transaction and loop-key-scope's two are the loop key's on an expiring
  // nonce, and loop-key's fallback checks the lock again itself before it would send anything from
  // the treasury.
  const holder = treasuryHolder();
  if (holder && !dry && !KEY_SIGNED_CASES.includes(name)) {
    console.error(`a console (pid ${holder.pid}) holds the treasury; stop it first`);
    return 2;
  }
  const tempo = await dynamicImport("viem/tempo");
  const actions = await dynamicImport("viem/actions");
  const rootPk = dry ? generatePrivateKey() : treasuryKey();
  const root = tempo.Account.fromSecp256k1(rootPk);
  const client = createClient({
    account: root,
    chain: tempoMainnet.extend({ feeToken: TEMPO_USDC_E }),
    transport: http(TEMPO_RPC_URL),
  });
  const names = name === "all" ? [...CASES] : [name as CaseName];
  const outputs: Record<string, any>[] = [];
  for (const c of names) {
    const ctx: Ctx = {
      dry,
      argv,
      rpc: httpRpc(),
      client,
      root,
      address: root.address,
      tempo,
      actions,
      expiry: Math.floor(Date.now() / 1000) + KEY_TTL_S,
      txs: {},
      stubbed: [],
      plan: {},
    };
    const out: Record<string, any> = {
      case: c,
      probedAt: new Date().toISOString(),
      dryRun: dry,
      treasury: dry ? `${root.address} (a throwaway key in the treasury's place)` : root.address,
      ...(holder
        ? {
            lock: KEY_SIGNED_CASES.includes(c)
              ? `held by pid ${holder.pid}; ${c} runs anyway and sends nothing from the treasury`
              : `held by pid ${holder.pid}; a live run would refuse`,
          }
        : {}),
    };
    const before = await balanceOf(ctx);
    try {
      if (c === "p1") await caseP1(ctx, out);
      else if (c === "p2") await caseP2(ctx, out);
      else if (c === "p3") await caseP3(ctx, out);
      else if (c === "p4") await caseP4(ctx, out);
      else if (c === "p5") await caseP5(ctx, out);
      else if (c === "scopes") await caseScopes(ctx, out);
      else if (c === "loop-key-scope") await caseLoopKeyScope(ctx, out);
      else await caseLoopKey(ctx, out);
    } catch (e) {
      out.error = why(e);
      out.answer = out.answer ?? `stopped: ${out.error.slice(0, 300)}`;
    }
    const after = await balanceOf(ctx).catch(() => null);
    out.treasuryBalance =
      before === null
        ? "not read (dry run)"
        : {
            before: usd(before),
            after: after === null ? null : usd(after),
            delta: after === null ? null : usd(after - before),
          };
    out.txs = Object.fromEntries(Object.entries(ctx.txs).map(([k, h]) => [k, `${EXPLORER}${h}`]));
    if (dry) {
      out.plan = ctx.plan;
      out.stubbed = ctx.stubbed;
    }
    outputs.push(out);
    if (out.error && !dry) break;
  }
  const json = JSON.stringify(
    outputs.length === 1 ? outputs[0] : { dryRun: dry, cases: outputs },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2
  );
  const at = argv.indexOf("--out");
  if (at >= 0 && argv[at + 1]) fs.writeFileSync(argv[at + 1], json);
  console.log(json);
  return outputs.some((o) => o.error) ? 1 : 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // The cases are their own run: the default run's funding, root file and sweep play no part in them.
  if (argv.includes("--case") || argv.includes("--dry-run")) {
    if (!argv.includes("--case")) {
      console.error("--dry-run builds the --case probes; the default run has no dry run");
      return 2;
    }
    return runCase(argv);
  }
  const lock = readTreasuryLock();
  if (lock && Date.now() - lock.heartbeatAt < 30_000) {
    console.error(`a console (pid ${lock.pid}) holds the treasury; stop it first`);
    return 2;
  }
  const rpc = httpRpc();
  const treasury = treasuryAccount();
  const sweepOnly = argv.includes("--sweep-only");
  const onTreasury = argv.includes("--root-treasury");
  if (onTreasury && (sweepOnly || argv.includes("--resume"))) {
    console.error("--root-treasury has no root file to resume or sweep");
    return 2;
  }
  if (sweepOnly && !fs.existsSync(ROOT_KEY_FILE)) {
    console.error(`--sweep-only needs ${ROOT_KEY_FILE}, which does not exist`);
    return 2;
  }
  const { Account, Actions } = await dynamicImport("viem/tempo");
  const rootPk = onTreasury ? treasuryKey() : rootKey(argv.includes("--resume") || sweepOnly);
  const rootSigner = privateKeyToAccount(rootPk);
  const root = Account.fromSecp256k1(rootPk);
  const client = createClient({
    account: root,
    chain: tempoMainnet.extend({ feeToken: TEMPO_USDC_E }),
    transport: http(TEMPO_RPC_URL),
  });
  // `client` goes to viem's Tempo actions as `any`: under this tree's `strict: false` their
  // parameter types collapse to `never`, the same reason the SDK calls `client.request`.
  const reader = new TempoRpcReader();
  const txs: Record<string, string> = {};
  const result: Record<string, any> = {
    probedAt: new Date().toISOString(),
    treasury: treasury.address,
    root: root.address,
    rootKeyFile: onTreasury ? null : ROOT_KEY_FILE,
  };

  // Sweep the root back to the treasury, less the gas the transfer itself pays. The fee is in
  // USDC.e base units (`gasFeeBase`): the first run compared the wei product, twelve decimals too
  // many, against the balance, found the fee always larger and skipped the sweep without a word.
  const sweep = async () => {
    const left = await usdcBalance(rpc, root.address);
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) as string);
    const gas = await estimateTransferGas(rpc, root.address, treasury.address, left);
    const fee = gasFeeBase(gas, gasPrice);
    result.sweep = { left: usd(left), fee: usd(fee) };
    if (left > fee) {
      txs.sweep = await transferUsdc(rpc, rootSigner, treasury.address, left - fee, { gas, gasPrice });
    }
    result.rootLeft = usd(await usdcBalance(rpc, root.address));
  };
  const print = () => {
    result.txs = Object.fromEntries(Object.entries(txs).map(([k, h]) => [k, `${EXPLORER}${h}`]));
    const json = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    const at = argv.indexOf("--out");
    if (at >= 0 && argv[at + 1]) fs.writeFileSync(argv[at + 1], json);
    console.log(json);
  };
  if (sweepOnly) {
    await sweep();
    print();
    return 0;
  }

  // Funding: only up to FUNDING, so a resumed run does not fund twice. A treasury root pays from
  // its own balance.
  const had = await usdcBalance(rpc, root.address);
  if (!onTreasury && had < FUNDING) {
    txs.fund = await transferUsdc(rpc, treasury, root.address, FUNDING - had);
  }
  result[onTreasury ? "rootBalance" : "rootFunded"] = usd(await usdcBalance(rpc, root.address));
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const remaining = async (key: any) =>
    (
      await Actions.accessKey.getRemainingLimit(client as any, {
        account: root.address,
        accessKey: key,
        token: TEMPO_USDC_E,
      })
    ).remaining as bigint;

  // Case A: a limit below the deposit the session asks for. The open is inside it (0.001); the
  // second call's top-up to 0.01 is not, and must fail if Tempo enforces the cap on escrow pulls.
  const keyA = Account.fromSecp256k1(generatePrivateKey(), { access: root });
  const authA = await Actions.accessKey.authorizeSync(
    client as any,
    {
      accessKey: keyA,
      expiry,
      limits: [{ token: TEMPO_USDC_E, limit: LIMIT_A }],
    } as any
  );
  txs.authorizeA = authA.receipt.transactionHash;
  const a = await session(keyA, DEPOSIT);
  const aFirst = await a.call("eth_blockNumber");
  const remainingAfterOpenA = usd(await remaining(keyA));
  const aSecond = await a.call("eth_chainId");
  result.caseA = {
    key: keyA.accessKeyAddress,
    limit: usd(LIMIT_A),
    maxDeposit: DEPOSIT,
    calls: [aFirst, aSecond],
    opened: !!a.s.opened,
    channelId: a.s.channelId ?? null,
    remainingAfterOpen: remainingAfterOpenA,
    remainingAfter: usd(await remaining(keyA)),
  };
  if (a.s.channelId) {
    const st = await reader.channelState(a.s.channelId).catch(() => null);
    result.caseA.channelBeforeClose = st ? { deposit: usd(st.deposit), settled: usd(st.settled) } : null;
  }
  if (a.s.opened) {
    // Closed whatever happened to the top-up, so no deposit is stranded.
    try {
      const r = await a.s.close();
      result.caseA.close = { txHash: r?.txHash, spent: r?.spent !== undefined ? usd(BigInt(r.spent)) : null };
      if (r?.txHash) txs.closeA = r.txHash;
    } catch (e) {
      result.caseA.close = { error: short(e) };
    }
  }

  // Case B: a limit equal to the deposit. The session must open, pay and close.
  const onlyA = argv.includes("--only-a");
  const caseB: Record<string, any> = {};
  if (!onlyA) {
    const keyB = Account.fromSecp256k1(generatePrivateKey(), { access: root });
    const authB = await Actions.accessKey.authorizeSync(
      client as any,
      {
        accessKey: keyB,
        expiry,
        limits: [{ token: TEMPO_USDC_E, limit: LIMIT_B }],
      } as any
    );
    txs.authorizeB = authB.receipt.transactionHash;
    const rootBeforeB = await usdcBalance(rpc, root.address);
    const b = await session(keyB, DEPOSIT);
    const bCalls = [await b.call("eth_blockNumber"), await b.call("eth_chainId")];
    Object.assign(caseB, {
      key: keyB.accessKeyAddress,
      limit: usd(LIMIT_B),
      deposit: DEPOSIT,
      calls: bCalls,
      opened: !!b.s.opened,
      channelId: b.s.channelId ?? null,
      remainingAfterOpen: usd(await remaining(keyB)),
    });
    if (b.s.channelId) {
      const st = await reader.channelState(b.s.channelId).catch(() => null);
      caseB.channelBeforeClose = st ? { deposit: usd(st.deposit), settled: usd(st.settled) } : null;
    }
    if (b.s.opened) {
      try {
        const r = await b.s.close();
        caseB.close = { txHash: r?.txHash, spent: r?.spent !== undefined ? usd(BigInt(r.spent)) : null };
        if (r?.txHash) txs.closeB = r.txHash;
      } catch (e) {
        caseB.close = { error: short(e) };
      }
    }
    caseB.rootDelta = usd((await usdcBalance(rpc, root.address)) - rootBeforeB);
  }
  result.caseB = onlyA ? "not run (--only-a)" : caseB;

  // The verdict, in the terms ROADMAP.md item 11 asks for.
  // The cap held if the deposit never passed the limit and the call that needed it failed with a
  // limit-shaped error; it did not if the escrow ended up holding more than the key may spend.
  const capError = /limit|spend|exceed|insufficient/i.test(aSecond.error ?? "");
  const aDeposit = Number(result.caseA.channelBeforeClose?.deposit ?? NaN);
  const overLimit = aDeposit > Number(usd(LIMIT_A));
  const paid = onlyA ? 0 : caseB.calls.filter((c: any) => c.status === 200 && Number(c.delta) > 0).length;
  result.verdict = {
    tempoEnforcesCapOnTopUp: overLimit ? "no" : aSecond.error && capError ? "yes" : "unclear",
    accessKeySessionWorks: onlyA ? "not run" : caseB.opened && paid === 2 && !!caseB.close?.txHash ? "yes" : "no",
    remainingAfterOpenIsZero: onlyA ? "not run" : caseB.remainingAfterOpen === "0",
    note: "unclear = the top-up neither passed the limit nor failed with a limit-shaped error; read caseA.calls[1].error",
  };

  // A treasury root has nowhere to sweep to.
  if (!onTreasury && !argv.includes("--keep")) await sweep();
  print();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    // A case keeps no root file; its keys are in memory and expire within the hour.
    if (!process.argv.includes("--case")) {
      console.error(`the root key, and any funds it holds, are in ${ROOT_KEY_FILE}; rerun with --resume`);
    }
    process.exit(1);
  }
);
