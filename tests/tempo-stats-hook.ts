/**
 * `useTempoStats`'s read (`frontend/src/lib/tempo-stats.ts`), against a stubbed `fetch`: the
 * `/api/tempo/stats` contract (`frontend/src/types/tempo-stats.ts`) as the Tempo tab receives it.
 * Every failure is an answer with an `error`, never a throw and never a row of zeros. Node-only;
 * nothing leaves the process.
 */
import { assert } from "chai";
import { fetchTempoStats } from "../frontend/src/lib/tempo-stats";
import type { TempoStats } from "../frontend/src/types/tempo-stats";

const STATS: TempoStats = {
  treasury: "0x18fbe5e0a83dca440072059f91d1a23babe6e0b0",
  since: "2026-09-29T10:00:00.000Z",
  until: "2026-10-05T10:00:00.000Z",
  days: 6,
  channels: { opened: 12, settled: 11, open: 1, unread: 0 },
  depositedBase: "4140000",
  channelPaidBase: "1234567",
  refundedBase: "2560000",
  parkedBase: "345433",
  approximate: false,
  storage: { count: 3, amountBase: "3000" },
  paidBase: "1237567",
  computedAt: "2026-10-05T10:05:00.000Z",
  recent: [
    {
      kind: "close",
      txHash: "0x9c0eb80273a5021a09d2c157764cfd303a374ea16dd9296d40e4f81d154227dc",
      amountBase: "0",
      at: "2026-10-05T10:00:00.000Z",
    },
    {
      kind: "open",
      txHash: `0x${"aa".repeat(32)}`,
      channelId: `0x${"11".repeat(32)}`,
      amountBase: "345000",
      at: "2026-10-05T09:00:00.000Z",
    },
  ],
};

describe("useTempoStats's read of /api/tempo/stats", () => {
  const real = globalThis.fetch;
  let asked: string[] = [];
  const answer = (respond: () => Promise<Response>) => {
    asked = [];
    globalThis.fetch = (async (url: any) => {
      asked.push(String(url));
      return respond();
    }) as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = real;
  });

  it("answers with the figures the route served", async () => {
    answer(async () => new Response(JSON.stringify(STATS), { status: 200 }));
    const got = await fetchTempoStats();
    assert.deepEqual(asked, ["/api/tempo/stats"]);
    assert.deepEqual(got, { stats: STATS });
  });

  it("makes a 404 an error state, in words, not a throw", async () => {
    answer(async () => new Response("not found", { status: 404 }));
    const got = await fetchTempoStats();
    assert.isUndefined(got.stats);
    assert.equal(got.status, 404);
    assert.equal(got.error, "this console serves no Tempo figures");
  });

  it("passes on the route's own sentence when it gave one", async () => {
    answer(async () => new Response(JSON.stringify({ error: "no Tempo treasury is configured" }), { status: 503 }));
    assert.deepEqual(await fetchTempoStats(), { status: 503, error: "no Tempo treasury is configured" });
    answer(async () => new Response("<html>", { status: 502 }));
    assert.deepEqual(await fetchTempoStats(), { status: 502, error: "the console answered HTTP 502" });
  });

  it("makes a fetch that threw an error state too", async () => {
    answer(async () => {
      throw new Error("connection refused");
    });
    const got = await fetchTempoStats();
    assert.isUndefined(got.stats);
    assert.include(got.error, "connection refused");
  });

  it("refuses a 200 that is not a set of figures rather than draw zeros", async () => {
    for (const body of ["null", "{}", JSON.stringify({ treasury: "0x1" }), "not json"]) {
      answer(async () => new Response(body, { status: 200 }));
      const got = await fetchTempoStats();
      assert.isUndefined(got.stats, body);
      assert.equal(got.error, "the console's answer is not a set of Tempo figures");
    }
  });
});
