/**
 * Per-loop Tempo access keys.
 *
 * Each loop signs its owner-paid Tempo payments with its own access key, authorized on the
 * operator's treasury with a USDC.e limit sized from the loop's budget, so Tempo itself refuses any
 * deposit past that limit whatever the console does. The channel's `payer` stays the treasury and
 * its `authorizedSigner` is the key (`Account.fromSecp256k1(pk, { access: root })`).
 *
 * Behind `LATH_TEMPO_LOOP_KEYS` (default off). With it off no **new** key is made: no loop started
 * then has a `tempoKey` in its policy, and every such hash is as it was. A loop started while it was
 * on keeps its key after it is turned off, until the loop is stopped, which revokes it.
 *
 * Where a key can outlive its loop, and what removes it: a crash after the authorize mines but
 * before its hash is written back leaves a file without `authorizeTx` whose key is live; a revoke
 * that failed leaves its file for the backoff retry and the start-up sweep (`sweepLoopKeys` in
 * `_lib/loop-key.ts`), which revokes the keys of this console's own stopped loops. A file with no loop
 * row — the crash case — is never swept at start: the key directory can be shared by consoles with
 * different trace directories, and a row-less file here may be another console's live loop. The
 * operator revokes it by the address in the file (SECURITY.md §8); `sweepLoopKeys({ orphans: true })`
 * does the same from code and has no entry point yet. An authorize whose outcome is unknown deletes
 * the file, so a key it may have authorized has no private key anywhere and can sign nothing; its
 * address is logged so the treasury can still revoke it by hand.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decodeAbiParameters, keccak256, pad, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
// Only these from the console's own modules: the treasury (the root every key is authorized on),
// its in-process ordering and cross-process lock, and the directory `/api/traces` serves. Nothing
// from `runner.ts`'s key derivation — a loop key is random (`generatePrivateKey()`), because no new
// role derives from the server seed, and `tests/tempo-keys.ts` asserts it.
import type { TempoKeyScope } from "@lath/runtime";
import { TRACE_DIR } from "./runner";
import { syncDirSync, writeFlushedSync } from "./json-store";
import {
  TEMPO_ESCROW,
  TEMPO_RPC_URL,
  TEMPO_USDC_E,
  claimTreasury,
  httpRpc,
  treasuryAccount,
  withTreasury,
  type JsonRpc,
} from "./tempo";

/** A loop's access key, as the console holds it. `file` is never stored in a row the API serves. */
export interface LoopKey {
  loopId: string;
  /** The key's own address: the channel's `authorizedSigner` and the `signer` on every record. */
  address: `0x${string}`;
  /** The TIP-20 token the limit is in: USDC.e (`TEMPO_USDC_E`). */
  token: `0x${string}`;
  /** The limit authorized at start, raw USDC.e base units as a decimal string. */
  limitBase: string;
  /** Unix seconds after which Tempo refuses the key: 30 days from authorization. */
  expiry: number;
  /** The treasury transaction that authorized the key; absent until `authorizeLoopKey` returns. */
  authorizeTx?: `0x${string}`;
  /** The calls the key may make; absent for an unscoped key. */
  scopes?: TempoKeyScope[];
  /** Where the private key lives. Console-only. */
  file: string;
}

/** What `loops.json` carries for a loop with a key (`LoopRecord.tempoKey`): everything but the file. */
export type LoopTempoKey = Omit<LoopKey, "file">;

/**
 * The key file, mode 0600, at `loopKeyFilePath(loopId)`. Written before the authorize transaction
 * is sent, so no authorized key exists whose private key was never on disk. A crash before the
 * authorize mines leaves a file whose key holds nothing; a crash after it mines but before
 * `authorizeTx` is written back leaves a file without `authorizeTx` whose key **is** live — revoked
 * by hand by the address in the file (SECURITY.md §8), which is why the file is kept rather than
 * cleaned up as a leftover. `scripts/tempo-access-key-probe.ts --case loop-key` reads it.
 */
export interface LoopKeyFile {
  v: 1;
  loopId: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  /** The root the key is authorized on: the treasury's address. */
  root: `0x${string}`;
  token: `0x${string}`;
  limitBase: string;
  expiry: number;
  authorizeTx?: `0x${string}`;
  /** The call scopes authorized with the key; absent for an unscoped key. */
  scopes?: TempoKeyScope[];
  /** Unix ms. */
  createdAt: number;
}

/**
 * One channel of a loop, as `reconcileLoopKeyLimit` reads it: what the channel deposited and, once
 * closed, what it settled. `_lib/loop-key.ts` assembles these from the loop's ledger rows and its
 * registry row.
 */
export interface LoopKeyChannelRow {
  channelId: string;
  /** Total deposited into the channel (open plus every top-up), base units. */
  deposit: string;
  /** What the close paid the payee, base units; only meaningful when `closed`. */
  settled?: string;
  closed: boolean;
}

/** What Tempo says about a key now. `null` from `loopKeyState` when Tempo did not answer. */
export interface LoopKeyState {
  /** `getRemainingLimit` for the key's token, base units. */
  remaining: string;
  expiry: number;
  isRevoked: boolean;
}

/** `LATH_TEMPO_LOOP_KEYS`: on for `1`, `on`, `true` or `yes`; anything else, or unset, is off. */
export function loopKeysEnabled(): boolean {
  return /^(1|on|true|yes)$/i.test((process.env.LATH_TEMPO_LOOP_KEYS ?? "").trim());
}

/**
 * Whether a loop key is scoped to its own calls: on with the keys unless `LATH_TEMPO_KEY_SCOPES` is
 * `0|off|false|no` — the escape hatch until the `--case scopes` probe has passed on mainnet.
 */
export function loopKeyScopesEnabled(): boolean {
  return loopKeysEnabled() && !/^(0|off|false|no)$/i.test((process.env.LATH_TEMPO_KEY_SCOPES ?? "").trim());
}

// ─── Call scopes ────────────────────────────────────────────────────────────
//
// The three calls a loop key makes, as 4-byte selectors. Literals rather than `viem/tempo`'s
// `Selectors`, because that module is only reachable through `import()` here (see `dynamicImport`
// below) and `loopKeyScopes` is called synchronously at a loop's start. `tests/tempo-keys.ts` holds
// each literal to the installed sources, so a dependency bump that moves one fails there, not on
// mainnet with `CallNotAllowed`.

/**
 * The TIP-1034 escrow's `open(address,address,address,uint96,bytes32,address)`: what mppx's
 * `createOpenPayload` encodes from `escrowAbi` (`mppx/dist/tempo/session/precompile/escrow.abi.js`,
 * `session/client/ChannelOps.js:142`), and viem's `Selectors.tip20ChannelReserve.open` for the
 * same address. Also the call the `loop-key` probe's cap shot makes directly.
 */
export const ESCROW_OPEN_SELECTOR = "0xedc53b00";
/**
 * The escrow's `topUp((address,address,address,address,bytes32,address,bytes32),uint96)`: mppx's
 * `createTopUpPayload` (`ChannelOps.js:203`), viem's `Selectors.tip20ChannelReserve.topUp`.
 */
export const ESCROW_TOP_UP_SELECTOR = "0xdc48471e";
/**
 * TIP-20 `transferWithMemo(address,uint256,bytes32)`: mppx's charge builds each transfer with
 * `Actions.token.transfer.call(…, { memo })` (`mppx/dist/tempo/client/Charge.js`), which viem encodes
 * as `transferWithMemo` whenever a memo is given and no `from` (`viem/tempo/actions/token.ts`), and
 * the charge always gives one — the challenge's or the MPP attribution memo. `Selectors.tip20`.
 */
export const TIP20_TRANSFER_WITH_MEMO_SELECTOR = "0x95777d59";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR = /^0x[0-9a-fA-F]{8}$/;

/**
 * Scopes as the file, the authorize and the policy all carry them: addresses and selectors
 * lower-case, sorted by address then selector, each `recipients` sorted. Lower-case is not
 * cosmetic: `ox` groups scopes into the keychain's `allowedCalls` by the address **string**, so one
 * contract spelled two ways would be authorized as two targets. A malformed entry, or an empty list
 * — whose meaning (nothing allowed, or everything) is the keychain's to decide and not one to guess
 * — is refused before anything is written or sent.
 */
function normaliseScopes(scopes: readonly TempoKeyScope[]): TempoKeyScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("a scoped loop key needs at least one scope; pass none for an unscoped key");
  }
  const out = scopes.map((s, i) => {
    if (!s || typeof s.address !== "string" || !ADDRESS.test(s.address)) {
      throw new Error(`scope ${i} has no contract address: ${JSON.stringify(s)}`);
    }
    if (s.selector !== undefined && (typeof s.selector !== "string" || !SELECTOR.test(s.selector))) {
      throw new Error(`scope ${i}'s selector is not 4 bytes of hex: ${JSON.stringify(s.selector)}`);
    }
    if (s.recipients !== undefined) {
      if (
        !Array.isArray(s.recipients) ||
        s.recipients.some((r: unknown) => typeof r !== "string" || !ADDRESS.test(r))
      ) {
        throw new Error(`scope ${i}'s recipients are not all addresses: ${JSON.stringify(s.recipients)}`);
      }
      // An empty list reads as "pays no one" but the keychain reads it as "pays anyone" (`ox`
      // `KeyAuthorization.Scope`): the scope without `recipients` says that honestly.
      if (s.recipients.length === 0) throw new Error(`scope ${i} has an empty recipients list, which allows anyone`);
      // Recipients bind only to a selector: on a whole-contract scope `ox` drops them, so the key
      // would be authorized wider than the scope reads.
      if (s.selector === undefined) throw new Error(`scope ${i} names recipients without a selector`);
    }
    const scope: TempoKeyScope = { address: s.address.toLowerCase() };
    if (s.selector !== undefined) scope.selector = s.selector.toLowerCase();
    if (s.recipients !== undefined) scope.recipients = s.recipients.map((r: string) => r.toLowerCase()).sort();
    return scope;
  });
  const order = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => order(a.address, b.address) || order(a.selector, b.selector));
}

/**
 * The scopes of a loop key: the escrow's `open` and `topUp`, and USDC.e `transferWithMemo` to
 * `storagePayee` only. Sorted as `policyDocument` writes them.
 *
 * Exactly what mppx and the console sign with the key, and nothing else. No `approve`: the escrow
 * pulls the deposit itself, and mppx adds prefix calls to an open or a top-up only for `autoSwap`,
 * which nothing in Lath passes. No close: a cooperative close is a voucher the gateway submits, and
 * `requestClose`/`withdraw` are the treasury's own. The paid-RPC and model gateways' payees
 * need no recipient rule because the key only ever calls the escrow for them; the storage gateway is
 * paid by a direct transfer, so its payee is the one recipient the key may name. A gateway that later
 * pays to another address — or splits a charge, whose extra transfers name other recipients — fails
 * with `CallNotAllowed`: closed, as an unpaid storage call is.
 */
export function loopKeyScopes(storagePayee: `0x${string}`): TempoKeyScope[] {
  // A zero payee is a challenge read wrong, not a gateway; scoping the key to it would starve every
  // storage call without saying why.
  if (typeof storagePayee !== "string" || !ADDRESS.test(storagePayee) || /^0x0{40}$/.test(storagePayee)) {
    throw new Error(`the storage payee is not an address: ${JSON.stringify(storagePayee)}`);
  }
  return normaliseScopes([
    { address: TEMPO_ESCROW, selector: ESCROW_OPEN_SELECTOR },
    { address: TEMPO_ESCROW, selector: ESCROW_TOP_UP_SELECTOR },
    { address: TEMPO_USDC_E, selector: TIP20_TRANSFER_WITH_MEMO_SELECTOR, recipients: [storagePayee] },
  ]);
}

/** `LATH_TEMPO_KEY_DIR`, default `~/.lath/tempo-keys`. Never under `LATH_TRACE_DIR`, which `/api/traces` serves. */
export function loopKeyDir(): string {
  return process.env.LATH_TEMPO_KEY_DIR || path.join(os.homedir(), ".lath", "tempo-keys");
}

/** The key file of one loop. Loop ids are `loop-<16 hex>`, one flat path segment. */
export function loopKeyFilePath(loopId: string): string {
  return path.join(loopKeyDir(), `${loopId}.json`);
}

// ─── What Tempo is asked to do, and the seam a test replaces ────────────────

/**
 * The four things this module asks of Tempo. `realChain` is the only implementation that ships;
 * `setTempoKeyChainForTests` swaps it, so a suite exercises the file handling, the lock, the
 * formula and the failure paths without a network. Addresses only: no private key crosses it —
 * the keychain identifies a secp256k1 key by its address, so authorizing needs no signature from
 * the key itself, only the root's.
 */
export interface TempoKeyChain {
  /** Authorizes `key` on `root`'s keychain and waits for the receipt. Throws with Tempo's reason. */
  authorize(o: {
    root: `0x${string}`;
    key: `0x${string}`;
    token: `0x${string}`;
    limit: bigint;
    expiry: number;
    /** The key's call scopes, as its file holds them; absent for an unscoped key, and then not sent. */
    scopes?: TempoKeyScope[];
  }): Promise<{ txHash?: `0x${string}`; status: "success" | "reverted" | "pending" }>;
  /** `updateSpendingLimit(key, token, limit)`, mined. The tx hash. Throws with Tempo's reason. */
  updateLimit(o: {
    root: `0x${string}`;
    key: `0x${string}`;
    token: `0x${string}`;
    limit: bigint;
  }): Promise<`0x${string}`>;
  /** `revokeKey(key)`, mined. The tx hash. Throws with Tempo's reason. */
  revoke(o: { root: `0x${string}`; key: `0x${string}` }): Promise<`0x${string}`>;
  /**
   * The key as the keychain reports it. `total` — the limit in force, of which `remaining` is what
   * is left — is read only when `wantTotal` is passed, because only `LIMIT_UPDATE_SETS = "total"`
   * needs it.
   */
  readState(o: {
    root: `0x${string}`;
    key: `0x${string}`;
    token: `0x${string}`;
    wantTotal?: { limitBase: string; authorizeTx?: `0x${string}` };
  }): Promise<{ remaining: bigint; expiry: number; isRevoked: boolean; total?: bigint }>;
}

/** What a suite may replace: any of the chain's calls, the treasury, and the update semantics. */
export interface TempoKeyTestHooks extends Partial<TempoKeyChain> {
  /** The root in place of `treasuryAccount()`, whose `LATH_TEMPO_TREASURY` read is cached per process. */
  treasury?: PrivateKeyAccount;
  /** `LIMIT_UPDATE_SETS` for this suite, so both branches run through `reconcileLoopKeyLimit`. */
  limitUpdateSets?: LimitUpdateSemantics;
}

let hooks: TempoKeyTestHooks | null = null;

/**
 * Test seam: every call this module would send to Tempo goes to `h` instead (a call `h` leaves out
 * rejects rather than reaching the network); `null` restores the real chain. Also drops the account
 * cache, since a cached account was built against the previous treasury.
 */
export function setTempoKeyChainForTests(h: TempoKeyTestHooks | null): void {
  hooks = h;
  accounts.clear();
}

function chain(): TempoKeyChain {
  const h = hooks;
  if (!h) return realChain;
  const missing = (name: string) => () => Promise.reject(new Error(`tempo-keys test hooks: no ${name}`));
  return {
    authorize: h.authorize ?? missing("authorize"),
    updateLimit: h.updateLimit ?? missing("updateLimit"),
    revoke: h.revoke ?? missing("revoke"),
    readState: h.readState ?? missing("readState"),
  };
}

function root(): PrivateKeyAccount {
  return hooks?.treasury ?? treasuryAccount();
}

// ─── The limit update's semantics ───────────────────────────────────────────

export type LimitUpdateSemantics = "remaining" | "total";

/**
 * What `updateSpendingLimit(key, token, newLimit)` sets: the amount the key may **still** spend
 * (`"remaining"`), or the total of which what it already spent is a part (`"total"`). A mainnet
 * probe settles it — open at 0.001, close, update to a chosen value, read `getRemainingLimit` and
 * the `SpendingLimitUpdated` event — and this constant is the one line the answer changes. Until
 * then it is `"remaining"`, and `reconcileLoopKeyLimit` rechecks the key after every update: a
 * remaining limit above the formula's target is thrown, not tolerated.
 */
export const LIMIT_UPDATE_SETS: LimitUpdateSemantics = "remaining";

/**
 * The `newLimit` to send so that the key may still spend exactly `target`, given what the keychain
 * says now. Pure, so both readings are pinned by a test whichever one mainnet confirms.
 *
 * - `"remaining"`: `target` itself.
 * - `"total"`: what the key has already spent, plus `target`. The keychain exposes no spent counter
 *   (`getKey` has none, nor viem 2.56's `getMetadata`), so it is `total − remaining`, where `total`
 *   is the limit in force: the newest `SpendingLimitUpdated.newLimit` since the authorize, or
 *   `limitBase` when there was none (`KeyAuthorized` carries no limits). The probe must confirm, for
 *   this reading, that `remaining` is `total − Σ AccessKeySpend` and that a refund does not move it.
 *
 * Either way the effect of the value returned is `remaining = target`, never more.
 */
export function limitUpdateValue(
  target: bigint,
  state: { remaining: bigint; total?: bigint },
  semantics: LimitUpdateSemantics = LIMIT_UPDATE_SETS
): bigint {
  if (target < BigInt(0)) throw new Error(`a limit target cannot be negative (${target})`);
  if (semantics === "remaining") return target;
  if (state.total === undefined) {
    throw new Error("the key's limit in force is unknown, and a total-limit update cannot be sized without it");
  }
  // A remaining above the total is a reading this formula cannot explain; anything sized from it
  // could hand the key more than the target, so it is refused.
  if (state.total < state.remaining) {
    throw new Error(`the keychain reports ${state.remaining} remaining of a ${state.total} limit; refusing to update`);
  }
  return state.total - state.remaining + target;
}

// ─── The formula ─────────────────────────────────────────────────────────────

function baseUnits(v: string, what: string): bigint {
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    throw new Error(`${what} is not a base-unit integer: ${JSON.stringify(v)}`);
  }
  return BigInt(v);
}

/**
 * What the key may still deposit: `max(0, limitBase − Σ settled(closed) − Σ deposit(open))`.
 *
 * Generic over what a row is: `_lib/loop-key.ts` also passes each owner storage charge the key
 * signed as a closed row with `deposit = settled = amount`, so a charge is counted once and never
 * restored. A closed row without `settled` counts its whole deposit — not knowing what a close paid
 * is read as the close having paid everything, the direction that can only leave the key less,
 * never more.
 */
export function loopKeyLimitTarget(limitBase: string, rows: readonly LoopKeyChannelRow[]): bigint {
  let used = BigInt(0);
  for (const r of rows) {
    const deposit = baseUnits(r.deposit, `channel ${r.channelId}'s deposit`);
    used += r.closed && r.settled !== undefined ? baseUnits(r.settled, `channel ${r.channelId}'s settled`) : deposit;
  }
  const left = baseUnits(limitBase, "limitBase") - used;
  return left > BigInt(0) ? left : BigInt(0);
}

// ─── Root transactions: one nonce rule, one place ───────────────────────────

/**
 * How the treasury's root transactions (authorize, limit update, revoke) take their nonce.
 * Sequential until a mainnet probe shows `authorizeSync` / `updateLimitSync` accept
 * `nonceKey: 'expiring'`: the sequential nonce is the one `transferUsdc` also signs with, so every
 * such transaction queues behind `withTreasury`, or two could be signed with one nonce and one of
 * them would never mine.
 */
const ROOT_NONCE = "sequential" as "sequential" | "expiring";

/** What the viem action is passed for the nonce: nothing (sequential; viem reads it) or the expiring key. */
function rootNonceOptions(): Record<string, unknown> {
  return ROOT_NONCE === "expiring" ? { nonceKey: "expiring" } : {};
}

const perLoop = new Map<string, Promise<unknown>>();

/**
 * Runs a root transaction under the treasury's lock. Sequential: inside `withTreasury`, the queue
 * every channel open and close is in, after claiming the cross-process lock (a second console on
 * the treasury is refused here as it is at an open). Expiring: no nonce is shared, so only one
 * loop's own transactions are serialised. Never call this — or anything in this module that sends —
 * from inside a `withTreasury` body: the queue is one chain of promises, and it would wait on
 * itself.
 */
function rootTx<T>(loopId: string, fn: () => Promise<T>): Promise<T> {
  const body = async () => {
    claimTreasury();
    return fn();
  };
  if (ROOT_NONCE === "sequential") return withTreasury(body);
  const next = (perLoop.get(loopId) ?? Promise.resolve()).then(body, body);
  perLoop.set(
    loopId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

/** Tempo's reason, as a person reads it: viem's short message and the node's details when they differ. */
function tempoReason(e: any): string {
  const short = e?.shortMessage ? String(e.shortMessage) : "";
  const details = e?.details ? String(e.details) : "";
  const text = short && details && !short.includes(details) ? `${short} (${details})` : short || details;
  return (text || String(e?.message ?? e)).slice(0, 500);
}

// ─── The key file ────────────────────────────────────────────────────────────

/** Loop ids are `loop-<16 hex>`; anything with a separator or a dot could name a file elsewhere. */
const LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function checkLoopId(loopId: string): void {
  if (typeof loopId !== "string" || !LOOP_ID.test(loopId)) throw new Error(`not a loop id: ${JSON.stringify(loopId)}`);
}

/** The real path of `p`, or of its deepest existing ancestor with the rest appended, for a directory not made yet. */
function realish(p: string): string {
  const abs = path.resolve(p);
  try {
    // `.native` is the OS's realpath(3), which on macOS also returns each existing component in
    // its on-disk case; the JS implementation hands back the case it was given.
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realish(parent), path.basename(abs));
  }
}

/**
 * Whether paths that differ only in case name one file. True on the platforms whose default file
 * system folds case (APFS and HFS+ as macOS formats them, NTFS): there `/tmp/TRACES/keys` is inside
 * `/tmp/traces`, and a guard comparing bytes would let a key directory in under another spelling.
 * A case-sensitive volume mounted on such a host is then over-refused, the safe direction.
 */
const CASE_FOLDS = process.platform === "darwin" || process.platform === "win32";

function within(child: string, parent: string): boolean {
  const fold = (p: string) => (CASE_FOLDS ? p.toLowerCase() : p);
  const rel = path.relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Refuses a key directory at or under the trace directory: `/api/traces` serves that tree, so a key
 * file there would be one URL away from anyone. Compared by real path, so a symlink into it is
 * caught too, and case-insensitively where the file system folds case. Both the directory
 * `runner.ts` captured at load and the variable as it is now are checked, so a process whose
 * environment changed after load is held to either.
 */
function assertKeyDirAllowed(dir: string): void {
  const real = realish(dir);
  const traceDirs = [TRACE_DIR, process.env.LATH_TRACE_DIR].filter((d): d is string => !!d);
  for (const t of traceDirs) {
    if (within(real, realish(t))) {
      throw new Error(
        `LATH_TEMPO_KEY_DIR (${dir}) is inside LATH_TRACE_DIR (${t}); a loop's key must never be in the store /api/traces serves`
      );
    }
  }
}

function readKeyFile(loopId: string): LoopKeyFile | null {
  checkLoopId(loopId);
  let raw: string;
  try {
    raw = fs.readFileSync(loopKeyFilePath(loopId), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  const file = JSON.parse(raw) as LoopKeyFile;
  if (file?.v !== 1 || file.loopId !== loopId || !/^0x[0-9a-fA-F]{64}$/.test(file.privateKey ?? "")) {
    throw new Error(`${loopKeyFilePath(loopId)} is not a loop key file for ${loopId}`);
  }
  return file;
}

/** Rewrites a key file: a fresh 0600 file beside it, renamed over it, so a crash never leaves half a key. */
function rewriteKeyFile(file: LoopKeyFile): void {
  const target = loopKeyFilePath(file.loopId);
  const tmp = `${target}.${process.pid}.tmp`;
  // Flushed before the rename and the directory after it (`writeJsonAtomic`): a key file a power
  // loss empties is a key nothing can sign a close with.
  writeFlushedSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
  syncDirSync(path.dirname(target));
}

function keyOf(file: LoopKeyFile): LoopKey {
  return {
    loopId: file.loopId,
    address: file.address,
    token: file.token,
    limitBase: file.limitBase,
    expiry: file.expiry,
    ...(file.authorizeTx ? { authorizeTx: file.authorizeTx } : {}),
    ...(file.scopes ? { scopes: file.scopes.map((s) => ({ ...s })) } : {}),
    file: loopKeyFilePath(file.loopId),
  };
}

/** The treasury, or a refusal when the file names another root: a key is managed only from the root it was made on. */
function rootFor(file: LoopKeyFile): PrivateKeyAccount {
  const treasury = root();
  if (treasury.address.toLowerCase() !== file.root.toLowerCase()) {
    throw new Error(`the key of ${file.loopId} is rooted on ${file.root}, not on this treasury (${treasury.address})`);
  }
  return treasury;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ─── The lifecycle ──────────────────────────────────────────────────────────

/** Makes a random key (never from the server seed) and writes its file, mode 0600, before anything is sent. */
export function createLoopKey(
  loopId: string,
  limitBase: string,
  expiry: number,
  /**
   * The key's call scopes, stored in the file and authorized with it; `loopKeyScopes` builds them.
   * Absent, the key is unscoped and its authorize carries no scopes at all.
   */
  scopes?: TempoKeyScope[]
): LoopKey {
  checkLoopId(loopId);
  // Normalised (and checked) before anything touches the disk, so the file, the authorize and the
  // policy hold one spelling of the key's terms.
  const scoped = scopes === undefined ? undefined : normaliseScopes(scopes);
  if (baseUnits(limitBase, "limitBase") <= BigInt(0)) throw new Error("a loop key's limit must be above zero");
  if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) {
    throw new Error(`a loop key's expiry must be a future unix time in seconds (got ${expiry})`);
  }
  const dir = loopKeyDir();
  assertKeyDirAllowed(dir);
  // The root is read before the file is written: a console without a treasury has nothing to
  // authorize on, and leaves nothing behind saying otherwise.
  const rootAddress = root().address;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const privateKey = generatePrivateKey();
  const file: LoopKeyFile = {
    v: 1,
    loopId,
    address: privateKeyToAccount(privateKey).address,
    privateKey,
    root: rootAddress,
    token: TEMPO_USDC_E,
    limitBase,
    expiry,
    ...(scoped ? { scopes: scoped } : {}),
    createdAt: Date.now(),
  };
  const at = loopKeyFilePath(loopId);
  // `wx`: a loop has one key. An existing file is a key that may already be authorized — or the
  // trace of a crash between write and authorize — and either way it is a person's to look at,
  // not this function's to overwrite.
  try {
    // Flushed, with its directory below, before the key is authorized: the key is about to sign for
    // a deposit, and a file a power loss left empty would be a key nobody can close with.
    writeFlushedSync(at, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (e: any) {
    if (e?.code === "EEXIST") throw new Error(`${loopId} already has a key file at ${at}`);
    throw e;
  }
  // The mode is under the umask's say at creation; this makes 0600 exact whatever it is.
  fs.chmodSync(at, 0o600);
  syncDirSync(path.dirname(at));
  return keyOf(file);
}

/**
 * Authorizes `key` on the treasury's keychain with its `limitBase` and `expiry`: a root transaction
 * under `withTreasury`. Returns the key with `authorizeTx`, which is also written to its file. On
 * failure it deletes the file and throws with Tempo's reason. A failure after the transaction went
 * out — reverted, unmined, or an error whose outcome is unknown — may still have authorized the
 * key; deleting its private key makes it inert (nothing can sign with it), and the log line and the
 * error name its address so the treasury can revoke it by address.
 */
export async function authorizeLoopKey(key: LoopKey): Promise<LoopKey> {
  const file = readKeyFile(key.loopId);
  if (!file) throw new Error(`no key file for ${key.loopId}: createLoopKey writes it before anything is sent`);
  if (file.authorizeTx) {
    // Already authorized: deleting this file would orphan a live key, so it is left as it is.
    throw new Error(`the key of ${key.loopId} was already authorized in ${file.authorizeTx}`);
  }
  // Whether the authorize was handed to Tempo, and the hash it answered with: what the failure
  // line must say, since only a key that was sent can be live.
  let sent = false;
  let sentTx: `0x${string}` | undefined;
  try {
    // The file is what gets authorized; a caller's copy that disagrees with it is a bug upstream,
    // and authorizing either would commit terms the other does not hold.
    if (
      !same(file.address, key.address) ||
      file.limitBase !== key.limitBase ||
      file.expiry !== key.expiry ||
      !same(file.token, key.token) ||
      // The scopes are terms too: a caller holding a scoped copy of an unscoped file, or the
      // reverse, would commit calls the keychain does not restrict, or restricts differently.
      JSON.stringify(file.scopes ?? null) !== JSON.stringify(key.scopes ?? null)
    ) {
      throw new Error("the key passed does not match its file");
    }
    const treasury = rootFor(file);
    const res = await rootTx(key.loopId, () => {
      sent = true;
      return chain().authorize({
        root: treasury.address,
        key: file.address,
        token: file.token,
        limit: BigInt(file.limitBase),
        expiry: file.expiry,
        // From the file, as every other term is; an unscoped file sends no `scopes` key at all.
        ...(file.scopes ? { scopes: file.scopes } : {}),
      });
    });
    sentTx = res.txHash;
    if (res.status !== "success" || !res.txHash) {
      const tx = res.txHash ? ` ${res.txHash}` : "";
      throw new Error(
        res.status === "pending" ? `the authorize${tx} was not mined in time` : `the authorize${tx} reverted`
      );
    }
    const done: LoopKeyFile = { ...file, authorizeTx: res.txHash };
    rewriteKeyFile(done);
    return keyOf(done);
  } catch (e: any) {
    // A start refused here must leave no usable key behind: the private key goes, so even a
    // key the authorize did reach can sign nothing. Its address — never the private key — is what
    // is said, because that is all the treasury needs to revoke it.
    const tail = sent
      ? `; the key ${file.address}${sentTx ? ` (authorize ${sentTx})` : ""} may be authorized on the treasury — ` +
        `it can sign nothing now its file is deleted, and the treasury can revoke it by address`
      : `; nothing was sent, so the key ${file.address} was never authorized`;
    console.warn(`tempo-keys: authorizing the key of ${key.loopId} failed${tail}`);
    deleteLoopKeyFile(key.loopId);
    throw new Error(`authorizing the Tempo key of ${key.loopId} failed: ${tempoReason(e)}${tail}`);
  }
}

/** Accounts built per loop: the `viem/tempo` import and the curve work are paid once. */
const accounts = new Map<string, { address: string; account: any }>();

/**
 * The access-key account `mppx` signs with, or `null` when the file is gone (the treasury then
 * closes the loop's channels as their payer).
 * `expectedAddress` is the key the loop's row commits (`LoopRecord.tempoKey.address`): a file that
 * holds any other key — replaced on disk, even by another key rooted on this treasury — is refused
 * rather than signed with, since its payments would name a signer the loop's Genesis never committed.
 */
export async function loopKeyAccount(loopId: string, expectedAddress?: string): Promise<any | null> {
  const file = readKeyFile(loopId);
  if (!file) {
    accounts.delete(loopId);
    return null;
  }
  if (expectedAddress !== undefined && !same(file.address, expectedAddress)) {
    accounts.delete(loopId);
    throw new Error(`the key file of ${loopId} holds ${file.address}, not the ${expectedAddress} its loop committed`);
  }
  const cached = accounts.get(loopId);
  if (cached && cached.address === file.address) return cached.account;
  const treasury = rootFor(file);
  const { Account } = await dynamicImport("viem/tempo");
  const account = Account.fromSecp256k1(file.privateKey, { access: treasury });
  // The two properties every record and every channel rely on: the payer is the treasury, and the
  // signer is this loop's key. Either differing means the file is not what it says, and signing
  // with it would put a payment under a name the audit cannot reconcile — refused, not guessed.
  if (!same(String(account.address), treasury.address)) {
    throw new Error(`the key account of ${loopId} pays from ${account.address}, not the treasury ${treasury.address}`);
  }
  if (!same(String(account.accessKeyAddress), file.address)) {
    throw new Error(
      `the key file of ${loopId} names ${file.address}, but its private key is ${account.accessKeyAddress}`
    );
  }
  accounts.set(loopId, { address: file.address, account });
  return account;
}

/**
 * Thrown by `reconcileLoopKeyLimit` when, after an update, the key could spend more than the
 * `loopKeyLimitTarget` target. Before throwing, the reconcile has already asked Tempo to set the
 * key's limit to zero — zero is zero under either reading of `LIMIT_UPDATE_SETS` — so the key is
 * shut whatever the caller does next; `zeroed` says whether that update went through. The caller
 * stops the loop (`tempo-key-refused`).
 */
export class LoopKeyOverCapError extends Error {
  readonly zeroed: boolean;
  constructor(message: string, zeroed: boolean) {
    super(message);
    this.name = "LoopKeyOverCapError";
    this.zeroed = zeroed;
  }
}

/**
 * Thrown by `reconcileLoopKeyLimit` when it cannot tell what the key's limit now is: the update
 * errored or timed out after it may have been broadcast and the state read afterwards does not show
 * its effect, or the read that rechecks an update failed. Nothing may be opened on the key until a
 * later reconcile reads it cleanly.
 */
export class LoopKeyLimitUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopKeyLimitUnknownError";
  }
}

/**
 * Thrown by `reconcileLoopKeyLimit` when the key's state could not be read **before anything was
 * sent**: a `getRemainingLimit` that timed out or errored on the way in. Nothing about the key moved,
 * so this is the one reconcile failure that is safe to try again — the loop opens nothing this step
 * and reconciles on the next one, rather than stopping a healthy loop on one dropped read. Matched by
 * name as well as class, for the reason `PaidCallFailed` is.
 */
export class LoopKeyReadFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopKeyReadFailedError";
  }

  static is(e: unknown): e is LoopKeyReadFailedError {
    return e instanceof LoopKeyReadFailedError || (e as { name?: unknown } | null)?.name === "LoopKeyReadFailedError";
  }
}

/**
 * Sets the key's limit so that what it may still deposit is `limitBase − Σ settled(closed) − Σ
 * deposit(open)` over `rows`, sending nothing when Tempo already says that. Idempotent; a root
 * transaction under `withTreasury`. `target` is that amount, base units.
 *
 * It fails closed. An update that leaves the key above the target is followed by an update to zero
 * and a `LoopKeyOverCapError`; an update whose outcome cannot be read back, or whose recheck cannot
 * be read at all, is a `LoopKeyLimitUnknownError`. Either way it throws, and the caller opens nothing.
 *
 * `rows` must be the loop's channels as they stand when no open, top-up or close of this loop is in
 * flight — `_lib/loop-key.ts` assembles them right before the loop's next open, and a loop's
 * channel moments are serial, so nothing can add a deposit between that read and this reconcile. A
 * caller that cannot promise that passes `opts.rowsUnderLock`, read again under the lock, from
 * which the target sent is recomputed; a row missed by a stale read can only be a deposit, which
 * would raise the target, and this is the way to rule that out.
 */
export async function reconcileLoopKeyLimit(
  loopId: string,
  rows: readonly LoopKeyChannelRow[],
  opts: { rowsUnderLock?: () => readonly LoopKeyChannelRow[] | Promise<readonly LoopKeyChannelRow[]> } = {}
): Promise<{ target: string; sent: boolean; txHash?: `0x${string}` }> {
  const file = readKeyFile(loopId);
  if (!file) throw new Error(`no key file for ${loopId}; its limit cannot be reconciled`);
  const treasury = rootFor(file);
  const firstTarget = loopKeyLimitTarget(file.limitBase, rows);
  const semantics = hooks?.limitUpdateSets ?? LIMIT_UPDATE_SETS;
  const wantTotal =
    semantics === "total"
      ? { limitBase: file.limitBase, ...(file.authorizeTx ? { authorizeTx: file.authorizeTx } : {}) }
      : undefined;
  const read = () =>
    chain().readState({
      root: treasury.address,
      key: file.address,
      token: file.token,
      ...(wantTotal ? { wantTotal } : {}),
    });
  const update = (limit: bigint) =>
    chain().updateLimit({ root: treasury.address, key: file.address, token: file.token, limit });
  // A read before any update moved nothing: its failure is retryable, unlike every failure after a send.
  const readBeforeSending = () =>
    read().catch((e) => {
      throw new LoopKeyReadFailedError(
        `the Tempo key of ${loopId} could not be read before its limit was reconciled (${tempoReason(e)}); ` +
          `nothing was sent`
      );
    });
  // The common case — nothing settled since the last reconcile — answers from one read outside the
  // queue, so a loop's reopen does not wait behind another loop's open for nothing.
  if ((await readBeforeSending()).remaining === firstTarget) return { target: firstTarget.toString(), sent: false };
  return rootTx(loopId, async () => {
    const target = opts.rowsUnderLock ? loopKeyLimitTarget(file.limitBase, await opts.rowsUnderLock()) : firstTarget;
    // Read again under the lock: the value sent is sized from the state it will apply to.
    const state = await readBeforeSending();
    if (state.remaining === target) return { target: target.toString(), sent: false };
    const limit = limitUpdateValue(target, state, semantics);

    // Shuts the key and throws: the one answer to "the key may spend more than it should".
    const overCap = async (remaining: bigint, how: string): Promise<never> => {
      let zeroed = false;
      let zeroNote: string;
      try {
        zeroNote = `its limit was set to 0 in ${await update(BigInt(0))}`;
        zeroed = true;
      } catch (z) {
        zeroNote = `setting its limit to 0 also failed (${tempoReason(z)}); revoke it from the treasury by address ${
          file.address
        }`;
      }
      throw new LoopKeyOverCapError(
        `the Tempo key of ${loopId} has ${remaining} remaining after ${how}, above its target ${target}: ` +
          `updateSpendingLimit does not set the ${semantics} amount; ${zeroNote}`,
        zeroed
      );
    };

    let txHash: `0x${string}` | undefined;
    try {
      txHash = await update(limit);
    } catch (e) {
      // The update may have been broadcast and mined even though the call failed (a timeout
      // waiting for the receipt, a dropped connection). Only the state can say what happened.
      const reason = tempoReason(e);
      const now = await read().catch(() => null);
      if (now && now.remaining > target && now.remaining !== state.remaining) {
        await overCap(now.remaining, `a limit update for ${target} that answered "${reason}"`);
      }
      if (!now || now.remaining !== target) {
        throw new LoopKeyLimitUnknownError(
          `the limit update for the Tempo key of ${loopId} (target ${target}) failed with "${reason}", and its ` +
            `outcome is unknown: ${
              now ? `the key now reads ${now.remaining} remaining` : "the key's state could not be read back"
            }. ` +
            `Open nothing on this key until a reconcile reads it at its target`
        );
      }
      // The state shows the update's effect: it landed, and only the answer was lost.
      console.warn(`tempo-keys: ${loopId}'s limit update answered "${reason}" but the key reads its target ${target}`);
      return { target: target.toString(), sent: true };
    }

    // The recheck that keeps an unconfirmed `LIMIT_UPDATE_SETS` from becoming an over-cap: a
    // remaining above the target means the update meant something other than `semantics` says, and
    // the key is shut before the throw. A recheck that cannot be read is not skipped: it throws.
    // Below the target is the safe direction (a loop starved early), said rather than thrown.
    let after: { remaining: bigint };
    try {
      after = await read();
    } catch (e) {
      throw new LoopKeyLimitUnknownError(
        `the Tempo key of ${loopId} could not be read back after ${txHash} set it for ${target} (${tempoReason(e)}); ` +
          `open nothing on it until a reconcile reads it at its target`
      );
    }
    if (after.remaining > target) await overCap(after.remaining, txHash);
    if (after.remaining < target) {
      console.warn(
        `tempo-keys: ${loopId} has ${after.remaining} remaining after ${txHash}, below its target ${target}; check LIMIT_UPDATE_SETS`
      );
    }
    return { target: target.toString(), sent: true, txHash };
  });
}

/** Revokes the loop's key: a root transaction under `withTreasury`. The tx hash, or `null` when there was no key to revoke. */
export async function revokeLoopKey(loopId: string): Promise<`0x${string}` | null> {
  const file = readKeyFile(loopId);
  if (!file) return null;
  const treasury = rootFor(file);
  let txHash: `0x${string}`;
  try {
    txHash = await rootTx(loopId, () => chain().revoke({ root: treasury.address, key: file.address }));
  } catch (e) {
    // The file stays: an unrevoked key is still live, and its file is what a person revokes it with.
    throw new Error(`revoking the Tempo key of ${loopId} failed: ${tempoReason(e)}`);
  }
  // A revoked key can neither open nor top up, and a leftover channel is the treasury's to
  // force-close as its payer, so the private key has nothing left to do.
  deleteLoopKeyFile(loopId);
  return txHash;
}

/** Reads the key's remaining limit, expiry and revocation off Tempo by address; needs no file. */
export async function loopKeyState(key: Pick<LoopKey, "address" | "token">): Promise<LoopKeyState | null> {
  try {
    const s = await chain().readState({ root: root().address, key: key.address, token: key.token });
    return { remaining: s.remaining.toString(), expiry: s.expiry, isRevoked: s.isRevoked };
  } catch {
    return null;
  }
}

/** Removes the loop's key file, if any. */
export function deleteLoopKeyFile(loopId: string): void {
  checkLoopId(loopId);
  accounts.delete(loopId);
  fs.rmSync(loopKeyFilePath(loopId), { force: true });
}

// ─── The real chain ─────────────────────────────────────────────────────────

// `viem/tempo` and `viem/chains` go through `import()`, as the access-key probe loads them: required
// as CommonJS they pull in `ox`, which tsconfig.json maps to its `.d.ts` files for the type checker
// and `tsconfig-paths/register` then maps at run time too, so the import dies. The ESM resolver is
// not hooked. Loaded on first use, so a console with the switch off never loads them at all.
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

/**
 * A viem client on Tempo mainnet. With `treasury`, its account is the treasury as a Tempo **root**
 * account — what `Account.fromSecp256k1(treasuryKey)` makes in the probe, built here from the
 * treasury's public key and its `sign`, so the raw key stays inside `_lib/tempo.ts`. Fees are paid
 * in USDC.e, like every other treasury transaction.
 */
async function tempoClient(treasury: PrivateKeyAccount | null): Promise<{ client: any; Actions: any; Addresses: any }> {
  const [{ Account, Actions, Addresses, PublicKey }, { tempo }, { createClient, http }] = await Promise.all([
    dynamicImport("viem/tempo"),
    dynamicImport("viem/chains"),
    dynamicImport("viem"),
  ]);
  let account: any = undefined;
  if (treasury) {
    account = Account.from({
      keyType: "secp256k1",
      publicKey: PublicKey.fromHex(treasury.publicKey),
      sign: ({ hash }: { hash: Hex }) => treasury.sign({ hash }),
    });
    if (!same(String(account.address), treasury.address)) {
      throw new Error("the treasury's Tempo root account does not resolve to the treasury's address");
    }
  }
  const client = createClient({
    ...(account ? { account } : {}),
    chain: tempo.extend({ feeToken: TEMPO_USDC_E }),
    transport: http(TEMPO_RPC_URL),
  });
  return { client, Actions, Addresses };
}

/**
 * What `realChain.authorize` hands `Actions.accessKey.authorizeSync`. Pure, so a test can hold an
 * unscoped key to the unscoped authorize byte for byte: without scopes the object has no `scopes`
 * key at all, rather than `scopes: undefined`, which a later viem could read as a field that was
 * sent.
 */
export function loopKeyAuthorizeArgs(o: {
  key: `0x${string}`;
  token: `0x${string}`;
  limit: bigint;
  expiry: number;
  scopes?: readonly TempoKeyScope[];
}): Record<string, unknown> {
  return {
    accessKey: { address: o.key, type: "secp256k1" },
    expiry: o.expiry,
    limits: [{ token: o.token, limit: o.limit }],
    ...(o.scopes ? { scopes: o.scopes.map((s) => ({ ...s })) } : {}),
    ...rootNonceOptions(),
  };
}

/** A mined receipt's hash, or the reason it is not one. viem's `status` is `success` or `reverted`. */
function minedHash(receipt: any, what: string): `0x${string}` {
  const hash = receipt?.transactionHash as `0x${string}` | undefined;
  if (receipt?.status !== "success" || !hash) {
    const tx = hash ? ` ${hash}` : "";
    throw new Error(`the ${what}${tx} ${receipt?.status === "reverted" ? "reverted" : "was not mined in time"}`);
  }
  return hash;
}

const SPENDING_LIMIT_UPDATED = keccak256(toHex("SpendingLimitUpdated(address,address,address,uint256)"));

/**
 * The limit in force, for `"total"` semantics only: the newest `SpendingLimitUpdated` for this
 * (root, key, token) since the authorize's block, else `limitBase`. Every update to a loop key goes
 * through `reconcileLoopKeyLimit`, so the authorize and the log between them name every value it held.
 */
async function limitInForce(
  rpc: JsonRpc,
  keychain: `0x${string}`,
  o: { root: `0x${string}`; key: `0x${string}`; token: `0x${string}` },
  wantTotal: { limitBase: string; authorizeTx?: `0x${string}` }
): Promise<bigint> {
  if (!wantTotal.authorizeTx) throw new Error("the key has no authorize transaction to read its limit updates from");
  const receipt = await rpc("eth_getTransactionReceipt", [wantTotal.authorizeTx]);
  if (!receipt?.blockNumber) throw new Error(`the authorize ${wantTotal.authorizeTx} has no receipt`);
  const topic = (a: `0x${string}`) => pad(a.toLowerCase() as `0x${string}`, { size: 32 });
  const logs = (await rpc("eth_getLogs", [
    {
      address: keychain,
      topics: [SPENDING_LIMIT_UPDATED, topic(o.root), topic(o.key), topic(o.token)],
      fromBlock: receipt.blockNumber,
      toBlock: "latest",
    },
  ])) as { data: Hex }[] | null;
  if (!logs || logs.length === 0) return BigInt(wantTotal.limitBase);
  const [newLimit] = decodeAbiParameters([{ type: "uint256" }], logs[logs.length - 1].data);
  return newLimit as bigint;
}

/**
 * Tempo itself. The `*Sync` actions submit and wait for the receipt, as the probe used them;
 * `throwOnReceiptRevert` stays at its default, so a revert arrives as an error carrying the node's
 * reason, which `tempoReason` surfaces. Under `strict: false` viem's action parameter types
 * collapse, hence the `any`s, as in the probe.
 */
const realChain: TempoKeyChain = {
  async authorize(o) {
    const { client, Actions } = await tempoClient(root());
    const res = await Actions.accessKey.authorizeSync(client, loopKeyAuthorizeArgs(o));
    const receipt = res?.receipt;
    const status = receipt?.status === "success" ? "success" : receipt?.status === "reverted" ? "reverted" : "pending";
    return { txHash: receipt?.transactionHash, status };
  },
  async updateLimit(o) {
    const { client, Actions } = await tempoClient(root());
    const res = await Actions.accessKey.updateLimitSync(client, {
      accessKey: o.key,
      token: o.token,
      limit: o.limit,
      ...rootNonceOptions(),
    });
    return minedHash(res?.receipt, "limit update");
  },
  async revoke(o) {
    const { client, Actions } = await tempoClient(root());
    const res = await Actions.accessKey.revokeSync(client, { accessKey: o.key, ...rootNonceOptions() });
    return minedHash(res?.receipt, "revoke");
  },
  async readState(o) {
    const { client, Actions, Addresses } = await tempoClient(null);
    const [limit, meta] = await Promise.all([
      Actions.accessKey.getRemainingLimit(client, { account: o.root, accessKey: o.key, token: o.token }),
      Actions.accessKey.getMetadata(client, { account: o.root, accessKey: o.key }),
    ]);
    const total = o.wantTotal ? await limitInForce(httpRpc(), Addresses.accountKeychain, o, o.wantTotal) : undefined;
    return {
      remaining: BigInt(limit.remaining),
      expiry: Number(meta.expiry),
      isRevoked: !!meta.isRevoked,
      ...(total !== undefined ? { total } : {}),
    };
  },
};
