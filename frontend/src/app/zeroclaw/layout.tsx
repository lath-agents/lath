import type { Metadata } from "next";
import type { ReactNode } from "react";

// The tab's own title ("%s · Lath" from the root template): its page is a client component,
// which cannot export metadata, so this segment layout carries it and renders nothing of its own.
// The segment's only page is one sandbox's proof (`/zeroclaw/<loopId>`), reached from a run's
// Proof; `/zeroclaw` itself is a redirect to the workspace.
export const metadata: Metadata = { title: "Sandbox proof" };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
