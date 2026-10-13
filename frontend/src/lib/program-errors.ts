/**
 * Which program refused a transaction, and the sentence a person gets for it.
 *
 * Anchor numbers every program's custom errors from 6000, in declaration order, so a number alone
 * names nothing: 6005 is `InsufficientBalance` in lath-billing, `InvalidBatchSize` in lath, and
 * something else again in the Light system program. Looking any 6000–6012 up in the billing table
 * would answer "Not enough spendable balance" for an error another program raised, and a deploy or
 * clone the Light system program refused would read as billing text too. So the program is
 * attributed first — from the log line `Program <id> failed: custom program error:
 * 0x…` — and a table is used only for the program it belongs to. A number with no program in the
 * text uses the caller's hint (the on-chain path carries only `{"Custom": n}`), and nothing falls
 * back to billing copy by number alone.
 *
 * The copy is keyed by variant *name*, and a code becomes a name through the program's IDL, which
 * `npm run sdk:sync` regenerates from the same enum. The offset is the ABI — an error inserted in
 * the middle of an enum renumbers every one after it — and keying by name is what keeps the copy
 * on the right error when that happens: a table keyed by number drifts, reading `BalanceRequired`
 * (6007) as a sweep error and every code after it one sentence off. `tests/console-reader.ts` pins every
 * name here against the IDLs.
 *
 * The copy is what the user can do about it, not what the program called it.
 *
 * No React, no config and no SDK import here, so the rule is a pure function a node test loads:
 * `lib/writes.ts` passes in the program ids and the IDLs' error lists.
 */

/** `BillingError` (`programs/lath-billing/src/lib.rs`), by variant name. */
export const BILLING_ERRORS: Record<string, string> = {
  Unauthorized: "That account is not yours to change.",
  ZeroAmount: "Enter an amount greater than zero.",
  Overflow: "The amount is out of range.",
  AllowanceExpired: "This allowance has expired — grant it again to keep the agent running.",
  AllowanceCapExceeded: "That would put the agent over its cap. Raise the cap first.",
  InsufficientBalance: "Not enough spendable balance. Top up, or wait for a reservation to be released.",
  NothingReserved: "Nothing is reserved to release.",
  BalanceRequired: "This grant still holds funds, so the balance they return to has to be part of the transaction.",
  AllowanceNotOutdated: "This allowance already has the current layout; there is nothing to migrate.",
  SweepExceedsSpent: "A sweep cannot exceed what has actually been metered.",
  SweepCapExceeded: "That sweep is over the per-call cap.",
  DailySweepCapExceeded: "That sweep is over the daily cap.",
  WrongMint: "That token account holds a different mint than the treasury's.",
  WrongVault: "The vault account does not match the treasury.",
  WrongDestination: "That is not the treasury's sweep destination.",
};

/** One program's side of the lookup: its id, its IDL's `errors`, and the copy for them. */
export interface ErrorTable {
  programId: string;
  errors: readonly { code: number; name: string }[];
  copy: Record<string, string>;
}

/**
 * The programs with a copy table: only billing in this build; a hint stays a name rather than a boolean so
 * another program's table is one entry.
 */
export type ErrorHint = "billing";

export interface ProgramError {
  /** The program whose log line failed first — the innermost CPI, where the error originated. */
  programId?: string;
  code?: number;
  /** Anchor's `Error Code: <Name>`, when the logs carry it. */
  name?: string;
}

/**
 * What the error text says about who refused and with what. The *first* `Program <id> failed:
 * custom program error` line wins: Solana logs a failed CPI from the inside out, so the first is
 * the program the error originated in and the ones after it only propagated it.
 */
export function programErrorOf(text: string): ProgramError {
  const out: ProgramError = {};
  const attributed = text.match(/Program (\w+) failed: custom program error: 0x([0-9a-f]+)/i);
  if (attributed) {
    out.programId = attributed[1];
    out.code = parseInt(attributed[2], 16);
  } else {
    const hexCode = text.match(/custom program error: 0x([0-9a-f]+)/i);
    const numbered = text.match(/Error Number: (\d+)/);
    // The on-chain failure path: `transaction failed on-chain: {"InstructionError":[i,{"Custom":n}]}`.
    const custom = text.match(/"Custom":\s*(\d+)/);
    if (hexCode) out.code = parseInt(hexCode[1], 16);
    else if (numbered) out.code = Number(numbered[1]);
    else if (custom) out.code = Number(custom[1]);
  }
  const named = text.match(/Error Code: (\w+)/);
  if (named) out.name = named[1];
  return out;
}

/**
 * The sentence for a custom program error, or `null` when the text carries none (the caller's
 * other rules — a declined prompt, a cluster mismatch, an expired blockhash — apply then).
 *
 * The table is chosen by the program the logs name; failing that, by the caller's `expect` hint,
 * which is only consulted when the text names no program at all. A program error nothing
 * attributes reads by name when Anchor logged one, and by number otherwise — never as another
 * program's copy.
 */
export function explainProgramError(
  text: string,
  tables: Record<ErrorHint, ErrorTable>,
  expect?: ErrorHint
): string | null {
  const e = programErrorOf(text);
  if (e.code === undefined && e.name === undefined) return null;
  const table = e.programId
    ? Object.values(tables).find((t) => t.programId === e.programId)
    : expect
    ? tables[expect]
    : undefined;
  if (table) {
    const name = (e.code !== undefined ? table.errors.find((x) => x.code === e.code)?.name : undefined) ?? e.name;
    if (name && table.copy[name]) return table.copy[name];
    if (name) return `The program refused this: ${name}${e.code !== undefined ? ` (error ${e.code})` : ""}.`;
  }
  if (e.name) return `The program rejected this: ${e.name}.`;
  return `The program refused this (error ${e.code}).`;
}
