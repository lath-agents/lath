/**
 * `scripts/tempo-stats.ts` — what the operator's Tempo treasury has paid on Tempo mainnet, read
 * from Tempo itself, for the submission's Tempo line.
 *
 *   npm run -s tempo:stats                          # the treasury LATH_TEMPO_TREASURY names
 *   npm run -s tempo:stats -- --address 0x…         # any payer; no key needed
 *   npm run -s tempo:stats -- --since 2026-10-06 --json
 *
 * Two public sources and nothing else:
 *
 * - the address's activity feed on `api.tempo.xyz` — channel opens, channel top-ups, refunds the
 *   escrow sends back at a close, storage charges (attributed "Object Storage"), and the owner's
 *   top-ups of the treasury;
 * - per channel, `getChannelState` on the escrow precompile. A closed channel reads as zeros
 *   and an open one still holds what it has not settled, so this read is what separates
 *   money paid from money parked.
 *
 * The sorting, the arithmetic and the reads are `frontend/src/app/api/_lib/tempo-stats.ts`, shared
 * with `GET /api/tempo/stats` so the console's Tempo tab and this line cannot disagree; this file is
 * the flags, the address and the printout.
 *
 * Nothing is signed and nothing is spent. The key, when the address comes from it, is used only
 * to derive the address; `--address` needs no key at all, so anyone can check the figures.
 *
 * What it cannot say: how many model calls those channels paid. Vouchers never reach the chain,
 * so the call count lives in the Solana records (`lath-audit verify-channel`), not here. And the
 * figures are the treasury's, whoever's loop spent them — the line that quotes them must say
 * who ran those loops (memory: team-run counts are labelled as such).
 */
import * as fs from "fs";
import * as path from "path";
import { TEMPO_RPC_URL, TempoRpcReader } from "../sdk/src";
import {
  TEMPO_API_URL,
  fetchActivities,
  readStates,
  statsDays,
  summarize,
  usdc,
  classify,
  type ChannelState,
  type Stats,
} from "../frontend/src/app/api/_lib/tempo-stats";

// The core lives in `_lib/tempo-stats.ts` so `GET /api/tempo/stats` serves the same figures this
// prints; it is re-exported so the suites that read it here keep reading it.
export {
  TEMPO_API_URL,
  classify,
  summarize,
  usdc,
  type Activity,
  type ChannelState,
  type Classified,
  type Kind,
  type Stats,
} from "../frontend/src/app/api/_lib/tempo-stats";

export interface Args {
  address?: string;
  since?: Date;
  json: boolean;
  api: string;
  tempoRpc: string;
  /** Skip the per-channel escrow reads: faster, but paid and parked can no longer be told apart. */
  noState: boolean;
}

export function parseArgs(argv: string[]): Args {
  const val = (flag: string) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const since = val("--since");
  const sinceDate = since ? new Date(since) : undefined;
  if (sinceDate && Number.isNaN(sinceDate.getTime())) throw new Error(`--since ${since} is not a date`);
  const address = val("--address");
  if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`--address ${address} is not an address`);
  return {
    ...(address ? { address } : {}),
    ...(sinceDate ? { since: sinceDate } : {}),
    json: argv.includes("--json"),
    api: val("--api") ?? TEMPO_API_URL,
    tempoRpc: val("--tempo-rpc") ?? TEMPO_RPC_URL,
    noState: argv.includes("--no-state"),
  };
}

/**
 * The treasury's address, derived the way the console derives it: `LATH_TEMPO_TREASURY` (a key
 * or a file holding one), else the repo's `.tempo-treasury.key` as `scripts/dev-devnet.sh` uses.
 * Only the address leaves this function.
 */
async function treasuryAddress(): Promise<string | null> {
  const fallback = path.join(__dirname, "..", ".tempo-treasury.key");
  if (!process.env.LATH_TEMPO_TREASURY && fs.existsSync(fallback)) process.env.LATH_TEMPO_TREASURY = fallback;
  if (!process.env.LATH_TEMPO_TREASURY) return null;
  const { tempoTreasuryAddress } = await import("../frontend/src/app/api/_lib/tempo");
  return tempoTreasuryAddress();
}

function report(s: Stats, since?: Date): string {
  const line = (label: string, value: string) => `  ${label.padEnd(36)} ${value}`;
  const days = statsDays(s);
  return [
    `Tempo mainnet, payer ${s.address}${since ? ` since ${since.toISOString().slice(0, 10)}` : ""}`,
    `  ${s.rows} activity rows, ${s.from ?? "-"} → ${s.to ?? "-"} (${days} days)`,
    "",
    line("MPP channels opened", `${s.channels.opened}`),
    line("  closed (settled) / open / unread", `${s.channels.closed} / ${s.channels.open} / ${s.channels.unknown}`),
    line("deposited into channels", `${usdc(s.depositedBase)} USDC.e`),
    line("refunded by the escrow at close", `${usdc(s.refundedBase)} USDC.e`),
    line("parked in open channels", `${usdc(s.parkedBase)} USDC.e`),
    line(
      "paid through channels",
      `${usdc(s.channelPaidBase)} USDC.e${s.approximate ? " (approximate: unread channels)" : ""}`
    ),
    line("storage charges", `${s.storage.count} · ${usdc(s.storage.base)} USDC.e`),
    line("paid to MPP services in all", `${usdc(s.paidBase)} USDC.e`),
    "",
    line("treasury top-ups received", `${s.topups.count} · ${usdc(s.topups.base)} USDC.e`),
    line("other outgoing transfers", `${s.otherOut.count} · ${usdc(s.otherOut.base)} USDC.e`),
    ...(s.other ? [line("rows not in USDC.e or not sorted", `${s.other}`)] : []),
    "",
    "  Model calls are not counted here: vouchers stay off chain; count them from the Solana records.",
    "  These are the treasury's payments, whoever ran the loops; say who ran them when quoting them.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const address = args.address ?? (await treasuryAddress());
  if (!address) {
    console.error("no address: pass --address 0x…, or set LATH_TEMPO_TREASURY (a key or a file holding one)");
    process.exit(2);
  }
  const all = await fetchActivities(args.api, address);
  const rows = all.filter((r) => !args.since || Date.parse(r.timestamp) >= args.since.getTime()).map(classify);
  const ids = [...new Set(rows.filter((r) => r.channelId).map((r) => r.channelId!))];
  const states = args.noState
    ? new Map<string, ChannelState | null>()
    : await readStates(new TempoRpcReader({ url: args.tempoRpc }), ids);
  const stats = summarize(address, rows, states);
  if (args.json) {
    console.log(JSON.stringify(stats, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    console.log(report(stats, args.since));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
