/**
 * `lath-audit binary`'s pure half (`sdk/src/binary-audit.ts`): the patch-set hash `build.sh`
 * prints, the published-build lookup, and the posture read held to the Genesis's
 * `policy_version_hash` over a fake chain. Node-only: no validator, no RPC, no cargo build.
 */
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { EventKind, hex, idFromString, MemoryTraceStore, payloadPreimage, sha256, utf8 } from "../sdk/src";
import { type InferenceRecord } from "../sdk/src/audit";
import {
  binaryVerdict,
  hostTriple,
  patchSetOf,
  policyDocumentFrom,
  postureOfPolicy,
  readCheckout,
  stepPosture,
} from "../sdk/src/binary-audit";
import { canonicalJson } from "../sdk/src/market";
import { PUBLISHED_ZEROCLAW_BUILDS, publishedBuild, ZEROCLAW_UPSTREAM_COMMIT } from "../sdk/src/zeroclaw-builds";

const AGENT = sha256(utf8("zeroclaw-binary-audit-agent"));
const MAC = PUBLISHED_ZEROCLAW_BUILDS[0];

/** A posture with the three fields the command reads and enough beside them to be one. */
function posture(binarySha256 = MAC.sha256, patchSet = MAC.patchSet) {
  return {
    version: 1,
    binarySha256,
    patchSet,
    wrapper: { kind: "sandbox-exec", template: ["(version 1)", "(deny default)"] },
    workspace: { maxBytes: 8388608, maxFiles: 1000 },
  };
}

/** The document the runtime hashes: canonical JSON, the posture under `sandbox`. */
function policyDoc(sandbox: unknown = posture()): string {
  return canonicalJson({ model: "openai/gpt-4o-mini", temperature: 0, toolAllowList: [], maxCost: 1, sandbox });
}

/** A step: a Genesis at `genesisSeq` committing `doc`'s hash, and its `loop.step` checkpoint two seqs on. */
async function chainWith(doc: string, genesisSeq = 3) {
  const store = new MemoryTraceStore();
  const genesis = payloadPreimage({
    kind: EventKind.Genesis,
    sessionId: "step-1",
    callerPubkey: new Uint8Array(32),
    policyVersionHash: sha256(utf8(doc)),
    inputPayloadHash: sha256(utf8("input")),
  });
  const payloadHash = await store.put(genesis);
  const records: InferenceRecord[] = [
    { seq: BigInt(genesisSeq), kind: EventKind.Genesis, reference: new Uint8Array(32), payloadHash },
    {
      seq: BigInt(genesisSeq + 2),
      kind: EventKind.Action,
      reference: idFromString("loop.step"),
      payloadHash: sha256(utf8("checkpoint")),
    },
  ];
  return { store, chain: { listEvents: async () => records } };
}

describe("zeroclaw binary audit", () => {
  it("hashes the patch series the way build.sh does: *.patch only, in name order", () => {
    const a = { name: "0001-a.patch", bytes: utf8("A\n") };
    const b = { name: "0002-b.patch", bytes: utf8("B\n") };
    const md = { name: "0001-a.pr.md", bytes: utf8("not a patch") };
    const want = hex(sha256(utf8("A\nB\n")));
    assert.equal(patchSetOf([b, md, a]), want);
    assert.notEqual(patchSetOf([a]), want);
  });

  it("re-hashes this checkout's zeroclaw/patches to the published patch set", () => {
    // The pin and the table must move together: a patch edited without a new row in
    // `sdk/src/zeroclaw-builds.ts` is a build nobody published.
    const c = readCheckout(path.resolve(__dirname, ".."));
    assert.equal(c.upstream, ZEROCLAW_UPSTREAM_COMMIT);
    assert.equal(c.patchSet, MAC.patchSet);
    assert.isTrue(fs.existsSync(path.join(c.root, "zeroclaw", "build.sh")));
  });

  it("looks a binary up among the published builds, case-insensitively", () => {
    assert.equal(publishedBuild(MAC.sha256.toUpperCase())?.triple, "aarch64-apple-darwin");
    assert.equal(publishedBuild(PUBLISHED_ZEROCLAW_BUILDS[1].sha256)?.triple, "x86_64-unknown-linux-gnu");
    assert.isUndefined(publishedBuild("00".repeat(32)));
  });

  it("names the host triple for the platforms build.sh runs on", () => {
    assert.equal(hostTriple("darwin", "arm64"), "aarch64-apple-darwin");
    assert.equal(hostTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
    assert.isNull(hostTriple("win32", "x64"));
  });

  it("reads the posture only as far as the document re-hashes to the Genesis's commitment", () => {
    const doc = utf8(policyDoc());
    const pvh = hex(sha256(doc));
    const ok = postureOfPolicy(doc, pvh);
    assert.equal(ok.anchor, "match");
    assert.equal(ok.posture?.binarySha256, MAC.sha256);
    assert.equal(ok.posture?.wrapper, "sandbox-exec");
    assert.equal(ok.posture?.postureHash, hex(sha256(utf8(canonicalJson(posture())))));

    // One byte of the posture moved: the document no longer hashes to what the Genesis committed.
    const edited = utf8(policyDoc(posture("11".repeat(32))));
    assert.equal(postureOfPolicy(edited, pvh).anchor, "mismatch");
    assert.equal(postureOfPolicy(doc, undefined).anchor, "unanchored");
    assert.match(postureOfPolicy(utf8(canonicalJson({ model: "m" })), undefined).problem!, /no sandbox key/);
  });

  it("takes the console's /api/zeroclaw response or the bare document for --policy", () => {
    const doc = policyDoc();
    const served = { cluster: "devnet", sandbox: { policyDocument: { value: doc, source: "console" } } };
    assert.equal(hex(policyDocumentFrom(utf8(JSON.stringify(served)))!), hex(utf8(doc)));
    assert.equal(hex(policyDocumentFrom(utf8(doc))!), hex(utf8(doc)));
    const withheld = { sandbox: { policyDocument: { value: null, source: "console", note: "…" } } };
    assert.isNull(policyDocumentFrom(utf8(JSON.stringify(withheld))));
  });

  it("finds a checkpoint's Genesis and reads the document from the store under policy_version_hash", async () => {
    const doc = policyDoc();
    const { store, chain } = await chainWith(doc);
    await store.put(utf8(doc));
    const { report, notes } = await stepPosture(chain, AGENT, 5, { store });
    assert.equal(report.record, "loop.step");
    assert.equal(report.genesisSeq, "3");
    assert.equal(report.policySource, "the store");
    assert.equal(report.anchor, "match");
    assert.equal(report.published?.triple, "aarch64-apple-darwin");
    const v = binaryVerdict(
      { ...report, checkout: { root: "/x", upstream: ZEROCLAW_UPSTREAM_COMMIT, patchSet: MAC.patchSet } },
      notes
    );
    assert.equal(v.verdict, "ok", v.notes.join("; "));
  });

  it("holds a --policy document to the Genesis, and fails one the Genesis did not commit", async () => {
    const { store, chain } = await chainWith(policyDoc());
    const good = await stepPosture(chain, AGENT, 5, { store, policy: { bytes: utf8(policyDoc()), source: "file" } });
    assert.equal(good.report.anchor, "match");
    assert.equal(good.report.policySource, "file");

    const other = utf8(policyDoc(posture(PUBLISHED_ZEROCLAW_BUILDS[1].sha256)));
    const bad = await stepPosture(chain, AGENT, 5, { store, policy: { bytes: other, source: "file" } });
    assert.equal(bad.report.anchor, "mismatch");
    assert.equal(binaryVerdict(bad.report, bad.notes).verdict, "mismatch");
  });

  it("says a posture it could not anchor, an unlisted build or a wrong local binary out loud", async () => {
    const { chain } = await chainWith(policyDoc());
    // No store: the Genesis payload is unread, so the posture is only the source's word.
    const loose = await stepPosture(chain, AGENT, 5, { policy: { bytes: utf8(policyDoc()), source: "file" } });
    assert.equal(loose.report.anchor, "unanchored");
    const checkout = { root: "/x", upstream: ZEROCLAW_UPSTREAM_COMMIT, patchSet: MAC.patchSet };
    assert.equal(binaryVerdict({ ...loose.report, checkout }, loose.notes).verdict, "unchecked");

    const doc = policyDoc(posture("22".repeat(32)));
    const { store, chain: c2 } = await chainWith(doc);
    await store.put(utf8(doc));
    const unlisted = await stepPosture(c2, AGENT, 5, { store });
    assert.isNull(unlisted.report.published);
    const v = binaryVerdict({ ...unlisted.report, checkout }, unlisted.notes);
    assert.equal(v.verdict, "unchecked");
    assert.match(v.notes.join("\n"), /not a build this repo publishes/);

    const local = binaryVerdict(
      { ...unlisted.report, checkout, local: { path: "/bin/zc", sha256: "33".repeat(32) } },
      unlisted.notes
    );
    assert.equal(local.verdict, "mismatch");
  });
});
