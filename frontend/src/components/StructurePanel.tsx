"use client";

import { useMemo, useState } from "react";
import {
  AppendPolicy,
  Cell,
  hex,
  idFromString,
  STORE_ID,
  StructHeader,
  StructKind,
  StructMode,
} from "@lath/sdk/browser";
import { Badge, ChevronIcon, Copyable, Empty, KV, ReadFailed, Segmented, Skeleton } from "@/components/ui";
import { formatTimestampMs, truncate } from "@/lib/format";
import { StructureView, useStructures } from "@/lib/queries";

const STORE_HEX = hex(STORE_ID);

const WELL_KNOWN: [string, string][] = [
  [hex(idFromString("mailbox")), "Mailbox (Queue)"],
  [hex(idFromString("task-graph")), "Task Graph (DAG State)"],
  [hex(idFromString("locator-registry")), "Locator Registry"],
  [hex(idFromString("profile")), "Profile & Name Record"],
  [hex(idFromString("policy-registry")), "Policy Registry"],
  [hex(idFromString("store")), "Agent Store"],
];

function labelFor(structId: Uint8Array): string | undefined {
  const id = hex(structId);
  return WELL_KNOWN.find(([known]) => known === id)?.[1];
}

const POLICY: Record<AppendPolicy, string> = {
  [AppendPolicy.OwnerOnly]: "Owner only",
  [AppendPolicy.AllowList]: "Allow-list",
  [AppendPolicy.Anyone]: "Anyone",
};

function asText(slot: Uint8Array): string | undefined {
  let end = slot.length;
  while (end > 0 && slot[end - 1] === 0) end--;
  if (end === 0) return undefined;
  for (let i = 0; i < end; i++) if (slot[i] < 0x20 || slot[i] > 0x7e) return undefined;
  return new TextDecoder().decode(slot.subarray(0, end));
}

type Filter = "all" | "log" | "map";

/**
 * The runtime's own structures — mailbox, task graph, policy and locator registries, the name
 * record — as the collapsed last section of the agent page's Data card. The agent store is listed
 * above it by `StoreCard` and left out here, so no structure shows twice.
 *
 * Collapsed by default: these are what an auditor opens, not what an owner uses.
 */
export function StructurePanel({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const query = useStructures(id);
  const rawData: StructureView[] = useMemo(
    () => (query.data ?? []).filter((s) => hex(s.header.structId) !== STORE_HEX),
    [query.data]
  );

  const filtered = useMemo(() => {
    if (filter === "log") return rawData.filter((s) => s.header.kind === StructKind.Log);
    if (filter === "map") return rawData.filter((s) => s.header.kind === StructKind.Map);
    return rawData;
  }, [rawData, filter]);

  const logs = rawData.filter((s) => s.header.kind === StructKind.Log).length;
  const maps = rawData.filter((s) => s.header.kind === StructKind.Map).length;

  return (
    <div className="mt-5 border-t border-line/[0.08] pt-5 first:mt-0 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left"
          data-testid="system-structures-toggle"
        >
          <span className="text-ink-3">
            <ChevronIcon open={open} />
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink-1">System structures</span>
          {/* No count over a failed read: "0 live" would say what the read did not establish. */}
          <span className="num text-xs text-ink-3">
            {query.isLoading ? "…" : query.isError && !query.data ? "unread" : `${rawData.length} live`}
          </span>
        </button>
        {open && rawData.length > 0 && (
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            size="sm"
            label="Structure kind"
            options={[
              { value: "all", label: "All", count: rawData.length },
              { value: "log", label: "Logs / queues", count: logs },
              { value: "map", label: "Maps / registries", count: maps },
            ]}
          />
        )}
      </div>
      <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-3">
        What the runtime keeps for itself: the mailbox delegated work arrives in, the graph of who handed work to whom,
        and the registries that name its policies and where its blobs are.
      </p>
      {open && (
        <div className="mt-4">
          {query.isLoading ? (
            <Skeleton rows={3} />
          ) : query.isError && !query.data ? (
            // A failed read says why, never *no system structures*: that is a claim about the chain.
            <ReadFailed error={query.error} onRetry={() => void query.refetch()} />
          ) : filtered.length === 0 ? (
            <Empty>This agent has no system structures on chain yet.</Empty>
          ) : (
            <div className="space-y-2">
              {filtered.map((s) => (
                <StructureRow key={hex(s.header.structId)} view={s} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StructureRow({ view }: { view: StructureView }) {
  const { header, cells } = view;
  const [open, setOpen] = useState(false);

  const isSet =
    header.kind === StructKind.Map && cells.length > 0 && cells.every((c) => c.valueSlot.every((b) => b === 0));

  const kindLabel =
    header.kind === StructKind.Log
      ? header.consumable
        ? "Log · consumable queue"
        : "Log · append-only"
      : isSet
      ? "Set · unique keys"
      : "Map · key-value";

  const label = labelFor(header.structId);

  return (
    <div
      className={`rounded-lg border transition-colors ${
        open ? "border-line/[0.14] bg-line/[0.02]" : "border-line/[0.08] hover:border-line/[0.14]"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="structure-row"
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-ink-3">
          <ChevronIcon open={open} />
        </span>
        <span className="font-medium text-ink-1">
          {label ?? <span className="font-mono text-xs">{truncate(hex(header.structId), 8, 8)}</span>}
        </span>
        <Badge tone={header.kind === StructKind.Log ? "cyan" : "blue"}>{kindLabel}</Badge>
        {header.mode === StructMode.Private && <Badge tone="warn">private</Badge>}

        <span className="ml-auto flex items-center gap-4 text-xs text-ink-3">
          <span className="num">
            {cells.length} live / {header.lenOrCount.toString()} ops
          </span>
          <span className="hidden sm:inline">{POLICY[header.appendPolicy]}</span>
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-line/[0.08] px-4 py-4">
          <KV
            items={[
              { label: "Struct id", value: <Copyable value={hex(header.structId)} /> },
              { label: "Header address", value: header.address ? <Copyable value={header.address.toBase58()} /> : "—" },
              {
                label: "Created at op",
                value: <span className="num text-xs text-ink-1">seq #{header.createdOpSeq.toString()}</span>,
              },
              {
                label: "Append policy",
                value: <span className="text-xs text-ink-1">{POLICY[header.appendPolicy]}</span>,
              },
            ]}
          />
          <CellTable cells={cells} header={header} isSet={isSet} />
        </div>
      )}
    </div>
  );
}

function CellTable({ cells, header, isSet }: { cells: Cell[]; header: StructHeader; isSet: boolean }) {
  const isLog = header.kind === StructKind.Log;
  const isPrivate = header.mode === StructMode.Private;
  const rows = useMemo(
    () => [...cells].sort((a, b) => (isLog ? Number(a.indexOrVersion - b.indexOrVersion) : Number(a.opSeq - b.opSeq))),
    [cells, isLog]
  );

  if (rows.length === 0) {
    return <Empty>No live cells. All previously added cells have been consumed or closed.</Empty>;
  }

  return (
    <div className="table-wrap">
      <table className="w-full min-w-[42rem] text-sm">
        <thead className="border-b border-line/[0.08]">
          <tr>
            <th className="th">{isLog ? "Index" : "Key slot"}</th>
            {!isSet && <th className="th">Value slot</th>}
            <th className="th">Tag</th>
            <th className="th">Status</th>
            <th className="th">Op seq</th>
            <th className="th">Timestamp</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/[0.06]">
          {rows.map((cell) => (
            <tr key={cell.address?.toBase58() ?? `${cell.indexOrVersion}-${cell.opSeq}`} className="row-hover">
              <td className="td num text-xs text-ink-1">
                {isLog ? `#${cell.indexOrVersion.toString()}` : <Copyable value={hex(cell.keySlot)} />}
              </td>
              {!isSet && (
                <td className="td">
                  <Slot bytes={cell.valueSlot} isPrivate={isPrivate} />
                </td>
              )}
              <td className="td font-mono text-xs text-ink-2">{cell.tag || "—"}</td>
              <td className="td font-mono text-xs text-ink-2">{cell.status || "—"}</td>
              <td className="td num text-xs text-ink-2">
                #{cell.opSeq.toString()}
                {!isLog && <span className="ml-1 text-ink-3">v{cell.indexOrVersion.toString()}</span>}
              </td>
              <td suppressHydrationWarning className="td whitespace-nowrap text-xs text-ink-2">
                {formatTimestampMs(cell.timestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Slot({ bytes, isPrivate }: { bytes: Uint8Array; isPrivate: boolean }) {
  const text = isPrivate ? undefined : asText(bytes);
  if (bytes.every((b) => b === 0)) return <span className="text-xs text-ink-3">—</span>;
  if (text)
    return (
      <span className="rounded bg-line/[0.05] px-1.5 py-0.5 font-mono text-xs text-accent-strong">
        &quot;{text}&quot;
      </span>
    );
  return <Copyable value={hex(bytes)} />;
}
