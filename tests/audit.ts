/**
 * The `lath-audit` CLI's contract — the part an external auditor scripts against: report replay, trace
 * retrievability and the exit-code contract, all over in-memory fixtures.
 */
import { assert } from "chai";
import * as fs from "fs";
import { audit, exitCode, formatReport, openStore, subHashes } from "../scripts/audit";
import { genesisPolicyVersionHash } from "../sdk/src/audit";
import { loopManifestBytes } from "../sdk/src/loops";
import { isBatchRefusal } from "../sdk/src/billing";
import { keyedAudit, LayeredEpochStore, main, readPlan, rpcArg, USAGE } from "../sdk/src/cli";
import {
  AgentLogger,
  BundledTraceStore,
  EncryptedTraceStore,
  EventInput,
  EventKind,
  EventPayload,
  FileTraceStore,
  LOOP_STEP_TOOL,
  MemoryEpochStore,
  encodeEpochBlob,
  epochRootOf,
  payloadPreimage,
  toEventInput,
  FsLocatorBackend,
  LocatorRegistry,
  MemoryBackend,
  MemoryTraceStore,
  NameRecord,
  PlainTraceStore,
  RecordingTraceStore,
  type Lath,
  LathClient,
  encodePayload,
  hex,
  idFromString,
  sha256,
  utf8,
} from "../sdk/src";
import { SealingTraceStore, sealTrace, traceKey } from "./fixtures/sealed-traces";

/**
 * The CLI's own contract — the part an external auditor scripts against. Pure functions over a
 * report plus argument handling, so it needs no validator and CI runs it in the fast job.
 */
describe("lath-audit CLI contract", () => {
  const base = {
    agentId: "aa".repeat(32),
    programId: "AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz",
    authority: "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy",
    seq: "3",
    head: "bb".repeat(32),
    chain: { ok: true, headReached: true, records: 3, missingSeqs: [], recoveredSeqs: [] },
    ok: true,
  };
  /** What `verifyChain` returns for a chain whose tail is a gap: nothing wrong, nothing checked. */
  const unreached = { ...base, ok: false, chain: { ...base.chain, ok: false, headReached: false } };

  it("maps a report to the documented exit codes", () => {
    assert.equal(exitCode(base), 0, "verified");
    assert.equal(
      exitCode({
        ...base,
        ok: false,
        traces: { checked: 1, missing: ["cc".repeat(32)], preimagesUnavailable: [], kindMismatches: [] },
      }),
      2,
      "traces missing"
    );
    assert.equal(
      exitCode({ ...base, ok: false, chain: { ...base.chain, ok: false, firstBadSeq: "2" } }),
      1,
      "a broken chain outranks a missing trace"
    );
    assert.equal(exitCode(unreached), 4, "a replay that never reached the head is not a verified chain");
    assert.equal(
      exitCode({
        ...unreached,
        traces: { checked: 1, missing: ["cc".repeat(32)], preimagesUnavailable: [], kindMismatches: [] },
      }),
      4,
      "an unchecked chain outranks a missing trace, the way a broken one does"
    );
    assert.equal(
      exitCode({ ...unreached, chain: { ...unreached.chain, firstBadSeq: "2" } }),
      1,
      "a head that does not re-fold is broken, not merely unchecked"
    );
  });

  it("renders a report a human can read, and names the broken seq", () => {
    const lines = formatReport({ ...base, ok: false, chain: { ...base.chain, ok: false, firstBadSeq: "2" } });
    assert.include(lines.join("\n"), "chain      BROKEN at seq 2");
    assert.equal(lines[lines.length - 1], "FAILED");
  });

  it("says the head was never reached rather than calling the chain verified", () => {
    const text = formatReport(unreached).join("\n");
    assert.include(text, "chain      HEAD NOT REACHED");
    assert.include(text, "never reached AgentState.head");
    assert.include(text, "--recover");
    assert.notInclude(text, "VERIFIED\n", "the last line must not read VERIFIED");
    assert.equal(formatReport(unreached).pop(), "NOT VERIFIED (head not reached)");
  });

  it("does not call a chain with a gap history does not explain verified", () => {
    // What `verifyChain` returns when an indexer drops a record mid-chain: the fold re-synced at
    // the next record's stored head and reached `AgentState.head`, nothing disagreed — and seq 1
    // was never seen. That must not print OK / VERIFIED and exit 0.
    const hidden = {
      ...base,
      ok: false,
      chain: { ...base.chain, ok: false, missingSeqs: ["1"], unexplainedGaps: ["1"] },
    };
    assert.equal(exitCode(hidden), 4, "unchecked, not broken");
    const text = formatReport(hidden).join("\n");
    assert.include(text, "chain      GAPS NOT ACCOUNTED FOR");
    assert.include(text, "not accounted for: seq 1");
    assert.include(text, "--recover");
    assert.equal(formatReport(hidden).pop(), "NOT VERIFIED (gaps not accounted for)");
    assert.equal(
      exitCode({ ...hidden, chain: { ...hidden.chain, firstBadSeq: "2" } }),
      1,
      "a head that does not re-fold still outranks it"
    );
    // A compact write history does name stays what it was: a gap, reported, and VERIFIED.
    const compact = { ...base, chain: { ...base.chain, missingSeqs: ["1"], unexplainedGaps: [] } };
    assert.equal(exitCode(compact), 0);
    assert.equal(formatReport(compact).pop(), "VERIFIED");
  });

  it("names the set_append_policy rewrites folded from AppendPolicySet, and says nothing when there are none", () => {
    const line = "policy rewrites folded from AppendPolicySet";
    const one = formatReport({ ...base, chain: { ...base.chain, policyRewrites: 1 } });
    assert.include(one.join("\n"), `  ${line}: 1`);
    // A rewrite is folded and checked, not a gap: it changes nothing about the verdict.
    assert.equal(one[one.length - 1], "VERIFIED");
    assert.notInclude(formatReport({ ...base, chain: { ...base.chain, policyRewrites: 0 } }).join("\n"), line);
    // An older report carries no count at all.
    assert.notInclude(formatReport(base).join("\n"), line);
  });

  it("names a preimage whose kind disagrees with the record that points at it", () => {
    const lines = formatReport({
      ...base,
      ok: false,
      traces: {
        checked: 2,
        missing: [],
        preimagesUnavailable: [],
        kindMismatches: [{ payloadHash: "dd".repeat(32), recordKind: 1, preimageKind: 3 }],
      },
    });
    const text = lines.join("\n");
    assert.include(text, `kind disagrees with preimage: ${"dd".repeat(32)} (record 1, preimage 3)`);
    assert.equal(lines[lines.length - 1], "FAILED");
  });

  it("exits 3 on bad usage, and takes the bin name npx may pass through", async () => {
    const errs: string[] = [];
    const err = console.error;
    console.error = (m?: any) => errs.push(String(m));
    try {
      assert.equal(await main([]), 3, "no agent id");
      assert.equal(await main(["lath-audit"]), 3, "the bin name alone is still no agent id");
    } finally {
      console.error = err;
    }
    assert.match(errs.join("\n"), /usage: lath-audit/);
  });

  it("says FAILED (loop key), and ok: false, when --key's check failed on a chain that replays", () => {
    const KEY = "0x5eed00000000000000000000000000000000c0de";
    const keyReport = (status: "ok" | "failed", channel: "ok" | "failed" = "ok") => ({
      agentId: base.agentId,
      key: { status, detail: status === "ok" ? "authorize ok" : "authorize set a limit of 9, not 2500", address: KEY },
      channels: [
        {
          channelId: `0x${"11".repeat(32)}`,
          seqs: ["1"],
          verdict: "verified" as const,
          key: { status: channel, detail: channel === "ok" ? "opened by the key" : "opened by 0xbad", address: KEY },
        },
      ],
      verdict: "verified" as const,
    });
    const failed = keyedAudit(base as any, keyReport("failed"));
    assert.equal(failed.lines[failed.lines.length - 1], "FAILED (loop key)");
    assert.notInclude(failed.lines, "VERIFIED");
    const at = failed.lines.indexOf(`key        ${KEY}`);
    assert.isAbove(at, 0, "the key block is printed");
    assert.isBelow(at, failed.lines.length - 1, "before the verdict");
    assert.equal(failed.code, 2);
    assert.include(failed.json as any, { ok: false });
    assert.match((failed.json as any).reasons[0], /^the loop's Tempo key: \(a\) authorize set a limit of 9/);
    // A channel opened by another signer fails it the same way.
    const signer = keyedAudit(base as any, keyReport("ok", "failed"));
    assert.equal(signer.lines[signer.lines.length - 1], "FAILED (loop key)");
    assert.equal((signer.json as any).ok, false);
    // A key that checks out leaves the report as it was, its block after the verdict.
    const ok = keyedAudit(base as any, keyReport("ok"));
    assert.equal(ok.code, 0);
    assert.equal((ok.json as any).ok, true);
    assert.notProperty(ok.json as any, "reasons");
    assert.include(ok.lines, "VERIFIED");
    assert.equal(ok.lines[ok.lines.length - 1].startsWith("  "), true, "the key block's last line comes last");
    // Without --key the audit's output is formatReport's own.
    assert.deepEqual(keyedAudit(base as any, undefined).lines, formatReport(base as any));
    // An unchecked chain (4) has not failed on its own, so a failed key outranks it: 2 and
    // `FAILED (loop key)`, by the audit's rule that a failure outranks "not checked".
    const unchecked = { ...base, notChecked: ["1 epoch not opened (12 steps): pass --epochs, --store or --gateway"] };
    assert.equal(keyedAudit(unchecked as any, undefined).code, 4);
    const over = keyedAudit(unchecked as any, keyReport("failed"));
    assert.equal(over.code, 2);
    assert.equal(over.lines[over.lines.length - 1], "FAILED (loop key)");
    assert.equal(keyedAudit(unchecked as any, keyReport("ok")).code, 4, "a key that checks out leaves the 4");
  });

  it("takes --rpc on a machine with no RPC in its environment and no `solana` on PATH", () => {
    const url = "http://127.0.0.1:9";
    const noCli = () => {
      throw new Error("no RPC: the CLI fallback was asked");
    };
    // The line the console prints, on a clean machine: the fallbacks are never reached.
    assert.equal(rpcArg(["aa".repeat(32), "--rpc", url], {}, noCli), url);
    assert.equal(rpcArg(["verify-charge", "--rpc", url, "--json"], {}, noCli), url);
    // The real fallback, with nothing on PATH, is not evaluated either.
    const path = process.env.PATH;
    const saved = { d: process.env.LATH_DEVNET_RPC, r: process.env.LATH_RPC_URL };
    process.env.PATH = "";
    delete process.env.LATH_DEVNET_RPC;
    delete process.env.LATH_RPC_URL;
    try {
      assert.equal(rpcArg(["x", "--rpc", url]), url);
      assert.throws(() => rpcArg(["x"]), /no RPC: pass --rpc/);
    } finally {
      process.env.PATH = path;
      if (saved.d !== undefined) process.env.LATH_DEVNET_RPC = saved.d;
      if (saved.r !== undefined) process.env.LATH_RPC_URL = saved.r;
    }
    // The order is unchanged: --rpc, then the environment, then the CLI.
    assert.equal(rpcArg(["x"], { LATH_DEVNET_RPC: "d", LATH_RPC_URL: "r" }, noCli), "d");
    assert.equal(rpcArg(["x"], { LATH_RPC_URL: "r" }, noCli), "r");
    assert.equal(rpcArg(["x", "--rpc", url], { LATH_DEVNET_RPC: "d" }, noCli), url);
    assert.equal(
      rpcArg(["x"], {}, () => "cli"),
      "cli"
    );
  });

  it("layers --store, --gateway and the Irys reader rather than making the caller choose", () => {
    const irys = { url: "https://gateway.irys.xyz", scheme: 4, encoding: "base64url" as const };
    // A console on the `irys` backend keeps trace blobs on disk and epochs at Irys, and a chain
    // that flipped backends carries both schemes: one plan reads all of it.
    assert.deepEqual(readPlan(["--store", ".traces", "--gateway", "http://localhost:3000/api/traces"]), {
      store: ".traces",
      epochs: undefined,
      gateways: [{ url: "http://localhost:3000/api/traces", scheme: 0, encoding: "hex" }, irys],
    });
    // Scheme 4 always has somewhere to go: naming it, or naming a directory, is enough.
    assert.deepEqual(readPlan(["--scheme", "4"]).gateways, [irys]);
    assert.deepEqual(readPlan(["--store", ".traces"]).gateways, [irys]);
    assert.deepEqual(readPlan(["--epochs", "ep"]), { store: undefined, epochs: "ep", gateways: [irys] });
    // The line the console has always printed for an Irys chain names that reader once, not twice.
    assert.deepEqual(readPlan(["--gateway", irys.url, "--scheme", "4", "--encoding", "base64url"]).gateways, [irys]);
    assert.deepEqual(readPlan(["--store", "d", "--irys-gateway", "http://irys.local"]).gateways, [
      { ...irys, url: "http://irys.local" },
    ]);
    // Nothing named is a chain-only audit, exactly as before.
    assert.deepEqual(readPlan([]), { store: undefined, epochs: undefined, gateways: [] });
    assert.throws(() => readPlan(["--gateway", "x", "--scheme", "300"]), /--scheme must be a u8/);
    assert.throws(() => readPlan(["--gateway", "x", "--encoding", "utf8"]), /--encoding is hex or base64url/);
  });

  it("prints a verified published name next to the id, and nothing when it does not verify", () => {
    assert.include(formatReport({ ...base, name: "agent-alpha" })[0], "(agent-alpha)");
    assert.notInclude(formatReport(base)[0], "(");
    assert.match(USAGE, /--name-check/);
  });

  it("reads a genesis policy_version_hash at its fixed offset, and nothing else's", () => {
    // `subHashes` returns the *fetchable* leaves, so for a genesis it returns the input
    // payload hash at 96 and not the policy hash — which could make a walk read 96 as the
    // policy hash and reason its way to an offset of 65 from a 33-byte caller. The caller is 32
    // bytes like everything else; 65 is right only for the blob a trace store holds, which is
    // `kind ‖ encodePayload(p)`. This is the accessor that says so once.
    const payload = {
      kind: EventKind.Genesis as const,
      sessionId: "session-1",
      callerPubkey: sha256(utf8("caller")),
      policyVersionHash: sha256(utf8("policy v1")),
      inputPayloadHash: sha256(utf8("the prompt")),
    };
    const encoding = encodePayload(payload);
    assert.lengthOf(encoding, 128);
    assert.equal(hex(genesisPolicyVersionHash(EventKind.Genesis, encoding)!), hex(sha256(utf8("policy v1"))));
    // And it is not what `subHashes` returns, which is the input hash: the two are adjacent and
    // confusing them is exactly the mistake this exists to stop.
    assert.equal(hex(subHashes(EventKind.Genesis, encoding)[0]), hex(sha256(utf8("the prompt"))));

    // In the stored blob the same field is one byte further along.
    const stored = new Uint8Array([EventKind.Genesis, ...encoding]);
    assert.equal(hex(stored.slice(65, 97)), hex(sha256(utf8("policy v1"))));

    // Only a genesis has one, and a truncated encoding has none rather than 32 bytes of whatever.
    assert.isNull(genesisPolicyVersionHash(EventKind.Action, encoding));
    assert.isNull(genesisPolicyVersionHash(EventKind.Genesis, encoding.slice(0, 100)));
  });

  it("reads the fetchable leaf of a delegation and a resolution at their fixed offsets", () => {
    // Genesis (96) and Action (32, 64) are pinned by the case above and by the walk; Delegation's
    // 96 and Resolution's 33 were not pinned anywhere. A wrong constant in either is invisible
    // until a chain read is wrong: `audit` reports the leaf as `missing`, an otherwise-good chain
    // exits 2, and every agent with a terminal Resolution fails for a reason that is not the one
    // printed. Offsets derived from SPEC.md §3, not from `subHashes`:
    //   Delegation  parent_task_id[32] ‖ from[32] ‖ to[32] ‖ scope_hash[32]   → 96, length 128
    //   Resolution  task_id[32] ‖ status u8 ‖ final_output_hash[32] ‖ steps u32 → 33, length 69
    const scope = sha256(utf8("the scope"));
    const delegation = encodePayload({
      kind: EventKind.Delegation as const,
      parentTaskId: "task-1",
      fromAgentPubkey: sha256(utf8("from")),
      toAgentPubkey: sha256(utf8("to")),
      scopeHash: scope,
    });
    assert.lengthOf(delegation, 128);
    assert.equal(hex(subHashes(EventKind.Delegation, delegation)[0]), hex(scope));

    const output = sha256(utf8("the answer"));
    const resolution = encodePayload({
      kind: EventKind.Resolution as const,
      taskId: "task-1",
      status: 0,
      finalOutputHash: output,
      totalStepCount: 3,
    });
    assert.lengthOf(resolution, 69);
    assert.equal(hex(subHashes(EventKind.Resolution, resolution)[0]), hex(output));

    // A short encoding yields nothing, not 32 bytes of whatever follows.
    assert.deepEqual(subHashes(EventKind.Resolution, resolution.slice(0, 68)), []);
    assert.deepEqual(subHashes(EventKind.Delegation, delegation.slice(0, 127)), []);
  });

  it("tells a batch refusal from a plain rate limit", () => {
    // The batch fallback fires up to a hundred sequential `getTransaction` calls in place of one
    // batch, which is the right answer to "this node will not do batches" and the worst possible
    // answer to "this node is rate-limiting you". Both halves are asserted here, so the regex
    // cannot drift back to the bare phrase with nothing turning red — the symptom is a billing page reading *No escrow
    // activity yet*, or an RPC ban.
    assert.isTrue(isBatchRefusal(new Error("-32403 Batch requests are only available for paid plans")));
    assert.isTrue(isBatchRefusal(new Error('HTTP 413: {"code":-32413,"message":"Payload too large"}')));
    assert.isTrue(isBatchRefusal(new Error("batch is too large")));
    assert.isFalse(
      isBatchRefusal(new Error("429 Too Many Requests")),
      "a plain rate limit must not answer with a hundred sequential reads"
    );
    assert.isFalse(isBatchRefusal(new Error("fetch failed")));
  });

  it("advertises the gateway flags in its usage", () => {
    assert.match(USAGE, /--gateway <url>/);
    assert.match(USAGE, /--encoding hex\|base64url/);
    assert.match(USAGE, /--trace-key <hex\|path>/);
  });

  /**
   * A chain with no validator behind it: `records` are what `listEvents` answers and `epochs` what
   * `verifyChain` found folded. What is under test is what the audit does with a chain, not how it
   * reads one — `describe("lath-audit")` above does that against the Light stack.
   */
  function stubChainOf(
    records: { seq: bigint; kind: number; status: number; reference: Uint8Array; payloadHash: Uint8Array }[],
    epochs: { root: Uint8Array; startSeq: bigint; endSeq: bigint }[] = []
  ): LathClient {
    const seq = epochs.reduce((n, e) => (e.endSeq > n ? e.endSeq : n), BigInt(records.length));
    return {
      programId: { toBase58: () => "AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz" },
      getAgentState: async () => ({ state: { authority: { toBase58: () => "stub-authority" } } }),
      verifyChain: async () => ({
        ok: true,
        headReached: true,
        records: records.length,
        seq,
        head: new Uint8Array(32),
        missingSeqs: [],
        recoveredSeqs: [],
        resyncedSeqs: [],
        epochs: epochs.map((e) => ({
          agentId: new Uint8Array(32),
          epochRoot: e.root,
          startSeq: e.startSeq,
          endSeq: e.endSeq,
          head: new Uint8Array(32),
          signature: "stub",
          slot: 0,
          blockTime: null,
        })),
      }),
      listEvents: async () => records,
    } as unknown as LathClient;
  }

  /** A record exactly as `toEventInput` would have written it for `payload`, at `seq`. */
  function recordOf(seq: bigint, payload: EventPayload) {
    const input = toEventInput(payload, 1_700_000_000_000);
    return { seq, kind: input.kind, status: input.status, reference: input.reference, payloadHash: input.payloadHash };
  }

  /**
   * Three LLM Actions folded into one epoch, with the blobs a loop's session would have stored:
   * each payload preimage and its two leaves. `startSeq` is where the epoch begins.
   */
  function epochFixture(startSeq: bigint) {
    const leaves = [0, 1, 2].map((i) => ({ args: utf8(`step ${i} request`), result: utf8(`step ${i} answer`) }));
    const payloads: EventPayload[] = leaves.map((l) => ({
      kind: EventKind.Action,
      toolId: "llm.x",
      argsHash: sha256(l.args),
      resultHash: sha256(l.result),
      statusCode: 200,
    }));
    const inputs: EventInput[] = payloads.map((p) => toEventInput(p, 1_700_000_000_000));
    const root = epochRootOf(startSeq, inputs);
    const epochs = new MemoryEpochStore();
    const blobStored = epochs.put(root, encodeEpochBlob(startSeq, inputs));
    return {
      payloads,
      leaves,
      inputs,
      epoch: { root, startSeq, endSeq: startSeq + 3n },
      epochs: blobStored.then(() => epochs),
      /** A plain store holding the preimages and every leaf, minus whatever `without` names. */
      async store(without: Uint8Array[] = []) {
        const store = new MemoryTraceStore();
        const skip = new Set(without.map(hex));
        const put = async (b: Uint8Array) => void (skip.has(hex(sha256(b))) ? null : await store.put(b));
        for (const p of payloads) await put(payloadPreimage(p));
        for (const l of leaves) {
          await put(l.args);
          await put(l.result);
        }
        return store;
      },
    };
  }

  describe("an epoch chain audited with no reader for its epochs", () => {
    it("is NOT VERIFIED, exit 4, and says which flag opens them", async () => {
      const f = epochFixture(0n);
      const report = await audit(stubChainOf([], [f.epoch]), idFromString("audit-epoch"));
      assert.isFalse(report.ok, "a chain whose steps nobody opened has not been verified");
      assert.lengthOf(report.notChecked!, 1);
      assert.include(report.notChecked![0], "1 epoch not opened (3 steps)");
      assert.equal(exitCode(report), 4, "unchecked, which is 4's meaning — not wrong, which is 2's");
      const lines = formatReport(report);
      assert.include(lines.join("\n"), "--epochs");
      assert.equal(lines.pop(), "NOT VERIFIED (epochs not opened)");
    });

    it("is VERIFIED once the epoch is opened and rebuilds its root", async () => {
      const f = epochFixture(0n);
      const report = await audit(stubChainOf([], [f.epoch]), idFromString("audit-epoch"), { epochs: await f.epochs });
      assert.isTrue(report.ok);
      assert.isUndefined(report.notChecked);
      assert.equal(exitCode(report), 0);
      assert.equal(formatReport(report).pop(), "VERIFIED");
    });

    it("never counts an epoch a layer could not read as missing, and still takes a later layer's bytes", async () => {
      const f = epochFixture(0n);
      // What `FileEpochStore.get` throws for an `--epochs` directory this process cannot read.
      const unreadable = {
        put: async () => undefined,
        get: async () => {
          throw Object.assign(new Error("EACCES: permission denied, open 'ep/…'"), { code: "EACCES" });
        },
      };
      const chain = stubChainOf([], [f.epoch]);
      const id = idFromString("audit-epoch");

      // The gateway layer behind it has the bytes: the audit re-derives the root, so they verify.
      const behind = await audit(chain, id, { epochs: new LayeredEpochStore([unreadable, await f.epochs]) });
      assert.isTrue(behind.ok);
      assert.deepEqual(behind.epochs?.missing, []);

      // Nobody has them: the read error is the answer, never a missing epoch that fails the chain.
      let thrown: any;
      try {
        await audit(chain, id, { epochs: new LayeredEpochStore([unreadable, new MemoryEpochStore()]) });
      } catch (e) {
        thrown = e;
      }
      assert.equal(thrown?.code, "EACCES");

      // Every layer answering null is still the missing epoch it always was.
      const none = await audit(chain, id, { epochs: new LayeredEpochStore([new MemoryEpochStore()]) });
      assert.deepEqual(none.epochs?.missing, [hex(f.epoch.root)]);
      assert.equal(exitCode(none), 2);
    });

    it("still exits 2 when something else failed too", async () => {
      const f = epochFixture(0n);
      const report = await audit(stubChainOf([], [f.epoch]), idFromString("audit-epoch"), {
        traceHashes: [sha256(utf8("a trace nobody kept"))],
      });
      assert.isFalse(report.ok);
      assert.isUndefined(report.notChecked, "a real failure is the more useful answer");
      assert.equal(exitCode(report), 2);
      assert.equal(formatReport(report).pop(), "FAILED");
    });
  });

  describe("the steps inside an epoch are walked like records", () => {
    const id = idFromString("audit-epoch-steps");

    it("fails --require-preimages when the store holds none of their preimages", async () => {
      // The probe: a walk that skipped epochs would print "traces all retrievable (0 checked) | VERIFIED".
      const f = epochFixture(0n);
      const report = await audit(stubChainOf([], [f.epoch]), id, {
        epochs: await f.epochs,
        store: new PlainTraceStore(new MemoryBackend()),
        requirePreimages: true,
      });
      assert.lengthOf(report.traces!.preimagesUnavailable, 3);
      assert.isFalse(report.ok);
      assert.equal(exitCode(report), 2);
    });

    // Absent bytes are the reader's gap; other bytes under the hash are the store disagreeing with
    // the chain, and the default audit must not count them as merely unavailable.
    it("fails a preimage the store holds as other bytes, even without --require-preimages", async () => {
      const f = epochFixture(0n);
      const backend = new MemoryBackend();
      const edited = payloadPreimage(f.payloads[1]).slice();
      edited[98] ^= 1;
      for (const p of f.payloads) {
        const bytes = payloadPreimage(p);
        await backend.set(hex(sha256(bytes)), p === f.payloads[1] ? edited : bytes);
      }
      for (const l of f.leaves) {
        await backend.set(hex(sha256(l.args)), l.args);
        await backend.set(hex(sha256(l.result)), l.result);
      }
      const report = await audit(stubChainOf([], [f.epoch]), id, {
        epochs: await f.epochs,
        store: new PlainTraceStore(backend),
      });
      const payloadHash = hex(sha256(payloadPreimage(f.payloads[1])));
      assert.deepEqual(report.traces!.preimagesEdited, [{ seq: "1", payloadHash }]);
      assert.deepEqual(report.traces!.preimagesUnavailable, []);
      assert.isFalse(report.ok);
      assert.equal(exitCode(report), 2);
      const lines = formatReport(report).join("\n");
      assert.include(lines, "1 EDITED");
      assert.include(lines, `payload preimage edited: seq 1 ${payloadHash}`);
    });

    it("fails on a missing leaf even without --require-preimages", async () => {
      const f = epochFixture(0n);
      const lost = sha256(f.leaves[1].args);
      const report = await audit(stubChainOf([], [f.epoch]), id, {
        epochs: await f.epochs,
        store: await f.store([lost]),
      });
      assert.deepEqual(report.traces!.missing, [hex(lost)]);
      assert.isFalse(report.ok, "a leaf the chain commits and nobody kept fails, as it does under a record");
      assert.equal(exitCode(report), 2);
    });

    it("verifies when every preimage and leaf is there, and says it walked the epoch", async () => {
      const f = epochFixture(0n);
      const report = await audit(stubChainOf([], [f.epoch]), id, {
        epochs: await f.epochs,
        store: await f.store(),
        requirePreimages: true,
      });
      assert.isTrue(report.ok, JSON.stringify(report.traces));
      assert.equal(report.traces!.checked, 9, "three preimages and six leaves");
      assert.equal(report.traces!.epochSteps, 3);
      assert.include(formatReport(report).join("\n"), "(9 checked, 3 steps inside epochs)");
    });

    it("walks a compact log refilled under --recover, which has no account to list", async () => {
      const f = epochFixture(0n);
      const compact = recordOf(0n, f.payloads[0]);
      const client = stubChainOf([]);
      const verify = client.verifyChain.bind(client);
      Object.assign(client as unknown as Record<string, unknown>, {
        verifyChain: async () => ({ ...(await verify(new Uint8Array(32))), recoveredSeqs: [0n] }),
        recoverCompactEvents: async () => [compact],
      });
      const lost = sha256(f.leaves[0].result);
      const report = await audit(client, id, { store: await f.store([lost]), recover: true });
      assert.equal(report.traces!.recovered, 1);
      assert.deepEqual(report.traces!.missing, [hex(lost)], "its leaves are held to the record rules");
      assert.include(formatReport(report).join("\n"), "1 recovered from history");
    });

    it("opens the session at its genesis before asking for any step inside the epoch", async () => {
      // A bundle reader answers a session's hashes only after `openSession`, so the walk has to
      // reach seq 0 before seq 1 whatever order the sources came in.
      const f = epochFixture(1n);
      const input = utf8("the prompt");
      const genesis: EventPayload = {
        kind: EventKind.Genesis,
        sessionId: "s1",
        callerPubkey: sha256(utf8("caller")),
        policyVersionHash: sha256(utf8("policy")),
        inputPayloadHash: sha256(input),
      };
      const inner = await f.store();
      await inner.put(payloadPreimage(genesis));
      await inner.put(input);
      const calls: string[] = [];
      const scoped = {
        put: (b: Uint8Array) => inner.put(b),
        get: async (h: Uint8Array) => {
          calls.push(`get ${hex(h)}`);
          return inner.get(h);
        },
        openSession: async (h: Uint8Array) => {
          calls.push(`open ${hex(h)}`);
          return 1;
        },
      };
      const g = recordOf(0n, genesis);
      const report = await audit(stubChainOf([g], [f.epoch]), id, { epochs: await f.epochs, store: scoped });
      assert.isTrue(report.ok, JSON.stringify(report.traces));
      assert.equal(calls[0], `open ${hex(g.payloadHash)}`);
      const firstStep = calls.indexOf(`get ${hex(f.inputs[0].payloadHash)}`);
      assert.isAbove(firstStep, 0, "the epoch's first step was asked for, after the session opened");
    });
  });

  describe("a record whose status or tool id is not its payload's", () => {
    const id = idFromString("audit-fields");

    async function chainWith(record: (p: EventPayload) => ReturnType<typeof recordOf>, payload: EventPayload) {
      const store = new MemoryTraceStore();
      await store.put(payloadPreimage(payload));
      await store.put(utf8("args"));
      await store.put(utf8("result"));
      return { client: stubChainOf([record(payload)]), store };
    }
    const some: EventPayload = {
      kind: EventKind.Action,
      toolId: "some.tool",
      argsHash: sha256(utf8("args")),
      resultHash: sha256(utf8("result")),
      statusCode: 200,
    };

    it("fails, and disputes a goal claim the payload does not make", async () => {
      // The probe: a loop.step at 201 over a some.tool/200 payload must not read ok, goal reached.
      const { client, store } = await chainWith(
        (p) => ({ ...recordOf(0n, p), status: 201, reference: idFromString(LOOP_STEP_TOOL) }),
        some
      );
      const report = await audit(client, id, { store });
      const mismatches = report.traces!.fieldMismatches!;
      assert.lengthOf(mismatches, 2);
      assert.deepEqual(
        mismatches.map((m) => m.field),
        ["status", "reference"]
      );
      assert.equal(mismatches[0].record, "201");
      assert.equal(mismatches[0].preimage, "200");
      assert.equal(report.goalReached![0].terminal, "disputed");
      assert.isFalse(report.ok);
      assert.equal(exitCode(report), 2);
      const text = formatReport(report).join("\n");
      assert.include(text, "record disagrees with its preimage: seq 0 status 201 (preimage 200)");
      assert.include(text, "the claim is the record's word only");
    });

    it("finds nothing to say about a consistent loop.step at 201", async () => {
      const { client, store } = await chainWith((p) => recordOf(0n, p), {
        ...some,
        toolId: LOOP_STEP_TOOL,
        statusCode: 201,
      });
      const report = await audit(client, id, { store });
      assert.deepEqual(report.traces!.fieldMismatches, []);
      assert.lengthOf(report.goalReached!, 1);
      assert.notEqual(report.goalReached![0].terminal, "disputed");
      assert.isTrue(report.ok);
    });
  });

  describe("an owner-encrypted chain", () => {
    // No validator: the chain is a two-record stub, because what is under test is what the audit
    // does with bytes it cannot read, not how it reads a chain (`tests/audit.ts` above does that).
    //
    // The payloads are real encodings, at the real preimage sizes (129 and 99 bytes): an encrypted
    // preimage has to be exactly the size ciphertext of its kind's preimage can be, and stub bytes
    // (128 and 98) would be no real preimage's size.
    const agentId = idFromString("audit-encrypted");
    const leaves = [utf8("the prompt"), utf8('{"u":"x"}'), utf8('{"ok":true}')];
    const payloads: EventPayload[] = [
      {
        kind: EventKind.Genesis,
        sessionId: "s1",
        callerPubkey: sha256(utf8("caller")),
        policyVersionHash: sha256(utf8("policy")),
        inputPayloadHash: sha256(leaves[0]),
      },
      {
        kind: EventKind.Action,
        toolId: "http.get",
        argsHash: sha256(leaves[1]),
        resultHash: sha256(leaves[2]),
        statusCode: 200,
      },
    ];
    const preimages = payloads.map(payloadPreimage);

    function stubChain(): LathClient {
      return stubChainOf(payloads.map((p, i) => recordOf(BigInt(i + 1), p)));
    }

    /**
     * A console store written encrypted: every blob the session wrote, encrypted under the agent's
     * key (`tests/fixtures/sealed-traces.ts`; this build writes in the clear).
     */
    async function encryptedStore(key: Uint8Array) {
      const backend = new MemoryBackend();
      const store = new SealingTraceStore(backend, key);
      for (const b of [...preimages, ...leaves]) await store.put(b);
      return { backend, key };
    }

    it("pins the preimage sizes the encrypted check is bound to", () => {
      assert.deepEqual(
        preimages.map((p) => p.length),
        [129, 99]
      );
    });

    it("reports an unreadable preimage as encrypted, and passes an audit that did not ask for preimages", async () => {
      const { backend } = await encryptedStore(traceKey());
      const report = await audit(stubChain(), agentId, { store: new PlainTraceStore(backend) });
      assert.lengthOf(report.traces!.preimagesEncrypted!, preimages.length);
      assert.isTrue(report.ok, "withheld bytes are not a failed audit");
      assert.isUndefined(report.notChecked);
      assert.equal(exitCode(report), 0);
      assert.include(formatReport(report).join("\n"), "--trace-key");
      assert.equal(formatReport(report).pop(), "VERIFIED");
    });

    it("does not let encrypted preimages satisfy --require-preimages without a key", async () => {
      const { backend } = await encryptedStore(traceKey());
      // A reader with no key: the bytes are served, they are ciphertext, and that is a third
      // answer beside "retrievable" and "gone".
      const report = await audit(stubChain(), agentId, {
        store: new PlainTraceStore(backend),
        requirePreimages: true,
      });
      assert.deepEqual(report.traces!.preimagesUnavailable, [], "nothing is missing here");
      assert.lengthOf(report.traces!.preimagesEncrypted!, preimages.length);
      assert.isUndefined(report.traces!.encryptedLegacy, "every blob is LTE2");
      assert.deepEqual(report.traces!.missing, []);
      // Not a failure — the owner withheld the bytes, nothing disagreed — but a reader who asked
      // for every preimage has read none of these: the sub-hashes, tool ids and goal claims inside
      // them are unchecked. That must not print VERIFIED and exit 0.
      assert.isFalse(report.ok, "an audit that opened none of the preimages it required is not verified");
      assert.deepEqual(report.notChecked, [
        `${preimages.length} encrypted preimages not opened: pass --trace-key <hex|path>`,
      ]);
      assert.equal(exitCode(report), 4, "not checked, not failed");
      const text = formatReport(report).join("\n");
      assert.include(text, `payload preimages encrypted: ${preimages.length}`);
      assert.include(text, "--trace-key");
      assert.equal(formatReport(report).pop(), "NOT VERIFIED (encrypted preimages not opened)");
    });

    it("does not verify --require-preimages when nothing was given to read them from", async () => {
      // No --store, --gateway or --traces: the walk never runs, so no preimage is missing and none
      // is encrypted — and the flag must not pass by default, VERIFIED and exit 0 over an audit that
      // fetched nothing. It is the reader's gap, like an unopened epoch: not checked, exit 4.
      const report = await audit(stubChain(), agentId, { requirePreimages: true });
      assert.isUndefined(report.traces, "nothing was walked");
      assert.isFalse(report.ok);
      assert.deepEqual(report.notChecked, ["--require-preimages with no preimage reader: pass --store or --gateway"]);
      assert.equal(exitCode(report), 4);
      assert.equal(formatReport(report).pop(), "NOT VERIFIED (no preimage reader given)");
      // Without the flag the same structure-only audit is what it always was.
      assert.equal(exitCode(await audit(stubChain(), agentId, {})), 0);
    });

    it("does not take a header and some zeros for an encrypted preimage", async () => {
      // The probe: "LTE1" and 28 zero bytes must not read as "payload preimages encrypted: 1 …
      // VERIFIED". A header is four bytes anyone can write; the size is what binds.
      const backend = new MemoryBackend();
      const junk = new Uint8Array([...utf8("LTE1"), ...new Uint8Array(28)]);
      for (const p of preimages) await backend.set(hex(sha256(p)), junk);
      const report = await audit(stubChain(), agentId, {
        store: new PlainTraceStore(backend),
        requirePreimages: true,
      });
      assert.deepEqual(report.traces!.preimagesEncrypted, []);
      assert.lengthOf(report.traces!.preimagesUnavailable, 2);
      assert.isFalse(report.ok);
      assert.equal(exitCode(report), 2);
    });

    it("fails a genuine LTE2 blob of other bytes filed under this hash", async () => {
      const key = traceKey();
      const { backend } = await encryptedStore(key);
      // Real ciphertext, under the right key even — of a different plaintext, whose hash its
      // header names in the clear.
      const other = sealTrace(key, utf8("another blob"));
      backend.set(hex(sha256(preimages[1])), other.blob);
      const report = await audit(stubChain(), agentId, { store: new PlainTraceStore(backend) });
      const refused = report.traces!.unopenable!;
      assert.lengthOf(refused, 1);
      assert.equal(refused[0].seq, "2");
      assert.include(refused[0].reason, `names another hash ${hex(other.hash)}`);
      assert.lengthOf(report.traces!.preimagesEncrypted!, 1, "the genesis is still the owner's to withhold");
      assert.isFalse(report.ok);
      assert.equal(formatReport(report).pop(), "FAILED");
    });

    it("still counts an older LTE1 preimage of the right size as encrypted", async () => {
      // Devnet carries LTE1 blobs, and they have to keep auditing: the size is the only check an
      // audit without the key can make of one, and the report says that is all it was.
      const key = traceKey();
      const { backend } = await encryptedStore(key);
      backend.set(hex(sha256(preimages[1])), sealTrace(key, preimages[1], "LTE1").blob);
      const report = await audit(stubChain(), agentId, {
        store: new PlainTraceStore(backend),
        requirePreimages: true,
      });
      assert.lengthOf(report.traces!.preimagesEncrypted!, 2);
      assert.equal(report.traces!.encryptedLegacy, 1);
      // Counted as encrypted, not unavailable: the same "not opened" as LTE2 under the flag, and no
      // worse.
      assert.deepEqual(report.traces!.preimagesUnavailable, []);
      assert.equal(exitCode(report), 4);
      assert.include(formatReport(report).join("\n"), "1 in the older LTE1 format");
      assert.equal(formatReport(report).pop(), "NOT VERIFIED (encrypted preimages not opened)");
    });

    it("names the blob that will not open with this key, and walks on past it", async () => {
      const key = traceKey();
      const backend = new MemoryBackend();
      const mine = new SealingTraceStore(backend, key);
      await mine.put(preimages[0]);
      await mine.put(leaves[0]);
      // One blob written under somebody else's key: the shape the devnet chain had, where every
      // other blob opened and the audit still ended as one library sentence naming nothing.
      await new SealingTraceStore(backend, traceKey()).put(preimages[1]);
      const report = await audit(stubChain(), agentId, {
        store: new EncryptedTraceStore(backend, key),
        requirePreimages: true,
      });
      const refused = report.traces!.unopenable!;
      assert.lengthOf(refused, 1);
      assert.equal(refused[0].seq, "2", "reported against the record whose walk asked for it");
      assert.equal(refused[0].kind, EventKind.Action);
      assert.equal(refused[0].hash, hex(sha256(preimages[1])));
      assert.equal(report.traces!.checked, 2, "the record before it, and its leaf, were still checked");
      assert.isFalse(report.ok, "bytes that refuse the key are not a chain anybody verified");
      assert.equal(exitCode(report), 2);
      const text = formatReport(report).join("\n");
      assert.include(text, `could not be opened with this key: ${hex(sha256(preimages[1]))}`);
      assert.include(text, "seq 2");
      assert.include(text, "UNOPENABLE");
      assert.equal(formatReport(report).pop(), "FAILED");
    });

    it("verifies the same chain through the key", async () => {
      const key = traceKey();
      const { backend } = await encryptedStore(key);
      const report = await audit(stubChain(), agentId, {
        store: new EncryptedTraceStore(backend, key),
        requirePreimages: true,
      });
      assert.deepEqual(report.traces!.preimagesEncrypted, [], "with the key there is nothing withheld");
      assert.deepEqual(report.traces!.preimagesUnavailable, []);
      assert.deepEqual(report.traces!.fieldMismatches, [], "and every record agrees with the payload it commits");
      assert.equal(report.traces!.checked, 5, "two preimages and three leaves");
      assert.isTrue(report.ok);
      assert.equal(formatReport(report).pop(), "VERIFIED");
    });
  });
  describe("a loop step resumes from what its loop's last checkpoint committed", () => {
    const id = idFromString("audit-memory-link");
    const loopId = "loop-memory-link";
    const memory = (n: number) => hex(sha256(utf8(`memory after step ${n}`)));

    /**
     * One loop on one chain: per step, the session's genesis and then its `loop.step` checkpoint,
     * with the blobs a console would have stored. `resumed` is what each step's genesis says it
     * stood on; `committed` what each checkpoint's manifest commits. `extra` genesis sessions are
     * written after a step's own, the way a synthesis session is.
     */
    async function loopChain(
      steps: { step: number; resumed?: string; committed?: string; extra?: { sessionId: string; resumed: string } }[]
    ) {
      const store = new MemoryTraceStore();
      const records: ReturnType<typeof recordOf>[] = [];
      const genesisOf = async (sessionId: string, resumed?: string) => {
        const input = utf8(JSON.stringify({ prompt: "p", ...(resumed ? { memoryHash: resumed } : {}) }));
        await store.put(input);
        const payload: EventPayload = {
          kind: EventKind.Genesis,
          sessionId,
          callerPubkey: sha256(utf8("caller")),
          policyVersionHash: sha256(utf8("policy")),
          inputPayloadHash: sha256(input),
        };
        await store.put(payloadPreimage(payload));
        records.push(recordOf(BigInt(records.length), payload));
      };
      for (const s of steps) {
        await genesisOf(`${loopId}:step-${s.step}`, s.resumed);
        if (s.extra) await genesisOf(s.extra.sessionId, s.extra.resumed);
        const manifest = loopManifestBytes({
          loopId,
          step: s.step,
          intervalMs: 60_000,
          maxSteps: 10,
          promptHash: hex(sha256(utf8("p"))),
          startedAt: 1_700_000_000_000,
          ...(s.committed ? { memoryHash: s.committed } : {}),
        });
        const leaf = utf8(`leaf of step ${s.step}`);
        await store.put(manifest);
        await store.put(leaf);
        const payload: EventPayload = {
          kind: EventKind.Action,
          toolId: LOOP_STEP_TOOL,
          argsHash: sha256(manifest),
          resultHash: sha256(leaf),
          statusCode: 200,
        };
        await store.put(payloadPreimage(payload));
        records.push(recordOf(BigInt(records.length), payload));
      }
      return { client: stubChainOf(records), store };
    }

    it("is VERIFIED when every step stood on the memory the checkpoint before it committed", async () => {
      const { client, store } = await loopChain([
        { step: 1, committed: memory(1) },
        { step: 2, resumed: memory(1), committed: memory(2) },
        { step: 3, resumed: memory(2), committed: memory(3) },
      ]);
      const report = await audit(client, id, { store, requirePreimages: true });
      assert.deepEqual(
        report.memoryLinks!.map((l) => l.link),
        ["ok", "ok"],
        "the first step has nothing before it to stand on"
      );
      assert.isTrue(report.ok, JSON.stringify(report.memoryLinks));
      assert.include(formatReport(report).join("\n"), "memory     2 of 2 loop steps resumed");
    });

    it("FAILS when a step's genesis stood on a memory the checkpoint before it did not commit", async () => {
      const elsewhere = hex(sha256(utf8("a memory no checkpoint committed")));
      const { client, store } = await loopChain([
        { step: 1, committed: memory(1) },
        { step: 2, resumed: elsewhere, committed: memory(2) },
      ]);
      const report = await audit(client, id, { store });
      assert.deepEqual(report.memoryLinks, [
        { seq: "3", loopId, step: 2, committed: memory(1), resumed: elsewhere, link: "mismatch" },
      ]);
      assert.isFalse(report.ok);
      assert.equal(exitCode(report), 2);
      assert.include(
        formatReport(report).join("\n"),
        `resumed from ${elsewhere}, but the checkpoint before it committed`
      );
    });

    it("links across a failed step, which writes no checkpoint and leaves the memory where it was", async () => {
      const { client, store } = await loopChain([
        { step: 1, committed: memory(1) },
        { step: 3, resumed: memory(1), committed: memory(3) },
      ]);
      const report = await audit(client, id, { store });
      assert.deepEqual(
        report.memoryLinks!.map((l) => l.link),
        ["ok"]
      );
      assert.isTrue(report.ok);
    });

    it("checks the step's own session, not a synthesis session written after it", async () => {
      const { client, store } = await loopChain([
        { step: 1, committed: memory(1) },
        {
          step: 2,
          resumed: memory(1),
          committed: memory(2),
          extra: { sessionId: `${loopId}:step-2:synthesis`, resumed: hex(sha256(utf8("session A's output"))) },
        },
      ]);
      const report = await audit(client, id, { store });
      assert.deepEqual(
        report.memoryLinks!.map((l) => l.link),
        ["ok"]
      );
      assert.isTrue(report.ok);
    });

    it("reports a step that ignored its loop's memory without failing the chain", async () => {
      const { client, store } = await loopChain([
        { step: 1, committed: memory(1) },
        { step: 2, committed: memory(2) },
      ]);
      const report = await audit(client, id, { store });
      assert.deepEqual(
        report.memoryLinks!.map((l) => l.link),
        ["not-resumed"]
      );
      assert.isTrue(report.ok, "a step that claims no memory does not contradict the one committed");
      assert.include(formatReport(report).join("\n"), `started without the memory ${memory(1)}`);
    });

    it("says nothing about a loop that keeps no memory", async () => {
      const { client, store } = await loopChain([{ step: 1 }, { step: 2 }]);
      const report = await audit(client, id, { store });
      assert.isUndefined(report.memoryLinks);
      assert.isTrue(report.ok);
    });
  });
});
