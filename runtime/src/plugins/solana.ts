/**
 * What `sas.ts`'s `sasFailure` reads a failure with: the program error code, from whatever shape the
 * failure arrived in.
 */

/**
 * The custom program error a failure carries, from any of the shapes web3.js hands it over in: a
 * transaction `err` (`{ InstructionError: [i, { Custom: n }] }`), a `SendTransactionError` whose
 * message or logs say `custom program error: 0x…` or Anchor's `Error Number: n`. Anchor's line is
 * preferred because it names the program that raised it; `undefined` when there is none.
 */
export function programErrorCode(failure: unknown): number | undefined {
  if (failure && typeof failure === "object") {
    const ie = (failure as { InstructionError?: unknown }).InstructionError;
    if (Array.isArray(ie) && ie[1] && typeof ie[1] === "object") {
      const custom = (ie[1] as { Custom?: unknown }).Custom;
      if (typeof custom === "number") return custom;
    }
  }
  const texts: string[] = [];
  if (failure instanceof Error) texts.push(failure.message);
  else if (typeof failure === "string") texts.push(failure);
  const logs = failure && typeof failure === "object" ? (failure as { logs?: unknown }).logs : undefined;
  if (Array.isArray(logs)) texts.push(...logs.filter((l): l is string => typeof l === "string"));
  const all = texts.join("\n");
  const anchor = /Error Number: (\d+)/.exec(all);
  if (anchor) return Number(anchor[1]);
  const custom = /custom program error: 0x([0-9a-fA-F]+)/.exec(all);
  if (custom) return parseInt(custom[1], 16);
  return undefined;
}
