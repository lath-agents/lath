"use client";

import { use } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { hex } from "@lath/sdk/browser";
import { Badge, Card, Copyable, Crumbs, Empty, ExplorerLink, PageHeader, ReadFailed, Skeleton } from "@/components/ui";
import { formatTimestampMs, truncate } from "@/lib/format";
import { useNameBook } from "@/lib/names";
import { useOwnersByAuthority, usePublishedNames } from "@/lib/queries";

/**
 * Everything one key signs for. This is the page a `reference` on a Genesis or Delegation
 * record points at: those fields hold a *pubkey*, and a pubkey's meaning here is "the authority
 * behind some set of agents".
 */
export default function AuthorityPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { nameOf } = useNameBook();

  let authority: PublicKey | null = null;
  try {
    authority = new PublicKey(key);
  } catch {
    authority = null;
  }

  const owners = useOwnersByAuthority(authority);
  // A published name is checked by re-hashing, so it outranks the local name book.
  const published = usePublishedNames((owners.data ?? []).map((o) => hex(o.state.agentId)));

  if (!authority) return <Empty>“{truncate(key, 8, 8)}” is not a valid address.</Empty>;

  return (
    <div className="space-y-8">
      <PageHeader
        // The crumb names the workspace, which `/agents` redirects to.
        eyebrow={<Crumbs items={[{ label: "Agents", href: "/" }, { label: "Authority" }]} />}
        title={<span className="font-mono text-lg sm:text-xl">{truncate(authority.toBase58(), 10, 8)}</span>}
        description={
          <span className="inline-flex flex-wrap items-center gap-3">
            <Copyable value={authority.toBase58()} display={authority.toBase58()} />
            <ExplorerLink kind="address" value={authority.toBase58()} />
          </span>
        }
      />

      <Card
        title={
          <>
            <span>Signs for</span>
            {/* No count over a failed read: a 0 there would say what the read did not establish. */}
            {!owners.isError && <span className="num text-xs font-normal text-ink-3">{owners.data?.length ?? 0}</span>}
          </>
        }
        description="Agents whose header names this key as authority: the key that appends to their chains."
      >
        {owners.isLoading ? (
          <Skeleton rows={3} />
        ) : owners.isError ? (
          // A read that failed says why, never *not the authority of any agent*: that sentence is a
          // claim about the chain, and a failed read established nothing about it (inv §5).
          <ReadFailed error={owners.error} onRetry={() => void owners.refetch()} />
        ) : (owners.data?.length ?? 0) === 0 ? (
          <Empty>This key is not the authority of any agent on this cluster.</Empty>
        ) : (
          <ul className="divide-y divide-line/[0.06] text-sm">
            {owners.data!.map((owner) => {
              const id = hex(owner.state.agentId);
              return (
                <li key={owner.address.toBase58()} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone="cyan">agent</Badge>
                    <Link href={`/agent/${id}`} className="link truncate text-sm font-medium">
                      {published.data?.[id] ?? nameOf(id) ?? truncate(id, 8, 6)}
                    </Link>
                  </span>
                  <span className="num whitespace-nowrap text-xs text-ink-3">
                    {owner.state.seq.toString()} ops · {formatTimestampMs(owner.state.updatedAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
