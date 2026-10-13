/**
 * The _changed since pinned_ note read back off a step's row for a screen. The console keeps the note's
 * **text** — the exact bytes the step's message carried, which `messageHash` commits — so the page parses
 * that text rather than a second, structured copy that could say something the model was not told.
 *
 * The grammar is `renderRefresh` in `runtime/src/zeroclaw/sources.ts`: a head line, then per Solana
 * source `[n] <address>: unchanged since slot …`, `[n] <address>: changed since slot … (read at slot …)`
 * followed by indented `what: old → new` lines (and a `… k more changed fields` line when the note was
 * held to its size), or `[n] could not re-read <address>: <reason>`. A line this does not know is kept
 * as `other` rather than dropped, so a later wording still reaches the screen.
 *
 * Pure and dependency-free: the loop page, the ZeroClaw page and the Node tests all import it.
 */

export interface SourcesNoteChange {
  what: string;
  from: string;
  to: string;
}

export type SourcesNoteRow =
  | { n: number; address: string; kind: "unchanged" }
  | { n: number; address: string; kind: "changed"; changes: SourcesNoteChange[]; more: number }
  | { n: number; address: string; kind: "unread"; reason: string }
  | { kind: "other"; line: string };

export interface SourcesNoteView {
  rows: SourcesNoteRow[];
  /** Sources with at least one changed field. */
  changed: number;
  unchanged: number;
  unread: number;
}

const CHANGED = /^\[(\d+)\] (\S+): changed since slot /;
const UNCHANGED = /^\[(\d+)\] (\S+): unchanged since slot /;
const UNREAD = /^\[(\d+)\] could not re-read (\S+): (.*)$/;
const FIELD = /^ {2}(.+?): (.*) → (.*)$/;
const MORE = /^ {2}… (\d+) more changed field/;

export function parseSourcesNote(text: string): SourcesNoteView {
  const rows: SourcesNoteRow[] = [];
  let open: Extract<SourcesNoteRow, { kind: "changed" }> | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("Changed since pinned:")) continue;
    let m: RegExpExecArray | null;
    if (open && (m = MORE.exec(line))) {
      open.more += Number(m[1]);
      continue;
    }
    if (open && (m = FIELD.exec(line))) {
      open.changes.push({ what: m[1], from: m[2], to: m[3] });
      continue;
    }
    open = null;
    if ((m = CHANGED.exec(line))) {
      open = { n: Number(m[1]), address: m[2], kind: "changed", changes: [], more: 0 };
      rows.push(open);
    } else if ((m = UNCHANGED.exec(line))) {
      rows.push({ n: Number(m[1]), address: m[2], kind: "unchanged" });
    } else if ((m = UNREAD.exec(line))) {
      rows.push({ n: Number(m[1]), address: m[2], kind: "unread", reason: m[3] });
    } else {
      rows.push({ kind: "other", line: line.trim() });
    }
  }
  const count = (k: SourcesNoteRow["kind"]) => rows.filter((r) => r.kind === k).length;
  return { rows, changed: count("changed"), unchanged: count("unchanged"), unread: count("unread") };
}

/**
 * A value as a screen shows it: an address or a 64-hex hash cut to its ends, a JSON-quoted string or
 * structure cut at 24 characters, anything short as it is. The full text stays one click away.
 */
export function shortNoteValue(v: string): string {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return `${v.slice(0, 4)}…${v.slice(-4)}`;
  if (/^[0-9a-f]{64}$/i.test(v)) return `${v.slice(0, 8)}…`;
  return v.length > 24 ? `${v.slice(0, 23)}…` : v;
}

/**
 * One line per changed source, for a row: `[4] EXkX…WpXX: upgradeAuthority C6bY…Qm1a → pAtq…w3P,
 * authorityKind keypair → pda`, then the ones that could not be re-read. `null` for a note that says
 * nothing moved and nothing failed, which the page words as _nothing changed since pinned_.
 */
export function sourcesNoteLines(view: SourcesNoteView): string[] | null {
  const lines: string[] = [];
  for (const r of view.rows) {
    if (r.kind === "changed") {
      const fields = r.changes.map((c) => `${c.what} ${shortNoteValue(c.from)} → ${shortNoteValue(c.to)}`);
      if (r.more > 0) fields.push(`${r.more} more`);
      lines.push(`[${r.n}] ${shortNoteValue(r.address)}: ${fields.join(", ") || "changed"}`);
    } else if (r.kind === "unread") {
      lines.push(`[${r.n}] ${shortNoteValue(r.address)}: could not re-read (${r.reason})`);
    } else if (r.kind === "other") {
      lines.push(r.line);
    }
  }
  return lines.length ? lines : null;
}
