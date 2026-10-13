"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { TempoStats, TempoStatsError } from "../types/tempo-stats";

export type { TempoStats, TempoStatsActivity } from "../types/tempo-stats";
export { TEMPO_STATS_RECENT_LIMIT } from "../types/tempo-stats";

/**
 * What the Tempo tab has to draw: the figures, or the reason there are none.
 *
 * Never a throw. A 404 is a console without the route (an older server) or without a
 * treasury, and a 502 or a failed fetch is Tempo or the route not answering; each is a sentence the
 * tab shows in place of the figures, not a crash and not a row of zeros — zeros would be a claim
 * that the treasury paid nothing, which nobody established (the rule `useTempoTreasury` keeps).
 */
export type TempoStatsAnswer =
  | { stats: TempoStats; error?: undefined; status?: undefined }
  | { stats?: undefined; error: string; status?: number };

/**
 * `GET /api/tempo/stats`, read once per five minutes: the route caches its own answer for about ten,
 * since each one pages Tempo's public feed and reads every channel, so asking more often would only
 * return the same figures.
 */
export function useTempoStats(): UseQueryResult<TempoStatsAnswer> {
  return useQuery({
    queryKey: ["tempo-stats"],
    staleTime: 5 * 60_000,
    // Never rejects, so the query never retries either: a 404 is a route that is not there, and
    // asking it three more times would only delay the sentence that says so.
    queryFn: fetchTempoStats,
  });
}

/**
 * The read behind `useTempoStats`, which never throws: every way it can go wrong is a `TempoStatsAnswer`
 * with an `error`. Exported for `tests/tempo-stats-hook.ts`.
 */
export async function fetchTempoStats(): Promise<TempoStatsAnswer> {
  let res: Response;
  try {
    res = await fetch("/api/tempo/stats");
  } catch (e: any) {
    return { error: `the console did not answer (${e?.message ?? String(e)})` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const said = (body as TempoStatsError | null)?.error;
    return {
      status: res.status,
      error:
        typeof said === "string" && said
          ? said
          : res.status === 404
          ? "this console serves no Tempo figures"
          : `the console answered HTTP ${res.status}`,
    };
  }
  if (!isStats(body)) return { status: res.status, error: "the console's answer is not a set of Tempo figures" };
  return { stats: body };
}

/** Enough of the shape to draw from without a property read throwing; the route is ours, not a stranger's. */
function isStats(v: unknown): v is TempoStats {
  const s = v as TempoStats | null;
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.treasury === "string" &&
    !!s.channels &&
    typeof s.channels === "object" &&
    !!s.storage &&
    Array.isArray(s.recent)
  );
}
