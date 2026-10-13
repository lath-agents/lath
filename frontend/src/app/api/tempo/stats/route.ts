/**
 * `GET /api/tempo/stats` — the operator treasury's lifetime figures on Tempo mainnet, the Tempo
 * tab's source: what `npm run -s tempo:stats` prints, plus the newest feed rows, in the shape
 * `types/tempo-stats.ts` fixes.
 * Public, because everything in it is: the treasury's activity feed on `api.tempo.xyz` and each
 * channel's `getChannelState` on the escrow over Tempo's free RPC. No key is read, nothing is signed,
 * nothing is spent; `tempoTreasuryAddress()` is the only thing taken from the treasury, and it is
 * the address. A GET, so the middleware's cross-site guard, which refuses only writes, lets every
 * page ask it.
 *
 * - **200** — the figures, from the cache (`_lib/tempo-stats.ts` `tempoStatsCache`): computed at most
 *   once per ten minutes, one computation shared by every caller who arrives while it runs, and the
 *   last good figures kept through a failed refresh, `computedAt` saying how old they are.
 *   `approximate: true` also covers a feed the rate limit cut short (below).
 * - **404** `{ error }` — `LATH_TEMPO_TREASURY` is empty (the `--e2e` pin, a deployment off the
 *   rail): there is no payer whose figures to read. `GET /api/tempo/treasury` answers `enabled:
 *   false` for the same state; this route answers the `TempoStatsError` its hook reads instead,
 *   because `useTempoStats` takes a 200 as a set of figures.
 * - **502** `{ error }` — Tempo's feed or RPC refused or failed, with no earlier figures to serve.
 * - **503** `{ error }` — the forty seconds a computation may take ran out, or the feed's rate
 *   window was spent, before anything had been read. A bound or a spent window that bites later
 *   serves what is held with `approximate: true`.
 *
 * The feed allows twenty requests a window and answers past them with 402, its MPP-paid tier, which
 * this route never pays. Walking the whole feed on every console start, ~14 pages for ~1 300 rows
 * with nothing kept across the restart, spends that window and leaves the tab on its error
 * sentence, so the feed is read incrementally and kept: `LATH_TRACE_DIR/tempo-stats.json` holds
 * every row read, the cursors still to resume, the settled channels and the last figures, written
 * atomically after each computation. A refresh pages from the newest row until it meets one it
 * holds — one request, two when a page's worth arrived — and stops before `ratelimit-remaining`
 * reaches zero; a restart serves the file's figures at once and refreshes behind them. The cold
 * walk, with no file, is the only one that pages the whole feed.
 *
 * The channel reads go to the RPC every money decision here also reads through, from the same
 * address (the balance-cache note in `../treasury/route.ts`), which is one reason for the cache: a
 * channel read as settled is not read again (`SETTLED_MEMO_AGE_MS`), so a refresh reads the few
 * that might still be open, and a failure stands for a minute before anyone asks again.
 */
import * as path from "path";
import { TRACE_DIR } from "../../_lib/runner";
import { escrowState, httpRpc, tempoTreasuryAddress } from "../../_lib/tempo";
import { TEMPO_STATS_FILE, answerTempoStats, persistentTempoStats } from "../../_lib/tempo-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const rpc = httpRpc();
const cached = persistentTempoStats({
  file: path.join(TRACE_DIR, TEMPO_STATS_FILE),
  deps: { reader: { channelState: (id) => escrowState(id, rpc) } },
});

export async function GET() {
  const { status, body } = await answerTempoStats(tempoTreasuryAddress(), cached);
  return Response.json(body, { status });
}
