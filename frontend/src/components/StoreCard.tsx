"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  STORE_ID,
  StoreEntry,
  StoreWriter,
  hex,
  openStoreEntry,
  storeWriteBinding,
  toBytes32,
} from "@lath/sdk/browser";
import { Badge, Button, Card, Empty, ErrorNote, Field, Info, Skeleton } from "@/components/ui";
import { useLath } from "@/lib/clients";
import { config } from "@/lib/config";
import { signAuth } from "@/lib/console-stream";
import { formatTimestampMs } from "@/lib/format";
import { explainError } from "@/lib/writes";

const storeKey = (id: string) => ["agent-store", id.toLowerCase()] as const;

/**
 * Every key of the agent's store, each entry re-hashed against the cell that commits to it
 * (`openStoreEntry`). The entries are fetched from `/api/traces`, which is trusted only to have
 * them: bytes that do not hash to the slot, or that name another key, show as a mismatch.
 */
function useAgentStore(id: string) {
  const lath = useLath();
  return useQuery({
    queryKey: storeKey(id),
    queryFn: async (): Promise<StoreEntry[]> => {
      const cells = await lath.listCells(toBytes32(id), STORE_ID);
      const entries = await Promise.all(
        cells.map(async (cell) => {
          const res = await fetch(`/api/traces/${hex(cell.valueSlot)}`).catch(() => null);
          const blob = res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
          return openStoreEntry(cell, blob);
        })
      );
      return entries.sort((a, b) => (a.key ?? a.keySlot).localeCompare(b.key ?? b.keySlot));
    },
    staleTime: 10_000,
  });
}

/**
 * The agent's key-value store (`sdk/src/store.ts`): what its sessions and loop steps keep between
 * runs, and what its owner can set for it. A loop runs on its agent, so the loop page shows the
 * same store.
 *
 * Read by everyone — the store is public. The form is the owner's: one signed `"Lath agent"`
 * message per write, whose action line binds the key and the value, and the console writes the
 * cell with the agent's key because only that key may replace one.
 */
export function StoreCard({
  agentId,
  owner,
  tools,
  nested = false,
}: {
  agentId: string;
  /** Rendered as a section of the agent page's Data card rather than a card of its own. */
  nested?: boolean;
  /** The wallet the console recorded as the owner; the route's own check is authoritative. */
  owner: string | null | undefined;
  /** The agent's tool allow-list, when the console knows it, to say what the agent may do here. */
  tools?: string[];
}) {
  const query = useAgentStore(agentId);
  const { publicKey } = useWallet();
  const isOwner = !!publicKey && !!owner && publicKey.toBase58() === owner;
  const entries = query.data ?? [];

  const reads = tools?.includes("store.get");
  const writes = tools?.includes("store.set");
  const access = !tools
    ? null
    : writes && reads
    ? "The agent reads and writes this store."
    : reads
    ? "The agent reads this store and cannot write it."
    : writes
    ? "The agent writes this store and cannot read it."
    : "The agent's policy grants neither store tool, so only its owner uses this store.";

  return (
    <Card
      nested={nested}
      // The description, word for word, behind the title.
      title={
        <>
          <span>Store</span>
          <Info label="About the store" wide>
            <p className="text-2xs leading-relaxed text-ink-3">
              Key-value entries on this agent&apos;s chain, kept across sessions and loop steps. Public: anyone can read
              them. {access}
            </p>
          </Info>
        </>
      }
      right={<Badge tone="neutral">{entries.length} keys</Badge>}
    >
      <div className="space-y-5" data-testid="agent-store">
        {query.isLoading ? (
          <Skeleton rows={3} />
        ) : query.error ? (
          <ErrorNote>{explainError(query.error)}</ErrorNote>
        ) : entries.length === 0 ? (
          <Empty>Nothing stored yet.</Empty>
        ) : (
          <EntryTable entries={entries} />
        )}
        {isOwner && <OwnerWrite agentId={agentId} />}
      </div>
    </Card>
  );
}

function EntryTable({ entries }: { entries: StoreEntry[] }) {
  return (
    <div className="table-wrap">
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="border-b border-line/[0.08]">
          <tr>
            <th className="th">Key</th>
            <th className="th">Value</th>
            <th className="th">Written by</th>
            <th className="th">Writes</th>
            <th className="th">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/[0.06]">
          {entries.map((e) => (
            <tr key={e.keySlot} className="row-hover" data-testid="store-entry" data-key={e.key ?? ""}>
              <td className="td font-mono text-xs text-ink-1">{e.key ?? `${e.keySlot.slice(0, 10)}…`}</td>
              <td className="td max-w-[24rem] text-xs text-ink-1">
                {e.status === "ok" ? (
                  e.value === "" ? (
                    <span className="text-ink-3">(cleared)</span>
                  ) : (
                    <span className="whitespace-pre-wrap break-words">{e.value}</span>
                  )
                ) : e.status === "missing" ? (
                  <Badge tone="warn">entry not retrievable</Badge>
                ) : (
                  <Badge tone="bad">entry does not match the chain</Badge>
                )}
              </td>
              <td className="td text-xs">
                {e.writer === StoreWriter.Owner ? (
                  <Badge tone="blue">owner</Badge>
                ) : e.writer === StoreWriter.Agent ? (
                  <Badge tone="cyan">agent</Badge>
                ) : (
                  <span className="text-ink-3">tag {e.writer}</span>
                )}
              </td>
              <td className="td num text-xs text-ink-2">{(e.version + 1n).toString()}</td>
              <td suppressHydrationWarning className="td whitespace-nowrap text-xs text-ink-2">
                {formatTimestampMs(e.timestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OwnerWrite({ agentId }: { agentId: string }) {
  const { publicKey, signMessage } = useWallet();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function save() {
    if (busy || !publicKey) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (!signMessage) throw new Error("this wallet cannot sign messages, which this needs");
      // Throws on a key or value the store refuses, before the wallet is asked for anything.
      const binding = storeWriteBinding(agentId, key, value);
      const auth = await signAuth("Lath agent", {
        ...binding,
        cluster: config.cluster,
        wallet: publicKey.toBase58(),
        signMessage,
      });
      if (!auth) throw new Error("the message was not signed");
      const res = await fetch(`/api/store/${encodeURIComponent(agentId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value, auth }),
      });
      const answer = await res.json();
      if (!res.ok) throw new Error(answer.error ?? `the server refused (${res.status})`);
      setDone(`${key} saved (write ${Number(answer.version) + 1}).`);
      // The indexer trails the write by a moment; ask again once it has had one.
      await queryClient.invalidateQueries({ queryKey: storeKey(agentId) });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: storeKey(agentId) }), 4_000);
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-line/[0.08] pt-4">
      <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
        <Field label="Key" hint="1–64 of A–Z a–z 0–9 . _ : -">
          <input
            className="input font-mono"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="threshold"
            data-testid="store-key"
          />
        </Field>
        <Field label="Value" hint="Text, up to 1024 bytes. An existing key is overwritten; empty clears it.">
          <textarea
            className="input min-h-[2.25rem]"
            rows={2}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.05"
            data-testid="store-value"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} loading={busy} disabled={busy || !key} testId="store-save">
          Save to store
        </Button>
        <span className="text-2xs text-ink-3">One signature; the console writes it with the agent&apos;s key.</span>
      </div>
      {done && <p className="text-xs text-spine-green">{done}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
