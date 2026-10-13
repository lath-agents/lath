/**
 * The one sentence a caught value has to offer. An `Error`'s `message`; a thrown string, number
 * or `null` as `String()` writes it; and a plain object carrying a `message` (an RPC error body,
 * a cross-realm error) gives its message rather than `[object Object]`, which is why this reads
 * `.message` off anything instead of asking `instanceof Error`. `max` clips a provider's or a
 * gateway's page-long body before it lands in a refusal the console shows or a row a report stores.
 *
 * The runtime imports it wherever it reports a caught value, and the console's `_lib` reaches it
 * through `@lath/runtime`. Pure, no Node built-ins, so a browser page may use it.
 */
export function errorText(e: unknown, max?: number): string {
  const text = String((e as { message?: unknown } | null | undefined)?.message ?? e);
  return max === undefined ? text : text.slice(0, max);
}
