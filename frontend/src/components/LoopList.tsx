"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { Badge, Button, Copyable } from "@/components/ui";
import { LOOP_STOP_REASON_TEXT } from "@/types/loop";
import { REBUILT_TITLE, chainRebuilt } from "@/lib/chain-records";
import { truncate } from "@/lib/format";
import { explainError } from "@/lib/writes";
import { LoopView, loopKeys, postLoop, useLoopAction, useRunAgain } from "@/lib/loops";

/**
 * The badge's words for the four stops a loop's Tempo access key causes (`LOOP_STOP_REASON_TEXT` has
 * the sentences). `tests/loop-status-neutral.ts` holds the keys to every `tempo-key-*` code there.
 */
const TEMPO_KEY_STOP_LABEL: Record<string, string> = {
  "tempo-key-limit": "Tempo limit reached",
  "tempo-key-expired": "Tempo key expired",
  "tempo-key-missing": "Tempo key missing",
  "tempo-key-refused": "Tempo key refused",
};

/** The badge a loop's status earns. `stepping` outranks the rest: it is the thing happening now. */
export function LoopStatusBadge({ loop }: { loop: LoopView }) {
  if (loop.stepping)
    return (
      <Badge tone="cyan" dot pulse>
        running
      </Badge>
    );
  // A gated run between steps is not idle: every poll asks Jev whether what changed needs a step.
  if (loop.status === "running" && loop.trigger?.kind === "gate")
    return <Badge tone="blue">waiting for the decision model</Badge>;
  // Between steps a running loop is waiting for its next one, and a paused one for its owner: both
  // blue, the spine's waiting. Green is a step that ran, never a loop's state.
  if (loop.status === "running") return <Badge tone="blue">running</Badge>;
  if (loop.status === "paused") return <Badge tone="blue">paused</Badge>;
  // A run stopped because its writes would not land is not a run that failed: its step ran and
  // its output is in the trace store, and what is missing is the transactions. So it reads as
  // *not anchored* and not as an error, and the way out of it is Retry the step.
  if (loop.stopReason === "anchor-failed")
    return (
      <Badge tone="warn" title={loop.stopDetail ?? "the step ran; its chain writes did not land"}>
        not anchored
      </Badge>
    );
  // A run that reached its goal finished, and finished early: it says so rather than *finished*,
  // because the number of steps it took is not the thing that ended it. Neutral like `max-steps` —
  // neither is a failure.
  // Worded *completed*: the run did what it was started for, which is the word a person reads it by;
  // the hover keeps the reason's own words.
  if (loop.stopReason === "goal-reached")
    return (
      <Badge tone="volt" title={LOOP_STOP_REASON_TEXT["goal-reached"] ?? loop.stopDetail ?? undefined}>
        completed
      </Badge>
    );
  const done = loop.stopReason === "max-steps";
  // `stopped` is the reason an owner's own Stop writes: a decision, not a fault, and printing it
  // after the status would make the badge read *stopped: stopped*.
  if (loop.stopReason === "stopped")
    return (
      <Badge tone="neutral" title={loop.stopDetail ?? "its owner stopped this run"}>
        stopped
      </Badge>
    );
  // A run a second model stopped is not a run that broke, and *stopped: escalated* alone reads
  // as a code. The hover is the sentence `LOOP_STOP_REASON_TEXT` holds — the same words the run's
  // own page prints — rather than a `stopDetail` the runner wrote for a log.
  const title = (loop.stopReason && LOOP_STOP_REASON_TEXT[loop.stopReason]) ?? loop.stopDetail ?? undefined;
  // A run that drew its one budget down did what its owner set it to, and a
  // run with no recorded reason has nothing to blame: both grey, as the spine draws them
  // (`NEUTRAL_STOPS` in `LoopSpine.tsx`). Rose is kept for a stop that is a fault.
  if (loop.stopReason === "budget" || !loop.stopReason)
    return (
      <Badge tone="neutral" title={title}>
        {loop.stopReason ? "budget spent" : "stopped"}
      </Badge>
    );
  // A stop the loop's Tempo access key caused is grey for the same reason (`NEUTRAL_STOPS`): Tempo
  // refusing past the key's limit is the cap working, and the other three stop at a step boundary
  // rather than pay without the key. Worded rather than *stopped: tempo-key-limit*, a code; the hover
  // is the sentence the loop page's note prints.
  const keyStop = loop.stopReason ? TEMPO_KEY_STOP_LABEL[loop.stopReason] : undefined;
  if (keyStop)
    return (
      <Badge tone="neutral" title={title}>
        {keyStop}
      </Badge>
    );
  return (
    <Badge tone={done ? "neutral" : "bad"} title={title}>
      {done ? "finished" : `stopped: ${loop.stopReason}`}
    </Badge>
  );
}

/** *from ‹template› v‹n›* — the run's lineage, wherever a loop is named. */
export function TemplateLine({ loop, className = "" }: { loop: LoopView; className?: string }) {
  if (!loop.template) return null;
  return (
    <span className={`text-2xs text-ink-3 ${className}`} data-testid="loop-template">
      from <Copyable value={loop.template.id} display={truncate(loop.template.id, 8, 4)} /> v{loop.template.version}
    </span>
  );
}

/**
 * *Run again*: a new run from the template version this one came from.
 *
 * A run is produced once and never revived, so this is a start, not a resume — a new loop id
 * with its own history, from the same config. It lands on the new loop's page, because that is
 * the run being watched from here on. A row with no template (recorded before templates
 * existed) has nothing to start from and says so.
 */
export function RunAgainButton({ loop, size = "md" }: { loop: LoopView; size?: "sm" | "md" }) {
  const { publicKey, signMessage } = useWallet();
  const again = useRunAgain(publicKey ?? null, signMessage);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  if (!publicKey || publicKey.toBase58() !== loop.owner) return null;
  // Only on a stopped run, as the run panel draws it (`LoopSpine.tsx`): a running or paused run is
  // still the one being watched, and a second run beside it on the same terms is a second budget
  // nobody asked for. Here rather than at each call site, so the loop page and the agent's loop card
  // cannot offer it where the panel does not.
  if (loop.status !== "stopped") return null;
  // Not offered on a run whose writes are owed. The work of its last step is done and is in the
  // trace store; a new run would pay for it a second time and leave the first one's records in
  // the journal for good. *Retry the step* is the action for that state, and it is the only one.
  if (loop.stopReason === "anchor-failed") return null;
  // Not on an Improve's arm either, a row that carries `trial` (Improve is on the roadmap): the run to
  // repeat is the source, not a trial on the Improve's 10 s interval.
  if (loop.trial) return null;

  async function run() {
    if (!loop.template) return;
    setError(null);
    setStartedId(null);
    try {
      // The version, not just the id: *Run again* means this run's terms, and the template may
      // have been edited since. A new version is *Edit and run*, which is a different button.
      const started = await again.mutateAsync({ templateId: loop.template.id, version: loop.template.version });
      setStartedId(started.id);
      await queryClient.invalidateQueries({ queryKey: ["loops"] });
      router.push(`/loop/${started.id}`);
    } catch (e: any) {
      setError(explainError(e));
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size={size}
        loading={again.isPending}
        disabled={!loop.template}
        title={
          loop.template
            ? "Start a new run from this loop's template: same terms, new id, its own history"
            : "This run predates templates, so there is no config to start again from"
        }
        onClick={run}
        testId="loop-run-again"
      >
        Run again
      </Button>
      {/* A start fetches every source again and opens a channel before it answers — 25–30 s on
          devnet, long enough that a spinner alone reads as nothing happening. And the new run's
          link, in case the move to its page does not happen. */}
      {again.isPending && (
        <span className="text-2xs text-ink-3">
          Starting a new run on this run&apos;s terms and sources: fetching the sources again, about 30 s.
        </span>
      )}
      {startedId && (
        <Link href={`/loop/${startedId}`} className="link-mono text-2xs" data-testid="loop-run-again-started">
          {startedId}
        </Link>
      )}
      {error && <span className="text-2xs text-rose-300">{error}</span>}
    </span>
  );
}

/**
 * *Retry the step*: send the records this run built and could not land, then put it back on its
 * schedule.
 *
 * Only for a run stopped with `anchor-failed`, and deliberately not a *Run again*: the step's
 * session has already happened and its blobs are in the trace store, so what is owed is the
 * transactions, not the work. The server re-queues them under the head check, so a record that
 * landed and only lost its confirmation is not written twice. A retry that fails again answers
 * 409 and the run stays exactly as it was — stopped, journal intact, retriable later.
 */
export function RetryStepButton({ loop, size = "md" }: { loop: LoopView; size?: "sm" | "md" }) {
  const { publicKey, signMessage } = useWallet();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: async () => {
      if (!publicKey) throw new Error("connect a wallet to retry this run's writes");
      return postLoop({ action: "retry", id: loop.id }, publicKey, signMessage);
    },
  });
  // Also for a finished run whose settlement record is still owed: its own write can fail on a
  // healthy chain, and Retry is what writes it — without putting the run back on its
  // schedule, which only an `anchor-failed` stop gets.
  const recordOwed = loop.status === "stopped" && loop.tempo?.recordOwed === true;
  if (loop.stopReason !== "anchor-failed" && !recordOwed) return null;
  if (!publicKey || publicKey.toBase58() !== loop.owner) return null;

  async function run() {
    setError(null);
    try {
      await retry.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: loopKeys.one(loop.id) });
      await queryClient.invalidateQueries({ queryKey: ["loops"] });
    } catch (e: any) {
      setError(explainError(e));
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size={size}
        loading={retry.isPending}
        // Disabled on a row rebuilt from the chain: its journal is the other console's, so this one has
        // nothing to send (`LoopControls` says the same of Pause and Stop).
        disabled={chainRebuilt(loop.chain)}
        title={
          chainRebuilt(loop.chain)
            ? REBUILT_TITLE
            : "Send this run's unanchored records again. Nothing is re-run: the step already happened"
        }
        onClick={run}
        testId="loop-retry-step"
      >
        Retry the step
      </Button>
      {error && <span className="text-2xs text-rose-300">{error}</span>}
    </span>
  );
}

/**
 * *Discard*: give up the writes a diverged run still owes.
 *
 * Offered only after a Retry answered _head diverged_ (`anchorDiverged`), because before that
 * Retry is the answer and this would throw away records that can still land. The server checks
 * the chain again and refuses anything a Retry could land, so the flag decides what is shown and
 * never what is allowed. It asks first: what it drops is the step's records and the charge they
 * carried, and nothing brings them back.
 */
export function DiscardAnchorButton({ loop, size = "md" }: { loop: LoopView; size?: "sm" | "md" }) {
  const { publicKey, signMessage } = useWallet();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const discard = useMutation({
    mutationFn: async () => {
      if (!publicKey) throw new Error("connect a wallet to discard this run's writes");
      return postLoop({ action: "discard", id: loop.id }, publicKey, signMessage);
    },
  });
  if (loop.stopReason !== "anchor-failed" || !loop.anchorDiverged) return null;
  if (!publicKey || publicKey.toBase58() !== loop.owner) return null;

  async function run() {
    if (
      !window.confirm(
        "Discard this run's unanchored records? They and the step's charge will never reach the chain. " +
          "The model calls were already paid from the operator's treasury."
      )
    )
      return;
    setError(null);
    try {
      await discard.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: loopKeys.one(loop.id) });
      await queryClient.invalidateQueries({ queryKey: ["loops"] });
    } catch (e: any) {
      setError(explainError(e));
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size={size}
        loading={discard.isPending}
        disabled={chainRebuilt(loop.chain)}
        title={
          chainRebuilt(loop.chain)
            ? REBUILT_TITLE
            : "Drop the records this run could not land: the chain has moved where they never can"
        }
        onClick={run}
        testId="loop-discard-anchor"
      >
        Discard
      </Button>
      {error && <span className="text-2xs text-rose-300">{error}</span>}
    </span>
  );
}

/**
 * *Archive*: stop the run and take it out of the lists. *Unarchive*: put it back.
 *
 * Not a delete. The record, its steps and its page stay — an archived loop still answers on `?id=`,
 * so every audit link into it keeps working — and there is a verb that undoes it, so one click never
 * stops a running loop, hides it from every list and leaves no button that touches it, which is what
 * a delete looks like from the outside.
 *
 * Archive asks first, because it stops a run that may be mid-schedule. Unarchive does not: it
 * restores a record and starts nothing. The run stays stopped — a run is produced once and never
 * revived, and *Run again* is how a stopped run gets a successor.
 */
export function ArchiveLoopButton({ loop, size = "md" }: { loop: LoopView; size?: "sm" | "md" }) {
  const { publicKey, signMessage } = useWallet();
  const action = useLoopAction(publicKey ?? null, signMessage);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  if (!publicKey || publicKey.toBase58() !== loop.owner) return null;

  const archived = !!loop.archivedAt;

  async function run() {
    setError(null);
    if (
      !archived &&
      !window.confirm(
        loop.status === "running" || loop.status === "paused"
          ? `Archive this run? It is ${loop.status}, so it is stopped first and leaves the lists. You can unarchive it again.`
          : "Archive this run? It leaves the lists; its page and its steps stay. You can unarchive it again."
      )
    )
      return;
    try {
      await action.mutateAsync({ id: loop.id, action: archived ? "unarchive" : "archive" });
      await queryClient.invalidateQueries({ queryKey: loopKeys.one(loop.id) });
      await queryClient.invalidateQueries({ queryKey: ["loops"] });
    } catch (e: any) {
      setError(explainError(e));
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="ghost"
        size={size}
        loading={action.isPending}
        title={
          archived
            ? "Put this run back in the lists. It stays stopped; Run again is how a stopped run gets a successor"
            : "Stop this run if it is running and take it out of the lists; nothing is deleted"
        }
        onClick={run}
        testId={archived ? "loop-unarchive" : "loop-archive"}
      >
        {archived ? "Unarchive" : "Archive"}
      </Button>
      {error && <span className="text-2xs text-rose-300">{error}</span>}
    </span>
  );
}
