"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EpochRecord, EventInput, EventKind, EventRecord, hex } from "@lath/sdk/browser";
import { Badge, BadgeTone, Copyable, Empty, ExplorerLink, Segmented } from "@/components/ui";
import { CopyLink } from "@/components/CopyLink";
import { VerificationExport } from "@/components/VerificationExport";
import { ChainVerify, ChainVerifyToggle, EpochVerify, TraceVerify } from "@/components/VerifyPanel";
import { SettlementCarriersContext, TempoTraceBlock } from "@/components/TracePanel";
import { settlementCarriers } from "@/lib/tempo";
import { formatTimestampMs, truncate } from "@/lib/format";
import { describeReference, describeStatus, KIND_LABEL, toolName } from "@/lib/eventmeta";
import { epochOrdinal, proveEpochStep, StepInclusionProof } from "@/lib/proofs";
import {
  renderTrace,
  ResolvedTrace,
  TraceReaders,
  useEpochSteps,
  useTrace,
  useTracePart,
  useTraceStore,
} from "@/lib/traces";

type Tab = EventKind | "all";

const TABS: Tab[] = ["all", EventKind.Genesis, EventKind.Action, EventKind.Delegation, EventKind.Resolution];

const KIND_TONES: Record<EventKind, BadgeTone> = {
  // The spine hues in chain order: a Genesis opens (blue), Actions happen (light blue), a
  // Delegation hands work on (green), and the Resolution is the answer (electric green).
  [EventKind.Genesis]: "blue",
  [EventKind.Action]: "cyan",
  [EventKind.Delegation]: "good",
  // `answer`, not `volt`: the hue without achieved's glow, which belongs to a goal reached.
  [EventKind.Resolution]: "answer",
};

/** A row is a record the chain holds, or an epoch that stands in for a run of seqs. */
type Row = { kind: "record"; seq: bigint; record: EventRecord } | { kind: "epoch"; seq: bigint; epoch: EpochRecord };

const toggle =
  "inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";
const toggleNeutral = `${toggle} border-line/[0.1] text-ink-2 hover:border-line/[0.2] hover:bg-line/[0.04] hover:text-ink-1`;
const toggleAccent = `${toggle} border-accent/30 bg-accent/[0.08] text-accent-strong hover:bg-accent/[0.14]`;

export function EventTimeline({
  records,
  epochs = [],
  id,
  unread = false,
  name,
}: {
  records: EventRecord[];
  epochs?: EpochRecord[];
  id: string;
  /** The agent's name, when the page knows it: the Tempo checks in _Verify offline_ take it. */
  name?: string;
  /** The scan that fills `records` rejected: an empty table means unread, not none. */
  unread?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const store = useTraceStore(id);
  // Three ways in from a URL, read after mount so the server render and the first client render
  // agree. `?seq=N` names a row: the record at seq N, or the epoch that covers it. `?at=N` names
  // a chain *state* — the head after N operations, which is what a checkpoint leaf carries as
  // `AgentState.seq` — so the row to show is the one that produced it: the last record or epoch
  // at or before N − 1. Cell writes advance the counter without a row, so "at or before".
  // `?prove=N` names the same row as `?seq=N` and additionally asks for the evidence: an epoch
  // opens and the step at N proves itself, a record opens its trace panel.
  const [focusReq, setFocusReq] = useState<{ mode: "seq" | "at" | "prove"; n: bigint } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const at = params.get("at");
    const seq = params.get("seq");
    const prove = params.get("prove");
    if (at && /^\d+$/.test(at)) setFocusReq({ mode: "at", n: BigInt(at) });
    else if (seq && /^\d+$/.test(seq)) setFocusReq({ mode: "seq", n: BigInt(seq) });
    else if (prove && /^\d+$/.test(prove)) setFocusReq({ mode: "prove", n: BigInt(prove) });
  }, []);
  const focus = useMemo<{ seq: bigint; label?: string } | null>(() => {
    if (!focusReq) return null;
    if (focusReq.mode !== "at") return { seq: focusReq.n };
    const last = focusReq.n - 1n;
    if (last < 0n) return null;
    let best: bigint | null = null;
    const take = (c: bigint) => {
      if (c <= last && (best === null || c > best)) best = c;
    };
    for (const r of records) take(r.seq);
    for (const e of epochs) if (e.startSeq <= last) take(e.endSeq - 1n < last ? e.endSeq - 1n : last);
    return best === null ? null : { seq: best, label: `checkpoint head at seq ${focusReq.n.toString()}` };
  }, [focusReq, records, epochs]);
  const focusSeq = focus?.seq ?? null;
  /** The seq `?prove=` named, if any: the one row that opens itself and computes its proof. */
  const proveSeq = focusReq?.mode === "prove" ? focusReq.n : null;

  /**
   * The genesis each record's session opened with: the last kind-0 record at or before it.
   *
   * That hash is what names the session's bundle (`sdk/src/bundle.ts`), and the timeline is
   * holding every record already, so no extra read is needed to find it. Records before the
   * first genesis on a chain — a checkpoint written outside a session, an offer — get nothing,
   * and their traces resolve without a session bundle.
   */
  const sessionGenesis = useMemo(() => {
    const bySeq = new Map<string, Uint8Array>();
    let current: Uint8Array | undefined;
    for (const record of [...records].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))) {
      if (record.kind === EventKind.Genesis) current = record.payloadHash;
      if (current) bySeq.set(record.seq.toString(), current);
    }
    return bySeq;
  }, [records]);

  /**
   * The records that can carry a Tempo settlement, handed to every payment block below so an
   * `llm.*` Action links its channel's close instead of reading PENDING for good. Picked by kind
   * and tool id, which the chain already holds; a block reads their blobs only once it is opened.
   */
  const settlements = useMemo(
    () => ({ store, carriers: settlementCarriers(records, (seq) => sessionGenesis.get(seq)) }),
    [store, records, sessionGenesis]
  );

  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [
      ...records.map((record) => ({ kind: "record" as const, seq: record.seq, record })),
      ...epochs.map((epoch) => ({ kind: "epoch" as const, seq: epoch.startSeq, epoch })),
    ];
    all.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    // An epoch holds Actions only, so it stays under the Action tab and disappears elsewhere.
    return tab === "all"
      ? all
      : all.filter((r) => (r.kind === "record" ? r.record.kind === tab : tab === EventKind.Action));
  }, [records, epochs, tab]);

  useEffect(() => {
    if (focusSeq === null) return;
    document.getElementById(`seq-${focusSeq}`)?.scrollIntoView({ block: "center" });
  }, [focusSeq, rows.length]);

  const [verifyOpen, setVerifyOpen] = useState(false);

  const countFor = (t: Tab) =>
    t === "all"
      ? records.length + epochs.length
      : records.filter((r) => r.kind === t).length + (t === EventKind.Action ? epochs.length : 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<string>
          value={String(tab)}
          onChange={(v) => setTab(v === "all" ? "all" : (Number(v) as EventKind))}
          label="Event kind"
          size="sm"
          options={TABS.map((t) => ({
            value: String(t),
            label: t === "all" ? "All" : KIND_LABEL[t],
            count: countFor(t),
          }))}
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="num text-xs text-ink-3" data-testid="timeline-count">
            {records.length} record{records.length === 1 ? "" : "s"}
            {epochs.length > 0 ? ` · ${epochs.length} epoch${epochs.length === 1 ? "" : "s"}` : ""}
          </span>
          <ChainVerifyToggle open={verifyOpen} onToggle={() => setVerifyOpen((o) => !o)} />
          <VerificationExport id={id} records={records} epochs={epochs} />
        </div>
      </div>
      {/* Its own full-width row under the toolbar, not inside it. */}
      {verifyOpen && <ChainVerify ownerId={id} agentName={name} />}

      {rows.length === 0 ? (
        // "No events of this kind" is a claim about the chain, and an errored scan has not made
        // one. Same distinction `/billing` draws for a charge history that could not be read.
        <Empty>
          {unread
            ? "The records on this chain could not be read from the indexer. This is not an empty chain; try again in a moment."
            : "No events of this kind."}
        </Empty>
      ) : (
        <SettlementCarriersContext.Provider value={settlements}>
          <div className="table-wrap">
            <table className="w-full min-w-[48rem] text-sm" data-testid="timeline">
              <thead className="border-b border-line/[0.08]">
                <tr>
                  <th className="th">Seq</th>
                  <th className="th">Kind</th>
                  <th className="th">Reference</th>
                  <th className="th">Status</th>
                  <th className="th">Timestamp</th>
                  <th className="th">Head</th>
                  <th className="th">Storage</th>
                  <th className="th text-right">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/[0.06]">
                {rows.map((row) =>
                  row.kind === "record" ? (
                    <RecordRow
                      key={`r${row.seq}`}
                      record={row.record}
                      store={store}
                      ownerId={id}
                      genesis={sessionGenesis.get(row.seq.toString())}
                      focused={focusSeq === row.seq}
                      focusLabel={focusSeq === row.seq ? focus?.label : undefined}
                      // `?prove=` on a record has no epoch proof to compute: the record *is* its
                      // own account, so the evidence to open is its trace.
                      autoOpen={proveSeq === row.seq}
                    />
                  ) : (
                    <EpochRow
                      key={`e${row.seq}`}
                      epoch={row.epoch}
                      ordinal={epochOrdinal(epochs, row.epoch)}
                      store={store}
                      ownerId={id}
                      proveSeq={
                        proveSeq !== null && proveSeq >= row.epoch.startSeq && proveSeq < row.epoch.endSeq
                          ? proveSeq
                          : null
                      }
                      focusSeq={
                        focusSeq !== null && focusSeq >= row.epoch.startSeq && focusSeq < row.epoch.endSeq
                          ? focusSeq
                          : null
                      }
                      focusLabel={
                        focusSeq !== null && focusSeq >= row.epoch.startSeq && focusSeq < row.epoch.endSeq
                          ? focus?.label
                          : undefined
                      }
                    />
                  )
                )}
              </tbody>
            </table>
          </div>
        </SettlementCarriersContext.Provider>
      )}
    </div>
  );
}

function FocusLabel({ label }: { label?: string }) {
  if (!label) return null;
  return (
    <div className="mt-1 font-sans text-[10px] font-normal text-accent-strong" data-testid="focus-label">
      {label}
    </div>
  );
}

function RecordRow({
  record,
  store,
  ownerId,
  genesis,
  focused = false,
  focusLabel,
  autoOpen = false,
}: {
  record: EventRecord;
  store: TraceReaders | null;
  /** The agent whose chain this row belongs to — what the Tempo verify line names. */
  ownerId: string;
  /** `payload_hash` of the genesis that opened this record's session — its bundle's key. */
  genesis?: Uint8Array;
  /** True for the row `?seq=` / `?at=` names: highlighted and scrolled to. */
  focused?: boolean;
  /** Why it is focused, when the URL named a chain state rather than this row. */
  focusLabel?: string;
  /** `?prove=` named this record: open the trace panel without a click. */
  autoOpen?: boolean;
}) {
  const reference = describeReference(record);
  const status = describeStatus(record);
  const [open, setOpen] = useState(false);
  const trace = useTrace(store, record, open, genesis);
  // Not an initial state: the URL is read after mount, so the flag arrives a render late.
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  return (
    <>
      <tr
        id={`seq-${record.seq.toString()}`}
        className={`row-hover ${focused ? "bg-accent/[0.07] shadow-[inset_2px_0_0_0_rgb(var(--accent))]" : ""}`}
        data-testid="timeline-record"
        data-kind={KIND_LABEL[record.kind]}
        // The tool id of a known Action, for whoever must tell a public lifecycle record (`agent.deploy`,
        // `loop.start`, …) from a session's encrypted ones without reading the label's wording.
        data-tool={record.kind === EventKind.Action ? toolName(record.reference) : undefined}
        data-focused={focused || undefined}
      >
        <td className="td num text-xs font-medium text-ink-1">
          <span className="inline-flex items-center gap-1">
            #{record.seq.toString()}
            <CopyLink param="seq" seq={record.seq} what={`record #${record.seq.toString()}`} />
          </span>
          <FocusLabel label={focusLabel} />
        </td>
        <td className="td">
          <Badge tone={KIND_TONES[record.kind]}>{KIND_LABEL[record.kind]}</Badge>
        </td>
        <td className="td">
          <div className="text-2xs text-ink-3">{reference.label}</div>
          {reference.isKey ? (
            <Link href={`/authority/${reference.value}`} className="link-mono">
              {truncate(reference.value, 6, 6)}
            </Link>
          ) : (
            <Copyable value={reference.value} display={truncate(reference.value, 10, 6)} />
          )}
        </td>
        <td className="td">
          {status.text === "—" ? (
            <span className="text-ink-3">—</span>
          ) : (
            <Badge tone={status.tone}>{status.text}</Badge>
          )}
        </td>
        <td className="td whitespace-nowrap text-xs text-ink-2">{formatTimestampMs(record.timestamp)}</td>
        <td className="td">
          <Copyable value={hex(record.head)} display={truncate(hex(record.head), 8, 4)} />
        </td>
        <td className="td" data-testid="storage-tier">
          <span className="text-xs text-ink-2" title="This event has its own compressed account on chain.">
            record
          </span>
        </td>
        <td className="td text-right">
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className={toggleNeutral}>
            {open ? "Hide" : "Open"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="pb-4 pt-1">
            <TracePanel
              record={record}
              store={store}
              ownerId={ownerId}
              genesis={genesis}
              trace={trace.data}
              loading={trace.isLoading}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function EpochRow({
  epoch,
  ordinal,
  store,
  ownerId,
  focusSeq = null,
  focusLabel,
  proveSeq = null,
}: {
  epoch: EpochRecord;
  /** Which epoch this is among the owner's, 1-based by `startSeq` — the *k* in *epoch #k*. */
  ordinal: number;
  store: TraceReaders | null;
  /** The agent this epoch belongs to — what the offline audit command takes as its argument. */
  ownerId: string;
  /** A seq inside this epoch that `?seq=` / `?at=` names: the row is highlighted and scrolled to. */
  focusSeq?: bigint | null;
  /** Why it is focused, when the URL named a chain state rather than this row. */
  focusLabel?: string;
  /** A seq inside this epoch that `?prove=` names: the panel opens and that step proves itself. */
  proveSeq?: bigint | null;
}) {
  const [open, setOpen] = useState(false);
  const steps = useEpochSteps(store, epoch, open);
  const count = Number(epoch.endSeq - epoch.startSeq);
  const last = epoch.endSeq - 1n;
  // Not an initial state: the URL is read after mount, so the flag arrives a render late.
  useEffect(() => {
    if (proveSeq !== null) setOpen(true);
  }, [proveSeq]);

  return (
    <>
      <tr
        id={focusSeq !== null ? `seq-${focusSeq.toString()}` : undefined}
        className={`bg-accent/[0.04] transition-colors hover:bg-accent/[0.07] ${
          focusSeq !== null ? "shadow-[inset_2px_0_0_0_rgb(var(--accent))]" : ""
        }`}
        data-testid="timeline-epoch"
        data-focused={focusSeq !== null || undefined}
      >
        <td className="td num text-xs font-medium text-accent">
          <span className="inline-flex items-center gap-1">
            #{epoch.startSeq.toString()}–{last.toString()}
            <CopyLink param="seq" seq={epoch.startSeq} what={`epoch #${ordinal}`} />
          </span>
          <FocusLabel label={focusLabel} />
        </td>
        <td className="td">
          <Badge tone="compressed">Epoch · {count} steps</Badge>
        </td>
        <td className="td">
          <div className="text-2xs text-ink-3">root</div>
          <Copyable value={hex(epoch.epochRoot)} display={truncate(hex(epoch.epochRoot), 10, 6)} />
        </td>
        <td className="td">
          <ExplorerLink kind="tx" value={epoch.signature}>
            tx
          </ExplorerLink>
        </td>
        <td className="td whitespace-nowrap text-xs text-ink-2">
          {epoch.blockTime ? formatTimestampMs(epoch.blockTime * 1000) : "—"}
        </td>
        <td className="td">
          <Copyable value={hex(epoch.head)} display={truncate(hex(epoch.head), 8, 4)} />
        </td>
        <td className="td" data-testid="storage-tier">
          <span
            className="text-xs text-accent/90"
            title={`${count} steps under one Merkle root and one chain write; no per-step account exists.`}
          >
            epoch #{ordinal}
          </span>
        </td>
        <td className="td text-right">
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className={toggleAccent}>
            {open ? "Hide steps" : "Open steps"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="pb-4 pt-1">
            <EpochPanel
              epoch={epoch}
              ordinal={ordinal}
              store={store}
              ownerId={ownerId}
              loading={steps.isLoading}
              resolved={steps.data}
              proveSeq={proveSeq}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function EpochPanel({
  epoch,
  ordinal,
  store,
  ownerId,
  loading,
  resolved,
  proveSeq = null,
}: {
  epoch: EpochRecord;
  ordinal: number;
  store: TraceReaders | null;
  ownerId: string;
  loading: boolean;
  resolved?: ReturnType<typeof useEpochSteps>["data"];
  /** The step `?prove=` named, which proves itself as soon as the blob resolves. */
  proveSeq?: bigint | null;
}) {
  if (loading)
    return <div className="px-3 py-2 text-xs text-ink-2">Fetching the epoch blob and rebuilding its root…</div>;
  if (!resolved) return null;
  if (resolved.status !== "ok") {
    const why: Record<string, string> = {
      unconfigured: "No reader for this locator's scheme on this deployment.",
      "not-anchored":
        "The chain holds no locator for this root yet: no direct cell and no manifest names it. A store that batches locators publishes one manifest cell per K epochs, so a recent epoch may be waiting for its manifest.",
      unavailable:
        "The chain names a locator, but no gateway here served it — either the scheme has none configured (set NEXT_PUBLIC_TRACE_GATEWAY for a raw store) or the one it has did not answer.",
      mismatch: "The gateway served bytes whose Merkle root is not the one the chain folded. They are not this epoch.",
    };
    return (
      <div className="well space-y-3 p-4 text-xs leading-relaxed text-ink-2">
        <div>{why[resolved.status]}</div>
        {resolved.url && <EpochVerify epoch={epoch} resolved={resolved} ownerId={ownerId} />}
      </div>
    );
  }
  return (
    <div className="well space-y-3 border-accent/20 p-4" data-testid="epoch-steps">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/[0.08] pb-2 text-xs">
        <Badge tone="good" dot>
          Root rebuilt in this browser matches the chain
        </Badge>
        <span className="num text-ink-3">
          {resolved.steps!.length} steps · seq {epoch.startSeq.toString()}–{(epoch.endSeq - 1n).toString()}
        </span>
      </div>
      <div className="table-wrap">
        <table className="w-full min-w-[44rem] text-xs">
          <thead>
            <tr>
              <th className="th pb-1.5">Seq</th>
              <th className="th pb-1.5">Kind</th>
              <th className="th pb-1.5">Reference</th>
              <th className="th pb-1.5">Status</th>
              <th className="th pb-1.5">Timestamp</th>
              <th className="th pb-1.5">Payload hash</th>
              <th className="th pb-1.5">Storage</th>
              <th className="th pb-1.5">Inclusion proof</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/[0.06]">
            {resolved.steps!.map(({ seq, input }, index) => (
              <EpochStepRow
                key={seq.toString()}
                seq={seq}
                index={index}
                input={input}
                inputs={resolved.steps!.map((s) => s.input)}
                startSeq={epoch.startSeq}
                chainRoot={epoch.epochRoot}
                ordinal={ordinal}
                store={store}
                ownerId={ownerId}
                autoProve={proveSeq === seq}
              />
            ))}
          </tbody>
        </table>
      </div>
      <EpochVerify epoch={epoch} resolved={resolved} ownerId={ownerId} />
    </div>
  );
}

function EpochStepRow({
  seq,
  index,
  input,
  inputs,
  startSeq,
  chainRoot,
  ordinal,
  store,
  ownerId,
  autoProve = false,
}: {
  seq: bigint;
  /** This step's position in the epoch, which is what the Merkle proof indexes. */
  index: number;
  input: EventInput;
  /** Every step of the epoch, in order: the leaves the proof is built over. */
  inputs: EventInput[];
  startSeq: bigint;
  /** `EpochCommitted.epoch_root` — the root the chain folded, not one rebuilt from the blob. */
  chainRoot: Uint8Array;
  ordinal: number;
  store: TraceReaders | null;
  /** The agent whose chain this epoch belongs to — the steps inside it are its Actions. */
  ownerId: string;
  /** `?prove=` named this step: compute the proof on mount and bring the row into view. */
  autoProve?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [proof, setProof] = useState<StepInclusionProof | null>(null);
  const row = useRef<HTMLTableRowElement>(null);
  const asRecord: EventRecord = {
    agentId: new Uint8Array(32),
    seq,
    timestamp: input.timestamp,
    kind: input.kind,
    status: input.status,
    reference: input.reference,
    payloadHash: input.payloadHash,
    head: new Uint8Array(32),
  };
  const reference = describeReference(asRecord);
  const status = describeStatus(asRecord);
  const trace = useTrace(store, asRecord, open);
  // The same computation the Prove button runs — it is synchronous and local, so a shared link
  // lands on a verified row rather than on a button someone still has to press.
  useEffect(() => {
    // `proof` guards as well as depends: `inputs` is rebuilt on every render of the panel, so
    // without it this would re-prove — and re-render — forever.
    if (!autoProve || proof) return;
    setProof(proveEpochStep(startSeq, inputs, index, chainRoot));
    row.current?.scrollIntoView({ block: "center" });
  }, [autoProve, proof, startSeq, inputs, index, chainRoot]);
  return (
    <Fragment>
      <tr ref={row} data-testid="epoch-step" data-proved={autoProve || undefined} className="row-hover">
        <td className="num py-2 pr-4 text-accent">
          <span className="inline-flex items-center gap-1">
            #{seq.toString()}
            <CopyLink param="prove" seq={seq} what={`step #${seq.toString()}`} />
          </span>
        </td>
        <td className="py-2 pr-4">
          <Badge tone={KIND_TONES[input.kind]}>{KIND_LABEL[input.kind]}</Badge>
        </td>
        <td className="py-2 pr-4 font-mono text-ink-2">{truncate(reference.value, 10, 6)}</td>
        <td className="py-2 pr-4">{status.text === "—" ? "—" : <Badge tone={status.tone}>{status.text}</Badge>}</td>
        <td className="whitespace-nowrap py-2 pr-4 text-ink-2">{formatTimestampMs(input.timestamp)}</td>
        <td className="py-2 pr-4">
          <button onClick={() => setOpen((v) => !v)} className="link-mono">
            {truncate(hex(input.payloadHash), 8, 6)}
          </button>
        </td>
        <td className="py-2 pr-4" data-testid="storage-tier">
          <span
            className="text-accent/90"
            title="No account of its own: this step is a leaf of the epoch's Merkle root."
          >
            {`epoch #${ordinal}${proof?.verified ? " · proof verified" : ""}`}
          </span>
        </td>
        <td className="py-2">
          {proof === null ? (
            <button
              data-testid="epoch-step-prove"
              onClick={() => setProof(proveEpochStep(startSeq, inputs, index, chainRoot))}
              className={`${toggleAccent} h-6 text-2xs`}
            >
              Prove
            </button>
          ) : (
            <div className="space-y-1">
              <span data-testid="proof-badge">
                <Badge tone={proof.verified ? "good" : "bad"} dot>
                  {proof.verified
                    ? `proof verified · ${proof.path.length}-node path`
                    : "proof does not match the chain's root"}
                </Badge>
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
                <span>leaf</span>
                <Copyable value={proof.leaf} display={truncate(proof.leaf, 8, 6)} />
                <span title="Sibling hashes re-hashed with the leaf, bottom-up, to reach the root.">
                  · {proof.path.length} sibling{proof.path.length === 1 ? "" : "s"} to the root
                </span>
              </div>
            </div>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="pb-3">
            <TracePanel
              record={asRecord}
              store={store}
              ownerId={ownerId}
              trace={trace.data}
              loading={trace.isLoading}
              origin={`as a step of epoch #${ordinal} — the hash is a leaf of the root the chain folded`}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function TracePanel({
  record,
  store,
  ownerId,
  genesis,
  trace,
  loading,
  origin,
}: {
  record: EventRecord;
  store: TraceReaders | null;
  /** The agent whose chain this record belongs to; absent for a row read outside one. */
  ownerId?: string;
  /** The session whose bundle the sub-hashes below are in, when the record belongs to one. */
  genesis?: Uint8Array;
  trace?: ResolvedTrace;
  loading: boolean;
  /** Passed through to the verify block for a hash with no account of its own (an epoch step). */
  origin?: string;
}) {
  if (loading) return <div className="px-3 py-2 text-xs text-ink-2">Resolving…</div>;
  if (!trace) return null;

  if (trace.status !== "ok") {
    return (
      <div className="well p-4 text-xs leading-relaxed text-ink-2" data-testid={`trace-${trace.status}`}>
        <div className="mb-2 font-mono text-ink-1">
          payload_hash: <Copyable value={hex(record.payloadHash)} display={truncate(hex(record.payloadHash), 12, 8)} />
        </div>
        {trace.status === "not-anchored" &&
          "No locator on chain for this hash, and no content-addressed gateway here serves it by name."}
        {trace.status === "unavailable" &&
          "The chain names a locator, but the bytes came back wrong, or from nowhere this deployment can read. The chain's commitment stands; the copy does not."}
        {/* A payload written encrypted gets no sentence (privacy is a roadmap item): the hash
            and the verify block below still say what the chain committed. */}
        {trace.status === "unconfigured" && "No reader for this locator's scheme on this deployment."}
        {(trace.url || trace.bundle?.url) && (
          <div className="mt-3">
            <TraceVerify record={record} trace={trace} origin={origin} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="well space-y-3 p-4" data-testid="trace-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/[0.08] pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="good" dot>
            sha256 matches payload_hash
          </Badge>
          <span className="text-2xs text-ink-3">
            {trace.via === "chain"
              ? "located through the on-chain registry"
              : trace.via === "bundle"
              ? "from this session's bundle, re-hashed"
              : "fetched by hash, re-hashed"}
          </span>
        </div>
        <div className="font-mono text-xs text-ink-3">{truncate(hex(record.payloadHash), 8, 6)}</div>
      </div>
      <TraceBlock label="Payload preimage" bytes={trace.bytes!} />
      {trace.commitments && trace.commitments.length > 0 && (
        <div className="space-y-2 pt-1" data-testid="trace-commitments">
          {/* Shown, not resolved. A `policy_version_hash` commits to a document the runtime
              derives — model, temperature, tool allow-list, cost cap, and the prompt's hash when
              there is one — and nothing stores it as a blob, so there is nothing to fetch. It is
              still the only chain fact about what this agent *was* when it ran this session,
              which is what makes it worth printing beside the leaves that are fetchable. */}
          <div className="eyebrow">Commits to</div>
          {trace.commitments.map((c) => (
            <div
              key={c.hash}
              className="flex flex-wrap items-baseline gap-2 rounded-md border border-line/[0.06] bg-line/[0.02] px-3 py-2 text-xs"
              data-testid={`commitment-${c.label.replace(/\s+/g, "-")}`}
              data-hash={c.hash}
            >
              <span className="font-medium text-ink-1">{c.label}</span>
              <Copyable value={c.hash} display={truncate(c.hash, 10, 6)} />
              <span className="text-2xs text-ink-3">
                sha256 of what this session ran under; it moves when the agent&apos;s configuration does
              </span>
            </div>
          ))}
        </div>
      )}
      {/* The `tempo` rail's block, for an Action whose result blob carries a payment. It resolves
          that blob itself and renders nothing at all when there is none — every vault-rail Action,
          and every older Action whose result carries no payment (`components/TracePanel.tsx`). */}
      {record.kind === EventKind.Action && ownerId && (
        <TempoTraceBlock
          agentId={ownerId}
          seq={record.seq.toString()}
          store={store}
          genesis={genesis}
          resultHash={trace.parts?.[1]?.hash}
        />
      )}
      {trace.parts && trace.parts.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="eyebrow">Inside it</div>
          {trace.parts.map((part) => (
            <TracePart key={part.hash} store={store} genesis={genesis} label={part.label} hash={part.hash} />
          ))}
        </div>
      )}
      <TraceVerify record={record} trace={trace} origin={origin} />
    </div>
  );
}

function TracePart({
  store,
  genesis,
  label,
  hash,
}: {
  store: TraceReaders | null;
  genesis?: Uint8Array;
  label: string;
  hash: string;
}) {
  const part = useTracePart(store, hash, true, genesis);
  if (part.isLoading) return <div className="px-2 text-xs text-ink-3">{label}: resolving…</div>;
  if (part.data?.status === "ok") return <TraceBlock label={label} bytes={part.data.bytes!} />;
  // *Encrypted* is not *not served*: a part written encrypted keeps its label and
  // hash and says nothing more, since privacy is a roadmap item.
  const encrypted = part.data?.status === "encrypted";
  return (
    <div
      className="rounded-md border border-line/[0.06] bg-line/[0.02] px-3 py-2 text-xs text-ink-2"
      data-testid={encrypted ? "trace-part-encrypted" : "trace-part-missing"}
    >
      <span className="font-medium text-ink-1">{label}:</span>{" "}
      <span className="font-mono text-ink-3">{truncate(hash, 10, 6)}</span> {encrypted ? null : "— not served"}
    </div>
  );
}

function TraceBlock({ label, bytes }: { label: string; bytes: Uint8Array }) {
  return (
    <div className="rounded-lg border border-line/[0.06] bg-canvas p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <span className="num text-[10px] text-ink-3">{bytes.length} bytes</span>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-ink-1">
        {renderTrace(bytes)}
      </pre>
    </div>
  );
}
