"use client";

/**
 * The client half of `/api/run`, shared by everything that runs a session: the message the
 * wallet signs, the SSE parser, the shapes the stream carries, and the one-line-per-chain-write
 * renderer. Two screens use it — the chat on an owner's page and the console — and they must
 * agree byte for byte with the server on the signed message, so it is written once.
 */
import { useQuery } from "@tanstack/react-query";
import type { AuthBinding, AuthPurpose, EpochFlushTrigger } from "@lath/sdk/browser";
import { authMessage } from "@lath/sdk/browser";
import { Badge, Copyable, ExplorerLink } from "@/components/ui";
import { formatUsdc, truncate } from "@/lib/format";
import { parseSseBlock } from "@/lib/loop-start-stream";

/** What `GET /api/run` says about the server's runtime. */
export interface RunnerInfo {
  ready: boolean;
  reason?: string;
  cluster?: string;
  programId?: string;
  epochs?: boolean;
  authority?: string;
  balanceSol?: number;
  /** Where epoch blobs are anchored; on Irys, the uploader's second balance (`_lib/runner.ts`). */
  traceBackend?:
    | { kind: "fs"; dir: string; scheme: number; encoding: "hex" }
    | {
        kind: "irys";
        network: "devnet" | "mainnet";
        node: string;
        gateway: string;
        scheme: number;
        encoding: "base64url";
        uploader: string | null;
        balanceSol: number | null;
        error: string | null;
      };
  inference?: "openrouter" | "scripted";
  inferenceNote?: string | null;
  signedSessions?: { model: "openrouter" | "scripted"; anonymous: "scripted"; windowMs: number };
  sessionCapUsdc?: number;
  maxSteps?: number;
  agents?: { role: string; name: string; id: string; authority: string }[];
  /** Only present for `GET /api/run?agent=<hex>`: can this server write that chain? */
  target?: {
    id: string;
    name: string | null;
    kind: "agent" | null;
    authority: string | null;
    operated: boolean;
    policy: { model: string; tools: string[]; budgetCapUsdc: string; expirationDays: number } | null;
    source: "console" | "deployed" | null;
    /** The wallet that deployed it; only its signature runs a deployed agent. */
    owner?: string | null;
  } | null;
}

/**
 * What a record's anchor is doing. Three states and no fourth:
 * `failed` says the blockchain write failed after three attempts — never that the answer was
 * lost, which is in the trace store either way.
 */
export type AnchorState = "pending" | "verified" | "failed";

/** A `runtime` event with `type: "anchor"`: one transition of one journaled record. */
export interface AnchorEventData {
  agentId: string;
  agentName?: string;
  id: string;
  kind: "event" | "charge" | "epoch";
  state: AnchorState;
  seq?: string;
  head?: string;
  signature?: string;
  attempts: number;
  error?: string;
}

/** `session:token`: one content delta of the top agent's model, on the step that produced it. */
export interface Token {
  delta: string;
  step: number;
}

/**
 * `session:answer`: the reply, at the moment the resolution record is journaled — before any of
 * the session's writes have been confirmed. `seq` and `head` are the ones the record will have.
 */
export interface Answer {
  output: string;
  seq: string | null;
  head: string | null;
  status: string | null;
}

/** What the writer queue still owes this chain when a stream ends. */
export interface AnchorSummary {
  pending: number;
  failed: number;
  seq: string;
  head: string;
}

/** One line in the console: a chain write, a batched step, or a setup note. */
export interface Line {
  key: string;
  type: "genesis" | "action" | "delegation" | "resolution" | "epoch" | "setup" | "error";
  agentName?: string;
  agentId?: string;
  seq?: string;
  head?: string;
  signature?: string;
  toolId?: string;
  statusCode?: number;
  queued?: boolean;
  costMicroUsdc?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  summary?: string;
  text?: string;
  startSeq?: string;
  endSeq?: string;
  epochRoot?: string;
  steps?: number;
  status?: string;
  output?: string;
  reason?: string;
  childAgentId?: string;
  task?: string;
  /** `epoch`: what closed it, as the batcher recorded it. */
  trigger?: EpochFlushTrigger;
  /** `epoch`: false when the commit landed but the locator cell did not. */
  anchored?: boolean;
  anchorError?: string;
  /** `epoch`: the locator is queued for the next manifest cell rather than on chain yet. */
  anchorPending?: boolean;
  /** `action`: metered but not debited (batched step, backend without `charge`). */
  unbilled?: boolean;
  /** `error`: a background failure that did not stop the session. */
  error?: string;
  /**
   * A record that was journaled rather than sent: its `signature` is empty until the writer
   * queue lands it, and this is what it is doing meanwhile. Filled in from the `anchor` events
   * that name the same `anchorId`.
   */
  anchorState?: AnchorState;
  anchorId?: string;
}

/**
 * Why an epoch closed, in words. The four values are the batcher's own
 * (`EpochFlushTrigger` in `sdk/src/rollup.ts`); nothing here is inferred from the numbers.
 */
export const TRIGGER_LABEL: Record<EpochFlushTrigger, string> = {
  count: "flushed: batch full",
  fee: "flushed: fee at floor",
  time: "flushed: timer",
  manual: "flushed: milestone",
};

export interface Init {
  cluster: string;
  programId: string;
  epochs: boolean;
  inference: "openrouter" | "scripted";
  inferenceNote: string | null;
  /** `wallet` when the caller signed for the session; `anonymous` otherwise. */
  auth: "wallet" | "anonymous";
  model: string;
  billing: "charged" | "unfunded" | "no-wallet";
  user: string | null;
  capMicroUsdc: string;
  authority: string;
  /** The fee payer's lamports before the first write. `Done.lamportsSpent` is the delta from it. */
  startLamports?: number;
  /** What the cluster said when the session opened, sampled with the batcher's own probes. */
  signals?: {
    priorityFeeMicroLamports: number | null;
    payerBalanceLamports: number | null;
    payer: string;
    /** The floor below which the batcher will not open an epoch, or null when epochs are off. */
    minPayerLamports: number | null;
    sampledAt: number;
  };
  agents: {
    top: { name: string; id: string; authority: string };
  };
}

export interface Done {
  status: string;
  reason: string | null;
  output: string;
  steps: number;
  batchedSteps: number;
  epochs: { startSeq: string; endSeq: string; root: string; signature: string }[];
  records: { seq: string; kind: number; signature: string; head: string }[];
  costMicroUsdc: string;
  costUsd: number;
  billing: string;
  /** The fee payer's balance before the first write and after the last one. */
  startLamports?: number;
  endLamports?: number;
  /** `startLamports − endLamports`: what the session cost in fees and rent, measured. */
  lamportsSpent: number;
  head: string;
  /** What the writer queue left: `pending: 0, failed: 0` is a session fully on chain. */
  anchor?: AnchorSummary;
  /**
   * Why a record did not land, when one did not. The answer was still given — this is the
   * blockchain write failing, and the records stay journaled for the retry.
   */
  anchorError?: string | null;
  /** Set on the `session:done` of a retry, which writes records rather than answering. */
  retry?: boolean;
}

/** `session:fees`: one balance read after a confirmed write, so the fee stat is measured. */
export interface Fees {
  payer: string;
  startLamports: number;
  lamports: number;
  lamportsSpent: number;
}

/**
 * `session:error`. A refusal by the epoch batcher carries the numbers it refused on; anything
 * else carries only the server's message.
 */
export interface SessionError {
  error: string;
  code?: "InsufficientPayerBalance";
  balance?: number;
  required?: number;
  payer?: string;
  cluster?: string;
}

export interface AuditResult {
  report: any;
  formatted: string[];
}

/** OpenRouter slugs the server accepts (`/api/run` keeps the same list). */
export const MODELS = [
  "deepseek/deepseek-v4.1-flash",
  // Still accepted for older agents deployed with it; the wizard offers only v4.1.
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-chat",
  "moonshotai/kimi-k3",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-haiku-4.5",
  "meta-llama/llama-3.3-70b-instruct",
];

// The purpose vocabulary and the exact bytes signed live in `@lath/sdk`, so this side and the
// route rebuild the same message from one definition. Re-exported because the components that
// sign import their auth surface from this module.
export type { AuthBinding, AuthPurpose } from "@lath/sdk/browser";
export { authMessage, loopAuthBinding } from "@lath/sdk/browser";

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Proves the wallet with a signed nonce — no transaction. A wallet that cannot sign messages, or
 * a user who declines, gets `undefined`: the caller then runs anonymously, which is a real chain
 * write with scripted inference and no billing.
 *
 * `action` and `target` are the request this signature is for, derived the way the route derives
 * them: the route refuses a signature whose pair is not its request's, so a message signed
 * to archive one agent cannot unlock it, and one signed for agent A cannot act on B. `body`, when
 * the binding carries one, is the hash of the request body a loop start authorizes.
 *
 * The domain and URI are this page's: the message is SIWS-shaped, so a wallet that knows the
 * shape shows the person the site asking, and the console refuses a message naming any site but
 * its own — which is what a lookalike page would have had the person sign.
 */
export async function signAuth(
  purpose: AuthPurpose,
  p: AuthBinding & {
    cluster: string;
    wallet: string;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  }
): Promise<{ message: string; signature: string } | undefined> {
  if (!p.signMessage) return undefined;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const message = authMessage(purpose, {
    action: p.action,
    target: p.target,
    body: p.body,
    domain: window.location.host,
    uri: window.location.origin,
    cluster: p.cluster,
    wallet: p.wallet,
    issued: new Date().toISOString(),
    nonce,
  });
  try {
    return { message, signature: base64(await p.signMessage(new TextEncoder().encode(message))) };
  } catch {
    return undefined;
  }
}

/**
 * POSTs a session and calls back once per server-sent event, in order. Throws with the server's
 * own reason when it refuses (rate limit, unknown target, no runtime).
 */
export async function streamSession(
  body: Record<string, unknown>,
  on: (event: string, data: any, key: string) => void
): Promise<void> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const failed = await res.json().catch(() => ({}));
    throw new Error(failed.error ?? `the server refused the session (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      // `parseSseBlock` says why the lines are not matched with a regex: U+2028 in a token cut it.
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      n++;
      on(parsed.event, JSON.parse(parsed.data), `${n}`);
    }
  }
}

/**
 * How a message's anchor reads, reduced over the transitions of the records it journaled. The
 * wording is the design's (§4) and is deliberate: a failure here is a write that did not land,
 * and the sentence beside it must not let a reader think the answer went with it.
 */
export function anchorLabel(a: { state: AnchorState; verified: number; total: number; seq?: string }): {
  tone: "neutral" | "good" | "bad";
  text: string;
} {
  if (a.state === "failed") return { tone: "bad", text: "not anchored" };
  if (a.state === "verified") return { tone: "good", text: a.seq ? `verified to seq ${a.seq}` : "verified" };
  return { tone: "neutral", text: `anchoring ${a.verified}/${a.total}` };
}

/** `runtime` and `session:setup` events as the lines a reader sees. */
export function toLine(event: string, data: any, key: string): Line | null {
  switch (event) {
    case "session:setup":
      return { key, type: "setup", text: `${data.phase}: ${data.detail}`, signature: data.signature };
    case "runtime":
      // An anchor transition is not a line of its own: it is what happened to a record that
      // already has one, and it reaches that line by `anchorId`.
      if (data.type === "anchor") return null;
      return { key, ...data };
    default:
      return null;
  }
}

export function LineView({ line }: { line: Line }) {
  if (line.type === "setup") {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-line/[0.06] bg-line/[0.02] px-3 py-1.5 text-xs text-ink-2"
        data-testid="console-line"
        data-type={line.type}
      >
        <span>{line.text}</span>
        <span className="flex items-center gap-2 font-mono">
          {line.seq && <span>seq #{line.seq}</span>}
          {line.signature && <ExplorerLink kind="tx" value={line.signature} />}
        </span>
      </div>
    );
  }
  const tone =
    line.type === "genesis"
      ? "blue"
      : line.type === "resolution"
      ? "volt"
      : line.type === "delegation"
      ? "good"
      : line.type === "epoch"
      ? "compressed"
      : line.type === "error"
      ? "bad"
      : "cyan";
  return (
    <div
      className="rounded-md border border-line/[0.06] bg-line/[0.02] px-3 py-2"
      data-testid="console-line"
      data-type={line.type}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone}>{line.type}</Badge>
          <span className="font-mono text-xs text-ink-1">{line.agentName}</span>
          {line.toolId && <span className="font-mono text-xs text-ink-3">{line.toolId}</span>}
          {line.queued && <Badge tone="neutral">queued for epoch</Badge>}
          {line.anchorState && (
            <span data-testid="line-anchor" data-state={line.anchorState}>
              <Badge
                tone={line.anchorState === "verified" ? "good" : line.anchorState === "failed" ? "bad" : "neutral"}
              >
                {line.anchorState === "verified"
                  ? "anchored"
                  : line.anchorState === "failed"
                  ? "write failed"
                  : "anchoring"}
              </Badge>
            </span>
          )}
          {line.unbilled && <Badge tone="warn">unbilled</Badge>}
          {line.anchored === false && <Badge tone="warn">not anchored</Badge>}
          {line.anchorPending && <Badge tone="neutral">locator in next manifest</Badge>}
          {line.type === "epoch" && line.trigger && (
            <span data-testid="epoch-trigger" data-trigger={line.trigger}>
              <Badge tone="neutral">{TRIGGER_LABEL[line.trigger]}</Badge>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-ink-3">
          {line.costMicroUsdc && line.costMicroUsdc !== "0" && (
            <span className="text-amber-300">−{formatUsdc(BigInt(line.costMicroUsdc))} USDC</span>
          )}
          {line.promptTokens !== undefined && (
            <span>
              {line.promptTokens} in / {line.completionTokens ?? 0} out
              {line.cachedTokens ? ` · ${line.cachedTokens} cached` : ""}
            </span>
          )}
          {line.seq && <span>seq #{line.seq}</span>}
          {line.startSeq && (
            <span>
              seq #{line.startSeq}–{String(BigInt(line.endSeq!) - 1n)} · {line.steps} steps
            </span>
          )}
          {line.signature && <ExplorerLink kind="tx" value={line.signature} />}
        </div>
      </div>
      {(line.summary || line.output || line.task || line.epochRoot || line.error) && (
        <div className="mt-1.5 text-xs leading-relaxed text-ink-2">
          {line.task && <span className="text-ink-3">task: </span>}
          {line.task ?? line.output ?? line.summary ?? line.error}
          {line.epochRoot && (
            <span className="font-mono text-ink-3">
              root <Copyable value={line.epochRoot} display={truncate(line.epochRoot, 10, 6)} />
            </span>
          )}
          {line.reason && <span className="text-rose-300"> {line.reason}</span>}
          {line.anchorError && <span className="text-rose-300"> {line.anchorError}</span>}
        </div>
      )}
      {line.head && (
        <div className="mt-1 font-mono text-[11px] text-ink-3">
          head <Copyable value={line.head} display={truncate(line.head, 12, 8)} />
        </div>
      )}
    </div>
  );
}

/**
 * What this server's runtime is: its authority, its balance, and the agents it operates.
 *
 * One query for the whole app. It was five, and five copies of a `staleTime` are five chances
 * for two parts of the same screen to disagree about whether the runner is ready. `/api/run` is
 * a cheap read and the answer changes on the scale of a deploy, so 30 s is the right stale
 * window everywhere; a caller that needs it to keep polling — the nav pill — passes an interval,
 * and one that only needs it on a miss passes `enabled`.
 */
export function useRunnerInfo(opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery<RunnerInfo>({
    queryKey: ["runner-info"],
    queryFn: async () => (await fetch("/api/run")).json(),
    staleTime: 30_000,
    ...opts,
  });
}

/** Where an owner's page lives. */
export function ownerHref(id: string): string {
  return `/agent/${id}`;
}
