/**
 * The one helper two verifiers share that cannot live in `core.ts`: it decodes a `loop.step` manifest,
 * so it imports `../loops`, which imports `core`. Keeping it here keeps `core.ts` a leaf.
 */
import { decodeLoopManifest, type LoopStepManifest } from "../loops";
import type { TraceStore } from "../trace-store";
import { type InferenceRecord, blobAt, payloadLeaf } from "./core";

/**
 * The `loop.step` manifest a checkpoint's `args_hash` names, when the store still holds it.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function manifestOf(
  store: TraceStore | undefined,
  rec: InferenceRecord
): Promise<LoopStepManifest | null> {
  const argsHash = await payloadLeaf(store, rec, 0);
  if (!argsHash) return null;
  const bytes = await blobAt(store, argsHash);
  return bytes ? decodeLoopManifest(bytes) : null;
}
