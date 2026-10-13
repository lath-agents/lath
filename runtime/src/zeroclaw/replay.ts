/**
 * The replay record: the one blob a sandboxed loop step commits, as the manifest's thirteenth key
 * `replayHash`, that names every input of the step except the model's replies.
 *
 * A sandboxed step is a function of its binary, its posture, its environment, its message, the
 * workspace it started in, the replies the model gave and the results the host tools gave. The
 * `llm.*` and tool Actions already commit the last two; this record commits the rest, so a verifier
 * can re-run the step against a replay provider and check it arrives at the same requests, the same
 * tool calls, the same workspace and the same final text. What that shows is that the step followed
 * from its replies — _replayed_, never _verified correct_.
 *
 * ```text
 * replayHash = sha256(canonicalJson({
 *   v: 1,
 *   binarySha256,      // the Lath-patched zeroclaw that ran (the posture commits it too)
 *   postureHash,       // sha256 of the posture JSON the TOML was rendered from
 *   messageHash,       // sha256 of the UTF-8 bytes passed to `-m`, stored as their own blob
 *   workspacePath,     // the workspace's absolute path as the binary saw it (/lath/work under bwrap)
 *   tz, locale,        // TZ and the config's `locale`, which the system prompt carries
 *   now,               // ZEROCLAW_NOW: the step's own start instant
 *   workspaceBefore,   // the previous step's workspaceAfter; on step 1 EMPTY_WORKSPACE_HASH, or
 *                      // the seeded sources' tree (`sourcesTreeHash`) in a loop with sources
 *   workspaceAfter,    // `hashWorkspace` after the sandbox exited
 *   seqs,              // the step's llm.* and tool Action seqs, in order, as decimal strings
 *   contextWindow?,    // the config's `context_window`, only when the step's TOML carried one
 * }))
 * ```
 *
 * Canonical JSON is `canonicalJson` from `policy.ts`, the encoding every other hashed JSON object
 * in the runtime uses: keys sorted, no whitespace, so the record's bytes follow from its values
 * and nothing else. `v` is in the bytes so a replayer can refuse a record it does not know how
 * to read rather than misread one; a record with another key set is another version.
 *
 * `contextWindow` is the one optional key, and it is additive within `v: 1` rather than a `v: 2`:
 * the window is a per-step input of the rendered config (`context-window.ts`), and a replayer that
 * rebuilt the config without it would run the binary at upstream's 32k fallback and could refuse
 * a turn the run took. It is present exactly when the step's TOML carried `context_window`, and
 * absent — the key left out, not `null` — a record has exactly the eleven keys of one without a
 * window, so every record written without it keeps its `replayHash` and every pinned vector holds.
 * A reader that does not know the key refuses a record carrying it, as it refuses any key set it does
 * not know, which is the failure `v` exists for: refusing, never misreading a record as one without a
 * window.
 *
 * `now` is the step's start and not the manifest's `startedAt`, which is the loop's creation time
 * and the same on every step — pinning the clock to it would tell the model on step 40 that it is
 * still the day the loop was born. It is whole seconds in UTC, the one form `zeroclawNow`
 * writes, because the binary renders no finer than seconds and a record that allowed two
 * spellings of one instant would allow two hashes of one step.
 *
 * Node only by where it lives, though nothing here touches the filesystem: the record is written
 * by the host that spawned the sandbox, and read back by `lath-audit replay` on a verifier's machine,
 * never in the browser.
 */
import { EventKind, hex, sha256, utf8, type EpochCommit, type LogResult } from "@lath/sdk";
import { canonicalJson } from "../policy";

/** The record's version, in its bytes. */
export const REPLAY_RECORD_VERSION = 1;

export interface ReplayRecord {
  v: typeof REPLAY_RECORD_VERSION;
  /** `sha256` of the binary that ran, hex. */
  binarySha256: string;
  /** `sha256` of the posture JSON, hex. */
  postureHash: string;
  /** `sha256(replayMessageBytes(message))`, hex. */
  messageHash: string;
  /** Absolute POSIX path, no trailing `/`: what the system prompt names as the workspace. */
  workspacePath: string;
  /** The `TZ` the sandbox was spawned with (`UTC`). */
  tz: string;
  /** The config's `locale` (`en`). */
  locale: string;
  /** `ZEROCLAW_NOW` exactly as passed: `YYYY-MM-DDTHH:MM:SSZ`. */
  now: string;
  /**
   * `workspaceHash` before the step: the previous step's `workspaceAfter`, or, on a sandbox's first
   * step, the empty tree — or the tree of its seeded `sources/` when the loop has sources.
   */
  workspaceBefore: string;
  /** `workspaceHash` after the sandbox exited. */
  workspaceAfter: string;
  /** The step's `llm.*` and tool Action seqs, ascending, as decimal strings (a seq is a u64). */
  seqs: string[];
  /**
   * The `context_window` the step's config was rendered with, in tokens: a positive safe integer,
   * present only when the TOML carried the key. Absent means the sandbox ran at upstream's fallback.
   */
  contextWindow?: number;
}

/** What a caller supplies; `v` is the module's and `seqs` may be bigints. */
export type ReplayRecordInput = Omit<ReplayRecord, "v" | "seqs"> & { seqs: readonly (bigint | string)[] };

const HEX64 = /^[0-9a-f]{64}$/;
const NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

/**
 * The instant to hand the sandbox as `ZEROCLAW_NOW` for a step that started at `ms`, in the one form
 * the record accepts: UTC, whole seconds, `Z`. Floored, not rounded, so the sandbox is never told a
 * time after the step's own start.
 */
export function zeroclawNow(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error(`zeroclawNow: ${ms} is not an instant`);
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/** The bytes `messageHash` is over, and the blob stored under it: what `-m` was given, as UTF-8. */
export function replayMessageBytes(message: string): Uint8Array {
  return utf8(message);
}

/** `sha256(replayMessageBytes(message))`, hex. */
export function replayMessageHash(message: string): string {
  return hex(sha256(replayMessageBytes(message)));
}

/** Every rule the record is held to, or the first one it breaks. */
function problemWith(r: ReplayRecord): string | null {
  if (r.v !== REPLAY_RECORD_VERSION) return `version ${JSON.stringify(r.v)} is not ${REPLAY_RECORD_VERSION}`;
  for (const key of ["binarySha256", "postureHash", "messageHash", "workspaceBefore", "workspaceAfter"] as const) {
    if (typeof r[key] !== "string" || !HEX64.test(r[key])) return `${key} is not 64 lowercase hex`;
  }
  const path = r.workspacePath;
  if (typeof path !== "string" || !path.startsWith("/")) return "workspacePath is not an absolute path";
  // One spelling per path, since the system prompt carries it byte for byte: no trailing slash,
  // no empty, `.` or `..` component, and nothing a newline could split.
  if (path !== "/" && path.endsWith("/")) return "workspacePath ends in /";
  if (
    path !== "/" &&
    path
      .slice(1)
      .split("/")
      .some((c) => c === "" || c === "." || c === "..")
  ) {
    return "workspacePath is not a normalised path";
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return "workspacePath has a control character";
  for (const key of ["tz", "locale"] as const) {
    if (typeof r[key] !== "string" || r[key].length === 0) return `${key} is empty`;
  }
  // The pattern, and a real instant that prints back the same: `2026-02-30T…` matches the shape
  // and is not a time the binary would render as written.
  const at = typeof r.now === "string" && NOW.test(r.now) ? Date.parse(r.now) : NaN;
  if (!Number.isFinite(at) || zeroclawNow(at) !== r.now) return "now is not a whole-second UTC RFC 3339 instant";
  if (!Array.isArray(r.seqs)) return "seqs is not a list";
  let last = -1n;
  for (const s of r.seqs) {
    if (typeof s !== "string" || !DECIMAL.test(s)) return `seq ${JSON.stringify(s)} is not a decimal string`;
    const n = BigInt(s);
    if (n > U64_MAX) return `seq ${s} is not a u64`;
    // Ascending and distinct: the calls of one step on one chain, in the order they were written.
    if (n <= last) return `seqs are not ascending at ${s}`;
    last = n;
  }
  // The binary's own rule for the key (patch 0005): a window it would refuse is not one a step ran with.
  const w = r.contextWindow;
  if (w !== undefined && !(typeof w === "number" && Number.isSafeInteger(w) && w > 0)) {
    return `contextWindow ${JSON.stringify(w)} is not a positive integer`;
  }
  return null;
}

/** The record from its fields, checked. Throws, naming the field, on anything the bytes would not hold. */
export function replayRecord(input: ReplayRecordInput): ReplayRecord {
  const record: ReplayRecord = {
    v: REPLAY_RECORD_VERSION,
    binarySha256: input.binarySha256,
    postureHash: input.postureHash,
    messageHash: input.messageHash,
    workspacePath: input.workspacePath,
    tz: input.tz,
    locale: input.locale,
    now: input.now,
    workspaceBefore: input.workspaceBefore,
    workspaceAfter: input.workspaceAfter,
    seqs: input.seqs.map((s) => (typeof s === "bigint" ? s.toString() : s)),
    // Left off, not set to `undefined`, when unknown: the record then deep-equals its own decode.
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  };
  const problem = problemWith(record);
  if (problem) throw new Error(`the replay record is not writable: ${problem}`);
  return record;
}

/** The record's canonical bytes: the blob stored under `replayHash`. */
export function replayRecordBytes(record: ReplayRecord): Uint8Array {
  const problem = problemWith(record);
  if (problem) throw new Error(`the replay record is not writable: ${problem}`);
  return utf8(canonicalJson(record));
}

/** `sha256(replayRecordBytes(record))`, hex — the manifest's `replayHash`. */
export function replayHash(record: ReplayRecord): string {
  return hex(sha256(replayRecordBytes(record)));
}

/**
 * The inverse, for a blob fetched under a manifest's `replayHash`. `null` for anything that is
 * not a record, and for a record that is not in canonical form — bytes that re-encode to other
 * bytes would hash to another `replayHash`, and so are not the record the manifest names.
 */
export function decodeReplayRecord(bytes: Uint8Array): ReplayRecord | null {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    // The eleven keys every record has, and `contextWindow` when the step's config carried one.
    const expected = [
      "binarySha256",
      ...(Object.prototype.hasOwnProperty.call(parsed, "contextWindow") ? ["contextWindow"] : []),
      "locale",
      "messageHash",
      "now",
      "postureHash",
      "seqs",
      "tz",
      "v",
      "workspaceAfter",
      "workspaceBefore",
      "workspacePath",
    ];
    if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) return null;
    const record = parsed as ReplayRecord;
    if (problemWith(record)) return null;
    const again = replayRecordBytes(record);
    if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * The seqs a session's Actions took, ascending: the records it wrote on its own and the entries
 * of the epochs it committed (an epoch's input _i_ is at `startSeq + i`). Genesis, Delegation and
 * Resolution are left out — the record names the calls, and the session's boundary is already
 * its genesis and resolution.
 *
 * Only knowable once the session's epochs have been committed, since a batched call has no seq
 * until its epoch is given one; the runtime that writes the record calls this after the closing
 * flush.
 */
export function sessionActionSeqs(events: readonly LogResult[], epochs: readonly EpochCommit[]): bigint[] {
  const seqs = new Set<bigint>();
  for (const e of events) if (e.input.kind === EventKind.Action) seqs.add(e.seq);
  for (const epoch of epochs) {
    epoch.inputs.forEach((input, i) => {
      if (input.kind === EventKind.Action) seqs.add(epoch.startSeq + BigInt(i));
    });
  }
  return [...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
