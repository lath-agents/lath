"use client";

import { useMemo, useState } from "react";
import { computeHead, EventRecord, GENESIS_HEAD, hex, toBytes32 } from "@lath/sdk/browser";
import { Badge, Card, Copyable, Info, Note } from "@/components/ui";
import { formatTimestampMs, truncate } from "@/lib/format";
import { KIND_LABEL } from "@/lib/eventmeta";

/**
 * One chain step, replayed here.
 *
 * For the selected record the preimage is laid out field by field, hashed in this browser with
 * the SDK's `computeHead` (the same bytes the program hashes), and compared with the head the
 * chain stored. When the previous row is the record just before it the input head is that
 * record's, and the replay is a real check. When operations sit between the two — an epoch, a
 * compact event, a cell write — the chain's own head for that gap is not in this list, so the
 * step is shown but cannot be replayed from records alone; the header's chain check folds those.
 */
export function HashChainInspector({
  records,
  agentId,
  nested = false,
}: {
  records: EventRecord[];
  agentId: string;
  /** Rendered as a section of the Events card rather than a card of its own. */
  nested?: boolean;
}) {
  // `null` until the reader picks one: the explainer then opens on the first record it can replay.
  const [picked, setIndex] = useState<number | null>(null);

  const sorted = useMemo(() => [...records].sort((a, b) => Number(a.seq - b.seq)), [records]);
  const idBytes = useMemo(() => toBytes32(agentId), [agentId]);

  // The first record whose input head this list holds: seq 0, or one right after a listed record.
  // Opening on any other (#8, after epoch steps, say) would show _Not recomputed_ first, on the one
  // thing this card exists to do.
  const firstReplayable = useMemo(() => {
    const i = sorted.findIndex((r, k) => (r.seq === 0n ? k === 0 : k > 0 && sorted[k - 1].seq + 1n === r.seq));
    return i < 0 ? 0 : i;
  }, [sorted]);
  const index = picked ?? firstReplayable;

  const current = sorted[index] ?? sorted[0];
  const previous = index > 0 ? sorted[index - 1] : null;

  const replay = useMemo(() => {
    if (!current) return null;
    // The input head is knowable from this list only at the chain's start or right after a
    // listed record; anywhere else, unlisted operations sit in between.
    const contiguous = current.seq === 0n ? previous === null : previous !== null && previous.seq + 1n === current.seq;
    const prevHead = current.seq === 0n ? GENESIS_HEAD : previous ? previous.head : null;
    if (!contiguous || !prevHead) {
      const gap = previous ? Number(current.seq - previous.seq - 1n) : Number(current.seq);
      return { contiguous: false as const, prevHead: null, computed: null, matches: null, gap };
    }
    const computed = computeHead(prevHead, idBytes, current.seq, current);
    const matches = hex(computed) === hex(current.head);
    return { contiguous: true as const, prevHead, computed, matches, gap: 0 };
  }, [current, previous, idBytes]);

  if (records.length === 0 || !current || !replay) return null;

  const prevHex = replay.prevHead ? hex(replay.prevHead) : null;

  return (
    <Card
      nested={nested}
      title={
        <>
          <span>Hash chain, one step at a time</span>
          {replay.contiguous ? (
            <Badge tone={replay.matches ? "good" : "bad"} dot>
              {replay.matches ? "replayed in this browser" : "replay does not match"}
            </Badge>
          ) : (
            <Badge tone="neutral">input head not in this list</Badge>
          )}
          <Info label="About the hash chain">
            <p className="text-2xs leading-relaxed text-ink-3">
              The preimage of the selected record&apos;s head, hashed here with the SDK and compared with what the chain
              stored.
            </p>
          </Info>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Record to inspect">
            {sorted.map((r, i) => (
              <button
                key={r.seq.toString()}
                type="button"
                onClick={() => setIndex(i)}
                aria-pressed={index === i}
                className="chip"
              >
                #{r.seq.toString()}
              </button>
            ))}
          </div>
          <span className="num text-xs text-ink-3">
            record {index + 1} of {sorted.length}
          </span>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="well p-4">
            <div className="eyebrow">Preimage</div>
            <div className="mt-2 rounded-md border border-line/[0.06] bg-canvas px-3 py-2 font-mono text-2xs leading-relaxed text-ink-2">
              head<sub>n</sub> = sha256( head<sub>n−1</sub> ‖ agent_id ‖ seq ‖ ts ‖ kind ‖ status ‖ reference ‖
              payload_hash )
            </div>

            <dl className="mt-3 divide-y divide-line/[0.06] text-xs">
              <Row
                label={
                  <>
                    head<sub>n−1</sub>
                  </>
                }
              >
                {prevHex ? (
                  <Copyable value={prevHex} display={truncate(prevHex, 10, 6)} />
                ) : (
                  <span className="text-ink-3">
                    folded through {replay.gap} unlisted operation{replay.gap === 1 ? "" : "s"}
                  </span>
                )}
              </Row>
              <Row label="agent_id">
                <Copyable value={agentId} display={truncate(agentId, 10, 6)} />
              </Row>
              <Row label="seq · u64 le">
                <span className="num text-ink-1">{current.seq.toString()}</span>
              </Row>
              <Row label="timestamp · i64 le">
                <span className="num text-ink-1">{current.timestamp.toString()}</span>
                <span className="ml-2 text-ink-3">{formatTimestampMs(current.timestamp)}</span>
              </Row>
              <Row label="kind · u8">
                <span className="num text-ink-1">{current.kind}</span>
                <span className="ml-2 text-ink-3">{KIND_LABEL[current.kind]}</span>
              </Row>
              <Row label="status · u16 le">
                <span className="num text-ink-1">{current.status}</span>
              </Row>
              <Row label="reference · 32 bytes">
                <Copyable value={hex(current.reference)} display={truncate(hex(current.reference), 10, 6)} />
              </Row>
              <Row label="payload_hash · 32 bytes">
                <Copyable value={hex(current.payloadHash)} display={truncate(hex(current.payloadHash), 10, 6)} />
              </Row>
            </dl>
          </div>

          <div className="flex flex-col gap-3">
            <div className="well p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="eyebrow">
                  head<sub>{current.seq.toString()}</sub> on chain
                </div>
              </div>
              <div className="mt-2 break-all font-mono text-xs leading-relaxed text-ink-1">
                <Copyable value={hex(current.head)} display={hex(current.head)} />
              </div>
            </div>

            <div
              className={`well p-4 ${
                replay.contiguous
                  ? replay.matches
                    ? "border-spine-green/25 bg-spine-green/[0.05]"
                    : "border-rose-400/25 bg-rose-400/[0.05]"
                  : ""
              }`}
              data-testid="chain-replay"
              data-verified={replay.matches ?? undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="eyebrow">Recomputed here</div>
                {replay.contiguous && (
                  <Badge tone={replay.matches ? "good" : "bad"} dot>
                    {replay.matches ? "equal" : "different"}
                  </Badge>
                )}
              </div>
              {replay.computed ? (
                <div
                  className={`mt-2 break-all font-mono text-xs leading-relaxed ${
                    replay.matches ? "text-spine-green" : "text-rose-200"
                  }`}
                >
                  {/* Two even halves rather than one wrapped line: the 64 digits wrapped their last one
                    onto a line of its own at this card's width. */}
                  <span className="block">{hex(replay.computed).slice(0, 32)}</span>
                  <span className="block">{hex(replay.computed).slice(32)}</span>
                </div>
              ) : (
                <p className="mt-2 text-xs leading-relaxed text-ink-3">
                  Not recomputed: the head this record folds is the result of {replay.gap} operation
                  {replay.gap === 1 ? "" : "s"} not listed here as records (epoch steps, compact events or cell writes).
                  Epoch steps are replayed from their epochs and closed or replaced cells re-sync from their CellWritten
                  events; a compact event has neither, so the header&apos;s check resumes at the next record&apos;s head
                  and says <em>with gaps</em>.
                </p>
              )}
            </div>

            <Note>
              Each head binds the previous head and the record&apos;s canonical bytes, so a change to any record at seq
              N changes every head after it.
            </Note>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="whitespace-nowrap font-mono text-ink-3">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end text-right">{children}</dd>
    </div>
  );
}
