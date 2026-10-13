/**
 * The arithmetic behind the billing spend chart. No validator, no browser —
 * bucketing is the part that can be wrong, and it is pure.
 */
import { assert } from "chai";
import { spendByDay } from "../frontend/src/lib/spend";

const at = (iso: string, amount: number, name = "Charged") =>
  ({
    name,
    direction: "debit",
    signature: iso,
    slot: 1,
    blockTime: Math.floor(new Date(iso).getTime() / 1000),
    amount: BigInt(amount),
    agentAuthority: null,
  } as any);

const NOW = new Date("2026-08-25T12:00:00Z");

describe("spend chart bucketing", () => {
  it("fills every day in the window, including the ones with no charges", () => {
    const rows = spendByDay([at("2026-08-25T01:00:00Z", 100)], 5, NOW);
    assert.deepEqual(
      rows.map((r) => r.day),
      ["2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25"]
    );
    // A gap is information; plotting only the days that had charges compresses time.
    assert.deepEqual(
      rows.map((r) => r.amount),
      [0n, 0n, 0n, 0n, 100n]
    );
  });

  it("sums several charges in one day", () => {
    const rows = spendByDay([at("2026-08-24T01:00:00Z", 100), at("2026-08-24T23:59:00Z", 50)], 3, NOW);
    assert.equal(rows.find((r) => r.day === "2026-08-24")!.amount, 150n);
  });

  it("counts only charges — not the user's own deposits, and not unspent holds", () => {
    const rows = spendByDay(
      [
        at("2026-08-25T01:00:00Z", 100, "Charged"),
        at("2026-08-25T02:00:00Z", 900, "Deposited"),
        at("2026-08-25T03:00:00Z", 700, "Withdrawn"),
        at("2026-08-25T04:00:00Z", 500, "Reserved"),
        at("2026-08-25T05:00:00Z", 500, "Released"),
      ],
      2,
      NOW
    );
    assert.equal(rows[1].amount, 100n);
  });

  it("drops a row the RPC has no block time for, rather than dating it now", () => {
    const noTime = { ...at("2026-08-25T01:00:00Z", 999), blockTime: null };
    const rows = spendByDay([noTime, at("2026-08-25T01:00:00Z", 1)], 2, NOW);
    assert.equal(rows[1].amount, 1n, "an undated charge is not silently attributed to today");
  });

  it("ignores charges older than the window", () => {
    const rows = spendByDay([at("2026-07-01T01:00:00Z", 5000), at("2026-08-25T01:00:00Z", 7)], 3, NOW);
    assert.equal(
      rows.reduce((s, r) => s + r.amount, 0n),
      7n
    );
  });

  it("crosses a month boundary by date, not by subtracting 30 days from a day number", () => {
    const rows = spendByDay([], 4, new Date("2026-09-02T12:00:00Z"));
    assert.deepEqual(
      rows.map((r) => r.day),
      ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]
    );
  });
});
