/**
 * The replay record a sandboxed loop step commits, and the
 * workspace tree it names.
 *
 * Five contracts are pinned here, each one a hash that cannot be backfilled once a step carries
 * it:
 *
 * - **the tree bytes.** A fixture workspace hashes to a pinned value, independent of mtimes and
 *   modes, in UTF-8 byte order; the empty tree is the pinned constant.
 * - **the refusals.** Symlinks, special files, hard links, names outside the Unicode and case
 *   rule, and a workspace over the host's default cap are refused with a reason that names what was wrong.
 * - **the changed-file helper.** Each new content hash is stored once, whatever its path.
 * - **the replay record.** A fixed record has pinned bytes and a pinned `replayHash`, and only
 *   the canonical form decodes.
 * - **the manifest.** `replayHash` is the thirteenth key, after `gateHash`, emitted only when
 *   set: a manifest without it has exactly today's bytes, and `LoopRunner` writes it only for a
 *   session that set it.
 *
 * Node-only: a temporary directory, the in-memory chain of `fixtures/fake-chain.ts`, and nothing
 * that can spend money.
 */
import { assert } from "chai";
import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import {
  AgentLogger,
  EpochStore,
  EventKind,
  decodeLoopManifest,
  hex,
  idFromString,
  loopManifestBytes,
  MemoryTraceStore,
  sha256,
  utf8,
  type EpochCommit,
  type LogResult,
  type LoopStepManifest,
} from "../sdk/src";
import {
  AgentRuntime,
  AnchorQueue,
  ChatRequest,
  ChatResult,
  ChatTransport,
  LoopRunner,
  MemoryAnchorJournal,
  writeLoopCheckpoint,
} from "../runtime/src";
import type { SessionResult, StartOptions } from "../runtime/src/runtime";
import { sourceDir, type SourcesManifest } from "../runtime/src/zeroclaw/sources";
import {
  canonicalEntries,
  checkSources,
  EMPTY_WORKSPACE_HASH,
  hashWorkspace,
  parseTreeBytes,
  readWorkspaceFile,
  seedSources,
  sourcesEntries,
  sourcesTreeHash,
  unlockSources,
  treeBytes,
  workspaceChanges,
  workspaceHash,
  WORKSPACE_MAX_BYTES,
  WORKSPACE_MAX_FILES,
  WorkspaceRefused,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "../runtime/src/zeroclaw/workspace";
import {
  decodeReplayRecord,
  replayHash,
  replayMessageHash,
  replayRecord,
  replayRecordBytes,
  sessionActionSeqs,
  zeroclawNow,
} from "../runtime/src/zeroclaw/replay";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";

const sha = (s: string | Uint8Array) => hex(sha256(typeof s === "string" ? utf8(s) : s));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

let scratch: string;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), "zeroclaw-workspace-"));
});
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let sandboxes = 0;
/** A fresh workspace root under the suite's scratch directory. */
function sandbox(): string {
  const dir = join(scratch, `sandbox-${++sandboxes}`);
  mkdirSync(dir);
  return dir;
}

/** What `hashWorkspace` or `treeBytes` refused with, or a failure if it did not. */
async function refusal(run: () => unknown): Promise<WorkspaceRefused> {
  try {
    await run();
  } catch (e) {
    assert.instanceOf(e, WorkspaceRefused, String(e));
    return e as WorkspaceRefused;
  }
  assert.fail("expected a WorkspaceRefused");
}

/** The fixture tree: a file, a nested directory with an empty file and an empty directory, a
 * space in a name, and a non-ASCII NFC name that sorts last by bytes. */
function fixture(): string {
  const root = sandbox();
  writeFileSync(join(root, "notes.md"), "hello\n");
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "a.json"), '{"x":1}');
  writeFileSync(join(root, "data", "zero.txt"), "");
  mkdirSync(join(root, "data", "empty"));
  writeFileSync(join(root, "with space.txt"), "s");
  writeFileSync(join(root, "\u03a9.txt"), "omega");
  return root;
}

const FIXTURE_TREE =
  "lath.workspace.v1\n" +
  "d data\n" +
  `f ${sha('{"x":1}')} 7 data/a.json\n` +
  "d data/empty\n" +
  `f ${sha("")} 0 data/zero.txt\n` +
  `f ${sha("hello\n")} 6 notes.md\n` +
  `f ${sha("s")} 1 with space.txt\n` +
  `f ${sha("omega")} 5 \u03a9.txt\n`;

describe("the workspace tree", () => {
  it("hashes the fixture tree to the pinned bytes and hash", async () => {
    const tree = await hashWorkspace(fixture());
    assert.equal(text(tree.bytes), FIXTURE_TREE);
    // Pinned, and re-derived outside this code (Python's hashlib over the same string) when it was
    // written: the hash a step's `workspaceAfter` carries for this workspace, forever.
    assert.equal(tree.hash, "00f0568f97835af2bd5cd49d5908896631bdfffe7feeffe1cc2358f0a8a55826");
    assert.equal(tree.hash, sha(FIXTURE_TREE));
    assert.equal(tree.totalBytes, 7 + 0 + 6 + 1 + 5);
    assert.equal(tree.count, 7, "five files and two directories");
    // The same tree built in code is the same bytes, whatever order it was listed in.
    assert.equal(workspaceHash([...tree.entries].reverse()), tree.hash);
  });

  it("does not see mtimes or modes", async () => {
    const root = fixture();
    const before = await hashWorkspace(root);
    chmodSync(join(root, "notes.md"), 0o600);
    chmodSync(join(root, "data"), 0o700);
    utimesSync(join(root, "notes.md"), new Date(0), new Date(0));
    const after = await hashWorkspace(root);
    assert.equal(after.hash, before.hash);
  });

  it("pins the empty tree, which is not the empty file", async () => {
    assert.equal(workspaceHash([]), EMPTY_WORKSPACE_HASH);
    assert.equal((await hashWorkspace(sandbox())).hash, EMPTY_WORKSPACE_HASH);
    assert.equal(EMPTY_WORKSPACE_HASH, sha("lath.workspace.v1\n"));
    assert.notEqual(EMPTY_WORKSPACE_HASH, sha(""), "an empty file and an empty workspace are two blobs");
  });

  it("sorts by UTF-8 bytes, not by JavaScript's UTF-16 order", () => {
    // U+FF21 (EF BC A1) is before U+1F600 (F0 9F 98 80) in UTF-8 and after it in UTF-16, where the
    // emoji is a surrogate pair starting D83D.
    const entries: WorkspaceEntry[] = [
      { kind: "file", path: "\u{1F600}.txt", size: 0, sha256: sha("") },
      { kind: "file", path: "\uFF21.txt", size: 0, sha256: sha("") },
    ];
    assert.isTrue("\u{1F600}.txt" < "\uFF21.txt", "the premise: JavaScript orders them the other way");
    const lines = text(treeBytes(entries)).split("\n");
    assert.deepEqual(
      lines.slice(1, 3).map((l) => l.split(" ").pop()),
      ["\uFF21.txt", "\u{1F600}.txt"]
    );
  });

  it("round-trips through parseTreeBytes, and refuses a blob that is not canonical", async () => {
    const tree = await hashWorkspace(fixture());
    assert.deepEqual(parseTreeBytes(tree.bytes), tree.entries);
    assert.deepEqual(parseTreeBytes(treeBytes([])), []);
    const lines = FIXTURE_TREE.split("\n");
    const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)].join("\n");
    assert.equal((await refusal(() => parseTreeBytes(utf8(swapped)))).reason, "tree");
    const noParent = FIXTURE_TREE.replace("d data/empty\n", "").replace("d data\n", "");
    assert.match((await refusal(() => parseTreeBytes(utf8(noParent)))).message, /not the directory data/);
    assert.equal((await refusal(() => parseTreeBytes(utf8(FIXTURE_TREE.slice(0, -1))))).reason, "tree");
    assert.equal((await refusal(() => parseTreeBytes(utf8(FIXTURE_TREE.replace(" 6 ", " 06 "))))).reason, "tree");
    assert.equal(
      (await refusal(() => parseTreeBytes(utf8(FIXTURE_TREE.replace("lath.workspace.v1", "lath.workspace.v2")))))
        .reason,
      "tree"
    );
  });

  it("refuses a file listed under a file, and a path listed twice", async () => {
    const f = (path: string): WorkspaceFile => ({ kind: "file", path, size: 0, sha256: sha("") });
    assert.match((await refusal(() => treeBytes([f("a"), f("a/b")]))).message, /under a, which is a file/);
    assert.match((await refusal(() => treeBytes([f("a"), f("a")]))).message, /twice/);
  });
});

describe("what the tree refuses", () => {
  it("refuses a symlink inside the workspace, and a root that is one", async () => {
    const root = sandbox();
    writeFileSync(join(root, "target.txt"), "t");
    symlinkSync("target.txt", join(root, "link.txt"));
    const inside = await refusal(() => hashWorkspace(root));
    assert.equal(inside.reason, "symlink");
    assert.match(inside.message, /link\.txt/);

    const real = sandbox();
    const alias = join(scratch, `alias-${sandboxes}`);
    symlinkSync(real, alias);
    assert.equal((await refusal(() => hashWorkspace(alias))).reason, "root");
    assert.equal((await refusal(() => hashWorkspace("relative/path"))).reason, "root");
    assert.equal((await refusal(() => hashWorkspace(join(scratch, "missing")))).reason, "root");
  });

  it("refuses a directory symlink too, without following it", async () => {
    const root = sandbox();
    symlinkSync(scratch, join(root, "out"));
    assert.equal((await refusal(() => hashWorkspace(root))).reason, "symlink");
  });

  it("refuses a FIFO and a hard link", async () => {
    const root = sandbox();
    execFileSync("mkfifo", [join(root, "pipe")]);
    const fifo = await refusal(() => hashWorkspace(root));
    assert.equal(fifo.reason, "special");
    assert.match(fifo.message, /a FIFO at pipe/);

    const linked = sandbox();
    writeFileSync(join(linked, "one"), "same inode");
    linkSync(join(linked, "one"), join(linked, "two"));
    assert.equal((await refusal(() => hashWorkspace(linked))).reason, "hardlink");
  });

  it("refuses one byte over the 8 MiB cap, naming it, and takes exactly the cap", async () => {
    assert.equal(WORKSPACE_MAX_BYTES, 8 * 1024 * 1024);
    const root = sandbox();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(WORKSPACE_MAX_BYTES));
    const at = await hashWorkspace(root);
    assert.equal(at.totalBytes, WORKSPACE_MAX_BYTES);
    writeFileSync(join(root, "one.more"), "x");
    const over = await refusal(() => hashWorkspace(root));
    assert.equal(over.reason, "bytes");
    assert.match(over.message, /8 MiB/);
    assert.match(over.message, /8388608-byte cap \(the host's default\)/);
  });

  it("refuses the 1 001st entry, naming the cap, and counts directories as entries", async () => {
    assert.equal(WORKSPACE_MAX_FILES, 1000);
    const root = sandbox();
    for (let i = 0; i < WORKSPACE_MAX_FILES - 1; i++) writeFileSync(join(root, `f${i}`), "");
    mkdirSync(join(root, "d"));
    assert.equal((await hashWorkspace(root)).count, WORKSPACE_MAX_FILES);
    mkdirSync(join(root, "d", "one-more"));
    const over = await refusal(() => hashWorkspace(root));
    assert.equal(over.reason, "files");
    assert.match(over.message, /1000-entry cap \(the host's default\)/);
  });

  it("takes the cap from the caller, as the posture field will set it", async () => {
    const root = fixture();
    assert.equal((await refusal(() => hashWorkspace(root, { maxBytes: 18 }))).reason, "bytes");
    assert.equal((await refusal(() => hashWorkspace(root, { maxFiles: 6 }))).reason, "files");
    assert.equal((await hashWorkspace(root, { maxBytes: 19, maxFiles: 7 })).count, 7);
  });
});

describe("the Unicode and case rule", () => {
  const f = (path: string): WorkspaceFile => ({ kind: "file", path, size: 0, sha256: sha("") });

  it("commits an NFC name as written and refuses an NFD one rather than normalising it", async () => {
    const nfc = "caf\u00e9.txt";
    const nfd = "cafe\u0301.txt";
    assert.include(text(treeBytes([f(nfc)])), nfc);
    const refused = await refusal(() => treeBytes([f(nfd)]));
    assert.equal(refused.reason, "name");
    assert.match(refused.message, /NFC/);

    // On disk too: APFS and ext4 both keep the form a name was written in, so the walk sees NFD.
    const root = sandbox();
    writeFileSync(join(root, nfd), "");
    assert.equal((await refusal(() => hashWorkspace(root))).reason, "name");
  });

  it("refuses siblings that differ only in case, and keeps case otherwise", async () => {
    assert.include(text(treeBytes([f("Notes.md")])), "Notes.md");
    const pair = await refusal(() => treeBytes([f("Notes.md"), f("notes.md")]));
    assert.equal(pair.reason, "case");
    assert.match(pair.message, /Notes\.md and notes\.md/);
    // Beyond ASCII, by Unicode's default mapping, and for directories as much as files.
    assert.equal((await refusal(() => treeBytes([f("\u00c9t\u00e9"), f("\u00e9t\u00e9")]))).reason, "case");
    const dirs: WorkspaceEntry[] = [{ kind: "dir", path: "A" }, f("A/x"), { kind: "dir", path: "a" }, f("a/y")];
    assert.equal((await refusal(() => treeBytes(dirs))).reason, "case");
    // The same name in two different directories is two files, not a collision.
    const apart: WorkspaceEntry[] = [{ kind: "dir", path: "x" }, { kind: "dir", path: "y" }, f("x/n"), f("y/N")];
    assert.lengthOf(canonicalEntries(apart), 4);
  });

  it("refuses control characters, dot components, empty components and over-long names", async () => {
    for (const path of ["a\nb", "tab\there", "del\u007f", ".", "..", "a/../b", "a//b", "/abs", "x".repeat(256)]) {
      assert.equal((await refusal(() => treeBytes([f(path)]))).reason, "name", JSON.stringify(path));
    }
    // 255 UTF-8 bytes is NAME_MAX and fine; a lone surrogate is not UTF-8 at all.
    assert.lengthOf(canonicalEntries([f("x".repeat(255))]), 1);
    assert.equal((await refusal(() => treeBytes([f("bad\uD800")]))).reason, "name");
  });

  it("refuses a name on disk that is not valid UTF-8, where the filesystem lets one exist", async function () {
    const root = sandbox();
    try {
      writeFileSync(Buffer.concat([Buffer.from(root + "/"), Buffer.from([0x66, 0xff, 0x66])]), "");
    } catch {
      // APFS refuses such a name itself (EILSEQ), so on macOS there is nothing to refuse.
      this.skip();
    }
    assert.equal((await refusal(() => hashWorkspace(root))).reason, "name");
  });
});

describe("the changed-file helper", () => {
  it("names what moved and stores each new content hash once", async () => {
    const root = sandbox();
    writeFileSync(join(root, "keep.txt"), "same");
    writeFileSync(join(root, "edit.txt"), "v1");
    writeFileSync(join(root, "gone.txt"), "bye");
    const first = await hashWorkspace(root);

    // Step 1 starts from the empty tree: every file is new, and "same" content is stored once.
    const fromEmpty = workspaceChanges(undefined, first.entries);
    assert.deepEqual(
      fromEmpty.toStore.map((e) => e.path),
      ["edit.txt", "gone.txt", "keep.txt"]
    );

    writeFileSync(join(root, "edit.txt"), "v2");
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "renamed.txt"), "bye"); // the removed file's content, under a new name
    writeFileSync(join(root, "copy-a.txt"), "twice");
    writeFileSync(join(root, "copy-b.txt"), "twice");
    const second = await hashWorkspace(root);

    const changes = workspaceChanges(first.entries, second.entries);
    assert.deepEqual(
      changes.added.map((e) => e.path),
      ["copy-a.txt", "copy-b.txt", "renamed.txt"]
    );
    assert.deepEqual(
      changes.modified.map((e) => e.path),
      ["edit.txt"]
    );
    assert.deepEqual(changes.removed, ["gone.txt"]);
    // `bye` is already in the store under its hash, and `twice` is one blob for two paths.
    assert.deepEqual(
      changes.toStore.map((e) => e.path),
      ["copy-a.txt", "edit.txt"]
    );
    assert.deepEqual(workspaceChanges(second.entries, second.entries).toStore, []);
  });

  it("reads a listed file back only while it still hashes to the tree's entry", async () => {
    const root = sandbox();
    writeFileSync(join(root, "a.txt"), "first");
    const tree = await hashWorkspace(root);
    const entry = tree.entries[0] as WorkspaceFile;
    assert.equal(text(await readWorkspaceFile(root, entry)), "first");
    writeFileSync(join(root, "a.txt"), "second");
    assert.equal((await refusal(() => readWorkspaceFile(root, entry))).reason, "changed");
    rmSync(join(root, "a.txt"));
    symlinkSync(join(scratch, "nowhere"), join(root, "a.txt"));
    assert.equal((await refusal(() => readWorkspaceFile(root, entry))).reason, "symlink");
  });
});

describe("a sandbox's sources in the workspace tree", () => {
  const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
  const FILES: Record<string, string> = {
    "github/Squads-Protocol/v4/programs/README.md": "# squads\n",
    "github/Squads-Protocol/v4/programs/src/lib.rs": "fn main() {}\n",
    [`solana/devnet/${SQUADS}/account.json`]: '{"executable":true}\n',
  };
  const CAPS = { maxBytes: 16 * 1024 * 1024, maxFiles: 2000 };
  const locked: string[] = [];
  after(async () => {
    // A seeded `sources/` is 0555 on disk, and the suite's scratch directory is removed after this.
    for (const w of locked) await unlockSources(w);
  });

  /** The fetched directory as the console leaves it, and the manifest that commits it. */
  function fetched(): { from: string; manifest: SourcesManifest } {
    const from = sandbox();
    for (const [p, body] of Object.entries(FILES)) {
      mkdirSync(join(from, p, ".."), { recursive: true });
      writeFileSync(join(from, p), body);
    }
    const file = (p: string) => ({ path: p, size: utf8(FILES[p]).length, sha256: sha(FILES[p]) });
    const github = {
      kind: "github" as const,
      input: "https://github.com/Squads-Protocol/v4/tree/main/programs",
      owner: "Squads-Protocol",
      repo: "v4",
      ref: "main",
      path: "programs",
      commit: "a".repeat(40),
    };
    const solana = {
      kind: "solana" as const,
      input: SQUADS,
      cluster: "devnet" as const,
      address: SQUADS,
      slot: "4123",
    };
    const manifest: SourcesManifest = {
      v: 1,
      sources: [
        {
          source: github,
          dir: sourceDir(github),
          files: [
            file("github/Squads-Protocol/v4/programs/README.md"),
            file("github/Squads-Protocol/v4/programs/src/lib.rs"),
          ],
        },
        { source: solana, dir: sourceDir(solana), files: [file(`solana/devnet/${SQUADS}/account.json`)] },
      ],
    };
    return { from, manifest };
  }

  async function seeded(): Promise<{ work: string; manifest: SourcesManifest; from: string }> {
    const { from, manifest } = fetched();
    const work = sandbox();
    locked.push(work);
    assert.isTrue(await seedSources(work, { manifest, from }));
    await checkSources(work, manifest, CAPS);
    return { work, manifest, from };
  }

  it("seeds a copy whose tree is the manifest's, read-only on disk, and seeds it once", async () => {
    const { work, manifest, from } = await seeded();
    const tree = await hashWorkspace(work, { sources: CAPS });
    // A first step's `workspaceBefore`: the seeded sources, and not the empty tree.
    assert.equal(tree.hash, sourcesTreeHash(manifest));
    assert.notEqual(tree.hash, EMPTY_WORKSPACE_HASH);
    assert.include(text(tree.bytes), `d sources\nd sources/github\n`);
    assert.deepEqual(tree.sources, { bytes: 42, files: 3, dirs: 9 });
    assert.equal(tree.count, 0, "none of it counts against the workspace cap");
    const readme = join(work, "sources", "github", "Squads-Protocol", "v4", "programs", "README.md");
    const st = statSync(readme);
    assert.equal(st.nlink, 1, "a copy, not a link");
    assert.equal(st.mode & 0o777, 0o444);
    assert.equal(statSync(join(work, "sources")).mode & 0o777, 0o555);
    // Present already: nothing is copied again, and the check still passes.
    assert.isFalse(await seedSources(work, { manifest, from }));
    await checkSources(work, manifest, CAPS);
  });

  it("refuses a sources/ that was edited, added to or emptied between steps, naming the path", async () => {
    const edits: [string, (w: string) => void, RegExp][] = [
      [
        "edited",
        (w) => writeFileSync(join(w, "sources", "github", "Squads-Protocol", "v4", "programs", "README.md"), "x"),
        /sources\/github\/Squads-Protocol\/v4\/programs\/README\.md holds 1 bytes/,
      ],
      ["added", (w) => writeFileSync(join(w, "sources", "extra.md"), "x"), /sources\/extra\.md is not in the manifest/],
      [
        "removed",
        (w) => rmSync(join(w, "sources", "solana", "devnet", SQUADS, "account.json")),
        new RegExp(`sources/solana/devnet/${SQUADS}/account\\.json is missing`),
      ],
    ];
    for (const [what, edit, named] of edits) {
      const { work, manifest } = await seeded();
      await unlockSources(work);
      edit(work);
      const r = await refusal(() => checkSources(work, manifest, CAPS));
      assert.equal(r.reason, "sources", what);
      assert.match(r.message, named, what);
      assert.match(r.message, /does not match the manifest its posture commits/);
    }
  });

  it("refuses to seed from a fetched copy that is not the manifest's bytes, and leaves nothing behind", async () => {
    const { from, manifest } = fetched();
    writeFileSync(join(from, "github", "Squads-Protocol", "v4", "programs", "README.md"), "# changed\n");
    const work = sandbox();
    const r = await refusal(() => seedSources(work, { manifest, from }));
    assert.equal(r.reason, "sources");
    assert.match(r.message, /programs\/README\.md is 10 bytes hashing to/);
    assert.isFalse(existsSync(join(work, "sources")), "a sandbox has all of its sources or none");
    assert.isFalse(existsSync(`${work}.sources-seeding`), "no staging left beside the workspace");
  });

  it("counts sources/ against the sources caps and the rest against the workspace cap, only when the sandbox has sources", async () => {
    const { work } = await seeded();
    writeFileSync(join(work, "notes.md"), "mine\n");
    const tree = await hashWorkspace(work, { maxBytes: 5, maxFiles: 1, sources: CAPS });
    assert.equal(tree.count, 1);
    assert.equal(tree.totalBytes, 5);
    // Without the sources limits `sources/` is a directory like any other, and over the cap.
    assert.equal((await refusal(() => hashWorkspace(work, { maxBytes: 5, maxFiles: 1000 }))).reason, "bytes");
    assert.equal((await refusal(() => hashWorkspace(work, { maxBytes: CAPS.maxBytes, maxFiles: 1 }))).reason, "files");
    // And the sources caps hold `sources/` itself.
    const over = await refusal(() => hashWorkspace(work, { sources: { maxBytes: 20, maxFiles: 2000 } }));
    assert.equal(over.reason, "bytes");
    assert.match(over.message, /sources\/ holds more than 20 bytes/);
    const many = await refusal(() => hashWorkspace(work, { sources: { maxBytes: CAPS.maxBytes, maxFiles: 2 } }));
    assert.equal(many.reason, "files");
  });

  it("never stores a sources file as a step's blob, but stores what the step wrote", async () => {
    const { work } = await seeded();
    const before = await hashWorkspace(work, { sources: CAPS });
    writeFileSync(join(work, "notes.md"), "# squads\n"); // a copy of a source file's content, under the sandbox's own name
    writeFileSync(join(work, "plan.md"), "mine\n");
    const after = await hashWorkspace(work, { sources: CAPS });
    const changes = workspaceChanges(before.entries, after.entries, { sources: true });
    assert.deepEqual(
      changes.toStore.map((e) => e.path),
      ["plan.md"]
    );
    // From an empty tree the sources files are added but still not stored: they are the manifest's.
    const fromEmpty = workspaceChanges(undefined, after.entries, { sources: true });
    assert.isTrue(fromEmpty.added.some((e) => e.path.startsWith("sources/")));
    assert.isFalse(fromEmpty.toStore.some((e) => e.path.startsWith("sources/")));
    // Without the option (a sandbox with no sources), a `sources/` the agent wrote is stored like anything else.
    assert.isTrue(workspaceChanges(undefined, after.entries).toStore.some((e) => e.path.startsWith("sources/")));
  });

  it("refuses a manifest that lays out one path twice", () => {
    const { manifest } = fetched();
    const twice: SourcesManifest = { v: 1, sources: [manifest.sources[0], manifest.sources[0]] };
    assert.throws(() => sourcesEntries(twice), /cannot be laid out: .* twice/);
  });
});

/** The record every vector below starts from. */
const RECORD = {
  binarySha256: "1".repeat(64),
  postureHash: "2".repeat(64),
  messageHash: replayMessageHash("Watch the cluster."),
  workspacePath: "/lath/work",
  tz: "UTC",
  locale: "en",
  now: "2026-09-24T12:00:00Z",
  workspaceBefore: EMPTY_WORKSPACE_HASH,
  workspaceAfter: "3".repeat(64),
  seqs: [5n, 6n, 9n],
};

describe("the replay record", () => {
  it("has pinned canonical bytes and a pinned replayHash", () => {
    const record = replayRecord(RECORD);
    const json =
      `{"binarySha256":"${"1".repeat(64)}","locale":"en","messageHash":"${sha("Watch the cluster.")}",` +
      `"now":"2026-09-24T12:00:00Z","postureHash":"${"2".repeat(64)}","seqs":["5","6","9"],"tz":"UTC","v":1,` +
      `"workspaceAfter":"${"3".repeat(64)}","workspaceBefore":"${EMPTY_WORKSPACE_HASH}","workspacePath":"/lath/work"}`;
    assert.equal(text(replayRecordBytes(record)), json);
    assert.equal(replayHash(record), sha(json));
    assert.equal(replayHash(record), "cb26c90e546dff22814f09f1e8ba4ea9a7e48148cf62b27a591bff76549d2e29");
  });

  it("decodes only the canonical form", () => {
    const record = replayRecord(RECORD);
    const bytes = replayRecordBytes(record);
    assert.deepEqual(decodeReplayRecord(bytes), record);
    assert.isNull(decodeReplayRecord(utf8(JSON.stringify(record, null, 1))), "whitespace is another hash");
    assert.isNull(decodeReplayRecord(utf8(JSON.stringify({ ...record, extra: 1 }))));
    assert.isNull(decodeReplayRecord(utf8(text(bytes).replace('"v":1', '"v":2'))));
    assert.isNull(decodeReplayRecord(utf8("not json")));
  });

  it("refuses a record whose fields the bytes would not hold", () => {
    const bad = (over: Record<string, unknown>) => () => replayRecord({ ...RECORD, ...over } as typeof RECORD);
    assert.throws(bad({ binarySha256: "A".repeat(64) }), /binarySha256/);
    assert.throws(bad({ workspaceAfter: "3".repeat(63) }), /workspaceAfter/);
    assert.throws(bad({ workspacePath: "lath/work" }), /absolute/);
    assert.throws(bad({ workspacePath: "/lath/work/" }), /ends in/);
    assert.throws(bad({ workspacePath: "/lath/../work" }), /normalised/);
    assert.throws(bad({ tz: "" }), /tz/);
    assert.throws(bad({ now: "2026-09-24T12:00:00.500Z" }), /now/);
    assert.throws(bad({ now: "2026-09-24T09:00:00-03:00" }), /now/);
    assert.throws(bad({ now: "2026-02-30T00:00:00Z" }), /now/);
    assert.throws(bad({ seqs: [6n, 5n] }), /ascending/);
    assert.throws(bad({ seqs: [5n, 5n] }), /ascending/);
    assert.throws(bad({ seqs: ["05"] }), /decimal/);
    assert.throws(bad({ seqs: [1n << 64n] }), /u64/);
  });

  it("leaves a record without a context window at the bytes and replayHash of a record without the key", () => {
    // The context-window key is additive: absent (or passed as `undefined`) is a record without it, byte for
    // byte, so every replayHash already committed in a loop manifest still names its blob.
    const before = "cb26c90e546dff22814f09f1e8ba4ea9a7e48148cf62b27a591bff76549d2e29";
    const record = replayRecord({ ...RECORD, contextWindow: undefined });
    assert.notProperty(record, "contextWindow");
    assert.equal(replayHash(record), before);
    assert.deepEqual(replayRecordBytes(record), replayRecordBytes(replayRecord(RECORD)));
    assert.notInclude(text(replayRecordBytes(record)), "contextWindow");
    assert.deepEqual(decodeReplayRecord(replayRecordBytes(record)), record);
  });

  it("has pinned canonical bytes and a pinned replayHash for a record with a context window", () => {
    const record = replayRecord({ ...RECORD, contextWindow: 163_840 });
    const json =
      `{"binarySha256":"${"1".repeat(64)}","contextWindow":163840,"locale":"en",` +
      `"messageHash":"${sha("Watch the cluster.")}","now":"2026-09-24T12:00:00Z","postureHash":"${"2".repeat(64)}",` +
      `"seqs":["5","6","9"],"tz":"UTC","v":1,"workspaceAfter":"${"3".repeat(64)}",` +
      `"workspaceBefore":"${EMPTY_WORKSPACE_HASH}","workspacePath":"/lath/work"}`;
    assert.equal(text(replayRecordBytes(record)), json);
    assert.equal(replayHash(record), sha(json));
    assert.equal(replayHash(record), "15269e42010b69215ee981ebc5ba1ad881a7e6cbbed1397fe96838f111a7cae0");
    assert.deepEqual(decodeReplayRecord(replayRecordBytes(record)), record);
  });

  it("refuses a context window the binary would not take, when writing and when decoding", () => {
    const good = text(replayRecordBytes(replayRecord({ ...RECORD, contextWindow: 163_840 })));
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, "163840", null]) {
      assert.throws(
        () => replayRecord({ ...RECORD, contextWindow: bad as number }),
        /contextWindow/,
        `${JSON.stringify(bad)} was written`
      );
    }
    for (const bad of ["0", "-1", "1.5", "null", '"163840"', "9007199254740992"]) {
      const bytes = utf8(good.replace('"contextWindow":163840', `"contextWindow":${bad}`));
      assert.isNull(decodeReplayRecord(bytes), `contextWindow ${bad} was decoded`);
    }
    // Another spelling of a good value re-encodes to other bytes, so it is not the record a hash names.
    assert.isNull(decodeReplayRecord(utf8(good.replace('"contextWindow":163840', '"contextWindow":163840.0'))));
    assert.isNull(decodeReplayRecord(utf8(good.replace('"contextWindow":163840', '"contextWindow":1.6384e5'))));
  });

  it("writes ZEROCLAW_NOW as whole UTC seconds, floored", () => {
    assert.equal(zeroclawNow(Date.UTC(2026, 8, 24, 12, 0, 0, 999)), "2026-09-24T12:00:00Z");
    assert.equal(zeroclawNow(Date.UTC(2026, 8, 24, 12, 0, 1)), "2026-09-24T12:00:01Z");
    assert.throws(() => zeroclawNow(NaN));
  });

  it("takes a session's Action seqs from its records and its epochs, and nothing else", () => {
    const at = (seq: bigint, kind: EventKind) => ({ seq, input: { kind } } as unknown as LogResult);
    const events = [at(4n, EventKind.Genesis), at(9n, EventKind.Action), at(12n, EventKind.Resolution)];
    const epoch = {
      startSeq: 5n,
      endSeq: 9n,
      inputs: [EventKind.Action, EventKind.Action, EventKind.Delegation, EventKind.Action].map((kind) => ({ kind })),
    } as unknown as EpochCommit;
    assert.deepEqual(sessionActionSeqs(events, [epoch]), [5n, 6n, 8n, 9n]);
  });
});

describe("replayHash in the loop manifest", () => {
  const twelve: LoopStepManifest = {
    loopId: "loop-zc",
    step: 3,
    intervalMs: 60000,
    maxSteps: 10,
    promptHash: "1".repeat(64),
    startedAt: 1_757_000_000_000,
    memoryHash: "2".repeat(64),
    gateHash: "7".repeat(64),
  };
  const TWELVE_JSON =
    `{"loopId":"loop-zc","step":3,"intervalMs":60000,"maxSteps":10,"promptHash":"${"1".repeat(64)}",` +
    `"startedAt":1757000000000,"memoryHash":"${"2".repeat(64)}","gateHash":"${"7".repeat(64)}"}`;
  const REPLAY = "8".repeat(64);

  it("leaves a manifest without it at exactly today's bytes", () => {
    assert.equal(text(loopManifestBytes(twelve)), TWELVE_JSON);
    assert.equal(sha(loopManifestBytes(twelve)), sha(TWELVE_JSON));
    assert.equal(text(loopManifestBytes({ ...twelve, replayHash: undefined })), TWELVE_JSON);
  });

  it("emits it thirteenth and last, pinned, and round-trips it", () => {
    const withReplay = { ...twelve, replayHash: REPLAY };
    const json = text(loopManifestBytes(withReplay));
    assert.equal(json, TWELVE_JSON.slice(0, -1) + `,"replayHash":"${REPLAY}"}`);
    assert.equal(sha(json), "aedd993bdeaa0e52479b35a37db48fafddcf63606c35806df4645a7bb7bf8f29");
    assert.deepEqual(decodeLoopManifest(loopManifestBytes(withReplay)), withReplay);
    // Last even on an ungated step, which has no twelfth key to follow.
    const { gateHash: _g, ...ungated } = withReplay;
    assert.equal(Object.keys(JSON.parse(text(loopManifestBytes(ungated)))).pop(), "replayHash");
  });

  it("decodes it with the 64-hex check the other hashes get", () => {
    const bad = (value: unknown) => utf8(TWELVE_JSON.slice(0, -1) + `,"replayHash":${JSON.stringify(value)}}`);
    assert.isNull(decodeLoopManifest(bad("8".repeat(63))));
    assert.isNull(decodeLoopManifest(bad("8".repeat(65))));
    assert.isNull(decodeLoopManifest(bad("A".repeat(64))));
    assert.isNull(decodeLoopManifest(bad(8)));
    assert.isNull(decodeLoopManifest(bad("")));
    assert.notProperty(decodeLoopManifest(utf8(TWELVE_JSON))!, "replayHash");
  });
});

// ── The plumbing: `LoopRunner` commits what the session reports, and nothing when it reports none ──

const AGENT = idFromString("zeroclaw-workspace-agent");
const USER = new PublicKey("11111111111111111111111111111112");
const T = 1_700_000_000_000;

class Answering implements ChatTransport {
  calls = 0;
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    return {
      status: 200,
      body: {
        id: `gen-${this.calls}`,
        model: "test/model",
        choices: [{ index: 0, message: { role: "assistant", content: `answer ${this.calls}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      },
    };
  }
}

/** Stands in for `ZeroClawRuntime`: an ordinary session that reports a replay record. */
class Sandboxed extends AgentRuntime {
  replay?: string;
  async start(opts: StartOptions): Promise<SessionResult> {
    const session = await super.start(opts);
    return this.replay ? { ...session, replayHash: this.replay } : session;
  }
}

function epochStore(): EpochStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(root: Uint8Array, blob: Uint8Array) {
      blobs.set(hex(root), blob);
    },
    async get(root: Uint8Array) {
      return blobs.get(hex(root)) ?? null;
    },
  } as EpochStore;
}

function loopOn(chain: FakeChain, o: { replay?: string; store: MemoryTraceStore; failCheckpoint?: boolean }) {
  const billing = new RecordingBilling();
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing,
    maxAttempts: 1,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
  const runtime = new Sandboxed({
    client: chain.asClient(),
    agentId: AGENT,
    transport: new Answering(),
    policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
    billing,
    structures: false,
    publishPolicy: false,
    now: () => T,
    store: o.store,
    rollup: { store: epochStore(), batchSize: 16 },
    anchor: { queue, drain: true },
  });
  runtime.replay = o.replay;
  const runner = new LoopRunner({
    runtime,
    loopId: "loop-zc",
    prompt: "Watch the cluster.",
    intervalMs: 0,
    maxSteps: 5,
    user: USER,
    startedAt: T,
    now: () => T,
    sleep: async () => undefined,
    // The checkpoint is a direct client write, so failing the next chain write fails it.
    work: o.failCheckpoint ? async () => chain.failNext(1) : undefined,
  });
  return runner;
}

describe("LoopRunner and replayHash", () => {
  const REPLAY = "9".repeat(64);

  it("commits the session's replayHash as the thirteenth key", async () => {
    const store = new MemoryTraceStore();
    const stepped = await loopOn(new FakeChain(), { replay: REPLAY, store }).step();
    assert.isTrue(stepped.leafOk);
    assert.equal(stepped.manifest!.replayHash, REPLAY);
    const bytes = loopManifestBytes(stepped.manifest!);
    assert.isTrue(text(bytes).endsWith(`,"replayHash":"${REPLAY}"}`));
    assert.deepEqual(await store.get(sha256(bytes)), bytes, "the committed manifest is the one in the store");
  });

  it("writes today's manifest for a session that reports none", async () => {
    const stepped = await loopOn(new FakeChain(), { store: new MemoryTraceStore() }).step();
    assert.isTrue(stepped.leafOk);
    assert.notProperty(stepped.manifest!, "replayHash");
    assert.notInclude(text(loopManifestBytes(stepped.manifest!)), "replayHash");
  });

  it("carries it through a deferred checkpoint to the Retry's write", async () => {
    const chain = new FakeChain();
    const store = new MemoryTraceStore();
    const stepped = await loopOn(chain, { replay: REPLAY, store, failCheckpoint: true }).step();
    assert.exists(stepped.deferredCheckpoint);
    assert.equal(stepped.deferredCheckpoint!.replayHash, REPLAY);
    const logger = new AgentLogger(chain.asClient(), AGENT, { store, compact: false, now: () => T });
    const written = await writeLoopCheckpoint({
      client: chain.asClient(),
      agentId: AGENT,
      logger,
      plan: stepped.deferredCheckpoint!,
    });
    assert.isTrue(written.leafOk);
    assert.equal(written.manifest.replayHash, REPLAY);
  });
});
