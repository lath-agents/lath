import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LoopRecord,
  SANDBOX_TOOL_NAMES,
  archiveLoop,
  checkLoopStart,
  publicLoop,
  publishStepPostures,
  readLoop,
  recordLoop,
  sandboxToolNames,
  sandboxToolRefusal,
  setPostureUploaderForTests,
  statusAfterStep,
  toldSourcesNote,
  withRunSlot,
  zeroclawReadiness,
  zeroclawStepRecord,
} from "../frontend/src/app/api/_lib/loops";
import {
  HOST_PATHS_WITHHELD,
  MEMBER_NOT_RECORDED,
  MEMBER_REPLAY_MISMATCH,
  MEMBER_REPLAY_UNCOMMITTED,
  NOT_SANDBOXED,
  NO_STEP,
  REPLAY_NOT_KEPT,
  REPLAY_NOT_WHOLE,
  REPLAY_REHASH_MISMATCH,
  STEP_NOT_SANDBOXED,
  SYNTHESIS_FOLDED,
  readZeroClawHost,
  readZeroClawSandbox,
  readZeroClawSandboxes,
  replayRehash,
  zeroclawStepRecordOf,
  type ZeroClawSandboxDetailResponse,
} from "../frontend/src/app/api/_lib/zeroclaw";
import { GET as zeroclawListGET } from "../frontend/src/app/api/zeroclaw/route";
import { GET as zeroclawDetailGET } from "../frontend/src/app/api/zeroclaw/[id]/route";
import { acquireRunSlot, recordAgent, runSlotHolder } from "../frontend/src/app/api/_lib/runner";
import type { LoopMemberView, LoopStepSummary } from "../frontend/src/types/loop";
import type { ZeroClawReplayRecord, ZeroClawStepRecord } from "../frontend/src/types/zeroclaw";
import type { ZeroClawSessionReport } from "../runtime/src/zeroclaw/runtime";
import {
  SOURCES_TAG,
  sourcesHash,
  sourcesManifestBytes,
  sourcesRefreshNote,
  type SourcesManifest,
} from "../runtime/src/zeroclaw/sources";
import { sourcesRefreshNoteFor } from "../frontend/src/app/api/_lib/sources-refresh";
import type { SourcesDeps } from "../frontend/src/app/api/_lib/sources";
import { parseSourcesNote, sourcesNoteLines } from "../frontend/src/lib/sources-note";
import { replayHash, type ReplayRecord } from "../runtime/src/zeroclaw/replay";
import { canonicalJson } from "../runtime/src/policy";
import { hex, sha256, utf8 } from "@lath/sdk";

/**
 * The ZeroClaw tab's server read (`_lib/zeroclaw.ts`) over the sandbox records a step writes on its
 * row (`zeroclawStepRecord` in `_lib/loop-sandbox.ts`), and the rules in front of a loop's start:
 * which tools a sandbox can run, and what refuses a console with no working binary.
 *
 * What it pins, beyond the shapes: a malformed sandbox record is dropped, not half-reported; an
 * archived loop still resolves by id; and nothing the tab answers carries prompt text or a step's
 * token — the record holds hashes, the posture and sizes, and the TOML says `<step token>` — and no
 * reader is served the host's paths: the derived TOML and wrapper profile stay on the console's disk.
 *
 * Node-only: the registry is a throwaway `LATH_TRACE_DIR`, and nothing reaches a cluster.
 */

const OWNER = "OwNeR111111111111111111111111111111111111111";
const AGENT = "ab".repeat(32);
const PROMPT = "PROMPT-TEXT-that-must-never-reach-the-tab";
const TOKEN = "f".repeat(64);
const H = (c: string) => c.repeat(64);

/** Session A's replay record in the fixture, whole, as the runtime writes it. */
const RECORD_A: ReplayRecord = {
  v: 1,
  binarySha256: H("1"),
  postureHash: H("2"),
  messageHash: H("4"),
  workspacePath: "/Users/x/.lath/zc/loops/loop-zc/work",
  tz: "UTC",
  locale: "en",
  now: "2026-09-24T12:00:00Z",
  workspaceBefore: H("5"),
  workspaceAfter: H("6"),
  seqs: ["8", "9", "10", "11"],
};
/** A synthesis's record: session B starts in the workspace A left, and writes to it. */
const RECORD_B: ReplayRecord = {
  ...RECORD_A,
  messageHash: H("a"),
  now: "2026-09-24T12:00:30Z",
  workspaceBefore: H("6"),
  workspaceAfter: H("d"),
  seqs: ["13", "14"],
  contextWindow: 163_840,
};
/** A member's own record, in its own sandbox. */
const RECORD_M: ReplayRecord = { ...RECORD_A, workspacePath: "/Users/x/.lath/zc/loops/loop-zc/m/reader/work" };
/** What the runtime commits: the record's own hash, or the fold `sha256(canonicalJson([A, B]))`. */
const REPLAY_A = replayHash(RECORD_A);
const REPLAY_M = replayHash(RECORD_M);
const FOLD = hex(sha256(utf8(canonicalJson([RECORD_A, RECORD_B]))));

function report(over: Partial<ZeroClawSessionReport> = {}): ZeroClawSessionReport {
  return {
    sessionId: "loop-zc:step-1",
    platform: "darwin",
    wrapper: "sandbox-exec",
    binarySha256: H("1"),
    patchSet: "feed",
    postureHash: H("2"),
    postureJson: '{"version":1}',
    postureToml: 'api_key = "<step token>"\ntools_token = "<step token>"\n',
    wrapperProfile: "(version 1)\n(deny default)\n",
    policyDocument: '{"model":"m","sandbox":{"version":1}}',
    genesisSeq: "7",
    actions: [
      { seq: "9", tool: "zc.file_write", status: 200 },
      { seq: "10", tool: "solana.slot", status: 200 },
    ],
    workspace: { bytes: 13, files: 2, capBytes: 8 * 1024 * 1024, capFiles: 1000 },
    replayHash: REPLAY_A,
    replay: { ...RECORD_A, seqs: [...RECORD_A.seqs] },
    messageHash: H("4"),
    ...over,
  };
}

function step(n: number, over: Partial<LoopStepSummary> = {}): LoopStepSummary {
  return {
    step: n,
    status: "success",
    steps: 2,
    batchedSteps: 2,
    costMicroUsdc: "1500",
    seq: String(10 + n * 5),
    leafOk: true,
    epochs: [],
    startedAt: 1_700_000_000_000 + n,
    endedAt: 1_700_000_000_500 + n,
    ...over,
  };
}

function loop(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
  const l: LoopRecord = {
    id,
    agentId: AGENT,
    agentName: "watcher",
    owner: OWNER,
    prompt: PROMPT,
    promptHash: "cd".repeat(32),
    intervalMs: 60_000,
    maxSteps: 5,
    budgetMicroUsdcPerStep: "50000",
    model: "deepseek/deepseek-v4.1-flash",
    createdAt: 1_700_000_000_000,
    status: "running",
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
    ...over,
  };
  recordLoop(l);
  return l;
}

/**
 * The detail as `GET /api/zeroclaw/<id>` answers it. There is one view for every reader (privacy
 * is a roadmap item), so this is the owner's and a stranger's alike, and a describe below pins
 * that nothing is withheld.
 */
function detailOf(id: string, at?: number, sandbox?: string) {
  return readZeroClawSandbox(id, at, sandbox);
}

function clearStore(): void {
  fs.rmSync(path.join(traceDir, "loops.json"), { force: true });
  fs.rmSync(path.join(traceDir, "agents.json"), { force: true });
}

describe("the sandbox record a sandboxed step leaves", () => {
  it("round-trips through the tab's reader with every field", () => {
    const record = zeroclawStepRecord(report());
    const read = zeroclawStepRecordOf({ zeroclaw: record })!;
    assert.deepEqual(read, record);
    assert.equal(read.platform, "macos", "the tab's word for darwin");
    assert.deepEqual(read.actions, [
      { seq: "9", tool: "zc.file_write", status: 200 },
      { seq: "10", tool: "solana.slot", status: 200 },
    ]);
    // The record whole, `v` and `now` included, so it re-hashes to the step's replayHash.
    assert.deepEqual(read.replay, RECORD_A, "every key the runtime hashed");
    assert.equal(hex(sha256(utf8(canonicalJson(read.replay)))), read.replayHash);
  });

  it("keeps no token and no prompt text", () => {
    const json = JSON.stringify(zeroclawStepRecord(report()));
    assert.include(json, "<step token>");
    assert.notInclude(json, TOKEN);
    assert.notInclude(json, PROMPT);
  });

  it("drops a record that cannot say which sandbox, and one bad field alone", () => {
    const good = zeroclawStepRecord(report());
    for (const bad of [
      { ...good, wrapper: "docker" },
      { ...good, platform: "darwin" },
      { ...good, binarySha256: "12" },
      { ...good, postureHash: H("Z") },
      "not a record",
    ]) {
      assert.isNull(zeroclawStepRecordOf({ zeroclaw: bad }), JSON.stringify(bad).slice(0, 60));
    }
    const partial = zeroclawStepRecordOf({
      zeroclaw: { ...good, replayHash: "short", workspace: { bytes: -1 }, actions: [{ seq: "x" }, good.actions![0]] },
    })!;
    assert.notProperty(partial, "replayHash");
    assert.notProperty(partial, "workspace");
    assert.deepEqual(partial.actions, [good.actions![0]]);
    assert.equal(partial.postureHash, good.postureHash);
  });
});

describe("the ZeroClaw tab's list and detail over the loop registry", () => {
  beforeEach(clearStore);

  it("says no step, then not sandboxed, and never invents a sandbox", () => {
    loop("loop-new");
    loop("loop-old", { history: [step(1)] });
    const sandboxes = Object.fromEntries(readZeroClawSandboxes().map((r) => [r.loopId, r]));
    assert.equal(sandboxes["loop-new"].wrapper.note, NO_STEP);
    assert.isNull(sandboxes["loop-new"].lastStep);
    assert.isFalse(sandboxes["loop-old"].sandboxed);
    assert.equal(sandboxes["loop-old"].binarySha256.note, NOT_SANDBOXED);
    assert.equal(sandboxes["loop-old"].lastStep!.replayHash.note, STEP_NOT_SANDBOXED);
  });

  it("reads the newest sandbox for the list and the last step's for the detail", () => {
    loop("loop-zc", {
      history: [step(1, { zeroclaw: zeroclawStepRecord(report()) }), step(2)],
    });
    const [view] = readZeroClawSandboxes();
    assert.isTrue(view.sandboxed);
    assert.deepEqual(view.wrapper.value, { kind: "sandbox-exec", platform: "macos" });
    assert.equal(view.binarySha256.value, H("1"));
    // The last step ran outside a sandbox, so its own fields say so.
    assert.isFalse(view.lastStep!.sandboxed);
    const detail = detailOf("loop-zc")!;
    assert.isNull(detail.postureJson.value);
    assert.equal(detail.previousSeq, "15");
  });

  it("serves the last step's posture, actions and replay record, and no prompt text or token", () => {
    loop("loop-zc", { history: [step(1, { zeroclaw: zeroclawStepRecord(report()) })] });
    const detail = detailOf("loop-zc")!;
    assert.equal(detail.postureJson.value, '{"version":1}');
    assert.equal(detail.genesisSeq, "7");
    assert.lengthOf(detail.actions.value!, 2);
    assert.equal((detail.replay.value as ZeroClawReplayRecord).workspaceAfter, H("6"));
    assert.isTrue(detail.lastStep!.replayable);
    assert.equal(detail.lastStep!.zcActions.value, 1);
    assert.deepEqual(detail.lastStep!.workspace.value, report().workspace);
    const json = JSON.stringify({ sandboxes: readZeroClawSandboxes(), sandbox: detail });
    assert.notInclude(json, PROMPT);
    assert.notInclude(json, TOKEN);
  });

  it("serves an earlier step's own sandbox after a later step has run, and says when a step never ran", () => {
    const second = report({ genesisSeq: "20", actions: [{ seq: "22", tool: "zc.file_read", status: 200 }] });
    loop("loop-zc", {
      history: [step(1, { zeroclaw: zeroclawStepRecord(report()) }), step(2, { zeroclaw: zeroclawStepRecord(second) })],
    });
    const first = detailOf("loop-zc", 1)!;
    assert.deepEqual(first.steps, [1, 2]);
    assert.equal(first.step!.step, 1);
    assert.equal(first.step!.seq.value, "15");
    // Step 1 is the first checkpoint, so its range on the chain starts at the Genesis, not a step.
    assert.isNull(first.previousSeq);
    assert.equal(first.genesisSeq, "7");
    assert.deepEqual(
      first.actions.value!.map((a) => a.tool),
      ["zc.file_write", "solana.slot"]
    );
    // The loop-level view is unchanged: the list's newest sandbox and last step.
    assert.equal(first.lastStep!.step, 2);

    const last = detailOf("loop-zc")!;
    assert.equal(last.step!.step, 2);
    assert.equal(last.previousSeq, "15");
    assert.deepEqual(
      last.actions.value!.map((a) => a.tool),
      ["zc.file_read"]
    );

    const none = detailOf("loop-zc", 9)!;
    assert.isNull(none.step);
    assert.isNull(none.postureJson.value);
    assert.equal(none.postureJson.note, "this loop has no step 9");
  });

  it("leaves archived loops out of the list and still resolves one by id", () => {
    loop("loop-gone", { history: [step(1, { zeroclaw: zeroclawStepRecord(report()) })] });
    archiveLoop("loop-gone");
    assert.lengthOf(readZeroClawSandboxes(), 0);
    assert.lengthOf(readZeroClawSandboxes({ archived: true }), 1);
    assert.equal(detailOf("loop-gone")!.binarySha256.value, H("1"));
    assert.isNull(detailOf("loop-nope"));
  });

  it("filters the list by owner", () => {
    loop("loop-a");
    loop("loop-b", { owner: "SoMeOnEeLsE11111111111111111111111111111111" });
    assert.deepEqual(
      readZeroClawSandboxes({ owner: OWNER }).map((r) => r.loopId),
      ["loop-a"]
    );
  });

  it("keeps the sandbox's texts off the open /api/loops rows", () => {
    const l = loop("loop-zc", { history: [step(1, { zeroclaw: zeroclawStepRecord(report()) })] });
    const row = publicLoop(l).history[0];
    assert.equal(row.zeroclaw!.postureHash, H("2"));
    assert.equal(row.zeroclaw!.replayHash, REPLAY_A);
    for (const key of ["postureJson", "postureToml", "wrapperProfile", "policyDocument"]) {
      assert.notProperty(row.zeroclaw!, key);
    }
  });
});

describe("what a sandbox can run, and what refuses a console with no sandbox", () => {
  it("offers the chain reads by default and the store only on request", () => {
    assert.deepEqual(SANDBOX_TOOL_NAMES, [
      "solana.slot",
      "solana.fees",
      "solana.balance",
      "lath.verify_chain",
      "store.get",
      "store.set",
    ]);
    assert.deepEqual(sandboxToolNames(undefined, "a"), [
      "solana.slot",
      "solana.fees",
      "solana.balance",
      "lath.verify_chain",
    ]);
    assert.deepEqual(sandboxToolNames([], "a"), sandboxToolNames(undefined, "a"));
    assert.deepEqual(sandboxToolNames(["store.set", "solana.slot"], "a"), ["solana.slot", "store.set"]);
  });

  it("refuses a web tool and the `lattice.verify_chain` alias by name, and drops the retired tool", () => {
    assert.match(
      sandboxToolRefusal(["solana.slot", "web.fetch_page"], "watcher")!,
      /web\.fetch_page.*air-gapped.*\(watcher\)/
    );
    // The market's price read is internet access under another prefix, and the posture says so.
    assert.match(sandboxToolRefusal(["market.prices"], "watcher")!, /market\.prices/);
    assert.match(sandboxToolRefusal(["lattice.verify_chain"], "member b")!, /lattice\.verify_chain.*\(member b\)/);
    assert.throws(() => sandboxToolNames(["web.search"], "watcher"), /web\.search/);
    assert.isNull(sandboxToolRefusal(["hire", "solana.fees"], "old coordinator"));
    assert.deepEqual(sandboxToolNames(["hire", "solana.fees"], "old coordinator"), ["solana.fees"]);
  });

  it("refuses a start whose agent names a tool the sandbox cannot run, before anything is written", () => {
    clearStore();
    const start = {
      agentId: AGENT,
      prompt: "watch the slot",
      intervalMs: 60_000,
      maxSteps: 3,
      budgetMicroUsdcPerStep: "50000",
      model: "deepseek/deepseek-v4.1-flash",
    };
    const deployWith = (tools: string[]) =>
      recordAgent(AGENT, {
        name: "watcher",
        authority: "AuThOrItY1111111111111111111111111111111111",
        owner: OWNER,
        createdAt: Date.now(),
        policy: { model: "deepseek/deepseek-v4.1-flash", tools, budgetCapUsdc: "1.00", expirationDays: 14 },
      });
    deployWith(["solana.slot", "web.search"]);
    const refused = checkLoopStart(start, OWNER) as { error: string; status: number };
    assert.equal(refused.status, 400);
    assert.match(refused.error, /web\.search/);
    assert.lengthOf(readZeroClawSandboxes(), 0, "no loop was recorded");
    deployWith(["solana.slot", "store.get"]);
    assert.notProperty(checkLoopStart(start, OWNER), "error");
  });

  it("names the missing binary when the console has none", () => {
    const none = zeroclawReadiness({ PATH: "/nonexistent" } as NodeJS.ProcessEnv);
    assert.isFalse(none.ok);
    assert.match((none as { reason: string }).reason, /LATH_ZEROCLAW_BIN/);
    const host = readZeroClawHost({} as NodeJS.ProcessEnv, "darwin");
    assert.isFalse(host.configured);
    assert.equal(host.wrapper, "sandbox-exec");
    assert.match(host.note ?? "", /no zeroclaw is on this console's PATH/);
  });

  it("hashes the binary the start would spawn: LATH_ZEROCLAW_BIN when set, else zeroclaw on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-zc-host-"));
    try {
      const onPath = path.join(dir, "bin");
      fs.mkdirSync(onPath);
      const found = path.join(onPath, "zeroclaw");
      fs.writeFileSync(found, "the binary on PATH");
      const named = path.join(dir, "named-zeroclaw");
      fs.writeFileSync(named, "the binary the variable names");
      const shaOf = (f: string) => hex(sha256(fs.readFileSync(f)));
      const PATH = `/nonexistent:${onPath}`;

      // Unset: the start resolves `zeroclaw` on PATH, so the tab hashes that file and says where it is.
      const fromPath = readZeroClawHost({ PATH } as NodeJS.ProcessEnv, "darwin");
      assert.isTrue(fromPath.configured);
      assert.equal(fromPath.binarySha256, shaOf(found));
      assert.include(fromPath.note ?? "", found);
      assert.match(fromPath.note ?? "", /LATH_ZEROCLAW_BIN is not set; .* is zeroclaw on PATH/);

      // Set: the variable wins over PATH, as it does at the start, and needs no note.
      const fromVar = readZeroClawHost({ PATH, LATH_ZEROCLAW_BIN: named } as NodeJS.ProcessEnv, "darwin");
      assert.isTrue(fromVar.configured);
      assert.equal(fromVar.binarySha256, shaOf(named));
      assert.isUndefined(fromVar.note);

      // A link is hashed through to its target, the file the start spawns.
      const link = path.join(dir, "link-zeroclaw");
      fs.symlinkSync(named, link);
      assert.equal(
        readZeroClawHost({ LATH_ZEROCLAW_BIN: link } as NodeJS.ProcessEnv, "darwin").binarySha256,
        shaOf(named)
      );

      // A variable naming nothing is not rescued by PATH: the start would refuse it too.
      const missing = readZeroClawHost(
        { PATH, LATH_ZEROCLAW_BIN: path.join(dir, "absent") } as NodeJS.ProcessEnv,
        "darwin"
      );
      assert.isFalse(missing.configured);
      assert.match(missing.note ?? "", /LATH_ZEROCLAW_BIN names .*absent, a file this console cannot read/);

      // The open routes ask for no paths, and the hash and the configured flag still come back.
      const quiet = readZeroClawHost({ PATH } as NodeJS.ProcessEnv, "darwin", false);
      assert.isTrue(quiet.configured);
      assert.equal(quiet.binarySha256, shaOf(found));
      assert.notInclude(quiet.note ?? "", dir);
      const quietMissing = readZeroClawHost(
        { PATH, LATH_ZEROCLAW_BIN: path.join(dir, "absent") } as NodeJS.ProcessEnv,
        "darwin",
        false
      );
      assert.notInclude(quietMissing.note ?? "", dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the open sandbox routes name none of the host's paths", () => {
  beforeEach(clearStore);

  it("answers the list and the detail without the binary's path, the ZeroClaw home or the derived texts", async () => {
    // One directory both configured paths sit under, so one `notInclude` catches either leaking.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-zc-host-"));
    const bin = path.join(dir, "operator", "bin", "zeroclaw");
    const home = path.join(dir, "operator", ".lath", "zc");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "the bytes the tab hashes");
    const saved = { bin: process.env.LATH_ZEROCLAW_BIN, home: process.env.LATH_ZEROCLAW_HOME };
    process.env.LATH_ZEROCLAW_BIN = bin;
    process.env.LATH_ZEROCLAW_HOME = home;
    try {
      // The texts as `layOut` derives them: the step's directories, its sockets and the binary by path.
      // The replay record is the fixture's, whose `workspacePath` is the path the binary saw and is
      // committed by `replayHash`; it is not what this pins.
      const stepDir = path.join(home, "loops", "loop-paths", "steps", "1");
      const record = zeroclawStepRecord(
        report({
          postureToml: `[workspace]\npath = "${stepDir}/work"\n[lath]\ntools_socket = "${stepDir}/t.sock"\n`,
          wrapperProfile: `(version 1)\n(allow process-exec (literal "${bin}"))\n(allow file-write* (subpath "${stepDir}"))\n`,
        })
      );
      assert.include(record.wrapperProfile!, bin, "the row keeps them on the console's own disk");
      loop("loop-paths", { history: [step(1, { zeroclaw: record })] });

      const list = await zeroclawListGET({ nextUrl: new URL("http://console.test/api/zeroclaw") } as any);
      const detail = await zeroclawDetailGET(
        { nextUrl: new URL("http://console.test/api/zeroclaw/loop-paths?step=1") } as any,
        { params: Promise.resolve({ id: "loop-paths" }) }
      );
      const bodies: string[] = [];
      for (const res of [list, detail]) {
        assert.equal(res.status, 200);
        bodies.push(await res.text());
      }
      for (const text of bodies) {
        assert.notInclude(text, dir);
        assert.notInclude(text, "t.sock");
      }
      const body = JSON.parse(bodies[1]) as ZeroClawSandboxDetailResponse;
      assert.isTrue(body.host.configured, "the configured binary is still described, by its hash");
      assert.equal(body.host.binarySha256, hex(sha256(utf8("the bytes the tab hashes"))));
      assert.isNull(body.sandbox.postureToml.value);
      assert.equal(body.sandbox.postureToml.note, HOST_PATHS_WITHHELD);
      assert.isNull(body.sandbox.wrapperProfile.value);
      assert.equal(body.sandbox.wrapperProfile.note, HOST_PATHS_WITHHELD);
      assert.equal(body.sandbox.postureJson.value, record.postureJson, "the committed posture is served");
    } finally {
      if (saved.bin === undefined) delete process.env.LATH_ZEROCLAW_BIN;
      else process.env.LATH_ZEROCLAW_BIN = saved.bin;
      if (saved.home === undefined) delete process.env.LATH_ZEROCLAW_HOME;
      else process.env.LATH_ZEROCLAW_HOME = saved.home;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Every sandbox of a step, and the sources ───────────────────────────────────────────────────────

const MEMBER_A = "0a".repeat(32);
const MEMBER_B = "0b".repeat(32);

/** The Squads demo's two sources, laid out as the fetcher lays them out. */
function manifest(): SourcesManifest {
  return {
    v: 1,
    sources: [
      {
        source: {
          kind: "github",
          input: "https://github.com/Squads-Protocol/v4/tree/main/programs",
          owner: "Squads-Protocol",
          repo: "v4",
          ref: "main",
          path: "programs",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
        dir: "github/Squads-Protocol/v4",
        files: [{ path: "github/Squads-Protocol/v4/programs/src/lib.rs", size: 4096, sha256: H("b") }],
        skipped: { files: 1, bytes: 2_000_000 },
      },
      {
        source: {
          kind: "solana",
          input: "devnet:SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
          cluster: "devnet",
          address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
          slot: "503739376",
        },
        dir: "solana/devnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
        files: [
          { path: "solana/devnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf/account.json", size: 300, sha256: H("c") },
        ],
      },
    ],
  };
}

/**
 * A sandbox record seeded with `m`, its posture carrying `sources.hash` as a posture with sources
 * does. Built on `zeroclawStepRecord` and then given `sources`, so the tab is held to the record a
 * step with sources writes whatever this helper's report carries.
 */
function sandboxWithSources(
  m: SourcesManifest,
  over: Partial<ZeroClawSessionReport> = {},
  hash = sourcesHash(m)
): ZeroClawStepRecord {
  const postureJson = canonicalJson({ version: 1, sources: { hash, maxBytes: 16 << 20, maxFiles: 2000 } });
  const record = zeroclawStepRecord(report({ postureJson, postureHash: hex(sha256(utf8(postureJson))), ...over }));
  return { ...record, sources: { hash, manifest: m } };
}

function member(agentId: string, name: string, zeroclaw?: ZeroClawStepRecord): LoopMemberView {
  return {
    agentId,
    name,
    taskId: `t-${name}`,
    outcome: "done",
    seq: "4",
    head: "ee".repeat(32),
    costMicroUsdc: "700",
    ...(zeroclaw ? { zeroclaw } : {}),
  };
}

/** One step of a team with sources: session A, two members (one without a sandbox record), a synthesis. */
function teamStep(m = manifest()): LoopStepSummary {
  const memberSandbox = sandboxWithSources(m, {
    sessionId: "member-a",
    postureHash: H("7"),
    genesisSeq: "1",
    actions: [
      { seq: "2", tool: "zc.file_read", status: 200 },
      { seq: "3", tool: "zc.file_read", status: 200 },
    ],
    replayHash: REPLAY_M,
    replay: { ...RECORD_M, seqs: [...RECORD_M.seqs] },
  });
  return step(1, {
    zeroclaw: sandboxWithSources(m),
    members: [member(MEMBER_A, "reader", memberSandbox), member(MEMBER_B, "checker")],
    synthesis: { sessionId: "loop-zc:step-1:synthesis", costMicroUsdc: "300" },
  });
}

describe("every sandbox of a step, members included", () => {
  beforeEach(clearStore);

  it("lists session A, each member and the synthesis, with a member's replayable null and said why", () => {
    loop("loop-team", { history: [teamStep()] });
    const detail = detailOf("loop-team")!;
    assert.deepEqual(
      detail.sandboxes.map((r) => [r.kind, r.label, r.sandbox]),
      [
        ["session", "session A", null],
        ["member", "reader", "reader"],
        ["member", "checker", "checker"],
        ["synthesis", "synthesis", null],
      ]
    );
    const [a, reader, checker, synthesis] = detail.sandboxes;
    assert.isTrue(a.replayable.value);
    assert.equal(a.zcActions.value, 1);
    assert.isNull(reader.replayable.value);
    assert.equal(reader.replayable.note, MEMBER_REPLAY_UNCOMMITTED);
    assert.match(reader.replayable.note!, /no manifest names it/);
    assert.equal(reader.postureHash.value, H("7"));
    assert.equal(reader.zcActions.value, 2);
    assert.equal(reader.agentId, MEMBER_A);
    assert.isFalse(checker.sandboxed);
    assert.equal(checker.wrapper.note, MEMBER_NOT_RECORDED);
    assert.isNull(checker.replayable.value);
    assert.equal(synthesis.zcActions.note, SYNTHESIS_FOLDED);
    // The bare step URL is session A, as it was before members had sandboxes.
    assert.deepEqual(detail.selected, { kind: "session", label: "session A", sandbox: null, agentId: AGENT });
  });

  it("?sandbox= describes that member's sandbox on its own chain", () => {
    loop("loop-team", { history: [step(1), teamStep()].map((s, i) => ({ ...s, step: i + 1 })) });
    const detail = detailOf("loop-team", 2, "reader")!;
    assert.deepEqual(detail.selected, { kind: "member", label: "reader", sandbox: "reader", agentId: MEMBER_A });
    assert.equal(detail.postureHash.value, H("7"), "the header describes the sandbox the cards describe");
    assert.equal(detail.step!.step, 2);
    assert.equal(detail.step!.seq.value, "4", "bounded at the member's seq, not the loop's checkpoint");
    assert.isNull(detail.previousSeq, "the loop's checkpoints do not bound a member's chain");
    assert.equal(detail.genesisSeq, "1");
    assert.isNull(detail.genesisPayloadHash, "the step's bundle key is the loop's, not the member's");
    assert.deepEqual(
      detail.actions.value!.map((a) => a.seq),
      ["2", "3"]
    );
    assert.equal(detail.step!.replayHash.value, REPLAY_M);
    assert.isFalse(detail.step!.replayable, "a step whose manifest commits no member's record");
    assert.equal(detail.stepCostMicroUsdc.value, "700");
    assert.equal(detail.sources!.value!.hash, sourcesHash(manifest()), "members get the loop's sources");
  });

  it("says a member the step does not carry, and one whose sandbox was not recorded", () => {
    loop("loop-team", { history: [teamStep()] });
    const none = detailOf("loop-team", 1, "nobody")!;
    assert.isNull(none.postureJson.value);
    assert.equal(none.postureJson.note, 'step 1 has no member named "nobody"');
    assert.isNull(none.sources);
    const checker = detailOf("loop-team", 1, "checker")!;
    assert.equal(
      checker.postureHash.value,
      checker.sandboxes[0].postureHash.value,
      "no record: the loop's newest sandbox"
    );
    assert.equal(checker.postureJson.note, MEMBER_NOT_RECORDED);
    assert.equal(checker.step!.seq.value, "4", "a member with no sandbox record is still bounded by its seq");
    assert.isFalse(checker.step!.sandboxed);
  });
});

describe("a member's replay record, committed by the step's manifest", () => {
  beforeEach(clearStore);

  /** `teamStep`, with the reader's member object carrying `replayHash` as the runner now writes it. */
  function committedStep(replayHash: string | undefined, recordHash: string | null = REPLAY_M): LoopStepSummary {
    const base = teamStep();
    const [reader, checker] = base.members!;
    const zeroclaw = { ...reader.zeroclaw! };
    if (recordHash === null) delete zeroclaw.replayHash;
    else zeroclaw.replayHash = recordHash;
    return { ...base, members: [{ ...reader, zeroclaw, ...(replayHash ? { replayHash } : {}) }, checker] };
  }

  it("calls a member replayable when its committed replayHash is its record's hash", () => {
    loop("loop-fz6", { history: [committedStep(REPLAY_M)] });
    const detail = detailOf("loop-fz6")!;
    const reader = detail.sandboxes.find((r) => r.label === "reader")!;
    assert.isTrue(reader.replayable.value);
    assert.isUndefined(reader.replayable.note);
    const checker = detail.sandboxes.find((r) => r.label === "checker")!;
    assert.isNull(checker.replayable.value, "a member with no sandbox is still the no-sandbox sentence");
    assert.equal(checker.replayable.note, MEMBER_NOT_RECORDED);

    const sandbox = detailOf("loop-fz6", 1, "reader")!;
    assert.isTrue(sandbox.step!.replayable);
    assert.equal(sandbox.step!.replayHash.value, REPLAY_M);
    // The record's fields are served beside the hash: nothing in the detail is withheld from a
    // reader who is not the owner. The derived TOML and the wrapper profile are withheld from every
    // reader, the owner too: they name the host's paths.
    assert.isNotNull(sandbox.replay.value);
    assert.isNull(sandbox.postureToml.value);
    assert.equal(sandbox.postureToml.note, HOST_PATHS_WITHHELD);
    assert.isNull(sandbox.wrapperProfile.value);
    assert.equal(sandbox.wrapperProfile.note, HOST_PATHS_WITHHELD);
    assert.isTrue(sandbox.sandboxes.find((r) => r.label === "reader")!.replayable.value);
  });

  it("says not replayable, and why, when the committed hash is not the record this console kept", () => {
    loop("loop-fz6", { history: [committedStep(H("9"))] });
    const reader = detailOf("loop-fz6")!.sandboxes.find((r) => r.label === "reader")!;
    assert.isFalse(reader.replayable.value);
    assert.equal(reader.replayable.note, MEMBER_REPLAY_MISMATCH);
    assert.isFalse(detailOf("loop-fz6", 1, "reader")!.step!.replayable);
  });

  it("is plainly not replayable when the member's sandbox wrote no record and the step committed none", () => {
    loop("loop-fz6", { history: [committedStep(undefined, null)] });
    const reader = detailOf("loop-fz6")!.sandboxes.find((r) => r.label === "reader")!;
    assert.isFalse(reader.replayable.value);
    assert.isUndefined(reader.replayable.note);
  });

  it("keeps an older step's null and says its manifest commits no record for the member", () => {
    loop("loop-fz6", { history: [committedStep(undefined)] });
    const reader = detailOf("loop-fz6")!.sandboxes.find((r) => r.label === "reader")!;
    assert.isNull(reader.replayable.value);
    assert.equal(reader.replayable.note, MEMBER_REPLAY_UNCOMMITTED);
    assert.match(reader.replayable.note!, /commits no replay record for this member/);
    assert.isFalse(detailOf("loop-fz6", 1, "reader")!.step!.replayable);
  });
});

describe("the sources as committed", () => {
  beforeEach(clearStore);

  it("serves the manifest the posture's sources.hash names, and the browser's formula is the runtime's", () => {
    const m = manifest();
    loop("loop-src", { history: [teamStep(m)] });
    const detail = detailOf("loop-src")!;
    const got = detail.sources!.value!;
    assert.equal(got.hash, sourcesHash(m));
    assert.deepEqual(got.manifest, m);
    const posture = JSON.parse(detail.postureJson.value!) as { sources: { hash: string } };
    assert.equal(posture.sources.hash, got.hash);
    // `sourcesManifestHash` in `lib/zeroclaw.ts` is `sha256(tag + "\n" + canonicalJson(m))` over
    // the page's copy of `canonicalJson`; this pins that formula to the runtime's bytes.
    assert.equal(Buffer.from(sourcesManifestBytes(m)).toString("utf8"), `${SOURCES_TAG}\n${canonicalJson(m)}`);
    assert.equal(hex(sha256(utf8(`lath.sources.v1\n${canonicalJson(got.manifest)}`))), got.hash);
  });

  it("serves a manifest that does not re-hash to its posture unchanged, so the page shows the mismatch", () => {
    const m = manifest();
    const tampered: SourcesManifest = JSON.parse(JSON.stringify(m));
    tampered.sources[0].files[0].sha256 = H("f");
    // An extra key the reader does not know: rebuilt rather than passed on, it would vanish and
    // the manifest would re-hash differently from what the record holds.
    (tampered.sources[1] as unknown as Record<string, unknown>).extra = "kept";
    loop("loop-src", {
      history: [
        step(1, { zeroclaw: { ...sandboxWithSources(m), sources: { hash: sourcesHash(m), manifest: tampered } } }),
      ],
    });
    const got = detailOf("loop-src")!.sources!.value!;
    assert.deepEqual(got.manifest, tampered, "never dropped, never rebuilt");
    assert.notEqual(hex(sha256(utf8(`${SOURCES_TAG}\n${canonicalJson(got.manifest)}`))), got.hash);
  });

  it("draws no card for a sandbox without sources, and names the gap when the posture commits some", () => {
    loop("loop-plain", { history: [step(1, { zeroclaw: zeroclawStepRecord(report()) })] });
    assert.isNull(detailOf("loop-plain")!.sources);

    const withGap = sandboxWithSources(manifest());
    delete withGap.sources;
    loop("loop-gap", { history: [step(1, { zeroclaw: withGap })] });
    const gap = detailOf("loop-gap")!.sources!;
    assert.isNull(gap.value);
    assert.equal(gap.note, "the posture commits sources the sandbox did not record");

    const unreadable = { ...zeroclawStepRecord(report()), sources: { hash: "short", manifest: {} } };
    loop("loop-bad", { history: [step(1, { zeroclaw: unreadable as unknown as ZeroClawStepRecord })] });
    assert.equal(detailOf("loop-bad")!.sources!.note, "the sandbox recorded sources this console cannot read");
  });
});

/**
 * An older step's record as the registry keeps it: `withoutSandboxTexts` in `_lib/loop-sandbox.ts` leaves the
 * four texts on the newest row only, so this is the shape every step but the last has on devnet.
 */
function withoutTexts(r: ZeroClawStepRecord): ZeroClawStepRecord {
  const { postureJson: _j, postureToml: _t, wrapperProfile: _w, policyDocument: _p, ...rest } = r;
  return rest;
}

/** `sandboxWithSources` whose policy document carries its posture under `sandbox`, as the runtime's does. */
function committedSandbox(m: SourcesManifest, over: Partial<ZeroClawSessionReport> = {}): ZeroClawStepRecord {
  const r = sandboxWithSources(m, over);
  return { ...r, policyDocument: canonicalJson({ model: "m", sandbox: JSON.parse(r.postureJson!) }) };
}

/**
 * The Sources card's tag, as the page decides it (`SourcesCard` over `postureSourcesHash` in
 * `lib/zeroclaw.ts`, which imports React and cannot load here): `chain` when the served posture
 * bytes name a `sources.hash`, `console` when only the record's copy is there.
 */
function sourcesTag(detail: { postureJson: { value: string | null } }): "chain" | "console" {
  const p = detail.postureJson.value;
  if (!p) return "console";
  try {
    const h = (JSON.parse(p) as { sources?: { hash?: unknown } }).sources?.hash;
    return typeof h === "string" ? "chain" : "console";
  } catch {
    return "console";
  }
}

describe("an older step's posture bytes, borrowed by hash", () => {
  beforeEach(clearStore);

  it("serves an older step the posture bytes that re-hash to its posture hash, so its sources hash is the chain's", () => {
    const m = manifest();
    const newest = committedSandbox(m, { sessionId: "loop-y1:step-2" });
    const older = withoutTexts(committedSandbox(m));
    const olderMember = withoutTexts(committedSandbox(m, { sessionId: "member-a" }));
    loop("loop-y1", {
      history: [
        step(1, { zeroclaw: older, members: [member(MEMBER_A, "reader", olderMember)] }),
        step(2, { zeroclaw: newest }),
      ],
    });
    const first = detailOf("loop-y1", 1)!;
    assert.equal(first.postureJson.value, newest.postureJson);
    assert.equal(hex(sha256(utf8(first.postureJson.value!))), first.postureHash.value, "the page's re-hash matches");
    assert.equal(first.policyDocument.value, newest.policyDocument, "session A's own document, from session A's row");
    assert.equal(sourcesTag(first), "chain");
    assert.equal(JSON.parse(first.postureJson.value!).sources.hash, first.sources!.value!.hash);
    // Derived per session, naming that session's step directory: never borrowed, and never served.
    assert.isNull(first.postureToml.value);
    assert.equal(first.postureToml.note, HOST_PATHS_WITHHELD);
    assert.isNull(first.wrapperProfile.value);

    // A member's sandbox borrows the posture bytes from session A's row — the hash is the proof — but
    // not session A's policy document: a member's Genesis hashes its own agent's policy.
    const reader = detailOf("loop-y1", 1, "reader")!;
    assert.equal(reader.postureJson.value, newest.postureJson);
    assert.equal(sourcesTag(reader), "chain");
    assert.isNull(reader.policyDocument.value);
    assert.equal(reader.policyDocument.note, "the sandbox did not record the policy document its Genesis hashed");
  });

  it("does not borrow from a record whose posture hash differs", () => {
    const m = manifest();
    const older = withoutTexts(committedSandbox(m));
    const other = committedSandbox(m, { sessionId: "loop-y1:step-2" });
    const otherPosture = canonicalJson({ ...JSON.parse(other.postureJson!), note: "a later start" });
    const newest = { ...other, postureJson: otherPosture, postureHash: hex(sha256(utf8(otherPosture))) };
    loop("loop-y1", { history: [step(1, { zeroclaw: older }), step(2, { zeroclaw: newest })] });
    const first = detailOf("loop-y1", 1)!;
    assert.notEqual(newest.postureHash, older.postureHash);
    assert.isNull(first.postureJson.value);
    assert.equal(first.postureJson.note, "the sandbox recorded the posture's hash but not its bytes");
    assert.isNull(first.policyDocument.value);
    assert.equal(sourcesTag(first), "console", "only the record's copy of the sources hash is left");
  });

  it("refuses borrowed posture bytes that do not re-hash to the hash, even under a matching postureHash", () => {
    const m = manifest();
    const older = withoutTexts(committedSandbox(m));
    const forged = canonicalJson({ ...JSON.parse(committedSandbox(m).postureJson!), network: "open" });
    // The donor row claims the older step's hash for bytes that are not its preimage.
    const newest = {
      ...committedSandbox(m, { sessionId: "loop-y1:step-2" }),
      postureHash: older.postureHash,
      postureJson: forged,
      policyDocument: canonicalJson({ model: "m", sandbox: JSON.parse(forged) }),
    };
    loop("loop-y1", { history: [step(1, { zeroclaw: older }), step(2, { zeroclaw: newest })] });
    const first = detailOf("loop-y1", 1)!;
    assert.isNull(first.postureJson.value);
    assert.equal(first.postureJson.note, "the sandbox recorded the posture's hash but not its bytes");
    assert.isNull(first.policyDocument.value);
    assert.equal(sourcesTag(first), "console");
  });
});

/**
 * Privacy is a roadmap item, so there is one view: a reader who is not the owner gets the texts —
 * the prompt, the typed sources, the manifest and the replay record — not just their hashes. These
 * cases pin that every reader gets the texts with the
 * hashes still beside them — a page that checks a text against its hash can still do so.
 */
describe("every reader gets the texts, with their hashes", () => {
  beforeEach(clearStore);

  const GOAL = "GOAL-TEXT-the-owner-typed";
  const ROLE = "ROLE-LINE-of-a-member-system-prompt";
  const TYPED = "https://example.com/OWNER-TYPED-SOURCE";

  /** A loop carrying every text the owner view has: the prompt, a goal, a sandbox's typed sources, a slot's brief. */
  function textLoop(id: string): LoopRecord {
    return loop(id, {
      goal: GOAL,
      goalHash: "9f".repeat(32),
      sandbox: { config: { sources: [{ kind: "url", url: TYPED }] }, sourcesHash: sourcesHash(manifest()) },
      workers: {
        agentIds: [MEMBER_A, MEMBER_B],
        model: "m",
        budgetMicroUsdcPerTask: "1000",
        slots: [{ name: "reader", model: "m", policy: { systemPrompt: `${ROLE}\nand the rest` } }, { model: "m" }],
      },
      history: [teamStep()],
    });
  }

  it("the sandbox detail carries the manifest and the replay record beside their hashes", () => {
    textLoop("loop-f25");
    const detail = readZeroClawSandbox("loop-f25", undefined, undefined)!;
    assert.notProperty(detail, "ownerView");
    assert.equal(detail.sources!.value!.hash, sourcesHash(manifest()));
    assert.deepEqual(detail.sources!.value!.manifest, manifest());
    assert.equal((detail.replay.value as ZeroClawReplayRecord).workspaceAfter, H("6"));
    assert.equal(detail.step!.replayHash.value, REPLAY_A);
    assert.isTrue(detail.step!.replayable);
    assert.isNotNull(detail.postureJson.value);
    // A member's sandbox is the same: its manifest and replay record are served too.
    const member = readZeroClawSandbox("loop-f25", 1, "reader")!;
    assert.deepEqual(member.sources!.value!.manifest, manifest());
    assert.isNotNull(member.replay.value);
    assert.equal(member.step!.replayHash.value, REPLAY_M);
  });

  it("a sandbox with no replay record says so", () => {
    loop("loop-norp", {
      history: [step(1, { zeroclaw: zeroclawStepRecord(report({ replayHash: undefined, replay: undefined })) })],
    });
    const detail = readZeroClawSandbox("loop-norp", undefined, undefined)!;
    assert.equal(detail.replay.note, "the step committed no replay record");
  });

  it("the /api/loops view carries the prompt, typed sources, manifests and replay records, and no team roster", () => {
    const l = textLoop("loop-f25");
    const view = publicLoop(l);
    assert.notProperty(view, "ownerView");
    assert.equal(view.prompt, PROMPT);
    assert.equal(view.promptHash, l.promptHash);
    assert.equal(view.goal, GOAL);
    assert.equal(view.goalHash, "9f".repeat(32));
    assert.deepEqual(view.sandbox!.config.sources, [{ kind: "url", url: TYPED }]);
    assert.equal(view.sandbox!.sourcesHash, sourcesHash(manifest()));
    // A stored team is named, not projected: a slot's role is the owner's text and stays off.
    assert.deepEqual(view.earlierBuild, ["team"]);
    assert.notInclude(JSON.stringify(view), ROLE);
    const row = view.history[0];
    assert.deepEqual(row.zeroclaw!.sources!.manifest, manifest());
    assert.property(row.zeroclaw!, "replay");
    assert.equal(row.zeroclaw!.replayHash, REPLAY_A);
    const reader = row.members![0].zeroclaw!;
    assert.property(reader, "replay");
    assert.equal(reader.replayHash, REPLAY_M);
    assert.notProperty(row.members![1], "zeroclaw", "a member with no sandbox is left as it was");
    // The read is a read: the record itself is unchanged by it.
    assert.equal(readLoop("loop-f25")!.prompt, PROMPT);
  });
});

// ─── The whole replay record, and both of a synthesizing step's ───────────────────────────────────

/** An older row: the record without `v`, `now` and `contextWindow`. */
function oldReplay(r: ReplayRecord): ZeroClawReplayRecord {
  const { v: _v, now: _now, contextWindow: _w, ...rest } = r;
  return { ...rest, seqs: [...r.seqs] };
}

/**
 * A synthesizing team step's row as stored (`zeroclawStepRecord` over the report the runtime
 * folded): both records in order under the fold's hash, and the synthesis's own record hash beside
 * them. This build writes no such row; the tab still reads them.
 */
function synthesizingRecord(over: Partial<ZeroClawStepRecord> = {}): ZeroClawStepRecord {
  return {
    ...zeroclawStepRecord(report({ replayHash: FOLD })),
    replay: [RECORD_A, RECORD_B] as [ZeroClawReplayRecord, ZeroClawReplayRecord],
    synthesis: { replayHash: replayHash(RECORD_B) },
    ...over,
  };
}

describe("the replay record a row keeps, and when the tab calls it replayable", () => {
  beforeEach(clearStore);

  it("keeps v, now and the context window, re-hashes to replayHash, and serves the window to the Replay card", () => {
    const withWindow: ReplayRecord = { ...RECORD_A, contextWindow: 163_840 };
    const hash = replayHash(withWindow);
    const record = zeroclawStepRecord(report({ replayHash: hash, replay: withWindow }));
    assert.deepEqual(record.replay, withWindow);
    assert.equal(hex(sha256(utf8(canonicalJson(record.replay)))), hash, "the kept record is the hash's preimage");
    assert.isTrue(replayRehash(zeroclawStepRecordOf({ zeroclaw: record })).ok);

    loop("loop-fz28", { history: [step(1, { zeroclaw: record })] });
    const detail = detailOf("loop-fz28")!;
    assert.isTrue(detail.step!.replayable);
    assert.isUndefined(detail.step!.replayNote);
    const shown = detail.replay.value as ZeroClawReplayRecord;
    assert.equal(shown.contextWindow, 163_840, "the Replay card's context window line has a value to render");
    assert.equal(shown.now, RECORD_A.now);
    assert.equal(shown.v, 1);
    assert.isTrue(detail.sandboxes[0].replayable.value);
  });

  it("reads both records of a synthesizing step, whose fold re-hashes to the step's replayHash", () => {
    const record = synthesizingRecord();
    assert.isArray(record.replay);
    const [a, b] = record.replay as ZeroClawReplayRecord[];
    assert.deepEqual(a, RECORD_A);
    assert.deepEqual(b, RECORD_B);
    assert.equal(b.workspaceBefore, a.workspaceAfter, "B starts where A left the workspace");
    assert.equal(hex(sha256(utf8(canonicalJson(record.replay)))), FOLD);
    assert.deepEqual(record.synthesis, { replayHash: replayHash(RECORD_B) });

    loop("loop-fold", {
      history: [
        step(1, { zeroclaw: record, synthesis: { sessionId: "loop-zc:step-1:synthesis", costMicroUsdc: "3" } }),
      ],
    });
    const detail = detailOf("loop-fold")!;
    assert.isTrue(detail.step!.replayable);
    assert.deepEqual(detail.replay.value, [RECORD_A, RECORD_B]);
    const synthesis = detail.sandboxes.find((r) => r.kind === "synthesis")!;
    assert.isTrue(synthesis.replayable.value, "the synthesis's row reads the same fold");
  });

  it("shows a kept synthesis refusal on the synthesis's row", () => {
    const refused = "the workspace is 9154 bytes over its 1024-byte cap";
    // Session B's sandbox wrote no record, so the fold took the step's replayHash away, and the row
    // kept session A's record and the synthesis's refusal.
    const record: ZeroClawStepRecord = {
      ...zeroclawStepRecord(report({ replayHash: undefined })),
      synthesis: { refused },
    };
    assert.deepEqual(record.synthesis, { refused });
    assert.deepEqual(record.replay, RECORD_A, "no second record, so no fold");
    loop("loop-bref", {
      history: [
        step(1, { zeroclaw: record, synthesis: { sessionId: "loop-zc:step-1:synthesis", costMicroUsdc: "3" } }),
      ],
    });
    const detail = detailOf("loop-bref")!;
    const rows = Object.fromEntries(detail.sandboxes.map((r) => [r.kind, r]));
    assert.equal(rows.synthesis.refused, refused);
    assert.isUndefined(rows.session.refused, "session A's own row is not the synthesis's");
    assert.isFalse(detail.step!.replayable);
  });

  it("reads a two-element array, and drops any other array rather than half a fold", () => {
    const record = synthesizingRecord();
    assert.deepEqual(zeroclawStepRecordOf({ zeroclaw: record })!.replay, [RECORD_A, RECORD_B]);
    for (const bad of [[RECORD_A], [RECORD_A, RECORD_B, RECORD_A], [RECORD_A, { nope: 1 }], []]) {
      assert.notProperty(zeroclawStepRecordOf({ zeroclaw: { ...record, replay: bad } })!, "replay");
    }
  });

  it("is not replayable, and says why, when the kept record cannot be re-hashed", () => {
    // An older row: the record lacks `v` and `now`.
    loop("loop-old", {
      history: [step(1, { zeroclaw: { ...zeroclawStepRecord(report()), replay: oldReplay(RECORD_A) } })],
    });
    const old = detailOf("loop-old")!;
    assert.isFalse(old.step!.replayable);
    assert.equal(old.step!.replayNote, REPLAY_NOT_WHOLE);
    assert.equal(old.sandboxes[0].replayable.note, REPLAY_NOT_WHOLE);
    assert.equal((old.replay.value as ZeroClawReplayRecord).workspaceAfter, H("6"), "still shown, not dropped");

    // An older synthesizing step: session A's record alone under the fold's hash, which a reader
    // that compared nothing would call replayable.
    const stale = synthesizingRecord({ replay: RECORD_A });
    loop("loop-stale", { history: [step(1, { zeroclaw: stale })] });
    const detail = detailOf("loop-stale")!;
    assert.isFalse(detail.step!.replayable);
    assert.equal(detail.step!.replayNote, REPLAY_REHASH_MISMATCH);

    // A hash with no record kept under it.
    const bare = { ...zeroclawStepRecord(report()) };
    delete bare.replay;
    assert.deepEqual(replayRehash(bare), { ok: false, note: REPLAY_NOT_KEPT });
    // No hash: not replayable, and the replayHash field already says why.
    assert.deepEqual(replayRehash({ replay: RECORD_A }), { ok: false });
  });

  it("holds a member to the same re-hash as session A", () => {
    const base = teamStep();
    const [reader, checker] = base.members!;
    // The committed hash and the record's own agree, and the record kept is not their preimage.
    const zeroclaw = { ...reader.zeroclaw!, replay: oldReplay(RECORD_M) };
    loop("loop-mfz28", {
      history: [{ ...base, members: [{ ...reader, zeroclaw, replayHash: REPLAY_M }, checker] }],
    });
    const row = detailOf("loop-mfz28")!.sandboxes.find((r) => r.label === "reader")!;
    assert.isFalse(row.replayable.value);
    assert.equal(row.replayable.note, REPLAY_NOT_WHOLE);
  });

  it("leaves every replay vector as it was: the record's bytes and the fold's", () => {
    // `replayHash` of a record is `sha256(canonicalJson(record))`, and the fold is over the array; the
    // tab's re-hash is exactly these two, so it agrees with the runtime without a formula of its own.
    assert.equal(REPLAY_A, hex(sha256(utf8(canonicalJson(RECORD_A)))));
    assert.equal(FOLD, hex(sha256(utf8(`[${canonicalJson(RECORD_A)},${canonicalJson(RECORD_B)}]`))));
  });
});

describe("a loop stopped by its sandbox, on the row", () => {
  it("records `sandbox` and the refusal as the row's stop reason and detail", () => {
    const detail = "the sandbox refused step 3: the workspace is 1025 bytes, over its 1024-byte cap";
    const after = statusAfterStep(
      { status: "running" },
      { status: "stopped", stopReason: "sandbox", stopDetail: detail, steps: 3 }
    );
    assert.deepEqual(after, { status: "stopped", stopReason: "sandbox", stopDetail: detail });
  });
});

describe("a loop step holds the run slot for as long as it runs", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("extends the slot past its TTL while the step runs, so a second writer is refused, and frees it after", async () => {
    let during: ReturnType<typeof acquireRunSlot> | undefined;
    const held = withRunSlot(
      "loop fz29",
      100,
      async () => {
        // Well past the TTL: without the heartbeat the slot would read as free here.
        await sleep(250);
        during = acquireRunSlot("another writer", 1_000);
        assert.equal(runSlotHolder(), "loop fz29");
      },
      20
    );
    assert.equal(await held, "stepped");
    assert.isNull(during, "a second acquireRunSlot during the step returns null");
    assert.isNull(runSlotHolder(), "released when the step ends");
    const next = acquireRunSlot("the next writer", 1_000);
    assert.isNotNull(next);
    next!.release();
  });

  it("answers busy and runs nothing while another holder has the slot", async () => {
    const other = acquireRunSlot("a session", 1_000)!;
    let ran = false;
    try {
      assert.equal(
        await withRunSlot("loop fz29", 60, async () => {
          ran = true;
        }),
        "busy"
      );
      assert.isFalse(ran);
    } finally {
      other.release();
    }
  });

  it("releases the slot when the step throws", async () => {
    let caught: unknown;
    try {
      await withRunSlot("loop fz29", 60, async () => {
        throw new Error("the step threw");
      });
    } catch (e) {
      caught = e;
    }
    assert.match(String(caught), /the step threw/);
    assert.isNull(runSlotHolder());
  });
});

// ─── The changed-since-pinned note on the step's row ─────────────────────────────────────────────

describe("the changed since pinned note a step keeps on its row", () => {
  beforeEach(clearStore);

  const TARGET = "EXkXWEpWtKs3oQf7RK2GpyqkrkjqudvGmxJSBUQ7Mo1n";
  const COUNCIL = "6ZoaWHyBTnJJUwLDpR3yh5Ru1HCRsLnsu4zHNdVaD1sn";
  const OLD_AUTH = "C6bYVSkbZVyYPUWP6c8vPoVAhVyFoMF1b1Wd2A5CQm1a";
  const VAULT = "pAtqwgcvW6LeQcF3RfqVarpjLTTeoMxZdPGiP43tw3P";
  /** Step 2's note in the demo: _target_'s authority moved to the council's vault, the council did not. */
  const MOVED = sourcesRefreshNote([
    {
      n: 4,
      address: TARGET,
      pinnedSlot: "100",
      slot: "140",
      changes: [
        { what: "upgradeAuthority", from: OLD_AUTH, to: VAULT },
        { what: "authorityKind", from: "keypair", to: "pda" },
      ],
    },
    { n: 5, address: COUNCIL, pinnedSlot: "100", slot: "140", changes: [] },
  ])!;
  /** Step 1's: nothing moved. */
  const STILL = sourcesRefreshNote([
    { n: 4, address: TARGET, pinnedSlot: "100", slot: "120", changes: [] },
    { n: 5, address: COUNCIL, pinnedSlot: "100", slot: "120", changes: [] },
  ])!;

  it("keeps the note a sandbox was told, and none when no sandbox asked or no Solana source exists", async () => {
    const told = toldSourcesNote(Promise.resolve(MOVED));
    assert.isFunction(told.provide);
    assert.isUndefined(told.told(), "no sandbox has asked yet: the model read nothing");
    assert.equal(await told.provide!(), MOVED, "the sandbox is handed the note byte for byte");
    assert.equal(told.told(), MOVED);

    // A step that stopped before its sandbox opened: the read ran, nobody was told.
    const unasked = toldSourcesNote(Promise.resolve(MOVED));
    await new Promise((r) => setImmediate(r));
    assert.isUndefined(unasked.told());

    // A loop whose sources hold no Solana entry makes no read, and its row keeps no note.
    const github: SourcesManifest = { v: 1, sources: [manifest().sources[0]] };
    const none = toldSourcesNote(
      sourcesRefreshNoteFor({ manifest: github, dir: "/nowhere" }, {} as unknown as SourcesDeps)
    );
    if (none.provide) assert.isUndefined(await none.provide());
    assert.isUndefined(none.told());
    assert.isUndefined(toldSourcesNote(undefined).provide);
  });

  it("serves the note on the loop's rows and the ZeroClaw detail, to every reader", () => {
    const l = loop("loop-d1", {
      history: [
        step(1, { zeroclaw: zeroclawStepRecord(report()), sourcesNote: STILL }),
        step(2, { zeroclaw: zeroclawStepRecord(report()), sourcesNote: MOVED }),
        step(3, { zeroclaw: zeroclawStepRecord(report()) }),
      ],
    });
    const view = publicLoop(l);
    assert.equal(view.history[0].sourcesNote, STILL);
    assert.equal(view.history[1].sourcesNote, MOVED);
    assert.notProperty(view.history[2], "sourcesNote", "a row without a note is left without one");

    assert.equal(detailOf("loop-d1", 2)!.sourcesNote, MOVED);
    assert.notProperty(detailOf("loop-d1", 3)!, "sourcesNote");
  });

  it("reads the note back as one short line per changed source, or says nothing changed", () => {
    const moved = parseSourcesNote(MOVED);
    assert.equal(moved.changed, 1);
    assert.equal(moved.unchanged, 1);
    assert.deepEqual(sourcesNoteLines(moved), [
      "[4] EXkX…Mo1n: upgradeAuthority C6bY…Qm1a → pAtq…tw3P, authorityKind keypair → pda",
    ]);
    const changed = moved.rows.find((r) => r.kind === "changed");
    assert.deepEqual(changed && "changes" in changed ? changed.changes[0] : null, {
      what: "upgradeAuthority",
      from: OLD_AUTH,
      to: VAULT,
    });

    assert.isNull(sourcesNoteLines(parseSourcesNote(STILL)), "nothing changed since pinned");

    const unread = parseSourcesNote(
      sourcesRefreshNote([{ n: 4, address: TARGET, pinnedSlot: "100", error: "timed out after 20000 ms" }])!
    );
    assert.deepEqual(sourcesNoteLines(unread), ["[4] EXkX…Mo1n: could not re-read (timed out after 20000 ms)"]);
  });
});

describe("the posture on Irys", () => {
  const JSON_A = '{"version":1,"wrapper":{"kind":"sandbox-exec","template":["(version 1)","(deny default)"]}}';
  const HASH_A = hex(sha256(utf8(JSON_A)));
  const uploads: { bytes: Uint8Array; tags: { name: string; value: string }[] }[] = [];
  const stub = {
    async upload(bytes: Uint8Array, tags: { name: string; value: string }[]) {
      uploads.push({ bytes: Uint8Array.from(bytes), tags });
      return sha256(bytes);
    },
  };
  beforeEach(() => {
    clearStore();
    uploads.length = 0;
    setPostureUploaderForTests(stub);
  });
  after(() => setPostureUploaderForTests(undefined));

  const sandboxed = (n: number) =>
    step(n, { zeroclaw: zeroclawStepRecord(report({ postureHash: HASH_A, postureJson: JSON_A })) });

  it("puts a step's posture up once, records its id by hash, and the detail names it", async () => {
    loop("loop-z2", { history: [sandboxed(1)] });
    await publishStepPostures("loop-z2", sandboxed(1));
    assert.lengthOf(uploads, 1);
    assert.equal(new TextDecoder().decode(uploads[0].bytes), JSON_A, "the recorded bytes, as they are");
    assert.deepInclude(uploads[0].tags, { name: "Lath-Posture-Hash", value: HASH_A });
    const kept = readLoop("loop-z2")!.postures![HASH_A];
    assert.match(kept.gateway, /^https:\/\//);

    // A second step under the same posture uploads nothing.
    await publishStepPostures("loop-z2", sandboxed(2));
    assert.lengthOf(uploads, 1);

    const detail = detailOf("loop-z2")!;
    assert.deepEqual(detail.postureIrys, {
      id: kept.id,
      gateway: kept.gateway,
      network: kept.network,
      postureHash: HASH_A,
    });
  });

  it("names nothing for a loop from before, and the page falls back to the console's copy", () => {
    loop("loop-z2-old", { history: [sandboxed(1)] });
    const detail = detailOf("loop-z2-old")!;
    assert.isNull(detail.postureIrys);
    assert.equal(detail.postureJson.value, JSON_A);
  });

  it("uploads nothing on a console that does not publish, and bytes that do not re-hash never", async () => {
    setPostureUploaderForTests(null);
    loop("loop-z2-fs", { history: [sandboxed(1)] });
    await publishStepPostures("loop-z2-fs", sandboxed(1));
    assert.isUndefined(readLoop("loop-z2-fs")!.postures);

    setPostureUploaderForTests(stub);
    const lying = step(1, { zeroclaw: zeroclawStepRecord(report({ postureHash: H("2"), postureJson: JSON_A })) });
    loop("loop-z2-lie", { history: [lying] });
    await publishStepPostures("loop-z2-lie", lying);
    assert.lengthOf(uploads, 0);
  });

  it("a failed upload does not throw and is tried again on the next step", async () => {
    setPostureUploaderForTests({
      async upload() {
        throw new Error("402: not enough balance at Irys");
      },
    });
    loop("loop-z2-fail", { history: [sandboxed(1)] });
    await publishStepPostures("loop-z2-fail", sandboxed(1));
    assert.isUndefined(readLoop("loop-z2-fail")!.postures);
    setPostureUploaderForTests(stub);
    await publishStepPostures("loop-z2-fail", sandboxed(2));
    assert.lengthOf(uploads, 1);
  });
});
