/**
 * `scripts/tempo-stats.ts` — the treasury's Tempo figures for the submission's Tempo line. The
 * sorting and the arithmetic are `frontend/src/app/api/_lib/tempo-stats.ts`, which the script
 * re-exports and `GET /api/tempo/stats` serves (its own suite is `console-tempo-stats`).
 *
 * Node-only, network-free: the feed rows are fixtures shaped like `api.tempo.xyz`'s, and channel
 * states are handed in, so what is pinned is the sorting and the arithmetic, not Tempo's answers.
 */
import { assert } from "chai";
import { TEMPO_ESCROW, TEMPO_USDC_E } from "../sdk/src";
import { classify, parseArgs, summarize, usdc, type Activity } from "../scripts/tempo-stats";
import * as core from "../frontend/src/app/api/_lib/tempo-stats";

const TREASURY = "0x18fB0000000000000000000000000000000000B0";
const OTHER_TOKEN = "0x20c0000000000000000000000000000000000000";

function row(type: string, perspective: string, base: number, data: Activity["data"] = {}, token = TEMPO_USDC_E) {
  return {
    type,
    perspective,
    timestamp: `2026-10-0${1 + (base % 3)}T00:00:00.000Z`,
    data: { sourceAmount: { baseUnits: String(base) }, sourceToken: { address: token }, ...data },
  } as Activity;
}

describe("tempo-stats", () => {
  it("sorts each feed row into what it means for the treasury", () => {
    assert.equal(classify(row("channel-opened", "outgoing", 940, { channelId: "0xa" })).kind, "channel-open");
    assert.equal(classify(row("channel-funded", "outgoing", 10_000, { channelId: "0xa" })).kind, "channel-fund");
    // The escrow's address in any case is a refund; anyone else sending USDC.e is a top-up.
    assert.equal(classify(row("transfer", "incoming", 3, { sender: TEMPO_ESCROW.toUpperCase() })).kind, "refund");
    assert.equal(classify(row("transfer", "incoming", 4, { sender: "0x77bc" })).kind, "topup");
    assert.equal(classify(row("transfer", "outgoing", 100, { attribution: "Object Storage" })).kind, "storage");
    assert.equal(classify(row("transfer", "outgoing", 60, { attribution: null })).kind, "other-out");
    // A row in another token is not a payment these figures describe.
    assert.equal(classify(row("channel-opened", "outgoing", 5, { channelId: "0xb" }, OTHER_TOKEN)).kind, "other");
  });

  it("subtracts refunds and parked money from deposits, and adds storage", () => {
    const rows = [
      row("channel-opened", "outgoing", 1_000, { channelId: "0xA" }),
      row("channel-funded", "outgoing", 9_000, { channelId: "0xa" }),
      row("transfer", "incoming", 6_000, { sender: TEMPO_ESCROW }),
      row("channel-opened", "outgoing", 2_000, { channelId: "0xb" }),
      row("transfer", "outgoing", 100, { attribution: "Object Storage" }),
      row("transfer", "incoming", 4_000_000, { sender: "0x77bc" }),
    ].map(classify);
    // 0xa closed (zeros); 0xb open with 2 000 deposited and 500 settled, so 1 500 is parked.
    const states = new Map([
      ["0xa", { settled: 0n, deposit: 0n }],
      ["0xb", { settled: 500n, deposit: 2_000n }],
    ]);
    const s = summarize(TREASURY, rows, states);
    assert.deepEqual(s.channels, { opened: 2, closed: 1, open: 1, unknown: 0 });
    assert.equal(s.depositedBase, 12_000n);
    assert.equal(s.refundedBase, 6_000n);
    assert.equal(s.parkedBase, 1_500n);
    assert.equal(s.channelPaidBase, 4_500n);
    assert.deepEqual(s.storage, { count: 1, base: 100n });
    assert.equal(s.paidBase, 4_600n);
    assert.deepEqual(s.topups, { count: 1, base: 4_000_000n });
    assert.isFalse(s.approximate);
  });

  it("says the paid figure is approximate when a channel's state is missing", () => {
    const rows = [row("channel-opened", "outgoing", 1_000, { channelId: "0xc" })].map(classify);
    const s = summarize(TREASURY, rows, new Map());
    assert.deepEqual(s.channels, { opened: 1, closed: 0, open: 0, unknown: 1 });
    assert.isTrue(s.approximate);
  });

  it("prints base units with six decimals", () => {
    assert.equal(usdc(2_416_403n), "2.416403");
    assert.equal(usdc(100n), "0.000100");
    assert.equal(usdc(-5n), "-0.000005");
  });

  it("is the console's core, so the printed line and the Tempo tab cannot disagree", () => {
    assert.strictEqual(classify, core.classify);
    assert.strictEqual(summarize, core.summarize);
    assert.strictEqual(usdc, core.usdc);
  });

  it("counts the days the rows span, at least one when there are any", () => {
    assert.equal(core.statsDays({ from: null, to: null }), 0);
    assert.equal(core.statsDays({ from: "2026-10-01T08:00:00Z", to: "2026-10-01T09:00:00Z" }), 1);
    assert.equal(core.statsDays({ from: "2026-10-01T08:00:00Z", to: "2026-10-04T09:00:00Z" }), 4);
  });

  it("refuses a malformed address or date", () => {
    assert.throws(() => parseArgs(["--address", "0x12"]), /not an address/);
    assert.throws(() => parseArgs(["--since", "yesterday-ish"]), /not a date/);
    const a = parseArgs(["--address", TREASURY, "--since", "2026-10-06", "--json", "--no-state"]);
    assert.equal(a.address, TREASURY);
    assert.equal(a.since?.toISOString(), "2026-10-06T00:00:00.000Z");
    assert.isTrue(a.json && a.noState);
  });
});
