/**
 * The canonical workspace tree: what a sandboxed loop step's workspace held, as bytes whose hash
 * the replay record commits as `workspaceBefore` and `workspaceAfter`.
 *
 * A replay restores the workspace from these bytes and the file blobs they name, runs the pinned
 * binary in it, and hashes it again. So the tree has to say everything a tool inside the sandbox can
 * observe about the workspace and nothing it cannot: which names exist, which of them are
 * directories, and each file's bytes. Not mtimes, modes or owners — `file_read` and `file_write`
 * never report them, and they differ between the run and its replay by construction.
 *
 * ## The bytes
 *
 * ```text
 * lath.workspace.v1\n
 * d <path>\n                       one line per directory
 * f <sha256 hex> <size> <path>\n   one line per regular file; size in decimal bytes
 * ```
 *
 * Lines are sorted by the path's UTF-8 bytes (not by JavaScript's UTF-16 string order, which puts
 * astral characters before U+E000–U+FFFF and would disagree with a Rust or Go verifier). Paths
 * are relative to the workspace root, `/`-separated, with no leading or trailing `/`. The path is
 * the last field so a space in it needs no escaping, and names carry no control characters (the
 * name rule below), so a newline always ends a line. The root itself is not a line.
 *
 * The header is in the bytes so the empty tree is not `sha256("")`, which is also the hash of
 * every empty file a step writes: a blob store keyed by hash would otherwise hold one object that
 * is two different things. `v1` is there so a later format is a different hash, never a
 * different reading of the same one.
 *
 * Directories are lines because an empty one is observable: `file_read` on it answers with an
 * OS error, and on a name that does not exist with a different one, so a replay that dropped it
 * would diverge at that call. Every directory is listed, not only empty ones, so every name on
 * the path to a file is in the tree and `parseTreeBytes` can refuse a tree that skips one — one
 * workspace, one byte string.
 *
 * ## The name rule (Unicode and case)
 *
 * macOS (APFS, case- and normalisation-insensitive by default, preserving) and Linux (ext4,
 * byte-exact) disagree on what makes two names the same. The rule makes every tree it accepts
 * restorable on both, byte for byte, and refuses the rest:
 *
 * 1. **Each name is valid UTF-8 in NFC.** A name that is not is refused, never normalised:
 *    normalising would commit a name the binary did not write, and a restore would then write a
 *    name the step's tools never saw. Invalid UTF-8 is refused because the tree is text.
 * 2. **No two names in one directory are equal under case folding** (`toLowerCase` of the NFC
 *    form — Unicode's default mapping, never the locale's). APFS cannot hold both, so the tree
 *    could not be restored on macOS. Case is otherwise kept exactly: `Notes.md` is committed as
 *    `Notes.md`.
 * 3. **No control characters** (U+0000–U+001F, U+007F), no `.` or `..`, nothing empty, at most
 *    255 UTF-8 bytes (NAME_MAX on both).
 *
 * What the rule does not remove: a step that reads `notes.md` when the file is `Notes.md` gets
 * the file on macOS and an error on Linux. That is the filesystem, not the tree; a replay across
 * platforms then diverges at that call and says so, which is the honest outcome.
 *
 * ## What is refused
 *
 * A symlink (a restore would have to decide where it points, and following one is how a sandbox
 * reads outside itself), a special file (FIFO, socket, device), a hard link (a restore writes
 * two independent files, and a write through one name would no longer show through the other),
 * a file that changed while it was hashed, and a workspace over the cap (8 MiB of file bytes,
 * 1 000 entries). Each refusal is a `WorkspaceRefused` whose message names the path or the
 * limit, because it fails the step and the reason is what the owner reads.
 *
 * The walk runs after the sandbox's process has exited, when nothing else writes the workspace. It
 * still opens every file with `O_NOFOLLOW` and checks the open file is the one it listed, so a
 * name swapped for a symlink between the listing and the read is refused rather than followed.
 *
 * Node only: it reads the filesystem, and it lives in `runtime/`, never in `@lath/sdk/browser`.
 */
import { constants } from "fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { hex, sha256, utf8 } from "@lath/sdk";
import { SOURCES_DIR, type SourcesManifest } from "./sources";

/** The first line of the tree bytes. A new format gets a new tag, and so a new hash. */
export const WORKSPACE_TREE_TAG = "lath.workspace.v1";

/** The host's workspace cap: 8 MiB of file bytes per loop workspace. */
export const WORKSPACE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The host's workspace cap: 1 000 entries per loop workspace. A directory counts as one, because it is one line in
 * the tree and one thing a restore creates; counting files alone would leave a workspace of a
 * million empty directories under the cap.
 */
export const WORKSPACE_MAX_FILES = 1000;

/** The longest name both filesystems accept (NAME_MAX), in UTF-8 bytes. */
const MAX_NAME_BYTES = 255;

/**
 * `workspaceHash` of the empty tree: the header line and nothing else. Every loop's first step
 * starts from it (`workspaceBefore` of step 1). Pinned here and re-derived in
 * `tests/zeroclaw-workspace.ts`, so a change to the format cannot move it silently.
 */
export const EMPTY_WORKSPACE_HASH = "bf584bafaeaf31874091b1e71720610b750221cadd357bc685eef4bf07ea03b9";

export interface WorkspaceFile {
  kind: "file";
  /** Relative, `/`-separated, NFC. */
  path: string;
  /** Bytes. */
  size: number;
  /** `sha256(content)`, hex: the key the file's blob is stored under. */
  sha256: string;
}

export interface WorkspaceDir {
  kind: "dir";
  path: string;
}

export type WorkspaceEntry = WorkspaceFile | WorkspaceDir;

/** A hashed workspace. `entries` are in the tree's order. */
export interface WorkspaceTree {
  entries: WorkspaceEntry[];
  /** `treeBytes(entries)`: the blob the host stores beside the files. */
  bytes: Uint8Array;
  /** `sha256(bytes)`, hex — `workspaceBefore` / `workspaceAfter`. */
  hash: string;
  /** Sum of the sizes of the files the `maxBytes` cap counts (all of them, unless `sources` is set). */
  totalBytes: number;
  /** File and directory entries; what the `maxFiles` cap counts. */
  count: number;
  /** When the walk was given `sources` limits: what `sources/` held, counted against those instead. */
  sources?: { bytes: number; files: number; dirs: number };
}

export interface WorkspaceLimits {
  maxBytes: number;
  maxFiles: number;
}

/**
 * The walk's limits. `sources`, set only for a sandbox that has sources, moves everything under
 * `sources/` off the workspace cap and onto the posture's sources caps: the sources
 * are the owner's input, fetched once, and a large repo must not leave the steps no room to write.
 * Without it `sources/` is a directory like any other — a loop with no sources whose agent writes
 * one gets no second allowance through the name.
 */
export type WorkspaceWalkLimits = Partial<WorkspaceLimits> & { sources?: WorkspaceLimits };

export type WorkspaceRefusalReason =
  | "root"
  | "name"
  | "case"
  | "symlink"
  | "special"
  | "hardlink"
  | "changed"
  | "bytes"
  | "files"
  | "tree"
  | "sources"
  | "skills";

/**
 * A workspace the tree cannot commit. `reason` is for code; the message is for the owner, and
 * always names the path or the limit, because it is the reason the step failed.
 */
export class WorkspaceRefused extends Error {
  constructor(readonly reason: WorkspaceRefusalReason, message: string) {
    super(message);
    this.name = "WorkspaceRefused";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
// A lone surrogate is a string no UTF-8 encoder can write back, so it is not a name.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// C0 controls and DEL: a newline would end a tree line early, and none of them is portable.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Rule 1 and 3 of the name rule, for one path component. */
function checkName(name: string, where: string): void {
  const bad = (why: string) => new WorkspaceRefused("name", `the workspace name ${JSON.stringify(where)} ${why}`);
  if (name.length === 0) throw bad("has an empty component");
  if (name === "." || name === "..") throw bad(`has a "${name}" component`);
  if (name.includes("/")) throw bad("has a / inside a name");
  if (CONTROL.test(name)) throw bad("has a control character");
  if (LONE_SURROGATE.test(name)) throw bad("is not valid UTF-8");
  if (name.normalize("NFC") !== name) {
    throw bad("is not in Unicode NFC; the tree commits names as the step wrote them and refuses to normalise one");
  }
  if (utf8(name).length > MAX_NAME_BYTES) throw bad(`is longer than ${MAX_NAME_BYTES} UTF-8 bytes`);
}

/** Rule 2's key: two siblings with the same fold cannot both exist on macOS. */
function fold(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The entries in tree order, checked against every rule a tree has: each path's names, no
 * duplicates, no case-folded siblings, every parent a listed directory, well-formed hashes and
 * sizes. `treeBytes` and `parseTreeBytes` both go through it, so a tree built in code, one read
 * from disk and one parsed from a blob are held to the same rules.
 */
export function canonicalEntries(entries: readonly WorkspaceEntry[]): WorkspaceEntry[] {
  const keyed = entries.map((e) => {
    if (typeof e.path !== "string") throw new WorkspaceRefused("tree", "a workspace entry has no path");
    for (const name of e.path.split("/")) checkName(name, e.path);
    if (e.kind === "file") {
      if (!HEX64.test(e.sha256)) throw new WorkspaceRefused("tree", `the file ${e.path} has no sha256`);
      if (!Number.isSafeInteger(e.size) || e.size < 0) {
        throw new WorkspaceRefused("tree", `the file ${e.path} has a size of ${e.size}`);
      }
    } else if (e.kind !== "dir") {
      // Unreachable for a typed caller; a tree parsed from JSON or built loosely is not one.
      const path = (e as { path: string }).path;
      throw new WorkspaceRefused("tree", `the workspace entry ${path} is neither a file nor a directory`);
    }
    return { entry: e, key: utf8(e.path) };
  });
  keyed.sort((a, b) => compareBytes(a.key, b.key));

  const kinds = new Map<string, WorkspaceEntry["kind"]>();
  const folded = new Map<string, string>();
  for (const { entry } of keyed) {
    if (kinds.has(entry.path)) throw new WorkspaceRefused("tree", `the workspace lists ${entry.path} twice`);
    kinds.set(entry.path, entry.kind);
    const parent = parentOf(entry.path);
    // Sorted by bytes, a parent precedes everything under it ("a" < "a/…"), so it is already in
    // `kinds` when its children arrive, or it is missing.
    if (parent !== "" && kinds.get(parent) !== "dir") {
      throw new WorkspaceRefused(
        "tree",
        kinds.has(parent)
          ? `the workspace lists ${entry.path} under ${parent}, which is a file`
          : `the workspace lists ${entry.path} and not the directory ${parent} it is in`
      );
    }
    const key = `${parent}/${fold(baseOf(entry.path))}`;
    const other = folded.get(key);
    if (other !== undefined) {
      throw new WorkspaceRefused(
        "case",
        `the workspace holds both ${other} and ${entry.path}, which differ only in case; ` +
          "macOS cannot hold both, so the tree could not be restored there"
      );
    }
    folded.set(key, entry.path);
  }
  return keyed.map((k) => k.entry);
}

/** The tree's canonical bytes (the format in the header comment). Refuses what the rules refuse. */
export function treeBytes(entries: readonly WorkspaceEntry[]): Uint8Array {
  const lines = [WORKSPACE_TREE_TAG];
  for (const e of canonicalEntries(entries)) {
    lines.push(e.kind === "dir" ? `d ${e.path}` : `f ${e.sha256} ${e.size} ${e.path}`);
  }
  return utf8(lines.join("\n") + "\n");
}

/** `sha256(treeBytes(entries))`, hex. */
export function workspaceHash(entries: readonly WorkspaceEntry[]): string {
  return hex(sha256(treeBytes(entries)));
}

/**
 * The inverse, for a tree blob fetched from the store: what a replay restores the workspace from.
 * Strict — bytes that are not exactly what `treeBytes` would write for the entries they list are
 * refused, so one workspace has one tree blob and one hash.
 */
export function parseTreeBytes(bytes: Uint8Array): WorkspaceEntry[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkspaceRefused("tree", "the tree blob is not UTF-8");
  }
  if (!text.endsWith("\n")) throw new WorkspaceRefused("tree", "the tree blob does not end in a newline");
  const [tag, ...lines] = text.slice(0, -1).split("\n");
  if (tag !== WORKSPACE_TREE_TAG) throw new WorkspaceRefused("tree", `the tree blob is not ${WORKSPACE_TREE_TAG}`);
  const entries: WorkspaceEntry[] = lines.map((line) => {
    const dir = /^d (.+)$/.exec(line);
    if (dir) return { kind: "dir", path: dir[1] };
    const file = /^f ([0-9a-f]{64}) (0|[1-9][0-9]*) (.+)$/.exec(line);
    if (file) return { kind: "file", sha256: file[1], size: Number(file[2]), path: file[3] };
    throw new WorkspaceRefused("tree", `the tree blob has a line that is not an entry: ${JSON.stringify(line)}`);
  });
  const again = treeBytes(entries);
  if (compareBytes(again, bytes) !== 0) {
    throw new WorkspaceRefused("tree", "the tree blob is not in canonical order");
  }
  return canonicalEntries(entries);
}

function describeKind(st: { isFIFO(): boolean; isSocket(): boolean; isBlockDevice(): boolean }): string {
  return st.isFIFO() ? "a FIFO" : st.isSocket() ? "a socket" : st.isBlockDevice() ? "a block device" : "a device";
}

function capBytes(limits: WorkspaceLimits): string {
  return limits.maxBytes === WORKSPACE_MAX_BYTES ? "8 MiB" : `${limits.maxBytes} bytes`;
}

/** How `readRegular` names the file in a refusal, and the most bytes it will read. */
export interface ReadRegularOptions {
  /** Default `the workspace file`: the words before the path in every refusal's message. */
  what?: string;
  /**
   * Refuse (`bytes`) a file longer than this, and never read more than one byte past it: a file the
   * sandbox made is as large as it likes, and one it is still appending to is larger than its `fstat`.
   */
  maxBytes?: number;
}

/**
 * Opens a listed file without following a symlink and without blocking on a FIFO, checks it is
 * still a regular file with one link, and reads it. Shared by the walk, by `readWorkspaceFile` and by
 * the host's read of the runtime trace the sandbox leaves in its config directory, so the host never
 * reads a sandbox-written path through anything the tree would refuse: a symlink would hand it a host
 * file (the server keypair) to store as a blob the owner can open, and a FIFO would block the read,
 * or `readFileSync`'s whole event loop, until something wrote to it. Only the last component is
 * `O_NOFOLLOW`; a caller whose parent directories the sandbox can write checks those itself.
 */
export async function readRegular(abs: string, rel: string, opts: ReadRegularOptions = {}): Promise<Uint8Array> {
  const what = opts.what ?? "the workspace file";
  let handle;
  try {
    handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw new WorkspaceRefused("symlink", `${what} ${rel} became a symlink while it was read`);
    }
    throw new WorkspaceRefused("changed", `${what} ${rel} could not be opened: ${(e as Error).message}`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new WorkspaceRefused("changed", `${what} ${rel} is no longer a regular file`);
    if (st.nlink > 1) throw new WorkspaceRefused("hardlink", `${what} ${rel} has ${st.nlink} hard links`);
    if (opts.maxBytes === undefined) return new Uint8Array(await handle.readFile());
    if (st.size > opts.maxBytes) {
      throw new WorkspaceRefused("bytes", `${what} ${rel} is ${st.size} bytes, over the ${opts.maxBytes} it may be`);
    }
    // One byte past what `fstat` said, so a file that grew after it is refused rather than cut short.
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await handle.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > st.size) throw new WorkspaceRefused("changed", `${what} ${rel} grew while it was read`);
    return new Uint8Array(buf.subarray(0, n));
  } finally {
    await handle.close();
  }
}

/**
 * Refuses a workspace whose root holds a `skills` entry, of any type — the one name the Lath binary
 * will not start beside (patch 0005 `check_workspace`), because upstream loads `<workspace>/skills`
 * as skills and a skill can re-expose a shell or HTTP tool. The sandbox's own `file_write` can create
 * it, so a step can leave one behind, and every later step would then exit at the binary's check
 * before any model call: a session that fails in a way the loop counted as its own, step after step
 * until `maxSteps`. Refused here, the host says so before it spawns, and the caller turns it into the
 * `SandboxRefused` that stops the loop.
 *
 * Kept out of `hashWorkspace` on purpose: that walk is also the tree after a step, and a step that
 * wrote `skills` is a step that ran; its tree is committed as it is, and only the next spawn is
 * refused. Nothing is deleted or renamed either: the entry is in that committed `workspaceAfter`, and
 * the next `workspaceBefore` has to match it for the replay chain to link.
 */
export async function refuseSkillsEntry(root: string): Promise<void> {
  try {
    await lstat(join(root, "skills"));
  } catch (e) {
    // Only absence is a pass; a workspace whose root cannot be read is not one known to be clean.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw e;
  }
  throw new WorkspaceRefused(
    "skills",
    "the workspace holds a root `skills` entry, which the sandbox's binary refuses to start beside " +
      "(it would load it as skills); remove it from the loop's workspace to run another step"
  );
}

/**
 * Walks the workspace at `root` and hashes it. Refuses (with `WorkspaceRefused`) everything the
 * header comment lists, and stops walking the moment the cap is passed, so a workspace of a
 * million files costs the host a refusal rather than a million reads.
 *
 * Run after the sandbox's process has exited: the tree is a statement about the workspace between
 * two steps, and there is no such thing while a step is still writing it.
 */
export async function hashWorkspace(root: string, limits: WorkspaceWalkLimits = {}): Promise<WorkspaceTree> {
  const cap: WorkspaceLimits = {
    maxBytes: limits.maxBytes ?? WORKSPACE_MAX_BYTES,
    maxFiles: limits.maxFiles ?? WORKSPACE_MAX_FILES,
  };
  const srcCap = limits.sources;
  // What `sources/` holds when it is the sandbox's sources, counted apart from the workspace cap.
  const src = { bytes: 0, files: 0, dirs: 0 };
  let counted = 0;
  const inSources = (rel: string) => srcCap !== undefined && (rel === SOURCES_DIR || rel.startsWith(`${SOURCES_DIR}/`));
  if (!isAbsolute(root)) throw new WorkspaceRefused("root", `the workspace root ${root} is not an absolute path`);
  let top;
  try {
    top = await lstat(root);
  } catch (e) {
    throw new WorkspaceRefused("root", `the workspace root ${root} cannot be read: ${(e as Error).message}`);
  }
  // The root itself too: a root that is a symlink is a workspace somewhere the wrapper was not
  // told about. Its ancestors may be links (macOS's /var is), which is the host's layout, not
  // the sandbox's.
  if (top.isSymbolicLink()) throw new WorkspaceRefused("root", `the workspace root ${root} is a symlink`);
  if (!top.isDirectory()) throw new WorkspaceRefused("root", `the workspace root ${root} is not a directory`);

  const listed: { rel: string; abs: string; kind: "file" | "dir"; size: number }[] = [];
  let totalBytes = 0;
  const pending: string[] = [""];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (pending.length) {
    const dirRel = pending.pop()!;
    const dirAbs = dirRel ? join(root, dirRel) : root;
    // Names as bytes, so a name that is not UTF-8 is seen and refused rather than read back by
    // Node with U+FFFD in it — a name that would then not exist when the host opened it.
    const raw = await readdir(dirAbs, { encoding: "buffer" });
    for (const nameBytes of raw) {
      let name: string;
      try {
        name = decoder.decode(nameBytes);
      } catch {
        const shown = dirRel
          ? `${dirRel}/${Buffer.from(nameBytes).toString("hex")}`
          : Buffer.from(nameBytes).toString("hex");
        throw new WorkspaceRefused("name", `the workspace holds a name that is not valid UTF-8 (hex ${shown})`);
      }
      const rel = dirRel ? `${dirRel}/${name}` : name;
      checkName(name, rel);
      const abs = join(root, rel);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) throw new WorkspaceRefused("symlink", `the workspace holds a symlink at ${rel}`);
      const sourced = inSources(rel);
      if (st.isDirectory()) {
        listed.push({ rel, abs, kind: "dir", size: 0 });
        pending.push(rel);
        if (sourced) src.dirs++;
      } else if (st.isFile()) {
        if (st.nlink > 1)
          throw new WorkspaceRefused("hardlink", `the workspace file ${rel} has ${st.nlink} hard links`);
        listed.push({ rel, abs, kind: "file", size: st.size });
        if (sourced) {
          src.files++;
          src.bytes += st.size;
          if (src.bytes > srcCap!.maxBytes) {
            throw new WorkspaceRefused(
              "bytes",
              `the sandbox's ${SOURCES_DIR}/ holds more than ${srcCap!.maxBytes} bytes of files ` +
                `(${src.bytes} by ${rel}), over the sources cap its posture commits`
            );
          }
        } else {
          totalBytes += st.size;
          if (totalBytes > cap.maxBytes) {
            throw new WorkspaceRefused(
              "bytes",
              `the workspace holds more than ${capBytes(cap)} of files (${totalBytes} bytes by ${rel}), ` +
                `over the ${cap.maxBytes}-byte cap (${
                  cap.maxBytes < WORKSPACE_MAX_BYTES ? "lowered by the sandbox's posture" : "the host's default"
                })`
            );
          }
        }
      } else {
        throw new WorkspaceRefused("special", `the workspace holds ${describeKind(st)} at ${rel}`);
      }
      // Under `sources/`, files and directories are bounded apart, each by the file cap: the
      // directories are the parents of the manifest's files, so a tree with more of them than the
      // cap allows files is not one the host seeded, and the walk stops rather than go on reading.
      if (sourced && (src.files > srcCap!.maxFiles || src.dirs > srcCap!.maxFiles)) {
        throw new WorkspaceRefused(
          "files",
          `the sandbox's ${SOURCES_DIR}/ holds more than ${srcCap!.maxFiles} ` +
            `${src.files > srcCap!.maxFiles ? "files" : "directories"}, over the sources cap its posture commits`
        );
      }
      if (!sourced && ++counted > cap.maxFiles) {
        throw new WorkspaceRefused(
          "files",
          `the workspace holds more than ${cap.maxFiles} entries (files and directories), ` +
            `over the ${cap.maxFiles}-entry cap (${
              cap.maxFiles < WORKSPACE_MAX_FILES ? "lowered by the sandbox's posture" : "the host's default"
            })`
        );
      }
    }
  }

  const entries: WorkspaceEntry[] = [];
  for (const item of listed) {
    if (item.kind === "dir") {
      entries.push({ kind: "dir", path: item.rel });
      continue;
    }
    const content = await readRegular(item.abs, item.rel);
    if (content.length !== item.size) {
      throw new WorkspaceRefused(
        "changed",
        `the workspace file ${item.rel} was ${item.size} bytes when listed and ${content.length} when read`
      );
    }
    entries.push({ kind: "file", path: item.rel, size: item.size, sha256: hex(sha256(content)) });
  }

  const ordered = canonicalEntries(entries);
  const bytes = treeBytes(ordered);
  return {
    entries: ordered,
    bytes,
    hash: hex(sha256(bytes)),
    totalBytes,
    count: counted,
    ...(srcCap ? { sources: src } : {}),
  };
}

/** What moved between two trees, and which blobs that leaves the host to store. */
export interface WorkspaceChanges {
  /** Files at a path the previous tree had no file at. */
  added: WorkspaceFile[];
  /** Files at a path the previous tree had a file at, with other content. */
  modified: WorkspaceFile[];
  /** Paths (files and directories) the previous tree had and this one does not. */
  removed: string[];
  /**
   * One file per content hash the previous tree did not hold, in tree order: exactly the blobs
   * the host still has to put. A file renamed, copied or left alone is content the store already
   * has under the same hash, so it is stored once, whatever its path.
   */
  toStore: WorkspaceFile[];
}

/**
 * The difference between the previous step's tree and this one's. `previous` absent is the empty
 * tree — step 1's `workspaceBefore`. The tree blob itself is not in `toStore`: the host puts
 * `tree.bytes` on every step, since that is what `workspaceAfter` names.
 *
 * `opts.sources`, for a sandbox with sources: no file under `sources/` is ever in `toStore`. Those
 * blobs are the manifest's, stored once when the loop started; a sandbox cannot change them (the
 * wrapper makes the subtree read-only and every spawn checks it), so storing them again on every
 * step would only copy the same bytes into every step's bundle.
 */
export function workspaceChanges(
  previous: readonly WorkspaceEntry[] | undefined,
  next: readonly WorkspaceEntry[],
  opts: { sources?: boolean } = {}
): WorkspaceChanges {
  const before = new Map<string, WorkspaceEntry>();
  const held = new Set<string>();
  for (const e of previous ?? []) {
    before.set(e.path, e);
    if (e.kind === "file") held.add(e.sha256);
  }
  const now = new Set<string>();
  const out: WorkspaceChanges = { added: [], modified: [], removed: [], toStore: [] };
  for (const e of canonicalEntries(next)) {
    now.add(e.path);
    if (e.kind !== "file") continue;
    const was = before.get(e.path);
    if (!was || was.kind !== "file") out.added.push(e);
    else if (was.sha256 !== e.sha256) out.modified.push(e);
    if (opts.sources && e.path.startsWith(`${SOURCES_DIR}/`)) continue;
    if (!held.has(e.sha256)) {
      held.add(e.sha256);
      out.toStore.push(e);
    }
  }
  for (const path of before.keys()) if (!now.has(path)) out.removed.push(path);
  return out;
}

/**
 * The bytes of one file of a hashed tree, re-hashed against the entry before they are returned,
 * so the blob the host stores is the content the tree names or nothing: a file that changed
 * after `hashWorkspace` is refused with `changed`, and one swapped for a symlink with `symlink`.
 */
export async function readWorkspaceFile(root: string, entry: WorkspaceFile): Promise<Uint8Array> {
  for (const name of entry.path.split("/")) checkName(name, entry.path);
  const content = await readRegular(join(root, entry.path), entry.path);
  const got = hex(sha256(content));
  if (got !== entry.sha256) {
    throw new WorkspaceRefused("changed", `the workspace file ${entry.path} hashes to ${got}, not ${entry.sha256}`);
  }
  return content;
}

// ---------------------------------------------------------------------------------------------
// The sandbox's sources (`zeroclaw/CONTRACT.md` §5)

/**
 * The tree `<workspace>/sources` holds for a manifest, as workspace entries: each file at
 * `sources/<path>`, and every directory on the way to one, `sources` itself included. Nothing else:
 * a source whose files were all skipped has no directory, and none is ever created empty. This is
 * what seeding writes and what every spawn checks, so the two cannot disagree.
 *
 * `canonicalEntries` holds it to the tree's rules, so a manifest that lists one path twice (the same
 * repo named twice) or two names that differ only in case is refused here, before a sandbox exists.
 */
export function sourcesEntries(manifest: SourcesManifest): WorkspaceEntry[] {
  const dirs = new Set<string>([SOURCES_DIR]);
  const out: WorkspaceEntry[] = [];
  for (const source of manifest.sources) {
    for (const f of source.files) {
      const p = `${SOURCES_DIR}/${f.path}`;
      const segs = p.split("/");
      for (let i = 2; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
      out.push({ kind: "file", path: p, size: f.size, sha256: f.sha256 });
    }
  }
  for (const d of dirs) out.push({ kind: "dir", path: d });
  try {
    return canonicalEntries(out);
  } catch (e) {
    throw new WorkspaceRefused("sources", `the sources manifest cannot be laid out: ${(e as Error).message}`);
  }
}

/**
 * The workspace tree hash of a sandbox that holds only the seeded sources: `workspaceBefore` of a
 * loop's first step when it has sources, as `EMPTY_WORKSPACE_HASH` is when it has none.
 */
export function sourcesTreeHash(manifest: SourcesManifest): string {
  return workspaceHash(sourcesEntries(manifest));
}

/**
 * Copies the loop's fetched sources into a sandbox's `<workspace>/sources` when it is not there yet,
 * and returns whether it did. `from` is the host directory laid out as `sources/` will be.
 *
 * A copy, never a link: the tree refuses a file with a second hard link, and a link would let a
 * write through one name reach the other. Only the files the manifest names are copied, each
 * re-hashed against it on the way, so a fetched directory that changed or gained a file after the
 * fetch cannot seed a sandbox with bytes the posture does not commit. The copy is built beside the
 * workspace (the same filesystem, and never inside it, where a crash would leave a stray tree the
 * next step would commit) and renamed in whole: a sandbox has all of its sources or none of them.
 */
export async function seedSources(
  workspace: string,
  src: { manifest: SourcesManifest; from: string }
): Promise<boolean> {
  const target = join(workspace, SOURCES_DIR);
  try {
    await lstat(target);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WorkspaceRefused("sources", `the sandbox's ${SOURCES_DIR}/ cannot be read: ${(e as Error).message}`);
    }
  }
  const expected = sourcesEntries(src.manifest);
  const staging = `${workspace}.sources-seeding`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const e of expected) {
      const rel = e.path.slice(SOURCES_DIR.length + 1);
      if (e.kind === "dir") {
        // Tree order puts a parent before its children, so one level at a time is enough.
        if (rel) await mkdir(join(staging, rel), { mode: 0o700 });
        continue;
      }
      let content: Uint8Array;
      try {
        content = await readRegular(join(src.from, rel), rel);
      } catch (err) {
        throw new WorkspaceRefused(
          "sources",
          `the fetched source file ${rel} cannot be copied into the sandbox: ${(err as Error).message}`
        );
      }
      const got = hex(sha256(content));
      if (content.length !== e.size || got !== e.sha256) {
        throw new WorkspaceRefused(
          "sources",
          `the fetched source file ${rel} is ${content.length} bytes hashing to ${got}, not the ${e.size} bytes ` +
            `and ${e.sha256} the manifest commits`
        );
      }
      await writeFile(join(staging, rel), content, { flag: "wx", mode: 0o600 });
    }
    await rename(staging, target);
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return true;
}

/**
 * Checks `<workspace>/sources` against the manifest, file for file and directory for directory, and
 * makes it read-only on disk. A sandbox whose sources were edited, added to or removed from between
 * steps — by hand on the host, since the wrapper refuses the sandbox every write there — is refused
 * with the first path that differs, rather than run on inputs the posture does not commit.
 *
 * Read-only on disk as well as in the wrapper (`0444` files, `0555` directories, set again on every
 * spawn, so a crash between seeding and locking is repaired): the wrapper is the air gap's layer;
 * the mode is what stops the host's own tooling, or a test's unwrapped stub, writing there by
 * accident.
 */
export async function checkSources(workspace: string, manifest: SourcesManifest, caps: WorkspaceLimits): Promise<void> {
  const root = join(workspace, SOURCES_DIR);
  const expected = sourcesEntries(manifest);
  const refuse = (what: string) =>
    new WorkspaceRefused(
      "sources",
      `the sandbox's ${SOURCES_DIR}/ does not match the manifest its posture commits: ${what}; it was changed ` +
        "after the loop started, and the step is refused rather than run on inputs the chain does not name"
    );
  let actual: WorkspaceTree;
  try {
    // One entry of slack over what the manifest names (`expected` counts `sources` itself, the
    // walk does not), so a single extra file is reported by name below; more stops the walk here.
    actual = await hashWorkspace(root, { maxBytes: caps.maxBytes, maxFiles: expected.length });
  } catch (e) {
    throw refuse((e as Error).message);
  }
  const want = new Map(expected.filter((e) => e.path !== SOURCES_DIR).map((e) => [e.path, e]));
  const got = new Map(actual.entries.map((e) => [`${SOURCES_DIR}/${e.path}`, e]));
  const paths = [...new Set([...want.keys(), ...got.keys()])].sort((a, b) => compareBytes(utf8(a), utf8(b)));
  for (const p of paths) {
    const w = want.get(p);
    const g = got.get(p);
    if (!g) throw refuse(`${p} is missing`);
    if (!w) throw refuse(`${p} is not in the manifest`);
    if (w.kind !== g.kind) throw refuse(`${p} is a ${g.kind === "dir" ? "directory" : "file"}, not a ${w.kind}`);
    if (w.kind === "file" && g.kind === "file" && (w.sha256 !== g.sha256 || w.size !== g.size)) {
      throw refuse(`${p} holds ${g.size} bytes hashing to ${g.sha256}, not ${w.sha256}`);
    }
  }
  for (const e of actual.entries) await chmod(join(root, e.path), e.kind === "dir" ? 0o555 : 0o444);
  await chmod(root, 0o555);
}

/**
 * Gives the owner back write permission on a sandbox's `sources/`, so the tree can be removed: the
 * entries of a `0555` directory cannot be unlinked. For whoever retires a sandbox, and for tests.
 */
export async function unlockSources(workspace: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) await chmod(p, 0o600);
    }
  };
  try {
    await walk(join(workspace, SOURCES_DIR));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
