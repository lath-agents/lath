/**
 * What the loop page reads off a loop's Tempo services: the storage chip on a step row, the Costs
 * card's four Tempo lines with their block numbers, and the check an opened report must pass before
 * it is shown. Also the Tempo side of the page as figures: the money flow, the open channel's fill, the _Paid
 * on Tempo_ rows and the treasury's balance per step.
 *
 * Pure and browser-safe, with relative imports only, so the node suite (`tests/console-tempo-report.ts`)
 * reads the same functions the page renders from and the console's report route picks its report
 * with the same rule the page names it by.
 */
import type { LoopStepSummary, LoopTempoServicesStop, LoopView } from "../types/loop";
import { jevCostBase, traceCostBase } from "./loop-money";

type StepStorage = NonNullable<LoopStepSummary["tempoStorage"]>;
type StepSnapshot = NonNullable<LoopStepSummary["tempoSnapshot"]>;

/**
 * How long after its row a paid step's chip reads _pending_ with no PUT on the row. A PUT is two
 * seconds measured and the row's write retries once a second later (`rememberStepStorage`), so a
 * minute is far past any PUT that is coming; after it the chip says nothing rather than waiting on
 * a step that wrote no `report/` file, which publishes nothing and records nothing.
 */
export const STORAGE_PENDING_MS = 60_000;

/** One step's storage chip, or `null` for a step that published nothing (and on every older row). */
export type StorageChip =
  | { state: "pending" }
  | { state: "published"; amount?: string; reference?: string; seq?: string; bytes: number }
  | { state: "failed"; error: string; reference?: string; seq?: string };

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The chip for one step row. _Pending_ only on the `tempo` rail, on a step that paid its model over
 * Tempo — only a paid step publishes (`runnerBaseFor`: the PUT is the owner's, metered into the same
 * debit) — while its row is younger than `STORAGE_PENDING_MS`, and never once the report job has
 * said the step wrote no report (`tempoReport: "none"`).
 */
export function storageChipOf(
  row: Pick<LoopStepSummary, "tempoStorage" | "tempoReport" | "tempoSpent" | "endedAt"> | undefined,
  loop: Pick<LoopView, "rail">,
  now: number
): StorageChip | null {
  if (!row) return null;
  const s = row.tempoStorage;
  if (!s) {
    if (row.tempoReport === "none") return null;
    const paid = !!row.tempoSpent && /^\d+$/.test(row.tempoSpent) && BigInt(row.tempoSpent) > BigInt(0);
    return loop.rail === "tempo" && paid && now - row.endedAt < STORAGE_PENDING_MS ? { state: "pending" } : null;
  }
  if (ok(s.statusCode)) {
    return {
      state: "published",
      bytes: s.bytes,
      ...(s.amount ? { amount: s.amount } : {}),
      ...(s.reference ? { reference: s.reference } : {}),
      ...(s.seq ? { seq: s.seq } : {}),
    };
  }
  return {
    state: "failed",
    error: s.error ?? `status ${s.statusCode}`,
    ...(s.reference ? { reference: s.reference } : {}),
    ...(s.seq ? { seq: s.seq } : {}),
  };
}

/** Whether any row's chip is pending now: the page polls faster while one is, so it fills in soon. */
export function storagePending(loop: Pick<LoopView, "rail" | "history">, now: number): boolean {
  return loop.history.some((h) => storageChipOf(h, loop, now)?.state === "pending");
}

/**
 * USDC.e as dollars for a line a person reads: `200` base units is `$0.0002`, never `0.000200`. At
 * least two decimals, trailing zeros past them dropped.
 */
export function dollarsOfBase(base: bigint | string | undefined): string | null {
  const v = baseOf(base);
  if (v === null) return null;
  const whole = v / BigInt(1_000_000);
  let frac = (v % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `$${whole}.${frac}`;
}

/**
 * USDC.e in its own unit for a line a person reads: `200` base units is `0.0002 USDC.e`. The same
 * digits as `dollarsOfBase`, named by the token rather than a `$`, because the Costs card states the
 * Solana ledger in USDC beside it and a `$` on one ledger and a token name on the other read as two
 * currencies of one ledger, or one currency of two.
 */
export function usdcEOfBase(base: bigint | string | undefined): string | null {
  const dollars = dollarsOfBase(base);
  return dollars === null ? null : `${dollars.slice(1)} USDC.e`;
}

/**
 * A figure as base units. A decimal string of digits is base units already; one with a point is
 * dollars, which is how an mppx close receipt has reported `spent` in a probe (_0.005 spent for five
 * calls_), so both shapes read as the same amount rather than one of them as a million times it.
 */
export function baseOf(value: bigint | string | undefined | null): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "bigint") return value;
  if (/^\d+$/.test(value)) return BigInt(value);
  const m = /^(\d*)\.(\d{1,6})$/.exec(value);
  if (!m) return null;
  return BigInt(m[1] || "0") * BigInt(1_000_000) + BigInt(m[2].padEnd(6, "0"));
}

/** The committed report the _Open report_ link reads: the last step whose PUT landed and was written. */
export interface PublishedReport {
  step: number;
  /** `<loopId>-<sha256 hex>`, the key the `storage.put` Action commits through its args. */
  key: string;
  /** The SHA-256 of the report, hex: the Action's `result_hash`. */
  hash: string;
  /** The Action's seq, once a runner has written it; absent while the Action is still owed. */
  seq?: string;
  bytes: number;
  path: string;
  statusCode: number;
}

/**
 * The last step whose PUT came back 2xx, read off the console's rows. The hash is the key's suffix,
 * because the key is `<loopId>-<sha256 of the bytes>` by construction (`storageKey`); a key that does
 * not end in one is not a report this rule can name, and is passed over.
 */
export function lastPublishedReport(history: Pick<LoopStepSummary, "step" | "tempoStorage">[]): PublishedReport | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i].tempoStorage;
    if (!s || !ok(s.statusCode)) continue;
    const hash = reportHashOf(s.key);
    if (!hash) continue;
    return {
      step: history[i].step,
      key: s.key,
      hash,
      ...(s.seq ? { seq: s.seq } : {}),
      bytes: s.bytes,
      path: s.path,
      statusCode: s.statusCode,
    };
  }
  return null;
}

/**
 * The report's sha256 from its committed key, `<loopId>-<sha256 hex>` (`storageKey`), or `null` for a
 * key that is not one: the hash the step's `storage.put` commits as its result.
 */
export function reportHashOf(key: string): string | null {
  return /-([0-9a-f]{64})$/.exec(key)?.[1] ?? null;
}

/**
 * A report's first paragraph as plain text, for the step card's _report_: the first block of text
 * between blank lines that is not a heading, a rule or a fence, with its line breaks folded and the
 * Markdown marks a reader would see as noise (`**`, `__`, backticks, a leading `>` or list mark) taken
 * out. The whole text when it has no such block, and `""` for an empty one.
 */
export function reportFirstParagraph(text: string): string {
  const notProse = /^\s*(#{1,6}\s|[-*_]{3,}\s*$|```|~~~)/;
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) =>
      b
        .split("\n")
        .filter((l) => !notProse.test(l))
        .map((l) => l.replace(/^\s*(>\s?|[-*+]\s+|\d+[.)]\s+)/, "").trim())
        .filter(Boolean)
        .join(" ")
    )
    .filter(Boolean);
  return (blocks[0] ?? text.trim())
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The Costs card's Tempo lines (agent model, Jev, storage, RPC) and the two block numbers. */
export interface TempoServiceLines {
  /** The agent's model calls on the loop's channel: the steps' Tempo spend less Jev's part of it. */
  model: bigint;
  /** Jev's decisions on the same channel; Lath's, never the owner's. */
  jev: bigint;
  /**
   * The trace audit on the same channel, on a loop that ran with it (a roadmap feature this build does
   * not start): its Jev calls and any veto's confirm, Lath's decision spend like the verify seat's.
   * Zero on a loop that audits nothing.
   */
  trace: bigint;
  /** The committed PUTs' charges — the ones whose receipt names a transaction, which the owner is debited for. */
  storage: bigint;
  storageCount: number;
  /** What Lath's RPC session has paid for the loop's reads; `final` once its channel closed and said so. */
  rpc: bigint | null;
  rpcFinal: boolean;
  /** The newest snapshot's block, and the step it was read after. */
  readBlock?: { block: string; ofStep: number };
  /** The block the model channel's close settled in, from the stop record. */
  closeBlock?: string;
  /** The close transaction that block holds. */
  closeTx?: string;
}

/**
 * The lines, or `null` on a loop that has no Tempo services at all — no storage row, no snapshot,
 * no stop record naming them — which is every loop on the vault rail and every older loop that ran
 * without them, so their Costs card stays the card it was.
 */
export function tempoServiceLines(loop: Pick<LoopView, "history" | "tempo">): TempoServiceLines | null {
  const services: LoopTempoServicesStop | undefined = loop.tempo?.services;
  const snaps: StepSnapshot[] = loop.history.map((h) => h.tempoSnapshot).filter((s): s is StepSnapshot => !!s);
  if (services?.lastSnapshot) snaps.push(services.lastSnapshot);
  const stored = loop.history.map((h) => h.tempoStorage).filter((s): s is StepStorage => !!s);
  if (!services && snaps.length === 0 && stored.length === 0) return null;

  let tempo = BigInt(0);
  let jev = BigInt(0);
  let trace = BigInt(0);
  for (const h of loop.history) {
    tempo += baseOf(h.tempoSpent) ?? BigInt(0);
    jev += baseOf(jevCostBase(h)) ?? BigInt(0);
    trace += baseOf(traceCostBase(h)) ?? BigInt(0);
  }
  let storage = BigInt(0);
  let storageCount = 0;
  for (const s of stored) {
    // The same rule the runner debits by (`ownerBase`): a charge counts only when its receipt names
    // a Tempo transaction; a refused one moved nothing and a lost one names nothing to show.
    if (!s.reference) continue;
    storage += baseOf(s.amount) ?? BigInt(0);
    storageCount++;
  }

  let rpc: bigint | null = null;
  let rpcFinal = false;
  const closedSpent = services?.rpc?.closed ? baseOf(services.rpc.spent) : null;
  if (closedSpent !== null) {
    rpc = closedSpent;
    rpcFinal = true;
  } else {
    for (const s of snaps) {
      const c = baseOf(s.rpc?.cumulative);
      if (c !== null && (rpc === null || c > rpc)) rpc = c;
    }
  }

  let readBlock: TempoServiceLines["readBlock"];
  for (const s of snaps) {
    if (!s.block) continue;
    if (!readBlock || BigInt(s.block) > BigInt(readBlock.block)) readBlock = { block: s.block, ofStep: s.ofStep };
  }

  return {
    // The channel's spend less Lath's decisions — Jev's seats and, on a loop that ran the trace audit,
    // its calls too — which are what is left as the owner's model calls.
    model: tempo > jev + trace ? tempo - jev - trace : BigInt(0),
    jev,
    trace,
    storage,
    storageCount,
    rpc,
    rpcFinal,
    ...(readBlock ? { readBlock } : {}),
    ...(services?.closeBlock ? { closeBlock: services.closeBlock } : {}),
    ...(services?.closeBlock && loop.tempo?.txHash ? { closeTx: loop.tempo.txHash } : {}),
  };
}

// ─── The report the owner opens ──────────────────────────────────────────────

/** What `GET /api/loops/<id>/report` answers on a 200 (`_lib/loop-report.ts`). */
export interface LoopReportAnswer {
  step: number;
  /** The `storage.put` Action's seq on the loop's agent chain. */
  seq: string;
  /** The committed key (`<loopId>-<sha256>`), which the Action's args name. */
  key: string;
  /** The key the console read the bytes from: the committed one. */
  fetchedKey: string;
  /** What the Action commits: its `result_hash` (the report's SHA-256), `args_hash` and status, hex. */
  resultHash: string;
  argsHash: string;
  statusCode: number;
  /** The workspace path the step wrote its report at. */
  path: string;
  /** The report's bytes, base64: the console's own copy, or what Tempo storage answered. */
  bytes: string;
  size: number;
  /**
   * How the object was stored: always `plain`, because this console does not open encrypted reports.
   * Absent from an older console's answer.
   */
  encoding?: "plain";
  /** The object's size on Tempo storage. */
  storedSize?: number;
  /** What the console's GET cost the treasury, when the gateway charged for it: Lath's, not the owner's. */
  payment?: { amount: string; reference: string };
  /**
   * `store` when the bytes are this console's own plaintext copy, the `storage.put` record's result blob
   * from its trace store, and Tempo storage was not read: anyone may read that copy, as `/api/traces`
   * already serves it. Absent when Tempo storage answered.
   */
  from?: "store";
}

/** The verdict on an opened report. Only `ok` shows the text. */
export type LoopReportCheck =
  | { verdict: "ok"; text: string; hash: string }
  | { verdict: "bytes-mismatch"; hash: string; want: string }
  | { verdict: "record-mismatch"; hash: string }
  | { verdict: "no-record"; hash: string };

export interface LoopReportCheckDeps {
  /** SHA-256 of the bytes, hex: SubtleCrypto in the browser, the SDK's `sha256` in a test. */
  digest(bytes: Uint8Array): Promise<string> | string;
  /** The Action payload's hash, hex, rebuilt from its four fields (`hashPayload` over an Action). */
  payloadHashOf(p: { toolId: string; argsHash: string; resultHash: string; statusCode: number }): string;
  /** The record at `answer.seq` on the agent's chain, `null` when the indexer has none. */
  record: { payloadHash: string } | null;
}

/** The tool id a `storage.put` Action commits (`STORAGE_PUT_TOOL` in `runtime/src/loop-tempo.ts`). */
export const STORAGE_PUT_TOOL_ID = "storage.put";

/** Base64 to bytes, without `Buffer`: the page and the node suite run the same code. */
function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The browser's half: the bytes must hash to the `result_hash` the console named, and the chain's
 * record at that seq must be exactly the `storage.put` Action those hashes rebuild — so the hash is
 * the chain's, not the console's word. Either failing refuses the report; neither check trusts the
 * console, which only carried the bytes (it is the only reader Tempo storage lets in).
 */
export async function checkLoopReport(answer: LoopReportAnswer, deps: LoopReportCheckDeps): Promise<LoopReportCheck> {
  const bytes = base64Bytes(answer.bytes);
  const hash = (await deps.digest(bytes)).toLowerCase();
  if (hash !== answer.resultHash.toLowerCase()) return { verdict: "bytes-mismatch", hash, want: answer.resultHash };
  if (!deps.record) return { verdict: "no-record", hash };
  const rebuilt = deps.payloadHashOf({
    toolId: STORAGE_PUT_TOOL_ID,
    argsHash: answer.argsHash,
    resultHash: hash,
    statusCode: answer.statusCode,
  });
  if (rebuilt.toLowerCase() !== deps.record.payloadHash.toLowerCase()) return { verdict: "record-mismatch", hash };
  return { verdict: "ok", text: new TextDecoder().decode(bytes), hash };
}

// ─── The loop page's Tempo side, as figures ──────────────────────────────────

/** `a` and `b` are the same channel id or address: hex compares without case. */
function sameHex(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * The loop's open payment channel and how full it is: _Payment channel open since step k ·
 * X of Y USDC.e used_. `null` when no channel is open — the vault rail, a run before its first paid
 * call, and every run once its channel settled, which is when the console clears `loop.channel`.
 *
 * Two halves, from two places, and the page tags each: `used` is the console's own record of the
 * cumulative after the last paid call (`loop.channel.cumulative`, which moves on every poll while a
 * step pays), and `deposit` is what Tempo's escrow held for the channel when the console last read
 * it after a step (`tempoSnapshot.channel.deposit` at its `block`). A deposit is read only from a
 * snapshot of this same channel: one of a channel the loop closed before cannot size this one. With
 * no readable deposit there is no denominator, so `fraction` is `null` and the bar is not drawn
 * rather than drawn against a guess.
 */
export interface OpenChannelFill {
  channelId: string;
  openedAtStep: number;
  /** The console's cumulative, base units. */
  usedBase: bigint;
  /** Tempo's deposit for the channel at `depositBlock`, base units; `null` when no snapshot read one. */
  depositBase: bigint | null;
  /** What the escrow had settled on the channel at the same read, base units. */
  settledBase: bigint | null;
  depositBlock?: string;
  depositOfStep?: number;
  /** `used / deposit`, 0–1, or `null` without a deposit. */
  fraction: number | null;
  used: string;
  deposit: string | null;
}

export function openChannelFill(loop: Pick<LoopView, "channel" | "history" | "tempo">): OpenChannelFill | null {
  const ch = loop.channel;
  if (!ch || !ch.channelId) return null;
  // A settled loop can still carry the row for a poll; the channel is not open once its close is.
  if (loop.tempo?.closed && sameHex(loop.tempo.channelId, ch.channelId)) return null;
  let snap: StepSnapshot | undefined;
  for (const h of loop.history) {
    const s = h.tempoSnapshot;
    if (!s?.channel || !sameHex(s.channel.id, ch.channelId) || baseOf(s.channel.deposit) === null) continue;
    if (!snap || s.ofStep >= snap.ofStep) snap = s;
  }
  const usedBase = baseOf(ch.cumulative) ?? baseOf(snap?.channel?.cumulative) ?? BigInt(0);
  const depositBase = baseOf(snap?.channel?.deposit);
  const settledBase = baseOf(snap?.channel?.settled);
  const fraction =
    depositBase !== null && depositBase > BigInt(0) ? Math.min(1, Number(usedBase) / Number(depositBase)) : null;
  return {
    channelId: ch.channelId,
    openedAtStep: ch.openedAtStep,
    usedBase,
    depositBase,
    settledBase,
    ...(snap?.block ? { depositBlock: snap.block } : {}),
    ...(snap ? { depositOfStep: snap.ofStep } : {}),
    fraction,
    used: usdcEOfBase(usedBase)!,
    deposit: depositBase === null ? null : usdcEOfBase(depositBase),
  };
}

/** One point of the treasury's balance, read from Tempo after a step. */
export interface TreasuryPoint {
  step: number;
  block?: string;
  usdcEBase: bigint;
}

/**
 * The treasury's USDC.e balance after each step, as the console read it from Tempo
 * (`tempoSnapshot.treasury.usdcE` at `block`), step 1 first; the stop record's last snapshot is a
 * point too. One point per step — a step read twice keeps its later read — and a snapshot with no
 * readable balance is no point, rather than a zero the treasury never held.
 */
export function treasurySeries(loop: Pick<LoopView, "history" | "tempo">): TreasuryPoint[] {
  const snaps: StepSnapshot[] = loop.history.map((h) => h.tempoSnapshot).filter((s): s is StepSnapshot => !!s);
  const last = loop.tempo?.services?.lastSnapshot;
  if (last) snaps.push(last);
  const byStep = new Map<number, TreasuryPoint>();
  for (const s of snaps) {
    const v = baseOf(s.treasury?.usdcE);
    if (v === null) continue;
    byStep.set(s.ofStep, { step: s.ofStep, usdcEBase: v, ...(s.block ? { block: s.block } : {}) });
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

/** Whose cost a Tempo payment is: the treasury pays every one, and this says who it is billed to. */
export type TempoPayer = "owner" | "lath";

/** A Tempo transaction a payment row links to. */
export interface TempoTxRef {
  hash: string;
  /** What the link reads as: `settled`, `step 3`. */
  label: string;
  kind: "settlement" | "storage" | "rpc";
}

/** One row of the _Paid on Tempo_ card: a service, who it is billed to, the amount, its txs. */
export interface TempoPaymentRow {
  id: "model" | "jev" | "trace" | "storage" | "rpc";
  payer: TempoPayer;
  amountBase: bigint | null;
  /** `0.0112 USDC.e`, or `null` for a figure that was never read. */
  amount: string | null;
  /** One short line: `settled on Tempo`, `2 reports published`, `so far, on its open session`. */
  note: string;
  txs: TempoTxRef[];
}

export interface TempoPayments {
  rows: TempoPaymentRow[];
  readBlock?: { block: string; ofStep: number };
  closeBlock?: string;
}

/**
 * The _Paid on Tempo_ card's rows, per service and payer, with every transaction the page
 * holds for each: the model channel's close for the three services that ride it (the agent's model,
 * the decision model, the trace audit), each committed storage PUT, and the RPC session's own close
 * (`services.rpc.txHash`).
 *
 * `tempoServiceLines` decides the figures. An older loop that paid on Tempo without the services
 * has no lines, and gets its channel rows from its step rows alone, so its card
 * still says what the channel paid; a loop that paid nothing on Tempo gets `null` and no card.
 */
export function tempoPayments(loop: Pick<LoopView, "history" | "tempo">): TempoPayments | null {
  let lines = tempoServiceLines(loop);
  if (!lines) {
    let tempo = BigInt(0);
    let jev = BigInt(0);
    let trace = BigInt(0);
    for (const h of loop.history) {
      tempo += baseOf(h.tempoSpent) ?? BigInt(0);
      jev += baseOf(jevCostBase(h)) ?? BigInt(0);
      trace += baseOf(traceCostBase(h)) ?? BigInt(0);
    }
    if (tempo === BigInt(0) && !loop.tempo) return null;
    lines = {
      model: tempo > jev + trace ? tempo - jev - trace : BigInt(0),
      jev,
      trace,
      storage: BigInt(0),
      storageCount: 0,
      rpc: null,
      rpcFinal: false,
    };
  }
  const closeTx = loop.tempo?.closed && loop.tempo.txHash ? loop.tempo.txHash : null;
  const settlement: TempoTxRef[] = closeTx ? [{ hash: closeTx, label: "settled", kind: "settlement" }] : [];
  const channelNote = closeTx ? "settled on Tempo" : "on the loop's payment channel";
  const rows: TempoPaymentRow[] = [
    {
      id: "model",
      payer: "owner",
      amountBase: lines.model,
      amount: usdcEOfBase(lines.model),
      note: channelNote,
      txs: settlement,
    },
    {
      id: "jev",
      payer: "lath",
      amountBase: lines.jev,
      amount: usdcEOfBase(lines.jev),
      note: channelNote,
      txs: settlement,
    },
  ];
  // The trace audit's row only on a loop that paid for one, so every other card is the card it was.
  if (lines.trace > BigInt(0)) {
    rows.push({
      id: "trace",
      payer: "lath",
      amountBase: lines.trace,
      amount: usdcEOfBase(lines.trace),
      note: channelNote,
      txs: settlement,
    });
  }
  const puts: TempoTxRef[] = [];
  for (const h of loop.history) {
    const s = h.tempoStorage;
    // The rule `tempoServiceLines` counts by: a PUT is a payment when its receipt names a transaction.
    if (s?.reference) puts.push({ hash: s.reference, label: `step ${h.step}`, kind: "storage" });
  }
  rows.push({
    id: "storage",
    payer: "owner",
    amountBase: lines.storage,
    amount: usdcEOfBase(lines.storage),
    note: `${lines.storageCount} ${lines.storageCount === 1 ? "report" : "reports"} published`,
    txs: puts,
  });
  const rpc = loop.tempo?.services?.rpc;
  rows.push({
    id: "rpc",
    payer: "lath",
    amountBase: lines.rpc,
    amount: lines.rpc === null ? null : usdcEOfBase(lines.rpc),
    note: lines.rpcFinal ? "settled when its session closed" : "so far, on its open session",
    txs: rpc?.closed && rpc.txHash ? [{ hash: rpc.txHash, label: "settled", kind: "rpc" }] : [],
  });
  return {
    rows,
    ...(lines.readBlock ? { readBlock: lines.readBlock } : {}),
    ...(lines.closeBlock ? { closeBlock: lines.closeBlock } : {}),
  };
}

/**
 * The money flow's figures for one loop: what the treasury has paid on the
 * loop's model channel — which is what OpenRouter is paid through its Tempo gateway — and how much of
 * it is the owner's model calls and how much Lath's decisions.
 *
 * `channelPaid` is the console's cumulative while the channel is open (it moves call by call), the
 * settlement's `spent` once it closed, and the step rows' sum otherwise. `state` says which, so the
 * page words the boxes _so far_, _settled_ or nothing yet. `scripted` is a run whose steps paid
 * nothing because no model key was accepted: _not paid (scripted)_, not a zero.
 */
export interface MoneyFlowFigures {
  state: "open" | "settled" | "none";
  channelPaid: bigint | null;
  /** The owner's model calls on the channel, base units. */
  model: bigint;
  /** Lath's decision model on the channel — its seats and the trace audit — base units. */
  decisions: bigint;
  /** Steps that paid anything on Tempo. */
  paidSteps: number;
  openedAtStep?: number;
  channelId?: string;
  payer?: string;
  settleTx?: string;
  scripted: boolean;
}

export function moneyFlowFigures(
  loop: Pick<LoopView, "history" | "tempo" | "channel" | "inference">
): MoneyFlowFigures {
  let sum = BigInt(0);
  let jev = BigInt(0);
  let trace = BigInt(0);
  let paidSteps = 0;
  for (const h of loop.history) {
    const t = baseOf(h.tempoSpent) ?? BigInt(0);
    if (t > BigInt(0)) paidSteps++;
    sum += t;
    jev += baseOf(jevCostBase(h)) ?? BigInt(0);
    trace += baseOf(traceCostBase(h)) ?? BigInt(0);
  }
  const decisions = jev + trace;
  const model = sum > decisions ? sum - decisions : BigInt(0);
  const ch = loop.channel;
  if (ch?.channelId && !(loop.tempo?.closed && sameHex(loop.tempo.channelId, ch.channelId))) {
    // The console's cumulative leads the step rows while a step is paying; the rows' sum is the floor.
    const c = baseOf(ch.cumulative);
    return {
      state: "open",
      channelPaid: c !== null && c > sum ? c : sum,
      model,
      decisions,
      paidSteps,
      openedAtStep: ch.openedAtStep,
      channelId: ch.channelId,
      payer: ch.payer,
      scripted: false,
    };
  }
  if (loop.tempo?.closed && loop.tempo.txHash) {
    return {
      state: "settled",
      channelPaid: baseOf(loop.tempo.spent) ?? sum,
      model,
      decisions,
      paidSteps,
      ...(loop.tempo.channelId ? { channelId: loop.tempo.channelId } : {}),
      payer: loop.tempo.payer,
      settleTx: loop.tempo.txHash,
      scripted: false,
    };
  }
  return {
    state: "none",
    channelPaid: sum > BigInt(0) ? sum : null,
    model,
    decisions,
    paidSteps,
    ...(loop.tempo?.channelId ? { channelId: loop.tempo.channelId } : {}),
    ...(loop.tempo?.payer ? { payer: loop.tempo.payer } : {}),
    scripted: !loop.tempo && sum === BigInt(0) && loop.inference === "scripted",
  };
}
