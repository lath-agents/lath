/**
 * A loop's postures in clear on Irys: the console half. `runtime/src/zeroclaw/posture-irys.ts`
 * says why the posture is safe to publish and holds the pure reads; this file picks which postures a
 * step's row names that are not up yet, and uploads one through the uploader the sources go through
 * (`irysSourcesUploader`: the console's key, network and node), so the posture is paid from the
 * balance the sources and the epochs are.
 *
 * Nothing on chain names a posture's Irys id, and nothing needs to: the id only says where to look,
 * and a reader re-hashes the bytes against the posture hash under the Genesis's
 * `policy_version_hash`. A lying id is caught by that hash, as a lying sources index is.
 */
import { hex, irysIdString, sha256 } from "@lath/sdk";
import {
  checkPostureBytes,
  postureBytes,
  postureIrysTags,
  POSTURE_IRYS_MAX_BYTES,
} from "@lath/runtime/zeroclaw/posture-irys";
import type { LoopPostureIrys, LoopStepSummary } from "../../../types/loop";
import type { LoopRecord } from "./loops";
import type { ZeroClawStepRecord } from "../../../types/zeroclaw";
import type { SourcesUploader } from "./sources-irys";

/** A posture a step recorded whose bytes are not on Irys yet: its hash and the exact bytes it hashes. */
export interface PostureToPublish {
  hash: string;
  json: string;
}

/**
 * The postures `row` names — session A's and each member's — that `loop` has no Irys id for. Only a
 * record whose `postureJson` re-hashes to its own `postureHash` counts: the console uploads what the
 * Genesis commits, never bytes it only claims are. A row whose sandbox kept only the hash (an older
 * row, `withoutSandboxTexts`) names nothing to upload. One entry per hash, however many sandboxes
 * share it.
 */
export function posturesToPublish(loop: Pick<LoopRecord, "postures">, row: LoopStepSummary): PostureToPublish[] {
  const records: (ZeroClawStepRecord | undefined)[] = [row.zeroclaw, ...(row.members ?? []).map((m) => m.zeroclaw)];
  const out: PostureToPublish[] = [];
  for (const r of records) {
    if (!r?.postureJson || !r.postureHash) continue;
    if (loop.postures?.[r.postureHash] || out.some((p) => p.hash === r.postureHash)) continue;
    if (hex(sha256(postureBytes(r.postureJson))) !== r.postureHash) continue;
    out.push({ hash: r.postureHash, json: r.postureJson });
  }
  return out;
}

/**
 * One posture up, in clear, tagged with its hash. Checked first with the reader's own check
 * (`checkPostureBytes`), so what goes up is exactly what a page will accept, and refused over the
 * cap a page reads to. Returns the Irys id, base58. Throws on a refusal or a failed upload; the
 * caller decides that neither may fail a step.
 */
export async function publishPosture(p: PostureToPublish, uploader: SourcesUploader): Promise<string> {
  const bytes = postureBytes(p.json);
  if (bytes.length > POSTURE_IRYS_MAX_BYTES) {
    throw new Error(`the posture is ${bytes.length} bytes, over the ${POSTURE_IRYS_MAX_BYTES} a reader takes`);
  }
  const read = checkPostureBytes(bytes, p.hash);
  if ("why" in read) throw new Error(`the posture ${p.hash} was not published: ${read.why}`);
  return irysIdString(await uploader.upload(bytes, postureIrysTags(p.hash)));
}

/**
 * An id this console already holds for `hash` on `network`, from any loop's row: a posture is the
 * same bytes whichever loop committed it, so a second loop under the same posture names the first
 * upload rather than paying for the bytes again.
 */
export function knownPosture(
  loops: Iterable<Pick<LoopRecord, "postures">>,
  hash: string,
  network: LoopPostureIrys["network"]
): LoopPostureIrys | null {
  for (const l of loops) {
    const found = l.postures?.[hash];
    if (found && found.network === network) return found;
  }
  return null;
}
