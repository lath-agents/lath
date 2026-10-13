import {
  AppendPolicyRewrite,
  Cell,
  CellOp,
  EpochRecord,
  EventInput,
  EventRecord,
  hex,
  StructHeader,
  StructKind,
} from "@lath/sdk/browser";
import { proveEpochStep } from "./proofs";

/**
 * The verification bundle: everything a third party needs to re-derive this owner's chain
 * **without the chain**, and nothing it cannot check.
 *
 * The page can already show that a head folds and that a step is inside an epoch's root. What it
 * cannot do is let someone else repeat that on their own machine a week later. So the export is
 * the raw material of those computations — record inputs and the head each one produced, epoch
 * bounds and roots and the head each fold produced, and for every epoch whose blob was actually
 * served, its steps with the sibling path that reaches the root the chain committed.
 * `scripts/verify-bundle.ts` replays exactly that, using the same SDK functions the browser used.
 *
 * Two rules the shape enforces:
 *
 * - **Nothing is invented.** An epoch whose blob the gateway did not serve, or whose bytes
 *   rebuilt to a different root, carries no `steps` and its ordinal is listed in `unavailable`.
 *   It is never quietly dropped, because a bundle missing an epoch would look complete and
 *   replay as a gap nobody could explain.
 * - **No bigints, no byte arrays.** JSON has neither, so seqs and timestamps are decimal strings
 *   and every hash is lowercase hex. Pubkeys stay base58, which is how a reader would paste them
 *   into an explorer.
 *
 * **Cell and structure writes are carried too** (`operations`, bundle version 2). They share the
 * owner's operation counter with events (SPEC §12 #6) but leave neither a record nor an epoch, so
 * a bundle without them has a hole in the middle of the fold — and a chain written by this
 * console begins with six of them, so without them every export would replay as FAILED. What goes in
 * is what the two Photon scans behind the Storage panel already read: the structure headers and
 * the live cells, each with the fields its fold hashes over. Nothing off-chain and nothing new is
 * read for this — a cell's `value_slot` is public chain data for anyone with the owner id, and a
 * private-mode structure has a commitment there rather than a value.
 *
 * **Policy rewrites are carried too** (`type: "policy"`, bundle version 3, P-1b). A
 * `set_append_policy` spends a seq and leaves no account of its own — the header is re-created at
 * the same address showing the *new* policy — so a bundle holding only the header as read would
 * fold the structure's creation over a policy it did not have at `createdOpSeq` and replay as
 * FAILED at the next recorded head. The rewrite lives only in its `AppendPolicySet` event, which
 * the exporter reads from transaction history when the headers and cells alone leave a gap (the
 * same rule `LathClient.verifyChain` applies), and the operation carries the policy before and
 * after plus the head the event names. The `struct` operation keeps the header as read; the checker
 * puts the previous policy back itself (`headerFolds`), so what the file says the browser saw and
 * what the checker derives stay two different things.
 *
 * What still cannot be carried, and is reported as a gap rather than invented: compact events
 * (no account at all), and cells that were closed or replaced away (the account is gone, and only
 * the `CellWritten` log in transaction history still names the head). `scripts/verify-bundle.ts`
 * answers **verified with gaps** for those — every check it could run passed, and it lists the
 * seqs it could not derive. `npm run audit` against an RPC is what closes them, because
 * `LathClient.verifyChain({ recover: true })` can read that history and a file cannot.
 */
export const BUNDLE_VERSION = 3;

export interface BundleRecord {
  seq: string;
  timestamp: string;
  kind: number;
  status: number;
  reference: string;
  payloadHash: string;
  head: string;
}

export interface BundleStep {
  seq: string;
  timestamp: string;
  kind: number;
  status: number;
  reference: string;
  payloadHash: string;
  /** `sha256("lattice.epoch.leaf" ‖ seq ‖ input)`. */
  leaf: string;
  /** Sibling hashes from the leaf up to the root, bottom first. */
  proof: string[];
  /** Position in the epoch, which is what the path is indexed by. */
  index: number;
}

export interface BundleEpoch {
  ordinal: number;
  startSeq: string;
  endSeq: string;
  root: string;
  head: string;
  signature: string;
  steps?: BundleStep[];
}

/**
 * A v0.2 write that is neither a record nor an epoch: a structure header, one cell write, or one
 * policy rewrite. It carries the fields its own fold hashes over, so a reader recomputes the head
 * rather than trusting the exporter — `computeStructHead` for a header and a rewrite,
 * `computeCellHead` for a cell.
 */
export interface BundleOperation {
  /**
   * `struct` is `create_struct`; `cell` is `create_cell` / `replace_cell` / `close_cell`; `policy`
   * is `set_append_policy` (bundle version 3).
   */
  type: "struct" | "cell" | "policy";
  seq: string;
  structId: string;
  /** Cell only: the `cell_op` byte the chain folded — 1 create, 2 replace, 3 close. */
  cellOp?: number;
  /**
   * Header only: `struct_kind`, `struct_mode`, `append_policy` and the policy reference, as the
   * account reads today — after any rewrite. Policy only: `appendPolicy` / `policyRef` are what the
   * rewrite set.
   */
  structKind?: number;
  mode?: number;
  consumable?: boolean;
  appendPolicy?: number;
  policyRef?: string;
  /**
   * Policy only: the policy fields the rewrite replaced — what `create_struct` folded, if this is
   * the structure's first rewrite.
   */
  previousPolicy?: number;
  previousPolicyRef?: string;
  /** Cell only: `cell_preimage` minus the owner id, which is the bundle's own `id`. */
  indexOrVersion?: string;
  timestamp?: string;
  tag?: number;
  status?: number;
  keySlot?: string;
  valueSlot?: string;
  /**
   * The head this write produced. A cell stores it in its own account and a policy rewrite's event
   * names it; a structure header stores none at all, so a header can be folded forward but never
   * checked against a recorded value — the same asymmetry `LathClient.verifyChain` lives with.
   */
  head?: string;
}

export interface VerificationBundle {
  version: number;
  cluster: string;
  /** Every owner is an agent; the field stays so a bundle keeps its shape. */
  kind: "agent";
  id: string;
  programId: string;
  addressTree?: string;
  header: { seq: string; head: string; authority: string };
  records: BundleRecord[];
  epochs: BundleEpoch[];
  /** Ordinals of epochs with no steps: the blob was not served, or was not this epoch. */
  unavailable: number[];
  /**
   * Structure, cell and policy writes, ascending by seq. A version 1 bundle carries none of these;
   * a version 2 bundle carries no `policy` rows.
   */
  operations: BundleOperation[];
  /**
   * Did the structure scan answer? `unavailable` means the two Photon scans failed, not that this
   * owner has no cells — an empty `operations` would otherwise read as the second.
   */
  operationsStatus: "scanned" | "unavailable";
  /** What to run on this file, and which verdicts it can give. The bundle explains itself. */
  readme: string[];
  exportedAt: string;
}

/** One epoch as the exporter found it: the chain's row, plus the blob's steps if it had them. */
export interface EpochSource {
  epoch: EpochRecord;
  ordinal: number;
  /** `null` when the trace store served no blob, or served bytes that rebuilt to another root. */
  steps: { seq: bigint; input: EventInput }[] | null;
}

/**
 * The owner's structures as the Storage panel's query already returns them (`useStructures`):
 * headers, and the cells that are still live. `null` when that scan failed or had not run — the
 * bundle then says `operationsStatus: "unavailable"` rather than claiming the owner wrote none.
 */
export interface StructureSource {
  header: StructHeader;
  cells: Cell[];
}

export interface BundleInput {
  cluster: string;
  kind: "agent";
  id: string;
  programId: string;
  addressTree?: string;
  header: { seq: bigint; head: Uint8Array; authority: string };
  records: EventRecord[];
  epochs: EpochSource[];
  structures: StructureSource[] | null;
  /**
   * Every `set_append_policy` in the owner's transaction history (`LathClient.readHistory`
   * `policies`). Optional because reading it is a history walk the exporter makes only when the
   * headers and cells leave a gap — a rewrite always does, and a chain with no gaps has none.
   */
  policies?: readonly AppendPolicyRewrite[];
  /** Injectable so a test gets a stable document. */
  now?: Date;
}

/** The step and whether its path actually reached `root` — the caller drops the epoch if not. */
function toBundleStep(
  startSeq: bigint,
  inputs: EventInput[],
  index: number,
  root: Uint8Array
): { step: BundleStep; verified: boolean } {
  const input = inputs[index];
  const proof = proveEpochStep(startSeq, inputs, index, root);
  const step: BundleStep = {
    seq: proof.seq.toString(),
    timestamp: input.timestamp.toString(),
    kind: input.kind,
    status: input.status,
    reference: hex(input.reference),
    payloadHash: hex(input.payloadHash),
    leaf: proof.leaf,
    proof: proof.path,
    index,
  };
  return { step, verified: proof.verified };
}

/**
 * Which `cell_op` produced a cell that is still live. A `Map` cell past version 0 was written by
 * `replace_cell`, everything else by `create_cell` — the same rule `LathClient.verifyChain`
 * applies, and it is a rule rather than a stored field because the op byte is folded into the
 * head instead of kept in the account.
 */
function cellOpOf(header: StructHeader, cell: Cell): CellOp {
  return header.kind === StructKind.Map && cell.indexOrVersion > 0n ? CellOp.Replace : CellOp.Create;
}

/** Headers, live cells and policy rewrites as `BundleOperation`s, ascending by the seq each one consumed. */
function toOperations(structures: StructureSource[], policies: readonly AppendPolicyRewrite[]): BundleOperation[] {
  const out: BundleOperation[] = [];
  for (const p of policies) {
    out.push({
      type: "policy",
      seq: p.opSeq.toString(),
      structId: hex(p.structId),
      appendPolicy: p.appendPolicy,
      policyRef: hex(p.policyRef),
      previousPolicy: p.previousPolicy,
      previousPolicyRef: hex(p.previousPolicyRef),
      head: hex(p.head),
    });
  }
  for (const { header, cells } of structures) {
    out.push({
      type: "struct",
      seq: header.createdOpSeq.toString(),
      structId: hex(header.structId),
      structKind: header.kind,
      mode: header.mode,
      consumable: header.consumable,
      appendPolicy: header.appendPolicy,
      policyRef: hex(header.policyRef),
    });
    for (const cell of cells) {
      out.push({
        type: "cell",
        seq: cell.opSeq.toString(),
        structId: hex(cell.structId),
        cellOp: cellOpOf(header, cell),
        indexOrVersion: cell.indexOrVersion.toString(),
        timestamp: cell.timestamp.toString(),
        tag: cell.tag,
        status: cell.status,
        keySlot: hex(cell.keySlot),
        valueSlot: hex(cell.valueSlot),
        head: hex(cell.head),
      });
    }
  }
  return out.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
}

/**
 * The two verdicts a reader can get, in the file itself. Said here because the person who runs
 * the checker is not the person who exported it, and "verified with gaps" is a pass they should
 * be able to explain without reading anything else first.
 */
const README: string[] = [
  "Replay this file with: npm run verify:bundle -- <this file>. No network is used.",
  "VERIFIED means every record and epoch head folds from the one before it, every epoch's steps " +
    "rebuild the root the chain committed, and the last fold equals the header's head.",
  "VERIFIED WITH GAPS means all of that held for what is here, but some operations are not in the " +
    "file and their seqs are listed. Compact events leave no account to read, and a cell that was " +
    "closed or replaced away leaves none either, so only an RPC that can read transaction history " +
    "covers them: npm run audit -- <id> --rpc <url> --recover. A structure whose append policy was " +
    "rewritten (set_append_policy) is carried as a policy operation read from that history. It is " +
    "also the verdict for an epoch whose steps the file does not carry (the gateway did not serve " +
    "them): its fold is checked and its steps are not, and the epoch is named, so open its blob " +
    "with npm run audit -- <id> --rpc <url> --gateway <url>.",
  "FAILED means something disagreed: a head that does not fold, a step outside its root, or a " +
    "malformed document. The first bad seq is named.",
  "This file holds only what is already public on chain, plus the epoch steps a trace gateway " +
    "served. It is what one browser read, not a claim by Solana: AgentState.head is.",
];

export function buildBundle(input: BundleInput): VerificationBundle {
  const records = [...input.records]
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    .map((r) => ({
      seq: r.seq.toString(),
      timestamp: r.timestamp.toString(),
      kind: r.kind,
      status: r.status,
      reference: hex(r.reference),
      payloadHash: hex(r.payloadHash),
      head: hex(r.head),
    }));

  const unavailable: number[] = [];
  const epochs = [...input.epochs]
    .sort((a, b) => (a.epoch.startSeq < b.epoch.startSeq ? -1 : a.epoch.startSeq > b.epoch.startSeq ? 1 : 0))
    .map(({ epoch, ordinal, steps }): BundleEpoch => {
      const row: BundleEpoch = {
        ordinal,
        startSeq: epoch.startSeq.toString(),
        endSeq: epoch.endSeq.toString(),
        root: hex(epoch.epochRoot),
        head: hex(epoch.head),
        signature: epoch.signature,
      };
      if (!steps || steps.length === 0) {
        unavailable.push(ordinal);
        return row;
      }
      const inputs = steps.map((s) => s.input);
      const built = inputs.map((_, i) => toBundleStep(epoch.startSeq, inputs, i, epoch.epochRoot));
      // A step whose path does not reach the chain's root is not evidence of anything, and a
      // bundle that carried it would be asking the checker to believe the exporter. Report the
      // epoch as unavailable instead — the same word the missing-blob case uses, and for the
      // same reason: this browser could not show the steps are inside the root. (The trace
      // store already refuses a blob whose root does not match, so this is belt and braces.)
      const complete = built.length === Number(epoch.endSeq - epoch.startSeq) && built.every((b) => b.verified);
      if (!complete) {
        unavailable.push(ordinal);
        return row;
      }
      row.steps = built.map((b) => b.step);
      return row;
    });

  return {
    version: BUNDLE_VERSION,
    cluster: input.cluster,
    kind: input.kind,
    id: input.id,
    programId: input.programId,
    ...(input.addressTree ? { addressTree: input.addressTree } : {}),
    header: {
      seq: input.header.seq.toString(),
      head: hex(input.header.head),
      authority: input.header.authority,
    },
    records,
    epochs,
    unavailable,
    operations: input.structures ? toOperations(input.structures, input.policies ?? []) : [],
    operationsStatus: input.structures ? "scanned" : "unavailable",
    readme: README,
    exportedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Which seqs below the header nothing in the bundle covers — a compact event, or a cell that was
 * closed or replaced away. This is coverage only, not folding: it is what the export button uses
 * to tell the reader which verdict to expect before they run anything. `verify-bundle.ts` finds
 * the same holes for itself while replaying, and its answer is the authoritative one.
 */
export function uncoveredSeqs(bundle: VerificationBundle): bigint[] {
  const spans: { op: bigint; next: bigint }[] = [
    ...bundle.records.map((r) => ({ op: BigInt(r.seq), next: BigInt(r.seq) + 1n })),
    ...bundle.epochs.map((e) => ({ op: BigInt(e.startSeq), next: BigInt(e.endSeq) })),
    ...(bundle.operations ?? []).map((o) => ({ op: BigInt(o.seq), next: BigInt(o.seq) + 1n })),
  ].sort((a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));
  const out: bigint[] = [];
  let expected = 0n;
  for (const span of spans) {
    while (expected < span.op) out.push(expected++);
    if (span.next > expected) expected = span.next;
  }
  const headerSeq = BigInt(bundle.header.seq);
  while (expected < headerSeq) out.push(expected++);
  return out;
}

/** `lath-agent-1f4c….verification.json` — the id is in the name so two exports never collide. */
export function bundleFilename(id: string): string {
  return `lath-agent-${id.slice(0, 12)}.verification.json`;
}
