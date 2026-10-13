"use client";

/**
 * The console's registry, read in the browser: what this deployment has deployed, and for whom.
 *
 * The file is named for the marketplace, which is on the roadmap and not in this build; what it
 * holds here are the registry reads the rest of the app shares. `useDeployedAgents` and
 * `useAgentsRegistry` are both `GET /api/agents`, under two cache keys because their callers want
 * different shapes of it.
 */
import { useQuery, UseQueryResult } from "@tanstack/react-query";
import type { LoopChainView } from "@/types/loop";

/** One row of `GET /api/agents`: what this console has deployed, and for whom. */
export interface DeployedAgentRow {
  id: string;
  name: string;
  authority: string;
  owner?: string;
  policy: { model: string; tools: string[]; budgetCapUsdc: string; expirationDays: number };
  /**
   * Where the copy came from, when it is one. `via: "market"` marks a launch off someone else's
   * published offer on the marketplace (a roadmap feature this build does not write), which the
   * pages read as a copy; absent means the owner copied their own agent, and is also what every record written before
   * the distinction existed carries. Such a launch's record may also carry the `listing` it copied,
   * which nothing in this build reads.
   */
  clonedFrom?: { agentId: string; name: string; via?: "market" };
}

export const marketKeys = {
  deployed: () => ["market-deployed"] as const,
};

/**
 * The agents this console operates, with the wallet that owns each. The loop entry, the loop card,
 * *Compose a loop* and the workspace's agent panel filter it to the connected wallet; the server
 * checks ownership again on every write, so this is a filter for the screen, not the permission.
 */
export function useDeployedAgents(): UseQueryResult<DeployedAgentRow[]> {
  return useQuery({
    queryKey: marketKeys.deployed(),
    queryFn: async () => (await fetch("/api/agents")).json().then((r: any) => r.agents ?? []),
    staleTime: 30_000,
  });
}

/**
 * The console's whole registry in one read: live rows with the fields a tile's hover card reads,
 * and the ids that are archived. The Agents tab and Explore both join it, under one cache key.
 */
export function useAgentsRegistry(): UseQueryResult<{ archived: string[]; agents: RegistryAgent[] }> {
  return useQuery({
    queryKey: ["agents-registry"],
    queryFn: async () =>
      (await fetch("/api/agents")).json().then((r: any) => ({
        archived: (r.archived ?? []) as string[],
        agents: (r.agents ?? []) as RegistryAgent[],
      })),
    staleTime: 30_000,
  });
}

/**
 * A registry row as the tiles read it: `DeployedAgentRow` plus the three fields the hover card
 * wants and the console's GET does not promise yet. All optional, because a record written
 * without `description` has none, and a hover card missing a line is the right way for
 * that to show.
 */
export type RegistryAgent = DeployedAgentRow & {
  description?: string;
  template?: { id: string; version: number } | null;
  archivedAt?: number | null;
  /**
   * The agent's lifecycle records on its chain (`agent.deploy`, `agent.archive`, `agent.unarchive`,
   * `sdk/src/lifecycle.ts`), what is owed of them and the last owed write's error. Absent on a row
   * from before the records and from an older server, which the panel shows as no line at all.
   */
  chain?: AgentChainView;
};

/** A loop's `LoopChainView` without `rebuilt`: an agent row is never scheduled, so it has nothing to refuse. */
export type AgentChainView = Omit<LoopChainView, "rebuilt">;
