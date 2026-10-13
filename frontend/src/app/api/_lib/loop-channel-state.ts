/**
 * What the console knows about a loop's Tempo channel without touching it (`_lib/loops.ts`
 * re-exports it): the channel's sizing against the loop's budget, the deposits the treasury has
 * committed, the marks a step's spend is measured between, and the hooks a suite stands in for
 * Tempo. Opening and settling it is `loop-channel.ts`.
 */
import { PublicKey } from "@solana/web3.js";
import { BillingClient, LathClient } from "@lath/sdk";
import type { ChatTransport, TempoChannel, TempoSettlement } from "@lath/runtime";
import { type OpenChannelRow, base6, httpRpc, openChannelLedger, treasuryAccount, usdcBalance } from "./tempo";
import { TREASURY_ADMIN, admitSpend, deployedRoles, loadKeypair, lookupAgent, rpcFor } from "./runner";
import { GATE_ASK_DEPOSIT_BASE, JEV_BUDGET_PERCENT, STEP_DEADLINE_MS } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import {
  digits,
  jevBudgetOf,
  jevFundedRemaining,
  jevRemainingOf,
  type LoopBudgetFields,
  loopRemainingOf,
} from "./loop-budget";
import { scheduler } from "./loop-state";
import { readLoops } from "./loop-registry";

/** What the scheduler holds per open channel: the transport, and where in the run it opened. */
export interface HeldChannel {
  channel: LoopChannel;
  openedAt: number;
  /** `snapshot.steps` when the channel opened; the first step it pays for is this + 1. */
  openedAtStep: number;
}

/** A `PooledTempoTransport`, structurally: what a step pays through and what a settlement closes. */
export type LoopChannel = ChatTransport & TempoChannel & { readonly cumulative?: string };

/**
 * How long a loop's channel may sit with nothing paid through it before it is settled: two of
 * whatever this loop ticks on, capped at an hour.
 *
 * Two intervals rather than one because a step that ran late must not settle the channel it is
 * about to use; an hour because an idle deposit is exactly what a crash strands, and nothing is
 * worth leaving the operator's USDC.e out overnight for. A loop on a half-hour interval is
 * therefore effectively back to a channel per step, which is the right trade at that spacing:
 * the open costs seconds and the deposit would otherwise be out for the whole gap.
 */
export function channelIdleMs(loop: LoopRecord): number {
  return Math.min(2 * loop.intervalMs, 60 * 60_000);
}

export function clearIdleTimer(id: string): void {
  const timer = scheduler().idle.get(id);
  if (timer) clearTimeout(timer);
  scheduler().idle.delete(id);
}

/** Where a loop's channel stands at one moment: which channel, and its cumulative in base units. */
export interface LoopChannelMark {
  channelId?: string;
  cumulative?: string;
}

/** The mark of the channel this process holds for loop `id`, or an empty one when it holds none. */
export function loopChannelMark(id: string): LoopChannelMark {
  const held = scheduler().channels.get(id);
  return held ? { channelId: held.channel.channelId, cumulative: held.channel.cumulative } : {};
}

/**
 * What a step's Tempo channel paid out between two marks, USDC.e base units as a decimal string —
 * the step row's `tempoSpent`. `loop.tempo.spent` says this only for the channel the run settled,
 * which is every step's at once; this is one step's share of it.
 *
 * The channel opens lazily inside the first paid call and can be settled idle and reopened between
 * steps, so a channel the step ended on that is not the one it started on counts from zero: every
 * voucher on it was signed during this step. Nothing paid, or no channel at the end, is `undefined`
 * rather than `"0"`, so a vault-rail or scripted step's row carries no Tempo figure at all.
 * Gate asks are paid between steps, outside the two marks, and so are not in it; Jev's decision on
 * the step is, because it rides the same channel inside the step.
 */
export function tempoSpentSince(before: LoopChannelMark, after: LoopChannelMark): string | undefined {
  if (!after.channelId || after.cumulative === undefined) return undefined;
  const from = before.channelId === after.channelId ? BigInt(before.cumulative ?? "0") : BigInt(0);
  const spent = BigInt(after.cumulative) - from;
  return spent > BigInt(0) ? spent.toString() : undefined;
}

/** Every loop channel this console believes is open, in the ledger's row shape, newest first. */
export function openLoopChannels(): OpenChannelRow[] {
  return Object.values(readLoops())
    .filter((l) => !!l.channel)
    .map((l) => ({
      agentId: l.agentId,
      channelId: l.channel!.channelId,
      payer: l.channel!.payer,
      openedAt: l.channel!.openedAt,
      loopId: l.id,
    }))
    .sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * The three moments that touch Tempo or the chain, injected so the channel's whole life — one
 * per loop, settled on every exit, reopened after an idle — is testable without either
 * (`tests/console-loops.ts`). The app passes none of them and gets the three defaults below.
 */
export interface LoopChannelHooks {
  /** Opens the loop's channel. Default: `openTempoChannel` against the operator's treasury. */
  open?: (loop: LoopRecord) => Promise<{ channel: LoopChannel } | { degrade: string }>;
  /** Settles a channel this process holds no mppx session for. Default: `closeChannelById`. */
  closeById?: (channelId: string, payer: string) => Promise<{ txHash?: string; spent?: string }>;
  /** Writes the `loop.settlement` record. Default: a `LoopRunner` built the way a step builds one. */
  settle?: (loop: LoopRecord, channel: TempoChannel) => Promise<TempoSettlement | undefined>;
}

/**
 * What a loop's channel is opened with: a deposit of what is **left** of the owner's budget plus
 * what is left of Lath's Jev budget — every call the channel can still carry, owner's and Jev's —
 * and a top-up unit of an even share of what is left per step left, never less than
 * `GATE_ASK_DEPOSIT_BASE`, so a nearly spent loop still refills in useful steps.
 *
 * `funded` is what the owner's allowance and escrow back of that remainder (`loopFundedHeadroom`),
 * and when it is given — the real open always gives it — both halves are sized from it instead of
 * from the declared budget: the owner's half is at most what is funded, and Lath's Jev half at most
 * its share of what the owner has spent and funded (`jevFundedRemaining`). The deposit is a
 * ceiling, not what leaves the treasury at the open: mppx opens with the gateway's suggested
 * deposit and tops up automatically, `topUpBase` at a time, but never lets the cumulative voucher
 * pass `maxDeposit` — so this number is what one channel can draw from the treasury in all, and
 * sizing it from a budget nobody funded would let one step's estimate in escrow unlock the
 * treasury's whole balance. Without `funded` it is sized from the declared budget.
 *
 * The deposit is not a per-step unit (`budgetMicroUsdcPerStep × (steps left + 1)`): a loop's policy
 * `maxCost` is the whole budget, and a per-step formula would ask the treasury to hold that budget
 * once per step. An older row with only a per-step budget is sized the same way over its derived
 * budget, which is at most what a per-step formula would hold for it.
 */
export function loopChannelSizing(
  loop: LoopBudgetFields & Pick<LoopRecord, "snapshot">,
  funded?: bigint
): {
  maxDepositBase: bigint;
  topUpBase: bigint;
} {
  const remaining = loopRemainingOf(loop);
  const owner = funded === undefined || funded > remaining ? remaining : funded > 0n ? funded : 0n;
  const stepsLeft = BigInt(Math.max(1, loop.maxSteps - loop.snapshot.steps));
  const share = owner / stepsLeft;
  const topUpBase = share > GATE_ASK_DEPOSIT_BASE ? share : GATE_ASK_DEPOSIT_BASE;
  const deposit = owner + (funded === undefined ? jevRemainingOf(loop) : jevFundedRemaining(loop, owner));
  // Never under one top-up unit: a channel opened on a nearly spent loop (a gate ask after the
  // owner's budget ran low) with a deposit of dust, or of nothing, is one mppx cannot pay a call
  // from. The floor is at most `GATE_ASK_DEPOSIT_BASE` over what is left, and only then.
  return { maxDepositBase: deposit > topUpBase ? deposit : topUpBase, topUpBase };
}

/**
 * The ceiling each loop channel this process opened was sized to, by loop id — what the channel can
 * still draw from the treasury is this less what has been deposited into it already. Pinned to the
 * process like the scheduler, so a re-evaluated module does not forget a channel it still holds.
 */
const LOOP_CHANNEL_CAPS_KEY = Symbol.for("lath.loopChannelCaps");

export function loopChannelCaps(): Map<string, bigint> {
  const g = globalThis as any;
  if (g[LOOP_CHANNEL_CAPS_KEY] === undefined) g[LOOP_CHANNEL_CAPS_KEY] = new Map<string, bigint>();
  return g[LOOP_CHANNEL_CAPS_KEY] as Map<string, bigint>;
}

/**
 * What open channels can still pull from the treasury by topping up, base units: each channel's
 * ceiling less what is already deposited into it (which has already left the treasury's balance),
 * or less its cumulative when no deposit is known — the cumulative is never above the deposit, so
 * that reads more as committed, never less. Pure, so the arithmetic is testable without a channel.
 */
export function channelsCommittedBase(channels: { cap: bigint; deposit?: bigint; cumulative?: bigint }[]): bigint {
  let committed = 0n;
  for (const c of channels) {
    const out = c.deposit ?? c.cumulative ?? 0n;
    if (c.cap > out) committed += c.cap - out;
  }
  return committed;
}

/**
 * `channelsCommittedBase` over every loop channel this process holds, but `except`'s own: the
 * deposit of another loop's channel is not in the treasury's balance, and the rest of its ceiling
 * is money a top-up will take from that balance later. A start or an open that read only the
 * balance would count the same USDC.e for two loops. The deposit is read off the channel ledger's
 * recovery row, which the transport rewrites on every voucher and top-up.
 */
export function loopChannelsCommitted(except?: string): bigint {
  const caps = loopChannelCaps();
  const held = scheduler().channels;
  const ledger = new Map<string, OpenChannelRow>();
  for (const row of openChannelLedger()) ledger.set(row.channelId, row);
  const rows: { cap: bigint; deposit?: bigint; cumulative?: bigint }[] = [];
  for (const [loopId, cap] of caps) {
    const entry = held.get(loopId);
    // A cap whose channel this process no longer holds was settled: nothing more can be drawn.
    if (!entry) {
      caps.delete(loopId);
      continue;
    }
    if (loopId === except) continue;
    const channelId = entry.channel.channelId;
    const deposit = channelId ? ledger.get(channelId)?.recovery?.deposit : undefined;
    const cumulative = entry.channel.cumulative;
    rows.push({
      cap,
      ...(deposit !== undefined && digits(deposit) ? { deposit: BigInt(deposit) } : {}),
      ...(cumulative !== undefined && digits(cumulative) ? { cumulative: BigInt(cumulative) } : {}),
    });
  }
  return channelsCommittedBase(rows);
}

/**
 * Why the channel this loop holds cannot carry a step expected to cost `estimate`, or `null` — also
 * `null` when it holds none, or one this process did not size. What is left of it is its ceiling
 * less its cumulative: mppx refuses a voucher past the ceiling, so a step on a channel with less
 * than its estimate left fails at its first call past it, and so does every step after it.
 */
export function heldChannelShort(id: string, estimate: bigint): string | null {
  const held = scheduler().channels.get(id);
  const cap = loopChannelCaps().get(id);
  if (!held || cap === undefined) return null;
  const cumulative = digits(held.channel.cumulative) ? BigInt(held.channel.cumulative) : 0n;
  const left = cap > cumulative ? cap - cumulative : 0n;
  if (left >= estimate) return null;
  return (
    `this loop's channel was sized to what the owner had funded when it opened (${base6(cap)} USDC.e) and has ` +
    `${base6(left)} left, under this step's ${base6(estimate)} estimate, so this step ran scripted and unbilled; ` +
    "the channel is settled after the step and the next one opens a channel sized to what is funded then"
  );
}

/**
 * The owner's allowance to this loop's agent and their escrow's spendable, read as a step reads them,
 * or `null` when they could not be read — which the open treats as nothing funded, never as the
 * declared budget.
 */
export async function loopOwnerFunds(
  loop: LoopRecord
): Promise<{ grant: Parameters<typeof admitSpend>[0]["grant"]; spendable: bigint } | null> {
  const server = loadKeypair();
  const deployed = lookupAgent(loop.agentId);
  if (!server || !deployed || !TREASURY_ADMIN) return null;
  try {
    const rpc = rpcFor();
    const key = deployedRoles(server, deployed.name).agent.key;
    const client = LathClient.fromIdl(rpc, key);
    const reader = BillingClient.fromIdl(rpc, key, { admin: new PublicKey(TREASURY_ADMIN), lath: client });
    const owner = new PublicKey(loop.owner);
    return { grant: await reader.getAllowance(owner, key.publicKey), spendable: await reader.spendable(owner) };
  } catch {
    return null;
  }
}

/** The treasury's USDC.e, or `null` when it could not be read (then the check says so). */
export async function treasuryHeld(): Promise<bigint | null> {
  try {
    return await usdcBalance(httpRpc(), treasuryAccount().address);
  } catch {
    return null;
  }
}

/**
 * Why the treasury cannot hold the deposit a run on these terms opens with, and the largest loop
 * budget it could hold, or `null`. The deposit is `loopChannelSizing`'s on a fresh run: the whole
 * loop budget plus Lath's Jev share of it, at the rate a start freezes (`JEV_BUDGET_PERCENT`).
 *
 * `committed` is what other loops' open channels can still top up from the treasury
 * (`loopChannelsCommitted`), and is not the new run's to count on. Read from this process by
 * default, so every caller accounts for it without asking.
 */
export function treasuryShortfall(
  terms: { maxSteps: number; budgetMicroUsdc: string | bigint },
  held: bigint | null,
  percent: number = JEV_BUDGET_PERCENT,
  committed: bigint = loopChannelsCommitted()
): string | null {
  const budget = BigInt(terms.budgetMicroUsdc);
  const needed = budget + jevBudgetOf(budget, percent);
  if (held === null) {
    return "the operator's Tempo treasury could not be read, so this run's steps would run scripted and unbilled; try again";
  }
  const free = held > committed ? held - committed : 0n;
  if (free >= needed) return null;
  // The largest budget whose deposit fits: `free ÷ (1 + percent/100)`, in hundredths of a percent.
  const hundredths = BigInt(Math.round(Math.min(100, Math.max(0, percent)) * 100));
  const fits = (free * 10_000n) / (10_000n + hundredths);
  const holds =
    committed > 0n
      ? `holds ${base6(held)} USDC.e, ${base6(committed)} of it committed to other loops' open channels,`
      : `holds ${base6(held)} USDC.e`;
  return (
    `the operator's Tempo treasury ${holds} and a loop budget of ${base6(budget)} USDC needs ` +
    `${base6(
      needed
    )} on deposit (the budget and Lath's ${percent}% for the decision model), so its steps would run scripted and ` +
    `unbilled. ` +
    (fits > 0n
      ? `Lower the loop budget to ${base6(fits)} USDC or less, or top up the treasury.`
      : "Top up the treasury.")
  );
}

/** Waits out a step of this loop running in this process; its last voucher is signed inside it. */
export async function waitForStep(id: string): Promise<void> {
  const until = Date.now() + STEP_DEADLINE_MS;
  while (scheduler().inFlight.has(id) && Date.now() < until) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      timer.unref?.();
    });
  }
}

/** Whether two spellings of a channel id name one channel: hex, so case does not count. */
export function sameChannelId(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Whether a settle of loop `id` is queued or running in this process (`checkLoopStart` refuses on it). */
export function loopSettling(id: string): boolean {
  return scheduler().settles.has(id);
}
