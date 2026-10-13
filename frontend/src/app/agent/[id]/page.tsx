"use client";

import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { toBytes32 } from "@lath/sdk/browser";
import { AgentChat } from "@/components/AgentChat";
import { AgentLoopList, LoopActions, LoopRow } from "@/components/LoopCard";
import { AgentChainLine } from "@/components/LoopChain";
import { AllowancePanel } from "@/components/AllowancePanel";
import { EventTimeline } from "@/components/EventTimeline";
import { HashChainInspector } from "@/components/HashChainInspector";
import { DeployedDetail, OwnerHeaderCard, agentRecordKey } from "@/components/OwnerHeaderCard";
import { StoreCard } from "@/components/StoreCard";
import { StructurePanel } from "@/components/StructurePanel";
import { Card, Crumbs, FactRow, Info, Note, Proof, Skeleton } from "@/components/ui";
import { useLath } from "@/lib/clients";
import { useRunnerInfo } from "@/lib/console-stream";
import { useOwnerWatch } from "@/lib/live";
import { useNameBook } from "@/lib/names";
import { useDocumentTitle } from "@/lib/document-title";
import { useEpochs, useEvents, useOwnerState, usePublishedName } from "@/lib/queries";
import { useAgentsRegistry } from "@/lib/market";
import { NotFound } from "@/components/NotFound";

export default function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  useOwnerWatch(id);
  const stateQuery = useOwnerState(id);
  const eventsQuery = useEvents(id);
  const epochsQuery = useEpochs(id);
  const published = usePublishedName(id);
  const { nameOf } = useNameBook();
  const lath = useLath();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const registry = useAgentsRegistry();

  // The header this page last read for this id, kept through a read that answers null. A session's
  // writes nullify the header's old leaf and append the new one, and for a moment after it the
  // indexer can answer neither — the chat's own refetch, right after its session, is the read most
  // likely to land in that moment. Taken at face value, that null would flip the page into the
  // "not yet on chain" branch below, whose `AgentChat` is another instance: the exchange on screen
  // would be dropped, the chat would say "Nothing asked yet", and `/api/run?agent=` would be asked
  // again (`e2e/console.spec.ts` covers it). An id that once had a header still has one — a header is
  // never deleted short of `close_agent` — so the last one stands until a read returns a header
  // again. Kept in state set during render, not in an effect, because an effect would commit the
  // null render first, and that commit is the remount. An id never seen with a header is not
  // helped: it still gets the runtime's card or `NotFound`.
  const fetched = stateQuery.data?.state;
  const [kept, setKept] = useState<{ id: string; state: NonNullable<typeof fetched> } | null>(null);
  if (fetched && (kept?.id !== id || kept.state !== fetched)) setKept({ id, state: fetched });
  const state = fetched ?? (kept?.id === id ? kept.state : undefined);

  // The agents this server writes by default are registered by their *first* session, so on a
  // fresh cluster their pages have no header yet. Ask the runtime before calling the id unknown:
  // an agent it operates gets its chat card, and that first send is what puts it on chain.
  // What this console recorded when it deployed the agent: the template version the record links
  // to, its lineage, and whether it is archived. A 404 is the normal answer for an agent this
  // server did not deploy — the page reads a chain, and this only adds what the console knows.
  const deployed = useQuery<DeployedDetail | null>({
    queryKey: agentRecordKey(id),
    queryFn: async () => {
      // The route id is one path segment, so it is encoded as one, as `lib/zeroclaw.ts` does.
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      return (await res.json()).agent ?? null;
    },
    staleTime: 30_000,
  });

  // The name, strongest claim first: a published `NameRecord` the chain can check, the browser's
  // name book (filed under `sha256(name)`, so it cannot name the wrong id), then the name this
  // console registered the agent under. The last is what a launched copy has until its owner
  // publishes one — without it the page would call a copy the wallet had just named *Unnamed*, while
  // the tile for the same agent shows the name, because the tile join falls back to it.
  const name = published.data ?? nameOf(id) ?? deployed.data?.name ?? undefined;
  // The wallet that deployed the agent gets the Budget row's _Change_ and the two buttons; any other
  // reads the rows. The same rule as the ⋯ menu's (`useAgentActions`) and the Ask card's.
  const owner = !!wallet && !!deployed.data?.owner && deployed.data.owner === wallet;
  // The console's registry row carries the deploy's chain records, which the On Solana row links.
  const registered = registry.data?.agents.find((a) => a.id === id.toLowerCase());
  const nameSource = published.data ? "published" : nameOf(id) ? "local" : deployed.data?.name ? "runtime" : undefined;
  useDocumentTitle(name);

  const runner = useRunnerInfo({ enabled: !stateQuery.isLoading && !state });
  const operatedHere = runner.data?.agents?.find((a) => a.id === id.toLowerCase());

  if (stateQuery.isLoading) return <PageSkeleton />;
  if (!state) {
    if (runner.isLoading) return <PageSkeleton />;
    if (!operatedHere)
      return <NotFound kind="agent" id={id} error={stateQuery.error} onRetry={() => void stateQuery.refetch()} />;
    return (
      <div className="space-y-6">
        <Crumbs items={[{ label: "Agents", href: `/?item=${id.toLowerCase()}` }, { label: operatedHere.name }]} />
        <Card title={operatedHere.name} description="An agent this server runs, not yet on chain.">
          <Note>
            No session has been run on it yet, so it has no header on {stateQuery.error ? "the indexer" : "chain"}. Its
            first session registers it — authority{" "}
            <span className="font-mono text-xs text-ink-1">{operatedHere.authority}</span> — and everything below
            appears the moment that session lands.
          </Note>
        </Card>
        {/* Nothing to read back here: an agent with no header on chain has no records, and its
            first session is the one that registers it. Open, not folded as on a chain's page:
            the chat is the one thing this page offers. */}
        <AgentChat id={id} defaultOpen />
      </div>
    );
  }

  const records = eventsQuery.data ?? [];
  const epochs = epochsQuery.data ?? [];
  // An empty list from a read that *failed* is not an empty chain, and the two components below
  // both state a positive fact about it: the header card works out how many operations "left no
  // record and are in no epoch" from `records.length`, and the timeline says "No events of this
  // kind." A rejecting Photon scan would have the page explain an absence that was never read.
  const recordsUnread = eventsQuery.isError || epochsQuery.isError;

  return (
    <div className="space-y-6">
      {/* The list this page is a deep link out of is the workspace's: the crumb goes back to it
          with this agent selected, rather than to `/agents`, which redirects. Without the name: the
          heading says it a line below. */}
      <Crumbs
        items={[
          {
            label: (
              <>
                <span aria-hidden>‹</span> Agents
              </>
            ),
            href: `/?item=${id.toLowerCase()}`,
          },
        ]}
      />

      <OwnerHeaderCard
        id={id}
        state={state}
        address={lath.agentAddress(toBytes32(id))}
        records={records}
        recordsUnread={recordsUnread}
        epochs={epochs}
        name={name}
        nameSource={nameSource}
        deployed={deployed.data ?? undefined}
      >
        {/* The agent's standing in three rows, then what to do with it: rows rather than a card each,
            so the allowance and the loop read in one shape. `#allowance` and `#loop` are the rows' own
            anchors; the buttons are `LoopActions`. */}
        <dl className="space-y-3 text-sm">
          <AllowancePanel agentAuthority={state.authority} canChange={owner} />
          <FactRow label="Solana" testId="agent-chain">
            {/* The count opens the Proof below, where every record is listed with its hash chain, and
                scrolls to it. The records are compressed accounts, which an explorer does not
                list as an agent's, so the page's own table is the place to see them all. */}
            <a
              href="#records"
              className="num link"
              data-source="chain"
              data-testid="agent-records-open"
              title="Every record of this agent on Solana, with the hash chain that links them"
              onClick={() => {
                // A second click on the same fragment fires no `hashchange`: say it, so a closed box opens.
                if (window.location.hash === "#records") window.dispatchEvent(new HashChangeEvent("hashchange"));
              }}
            >
              {state.seq.toString()} {state.seq.toString() === "1" ? "record" : "records"}
            </a>
            {/* The deploy as its chain records it (`agent.deploy`), with what is still owed. Nothing for
                an agent deployed before the records or read from an older console. */}
            <AgentChainLine chain={registered?.chain} />
          </FactRow>
          <LoopRow id={id} />
        </dl>
        <LoopActions id={id} />
      </OwnerHeaderCard>

      {/* The agent's loop runs: the agent works by stepping a goal loop, and the list is what a
          reader of its page comes for. The chat is on the page of an agent this server runs and has
          not put on chain yet, above. */}
      <AgentLoopList id={id} />

      {/* Everything that proves the page rather than runs it — the store and the structures, the
          events with their epochs and Prove, the hash-chain inspector, _Verify offline_ and
          _Export verification_ — behind one Proof. A link into it (`?seq=`, `?at=`, `?prove=`,
          which `CopyLink` hands out) opens it, since the row it names is inside. Its summary says
          what is inside rather than repeat the header's verdict. */}
      <Proof
        summary={<span data-testid="proof-summary">events, the hash chain and the offline checks</span>}
        openWhen={["seq", "at", "prove"]}
        hash="records"
        testId="proof"
      >
        <div className="space-y-6">
          {/* What the agent keeps: the store its sessions, its loops and its owner use, then the
              structures the runtime keeps for itself, collapsed. */}
          <Card
            title={
              <>
                <span>Data</span>
                <Info label="About this agent's data">
                  <p className="text-2xs leading-relaxed text-ink-3">
                    Everything this agent keeps on its chain besides its events.
                  </p>
                </Info>
              </>
            }
          >
            <StoreCard nested agentId={id} owner={deployed.data?.owner} tools={deployed.data?.policy.tools} />
            <StructurePanel id={id} />
          </Card>

          <Card
            title={
              <>
                <span>Events</span>
                <Info label="About the events">
                  <p className="text-2xs leading-relaxed text-ink-3">
                    Every record this agent wrote, and every epoch that stands in for a run of steps.
                  </p>
                </Info>
              </>
            }
            right={
              eventsQuery.isLoading || epochsQuery.isLoading ? (
                <span className="text-xs text-ink-3">reading…</span>
              ) : undefined
            }
          >
            {/* Both lists, or neither: a timeline without its epochs would export a bundle with gaps and
                resolve `?prove=` against rows that are not there yet. */}
            {eventsQuery.isLoading || epochsQuery.isLoading ? (
              <Skeleton rows={4} />
            ) : (
              <EventTimeline records={records} epochs={epochs} id={id} name={name} unread={recordsUnread} />
            )}
            {/* The same records, one head at a time: the replay that proves the list above is a chain. */}
            {records.length > 0 && <HashChainInspector nested records={records} agentId={id} />}
          </Card>
        </div>
      </Proof>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="skeleton h-4 w-40" />
      <div className="surface p-5">
        <Skeleton rows={3} />
      </div>
      <div className="surface p-5">
        <Skeleton rows={5} />
      </div>
    </div>
  );
}
