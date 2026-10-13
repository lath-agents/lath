"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { Card, Empty, ErrorNote, ExplorerLink, Info, Note, Skeleton } from "@/components/ui";
import { LoopStartForm } from "@/components/LoopStartForm";
import { CreatorWizard, type DeployedAgent } from "@/components/CreatorWizard";
import { CreateMode, StartFrom } from "@/components/StartFrom";
import { useDeployedAgents } from "@/lib/market";
import { loopFormKey } from "@/lib/loop-form-key";
import { useLoopPreset } from "@/lib/loop-presets";
import type { Draft, DraftLoop, SourceRef } from "@/lib/draft";

/**
 * `/create?loop=1`: one way to make a loop.
 *
 * A loop is a schedule on an agent, so the only thing worth settling first is which agent runs it.
 * `?agent=<id>` — what *Compose a loop* on an agent's page links to — settles it, and the page
 * opens on that agent's terms. With no agent named it opens on the first agent this wallet owns.
 *
 * A loop always starts on an agent that already exists. `/create` deploys and nothing else, and a
 * wallet with no agent is sent there first. Two prompts for a scheduled agent — the deploy's
 * transaction, then this form's `"Lath loop"` message — and one job per screen.
 *
 * Above both sits *Start from* when no agent is named, the loop flow's half of the builder: this
 * wallet's own agents (put one on a schedule, which is what the select below does), and its runs and
 * its loop templates (open their terms in the form and edit them).
 *
 * _Run as a loop_ on an agent names it (`?agent=<id>`), and then there is no *Start from*: the owner
 * already said what to start from — this agent — and the form opens on it. No preset is listed on
 * screen: a preset is reached by its own link, `&preset=<id>`, which a spec or a demo opens directly
 * (`lib/loop-presets.ts`). A deep link with `?from=` keeps *Start from*, because that is where its
 * prefill is applied.
 *
 * The picker adds a step; it does not take one away. Nothing is hidden behind it: with no pick
 * made the page below is the plain form, and `?loop=1&agent=<id>` opens on that agent's form, which
 * is what the loop specs read.
 */
export function LoopEntry({ agentId, from }: { agentId?: string; from?: SourceRef | null }) {
  const { publicKey } = useWallet();
  const preset = useLoopPreset();
  const wallet = publicKey?.toBase58() ?? null;
  const deployed = useDeployedAgents();
  const mine = (deployed.data ?? []).filter((a) => a.owner === wallet);
  // `?agent=` is a request, not a promise. An id this wallet does not own is not in `mine`, so the
  // select falls back to a row it does own rather than offering a loop `/api/loops` would refuse.
  const wanted = agentId?.toLowerCase() ?? "";
  const [picked, setPicked] = useState(wanted);
  // The terms a pick from *Your assets* opened with, and the loop template they came from. Null
  // until something is picked, which is what keeps the two openings above untouched.
  const [terms, setTerms] = useState<PickedTerms | null>(null);
  // How many picks *Start from* has made. It is in the form's key (`loopFormKey`), so every pick
  // mounts a fresh form: two picks can carry the same template id and version on one agent — two
  // runs of one lineage, or a template-less run and the blank form — and keyed on those the second
  // pick would keep the first one's terms on screen.
  const [pick, setPick] = useState(0);
  // _Run as a loop_ on an agent names it, and the page then opens on that agent's form with no
  // _Start from_ above it; a `?from=` deep link still needs _Start from_, which applies its prefill.
  const fromAgent = !!wanted && !from;
  const chosen = mine.find((a) => a.id === picked) ?? mine.find((a) => a.id === wanted) ?? mine[0] ?? null;
  // The agent `?agent=` named, once it resolves to one of this wallet's, is said in one read-only line
  // rather than asked again in a select: _Run as a loop_ already
  // answered which agent. _change_ brings the select back. The select stays mounted, hidden, while the
  // line shows: it is the control the specs read the chosen agent from (`loop-agent-select`).
  const [changing, setChanging] = useState(false);
  // Which _Create from_ choice was made; null until one is, so the page can open on the right one.
  // A `?from=` deep link names it: an agent is _Existing agent_, a run or a template _Existing loop_.
  const [chosenMode, setChosenMode] = useState<CreateMode | null>(
    from ? (from.kind === "agent" ? "agent" : "loop") : null
  );
  const settled = fromAgent && !changing && !!chosen && chosen.id === wanted;
  // _New_'s step 1 done: the agent the wizard just deployed, whose loop form is step 2 on this page.
  const [made, setMade] = useState<DeployedAgent | null>(null);
  const router = useRouter();

  const onPick = useCallback(
    (draft: Draft) => {
      setPick((n) => n + 1);
      const lineage = draft.lineage;
      if (lineage.kind === "agent") {
        // An agent picked here is the agent the schedule goes on: the select below is the control
        // that says so, and it is the one prefilled rather than replaced. Its template
        // is an *agent* template — a config for a deploy, not for a run — so nothing of it rides
        // on the start.
        setTerms(null);
        setPicked(lineage.sourceId.toLowerCase());
        return;
      }
      if (lineage.kind === "loop" || lineage.kind === "loop-template") {
        setTerms({
          loop: draft.loop ?? {},
          // A loop record's model is the draft's top-level one: the model belongs to the agent's
          // policy, and the loop only records which one its steps ran against.
          model: draft.model,
          template: lineage.templateId ? { id: lineage.templateId, version: lineage.version } : undefined,
          lineageName: lineage.sourceName,
        });
        // The coordinator stays the agent the source ran on, and members stay empty. A
        // loop template whose coordinator is a `{ template }` slot names no agent, and the select
        // is then still the question to answer — so the pick falls back to it rather than to an
        // agent the source never mentioned.
        if (draft.loop?.agentId) setPicked(draft.loop.agentId.toLowerCase());
        return;
      }
      // Blank: the form with nothing prefilled, on the agent that was named or the first one this
      // wallet owns. An offer never reaches here: `StartFrom` lists none.
      setTerms(null);
      setPicked(wanted);
    },
    [wanted]
  );

  const body = (
    <div className="space-y-4">
      <Card
        tone="emerald"
        // The one-loop rule in an ⓘ: the form says it again, in full, where it applies — the running
        // loop's link, or the start's refusal.
        title={
          <>
            {/* _Agent loop_, the create page's own word for it. */}
            {chosen ? `Agent loop on ${chosen.name}` : "Agent loop"}
            <Info label="One loop per agent" testId="loop-entry-info">
              <p>One running loop per agent; the server runs one step at a time.</p>
            </Info>
          </>
        }
      >
        {!wallet ? (
          <Empty>Connect a wallet to list the agents it deployed.</Empty>
        ) : deployed.isLoading ? (
          <Skeleton rows={3} />
        ) : mine.length === 0 ? (
          <Empty>
            <span data-testid="loop-no-agent">
              A loop runs on an agent this wallet deployed, and it has none yet.{" "}
              {fromAgent ? (
                <Link href="/create?loop=1" className="link">
                  Create one with its loop
                </Link>
              ) : (
                <>
                  Choose <em>New</em> above to create one with its loop.
                </>
              )}
            </span>
          </Empty>
        ) : (
          <div className="space-y-5">
            {settled && chosen && (
              <div data-testid="loop-agent-fixed">
                <div className="mb-1.5 text-xs font-medium text-ink-2">Agent</div>
                <div className="flex items-center gap-3 text-sm text-ink-1">
                  <span className="min-w-0 truncate">
                    {chosen.name} · <span className="font-mono text-ink-2">{chosen.policy.model}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setChanging(true)}
                    className="link text-2xs"
                    data-testid="loop-agent-change"
                  >
                    change
                  </button>
                </div>
              </div>
            )}
            <label
              // A class, not the `hidden` attribute: Tailwind's `block` would override the attribute's
              // display and draw the select under the line anyway.
              className={settled ? "hidden" : "block"}
            >
              <div className="mb-1.5 text-xs font-medium text-ink-2">Agent</div>
              <select
                className="input"
                value={chosen?.id ?? ""}
                onChange={(e) => setPicked(e.target.value)}
                data-testid="loop-agent-select"
              >
                {mine.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.policy.model}
                  </option>
                ))}
              </select>
            </label>
            {chosen && (
              // The `key` is the whole prefill contract: `LoopStartForm` reads `initial` in its
              // state initialiser, so a second pick has to arrive as a fresh mount or it would be
              // a form showing one run's terms and about to post another's. It counts picks rather
              // than naming the template, which two different picks can share (`loopFormKey`).
              <LoopStartForm
                key={loopFormKey(chosen.id, pick)}
                agentId={chosen.id}
                agentName={chosen.name}
                model={terms?.model ?? chosen.policy.model}
                agentTools={chosen.policy.tools}
                initial={terms?.loop}
                template={terms?.template}
                lineageName={terms?.lineageName}
              />
            )}
          </div>
        )}
      </Card>
    </div>
  );

  // _Create from_ is three choices: an existing agent (the form below, its agent select the pick), an
  // existing loop (a past run's or a loop template's terms, picked from tiles, then the form), or new
  // (the agent wizard, which on its deploy continues to this form on the agent it made). There is no
  // _Or deploy a new agent_ link under the form: _New_ is that.
  // With no choice made the page opens on _Existing agent_, or on _New_ for a wallet with no agent.
  const showCreateFrom = !preset && !fromAgent;
  const mode: CreateMode =
    chosenMode ?? (showCreateFrom && wallet && !deployed.isLoading && mine.length === 0 ? "new" : "agent");
  // _New_ is the wizard with its _Agent loop_ step: the agent and its loop
  // configured together and sent in the one transaction the deploy signs, after which the page goes to
  // the loop. What follows is the fallback when that loop did not start — the deploy stands, so the
  // loop form opens here on the agent it made, for a start with its own message — or when the name was
  // this wallet's already (nothing deployed, nothing started). It reads the agent from the deploy
  // itself, and from the wallet's list only when that already has it (a name this wallet held, whose
  // record kept its own model and tools), so it never waits on the list or opens on another agent.
  const madeRow = made ? mine.find((a) => a.id === made.id) : undefined;
  const madeModel = madeRow?.policy.model ?? made?.model;
  const madeTools = madeRow?.policy.tools ?? made?.tools;
  const stepTwo = made && (
    <Card
      tone="emerald"
      title={
        <>
          Agent loop on {made.name}
          <Info label="One loop per agent" testId="loop-entry-info">
            <p>One running loop per agent; the server runs one step at a time.</p>
          </Info>
        </>
      }
    >
      <div className="space-y-5" data-testid="new-loop-step">
        {made.loopError && (
          <ErrorNote>
            The agent is deployed, but its loop did not start: {made.loopError}. Start it below; that asks for one
            signature.
          </ErrorNote>
        )}
        <Note tone="good">
          {made.name} is deployed on Solana
          {made.signature ? (
            <>
              {" "}
              (<ExplorerLink kind="tx" value={made.signature} />)
            </>
          ) : (
            " (already yours under this name)"
          )}
          . Write the loop&apos;s goal and budget below, then start it with one signature.
        </Note>
        {madeModel ? (
          <LoopStartForm
            key={made.id}
            agentId={made.id}
            agentName={made.name}
            model={madeModel}
            agentTools={madeTools}
          />
        ) : (
          <Skeleton rows={3} />
        )}
      </div>
    </Card>
  );
  return (
    <div className="space-y-6">
      {/* Not under a preset link (`&preset=<id>`): the link already
          says what to start from, and a pick here would only replace the terms it filled. Gone at
          _New_'s step 2, which is about the agent just made and nothing else. */}
      {showCreateFrom && !made && (
        <StartFrom kind="loop" mode={mode} onMode={setChosenMode} initial={from} onPick={onPick} />
      )}
      {showCreateFrom && mode === "new" ? (
        made ? (
          stepTwo
        ) : (
          <CreatorWizard
            draft={BLANK}
            withLoop
            onDeployed={(agent) => {
              // Started with the deploy: its page is where a run is watched.
              if (agent.loopId) {
                router.push(`/loop/${agent.loopId}`);
                return;
              }
              // Held at _New_: a wallet with no agent opened here by default, and the list the deploy
              // refreshed now has one, which would otherwise turn the page to _Existing agent_.
              setChosenMode("new");
              setMade(agent);
            }}
          />
        )
      ) : showCreateFrom && mode === "loop" && !terms ? null : (
        // _Existing loop_ shows the form once a run or a template is picked, not a blank one before.
        body
      )}
    </div>
  );
}

/** The new agent's draft: blank, with no lineage. */
const BLANK: Draft = { lineage: { kind: "blank" } };

/** What a pick from *Your assets* carries into the form below it. */
interface PickedTerms {
  loop: DraftLoop;
  model?: string;
  template?: { id: string; version?: number };
  lineageName?: string;
}
