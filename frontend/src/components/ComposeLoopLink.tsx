"use client";

import Link from "next/link";
import { Button } from "@/components/ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { useDeployedAgents } from "@/lib/market";

/**
 * *Compose a loop*: the link from an agent, or from one of its finished runs, to the loop form
 * with that agent already chosen (`/create?loop=1&agent=<id>`).
 *
 * A person decides "this should run on a schedule" while looking at the agent, and a form reachable
 * only by knowing the query string would leave the decision nowhere to go. This is a
 * link and nothing else — the signature, the terms and the refusals all belong to the form it
 * opens — shown only to the wallet that deployed the agent, for the same reason the form is: a step
 * is a session billed to that wallet's allowance and `/api/loops` refuses anyone else. An agent
 * this console did not deploy has no row and gets no link.
 */
export function ComposeLoopLink({ agentId, size = "sm" }: { agentId: string; size?: "sm" | "md" }) {
  const { publicKey } = useWallet();
  const deployed = useDeployedAgents();
  const row = deployed.data?.find((a) => a.id === agentId.toLowerCase()) ?? null;
  if (!row || !publicKey || row.owner !== publicKey.toBase58()) return null;

  return (
    <Link
      href={`/create?loop=1&agent=${row.id}`}
      data-testid="compose-loop"
      title="Open the loop form with this agent chosen: a standing instruction, an interval, a step count and one budget for the whole loop"
    >
      <Button variant="secondary" size={size}>
        Compose a loop
      </Button>
    </Link>
  );
}
