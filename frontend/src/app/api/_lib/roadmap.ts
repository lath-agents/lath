/**
 * Gated loops and loops woken by an oracle request or feed, which this build does not have.
 *
 * This build offers one agent stepping on the clock, Jev's goal check, and SAS · receipt. Teams, the
 * gate, the request and feed triggers, the trace audit and protocol-plugin grants are on the roadmap
 * and have no write side here, so each is refused at every door, and a running row that carries one is
 * stopped. This module holds the gate's and the oracle triggers' refusals; the others sit beside the
 * check that reads them in `_lib/loop-terms.ts` (`checkWorkersRequest`, `asksForTraceAudit`, `grantsRefusal`).
 * What the audit re-runs stays (`sdk/src/gate.ts`, `sdk/src/audit/*`), and the loop page still reads an
 * old row's gate and wake.
 *
 * Refused, never dropped: the start's signature binds its terms, and a loop started without a term it
 * signed would run something other than what its owner asked for.
 *
 * Its own module, importing nothing, so `_lib/loops.ts`, `templates/validate.ts` and the suites read the
 * one rule.
 */

/**
 * The features whose write side this build does not have: a gated loop, and a loop woken by an oracle
 * request or publishing to a feed. There is no code here to run them, and this build does not audit
 * their chains.
 */
export type RemovedFeature = "gate" | "oracle";

/** The keys each feature is asked for by, as a start body, a template config and a `LoopRecord` all spell them. */
export interface RoadmapTerms {
  trigger?: unknown;
  gate?: unknown;
}

/**
 * The roadmap feature `terms` asks for, or `null`: a `gate` that is absent or `null` asks for nothing,
 * and the trigger asks for one only when its kind is `gate`, `request` or `feed`. Asked by every check
 * below, so a body, a template or a row that carries one is refused, or kept from stepping, on every
 * console.
 */
export function removedFeatureOf(terms: RoadmapTerms | null | undefined): RemovedFeature | null {
  if (!terms) return null;
  const kind = (terms.trigger as { kind?: unknown } | null | undefined)?.kind;
  if (kind === "gate" || (terms.gate !== undefined && terms.gate !== null)) return "gate";
  if (kind === "request" || kind === "feed") return "oracle";
  return null;
}

/** What a roadmap feature is called in a sentence. */
const REMOVED_NAME: Record<RemovedFeature, string> = {
  gate: "a gate",
  oracle: "an oracle trigger",
};

/** What a start or a template write asking for a roadmap feature is told. */
const REMOVED_START_REFUSAL: Record<RemovedFeature, string> = {
  gate:
    "gated loops are not in this build: leave out gate and start the loop on a schedule; " +
    "loops that already ran with a gate still verify",
  oracle:
    "loops woken by an oracle request or feed are not in this build: start the loop on a schedule; " +
    "loops that already ran on one still verify",
};

/**
 * Why a running row cannot take another step, or `null`: it was started with a roadmap feature, and
 * there is no code here to step it. The scheduler stops it with this sentence
 * before anything is funded or spent (`tickOnce`).
 */
export function removedFeatureStop(row: RoadmapTerms | null | undefined): string | null {
  const removed = removedFeatureOf(row);
  return removed
    ? `this loop runs with ${REMOVED_NAME[removed]}, which is not in this build, so it takes no more steps; ` +
        "its chain still verifies"
    : null;
}

/** Why a start body or a template config is refused, or `null`. */
export function roadmapStartRefusal(terms: RoadmapTerms | null | undefined): string | null {
  const removed = removedFeatureOf(terms);
  return removed ? REMOVED_START_REFUSAL[removed] : null;
}

/**
 * Why a paused loop row cannot resume, or `null`. A row paused with a roadmap feature would otherwise
 * step on into a path this build does not have; its chain is unaffected, and stopping it —
 * which settles its channel — stays open.
 */
export function roadmapResumeRefusal(row: RoadmapTerms | null | undefined): string | null {
  const removed = removedFeatureOf(row);
  return removed
    ? `this loop cannot resume: it runs with ${REMOVED_NAME[removed]}, which is not in this build; ` +
        "its chain still verifies, and stopping it still settles its channel"
    : null;
}

/**
 * Why a Retry that landed everything a stopped run owed still leaves it stopped, or `null`. Putting the
 * run back on its schedule is a resume by another door (`retryUnderSlot`), so it is withheld from the
 * rows `roadmapResumeRefusal` refuses. The drain is not: the writes the run owed are its own chain's,
 * and they land whatever this build offers. The run keeps `anchor-failed` with this as its detail.
 */
export function roadmapRetryRefusal(row: RoadmapTerms | null | undefined): string | null {
  const removed = removedFeatureOf(row);
  return removed
    ? `this run's writes are on chain, but it stays stopped: it runs with ${REMOVED_NAME[removed]}, which is ` +
        "not in this build; its chain still verifies"
    : null;
}
