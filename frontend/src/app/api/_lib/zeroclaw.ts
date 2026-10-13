/**
 * The server-side read behind the ZeroClaw tab: every loop the scheduler knows, projected as its
 * sandbox.
 *
 * Read-only, and only over what this process already holds: the loop registry `_lib/loops.ts` keeps
 * (imported, never edited here — the loop step is what writes a step's sandbox record) and the one
 * binary a loop start would spawn (`LATH_ZEROCLAW_BIN`, else `zeroclaw` on `PATH`). It spawns
 * nothing, writes nothing and asks the chain nothing; the pages read the chain themselves and tag what
 * they read `chain`.
 *
 * Its one rule is the one the tab exists to keep: a field no step has produced is `null` with a
 * sentence, never a default. A step with no sandbox record reads *not sandboxed* — which is the truth
 * about such a step: it ran in-process.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { canonicalJson } from "@lath/runtime";
import { onPath } from "@lath/runtime/zeroclaw/runtime";
import { readLoop, readLoops, steppingNow, type LoopRecord } from "./loops";
import type { LoopMemberView } from "../../../types/loop";
import { stepStageView } from "./loop-stage";
import {
  replayRecords,
  type Sourced,
  type SourcesManifest,
  type ZeroClawDetail,
  type ZeroClawHostView,
  type ZeroClawPlatform,
  type ZeroClawReplay,
  type ZeroClawReplayRecord,
  type ZeroClawStepRecord,
  type ZeroClawStepView,
  type ZeroClawView,
  type ZeroClawWrapperKind,
} from "../../../types/zeroclaw";

/** Said on every field a step has not produced yet: the step ran, and ran outside a sandbox. */
export const NOT_SANDBOXED = "not yet sandboxed: no step of this loop has run in a sandbox";
/** Said on a step's own fields when that step ran outside a sandbox. */
export const STEP_NOT_SANDBOXED = "not sandboxed: this step ran outside a sandbox";
/** Said on every field of a loop that has not stepped at all. */
export const NO_STEP = "no step yet";
/**
 * Said on a member's _replayable_ when its sandbox kept a replay record and the step's manifest has no
 * `replayHash` in that member's object: an older step that did not commit members' records, so
 * nothing on chain names the record and calling it replayable would claim a commitment that is not
 * there. A step that commits it makes the member replayable on the same terms session A is.
 */
export const MEMBER_REPLAY_UNCOMMITTED =
  "this step's manifest commits no replay record for this member: the record is kept but no manifest names it";
/**
 * Said when the manifest commits a member's `replayHash` and the sandbox's record carries another hash,
 * or none: the commitment stands, but the record this console holds is not the one it names.
 */
export const MEMBER_REPLAY_MISMATCH =
  "the step's manifest commits a replay record for this member that is not the one this console kept";
/** Said on a member whose row carries no sandbox: it never reached one, or ran before members' sandboxes were kept. */
export const MEMBER_NOT_RECORDED = "this member's sandbox was not recorded";
/**
 * Said on the derived `config.toml` and the wrapper profile, to every reader. Both are one
 * session's, written by `layOut` in the runtime: the profile names the binary's absolute path, the
 * step's work and config directories, both sockets, their ancestor directories and, under `bwrap`, the
 * libraries `ldd` found; the TOML names the step's directories and workspace. That is the host's
 * filesystem layout, the operator's user name among it, which the open routes keep back as
 * `readZeroClawHost(…, false)` keeps back the binary's location. Not a privacy rule, so no reader is
 * served them: nothing commits either text, and the posture JSON, which the chain commits by hash, is
 * all the page's re-hash needs.
 */
export const HOST_PATHS_WITHHELD =
  "not served: it names this host's directories and sockets, and nothing commits it; the posture JSON is what the chain commits by hash";
/** Said on the synthesis's row: its sandbox is the orchestrator's, folded into session A's record. */
export const SYNTHESIS_FOLDED =
  "the synthesis ran in the orchestrator's sandbox and its tool calls are folded into session A's record";
/**
 * Said when a step committed a `replayHash` and the record this console kept cannot be re-hashed to
 * it, because the row is an older one that kept the record in part: `v` and `now` were dropped, so
 * the bytes the hash is over cannot be rebuilt here.
 */
export const REPLAY_NOT_WHOLE =
  "the record kept for this step is an older, partial one that lacks `v` or `now`, so it cannot be re-hashed to its replayHash";
/**
 * Said when the kept record is whole and does not re-hash to the committed `replayHash`: on a
 * synthesizing step written before both records were kept, the row holds session A's record under
 * the fold's hash.
 */
export const REPLAY_REHASH_MISMATCH = "the record kept for this step does not re-hash to its replayHash";
/** Said when a step committed a `replayHash` and this console kept no record under it. */
export const REPLAY_NOT_KEPT = "the step committed a replayHash and this console kept no record under it";

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]+$/;

// ─── The sandbox record, read structurally ─────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function hex64(v: unknown): string | undefined {
  const s = str(v)?.toLowerCase();
  return s && HEX64.test(s) ? s : undefined;
}

function decimal(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  const s = str(v);
  return s && DECIMAL.test(s) ? s : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/**
 * The `zeroclaw` key of a step summary as a `ZeroClawStepRecord`, or `null` when the step has
 * none or it is not one.
 *
 * The three keys that say *which sandbox* — wrapper, platform, binary hash — and the posture hash are
 * required: a record without them cannot say what the step was confined by, and reporting half a
 * sandbox as a sandbox is the claim this tab must not make. Everything else is optional and dropped
 * alone when malformed, so one bad field hides that field and not the step. A hash that is not 64
 * hex characters is malformed, not shortened: a page re-hashes against these.
 */
export function zeroclawStepRecordOf(step: unknown): ZeroClawStepRecord | null {
  if (!step || typeof step !== "object") return null;
  const r = (step as Record<string, unknown>).zeroclaw;
  if (!r || typeof r !== "object") return null;
  const z = r as Record<string, unknown>;
  const wrapper = z.wrapper === "sandbox-exec" || z.wrapper === "bwrap" ? (z.wrapper as ZeroClawWrapperKind) : null;
  const platform = z.platform === "macos" || z.platform === "linux" ? (z.platform as ZeroClawPlatform) : null;
  const binarySha256 = hex64(z.binarySha256);
  const postureHash = hex64(z.postureHash);
  if (!wrapper || !platform || !binarySha256 || !postureHash) return null;

  const out: ZeroClawStepRecord = { wrapper, platform, binarySha256, postureHash };
  const postureJson = str(z.postureJson);
  if (postureJson) out.postureJson = postureJson;
  const postureToml = str(z.postureToml);
  if (postureToml) out.postureToml = postureToml;
  const wrapperProfile = str(z.wrapperProfile);
  if (wrapperProfile) out.wrapperProfile = wrapperProfile;
  const policyDocument = str(z.policyDocument);
  if (policyDocument) out.policyDocument = policyDocument;
  const genesisSeq = decimal(z.genesisSeq);
  if (genesisSeq) out.genesisSeq = genesisSeq;
  if (Array.isArray(z.actions)) {
    const actions: NonNullable<ZeroClawStepRecord["actions"]> = [];
    for (const a of z.actions) {
      if (!a || typeof a !== "object") continue;
      const row = a as Record<string, unknown>;
      const seq = decimal(row.seq);
      const tool = str(row.tool);
      const status = count(row.status);
      if (seq && tool && status !== undefined) actions.push({ seq, tool, status });
    }
    out.actions = actions;
  }
  const replayHash = hex64(z.replayHash);
  if (replayHash) out.replayHash = replayHash;
  const replay = replayOf(z.replay);
  if (replay) out.replay = replay;
  if (z.synthesis && typeof z.synthesis === "object") {
    const s = z.synthesis as Record<string, unknown>;
    const synthesis = {
      ...(hex64(s.replayHash) ? { replayHash: hex64(s.replayHash) } : {}),
      ...(str(s.refused) ? { refused: str(s.refused) } : {}),
    };
    if (Object.keys(synthesis).length) out.synthesis = synthesis;
  }
  if (z.workspace && typeof z.workspace === "object") {
    const w = z.workspace as Record<string, unknown>;
    const bytes = count(w.bytes);
    const files = count(w.files);
    const capBytes = count(w.capBytes);
    const capFiles = count(w.capFiles);
    if (bytes !== undefined && files !== undefined && capBytes !== undefined && capFiles !== undefined)
      out.workspace = { bytes, files, capBytes, capFiles };
  }
  const refused = str(z.refused);
  if (refused) out.refused = refused;
  const sources = sourcesRecordOf(z.sources);
  if (sources) out.sources = sources;
  return out;
}

const SOURCE_KINDS = ["github", "url", "solana", "text"];

/**
 * The record's `sources`, or `null` when it is absent or cannot be rendered.
 *
 * Checked only as far as the page needs to draw it — a hash that is 64 hex, entries whose source
 * names a kind and an input (an attached file's name, for `text`, which has no input), files with a
 * path, a size and a hash — and then passed on **as
 * recorded**, never rebuilt: the page re-hashes this object against the posture's `sources.hash`,
 * and a reader that dropped an unknown key or reordered a list would turn a manifest that does not
 * match into one that does. Whether it matches is the browser's to say, not this read's.
 */
function sourcesRecordOf(v: unknown): { hash: string; manifest: SourcesManifest } | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const hash = hex64(r.hash);
  const m = r.manifest as Record<string, unknown> | null;
  if (!hash || !m || typeof m !== "object" || m.v !== 1 || !Array.isArray(m.sources)) return null;
  for (const e of m.sources as unknown[]) {
    if (!e || typeof e !== "object") return null;
    const entry = e as Record<string, unknown>;
    const src = entry.source as Record<string, unknown> | null;
    if (!src || typeof src !== "object" || !SOURCE_KINDS.includes(src.kind as string)) return null;
    const named = src.kind === "text" ? typeof src.name === "string" : typeof src.input === "string";
    if (!named || typeof entry.dir !== "string" || !Array.isArray(entry.files)) return null;
    for (const f of entry.files as unknown[]) {
      const file = f as Record<string, unknown> | null;
      if (!file || typeof file !== "object" || typeof file.path !== "string") return null;
      if (count(file.size) === undefined || typeof file.sha256 !== "string") return null;
    }
  }
  return { hash, manifest: m as unknown as SourcesManifest };
}

/**
 * The row's replay: one record, or a synthesizing step's two in order. An array of any
 * other length, or one with an element that is not a record, is no replay — half a fold is not a
 * record the step's hash names.
 */
function replayOf(v: unknown): ZeroClawReplay | null {
  if (Array.isArray(v)) {
    if (v.length !== 2) return null;
    const a = replayRecordOf(v[0]);
    const b = replayRecordOf(v[1]);
    return a && b ? [a, b] : null;
  }
  return replayRecordOf(v);
}

/**
 * Whether the kept replay is the preimage of the committed `replayHash`: every record whole (`v` and
 * `now` kept) and `sha256(canonicalJson(replay))` equal to the hash — the record's own bytes
 * (`replayRecordBytes`) for one session, the fold's for two. `note` says why not, when the
 * record is the reason; a step that committed no hash has no note here, its field already says so.
 *
 * Re-hashed rather than trusted because the row is the console's word about the record and the hash
 * is the chain's: an older synthesizing step's row holds session A's record under the fold's hash, and
 * trusting the row would call that _replayable_.
 */
export function replayRehash(record: Pick<ZeroClawStepRecord, "replayHash" | "replay"> | null): {
  ok: boolean;
  note?: string;
} {
  if (!record?.replayHash) return { ok: false };
  if (!record.replay) return { ok: false, note: REPLAY_NOT_KEPT };
  const records = replayRecords(record.replay);
  if (records.some((r) => r.v === undefined || r.now === undefined)) return { ok: false, note: REPLAY_NOT_WHOLE };
  const kept = Array.isArray(record.replay) ? records : records[0];
  return sha256Hex(canonicalJson(kept)) === record.replayHash
    ? { ok: true }
    : { ok: false, note: REPLAY_REHASH_MISMATCH };
}

function replayRecordOf(v: unknown): ZeroClawReplayRecord | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const binarySha256 = hex64(r.binarySha256);
  const postureHash = hex64(r.postureHash);
  const messageHash = hex64(r.messageHash);
  const workspaceBefore = hex64(r.workspaceBefore);
  const workspaceAfter = hex64(r.workspaceAfter);
  const workspacePath = str(r.workspacePath);
  const tz = str(r.tz);
  const locale = str(r.locale);
  if (!binarySha256 || !postureHash || !messageHash || !workspaceBefore || !workspaceAfter) return null;
  if (!workspacePath || !tz || !locale || !Array.isArray(r.seqs)) return null;
  const seqs = r.seqs.map(decimal);
  if (seqs.some((s) => s === undefined)) return null;
  // Carried when the record has one, so the Replay card can say what window the sandbox was told; an
  // older record has none, and none is invented for it.
  const contextWindow = count(r.contextWindow);
  // Kept when the row has them, so the record re-hashes; an older row has neither, and neither is
  // invented for it — the record is then shown and not called replayable.
  const version = count(r.v);
  const now = str(r.now);
  return {
    ...(version !== undefined ? { v: version } : {}),
    binarySha256,
    postureHash,
    messageHash,
    workspacePath,
    tz,
    locale,
    ...(now ? { now } : {}),
    workspaceBefore,
    workspaceAfter,
    seqs: seqs as string[],
    ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
  };
}

// ─── The projection ─────────────────────────────────────────────────────────

function known<T>(value: T): Sourced<T> {
  return { value, source: "console" };
}

function absent<T>(note: string): Sourced<T> {
  return { value: null, source: "console", note };
}

/** The newest step that ran in a sandbox, which is what the tab's wrapper and posture describe. */
function lastSandboxOf(loop: LoopRecord): ZeroClawStepRecord | null {
  for (let i = loop.history.length - 1; i >= 0; i--) {
    const sandbox = zeroclawStepRecordOf(loop.history[i]);
    if (sandbox) return sandbox;
  }
  return null;
}

type StepSummary = LoopRecord["history"][number];

/**
 * One step as the tab shows it, described by `sandbox` — session A's record by default, or a member's
 * when the page asked for that member's sandbox. `seq` is what bounds the sandbox's Actions on its chain:
 * the step's checkpoint for session A, the member's own seq when the step closed for a member.
 */
function stepViewOf(
  step: StepSummary,
  sandbox: ZeroClawStepRecord | null = zeroclawStepRecordOf(step),
  why: string = STEP_NOT_SANDBOXED,
  seq: string | undefined = step.seq
): ZeroClawStepView {
  const zc = sandbox?.actions?.filter((a) => a.tool.startsWith("zc.")).length;
  const rehash = replayRehash(sandbox);
  const view: ZeroClawStepView = {
    step: step.step,
    status: step.status,
    sandboxed: !!sandbox,
    seq: seq && DECIMAL.test(seq) ? known(seq) : absent("the step wrote no checkpoint"),
    ranAt: Number.isFinite(step.endedAt) && step.endedAt > 0 ? known(step.endedAt) : absent("not recorded"),
    zcActions: !sandbox
      ? absent(why)
      : zc === undefined
      ? absent("the sandbox recorded no tool calls for this step")
      : known(zc),
    replayHash: !sandbox
      ? absent(why)
      : sandbox.replayHash
      ? known(sandbox.replayHash)
      : absent("the step committed no replay record"),
    // Only when the kept record(s) re-hash to the committed hash: a hash and a record beside
    // it are two claims, and a replay needs the record the hash names.
    replayable: rehash.ok,
    workspace: !sandbox
      ? absent(why)
      : sandbox.workspace
      ? known(sandbox.workspace)
      : absent("the sandbox recorded no workspace size"),
  };
  if (rehash.note) view.replayNote = rehash.note;
  if (sandbox?.refused) view.refused = sandbox.refused;
  return view;
}

/** One loop as its sandbox. `lastStep` is the newest step recorded, sandboxed or not. */
export function zeroclawViewOf(loop: LoopRecord): ZeroClawView {
  const sandbox = lastSandboxOf(loop);
  const last = loop.history.length ? loop.history[loop.history.length - 1] : null;
  const none = loop.history.length === 0 ? NO_STEP : NOT_SANDBOXED;
  return {
    loopId: loop.id,
    agentId: loop.agentId,
    agentName: loop.agentName,
    owner: loop.owner,
    loopStatus: loop.status,
    stepping: steppingNow(loop),
    // The stage alone, not the clock: the tab's badge says what the sandbox is doing, and the loop
    // page is where a step is timed. Absent at rest, so an idle row carries no stage key at all.
    ...((): { stepStage?: string } => {
      const { stepStage } = stepStageView(loop.id);
      return stepStage ? { stepStage } : {};
    })(),
    createdAt: loop.createdAt,
    sandboxed: !!sandbox,
    wrapper: sandbox ? known({ kind: sandbox.wrapper, platform: sandbox.platform }) : absent(none),
    binarySha256: sandbox ? known(sandbox.binarySha256) : absent(none),
    postureHash: sandbox ? known(sandbox.postureHash) : absent(none),
    lastStep: last ? stepViewOf(last) : null,
  };
}

/**
 * One sandbox a step opened, as the _Sandboxes in this step_ card lists it: session A, each member
 * (members run in sandboxes of their own), and the synthesis when the step ran one. `sandbox` is what `?sandbox=` names — `null` for session A, which is the bare step URL, and for the
 * synthesis, whose sandbox is session A's and has no record of its own to open.
 */
export interface ZeroClawSandboxRow {
  kind: "session" | "synthesis" | "member";
  label: string;
  sandbox: string | null;
  /** The chain this sandbox's Actions are on: the loop agent's, or the member's own. */
  agentId: string;
  sandboxed: boolean;
  wrapper: Sourced<{ kind: ZeroClawWrapperKind; platform: ZeroClawPlatform }>;
  postureHash: Sourced<string>;
  zcActions: Sourced<number>;
  /**
   * `null` with a note for a sandbox with no record and for a member of an older step that did not
   * commit members' records; a member of a step that does is `true` when the manifest's
   * `replayHash` in its object is its record's hash. Never a guess.
   */
  replayable: Sourced<boolean>;
  refused?: string;
}

/**
 * `GET /api/zeroclaw/<loopId>?step=N&sandbox=<member>`: the detail, plus every sandbox of the step and
 * the sources the described sandbox was seeded with. The Posture, Actions and Replay fields describe
 * `selected`, which is session A unless `?sandbox=` named a member.
 *
 * Declared here, beside the read that fills it, rather than in `types/zeroclaw.ts`; the page imports
 * it as a type only, so nothing of this module reaches the browser.
 */
export interface ZeroClawSandboxDetail extends ZeroClawDetail {
  sandboxes: ZeroClawSandboxRow[];
  selected: { kind: "session" | "member"; label: string; sandbox: string | null; agentId: string };
  /**
   * The described sandbox's sources: `hash` is the record's copy of its posture's `sources.hash`,
   * `manifest` what it names. `null` when the sandbox had none, so the page draws no card rather than
   * an empty one; a value of `null` with a note when sources are committed but cannot be shown.
   */
  sources: Sourced<{ hash: string; manifest: SourcesManifest | null }> | null;
  /**
   * Where the described sandbox's sources are on Irys: the
   * index the page reads each file's id from, and the gateway it links them through. The console's
   * word for where to look, nothing more — the page re-hashes the index's `sourcesHash` against the
   * posture's and every linked file is named by the hash the manifest commits.
   *
   * `null` when the loop's sources are not on Irys, or when the described sandbox is not seeded with
   * them.
   */
  irys: Sourced<SandboxSourcesIrys> | null;
  /**
   * Where the described sandbox's posture is on Irys in clear: the object whose bytes the page
   * re-hashes against `postureHash` in place of this console's `postureJson`, so the posture check
   * takes nothing on the console's word but where to look. `null` when this console never put that
   * posture up: an older loop, or any loop on a console that does not anchor to Irys. The page then
   * verifies from `postureJson`.
   */
  postureIrys: SandboxPostureIrys | null;
}

export interface ZeroClawSandboxDetailResponse {
  cluster: string;
  host: ZeroClawHostView;
  sandbox: ZeroClawSandboxDetail;
}

/** `ZeroClawSandboxDetail.irys`'s value: the loop row's `LoopSourcesIrys`, less what a page has no use for. */
export interface SandboxSourcesIrys {
  /** The index's Irys id, base58. */
  index: string;
  /** Without a trailing slash; a file is `<gateway>/<id>`. */
  gateway: string;
  network: "devnet" | "mainnet";
  /** The sources hash the index was published or restored for: the loop's. */
  sourcesHash: string;
  /** `true` when this loop restored its sources from another loop's rather than publishing them. */
  restored: boolean;
}

/** `ZeroClawSandboxDetail.postureIrys`'s value: one entry of the loop row's `postures`, and the hash it is for. */
export interface SandboxPostureIrys {
  /** The object's Irys id, base58. */
  id: string;
  /** Without a trailing slash; the posture is `<gateway>/<id>`. */
  gateway: string;
  network: "devnet" | "mainnet";
  /** The posture hash the id was uploaded for: the described sandbox's. */
  postureHash: string;
}

/**
 * The described sandbox's posture on Irys, looked up by the hash its record names — never by step, so
 * every step and member that ran under one posture links the one object. Only an https gateway is
 * linked, for the reason the sources' is.
 */
function postureIrysOf(loop: LoopRecord, record: ZeroClawStepRecord | null): SandboxPostureIrys | null {
  const hash = record?.postureHash;
  const found = hash ? loop.postures?.[hash] : undefined;
  if (!hash || !found || typeof found.id !== "string" || typeof found.gateway !== "string") return null;
  if (!/^https:\/\//i.test(found.gateway)) return null;
  return {
    id: found.id,
    gateway: found.gateway.replace(/\/+$/, ""),
    network: found.network === "mainnet" ? "mainnet" : "devnet",
    postureHash: hash,
  };
}

/**
 * The loop's sources on Irys, for the sandbox the page describes: only when that sandbox's record
 * names the loop's own sources hash — every sandbox of a loop is seeded with the one set, so
 * this is the common case, and a record naming another hash is one the index is not about. A
 * gateway that is not `https://` is left out, as `SourcePin` leaves out such a URL: the record is
 * the console's, and an href taken from it unchecked is a `javascript:` URL away from running.
 */
function sourcesIrysFieldOf(loop: LoopRecord, record: ZeroClawStepRecord | null): Sourced<SandboxSourcesIrys> | null {
  const irys = loop.sandbox?.irys;
  const hash = loop.sandbox?.sourcesHash;
  if (!irys || !hash || !record?.sources || record.sources.hash !== hash) return null;
  if (typeof irys.index !== "string" || typeof irys.gateway !== "string") return null;
  if (!/^https:\/\//i.test(irys.gateway)) return absent("the console's Irys gateway is not an https:// URL");
  return known({
    index: irys.index,
    gateway: irys.gateway.replace(/\/+$/, ""),
    network: irys.network === "mainnet" ? "mainnet" : "devnet",
    sourcesHash: hash,
    restored: !!irys.restored,
  });
}

/** Whether the posture JSON carries a `sources` key: it commits sources whether or not the record shows them. */
function postureNamesSources(postureJson: string | undefined): boolean {
  if (!postureJson) return false;
  try {
    const p = JSON.parse(postureJson) as Record<string, unknown> | null;
    return !!p && typeof p === "object" && p.sources !== undefined;
  } catch {
    return false;
  }
}

function sourcesFieldOf(
  record: ZeroClawStepRecord | null,
  raw: unknown
): Sourced<{ hash: string; manifest: SourcesManifest | null }> | null {
  if (!record) return null;
  if (record.sources?.manifest) return known({ hash: record.sources.hash, manifest: record.sources.manifest });
  const rawHas = !!raw && typeof raw === "object" && (raw as Record<string, unknown>).sources !== undefined;
  // A record that says it had sources, or a posture that commits them, and no manifest this read can
  // draw: the card is shown with the gap named. Hiding it would make a sandbox seeded with files look
  // like a sandbox with none.
  if (rawHas) return absent("the sandbox recorded sources this console cannot read");
  if (postureNamesSources(record.postureJson)) return absent("the posture commits sources the sandbox did not record");
  return null;
}

function rawSandboxOf(v: unknown): unknown {
  return v && typeof v === "object" ? (v as Record<string, unknown>).zeroclaw : undefined;
}

function memberRecordOf(m: LoopMemberView): ZeroClawStepRecord | null {
  return zeroclawStepRecordOf({ zeroclaw: m.zeroclaw });
}

/**
 * A member's _replayable_: `true` exactly when the step's manifest committed a `replayHash` in this
 * member's object and it is the hash of the record the member's sandbox kept — the same two facts
 * session A's rests on, a commitment and the record under it. A member with no committed key is an
 * older step that does not carry the key (or a sandbox that never wrote its record): `null` and the
 * sentence, because *not replayable* would be a verdict on a step that was never asked to commit one. A committed key the record does not carry is `false` and said why.
 */
function memberReplayable(
  member: LoopMemberView | null,
  record: ZeroClawStepRecord | null,
  why: string
): Sourced<boolean> {
  if (!record) return absent(why);
  const committed = member?.replayHash;
  if (!committed) return record.replayHash ? absent(MEMBER_REPLAY_UNCOMMITTED) : known(false);
  if (record.replayHash !== committed) return { value: false, source: "console", note: MEMBER_REPLAY_MISMATCH };
  // The commitment and the record's own hash agree; the kept record must still be what they name.
  const rehash = replayRehash(record);
  return rehash.ok ? known(true) : { value: false, source: "console", note: rehash.note };
}

/** Session A's _replayable_, or the synthesis's (the same fold, on session A's record): yes only on a re-hash. */
function sessionReplayable(record: ZeroClawStepRecord): Sourced<boolean> {
  const rehash = replayRehash(record);
  return rehash.note ? { value: rehash.ok, source: "console", note: rehash.note } : known(rehash.ok);
}

function sandboxRowOf(
  kind: ZeroClawSandboxRow["kind"],
  label: string,
  sandbox: string | null,
  agentId: string,
  record: ZeroClawStepRecord | null,
  why: string,
  member: LoopMemberView | null = null
): ZeroClawSandboxRow {
  const zc = record?.actions?.filter((a) => a.tool.startsWith("zc.")).length;
  const row: ZeroClawSandboxRow = {
    kind,
    label,
    sandbox,
    agentId,
    sandboxed: !!record,
    wrapper: record ? known({ kind: record.wrapper, platform: record.platform }) : absent(why),
    postureHash: record ? known(record.postureHash) : absent(why),
    zcActions: !record
      ? absent(why)
      : kind === "synthesis"
      ? absent(SYNTHESIS_FOLDED)
      : zc === undefined
      ? absent("the sandbox recorded no tool calls")
      : known(zc),
    replayable: !record
      ? absent(why)
      : kind === "member"
      ? memberReplayable(member, record, why)
      : sessionReplayable(record),
  };
  // The synthesis's own refusal, which the row keeps apart from session A's (`record.refused`).
  const refused = kind === "synthesis" ? record?.synthesis?.refused : record?.refused;
  if (refused) row.refused = refused;
  return row;
}

/** Every sandbox `cur` opened: session A, each member in the order the runner reported them, then the synthesis. */
function sandboxRowsOf(loop: LoopRecord, cur: StepSummary): ZeroClawSandboxRow[] {
  const a = zeroclawStepRecordOf(cur);
  const rows = [sandboxRowOf("session", "session A", null, loop.agentId, a, STEP_NOT_SANDBOXED)];
  for (const m of cur.members ?? []) {
    rows.push(sandboxRowOf("member", m.name, m.name, m.agentId, memberRecordOf(m), MEMBER_NOT_RECORDED, m));
  }
  if (cur.synthesis) rows.push(sandboxRowOf("synthesis", "synthesis", null, loop.agentId, a, STEP_NOT_SANDBOXED));
  return rows;
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Whether `doc` is a policy document whose `sandbox` key is exactly `posture`'s bytes. */
function policyCarries(doc: string, posture: string): boolean {
  try {
    const p = JSON.parse(doc) as Record<string, unknown> | null;
    return !!p && typeof p === "object" && p.sandbox !== undefined && canonicalJson(p.sandbox) === posture;
  } catch {
    return false;
  }
}

/**
 * `sandbox` with the posture's bytes and its policy document filled in from another record of the same
 * loop, when its own row no longer carries them.
 *
 * Why they go missing: `loop-step.ts` keeps the four sandbox texts on the newest history row only
 * (`withoutSandboxTexts`), so an older step's record keeps `postureHash` and loses `postureJson` — and
 * the Posture card could not re-hash it, and the Sources card would call its sources hash the
 * console's word although every step of a loop that did not restart runs the same posture.
 *
 * Why borrowing is honest: `postureHash` is `sha256(utf8(postureJson))`, so bytes that hash to the
 * hash this sandbox recorded are this sandbox's posture, whoever's row they were kept on. They are taken
 * only on that equality — never on a matching `postureHash` field alone, which is a claim a donor
 * row makes about itself — so a donor whose bytes do not re-hash is refused, not served.
 *
 * `policyDocument` cannot be held to anything here: the hash it answers to is the Genesis's
 * `policy_version_hash`, on chain, and this module asks the chain nothing. So it is borrowed only
 * from the same sandbox across steps (session A's rows for session A, the same member agent's for a
 * member — a member's policy is its own agent's, not the loop's), whose posture re-hashes to this
 * sandbox's hash and whose `sandbox` key is those bytes. The page still re-hashes it against the
 * Genesis it reads, so a document that changed between steps shows as a mismatch, never a match.
 *
 * `postureToml` and `wrapperProfile` are not borrowed: they are derived per session and name that
 * session's step directory and sockets (`layOut` in the runtime), nothing commits them, and another
 * step's would show paths this sandbox never had. Nor are they served, own or borrowed: those paths
 * are the host's (`HOST_PATHS_WITHHELD`).
 */
function withBorrowedTexts(
  loop: LoopRecord,
  sandbox: ZeroClawStepRecord,
  memberAgentId: string | undefined
): ZeroClawStepRecord {
  const ownPosture = sandbox.postureJson;
  if (ownPosture && sandbox.policyDocument) return sandbox;
  const donors: { record: ZeroClawStepRecord; sameSandbox: boolean }[] = [];
  for (let j = loop.history.length - 1; j >= 0; j--) {
    const h = loop.history[j];
    const a = zeroclawStepRecordOf(h);
    if (a) donors.push({ record: a, sameSandbox: memberAgentId === undefined });
    for (const m of h.members ?? []) {
      const r = memberRecordOf(m);
      if (r) donors.push({ record: r, sameSandbox: memberAgentId !== undefined && m.agentId === memberAgentId });
    }
  }
  const verified = (r: ZeroClawStepRecord): string | undefined =>
    r.postureHash === sandbox.postureHash && r.postureJson && sha256Hex(r.postureJson) === sandbox.postureHash
      ? r.postureJson
      : undefined;

  let postureJson = ownPosture;
  if (!postureJson) {
    for (const d of donors) {
      postureJson = verified(d.record);
      if (postureJson) break;
    }
  }
  let policyDocument = sandbox.policyDocument;
  // Only beside a posture that is this sandbox's by hash: a policy document next to bytes the page
  // cannot tie to the Genesis would be a second unchecked text, not a checked one.
  if (!policyDocument && postureJson && sha256Hex(postureJson) === sandbox.postureHash) {
    for (const d of donors) {
      const p = d.sameSandbox ? verified(d.record) : undefined;
      if (p && d.record.policyDocument && policyCarries(d.record.policyDocument, p)) {
        policyDocument = d.record.policyDocument;
        break;
      }
    }
  }
  if (postureJson === ownPosture && policyDocument === sandbox.policyDocument) return sandbox;
  return {
    ...sandbox,
    ...(postureJson ? { postureJson } : {}),
    ...(policyDocument ? { policyDocument } : {}),
  };
}

/**
 * The detail page's read: the list's view, plus one step's posture as committed, the Actions the
 * sandbox recorded and the replay record — never the derived TOML or wrapper profile, which name the
 * host's paths (`HOST_PATHS_WITHHELD`). The step is `at` when
 * given (`?step=N`), else the last one; the sandbox is the member `sandboxName` names (`?sandbox=`), else
 * session A.
 *
 * Everything is **that step's**, not the newest sandbox's: the page bounds the step on the chain by
 * its checkpoint seqs and shows that step's Actions, and a posture from another step beside them
 * would describe a sandbox those Actions did not run in. `at` exists because a loop steps faster than
 * a reader: by the time step 1's page is open step 2 may be the last, and step 1's Actions would
 * have no page of their own.
 *
 * A member's sandbox is described from the member's own record and bounded on the member's own chain
 * — from its Genesis to its seq when the step closed. Its bundle key is not on the step's row (that
 * one is the loop's), so `genesisPayloadHash` is `null` and the page finds its Genesis by seq.
 */
export function zeroclawDetailOf(loop: LoopRecord, at?: number, sandboxName?: string): ZeroClawSandboxDetail {
  const view = zeroclawViewOf(loop);
  const n = loop.history.length;
  const i = at === undefined ? n - 1 : loop.history.findIndex((h) => h.step === at);
  const cur = i >= 0 ? loop.history[i] : null;
  const member = cur && sandboxName ? (cur.members ?? []).find((m) => m.name === sandboxName) ?? null : null;
  const own = !cur ? null : sandboxName ? (member ? memberRecordOf(member) : null) : zeroclawStepRecordOf(cur);
  // An older step's row has lost its texts to the newest row (`withoutSandboxTexts`); the posture's
  // bytes come back from any record they re-hash to this sandbox's hash from, which is also what lets
  // the Sources card tie `sources.hash` to the Genesis on every step, not only the newest.
  const sandbox = own ? withBorrowedTexts(loop, own, member?.agentId) : null;
  // The newest earlier step that wrote a checkpoint: a failed step writes none. A
  // member's range starts at its own Genesis on its own chain, which the loop's steps do not bound.
  let previousSeq: string | null = null;
  for (let j = i - 1; j >= 0 && !sandboxName; j--) {
    const seq = loop.history[j].seq;
    if (seq && DECIMAL.test(seq)) {
      previousSeq = seq;
      break;
    }
  }
  const why = !cur
    ? at !== undefined && n
      ? `this loop has no step ${at}`
      : NO_STEP
    : sandboxName && !member
    ? `step ${cur.step} has no member named ${JSON.stringify(sandboxName)}`
    : member
    ? MEMBER_NOT_RECORDED
    : STEP_NOT_SANDBOXED;
  const field = <T>(value: T | undefined, missing: string): Sourced<T> =>
    !sandbox ? absent(why) : value !== undefined ? known(value) : absent(missing);
  // A refused Delegation leaves the member at seq "0": no chain to bound, not a range ending at 0.
  const memberSeq = member && member.seq !== "0" ? member.seq : undefined;
  const step = cur ? (sandboxName ? stepViewOf(cur, sandbox, why, memberSeq) : stepViewOf(cur)) : null;
  // A member's sandbox is replayable only when the step's manifest committed its record; the row's
  // `null` for an older step that did not is `false` here, where the field is a plain yes/no.
  if (step && sandboxName) step.replayable = memberReplayable(member, sandbox, why).value === true;
  return {
    ...view,
    // The sandbox the cards describe, when it has a record: the Posture card re-hashes this sandbox's
    // posture bytes against `postureHash`, and the loop's newest sandbox beside a member's (or an
    // earlier step's) posture is a mismatch the page would report about a sandbox it is not showing.
    ...(sandbox
      ? {
          wrapper: known({ kind: sandbox.wrapper, platform: sandbox.platform }),
          binarySha256: known(sandbox.binarySha256),
          postureHash: known(sandbox.postureHash),
        }
      : {}),
    step,
    steps: loop.history.map((h) => h.step),
    previousSeq,
    genesisSeq: sandbox?.genesisSeq ?? null,
    genesisPayloadHash:
      !sandboxName && cur?.genesisPayloadHash && HEX64.test(cur.genesisPayloadHash) ? cur.genesisPayloadHash : null,
    postureJson: field(sandbox?.postureJson, "the sandbox recorded the posture's hash but not its bytes"),
    // The derived TOML and the wrapper profile are per-session and uncommitted, and they name the
    // host's binary, step directories, sockets and workspace paths, so they are absent for
    // every reader, whether or not the row kept them. The keys stay so the response keeps its shape;
    // the posture JSON above is what the chain commits by hash, and the page's re-hash needs nothing else.
    postureToml: absent(HOST_PATHS_WITHHELD),
    wrapperProfile: absent(HOST_PATHS_WITHHELD),
    policyDocument: field(sandbox?.policyDocument, "the sandbox did not record the policy document its Genesis hashed"),
    actions: field(sandbox?.actions, "the sandbox recorded no tool calls for this step"),
    replay: field(sandbox?.replay, "the step committed no replay record"),
    // The note is one of the message's parts, so it is shown where the replay record is. A member was
    // handed the step's one read, the same text, so its sandbox shows it too.
    ...(sandbox && cur?.sourcesNote ? { sourcesNote: cur.sourcesNote } : {}),
    // Only a sandboxed step's cost is the proxy's meter; an in-process step's is the runtime's, and
    // naming it the proxy's would say the step crossed a proxy it never did. A member's is its own.
    stepCostMicroUsdc: field(member ? member.costMicroUsdc : cur?.costMicroUsdc, "the step recorded no cost"),
    sandboxes: cur ? sandboxRowsOf(loop, cur) : [],
    selected: member
      ? { kind: "member", label: member.name, sandbox: member.name, agentId: member.agentId }
      : sandboxName
      ? { kind: "member", label: sandboxName, sandbox: sandboxName, agentId: loop.agentId }
      : { kind: "session", label: "session A", sandbox: null, agentId: loop.agentId },
    sources: sourcesFieldOf(sandbox, rawSandboxOf(member ?? cur)),
    irys: sourcesIrysFieldOf(loop, sandbox),
    postureIrys: postureIrysOf(loop, sandbox),
  };
}

/** Every sandbox this console knows, newest loop first; archived loops left out as `/api/loops` does. */
export function readZeroClawSandboxes(filter: { owner?: string | null; archived?: boolean } = {}): ZeroClawView[] {
  return Object.values(readLoops())
    .filter((l) => (filter.archived ? true : !l.archivedAt))
    .filter((l) => (filter.owner ? l.owner === filter.owner : true))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(zeroclawViewOf);
}

/**
 * One sandbox by loop id — archived loops included, so a link into one keeps working — at step `at`,
 * or its last step, described as the member `sandbox` names or as session A. A step the loop never ran is a detail whose `step` is `null`, not a missing loop.
 */
export function readZeroClawSandbox(
  loopId: string,
  at: number | undefined,
  sandbox: string | undefined
): ZeroClawSandboxDetail | null {
  const loop = readLoop(loopId);
  return loop ? zeroclawDetailOf(loop, at, sandbox) : null;
}

// ─── The host ───────────────────────────────────────────────────────────────

/** The file hashed last, by path, size and mtime: a 30 MB binary is not re-read on every GET. */
let hashed: { key: string; sha256: string } | null = null;

function platformOf(p: NodeJS.Platform): { platform: ZeroClawPlatform; wrapper: ZeroClawWrapperKind } | null {
  if (p === "darwin") return { platform: "macos", wrapper: "sandbox-exec" };
  if (p === "linux") return { platform: "linux", wrapper: "bwrap" };
  return null;
}

/**
 * `zeroclaw` on a `PATH` string, found the way `resolveZeroClaw` finds it: the first directory
 * holding a file of that name. A copy, because the runtime keeps its lookup private; the two must
 * agree, or the tab would hash a file the start never spawns.
 */
// The start's own lookup (`resolveZeroClaw`), not a copy, so the tab cannot name a binary the
// start would not spawn.
function zeroclawOnPath(pathEnv: string | undefined): string | undefined {
  return onPath("zeroclaw", pathEnv);
}

/**
 * The one host status the tab reads: the binary a loop start would spawn, that file's
 * `sha256`, and the wrapper this platform would put around it.
 *
 * The binary is found as the start finds it (`resolveZeroClaw`): `LATH_ZEROCLAW_BIN` when set,
 * else `zeroclaw` on this process's `PATH`. Saying an unset variable means no sandbox, while the start
 * resolves one on `PATH` and runs every step in it, would put a false sentence beside those steps'
 * hashes. A binary found on `PATH` is named with where it came from, because which file a `PATH`
 * lookup lands on is not visible anywhere else on the page.
 *
 * It hashes the file and does not run it — not `--version`, not `doctor`. Whether the binary is
 * the Lath build and passes its self-check is the start-time refusal on `/api/loops`; this read
 * only says which bytes are there, so the page can set them beside the hash each step's posture
 * committed.
 */
export function readZeroClawHost(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  // The open routes pass false: a note that names where the binary lives is the host's filesystem
  // layout, and the tab needs only whether it is configured and the hash.
  showPaths = true
): ZeroClawHostView {
  const os = platformOf(platform);
  const base = { wrapper: os?.wrapper ?? null, platform: os?.platform ?? null };
  const set = env.LATH_ZEROCLAW_BIN?.trim();
  const given = set || zeroclawOnPath(env.PATH);
  if (!given) {
    return {
      configured: false,
      binarySha256: null,
      ...base,
      note: "LATH_ZEROCLAW_BIN is not set and no zeroclaw is on this console's PATH, so it cannot run a loop step in a sandbox",
    };
  }
  const abs = path.resolve(given);
  const shown = showPaths ? abs : "a file";
  const where = set
    ? `LATH_ZEROCLAW_BIN names ${shown}`
    : `LATH_ZEROCLAW_BIN is not set; ${showPaths ? abs : "zeroclaw"} is zeroclaw on PATH`;
  try {
    // The start spawns a link's target, so the target's bytes are the ones hashed.
    const real = fs.realpathSync(abs);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error("not a file");
    const key = `${real}:${st.size}:${st.mtimeMs}`;
    if (hashed?.key !== key) {
      hashed = { key, sha256: crypto.createHash("sha256").update(fs.readFileSync(real)).digest("hex") };
    }
    const notes = [
      ...(set ? [] : [`${where}, the binary a loop start runs`]),
      ...(os ? [] : [`this console runs on ${platform}, which has neither wrapper`]),
    ];
    return {
      configured: true,
      binarySha256: hashed.sha256,
      ...base,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  } catch {
    return {
      configured: false,
      binarySha256: null,
      ...base,
      note: `${where}, a file this console cannot read`,
    };
  }
}
