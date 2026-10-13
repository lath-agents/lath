"use client";

/**
 * The loop's Tempo access key on its page, as one line under the money flow: _signed by this loop's
 * own Tempo key 0xab12…cd34 ↗_, the address a link to explore.tempo.xyz, and everything else — the
 * limit, the expiry, the scopes and what the limit covers — in that link's `Info`.
 *
 * What it does not draw, on purpose: no meter of used / limit / left, because the key's remaining
 * limit is reset on every reopen and a meter of it reads as a second budget; and no authorize or revoke transaction, because the key's address page
 * on the explorer is where both are, one click away.
 *
 * Renders nothing when the view has no key — `null` from a console with the switch off, absent from
 * a row written without the field — so every loop started without one draws no key line. The words
 * are `lib/tempo-key.ts`'s, a pure module the node suite holds; this file only lays them out.
 */
import { Badge, Facts } from "@/components/ui";
import { TempoLink } from "@/components/Tempo";
import { useNow } from "@/lib/live";
import { tempoKeyLine, type TempoKeyLine } from "@/lib/tempo-key";
import type { LoopView } from "@/types/loop";

/** The key's name where the page states it, so the page and a test name it alike. */
export const TEMPO_KEY_LABEL = "Tempo-enforced cap";

/** The key's line for `loop`, or `null` when it has none: what decides whether the line is drawn. */
export function loopTempoKeyLine(loop: LoopView, nowMs: number): TempoKeyLine | null {
  return loop.tempoKey ? tempoKeyLine(loop.tempoKey, loop, Math.floor(nowMs / 1000)) : null;
}

/**
 * What the limit covers, said in the panel under the key, in one plain clause: the decision share and
 * Tempo's refusal are in the key line's own text (`tempoKeyLine`), which the audit and the start form
 * read, and the panel is for a glance. `loop` is taken so callers need not change when the clause says
 * something of this loop's own.
 */
export function loopTempoKeyHint(_loop: LoopView): string {
  return "The limit covers the loop's budget.";
}

/**
 * The line. The clock ticks once a minute, enough for an expiry measured in days; it is read here
 * rather than on the page so the page gains no hook ahead of its early returns.
 */
export function LoopTempoKey({ loop }: { loop: LoopView }) {
  const now = useNow(60_000);
  const line = loopTempoKeyLine(loop, now);
  return line ? <TempoKeyLineView line={line} hint={loopTempoKeyHint(loop)} /> : null;
}

function TempoKeyLineView({ line, hint }: { line: TempoKeyLine; hint: string }) {
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1"
      data-testid="loop-tempo-key"
      data-state={line.state}
    >
      <span>signed by this loop&apos;s own key</span>
      <TempoLink
        kind="address"
        value={line.address}
        testId="loop-tempo-key-address"
        details={
          <>
            <div className="text-xs font-medium text-ink-1">{TEMPO_KEY_LABEL}</div>
            <Facts
              items={[
                {
                  label: "limit",
                  value: <span data-testid="loop-tempo-key-limit">{line.limit}</span>,
                  // The console's copy of what the Genesis policy commits by hash; `lath-audit --key`
                  // holds Tempo's authorization to it.
                  source: "console",
                  title: "committed in the loop's Genesis policy, and authorized on Tempo with this limit",
                  mono: true,
                },
                {
                  label: line.state === "revoked" ? "revoked" : "expiry",
                  value: (
                    <span data-testid="loop-tempo-key-expiry">
                      {line.state === "revoked" ? `expiry ${line.expires}` : line.stateText}
                    </span>
                  ),
                  // Revocation is Tempo's answer; without one the line is only the committed expiry.
                  source: line.state === "unknown" ? "console" : "tempo",
                },
              ]}
            />
            {(line.state === "revoked" || line.state === "expired") && (
              <Badge
                tone={line.state === "expired" ? "warn" : "neutral"}
                title={
                  line.state === "revoked"
                    ? "Tempo says the treasury revoked this key: it can sign nothing more"
                    : "Past the expiry the treasury authorized; Tempo refuses the key"
                }
              >
                {line.state}
              </Badge>
            )}
            {line.scopes && (
              // The call scopes Tempo enforces beside the limit. The selector names and
              // `CallNotAllowed` are said here and nowhere else on the page.
              <p className="text-2xs leading-relaxed text-ink-3" data-testid="loop-tempo-key-scopes">
                The key {line.scopes}; Tempo refuses any other call it signs (CallNotAllowed).
              </p>
            )}
            <p className="text-2xs leading-relaxed text-ink-2" data-testid="loop-tempo-key-hint">
              {hint}
            </p>
          </>
        }
      />
      {/* On the line itself, not only in the ⓘ: after a stop, that the key can sign nothing more is the
        line's news, and a reader should not have to open the panel to find it. */}
      {(line.state === "revoked" || line.state === "expired") && (
        <span data-testid="loop-tempo-key-state">
          <Badge tone={line.state === "expired" ? "warn" : "neutral"}>{line.state}</Badge>
        </span>
      )}
    </span>
  );
}
