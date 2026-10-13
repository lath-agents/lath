/**
 * The Tempo half of _Check it yourself_: the
 * `lath-audit` lines that recheck a loop's payments off this machine, and the `tempo:stats` line that
 * recounts the treasury's, each with the one sentence of what it checks.
 *
 * Pure string builders, free of imports for the reason `check-commands.ts` is: the root tsconfig can
 * load this file, so `tests/tempo-commands.ts` parses every line it builds with the CLI's own flag
 * rules rather than only reading it. `verify.ts` fills in the two things that come from the page's
 * config — the reader's `R=` line and the gateway flags for the chain's scheme — and re-exports the
 * builders, so a component imports them from where it imports `auditCommand`.
 *
 * Every flag here is one `sdk/src/cli.ts` `USAGE` lists for that subcommand, and each `checks`
 * sentence is that subcommand's, from its usage and `sdk/src/audit/channels.ts` / `charges.ts`: what
 * the command holds against what, never what it prints. Nothing here signs or spends; all four are
 * reads of public chains.
 */

/** One copyable command and what it checks, in one plain sentence. */
export interface CheckCommand {
  command: string;
  checks: string;
}

/** What `verify.ts` derives from the page's config, handed in so this file stays import-free. */
export interface CommandReader {
  /** The `R=` line: the reader's own ZK-compression RPC, never the operator's key. */
  rpcLine: string;
  /** The reader flags for the chain's scheme (`--gateway … --scheme … --encoding …`), one per line. */
  flags: readonly string[];
  /** Tempo's RPC, public; filled into a `T=` line. */
  tempoRpc: string;
}

export interface VerifyChannelOptions {
  /** One channel (`0x…`, 32 bytes) instead of every channel the chain paid through. */
  channel?: string | null;
  /** The address every voucher must name: the operator's Tempo treasury on a v2 chain. */
  payer?: string | null;
  /** The address every close must have paid: the model gateway's payee. */
  payee?: string | null;
  /** Ask for the loop's Tempo access-key line by name, so a chain whose policy commits none says so. */
  key?: boolean;
}

export interface VerifyChargeOptions {
  /** Pins every storage receipt's payer; without it, the chain's own vouchers' payer. */
  payer?: string | null;
  /** Pins every storage receipt's recipient: the storage gateway's payee. */
  recipient?: string | null;
}

export interface KeyAuditOptions {
  payer?: string | null;
  payee?: string | null;
}

export interface TempoStatsOptions {
  /** Any payer; without it the script derives the treasury from `LATH_TEMPO_TREASURY`, a key. */
  address?: string | null;
  /** `YYYY-MM-DD`: only feed rows from then on. */
  since?: string | null;
  json?: boolean;
}

// `@lath/sdk` is not published to npm, so `npx @lath/sdk` 404s: `lath-audit` runs from a clone of the repository,
// through its `audit` script, which is what the README's _Check it yourself_ runs.
export const LATH_AUDIT = "npm run -s audit --";
/** The line every audit block opens with: where the command runs. */
export const LATH_AUDIT_WHERE = "# in a clone of https://github.com/lath-agents/lath, after npm ci";

/**
 * A value as one shell word. Agent names are free text (a space, a quote), and a command that
 * splits one into two arguments audits a different agent, `idFromString` of the first word. Plain
 * words stay bare so the common line reads the way the CLI's usage prints it.
 */
export function shellWord(value: string): string {
  if (/^[A-Za-z0-9._:/@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `--flag value` when there is a value, else nothing. */
const opt = (flag: string, value: string | null | undefined) => (value ? ` --${flag} ${shellWord(value)}` : "");

/** The block every payment line shares: the `R=` and `T=` lines, then the command over its lines. */
function block(reader: CommandReader, lines: string[]): string {
  return [LATH_AUDIT_WHERE, reader.rpcLine, `T="${reader.tempoRpc}"`, lines.join(" \\\n")].join("\n");
}

/**
 * `lath-audit verify-channel --name <agent>` — every channel the chain paid through, or one: its
 * vouchers' deltas, the decisions' included, against what the escrow's `ChannelClosed` paid out.
 */
export function verifyChannelLine(agentName: string, opts: VerifyChannelOptions, reader: CommandReader): CheckCommand {
  const lines = [
    `${LATH_AUDIT} verify-channel --name ${shellWord(agentName)}` + opt("channel", opts.channel),
    `  --rpc "$R" --tempo-rpc "$T"` + opt("payer", opts.payer) + opt("payee", opts.payee),
    // The vouchers live in the blobs, so without the gateway the line could only say "no preimage".
    ...reader.flags,
    // Last, after every valued flag: the CLI takes the word after any `--flag` as that flag's value,
    // so a bare flag is only unambiguous where no value follows it.
    ...(opts.key ? ["  --key"] : []),
  ];
  const which = opts.channel ? "the payment channel named" : "every payment channel this agent's chain paid through";
  const to = opts.payee ? "the payee given" : "the payee of the chain's first verified channel";
  return {
    command: block(reader, lines),
    checks:
      `Adds up the vouchers the chain committed on ${which}, the decision model's included, and checks that ` +
      `the total is what Tempo's escrow paid out when it closed, in USDC.e, to ${to} and not back to the payer` +
      (opts.key ? ", and that the loop's Tempo access key is the signer every channel was opened with." : "."),
  };
}

/**
 * `lath-audit verify-charge --name <agent>` — every Tempo storage PUT a loop recorded, held to the
 * one Tempo transfer its receipt names.
 */
export function verifyChargeLine(agentName: string, opts: VerifyChargeOptions, reader: CommandReader): CheckCommand {
  const lines = [
    `${LATH_AUDIT} verify-charge --name ${shellWord(agentName)}`,
    `  --rpc "$R" --tempo-rpc "$T"` + opt("payer", opts.payer) + opt("recipient", opts.recipient),
    ...reader.flags,
  ];
  return {
    command: block(reader, lines),
    checks:
      "Re-hashes every Tempo storage payment the chain recorded and checks that the Tempo transaction its " +
      `receipt names moved that amount of USDC.e from the payer to ${
        opts.recipient ? "the recipient given" : "the recipient of the chain's first paid charge"
      }, with no transaction counted twice and each step's snapshot and receipt paired with its step.`,
  };
}

/**
 * `lath-audit --name <agent> --key` — the chain audit with the loop key's checks beside it
 * Shaped like `auditCommand`: with a gateway it
 * asks for the preimages too, and an owner-encrypted agent then needs `--trace-key`, which the page
 * never holds for a visitor.
 */
export function keyAuditLine(agentName: string, opts: KeyAuditOptions, reader: CommandReader): CheckCommand {
  const lines = [
    `${LATH_AUDIT} --name ${shellWord(agentName)}`,
    `  --rpc "$R" --tempo-rpc "$T"` + opt("payer", opts.payer) + opt("payee", opts.payee),
    ...reader.flags,
    ...(reader.flags.length > 0 ? ["  --require-preimages --key"] : ["  --key"]),
  ];
  return {
    command: block(reader, lines),
    checks:
      `Replays this agent's hash chain to its head on Solana${
        reader.flags.length > 0 ? " with every preimage re-hashed" : ""
      }, and checks that the Tempo access key the loop's policy commits, if it commits one, was authorized on the ` +
      "payer with the committed limit and expiry and is the signer every channel was opened with and every voucher names.",
  };
}

/**
 * `npm run -s tempo:stats` — the treasury's lifetime figures, from Tempo's public activity feed and
 * the escrow (`scripts/tempo-stats.ts`). A repository script, not part of `@lath/sdk`, so the line
 * says where it runs; `--address` makes it key-free, which is what a reader without the operator's
 * key needs.
 */
export function tempoStatsLine(opts: TempoStatsOptions = {}): CheckCommand {
  const args = [opt("address", opts.address), opt("since", opts.since), opts.json ? " --json" : ""].join("");
  return {
    command: [
      "# from a checkout of the Lath repository, after npm ci",
      `npm run -s tempo:stats${args ? ` --${args}` : ""}`,
    ].join("\n"),
    checks:
      "Reads the treasury's public activity feed on api.tempo.xyz and each channel's escrow state over Tempo's " +
      "RPC, and totals the channels opened, settled and still open, the USDC.e deposited, paid through " +
      "channels and refunded, and the storage charges, signing nothing.",
  };
}
