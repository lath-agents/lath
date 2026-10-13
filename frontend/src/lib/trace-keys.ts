/**
 * The react-query keys a trace read is cached under (`useTrace`, `tracePartQuery` in
 * `lib/traces.ts`).
 *
 * The bytes are content-addressed, but a resolved trace is not only bytes: it carries chain facts
 * about *one agent's* registry — the locator account, the session bundle's key, cell and url, which
 * leg answered, and on a console with no raw gateway the `not-anchored` status that the timeline
 * prints as "No locator on chain for this hash". Identical hashes across agents are routine (two
 * copies of one blueprint asked the same thing; an empty-args blob), and the cache is app-wide with
 * a five-minute `staleTime`, so a key of hash and gateway alone would serve agent A's answer on
 * agent B's page without running B's read: A's `not-anchored` over a part B's sealed bundle holds,
 * or A's bundle offered as B's check link. So the agent is in the key, and so is the genesis that names the
 * session bundle, so a read made before the genesis was known cannot pin `not-anchored` for one that would
 * open the bundle.
 *
 * No imports, so `tests/trace-routing.ts` pins it; `lib/traces.ts` cannot be imported there.
 */
export interface TraceQueryScope {
  /** Hex `agent_id` whose registry the read resolves through, `""` with no reader. */
  agent: string;
  /** Hex genesis `payload_hash` naming the session bundle, `""` when the read has none. */
  genesis: string;
  /** The raw gateway the read may ask by hash; a different gateway is a different answer. */
  gateway: string | null | undefined;
}

/** `useTrace`'s key: one record's `payload_hash`, read through one agent's registry. */
export function traceQueryKey(payloadHash: string, scope: TraceQueryScope) {
  return ["trace", payloadHash, scope.gateway, scope.agent, scope.genesis] as const;
}

/** `tracePartQuery`'s key: one sub-hash, read through one agent's registry. */
export function tracePartQueryKey(hash: string | null, scope: TraceQueryScope) {
  return ["trace-part", hash, scope.gateway, scope.agent, scope.genesis] as const;
}
