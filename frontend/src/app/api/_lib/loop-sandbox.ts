/**
 * The ZeroClaw sandbox every loop step runs in, and the config a start may give it: the tools, the
 * workspace caps, the fetched sources' directory, and the record a step keeps of its session
 * (`_lib/loops.ts` re-exports it).
 */
import * as fs from "fs";
import * as path from "path";
import type { TraceStore } from "@lath/sdk";
import {
  PostureRefused,
  allowedWireTools,
  decodeSourcesManifest,
  sourcesHash,
  type SourcesManifest,
} from "@lath/runtime";
// Server-only, and so not in the package index the client pages import (see `runtime/src/index.ts`).
import {
  ZeroClawUnavailable,
  pathInside,
  resolveZeroClaw,
  zeroclawHome,
  type ZeroClawBinary,
  type ZeroClawSessionReport,
} from "@lath/runtime/zeroclaw/runtime";
import { WORKSPACE_MAX_BYTES, WORKSPACE_MAX_FILES } from "@lath/runtime/zeroclaw/workspace";
import type { LoopStepSummary, SandboxConfig } from "../../../types/loop";
import type { ZeroClawReplayRecord, ZeroClawStepRecord } from "../../../types/zeroclaw";
import { SourcesRefused, parseSourceInputs } from "./sources";
import {
  CHAIN_TOOL_NAMES,
  OPT_IN_TOOL_NAMES,
  RETIRED_TOOL_NAMES,
  STORE_TOOL_NAMES,
  TOOL_NAMES,
  type ScriptTurn,
} from "./tools";
import { TRACE_DIR } from "./runner";
import { LoopRefused, STEP_DEADLINE_MS } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import type { LoopRequest } from "./loop-request";

// ─── The sandbox every step runs in ──────────────────────

/**
 * The wall clock one session's sandbox may run. A third of the step's own deadline, because a step
 * can open three sandboxes in a row — session A, the team (in parallel, one sandbox each), session B —
 * and all of them have to finish inside the run slot the step holds.
 */
export const SANDBOX_TIMEOUT_MS = Math.max(60_000, Math.floor(STEP_DEADLINE_MS / 3));

/**
 * The host tools a sandbox can run (`zeroclaw/CONTRACT.md` §3): the chain reads and the agent's own
 * store. Nothing else of the catalogue is compiled into the Lath build — the web tools are internet
 * access, and the sandbox is air-gapped.
 */
export const SANDBOX_TOOL_NAMES = [...CHAIN_TOOL_NAMES, ...STORE_TOOL_NAMES];

/**
 * Why a policy's tools cannot run in a sandbox, or `null`. `who` names whose policy it is, because a
 * refusal on a team names one member of several. The retired `hire` is not a refusal: it answers
 * only that it is gone, the sandbox has no way to offer it, and dropping it takes nothing a model
 * could use. Every other name the sandbox cannot run is — a `web.*` tool, the older spelling
 * `lattice.verify_chain` — with the posture's own sentence, so the owner reads which tool and why.
 *
 * Pure, so `checkLoopStart` can refuse a start with it before anything is written.
 */
export function sandboxToolRefusal(named: readonly string[] | undefined, who: string): string | null {
  for (const tool of named ?? []) {
    if (!TOOL_NAMES.includes(tool) || RETIRED_TOOL_NAMES.includes(tool)) continue;
    try {
      allowedWireTools([tool]);
    } catch (e) {
      if (PostureRefused.is(e)) return `${e.message} (${who})`;
      throw e;
    }
  }
  return null;
}

/**
 * Why a policy's tools cannot run in a loop's sandbox — `checkLoopStart`'s tool refusal, restated
 * over what a deploy's prepare has, which is the policy and the checked request rather than a
 * deployed loop agent. Teams are not in this build, so the checked request carries no team slots to
 * hold to it; `checked` stays in the signature for callers.
 */
export function loopToolRefusal(
  tools: readonly string[] | undefined,
  who: string,
  _checked: LoopRequest
): string | null {
  return sandboxToolRefusal(tools, who) ?? null;
}

/**
 * The tools a sandboxed session of a policy is offered, in catalogue order. A policy that names
 * none gets the chain reads — the default list, less the web tools the sandbox cannot hold; the
 * opt-in store tools stay opt-in, for the hash reason in `OPT_IN_TOOL_NAMES`. A policy that names
 * some gets those the sandbox can run, and a `LoopRefused` for any it cannot.
 */
export function sandboxToolNames(named: readonly string[] | undefined, who: string): string[] {
  const refusal = sandboxToolRefusal(named, who);
  if (refusal) throw new LoopRefused(refusal);
  const asked = named && named.length > 0 ? named.filter((t) => TOOL_NAMES.includes(t)) : undefined;
  return asked
    ? SANDBOX_TOOL_NAMES.filter((n) => asked.includes(n))
    : SANDBOX_TOOL_NAMES.filter((n) => !OPT_IN_TOOL_NAMES.includes(n));
}

// ─── The sandbox's config: tools, caps and sources ─────

/**
 * The `sandbox` a start named, held to its shape, or a sentence saying why it is not one.
 *
 * Normalised before anything is hashed, on the rule `workers` and `gate` follow: a key that says
 * what the host's default already is — `chain: true`, a cap equal to the host's, an empty source
 * list — is dropped, and a config left with no keys is no config at all. So a form that opened the
 * section and changed nothing, and an API caller that spells out the defaults, both start the loop
 * a start without `sandbox` starts, with the same policy, template and posture bytes.
 *
 * Whether the store switch widens past the agent's policy needs the agent, so `checkLoopStart`
 * asks that; this is the half that needs nothing but the body.
 */
/**
 * The sandbox config a body asks for, read under either key. `room` is the key's older name, and a
 * loop form left open in a browser, or a script written against the older API, may still send it:
 * read as `sandbox` only, its loop would start without the switches and sources it was written with,
 * and say nothing. `sandbox` wins when both are present; only `sandbox` is ever written.
 */
export function sandboxOf(v: { sandbox?: unknown; room?: unknown } | null | undefined): unknown {
  return v?.sandbox !== undefined ? v.sandbox : v?.room;
}

export function checkSandboxConfig(v: unknown): { sandbox?: SandboxConfig } | { error: string } {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return { error: "sandbox must be an object" };
  const asked = v as Record<string, unknown>;
  const unknown = Object.keys(asked).filter((k) => !["tools", "maxBytes", "maxFiles", "sources"].includes(k));
  if (unknown.length) {
    return { error: `sandbox has no ${unknown.join(", ")}; it takes tools, maxBytes, maxFiles and sources` };
  }
  const sandbox: SandboxConfig = {};

  if (asked.tools !== undefined && asked.tools !== null) {
    if (typeof asked.tools !== "object" || Array.isArray(asked.tools)) {
      return { error: "sandbox.tools must be an object of switches" };
    }
    const t = asked.tools as Record<string, unknown>;
    const extra = Object.keys(t).filter((k) => k !== "chain" && k !== "store");
    // _Files_ is not a switch: the workspace is where sources land and what replay hashes.
    if (extra.length) return { error: `sandbox.tools switches chain and store only, not ${extra.join(", ")}` };
    for (const k of ["chain", "store"] as const) {
      if (t[k] !== undefined && typeof t[k] !== "boolean") return { error: `sandbox.tools.${k} is on or off` };
    }
    const tools: NonNullable<SandboxConfig["tools"]> = {};
    // `chain: true` is the default and cannot widen anything (the switch only takes chain reads
    // away), so it is dropped rather than hashed as a second spelling of the absent key.
    if (t.chain === false) tools.chain = false;
    // Both values of the store switch are kept: `false` takes the store away from an agent
    // deployed with it, and `true` is the owner saying the sandbox should have it, which
    // `checkLoopStart` holds against the agent's policy — it narrows, never widens.
    if (typeof t.store === "boolean") tools.store = t.store;
    if (Object.keys(tools).length) sandbox.tools = tools;
  }

  // The workspace cap, lowered only (the host's cap is the ceiling). A cap equal to the host's is the
  // host's and dropped, so it hashes as no sandbox at all. A lower one is kept: every sandbox of the
  // loop commits it in its posture's `workspace` key and the walk after each session holds the sandbox to
  // it (`sandboxWorkspace`, `runtime/src/zeroclaw/posture.ts`), so the limit the owner asked for and
  // the page shows is the one applied.
  for (const [k, host] of [
    ["maxBytes", WORKSPACE_MAX_BYTES],
    ["maxFiles", WORKSPACE_MAX_FILES],
  ] as const) {
    const raw = asked[k];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
      return { error: `sandbox.${k} must be a positive whole number` };
    }
    if (raw > host) return { error: `sandbox.${k} can lower the host's cap of ${host}, never raise it` };
    if (raw < host) sandbox[k] = raw;
  }

  if (asked.sources !== undefined && asked.sources !== null) {
    try {
      const sources = parseSourceInputs(asked.sources);
      if (sources.length) sandbox.sources = sources;
    } catch (e) {
      if (e instanceof SourcesRefused) return { error: e.message };
      throw e;
    }
  }
  return Object.keys(sandbox).length ? { sandbox } : {};
}

/**
 * The workspace cap a loop's sandbox config lowers, as `withSandbox` and `ZeroClawRuntime` take it,
 * or `undefined` when it lowers nothing. Read from the record at every step rather than kept
 * beside it, so session A, each member, the synthesis and the member policies the orchestrator's
 * policy names all commit one cap. A bound equal to the host's is left out even if a record holds
 * it (`checkSandboxConfig` drops it, but a record is data): the posture's bytes at the host's cap do
 * not depend on how the cap was spelled, and a loop with no cap passes no key at all.
 */
export function sandboxWorkspace(
  config: SandboxConfig | undefined
): { maxBytes?: number; maxFiles?: number } | undefined {
  const out: { maxBytes?: number; maxFiles?: number } = {};
  if (config?.maxBytes !== undefined && config.maxBytes < WORKSPACE_MAX_BYTES) out.maxBytes = config.maxBytes;
  if (config?.maxFiles !== undefined && config.maxFiles < WORKSPACE_MAX_FILES) out.maxFiles = config.maxFiles;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The tools a sandbox config leaves of a list the sandbox could already run: chain reads off when the
 * owner switched them off, the store off when the owner switched it off, and nothing added.
 * Applied after `sandboxToolNames`, so it only ever narrows what the policy names; a loop with no
 * config, or one that switched nothing, gets the list unchanged and so the same policy hash as a loop
 * without the switches.
 */
export function sandboxNarrowed(names: readonly string[], tools: SandboxConfig["tools"] | undefined): string[] {
  return names.filter(
    (n) =>
      !(tools?.chain === false && CHAIN_TOOL_NAMES.includes(n)) &&
      !(tools?.store === false && STORE_TOOL_NAMES.includes(n))
  );
}

/**
 * Why the store switch would widen the agent's policy, or `null`. On only for an agent whose
 * deployed policy already gives a sandbox the store: a switch narrows a policy and never widens it,
 * so a loop cannot run a tool its agent was not deployed with.
 */
export function storeSwitchRefusal(
  tools: SandboxConfig["tools"] | undefined,
  named: readonly string[] | undefined,
  who: string
): string | null {
  if (tools?.store !== true) return null;
  const has = sandboxToolNames(named, who).some((n) => STORE_TOOL_NAMES.includes(n));
  return has
    ? null
    : `${who} was deployed without the store tools, and the sandbox's store switch narrows its policy, never widens it`;
}

/**
 * Where a loop's sources are fetched to: beside its sandboxes under `LATH_ZEROCLAW_HOME`, never inside
 * a workspace (a sandbox could write the copy it is seeded from) and never under `LATH_TRACE_DIR`
 * (the blob route serves that, and these files are in clear). `prepareLoopStart` asks
 * `zeroclawReadiness` before it fetches, so a home inside the trace directory — or a console that
 * could run no step at all — is refused before a byte is written here.
 */
export function fetchedSourcesDir(loopId: string, home: string = zeroclawHome()): string {
  return path.join(home, "loops", loopId, "sources.fetched");
}

/** A fetch nothing will run on — a start refused after it — removed, so it does not sit in the home for good. */
export function discardFetchedSources(loopId: string, home: string = zeroclawHome()): void {
  fs.rmSync(fetchedSourcesDir(loopId, home), { recursive: true, force: true });
  // The loop's directory only if the fetch was all that was in it: a started loop's sandboxes are not ours to remove.
  try {
    fs.rmdirSync(path.join(home, "loops", loopId));
  } catch {
    /* not empty, or not there */
  }
}

/**
 * The loop's sources for a step: the manifest, read back from the loop agent's trace store by the
 * hash the record keeps and checked against it, and the directory it was fetched to. `undefined`
 * for a loop with no sources.
 *
 * A console restart keeps the record and, normally, the directory; a directory that is gone is a
 * refusal with the reason, never a second fetch. A pinned commit or slot could be fetched again to
 * the same bytes, but a URL may answer different bytes now, and the sandbox seeds and checks every
 * file against the manifest anyway — so a re-fetch would either fail that check or be a partial
 * story told differently per kind. The owner starts the loop again, which fetches afresh.
 */
export async function loopSources(
  loop: Pick<LoopRecord, "id" | "sandbox">,
  home: string,
  traces: TraceStore
): Promise<{ manifest: SourcesManifest; dir: string } | undefined> {
  const hash = loop.sandbox?.sourcesHash;
  if (!hash) return undefined;
  const dir = fetchedSourcesDir(loop.id, home);
  if (!fs.existsSync(dir)) {
    throw new LoopRefused(
      `this loop's sources were fetched once, when it started, to ${dir}, and that directory is gone; ` +
        "a step is not run on sources fetched again, because a URL may now answer other bytes. Start the loop again"
    );
  }
  const bytes = await traces.get(Uint8Array.from(Buffer.from(hash, "hex"))).catch(() => null);
  const manifest = bytes ? decodeSourcesManifest(bytes) : null;
  if (!manifest || sourcesHash(manifest) !== hash) {
    throw new LoopRefused(
      `this loop's sources manifest ${hash.slice(0, 12)}… cannot be read back from its trace store, ` +
        "so no sandbox can be seeded with what the start committed. Start the loop again"
    );
  }
  return { manifest, dir };
}

export type ZeroClawReadiness = { ok: true; binary: ZeroClawBinary; home: string } | { ok: false; reason: string };

/**
 * Whether this console can run a loop step at all: a Lath-patched binary that answers, a wrapper
 * that starts (`resolveZeroClaw`), and a `LATH_ZEROCLAW_HOME` outside the trace directory (a
 * workspace path bug must not land files in the store `/api/traces` serves). `POST /api/loops`
 * refuses a start with the reason; a running loop's step is refused with it (`sandboxFor`). There is
 * no answer that means *run it in-process instead*.
 */
export function zeroclawReadiness(env: NodeJS.ProcessEnv = process.env): ZeroClawReadiness {
  try {
    const binary = resolveZeroClaw({ bin: env.LATH_ZEROCLAW_BIN });
    const home = zeroclawHome(env);
    if (pathInside(home, TRACE_DIR)) {
      return {
        ok: false,
        reason: `LATH_ZEROCLAW_HOME (${home}) is inside LATH_TRACE_DIR (${TRACE_DIR}); a sandbox's workspace must never be in the store the blob route serves`,
      };
    }
    return { ok: true, binary, home };
  } catch (e) {
    if (ZeroClawUnavailable.is(e)) return { ok: false, reason: e.reason };
    throw e;
  }
}

/** The sandbox a step runs in, or the `LoopRefused` that stops the loop with the reason. */
export function sandboxFor(): { binary: ZeroClawBinary; home: string } {
  const ready = zeroclawReadiness();
  if ("reason" in ready) throw new LoopRefused(ready.reason);
  return ready;
}

/**
 * The scripted walk as a sandbox's model must write it: the tools by their wire names (`solana_slot`).
 * The in-process runtime maps a dotted name back itself (`toolName`), so its walk names `solana.slot`;
 * a sandbox's registry holds only the wire names ZeroClaw was configured with, and would answer a
 * dotted one `Unknown tool` — an unbilled step would then anchor two 404s instead of reading the
 * cluster. The ids on the chain are the dotted ones either way.
 */
export function sandboxTurns(turns: ScriptTurn[]): ScriptTurn[] {
  return turns.map((t) =>
    t.calls ? { ...t, calls: t.calls.map((c) => ({ ...c, name: c.name.replace(/\./g, "_") })) } : t
  );
}

/**
 * One replay record as the row keeps it: every key the runtime hashed and nothing else, copied so the
 * row does not share the runtime's arrays. `contextWindow` only when the record has one, so a record
 * without it re-hashes to the bytes it was stored under.
 */
function replayKept(r: NonNullable<ZeroClawSessionReport["replay"]>): ZeroClawReplayRecord {
  return {
    v: r.v,
    binarySha256: r.binarySha256,
    postureHash: r.postureHash,
    messageHash: r.messageHash,
    workspacePath: r.workspacePath,
    tz: r.tz,
    locale: r.locale,
    now: r.now,
    workspaceBefore: r.workspaceBefore,
    workspaceAfter: r.workspaceAfter,
    seqs: [...r.seqs],
    ...(r.contextWindow !== undefined ? { contextWindow: r.contextWindow } : {}),
  };
}

/**
 * What a sandboxed step leaves on its row (`ZeroClawStepRecord`, the ZeroClaw tab's contract):
 * hashes, the posture, sizes, the tool Actions by seq. Never a token — the TOML carries
 * `<step token>` — and never prompt text: the message is committed by its hash.
 */
export function zeroclawStepRecord(r: ZeroClawSessionReport): ZeroClawStepRecord {
  return {
    wrapper: r.wrapper,
    platform: r.platform === "darwin" ? "macos" : "linux",
    binarySha256: r.binarySha256,
    postureHash: r.postureHash,
    postureJson: r.postureJson,
    ...(r.postureToml ? { postureToml: r.postureToml } : {}),
    ...(r.wrapperProfile ? { wrapperProfile: r.wrapperProfile } : {}),
    policyDocument: r.policyDocument,
    ...(r.genesisSeq ? { genesisSeq: r.genesisSeq } : {}),
    actions: r.actions.map((a) => ({ seq: a.seq, tool: a.tool, status: a.status })),
    ...(r.replayHash ? { replayHash: r.replayHash } : {}),
    // The record whole — `v`, `now` and `contextWindow` included — so the tab can re-hash it against
    // `replayHash` before it says _replayable_, and the Replay card can show the window; dropping the
    // three would leave no kept record that could be re-hashed. An older synthesizing team step kept
    // both its records as an array and its synthesis's outcome beside them; this build runs no
    // synthesis, so a row it writes keeps one record, and the tab still reads the rows that kept two.
    ...(r.replay ? { replay: replayKept(r.replay) } : {}),
    ...(r.workspace ? { workspace: { ...r.workspace } } : {}),
    ...(r.refused ? { refused: r.refused } : {}),
    // The sources the sandbox was seeded with: the hash the posture commits and the manifest it names,
    // for the tab's Sources card to re-hash. Absent on a loop with none, so every row recorded without
    // sources keeps its bytes.
    ...(r.sources ? { sources: { hash: r.sources.hash, manifest: r.sources.manifest } } : {}),
  };
}

/**
 * The step row without its sandbox's four texts — the posture JSON, the TOML, the wrapper profile and
 * the policy document. They are a few kilobytes a step and the tab reads them off the newest row
 * only, so older rows keep the hashes and sizes and drop the bytes; `/api/loops`, which is open and
 * renders none of them, drops them from every row. The TOML and the wrapper profile also name the
 * host's binary, directories and sockets, so the ZeroClaw routes serve neither (`HOST_PATHS_WITHHELD`).
 */
export function withoutSandboxTexts(row: LoopStepSummary): LoopStepSummary {
  // Each member's sandbox on an older team row carries the same four texts, because members keep their
  // records, and they go for the same reasons session A's do: the tab reads them through its own route.
  const members = row.members?.some((m) => m.zeroclaw)
    ? row.members.map((m) => (m.zeroclaw ? { ...m, zeroclaw: sandboxRecordWithoutTexts(m.zeroclaw) } : m))
    : row.members;
  if (!row.zeroclaw && members === row.members) return row;
  return {
    ...row,
    ...(row.zeroclaw ? { zeroclaw: sandboxRecordWithoutTexts(row.zeroclaw) } : {}),
    ...(members ? { members } : {}),
  };
}

function sandboxRecordWithoutTexts(r: ZeroClawStepRecord): ZeroClawStepRecord {
  const { postureJson: _j, postureToml: _t, wrapperProfile: _w, policyDocument: _p, ...rest } = r;
  return rest;
}
