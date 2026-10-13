import { PublicKey } from "@solana/web3.js";
import { ActionPayload, Bytes32, LogResult } from "@lath/sdk";

/**
 * What the runtime needs from a billing backend. Deliberately one method: the USDC deduction and
 * the event that justifies it must land in the **same transaction**, so a backend that can do
 * that must own the logging call too.
 *
 * A backend that cannot (or a session that is not billed) returns `null` and the runtime logs
 * the event by itself.
 */
export interface ChargeAndLogRequest {
  /** Whose `UserBalance` and `Allowance` are debited. */
  user: PublicKey;
  /** Cost of this step, micro-USDC, margin already applied and rounded up. */
  amountMicroUsdc: bigint;
  /** Chain the event belongs to. */
  agentId: Bytes32;
  /** The action to log alongside the charge. */
  payload: ActionPayload;
  compact: boolean;
  timestamp: number;
}

export interface BillingBackend {
  /**
   * Debits `amountMicroUsdc` on its own, for a step whose event is batched into an epoch rather
   * than logged in the same transaction (`AgentRuntimeOptions.rollup`). Optional: a backend
   * without it leaves epoch steps unbilled, which the runtime reports rather than hides.
   * Throws to abort the step.
   */
  charge?(user: PublicKey, amountMicroUsdc: bigint): Promise<string | null>;
  /**
   * Debits `amountMicroUsdc` and logs `payload` atomically. Returns the `LogResult` when the
   * event was logged as part of the charge, or `null` when the backend charged nothing and
   * the caller should log the event itself.
   *
   * Throws to abort the step: a failed charge must not produce an event that claims work was
   * paid for: the step aborts and the session resolves `failed`.
   */
  chargeAndLog(req: ChargeAndLogRequest): Promise<LogResult | null>;
}

/** Default backend: meters spend in memory, moves no money, logs nothing. */
export class NoopBilling implements BillingBackend {
  /** Total micro-USDC the runtime *would* have charged. */
  charged = 0n;
  readonly charges: { user: string; amountMicroUsdc: bigint }[] = [];

  async chargeAndLog(req: ChargeAndLogRequest): Promise<LogResult | null> {
    this.charged += req.amountMicroUsdc;
    this.charges.push({ user: req.user.toBase58(), amountMicroUsdc: req.amountMicroUsdc });
    return null;
  }

  async charge(user: PublicKey, amountMicroUsdc: bigint): Promise<string | null> {
    this.charged += amountMicroUsdc;
    this.charges.push({ user: user.toBase58(), amountMicroUsdc });
    return null;
  }
}

/** USD (OpenRouter's `usage.cost`) → micro-USDC with operator margin, rounded **up**. */
export function toMicroUsdc(costUsd: number, margin: number): bigint {
  if (!Number.isFinite(costUsd) || costUsd < 0) return 0n;
  // Settle the float product to a thousandth of a micro-USDC before rounding up, otherwise
  // 0.007 × 1.1 × 1e6 = 7700.000000000001 ceils to 7701 and the charge is not reproducible
  // from the documented formula.
  const micro = Math.round(costUsd * (1 + margin) * 1_000_000 * 1_000) / 1_000;
  return BigInt(Math.ceil(micro));
}

// ─── The one margin, and the meter it is applied to ─────────────────────────

/**
 * The operator's margin over what the provider was paid, when nothing configures one.
 *
 * One number, because there is one rail: every billed call is paid over MPP from the treasury and
 * metered by the voucher delta. It is the measured number rather than a chosen one. What a margin
 * could amortise beyond the provider's own price is the on-chain cost of a TIP-1034 channel per
 * session: its open and its close. Measured on Tempo mainnet from the treasury `0x18fB…e0B0` over a
 * three-step loop: the open is gas-sponsored by the gateway (`feePayer: true`), the close is sent
 * and paid by the payee (`0xca4e…79fe`, 65 421 gas at 0.6 gwei ≈ 39 base units, none of it the
 * treasury's), and the treasury moved by exactly the vouchers — 9 000 base units for six calls at
 * 1 500. Gas per session from the treasury is therefore 0. A charge is `ceil(delta × (1 + margin))`
 * and stays reproducible from the delta a record commits and this number alone.
 */
export const DEFAULT_MARGIN = 0.1;

function envMargin(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  // A margin that cannot be parsed is the operator's typo, and charging a number nobody meant is
  // worse than charging the documented one: the default stands, and the formula still explains
  // the bill.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** `LATH_MARGIN`, default 0.10. Read per call, so a process can be reconfigured without a restart. */
export function margin(): number {
  return envMargin("LATH_MARGIN", DEFAULT_MARGIN);
}

/**
 * The `tempo` rail's meter: the voucher delta (`cumulativeAfter − cumulativeBefore`) with the
 * operator margin, rounded **up**.
 *
 * USDC.e has six decimals, so the delta is already micro units and nothing is converted here —
 * and nothing passes through a float either, unlike `toMicroUsdc`, which has to start from a USD
 * number. The margin becomes basis points once and the rest is integer arithmetic, so the charge
 * is exactly reproducible from the delta the record commits and the margin the docs state.
 */
export function toMicroUsdcFromBase(deltaBase: bigint, margin: number): bigint {
  if (deltaBase <= 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.round(margin * 10_000)));
  const scaled = deltaBase * (10_000n + bps);
  // `ceil` over integers: the operator never absorbs a fraction of a micro-USDC.
  return scaled / 10_000n + (scaled % 10_000n === 0n ? 0n : 1n);
}
