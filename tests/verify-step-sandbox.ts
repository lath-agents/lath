/**
 * `verify-step`'s sandbox line. A sandboxed step's replay record is
 * re-hashed against the `replayHash` its manifest commits, its `postureHash` is held to the posture
 * the session's Genesis commits through `policy_version_hash`, and the posture's binary is flagged as
 * a published build or not.
 *
 * The record, the posture and the policy document are built by the runtime's own functions
 * (`replay.ts`, `posture.ts`, `policy.ts`), so the SDK's re-derivation is pinned against the bytes a
 * real step writes rather than against a copy of them.
 *
 * Node-only: an in-memory chain and store, no validator, no RPC, no key that spends anything.
 */
import { assert } from "chai";
import {
  EventKind,
  formatStepVerify,
  hex,
  idFromString,
  LOOP_STEP_TOOL,
  loopManifestBytes,
  MemoryBackend,
  PlainTraceStore,
  payloadPreimage,
  roadmapKeysOf,
  sha256,
  stepVerifyExitCode,
  utf8,
  verifyStepDecision,
  WebEncryptedTraceStore,
  type InferenceRecord,
  type LoopStepManifest,
  type TraceStore,
} from "../sdk/src";
import { SealingTraceStore, traceKey } from "./fixtures/sealed-traces";
import { checkBuild, checkReplayBlob, postureOfPolicy } from "../sdk/src/step-sandbox";
import { PUBLISHED_ZEROCLAW_BUILDS, publishedBuild } from "../sdk/src/zeroclaw-builds";
import { canonicalJson, policyDocument, policyVersionHash } from "@lath/runtime/policy";
import { lathPosture, postureHash, type LathPosture } from "@lath/runtime/zeroclaw/posture";
import { replayHash, replayRecord, replayRecordBytes, type ReplayRecord } from "@lath/runtime/zeroclaw/replay";

const DARWIN = PUBLISHED_ZEROCLAW_BUILDS.find((b) => b.triple === "aarch64-apple-darwin")!;
const AGENT = idFromString("verify-step-sandbox");
const MEMBER = idFromString("verify-step-sandbox-member");
const CALLER = new Uint8Array(32).fill(7);
const BASE = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["store.get"], maxCost: 5_000 };

const posture = (binarySha256 = DARWIN.sha256): LathPosture =>
  lathPosture({ toolAllowList: ["store.get"], binarySha256, patchSet: DARWIN.patchSet, platform: "darwin" });

const record = (p: LathPosture, over: Partial<ReplayRecord> = {}): ReplayRecord =>
  replayRecord({
    binarySha256: p.binarySha256,
    postureHash: postureHash(p),
    messageHash: hex(sha256(utf8("the step's message"))),
    workspacePath: "/lath/work",
    tz: "UTC",
    locale: "en",
    now: "2026-09-26T12:00:00Z",
    workspaceBefore: "00".repeat(32),
    workspaceAfter: "11".repeat(32),
    seqs: ["1", "2"],
    ...over,
  });

/**
 * One agent's chain: a Genesis committing `policy` at each seq in `genesisAt`, Actions at every other
 * seq below the checkpoint, and the `loop.step` checkpoint at `checkpointAt` over `manifest`.
 */
async function chainOf(
  put: (bytes: Uint8Array) => Promise<unknown>,
  policy: object,
  genesisAt: number[],
  checkpointAt: number,
  manifest?: LoopStepManifest
): Promise<InferenceRecord[]> {
  const doc = utf8(policyDocument(policy as any));
  await put(doc);
  const records: InferenceRecord[] = [];
  for (let seq = 0; seq < checkpointAt; seq++) {
    if (genesisAt.includes(seq)) {
      const pre = payloadPreimage({
        kind: EventKind.Genesis,
        sessionId: `session-${seq}`,
        callerPubkey: CALLER,
        policyVersionHash: policyVersionHash(policy as any),
        inputPayloadHash: sha256(utf8(`input ${seq}`)),
      });
      await put(pre);
      records.push({ seq: BigInt(seq), kind: EventKind.Genesis, reference: CALLER, payloadHash: sha256(pre) });
    } else {
      records.push({
        seq: BigInt(seq),
        kind: EventKind.Action,
        reference: idFromString("llm.chat"),
        payloadHash: sha256(utf8(`call ${seq}`)),
      });
    }
  }
  if (manifest) {
    const bytes = loopManifestBytes(manifest);
    await put(bytes);
    const pre = payloadPreimage({
      kind: EventKind.Action,
      toolId: LOOP_STEP_TOOL,
      argsHash: sha256(bytes),
      resultHash: sha256(utf8("leaf")),
      statusCode: 200,
    });
    await put(pre);
    records.push({
      seq: BigInt(checkpointAt),
      kind: EventKind.Action,
      reference: idFromString(LOOP_STEP_TOOL),
      payloadHash: sha256(pre),
    });
  }
  return records;
}

const manifestWith = (extra: Partial<LoopStepManifest>): LoopStepManifest => ({
  loopId: "loop-z3",
  step: 1,
  intervalMs: 60_000,
  maxSteps: 3,
  promptHash: hex(sha256(utf8("watch the program"))),
  startedAt: 1_790_000_000_000,
  ...extra,
});

/** A plain store and a single-agent chain whose step committed `blob` as its replay record. */
async function sandboxedStep(opts: { policy?: object; blob: Uint8Array; genesisAt?: number[]; checkpointAt?: number }) {
  const store = new PlainTraceStore(new MemoryBackend());
  await store.put(opts.blob);
  const manifest = manifestWith({ replayHash: hex(sha256(opts.blob)) });
  const policy = opts.policy ?? { ...BASE, sandbox: posture() };
  const records = await chainOf((b) => store.put(b), policy, opts.genesisAt ?? [0], opts.checkpointAt ?? 3, manifest);
  return { store, chain: { listEvents: async () => records }, seq: BigInt(opts.checkpointAt ?? 3) };
}

describe("verify-step sandbox: the pure checks", () => {
  it("re-hashes a record the runtime wrote to the hash the runtime gave it", () => {
    const r = record(posture());
    const bytes = replayRecordBytes(r);
    const out = checkReplayBlob(replayHash(r), bytes, false);
    assert.equal(out.check.verdict, "pass", out.check.detail);
    assert.deepEqual(out.records, [r]);
    assert.isFalse(out.folded);
  });

  it("fails bytes that do not re-hash, and bytes that hash but are not a record", () => {
    const r = record(posture());
    const edited = utf8(canonicalJson({ ...r, workspaceAfter: "22".repeat(32) }));
    assert.equal(checkReplayBlob(replayHash(r), edited, false).check.verdict, "fail");
    const notRecord = utf8(canonicalJson({ v: 1 }));
    assert.equal(checkReplayBlob(hex(sha256(notRecord)), notRecord, false).check.verdict, "fail");
    const spaced = utf8(JSON.stringify(r, null, 1));
    assert.match(checkReplayBlob(hex(sha256(spaced)), spaced, false).check.detail, /canonical/);
  });

  it("reads the two-record fold, and fails one whose synthesis did not start where the session ended", () => {
    const p = posture();
    const a = record(p, { seqs: ["1"] });
    const b = record(p, { seqs: ["3"], workspaceBefore: a.workspaceAfter, workspaceAfter: "33".repeat(32) });
    const fold = utf8(canonicalJson([a, b]));
    const ok = checkReplayBlob(hex(sha256(fold)), fold, false);
    assert.equal(ok.check.verdict, "pass", ok.check.detail);
    assert.isTrue(ok.folded);
    const broken = utf8(canonicalJson([a, { ...b, workspaceBefore: "44".repeat(32) }]));
    assert.equal(checkReplayBlob(hex(sha256(broken)), broken, false).check.verdict, "fail");
  });

  it("says an encrypted or absent record is not checkable, never a fail", () => {
    assert.equal(checkReplayBlob("ab".repeat(32), null, true).check.verdict, "unchecked");
    assert.equal(checkReplayBlob("ab".repeat(32), null, false).check.verdict, "unchecked");
  });

  it("derives postureHash from a policy document exactly as the runtime does", () => {
    const p = posture();
    const got = postureOfPolicy(utf8(policyDocument({ ...BASE, sandbox: p } as any)));
    assert.notTypeOf(got, "string");
    assert.equal((got as { postureHash: string }).postureHash, postureHash(p));
    assert.equal(postureOfPolicy(utf8(policyDocument(BASE as any))), "no-sandbox");
  });

  it("flags a published build by its triple and anything else as unknown", () => {
    assert.equal(publishedBuild(DARWIN.sha256.toUpperCase())?.triple, "aarch64-apple-darwin");
    const known = checkBuild(DARWIN.sha256);
    assert.equal(known.verdict, "pass");
    assert.include(known.detail, "published build (aarch64-apple-darwin, patch 0005 accepts context_window)");
    const unknown = checkBuild("ab".repeat(32));
    assert.equal(unknown.verdict, "unchecked");
    assert.include(unknown.detail, "unknown build");
    assert.include(unknown.detail, "not one this repo publishes");
  });
});

describe("verify-step sandbox: the line", () => {
  it("passes a step whose record, posture and build agree, and leaves its exit code alone", async () => {
    const r = record(posture());
    const { store, chain, seq } = await sandboxedStep({ blob: replayRecordBytes(r) });
    const report = await verifyStepDecision(chain, AGENT, seq, { store });
    const [s] = report.sandboxes!;
    assert.equal(s.whose, "step");
    assert.deepEqual(
      [s.replay.verdict, s.posture.verdict, s.build.verdict],
      ["pass", "pass", "pass"],
      JSON.stringify(s)
    );
    assert.equal(s.wrapper, "sandbox-exec");
    // An unverified step is still "nothing to check" for the decision; a passing sandbox adds no verdict.
    assert.equal(report.verdict, "no-preimage");
    assert.equal(stepVerifyExitCode(report), 2);
    const text = formatStepVerify(report).join("\n");
    assert.include(text, "sandbox    step session, replay");
    assert.include(text, "posture  PASS: postureHash");
    assert.include(text, "build    PASS: published build (aarch64-apple-darwin");
    assert.include(text, "wrapper sandbox-exec");
    assert.include(text, "workspace 000000000000… → 111111111111…");
    assert.notMatch(text, /isolated|proven/i);
  });

  it("fails the step when the record names a posture its Genesis did not commit", async () => {
    const other = posture("ab".repeat(32));
    const r = record(posture(), { postureHash: postureHash(other) });
    const { store, chain, seq } = await sandboxedStep({ blob: replayRecordBytes(r) });
    const report = await verifyStepDecision(chain, AGENT, seq, { store });
    assert.equal(report.sandboxes![0].posture.verdict, "fail");
    assert.equal(report.verdict, "mismatch");
    assert.match(report.reason!, /^the step's sandbox: /);
    assert.equal(stepVerifyExitCode(report), 1);
  });

  it("fails a sandboxed step whose Genesis commits a policy with no posture", async () => {
    const r = record(posture());
    const { store, chain, seq } = await sandboxedStep({ blob: replayRecordBytes(r), policy: BASE });
    const report = await verifyStepDecision(chain, AGENT, seq, { store });
    assert.equal(report.sandboxes![0].posture.verdict, "fail");
    assert.match(report.sandboxes![0].posture.detail, /carries no sandbox posture/);
    assert.equal(report.verdict, "mismatch");
  });

  it("holds each half of a synthesizing step's fold to its own Genesis", async () => {
    const p = posture();
    const a = record(p, { seqs: ["1"] });
    const b = record(p, { seqs: ["3"], workspaceBefore: a.workspaceAfter, workspaceAfter: "33".repeat(32) });
    const fold = utf8(canonicalJson([a, b]));
    const { store, chain, seq } = await sandboxedStep({ blob: fold, genesisAt: [0, 2], checkpointAt: 4 });
    const report = await verifyStepDecision(chain, AGENT, seq, { store });
    const [s] = report.sandboxes!;
    assert.isTrue(s.folded);
    assert.equal(s.posture.verdict, "pass", s.posture.detail);
    assert.include(s.posture.detail, "seq 0 and 2");
    assert.lengthOf(s.workspaces!, 2);
    assert.include(formatStepVerify(report).join("\n"), "(session and synthesis, folded)");
  });

  it("does not fail a step for an unknown build, and says so", async () => {
    const p = posture("ab".repeat(32));
    const { store, chain, seq } = await sandboxedStep({
      blob: replayRecordBytes(record(p)),
      policy: { ...BASE, sandbox: p },
    });
    const report = await verifyStepDecision(chain, AGENT, seq, { store });
    assert.equal(report.sandboxes![0].build.verdict, "unchecked");
    assert.equal(report.verdict, "no-preimage");
    assert.include(formatStepVerify(report).join("\n"), "build    not checkable: unknown build");
  });

  it("says a team step is a roadmap feature's, never verified here, and reads no member's chain", async () => {
    const store = new PlainTraceStore(new MemoryBackend());
    const r = record(posture(), { seqs: ["1"] });
    await store.put(replayRecordBytes(r));
    const manifest = manifestWith({
      members: [
        {
          agentId: hex(MEMBER),
          taskId: "t1",
          outcome: "done",
          seq: "2",
          head: "55".repeat(32),
          replayHash: replayHash(r),
        },
      ],
    });
    const records = await chainOf((b) => store.put(b), BASE, [0], 1, manifest);
    const asked: string[] = [];
    const chain = {
      listEvents: async (id: Uint8Array) => {
        asked.push(hex(id));
        return records;
      },
    };
    const report = await verifyStepDecision(chain, AGENT, 1n, { store });
    assert.deepEqual(asked, [hex(AGENT)], "the member's own chain is not this build's to read");
    assert.isUndefined(report.sandboxes, "a member's replay record is not this build's to check");
    assert.deepEqual(report.roadmap, ["a team"]);
    assert.equal(report.verdict, "no-preimage");
    assert.include(report.reason!, "which this build does not verify");
    assert.equal(stepVerifyExitCode(report), 2);
    const text = formatStepVerify(report).join("\n");
    assert.include(text, "roadmap    written by a team: not verified by this build");
    assert.include(text, "NOT VERIFIED (roadmap feature)");
  });

  it("names every roadmap key a manifest carries, and none on this build's steps", () => {
    assert.deepEqual(roadmapKeysOf(manifestWith({})), []);
    assert.deepEqual(roadmapKeysOf(manifestWith({ replayHash: "aa".repeat(32), members: [] })), []);
    assert.deepEqual(
      roadmapKeysOf(
        manifestWith({ gateHash: "aa".repeat(32), traceAuditHash: "bb".repeat(32), pluginHash: "cc".repeat(32) })
      ),
      ["a gated loop", "a trace audit", "a protocol plugin"]
    );
  });

  it("still fails a roadmap step whose own sandbox contradicts its Genesis", async () => {
    const other = posture("ab".repeat(32));
    const r = record(posture(), { postureHash: postureHash(other) });
    const store = new PlainTraceStore(new MemoryBackend());
    await store.put(replayRecordBytes(r));
    const manifest = manifestWith({ replayHash: replayHash(r), gateHash: "aa".repeat(32) });
    const records = await chainOf((b) => store.put(b), { ...BASE, sandbox: posture() }, [0], 3, manifest);
    const report = await verifyStepDecision({ listEvents: async () => records }, AGENT, 3n, { store });
    assert.deepEqual(report.roadmap, ["a gated loop"]);
    assert.equal(report.verdict, "mismatch", "a contradiction outranks the roadmap note");
    assert.match(report.reason!, /^the step's sandbox: /);
  });

  it("gives a reader without the owner's key a line, not an error", async () => {
    const key = traceKey();
    const backend = new MemoryBackend();
    // Withheld the way a chain written encrypted holds it (this build writes in the clear); opened
    // below by the SDK's WebCrypto reader.
    const owner = new SealingTraceStore(backend, key);
    const plain = new PlainTraceStore(backend);
    const r = record(posture());
    // The record withheld, the Genesis and its policy in the clear: the posture and build still show.
    await owner.put(replayRecordBytes(r));
    const manifest = manifestWith({ replayHash: replayHash(r) });
    const records = await chainOf((b) => plain.put(b), { ...BASE, sandbox: posture() }, [0], 3, manifest);
    const chain = { listEvents: async () => records };
    const outsider = await verifyStepDecision(chain, AGENT, 3n, { store: plain });
    const [s] = outsider.sandboxes!;
    assert.equal(s.replay.verdict, "unchecked");
    assert.include(s.replay.detail, "--trace-key");
    assert.equal(s.posture.verdict, "unchecked");
    assert.include(s.posture.detail, "no record is here to hold it against");
    assert.equal(s.build.verdict, "pass");
    assert.equal(outsider.verdict, "no-preimage");
    const insider = await verifyStepDecision(chain, AGENT, 3n, {
      store: new WebEncryptedTraceStore(backend, key) as unknown as TraceStore,
    });
    assert.deepEqual(
      insider.sandboxes!.map((x) => [x.replay.verdict, x.posture.verdict]),
      [["pass", "pass"]]
    );

    // Everything withheld, the manifest too: the line says what cannot be said, and why.
    const sealed = new MemoryBackend();
    const sealedOwner = new SealingTraceStore(sealed, key);
    const sealedRecords = await chainOf((b) => sealedOwner.put(b), { ...BASE, sandbox: posture() }, [0], 3, manifest);
    const locked = await verifyStepDecision({ listEvents: async () => sealedRecords }, AGENT, 3n, {
      store: new PlainTraceStore(sealed),
    });
    assert.equal(locked.verdict, "encrypted");
    assert.include(
      formatStepVerify(locked).join("\n"),
      "sandbox    not checkable: the step's manifest is not readable"
    );
  });
});
