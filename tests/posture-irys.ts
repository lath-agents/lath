import { decodeIrysId, hex, sha256, utf8 } from "@lath/sdk";
import { assert } from "chai";
import { canonicalJson } from "../runtime/src/policy";
import { lathPosture, postureHash, type LathPosture } from "../runtime/src/zeroclaw/posture";
import {
  POSTURE_IRYS_MAX_BYTES,
  checkPostureBytes,
  jailRules,
  postureBytes,
  postureIrysTags,
} from "../runtime/src/zeroclaw/posture-irys";
import { knownPosture, posturesToPublish, publishPosture } from "../frontend/src/app/api/_lib/posture-irys";
import type { IrysTag, SourcesUploader } from "../frontend/src/app/api/_lib/sources-irys";
import type { LoopStepSummary } from "../frontend/src/types/loop";
import type { ZeroClawStepRecord } from "../frontend/src/types/zeroclaw";
import { binaryVerdict, postureFromIrys, type PostureBinary } from "../sdk/src/binary-audit";

/**
 * A sandbox's posture in clear on Irys: the bytes that go up, the check a reader makes on the
 * bytes that come back, the jail rules drawn from them, and `lath-audit binary --posture-irys`'s pure
 * half. Node-only: the uploader is a stub, and nothing reaches Irys or a cluster.
 */

const BIN_SHA = "b1".repeat(32);
const PATCH_SET = "9a".repeat(32);

function posture(platform: "darwin" | "linux", sources = false): LathPosture {
  return lathPosture({
    toolAllowList: ["store.get", "solana.slot"],
    binarySha256: BIN_SHA,
    patchSet: PATCH_SET,
    platform,
    ...(sources ? { sources: { hash: "5c".repeat(32), maxBytes: 1024, maxFiles: 10 } } : {}),
  });
}

/** What the runtime records: the canonical JSON the posture hash is taken over. */
function recorded(p: LathPosture): { json: string; hash: string } {
  return { json: canonicalJson(p), hash: postureHash(p) };
}

describe("posture on Irys: what goes up is safe to publish", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`a ${platform} posture names no host path, token, socket or clock — only placeholders`, () => {
      const { json } = recorded(posture(platform, true));
      // A placeholder is `@NAME@`; every value that would be one run's is one.
      assert.notMatch(json, /\/(Users|home|private|tmp|var)\//, "no host directory");
      // Only the fixed in-sandbox mount points bwrap binds the sockets to, the same on every host.
      assert.notMatch(json.replace(/"\/lath\/[mt]\.sock"/g, ""), /\.sock"/, "no host socket path");
      assert.notMatch(json, /\d{4}-\d{2}-\d{2}T\d{2}:/, "no instant");
      const p = JSON.parse(json) as LathPosture;
      assert.deepEqual(Object.keys(p.env).sort(), ["HOME", "LANG", "TZ", "ZEROCLAW_NOW", "ZEROCLAW_OMIT_HOST"]);
      assert.equal(p.env.HOME, "@HOME@");
      assert.equal(p.env.ZEROCLAW_NOW, "@NOW@");
      assert.include(p.argv, "@MESSAGE@", "the message is a placeholder, never the owner's prompt");
    });
  }
});

describe("posture on Irys: re-hashing fetched bytes", () => {
  it("accepts the recorded bytes and hands back the posture", () => {
    const { json, hash } = recorded(posture("darwin"));
    const read = checkPostureBytes(postureBytes(json), hash);
    assert.isTrue(read.ok);
    if (read.ok) {
      assert.equal(read.json, json);
      assert.equal(read.posture.wrapper.kind, "sandbox-exec");
    }
  });

  it("refuses a byte changed, naming both hashes", () => {
    const { json, hash } = recorded(posture("darwin"));
    const bytes = postureBytes(json.replace("(deny default)", "(allow default)"));
    const read = checkPostureBytes(bytes, hash);
    assert.isFalse(read.ok);
    assert.equal(read.hash, hex(sha256(bytes)));
    assert.include(!read.ok ? read.why : "", hash);
  });

  it("refuses bytes that hash right but are not a posture, and anything over the cap", () => {
    const junk = utf8('{"version":2}');
    assert.include((checkPostureBytes(junk, hex(sha256(junk))) as { why: string }).why, "not a version-1 posture");
    const huge = new Uint8Array(POSTURE_IRYS_MAX_BYTES + 1);
    const read = checkPostureBytes(huge, hex(sha256(huge)));
    assert.isFalse(read.ok);
    assert.isNull(read.hash, "not even hashed");
  });
});

describe("posture on Irys: the jail rules, placeholders kept", () => {
  it("renders a Seatbelt profile line for line, with its placeholders named", () => {
    const p = posture("darwin", true);
    const rules = jailRules(p)!;
    assert.equal(rules.kind, "sandbox-exec");
    assert.deepEqual(rules.lines, p.wrapper.template, "one line per template line, nothing filled");
    assert.equal(rules.lines[1], "(deny default)");
    assert.include(rules.lines.join("\n"), '(deny file-write* (subpath "@SRC@"))');
    assert.deepEqual(
      rules.placeholders.map((x) => x.name),
      ["BIN", "ANCESTORS", "WORK", "CFG", "SRC", "MSOCK", "TSOCK"]
    );
    assert.include(rules.explained, "deny default");
    for (const x of rules.placeholders) assert.notEqual(x.meaning, "a value filled at spawn");
  });

  it("groups bwrap arguments one flag and its operands per line", () => {
    const rules = jailRules(posture("linux", true))!;
    assert.equal(rules.kind, "bwrap");
    assert.deepEqual(rules.lines, [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "@ENV@",
      "--proc /proc",
      "--dev /dev",
      "@LIBS@",
      "--ro-bind @BIN@ /lath/bin/zeroclaw",
      "--bind @WORK@ /lath/work",
      "--ro-bind @SRC@ /lath/work/sources",
      "--bind @CFG@ /lath/cfg",
      "--bind @MSOCK@ /lath/m.sock",
      "--bind @TSOCK@ /lath/t.sock",
      "--chdir /lath/work",
      "/lath/bin/zeroclaw",
    ]);
    assert.include(rules.explained, "--unshare-all");
  });

  it("says nothing for a posture with no wrapper it knows", () => {
    assert.isNull(jailRules({ wrapper: { kind: "docker" as never, template: [] } }));
    assert.isNull(jailRules({} as never));
  });
});

// ─── The console half ───────────────────────────────────────────────────────

class StubUploader implements SourcesUploader {
  readonly calls: { bytes: Uint8Array; tags: IrysTag[] }[] = [];
  async upload(bytes: Uint8Array, tags: IrysTag[]): Promise<Uint8Array> {
    this.calls.push({ bytes: Uint8Array.from(bytes), tags });
    return sha256(bytes);
  }
}

function sandboxRecord(p: { json: string; hash: string }, keepJson = true): ZeroClawStepRecord {
  return {
    wrapper: "sandbox-exec",
    platform: "macos",
    binarySha256: BIN_SHA,
    postureHash: p.hash,
    ...(keepJson ? { postureJson: p.json } : {}),
  } as ZeroClawStepRecord;
}

function row(over: Partial<LoopStepSummary>): LoopStepSummary {
  return {
    step: 1,
    status: "success",
    steps: 1,
    batchedSteps: 1,
    costMicroUsdc: "0",
    leafOk: true,
    epochs: [],
    startedAt: 0,
    endedAt: 1,
    ...over,
  } as LoopStepSummary;
}

describe("posture on Irys: what the console puts up", () => {
  const a = recorded(posture("darwin"));
  const m = recorded(
    lathPosture({ toolAllowList: ["store.get"], binarySha256: BIN_SHA, patchSet: PATCH_SET, platform: "darwin" })
  );

  it("names each posture a row carries once, and none the loop already has", () => {
    const r = row({
      zeroclaw: sandboxRecord(a),
      members: [
        { name: "reader", zeroclaw: sandboxRecord(m) },
        { name: "writer", zeroclaw: sandboxRecord(m) },
      ] as LoopStepSummary["members"],
    });
    assert.deepEqual(
      posturesToPublish({}, r).map((p) => p.hash),
      [a.hash, m.hash]
    );
    const have = { [a.hash]: { id: "x", network: "devnet" as const, gateway: "https://g" } };
    assert.deepEqual(
      posturesToPublish({ postures: have }, r).map((p) => p.hash),
      [m.hash]
    );
  });

  it("skips a record that kept only the hash, and one whose bytes do not re-hash to it", () => {
    assert.deepEqual(posturesToPublish({}, row({ zeroclaw: sandboxRecord(a, false) })), []);
    const lying = { json: a.json, hash: m.hash };
    assert.deepEqual(posturesToPublish({}, row({ zeroclaw: sandboxRecord(lying) })), []);
  });

  it("uploads the exact recorded bytes, tagged with the hash", async () => {
    const up = new StubUploader();
    const id = await publishPosture(a, up);
    assert.lengthOf(up.calls, 1);
    assert.equal(hex(up.calls[0].bytes), hex(utf8(a.json)));
    assert.equal(hex(sha256(up.calls[0].bytes)), a.hash, "the object on Irys hashes to the posture hash");
    assert.deepEqual(up.calls[0].tags, postureIrysTags(a.hash));
    assert.equal(hex(decodeIrysId(id)), hex(sha256(utf8(a.json))), "the id as Irys prints it");
  });

  it("refuses to upload bytes that are not the posture they are named for", async () => {
    const up = new StubUploader();
    let threw: Error | null = null;
    await publishPosture({ json: a.json, hash: m.hash }, up).catch((e) => (threw = e));
    assert.include(String(threw), "was not published");
    assert.lengthOf(up.calls, 0);
  });

  it("reuses another loop's upload of the same posture on the same network only", () => {
    const loops = [{}, { postures: { [a.hash]: { id: "ID", network: "devnet" as const, gateway: "https://g" } } }];
    assert.equal(knownPosture(loops, a.hash, "devnet")?.id, "ID");
    assert.isNull(knownPosture(loops, a.hash, "mainnet"));
    assert.isNull(knownPosture(loops, m.hash, "devnet"));
  });
});

describe("lath-audit binary --posture-irys (pure half)", () => {
  const p = posture("linux");
  const { json, hash } = recorded(p);
  const committed: PostureBinary = { binarySha256: BIN_SHA, patchSet: PATCH_SET, wrapper: "bwrap", postureHash: hash };

  it("holds the copy to the policy's posture", () => {
    const got = postureFromIrys(utf8(json), "irys:x", committed);
    assert.deepEqual(got.irys, { source: "irys:x", postureHash: hash, match: true });
    const other = postureFromIrys(utf8(canonicalJson({ ...p, patchSet: "00".repeat(32) })), "irys:y", committed);
    assert.isFalse(other.irys!.match);
    const verdict = binaryVerdict(
      { agentId: "a", seq: "1", anchor: "match", posture: committed, postureIrys: other.irys },
      []
    );
    assert.equal(verdict.verdict, "mismatch");
  });

  it("with no policy document, is the posture — its own word", () => {
    const got = postureFromIrys(utf8(json), "irys:x");
    assert.deepEqual(got.posture, committed);
    assert.isNull(got.irys!.match);
  });

  it("refuses JSON that is not canonical, whose hash no Genesis could commit", () => {
    const got = postureFromIrys(utf8(JSON.stringify(p, null, 2)), "irys:x", committed);
    assert.include(got.problem!, "canonical");
    assert.isUndefined(got.irys);
  });
});
