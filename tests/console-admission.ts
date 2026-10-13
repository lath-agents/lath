// First, so `LATH_TRACE_DIR` is set before `runner.ts` captures it: CI runs every console suite in
// one process, and this file sorts first, so without it the registry would write to `./.traces`
// while every later `clearStore` empties the fixture's temp dir.
import "./fixtures/trace-dir";
import { assert } from "chai";
import {
  acquireRunSlot,
  admitSpend,
  extendRunSlot,
  holdRunSlot,
  largestSingleCharge,
  runSlotHolder,
} from "../frontend/src/app/api/_lib/runner";
import { perCallCeiling } from "../frontend/src/app/api/_lib/tempo";

/**
 * What a grant has to cover before a run may spend the operator's model key
 * (`_lib/runner.ts`, `admitSpend`).
 *
 * Three routes admit a run — a console session, a loop step and a loop's anchor retry. A
 * predicate of `grant.cap > grant.spent && spendable > 0n` would be a dust threshold on both
 * halves, and it reads `spent` where the program reads `spent + reserved`. Because a charge is
 * journaled rather than awaited, and the runtime counts a journaled charge as spent, nothing
 * downstream would notice: one micro-USDC would buy a whole session's worth of real inference,
 * the charges would fail on chain afterwards, and the answer would already have been given.
 *
 * So the cases below are about a floor, and the floor is the largest charge the *first* metered
 * record can carry. Everything here is arithmetic over decoded accounts — no RPC and no chain.
 */
describe("what a grant must cover before a run is admitted", () => {
  /** A session's numbers: 0.25 USDC over six steps, so one record can charge 0.041666. */
  const CAP = 250_000n;
  const STEPS = 6;
  const NEEDED = 41_666n;
  /** An hour from now, in the unix **seconds** the account carries. */
  const future = Math.floor(Date.now() / 1000) + 3600;
  const grant = (p: { cap: bigint; spent: bigint; reserved?: bigint; expiresAt?: number }) => ({
    cap: p.cap,
    spent: p.spent,
    ...(p.reserved === undefined ? {} : { reserved: p.reserved }),
    expiresAt: p.expiresAt ?? future,
  });

  it("charges the same per-record ceiling the tempo rail sizes its deposit from", () => {
    // The two are the same formula in two modules (the comment on `largestSingleCharge` says why
    // it is not one import). This is what notices if either is ever changed alone.
    for (const [cap, steps] of [
      [CAP, STEPS],
      [1n, 6],
      [7n, 3],
      [1_000_000n, 1],
    ] as const) {
      assert.equal(largestSingleCharge(cap, steps), perCallCeiling(cap, steps), `${cap} over ${steps}`);
    }
    assert.equal(largestSingleCharge(CAP, STEPS), NEEDED);
  });

  it("refuses a dust deposit below the floor, and says it was the deposit", () => {
    // The dust case: the grant is generous, the escrow holds one micro-USDC. A `spendable > 0n`
    // predicate would admit this, and the session would then run 0.25 USDC of inference.
    const refused = admitSpend({
      grant: grant({ cap: CAP, spent: 0n, reserved: 0n }),
      spendable: 1n,
      cap: CAP,
      maxSteps: STEPS,
    });
    assert.property(refused, "refuse");
    const why = (refused as { refuse: string }).refuse;
    assert.include(why, "escrow deposit is short", "the caller is told which of the two to fix");
    assert.include(why, "0.000001 USDC spendable");
    assert.include(why, "0.041666 USDC", "and what the first record can charge");
  });

  it("refuses a dust allowance below the floor, and says it was the allowance", () => {
    const refused = admitSpend({
      grant: grant({ cap: 1n, spent: 0n, reserved: 0n }),
      spendable: 10_000_000n,
      cap: CAP,
      maxSteps: STEPS,
    });
    assert.include((refused as { refuse: string }).refuse, "allowance is short");
  });

  it("refuses a grant whose headroom is entirely held in `reserved`", () => {
    // The program's own cap check is `spent + reserved` (`committed`), so this grant can
    // pay nothing — and a predicate that compared `cap` to `spent` alone would call it live.
    const refused = admitSpend({
      grant: grant({ cap: CAP, spent: 0n, reserved: CAP }),
      spendable: 10_000_000n,
      cap: CAP,
      maxSteps: STEPS,
    });
    const why = (refused as { refuse: string }).refuse;
    assert.include(why, "allowance is short");
    assert.include(why, "held 0.250000 USDC", "the hold is named, so the owner knows to wait or release it");
    assert.include(why, "0.000000 USDC of headroom left");
  });

  it("admits a healthy grant, and reports the headroom it admitted on", () => {
    const ok = admitSpend({
      grant: grant({ cap: CAP, spent: 50_000n, reserved: 8_000n }),
      spendable: 500_000n,
      cap: CAP,
      maxSteps: STEPS,
    });
    assert.deepEqual(ok, { ok: true, needed: NEEDED, headroom: 192_000n });
  });

  it("admits a grant that predates `reserved`, whose field decodes as absent", () => {
    // An older grant has no `reserved` and cannot hold anything, so its headroom really
    // is `cap − spent`. Treating the missing field as zero keeps those grants working, which is
    // the invariant that old chains must keep running under a new build.
    const ok = admitSpend({ grant: grant({ cap: CAP, spent: 0n }), spendable: CAP, cap: CAP, maxSteps: STEPS });
    assert.deepEqual(ok, { ok: true, needed: NEEDED, headroom: CAP });
  });

  it("refuses an expired grant and a missing one, in the words the caller can act on", () => {
    const expired = admitSpend({
      grant: grant({ cap: CAP, spent: 0n, reserved: 0n, expiresAt: Math.floor(Date.now() / 1000) - 1 }),
      spendable: CAP,
      cap: CAP,
      maxSteps: STEPS,
    });
    assert.include((expired as { refuse: string }).refuse, "expired");
    const none = admitSpend({ grant: null, spendable: CAP, cap: CAP, maxSteps: STEPS });
    assert.include((none as { refuse: string }).refuse, "no allowance");
  });

  it("admits a wallet that has funded some of the run but not all of it", () => {
    // Deliberately not "the whole cap must be payable": the per-record charge is what stops a
    // run when the money stops, and demanding the cap up front would refuse honest small budgets.
    const ok = admitSpend({
      grant: grant({ cap: CAP, spent: 0n, reserved: 0n }),
      spendable: NEEDED,
      cap: CAP,
      maxSteps: STEPS,
    });
    assert.property(ok, "ok");
  });

  it("holds a loop step to its own per-step budget, not to a session's cap", () => {
    // `_lib/loops.ts` passes `budgetMicroUsdcPerStep`. A loop metered at 0.012 USDC a step needs
    // 0.002 for its first record, so a wallet with 0.005 in escrow steps — and the same wallet
    // would be refused a 0.25 USDC session.
    const budget = 12_000n;
    assert.property(
      admitSpend({
        grant: grant({ cap: budget, spent: 0n, reserved: 0n }),
        spendable: 5_000n,
        cap: budget,
        maxSteps: 6,
      }),
      "ok"
    );
    assert.property(
      admitSpend({ grant: grant({ cap: CAP, spent: 0n, reserved: 0n }), spendable: 5_000n, cap: CAP, maxSteps: 6 }),
      "refuse"
    );
  });
});

/**
 * The run slot's crash guard, and why its ceiling is a report rather than a release
 * (`_lib/runner.ts`, `extendRunSlot`).
 */
describe("holding the run slot while a drain is still running", () => {
  const LIMIT = 45 * 60_000;

  it("keeps extending for as long as the work has not exited, past the ceiling", () => {
    // The finding: the heartbeat stopped at 45 minutes, `runSlotHolder` reads a lapsed TTL as
    // free, and a second session then wrote the same chain beside the first one's drain.
    const late = extendRunSlot({ workRunning: true, heldMs: LIMIT * 4, limitMs: LIMIT });
    assert.isTrue(late.extend, "a drain that has not reported done keeps the slot");
    assert.isTrue(late.wedged, "and is reported, because holding this long is a stuck process");
  });

  it("stops extending the moment the work exits, so the next caller is not made to wait out a TTL", () => {
    assert.deepEqual(extendRunSlot({ workRunning: false, heldMs: 1, limitMs: LIMIT }), {
      extend: false,
      wedged: false,
    });
    // `hold` releases the slot in the same tick it sets this false; the heartbeat is belt and
    // braces, and must not hold a slot nobody is using.
    assert.deepEqual(extendRunSlot({ workRunning: false, heldMs: LIMIT * 4, limitMs: LIMIT }), {
      extend: false,
      wedged: false,
    });
  });

  it("does not report a healthy long session as wedged", () => {
    const fine = extendRunSlot({ workRunning: true, heldMs: LIMIT - 1, limitMs: LIMIT });
    assert.deepEqual(fine, { extend: true, wedged: false });
  });
});

/**
 * The run slot must not be released while the session could still write. `/api/run` races a session
 * against its deadline, and the deadline ends the *wait*, not the session: the anchor drain takes
 * no signal on purpose (a drain stopped mid-record is worse than a slow one), so a session past
 * its deadline can still be writing its chain. The slot is therefore held by `holdRunSlot` until
 * the work exits, and pushed past its own TTL while it runs (`_lib/runner.ts`).
 */
describe("the run slot outlives the request's deadline", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const deferred = () => {
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const promise = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    return { promise, ...settle };
  };

  it("keeps a second writer out until the abandoned session exits, past the deadline, the TTL and the ceiling", async () => {
    const slot = acquireRunSlot("a console session (slot test)", 60);
    assert.isNotNull(slot, "the slot was free when the test began");
    const work = deferred();
    let wedged = 0;
    const hold = holdRunSlot(slot!, work.promise, { ttlMs: 60, limitMs: 120, beatMs: 20, onWedged: () => wedged++ });

    try {
      // The route's deadline: the request stops waiting and closes its stream; the session goes on.
      const waited = await Promise.race([work.promise.then(() => "exited"), sleep(80).then(() => "deadline")]);
      assert.equal(waited, "deadline");
      await sleep(200);

      // Past the deadline, past the 60 ms TTL a lapsed slot would be free at, past the ceiling.
      assert.equal(runSlotHolder(), "a console session (slot test)", "still held while the session can write");
      const second = acquireRunSlot("a second writer", 1_000);
      second?.release();
      assert.isNull(second, "the next caller is refused, not let in beside it");
      assert.equal(wedged, 1, "held past the ceiling is reported, once, and is not a release");
    } finally {
      // A session that fails is still an exit: the slot goes then, in the same tick. In a
      // `finally` so a failed assertion above does not leave the heartbeat running.
      work.reject(new Error("anchoring failed"));
      await hold;
    }
    assert.isNull(runSlotHolder(), "released the moment the work exits");
    const next = acquireRunSlot("the next writer", 1_000);
    assert.isNotNull(next, "and the next writer gets it without waiting out a TTL");
    next!.release();
  });

  it("releases at once when the work exits before its deadline", async () => {
    const slot = acquireRunSlot("a console session (slot test)", 60_000);
    assert.isNotNull(slot);
    const work = deferred();
    const hold = holdRunSlot(slot!, work.promise, {
      ttlMs: 60_000,
      limitMs: 180_000,
      beatMs: 15_000,
      onWedged: () => {},
    });
    assert.equal(runSlotHolder(), "a console session (slot test)");
    work.resolve();
    await hold;
    assert.isNull(runSlotHolder());
  });
});
