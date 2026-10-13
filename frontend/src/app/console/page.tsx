"use client";

/**
 * There is no separate console screen: an agent's page *is* its console. The route stays because
 * links to it exist, and it lands on the agent this server writes by default — the one whose
 * chat, chain writes, epochs and audit make up the console's session.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ownerHref, useRunnerInfo } from "@/lib/console-stream";

export default function ConsolePage() {
  const router = useRouter();
  const info = useRunnerInfo();

  const top = info.data?.agents?.[0];

  useEffect(() => {
    if (top) router.replace(ownerHref(top.id));
  }, [router, top]);

  return (
    <div className="p-8 text-center text-sm text-neutral-400" data-testid="console-redirect">
      {info.isLoading
        ? "Finding the agent this server runs…"
        : top
        ? `Opening ${top.name}…`
        : `This server runs no agent: ${info.data?.reason ?? "no runtime keypair"}. Deploy one from the Agents page.`}
    </div>
  );
}
