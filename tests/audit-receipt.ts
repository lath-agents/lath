/**
 * `lath-audit verify-receipt` (docs/ARCHITECTURE.md §8), node-only: fixture records the
 * way the runner writes a loop (a Genesis per step committing the policy, a `loop.step` checkpoint whose
 * leaf commits the head before it, 201 on the step Jev's goal check stopped), the receipt's account
 * built as SAS lays it out, and a fake account reader. No validator, no RPC, no key.
 *
 * - **honest.** A receipt whose account, data, subject, position, status, steps and goal all match
 *   verifies, and its money fields print as the console reported them.
 * - **forged.** A head the leaf does not commit, a head the chain's prior head contradicts, a seq that is
 *   not the loop's last step (or no step at all), another signer, credential, schema or nonce, an owner
 *   that is not SAS, data that is not a receipt, another agent or loop, a step count and a goal the
 *   manifests do not commit, and a receipt on a step that did not reach its goal each fail by name.
 * - **not read.** No account is `unchecked` (committed, not published) when the last step reached its
 *   goal and `not-due` when it did not; a reader that throws is `unchecked`; a policy without `receipt`
 *   reports nothing; a later step hidden in an unopened epoch is `unchecked`, never `ok`.
 */
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  EventKind,
  hex,
  idFromString,
  LOOP_STEP_TOOL,
  loopLeafPreimage,
  loopManifestBytes,
  LoopStepStatus,
  MemoryTraceStore,
  payloadPreimage,
  ResolutionStatus,
  sha256,
  toBytes32,
  utf8,
  type InferenceRecord,
  type LoopStepManifest,
} from "../sdk/src";
import {
  loopReceiptAddress,
  loopReceiptBytes,
  loopReceiptNonce,
  type LoopReceipt,
  type LoopReceiptPointer,
} from "../sdk/src/receipt";
import { SAS_PROGRAM_ID } from "../sdk/src/plugins";
import {
  formatReceipt,
  receiptsExitCode,
  receiptsStatus,
  verifyReceiptLoops,
  type ReceiptAccountReader,
  type ReceiptReads,
  type ReceiptsResult,
} from "../sdk/src/audit/receipt";
import { solanaAccountReader } from "../sdk/src/cli";

const CREDENTIAL = "BewvqsfA1tFejBKDs6ZGza8Pp5CFmpE2pB81jRamaK9C";
const SCHEMA = "9QRYEHn48Qcs7joVdD7UhP7CPop72uQJ6DSp5FP8g7Pk";
const SIGNER = "35ZEEEb2PuHa2QBdCzZBHVbpAw7tcbfnDCPxFVsAG8tu";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const CALLER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const POINTER: LoopReceiptPointer = { credential: CREDENTIAL, schema: SCHEMA, signer: SIGNER };
const AGENT = idFromString("audit-receipt-agent");
const LOOP = "loop-0292a02b6f3d2780";
const OTHER_LOOP = "loop-1111111111111111";
const GOAL = "ship the release notes";
const T = 1_791_000_000_000;

const json = (v: unknown) => utf8(JSON.stringify(v));

/** One loop step to write: its loop, whether it reached its goal, and the policy its Genesis commits. */
interface StepSpec {
  loop: string;
  step: number;
  reached?: boolean;
  policy: Record<string, unknown>;
  goal?: string | null;
}

/**
 * A chain of loop steps the way `LoopRunner` writes them: per step, a Genesis committing the policy
 * (session `${loopId}:step-<n>`), a Resolution, and the `loop.step` checkpoint whose `result_hash` is
 * the leaf over the head before it. Heads are stand-ins (`sha256("head-<seq>")`): the leaf binds them.
 */
async function chainOf(steps: StepSpec[]) {
  const store = new MemoryTraceStore();
  const records: InferenceRecord[] = [];
  const priorHeads = new Map<string, string | null>();
  const last = new Map<string, { seq: bigint; head: string; step: number }>();
  let seq = 0n;
  const push = async (kind: EventKind, reference: Uint8Array, pre: Uint8Array) => {
    records.push({ seq: seq++, kind, reference, payloadHash: await store.put(pre) });
  };
  for (const s of steps) {
    await push(
      EventKind.Genesis,
      toBytes32(new PublicKey(CALLER)),
      payloadPreimage({
        kind: EventKind.Genesis,
        sessionId: `${s.loop}:step-${s.step}`,
        callerPubkey: new PublicKey(CALLER),
        policyVersionHash: await store.put(json(s.policy)),
        inputPayloadHash: sha256(utf8("input")),
      })
    );
    await push(
      EventKind.Resolution,
      idFromString(`${s.loop}:step-${s.step}`),
      payloadPreimage({
        kind: EventKind.Resolution,
        taskId: `${s.loop}:step-${s.step}`,
        status: ResolutionStatus.Success,
        finalOutputHash: sha256(utf8(`answer ${s.step}`)),
        totalStepCount: 1,
      })
    );
    const goal = s.goal === null ? undefined : s.goal ?? GOAL;
    const manifest: LoopStepManifest = {
      loopId: s.loop,
      step: s.step,
      intervalMs: 10_000,
      maxSteps: 5,
      promptHash: hex(sha256(utf8("write the notes"))),
      startedAt: T,
      ...(goal ? { goalHash: hex(sha256(utf8(goal))) } : {}),
    };
    const at = seq;
    const prior = sha256(utf8(`head-${at - 1n}`));
    priorHeads.set(at.toString(), hex(prior));
    await push(
      EventKind.Action,
      idFromString(LOOP_STEP_TOOL),
      payloadPreimage({
        kind: EventKind.Action,
        toolId: LOOP_STEP_TOOL,
        argsHash: await store.put(loopManifestBytes(manifest)),
        // The leaf is sha256 of its 72-byte preimage, which the runner stores under it.
        resultHash: await store.put(loopLeafPreimage(AGENT, at, prior)),
        statusCode: s.reached ? LoopStepStatus.GoalReached : LoopStepStatus.Success,
      })
    );
    last.set(s.loop, { seq: at, head: hex(prior), step: s.step });
  }
  return { store, records, priorHeads, last };
}

const RECEIPT_POLICY = { model: "x", receipt: POINTER };

/** The honest three-step goal loop, Jev's `achieved` on step 3. */
const HONEST: StepSpec[] = [
  { loop: LOOP, step: 1, policy: RECEIPT_POLICY },
  { loop: LOOP, step: 2, policy: RECEIPT_POLICY },
  { loop: LOOP, step: 3, policy: RECEIPT_POLICY, reached: true },
];

function receiptFor(c: Awaited<ReturnType<typeof chainOf>>, over: Partial<LoopReceipt> = {}): LoopReceipt {
  const l = c.last.get(LOOP)!;
  return {
    agent: hex(AGENT),
    loop: LOOP,
    seq: l.seq.toString(),
    head: l.head,
    steps: l.step,
    goal: hex(sha256(utf8(GOAL))),
    usdcCharged: "23456",
    tempoSpent: "31000",
    tempoPayer: "0x18fbe5e0a83dca440072059f91d1a23babe6e0b0",
    ...over,
  };
}

/** An SAS attestation account's bytes, as SAS lays one out. */
function attestationAccount(
  data: Uint8Array,
  over: Partial<{ nonce: string; credential: string; schema: string; signer: string; discriminator: number }> = {}
): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length, true);
  const parts = [
    Uint8Array.of(over.discriminator ?? 2),
    new PublicKey(over.nonce ?? loopReceiptNonce(LOOP)).toBytes(),
    new PublicKey(over.credential ?? CREDENTIAL).toBytes(),
    new PublicKey(over.schema ?? SCHEMA).toBytes(),
    len,
    data,
    new PublicKey(over.signer ?? SIGNER).toBytes(),
    new Uint8Array(8),
    new PublicKey(SAS_PROGRAM_ID).toBytes(),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A reader that holds one account at the loop's receipt address, or none, or throws. */
function readerOf(
  account: { owner: string; data: Uint8Array } | null | "throw",
  loopId = LOOP
): ReceiptAccountReader & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    async getAccountInfo(address: string) {
      asked.push(address);
      if (account === "throw") throw new Error("429 Too Many Requests");
      return address === loopReceiptAddress(POINTER, loopId) ? account : null;
    },
  };
}

async function run(
  steps: StepSpec[],
  account: (c: Awaited<ReturnType<typeof chainOf>>) => { owner: string; data: Uint8Array } | null | "throw",
  extra: Partial<ReceiptReads> & {
    noPriorHeads?: boolean;
    mutate?: (c: Awaited<ReturnType<typeof chainOf>>) => void;
  } = {}
): Promise<ReceiptsResult> {
  const c = await chainOf(steps);
  extra.mutate?.(c);
  const reads: ReceiptReads = {
    store: c.store,
    accounts: readerOf(account(c)),
    ...(extra.noPriorHeads ? {} : { priorHeads: c.priorHeads }),
    ...(extra.blind ? { blind: extra.blind } : {}),
  };
  return verifyReceiptLoops(AGENT, c.records, reads);
}

const published =
  (over: Partial<LoopReceipt> = {}, account: Parameters<typeof attestationAccount>[1] = {}) =>
  (c: Awaited<ReturnType<typeof chainOf>>) => ({
    owner: SAS_PROGRAM_ID,
    data: attestationAccount(loopReceiptBytes(receiptFor(c, over)), account),
  });

function failedCheck(r: ReceiptsResult, name: string) {
  assert.lengthOf(r.loops, 1);
  const c = r.loops[0].checks.find((x) => x.name === name);
  assert.ok(c, `no ${name} check: ${formatReceipt(r.loops[0]).join("\n")}`);
  assert.equal(c!.status, "failed", formatReceipt(r.loops[0]).join("\n"));
  assert.equal(r.loops[0].status, "failed");
  assert.equal(receiptsExitCode(r), 1);
  return c!;
}

describe("audit-receipt: an honest receipt", () => {
  it("verifies every check, and prints the money as the console reported it", async () => {
    const r = await run(HONEST, published());
    assert.lengthOf(r.loops, 1);
    assert.deepEqual(r.unread, []);
    const l = r.loops[0];
    assert.equal(l.status, "ok", formatReceipt(l).join("\n"));
    assert.deepEqual(
      l.checks.map((c) => [c.name, c.status]),
      [
        ["account", "ok"],
        ["data", "ok"],
        ["subject", "ok"],
        ["position", "ok"],
        ["reached", "ok"],
        ["steps", "ok"],
        ["goal", "ok"],
      ]
    );
    assert.equal(l.address, loopReceiptAddress(POINTER, LOOP));
    assert.equal(receiptsStatus(r), "ok");
    assert.equal(receiptsExitCode(r), 0);
    const text = formatReceipt(l).join("\n");
    assert.include(text, "account ✓ · data ✓ · subject ✓ · position ✓ · reached ✓ · steps ✓ · goal ✓");
    assert.include(text, "0.023456 USDC charged on Solana · 0.031 USDC.e paid on Tempo by 0x18fbe5e0");
    assert.include(text, "as the console reported them; this audit does not re-derive them");
    assert.notMatch(text, /prove/i, "the receipt points at the records; it never proves the loop");
  });

  it("verifies on the leaf alone when the chain's prior heads were not read, and says so", async () => {
    const r = await run(HONEST, published(), { noPriorHeads: true });
    assert.equal(r.loops[0].status, "ok");
    const position = r.loops[0].checks.find((c) => c.name === "position")!;
    assert.include(position.detail, "the chain's head before it was not read here");
  });

  it("reports only the loop whose policy commits a receipt", async () => {
    const steps: StepSpec[] = [
      { loop: OTHER_LOOP, step: 1, policy: { model: "x" }, reached: true },
      ...HONEST,
      { loop: OTHER_LOOP, step: 2, policy: { model: "x" } },
    ];
    const r = await run(steps, published());
    assert.deepEqual(
      r.loops.map((l) => l.loopId),
      [LOOP]
    );
    assert.equal(r.loops[0].status, "ok", formatReceipt(r.loops[0]).join("\n"));
  });
});

describe("audit-receipt: a forged receipt fails by name", () => {
  it("a head the record's leaf does not commit", async () => {
    const c = failedCheck(await run(HONEST, published({ head: "ab".repeat(32) })), "position");
    assert.match(c.detail, /is not the leaf over this agent, seq \d+ and the receipt's head/);
  });

  it("a head the chain's prior head contradicts, though the leaf commits it", async () => {
    const r = await run(HONEST, published(), {
      mutate: (c) => c.priorHeads.set(c.last.get(LOOP)!.seq.toString(), "cd".repeat(32)),
    });
    assert.match(failedCheck(r, "position").detail, /the chain's head before seq \d+ is cdcdcdcd/);
  });

  it("a seq that is not the loop's last step, with that step's own head and count", async () => {
    // Step 2's seq and head, honestly paired: the leaf matches, and the receipt still does not point at the end.
    const forged = (c: Awaited<ReturnType<typeof chainOf>>) => {
      const step2 = c.records.filter((x) => hex(x.reference) === hex(idFromString(LOOP_STEP_TOOL)))[1];
      return published({
        seq: step2.seq.toString(),
        head: c.priorHeads.get(step2.seq.toString())!,
        steps: 2,
      })(c);
    };
    const c = failedCheck(await run(HONEST, forged), "position");
    assert.match(c.detail, /is step 2 of the loop, and its last loop\.step is step 3 at seq \d+/);
  });

  it("a seq with no loop.step of this loop", async () => {
    const r = await run(HONEST, published({ seq: "1" }));
    assert.match(
      failedCheck(r, "position").detail,
      /no loop\.step of loop-0292a02b6f3d2780 at seq 1: the record there is not a loop\.step/
    );
    const r2 = await run(HONEST, published({ seq: "999" }));
    assert.match(failedCheck(r2, "position").detail, /the chain has no record there/);
  });

  it("another signer", async () => {
    const c = failedCheck(await run(HONEST, published({}, { signer: OTHER })), "account");
    assert.include(c.detail, `it is signed by ${OTHER}, the policy commits ${SIGNER}`);
  });

  it("another credential, schema or nonce", async () => {
    const cred = failedCheck(await run(HONEST, published({}, { credential: OTHER })), "account");
    assert.include(cred.detail, `its credential is ${OTHER}`);
    const schema = failedCheck(await run(HONEST, published({}, { schema: OTHER })), "account");
    assert.include(schema.detail, `its schema is ${OTHER}`);
    const nonce = failedCheck(await run(HONEST, published({}, { nonce: loopReceiptNonce(OTHER_LOOP) })), "account");
    assert.include(
      nonce.detail,
      `its nonce is ${loopReceiptNonce(OTHER_LOOP)}, the loop's is ${loopReceiptNonce(LOOP)}`
    );
  });

  it("an account SAS does not own, or one that is not an attestation", async () => {
    const owner = failedCheck(await run(HONEST, (c) => ({ ...published()(c), owner: OTHER })), "account");
    assert.include(owner.detail, `owned by ${OTHER}, not the SAS program`);
    const notAtt = failedCheck(await run(HONEST, published({}, { discriminator: 1 })), "account");
    assert.include(notAtt.detail, "does not decode as an SAS attestation");
  });

  it("data that is not a loop receipt", async () => {
    const r = await run(HONEST, () => ({ owner: SAS_PROGRAM_ID, data: attestationAccount(utf8("not a receipt")) }));
    assert.include(failedCheck(r, "data").detail, "does not decode as a loop-receipt v1");
  });

  it("another agent or another loop", async () => {
    const agent = failedCheck(await run(HONEST, published({ agent: "ee".repeat(32) })), "subject");
    assert.match(agent.detail, /it names agent eeeeeeee…/);
    const loop = failedCheck(await run(HONEST, published({ loop: OTHER_LOOP })), "subject");
    assert.include(loop.detail, `it names loop ${OTHER_LOOP}, not ${LOOP}`);
  });

  it("a step count the record does not commit", async () => {
    const c = failedCheck(await run(HONEST, published({ steps: 4 })), "steps");
    assert.include(c.detail, "the receipt says 4 steps, and its record is step 3");
  });

  it("a goal the manifests do not commit, or a loop whose manifests commit none", async () => {
    const c = failedCheck(await run(HONEST, published({ goal: hex(sha256(utf8("another goal"))) })), "goal");
    assert.match(c.detail, /the receipt's goal is [0-9a-f]{8}…, the manifests commit [0-9a-f]{8}…/);
    const none = HONEST.map((s) => ({ ...s, goal: null }));
    assert.include(failedCheck(await run(none, published()), "goal").detail, "commits no goal");
  });

  it("a receipt on a loop whose last step did not reach its goal", async () => {
    const stopped = HONEST.map((s) => ({ ...s, reached: false }));
    const c = failedCheck(await run(stopped, published()), "reached");
    assert.include(c.detail, `records status ${LoopStepStatus.Success}, not the goal reached`);
  });

  it("a receipt pointer the policy commits that is not one", async () => {
    const bad = HONEST.map((s) => ({ ...s, policy: { model: "x", receipt: { credential: CREDENTIAL } } }));
    const r = await run(bad, published());
    assert.equal(r.loops[0].status, "failed");
    assert.match(r.loops[0].detail!, /not a pointer \(receipt\.schema must be a base58 address\)/);
    assert.equal(receiptsExitCode(r), 1);
  });
});

describe("audit-receipt: what is not read is unchecked, never failed", () => {
  it("no account on a loop whose last step reached its goal: committed, not published", async () => {
    const r = await run(HONEST, () => null);
    assert.equal(r.loops[0].status, "unchecked");
    assert.match(
      r.loops[0].detail!,
      /^committed, not published: there is no account at the receipt's address; the loop's last loop\.step \(step 3, seq \d+\) records the goal reached$/
    );
    assert.equal(receiptsExitCode(r), 2);
    assert.include(formatReceipt(r.loops[0]).join("\n"), "not checked");
  });

  it("no account on a loop that did not reach its goal: none is due, and nothing was checked", async () => {
    const stopped = HONEST.map((s) => ({ ...s, reached: false }));
    const r = await run(stopped, () => null);
    assert.equal(r.loops[0].status, "not-due");
    assert.match(r.loops[0].detail!, /no receipt is due: .* records status 200, not the goal reached/);
    assert.equal(receiptsStatus(r), "unchecked");
    assert.equal(receiptsExitCode(r), 2);
  });

  it("a reader that throws", async () => {
    const r = await run(HONEST, () => "throw");
    assert.equal(r.loops[0].status, "unchecked");
    assert.include(r.loops[0].detail!, "could not be read: 429 Too Many Requests");
    assert.equal(receiptsExitCode(r), 2);
  });

  it("no reader at all", async () => {
    const c = await chainOf(HONEST);
    const r = await verifyReceiptLoops(AGENT, c.records, { store: c.store });
    assert.equal(r.loops[0].status, "unchecked");
    assert.equal(receiptsExitCode(r), 2);
  });

  it("a policy without receipt prints no line, and an agent with none exits 2", async () => {
    const plain = HONEST.map((s) => ({ ...s, policy: { model: "x", grants: { items: [] } } }));
    const reader = readerOf(null);
    const c = await chainOf(plain);
    const r = await verifyReceiptLoops(AGENT, c.records, { store: c.store, accounts: reader });
    assert.deepEqual(r, { loops: [], unread: [] });
    assert.deepEqual(reader.asked, [], "no receipt committed, so no account is read");
    assert.equal(receiptsExitCode(r), 2);
  });

  it("a later step hidden in an unopened epoch leaves the position unchecked", async () => {
    const r = await run(HONEST, published(), {
      blind: (from, want) => (want > 100n && from >= 0n ? "the epoch 20–30 is not opened here" : undefined),
    });
    const l = r.loops[0];
    assert.equal(l.status, "unchecked", formatReceipt(l).join("\n"));
    assert.include(
      l.checks.find((c) => c.name === "position")!.detail,
      "whether a later step of this loop exists cannot be read"
    );
  });

  it("a policy not readable here is named, not skipped", async () => {
    const c = await chainOf(HONEST);
    const bare = new MemoryTraceStore();
    // Every blob but the policy document: the manifests and payloads read, the policy does not.
    const policyHash = hex(sha256(json(RECEIPT_POLICY)));
    for (const rec of c.records) {
      const pre = await c.store.get(rec.payloadHash);
      await bare.put(pre!);
    }
    for (const s of HONEST) {
      await bare.put(
        loopManifestBytes({
          loopId: s.loop,
          step: s.step,
          intervalMs: 10_000,
          maxSteps: 5,
          promptHash: hex(sha256(utf8("write the notes"))),
          startedAt: T,
          goalHash: hex(sha256(utf8(GOAL))),
        })
      );
    }
    assert.isNull(await bare.get(toBytes32(policyHash)));
    const r = await verifyReceiptLoops(AGENT, c.records, { store: bare, accounts: readerOf(null) });
    assert.deepEqual(r.loops, []);
    assert.lengthOf(r.unread, 1);
    assert.match(r.unread[0], /loop-0292a02b6f3d2780: the policy its last step ran under is not readable here/);
    assert.equal(receiptsExitCode(r), 2);
  });
});

describe("audit-receipt: the CLI's account reader", () => {
  it("reads owner and data over getAccountInfo at confirmed, and a missing account as null", async () => {
    const data = Uint8Array.of(2, 3, 4);
    const calls: [string, unknown][] = [];
    const conn = {
      async getAccountInfo(key: PublicKey, commitment?: unknown) {
        calls.push([key.toBase58(), commitment]);
        if (key.toBase58() === OTHER) return null;
        return { owner: new PublicKey(SAS_PROGRAM_ID), data: Buffer.from(data), lamports: 1, executable: false };
      },
    } as any;
    const reader = solanaAccountReader(conn);
    assert.deepEqual(await reader.getAccountInfo(SIGNER), { owner: SAS_PROGRAM_ID, data });
    assert.isNull(await reader.getAccountInfo(OTHER));
    assert.deepEqual(calls, [
      [SIGNER, "confirmed"],
      [OTHER, "confirmed"],
    ]);
  });
});
