"use client";

import { useEffect } from "react";

/**
 * A page's browser title from what it has read, as `‹title› · Lath` (the root layout's template).
 * For a page whose name is only known after a read — a loop's agent, an agent's name — which a
 * segment layout's static `metadata` cannot carry. The title it replaced comes back on unmount, so
 * the next page's own metadata is not left behind a stale name.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `${title} · Lath`;
    return () => {
      document.title = before;
    };
  }, [title]);
}
