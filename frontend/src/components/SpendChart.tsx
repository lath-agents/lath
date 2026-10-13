"use client";

import { useMemo, useState } from "react";
import { formatUsdc } from "@/lib/format";
import { ChargeLike, DayBucket, spendByDay } from "@/lib/spend";

const BAR_MAX_WIDTH = 28;
const BAR_GAP = 6;
const PADDING_LEFT = 8;
const PADDING_RIGHT = 8;

/**
 * Two sizes of one drawing. `full` is /billing's _Spend by day_; `compact` is the vault popover's
 * 14-day sparkline, the same buckets with no day labels and no grid, because at 64 px tall the labels
 * would be all the chart had room for.
 */
const SIZES = {
  full: { height: 160, top: 16, bottom: 24, svgClass: "h-40", wellClass: "p-3" },
  compact: { height: 56, top: 4, bottom: 4, svgClass: "h-14", wellClass: "p-2" },
} as const;

export function SpendChart({ activity, compact = false }: { activity: ChargeLike[]; compact?: boolean }) {
  const [hovered, setHovered] = useState<DayBucket | null>(null);
  const buckets = useMemo(() => spendByDay(activity, 14), [activity]);
  const size = SIZES[compact ? "compact" : "full"];

  if (buckets.length === 0 || buckets.every((b) => b.amount === 0n && activity.length === 0)) {
    return compact ? (
      <div className="rounded-lg border border-dashed border-line/[0.12] px-3 py-2 text-center text-2xs leading-relaxed text-ink-3">
        No metered charges in the last 14 days.
      </div>
    ) : (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line/[0.12] p-6 text-center text-xs leading-relaxed text-ink-2">
        No metered charges in this window. Charges land as agents run tools and model steps against your allowances.
      </div>
    );
  }

  const total = buckets.reduce((n, b) => n + b.amount, 0n);
  // The peak as printed is the largest bucket, read in bigint; the floor of 1 is only for the bar
  // divisor, since a window with activity and no spend would otherwise print "peak 0.000001".
  const peak = buckets.reduce((m, b) => (b.amount > m ? b.amount : m), 0n);
  const maxMicro = Math.max(Number(peak), 1);
  const plotHeight = size.height - size.top - size.bottom;
  const barWidth = Math.min(BAR_MAX_WIDTH, Math.max(12, 400 / buckets.length - BAR_GAP));
  const svgWidth = Math.max(320, PADDING_LEFT + PADDING_RIGHT + buckets.length * (barWidth + BAR_GAP) - BAR_GAP);

  return (
    <div className={compact ? "space-y-1.5" : "space-y-3"}>
      <div className={`flex items-baseline justify-between gap-3 ${compact ? "text-2xs" : "text-xs"}`}>
        {hovered ? (
          <span className="text-ink-2">
            {hovered.day} · <span className="num font-semibold text-ink-1">{formatUsdc(hovered.amount)} USDC</span>
          </span>
        ) : (
          <span className="text-ink-2">
            {compact ? "Spent, 14 days" : "14 days"} ·{" "}
            <span className="num font-semibold text-ink-1">{formatUsdc(total)} USDC</span>
          </span>
        )}
        <span className="num text-ink-3">peak {formatUsdc(peak)}</span>
      </div>

      <div className={`well overflow-x-auto ${size.wellClass}`}>
        <svg
          viewBox={`0 0 ${svgWidth} ${size.height}`}
          className={`${size.svgClass} w-full`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Metered charges by day over 14 days, ${formatUsdc(total)} USDC in all`}
        >
          {(compact ? [1] : [0, 0.5, 1]).map((f) => (
            <line
              key={f}
              x1={PADDING_LEFT}
              x2={svgWidth - PADDING_RIGHT}
              y1={size.top + plotHeight * f}
              y2={size.top + plotHeight * f}
              stroke={f === 1 ? "rgb(255 255 255 / 0.14)" : "rgb(255 255 255 / 0.05)"}
              strokeDasharray={f === 1 ? undefined : "2 3"}
            />
          ))}

          {buckets.map((b, i) => {
            const x = PADDING_LEFT + i * (barWidth + BAR_GAP);
            const val = Number(b.amount);
            const height = val > 0 ? Math.max(3, (val / maxMicro) * plotHeight) : 1;
            const y = size.height - size.bottom - height;
            const isHovered = hovered?.day === b.day;
            const showLabel = !compact && i % Math.max(1, Math.floor(buckets.length / 7)) === 0;

            return (
              <g key={b.day} onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}>
                {/* A full-height hit target so thin bars are still hoverable. */}
                <rect
                  x={x - BAR_GAP / 2}
                  y={size.top}
                  width={barWidth + BAR_GAP}
                  height={plotHeight}
                  fill="transparent"
                />
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={height}
                  rx="2"
                  fillOpacity={val > 0 ? (isHovered ? 1 : 0.7) : 0.08}
                  // The accent token, not a hard-coded cyan: a `var()` is not read from an SVG attribute, so the
                  // fill is a class.
                  className={`transition-all duration-150 ${val > 0 ? "fill-accent" : "fill-white"}`}
                />
                {showLabel && (
                  <text
                    x={x + barWidth / 2}
                    y={size.height - 8}
                    fill="rgb(108 114 128)"
                    fontSize="9"
                    textAnchor="middle"
                    className="font-mono"
                  >
                    {b.day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
