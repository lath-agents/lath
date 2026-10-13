/**
 * The Lath mark: a triangle built from four laths, one per record, the newest
 * on top. The colour runs from the spine's blue at the base — the oldest record — to the logo's
 * light blue at the head, so the mark is the chain read bottom to top.
 *
 * Drawn on a 48-unit grid in whole units so it lands on pixels at 16, 22 and 32. The glow is a CSS
 * drop-shadow rather than an SVG filter so it can be left off at favicon sizes, where a halo only
 * blurs the bars. `running` pulses the head bar, for a place that shows a loop stepping now.
 */
export function LathMark({
  size = 22,
  glow = true,
  running = false,
  className = "",
  title,
}: {
  size?: number;
  glow?: boolean;
  running?: boolean;
  className?: string;
  /** An accessible name; without one the mark is decorative and hidden from assistive tech. */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`shrink-0 ${glow ? "mark-glow" : ""} ${className}`}
    >
      <rect x="19" y="6" width="10" height="6" rx="1.5" fill="#bfefff" className={running ? "animate-pulse" : ""} />
      <rect x="14" y="16" width="20" height="6" rx="1.5" fill="#7fdcff" />
      <rect x="9" y="26" width="30" height="6" rx="1.5" fill="#56a9fa" />
      <rect x="4" y="36" width="40" height="6" rx="1.5" fill="#2f7cf6" />
    </svg>
  );
}
