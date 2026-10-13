import { assert } from "chai";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { TreeType } from "@lightprotocol/stateless.js";
import { BN } from "@coral-xyz/anchor";
import {
  AgentState,
  AppendPolicy,
  AppendPolicyRewrite,
  assertEpochSpan,
  Bytes32,
  Cell,
  CellOp,
  computeCellHead,
  computeEpochHead,
  computeHead,
  computeStructHead,
  EventInput,
  EventKind,
  EventRecord,
  exitCode,
  GENESIS_HEAD,
  headerFolds,
  idFromString,
  LathClient,
  MAX_EPOCH_SPAN,
  MemoryEpochStore,
  sha256,
  StructHeader,
  StructKind,
  StructMode,
  utf8,
  valueSlot,
  type AuditReport,
  type ChainVerification,
} from "../sdk/src";

/**
 * No validator and no RPC. Two pieces of `client.ts` are pure enough to drive from a stub, and
 * both of them decide whether a chain is believed:
 *
 * - `verifyChain`'s fold, which must not call a chain verified when a gap stopped the replay
 *   before `AgentState.head` — the compact-logged agent that audited VERIFIED having compared
 *   nothing;
 * - `sendWrite`'s landed check and the in-doubt ledger behind `withRetry`, which are what stop a
 *   lost confirmation from becoming a second, identical write.
 *
 * The stub replaces only the reads: the folding, the gap bookkeeping and the head comparison are
 * the real ones, so what passes here is what runs on devnet.
 */

const PROGRAM_ID = new PublicKey("AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz");
const AGENT = idFromString("verify-chain-agent");

function bare(): LathClient {
  return new LathClient({} as any, { programId: PROGRAM_ID } as any, Keypair.generate());
}

function stateOf(seq: bigint, head: Bytes32): AgentState {
  return {
    authority: PublicKey.default,
    agentId: AGENT,
    seq,
    head,
    createdAt: 0n,
    updatedAt: 0n,
  };
}

/** One `log_event` at `seq`, folded onto `prev`. */
function record(prev: Bytes32, seq: bigint): EventRecord {
  const rec: EventRecord = {
    agentId: AGENT,
    seq,
    timestamp: 1_700_000_000_000n + seq,
    kind: EventKind.Action,
    status: 0,
    reference: new Uint8Array(32),
    payloadHash: sha256(new Uint8Array([Number(seq)])),
    head: new Uint8Array(32),
  };
  rec.head = computeHead(prev, AGENT, seq, rec);
  return rec;
}

/** `n` records folded from genesis, plus the head they leave behind. */
function chain(n: number): { records: EventRecord[]; head: Bytes32 } {
  const records: EventRecord[] = [];
  let head: Bytes32 = GENESIS_HEAD;
  for (let i = 0; i < n; i++) {
    const rec = record(head, BigInt(i));
    records.push(rec);
    head = rec.head;
  }
  return { records, head };
}

/**
 * A client whose reads are answered from memory. `readHistory` is answered too: `verifyChain`
 * walks transaction history the moment the record walk leaves a gap, and every case here is
 * about gaps, so leaving it to the real implementation would reach for an RPC that is not there.
 */
function clientFor(
  state: AgentState,
  records: EventRecord[],
  cells: { opSeq: bigint; op: number; head: Bytes32; signature: string }[] = [],
  history: (EventRecord & { compact?: boolean })[] = [],
  structs: { opSeq: bigint; head: Bytes32; signature: string }[] = [],
  accounts: { headers?: StructHeader[]; cells?: Cell[]; policies?: AppendPolicyRewrite[] } = {}
): LathClient {
  const client = bare();
  const reads = client as any;
  reads.getAgentState = async () => ({ account: {}, state });
  reads.listEvents = async () => records;
  reads.listStructs = async () => accounts.headers ?? [];
  reads.listOwnerCells = async () => accounts.cells ?? [];
  reads.historyReads = 0;
  reads.readHistory = async () => {
    reads.historyReads++;
    // `compact` is what the real `readHistory` reads off the instruction name: absent here means
    // a `log_event` write, the one that created an account.
    return {
      events: history.map((r) => ({ ...r, signature: "h", compact: r.compact ?? false })),
      epochs: [],
      cells,
      structs,
      policies: accounts.policies ?? [],
    };
  };
  return client;
}

/**
 * The exit code `lath-audit` gives a report carrying this verification, with nothing else wrong:
 * 1 is BROKEN (a head was checked and was wrong), 4 is NOT VERIFIED (part of the chain unchecked).
 */
function exitOf(v: ChainVerification): number {
  const report: AuditReport = {
    agentId: "aa".repeat(32),
    programId: PROGRAM_ID.toBase58(),
    authority: PublicKey.default.toBase58(),
    seq: v.seq.toString(),
    head: Buffer.from(v.head).toString("hex"),
    chain: {
      ok: v.ok,
      headReached: v.headReached,
      records: v.records,
      firstBadSeq: v.firstBadSeq?.toString(),
      missingSeqs: v.missingSeqs.map(String),
      unexplainedGaps: v.unexplainedGaps.map(String),
      recoveredSeqs: v.recoveredSeqs.map(String),
    },
    ok: v.ok,
  };
  return exitCode(report);
}

/** A head no record fold produces — what a `close_cell` leaves, as far as this stub is concerned. */
const closeHead = (prev: Bytes32, seq: bigint) => sha256(new Uint8Array([...prev, Number(seq), 0xc1]));

describe("verifyChain reaches the head, or says it did not", () => {
  it("verifies a chain with no gaps", async () => {
    const { records, head } = chain(3);
    const v = await clientFor(stateOf(3n, head), records).verifyChain(AGENT);

    assert.isTrue(v.ok);
    assert.isTrue(v.headReached);
    assert.isUndefined(v.firstBadSeq);
    assert.deepEqual(v.missingSeqs, []);
    assert.equal(v.records, 3);
  });

  it("does not verify a chain logged entirely with compact writes", async () => {
    // Every seq is a gap, so the fold never leaves `null` and `AgentState.head` is never
    // compared with anything. The old tail test short-circuited this into `ok: true`, and
    // `lath-audit` printed VERIFIED and exited 0 over an unread chain.
    const { head } = chain(4);
    const v = await clientFor(stateOf(4n, head), []).verifyChain(AGENT);

    assert.isFalse(v.headReached, "nothing was folded, so nothing reached the head");
    assert.isFalse(v.ok, "an unchecked chain is not a verified one");
    assert.isUndefined(v.firstBadSeq, "no head disagreed — none was checked");
    assert.deepEqual(v.missingSeqs, [0n, 1n, 2n, 3n]);
  });

  it("does not verify a chain whose last write was compact", async () => {
    // The shape a real agent has: ordinary records, then a terminal compact write (or a
    // `close_cell`, which leaves no account either). The records replay, the tail does not.
    const { records, head } = chain(3);
    const afterCompact = computeHead(head, AGENT, 3n, record(head, 3n));
    const v = await clientFor(stateOf(4n, afterCompact), records).verifyChain(AGENT);

    assert.isFalse(v.headReached);
    assert.isFalse(v.ok);
    assert.deepEqual(v.missingSeqs, [3n]);
    assert.equal(v.records, 3, "the records that do exist still replayed");
  });

  it("still verifies a chain whose middle gap is a compact write history names", async () => {
    // The documented behaviour this must not break: a gap is reported, not replayed across, and
    // the replay re-synchronises at the next record — which does carry the head that gets
    // compared with `AgentState.head`. The program emitted `EventLogged` for the compact write,
    // and history names `log_event_compact` as what wrote it, so seq 1 is accounted for without
    // `recover` folding it.
    const { records } = chain(3);
    const withGap = [records[0], records[2]];
    const compact = [{ ...records[1], compact: true }];
    const v = await clientFor(stateOf(3n, records[2].head), withGap, [], compact).verifyChain(AGENT);

    assert.isTrue(v.headReached);
    assert.isTrue(v.ok);
    assert.deepEqual(v.missingSeqs, [1n]);
    assert.deepEqual(v.unexplainedGaps, []);
  });

  it("does not verify a dropped log_event record whose signature history still lists", async () => {
    // The indexer drops record 1's account but keeps its transaction. History shows `log_event`
    // wrote seq 1, and that write created an account — so the gap is a record not being shown,
    // not a compact write. Counted as explained, it would read ok, VERIFIED, exit 0, with the event
    // neither folded nor walked for its preimage.
    const { records } = chain(3);
    const withGap = [records[0], records[2]];
    const v = await clientFor(stateOf(3n, records[2].head), withGap, [], [records[1]]).verifyChain(AGENT);

    assert.isTrue(v.headReached);
    assert.isUndefined(v.firstBadSeq);
    assert.deepEqual(v.missingSeqs, [1n]);
    assert.deepEqual(v.unexplainedGaps, [1n]);
    assert.isFalse(v.ok);
  });

  it("does not take a StructCreated as explaining a missing header, and re-syncs it under --recover", async () => {
    // A structure header is never closed, so its seq missing is an indexer not returning it.
    const r0 = record(GENESIS_HEAD, 0n);
    const created = closeHead(r0.head, 1n);
    const r2 = record(created, 2n);
    const structs = [{ opSeq: 1n, head: created, signature: "s" }];
    const plain = await clientFor(stateOf(3n, r2.head), [r0, r2], [], [], structs).verifyChain(AGENT);
    assert.isFalse(plain.ok);
    assert.deepEqual(plain.unexplainedGaps, [1n]);

    const rec = await clientFor(stateOf(3n, r2.head), [r0, r2], [], [], structs).verifyChain(AGENT, { recover: true });
    assert.isTrue(rec.ok);
    assert.deepEqual(rec.missingSeqs, []);
    assert.deepEqual(rec.resyncedSeqs, [1n]);
  });

  it("does not verify a chain whose middle gap nothing explains", async () => {
    // An indexer that drops record 1 and has no history for it: the fold re-syncs at record 2's
    // stored head and reaches `AgentState.head`, nothing disagrees — and seq 1 was never seen.
    // Returning `ok: true` would have `lath-audit` exit 0 VERIFIED over a hidden event.
    const { records } = chain(3);
    const withGap = [records[0], records[2]];
    const v = await clientFor(stateOf(3n, records[2].head), withGap).verifyChain(AGENT);

    assert.isTrue(v.headReached, "the fold did reach the head");
    assert.isUndefined(v.firstBadSeq, "no head disagreed");
    assert.deepEqual(v.missingSeqs, [1n]);
    assert.deepEqual(v.unexplainedGaps, [1n]);
    assert.isFalse(v.ok, "a chain with a write nobody saw is not verified");
  });

  it("verifies the dropped log_event record once --recover folds it back from history", async () => {
    const { records } = chain(3);
    const withGap = [records[0], records[2]];
    const v = await clientFor(stateOf(3n, records[2].head), withGap, [], [records[1]]).verifyChain(AGENT, {
      recover: true,
    });

    assert.isTrue(v.ok);
    assert.deepEqual(v.missingSeqs, []);
    assert.deepEqual(v.unexplainedGaps, []);
    assert.deepEqual(v.recoveredSeqs, [1n]);
  });

  it("reports a tail head that does not re-fold as a divergence, not as a gap", async () => {
    const { records } = chain(3);
    const v = await clientFor(stateOf(3n, sha256(new Uint8Array([9]))), records).verifyChain(AGENT);

    assert.isTrue(v.headReached, "the fold did reach the tail; it disagreed there");
    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 2n);
  });

  it("verifies a chain whose tail is a close_cell, from the head its CellWritten emitted", async () => {
    // seed-agent-alpha's shape: records, then a `close_cell` whose account is gone. The
    // event names the head the close produced, and that head is `AgentState.head`.
    const { records, head } = chain(3);
    const closed = closeHead(head, 3n);
    const client = clientFor(stateOf(4n, closed), records, [{ opSeq: 3n, op: 2, head: closed, signature: "s" }]);
    const v = await client.verifyChain(AGENT);

    assert.isTrue(v.headReached);
    assert.isTrue(v.ok);
    assert.deepEqual(v.missingSeqs, []);
    assert.deepEqual(v.resyncedSeqs, [3n]);
  });

  it("re-syncs a middle closed cell and a tail closed cell together", async () => {
    // Gaps at 1 (a replaced-away Map put) and 3 (the tail close); record 2 still re-folds.
    const r0 = record(GENESIS_HEAD, 0n);
    const put = closeHead(r0.head, 1n);
    const r2 = record(put, 2n);
    const closed = closeHead(r2.head, 3n);
    const cells = [
      { opSeq: 1n, op: 0, head: put, signature: "a" },
      { opSeq: 3n, op: 2, head: closed, signature: "b" },
    ];
    const v = await clientFor(stateOf(4n, closed), [r0, r2], cells).verifyChain(AGENT);

    assert.isTrue(v.ok);
    assert.deepEqual(v.resyncedSeqs, [1n, 3n]);
    assert.deepEqual(v.missingSeqs, []);
  });

  it("still breaks when a record after a re-synced cell does not fold from its head", async () => {
    const r0 = record(GENESIS_HEAD, 0n);
    const put = closeHead(r0.head, 1n);
    const r2 = record(sha256(new Uint8Array([5])), 2n); // folded from some other head
    const cells = [{ opSeq: 1n, op: 0, head: put, signature: "a" }];
    const v = await clientFor(stateOf(3n, r2.head), [r0, r2], cells).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 2n, "the event head is carried forward and record 2 is checked against it");
  });

  it("does not verify a tail CellWritten head that disagrees with AgentState.head", async () => {
    const { records, head } = chain(3);
    const cells = [{ opSeq: 3n, op: 2, head: sha256(new Uint8Array([8])), signature: "s" }];
    const v = await clientFor(stateOf(4n, closeHead(head, 3n)), records, cells).verifyChain(AGENT);

    assert.isTrue(v.headReached);
    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 3n);
  });

  it("reads no transaction history for a chain with no gaps", async () => {
    const { records, head } = chain(3);
    const client = clientFor(stateOf(3n, head), records);
    await client.verifyChain(AGENT);
    assert.equal((client as any).historyReads, 0);
  });

  it("verifies a freshly registered agent that has written nothing", async () => {
    const v = await clientFor(stateOf(0n, GENESIS_HEAD), []).verifyChain(AGENT);

    assert.isTrue(v.headReached, "genesis is the head, and genesis is known");
    assert.isTrue(v.ok);
    assert.deepEqual(v.missingSeqs, []);
  });
});

/**
 * A structure whose append policy was rewritten by `set_append_policy`. The header account
 * is re-created at its own address showing the *new* policy and no account records the rewrite's
 * seq, so a verifier that recomputes the `CREATE_STRUCT` fold from the header as read hashes the
 * wrong policy and every agent that used the instruction audits FAILED at its next recorded head.
 * `AppendPolicySet` is the only place the previous policy survives; these cases pin that the
 * replay reads it back, and that a chain with no rewrite is replayed exactly as one always was.
 */
describe("verifyChain replays a header rewritten by set_append_policy", () => {
  const STRUCT = sha256(utf8("runtime-inbox"));
  const ZERO = new Uint8Array(32);

  /**
   * A legacy mailbox's life: created `Anyone` at seq 0, one cell at 1, a record at 2, taken to
   * `OwnerOnly` at 3, a record at 4. Every head is the real fold, and the header is returned as
   * Photon would return it today — `OwnerOnly`, with the cell counted.
   */
  function rewrittenChain() {
    const atCreation: StructHeader = {
      ownerId: AGENT,
      structId: STRUCT,
      kind: StructKind.Log,
      mode: StructMode.Public,
      lenOrCount: 0n,
      createdOpSeq: 0n,
      consumable: true,
      appendPolicy: AppendPolicy.Anyone,
      policyRef: ZERO,
    };
    const h0 = computeStructHead(GENESIS_HEAD, atCreation, 0n);
    const cell: Cell = {
      ownerId: AGENT,
      structId: STRUCT,
      indexOrVersion: 0n,
      opSeq: 1n,
      timestamp: 1_700_000_000_001n,
      tag: 3,
      status: 0,
      keySlot: ZERO,
      valueSlot: valueSlot("hello"),
      head: ZERO,
    };
    cell.head = computeCellHead(h0, CellOp.Create, cell);
    const r2 = record(cell.head, 2n);
    const asRead: StructHeader = { ...atCreation, lenOrCount: 1n, appendPolicy: AppendPolicy.OwnerOnly };
    const h3 = computeStructHead(r2.head, asRead, 3n, CellOp.SetAppendPolicy);
    const r4 = record(h3, 4n);
    const rewrite: AppendPolicyRewrite = {
      opSeq: 3n,
      structId: STRUCT,
      previousPolicy: AppendPolicy.Anyone,
      previousPolicyRef: ZERO,
      appendPolicy: AppendPolicy.OwnerOnly,
      policyRef: ZERO,
      head: h3,
    };
    return { atCreation, asRead, cell, records: [r2, r4], rewrite, heads: [h0, cell.head, r2.head, h3, r4.head] };
  }

  it("verifies the chain once the rewrite is read back from AppendPolicySet", async () => {
    const c = rewrittenChain();
    const client = clientFor(stateOf(5n, c.heads[4]), c.records, [], [], [], {
      headers: [c.asRead],
      cells: [c.cell],
      policies: [c.rewrite],
    });
    const v = await client.verifyChain(AGENT);

    assert.isTrue(v.ok, `firstBadSeq ${v.firstBadSeq}, missing ${v.missingSeqs}, unexplained ${v.unexplainedGaps}`);
    assert.isTrue(v.headReached);
    assert.deepEqual(v.missingSeqs, [], "the rewrite's seq is folded, not left as a gap");
    assert.deepEqual(v.resyncedSeqs, [], "recomputed from the header and the event, not taken on the event's word");
    assert.equal(v.policyRewrites, 1);
    assert.equal(v.structs, 1);
    assert.equal((client as any).historyReads, 1, "the rewrite's seq is the gap that reads history");
  });

  it("reads the chain as unchecked, not broken, when the AppendPolicySet transaction is missing", async () => {
    // History with no `AppendPolicySet` — `getTransaction` returned nothing for it, an RPC that
    // pruned it, or a stub that knows no rewrite. The creation fold over the header as read hashes
    // `OwnerOnly`, so seq 1's recorded head would disagree: `firstBadSeq: 1`, BROKEN, exit 1,
    // for an intact chain, where every other missing transaction reads as a gap nobody checked.
    // The gap at 3 could be the rewrite, so the creation fold is not carried forward: the replay
    // re-syncs at the cell, still checks record 2 from it, and seq 3 keeps the chain unverified.
    const c = rewrittenChain();
    const v = await clientFor(stateOf(5n, c.heads[4]), c.records, [], [], [], {
      headers: [c.asRead],
      cells: [c.cell],
    }).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.isUndefined(v.firstBadSeq, `firstBadSeq ${v.firstBadSeq}`);
    assert.isTrue(v.headReached);
    assert.deepEqual(v.missingSeqs, [3n]);
    assert.deepEqual(v.unexplainedGaps, [3n]);
    assert.equal(exitOf(v), 4, "NOT VERIFIED (gaps), not FAILED");
  });

  it("still breaks at a later record that does not fold, with the rewrite missing", async () => {
    // Dropping the creation fold costs one check — the one the missing history made unreliable —
    // and no other: record 2 is still recomputed from the cell's recorded head.
    const c = rewrittenChain();
    const stray = record(sha256(utf8("not the cell's head")), 2n);
    const v = await clientFor(stateOf(5n, c.heads[4]), [stray, c.records[1]], [], [], [], {
      headers: [c.asRead],
      cells: [c.cell],
    }).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 2n);
    assert.equal(exitOf(v), 1);
  });

  it("reads the chain as unchecked when only the second of two rewrites came back", async () => {
    // Anyone at 0, OwnerOnly at 3 (its transaction missing), AllowList at 5 (present), a record at
    // 6. `headerFolds` rebuilds the creation from the rewrite it has, whose `previous_policy` is
    // OwnerOnly — the policy after the missing rewrite, not the one `create_struct` folded — so
    // this diverged at seq 1 exactly like a single missing rewrite. The fold at 5 is still
    // recomputed over AllowList and checked against its event's head.
    const c = rewrittenChain();
    const ref = sha256(utf8("senders"));
    const nowAllowList: StructHeader = { ...c.asRead, appendPolicy: AppendPolicy.AllowList, policyRef: ref };
    const h5 = computeStructHead(c.heads[4], nowAllowList, 5n, CellOp.SetAppendPolicy);
    const r6 = record(h5, 6n);
    const second: AppendPolicyRewrite = {
      opSeq: 5n,
      structId: STRUCT,
      previousPolicy: AppendPolicy.OwnerOnly,
      previousPolicyRef: ZERO,
      appendPolicy: AppendPolicy.AllowList,
      policyRef: ref,
      head: h5,
    };
    const v = await clientFor(stateOf(7n, r6.head), [...c.records, r6], [], [], [], {
      headers: [nowAllowList],
      cells: [c.cell],
      policies: [second],
    }).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.isUndefined(v.firstBadSeq, `firstBadSeq ${v.firstBadSeq}`);
    assert.deepEqual(v.unexplainedGaps, [3n]);
    assert.equal(v.policyRewrites, 1);
    assert.equal(exitOf(v), 4);

    // The same history with the rewrite at 5 forged: still caught at its own seq, gap or not.
    const forged = await clientFor(stateOf(7n, r6.head), [...c.records, r6], [], [], [], {
      headers: [nowAllowList],
      cells: [c.cell],
      policies: [{ ...second, head: sha256(utf8("some other head")) }],
    }).verifyChain(AGENT);
    assert.equal(forged.firstBadSeq, 5n);
  });

  it("keeps checking the creation fold when the only gap after it is a compact write", async () => {
    // A compact write is no rewrite: history names the instruction that wrote it. With no other
    // gap the creation fold is carried forward as before, and a header whose policy does not
    // match what the chain folded is still caught at the cell after it.
    const c = rewrittenChain();
    const compact = { ...record(c.records[0].head, 3n), compact: true };
    const r4 = record(compact.head, 4n);
    const v = await clientFor(stateOf(5n, r4.head), [c.records[0], r4], [], [compact], [], {
      headers: [c.asRead],
      cells: [c.cell],
    }).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 1n, "the header reads OwnerOnly and nothing says it was ever rewritten");
    assert.deepEqual(v.unexplainedGaps, []);
    assert.equal(exitOf(v), 1);
  });

  it("fails on a tampered previous_policy, at the first head after the creation", async () => {
    // An event claiming the structure was always `OwnerOnly`: the creation fold it rebuilds is
    // not the one the chain holds, and the cell at seq 1 says so.
    const c = rewrittenChain();
    const forged = { ...c.rewrite, previousPolicy: AppendPolicy.OwnerOnly };
    const v = await clientFor(stateOf(5n, c.heads[4]), c.records, [], [], [], {
      headers: [c.asRead],
      cells: [c.cell],
      policies: [forged],
    }).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 1n);
  });

  it("fails on a tampered previous_policy_ref the same way", async () => {
    const c = rewrittenChain();
    const forged = { ...c.rewrite, previousPolicyRef: sha256(utf8("not the ref")) };
    const v = await clientFor(stateOf(5n, c.heads[4]), c.records, [], [], [], {
      headers: [c.asRead],
      cells: [c.cell],
      policies: [forged],
    }).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 1n);
  });

  it("fails at the rewrite's own seq when the head its event names is not the fold", async () => {
    const c = rewrittenChain();
    const forged = { ...c.rewrite, head: sha256(utf8("some other head")) };
    const v = await clientFor(stateOf(5n, c.heads[4]), c.records, [], [], [], {
      headers: [c.asRead],
      cells: [c.cell],
      policies: [forged],
    }).verifyChain(AGENT);

    assert.isFalse(v.ok);
    assert.equal(v.firstBadSeq, 3n, "the rewrite is recomputed and checked against the event's head");
  });

  it("replays a chain with no rewrite from the header as read, without reading history", async () => {
    // The old shape, byte for byte: a header created `OwnerOnly` and never rewritten folds from
    // the account alone, and nothing here is a gap, so transaction history is not touched.
    const header: StructHeader = {
      ownerId: AGENT,
      structId: STRUCT,
      kind: StructKind.Log,
      mode: StructMode.Public,
      lenOrCount: 0n,
      createdOpSeq: 0n,
      consumable: false,
      appendPolicy: AppendPolicy.OwnerOnly,
      policyRef: ZERO,
    };
    const h0 = computeStructHead(GENESIS_HEAD, header, 0n);
    const r1 = record(h0, 1n);
    const client = clientFor(stateOf(2n, r1.head), [r1], [], [], [], { headers: [header] });
    const v = await client.verifyChain(AGENT);

    assert.isTrue(v.ok);
    assert.deepEqual(v.missingSeqs, []);
    assert.equal(v.policyRewrites, 0);
    assert.equal((client as any).historyReads, 0);
  });

  it("re-syncs a rewrite whose header the indexer dropped only under --recover, like the header", async () => {
    // No header and so no cells from the account view: seqs 0, 1 and 3 are gaps. The cell
    // re-syncs from `CellWritten` regardless; the header and the rewrite need the header's fixed
    // fields to fold, which only the account has, so without it they are taken from their events
    // on the same terms as a missing `StructCreated` — asked for with `recover`.
    const c = rewrittenChain();
    const cells = [{ opSeq: 1n, op: CellOp.Create, head: c.heads[1], signature: "c" }];
    const structs = [{ opSeq: 0n, head: c.heads[0], signature: "s" }];
    const plain = await clientFor(stateOf(5n, c.heads[4]), c.records, cells, [], structs, {
      policies: [c.rewrite],
    }).verifyChain(AGENT);
    assert.isFalse(plain.ok);
    assert.deepEqual(plain.unexplainedGaps, [0n, 3n]);

    const rec = await clientFor(stateOf(5n, c.heads[4]), c.records, cells, [], structs, {
      policies: [c.rewrite],
    }).verifyChain(AGENT, { recover: true });
    assert.isTrue(rec.ok);
    assert.deepEqual(rec.missingSeqs, []);
    assert.deepEqual([...rec.resyncedSeqs].sort(), [0n, 1n, 3n]);
  });

  it("headerFolds rebuilds the creation from the earliest rewrite and folds each rewrite in order", () => {
    const c = rewrittenChain();
    const ref = sha256(utf8("senders"));
    const second: AppendPolicyRewrite = {
      opSeq: 7n,
      structId: STRUCT,
      previousPolicy: AppendPolicy.OwnerOnly,
      previousPolicyRef: ZERO,
      appendPolicy: AppendPolicy.AllowList,
      policyRef: ref,
      head: sha256(utf8("h7")),
    };
    const other: AppendPolicyRewrite = { ...second, opSeq: 5n, structId: sha256(utf8("another struct")) };
    const nowAllowList: StructHeader = { ...c.asRead, appendPolicy: AppendPolicy.AllowList, policyRef: ref };
    // Given out of order and with another structure's rewrite mixed in.
    const folds = headerFolds(nowAllowList, [second, other, c.rewrite]);

    assert.deepEqual(
      folds.map((f) => [f.opSeq, f.op, f.header.appendPolicy]),
      [
        [0n, CellOp.CreateStruct, AppendPolicy.Anyone],
        [3n, CellOp.SetAppendPolicy, AppendPolicy.OwnerOnly],
        [7n, CellOp.SetAppendPolicy, AppendPolicy.AllowList],
      ]
    );
    assert.equal(hexOf(folds[2].header.policyRef), hexOf(ref));
    assert.isUndefined(folds[0].head, "a creation records no head");
    assert.equal(hexOf(folds[1].head!), hexOf(c.heads[3]));
    // The creation fold is the one the chain holds.
    assert.equal(hexOf(computeStructHead(GENESIS_HEAD, folds[0].header, 0n)), hexOf(c.heads[0]));
    // No rewrites: one creation fold over the header exactly as given.
    const plain = headerFolds(c.atCreation, []);
    assert.lengthOf(plain, 1);
    assert.strictEqual(plain[0].header, c.atCreation);
  });
});

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * The landed check behind every write that folds into a chain. `send` is stubbed to fail the
 * way a real confirmation timeout does — the transaction is out, the answer is not — and the
 * only question is whether `sendWrite` reads the chain before letting `withRetry` send again.
 */
class LandedProbe extends LathClient {
  sends = 0;
  readonly after: AgentState | null;
  readonly attachSignature: boolean;

  constructor(after: AgentState | null, attachSignature: boolean) {
    super({} as any, { programId: PROGRAM_ID } as any, Keypair.generate());
    this.after = after;
    this.attachSignature = attachSignature;
  }

  protected async send(): Promise<string> {
    this.sends++;
    const e: any = new Error("Transaction was not confirmed in 30.00 seconds");
    // `send` attaches the signature only when the transaction actually left the client; a
    // failure before that (a blockhash fetch, a refused signature) carries none, and nothing
    // may be assumed to have landed.
    if (this.attachSignature) e.signature = "sig-under-test";
    throw e;
  }

  async getAgentState(): Promise<any> {
    return this.after === null ? null : { account: {}, state: this.after };
  }

  /** The in-doubt ledger the last probe wrote to — what the next attempt would consult. */
  readonly sent: any[] = [];

  probe(expectedSeq: bigint, expectedHead: Bytes32): Promise<string> {
    const from = { seq: expectedSeq - 1n, head: GENESIS_HEAD };
    return this.sendWrite({} as any, AGENT, from, expectedSeq, expectedHead, this.sent, (s: string) => s);
  }
}

/** The probe must hand the failure back to `withRetry` untouched, so the message is checked too. */
async function rethrows(p: Promise<unknown>, why: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.match(String((e as Error).message), /not confirmed/, why);
    return;
  }
  assert.fail(why);
}

/**
 * `readHistory` itself, over transactions whose instruction data and logs are encoded with the
 * program's own coder: the `compact` flag the fold relies on must come from the instruction that
 * wrote the seq, since that is the only thing telling a compact write from a dropped record.
 */
describe("readHistory names the instruction that wrote each seq", () => {
  it("marks log_event_compact seqs compact and log_event / log_events seqs not", async () => {
    const txs = new Map<string, any>();
    const rpc: any = {
      getCompressionSignaturesForAddress: async () => ({
        items: [...txs.keys()].map((signature) => ({ signature })),
        cursor: null,
      }),
      getTransaction: async (sig: string) => txs.get(sig),
    };
    const client: any = LathClient.fromIdl(rpc, Keypair.generate());
    const coder = client.program.coder;
    const programId: PublicKey = client.programId;
    const disc = Buffer.from(client.program.idl.events.find((e: any) => e.name === "eventLogged").discriminator);
    const input = (seq: number) => ({
      timestamp: new BN(1_700_000_000_000 + seq),
      kind: EventKind.Action,
      status: 0,
      reference: Array(32).fill(0),
      payloadHash: Array.from(sha256(new Uint8Array([seq]))),
    });
    const current = {
      authority: PublicKey.default,
      agentId: Array.from(AGENT),
      seq: new BN(0),
      head: Array(32).fill(0),
      createdAt: new BN(0),
      updatedAt: new BN(0),
    };
    const agentMeta = {
      treeInfo: { rootIndex: 0, proveByIndex: false, merkleTreePubkeyIndex: 0, queuePubkeyIndex: 0, leafIndex: 0 },
      address: Array(32).fill(0),
      outputStateTreeIndex: 0,
    };
    const tree = { addressMerkleTreePubkeyIndex: 0, addressQueuePubkeyIndex: 0, rootIndex: 0 };
    const base = { proof: { 0: null }, current, agentMeta };
    const logged = (seq: number) =>
      "Program data: " +
      Buffer.concat([
        disc,
        coder.types.encode("eventLogged", {
          agentId: Array.from(AGENT),
          seq: new BN(seq),
          kind: EventKind.Action,
          head: Array(32).fill(seq),
        }),
      ]).toString("base64");
    const tx = (name: string, args: any, seqs: number[]) => ({
      slot: 1,
      blockTime: null,
      meta: {
        err: null,
        loadedAddresses: undefined,
        logMessages: [
          `Program ${programId.toBase58()} invoke [1]`,
          ...seqs.map(logged),
          `Program ${programId.toBase58()} success`,
        ],
      },
      transaction: {
        message: {
          getAccountKeys: () => ({ get: (i: number) => (i === 0 ? programId : undefined) }),
          compiledInstructions: [{ programIdIndex: 0, data: coder.instruction.encode(name, args) }],
        },
      },
    });
    const full = { ...base, eventTreeInfo: tree, eventOutputStateTreeIndex: 0 };
    txs.set("a", tx("logEvent", { ...full, input: input(0) }, [0]));
    txs.set("b", tx("logEventCompact", { ...base, input: input(1) }, [1]));
    txs.set("c", tx("logEvents", { ...full, inputs: [input(2), input(3)] }, [2, 3]));

    const h = await client.readHistory(AGENT);
    assert.deepEqual(
      h.events.map((e: any) => [Number(e.seq), e.compact]),
      [
        [0, false],
        [1, true],
        [2, false],
        [3, false],
      ]
    );
    assert.equal(h.events[1].payloadHash[0], sha256(new Uint8Array([1]))[0], "the input decoded, not just the name");
    assert.deepEqual(h.policies, [], "no rewrite in this history");
  });

  it("decodes AppendPolicySet into policies, and only the owner's", async () => {
    // The event through the program's own coder, so the name and field spelling `readHistory`
    // matches on are the IDL's and not a stub's.
    const txs = new Map<string, any>();
    const rpc: any = {
      getCompressionSignaturesForAddress: async () => ({
        items: [...txs.keys()].map((signature) => ({ signature })),
        cursor: null,
      }),
      getTransaction: async (sig: string) => txs.get(sig),
    };
    const client: any = LathClient.fromIdl(rpc, Keypair.generate());
    const coder = client.program.coder;
    const programId: PublicKey = client.programId;
    const disc = Buffer.from(client.program.idl.events.find((e: any) => e.name === "appendPolicySet").discriminator);
    const structId = sha256(utf8("runtime-inbox"));
    const policySet = (ownerId: Uint8Array, opSeq: number) =>
      "Program data: " +
      Buffer.concat([
        disc,
        coder.types.encode("appendPolicySet", {
          ownerId: Array.from(ownerId),
          structId: Array.from(structId),
          previousPolicy: AppendPolicy.Anyone,
          previousPolicyRef: Array(32).fill(0),
          appendPolicy: AppendPolicy.OwnerOnly,
          policyRef: Array(32).fill(0),
          opSeq: new BN(opSeq),
          head: Array(32).fill(opSeq),
        }),
      ]).toString("base64");
    const tx = (log: string) => ({
      slot: 1,
      blockTime: null,
      meta: {
        err: null,
        loadedAddresses: undefined,
        logMessages: [`Program ${programId.toBase58()} invoke [1]`, log, `Program ${programId.toBase58()} success`],
      },
      transaction: {
        message: {
          getAccountKeys: () => ({ get: () => undefined }),
          compiledInstructions: [],
        },
      },
    });
    txs.set("ours", tx(policySet(AGENT, 3)));
    txs.set("theirs", tx(policySet(idFromString("someone else"), 9)));

    const h = await client.readHistory(AGENT);
    assert.lengthOf(h.policies, 1, "another owner's rewrite is not this chain's");
    const p = h.policies[0];
    assert.equal(p.opSeq, 3n);
    assert.equal(hexOf(p.structId), hexOf(structId));
    assert.equal(p.previousPolicy, AppendPolicy.Anyone);
    assert.equal(p.appendPolicy, AppendPolicy.OwnerOnly);
    assert.equal(hexOf(p.previousPolicyRef), hexOf(new Uint8Array(32)));
    assert.equal(hexOf(p.head), hexOf(new Uint8Array(32).fill(3)));
    assert.deepEqual(h.events, [], "a rewrite is not an event");
  });
});

describe("a lost confirmation is not resent", () => {
  const { records, head } = chain(3);
  const landedState = stateOf(3n, head);

  it("returns the signature when the chain shows the write's own (seq, head)", async () => {
    const probe = new LandedProbe(landedState, true);
    assert.equal(await probe.probe(3n, head), "sig-under-test");
    assert.equal(probe.sends, 1, "the transaction was sent once and is not offered to a retry");
  });

  it("rethrows when the chain is still at the state before the write", async () => {
    const probe = new LandedProbe(stateOf(2n, records[1].head), true);
    await rethrows(probe.probe(3n, head), "a write that did not land must be retried");
    // …and records it as in doubt, so the next attempt asks before it builds again.
    assert.lengthOf(probe.sent, 1);
    assert.equal(probe.sent[0].signature, "sig-under-test");
    assert.equal(probe.sent[0].to.seq, 3n);
    assert.equal(probe.sent[0].result("sig-under-test"), "sig-under-test");
  });

  it("rethrows on the right seq under a different head", async () => {
    // Somebody else's write can land at the same seq; only the head this client computed
    // identifies the transaction it sent.
    const probe = new LandedProbe(stateOf(3n, sha256(new Uint8Array([7]))), true);
    await rethrows(probe.probe(3n, head), "a seq match under a foreign head is not this write");
  });

  it("rethrows when the failure carried no signature, whatever the chain says", async () => {
    const probe = new LandedProbe(landedState, false);
    await rethrows(probe.probe(3n, head), "nothing was sent, so nothing may be assumed to have landed");
    assert.lengthOf(probe.sent, 0, "and there is nothing in doubt");
  });

  it("rethrows when the agent header cannot be read at all", async () => {
    const probe = new LandedProbe(null, true);
    await rethrows(probe.probe(3n, head), "an unreadable header proves nothing about the write");
  });

  it("keeps the entry in doubt when the landed read itself fails", async () => {
    // A 429 on the one Photon read must not lose the fact that a transaction went out.
    const probe = new LandedProbe(landedState, true);
    (probe as any).getAgentState = async () => {
      throw new Error("HTTP error! status: 429");
    };
    await rethrows(probe.probe(3n, head), "the send's own failure is what goes back to withRetry");
    assert.lengthOf(probe.sent, 1);
  });

  it("recognises a batch by the seq it ends at and the head it folds to", async () => {
    // `log_events` advances by `inputs.length` in one transaction, so the state a landed batch
    // leaves is `firstSeq + n` under the fold over every input — not `firstSeq + 1`.
    const batchEnd = chain(2);
    const probe = new LandedProbe(stateOf(2n, batchEnd.head), true);
    assert.equal(await probe.probe(2n, batchEnd.head), "sig-under-test");
    await rethrows(
      new LandedProbe(stateOf(2n, batchEnd.head), true).probe(1n, batchEnd.records[0].head),
      "the first event's head is not the state a landed batch leaves"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// A lost confirmation inside `withRetry`, end to end against a fake cluster.
// ---------------------------------------------------------------------------------------------

/** AgentState's 120 bytes, at the offsets `decodeAgentState` reads (`AGENT_STATE_OFFSETS`). */
function encodeState(s: AgentState): Buffer {
  const out = Buffer.alloc(120);
  s.authority.toBuffer().copy(out, 0);
  Buffer.from(s.agentId).copy(out, 32);
  out.writeBigUInt64LE(s.seq, 64);
  Buffer.from(s.head).copy(out, 72);
  out.writeBigInt64LE(s.createdAt, 104);
  out.writeBigInt64LE(s.updatedAt, 112);
  return out;
}

const TREE = {
  tree: new PublicKey(new Uint8Array(32).fill(3)),
  queue: new PublicKey(new Uint8Array(32).fill(4)),
  treeType: TreeType.StateV2,
  nextTreeInfo: null,
};

/** Borsh field names come back in the IDL's spelling; the SDK writes camelCase. Accept both. */
const field = (o: any, camel: string, snake: string) => o[camel] ?? o[snake];

/**
 * One agent's chain as a validator plus a lagging Photon would show it. `send` applies the
 * instruction it decodes — the program's own arguments, through the real IDL coder — and
 * refuses one built on a state the chain has moved past, the way a spent account hash fails its
 * proof. The first landing's confirmation is lost: the transaction is on chain, and the error
 * `send` raises carries its signature, which is the shape `confirmByPolling` gives up with.
 *
 * `lagReads` is how many state reads after a landing still see the state before it.
 */
class FakeCluster {
  readonly history: AgentState[];
  /** Instruction names of every transaction that reached the cluster, landed or not. */
  readonly sends: string[] = [];
  /** Every landed transaction: its signature and how many instructions it carried. */
  readonly landed: { signature: string; name: string; instructions: TransactionInstruction[] }[] = [];
  /** What `getSignatureStatuses` answers for a landed signature; the truth by default. */
  statusOf: (sig: string) => "confirmed" | null = (sig) =>
    this.landed.some((l) => l.signature === sig) ? "confirmed" : null;
  /** Runs right after the first landing, before anyone reads: another writer, if a test wants one. */
  afterFirstLanding?: () => void;
  /** What each `sendRawTransaction` on the wire path does, in order; `"ok"` once it runs out. */
  sendOutcomes: ("ok" | "forward-then-502" | "drop-502")[] = [];
  /** Signatures whose send failed before anything was forwarded: they never land. */
  readonly dropped: string[] = [];
  /** The authority a `register_agent` landing records, for a cluster that starts with no agent. */
  registerAs?: PublicKey;
  private lagLeft = 0;
  readonly lagReads: number;

  /** `start` null: no agent yet, for `register_agent`. */
  constructor(start: AgentState | null, lagReads: number) {
    this.history = start ? [start] : [];
    this.lagReads = lagReads;
  }

  get current(): AgentState {
    return this.history[this.history.length - 1];
  }

  /** A `close_agent` landed: the state is gone, though a lagging read still shows it. */
  closed = false;

  /** The state Photon shows, `lagReads` reads behind a landing — nothing at all behind a registration. */
  read(): AgentState | undefined {
    if (this.lagLeft > 0) {
      this.lagLeft--;
      return this.closed ? this.current : this.history[this.history.length - 2];
    }
    return this.closed ? undefined : this.current;
  }

  /** A write that did not come through this client — a `Mailbox` sender, say. */
  foreignWrite(): void {
    const s = this.current;
    this.history.push({ ...s, seq: s.seq + 1n, head: sha256(new Uint8Array([...s.head, 0xf0])) });
  }

  rpc(): any {
    return {
      commitment: "confirmed",
      getCompressedAccount: async () => {
        const state = this.read();
        if (!state) return null;
        return {
          hash: { toArray: () => Array.from(state.head) },
          treeInfo: TREE,
          leafIndex: Number(state.seq),
          address: Array.from(new Uint8Array(32).fill(1)),
          data: { data: encodeState(state), discriminator: [0, 0, 0, 0, 0, 0, 0, 0], dataHash: [] },
        };
      },
      getValidityProofV0: async (hashes: unknown[], newAddresses: unknown[]) => {
        // A non-inclusion proof for an address that now exists is refused, as Photon refuses one:
        // the read a retried `register_agent` makes first.
        if (hashes.length === 0 && newAddresses.length > 0 && this.history.length > 0) {
          throw new Error("failed to get validity proof for addresses: address already exists in the tree");
        }
        return { compressedProof: null, rootIndices: [0, 0], proveByIndices: [true, true] };
      },
      getSignatureStatuses: async (sigs: string[]) => ({
        context: { slot: 1 },
        value: sigs.map((s) =>
          this.statusOf(s) ? { slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" } : null
        ),
      }),
    };
  }

  /**
   * Decodes, checks and applies one transaction, landing it under `signature`. A transaction built
   * on a `current` the chain has moved past is refused the way a node refuses a spent account hash,
   * and a `register_agent` for an agent that exists the way it refuses an address already taken.
   */
  apply(tx: Transaction, signature: string, program: LathClient["program"]): void {
    const ix = tx.instructions[tx.instructions.length - 1];
    // `BorshInstructionCoder` has `decode`; the `InstructionCoder` interface it is typed as does not.
    const decoded = (program.coder.instruction as any).decode(ix.data);
    const name: string = decoded.name;
    this.sends.push(name);
    const args = decoded.data;
    if (name === "registerAgent" || name === "register_agent") {
      if (this.history.length > 0) {
        throw new Error("Transaction simulation failed: Error processing Instruction 1: AddressAlreadyExists");
      }
      this.history.push({
        authority: this.registerAs!,
        agentId: Uint8Array.from(field(args, "agentId", "agent_id")),
        seq: 0n,
        head: GENESIS_HEAD,
        createdAt: 0n,
        updatedAt: 0n,
      });
      this.lagLeft = this.lagReads;
      this.landed.push({ signature, name, instructions: tx.instructions });
      return;
    }
    const cur = this.current;
    const current = args.current;
    if (
      this.closed ||
      BigInt(current.seq.toString()) !== cur.seq ||
      !Buffer.from(current.head).equals(Buffer.from(cur.head)) ||
      // The authority is hashed into the account too, so a rebuild on the pre-rotation state
      // spends a hash the rotation already spent.
      !new PublicKey(current.authority).equals(cur.authority)
    ) {
      // What a transaction built on a stale `current` meets: the account hash it spends is gone.
      throw new Error("Transaction simulation failed: Error processing Instruction 1: ProofVerificationFailed");
    }
    let next: AgentState;
    if (name === "commitEpoch" || name === "commit_epoch") {
      const start = BigInt(field(args, "startSeq", "start_seq").toString());
      const end = BigInt(field(args, "endSeq", "end_seq").toString());
      if (start !== cur.seq) throw new Error("Error Code: EpochSeqMismatch");
      const root = Uint8Array.from(field(args, "epochRoot", "epoch_root"));
      next = { ...cur, seq: end, head: computeEpochHead(cur.head, cur.agentId, root, start, end) };
    } else if (name === "logEventCompact" || name === "log_event_compact") {
      const i = args.input;
      const input: EventInput = {
        timestamp: BigInt(i.timestamp.toString()),
        kind: i.kind,
        status: i.status,
        reference: Uint8Array.from(i.reference),
        payloadHash: Uint8Array.from(field(i, "payloadHash", "payload_hash")),
      };
      next = { ...cur, seq: cur.seq + 1n, head: computeHead(cur.head, cur.agentId, cur.seq, input) };
    } else if (name === "setAuthority" || name === "set_authority") {
      next = { ...cur, authority: new PublicKey(field(args, "newAuthority", "new_authority")) };
    } else if (name === "closeAgent" || name === "close_agent") {
      this.closed = true;
      this.lagLeft = this.lagReads;
      this.landed.push({ signature, name, instructions: tx.instructions });
      return;
    } else {
      throw new Error(`the fake cluster does not apply ${name}`);
    }
    this.history.push(next);
    this.lagLeft = this.lagReads;
    this.landed.push({ signature, name, instructions: tx.instructions });
  }

  /** Replaces `client.send`: decode, check, apply, and lose the first confirmation. */
  attach(client: LathClient): void {
    (client as any).stateTree = TREE;
    (client as any).send = async (tx: Transaction): Promise<string> => {
      const signature = `sig-${this.landed.length + 1}`;
      this.apply(tx, signature, client.program);
      if (this.landed.length === 1) {
        this.afterFirstLanding?.();
        throw Object.assign(
          new Error(
            `confirmation of ${signature} unknown: the RPC answered only transient errors for 180000 ms (last: 429 Too Many Requests)`
          ),
          { signature, confirmationUnknown: true }
        );
      }
      return signature;
    };
  }

  /**
   * Leaves `client.send` real, so the transaction is signed, serialized and handed to this
   * cluster's `sendRawTransaction` (`wire`), which fails as `sendOutcomes` says.
   */
  wire(client: LathClient): void {
    (client as any).stateTree = TREE;
    this.program = client.program;
  }

  private program?: LathClient["program"];

  /** The send path's half of the RPC, for a client left with its own `send` (`wire`). */
  wireRpc(): any {
    return {
      ...this.rpc(),
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1_000,
      }),
      // Past every blockhash handed out: a transaction the cluster does not have reads as expired.
      getBlockHeight: async () => 2_000,
      sendRawTransaction: async (raw: Uint8Array): Promise<string> => {
        const tx = Transaction.from(raw);
        const signature = bs58.encode(tx.signature!);
        const outcome = this.sendOutcomes.shift() ?? "ok";
        if (outcome === "drop-502") {
          this.dropped.push(signature);
          throw new Error("502 Bad Gateway: upstream connect error");
        }
        this.apply(tx, signature, this.program!);
        if (outcome === "forward-then-502") throw new Error("502 Bad Gateway: upstream request timeout");
        return signature;
      },
    };
  }
}

const CHAIN_ID = idFromString("in-doubt-agent");

function inDoubtSetup(lagReads: number, startSeq = 40n) {
  const authority = Keypair.generate();
  const start: AgentState = {
    authority: authority.publicKey,
    agentId: CHAIN_ID,
    seq: startSeq,
    head: sha256(new Uint8Array([Number(startSeq)])),
    createdAt: 0n,
    updatedAt: 0n,
  };
  const cluster = new FakeCluster(start, lagReads);
  const client = LathClient.fromIdl(cluster.rpc(), authority, { retryDelayMs: 1, maxRetries: 3, indexerWaitMs: 0 });
  cluster.attach(client);
  return { cluster, client };
}

function step(i: number): EventInput {
  return {
    timestamp: 1_700_000_000_000n + BigInt(i),
    kind: EventKind.Action,
    status: 200,
    reference: new Uint8Array(32),
    payloadHash: sha256(new Uint8Array([i])),
  };
}

/** A charge instruction's stand-in: nothing reads it but the count of landed debits. */
const CHARGE = new TransactionInstruction({
  programId: new PublicKey(new Uint8Array(32).fill(9)),
  keys: [],
  data: Buffer.from([1]),
});
const debits = (cluster: FakeCluster) =>
  cluster.landed.filter((l) => l.instructions.some((ix) => ix.programId.equals(CHARGE.programId))).length;

describe("a landed write whose confirmation was lost is not written twice", () => {
  for (const lagReads of [0, 1, 2]) {
    it(`createEpochCommitter commits [40,52) once, with the indexer ${lagReads} read(s) behind`, async () => {
      const { cluster, client } = inDoubtSetup(lagReads);
      const inputs = Array.from({ length: 12 }, (_, i) => step(i));
      const commit = await client.createEpochCommitter(CHAIN_ID, new MemoryEpochStore())(inputs);

      assert.equal(cluster.landed.length, 1, "exactly one commit landed");
      assert.equal(cluster.current.seq, 52n, "the batch is on chain once, not at [52,64) as well");
      assert.equal(commit.startSeq, 40n);
      assert.equal(commit.endSeq, 52n);
      assert.equal(commit.signature, "sig-1");
      assert.equal(Buffer.from(commit.head).toString("hex"), Buffer.from(cluster.current.head).toString("hex"));
    });

    it(`logEventInput with a charge lands once, with the indexer ${lagReads} read(s) behind`, async () => {
      const { cluster, client } = inDoubtSetup(lagReads);
      const result = await client.logEventInput(CHAIN_ID, step(0), true, [CHARGE]);

      assert.equal(cluster.landed.length, 1, "one transaction landed");
      assert.equal(debits(cluster), 1, "so the user was debited once");
      assert.equal(cluster.current.seq, 41n);
      assert.equal(result.seq, 40n);
      assert.equal(result.signature, "sig-1");
    });
  }

  it("a lag that outlasts every attempt is settled by signature before the error is thrown", async () => {
    // Each rebuild spends the state hash the landed write already spent, so each one fails; the
    // last look `withRetry` takes over history is what finds the landing.
    const { cluster, client } = inDoubtSetup(50);
    const result = await client.logEventInput(CHAIN_ID, step(0), true, [CHARGE]);

    assert.equal(debits(cluster), 1);
    assert.equal(cluster.current.seq, 41n);
    assert.equal(result.signature, "sig-1");
    assert.isAbove(cluster.sends.length, 1, "the rebuilds were sent and refused, not landed");
  });

  it("another writer past our landing: a confirmed signature is the answer, and nothing is resent", async () => {
    const { cluster, client } = inDoubtSetup(0);
    cluster.afterFirstLanding = () => cluster.foreignWrite();
    const result = await client.logEventInput(CHAIN_ID, step(0), true, [CHARGE]);

    assert.equal(result.signature, "sig-1");
    assert.equal(result.seq, 40n);
    assert.lengthOf(cluster.sends, 1, "nothing was resent");
    assert.equal(cluster.current.seq, 42n, "our write and the foreign one, nothing else");
  });

  it("another writer past our landing: an unconfirmed signature rebuilds on the new state (no false positive)", async () => {
    const { cluster, client } = inDoubtSetup(0);
    cluster.afterFirstLanding = () => cluster.foreignWrite();
    cluster.statusOf = () => null;
    const result = await client.logEventInput(CHAIN_ID, step(0), true, [CHARGE]);

    assert.equal(result.signature, "sig-2", "state alone never claims a write it cannot see");
    assert.equal(result.seq, 42n, "rebuilt on the state the other writer left");
    assert.equal(cluster.current.seq, 43n);
  });
});

/** `inDoubtSetup` with the client's own `send`: signed, serialized and failed on the wire. */
function wireSetup(lagReads: number, sendOutcomes: FakeCluster["sendOutcomes"], start: bigint | null = 40n) {
  const authority = Keypair.generate();
  const cluster = new FakeCluster(
    start === null
      ? null
      : {
          authority: authority.publicKey,
          agentId: CHAIN_ID,
          seq: start,
          head: sha256(new Uint8Array([Number(start)])),
          createdAt: 0n,
          updatedAt: 0n,
        },
    lagReads
  );
  cluster.sendOutcomes = sendOutcomes;
  cluster.registerAs = authority.publicKey;
  const client = LathClient.fromIdl(cluster.wireRpc(), authority, { retryDelayMs: 1, maxRetries: 3, indexerWaitMs: 0 });
  cluster.wire(client);
  return { cluster, client };
}

/**
 * A `send` that took the signature from `sendRawTransaction`'s answer would let a send that failed
 * after the RPC forwarded the transaction — a 502 or 504 from a gateway that timed out on the node
 * — reach `withRetry` with no signature, put nothing into the in-doubt ledger, and have the rebuild
 * on the advanced chain land the same record a second time (with its charge), or recommit the
 * epoch's steps at the new seq. The transaction here is the real one: signed by the client, put on
 * the wire, and decoded back out of the bytes by the fake cluster.
 */
describe("a write whose send failed after it was forwarded is not written twice", () => {
  for (const lagReads of [0, 1, 2]) {
    it(`logEventInput with a charge lands once after a 502, with the indexer ${lagReads} read(s) behind`, async () => {
      const { cluster, client } = wireSetup(lagReads, ["forward-then-502"]);
      const result = await client.logEventInput(CHAIN_ID, step(0), true, [CHARGE]);

      assert.equal(cluster.landed.length, 1, "one transaction landed, not two");
      assert.equal(debits(cluster), 1, "so the user was debited once");
      assert.equal(cluster.current.seq, 41n);
      assert.equal(result.seq, 40n);
      assert.equal(result.signature, cluster.landed[0].signature, "named by the signature that landed");
    });

    it(`createEpochCommitter commits [40,52) once after a 502, with the indexer ${lagReads} read(s) behind`, async () => {
      const { cluster, client } = wireSetup(lagReads, ["forward-then-502"]);
      const inputs = Array.from({ length: 12 }, (_, i) => step(i));
      const commit = await client.createEpochCommitter(CHAIN_ID, new MemoryEpochStore())(inputs);

      assert.equal(cluster.landed.length, 1, "exactly one commit landed, not [52,64) as well");
      assert.equal(cluster.current.seq, 52n);
      assert.equal(commit.startSeq, 40n);
      assert.equal(commit.signature, cluster.landed[0].signature);
    });
  }

  it("names the rebuild that landed, not the dropped send or the refused one that share its (seq, head)", async () => {
    // The first send never left the gateway; the rebuild landed and its answer was lost; the next
    // rebuild, let through by a lagging indexer, was refused over the spent state hash. All three
    // lead to seq 41 under one head, so the state alone cannot say which is on chain.
    const { cluster, client } = wireSetup(2, ["drop-502", "forward-then-502"]);
    const result = await client.logEventInput(CHAIN_ID, step(0), true, [CHARGE]);

    assert.equal(cluster.landed.length, 1);
    assert.equal(debits(cluster), 1);
    assert.lengthOf(cluster.dropped, 1);
    assert.equal(result.signature, cluster.landed[0].signature, "the cluster was asked which one landed");
    assert.notEqual(result.signature, cluster.dropped[0]);
  });

  it("a send that never left still builds again at once, on the same state hash", async () => {
    const { cluster, client } = wireSetup(0, ["drop-502"]);
    const result = await client.logEventInput(CHAIN_ID, step(0), true, [CHARGE]);

    assert.equal(cluster.landed.length, 1);
    assert.equal(result.seq, 40n, "built on the state the dropped send was built on");
    assert.equal(result.signature, cluster.landed[0].signature);
  });
});

/**
 * Without an in-doubt ledger in `registerAgent`, a registration that landed while its answer was
 * lost would be retried as if nothing had: the retry's non-inclusion proof for the now-taken
 * address would be refused, the deploy fail, and the next deploy find a header it could not adopt
 * — the name spent for good. The cluster starts with no agent; `register_agent` creates it.
 */
describe("a registration whose answer was lost is found by its signature", () => {
  it("returns the registration that landed when the send failed after forwarding", async () => {
    const { cluster, client } = wireSetup(0, ["forward-then-502"], null);
    const result = await client.registerAgent(CHAIN_ID);

    assert.equal(cluster.landed.length, 1, "registered once");
    assert.equal(result.signature, cluster.landed[0].signature);
    assert.equal(result.address.toBase58(), client.agentAddress(CHAIN_ID).toBase58());
  });

  it("settles by signature when the retry's proof is refused because the address is now taken", async () => {
    // The cluster has not confirmed it when the second attempt asks, so that attempt goes on to the
    // proof, which Photon refuses for an address that exists; `withRetry`'s last look finds it.
    const { cluster, client } = wireSetup(0, ["forward-then-502"], null);
    let reads = 0;
    cluster.statusOf = (sig) => (++reads > 1 && cluster.landed.some((l) => l.signature === sig) ? "confirmed" : null);
    const result = await client.registerAgent(CHAIN_ID);

    assert.equal(cluster.landed.length, 1);
    assert.equal(result.signature, cluster.landed[0].signature);
    assert.isAbove(reads, 1, "asked before the proof, and again after it was refused");
  });

  it("never adopts a header no confirmed signature of this call accounts for", async () => {
    // The header is on chain, and it is even this call's — but the cluster never says so by
    // signature, and a header read cannot tell this from someone else's orphan.
    const { cluster, client } = wireSetup(0, ["forward-then-502"], null);
    cluster.statusOf = () => null;
    let error: unknown;
    await client.registerAgent(CHAIN_ID).catch((e) => (error = e));
    assert.match(String((error as Error)?.message), /address already exists/);
  });
});

/**
 * `setAuthority` and `closeAgent` keep an in-doubt ledger too. Without one, a rotation that landed
 * behind a 502 and was read back stale would fail the post-send check as "not landed"; the next
 * attempt would read the rotated state and be refused as "client authority does not own this
 * agent", which is not retryable, and the caller would be told the rotation failed after it
 * happened. A close would go the same way, as "not registered".
 */
describe("a rotation or close whose answer was lost is found by its signature", () => {
  it("setAuthority returns the rotation that landed behind a 502, and sends it once", async () => {
    const { cluster, client } = wireSetup(1, ["forward-then-502"]);
    const next = Keypair.generate().publicKey;
    const result = await client.setAuthority(CHAIN_ID, next);

    assert.lengthOf(cluster.landed, 1);
    assert.equal(result.signature, cluster.landed[0].signature);
    assert.isTrue(cluster.current.authority.equals(next));
    assert.lengthOf(cluster.sends, 1, "the next attempt asked by signature instead of rebuilding");
  });

  it("closeAgent returns the close that landed behind a 502", async () => {
    const { cluster, client } = wireSetup(1, ["forward-then-502"]);
    const result = await client.closeAgent(CHAIN_ID);

    assert.isTrue(cluster.closed);
    assert.lengthOf(cluster.landed, 1);
    assert.equal(result.signature, cluster.landed[0].signature);
    assert.equal(result.finalSeq, 40n);
  });

  it("settles by signature at the last look when the cluster confirms only after the refusal", async () => {
    // Not confirmed when the second attempt asks, which then reads the rotated state and is
    // refused as not owning the agent; `withRetry`'s last look over the ledger finds the landing.
    const { cluster, client } = wireSetup(1, ["forward-then-502"]);
    let reads = 0;
    cluster.statusOf = (sig) => (++reads > 1 && cluster.landed.some((l) => l.signature === sig) ? "confirmed" : null);
    const result = await client.setAuthority(CHAIN_ID, Keypair.generate().publicKey);

    assert.equal(result.signature, cluster.landed[0].signature);
    assert.isAbove(reads, 1);
  });

  it("still fails a rotation no confirmed signature accounts for", async () => {
    const { cluster, client } = wireSetup(1, ["forward-then-502"]);
    cluster.statusOf = () => null;
    let error: unknown;
    await client.setAuthority(CHAIN_ID, Keypair.generate().publicKey).catch((e) => (error = e));
    assert.match(String((error as Error)?.message), /does not own this agent/);
  });

  it("a read after a confirmed rotation or close waits for the indexer to show it", async () => {
    for (const op of ["rotate", "close"] as const) {
      const { cluster, client } = wireSetup(2, []);
      (client as any).indexerWaitMs = 10_000;
      const next = Keypair.generate().publicKey;
      if (op === "rotate") await client.setAuthority(CHAIN_ID, next);
      else await client.closeAgent(CHAIN_ID);
      const after = await client.getAgentState(CHAIN_ID);
      if (op === "rotate") assert.isTrue(after!.state.authority.equals(next), "not the pre-rotation read");
      else assert.isNull(after, "not the pre-close read");
      assert.isTrue(op === "close" ? cluster.closed : cluster.current.authority.equals(next));
    }
  });
});

describe("the epoch span bound", () => {
  it("accepts exactly u32::MAX steps and refuses one more", () => {
    assert.equal(MAX_EPOCH_SPAN, 0xffff_ffffn);
    assertEpochSpan(40n, 40n + MAX_EPOCH_SPAN);
    assert.throws(() => assertEpochSpan(40n, 40n + MAX_EPOCH_SPAN + 1n), /spans 4294967296 steps/);
    assert.throws(() => assertEpochSpan(40n, 40n), /empty/);
    assert.throws(() => assertEpochSpan(40n, 39n), /empty/);
  });

  it("commitEpoch refuses an over-long span before reading or sending anything", async () => {
    const { cluster, client } = inDoubtSetup(0);
    try {
      await client.commitEpoch(CHAIN_ID, sha256(new Uint8Array([1])), 40n, 40n + 2n ** 32n);
      assert.fail("an epoch no reader could open must not be sent");
    } catch (e) {
      assert.match(String((e as Error).message), /spans 4294967296 steps/);
    }
    assert.lengthOf(cluster.sends, 0);
    assert.equal(cluster.current.seq, 40n);
  });
});

/**
 * Of two in-doubt attempts that fold to the head the chain shows, a `whichLanded` that answered the
 * earliest whenever none read `confirmed` would let an indexer that ran ahead of the status name
 * the attempt that was dropped. The attempts spend one state hash, so a status
 * without an error is the one that executed, even at `processed`.
 */
describe("the landed attempt is named by its status, not by its place in the ledger", () => {
  const status = (s: { err?: unknown; confirmationStatus?: string } | null) =>
    s && { slot: 1, confirmations: null, err: s.err ?? null, confirmationStatus: s.confirmationStatus };
  const attempts = ["sig-dropped", "sig-landed"].map((signature) => ({ signature }));
  const client = (value: unknown[] | Error) =>
    new LathClient(
      {
        getSignatureStatuses: async () => {
          if (value instanceof Error) throw value;
          return { context: { slot: 1 }, value };
        },
      } as any,
      { programId: PROGRAM_ID } as any,
      Keypair.generate()
    ) as any;

  it("answers a confirmed attempt over an earlier one", async () => {
    const c = client([null, status({ confirmationStatus: "confirmed" })]);
    assert.equal((await c.whichLanded(attempts)).signature, "sig-landed");
  });

  it("answers the attempt the node saw execute, at processed, over an earlier one it never saw", async () => {
    const c = client([null, status({ confirmationStatus: "processed" })]);
    assert.equal((await c.whichLanded(attempts)).signature, "sig-landed");
  });

  it("never answers an attempt that failed while another executed", async () => {
    const c = client([
      status({ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }),
      status({ confirmationStatus: "processed" }),
    ]);
    assert.equal((await c.whichLanded(attempts)).signature, "sig-landed");
  });

  it("answers the earliest when the statuses name none, or cannot be read", async () => {
    assert.equal((await client([null, null]).whichLanded(attempts)).signature, "sig-dropped");
    assert.equal((await client(new Error("410 Gone")).whichLanded(attempts)).signature, "sig-dropped");
  });
});
