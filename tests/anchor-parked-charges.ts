import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BillingClient, EventKind, hex, idFromString, isSendRefusal } from "../sdk/src";
import {
  AnchorChargeEntry,
  AnchorEvent,
  AnchorFailed,
  AnchorQueue,
  chargeRefusal,
  FileAnchorJournal,
  MemoryAnchorJournal,
  NoopBilling,
} from "../runtime/src";
import {
  anchorQueue,
  anchorSummary,
  bindAnchorChain,
  carriedCharges,
  drainAdmission,
  drainOwed,
  subscribe,
} from "../frontend/src/app/api/_lib/anchor";
import { loopDrainRefusal } from "../frontend/src/app/api/_lib/loops";
import { FakeChain } from "./fixtures/fake-chain";
import { DoubtfulRpc, ForwardingRpc } from "./fixtures/doubtful-rpc";

/**
 * Two rules in the anchor queue's handling of a standalone `charge` entry.
 *
 * A charge the billing program refused — the payer revoked their grant or let it expire — would,
 * failed after three attempts, halt the chain, and the console's drain gate would name that payer
 * as the only wallet allowed to drain it: on the console's shared agents, one wallet locking every
 * other caller out, across restarts. Such a charge is parked instead: owed by its payer, consulted
 * only by that payer's admission, out of the chain's way.
 *
 * The billing client throws `could not tell whether <sig> landed; not resent` with the signature
 * on the error; a queue that dropped the signature would send a fresh debit on each attempt —
 * three per entry. The queue journals the signature and asks the cluster about it first.
 *
 * No validator and no RPC: `FakeChain` for the records, `DoubtfulRpc` for the billing client's send
 * path, and error texts in the shapes the billing client and the cluster produce.
 */

void traceDir;

const USER = new PublicKey("11111111111111111111111111111112");
const STRANGER = new PublicKey("11111111111111111111111111111113");

/** A preflight refusal as `sendRawTransaction` throws it: `SendTransactionError`, logs in the message. */
const EXPIRED =
  "Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 0: custom program error: " +
  '0x1773. \nLogs: \n[\n  "Program log: Instruction: Charge",\n  "Program log: AnchorError thrown in ' +
  "programs/lath-billing/src/lib.rs:301. Error Code: AllowanceExpired. Error Number: 6003. Error Message: Allowance " +
  'has expired."\n]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.';
/** `revoke_agent` closes the grant, so the charge meets Anchor's missing-account error, not a custom one. */
const REVOKED =
  "Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 0: custom program error: " +
  '0xbc4. \nLogs: \n[\n  "Program log: AnchorError caused by account: allowance. Error Code: AccountNotInitialized. ' +
  'Error Number: 3012. Error Message: The program expected this account to be already initialized."\n].';
/** A charge that landed and failed, as `confirmByPolling` reports it. */
const OVER_CAP = 'Transaction 5Vf… failed: {"InstructionError":[1,{"Custom":6004}]}';

function action(toolId: string) {
  return {
    kind: EventKind.Action as const,
    toolId,
    argsHash: idFromString(`${toolId}:args`),
    resultHash: idFromString(`${toolId}:result`),
    statusCode: 200,
  };
}

/** A payer's grant: refuses every charge with `refusal` while it is set, pays once it is cleared. */
class Grant {
  refusal: string | null = null;
  attempts = 0;
  readonly paid: { user: string; amountMicroUsdc: string }[] = [];

  async charge(user: PublicKey, amountMicroUsdc: bigint): Promise<string | null> {
    this.attempts++;
    if (this.refusal) throw new Error(this.refusal);
    this.paid.push({ user: user.toBase58(), amountMicroUsdc: amountMicroUsdc.toString() });
    return `paid-${this.paid.length}`;
  }

  async chargeAndLog(): Promise<null> {
    throw new Error("chargeAndLog is not the anchored path");
  }
}

function queueOn(
  chain: FakeChain,
  billing: ConstructorParameters<typeof AnchorQueue>[0]["billing"],
  opts: Partial<ConstructorParameters<typeof AnchorQueue>[0]> = {}
) {
  const events: AnchorEvent[] = [];
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing,
    onEvent: (e) => events.push(e),
    indexerWaitMs: 200,
    retryDelayMs: 2,
    ...opts,
  });
  return { queue, events };
}

describe("chargeRefusal", () => {
  it("names the billing program's refusals in each shape they arrive in", () => {
    assert.equal(chargeRefusal(new Error(EXPIRED)), "AllowanceExpired", "a preflight refusal, by Anchor's name");
    assert.equal(chargeRefusal(new Error(REVOKED)), "AccountNotInitialized", "a revoked grant is a closed account");
    assert.equal(chargeRefusal(new Error(OVER_CAP)), "AllowanceCapExceeded", "a landed failure, by number");
    assert.equal(
      chargeRefusal(Object.assign(new Error("failed to send transaction"), { logs: ["Error Number: 6005"] })),
      "InsufficientBalance",
      "and from the logs an error carries beside its message"
    );
    assert.equal(chargeRefusal(EXPIRED), "AllowanceExpired", "a journaled message alone, which is what a load has");
  });

  it("names nothing a resend could change, or a refusal it cannot attribute", () => {
    for (const text of [
      "429 Too Many Requests",
      "could not tell whether 5Vf… landed; not resent (a resent charge debits twice)",
      "the billing backend bound for this chain moved no USDC for a 250 micro-USDC charge to 1111… (no signature)",
      "Signature 5Vf… has expired: block height exceeded.",
      "fake billing: charge failed",
      // `BalanceRequired` (6007) is a refusal, but not one a payer's grant explains.
      'Transaction 5Vf… failed: {"InstructionError":[0,{"Custom":6007}]}',
    ]) {
      assert.isNull(chargeRefusal(new Error(text)), text);
    }
  });
});

describe("a charge the billing program refuses is parked, not failed", () => {
  it("parks on the first refusal and lets the records journaled around it land", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa2-parks");
    await chain.registerAgent(agent);
    const grant = new Grant();
    grant.refusal = EXPIRED;
    const { queue, events } = queueOn(chain, grant);

    await queue.logEvent(agent, action("a"), { timestamp: 1 });
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "9900" });
    await queue.logEvent(agent, action("b"), { timestamp: 1 });
    await queue.drain(agent); // resolves: nothing failed

    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0", "1"],
      "the record behind the charge landed: a charge moves no seq"
    );
    assert.equal(grant.attempts, 1, "a refusal is not retried: the program answers the same way");
    assert.lengthOf(queue.failed(agent), 0, "nothing halts the chain");
    assert.lengthOf(await queue.carried(agent), 0, "and nothing is owed to it");
    const parked = await queue.parked(agent);
    assert.lengthOf(parked, 1, "the debt is kept");
    assert.equal(parked[0].user, USER.toBase58());
    assert.include(parked[0].error ?? "", "AllowanceExpired", "with the program's reason");
    const seen = events.find((e) => e.state === "parked");
    assert.deepInclude(seen, { kind: "charge", payer: USER.toBase58(), amountMicroUsdc: "9900" }, "and announced");
  });

  it("resends a parked charge only for a payer in scope, and parks it again if it is still refused", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa2-scope");
    await chain.registerAgent(agent);
    const grant = new Grant();
    grant.refusal = REVOKED;
    let scope: readonly string[] | "all" = [];
    const { queue } = queueOn(chain, grant, { parkedScope: () => scope });
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "500" });
    await queue.drain(agent);
    assert.equal(grant.attempts, 1);

    await queue.retry(agent); // the queue's own scope: nobody
    await queue.drain(agent);
    await queue.retry(agent, { payers: [STRANGER.toBase58()] });
    await queue.drain(agent);
    assert.equal(grant.attempts, 1, "another payer's drain never sends this payer's refused charge");

    await queue.retry(agent, { payers: [USER.toBase58()] });
    await queue.drain(agent);
    assert.equal(grant.attempts, 2, "the payer's own drain sends it");
    assert.lengthOf(await queue.parked(agent), 1, "and a second refusal parks it again");
    assert.lengthOf(queue.failed(agent), 0, "rather than halting the chain");

    grant.refusal = null;
    scope = "all";
    await queue.retry(agent); // the default a single-payer chain runs with
    await queue.drain(agent);
    assert.deepEqual(grant.paid, [{ user: USER.toBase58(), amountMicroUsdc: "500" }], "paid once the grant is back");
    assert.lengthOf(await queue.parked(agent), 0);
  });

  it("parks a resent charge again when an unbilled drain moves nothing, and still fails a fresh one", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa2-noop");
    await chain.registerAgent(agent);
    const grant = new Grant();
    grant.refusal = OVER_CAP;
    let backend: Grant | NoopBilling = grant;
    const { queue } = queueOn(chain, () => backend);
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "700" });
    await queue.drain(agent);

    backend = new NoopBilling();
    await queue.retry(agent); // scope "all": the parked charge goes out through a backend with no money
    await queue.drain(agent);
    assert.lengthOf(await queue.parked(agent), 1, "it moved nothing, so it is owed and parked again");
    assert.lengthOf(queue.failed(agent), 0);

    // A charge never refused keeps the moved-nothing rule: through `NoopBilling` it fails and halts.
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "800" });
    let failed: unknown;
    await queue.drain(agent).catch((e) => (failed = e));
    assert.instanceOf(failed, AnchorFailed);
    assert.match((failed as AnchorFailed).entry.error ?? "", /moved no USDC/);
  });

  it("still fails and halts a charge that failed for any reason a resend might change", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa2-transient");
    await chain.registerAgent(agent);
    const grant = new Grant();
    grant.refusal = "fetch failed";
    const { queue } = queueOn(chain, grant, { maxAttempts: 3 });
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "100" });
    let failed: unknown;
    await queue.drain(agent).catch((e) => (failed = e));
    assert.instanceOf(failed, AnchorFailed, "rule 4, unchanged");
    assert.equal(grant.attempts, 3);
    assert.lengthOf(await queue.parked(agent), 0);
  });

  it("migrates a journal that holds a refused charge as failed, so a restart does not bring the lock back", async () => {
    const dir = fs.mkdtempSync(path.join(traceDir, "sa2-migrate-"));
    const chain = new FakeChain();
    const agent = idFromString("sa2-migrate");
    await chain.registerAgent(agent);
    const key = hex(agent);
    // What an older console's journal holds: the refused charge failed and halting, the
    // records behind it pending, and a second charge that failed on the RPC.
    const writer = queueOn(chain, undefined, { journal: new FileAnchorJournal(dir) }).queue;
    await writer.logEvent(agent, action("a"), { timestamp: 1 });
    const file = path.join(dir, "pending", `${key}.json`);
    const pendingEvent = JSON.parse(fs.readFileSync(file, "utf8"))[0];
    const old = (id: string, user: string, error: string): AnchorChargeEntry => ({
      kind: "charge",
      id,
      agentId: key,
      user,
      amountMicroUsdc: "9900",
      attempts: 3,
      state: "failed",
      error: `anchoring charge ${id} failed after 3 attempts: ${error}`,
      createdAt: 1_700_000_000_000,
    });
    fs.writeFileSync(
      file,
      JSON.stringify(
        [old("refused", USER.toBase58(), EXPIRED), pendingEvent, old("rpc", STRANGER.toBase58(), "fetch failed")],
        null,
        2
      )
    );

    const grant = new Grant();
    const { queue } = queueOn(chain, grant, { journal: new FileAnchorJournal(dir), parkedScope: () => [] });
    const parked = await queue.parked(agent);
    assert.deepEqual(
      parked.map((e) => [e.id, e.state, e.parkedAt]),
      [["refused", "parked", 1_700_000_000_000]],
      "the refused charge loads parked, dated from when it was journaled"
    );
    assert.deepEqual(
      queue.failed(agent).map((e) => e.id),
      ["rpc"],
      "the charge that failed on the RPC loads as it was"
    );
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as AnchorChargeEntry[];
    assert.equal(onDisk.find((e) => e.id === "refused")?.state, "parked", "and the file says so");
    assert.lengthOf(onDisk, 3, "nothing was dropped");

    // A Retry of the RPC failure lands the record and pays the other payer's charge; the parked
    // one is out of scope and stays owed.
    await queue.retry(agent);
    await queue.drain(agent);
    assert.deepEqual(
      chain.applied.map((w) => w.seq),
      ["0"]
    );
    assert.deepEqual(grant.paid, [{ user: STRANGER.toBase58(), amountMicroUsdc: "9900" }]);
    assert.deepEqual(
      (JSON.parse(fs.readFileSync(file, "utf8")) as AnchorChargeEntry[]).map((e) => e.id),
      ["refused"],
      "after compaction the journal is the parked debt alone"
    );
  });

  it("keeps a parked charge out of a discard's side file: it is owed to its payer, not to the chain", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa2-discard");
    await chain.registerAgent(agent);
    const grant = new Grant();
    grant.refusal = EXPIRED;
    const { queue } = queueOn(chain, grant);
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "9900" });
    await queue.drain(agent);
    // Another writer moves the chain under a journaled record: rule 3's divergence.
    await queue.logEvent(agent, action("a"), { timestamp: 1 });
    await chain.logEvent(agent, action("intruder"));
    await queue.drain(agent).catch(() => undefined);
    const result = await queue.discard(agent);
    assert.deepEqual(
      result.dropped.map((e) => e.kind),
      ["event"],
      "only the record is dropped"
    );
    assert.lengthOf(await queue.parked(agent), 1, "the parked debt stays");
  });
});

describe("a charge the billing client could not confirm is asked about, never resent", () => {
  function doubtful(chain: FakeChain) {
    const rpc = new DoubtfulRpc();
    const billing = BillingClient.fromIdl(rpc.asConnection(), Keypair.generate(), {
      admin: Keypair.generate().publicKey,
      maxRetries: 1,
      retryDelayMs: 1,
      // The client gives up on the first poll that meets a 429, and says it could not tell.
      confirmMaxWaitMs: 0,
    });
    return { rpc, ...queueOn(chain, billing, { maxAttempts: 3 }) };
  }

  it("sends one transaction for one journaled charge while status reads fail, not three", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa4-one-send");
    await chain.registerAgent(agent);
    const { rpc, queue } = doubtful(chain);
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "9900" });

    let failed: unknown;
    await queue.drain(agent).catch((e) => (failed = e));
    assert.equal(rpc.sent.length, 1, "transactions sent for ONE journaled charge");
    assert.instanceOf(failed, AnchorFailed, "stuck rather than resent: stuck is recoverable, a double debit is not");
    const entry = (failed as AnchorFailed).entry;
    assert.equal(entry.signature, rpc.sent[0], "the signature in doubt is journaled");
    assert.match(entry.error ?? "", /still in doubt/);

    // A Retry while the RPC still cannot answer asks again and still sends nothing.
    await queue.retry(agent);
    await queue.drain(agent).catch(() => undefined);
    assert.equal(rpc.sent.length, 1, "a Retry is not three more debits");

    // The RPC recovers and the cluster has it: settled on the signature that landed.
    rpc.failing = false;
    await queue.retry(agent);
    await queue.drain(agent);
    assert.equal(rpc.sent.length, 1, "known to have landed, so never resent");
    assert.lengthOf(await queue.carried(agent), 0, "and settled");
  });

  it("builds the charge again only once the cluster says it has no record of the one in doubt", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa4-lost");
    await chain.registerAgent(agent);
    const { rpc, queue, events } = doubtful(chain);
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "9900" });
    await queue.drain(agent).catch(() => undefined);
    assert.equal(rpc.sent.length, 1);

    rpc.lost.add(rpc.sent[0]);
    rpc.failing = false;
    await queue.retry(agent);
    await queue.drain(agent);
    assert.equal(rpc.sent.length, 2, "nothing moved under the first signature, so one new charge went out");
    const verified = events.filter((e) => e.state === "verified");
    assert.equal(verified[verified.length - 1].signature, rpc.sent[1], "settled on the one that landed");
  });

  it("holds a charge in doubt when the chain's backend cannot ask about it", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa4-cannot-ask");
    await chain.registerAgent(agent);
    let calls = 0;
    const backend = {
      async charge(): Promise<string | null> {
        calls++;
        throw Object.assign(new Error("could not tell whether sig-1 landed; not resent"), { signature: "sig-1" });
      },
      async chargeAndLog(): Promise<null> {
        return null;
      },
    };
    const { queue } = queueOn(chain, backend, { maxAttempts: 3 });
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "100" });
    await queue.drain(agent).catch(() => undefined);
    assert.equal(calls, 1, "not knowing is never read as not landed");
  });

  /** A backend that can only send its own charge, whose first send cannot tell whether it landed. */
  function chargeOnly(status: { answer: boolean | null | "unknown" }) {
    const sent: string[] = [];
    const backend = {
      async charge(): Promise<string | null> {
        const sig = `sig-${sent.length + 1}`;
        sent.push(sig);
        if (sent.length === 1) {
          throw Object.assign(new Error(`could not tell whether ${sig} landed; not resent`), { signature: sig });
        }
        return sig;
      },
      async chargeLanded(): Promise<boolean | null | "unknown"> {
        return status.answer;
      },
      async chargeAndLog(): Promise<null> {
        return null;
      },
    };
    return { backend, sent };
  }

  it("asks about a record's own charge in doubt before charging it again, on a charge-only backend", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa4-record-charge");
    await chain.registerAgent(agent);
    const status: { answer: boolean | null | "unknown" } = { answer: "unknown" };
    const { backend, sent } = chargeOnly(status);
    const { queue } = queueOn(chain, backend, { maxAttempts: 3 });
    await queue.logEvent(agent, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 700n } });
    await queue.drain(agent).catch(() => undefined);
    assert.deepEqual(sent, ["sig-1"], "in doubt, so never sent again (resending would debit three times)");
    assert.equal(chain.applied.length, 0, "and the record waits for it");

    // The cluster has it: the record goes out alone, on the charge that landed.
    status.answer = true;
    await queue.retry(agent);
    await queue.drain(agent);
    assert.deepEqual(sent, ["sig-1"], "known to have landed, so never resent");
    assert.equal(chain.applied.length, 1);
  });

  it("never counts a discarded record's charge in doubt as unbilled: it may have debited the user", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa4-record-discard");
    await chain.registerAgent(agent);
    const { backend } = chargeOnly({ answer: "unknown" });
    const { queue } = queueOn(chain, backend, { maxAttempts: 3 });
    await queue.logEvent(agent, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 700n } });
    await queue.drain(agent).catch(() => undefined);
    // Another writer takes the seq the record was built for: rule 3's divergence.
    await chain.logEvent(agent, action("intruder"));
    const result = await queue.discard(agent);
    assert.lengthOf(result.dropped, 1);
    assert.equal(result.unbilledMicroUsdc, 0n, "not the operator's loss: it may have moved");
    assert.equal(result.chargedMicroUsdc, 700n);
    assert.equal(result.inDoubtMicroUsdc, 700n, "and said to be in doubt, not known to have moved");
  });

  it("charges a record again only once the cluster has no record of its charge in doubt", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa4-record-lost");
    await chain.registerAgent(agent);
    const { backend, sent } = chargeOnly({ answer: null });
    const { queue } = queueOn(chain, backend, { maxAttempts: 3 });
    await queue.logEvent(agent, action("llm.step"), { timestamp: 1, charge: { user: USER, amountMicroUsdc: 700n } });
    await queue.drain(agent);
    assert.deepEqual(sent, ["sig-1", "sig-2"], "nothing moved under the first, so one new charge");
    assert.equal(chain.applied.length, 1);
  });
});

/**
 * Journaling a signature only when the billing client throws one is not enough: two failures throw
 * none while the charge can still land. A send that fails after the RPC forwarded the transaction
 * (a gateway's 502) loses the signature outright; a height read answering a JSON-RPC internal
 * error, which does not look transient, ends the confirmation while the status is still empty.
 * Either way a queue with nothing to ask about would charge again on a fresh blockhash: two
 * debits for one journaled charge.
 */
describe("a charge whose send or poll failed is confirmed, never sent beside itself", () => {
  function forwarding(chain: FakeChain, rpc: ForwardingRpc) {
    const billing = BillingClient.fromIdl(rpc.asConnection(), Keypair.generate(), {
      admin: Keypair.generate().publicKey,
      maxRetries: 3,
      retryDelayMs: 1,
    });
    return queueOn(chain, billing, { maxAttempts: 3 });
  }

  async function oneCharge(name: string, rpc: ForwardingRpc) {
    const chain = new FakeChain();
    const agent = idFromString(name);
    await chain.registerAgent(agent);
    const { queue, events } = forwarding(chain, rpc);
    await queue.enqueue({ kind: "charge", agentId: hex(agent), user: USER.toBase58(), amountMicroUsdc: "9900" });
    await queue.drain(agent);
    return { queue, events, agent };
  }

  it("confirms a charge whose send failed after the RPC forwarded it, rather than sending it twice", async () => {
    const rpc = new ForwardingRpc();
    rpc.sendOutcomes = ["forward-then-502"];
    const { queue, events, agent } = await oneCharge("chain1-forwarded-502", rpc);

    assert.equal(rpc.sends, 1, "one transaction sent for one journaled charge");
    assert.lengthOf(rpc.landed(), 1, "and one debit");
    const verified = events.filter((e) => e.state === "verified");
    assert.equal(verified[verified.length - 1].signature, rpc.forwarded[0].signature, "settled on the one that landed");
    assert.lengthOf(await queue.carried(agent), 0);
  });

  it("keeps polling through a height read that is not transient while the charge is in flight (2 debits before)", async function () {
    this.timeout(20_000);
    const rpc = new ForwardingRpc();
    rpc.heightFaults = 1;
    rpc.landAfterMs = 50;
    await oneCharge("chain1-poll-internal-error", rpc);

    assert.equal(rpc.sends, 1, "the -32603 is the provider's state, not a verdict on the charge");
    assert.lengthOf(rpc.landed(), 1);
  });

  it("builds a dropped charge again only once its blockhash has expired", async function () {
    this.timeout(20_000);
    const rpc = new ForwardingRpc();
    rpc.sendOutcomes = ["drop-502"];
    // In the window for the first poll, past it after: the dropped transaction is pending, then dead.
    rpc.heights = [999, 1_001];
    const { events } = await oneCharge("chain1-dropped-502", rpc);

    assert.equal(rpc.sends, 2, "nothing reached the cluster, so one new charge went out");
    assert.isAbove(rpc.sendHeights[1], 1_000, "and only after the first could no longer land");
    assert.lengthOf(rpc.landed(), 1, "one debit");
    const verified = events.filter((e) => e.state === "verified");
    assert.equal(verified[verified.length - 1].signature, rpc.forwarded[0].signature);
  });

  it("still rethrows the node's own refusal at once, so the queue parks it by the program's reason", async () => {
    const rpc = new ForwardingRpc();
    rpc.sendOutcomes = ["refuse"];
    const { queue, agent } = await oneCharge("chain1-refused", rpc);

    assert.equal(rpc.sends, 1);
    assert.equal(rpc.statusReads, 0, "a refusal forwarded nothing, so there is nothing to ask about");
    const parked = await queue.parked(agent);
    assert.lengthOf(parked, 1);
    assert.include(parked[0].error ?? "", "AllowanceExpired");
  });

  it("names what a send refusal is, and what it is not", () => {
    assert.isTrue(isSendRefusal(new Error(EXPIRED)), "a preflight refusal in web3.js's words");
    assert.isTrue(isSendRefusal(new Error("failed to send transaction: Node is behind by 42 slots")));
    for (const text of ["502 Bad Gateway: upstream request timeout", "fetch failed", "socket hang up", "504"]) {
      assert.isFalse(isSendRefusal(new Error(text)), text);
    }
  });
});

describe("console: one payer's refused charge locks nobody else out of a shared chain", () => {
  it("admits every other caller, refuses the payer until they can pay, and survives a restart", async () => {
    const chain = new FakeChain();
    const agent = idFromString("sa2-console-shared-agent");
    await chain.registerAgent(agent);
    const queue = anchorQueue();
    const payer = USER.toBase58();
    const stranger = STRANGER.toBase58();
    const grant = new Grant();
    grant.refusal = REVOKED;
    bindAnchorChain(agent, { client: chain.asClient(), billing: grant });

    // The payer's session: billed, then revoked before its charges drained.
    await drainOwed(agent, payer);
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a.join(" "));
    const seen: string[] = [];
    const off = subscribe(agent, (e) => seen.push(`${e.kind}:${e.state}`));
    try {
      await queue.logEvent(agent, action("genesis"), { timestamp: 1 });
      await queue.enqueue({ kind: "charge", agentId: hex(agent), user: payer, amountMicroUsdc: "9900" });
      await queue.logEvent(agent, action("resolution"), { timestamp: 1 });
      await queue.drain(agent);
    } finally {
      off();
      console.warn = warn;
    }
    assert.equal(chain.state(agent)!.seq, 2n, "the session's records are on chain");
    assert.include(seen, "charge:failed", "the payer's message says its debit did not land, in the browser's words");
    assert.isTrue(
      warned.some((w) => w.includes("parked") && w.includes(payer) && w.includes("9900")),
      "and the operator's log names the debt"
    );
    assert.include(await anchorSummary(agent), { pending: 0, failed: 0, parked: 1 });

    // Everyone else: nothing owed, admitted exactly as on a chain that owes nothing.
    for (const caller of [null, stranger]) {
      const owed = await drainOwed(agent, caller);
      assert.deepEqual(owed, { payers: [], microUsdc: 0n }, `nothing is owed by ${caller ?? "an unsigned caller"}`);
      assert.deepEqual(
        drainAdmission({ owed, user: caller, authNote: null, billingState: caller ? "charged" : "no-wallet" }),
        { ok: true, billed: false }
      );
    }
    // A drain scoped to the stranger does not send the payer's refused charge.
    await drainOwed(agent, stranger);
    await queue.retry(agent);
    await queue.drain(agent);
    assert.equal(grant.attempts, 1, "nobody else's drain touches it");

    // The payer: their own admission still waits on their own debt.
    const theirs = await drainOwed(agent, payer);
    assert.deepEqual(theirs, { payers: [payer], microUsdc: 9_900n });
    const broke = drainAdmission({ owed: theirs, user: payer, authNote: null, billingState: "unfunded" });
    assert.equal((broke as { status: number }).status, 402, "refused until their allowance can pay");
    // And so does a loop's step on a chain the payer owns: `carriedCharges` counts parked debt.
    assert.deepEqual(await carriedCharges(agent), { payers: [payer], microUsdc: 9_900n });
    assert.match(
      loopDrainRefusal(await carriedCharges(agent), { refuse: "the allowance has been revoked" }) ?? "",
      /owes 0\.009900 USDC/
    );

    // A restart: a fresh queue over the same directory finds the debt parked, halting nothing.
    const reopened = new AnchorQueue({
      client: chain.asClient(),
      journal: new FileAnchorJournal(process.env.LATH_TRACE_DIR!),
    });
    assert.deepEqual(
      (await reopened.parked(agent)).map((e) => [e.user, e.amountMicroUsdc]),
      [[payer, "9900"]]
    );
    assert.lengthOf(reopened.failed(agent), 0);

    // The payer approves again: admitted, and their drain pays the debt, once.
    grant.refusal = null;
    const owed = await drainOwed(agent, payer);
    assert.deepEqual(drainAdmission({ owed, user: payer, authNote: null, billingState: "charged" }), {
      ok: true,
      billed: true,
    });
    await queue.retry(agent);
    await queue.drain(agent);
    assert.deepEqual(grant.paid, [{ user: payer, amountMicroUsdc: "9900" }]);
    assert.deepEqual(await drainOwed(agent, payer), { payers: [], microUsdc: 0n });
    assert.deepEqual(await carriedCharges(agent), { payers: [], microUsdc: 0n });
  });
});
