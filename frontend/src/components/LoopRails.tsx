"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ExplorerLink } from "@/components/ui";
import { OpenRouterMark, SolanaMark, TempoLink, TempoMark } from "@/components/Tempo";
import { moneyFlowFigures, usdcEOfBase } from "@/lib/tempo-services";
import { TempoCheckItYourself } from "@/components/LoopTempoServices";
import type { LoopView } from "@/lib/loops";

/**
 * Lath's two rails for one run, side by side under the money flow: the two things a judge should see
 * first. Solana: the records this run wrote on its agent's chain and the
 * checkpoint each step closed with. Tempo: what OpenRouter was paid for the agent's model calls, on the
 * loop's own channel. Every figure is one the page already holds (the row's history, its chain records,
 * `moneyFlowFigures`); the call-by-call pairing of the two is the table under the steps.
 */
export function LoopRails({ loop }: { loop: LoopView }) {
  const checkpoints = loop.history.filter((h) => !!h.seq);
  const leavesOk = checkpoints.filter((h) => h.leafOk === true).length;
  const lastCheckpoint = [...checkpoints].reverse().find((h) => !!h.signature);
  const records = loop.chain?.records ?? [];
  const start = records.find((r) => r.tool === "loop.start");
  // The run's span on its agent's chain: from its start record to the newest seq the row knows (a step's
  // checkpoint, or the stop and settlement after it). One running loop per agent, so the span is this run's.
  const seqs = [...records.map((r) => r.seq), ...checkpoints.map((h) => h.seq!), loop.lastSeq ?? undefined]
    .filter((s): s is string => typeof s === "string" && /^\d+$/.test(s))
    .map((s) => BigInt(s));
  const first = start && /^\d+$/.test(start.seq) ? BigInt(start.seq) : null;
  const last = seqs.length ? seqs.reduce((a, b) => (b > a ? b : a)) : null;
  const span = first !== null && last !== null && last >= first ? Number(last - first + BigInt(1)) : null;

  const flow = moneyFlowFigures(loop);
  const model = flow.model > BigInt(0) ? usdcEOfBase(flow.model) : null;
  const decisions = flow.decisions > BigInt(0) ? usdcEOfBase(flow.decisions) : null;

  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="loop-rails">
      <Rail
        testId="loop-rails-solana"
        mark={<SolanaMark size={16} />}
        name="Solana"
        what="every action is a record"
        figure={
          span !== null ? (
            <>
              {span} <span className="text-sm font-normal text-ink-2">records on the agent&apos;s chain</span>
            </>
          ) : checkpoints.length ? (
            <>
              {checkpoints.length} <span className="text-sm font-normal text-ink-2">step checkpoints</span>
            </>
          ) : (
            <span className="text-sm font-normal text-ink-2">no record yet</span>
          )
        }
        lines={[
          ...(span !== null && first !== null && last !== null
            ? [`seq ${first} → ${last}, each folded into the chain's head`]
            : []),
          ...(checkpoints.length
            ? [
                `${checkpoints.length} step checkpoint${
                  checkpoints.length === 1 ? "" : "s"
                }, ${leavesOk} matched by the console`,
              ]
            : []),
          "every model call is an Action record that commits its Tempo payment",
        ]}
        links={[
          <Link key="chain" href={`/agent/${loop.agentId}`} className="link" data-testid="loop-rails-agent">
            the agent&apos;s chain
          </Link>,
          ...(start?.signature
            ? [
                <ExplorerLink key="start" kind="tx" value={start.signature}>
                  start
                </ExplorerLink>,
              ]
            : []),
          ...(lastCheckpoint?.signature
            ? [
                <ExplorerLink key="last" kind="tx" value={lastCheckpoint.signature}>
                  last checkpoint
                </ExplorerLink>,
              ]
            : []),
        ]}
      />
      <Rail
        testId="loop-rails-tempo"
        mark={<TempoMark />}
        name="Tempo"
        what="every model call is paid"
        figure={
          flow.scripted ? (
            <span className="text-sm font-normal text-ink-2">not paid: the steps ran scripted</span>
          ) : model ? (
            <>
              {model}{" "}
              <span className="inline-flex items-center gap-1 text-sm font-normal text-ink-2">
                to <OpenRouterMark /> OpenRouter
              </span>
            </>
          ) : (
            <span className="text-sm font-normal text-ink-2">no model call paid yet</span>
          )
        }
        lines={[
          ...(flow.paidSteps
            ? [
                `over ${flow.paidSteps} step${
                  flow.paidSteps === 1 ? "" : "s"
                }, each call a voucher on the loop's channel`,
              ]
            : []),
          flow.state === "settled"
            ? "the channel is closed and settled on Tempo"
            : flow.state === "open"
            ? "the channel is open and pays call by call"
            : "a channel opens with the first paid call",
          ...(decisions ? [`${decisions} for the decision model, paid by Lath`] : []),
        ]}
        links={[
          ...(flow.payer
            ? [<TempoLink key="payer" kind="address" value={flow.payer} label="treasury" testId="loop-rails-payer" />]
            : []),
          ...(flow.settleTx
            ? [<TempoLink key="settle" kind="tx" value={flow.settleTx} label="settled" testId="loop-rails-settled" />]
            : []),
        ]}
        // The `lath-audit verify-channel` line that checks this box from a clone, once there is a payment
        // to check: every voucher the chain committed against what the channel settled on Tempo.
        footer={flow.paidSteps > 0 && !flow.scripted ? <TempoCheckItYourself loop={loop} /> : undefined}
      />
    </div>
  );
}

function Rail({
  testId,
  mark,
  name,
  what,
  figure,
  lines,
  links,
  footer,
}: {
  testId: string;
  mark: ReactNode;
  name: string;
  what: string;
  figure: ReactNode;
  lines: string[];
  links: ReactNode[];
  footer?: ReactNode;
}) {
  return (
    <div className="well space-y-2 px-4 py-3" data-testid={testId}>
      <div className="flex items-center gap-2 text-xs font-medium text-ink-1">
        {mark}
        {name}
        <span className="font-normal text-ink-3">· {what}</span>
      </div>
      <div className="num text-xl text-ink-1" data-testid={`${testId}-figure`}>
        {figure}
      </div>
      <ul className="space-y-0.5 text-2xs leading-relaxed text-ink-3">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {links.length > 0 && <div className="flex flex-wrap items-center gap-3 text-2xs">{links}</div>}
      {footer}
    </div>
  );
}
