/**
 * Which models a session's chat calls may be served by: the policy's `model`, and its `fallbackModel`
 * when it commits one. `verifyInference` holds one paid call to it and `audit` every `llm.*` Action
 * it walks, so a record never shows a model its Genesis did not allow.
 *
 * What is held is the **request's** model — the `model` of the args blob, the model Lath asked the
 * gateway for — because that is what the runtime sets and the policy binds. The body's `model` is
 * the gateway's name for the build that answered, which can be a dated build of the requested slug
 * (`typesafe/jev-1.13-20260917`): reported, never compared, or an honest chain whose gateway
 * resolved an alias would fail.
 *
 * A chain whose policy commits no `fallbackModel` is held to its `model` alone: each of its chat
 * requests carries that model, which `runtime.ts` pins on every path (`runTurns`, the sandbox's
 * proxy). A policy or args blob this reader cannot read leaves the call unchecked, never failed.
 */
import { EventKind } from "../events";
import { hex, idFromString } from "../hash";
import type { TraceStore } from "../trace-store";
import { type InferenceRecord, blobAt, genesisPolicyVersionHash, payloadLeaf } from "./core";

/** The models a policy document allows a chat call to ask for. */
export interface CommittedModels {
  model: string;
  /** Present only when the policy commits one. */
  fallbackModel?: string;
}

/** `model` and `fallbackModel` of a policy document, or `null` when it names no model at all. */
export function committedModelsOf(doc: unknown): CommittedModels | null {
  const d = doc as { model?: unknown; fallbackModel?: unknown } | null;
  if (!d || typeof d !== "object" || typeof d.model !== "string" || !d.model) return null;
  return typeof d.fallbackModel === "string" && d.fallbackModel
    ? { model: d.model, fallbackModel: d.fallbackModel }
    : { model: d.model };
}

/**
 * The committed models of the policy a Genesis names, read through its `policy_version_hash`:
 * `undefined` when the preimage or the document is not readable here (unchecked), `null` when the
 * document names no model. Cached by policy hash, because every step of a loop names the same one.
 */
export async function committedModelsAt(
  store: TraceStore | undefined,
  genesis: InferenceRecord,
  cache: Map<string, CommittedModels | null | undefined>
): Promise<CommittedModels | null | undefined> {
  if (genesis.kind !== EventKind.Genesis || !store) return undefined;
  let preimage: Uint8Array | null = null;
  try {
    preimage = await blobAt(store, genesis.payloadHash);
  } catch {
    // An owner-encrypted store raises on a blob it cannot open: unread, not absent.
    return undefined;
  }
  if (!preimage || preimage[0] !== genesis.kind) return undefined;
  const pvh = genesisPolicyVersionHash(preimage[0], preimage.slice(1));
  if (!pvh) return undefined;
  const id = hex(pvh);
  if (cache.has(id)) return cache.get(id);
  let found: CommittedModels | null | undefined;
  try {
    const doc = await blobAt(store, pvh);
    found = doc ? committedModelsOf(JSON.parse(new TextDecoder().decode(doc))) : undefined;
  } catch {
    found = undefined;
  }
  cache.set(id, found);
  return found;
}

/**
 * The policy document a Genesis names, parsed: `undefined` when the preimage or the document is not
 * readable here, or is not JSON. Cached by policy hash, as `committedModelsAt` is.
 */
export async function committedPolicyAt(
  store: TraceStore | undefined,
  genesis: InferenceRecord,
  cache: Map<string, unknown>
): Promise<unknown> {
  if (genesis.kind !== EventKind.Genesis || !store) return undefined;
  let preimage: Uint8Array | null = null;
  try {
    preimage = await blobAt(store, genesis.payloadHash);
  } catch {
    return undefined;
  }
  if (!preimage || preimage[0] !== genesis.kind) return undefined;
  const pvh = genesisPolicyVersionHash(preimage[0], preimage.slice(1));
  if (!pvh) return undefined;
  const id = hex(pvh);
  if (cache.has(id)) return cache.get(id);
  let doc: unknown;
  try {
    doc = jsonOf(await blobAt(store, pvh)) ?? undefined;
  } catch {
    doc = undefined;
  }
  cache.set(id, doc);
  return doc;
}

/** A decision seat — the verifier or Jev's goal check — as a policy document commits it. */
export interface CommittedSeat {
  model: string;
  minConfidence: number;
}

/** `doc.verify` or `doc.goalCheck` when it names a model and a numeric bar; `null` when it does not. */
export function committedSeatOf(doc: unknown, key: "verify" | "goalCheck"): CommittedSeat | null {
  const seat = (doc as Record<string, any> | null)?.[key];
  if (!seat || typeof seat !== "object" || typeof seat.model !== "string" || typeof seat.minConfidence !== "number") {
    return null;
  }
  return { model: seat.model, minConfidence: seat.minConfidence };
}

/**
 * Why a decision blob was not asked of the seat its session's policy commits, or `null` when it was.
 * The blob records the model it asked and the bar it was held to, and both are the writer's word:
 * the runner refuses to start under a seat its policy does not name, so on an honest chain the two
 * are the policy's, and a blob that names another model or a lower bar is a decision the loop's
 * owner never agreed to. A blob with no bar is not refused here — older blobs carry none — and the
 * caller decides what the policy's bar makes of it.
 */
export function seatProblem(
  request: { model: string; minConfidence?: number },
  seat: CommittedSeat,
  hash: string
): string | null {
  if (request.model !== seat.model) {
    return `the decision under ${hash} asked ${request.model}, while the step's policy commits ${seat.model}`;
  }
  if (request.minConfidence !== undefined && request.minConfidence !== seat.minConfidence) {
    return (
      `the decision under ${hash} was held to a bar of ${request.minConfidence}, while the step's policy ` +
      `commits ${seat.minConfidence}`
    );
  }
  return null;
}

function jsonOf(bytes: Uint8Array | null): any {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * The model an `llm.*` Action asked for and the one that served, when the record is one: its tool
 * id is `llm.<m>` for the model its result body names or the model its args name — `isLlmCall`'s
 * rule, the two ids `paidChat` writes. `null` for any other record, or one whose blobs are not here.
 */
export async function chatModelsAt(
  store: TraceStore | undefined,
  rec: InferenceRecord
): Promise<{ asked: string; served?: string } | null> {
  if (rec.kind !== EventKind.Action) return null;
  const argsHash = await payloadLeaf(store, rec, 0).catch(() => null);
  const resultHash = await payloadLeaf(store, rec, 1).catch(() => null);
  const args = jsonOf(argsHash ? await blobAt(store, argsHash).catch(() => null) : null);
  const result = jsonOf(resultHash ? await blobAt(store, resultHash).catch(() => null) : null);
  const asked = typeof args?.model === "string" && args.model ? (args.model as string) : null;
  const served = typeof result?.model === "string" && result.model ? (result.model as string) : undefined;
  if (!asked) return null;
  const reference = hex(rec.reference);
  const names = (m: string | undefined) => !!m && hex(idFromString(`llm.${m}`)) === reference;
  if (!names(served) && !names(asked)) return null;
  return { asked, ...(served ? { served } : {}) };
}

/**
 * Why a call that asked for `asked` breaks the policy that committed `committed`, or `null` when it
 * keeps it. The sentence names both, because the reader has to see which model the policy allowed.
 */
export function modelProblem(asked: string, committed: CommittedModels): string | null {
  if (asked === committed.model || asked === committed.fallbackModel) return null;
  const allowed = committed.fallbackModel
    ? `${committed.model}, or its fallback ${committed.fallbackModel}`
    : committed.model;
  return `asked for ${asked}, a model the session's policy does not commit (it allows ${allowed})`;
}
