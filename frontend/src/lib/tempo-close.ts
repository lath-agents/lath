/**
 * What a Tempo close receipt must say before the browser's badge may read VERIFIED — the same
 * three facts `lath-audit verify-inference` checks (`closeProblem`, `sdk/src/audit.ts`), minus the
 * amount.
 *
 * A badge that read VERIFIED for any receipt with `status: 0x1` would pass a successful
 * transaction to anything, closing anything. So this asks the receipt, as the audit
 * does, that it (1) succeeded, (2) was sent to the escrow, and (3) carries a `ChannelClosed` log
 * *the escrow emitted* for *this* channel, against *this* payer when the record names one — looked
 * up among every such log on the receipt, as the SDK's `closedLogFor` does, since one settlement
 * transaction may close several channels. The
 * amount — `finalAmount ≥ cumulativeAfter` — stays the audit's job: it needs the voucher the
 * record committed and the full event data, and the copy-pasteable line beside the badge is
 * where a reader gets it.
 *
 * No viem and no ABI decoder: `ChannelClosed(bytes32 indexed channelId, address indexed payer,
 * address indexed payee, uint96 finalAmount, uint96 refund)` puts the two things compared here in
 * `topics[1]` and `topics[2]`, which are plain hex. viem never reaches the browser bundle.
 * The rest of the event — the payee in `topics[3]`, `finalAmount` and `refund` as the two words of
 * `data` — is `closeReceiptDetails`, read for the page to *show*; the verdict above does not
 * depend on it.
 *
 * The two constants below duplicate the SDK's, and `tests/tempo-verify.ts` pins both against it —
 * `channelClosedTopic()` computed by viem, and `TEMPO_ESCROW` — so they cannot drift silently.
 * No React and no network here, so `tests/console-reader.ts` checks the rule itself.
 */

/** `topic0` of `ChannelClosed(bytes32,address,address,uint96,uint96)`: keccak256 of the signature. */
export const CHANNEL_CLOSED_TOPIC = "0x5613aed96d5bf39f928408dbe1d4143490b9bb5957eac2dd8e69b5dc4b2206e6";

/** The Tempo payment-channel escrow, as `sdk/src/audit.ts` `TEMPO_ESCROW` names it. */
export const TEMPO_ESCROW_ADDRESS = "0x4d50500000000000000000000000000000000000";

/** The fields of an `eth_getTransactionReceipt` result this reads, as the RPC returns them. */
export interface RpcCloseReceipt {
  status?: string | null;
  to?: string | null;
  logs?: readonly { address?: string | null; topics?: readonly string[] | null; data?: string | null }[] | null;
}

const lower = (v: string | null | undefined) => (v ?? "").toLowerCase();

/** An indexed `address` topic is 32 bytes, left-padded: the address is its last twenty. */
function addressOfTopic(topic: string): string {
  const h = lower(topic).replace(/^0x/, "");
  return `0x${h.slice(-40)}`;
}

/**
 * `null` when the receipt closes `channelId` at the escrow (and against `payer`, when given), or a
 * sentence saying which of those it does not. Worded after `closeProblem`, so the badge's title
 * and the audit's line say the same thing about the same receipt.
 */
export function closeReceiptProblem(receipt: RpcCloseReceipt, channelId: string, payer?: string | null): string | null {
  if (receipt.status !== "0x1") return `the settlement transaction reverted (status ${receipt.status ?? "unknown"})`;
  if (lower(receipt.to) !== TEMPO_ESCROW_ADDRESS) {
    return `the settlement was sent to ${
      receipt.to ?? "a contract creation"
    }, not to the escrow ${TEMPO_ESCROW_ADDRESS}`;
  }
  // Only a log the escrow itself emitted counts: anyone may emit an event with the same topic.
  const closures = (receipt.logs ?? []).filter(
    (l) => lower(l.address) === TEMPO_ESCROW_ADDRESS && lower(l.topics?.[0]) === CHANNEL_CLOSED_TOPIC
  );
  // This channel's close wherever it sits on the receipt — the SDK's `closedLogFor` rule. Taking
  // the first one failed the second channel's honest close on a transaction that settled several,
  // while `lath-audit` verified it. The first is kept only to name what was closed when none of
  // them is this channel's.
  const closed = closures.find((l) => lower(l.topics?.[1]) === lower(channelId)) ?? closures[0];
  if (!closed || !closed.topics || closed.topics.length < 3) {
    return "the settlement closed no channel: its receipt carries no ChannelClosed log from the escrow";
  }
  const closedChannel = lower(closed.topics[1]);
  if (closedChannel !== lower(channelId))
    return `the settlement closed channel ${closedChannel}, not ${lower(channelId)}`;
  const closedPayer = addressOfTopic(closed.topics[2]);
  if (payer && closedPayer !== lower(payer)) {
    return `channel ${lower(channelId)} was closed against payer ${closedPayer}, not ${lower(payer)}`;
  }
  return null;
}

/**
 * What the escrow's `ChannelClosed` says a close paid out, read off the receipt in this browser:
 * whom (`payee`, `topics[3]`), how much (`finalAmount`, the first word of `data`) and what went back to the
 * payer (`refund`, the second). Base units of USDC.e as decimal strings, since a `uint96` does not fit a
 * `number`.
 */
export interface CloseReceiptDetails {
  payee: string;
  finalAmountBase: string;
  refundBase: string;
}

/** One ABI word holding a `uint96`: the value is its low twelve bytes, and the high twenty are zero. */
function uint96Word(word: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(word)) return null;
  // A word with anything in its high bytes is not an encoded `uint96`: a log that only shares the
  // topic, or a layout this does not know. Reading its low bytes would print a number nobody paid.
  if (!/^0{40}$/.test(word.slice(0, 40))) return null;
  return BigInt(`0x${word}`).toString();
}

/**
 * The payee, `finalAmount` and refund of the close of `channelId` in `receipt`, or `null` when the
 * receipt does not carry a well-formed one.
 *
 * The same event `closeReceiptProblem` reads, decoded further. `ChannelClosed(bytes32 indexed
 * channelId, address indexed payer, address indexed payee, uint96 finalAmount, uint96 refund)`
 * (`CHANNEL_CLOSED_SIGNATURE`, `ESCROW_ABI` in `sdk/src/tempo.ts`) puts the payee in `topics[3]`,
 * and the two unindexed `uint96`s in `data` as two 32-byte words, in that order; `tests/tempo-close.ts`
 * holds this against the SDK's viem decoder over a real mainnet close receipt.
 *
 * Like `closeReceiptProblem`, this looks for the `ChannelClosed` naming `channelId`: a gateway's
 * close transaction may close several channels, and another channel's `finalAmount` is
 * not this one's. Only a log the escrow emitted counts, and only
 * on a receipt that succeeded. This says what the log says and judges nothing: whether the close
 * is this record's, its payer and its `to` are `closeReceiptProblem`'s, and a caller shows these
 * figures beside that verdict, not instead of it.
 */
export function closeReceiptDetails(receipt: RpcCloseReceipt, channelId: string): CloseReceiptDetails | null {
  if (receipt.status !== "0x1" || !channelId) return null;
  const log = (receipt.logs ?? []).find(
    (l) =>
      lower(l.address) === TEMPO_ESCROW_ADDRESS &&
      lower(l.topics?.[0]) === CHANNEL_CLOSED_TOPIC &&
      lower(l.topics?.[1]) === lower(channelId)
  );
  if (!log?.topics || log.topics.length < 4) return null;
  const data = lower(log.data).replace(/^0x/, "");
  if (data.length !== 128) return null;
  const finalAmountBase = uint96Word(data.slice(0, 64));
  const refundBase = uint96Word(data.slice(64));
  if (finalAmountBase === null || refundBase === null) return null;
  return { payee: addressOfTopic(log.topics[3]), finalAmountBase, refundBase };
}

/**
 * Whether a close paid at least what the chain's last voucher on the channel committed
 * (`cumulativeAfter`), the amount half of `closeProblem` (`finalAmount ≥ cumulativeAfter`). `null`
 * when either side is missing or unreadable, so a caller says nothing rather than a guess. The
 * page that holds every voucher of the channel passes the last one; one that holds some of them
 * can only say the close covers those.
 */
export function closeCoversCumulative(
  details: CloseReceiptDetails | null | undefined,
  cumulativeAfter: string | bigint | null | undefined
): boolean | null {
  if (!details || cumulativeAfter === null || cumulativeAfter === undefined || cumulativeAfter === "") return null;
  try {
    return BigInt(details.finalAmountBase) >= BigInt(cumulativeAfter);
  } catch {
    return null;
  }
}

/** What a session's or a loop's close left behind: the Resolution's (or `loop.settlement`'s) blob. */
export interface TempoSettlementView {
  txHash?: string | null;
  spent?: string | null;
  channelId?: string | null;
  /** The treasury that paid, on every settlement the runtime writes (`closeTempo`). */
  payer?: string | null;
  closed?: boolean;
  error?: string | null;
}

/**
 * The settlement a close left on chain, from either record that can carry one — a session's
 * Resolution, whose output object holds `settlement: { txHash, spent }`, or a loop's
 * `Action{tool_id: "loop.settlement"}`, whose result blob *is* the settlement. Both shapes are read here so
 * a panel does not have to know which kind of run it is looking at.
 */
export function settlementFromBlob(bytes: Uint8Array | undefined): TempoSettlementView | null {
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const settlement = body?.settlement ?? (body?.channelId || body?.closed !== undefined ? body : null);
    if (!settlement) return null;
    return settlement.txHash || settlement.closed !== undefined ? (settlement as TempoSettlementView) : null;
  } catch {
    return null;
  }
}

/**
 * One record after a paid call that can carry a settlement, as a reader has it so far:
 * `undefined` while its blobs are still being read, `null` once read and carrying none.
 */
export interface SettlementCandidate {
  /** A `loop.settlement` Action, which is a settlement by its tool id; otherwise a Resolution. */
  loop: boolean;
  settlement: TempoSettlementView | null | undefined;
  /**
   * The record sits in a session that opened after the paid call's — a Genesis lies between the
   * two. A Resolution there closes another session and is never this call's close. Optional: a
   * reader that does not say leaves the first Resolution after the call as the call's own, which is
   * wrong only for a session that never resolved at all.
   */
  laterSession?: boolean;
}

/**
 * Which settlement covers a call paid on `channelId`, given the candidates the chain wrote after
 * it in seq order — the rule `lath-audit verify-inference` walks (`sdk/src/audit/inference.ts`,
 * step 3), so the badge and the audit line pick the same close.
 *
 * A Resolution settles only the session it closes. A one-shot session's close can fail and leave
 * its Resolution with no settlement, and the next session's Resolution then carries *its*
 * close, often with no channel named — so "the first settlement after this seq" would pin that
 * close on this call. Resolutions are therefore read only while this
 * call's session is open: the first one is its own, and one past a Genesis (`laterSession`) is
 * not. Once the session is over only a `loop.settlement` counts, which is what settles a loop
 * step's calls many Resolutions later. An own Resolution that names no settlement leaves
 * the answer PENDING unless a loop's settlement follows — never another session's close.
 *
 * A settlement naming another channel is skipped rather than judged against, from either kind of
 * record: a loop can open a second channel after a close. One naming no channel — an older one-shot
 * Resolution carries `{ txHash, spent }` only — is this call's, because it
 * closes the session this call was paid in. Two things stop the walk with no answer instead of
 * reading past them, because reading past would pin this call on a later channel's close: a
 * candidate not yet read (other than a Resolution the session rule has already ruled out), and a
 * `loop.settlement` whose bytes this reader could not open. `null` reads PENDING on screen, which
 * is what a call whose close this page cannot show yet is.
 *
 * A close that did not happen (`closed: false`, no transaction) is returned only when it names
 * this channel, so the block can say the channel was left open; the audit skips those, having no
 * transaction to check.
 */
export function settlementCovering(
  channelId: string | null | undefined,
  candidates: readonly SettlementCandidate[]
): TempoSettlementView | null {
  if (!channelId) return null;
  let sessionOver = false;
  for (const c of candidates) {
    if (c.laterSession) sessionOver = true;
    if (!c.loop) {
      // Past this call's session a Resolution is another session's, read or not.
      if (sessionOver) continue;
      if (c.settlement === undefined) return null;
      // Read: this is the call's own Resolution whatever it says, and the last one that counts.
      sessionOver = true;
    } else if (!c.settlement) {
      return null;
    }
    const settlement = c.settlement;
    if (!settlement) continue;
    const named = settlement.channelId;
    if (named && lower(named) !== lower(channelId)) continue;
    if (!settlement.txHash) {
      if (named && settlement.closed === false) return settlement;
      continue;
    }
    return settlement;
  }
  return null;
}
