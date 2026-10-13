/**
 * The loop-receipt audit, run on a loop whose policy commits a `receipt` pointer and on no other, so a
 * chain without one has nothing checked here.
 *
 * A receipt is the console's claim about a loop, signed by its runtime key and published on the Solana
 * Attestation Service when Jev's goal check answered `achieved`. It is an index, not a proof: it points
 * at the loop's records, and this checks that what it points at is there. Per loop, the receipt's address
 * is derived from the committed pointer and the loop id, the account is read, and:
 *
 * 1. `account` — it is owned by SAS, decodes as an attestation, and its credential, schema and nonce are
 *    the pointer's and `loopReceiptNonce(loopId)`, its signer the pointer's signer;
 * 2. `data` — its data decodes as a `LoopReceipt`;
 * 3. `subject` — its `agent` is the audited agent and its `loop` this loop;
 * 4. `position` — a `loop.step` record of this loop sits at its `seq`, it is the loop's last, and its
 *    leaf (`result_hash`) is `loopStepLeaf(agent, seq, head)` — the head the receipt names is the one the
 *    record committed. Where the chain's own head before that record was read (`priorHeads`, from
 *    `listSteps`), it must be the receipt's head too;
 * 5. `reached` — that record's status is `GoalReached` (201): the console publishes only on `achieved`,
 *    and the runner writes 201 on exactly the step whose goal check stopped the loop;
 * 6. `steps` — its `steps` is the step number that record's manifest commits. The runner sets the
 *    snapshot's `steps = step` at each step's close, failed steps included, so the last manifest's
 *    `step` is what the receipt carries, and a count of `loop.step` records would undercount a loop
 *    with a step that never closed;
 * 7. `goal` — its `goal` is the `goalHash` every readable manifest of the loop commits.
 *
 * Each is `ok`, `unchecked` (a reader that did not answer, a record not readable here) or `failed`
 * (a contradiction). The money fields — `usdcCharged`, `tempoSpent`, `tempoPayer` — are reported as the
 * console wrote them and are not re-derived: they carry no status.
 *
 * A loop whose receipt is committed and not published is `unchecked`, unless the chain says none is
 * due: its last `loop.step` reads and does not record the goal reached (a loop stopped by hand, by
 * budget, by an error, or still running), which is `not-due` and counts as nothing checked.
 *
 * What it does not check: that the chain's records replay to the agent's head (the chain audit does
 * that, and holds every leaf to it), that Jev's goal-check blob answered `achieved` (the status code is
 * the record's word, and `verify-step` reads the blob), or the money fields. The receipt's signer is the
 * one the policy commits; who that key belongs to is the console's word.
 *
 * Browser-safe: no Anchor, no Node built-in. The account reader is an interface; the CLI's
 * implementation (`cli.ts`) is the one that holds a `Connection`.
 */
import { EventKind } from "../events";
import { hex, idFromString, toBytes32 } from "../hash";
import { LOOP_STEP_TOOL, LoopStepStatus, loopStepLeaf, type LoopStepManifest } from "../loops";
import {
  decodeLoopReceipt,
  decodeSasAttestationAccount,
  LOOP_RECEIPT_PROGRAM_ID,
  loopReceiptAddress,
  loopReceiptNonce,
  type LoopReceipt,
  type LoopReceiptPointer,
  validateLoopReceiptPointer,
} from "../receipt";
import type { TraceStore } from "../trace-store";
import { type InferenceRecord, blobAt, genesisPolicyVersionHash, openSessionAt, payloadLeaf, statusOf } from "./core";
import type { PluginCheckStatus } from "./solana";
import { manifestOf } from "./shared";

/**
 * Reads one account: `null` when the cluster has none, a throw when it cannot be asked (which makes
 * the receipt `unchecked`). The CLI's implementation calls `getAccountInfo` at `confirmed`.
 */
export interface ReceiptAccountReader {
  getAccountInfo(address: string): Promise<{ owner: string; data: Uint8Array } | null>;
}

/** A loop's receipt status: a check's three, and `not-due` for a loop the chain says got none. */
export type ReceiptStatus = PluginCheckStatus | "not-due";

export type ReceiptCheckName = "account" | "data" | "subject" | "position" | "reached" | "steps" | "goal";

export interface ReceiptCheck {
  name: ReceiptCheckName;
  status: PluginCheckStatus;
  /** `<short> — <why>`, as every check's detail is written. */
  detail: string;
}

/** One loop's receipt, as `verify-receipt` reports it. */
export interface ReceiptReport {
  loopId: string;
  status: ReceiptStatus;
  /** The pointer the policy commits, when it is one. */
  pointer?: LoopReceiptPointer;
  /** Where the receipt is, derived from the pointer and the loop id. */
  address?: string;
  /** The receipt's data, decoded, when the account held one. */
  receipt?: LoopReceipt;
  /** The checks that ran, in order. A check that could not start (no account, no data) is absent. */
  checks: ReceiptCheck[];
  /** Why the loop is not `ok` when one reason covers it (no account, a pointer that is not one). */
  detail?: string;
}

/** What the receipt audit reads. */
export interface ReceiptReads {
  /** The trace store: the manifests, the payload preimages and the policy documents. */
  store?: TraceStore;
  /** The Solana account reader. Absent, every committed receipt is `unchecked`. */
  accounts?: ReceiptAccountReader;
  /**
   * Why a record strictly between two seqs may be missing from `records` (`blindBetween`), or
   * `undefined` when that window is all here. Absent, `records` is taken as the whole chain.
   */
  blind?: (from: bigint, want: bigint) => string | undefined;
  /**
   * The chain's head before each `loop.step` record (`LoopStep.priorHead` from `listSteps`), hex,
   * keyed by the record's seq; `null` where that head is not readable. Absent, or a seq missing from it,
   * the record's leaf is what binds the receipt's head, and the chain audit is what binds the leaf.
   */
  priorHeads?: ReadonlyMap<string, string | null>;
}

/** Every loop on the chain whose policy commits a receipt, and what could not be read. */
export interface ReceiptsResult {
  loops: ReceiptReport[];
  /** Why a loop's receipt, or whether it commits one, could not be read here. */
  unread: string[];
}

const RANK: Record<PluginCheckStatus, number> = { ok: 0, unchecked: 1, failed: 2 };

function worst(statuses: readonly PluginCheckStatus[]): PluginCheckStatus {
  return statuses.reduce<PluginCheckStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), "ok");
}

function check(name: ReceiptCheckName, status: PluginCheckStatus, why: string): ReceiptCheck {
  const mark = status === "ok" ? "✓" : status === "failed" ? "✗" : "?";
  return { name, status, detail: `${name} ${mark} — ${why}` };
}

function messageOf(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e);
}

const short = (h: string) => (h.length > 12 ? `${h.slice(0, 8)}…` : h);
const normHash = (h: string | undefined) => (h ?? "").replace(/^0x/i, "").toLowerCase();
/** Past every seq a chain can reach: the window `(from, END)` is the rest of the chain. */
const END = BigInt("18446744073709551616");

/** A `loop.step` record and its manifest. */
interface StepEntry {
  rec: InferenceRecord;
  manifest: LoopStepManifest;
}

/**
 * The policy the step's session ran under: the last Genesis before the checkpoint names its
 * `policy_version_hash`, and the store holds the document under it. `"unread"` when any of that is not
 * here, which is never the same answer as a policy without a receipt.
 *
 * When that last Genesis opens a session that is not the step's own (`${loopId}:step-<n>`, or its
 * `:synthesis`) — a chat on the agent (`/api/run`) that opened while the step ran — the step's session A
 * Genesis after the previous checkpoint is read instead, so the step is held to its own policy rather
 * than the chat's. On every chain where the last Genesis is the step's, or where the step's own is
 * not found, the answer is the last Genesis's policy.
 */
async function policyAt(
  records: readonly InferenceRecord[],
  want: bigint,
  store: TraceStore | undefined,
  step?: { from: bigint; manifest: LoopStepManifest }
): Promise<Record<string, any> | "unread"> {
  const genesis = [...records].reverse().find((r) => r.seq < want && r.kind === EventKind.Genesis);
  if (!genesis) return "unread";
  try {
    let preimage = await blobAt(store, genesis.payloadHash);
    if (preimage && step) {
      const idA = hex(idFromString(`${step.manifest.loopId}:step-${step.manifest.step}`));
      const idB = hex(idFromString(`${step.manifest.loopId}:step-${step.manifest.step}:synthesis`));
      const id = hex(preimage.slice(1, 33));
      if (id !== idA && id !== idB) {
        for (const r of [...records].reverse()) {
          if (r.seq >= genesis.seq || r.seq <= step.from || r.kind !== EventKind.Genesis) continue;
          const own = await blobAt(store, r.payloadHash).catch(() => null);
          if (own && own[0] === EventKind.Genesis && hex(own.slice(1, 33)) === idA) {
            preimage = own;
            break;
          }
        }
      }
    }
    const pvh = preimage ? genesisPolicyVersionHash(preimage[0], preimage.slice(1)) : null;
    const doc = pvh ? await blobAt(store, pvh) : null;
    const parsed = doc ? JSON.parse(new TextDecoder().decode(doc)) : null;
    return parsed && typeof parsed === "object" ? parsed : "unread";
  } catch {
    return "unread";
  }
}

/**
 * `verify-receipt`'s walk: every loop on the chain whose last step's policy commits `receipt` (or the
 * one `only` names), its receipt read and held to the loop's records. A loop whose policy commits none
 * is not reported. Never throws: a reader that did not answer is `unchecked`, with why.
 */
export async function verifyReceiptLoops(
  agentId: Uint8Array,
  records: readonly InferenceRecord[],
  reads: ReceiptReads,
  only?: string
): Promise<ReceiptsResult> {
  const store = reads.store;
  const stepTool = hex(idFromString(LOOP_STEP_TOOL));
  const loops = new Map<string, StepEntry[]>();
  const unreadManifests: { seq: bigint; why: string }[] = [];
  // Every `loop.step` checkpoint of any loop, in chain order: `policyAt` reads a step's policy from the
  // Genesis after the previous one, whichever loop it was.
  const checkpoints: bigint[] = [];
  for (const rec of records) {
    await openSessionAt(store, rec);
    if (rec.kind !== EventKind.Action || hex(rec.reference) !== stepTool) continue;
    checkpoints.push(rec.seq);
    const manifest = await manifestOf(store, rec).catch(() => null);
    if (!manifest) {
      unreadManifests.push({
        seq: rec.seq,
        why: `the ${LOOP_STEP_TOOL} manifest at seq ${rec.seq} is not readable here`,
      });
      continue;
    }
    if (only && manifest.loopId !== only) continue;
    loops.set(manifest.loopId, [...(loops.get(manifest.loopId) ?? []), { rec, manifest }]);
  }

  const out: ReceiptReport[] = [];
  const unread: string[] = [];
  for (const [loopId, entries] of loops) {
    const last = entries[entries.length - 1];
    const from = [...checkpoints].reverse().find((s) => s < last.rec.seq) ?? -1n;
    let policy: Record<string, any> | "unread";
    try {
      policy = await policyAt(records, last.rec.seq, store, { from, manifest: last.manifest });
    } catch {
      policy = "unread";
    }
    if (policy === "unread") {
      unread.push(
        `${loopId}: the policy its last step ran under is not readable here, so whether it commits a receipt cannot be read`
      );
      continue;
    }
    if (policy.receipt === undefined) {
      // The Genesis `policyAt` found may be an earlier session's when the step's own sits in an epoch
      // not opened here: a policy without a receipt is the answer only when nothing between is hidden.
      const hidden = reads.blind?.(from, last.rec.seq);
      if (hidden) unread.push(`${loopId}: whether its policy commits a receipt cannot be read: ${hidden}`);
      continue;
    }
    out.push(await receiptOfLoop(agentId, loopId, policy.receipt, entries, records, reads, unreadManifests));
  }
  // A manifest that did not read may be a loop with a receipt, so it is said rather than skipped.
  return { loops: out, unread: [...unreadManifests.map((u) => u.why), ...unread] };
}

async function receiptOfLoop(
  agentId: Uint8Array,
  loopId: string,
  committed: unknown,
  entries: StepEntry[],
  records: readonly InferenceRecord[],
  reads: ReceiptReads,
  unreadManifests: { seq: bigint; why: string }[]
): Promise<ReceiptReport> {
  const valid = validateLoopReceiptPointer(committed);
  if ("reason" in valid) {
    return {
      loopId,
      status: "failed",
      checks: [],
      detail: `the policy commits a receipt that is not a pointer (${valid.reason}), so nothing can be looked for`,
    };
  }
  const pointer = valid.pointer;
  const address = loopReceiptAddress(pointer, loopId);
  const base = { loopId, pointer, address };
  const last = entries[entries.length - 1];
  // Whether a later step of this loop may exist and not be here: an epoch not opened after the last
  // step seen, or a manifest after it that did not read (it may be this loop's).
  const later = [
    reads.blind?.(last.rec.seq, END),
    ...unreadManifests.filter((u) => u.seq > last.rec.seq).map((u) => u.why),
  ].filter((x): x is string => !!x);

  if (!reads.accounts) {
    return {
      ...base,
      status: "unchecked",
      checks: [],
      detail: "no Solana reader was given, so the receipt was not read",
    };
  }
  let info: { owner: string; data: Uint8Array } | null;
  try {
    info = await reads.accounts.getAccountInfo(address);
  } catch (e) {
    return {
      ...base,
      status: "unchecked",
      checks: [],
      detail: `the receipt's account could not be read: ${messageOf(e)}`,
    };
  }

  if (!info) {
    // No receipt. Due only when the loop's last step recorded the goal reached; a loop that stopped any
    // other way, or is still running, gets none.
    const status = later.length ? undefined : await statusOf(reads.store, last.rec).catch(() => undefined);
    if (status !== undefined && status !== LoopStepStatus.GoalReached) {
      return {
        ...base,
        status: "not-due",
        checks: [],
        detail:
          `no receipt is due: the loop's last ${LOOP_STEP_TOOL} (step ${last.manifest.step}, seq ${last.rec.seq}) ` +
          `records status ${status}, not the goal reached, and a receipt is published only when Jev answers achieved`,
      };
    }
    const why =
      status === LoopStepStatus.GoalReached
        ? `the loop's last ${LOOP_STEP_TOOL} (step ${last.manifest.step}, seq ${last.rec.seq}) records the goal reached`
        : later.length
        ? `whether the loop ended on its goal cannot be read: ${later.join("; ")}`
        : `the status of the loop's last ${LOOP_STEP_TOOL} is not readable here`;
    return {
      ...base,
      status: "unchecked",
      checks: [],
      detail: `committed, not published: there is no account at the receipt's address; ${why}`,
    };
  }

  const checks: ReceiptCheck[] = [];
  const done = (receipt?: LoopReceipt): ReceiptReport => {
    const status = worst(checks.map((c) => c.status));
    return { ...base, ...(receipt ? { receipt } : {}), status, checks };
  };

  // 1. The account: SAS's, an attestation, and at the pointer's credential, schema and nonce, signed by its signer.
  if (info.owner !== LOOP_RECEIPT_PROGRAM_ID) {
    checks.push(check("account", "failed", `the account is owned by ${info.owner}, not the SAS program`));
    return done();
  }
  const att = decodeSasAttestationAccount(info.data);
  if (!att) {
    checks.push(check("account", "failed", "the account does not decode as an SAS attestation"));
    return done();
  }
  const nonce = loopReceiptNonce(loopId);
  const wrong = [
    att.credential !== pointer.credential
      ? `its credential is ${att.credential}, the policy commits ${pointer.credential}`
      : "",
    att.schema !== pointer.schema ? `its schema is ${att.schema}, the policy commits ${pointer.schema}` : "",
    att.nonce !== nonce ? `its nonce is ${att.nonce}, the loop's is ${nonce}` : "",
    att.signer !== pointer.signer ? `it is signed by ${att.signer}, the policy commits ${pointer.signer}` : "",
  ].filter(Boolean);
  checks.push(
    wrong.length
      ? check("account", "failed", wrong.join("; "))
      : check(
          "account",
          "ok",
          `an SAS attestation on the committed credential and schema, signed by ${short(pointer.signer)}`
        )
  );

  // 2. The data.
  const receipt = decodeLoopReceipt(att.data);
  if (!receipt) {
    checks.push(check("data", "failed", "the attestation's data does not decode as a loop-receipt v1"));
    return done();
  }
  checks.push(check("data", "ok", "a loop-receipt v1"));

  // 3. The subject.
  const agent = hex(agentId);
  const subject = [
    receipt.agent !== agent ? `it names agent ${short(receipt.agent)}, not ${short(agent)}` : "",
    receipt.loop !== loopId ? `it names loop ${receipt.loop}, not ${loopId}` : "",
  ].filter(Boolean);
  checks.push(
    subject.length ? check("subject", "failed", subject.join("; ")) : check("subject", "ok", "this agent and this loop")
  );

  // 4. The position: the record at `seq` is this loop's last checkpoint and its leaf commits `head`.
  const seq = BigInt(receipt.seq);
  const at = entries.find((e) => e.rec.seq === seq);
  checks.push(await positionCheck(agentId, loopId, receipt, seq, at, last, records, reads, unreadManifests, later));

  // 5. The record at `seq` recorded the goal reached.
  if (!at) {
    checks.push(
      check("reached", "unchecked", `there is no ${LOOP_STEP_TOOL} of this loop at seq ${seq} to read a status from`)
    );
  } else {
    const status = await statusOf(reads.store, at.rec).catch(() => undefined);
    checks.push(
      status === undefined
        ? check("reached", "unchecked", `the status of the ${LOOP_STEP_TOOL} at seq ${seq} is not readable here`)
        : status === LoopStepStatus.GoalReached
        ? check("reached", "ok", `step ${at.manifest.step} records the goal reached`)
        : check(
            "reached",
            "failed",
            `step ${at.manifest.step} records status ${status}, not the goal reached (${LoopStepStatus.GoalReached}), ` +
              "and a receipt is published only when Jev answers achieved"
          )
    );
  }

  // 6. The step count, as the record's manifest commits it.
  if (!at) {
    checks.push(
      check("steps", "unchecked", `there is no ${LOOP_STEP_TOOL} manifest of this loop at seq ${seq} to count from`)
    );
  } else {
    checks.push(
      at.manifest.step === receipt.steps
        ? check("steps", "ok", `${receipt.steps}, the step its record commits`)
        : check(
            "steps",
            "failed",
            `the receipt says ${receipt.steps} steps, and its record is step ${at.manifest.step}`
          )
    );
  }

  // 7. The goal, as every manifest of the loop commits it.
  const goals = new Set(entries.map((e) => normHash(e.manifest.goalHash)));
  if (goals.has("")) {
    checks.push(check("goal", "failed", "a manifest of this loop commits no goal, and the receipt names one"));
  } else if (goals.size !== 1 || !goals.has(normHash(receipt.goal))) {
    const committed = [...goals].map(short).join(", ");
    checks.push(
      check("goal", "failed", `the receipt's goal is ${short(receipt.goal)}, the manifests commit ${committed}`)
    );
  } else {
    checks.push(check("goal", "ok", `the goal every manifest of this loop commits`));
  }
  return done(receipt);
}

async function positionCheck(
  agentId: Uint8Array,
  loopId: string,
  receipt: LoopReceipt,
  seq: bigint,
  at: StepEntry | undefined,
  last: StepEntry,
  records: readonly InferenceRecord[],
  reads: ReceiptReads,
  unreadManifests: { seq: bigint; why: string }[],
  later: string[]
): Promise<ReceiptCheck> {
  if (!at) {
    const rec = records.find((r) => r.seq === seq);
    const unreadHere = unreadManifests.find((u) => u.seq === seq);
    if (unreadHere) return check("position", "unchecked", unreadHere.why);
    if (!rec) {
      const hidden = reads.blind?.(seq - 1n, seq + 1n);
      if (hidden) return check("position", "unchecked", `the record at seq ${seq} is not readable here: ${hidden}`);
    }
    const there = !rec
      ? "the chain has no record there"
      : rec.kind === EventKind.Action && hex(rec.reference) === hex(idFromString(LOOP_STEP_TOOL))
      ? `the ${LOOP_STEP_TOOL} there is another loop's`
      : `the record there is not a ${LOOP_STEP_TOOL}`;
    return check("position", "failed", `there is no ${LOOP_STEP_TOOL} of ${loopId} at seq ${seq}: ${there}`);
  }
  if (at !== last) {
    return check(
      "position",
      "failed",
      `seq ${seq} is step ${at.manifest.step} of the loop, and its last ${LOOP_STEP_TOOL} is step ` +
        `${last.manifest.step} at seq ${last.rec.seq}: the receipt does not point at the loop's end`
    );
  }
  const leaf = await payloadLeaf(reads.store, at.rec, 1).catch(() => null);
  if (!leaf)
    return check("position", "unchecked", `the ${LOOP_STEP_TOOL} at seq ${seq}'s payload is not readable here`);
  if (hex(leaf) !== hex(loopStepLeaf(agentId, seq, toBytes32(receipt.head)))) {
    return check(
      "position",
      "failed",
      `the ${LOOP_STEP_TOOL} at seq ${seq} commits leaf ${short(hex(leaf))}, which is not the leaf over this ` +
        `agent, seq ${seq} and the receipt's head ${short(receipt.head)}`
    );
  }
  const prior = reads.priorHeads?.get(seq.toString());
  if (prior && normHash(prior) !== normHash(receipt.head)) {
    return check(
      "position",
      "failed",
      `the chain's head before seq ${seq} is ${short(normHash(prior))}, and the receipt's head is ${short(
        receipt.head
      )}`
    );
  }
  if (later.length) {
    return check(
      "position",
      "unchecked",
      `whether a later step of this loop exists cannot be read: ${later.join("; ")}`
    );
  }
  const how = prior
    ? "the chain's head before it is the receipt's head"
    : "the chain's head before it was not read here; the record's leaf binds the head, and the chain audit binds the leaf";
  return check(
    "position",
    "ok",
    `seq ${seq} is the loop's last ${LOOP_STEP_TOOL} and its leaf commits head ${short(receipt.head)} (${how})`
  );
}

/** Micro-units (USDC and USDC.e both carry six decimals) as a decimal string. */
function sixDecimals(base: string): string {
  if (!/^\d+$/.test(base)) return base;
  const s = base.padStart(7, "0");
  const whole = s.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * One loop's lines: where the receipt is, what it points at, one line of checks, each check that did
 * not verify with why, and the money fields as the console reported them. No verdict line:
 * `verify-receipt` prints its own.
 */
export function formatReceipt(report: ReceiptReport): string[] {
  const out: string[] = [];
  if (report.address) out.push(`receipt    ${report.address}`);
  const r = report.receipt;
  if (r) {
    out.push(
      `points at  seq ${r.seq} · head ${short(r.head)} · ${r.steps} step${r.steps === 1 ? "" : "s"} · goal ${short(
        r.goal
      )}`
    );
  }
  if (report.checks.length) {
    const parts = report.checks.map((c) => c.detail.split(" — ")[0]);
    if (report.status !== "ok") parts.push(report.status === "failed" ? "FAILED" : "not checked");
    out.push(parts.join(" · "));
    for (const c of report.checks) {
      if (c.status === "ok") continue;
      out.push(`    ${c.name}: ${c.detail.split(" — ").slice(1).join(" — ")}`);
    }
  }
  if (report.detail) {
    // A loop with no checks says why in one line, with its status, as a check line would end.
    const tail =
      report.checks.length || report.status === "not-due" || report.status === "ok"
        ? ""
        : ` · ${report.status === "failed" ? "FAILED" : "not checked"}`;
    out.push(`${report.detail}${tail}`);
  }
  if (r) {
    const payer = r.tempoPayer ? ` by ${r.tempoPayer}` : "";
    out.push(
      `money      ${sixDecimals(r.usdcCharged)} USDC charged on Solana · ${sixDecimals(r.tempoSpent)} USDC.e paid on ` +
        `Tempo${payer} — as the console reported them; this audit does not re-derive them`
    );
  }
  return out;
}

/** `verify-receipt`'s verdict: `failed`, `unchecked` (anything not read, or nothing to check), or `ok`. */
export function receiptsStatus(result: ReceiptsResult): PluginCheckStatus {
  if (result.loops.some((l) => l.status === "failed")) return "failed";
  const checked = result.loops.filter((l) => l.status !== "not-due");
  if (!checked.length || result.unread.length || checked.some((l) => l.status === "unchecked")) return "unchecked";
  return "ok";
}

/** Exit codes: `0` verified, `1` a contradiction, `2` nothing to check or a reader that did not answer. */
export function receiptsExitCode(result: ReceiptsResult): number {
  const s = receiptsStatus(result);
  return s === "failed" ? 1 : s === "unchecked" ? 2 : 0;
}
