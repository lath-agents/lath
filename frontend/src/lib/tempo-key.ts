/**
 * The loop page's words for its Tempo access key:
 * the key, its limit and what is left of it, the expiry, whether Tempo revoked it, and the one
 * sentence that says what the limit covers.
 *
 * Pure and browser-safe, with relative imports of `types/` only, so the node suite
 * (`tests/loop-tempo-key.ts`) holds the text without React. The component that draws it is
 * `components/LoopTempoKey.tsx`; the explorer link is built there from `authorizeTx`, through
 * `lib/tempo.ts`, which this module does not import because that one pulls react-query.
 */
import { LOOP_STOP_REASON_TEXT, type LoopTempoKeyView, type LoopView } from "../types/loop";

/** USDC.e and µUSDC both carry six decimals, so one budget figure and one limit compare as they are. */
const DECIMALS = 6;

/** Said in place of a figure Tempo did not give: not `0`, which would read as a spent key. */
export const NOT_READABLE = "not readable";

/** `0x1234…abcd`: the four hex digits either side, the way an address is told apart at a glance. */
export function shortTempoAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(address) || address.length <= 2 + 4 + 4 + 1) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Base units to `1.150000 USDC.e`, exact, never through a float. `null` for anything that is not a
 * whole non-negative number of base units: a limit is exact or it is not shown.
 */
export function usdcEOfBase(base: string | null | undefined): string | null {
  if (typeof base !== "string" || !/^\d+$/.test(base)) return null;
  const v = BigInt(base);
  const unit = BigInt(10) ** BigInt(DECIMALS);
  return `${v / unit}.${(v % unit).toString().padStart(DECIMALS, "0")} USDC.e`;
}

/**
 * The loop's frozen Jev share as a percentage of its budget, from the two figures the view carries
 * (`jevBudgetBase` beside `budgetMicroUsdc`), rather than the 15 the console defaults to: the share
 * is `LATH_JEV_BUDGET_PERCENT` at the loop's start, and an operator may have set another. Read to
 * one decimal and trimmed, because the console floors `budget × pct / 100` to a base unit and the
 * ratio of the two comes back a hair under the percentage it was made from. `null` when either
 * figure is missing or the budget is nothing, which leaves no ratio to read.
 */
export function jevSharePercent(loop: Partial<Pick<LoopView, "budgetMicroUsdc" | "jevBudgetBase">>): string | null {
  const budget = loop.budgetMicroUsdc;
  const jev = loop.jevBudgetBase;
  if (typeof budget !== "string" || typeof jev !== "string" || !/^\d+$/.test(budget) || !/^\d+$/.test(jev)) {
    return null;
  }
  const b = BigInt(budget);
  if (b === BigInt(0)) return null;
  // Tenths of a percent, rounded half up: `(jev × 1000 + b / 2) / b`.
  const tenths = (BigInt(jev) * BigInt(1000) + b / BigInt(2)) / b;
  const whole = tenths / BigInt(10);
  const frac = tenths % BigInt(10);
  return frac === BigInt(0) ? whole.toString() : `${whole}.${frac}`;
}

/**
 * What the key's limit covers: the loop's channel at start, sized by the same function that
 * sizes `maxDeposit` — the owner's budget plus Lath's Jev share. "At most", because the share is a
 * ceiling on what Lath may spend on decisions, not a figure it spends. Without a readable share the
 * sentence names it without a number rather than guess one.
 */
export function tempoKeyCoversText(loop: Partial<Pick<LoopView, "budgetMicroUsdc" | "jevBudgetBase">>): string {
  const pct = jevSharePercent(loop);
  return pct === null
    ? "the loop's budget plus its share for decisions, which Lath pays"
    : `the loop's budget plus at most ${pct} % for its decisions, which Lath pays`;
}

/** Unix seconds as `2026-11-02 14:05 UTC`: a fixed zone, so every reader and the test read one date. */
export function tempoKeyDate(expirySecs: number): string {
  if (!Number.isFinite(expirySecs) || expirySecs <= 0) return "—";
  return `${new Date(expirySecs * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Where the key stands. `revoked` is Tempo's word and wins: a revoked key is refused whatever its
 * expiry says. `expired` is the committed expiry against the reader's clock, which needs no answer
 * from Tempo. `unknown` is Tempo not answering, said as that, never as `active`.
 */
export type TempoKeyState = "active" | "expired" | "revoked" | "unknown";

/**
 * The contracts and selectors a scoped loop key is authorized for, named for the page. They are the ones
 * `_lib/tempo-keys.ts` `loopKeyScopes` authorizes — the channel escrow's `open` and `topUp`, and USDC.e
 * `transferWithMemo` to the storage payee — copied here because this module stays free of server imports;
 * anything else is shown as its raw hex, so a scope the page does not know is still shown rather than
 * hidden.
 */
const SCOPE_TARGETS: Record<string, string> = {
  "0x4d50500000000000000000000000000000000000": "the channel escrow",
  "0x20c000000000000000000000b9537d11c60e8b50": "USDC.e",
};
const SCOPE_SELECTORS: Record<string, string> = {
  "0xedc53b00": "open",
  "0xdc48471e": "top-up",
  "0x95777d59": "transferWithMemo",
};

/**
 * What a scoped key may call, in one sentence: `can call only the channel escrow (open, top-up) and
 * USDC.e (transferWithMemo to 0xca4e…79fe)`. `null` for an unscoped key, which draws no line.
 */
export function tempoKeyScopesText(scopes: LoopTempoKeyView["scopes"]): string | null {
  if (!Array.isArray(scopes)) return null;
  if (scopes.length === 0) return "can call nothing";
  const groups = new Map<string, { selectors: string[]; recipients: string[] }>();
  for (const s of scopes) {
    const target = String(s.address).toLowerCase();
    const g = groups.get(target) ?? { selectors: [], recipients: [] };
    if (s.selector) g.selectors.push(SCOPE_SELECTORS[s.selector.toLowerCase()] ?? s.selector.toLowerCase());
    for (const r of s.recipients ?? []) if (!g.recipients.includes(r.toLowerCase())) g.recipients.push(r.toLowerCase());
    groups.set(target, g);
  }
  const parts = [...groups].map(([target, g]) => {
    const calls = g.selectors.length ? g.selectors.join(", ") : "any call";
    const to = g.recipients.length ? ` to ${g.recipients.map(shortTempoAddress).join(", ")}` : "";
    return `${SCOPE_TARGETS[target] ?? shortTempoAddress(target)} (${calls}${to})`;
  });
  return `can call only ${parts.join(" and ")}`;
}

/** Everything the page draws for the key, as text. */
export interface TempoKeyLine {
  address: string;
  short: string;
  limit: string;
  remaining: string;
  /** False when Tempo did not answer, so the page can mute the figure. */
  remainingReadable: boolean;
  expires: string;
  state: TempoKeyState;
  /** `expires 2026-11-02 14:05 UTC`, `expired …`, `revoked`, or `revocation not readable`. */
  stateText: string;
  authorizeTx: string | null;
  /** What a scoped key may call, or `null` for an unscoped one. */
  scopes: string | null;
  /** The `tempoKeyCoversText` sentence, with the loop's own share. */
  covers: string;
  /** The whole line, one sentence: what a test pins and what the row's title repeats. */
  text: string;
}

export function tempoKeyLine(
  key: LoopTempoKeyView,
  loop: Partial<Pick<LoopView, "budgetMicroUsdc" | "jevBudgetBase">>,
  nowSecs: number
): TempoKeyLine {
  const limit = usdcEOfBase(key.limitBase) ?? NOT_READABLE;
  const remainingFigure = usdcEOfBase(key.remaining);
  const expires = tempoKeyDate(key.expiry);
  const expired = Number.isFinite(key.expiry) && key.expiry > 0 && key.expiry <= nowSecs;
  const state: TempoKeyState =
    key.isRevoked === true ? "revoked" : expired ? "expired" : key.isRevoked === null ? "unknown" : "active";
  const stateText =
    state === "revoked"
      ? "revoked"
      : state === "expired"
      ? `expired ${expires}`
      : state === "unknown"
      ? `expires ${expires}, revocation not readable`
      : `expires ${expires}`;
  const short = shortTempoAddress(key.address);
  const remaining = remainingFigure ?? NOT_READABLE;
  const covers = tempoKeyCoversText(loop);
  const scopes = tempoKeyScopesText(key.scopes);
  return {
    address: key.address,
    short,
    limit,
    remaining,
    remainingReadable: remainingFigure !== null,
    expires,
    state,
    stateText,
    authorizeTx: key.authorizeTx ?? null,
    scopes,
    covers,
    text:
      `Tempo-enforced cap: key ${short}, limit ${limit}, remaining ${remaining}, ${stateText}. The limit covers ${covers}.` +
      (scopes ? ` The key ${scopes}.` : ""),
  };
}

/**
 * The four stops the loop's key can cause, in words: the entries of
 * `LOOP_STOP_REASON_TEXT` for them, so the tiles and this page say the same sentence.
 */
export const TEMPO_KEY_STOP_TEXT: Record<string, string> = Object.fromEntries(
  ["tempo-key-limit", "tempo-key-expired", "tempo-key-missing", "tempo-key-refused"].map((r) => [
    r,
    LOOP_STOP_REASON_TEXT[r],
  ])
);

/** The sentence for a key stop, or `undefined` for any other reason. */
export function tempoKeyStopText(reason: string | null | undefined): string | undefined {
  return reason ? TEMPO_KEY_STOP_TEXT[reason] : undefined;
}
