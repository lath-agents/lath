"use client";

import { CSSProperties, KeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { AgentState, EpochRecord, EventRecord } from "@lath/sdk/browser";
import { PublicKey } from "@solana/web3.js";
import { AVAILABLE_TOOLS, CHAIN_READ_TOOLS } from "@/components/CreatorWizard";
import {
  Badge,
  Card,
  Copyable,
  ErrorNote,
  ExplorerLink,
  Facts,
  Info,
  Note,
  SOURCE_TITLE,
  Spinner,
} from "@/components/ui";
import { config } from "@/lib/config";
import { signAuth } from "@/lib/console-stream";
import { useLiveStatus } from "@/lib/live";
import { useChainVerification } from "@/lib/queries";
import { formatTimestampMs, truncate } from "@/lib/format";
import { chainBadge } from "@/lib/chain-badge";
import { confirmPrepared, explainError, useSendPrepared } from "@/lib/writes";
import { unrecordedWriteError } from "@/lib/broadcast";
import { copyGrantExpectation } from "@/lib/prepared-check";
import type { AgentView } from "@/types/agent";

/** What the owner can do to a deployment from its own page. */
type Action = "clone" | "archive" | "unarchive" | "useVersion";

/**
 * What `GET /api/agents/:id` says about a deployment this console made: the template version the
 * record links to, where it was cloned from, and whether it is archived. Absent for an agent this
 * server did not deploy — the page reads a chain, and the registry is only what this console knows.
 */
/** What `GET /api/agents/<id>` returns, declared once in `types/agent.ts` beside the route. */
export type DeployedDetail = AgentView;

/** The query the page and these buttons share, so an action's answer refreshes the line above it. */
export const agentRecordKey = (id: string) => ["agent-record", id.toLowerCase()] as const;

/**
 * The agent's header: its name, the chain badge and the allowance on screen, the rest one tap away.
 *
 * What stays visible is what a reader acts on — who the agent is (its model and tools under the name),
 * whether its chain checks out, and the rows and buttons the page folds in as `children`: _Budget_,
 * _On Solana_, _Loops_, then _Run as a loop_. The ids
 * (agent id, authority, compressed address, operations), the template it was deployed from, the
 * epochs folded and the live indicator are details a reader looks up rather than reads, so they sit in
 * one `Info` beside the badge, with the sentences explaining the owner's ⋯ menu after them, under one ⓘ.
 * Every id and figure the header knows is in the popover, with where it was read.
 */
export function OwnerHeaderCard({
  id,
  state,
  address,
  records,
  epochs,
  name,
  nameSource,
  deployed,
  recordsUnread,
  children,
}: {
  id: string;
  state: AgentState;
  address: PublicKey;
  records: EventRecord[];
  epochs?: EpochRecord[];
  name?: string;
  nameSource?: "published" | "local" | "runtime";
  /** The console's record for this agent, when it deployed it. */
  deployed?: DeployedDetail;
  /** The records scan rejected, so `records` is empty for a reason that is not an empty chain. */
  recordsUnread?: boolean;
  /** What the page folds into the header: the agent's rows and its two buttons. */
  children?: ReactNode;
}) {
  const chain = useChainVerification(id);
  const epochSteps = (epochs ?? []).reduce((n, e) => n + Number(e.endSeq - e.startSeq), 0);
  const unlisted = Number(state.seq) - records.length - epochSteps;
  const actions = useAgentActions(deployed);

  return (
    <Card tone="cyan" padding="none">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 pt-5">
        <div className="min-w-0">
          {/* No kind badge and no *name on chain* badge: this page is only ever an agent, and a
              registered name is the ordinary case. The badges here are the exceptions — a name that is
              not on chain, and an archived agent. */}
          {/* Drawn only when it has a badge: an empty row would push the name down. */}
          {(nameSource === "local" || deployed?.archivedAt) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {nameSource === "local" && <Badge tone="neutral">local note</Badge>}
              {deployed?.archivedAt && (
                <Badge
                  tone="warn"
                  title="Hidden from the console's lists and refusing new sessions. Its chain is untouched."
                >
                  archived
                </Badge>
              )}
            </div>
          )}
          <h1 className="truncate text-xl font-semibold tracking-tight text-ink-1 sm:text-2xl" data-testid="owner-name">
            {name ?? "Unnamed"}
          </h1>
          {deployed && <AgentConfigLine deployed={deployed} />}
          {/* Another wallet's agent says whose it is in one line, with the owner's key shortened. */}
          {deployed?.owner && !actions.isOwner && (
            <p className="mt-1 text-xs text-ink-3" data-testid="agent-owned-by">
              Owned by{" "}
              <Link href={`/authority/${deployed.owner}`} className="link-mono" title={deployed.owner}>
                {truncate(deployed.owner, 4, 4)}
              </Link>
            </p>
          )}
          {deployed && <Lineage deployed={deployed} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2" data-testid="chain-status">
            {chain.isLoading ? (
              <Badge tone="neutral">verifying chain…</Badge>
            ) : chain.data ? (
              // Four arms, worded in `chainBadge`: verified, verified *with gaps* (a compact event
              // or lost history the fold resumed across without recomputing), head not
              // reached, and broken.
              // The green arm reads _verified on Solana_: _to seq N_ is a number
              // a first-time reader cannot use, and the _On Solana_ row below gives the record count. The
              // words and the seq stay in the hover and in `data-seq`; the warning arms keep their text,
              // because there the seq is the finding.
              (() => {
                const b = chainBadge(chain.data);
                const short = b.tone === "good";
                return (
                  <span data-seq={chain.data.seq.toString()} className="inline-flex">
                    <Badge tone={b.tone} dot title={short ? `${b.text}: ${b.title}` : b.title}>
                      {short ? "verified on Solana" : b.text}
                    </Badge>
                  </span>
                );
              })()
            ) : (
              <Badge tone="warn">chain unreadable</Badge>
            )}
            <Info label="Agent details" wide testId="agent-details" triggerTestId="agent-details-toggle">
              <AgentFacts
                id={id}
                state={state}
                address={address}
                epochsFolded={chain.data ? chain.data.epochs.length : null}
                deployed={deployed}
              />
              {/* The note explains an *absence*, so it may only be said when the absence was read. */}
              {!recordsUnread && unlisted > 0 && (
                <p className="text-2xs leading-relaxed text-ink-3">
                  {/* "Record" is the event-record account (`["event", agent_id, seq]`). Saying these
                      operations "left no record" would read as not on chain. They are: each was a
                      transaction folded into the head, just not stored as its own account. So it says
                      where they are, not what they lack. */}
                  {unlisted} operation{unlisted === 1 ? " is" : "s are"} on chain through the header&apos;s hash only —
                  cell writes and compact actions, which are not kept as a record of their own or in an epoch. The chain
                  check covers them.
                </p>
              )}
              {/* The ⋯ menu has no ⓘ of its own: two ⓘ side by side read as one control drawn twice, so the header has one, and the owner's sentences on
                  what the menu does follow the ids. */}
              {actions.isOwner && <AgentActionsAbout actions={actions} />}
            </Info>
          </div>
          {actions.isOwner && <AgentActionsMenu actions={actions} />}
        </div>
      </div>

      {/* No Budget meter here: it would be the allowance section's own figure and bar a few pixels
          lower, so the page would say the budget twice. The _Budget_ row below has it, with its Change
          and expiry beside it. */}
      <div className="h-4" />

      {actions.isOwner && <AgentActionsStatus actions={actions} />}

      {/* The one note that stays on screen: a read that failed is a fact about this page, not a
          detail, and a rejecting scan leaves `records` empty for a reason a reader must see. */}
      {recordsUnread && (
        <div className="px-5 pb-5">
          <Note tone="warn">
            The records on this chain could not be read from the indexer, so what is listed below is not all of it. The
            header above is read from the account itself and still stands.
          </Note>
        </div>
      )}
      {children && <div className="border-t border-line/[0.08] px-5 py-5">{children}</div>}
      {!recordsUnread && !children && <div className="pb-1" />}
    </Card>
  );
}

/**
 * The header ids, one tap away, each tagged with
 * where it was read. The epochs and the live indicator join them, because both qualify the badge
 * rather than add to it.
 */
function AgentFacts({
  id,
  state,
  address,
  epochsFolded,
  deployed,
}: {
  id: string;
  state: AgentState;
  address: PublicKey;
  epochsFolded: number | null;
  deployed?: DeployedDetail;
}) {
  // The template version the record links to, here rather than under the name: "deployed from agent1
  // v1" under every agent's name is lineage a reader looks up, not reads. A copy names what it was
  // copied from instead (`Lineage`), so it gets
  // no row: the template's name is whichever agent first wrote those bytes.
  const template = deployed?.template && !deployed.clonedFrom ? deployed.template : null;
  return (
    <Facts
      testId="agent-facts"
      items={[
        { label: "Agent id", value: <Copyable value={id} display={truncate(id, 8, 8)} />, source: "chain" },
        {
          label: "Authority",
          value: (
            <span className="inline-flex items-center gap-1.5">
              <Link href={`/authority/${state.authority.toBase58()}`} className="link-mono">
                {truncate(state.authority.toBase58(), 6, 4)}
              </Link>
              <Copyable value={state.authority.toBase58()} display="" />
            </span>
          ),
          source: "chain",
        },
        {
          label: "Compressed address",
          value: <ExplorerLink kind="address" value={address.toBase58()} />,
          source: "chain",
        },
        {
          label: "Operations",
          value: (
            <span className="num">
              {state.seq.toString()} <span className="text-ink-3">seq</span>
            </span>
          ),
          source: "chain",
        },
        ...(epochsFolded !== null && epochsFolded > 0
          ? [{ label: "Epochs folded", value: <span className="num">{epochsFolded}</span>, source: "chain" as const }]
          : []),
        ...(template
          ? [
              {
                label: "Deployed from",
                value: (
                  <span data-testid="agent-template">
                    {deployed?.templateName ?? template.id} v{template.version}
                  </span>
                ),
                source: "console" as const,
              },
            ]
          : []),
        {
          label: "Following",
          value: <LiveIndicator id={id} fallback={<span className="text-ink-3">not watched here</span>} />,
        },
      ]}
    />
  );
}

/**
 * What the agent is, under its name: its model and its tools, in the wizard's words. Both are the
 * console's record (the chain commits a policy hash, not the list), so the line carries that source in
 * its hover.
 */
function AgentConfigLine({ deployed }: { deployed: DeployedDetail }) {
  const { model, tools } = deployed.policy;
  const names = tools.map(toolDisplayName);
  // The tools on a line of their own under the model, labelled: run on after the model they would read
  // as part of its name.
  return (
    <div
      className="mt-1 space-y-0.5 text-xs text-ink-3"
      data-testid="agent-config"
      data-source="console"
      title={SOURCE_TITLE.console}
    >
      <p className="font-mono text-ink-2">{model}</p>
      {names.length > 0 && (
        <p data-testid="agent-tools">
          Tools: <span className="text-ink-2">{names.join(", ")}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The wizard's name for a tool id; `lattice.verify_chain` is the id older policies commit for
 * _Chain Verification_.
 * The workspace's agent panel names an agent's tools by it too.
 */
export function toolDisplayName(id: string): string {
  const key = id === "lattice.verify_chain" ? "lath.verify_chain" : id;
  return [...CHAIN_READ_TOOLS, ...AVAILABLE_TOOLS].find((t) => t.id === key)?.name ?? id;
}

/**
 * Where this agent's configuration came from, under its name: the agent it was cloned from when it
 * was one, and when it was archived. Neither is a chain fact — the chain commits a policy hash per
 * session, not a template id — so this reads as lineage. The template version an ordinary deploy
 * links to is in the Agent details ⓘ (`agent-template`): it is on every agent's page and says nothing a
 * reader acts on, where a clone or an archive is the exception worth a line.
 *
 * A copy names only what it was copied from. Implicit templates dedupe by config hash, so
 * `templateName` is whichever agent *first* wrote those bytes — for a copy of somebody else's
 * agent that is a third party the owner has never seen, and putting its name first on the page reads
 * as a claim about where the copy came from. The template link is still there for the version check;
 * it is the *name* that has nothing to say here.
 *
 * A clone is the owner copying their own agent. A record of a copy launched off another wallet's
 * marketplace listing carries `clonedFrom.via: "market"`, and reads as *copied from*, with no market
 * badge and no listing seq or hash: the marketplace is on the roadmap, not in this build. A record
 * written without `via` reads as a clone, which is what it is.
 */
function Lineage({ deployed }: { deployed: DeployedDetail }) {
  const { clonedFrom, archivedAt } = deployed;
  if (!clonedFrom && !archivedAt) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3" data-testid="agent-lineage">
      {clonedFrom && (
        <span className="inline-flex items-center gap-1.5">
          {clonedFrom.via === "market" ? "copied from" : "cloned from"}{" "}
          {/^[0-9a-f]{64}$/i.test(clonedFrom.agentId ?? "") ? (
            <Link href={`/agent/${clonedFrom.agentId}`} className="link-mono">
              {clonedFrom.name}
            </Link>
          ) : (
            <span className="text-ink-2">{clonedFrom.name}</span>
          )}
        </span>
      )}
      {archivedAt && <span suppressHydrationWarning>archived {formatTimestampMs(archivedAt)}</span>}
    </div>
  );
}

/** The owner's actions and what they last said, shared by the ⋯ menu and the lines under the header. */
interface AgentActionsState {
  isOwner: boolean;
  deployed?: DeployedDetail;
  archived: boolean;
  /** A newer template version this agent could link to, or `null`. */
  newer: number | null;
  busy: Action | null;
  phase: string | null;
  error: string | null;
  note: string | null;
  run: (action: Action) => Promise<void>;
}

/**
 * Clone, archive, unarchive, and *use version n*, for the wallet that deployed this agent.
 *
 * Clone is a new name and therefore a new chain: `agent_id = sha256(name)`, so there is no such
 * thing as two agents with one name, and the copy shares only its configuration. It is **one
 * transaction and one prompt**, the shape the wizard's deploy has: the
 * server prepares funding, `register_agent` and `approve_agent` together, this signs once and
 * broadcasts, and `confirm` presents the ticket rather than a second signature. A `"Lath deploy"`
 * message alone would leave the copy registered, funded and with no allowance — its first session
 * refused, and no way to grant one from this page.
 *
 * Archive, unarchive and *use version n* sign `"Lath agent"`: they change a record and nothing
 * on chain. Archive asks first, because it stops the agent's loops and takes it out of every list;
 * unarchive is how it comes back.
 *
 * A hook, because the controls live in a ⋯ menu that closes when an item is
 * chosen: the progress and the answer are drawn under the header, where they stay mounted, and the
 * menu only starts them.
 */
function useAgentActions(deployed: DeployedDetail | undefined): AgentActionsState {
  const { publicKey, signMessage } = useWallet();
  const sendPrepared = useSendPrepared();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Action | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const isOwner = !!deployed && !!publicKey && !!deployed.owner && publicKey.toBase58() === deployed.owner;

  const archived = !!deployed?.archivedAt;
  // Not offered for an archived template. `useVersion` refuses one — it is the same stamp the
  // deploy route and `loopStartTemplate` refuse — so a button that led to a 409 *after*
  // the wallet had signed would be offering something the server has already decided against.
  // `templateArchived` is the newest version's stamp, and a new version un-archives
  // the id, so an archived latest means every version of it is put away.
  const newer =
    deployed?.template &&
    deployed.latestVersion &&
    deployed.latestVersion > deployed.template.version &&
    !deployed.templateArchived
      ? deployed.latestVersion
      : null;

  /** A record edit: one signed message, no transaction. */
  async function post(d: DeployedDetail, action: Action, extra: Record<string, unknown> = {}): Promise<any> {
    if (!signMessage) throw new Error("this wallet cannot sign messages, which this needs");
    const auth = await signAuth("Lath agent", {
      action,
      target: d.id.toLowerCase(),
      cluster: config.cluster,
      wallet: publicKey!.toBase58(),
      signMessage,
    });
    if (!auth) throw new Error("the message was not signed");
    const res = await fetch(`/api/agents/${d.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra, auth }),
    });
    const answer = await res.json();
    if (!res.ok) throw new Error(answer.error ?? `the server refused (${res.status})`);
    return answer;
  }

  /**
   * The clone, as one transaction: prepare, one signature, confirm by ticket. The allowance is
   * inside the transaction being signed, so the copy can spend from the moment it exists.
   */
  async function clone(d: DeployedDetail, name: string) {
    setPhase("preparing the transaction");
    const prep = await fetch(`/api/agents/${d.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clone", name, prepare: true, wallet: publicKey!.toBase58() }),
    });
    const prepared = await prep.json();
    if (!prep.ok) throw new Error(prepared.error ?? `the server refused the clone (${prep.status})`);

    // The server computes a clone's grant from the config it copies, so the page holds the grant
    // to what the answer reported and bounds it by this agent's own terms as the page has them:
    // a cap or an expiry past those is not a copy of this agent, whatever the answer says.
    const expect = copyGrantExpectation(prepared, d.policy);
    if (typeof expect === "string") throw new Error(expect);

    setPhase("waiting for your signature");
    const sent = await sendPrepared(prepared.transaction, prepared.lastValidBlockHeight, expect);

    // The ticket, not a second signature: one clone asks the wallet once, and the server proves
    // that wallet signed by reading the transaction back off the chain. Presented until the chain
    // has answered — the transaction has landed by now, and on devnet the compressed account it
    // wrote is routinely a beat behind it — and presented too when this browser could not read
    // whether it landed (`sent.landed` false).
    setPhase("recording the clone");
    try {
      return await confirmPrepared(
        `/api/agents/${d.id}`,
        { confirm: sent.signature, ticket: prepared.ticket },
        {
          onWaiting: (n, of) =>
            setPhase(
              sent.landed
                ? `the clone landed; waiting for the indexer (try ${n} of ${of})`
                : `the clone was sent; asking the console whether it landed (try ${n} of ${of})`
            ),
        }
      );
    } catch (err: any) {
      throw unrecordedWriteError(err, sent, "copy");
    }
  }

  async function run(action: Action) {
    // One slot for every action. A button that read only its *own* name out of it would stay live
    // during another's run (`Button` disables on `loading` alone), so pressing Archive during a clone
    // would overwrite `busy`, the clone's spinner would vanish, *Clone* would go live again, and a
    // second `window.prompt` plus a second `signTransaction` would be one click away, against a claim
    // of one prompt per action; whichever finished first would clear the flag and wipe the other's
    // progress.
    // The guard below is belt to the menu's braces: a queued click cannot get past either.
    if (busy || !deployed || !isOwner) return;
    const d = deployed;
    setError(null);
    setNote(null);
    // A clone needs a name of its own, and the owner is the only one who knows what it is for.
    const name = action === "clone" ? window.prompt("A name for the clone", `${d.name}-2`) : null;
    if (action === "clone" && !name) return;
    // Archive stops this agent's loops and takes it out of every list. It is undoable, and it still
    // asks: a destructive-looking button that fires on one click is the surprise, and the
    // confirm is where the loops it will stop get said out loud.
    if (
      action === "archive" &&
      !window.confirm(
        `Archive ${d.name}? Any loop on it is stopped and it leaves the lists. You can unarchive it again.`
      )
    )
      return;
    setBusy(action);
    try {
      const answer =
        action === "clone"
          ? await clone(d, name!)
          : await post(d, action, action === "useVersion" ? { version: newer } : {});
      await queryClient.invalidateQueries({ queryKey: agentRecordKey(d.id) });
      await queryClient.invalidateQueries({ queryKey: ["agents-registry"] });
      if (action === "clone") router.push(`/agent/${answer.id}`);
      else setNote(answer.note ?? null);
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setBusy(null);
      setPhase(null);
    }
  }

  return { isOwner, deployed, archived, newer, busy, phase, error, note, run };
}

/** One entry of the ⋯ menu. `testId` is the handle the specs address that control by. */
interface MenuItem {
  label: string;
  testId: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * The owner's actions as a ⋯ menu: a button with `aria-haspopup="menu"` that opens a `role="menu"`
 * list of the same four controls, keyboard first. Enter, Space or ArrowDown on
 * the button opens it on the first item; ArrowUp and ArrowDown, Home and End move through the
 * items; Escape closes it and returns focus to the button; Tab or a pointer outside closes it. The
 * list is drawn at `document.body`, as `Info`'s popover is, because the header card clips what
 * overflows it.
 *
 * Choosing an item closes the menu before the action starts, so a `window.prompt` or the wallet's
 * own window never opens over a menu that is still drawn. What the action says back is drawn under
 * the header (`AgentActionsStatus`).
 */
function AgentActionsMenu({ actions }: { actions: AgentActionsState }) {
  const { archived, newer, busy, run } = actions;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Which item takes focus when the menu opens: the first by default, the last on ArrowUp.
  const focusOnOpen = useRef<"first" | "last">("first");
  const working = busy !== null;

  const items: MenuItem[] = [
    { label: "Clone", testId: "agent-clone", onSelect: () => void run("clone"), disabled: working },
    ...(newer
      ? [
          {
            label: `Use version ${newer}`,
            testId: "agent-use-version",
            onSelect: () => void run("useVersion"),
            disabled: archived || working,
          },
        ]
      : []),
    archived
      ? { label: "Unarchive", testId: "agent-unarchive", onSelect: () => void run("unarchive"), disabled: working }
      : {
          label: "Archive",
          testId: "agent-archive",
          onSelect: () => void run("archive"),
          disabled: working,
          danger: true,
        },
  ];

  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  // Placed under the button, right edges aligned, and kept there on scroll and resize.
  useEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      setStyle({
        position: "fixed",
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
        zIndex: 60,
        minWidth: 200,
      });
    };
    place();
    const focus = requestAnimationFrame(() => {
      const list = menuItems();
      (focusOnOpen.current === "last" ? list[list.length - 1] : list[0])?.focus();
    });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Escape from anywhere, not only from an item: while an action runs every item is disabled, so
    // focus may never have entered the list for its own handler to hear the key.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(focus);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusOnOpen.current = e.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = menuItems();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(at < 0 ? list.length - 1 : at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(list.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const menuId = `${id}-menu`;
  return (
    <div className="flex items-center gap-1.5">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Agent actions"
        title="Agent actions"
        data-testid="agent-actions-menu"
        onClick={() => {
          focusOnOpen.current = "first";
          setOpen((o) => !o);
        }}
        onKeyDown={onButtonKey}
        className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-line/[0.12] bg-surface-3 px-2 text-sm font-semibold text-ink-1 transition-colors hover:border-line/[0.2] hover:bg-surface-3/80 aria-expanded:border-accent/40"
      >
        {working ? <Spinner /> : <span aria-hidden>⋯</span>}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Agent actions"
            onKeyDown={onMenuKey}
            data-testid="agent-actions-list"
            style={style ?? { position: "fixed", top: 0, right: 0, visibility: "hidden", zIndex: 60 }}
            className="surface animate-rise bg-surface-2 p-1 shadow-float"
          >
            {items.map((item) => (
              <button
                key={item.testId}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                data-testid={item.testId}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
                className={`flex w-full items-center rounded-md px-3 py-2 text-left text-xs font-medium transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
                  item.danger
                    ? "text-rose-300 hover:bg-rose-400/10 focus-visible:bg-rose-400/10"
                    : "text-ink-1 hover:bg-line/[0.06] focus-visible:bg-line/[0.06]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

/**
 * What the ⋯ menu's items do, in the Agent details ⓘ, in two sentences. The menu has no ⓘ of its own
 * beside it: the header keeps one.
 */
function AgentActionsAbout({ actions }: { actions: AgentActionsState }) {
  const { newer, deployed } = actions;
  return (
    <div className="space-y-2 border-t border-line/[0.08] pt-2" data-testid="agent-actions-info">
      <p className="text-2xs leading-relaxed text-ink-3">
        A clone is one transaction: the new agent&apos;s registration and the allowance your wallet signs for, together,
        so the copy can spend from the moment it exists.
      </p>
      {newer && (
        <p className="text-2xs leading-relaxed text-ink-3">
          v{newer} of this template is newer than the v{deployed?.template?.version} this agent links to. Linking to it
          changes what the <em>next</em> session commits as its policy version hash; a version that only moved the
          budget cap or the expiry commits the same hash as before, so nothing on chain changes at all.
        </p>
      )}
    </div>
  );
}

/** What the last action said, under the header, where it outlives the menu that started it. */
function AgentActionsStatus({ actions }: { actions: AgentActionsState }) {
  const { phase, note, error } = actions;
  const any = !!phase || !!note || !!error;
  if (!any) return null;
  return (
    <div className="space-y-2 border-t border-line/[0.08] px-5 py-4" data-testid="agent-actions-status">
      {phase && !error && <p className="text-2xs text-ink-3">{phase}…</p>}
      {note && <Note>{note}</Note>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/**
 * Whether this page is actually following its chain, said plainly.
 *
 * It renders nothing unless a watch is mounted for this owner (`useOwnerWatch`), because an
 * unwatched page is not live and must not say it is. "checked Ns ago" comes from the last
 * *successful* header read, so a poll that starts failing shows itself by the number climbing
 * rather than by the badge continuing to promise freshness.
 */
function LiveIndicator({ id, fallback = null }: { id: string; fallback?: ReactNode }) {
  const live = useLiveStatus(id);
  if (!live) return <>{fallback}</>;

  const label = live.paused
    ? "paused"
    : live.flash
    ? "updated"
    : live.checkedAgo === null
    ? "live"
    : `live · checked ${live.checkedAgo}s ago`;

  return (
    <span className="inline-flex items-center gap-1.5 text-2xs text-ink-3" data-testid="live-status">
      <span
        className={`h-1.5 w-1.5 rounded-full ${live.paused ? "bg-ink-3" : live.flash ? "bg-accent" : "bg-accent/50"}`}
        aria-hidden
      />
      {label}
    </span>
  );
}
