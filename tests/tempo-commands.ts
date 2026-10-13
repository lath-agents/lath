/**
 * The Tempo _Check it yourself_ lines (`frontend/src/lib/tempo-commands.ts`), run through a
 * real shell and read back with the CLI's own flag rules, so a line on screen is one the tools it
 * names would take — the reason `check-commands.ts` is import-free too.
 *
 * `bash -c` runs each block with `npm` replaced by a function that prints its arguments,
 * so the quoting is the shell's and not this suite's guess at it; nothing is installed, fetched or
 * run. Each flag is then held to `USAGE` (`sdk/src/cli.ts`) for its subcommand, `--rpc` to the CLI's
 * `rpcArg`, and the stats line to `scripts/tempo-stats.ts`'s `parseArgs`. Node-only, no network.
 */
import { assert } from "chai";
import { execFileSync } from "child_process";
import { USAGE, rpcArg } from "../sdk/src/cli";
import { parseArgs } from "../scripts/tempo-stats";
import {
  keyAuditLine,
  shellWord,
  tempoStatsLine,
  verifyChannelLine,
  verifyChargeLine,
  type CommandReader,
} from "../frontend/src/lib/tempo-commands";

const READER: CommandReader = {
  rpcLine: 'R="https://devnet.helius-rpc.com/?api-key=…"   # a ZK-compression RPC for devnet',
  flags: ["  --gateway https://gateway.irys.xyz --scheme 4 --encoding base64url"],
  tempoRpc: "https://rpc.tempo.xyz",
};
const NO_GATEWAY: CommandReader = { ...READER, flags: [] };

const TREASURY = "0x18fbe5e0a83dca440072059f91d1a23babe6e0b0";
const PAYEE = "0xca4e835f803cb0b7c428222b3a3b98518d4779fe";
const CHANNEL = "0x31a142270f1dc5312e4c045f107048581b0d1c15887933f4a989a32f7b1e90bb";

/** The argv the shell hands `npm run -s audit --` (or `npm run -s tempo:stats`) for a block. */
function argvOf(command: string, _tool: "npm" = "npm"): string[] {
  // `npm run -s <script> -- …`: drop `run -s <script> --`, print the rest. Every block runs through
  // npm: `@lath/sdk` is not on npm, so `lath-audit` runs from a clone's `audit` script.
  const stub = `npm() { shift 3; if [ "$1" = "--" ]; then shift; fi; if [ $# -gt 0 ]; then printf '%s\\0' "$@"; fi; }`;
  const out = execFileSync("bash", ["-c", `${stub}\n${command}`], { encoding: "utf8" });
  return out.split("\0").slice(0, -1);
}

/** `arg` as `sdk/src/cli.ts` reads a valued flag: the next word, unless it is itself a flag. */
function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

/** `positionalsOf` as the CLI reads it: words that are neither a flag nor a flag's value. */
const positionals = (argv: string[]) =>
  argv.filter((v, i) => !v.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

/** The usage lines for one subcommand, from its `lath-audit <sub>` line to the next subcommand's. */
function usageOf(sub: string): string {
  const lines = USAGE.split("\n");
  const start = lines.findIndex((l) => l.includes(`lath-audit ${sub} `));
  assert.isAtLeast(start, 0, `USAGE lists ${sub}`);
  const end = lines.findIndex((l, i) => i > start && /lath-audit [a-z-]+ </.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const flagsOf = (argv: string[]) => argv.filter((a) => a.startsWith("--"));

describe("Check it yourself: the Tempo commands", () => {
  it("builds verify-channel with the flags the CLI takes for it, and nothing it does not", () => {
    const { command, checks } = verifyChannelLine(
      "agent-alpha",
      { channel: CHANNEL, payer: TREASURY, payee: PAYEE, key: true },
      READER
    );
    const argv = argvOf(command, "npm");
    assert.equal(argv[0], "verify-channel");
    const rest = argv.slice(1);
    assert.equal(arg(rest, "name"), "agent-alpha");
    assert.deepEqual(positionals(rest), [], "named by --name, so no positional id the CLI would read first");
    assert.equal(arg(rest, "channel"), CHANNEL);
    assert.equal(arg(rest, "payer"), TREASURY);
    assert.equal(arg(rest, "payee"), PAYEE);
    assert.equal(arg(rest, "tempo-rpc"), "https://rpc.tempo.xyz", "the T= line feeds --tempo-rpc");
    assert.equal(arg(rest, "gateway"), "https://gateway.irys.xyz");
    assert.include(rest, "--key");
    // `$R` is the reader's url, placeholder key and all; the CLI's own reader of --rpc takes it.
    assert.equal(
      rpcArg(rest, {}, () => "unused"),
      "https://devnet.helius-rpc.com/?api-key=…"
    );
    const usage = usageOf("verify-channel");
    for (const f of flagsOf(rest)) assert.include(usage, `${f}`, `${f} is a verify-channel flag`);
    assert.match(checks, /^[A-Z][^\n]+\.$/, "one sentence");
    assert.include(checks, "the payment channel named");
    assert.include(checks, "the payee given");
    assert.include(checks, "access key");
  });

  it("leaves out every optional flag it was not given, and says what it checks without them", () => {
    const { command, checks } = verifyChannelLine("agent-alpha", {}, NO_GATEWAY);
    const rest = argvOf(command, "npm").slice(1);
    assert.deepEqual(flagsOf(rest), ["--name", "--rpc", "--tempo-rpc"]);
    assert.include(checks, "every payment channel this agent's chain paid through");
    assert.include(checks, "the payee of the chain's first verified channel");
    assert.notInclude(checks, "access key");
  });

  it("builds verify-charge with its own pins", () => {
    const { command, checks } = verifyChargeLine("agent-alpha", { payer: TREASURY, recipient: PAYEE }, READER);
    const argv = argvOf(command, "npm");
    assert.equal(argv[0], "verify-charge");
    const rest = argv.slice(1);
    assert.equal(arg(rest, "name"), "agent-alpha");
    assert.equal(arg(rest, "payer"), TREASURY);
    assert.equal(arg(rest, "recipient"), PAYEE);
    assert.equal(arg(rest, "tempo-rpc"), "https://rpc.tempo.xyz");
    assert.notInclude(rest, "--payee", "the storage gateway is --recipient here, not --payee");
    const usage = usageOf("verify-charge");
    for (const f of flagsOf(rest)) assert.include(usage, f, `${f} is a verify-charge flag`);
    assert.match(checks, /^[A-Z][^\n]+\.$/);
    assert.include(checks, "the recipient given");
    assert.include(verifyChargeLine("a", {}, READER).checks, "the recipient of the chain's first paid charge");
  });

  it("builds the chain audit with --key, after every valued flag", () => {
    const { command, checks } = keyAuditLine("agent-alpha", { payer: TREASURY }, READER);
    const argv = argvOf(command, "npm");
    // No subcommand: the audit itself, named by --name.
    assert.equal(argv[0], "--name");
    assert.equal(arg(argv, "name"), "agent-alpha");
    assert.deepEqual(positionals(argv), []);
    assert.equal(arg(argv, "payer"), TREASURY);
    assert.equal(arg(argv, "tempo-rpc"), "https://rpc.tempo.xyz");
    assert.deepEqual(
      argv.slice(-2),
      ["--require-preimages", "--key"],
      "the gateway asks for the preimages, as auditCommand"
    );
    // The audit's flags are spread over USAGE's first block and the [--key] line, so the whole of it.
    for (const f of flagsOf(argv)) assert.include(USAGE, f);
    assert.include(checks, "with every preimage re-hashed");
    const bare = keyAuditLine("agent-alpha", {}, NO_GATEWAY);
    assert.deepEqual(argvOf(bare.command, "npm").slice(-1), ["--key"]);
    assert.notInclude(bare.checks, "preimage", "without a gateway it reads none, and does not say it does");
  });

  it("keeps a name with a space or a quote one argument, so it audits that agent and not another", () => {
    for (const name of ["my agent", "it's mine", "a$b `c`", 'say "hi"']) {
      assert.equal(arg(argvOf(verifyChannelLine(name, {}, READER).command, "npm").slice(1), "name"), name);
      assert.equal(arg(argvOf(verifyChargeLine(name, {}, READER).command, "npm").slice(1), "name"), name);
      assert.equal(arg(argvOf(keyAuditLine(name, {}, READER).command, "npm"), "name"), name);
    }
    assert.equal(shellWord("agent-alpha"), "agent-alpha", "a plain name reads as the usage prints it");
  });

  it("builds tempo:stats as scripts/tempo-stats.ts parses it, key-free with --address", () => {
    const { command, checks } = tempoStatsLine({ address: TREASURY, since: "2026-10-06", json: true });
    assert.match(command, /^# from a checkout of the Lath repository/);
    const argv = argvOf(command, "npm");
    const parsed = parseArgs(argv);
    assert.equal(parsed.address, TREASURY);
    assert.equal(parsed.since?.toISOString().slice(0, 10), "2026-10-06");
    assert.isTrue(parsed.json);
    assert.match(checks, /^[A-Z][^\n]+\.$/);
    assert.include(checks, "signing nothing");
    // Nothing given: the bare script, which derives the treasury from the operator's key.
    assert.deepEqual(argvOf(tempoStatsLine().command, "npm"), []);
    assert.include(tempoStatsLine().command, "npm run -s tempo:stats");
  });
});
