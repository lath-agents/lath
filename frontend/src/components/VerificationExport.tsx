"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EpochRecord, EventRecord, toBytes32 } from "@lath/sdk/browser";
import { Button } from "@/components/ui";
import { useLath } from "@/lib/clients";
import { config } from "@/lib/config";
import { epochOrdinal } from "@/lib/proofs";
import { useOwnerState, useStructures } from "@/lib/queries";
import { ReadTimeoutError, withDeadline } from "@/lib/capped-fetch";
import { epochStepsKey, fetchEpochSteps, useTraceStore } from "@/lib/traces";
import {
  bundleFilename,
  buildBundle,
  BundleInput,
  EpochSource,
  StructureSource,
  uncoveredSeqs,
} from "@/lib/verification-export";

/**
 * How long the export waits for one epoch, ms. The epoch's read is a registry lookup over RPC —
 * which may read manifest blobs — then the blob itself, and neither the RPC reads nor the query
 * cache take a signal, so nothing below bounds the whole. Four gateway deadlines (15 s each, the
 * SDK's `GATEWAY_READ_TIMEOUT_MS`) is room for a slow gateway that is up; past it the epoch is
 * written as unavailable and the export moves on.
 */
const EPOCH_WAIT_MS = 60_000;

/**
 * Downloads the verification bundle for this owner (`src/lib/verification-export.ts`).
 *
 * The epoch blobs are the slow part, so they are pulled through the same query cache the panels
 * use: an epoch already opened on screen costs nothing here, and one fetched here is on screen
 * instantly afterwards. Progress is on the button because a chain with many epochs is many
 * gateway round-trips and a button that just sits there looks broken.
 *
 * Epochs whose blob does not arrive are not an error and do not stop the export — they are
 * reported in the bundle as `unavailable`.
 *
 * The structure scan behind the Storage panel is read too, because cell and structure writes
 * consume the same operation counter as records and a bundle without them replays as a hole in
 * the middle of the chain. It is the same query key that panel uses, so on an agent page
 * it is already in cache and costs nothing; a scan that fails is reported in the bundle rather
 * than failing the export, the way an unavailable epoch is.
 */
export function VerificationExport({
  id,
  records,
  epochs,
}: {
  id: string;
  records: EventRecord[];
  epochs: EpochRecord[];
}) {
  const client = useLath();
  const store = useTraceStore(id);
  const queryClient = useQueryClient();
  const state = useOwnerState(id).data?.state;
  const structures = useStructures(id);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Seqs the exported file does not carry — empty means the reader should expect VERIFIED. */
  const [expected, setExpected] = useState<bigint[] | null>(null);
  /** Ordinals of the epochs that did not answer within `EPOCH_WAIT_MS`, said beside the verdict. */
  const [stalled, setStalled] = useState<number[]>([]);

  async function exportBundle() {
    if (!state) return;
    setError(null);
    setStalled([]);
    const ordered = [...epochs].sort((a, b) => (a.startSeq < b.startSeq ? -1 : a.startSeq > b.startSeq ? 1 : 0));
    setProgress({ done: 0, total: ordered.length });
    try {
      const sources: EpochSource[] = [];
      const late: number[] = [];
      for (let i = 0; i < ordered.length; i++) {
        setProgress({ done: i, total: ordered.length });
        const epoch = ordered[i];
        // A gateway or RPC that never answers must not hang the export: past `EPOCH_WAIT_MS` the
        // wait ends, and a failed or abandoned fetch is an epoch without steps, which the bundle
        // says out loud. The read itself carries on and fills the cache if it ever lands.
        const ordinal = epochOrdinal(epochs, epoch);
        const resolved = await withDeadline(
          queryClient.fetchQuery({
            queryKey: epochStepsKey(epoch),
            queryFn: () => fetchEpochSteps(store, epoch),
            staleTime: 5 * 60_000,
          }),
          EPOCH_WAIT_MS
        ).catch((e) => {
          if (e instanceof ReadTimeoutError) late.push(ordinal);
          return null;
        });
        sources.push({
          epoch,
          ordinal,
          steps: resolved?.status === "ok" ? resolved.steps ?? null : null,
        });
      }
      setProgress({ done: ordered.length, total: ordered.length });
      setStalled(late);

      // `null`, not `[]`, when the scan did not answer: the bundle says which of the two it was,
      // and a reader can tell an owner with no structures from a Photon read that failed.
      const scanned: StructureSource[] | null =
        structures.data ?? (await structures.refetch().catch(() => null))?.data ?? null;

      const input: BundleInput = {
        cluster: config.cluster,
        kind: "agent",
        id,
        programId: client.programId.toBase58(),
        addressTree: client.addressTree.toBase58(),
        header: { seq: state.seq, head: state.head, authority: state.authority.toBase58() },
        records,
        epochs: sources,
        structures: scanned,
      };
      let bundle = buildBundle(input);
      // A `set_append_policy` leaves no account to scan — the header is re-created at its own
      // address showing the new policy — so its seq is a gap, and a file without it would fold the
      // structure's creation over the wrong policy and replay FAILED. The rewrite is in the
      // owner's transaction history, which is a walk the export pays for only when the scans leave
      // a gap at all: that is `verifyChain`'s rule too, and a chain with no gaps has no rewrite.
      // History that cannot be read leaves the bundle as it was, with the gap stated.
      if (scanned && uncoveredSeqs(bundle).length > 0) {
        const history = await client.readHistory(toBytes32(id)).catch(() => null);
        if (history && history.policies.length > 0) bundle = buildBundle({ ...input, policies: history.policies });
      }
      download(bundleFilename(id), JSON.stringify(bundle, null, 2));
      // Say which verdict the checker will give before anyone runs it. A chain whose compact
      // events or closed cells cannot be carried replays as verified-with-gaps, and a reader who
      // was told to expect VERIFIED would read that as a failure.
      setExpected(uncoveredSeqs(bundle));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  }

  const busy = progress !== null;
  return (
    <span className="inline-flex items-center gap-2">
      {error && (
        <span className="text-2xs text-rose-300" data-testid="export-error">
          {error}
        </span>
      )}
      {stalled.length > 0 && (
        <span className="text-2xs text-ink-3" data-testid="export-stalled">
          {stalled.length === 1
            ? `epoch ${stalled[0]} did not answer within ${EPOCH_WAIT_MS / 1000} s; the file marks it unavailable`
            : `epochs ${stalled.join(", ")} did not answer within ${
                EPOCH_WAIT_MS / 1000
              } s; the file marks them unavailable`}
        </span>
      )}
      {expected && (
        <span
          className="text-2xs text-ink-3"
          data-testid="export-verdict"
          title={
            expected.length === 0
              ? "Every operation this chain performed is in the file, so the replay derives the head from zero."
              : "Compact events and cells that were closed or replaced away leave no account to read, so " +
                "the file cannot carry them. The checker names those seqs and verifies everything else; " +
                "`npm run audit` against an RPC is what covers them, because it can read transaction history."
          }
        >
          {expected.length === 0
            ? "verify:bundle → VERIFIED"
            : `verify:bundle → VERIFIED WITH GAPS · ${expected.length} operation${
                expected.length === 1 ? "" : "s"
              } not in the file (seq ${seqList(expected)})`}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        testId="export-verification"
        loading={busy}
        disabled={!state || busy}
        title={
          "Download the records, cell and policy writes, epoch roots and inclusion proofs this page verified, as JSON. " +
          "Replay it with `npm run verify:bundle -- <file>`: VERIFIED if the file carries every operation, " +
          "VERIFIED WITH GAPS if some seqs are compact events or closed cells, which leave no account to read."
        }
        onClick={() => void exportBundle()}
      >
        {busy && progress!.total > 0 && progress!.done < progress!.total
          ? `fetching epoch ${progress!.done + 1} of ${progress!.total}…`
          : busy
          ? "building…"
          : "Export verification"}
      </Button>
    </span>
  );
}

/**
 * Consecutive seqs as ranges — `0–5, 12, 14` — and never more than four groups, because the point
 * on screen is which writes are missing, not a list a thousand long. The exported file's own
 * README, and the checker, carry the full set.
 */
function seqList(seqs: bigint[], groups = 4): string {
  const ranges: [bigint, bigint][] = [];
  for (const seq of seqs) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1n === seq) last[1] = seq;
    else ranges.push([seq, seq]);
  }
  const shown = ranges.slice(0, groups).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  return shown.join(", ") + (ranges.length > groups ? ", …" : "");
}

/** A Blob url and a synthetic click: no server round-trip, and the JSON never leaves the page. */
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
