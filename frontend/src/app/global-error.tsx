"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * The boundary for a throw in the root layout itself — the nav, the setup banner, the providers —
 * which `app/error.tsx` cannot catch because it renders inside that layout. It replaces the whole
 * document, so it brings its own `<html>` and `<body>` and depends on nothing the layout provides:
 * no wallet, no query client, no components that read either.
 *
 * Same rule as `app/error.tsx`: the message is logged, never printed, since it can quote data a
 * stranger chose.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center px-4">
        <div className="surface max-w-lg space-y-3 p-5" data-testid="global-error">
          <h1 className="text-sm font-semibold text-ink-1">Lath could not be drawn</h1>
          <p className="text-xs leading-relaxed text-ink-2">
            Something the app reads could not be read as it expected, so the page was not drawn. Your wallet was not
            asked for anything and nothing was sent.
            {error.digest && <span className="ml-1 font-mono text-2xs text-ink-3">(digest {error.digest})</span>}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-accent-strong"
            >
              Try again
            </button>
            {/* A plain anchor, not `next/link`: a full load is the point when the layout itself threw. */}
            <a href="/" className="text-xs text-ink-2 hover:text-ink-1">
              Reload the start page
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
