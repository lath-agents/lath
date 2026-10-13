/**
 * The loop's Tempo services (`_lib/loops.ts` re-exports the public names): the storage and RPC a paid
 * loop's steps use, held for the run, and the step row they write to.
 */
import { LoopTempoServices, type StoragePut, type TempoSnapshot } from "@lath/runtime";
import type { LoopStepSummary } from "../../../types/loop";
import { TEMPO_USDC_E, tempoEnabled, treasuryAccount, treasuryChargeTransport, treasuryRpcSession } from "./tempo";
import { TIP20_TRANSFER_WITH_MEMO_SELECTOR, type LoopTempoKey } from "./tempo-keys";
import type { LoopRecord } from "./loop-record";
import { scheduler } from "./loop-state";
import { updateLoop } from "./loop-registry";
import { loopChannelMark } from "./loop-channel-state";
import { rememberKeyCharge } from "./loop-key";

// ─── The loop's Tempo services ──────────────────────────────────────────────
//
// A paid loop publishes each step's report to Tempo storage, from the treasury, after the step's
// leaf has landed. The object that does it lives here for the loop's run, beside its channel, and
// every runner of the loop — each step's, and the one a settlement builds — is handed it: a step's
// runner writes the `storage.put` Actions the previous PUTs owe, and a settlement's drains what is
// still in flight before it writes the stop record. A loop with no treasury never builds one, so its
// steps publish nothing to Tempo storage and read no paid RPC.

/**
 * The charge client a loop's owner-paid storage PUTs go through. A keyed loop's carry its id as
 * mppx's `clientId`, so each transfer's attribution memo names the loop in bytes 15..24 and the
 * audit can hold the charge to it — whether its key signs them or, with `STORAGE_CHARGES_UNDER_KEY`
 * off, the treasury does, because either way they are this loop's spend. An unkeyed loop's is the
 * plain call, with no third argument, so its memos keep mppx's anonymous zeros byte for byte.
 * `make` is the seam a suite reads the arguments through.
 */
export function loopStorageTransport(
  loop: Pick<LoopRecord, "id" | "tempoKey">,
  storageKey?: unknown,
  make: typeof treasuryChargeTransport = treasuryChargeTransport
): ReturnType<typeof treasuryChargeTransport> {
  const account = storageKey as Parameters<typeof treasuryChargeTransport>[1];
  if (!loop.tempoKey) return account ? make(undefined, account) : make();
  const pinned = storagePayeesOf(loop.tempoKey);
  return make(undefined, account, { clientId: loop.id, ...(pinned ? { expectedRecipients: pinned } : {}) });
}

/**
 * The recipients a scoped key's USDC.e `transferWithMemo` scope admits — the storage payee the
 * start read — so a keyed loop's charges are pinned to it and a challenge naming anyone else is
 * refused before the key signs a transfer Tempo would turn away (if `CallNotAllowed` only lands at
 * execution, that transfer is mined, reverts and costs a fee, every step). `undefined` for an
 * unscoped key, which pins nothing. A scoped key with no such scope pins to nobody (`[]`): it could
 * pay no storage call anyway, and this way it signs none.
 */
function storagePayeesOf(key: LoopTempoKey): string[] | undefined {
  if (!key.scopes) return undefined;
  return key.scopes
    .filter(
      (s) =>
        s.address.toLowerCase() === TEMPO_USDC_E.toLowerCase() &&
        s.selector?.toLowerCase() === TIP20_TRANSFER_WITH_MEMO_SELECTOR.toLowerCase()
    )
    .flatMap((s) => (s.recipients ?? []).map((r) => r.toLowerCase()));
}

/**
 * This loop's services: the held one, or — on a paid step, `create` — a new one over the treasury's
 * charge client. `undefined` when the rail is off or no paid step has built one yet.
 */
export function loopTempoServices(
  loop: LoopRecord,
  create: boolean,
  /**
   * The loop's access-key account, when its storage charges are signed under its cap
   * (`STORAGE_CHARGES_UNDER_KEY`); absent, they are the treasury's.
   */
  storageKey?: unknown
): LoopTempoServices | undefined {
  const s = scheduler();
  const held = s.tempoServices.get(loop.id);
  if (held || !create || !tempoEnabled()) return held;
  const services = new LoopTempoServices({
    loopId: loop.id,
    storage: loopStorageTransport(loop, storageKey),
    onStorage: (put) => {
      rememberStepStorage(loop.id, put.ofStep, storageRowView(put));
      // A charge the key signed spends its limit for good: a row of its own, so no reconcile restores it.
      if (storageKey) rememberKeyCharge(loop.id, put);
    },
    // The paid RPC: the treasury's own session, Lath's spend, charged to nobody.
    rpc: treasuryRpcSession(loop.agentId),
    treasury: treasuryAccount().address,
    // The loop's model channel as this process holds it when the reads run: the channel a snapshot
    // reads the escrow for, and the cumulative the payer has signed on it.
    channel: () => {
      const mark = loopChannelMark(loop.id);
      return { id: mark.channelId, cumulative: mark.cumulative };
    },
    onSnapshot: (snapshot) => rememberStepSnapshot(loop.id, snapshot),
  });
  s.tempoServices.set(loop.id, services);
  return services;
}

/** Settles nothing on chain — the settlement's runner did that — and lets go of the services. */
export function releaseTempoServices(id: string): void {
  const s = scheduler();
  const services = s.tempoServices.get(id);
  s.tempoServices.delete(id);
  // Idempotent: a settlement that already drained and closed them hands back the same answer, and
  // one that never reached them (a loop whose row was gone) still waits its jobs out.
  if (services) void services.close().catch(() => undefined);
}

/**
 * A snapshot onto the row of the step it was taken after (`LoopStepSummary.tempoSnapshot`): what
 * the loop page reads _read from Tempo at block N_ off. Cosmetic like the storage view; the chain's
 * copy is the one the next leaf carries.
 */
function rememberStepSnapshot(id: string, snapshot: TempoSnapshot): void {
  try {
    updateLoop(id, (l) => ({
      ...l,
      history: l.history.map((h) => (h.step === snapshot.ofStep ? { ...h, tempoSnapshot: snapshot } : h)),
    }));
  } catch (e) {
    console.warn(
      `[loops] the Tempo snapshot after step ${snapshot.ofStep} of ${id} was not recorded: ${(e as any)?.message ?? e}`
    );
  }
}

/** A PUT as the step row carries it (`LoopStepSummary.tempoStorage`). */
function storageRowView(put: StoragePut): NonNullable<LoopStepSummary["tempoStorage"]> {
  const payment = put.receipt.payment;
  return {
    key: put.key,
    path: put.receipt.path,
    bytes: put.receipt.bytes,
    statusCode: put.statusCode,
    ...(payment ? { amount: payment.amount } : {}),
    ...(payment?.reference ? { reference: payment.reference } : {}),
    ...(put.receipt.error ? { error: put.receipt.error } : {}),
  };
}

/**
 * Writes a PUT onto the row of the step it published, or the Action's seq onto the view already
 * there. A PUT back before its row was written — the report is read and sent while `runOneStep` is
 * still between `step()` and its registry write — is tried again once, a second later; the row is
 * cosmetic, and the Action and its receipt are what the chain keeps either way.
 */
export function rememberStepStorage(
  id: string,
  step: number,
  view: Partial<NonNullable<LoopStepSummary["tempoStorage"]>>
): void {
  rememberStepRow(id, step, "storage", (h) => ({
    ...h,
    tempoStorage: { ...h.tempoStorage, ...view } as NonNullable<LoopStepSummary["tempoStorage"]>,
  }));
}

/**
 * Changes the row of one step, tried again once a second later when the row is not written yet: the
 * Tempo jobs run off the step's clock and can answer while `runOneStep` is still between `step()` and
 * its registry write. `what` names the change in the log line when it cannot be made.
 */
export function rememberStepRow(
  id: string,
  step: number,
  what: string,
  change: (h: LoopStepSummary) => LoopStepSummary,
  retried = false
): void {
  try {
    let found = false;
    updateLoop(id, (l) => ({
      ...l,
      history: l.history.map((h) => {
        if (h.step !== step) return h;
        found = true;
        return change(h);
      }),
    }));
    if (!found && !retried) {
      const timer = setTimeout(() => rememberStepRow(id, step, what, change, true), 1_000);
      timer.unref?.();
    }
  } catch (e) {
    console.warn(`[loops] the ${what} of step ${step} of ${id} was not recorded: ${(e as any)?.message ?? e}`);
  }
}
