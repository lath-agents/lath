/**
 * `ts-node -P ./tsconfig.json scripts/verify-bundle.ts <bundle.json>` — replay a verification
 * bundle offline.
 *
 * The web app's "Export verification" button writes a JSON document holding an owner's records,
 * its cell and structure writes, its epoch commits, and — for every epoch whose blob the trace
 * gateway actually served — the steps inside it with their Merkle paths. This script is the other
 * half: it re-derives all of it from the file alone, with no RPC, no gateway and no network, using
 * the same SDK functions the program and the browser use (`computeHead`, `computeCellHead`,
 * `computeStructHead`, `computeEpochHead`, `computeEpochLeaf`, `epochRootOf`, `verifyEpochProof`).
 *
 * ## The three verdicts
 *
 * A Lath owner has one operation counter and several kinds of write share it: per-event
 * records, epoch commits, structure headers and cell writes (`LathClient.verifyChain`).
 *
 * - **VERIFIED** — every seq below the header is covered by the file, every fold recomputes the
 *   head the write recorded, every epoch's steps rebuild the root the chain committed, and the
 *   last fold equals the header's head. The chain is derived from zero; nothing is taken on trust.
 * - **VERIFIED WITH GAPS** — everything above held for what the file carries, but some seqs are
 *   not in it. Two kinds cannot be: a compact event has no account at all, and a cell that was
 *   closed or replaced away has none either, so only the `CellWritten` log in transaction history
 *   still names the head it produced. The script lists those seqs, takes the next write's head
 *   from the file rather than deriving it, and says so per write. That is a pass with a stated
 *   hole, not a verified chain — `npm run audit -- <id> --rpc <url> --recover` is what closes it,
 *   because `verifyChain({ recover: true })` can read the history a file cannot.
 * - **FAILED** — something disagreed: a head that does not fold, a step outside its root, or a
 *   malformed document. The first bad seq is named and the exit code is 1.
 *
 * Version 1 bundles (exported before cell writes were carried) have no `operations`, so a chain
 * that used any v0.2 structure replays as verified-with-gaps. They are still read, not refused:
 * an old export is evidence about an old chain and must keep answering. Version 2 bundles carry
 * no `policy` operations: a structure whose append policy was rewritten (`set_append_policy`,
 * SPEC §5) then gaps at the rewrite's seq, and its creation fold is over the header as it reads
 * *after* the rewrite, so the next recorded head disagrees — that export really does not hold what
 * the chain folded, and re-exporting is the remedy. Version 3 carries the rewrite with the policy
 * it replaced, and `headerFolds` puts that policy back before folding the creation.
 *
 * A bundle is also not a claim about the chain. It says what one browser read; only the head in
 * an on-chain `AgentState` says what Solana holds. Re-run `npm run audit -- <id>` against
 * an RPC to tie the two together — this script's job is that the bundle is self-consistent and
 * that nobody edited a step after the fact.
 */
import { readFileSync } from "fs";
import {
  AppendPolicy,
  AppendPolicyRewrite,
  Cell,
  CellOp,
  computeCellHead,
  computeEpochHead,
  computeEpochLeaf,
  computeHead,
  computeStructHead,
  epochRootOf,
  EventInput,
  EventKind,
  headerFolds,
  hex,
  StructHeader,
  StructKind,
  StructMode,
  verifyEpochProof,
  ZERO32,
} from "../sdk/src";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ─── The document ───────────────────────────────────────────────────────────

interface BundleStep {
  seq: string;
  timestamp: string;
  kind: number;
  status: number;
  reference: string;
  payloadHash: string;
  leaf: string;
  proof: string[];
  index: number;
}

interface BundleEpoch {
  ordinal: number;
  startSeq: string;
  endSeq: string;
  root: string;
  head: string;
  signature: string;
  steps?: BundleStep[];
}

interface BundleRecord {
  seq: string;
  timestamp: string;
  kind: number;
  status: number;
  reference: string;
  payloadHash: string;
  head: string;
}

/** A structure header, a cell write or a policy rewrite — the writes that share the counter with events. */
interface BundleOperation {
  type: "struct" | "cell" | "policy";
  seq: string;
  structId: string;
  cellOp?: number;
  structKind?: number;
  mode?: number;
  consumable?: boolean;
  appendPolicy?: number;
  policyRef?: string;
  previousPolicy?: number;
  previousPolicyRef?: string;
  indexOrVersion?: string;
  timestamp?: string;
  tag?: number;
  status?: number;
  keySlot?: string;
  valueSlot?: string;
  head?: string;
}

export interface Bundle {
  version: number;
  cluster: string;
  kind: string;
  id: string;
  programId: string;
  addressTree?: string;
  header: { seq: string; head: string; authority: string };
  records: BundleRecord[];
  epochs: BundleEpoch[];
  operations?: BundleOperation[];
  operationsStatus?: "scanned" | "unavailable";
  readme?: string[];
  unavailable?: number[];
  exportedAt: string;
}

/** The highest bundle version this script understands; 1 and 2 are read too, with fewer operations. */
export const MAX_BUNDLE_VERSION = 3;

function b32(field: string, value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${field}: expected 64 hex characters, got ${JSON.stringify(value)}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function big(field: string, value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${field}: expected a decimal string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function u8(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${field}: expected a byte, got ${JSON.stringify(value)}`);
  }
  return value;
}

function u16(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${field}: expected an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A timestamp the program stores as `i64`; the exporter never writes a negative one. */
function i64(field: string, value: unknown): bigint {
  const n = big(field, value);
  if (n > (1n << 63n) - 1n) throw new Error(`${field}: ${n} does not fit an i64`);
  return n;
}

/**
 * The 75 bytes a `log_event` would have carried — the preimage of both a head and a leaf.
 *
 * Every field is checked to the width `computeHead` writes it at, because the encoders wrap rather
 * than refuse: `kind: 257` hashed as 1, `status: 65736` as 200, and a timestamp of `2^64 + t` as
 * `t`, so a bundle edited to say any of them replayed as verified while saying what no chain wrote.
 */
function inputOf(field: string, s: BundleRecord | BundleStep): EventInput {
  return {
    timestamp: i64(`${field}.timestamp`, s.timestamp),
    kind: u8(`${field}.kind`, s.kind) as EventKind,
    status: u16(`${field}.status`, s.status),
    reference: b32(`${field}.reference`, s.reference),
    payloadHash: b32(`${field}.payloadHash`, s.payloadHash),
  };
}

/**
 * The cell as the program hashed it. `ownerId` is the bundle's own id rather than a field of its
 * own: every cell in the file belongs to this owner — that owner-id `memcmp` is how cells are
 * enumerated at all — so carrying it per cell would only be a second place for it to disagree.
 */
function cellOf(field: string, agentId: Uint8Array, o: BundleOperation): Cell {
  return {
    ownerId: agentId,
    structId: b32(`${field}.structId`, o.structId),
    indexOrVersion: big(`${field}.indexOrVersion`, o.indexOrVersion),
    opSeq: big(`${field}.seq`, o.seq),
    timestamp: big(`${field}.timestamp`, o.timestamp),
    tag: u8(`${field}.tag`, o.tag),
    status: u8(`${field}.status`, o.status),
    keySlot: b32(`${field}.keySlot`, o.keySlot),
    valueSlot: b32(`${field}.valueSlot`, o.valueSlot),
    head: b32(`${field}.head`, o.head),
  };
}

function headerOf(field: string, agentId: Uint8Array, o: BundleOperation): StructHeader {
  return {
    ownerId: agentId,
    structId: b32(`${field}.structId`, o.structId),
    kind: u8(`${field}.structKind`, o.structKind) as StructKind,
    mode: u8(`${field}.mode`, o.mode) as StructMode,
    // `lenOrCount` is not in the header's fold preimage (the count changes with every append and
    // the head must not), so the value here is never hashed.
    lenOrCount: 0n,
    createdOpSeq: big(`${field}.seq`, o.seq),
    consumable: o.consumable === true,
    appendPolicy: u8(`${field}.appendPolicy`, o.appendPolicy) as AppendPolicy,
    policyRef: b32(`${field}.policyRef`, o.policyRef),
  };
}

/** One `set_append_policy` as the bundle carries it: the fields `headerFolds` rebuilds the header from. */
function rewriteOf(field: string, o: BundleOperation): AppendPolicyRewrite {
  return {
    opSeq: big(`${field}.seq`, o.seq),
    structId: b32(`${field}.structId`, o.structId),
    previousPolicy: u8(`${field}.previousPolicy`, o.previousPolicy) as AppendPolicy,
    previousPolicyRef: b32(`${field}.previousPolicyRef`, o.previousPolicyRef),
    appendPolicy: u8(`${field}.appendPolicy`, o.appendPolicy) as AppendPolicy,
    policyRef: b32(`${field}.policyRef`, o.policyRef),
    head: b32(`${field}.head`, o.head),
  };
}

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

/** Consecutive seqs as ranges: `0–5, 12, 14`. */
export function seqRanges(seqs: bigint[]): string {
  const ranges: [bigint, bigint][] = [];
  for (const seq of seqs) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1n === seq) last[1] = seq;
    else ranges.push([seq, seq]);
  }
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}

// ─── The replay ─────────────────────────────────────────────────────────────

/** One write in the owner's operation stream: it occupies `[op, next)` and produced `head`. */
interface Write {
  op: bigint;
  next: bigint;
  label: string;
  /** Absent for a structure header, which stores no head: it can be folded, never compared. */
  head?: Uint8Array;
  fold: (prev: Uint8Array) => Uint8Array;
}

export type Verdict = "verified" | "verified-with-gaps" | "failed";

/** One printed line. `ok` is `true`/`false` for a check, `null` for a note or a heading. */
export interface Line {
  ok: boolean | null;
  text: string;
}

export interface Replay {
  lines: Line[];
  verdict: Verdict;
  /** Checks that disagreed. Gaps are not failures and are not counted here. */
  failures: number;
  /** Seqs below the header that no row in the file covers. */
  missingSeqs: bigint[];
  /** Ordinals of epochs the file carries no steps for: their fold is checked, their steps are not. */
  steplessEpochs: number[];
  firstBadSeq?: bigint;
  /** The last line, already worded: what the caller prints as the verdict. */
  summary: string;
}

/**
 * Replays a parsed bundle and returns every line it would print plus the verdict. Pure, so
 * `tests/bundle.ts` asserts on the verdict of a document it built rather than on stdout.
 */
export function replayBundle(bundle: Bundle): Replay {
  const lines: Line[] = [];
  let failures = 0;
  let firstBadSeq: bigint | undefined;
  /** A step whose leaf or path is wrong is a bad seq too, found before the replay reaches it. */
  let firstBadStepSeq: bigint | undefined;
  const missingSeqs: bigint[] = [];
  const steplessEpochs: number[] = [];
  const check = (pass: boolean, text: string) => {
    lines.push({ ok: pass, text });
    if (!pass) failures++;
  };
  const note = (text: string) => lines.push({ ok: null, text });
  const blank = () => lines.push({ ok: null, text: "" });

  const agentId = b32("id", bundle.id);
  const headerSeq = big("header.seq", bundle.header.seq);
  const headerHead = b32("header.head", bundle.header.head);
  const operations = bundle.operations ?? [];

  note(
    `${bundle.kind} ${short(bundle.id)} on ${bundle.cluster} — ${bundle.records.length} record(s), ` +
      `${operations.length} cell/structure write(s), ${bundle.epochs.length} epoch(s), header at seq ${headerSeq}`
  );
  note(dim(`exported ${bundle.exportedAt} · authority ${bundle.header.authority}`));
  if (bundle.version < 2) {
    // Said out loud because it changes which verdict is achievable: a version 1 file carries no
    // cell writes at all, so any chain that used a structure gaps there and nothing is wrong.
    note(
      dim(
        `bundle version ${bundle.version}: exported before cell and structure writes were carried, ` +
          `so any of those seqs will read as a gap`
      )
    );
  } else if (bundle.version < MAX_BUNDLE_VERSION) {
    // A version 2 file of a chain whose header was never rewritten replays exactly as before. One
    // with a rewrite cannot pass: the rewrite's seq is a gap and the header it carries shows the
    // policy after it, so the creation fold is wrong and the next recorded head says so.
    note(
      dim(
        `bundle version ${bundle.version}: exported before policy rewrites (set_append_policy) were carried; ` +
          `a chain with one gaps at its seq and fails at the next head — re-export it`
      )
    );
  }
  if (bundle.operationsStatus === "unavailable") {
    note(`the exporter's structure scan did not answer, so no cell or structure write is in this file`);
  }
  blank();

  // ── Epoch blobs: are the steps in the bundle really the leaves of the root it names? ──
  for (const e of bundle.epochs) {
    const label = `epoch #${e.ordinal} (seq ${e.startSeq}–${(big("endSeq", e.endSeq) - 1n).toString()})`;
    const startSeq = big(`${label}.startSeq`, e.startSeq);
    const endSeq = big(`${label}.endSeq`, e.endSeq);
    const root = b32(`${label}.root`, e.root);
    if (!e.steps) {
      // Not a failure: the exporter could not reach the blob and said so rather than inventing
      // it. The epoch still folds into the chain below; only its steps go unchecked — and that is a
      // gap in what the file proves, so it holds the verdict at verified-with-gaps. VERIFIED says
      // every epoch's steps rebuild the root, and the file's own readme says so to its reader.
      note(`${label}: no steps in the bundle — the fold is checked below, the ${endSeq - startSeq} steps are not`);
      steplessEpochs.push(e.ordinal);
      continue;
    }
    const inputs = e.steps.map((s, i) => inputOf(`${label}.steps[${i}]`, s));
    check(
      BigInt(inputs.length) === endSeq - startSeq,
      `${label}: ${inputs.length} step(s) for the ${endSeq - startSeq} seq(s) it covers`
    );
    // The strongest single check available offline: the steps as given rebuild the root the
    // chain folded. A step edited after export changes a leaf and this stops matching.
    check(hex(epochRootOf(startSeq, inputs)) === e.root, `${label}: steps rebuild the committed root ${short(e.root)}`);

    // Per step rather than per epoch: an epoch is up to a thousand leaves, and a line each
    // would bury the answer. The counts plus the first seq that failed say the same thing.
    let leavesOk = 0;
    let proofsOk = 0;
    let firstBadLeaf: bigint | undefined;
    let firstBadProof: bigint | undefined;
    for (let i = 0; i < e.steps.length; i++) {
      const s = e.steps[i];
      const seq = big(`${label}.steps[${i}].seq`, s.seq);
      const leaf = computeEpochLeaf(seq, inputs[i]);
      if (seq === startSeq + BigInt(s.index) && hex(leaf) === s.leaf) leavesOk++;
      else if (firstBadLeaf === undefined) firstBadLeaf = seq;
      const path = s.proof.map((p, j) => b32(`${label}.steps[${i}].proof[${j}]`, p));
      if (verifyEpochProof(root, leaf, path, s.index)) proofsOk++;
      else if (firstBadProof === undefined) firstBadProof = seq;
    }
    const at = (seq: bigint | undefined) => (seq === undefined ? "" : ` (first bad seq ${seq})`);
    check(
      leavesOk === e.steps.length,
      `${label}: ${leavesOk}/${e.steps.length} leaves recompute from their step${at(firstBadLeaf)}`
    );
    check(
      proofsOk === e.steps.length,
      `${label}: ${proofsOk}/${e.steps.length} inclusion proof(s) reach the committed root${at(firstBadProof)}`
    );
    for (const seq of [firstBadLeaf, firstBadProof]) {
      if (seq !== undefined && (firstBadStepSeq === undefined || seq < firstBadStepSeq)) firstBadStepSeq = seq;
    }
  }
  if (bundle.unavailable?.length) {
    note(`epochs with no blob in this bundle: ${bundle.unavailable.map((o) => `#${o}`).join(", ")}`);
  }
  blank();

  // ── The chain: records, cell writes and epochs interleave by seq, each fold taking the head
  //    before it. This is `verifyChain`'s one ordered stream, rebuilt from a file. ──
  // Policy rewrites first: a structure's folds depend on every rewrite the file holds for it.
  const rewrites = operations.flatMap((o, i) => (o.type === "policy" ? [rewriteOf(`operations[${i}]`, o)] : []));
  const writes: Write[] = [
    ...bundle.records.map((r, i): Write => {
      const seq = big(`records[${i}].seq`, r.seq);
      const input = inputOf(`records[${i}]`, r);
      return {
        op: seq,
        next: seq + 1n,
        label: `seq ${seq} record`,
        head: b32(`records[${i}].head`, r.head),
        fold: (prev) => computeHead(prev, agentId, seq, input),
      };
    }),
    ...operations.flatMap((o, i): Write[] => {
      const field = `operations[${i}]`;
      const seq = big(`${field}.seq`, o.seq);
      if (o.type === "struct") {
        const header = headerOf(field, agentId, o);
        // The header as the browser read it, plus every rewrite the file carries for it, through
        // the same `headerFolds` `verifyChain` uses: the creation fold at `seq` over the header as
        // `create_struct` wrote it — the earliest rewrite's previous policy put back — then one
        // fold per rewrite at its own seq, checked against the head its event named. With no
        // rewrite this is one creation fold over the header as given, as it always was.
        return headerFolds(header, rewrites).map((f) =>
          f.op === CellOp.CreateStruct
            ? {
                op: f.opSeq,
                next: f.opSeq + 1n,
                label: `seq ${f.opSeq} structure ${short(hex(header.structId))}`,
                // No `head`: `create_struct` leaves the produced head in no account, so the fold goes
                // forward and the next write is what checks it.
                fold: (prev) => computeStructHead(prev, f.header, f.opSeq, f.op),
              }
            : {
                op: f.opSeq,
                next: f.opSeq + 1n,
                label: `seq ${f.opSeq} policy rewrite ${short(hex(header.structId))}`,
                head: f.head,
                fold: (prev) => computeStructHead(prev, f.header, f.opSeq, f.op),
              }
        );
      }
      // A rewrite's own row is folded with its structure above, which has the header fields the
      // fold needs; a rewrite whose structure the file does not carry is a seq nobody can fold,
      // and it is left to read as a gap rather than taken on its own word.
      if (o.type === "policy") return [];
      if (o.type !== "cell")
        throw new Error(`${field}.type: expected "struct", "cell" or "policy", got ${JSON.stringify(o.type)}`);
      const cell = cellOf(field, agentId, o);
      const op = u8(`${field}.cellOp`, o.cellOp);
      if (op !== CellOp.Create && op !== CellOp.Replace && op !== CellOp.Close) {
        throw new Error(`${field}.cellOp: expected 1, 2 or 3, got ${op}`);
      }
      const verb = op === CellOp.Create ? "cell" : op === CellOp.Replace ? "cell replace" : "cell close";
      return [
        {
          op: seq,
          next: seq + 1n,
          label: `seq ${seq} ${verb} ${short(hex(cell.structId))}`,
          head: cell.head,
          fold: (prev) => computeCellHead(prev, op as CellOp, cell),
        },
      ];
    }),
    ...bundle.epochs.map((e, i): Write => {
      const startSeq = big(`epochs[${i}].startSeq`, e.startSeq);
      const endSeq = big(`epochs[${i}].endSeq`, e.endSeq);
      const root = b32(`epochs[${i}].root`, e.root);
      return {
        op: startSeq,
        next: endSeq,
        label: `seq ${startSeq}–${endSeq - 1n} epoch #${e.ordinal}`,
        head: b32(`epochs[${i}].head`, e.head),
        fold: (prev) => computeEpochHead(prev, agentId, root, startSeq, endSeq),
      };
    }),
  ].sort((a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));

  // `null` once a hole has been crossed: the head before the next write is unknown, so the
  // next fold has no input and the link cannot be derived, only read.
  let prev: Uint8Array | null = ZERO32;
  let expected = 0n;
  /** A gap is not a disagreement: nothing in the file contradicts anything. It is a note and a
   * listed seq, and it is what separates verified-with-gaps from FAILED. */
  const gap = (upTo: bigint, why: string) => {
    const size = upTo - expected;
    while (expected < upTo) missingSeqs.push(expected++);
    note(`gap of ${size} operation${size === 1n ? "" : "s"} before seq ${upTo} — ${why}`);
    prev = null;
  };
  /** Why a seq can be missing at all, given what this particular document carries. */
  const whyMissing =
    bundle.version < 2 || bundle.operationsStatus === "unavailable"
      ? "a compact event, a closed cell, or any cell write — this file carries none of them"
      : bundle.version < MAX_BUNDLE_VERSION
      ? "a compact event, a cell closed or replaced away, or a policy rewrite — this file carries no rewrites"
      : "a compact event, or a cell closed or replaced away: no account holds its head";
  for (const w of writes) {
    if (w.op > expected) {
      gap(w.op, whyMissing);
    } else if (w.op < expected) {
      check(false, `${w.label} overlaps the write that ends at seq ${expected}: the bundle is malformed`);
      prev = null;
    }
    const produced: Uint8Array | null = prev === null ? null : w.fold(prev);
    if (produced === null) {
      note(
        `${w.label}: head ${w.head ? short(hex(w.head)) : "not recorded"} taken from the bundle — ` +
          `nothing before it to fold from`
      );
    } else {
      if (w.head) {
        const ok = hex(produced) === hex(w.head);
        check(ok, `${w.label}: head ${short(hex(w.head))}${ok ? "" : ` ≠ folded ${short(hex(produced))}`}`);
        if (!ok && firstBadSeq === undefined) firstBadSeq = w.op;
      } else {
        // A structure header records no head, so there is nothing to disagree with here — the
        // fold carries on and the next write's recorded head is what proves this one.
        note(`${w.label}: folded to ${short(hex(produced))}, which the next write checks`);
      }
    }
    // Continue from the *recorded* head where there is one, not the folded one: each link is then
    // checked against its own stated predecessor, so an edited head shows up as the two links it
    // actually breaks — the one that produced it and the one that consumes it — and not as every
    // link after it. A structure header has none, so its folded value carries.
    prev = w.head ?? produced;
    expected = w.next;
  }

  if (expected < headerSeq) {
    gap(headerSeq, `the header's seq is past the last write in the bundle — ${whyMissing}`);
  } else if (expected > headerSeq) {
    check(false, `the bundle holds writes up to seq ${expected}, past the header's seq ${headerSeq}`);
  } else if (prev !== null) {
    const ok = hex(prev) === hex(headerHead);
    check(ok, `header: head after ${headerSeq} operation(s) is ${short(bundle.header.head)}`);
    if (!ok && firstBadSeq === undefined) firstBadSeq = headerSeq > 0n ? headerSeq - 1n : 0n;
  } else {
    note(`header: head ${short(bundle.header.head)} not derived — the last gap runs to the tail`);
  }

  blank();
  const bad = firstBadSeq ?? firstBadStepSeq;
  let verdict: Verdict;
  let summary: string;
  if (failures > 0) {
    verdict = "failed";
    summary = red(
      bad !== undefined
        ? `FAILED — first bad seq ${bad} (${failures} check(s) failed)`
        : `FAILED — ${failures} check(s) failed`
    );
  } else if (missingSeqs.length > 0 || steplessEpochs.length > 0) {
    verdict = "verified-with-gaps";
    const missing = missingSeqs.length
      ? ` ${missingSeqs.length} operation(s) are not in it: seq ${seqRanges(missingSeqs)} — ${whyMissing}. ` +
        `Their heads live only in transaction history, so run ` +
        `\`npm run audit -- ${bundle.id} --rpc <url> --recover\` to cover them.`
      : "";
    const stepless = steplessEpochs.length
      ? ` ${steplessEpochs.length} epoch(s) carry no steps (${steplessEpochs.map((o) => `#${o}`).join(", ")}): ` +
        `the fold is checked and the steps inside are not, so run ` +
        `\`npm run audit -- ${bundle.id} --rpc <url> --gateway <url>\` to open the blob.`
      : "";
    summary = yellow(
      `VERIFIED WITH GAPS — every check passed for what this file carries ` +
        `(${bundle.records.length} record(s), ${operations.length} cell/structure write(s), ` +
        `${bundle.epochs.length} epoch(s)).${missing}${stepless}`
    );
  } else {
    verdict = "verified";
    summary = green(
      `VERIFIED — ${bundle.records.length} record(s), ${operations.length} cell/structure write(s) and ` +
        `${bundle.epochs.length} epoch(s) replay from zero to the header's head`
    );
  }
  // The verdict is not one of the checks and carries its own colour, so it is `summary` alone and
  // not a line with a ✔ or ✘ in front of it.
  return { lines, verdict, failures, missingSeqs, steplessEpochs, firstBadSeq: bad, summary };
}

export function main(argv = process.argv): number {
  const path = argv[2];
  if (!path) {
    console.error("usage: ts-node -P ./tsconfig.json scripts/verify-bundle.ts <bundle.json>");
    return 2;
  }
  const bundle: Bundle = JSON.parse(readFileSync(path, "utf8"));
  if (!Number.isInteger(bundle.version) || bundle.version < 1 || bundle.version > MAX_BUNDLE_VERSION) {
    console.error(`bundle version ${bundle.version} is not one this script reads (expected 1–${MAX_BUNDLE_VERSION})`);
    return 2;
  }
  const replay = replayBundle(bundle);
  for (const line of replay.lines) {
    if (line.text === "") console.log("");
    else if (line.ok === null) console.log(`${yellow("●")} ${line.text}`);
    else console.log(`${line.ok ? green("✔") : red("✘")} ${line.text}`);
  }
  console.log(replay.summary);
  // Verified-with-gaps exits 0: nothing in the file disagreed with anything else, and the seqs it
  // could not derive and the epochs whose steps it could not check are named in the verdict. A non-zero exit would make every export of an
  // ordinary agent look broken, which a gap is not.
  return replay.verdict === "failed" ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(red(`✘ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(2);
  }
}
