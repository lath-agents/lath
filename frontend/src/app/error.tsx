"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, Card, ErrorNote } from "@/components/ui";

/**
 * What a page shows when something in it throws while rendering, in place of a blank app.
 *
 * Without an error boundary, one throw anywhere in a page unmounts the whole tree: a single
 * malformed piece of data, which any wallet can publish, would blank a page for every visitor. This
 * is the floor under every reader that still assumes a type some chain data or gateway answer does
 * not have. The nav, the wallet and the layout stay up, and *Try again* re-renders the page without
 * a reload.
 *
 * The thrown message is logged, not printed: it can quote the data that caused it — React's
 * "Objects are not valid as a React child" names the object's keys, which a publisher chooses — and
 * a page should not hand a stranger a sentence on the visitor's screen.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Card title="This page could not be drawn" tone="rose">
      <div className="space-y-3" data-testid="page-error">
        <ErrorNote>
          Something on this page could not be read as the app expected, so it was not drawn. Your wallet was not asked
          for anything and nothing was sent.
          {error.digest && <span className="num ml-1 text-2xs">(digest {error.digest})</span>}
        </ErrorNote>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={reset} testId="page-error-retry">
            Try again
          </Button>
          <Link href="/" className="text-xs text-ink-2 transition-colors hover:text-ink-1">
            Back to the start page
          </Link>
        </div>
      </div>
    </Card>
  );
}
