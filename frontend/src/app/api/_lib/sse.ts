/**
 * One server-sent event in the framing `/api/run` writes and `lib/loop-start-stream.ts` and the
 * chat's reader parse: `event:` line, `data:` line, blank line. A `bigint` in the frame — a lamport or
 * micro-USDC amount off a chain read — is written as its decimal string, because `JSON.stringify`
 * throws on one and a session would otherwise die mid-stream on its first charge. `_lib/loop-start.ts`
 * frames through this function too, not a copy, so a start whose `result` body carries a bigint
 * cannot throw where the run route does not.
 *
 * A leaf on purpose: the run route imports it without pulling in `loop-start`'s store reads.
 */
export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
}
