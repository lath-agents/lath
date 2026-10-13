"use client";

/**
 * The client half of a loop's sandbox view: what `GET /api/zeroclaw/<id>` says about the sandbox a
 * step ran in, and what the chain says about the same step.
 *
 * The same split `lib/loops.ts` keeps. The route reports the console's own records — the wrapper a
 * step ran under, the posture it was handed, the Actions it recorded — and every one of those comes
 * back tagged `console`. What this file adds is the reads that make some of them `chain`: the
 * step's Actions by seq and the Genesis's `policy_version_hash`, against which the posture is
 * re-hashed here, in the browser, rather than believed. (The tab's list read and its tiles' header
 * reads went with the tab, which the workspace replaced.)
 */
import { useMemo } from "react";
import { useQueries, useQuery, UseQueryResult } from "@tanstack/react-query";
import {
  EpochRecord,
  EventInput,
  EventKind,
  canonicalJson,
  EventRecord,
  hex,
  idFromString,
  sha256,
  utf8,
} from "@lath/sdk/browser";
import { checkPostureBytes, POSTURE_IRYS_MAX_BYTES, type PostureBytesCheck } from "@lath/runtime/zeroclaw/posture-irys";
import { errorText } from "@lath/runtime/errors";
import { fetchCapped, ReadCapError } from "./capped-fetch";
import { useEpochs } from "./queries";
import { epochStepsKey, fetchEpochSteps, useTraceStore, type ResolvedEpoch } from "./traces";
import { toolName } from "./eventmeta";
import { ZC_TOOLS, type SourcesManifest, type ZeroClawDetail } from "@/types/zeroclaw";
// Types only: the server read's module holds `fs`, and a type import is erased before the bundle.
import type { ZeroClawSandboxDetailResponse } from "@/app/api/_lib/zeroclaw";

export type {
  Sourced,
  SourcesManifest,
  ZeroClawDetail,
  ZeroClawHostView,
  ZeroClawListResponse,
  ZeroClawView,
} from "@/types/zeroclaw";
export type {
  SandboxPostureIrys,
  ZeroClawSandboxDetail,
  ZeroClawSandboxDetailResponse,
  ZeroClawSandboxRow,
} from "@/app/api/_lib/zeroclaw";
import type { SandboxPostureIrys } from "@/app/api/_lib/zeroclaw";

export const zeroclawKeys = {
  one: (id: string, step?: number, sandbox?: string) =>
    ["zeroclaw-sandbox", id, step ?? "last", sandbox ?? "session"] as const,
};

/** One sandbox at step `step`, or at its last step; a member's sandbox when `sandbox` names one, else session A's. */
export function useZeroClawSandbox(
  id: string,
  step?: number,
  sandbox?: string
): UseQueryResult<ZeroClawSandboxDetailResponse> {
  return useQuery({
    queryKey: zeroclawKeys.one(id, step, sandbox),
    refetchInterval: (query) => (query.state.data?.sandbox.stepping ? 2_000 : 10_000),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (step !== undefined) params.set("step", String(step));
      if (sandbox !== undefined) params.set("sandbox", sandbox);
      const q = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`/api/zeroclaw/${encodeURIComponent(id)}${q}`);
      if (res.status === 404) throw new Error("no loop with that id");
      if (!res.ok) throw new Error(`the console answered ${res.status}`);
      return (await res.json()) as ZeroClawSandboxDetailResponse;
    },
  });
}

const ZC_BY_HASH = new Map<string, string>(ZC_TOOLS.map((t) => [hex(idFromString(t)), t]));

/** A tool id's name: the sandbox's tools first, then the console's own table, else `null`. */
export function sandboxToolName(reference: Uint8Array): string | null {
  return ZC_BY_HASH.get(hex(reference)) ?? toolName(reference) ?? null;
}

/** An Action the step wrote, as the chain has it. */
export interface ChainAction {
  seq: bigint;
  tool: string | null;
  toolHash: string;
  status: number;
  /** One of the sandbox's own tools (`zc.*`), as opposed to a host tool or the checkpoint. */
  zc: boolean;
  /** A leaf of the step's epoch, read from its blob after the root rebuilt to the chain's. */
  inEpoch: boolean;
  /** The record's `payload_hash`, hex: what names its args and result blobs, for a reader that opens them. */
  payloadHash: string;
}

type StepBounds = { seq: string | null; previousSeq: string | null; genesisSeq: string | null };

/**
 * The seqs one step spans on the chain: after the previous step's `loop.step` (or from the step's
 * Genesis, when the sandbox recorded it) up to and including this step's. A step's session, its
 * synthesis and its checkpoint are all in that range and nothing of the next step is, because
 * steps are serial (`LoopRunner`). `null` when the step wrote no checkpoint to bound it by.
 */
export function stepRange(bounds: StepBounds): { lo: bigint; hi: bigint } | null {
  if (!bounds.seq) return null;
  const hi = BigInt(bounds.seq);
  const lo = bounds.genesisSeq ? BigInt(bounds.genesisSeq) : bounds.previousSeq ? BigInt(bounds.previousSeq) + 1n : 0n;
  return { lo, hi };
}

/**
 * The Actions of one step, by seq, from both places the chain keeps them: live records, and the
 * leaves of the step's epoch. A loop rolls a step's tool calls into one epoch (`runtime/src/loop.ts`),
 * so the calls a sandbox made are never live records — only the Genesis, the Resolution and the
 * checkpoint are — and a read of live records alone finds a sandboxed step with no tool calls at
 * all. `null` when the step wrote no checkpoint to bound it by.
 */
export function stepActions(
  events: EventRecord[] | undefined,
  bounds: StepBounds,
  leaves: { seq: bigint; input: EventInput }[] = []
): ChainAction[] | null {
  const range = stepRange(bounds);
  if (!events || !range) return null;
  const within = (seq: bigint) => seq >= range.lo && seq <= range.hi;
  const rows = [
    ...events.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      reference: e.reference,
      status: e.status,
      payloadHash: e.payloadHash,
      inEpoch: false,
    })),
    ...leaves.map((l) => ({ seq: l.seq, ...l.input, inEpoch: true })),
  ];
  return rows
    .filter((e) => e.kind === EventKind.Action && within(e.seq))
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    .map((e) => {
      const tool = sandboxToolName(e.reference);
      return {
        seq: e.seq,
        tool,
        toolHash: hex(e.reference),
        status: e.status,
        zc: !!tool && tool.startsWith("zc."),
        inEpoch: e.inEpoch,
        payloadHash: hex(e.payloadHash),
      };
    });
}

/** The step's epochs and what opening each one gave; `pending` until every one has answered. */
export interface StepEpochs {
  epochs: EpochRecord[];
  resolved: (ResolvedEpoch | undefined)[];
  leaves: { seq: bigint; input: EventInput }[];
  pending: boolean;
  error: unknown;
}

/**
 * Every epoch the owner committed that overlaps the step's range, each opened the way the agent
 * page's timeline opens one: the blob found through the registry, its root rebuilt in the browser
 * and matched against the chain's. Only a matched blob's leaves count; one that is unanchored,
 * unavailable or a mismatch is reported by its status, not read.
 */
export function useStepEpochs(agentId: string, bounds: StepBounds): StepEpochs {
  const range = stepRange(bounds);
  const store = useTraceStore(agentId);
  const all = useEpochs(agentId, !!range);
  const epochs = useMemo(
    () => (range && all.data ? all.data.filter((e) => e.startSeq <= range.hi && e.endSeq > range.lo) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all.data, range?.lo, range?.hi]
  );
  const opened = useQueries({
    queries: epochs.map((epoch) => ({
      queryKey: epochStepsKey(epoch),
      staleTime: 5 * 60_000,
      queryFn: () => fetchEpochSteps(store, epoch),
    })),
  });
  const resolved = opened.map((q) => q.data);
  return {
    epochs,
    resolved,
    leaves: resolved.flatMap((r) => (r?.status === "ok" ? r.steps ?? [] : [])),
    pending: !!range && (all.isLoading || opened.some((q) => q.isLoading)),
    error: all.error ?? opened.find((q) => q.error)?.error ?? null,
  };
}

/** The first Genesis of the step's range: the step's own session, before any synthesis. */
export function stepGenesis(
  events: EventRecord[] | undefined,
  bounds: { seq: string | null; previousSeq: string | null; genesisSeq: string | null }
): EventRecord | null {
  if (!events || !bounds.seq) return null;
  const hi = BigInt(bounds.seq);
  if (bounds.genesisSeq) {
    const at = BigInt(bounds.genesisSeq);
    return events.find((e) => e.kind === EventKind.Genesis && e.seq === at) ?? null;
  }
  const lo = bounds.previousSeq ? BigInt(bounds.previousSeq) + 1n : 0n;
  return (
    events
      .filter((e) => e.kind === EventKind.Genesis && e.seq >= lo && e.seq <= hi)
      .sort((a, b) => (a.seq < b.seq ? -1 : 1))[0] ?? null
  );
}

/**
 * `canonicalJson` is the SDK's (`sdk/src/market.ts`), reached through `@lath/sdk/browser` like
 * every other hash primitive this file uses: keys sorted, `undefined` dropped, arrays in order —
 * the bytes a policy's, a posture's and a replay record's hash are over. It is not copied here:
 * the browser bundle exports it, and a copy would only be a second place for a hash input to
 * drift. Re-exported because
 * `ZeroClawSandbox` imports it from here.
 */
export { canonicalJson };

export function sha256Hex(text: string): string {
  return hex(sha256(utf8(text)));
}

/** One line of the verify block: what was compared, and how it came out. */
export interface PostureCheck {
  label: string;
  verdict: "match" | "mismatch" | "unavailable";
  detail: string;
}

/**
 * The posture as read from Irys, in the browser: the object's bytes held to the posture hash
 * with `checkPostureBytes`, or why they could not be read. `null` while reading and when the console
 * names no Irys copy, which is every older loop that ran without one.
 */
export type IrysPosture =
  | { id: string; url: string; state: "read"; read: PostureBytesCheck }
  | { id: string; url: string; state: "unavailable"; note: string };

/**
 * The described sandbox's posture off the Irys gateway, re-hashed here against the hash its record
 * names. Read as soon as the page knows where, not on _Verify_: it is a few kilobytes, and the jail
 * rules are drawn from it. A gateway that fails, does not answer within the gateway deadline, or
 * sends more than a posture can be is `unavailable`, and the page falls back to this console's copy
 * and says so.
 */
export function useIrysPosture(at: SandboxPostureIrys | null): UseQueryResult<IrysPosture> {
  return useQuery<IrysPosture>({
    queryKey: ["zeroclaw-posture-irys", at?.gateway, at?.id, at?.postureHash],
    enabled: !!at,
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      const { id, gateway, postureHash } = at!;
      const url = `${gateway}/${id}`;
      try {
        const got = await fetchCapped(url, { maxBytes: POSTURE_IRYS_MAX_BYTES });
        if (!got.bytes) return { id, url, state: "unavailable", note: `the gateway answered ${got.status}` };
        return { id, url, state: "read", read: checkPostureBytes(got.bytes, postureHash) };
      } catch (e) {
        if (e instanceof ReadCapError) {
          return {
            id,
            url,
            state: "unavailable",
            note: `the gateway sent over ${POSTURE_IRYS_MAX_BYTES} bytes, more than a posture`,
          };
        }
        return { id, url, state: "unavailable", note: `the gateway could not be read: ${errorText(e)}` };
      }
    },
  });
}

/**
 * The posture bytes the checks and the jail rules use, and where they came from: Irys when the copy
 * there re-hashed to the committed hash, else this console's `postureJson`. A copy on Irys that did
 * not re-hash is not replaced by the console's — that is a mismatch the check reports.
 */
export function postureSource(
  sandbox: ZeroClawDetail,
  irys: IrysPosture | null | undefined
): { json: string | null; from: "irys" | "console"; note?: string } {
  if (irys?.state === "read") return { json: irys.read.ok ? irys.read.json : null, from: "irys" };
  return {
    json: sandbox.postureJson.value ?? null,
    from: "console",
    ...(irys?.state === "unavailable" ? { note: `the copy on Irys was not read (${irys.note})` } : {}),
  };
}

/**
 * The posture's _verify_: three comparisons, each done here and each saying what it could not do.
 *
 * 1. The posture's bytes re-hash to the posture hash the sandbox recorded — the bytes on Irys when
 *    the console names a copy there and it could be read, this console's otherwise, and the detail
 *    says which ("from Irys" / "from this console").
 * 2. The policy document carries exactly those bytes under `sandbox` — so the posture is inside
 *    what the Genesis hashed, not beside it.
 * 3. The policy document re-hashes to the `policy_version_hash` the step's Genesis committed, read
 *    from the Genesis's payload in the browser.
 *
 * Only the third touches the chain, and it is the one that matters: from this console's copy the
 * first two hold the console to itself; from Irys the posture's bytes are not the console's,
 * though the policy document still is. A match on all three says the posture shown is the posture that step committed; it
 * does not say the binary applied it — that is the wrapper's, and the sentence below the block
 * says what the host claims about it.
 */
export function checkPosture(
  sandbox: ZeroClawDetail,
  genesisPolicyHash: string | null,
  genesisNote?: string,
  irys?: IrysPosture | null
): PostureCheck[] {
  const checks: PostureCheck[] = [];
  const source = postureSource(sandbox, irys);
  const from = source.from === "irys" ? "from Irys" : "from this console";
  const posture = source.json;
  const recorded = sandbox.postureHash.value;
  if (irys?.state === "read" && !irys.read.ok) {
    checks.push({ label: "posture bytes → posture hash", verdict: "mismatch", detail: `${from}: ${irys.read.why}` });
  } else if (posture && recorded) {
    const got = sha256Hex(posture);
    checks.push({
      label: "posture bytes → posture hash",
      verdict: got === recorded ? "match" : "mismatch",
      detail: `${from}: ${got === recorded ? got : `re-hashed to ${got}, the sandbox recorded ${recorded}`}${
        source.note ? `; ${source.note}` : ""
      }`,
    });
  } else {
    checks.push({
      label: "posture bytes → posture hash",
      verdict: "unavailable",
      detail: sandbox.postureJson.note ?? sandbox.postureHash.note ?? "no posture recorded",
    });
  }

  const doc = sandbox.policyDocument.value;
  if (doc && posture) {
    let inner: string | null = null;
    try {
      const parsed = JSON.parse(doc) as Record<string, unknown>;
      inner =
        parsed && typeof parsed === "object" && parsed.sandbox !== undefined ? canonicalJson(parsed.sandbox) : null;
    } catch {
      inner = null;
    }
    checks.push({
      label: "policy document carries the posture",
      verdict: inner === posture ? "match" : "mismatch",
      detail:
        inner === null
          ? "the policy document has no sandbox key"
          : inner === posture
          ? "its sandbox key is the posture's bytes"
          : "its sandbox key is not the posture shown",
    });
  } else {
    checks.push({
      label: "policy document carries the posture",
      verdict: "unavailable",
      detail: sandbox.policyDocument.note ?? sandbox.postureJson.note ?? "nothing to compare",
    });
  }

  if (doc && genesisPolicyHash) {
    const got = sha256Hex(doc);
    checks.push({
      label: "policy document → Genesis policy_version_hash",
      verdict: got === genesisPolicyHash ? "match" : "mismatch",
      detail: got === genesisPolicyHash ? got : `re-hashed to ${got}, the Genesis committed ${genesisPolicyHash}`,
    });
  } else {
    checks.push({
      label: "policy document → Genesis policy_version_hash",
      verdict: "unavailable",
      detail: !doc
        ? sandbox.policyDocument.note ?? "no policy document recorded"
        : genesisNote ?? "the Genesis's policy hash was not read",
    });
  }
  return checks;
}

/**
 * `SOURCES_TAG` from `runtime/src/zeroclaw/sources.ts`, copied for the reason `canonicalJson` is: the
 * runtime cannot ship to the browser. The tag is the first line of the bytes the posture hashes, so
 * a copy that drifted would fail every sources check on the page, loudly.
 */
export const SOURCES_TAG = "lath.sources.v1";

/** `sourcesHash` from the runtime: `sha256("lath.sources.v1\n" + canonicalJson(manifest))`, hex. */
export function sourcesManifestHash(m: SourcesManifest): string {
  return sha256Hex(`${SOURCES_TAG}\n${canonicalJson(m)}`);
}

/** The `sources.hash` the posture JSON commits, or `null` when it names none or does not parse. */
export function postureSourcesHash(postureJson: string | null): string | null {
  if (!postureJson) return null;
  try {
    const p = JSON.parse(postureJson) as { sources?: { hash?: unknown } } | null;
    const h = p?.sources?.hash;
    return typeof h === "string" ? h : null;
  } catch {
    return null;
  }
}

/**
 * The Sources card's two comparisons, both done here, in the browser.
 *
 * 1. The manifest the console served re-hashes to the hash the posture commits — the posture whose
 *    bytes _Verify_ ties to the Genesis's `policy_version_hash`, which is why that hash is tagged
 *    `chain` and the manifest only `console`. With no posture bytes to read it from, the record's
 *    own copy of the hash is all there is, and the detail says so.
 * 2. The sandbox's record names the same hash as its posture: a record whose copy drifted from the
 *    posture describes a different set of files from the one the Genesis committed.
 *
 * A mismatch is returned, never swallowed: the card shows it above the manifest it failed on.
 */
export function checkSources(
  sources: { hash: string; manifest: SourcesManifest },
  postureJson: string | null
): PostureCheck[] {
  const committed = postureSourcesHash(postureJson);
  const got = sourcesManifestHash(sources.manifest);
  const against = committed ?? sources.hash;
  const whose = committed ? "the posture commits" : "the sandbox recorded (no posture bytes to read it from)";
  return [
    {
      label: "manifest → posture sources.hash",
      verdict: got === against ? "match" : "mismatch",
      detail: got === against ? got : `re-hashed to ${got}, ${whose} ${against}`,
    },
    committed
      ? {
          label: "sandbox record names the posture's sources",
          verdict: committed === sources.hash ? "match" : "mismatch",
          detail:
            committed === sources.hash
              ? "the record's hash is the posture's"
              : `the record names ${sources.hash}, the posture ${committed}`,
        }
      : {
          label: "sandbox record names the posture's sources",
          verdict: "unavailable",
          detail: postureJson
            ? "the posture shown has no sources key"
            : "the sandbox did not record its posture's bytes",
        },
  ];
}
