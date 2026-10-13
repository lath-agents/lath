/**
 * The wire shape of the ZeroClaw tab: what `GET /api/zeroclaw` and
 * `GET /api/zeroclaw/<loopId>` answer, declared once and shared by the routes, the server read in
 * `api/_lib/zeroclaw.ts` and the pages.
 *
 * A sandbox is one loop's sandbox: every step of a loop runs in a one-shot Lath-patched ZeroClaw
 * process under the host's wrapper, and the tab shows what those processes were told and what they
 * did. Nothing here is a live process metric — a sandbox exists only while a step runs.
 *
 * Every derived field is a `Sourced<T>`: its value, and which half of the system said it. The
 * server reads only the console's own records, so what it sends is tagged `console`; the pages
 * replace a value with a `chain` one only where they read the chain themselves (the header's seq
 * and last write, the step's Actions). A field no step has produced yet is `value: null` with a
 * `note` saying why — never a placeholder that could be read as a measurement.
 *
 * No import: the root `tsconfig.json` resolves neither `@/` nor the SDK, and a type file that
 * reached for either could not be shared with a Node-only suite later.
 */

/** Which half of the system a field is true of — the same two words `lib/tiles.ts` uses. */
export type ZeroClawSource = "chain" | "console";

/** A value, where it came from, and — when there is none — why not. */
export interface Sourced<T> {
  value: T | null;
  source: ZeroClawSource;
  /** Set when `value` is `null`: the sentence the page prints instead of a value. */
  note?: string;
}

/** The OS layer the host put around the binary. */
export type ZeroClawWrapperKind = "sandbox-exec" | "bwrap";
export type ZeroClawPlatform = "macos" | "linux";

/**
 * What one sandboxed step leaves on its `LoopStepSummary`, under the key `zeroclaw`.
 *
 * The loop scheduler (`_lib/loops.ts`) writes it. A step that ran no sandbox carries none, and the
 * server read says *not yet sandboxed* rather than inventing any of it. It is read structurally (`zeroclawStepRecordOf`), so a record
 * that lacks a key is a record with that field unknown, not a record that is dropped.
 */
export interface ZeroClawStepRecord {
  wrapper: ZeroClawWrapperKind;
  platform: ZeroClawPlatform;
  /** Hex `sha256` of the Lath-patched binary the host spawned — the one the posture commits. */
  binarySha256: string;
  /** Hex `sha256` of `postureJson`'s UTF-8 bytes. */
  postureHash: string;
  /**
   * The posture as committed: the canonical JSON that is `RuntimePolicy.sandbox` — the
   * risk and runtime profile, the wrapper profile and the binary's hash.
   */
  postureJson?: string;
  /** The `config.toml` the host derived from the posture and wrote into the step's config dir. */
  postureToml?: string;
  /** The generated `sandbox-exec` profile, or the `bwrap` arguments one per line. */
  wrapperProfile?: string;
  /**
   * The whole policy document the step's Genesis hashed into `policy_version_hash`
   * (`policyDocument` in `runtime/src/policy.ts`). With it the page re-hashes against the chain;
   * without it the page can only re-hash the posture against its own recorded hash.
   */
  policyDocument?: string;
  /** Seq of the step's Genesis on the loop agent's chain, decimal. */
  genesisSeq?: string;
  /** The `zc.*` Actions the host wrote for the step, from the proxy, in seq order. */
  actions?: { seq: string; tool: string; status: number }[];
  /** Hex `replayHash`, the manifest's 13th key, when the step committed one. */
  replayHash?: string;
  /**
   * The kept record(s) `replayHash` is over: session A's record, or — on a step whose synthesis ran in
   * the sandbox — `[recordA, recordB]`, the fold the hash names, kept as the chains on devnet carry
   * it. Either way `sha256(canonicalJson(replay))` is `replayHash` when the record is whole, which is
   * what the tab checks before it says _replayable_.
   */
  replay?: ZeroClawReplay;
  /**
   * The synthesis's own outcome on a synthesizing step: its record's hash and why its sandbox failed,
   * when it did. Absent on every other step.
   */
  synthesis?: { replayHash?: string; refused?: string };
  /** The canonical tree's size after the step, against the posture's cap. */
  workspace?: { bytes: number; files: number; capBytes: number; capFiles: number };
  /** Why the sandbox refused or failed the step, in the host's words, when it did. */
  refused?: string;
  /**
   * The sources the sandbox was seeded with: `hash` is the posture's
   * `sources.hash`, which the Genesis's policy hash commits, and `manifest` what it names. Absent
   * on a loop with no sources — the tab shows no Sources card then, not an empty one.
   *
   * `manifest` is optional on the wire only: every record the runtime writes carries it.
   */
  sources?: { hash: string; manifest?: SourcesManifest };
}

/*
 * The sources manifest's wire shape, restated from `runtime/src/zeroclaw/sources.ts` because this
 * file imports nothing (header). The runtime module is the definition — its bytes are what the
 * posture hashes — and a page that re-hashes a manifest does it with that module's `sourcesHash`.
 */

/**
 * What the owner typed on the form, before anything is fetched or restored.
 *
 * The runtime keeps `irys` apart (`IrysSourceInput`, with `LoopSourceInput` the union) because its
 * `SandboxSourceInput` is what the fetcher switches over, and a restored set is not fetched. This
 * mirror has no fetcher, only a form and a wire, so it is the whole of what may be typed: the
 * three fetched kinds and a source set restored from another loop's sources on Irys,
 * named by that loop's agent (64 hex) or its Irys index id, and always by the `sourcesHash` its
 * sandbox page shows. A restored set is the loop's only source; the server refuses it beside another.
 */
export type SandboxSourceInput =
  | { kind: "github"; url: string }
  | { kind: "url"; url: string }
  | { kind: "solana"; cluster: "devnet" | "mainnet"; address: string }
  /** A file the owner attached: its content rides in the start body the signature binds. */
  | { kind: "text"; name: string; content: string; contentType?: TextSourceType }
  | { kind: "irys"; agent?: string; index?: string; sourcesHash: string };

/** What an attached file may say it is (`TEXT_SOURCE_TYPES` in the runtime). Absent is `text/plain`. */
export type TextSourceType = "application/json" | "text/plain" | "text/markdown";

/**
 * What _Check sources_ adds when the list is a restored set: where the index was found and the hash
 * every file was re-hashed against. `resolved` then lists the restored manifest's own entries, the
 * pins the first loop fetched, which are what this loop's sandbox will read.
 */
export interface RestoredSourcesCheck {
  /** The index's Irys id, base58. */
  index: string;
  sourcesHash: string;
  /** The agent whose on-chain locator named the index, or `null` when the index id was given. */
  agent: string | null;
}

/** What an input resolved to at start: the commit, the final URL and its type, or the slot. */
export type ResolvedSource =
  | {
      kind: "github";
      input: string;
      owner: string;
      repo: string;
      ref: string | null;
      path: string | null;
      commit: string;
    }
  | { kind: "url"; input: string; finalUrl: string; contentType: string }
  | { kind: "solana"; input: string; cluster: "devnet" | "mainnet"; address: string; slot: string }
  /** An attached file: its name and type, never its content — the file's sha256 is the commitment. */
  | { kind: "text"; name: string; contentType: TextSourceType };

export interface SourceFile {
  /** Relative to `sources/`, beginning with the entry's `dir`. */
  path: string;
  size: number;
  sha256: string;
}

export interface SourceEntry {
  source: ResolvedSource;
  dir: string;
  files: SourceFile[];
  /** `reasons`: why a Solana source's `decoded.json` was not made; absent when there is none. */
  skipped?: { files: number; bytes: number; reasons?: string[] };
}

export interface SourcesManifest {
  v: 1;
  sources: SourceEntry[];
}

/**
 * The replay record `replayHash` commits to, every key the runtime hashes. Hashes are hex.
 *
 * `v` and `now` are optional on the wire only: older rows kept the record without them, and such a
 * record can be shown but never re-hashed, so it is never _replayable_.
 */
export interface ZeroClawReplayRecord {
  /** The record's version, `1`. */
  v?: number;
  binarySha256: string;
  postureHash: string;
  messageHash: string;
  /** The workspace's absolute path as the system prompt carries it (`/lath/work` under `bwrap`). */
  workspacePath: string;
  tz: string;
  locale: string;
  /** `ZEROCLAW_NOW` as the sandbox was told it: the step's own start, `YYYY-MM-DDTHH:MM:SSZ`. */
  now?: string;
  workspaceBefore: string;
  workspaceAfter: string;
  /** The step's `llm.*` and tool seqs, in order, decimal. */
  seqs: string[];
  /**
   * The context window the sandbox's config told the binary the model has, when the step recorded
   * one. Absent on an older record written without it, whose `replayHash` therefore hashes exactly as
   * it was committed.
   */
  contextWindow?: number;
}

/**
 * What a step's `replayHash` is over: one session's record, or a synthesizing step's two in order.
 * Session B starts where session A left the workspace, so `[1].workspaceBefore` is
 * `[0].workspaceAfter` on a fold that is what it says.
 */
export type ZeroClawReplay = ZeroClawReplayRecord | [ZeroClawReplayRecord, ZeroClawReplayRecord];

/** The records of a `ZeroClawReplay`, in the order a replayer runs them. */
export function replayRecords(replay: ZeroClawReplay): ZeroClawReplayRecord[] {
  return Array.isArray(replay) ? [...replay] : [replay];
}

/** What the tab says about this console's own binary: one host status read, never a process metric. */
export interface ZeroClawHostView {
  /** The binary a loop start would spawn (`LATH_ZEROCLAW_BIN`, else `zeroclaw` on `PATH`) is a file this process can read. */
  configured: boolean;
  /** Hex `sha256` of that file, hashed by the server; `null` when not configured. */
  binarySha256: string | null;
  /** The wrapper this host would start a step under, from its platform; `null` on neither. */
  wrapper: ZeroClawWrapperKind | null;
  platform: ZeroClawPlatform | null;
  /** Why the host cannot run a sandbox, when it cannot. */
  note?: string;
}

/** One loop's sandbox, as the tab lists it. */
export interface ZeroClawView {
  loopId: string;
  agentId: string;
  agentName: string;
  owner: string;
  loopStatus: "running" | "paused" | "stopped";
  stepping: boolean;
  /**
   * Where the running step is, in `LoopStepStage`'s words (`types/loop.ts`); absent at rest.
   * Typed as a string rather than imported, for the no-import rule above.
   */
  stepStage?: string;
  /** Unix ms the loop was created. */
  createdAt: number;
  /** `true` once any step of this loop left a sandbox record. */
  sandboxed: boolean;
  wrapper: Sourced<{ kind: ZeroClawWrapperKind; platform: ZeroClawPlatform }>;
  binarySha256: Sourced<string>;
  postureHash: Sourced<string>;
  /** The last step the loop recorded, sandboxed or not; `null` before its first step. */
  lastStep: ZeroClawStepView | null;
}

export interface ZeroClawStepView {
  step: number;
  status: string;
  /** This step left a sandbox record: it ran in a sandbox, and the view's wrapper and posture are its. */
  sandboxed: boolean;
  /** Seq of the step's `loop.step` checkpoint record. */
  seq: Sourced<string>;
  /** Unix ms the step ended. */
  ranAt: Sourced<number>;
  /** How many `zc.*` Actions the step wrote. */
  zcActions: Sourced<number>;
  replayHash: Sourced<string>;
  /**
   * Has a `replayHash` and the record(s) it names, kept whole: `sha256(canonicalJson(replay))` is
   * `replayHash`. A replay can then be attempted. On a member's
   * sandbox, only when the step's manifest committed that member's record.
   */
  replayable: boolean;
  /** Why a step with a `replayHash` is not replayable, when the kept record is the reason. */
  replayNote?: string;
  workspace: Sourced<{ bytes: number; files: number; capBytes: number; capFiles: number }>;
  refused?: string;
}

/** `GET /api/zeroclaw/<loopId>`: the list's view plus everything the detail page shows. */
export interface ZeroClawDetail extends ZeroClawView {
  /**
   * The step every field below describes: the one `?step=N` names, else the last. `null` before the
   * first step, or when the loop never ran step N.
   */
  step: ZeroClawStepView | null;
  /** Every step number the loop recorded, oldest first, so the page can link to each. */
  steps: number[];
  /** Seq of the checkpoint before this step's, so the page can bound the step on the chain. */
  previousSeq: string | null;
  /** This step's Genesis seq, when the sandbox recorded it. */
  genesisSeq: string | null;
  /** This step's genesis `payload_hash`, which names its bundle (`LoopStepSummary`). */
  genesisPayloadHash: string | null;
  postureJson: Sourced<string>;
  /**
   * Always absent, with the note saying why: the derived TOML and the wrapper profile name the host's
   * binary, step directories and sockets, and nothing commits them. The row may keep them on
   * the console's disk; no route serves them. Kept as keys so a client that reads them finds a note,
   * not a missing field.
   */
  postureToml: Sourced<string>;
  wrapperProfile: Sourced<string>;
  policyDocument: Sourced<string>;
  /** The `zc.*` Actions the sandbox recorded; the page holds them against the chain's. */
  actions: Sourced<{ seq: string; tool: string; status: number }[]>;
  replay: Sourced<ZeroClawReplay>;
  /**
   * The step's _changed since pinned_ note, as its sandboxes were told it:
   * part of the message the replay record's `messageHash` commits, shown on the Replay card. Absent
   * when the step carries none, and for a reader who is not the owner, for the replay record's reason.
   */
  sourcesNote?: string;
  /**
   * What this step's model calls cost, micro-USDC, as the console metered them. For a
   * sandboxed step every call crossed the proxy, so this is the proxy's meter for the session; the
   * Tempo channel it rode is on the loop's page.
   */
  stepCostMicroUsdc: Sourced<string>;
}

export interface ZeroClawListResponse {
  cluster: string;
  host: ZeroClawHostView;
  sandboxes: ZeroClawView[];
}

/**
 * The tool ids a sandbox's Actions carry: the two file tools. The chain stores `sha256(name)`, so a
 * name is recoverable only from a list; `zc.shell` and the rest join it when the posture widens, and
 * a tool missing here shows as its hash.
 */
export const ZC_TOOLS = ["zc.file_read", "zc.file_write"] as const;

/** The trademark line the tab owes, said once on the page and in the docs. */
export const ZEROCLAW_ATTRIBUTION = "ZeroClaw is a trademark of ZeroClaw Labs; Lath runs a Lath-patched build of it.";

/** What the sandbox could reach, in the air-gap's own words, for the platform the step ran on. */
export function airGapSentence(platform: ZeroClawPlatform | null): string {
  const on = platform === "macos" ? "macOS (sandbox-exec)" : platform === "linux" ? "Linux (bwrap)" : null;
  return on
    ? `This step could reach the metering proxy and Lath's host tools over two Unix sockets and nothing else; the host's wrapper enforced that at the OS on ${on}.`
    : "No wrapper to name: the last step of this loop did not run in a sandbox. A sandboxed step is given two Unix sockets, the metering proxy and Lath's host tools, and no other network.";
}
