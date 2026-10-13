import * as anchor from "@coral-xyz/anchor";
import { BN, EventParser, Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { LATH_BILLING_IDL, type LathBilling } from "./idl";
import { confirmByPolling, isTransientRpcError } from "./confirm";
import { isRetryableWriteError, LathClient } from "./client";
import { ActionPayload } from "./events";
import { Bytes32 } from "./hash";
import {
  Allowance,
  ALLOWANCE_LEGACY_LEN,
  ALLOWANCE_LEN,
  ALLOWANCE_OFFSETS,
  allowanceAddress,
  balanceAddress,
  decodeAllowance,
  decodeTreasury,
  decodeUserBalance,
  spendableOf,
  Treasury,
  treasuryAddress,
  USER_BALANCE_LEN,
  UserBalance,
  vaultAddress,
} from "./layout";
import { LathSigner, SignerLike, toAnchorWallet, toLathSigner } from "./signer";

/** SPL Token program. USDC is a classic SPL mint, so no Token-2022 path is needed. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * Whether `sendRawTransaction` failed because the RPC answered and refused the transaction, so
 * that nothing was forwarded. web3.js throws `SendTransactionError` for a JSON-RPC error to
 * `sendTransaction`, and a node returns one only before it forwards: a transaction it cannot
 * decode, a bad signature, an unhealthy node, a preflight simulation that failed. Its message opens
 * `Simulation failed.` under preflight (older releases: `failed to send transaction:`), which is
 * tested too, for a caller whose `Connection` comes from another copy of web3.js than this SDK's.
 *
 * Everything else is not a refusal: an HTTP status (`502 Bad Gateway: …`, a 504 from a gateway
 * that timed out waiting on the node), `fetch failed`, a dropped socket — each can arrive after
 * the RPC handed the transaction on, and is confirmed as a send.
 */
export function isSendRefusal(e: unknown): boolean {
  if (e instanceof SendTransactionError) return true;
  const message = (e as any)?.message;
  return typeof message === "string" && /^(Simulation failed\.|failed to send transaction:)/.test(message);
}

/** The fee payer's signature, base58: the id the cluster files a signed transaction under. */
function signatureOf(signed: Transaction): string {
  if (!signed.signature) throw new Error("the transaction carries no fee-payer signature");
  return bs58.encode(signed.signature);
}

/** An `Allowance` together with the address that proves which treasury it belongs to. */
interface AllowanceEntry {
  address: PublicKey;
  allowance: Allowance;
}

interface ChargeHistoryOptions {
  /** How many signatures to walk back. Default 50. */
  limit?: number;
  /** Signature to page before, for "load older". */
  before?: string;
}

/** One billing event affecting a user's balance, as reported by `chargeHistory`. */
export interface BillingActivity {
  name: "Deposited" | "Withdrawn" | "Charged" | "Reserved" | "Released" | "Settled";
  /** `credit` raises spendable, `debit` lowers it, `hold` moves it in or out of `reserved`. */
  direction: "credit" | "debit" | "hold";
  signature: string;
  slot: number;
  /** Unix **seconds**, or null when the RPC has no block time for the slot. */
  blockTime: number | null;
  amount: bigint;
  /** The agent that spent, for `Charged`/`Reserved`/`Released`/`Settled`; null for the user's own moves. */
  agentAuthority: PublicKey | null;
  /**
   * `Settled` only (an event of `settle`, which this program does not have; older transactions
   * still decode): the other side — who was paid, or who paid.
   */
  counterparty?: PublicKey | null;
}

export interface ChargeAndLogRequest {
  user: PublicKey;
  amountMicroUsdc: bigint;
  agentId: Bytes32;
  payload: ActionPayload;
  compact: boolean;
  timestamp: number;
}

interface BillingClientOptions {
  /**
   * The Lath client whose chain `chargeAndLog` appends to. Required only for
   * `chargeAndLog`; every other call works without it.
   */
  lath?: LathClient;
  /**
   * Which treasury this client talks to. Treasuries are namespaced by their admin
   * (`["treasury", admin]`) and every balance, allowance and vault is scoped to one, so a
   * client that is not the admin must say which treasury it means. Defaults to the signer's
   * own treasury, which is only correct for the admin.
   */
  admin?: PublicKey;
  /**
   * How many times a standalone write (`charge`, `reserve`, `deposit`, …) is rebuilt on a fresh
   * blockhash and resent after a *transient* failure. A transaction the cluster reports as
   * landed is never resent, whatever the confirm call said. Default 3.
   */
  maxRetries?: number;
  /** Base delay between attempts in ms; doubles each time. Default 400. */
  retryDelayMs?: number;
  /**
   * How long `confirmByPolling` waits through an RPC answering only errors (any error: this
   * client polls with `anyRpcError`) before it calls the confirmation unknown. Default
   * `CONFIRM_MAX_WAIT_MS` (180 s), which outlasts the blockhash; a test passes a few ms. Below the
   * validity window a rebuild after "unknown" could land beside the original, so production code
   * should leave it alone.
   */
  confirmMaxWaitMs?: number;
}

/**
 * Client for the `lath-billing` program: USDC escrow, per-agent allowances, metered
 * deduction and the treasury sweep.
 *
 * All amounts are micro-USDC (native units of a 6-decimal mint). Token accounts are passed in
 * explicitly rather than derived, so the SDK carries no SPL-token dependency and works with
 * whatever account layout the operator uses.
 */
export class BillingClient {
  readonly signer: LathSigner;
  /** Admin whose treasury this client operates against. */
  readonly admin: PublicKey;
  private readonly lath?: LathClient;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly confirmMaxWaitMs?: number;
  /** Allowance addresses already seen at the current size, so the repair check is asked once. */
  private readonly currentAllowances = new Set<string>();

  constructor(
    readonly connection: Connection,
    readonly program: Program<LathBilling>,
    signer: SignerLike,
    opts: BillingClientOptions = {}
  ) {
    this.signer = toLathSigner(signer);
    this.admin = opts.admin ?? this.signer.publicKey;
    this.lath = opts.lath;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.confirmMaxWaitMs = opts.confirmMaxWaitMs;
  }

  /** Builds a client from the bundled billing IDL — no Anchor workspace required. */
  static fromIdl(connection: Connection, signer: SignerLike, opts: BillingClientOptions = {}): BillingClient {
    const s = toLathSigner(signer);
    const provider = new anchor.AnchorProvider(connection as any, toAnchorWallet(s), {
      commitment: connection.commitment ?? "confirmed",
    });
    const program = new Program<LathBilling>(LATH_BILLING_IDL, provider);
    return new BillingClient(connection, program, s, opts);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  // ---------------------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------------------

  treasuryAddress(): PublicKey {
    return treasuryAddress(this.admin, this.programId);
  }

  vaultAddress(): PublicKey {
    return vaultAddress(this.treasuryAddress(), this.programId);
  }

  balanceAddress(user: PublicKey): PublicKey {
    return balanceAddress(this.treasuryAddress(), user, this.programId);
  }

  allowanceAddress(user: PublicKey, agentAuthority: PublicKey): PublicKey {
    return allowanceAddress(this.treasuryAddress(), user, agentAuthority, this.programId);
  }

  // ---------------------------------------------------------------------------------------
  // Instruction builders — every write is available as an instruction so it can be composed
  // into a caller's transaction (which is the whole point of `chargeAndLog`).
  // ---------------------------------------------------------------------------------------

  async initTreasuryIx(p: {
    usdcMint: PublicKey;
    sweepDestination: PublicKey;
    sweeper: PublicKey;
    maxSweepPerCall?: bigint | number;
    maxSweepPerDay?: bigint | number;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .initTreasury(p.sweeper, new BN((p.maxSweepPerCall ?? 0).toString()), new BN((p.maxSweepPerDay ?? 0).toString()))
      .accountsPartial({
        admin: this.signer.publicKey,
        treasury: this.treasuryAddress(),
        usdcMint: p.usdcMint,
        vault: this.vaultAddress(),
        sweepDestination: p.sweepDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async depositIx(p: {
    amount: bigint | number;
    usdcMint: PublicKey;
    userToken: PublicKey;
    user?: PublicKey;
  }): Promise<TransactionInstruction> {
    const user = p.user ?? this.signer.publicKey;
    return this.program.methods
      .deposit(new BN(p.amount.toString()))
      .accountsPartial({
        user,
        treasury: this.treasuryAddress(),
        balance: this.balanceAddress(user),
        usdcMint: p.usdcMint,
        userToken: p.userToken,
        vault: this.vaultAddress(),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async approveAgentIx(p: {
    agentAuthority: PublicKey;
    cap: bigint | number;
    expiresAt: bigint | number;
    policyVersionHash: Bytes32;
    user?: PublicKey;
  }): Promise<TransactionInstruction> {
    const user = p.user ?? this.signer.publicKey;
    return this.program.methods
      .approveAgent(
        p.agentAuthority,
        new BN(p.cap.toString()),
        new BN(p.expiresAt.toString()),
        Array.from(p.policyVersionHash)
      )
      .accountsPartial({
        user,
        treasury: this.treasuryAddress(),
        allowance: this.allowanceAddress(user, p.agentAuthority),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Revoking releases whatever the grant is still holding, so the balance row has to travel with
   * it. The account is optional in the program because a user can grant an allowance before ever
   * depositing; it is passed whenever it exists, and `null` when it does not — a user with no
   * balance row has no hold to return.
   */
  async revokeAgentIx(p: { agentAuthority: PublicKey; user?: PublicKey }): Promise<TransactionInstruction> {
    const user = p.user ?? this.signer.publicKey;
    const balance = this.balanceAddress(user);
    const exists = await this.connection.getAccountInfo(balance);
    return this.program.methods
      .revokeAgent(p.agentAuthority)
      .accountsPartial({
        user,
        treasury: this.treasuryAddress(),
        balance: exists ? balance : null,
        allowance: this.allowanceAddress(user, p.agentAuthority),
      })
      .instruction();
  }

  /** `charge` and `reserve` share an account set; the agent authority signs. */
  private async meterIx(
    op: "charge" | "reserve",
    user: PublicKey,
    amount: bigint | number
  ): Promise<TransactionInstruction> {
    const accounts = {
      agentAuthority: this.signer.publicKey,
      user,
      treasury: this.treasuryAddress(),
      balance: this.balanceAddress(user),
      allowance: this.allowanceAddress(user, this.signer.publicKey),
    };
    const arg = new BN(amount.toString());
    const builder = op === "charge" ? this.program.methods.charge(arg) : this.program.methods.reserve(arg);
    return builder.accounts(accounts).instruction();
  }

  /**
   * Grows a grant in the older layout to the one that carries `reserved`, or `null` when the grant
   * is already current (or does not exist, in which case the instruction that needs it will fail
   * on its own terms).
   *
   * Anchor deserialises exactly, so a short grant fails *every* instruction that reads it with
   * `AccountDidNotDeserialize` (3003) — an error that says nothing about what to do. The writes
   * below therefore repair the grant in the same transaction rather than leaving that to the
   * caller. One `getAccountInfo` per pair, remembered, because the repair happens at most once.
   */
  async migrateAllowanceIxIfNeeded(user: PublicKey, agentAuthority: PublicKey): Promise<TransactionInstruction | null> {
    const address = this.allowanceAddress(user, agentAuthority);
    const key = address.toBase58();
    if (this.currentAllowances.has(key)) return null;
    const info = await this.connection.getAccountInfo(address);
    if (!info || info.data.length !== ALLOWANCE_LEGACY_LEN) {
      // A grant that does not exist is not a grant that needs growing: let the real instruction
      // report the missing account, which is a different problem with a clearer error.
      if (info) this.currentAllowances.add(key);
      return null;
    }
    return this.migrateAllowanceIx({ user, agentAuthority });
  }

  /** The repair on its own. `payer` defaults to this client's signer — any signer is allowed. */
  async migrateAllowanceIx(p: { user: PublicKey; agentAuthority: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .migrateAllowance(p.agentAuthority)
      .accountsPartial({
        payer: this.signer.publicKey,
        user: p.user,
        treasury: this.treasuryAddress(),
        allowance: this.allowanceAddress(p.user, p.agentAuthority),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `[migrate?, ix]` — the repair above prepended to the write that needs it. */
  private async withMigration(
    user: PublicKey,
    agentAuthority: PublicKey,
    ix: TransactionInstruction
  ): Promise<TransactionInstruction[]> {
    const migrate = await this.migrateAllowanceIxIfNeeded(user, agentAuthority);
    return migrate ? [migrate, ix] : [ix];
  }

  chargeIx(user: PublicKey, amount: bigint | number): Promise<TransactionInstruction> {
    return this.meterIx("charge", user, amount);
  }
  /**
   * The charge as the instructions one transaction needs, the legacy-grant repair first when the
   * grant still has the older layout, without `reserved`. `chargeIx` alone fails every composed
   * charge on such a grant with 3003; every direct send goes through `withMigration`, and
   * `chargeAndLog` composes `[migrate, charge]` beside the log, so the size is proven.
   */
  async chargeIxs(user: PublicKey, amount: bigint | number): Promise<TransactionInstruction[]> {
    return this.withMigration(user, this.signer.publicKey, await this.chargeIx(user, amount));
  }
  reserveIx(user: PublicKey, amount: bigint | number): Promise<TransactionInstruction> {
    return this.meterIx("reserve", user, amount);
  }
  /**
   * Gives a hold back. The signer is either the agent that placed it (the default, and what a
   * runtime does when a session ends) or the **user** whose balance is carrying it, who passes
   * the `agentAuthority` whose grant to unwind. The owner's path is the one that works when the
   * agent is gone: nothing about it needs the agent's key.
   */
  releaseIx(user: PublicKey, amount: bigint | number, agentAuthority?: PublicKey): Promise<TransactionInstruction> {
    const agent = agentAuthority ?? this.signer.publicKey;
    return this.program.methods
      .release(new BN(amount.toString()))
      .accountsPartial({
        signer: this.signer.publicKey,
        user,
        agentAuthority: agent,
        treasury: this.treasuryAddress(),
        balance: this.balanceAddress(user),
        allowance: this.allowanceAddress(user, agent),
      })
      .instruction();
  }

  async sweepIx(p: {
    amount: bigint | number;
    usdcMint: PublicKey;
    destination: PublicKey;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .sweep(new BN(p.amount.toString()))
      .accountsPartial({
        sweeper: this.signer.publicKey,
        treasury: this.treasuryAddress(),
        usdcMint: p.usdcMint,
        vault: this.vaultAddress(),
        destination: p.destination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  // ---------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------

  /**
   * Signs, sends and confirms one transaction, rebuilt on a fresh blockhash after a transient
   * failure — with one rule that matters more than the retry: **a transaction the cluster says
   * landed is never sent twice.** The confirm call watches a blockhash's validity window, and
   * on a slow cluster it can report "block height exceeded" for a transaction that was in fact
   * confirmed a moment earlier (a devnet charge has done exactly this: the signature was
   * `Finalized` while the step was failed for it). Resending a `charge` on that
   * verdict would debit the user twice, so every failure first asks the cluster what became of
   * the signature and only rebuilds when the answer is "nothing".
   *
   * "Could not ask" is not "nothing". When the status cannot be read at all — the RPC answering
   * only transient errors — the transaction is **not** rebuilt and this throws `could not tell
   * whether … landed`: a stuck charge is recoverable, a double debit is not. A
   * confirmation that `confirmByPolling` gave up on as unknown (`confirmationUnknown`) and a
   * status the cluster then reports as absent do rebuild: that wait outlasts the blockhash, so
   * the first transaction can no longer land.
   *
   * Nothing is rebuilt, or thrown without its signature, while the transaction can still land.
   * A charge takes no nonce, so a rebuild beside a transaction still in flight is a second debit,
   * here or in a caller one layer up that resends on any error it cannot attribute (the anchor
   * queue). Two failures would otherwise end an attempt early and bare. A send that throws after
   * the RPC has already forwarded the transaction (a 502 or 504 from a gateway, `fetch failed`)
   * carries no signature at all, so the signature is taken from the signed bytes before they
   * leave, and any send failure that is not the RPC's own refusal (`isSendRefusal`) is confirmed
   * as if the transaction had gone out. And a status or height read that fails in a way that does
   * not look transient would be a confirmation error while the transaction is still in flight, so
   * the poll asks again through any RPC failure (`anyRpcError`), and every verdict it reaches
   * leaves the transaction landed, failed, or past its blockhash.
   *
   * `cosigners` sign after this client's signer, for an instruction that needs a second
   * signature. Nothing in this client needs one; the parameter stays for a caller composing its
   * own.
   */
  async send(instructions: TransactionInstruction[], cosigners: SignerLike[] = []): Promise<string> {
    const others = cosigners.map(toLathSigner);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const tx = new Transaction().add(...instructions);
      tx.feePayer = this.signer.publicKey;
      const bh = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = bh.blockhash;
      let signed = await this.signer.signTransaction(tx);
      for (const other of others) signed = await other.signTransaction(signed);
      const raw = signed.serialize();
      // The fee payer's signature is the transaction's id, and the signed bytes already fix it:
      // taken here, it names the transaction whatever the send below does.
      const signature = signatureOf(signed);
      try {
        await this.connection.sendRawTransaction(raw);
      } catch (e) {
        // The RPC answered and refused, before forwarding anything: rethrown as it came, because
        // a program refusal's logs are what the anchor queue parks a charge by (`chargeRefusal`).
        if (isSendRefusal(e)) throw e;
        // Anything else can come after the forward, so the transaction is treated as sent. The
        // confirmation below settles it: landed, or nothing landed by the time its blockhash is
        // past, and only then is it built again.
      }
      try {
        // Confirm against the blockhash the transaction was signed with, so the wait ends when
        // that blockhash expires and not when some later one does.
        await confirmByPolling(this.connection, signature, bh.lastValidBlockHeight, {
          maxWaitMs: this.confirmMaxWaitMs,
          anyRpcError: true,
        });
        return signature;
      } catch (e) {
        lastError = e;
        const landed = await this.landed(signature);
        if (landed === true) return signature;
        // `false` is the cluster's own verdict that the transaction failed; a rebuild would fail
        // the same way. `null` — no status — is the only case a fresh blockhash can help with.
        // Thrown with the signature on it when the status could not be read, as the in-doubt throw
        // below is: a caller one layer up that resends on any error (the anchor queue) must be
        // able to ask about this transaction first, or it debits twice where this client would
        // not. The message is the original's either way.
        if (landed === false || attempt === this.maxRetries || !isRetryableWriteError(e)) {
          if (landed === "unknown" && e && typeof e === "object" && !("signature" in e)) {
            Object.assign(e, { signature });
          }
          throw e;
        }
        if (landed === "unknown") {
          throw Object.assign(
            new Error(`could not tell whether ${signature} landed; not resent (a resent charge debits twice)`),
            { signature, cause: e }
          );
        }
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
      }
    }
    throw lastError;
  }

  /**
   * `landed`, for a caller holding a signature this client threw as in doubt: the anchor queue
   * journals it and asks here before it sends the charge again, so a charge the client refused to
   * resend is not resent one layer up. Same answers, same history search, same retries.
   */
  chargeLanded(signature: string): Promise<boolean | null | "unknown"> {
    return this.landed(signature);
  }

  /**
   * `true` landed without error, `false` landed and failed, `null` the cluster has no record,
   * `"unknown"` the status could not be read. A transient read failure is retried with the same
   * budget as a send, because one 429 read as `null` would send the charge again.
   */
  private async landed(signature: string): Promise<boolean | null | "unknown"> {
    for (let i = 0; ; i++) {
      try {
        const { value } = await this.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = value[0];
        if (!status) return null;
        if (status.err) return false;
        return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? true : null;
      } catch (e) {
        if (i >= this.maxRetries || !isTransientRpcError(e)) return "unknown";
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** i));
      }
    }
  }

  async initTreasury(p: Parameters<BillingClient["initTreasuryIx"]>[0]): Promise<string> {
    return this.send([await this.initTreasuryIx(p)]);
  }
  async deposit(p: Parameters<BillingClient["depositIx"]>[0]): Promise<string> {
    return this.send([await this.depositIx(p)]);
  }
  async approveAgent(p: Parameters<BillingClient["approveAgentIx"]>[0]): Promise<string> {
    const user = p.user ?? this.signer.publicKey;
    return this.send(await this.withMigration(user, p.agentAuthority, await this.approveAgentIx(p)));
  }
  async revokeAgent(p: Parameters<BillingClient["revokeAgentIx"]>[0]): Promise<string> {
    const user = p.user ?? this.signer.publicKey;
    return this.send(await this.withMigration(user, p.agentAuthority, await this.revokeAgentIx(p)));
  }
  async charge(user: PublicKey, amount: bigint | number): Promise<string> {
    return this.send(await this.withMigration(user, this.signer.publicKey, await this.chargeIx(user, amount)));
  }
  async reserve(user: PublicKey, amount: bigint | number): Promise<string> {
    return this.send(await this.withMigration(user, this.signer.publicKey, await this.reserveIx(user, amount)));
  }
  async release(user: PublicKey, amount: bigint | number, agentAuthority?: PublicKey): Promise<string> {
    const agent = agentAuthority ?? this.signer.publicKey;
    return this.send(await this.withMigration(user, agent, await this.releaseIx(user, amount, agent)));
  }
  /** Grows an older-layout grant on its own, for a caller with nothing else to compose it with. */
  async migrateAllowance(p: Parameters<BillingClient["migrateAllowanceIx"]>[0]): Promise<string> {
    return this.send([await this.migrateAllowanceIx(p)]);
  }
  async sweep(p: Parameters<BillingClient["sweepIx"]>[0]): Promise<string> {
    return this.send([await this.sweepIx(p)]);
  }

  /**
   * Debits the user and appends the event that justifies the debit in **one** transaction.
   * `charge` runs first, so a rejected allowance, an expired grant or an
   * insufficient balance fails the whole transaction and no event is written.
   *
   * Satisfies the runtime's `BillingBackend`, so wiring billing into an `AgentRuntime` is
   * `billing: new BillingClient(connection, program, agentKeypair, { lath })`.
   *
   * A lost confirmation does not charge twice: the write goes through `LathClient.logEvent`,
   * whose in-doubt ledger finds a landed attempt — by its `(seq, head)` or by signature — before
   * any rebuild, and a rebuild spends the same state hash as the attempt in doubt, so at most one
   * of the two transactions (each carrying its charge) can land.
   */
  async chargeAndLog(req: ChargeAndLogRequest) {
    if (!this.lath) throw new Error("BillingClient needs a `lath` client to chargeAndLog");
    if (!this.lath.authority.publicKey.equals(this.signer.publicKey)) {
      throw new Error("the agent authority must be the same key on both clients");
    }
    // A zero-cost step (a cached or free generation) still gets logged; the program rejects a
    // zero-amount charge, so there is nothing to compose.
    const instructions =
      req.amountMicroUsdc > 0n
        ? await this.withMigration(req.user, this.signer.publicKey, await this.chargeIx(req.user, req.amountMicroUsdc))
        : [];
    return this.lath.logEvent(req.agentId, req.payload, {
      compact: req.compact,
      timestamp: req.timestamp,
      instructions,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------

  async getTreasury(): Promise<Treasury | null> {
    const info = await this.connection.getAccountInfo(this.treasuryAddress());
    return info ? decodeTreasury(info.data) : null;
  }

  /**
   * A user's escrow row, or `null` when they have none. A user paid through `settle`, which this
   * program does not have, may hold an older row without ever depositing; anyone else without a
   * deposit has none, which is `null` rather than an error.
   */
  async getBalance(user: PublicKey): Promise<UserBalance | null> {
    const info = await this.connection.getAccountInfo(this.balanceAddress(user));
    return info ? decodeUserBalance(info.data) : null;
  }

  async getAllowance(user: PublicKey, agentAuthority: PublicKey): Promise<Allowance | null> {
    const info = await this.connection.getAccountInfo(this.allowanceAddress(user, agentAuthority));
    return info ? decodeAllowance(info.data) : null;
  }

  /** `deposited − spent − reserved`: what a charge or a hold may draw on. */
  async spendable(user: PublicKey): Promise<bigint> {
    return spendableOf(await this.getBalance(user));
  }

  /** `total_spent − total_swept`: the only USDC the sweeper is allowed to move. */
  async sweepable(): Promise<bigint> {
    const t = await this.getTreasury();
    return t ? t.totalSpent - t.totalSwept : 0n;
  }

  /**
   * Every grant this user has made, in this treasury: "which agents am I paying for".
   *
   * `Allowance` is a plain Solana account, so this is one `getProgramAccounts` with a size
   * filter and a `memcmp` on `user`. The treasury is *not* a field on the account — it is a
   * PDA seed — so grants made in another admin's treasury match the same filters. Each hit is
   * therefore checked against the address this client would derive for it, which is the only
   * thing that ties an allowance to a treasury.
   */
  async listAllowancesByUser(user: PublicKey): Promise<AllowanceEntry[]> {
    return this.listAllowances(ALLOWANCE_OFFSETS.user, user, (a) => this.allowanceAddress(a.user, a.agentAuthority));
  }

  /**
   * Every grant *to* this agent authority: "who is paying me". The operator side of the same
   * table — an agent runtime uses it to find the users it may charge.
   */
  async listAllowancesByAgent(agentAuthority: PublicKey): Promise<AllowanceEntry[]> {
    return this.listAllowances(ALLOWANCE_OFFSETS.agentAuthority, agentAuthority, (a) =>
      this.allowanceAddress(a.user, a.agentAuthority)
    );
  }

  private async listAllowances(
    offset: number,
    key: PublicKey,
    expected: (a: Allowance) => PublicKey
  ): Promise<AllowanceEntry[]> {
    // Two queries, because `dataSize` is exact and a grant in the older layout, without `reserved`,
    // is eight bytes short until `migrate_allowance` grows it. Dropping the filter instead
    // would match every treasury and balance row the program owns.
    const accounts = (
      await Promise.all(
        [ALLOWANCE_LEN, ALLOWANCE_LEGACY_LEN].map((dataSize) =>
          this.connection.getProgramAccounts(this.programId, {
            filters: [{ dataSize }, { memcmp: { offset, bytes: key.toBase58() } }],
          })
        )
      )
    ).flat();
    const out: AllowanceEntry[] = [];
    for (const { pubkey, account } of accounts) {
      const allowance = decodeAllowance(account.data);
      if (!expected(allowance).equals(pubkey)) continue; // another treasury's grant
      out.push({ address: pubkey, allowance });
    }
    return out.sort((a, b) => a.address.toBase58().localeCompare(b.address.toBase58()));
  }

  /**
   * Calls `cb` with the balance every time it changes, and once is not called for the current
   * value — read it with `getBalance` first. `cb` gets `null` if the account is closed or has
   * an unexpected size; a user with no deposits yet has no account at all, so nothing fires
   * until their first deposit creates it.
   *
   * Returns the unsubscribe function.
   */
  watchBalance(user: PublicKey, cb: (balance: UserBalance | null) => void): () => void {
    const id = this.connection.onAccountChange(
      this.balanceAddress(user),
      (info) => cb(info.data.length === USER_BALANCE_LEN ? decodeUserBalance(info.data) : null),
      { commitment: this.connection.commitment ?? "confirmed" }
    );
    return () => {
      this.connection.removeAccountChangeListener(id).catch(() => {});
    };
  }

  /**
   * The user's billing activity, newest first: deposits, withdrawals, charges, reserves and
   * releases, read out of the Anchor events in the transactions that touched their balance
   * account.
   *
   * This is history by replay, not by index — it costs one `getSignaturesForAddress` plus a
   * batched `getTransaction`, and it only reaches as far back as the RPC's retention.
   * `approve_agent` and `revoke_agent` never touch the balance account, so they are deliberately
   * absent.
   */
  async chargeHistory(user: PublicKey, opts: ChargeHistoryOptions = {}): Promise<BillingActivity[]> {
    const limit = opts.limit ?? 50;
    const signatures = await this.connection.getSignaturesForAddress(this.balanceAddress(user), {
      limit,
      before: opts.before,
    });
    const confirmed = signatures.filter((s) => !s.err);
    if (confirmed.length === 0) return [];

    const parser = new EventParser(this.programId, this.program.coder);
    const out: BillingActivity[] = [];
    // `getTransactions` batches into one RPC call; 100 is the server-side cap per batch.
    const txOpts = { maxSupportedTransactionVersion: 0, commitment: "confirmed" as const };
    for (let i = 0; i < confirmed.length; i += 100) {
      const batch = confirmed.slice(i, i + 100);
      let txs: Awaited<ReturnType<Connection["getTransactions"]>>;
      try {
        txs = await this.connection.getTransactions(
          batch.map((s) => s.signature),
          txOpts
        );
      } catch (err) {
        // Some RPC tiers refuse JSON-RPC batches outright (Helius free: -32403 "Batch requests
        // are only available for paid plans"). One request per signature costs more round trips
        // and reads the same history; anything else is a real error.
        if (!isBatchRefusal(err)) throw err;
        txs = [];
        for (const s of batch) txs.push(await this.connection.getTransaction(s.signature, txOpts));
      }
      txs.forEach((tx, j) => {
        const logs = tx?.meta?.logMessages;
        if (!logs) return;
        // Not `errorOnDecodeFailure`: a program's logs interleave Anchor events with plain
        // `Program log:` lines, and only the events are ours to decode.
        for (const event of parser.parseLogs(logs)) {
          const activity = toActivity(event, batch[j].signature, tx!.slot, tx!.blockTime ?? null, user);
          if (activity) out.push(activity);
        }
      });
    }
    return out;
  }
}

/**
 * The kinds of billing event `chargeHistory` reports, with the sign each has on the balance.
 *
 * Keyed by the lowercased event name on purpose: Anchor's event coder reports whatever casing
 * the IDL it was built from carries, and the same program's IDL is `Charged` when read from
 * `target/idl` and `charged` when read from the generated TypeScript. The discriminator is the
 * real identity; the name is just how it is spelled back to us.
 */
const ACTIVITY_KINDS: Record<string, { name: BillingActivity["name"]; direction: BillingActivity["direction"] }> = {
  deposited: { name: "Deposited", direction: "credit" },
  withdrawn: { name: "Withdrawn", direction: "debit" },
  charged: { name: "Charged", direction: "debit" },
  reserved: { name: "Reserved", direction: "hold" },
  released: { name: "Released", direction: "hold" },
  // A `settle` (not in this program; older transactions carry its event) moved escrow between two
  // rows, so the same event is a debit on one side and a credit on the other. Which one this is
  // depends on whose history is being read, and `toActivity` decides it from the `user` the
  // caller asked about — the direction below is only the default.
  settled: { name: "Settled", direction: "debit" },
};

function toActivity(
  event: { name: string; data: any },
  signature: string,
  slot: number,
  blockTime: number | null,
  /** Whose history this is. A `Settled` event reads as a credit for the payee and a debit for the payer. */
  user: PublicKey
): BillingActivity | null {
  const kind = ACTIVITY_KINDS[event.name?.toLowerCase()];
  if (!kind) return null;
  const d = event.data ?? {};
  const agentAuthority = d.agentAuthority ?? d.agent_authority ?? null;
  const payer = d.user ? new PublicKey(d.user) : null;
  const provider = d.provider ? new PublicKey(d.provider) : null;
  const paid = kind.name === "Settled" && !!provider && provider.equals(user);
  return {
    name: kind.name,
    direction: paid ? "credit" : kind.direction,
    signature,
    slot,
    blockTime,
    amount: BigInt(d.amount?.toString() ?? "0"),
    agentAuthority: agentAuthority ? new PublicKey(agentAuthority) : null,
    counterparty: kind.name === "Settled" ? (paid ? payer : provider) : undefined,
  };
}

/**
 * A JSON-RPC refusal of the batch itself, as opposed to a failure of any one transaction read.
 *
 * Two shapes, both about the batch and neither about the transactions in it: a tier that refuses
 * batching at all (Helius free: `-32403`, "Batch requests are only available for paid plans"),
 * and one that accepts batches but not one this large (Helius devnet: HTTP 413, `-32413`, "Too
 * many requests"). Unrecognised, the second makes `chargeHistory` throw on every wallet with more
 * than a handful of charges, which the billing page renders as *No escrow activity yet* — a
 * balance that says it has spent, over a history that says nothing ever happened.
 *
 * Matched by code, not by the sentence alone. "Too many requests" is also what an ordinary HTTP
 * 429 says, and a 429 is precisely the case where the per-signature fallback — a hundred requests
 * where there was one — must *not* run.
 */
export function isBatchRefusal(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  // The two JSON-RPC codes, and the two sentences that name the *batch*. Deliberately not the
  // bare phrase "too many requests": that is also what a plain HTTP 429 says, and answering a
  // rate limit by firing up to a hundred sequential `getTransaction` calls at the node that just
  // imposed it is the opposite of what the fallback is for. Helius devnet's 413 carries `-32413`,
  // so the code is what recognises it.
  return /-32403|-32413|batch requests|batch is too large|payload too large/i.test(text);
}
