import { decodeIrysId, hex, irysIdString, LocatorScheme, sha256, utf8, type Locator } from "@lath/sdk";
import {
  decodeSourcesIrysIndex,
  irysSourceProblem,
  loopSourcesProblem,
  SOURCES_IRYS_TAG,
  sourcesHash,
  sourcesIrysIndexBytes,
  sourcesIrysKey,
  sourcesManifestBytes,
  type SourceEntry,
  type SourcesIrysIndex,
  type SourcesManifest,
} from "@lath/runtime/zeroclaw/sources";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SourcesRefused } from "../frontend/src/app/api/_lib/sources";
import {
  publishSources,
  irysGateway,
  restoreSources,
  SourcesPublishFailed,
  type IrysTag,
  type LocateSourcesIndex,
  type SourcesGateway,
  type SourcesUploader,
} from "../frontend/src/app/api/_lib/sources-irys";

/**
 * Sources in clear on Irys and restoring a whole set from there. Node-only: Irys, the gateway and
 * the chain's locator read are
 * all stubs below, so nothing here uploads, signs or opens a socket.
 */

// ─── A stubbed Irys: an uploader and a gateway over one map ─────────────────

class FakeIrys implements SourcesUploader, SourcesGateway {
  readonly objects = new Map<string, { bytes: Uint8Array; tags: IrysTag[] }>();
  private n = 0;
  /** Throws like a node with no balance for the upload whose tags match. */
  failOn: ((tags: IrysTag[]) => boolean) | null = null;

  async upload(bytes: Uint8Array, tags: IrysTag[]): Promise<Uint8Array> {
    if (this.failOn?.(tags)) throw new Error("402: not enough balance at Irys");
    const id = sha256(utf8(`irys-object-${this.n++}`));
    this.objects.set(hex(id), { bytes: Uint8Array.from(bytes), tags });
    return id;
  }

  async download(id: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
    const o = this.objects.get(hex(id));
    if (!o || o.bytes.length > maxBytes) return null;
    return Uint8Array.from(o.bytes);
  }

  /** An object planted by hand, as a stranger could upload one. Returns its id as Irys prints it. */
  async plant(bytes: Uint8Array): Promise<string> {
    return irysIdString(await this.upload(bytes, []));
  }

  get(id: string): { bytes: Uint8Array; tags: IrysTag[] } {
    const o = this.objects.get(hex(decodeIrysId(id)));
    if (!o) throw new Error(`no object ${id}`);
    return o;
  }

  tamper(id: string, f: (b: Uint8Array) => Uint8Array): void {
    const o = this.get(id);
    o.bytes = f(Uint8Array.from(o.bytes));
  }
}

/** The chain's `LocatorRegistry` read, as a map from (agent, key) to the cell's locator. */
function chain(): { locate: LocateSourcesIndex; cells: Map<string, Locator> } {
  const cells = new Map<string, Locator>();
  return {
    cells,
    locate: async (agent, key) => cells.get(`${hex(agent)}/${hex(key)}`) ?? null,
  };
}

// ─── A fetched set on disk, and its manifest ────────────────────────────────

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const AGENT = "ab".repeat(32);

const README = "# Squads v4\n\nThe multisig program.\n";
const CONTENT: Record<string, string> = {
  "github/Squads-Protocol/v4/programs/README.md": README,
  // The same bytes under a second path: uploaded once, restored twice.
  "github/Squads-Protocol/v4/programs/docs/COPY.md": README,
  "github/Squads-Protocol/v4/programs/idl.json": '{"name":"squads_multisig_program"}\n',
  "github/Squads-Protocol/v4/programs/src/lib.rs": "pub fn process() {}\n",
  "url/docs.example.org/spec.md/spec.md": "# Upgrade authority\n\nWho may upgrade.\n",
  [`solana/devnet/${SQUADS}/account.json`]:
    '{"executable":true,"owner":"BPFLoaderUpgradeab1e11111111111111111111111"}\n',
};

function fileOf(p: string) {
  const bytes = utf8(CONTENT[p]);
  return { path: p, size: bytes.length, sha256: hex(sha256(bytes)) };
}

function sortedFiles(prefix: string) {
  return Object.keys(CONTENT)
    .filter((p) => p.startsWith(`${prefix}/`))
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))
    .map(fileOf);
}

function manifest(): SourcesManifest {
  const entries: SourceEntry[] = [
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
      files: sortedFiles("github/Squads-Protocol/v4"),
      skipped: { files: 1, bytes: 2_000_000 },
    },
    {
      source: {
        kind: "url",
        input: "https://docs.example.org/spec.md",
        finalUrl: "https://docs.example.org/spec.md",
        contentType: "text/markdown",
      },
      dir: "url/docs.example.org/spec.md",
      files: sortedFiles("url/docs.example.org/spec.md"),
    },
    {
      source: { kind: "solana", input: `devnet:${SQUADS}`, cluster: "devnet", address: SQUADS, slot: "503739376" },
      dir: `solana/devnet/${SQUADS}`,
      files: sortedFiles(`solana/devnet/${SQUADS}`),
    },
  ];
  return { v: 1, sources: entries };
}

let tmp: string;

function laidOut(): string {
  const dir = fs.mkdtempSync(path.join(tmp, "set-"));
  for (const [p, text] of Object.entries(CONTENT)) {
    const at = path.join(dir, ...p.split("/"));
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  }
  return dir;
}

function tagOf(tags: IrysTag[], name: string): string | undefined {
  return tags.find((t) => t.name === name)?.value;
}

async function refusal(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lath-sources-irys-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── The suite ──────────────────────────────────────────────────────────────

describe("sources on Irys: publish and restore", () => {
  it("a round trip gives the same sourcesHash, by index id and by agent through the locator", async () => {
    const m = manifest();
    const irys = new FakeIrys();
    const published = await publishSources(m, laidOut(), irys);
    assert.equal(published.sourcesHash, sourcesHash(m));
    // Five distinct files (two paths share one), the manifest and the index.
    assert.equal(published.uploads, 5 + 2);
    assert.equal(Object.keys(published.files).length, 5);
    // What went up as the manifest is the manifest's own bytes: nothing about Irys is in them.
    assert.deepEqual(irys.get(published.manifest).bytes, sourcesManifestBytes(m));
    assert.deepEqual(decodeSourcesIrysIndex(irys.get(published.index).bytes), {
      sourcesHash: published.sourcesHash,
      manifest: published.manifest,
      files: published.files,
    });

    const byId = await restoreSources(published.index, irys);
    assert.equal(byId.hash, sourcesHash(m));
    assert.equal(sourcesHash(byId.manifest), sourcesHash(m));
    assert.deepEqual(sourcesManifestBytes(byId.manifest), sourcesManifestBytes(m));

    const withHash = await restoreSources({ index: published.index, sourcesHash: published.sourcesHash }, irys);
    assert.equal(withHash.hash, published.sourcesHash);

    const { locate, cells } = chain();
    cells.set(`${AGENT}/${hex(sourcesIrysKey(published.sourcesHash))}`, {
      scheme: LocatorScheme.Irys,
      id: decodeIrysId(published.index),
    });
    const out = path.join(tmp, "restored-by-agent");
    const byAgent = await restoreSources({ agent: AGENT, sourcesHash: published.sourcesHash }, irys, {
      locate,
      outDir: out,
    });
    assert.equal(byAgent.hash, published.sourcesHash);
    assert.equal(byAgent.resolved.kind, "irys");
    assert.equal(byAgent.resolved.agent, AGENT);
    assert.equal(byAgent.resolved.index, published.index);
    assert.deepEqual(byAgent.resolved.manifest, m);
    // Laid out as the fetch laid it out: every path, every byte, the shared file at both paths.
    for (const [p, text] of Object.entries(CONTENT)) {
      assert.equal(fs.readFileSync(path.join(out, ...p.split("/")), "utf8"), text, p);
    }
    assert.equal(byAgent.files.length, Object.keys(CONTENT).length);
  });

  it("tags each file with a content type the gateway serves as text", async () => {
    const irys = new FakeIrys();
    const published = await publishSources(manifest(), laidOut(), irys);
    const typeOf = (p: string) => tagOf(irys.get(published.files[fileOf(p).sha256]).tags, "Content-Type");
    assert.equal(typeOf("github/Squads-Protocol/v4/programs/README.md"), "text/markdown; charset=utf-8");
    assert.equal(typeOf("github/Squads-Protocol/v4/programs/idl.json"), "application/json");
    assert.equal(typeOf("github/Squads-Protocol/v4/programs/src/lib.rs"), "text/plain; charset=utf-8");
    assert.equal(typeOf("url/docs.example.org/spec.md/spec.md"), "text/markdown");
    assert.equal(typeOf(`solana/devnet/${SQUADS}/account.json`), "application/json");
    const lib = irys.get(published.files[fileOf("github/Squads-Protocol/v4/programs/src/lib.rs").sha256]).tags;
    assert.equal(tagOf(lib, "Lath-Path"), "sources/github/Squads-Protocol/v4/programs/src/lib.rs");
    assert.equal(tagOf(lib, "Lath-Sources-Hash"), published.sourcesHash);
    assert.equal(tagOf(irys.get(published.index).tags, "Lath-Kind"), "sources.index");
  });

  it("refuses a flipped byte in one file, naming its path, and writes nothing", async () => {
    const irys = new FakeIrys();
    const published = await publishSources(manifest(), laidOut(), irys);
    const lib = fileOf("github/Squads-Protocol/v4/programs/src/lib.rs");
    irys.tamper(published.files[lib.sha256], (b) => {
      b[3] ^= 0x01;
      return b;
    });
    const out = path.join(tmp, "restored-flipped");
    const e = await refusal(
      restoreSources({ index: published.index, sourcesHash: published.sourcesHash }, irys, { outDir: out })
    );
    assert.instanceOf(e, SourcesRefused);
    assert.match(e.message, /sources\/github\/Squads-Protocol\/v4\/programs\/src\/lib\.rs .* does not re-hash/);
    assert.isFalse(fs.existsSync(out));
    assert.deepEqual(
      fs.readdirSync(tmp).filter((n) => n.includes("restored-flipped")),
      [],
      "no staging directory is left behind"
    );
  });

  it("refuses a manifest that does not hash to the sources hash", async () => {
    const irys = new FakeIrys();
    const published = await publishSources(manifest(), laidOut(), irys);
    // A gateway that serves other bytes under the manifest's id.
    irys.tamper(published.manifest, (b) => {
      const text = new TextDecoder().decode(b).replace('"slot":"503739376"', '"slot":"503739377"');
      return utf8(text);
    });
    const e = await refusal(restoreSources({ index: published.index, sourcesHash: published.sourcesHash }, irys));
    assert.instanceOf(e, SourcesRefused);
    assert.match(e.message, new RegExp(`hashes to [0-9a-f]{64}, not to the sources hash ${published.sourcesHash}`));

    // An index that names the right hash but points at another set's manifest.
    const other = manifest();
    other.sources.pop();
    const otherId = await irys.plant(sourcesManifestBytes(other));
    const lying: SourcesIrysIndex = { sourcesHash: published.sourcesHash, manifest: otherId, files: published.files };
    const lyingId = await irys.plant(sourcesIrysIndexBytes(lying));
    const e2 = await refusal(restoreSources({ index: lyingId, sourcesHash: published.sourcesHash }, irys));
    assert.match(e2.message, new RegExp(`hashes to ${sourcesHash(other)}, not to the sources hash`));
  });

  it("refuses an index naming another hash, whether given raw or found through the agent", async () => {
    const irys = new FakeIrys();
    const published = await publishSources(manifest(), laidOut(), irys);
    const asked = "cd".repeat(32);
    const e = await refusal(restoreSources({ index: published.index, sourcesHash: asked }, irys));
    assert.instanceOf(e, SourcesRefused);
    assert.match(e.message, new RegExp(`is for sources ${published.sourcesHash}, not ${asked}`));

    // A cell under the asked hash's key that points at this set's index: the index still decides.
    const { locate, cells } = chain();
    cells.set(`${AGENT}/${hex(sourcesIrysKey(asked))}`, {
      scheme: LocatorScheme.Irys,
      id: decodeIrysId(published.index),
    });
    const e2 = await refusal(restoreSources({ agent: AGENT, sourcesHash: asked }, irys, { locate }));
    assert.match(e2.message, new RegExp(`is for sources ${published.sourcesHash}, not ${asked}`));
  });

  it("refuses an agent with no cell for the hash, or one that is not an Irys locator", async () => {
    const irys = new FakeIrys();
    const published = await publishSources(manifest(), laidOut(), irys);
    const { locate, cells } = chain();
    const e = await refusal(restoreSources({ agent: AGENT, sourcesHash: published.sourcesHash }, irys, { locate }));
    assert.match(e.message, /has anchored no Irys index for these sources/);
    cells.set(`${AGENT}/${hex(sourcesIrysKey(published.sourcesHash))}`, {
      scheme: LocatorScheme.Raw,
      id: decodeIrysId(published.index),
    });
    const e2 = await refusal(restoreSources({ agent: AGENT, sourcesHash: published.sourcesHash }, irys, { locate }));
    assert.match(e2.message, /locator scheme 0, not Irys/);
    // An agent and an id that disagree: the chain's cell is the one believed, and the pair refused.
    cells.set(`${AGENT}/${hex(sourcesIrysKey(published.sourcesHash))}`, {
      scheme: LocatorScheme.Irys,
      id: decodeIrysId(published.manifest),
    });
    const e3 = await refusal(
      restoreSources({ agent: AGENT, index: published.index, sourcesHash: published.sourcesHash }, irys, { locate })
    );
    assert.match(e3.message, /not the one the agent anchored/);
  });

  it("refuses an index file missing from the index, and one that is not an index at all", async () => {
    const irys = new FakeIrys();
    const published = await publishSources(manifest(), laidOut(), irys);
    const lib = fileOf("github/Squads-Protocol/v4/programs/src/lib.rs");
    const files = { ...published.files };
    delete files[lib.sha256];
    const short = await irys.plant(
      sourcesIrysIndexBytes({ sourcesHash: published.sourcesHash, manifest: published.manifest, files })
    );
    const e = await refusal(restoreSources(short, irys));
    assert.match(e.message, /sources\/github\/Squads-Protocol\/v4\/programs\/src\/lib\.rs has no Irys id/);
    const e2 = await refusal(restoreSources(published.manifest, irys));
    assert.match(e2.message, /is not a sources index/);
  });

  it("reads the gateway by the base64url spelling, and gives up past the size it was asked for", async () => {
    const id = sha256(utf8("object"));
    const seen: string[] = [];
    const body = utf8("x".repeat(100));
    let status = 200;
    const gw = irysGateway("https://gateway.test/", {
      fetch: (async (url: string) => {
        seen.push(url);
        return new Response(status === 200 ? body : "no", { status });
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(await gw.download(id, 100), body);
    assert.equal(seen[0], `https://gateway.test/${Buffer.from(id).toString("base64url")}`);
    assert.isNull(await gw.download(id, 99));
    status = 404;
    assert.isNull(await gw.download(id, 100));
  });

  it("does not publish a file changed on disk since the fetch, and names a file whose upload fails", async () => {
    const dir = laidOut();
    fs.appendFileSync(path.join(dir, "url", "docs.example.org", "spec.md", "spec.md"), "edited\n");
    const e = await refusal(publishSources(manifest(), dir, new FakeIrys()));
    assert.instanceOf(e, SourcesPublishFailed);
    assert.equal((e as SourcesPublishFailed).path, "url/docs.example.org/spec.md/spec.md");
    assert.match(
      e.message,
      /sources\/url\/docs\.example\.org\/spec\.md\/spec\.md on disk is not the file the manifest commits/
    );

    const irys = new FakeIrys();
    irys.failOn = (tags) => tagOf(tags, "Lath-Path") === `sources/solana/devnet/${SQUADS}/account.json`;
    const e2 = await refusal(publishSources(manifest(), laidOut(), irys));
    assert.instanceOf(e2, SourcesPublishFailed);
    assert.match(e2.message, /account\.json did not upload to Irys: 402/);
    irys.failOn = (tags) => tagOf(tags, "Lath-Kind") === "sources.index";
    const e3 = await refusal(publishSources(manifest(), laidOut(), irys));
    assert.match(e3.message, /^sources\.index did not upload/);
  });
});

describe("sources on Irys: nothing that was hashed moves", () => {
  it("a manifest that does not use the new kind hashes exactly as before (the pinned vector)", () => {
    // `tests/sandbox-sources-manifest.ts`'s two-source vector, restated so this suite fails on its
    // own if the Irys additions ever reach the manifest's bytes.
    const H = (c: string) => c.repeat(64);
    const m: SourcesManifest = {
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
          source: { kind: "solana", input: `devnet:${SQUADS}`, cluster: "devnet", address: SQUADS, slot: "503739376" },
          dir: `solana/devnet/${SQUADS}`,
          files: [
            { path: `solana/devnet/${SQUADS}/account.json`, size: 300, sha256: H("c") },
            { path: `solana/devnet/${SQUADS}/program.json`, size: 250, sha256: H("d") },
          ],
        },
      ],
    };
    assert.equal(sourcesHash(m), "4805a13e7799f9230bac1ea67a952ce370b41adac2c8f68c5a2b4c7165859207");
    assert.isTrue(new TextDecoder().decode(sourcesManifestBytes(m)).startsWith("lath.sources.v1\n"));
  });

  it("pins the locator key a set's index is anchored under, apart from the manifest's own hash", () => {
    const h = "4805a13e7799f9230bac1ea67a952ce370b41adac2c8f68c5a2b4c7165859207";
    const key = sourcesIrysKey(h);
    assert.equal(hex(key), hex(sha256(utf8(`${SOURCES_IRYS_TAG}\n`), Buffer.from(h, "hex"))));
    assert.equal(hex(key), "d10007e6490ef27b4874e5001e5752c9c51b6c68d16cf2396bede6b0349b88ee");
    assert.notEqual(hex(key), h);
    assert.throws(() => sourcesIrysKey("not a hash"), /not a sources hash/);
  });

  it("reads an index one way only", () => {
    const index: SourcesIrysIndex = {
      sourcesHash: "ab".repeat(32),
      manifest: irysIdString(sha256(utf8("m"))),
      files: { ["cd".repeat(32)]: irysIdString(sha256(utf8("f"))) },
    };
    const bytes = sourcesIrysIndexBytes(index);
    assert.isTrue(new TextDecoder().decode(bytes).startsWith("lath.sources.irys.v1\n{"));
    assert.deepEqual(decodeSourcesIrysIndex(bytes), index);
    const json = new TextDecoder().decode(bytes).slice(SOURCES_IRYS_TAG.length + 1);
    assert.isNull(decodeSourcesIrysIndex(utf8(`lath.sources.v1\n${json}`)));
    assert.isNull(decodeSourcesIrysIndex(utf8(`${SOURCES_IRYS_TAG}\n${JSON.stringify(index, null, 1)}`)));
    assert.isNull(decodeSourcesIrysIndex(sourcesIrysIndexBytes({ ...index, extra: 1 } as SourcesIrysIndex)));
    assert.isNull(decodeSourcesIrysIndex(sourcesIrysIndexBytes({ ...index, manifest: "not-an-id" })));
  });

  it("takes an irys source only as the loop's one source, with a hash and a way to find it", () => {
    const hash = "ab".repeat(32);
    assert.isNull(loopSourcesProblem([{ kind: "github", url: "https://github.com/a/b" }]));
    assert.isNull(loopSourcesProblem([{ kind: "irys", agent: AGENT, sourcesHash: hash }]));
    assert.match(
      loopSourcesProblem([
        { kind: "irys", agent: AGENT, sourcesHash: hash },
        { kind: "url", url: "https://docs.example.org/spec.md" },
      ]) ?? "",
      /only source/
    );
    assert.match(irysSourceProblem({ kind: "irys", sourcesHash: hash }) ?? "", /agent .* or its Irys index id/);
    assert.match(irysSourceProblem({ kind: "irys", agent: AGENT, sourcesHash: "abc" }) ?? "", /sources hash/);
    assert.match(irysSourceProblem({ kind: "irys", agent: "upgrade-watch", sourcesHash: hash }) ?? "", /64/);
    assert.isNull(irysSourceProblem({ kind: "irys", index: irysIdString(sha256(utf8("i"))), sourcesHash: hash }));
  });
});
