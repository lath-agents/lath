"use client";

import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { Workspace } from "@/components/Workspace";

/**
 * The workspace: the wallet's agents with their runs nested under them and the selected one open in
 * place, and Tempo as a tab — the page every visit starts on. `/agents`, `/loops`, `/market` and the `/zeroclaw` index redirect
 * here; the agent and loop pages stay, as deep links.
 *
 * The Suspense boundary is `useSearchParams`'s: the tab and the selection are in the URL, and a page
 * that reads them must give Next somewhere to wait while it renders the rest statically.
 */
export default function HomePage() {
  return (
    <Suspense fallback={<Skeleton rows={4} />}>
      <Workspace />
    </Suspense>
  );
}
