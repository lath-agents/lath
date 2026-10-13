"use client";

/**
 * The Tempo side's marks and its one link.
 *
 * Every Tempo surface carries the Tempo mark and every paid model call reads *OpenRouter via
 * Tempo*, so these are the two marks the screens use, at text size. `TempoLink` gives every Tempo
 * explorer link one look, the one Solana's `ExplorerLink` has.
 */

import { ReactNode } from "react";
import { truncate } from "@/lib/format";
import { tempoAddressUrl, tempoTxUrl } from "@/lib/tempo";
import { CopyButton, EXTERNAL_LINK_CLASS, ExternalIcon, Facts, Info } from "@/components/ui";

/**
 * The Tempo "T": the first path of the wordmark (`public/logos/tempo-wordmark.svg`), in `currentColor` so it takes the colour of the text it sits in. Em-sized, so it is as
 * tall as a capital wherever it is placed. Decorative unless given a `title`, because it almost
 * always stands beside the word *Tempo*, and a reader would hear the name twice.
 */
export function TempoMark({ title, className = "" }: { title?: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 44 46"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`inline-block flex-none ${className}`}
      style={{ width: "0.69em", height: "0.72em" }}
    >
      {title && <title>{title}</title>}
      <path d="M15.4218 45.2859H3.16805L14.5252 10.771H0L3.16805 0.654591H43.6354L40.4674 10.771H26.7192L15.4218 45.2859Z" />
    </svg>
  );
}

/**
 * OpenRouter's mark, its own 200×200 image drawn small and rounded. A plain `<img>`, as the rest of
 * the app has none and `next.config.mjs` sets no image loader: a 3.6 KB file served from `public/`
 * gains nothing from `next/image`'s resizing. Decorative unless given a `title`, like `TempoMark`.
 */
export function OpenRouterMark({
  title,
  size = 14,
  className = "",
}: {
  title?: string;
  size?: 14 | 15 | 16;
  className?: string;
}) {
  return (
    <img
      src="/logos/openrouter.jpg"
      width={size}
      height={size}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      title={title}
      className={`inline-block flex-none rounded-[3px] align-[-0.15em] ${className}`}
    />
  );
}

/**
 * Solana's mark, the three bars (`public/logos/solana.png`), drawn small. It sits beside the cluster in the nav's account chip, so Solana reads as the other chain
 * the way the Tempo pill reads as Tempo. It lives with the Tempo marks because they are the screens'
 * only brand marks, and a plain `<img>` like `OpenRouterMark`. Decorative unless given a `title`.
 */
export function SolanaMark({
  title,
  size = 14,
  className = "",
}: {
  title?: string;
  size?: 14 | 16;
  className?: string;
}) {
  return (
    <img
      src="/logos/solana.png"
      width={size}
      height={size}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      title={title}
      className={`inline-block flex-none align-[-0.15em] ${className}`}
    />
  );
}

/**
 * Irys's mark, the wordmark tile (`public/logos/irys.png`), drawn small and rounded like `OpenRouterMark` because it is a filled square. It marks the loop
 * start's Irys stages and the Files section, where Irys is where the sources are pinned. Decorative
 * unless given a `title`, like the others.
 */
export function IrysMark({ title, size = 14, className = "" }: { title?: string; size?: 14 | 16; className?: string }) {
  return (
    <img
      src="/logos/irys.png"
      width={size}
      height={size}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      title={title}
      className={`inline-block flex-none rounded-[3px] align-[-0.15em] ${className}`}
    />
  );
}

export type TempoLinkKind = "tx" | "address" | "token";

const KIND_NAME: Record<TempoLinkKind, string> = { tx: "Transaction", address: "Address", token: "Token" };

/**
 * The explorer page for a Tempo object. A token has no page of its own on explore.tempo.xyz; its
 * contract's address page is where its transfers are, so it opens that (U0b adds `tempoTokenUrl`
 * to `lib/tempo.ts`, which this switches to then).
 */
export function tempoLinkHref(kind: TempoLinkKind, value: string): string {
  return kind === "tx" ? tempoTxUrl(value) : tempoAddressUrl(value);
}

/**
 * One link to explore.tempo.xyz for a transaction, an address or a token: the Tempo mark, a short
 * value (`0xab12…cd34`) or the label, the external icon, and beside it an `Info` with the full value,
 * a copy button and anything the caller adds in `details` — the loop key's limit and expiry fold
 * there. The full value lives in the popover rather than in a native `title`
 * because a title cannot be selected, copied or reached by touch.
 */
export function TempoLink({
  kind,
  value,
  label,
  full = false,
  details,
  testId,
}: {
  kind: TempoLinkKind;
  value: string;
  /** Drawn in place of the short value, e.g. "settled" or "Lath treasury". */
  label?: ReactNode;
  /** The whole value rather than its ends. */
  full?: boolean;
  /** More rows for the popover, under the full value. */
  details?: ReactNode;
  testId?: string;
}) {
  const short = truncate(value, 6, 4);
  const name = KIND_NAME[kind];
  return (
    <span className="inline-flex max-w-full items-center gap-1 align-baseline" data-testid={testId}>
      <a
        href={tempoLinkHref(kind, value)}
        target="_blank"
        rel="noreferrer"
        data-tempo-kind={kind}
        aria-label={`${typeof label === "string" ? `${label}: ` : ""}${name} ${short} on the Tempo explorer`}
        className={EXTERNAL_LINK_CLASS}
      >
        <TempoMark />
        <span className={full ? "break-all" : "truncate"}>{label ?? (full ? value : short)}</span>
        <ExternalIcon />
      </a>
      <Info label={`${name} ${short} on Tempo`} wide>
        <div className="flex items-center gap-1.5 text-sm font-medium text-ink-1">
          <TempoMark /> {name} on Tempo
        </div>
        <div className="flex items-start gap-1">
          <code className="min-w-0 break-all font-mono text-2xs text-ink-1">{value}</code>
          <CopyButton value={value} />
        </div>
        {details}
        <Facts
          items={[
            {
              label: "Explorer",
              value: (
                <a href={tempoLinkHref(kind, value)} target="_blank" rel="noreferrer" className={EXTERNAL_LINK_CLASS}>
                  explore.tempo.xyz
                  <ExternalIcon />
                </a>
              ),
              source: "tempo",
            },
          ]}
        />
      </Info>
    </span>
  );
}
