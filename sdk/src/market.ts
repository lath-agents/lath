/**
 * The tool ids the agent marketplace's records carried, and nothing else of it.
 *
 * The market (offers published as `agent.offer` Actions, launched copies, and the hire path) is not
 * in this build, and neither are its readers. These three ids are here because the console labels
 * the devnet rows that carry them (`eventmeta.ts`). Those rows replay through `verifyChain` as
 * ordinary `Action`s like any other.
 *
 * `canonicalJson` lives in `hash.ts`; it is re-exported here for the modules that import it from this one.
 */

/** `tool_id` of the `Action` that published an offer. */
export const OFFER_TOOL = "agent.offer";
/** `tool_id` of the caller's action that accompanied a `settle`. */
export const HIRE_SETTLED_TOOL = "hire.settled";
/** `tool_id` of the caller's action that accompanied a `release` — a hire that was not paid. */
export const HIRE_RELEASED_TOOL = "hire.released";

export { canonicalJson } from "./hash";
