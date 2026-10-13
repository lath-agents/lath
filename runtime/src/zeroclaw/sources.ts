import { hex, sha256, utf8 } from "@lath/sdk";
import { canonicalJson } from "../policy";

/**
 * A loop sandbox's sources (`zeroclaw/CONTRACT.md` §5): what the host fetched once when the loop
 * started — public GitHub repos pinned to a commit, static `https://` files, Solana accounts pinned
 * to a slot, and files the owner attached inline in the start body (`text`) — laid out
 * read-only under `<workspace>/sources/` in every sandbox of the loop, and committed through the
 * posture's `sources.hash`.
 *
 * This file is the contract only: the manifest, its bytes and hash, where each source lives under
 * `sources/`, and the index block that opens a step's message. It fetches nothing and touches no
 * filesystem — the fetcher is the console's (`api/_lib/sources.ts`), the seeding and the check are
 * the sandbox's (`runtime.ts`, `workspace.ts`). Pure and free of Node built-ins, like `posture.ts`, so
 * a page can re-hash a manifest the console served and compare it with the posture it verified.
 *
 * ## The bytes
 *
 * `lath.sources.v1\n` + `canonicalJson(manifest)`. The tag is in the bytes for the reason the
 * workspace tree carries one: a later format is a different hash, never a different reading of the
 * same one. The manifest keeps its sources in the order the owner listed them — the order is what
 * the owner chose and what the index shows, so it is committed — and each source's files sorted by
 * the UTF-8 bytes of their path, which is the order a Rust or Go verifier would produce.
 *
 * A set published in clear on Irys gets a second object beside the manifest, never inside it:
 * the Irys index at the end of this file (`lath.sources.irys.v1`), which maps each hash to an Irys
 * id. The publisher and the restorer are the console's (`api/_lib/sources-irys.ts`).
 *
 * A loop with Solana sources is also told, at every step, what changed on chain since they were
 * pinned: the note at the very end of this file (`sourcesRefreshNote`). It is the step's input, not a
 * source — the re-read is the console's (`api/_lib/sources-refresh.ts`), and nothing above changes.
 */

/** The first line of the manifest bytes. */
export const SOURCES_TAG = "lath.sources.v1";

/** The subtree under the workspace root where every sandbox of the loop finds the sources. */
export const SOURCES_DIR = "sources";

/**
 * The caps. Kept apart from the workspace's own cap (8 MiB / 1 000 entries, `WORKSPACE_MAX_BYTES`),
 * which counts only what the steps write: the sources are the owner's input, not the agent's output,
 * and a repo that filled the workspace cap would leave the steps no room to write anything.
 */
/** One file. A larger one is skipped and counted, not refused: a repo's one big asset should not refuse the repo. */
export const SOURCE_FILE_MAX_BYTES = 1024 * 1024;
/** One source's kept files together. Over it, the source is refused. */
export const SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** Every source of the loop together, in bytes and in files. */
export const SOURCES_MAX_BYTES = 16 * 1024 * 1024;
export const SOURCES_MAX_FILES = 2000;
/** How many sources one loop may list. */
export const SOURCES_MAX_INPUTS = 8;

/**
 * One `text` source's content, in UTF-8 bytes. An attached file rides in the
 * start body the `"Lath loop"` signature binds, and in the template version that stores the start's
 * terms, so it is held far below a fetched file's cap: a page of invoices or a spec, not a corpus.
 */
export const TEXT_SOURCE_MAX_BYTES = 64 * 1024;
/**
 * Every `text` source of one loop together. The start body is read to 256 KiB at most
 * (`POST /api/loops`'s `MAX_BODY_BYTES`), and eight sources at the per-source cap would be twice
 * that before JSON escaped a byte; two full ones leave the rest of the body its room.
 */
export const TEXT_SOURCES_MAX_BYTES = 128 * 1024;
/** What a `text` source may say it is. Absent is `text/plain`. */
export const TEXT_SOURCE_TYPES = ["application/json", "text/plain", "text/markdown"] as const;
export type TextSourceType = (typeof TEXT_SOURCE_TYPES)[number];

/** What the owner typed on the form, before anything is fetched. */
export type SandboxSourceInput =
  /** `https://github.com/<owner>/<repo>[/tree/<ref>[/<path>]]`, public only. */
  | { kind: "github"; url: string }
  /** `https://` only; one file of `text/plain`, `application/json` or markdown. */
  | { kind: "url"; url: string }
  /** An account on devnet or mainnet; mainnet only when the host has `LATH_MAINNET_RPC`. */
  | { kind: "solana"; cluster: "devnet" | "mainnet"; address: string }
  /**
   * A file the owner attached: its content arrives in the start body, so the
   * `"Lath loop"` signature's `Request ID` binds its exact bytes, and nothing is fetched. Written as
   * one UTF-8 file named `name`; held to `textSourceProblem`.
   */
  | { kind: "text"; name: string; content: string; contentType?: TextSourceType };

/**
 * A whole source set restored from Irys: another loop's sources, named by the hash its posture
 * committed. `agent` (64 hex) resolves the Irys index through that agent's on-chain
 * `LocatorRegistry`; `index` is the index's Irys id, taken as
 * given. Either way `sourcesHash` is required and the restore is checked against it, so a raw id
 * cannot hand a loop a set other than the one the owner named.
 *
 * It is its own type, and `LoopSourceInput` the widened union, rather than a fourth member of
 * `SandboxSourceInput`: that union is what the fetcher (`api/_lib/sources.ts`) switches over, and
 * an `irys` input is not fetched, it is restored. The console's start parses onto `LoopSourceInput`
 * and routes this kind to `restoreSources`.
 */
export type IrysSourceInput = { kind: "irys"; agent?: string; sourcesHash: string; index?: string };

/** Every kind a loop's sources may list: the fetched kinds (an attached `text` one is written, not fetched) and a restored set. */
export type LoopSourceInput = SandboxSourceInput | IrysSourceInput;

/**
 * What an `irys` input resolved to: the Irys id the index was read from, how it was found, and the
 * manifest itself — **the original one**, byte for byte, re-hashed against `sourcesHash` before it
 * is returned. There is no `ResolvedSource` for this kind, because nothing about the restore is
 * written into a manifest: the loop commits the first loop's manifest, so its `sourcesHash` is
 * identical by construction, and a manifest is the same bytes whether or not a loop restored it.
 */
export interface ResolvedIrysSource {
  kind: "irys";
  /** What the owner typed, as `irysSourceLabel` spells it. */
  input: string;
  /** The agent whose locator named the index, or `null` when the index id was given. */
  agent: string | null;
  sourcesHash: string;
  /** The index's Irys id, base58 as Irys prints it. */
  index: string;
  manifest: SourcesManifest;
}

/** What an input resolved to when it was fetched: the pin that makes the bytes reproducible. */
export type ResolvedSource =
  | {
      kind: "github";
      input: string;
      owner: string;
      repo: string;
      /** The ref the URL named, or `null` for the default branch (`HEAD`). */
      ref: string | null;
      /** The subpath the URL named, or `null` for the whole repo. */
      path: string | null;
      /** 40 lowercase hex: the commit the ref resolved to at start. */
      commit: string;
    }
  | { kind: "url"; input: string; finalUrl: string; contentType: string }
  | {
      kind: "solana";
      input: string;
      cluster: "devnet" | "mainnet";
      address: string;
      /** `context.slot` of the read, u64 in decimal. */
      slot: string;
    }
  /**
   * An attached file. The content is **not** here: the file's `sha256` in the entry is its
   * commitment, as for every other kind, and a manifest that carried it would put the owner's file
   * everywhere the manifest goes. Nor is there an `input`: the name is what the owner chose, and it
   * is all the index and a page call the source. Exactly these three keys (`decodeSourcesManifest`
   * refuses any other), so a manifest cannot carry the content back in under another key.
   */
  | { kind: "text"; name: string; contentType: TextSourceType };

/** One kept file. `path` is relative to `sources/` and so begins with the entry's `dir`. */
export interface SourceFile {
  path: string;
  size: number;
  /** `sha256(content)`, hex: the key the file's blob is stored under. */
  sha256: string;
}

export interface SourceEntry {
  source: ResolvedSource;
  /** `sourceDir(source)`, relative to `sources/`. */
  dir: string;
  /** Sorted by the UTF-8 bytes of `path`. */
  files: SourceFile[];
  /**
   * Binaries and over-cap files the fetcher dropped. Absent when nothing was. `reasons` is set only
   * by a Solana source whose `decoded.json` could not be made (a decode that fails writes no file
   * and says why here), and only when it has a line, so a manifest without one has no `reasons` key.
   */
  skipped?: { files: number; bytes: number; reasons?: string[] };
}

export interface SourcesManifest {
  v: 1;
  /** In the order the owner listed the inputs. */
  sources: SourceEntry[];
}

/** A manifest or a directory name this module will not produce. The message names what. */
export class SourcesManifestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcesManifestRefused";
  }
}

// The workspace tree's name rule (`workspace.ts` `checkName`), restated here because that
// module reads the filesystem and this one must stay pure. Rules 1 and 3; rule 2 (no case-fold
// clash among siblings) is the fetcher's, which is the only one that sees siblings.
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_NAME_BYTES = 255;

/** `null` when `name` passes rules 1 and 3 of the name rule, else why it does not. */
export function sourceNameProblem(name: string): string | null {
  if (name.length === 0) return "is empty";
  if (name === "." || name === "..") return `is "${name}"`;
  if (name.includes("/")) return "has a / inside a name";
  if (CONTROL.test(name)) return "has a control character";
  if (LONE_SURROGATE.test(name)) return "is not valid UTF-8";
  if (name.normalize("NFC") !== name) return "is not in Unicode NFC";
  if (utf8(name).length > MAX_NAME_BYTES) return `is longer than ${MAX_NAME_BYTES} UTF-8 bytes`;
  return null;
}

/** `contentType` as a `text` source resolves it: absent is `text/plain`. */
export function textSourceType(contentType: TextSourceType | undefined): TextSourceType {
  return contentType ?? "text/plain";
}

/**
 * `null` when an attached file is one the start can write, else why not: a name the tree can hold
 * (rules 1 and 3 above), a type it may say it is, and content that is text — a string with no lone
 * surrogate (the body's JSON can carry one, and its UTF-8 would be a replacement character, not what
 * the owner signed), no NUL, at most `TEXT_SOURCE_MAX_BYTES` of UTF-8, and JSON when it says it is.
 * Shape only, and the same sentence for the start, _Check sources_ and a template's `PUT`.
 */
export function textSourceProblem(input: { name: unknown; content: unknown; contentType?: unknown }): string | null {
  if (typeof input.name !== "string") return "an attached file needs a name";
  const named = sourceNameProblem(input.name);
  if (named) return `the file name ${JSON.stringify(input.name)} ${named}`;
  if (input.contentType !== undefined && !(TEXT_SOURCE_TYPES as readonly unknown[]).includes(input.contentType)) {
    return `an attached file is ${TEXT_SOURCE_TYPES.join(", ")}, not ${JSON.stringify(input.contentType)}`;
  }
  if (typeof input.content !== "string") return "an attached file's content is text";
  if (LONE_SURROGATE.test(input.content)) return "the file is not valid UTF-8";
  if (input.content.includes("\u0000")) return "the file has a NUL byte, so it is not text";
  const bytes = utf8(input.content).length;
  if (bytes > TEXT_SOURCE_MAX_BYTES) {
    return `the file is ${bytes} bytes, over the ${TEXT_SOURCE_MAX_BYTES / 1024} KiB an attached file may be`;
  }
  if (input.contentType === "application/json") {
    try {
      JSON.parse(input.content);
    } catch {
      return "the file says it is application/json and does not parse as JSON";
    }
  }
  return null;
}

function checkSegment(name: string, where: string): string {
  const problem = sourceNameProblem(name);
  if (problem) throw new SourcesManifestRefused(`the source name ${JSON.stringify(where)} ${problem}`);
  return name;
}

/**
 * Where a source lives under `sources/`: `github/<owner>/<repo>`, `url/<host>/<path…>`,
 * `solana/<cluster>/<address>`, `text/<name>`. Every segment goes through the name rule and a refused one throws,
 * because a directory the tree cannot commit is a sandbox the step could not start in. A URL's path
 * keeps its segments (percent-decoded) so two files of one host do not collide; an empty path is
 * `index`, as the URL fetcher names the file.
 */
export function sourceDir(s: ResolvedSource): string {
  switch (s.kind) {
    case "github":
      return ["github", checkSegment(s.owner, s.input), checkSegment(s.repo, s.input)].join("/");
    case "solana":
      return ["solana", s.cluster, checkSegment(s.address, s.input)].join("/");
    case "text":
      // A directory of the file's own name, holding the file, as a URL's file sits: two attached
      // files never share a directory, and the layout reads like the other kinds'.
      return ["text", checkSegment(s.name, s.name)].join("/");
    case "url": {
      let u: URL;
      try {
        u = new URL(s.finalUrl);
      } catch {
        throw new SourcesManifestRefused(`the source URL ${JSON.stringify(s.finalUrl)} does not parse`);
      }
      const segs = u.pathname.split("/").filter((x) => x.length > 0);
      const names = segs.map((seg) => {
        let d: string;
        try {
          d = decodeURIComponent(seg);
        } catch {
          throw new SourcesManifestRefused(`the source URL ${JSON.stringify(s.finalUrl)} has a malformed escape`);
        }
        return checkSegment(d, s.finalUrl);
      });
      return ["url", checkSegment(u.hostname, s.finalUrl), ...(names.length ? names : ["index"])].join("/");
    }
  }
}

/** `${SOURCES_TAG}\n` + `canonicalJson(m)`: what `sourcesHash` hashes and what is stored as the manifest blob. */
export function sourcesManifestBytes(m: SourcesManifest): Uint8Array {
  return utf8(`${SOURCES_TAG}\n${canonicalJson(m)}`);
}

/** `sha256(sourcesManifestBytes(m))`, hex: the posture's `sources.hash`. */
export function sourcesHash(m: SourcesManifest): string {
  return hex(sha256(sourcesManifestBytes(m)));
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;

function isStr(x: unknown): x is string {
  return typeof x === "string";
}

function validSource(s: unknown): boolean {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  if (o.kind === "text") {
    return (
      Object.keys(o).length === 3 &&
      isStr(o.name) &&
      isStr(o.contentType) &&
      (TEXT_SOURCE_TYPES as readonly string[]).includes(o.contentType)
    );
  }
  if (!isStr(o.input)) return false;
  switch (o.kind) {
    case "github":
      return (
        isStr(o.owner) &&
        isStr(o.repo) &&
        (o.ref === null || isStr(o.ref)) &&
        (o.path === null || isStr(o.path)) &&
        isStr(o.commit) &&
        HEX40.test(o.commit)
      );
    case "url":
      return isStr(o.finalUrl) && isStr(o.contentType);
    case "solana":
      return (
        (o.cluster === "devnet" || o.cluster === "mainnet") && isStr(o.address) && isStr(o.slot) && U64.test(o.slot)
      );
    default:
      return false;
  }
}

function validEntry(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  if (!validSource(o.source) || !isStr(o.dir) || !Array.isArray(o.files)) return false;
  let dir: string;
  try {
    dir = sourceDir(o.source as ResolvedSource);
  } catch {
    return false;
  }
  if (dir !== o.dir) return false;
  let prev: Uint8Array | null = null;
  for (const f of o.files as unknown[]) {
    if (!f || typeof f !== "object") return false;
    const file = f as Record<string, unknown>;
    if (!isStr(file.path) || !isStr(file.sha256) || !HEX64.test(file.sha256)) return false;
    if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) return false;
    if (!file.path.startsWith(`${dir}/`)) return false;
    if (file.path.split("/").some((seg) => sourceNameProblem(seg) !== null)) return false;
    const b = utf8(file.path);
    if (prev && compareBytes(prev, b) >= 0) return false;
    prev = b;
  }
  if (o.skipped !== undefined) {
    const sk = o.skipped as Record<string, unknown> | null;
    if (!sk || typeof sk !== "object") return false;
    if (!Number.isSafeInteger(sk.files) || !Number.isSafeInteger(sk.bytes)) return false;
    // A page renders each reason as a line, so a manifest carrying anything else is not one.
    if (sk.reasons !== undefined && !(Array.isArray(sk.reasons) && sk.reasons.every(isStr))) return false;
  }
  return true;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * The manifest in `bytes`, or `null` when they are not one: a wrong tag or version, a malformed
 * entry, files out of order, or bytes that are not the canonical encoding of what they parse to.
 * The last check makes the reading one-to-one — a manifest has one byte string, so a page that
 * re-hashes what it decoded gets the hash the posture committed or learns that it does not.
 */
export function decodeSourcesManifest(bytes: Uint8Array): SourcesManifest | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const head = `${SOURCES_TAG}\n`;
  if (!text.startsWith(head)) return null;
  let m: unknown;
  try {
    m = JSON.parse(text.slice(head.length));
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.sources) || !o.sources.every(validEntry)) return null;
  const manifest = m as SourcesManifest;
  if (canonicalJson(manifest) !== text.slice(head.length)) return null;
  return manifest;
}

function pinOf(s: ResolvedSource): string {
  switch (s.kind) {
    case "github":
      return `commit ${s.commit}`;
    case "url":
      return `${s.finalUrl} (${s.contentType})`;
    case "solana":
      return `${s.cluster} slot ${s.slot}`;
    case "text":
      return `attached (${s.contentType})`;
  }
}

/**
 * What the index and a page call a source: what the owner typed, or an attached file's name. Every
 * kind but `text` is its `input`, so the index of a manifest without one is the bytes it always was.
 */
export function sourceLabel(s: ResolvedSource): string {
  return s.kind === "text" ? s.name : s.input;
}

/**
 * The block that opens every step message of a loop with sources, in every sandbox: one line per
 * source (what the owner typed and what it was pinned to), then one line per file in manifest
 * order, `<sha256> <size> sources/<path>`. Fixed bytes for a fixed manifest and nothing per-step in
 * it, so it is the same prefix in every step and every member's sandbox — the part of the prompt a
 * provider can cache. The files themselves are not inlined: the agent reads what it needs with
 * `file_read`, and each read is a `zc.file_read` on its chain.
 *
 * It ends with `SOURCES_INDEX_READING`, one fixed line on how to read the list. Without it, an agent
 * asked to "read what you remember and the sources index" looks for both on disk, and spends most of
 * a step's tool calls on reads that fail: not mistyped source paths, but files that do not exist
 * (`MEMORY.md`, `notes.md`, `state.json`, a `sources/README.md`, an `index.md`) and `file_read` on `.`
 * and on `sources`, which ZeroClaw answers _Is a directory_. ZeroClaw's own errors already say _No
 * such file or directory_; what the agent lacks is knowing that the list is the whole of `sources/`,
 * that nothing else is on disk but what a step wrote, and that its memory is in the message. The line
 * is the same bytes in every step, so the cacheable prefix stays one prefix, and it is no posture
 * input: `sourcesHash` hashes the manifest, never this text.
 */
export function sourcesIndex(m: SourcesManifest): string {
  const lines = [`Sources (read-only, under ${SOURCES_DIR}/; ${SOURCES_TAG}):`];
  m.sources.forEach((e, i) => {
    lines.push(`[${i + 1}] ${e.source.kind} ${sourceLabel(e.source)} -> ${pinOf(e.source)} at ${SOURCES_DIR}/${e.dir}`);
  });
  lines.push("Files:");
  for (const e of m.sources) {
    for (const f of e.files) lines.push(`${f.sha256} ${f.size} ${SOURCES_DIR}/${f.path}`);
  }
  lines.push(SOURCES_INDEX_READING);
  return `${lines.join("\n")}\n`;
}

/** The index's last line: how to read the list above it (`sourcesIndex`, and why it exists). */
export const SOURCES_INDEX_READING =
  `Read a file with file_read and its path exactly as listed above. These are all the files under ${SOURCES_DIR}/: ` +
  "there is no index file, file_read on a directory fails, and the workspace holds nothing else but what " +
  "earlier steps wrote with file_write. What you remember from an earlier step, when there is any, is in " +
  "this message under What you remember, not in a file.";

/**
 * The most bytes the index may take. It opens every step message, and the whole message goes to
 * the sandbox as one `-m` argument of at most 131 071 bytes (`MAX_ARG_STRLEN`, `runtime.ts`
 * `MAX_MESSAGE_BYTES`); the rest is left for the step text, the memory and the team's tasks. A
 * manifest over it is refused when it is checked and when it is fetched — before the wallet signs
 * and before anything is registered — because the sandbox would otherwise refuse every step after
 * its Genesis was written. Each file line is ~70 bytes plus its path, so
 * this admits roughly a thousand files at typical repo depth, below `SOURCES_MAX_FILES`.
 */
export const SOURCES_INDEX_MAX_BYTES = 96 * 1024;

/** `null` when `sourcesIndex(m)` fits `SOURCES_INDEX_MAX_BYTES`, else the sentence that refuses it. */
export function sourcesIndexProblem(m: SourcesManifest): string | null {
  const n = utf8(sourcesIndex(m)).length;
  if (n <= SOURCES_INDEX_MAX_BYTES) return null;
  const files = m.sources.reduce((k, e) => k + e.files.length, 0);
  return (
    `the sources' index is ${n} bytes for ${files} files, over the ${SOURCES_INDEX_MAX_BYTES} a step's message ` +
    `can give it; narrow a repo to a subpath (…/tree/<ref>/<path>) or list fewer sources`
  );
}

// ─── Sources on Irys ─────────────────────────────────────────────────────────

/**
 * The first line of a sources index on Irys. The index is a separate object from the manifest,
 * so the manifest's bytes — and with them `sourcesHash` and every posture that commits it — do not
 * change when a set is published: `lath.sources.irys.v1\n` + `canonicalJson(index)`.
 */
export const SOURCES_IRYS_TAG = "lath.sources.irys.v1";

/**
 * Where a published set's bytes are on Irys: the manifest's id, and each file's id keyed by its
 * `sha256` (a file two paths share is uploaded once). Every id is base58, as Irys prints it. The
 * index is trusted for nothing but finding bytes: a reader re-hashes the manifest against
 * `sourcesHash` and every file against the manifest.
 */
export interface SourcesIrysIndex {
  sourcesHash: string;
  manifest: string;
  files: Record<string, string>;
}

/** An Irys id as the receipt prints it: 32 bytes in base58. */
const IRYS_ID_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** The gateway's other spelling of the same 32 bytes: unpadded base64url. */
const IRYS_ID_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

/** `true` when `id` is spelled the way an Irys id is, in either of the gateway's spellings. Shape only. */
export function looksLikeIrysId(id: string): boolean {
  return IRYS_ID_BASE58.test(id) || IRYS_ID_BASE64URL.test(id);
}

export function sourcesIrysIndexBytes(index: SourcesIrysIndex): Uint8Array {
  return utf8(`${SOURCES_IRYS_TAG}\n${canonicalJson(index)}`);
}

/**
 * The index in `bytes`, or `null` when they are not one: a wrong tag, a malformed or extra field,
 * an id that is not base58, or bytes that are not the canonical encoding of what they parse to.
 * The last is the manifest's rule, kept for the same reason: one index has one byte string.
 */
export function decodeSourcesIrysIndex(bytes: Uint8Array): SourcesIrysIndex | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const head = `${SOURCES_IRYS_TAG}\n`;
  if (!text.startsWith(head)) return null;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(head.length));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 3) return null;
  if (!isStr(o.sourcesHash) || !HEX64.test(o.sourcesHash)) return null;
  if (!isStr(o.manifest) || !IRYS_ID_BASE58.test(o.manifest)) return null;
  if (!o.files || typeof o.files !== "object" || Array.isArray(o.files)) return null;
  for (const [sha, id] of Object.entries(o.files as Record<string, unknown>)) {
    if (!HEX64.test(sha) || !isStr(id) || !IRYS_ID_BASE58.test(id)) return null;
  }
  const index = v as SourcesIrysIndex;
  if (canonicalJson(index) !== text.slice(head.length)) return null;
  return index;
}

/**
 * The key a published set's index is anchored under in the loop agent's `LocatorRegistry`:
 * `sha256("lath.sources.irys.v1\n" ‖ sourcesHash)`, not `sourcesHash` itself. The registry is one
 * map per agent whose cells mean "the bytes that hash to this key are at this locator", written
 * first-write-wins; the manifest *is* bytes that hash to `sourcesHash`, and a blob publisher
 * (`publishBlobs`, `AnchoredTraceStore`) that anchored it would find the index's cell in its place,
 * or have taken the index's. A domain-separated key cannot collide with any blob's hash, costs the
 * same one cell, and a stranger holding the posture's `sourcesHash` derives it with no console —
 * the pattern the session bundle's key already follows (`sdk/src/bundle.ts` `bundleKey`).
 */
export function sourcesIrysKey(sourcesHashHex: string): Uint8Array {
  if (!isStr(sourcesHashHex) || !HEX64.test(sourcesHashHex)) {
    throw new SourcesManifestRefused(`${JSON.stringify(sourcesHashHex)} is not a sources hash (64 lowercase hex)`);
  }
  const h = new Uint8Array(32);
  for (let i = 0; i < 32; i++) h[i] = parseInt(sourcesHashHex.slice(i * 2, i * 2 + 2), 16);
  return sha256(utf8(`${SOURCES_IRYS_TAG}\n`), h);
}

/** How an `irys` input reads on the form and in a refusal: `irys:<agent>/<hash>` or `irys:<index>#<hash>`. */
export function irysSourceLabel(input: IrysSourceInput): string {
  return input.agent ? `irys:${input.agent}/${input.sourcesHash}` : `irys:${input.index ?? "?"}#${input.sourcesHash}`;
}

/**
 * `null` when an `irys` input is well formed, else why not: a 64-hex `sourcesHash`, and an agent
 * (64 hex) or an index id to find it by. Shape only; whether the set is there is `restoreSources`'s.
 */
export function irysSourceProblem(input: IrysSourceInput): string | null {
  if (!isStr(input.sourcesHash) || !HEX64.test(input.sourcesHash)) {
    return "a restored source set needs the sources hash its loop's sandbox page shows (64 lowercase hex)";
  }
  if (input.agent === undefined && input.index === undefined) {
    return "a restored source set needs the agent whose loop published it, or its Irys index id";
  }
  if (input.agent !== undefined && (!isStr(input.agent) || !HEX64.test(input.agent))) {
    return "the agent of a restored source set is its id, 64 lowercase hex";
  }
  if (input.index !== undefined && (!isStr(input.index) || !looksLikeIrysId(input.index))) {
    return "the index of a restored source set is an Irys id (base58, or the gateway's base64url)";
  }
  return null;
}

/**
 * `null` when a loop's list is one the start can commit, else why not. An `irys` input stands for a
 * whole manifest — the one its `sourcesHash` names — so it is the loop's only source: listed beside
 * anything else, the loop would commit a new manifest, and the point of restoring a set is that its
 * hash is the first loop's.
 */
export function loopSourcesProblem(inputs: LoopSourceInput[]): string | null {
  const restored = inputs.filter((i): i is IrysSourceInput => i.kind === "irys");
  if (restored.length === 0) return null;
  if (inputs.length > 1) {
    return "a source set restored from Irys is the loop's only source: it commits that set's manifest as it is";
  }
  return irysSourceProblem(restored[0]);
}

// ─── What changed since the sources were pinned (per step) ───────────────────

/**
 * One field of a pinned Solana source that reads differently at a step: where it is pinned
 * (`program.json upgradeAuthority`, `decoded.json data.threshold`), its pinned value, and its value
 * now, each as the note prints it (`sourceChangeValue`).
 */
export interface SourceChange {
  what: string;
  from: string;
  to: string;
}

/**
 * One Solana source of a loop's manifest, re-read before a step (_changed since pinned_). `n` is its 1-based place in the manifest — the number the sources index gives it —
 * and `pinnedSlot` the slot the manifest pinned it at. Either the slot the re-read answered at and
 * what changed (nothing, for a source that did not move), or why it could not be read.
 */
export type SourceRefresh =
  | { n: number; address: string; pinnedSlot: string; slot: string; changes: SourceChange[] }
  | { n: number; address: string; pinnedSlot: string; error: string };

/**
 * The most bytes the note may take. It rides in the step's `-m` message beside an index that may
 * take `SOURCES_INDEX_MAX_BYTES`, so it is held small: eight sources' first lines fit with room to
 * spare, and a note whose changed fields would pass it drops fields, saying how many, before it
 * drops any source.
 */
export const SOURCES_REFRESH_NOTE_MAX_BYTES = 4096;

/** The note's first line: what it is, and that `sources/` is not what it describes. */
export const SOURCES_REFRESH_HEAD =
  "Changed since pinned: the host re-read each Solana source at confirmed before this step. The files under " +
  `${SOURCES_DIR}/ stay as they were pinned when the loop started; this says what the chain holds now.`;

/** A value as the note prints it on one line, cut when long. */
function noteValue(v: string): string {
  return v.length > 160 ? `${v.slice(0, 160)}…` : v;
}

/**
 * How a pinned or re-read value is spelled in a `SourceChange`: `none` for an absent one, a plain
 * token (an address, a slot, a hash) as it is, any other string as JSON so a newline in a decoded
 * field cannot start a line of its own, and a structure as canonical JSON.
 */
export function sourceChangeValue(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return /^[\x21-\x7e]+$/.test(v) ? v : JSON.stringify(v);
  return canonicalJson(v);
}

/** The manifest's Solana sources, each with its 1-based place in the manifest. */
export function solanaSourceEntries(m: SourcesManifest): { n: number; entry: SourceEntry }[] {
  return m.sources.flatMap((entry, i) => (entry.source.kind === "solana" ? [{ n: i + 1, entry }] : []));
}

/** Every Solana source of `m` as not re-read, for `why`: what the note says when the whole read failed. */
export function sourcesRefreshUnread(m: SourcesManifest, why: string): SourceRefresh[] {
  return solanaSourceEntries(m).map(({ n, entry }) => {
    const s = entry.source as Extract<ResolvedSource, { kind: "solana" }>;
    return { n, address: s.address, pinnedSlot: s.slot, error: why };
  });
}

function renderRefresh(rows: readonly SourceRefresh[], maxChanges: number): string {
  const lines = [SOURCES_REFRESH_HEAD];
  for (const r of rows) {
    if ("error" in r) {
      lines.push(`[${r.n}] could not re-read ${r.address}: ${noteValue(r.error.replace(/\s+/g, " "))}`);
      continue;
    }
    if (r.changes.length === 0) {
      lines.push(`[${r.n}] ${r.address}: unchanged since slot ${r.pinnedSlot} (read at slot ${r.slot})`);
      continue;
    }
    lines.push(`[${r.n}] ${r.address}: changed since slot ${r.pinnedSlot} (read at slot ${r.slot})`);
    const kept = r.changes.slice(0, maxChanges);
    for (const c of kept) lines.push(`  ${c.what}: ${noteValue(c.from)} → ${noteValue(c.to)}`);
    const left = r.changes.length - kept.length;
    if (left > 0)
      lines.push(`  … ${left} more changed field${left === 1 ? "" : "s"}, left out to keep this note small`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The note a step of a loop with Solana sources reads, _changed since pinned_: one line per Solana
 * source in manifest order — `unchanged since slot N`, the fields that changed as `old → new` with
 * the slot read at, or `could not re-read <address>: <reason>` — or `undefined` when there are no
 * rows, so a loop without a Solana source is told nothing and its message is the one it always was.
 *
 * Per-step input, never a source: it goes in the step's message (`withSourcesNote` in `runtime.ts`),
 * which the replay record's `messageHash` commits, and never into `sources/`, the manifest or
 * `sourcesHash`, which stay what the start pinned. Held to `SOURCES_REFRESH_NOTE_MAX_BYTES` by
 * dropping changed fields before sources, and cut at a line only when the first lines alone would
 * not fit, which only a manifest with more Solana sources than a loop may list can reach.
 */
export function sourcesRefreshNote(rows: readonly SourceRefresh[]): string | undefined {
  if (rows.length === 0) return undefined;
  const sorted = [...rows].sort((a, b) => a.n - b.n);
  for (const max of [Infinity, 8, 4, 2, 1, 0]) {
    const text = renderRefresh(sorted, max);
    if (utf8(text).length <= SOURCES_REFRESH_NOTE_MAX_BYTES) return text;
  }
  let out = "";
  for (const line of renderRefresh(sorted, 0).split("\n")) {
    if (utf8(`${out}${line}\n`).length > SOURCES_REFRESH_NOTE_MAX_BYTES) break;
    out += `${line}\n`;
  }
  return out;
}
