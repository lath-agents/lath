"use client";

/**
 * Talking to one agent, on its own chain.
 *
 * Every message is a full session: the server's runtime opens a genesis record for it, runs the
 * model and the tools, batches the steps into an epoch, resolves, and audits the chain it just
 * wrote. The reply in the bubble is that session's `output`; the strip under it says which model
 * produced it, what was metered and where the writes landed. Nothing here is a mock — if the
 * server cannot write this chain, the box says so instead of pretending.
 *
 * The answer comes first. Tokens arrive as the model produces them
 * and fill the bubble; the reply is final the moment the resolution record is computed, which is
 * before any of it is on chain. The badge beside the message is the anchor, and only the anchor:
 * *anchoring n/m* while the writer queue works, *verified to seq N* when it is done, and *not
 * anchored* when a write did not land after three attempts — which means the blockchain write
 * failed and nothing else. The answer is in the trace store either way, and the badge is then a
 * button that re-queues the same records.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Badge, Button, Card, ExplorerLink, Facts, Info } from "@/components/ui";
import { OpenRouterMark, TempoLink, TempoMark } from "@/components/Tempo";
import { formatUsdc, truncate } from "@/lib/format";
import { keys, useAllowance } from "@/lib/queries";
import { readAllowance } from "@/lib/allowance-grant";
import {
  Answer,
  AnchorEventData,
  AnchorState,
  anchorLabel,
  AuditResult,
  Done,
  Fees,
  Init,
  Line,
  LineView,
  MODELS,
  RunnerInfo,
  SessionError,
  signAuth,
  streamSession,
  toLine,
} from "@/lib/console-stream";
import { EventRecord } from "@lath/sdk/browser";
import { DUAL_RAIL_TITLE, DualRailPanel, type LiveRail } from "@/components/DualRailPanel";
import { NothingAsked, PastSessions } from "@/components/PastSessions";

const sol = (lamports: number) => `${(lamports / 1e9).toFixed(6)} SOL`;

/** One question and everything the chain did about it. */
interface Exchange {
  key: string;
  prompt: string;
  model: string;
  lines: Line[];
  init: Init | null;
  audit: AuditResult | null;
  done: Done | null;
  /** The model's output as it streamed, shown until the resolution gives the final text. */
  tokens: string;
  /** The reply, from the moment the resolution record was journaled. */
  answer: Answer | null;
  /** Every journaled record of this message, by id, at its latest state. */
  anchors: Record<string, AnchorEventData>;
  /** A retry of this message's failed writes is in flight. */
  retrying: boolean;
  /** The payer's balance after the last confirmed write of this session, when one has landed. */
  fees: Fees | null;
  error: SessionError | null;
  /**
   * The `tempo` rail of this session as it happens: the channel the first voucher announced, one
   * entry per paid call, and the settlement the close reported. Null for an unbilled session,
   * which is every session on a deployment with no treasury (`lib/tempo.ts`).
   */
  tempo: LiveRail | null;
  running: boolean;
  startedAt: number;
  ms: number;
}

export function AgentChat({
  id,
  records = [],
  defaultOpen = false,
}: {
  id: string;
  /** This chain's records, so a reload can read back what it already answered. */
  records?: EventRecord[];
  /**
   * Open on load rather than folded: for a page where this card is the only thing to do, an agent
   * with no header on chain yet, whose first send is what registers it.
   */
  defaultOpen?: boolean;
}) {
  const { publicKey, signMessage } = useWallet();
  const queryClient = useQueryClient();
  // The card is folded to its title by default: the agent page leads with the agent and its allowance, and the
  // transcript is one click away. A link to `#ask` — the e2e specs that send from this card open it so — is a person
  // who came to ask, so it opens the card. Read after mount, and on `hashchange` for a same-page link, because the
  // server has no hash to agree with. `Card` takes its open state once, so the key remounts the card when the link is
  // seen; it only ever flips one way, and the exchanges live in this component's state, not the card's, so nothing
  // asked is lost by it.
  const [askLinked, setAskLinked] = useState(false);
  useEffect(() => {
    const check = () => {
      if (window.location.hash === "#ask") setAskLinked(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  const info = useQuery<RunnerInfo>({
    queryKey: ["runner-info", id],
    queryFn: async () => (await fetch(`/api/run?agent=${encodeURIComponent(id)}`)).json(),
    staleTime: 30_000,
  });

  const target = info.data?.target ?? null;

  // Whether this wallet's signature would be billed, read before anything is signed.
  // Every visitor is connected (`WalletGate`), and `/api/run` answers a signed session from a
  // wallet that neither owns the agent nor holds a live allowance to its authority with a 402 — so
  // signing for those wallets would turn the console's open demo agent into a refusal for every
  // visitor. Such a wallet runs the anonymous session instead (real chain, scripted, unbilled) with
  // no prompt, and the composer says how to get a real model. The route's rules are the same either
  // way; this only stops asking for a signature the route would refuse.
  const authorityKey = useMemo(() => {
    try {
      return target?.authority ? new PublicKey(target.authority) : null;
    } catch {
      return null;
    }
  }, [target?.authority]);
  const grant = readAllowance(useAllowance(publicKey ?? null, authorityKey));
  const ownsAgent = !!publicKey && target?.source === "deployed" && target.owner === publicKey.toBase58();
  // Live as `admitSpend` (`_lib/runner.ts`) reads it: unexpired, with headroom under the cap. A
  // short escrow deposit is not visible here; the route still refuses that with its reason.
  const liveAllowance =
    grant.kind === "granted" &&
    Number(grant.allowance.expiresAt) * 1000 > Date.now() &&
    grant.allowance.cap - grant.allowance.spent - (grant.allowance.reserved ?? 0n) > 0n;
  const billable = ownsAgent || liveAllowance;
  // Until the allowance is read the send waits, so a funded wallet's first message is not run
  // scripted for having been typed quickly.
  const billingUnknown = !!publicKey && !!authorityKey && !ownsAgent && grant.kind === "reading";
  const signer = billable ? publicKey : null;

  const [model, setModel] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const running = exchanges.some((e) => e.running);
  // The Genesis seq of every session this tab ran, so the chain's copy of it is not drawn a second
  // time above the live one. A session's first Genesis line is its own: the runtime opens the top
  // agent's session before any child is delegated to, and a child's Genesis is on the child's chain,
  // whose seqs are not this chain's. Read from the line, which carries the seq the record was
  // journaled at, rather than from `done.records`, so a session whose writes are still queued or
  // failed is held too — its record may reach the chain before this tab hears that it did.
  const heldGeneses = useMemo(() => {
    const seqs = new Set<string>();
    for (const e of exchanges) {
      const seq = e.lines.find((l) => l.type === "genesis" && l.seq)?.seq;
      if (seq) seqs.add(seq);
    }
    return seqs;
  }, [exchanges]);
  const listRef = useRef<HTMLDivElement>(null);

  // The agent's deployed model is the default, when it named one this server still offers.
  const chosen =
    model ?? (target?.policy?.model && MODELS.includes(target.policy.model) ? target.policy.model : MODELS[0]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [exchanges]);

  function patch(key: string, change: (e: Exchange) => Exchange) {
    setExchanges((prev) => prev.map((e) => (e.key === key ? change(e) : e)));
  }

  /**
   * An anchor transition belongs to a record that already has a line: it carries the signature
   * that line was missing, because the record was journaled before it was sent and an empty
   * signature is how the stream says so. A session and a retry fold them in the same way.
   *
   * Matched on the head rather than on `anchorId`, which the runtime declares but does not yet
   * put on a logged event. The head is what the record is: no two records on a chain share one,
   * so it identifies the line at least as precisely as the id would.
   */
  function applyAnchor(key: string, data: AnchorEventData) {
    const same = (l: Line) => (l.anchorId && l.anchorId === data.id) || (!!data.head && l.head === data.head);
    patch(key, (e) => ({
      ...e,
      anchors: { ...e.anchors, [data.id]: data },
      lines: e.lines.map((l) =>
        same(l) ? { ...l, anchorState: data.state, signature: data.signature || l.signature } : l
      ),
    }));
  }

  /**
   * The *not anchored* click. It runs no model and asks no new question: the server puts this
   * chain's failed records back in the writer queue and drains them under the head check, and the
   * transitions stream back into the message they belong to.
   */
  async function retryWrites(key: string) {
    const e = exchanges.find((x) => x.key === key);
    if (!e || e.retrying) return;
    patch(key, (x) => ({ ...x, retrying: true }));
    try {
      // The retry signs on the same rule as the session it re-queues: only a wallet that can be billed.
      const auth = signer
        ? await signAuth("Lath console session", {
            action: "retry",
            target: id.toLowerCase(),
            cluster: info.data?.cluster ?? "devnet",
            wallet: signer.toBase58(),
            signMessage,
          })
        : undefined;
      // The route holds a retry to the same owner gate as a session (`/api/run` answers 401 to an
      // unsigned one on a deployed agent), so it is stopped here and says why, as `send` is.
      if (!auth && target?.source === "deployed") {
        patch(key, (x) => ({
          ...x,
          error: {
            error: signMessage
              ? "signature needed: this agent's writes are retried only for its owner's signed message, and none was given"
              : "signature needed: this agent's writes are retried only for its owner's signed message, and this wallet cannot sign messages",
          },
        }));
        return;
      }
      await streamSession(
        { action: "retry", agentId: id, target: { kind: "agent", id }, user: signer?.toBase58(), auth },
        (event, data) => {
          if (event === "runtime" && data.type === "anchor") applyAnchor(key, data);
          else if (event === "session:done")
            patch(key, (x) => ({
              ...x,
              done: x.done ? { ...x.done, anchor: data.anchor, anchorError: data.anchorError } : x.done,
            }));
          else if (event === "session:error") patch(key, (x) => ({ ...x, error: data }));
          // A retry is a second stream against the message already on screen, and what it has to
          // say belongs in that message's log: *retrying*, and the seal this message left owed,
          // which is the only place a reader is ever told the bundle landed. Dropping these would
          // leave the badge going green with nothing to explain it.
          else {
            patch(key, (x) => {
              // Keyed off the line count rather than a counter in this closure: a counter in the
              // component body resets on every render, and two lines with one key is a React
              // warning and a list that does not update.
              const line = toLine(event, data, `${key}-retry-${x.lines.length}`);
              return line ? { ...x, lines: [...x.lines, line] } : x;
            });
          }
        }
      );
    } catch (err: any) {
      patch(key, (x) => ({ ...x, error: { error: err?.message ?? String(err) } }));
    } finally {
      patch(key, (x) => ({ ...x, retrying: false }));
      queryClient.invalidateQueries({ queryKey: keys.ownerState(id) });
    }
  }

  async function send() {
    const prompt = draft.trim();
    if (!prompt || running || billingUnknown) return;
    const key = `${Date.now()}`;
    // Up to eight earlier turns go with the prompt; the session itself stays single-shot, and
    // the chain records exactly what it always records.
    const history = exchanges
      .filter((e) => e.done)
      .flatMap((e) => [
        { role: "user" as const, text: e.prompt },
        { role: "agent" as const, text: e.done!.output },
      ])
      .slice(-8);
    setDraft("");
    setExchanges((prev) => [
      ...prev,
      {
        key,
        prompt,
        model: chosen,
        lines: [],
        init: null,
        audit: null,
        done: null,
        tokens: "",
        answer: null,
        anchors: {},
        retrying: false,
        tempo: null,
        fees: null,
        error: null,
        running: true,
        startedAt: Date.now(),
        ms: 0,
      },
    ]);

    try {
      // A signed message (no transaction) is what lets the server pay a model on this wallet's
      // behalf and bill the wallet's allowance, so it is asked only of a wallet that can be billed
      // (`billable` above). Without one — declined, or a wallet with no `signMessage` — what the
      // route does depends on the agent: one of the console's own runs anonymously (real chain,
      // scripted inference, unbilled), but a deployed agent runs only for its owner's signature and
      // `/api/run` answers 401 to an unsigned send, so that send is stopped here and says why.
      const auth = signer
        ? await signAuth("Lath console session", {
            action: "session",
            target: id.toLowerCase(),
            cluster: info.data?.cluster ?? "devnet",
            wallet: signer.toBase58(),
            signMessage,
          })
        : undefined;
      if (!auth && target?.source === "deployed") {
        patch(key, (e) => ({
          ...e,
          error: {
            error: signMessage
              ? "signature needed: this agent runs only for its owner's signed message, and none was given"
              : "signature needed: this agent runs only for its owner's signed message, and this wallet cannot sign messages",
          },
        }));
        return;
      }
      await streamSession(
        {
          target: { kind: "agent", id },
          prompt,
          model: chosen,
          history,
          user: signer?.toBase58(),
          auth,
        },
        (event, data, n) => {
          switch (event) {
            case "session:init":
              patch(key, (e) => ({ ...e, init: data }));
              break;
            case "session:audit":
              patch(key, (e) => ({ ...e, audit: data }));
              break;
            case "session:done":
              patch(key, (e) => ({ ...e, done: data }));
              break;
            case "session:fees":
              patch(key, (e) => ({ ...e, fees: data }));
              break;
            case "session:error":
              patch(key, (e) => ({ ...e, error: data }));
              break;
            case "session:token":
              patch(key, (e) => ({ ...e, tokens: e.tokens + data.delta }));
              break;
            case "session:answer":
              patch(key, (e) => ({ ...e, answer: data }));
              break;
            // The three `tempo` kinds, folded into one live rail. The channel arrives with the
            // first voucher rather than on open, because the transport opens it lazily inside
            // the first call; a voucher for a seq already listed replaces it, so a retried
            // stream cannot double-count what left the wallet.
            case "session:tempo:channel":
              patch(key, (e) => ({
                ...e,
                tempo: { vouchers: [], ...(e.tempo ?? {}), payer: data.payer, channelId: data.channelId },
              }));
              break;
            case "session:tempo:voucher":
              patch(key, (e) => ({
                ...e,
                tempo: {
                  ...(e.tempo ?? { vouchers: [] }),
                  vouchers: [...(e.tempo?.vouchers ?? []).filter((v) => v.seq !== data.seq), data],
                },
              }));
              break;
            case "session:tempo:settled":
              patch(key, (e) => ({
                ...e,
                tempo: { vouchers: [], ...(e.tempo ?? {}), settlement: data },
              }));
              break;
            default: {
              if (event === "runtime" && data.type === "anchor") {
                applyAnchor(key, data);
                break;
              }
              const line = toLine(event, data, `${key}-${n}`);
              if (line) patch(key, (e) => ({ ...e, lines: [...e.lines, line] }));
            }
          }
        }
      );
    } catch (err: any) {
      patch(key, (e) => ({ ...e, error: { error: err?.message ?? String(err) } }));
    } finally {
      patch(key, (e) => ({ ...e, running: false, ms: Date.now() - e.startedAt }));
      // The session wrote this chain: the header read is stale by definition. The page's header
      // watch (`lib/live.ts`) sees the new seq on that refetch and pulls events, epochs and the
      // chain check along; invalidating those here as well would start every scan twice.
      queryClient.invalidateQueries({ queryKey: keys.ownerState(id) });
      if (publicKey) queryClient.invalidateQueries({ queryKey: keys.balance(publicKey.toBase58()) });
    }
  }

  if (info.isLoading)
    return (
      <Card title="Ask">
        <p className="text-xs text-ink-3">Checking whether this server can run this agent…</p>
      </Card>
    );

  if (!info.data?.ready) {
    return (
      <Card title="Ask">
        <p className="text-sm leading-relaxed text-ink-2" data-testid="chat-unavailable">
          This server cannot run sessions: {info.data?.reason ?? "unknown"}. A deployment with a funded runtime keypair
          answers here.
        </p>
      </Card>
    );
  }

  const owned = target?.source === "deployed";
  const wallet = publicKey?.toBase58() ?? null;
  // Another wallet's agent draws no chat at all: the header's _Owned by_ line says whose it is, and a card whose only
  // content was that sentence and the owner's full key would be the page's one dead end. An agent with no recorded
  // owner still says why nobody can run it.
  if (target && owned && target.owner && wallet !== target.owner) return null;
  if (target && owned && !target.owner) {
    return (
      <Card title="Ask">
        <p className="text-sm leading-relaxed text-ink-2" data-testid="chat-not-owner">
          {/* No *connect the wallet* arm: every page is behind `WalletGate`, so a wallet is always
              connected here, and a sentence for none would be unreachable. */}
          This agent was deployed before ownership was recorded, so nobody can run it. Redeploy it under your wallet.
        </p>
      </Card>
    );
  }

  if (target && !target.operated) {
    return (
      <Card title="Ask">
        <p className="text-sm leading-relaxed text-ink-2" data-testid="chat-not-operated">
          This agent&apos;s authority is{" "}
          <span className="font-mono text-xs text-ink-1">{target.authority ?? "not registered yet"}</span>; the runtime
          on this server cannot write its chain, and only the authority may append to it. Deploy an agent from the
          Agents page to get one it operates.
        </p>
      </Card>
    );
  }

  return (
    <Card
      key={askLinked ? "ask-linked" : "ask"}
      collapsible={{ testId: "agent-ask", defaultOpen: defaultOpen || askLinked }}
      title="Ask this agent"
      right={
        <div className="flex flex-wrap items-center gap-2">
          {/* The description, word for word, behind an ⓘ. On the header's right
              since the card folds: the title is the fold's toggle button, and an ⓘ inside it
              would be a button inside a button. */}
          <Info label="About this chat" wide>
            <p className="text-2xs leading-relaxed text-ink-3">
              Each message runs one session on this agent&apos;s own chain: genesis, the model&apos;s tool calls batched
              into an epoch, resolution, then an audit. The reply arrives as it is written; the badge beside it says how
              much of it is on chain.
            </p>
            <p className="text-2xs leading-relaxed text-ink-3">
              A billed session&apos;s model calls are paid to OpenRouter via Tempo, from Lath&apos;s treasury, and
              debited from your allowance in USDC on Solana.
            </p>
          </Info>
          <Badge tone={info.data.inference === "openrouter" ? "good" : "neutral"}>
            {/* Named as every paid call is named elsewhere, _OpenRouter via Tempo_: that is how it is paid. */}
            {info.data.inference === "openrouter" ? "OpenRouter inference via Tempo" : "scripted inference"}
          </Badge>
          {running && (
            <Badge tone="warn" dot>
              running on chain
            </Badge>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div ref={listRef} className="max-h-[40rem] space-y-5 overflow-y-auto pr-1" data-testid="chat-transcript">
          {/* What this chain already answered, read back out of its traces, above whatever this
              tab has asked since it loaded. A session that ran in another tab, or before a
              reload, is the chain's business and not this component's state. The two are
              kept apart by the sessions this tab ran: once a send lands the records are read
              again and carry that session too, and without `held` it would be drawn twice, once from
              the chain above and once live below. */}
          <PastSessions agentId={id} records={records} held={heldGeneses} />
          {exchanges.length === 0 && records.length === 0 && <NothingAsked />}
          {exchanges.map((e) => (
            <ExchangeView key={e.key} agentId={id} exchange={e} onRetry={retryWrites} />
          ))}
        </div>

        <div className="space-y-2.5 border-t border-line/[0.08] pt-4">
          <textarea
            rows={2}
            // The route refuses a prompt past 2 000 characters; stopping the typing here
            // keeps that refusal for callers that are not this page.
            maxLength={2000}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" && !ev.shiftKey) {
                ev.preventDefault();
                void send();
              }
            }}
            placeholder="Ask this agent…"
            data-testid="chat-input"
            className="input h-auto resize-y py-2.5 leading-relaxed"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-ink-3">
              <span>Model</span>
              <select
                value={chosen}
                onChange={(ev) => setModel(ev.target.value)}
                className="input h-8 w-auto pr-7 font-mono text-xs"
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <span className="flex items-center gap-2">
              {/* What a send costs the wallet, behind an ⓘ beside the button rather than as a line of
                  small print under every composer, word for word. */}
              {signer && (
                <Info label="How a send works" wide testId="chat-send-info">
                  <p className="text-2xs leading-relaxed text-ink-3">
                    Your wallet signs a short message per send (no transaction);{" "}
                    {liveAllowance
                      ? "the session then runs the model and is billed against your allowance to this agent."
                      : "as this agent's owner with no allowance to it yet, the session runs scripted and unbilled."}{" "}
                    Enter sends, Shift+Enter starts a line.
                  </p>
                </Info>
              )}
              <span data-testid="chat-send">
                <Button onClick={send} disabled={running || billingUnknown || !draft.trim()} loading={running}>
                  {running ? "Running on chain…" : billingUnknown ? "Reading your allowance…" : "Send"}
                </Button>
              </span>
            </span>
          </div>
          {!signer && (
            <p className="text-2xs leading-relaxed text-ink-3" data-testid="chat-anon-note">
              This session runs without your signature: the chain writes are real, inference is scripted and nothing is
              billed. To run it on a real model, grant an allowance to this agent&apos;s authority
              {target?.authority ? (
                <>
                  {" "}
                  (<span className="font-mono">{truncate(target.authority, 6)}</span>)
                </>
              ) : null}{" "}
              in its{" "}
              <a
                href="#allowance"
                className="text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink-1"
              >
                Allowance
              </a>{" "}
              card. Enter sends, Shift+Enter starts a line.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function ExchangeView({
  exchange: e,
  agentId,
  onRetry,
}: {
  exchange: Exchange;
  /** The chain this session is writing; what the rail panel and its verify lines name. */
  agentId: string;
  onRetry: (key: string) => void;
}) {
  const [openDetails, setOpenDetails] = useState(false);
  /**
   * The final text, then the answer the resolution gave before anything was written, then what
   * the model has streamed so far. The order is the design's: nothing here waits for the chain.
   */
  const resolved = e.done
    ? e.done.status === "success"
      ? e.done.output || "(the session produced no text)"
      : e.done.output || `session ${e.done.status}${e.done.reason ? `: ${e.done.reason}` : ""}`
    : e.answer
    ? e.answer.output || "(the session produced no text)"
    : undefined;
  const reply = resolved ?? e.error?.error ?? (e.tokens || undefined);

  /**
   * This message's anchor, reduced over the records it journaled: `m` is how many there are and
   * `n` how many the writer queue has confirmed. One failure is the message's state, because the
   * queue halts a chain at its first failed record and nothing after it can land.
   */
  const anchor = useMemo(() => {
    const all = Object.values(e.anchors);
    if (all.length === 0) return null;
    const verified = all.filter((a) => a.state === "verified");
    const failed = all.filter((a) => a.state === "failed").length;
    const state: AnchorState = failed > 0 ? "failed" : verified.length === all.length ? "verified" : "pending";
    const seqs = verified.filter((a) => a.seq).map((a) => BigInt(a.seq!));
    const seq = seqs.length > 0 ? seqs.reduce((a, b) => (b > a ? b : a)).toString() : undefined;
    return { state, total: all.length, verified: verified.length, seq };
  }, [e.anchors]);

  const seqs = useMemo(() => {
    if (!e.done) return null;
    const all = e.done.records.map((r) => BigInt(r.seq));
    for (const ep of e.done.epochs) {
      all.push(BigInt(ep.startSeq), BigInt(ep.endSeq) - 1n);
    }
    if (all.length === 0) return null;
    const lo = all.reduce((a, b) => (b < a ? b : a));
    const hi = all.reduce((a, b) => (b > a ? b : a));
    return lo === hi ? `#${lo}` : `#${lo}–${hi}`;
  }, [e.done]);

  const writes = e.lines.filter((l) => l.signature).length;
  const auditOk = e.audit ? e.audit.report.ok : null;

  return (
    <div className="space-y-2" data-testid="chat-exchange">
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/[0.12] px-3.5 py-2 text-sm leading-relaxed text-ink-1">
          {e.prompt}
        </p>
      </div>

      <div className="flex justify-start">
        <div className="max-w-[85%] space-y-2">
          <div
            className={`whitespace-pre-wrap rounded-2xl rounded-bl-md border px-3.5 py-2 text-sm leading-relaxed ${
              e.error
                ? "border-rose-400/25 bg-rose-400/[0.07] text-rose-200"
                : "border-line/[0.08] bg-surface-2 text-ink-1"
            }`}
            data-testid="chat-reply"
          >
            {reply ?? <span className="text-ink-3">thinking…</span>}
          </div>

          {e.error?.code === "InsufficientPayerBalance" && (
            <p
              className="rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2 text-2xs leading-relaxed text-rose-200"
              data-testid="insufficient-balance"
            >
              The epoch was refused before anything was queued: the payer holds{" "}
              <span className="num">{e.error.balance?.toLocaleString()}</span> lamports ({sol(e.error.balance ?? 0)})
              and one <code className="font-mono">commit_epoch</code>, its locator cell and the record after it need{" "}
              <span className="num">{e.error.required?.toLocaleString()}</span> lamports ({sol(e.error.required ?? 0)}).
              Fund {e.error.payer && <ExplorerLink kind="address" value={e.error.payer} />} and ask again.
            </p>
          )}

          {anchor?.state === "failed" && (
            <p
              className="rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2 text-2xs leading-relaxed text-rose-200"
              data-testid="anchor-failed-note"
            >
              The blockchain write failed
              {e.done?.anchorError ? `: ${e.done.anchorError}` : " after three attempts"}. The answer above is this
              session&apos;s own output and is stored off chain; what did not land is the record of it. Click{" "}
              <span className="font-mono">not anchored</span> to write the same records again — they are queued in seq
              order, and one that already landed is recognised by its head rather than written twice.
            </p>
          )}

          {/* One quiet line by default; everything the session did is behind Details. */}
          {(e.running || e.done || e.lines.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-3">
              {anchor && (
                <span data-testid="anchor-badge" data-state={anchor.state}>
                  {anchor.state === "failed" ? (
                    <button
                      type="button"
                      onClick={() => onRetry(e.key)}
                      // Until the session's own stream has closed it still holds the run slot —
                      // it seals, audits and sums up after the failed drain — and a retry sent
                      // then is refused as a run in progress. The badge says FAILED from the
                      // queue's transition, which comes first; the click waits for the summary.
                      disabled={e.retrying || !e.done}
                      data-testid="anchor-retry"
                      title="Re-queue this message's records; the answer above is unaffected"
                      className="transition-opacity hover:opacity-80 disabled:opacity-50"
                    >
                      <Badge tone="bad" dot>
                        {e.retrying ? "retrying the write…" : "not anchored"}
                      </Badge>
                    </button>
                  ) : (
                    <Badge tone={anchorLabel({ ...anchor }).tone} dot>
                      {anchorLabel({ ...anchor }).text}
                    </Badge>
                  )}
                </span>
              )}
              {/* The quiet line keeps the answer's cost and how it was paid; the
                  model, the duration and a passing audit are in its Info. A failed audit stays on
                  the line: a failure is not a detail. */}
              {e.done && e.init && (
                <>
                  <span data-testid="chat-cost">
                    {formatUsdc(BigInt(e.done.costMicroUsdc))} USDC
                    {e.done.billing === "charged" ? "" : " · unbilled"}
                  </span>
                  <ChatPayment tempo={e.tempo} paid={e.init.inference === "openrouter"} />
                  {auditOk === false && (
                    <Badge tone="bad" dot>
                      audit failed
                    </Badge>
                  )}
                  <Info
                    label="This session's details"
                    testId="chat-session-info"
                    triggerTestId="chat-session-info-toggle"
                  >
                    <Facts
                      items={[
                        {
                          label: "model",
                          value: e.init.inference === "openrouter" ? e.init.model : `${e.init.model} · scripted`,
                          mono: true,
                          source: "console",
                        },
                        ...(e.ms ? [{ label: "took", value: `${(e.ms / 1000).toFixed(1)}s` }] : []),
                        ...(auditOk !== null
                          ? [
                              {
                                label: "audit",
                                value: (
                                  <Badge tone={auditOk ? "good" : "bad"} dot>
                                    {auditOk ? "verified" : "audit failed"}
                                  </Badge>
                                ),
                                source: "chain" as const,
                              },
                            ]
                          : []),
                      ]}
                    />
                    {e.tempo && (
                      <p className="text-2xs leading-relaxed text-ink-3">
                        Each call is paid to OpenRouter&apos;s Tempo gateway with Tempo&apos;s Machine Payments
                        Protocol, in a payment channel that settles on Tempo when the session ends.
                      </p>
                    )}
                  </Info>
                </>
              )}
              <button
                type="button"
                onClick={() => setOpenDetails((v) => !v)}
                aria-expanded={openDetails}
                data-testid="chat-details"
                className="rounded-md border border-line/[0.1] px-2 py-0.5 text-ink-2 transition-colors hover:border-line/[0.2] hover:bg-line/[0.04] hover:text-ink-1"
              >
                {openDetails ? "Hide details" : "Details"}
              </button>
            </div>
          )}

          {openDetails && (
            <div className="well space-y-3 p-3 animate-rise">
              {e.init?.signals && (
                <p className="text-2xs leading-relaxed text-ink-2" data-testid="session-signals">
                  <span className="text-ink-3">
                    sampled from the cluster at session start — the two reads the epoch batcher makes:{" "}
                  </span>
                  priority fee{" "}
                  <span className="num text-ink-1" data-testid="signal-fee">
                    {e.init.signals.priorityFeeMicroLamports ?? "—"}
                  </span>{" "}
                  micro-lamports per compute unit (median of the recent prioritization fees) · payer{" "}
                  <ExplorerLink kind="address" value={e.init.signals.payer} /> balance{" "}
                  <span className="num text-ink-1" data-testid="signal-balance">
                    {e.init.signals.payerBalanceLamports?.toLocaleString() ?? "—"}
                  </span>{" "}
                  lamports
                  {e.init.signals.minPayerLamports !== null && (
                    <> · no epoch is opened below {e.init.signals.minPayerLamports.toLocaleString()} lamports</>
                  )}
                </p>
              )}

              {!e.done && e.fees && (
                <p className="text-2xs text-ink-2" data-testid="fees-paid-running">
                  <span className="text-ink-3">fees paid so far </span>
                  {sol(e.fees.lamportsSpent)}
                  <span className="text-ink-3">
                    {" "}
                    — the payer&apos;s balance delta, measured after the last confirmed write
                  </span>
                </p>
              )}

              {e.done && e.init && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-2">
                  <span>
                    <span className="text-ink-3">inference </span>
                    {e.init.inference === "openrouter" ? `${e.init.model} · signed` : `${e.init.model} · scripted`}
                  </span>
                  <span>
                    <span className="text-ink-3">metered </span>
                    {formatUsdc(BigInt(e.done.costMicroUsdc))} USDC{" "}
                    {e.done.billing === "charged"
                      ? "· debited from your escrow"
                      : e.done.billing === "unfunded"
                      ? "· unbilled: no allowance for the runtime"
                      : "· unbilled: no wallet"}
                  </span>
                  <span data-testid="fees-paid" data-lamports={e.done.lamportsSpent}>
                    <span className="text-ink-3">fees paid </span>
                    {sol(e.done.lamportsSpent)}
                    <span className="text-ink-3">
                      {" "}
                      · {e.done.lamportsSpent.toLocaleString()} lamports, the payer&apos;s balance delta, measured
                    </span>
                  </span>
                  <span>
                    <span className="text-ink-3">epochs </span>
                    {e.done.epochs.length}
                  </span>
                  {seqs && (
                    <span>
                      <span className="text-ink-3">seq </span>
                      {seqs}
                    </span>
                  )}
                  <span>
                    <span className="text-ink-3">chain writes </span>
                    {writes}
                  </span>
                  {e.done.head && <span className="font-mono text-ink-3">head {truncate(e.done.head, 8, 6)}</span>}
                </div>
              )}

              {/* The `tempo` rail of this session, while it is happening: every seq with what
                  the gateway was paid for it, and the settlement when the channel closes. A
                  scripted session has no `tempo` state and shows nothing. */}
              {e.tempo && <DualRailPanel agentId={agentId} live={e.tempo} title={`This session: ${DUAL_RAIL_TITLE}`} />}

              {e.lines.length > 0 && (
                <div
                  className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border border-line/[0.06] bg-canvas/60 p-2 pr-1"
                  data-testid="chat-lines"
                >
                  {e.lines.map((l) => (
                    <LineView key={l.key} line={l} />
                  ))}
                </div>
              )}

              {e.audit && (
                <div className="space-y-1">
                  <Badge tone={e.audit.report.ok ? "good" : "bad"} dot>
                    audit {e.audit.report.ok ? "VERIFIED" : "FAILED"}
                  </Badge>
                  <pre
                    className="overflow-x-auto rounded-lg border border-line/[0.06] bg-canvas p-3 font-mono text-2xs leading-relaxed text-ink-2"
                    data-testid="chat-audit"
                  >
                    {e.audit.formatted.join("\n")}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * How this session's model calls were paid, on the quiet line: _OpenRouter via Tempo_, linked to
 * the session's settlement transaction once the payment channel has closed, and a plain _paid on
 * Tempo · settling_ before that. A scripted session paid nobody and says so; a
 * real model with no `tempo` state is a session this deployment did not bill, and says nothing.
 */
function ChatPayment({ tempo, paid }: { tempo: LiveRail | null; paid: boolean }) {
  if (!paid) {
    return (
      <span className="inline-flex items-center gap-1" data-testid="chat-tempo" data-state="scripted">
        not paid (scripted)
        <Info label="Why this session was not paid">
          <p className="text-2xs leading-relaxed text-ink-3">
            This session ran on the scripted transport: the chain writes are real, no model was called, and nothing was
            paid on Tempo or debited on Solana.
          </p>
        </Info>
      </span>
    );
  }
  if (!tempo) return null;
  const tx = tempo.settlement?.txHash;
  if (tx) {
    return (
      <span className="inline-flex items-center gap-1" data-testid="chat-tempo" data-state="settled">
        <OpenRouterMark /> OpenRouter via{" "}
        <TempoLink kind="tx" value={tx} label="Tempo" testId="chat-tempo-settlement" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" data-testid="chat-tempo" data-state="settling">
      <TempoMark /> {tempo.settlement?.closed === false ? "paid on Tempo · not settled" : "paid on Tempo · settling"}
    </span>
  );
}
