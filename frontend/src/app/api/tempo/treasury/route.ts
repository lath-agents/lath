/**
 * `GET /api/tempo/treasury` — whose money pays for inference on the `tempo` rail here, how much
 * of it is left, and how many channels this process holds open on it.
 *
 * Public, because everything it reports is public: the treasury's address is an account on Tempo
 * mainnet anyone can read, and the channel count is this process's own. The key itself is never
 * here in any form — `tempoTreasury()` keeps it and only `address` leaves the module
 * (`_lib/tempo.ts`).
 *
 * It has nothing to say about *funded agents*: no agent has a wallet of its own, the treasury signs
 * every voucher, and what an operator wants to know is the balance and what is currently committed
 * against it. `openChannels` is per process and not per treasury — two consoles against one treasury
 * are unsupported and this number would not notice a second one.
 *
 * `enabled: false` is the answer whenever `LATH_TEMPO_TREASURY` is empty, which is the `--e2e`
 * pin and the ordinary state of a deployment that does not run the rail. The operator panel on
 * `/billing` renders nothing at all in that case: there is no operator money to account for.
 */
import {
  TEMPO_CHAIN_ID,
  TEMPO_USDC_E,
  httpRpc,
  openChannelCount,
  tempoTreasuryAddress,
  usdcBalance,
} from "../../_lib/tempo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The balance, shared by every caller for fifteen seconds — the `serverInfo` rule in `GET
 * /api/run`. This route is public and anonymous, and without the cache each GET would be one
 * `balanceOf` on Tempo's public RPC from the console's own address: the same endpoint and the same
 * address every money decision reads through (`tempoCanCover` before a session, `escrowState` before
 * a close, the loop keys' reads). Anyone polling it could spend that address's standing with the
 * RPC, and a throttled address degrades every billed session to scripted and leaves deposits locked
 * when a close cannot read its channel. One read in flight, and one per window, whatever the
 * number of callers; a failure is kept for the window too, so a caller cannot hammer an RPC that
 * is already refusing.
 */
const BALANCE_TTL_MS = 15_000;
let balanceCache: {
  address: string;
  at: number;
  value: Promise<{ balanceBase: string | null; balanceError?: string }>;
} | null = null;

function treasuryBalance(address: string): Promise<{ balanceBase: string | null; balanceError?: string }> {
  const now = Date.now();
  if (balanceCache && balanceCache.address === address && now - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.value;
  }
  // A balance the RPC would not answer is unknown, not zero: the panel says so rather than
  // showing an operator an empty treasury that is in fact full (the shape `/billing` uses for
  // every read it cannot make). Never a rejection, so nothing cached can fail a later caller.
  const value = usdcBalance(httpRpc(), address).then(
    (held) => ({ balanceBase: held.toString() }),
    (e: any) => ({ balanceBase: null, balanceError: e?.message ?? String(e) })
  );
  balanceCache = { address, at: now, value };
  return value;
}

export async function GET() {
  const address = tempoTreasuryAddress();
  if (!address) return Response.json({ enabled: false });

  const { balanceBase, balanceError } = await treasuryBalance(address);

  return Response.json({
    enabled: true,
    address,
    chainId: TEMPO_CHAIN_ID,
    token: TEMPO_USDC_E,
    balanceBase,
    ...(balanceError ? { balanceError } : {}),
    openChannels: openChannelCount(),
  });
}
