/**
 * The step manifest the browser rebuilds to check a `loop.step` leaf (`verifyStep`), from the loop's
 * own terms and what the row says the step committed.
 *
 * Its own module, with no React and no chain read, so the rebuild is a pure function a node-only
 * suite can hold against `loopManifestBytes` (`tests/console-trace-audit.ts`). A manifest key the
 * runner writes and this rebuild does not know makes every step carrying it read *leaf mismatch*;
 * a test that pins the full sixteen keys is what keeps the two in step.
 */
import type { LoopStepManifest } from "@lath/sdk";
import type { LoopStepSummary, LoopView } from "../types/loop";

/**
 * The keys a step carries on its own, beyond the memory, the verdict, the request and the members,
 * each set only when the runner wrote it.
 */
export interface StepManifestKeys {
  gateHash?: string;
  replayHash?: string;
  goalCheckHash?: string;
  tempoHash?: string;
  traceAuditHash?: string;
}

/**
 * The manifest step `n` of `loop` must have committed to, rebuilt from the loop's own terms.
 * `memoryHash` is the one term that is not fixed for the life of the loop: it is what the server
 * says the step ended with, and the manifest check is what holds the server to it.
 */
export function manifestFor(
  loop: Pick<LoopView, "id" | "intervalMs" | "maxSteps" | "promptHash" | "createdAt" | "goalHash">,
  step: number,
  memoryHash?: string,
  verifyHash?: string,
  requestAddress?: string,
  members?: LoopStepSummary["members"],
  keys: StepManifestKeys = {}
): LoopStepManifest {
  const m: LoopStepManifest = {
    loopId: loop.id,
    step,
    intervalMs: loop.intervalMs,
    maxSteps: loop.maxSteps,
    promptHash: loop.promptHash,
    startedAt: loop.createdAt,
  };
  if (memoryHash) m.memoryHash = memoryHash;
  // The eighth key, on a step woken by an oracle `Request` only: the runtime writes it
  // and a rebuild without it reads *leaf mismatch* on every request-triggered step.
  if (requestAddress) m.requestAddress = requestAddress;
  // The ninth key, on a verified step only: without it the rebuilt bytes are the eight-key
  // manifest and every verified step reads *leaf mismatch*.
  if (verifyHash) m.verifyHash = verifyHash;
  // The tenth key, on every step of a goal loop: the goal is committed by hash for the life of
  // the run, so it comes from the loop rather than the step; omitting it reads *leaf mismatch* on
  // every step of every goal loop, as omitting either key above does on its steps.
  if (loop.goalHash) m.goalHash = loop.goalHash;
  // The eleventh, on a step that opened at least one member: the five committed keys only, in
  // the order `loopManifestBytes` emits them. The console's row carries more than the manifest
  // does — the name, the cost, the Delegation signature — and any of that in the rebuilt bytes
  // would be a mismatch against what the runner hashed.
  if (members?.length) {
    m.members = members.map((w) => ({
      agentId: w.agentId,
      taskId: w.taskId,
      outcome: w.outcome,
      seq: w.seq,
      head: w.head,
      // The sixth and seventh keys, only when the runner wrote
      // them: a judged or routed member rebuilt without its hash reads *leaf mismatch*.
      ...(w.verifyHash ? { verifyHash: w.verifyHash } : {}),
      ...(w.routeHash ? { routeHash: w.routeHash } : {}),
    }));
  }
  // The twelfth and thirteenth: the gate log on a woken step, and the replay record on every
  // sandboxed one. Every loop step runs in a sandbox, so a rebuild without `replayHash` reads
  // *leaf mismatch* on every step of every loop.
  if (keys.gateHash) m.gateHash = keys.gateHash;
  if (keys.replayHash) m.replayHash = keys.replayHash;
  // The fourteenth, on a goal-checked step of a run with no verify seat: the
  // goal answer's own blob. Without it such a step rebuilds the thirteen-key bytes and mismatches.
  if (keys.goalCheckHash) m.goalCheckHash = keys.goalCheckHash;
  // The fifteenth, on a step whose loop's Tempo services carried something; a rebuild without it
  // reads *leaf mismatch* on every such step.
  if (keys.tempoHash) m.tempoHash = keys.tempoHash;
  // The sixteenth, on a trace-audited step the model answered.
  if (keys.traceAuditHash) m.traceAuditHash = keys.traceAuditHash;
  return m;
}

/**
 * The per-step keys off a console row: each from the view that carries it, and the two a late
 * checkpoint's plan carries from the plan when the view does not (the Retry wrote them from it).
 */
export function manifestKeysOf(row: LoopStepSummary | undefined): StepManifestKeys {
  if (!row) return {};
  const tempoHash = row.tempoHash ?? row.deferredCheckpoint?.tempoHash;
  const traceAuditHash = row.traceAudit?.traceAuditHash ?? row.deferredCheckpoint?.traceAuditHash;
  return {
    ...(row.wake?.gateHash ? { gateHash: row.wake.gateHash } : {}),
    ...(row.zeroclaw?.replayHash ? { replayHash: row.zeroclaw.replayHash } : {}),
    ...(row.goalCheck?.goalCheckHash ? { goalCheckHash: row.goalCheck.goalCheckHash } : {}),
    ...(tempoHash ? { tempoHash } : {}),
    ...(traceAuditHash ? { traceAuditHash } : {}),
  };
}

/**
 * Whether `row` may have committed a `tempoHash` its view does not carry: it names none, and an
 * earlier row of the same loop had something for a later leaf to carry (a `storage.put` or a
 * snapshot, each carried by the next leaf, not by the step that made it).
 *
 * Some older rows belong to steps whose runner wrote the fifteenth key into the manifest while
 * the row kept it off, so such a step rebuilds the fourteen-key bytes and reads *leaf mismatch* on
 * a chain `lath-audit` verifies. This only says the step is worth a `recoverTempoHash`; it never
 * says the leaf is good.
 */
export function mayLackTempoHash(row: LoopStepSummary | undefined, earlier: readonly LoopStepSummary[]): boolean {
  if (!row || manifestKeysOf(row).tempoHash) return false;
  return earlier.some((h) => h.step < row.step && (h.tempoStorage || h.tempoSnapshot));
}

/**
 * The `tempoHash` a step's manifest committed, found among `candidates` — the hashes of the blobs
 * the step itself wrote, which is where its carry blob is (`storeCarry` puts it through the step's
 * own store, so it is in the step's bundle, indexed by its plaintext hash whether or not it is
 * encrypted) — or `undefined`.
 *
 * Nothing is taken on the row's or the bundle's word: a candidate is the answer only when
 * `matches` holds for the manifest rebuilt with it, and `matches` is meant to be `verifyStep`'s
 * manifest path, which compares against the record's on-chain `payload_hash`. The key is a SHA-256
 * input, so the one candidate that reproduces that hash is the one the runner wrote, and a carry
 * edited by so much as a byte hashes to a candidate that matches nothing. A `base` that already
 * names a `tempoHash` is left alone: a row that named one and mismatches is a mismatch, and
 * swapping the key it named for another would be exactly the "accept a leaf because a key was
 * missing" this must never do.
 */
export async function recoverTempoHash(
  base: LoopStepManifest,
  candidates: Iterable<string>,
  matches: (manifest: LoopStepManifest) => boolean | Promise<boolean>
): Promise<string | undefined> {
  if (base.tempoHash !== undefined) return undefined;
  const seen = new Set<string>();
  for (const raw of candidates) {
    const candidate = raw.toLowerCase();
    // The decoder (`decodeLoopManifest`) admits only 64 hex digits here, so nothing else could be
    // what the runner wrote; and each is tried once however many bundles repeat it.
    if (!/^[0-9a-f]{64}$/.test(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await matches({ ...base, tempoHash: candidate })) return candidate;
  }
  return undefined;
}
