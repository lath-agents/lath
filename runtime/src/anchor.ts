/**
 * The journal and the single writer queue behind an interactive-first session.
 *
 * **The head is local; the transaction is not.** Every record's `seq` and `head` follow from
 * the §4.4 formula and can be computed the instant the record exists, which is why a session
 * can answer before the chain confirms. The *transaction* cannot be built ahead of time:
 * `LathClient` reads the confirmed compressed `AgentState` from Photon before every write,
 * because the validity proof needs the prior account's hash and leaf index. So this queue
 * cannot pre-sign a run of records — it is one indexer read, one proof and one confirmation
 * per record, strictly serial, at devnet pace.
 *
 * The rules, all of them load-bearing:
 *
 * 1. **One entry in flight per agent, in journal order.** Seq N+1 cannot be built before N is
 *    confirmed, for the reason above.
 * 2. **A head check before every submit that is not an entry's first attempt, and before the
 *    first submit after a `load`.** If `AgentState` already stands at what the entry leads to,
 *    the write landed and only its confirmation was lost: the entry is marked `verified`
 *    without being sent. Without that check a lost confirmation becomes a duplicate record —
 *    the same session anchored twice, at two seqs, with the audit reporting a chain that no
 *    longer matches the trace store. The check stays armed until a *head-bearing* entry — a
 *    record or an epoch — is actually submitted, because a crash can have left more than one
 *    record landed but unrecorded.
 *    `charge` entries have no head; they are checked by their signature when there is one and
 *    otherwise resent, because a double charge is a bounded loss while a duplicate record is a
 *    broken chain. The signature is journaled the moment the billing client says it sent one and
 *    cannot tell whether it landed, and the next attempt asks the cluster about *that* signature,
 *    over history, before it sends anything: a charge known to have landed is settled, one still
 *    in doubt is not resent, and only one the cluster has no record of (its blockhash long gone
 *    by the time the client gives up) is built again. Dropping the signature with the error would
 *    make each attempt a fresh debit, three per entry and three more per Retry. Sending one
 *    therefore does *not* disarm the check: a charge transaction says nothing about `AgentState`,
 *    and a journal reopened as `[charge, event]` after a crash would otherwise spend the check on
 *    the charge and hand the event a chain nothing reconciled.
 * 3. **After a submit the confirmed head must equal the journaled one.** If it does not,
 *    another writer touched this chain: the entry fails with `head diverged` and the agent's
 *    queue halts rather than reordering anything. One session per agent is what rules this out
 *    in normal operation. Rebasing is never the way out — every journaled head was
 *    precomputed over the heads before it, and a record re-folded onto a chain it was not built
 *    against says something its session did not. The way out is `discard`: the chain's owed
 *    entries are dropped, and written to a side file first, so the loss is recorded rather than
 *    silent. It refuses anything a Retry can still land.
 * 4. **`maxAttempts` attempts, then `failed`, and the agent's queue halts** until `retry`. The
 *    client's own `withRetry` inside one attempt counts as that one attempt: three tries at
 *    1–3 s a confirmation is the budget, and anything slower is a cluster problem.
 *    A charge whose backend answers with no signature fails at once (`ChargeUnpaid`): it is
 *    still owed, and a retry through a backend that can pay sends it.
 * 4a. **A charge the billing program refuses is parked, not failed**: an allowance revoked or
 *    expired, a cap reached, a balance short (`chargeRefusal`). Resending cannot change that
 *    answer, and a charge moves no seq, so nothing behind it on the chain needs it — but as a
 *    `failed` entry it would halt the chain's queue, and on the console's shared agents that would
 *    turn one wallet's lapsed grant into a lock on every other caller. A parked
 *    charge stays in the journal and stays owed (`parked`, `isOwed`), halts nothing, and is put
 *    back in the queue only by a `retry` whose scope names its payer (`parkedScope`), which a
 *    host sets to the wallet it has just admitted. Once parked, a charge that fails again parks
 *    again rather than halting.
 * 5. `drain` and `retry` are what a loop and the console's `FAILED` badge call. Nothing
 *    else in the codebase talks to the chain about a journaled record.
 *
 * What is *not* here, and why: the locator publish that follows an epoch
 * (`AnchoredEpochStore` → a `LocatorRegistry` cell) is the one write whose head is not known
 * at journal time, because the cell folds `computeCellHead` over its own bytes and it lands on
 * this same chain at a seq nobody can know before the epoch commit does. It therefore runs
 * synchronously from the epoch entry's `verified` transition (the `onVerified` hook below),
 * and an epoch is a barrier: a record journaled behind one whose cell has not landed is placed
 * lazily, at its turn (`AnchorEventEntry.lazy`), and the next epoch — which cannot be placed late,
 * its root commits to its `startSeq` — is built only after a drain (`epochTip`), so its local seq
 * accounts for the locator cell.
 *
 * The hook itself is in memory and cannot be anything else: it closes over an `EpochStore`
 * instance. A journal reloaded by another process therefore settles an epoch with nobody to
 * publish its locator. What *is* journaled is the debt — `AnchorEpochEntry.locator` — so the
 * epoch stays in the journal, and stays findable, until something that does hold the store
 * writes the cell: `AgentRuntime.flushAnchors` for a runtime on the same chain, `reanchorEpochs`
 * for a chain no runtime will open again. The queue cannot close that gap by itself; what it can
 * do is keep the entry, since dropping it would turn a locator lost to a restart into one nothing
 * could find.
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  Bytes32,
  EventInput,
  EventPayload,
  LathClient,
  LogResult,
  LogWriter,
  ZERO32,
  computeHead,
  hex,
  toBytes32,
  toEventInput,
} from "@lath/sdk";
import { BillingBackend } from "./billing";

/**
 * `parked` is a `charge` only: owed by its payer, refused by the billing program, and out of the
 * chain's way (rule 4a). Everything else is one of the other three.
 */
export type AnchorState = "pending" | "verified" | "failed" | "parked";

/**
 * An `EventInput` as JSON: hex for every 32-byte value, a decimal string for the bigint. The
 * journal is a file a person may have to read while a chain is stuck, so it is diffable rather
 * than compact.
 */
export interface SerializedEventInput {
  timestamp: string;
  kind: number;
  status: number;
  reference: string;
  payloadHash: string;
}

interface AnchorEntryBase {
  /** Unique within a journal; what an `AnchorEvent` and a console badge name. */
  id: string;
  /** Hex agent id — the chain this entry belongs to, and the journal's partition key. */
  agentId: string;
  attempts: number;
  state: AnchorState;
  /**
   * The transaction that landed it. Empty until it does — except on a `charge` that is not yet
   * `verified`, where it is a send the billing client could not confirm either way, and the next
   * attempt asks about it before anything is sent again (rule 2).
   */
  signature?: string;
  error?: string;
  createdAt: number;
}

/** One record, folded with `computeHead` (SPEC §4.4) at `seq`. */
export interface AnchorEventEntry extends AnchorEntryBase {
  kind: "event";
  seq: string;
  prevHead: string;
  head: string;
  input: SerializedEventInput;
  compact: boolean;
  /**
   * The USDC this record pays for, charged in the same transaction as the record itself when
   * the backend can compose an instruction (`BillingClient.chargeIx`) — SPEC §12's rule that
   * the deduction and the event that justifies it share a transaction.
   */
  charge?: {
    user: string;
    amountMicroUsdc: string;
    /**
     * Set once a backend that can only send its own transaction has charged for this record —
     * the signature, or `""` when the backend returned none. A later attempt of the same entry
     * then sends the record alone rather than debiting the user a second time. Absent on
     * a composed charge, which shares the record's transaction and lands or fails with it, and
     * on an older journal entry without the field, which therefore loads unchanged.
     */
    signature?: string;
    /**
     * A charge this backend sent and could not tell had landed (the error carried its
     * signature). The next attempt asks the cluster about it before charging again, as a `charge`
     * entry's in-doubt signature is asked: landed, it becomes `signature`; unknown to the cluster or
     * failed, it is dropped and the charge is sent anew; still in doubt, nothing is sent. Absent on
     * an older journal entry without the field.
     */
    inDoubt?: string;
  };
  /**
   * Journaled behind an epoch that has not landed. An epoch's `verified` transition writes its
   * locator cell — a structure on the first one — straight to the chain, at seqs only the
   * confirmed commit reveals, so a record journaled behind a pending epoch cannot know its
   * seq or head: the ones here are provisional, and the queue recomputes them from the chain
   * the moment it is this entry's turn. Also set behind an epoch that has landed while its hook is
   * still writing that cell. The resolution of a session whose genesis failed is one case; a
   * record journaled behind an epoch a `push` committed on its own is the ordinary one.
   */
  lazy?: boolean;
}

/**
 * A standalone debit with no record of its own: the batched-mode charge that today runs before
 * `batcher.push`. It has no seq and no head, so it is the one entry kind the head check cannot
 * speak for.
 */
export interface AnchorChargeEntry extends AnchorEntryBase {
  kind: "charge";
  user: string;
  amountMicroUsdc: string;
  /**
   * When this charge was first parked (rule 4a). Kept while a scoped `retry` resends it, so a
   * resend that fails again parks it again instead of halting the chain; absent on a charge that
   * was never refused, which fails and halts by rule 4.
   */
  parkedAt?: number;
}

/** One epoch occupying `[startSeq, endSeq)`, folded with `computeEpochHead` (SPEC §15). */
export interface AnchorEpochEntry extends AnchorEntryBase {
  kind: "epoch";
  startSeq: string;
  endSeq: string;
  prevHead: string;
  head: string;
  epochRoot: string;
  /**
   * The locator cell this epoch owes — `"owed"` from the moment it is journaled until the cell
   * is on chain, then `"published"`; absent when there is none to write (no `anchor` on the
   * store, or a blob that fell back to the local one, so there is nothing to point at).
   *
   * The debt is journaled because the work is not: the `onVerified` hook that writes the cell
   * closes over an `EpochStore` and lives only in the process that registered it. Without the
   * marker, an epoch settled after a restart is indistinguishable from one whose cell landed,
   * and the bytes behind a committed root become unfindable with nothing saying so.
   */
  locator?: "owed" | "published";
}

export type AnchorEntry = AnchorEventEntry | AnchorChargeEntry | AnchorEpochEntry;

/**
 * What a journal still has to hold: anything not yet on chain — a parked charge included, which
 * is the only record of a payer's refused debit — plus an epoch that is on chain and still owes
 * its locator cell. Compacting the second away would make a locator lost to a restart
 * unfindable — the entry carrying the root would disappear with the debt.
 */
export function isOwed(entry: AnchorEntry): boolean {
  return entry.state !== "verified" || (entry.kind === "epoch" && entry.locator === "owed");
}

/**
 * An entry as the caller supplies it. Distributed over the union deliberately: `Omit` applied
 * to a union collapses it to the fields they share, and an `event` would lose its `head`.
 */
export type NewAnchorEntry<T = AnchorEntry> = T extends AnchorEntry
  ? Omit<T, "id" | "attempts" | "state" | "createdAt">
  : never;

/**
 * Work that must run from an entry's `verified` transition rather than from whoever journaled
 * it. In memory only, because it closes over live objects: a journal reloaded in a new process
 * has no hooks. What survives the reload is the *debt* — `AnchorEpochEntry.locator` — which
 * `locatorsOwed` reports and `AgentRuntime.flushAnchors` pays.
 */
export interface AnchorHooks {
  onVerified?: () => Promise<void>;
}

export interface AnchorEvent {
  agentId: string;
  id: string;
  kind: AnchorEntry["kind"];
  state: AnchorState;
  seq?: string;
  head?: string;
  signature?: string;
  attempts: number;
  error?: string;
  /** A `charge`'s payer and amount, so an observer can say whose debt a parked charge is. */
  payer?: string;
  amountMicroUsdc?: string;
}

/** Where journaled entries live between the answer and the confirmation. */
export interface AnchorJournal {
  /**
   * Everything still owed, in the order it was made: `pending` and `failed`, plus any epoch that
   * is `verified` and still owes its locator cell (`isOwed`).
   */
  load(agentId: string): Promise<AnchorEntry[]>;
  append(entry: AnchorEntry): Promise<void>;
  update(entry: AnchorEntry): Promise<void>;
  /** Drops what `isOwed` says is settled. Called when an agent has nothing left owing. */
  compact(agentId: string): Promise<void>;
  /**
   * Drops these entries for good, after recording them — `AnchorQueue.discard` is the only
   * caller, and only for a chain the journal has diverged from. Returns where the record went,
   * when it went anywhere a person can read.
   */
  discard(agentId: string, ids: string[], note: DiscardNote): Promise<string | undefined>;
}

/** What a discard writes beside the entries it drops: when, why, and where the chain stood. */
export interface DiscardNote {
  discardedAt: number;
  reason: string;
  chain: { seq: string; head: string };
}

/** For tests and for a process that has no promise to keep past its own lifetime. */
export class MemoryAnchorJournal implements AnchorJournal {
  private readonly byAgent = new Map<string, AnchorEntry[]>();

  async load(agentId: string): Promise<AnchorEntry[]> {
    return (this.byAgent.get(agentId) ?? []).filter(isOwed).map(clone);
  }

  async append(entry: AnchorEntry): Promise<void> {
    const list = this.byAgent.get(entry.agentId) ?? [];
    list.push(clone(entry));
    this.byAgent.set(entry.agentId, list);
  }

  async update(entry: AnchorEntry): Promise<void> {
    const list = this.byAgent.get(entry.agentId) ?? [];
    const i = list.findIndex((e) => e.id === entry.id);
    if (i >= 0) list[i] = clone(entry);
    else list.push(clone(entry));
    this.byAgent.set(entry.agentId, list);
  }

  async compact(agentId: string): Promise<void> {
    this.byAgent.set(agentId, (this.byAgent.get(agentId) ?? []).filter(isOwed));
  }

  /** What each discard dropped, in order — the memory journal's side file. */
  readonly discarded: (DiscardNote & { agentId: string; entries: AnchorEntry[] })[] = [];

  async discard(agentId: string, ids: string[], note: DiscardNote): Promise<string | undefined> {
    const list = this.byAgent.get(agentId) ?? [];
    this.discarded.push({ ...note, agentId, entries: list.filter((e) => ids.includes(e.id)).map(clone) });
    this.byAgent.set(
      agentId,
      list.filter((e) => !ids.includes(e.id))
    );
    return undefined;
  }
}

/**
 * `<dir>/pending/<agentIdHex>.json`, one file per chain, rewritten whole on every change.
 *
 * A file rather than memory because the `FAILED` badge is a promise that the retry still exists
 * after the process that failed is gone; not the trace store, because that has no order and no
 * *not yet*. Rewriting the whole file is what keeps it a readable JSON array — a session's
 * journal is a handful of entries, and the cost of the rewrite is nothing beside a
 * confirmation. The write goes to a temporary file and is renamed over the target, so a crash
 * mid-write leaves the previous journal rather than half of the new one.
 */
/**
 * Flushes a directory's entries, so a rename in it survives a power loss. Best effort: Windows
 * cannot open a directory and some filesystems refuse to flush one, and a journal write that has
 * already landed must not fail over it.
 */
async function syncDir(dir: string): Promise<void> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(dir, "r");
    await fh.sync();
  } catch {
    // Above: nothing more can be done on this platform.
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export class FileAnchorJournal implements AnchorJournal {
  /**
   * One chain of writes per agent. Every mutation is a read-modify-write of the whole file, so
   * two of them running at once — the queue marking an entry verified while the session
   * journals the next one — would lose whichever read first.
   */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(readonly dir: string) {}

  private file(agentId: string): string {
    return path.join(this.dir, "pending", `${agentId}.json`);
  }

  private serialize<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(agentId) ?? Promise.resolve()).then(fn, fn);
    this.writes.set(
      agentId,
      next.catch(() => undefined)
    );
    return next;
  }

  private async read(agentId: string): Promise<AnchorEntry[]> {
    try {
      const raw = await fs.promises.readFile(this.file(agentId), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AnchorEntry[]) : [];
    } catch (e) {
      // A journal that is not there is an agent that owes the chain nothing. A journal that is
      // there and unreadable is not: rather than silently dropping records, say so.
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw e;
    }
  }

  private async write(agentId: string, entries: AnchorEntry[]): Promise<void> {
    const file = this.file(agentId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${nextId()}.tmp`;
    // Flushed before the rename and the directory after it. A rename can reach the disk before the
    // bytes it names, so a power loss between the two could leave a zero-length journal: `read`
    // refuses it (rightly — it cannot tell an empty file from lost entries), and the agent's queue
    // would stay wedged until someone repaired the file by hand.
    const fh = await fs.promises.open(tmp, "w");
    try {
      await fh.writeFile(`${JSON.stringify(entries, null, 2)}\n`, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmp, file);
    await syncDir(path.dirname(file));
  }

  async load(agentId: string): Promise<AnchorEntry[]> {
    return this.serialize(agentId, async () => (await this.read(agentId)).filter(isOwed));
  }

  async append(entry: AnchorEntry): Promise<void> {
    return this.serialize(entry.agentId, async () => {
      const entries = await this.read(entry.agentId);
      entries.push(entry);
      await this.write(entry.agentId, entries);
    });
  }

  async update(entry: AnchorEntry): Promise<void> {
    return this.serialize(entry.agentId, async () => {
      const entries = await this.read(entry.agentId);
      const i = entries.findIndex((e) => e.id === entry.id);
      if (i >= 0) entries[i] = entry;
      else entries.push(entry);
      await this.write(entry.agentId, entries);
    });
  }

  async compact(agentId: string): Promise<void> {
    return this.serialize(agentId, async () => {
      const entries = (await this.read(agentId)).filter(isOwed);
      if (entries.length === 0) {
        await fs.promises.rm(this.file(agentId), { force: true });
        return;
      }
      await this.write(agentId, entries);
    });
  }

  /**
   * `<dir>/pending/<agentIdHex>.discarded-<ms>.json` first, the journal rewritten after: a crash
   * between the two leaves the entries in both places, which a second discard then records
   * again, rather than in neither. The side file is never read back — it is for a person asking
   * what a chain lost, and a later discard gets a file of its own.
   */
  async discard(agentId: string, ids: string[], note: DiscardNote): Promise<string | undefined> {
    return this.serialize(agentId, async () => {
      const entries = await this.read(agentId);
      const dropped = entries.filter((e) => ids.includes(e.id));
      const side = path.join(this.dir, "pending", `${agentId}.discarded-${note.discardedAt}.json`);
      await fs.promises.mkdir(path.dirname(side), { recursive: true });
      await fs.promises.writeFile(side, `${JSON.stringify({ agentId, ...note, entries: dropped }, null, 2)}\n`, "utf8");
      const kept = entries.filter((e) => !ids.includes(e.id));
      if (kept.length === 0) await fs.promises.rm(this.file(agentId), { force: true });
      else await this.write(agentId, kept);
      return side;
    });
  }
}

/**
 * A billing backend that can hand over its charge as an *instruction* instead of a transaction.
 * `BillingClient` has one; `NoopBilling` does not. It is what lets a journaled record keep the
 * SPEC §12 property that the debit and the event it pays for share a transaction, because the
 * journal holds the `EventInput` and not the `ActionPayload` that `chargeAndLog` would need.
 */
export interface ComposableBilling extends BillingBackend {
  chargeIx?(user: PublicKey, amountMicroUsdc: bigint | number): Promise<TransactionInstruction>;
  /**
   * The charge as every instruction one transaction needs, when that is more than one:
   * `BillingClient.chargeIxs` puts the legacy-grant repair in front of the debit while the
   * user's `Allowance` still has the legacy layout. Preferred over `chargeIx` when
   * present, because a bare `chargeIx` against such a grant fails every attempt of the entry
   * and halts the chain's queue — which every direct send already avoids by composing
   * the same repair.
   */
  chargeIxs?(user: PublicKey, amountMicroUsdc: bigint | number): Promise<TransactionInstruction[]>;
  /**
   * What became of a charge transaction the backend sent and could not confirm: `true` landed,
   * `false` landed and failed (nothing moved), `null` the cluster has no record of it, `"unknown"`
   * the status could not be read. `BillingClient.chargeLanded`, over history. A backend without it
   * is asked nothing and its in-doubt charge is never resent, which is the safe half.
   */
  chargeLanded?(signature: string): Promise<boolean | null | "unknown">;
}

/**
 * The `BillingError` variants (`programs/lath-billing/src/lib.rs`) a resend cannot change, by
 * Anchor's numbering from 6000, plus Anchor's own `AccountNotInitialized` (3012): `revoke_agent`
 * *closes* the `Allowance`, so a charge against a revoked grant meets a missing account rather
 * than a custom error, and a payer who never deposited has no balance row either.
 *
 * A number is only safe to read this way because a standalone `charge` transaction carries
 * nothing but the billing program's own instructions (`BillingClient.charge`: the legacy-grant
 * repair and the debit); `frontend/src/lib/program-errors.ts` says why a bare number names
 * nothing in general. A composed charge rides in a `log_event` transaction, where the
 * same number could be lath's, and is never classified here.
 */
const CHARGE_REFUSALS: Record<number, string> = {
  6000: "Unauthorized",
  6003: "AllowanceExpired",
  6004: "AllowanceCapExceeded",
  6005: "InsufficientBalance",
  3012: "AccountNotInitialized",
};

/**
 * The billing program's refusal of a standalone charge, by name, or `null` when the error is
 * anything else — a transport failure, a confirmation in doubt, a backend with no money behind it
 * (`ChargeUnpaid`) — which keeps rule 4's attempts and halt. Reads the error's message, string
 * form and logs the way `isRetryableWriteError` does, and also a bare string, because an older
 * journal entry that failed rather than parked keeps only the message of the error that failed it,
 * and that is what a load migrates by.
 *
 * Three shapes reach here: a preflight refusal (`custom program error: 0x1773` with Anchor's
 * `Error Code: AllowanceExpired` in the logs `SendTransactionError` puts in its message), a
 * transaction that landed and failed (`Transaction … failed: {"InstructionError":[1,{"Custom":6003}]}`
 * from `confirmByPolling`), and Anchor's `Error Number: 6003`.
 */
export function chargeRefusal(e: unknown): string | null {
  const err = e as any;
  const text =
    typeof e === "string"
      ? e
      : [
          err?.message,
          err?.toString?.(),
          JSON.stringify(err?.logs ?? []),
          JSON.stringify(err?.transactionLogs ?? []),
        ].join(" ");
  const named = /Error Code: (\w+)/.exec(text)?.[1];
  if (named && Object.values(CHARGE_REFUSALS).includes(named)) return named;
  const codes = [
    ...[...text.matchAll(/custom program error: 0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1], 16)),
    ...[...text.matchAll(/"Custom":\s*(\d+)/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/Error Number: (\d+)/g)].map((m) => Number(m[1])),
  ];
  for (const code of codes) if (CHARGE_REFUSALS[code]) return CHARGE_REFUSALS[code];
  return null;
}

/**
 * The backend a chain's charges go through, asked for per chain rather than held once.
 *
 * `charge` and `chargeIx` name a wallet and an amount, not a chain, so a host that serves more
 * than one agent from one process cannot say through them which backend a drained entry belongs
 * to, and keeping the one bound last would charge whichever rail was bound when the drain
 * happens, not the rail the record was journaled under. The queue knows the entry's
 * agent at every charge site, so it asks; returning `undefined` means this chain has no backend.
 */
export type BillingResolver = (agentId: Bytes32) => ComposableBilling | undefined;

export interface AnchorQueueOptions {
  client: LathClient;
  journal: AnchorJournal;
  /**
   * Needed for `charge` entries and for an `event` that carries one. One backend for every chain
   * this queue writes, or a `BillingResolver` when they differ per chain.
   */
  billing?: ComposableBilling | BillingResolver;
  /** Attempts before an entry is `failed` and its agent's queue halts. Default 3. */
  maxAttempts?: number;
  /**
   * How long a chain read waits for the indexer to show a write the queue knows has landed
   * (`expectSeq`). Default 20 s: several devnet confirmations, so an indexer this far behind
   * is an outage, not lag. Tests set it low.
   */
  indexerWaitMs?: number;
  /** Base of the backoff between attempts on one entry (doubled per attempt, capped at 4×). Default 1 s. */
  retryDelayMs?: number;
  /** Every state transition, for a console. Never awaited; a throwing observer is ignored. */
  onEvent?: (e: AnchorEvent) => void;
  /**
   * Whose parked charges a `retry` of this chain puts back in the queue (rule 4a): base58
   * payers, or `"all"`. Default `"all"`, which is right for a chain with one payer — a loop's or
   * a deployed agent's, whose owner is admitted before anything drains it. A host serving a
   * chain many wallets pay on names the one it has just admitted, so a drain on that chain sends
   * nobody else's refused charge through it.
   */
  parkedScope?: (agentId: Bytes32) => readonly string[] | "all";
}

/** Thrown by `drain` when an entry for that agent has spent its attempts. */
export class AnchorFailed extends Error {
  constructor(readonly entry: AnchorEntry) {
    super(`anchoring ${entry.kind} ${entry.id} failed after ${entry.attempts} attempts: ${entry.error ?? "unknown"}`);
    this.name = "AnchorFailed";
  }
}

/**
 * A charge the bound backend answered with no signature, which is how `NoopBilling` answers every
 * charge: it meters and moves nothing. Read as sent (`signature ?? ""`), it would settle the
 * entry `verified`, so any path that drained a chain through a backend with no money behind it —
 * an anonymous console retry, an unbilled loop step or a settlement whose owner's allowance had
 * lapsed — would mark a user's debit paid with no transaction, after the operator had already
 * paid the model call. So the entry fails and stays owed. Not retried inside the drain: the same
 * backend answers the same way, and only a `retry` through one that can pay will ever send it.
 */
export class ChargeUnpaid extends Error {
  constructor(amountMicroUsdc: string, user: string) {
    super(
      `the billing backend bound for this chain moved no USDC for a ${amountMicroUsdc} micro-USDC charge to ${user} ` +
        "(no signature); the charge stays owed until a backend that can pay drains it"
    );
    this.name = "ChargeUnpaid";
  }
}

/**
 * A discard the queue will not do, because a Retry can still land what is owed: nothing failed,
 * the chain stands where the journal expects it, the chain is only behind, or an owed entry has
 * in fact landed. Each is Retry's case, and dropping those records would lose writes that were
 * never lost.
 */
export class DiscardRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscardRefused";
  }
}

/** What `AnchorQueue.discard` dropped, and what the money in it came to. */
export interface DiscardResult {
  dropped: AnchorEntry[];
  /**
   * Charges in the dropped entries that never moved: a composed charge rides in its record's
   * transaction, and the record never landed. What the session's model calls cost was paid out
   * of the operator's treasury over Tempo, so this is the operator's loss, not the user's.
   */
  unbilledMicroUsdc: bigint;
  /**
   * Charges a charge-only backend sent on their own and journaled a signature for — they may
   * have moved even though the record they paid for did not. Includes `inDoubtMicroUsdc`.
   */
  chargedMicroUsdc: bigint;
  /**
   * The part of `chargedMicroUsdc` whose landing nobody confirmed: a record's charge journaled as
   * `charge.inDoubt` (the client could not tell whether it landed). It may have debited the user, so
   * it is never counted as unbilled; a reader that wants to say "may have" rather than "was" reads
   * it here. Optional so a `LoopAnchorQueue` that does not report it still satisfies the type;
   * `discard` always sets it.
   */
  inDoubtMicroUsdc?: bigint;
  /** Where the dropped entries were written, when the journal keeps a file. */
  file?: string;
  /** The chain as the discard found it. */
  chain: { seq: bigint; head: Bytes32 };
  /** Why it was a divergence, in the words the side file keeps. */
  reason: string;
}

interface AgentQueue {
  entries: AnchorEntry[];
  /** A head check is owed before the next submit; see rule 2. */
  checkNext: boolean;
  /** An entry failed: nothing more is sent for this agent until `retry`. */
  halted: boolean;
  pumping: Promise<void> | null;
  /**
   * The lowest seq a chain read is allowed to report. Photon indexes a confirmed write a
   * moment after the RPC confirms it, and a read in that moment shows the chain one or more
   * records short. Every write this queue confirms — and every synchronous write a caller
   * reports through `expect` — raises this, and `chain()` waits for the indexer to reach it
   * before anything is derived from what it says. Without it the tip of a session that opened
   * right after a cell write would be seeded from the state before the cell, and every record the
   * session journaled would carry a head the chain could never confirm.
   */
  expectSeq: bigint;
}

let counter = 0;

function nextId(): string {
  return `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function serializeEventInput(input: EventInput): SerializedEventInput {
  return {
    timestamp: input.timestamp.toString(),
    kind: input.kind,
    status: input.status,
    reference: hex(input.reference),
    payloadHash: hex(input.payloadHash),
  };
}

export function deserializeEventInput(input: SerializedEventInput): EventInput {
  return {
    timestamp: BigInt(input.timestamp),
    kind: input.kind,
    status: input.status,
    reference: toBytes32(input.reference),
    payloadHash: toBytes32(input.payloadHash),
  };
}

/**
 * The single writer for a set of agent chains. One queue per process: two would be two writers
 * on one chain, which is exactly what rule 3 exists to detect rather than to allow.
 */
export class AnchorQueue {
  readonly client: LathClient;
  readonly journal: AnchorJournal;
  /** Resolved per chain at each charge site; see `BillingResolver` for why it is not one field. */
  readonly billingFor: BillingResolver;
  readonly maxAttempts: number;
  private readonly indexerWaitMs: number;
  private readonly retryDelayMs: number;
  private readonly onEvent?: (e: AnchorEvent) => void;
  private readonly parkedScope: (agentId: Bytes32) => readonly string[] | "all";
  private readonly agents = new Map<string, AgentQueue>();
  private readonly loading = new Map<string, Promise<AgentQueue>>();
  private readonly hooks = new Map<string, AnchorHooks>();
  /**
   * Entries whose `onVerified` hook is running. `settle` marks an entry `verified` before its hook
   * writes the locator cell, so for the length of that write the state alone says the chain is
   * where the journal left it, when the cell is about to move it one seq further.
   */
  private readonly settling = new Set<string>();

  constructor(opts: AnchorQueueOptions) {
    this.client = opts.client;
    this.journal = opts.journal;
    const backend = opts.billing;
    this.billingFor = typeof backend === "function" ? backend : () => backend;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.indexerWaitMs = opts.indexerWaitMs ?? 20_000;
    this.retryDelayMs = opts.retryDelayMs ?? 1_000;
    this.onEvent = opts.onEvent;
    this.parkedScope = opts.parkedScope ?? (() => "all");
  }

  /**
   * The `AgentLogger` seam: journals the record, computes its head locally, and answers with a
   * `LogResult` whose signature is empty. The real signature reaches a console later, on the
   * entry's `verified` transition.
   */
  writer(): LogWriter {
    return {
      logEvent: async (agentId: Bytes32, payload: EventPayload, opts): Promise<LogResult> => {
        return this.logEvent(agentId, payload, opts);
      },
    };
  }

  async logEvent(
    agentId: Bytes32,
    payload: EventPayload,
    opts: { compact?: boolean; timestamp?: number; charge?: { user: PublicKey; amountMicroUsdc: bigint } } = {}
  ): Promise<LogResult> {
    const input = toEventInput(payload, opts.timestamp ?? Date.now());
    return this.logEventInput(agentId, input, !!opts.compact, opts.charge);
  }

  async logEventInput(
    agentId: Bytes32,
    input: EventInput,
    compact: boolean,
    charge?: { user: PublicKey; amountMicroUsdc: bigint }
  ): Promise<LogResult> {
    const { seq, head: prevHead } = await this.tip(agentId);
    const head = computeHead(prevHead, agentId, seq, input);
    // Behind a pending epoch, or behind another lazy record (its head is provisional too), the
    // seq is not knowable yet; see `AnchorEventEntry.lazy`. So too behind an epoch that has landed
    // and whose hook is still writing its locator cell: the tip read above saw the chain before
    // the cell, and an eager record built there takes the cell's seq.
    const q = await this.state(hex(agentId));
    const lazy = q.entries.some(
      (e) =>
        (e.state !== "verified" && (e.kind === "epoch" || (e.kind === "event" && e.lazy === true))) ||
        this.hookPending(e)
    );
    await this.enqueue({
      kind: "event",
      agentId: hex(agentId),
      seq: seq.toString(),
      prevHead: hex(prevHead),
      head: hex(head),
      input: serializeEventInput(input),
      compact,
      charge: charge ? { user: charge.user.toBase58(), amountMicroUsdc: charge.amountMicroUsdc.toString() } : undefined,
      ...(lazy ? { lazy: true } : {}),
    });
    // The address is derived from the agent id and the seq, so a non-compact record can be
    // linked to before it exists; the signature genuinely cannot be known yet, and an empty
    // one is how a caller tells a journaled record from a sent one.
    return {
      signature: "",
      seq,
      head,
      input,
      eventAddress: compact ? undefined : this.client.eventAddress(agentId, seq),
    };
  }

  /** Local chain tip: the last journaled head, or the confirmed one when the journal is empty. */
  async tip(agentId: Bytes32): Promise<{ seq: bigint; head: Bytes32 }> {
    const q = await this.state(hex(agentId));
    for (let i = q.entries.length - 1; i >= 0; i--) {
      const e = q.entries[i];
      // A charge moves no head, and anything at or before a verified entry is on chain — where
      // the read below also picks up cell writes this queue never saw.
      if (e.kind === "charge") continue;
      if (e.state === "verified") break;
      return { seq: e.kind === "event" ? BigInt(e.seq) + 1n : BigInt(e.endSeq), head: toBytes32(e.head) };
    }
    const found = await this.chain(q, agentId);
    return found ? { seq: found.seq, head: found.head } : { seq: 0n, head: ZERO32 };
  }

  /**
   * The tip an epoch is built at. Unlike a record, an epoch cannot be journaled lazily and placed
   * at its turn: its root and its blob commit to `startSeq`, and the blob is uploaded before the
   * commit is journaled. So it must not be built behind anything whose landing moves the chain past
   * the journal's tip — an entry whose `verified` hook has yet to run or is running (an epoch's
   * locator cell, written at that epoch's `endSeq`, the very seq `tip` would hand this one), or a
   * lazy record, whose seq is provisional. When there is one the chain is drained first, so the
   * tip is the chain's own, cell included.
   *
   * Draining after each of `AgentRuntime`'s own flushes is not enough: an epoch `push` closed on a
   * `count` or `fee` trigger, or the batcher's timer on `time`, has nobody to drain after it, and
   * the next epoch would be built at the seq the first one's cell then takes — halting the queue
   * on `head diverged`, with every Retry in the same process meeting it again.
   *
   * A drain that rejects — a halted queue — leaves the journal's tip as the only place to build,
   * because the caller's batch is the only copy of steps whose charges are already journaled.
   * The hooks still waiting on the entries ahead are dropped then, so the cells they would
   * write cannot take the seqs this epoch is built for: those epochs land as they would after a
   * restart, which also drops every hook, with `locator: "owed"` on the entry for
   * `AgentRuntime.flushAnchors` or `reanchorEpochs` to pay — rather than a Retry that lands the
   * first epoch and diverges on the second, every time.
   */
  async epochTip(agentId: Bytes32): Promise<{ seq: bigint; head: Bytes32 }> {
    const q = await this.state(hex(agentId));
    const moves = (e: AnchorEntry) =>
      this.hookPending(e) || (e.state !== "verified" && e.kind === "event" && e.lazy === true);
    if (q.entries.some(moves)) {
      try {
        await this.drain(agentId);
      } catch {
        for (const e of q.entries) if (e.state !== "verified") this.hooks.delete(e.id);
      }
    }
    return this.tip(agentId);
  }

  /** Whether `entry` still has a `verified` hook to run, or is running one — a write this queue cannot place. */
  private hookPending(entry: AnchorEntry): boolean {
    return this.hooks.has(entry.id) || this.settling.has(entry.id);
  }

  /**
   * Tells the queue the chain is at least at `seq` — after a caller's own synchronous write,
   * which the queue never saw but which the indexer may not show yet. The next chain read
   * waits for it.
   */
  async expect(agentId: Bytes32, seq: bigint): Promise<void> {
    const q = await this.state(hex(agentId));
    if (seq > q.expectSeq) q.expectSeq = seq;
  }

  /**
   * The confirmed `AgentState`, read only once the indexer has caught up with everything this
   * queue knows has landed (`expectSeq`). Bounded: an indexer that stays behind for longer
   * than a devnet confirmation could plausibly take is reported as it is, and the guard in
   * `process` then treats a short chain as *behind*, which is retried, never as a place to
   * write.
   */
  private async chain(q: AgentQueue, agentId: Bytes32): Promise<{ seq: bigint; head: Bytes32 } | null> {
    const deadline = Date.now() + this.indexerWaitMs;
    let delay = 400;
    for (;;) {
      const found = await this.client.getAgentState(agentId);
      const seq = found ? found.state.seq : -1n;
      if (seq >= q.expectSeq || Date.now() >= deadline) {
        return found ? { seq: found.state.seq, head: found.state.head } : null;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }

  /** Journals and schedules; resolves as soon as the entry is on disk. */
  async enqueue(entry: NewAnchorEntry, hooks?: AnchorHooks): Promise<AnchorEntry> {
    const q = await this.state(entry.agentId);
    const full = { ...entry, id: nextId(), attempts: 0, state: "pending", createdAt: Date.now() } as AnchorEntry;
    // Journaled before it joins the queue, because the queue is what the pump sends from: pushed
    // first, an append that threw would leave the entry pending in memory, and a pump already
    // running — or the next kick — would write to the chain a record its caller was told had
    // failed and that no restart could account for. A push afterwards, with nothing awaited in between, also means
    // the pump never meets an entry whose `onVerified` hook is not registered yet.
    await this.journal.append(full);
    q.entries.push(full);
    if (hooks) this.hooks.set(full.id, hooks);
    this.emit(full);
    this.kick(entry.agentId);
    return full;
  }

  /** Resolves when nothing is pending for `agentId`; rejects with `AnchorFailed` if one failed. */
  async drain(agentId: Bytes32): Promise<void> {
    const key = hex(agentId);
    const q = await this.state(key);
    this.kick(key);
    while (q.pumping) await q.pumping;
    const failed = q.entries.find((e) => e.state === "failed");
    if (failed) throw new AnchorFailed(failed);
  }

  /**
   * Puts every failed entry back to pending, attempts 0, and resumes under a head check — and
   * every parked charge whose payer is in scope: `payers` when given, else the queue's
   * `parkedScope` for this chain (rule 4a). A parked charge out of scope stays parked; it is
   * owed to its payer, not to this drain.
   */
  async retry(agentId: Bytes32, opts: { payers?: readonly string[] } = {}): Promise<void> {
    const key = hex(agentId);
    const q = await this.state(key);
    const scope = opts.payers ?? this.parkedScope(agentId);
    for (const e of q.entries) {
      const unpark = e.state === "parked" && e.kind === "charge" && (scope === "all" || scope.includes(e.user));
      if (e.state !== "failed" && !unpark) continue;
      e.state = "pending";
      e.attempts = 0;
      e.error = undefined;
      await this.journal.update(e);
      this.emit(e);
    }
    q.halted = false;
    // A failed entry may have landed and lost its confirmation, so the first submit after a
    // retry is always preceded by the head check.
    q.checkNext = true;
    this.kick(key);
  }

  /**
   * The way out of rule 3: drops every entry this chain still owes the chain, once the chain has
   * moved somewhere the journal can never follow — and only then.
   *
   * The test is made against the chain now, not against the error an entry kept: an entry that
   * failed on `chain behind` or on its attempts is Retry's case, and one whose `head diverged`
   * came from an indexer that had not caught up may be Retry's case too. So a discard reads the
   * confirmed state and refuses when the chain is behind the first owed record, stands exactly
   * where that record expects it, or stands where some owed record leads (it landed, and the head
   * check settles it). What is left is a chain at or past the record's seq under a head the
   * journal never computed, and nothing in the journal can be sent onto that.
   *
   * The entries are written to the journal's side file before they are dropped; a verified epoch
   * kept only for its locator debt is not owed to the chain and stays. The queue is released and
   * compacts on its next pump, so the next write builds on the chain as it stands.
   */
  async discard(agentId: Bytes32): Promise<DiscardResult> {
    const key = hex(agentId);
    const q = await this.state(key);
    while (q.pumping) await q.pumping;
    // A parked charge is owed to its payer, not to the chain, and no divergence of the chain
    // changes what that payer owes: it stays in the journal, out of the side file.
    const owed = q.entries.filter((e) => e.state !== "verified" && e.state !== "parked");
    if (!owed.some((e) => e.state === "failed")) {
      throw new DiscardRefused("nothing on this chain has failed, so there is nothing to discard");
    }
    const first = owed.find((e): e is AnchorEventEntry | AnchorEpochEntry => e.kind !== "charge");
    if (!first)
      throw new DiscardRefused(
        "only charges are owed on this chain, and they have no head to diverge; Retry sends them"
      );
    if (first.kind === "event" && first.lazy) {
      throw new DiscardRefused(
        "the first owed record is placed when its turn comes, so it cannot have diverged; Retry"
      );
    }
    const found = await this.chain(q, agentId);
    if (!found) throw new DiscardRefused("the indexer reports no state for this chain; Retry once it does");
    const target = BigInt(first.kind === "event" ? first.seq : first.startSeq);
    const tipHead = hex(found.head);
    if (found.seq < target) {
      throw new DiscardRefused(`the chain is behind the journal (seq ${found.seq}, first owed at ${target}); Retry`);
    }
    if (found.seq === target && tipHead === first.prevHead) {
      throw new DiscardRefused("the chain stands exactly where the journal expects it; Retry is the answer here");
    }
    const landed = owed.some(
      (e) =>
        e.kind !== "charge" &&
        !(e.kind === "event" && e.lazy) &&
        (e.kind === "event" ? BigInt(e.seq) + 1n : BigInt(e.endSeq)) === found.seq &&
        e.head === tipHead
    );
    if (landed) throw new DiscardRefused("an owed record has landed and only lost its confirmation; Retry settles it");

    const reason = `head diverged: the chain is at seq ${found.seq} under ${tipHead.slice(
      0,
      16
    )}…, the journal's first owed ${first.kind} is at ${target} after ${first.prevHead.slice(0, 16)}…`;
    let unbilled = 0n;
    let charged = 0n;
    let inDoubt = 0n;
    for (const e of owed) {
      const money =
        e.kind === "charge"
          ? { amount: e.amountMicroUsdc, sent: e.signature }
          : e.kind === "event" && e.charge
          ? // A charge journaled in doubt may have debited the user, so it is not the operator's loss.
            {
              amount: e.charge.amountMicroUsdc,
              sent: e.charge.signature ?? e.charge.inDoubt,
              doubt: e.charge.signature === undefined && e.charge.inDoubt !== undefined,
            }
          : null;
      if (!money) continue;
      if (money.sent !== undefined) charged += BigInt(money.amount);
      else unbilled += BigInt(money.amount);
      if ("doubt" in money && money.doubt) inDoubt += BigInt(money.amount);
    }
    const ids = owed.map((e) => e.id);
    const file = await this.journal.discard(key, ids, {
      discardedAt: Date.now(),
      reason,
      chain: { seq: found.seq.toString(), head: tipHead },
    });
    for (const id of ids) this.hooks.delete(id);
    q.entries = q.entries.filter((e) => !ids.includes(e.id));
    q.halted = false;
    // Nothing is owed to the chain any more, so there is nothing a head check could settle.
    q.checkNext = false;
    this.kick(key);
    return {
      dropped: owed,
      unbilledMicroUsdc: unbilled,
      chargedMicroUsdc: charged,
      inDoubtMicroUsdc: inDoubt,
      file,
      chain: found,
      reason,
    };
  }

  /**
   * Everything this chain still owes, the journal included — the count a caller needs *before*
   * it writes anything, to say whose records the next drain is about to carry.
   *
   * `pending` and `failed` read what this process already has in memory. A journal left behind
   * by a process that is gone stays on disk until the queue is asked about that chain, so a
   * caller that only reads those two sees nothing owed and reports nothing, which is exactly
   * what the FAILED badge promises will not happen.
   */
  async carried(agentId: Bytes32): Promise<AnchorEntry[]> {
    const q = await this.state(hex(agentId));
    // Parked charges are not carried: no drain sends them unless a scoped retry puts them back,
    // and nothing on the chain waits for them (rule 4a). `parked` is where they are read.
    return q.entries.filter((e) => e.state !== "verified" && e.state !== "parked");
  }

  /**
   * The charges the billing program refused on this chain, still owed by their payers (rule 4a),
   * journal included — what a host's admission reads for the one payer it is admitting, and what
   * an operator reads to see who owes what.
   */
  async parked(agentId: Bytes32): Promise<AnchorChargeEntry[]> {
    const q = await this.state(hex(agentId));
    return q.entries.filter((e): e is AnchorChargeEntry => e.kind === "charge" && e.state === "parked");
  }

  /**
   * Epochs on this chain whose locator cell has not been written. Normally empty: the hook runs
   * from the `verified` transition in the process that journaled the commit. It is not empty
   * when that process died before the confirmation and another one settled the entry, which is
   * the only way the debt outlives the hook.
   *
   * `AgentRuntime.flushAnchors` is what clears these for a chain a runtime still holds a store
   * for; `reanchorEpochs` is the operator tool for one it does not.
   *
   * Only epochs that **landed**. `locator: "owed"` is set when the commit is journaled, not when
   * it confirms, so an epoch still pending behind a failed record carries it too — and a cell
   * published for that one is a direct write at the seq the journaled records were built for,
   * which wedges every Retry on `head diverged`. Its own
   * `onVerified` hook, or a flush after the drain, pays it once it is on chain.
   */
  async locatorsOwed(agentId: Bytes32): Promise<AnchorEpochEntry[]> {
    const q = await this.state(hex(agentId));
    return q.entries.filter(
      (e): e is AnchorEpochEntry => e.kind === "epoch" && e.state === "verified" && e.locator === "owed"
    );
  }

  /**
   * The cell for this epoch's root is on chain: the debt is paid, and the entry may now be
   * compacted away with the rest. Idempotent, so a flush that races the hook costs nothing.
   */
  async locatorPublished(entry: AnchorEpochEntry): Promise<void> {
    const q = await this.state(entry.agentId);
    const held = (q.entries.find((e) => e.id === entry.id) as AnchorEpochEntry | undefined) ?? entry;
    if (held.locator !== "owed") return;
    held.locator = "published";
    held.error = undefined;
    await this.journal.update(held);
    this.emit(held);
    // Nothing is owed on this chain any more, so let the pump compact the journal it was keeping.
    this.kick(entry.agentId);
  }

  pending(agentId: Bytes32): AnchorEntry[] {
    return (this.agents.get(hex(agentId))?.entries ?? []).filter((e) => e.state === "pending");
  }

  failed(agentId: Bytes32): AnchorEntry[] {
    return (this.agents.get(hex(agentId))?.entries ?? []).filter((e) => e.state === "failed");
  }

  /** Loads an agent's journal once, then keeps it in memory as the queue's own order of work. */
  private async state(key: string): Promise<AgentQueue> {
    const have = this.agents.get(key);
    if (have) return have;
    const loading = this.loading.get(key);
    if (loading) return loading;
    const task = (async () => {
      const entries = await this.journal.load(key);
      // An older journal can hold a refused charge as `failed`, which would halt this chain again
      // on load — the lock rule 4a exists to prevent, carried across the restart. It is parked
      // in place, by the message it was failed with, and written back so the file says so too;
      // a charge that failed for any other reason (its attempts, an RPC in doubt) loads as it was.
      for (const e of entries) {
        if (e.kind !== "charge" || e.state !== "failed" || !e.error || !chargeRefusal(e.error)) continue;
        e.state = "parked";
        e.parkedAt = e.createdAt;
        await this.journal.update(e);
      }
      const q: AgentQueue = {
        entries,
        // Anything still owed to the *chain* may have landed in a process that is gone, so the
        // first submit after a load is preceded by the head check. A verified epoch kept only
        // for its locator debt is not owed to the chain and arms nothing; nor does a parked charge.
        checkNext: entries.some((e) => e.state !== "verified" && e.state !== "parked"),
        halted: entries.some((e) => e.state === "failed"),
        pumping: null,
        expectSeq: 0n,
      };
      this.agents.set(key, q);
      this.loading.delete(key);
      return q;
    })();
    this.loading.set(key, task);
    // A load that rejects is forgotten, so the next call reads the journal again. Kept, it would
    // be the answer to every `state` for this chain for the life of the process: one EMFILE or EIO
    // under load, and every retry, drain, tip and enqueue on the console's shared agent would
    // reject with it until a restart. A journal that is really corrupt still throws, on each read.
    task.catch(() => {
      if (this.loading.get(key) === task) this.loading.delete(key);
    });
    return task;
  }

  private emit(entry: AnchorEntry): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({
        agentId: entry.agentId,
        id: entry.id,
        kind: entry.kind,
        state: entry.state,
        seq: entry.kind === "event" ? entry.seq : entry.kind === "epoch" ? entry.endSeq : undefined,
        head: entry.kind === "charge" ? undefined : entry.head,
        signature: entry.signature,
        attempts: entry.attempts,
        error: entry.error,
        ...(entry.kind === "charge" ? { payer: entry.user, amountMicroUsdc: entry.amountMicroUsdc } : {}),
      });
    } catch {
      // An observer is a spectator; it must not be able to stop the writer.
    }
  }

  /** Starts the agent's pump if it is not already running. One entry in flight, in order. */
  private kick(key: string): void {
    const q = this.agents.get(key);
    if (!q || q.pumping || q.halted) return;
    // Cleared from outside the run rather than in a `finally` inside it: a pump that finishes
    // without ever awaiting would otherwise clear the field *before* it is assigned, and
    // `drain` would spin on a promise that has already resolved.
    const run = this.pump(q, key);
    q.pumping = run;
    const clear = () => {
      if (q.pumping === run) q.pumping = null;
    };
    // Both arms: a journal that cannot be written rejects the run, and `drain` is where that is
    // reported — an unhandled rejection here would take the process down instead.
    run.then(clear, clear);
  }

  private async pump(q: AgentQueue, key: string): Promise<void> {
    for (;;) {
      if (q.halted) return;
      const entry = q.entries.find((e) => e.state === "pending");
      if (entry) {
        await this.process(q, entry);
        continue;
      }
      // `isOwed` rather than `state !== "verified"`: an epoch whose locator cell is still owed
      // stays, because the entry is the only record of which root is missing a pointer.
      // A parked charge is owed too, but to its payer and not to the chain, so it does not keep the
      // settled entries around it: a shared chain whose one payer never comes back would otherwise
      // keep every later session's records in its journal for good. The second test stops the
      // loop once only parked charges remain, which compacting again would not change.
      const chainOwed = (e: AnchorEntry) => isOwed(e) && e.state !== "parked";
      if (q.entries.length === 0 || q.entries.some(chainOwed)) return;
      if (q.entries.every((e) => e.state === "parked")) return;
      await this.journal.compact(key);
      // Dropped from memory too, so `tip` falls back to reading the chain — which is the only
      // place a cell write made outside this queue can be seen. Filtered rather than emptied,
      // because a caller can have journaled a new entry during the `await` above and losing it
      // would strand a record nothing will ever send.
      q.entries = q.entries.filter(isOwed);
    }
  }

  private async process(q: AgentQueue, entry: AnchorEntry): Promise<void> {
    const agentId = toBytes32(entry.agentId);
    if (entry.attempts > 0) await sleep(Math.min(this.retryDelayMs * 2 ** (entry.attempts - 1), this.retryDelayMs * 4));
    entry.attempts += 1;
    await this.journal.update(entry);
    try {
      if (entry.kind === "charge" && entry.signature) {
        // A charge has no head to compare: its signature is the only evidence it landed, and a
        // pending charge carries one only when the billing client sent it and could not tell
        // whether it landed (rule 2). The cluster is asked, over history, rather than the entry
        // settling on the signature alone.
        const landed = await this.chargeLanded(agentId, entry.signature);
        if (landed === true) {
          await this.settle(entry, entry.signature);
          return;
        }
        if (landed === "unknown") {
          // Still in doubt: a resend could be a second debit. Spends an
          // attempt and is asked again; a Retry asks again later. Stuck is recoverable.
          throw new Error(
            `the charge ${entry.signature} is still in doubt (its status cannot be read); not resent, ` +
              "because a resent charge debits twice"
          );
        }
        // `false` landed and failed, `null` unknown to the cluster after the client's wait outlasted
        // its blockhash: either way nothing moved under that signature, and a new one may be sent.
        entry.signature = undefined;
        await this.journal.update(entry);
      }
      if (entry.kind !== "charge") {
        // Read once, used twice: the head check (rule 2) and the guard below. The guard is needed
        // because `logEventInput` builds against whatever seq the chain is at, so a resubmit whose seq
        // is already taken does not fail — it lands a second copy of the record one seq later,
        // and only then is the head seen to differ. Nothing is sent unless the chain stands
        // exactly where this entry expects it, and a chain that is merely *behind* is the
        // indexer catching up, retried, not a place to write.
        const found = await this.chain(q, agentId);
        if (entry.attempts > 1 || q.checkNext) {
          await this.reconcile(q, found);
          if (entry.state !== "pending") return;
        }
        if (entry.kind === "event" && entry.lazy) {
          // Its turn: everything ahead of it has landed, including the cells an epoch's
          // `verified` transition wrote, so the chain is exactly where this record goes.
          if (!found) throw new Error("chain behind: the indexer reports no state for a lazy record's chain");
          entry.seq = found.seq.toString();
          entry.prevHead = hex(found.head);
          entry.head = hex(computeHead(found.head, agentId, found.seq, deserializeEventInput(entry.input)));
          entry.lazy = false;
          await this.journal.update(entry);
          this.emit(entry);
        }
        const target = BigInt(entry.kind === "event" ? entry.seq : entry.startSeq);
        const seq = found ? found.seq : -1n;
        if (seq < target)
          throw new Error(`chain behind: indexer reports seq ${seq < 0n ? "none" : seq}, entry is at ${target}`);
        if (seq > target || hex(found!.head) !== entry.prevHead) {
          throw new HeadDiverged(entry.prevHead, found ? hex(found.head) : "", `seq ${seq}, entry at ${target}`);
        }
      }
      const signature = await this.submit(agentId, entry);
      // Submitted: the next entry starts from a chain this queue has just seen — but only a
      // head-bearing submit saw it. A charge is its own transaction against the billing program
      // and tells this queue nothing about `AgentState`, so disarming the check on one spends
      // it without using it. The journal `[charge(no signature), event(landed)]` is the case:
      // the charge is resent, the check goes with it, the event is then processed on its first
      // attempt with no reconcile, and the guard above sees a chain past the entry's seq and
      // raises `HeadDiverged` — which is never retried — for a record already on chain.
      if (entry.kind !== "charge") q.checkNext = false;
      await this.settle(entry, signature);
    } catch (e) {
      const message = (e as any)?.message ?? String(e);
      if (entry.kind === "charge") {
        // `BillingClient.send` throws `could not tell whether <sig> landed; not resent` with
        // the signature on the error. Journaled, so the next attempt — or a Retry in another
        // process — asks about it rather than debiting the user again.
        const sent = (e as any)?.signature;
        if (typeof sent === "string" && sent.length > 0) entry.signature = sent;
        const refusal = e instanceof ChargeUnpaid ? null : chargeRefusal(e);
        const reparked =
          entry.parkedAt !== undefined && (e instanceof ChargeUnpaid || entry.attempts >= this.maxAttempts);
        if (refusal || reparked) {
          // Rule 4a: owed by its payer, out of the chain's way. The queue is not halted, so the
          // records journaled behind this charge keep landing and the drain resolves.
          entry.state = "parked";
          entry.error = refusal ? `the billing program refused this charge (${refusal}): ${message}` : message;
          entry.parkedAt ??= Date.now();
          await this.journal.update(entry);
          this.emit(entry);
          return;
        }
      }
      if (e instanceof HeadDiverged || e instanceof ChargeUnpaid || entry.attempts >= this.maxAttempts) {
        entry.state = "failed";
        entry.error = message;
        q.halted = true;
        await this.journal.update(entry);
        this.emit(entry);
        return;
      }
      entry.error = message;
      await this.journal.update(entry);
    }
  }

  /**
   * Rule 2, as one read of `AgentState` for the whole journal: if the chain stands exactly where
   * some journaled entry leads, that entry landed and only its confirmation was lost — and so
   * did every entry before it, because a head commits to the entire history behind it. Settling
   * the whole run in one pass is what makes the check safe after a crash that lost more than one
   * confirmation; asking only about the entry at hand would resend the ones behind the tip.
   */
  private async reconcile(q: AgentQueue, found: { seq: bigint; head: Bytes32 } | null): Promise<void> {
    if (!found) return;
    const tipSeq = found.seq;
    const tipHead = hex(found.head);
    const landed = q.entries.findIndex(
      (e) =>
        e.state === "pending" &&
        e.kind !== "charge" &&
        !(e.kind === "event" && e.lazy) &&
        (e.kind === "event" ? BigInt(e.seq) + 1n : BigInt(e.endSeq)) === tipSeq &&
        e.head === tipHead
    );
    if (landed < 0) return;
    for (let i = 0; i <= landed; i++) {
      const e = q.entries[i];
      // A charge inside the run is left alone: it is its own transaction and the chain's head
      // says nothing about whether the money moved.
      if (e.state !== "pending" || e.kind === "charge") continue;
      // Awaited. Not for the journal write — the caller's next step is a read of `entry.state`,
      // which is already right — but for the `onVerified` hook `settle` runs: an epoch's hook
      // publishes its locator cell, a real write that advances this same chain's `seq`. Left
      // unawaited, the pump would move on and build the next entry against a chain the cell was
      // about to move under it.
      await this.settle(e, e.signature ?? "");
    }
  }

  /**
   * The cluster's word on a charge in doubt, through the chain's own backend. A backend that
   * cannot ask — `NoopBilling`, an older one — answers `"unknown"`, so the charge is held rather
   * than sent again: not knowing is never read as "it did not land".
   */
  private async chargeLanded(agentId: Bytes32, signature: string): Promise<boolean | null | "unknown"> {
    const billing = this.billingFor(agentId);
    if (!billing?.chargeLanded) return "unknown";
    try {
      return await billing.chargeLanded(signature);
    } catch {
      return "unknown";
    }
  }

  private async submit(agentId: Bytes32, entry: AnchorEntry): Promise<string> {
    if (entry.kind === "charge") {
      const billing = this.billingFor(agentId);
      if (!billing?.charge) throw new Error("this queue has no billing backend to charge through");
      const signature = await billing.charge(new PublicKey(entry.user), BigInt(entry.amountMicroUsdc));
      // No signature is no debit (`ChargeUnpaid`), never an empty one that `settle` would record.
      if (!signature) throw new ChargeUnpaid(entry.amountMicroUsdc, entry.user);
      return signature;
    }
    if (entry.kind === "epoch") {
      const committed = await this.client.commitEpoch(
        agentId,
        toBytes32(entry.epochRoot),
        BigInt(entry.startSeq),
        BigInt(entry.endSeq)
      );
      if (hex(committed.head) !== entry.head) throw new HeadDiverged(entry.head, hex(committed.head));
      return committed.signature;
    }
    const logged = await this.client.logEventInput(
      agentId,
      deserializeEventInput(entry.input),
      entry.compact,
      await this.chargeInstructions(entry)
    );
    if (hex(logged.head) !== entry.head) throw new HeadDiverged(entry.head, hex(logged.head));
    return logged.signature;
  }

  /**
   * The debit that belongs in this record's transaction. A backend that can compose one keeps
   * the SPEC §12 guarantee — `chargeIxs` first, which carries the legacy-grant repair a bare
   * `chargeIx` lacks. One that can only send its own transaction charges first, once:
   * its signature is journaled on the entry before the record is sent, so a record that fails
   * after its charge landed is retried without a second debit — the rule a `charge` entry
   * follows (rule 2). A crash between the charge and the journal write can still resend it,
   * which is the bounded loss rule 2 accepts. Either way a record never claims work the
   * user was not billed for — the reverse would be a record that says paid when nothing moved.
   */
  private async chargeInstructions(entry: AnchorEventEntry): Promise<TransactionInstruction[] | undefined> {
    if (!entry.charge) return undefined;
    const amount = BigInt(entry.charge.amountMicroUsdc);
    if (amount === 0n) return undefined;
    const user = new PublicKey(entry.charge.user);
    // The entry's own chain, not the chain being drained elsewhere in this process: the record
    // and its debit were journaled together and must be paid through the backend that chain was
    // bound to.
    const billing = this.billingFor(toBytes32(entry.agentId));
    if (billing?.chargeIxs) return billing.chargeIxs(user, amount);
    if (billing?.chargeIx) return [await billing.chargeIx(user, amount)];
    if (billing?.charge) {
      // Charged on an earlier attempt of this entry: the record is what is still owed, not the
      // money. A landed-but-unconfirmed *record* never gets here — the head check settles it
      // without re-entering `submit`.
      if (entry.charge.signature !== undefined) return undefined;
      const inDoubt = entry.charge.inDoubt;
      if (inDoubt) {
        const landed = await this.chargeLanded(toBytes32(entry.agentId), inDoubt);
        if (landed === "unknown") {
          throw new Error(
            `the charge ${inDoubt} for this record is still in doubt (its status cannot be read); not resent, ` +
              "because a resent charge debits twice"
          );
        }
        if (landed === true) {
          entry.charge.signature = inDoubt;
          entry.charge.inDoubt = undefined;
          await this.journal.update(entry);
          return undefined;
        }
        // Failed, or unknown to the cluster once its blockhash is gone: nothing moved under it.
        entry.charge.inDoubt = undefined;
        await this.journal.update(entry);
      }
      let signature: string | null;
      try {
        signature = await billing.charge(user, amount);
      } catch (e) {
        // The in-doubt error `BillingClient.send` throws, for a charge that rides ahead of its
        // record: the signature is journaled so the next attempt — or a Retry in another process —
        // asks about it instead of debiting the user again, as a `charge` entry does. Without it,
        // each attempt of an event entry under a charge-only backend would be a fresh debit.
        const sent = (e as any)?.signature;
        if (typeof sent === "string" && sent.length > 0) {
          entry.charge.inDoubt = sent;
          await this.journal.update(entry);
        }
        throw e;
      }
      // The record is not sent on a charge that moved nothing: it would land claiming a debit that
      // never happened, and the journaled `""` would stop any later attempt charging it again.
      if (!signature) throw new ChargeUnpaid(entry.charge.amountMicroUsdc, entry.charge.user);
      entry.charge.signature = signature;
      await this.journal.update(entry);
      return undefined;
    }
    throw new Error("this entry carries a charge but the queue has no billing backend");
  }

  private async settle(entry: AnchorEntry, signature: string): Promise<void> {
    entry.state = "verified";
    entry.signature = signature;
    entry.error = undefined;
    if (entry.kind !== "charge") {
      const q = this.agents.get(entry.agentId);
      const landedAt = BigInt(entry.kind === "event" ? entry.seq : entry.endSeq) + (entry.kind === "event" ? 1n : 0n);
      if (q && landedAt > q.expectSeq) q.expectSeq = landedAt;
    }
    await this.journal.update(entry);
    const hooks = this.hooks.get(entry.id);
    if (hooks?.onVerified) {
      // Marked running before it leaves `hooks`, so `hookPending` never reads it as done early.
      this.settling.add(entry.id);
      this.hooks.delete(entry.id);
      try {
        await hooks.onVerified();
        if (entry.kind === "epoch" && entry.locator === "owed") entry.locator = "published";
        await this.journal.update(entry);
      } catch (e) {
        // The locator cell is the only hook there is, and an epoch that is on chain stays on
        // chain whether or not its bytes can be found from it. Report, do not undo — and leave
        // `locator` at `"owed"`, which is what keeps the entry in the journal for a later flush.
        entry.error = (e as any)?.message ?? String(e);
        await this.journal.update(entry);
      } finally {
        this.settling.delete(entry.id);
      }
    } else if (entry.kind === "epoch" && entry.locator === "owed") {
      // Settled by a process that did not journal it: `hooks` is in memory and `journal.load`
      // does not repopulate it, so there is nobody here holding the epoch store. The debt is
      // already on the entry; say so rather than letting a `verified` epoch read as complete.
      entry.error = "epoch verified without its locator hook; the locator cell is still owed";
      await this.journal.update(entry);
    }
    this.emit(entry);
  }
}

/** Rule 3: the chain confirmed a head this entry did not predict. Never retried. */
class HeadDiverged extends Error {
  constructor(readonly expected: string, readonly got: string, detail?: string) {
    super(
      `head diverged: journal expected ${expected.slice(0, 16)}…, chain confirmed ${got.slice(0, 16)}…` +
        (detail ? ` (${detail})` : "")
    );
    this.name = "HeadDiverged";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
