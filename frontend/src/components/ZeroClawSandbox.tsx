"use client";

import { createContext, useContext, useMemo, useState } from "react";
import Link from "next/link";
import { toBytes32 } from "@lath/sdk/browser";
import {
  Badge,
  Button,
  Card,
  Copyable,
  Crumbs,
  Empty,
  ErrorNote,
  ExplorerLink,
  KV,
  Note,
  Skeleton,
  SourceTag,
} from "@/components/ui";
import type { SandboxSourcesIrys } from "@/app/api/_lib/zeroclaw";
import { SourcesNoteLine } from "@/components/SourcesNote";
import { JailRules, postureSource, useIrysPosture } from "@/components/JailRules";
import { TempoLink } from "@/components/Tempo";
import {
  ChannelEscrowLink,
  IrysTag,
  SettledLink,
  plural,
  useIrysSources,
  useSandboxSources,
  useStepProof,
  type SandboxSources,
  type StepProof,
} from "@/components/ZeroClawProof";
import { formatTimestampMs, formatUsdc, truncate } from "@/lib/format";
import { useEvents } from "@/lib/queries";
import { useTrace, useTraceStore } from "@/lib/traces";
import { useLoop } from "@/lib/loops";
import { formatBaseUnits } from "@/lib/tempo";
import { voucherDelta } from "@/lib/zeroclaw-proof";
import { bytesLabel, sandboxActions } from "@/lib/tiles";
import { textSourceLine } from "@/lib/attached-sources";
import {
  canonicalJson,
  checkPosture,
  checkSources,
  sha256Hex,
  stepGenesis,
  useZeroClawSandbox,
  type ChainAction,
  type PostureCheck,
  type Sourced,
  type SourcesManifest,
  type ZeroClawHostView,
  type ZeroClawSandboxDetail,
  type ZeroClawSandboxRow,
} from "@/lib/zeroclaw";
import {
  ZEROCLAW_ATTRIBUTION,
  airGapSentence,
  replayRecords,
  type ZeroClawReplay,
  type ZeroClawReplayRecord,
} from "@/types/zeroclaw";
import { stepStageText } from "@/types/loop";

/**
 * One loop's sandbox: one step's posture as committed — `?step=N`, else the last step's — what was
 * derived from it, the binary, the step's tool calls as Actions, and the replay record. Every step has
 * its own page because a loop steps faster than a reader.
 *
 * The console's record and the chain's, kept apart as on the loop page. The route says what the
 * sandbox was handed and what it recorded; this page reads the step's records off the chain, lists
 * them by seq, holds the sandbox's record against them, and re-hashes the posture against the
 * `policy_version_hash` the step's Genesis committed. What it never does is run anything: a replay
 * spawns the binary, which is the CLI's job and never the browser's or the console's, so
 * *replayable* here means a replay can be attempted, not that one passed.
 *
 * A step opens more than one sandbox when it has a team: session A,
 * each member's, and the synthesis in session A's. _Sandboxes in this step_ lists them, and
 * `?sandbox=<member name>` points the Posture, Actions and Replay cards at that member's sandbox and its
 * own chain. The bare step URL is session A's.
 *
 * It is a component rather than a page so the loop page can carry it as its _ZeroClaw Sandbox_ tab;
 * the `/zeroclaw/<id>` route renders it whole too, so a link to that route keeps working.
 */
export function ZeroClawSandboxView({
  id,
  at,
  member,
  embedded = false,
}: {
  id: string;
  /** The step shown; undefined is the newest, as the bare URL has always meant. */
  at?: number;
  /** A member's sandbox on a team step; undefined is session A's. */
  member?: string;
  /** Inside the loop page's _ZeroClaw Sandbox_ tab: no crumbs of its own, and links stay on that page. */
  embedded?: boolean;
}) {
  const query = useZeroClawSandbox(id, at, member);
  const sandbox = query.data?.sandbox;

  if (query.isLoading) return <Skeleton rows={6} />;
  if (!sandbox) {
    return (
      <div className="space-y-6">
        {!embedded && <Crumbs items={[{ label: "Agents", href: "/" }, { label: truncate(id, 10, 4) }]} />}
        <ErrorNote>
          No loop with that id is known here. Sandboxes are read from this server&apos;s own loop registry, so a loop
          started against a different deployment will not be found by this one.
        </ErrorNote>
      </div>
    );
  }
  return (
    <Embedded.Provider value={embedded}>
      {/* Keyed on the chain read: a `?sandbox=` member is another agent on the same page, and its reads
          start fresh rather than from the last agent's. */}
      <Sandbox key={sandbox.selected.agentId} sandbox={sandbox} host={query.data!.host} />
    </Embedded.Provider>
  );
}

function Sandbox({ sandbox, host }: { sandbox: ZeroClawSandboxDetail; host: ZeroClawHostView }) {
  const step = sandbox.step;
  const platform = sandbox.wrapper.value?.platform ?? null;
  const sources = useSandboxSources(sandbox);
  // The loop row, for the two things the sandbox read does not carry: the checkpoint's signature
  // and the loop channel's close. Both are the console's; each is shown with that tag.
  const loop = useLoop(sandbox.loopId).data?.loop ?? null;
  const proof = useStepProof(sandbox, sources, loop);
  const embedded = useContext(Embedded);

  return (
    <div className="space-y-6">
      {!embedded && (
        <Crumbs
          items={[
            { label: "Agents", href: `/?run=${encodeURIComponent(sandbox.loopId)}` },
            { label: sandbox.agentName || sandbox.loopId, href: `/loop/${sandbox.loopId}` },
            { label: "ZeroClaw Sandbox" },
          ]}
        />
      )}

      <Card
        tone="cyan"
        title={
          <>
            <span>{sandbox.agentName || truncate(sandbox.agentId, 8, 4)}</span>
            {sandbox.stepping ? (
              // With the running step's stage when the console reports one: _in a sandbox · model call 2_.
              <Badge tone="cyan" dot>
                {sandbox.stepStage ? `in a sandbox · ${stepStageText(sandbox.stepStage)}` : "in a sandbox"}
              </Badge>
            ) : sandbox.sandboxed ? (
              <Badge tone="compressed">sandboxed</Badge>
            ) : (
              <Badge tone="neutral">not yet sandboxed</Badge>
            )}
          </>
        }
        description={
          <>
            The sandbox of{" "}
            <Link href={`/loop/${sandbox.loopId}`} className="link-mono">
              this loop
            </Link>{" "}
            on{" "}
            <Link href={`/agent/${sandbox.agentId}`} className="link-mono">
              this agent&apos;s chain
            </Link>
            : a one-shot Lath-patched ZeroClaw process per step, started at the step&apos;s Genesis and gone before its
            Resolution.
          </>
        }
        right={step ? <span className="num text-xs text-ink-3">step {step.step}</span> : undefined}
      >
        <div className="space-y-4">
          <StepLinks sandbox={sandbox} />
          {!step && sandbox.steps.length > 0 && (
            <Note tone="warn">
              This loop has no such step. It has run steps {sandbox.steps[0]}–{sandbox.steps[sandbox.steps.length - 1]}.
            </Note>
          )}
          <p className="text-sm leading-relaxed text-ink-2" data-testid="zeroclaw-airgap">
            {airGapSentence(step?.sandboxed ? platform : null)}
          </p>
          <p className="text-2xs text-ink-3">
            The chain commits the posture this binary was told to apply, the binary&apos;s hash and the wrapper the host
            started it under. That is the claim; this page does not say the sandbox was isolated beyond it.
          </p>
          <KV
            items={[
              { label: "loop", value: <Copyable value={sandbox.loopId} display={truncate(sandbox.loopId, 12, 4)} /> },
              {
                label: "wrapper",
                value: sourcedValue(sandbox.wrapper, (w) => (
                  <span className="inline-flex items-center gap-2">
                    <Badge tone="compressed">{w.kind}</Badge>
                    <span className="text-xs text-ink-2">{w.platform === "macos" ? "macOS" : "Linux"}</span>
                  </span>
                )),
              },
              {
                label: "ran",
                value: step
                  ? sourcedValue(step.ranAt, (t) => <span suppressHydrationWarning>{formatTimestampMs(t)}</span>)
                  : "—",
              },
              {
                label: "metered",
                value: sourcedValue(sandbox.stepCostMicroUsdc, (c) => (
                  <span className="num">{formatUsdc(BigInt(c))} USDC</span>
                )),
                hint: (
                  <>
                    the proxy&apos;s meter for{" "}
                    {sandbox.selected.kind === "member" ? `${sandbox.selected.label}'s session` : "the step's session"};
                    the Tempo channel it rode is on the{" "}
                    <Link href={`/loop/${sandbox.loopId}`} className="link-mono">
                      loop&apos;s page
                    </Link>
                  </>
                ),
              },
              ...(step ? proofSummaryItems(sandbox, proof) : []),
            ]}
          />
          {step?.refused && <Note tone="warn">The sandbox refused the step: {step.refused}</Note>}
          <p className="text-2xs text-ink-3" data-testid="zeroclaw-routes">
            Read from <code>GET /api/zeroclaw/{sandbox.loopId}</code> (this console&apos;s loop registry, read-only) and
            the step&apos;s records on Solana. Nothing here writes.
          </p>
          <p className="text-2xs text-ink-3" data-testid="zeroclaw-attribution">
            {ZEROCLAW_ATTRIBUTION}
          </p>
        </div>
      </Card>

      {step && <StepOrderCard sandbox={sandbox} sources={sources} proof={proof} />}
      <SandboxesCard sandbox={sandbox} />
      {sandbox.sources && <SourcesCard sandbox={sandbox} src={sources} />}
      {/* Keyed on the sandbox and step it describes, so a verify pressed on one step is not shown as
          run on the next. The step is named by its number, which every step has: its checkpoint seq is
          absent on a step that wrote none, and two such steps keyed on it shared one card and one verify. */}
      <PostureCard
        key={`${sandbox.loopId}:${sandbox.selected.agentId}:${sandbox.selected.sandbox ?? ""}:${
          sandbox.step ? `step-${sandbox.step.step}` : "no-step"
        }`}
        sandbox={sandbox}
        host={host}
      />
      <ActionsCard sandbox={sandbox} proof={proof} />
      <ReplayCard sandbox={sandbox} />
    </div>
  );
}

/** `?step=` and `?sandbox=` as the view takes them, read the same way on both routes that show it. */
export function sandboxQuery(sp: { step?: string; sandbox?: string; room?: string }): {
  at?: number;
  member?: string;
} {
  // A `?step=` that is not a step number reads as no step at all: the last step's page, as linked.
  const at = sp.step && /^[1-9][0-9]{0,8}$/.test(sp.step) ? Number(sp.step) : undefined;
  // The route refuses an empty or overlong name; either reads here as session A, the bare URL.
  // `?room=` is the same link under the older name for a sandbox, a room, which older links carry.
  const asked = sp.sandbox ?? sp.room;
  const member = asked && asked.length <= 128 ? asked : undefined;
  return { at, member };
}

/**
 * Whether this view sits in the loop page's _ZeroClaw Sandbox_ tab. There its step and
 * member links stay on the loop page, under `#sandbox`, rather than leaving for `/zeroclaw/<id>`.
 */
const Embedded = createContext(false);

/** The link to one sandbox of one step: the bare step URL for session A, `&sandbox=` for a member. */
function sandboxHref(
  sandbox: ZeroClawSandboxDetail,
  step: number | undefined,
  member: string | null,
  embedded: boolean
): string {
  const params = new URLSearchParams();
  if (step !== undefined) params.set("step", String(step));
  if (member) params.set("sandbox", member);
  const q = params.toString();
  return embedded
    ? `/loop/${sandbox.loopId}${q ? `?${q}` : ""}#sandbox`
    : `/zeroclaw/${sandbox.loopId}${q ? `?${q}` : ""}`;
}

/**
 * Every sandbox the step opened, one row each: which wrapper, which posture, how many `zc.*` calls,
 * and whether a replay can be attempted. A member's _replayable_ is a yes or no when its step's
 * manifest committed the member's record, and the server's sentence on an older step written
 * without members' records committed, which is neither.
 */
function SandboxesCard({ sandbox }: { sandbox: ZeroClawSandboxDetail }) {
  if (!sandbox.step || sandbox.sandboxes.length === 0) return null;
  const at = sandbox.step.step;
  return (
    <Card
      title={
        <>
          <span>Sandboxes in this step</span>
          <SourceTag source="console" />
        </>
      }
      description={
        <>
          Every sandbox step {at} opened: the orchestrator&apos;s session, each member&apos;s own sandbox, and the
          synthesis when there was one. Pick a member to point the cards below at its sandbox and its own chain.
        </>
      }
      right={<span className="num text-xs text-ink-3">{sandbox.sandboxes.length}</span>}
    >
      <ul className="divide-y divide-line/[0.06]" data-testid="zeroclaw-sandboxes">
        {sandbox.sandboxes.map((r) => (
          <SandboxRow key={`${r.kind}:${r.label}`} sandbox={sandbox} row={r} at={at} />
        ))}
      </ul>
    </Card>
  );
}

function SandboxRow({ sandbox, row, at }: { sandbox: ZeroClawSandboxDetail; row: ZeroClawSandboxRow; at: number }) {
  const embedded = useContext(Embedded);
  const shown = row.kind !== "synthesis" && row.sandbox === sandbox.selected.sandbox;
  const label =
    row.kind === "synthesis" ? (
      <span className="text-ink-2">{row.label}</span>
    ) : shown ? (
      <span className="rounded bg-accent/10 px-1.5 text-accent-strong" aria-current="page">
        {row.label}
      </span>
    ) : (
      <Link href={sandboxHref(sandbox, at, row.sandbox, embedded)} className="link-mono">
        {row.label}
      </Link>
    );
  return (
    <li className="space-y-1 py-2 text-xs" data-testid="zeroclaw-sandbox-row" data-kind={row.kind}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 break-all font-medium">{label}</span>
        {row.kind === "member" && <span className="text-2xs text-ink-3">member</span>}
        {row.wrapper.value ? (
          <Badge tone="compressed">{row.wrapper.value.kind}</Badge>
        ) : (
          <Badge tone="neutral">no sandbox</Badge>
        )}
        {row.postureHash.value && (
          <span className="num text-2xs text-ink-3" title={row.postureHash.value}>
            posture {truncate(row.postureHash.value, 8, 6)}
          </span>
        )}
        {row.zcActions.value !== null && (
          <span className="num text-2xs text-ink-2">{sandboxActions(row.zcActions.value)}</span>
        )}
        {row.replayable.value === true ? (
          <Badge tone="good">replayable</Badge>
        ) : row.replayable.value === false ? (
          <Badge tone="neutral">not replayable</Badge>
        ) : null}
      </div>
      {[row.zcActions, row.replayable, row.wrapper]
        .map((f) => f.note)
        .filter((n, i, all): n is string => !!n && all.indexOf(n) === i)
        .map((n) => (
          <p key={n} className="text-2xs text-ink-3" data-testid="zeroclaw-sandbox-note">
            {n}
          </p>
        ))}
      {row.refused && <p className="text-2xs text-rose-300">refused: {row.refused}</p>}
    </li>
  );
}

/** One source's resolved pin as a person reads it: the commit on GitHub, the final URL, the slot. */
function SourcePin({ source }: { source: SourcesManifest["sources"][number]["source"] }) {
  if (source.kind === "github") {
    const tree = `https://github.com/${source.owner}/${source.repo}/tree/${source.commit}${
      source.path ? `/${source.path}` : ""
    }`;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="text-ink-3">{source.ref ? `${source.ref} →` : "default branch →"}</span>
        <a href={tree} target="_blank" rel="noreferrer" className="link-mono num" title={source.commit}>
          {source.commit.slice(0, 12)}
        </a>
      </span>
    );
  }
  if (source.kind === "text") {
    return <span className="text-ink-3">attached by the owner at start · {source.contentType}</span>;
  }
  if (source.kind === "url") {
    // A link only to what the fetcher could have fetched: the record is the console's, and an href
    // taken from it unchecked is a `javascript:` URL away from running in this page.
    const safe = /^https:\/\//i.test(source.finalUrl);
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
        {safe ? (
          <a href={source.finalUrl} target="_blank" rel="noreferrer" className="link-mono min-w-0 break-all">
            {source.finalUrl}
          </a>
        ) : (
          <span className="min-w-0 break-all">{source.finalUrl}</span>
        )}
        <span className="text-ink-3">{source.contentType}</span>
      </span>
    );
  }
  // _Solana mainnet_ rather than a bare _mainnet_ beside the nav's _Tempo · mainnet_ pill; the label
  // only, the committed `cluster` is unchanged.
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone="neutral">Solana {source.cluster}</Badge>
      <span className="num text-ink-2">slot {source.slot}</span>
    </span>
  );
}

/**
 * The sources the sandbox was seeded with, as committed: each input and what
 * it resolved to, files and bytes, what was skipped, and every file with its hash behind a
 * disclosure. The hash is tagged `chain` when it is read from the posture, which _Verify_ ties to
 * the Genesis's `policy_version_hash`, and `console` when only the record's copy is there; the manifest is the console's until the browser re-hashes
 * it here, and a manifest that does not re-hash is shown with the mismatch, not hidden.
 */
function SourcesCard({ sandbox, src }: { sandbox: ZeroClawSandboxDetail; src: SandboxSources }) {
  const { value, posture, fromPosture, committed, irys, onIrys, manifest, manifestFromIrys, fileIds } = src;
  const sources = sandbox.sources!;
  const checks = useMemo(
    () => (value && manifest ? checkSources({ hash: value.hash, manifest }, posture) : null),
    [value, manifest, posture]
  );
  return (
    <Card
      title={
        <>
          <span>Sources</span>
          <SourceTag source="console" />
        </>
      }
      description={
        <>
          Fetched once by the host when the loop started, pinned by commit or slot, and copied read-only under{" "}
          <code>sources/</code> into every sandbox of this loop. The step&apos;s Genesis commits them through the
          posture&apos;s <code>sources.hash</code>.
        </>
      }
    >
      {!value || !manifest ? (
        <p className="text-xs text-ink-3" data-testid="zeroclaw-sources-missing">
          {sources.note ?? "the sandbox recorded its sources hash but not the manifest it names"}
        </p>
      ) : (
        // `manifest` is the console's, or the one on Irys, which `useIrysSources` has re-hashed to
        // `committed` before handing it here.
        <div className="space-y-4" data-testid="zeroclaw-sources">
          <KV
            items={[
              {
                label: "sources hash",
                value: committed ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Copyable value={committed} display={truncate(committed, 12, 8)} />
                    <SourceTag source={fromPosture ? "chain" : "console"} />
                  </span>
                ) : (
                  "—"
                ),
                hint: fromPosture
                  ? "a key of the posture above, which Verify holds against the Genesis"
                  : "the sandbox's own copy; no posture bytes to tie it to the Genesis",
              },
            ]}
          />
          <div className="space-y-1.5" data-testid="zeroclaw-sources-checks">
            {checks!.map((c) => (
              <div key={c.label} className="flex flex-wrap items-baseline gap-2 text-xs">
                <Badge tone={c.verdict === "match" ? "good" : c.verdict === "mismatch" ? "bad" : "neutral"}>
                  {c.verdict}
                </Badge>
                <span className="text-ink-2">{c.label}</span>
                <span className="num min-w-0 break-all text-2xs text-ink-3">{c.detail}</span>
              </div>
            ))}
          </div>
          <IrysLine irys={irys} state={onIrys} />
          <ul className="space-y-3">
            {manifest.sources.map((entry, i) => {
              const bytes = entry.files.reduce((t, f) => t + f.size, 0);
              return (
                <li key={`${i}:${entry.dir}`} className="space-y-1.5 text-xs" data-testid="zeroclaw-source">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="compressed">{entry.source.kind}</Badge>
                    {entry.source.kind === "text" ? (
                      // An attached file has no input to show and no pin but its bytes: the line is its
                      // name, size and hash, as the manifest commits them. Its content is in no manifest.
                      <span
                        className="num min-w-0 break-all text-ink-1"
                        title={entry.files[0]?.sha256}
                        data-testid="zeroclaw-source-text"
                      >
                        {textSourceLine(entry)}
                      </span>
                    ) : (
                      <span className="min-w-0 break-all text-ink-1">{entry.source.input}</span>
                    )}
                    {manifestFromIrys ? <IrysTag /> : <SourceTag source="console" />}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-2">
                    <SourcePin source={entry.source} />
                    <span className="num">
                      {entry.files.length} file{entry.files.length === 1 ? "" : "s"} · {bytesLabel(bytes)}
                    </span>
                    {entry.skipped && (
                      <span className="num text-ink-3">
                        {entry.skipped.files} skipped · {bytesLabel(entry.skipped.bytes)}
                      </span>
                    )}
                  </div>
                  {/* Why a Solana source's `decoded.json` was not made, in the fetcher's words.
                      Rendered as text: the manifest is data, and each line is a string it checked. */}
                  {entry.skipped?.reasons && entry.skipped.reasons.length > 0 && (
                    <ul className="space-y-0.5 text-2xs text-ink-3" data-testid="zeroclaw-source-skipped-reasons">
                      {entry.skipped.reasons.map((r, k) => (
                        <li key={k} className="break-words">
                          skipped: {r}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details>
                    <summary className="cursor-pointer text-2xs text-ink-3">
                      files in <code>sources/{entry.dir}</code>
                    </summary>
                    <ul className="well mt-1.5 max-h-72 space-y-0.5 overflow-auto px-3 py-2 font-mono text-2xs text-ink-2">
                      {entry.files.map((f) => {
                        // The file's own Irys object, by the hash the manifest commits: the gateway
                        // serves the bytes, and whoever opens it re-hashes them against this line.
                        const id = irys && fileIds ? fileIds[f.sha256] : undefined;
                        return (
                          <li key={f.path} className="break-all" data-testid="zeroclaw-source-file">
                            <span className="text-ink-3" title={f.sha256}>
                              {f.sha256.slice(0, 12)}
                            </span>{" "}
                            <span className="num">{f.size}</span> {f.path}
                            {id && (
                              <>
                                {" "}
                                <a
                                  href={`${irys!.gateway}/${id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="link-mono"
                                  title={`${irys!.gateway}/${id}`}
                                  data-testid="zeroclaw-source-file-irys"
                                >
                                  open
                                </a>{" "}
                                <IrysTag />
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** One line under the checks: where the sources are on Irys, and whether the index read back right. */
function IrysLine({ irys, state }: { irys: SandboxSourcesIrys | null; state: ReturnType<typeof useIrysSources> }) {
  if (!irys) return null;
  const verdict = state.isError ? "mismatch" : state.data ? "match" : "unavailable";
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="zeroclaw-sources-irys">
      <Badge tone={verdict === "match" ? "good" : verdict === "mismatch" ? "bad" : "neutral"}>
        {state.isLoading ? "reading" : verdict}
      </Badge>
      <span className="text-ink-2">
        {irys.restored ? "restored from another loop's sources on Irys" : "on Irys"} · {irys.network}
      </span>
      <a
        href={`${irys.gateway}/${irys.index}`}
        target="_blank"
        rel="noreferrer"
        className="link-mono num min-w-0 break-all text-2xs"
        title="the sources index: each file's Irys id by its hash"
      >
        index {truncate(irys.index, 8, 6)}
      </a>
      <IrysTag />
      <span className="num min-w-0 break-all text-2xs text-ink-3">
        {state.isError
          ? (state.error as Error).message
          : state.data
          ? "the index names the hash the posture commits; each file links to its own object"
          : "reading the index from the gateway"}
      </span>
    </div>
  );
}

/**
 * One link per step the loop recorded, the one shown marked. The bare URL follows the loop to its
 * newest step; a `?step=N` link stays on step N while the loop moves on.
 */
function StepLinks({ sandbox }: { sandbox: ZeroClawSandboxDetail }) {
  const embedded = useContext(Embedded);
  if (sandbox.steps.length < 2) return null;
  const shown = sandbox.step?.step;
  const last = sandbox.steps[sandbox.steps.length - 1];
  return (
    <nav className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="steps" data-testid="zeroclaw-steps">
      <span className="text-ink-3">steps</span>
      {sandbox.steps.map((n) => (
        <Link
          key={n}
          href={sandboxHref(sandbox, n, sandbox.selected.sandbox, embedded)}
          aria-current={n === shown ? "page" : undefined}
          className={n === shown ? "num rounded bg-accent/10 px-1.5 text-accent-strong" : "num link-mono px-1.5"}
        >
          {n}
        </Link>
      ))}
      {shown !== last && (
        <Link href={sandboxHref(sandbox, undefined, sandbox.selected.sandbox, embedded)} className="link-mono px-1.5">
          latest
        </Link>
      )}
    </nav>
  );
}

/** A sourced value on screen: the value with its tag, or `—` with the reason beside it. */
function sourcedValue<T>(field: Sourced<T>, show: (v: T) => React.ReactNode) {
  if (field.value === null) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-ink-3">
        — <span>{field.note}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {show(field.value)}
      <SourceTag source={field.source} />
    </span>
  );
}

function PostureCard({ sandbox, host }: { sandbox: ZeroClawSandboxDetail; host: ZeroClawHostView }) {
  const [checks, setChecks] = useState<PostureCheck[] | null>(null);

  const bounds = useMemo(
    () => ({ seq: sandbox.step?.seq.value ?? null, previousSeq: sandbox.previousSeq, genesisSeq: sandbox.genesisSeq }),
    [sandbox.step?.seq.value, sandbox.previousSeq, sandbox.genesisSeq]
  );
  // The step's Genesis, off the chain, and its payload through the trace store: the payload is where
  // `policy_version_hash` sits (`genesisPolicyVersionHash`), so reading it is the one chain read the
  // verify below needs. Only once the reader asks, because it may be a bundle download.
  const events = useEvents(sandbox.selected.agentId, checks !== null && !!bounds.seq);
  const genesis = useMemo(() => stepGenesis(events.data, bounds), [events.data, bounds]);
  const store = useTraceStore(sandbox.selected.agentId);
  const genesisBundle = sandbox.genesisPayloadHash ? toBytes32(sandbox.genesisPayloadHash) : genesis?.payloadHash;
  const trace = useTrace(store, genesis, checks !== null && !!genesis, genesisBundle);
  const genesisPolicy = trace.data?.commitments?.find((c) => c.label === "policy version")?.hash ?? null;
  // A Genesis written encrypted: the check's detail is a dash.
  const sealedGenesis = trace.data?.status === "encrypted";
  const genesisNote = !bounds.seq
    ? "the step wrote no checkpoint to find its Genesis by"
    : events.isLoading || trace.isLoading
    ? "reading the step's Genesis…"
    : !genesis
    ? "no Genesis found in the step's range on chain"
    : sealedGenesis
    ? "—"
    : trace.data && trace.data.status !== "ok"
    ? `the Genesis payload could not be read (${trace.data.status})`
    : undefined;

  // The posture's copy on Irys, read and re-hashed here as soon as the console names one; the
  // checks and the jail rules use it in place of this console's bytes, and fall back to them for a
  // loop with no copy there (an older loop) or a gateway that did not answer.
  const irysPosture = useIrysPosture(sandbox.postureIrys ?? null);
  const source = postureSource(sandbox, irysPosture.data);
  // Re-run when the Genesis read lands, so *verify* is one click and not one per read.
  const shown = checks === null ? null : checkPosture(sandbox, genesisPolicy, genesisNote, irysPosture.data);
  const posture = sandbox.postureJson.value;
  const postureRehash = posture ? sha256Hex(posture) : null;

  return (
    <Card
      title={
        <>
          <span>Posture</span>
          <SourceTag source="console" />
          {sandbox.selected.kind === "member" && <span className="text-xs text-ink-3">{sandbox.selected.label}</span>}
        </>
      }
      description={
        <>
          What the host handed this step&apos;s sandbox: the risk and runtime profile, the wrapper profile and the
          binary&apos;s hash, as canonical JSON under <code>sandbox</code> in the step&apos;s policy document. The TOML
          and the wrapper profile the host derived from it are not shown: they name the host&apos;s directories and
          nothing commits them.
        </>
      }
      right={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setChecks([])}
          disabled={!posture && !sandbox.postureIrys}
          title="Re-hash the posture here (from Irys when it is there), and hold the policy document against the Genesis's policy_version_hash"
          testId="zeroclaw-posture-verify"
        >
          Verify
        </Button>
      }
    >
      <div className="space-y-4">
        <KV
          items={[
            {
              label: "posture hash",
              value: sourcedValue(sandbox.postureHash, (h) => <Copyable value={h} display={truncate(h, 12, 8)} />),
            },
            {
              label: "binary sha256",
              value: sourcedValue(sandbox.binarySha256, (h) => <Copyable value={h} display={truncate(h, 12, 8)} />),
              hint: (
                <>
                  set it beside the hash <code>zeroclaw/build.sh</code> prints for {platformName(sandbox)}; this
                  console&apos;s configured binary is{" "}
                  {host.binarySha256 ? (
                    <code className="num" title={host.binarySha256}>
                      {truncate(host.binarySha256, 8, 6)}
                    </code>
                  ) : (
                    host.note ?? "not configured"
                  )}
                  {host.binarySha256 && sandbox.binarySha256.value && host.binarySha256 !== sandbox.binarySha256.value
                    ? " — not the one this step ran"
                    : ""}
                </>
              ),
            },
          ]}
        />

        {shown && (
          <div className="space-y-1.5" data-testid="zeroclaw-posture-checks">
            {shown.map((c) => (
              <div key={c.label} className="flex flex-wrap items-baseline gap-2 text-xs">
                <Badge tone={c.verdict === "match" ? "good" : c.verdict === "mismatch" ? "bad" : "neutral"}>
                  {c.verdict}
                </Badge>
                <span className="text-ink-2">{c.label}</span>
                <span className="num min-w-0 truncate text-2xs text-ink-3" title={c.detail}>
                  {c.detail}
                </span>
              </div>
            ))}
          </div>
        )}

        {posture ? (
          <Block
            label="posture JSON"
            testId="zeroclaw-posture-json"
            text={posture}
            json
            note={postureRehash ? `sha256 ${postureRehash}` : undefined}
          />
        ) : (
          <p className="text-xs text-ink-3">{sandbox.postureJson.note}</p>
        )}
        <JailRules
          postureJson={source.json}
          from={source.from}
          at={sandbox.postureIrys ?? null}
          irys={irysPosture.data}
        />
      </div>
    </Card>
  );
}

/** `text` re-indented for reading when it parses as JSON; the text as it is when it does not. */
function indentJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function platformName(sandbox: ZeroClawSandboxDetail): string {
  const p = sandbox.wrapper.value?.platform;
  return p === "macos" ? "macOS" : p === "linux" ? "Linux" : "the platform";
}

/**
 * Read-only text: the bytes as recorded, never reformatted — a re-hash is over exactly these.
 * `json` shows them indented instead: the posture is one line of JSON, and wrapped mid-word at the
 * box's edge it cannot be read. Only the display changes; the hash beside it is
 * over the recorded bytes, and the caller computes it from `text`, never from what is shown.
 */
function Block({
  label,
  text,
  note,
  testId,
  json = false,
}: {
  label: string;
  text: string;
  note?: string;
  testId?: string;
  json?: boolean;
}) {
  const shown = json ? indentJson(text) : text;
  const body = (
    // `break-words`, not `break-all`: lines wrap at a token's end and only a token longer than the
    // box (a hash, a path) is cut.
    <pre className="well max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-2xs text-ink-2">
      {shown}
    </pre>
  );
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-3">
        <span>{label}</span>
        {note && <span className="num text-2xs">{note}</span>}
      </div>
      {body}
    </div>
  );
}

/**
 * The step's tool calls as the chain has them, and the sandbox's own record beside them.
 *
 * The rows are the chain's: every Action between the previous checkpoint and this step's, by seq,
 * named from the known tool table — live records, and the leaves of the step's epoch once its blob
 * has rebuilt to the root the chain folded, which is where a loop step's tool calls are. The sandbox's record (`zc.*` from the proxy) is the
 * console's, and each of its entries is held against the chain's Action at that seq by the tool's
 * hash — a record the chain does not carry is a mismatch said out loud, not a row quietly dropped.
 */
function ActionsCard({ sandbox, proof }: { sandbox: ZeroClawSandboxDetail; proof: StepProof }) {
  const { bounds, events, epochs, actions } = proof;
  // An epoch in the step's range that did not open: its leaves are missing from the rows, and the
  // record line would call that a mismatch, so the card says which epoch and why first.
  const unopened = epochs.epochs
    .map((e, i) => ({ e, r: epochs.resolved[i] }))
    .filter(({ r }) => r && r.status !== "ok");
  const recorded = sandbox.actions.value;
  const bySeq = useMemo(() => new Map((actions ?? []).map((a) => [a.seq.toString(), a])), [actions]);
  const mismatches = (recorded ?? []).filter((r) => {
    const onChain = bySeq.get(r.seq);
    return !onChain || onChain.toolHash !== sha256Hex(r.tool);
  });
  const zcOnChain = (actions ?? []).filter((a) => a.zc).length;
  const recordLine = (
    <p className="flex flex-wrap items-center gap-2 text-2xs text-ink-3" data-testid="zeroclaw-actions-record">
      <SourceTag source="console" />
      {recorded === null
        ? sandbox.actions.note ?? "the sandbox recorded no tool calls"
        : mismatches.length === 0
        ? `the sandbox's record of ${recorded.length} tool call${
            recorded.length === 1 ? "" : "s"
          } matches the chain, seq by seq`
        : `the sandbox's record differs from the chain at seq ${mismatches.map((m) => m.seq).join(", ")}`}
    </p>
  );

  const unopenedNote =
    unopened.length > 0 ? (
      <Note tone="warn">
        {unopened
          .map(
            ({ e, r }) =>
              `epoch #${e.startSeq}–${e.endSeq - 1n} could not be opened (${r!.status}), so its Actions are not listed`
          )
          .join("; ")}
        .
      </Note>
    ) : null;

  return (
    <Card
      id="zeroclaw-step-actions"
      title={
        <>
          <span>The step&apos;s tool calls</span>
          <SourceTag source="chain" />
        </>
      }
      description={
        bounds.seq ? (
          sandbox.selected.kind === "member" ? (
            <>
              Every Action {sandbox.selected.label} wrote in step {sandbox.step?.step}, on its own chain, from its
              Genesis to seq {bounds.seq} where the step left it. The sandbox&apos;s file tools are <code>zc.*</code>;
              Lath&apos;s host tools keep the ids they have outside a sandbox.
            </>
          ) : (
            <>
              Every Action of step {sandbox.step?.step} on the agent&apos;s chain, up to its <code>loop.step</code> at
              seq {bounds.seq}. The sandbox&apos;s file tools are <code>zc.*</code>; Lath&apos;s host tools keep the ids
              they have outside a sandbox.
            </>
          )
        ) : sandbox.selected.kind === "member" ? (
          "This member reached no chain write in the step, so there is no range to read its Actions from."
        ) : (
          "This step wrote no checkpoint, so there is no range on the chain to read its Actions from."
        )
      }
      right={
        actions ? (
          <span className="num text-xs text-ink-3" data-testid="zeroclaw-zc-count">
            {sandboxActions(zcOnChain)}
          </span>
        ) : undefined
      }
    >
      {!bounds.seq ? null : events.isLoading || epochs.pending ? (
        <Skeleton rows={3} />
      ) : events.isError || epochs.error ? (
        <Empty>
          The chain read failed (
          {(events.error ?? epochs.error) instanceof Error
            ? ((events.error ?? epochs.error) as Error).message
            : "request failed"}
          ).
        </Empty>
      ) : !actions || actions.length === 0 ? (
        // The sandbox's record is still held against the empty range: a record of tool calls the chain
        // does not carry is the mismatch this card exists to say, not a reason to say nothing.
        <div className="space-y-3">
          <Empty>No Actions in the step&apos;s range on chain.</Empty>
          {unopenedNote}
          {recordLine}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="table-wrap">
            <table className="w-full min-w-[40rem] text-sm" data-testid="zeroclaw-actions">
              <thead className="border-b border-line/[0.08]">
                <tr>
                  <th className="th text-right">Seq</th>
                  <th className="th">Tool</th>
                  <th className="th">What it touched</th>
                  <th className="th text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/[0.06]">
                {actions.map((a) => (
                  <tr key={a.seq.toString()} data-testid={a.zc ? "zeroclaw-action-zc" : "zeroclaw-action"}>
                    <td className="td num text-right text-xs text-ink-1">{a.seq.toString()}</td>
                    <td className="td text-xs">
                      {a.tool ? (
                        a.zc ? (
                          <Badge tone="compressed">{a.tool}</Badge>
                        ) : (
                          <span className="text-ink-2">{a.tool}</span>
                        )
                      ) : proof.llmName(a) ? (
                        // Named by the model the policy commits: `llm.<model>` hashes to this id.
                        <span className="text-ink-2" title={a.toolHash}>
                          {proof.llmName(a)}
                        </span>
                      ) : (
                        <span className="num text-2xs text-ink-3" title={a.toolHash}>
                          {truncate(a.toolHash, 8, 6)}
                        </span>
                      )}
                    </td>
                    <td className="td text-xs">
                      <ActionDetailCell action={a} proof={proof} />
                    </td>
                    <td className={`td num text-right text-xs ${a.status >= 400 ? "text-rose-300" : "text-ink-2"}`}>
                      {a.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unopenedNote}
          {recordLine}
        </div>
      )}
    </Card>
  );
}

/**
 * The header card's two summary lines (beside _metered_): the step's model calls and what they paid
 * over Tempo, and its file reads and how many were pinned sources. The counts are the chain's tool
 * ids, which anyone reads; the amounts and the paths are in the calls' blobs. A step written
 * encrypted leaves those parts out: the counts stand alone.
 */
function proofSummaryItems(sandbox: ZeroClawSandboxDetail, proof: StepProof) {
  const c = proof.counts;
  const locked = proof.sealed && !proof.tempo;
  const amount = proof.tempo ? (
    <span className="num text-ink-1">{formatBaseUnits(proof.tempo.total)} USDC.e to OpenRouter via Tempo</span>
  ) : locked ? null : (
    <span className="text-ink-3">no Tempo voucher read</span>
  );
  const model = (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="zeroclaw-proof-model">
      <span className="num text-ink-1">{c ? plural(c.modelCalls, "model call") : "…"}</span>
      <span className="text-ink-3">·</span>
      {amount && (
        <>
          {amount}
          <span className="text-ink-3">·</span>
        </>
      )}
      {proof.settlement ? (
        <SettledLink settlement={proof.settlement} />
      ) : (
        <span className="text-ink-3">channel not closed yet</span>
      )}
    </span>
  );
  const reads = (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="zeroclaw-proof-reads">
      <span className="num text-ink-1">{c ? plural(c.reads, "file read") : "…"}</span>
      {proof.reads ? (
        <span className="num text-ink-2">
          , {proof.reads.fromSources} from pinned sources on Irys
          {proof.reads.opened < (c?.reads ?? 0) ? ` (of the ${proof.reads.opened} this page opened)` : ""}
        </span>
      ) : null}
    </span>
  );
  return [
    {
      label: "model calls",
      value: model,
      hint: proof.tempo
        ? `the voucher deltas in the calls' result blobs${
            proof.tempo.paid < (c?.modelCalls ?? 0) ? `, ${proof.tempo.paid} of ${c?.modelCalls} read` : ""
          }; the count is the chain's tool ids`
        : "counted from the chain's tool ids",
    },
    {
      label: "file reads",
      value: reads,
      hint: sandbox.sources
        ? "a read's path is in its args blob; a pinned one links to its file on Irys in the table below"
        : "this sandbox was seeded with no sources",
    },
  ];
}

/** One line of _This step, in order_: a label, what it says, and its proof link. */
function OrderItem({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <li className="relative pl-4" data-testid={testId}>
      <span className="absolute left-0 top-[0.45rem] h-1.5 w-1.5 rounded-full bg-line/30" aria-hidden />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="w-32 flex-none text-ink-3">{label}</span>
        <span className="min-w-0 flex-1 text-ink-2">{children}</span>
      </div>
    </li>
  );
}

/**
 * _This step, in order_: one step's sandbox run as a chain of links, each to something the operator
 * does not hold — the pinned sources on Irys, the channel's close on Tempo, the checkpoint on Solana
 * The links show that the step's records are
 * consistent with those; they do not show that the process ran in the sandbox, which the Posture
 * card's wrapper is the host's claim for.
 */
function StepOrderCard({
  sandbox,
  sources,
  proof,
}: {
  sandbox: ZeroClawSandboxDetail;
  sources: SandboxSources;
  proof: StepProof;
}) {
  // A step written encrypted keeps its counts and says nothing more.
  const c = proof.counts;
  const manifest = sources.manifest;
  const files = manifest ? manifest.sources.reduce((t, e) => t + e.files.length, 0) : null;
  const irysIndex = sources.irys ? `${sources.irys.gateway}/${sources.irys.index}` : null;
  return (
    <Card
      title="This step, in order"
      description={
        <>
          Step {sandbox.step?.step}
          {sandbox.selected.kind === "member" ? ` · ${sandbox.selected.label}'s sandbox` : ""}, top to bottom, each line
          with the link that checks it. They show the step&apos;s records agree with the pinned files and the settled
          channel; that the process ran in the sandbox is the host&apos;s claim, in the Posture card.
        </>
      }
    >
      <div className="space-y-4">
        <ol className="space-y-2.5" data-testid="zeroclaw-step-order">
          <OrderItem label="sources pinned" testId="zeroclaw-order-sources">
            {sources.committed ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="num">
                  {manifest && files !== null
                    ? `${plural(files, "file")} from ${plural(manifest.sources.length, "source")}`
                    : `sources ${truncate(sources.committed, 8, 6)}`}
                </span>
                {irysIndex ? (
                  <>
                    <a href={irysIndex} target="_blank" rel="noreferrer" className="link-mono num text-2xs">
                      index {truncate(sources.irys!.index, 6, 4)}
                    </a>
                    <IrysTag />
                  </>
                ) : (
                  <span className="text-2xs text-ink-3">not on Irys</span>
                )}
              </span>
            ) : (
              <span className="text-ink-3">none: this sandbox was seeded with its workspace only</span>
            )}
          </OrderItem>
          {sandbox.sourcesNote ? (
            <OrderItem label="changed since pinned" testId="zeroclaw-order-note">
              <SourcesNoteLine note={sandbox.sourcesNote} />
            </OrderItem>
          ) : null}
          <OrderItem label="file reads" testId="zeroclaw-order-reads">
            <span className="num">{c ? plural(c.reads, "read") : "…"}</span>
            {proof.reads ? (
              <span className="num">
                {" "}
                · {proof.reads.fromSources} of pinned files on Irys
                {proof.reads.matched > 0 && ` · ${proof.reads.matched} re-build to the pinned bytes`}
                {proof.reads.mismatched > 0 && (
                  <span className="text-rose-300"> · {proof.reads.mismatched} do not</span>
                )}
              </span>
            ) : null}{" "}
            <a href="#zeroclaw-step-actions" className="link-mono text-2xs">
              each read
            </a>
          </OrderItem>
          <OrderItem label="model calls" testId="zeroclaw-order-model">
            <span className="num">{c ? plural(c.modelCalls, "call") : "…"}</span>
            {proof.tempo ? <span className="num"> · {formatBaseUnits(proof.tempo.total)} USDC.e</span> : null}{" "}
            {proof.settlement ? (
              <SettledLink settlement={proof.settlement} />
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-ink-3">channel not closed yet ·</span>
                <ChannelEscrowLink channelId={proof.tempo?.channels[0]} />
              </span>
            )}
          </OrderItem>
          <OrderItem label="writes" testId="zeroclaw-order-writes">
            {proof.writes ? (
              <span className="break-all font-mono text-2xs text-ink-2">{proof.writes.join(", ")}</span>
            ) : (
              <>
                <span className="num">{c ? plural(c.writes, "write") : "…"}</span>
              </>
            )}
          </OrderItem>
          <OrderItem label="workspace" testId="zeroclaw-order-workspace">
            {proof.workspace ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Hash h={proof.workspace.before} />
                <span className="text-ink-3">→</span>
                <Hash h={proof.workspace.after} />
                <SourceTag source="console" />
              </span>
            ) : (
              <span className="text-ink-3">{sandbox.replay.note ?? "no replay record kept"}</span>
            )}
          </OrderItem>
          <OrderItem label="checkpoint" testId="zeroclaw-order-checkpoint">
            {proof.checkpoint.seq ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Link href={`/agent/${sandbox.agentId}`} className="link-mono num">
                  loop.step at seq {proof.checkpoint.seq}
                </Link>
                {proof.checkpoint.signature ? (
                  <ExplorerLink kind="tx" value={proof.checkpoint.signature} />
                ) : (
                  <span className="text-2xs text-ink-3">no signature recorded</span>
                )}
              </span>
            ) : (
              <span className="text-ink-3">the step wrote no checkpoint</span>
            )}
          </OrderItem>
        </ol>
      </div>
    </Card>
  );
}

/** A small tag beside a read's path: where the path is. */
function WhereTag({ children, pinned = false }: { children: React.ReactNode; pinned?: boolean }) {
  return (
    <span
      className={`rounded px-1 font-mono text-[10px] leading-4 ${
        pinned ? "bg-spine-green/10 text-spine-green" : "bg-line/[0.05] text-ink-3"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * The _What it touched_ cell of one tool call: a file tool's path — linked to its file on Irys when
 * it is a pinned source, with whether the text the model was shown re-builds to that file — or a
 * model call's gateway price and the close that settled it. Nothing is filled in from anywhere else;
 * a call whose blobs were written encrypted is a dash, as a call with nothing to show.
 */
function ActionDetailCell({ action, proof }: { action: ChainAction; proof: StepProof }) {
  const d = proof.detail(action);
  const llm = !!proof.llmName(action);
  if (!d) return <span className="text-ink-3">—</span>;
  if (d.state === "sealed") {
    return (
      <span className="text-ink-3" data-testid="zeroclaw-action-sealed">
        —
      </span>
    );
  }
  if (d.state === "reading" && !d.args && !d.payment) return <span className="text-2xs text-ink-3">reading…</span>;
  if (llm) {
    if (!d.payment) {
      return (
        <span className="text-2xs text-ink-3">
          {d.state === "unavailable" ? "its result blob is not readable here" : "no Tempo voucher in its result"}
        </span>
      );
    }
    return (
      <span className="inline-flex flex-wrap items-center gap-2" data-testid="zeroclaw-action-price">
        <span className="num text-ink-1">{formatBaseUnits(voucherDelta(d.payment))} USDC.e</span>
        {proof.settlement ? (
          <TempoLink kind="tx" value={proof.settlement.view.txHash!} label="settled on Tempo" />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-2xs">
            <span className="text-ink-3">channel not closed yet ·</span>
            <ChannelEscrowLink channelId={proof.tempo?.channels[0]} />
          </span>
        )}
      </span>
    );
  }
  if (!d.args) {
    return (
      <span className="text-2xs text-ink-3">
        {d.state === "unavailable" ? "its args blob is not readable here" : "no path in its args"}
      </span>
    );
  }
  const t = d.target;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2" data-testid="zeroclaw-action-path">
      {t?.kind === "source" && t.url ? (
        <a
          href={t.url}
          target="_blank"
          rel="noreferrer"
          className="link-mono min-w-0 break-all font-mono text-2xs"
          title={`${t.url} · sha256 ${t.file.sha256}`}
          data-testid="zeroclaw-action-irys"
        >
          {d.args.path}
        </a>
      ) : (
        <span className="min-w-0 break-all font-mono text-2xs text-ink-2">{d.args.path}</span>
      )}
      {t?.kind === "source" ? (
        <WhereTag pinned>pinned on Irys</WhereTag>
      ) : t?.kind === "unlisted" ? (
        <WhereTag>under sources/, not a pinned file</WhereTag>
      ) : (
        <WhereTag>workspace</WhereTag>
      )}
      {d.args.partial && <span className="text-2xs text-ink-3">part of the file</span>}
      {d.check && (
        <span data-testid="zeroclaw-action-check" title={d.check.detail}>
          <Badge tone={d.check.verdict === "match" ? "good" : d.check.verdict === "mismatch" ? "bad" : "neutral"}>
            {d.check.verdict === "match"
              ? "matches the pinned file"
              : d.check.verdict === "mismatch"
              ? "differs from the pinned file"
              : "not comparable"}
          </Badge>
        </span>
      )}
    </span>
  );
}

/**
 * The replay record's fields and whether the step is _replayable_ — it committed a `replayHash` and
 * the kept record re-hashes to it, so a replay can be attempted. On a synthesizing step both records
 * are shown, session A's then session B's, with B's `workspaceBefore` held against A's
 * `workspaceAfter`. Never a verdict on the run: the page does not run the binary, and a verdict it
 * computed itself would be the operator vouching for the operator.
 */
function ReplayCard({ sandbox }: { sandbox: ZeroClawSandboxDetail }) {
  const step = sandbox.step;
  const replay = sandbox.replay.value;
  const ws = step?.workspace.value ?? null;
  // A member of an older step written without members' records committed: its record is kept
  // but no manifest names it, the server's sentence says so, and the badge is neither _replayable_
  // nor _not replayable_, because neither is known. A member that reached no sandbox has a note too,
  // but there is no record to be uncommitted — its badge is the Sandboxes card's _no sandbox_. Both are the
  // row's `null`; a member whose step committed its record is a yes or no like session A, and a
  // `false` may carry the server's sentence for why. The constants live beside `fs` and cannot be
  // imported into this page, so the row's value, not its words, decides the badge.
  const memberRow =
    sandbox.selected.kind === "member"
      ? sandbox.sandboxes.find((r) => r.kind === "member" && r.sandbox === sandbox.selected.sandbox) ?? null
      : null;
  const memberNote = memberRow?.replayable.note ?? null;
  const memberUnknown = !!memberRow && memberRow.replayable.value === null;
  // One record, or a synthesizing step's two in order.
  const records = replay ? replayRecords(replay) : [];
  const checks = replay ? replayChecks(replay, step?.replayHash.value ?? null) : [];
  return (
    <Card
      title={
        <>
          <span>Replay record</span>
          <SourceTag source="console" />
          {step &&
            (memberUnknown ? (
              <Badge tone="neutral">{memberRow!.sandboxed ? "not committed" : "no sandbox"}</Badge>
            ) : step.replayable ? (
              <Badge tone="good">replayable</Badge>
            ) : (
              <Badge tone="neutral">not replayable</Badge>
            ))}
        </>
      }
      description={
        <>
          What a replay of this step would hold the sandbox to — everything but the model. <em>Replayable</em> means the
          step committed a <code>replayHash</code> (for a member&apos;s sandbox, in that member&apos;s entry of the
          step&apos;s manifest), the record kept here re-hashes to it, and a replay can be attempted; this page never
          runs one and shows no verdict of its own. A step whose synthesis ran in the sandbox commits both of its
          sessions&apos; records, in order.
        </>
      }
    >
      <div className="space-y-4" data-testid="zeroclaw-replay">
        {memberNote && (
          <p className="text-xs text-ink-3" data-testid="zeroclaw-member-replay">
            {memberNote}
          </p>
        )}
        <KV
          items={[
            {
              label: "replayHash",
              value: step
                ? sourcedValue(step.replayHash, (h) => <Copyable value={h} display={truncate(h, 12, 8)} />)
                : "—",
            },
            {
              label: "workspace",
              value: ws ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="num text-xs text-ink-1">
                    {bytesLabel(ws.bytes)} of {bytesLabel(ws.capBytes)} · {ws.files} of {ws.capFiles} files
                  </span>
                  <SourceTag source="console" />
                </span>
              ) : (
                <span className="text-xs text-ink-3">— {step?.workspace.note ?? "no step yet"}</span>
              ),
            },
          ]}
        />
        {step?.replayNote && (
          <p className="text-xs text-ink-3" data-testid="zeroclaw-replay-note">
            {step.replayNote}
          </p>
        )}
        {/* The step's _changed since pinned_ note: one part of the message the record's
            `messageHash` commits, so it sits with the record and goes to whom the record does. */}
        {sandbox.sourcesNote && (
          <div className="space-y-1.5" data-testid="zeroclaw-sources-note">
            <p className="text-xs text-ink-3">
              Part of the message this step&apos;s <code>messageHash</code> commits: what the host re-read of each
              Solana source before the step, against the slot it was pinned at.
            </p>
            <SourcesNoteLine note={sandbox.sourcesNote} />
            <details className="text-2xs">
              <summary className="cursor-pointer text-ink-3">the note as the model read it</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-ink-2">{sandbox.sourcesNote}</pre>
            </details>
          </div>
        )}
        {replay ? (
          <div className="space-y-4">
            {checks.length > 0 && (
              <div className="space-y-1.5" data-testid="zeroclaw-replay-checks">
                {checks.map((c) => (
                  <div key={c.label} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <Badge tone={c.verdict === "match" ? "good" : c.verdict === "mismatch" ? "bad" : "neutral"}>
                      {c.verdict}
                    </Badge>
                    <span className="text-ink-2">{c.label}</span>
                    <span className="num min-w-0 break-all text-2xs text-ink-3">{c.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {records.map((r, i) => (
              <div key={i} className="space-y-1.5" data-testid="zeroclaw-replay-record">
                {records.length > 1 && (
                  <p className="text-xs font-medium text-ink-2">
                    {i === 0 ? "session A · the step's plan" : "session B · the synthesis"}
                  </p>
                )}
                <ReplayFields record={r} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-3">{sandbox.replay.note}</p>
        )}
        {sandbox.postureHash.value && records.some((r) => r.postureHash !== sandbox.postureHash.value) && (
          <Note tone="warn">The replay record names a different posture from the one the sandbox recorded.</Note>
        )}
      </div>
    </Card>
  );
}

/**
 * The page's own checks of the kept record(s), beside the server's _replayable_: the record
 * re-hashes to the step's `replayHash` — `sha256(canonicalJson(record))`, or of `[A, B]` on a
 * synthesizing step — and, with two, session B started where session A left the workspace.
 * Both are over the console's copy and the hash the console recorded, so they are `console` facts:
 * what ties the hash to the chain is the step's manifest, which `lath-audit` reads.
 */
function replayChecks(replay: ZeroClawReplay, replayHash: string | null): PostureCheck[] {
  const records = replayRecords(replay);
  const checks: PostureCheck[] = [];
  const whole = records.every((r) => r.v !== undefined && r.now !== undefined);
  const again = whole ? sha256Hex(canonicalJson(Array.isArray(replay) ? records : records[0])) : null;
  checks.push({
    label: records.length > 1 ? "the two records re-hash to replayHash" : "the record re-hashes to replayHash",
    verdict: !replayHash || !again ? "unavailable" : again === replayHash ? "match" : "mismatch",
    detail: !replayHash
      ? "the step committed no replayHash"
      : !again
      ? "the record was kept without v or now, as older records were"
      : again,
  });
  if (records.length === 2) {
    const [a, b] = records;
    checks.push({
      label: "session B starts where session A left the workspace",
      verdict: b.workspaceBefore === a.workspaceAfter ? "match" : "mismatch",
      detail: `B's workspace before ${b.workspaceBefore.slice(0, 12)}…, A's after ${a.workspaceAfter.slice(0, 12)}…`,
    });
  }
  return checks;
}

/** One replay record's fields, as recorded. */
function ReplayFields({ record }: { record: ZeroClawReplayRecord }) {
  return (
    <KV
      items={[
        { label: "binary sha256", value: <Hash h={record.binarySha256} /> },
        { label: "posture hash", value: <Hash h={record.postureHash} /> },
        { label: "message hash", value: <Hash h={record.messageHash} /> },
        { label: "workspace path", value: <code className="text-xs">{record.workspacePath}</code> },
        { label: "TZ · locale", value: <code className="text-xs">{`${record.tz} · ${record.locale}`}</code> },
        // The instant the sandbox was told (`ZEROCLAW_NOW`), and the record's version: both in the bytes
        // `replayHash` is over, and both missing from older rows written without them.
        ...(record.now ? [{ label: "now", value: <code className="text-xs">{record.now}</code> }] : []),
        { label: "workspace before", value: <Hash h={record.workspaceBefore} /> },
        { label: "workspace after", value: <Hash h={record.workspaceAfter} /> },
        {
          label: "seqs",
          value: <span className="num text-xs text-ink-2">{record.seqs.join(", ") || "—"}</span>,
        },
        // The model's context window the sandbox's config carried: part of what a replay
        // holds the sandbox to, and absent on every record written before it was kept.
        ...(typeof record.contextWindow === "number"
          ? [
              {
                label: "context window",
                value: (
                  <span className="num text-xs text-ink-2" data-testid="zeroclaw-replay-window">
                    {record.contextWindow.toLocaleString("en-US")} tokens
                  </span>
                ),
              },
            ]
          : []),
        ...(record.v !== undefined
          ? [{ label: "version", value: <span className="num text-xs text-ink-2">{record.v}</span> }]
          : []),
      ]}
    />
  );
}

function Hash({ h }: { h: string }) {
  return <Copyable value={h} display={truncate(h, 12, 8)} />;
}

/**
 * A loop's pinned sources on their own, for its answer page: what the answer was read from, each pin
 * resolved and checked as the sandbox page checks it. Nothing for a loop whose sandbox pinned none.
 */
export function LoopSourcesCard({ id }: { id: string }) {
  const query = useZeroClawSandbox(id);
  const sandbox = query.data?.sandbox;
  if (!sandbox?.sources) return null;
  return <PinnedSources sandbox={sandbox} />;
}

function PinnedSources({ sandbox }: { sandbox: ZeroClawSandboxDetail }) {
  const sources = useSandboxSources(sandbox);
  return <SourcesCard sandbox={sandbox} src={sources} />;
}
