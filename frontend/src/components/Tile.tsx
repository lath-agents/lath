"use client";

/**
 * The tile the Agents and Loops tabs lay out in a grid.
 *
 * One component for both tabs, because the two rows are the same facts: a kind chip, the name and
 * a status dot, two clamped lines of description, a 24 h sparkline, and a foot that carries
 * `seq · last write` on one side and the row's relation or terms on the other. What differs
 * between the tabs is the join that built the `TileRow`, not the drawing, which is why
 * `lib/tiles.ts` is where the sources live and this file takes a row and renders it.
 *
 * Three things here are contracts with code outside this file:
 *
 * 1. `data-testid="owner-row"` / `"loop-row"` and `data-agent-id` / `data-loop-id` sit **on the
 *    tile element**. Playwright specs resolve rows by those handles, and they keep resolving when
 *    the grid is the default view.
 * 2. A click is a `Link` to the record's own page. The ⓘ card is the summary; the record is
 *    `/agent/[id]` or `/loop/[id]`, and there is no drawer.
 * 3. The card is an `Info` (`components/ui.tsx`), a portal at the viewport, not a child of the
 *    tile: a tile inside a grid with `overflow` of its own would clip it, and a popover that gets
 *    clipped reads as a bug. It keeps `data-testid="tile-hover-card"`.
 *
 * The card hangs off an ⓘ in the tile's top row — the name is already the tile's link, and a button
 * cannot sit inside one — which opens on hover, focus, click or tap and stays open while the pointer
 * is on it. A card that opened on the tile's own hover and closed on its `mouseleave` could never be
 * reached by the pointer, and a touch could not open it at all.
 */

import { ReactNode, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Facts, Info, SourceTag } from "@/components/ui";
import { bins24, SPARKLINE_BINS, TileField, TileRow, TileTone } from "@/lib/tiles";
import { useEvents } from "@/lib/queries";

/* ------------------------------------------------------------------------------------------ */
/* Sparkline                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const SPARK_WIDTH = 140;
const SPARK_HEIGHT = 28;
const SPARK_GAP = 1.5;

/**
 * 24 hourly bins as bars, hand-rolled the way `SpendChart.tsx` is: six to twenty-four rectangles
 * with no axes is not what a charting dependency is for, and `frontend/package.json` gains none.
 *
 * `bins` of `null` means the records were not read — the tile then ships with its foot alone,
 * and drawing a flat line for it would be a claim that nothing happened.
 */
export function Sparkline({
  bins,
  label,
  className = "",
}: {
  /** 24 counts, oldest first, or `null` when this row's records were not read. */
  bins: number[] | null;
  /** Read out to assistive technology, e.g. "12 records in the last 24 hours". */
  label?: string;
  className?: string;
}) {
  if (!bins || bins.length === 0) return null;
  const max = Math.max(...bins, 1);
  const barWidth = (SPARK_WIDTH - SPARK_GAP * (bins.length - 1)) / bins.length;
  const quiet = bins.every((b) => b === 0);

  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className={`h-7 w-full ${className}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? `activity over the last ${SPARKLINE_BINS} hours`}
      data-testid="tile-sparkline"
      data-quiet={quiet ? "true" : undefined}
    >
      {/* The baseline is drawn even for a quiet day, so an empty sparkline still reads as a
          measured 24 hours rather than as a component that failed to render. */}
      <line
        x1={0}
        x2={SPARK_WIDTH}
        y1={SPARK_HEIGHT - 0.5}
        y2={SPARK_HEIGHT - 0.5}
        stroke="rgb(255 255 255 / 0.08)"
        strokeWidth={1}
      />
      {bins.map((count, i) => {
        const height = count > 0 ? Math.max(2, (count / max) * (SPARK_HEIGHT - 3)) : 0;
        if (height === 0) return null;
        return (
          <rect
            key={i}
            x={i * (barWidth + SPARK_GAP)}
            y={SPARK_HEIGHT - height}
            width={barWidth}
            height={height}
            rx={0.75}
            className="fill-accent"
            fillOpacity={0.75}
          />
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Hover card                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * The 24 h sparkline, read when the card opens and not before. One `listEvents` per tile costs
 * 5–10 s for a full grid on a busy wallet, so the tile itself carries no events; a hover pays one read (≈70 ms) and React Query keeps it
 * for the page's life. The query is only mounted while the card is, which is what makes it lazy.
 */
function LazySparkline({ agentId }: { agentId: string }) {
  const events = useEvents(agentId, true);
  const bins = events.data ? bins24(events.data, Date.now()) : null;
  return (
    <div className="flex items-center gap-2">
      {bins ? (
        <Sparkline bins={bins} label="Writes in the last 24 hours" className="h-6 flex-1" />
      ) : (
        <div className="h-6 flex-1 animate-pulse rounded bg-surface-3" aria-hidden />
      )}
      <span className="flex flex-none items-center gap-1 text-ink-3">
        24 h <SourceTag source="chain" />
      </span>
    </div>
  );
}

/**
 * The summary in the ⓘ card: the row's fields, each tagged `chain` or `console`.
 *
 * The tag is the point of the card: the console's registry and the chain
 * disagree about what is provable, and a panel that mixed them silently would let a console
 * record read as a chain fact.
 */
function TileSummary({ title, fields, agentId }: { title: ReactNode; fields: TileField[]; agentId?: string }) {
  return (
    <>
      <div className="truncate text-sm font-medium text-ink-1">{title}</div>
      {agentId && <LazySparkline agentId={agentId} />}
      <Facts
        items={fields.map((f) => ({ label: f.label, value: f.value, source: f.source, mono: f.mono, title: f.title }))}
        empty="Nothing but the header: this console has no record of this agent."
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Tile                                                                                        */
/* ------------------------------------------------------------------------------------------ */

const TONE_DOT: Record<TileTone, string> = {
  good: "bg-spine-green",
  warn: "bg-amber-400",
  bad: "bg-rose-400",
  neutral: "bg-ink-3",
  cyan: "bg-accent",
  blue: "bg-spine-blue",
  volt: "bg-spine-volt",
};

const TONE_TEXT: Record<TileTone, string> = {
  good: "text-spine-green",
  warn: "text-amber-300",
  bad: "text-rose-300",
  neutral: "text-ink-3",
  cyan: "text-accent-strong",
  blue: "text-accent-strong",
  volt: "text-spine-volt",
};

/**
 * One row of either grid.
 *
 * `actions` is where a tab hangs the controls its table already offers on the row — the Agents
 * tab has none, the Loops tab has pause, stop and *Run again* — so those stay in the tab that
 * owns them rather than becoming a prop shape this file has to know about.
 */
export function Tile({ row, actions }: { row: TileRow; actions?: ReactNode }) {
  const idAttrs = row.loopId ? { "data-loop-id": row.loopId } : { "data-agent-id": row.agentId };

  return (
    <div
      data-testid={row.testId}
      {...idAttrs}
      className="surface group relative flex flex-col gap-2.5 p-3.5 transition-colors hover:border-line/[0.16] hover:bg-line/[0.02]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={row.kind === "loop" ? "blue" : row.kind === "zeroclaw" ? "compressed" : "neutral"}>
            {row.kind}
          </Badge>
          <Link
            href={row.href}
            className={`min-w-0 truncate text-sm font-medium transition-colors group-hover:text-accent-strong ${
              row.unnamed ? "num text-xs text-ink-2" : "text-ink-1"
            }`}
          >
            {row.name}
          </Link>
        </div>
        <span className="flex flex-none items-center gap-1.5">
          <span className="flex items-center gap-1.5" title={row.statusLabel}>
            <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[row.statusTone]}`} />
            <span className={`text-2xs ${TONE_TEXT[row.statusTone]}`}>{row.statusLabel}</span>
          </span>
          <Info label={`${row.name} summary`} testId="tile-hover-card" triggerTestId="tile-info">
            <TileSummary title={row.name} fields={row.fields} agentId={row.agentId} />
          </Info>
        </span>
      </div>

      {/* Two lines, clamped: a description long enough to push a tile taller than its neighbours
          would break the grid's rhythm, and the whole text is on the row's own page. */}
      <p
        className={`line-clamp-2 min-h-[2rem] text-xs leading-4 ${
          row.descriptionPlaceholder ? "text-ink-3" : "text-ink-2"
        }`}
      >
        {row.description}
      </p>

      {/* No sparkline in the tile itself: no caller of `tileRows` passes `events`, so `row.bins` is
          always null here. The 24 h bars are in the ⓘ card, read when it opens. */}

      <div className="flex items-end justify-between gap-2 text-2xs text-ink-3">
        <span suppressHydrationWarning className="num truncate">
          {row.footLeft}
          {/* A sandbox tile's foot mixes the two halves — the header's seq when it was read, the
              console's wrapper and workspace — so each side says which it is. The other tabs' feet
              are one source each and carry no tag. */}
          {row.kind === "zeroclaw" && <SourceTag source={row.footLeftSource} className="ml-1.5" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {/* A funded agent shows what it may spend of the wallet's balance, not the word *funded*:
              every one of them draws on the same balance, and the approved cap is the difference. */}
          {row.kind === "zeroclaw" && row.footRight !== "—" && <SourceTag source={row.footRightSource} />}
          {row.allowanceLabel && (
            <span data-testid="tile-allowance" className="num truncate" title={row.allowanceTitle}>
              {row.allowanceLabel}
            </span>
          )}
          {!row.allowanceLabel && row.spendLabel && (
            <span data-testid="tile-spend" className="num truncate" title={row.spendTitle}>
              {row.spendLabel}
            </span>
          )}
          {row.relations.map((r) =>
            r === "funded" && row.allowanceLabel ? null : (
              <Badge key={r} tone={r === "signer" ? "good" : "blue"} dot={r === "signer"}>
                {r}
              </Badge>
            )
          )}
          {row.relations.length === 0 && row.footRight !== "—" && <span className="num truncate">{row.footRight}</span>}
        </span>
      </div>

      {actions && <div className="flex flex-wrap items-center gap-1.5 pt-0.5">{actions}</div>}
    </div>
  );
}

/**
 * The grid itself. One column on a phone, up to four on a wide screen — a tile carries about as
 * much text as a card in the market shelf, which is what these column counts are tuned to.
 */
export function TileGrid<R extends TileRow = TileRow>({
  rows,
  actionsFor,
  testId,
  wide = false,
  maxRows,
}: {
  rows: R[];
  /** Per-row controls, e.g. the Loops tab's pause and stop, or Explore's Launch. */
  actionsFor?: (row: R) => ReactNode;
  testId?: string;
  /** Four columns from `lg` rather than from `2xl`. */
  wide?: boolean;
  /**
   * Rows shown before the grid scrolls. The height is measured off the tallest tile of the first
   * row, not fixed in CSS, because a tile's height moves with its clamped description.
   */
  maxRows?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const grid = ref.current;
    if (!maxRows || !grid) return;
    const measure = () => {
      const tiles = Array.from(grid.children) as HTMLElement[];
      if (tiles.length === 0) return setMaxHeight(undefined);
      const top = tiles[0].offsetTop;
      const firstRow = tiles.filter((t) => t.offsetTop === top);
      const rowHeight = Math.max(...firstRow.map((t) => t.offsetHeight));
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
      setMaxHeight(maxRows * rowHeight + (maxRows - 1) * gap);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [maxRows, rows.length]);

  const columns = wide ? "lg:grid-cols-4" : "lg:grid-cols-3 2xl:grid-cols-4";
  return (
    <div
      className={maxRows ? "overflow-y-auto pr-1" : undefined}
      style={maxRows && maxHeight ? { maxHeight } : undefined}
      data-testid={testId ? `${testId}-scroll` : undefined}
    >
      <div ref={ref} data-testid={testId} className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${columns}`}>
        {rows.map((row) => (
          <Tile key={row.key} row={row} actions={actionsFor?.(row)} />
        ))}
      </div>
    </div>
  );
}
