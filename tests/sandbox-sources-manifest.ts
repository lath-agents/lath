import { hex, sha256, utf8 } from "@lath/sdk";
import {
  decodeSourcesManifest,
  SOURCES_INDEX_READING,
  SOURCES_TAG,
  sourceDir,
  sourcesHash,
  sourcesIndex,
  sourcesIndexProblem,
  sourcesManifestBytes,
  SourcesManifestRefused,
  type SourcesManifest,
} from "@lath/runtime/zeroclaw/sources";
import { assert } from "chai";

/**
 * The sandbox-sources contract: the manifest's bytes, its hash, where each
 * source lives under `sources/`, and the index block. Node-only. The vector below is pinned: the
 * hash goes into the posture and so under every step's policy hash, and a change to the encoding
 * that moved it would stop every loop with sources from verifying.
 */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const H = (c: string) => c.repeat(64);

function twoSources(): SourcesManifest {
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
          commit: COMMIT,
        },
        dir: "github/Squads-Protocol/v4",
        files: [
          { path: "github/Squads-Protocol/v4/programs/Cargo.toml", size: 120, sha256: H("a") },
          { path: "github/Squads-Protocol/v4/programs/src/lib.rs", size: 4096, sha256: H("b") },
        ],
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
          { path: "solana/devnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf/program.json", size: 250, sha256: H("d") },
        ],
      },
    ],
  };
}

describe("sandbox sources manifest", () => {
  it("pins the hash of a two-source manifest", () => {
    const m = twoSources();
    const bytes = sourcesManifestBytes(m);
    assert.equal(hex(sha256(bytes)), sourcesHash(m));
    assert.isTrue(new TextDecoder().decode(bytes).startsWith(`${SOURCES_TAG}\n{"sources":[`));
    assert.equal(sourcesHash(m), "4805a13e7799f9230bac1ea67a952ce370b41adac2c8f68c5a2b4c7165859207");
  });

  it("decodes what it encodes, and refuses a wrong tag, version or non-canonical bytes", () => {
    const m = twoSources();
    const bytes = sourcesManifestBytes(m);
    assert.deepEqual(decodeSourcesManifest(bytes), m);
    const json = new TextDecoder().decode(bytes).slice(SOURCES_TAG.length + 1);
    assert.isNull(decodeSourcesManifest(utf8(`lath.sources.v2\n${json}`)));
    assert.isNull(decodeSourcesManifest(utf8(`${SOURCES_TAG}\n${json.replace('"v":1', '"v":2')}`)));
    assert.isNull(decodeSourcesManifest(utf8(`${SOURCES_TAG}\n${JSON.stringify(m, null, 1)}`)));
    const unsorted = twoSources();
    unsorted.sources[0].files.reverse();
    assert.isNull(decodeSourcesManifest(sourcesManifestBytes(unsorted)));
    const wrongDir = twoSources();
    wrongDir.sources[1].dir = "solana/mainnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
    assert.isNull(decodeSourcesManifest(sourcesManifestBytes(wrongDir)));
  });

  it("lays each kind out under its own directory", () => {
    const [gh, sol] = twoSources().sources.map((e) => e.source);
    assert.equal(sourceDir(gh), "github/Squads-Protocol/v4");
    assert.equal(sourceDir(sol), "solana/devnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
    const url = (finalUrl: string) => sourceDir({ kind: "url", input: finalUrl, finalUrl, contentType: "text/plain" });
    assert.equal(url("https://example.com/docs/a%20b.md"), "url/example.com/docs/a b.md");
    assert.equal(url("https://example.com/"), "url/example.com/index");
  });

  it("refuses a directory the name rule refuses", () => {
    const url = (finalUrl: string) => sourceDir({ kind: "url", input: finalUrl, finalUrl, contentType: "text/plain" });
    assert.throws(() => url("https://example.com/a%0Ab"), SourcesManifestRefused, /control character/);
    assert.throws(() => url("https://example.com/café.md"), SourcesManifestRefused, /NFC/);
    assert.throws(() => url("https://example.com/a%2Fb"), SourcesManifestRefused, /\/ inside a name/);
    assert.throws(() => url(`https://example.com/${"x".repeat(256)}`), SourcesManifestRefused, /255/);
  });

  it("renders the index as fixed bytes, sources then files in manifest order", () => {
    const m = twoSources();
    const idx = sourcesIndex(m);
    assert.equal(idx, sourcesIndex(twoSources()));
    const lines = idx.trimEnd().split("\n");
    assert.match(lines[1], /^\[1\] github .* -> commit 0123456789abcdef/);
    assert.match(lines[2], /^\[2\] solana .* -> devnet slot 503739376/);
    assert.equal(lines[4], `${H("a")} 120 sources/github/Squads-Protocol/v4/programs/Cargo.toml`);
    // The last line says how to read the list, so a step does not hunt the disk for an index, a
    // directory listing or its memory (the 500s of loop-2683fbe571242443).
    assert.equal(lines[lines.length - 1], SOURCES_INDEX_READING);
    assert.match(SOURCES_INDEX_READING, /exactly as listed above/);
    assert.match(SOURCES_INDEX_READING, /file_read on a directory fails/);
    assert.match(SOURCES_INDEX_READING, /What you remember .* is in this message/);
    assert.equal(lines.length, 3 + 1 + 4 + 1);
  });
});

describe("sandbox sources index budget", () => {
  it("admits the two-source manifest and refuses one whose index would crowd out the step", () => {
    assert.isNull(sourcesIndexProblem(twoSources()));
    const big = twoSources();
    big.sources[0].files = Array.from({ length: 1500 }, (_, i) => ({
      path: `github/Squads-Protocol/v4/programs/src/f${String(i).padStart(4, "0")}.rs`,
      size: 1,
      sha256: H("e"),
    }));
    assert.match(sourcesIndexProblem(big) ?? "", /over the 98304/);
  });
});
