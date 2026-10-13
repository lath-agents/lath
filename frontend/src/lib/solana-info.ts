import { useQuery, type UseQueryResult } from "@tanstack/react-query";

/**
 * `GET /api/solana`, as the Solana tab reads it: the console's fee payer and its SOL, the indexer's
 * health and the slot. The Solana counterpart of `useTempoTreasury` (`lib/tempo.ts`), with the same
 * rule for a route that did not answer: `unreachable` says so, and nothing is read as zero.
 */
export interface SolanaInfo {
  /** Set when the route did not answer — an HTTP status or the fetch's own error. Ours, not the route's. */
  unreachable?: string;
  cluster?: string;
  /** `null` when this console holds no runtime key. */
  feePayer?: { address: string; lamports: string | null; error?: string } | null;
  indexer?: { healthy: boolean; error?: string };
  slot?: number | null;
}

export function useSolanaInfo(): UseQueryResult<SolanaInfo> {
  return useQuery({
    queryKey: ["solana-info"],
    staleTime: 30_000,
    queryFn: async (): Promise<SolanaInfo> => {
      let res: Response;
      try {
        res = await fetch("/api/solana");
      } catch (e: any) {
        return { unreachable: e?.message ?? String(e) };
      }
      if (!res.ok) return { unreachable: `HTTP ${res.status}` };
      try {
        return (await res.json()) as SolanaInfo;
      } catch (e: any) {
        return { unreachable: `an unreadable answer (${e?.message ?? String(e)})` };
      }
    },
  });
}

/** Lamports to SOL, exact: nine decimals with the trailing zeros dropped. */
export function solText(lamports: string | bigint): string {
  const v = BigInt(lamports);
  const whole = v / BigInt(1_000_000_000);
  const frac = (v % BigInt(1_000_000_000)).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} SOL`;
}
