/**
 * A loop's sources in clear on Irys and a whole set restored from there: the library half. The console
 * wiring — publishing at start, the locator cell, routing an `irys` source here — is in
 * `loop-sources.ts`.
 *
 * ## What goes up
 *
 * `publishSources` uploads, in this order:
 *
 * 1. every file of the manifest, once per distinct `sha256`, **in clear**, tagged with a
 *    `Content-Type` so the gateway serves readable text (a reader opens a cited file in a browser);
 * 2. the manifest's own bytes, `sourcesManifestBytes(m)` — the bytes `sourcesHash` hashes, so a
 *    stranger re-hashes the download against the posture on chain;
 * 3. the index, `lath.sources.irys.v1\n` + canonical JSON `{ sourcesHash, manifest, files }`
 *    (`runtime/src/zeroclaw/sources.ts`), and returns its id.
 *
 * The manifest's bytes do not change: an Irys id is in the index, never in the manifest, so a
 * loop's `sourcesHash` is the same whether or not its sources were published, and a loop restored
 * from them commits the same hash as the loop that published them.
 *
 * Every source is public already (a public repo, a public URL, a public account), so publishing
 * in clear costs no secrecy the inputs had; what it does reveal is the list — what the loop reads.
 *
 * ## What is trusted
 *
 * Irys and the gateway are trusted for availability only, as everywhere else (`sdk/src/irys.ts`).
 * `restoreSources` re-hashes the manifest against `sourcesHash` and every file against the
 * manifest before anything is returned or written, and any mismatch refuses the whole set with the
 * file named. The index only says where to look; a lying index is caught by the hashes.
 *
 * ## How a stranger finds a set
 *
 * By agent and `sourcesHash`: the publishing loop's agent carries one `LocatorRegistry` cell,
 * `sourcesIrysKey(sourcesHash) → index id` (a domain-separated key, for the reason
 * `sourcesIrysKey` gives). `restoreSources({ agent, sourcesHash })` reads that cell, so the path
 * from a posture on chain to the bytes on Irys has no console in it. A raw index id is accepted
 * too, checked against the `sourcesHash` the caller names.
 */
import {
  HttpGatewayBackend,
  IRYS_ENCODING,
  IRYS_NODES,
  LathClient,
  LocatorRegistry,
  LocatorScheme,
  decodeIrysId,
  hex,
  irysIdString,
  sha256,
  toBytes32,
  type IrysNetwork,
  type Locator,
} from "@lath/sdk";
import {
  SOURCES_MAX_BYTES,
  SOURCES_MAX_FILES,
  decodeSourcesIrysIndex,
  SOURCES_IRYS_TAG,
  decodeSourcesManifest,
  irysSourceLabel,
  irysSourceProblem,
  looksLikeIrysId,
  sourcesIndexProblem,
  sourcesIrysIndexBytes,
  sourcesIrysKey,
  sourcesManifestBytes,
  type IrysSourceInput,
  type ResolvedIrysSource,
  type SourceEntry,
  type SourceFile,
  type SourcesIrysIndex,
  type SourcesManifest,
} from "@lath/runtime/zeroclaw/sources";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SourcesRefused } from "./sources";

// ─── Uploading ───────────────────────────────────────────────────────────────

export interface IrysTag {
  name: string;
  value: string;
}

/**
 * What `publishSources` uploads through: one call, one object, its Irys id as 32 raw bytes. Tags
 * are the reason this is not the SDK's `LocatorBackend`: `IrysBackend.upload` tags every blob
 * `application/octet-stream`, right for ciphertext and epoch blobs, while a source file must be
 * served as the text it is. `irysSourcesUploader` is the real one; a suite passes a stub.
 */
export interface SourcesUploader {
  upload(bytes: Uint8Array, tags: IrysTag[]): Promise<Uint8Array>;
}

/** The slice of the Irys client the uploader uses — `IrysBackend`'s, restated so the types stay ours. */
interface IrysUploadClient {
  upload(data: Buffer, opts?: { tags?: IrysTag[] }): Promise<{ id: string }>;
}

/**
 * The real uploader, on the same key, network and node the console's `IrysBackend` is built with
 * (`runner.ts` `irysBackendFor`), so the sources are paid from the balance the epochs are. Built on
 * first use, like `IrysBackend`, so constructing it loads nothing; a connection that fails is not
 * cached. No retry: an upload that threw after the bytes were paid for would be paid twice, and a
 * failed publish refuses the start, which the owner can simply try again.
 */
export function irysSourcesUploader(opts: {
  wallet: { secretKey: Uint8Array } | Uint8Array;
  network: IrysNetwork;
  rpc: string;
  node?: string;
}): SourcesUploader {
  const secretKey = opts.wallet instanceof Uint8Array ? opts.wallet : opts.wallet?.secretKey;
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new Error("the sources uploader needs the console's Solana keypair (a 64-byte secret key)");
  }
  if (!opts.rpc) throw new Error("the sources uploader needs the Solana RPC url Irys prices against");
  const node = (opts.node || IRYS_NODES[opts.network]).replace(/\/+$/, "");
  let client: Promise<IrysUploadClient> | null = null;
  const connect = (): Promise<IrysUploadClient> => {
    if (!client) {
      client = (async () => {
        const [{ Uploader }, { Solana }] = await Promise.all([import("@irys/upload"), import("@irys/upload-solana")]);
        const builder = Uploader(Solana as any)
          .withWallet(secretKey)
          .withRpc(opts.rpc)
          .network(opts.network)
          .bundlerUrl(node);
        return (await builder.build()) as unknown as IrysUploadClient;
      })();
      client.catch(() => (client = null));
    }
    return client;
  };
  return {
    async upload(bytes, tags) {
      const receipt = await (await connect()).upload(Buffer.from(bytes), { tags });
      return decodeIrysId(receipt.id);
    },
  };
}

/**
 * The `Content-Type` a file is served with. A URL source carries the type its server answered with
 * in the manifest, and that is the tag. The other two kinds carry none, so it is read off what
 * they are: a Solana source is canonical JSON (`account.json`, `program.json`, an IDL), and a
 * GitHub file passed the fetcher's text test, so it is markdown or JSON by its extension and plain
 * UTF-8 text otherwise — never `text/html`, which a gateway would render rather than show.
 */
function sourceContentType(entry: SourceEntry, file: SourceFile): string {
  switch (entry.source.kind) {
    case "url":
      return entry.source.contentType;
    // An attached file is one of three types, held to them at start; the text ones say their charset,
    // as a GitHub file's do.
    case "text":
      return entry.source.contentType === "application/json"
        ? "application/json"
        : `${entry.source.contentType}; charset=utf-8`;
    case "solana":
      return "application/json";
    case "github": {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1).toLowerCase();
      if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown; charset=utf-8";
      if (name.endsWith(".json")) return "application/json";
      return "text/plain; charset=utf-8";
    }
  }
}

/** The manifest and the index are a tag line and canonical JSON: text, served as such. */
const TEXT = "text/plain; charset=utf-8";

/** What `publishSources` put on Irys. Every id is base58, as Irys prints it. */
export interface PublishedSources {
  /** The index's id: what the locator cell points at and what a raw restore names. */
  index: string;
  sourcesHash: string;
  manifest: string;
  /** `sha256 → id`, as in the index. */
  files: Record<string, string>;
  /** Objects uploaded (distinct files, the manifest and the index) and their bytes together, for the storage card. */
  uploads: number;
  bytes: number;
}

/** A publish that could not finish. Names the file when one was the cause. Nothing is anchored for it. */
export class SourcesPublishFailed extends Error {
  readonly path?: string;
  constructor(message: string, filePath?: string) {
    super(message);
    this.name = "SourcesPublishFailed";
    this.path = filePath;
  }
}

/**
 * Uploads a fetched set from `dir` — the directory `fetchSources` laid out, each file at its
 * manifest path — then its manifest, then its index, and returns where they are. Each file is read
 * back and checked against the manifest before it goes up, so what is on Irys is what the posture
 * commits and never a file changed on disk since the fetch. Throws `SourcesPublishFailed` on the
 * first failure; files already uploaded stay on Irys unreferenced, which is harmless (the order
 * `sdk/src/irys.ts` gives for epochs: bytes first, then what points at them).
 */
export async function publishSources(
  manifest: SourcesManifest,
  dir: string,
  backend: SourcesUploader
): Promise<PublishedSources> {
  const manifestBytes = sourcesManifestBytes(manifest);
  // The manifest's own checks — names, order, canonical form — before any of its paths is joined
  // onto `dir`: a path the decoder refuses is one this function must not read through.
  if (!decodeSourcesManifest(manifestBytes)) {
    throw new SourcesPublishFailed("the sources manifest is not one the sandbox would accept");
  }
  const sourcesHash = hex(sha256(manifestBytes));
  const root = path.resolve(dir);
  const files: Record<string, string> = {};
  let uploads = 0;
  let bytes = 0;
  const put = async (what: Uint8Array, tags: IrysTag[], filePath?: string): Promise<string> => {
    let id: Uint8Array;
    try {
      id = await backend.upload(what, tags);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new SourcesPublishFailed(
        `${
          filePath ? `sources/${filePath}` : tags.find((t) => t.name === "Lath-Kind")?.value
        } did not upload to Irys: ${why}`,
        filePath
      );
    }
    uploads++;
    bytes += what.length;
    return irysIdString(id);
  };

  for (const entry of manifest.sources) {
    for (const file of entry.files) {
      if (files[file.sha256]) continue;
      const at = path.resolve(root, ...file.path.split("/"));
      if (!at.startsWith(root + path.sep)) throw new SourcesPublishFailed(`sources/${file.path} leaves the directory`);
      let content: Uint8Array;
      try {
        content = fs.readFileSync(at);
      } catch (e) {
        throw new SourcesPublishFailed(
          `sources/${file.path} could not be read: ${e instanceof Error ? e.message : String(e)}`,
          file.path
        );
      }
      if (content.length !== file.size || hex(sha256(content)) !== file.sha256) {
        throw new SourcesPublishFailed(`sources/${file.path} on disk is not the file the manifest commits`, file.path);
      }
      files[file.sha256] = await put(
        content,
        [
          { name: "Content-Type", value: sourceContentType(entry, file) },
          { name: "Lath-Kind", value: "sources.file" },
          { name: "Lath-Sources-Hash", value: sourcesHash },
          { name: "Lath-Path", value: `sources/${file.path}` },
          { name: "Lath-Sha256", value: file.sha256 },
        ],
        file.path
      );
    }
  }
  const manifestId = await put(manifestBytes, [
    { name: "Content-Type", value: TEXT },
    { name: "Lath-Kind", value: "sources.manifest" },
    { name: "Lath-Sources-Hash", value: sourcesHash },
  ]);
  const index: SourcesIrysIndex = { sourcesHash, manifest: manifestId, files };
  const indexId = await put(sourcesIrysIndexBytes(index), [
    { name: "Content-Type", value: TEXT },
    { name: "Lath-Kind", value: "sources.index" },
    { name: "Lath-Sources-Hash", value: sourcesHash },
  ]);
  return { index: indexId, sourcesHash, manifest: manifestId, files, uploads, bytes };
}

// ─── Restoring ───────────────────────────────────────────────────────────────

/**
 * A read of one Irys object by its 32-byte id, returning at most `maxBytes` or `null`: gone, down,
 * or longer than the caller can use. The cap is the manifest's own size for a file, so a gateway
 * cannot make a restore hold more than the set it names.
 */
export interface SourcesGateway {
  download(id: Uint8Array, maxBytes: number): Promise<Uint8Array | null>;
}

/**
 * The public gateway, read the way `HttpGatewayBackend` reads it (the base64url spelling, a
 * failure is `null`), but counted while it streams: `HttpGatewayBackend.download` buffers
 * whatever comes back, which is fine for a blob the chain names by hash and not for a file whose
 * size a stranger's manifest declares.
 */
export function irysGateway(baseUrl: string, opts: { fetch?: typeof fetch } = {}): SourcesGateway {
  const reader = new HttpGatewayBackend(baseUrl, { scheme: LocatorScheme.Irys, encoding: IRYS_ENCODING });
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    async download(id, maxBytes) {
      let res: Response;
      try {
        res = await fetchImpl(reader.urlFor(id));
      } catch {
        return null;
      }
      if (!res.ok || !res.body) return null;
      const chunks: Uint8Array[] = [];
      let n = 0;
      const body = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await body.read();
          if (done) break;
          n += value.length;
          if (n > maxBytes) {
            await body.cancel().catch(() => undefined);
            return null;
          }
          chunks.push(value);
        }
      } catch {
        return null;
      }
      const out = new Uint8Array(n);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
  };
}

/** The locator cell a set's index is anchored under, read from the chain. Injected by the suites. */
export type LocateSourcesIndex = (agent: Uint8Array, key: Uint8Array) => Promise<Locator | null>;

/**
 * The chain read: the agent's default `LocatorRegistry`, the one its epochs and bundles anchor
 * through, at `sourcesIrysKey`. A read needs no authority, so the client signs with a throwaway
 * key. `runner.ts` is imported here, at the call, because it fixes its paths from the env when it
 * is first loaded and a module the suites load must not be the one that loads it.
 */
const chainLocate: LocateSourcesIndex = async (agent, key) => {
  const { rpcFor } = await import("./runner");
  const { Keypair } = await import("@solana/web3.js");
  const found = await new LocatorRegistry(LathClient.fromIdl(rpcFor(), Keypair.generate()), agent).resolve(key);
  return found ? found.locator : null;
};

/** The index and the manifest are small next to the files; these bound what a hostile id costs to read. */
const INDEX_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
/** Files read at once. A set is at most `SOURCES_MAX_FILES`; one at a time would take minutes. */
const CONCURRENCY = 8;

/** A set restored and checked: the original manifest, its hash, and each file's bytes at its path. */
export interface RestoredSources {
  resolved: ResolvedIrysSource;
  manifest: SourcesManifest;
  /** `sourcesHash(manifest)`, which is the hash asked for. */
  hash: string;
  files: { path: string; bytes: Uint8Array }[];
}

/**
 * A published set, fetched and checked, from its index id (a string) or from `{ agent, sourcesHash }`
 * through that agent's locator cell. `{ index, sourcesHash }` is the raw-id form the start takes:
 * the id is only trusted to point somewhere, and the hash decides. Every file is re-hashed against
 * the manifest and the manifest against `sourcesHash`; any mismatch refuses with `SourcesRefused`,
 * naming the file. With `outDir`, the files are laid out there as `fetchSources` lays out a fetch,
 * all or nothing, and `outDir` must not exist yet.
 */
export async function restoreSources(
  ref: string | Omit<IrysSourceInput, "kind">,
  gateway: string | SourcesGateway,
  opts: { outDir?: string; locate?: LocateSourcesIndex } = {}
): Promise<RestoredSources> {
  const input: IrysSourceInput =
    typeof ref === "string" ? { kind: "irys", index: ref, sourcesHash: "" } : { kind: "irys", ...ref };
  const expected = typeof ref === "string" ? null : ref.sourcesHash;
  const label = typeof ref === "string" ? `irys:${ref}` : irysSourceLabel(input);
  const refuse: (why: string) => never = (why) => {
    throw new SourcesRefused(`${label}: ${why}`);
  };
  if (typeof ref === "string") {
    if (!looksLikeIrysId(ref)) refuse("is not an Irys id");
  } else {
    const problem = irysSourceProblem(input);
    if (problem) refuse(problem);
  }
  const reader = typeof gateway === "string" ? irysGateway(gateway) : gateway;

  // The index's id: from the chain when an agent is named, else as given.
  let indexId: Uint8Array;
  const given = input.index !== undefined ? decodeId(input.index, "the index id", refuse) : null;
  if (input.agent !== undefined) {
    const found = await (opts.locate ?? chainLocate)(toBytes32(input.agent), sourcesIrysKey(input.sourcesHash)).catch(
      (e) => refuse(`the agent's locator could not be read: ${e instanceof Error ? e.message : String(e)}`)
    );
    if (!found) refuse(`agent ${input.agent} has anchored no Irys index for these sources`);
    if (found.scheme !== LocatorScheme.Irys) {
      refuse(`agent ${input.agent} anchored these sources under locator scheme ${found.scheme}, not Irys`);
    }
    indexId = found.id;
    if (given && hex(given) !== hex(indexId)) refuse("the index id given is not the one the agent anchored");
  } else if (given) {
    indexId = given;
  } else {
    // `irysSourceProblem` refuses an input with neither; this keeps the refusal if it ever did not.
    refuse("names neither an agent nor an index id");
  }
  const indexName = irysIdString(indexId);

  const indexBytes = await reader.download(indexId, INDEX_MAX_BYTES);
  if (!indexBytes) refuse(`the index ${indexName} is not available from the gateway`);
  const index = decodeSourcesIrysIndex(indexBytes);
  if (!index) refuse(`${indexName} is not a sources index (${SOURCES_IRYS_TAG})`);
  if (expected !== null && index.sourcesHash !== expected) {
    refuse(`the index ${indexName} is for sources ${index.sourcesHash}, not ${expected}`);
  }
  const want = index.sourcesHash;

  const manifestBytes = await reader.download(decodeId(index.manifest, "the manifest id", refuse), MANIFEST_MAX_BYTES);
  if (!manifestBytes) refuse(`the manifest ${index.manifest} is not available from the gateway`);
  const got = hex(sha256(manifestBytes));
  if (got !== want) refuse(`the manifest ${index.manifest} hashes to ${got}, not to the sources hash ${want}`);
  const manifest = decodeSourcesManifest(manifestBytes);
  if (!manifest) refuse(`the manifest ${index.manifest} hashes right but is not a sources manifest`);

  // The manifest's own caps, from its declared sizes, before a byte of a file is read: a set the
  // start could not have fetched is not one it restores either.
  const listed = manifest.sources.flatMap((e) => e.files);
  const total = listed.reduce((n, f) => n + f.size, 0);
  if (listed.length > SOURCES_MAX_FILES)
    refuse(`the set lists ${listed.length} files, over the ${SOURCES_MAX_FILES} cap`);
  if (total > SOURCES_MAX_BYTES) refuse(`the set is ${total} bytes, over the ${SOURCES_MAX_BYTES}-byte cap`);
  const tooLarge = sourcesIndexProblem(manifest);
  if (tooLarge) refuse(tooLarge);

  const shas = new Set(listed.map((f) => f.sha256));
  for (const f of listed) if (!index.files[f.sha256]) refuse(`sources/${f.path} has no Irys id in the index`);
  for (const sha of Object.keys(index.files)) {
    if (!shas.has(sha)) refuse(`the index names a file ${sha} the manifest does not list`);
  }

  // One read per distinct hash; the first path listed under a hash is the one a refusal names.
  const byHash = new Map<string, SourceFile>();
  for (const f of listed) if (!byHash.has(f.sha256)) byHash.set(f.sha256, f);
  const content = new Map<string, Uint8Array>();
  const queue = [...byHash.values()];
  const work = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const id = decodeId(index.files[f.sha256], `the id of sources/${f.path}`, refuse);
      const bytes = await reader.download(id, f.size);
      if (!bytes) refuse(`sources/${f.path} (${index.files[f.sha256]}) is not available from the gateway`);
      if (bytes.length !== f.size || hex(sha256(bytes)) !== f.sha256) {
        refuse(`sources/${f.path} (${index.files[f.sha256]}) does not re-hash to the manifest's ${f.sha256}`);
      }
      content.set(f.sha256, bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, work));

  const files = listed.map((f) => ({ path: f.path, bytes: content.get(f.sha256)! }));
  if (opts.outDir) layOut(files, opts.outDir);
  return {
    resolved: {
      kind: "irys",
      input: label,
      agent: input.agent ?? null,
      sourcesHash: want,
      index: indexName,
      manifest: manifest,
    },
    manifest: manifest,
    hash: want,
    files,
  };
}

function decodeId(id: string, what: string, refuse: (why: string) => never): Uint8Array {
  try {
    return decodeIrysId(id);
  } catch {
    return refuse(`${what} ${JSON.stringify(id)} is not a 32-byte Irys id`);
  }
}

/**
 * The restored files under `outDir`, as `fetchSources` writes a fetch: staged beside it and renamed
 * into place, so a failure leaves nothing, and `wx` so nothing is written over or through a link.
 * The paths passed `decodeSourcesManifest`'s name rule already.
 */
function layOut(files: { path: string; bytes: Uint8Array }[], outDir: string): void {
  const target = path.resolve(outDir);
  const staging = path.join(
    path.dirname(target),
    `.${path.basename(target)}.staging-${crypto.randomBytes(6).toString("hex")}`
  );
  try {
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    for (const f of files) {
      const dest = path.resolve(staging, ...f.path.split("/"));
      if (!dest.startsWith(staging + path.sep)) throw new SourcesRefused(`sources/${f.path} leaves the directory`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.bytes, { flag: "wx" });
    }
    fs.renameSync(staging, target);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (e instanceof SourcesRefused) throw e;
    throw new SourcesRefused(
      `the restored sources could not be written: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
