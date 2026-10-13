/**
 * The header's one-line verdict on an agent's chain, from `verifyChain`'s result.
 *
 * `ok` can be true with gaps. A seq with no account and no `CellWritten` is recorded in
 * `missingSeqs`; `ok` survives it only when transaction history shows a `log_event_compact` wrote
 * that seq — any other gap, including history this RPC no longer returns and a record it does not
 * show, is in `unexplainedGaps` and takes the not-verified arm below. Across a compact gap the
 * fold resumes at the next record's own head, which the program wrote and nothing here recomputed,
 * so a bare *chain verified to seq N* would claim a replay the page never made; the export says
 * VERIFIED WITH GAPS and `lath-audit` prints *no account at seq …* under OK, and this says the same.
 *
 * The *chain verified to seq* prefix is kept on both `ok` arms: the read-path, builder,
 * agent-archive and tempo-rail specs match it by regex, and what they assert — the chain read
 * and nothing disagreed — is true of both.
 *
 * No React and no chain read, so the rule is a pure function `tests/console-reader.ts` checks.
 */

/** The fields of `ChainVerification` (`@lath/sdk`) the badge reads; that type satisfies this. */
export interface ChainBadgeInput {
  ok: boolean;
  headReached: boolean;
  firstBadSeq?: bigint;
  missingSeqs: bigint[];
  /** Gap seqs with no account that no compact write in transaction history accounts for. */
  unexplainedGaps?: bigint[];
  seq: bigint;
}

export interface ChainBadge {
  text: string;
  tone: "good" | "warn" | "bad";
  title?: string;
}

/**
 * What the green arm's title says the badge covers. `verifyChain` recomputes the head
 * from the records it read; it does not open epoch proofs or fetch preimages, so "verified" here
 * means the hash chain is self-consistent and reaches the on-chain head, not that the traces
 * behind each `payload_hash` were checked. `lath-audit --store` (or the export) does that.
 */
const HEAD_ONLY_TITLE =
  "head recomputed from the records read, and it matches the on-chain head; epoch proofs and trace " +
  "preimages are not checked here (run lath-audit with a trace store for those)";

/** How many gap seqs the title names before it says there are more. */
const TITLE_SEQS = 12;

export function chainBadge(v: ChainBadgeInput): ChainBadge {
  const missing = v.missingSeqs.map((s) => s.toString());
  if (v.ok && missing.length === 0)
    return { text: `chain verified to seq ${v.seq.toString()}`, tone: "good", title: HEAD_ONLY_TITLE };
  if (v.ok) {
    const named = missing.slice(0, TITLE_SEQS).join(", ") + (missing.length > TITLE_SEQS ? ", …" : "");
    return {
      text: `chain verified to seq ${v.seq.toString()}, with gaps`,
      tone: "warn",
      title:
        `no account at seq ${named}: compact events, named in transaction history but not replayed; the fold ` +
        `resumed at the next record's own head, which the program wrote, and was not recomputed across the gap. ` +
        `Epoch proofs and trace preimages are not checked here either`,
    };
  }
  // Nothing disagreed; a gap reached the tail, so nothing was compared with the head. "Broken" is
  // kept for a head that was checked and was wrong.
  if (v.firstBadSeq === undefined && !v.headReached) {
    const gap = missing.length ? ` (gap at seq ${missing.slice(-3).join(", ")}${missing.length > 3 ? ", …" : ""})` : "";
    return { text: `head not reached${gap}`, tone: "warn" };
  }
  // Nothing disagreed and the head was reached, but a gap has no account and no compact write in
  // the history this RPC returned — a record not shown, or history pruned — so whatever was
  // written there was never seen. Not
  // "verified", which is the claim a hidden event must not get, and not "broken", which is kept
  // for a head that was checked and was wrong.
  const unexplained = (v.unexplainedGaps ?? []).map((s) => s.toString());
  if (v.firstBadSeq === undefined && v.headReached && unexplained.length) {
    const named = unexplained.slice(0, TITLE_SEQS).join(", ") + (unexplained.length > TITLE_SEQS ? ", …" : "");
    return {
      text: `chain not verified: gaps not accounted for`,
      tone: "warn",
      title:
        `no account, and no compact write in this RPC's history, at seq ${named}; what was written there was ` +
        `never seen. ` +
        `Audit with --recover against an RPC that still holds the history`,
    };
  }
  return { text: `chain broken at seq ${v.firstBadSeq?.toString() ?? "?"}`, tone: "bad" };
}
