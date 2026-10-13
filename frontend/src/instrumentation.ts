/**
 * Runs once when the Next server starts (`register`, Next 15). First it reads OpenRouter's model
 * list, so every loop step's sandbox knows its model's context window (below); then two things, both
 * about the Tempo treasury:
 *
 * 1. **Claim the treasury.** The open-channel ledger is a file, per process, and two consoles on
 *    one treasury would each hold channels the other cannot see or close. So the second one is
 *    refused here, at start, with the pid that holds the lock in the reason — a throw from
 *    `register` is how a Next server declines to come up.
 * 2. **Settle what the last process left open.** Every row the ledger still names is a channel
 *    whose deposit is the treasury's until the treasury's key closes it: a chat session's row is
 *    closed directly, a loop's goes through `settleLoopChannel` so the `loop.settlement` record
 *    lands on that loop's chain. Fired, not awaited: `openTempoChannel` awaits the same promise
 *    before its first deposit, so no session opens on top of a row not yet settled.
 *
 * Only the Node runtime does this — the edge runtime has no filesystem and no treasury. With no
 * treasury configured there is nothing to claim and nothing that could be open.
 *
 * The runtime check is an `if` around the imports rather than an early return on purpose: Next
 * compiles this file once per runtime and substitutes `NEXT_RUNTIME` at build time, and webpack
 * drops the body of an `if (false)` before it resolves the imports inside it. An early return
 * leaves them in the edge bundle, where `_lib/loops`'s imports reach Node's `crypto`, and the
 * whole server answers 500 (`Module not found: Can't resolve 'crypto'`) on every route.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Before the treasury, and whether or not there is one: every loop step's sandbox needs its model's
    // context window, and a first read of OpenRouter's list made from inside a step can time out while
    // the console pins that loop's files, leaving the step at ZeroClaw's 32 000-token fallback
    // (`runtime/src/zeroclaw/context-window.ts`). Read here, on an idle process, it is held before any
    // step asks. Fired, not awaited: a console with no network still comes up, and a read that fails
    // is forgotten, so the first step reads again or takes the table.
    const windows = await import("@lath/runtime/zeroclaw/context-window");
    void windows.prefetchOpenRouterContextWindows().then((held) => {
      console.log(
        held
          ? "zeroclaw: model context windows read from OpenRouter's list"
          : "zeroclaw: OpenRouter's model list could not be read at start; the first step reads it again"
      );
    });
    const tempo = await import("./app/api/_lib/tempo");
    if (!tempo.tempoEnabled()) return;
    const lock = tempo.claimTreasury();
    console.log(`tempo: treasury claimed by pid ${lock.pid} (${tempo.tempoTreasuryAddress()})`);
    const loops = await import("./app/api/_lib/loops");
    // The row goes with the id: a loop killed early in its first step has a ledger row and no
    // `channel` on its own record, and settling from the record alone would strand the deposit.
    // The settle takes the run slot for its record like every other write of a loop's
    // chain, and asks for it once: taken, it settles nothing, and the pass closes that row by id
    // instead — the deposit comes back without the record, rather than the record landing beside
    // another writer or the pass waiting on a caller that awaits it.
    void tempo.recoverOpenChannels({
      settleLoop: (loopId, row) => loops.settleLoopChannel(loopId, "restart", {}, row),
    });
  }
}
