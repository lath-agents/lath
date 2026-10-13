import type { ReactNode } from "react";

/**
 * The spine: a chain drawn as one glowing line, with a node on it per step or record. The styles are `.spine`, `.spine-item` and `.node-*` in `globals.css`.
 *
 * A node's state is carried by its form as well as its colour, so it still reads to someone who
 * cannot tell the four hues apart: a ring ran, a filled glow is happening or achieved, a dashed
 * ring has not happened yet, a small ring is a look that found nothing.
 */
export type NodeState =
  /** A step that ran (green ring). */
  | "ran"
  /** A run that is on its schedule but not stepping this second (light-blue ring). */
  | "live"
  /** Stepping now (light blue, filled, pulsing). */
  | "now"
  /** Completed: Jev said the goal is met (electric green, filled, glowing). */
  | "achieved"
  /** The next step, not taken yet (dashed blue). */
  | "next"
  /** Waiting: paused, or a stretch the spine does not draw (small blue ring). */
  | "quiet"
  /** A step that did not succeed (rose ring). */
  | "failed"
  /**
   * A step a trace audit flagged or vetoed (a step record that carries one; the trace audit is on the
   * roadmap): the amber every warn badge in the console uses, never purple. A ring, because the step
   * ran; not a spine hue, because a flag is not a state the loop means to be in. Also a step the model
   * did not answer: it is not a fault of the work, and the loop went on.
   */
  | "flagged"
  /** Stopped, and nothing more will land (grey ring). */
  | "idle"
  /*
   * Record kinds, for a spine of chain records rather than of steps: a Genesis opens the chain
   * (blue ring), an Action happens (light-blue ring), a Delegation hands work on (green ring), and
   * a Resolution is the answer (electric green, filled). A failed record uses `failed` instead.
   */
  | "genesis"
  | "action"
  | "delegation"
  | "resolution";

export function Node({ state, title }: { state: NodeState; title?: string }) {
  return <span className={`node ${state === "ran" ? "" : `node-${state}`}`} title={title} aria-hidden={!title} />;
}

export function Spine({
  children,
  className = "",
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <ol className={`spine ${className}`} aria-label={label}>
      {children}
    </ol>
  );
}

export function SpineItem({ state, children, title }: { state: NodeState; children: ReactNode; title?: string }) {
  return (
    <li className="spine-item">
      <Node state={state} title={title} />
      {children}
    </li>
  );
}
