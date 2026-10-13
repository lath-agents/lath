/**
 * The pure half of `verify-step`'s sandbox line: what a sandboxed step's replay record says, held to
 * the hash its manifest commits and to the posture its Genesis commits.
 *
 * Three questions, each answered _pass_, _fail_ or _unchecked_ with the reason:
 *
 * 1. **replay** — the bytes under the committed `replayHash` re-hash to it and decode as a record
 *    (or, on a synthesizing step, as the two-record fold `[recordA, recordB]`, with B starting in
 *    the workspace A left).
 * 2. **posture** — each record's `postureHash` is `sha256(canonicalJson(policy.sandbox))` of the
 *    policy document the session's Genesis commits through `policy_version_hash`, and each record's
 *    `binarySha256` is the one that posture names.
 * 3. **build** — the posture's `binarySha256` is one this repo publishes (`zeroclaw-builds.ts`). A
 *    build not listed is _unchecked_, never _fail_: the chain does not contradict itself when an
 *    operator runs a build of their own, it only names one nobody can rebuild from these pins.
 *
 * What the three together show is that the step committed to this posture and this build, and that
 * its replay record agrees with the chain. They do not show the process ran inside that posture:
 * the wrapper is the host's, and nothing on the chain witnesses it.
 *
 * The record's shape is `runtime/src/zeroclaw/replay.ts`'s. It is re-stated here rather than
 * imported because the SDK does not depend on the runtime and this file ships in the browser
 * bundle; the hash is what binds the two, so a copy that drifted would fail every record loudly.
 * Pure: `sha256`, `utf8` and `canonicalJson`, no Node built-in.
 */
import { hex, sha256, utf8 } from "./hash";
import { canonicalJson } from "./market";
import { publishedBuild, type ZeroclawBuild } from "./zeroclaw-builds";

/** One replay record as `replay.ts` writes it (`v: 1`). */
export interface StepReplayRecord {
  v: 1;
  binarySha256: string;
  postureHash: string;
  messageHash: string;
  workspacePath: string;
  tz: string;
  locale: string;
  now: string;
  workspaceBefore: string;
  workspaceAfter: string;
  seqs: string[];
  contextWindow?: number;
}

export type SandboxVerdict = "pass" | "fail" | "unchecked";

export interface SandboxCheck {
  verdict: SandboxVerdict;
  detail: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function asRecord(value: unknown): StepReplayRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return null;
  for (const key of ["binarySha256", "postureHash", "messageHash", "workspaceBefore", "workspaceAfter"]) {
    if (typeof r[key] !== "string" || !HEX64.test(r[key] as string)) return null;
  }
  if (!Array.isArray(r.seqs) || r.seqs.some((s) => typeof s !== "string" || !/^(0|[1-9][0-9]*)$/.test(s))) return null;
  return r as unknown as StepReplayRecord;
}

/**
 * The records under a committed `replayHash`, and the replay check's answer. `raw` is what the store
 * returned (`null` when nothing is stored); `encrypted` says the bytes are the owner's ciphertext.
 *
 * A single record is an object; a synthesizing step's fold is an array of two (the shape devnet
 * already carries). Anything else under the hash is a fail, because the hash matching
 * means these are exactly the bytes the step committed — and they are not a record.
 */
export function checkReplayBlob(
  committed: string,
  raw: Uint8Array | null,
  encrypted: boolean
): { check: SandboxCheck; records?: StepReplayRecord[]; folded?: boolean } {
  if (encrypted) {
    return {
      check: {
        verdict: "unchecked",
        detail: "the replay record is encrypted by the agent's owner; pass --trace-key <hex|path> to read it",
      },
    };
  }
  if (!raw) return { check: { verdict: "unchecked", detail: `no blob under ${committed} is available here` } };
  const got = hex(sha256(raw));
  if (got !== committed.toLowerCase()) {
    return { check: { verdict: "fail", detail: `the bytes under ${committed} hash to ${got}` } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return { check: { verdict: "fail", detail: `the bytes under ${committed} are not JSON` } };
  }
  const folded = Array.isArray(parsed);
  const items = folded ? (parsed as unknown[]) : [parsed];
  const records = items.map(asRecord);
  if ((folded && items.length !== 2) || records.some((r) => r === null)) {
    return {
      check: {
        verdict: "fail",
        detail: `the bytes under ${committed} are not a replay record, nor the two-record fold of a synthesizing step`,
      },
    };
  }
  // Canonical form, as `decodeReplayRecord` insists: bytes that re-encode to other bytes would be
  // a record that hashes two ways, and the replayer rebuilds from the values, not the bytes.
  if (canonicalJson(parsed) !== new TextDecoder().decode(raw)) {
    return { check: { verdict: "fail", detail: `the bytes under ${committed} are not in canonical form` } };
  }
  const recs = records as StepReplayRecord[];
  if (folded && recs[1].workspaceBefore !== recs[0].workspaceAfter) {
    return {
      records: recs,
      folded,
      check: {
        verdict: "fail",
        detail:
          `the synthesis started in workspace ${recs[1].workspaceBefore}, not ${recs[0].workspaceAfter}, which is ` +
          "the one the step's first session left",
      },
    };
  }
  return {
    records: recs,
    folded,
    check: {
      verdict: "pass",
      detail: folded
        ? "the two records (session and synthesis) re-hash to the committed replayHash, the second starting where the first ended"
        : "the record re-hashes to the committed replayHash",
    },
  };
}

/** The `sandbox` key of a policy document, and `sha256(canonicalJson(posture))` — `postureHash`. */
export function postureOfPolicy(
  doc: Uint8Array
): { posture: Record<string, unknown>; postureHash: string } | "no-sandbox" | "unreadable" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(doc));
  } catch {
    return "unreadable";
  }
  if (!parsed || typeof parsed !== "object") return "unreadable";
  const sandbox = (parsed as Record<string, unknown>).sandbox;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) return "no-sandbox";
  return {
    posture: sandbox as Record<string, unknown>,
    postureHash: hex(sha256(utf8(canonicalJson(sandbox)))),
  };
}

/**
 * Each record's `postureHash` and `binarySha256` against the posture the session's Genesis commits.
 * `postures[i]` is the posture record `i`'s Genesis resolved to, or the reason it could not be read.
 */
export function checkRecordPostures(
  records: readonly StepReplayRecord[],
  postures: readonly ({ postureHash: string; binarySha256?: string; genesisSeq: string } | { unread: string })[]
): SandboxCheck {
  const unread: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const p = postures[i];
    const r = records[i];
    const which = records.length > 1 ? (i === 0 ? "the session's record" : "the synthesis's record") : "the record";
    if (!p) {
      unread.push("no Genesis was found for it");
      continue;
    }
    if ("unread" in p) {
      unread.push(p.unread);
      continue;
    }
    if (r.postureHash !== p.postureHash) {
      return {
        verdict: "fail",
        detail:
          `${which} names posture ${r.postureHash}, while the policy the Genesis at seq ${p.genesisSeq} commits ` +
          `carries ${p.postureHash}`,
      };
    }
    if (p.binarySha256 !== undefined && r.binarySha256 !== p.binarySha256) {
      return {
        verdict: "fail",
        detail: `${which} names binary ${r.binarySha256}, while its posture names ${p.binarySha256}`,
      };
    }
  }
  if (unread.length) return { verdict: "unchecked", detail: unread[0] };
  const at = postures.map((p) => ("genesisSeq" in p ? p.genesisSeq : "?"));
  return {
    verdict: "pass",
    detail:
      `postureHash ${records[0].postureHash.slice(0, 16)}… is the sandbox key of the policy the Genesis at seq ` +
      `${[...new Set(at)].join(" and ")} commits`,
  };
}

/** The build flag: a binary this repo publishes, or one nobody can rebuild from its pins. */
export function checkBuild(binarySha256: string | undefined): SandboxCheck & { build?: ZeroclawBuild } {
  if (!binarySha256) return { verdict: "unchecked", detail: "no posture or record here names the binary" };
  const build = publishedBuild(binarySha256);
  if (build) return { verdict: "pass", detail: `published build (${build.triple}, ${build.note})`, build };
  return {
    verdict: "unchecked",
    detail: `unknown build ${binarySha256.slice(0, 16)}… — not one this repo publishes`,
  };
}
