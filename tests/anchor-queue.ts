import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  Bytes32,
  computeEpochHead,
  computeHead,
  decodeEpochBlob,
  epochRootOf,
  EventKind,
  hex,
  idFromString,
  toEventInput,
  ZERO32,
} from "../sdk/src";
import {
  AgentRuntime,
  AnchorEntry,
  AnchorEpochEntry,
  AnchorEventEntry,
  AnchorFailed,
  AnchorQueue,
  AnchorEvent,
  DiscardRefused,
  ChatResult,
  FileAnchorJournal,
  MemoryAnchorJournal,
  NoopBilling,
  RuntimeEvent,
  serializeEventInput,
} from "../runtime/src";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";
import { RecordedTransport } from "./fixtures/recorded-transport";

/**
 * The writer queue behind an interactive-first session, against the in-memory chain in
 * `fixtures/fake-chain.ts`. No validator and no RPC: what is under test is ordering, the head
 * check and the three states, all of which are the queue's own logic.
 */

const AGENT = idFromString("anchor-queue-agent");
const USER = new PublicKey("11111111111111111111111111111112");

function action(toolId: string) {
  return {
    kind: EventKind.Action as const,
    toolId,
    argsHash: idFromString(`${toolId}:args`),
    resultHash: idFromString(`${toolId}:result`),
    statusCode: 200,
  };
}

function queueOn(chain: FakeChain, opts: Partial<ConstructorParameters<typeof AnchorQueue>[0]> = {}) {
  const events: AnchorEvent[] = [];
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    onEvent: (e) => events.push(e),
    // The fake chain never lags unless told to, and a test's retry should not wait a second.
    indexerWaitMs: 200,
    retryDelayMs: 5,
    ...opts,
  });
  return { queue, events };
}

describe("anchor queue", () => {
  it("journals a record with its local head and confirms the run in seq order", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue, events } = queueOn(chain);

    const logged = [];
    for (const id of ["a", "b", "c"]) logged.push(await queue.logEvent(AGENT, action(id), { timestamp: 1 }));

    // The answer is already given at this point: every record has its seq and its head, and no
    // transaction has been sent.
    assert.deepEqual(
      logged.map((r) => r.seq.toString()),
      ["0", "1", "2"]
    );
    assert.deepEqual(
      logged.map((r) => r.signature),
      ["", "", ""],
      "a journaled record has no signature yet"
    );

    await queue.drain(AGENT);

    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0", "1", "2"],
      "one entry in flight, in journal order"
    );
    assert.equal(hex(chain.state(AGENT)!.head), hex(logged[2].head), "the chain folded to the head we predicted");
    assert.equal(queue.pending(AGENT).length, 0);
    assert.deepEqual(
      events.filter((e) => e.state === "verified").map((e) => e.seq),
      ["0", "1", "2"]
    );
    assert.isTrue(
      events.filter((e) => e.state === "verified").every((e) => !!e.signature),
      "the real signature arrives on the verified transition"
    );
  });

  it("marks a lost confirmation verified by the head check instead of writing it twice", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain);

    chain.loseNext(1); // applied on chain, then thrown at the caller
    await queue.logEvent(AGENT, action("a"), { timestamp: 1 });
    await queue.logEvent(AGENT, action("b"), { timestamp: 1 });
    await queue.drain(AGENT);

    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0", "1"],
      "the lost record was not appended a second time"
    );
    assert.equal(chain.state(AGENT)!.seq, 2n);
  });

  it("fails an entry after maxAttempts, halts the agent, and rejects the drain", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue, events } = queueOn(chain, { maxAttempts: 3 });

    chain.failNext(4);
    await queue.logEvent(AGENT, action("a"), { timestamp: 1 });
    await queue.logEvent(AGENT, action("b"), { timestamp: 1 });

    let failure: unknown;
    await queue.drain(AGENT).catch((e) => (failure = e));
    assert.instanceOf(failure, AnchorFailed, "the drain says which entry is stuck, not just that one is");
    assert.equal(queue.failed(AGENT).length, 1);
    assert.equal(queue.failed(AGENT)[0].attempts, 3);
    assert.equal(chain.applied.length, 0);
    assert.equal(queue.pending(AGENT).length, 1, "the entry behind it is untouched: the queue halted, it did not skip");
    assert.equal(events.filter((e) => e.state === "failed").length, 1);
  });

  it("retry puts the failed entry back under a head check and the queue resumes in order", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { maxAttempts: 1 });

    chain.failNext(1);
    const first = await queue.logEvent(AGENT, action("a"), { timestamp: 1 });
    await queue.logEvent(AGENT, action("b"), { timestamp: 1 });
    await queue.drain(AGENT).catch(() => undefined);
    assert.equal(queue.failed(AGENT).length, 1);

    await queue.retry(AGENT);
    await queue.drain(AGENT);

    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0", "1"]
    );
    assert.equal(chain.applied[0].head, hex(first.head), "the retried record kept the head it was journaled with");
    assert.equal(queue.failed(AGENT).length, 0);
  });

  it("fails an entry whose head the chain did not confirm, and halts rather than reordering", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain);

    // Another signer takes the seq this entry was journaled at, between the journal and the
    // send. One session per agent is what rules this out in normal operation; when it happens
    // the queue must stop, not adapt.
    chain.beforeWrite = () => {
      chain.beforeWrite = undefined;
      chain.foreignWrite(AGENT, toEventInput(action("outsider"), 1));
    };
    const entry = await queue.logEvent(AGENT, action("a"), { timestamp: 1 });

    let failure: unknown;
    await queue.drain(AGENT).catch((e) => (failure = e));
    assert.instanceOf(failure, AnchorFailed);
    const failed = queue.failed(AGENT)[0];
    assert.equal(failed.attempts, 1, "a diverged head is not retried: nothing about a resend would fix it");
    assert.include(failed.error ?? "", "head diverged");
    assert.notEqual(hex(chain.state(AGENT)!.head), hex(entry.head));
  });

  it("refuses to resend an entry whose seq the chain has moved past, so nothing lands twice", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    // A long enough backoff that the outside write below lands between the two attempts.
    const { queue } = queueOn(chain, { retryDelayMs: 200 });

    // First attempt fails without touching the chain; before the retry, a write the queue never
    // saw takes the entry's seq. On devnet this was the runtime's own cell writes, and the
    // retry landed a second genesis one seq later before the head was ever compared.
    chain.failNext(1);
    await queue.logEvent(AGENT, action("a"), { timestamp: 1 });
    await new Promise((r) => setTimeout(r, 20));
    chain.foreignWrite(AGENT, toEventInput(action("outsider"), 2));

    let failure: unknown;
    await queue.drain(AGENT).catch((e) => (failure = e));
    assert.instanceOf(failure, AnchorFailed);
    assert.include(queue.failed(AGENT)[0].error ?? "", "head diverged");
    assert.equal(chain.applied.length, 1, "the outsider's record is the only one on the chain");
    assert.equal(chain.state(AGENT)!.seq, 1n);
  });

  it("discards a diverged journal to a side file, leaving the chain untouched and writable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-discard-"));
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();
    const { queue } = queueOn(chain, { journal: new FileAnchorJournal(dir), billing, maxAttempts: 1 });

    // The charge refused, so the record never went out and nothing moved; then a write the queue
    // never saw takes the seq the record was built for — a locator cell written straight to the chain.
    billing.failNext(1);
    const lost = await queue.logEvent(AGENT, action("a"), {
      timestamp: 1,
      charge: { user: USER, amountMicroUsdc: 1320n },
    });
    await queue.drain(AGENT).catch(() => undefined);
    chain.foreignWrite(AGENT, toEventInput(action("outsider"), 2));
    const applied = chain.applied.length;
    const tip = { ...chain.state(AGENT)! };

    const result = await queue.discard(AGENT);
    assert.equal(chain.applied.length, applied, "a discard writes nothing to the chain");
    assert.equal(chain.state(AGENT)!.seq, tip.seq);
    assert.lengthOf(result.dropped, 1);
    assert.equal((result.dropped[0] as AnchorEventEntry).head, hex(lost.head));
    assert.equal(result.unbilledMicroUsdc, 1320n, "the record's charge never moved");
    assert.equal(result.chargedMicroUsdc, 0n);
    assert.include(result.reason, "head diverged");
    assert.isEmpty(billing.charges);

    const file = path.join(dir, "pending", `${hex(AGENT)}.json`);
    assert.isFalse(fs.existsSync(file), "the journal is empty, so it is gone");
    assert.deepEqual(await new FileAnchorJournal(dir).load(hex(AGENT)), []);
    const side = JSON.parse(fs.readFileSync(result.file!, "utf8"));
    assert.equal(side.entries.length, 1, "what was dropped is recorded, not silent");
    assert.equal(side.entries[0].head, hex(lost.head));
    assert.equal(side.chain.seq, tip.seq.toString());
    assert.isEmpty(await queue.carried(AGENT));

    // And the chain writes again, from where it actually stands.
    const next = await queue.logEvent(AGENT, action("b"), { timestamp: 3 });
    await queue.drain(AGENT);
    assert.equal(next.seq, tip.seq);
    assert.equal(hex(chain.state(AGENT)!.head), hex(next.head));
  });

  it("refuses to discard a queue that merely failed, because Retry lands it", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { maxAttempts: 1 });

    chain.failNext(1);
    const record = await queue.logEvent(AGENT, action("a"), { timestamp: 1 });
    await queue.drain(AGENT).catch(() => undefined);
    assert.lengthOf(queue.failed(AGENT), 1);

    let refused: unknown;
    await queue.discard(AGENT).catch((e) => (refused = e));
    assert.instanceOf(refused, DiscardRefused);
    assert.include((refused as Error).message, "Retry");
    assert.lengthOf(queue.failed(AGENT), 1, "the entry is still owed, exactly as it was");

    await queue.retry(AGENT);
    await queue.drain(AGENT);
    assert.equal(hex(chain.state(AGENT)!.head), hex(record.head));
  });

  it("refuses to discard a record that landed and only lost its confirmation", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { maxAttempts: 1 });

    chain.loseNext(1);
    await queue.logEvent(AGENT, action("a"), { timestamp: 1 });
    await queue.drain(AGENT).catch(() => undefined);
    assert.lengthOf(queue.failed(AGENT), 1);

    let refused: unknown;
    await queue.discard(AGENT).catch((e) => (refused = e));
    assert.instanceOf(refused, DiscardRefused);
    assert.include((refused as Error).message, "landed");
  });

  it("waits for the indexer to show a write it was told about before trusting a read", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { indexerWaitMs: 2_000 });

    // A synchronous write outside the queue, reported through `expect`; the next two reads
    // still show the state before it, the way Photon does for a moment after a confirmation.
    chain.foreignWrite(AGENT, toEventInput(action("cell"), 1));
    await queue.expect(AGENT, 1n);
    chain.lagReads(2);
    const tip = await queue.tip(AGENT);
    assert.equal(tip.seq, 1n, "the tip is the state after the write, not the lagging read");
    assert.equal(hex(tip.head), hex(chain.state(AGENT)!.head));

    // And an entry journaled from that tip lands where it said it would.
    await queue.logEvent(AGENT, action("a"), { timestamp: 2 });
    await queue.drain(AGENT);
    assert.equal(chain.state(AGENT)!.seq, 2n);
    assert.equal(chain.applied.length, 2);
  });

  it("treats a chain the indexer shows short as behind, and retries rather than writing", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { indexerWaitMs: 50 });

    chain.foreignWrite(AGENT, toEventInput(action("cell"), 1));
    await queue.expect(AGENT, 1n);
    const entry = await queue.logEvent(AGENT, action("a"), { timestamp: 2 });
    // The guard's read lags past the short wait: the entry is not sent against seq 0, it waits.
    chain.lagReads(3);
    await queue.drain(AGENT);
    const done = queue.pending(AGENT).length === 0 && queue.failed(AGENT).length === 0;
    assert.isTrue(done);
    assert.equal(chain.applied.length, 2, "one outside write, one from the queue, no duplicate");
    assert.equal(chain.state(AGENT)!.seq, 2n);
    assert.equal(hex(chain.state(AGENT)!.head), hex(entry.head));
  });

  it("journals a record behind a pending epoch lazily, and places it after the cells the epoch writes", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue, events } = queueOn(chain);

    // Genesis fails its first attempt so the epoch is still pending when the resolution is
    // journaled. The epoch's verified hook writes a cell straight to
    // the chain, the way the locator registry does, so the resolution's provisional seq is taken.
    chain.failNext(1);
    await queue.logEvent(AGENT, action("genesis"), { timestamp: 1 });
    const steps = [toEventInput(action("s1"), 2), toEventInput(action("s2"), 3)];
    const startSeq = 1n;
    const root = epochRootOf(startSeq, steps);
    const epochHead = computeEpochHead(
      computeHead(ZERO32, AGENT, 0n, toEventInput(action("genesis"), 1)),
      AGENT,
      root,
      startSeq,
      3n
    );
    await queue.enqueue(
      {
        kind: "epoch",
        agentId: hex(AGENT),
        startSeq: startSeq.toString(),
        endSeq: "3",
        prevHead: hex(computeHead(ZERO32, AGENT, 0n, toEventInput(action("genesis"), 1))),
        head: hex(epochHead),
        epochRoot: hex(root),
      },
      { onVerified: async () => chain.foreignWrite(AGENT, toEventInput(action("locator-cell"), 4)) }
    );
    const resolution = await queue.logEvent(AGENT, action("resolution"), { timestamp: 5 });
    assert.equal(resolution.seq, 3n, "provisional: the seq right after the epoch");
    const journaled = queue.pending(AGENT).find((e) => e.kind === "event" && e.seq === "3");
    assert.isTrue((journaled as any)?.lazy, "journaled behind a pending epoch, so lazy");

    await queue.drain(AGENT);
    assert.equal(queue.failed(AGENT).length, 0);
    const last = chain.applied[chain.applied.length - 1];
    assert.equal(last.kind, "event");
    assert.equal(last.seq, "4", "the resolution took the seq after the epoch's cell, not the one it guessed");
    assert.equal(chain.state(AGENT)!.seq, 5n);
    const verified = events.filter((e) => e.state === "verified" && e.kind === "event");
    assert.equal(verified[verified.length - 1].seq, "4", "the verified transition carries the real seq");
    assert.equal(verified[verified.length - 1].head, hex(chain.state(AGENT)!.head));
  });

  it("charges through the billing backend in order, and composes a record's own charge", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();
    const { queue } = queueOn(chain, { billing });

    await queue.enqueue({
      kind: "charge",
      agentId: hex(AGENT),
      user: USER.toBase58(),
      amountMicroUsdc: "1200",
    });
    await queue.logEvent(AGENT, action("llm.step"), {
      timestamp: 1,
      charge: { user: USER, amountMicroUsdc: 3400n },
    });
    await queue.drain(AGENT);

    assert.deepEqual(
      billing.charges.map((c) => c.amountMicroUsdc),
      ["1200", "3400"],
      "the standalone charge goes first, then the one the record carries"
    );
    assert.equal(chain.applied.length, 1, "a charge entry is not a record");
    assert.deepEqual(chain.instructionCounts, [0], "a backend without `chargeIx` charges on its own transaction");
  });

  it("a charge with no head is resent when it has no signature, and never after it has one", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();
    const { queue } = queueOn(chain, { billing, maxAttempts: 3 });

    billing.failNext(1);
    await queue.enqueue({ kind: "charge", agentId: hex(AGENT), user: USER.toBase58(), amountMicroUsdc: "500" });
    await queue.drain(AGENT);

    assert.deepEqual(
      billing.charges.map((c) => c.amountMicroUsdc),
      ["500"],
      "a failed charge is retried exactly once more, and once it lands it is done"
    );
  });

  it("composes every instruction a backend's chargeIxs hands back, and prefers it to chargeIx", async () => {
    // `BillingClient.chargeIxs` puts the legacy-grant repair in front of the debit; a bare
    // `chargeIx` against an older grant (no `reserved`) fails every attempt and halts the chain.
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const inert = () =>
      new TransactionInstruction({ keys: [], programId: SystemProgram.programId, data: Buffer.alloc(0) });
    let single = 0;
    const billing = {
      async chargeIxs(): Promise<TransactionInstruction[]> {
        return [inert(), inert()];
      },
      async chargeIx(): Promise<TransactionInstruction> {
        single += 1;
        return inert();
      },
      async chargeAndLog(): Promise<null> {
        throw new Error("chargeAndLog is not the anchored path");
      },
    };
    const { queue } = queueOn(chain, { billing });

    await queue.logEvent(AGENT, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 3400n } });
    await queue.drain(AGENT);

    assert.deepEqual(chain.instructionCounts, [2], "the repair and the debit, in the record's own transaction");
    assert.equal(single, 0, "chargeIx is the fallback, not asked when chargeIxs is there");
  });

  it("charges a record once through a charge-only backend, however many attempts the record takes", async () => {
    // The fallback charge runs inside `submit`, so unjournaled it would run on every attempt: three
    // attempts of one record, three debits. Its signature is journaled before the record is sent.
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();
    const updates: AnchorEntry[] = [];
    class Watching extends MemoryAnchorJournal {
      async update(entry: AnchorEntry): Promise<void> {
        updates.push(JSON.parse(JSON.stringify(entry)));
        return super.update(entry);
      }
    }
    const { queue } = queueOn(chain, { billing, maxAttempts: 3, journal: new Watching() });

    chain.failNext(2);
    await queue.logEvent(AGENT, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 1100n } });
    await queue.drain(AGENT);

    assert.deepEqual(
      billing.charges.map((c) => c.amountMicroUsdc),
      ["1100"],
      "one debit for one record"
    );
    assert.equal(chain.applied.length, 1, "and the record landed once, on its third attempt");
    const journaled = updates.filter((e) => e.kind === "event").map((e) => (e as AnchorEventEntry).charge?.signature);
    assert.include(journaled, "charge-1", "the charge's signature was written to the journal with the entry");
    assert.equal(
      journaled.indexOf("charge-1") < journaled.length - 1,
      true,
      "before the attempts that followed it, which is what stops them charging again"
    );
  });

  it("a file journal outlives the process that wrote it, and a fresh queue resumes from it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-"));
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const journal = new FileAnchorJournal(dir);

    const first = new AnchorQueue({ client: chain.asClient(), journal, maxAttempts: 1 });
    chain.failNext(1);
    const record = await first.logEvent(AGENT, action("a"), { timestamp: 1 });
    await first.drain(AGENT).catch(() => undefined);

    const file = path.join(dir, "pending", `${hex(AGENT)}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].state, "failed");
    assert.equal(onDisk[0].head, hex(record.head), "the head was computed before the write, and it is what is kept");

    // A new process: nothing in memory, everything owed still on disk.
    const second = new AnchorQueue({ client: chain.asClient(), journal: new FileAnchorJournal(dir) });
    await second.retry(AGENT);
    await second.drain(AGENT);

    assert.deepEqual(
      chain.applied.map((w) => w.head),
      [hex(record.head)],
      "the entry the first process journaled is the one the second sent"
    );
    assert.isFalse(fs.existsSync(file), "a chain that owes nothing keeps no journal");
  });

  // A rename can reach the disk before the bytes it names, so a power loss between the two would
  // leave a zero-length journal the next read refuses, wedging the queue.
  it("flushes the journal's bytes before the rename and its directory after", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-"));
    const journal = new FileAnchorJournal(dir);
    const order: string[] = [];
    const realOpen = fs.promises.open;
    const realRename = fs.promises.rename;
    (fs.promises as any).open = async (...args: Parameters<typeof realOpen>) => {
      const fh = await realOpen.apply(fs.promises, args);
      const sync = fh.sync.bind(fh);
      fh.sync = async () => {
        order.push(`sync ${path.basename(String(args[0]))}`);
        return sync();
      };
      return fh;
    };
    (fs.promises as any).rename = async (from: string, to: string) => {
      order.push(`rename ${path.basename(from).endsWith(".tmp") ? "tmp" : from}`);
      return realRename.call(fs.promises, from, to);
    };
    try {
      await journal.append({ agentId: hex(AGENT), id: "e-1", state: "pending" } as any);
    } finally {
      (fs.promises as any).open = realOpen;
      (fs.promises as any).rename = realRename;
    }
    assert.lengthOf(order, 3, order.join(", "));
    assert.match(order[0], /^sync .*\.tmp$/, "the temp file's bytes first");
    assert.equal(order[1], "rename tmp");
    assert.equal(order[2], "sync pending", "then the directory the rename is in");
  });

  it("says what a chain owes before anything is written to it, journal included", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-"));
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const journal = new FileAnchorJournal(dir);

    const first = new AnchorQueue({ client: chain.asClient(), journal, maxAttempts: 1 });
    chain.failNext(1);
    await first.logEvent(AGENT, action("a"), { timestamp: 1 });
    await first.drain(AGENT).catch(() => undefined);

    // The process that failed is gone. `pending` and `failed` read memory, so a fresh queue
    // answers nothing owed until something asks it about this chain — which is why a session
    // that reported off those two would say nothing about the records it was about to carry.
    const second = new AnchorQueue({ client: chain.asClient(), journal: new FileAnchorJournal(dir) });
    assert.lengthOf(second.pending(AGENT), 0, "memory knows nothing yet");
    assert.lengthOf(second.failed(AGENT), 0, "memory knows nothing yet");

    const carried = await second.carried(AGENT);
    assert.lengthOf(carried, 1, "the journal is loaded and the entry it holds is owed");
    assert.equal(carried[0].state, "failed");

    // And it is a plain read: asking does not send, retry, or change what is owed.
    assert.lengthOf(chain.applied, 0);
    assert.lengthOf(await second.carried(AGENT), 1);
  });

  it("owes nothing for a chain with no journal at all", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-"));
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const queue = new AnchorQueue({ client: chain.asClient(), journal: new FileAnchorJournal(dir) });
    assert.lengthOf(await queue.carried(AGENT), 0);
  });

  it("checks the head before the first entry after a load, for every entry that already landed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-"));
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);

    // A process that journaled two records, sent both, and died before either confirmation was
    // heard: the journal says `pending` for both while the chain already has them. Resending
    // either would duplicate it, which is why the head check stays armed until something is
    // actually submitted rather than only covering the first entry after the load.
    const journal = new FileAnchorJournal(dir);
    let prevHead: Bytes32 = ZERO32;
    let seq = 0n;
    for (const id of ["a", "b"]) {
      const input = toEventInput(action(id), 1);
      const head = computeHead(prevHead, AGENT, seq, input);
      await journal.append({
        kind: "event",
        id: `orphan-${id}`,
        agentId: hex(AGENT),
        seq: seq.toString(),
        prevHead: hex(prevHead),
        head: hex(head),
        input: serializeEventInput(input),
        compact: false,
        attempts: 1,
        state: "pending",
        createdAt: Date.now(),
      });
      chain.foreignWrite(AGENT, input); // the write itself landed
      prevHead = head;
      seq += 1n;
    }
    assert.equal(chain.applied.length, 2);

    const queue = new AnchorQueue({ client: chain.asClient(), journal: new FileAnchorJournal(dir) });
    await queue.drain(AGENT);

    assert.equal(chain.applied.length, 2, "both were recognised as landed; neither was written again");
    assert.equal(chain.state(AGENT)!.seq, 2n);
  });

  it("does not spend the head check on a charge, so the event behind one is still reconciled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-"));
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();

    // What a session leaves behind when the cluster refuses it: a batched step's charge in front
    // of the record it pays for, both `failed`. The record's write actually reached the chain —
    // that is the whole reason the head check exists — and the charge never got a signature.
    const journal = new FileAnchorJournal(dir);
    await journal.append({
      kind: "charge",
      id: "stuck-charge",
      agentId: hex(AGENT),
      user: USER.toBase58(),
      amountMicroUsdc: "700",
      attempts: 1,
      state: "failed",
      error: "fake billing: charge failed",
      createdAt: Date.now(),
    });
    const input = toEventInput(action("paid-step"), 1);
    await journal.append({
      kind: "event",
      id: "stuck-event",
      agentId: hex(AGENT),
      seq: "0",
      prevHead: hex(ZERO32),
      head: hex(computeHead(ZERO32, AGENT, 0n, input)),
      input: serializeEventInput(input),
      compact: false,
      attempts: 1,
      state: "failed",
      error: "fake chain: confirmation lost",
      createdAt: Date.now(),
    });
    chain.foreignWrite(AGENT, input); // the record landed; only its confirmation was lost

    // The FAILED badge, clicked: every entry goes back to `pending` at attempts 0 under one
    // armed head check, which is now the *only* thing that can reconcile them — attempts 0 means
    // the `attempts > 1` trigger never fires.
    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new FileAnchorJournal(dir),
      billing,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    await queue.retry(AGENT);
    await queue.drain(AGENT);

    // The charge is resent — it has no signature, and an unpaid step is worse than one paid
    // twice — but sending it must not disarm the check, because a charge transaction touches the
    // billing program and says nothing about `AgentState`. Disarmed, the record would be processed
    // with no reconcile, the guard would see the chain one seq past it, and a record already on
    // chain would end `head diverged`, which is never retried, and `failed` for good.
    assert.deepEqual(
      billing.charges.map((c) => c.amountMicroUsdc),
      ["700"],
      "the charge with no signature is resent"
    );
    assert.lengthOf(queue.failed(AGENT), 0, "and the record behind it was recognised as landed, not failed");
    assert.equal(chain.applied.length, 1, "nor written a second time");
    assert.equal(chain.state(AGENT)!.seq, 1n);
  });

  it("waits for a reconciled epoch's locator cell before building the record behind it", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain);

    const genesis = await queue.logEvent(AGENT, action("genesis"), { timestamp: 1 });
    await queue.drain(AGENT);

    const steps = [toEventInput(action("s1"), 2), toEventInput(action("s2"), 3)];
    const root = epochRootOf(1n, steps);
    const epochHead = computeEpochHead(genesis.head, AGENT, root, 1n, 3n);

    // The commit lands and the confirmation is lost, so the entry comes back on its second
    // attempt through `reconcile` rather than through a submit. `reconcile` is where the
    // `onVerified` hook then runs, and the hook writes a locator cell — a real chain write.
    chain.loseNext(1);
    const epoch = await queue.enqueue(
      {
        kind: "epoch",
        agentId: hex(AGENT),
        startSeq: "1",
        endSeq: "3",
        prevHead: hex(genesis.head),
        head: hex(epochHead),
        epochRoot: hex(root),
        locator: "owed",
      },
      {
        onVerified: async () => {
          // Slow on purpose: an unawaited `settle` let the pump read the chain and build the
          // record behind the epoch while the cell was still in flight, and the record then
          // took the seq the cell was about to.
          await new Promise((r) => setTimeout(r, 25));
          chain.foreignWrite(AGENT, toEventInput(action("locator-cell"), 4));
        },
      }
    );
    await queue.logEvent(AGENT, action("resolution"), { timestamp: 5 });
    await queue.drain(AGENT);

    assert.lengthOf(queue.failed(AGENT), 0);
    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0", "3", "3", "4"],
      "genesis, the epoch to endSeq 3, the locator cell at 3, and only then the resolution at 4"
    );
    assert.equal((epoch as AnchorEpochEntry).locator, "published", "the hook ran, so the debt is paid");
    assert.lengthOf(await queue.locatorsOwed(AGENT), 0);
  });

  it("journals a record lazily behind an epoch that has landed while its locator cell is still in flight", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain);

    const genesis = await queue.logEvent(AGENT, action("genesis"), { timestamp: 1 });
    await queue.drain(AGENT);
    const root = epochRootOf(1n, [toEventInput(action("s1"), 2), toEventInput(action("s2"), 3)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let hookStarted!: () => void;
    const started = new Promise<void>((r) => (hookStarted = r));
    await queue.enqueue(
      {
        kind: "epoch",
        agentId: hex(AGENT),
        startSeq: "1",
        endSeq: "3",
        prevHead: hex(genesis.head),
        head: hex(computeEpochHead(genesis.head, AGENT, root, 1n, 3n)),
        epochRoot: hex(root),
        locator: "owed",
      },
      {
        onVerified: async () => {
          hookStarted();
          await gate;
          chain.foreignWrite(AGENT, toEventInput(action("locator-cell"), 4));
        },
      }
    );
    // The epoch is on chain and `verified`; its cell is not. A tip read here says seq 3, which is
    // where the cell goes.
    await started;
    assert.equal(chain.state(AGENT)!.seq, 3n);
    const record = await queue.logEvent(AGENT, action("resolution"), { timestamp: 5 });
    const journaled = queue.pending(AGENT).find((e) => e.kind === "event") as AnchorEventEntry;
    assert.isTrue(journaled.lazy, "placed at its turn, after the cell, not at the seq the read showed");
    assert.equal(record.seq, 3n, "provisional");
    release();
    await queue.drain(AGENT);

    assert.lengthOf(queue.failed(AGENT), 0);
    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0", "3", "3", "4"],
      "genesis, the epoch, its cell at 3, and the record at 4"
    );
  });

  it("builds an epoch behind a halted one without letting the halted one's hook take its seq", async () => {
    // The failed-drain case: nothing can be drained, so the next epoch is built at the journal's tip. The
    // first epoch's hook would write its cell at that tip when a Retry lands it, and the second
    // epoch would diverge on every Retry in this process. The hook is dropped instead — the epoch
    // lands as it would after a restart, its locator still owed on the entry.
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { maxAttempts: 1 });
    chain.failNext(1);
    const genesis = await queue.logEvent(AGENT, action("genesis"), { timestamp: 1 });
    await queue.drain(AGENT).catch(() => undefined);
    assert.lengthOf(queue.failed(AGENT), 1, "halted");

    let cells = 0;
    const firstRoot = epochRootOf(1n, [toEventInput(action("s1"), 2)]);
    const firstHead = computeEpochHead(genesis.head, AGENT, firstRoot, 1n, 2n);
    await queue.enqueue(
      {
        kind: "epoch",
        agentId: hex(AGENT),
        startSeq: "1",
        endSeq: "2",
        prevHead: hex(genesis.head),
        head: hex(firstHead),
        epochRoot: hex(firstRoot),
        locator: "owed",
      },
      {
        onVerified: async () => {
          cells += 1;
          chain.foreignWrite(AGENT, toEventInput(action("locator-cell"), 4));
        },
      }
    );

    const tip = await queue.epochTip(AGENT);
    assert.equal(tip.seq, 2n, "the journal's tip: nothing could be drained");
    assert.equal(hex(tip.head), hex(firstHead));
    const secondRoot = epochRootOf(tip.seq, [toEventInput(action("s2"), 3)]);
    await queue.enqueue({
      kind: "epoch",
      agentId: hex(AGENT),
      startSeq: "2",
      endSeq: "3",
      prevHead: hex(tip.head),
      head: hex(computeEpochHead(tip.head, AGENT, secondRoot, 2n, 3n)),
      epochRoot: hex(secondRoot),
    });

    await queue.retry(AGENT);
    await queue.drain(AGENT);
    assert.lengthOf(queue.failed(AGENT), 0, "the Retry lands both epochs");
    assert.deepEqual(
      chain.applied.map((w) => w.kind),
      ["event", "epoch", "epoch"]
    );
    assert.equal(cells, 0, "the dropped hook wrote nothing");
    const owed = await queue.locatorsOwed(AGENT);
    assert.deepEqual(
      owed.map((e) => e.epochRoot),
      [hex(firstRoot)],
      "the first epoch's locator is still owed, for flushAnchors or reanchorEpochs"
    );
  });

  it("reads a journal again after a load that failed, rather than answering every later call with that failure", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    let loads = 0;
    class FlakyJournal extends MemoryAnchorJournal {
      async load(agentId: string): Promise<AnchorEntry[]> {
        loads += 1;
        if (loads === 1) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
        return super.load(agentId);
      }
    }
    const { queue } = queueOn(chain, { journal: new FlakyJournal() });

    let first: unknown;
    await queue.retry(AGENT).catch((e) => (first = e));
    assert.match(String((first as Error)?.message), /EMFILE/, "the failure is reported to the call that met it");

    // The descriptor came back: the next call loads, and the chain's queue works again.
    await queue.retry(AGENT);
    const logged = await queue.logEvent(AGENT, action("after"), { timestamp: 1 });
    await queue.drain(AGENT);
    assert.equal(loads, 2);
    assert.equal(logged.seq, 0n);
    assert.equal(hex(chain.state(AGENT)!.head), hex(logged.head));
  });

  it("never sends a record whose journal append failed, so a write its caller was told failed cannot land", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    let refuse = 0;
    class FullJournal extends MemoryAnchorJournal {
      async append(entry: AnchorEntry): Promise<void> {
        // Asynchronous, as a disk is: a pump that could see the entry would have had its turn.
        await new Promise((r) => setTimeout(r, 20));
        if (refuse-- > 0) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        return super.append(entry);
      }
    }
    const journal = new FullJournal();
    const { queue } = queueOn(chain, { journal });

    // A pump is running for "x" while "a" is being journaled, and the append for "a" then fails.
    const x = await queue.logEvent(AGENT, action("x"), { timestamp: 1 });
    refuse = 1;
    let refused: unknown;
    await queue.logEvent(AGENT, action("a"), { timestamp: 1 }).catch((e) => (refused = e));
    assert.match(String((refused as Error)?.message), /ENOSPC/, "the caller is told the write failed");

    // The next record takes the seq "a" never had, and a drain sends nothing of "a".
    const b = await queue.logEvent(AGENT, action("b"), { timestamp: 1 });
    await queue.drain(AGENT);
    assert.equal(b.seq, 1n);
    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0", "1"],
      "only the journaled records reached the chain"
    );
    assert.equal(hex(chain.state(AGENT)!.head), hex(computeHead(x.head, AGENT, 1n, b.input)));
    assert.deepEqual(
      queue.pending(AGENT).concat(queue.failed(AGENT)),
      [],
      "nothing of the refused record is left to send"
    );
  });

  it("keeps an epoch's owed locator findable when the process that held the hook is gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-"));
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);

    // A genesis, then an epoch that was sent and landed in a process that died before the
    // confirmation. `AnchorHooks` is in memory and `journal.load` does not repopulate it, so
    // nothing in the new process can publish the locator cell the commit owes.
    chain.foreignWrite(AGENT, toEventInput(action("genesis"), 1));
    const prevHead = chain.state(AGENT)!.head;
    const root = epochRootOf(1n, [toEventInput(action("s1"), 2)]);
    const journal = new FileAnchorJournal(dir);
    await journal.append({
      kind: "epoch",
      id: "orphan-epoch",
      agentId: hex(AGENT),
      startSeq: "1",
      endSeq: "2",
      prevHead: hex(prevHead),
      head: hex(computeEpochHead(prevHead, AGENT, root, 1n, 2n)),
      epochRoot: hex(root),
      locator: "owed",
      attempts: 1,
      state: "pending",
      createdAt: Date.now(),
    });
    await chain.commitEpoch(AGENT, root, 1n, 2n);

    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new FileAnchorJournal(dir),
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    await queue.drain(AGENT);

    const file = path.join(dir, "pending", `${hex(AGENT)}.json`);
    assert.equal(chain.applied.length, 2, "the commit was recognised as landed, not sent again");
    const owed = await queue.locatorsOwed(AGENT);
    assert.lengthOf(owed, 1, "the debt the dead process's hook owed is still on the entry");
    assert.equal(owed[0].epochRoot, hex(root), "and it names the root whose bytes have no pointer");
    assert.isTrue(fs.existsSync(file), "so the journal keeps it instead of compacting the debt away");

    // Whoever does hold the epoch store pays it — `AgentRuntime.flushAnchors` on this chain,
    // `reanchorEpochs` on one no runtime will open again — and then the chain owes nothing.
    await queue.locatorPublished(owed[0]);
    assert.lengthOf(await queue.locatorsOwed(AGENT), 0);
    await queue.drain(AGENT);
    assert.isFalse(fs.existsSync(file), "a chain that owes nothing, locator included, keeps no journal");
  });
});

/** One assistant turn with no tool calls: genesis, one LLM action, one resolution. */
function oneTurn(text: string): ChatResult[] {
  return [
    {
      status: 200,
      body: {
        id: "gen-1",
        model: "test/model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
      },
    },
  ];
}

function runtimeOn(
  chain: FakeChain,
  anchor?: { queue: AnchorQueue; drain: boolean },
  onEvent?: (e: RuntimeEvent) => void
) {
  return new AgentRuntime({
    onEvent,
    client: chain.asClient(),
    agentId: AGENT,
    transport: new RecordedTransport(oneTurn("the answer")),
    policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
    billing: new NoopBilling(),
    // Cells are not journaled — they stay on the client — and this test is about the records.
    structures: false,
    publishPolicy: false,
    now: () => 1_700_000_000_000,
    anchor,
  });
}

describe("an anchored session", () => {
  it("writes the same chain as a synchronous one", async () => {
    const direct = new FakeChain();
    const synchronous = await runtimeOn(direct).start({ user: USER, prompt: "hello", sessionId: "s1" });

    const anchored = new FakeChain();
    const { queue } = queueOn(anchored);
    const journaled = await runtimeOn(anchored, { queue, drain: true }).start({
      user: USER,
      prompt: "hello",
      sessionId: "s1",
    });

    assert.equal(journaled.output, synchronous.output);
    assert.equal(hex(journaled.head), hex(synchronous.head), "same records, same timestamps, same §4.4 fold");
    assert.deepEqual(
      journaled.events.map((e) => e.seq.toString()),
      synchronous.events.map((e) => e.seq.toString())
    );
    assert.deepEqual(
      anchored.applied.map((w) => w.head),
      direct.applied.map((w) => w.head)
    );
    assert.deepEqual(journaled.anchor, {
      pending: 0,
      failed: 0,
      seq: "3",
      head: hex(synchronous.head),
    });
    assert.equal(
      hex(anchored.state(AGENT)!.head),
      hex(journaled.head),
      "`drain: true` means the chain is settled when the session returns"
    );
  });

  it("returns before the chain confirms when it is told not to drain", async () => {
    const chain = new FakeChain();
    const { queue } = queueOn(chain);
    const tokens: string[] = [];
    const emitted: RuntimeEvent[] = [];
    const result = await runtimeOn(chain, { queue, drain: false }, (e) => emitted.push(e)).start({
      user: USER,
      prompt: "hello",
      sessionId: "s1",
      onToken: (delta) => tokens.push(delta),
    });

    // Every record was reported the moment it existed, with its seq and head and no signature:
    // that is what lets a console show the answer with a `pending` badge at its seq.
    assert.equal(result.status, "success");
    assert.equal(result.anchor!.seq, "3");
    const records = emitted.filter((e) => ["genesis", "action", "resolution"].includes(e.type));
    assert.equal(records.length, 3);
    assert.isTrue(
      records.every((e) => e.anchorState === "pending" && e.signature === ""),
      "a journaled record is reported as pending, not as a write with an empty signature"
    );
    assert.isAbove(tokens.length, 0, "`onToken` reaches the transport, which streams the recorded reply");
    assert.equal(tokens.join(""), result.output, "the streamed deltas are the answer the resolution commits to");

    await queue.drain(AGENT);
    assert.equal(hex(chain.state(AGENT)!.head), hex(result.head));
    assert.equal(
      (await chain.getAgentState(AGENT))!.state.seq,
      3n,
      "genesis, the LLM action and the resolution, in that order"
    );
  });

  it("publishes an epoch's locator from the commit's verified transition, and takes the cell's seq into account", async () => {
    const chain = new FakeChain();
    const { queue } = queueOn(chain);
    const order: string[] = [];
    // `AnchoredEpochStore` writes a `LocatorRegistry` cell after the commit. It folds into this
    // same chain, which is why the runtime treats an epoch as a barrier: the record after it
    // has to start from the seq the cell left behind, not from the epoch's `endSeq`.
    const store = {
      blobs: new Map<string, Uint8Array>(),
      async put(root: Uint8Array, blob: Uint8Array) {
        order.push("put");
        this.blobs.set(hex(root), blob);
      },
      async get(root: Uint8Array) {
        return this.blobs.get(hex(root)) ?? null;
      },
      async anchor(root: Uint8Array) {
        order.push("anchor");
        chain.foreignWrite(AGENT, toEventInput(action(`locator.${hex(root).slice(0, 8)}`), 1));
        return { published: true };
      },
    };

    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport: new RecordedTransport(oneTurn("batched")),
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing: new NoopBilling(),
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      rollup: { store, batchSize: 8 },
      anchor: { queue, drain: true },
    });
    const result = await runtime.start({ user: USER, prompt: "hello", sessionId: "s4" });

    assert.equal(result.batchedSteps, 1, "the LLM step went into the epoch, not into a record");
    assert.deepEqual(order, ["put", "anchor"], "the bytes are stored before the commit, the locator after it");
    assert.equal(result.epochs.length, 1);
    assert.equal(result.epochs[0].signature, "", "a journaled commit has no signature either");
    // genesis(0), epoch [1,2), locator cell(2), resolution(3).
    assert.equal(result.events[result.events.length - 1].seq, 3n);
    assert.equal(hex(chain.state(AGENT)!.head), hex(result.head));
    assert.equal(result.anchor!.pending, 0);
  });

  it("journals a batched step whose drain failed as an epoch, so the retry lands it before the Resolution", async () => {
    // A closing drain that rejected and skipped the flush would leave the batch — the only copy of
    // the step, whose charge was already journaled ahead of it — never committed: the retry would
    // land genesis, the charge and the Resolution, and the LLM Action would be gone.
    const chain = new FakeChain();
    // The queue sends the charge a batched step carries, so it holds the same backend the runtime does.
    const billing = new RecordingBilling();
    const { queue } = queueOn(chain, { maxAttempts: 1, billing });
    const blobs = new Map<string, Uint8Array>();
    const store = {
      async put(root: Uint8Array, blob: Uint8Array) {
        blobs.set(hex(root), blob);
      },
      async get(root: Uint8Array) {
        return blobs.get(hex(root)) ?? null;
      },
      // The locator cell, straight to the chain the way `LocatorRegistry` writes it, so the
      // Resolution behind the epoch has a seq it could not have guessed.
      async anchor(root: Uint8Array) {
        chain.foreignWrite(AGENT, toEventInput(action(`locator.${hex(root).slice(0, 8)}`), 1));
        return { published: true };
      },
    };
    const paid: ChatResult[] = [
      {
        status: 200,
        body: {
          id: "gen-1",
          model: "test/model",
          choices: [{ index: 0, message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
        },
      },
    ];
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport: new RecordedTransport(paid),
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing,
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      rollup: { store, batchSize: 8 },
      anchor: { queue, drain: true },
    });

    chain.failNext(1); // the genesis spends its one attempt
    const result = await runtime.start({ user: USER, prompt: "hello", sessionId: "lost-batch" });

    assert.equal(result.status, "failed", "the chain's account: the drain failed");
    assert.equal(result.workStatus, "success", "the work's account: the model answered");
    const owed = await queue.carried(AGENT);
    assert.deepEqual(
      owed.map((e) => e.kind),
      ["event", "charge", "epoch", "event"],
      "genesis, the step's charge, the epoch carrying the step, the Resolution"
    );
    assert.isTrue((owed[3] as AnchorEventEntry).lazy, "the Resolution is journaled behind the epoch, lazily");
    assert.lengthOf(billing.charges, 0, "nothing was charged while the chain refused");

    await queue.retry(AGENT);
    await queue.drain(AGENT);

    assert.deepEqual(
      chain.applied.map((w) => w.kind),
      ["event", "epoch", "event", "event"],
      "genesis, the epoch, its locator cell, then the Resolution"
    );
    assert.lengthOf(billing.charges, 1, "the step was charged once");
    const root = [...blobs.keys()];
    assert.lengthOf(root, 1);
    const decoded = decodeEpochBlob(blobs.get(root[0])!);
    assert.lengthOf(decoded.inputs, 1);
    assert.equal(decoded.inputs[0].kind, EventKind.Action, "the epoch carries the LLM step");
    // The Resolution was recomputed at its turn, over the locator cell's head.
    const resolution = result.events[result.events.length - 1];
    const cell = chain.applied[2];
    assert.equal(
      hex(chain.state(AGENT)!.head),
      hex(computeHead(Uint8Array.from(Buffer.from(cell.head, "hex")), AGENT, 3n, resolution.input))
    );
    assert.lengthOf(queue.failed(AGENT), 0);
  });

  it("publishes no locator for an epoch still journaled behind a failed record, so the retry still lands", async () => {
    // A loop stopped on `anchor-failed`, and the tick's stopped branch runs `flushAnchors`. Were the
    // unlanded epoch to carry `locator: "owed"` from the moment it was journaled, its cell would go
    // straight to the chain at the seq the genesis was built for, and every Retry after that would
    // answer `head diverged`.
    const chain = new FakeChain();
    const { queue } = queueOn(chain, { maxAttempts: 1 });
    const blobs = new Map<string, Uint8Array>();
    let cells = 0;
    const store = {
      async put(root: Uint8Array, blob: Uint8Array) {
        blobs.set(hex(root), blob);
      },
      async get(root: Uint8Array) {
        return blobs.get(hex(root)) ?? null;
      },
      async anchor(root: Uint8Array) {
        cells += 1;
        chain.foreignWrite(AGENT, toEventInput(action(`locator.${hex(root).slice(0, 8)}`), 1));
        return { published: true };
      },
    };
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport: new RecordedTransport(oneTurn("batched")),
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing: new NoopBilling(),
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      rollup: { store, batchSize: 8 },
      anchor: { queue, drain: true },
    });

    chain.failNext(1); // the genesis spends its one attempt
    const result = await runtime.start({ user: USER, prompt: "hello", sessionId: "stopped-on-failure" });
    assert.equal(result.status, "failed");
    const epoch = (await queue.carried(AGENT)).find((e) => e.kind === "epoch") as AnchorEpochEntry;
    assert.equal(epoch.locator, "owed", "the debt is on the entry from the moment it is journaled");
    assert.lengthOf(await queue.locatorsOwed(AGENT), 0, "but an epoch that has not landed is not payable");

    // What the loop tick does when a step stops the run.
    await runtime.flushAnchors();
    assert.equal(cells, 0, "no cell went to the chain ahead of the journaled records");
    assert.lengthOf(chain.applied, 0, "nothing at all was written");
    assert.equal(epoch.locator, "owed", "and the journal still says the locator is owed");

    await queue.retry(AGENT);
    await queue.drain(AGENT);
    assert.lengthOf(queue.failed(AGENT), 0, "the retry lands instead of diverging");
    assert.deepEqual(
      chain.applied.map((w) => w.kind),
      ["event", "epoch", "event", "event"],
      "genesis, the epoch, its locator cell from the hook, then the Resolution"
    );
    assert.equal(cells, 1, "the cell was written once, after its epoch");
  });

  it("makes an epoch that push committed on a count a barrier for the next one, so neither diverges", async () => {
    // A `count` flush from inside `push` has no drain after it, unlike `flushEpochs`. Without the
    // barrier the closing flush would build the second epoch at the first one's `endSeq` — the seq
    // the first one's locator cell takes when it lands — and the second epoch would halt the queue
    // on `head diverged`, which no Retry clears. `drain: false` is the console's `/api/run`, where nothing drains
    // before the closing flush.
    const chain = new FakeChain();
    const { queue } = queueOn(chain);
    const blobs = new Map<string, Uint8Array>();
    let cells = 0;
    const store = {
      async put(root: Uint8Array, blob: Uint8Array) {
        blobs.set(hex(root), blob);
      },
      async get(root: Uint8Array) {
        return blobs.get(hex(root)) ?? null;
      },
      // The locator cell, straight to the chain the way `LocatorRegistry` writes it — and as slowly
      // as a devnet confirmation, relative to a session that answers from memory, so the closing
      // flush runs while the first epoch's cell is still in flight.
      async anchor(root: Uint8Array) {
        await new Promise((r) => setTimeout(r, 25));
        cells += 1;
        chain.foreignWrite(AGENT, toEventInput(action(`locator.${hex(root).slice(0, 8)}`), 1));
        return { published: true };
      },
    };
    const call = (i: number) => ({
      id: `c${i}`,
      type: "function" as const,
      function: { name: `nope_${i}`, arguments: "{}" },
    });
    const turns: ChatResult[] = [
      {
        status: 200,
        body: {
          id: "gen-1",
          model: "test/model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: [call(1), call(2), call(3)] },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
        },
      } as ChatResult,
      ...oneTurn("done"),
    ];
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport: new RecordedTransport(turns),
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing: new NoopBilling(),
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      // Three: the first LLM step and the first two invented tool calls fill it, from inside `push`.
      rollup: { store, batchSize: 3 },
      anchor: { queue, drain: false },
    });

    const result = await runtime.start({ user: USER, prompt: "hello", sessionId: "two-epochs" });
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(
      result.epochs.map((e) => e.trigger),
      ["count", "manual"]
    );
    await queue.drain(AGENT);
    assert.lengthOf(queue.failed(AGENT), 0, "nothing diverged");
    assert.deepEqual(
      chain.applied.map((w) => w.kind),
      ["event", "epoch", "event", "epoch", "event", "event"],
      "genesis, the count epoch, its locator cell, the closing epoch, its locator cell, the Resolution"
    );
    assert.equal(cells, 2);
    assert.deepEqual(
      result.epochs.map((e) => [e.startSeq, e.endSeq]),
      [
        [1n, 4n],
        [5n, 7n],
      ],
      "the second epoch starts after the first one's locator cell, not at its endSeq"
    );
    assert.equal(hex(chain.state(AGENT)!.head), hex(result.head), "the Resolution is the head the session reported");

    // And the chain still takes a session after it: nothing is left halted for the next genesis.
    const next = await runtimeOn(chain, { queue, drain: true }).start({
      user: USER,
      prompt: "again",
      sessionId: "after",
    });
    assert.equal(next.status, "success", next.reason);
  });

  it("records and charges a paid batched call even when a balance read after it would throw", async () => {
    // `paidChat` admits the turn before the paid call. Were `recordLlmStep` to admit it again
    // after the voucher was signed, outside the try that becomes ChargeFailed, a 429 on that
    // second read (the sample expired during the call) would drop the call's Action and its
    // charge: the treasury would have paid the gateway and no record would name it.
    const chain = new FakeChain();
    (chain as any).chainSignals = () => ({});
    const billing = new RecordingBilling();
    const { queue } = queueOn(chain, { billing });
    const blobs = new Map<string, Uint8Array>();
    const store = {
      async put(root: Uint8Array, blob: Uint8Array) {
        blobs.set(hex(root), blob);
      },
      async get(root: Uint8Array) {
        return blobs.get(hex(root)) ?? null;
      },
    };
    let reads = 0;
    const transport = new RecordedTransport([
      {
        status: 200,
        body: {
          id: "gen-1",
          model: "test/model",
          choices: [{ index: 0, message: { role: "assistant", content: "paid" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
        },
      },
    ]);
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport,
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing,
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      rollup: {
        store,
        batchSize: 8,
        signals: {
          // Every read goes to the RPC, as one does after a model call longer than the sample.
          sampleIntervalMs: 0,
          payerBalance: async () => {
            reads += 1;
            if (reads > 1) throw new Error("HTTP error! status: 429");
            return 1e9;
          },
        },
      },
      anchor: { queue, drain: true },
    });

    const result = await runtime.start({ user: USER, prompt: "hello", sessionId: "paid-then-429" });
    assert.equal(result.status, "success", result.reason);
    assert.equal(transport.calls, 1);
    assert.equal(reads, 1, "admitted once, before the paid call");
    assert.equal(result.batchedSteps, 1, "the paid call is in the epoch");
    assert.lengthOf(billing.charges, 1, "and the user was charged for it");
    assert.isAbove(Number(result.costMicroUsdc), 0);
    const [root] = [...blobs.keys()];
    const decoded = decodeEpochBlob(blobs.get(root)!);
    assert.lengthOf(decoded.inputs, 1);
    assert.equal(decoded.inputs[0].kind, EventKind.Action);
  });

  it("resubmits what an earlier session left failed before it opens a genesis", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { maxAttempts: 1 });

    chain.failNext(1);
    const orphan = await queue.logEvent(AGENT, action("left-behind"), { timestamp: 1 });
    await queue.drain(AGENT).catch(() => undefined);
    assert.equal(queue.failed(AGENT).length, 1);

    const result = await runtimeOn(chain, { queue, drain: true }).start({
      user: USER,
      prompt: "hello",
      sessionId: "s2",
    });

    assert.equal(chain.applied[0].head, hex(orphan.head), "the failed record went first — seq N blocks N + 1");
    assert.equal(result.events[0].seq, 1n, "the genesis took the seq after it");
    assert.equal(result.anchor!.failed, 0);
  });

  it("throws before a genesis when the failed records still will not land", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const { queue } = queueOn(chain, { maxAttempts: 1 });

    chain.failNext(1);
    await queue.logEvent(AGENT, action("left-behind"), { timestamp: 1 });
    await queue.drain(AGENT).catch(() => undefined);

    chain.failNext(1);
    let failure: unknown;
    await runtimeOn(chain, { queue, drain: true })
      .start({ user: USER, prompt: "hello", sessionId: "s3" })
      .catch((e) => (failure = e));

    assert.instanceOf(failure, AnchorFailed);
    assert.equal(chain.applied.length, 0, "no genesis was opened on a chain that cannot accept one");
  });
});

/**
 * The console's binding layer over that queue (`frontend/src/app/api/_lib/anchor.ts`). One
 * process serves every chain it has a key for, so which backend a drained entry is charged
 * through is a question about the entry's own chain — not about whatever was bound most
 * recently.
 */
describe("console anchor bindings", () => {
  /** A backend per rail, recording what it was asked to pay and composing an inert debit. */
  class RailBilling {
    readonly charges: string[] = [];

    async charge(_user: PublicKey, amountMicroUsdc: bigint): Promise<string | null> {
      this.charges.push(amountMicroUsdc.toString());
      return `rail-charge-${this.charges.length}`;
    }

    async chargeIx(_user: PublicKey, amountMicroUsdc: bigint | number): Promise<TransactionInstruction> {
      this.charges.push(amountMicroUsdc.toString());
      return new TransactionInstruction({ keys: [], programId: SystemProgram.programId, data: Buffer.alloc(0) });
    }

    async chargeAndLog(): Promise<null> {
      throw new Error("chargeAndLog is not the anchored path");
    }
  }

  let bindAnchorChain: typeof import("../frontend/src/app/api/_lib/anchor").bindAnchorChain;
  let anchorQueue: typeof import("../frontend/src/app/api/_lib/anchor").anchorQueue;
  let carriedCharges: typeof import("../frontend/src/app/api/_lib/anchor").carriedCharges;
  let drainAdmission: typeof import("../frontend/src/app/api/_lib/anchor").drainAdmission;
  let subscribe: typeof import("../frontend/src/app/api/_lib/anchor").subscribe;

  before(() => {
    // Set before the module is loaded: `TRACE_DIR` is read once, at import, and the queue
    // journals under it. A tmpdir keeps the suite out of the console's real trace store.
    process.env.LATH_TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lath-anchor-queue-"));
    const mod = require("../frontend/src/app/api/_lib/anchor");
    bindAnchorChain = mod.bindAnchorChain;
    anchorQueue = mod.anchorQueue;
    carriedCharges = mod.carriedCharges;
    drainAdmission = mod.drainAdmission;
    subscribe = mod.subscribe;
  });

  it("charges a drained entry through the rail its own chain was bound to, not the one bound last", async () => {
    const chain = new FakeChain();
    const a = idFromString("f-t11-agent-a");
    const b = idFromString("f-t11-agent-b");
    await chain.registerAgent(a);
    await chain.registerAgent(b);
    const railA = new RailBilling();
    const railB = new RailBilling();
    const queue = anchorQueue();

    bindAnchorChain(a, { client: chain.asClient(), billing: railA });
    await queue.enqueue({ kind: "charge", agentId: hex(a), user: USER.toBase58(), amountMicroUsdc: "1200" });
    await queue.logEvent(a, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 3400n } });

    // What the console does between a session answering and its journal draining: a loop member
    // starts, a deploy registers, a second tab runs — each binds its own chain, and on a
    // dual-rail deployment its own rail.
    bindAnchorChain(b, { client: chain.asClient(), billing: railB });

    await queue.drain(a);

    assert.deepEqual(railA.charges, ["1200", "3400"], "both of A's debits were paid on A's rail");
    assert.deepEqual(railB.charges, [], "the rail bound last paid nothing for a chain that is not its own");
    assert.equal(chain.state(a)!.seq, 1n, "A's record landed");
    assert.equal(chain.state(b)!.seq, 0n, "B's chain was never written");
  });

  it("forwards a backend's chargeIxs for the entry's own chain, and falls back to chargeIx where it has none", async () => {
    // The console half. The queue prefers `chargeIxs`, but it only ever sees the dispatching
    // object this module builds; without the forward, the legacy-grant repair `BillingClient`
    // composes would never reach a journaled record's transaction, and an older grant would fail
    // every attempt and halt the chain.
    class RepairingRail extends RailBilling {
      single = 0;

      async chargeIxs(user: PublicKey, amountMicroUsdc: bigint | number): Promise<TransactionInstruction[]> {
        this.charges.push(amountMicroUsdc.toString());
        const inert = () =>
          new TransactionInstruction({ keys: [], programId: SystemProgram.programId, data: Buffer.alloc(0) });
        return [inert(), inert()];
      }

      async chargeIx(user: PublicKey, amountMicroUsdc: bigint | number): Promise<TransactionInstruction> {
        this.single += 1;
        return super.chargeIx(user, amountMicroUsdc);
      }
    }

    const chain = new FakeChain();
    const a = idFromString("f-l34-agent-repairing");
    const b = idFromString("f-l34-agent-plain");
    await chain.registerAgent(a);
    await chain.registerAgent(b);
    const repairing = new RepairingRail();
    const plain = new RailBilling();
    const queue = anchorQueue();

    bindAnchorChain(a, { client: chain.asClient(), billing: repairing });
    bindAnchorChain(b, { client: chain.asClient(), billing: plain });
    await queue.logEvent(a, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 3400n } });
    await queue.logEvent(b, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 5600n } });
    await queue.drain(a);
    await queue.drain(b);

    assert.deepEqual(
      chain.instructionCounts,
      [2, 1],
      "A's record carried the repair and the debit; B's backend composes one instruction, as before"
    );
    assert.deepEqual(repairing.charges, ["3400"], "A was charged once, through chargeIxs");
    assert.equal(repairing.single, 0, "chargeIx is not asked of a backend that has chargeIxs");
    assert.deepEqual(plain.charges, ["5600"], "B paid on its own rail, through its chargeIx");
    assert.equal(chain.state(a)!.seq, 1n, "A's record landed");
    assert.equal(chain.state(b)!.seq, 1n, "B's record landed");
  });

  /**
   * Both halves: the loss, and the gate that stands in front of it.
   *
   * Authenticated by the target check alone, a retry of a *console* agent's failed writes — the
   * owner gate fires only for a deployed agent, because the console's own agents are the open demo
   * — would need no wallet: `chainBilling` returns `NoopBilling` for a caller it cannot name, and a
   * wallet's pending USDC debit would settle to `verified` with nothing behind it. The first
   * assertion is that mechanism, kept because it is
   * the reason the gate exists; the rest is `drainAdmission` refusing every caller who is not
   * the payer with money behind them.
   */
  it("will not let a caller who is not the payer drain a journaled charge, and never through NoopBilling", async () => {
    const chain = new FakeChain();
    const agent = idFromString("f-r15-console-agent");
    await chain.registerAgent(agent);
    const queue = anchorQueue();
    const payer = USER.toBase58();
    const stranger = new PublicKey("11111111111111111111111111111113").toBase58();

    bindAnchorChain(agent, { client: chain.asClient(), billing: new NoopBilling() });
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: payer, amountMicroUsdc: "250000" });

    // What the journal owes, read the way the route reads it: `carried` loads the file, so this
    // answer is available in a process that never ran the session that wrote it.
    const owed = await carriedCharges(agent);
    assert.deepEqual(owed, { payers: [payer], microUsdc: 250_000n }, "the debt names its payer");

    assert.deepEqual(
      drainAdmission({ owed, user: null, authNote: "unsigned", billingState: "no-wallet" }),
      {
        status: 401,
        refuse:
          "this chain has 0.250000 USDC of journaled charges owed by " +
          `${payer}, so only that wallet may drain it: sign the request (unsigned)`,
      },
      "an anonymous retry of somebody else's debt is refused with the debt named"
    );
    const other = drainAdmission({ owed, user: stranger, authNote: null, billingState: "charged" });
    assert.equal((other as { status: number }).status, 403, "a signed stranger is not the payer");
    const broke = drainAdmission({
      owed,
      user: payer,
      authNote: null,
      billingState: "unfunded",
      shortfall:
        "the escrow deposit is short: 0.000000 USDC spendable and the first metered record can charge 0.041666 USDC",
    });
    assert.equal(
      (broke as { status: number }).status,
      402,
      "the payer with no money left is refused, not drained free"
    );
    assert.include((broke as { refuse: string }).refuse, "stay journaled", "and told the records are kept");
    assert.include((broke as { refuse: string }).refuse, "escrow deposit is short", "with which half was short");
    assert.deepEqual(
      drainAdmission({ owed, user: payer, authNote: null, billingState: "charged" }),
      { ok: true, billed: true },
      "the payer with a live allowance drains their own debt, billed"
    );

    // The loss the three refusals above prevent, and the queue's own backstop behind them. With
    // `NoopBilling` bound — which is what an unnamed caller gets — a charge could settle as
    // success on an empty signature, since `NoopBilling.charge` returns null, were `submit` to read
    // `signature ?? ""`. A charge that moved nothing fails and stays owed,
    // so a caller that reaches the queue without the gate above still cannot launder the debt.
    const settled: { state: string; signature?: string }[] = [];
    const off = subscribe(agent, (e) => settled.push({ state: e.state, signature: e.signature }));
    let failed: unknown;
    await queue.drain(agent).catch((e) => (failed = e));
    off();
    assert.instanceOf(failed, AnchorFailed, "the drain reports the unpaid charge instead of settling it");
    assert.include((failed as AnchorFailed).entry.error ?? "", "moved no USDC", "and says why");
    assert.deepEqual(
      settled.filter((e) => e.state === "verified"),
      [],
      "nothing was marked paid by a transaction that does not exist"
    );
    assert.deepEqual(
      await carriedCharges(agent),
      { payers: [payer], microUsdc: 250_000n },
      "the 0.25 USDC is still owed, by the same payer"
    );

    // And the payer with a live allowance drains it for real: the retry sends it through a
    // backend that signs, and only then is it settled.
    const paying = new RailBilling();
    bindAnchorChain(agent, { client: chain.asClient(), billing: paying });
    await queue.retry(agent);
    await queue.drain(agent);
    assert.deepEqual(paying.charges, ["250000"], "the owed charge was sent once, through the paying rail");
    assert.deepEqual(await carriedCharges(agent), { payers: [], microUsdc: 0n }, "and nothing is owed afterwards");
  });

  it("lets an anonymous retry drain a chain that owes nobody anything, exactly as before", async () => {
    // Most retries are this: records that failed to land, no money attached. Gating those on a
    // wallet would break the FAILED badge for the console's open demo, which is not the finding.
    const owed = { payers: [], microUsdc: 0n };
    assert.deepEqual(drainAdmission({ owed, user: null, authNote: null, billingState: "no-wallet" }), {
      ok: true,
      billed: false,
    });
  });
});
