"use client";

import { parseSourcesNote, sourcesNoteLines } from "@/lib/sources-note";

/**
 * The step's _changed since pinned_ note on a screen: one short line per Solana source that moved
 * — `[4] EXkX…WpXX: upgradeAuthority C6bY…Qm1a → pAtq…tw3P, authorityKind keypair → pda` — or
 * _nothing changed since pinned_. Built to be read at a glance, so addresses are cut to their
 * ends; the full note, as the model read it, is the title and, past three lines, a click away.
 *
 * Renders nothing without a note: a loop with no Solana source, and a row written without the field.
 */
export function SourcesNoteLine({ note, className = "" }: { note?: string; className?: string }) {
  if (!note) return null;
  const view = parseSourcesNote(note);
  const lines = sourcesNoteLines(view);
  const base = `max-w-[26rem] text-2xs ${className}`;
  if (!lines) {
    return (
      <div className={`${base} text-ink-3`} data-testid="step-sources-note" data-changed="0" title={note}>
        nothing changed since pinned
      </div>
    );
  }
  const head = (
    <span className="font-medium text-ink-1">
      Changed since pinned{view.unchanged ? ` (${view.unchanged} unchanged)` : ""}:
    </span>
  );
  const body = lines.map((l, i) => (
    <div key={i} className="break-all font-mono text-ink-2">
      {l}
    </div>
  ));
  // A long note folds, so a step row stays a row; the first line of it is already what moved.
  if (lines.length > 3) {
    return (
      <details className={base} data-testid="step-sources-note" data-changed={view.changed} title={note}>
        <summary className="cursor-pointer">
          {head} <span className="font-mono text-ink-2">{lines[0]}</span>
          <span className="text-ink-3"> and {lines.length - 1} more</span>
        </summary>
        {body.slice(1)}
      </details>
    );
  }
  return (
    <div className={base} data-testid="step-sources-note" data-changed={view.changed} title={note}>
      {head}
      {body}
    </div>
  );
}
