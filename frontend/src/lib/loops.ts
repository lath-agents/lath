"use client";

/**
 * The client half of loops: what `/api/loops` says, and what the chain says about the same
 * steps.
 *
 * Two sources, deliberately separate. The server's registry knows the schedule — when a loop
 * was created, how often it steps, what it is allowed to spend — and the chain knows what
 * actually happened. Nothing from the first is displayed as fact about the second: every step
 * row is checked in the browser with `verifyStep`, which rebuilds the checkpoint leaf from the
 * chain (`seq` and the head at `seq - 1`) and re-derives the record's `payload_hash` from it and
 * the manifest. A server that misreported a loop's interval, its step count or its prompt
 * produces a manifest whose hash is not the one the chain committed, and the row says so.
 */
import { useMutation, useQuery, UseQueryResult } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import {
  LoopStep,
  LoopStepManifest,
  LoopStepVerification,
  bundleKey,
  encodeLocatorId,
  indexBundle,
  isEncryptedTraceBlob,
  listSteps,
  MAX_BUNDLE_BYTES,
  memoryMatches,
  toBytes32,
  verifyStep,
} from "@lath/sdk/browser";
import { fetchCapped } from "./capped-fetch";
import { useLath } from "./clients";
import { config } from "./config";
import { loopAuthBinding, signAuth } from "./console-stream";
import { loopStepWindow, type LoopStepWindow } from "./loop-window";
import { manifestFor, manifestKeysOf, mayLackTempoHash, recoverTempoHash } from "./loop-manifest";
import { readLoopStart, type LoopStartStage } from "./loop-start-stream";
import type { ReceiptPointer } from "./plugins-view";
import { storagePending } from "./tempo-services";
import { openSession, readerFor, TraceReaders, useTraceStore } from "./traces";

// The wire shape of a run, declared once in `types/loop.ts` and shared with the route that
// builds it. Re-exported here because every consumer already imports it from this module.
export type { LoopStepSummary, LoopTrigger, LoopView } from "@/types/loop";
// The manifest rebuild lives in its own React-free module so a node suite can pin it; re-exported
// because consumers import it from this module.
export { manifestFor } from "./loop-manifest";
import type { LoopStepSummary, LoopView, SandboxConfig } from "@/types/loop";
import type { ResolvedSource, SandboxSourceInput } from "@/types/zeroclaw";

export interface LoopLimits {
  minIntervalMs: number;
  maxSteps: number;
  loopsPerWallet: number;
  sessionCapMicroUsdc: string;
  /**
   * The most one loop's whole budget may be, micro-USDC (`LATH_LOOP_BUDGET_MAX_USDC`). Optional
   * because an older console does not send it; the form then offers every chip and the server clamps
   * what it is sent.
   */
  loopBudgetMaxMicroUsdc?: string;
  /** Lath's Jev share of a loop's budget, percent (`LATH_JEV_BUDGET_PERCENT`), frozen per loop at start. */
  jevBudgetPercent?: number;
  /** Whether each new loop pays through its own Tempo access key (`LATH_TEMPO_LOOP_KEYS`); absent from an older console. */
  tempoLoopKeys?: boolean;
}

export const loopKeys = {
  all: (owner?: string) => ["loops", owner ?? "all"] as const,
  agent: (agentId: string) => ["loops", "agent", agentId.toLowerCase()] as const,
  one: (id: string) => ["loop", id] as const,
  steps: (agentId: string) => ["loop-steps", agentId] as const,
};

/**
 * Every loop this server is running, refreshed while one is mid-step.
 *
 * The poll is the live update: a step is a handful of transactions over a few seconds, and the
 * list has to move while it happens. A loop at rest is polled slowly — the next thing to happen
 * is a timer the browser cannot see anyway.
 */
export function useLoops(owner?: string | null): UseQueryResult<{ loops: LoopView[]; limits: LoopLimits }> {
  return useQuery({
    queryKey: loopKeys.all(owner ?? undefined),
    refetchInterval: (query) => (query.state.data?.loops.some((l) => l.stepping) ? 2_000 : 10_000),
    queryFn: async () => {
      const res = await fetch(owner ? `/api/loops?owner=${owner}` : "/api/loops");
      if (!res.ok) throw new Error(`the loop registry answered ${res.status}`);
      const body = await res.json();
      return { loops: (body.loops ?? []) as LoopView[], limits: body.limits as LoopLimits };
    },
  });
}

/**
 * Every run of one agent, whoever started it, newest first (`/api/loops?agent=`): the agent page's
 * list of loop runs. The registry's list is public, as each run's own page is, so an agent's runs read
 * the same for its owner and for any other wallet. Polled like `useLoops`.
 */
export function useLoopsOfAgent(agentId: string): UseQueryResult<LoopView[]> {
  return useQuery({
    queryKey: loopKeys.agent(agentId),
    refetchInterval: (query) => (query.state.data?.some((l) => l.stepping) ? 2_000 : 10_000),
    queryFn: async () => {
      const res = await fetch(`/api/loops?agent=${encodeURIComponent(agentId.toLowerCase())}`);
      if (!res.ok) throw new Error(`the loop registry answered ${res.status}`);
      return ((await res.json()).loops ?? []) as LoopView[];
    },
  });
}

export function useLoop(id: string): UseQueryResult<{ loop: LoopView; limits: LoopLimits }> {
  return useQuery({
    queryKey: loopKeys.one(id),
    // Fast while a step runs, and while a step's storage chip waits on its PUT: the PUT lands a few
    // seconds after the row, and the chip should fill in then.
    refetchInterval: (query) => {
      const loop = query.state.data?.loop;
      return loop && (loop.stepping || storagePending(loop, Date.now())) ? 2_000 : 10_000;
    },
    queryFn: async () => {
      const res = await fetch(`/api/loops?id=${encodeURIComponent(id)}`);
      if (res.status === 404) throw new Error("no loop with that id");
      if (!res.ok) throw new Error(`the loop registry answered ${res.status}`);
      const body = await res.json();
      return { loop: body.loop as LoopView, limits: body.limits as LoopLimits };
    },
  });
}

/**
 * The steps on an agent's chain: one `memcmp` scan for the `loop.step` records and one walk over
 * transaction history for the heads the epochs produced and the signatures that wrote each
 * record. It is the same history walk `useEpochs` makes, which is why this is its own query with
 * its own cache rather than something a row does for itself.
 */
export function useLoopSteps(agentId: string, enabled = true): UseQueryResult<LoopStep[]> {
  const client = useLath();
  return useQuery({
    queryKey: loopKeys.steps(agentId),
    enabled: enabled && /^[0-9a-f]{64}$/.test(agentId),
    refetchInterval: 15_000,
    queryFn: () => listSteps(client, toBytes32(agentId)),
  });
}

/**
 * What a step resumed from, and whether that can be believed. Three things have to line up:
 * the server names the step it resumed from and the hash it used; that hash is the `memoryHash`
 * the earlier step's *verified* manifest commits to (so the link is a chain fact, not a server
 * claim); and the bytes under it, fetched from the gateway, re-hash to it.
 *
 * The chain also speaks when the server does not. The previous verified step's manifest says
 * what memory it left, so a row whose summary claims no resume while that manifest commits to
 * one is `unreported` — never *fresh*. *fresh* is reserved for a step with nothing verified
 * before it to stand on.
 *
 * What this cannot tell: that the session was actually *handed* those bytes. The runtime
 * commits `memoryHash` in the step's genesis `input` as well (`runtime/src/runtime.ts`,
 * `StartOptions.memory`), but reading that back means finding the step's genesis record and
 * fetching its input preimage from the gateway — another scan and another blob per row — and
 * the console does not do it. `lath-audit --require-preimages` walks that preimage.
 */
export interface StepMemory {
  /**
   * The step this one resumed from, as the server says — or, for `unreported`, the earlier
   * verified step whose manifest committed the memory this one said nothing about.
   */
  fromStep: number;
  hash: string;
  verdict: /** Linked to the earlier step's committed memory and the bytes re-hash. */
  | "ok"
    /** The earlier step's verified manifest commits to a different memory than the one used. */
    | "unlinked"
    /** The server claims no resume, but the previous verified step committed a memory to resume from. */
    | "unreported"
    /** The gateway answered, and has nothing under the hash. */
    | "missing"
    /** The gateway returned bytes that hash to something else. */
    | "mismatch"
    /**
     * The bytes are there and carry an `LTE` header: they were written encrypted to the owner, and
     * this console does not open them. Distinct from `missing`, which says the publisher did not
     * store what it committed to, and from `mismatch`, which says the bytes are wrong.
     */
    | "encrypted"
    /** No gateway configured, or the fetch itself failed, so the bytes were never seen. */
    | "unchecked";
  /** The memory itself, as text, when it verified. */
  text?: string;
}

/**
 * The memory a step *left*, as opposed to the one it resumed from.
 *
 * The hash is this step's own verified manifest's `memoryHash` — so it is only ever read when
 * `verification.verdict` is `ok`, because an unverified manifest is not the chain speaking — and
 * the bytes are fetched and re-hashed exactly as the resumed-from ones are.
 *
 * Why this exists at all: `StepMemory` is the *link* between two steps, and a terminal step has
 * no successor to link to. A goal loop's last step is the one whose memory says `GOAL REACHED`,
 * so defining a step's plan as the one the step after it resumed from would make the only plan
 * anybody wants to read unreachable on screen. `lath-audit --require-preimages` already walks the
 * bytes a step left; this is the same check in the browser.
 *
 * The verdicts are `FetchedMemory`'s and no more: `unlinked` and `unreported` are statements
 * about a link, and there is no link here — the hash came off this step's own record.
 */
export interface LeftMemory {
  hash: string;
  verdict: FetchedMemory["status"];
  /** The memory itself, as text, when the bytes re-hashed to `hash`. */
  text?: string;
}

export interface VerifiedStep {
  /** The step as the chain has it. */
  chain: LoopStep;
  /** 1-based index, from the manifest that verified — or from the record's position. */
  index: number;
  verification: LoopStepVerification;
  /** What the server said about this step, when it has anything. */
  summary?: LoopStepSummary;
  /** What this step resumed from, when the server says it resumed from anything. */
  memory?: StepMemory;
  /** What this step left behind, when its own manifest verified and committed a memory. */
  left?: LeftMemory;
}

/**
 * What came back from the store under a committed memory hash. `encrypted` is ciphertext from a
 * chain written encrypted, which this console does not open.
 */
type FetchedVerdict = "ok" | "missing" | "mismatch" | "encrypted" | "unchecked";

type FetchedMemory = {
  bytes: Uint8Array | null;
  status: FetchedVerdict;
};

/**
 * The memory a step resumed from.
 *
 * First the bundle of the step that *committed* it: a step seals everything it wrote into one
 * blob keyed by its session's genesis (`sdk/src/bundle.ts`), and the memory it leaves for the
 * next step is one of those blobs. The bundle index keys a plaintext entry by its `sha256` and a
 * ciphertext entry by the hash its `LTE` header *claims*. A plaintext hit re-hashes by
 * construction; a ciphertext hit reads *encrypted*, never *memory verified*.
 *
 * Then the raw gateway by hash, and no other: by-hash is a property of a content-addressed store.
 * Irys names blobs its own way, so it is never asked by hash — a deployment on Irys whose step
 * has no bundle reports `unchecked` rather than a `missing` that would read as a broken
 * commitment.
 */
/**
 * The hashes one session's bundle holds, as `indexBundle` keys them: plaintext hashes, so no trace
 * key is needed to list them. Its own download rather than `readers.bundles`, which indexes entries
 * across sessions and keeps no list per session; it runs only on the mismatch path above.
 */
async function sessionHashes(readers: TraceReaders, genesisPayloadHash: string): Promise<string[]> {
  const found = await readers.registry.resolve(bundleKey(toBytes32(genesisPayloadHash))).catch(() => null);
  const reader = found ? readerFor(readers, found.locator.scheme) : null;
  const bytes = reader && found ? await reader.download(found.locator.id).catch(() => null) : null;
  try {
    return bytes ? [...indexBundle(bytes).keys()] : [];
  } catch {
    return [];
  }
}

async function fetchMemory(readers: TraceReaders, hash: string, genesisPayloadHash?: string): Promise<FetchedMemory> {
  if (genesisPayloadHash) {
    await openSession(readers, toBytes32(genesisPayloadHash));
    const bundled = readers.bundles.get(toBytes32(hash));
    if (bundled) return judgeMemory(bundled, hash);
  }
  if (!config.traceGateway) return { bytes: null, status: "unchecked" };
  // The raw gateway spells ids its own way, the same as `gatewayUrl` and the raw reader in
  // `useTraceStore` do: a hex path on a base64url gateway 404s, and that 404 would read as a
  // publisher that never stored the memory. Its own `fetch` rather than
  // `readers.raw.download`, which folds a 404 and a thrown fetch into one `null` and would
  // lose the missing/unchecked distinction below.
  const id = encodeLocatorId(toBytes32(hash), config.traceEncoding);
  // Held to the gateway deadline, and to the largest blob this app reads off a trace gateway (a
  // session bundle, `MAX_BUNDLE_BYTES`), so a gateway that stalls or streams without end cannot
  // hold the step's row open or the tab's memory.
  const url = `${config.traceGateway.replace(/\/$/, "")}/${id}`;
  const res = await fetchCapped(url, { maxBytes: MAX_BUNDLE_BYTES }).catch(() => null);
  // A fetch that threw — the deadline and the cap included — is `unchecked`: nobody looked.
  // *missing* is the word for a publisher that did not store what it committed to, and only a
  // gateway that answered can say that.
  if (!res) return { bytes: null, status: "unchecked" };
  if (!res.bytes) return { bytes: null, status: res.status === 404 ? "missing" : "unchecked" };
  return judgeMemory(res.bytes, hash);
}

/**
 * What the bytes under a memory hash turn out to be: the memory itself, a ciphertext of it written
 * encrypted to the owner, or something that is not this memory at all.
 */
function judgeMemory(bytes: Uint8Array, hash: string): FetchedMemory {
  if (memoryMatches(bytes, hash)) return { bytes, status: "ok" };
  return { bytes: null, status: isEncryptedTraceBlob(bytes) ? "encrypted" : "mismatch" };
}

/**
 * The checkpoints on the agent's chain that are this loop's, and how many belong to other runs of
 * it on either side. The rule is `loopStepWindow`, which is pure and checked in
 * `tests/console-loops.ts`.
 */
export function loopStepsOf(loop: LoopView | undefined, steps: LoopStep[] | undefined): LoopStepWindow<LoopStep> {
  return loopStepWindow(loop, steps);
}

/**
 * Pairs each on-chain step with the loop's own terms and checks it.
 *
 * The steps come back in seq order and the manifests are indexed from 1, so the *i*-th record is
 * step *i + 1* — unless a step was written by an earlier loop on the same agent, which is why a
 * record that does not verify against its expected index is retried against the index the
 * server's summary claims before it is called a mismatch.
 */
export function useVerifiedSteps(loop: LoopView | undefined, steps: LoopStep[] | undefined) {
  // The readers a step's memory is resolved through: the agent's own locator registry and the
  // gateways this deployment has. A placeholder id while there is no loop — the query is
  // disabled then, and `useTraceStore` insists on 32 bytes.
  const readers = useTraceStore(loop?.agentId ?? "0".repeat(64));
  return useQuery({
    queryKey: [
      "loop-verified",
      loop?.id,
      loop?.steps,
      // The window the rows are taken from moves with the registry row, not only with the chain's
      // list: a history row or a `lastSeq` that arrives on a later poll changes which records are
      // this loop's, and a key blind to that would keep showing the ones it already numbered.
      loop?.lastSeq,
      loop?.status,
      loop?.history.length,
      (steps ?? []).map((w) => w.seq.toString()).join(","),
    ],
    enabled: !!loop && !!steps,
    // The key moves with every poll that changes the loop's row or the chain's list, and a new key has
    // no data until every leaf is re-derived (~35 s each on devnet). Without a placeholder each landing
    // step would empty the list for that long — _No step has been written yet_ on a running loop — and
    // unmount every card, closing whatever proof or report a reader had open. The last check's rows
    // stay up instead, for the same loop only: another loop's rows are not this one's steps.
    // `isPlaceholderData` is how a reader of this hook tells them from a finished check.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === loop?.id ? previous : undefined),
    queryFn: async (): Promise<VerifiedStep[]> => {
      const agentId = toBytes32(loop!.agentId);
      const out: VerifiedStep[] = [];
      // A chain keeps every loop's checkpoints, and an agent can be run as a loop more than once.
      // A record from another run cannot be one of this loop's steps, and checking it against this
      // loop's terms could only ever say "mismatch" — which is the word for a broken commitment,
      // not for somebody else's. Both ends of the window are filtered: with only the earlier one, a
      // second run on the same agent would be numbered into this loop's manifest and its page would
      // read "3/6 leaves verified" about a run whose every step verified.
      const { own } = loopStepWindow(loop!, steps!);
      for (const [i, chain] of own.entries()) {
        const bySeq = loop!.history.find((h) => h.seq === chain.seq.toString());
        // The step index the row is *believed* to be, then its neighbours: an off-by-one in our
        // own numbering is not a broken commitment, and trying two more manifests is two hashes.
        const candidates = [...new Set([bySeq?.step, i + 1, i, i + 2])].filter(
          (n): n is number => typeof n === "number" && n >= 1
        );
        let index = candidates[0];
        const memoryHash = bySeq?.memoryHash;
        const verifyHash = bySeq?.verify?.verifyHash;
        const requestAddress = bySeq?.oracle?.requestAddress;
        const members = bySeq?.members;
        const keys = manifestKeysOf(bySeq);
        let verification = await verifyStep(agentId, chain, {
          manifest: manifestFor(loop!, index, memoryHash, verifyHash, requestAddress, members, keys),
        });
        for (const candidate of candidates.slice(1)) {
          if (verification.verdict === "ok") break;
          const alt = await verifyStep(agentId, chain, {
            manifest: manifestFor(loop!, candidate, memoryHash, verifyHash, requestAddress, members, keys),
          });
          if (alt.verdict === "ok") {
            index = candidate;
            verification = alt;
          }
        }
        // An older row may lack the fifteenth key its manifest committed, `tempoHash`, so the honest
        // leaf rebuilt here without it mismatches.
        // The carry blob that hash names went through the step's own store, so it is one of the
        // hashes in this step's bundle; one is taken only when the manifest rebuilt with it
        // reproduces the record's on-chain payload hash, so nothing but the committed bytes can pass.
        if (verification.verdict !== "ok" && bySeq?.genesisPayloadHash && mayLackTempoHash(bySeq, loop!.history)) {
          const base = manifestFor(loop!, index, memoryHash, verifyHash, requestAddress, members, keys);
          const ok = async (m: LoopStepManifest) =>
            (await verifyStep(agentId, chain, { manifest: m })).verdict === "ok";
          const tempoHash = await recoverTempoHash(base, await sessionHashes(readers, bySeq.genesisPayloadHash), ok);
          if (tempoHash) verification = await verifyStep(agentId, chain, { manifest: { ...base, tempoHash } });
        }

        // The memory this step resumed from. The link is only as good as the earlier step's
        // verified manifest: a server that named a hash the chain never committed is "unlinked".
        // And the earlier manifest is consulted whether or not the server says anything: what
        // the previous verified step committed as `memoryHash` is what this step had to stand on,
        // so a summary with no `resumed*` fields does not get to read "fresh" against it.
        const previous = out[i - 1];
        const committedBefore =
          previous?.verification.verdict === "ok" ? previous.verification.manifest?.memoryHash : undefined;
        let memory: StepMemory | undefined;
        if (!(bySeq?.resumedFromStep && bySeq.resumedMemoryHash) && committedBefore) {
          memory = { fromStep: previous.index, hash: committedBefore, verdict: "unreported" };
        } else if (bySeq?.resumedFromStep && bySeq.resumedMemoryHash) {
          const hash = bySeq.resumedMemoryHash;
          const earlier = out.find((v) => v.index === bySeq.resumedFromStep && v.verification.verdict === "ok");
          if (!earlier || earlier.verification.manifest?.memoryHash !== hash) {
            memory = { fromStep: bySeq.resumedFromStep, hash, verdict: "unlinked" };
          } else {
            // The bytes are in the bundle of the step that committed this memory, not this one's.
            const fetched = await fetchMemory(readers, hash, earlier.summary?.genesisPayloadHash);
            memory = {
              fromStep: bySeq.resumedFromStep,
              hash,
              verdict: fetched.status,
              text: fetched.bytes ? new TextDecoder().decode(fetched.bytes) : undefined,
            };
          }
        }

        // The memory this step *left*: the `memoryHash` its own manifest commits, which the
        // chain stands behind exactly when that manifest verified. The bytes are in this step's
        // own bundle — it is the step that wrote them — so its genesis is the one to open.
        //
        // Without this a terminal step's memory is never fetched at all, because the other reader
        // of a committed memory is the step *after* it, and the last step of a run has none. The
        // readers cache the bundle, so the next step's resumed-from fetch of the
        // same hash costs nothing more.
        const leftHash = verification.verdict === "ok" ? verification.manifest?.memoryHash : undefined;
        let left: LeftMemory | undefined;
        if (leftHash) {
          const fetched = await fetchMemory(readers, leftHash, bySeq?.genesisPayloadHash);
          left = {
            hash: leftHash,
            verdict: fetched.status,
            text: fetched.bytes ? new TextDecoder().decode(fetched.bytes) : undefined,
          };
        }
        out.push({ chain, index, verification, summary: bySeq, memory, left });
      }
      return out;
    },
  });
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface StartLoopRequest {
  agentId: string;
  prompt: string;
  intervalMs: number;
  maxSteps: number;
  /**
   * The loop's one overall budget, micro-USDC: what its steps draw down until it is spent,
   * `maxSteps` is reached or the goal is met. An older client's body carries a per-step budget
   * instead, which the server still reads.
   */
  budgetMicroUsdc: string;
  model?: string;
  /**
   * Omitted is `schedule`, the one trigger this build starts: the server refuses a `request`, `feed`
   * or `gate` trigger, and a `gate` key, since neither gated nor oracle-woken loops are in it.
   */
  trigger?: { kind: "schedule" };
  /**
   * Ask a second model to judge each step before it becomes memory.
   * Omitted is off; the server fills the model and a missing threshold.
   */
  verify?: { model?: string; minConfidence?: number };
  /**
   * What the run is working toward. Omitted is a loop without one, an instruction-only loop; the
   * server trims it, treats whitespace as absent, and — when a goal
   * is sent with no `prompt` — fills the standing instruction with the default itself, so the
   * `promptHash` the chain commits names what actually ran.
   */
  goal?: string;
  /**
   * _Jev checks the goal_: after each step Jev answers whether the goal is achieved, and its answer
   * ends the loop in place of the agent's own claim. Sent only as `true`, only with a goal; omitted is
   * the goal loop that stops on the agent's own claim. The server resolves the model and
   * the bar (the verify seat's when it is on, else 0.5).
   */
  goalCheck?: boolean;
  /**
   * The loop template this start extends. With the long body
   * above, the server appends a version to it when the terms differ; alone, it re-runs the stored
   * version. `version` is the one the form showed.
   */
  templateId?: string;
  version?: number;
  /**
   * The sandbox every step of the run opens: the host's tools switched, the workspace cap lowered,
   * the sources. Written only when the owner touched the Sandbox section, on the rule `verify`
   * follows, so a start without it hashes with no sandbox key.
   */
  sandbox?: SandboxConfig;
  /**
   * Where the loop's receipt on SAS goes and who signs it: the console's own demo pointer, which the
   * form reads from `attestDemo.receipt`, and the only one the console accepts. Written only when
   * SAS · receipt is picked, so every other start's policy hashes without it. Not a grant: it needs no loop key and rides beside `grants`, not in it.
   */
  receipt?: ReceiptPointer;
}

/**
 * `POST /api/loops { action: "check-sources", sources }`: what the form's _Check sources_ shows
 * before the wallet signs — each input resolved (commit, final URL and type, slot), with its file
 * count and size, and nothing kept. A refusal names the input by its 1-based `input`.
 */
export interface CheckSourcesRequest {
  action: "check-sources";
  sources: SandboxSourceInput[];
}

export type CheckSourcesResponse =
  | { ok: true; resolved: { source: ResolvedSource; files: number; bytes: number }[] }
  | { ok: false; error: string; input?: number };

/**
 * _Check sources_: resolve every input on the server and fetch nothing into a sandbox.
 *
 * Not signed, unlike every other verb of `/api/loops`. It starts nothing, spends nothing and keeps
 * nothing, and a `"Lath loop"` message here would be a second wallet prompt in front of the one
 * the start already asks for — the prompt the check exists to make safe to sign. What
 * guards the server's fetch on a stranger's say-so is the route's per-caller rate limit and the
 * same SSRF rules the start's fetch follows, not a signature.
 *
 * A refusal the server words (`ok: false`) is an answer, not an error: it is returned so the form
 * can put it against the row it names. Only a failure to get any answer at all throws.
 */
export async function checkSources(sources: SandboxSourceInput[]): Promise<CheckSourcesResponse> {
  const body: CheckSourcesRequest = { action: "check-sources", sources };
  const res = await fetch("/api/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answered = (await res.json().catch(() => null)) as CheckSourcesResponse | { error?: string } | null;
  if (answered && "ok" in answered) return answered;
  // A server without the action yet (R3b), or one that refused the body before reading it, answers
  // `{ error }` with a 4xx: shown as the check's own refusal rather than as a crash of the form.
  const error =
    (answered && "error" in answered && answered.error) || `the server could not check the sources (${res.status})`;
  return { ok: false, error };
}

export function useCheckSources() {
  return useMutation({ mutationFn: checkSources });
}

/**
 * Signs a `"Lath loop"` message and posts it. Its own purpose: a session or a deploy signature
 * must not be replayable into starting something that keeps spending for hours. A start's message
 * also carries the hash of the body it is posted with (`loopAuthBinding`), so the body signed
 * here is the only one the route will start on that signature: nothing between this function and
 * the route — a script holding a harvested signature included — can change the instruction, the
 * budget, the trigger or the team and keep the signature.
 */
export async function postLoop(
  body: Record<string, unknown>,
  wallet: PublicKey,
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
): Promise<LoopView> {
  return ((await postLoopRaw(body, wallet, signMessage)) as { loop: LoopView }).loop;
}

async function postLoopRaw(
  body: Record<string, unknown>,
  wallet: PublicKey,
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>,
  onStage?: (stage: LoopStartStage) => void
): Promise<unknown> {
  const auth = await signAuth("Lath loop", {
    ...loopAuthBinding(body),
    cluster: config.cluster,
    wallet: wallet.toBase58(),
    signMessage,
  });
  if (!auth) throw new Error("the loop message was not signed");
  // A caller that wants the stages asks for the stream; the signature and the body are the
  // same bytes either way, so the one `"Lath loop"` prompt is unchanged.
  const res = await fetch("/api/loops", {
    method: "POST",
    headers: { "content-type": "application/json", ...(onStage ? { accept: "text/event-stream" } : {}) },
    body: JSON.stringify({ ...body, auth }),
  });
  if (onStage) return readLoopStart(res, onStage);
  const answered = await res.json();
  if (!res.ok) throw new Error(answered.error ?? `the server refused the loop (${res.status})`);
  return answered;
}

/**
 * A start. With `onStage`, the start is streamed and each stage is told as the server begins it —
 * the check, the source fetch, the Irys pin or its reuse, the start itself — so the button can
 * name the minute a start with sources takes. The answer is the same `LoopView` either way.
 */
export function useStartLoop(
  wallet: PublicKey | null,
  signMessage?: (m: Uint8Array) => Promise<Uint8Array>,
  onStage?: (stage: LoopStartStage) => void
) {
  return useMutation({
    mutationFn: async (req: StartLoopRequest) => {
      if (!wallet) throw new Error("connect a wallet to run a loop");
      const answered = await postLoopRaw({ action: "start", ...req }, wallet, signMessage, onStage);
      return (answered as { loop: LoopView }).loop;
    },
  });
}

/** The verbs a loop's controls post. */
export type LoopActionVerb = "pause" | "resume" | "stop" | "archive" | "unarchive" | "retry";

export function useLoopAction(wallet: PublicKey | null, signMessage?: (m: Uint8Array) => Promise<Uint8Array>) {
  return useMutation({
    mutationFn: async (p: { id: string; action: LoopActionVerb }) => {
      if (!wallet) throw new Error("connect a wallet to control this loop");
      return postLoop({ action: p.action, id: p.id }, wallet, signMessage);
    },
  });
}

/**
 * *Run again*: a new run from the template version this one came from.
 *
 * Not a revival. A run is produced once and is never edited or restarted, so this posts a fresh start from the same config and gets back a new loop with a new id
 * and its own `startedAt`; the run it came from stays exactly as it ended. Same template, same
 * `template.hash`, different history.
 */
export function useRunAgain(wallet: PublicKey | null, signMessage?: (m: Uint8Array) => Promise<Uint8Array>) {
  return useMutation({
    mutationFn: async (p: { templateId: string; version?: number }) => {
      if (!wallet) throw new Error("connect a wallet to run this loop again");
      return postLoop({ action: "start", templateId: p.templateId, version: p.version }, wallet, signMessage);
    },
  });
}

// ─── Display helpers ────────────────────────────────────────────────────────

/** "every 5 min" — an interval as a person reads it. */
export function formatInterval(ms: number): string {
  if (ms < 60_000) return `every ${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `every ${Math.round(ms / 60_000)} min`;
  const hours = ms / 3_600_000;
  return `every ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

/** "in 2 min" / "now" / "—", for a timestamp that may be in the past. */
export function untilStep(at: number | null): string {
  if (!at) return "—";
  const delta = at - Date.now();
  if (delta <= 1000) return "now";
  if (delta < 60_000) return `in ${Math.round(delta / 1000)} s`;
  if (delta < 3_600_000) return `in ${Math.round(delta / 60_000)} min`;
  return `in ${(delta / 3_600_000).toFixed(1)} h`;
}

/** The one-word verdict a badge shows, and whether it is good news. */
export function verdictLabel(v: LoopStepVerification | undefined): { text: string; tone: "good" | "bad" | "warn" } {
  switch (v?.verdict) {
    case "ok":
      return { text: "leaf verified", tone: "good" };
    case "mismatch":
      return { text: "leaf mismatch", tone: "bad" };
    case "no-head":
      return { text: "no head at seq−1", tone: "warn" };
    case "no-preimage":
      return { text: "no preimage", tone: "warn" };
    case "unreadable":
      return { text: "unreadable", tone: "warn" };
    default:
      return { text: "checking…", tone: "warn" };
  }
}
