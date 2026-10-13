/**
 * `GET /api/solana` — the Solana half of what `GET /api/tempo/treasury` is for Tempo: the key this
 * console pays Solana fees from, how much SOL it holds, and whether the ZK-compression indexer every
 * agent read goes through answers. The workspace's Solana tab reads it.
 *
 * Public, because everything it reports is public: the fee payer's address and balance are a devnet
 * account anyone can read, and the indexer's health is a yes or no. The key never leaves
 * `loadKeypair()`, and the RPC url, which carries the operator's API key, never leaves the server: an
 * error that would quote it is reduced to a sentence first.
 *
 * Read once per window whatever the number of callers, as the treasury route does: the RPC is
 * the one every deploy and loop step writes through, and an anonymous poller must not spend it.
 */
import { Connection } from "@solana/web3.js";
import { CLUSTER, PHOTON_URL, RPC_URL, loadKeypair } from "../_lib/runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TTL_MS = 15_000;
const DEADLINE_MS = 8_000;

interface SolanaInfo {
  cluster: string;
  feePayer: { address: string; lamports: string | null; error?: string } | null;
  indexer: { healthy: boolean; error?: string };
  slot: number | null;
}

let cache: { at: number; value: Promise<SolanaInfo> } | null = null;

/** Never the url: an RPC client's message often quotes it, key and all. */
function plain(e: unknown): string {
  const message = (e as any)?.message ?? String(e);
  return message.replace(/https?:\/\/\S+/g, "the RPC").slice(0, 200);
}

function withDeadline<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("no answer in time")), DEADLINE_MS)),
  ]);
}

async function indexerHealth(): Promise<SolanaInfo["indexer"]> {
  if (!PHOTON_URL) return { healthy: false, error: "no indexer configured" };
  try {
    const res = await withDeadline(
      fetch(PHOTON_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIndexerHealth" }),
      })
    );
    if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    return body?.result === "ok"
      ? { healthy: true }
      : { healthy: false, error: plain(body?.error?.message ?? "not ok") };
  } catch (e) {
    return { healthy: false, error: plain(e) };
  }
}

async function read(): Promise<SolanaInfo> {
  const payer = loadKeypair();
  const connection = RPC_URL ? new Connection(RPC_URL, "confirmed") : null;
  const [feePayer, slot, indexer] = await Promise.all([
    (async (): Promise<SolanaInfo["feePayer"]> => {
      if (!payer) return null;
      const address = payer.publicKey.toBase58();
      if (!connection) return { address, lamports: null, error: "no RPC configured" };
      try {
        return { address, lamports: String(await withDeadline(connection.getBalance(payer.publicKey))) };
      } catch (e) {
        return { address, lamports: null, error: plain(e) };
      }
    })(),
    connection ? withDeadline(connection.getSlot()).catch(() => null) : Promise.resolve(null),
    indexerHealth(),
  ]);
  return { cluster: CLUSTER, feePayer, indexer, slot };
}

export async function GET() {
  const now = Date.now();
  if (!cache || now - cache.at >= TTL_MS) cache = { at: now, value: read() };
  return Response.json(await cache.value);
}
