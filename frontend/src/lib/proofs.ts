import {
  createEpochMerkleTree,
  epochLeaves,
  EpochRecord,
  EventInput,
  generateEpochProof,
  hex,
  verifyEpochProof,
} from "@lath/sdk/browser";

/**
 * Inclusion proofs for the steps inside an epoch, computed in the browser.
 *
 * An epoch puts one Merkle root on chain and leaves the per-step `EventInput`s in a blob
 * (`sdk/src/rollup.ts`). `useEpochSteps` already fetches that blob and rebuilds its root; what
 * a reader still cannot see from the panel alone is *why one particular step* is covered by the
 * root the chain folded. That is this file: rebuild the same leaves the SDK's `verifyEpochBlob`
 * rebuilds, take the sibling path to the root, and re-hash it against **the chain's root** —
 * `EpochCommitted.epoch_root`, not the root recomputed from the bytes, which would only prove
 * the blob is self-consistent.
 *
 * Every hash here comes from the SDK. Nothing in the frontend implements sha256 or a leaf
 * encoding of its own, so a proof shown on screen is byte-identical to one an auditor generates
 * with `lath-audit`.
 */

export interface StepInclusionProof {
  /** 0-based position in the epoch, which is also `seq - startSeq`. */
  index: number;
  seq: bigint;
  /** `sha256("lattice.epoch.leaf" ‖ seq ‖ input)`, hex. */
  leaf: string;
  /** The sibling hashes from the leaf up to the root, hex, bottom first. */
  path: string[];
  /** The root the path folds to, hex — what this browser computed. */
  computedRoot: string;
  /** The root the chain folded, hex — what the browser compared against. */
  chainRoot: string;
  /** True when the leaf and its path re-hash to the chain's root. */
  verified: boolean;
}

/**
 * The proof that step `index` of an epoch is inside the root the chain committed.
 *
 * `inputs` are the blob's decoded steps in order and `startSeq` the seq the epoch opened at, so
 * the leaves are the ones `epochRootOf` (and therefore `verifyEpochBlob`) builds.
 */
export function proveEpochStep(
  startSeq: bigint,
  inputs: EventInput[],
  index: number,
  chainRoot: Uint8Array
): StepInclusionProof {
  const tree = createEpochMerkleTree(epochLeaves(startSeq, inputs));
  const proof = generateEpochProof(tree, index);
  return {
    index,
    seq: startSeq + BigInt(index),
    leaf: hex(proof.leaf),
    path: proof.proof.map(hex),
    computedRoot: hex(proof.root),
    chainRoot: hex(chainRoot),
    verified: verifyEpochProof(chainRoot, proof.leaf, proof.proof, index),
  };
}

/**
 * Which epoch this is among the owner's, 1-based and ordered by `startSeq` — the `k` in the
 * timeline's *epoch #k* storage tier. Returns 0 for an epoch that is not in the list.
 */
export function epochOrdinal(epochs: EpochRecord[], epoch: EpochRecord): number {
  return (
    [...epochs]
      .sort((a, b) => (a.startSeq < b.startSeq ? -1 : a.startSeq > b.startSeq ? 1 : 0))
      .findIndex((e) => e.startSeq === epoch.startSeq) + 1
  );
}
