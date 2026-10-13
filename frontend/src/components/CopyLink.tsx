"use client";

import { useState } from "react";
import { CheckIcon } from "@/components/ui";

/**
 * "Copy the link to *this row*" — the affordance that makes a verification citable.
 *
 * A record or an epoch is named by `?seq=N`; a step inside an epoch by `?prove=N`, which also
 * opens the epoch and computes the step's inclusion proof (`EventTimeline`). The url is built
 * from `window.location` at click time rather than at render: this component is rendered during
 * the server pass too, where there is no location, and the page's own query string must not
 * leak into the link it hands out.
 */
export function CopyLink({
  param,
  seq,
  what,
}: {
  /** `seq` names a row; `prove` names a step and asks for its proof. */
  param: "seq" | "prove";
  seq: bigint | number | string;
  /** What the link points at, for the accessible name: "record #12", "epoch #3", "step #57". */
  what: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="copy-link"
      title={`Copy link to ${what}`}
      aria-label={`Copy link to ${what}`}
      className={`inline-flex h-5 w-5 flex-none items-center justify-center rounded transition-colors hover:bg-line/[0.06] ${
        copied ? "text-spine-green" : "text-ink-3 hover:text-ink-1"
      }`}
      onClick={() => {
        const { origin, pathname } = window.location;
        // The tick only once the write resolved: a rejected write (no permission, an insecure context
        // with no `navigator.clipboard`) must not leave a tick saying copied over an empty clipboard.
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(`${origin}${pathname}?${param}=${seq.toString()}`))
          .then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => undefined
          );
      }}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
    </button>
  );
}

/** A chain link, distinct from `ui.tsx`'s copy-the-value clipboard icon: this copies a url. */
function LinkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5" aria-hidden>
      <path d="M6.5 9.5a2.5 2.5 0 0 0 3.6.1l2.1-2.1a2.5 2.5 0 0 0-3.5-3.5l-1.2 1.2" strokeLinecap="round" />
      <path d="M9.5 6.5a2.5 2.5 0 0 0-3.6-.1L3.8 8.5a2.5 2.5 0 0 0 3.5 3.5l1.2-1.2" strokeLinecap="round" />
    </svg>
  );
}
