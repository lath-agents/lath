import { traceDir } from "./fixtures/trace-dir";
import { hex, loopStartBodyHash, sha256, utf8 } from "@lath/sdk";
import {
  SOURCES_INDEX_READING,
  decodeSourcesManifest,
  sourceDir,
  sourcesHash,
  sourcesIndex,
  sourcesManifestBytes,
  textSourceProblem,
  TEXT_SOURCE_MAX_BYTES,
  type SourcesManifest,
} from "@lath/runtime/zeroclaw/sources";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SourcesRefused,
  checkSources,
  fetchSources,
  parseSourceInputs,
  type SourcesDeps,
} from "../frontend/src/app/api/_lib/sources";
import { publishSources, restoreSources, type IrysTag } from "../frontend/src/app/api/_lib/sources-irys";
import { checkSandboxConfig } from "../frontend/src/app/api/_lib/loops";
import { implicitTemplate, lookupTemplate } from "../frontend/src/app/api/_lib/templates";
import { MAX_CONFIG_CHARS, checkConfig } from "../frontend/src/app/api/templates/validate";
import { attachFile, attachedListProblem, textSourceLine, textTypeOf } from "../frontend/src/lib/attached-sources";
import { sourceToDraft } from "../frontend/src/lib/sources";

/**
 * An attached file as a sandbox source (`text`): the owner's
 * file arrives in the start body, so the `"Lath loop"` signature binds its bytes; the host writes it
 * as one file and commits its sha256 like a URL's, and nothing is fetched. Node-only: the network
 * below throws, so a text source that touched it would fail here.
 */

const H = (c: string) => c.repeat(64);

/**
 * A manifest of the three fetched kinds, pinned **independently** of the `text` kind (its bytes'
 * hash and its index's hash were computed by an encoder without it): the encoding of the three
 * fetched kinds, and of a skip with reasons, must not move by a byte, or every loop with sources
 * stops verifying.
 */
const THREE: SourcesManifest = {
  v: 1,
  sources: [
    {
      source: {
        kind: "github",
        input: "https://github.com/o/r",
        owner: "o",
        repo: "r",
        ref: null,
        path: null,
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
      dir: "github/o/r",
      files: [{ path: "github/o/r/README.md", size: 10, sha256: H("1") }],
    },
    {
      source: {
        kind: "url",
        input: "https://example.org/spec.md",
        finalUrl: "https://example.org/spec.md",
        contentType: "text/markdown",
      },
      dir: "url/example.org/spec.md",
      files: [{ path: "url/example.org/spec.md/spec.md", size: 20, sha256: H("2") }],
    },
    {
      source: {
        kind: "solana",
        input: "devnet:SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
        cluster: "devnet",
        address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
        slot: "1",
      },
      dir: "solana/devnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
      files: [
        { path: "solana/devnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf/account.json", size: 30, sha256: H("3") },
      ],
      skipped: { files: 1, bytes: 5, reasons: ["no IDL"] },
    },
  ],
};
const THREE_HASH = "91f853e589d076a6b14bb81d87200583e7bd59f121fea746de1e69bf94d13f75";
const THREE_INDEX_HASH = "a0f2e988d28dae75b98b3ad6373cec46e0229930d179225f2f422147ce8cb3df";

const INVOICES = JSON.stringify(
  { title: "Council treasury: invoices for the week of 2026-10-05", invoices: [{ id: "inv-1", amount: "120" }] },
  null,
  2
);

/** A network that refuses everything: an attached file is written, never fetched. */
const offline: SourcesDeps = {
  fetch: async () => {
    throw new Error("an attached file reached the network");
  },
  lookup: async () => {
    throw new Error("an attached file looked up a name");
  },
  rpc: { devnet: "", mainnet: "" },
  now: () => 0,
};

describe("text sources: old manifests are byte for byte what they were", () => {
  it("hashes and indexes a github + url + solana manifest exactly as without the text kind", () => {
    assert.equal(sourcesHash(THREE), THREE_HASH);
    assert.equal(hex(sha256(sourcesManifestBytes(THREE))), THREE_HASH);
    // The index ends with one fixed line (`SOURCES_INDEX_READING`, how to read the list). Every line
    // before it is byte for byte the pinned one, which is what this vector pins: a
    // new kind must not move another kind's lines.
    const index = sourcesIndex(THREE);
    const reading = `${SOURCES_INDEX_READING}\n`;
    assert.isTrue(index.endsWith(reading));
    assert.equal(hex(sha256(utf8(index.slice(0, -reading.length)))), THREE_INDEX_HASH);
    assert.deepEqual(decodeSourcesManifest(sourcesManifestBytes(THREE)), THREE);
  });

  it("encodes an existing kind's entry identically beside a text source, with no new key", () => {
    const withText: SourcesManifest = {
      v: 1,
      sources: [
        ...THREE.sources,
        {
          source: { kind: "text", name: "invoices.json", contentType: "application/json" },
          dir: "text/invoices.json",
          files: [{ path: "text/invoices.json/invoices.json", size: 3, sha256: H("4") }],
        },
      ],
    };
    const before = new TextDecoder().decode(sourcesManifestBytes(THREE));
    const after = new TextDecoder().decode(sourcesManifestBytes(withText));
    // `…[E1,E2,E3],"v":1}` before and `…[E1,E2,E3,E4],"v":1}` after: the first three entries are
    // the same bytes in the same place.
    const tail = '],"v":1}';
    assert.isTrue(before.endsWith(tail));
    assert.isTrue(after.startsWith(`${before.slice(0, -tail.length)},{`), "an existing entry moved");
    assert.deepEqual(decodeSourcesManifest(sourcesManifestBytes(withText)), withText);
  });
});

describe("text sources: the manifest", () => {
  const entry = () => ({
    source: { kind: "text" as const, name: "invoices.json", contentType: "application/json" as const },
    dir: "text/invoices.json",
    files: [{ path: "text/invoices.json/invoices.json", size: 3, sha256: H("a") }],
  });

  it("lays an attached file out under text/<name>/ and indexes it by name, not content", () => {
    assert.equal(sourceDir(entry().source), "text/invoices.json");
    const m: SourcesManifest = { v: 1, sources: [entry()] };
    const idx = sourcesIndex(m);
    assert.include(idx, "[1] text invoices.json -> attached (application/json) at sources/text/invoices.json\n");
    assert.include(idx, `${H("a")} 3 sources/text/invoices.json/invoices.json\n`);
  });

  it("refuses a text entry carrying any key but kind, name and contentType, or a type it may not say", () => {
    const ok: SourcesManifest = { v: 1, sources: [entry()] };
    assert.isNotNull(decodeSourcesManifest(sourcesManifestBytes(ok)));
    const withContent = { v: 1, sources: [{ ...entry(), source: { ...entry().source, content: "{}" } }] };
    assert.isNull(decodeSourcesManifest(sourcesManifestBytes(withContent as unknown as SourcesManifest)));
    const withInput = { v: 1, sources: [{ ...entry(), source: { ...entry().source, input: "x" } }] };
    assert.isNull(decodeSourcesManifest(sourcesManifestBytes(withInput as unknown as SourcesManifest)));
    const html = { v: 1, sources: [{ ...entry(), source: { ...entry().source, contentType: "text/html" } }] };
    assert.isNull(decodeSourcesManifest(sourcesManifestBytes(html as unknown as SourcesManifest)));
    const elsewhere = { v: 1, sources: [{ ...entry(), dir: "text/other.json" }] };
    assert.isNull(decodeSourcesManifest(sourcesManifestBytes(elsewhere as unknown as SourcesManifest)));
  });
});

describe("text sources: the start resolves, writes and commits one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lath-text-sources-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes the file as sent, commits its sha256 and size, and keeps the content out of the manifest", async () => {
    const out = path.join(root, "one");
    const { manifest, hash } = await fetchSources(
      [{ kind: "text", name: "invoices.json", content: INVOICES, contentType: "application/json" }],
      offline,
      out
    );
    const bytes = utf8(INVOICES);
    assert.deepEqual(manifest.sources, [
      {
        source: { kind: "text", name: "invoices.json", contentType: "application/json" },
        dir: "text/invoices.json",
        files: [{ path: "text/invoices.json/invoices.json", size: bytes.length, sha256: hex(sha256(bytes)) }],
      },
    ]);
    assert.equal(hash, sourcesHash(manifest));
    assert.deepEqual(
      new Uint8Array(fs.readFileSync(path.join(out, "text", "invoices.json", "invoices.json"))),
      bytes,
      "the file is the content's UTF-8, byte for byte"
    );
    const manifestText = new TextDecoder().decode(sourcesManifestBytes(manifest));
    assert.notInclude(manifestText, "inv-1", "the content reached the manifest");
    assert.deepEqual(decodeSourcesManifest(sourcesManifestBytes(manifest)), manifest);
  });

  it("defaults the type to text/plain, and _Check sources_ counts it without fetching", async () => {
    const checked = await checkSources([{ kind: "text", name: "notes.md", content: "# Notes\n" }], offline);
    assert.deepEqual(checked, [
      { source: { kind: "text", name: "notes.md", contentType: "text/plain" }, files: 1, bytes: 8 },
    ]);
  });

  it("is a source like the others in one list: order kept, each in its own directory", async () => {
    const out = path.join(root, "two");
    const { manifest } = await fetchSources(
      [
        { kind: "text", name: "b.txt", content: "second\n", contentType: "text/plain" },
        { kind: "text", name: "a.md", content: "first\n", contentType: "text/markdown" },
      ],
      offline,
      out
    );
    assert.deepEqual(
      manifest.sources.map((e) => e.dir),
      ["text/b.txt", "text/a.md"]
    );
    assert.equal(fs.readFileSync(path.join(out, "text", "a.md", "a.md"), "utf8"), "first\n");
  });

  it("is published to Irys and restored like a URL's file, under its own content type", async () => {
    const out = path.join(root, "irys");
    const { manifest, hash } = await fetchSources(
      [{ kind: "text", name: "invoices.json", content: INVOICES, contentType: "application/json" }],
      offline,
      out
    );
    const objects = new Map<string, { bytes: Uint8Array; tags: IrysTag[] }>();
    let n = 0;
    const irys = {
      upload: async (bytes: Uint8Array, tags: IrysTag[]) => {
        const id = sha256(utf8(`object-${n++}`));
        objects.set(hex(id), { bytes: Uint8Array.from(bytes), tags });
        return id;
      },
      download: async (id: Uint8Array) => objects.get(hex(id))?.bytes ?? null,
    };
    const published = await publishSources(manifest, out, irys);
    const file = [...objects.values()].find((o) => new TextDecoder().decode(o.bytes) === INVOICES)!;
    assert.deepInclude(file.tags, { name: "Content-Type", value: "application/json" });
    const restored = await restoreSources({ index: published.index, sourcesHash: hash }, irys);
    assert.equal(restored.hash, hash);
    assert.deepEqual(restored.manifest, manifest);
  });
});

describe("text sources: what the start refuses", () => {
  const one = (over: Record<string, unknown> = {}) => [
    { kind: "text", name: "invoices.json", content: INVOICES, contentType: "application/json", ...over },
  ];
  const refusal = (raw: unknown): string => {
    try {
      parseSourceInputs(raw);
    } catch (e) {
      assert.instanceOf(e, SourcesRefused);
      return (e as Error).message;
    }
    throw new Error("not refused");
  };

  it("takes a well-formed one, keeping the content exactly and the name trimmed", () => {
    const [parsed] = parseSourceInputs(one({ name: "  invoices.json " }));
    assert.deepEqual(parsed, {
      kind: "text",
      name: "invoices.json",
      content: INVOICES,
      contentType: "application/json",
    });
    // Absent stays absent in the input; the resolve says text/plain.
    assert.notProperty(parseSourceInputs([{ kind: "text", name: "a.txt", content: "x" }])[0], "contentType");
  });

  it("refuses by size: over 64 KiB each, and over 128 KiB together", () => {
    const big = "x".repeat(TEXT_SOURCE_MAX_BYTES + 1);
    assert.match(refusal(one({ content: big, contentType: "text/plain" })), /^source 1: .*over the 64 KiB/);
    // Exactly the cap is taken; the cap counts UTF-8 bytes, not characters.
    parseSourceInputs(one({ content: "x".repeat(TEXT_SOURCE_MAX_BYTES), contentType: "text/plain" }));
    assert.match(
      refusal(one({ content: "é".repeat(TEXT_SOURCE_MAX_BYTES / 2 + 1), contentType: "text/plain" })),
      /64 KiB/
    );
    const full = (name: string) => ({ kind: "text", name, content: "y".repeat(60 * 1024) });
    assert.match(refusal([full("a.txt"), full("b.txt"), full("c.txt")]), /^source 3: the attached files together/);
  });

  it("refuses JSON that does not parse, a NUL, invalid UTF-8 and a type it may not say", () => {
    assert.match(refusal(one({ content: "{ not json" })), /does not parse as JSON/);
    assert.match(refusal(one({ content: '{"a":"\u0000"}' })), /NUL byte/);
    assert.match(refusal(one({ content: "bad \ud800 surrogate", contentType: "text/plain" })), /not valid UTF-8/);
    assert.match(refusal(one({ contentType: "text/html" })), /not "text\/html"/);
    assert.match(refusal(one({ content: 7 })), /content is text/);
  });

  it("refuses a name the sandbox's tree cannot hold, and two files of one name", () => {
    for (const [name, why] of [
      ["", /needs a name|is empty/],
      ["..", /is "\.\."/],
      ["a/b.json", /has a \/ inside a name/],
      ["bad\u0001.json", /control character/],
      ["é.json", /NFC/],
      ["x".repeat(256), /255 UTF-8 bytes/],
    ] as const) {
      assert.match(refusal(one({ name })), why, JSON.stringify(name));
    }
    assert.match(refusal([...one(), ...one()]), /^source 2: is source 1 again/);
  });

  it("counts toward the eight-source cap", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ kind: "text", name: `${i}.txt`, content: "x" }));
    assert.match(refusal(nine), /at most 8 sources, not 9/);
  });

  it("is the same sentence in the runtime's own check", () => {
    assert.isNull(textSourceProblem({ name: "invoices.json", content: INVOICES, contentType: "application/json" }));
    assert.match(textSourceProblem({ name: "i.json", content: "{", contentType: "application/json" })!, /JSON/);
  });
});

describe("text sources: the signature binds the bytes", () => {
  const body = (content: string) => ({
    action: "start",
    agentId: "ab".repeat(32),
    prompt: "Settle this week's invoices.",
    sandbox: { sources: [{ kind: "text", name: "invoices.json", content, contentType: "application/json" }] },
  });

  it("moves the Request ID when one byte of the attached file changes", () => {
    const a = loopStartBodyHash(body(INVOICES));
    assert.equal(loopStartBodyHash(body(INVOICES)), a);
    assert.notEqual(loopStartBodyHash(body(INVOICES.replace('"120"', '"121"'))), a);
    assert.notEqual(loopStartBodyHash(body(`${INVOICES}\n`)), a);
  });
});

describe("text sources: run again and template versions", () => {
  const OWNER = "Owner1111111111111111111111111111111111111";
  const big = JSON.stringify({ pad: "z".repeat(60 * 1024) });
  const config = (content: string) => ({
    prompt: "check the slot and report",
    intervalMs: 15_000,
    maxSteps: 3,
    budgetMicroUsdcPerStep: "50000",
    model: "deepseek/deepseek-v4.1-flash",
    coordinator: { agentId: "aa".repeat(32) },
    members: [],
    sandbox: { sources: [{ kind: "text", name: "invoices.json", content, contentType: "application/json" }] },
  });

  it("stores the content in a version (the owner signed it), measured outside the config's bound", () => {
    assert.isAbove(big.length, MAX_CONFIG_CHARS, "the case must be over the shared bound");
    const checked = checkConfig("loop", config(big));
    assert.notProperty(checked, "error", (checked as { error?: string }).error);
    const stored = (checked as { config: { sandbox?: { sources?: { content?: string }[] } } }).config;
    assert.equal(stored.sandbox!.sources![0].content, big, "the version keeps the bytes the start signed");
    // A refused attachment is refused by its own rule on a PUT too.
    assert.match((checkConfig("loop", config("{")) as { error: string }).error, /does not parse as JSON/);
    // The start's own sandbox check keeps it as sent.
    const sandbox = checkSandboxConfig(config(INVOICES).sandbox) as { sandbox: { sources: unknown[] } };
    assert.deepEqual(sandbox.sandbox.sources, config(INVOICES).sandbox.sources);
  });

  it("keeps it in the stored version, and Run again carries it whole", () => {
    const t = implicitTemplate({
      kind: "loop",
      owner: OWNER,
      name: "treasury-loop",
      config: (checkConfig("loop", config(INVOICES)) as { config: never }).config,
    });
    // `GET /api/templates` answers the stored version as it is (one view for every reader), so
    // what is stored is what is served.
    const stored = lookupTemplate(t.id, t.version)!.config as { sandbox?: { sources?: unknown[] } };
    assert.deepEqual(stored.sandbox!.sources, config(INVOICES).sandbox.sources);
    // _Run again_ from the version opens the form with the same attachment, content and all.
    const draft = sourceToDraft({
      kind: "loop-template",
      wallet: OWNER,
      row: { id: t.id, kind: "loop", owner: OWNER, name: t.name, version: t.version, config: t.config } as never,
    });
    assert.deepEqual(draft.loop?.sandbox?.sources as unknown[], config(INVOICES).sandbox.sources);
    assert.isOk(traceDir);
  });
});

describe("text sources: the form and the ZeroClaw tab", () => {
  it("attaches a picked file by its extension's type, refusing what the start would", () => {
    assert.equal(textTypeOf("invoices.JSON"), "application/json");
    assert.equal(textTypeOf("spec.md"), "text/markdown");
    assert.equal(textTypeOf("notes.txt"), "text/plain");
    const ok = attachFile("invoices.json", utf8(INVOICES));
    assert.deepEqual(ok, {
      ok: true,
      source: { kind: "text", name: "invoices.json", content: INVOICES, contentType: "application/json" },
    });
    assert.match((attachFile("x.json", utf8("{")) as { error: string }).error, /JSON/);
    assert.match((attachFile("x.txt", Uint8Array.of(0xff, 0xfe, 0x00)) as { error: string }).error, /not UTF-8/);
    assert.match(
      (attachFile("x.txt", new Uint8Array(TEXT_SOURCE_MAX_BYTES + 1).fill(0x61)) as { error: string }).error,
      /64 KiB at most/
    );
    // A decomposed name is put in NFC rather than refused: the picker's name is the OS's spelling.
    const nfc = attachFile("é.txt", utf8("x"));
    assert.equal((nfc as { source: { name: string } }).source.name, "é.txt");
    const a = { kind: "text" as const, name: "a.txt", content: "x" };
    assert.match(attachedListProblem([a, a])!, /Two attached files are named a\.txt/);
    assert.isNull(attachedListProblem([a, { kind: "url", url: "https://example.org/a.txt" }]));
  });

  it("names an attached entry text · name · size · sha256 short, and no other kind", () => {
    const bytes = utf8(INVOICES);
    const sha = hex(sha256(bytes));
    const line = textSourceLine({
      source: { kind: "text", name: "invoices.json", contentType: "application/json" },
      dir: "text/invoices.json",
      files: [{ path: "text/invoices.json/invoices.json", size: bytes.length, sha256: sha }],
    });
    assert.equal(line, `text · invoices.json · ${bytes.length} B · ${sha.slice(0, 12)}`);
    assert.isNull(textSourceLine(THREE.sources[1]));
  });
});
