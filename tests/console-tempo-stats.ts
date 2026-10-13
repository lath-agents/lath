/**
 * `GET /api/tempo/stats` and the core it shares
 * with `scripts/tempo-stats.ts` (`frontend/src/app/api/_lib/tempo-stats.ts`): the mapping into the
 * `TempoStats` contract the Tempo tab reads, the ten-minute cache, single-flight, the stale and
 * error answers, the bounds on the feed and the channel reads, and the console with no treasury.
 *
 * Node-only, network-free, key-free but for a throwaway treasury key the route derives an address
 * from: `fetch` is a stub that answers the feed's pages and the escrow's `getChannelState` from
 * fixtures, so nothing reaches Tempo and nothing is signed or spent. The route keeps the feed in
 * `LATH_TRACE_DIR/tempo-stats.json`, so the directory is a throwaway one, set first.
 */
import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TEMPO_ESCROW, TEMPO_USDC_E } from "../sdk/src";
import {
  SETTLED_MEMO_AGE_MS,
  TEMPO_FEED_RESERVE,
  TEMPO_STATS_FILE,
  TEMPO_STATS_RETRY_MS,
  TEMPO_STATS_TTL_MS,
  TempoStatsRateLimited,
  TempoStatsTimeout,
  TempoStatsUpstreamError,
  answerTempoStats,
  computeTempoStats,
  emptyFeedMemory,
  persistentTempoStats,
  recentActivity,
  tempoStatsCache,
  type Activity,
  type ChannelReader,
  type FeedWalk,
  type TempoStatsFile,
} from "../frontend/src/app/api/_lib/tempo-stats";
import { TEMPO_STATS_RECENT_LIMIT, type TempoStats } from "../frontend/src/types/tempo-stats";
import { fetchTempoStats } from "../frontend/src/lib/tempo-stats";

const TREASURY = "0x18fB0000000000000000000000000000000000B0";
const OTHER_TOKEN = "0x20c0000000000000000000000000000000000000";
const API = "https://api.tempo.xyz";
const RPC = "https://rpc.tempo.xyz";
const CH_A = `0x${"a1".repeat(32)}`;
const CH_B = `0x${"b2".repeat(32)}`;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function row(
  type: string,
  perspective: string,
  base: number,
  at: string,
  data: Activity["data"] = {},
  hash?: string,
  token: string = TEMPO_USDC_E
): Activity {
  return {
    type,
    perspective,
    timestamp: at,
    ...(hash ? { transactionHash: hash } : {}),
    data: { sourceAmount: { baseUnits: String(base) }, sourceToken: { address: token }, ...data },
  };
}

/** The feed newest first, as `api.tempo.xyz` pages it. */
const FEED: Activity[] = [
  row("transfer", "incoming", 4_000_000, "2026-10-04T09:00:00.000Z", { sender: "0x77bc" }, tx(7)),
  row("transfer", "outgoing", 100, "2026-10-04T08:00:00.000Z", { attribution: "Object Storage" }, tx(6)),
  row("channel-opened", "outgoing", 2_000, "2026-10-03T08:00:00.000Z", { channelId: CH_B }, tx(5)),
  // The escrow's refund at A's close: the close's only row on the treasury.
  row("transfer", "incoming", 6_000, "2026-10-02T08:00:00.000Z", { sender: TEMPO_ESCROW }, tx(4)),
  // A top-up of an open channel: counted in the deposits, never listed.
  row("channel-funded", "outgoing", 9_000, "2026-10-01T09:00:00.000Z", { channelId: CH_A }, tx(3)),
  // Not USDC.e, and a row with no transaction: neither is a line on the tab.
  row("channel-opened", "outgoing", 5, "2026-10-01T08:30:00.000Z", { channelId: CH_A }, tx(2), OTHER_TOKEN),
  row("transfer", "outgoing", 100, "2026-10-01T08:15:00.000Z", { attribution: "Object Storage" }),
  row("channel-opened", "outgoing", 1_000, "2026-10-01T08:00:00.000Z", { channelId: CH_A }, tx(1)),
];

/** `getChannelState`'s answer: three ABI words, `(uint96 settled, uint96 deposit, uint32 closeRequestedAt)`. */
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const stateWords = (settled: bigint, deposit: bigint) => `0x${word(settled)}${word(deposit)}${word(0n)}`;

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

/** A `fetch` that pages `feed` by `pageSize` and answers the escrow from `states`; counts what it was asked. */
function tempoStub(
  opts: {
    feed?: Activity[];
    pageSize?: number;
    states?: Record<string, [bigint, bigint]>;
    feedAnswer?: (page: number) => Response | "hang" | null;
    /** Headers on the feed's page answers, by request number: `ratelimit-*` for the rate cases. */
    feedHeaders?: (page: number) => Record<string, string>;
  } = {}
) {
  const feed = opts.feed ?? FEED;
  const pageSize = opts.pageSize ?? 3;
  const states = opts.states ?? { [CH_A]: [0n, 0n], [CH_B]: [500n, 2_000n] };
  const asked = { pages: 0, reads: [] as string[], cursors: [] as (string | null)[] };
  const fetchStub: Handler = async (url, init) => {
    if (url.startsWith(`${API}/v1/addresses/`)) {
      const page = asked.pages++;
      const cursor = new URL(url).searchParams.get("cursor");
      asked.cursors.push(cursor);
      const special = opts.feedAnswer?.(page);
      if (special === "hang") return hang(init?.signal ?? undefined);
      if (special) return special;
      const from = cursor ? Number(cursor) : 0;
      const data = feed.slice(from, from + pageSize);
      const next = from + pageSize < feed.length ? String(from + pageSize) : null;
      return Response.json({ data, nextCursor: next }, { headers: opts.feedHeaders?.(page) ?? {} });
    }
    if (url === RPC && init?.method === "POST") {
      const call = JSON.parse(String(init.body));
      assert.equal(call.method, "eth_call");
      assert.equal(call.params[0].to.toLowerCase(), TEMPO_ESCROW.toLowerCase());
      const id = `0x${String(call.params[0].data).slice(10)}`;
      asked.reads.push(id);
      const s = states[id];
      return Response.json({ jsonrpc: "2.0", id: call.id, result: s ? stateWords(s[0], s[1]) : "0x" });
    }
    throw new Error(`the stub was asked for ${url}, which these tests never reach`);
  };
  return { fetch: fetchStub as unknown as typeof fetch, asked };
}

/** A request that never answers until its signal fires, as a stalled upstream does. */
function hang(signal?: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

/** The reader the route builds, over the stubbed `fetch`: `escrowState` through `httpRpc`. */
async function escrowReader(): Promise<ChannelReader> {
  const { escrowState, httpRpc } = await import("../frontend/src/app/api/_lib/tempo");
  const rpc = httpRpc();
  return { channelState: (id) => escrowState(id, rpc) };
}

describe("console-tempo-stats: GET /api/tempo/stats", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("the mapping into TempoStats", () => {
    it("serves the script's figures under the contract's names, and lists only the rows the type allows", async () => {
      const stub = tempoStub();
      globalThis.fetch = stub.fetch;
      const got = await computeTempoStats(TREASURY, { reader: await escrowReader(), now: () => NOW });
      const want: TempoStats = {
        treasury: TREASURY,
        since: "2026-10-01T08:00:00.000Z",
        until: "2026-10-04T09:00:00.000Z",
        days: 4,
        // A read zeros (settled); B holds 2 000 with 500 settled, so 1 500 is parked.
        channels: { opened: 2, settled: 1, open: 1, unread: 0 },
        depositedBase: "12000",
        channelPaidBase: "4500",
        refundedBase: "6000",
        parkedBase: "1500",
        approximate: false,
        storage: { count: 2, amountBase: "200" },
        paidBase: "4700",
        computedAt: new Date(NOW).toISOString(),
        recent: [
          { kind: "topup", txHash: tx(7), amountBase: "4000000", at: "2026-10-04T09:00:00.000Z" },
          { kind: "storage", txHash: tx(6), amountBase: "100", at: "2026-10-04T08:00:00.000Z" },
          { kind: "open", txHash: tx(5), channelId: CH_B, amountBase: "2000", at: "2026-10-03T08:00:00.000Z" },
          // The refund is the close; its amount is what came back, and the feed did not name the channel.
          { kind: "close", txHash: tx(4), amountBase: "6000", at: "2026-10-02T08:00:00.000Z" },
          { kind: "open", txHash: tx(1), channelId: CH_A, amountBase: "1000", at: "2026-10-01T08:00:00.000Z" },
        ],
      };
      assert.deepEqual(got, want);
      // Three pages of three, and one escrow read per channel.
      assert.equal(stub.asked.pages, 3);
      assert.sameMembers(stub.asked.reads, [CH_A, CH_B]);
      // What the hook does with it: the same figures, accepted as figures.
      globalThis.fetch = (async () => Response.json(got)) as unknown as typeof fetch;
      assert.deepEqual(await fetchTempoStats(), { stats: want });
    });

    it("lists at most TEMPO_STATS_RECENT_LIMIT rows, newest first whatever order the feed sent", () => {
      const opens = Array.from({ length: 30 }, (_, i) =>
        row(
          "channel-opened",
          "outgoing",
          10,
          new Date(NOW - i * 60_000).toISOString(),
          { channelId: tx(100 + i) },
          tx(i)
        )
      );
      const recent = recentActivity([...opens].reverse());
      assert.lengthOf(recent, TEMPO_STATS_RECENT_LIMIT);
      assert.equal(recent[0].txHash, tx(0));
      assert.equal(recent[TEMPO_STATS_RECENT_LIMIT - 1].txHash, tx(TEMPO_STATS_RECENT_LIMIT - 1));
    });

    it("answers zeros and nulls for a treasury with no rows, not an error", async () => {
      globalThis.fetch = tempoStub({ feed: [] }).fetch;
      const got = await computeTempoStats(TREASURY, { reader: await escrowReader(), now: () => NOW });
      assert.include(got, { since: null, until: null, days: 0, paidBase: "0", approximate: false });
      assert.deepEqual(got.recent, []);
    });

    it("counts a channel whose state the escrow would not give as unread, and says the figure is approximate", async () => {
      globalThis.fetch = tempoStub({ states: { [CH_A]: [0n, 0n] } }).fetch;
      const got = await computeTempoStats(TREASURY, { reader: await escrowReader(), now: () => NOW });
      assert.deepEqual(got.channels, { opened: 2, settled: 1, open: 0, unread: 1 });
      assert.isTrue(got.approximate);
    });
  });

  describe("the bounds", () => {
    const reader: ChannelReader = { channelState: async () => ({ settled: 0n, deposit: 0n }) };

    it("is a 502 error when the feed refuses", async () => {
      const stub = tempoStub({ feedAnswer: () => new Response("no", { status: 400 }) });
      const err = await computeTempoStats(TREASURY, { reader, fetch: stub.fetch }).catch((e) => e);
      assert.instanceOf(err, TempoStatsUpstreamError);
      assert.match(err.message, /answered 400/);
    });

    it("gives up on a rate limit when no time is left to wait it out, rather than sleeping past the deadline", async () => {
      const stub = tempoStub({ feedAnswer: () => new Response("slow down", { status: 429 }) });
      const started = Date.now();
      const err = await computeTempoStats(TREASURY, { reader, fetch: stub.fetch, budgetMs: 300 }).catch((e) => e);
      assert.instanceOf(err, TempoStatsTimeout);
      assert.equal(stub.asked.pages, 1);
      assert.isBelow(Date.now() - started, 1_000);
    });

    it("is a timeout when the feed's first page never comes", async () => {
      const stub = tempoStub({ feedAnswer: () => "hang" });
      const err = await computeTempoStats(TREASURY, { reader, fetch: stub.fetch, budgetMs: 80 }).catch((e) => e);
      assert.instanceOf(err, TempoStatsTimeout);
    });

    it("serves the pages it read, marked approximate, when the feed stalls later", async () => {
      const stub = tempoStub({ feedAnswer: (page) => (page === 1 ? "hang" : null) });
      const got = await computeTempoStats(TREASURY, { reader, fetch: stub.fetch, budgetMs: 150 });
      assert.isTrue(got.approximate);
      assert.equal(got.until, FEED[0].timestamp);
      assert.equal(got.since, FEED[2].timestamp);
    });

    it("stops at the page cap and says so", async () => {
      const stub = tempoStub();
      const got = await computeTempoStats(TREASURY, { reader, fetch: stub.fetch, maxPages: 2 });
      assert.equal(stub.asked.pages, 2);
      assert.isTrue(got.approximate);
    });

    it("counts a channel read the deadline cut off as unread instead of waiting for it", async () => {
      const stub = tempoStub();
      const stalled: ChannelReader = { channelState: () => new Promise(() => undefined) };
      const started = Date.now();
      const got = await computeTempoStats(TREASURY, { reader: stalled, fetch: stub.fetch, budgetMs: 150 });
      assert.isBelow(Date.now() - started, 1_000);
      assert.deepEqual(got.channels, { opened: 2, settled: 0, open: 0, unread: 2 });
      assert.isTrue(got.approximate);
    });

    it("does not read a channel again once it read as settled long enough ago", async () => {
      const stub = tempoStub();
      globalThis.fetch = stub.fetch;
      const settled = new Set<string>();
      const deps = { reader: await escrowReader(), settled, now: () => NOW };
      await computeTempoStats(TREASURY, deps);
      // A is settled and its newest row is days old; B is open.
      assert.deepEqual([...settled], [CH_A]);
      stub.asked.reads = [];
      const again = await computeTempoStats(TREASURY, deps);
      assert.deepEqual(stub.asked.reads, [CH_B]);
      assert.deepEqual(again.channels, { opened: 2, settled: 1, open: 1, unread: 0 });
    });

    it("does not remember a zero read for a channel whose last row is minutes old", async () => {
      const fresh = new Date(NOW - SETTLED_MEMO_AGE_MS / 2).toISOString();
      const feed = [row("channel-opened", "outgoing", 1_000, fresh, { channelId: CH_A }, tx(1))];
      globalThis.fetch = tempoStub({ feed }).fetch;
      const settled = new Set<string>();
      await computeTempoStats(TREASURY, { reader: await escrowReader(), settled, now: () => NOW });
      assert.equal(settled.size, 0);
    });
  });

  describe("the cache", () => {
    const stats = (n: number): TempoStats =>
      ({ treasury: TREASURY, computedAt: new Date(NOW + n).toISOString(), recent: [] } as unknown as TempoStats);

    function clocked() {
      let t = NOW;
      return { now: () => t, advance: (ms: number) => (t += ms) };
    }

    it("computes once per ten minutes and serves the same figures in between", async () => {
      const clock = clocked();
      let computed = 0;
      const cached = tempoStatsCache(async () => stats(computed++), { now: clock.now });
      const first = await cached(TREASURY);
      clock.advance(9 * 60_000);
      const second = await cached(TREASURY.toLowerCase());
      assert.equal(computed, 1);
      assert.deepEqual(second, first);
      assert.equal(first.status, 200);
      clock.advance(2 * 60_000);
      const third = await cached(TREASURY);
      assert.equal(computed, 2);
      assert.notDeepEqual(third.body, first.body);
    });

    it("shares one computation among callers who arrive while it runs", async () => {
      let computed = 0;
      let finish: (s: TempoStats) => void = () => undefined;
      const cached = tempoStatsCache(
        () =>
          new Promise<TempoStats>((r) => {
            computed++;
            finish = r;
          })
      );
      const waiting = Array.from({ length: 5 }, () => cached(TREASURY));
      await new Promise((r) => setImmediate(r));
      assert.equal(computed, 1);
      finish(stats(0));
      const replies = await Promise.all(waiting);
      assert.equal(computed, 1);
      for (const r of replies) assert.deepEqual(r, { status: 200, body: stats(0) });
    });

    it("serves the last good figures through a failed refresh, and waits a minute before asking again", async () => {
      const clock = clocked();
      let computed = 0;
      let fail = false;
      const cached = tempoStatsCache(
        async () => {
          computed++;
          if (fail) throw new TempoStatsUpstreamError("api.tempo.xyz answered 500");
          return stats(computed);
        },
        { now: clock.now }
      );
      const good = await cached(TREASURY);
      fail = true;
      clock.advance(11 * 60_000);
      const stale = await cached(TREASURY);
      assert.equal(computed, 2);
      // The old figures, with the old `computedAt`: their age is on them.
      assert.deepEqual(stale, good);
      clock.advance(30_000);
      assert.deepEqual(await cached(TREASURY), good);
      assert.equal(computed, 2, "a failure stands for a minute");
      clock.advance(31_000);
      fail = false;
      const fresh = await cached(TREASURY);
      assert.equal(computed, 3);
      assert.notDeepEqual(fresh.body, good.body);
    });

    it("answers 502 for Tempo's refusal and 503 for its silence when there is nothing to fall back on", async () => {
      const clock = clocked();
      let computed = 0;
      let err: Error = new TempoStatsUpstreamError("api.tempo.xyz answered 500");
      const cached = tempoStatsCache(
        async () => {
          computed++;
          throw err;
        },
        { now: clock.now }
      );
      const refused = await cached(TREASURY);
      assert.equal(refused.status, 502);
      assert.match((refused.body as { error: string }).error, /answered 500/);
      // The failure is the answer for a minute: polling it does not walk the feed again.
      assert.deepEqual(await cached(TREASURY), refused);
      assert.equal(computed, 1);
      clock.advance(61_000);
      err = new TempoStatsTimeout("the feed did not answer within 10000 ms");
      const silent = await cached(TREASURY);
      assert.equal(silent.status, 503);
      assert.match((silent.body as { error: string }).error, /in time/);
    });
  });

  describe("the incremental feed, the file and the rate limit", () => {
    const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lath-tempo-stats-")), TEMPO_STATS_FILE);
    const readFile = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as TempoStatsFile;
    const zeros: ChannelReader = { channelState: async () => ({ settled: 0n, deposit: 0n }) };
    /** A storage charge as the live feed sends it, with Tempo's `id`; no channel, so no escrow read. */
    const charge = (n: number, at: string): Activity => ({
      ...row("transfer", "outgoing", 10 * n, at, { attribution: "Object Storage" }, tx(50 + n)),
      id: `${tx(50 + n)}-0`,
    });
    const clocked = () => {
      let t = NOW;
      return { now: () => t, advance: (ms: number) => (t += ms) };
    };
    const paywall = (reset: number) =>
      new Response(JSON.stringify({ type: "payment-required", challenge: "mpp" }), {
        status: 402,
        headers: { "ratelimit-limit": "20", "ratelimit-remaining": "0", "ratelimit-reset": String(reset) },
      });
    /** Polls until `ok`, for the refresh a restart runs behind the figures it served. */
    async function until(ok: () => Promise<boolean>) {
      for (let i = 0; i < 100; i++) {
        if (await ok()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.fail("the background refresh never landed");
    }

    it("pages only until it meets a row it holds, so a warm refresh is one request", async () => {
      const feed = [...FEED];
      const stub = tempoStub({ feed });
      globalThis.fetch = stub.fetch;
      const memory = emptyFeedMemory();
      const walks: number[] = [];
      const deps = {
        reader: await escrowReader(),
        memory,
        now: () => NOW,
        onWalk: (w: FeedWalk) => walks.push(w.complete ? w.requests : -1),
      };
      const cold = await computeTempoStats(TREASURY, deps);
      assert.lengthOf(memory.rows, FEED.length);
      // Nothing new: the first page meets a held row, and the figures are the same.
      assert.deepEqual(await computeTempoStats(TREASURY, deps), cold);
      // Two rows arrive: they and a held row share the first page.
      feed.unshift(charge(2, "2026-10-05T10:00:00.000Z"), charge(1, "2026-10-05T09:00:00.000Z"));
      const two = await computeTempoStats(TREASURY, deps);
      assert.deepEqual(two.storage, { count: 4, amountBase: "230" });
      assert.equal(two.until, "2026-10-05T10:00:00.000Z");
      // Four more: the first page is all new, so the walk needs a second to meet a held row.
      feed.unshift(...[6, 5, 4, 3].map((n) => charge(n, `2026-10-05T1${n}:00:00.000Z`)));
      const six = await computeTempoStats(TREASURY, deps);
      assert.deepEqual(six.storage, { count: 8, amountBase: String(200 + 10 * (1 + 2 + 3 + 4 + 5 + 6)) });
      assert.isFalse(six.approximate);
      assert.deepEqual(walks, [3, 1, 1, 2], "cold, then one, one and two requests");
      assert.deepEqual(stub.asked.cursors, [null, "3", "6", null, null, null, "3"]);
      // Every row once, newest first.
      assert.lengthOf(memory.rows, FEED.length + 6);
      assert.equal(memory.rows[0].id, `${tx(56)}-0`);
      // A from-scratch computation over the same feed agrees with the incremental one.
      const scratch = await computeTempoStats(TREASURY, { reader: await escrowReader(), now: () => NOW });
      assert.deepEqual(scratch, six);
    });

    it("keeps the rows, the settled channels and the figures in the file, and a restart serves them at once", async () => {
      const file = tmpFile();
      const clock = clocked();
      const stub = tempoStub();
      globalThis.fetch = stub.fetch;
      const deps = { reader: await escrowReader(), now: clock.now };
      const first = await persistentTempoStats({ file, deps })(TREASURY);
      assert.equal(first.status, 200);
      assert.equal(stub.asked.pages, 3);
      const saved = readFile(file);
      assert.include(saved, { version: 1, treasury: TREASURY.toLowerCase() });
      assert.lengthOf(saved.rows, FEED.length);
      assert.deepEqual(saved.resume, []);
      assert.deepEqual(saved.settled, [CH_A]);
      assert.deepEqual(saved.stats, first.body);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), [TEMPO_STATS_FILE], "no temp file is left beside it");

      // A restart inside the ten minutes: the file's figures, and Tempo is not asked.
      assert.deepEqual(await persistentTempoStats({ file, deps })(TREASURY), first);
      assert.equal(stub.asked.pages, 3);

      // A restart past them: the old figures at once, their `computedAt` saying how old, and a
      // refresh behind them that costs one feed request and reads only the channel still open.
      clock.advance(TEMPO_STATS_TTL_MS + 1);
      stub.asked.reads = [];
      const restarted = persistentTempoStats({ file, deps });
      assert.deepEqual(await restarted(TREASURY), first);
      const computedAt = (r: { body: unknown }) => (r.body as TempoStats).computedAt;
      let fresh = first;
      await until(async () => computedAt((fresh = await restarted(TREASURY))) !== computedAt(first));
      assert.equal(stub.asked.pages, 4);
      assert.deepEqual(stub.asked.reads, [CH_B]);
      const body = fresh.body as TempoStats;
      assert.equal(body.computedAt, new Date(clock.now()).toISOString());
      assert.deepEqual({ ...body, computedAt: "" }, { ...(first.body as TempoStats), computedAt: "" });
      assert.deepEqual(readFile(file).stats, body);
    });

    it("stops at a 402 mid-walk without paying it, serves the rows read as approximate, and resumes there", async () => {
      const file = tmpFile();
      const clock = clocked();
      let walled = true;
      const stub = tempoStub({ feedAnswer: (page) => (walled && page === 1 ? paywall((NOW + 30_000) / 1000) : null) });
      globalThis.fetch = stub.fetch;
      const cached = persistentTempoStats({ file, deps: { reader: await escrowReader(), now: clock.now } });
      const cut = await cached(TREASURY);
      assert.equal(cut.status, 200);
      const partial = cut.body as TempoStats;
      assert.isTrue(partial.approximate);
      assert.equal(partial.since, FEED[2].timestamp);
      assert.equal(stub.asked.pages, 2, "the 402 was asked once: not retried, not paid");
      assert.deepEqual(readFile(file).resume, ["3"]);
      assert.lengthOf(readFile(file).rows, 3);

      // Inside the window the approximate figures stand, and the feed is not asked.
      clock.advance(20_000);
      assert.deepEqual(await cached(TREASURY), cut);
      assert.equal(stub.asked.pages, 2);

      // A minute on, past the reset: the head is one request, then the walk resumes at its cursor.
      walled = false;
      clock.advance(TEMPO_STATS_RETRY_MS);
      const whole = (await cached(TREASURY)).body as TempoStats;
      assert.isFalse(whole.approximate);
      assert.equal(whole.since, FEED[FEED.length - 1].timestamp);
      assert.equal(whole.paidBase, "4700");
      assert.deepEqual(stub.asked.cursors, [null, "3", null, "3", "6"]);
      assert.deepEqual(readFile(file).resume, []);
    });

    it("serves the figures it holds, approximate, when the first request meets the 402, and a 503 when it holds none", async () => {
      const clock = clocked();
      let walled = false;
      const stub = tempoStub({ feedAnswer: () => (walled ? paywall((NOW + 60_000) / 1000) : null) });
      const deps = { reader: zeros, fetch: stub.fetch, now: clock.now };
      const cached = persistentTempoStats({ file: tmpFile(), deps });
      const good = (await cached(TREASURY)).body as TempoStats;
      assert.isFalse(good.approximate);
      walled = true;
      clock.advance(TEMPO_STATS_TTL_MS + 1);
      const pages = stub.asked.pages;
      const held = await cached(TREASURY);
      assert.equal(held.status, 200);
      assert.equal(stub.asked.pages, pages + 1);
      assert.deepEqual(
        { ...(held.body as TempoStats), computedAt: "", approximate: false },
        { ...good, computedAt: "" }
      );
      assert.isTrue((held.body as TempoStats).approximate);

      // A console that has read nothing: the refusal is the answer, as a rate limit and not as Tempo down.
      const empty = await persistentTempoStats({ file: tmpFile(), deps })(TREASURY);
      assert.equal(empty.status, 503);
      assert.match((empty.body as { error: string }).error, /rate-limited.*402/);
      const err = await computeTempoStats(TREASURY, deps).catch((e) => e);
      assert.instanceOf(err, TempoStatsRateLimited);
      assert.equal(err.resetAt, NOW + 60_000);
    });

    it("stops paging before ratelimit-remaining reaches zero, and waits for the window's reset", async () => {
      const clock = clocked();
      const reset = (NOW + 45_000) / 1000;
      const reset2 = (NOW + 90_000) / 1000;
      // The first two answers count a window down to the reserve; the third, in the next window,
      // is already at it; the rest come from a fresh one.
      const left = [TEMPO_FEED_RESERVE + 1, TEMPO_FEED_RESERVE, TEMPO_FEED_RESERVE];
      const stub = tempoStub({
        feedHeaders: (page) => ({
          "ratelimit-limit": "20",
          "ratelimit-remaining": String(left[page] ?? 19),
          "ratelimit-reset": String(page < 2 ? reset : reset2),
        }),
      });
      const memory = emptyFeedMemory();
      const deps = { reader: zeros, fetch: stub.fetch, memory, now: clock.now };
      const cut = await computeTempoStats(TREASURY, deps);
      assert.equal(stub.asked.pages, 2, "no request spent the reserve");
      assert.isTrue(cut.approximate);
      assert.deepEqual(memory.resume, ["6"]);
      assert.equal(memory.quietUntil, reset * 1000);
      // Inside the window: no request at all, and the rows held are still the figures.
      const quiet = await computeTempoStats(TREASURY, deps);
      assert.equal(stub.asked.pages, 2);
      assert.isTrue(quiet.approximate);
      assert.equal(quiet.since, FEED[5].timestamp);
      // After the reset the head is read, but it leaves the window at the reserve, so the resumed
      // walk waits for the next one rather than spend it.
      clock.advance(46_000);
      const head = await computeTempoStats(TREASURY, deps);
      assert.isTrue(head.approximate);
      assert.deepEqual(stub.asked.cursors, [null, "3", null]);
      assert.deepEqual(memory.resume, ["6"]);
      assert.equal(memory.quietUntil, reset2 * 1000);
      // In a fresh window: the head, then the cursor it stopped at.
      clock.advance(45_000);
      const whole = await computeTempoStats(TREASURY, deps);
      assert.isFalse(whole.approximate);
      assert.deepEqual(stub.asked.cursors, [null, "3", null, null, "6"]);
      assert.isUndefined(memory.quietUntil);
    });

    it("drops a resume cursor the feed refuses, and walks from the top next time", async () => {
      const memory = { ...emptyFeedMemory(), rows: FEED.slice(0, 3), resume: ["stale"] };
      const stub = tempoStub({
        feedAnswer: (page) => (page === 1 ? new Response("bad cursor", { status: 400 }) : null),
      });
      const deps = { reader: zeros, fetch: stub.fetch, memory, now: () => NOW };
      const err = await computeTempoStats(TREASURY, deps).catch((e) => e);
      assert.instanceOf(err, TempoStatsUpstreamError);
      assert.deepEqual(memory, { ...emptyFeedMemory(), settled: memory.settled });
      const whole = await computeTempoStats(TREASURY, deps);
      assert.isFalse(whole.approximate);
      assert.lengthOf(memory.rows, FEED.length);
    });
  });

  describe("the console", () => {
    it("answers 404 with a sentence, and asks Tempo nothing, when no treasury is configured", async () => {
      let computed = 0;
      const cached = tempoStatsCache(async () => {
        computed++;
        throw new Error("never");
      });
      const reply = await answerTempoStats(null, cached);
      assert.equal(reply.status, 404);
      assert.match((reply.body as { error: string }).error, /no Tempo treasury/);
      assert.equal(computed, 0);
      // The hook passes the sentence through as the tab's reason.
      globalThis.fetch = (async () => Response.json(reply.body, { status: reply.status })) as unknown as typeof fetch;
      assert.deepEqual(await fetchTempoStats(), { status: 404, error: (reply.body as { error: string }).error });
    });

    it("serves the treasury's figures through the route, from the cache on the second GET", async function () {
      // A throwaway key: the route reads only the address it derives. Set before `_lib/tempo` first
      // reads it; a suite earlier in the same run that read it unset leaves the rail off for good.
      process.env.LATH_TEMPO_TREASURY = `0x${"42".repeat(32)}`;
      const { tempoTreasuryAddress } = await import("../frontend/src/app/api/_lib/tempo");
      const address = tempoTreasuryAddress();
      if (!address) return this.skip();
      const stub = tempoStub();
      globalThis.fetch = stub.fetch;
      const { GET } = await import("../frontend/src/app/api/tempo/stats/route");
      const res = await GET();
      assert.equal(res.status, 200);
      const body = (await res.json()) as TempoStats;
      assert.equal(body.treasury, address);
      assert.deepEqual(body.channels, { opened: 2, settled: 1, open: 1, unread: 0 });
      assert.equal(body.paidBase, "4700");
      const asked = { ...stub.asked, reads: stub.asked.reads.length };
      const again = await GET();
      assert.deepEqual(await again.json(), body);
      assert.deepEqual({ ...stub.asked, reads: stub.asked.reads.length }, asked, "the second GET asked Tempo nothing");
      // And it kept the feed where a restart will find it.
      const saved = JSON.parse(fs.readFileSync(path.join(traceDir, TEMPO_STATS_FILE), "utf8")) as TempoStatsFile;
      assert.equal(saved.treasury, address.toLowerCase());
      assert.deepEqual(saved.stats, body);
    });
  });
});
