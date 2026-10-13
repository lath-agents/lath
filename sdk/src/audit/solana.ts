/**
 * Solana as the audits read it: a landed transaction by signature, structural so the browser entry
 * needs no web3.js type, and the three-way status every check of it reports. The lifecycle audit
 * reads a deploy's transaction through it and the receipt audit reports in its statuses; the CLI's
 * `solanaTxReader` (`cli.ts`) is the implementation that holds a `Connection`.
 *
 * `PluginCheckStatus` is named for the protocol-plugin audit (`squads.pay`, `sas.attest`), which is
 * on the roadmap and not in this build; the lifecycle audit imports it under that name.
 */

/** One instruction of a landed transaction: the program, its accounts in order, its data (base64). */
export interface SolanaTxInstruction {
  programId: string;
  accounts: string[];
  data: string;
}

/** A landed transaction as the audit needs it. */
export interface SolanaTxView {
  slot: number;
  /** `null` when it succeeded. */
  err: unknown;
  signers: string[];
  instructions: SolanaTxInstruction[];
  /** Per token account owner and mint, post − pre, base units, decimal. */
  tokenDeltas: { owner: string; mint: string; delta: string }[];
}

/**
 * Reads a transaction by signature: `null` when the cluster has none, a throw when it cannot be
 * asked (which makes the check that asked `unchecked`). The CLI's implementation calls
 * `getTransaction` with `maxSupportedTransactionVersion: 1`, because devnet carries version-1
 * transactions.
 */
export interface SolanaTxReader {
  getTransaction(signature: string): Promise<SolanaTxView | null>;
}

/** A check's answer: `unchecked` when a reader did not answer, which is never `failed`. */
export type PluginCheckStatus = "ok" | "failed" | "unchecked";
