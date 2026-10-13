"use client";

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { EventKind, hex, idFromString, sha256, subHashes, toBytes32 } from "@lath/sdk/browser";
// Pure and browser-safe: the index's and the manifest's decoders, the same the server restores with.
import { decodeSourcesIrysIndex, decodeSourcesManifest } from "@lath/runtime/zeroclaw/sources";
import { SourceTag } from "@/components/ui";
import type { SandboxSourcesIrys } from "@/app/api/_lib/zeroclaw";
import { truncate } from "@/lib/format";
import { useEvents } from "@/lib/queries";
import { fetchCapped, ReadCapError } from "@/lib/capped-fetch";
import { tracePartQuery, useTraceStore } from "@/lib/traces";
import { TEMPO_ESCROW_ADDRESS, settlementCarriers, useChainSettlement, type TempoSettlementView } from "@/lib/tempo";
import { TempoLink } from "@/components/Tempo";
import {
  fileToolArgs,
  llmToolNames,
  paymentOf,
  readMatchesPinned,
  readTarget,
  stepCounts,
  sumPayments,
  type FileToolArgs,
  type ProofPayment,
  type ProofVerdict,
  type ReadTarget,
  type StepCounts,
} from "@/lib/zeroclaw-proof";
import type { LoopView } from "@/types/loop";
import {
  postureSourcesHash,
  sha256Hex,
  stepActions,
  useStepEpochs,
  type ChainAction,
  type StepEpochs,
  type SourcesManifest,
  type ZeroClawSandboxDetail,
} from "@/lib/zeroclaw";
import { replayRecords } from "@/types/zeroclaw";

/*
 * One step's proof, read off the chain and the blob store: the hooks the proof screen
 * (`app/zeroclaw/[id]/page.tsx`) is built on, kept here so every view of a step draws it from the
 * same reads rather than a second, looser copy of them. A page file may export only what Next
 * allows, so the shared half cannot live there.
 */

/** What `useSandboxSources` read: the Sources card draws it, and the step's reads are resolved against it. */
export type SandboxSources = ReturnType<typeof useSandboxSources>;

/**
 * The sandbox's sources as this page has them, read once for every card that needs them: the Sources
 * card, and the step's file reads, which link to a pinned file by the same manifest and index. The
 * hash is the posture's where it has one — only that key is tied to the Genesis (Verify re-hashes
 * those bytes); the record's own copy, used when the sandbox kept no posture bytes, is the console's
 * word. The manifest is fetched from Irys only when the console did not send one, because the
 * set is public there by design, and `useIrysSources` re-hashes it to the committed hash
 * before handing it back.
 */
export function useSandboxSources(sandbox: ZeroClawSandboxDetail) {
  const value = sandbox.sources?.value ?? null;
  const posture = sandbox.postureJson.value;
  const fromPosture = postureSourcesHash(posture);
  const committed = fromPosture ?? value?.hash ?? null;
  const consoleManifest = value?.manifest ?? null;
  // Optional-chained although the type says it is there: an older console sends no key.
  const irys = sandbox.irys?.value ?? null;
  const onIrys = useIrysSources(irys, committed, !consoleManifest);
  const manifest = consoleManifest ?? onIrys.data?.manifest ?? null;
  return {
    value,
    posture,
    fromPosture,
    committed,
    irys,
    onIrys,
    manifest,
    manifestFromIrys: !consoleManifest && !!manifest,
    fileIds: onIrys.data?.files ?? null,
  };
}

/** An object on Irys, beside the `chain` / `console` tags: the bytes are read from the gateway and re-hashed here. */
export function IrysTag() {
  return (
    <span
      data-testid="irys-tag"
      title="read from Irys through its public gateway, and re-hashed in this browser against the hash the posture commits"
      className="rounded bg-spine-green/10 px-1 font-mono text-[10px] leading-4 text-spine-green"
    >
      irys
    </span>
  );
}

/** What `useIrysSources` read: each file's Irys id by its hash, and the manifest when it was asked for. */
export interface IrysSourcesRead {
  files: Record<string, string>;
  manifest: SourcesManifest | null;
}

/** The index and a manifest are small beside the files; these cap what a hostile gateway can make the page hold. */
const IRYS_INDEX_MAX_BYTES = 1024 * 1024;
const IRYS_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

async function gatewayBytes(url: string, max: number): Promise<Uint8Array> {
  const got = await fetchCapped(url, { maxBytes: max }).catch((e) => {
    if (e instanceof ReadCapError)
      throw new Error(`the gateway sent over ${max} bytes, more than a sources object can be`);
    throw e;
  });
  if (!got.bytes) throw new Error(`the gateway answered ${got.status}`);
  return got.bytes;
}

/**
 * The loop's sources index on Irys, read in the browser, and the manifest from
 * there when `wantManifest`. Nothing is taken on the console's word: the index must name the hash
 * the posture commits, and a manifest fetched from Irys must re-hash to it byte for byte before it
 * is returned — the same two checks `restoreSources` makes on the server. Any failure is the
 * query's error, shown as such; the links then simply are not drawn.
 */
export function useIrysSources(irys: SandboxSourcesIrys | null, committed: string | null, wantManifest: boolean) {
  return useQuery<IrysSourcesRead>({
    queryKey: ["zeroclaw-sources-irys", irys?.gateway, irys?.index, committed, wantManifest],
    enabled: !!irys && !!committed,
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      const at = irys!.gateway;
      const index = decodeSourcesIrysIndex(await gatewayBytes(`${at}/${irys!.index}`, IRYS_INDEX_MAX_BYTES));
      if (!index) throw new Error(`${irys!.index} is not a sources index`);
      if (index.sourcesHash !== committed) {
        throw new Error(
          `the index is for sources ${index.sourcesHash.slice(0, 12)}…, not the ${committed!.slice(0, 12)}… committed`
        );
      }
      if (!wantManifest) return { files: index.files, manifest: null };
      const bytes = await gatewayBytes(`${at}/${index.manifest}`, IRYS_MANIFEST_MAX_BYTES);
      const got = hex(sha256(bytes));
      if (got !== committed)
        throw new Error(`the manifest on Irys re-hashes to ${got.slice(0, 12)}…, not the hash committed`);
      const manifest = decodeSourcesManifest(bytes);
      if (!manifest) throw new Error("the manifest on Irys re-hashes right but is not a sources manifest");
      return { files: index.files, manifest: manifest as SourcesManifest };
    },
  });
}

/** What one Action's blobs said, once this page could read them. */
export interface ActionProof {
  /**
   * `sealed`: they were written encrypted, and this console does not open them; `reading`: not
   * back yet; `open`: read and re-hashed; `unavailable`: the store did not give them back.
   */
  state: "sealed" | "reading" | "open" | "unavailable";
  args: FileToolArgs | null;
  target: ReadTarget | null;
  check: { verdict: ProofVerdict; detail: string } | null;
  payment: ProofPayment | null;
}

export type StepBounds = { seq: string | null; previousSeq: string | null; genesisSeq: string | null };

/** One step's records, read once for the header's summary, _This step, in order_ and the tool calls table. */
export interface StepProof {
  bounds: StepBounds;
  events: ReturnType<typeof useEvents>;
  epochs: StepEpochs;
  actions: ChainAction[] | null;
  /** By tool id, from the chain alone: what anyone can count. */
  counts: StepCounts | null;
  /** `llm.<model>` when the Action's tool id is that name's hash; `null` for every other Action. */
  llmName: (a: ChainAction) => string | null;
  detail: (a: ChainAction) => ActionProof | null;
  /** The step's blobs were written encrypted, and this console does not open them. */
  sealed: boolean;
  /** Reads whose path this page could open, and what those paths were. `null` until one opened. */
  reads: { opened: number; fromSources: number; matched: number; mismatched: number } | null;
  /** Paths the step wrote, once their args opened. */
  writes: string[] | null;
  /** The model calls' vouchers, summed, once any result opened. */
  tempo: { paid: number; total: bigint; channels: string[] } | null;
  /** The close that covers the step's calls: the chain's by the audit's rule, else the loop row's. */
  settlement: { view: TempoSettlementView; source: "chain" | "console" } | null;
  /** The loop channel as the console has it, for a page that has not read a close: open, or not on Tempo. */
  channelOpen: boolean;
  checkpoint: { seq: string | null; signature: string | null };
  workspace: { before: string; after: string } | null;
}

export const isFileTool = (a: ChainAction) => a.tool === "zc.file_read" || a.tool === "zc.file_write";

/**
 * The step's Actions and, where this page can open them, what their blobs say: the path each `zc.file_*` touched and, for a read of a pinned source, whether the text the
 * model was shown re-builds to the file's hash; each model call's voucher delta on Tempo; and the
 * close that settled the channel they rode, found by `settlementCovering`, the audit's rule.
 *
 * One payload is read first; when it comes back `encrypted` (an older step written encrypted), nothing
 * else is fetched, rather than asking the store sixty times for bytes this console does not open.
 * The counts need none of it: they are tool ids, which the chain carries in the clear.
 */
export function useStepProof(
  sandbox: ZeroClawSandboxDetail,
  sources: SandboxSources,
  loop: LoopView | null
): StepProof {
  const agentId = sandbox.selected.agentId;
  const bounds = useMemo(
    () => ({ seq: sandbox.step?.seq.value ?? null, previousSeq: sandbox.previousSeq, genesisSeq: sandbox.genesisSeq }),
    [sandbox.step?.seq.value, sandbox.previousSeq, sandbox.genesisSeq]
  );
  const events = useEvents(agentId, !!bounds.seq);
  const epochs = useStepEpochs(agentId, bounds);
  const actions = useMemo(
    () => stepActions(events.data, bounds, epochs.leaves),
    // The leaves are rebuilt each render; their count and first seq say when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events.data, bounds, epochs.leaves.length, epochs.leaves[0]?.seq]
  );

  // A model call's tool id is `sha256("llm.<model>")` and not in any table, so it is named by the
  // model the policy document commits — the document Verify ties to the Genesis.
  const llmNames = useMemo(
    () => new Map(llmToolNames(sandbox.policyDocument.value).map((n) => [hex(idFromString(n)), n])),
    [sandbox.policyDocument.value]
  );
  const llmName = (a: ChainAction) => (a.tool?.startsWith("llm.") ? a.tool : llmNames.get(a.toolHash) ?? null);
  const counts = useMemo(() => (actions ? stepCounts(actions, new Set(llmNames.keys())) : null), [actions, llmNames]);

  // The Genesis each seq's session opened with: its `payload_hash` names the bundle the session's
  // blobs are in. A synthesizing step has two sessions in its range, so it is looked up per seq.
  const genesisOf = useMemo(() => {
    const gens = (events.data ?? [])
      .filter((e) => e.kind === EventKind.Genesis)
      .sort((x, y) => (x.seq < y.seq ? -1 : x.seq > y.seq ? 1 : 0));
    const fallback = sandbox.genesisPayloadHash ? toBytes32(sandbox.genesisPayloadHash) : undefined;
    return (seq: bigint): Uint8Array | undefined => {
      let found: Uint8Array | undefined;
      for (const g of gens) {
        if (g.seq > seq) break;
        found = g.payloadHash;
      }
      return found ?? fallback;
    };
  }, [events.data, sandbox.genesisPayloadHash]);

  const wanted = (actions ?? []).filter((a) => isFileTool(a) || !!llmName(a));
  const store = useTraceStore(agentId);
  const first = wanted[0] ?? null;
  const probe = useQuery(
    tracePartQuery(store, first?.payloadHash ?? null, !!first, first ? genesisOf(first.seq) : undefined)
  );
  const readable = probe.data?.status === "ok";
  const preimages = useQueries({
    queries: wanted.map((a) => tracePartQuery(store, a.payloadHash, readable, genesisOf(a.seq))),
  });
  // An Action's preimage is `kind ‖ encoding`; its sub-hashes are the args blob and the result blob.
  const parts = wanted.map((_, i) => {
    const d = preimages[i]?.data;
    if (d?.status !== "ok" || !d.bytes) return null;
    const subs = subHashes(EventKind.Action, d.bytes.slice(1));
    return { args: subs[0] ? hex(subs[0]) : null, result: subs[1] ? hex(subs[1]) : null };
  });
  const argHash = (a: ChainAction, i: number) => (isFileTool(a) ? parts[i]?.args ?? null : null);
  const resultHash = (a: ChainAction, i: number) =>
    a.tool === "zc.file_read" || llmName(a) ? parts[i]?.result ?? null : null;
  const argBlobs = useQueries({
    queries: wanted.map((a, i) => tracePartQuery(store, argHash(a, i), !!argHash(a, i), genesisOf(a.seq))),
  });
  const resultBlobs = useQueries({
    queries: wanted.map((a, i) => tracePartQuery(store, resultHash(a, i), !!resultHash(a, i), genesisOf(a.seq))),
  });

  const replay = sandbox.replay.value;
  const records = replay ? replayRecords(replay) : [];
  const irysFiles = sources.irys && sources.fileIds ? { gateway: sources.irys.gateway, files: sources.fileIds } : null;
  const probeStatus = probe.data?.status;
  const details = new Map<string, ActionProof>();
  wanted.forEach((a, i) => {
    const none = { args: null, target: null, check: null, payment: null };
    const pre = preimages[i]?.data ?? (i === 0 ? probe.data : undefined);
    if (probeStatus === "encrypted") return details.set(a.seq.toString(), { state: "sealed", ...none });
    if (probeStatus && probeStatus !== "ok" && !pre) {
      return details.set(a.seq.toString(), { state: "unavailable", ...none });
    }
    if (!pre) return details.set(a.seq.toString(), { state: "reading", ...none });
    if (pre.status === "encrypted") return details.set(a.seq.toString(), { state: "sealed", ...none });
    if (pre.status !== "ok") return details.set(a.seq.toString(), { state: "unavailable", ...none });
    const blobs = [argHash(a, i) ? argBlobs[i] : null, resultHash(a, i) ? resultBlobs[i] : null].filter((q) => !!q);
    const argBytes = argBlobs[i]?.data?.status === "ok" ? argBlobs[i].data!.bytes : undefined;
    const resultBytes = resultBlobs[i]?.data?.status === "ok" ? resultBlobs[i].data!.bytes : undefined;
    const args = argHash(a, i) ? fileToolArgs(argBytes) : null;
    const target = args ? readTarget(args.path, sources.manifest, irysFiles, records[0]?.workspacePath) : null;
    const resultText = resultBytes ? new TextDecoder().decode(resultBytes) : null;
    const check =
      a.tool === "zc.file_read" && target?.kind === "source"
        ? readMatchesPinned(resultText, a.status, target.file.sha256, sha256Hex)
        : null;
    const payment = llmName(a) ? paymentOf(resultBytes) : null;
    const state = blobs.some((q) => !q!.data)
      ? "reading"
      : blobs.some((q) => q!.data!.status === "encrypted")
      ? "sealed"
      : blobs.some((q) => q!.data!.status !== "ok")
      ? "unavailable"
      : "open";
    details.set(a.seq.toString(), { state, args, target, check, payment });
  });

  const opened = [...details.entries()];
  const readsOpen = (actions ?? []).filter((a) => a.tool === "zc.file_read" && details.get(a.seq.toString())?.args);
  const reads = readsOpen.length
    ? {
        opened: readsOpen.length,
        fromSources: readsOpen.filter((a) => details.get(a.seq.toString())!.target?.kind === "source").length,
        matched: readsOpen.filter((a) => details.get(a.seq.toString())!.check?.verdict === "match").length,
        mismatched: readsOpen.filter((a) => details.get(a.seq.toString())!.check?.verdict === "mismatch").length,
      }
    : null;
  const writePaths = (actions ?? [])
    .filter((a) => a.tool === "zc.file_write")
    .map((a) => details.get(a.seq.toString())?.args?.path)
    .filter((p): p is string => !!p);
  const payments = (actions ?? []).filter((a) => llmName(a)).map((a) => details.get(a.seq.toString())?.payment ?? null);
  const summed = sumPayments(payments);
  const tempo = summed.paid > 0 ? summed : null;

  // The close, by the audit's rule, over the records after the step's last model call that can
  // carry one; on a locked page those blobs are sealed too, and the loop row's close stands in,
  // tagged as the console's, for the step's own session only — a member's calls are matched to a
  // close by channel, and a locked page does not know the channel.
  const carriers = useMemo(
    () => settlementCarriers(events.data ?? [], (seq) => genesisOf(BigInt(seq))),
    [events.data, genesisOf]
  );
  const lastCall = (actions ?? [])
    .filter((a) => llmName(a))
    .reduce<bigint | null>((m, a) => (m === null || a.seq > m ? a.seq : m), null);
  const channel = tempo?.channels[0] ?? null;
  const onChain = useChainSettlement(
    store,
    carriers,
    channel ? lastCall : null,
    channel,
    lastCall === null ? undefined : genesisOf(lastCall)
  );
  const rowTempo = loop?.tempo ?? null;
  const rowCovers =
    !!rowTempo &&
    (channel
      ? (rowTempo.channelId ?? "").toLowerCase() === channel
      : sandbox.selected.kind === "session" && (counts?.modelCalls ?? 0) > 0);
  const settlement = onChain?.txHash
    ? { view: onChain, source: "chain" as const }
    : rowCovers && rowTempo!.closed && rowTempo!.txHash
    ? {
        view: { txHash: rowTempo!.txHash, spent: rowTempo!.spent, channelId: rowTempo!.channelId, closed: true },
        source: "console" as const,
      }
    : null;

  const historyRow = loop?.history.find((h) => h.step === sandbox.step?.step) ?? null;
  return {
    bounds,
    events,
    epochs,
    actions,
    counts,
    llmName,
    detail: (a) => details.get(a.seq.toString()) ?? null,
    sealed: probeStatus === "encrypted" || opened.some(([, d]) => d.state === "sealed"),
    reads,
    writes: writePaths.length ? writePaths : null,
    tempo,
    settlement,
    channelOpen: !!rowTempo && !rowTempo.closed,
    checkpoint: {
      seq: historyRow?.seq ?? (sandbox.selected.kind === "session" ? bounds.seq : null),
      signature: historyRow?.signature ?? null,
    },
    workspace: records.length
      ? { before: records[0].workspaceBefore, after: records[records.length - 1].workspaceAfter }
      : null,
  };
}

/** `N model calls` and `N file reads`, the words each count needs. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The close transaction on Tempo, with whose word it is. */
export function SettledLink({ settlement }: { settlement: NonNullable<StepProof["settlement"]> }) {
  const tx = settlement.view.txHash!;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-ink-3">settled in</span>
      <TempoLink
        kind="tx"
        value={tx}
        testId="zeroclaw-proof-settlement"
        details={
          <p className="text-2xs leading-relaxed text-ink-3">
            The channel&apos;s close on Tempo: the final amount it settled covers these vouchers.
          </p>
        }
      />
      <SourceTag source={settlement.source} />
    </span>
  );
}

/**
 * Where an open channel is: Tempo's escrow contract, whose page carries the
 * channel's opened and closed events. The channel id is a bytes32 inside it and has no page of its
 * own, so the id is the link's `Info`, with what closing it does.
 */
export function ChannelEscrowLink({ channelId }: { channelId?: string | null }) {
  return (
    <TempoLink
      kind="address"
      value={TEMPO_ESCROW_ADDRESS}
      label="in escrow"
      testId="tempo-escrow-link"
      details={
        <>
          {channelId && <code className="block break-all font-mono text-2xs text-ink-2">channel {channelId}</code>}
          <p className="text-2xs leading-relaxed text-ink-3">
            The channel id is a bytes32 inside Tempo&apos;s escrow, not an address of its own; the escrow&apos;s opened
            and closed events carry it. Closing the channel pays OpenRouter and refunds the rest.
          </p>
        </>
      }
    />
  );
}
