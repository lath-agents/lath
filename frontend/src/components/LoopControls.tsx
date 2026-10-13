"use client";

import { ReactNode, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { Button, ErrorNote } from "@/components/ui";
import { explainError } from "@/lib/writes";
import { REBUILT_TITLE, chainRebuilt } from "@/lib/chain-records";
import { LoopView, loopKeys, useLoopAction } from "@/lib/loops";

/**
 * Pause, resume and stop, for the wallet that owns the loop.
 *
 * Each is a signed `"Lath loop"` message, because each changes what the server will spend on
 * this wallet's behalf. A step already in flight is never interrupted: the scheduler lets it
 * finish and write its checkpoint, so the chain never carries half a step — the button says so
 * rather than pretending the loop stopped mid-write.
 *
 * `children` are the page's other buttons for the run (Run again, Retry, Compose, Archive),
 * set in the same row after Stop so a run has one row of actions. Each renders nothing for a
 * wallet it does not apply to, and a stranger still gets the row, under the note.
 */
export function LoopControls({ loop, children }: { loop: LoopView; children?: ReactNode }) {
  const { publicKey, signMessage } = useWallet();
  const action = useLoopAction(publicKey ?? null, signMessage);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const isOwner = !!publicKey && publicKey.toBase58() === loop.owner;

  async function run(which: "pause" | "resume" | "stop") {
    setError(null);
    try {
      await action.mutateAsync({ id: loop.id, action: which });
      await queryClient.invalidateQueries({ queryKey: loopKeys.one(loop.id) });
      await queryClient.invalidateQueries({ queryKey: ["loops"] });
    } catch (e: any) {
      setError(explainError(e));
    }
  }

  if (!isOwner) {
    return (
      <div className="space-y-3">
        {/* One muted line, not a box: it is a fact about who may press, not news. */}
        <p className="text-2xs text-ink-3" data-testid="loop-not-owner">
          Owned by <span className="font-mono">{loop.owner.slice(0, 8)}…</span>: anyone can check its steps against the
          chain, and only its owner&apos;s wallet can pause or stop it.
        </p>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    );
  }

  const finished = loop.status === "stopped";
  // A row rebuilt from the chain by a console that did not start the run: nothing here schedules it and
  // the server refuses its controls, so they stay in their places, disabled, with the reason on hover,
  // rather than asking for a signature to answer with an error.
  const readOnly = chainRebuilt(loop.chain);
  const readOnlyTitle = readOnly ? REBUILT_TITLE : undefined;
  return (
    <div className="space-y-3">
      {/* Centred: every button's explanation is its hover text, so the row is one line of buttons of
        one height. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* An Improve's arm, a row that carries `trial`, ran when its Improve said (Improve is on the
          roadmap): Pause and Resume are not offered on it. A stopped
          run offers neither Resume nor Stop: it never steps again, and two disabled
          buttons at the head of the row read as controls that might come back. Its row is what can
          still be done with it. */}
        {finished ? null : loop.trial ? null : loop.status === "running" ? (
          <Button
            variant="secondary"
            loading={action.isPending}
            disabled={readOnly}
            title={readOnlyTitle}
            onClick={() => run("pause")}
            testId="loop-pause"
          >
            Pause
          </Button>
        ) : (
          <Button
            variant="secondary"
            loading={action.isPending}
            disabled={readOnly || loop.steps >= loop.maxSteps}
            title={readOnlyTitle}
            onClick={() => run("resume")}
            testId="loop-resume"
          >
            Resume
          </Button>
        )}
        {!finished && (
          <Button
            variant="danger"
            loading={action.isPending}
            disabled={readOnly}
            title={readOnlyTitle}
            onClick={() => run("stop")}
            testId="loop-stop"
          >
            Stop
          </Button>
        )}
        {children}
        {loop.stepping && (
          <span className="text-2xs text-ink-3">A step is running; it will finish before it stops.</span>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
