import type { Metadata } from "next";
import type { ReactNode } from "react";

// The tab's own title ("%s · Lath" from the root template): its page is a client component,
// which cannot export metadata, so this segment layout carries it and renders nothing of its own.
export const metadata: Metadata = { title: "Loop" };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
