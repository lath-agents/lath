import type { ReactNode } from "react";
import { Node, NodeState } from "@/components/Spine";

/**
 * The layout every tab shares: a list on the left and the selected item's details
 * on the right, sticky while the list scrolls. Selecting a row never leaves the tab; the detail
 * panel links to the item's full page.
 *
 * The list is a `div` with `role="list"`, and each row carries whatever `data-testid` its tab's
 * specs address rows by, so a spec finds a row here as it does in the grid.
 */
export function SplitView({
  list,
  detail,
  listTestId,
  listHeader,
}: {
  list: ReactNode;
  detail: ReactNode;
  listTestId?: string;
  /** Drawn above the list in its column, outside the scroll: the list's title, search and actions. */
  listHeader?: ReactNode;
}) {
  // The header takes the first row of the list's column only, and the list and the detail share the
  // second, so the detail opens level with the top of the list rather than with the header above it.
  // On one column the header, list and detail stack in that order.
  return (
    <div className="grid items-start gap-x-4 gap-y-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {listHeader && <div className="min-w-0 lg:col-start-1 lg:row-start-1">{listHeader}</div>}
      <div
        data-testid={listTestId}
        role="list"
        className={`max-h-[75vh] overflow-y-auto rounded-xl border border-line/[0.08] bg-surface-1 lg:col-start-1 ${
          listHeader ? "lg:row-start-2" : "lg:row-start-1"
        }`}
      >
        {list}
      </div>
      {detail && (
        // Stretched to the row so the panel's own `lg:sticky` still has the list's height to stick within.
        <div className={`min-w-0 lg:col-start-2 lg:self-stretch ${listHeader ? "lg:row-start-2" : "lg:row-start-1"}`}>
          {detail}
        </div>
      )}
    </div>
  );
}

/**
 * One row of a `SplitView` list: a node, a name, a badge, and a mono line under them. `after` is
 * rendered below the row's button, outside it, for things that are interactive themselves (a
 * copy button cannot sit inside another button).
 */
export function SplitRow({
  node,
  name,
  badge,
  sub,
  selected,
  onSelect,
  after,
  testId,
  dataId,
  dataIdAttr = "data-id",
}: {
  node: NodeState;
  name: ReactNode;
  badge?: ReactNode;
  sub?: ReactNode;
  selected: boolean;
  onSelect: () => void;
  after?: ReactNode;
  testId?: string;
  dataId?: string;
  /** The attribute `dataId` is written to, for specs that look rows up by e.g. `data-loop-id`. */
  dataIdAttr?: string;
}) {
  return (
    <div
      role="listitem"
      data-testid={testId}
      {...(dataId !== undefined ? { [dataIdAttr]: dataId } : {})}
      className={`border-t border-line/[0.07] transition-colors first:border-t-0 ${
        selected ? "bg-accent/[0.06] shadow-[inset_2px_0_0_rgb(var(--accent))]" : "hover:bg-line/[0.025]"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg px-4 pt-3 text-left ${
          after ? "" : "pb-3"
        }`}
      >
        <Node state={node} />
        <span className="truncate font-medium text-ink-1">{name}</span>
        {badge ?? <span />}
        {sub && <span className="num col-start-2 col-end-4 truncate text-2xs text-ink-3">{sub}</span>}
      </button>
      {after && <div className="pb-3 pl-[46px] pr-4">{after}</div>}
    </div>
  );
}

/** The right half: a card with a title row, a sub line, the body and a footer of actions. */
export function SplitDetail({
  title,
  badges,
  action,
  sub,
  children,
  footer,
  testId,
}: {
  title: ReactNode;
  badges?: ReactNode;
  /** At the right end of the title row: the link to the full page. */
  action?: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="min-w-0 rounded-xl border border-line/[0.08] bg-surface-1 p-5 lg:sticky lg:top-20"
      data-testid={testId}
    >
      <header className="mb-5 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 break-words text-lg font-semibold tracking-tight text-ink-1">{title}</h2>
          {badges}
          {action && <div className="ml-auto">{action}</div>}
        </div>
        {sub && <div className="text-xs text-ink-3">{sub}</div>}
      </header>
      {children}
      {footer && (
        <footer className="mt-5 flex flex-wrap items-center gap-2 border-t border-line/[0.07] pt-4">{footer}</footer>
      )}
    </section>
  );
}

/** A small caps heading between sections of a detail panel. */
export function SplitSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <div className="eyebrow mb-2.5">{title}</div>
      {children}
    </div>
  );
}
