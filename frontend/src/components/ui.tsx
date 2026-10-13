"use client";

import Link from "next/link";
import {
  CSSProperties,
  FocusEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { explorerUrl } from "@/lib/config";
import { truncate } from "@/lib/format";
import { chainReadErrorText } from "@/lib/read-error";

/* ------------------------------------------------------------------------------------------ */
/* Layout                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The top of a page: an optional eyebrow (breadcrumb, kind), the title, a one-line description
 * and, on the right, the page's primary actions. Pages should have exactly one.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-3 ${className}`}>
      <div className="min-w-0 space-y-1.5">
        {eyebrow && <div className="flex items-center gap-2 text-xs text-ink-3">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-tight text-ink-1 sm:text-2xl">{title}</h1>
        {description && <p className="max-w-2xl text-sm leading-relaxed text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Breadcrumb trail for the eyebrow slot: `Agents / name`. */
export function Crumbs({ items }: { items: { label: ReactNode; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-ink-3">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          {item.href ? (
            <Link href={item.href} className="transition-colors hover:text-ink-1">
              {item.label}
            </Link>
          ) : (
            <span className="text-ink-2">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * A card: one bordered surface with an optional header row. `tone` paints a thin identity
 * stripe along the left edge and nothing else glows.
 */
export function Card({
  title,
  description,
  children,
  right,
  glow,
  tone,
  padding = "md",
  className = "",
  id,
  nested = false,
  pageTitle = false,
  collapsible,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
  /**
   * Rendered as a section of an enclosing card rather than a card of its own: no surface, a rule
   * above it, and none when it is the first thing in its parent.
   */
  nested?: boolean;
  /** Kept for callers that still pass it; maps onto `tone`. */
  glow?: "cyan" | "blue" | "emerald";
  tone?: "cyan" | "blue" | "emerald" | "amber" | "rose";
  padding?: "none" | "sm" | "md";
  className?: string;
  id?: string;
  /**
   * The card's title is the page's heading: rendered as the page's one `h1` rather than an `h2`, for
   * a page whose first card names what the page is about (the loop page), so the page has
   * a heading without a second copy of the name above the card.
   */
  pageTitle?: boolean;
  /**
   * Folded to its header until the reader opens it: the title is
   * the toggle, `right` stays on the header so a status badge still reads while folded, and the
   * description shows only when open. The body stays mounted while folded, hidden rather than gone, so
   * the reads inside it keep running and a test can still find what it holds. `<testId>-toggle` on the
   * button, `<testId>-body` on the body.
   */
  collapsible?: { testId: string; defaultOpen?: boolean };
}) {
  const [open, setOpen] = useState(collapsible?.defaultOpen ?? false);
  const bodyId = useId();
  const stripe = tone ?? glow;
  const Heading = pageTitle ? "h1" : "h2";
  const stripes = {
    cyan: "before:bg-accent",
    blue: "before:bg-spine-blue",
    emerald: "before:bg-spine-green",
    amber: "before:bg-amber-400",
    rose: "before:bg-rose-400",
  } as const;
  const pad = { none: "", sm: "p-4", md: "p-5" }[padding];

  if (nested) {
    return (
      <div
        id={id}
        className={`mt-5 border-t border-line/[0.08] pt-5 first:mt-0 first:border-t-0 first:pt-0 ${className}`}
      >
        {(title || right || description) && (
          <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 space-y-0.5">
              {title && (
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight text-ink-1">
                  {title}
                </h3>
              )}
              {description && <p className="text-xs leading-relaxed text-ink-3">{description}</p>}
            </div>
            {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
          </header>
        )}
        {children}
      </div>
    );
  }

  return (
    <section
      id={id}
      className={`surface relative overflow-hidden ${pad} ${
        stripe ? `before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${stripes[stripe]}` : ""
      } ${className}`}
    >
      {(title || right || description) && (
        <header
          className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 ${
            padding === "none" ? "px-5 pt-5" : ""
          } ${children && (!collapsible || open) ? "mb-4" : ""}`}
        >
          <div className="min-w-0 space-y-0.5">
            {title &&
              (collapsible ? (
                <Heading className="text-sm font-semibold tracking-tight text-ink-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    data-testid={`${collapsible.testId}-toggle`}
                    onClick={() => setOpen(!open)}
                    className="flex flex-wrap items-center gap-2 rounded-md text-left transition-colors hover:text-ink-1"
                  >
                    {title}
                    <span aria-hidden className="text-xs text-ink-3">
                      {open ? "▾" : "▸"}
                    </span>
                  </button>
                </Heading>
              ) : (
                <Heading className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight text-ink-1">
                  {title}
                </Heading>
              ))}
            {description && (!collapsible || open) && (
              <p className="text-xs leading-relaxed text-ink-3">{description}</p>
            )}
          </div>
          {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
        </header>
      )}
      {collapsible ? (
        <div id={bodyId} hidden={!open} data-testid={`${collapsible.testId}-body`}>
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Data display                                                                                */
/* ------------------------------------------------------------------------------------------ */

export function Stat({
  label,
  value,
  unit,
  hint,
  icon,
  trend,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  icon?: ReactNode;
  trend?: { text: string; positive?: boolean };
  tone?: "neutral" | "accent" | "amber";
}) {
  const tones = {
    neutral: "text-ink-1",
    accent: "text-accent-strong",
    amber: "text-amber-300",
  } as const;
  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        {icon && <span className="text-ink-3">{icon}</span>}
      </div>
      <div className={`mt-2 flex items-baseline gap-1.5 ${tones[tone]}`}>
        <span className="num text-2xl font-semibold tracking-tight">{value}</span>
        {unit && <span className="text-xs font-medium text-ink-3">{unit}</span>}
      </div>
      {(hint || trend) && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-ink-3">
          {hint && <span>{hint}</span>}
          {trend && (
            <span className={`num text-2xs ${trend.positive ? "text-spine-green" : "text-amber-400"}`}>
              {trend.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Label/value pairs. `columns` puts the label in a fixed left column; otherwise pairs stack. */
export function KV({
  items,
  columns = true,
  className = "",
  testId,
}: {
  items: { label: ReactNode; value: ReactNode; hint?: ReactNode }[];
  columns?: boolean;
  className?: string;
  testId?: string;
}) {
  if (columns) {
    return (
      <dl
        className={`grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] ${className}`}
        data-testid={testId}
      >
        {items.map((item, i) => (
          <div key={i} className="contents">
            <dt className="text-xs text-ink-3 sm:pt-0.5">{item.label}</dt>
            <dd className="min-w-0">
              {item.value}
              {item.hint && <div className="mt-0.5 text-2xs text-ink-3">{item.hint}</div>}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-4 ${className}`} data-testid={testId}>
      {items.map((item, i) => (
        <div key={i} className="well px-3 py-2.5">
          <dt className="eyebrow">{item.label}</dt>
          <dd className="mt-1 min-w-0">{item.value}</dd>
          {item.hint && <div className="mt-0.5 text-2xs text-ink-3">{item.hint}</div>}
        </div>
      ))}
    </dl>
  );
}

/**
 * No purple: identity tones are the spine hues, one meaning each — `blue` waiting
 * (between steps, paused, gated), `cyan` (light blue) happening now, `good` ran, `volt` achieved.
 */
export type BadgeTone = "neutral" | "good" | "bad" | "warn" | "cyan" | "blue" | "volt" | "answer" | "compressed";

export function Badge({
  tone = "neutral",
  children,
  dot = false,
  pulse = false,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  dot?: boolean;
  /** Pulses the dot: for the one thing happening now (the spine's light blue). Off under reduced motion. */
  pulse?: boolean;
  title?: string;
}) {
  const tones = {
    neutral: "border-line/[0.1] bg-line/[0.04] text-ink-2",
    good: "border-spine-green/25 bg-spine-green/10 text-spine-green",
    bad: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    warn: "border-amber-400/25 bg-amber-400/10 text-amber-300",
    cyan: "border-accent/20 bg-accent/10 text-accent-strong",
    blue: "border-spine-blue/30 bg-spine-blue/15 text-accent-strong",
    // Achieved is the one state in electric green, here as on the spine's node. No glow: the colour
    // says it, and a halo reads as decoration.
    volt: "border-spine-volt/40 bg-spine-volt/10 text-spine-volt",
    // A Resolution record: electric green as the chain's answer, without achieved's weight. Every
    // session resolves, so marking each one as strongly would drown the one run that reached its goal.
    answer: "border-spine-volt/30 bg-spine-volt/[0.06] text-spine-volt",
    // A static fact about storage, outlined in blue rather than the light blue of a run stepping now:
    // a badge that never changes must not read as running.
    compressed: "border-spine-blue/40 bg-transparent text-ink-2",
  } as const;

  const dots = {
    neutral: "bg-ink-3",
    good: "bg-spine-green",
    bad: "bg-rose-400",
    warn: "bg-amber-400",
    cyan: "bg-accent",
    blue: "bg-spine-blue",
    volt: "bg-spine-volt",
    answer: "bg-spine-volt",
    compressed: "bg-spine-blue",
  } as const;

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-4 ${tones[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 flex-none rounded-full ${dots[tone]} ${pulse ? "animate-pulse" : ""}`} />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Controls                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "glow" | "cyan";

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  size = "md",
  type = "button",
  icon,
  title,
  loading = false,
  className = "",
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit";
  icon?: ReactNode;
  title?: string;
  loading?: boolean;
  className?: string;
  testId?: string;
}) {
  const sizes = {
    sm: "h-7 px-2.5 text-xs gap-1",
    md: "h-9 px-3.5 text-xs gap-1.5",
    lg: "h-10 px-4 text-sm gap-2",
  };

  // `cyan` and `glow` are the names older call sites use for the primary action.
  const key = variant === "cyan" || variant === "glow" ? "primary" : variant;
  const variants = {
    primary: "bg-accent text-neutral-950 hover:bg-accent-strong active:bg-accent",
    secondary: "border border-line/[0.12] bg-surface-3 text-ink-1 hover:border-line/[0.2] hover:bg-surface-3/80",
    ghost:
      "border border-line/[0.1] bg-transparent text-ink-2 hover:border-line/[0.18] hover:bg-line/[0.04] hover:text-ink-1",
    danger: "border border-rose-400/25 bg-rose-400/10 text-rose-300 hover:bg-rose-400/15",
  } as const;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      data-testid={testId}
      className={`inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sizes[size]} ${variants[key]} ${className}`}
    >
      {loading ? <Spinner /> : icon ? <span className="flex-none">{icon}</span> : null}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

/** A labelled form control. The child is any input; this only supplies the label and the hint. */
export function Field({
  label,
  hint,
  right,
  children,
  className = "",
}: {
  label: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        {right && <span className="text-2xs text-ink-3">{right}</span>}
      </div>
      {children}
      {hint && <div className="mt-1.5 text-2xs leading-relaxed text-ink-3">{hint}</div>}
    </label>
  );
}

/** A segmented control: one of a few mutually exclusive choices. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  /** `title` says what the option, and its count, counts: pages count different things. */
  options: { value: T; label: ReactNode; count?: ReactNode; title?: string }[];
  label?: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="tablist" aria-label={label} className="segmented">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`segmented-item flex items-center gap-1.5 ${size === "sm" ? "px-2.5 py-0.5 text-2xs" : ""}`}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                className={`rounded px-1 font-mono text-[10px] leading-4 ${
                  active ? "bg-accent/15 text-accent-strong" : "bg-line/[0.05] text-ink-3"
                }`}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Which half of the system a field is true of: the chain, which proves it, or the console, which
 * merely recorded it.
 *
 * The tile grid and the fleet map draw that line on screen, because a hover card that listed a registry row's `model` beside an on-chain `head`
 * without saying so would let a console record borrow the chain's authority. It is deliberately
 * quiet — a four-letter tag, not a badge — since it appears beside every field.
 */
export type SourceKind = "chain" | "console" | "tempo";

/** What each tag means, said on hover: by the tag itself, and by a `Facts` label, which draws no tag. */
export const SOURCE_TITLE: Record<SourceKind, string> = {
  chain: "read from Solana: the record proves it",
  console: "the console's own record: true of this deployment, not proven on chain",
  tempo: "read from Tempo",
};

/**
 * `tempo` is the third half: a figure read from Tempo's chain — a channel's escrow, a
 * close receipt, the treasury's balance. It is proven there, not on Solana, and a tag that said
 * `chain` for it would send a reader to the wrong explorer. Outlined rather than filled so the two
 * chains' tags tell apart at a glance in the same light-blue family.
 */
export function SourceTag({ source, className = "" }: { source: SourceKind; className?: string }) {
  const styles: Record<SourceKind, string> = {
    chain: "bg-accent/10 text-accent-strong",
    console: "bg-line/[0.05] text-ink-3",
    tempo: "border border-accent/30 text-accent",
  };
  return (
    <span
      data-testid="source-tag"
      data-source={source}
      title={SOURCE_TITLE[source]}
      className={`rounded px-1 font-mono text-[10px] leading-4 ${styles[source]} ${className}`}
    >
      {source}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Details on demand: Info, Facts, Proof                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Hover must rest this long before a popover opens, so a pointer crossing a row opens nothing. */
const INFO_OPEN_DELAY = 150;
/**
 * And this long after it leaves before it closes: the gap between the trigger and the popover is
 * crossed in that time, which is what lets the pointer reach the popover at all. The tile hover
 * card that closes on the tile's own `mouseleave` is one nobody can point at.
 */
const INFO_CLOSE_DELAY = 160;
const INFO_GAP = 6;
const INFO_MARGIN = 8;

// `useLayoutEffect` measures before paint, so the popover never draws a frame in the wrong place.
// The server has no layout; there it is the plain effect, which React never runs anyway.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Where the popover goes: under the trigger, left edges aligned, flipped above it when it does not
 * fit below, and clamped inside the viewport on every side — the rule the tile hover card used,
 * now measured against the popover's real height rather than a guess of 40 px. When it fits on
 * neither side it takes the larger one and scrolls inside itself.
 */
function placePopover(trigger: DOMRect, height: number, width: number): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(INFO_MARGIN, Math.min(trigger.left, vw - width - INFO_MARGIN));
  const below = vh - trigger.bottom - INFO_GAP - INFO_MARGIN;
  const above = trigger.top - INFO_GAP - INFO_MARGIN;
  const base: CSSProperties = { position: "fixed", left, width, zIndex: 60 };
  if (height <= below || below >= above) {
    return {
      ...base,
      top: trigger.bottom + INFO_GAP,
      ...(height > below ? { maxHeight: below, overflowY: "auto" } : {}),
    };
  }
  return {
    ...base,
    bottom: vh - trigger.top + INFO_GAP,
    ...(height > above ? { maxHeight: above, overflowY: "auto" } : {}),
  };
}

/**
 * A detail behind a small ⓘ: it opens on 150 ms of hover, on keyboard focus, and on a click or a
 * tap, so nothing it holds is hover-only.
 *
 * The rules, and the failure each one closes:
 *
 * - **Hover and the pointer.** Hover opens it; leaving the trigger starts a short close delay that
 *   entering the popover cancels, so the pointer can travel from one to the other. Only a mouse
 *   hovers: a touch's synthetic `pointerenter` would open it and the tap's click then shut it.
 * - **Click.** A click opens it *pinned* — it then stays open when the pointer leaves. A click on a
 *   popover the hover opened pins it rather than closing it, because a reader who clicks an ⓘ that
 *   just opened under them meant "show me", not "hide". A click on a pinned one closes it. That is
 *   the toggle, one rule for mouse, touch and Enter.
 * - **Focus.** Keyboard focus opens it (`:focus-visible`, so the focus a mouse click gives a button
 *   does not open it a moment before the click toggles it). Focus that leaves both the trigger and
 *   the popover closes it; focus with nowhere known to go (`relatedTarget` null, as when text inside
 *   the popover is clicked) leaves it alone, and the outside-pointerdown rule covers the rest.
 * - **Escape** closes it from anywhere and returns focus to the trigger if it was inside.
 * - **A portal.** The popover is rendered at `document.body`, positioned against the trigger, so a
 *   card or a scrolling list with `overflow` of its own cannot clip it. It follows the trigger on
 *   scroll and resize rather than closing, and flips to stay in the viewport.
 *
 * `children` is rendered only while open, which is what lets a body do its own lazy read (the tile's
 * 24 h sparkline reads the agent's events only when its card opens).
 */
/**
 * Every open `Info` nested inside another one's body registers its popover with each ancestor. The
 * popover is portalled to `document.body`, so it is outside its parent's popover in the DOM, and the
 * parent's outside-pointerdown and focus-out rules would otherwise read a press on the child's copy
 * button as a press outside, close the parent, and unmount the child with it (a `TempoLink` inside a
 * `Facts` list is exactly that).
 */
const InfoNest = createContext<((el: HTMLElement) => () => void) | null>(null);

export function Info({
  label,
  children,
  trigger,
  wide = false,
  testId,
  triggerTestId,
  className = "",
}: {
  /** The accessible name of the trigger and the popover, e.g. "Agent details". */
  label: string;
  /** The popover's body, usually a `Facts` list. */
  children: ReactNode;
  /** Drawn in place of the ⓘ — a short hash, a name — when the trigger should be the value itself. */
  trigger?: ReactNode;
  /** 400 px rather than 296, for bodies with long values. Either is clamped to the viewport. */
  wide?: boolean;
  /** On the popover. */
  testId?: string;
  /** On the trigger button. */
  triggerTestId?: string;
  /** On the trigger button. */
  className?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  // A ref, not state: whether the popover is pinned decides what the next leave or click does, and
  // nothing on screen draws it.
  const pinned = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parentNest = useContext(InfoNest);
  const nested = useRef(new Set<HTMLElement>());
  const register = useCallback(
    (el: HTMLElement) => {
      nested.current.add(el);
      const up = parentNest?.(el);
      return () => {
        nested.current.delete(el);
        up?.();
      };
    },
    [parentNest]
  );
  const inside = useCallback(
    (node: Node) =>
      !!(triggerRef.current?.contains(node) || popRef.current?.contains(node)) ||
      Array.from(nested.current).some((el) => el.contains(node)),
    []
  );

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  }, []);

  const close = useCallback(() => {
    clearTimers();
    pinned.current = false;
    setOpen(false);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const onEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (!open && !openTimer.current) {
      openTimer.current = setTimeout(() => {
        openTimer.current = null;
        setOpen(true);
      }, INFO_OPEN_DELAY);
    }
  };

  const onLeave = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (pinned.current || closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!pinned.current) setOpen(false);
    }, INFO_CLOSE_DELAY);
  };

  const onClick = () => {
    clearTimers();
    if (open && pinned.current) return close();
    pinned.current = true;
    setOpen(true);
  };

  const onFocus = (e: FocusEvent<HTMLButtonElement>) => {
    let keyboard = true;
    try {
      keyboard = e.currentTarget.matches(":focus-visible");
    } catch {
      // A browser without `:focus-visible` opens on any focus, which is the accessible default.
    }
    if (keyboard) setOpen(true);
  };

  const onBlur = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next) return;
    if (inside(next)) return;
    close();
  };

  // Escape and an outside pointerdown, only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inside = popRef.current?.contains(document.activeElement);
      close();
      if (inside) triggerRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (inside(e.target as Node)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, close, inside]);

  // While open, this popover counts as inside every Info it is nested in.
  useEffect(() => {
    if (!open || !parentNest || !popRef.current) return;
    return parentNest(popRef.current);
  }, [open, parentNest]);

  // Position before paint, then again on scroll, resize and a change in the body's own size (a lazy
  // read that lands makes it taller, which matters when it sits above the trigger).
  const width = wide ? 400 : 296;
  useIsoLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    let frame = 0;
    const place = () => {
      const t = triggerRef.current;
      const p = popRef.current;
      if (!t || !p) return;
      const w = Math.min(width, window.innerWidth - INFO_MARGIN * 2);
      setStyle(placePopover(t.getBoundingClientRect(), p.scrollHeight, w));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (popRef.current) observer?.observe(popRef.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [open, width]);

  const popId = `${id}-info`;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-haspopup="dialog"
        // An icon has no text of its own, so the label is its name. A custom trigger's visible text
        // stays the start of its name (WCAG 2.5.3) and the label follows it, read but not drawn.
        aria-label={trigger ? undefined : label}
        data-testid={triggerTestId}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onBlur}
        className={
          trigger
            ? `inline-flex max-w-full items-center rounded text-left transition-colors hover:text-accent-strong ${className}`
            : `inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink-1 aria-expanded:text-accent-strong ${className}`
        }
      >
        {trigger ? (
          <>
            {trigger}
            <span className="sr-only">, {label}</span>
          </>
        ) : (
          <InfoIcon />
        )}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            role="dialog"
            aria-label={label}
            data-testid={testId}
            onPointerEnter={onEnter}
            onPointerLeave={onLeave}
            onBlur={onBlur}
            // The first frame is measured, not drawn: hidden until `placePopover` has its height.
            style={style ?? { position: "fixed", top: 0, left: 0, width, visibility: "hidden", zIndex: 60 }}
            className="surface pointer-events-auto animate-rise space-y-2 bg-surface-2 p-3 text-xs leading-relaxed text-ink-2 shadow-float"
          >
            <InfoNest.Provider value={register}>{children}</InfoNest.Provider>
          </div>,
          document.body
        )}
    </>
  );
}

/** One row of a `Facts` list. */
export interface Fact {
  label: ReactNode;
  /** Any node: a figure, a `Copyable`, a `TempoLink`, an `ExplorerLink`. */
  value: ReactNode;
  /** Which half of the system it is true of; omitted for a plain explanation. */
  source?: SourceKind;
  /** Hashes, ids and keys line up in the mono column. */
  mono?: boolean;
  /** The full value when `value` is truncated, or a sentence explaining the field. */
  title?: string;
}

/**
 * The body of an `Info`: label, value and where the value was read. The source is the point: a
 * console record beside a chain fact must not borrow the chain's authority, and a Tempo figure must
 * not pass for a Solana one.
 *
 * Said on hover, not as a tag on every row: tags on every list are noise to a first-time reader. The label's `title` carries the tag's sentence, and the
 * row keeps `data-source` so a test can still read which half a figure came from.
 */
export function Facts({
  items,
  empty,
  className = "",
  testId,
}: {
  items: Fact[];
  /** Said when `items` is empty. Nothing is drawn when this is unset too. */
  empty?: ReactNode;
  className?: string;
  testId?: string;
}) {
  if (items.length === 0) return empty ? <div className="text-ink-3">{empty}</div> : null;
  return (
    <dl className={`space-y-1.5 text-xs ${className}`} data-testid={testId}>
      {items.map((f, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3" data-source={f.source}>
          <dt
            className="flex flex-none items-center gap-1.5 text-ink-3"
            title={f.source ? SOURCE_TITLE[f.source] : undefined}
          >
            {f.label}
          </dt>
          <dd title={f.title} className={`min-w-0 truncate text-right text-ink-1 ${f.mono ? "num text-2xs" : ""}`}>
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One labelled line of a panel or a header, inside a `<dl>`: the label in a fixed column, its fact
 * beside it, wrapping under itself. The workspace's agent panel and
 * the agent page's header both draw their rows with it, so the two read alike. A block that belongs to
 * the row (a form, a run's controls) goes in as a `w-full` child and takes a line of its own.
 */
export function FactRow({
  label,
  id,
  testId,
  className = "",
  children,
}: {
  label: ReactNode;
  id?: string;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={`grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 ${className}`}
      data-testid={testId}
    >
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ink-1">{children}</dd>
    </div>
  );
}

/**
 * One disclosure per item for the long proof material — the hash chain, the epochs, the sandbox
 * proof, the audit commands — so it stays one click away rather than on screen.
 *
 * The open state lives in the URL, `?proof=1`, so a link to an opened proof opens it, and a deep
 * link that points into the proof (`?seq=`, `?at=`, `?prove=`, given in `openWhen`) opens it too:
 * the record it names would otherwise be inside a closed box. Toggling rewrites the query with
 * `history.replaceState`, keeping every other parameter, and does not navigate — opening a box is
 * not a page the back button should return to. The URL is read after mount, not during render,
 * for the same reason the workspace reads its selection that way (`lib/workspace.ts`): the server
 * has no query to agree with, and `useSearchParams` would need a Suspense boundary on every static page that used this.
 *
 * `hash` names a fragment that opens it as well, read on `hashchange`, so a same-page link
 * (`<a href="#records">`) opens the box without a navigation: the agent page's record count is one.
 * The fragment is the box's own `id`, so the browser scrolls to it as it opens.
 */
export function Proof({
  children,
  summary,
  openWhen = [],
  hash,
  label = "Proof",
  testId = "proof",
  className = "",
}: {
  children: ReactNode;
  /** One line beside the button, e.g. "chain verified to seq 42 · 3 epochs folded". */
  summary?: ReactNode;
  /** Other query parameters whose presence also opens it. */
  openWhen?: string[];
  /** A fragment, without `#`, that opens it too and is the box's `id`. */
  hash?: string;
  label?: string;
  /** `<testId>-toggle` on the button, `<testId>-body` on the body. */
  testId?: string;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const watched = openWhen.join(",");

  useEffect(() => {
    const read = () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const others = watched ? watched.split(",") : [];
        const linked = !!hash && window.location.hash === `#${hash}`;
        setOpen(params.get("proof") === "1" || others.some((k) => params.has(k)) || linked);
      } catch {
        // No usable URL: the box starts closed, as it does on a fresh visit.
      }
    };
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("hashchange", read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("hashchange", read);
    };
  }, [watched, hash]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("proof", "1");
      else url.searchParams.delete("proof");
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // The box still toggled on screen; only the reload-keeps-it part is lost.
    }
  };

  const bodyId = `${id}-proof`;
  return (
    <div className={`${hash ? "scroll-mt-20" : ""} ${className}`} id={hash}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={`${testId}-toggle`}
          onClick={toggle}
          className="inline-flex items-center gap-1 rounded-md text-xs font-semibold text-ink-2 transition-colors hover:text-ink-1 aria-expanded:text-ink-1"
        >
          {label} <span aria-hidden>{open ? "▾" : "▸"}</span>
        </button>
        {summary && <span className="min-w-0 text-2xs text-ink-3">{summary}</span>}
      </div>
      {/* The wrapper is always there so `aria-controls` names an element; the body mounts only while
          open, so a closed proof costs none of the reads its children make. */}
      <div id={bodyId} hidden={!open}>
        {open && (
          <div className="mt-3" data-testid={`${testId}-body`}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Inline values                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Monospace value with copy-to-clipboard feedback and an optional link. */
export function Copyable({ value, display, href }: { value: string; display?: string; href?: string }) {
  const text = display ?? truncate(value, 8, 8);
  return (
    <span className="inline-flex max-w-full items-center gap-1 font-mono text-xs">
      {href ? (
        <Link href={href} className="link-mono truncate">
          {text}
        </Link>
      ) : (
        <span className="truncate text-ink-1" title={value}>
          {text}
        </span>
      )}
      <CopyButton value={value} />
    </span>
  );
}

/** The copy half of `Copyable` on its own, for a value drawn some other way (a `TempoLink`'s popover). */
export function CopyButton({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy to clipboard"
      aria-label={`Copy ${value}`}
      data-testid={testId}
      className={`inline-flex h-5 w-5 flex-none items-center justify-center rounded transition-colors hover:bg-line/[0.06] ${
        copied ? "text-spine-green" : "text-ink-3 hover:text-ink-1"
      }`}
      onClick={() => {
        // The tick only once the write resolved: a rejected write (no permission, an insecure context
        // with no `navigator.clipboard`) would leave the old tick saying copied over an empty clipboard.
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(value))
          .then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => undefined
          );
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/**
 * The one look of a link that leaves the app for an explorer: mono, a short value, the external
 * icon. Solana's `ExplorerLink` and Tempo's `TempoLink` share it, so a reader learns
 * once what a link to a chain looks like; the Tempo one adds its mark in front.
 */
export const EXTERNAL_LINK_CLASS =
  "inline-flex max-w-full items-center gap-1 font-mono text-xs text-accent/90 underline decoration-accent/25 underline-offset-[3px] transition-colors hover:text-accent-strong hover:decoration-accent/60";

export function ExplorerLink({
  kind,
  value,
  children,
}: {
  kind: "tx" | "address";
  value: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={explorerUrl(kind, value)}
      target="_blank"
      rel="noreferrer"
      title={`Open ${kind === "tx" ? "transaction" : "address"} ${value} in the explorer`}
      className={EXTERNAL_LINK_CLASS}
    >
      {children ?? truncate(value, 6, 6)}
      <ExternalIcon />
    </a>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* States                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export function Empty({ children, icon, action }: { children: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line/[0.12] px-6 py-8 text-center text-sm text-ink-2">
      {icon && <div className="mb-2 text-ink-3">{icon}</div>}
      <p className="max-w-md leading-relaxed">{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * A chain read that failed, said the same way on every page (`lib/read-error.ts`): why, when that
 * is known — an RPC out of quota is not an indexer that is down — and a retry when the caller has
 * one. In place of the rows, never beside a skeleton.
 */
export function ReadFailed({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return (
    <div data-testid="read-failed">
      <Empty
        action={
          onRetry ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      >
        {chainReadErrorText(error)}
      </Empty>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2.5 text-xs leading-relaxed text-rose-200">
      <span className="mt-px flex-none text-rose-400" aria-hidden>
        <WarnIcon />
      </span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function Note({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "good" | "volt";
  children: ReactNode;
}) {
  const tones = {
    neutral: "border-line/[0.1] bg-line/[0.03] text-ink-2",
    warn: "border-amber-400/25 bg-amber-400/[0.07] text-amber-200",
    good: "border-spine-green/25 bg-spine-green/[0.07] text-ink-1",
    // A goal achieved and the loop stopped on it, in electric green; no glow.
    volt: "border-spine-volt/40 bg-spine-volt/[0.07] text-spine-volt",
  } as const;
  return <div className={`rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${tones[tone]}`}>{children}</div>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-8 w-full" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Icons (inline so nothing is fetched)                                                        */
/* ------------------------------------------------------------------------------------------ */

const icon = "h-3.5 w-3.5";

export function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={icon} aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className={icon} aria-hidden>
      <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3" aria-hidden>
      <path d="M6.5 3.5h-2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The ⓘ of an `Info`: a ring and an i, drawn so it inherits the text colour like the other icons. */
export function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className={icon} aria-hidden>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75v.01" strokeLinecap="round" />
    </svg>
  );
}

export function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={icon} aria-hidden>
      <path d="M8 2.5 14 13H2L8 2.5Z" strokeLinejoin="round" />
      <path d="M8 6.5v3M8 11.5v.01" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={`${icon} transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={icon} aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={icon} aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
