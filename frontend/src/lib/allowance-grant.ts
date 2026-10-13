/**
 * What the Allowance card may say and send, as a pure function of the allowance read.
 *
 * `approve_agent` writes `spent = 0` and the policy hash verbatim, so the hash a re-grant carries
 * has to be the one already on chain, and 32 zero bytes are right only for a first grant. Taking
 * `data ?? null` as the allowance would fold two different "no value yet" states into *none*: a read
 * that failed, and a read that has not come back. On devnet a read can stay pending for seconds (429
 * backoff plus a query retry) — long enough to press a preset and *Approve allowance* and sign a
 * zeroed hash over a live grant. Only a read that positively answered "no account" is *none* here;
 * anything short of an answer is *reading* or *unreadable*, and neither yields a hash to send.
 *
 * Kept free of React and of `@lath/sdk/browser` so the root Node suite can run it
 * (`tests/allowance-grant.ts`); the zero hash is spelled out below for that reason and is the same
 * 32 zero bytes as the SDK's `ZERO32`.
 */

/** The fields of a react-query result this reads; `status` rather than `isPending` so there is one source. */
export interface AllowanceQuery<A> {
  status: "pending" | "error" | "success";
  data?: A | null;
}

export type AllowanceRead<A> =
  | { kind: "reading" }
  | { kind: "unreadable" }
  | { kind: "none" }
  | { kind: "granted"; allowance: A };

export function readAllowance<A>(query: AllowanceQuery<A>): AllowanceRead<A> {
  // An error wins even when an earlier success left `data` behind: a background refetch that failed
  // means the card no longer knows what is on chain, and the older value may be the one that moved.
  if (query.status === "error") return { kind: "unreadable" };
  if (query.status !== "success") return { kind: "reading" };
  // `getAllowance` answers `null` for an account that does not exist; `undefined` on a success is not
  // that answer, so it is read as not-yet-read rather than as none.
  if (query.data === null) return { kind: "none" };
  if (query.data === undefined) return { kind: "reading" };
  return { kind: "granted", allowance: query.data };
}

/**
 * The policy hash an `approve_agent` from this card carries, or `null` when the card must not send
 * one: the grant's own hash on a re-grant, zeros only on a first grant the read said was absent.
 * A malformed hash is refused rather than padded, for the same reason a pending read is.
 */
export function grantPolicyHash(read: AllowanceRead<{ policyVersionHash: Uint8Array }>): Uint8Array | null {
  if (read.kind === "none") return new Uint8Array(32);
  if (read.kind !== "granted") return null;
  const hash = read.allowance.policyVersionHash;
  return hash instanceof Uint8Array && hash.length === 32 ? hash : null;
}
