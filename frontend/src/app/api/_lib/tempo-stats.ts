/**
 * What the operator's Tempo treasury has paid on Tempo mainnet, read from Tempo itself: the core
 * `scripts/tempo-stats.ts` prints and `GET /api/tempo/stats` serves. One copy, so the Tempo tab and
 * the script's Tempo line cannot disagree about what a row means.
 *
 * Two public sources and nothing else:
 *
 * - the address's activity feed on `api.tempo.xyz` — channel opens, channel top-ups, refunds the
 *   escrow sends back at a close, storage charges (attributed "Object Storage"), and the owner's
 *   top-ups of the treasury;
 * - per channel, `getChannelState` on the escrow precompile. A closed channel reads as zeros and an
 *   open one still holds what it has not settled, so this read is what separates money paid from
 *   money parked.
 *
 * Nothing is signed and nothing is spent, and nothing here holds a key: the caller hands in the
 * address. The module imports only the SDK's constants, the route's response type and
 * `./json-store` (`fs` and `path`, nothing else), and no other `_lib` sibling, because the script
 * loads it too and `runner.ts` behind `./tempo` would cost the script its start-up and print its
 * own lines into `--json`.
 *
 * What it cannot say: how many model calls those channels paid. Vouchers never reach the chain, so
 * the call count lives in the Solana records (`lath-audit verify-channel`), not here. And the
 * figures are the treasury's, whoever's loop spent them — the line that quotes them must say who
 * ran those loops.
 */
import { TEMPO_ESCROW, TEMPO_USDC_E } from "@lath/sdk";
import { readJsonOr, writeJsonAtomic } from "./json-store";
import {
  TEMPO_STATS_RECENT_LIMIT,
  type TempoStats,
  type TempoStatsActivity,
  type TempoStatsError,
} from "../../../types/tempo-stats";

export const TEMPO_API_URL = "https://api.tempo.xyz";

/** The attribution Tempo's feed gives a storage PUT's charge. */
const STORAGE_ATTRIBUTION = "Object Storage";

/** One row of `GET /v1/addresses/{a}/activities`, as much of it as the figures read. */
export interface Activity {
  /** Tempo's own id for the row, `<transaction hash>-<log index>`; what an incremental read matches on. */
  id?: string;
  type: string;
  perspective?: string;
  timestamp: string;
  transactionHash?: string;
  data?: {
    channelId?: string;
    attribution?: string | null;
    sender?: string;
    recipient?: string;
    sourceAmount?: { baseUnits?: string };
    sourceToken?: { address?: string };
  };
}

export type Kind = "channel-open" | "channel-fund" | "refund" | "storage" | "topup" | "other-out" | "other";

export interface Classified {
  kind: Kind;
  base: bigint;
  at: string;
  channelId?: string;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Sorts a feed row into what it means for the treasury. A row in any token but USDC.e is
 * `other`: the treasury pays in USDC.e only, so anything else is not a payment the figures describe.
 */
export function classify(row: Activity): Classified {
  const base = BigInt(row.data?.sourceAmount?.baseUnits ?? "0");
  const at = row.timestamp;
  const channelId = row.data?.channelId;
  const usdc = same(row.data?.sourceToken?.address, TEMPO_USDC_E);
  if (!usdc) return { kind: "other", base, at };
  if (row.type === "channel-opened") return { kind: "channel-open", base, at, ...(channelId ? { channelId } : {}) };
  if (row.type === "channel-funded") return { kind: "channel-fund", base, at, ...(channelId ? { channelId } : {}) };
  if (row.type === "transfer" && row.perspective === "incoming") {
    // The escrow pays a channel's unspent deposit back at its close; anyone else sending
    // USDC.e here is topping the treasury up.
    return { kind: same(row.data?.sender, TEMPO_ESCROW) ? "refund" : "topup", base, at };
  }
  if (row.type === "transfer" && row.perspective === "outgoing") {
    return { kind: row.data?.attribution === STORAGE_ATTRIBUTION ? "storage" : "other-out", base, at };
  }
  return { kind: "other", base, at };
}

export interface ChannelState {
  settled: bigint;
  deposit: bigint;
}

export interface Stats {
  address: string;
  from: string | null;
  to: string | null;
  rows: number;
  channels: { opened: number; closed: number; open: number; unknown: number };
  depositedBase: bigint;
  refundedBase: bigint;
  /** Still in open channels and not yet settled to the payee: parked, not paid. */
  parkedBase: bigint;
  /** What the channels paid the services: deposited, less refunded, less parked. */
  channelPaidBase: bigint;
  storage: { count: number; base: bigint };
  paidBase: bigint;
  topups: { count: number; base: bigint };
  otherOut: { count: number; base: bigint };
  other: number;
  /** True when a channel's state could not be read, so `channelPaidBase` counts its parked money as paid. */
  approximate: boolean;
}

/**
 * The figures, from classified rows and each channel's current state. A channel with no state
 * (`--no-state`, or a read that failed) is counted as neither closed nor open, and its parked
 * money cannot be subtracted, which is what `approximate` says.
 */
export function summarize(address: string, rows: Classified[], states: Map<string, ChannelState | null>): Stats {
  const sum = (k: Kind) => rows.filter((r) => r.kind === k).reduce((a, r) => a + r.base, 0n);
  const count = (k: Kind) => rows.filter((r) => r.kind === k).length;
  const ids = new Set(rows.filter((r) => r.channelId).map((r) => r.channelId!.toLowerCase()));
  let closed = 0;
  let open = 0;
  let unknown = 0;
  let parkedBase = 0n;
  for (const id of ids) {
    const s = states.get(id);
    if (!s) unknown++;
    else if (s.deposit === 0n && s.settled === 0n) closed++;
    else {
      open++;
      parkedBase += s.deposit > s.settled ? s.deposit - s.settled : 0n;
    }
  }
  const depositedBase = sum("channel-open") + sum("channel-fund");
  const refundedBase = sum("refund");
  const channelPaidBase = depositedBase - refundedBase - parkedBase;
  const storageBase = sum("storage");
  const times = rows.map((r) => r.at).sort();
  return {
    address,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    rows: rows.length,
    channels: { opened: count("channel-open"), closed, open, unknown },
    depositedBase,
    refundedBase,
    parkedBase,
    channelPaidBase,
    storage: { count: count("storage"), base: storageBase },
    paidBase: channelPaidBase + storageBase,
    topups: { count: count("topup"), base: sum("topup") },
    otherOut: { count: count("other-out"), base: sum("other-out") },
    other: count("other"),
    approximate: unknown > 0,
  };
}

/** Base units of USDC.e as a figure with its six decimals. */
export function usdc(base: bigint): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  return `${neg ? "-" : ""}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Whole days the figures span: at least one when there are rows, so a day's activity is not "0 days". */
export function statsDays(s: Pick<Stats, "from" | "to">): number {
  return s.from && s.to ? Math.max(1, Math.ceil((Date.parse(s.to) - Date.parse(s.from)) / 86_400_000)) : 0;
}

// ─── Reading Tempo, bounded ─────────────────────────────────────────────────

/** Tempo did not answer, or answered with an error: the route's 502. `status` is the HTTP status, when there was one. */
export class TempoStatsUpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
/** The time the caller allowed ran out before Tempo answered anything usable: the route's 503. */
export class TempoStatsTimeout extends Error {}
/**
 * The feed's free requests for this window are spent: a 402 (its paid tier, which nothing here
 * pays) or a 429 that outlasted its retries. A subclass of the upstream error, so a caller that
 * only told refusals from silences still reads it as a refusal; the route's 503 when nothing has
 * been read yet. `resetAt` is when the feed said the window ends.
 */
export class TempoStatsRateLimited extends TempoStatsUpstreamError {
  constructor(message: string, status: number, readonly resetAt: number) {
    super(message, status);
  }
}

/**
 * What a read may cost. Every field is optional and the script passes none, so its reads are what
 * they were before the route existed: no deadline, no per-request timeout, 10 000 pages. The route
 * is answering a browser and passes all three.
 */
export interface ReadBounds {
  /** `Date.now()` past which no new request starts and no read is waited for. */
  deadline?: number;
  /** One feed request's limit, body included; also cut short by `deadline`. */
  requestTimeoutMs?: number;
  /** The feed's page cap; past it the rows read so far are all there is. */
  maxPages?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const isTimeout = (e: unknown) => {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/**
 * When the feed's window ends, from `ratelimit-reset`. Tempo sends epoch seconds (ten digits, such
 * as 1791187920); the IETF draft the header comes from sends seconds from now, so a small number is
 * read that way. Absent or unreadable, a minute from now.
 */
export function rateResetAt(headers: Headers | undefined, now: number): number {
  const v = Number(headers?.get("ratelimit-reset") ?? NaN);
  if (!Number.isFinite(v) || v <= 0) return now + 60_000;
  return v > 1e9 ? v * 1000 : now + v * 1000;
}

/** `ratelimit-remaining` as a number, or `undefined` when the answer did not carry it. */
export function rateRemaining(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("ratelimit-remaining");
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

async function getJson(url: string, bounds: ReadBounds = {}): Promise<any> {
  return (await getJsonWithHeaders(url, bounds)).body;
}

/** One feed request, its body and its headers: the incremental walk reads `ratelimit-*` off every page. */
async function getJsonWithHeaders(url: string, bounds: ReadBounds = {}): Promise<{ body: any; headers: Headers }> {
  const doFetch = bounds.fetch ?? fetch;
  const now = bounds.now ?? Date.now;
  // Three tries with a growing wait: the feed is public and rate-limited, and a 429 halfway
  // through the pages should cost a pause, not the run.
  for (let attempt = 0; ; attempt++) {
    const left = bounds.deadline === undefined ? Infinity : bounds.deadline - now();
    if (left <= 0) throw new TempoStatsTimeout(`${url} was not asked: the time allowed ran out`);
    const limit = Math.min(left, bounds.requestTimeoutMs ?? Infinity);
    let res: Response;
    try {
      res = await doFetch(url, Number.isFinite(limit) ? { signal: AbortSignal.timeout(limit) } : undefined);
    } catch (e) {
      if (isTimeout(e)) throw new TempoStatsTimeout(`${url} did not answer within ${Math.round(limit)} ms`);
      throw new TempoStatsUpstreamError(`${url} did not answer: ${(e as Error)?.message ?? String(e)}`);
    }
    if (res.ok) {
      try {
        return { body: await res.json(), headers: res.headers };
      } catch (e) {
        // A body cut off by the signal is the deadline, not a malformed answer.
        if (isTimeout(e)) throw new TempoStatsTimeout(`${url} did not finish answering within ${Math.round(limit)} ms`);
        throw new TempoStatsUpstreamError(`${url} answered something that is not JSON`);
      }
    }
    if (res.status === 402) {
      // Past twenty requests a window the feed answers 402 Payment Required: its MPP-paid tier
      // (`server-timing: address_activity_mpp`). Paying it would be a spend for a read that is
      // public and free, so the challenge is never answered, nor its body read; asking again
      // inside the window would only be refused again, so this is not retried either.
      throw new TempoStatsRateLimited(
        `${url} answered 402: the feed's free requests for this window are spent`,
        402,
        rateResetAt(res.headers, now())
      );
    }
    const wait = 1000 * 2 ** attempt;
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      // A pause that would end past the deadline is a run that has already lost; say so now.
      if (bounds.deadline !== undefined && now() + wait >= bounds.deadline) {
        throw new TempoStatsTimeout(`${url} answered ${res.status}, and there is no time left to ask again`);
      }
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const said = `${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429) throw new TempoStatsRateLimited(said, 429, rateResetAt(res.headers, now()));
    throw new TempoStatsUpstreamError(said, res.status);
  }
}

/**
 * The feed, newest first, until it ends or a bound bites. `complete: false` is the page cap or the
 * deadline after at least one page: the rows are real but the oldest are missing. With no page at
 * all there are no figures, which is the deadline's error and not an empty treasury.
 */
export async function pageActivities(
  api: string,
  address: string,
  bounds: ReadBounds = {}
): Promise<{ rows: Activity[]; complete: boolean }> {
  const out: Activity[] = [];
  let cursor: string | undefined;
  const maxPages = bounds.maxPages ?? 10_000;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
    let body: any;
    try {
      body = await getJson(`${api}/v1/addresses/${address}/activities?${q}`, bounds);
    } catch (e) {
      if (e instanceof TempoStatsTimeout && page > 0) return { rows: out, complete: false };
      throw e;
    }
    out.push(...((body?.data ?? []) as Activity[]));
    cursor = body?.nextCursor ?? undefined;
    if (!cursor) return { rows: out, complete: true };
  }
  return { rows: out, complete: false };
}

/** The script's read: the whole feed or an error, since a printed lifetime figure has no "approximate" line for a cut feed. */
export async function fetchActivities(api: string, address: string): Promise<Activity[]> {
  // The feed pages newest first; a bound on the pages keeps a misbehaving cursor from looping.
  const { rows, complete } = await pageActivities(api, address, { maxPages: 10_000 });
  if (!complete) throw new Error("the activity feed did not end after 10 000 pages");
  return rows;
}

// ─── Reading the feed incrementally ─────────────────────────────────────────

/**
 * Requests of a feed window left unspent. The feed allows twenty a window and answers the
 * twenty-first with its paid 402, so a walk stops while `ratelimit-remaining` still says this
 * many, and the window's last request stays with whoever else reads the feed from this address
 * (a person checking it by hand, `npm run -s tempo:stats` on the same host).
 */
export const TEMPO_FEED_RESERVE = 1;

/**
 * What the route remembers of the feed between refreshes, and across restarts through
 * `tempo-stats.json`. The feed's rows never change once written — a close is a new refund row,
 * not an edit of the open — so a row read once is read for good, and a refresh need only page
 * from the newest until it meets one.
 */
export interface FeedMemory {
  /** Every row read, newest first, trimmed to what `classify` and `recentActivity` read. */
  rows: Activity[];
  /**
   * Cursors where an earlier walk stopped (a spent window, the deadline, the page cap) before it
   * met a row it held or the feed's end: the rows beyond each are missing until a walk resumes it.
   */
  resume: string[];
  /** Lowercased ids of channels read as settled (`SETTLED_MEMO_AGE_MS`). */
  settled: Set<string>;
  /** `Date.now()` before which the feed is not asked: the window a walk found spent ends then. */
  quietUntil?: number;
}

export const emptyFeedMemory = (): FeedMemory => ({ rows: [], resume: [], settled: new Set() });

/**
 * A row's identity: Tempo's `id` (`<transaction hash>-<log index>`), else the fields that tell two
 * rows apart, for a feed or a fixture that sends no id.
 */
export function rowKey(row: Activity): string {
  if (row.id) return row.id;
  const d = row.data;
  return JSON.stringify([
    row.transactionHash ?? null,
    row.type,
    row.perspective ?? null,
    row.timestamp,
    d?.channelId ?? null,
    d?.sender ?? null,
    d?.recipient ?? null,
    d?.sourceAmount?.baseUnits ?? null,
  ]);
}

/**
 * A row as it is kept: the fields the figures and the listed lines read, so the cache file holds
 * a few hundred bytes a row rather than the feed's titles, decimals and token names. The raw fields
 * are kept, not their classification, so a change to `classify` applies to rows already held.
 */
export function trimRow(row: Activity): Activity {
  const d = row.data;
  const data: NonNullable<Activity["data"]> = {
    ...(d?.channelId !== undefined ? { channelId: d.channelId } : {}),
    ...(d?.attribution !== undefined ? { attribution: d.attribution } : {}),
    ...(d?.sender !== undefined ? { sender: d.sender } : {}),
    ...(d?.recipient !== undefined ? { recipient: d.recipient } : {}),
    ...(d?.sourceAmount?.baseUnits !== undefined ? { sourceAmount: { baseUnits: d.sourceAmount.baseUnits } } : {}),
    ...(d?.sourceToken?.address !== undefined ? { sourceToken: { address: d.sourceToken.address } } : {}),
  };
  return {
    ...(row.id ? { id: row.id } : {}),
    type: row.type,
    ...(row.perspective !== undefined ? { perspective: row.perspective } : {}),
    timestamp: row.timestamp,
    ...(row.transactionHash ? { transactionHash: row.transactionHash } : {}),
    data,
  };
}

/** What one refresh's walk did: how many requests it made and whether the rows it leaves are the whole feed. */
export interface FeedWalk {
  requests: number;
  complete: boolean;
  /** Why it stopped short, when it did. */
  stopped?: "rate" | "time" | "cap";
}

/**
 * One refresh of `memory`: from the newest row until a row already held, then each `resume`
 * cursor until a held row or the feed's end. A warm refresh is one request, or two when more
 * than a page of rows arrived since the last.
 *
 * Rate-aware: no request while `memory.quietUntil` stands, none once `ratelimit-remaining` is
 * down to `TEMPO_FEED_RESERVE`, and a 402 or a spent 429 stops the walk like the deadline does —
 * the rows read so far are kept, the cursor it stopped at is resumed next time, and the walk
 * reports `complete: false`, which the figures carry as `approximate`.
 *
 * `memory` changes only when the walk returns: a refusal that throws (a 4xx but 402/429, a 5xx
 * past its retries) leaves it as it was, except that a refused `resume` cursor is dropped along
 * with every row, since a gap that can no longer be filled would leave the figures short for
 * good and only a walk from the top can close it. Nothing read and nothing held is the error
 * itself, not an empty treasury.
 */
export async function walkFeed(
  api: string,
  address: string,
  memory: FeedMemory,
  bounds: ReadBounds = {}
): Promise<FeedWalk> {
  const now = bounds.now ?? Date.now;
  const maxPages = bounds.maxPages ?? 10_000;
  // `held` is what the walk may stop at; `seen` also holds this refresh's rows, so a row the feed
  // repeats across a page boundary is kept once without passing for a row held before.
  const held = new Set(memory.rows.map(rowKey));
  const seen = new Set(held);
  const fresh: Activity[] = [];
  const resume: string[] = [];
  let requests = 0;
  let stopped: FeedWalk["stopped"];
  let stopError: unknown;
  let remaining: number | undefined;
  let lastHeaders: Headers | undefined;
  let quietUntil = memory.quietUntil;
  // `undefined` is the walk from the newest row; it is never resumed, since every refresh starts with it.
  const starts: (string | undefined)[] = [undefined, ...memory.resume];
  for (const start of starts) {
    let cursor = start;
    let done = false;
    while (!stopped) {
      if (quietUntil !== undefined && now() < quietUntil) {
        stopped = "rate";
        stopError = new TempoStatsRateLimited(
          `Tempo's activity feed is not asked until ${new Date(quietUntil).toISOString()}: its window is spent`,
          429,
          quietUntil
        );
        break;
      }
      if (remaining !== undefined && remaining <= TEMPO_FEED_RESERVE) {
        // The window is down to its reserve: stop before the request that would spend it — in
        // this walk or a resumed one — and ask again once it resets.
        stopped = "rate";
        quietUntil = rateResetAt(lastHeaders, now());
        break;
      }
      if (requests >= maxPages) {
        stopped = "cap";
        break;
      }
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      let page: { body: any; headers: Headers };
      try {
        requests++;
        page = await getJsonWithHeaders(`${api}/v1/addresses/${address}/activities?${q}`, bounds);
      } catch (e) {
        if (e instanceof TempoStatsRateLimited) {
          stopped = "rate";
          quietUntil = e.resetAt;
        } else if (e instanceof TempoStatsTimeout) {
          stopped = "time";
        } else {
          if (cursor !== undefined && cursor === start && e instanceof TempoStatsUpstreamError) {
            const s = e.status;
            if (s !== undefined && s >= 400 && s < 500) {
              memory.rows = [];
              memory.resume = [];
            }
          }
          throw e;
        }
        stopError = e;
        break;
      }
      lastHeaders = page.headers;
      remaining = rateRemaining(page.headers);
      let met = false;
      for (const row of (page.body?.data ?? []) as Activity[]) {
        const k = rowKey(row);
        if (held.has(k)) met = true;
        else if (!seen.has(k)) {
          seen.add(k);
          fresh.push(trimRow(row));
        }
      }
      const next: string | undefined = page.body?.nextCursor ?? undefined;
      if (met || !next) {
        done = true;
        break;
      }
      cursor = next;
    }
    if (!done && cursor !== undefined) resume.push(cursor);
  }
  // A walk that read nothing new and stopped on the first request it would have made, over a
  // memory that holds nothing either, has no figures to give: the stop is the answer.
  if (stopped && fresh.length === 0 && memory.rows.length === 0 && stopError) throw stopError;
  if (fresh.length) {
    const t = (r: Activity) => Date.parse(r.timestamp) || 0;
    // Stable, so rows sharing a timestamp keep the order the feed gave them.
    memory.rows = [...fresh, ...memory.rows]
      .map((r, i) => [r, i] as const)
      .sort((a, b) => t(b[0]) - t(a[0]) || a[1] - b[1])
      .map(([r]) => r);
  }
  memory.resume = resume;
  if (stopped === "rate") memory.quietUntil = quietUntil;
  else if (memory.quietUntil !== undefined && now() >= memory.quietUntil) delete memory.quietUntil;
  return { requests, complete: !stopped && resume.length === 0, ...(stopped ? { stopped } : {}) };
}

/** As much of a channel reader as the figures use: `TempoRpcReader` in the script, `escrowState` in the route. */
export interface ChannelReader {
  channelState(channelId: string): Promise<ChannelState | null>;
}

/**
 * Each channel's state, keyed by its lowercased id; `null` is a read that failed, or one the
 * deadline cut off, and is counted as unread.
 */
export async function readStates(
  reader: ChannelReader,
  ids: string[],
  bounds: Pick<ReadBounds, "deadline" | "now"> = {}
): Promise<Map<string, ChannelState | null>> {
  const now = bounds.now ?? Date.now;
  const states = new Map<string, ChannelState | null>();
  const queue = [...ids];
  // Four reads in flight: a few hundred channels finish in seconds without leaning on the node.
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const left = bounds.deadline === undefined ? Infinity : bounds.deadline - now();
        if (left <= 0) {
          states.set(id.toLowerCase(), null);
          continue;
        }
        const read = reader.channelState(id).catch(() => null);
        const s = Number.isFinite(left) ? await within(read, left) : await read;
        states.set(id.toLowerCase(), s ? { settled: s.settled, deposit: s.deposit } : null);
      }
    })
  );
  return states;
}

/** `p`, or `null` once `ms` pass; the timer is cleared so a finished read leaves nothing pending. */
function within<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// ─── The route's figures ────────────────────────────────────────────────────

/**
 * How the route bounds one computation. A treasury of 10 pages and 318 channels takes ~30 s cold
 * and ~7 s once the settled channels are remembered, so the cold walk fits with room; past it the
 * unread channels make the answer `approximate` and the next refresh reads fewer.
 */
export const TEMPO_STATS_BUDGET_MS = 40_000;
export const TEMPO_STATS_REQUEST_TIMEOUT_MS = 10_000;
/** 10 000 rows; a treasury of about a thousand rows needs ten pages, so the time bound bites long before this one. */
export const TEMPO_STATS_MAX_PAGES = 100;
/**
 * How old a channel's newest feed row must be before a zero read is remembered as settled. A closed
 * channel reads zeros for good, so it need not be read again; a channel opened a moment ago could
 * read zeros from a node a block behind, and remembering that would count its deposit as paid for
 * the life of the process.
 */
export const SETTLED_MEMO_AGE_MS = 15 * 60_000;

export interface TempoStatsDeps extends ReadBounds {
  reader: ChannelReader;
  api?: string;
  /** How long the whole computation may take; the default is `TEMPO_STATS_BUDGET_MS`. */
  budgetMs?: number;
  /**
   * Lowercased ids already read as settled, kept between computations by the caller: a refresh
   * then reads only the channels that might still be open, not all three hundred again. Ignored
   * when `memory` is passed, which carries its own.
   */
  settled?: Set<string>;
  /**
   * The rows read by earlier computations (`walkFeed`), changed in place: with it a refresh pages
   * only what arrived since; without it every computation walks the whole feed, as the script does.
   */
  memory?: FeedMemory;
  /** Called with each walk's request count and outcome; the suites count requests through it. */
  onWalk?: (walk: FeedWalk) => void;
}

/**
 * The `TempoStats` the route serves. `approximate` is also true when the feed was cut short — by
 * a bound, a spent rate window, or a gap an earlier walk left — since the missing rows' deposits
 * and refunds are then absent from every figure, and `since` may be the oldest row read rather
 * than the treasury's first.
 */
export async function computeTempoStats(address: string, deps: TempoStatsDeps): Promise<TempoStats> {
  const now = deps.now ?? Date.now;
  const deadline = deps.deadline ?? now() + (deps.budgetMs ?? TEMPO_STATS_BUDGET_MS);
  const bounds: ReadBounds = {
    deadline,
    requestTimeoutMs: deps.requestTimeoutMs ?? TEMPO_STATS_REQUEST_TIMEOUT_MS,
    maxPages: deps.maxPages ?? TEMPO_STATS_MAX_PAGES,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    now,
  };
  const memory = deps.memory ?? { ...emptyFeedMemory(), settled: deps.settled ?? new Set<string>() };
  const walk = await walkFeed(deps.api ?? TEMPO_API_URL, address, memory, bounds);
  deps.onWalk?.(walk);
  const rows = memory.rows.map(classify);
  const ids = [...new Set(rows.filter((r) => r.channelId).map((r) => r.channelId!))];
  const known = memory.settled;
  const states = await readStates(
    deps.reader,
    ids.filter((id) => !known.has(id.toLowerCase())),
    { deadline, now }
  );
  const ZERO: ChannelState = { settled: 0n, deposit: 0n };
  const newest = new Map<string, number>();
  for (const r of rows) {
    if (!r.channelId) continue;
    const id = r.channelId.toLowerCase();
    newest.set(id, Math.max(newest.get(id) ?? 0, Date.parse(r.at) || 0));
  }
  for (const id of ids.map((i) => i.toLowerCase())) {
    if (known.has(id)) states.set(id, ZERO);
    const s = states.get(id);
    if (s && s.deposit === 0n && s.settled === 0n && (newest.get(id) ?? Infinity) <= now() - SETTLED_MEMO_AGE_MS) {
      known.add(id);
    }
  }
  return toTempoStats(summarize(address, rows, states), memory.rows, {
    computedAt: new Date(now()).toISOString(),
    truncated: !walk.complete,
  });
}

/**
 * `Stats` as the route's JSON (`types/tempo-stats.ts`): every amount a decimal string, the script's
 * `closed` / `unknown` under the screen's words, and the newest rows the tab lists.
 */
export function toTempoStats(
  s: Stats,
  feed: Activity[],
  opts: { computedAt: string; truncated?: boolean }
): TempoStats {
  return {
    treasury: s.address,
    since: s.from,
    until: s.to,
    days: statsDays(s),
    channels: {
      opened: s.channels.opened,
      settled: s.channels.closed,
      open: s.channels.open,
      unread: s.channels.unknown,
    },
    depositedBase: s.depositedBase.toString(),
    channelPaidBase: s.channelPaidBase.toString(),
    refundedBase: s.refundedBase.toString(),
    parkedBase: s.parkedBase.toString(),
    approximate: s.approximate || !!opts.truncated,
    storage: { count: s.storage.count, amountBase: s.storage.base.toString() },
    paidBase: s.paidBase.toString(),
    computedAt: opts.computedAt,
    recent: recentActivity(feed),
  };
}

const LISTED: Partial<Record<Kind, TempoStatsActivity["kind"]>> = {
  "channel-open": "open",
  refund: "close",
  storage: "storage",
  topup: "topup",
};

/**
 * The newest rows worth a line, newest first. A `channel-funded` row is counted in the deposits and
 * not listed, as is anything outside USDC.e or not sorted; a row with no transaction hash is not
 * listed either, since every line on the tab is a link to its transaction.
 */
export function recentActivity(feed: Activity[], limit: number = TEMPO_STATS_RECENT_LIMIT): TempoStatsActivity[] {
  const out: TempoStatsActivity[] = [];
  const newestFirst = [...feed].sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  for (const row of newestFirst) {
    if (out.length >= limit) break;
    const kind = LISTED[classify(row).kind];
    if (!kind || !row.transactionHash) continue;
    const channelId = row.data?.channelId;
    const amount = row.data?.sourceAmount?.baseUnits;
    out.push({
      kind,
      txHash: row.transactionHash,
      ...(channelId ? { channelId } : {}),
      ...(amount !== undefined ? { amountBase: BigInt(amount).toString() } : {}),
      at: row.timestamp,
    });
  }
  return out;
}

// ─── The cache ──────────────────────────────────────────────────────────────

/** About ten minutes: each computation pages the feed and reads every channel that might be open. */
export const TEMPO_STATS_TTL_MS = 10 * 60_000;
/**
 * How long a failure stands before Tempo is asked again. The route is public and anonymous, so
 * without it every poll during an outage would be one more round of pages against a feed that is
 * already refusing — the rule `GET /api/tempo/treasury` keeps for its balance.
 */
export const TEMPO_STATS_RETRY_MS = 60_000;

export type TempoStatsReply = { status: number; body: TempoStats | TempoStatsError };

function failureOf(e: unknown): { status: number; error: string } {
  const said = (e as Error)?.message ?? String(e);
  if (e instanceof TempoStatsTimeout) return { status: 503, error: `Tempo did not answer in time: ${said}` };
  if (e instanceof TempoStatsRateLimited) {
    return {
      status: 503,
      error: `Tempo's activity feed is rate-limited, and nothing has been read from it yet: ${said}`,
    };
  }
  return { status: 502, error: `Tempo did not answer: ${said}` };
}

/**
 * The figures per address, computed at most once per `ttlMs`:
 *
 * - **single-flight** — callers that arrive while a computation runs wait for that one, so a burst
 *   of tab loads is one walk of the feed, not one each;
 * - **stale-while-error** — when a refresh fails, the last good figures are served as they were,
 *   their `computedAt` saying how old they are, and the refresh is not retried for `retryMs`;
 * - with no good figures yet, the failure itself is the answer for `retryMs`;
 * - **approximate figures stand for `retryMs`**, not `ttlMs`: they are what a spent rate window or a
 *   bound left, and the walk that completes them should not wait ten minutes for its turn;
 * - **restored figures** (`initial`: the copy a restart read back from disk) are served at once,
 *   however old, and a stale copy is refreshed in the background rather than waited for, so the
 *   first tab load after a restart is the last figures, not a walk of the feed.
 */
export function tempoStatsCache(
  compute: (address: string) => Promise<TempoStats>,
  opts: {
    ttlMs?: number;
    retryMs?: number;
    now?: () => number;
    initial?: (address: string) => TempoStats | null;
  } = {}
): (address: string) => Promise<TempoStatsReply> {
  const ttlMs = opts.ttlMs ?? TEMPO_STATS_TTL_MS;
  const retryMs = opts.retryMs ?? TEMPO_STATS_RETRY_MS;
  const now = opts.now ?? Date.now;
  type Entry = {
    good?: { stats: TempoStats; at: number; restored?: boolean };
    failed?: { status: number; error: string; at: number };
    inflight?: Promise<void>;
  };
  const entries = new Map<string, Entry>();
  const reply = (e: Entry): TempoStatsReply =>
    e.good
      ? { status: 200, body: e.good.stats }
      : { status: e.failed?.status ?? 502, body: { error: e.failed?.error ?? "Tempo did not answer" } };

  return async (address) => {
    const key = address.toLowerCase();
    let e = entries.get(key);
    if (!e) {
      entries.set(key, (e = {}));
      const restored = opts.initial?.(address);
      if (restored) e.good = { stats: restored, at: Date.parse(restored.computedAt) || 0, restored: true };
    }
    const t = now();
    if (e.good && t - e.good.at < (e.good.stats.approximate ? retryMs : ttlMs)) return reply(e);
    if (e.failed && t - e.failed.at < retryMs) return reply(e);
    if (!e.inflight) {
      const entry = e;
      entry.inflight = compute(address)
        .then(
          (stats) => {
            entry.good = { stats, at: now() };
            entry.failed = undefined;
          },
          (err) => {
            entry.failed = { ...failureOf(err), at: now() };
          }
        )
        .finally(() => {
          entry.inflight = undefined;
        });
    }
    // Its handlers never reject, so a refresh nobody waits for leaves no unhandled rejection.
    if (e.good?.restored) return reply(e);
    await e.inflight;
    return reply(e);
  };
}

// ─── The file ───────────────────────────────────────────────────────────────

/** The cache file's name under `LATH_TRACE_DIR`, beside `loops.json` and `templates.json`. */
export const TEMPO_STATS_FILE = "tempo-stats.json";

/**
 * `LATH_TRACE_DIR/tempo-stats.json`: one treasury's feed rows, the cursors still to resume, the
 * channels read as settled, and the last figures served. Everything in it is public and all of it
 * can be read again from Tempo, so a file that cannot be read is started over rather than refused —
 * the opposite of `agents.json`, whose rows exist nowhere else (`json-store.ts`).
 */
export interface TempoStatsFile {
  version: 1;
  /** Lowercased; a file written for another treasury is started over. */
  treasury: string;
  rows: Activity[];
  resume: string[];
  settled: string[];
  stats: TempoStats | null;
}

/** The memory and the last figures `file` holds for `address`; an empty memory when it holds none. */
export function loadTempoStatsFile(
  file: string | null,
  address: string
): { memory: FeedMemory; stats: TempoStats | null } {
  const empty = { memory: emptyFeedMemory(), stats: null };
  if (!file) return empty;
  let f: Partial<TempoStatsFile> | null;
  try {
    f = readJsonOr<Partial<TempoStatsFile> | null>(file, () => null);
  } catch (e) {
    console.warn(`[tempo-stats] ${(e as Error)?.message ?? e}; reading the feed from the start`);
    return empty;
  }
  if (
    !f ||
    f.version !== 1 ||
    f.treasury !== address.toLowerCase() ||
    !Array.isArray(f.rows) ||
    !Array.isArray(f.resume) ||
    !Array.isArray(f.settled)
  ) {
    return empty;
  }
  const stats = f.stats && typeof f.stats === "object" && typeof f.stats.computedAt === "string" ? f.stats : null;
  return {
    memory: {
      rows: f.rows.filter((r) => !!r && typeof r.type === "string" && typeof r.timestamp === "string"),
      resume: f.resume.filter((c) => typeof c === "string"),
      settled: new Set(f.settled.filter((c) => typeof c === "string").map((c) => c.toLowerCase())),
    },
    stats,
  };
}

/** Writes beside the file and renames over it (`writeJsonAtomic`), so a crash never leaves half of it. */
export function saveTempoStatsFile(file: string, address: string, memory: FeedMemory, stats: TempoStats | null): void {
  const value: TempoStatsFile = {
    version: 1,
    treasury: address.toLowerCase(),
    rows: memory.rows,
    resume: memory.resume,
    settled: [...memory.settled],
    stats,
  };
  writeJsonAtomic(file, value);
}

/**
 * The route's cache over the file: the memory and the last figures are read once per address on
 * first use, every computation walks the feed from that memory, and every computation that returns
 * figures — approximate ones too, since the rows behind them are worth keeping — is written back.
 * With `file: null` it is the same cache with nothing kept across restarts.
 */
export function persistentTempoStats(opts: {
  file: string | null;
  deps: Omit<TempoStatsDeps, "memory" | "settled">;
  ttlMs?: number;
  retryMs?: number;
}): (address: string) => Promise<TempoStatsReply> {
  const slots = new Map<string, { memory: FeedMemory; stats: TempoStats | null }>();
  const slot = (address: string) => {
    const key = address.toLowerCase();
    let s = slots.get(key);
    if (!s) slots.set(key, (s = loadTempoStatsFile(opts.file, address)));
    return s;
  };
  return tempoStatsCache(
    async (address) => {
      const s = slot(address);
      const stats = await computeTempoStats(address, { ...opts.deps, memory: s.memory });
      s.stats = stats;
      if (opts.file) {
        try {
          saveTempoStatsFile(opts.file, address, s.memory, stats);
        } catch (e) {
          // The figures are good whether or not they reached the disk; the next restart walks more.
          console.warn(`[tempo-stats] could not write ${opts.file}: ${(e as Error)?.message ?? e}`);
        }
      }
      return stats;
    },
    {
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
      ...(opts.deps.now ? { now: opts.deps.now } : {}),
      initial: (address) => slot(address).stats,
    }
  );
}

/** The route's answer. No treasury is a 404 with a sentence: there is no payer whose figures to read. */
export async function answerTempoStats(
  address: string | null,
  cached: (address: string) => Promise<TempoStatsReply>
): Promise<TempoStatsReply> {
  if (!address) {
    return { status: 404, body: { error: "this console has no Tempo treasury (LATH_TEMPO_TREASURY is empty)" } };
  }
  return cached(address);
}
