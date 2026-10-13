"use client";

import { Fragment } from "react";
import { jailRules } from "@lath/runtime/zeroclaw/posture-irys";
import { Badge } from "@/components/ui";
import { truncate } from "@/lib/format";
import type { IrysPosture, SandboxPostureIrys } from "@/lib/zeroclaw";

export { postureSource, useIrysPosture } from "@/lib/zeroclaw";

/**
 * The Posture card's _Jail rules_: the wrapper template the committed posture names, one rule a
 * line, its `@NAME@` placeholders left as placeholders and listed with what each stands for. Never
 * filled with a step's host paths: those are one run's, nothing commits them, and they are the host's
 * filesystem layout, which no route serves. Collapsed, because the posture JSON above it is
 * the record and this is a reading of one of its keys.
 *
 * The wording is held to what is shown: these are the rules the posture names. That the process ran
 * under them is the host's claim; nothing here, and nothing on chain, shows it.
 */
export function JailRules({
  postureJson,
  from,
  at,
  irys,
}: {
  /** The posture's bytes, from Irys when they re-hashed there, else this console's. */
  postureJson: string | null;
  from: "irys" | "console";
  at: SandboxPostureIrys | null;
  irys: IrysPosture | undefined;
}) {
  let parsed: unknown = null;
  try {
    parsed = postureJson ? JSON.parse(postureJson) : null;
  } catch {
    parsed = null;
  }
  // `jailRules` checks the wrapper's shape itself and answers `null` for anything that is not one.
  const rules = parsed && typeof parsed === "object" ? jailRules(parsed as Parameters<typeof jailRules>[0]) : null;
  return (
    <div className="space-y-1.5" data-testid="zeroclaw-jail-rules">
      <IrysPostureLine at={at} irys={irys} />
      {rules && (
        <details className="space-y-1.5">
          <summary className="cursor-pointer text-xs text-ink-3">
            Jail rules ({rules.kind}, {rules.lines.length} lines, {from === "irys" ? "from Irys" : "from this console"})
          </summary>
          <p className="text-2xs text-ink-3">
            {rules.explained} These are the rules the committed posture names; they do not show that the process ran
            under them.
          </p>
          <pre className="well max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-2xs text-ink-2">
            {rules.lines.map((line, i) => (
              <Fragment key={i}>
                <Placeheld line={line} />
                {"\n"}
              </Fragment>
            ))}
          </pre>
          {rules.placeholders.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs text-ink-3">
              {rules.placeholders.map((p) => (
                <Fragment key={p.name}>
                  <dt className="font-mono text-ink-2">@{p.name}@</dt>
                  <dd>{p.meaning}</dd>
                </Fragment>
              ))}
            </dl>
          )}
        </details>
      )}
    </div>
  );
}

/** One rule with each `@NAME@` marked as a placeholder, not as a path. */
function Placeheld({ line }: { line: string }) {
  const parts = line.split(/(@[A-Z]+@)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^@[A-Z]+@$/.test(part) ? (
          <span
            key={i}
            className="rounded bg-accent/10 px-0.5 text-accent-strong"
            title="filled at spawn, not committed"
          >
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  );
}

/** Where the posture is on Irys, and whether the copy there re-hashed to the committed hash. */
function IrysPostureLine({ at, irys }: { at: SandboxPostureIrys | null; irys: IrysPosture | undefined }) {
  if (!at) return null;
  const url = `${at.gateway}/${at.id}`;
  const verdict = !irys ? "reading" : irys.state === "read" ? (irys.read.ok ? "match" : "mismatch") : "unavailable";
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="zeroclaw-posture-irys">
      <Badge tone={verdict === "match" ? "good" : verdict === "mismatch" ? "bad" : "neutral"}>{verdict}</Badge>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="link-mono num min-w-0 break-all text-2xs"
        title="the posture's bytes in clear: sha256 of them is the posture hash"
      >
        posture on Irys {truncate(at.id, 8, 6)}
      </a>
      <span className="text-2xs text-ink-3">{at.network}</span>
      <span className="num min-w-0 break-all text-2xs text-ink-3">
        {!irys
          ? "reading from the gateway"
          : irys.state === "unavailable"
          ? `${irys.note}; the checks use this console's copy`
          : irys.read.ok
          ? "re-hashed here to the posture hash"
          : irys.read.why}
      </span>
    </div>
  );
}
