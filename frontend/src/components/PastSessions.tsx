"use client";

import { useMemo } from "react";
import { EventKind, EventRecord, hex } from "@lath/sdk/browser";
import { Badge, Copyable, Empty, Facts, Info } from "@/components/ui";
import { formatTimestampMs, truncate } from "@/lib/format";
import { renderTrace, ResolvedTrace, TraceReaders, useTrace, useTracePart, useTraceStore } from "@/lib/traces";

/**
 * The sessions this chain already answered, read back out of the traces.
 *
 * A transcript kept in React state alone would empty on a reload, and a page whose Events list read
 * *events to #29* would tell the reader "Nothing asked yet" one card above. Everything needed to say
 * otherwise is on the chain — a session's
 * question is the input payload its Genesis commits to, and its answer is the final output its
 * Resolution commits to — so this rebuilds the conversation from the records rather than from
 * anything the server remembered about them.
 *
 * What a row shows is what its bytes *prove*: `useTracePart` re-hashes every preimage against the
 * hash the chain committed before it reaches here (`lib/traces.ts`). A session written encrypted is
 * left out.
 */
export function PastSessions({
  agentId,
  records,
  held,
}: {
  agentId: string;
  records: EventRecord[];
  /**
   * Genesis seqs (decimal) of sessions the caller draws itself, live, from its own stream. Grouped
   * first and skipped after, so a held session's Resolution is still paired with its own Genesis
   * rather than closing the session before it.
   */
  held?: ReadonlySet<string>;
}) {
  const store = useTraceStore(agentId);
  const sessions = useMemo(
    () => groupSessions(records).filter((s) => !held?.has(s.genesis.seq.toString())),
    [records, held]
  );
  if (sessions.length === 0) return null;

  return (
    <div className="space-y-5" data-testid="past-sessions">
      {sessions.map((s) => (
        <PastExchange key={hex(s.genesis.payloadHash)} store={store} session={s} />
      ))}
    </div>
  );
}

/** A session as the chain describes one: the Genesis that opened it, the Resolution that closed it. */
interface Session {
  genesis: EventRecord;
  resolution: EventRecord | null;
}

/**
 * Records into sessions, oldest first. A Genesis opens one and the next Resolution closes it;
 * anything between them — Actions, Delegations — is the epoch's business and is on the Events
 * card, not here. A Genesis with no Resolution yet is a session that was interrupted or is still
 * running, and it is kept: a question this chain was asked is worth showing even when the answer
 * never landed.
 */
function groupSessions(records: EventRecord[]): Session[] {
  const out: Session[] = [];
  for (const r of [...records].sort((a, b) => Number(a.seq - b.seq))) {
    if (r.kind === EventKind.Genesis) out.push({ genesis: r, resolution: null });
    else if (r.kind === EventKind.Resolution && out.length > 0 && !out[out.length - 1].resolution) {
      out[out.length - 1].resolution = r;
    }
  }
  return out;
}

function PastExchange({ store, session }: { store: TraceReaders; session: Session }) {
  const { genesis, resolution } = session;
  // The genesis payload names the input payload; the resolution's names the final output. Both are
  // fetched through the session's own bundle, which `useTrace` opens once and both legs then share.
  const genesisTrace = useTrace(store, genesis, true, genesis.payloadHash);
  const resolutionTrace = useTrace(store, resolution, !!resolution, genesis.payloadHash);
  const askHash = genesisTrace.data?.parts?.[0]?.hash ?? null;
  const replyHash = resolutionTrace.data?.parts?.[0]?.hash ?? null;
  const ask = useTracePart(store, askHash, !!askHash, genesis.payloadHash);
  const reply = useTracePart(store, replyHash, !!replyHash, genesis.payloadHash);
  // A session written encrypted: not drawn at all (privacy is a roadmap item).
  const sealed = [genesisTrace.data, resolutionTrace.data, ask.data, reply.data].some((t) => t?.status === "encrypted");
  if (sealed) return null;

  return (
    <div className="space-y-2" data-testid="past-exchange" data-seq={genesis.seq.toString()}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
        {/* A record's timestamp is already unix milliseconds (SPEC §4.2); multiplying it by 1000 would
            date every past session some 55,000 years out. */}
        {genesis.timestamp ? <span>{formatTimestampMs(genesis.timestamp)}</span> : null}
        {/* The seq and the payload hash are where the turn sits on the chain, which a reader looks
            up rather than reads: one tap away, with their source. */}
        <Info label={`Session at seq ${genesis.seq.toString()}`} testId="past-exchange-info">
          <Facts
            items={[
              { label: "genesis seq", value: <span className="num">{genesis.seq.toString()}</span>, source: "chain" },
              {
                label: "payload hash",
                value: <Copyable value={hex(genesis.payloadHash)} display={truncate(hex(genesis.payloadHash), 8, 6)} />,
                source: "chain",
              },
              ...(resolution
                ? [
                    {
                      label: "resolution seq",
                      value: <span className="num">{resolution.seq.toString()}</span>,
                      source: "chain" as const,
                    },
                  ]
                : []),
            ]}
          />
        </Info>
        {!resolution && <Badge tone="warn">no resolution on chain</Badge>}
      </div>

      {/* The record's own payload is what names the leaf, so when *it* cannot be opened the leaf's
          hash is unknown and its query never runs. The turn then reports what the record reported
          — not anchored, unavailable — rather than drawing an empty box, which is the
          one thing a reader cannot tell apart from "this session asked nothing". */}
      <Turn
        who="asked"
        trace={ask.data ?? (genesisTrace.data?.status !== "ok" ? genesisTrace.data : undefined)}
        pending={ask.isLoading || genesisTrace.isLoading || (!!askHash && !ask.data)}
      />
      {resolution ? (
        <Turn
          who="answered"
          trace={reply.data ?? (resolutionTrace.data?.status !== "ok" ? resolutionTrace.data : undefined)}
          pending={reply.isLoading || resolutionTrace.isLoading || (!!replyHash && !reply.data)}
        />
      ) : (
        <div className="text-xs text-ink-3">
          This session wrote no Resolution, so the chain holds no answer for it — what the model said, if it said
          anything, was never committed.
        </div>
      )}
    </div>
  );
}

/**
 * One side of a past exchange: the bytes themselves, or why this deployment cannot fetch them.
 */
function Turn({ who, trace, pending }: { who: "asked" | "answered"; trace?: ResolvedTrace; pending: boolean }) {
  const label = who === "asked" ? "asked" : "answered";
  const tone = who === "asked" ? "text-ink-2" : "text-ink-1";
  return (
    <div className="well p-3" data-testid={`past-${who}`}>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      {pending && <div className="text-xs text-ink-3">reading the trace…</div>}
      {!pending && trace?.status === "ok" && (
        <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${tone}`}>
          {renderTrace(trace.bytes!)}
        </div>
      )}
      {!pending && trace && trace.status !== "ok" && trace.status !== "encrypted" && (
        <div className="text-xs leading-relaxed text-ink-3">
          {trace.status === "not-anchored"
            ? "No locator on chain for this hash, and no gateway here serves it by name."
            : trace.status === "unconfigured"
            ? "No reader for this locator's scheme on this deployment."
            : "The chain names a locator, but the bytes came back wrong or from nowhere this deployment can read."}
        </div>
      )}
    </div>
  );
}

/** What the chat shows above its own messages when the chain has never been asked anything. */
export function NothingAsked() {
  return <Empty>Nothing asked yet. The reply to your first message will be that session&apos;s output.</Empty>;
}
