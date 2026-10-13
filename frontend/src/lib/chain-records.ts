/**
 * The lifecycle records on screen: an agent's deploy and a loop's start, pause, resume and stop as
 * the chain holds them (`sdk/src/lifecycle.ts`), beside the console's own row. What the loop page's
 * _On Solana_ block, the workspace's run rows and the agent panel say of them comes from here.
 *
 * No React, no Next and no value import (types only), so `tests/workspace.ts` runs these under the
 * root `tsconfig.json`. The tool ids are literals rather than `LIFECYCLE_TOOLS` from the SDK for the
 * same reason, and that test pins the two lists equal, so a record kind added there fails here until
 * it has a name.
 */
import type { LifecycleRef, LoopChainView } from "../types/loop";

/**
 * Each lifecycle record's name on screen, in the SDK's order (agent's three, then the loop's four).
 * Short past-tense phrases, because a record is something that happened: the row reads _Loop paused ·
 * seq 41_, the way the step rows read _step 3_.
 */
export const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  "agent.deploy": "Agent deployed",
  "agent.archive": "Agent archived",
  "agent.unarchive": "Agent unarchived",
  "loop.start": "Loop started",
  "loop.pause": "Loop paused",
  "loop.resume": "Loop resumed",
  "loop.stop": "Loop stopped",
};

/** The lifecycle tool ids, for the event name table (`lib/eventmeta.ts`). */
export const LIFECYCLE_TOOL_IDS: readonly string[] = Object.keys(LIFECYCLE_LABELS);

/** A record's name, or its tool id when this build has no name for it (a later record kind). */
export function lifecycleLabel(tool: string): string {
  return LIFECYCLE_LABELS[tool] ?? tool;
}

/**
 * The hover on a rebuilt row's disabled controls, and its badge. Such a row came from the chain into a
 * console that did not start the loop: nothing here schedules it and the server refuses its controls,
 * so the buttons say why rather than answer with an error after a signature.
 */
export const REBUILT_TITLE =
  "Rebuilt from this loop's records on Solana by a console that did not start it: nothing here schedules it, so it cannot be paused, resumed, retried or stopped from this console";

/** The badge's words on a rebuilt row. */
export const REBUILT_LABEL = "rebuilt from chain · read-only";

/** One line of an _On Solana_ list. */
export interface ChainRecordLine {
  /** Stable across polls, for React's list key. */
  key: string;
  tool: string;
  label: string;
  /** Decimal seq on the agent's chain. */
  seq: string;
  signature?: string;
  /** Unix ms the console recorded it at. */
  at: number;
  /** The stop's reason, on the stop that ended the run, when the row has one. */
  detail?: string;
}

/** Seq order, numerically: `"10"` after `"9"`. A seq that is not a decimal sorts by time, after the rest. */
function bySeq(a: LifecycleRef, b: LifecycleRef): number {
  const da = /^\d+$/.test(a.seq);
  const db = /^\d+$/.test(b.seq);
  if (da && db) {
    const x = BigInt(a.seq);
    const y = BigInt(b.seq);
    if (x !== y) return x < y ? -1 : 1;
    return a.at - b.at;
  }
  if (da !== db) return da ? -1 : 1;
  return a.at - b.at;
}

/**
 * The records, oldest first, each named. The server sends them oldest first already; sorting again
 * costs nothing and keeps an older server's order from mattering.
 *
 * `stopReason` goes on the last record only, and only when that record is a stop: the row's reason is
 * why the run ended *now*, and an earlier stop that a resume undid ended nothing the row remembers.
 */
export function chainRecordLines(
  records: readonly LifecycleRef[] | undefined,
  opts: { stopReason?: string | null } = {}
): ChainRecordLine[] {
  const sorted = [...(records ?? [])].sort(bySeq);
  const lines: ChainRecordLine[] = sorted.map((r, i) => ({
    key: `${r.tool}:${r.seq}:${i}`,
    tool: r.tool,
    label: lifecycleLabel(r.tool),
    seq: r.seq,
    signature: r.signature,
    at: r.at,
  }));
  const last = lines[lines.length - 1];
  const reason = opts.stopReason?.trim();
  if (last && last.tool === "loop.stop" && reason) last.detail = reason;
  return lines;
}

/**
 * The quiet chip for records the console decided and has not written yet: _recording on Solana… loop
 * paused_. `null` when nothing is owed, so a caller draws nothing. The words name what is owed, so a
 * reader can tell a pause waiting behind a step from a stop waiting on a retry.
 */
export function owedText(owed: readonly string[] | undefined): string | null {
  if (!owed || owed.length === 0) return null;
  const names = owed.map((t) => {
    const label = lifecycleLabel(t);
    return label === t ? t : label.toLowerCase();
  });
  return `recording on Solana… ${names.join(", ")}`;
}

/** Whether the row owes records the chain does not have yet. Absent `chain` owes nothing it can say. */
export function chainOwes(chain: Pick<LoopChainView, "owed"> | undefined | null): boolean {
  return !!chain && chain.owed.length > 0;
}

/** Whether the row was rebuilt from the chain and is read-only here. */
export function chainRebuilt(chain: Pick<LoopChainView, "rebuilt"> | undefined | null): boolean {
  return chain?.rebuilt === true;
}

/**
 * The agent's `agent.deploy`: the first one by seq, since an agent is deployed once and a second
 * record of it (a console that wrote it again after a lost confirmation) would say nothing new.
 * `null` on an agent with no record, which is every older agent deployed without lifecycle records.
 */
export function deployRecord(records: readonly LifecycleRef[] | undefined): LifecycleRef | null {
  return [...(records ?? [])].filter((r) => r.tool === "agent.deploy").sort(bySeq)[0] ?? null;
}
