/**
 * The fetcher behind a sandbox's sources: what the host reads once, when a loop starts, so an
 * air-gapped sandbox has the repo, the spec and the program it was asked about without a network of
 * its own.
 *
 * Three kinds, each pinned to something that cannot move under the loop:
 *
 * - a public GitHub repo, to the commit its ref named at start (git smart HTTP for the ref, the
 *   commit's tarball from codeload, read by the small tar reader below; no token, so a private
 *   repo fails like a missing one);
 * - a static `https://` file, to the bytes and the final URL that answered;
 * - a Solana account on devnet or mainnet, to the slot the RPC answered at: a program with
 *   its programdata's upgrade authority and what kind of key holds it, any other account decoded
 *   with its owner's on-chain Anchor IDL when the owner has one.
 *
 * And one kind that is not fetched at all: a `text` source, a file the owner attached,
 * whose content arrives in the start body the `"Lath loop"` signature binds. It is written as one
 * UTF-8 file and committed like a URL's file — its sha256 and size in the manifest, its content
 * nowhere in it — and it counts toward every cap below, with its own (`TEXT_SOURCE_MAX_BYTES` each,
 * `TEXT_SOURCES_MAX_BYTES` together) because the body it rides in is read to 256 KiB.
 *
 * What a pinned Solana source reads as at each later step is not this module's: `sources-refresh.ts`
 * re-reads it with the helpers exported here, and nothing it reads is written under `sources/`.
 *
 * `checkSources` resolves every input and counts what would be kept, keeping nothing: it is what
 * the form's _Check sources_ shows before the wallet signs, so the common refusals come before the
 * prompt. `fetchSources` does the same work and then lays the files out under `outDir` as
 * `<workspace>/sources/` will be, all or nothing: a loop never starts with part of its sources.
 *
 * Every network touch goes through `deps`, and every URL an owner typed through `safe-fetch.ts`,
 * so `tests/sandbox-sources.ts` runs every refusal on a stubbed network.
 */
import {
  SOURCE_FILE_MAX_BYTES,
  SOURCE_MAX_BYTES,
  SOURCES_MAX_BYTES,
  SOURCES_MAX_FILES,
  SOURCES_DIR,
  SOURCES_MAX_INPUTS,
  TEXT_SOURCES_MAX_BYTES,
  canonicalJson,
  errorText,
  sourceDir,
  sourceNameProblem,
  sourcesHash,
  sourcesIndexProblem,
  textSourceProblem,
  textSourceType,
  type TextSourceType,
  type ResolvedSource,
  type SandboxSourceInput,
  type SourceEntry,
  type SourceFile,
  type SourcesManifest,
} from "@lath/runtime";
import {
  irysSourceLabel,
  irysSourceProblem,
  loopSourcesProblem,
  type IrysSourceInput,
  type LoopSourceInput,
} from "@lath/runtime/zeroclaw/sources";
import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import {
  FetchRefused,
  nodeTransport,
  safeFetch,
  systemLookup,
  trustedFetch,
  type LookupFn,
  type Transport,
} from "./safe-fetch";

// ─── Deps and limits ─────────────────────────────────────────────────────────

export interface SourcesDeps {
  /** One request, no redirects followed (`safe-fetch.ts` follows them, re-checked). */
  fetch: Transport;
  lookup: LookupFn;
  /** The RPC urls, `""` when unset. Devnet is the console's `LATH_RPC_URL`, mainnet `LATH_MAINNET_RPC`. */
  rpc: { devnet: string; mainnet: string };
  /** Milliseconds; only the per-source deadline reads it. */
  now: () => number;
}

/**
 * The real network. `devnetRpc` is the console's `RPC_URL` (`runner.ts`), passed in rather than
 * imported: `runner.ts` fixes its paths from the env when it is first loaded, and a module the
 * suites load early must not be the one that loads it. `LATH_MAINNET_RPC` is read here, where it
 * is used; empty means unset, as `runner.ts`'s `env` reads every variable.
 */
export function defaultSourcesDeps(devnetRpc: string): SourcesDeps {
  return {
    fetch: nodeTransport,
    lookup: systemLookup,
    rpc: { devnet: devnetRpc, mainnet: process.env.LATH_MAINNET_RPC?.trim() ?? "" },
    now: Date.now,
  };
}

/** One request's limit. A tarball of a mid-sized repo is seconds; a minute is a server that is not answering. */
const REQUEST_TIMEOUT_MS = 60_000;
/** One source's limit, every request of it together. */
const SOURCE_TIMEOUT_MS = 120_000;
/**
 * The compressed tarball, and what it may inflate to. The kept files are capped far lower
 * (`SOURCE_MAX_BYTES`), but the whole repo has to be read to find the subpath in it, so these
 * bound what a repo costs to read, and the second one what a gzip bomb costs.
 */
const TARBALL_MAX_BYTES = 64 * 1024 * 1024;
const TAR_MAX_BYTES = 256 * 1024 * 1024;
/** The ref advertisement. A repo with a hundred thousand tags is not one a sandbox needs. */
const REFS_MAX_BYTES = 8 * 1024 * 1024;
/** An RPC answer: a program's programdata is at most 10 MiB, which is ~13.4 MiB of base64. */
const RPC_MAX_BYTES = 16 * 1024 * 1024;
/** The window the NUL test reads: git's own binary heuristic reads the first 8000 bytes. */
const TEXT_SNIFF_BYTES = 8 * 1024;

export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
/** `UpgradeableLoaderState::ProgramData`'s header: tag u32, slot u64, Option<Pubkey> (1 + 32). */
export const PROGRAMDATA_HEADER = 45;

// ─── Refusals ────────────────────────────────────────────────────────────────

/** A source the start refuses. `input` is 1-based, as the form numbers the rows; absent when the list itself is wrong. */
export class SourcesRefused extends Error {
  readonly input?: number;
  constructor(message: string, input?: number) {
    super(input === undefined ? message : `source ${input}: ${message}`);
    this.name = "SourcesRefused";
    this.input = input;
  }
}

/** A refusal inside one source, before it knows its number. */
class Refused extends Error {}

function refuse(message: string): never {
  throw new Refused(message);
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * The owner's list, held to its shape: at most `SOURCES_MAX_INPUTS`, each a known kind with its
 * fields. The start body is JSON from a browser, so nothing here is taken on trust.
 *
 * The fourth kind, `irys`, is a whole source set restored from another loop's sources on
 * Irys rather than fetched, so it is held to two more rules here, where the start, _Check sources_
 * and a template's `PUT` all meet it: its own shape (`irysSourceProblem`), and being the list's only
 * entry (`loopSourcesProblem`) — it stands for the other loop's manifest as it is, and anything
 * listed beside it would make a new one. Only the keys it names are kept, trimmed, so a start and
 * the template it mints hash what the owner typed and nothing a browser added.
 */
export function parseSourceInputs(raw: unknown): LoopSourceInput[] {
  if (!Array.isArray(raw)) throw new SourcesRefused("sources must be a list");
  if (raw.length > SOURCES_MAX_INPUTS) {
    throw new SourcesRefused(`a loop takes at most ${SOURCES_MAX_INPUTS} sources, not ${raw.length}`);
  }
  const inputs = raw.map((x, i): LoopSourceInput => {
    const n = i + 1;
    if (!x || typeof x !== "object") throw new SourcesRefused("is not a source", n);
    const o = x as Record<string, unknown>;
    if ((o.kind === "github" || o.kind === "url") && typeof o.url === "string" && o.url.trim()) {
      return { kind: o.kind, url: o.url.trim() };
    }
    if (o.kind === "solana" && (o.cluster === "devnet" || o.cluster === "mainnet") && typeof o.address === "string") {
      return { kind: "solana", cluster: o.cluster, address: o.address.trim() };
    }
    if (o.kind === "irys") {
      const text = (v: unknown) => (typeof v === "string" ? v.trim() : v);
      const input = {
        kind: "irys",
        sourcesHash: text(o.sourcesHash),
        ...(o.agent !== undefined && o.agent !== null ? { agent: text(o.agent) } : {}),
        ...(o.index !== undefined && o.index !== null ? { index: text(o.index) } : {}),
      } as IrysSourceInput;
      const problem = irysSourceProblem(input);
      if (problem) throw new SourcesRefused(problem, n);
      return input;
    }
    if (o.kind === "text") {
      // The content kept exactly as it arrived — its bytes are what the signature bound and what the
      // sandbox reads — and the name trimmed, as a URL is. The type is kept only when it was sent, so
      // a stored config says what the owner sent and no more; absent resolves to `text/plain`.
      const input = {
        kind: "text" as const,
        name: typeof o.name === "string" ? o.name.trim() : o.name,
        content: o.content,
        ...(o.contentType !== undefined ? { contentType: o.contentType } : {}),
      };
      const problem = textSourceProblem(input);
      if (problem) throw new SourcesRefused(problem, n);
      return input as Extract<SandboxSourceInput, { kind: "text" }>;
    }
    throw new SourcesRefused(
      "is not a GitHub repo, an https:// URL, a Solana address, an attached file or a source set on Irys",
      n
    );
  });
  // The attached files together, held below the body they ride in (`TEXT_SOURCES_MAX_BYTES`).
  let attached = 0;
  inputs.forEach((s, i) => {
    if (s.kind !== "text") return;
    attached += Buffer.byteLength(s.content, "utf8");
    if (attached > TEXT_SOURCES_MAX_BYTES) {
      throw new SourcesRefused(
        `the attached files together are over the ${TEXT_SOURCES_MAX_BYTES / 1024} KiB a loop's start may carry`,
        i + 1
      );
    }
  });
  // One source listed twice, refused here, before anything is fetched. Its files would land at the
  // same paths twice, which `checkTree` refuses — but only once both copies are fetched, so a list of
  // one repo eight times would read its tarball eight times on a stranger's say-so for a refusal that
  // is certain from the list. It adds no other refusal: every list without a repeat passes it.
  const first = new Map<string, number>();
  inputs.forEach((s, i) => {
    if (s.kind === "irys") return; // the list's only entry (`loopSourcesProblem`)
    // Two attached files of one name would be one path twice; refused here, before anything is written.
    const key =
      s.kind === "solana"
        ? `solana ${s.cluster} ${s.address}`
        : s.kind === "text"
        ? `text ${s.name}`
        : `${s.kind} ${s.url}`;
    const seen = first.get(key);
    if (seen !== undefined) throw new SourcesRefused(`is source ${seen} again`, i + 1);
    first.set(key, i + 1);
  });
  const problem = loopSourcesProblem(inputs);
  if (problem) throw new SourcesRefused(problem);
  return inputs;
}

/**
 * The inputs the fetcher can fetch, or a refusal naming the one it cannot: a set restored from Irys
 * is the start's to restore (`restoreSources` in `sources-irys.ts`), never this module's to fetch.
 * The start and _Check sources_ route it there before calling in; this is the guard if one did not.
 */
function fetchedInputs(inputs: LoopSourceInput[]): SandboxSourceInput[] {
  const i = inputs.findIndex((x) => x.kind === "irys");
  if (i >= 0) {
    throw new SourcesRefused(`${inputLabel(inputs[i])}: is restored from Irys, not fetched`, i + 1);
  }
  return inputs as SandboxSourceInput[];
}

// ─── What a fetch produces, before anything is written ──────────────────────

/**
 * What a source dropped. `reasons` is only ever set by a Solana source whose `decoded.json` could
 * not be made (a decode that fails writes no file and says why), and it reaches the manifest only
 * when it has a line, so every manifest that has none is byte for byte what it would be without the key.
 */
type Skipped = NonNullable<SourceEntry["skipped"]>;

interface Collected {
  source: ResolvedSource;
  dir: string;
  /** `path` relative to `sources/`, already name-checked. */
  files: { path: string; bytes: Uint8Array }[];
  skipped: Skipped;
}

/** One source's reads: the network, and the instant they must be done by. Exported for the per-step re-read. */
export interface Ctx {
  deps: SourcesDeps;
  deadline: number;
}

export function sha256Hex(b: Uint8Array): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, TEXT_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function namesProblem(rel: string): string | null {
  for (const seg of rel.split("/")) {
    const p = sourceNameProblem(seg);
    if (p) return `${JSON.stringify(seg)} ${p}`;
  }
  return null;
}

function fmtMiB(n: number): string {
  return `${n / (1024 * 1024)} MiB`;
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const HEX40 = /^[0-9a-fA-F]{40}$/;

interface GithubUrl {
  owner: string;
  repo: string;
  /** The segments after `/tree/`, percent-decoded: the ref and the path, not yet told apart. */
  tree: string[] | null;
}

/**
 * `https://github.com/<owner>/<repo>[/tree/<ref>[/<path>]]` and nothing looser: no other host, no
 * query or fragment, no `/blob/`, no port. A URL read generously is a URL that means one thing to
 * the form and another to the fetch.
 */
export function parseGithubUrl(raw: string): GithubUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    refuse(`${JSON.stringify(raw)} is not a URL`);
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port !== "" || u.username || u.password) {
    refuse("a GitHub source is https://github.com/<owner>/<repo>, optionally /tree/<ref>/<path>");
  }
  if (u.search || u.hash) refuse("a GitHub source URL takes no query or fragment");
  const segs = u.pathname.split("/").filter((s, i, all) => !(s === "" && (i === 0 || i === all.length - 1)));
  let decoded: string[];
  try {
    decoded = segs.map((s) => decodeURIComponent(s));
  } catch {
    refuse("the GitHub URL has a malformed escape");
  }
  if (decoded.length < 2 || decoded.some((s) => s === "")) {
    refuse("a GitHub source is https://github.com/<owner>/<repo>, optionally /tree/<ref>/<path>");
  }
  const owner = decoded[0];
  const repo = decoded[1].endsWith(".git") ? decoded[1].slice(0, -4) : decoded[1];
  if (!OWNER.test(owner)) refuse(`${JSON.stringify(owner)} is not a GitHub owner name`);
  if (!REPO.test(repo) || repo === "." || repo === "..") refuse(`${JSON.stringify(repo)} is not a GitHub repo name`);
  if (decoded.length === 2) return { owner, repo, tree: null };
  if (decoded[2] !== "tree" || decoded.length < 4) {
    refuse("a GitHub source names a branch, tag or commit with /tree/<ref>, not /" + decoded[2]);
  }
  return { owner, repo, tree: decoded.slice(3) };
}

/** The pkt-lines of a smart-HTTP answer, flushes dropped. */
function pktLines(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const len = parseInt(text.slice(i, i + 4), 16);
    if (!Number.isInteger(len) || !/^[0-9a-f]{4}$/i.test(text.slice(i, i + 4))) {
      refuse("GitHub's ref advertisement did not parse");
    }
    if (len === 0) {
      i += 4;
      continue;
    }
    if (len < 4 || i + len > text.length) refuse("GitHub's ref advertisement did not parse");
    out.push(text.slice(i + 4, i + len).replace(/\n$/, ""));
    i += len;
  }
  return out;
}

interface Refs {
  head: string | null;
  refs: Map<string, string>;
}

/**
 * The repo's refs over git smart HTTP (`info/refs?service=git-upload-pack`), not the REST API:
 * the API allows sixty unauthenticated calls an hour per address, and every loop start would
 * spend one. A tag's peeled line (`^{}`) is the commit, and it wins over the tag object.
 */
async function githubRefs(ctx: Ctx, owner: string, repo: string): Promise<Refs> {
  const url = `https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`;
  const res = await safeFetch(url, {
    ...fetchOpts(ctx),
    maxBytes: REFS_MAX_BYTES,
    what: "GitHub's ref advertisement",
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    refuse(`github.com/${owner}/${repo} is not a public repository (GitHub answered ${res.status})`);
  }
  if (res.status !== 200) refuse(`GitHub answered ${res.status} for github.com/${owner}/${repo}`);
  const lines = pktLines(res.bytes);
  const refs = new Map<string, string>();
  let head: string | null = null;
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const [pair] = line.split("\0");
    const m = /^([0-9a-f]{40}) (.+)$/.exec(pair);
    if (!m) continue;
    const [, sha, name] = m;
    if (/^0{40}$/.test(sha)) continue;
    if (name === "HEAD") head = sha;
    else if (name.endsWith("^{}")) refs.set(name.slice(0, -3), sha);
    else if (!refs.has(name)) refs.set(name, sha);
  }
  return { head, refs };
}

/**
 * Which leading segments of `/tree/…` are the ref: a ref may hold slashes (`release/1.0`), so the
 * longest prefix that is a branch, then a tag, wins, and what is left is the path. A 40-hex ref is
 * a commit and taken as is.
 */
async function resolveGithub(ctx: Ctx, input: string): Promise<Extract<ResolvedSource, { kind: "github" }>> {
  const { owner, repo, tree } = parseGithubUrl(input);
  let ref: string | null = null;
  let rest: string[] = [];
  let commit: string;
  if (tree && HEX40.test(tree[0])) {
    ref = tree[0];
    rest = tree.slice(1);
    commit = tree[0].toLowerCase();
  } else {
    const { head, refs } = await githubRefs(ctx, owner, repo);
    if (!tree) {
      if (!head) refuse(`github.com/${owner}/${repo} has no default branch (an empty repository?)`);
      commit = head;
    } else {
      let found: string | undefined;
      for (let i = tree.length; i >= 1 && !found; i--) {
        const name = tree.slice(0, i).join("/");
        found = refs.get(`refs/heads/${name}`) ?? refs.get(`refs/tags/${name}`);
        if (found) {
          ref = name;
          rest = tree.slice(i);
        }
      }
      if (!found) refuse(`github.com/${owner}/${repo} has no branch or tag ${JSON.stringify(tree.join("/"))}`);
      commit = found;
    }
  }
  const sub = rest.join("/");
  if (sub) {
    const problem = namesProblem(sub);
    if (problem) refuse(`the path ${JSON.stringify(sub)} is refused: ${problem}`);
  }
  return { kind: "github", input, owner, repo, ref, path: sub || null, commit };
}

// ─── The tar reader ──────────────────────────────────────────────────────────

export interface TarEntry {
  /** As the archive spells it (pax `path` over GNU long name over ustar prefix/name), trailing `/` dropped. */
  path: string;
  kind: "file" | "dir" | "other";
  /** The ustar typeflag (`0` file, `5` directory, `1` hard link, `2` symlink, …). */
  type: string;
  data: Uint8Array;
}

function cstr(b: Uint8Array, from: number, len: number): string {
  let end = from;
  while (end < from + len && b[end] !== 0) end++;
  return Buffer.from(b.subarray(from, end)).toString("utf8");
}

function octal(b: Uint8Array, from: number, len: number): number {
  // Base-256 (the high bit of the first byte), which GNU tar writes for sizes over 8 GiB.
  if (b[from] & 0x80) {
    let n = b[from] & 0x7f;
    for (let i = from + 1; i < from + len; i++) n = n * 256 + b[i];
    return n;
  }
  const s = cstr(b, from, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) refuse("the tarball has a malformed header");
  return parseInt(s, 8);
}

function paxRecords(b: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < b.length) {
    let j = i;
    while (j < b.length && b[j] !== 0x20) j++;
    const len = parseInt(Buffer.from(b.subarray(i, j)).toString("latin1"), 10);
    if (!Number.isInteger(len) || len <= 0 || i + len > b.length) break;
    const rec = Buffer.from(b.subarray(j + 1, i + len - 1)).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/** What a pax `x` header and a GNU `L` long name leave for the entry after them. */
interface TarMeta {
  paxPath?: string;
  paxSize?: number;
  longName?: string;
}

/**
 * One 512-byte header: its typeflag and the size of the data after it, or `null` for the zero block
 * that ends the archive. Shared by the reader over a whole buffer and the one over a stream, so the
 * two cannot read one archive two ways.
 */
function tarHeader(h: Uint8Array, meta: TarMeta): { type: string; size: number } | null {
  if (h.every((x) => x === 0)) return null;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  if (sum !== octal(h, 148, 8)) refuse("the tarball has a header whose checksum does not match");
  return { type: String.fromCharCode(h[156] || 0x30), size: meta.paxSize ?? octal(h, 124, 12) };
}

/** The types that describe the entry after them (`x`, `L`) or nothing a reader needs (`g`), rather than an entry of their own. */
function isTarMeta(type: string): boolean {
  return type === "x" || type === "g" || type === "L";
}

/** A meta header's data folded into `meta`. A pax `g` header is skipped, so it never has data here. */
function foldTarMeta(type: string, data: Uint8Array, meta: TarMeta): void {
  if (type === "x") {
    const rec = paxRecords(data);
    meta.paxPath = rec.get("path");
    const s = rec.get("size");
    meta.paxSize = s !== undefined && /^[0-9]+$/.test(s) ? Number(s) : undefined;
  } else if (type === "L") {
    meta.longName = cstr(data, 0, data.length);
  }
}

/** The entry a header names, with the meta state it took cleared for the next one. */
function tarEntryOf(h: Uint8Array, type: string, meta: TarMeta): Omit<TarEntry, "data"> {
  const magic = cstr(h, 257, 6);
  const prefix = magic === "ustar" ? cstr(h, 345, 155) : "";
  const name = cstr(h, 0, 100);
  const p = meta.paxPath ?? meta.longName ?? (prefix ? `${prefix}/${name}` : name);
  meta.paxPath = undefined;
  meta.paxSize = undefined;
  meta.longName = undefined;
  const kind = type === "0" || type === "7" ? "file" : type === "5" ? "dir" : "other";
  return { path: p.replace(/\/+$/, ""), kind, type };
}

/**
 * A minimal reader for what codeload serves: ustar headers, a pax `x` header's `path` and `size`
 * for the entry after it, a pax `g` header skipped, a GNU `L` long name. Regular files and
 * directories come back as such; every other type (symlinks, hard links, devices, fifos) as
 * `other`, for the caller to drop — its link target is never read, let alone followed.
 *
 * Over a whole buffer; a fetch reads a tarball with `readTarGz`, which never holds it whole.
 */
export function* readTar(buf: Uint8Array): Generator<TarEntry> {
  let off = 0;
  const meta: TarMeta = {};
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    const head = tarHeader(h, meta);
    if (!head) return;
    const start = off + 512;
    if (start + head.size > buf.length) refuse("the tarball ends inside an entry");
    const data = buf.subarray(start, start + head.size);
    off = start + Math.ceil(head.size / 512) * 512;
    if (isTarMeta(head.type)) {
      foldTarMeta(head.type, data, meta);
      continue;
    }
    yield { ...tarEntryOf(h, head.type, meta), data };
  }
}

/**
 * The most a pax `x` header or a GNU long name may hold, since the stream reader keeps its data to
 * read it. Either carries one path, which no filesystem lets past a few KiB; codeload's own are
 * under a hundred bytes.
 */
const TAR_META_MAX_BYTES = 1024 * 1024;

/**
 * A gzip stream read as it inflates, `TAR_MAX_BYTES` counted as it goes. The inflate runs on libuv's
 * threadpool a chunk at a time, so the event loop is free between chunks, and nothing is held but
 * the chunks not yet read: bytes skipped are dropped as they pass, and bytes read are copied out.
 */
class Inflating {
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private inflated = 0;
  private ended = false;
  private readonly chunksIn: AsyncIterator<Buffer>;

  constructor(stream: zlib.Gunzip) {
    this.chunksIn = stream[Symbol.asyncIterator]();
  }

  private async more(): Promise<boolean> {
    if (this.ended) return false;
    let next: IteratorResult<Buffer>;
    try {
      next = await this.chunksIn.next();
    } catch {
      // zlib's own error (a bad header, a bad block, a stream cut short): what `gunzipSync` said for
      // every one of them, as one sentence.
      refuse("the repository's tarball is not gzip");
    }
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.inflated += next.value.length;
    if (this.inflated > TAR_MAX_BYTES) refuse(`the repository's tarball inflates past ${fmtMiB(TAR_MAX_BYTES)}`);
    this.chunks.push(next.value);
    this.buffered += next.value.length;
    return true;
  }

  private drop(n: number): void {
    while (n > 0) {
      const c = this.chunks[0];
      if (c.length <= n) {
        this.chunks.shift();
        this.buffered -= c.length;
        n -= c.length;
      } else {
        this.chunks[0] = c.subarray(n);
        this.buffered -= n;
        n = 0;
      }
    }
  }

  /** The next `n` bytes, copied out of the chunks they span, or `null` when the stream ends first. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buffered < n) if (!(await this.more())) return null;
    const out = Buffer.alloc(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - at);
      c.copy(out, at, 0, k);
      at += k;
      this.drop(k);
    }
    return out;
  }

  /** The next `n` bytes dropped as they inflate, none kept; `false` when the stream ends first. */
  async skip(n: number): Promise<boolean> {
    while (n > 0) {
      if (this.buffered === 0 && !(await this.more())) return false;
      const k = Math.min(n, this.buffered);
      this.drop(k);
      n -= k;
    }
    return true;
  }
}

/** An entry as the stream reader yields it: `data` is read only when the caller's `want` asked for it. */
export interface TarStreamEntry extends Omit<TarEntry, "data"> {
  size: number;
  data: Uint8Array | null;
}

/**
 * `readTar` over a gzipped tarball, inflated as it is walked rather than first. A whole inflate
 * would keep every repo's tarball — up to `TAR_MAX_BYTES` — in memory until its walk ended, and one
 * 6-byte file kept from it as a view would keep all of it until every source was fetched; and the
 * inflate and the walk would each hold the event loop for as long as they took, every SSE stream,
 * loop timer and heartbeat with it. This one holds a chunk at a time and reads an entry's data only when
 * `want` asks for it (a file the caller will keep, at most `SOURCE_FILE_MAX_BYTES` in practice); the
 * rest is dropped as it passes. An archive reads entry for entry as `readTar` reads it.
 */
export async function* readTarGz(
  gz: Uint8Array,
  want: (entry: Omit<TarStreamEntry, "data">) => boolean
): AsyncGenerator<TarStreamEntry> {
  const stream = zlib.createGunzip();
  stream.end(Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength));
  const tar = new Inflating(stream);
  const meta: TarMeta = {};
  try {
    for (;;) {
      const h = await tar.read(512);
      if (!h) return;
      const head = tarHeader(h, meta);
      if (!head) return;
      const pad = Math.ceil(head.size / 512) * 512 - head.size;
      let data: Uint8Array | null = null;
      let entry: Omit<TarStreamEntry, "data"> | null = null;
      if (isTarMeta(head.type)) {
        if (head.type !== "g") {
          if (head.size > TAR_META_MAX_BYTES) {
            refuse(
              `the tarball has a ${head.type === "x" ? "pax" : "long-name"} header over ${fmtMiB(TAR_META_MAX_BYTES)}`
            );
          }
          data = await tar.read(head.size);
          if (!data) refuse("the tarball ends inside an entry");
        } else if (!(await tar.skip(head.size))) {
          refuse("the tarball ends inside an entry");
        }
      } else {
        entry = { ...tarEntryOf(h, head.type, meta), size: head.size };
        if (want(entry)) {
          data = await tar.read(head.size);
          if (!data) refuse("the tarball ends inside an entry");
        } else if (!(await tar.skip(head.size))) {
          refuse("the tarball ends inside an entry");
        }
      }
      // Padding cut short is the archive's end, as `readTar` reads a buffer that stops there.
      const padded = await tar.skip(pad);
      if (entry) yield { ...entry, data };
      else if (data) foldTarMeta(head.type, data, meta);
      if (!padded) return;
    }
  } finally {
    // Stopped at the end block, refused, or abandoned by the caller: the inflate stops with it.
    stream.destroy();
  }
}

/**
 * The commit's tarball, reduced to what the sandbox gets: regular files under the subpath, under the
 * per-file cap, with no NUL in their first 8 KiB, outside any `.git`. Every entry's path is held
 * to the name rule's `.`/`..`/empty test whether it is kept or not, because a `../` in an archive
 * is an archive built to escape, not a file to skip.
 *
 * Read as it inflates (`readTarGz`), so what this holds is the compressed tarball and the files it
 * keeps, each its own copy, never the inflated whole.
 */
async function fetchGithub(ctx: Ctx, input: string): Promise<Collected> {
  const source = await resolveGithub(ctx, input);
  const dir = sourceDir(source);
  const res = await safeFetch(`https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.commit}`, {
    ...fetchOpts(ctx),
    maxBytes: TARBALL_MAX_BYTES,
    what: "the repository's tarball",
  });
  if (res.status === 404) {
    refuse(`github.com/${source.owner}/${source.repo} has no public commit ${source.commit}`);
  }
  if (res.status !== 200) refuse(`codeload.github.com answered ${res.status} for commit ${source.commit}`);
  const sub = source.path;
  // Where an entry sits: codeload puts everything under one `<repo>-<sha>/` directory, so its path
  // in the repo is what follows the first segment.
  const place = (p: string) => {
    const segs = p.split("/");
    const rel = segs.slice(1).join("/");
    return { segs, rel, under: rel !== "" && (sub === null || rel === sub || rel.startsWith(`${sub}/`)) };
  };
  // Only a file this could keep is read; everything else is skipped as it inflates. A file over the
  // per-file cap is counted by its size, which is all its skip needs.
  const want = (e: { path: string; kind: TarEntry["kind"]; size: number }) => {
    const { segs, under } = place(e.path);
    return under && e.kind === "file" && !segs.slice(1).includes(".git") && e.size <= SOURCE_FILE_MAX_BYTES;
  };
  const files: Collected["files"] = [];
  const skipped = { files: 0, bytes: 0 };
  let kept = 0;
  let seenSub = sub === null;
  for await (const entry of readTarGz(res.bytes, want)) {
    const { segs, rel, under } = place(entry.path);
    for (const s of segs) {
      if (s === "" || s === "." || s === "..") {
        refuse(`the tarball has the path ${JSON.stringify(entry.path)}, which leaves the repository`);
      }
    }
    if (!under) continue;
    seenSub = true;
    if (entry.kind !== "file") continue; // directories are implied by their files; links and devices dropped
    if (segs.slice(1).includes(".git")) continue;
    if (entry.data === null || entry.data.length > SOURCE_FILE_MAX_BYTES || looksBinary(entry.data)) {
      skipped.files++;
      skipped.bytes += entry.size;
      continue;
    }
    const problem = namesProblem(rel);
    if (problem) refuse(`the file ${JSON.stringify(rel)} is refused: ${problem}`);
    kept += entry.data.length;
    if (kept > SOURCE_MAX_BYTES) refuse(`its text files are over the ${fmtMiB(SOURCE_MAX_BYTES)} per-source cap`);
    // `readTarGz` copied it out of the stream's chunks, so keeping it keeps these bytes and no more.
    files.push({ path: `${dir}/${rel}`, bytes: entry.data });
  }
  if (!seenSub)
    refuse(`github.com/${source.owner}/${source.repo} has no path ${JSON.stringify(sub)} at ${source.commit}`);
  if (files.length === 0) refuse("it has no text file under the per-file cap");
  return { source, dir, files, skipped };
}

// ─── A static URL ────────────────────────────────────────────────────────────

/**
 * Plain text, JSON and markdown: what a sandbox reads as text. A PDF needs extraction and is roadmap.
 *
 * An allowlist, not `text/*`. The type answered here is the `Content-Type` the file is served with
 * from Irys (`sourceContentType` in `sources-irys.ts`), so `text/html` — or `text/xml`, or an SVG's
 * kin — was a page the gateway would render rather than show, from any URL an owner named.
 */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
  "application/json",
]);

function textType(contentType: string | undefined): string | null {
  const essence = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return TEXT_TYPES.has(essence) ? essence : null;
}

async function fetchUrl(ctx: Ctx, input: string): Promise<Collected> {
  const res = await safeFetch(input, {
    ...fetchOpts(ctx),
    maxBytes: SOURCE_FILE_MAX_BYTES,
    what: "the file",
  }).catch((e) => {
    // The one URL source is one file, so over the per-file cap is the source refused, not skipped.
    if (e instanceof FetchRefused && /cap$/.test(e.message)) {
      refuse(`the file is over the ${fmtMiB(SOURCE_FILE_MAX_BYTES)} per-file cap`);
    }
    throw e;
  });
  if (res.status !== 200) refuse(`${res.finalUrl.host} answered ${res.status}`);
  const contentType = textType(res.headers["content-type"]);
  if (!contentType) {
    refuse(
      `${res.finalUrl.host} answered ${
        res.headers["content-type"] || "no content type"
      }, not plain text, JSON or markdown`
    );
  }
  if (looksBinary(res.bytes)) refuse("the file has a NUL byte in its first 8 KiB, so it is not text");
  const final = new URL(res.finalUrl.toString());
  final.hash = "";
  const source: ResolvedSource = { kind: "url", input, finalUrl: final.toString(), contentType };
  const dir = sourceDir(source);
  // The file is named for the URL's last segment, and `sourceDir` already ends in it (or in
  // `index`), so it sits in a directory of its own name: two URLs of one host never share a file.
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  return { source, dir, files: [{ path: `${dir}/${name}`, bytes: res.bytes }], skipped: { files: 0, bytes: 0 } };
}

// ─── An attached file ────────────────────────────────────────────────────────

/**
 * An attached file, written as it arrived: no network, no deadline, and nothing to pin but the
 * bytes, whose sha256 the manifest commits as it does a URL's. `parseSourceInputs` has already held
 * it to `textSourceProblem`. The file sits in a directory of its own name (`sourceDir`), as a URL's
 * does, so the sandbox reads it at `sources/text/<name>/<name>`.
 */
function collectText(input: Extract<SandboxSourceInput, { kind: "text" }>): Collected {
  const contentType: TextSourceType = textSourceType(input.contentType);
  const source: ResolvedSource = { kind: "text", name: input.name, contentType };
  const dir = sourceDir(source);
  const bytes = new Uint8Array(Buffer.from(input.content, "utf8"));
  return { source, dir, files: [{ path: `${dir}/${input.name}`, bytes }], skipped: { files: 0, bytes: 0 } };
}

// ─── A Solana account ────────────────────────────────────────────────────────

export interface RpcAccount {
  data: [string, string];
  executable: boolean;
  lamports: number;
  owner: string;
  space?: number;
}

/**
 * One `getAccountInfo` at `confirmed`, and the slot it answered at. `dataSlice` asks for part of the
 * data only — the per-step re-read takes a programdata's 45-byte header and not its ELF; the fetch
 * never passes it, so its request bytes are the ones they were.
 */
export async function getAccount(
  ctx: Ctx,
  rpc: string,
  address: string,
  minContextSlot?: number,
  dataSlice?: { offset: number; length: number }
): Promise<{ slot: number; value: RpcAccount | null }> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [
      address,
      {
        encoding: "base64",
        commitment: "confirmed",
        ...(minContextSlot !== undefined ? { minContextSlot } : {}),
        ...(dataSlice ? { dataSlice } : {}),
      },
    ],
  });
  const res = await trustedFetch(rpc, {
    fetch: ctx.deps.fetch,
    now: ctx.deps.now,
    deadline: ctx.deadline,
    timeoutMs: REQUEST_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(body),
    maxBytes: RPC_MAX_BYTES,
    what: `the RPC's answer for ${address}`,
  });
  if (res.status !== 200) refuse(`the RPC answered ${res.status}`);
  let json: { result?: { context?: { slot?: number }; value?: RpcAccount | null }; error?: { message?: string } };
  try {
    json = JSON.parse(Buffer.from(res.bytes).toString("utf8"));
  } catch {
    refuse("the RPC's answer is not JSON");
  }
  if (json.error) refuse(`the RPC refused getAccountInfo: ${json.error.message ?? "no message"}`);
  const slot = json.result?.context?.slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) refuse("the RPC's answer has no slot");
  const value = json.result?.value ?? null;
  if (value && (!Array.isArray(value.data) || value.data[1] !== "base64" || typeof value.owner !== "string")) {
    refuse("the RPC's answer is not a base64 account");
  }
  return { slot, value };
}

/** A file's bytes as the sandbox reads it: canonical JSON, so the same account at the same slot is the same hash. */
function jsonFile(v: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(v)}\n`);
}

/**
 * Who can upgrade a program, in the one word the demo's question turns on: `keypair` when the
 * authority is a point on the ed25519 curve, so some private key signs for it alone; `pda` when it
 * is off the curve, so no private key exists and only the program that derived it can sign — a
 * Squads vault, which signs after its threshold approves; `none` when the programdata holds no
 * authority and the program can never be upgraded again. Which program derived a `pda` is not in
 * its bytes, so that is left to the sandbox to establish from the other sources.
 */
export type AuthorityKind = "keypair" | "pda" | "none";

export function authorityKind(authority: string | null): AuthorityKind {
  if (authority === null) return "none";
  return PublicKey.isOnCurve(new PublicKey(authority).toBytes()) ? "keypair" : "pda";
}

export type IdlRead =
  | { kind: "none" }
  | { kind: "unreadable"; address: string; rawBytes: number; why: string }
  | { kind: "json"; address: string; bytes: Buffer; idl: unknown };

/**
 * A program's on-chain Anchor IDL: createWithSeed(findProgramAddress([], program), "anchor:idl",
 * program), laid out as an 8-byte discriminator, a 32-byte authority, a u32 length and a zlib
 * payload that inflates to the IDL's JSON. Read at `slot` or later, so it is the IDL of the same
 * moment as the account it describes. `none` when the program has no IDL account, which is most
 * programs and not a failure; `unreadable` when it has one that is not an IDL under the cap.
 */
export async function readAnchorIdl(ctx: Ctx, rpc: string, program: PublicKey, slot: number): Promise<IdlRead> {
  const base = PublicKey.findProgramAddressSync([], program)[0];
  const address = (await PublicKey.createWithSeed(base, "anchor:idl", program)).toBase58();
  const got = await getAccount(ctx, rpc, address, slot);
  if (!got.value) return { kind: "none" };
  const raw = Buffer.from(got.value.data[0], "base64");
  const unreadable = (why: string): IdlRead => ({ kind: "unreadable", address, rawBytes: raw.length, why });
  const len = raw.length >= 44 ? raw.readUInt32LE(40) : -1;
  if (len < 0 || 44 + len > raw.length) return unreadable("is shorter than its own length field");
  let inflated: Buffer;
  try {
    inflated = zlib.inflateSync(raw.subarray(44, 44 + len), { maxOutputLength: SOURCE_FILE_MAX_BYTES });
  } catch {
    return unreadable(`does not inflate under the ${fmtMiB(SOURCE_FILE_MAX_BYTES)} per-file cap`);
  }
  try {
    return { kind: "json", address, bytes: inflated, idl: JSON.parse(inflated.toString("utf8")) };
  } catch {
    return unreadable("does not inflate to JSON");
  }
}

// An IDL written before Anchor 0.30 (the "legacy" format, which Squads v4 still has on chain on
// both clusters) is converted to the 0.30 shape `BorshAccountsCoder` reads, for its accounts and
// types only: `publicKey` is `pubkey`, `{defined: "T"}` is `{defined: {name: "T"}}`, and each
// account's discriminator, which a legacy IDL leaves implicit, is sha256("account:<Name>")[..8] —
// what Anchor wrote before the IDL carried it. Instructions are not needed to read an account.

function legacyType(t: unknown): unknown {
  if (t === "publicKey") return "pubkey";
  if (!t || typeof t !== "object") return t;
  const o = t as Record<string, unknown>;
  if (typeof o.defined === "string") return { defined: { name: o.defined } };
  if ("option" in o) return { option: legacyType(o.option) };
  if ("coption" in o) return { coption: legacyType(o.coption) };
  if ("vec" in o) return { vec: legacyType(o.vec) };
  if (Array.isArray(o.array)) return { array: [legacyType(o.array[0]), o.array[1]] };
  // Anything else is left as it is, for the coder to refuse by name.
  return o;
}

function legacyFields(fields: unknown): unknown {
  if (!Array.isArray(fields)) return fields;
  return fields.map((f) =>
    f && typeof f === "object" && "name" in f && "type" in f
      ? { name: (f as { name: unknown }).name, type: legacyType((f as { type: unknown }).type) }
      : legacyType(f)
  );
}

function legacyTypeDef(d: unknown): unknown {
  const o = (d ?? {}) as { name?: unknown; type?: Record<string, unknown> };
  const ty = o.type ?? {};
  if (ty.kind === "struct") {
    return { name: o.name, type: { kind: "struct", ...(ty.fields ? { fields: legacyFields(ty.fields) } : {}) } };
  }
  if (ty.kind === "enum" && Array.isArray(ty.variants)) {
    const variants = ty.variants.map((v: { name?: unknown; fields?: unknown }) => ({
      name: v?.name,
      ...(v?.fields ? { fields: legacyFields(v.fields) } : {}),
    }));
    return { name: o.name, type: { kind: "enum", variants } };
  }
  if (ty.kind === "alias") return { name: o.name, type: { kind: "type", alias: legacyType(ty.value) } };
  return { name: o.name, type: ty };
}

/** The IDL as `BorshAccountsCoder` reads it, and the spec it was written to (`legacy` when it was converted). */
function accountsIdl(raw: unknown, owner: string): { idl: Idl; spec: string } {
  if (!raw || typeof raw !== "object") throw new Error("the IDL is not a JSON object");
  const o = raw as Record<string, unknown>;
  const spec = (o.metadata as { spec?: unknown } | undefined)?.spec;
  if (typeof spec === "string") return { idl: o as unknown as Idl, spec };
  const accounts = Array.isArray(o.accounts) ? (o.accounts as { name?: unknown }[]) : [];
  const types = Array.isArray(o.types) ? o.types : [];
  const idl = {
    address: owner,
    metadata: { name: String(o.name ?? ""), version: String(o.version ?? ""), spec: "legacy" },
    instructions: [],
    accounts: accounts.map((a) => ({
      name: a.name,
      discriminator: [
        ...crypto
          .createHash("sha256")
          .update(`account:${String(a.name)}`)
          .digest()
          .subarray(0, 8),
      ],
    })),
    types: [...accounts.map(legacyTypeDef), ...types.map(legacyTypeDef)],
  };
  return { idl: idl as unknown as Idl, spec: "legacy" };
}

// ─── What a decode may cost ────────────────────────────────────────
//
// The IDL is the owner program's own account, so whoever holds that program's IDL authority writes
// it, and `BorshAccountsCoder` does what it says synchronously with nothing bounding the work but the
// IDL: a `vec` of a type that encodes in zero bytes (an empty struct) loops its u32 length — up to
// 4 294 967 295 — without reading a byte, building one object each time; an array loops its declared
// length; a type that names another twice, level after level, is built 2^levels times when the coder
// is made, before a byte is read. A V8 heap OOM is not an exception the `try` in `decodeWithIdl` can
// catch: it aborts the console, from an unsigned _Check sources_, and again at every step of a loop
// that pinned such an account — and the IDL can be swapped in after the pin. So before the coder is
// made, the IDL's types are walked once (memoized, so the walk itself is linear in the IDL), mirroring
// how `IdlCoder` reads them, and the decode is refused unless what the coder builds and what this one
// decode could do on `data.length` bytes are both bounded. An honest account is nowhere near either
// bound; a refusal is a `skip` line in the manifest, like any decode that fails.

/** Layouts the coder builds plus the name comparisons its `types.find` lookups make, every account of the IDL together. */
const IDL_BUILD_MAX = 50_000;
/**
 * What one decode may do: the values it reads, times one plus the variable-length layouts they nest
 * in, since buffer-layout re-measures a variable-length value once for each enclosing one. Two
 * million is a few hundred milliseconds of decode at worst.
 */
const IDL_DECODE_MAX = 2_000_000;
/** How deeply an IDL's types may nest. No honest account comes near it; the walk recurses this deep at most. */
const IDL_TYPE_MAX_DEPTH = 32;

/**
 * Each primitive's encoded size and what reading one costs, in the walk's unit (a struct field read):
 * a u64 and wider is a `BN` that `plain` turns into decimal, and a public key is base58-encoded,
 * which measures at about thirty times a field read.
 */
const PRIMITIVES = new Map<unknown, { bytes: number; reads: number }>([
  ["bool", { bytes: 1, reads: 1 }],
  ["u8", { bytes: 1, reads: 1 }],
  ["i8", { bytes: 1, reads: 1 }],
  ["u16", { bytes: 2, reads: 1 }],
  ["i16", { bytes: 2, reads: 1 }],
  ["u32", { bytes: 4, reads: 1 }],
  ["i32", { bytes: 4, reads: 1 }],
  ["f32", { bytes: 4, reads: 1 }],
  ["u64", { bytes: 8, reads: 8 }],
  ["i64", { bytes: 8, reads: 8 }],
  ["f64", { bytes: 8, reads: 1 }],
  ["u128", { bytes: 16, reads: 12 }],
  ["i128", { bytes: 16, reads: 12 }],
  ["u256", { bytes: 32, reads: 16 }],
  ["i256", { bytes: 32, reads: 16 }],
  ["pubkey", { bytes: 32, reads: 64 }],
]);

interface TypeCost {
  /** The fewest bytes a value of the type encodes in. */
  min: number;
  /** Layouts the coder builds for one reference to the type, plus the comparisons its lookups make. */
  build: number;
  /** Values one decode of it reads that do not grow with the data... */
  fixed: number;
  /** ...and the most it reads per byte of the data, which only a `vec` adds (each element takes `min` bytes or more). */
  perByte: number;
  /** How deeply types nest in it. */
  depth: number;
  /** How many variable-length layouts nest in it, on the deepest path. */
  varDepth: number;
  /** It holds a `vec` or a non-empty array whose element encodes in zero bytes. */
  zeroElement: boolean;
}

/**
 * A type `IdlCoder` refuses when it builds it (a name it does not know, `coption`, a generic with no
 * arguments, an array length that is not a non-negative integer): the coder throws there, so nothing
 * below it is ever decoded, and it counts as one cheap value. Its `min` is 1, not 0, so it never reads
 * as a zero-size element — the coder's own error is the truer sentence for it.
 */
const REFUSED_BY_CODER: TypeCost = {
  min: 1,
  build: 1,
  fixed: 1,
  perByte: 0,
  depth: 0,
  varDepth: 0,
  zeroElement: false,
};

class IdlCostRefused extends Error {}

/** The largest of `f` over `xs`, 0 for none; a reduce, since a struct may have more fields than a spread takes arguments. */
function maxOf<T>(xs: T[], f: (x: T) => number): number {
  return xs.reduce((m, x) => Math.max(m, f(x)), 0);
}

/**
 * The walk. `types` and the first-match lookup are the coder's (`types.find((t) => t.name === name)`),
 * so the type measured is the type the coder builds; a typedef's cost is memoized by its index, which
 * holds because a generic typedef — the only kind whose cost depends on where it is named — is refused.
 */
class IdlCost {
  private readonly types: unknown[];
  private readonly firstIndex = new Map<unknown, number>();
  private readonly memo = new Map<number, TypeCost>();
  private readonly walking = new Set<number>();

  constructor(private readonly idl: Idl) {
    this.types = Array.isArray(idl.types) ? (idl.types as unknown[]) : [];
    this.types.forEach((t, i) => {
      const name = t && typeof t === "object" ? (t as { name?: unknown }).name : undefined;
      if (!this.firstIndex.has(name)) this.firstIndex.set(name, i);
    });
  }

  /** The comparisons `types.find` makes for `name`, and the index it lands on (`-1` for none). */
  private find(name: unknown): { index: number; comparisons: number } {
    const index = this.firstIndex.get(name);
    return index === undefined ? { index: -1, comparisons: this.types.length } : { index, comparisons: index + 1 };
  }

  private fields(fields: unknown, level: number): TypeCost[] {
    // `handleDefinedFields`: none is a unit, a first field with a name makes every field `{name, type}`,
    // and otherwise each field is itself the type.
    if (!Array.isArray(fields) || fields.length === 0) return [];
    const named = !!(fields[0] && typeof fields[0] === "object" && (fields[0] as { name?: unknown }).name);
    return fields.map((f) =>
      named
        ? f && typeof f === "object"
          ? this.type((f as { type?: unknown }).type, level)
          : REFUSED_BY_CODER
        : this.type(f, level)
    );
  }

  private struct(children: TypeCost[], build: number): TypeCost {
    const varDepth = maxOf(children, (c) => c.varDepth);
    return {
      min: children.reduce((s, c) => s + c.min, 0),
      build: children.reduce((s, c) => s + c.build, build),
      // Each field is decoded and then measured, so every field costs one more than its value.
      fixed: children.reduce((s, c) => s + c.fixed + 1, 1),
      perByte: maxOf(children, (c) => c.perByte),
      depth: 1 + maxOf(children, (c) => c.depth),
      varDepth: varDepth > 0 ? varDepth + 1 : 0,
      zeroElement: children.some((c) => c.zeroElement),
    };
  }

  private typeDef(index: number, level: number): TypeCost {
    const kept = this.memo.get(index);
    if (kept) {
      if (level + kept.depth > IDL_TYPE_MAX_DEPTH) {
        throw new IdlCostRefused(`nests types more than ${IDL_TYPE_MAX_DEPTH} deep`);
      }
      return kept;
    }
    if (this.walking.has(index)) throw new IdlCostRefused("has a type that contains itself");
    if (level > IDL_TYPE_MAX_DEPTH) throw new IdlCostRefused(`nests types more than ${IDL_TYPE_MAX_DEPTH} deep`);
    const def = this.types[index] as { generics?: unknown; type?: Record<string, unknown> } | null;
    if (!def || typeof def !== "object" || !def.type || typeof def.type !== "object") return REFUSED_BY_CODER;
    if (def.generics != null && !(Array.isArray(def.generics) && def.generics.length === 0)) {
      throw new IdlCostRefused("has a generic type");
    }
    this.walking.add(index);
    let cost: TypeCost;
    const ty = def.type;
    if (ty.kind === "struct") {
      cost = this.struct(this.fields(ty.fields, level + 1), 1);
    } else if (ty.kind === "enum" && Array.isArray(ty.variants)) {
      const variants = ty.variants.map((v) =>
        v && typeof v === "object"
          ? this.struct(this.fields((v as { fields?: unknown }).fields, level + 1), 1)
          : REFUSED_BY_CODER
      );
      // One u8 discriminant, then the one variant it names: a variant is a struct of its fields.
      cost = {
        min: 1 + (variants.length ? variants.reduce((m, v) => Math.min(m, v.min), Infinity) : 0),
        build: variants.reduce((s, v) => s + v.build, 2),
        fixed: 1 + maxOf(variants, (v) => v.fixed),
        perByte: maxOf(variants, (v) => v.perByte),
        depth: maxOf(variants, (v) => v.depth),
        varDepth: 1 + maxOf(variants, (v) => v.varDepth),
        zeroElement: variants.some((v) => v.zeroElement),
      };
    } else if (ty.kind === "type") {
      const alias = this.type(ty.alias, level + 1);
      cost = { ...alias, depth: alias.depth + 1 };
    } else {
      cost = REFUSED_BY_CODER;
    }
    this.walking.delete(index);
    this.memo.set(index, cost);
    return cost;
  }

  private type(t: unknown, level: number): TypeCost {
    if (level > IDL_TYPE_MAX_DEPTH) throw new IdlCostRefused(`nests types more than ${IDL_TYPE_MAX_DEPTH} deep`);
    if (typeof t === "string") {
      const p = PRIMITIVES.get(t);
      if (p) return { ...REFUSED_BY_CODER, min: p.bytes, fixed: p.reads };
      // A u32 length and that many bytes, read as one slice: one value, whatever the length.
      if (t === "bytes" || t === "string") return { ...REFUSED_BY_CODER, min: 4, varDepth: 1 };
      return REFUSED_BY_CODER;
    }
    if (!t || typeof t !== "object") return REFUSED_BY_CODER;
    const o = t as Record<string, unknown>;
    // The coder's order: option, vec, array, defined, generic.
    if ("option" in o) {
      const inner = this.type(o.option, level + 1);
      return {
        min: 1,
        build: inner.build + 2,
        fixed: inner.fixed + 1,
        perByte: inner.perByte,
        depth: inner.depth + 1,
        varDepth: inner.varDepth + 1,
        zeroElement: inner.zeroElement,
      };
    }
    if ("vec" in o) {
      const inner = this.type(o.vec, level + 1);
      return {
        min: 4,
        build: inner.build + 5,
        fixed: 1,
        // At most data/min elements, each decoded and measured; a zero-size element has no such bound.
        perByte: inner.min > 0 ? (inner.fixed + 1) / inner.min + inner.perByte : Infinity,
        depth: inner.depth + 1,
        varDepth: inner.varDepth + 1,
        zeroElement: inner.zeroElement || inner.min === 0,
      };
    }
    if ("array" in o) {
      if (!Array.isArray(o.array)) return REFUSED_BY_CODER;
      const [elem, len] = o.array as [unknown, unknown];
      if (typeof len !== "number" || !Number.isInteger(len) || len < 0) return REFUSED_BY_CODER;
      const inner = this.type(elem, level + 1);
      return {
        min: len === 0 ? 0 : inner.min * len,
        build: inner.build + 3,
        fixed: len === 0 ? 1 : 1 + len * (inner.fixed + 1),
        perByte: inner.perByte,
        depth: inner.depth + 1,
        varDepth: inner.varDepth > 0 ? inner.varDepth + 1 : 0,
        zeroElement: inner.zeroElement || (inner.min === 0 && len > 0),
      };
    }
    if ("defined" in o) {
      const defined = o.defined as { name?: unknown } | null;
      if (!defined || typeof defined !== "object") return REFUSED_BY_CODER;
      const { index, comparisons } = this.find(defined.name);
      if (index < 0) return { ...REFUSED_BY_CODER, build: comparisons };
      const def = this.typeDef(index, level + 1);
      return { ...def, build: def.build + comparisons, depth: def.depth + 1 };
    }
    return REFUSED_BY_CODER;
  }

  /**
   * What `new BorshAccountsCoder(idl)` builds: every account's typedef, found by name in `types`, in
   * order, until the first it cannot find (where it throws). A sentence when that is over the bound,
   * else `null`. Throws `IdlCostRefused` for a recursive, too-deep or generic type on the way.
   */
  buildProblem(): string | null {
    const accounts = this.idl.accounts;
    if (!Array.isArray(accounts)) return null;
    let build = 0;
    for (const acc of accounts as unknown[]) {
      const { index, comparisons } = this.find(
        acc && typeof acc === "object" ? (acc as { name?: unknown }).name : undefined
      );
      build += comparisons;
      if (index < 0) break;
      build += this.typeDef(index, 0).build;
      if (build > IDL_BUILD_MAX) break;
    }
    return build > IDL_BUILD_MAX ? `takes more than ${IDL_BUILD_MAX} layouts and lookups to build` : null;
  }

  /** What decoding `data` (`bytes` long) as the account type `name` could do: a sentence when it is unbounded or over the bound. */
  decodeProblem(name: string, bytes: number): string | null {
    const { index } = this.find(name);
    if (index < 0) return null;
    const cost = this.typeDef(index, 0);
    if (cost.zeroElement) return "has a vec or array of a type that encodes in zero bytes";
    const work = (cost.fixed + cost.perByte * bytes) * (cost.varDepth + 1);
    if (!(work <= IDL_DECODE_MAX)) {
      return `could take more than ${IDL_DECODE_MAX} reads to decode this account's ${bytes} bytes`;
    }
    return null;
  }
}

/**
 * A decoded value as text: a u64 and wider (a `BN`) as its decimal string, a public key as base58,
 * a `bytes` field as base64 (as `account.json` carries the raw data), everything else as JSON has
 * it. `canonicalJson` would otherwise walk a `BN`'s limbs and a key's internals.
 */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v !== "object") return v;
  if (BN.isBN(v)) return (v as BN).toString(10);
  if (typeof (v as { toBase58?: unknown }).toBase58 === "function") return (v as PublicKey).toBase58();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map(plain);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
}

/**
 * An account's data decoded with its owner's IDL (`rawIdl`, as the IDL account inflates, found at
 * `idlAddress`): the account type whose discriminator the data opens with, and the value as
 * `decoded.json` carries it (`plain`). A `skip` with the sentence `decoded.json`'s manifest line uses
 * when no account type matches or the coder refuses. Shared by the fetch and the per-step re-read,
 * so a field the re-read compares is spelled as the pinned file spells it.
 */
export function decodeWithIdl(
  rawIdl: unknown,
  idlAddress: string,
  owner: string,
  data: Buffer
): { kind: "decoded"; accountType: string; spec: string; value: unknown } | { kind: "skip"; why: string } {
  try {
    const { idl, spec } = accountsIdl(rawIdl, owner);
    // Measured before the coder is made, since making it is where a doubling IDL costs.
    const cost = new IdlCost(idl);
    const unbuilt = cost.buildProblem();
    if (unbuilt)
      return { kind: "skip", why: `the owner's IDL (${idlAddress}) ${unbuilt}, which this console does not build` };
    const coder = new BorshAccountsCoder(idl);
    const match = (idl.accounts ?? []).find(
      (a) =>
        a.discriminator.length > 0 &&
        data.length >= a.discriminator.length &&
        Buffer.from(a.discriminator).equals(data.subarray(0, a.discriminator.length))
    );
    if (!match) {
      return {
        kind: "skip",
        why: `no account type in the owner's IDL (${idlAddress}) has this account's discriminator`,
      };
    }
    const undecoded = cost.decodeProblem(match.name, data.length);
    if (undecoded) {
      return { kind: "skip", why: `the owner's IDL (${idlAddress}) ${undecoded}, which this console does not decode` };
    }
    return { kind: "decoded", accountType: match.name, spec, value: plain(coder.decode(match.name, data)) };
  } catch (e) {
    if (e instanceof IdlCostRefused) {
      return { kind: "skip", why: `the owner's IDL (${idlAddress}) ${e.message}, which this console does not decode` };
    }
    return {
      kind: "skip",
      why: `the owner's IDL (${idlAddress}) does not decode it: ${errorText(e)}`,
    };
  }
}

/**
 * `decoded.json` for an account whose owner has an on-chain Anchor IDL: the account type whose
 * discriminator its data opens with, decoded by Anchor's `BorshAccountsCoder` with that IDL. `null`
 * when the owner has no IDL (nothing to decode with, so nothing is written and nothing is owed); a
 * `why` when it has one and the decode fails, or decodes past the per-file cap, so the manifest can
 * say why the file a reader might expect is not there.
 */
async function decodeWithOwnerIdl(
  ctx: Ctx,
  rpc: string,
  address: string,
  owner: string,
  data: Buffer,
  slot: number
): Promise<{ kind: "file"; bytes: Uint8Array } | { kind: "skip"; why: string } | null> {
  let ownerKey: PublicKey;
  try {
    ownerKey = new PublicKey(owner);
  } catch {
    return null;
  }
  const read = await readAnchorIdl(ctx, rpc, ownerKey, slot);
  if (read.kind === "none") return null;
  if (read.kind === "unreadable") return { kind: "skip", why: `the owner's IDL account ${read.address} ${read.why}` };
  const decoded = decodeWithIdl(read.idl, read.address, owner, data);
  if (decoded.kind === "skip") return decoded;
  const { accountType, spec, value } = decoded;
  const bytes = jsonFile({ address, owner, idl: read.address, idlSpec: spec, accountType, data: value });
  if (bytes.length > SOURCE_FILE_MAX_BYTES) {
    return {
      kind: "skip",
      why: `it decodes to ${bytes.length} bytes, over the ${fmtMiB(SOURCE_FILE_MAX_BYTES)} per-file cap`,
    };
  }
  return { kind: "file", bytes };
}

async function fetchSolana(ctx: Ctx, input: Extract<SandboxSourceInput, { kind: "solana" }>): Promise<Collected> {
  const { cluster } = input;
  let key: PublicKey;
  try {
    key = new PublicKey(input.address);
  } catch {
    refuse(`${JSON.stringify(input.address)} is not a Solana address`);
  }
  const address = key.toBase58();
  if (address !== input.address) refuse(`${JSON.stringify(input.address)} is not a Solana address as written`);
  const rpc = ctx.deps.rpc[cluster];
  if (!rpc) {
    refuse(
      cluster === "mainnet"
        ? "a mainnet address needs LATH_MAINNET_RPC on this host, and it is unset"
        : "a devnet address needs LATH_RPC_URL on this host, and it is unset"
    );
  }
  const first = await getAccount(ctx, rpc, address);
  if (!first.value) refuse(`${address} has no account on ${cluster} at slot ${first.slot}`);
  const acct = first.value;
  const slot = first.slot;
  const source: ResolvedSource = {
    kind: "solana",
    input: `${cluster}:${address}`,
    cluster,
    address,
    slot: String(slot),
  };
  const dir = sourceDir(source);
  const data = Buffer.from(acct.data[0], "base64");
  const files: Collected["files"] = [];
  const skipped: Skipped = { files: 0, bytes: 0 };

  // The account's data in the file when the file stays under the per-file cap; a larger account
  // (a programdata, a big state account) says how long it is and leaves the bytes out.
  const base = { address, owner: acct.owner, lamports: acct.lamports, executable: acct.executable, space: data.length };
  let accountJson = jsonFile({ ...base, data: acct.data[0] });
  if (accountJson.length > SOURCE_FILE_MAX_BYTES) {
    accountJson = jsonFile({ ...base, data: null, dataOmitted: "over the per-file cap" });
    skipped.files++;
    skipped.bytes += data.length;
  }
  files.push({ path: `${dir}/account.json`, bytes: accountJson });

  if (acct.owner === UPGRADEABLE_LOADER && acct.executable && data.length >= 36 && data.readUInt32LE(0) === 2) {
    // Read at the first read's slot or later: the program and its programdata from one moment.
    const programData = new PublicKey(data.subarray(4, 36)).toBase58();
    const pd = await getAccount(ctx, rpc, programData, slot);
    if (!pd.value) refuse(`the program's programdata ${programData} has no account on ${cluster}`);
    const pdBytes = Buffer.from(pd.value.data[0], "base64");
    if (pdBytes.length < PROGRAMDATA_HEADER || pdBytes.readUInt32LE(0) !== 3) {
      refuse(`${programData} is not an upgradeable loader programdata account`);
    }
    const lastDeploySlot = pdBytes.readBigUInt64LE(4).toString();
    const upgradeAuthority = pdBytes[12] === 1 ? new PublicKey(pdBytes.subarray(13, 45)).toBase58() : null;
    // The hash of what the account holds after the header, trailing padding included: the ELF
    // itself is not copied (a sandbox reads source, not a binary), but its hash lets a reader compare
    // it with a verified build.
    const elf = pdBytes.subarray(PROGRAMDATA_HEADER);
    files.push({
      path: `${dir}/program.json`,
      bytes: jsonFile({
        program: address,
        programData,
        upgradeAuthority,
        authorityKind: authorityKind(upgradeAuthority),
        lastDeploySlot,
        elfSha256: sha256Hex(elf),
        elfBytes: elf.length,
      }),
    });

    // An IDL account that does not inflate to JSON under the cap is counted, not refused: the
    // program is still worth reading without it.
    const idl = await readAnchorIdl(ctx, rpc, key, slot);
    if (idl.kind === "json") files.push({ path: `${dir}/idl.json`, bytes: idl.bytes });
    else if (idl.kind === "unreadable") {
      skipped.files++;
      skipped.bytes += idl.rawBytes;
    }
  } else if (!acct.executable) {
    // Any other account is decoded with its owner's IDL, when the owner has one: a Squads multisig
    // then reads as its members and threshold rather than as base64. A program account is skipped
    // (its data is loader state, and the loader has no IDL). A decode that fails is not a refusal
    // either — `account.json` still has the bytes — but it writes no file and the manifest says why.
    const decoded = await decodeWithOwnerIdl(ctx, rpc, address, acct.owner, data, slot);
    if (decoded?.kind === "skip") {
      skipped.files++;
      skipped.bytes += data.length;
      skipped.reasons = [`${dir}/decoded.json: ${decoded.why}`];
    } else if (decoded?.kind === "file") files.push({ path: `${dir}/decoded.json`, bytes: decoded.bytes });
  }
  return { source, dir, files, skipped };
}

// ─── Collect, check, fetch ───────────────────────────────────────────────────

function fetchOpts(ctx: Ctx) {
  return {
    fetch: ctx.deps.fetch,
    lookup: ctx.deps.lookup,
    now: ctx.deps.now,
    deadline: ctx.deadline,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

function inputLabel(input: LoopSourceInput): string {
  return input.kind === "solana"
    ? `${input.cluster}:${input.address}`
    : input.kind === "irys"
    ? irysSourceLabel(input)
    : input.kind === "text"
    ? `attached ${input.name}`
    : input.url;
}

/** `name.normalize("NFC").toLowerCase()`: the key two siblings may not share on APFS. */
function fold(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * The name rule's second clause over every source together, since they share one `sources/`
 * tree: no two siblings that fold to the same name, no path that is both a file and a directory,
 * no path twice. A tree that restores differently on APFS and on ext4 is a sandbox whose replay
 * would not see the files the step saw.
 */
function checkTree(all: { input: number; path: string }[]): void {
  const kinds = new Map<string, "dir" | "file">();
  const folded = new Map<string, string>();
  for (const { input, path: p } of all) {
    const segs = p.split("/");
    for (let i = 0; i < segs.length; i++) {
      const at = segs.slice(0, i + 1).join("/");
      const kind = i === segs.length - 1 ? "file" : "dir";
      const had = kinds.get(at);
      if (had) {
        if (had !== kind || kind === "file") {
          throw new SourcesRefused(`sources/${at} would be written twice, or as a file and a directory`, input);
        }
        continue;
      }
      const parent = segs.slice(0, i).join("/");
      const key = `${parent}\u0000${fold(segs[i])}`;
      const other = folded.get(key);
      if (other !== undefined) {
        throw new SourcesRefused(
          `sources/${at} and sources/${other} differ only in case or normalisation, which one filesystem cannot hold both of`,
          input
        );
      }
      folded.set(key, at);
      kinds.set(at, kind);
    }
  }
}

/**
 * The index a step's message would open with, held to `SOURCES_INDEX_MAX_BYTES`. Checked here, on
 * the manifest the start would commit, rather than in the sandbox: a manifest the sandbox cannot put in
 * a message refuses every step after its Genesis was written, and here it refuses
 * at _Check sources_ and at the start, before the wallet signs. The refusal names the source whose
 * file lines take the most of the index, since narrowing that one is what usually brings it under.
 */
function checkIndex(manifest: SourcesManifest, inputs: SandboxSourceInput[]): void {
  const problem = sourcesIndexProblem(manifest);
  if (!problem) return;
  let largest = 0;
  let largestBytes = -1;
  manifest.sources.forEach((e, i) => {
    const bytes = e.files.reduce(
      (n, f) => n + Buffer.byteLength(`${f.sha256} ${f.size} ${SOURCES_DIR}/${f.path}\n`),
      0
    );
    if (bytes > largestBytes) {
      largest = i;
      largestBytes = bytes;
    }
  });
  const entry = manifest.sources[largest];
  const hint =
    entry.source.kind === "github"
      ? `narrow it to a subpath (${entry.source.input.replace(/\/+$/, "")}${
          entry.source.ref === null && entry.source.path === null ? "/tree/<ref>/<path>" : "/<path>"
        })`
      : "list it without the others";
  throw new SourcesRefused(
    `${inputLabel(inputs[largest])}: ${problem}. It is the largest, with ${entry.files.length} of the index's ` +
      `files; ${hint}`,
    largest + 1
  );
}

async function collect(
  raw: unknown,
  deps: SourcesDeps
): Promise<{ collected: Collected[]; manifest: SourcesManifest }> {
  const inputs = fetchedInputs(parseSourceInputs(raw));
  const out: Collected[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const ctx: Ctx = { deps, deadline: deps.now() + SOURCE_TIMEOUT_MS };
    let c: Collected;
    try {
      c =
        input.kind === "github"
          ? await fetchGithub(ctx, input.url)
          : input.kind === "url"
          ? await fetchUrl(ctx, input.url)
          : input.kind === "text"
          ? collectText(input)
          : await fetchSolana(ctx, input);
    } catch (e) {
      // Every failure names its source, whatever raised it: a refusal here, the guard's, the
      // manifest's name rule, or the network's own error.
      const why = errorText(e);
      throw new SourcesRefused(`${inputLabel(input)}: ${why}`, i + 1);
    }
    totalBytes += c.files.reduce((n, f) => n + f.bytes.length, 0);
    totalFiles += c.files.length;
    if (totalBytes > SOURCES_MAX_BYTES) {
      throw new SourcesRefused(`the sources together are over the ${fmtMiB(SOURCES_MAX_BYTES)} cap`, i + 1);
    }
    if (totalFiles > SOURCES_MAX_FILES) {
      throw new SourcesRefused(`the sources together are over the ${SOURCES_MAX_FILES}-file cap`, i + 1);
    }
    out.push(c);
  }
  checkTree(out.flatMap((c, i) => c.files.map((f) => ({ input: i + 1, path: f.path }))));
  const manifest = manifestOf(out);
  checkIndex(manifest, inputs);
  return { collected: out, manifest };
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function manifestOf(collected: Collected[]): SourcesManifest {
  const sources: SourceEntry[] = collected.map((c) => {
    const files: SourceFile[] = c.files
      .map((f) => ({ path: f.path, size: f.bytes.length, sha256: sha256Hex(f.bytes) }))
      .sort((a, b) => compareUtf8(a.path, b.path));
    return {
      source: c.source,
      dir: c.dir,
      files,
      ...(c.skipped.files > 0
        ? {
            skipped: {
              files: c.skipped.files,
              bytes: c.skipped.bytes,
              ...(c.skipped.reasons?.length ? { reasons: [...c.skipped.reasons] } : {}),
            },
          }
        : {}),
    };
  });
  return { v: 1, sources };
}

export interface CheckedSource {
  source: ResolvedSource;
  files: number;
  bytes: number;
}

/**
 * Every input resolved and counted, nothing kept: the pins (commit, final URL and type, slot)
 * and what the start would keep. It does the start's whole fetch, so a refusal the start would
 * make — a name clash, a cap, an index too large for a step's message — is made here, before the
 * wallet is asked to sign.
 */
export async function checkSources(inputs: unknown, deps: SourcesDeps): Promise<CheckedSource[]> {
  const { collected } = await collect(inputs, deps);
  return collected.map((c) => ({
    source: c.source,
    files: c.files.length,
    bytes: c.files.reduce((n, f) => n + f.bytes.length, 0),
  }));
}

/** A refusal as `POST /api/loops { action: "check-sources" }` answers it. */
export function sourcesRefusal(e: unknown): { ok: false; error: string; input?: number } {
  if (e instanceof SourcesRefused) return { ok: false, error: e.message, ...(e.input ? { input: e.input } : {}) };
  return { ok: false, error: errorText(e) };
}

/**
 * Every input fetched and laid out under `outDir` as `<workspace>/sources/` will be (each file at
 * its manifest path), with the manifest and its hash. All or nothing: the files are written to a
 * staging directory beside `outDir` and renamed into place at the end, and any failure removes the
 * staging directory and throws `SourcesRefused`. `outDir` must not exist yet (or be empty).
 */
export async function fetchSources(
  inputs: unknown,
  deps: SourcesDeps,
  outDir: string
): Promise<{ manifest: SourcesManifest; hash: string }> {
  const { collected, manifest } = await collect(inputs, deps);
  const hash = sourcesHash(manifest);
  const target = path.resolve(outDir);
  const staging = path.join(
    path.dirname(target),
    `.${path.basename(target)}.staging-${crypto.randomBytes(6).toString("hex")}`
  );
  try {
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    for (const c of collected) {
      for (const f of c.files) {
        const dest = path.resolve(staging, ...f.path.split("/"));
        // The paths were held to the name rule already; this is the belt to that brace.
        if (!dest.startsWith(staging + path.sep)) throw new SourcesRefused(`sources/${f.path} leaves the directory`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // `wx`: never over a file already there, and never through a link someone left in its place.
        fs.writeFileSync(dest, f.bytes, { flag: "wx" });
      }
    }
    fs.renameSync(staging, target);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (e instanceof SourcesRefused) throw e;
    throw new SourcesRefused(`the sources could not be written: ${errorText(e)}`);
  }
  return { manifest, hash };
}
