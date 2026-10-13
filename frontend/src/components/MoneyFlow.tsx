"use client";

/**
 * The money flow: three boxes, where a model call's
 * money comes from and where it goes.
 *
 *   Lath Agent Loop Budget · Solana  ──▶  [T] Lath treasury · Tempo  ──▶  [OR] OpenRouter via Tempo
 *
 * Presentational and props-only. It computes, rounds and invents no figure: every number and every
 * link arrives from the caller, which reads them, because *measured numbers only* is easiest to
 * keep when the drawing cannot make one up. A box with no figure
 * yet is the caller's to say — "—", "not paid (scripted)" — not this file's to guess.
 *
 * One colour and one type for all three: three boxes that read as one flow read better alike than in
 * one colour per chain, and each box's mark says its chain. `data-rail` still names it. Under 640 px the boxes stack
 * and the arrows turn downward, so the order still reads.
 */

import { ReactNode } from "react";
import { OpenRouterMark, SolanaMark, TempoMark } from "@/components/Tempo";

export interface MoneyFlowBox {
  /** Replaces the box's default title. */
  title?: ReactNode;
  /** The main figure, e.g. "0.30 USDC · 0.12 spent". */
  figure: ReactNode;
  /** One line under it, e.g. "paid in 9 calls". */
  sub?: ReactNode;
  /** Up to three links (`ExplorerLink`, `TempoLink`); more are not drawn. */
  links?: ReactNode[];
  /** A line under the links, e.g. the Tempo key that signed the box's payments. */
  extra?: ReactNode;
  testId?: string;
}

type Rail = "solana" | "tempo";

const BOX = "border-accent/25 bg-accent/[0.04] before:bg-accent";

function Box({
  rail,
  title,
  box,
  compact,
  defaultTestId,
}: {
  rail: Rail;
  title: ReactNode;
  box: MoneyFlowBox;
  compact: boolean;
  defaultTestId: string;
}) {
  const links = (box.links ?? []).slice(0, 3);
  return (
    <div
      data-testid={box.testId ?? defaultTestId}
      data-rail={rail}
      className={`relative min-w-0 flex-1 overflow-hidden rounded-lg border before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${BOX} ${
        compact ? "px-2.5 py-2" : "px-3.5 py-3"
      }`}
    >
      <div className={`flex items-center gap-1.5 font-medium text-accent-strong ${compact ? "text-2xs" : "text-xs"}`}>
        {box.title ?? title}
      </div>
      <div className={`num mt-1 min-w-0 break-words font-semibold text-ink-1 ${compact ? "text-xs" : "text-sm"}`}>
        {box.figure}
      </div>
      {box.sub && <div className="mt-0.5 text-2xs leading-4 text-ink-3">{box.sub}</div>}
      {links.length > 0 && (
        <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 ${compact ? "mt-1" : "mt-2"}`}>
          {links.map((l, i) => (
            <span key={i} className="min-w-0">
              {l}
            </span>
          ))}
        </div>
      )}
      {box.extra && <div className={`text-2xs text-ink-3 ${compact ? "mt-1" : "mt-2"}`}>{box.extra}</div>}
    </div>
  );
}

/**
 * The arrow between two boxes. `live` pulses it softly — the channel into OpenRouter is open and
 * paying now — and the pulse is `motion-safe` only, besides the global reduced-motion rule in
 * `globals.css`, so a reader who asked for less motion sees a steady arrow, not a frozen frame.
 */
function Arrow({ live = false }: { live?: boolean }) {
  return (
    <div
      aria-hidden
      data-live={live ? "true" : undefined}
      className={`flex flex-none items-center justify-center self-center ${
        live ? "text-accent motion-safe:animate-pulse" : "text-ink-3"
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-4 w-4 rotate-90 sm:rotate-0"
      >
        <path d="M2.5 8h11M9.5 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function MoneyFlow({
  cap,
  treasury,
  openrouter,
  footer,
  variant = "full",
  live = false,
  testId = "money-flow",
  className = "",
}: {
  /** Box 1: the owner's USDC cap on Solana. */
  cap: MoneyFlowBox;
  /** Box 2: Lath's treasury paying on Tempo. */
  treasury: MoneyFlowBox;
  /** Box 3: OpenRouter, paid through its Tempo gateway. */
  openrouter: MoneyFlowBox;
  /** One line under the boxes, e.g. "signed by this loop's key <TempoLink>". */
  footer?: ReactNode;
  /** `compact` for the workspace's run panel, `full` for the loop page. */
  variant?: "compact" | "full";
  /** The channel into OpenRouter is open and paying now. */
  live?: boolean;
  testId?: string;
  className?: string;
}) {
  const compact = variant === "compact";
  return (
    <div
      role="group"
      aria-label="Where the money goes"
      data-testid={testId}
      data-variant={variant}
      className={className}
    >
      <div className={`flex flex-col sm:flex-row sm:items-stretch ${compact ? "gap-1.5" : "gap-2"}`}>
        {/* Its chain's mark first, as the treasury's box has Tempo's. */}
        <Box
          rail="solana"
          title={
            <>
              <SolanaMark /> Lath Agent Loop Budget · Solana
            </>
          }
          box={cap}
          compact={compact}
          defaultTestId={`${testId}-cap`}
        />
        <Arrow />
        <Box
          rail="tempo"
          title={
            <>
              <TempoMark /> Lath treasury · Tempo
            </>
          }
          box={treasury}
          compact={compact}
          defaultTestId={`${testId}-treasury`}
        />
        <Arrow live={live} />
        <Box
          rail="tempo"
          title={
            <>
              <OpenRouterMark /> OpenRouter via Tempo
            </>
          }
          box={openrouter}
          compact={compact}
          defaultTestId={`${testId}-openrouter`}
        />
      </div>
      {footer && (
        <div className={`flex flex-wrap items-center gap-1.5 text-2xs text-ink-3 ${compact ? "mt-1.5" : "mt-2"}`}>
          {footer}
        </div>
      )}
    </div>
  );
}
