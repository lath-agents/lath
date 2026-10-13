/**
 * `ZeroClawRuntime`: an `AgentRuntime` whose turns run in a sandbox — one Lath-patched ZeroClaw
 * process per session, spawned under the host's wrapper, air-gapped but for two Unix sockets
 * (`zeroclaw/CONTRACT.md`).
 *
 * Only `runTurns` changes. The Genesis before it and the Resolution after it are `start()`'s, written
 * by the same statements as an in-process session, and every record the sandbox causes is written by
 * the runtime's own paths: a model call is `paidChat` (through the metering proxy, `proxy.ts`), a
 * host tool is `callTool` (through the tools socket, `host-tools.ts`), and a call the sandbox ran or
 * refused on its own is `recordToolAction`. So a sandboxed session and an in-process one differ on
 * the chain in exactly two places: the Genesis's `policy_version_hash`, which commits the posture
 * (`policy.sandbox`), and the tool ids of what ran inside the sandbox (`zc.*`).
 *
 * One session, one sandbox:
 *
 * ```text
 * <home>/loops/<sandbox>/work              the loop's workspace; persists across its steps
 * <home>/loops/<sandbox>/steps/<id>/cfg    the session's fresh config dir: config.toml, then data/
 * <home>/loops/<sandbox>/steps/<id>/m.sock the metering proxy
 * <home>/loops/<sandbox>/steps/<id>/t.sock the host tools
 * ```
 *
 * `<home>` is `LATH_ZEROCLAW_HOME`, never under the trace directory and short, because a
 * socket path the binary cannot connect to would fail the step at its first model call, after the
 * Genesis; `socketPathOk` refuses it before anything is spawned. `<id>` is a hash of the session id,
 * so a session run again (a retried step) gets the same directory, cleared first. The step
 * directory is removed when the session ends: its one record worth keeping, the runtime trace, is
 * stored as a blob, and a socket or a token left behind is something a later sandbox could find.
 *
 * **A loop with sources** (`ZeroClawSandboxOptions.sources`) gives every sandbox of the loop —
 * the orchestrator's and each member's — the same `<work>/sources/`: copied from the fetched
 * directory the first time a sandbox opens, checked against the manifest on every spawn after that,
 * read-only on disk and in the wrapper. The posture commits the manifest's hash, the step message
 * opens with its index (`sandboxMessageText`), the workspace cap stops counting what is under it, and
 * none of its files is stored again as a step's blob: they are the manifest's. A loop whose sources
 * include a Solana account is also told, in every session's message, what changed on chain since the
 * pin (`ZeroClawSandboxOptions.sourcesNote`, `withSourcesNote`) — a message, never a file, because a
 * file the host wrote into the workspace between steps would break the `workspaceBefore` link.
 *
 * What the host does after the sandbox exits, in this order: closes both sockets; anchors every call
 * the sandbox asked for and never reported back (from the flushed trace or as a 500); hashes
 * the workspace (under the posture's cap) and stores each new file, the tree, the `-m` message
 * and the trace as blobs; then decides the outcome. A failure on either socket is the reason, kept
 * as thrown (a `BudgetExceeded` still resolves the session `aborted`); otherwise a non-zero exit or
 * an empty stdout fails the step with the tail of stderr. Stdout is the answer. A failure that
 * would recur on every later step — a workspace the tree refuses, sources that do not check, a
 * socket path too long, a wrapper that will not start — is thrown as `SandboxRefused` and handed
 * back on the result as `sandboxRefused`, so `LoopRunner` stops the loop with the reason instead of
 * paying for the same refusal until `maxSteps`.
 *
 * After `start()` returns — after the closing epoch flush, the only point at which every Action of
 * the session has a seq — the replay record (`replay.ts`) is written and its hash set
 * on `SessionResult.replayHash`, which `LoopRunner` commits as the manifest's thirteenth key — or,
 * when this runtime is a team member's sandbox, as the eighth key of that member's object in
 * the manifest's `members`. A member runs one session a step, so its hash is always its own
 * record, never a fold.
 *
 * **One sandbox per session, one record per step.** A team step, which is on the roadmap, would run
 * its synthesis as a second session and fold both records into the step's `replayHash`, as
 * `sha256(canonicalJson([recordA, recordB]))`. This build runs no team, so no second session starts
 * here and every step commits exactly the record `replay.ts` defines; the audit still re-hashes the
 * two-record arrays that team steps on older chains committed (`sdk/src/step-sandbox.ts`).
 *
 * The spawner is injectable for tests only (`ZeroClawSandboxOptions.spawner`): a Node stub that plays
 * the binary over the two sockets, unwrapped. Nothing in production passes one, and there is no
 * environment variable, flag or fallback that runs a session outside the wrapper.
 *
 * Node only: it spawns, listens and reads the filesystem. Exported from `@lath/runtime` for the
 * console's loop scheduler, which is server code; nothing in the browser reaches it.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventKind, hex, sha256, utf8, type EpochCommit, type LogResult } from "@lath/sdk";
import type { ChatMessage, ChatRequest, ChatResult } from "../openrouter";
import { errorText } from "../errors";
import { canonicalJson, toRuntimePolicy, type RuntimePolicy } from "../policy";
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type SessionCtx,
  type SessionResult,
  type StartOptions,
  type TurnsOutcome,
  undeclaredToolId,
} from "../runtime";
import { openRouterContextWindow, type ContextWindowLookup } from "./context-window";
import { startHostTools, type HostToolsServer } from "./host-tools";
import {
  HOST_TOOL_WIRE_NAMES,
  PostureRefused,
  bwrapArgs,
  lathPosture,
  lddLibs,
  postureHash,
  renderConfigToml,
  sandboxPaths,
  seatbeltProfile,
  socketPathOk,
  spawnSpec,
  wrapperKind,
  zeroclawArgv,
  type HostSandbox,
  type LathPosture,
  type PostureWorkspace,
  type SpawnSpec,
  type WrapperKind,
  type ZeroClawPlatform,
} from "./posture";
import { observedStatus, startModelProxy, type ModelProxy, type ObservedToolCall } from "./proxy";
import {
  replayRecord,
  replayRecordBytes,
  replayHash as recordHash,
  replayMessageBytes,
  replayMessageHash,
  sessionActionSeqs,
  zeroclawNow,
  type ReplayRecord,
} from "./replay";
import {
  SOURCES_MAX_BYTES,
  SOURCES_MAX_FILES,
  decodeSourcesManifest,
  sourcesHash,
  sourcesIndex,
  sourcesManifestBytes,
  sourcesRefreshNote,
  sourcesRefreshUnread,
  type SourcesManifest,
} from "./sources";
import {
  checkSources,
  hashWorkspace,
  readRegular,
  readWorkspaceFile,
  refuseSkillsEntry,
  seedSources,
  sourcesEntries,
  workspaceChanges,
  WorkspaceRefused,
  type WorkspaceTree,
  type WorkspaceWalkLimits,
} from "./workspace";

// ─── The binary ─────────────────────────────────────────────────────────────

/** There is no working Lath-patched binary or wrapper on this host; `reason` is the sentence. */
export class ZeroClawUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ZeroClawUnavailable";
  }
  static is(e: unknown): e is ZeroClawUnavailable {
    return e instanceof Error && e.name === "ZeroClawUnavailable";
  }
}

/**
 * A sandboxed session failed for a reason that will fail every later step the same way: a workspace
 * the tree refuses (over the cap, a symlink or a case clash the sandbox wrote — nothing resets the
 * workspace between steps, so the next step's `workspaceBefore` walk refuses it again), sources that
 * no longer check, a socket path the binary cannot reach, a wrapper that would not start the binary
 * (a wrapper or binary that broke after `resolveZeroClaw` cached its success), or a binary whose bytes
 * are no longer the ones the runtime committed (rebuilt in place since it was resolved,
 * `binaryUnchanged`).
 *
 * The session still resolves `failed` with `reason` as its message, byte for byte what any other
 * failed step says, so the chain records the failure as it would any other. What differs is the
 * loop: `ZeroClawRuntime.start` hands the reason back as `sandboxRefused` on the session result,
 * and `LoopRunner` stops with `sandbox` after the step instead of counting it as one failed session
 * and paying for the same refusal every step until `maxSteps`. Nothing wipes the workspace: a wipe
 * breaks the `workspaceBefore` link a replay checks, and the owner should see why the loop stopped.
 */
export class SandboxRefused extends Error {
  constructor(readonly kind: "workspace" | "sources" | "socket" | "wrapper" | "binary", readonly reason: string) {
    super(reason);
    this.name = "SandboxRefused";
  }
  static is(e: unknown): e is SandboxRefused {
    return e instanceof Error && e.name === "SandboxRefused";
  }
}

/**
 * What `ZeroClawRuntime.start` resolves to: a `SessionResult`, and — only when the session's sandbox
 * was refused for a reason that recurs (`SandboxRefused`) — that reason. Absent on every other
 * session, so a caller that does not know the key reads a plain `SessionResult`.
 */
export interface SandboxSessionResult extends SessionResult {
  sandboxRefused?: string;
}

/** A workspace walk that refused the tree, as the recurring refusal it is; anything else as thrown. */
function asRefusal(e: unknown, kind: "workspace" | "sources"): unknown {
  return e instanceof WorkspaceRefused ? new SandboxRefused(kind, e.message) : e;
}

/** A binary the host checked and may spawn: its bytes, what it says it is, and the wrapper it runs under. */
export interface ZeroClawBinary {
  /** Absolute, resolved path of the file spawned. */
  path: string;
  /** `sha256` of the file, hex — what the posture commits. */
  sha256: string;
  /** The patch set it was built from, as `zeroclaw/build.sh` records it. */
  patchSet: string;
  /** The first line `--version` printed. */
  version: string;
  platform: ZeroClawPlatform;
  wrapper: WrapperKind;
  /** The wrapper's absolute path: `/usr/bin/sandbox-exec`, or the `bwrap` found on `PATH`. */
  wrapperPath: string;
  /** On Linux, the libraries the binary's loader needs (`ldd`), each mounted at its own path. */
  libs: string[];
}

export interface ResolveZeroClawOptions {
  /** `LATH_ZEROCLAW_BIN`. Unset: `zeroclaw` on `pathEnv`. */
  bin?: string;
  /** Where to look for `zeroclaw` (and `bwrap`) when `bin` is unset: a `PATH` string. */
  pathEnv?: string;
  platform?: string;
  /** The wrapper to probe instead of the platform's default; the refusal tests point it at a dud. */
  wrapperPath?: string;
}

/**
 * An environment given whole, as the spawn's only one. Typed through `unknown` because a Next
 * build augments `ProcessEnv` with a required `NODE_ENV`, which is exactly the kind of inherited
 * variable these spawns must not carry.
 */
function exactEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return env as unknown as NodeJS.ProcessEnv;
}

/** How long `--version` and the wrapper probe may take before the answer is *not answering*. */
const PROBE_TIMEOUT_MS = 5_000;

/** Successes only, keyed by the file's identity: a binary rebuilt in place is checked again. */
let resolved: { key: string; binary: ZeroClawBinary } | null = null;

/** The identity of a file as far as a rebuild in place changes it: `cp` keeps the inode but moves the mtime. */
function fileStamp(st: fs.Stats): string {
  return `${st.size}:${st.mtimeMs}:${st.ino}`;
}

/** The last stamp at which each binary path was hashed, and the hash: a spawn re-hashes only on a change. */
const hashedAt = new Map<string, { stamp: string; sha256: string }>();

/**
 * Refuses a spawn whose binary is not the bytes the runtime committed. The posture's
 * `binarySha256` is read at `resolveZeroClaw`, but the sandbox is spawned by path, so a rebuild in
 * place (`zeroclaw/build.sh` copying over `.build/zeroclaw`) between the readiness check and a spawn
 * would have the Genesis commit the old hash while new bytes run. A file whose size, mtime or inode
 * moved since it was last hashed is hashed again, and a hash that differs is `SandboxRefused`: the
 * runtime's committed hash never changes, so every later step would be refused the same way, and
 * the loop stops rather than run unattested bytes. What remains is the instant between this check
 * and the exec, which a host rebuilding under a running loop can still race; the check closes the
 * ordinary case, a rebuild minutes before the next step.
 */
export function binaryUnchanged(binary: Pick<ZeroClawBinary, "path" | "sha256">): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(binary.path);
  } catch (e) {
    throw new SandboxRefused("binary", `the ZeroClaw binary ${binary.path} is gone: ${errorText(e)}`);
  }
  const stamp = fileStamp(st);
  const seen = hashedAt.get(binary.path);
  let sha = seen?.stamp === stamp ? seen.sha256 : undefined;
  if (sha === undefined) {
    sha = createHash("sha256").update(fs.readFileSync(binary.path)).digest("hex");
    hashedAt.set(binary.path, { stamp, sha256: sha });
  }
  if (sha !== binary.sha256) {
    throw new SandboxRefused(
      "binary",
      `the ZeroClaw binary ${binary.path} changed since this loop resolved it (its bytes are ${sha.slice(0, 12)}…, ` +
        `the posture commits ${binary.sha256.slice(0, 12)}…); start the loop again so its Genesis names what runs`
    );
  }
}

/** The first regular file named `cmd` on `pathEnv`. Exported so the tab's host read finds the binary the start would. */
export function onPath(cmd: string, pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

function tail(text: string, n = 400): string {
  const t = text.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** The patch set `build.sh` wrote beside the binary, when the record names this binary's bytes. */
function buildRecord(files: string[], sha: string): { patchSet?: string; other?: string } {
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const line = text.split("\n").find((l) => l.trim()) ?? "";
    const named = line.trim().split(/\s+/)[0];
    const patchSet = /(?:^|\s)patchset=(\S+)/.exec(line)?.[1];
    if (named !== sha) return { other: named };
    if (patchSet) return { patchSet };
  }
  return {};
}

/**
 * The Lath-patched binary this host would spawn, checked, or a `ZeroClawUnavailable` naming what
 * is missing: no binary (`LATH_ZEROCLAW_BIN` unset and no `zeroclaw` on `PATH`), a file that is not
 * executable, a `--version` that does not answer, a binary that is not the Lath build, a platform
 * with no wrapper, or a wrapper that cannot start (`bwrap` without user namespaces). The
 * refusal is the loop's: `/api/loops` answers it at start, and a running loop's step fails with it.
 *
 * _The Lath build_ is read from the record `zeroclaw/build.sh` writes beside the binary
 * (`<binary>.sha256`: the hash, then `patchset=<hash of zeroclaw/patches/*>`), which must name
 * this file's bytes, or else from a `patchset=` token in `--version`. Either gives the posture its
 * `patchSet`. The check is a usability one: the air gap does not rest on it. A stock binary would
 * still be spawned under the same wrapper, which denies it every socket but the two, so the worst
 * a mislabelled binary can do is fail its own step.
 *
 * `--version` runs unwrapped with an empty environment and stdin closed: it is the binary the
 * operator installed, asked its name, before any sandbox exists. Successful checks are cached until
 * the file changes; a refusal is not, so installing the binary takes effect on the next start.
 */
export function resolveZeroClaw(o: ResolveZeroClawOptions = {}): ZeroClawBinary {
  const platform = o.platform ?? process.platform;
  const given = o.bin?.trim() || onPath("zeroclaw", o.pathEnv ?? process.env.PATH);
  if (!given) {
    throw new ZeroClawUnavailable(
      "no Lath-patched ZeroClaw on this console: set LATH_ZEROCLAW_BIN to the binary zeroclaw/build.sh builds " +
        "(zeroclaw/.build/zeroclaw), or put it on PATH as zeroclaw; every loop step runs in a sandbox, and there is " +
        "no in-process fallback"
    );
  }
  const abs = path.resolve(given);
  let real: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync(abs);
    st = fs.statSync(real);
  } catch {
    throw new ZeroClawUnavailable(`the ZeroClaw binary ${abs} does not exist`);
  }
  if (!st.isFile()) throw new ZeroClawUnavailable(`the ZeroClaw binary ${abs} is not a file`);
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new ZeroClawUnavailable(`the ZeroClaw binary ${abs} is not executable`);
  }
  let kind: WrapperKind;
  try {
    kind = wrapperKind(platform);
  } catch (e) {
    throw new ZeroClawUnavailable((e as Error).message);
  }
  const key = `${real}:${st.size}:${st.mtimeMs}:${st.ino}:${platform}:${o.wrapperPath ?? ""}`;
  if (resolved?.key === key) return resolved.binary;

  const sha = createHash("sha256").update(fs.readFileSync(real)).digest("hex");
  hashedAt.set(real, { stamp: fileStamp(st), sha256: sha });
  const v = spawnSync(real, ["--version"], {
    env: exactEnv({}),
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const version = (v.stdout ?? "").split("\n").find((l) => l.trim()) ?? "";
  if (v.error || v.status !== 0 || !version) {
    const why = v.error ? v.error.message : v.status === null ? `killed by ${v.signal}` : `exit ${v.status}`;
    throw new ZeroClawUnavailable(
      `${abs} --version did not answer (${why})${v.stderr ? `: ${tail(v.stderr)}` : ""}; it is not a working ZeroClaw`
    );
  }
  const record = buildRecord([`${abs}.sha256`, `${real}.sha256`], sha);
  if (record.other) {
    throw new ZeroClawUnavailable(
      `the build record beside ${abs} names another binary (${record.other.slice(0, 12)}…, this one is ` +
        `${sha.slice(0, 12)}…); rebuild it with zeroclaw/build.sh`
    );
  }
  const patchSet = record.patchSet ?? /(?:^|\s)patchset=(\S+)/.exec(v.stdout ?? "")?.[1];
  if (!patchSet) {
    throw new ZeroClawUnavailable(
      `${abs} is not the Lath build: no build record (${path.basename(abs)}.sha256, written by zeroclaw/build.sh) ` +
        "beside it, and its --version names no patch set"
    );
  }

  let wrapperPath: string;
  let libs: string[] = [];
  if (kind === "sandbox-exec") {
    wrapperPath = o.wrapperPath ?? "/usr/bin/sandbox-exec";
    const t = spawnSync(wrapperPath, ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      env: exactEnv({}),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (t.error || t.status !== 0) {
      throw new ZeroClawUnavailable(
        `sandbox-exec cannot start a profile on this host (${t.error?.message ?? `exit ${t.status}`}` +
          `${t.stderr ? `: ${tail(t.stderr, 200)}` : ""}); a loop step runs air-gapped or not at all`
      );
    }
  } else {
    const found = o.wrapperPath ?? onPath("bwrap", `${o.pathEnv ?? process.env.PATH ?? ""}:/usr/bin:/bin`);
    if (!found) throw new ZeroClawUnavailable("no bwrap on this host; a loop step runs air-gapped or not at all");
    wrapperPath = found;
    // The same probe the air-gap test makes: a host that restricts unprivileged user namespaces
    // (Ubuntu 24.04's AppArmor default) cannot run the wrapper at all, and the loop is refused
    // rather than run unwrapped.
    const t = spawnSync(wrapperPath, ["--unshare-all", "--ro-bind", "/", "/", "true"], {
      env: exactEnv({ PATH: "/usr/bin:/bin" }),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (t.error || t.status !== 0) {
      throw new ZeroClawUnavailable(
        `bwrap cannot make namespaces on this host (${
          tail(t.stderr ?? "", 200) || t.error?.message || `exit ${t.status}`
        }); ` + "see kernel.apparmor_restrict_unprivileged_userns — a loop step runs air-gapped or not at all"
      );
    }
    // A static binary has no loader to mount; `ldd` says so and exits non-zero, which is not a refusal.
    const l = spawnSync("ldd", [real], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    if (l.status === 0) libs = lddLibs(l.stdout ?? "");
  }

  const binary: ZeroClawBinary = {
    path: real,
    sha256: sha,
    patchSet,
    version: version.trim(),
    platform: platform as ZeroClawPlatform,
    wrapper: kind,
    wrapperPath,
    libs,
  };
  resolved = { key, binary };
  return binary;
}

/**
 * `LATH_ZEROCLAW_HOME`, or its default: `~/.lath/zc`. Its own directory and short:
 * never under the trace directory, where a workspace path bug would land files in the store the
 * blob route serves, and short enough that a step's socket path fits what the binary can reach.
 */
export function zeroclawHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.LATH_ZEROCLAW_HOME?.trim();
  return path.resolve(set || path.join(os.homedir(), ".lath", "zc"));
}

/** Whether `child` is `parent` or inside it, lexically, after resolving both. */
export function pathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ─── The posture a policy commits ───────────────────────────────────────────

/**
 * The one posture for a session of this runtime: the policy's tool list as the wire names
 * ZeroClaw allows, `maxSteps` as `max_tool_iterations`, the binary's hash and patch set, and the
 * platform's wrapper. A tool the sandbox cannot run is a `PostureRefused` naming it. `workspace` is
 * the loop's lowered cap, absent for the host's.
 */
export function sandboxPosture(o: {
  toolAllowList: readonly string[];
  maxSteps?: number;
  binary: ZeroClawBinary;
  sources?: SourcesManifest;
  workspace?: PostureWorkspace;
}) {
  return lathPosture({
    toolAllowList: o.toolAllowList,
    maxSteps: o.maxSteps,
    binarySha256: o.binary.sha256,
    patchSet: o.binary.patchSet,
    platform: o.binary.platform,
    ...(o.workspace ? { workspace: o.workspace } : {}),
    ...(hasSources(o.sources)
      ? { sources: { hash: sourcesHash(o.sources), maxBytes: SOURCES_MAX_BYTES, maxFiles: SOURCES_MAX_FILES } }
      : {}),
  });
}

/**
 * A manifest that lists at least one source. An empty one is no sources: the sandbox gets no
 * `sources/` and the posture no key, so a loop whose owner opened the section and added nothing
 * runs, and hashes, exactly as one that never opened it.
 */
function hasSources(m: SourcesManifest | undefined): m is SourcesManifest {
  return m !== undefined && m.sources.length > 0;
}

/**
 * The policy with the posture in it, as the Genesis will commit it. A caller that has to name the
 * policy hash before the runtime exists — the orchestrator's `workers.slots[i].policyHash` names
 * each member's — builds it with this, so the hash it names is the one the member's Genesis writes.
 * `sources` is the loop's manifest, the same one every `ZeroClawRuntime` of the loop is given:
 * without it here the hash named would be of a posture the member's sandbox does not apply.
 * `workspace` is the loop's lowered cap, for the same reason: the sandbox enforces the cap its
 * posture commits, and the hash named must be of that posture.
 */
export function withSandbox(
  policy: RuntimePolicy,
  binary: ZeroClawBinary,
  maxSteps?: number,
  sources?: SourcesManifest,
  workspace?: PostureWorkspace
): RuntimePolicy {
  return {
    ...policy,
    sandbox: sandboxPosture({ toolAllowList: policy.toolAllowList, maxSteps, binary, sources, workspace }),
  };
}

/**
 * The single `-m` argument of a sandbox with sources: `sourcesIndex(manifest)`, then the step's
 * messages as `stepMessageText` renders them. The index goes first, before the policy's frame and
 * everything else `stepMessages` renders, because it is the one part that is the same in every step
 * and every member's sandbox of the loop — a byte-identical prefix is what a provider's prompt cache
 * keys on. Without sources it is `stepMessageText`.
 */
export function sandboxMessageText(messages: readonly ChatMessage[], sources?: SourcesManifest): string {
  const text = stepMessageText(messages);
  return hasSources(sources) ? `${sourcesIndex(sources)}\n${text}` : text;
}

/**
 * The step's messages with the _changed since pinned_ note (`sourcesRefreshNote`) as one system
 * message of its own: after the goal and the team, and before the memory and the prompt, which
 * `stepMessages` always puts last. So the session reads what its pinned sources say now, then where
 * the last step left off; and everything before the note — the index, the frame, the goal, the team —
 * stays the same bytes in every step, which is the prefix a prompt cache keys on. Without a note the
 * array is returned as it is, so nothing about a step with no Solana source moves.
 */
export function withSourcesNote(
  messages: readonly ChatMessage[],
  note: string | undefined,
  hasMemory: boolean
): ChatMessage[] {
  if (!note) return [...messages];
  const at = Math.max(0, messages.length - 1 - (hasMemory ? 1 : 0));
  return [...messages.slice(0, at), { role: "system", content: note }, ...messages.slice(at)];
}

// ─── The sandbox ───────────────────────────────────────────────────────────────

/** Test-only: what spawns the sandbox. Production spawns with `node:child_process`. */
export type ZeroClawSpawner = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ZeroClawSandboxOptions {
  binary: ZeroClawBinary;
  /** `LATH_ZEROCLAW_HOME`, resolved (`zeroclawHome`). */
  home: string;
  /**
   * The sandbox under `<home>/loops/`: the loop's id for its own agent, `<loopId>/m/<member>` for a
   * member, whose workspace is its own — members run in parallel, and one tree hashed while
   * another sandbox writes it would be a statement about no moment at all.
   */
  sandbox: string;
  /** Wall clock one session's process may run before it is killed. Default five minutes. */
  timeoutMs?: number;
  /** Test-only dependency injection; see the header. */
  spawner?: ZeroClawSpawner;
  /**
   * The loop's sources, fetched once at start. `dir` is a host directory
   * laid out as `<workspace>/sources/` will be — never inside a workspace, never under
   * `LATH_TRACE_DIR` — from which every sandbox of the loop is seeded read-only. Absent: a sandbox with
   * no `sources/`.
   */
  sources?: { manifest: SourcesManifest; dir: string };
  /**
   * The loop's workspace cap when the owner lowered it: committed in the posture's `workspace` key
   * and held by the walk after every session, like the default cap. Never above the default (the
   * posture refuses a raise); absent, the sandbox is held to the default cap.
   */
  workspace?: PostureWorkspace;
  /**
   * Where a step's model context window comes from (`context-window.ts`). Default: OpenRouter's
   * public model list, read when the console starts and again by a step while no read has succeeded,
   * with a table copied from that list for the console's models when it cannot be read. Injectable so
   * a test never reaches the network; a lookup that answers `undefined` renders the config without
   * `context_window`.
   */
  contextWindow?: ContextWindowLookup;
  /**
   * What changed on chain since the loop's Solana sources were pinned, as `sourcesRefreshNote`
   * renders it: asked once per session, before the sandbox is laid out, and put in the step's message
   * by `withSourcesNote`. The console hands every sandbox of a step one promise, read once for the
   * step (`api/_lib/sources-refresh.ts`), so every sandbox of the step is told the same thing. Only a
   * sandbox with sources asks; `undefined` adds nothing. A provider that throws is a note saying no
   * Solana source could be re-read, never a failed step.
   */
  sourcesNote?: () => Promise<string | undefined>;
}

export interface ZeroClawRuntimeOptions extends AgentRuntimeOptions {
  zeroclaw: ZeroClawSandboxOptions;
}

/**
 * What one sandboxed session left, for the console's step row and the ZeroClaw tab: hashes, the
 * posture, sizes. Never a token and never prompt text — the message is committed by its hash, and
 * the TOML carries `<step token>` where the sandbox's had one.
 */
export interface ZeroClawSessionReport {
  sessionId: string;
  platform: ZeroClawPlatform;
  wrapper: WrapperKind;
  binarySha256: string;
  patchSet: string;
  /** `sha256(postureJson)`, hex. */
  postureHash: string;
  /** `canonicalJson(policy.sandbox)`: the bytes the policy document folds in. */
  postureJson: string;
  /** The `config.toml` the sandbox was given, with both tokens replaced by `<step token>`. */
  postureToml?: string;
  /** The `sandbox-exec` profile, or the `bwrap` arguments one per line, as applied. */
  wrapperProfile?: string;
  /** The whole policy document the Genesis hashed. */
  policyDocument: string;
  genesisSeq?: string;
  /** Every tool Action of the session, named — `zc.*`, host tools, refused and invented ids — by seq. */
  actions: { seq: string; tool: string; status: number }[];
  /** The canonical tree after the session, against the posture's cap. */
  workspace?: { bytes: number; files: number; capBytes: number; capFiles: number };
  /** The step's `replayHash`: this session's record (header). */
  replayHash?: string;
  /** This session's own record. */
  replay?: ReplayRecord;
  messageHash?: string;
  traceHash?: string;
  /**
   * Why the runtime trace the sandbox left was not read, when one was there and the host refused it:
   * a symlink, a FIFO, a hard link, a file over 8 MiB (`readTrace`). The step has no `traceHash` then.
   */
  traceRefused?: string;
  /** The sources the sandbox was seeded with, when the loop has any: the posture's hash and the manifest it names. */
  sources?: { hash: string; manifest: SourcesManifest };
  /** Why the sandbox failed the session, in the host's words. */
  refused?: string;
}

/**
 * The single `-m` argument a sandbox is given: every message the in-process runtime would have sent
 * (`stepMessages`, the same array, the same order), their contents joined by a blank line. ZeroClaw
 * writes its own system prompt and puts this in the one user turn it opens with, so the policy's
 * frame, the goal, the team, the wake and the memory reach the model in the in-process order.
 */
export function stepMessageText(messages: readonly ChatMessage[]): string {
  return messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n");
}

/**
 * Linux caps one argument at `MAX_ARG_STRLEN` (32 pages, 131 072 bytes with its NUL), and the
 * message is one argument; macOS's limit is on the whole argv and environment and is larger. The
 * lower one, so a step that would fail to exec on one platform fails the same way on both — with
 * the size named, before a sandbox is spawned.
 */
export const MAX_MESSAGE_BYTES = 131_071;

const DEFAULT_SANDBOX_TIMEOUT_MS = 5 * 60_000;
/** Stdout is the answer; a sandbox that writes more than this is killed and fails its step. */
const MAX_STDOUT_BYTES = 1024 * 1024;
const STDERR_KEPT = 4096;
/** The trace is a blob of the step's bundle; one larger than this is left out, and said so (`traceRefused`). */
const MAX_TRACE_BYTES = 8 * 1024 * 1024;
/** Where the flushed runtime trace is (patch 0006), under the step's config dir. */
const TRACE_FILE = ["data", "state", "runtime-trace.jsonl"];
/** The result of a call the sandbox asked for and never reported back. */
export const NOT_REPORTED_BACK = "not reported back before the step ended";
const SANDBOX_NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** One session's sandbox while it is open and until its report is written. */
interface SandboxRun {
  sessionId: string;
  now?: string;
  messageHash?: string;
  inside?: HostSandbox;
  toml?: string;
  /** The `context_window` `toml` was rendered with, when it carried one: the replay record's `contextWindow`. */
  contextWindow?: number;
  profile?: string;
  before?: WorkspaceTree;
  after?: WorkspaceTree;
  /** Observed calls the proxy resolved, by the name the model called: `anchorUnreported`'s positions. */
  resolved: Map<string, number>;
  /** Every tool id this session recorded, for naming its Actions by their on-chain hash. */
  names: Set<string>;
  traceHash?: string;
  traceRefused?: string;
  refused?: string;
  /**
   * The recurring refusal behind the session's failure (`SandboxRefused`), kept even when a socket's
   * failure is the reason the session resolved with: a workspace the tree refused after a step whose
   * charge also failed is still a workspace every later step will be refused on.
   */
  sandboxRefused?: string;
}

interface SandboxExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
  aborted: boolean;
  overflow: boolean;
}

export class ZeroClawRuntime extends AgentRuntime {
  readonly posture: LathPosture;
  readonly binary: ZeroClawBinary;
  private readonly sandbox: Required<
    Omit<ZeroClawSandboxOptions, "spawner" | "binary" | "sources" | "workspace" | "contextWindow" | "sourcesNote">
  > & {
    spawner: ZeroClawSpawner;
    contextWindow: ContextWindowLookup;
  };
  private run?: SandboxRun;
  /** The last session of the step this runtime is on, kept for `stepReport`. */
  private last?: { report: ZeroClawSessionReport };
  /** The loop's sources, when it has any: what every session of this runtime seeds and checks. */
  private readonly sources?: { manifest: SourcesManifest; dir: string; hash: string };
  /** `ZeroClawSandboxOptions.sourcesNote`, kept only when the sandbox has sources to be told about. */
  private readonly sourcesNote?: () => Promise<string | undefined>;

  constructor(opts: ZeroClawRuntimeOptions) {
    super({ ...opts, policy: ZeroClawRuntime.sandboxed(opts) });
    this.binary = opts.zeroclaw.binary;
    this.posture = this.policy.sandbox!;
    if (
      !SANDBOX_NAME.test(opts.zeroclaw.sandbox) ||
      opts.zeroclaw.sandbox.split("/").some((s) => s === "." || s === "..")
    ) {
      throw new Error(`the sandbox name ${JSON.stringify(opts.zeroclaw.sandbox)} is not a plain relative path`);
    }
    this.sandbox = {
      home: path.resolve(opts.zeroclaw.home),
      sandbox: opts.zeroclaw.sandbox,
      timeoutMs: opts.zeroclaw.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      spawner: opts.zeroclaw.spawner ?? spawn,
      contextWindow: opts.zeroclaw.contextWindow ?? openRouterContextWindow,
    };
    const src = opts.zeroclaw.sources;
    if (hasSources(src?.manifest)) {
      this.sources = { ...ZeroClawRuntime.checkedSources(src!, this.sandbox.home), hash: this.posture.sources!.hash };
      this.sourcesNote = opts.zeroclaw.sourcesNote;
    }
  }

  /**
   * This session's _changed since pinned_ note, or `undefined` for none. A provider that throws does not
   * fail the step (a chain read is not the sandbox's to refuse on): every Solana source is then
   * reported as not re-read, with the reason, and the step runs on what it has pinned.
   */
  private async readSourcesNote(): Promise<string | undefined> {
    if (!this.sources || !this.sourcesNote) return undefined;
    try {
      return await this.sourcesNote();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return sourcesRefreshNote(sourcesRefreshUnread(this.sources.manifest, why));
    }
  }

  /**
   * The loop's sources, refused at construction — before a Genesis — when the sandbox could never be
   * seeded from them: a manifest that is not its own canonical bytes (so its hash would name
   * something else), one over the caps the posture commits, one whose paths cannot be laid out as
   * a tree, or a directory that is relative, inside a sandbox's workspace (where the sandbox could write
   * the copy it is seeded from) or missing.
   */
  private static checkedSources(
    src: { manifest: SourcesManifest; dir: string },
    home: string
  ): { manifest: SourcesManifest; dir: string } {
    if (decodeSourcesManifest(sourcesManifestBytes(src.manifest)) === null) {
      throw new Error("the sandbox's sources manifest is not a canonical lath.sources.v1 manifest");
    }
    let files = 0;
    let bytes = 0;
    for (const e of src.manifest.sources) {
      for (const f of e.files) {
        files++;
        bytes += f.size;
      }
    }
    if (files > SOURCES_MAX_FILES || bytes > SOURCES_MAX_BYTES) {
      throw new Error(
        `the sandbox's sources are ${files} files and ${bytes} bytes, over the ${SOURCES_MAX_FILES} files and ` +
          `${SOURCES_MAX_BYTES} bytes a sandbox holds`
      );
    }
    sourcesEntries(src.manifest);
    if (!path.isAbsolute(src.dir)) throw new Error(`the sandbox's sources directory ${src.dir} is not absolute`);
    const dir = path.resolve(src.dir);
    const rel = path.relative(path.join(home, "loops"), dir);
    if (!rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep).includes("work")) {
      throw new Error(`the sandbox's sources directory ${dir} is inside a sandbox's workspace`);
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      throw new Error(`the sandbox's sources directory ${dir} does not exist`);
    }
    if (!st.isDirectory()) throw new Error(`the sandbox's sources directory ${dir} is not a directory`);
    return { manifest: src.manifest, dir };
  }

  /**
   * The policy the Genesis commits: the caller's, with the posture this sandbox applies. A policy
   * that already carries one must carry exactly this one — a Genesis committing a posture the sandbox
   * did not apply is the one thing the posture exists to prevent.
   */
  private static sandboxed(opts: ZeroClawRuntimeOptions): RuntimePolicy {
    if (opts.delegates?.length) {
      throw new Error("a sandboxed session hands nothing to a child: the sandbox has no delegate tool");
    }
    const policy = toRuntimePolicy(opts.policy);
    // As `AgentRuntime` fills an absent allow-list from the declared tools, so the posture names
    // the list the policy hash will.
    const explicit = (opts.policy as any).toolAllowList ?? (opts.policy as any).tools;
    if (explicit === undefined) policy.toolAllowList = (opts.tools ?? []).map((t) => t.name).sort();
    const posture = sandboxPosture({
      toolAllowList: policy.toolAllowList,
      maxSteps: opts.maxSteps,
      binary: opts.zeroclaw.binary,
      sources: opts.zeroclaw.sources?.manifest,
      workspace: opts.zeroclaw.workspace,
    });
    if (policy.sandbox && canonicalJson(policy.sandbox) !== canonicalJson(posture)) {
      throw new Error("the policy's sandbox is not the posture this sandbox applies");
    }
    return { ...policy, sandbox: posture };
  }

  /** The caps `sources/` is held to: the ones the posture commits. */
  private sourcesCaps(): { maxBytes: number; maxFiles: number } {
    const s = this.posture.sources!;
    return { maxBytes: s.maxBytes, maxFiles: s.maxFiles };
  }

  /**
   * The workspace walk's limits: the posture's workspace cap for what the steps write and, in a
   * sandbox with sources, the posture's sources caps for `sources/`, which the workspace cap then does
   * not count.
   */
  private walkLimits(): WorkspaceWalkLimits {
    return { ...this.posture.workspace, ...(this.sources ? { sources: this.sourcesCaps() } : {}) };
  }

  /**
   * The model's context window for this step's config, or `undefined` for the config without one.
   * A lookup that throws or answers something the binary would refuse (patch 0005 takes only a
   * positive integer) is treated as not knowing: the step then runs at upstream's fallback, as a
   * config without the key does, rather than failing on a metadata read.
   */
  private async modelContextWindow(): Promise<number | undefined> {
    try {
      const n = await this.sandbox.contextWindow(this.policy.model);
      return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  /** The host tools this session's policy allows, by dotted id. */
  private hostToolIds(): string[] {
    return this.policy.toolAllowList.filter((id) => HOST_TOOL_WIRE_NAMES[id] !== undefined);
  }

  /** What the last session of this runtime left. The console writes it on the step's row. */
  stepReport(): ZeroClawSessionReport | undefined {
    return this.last?.report;
  }

  async start(opts: StartOptions): Promise<SandboxSessionResult> {
    this.run = undefined;
    let result: SessionResult;
    try {
      result = await super.start(opts);
    } catch (e) {
      this.run = undefined;
      throw e;
    }
    const run = this.run as SandboxRun | undefined;
    this.run = undefined;
    // `runTurns` never ran: `start()` stopped before the Genesis's turns (a journal that would not
    // drain, a mandate that did not match). No sandbox, so nothing to report.
    if (!run) return result;

    const { report } = await this.closeRun(run, result);
    const out: SandboxSessionResult = {
      ...result,
      ...(report.replayHash ? { replayHash: report.replayHash } : {}),
      // Only on a failed session: a refusal the session got past (it cannot, today) is not a reason
      // to stop a loop whose step succeeded.
      ...(run.sandboxRefused && result.status !== "success" ? { sandboxRefused: run.sandboxRefused } : {}),
    };
    this.last = { report };
    return out;
  }

  /** The report and the replay record of a session whose sandbox has closed. */
  private async closeRun(
    run: SandboxRun,
    result: SessionResult
  ): Promise<{ report: ZeroClawSessionReport; record?: ReplayRecord }> {
    const genesis = result.events.find((e) => e.input.kind === EventKind.Genesis);
    const report: ZeroClawSessionReport = {
      sessionId: run.sessionId,
      platform: this.binary.platform,
      wrapper: this.posture.wrapper.kind,
      binarySha256: this.binary.sha256,
      patchSet: this.binary.patchSet,
      postureHash: postureHash(this.posture),
      postureJson: canonicalJson(this.posture),
      ...(run.toml ? { postureToml: run.toml } : {}),
      ...(run.profile ? { wrapperProfile: run.profile } : {}),
      policyDocument: this.policyDocument,
      ...(genesis ? { genesisSeq: genesis.seq.toString() } : {}),
      actions: namedActions(result.events, result.epochs, run.names),
      ...(run.after
        ? {
            workspace: {
              bytes: run.after.totalBytes,
              files: run.after.count,
              capBytes: this.posture.workspace.maxBytes,
              capFiles: this.posture.workspace.maxFiles,
            },
          }
        : {}),
      ...(run.messageHash ? { messageHash: run.messageHash } : {}),
      ...(run.traceHash ? { traceHash: run.traceHash } : {}),
      ...(run.traceRefused ? { traceRefused: run.traceRefused } : {}),
      ...(this.sources ? { sources: { hash: this.sources.hash, manifest: this.sources.manifest } } : {}),
      ...(run.refused ? { refused: run.refused } : {}),
    };
    if (!run.before || !run.after || !run.now || !run.messageHash || !run.inside) return { report };

    let record: ReplayRecord;
    try {
      record = replayRecord({
        binarySha256: this.binary.sha256,
        postureHash: report.postureHash,
        messageHash: run.messageHash,
        workspacePath: run.inside.workspace,
        tz: this.posture.env.TZ,
        locale: this.posture.config.locale,
        now: run.now,
        workspaceBefore: run.before.hash,
        workspaceAfter: run.after.hash,
        // After the closing flush, which is the first moment a batched call has a seq.
        seqs: sessionActionSeqs(result.events, result.epochs),
        // The window the config was rendered with, so a replayer rebuilds the same config.
        ...(run.contextWindow !== undefined ? { contextWindow: run.contextWindow } : {}),
      });
      const bytes = replayRecordBytes(record);
      const put = hex(await this.store.put(bytes));
      const h = recordHash(record);
      // A record the store holds under another name is a hash pointing at nothing.
      if (put !== h) throw new Error(`the store keyed the replay record ${put}, not ${h}`);
      report.replayHash = h;
      report.replay = record;
      return { report, record };
    } catch (e) {
      report.refused ??= `the replay record was not written: ${(e as Error)?.message ?? e}`;
      return { report };
    }
  }

  // Every tool id this session records is noted, so its Actions can be named from the chain's
  // hashes afterwards; the records themselves are the parent's, written by the parent's code.
  protected async callTool(s: SessionCtx, nameOrWire: string, args: any) {
    const out = await super.callTool(s, nameOrWire, args);
    this.run?.names.add(out.toolId);
    return out;
  }

  protected async recordToolAction(
    s: SessionCtx,
    p: { toolId: string; args: unknown; result: unknown; statusCode: number }
  ): Promise<void> {
    await super.recordToolAction(s, p);
    this.run?.names.add(p.toolId);
  }

  /**
   * The sandbox: lay it out, serve its two sockets, spawn it under the wrapper, wait, and account for
   * everything it did. See the header for the order and the reasons.
   */
  protected async runTurns(s: SessionCtx, messages: ChatMessage[], opts: StartOptions): Promise<TurnsOutcome> {
    const run: SandboxRun = { sessionId: s.sessionId, resolved: new Map(), names: new Set() };
    this.run = run;
    try {
      // The step's own reading of its Solana sources, after the goal and the team and before the memory
      // (`withSourcesNote`): inside the `-m` message, so `messageHash` in the replay record commits it.
      const note = await this.readSourcesNote();
      return await this.inSandbox(s, withSourcesNote(messages, note, opts.memory !== undefined), run);
    } catch (e) {
      // `fetch` throws a bare "fetch failed" and puts the reason (ECONNRESET, a TLS or DNS error) on
      // `cause`; without it the step's row cannot say which hop failed.
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      const why = cause?.code ?? cause?.message;
      run.refused = ((e as Error)?.message ?? String(e)) + (why ? ` (${why})` : "");
      if (SandboxRefused.is(e)) run.sandboxRefused ??= e.reason;
      throw e;
    }
  }

  private async inSandbox(s: SessionCtx, messages: ChatMessage[], run: SandboxRun): Promise<TurnsOutcome> {
    // The step's own start instant, whole seconds in UTC: the form the binary renders and
    // the replay record accepts, so the string the sandbox is told is the string the record commits.
    const now = zeroclawNow(this.now());
    run.now = now;
    const message = sandboxMessageText(messages, this.sources?.manifest);
    const messageBytes = replayMessageBytes(message);
    if (messageBytes.length > MAX_MESSAGE_BYTES) {
      throw new Error(
        `the step's message is ${messageBytes.length} bytes, over the ${MAX_MESSAGE_BYTES} a sandbox's -m argument can carry`
      );
    }
    run.messageHash = replayMessageHash(message);

    const layout = this.layOut(s.sessionId);
    run.inside = layout.inside;
    try {
      // Every spawn, before anything is paid for: a sandbox of this loop that has no `sources/` yet
      // (its first step, a member's first sandbox) is seeded from the fetched copy, and then every sandbox
      // is checked against the manifest, so a step never runs on sources the posture does not name.
      // Sources that do not check now will not check on the next step either: nothing between steps
      // re-seeds a `sources/` that exists, so the refusal is `SandboxRefused` and stops the loop.
      if (this.sources) {
        try {
          await seedSources(layout.host.workspace, { manifest: this.sources.manifest, from: this.sources.dir });
          await checkSources(layout.host.workspace, this.sources.manifest, this.sourcesCaps());
        } catch (e) {
          throw asRefusal(e, "sources");
        }
      }
      // What the sandbox starts from, hashed rather than taken from the previous step: a workspace
      // wiped or edited between steps is then a `workspaceBefore` that does not match the last
      // `workspaceAfter`, which is the link a replay checks, instead of a record that hides it.
      // With sources, a first step's is the tree of the seeded sources, not the empty tree. A tree it
      // refuses is refused on every step after this one too: nothing resets the workspace.
      try {
        run.before = await hashWorkspace(layout.host.workspace, this.walkLimits());
        // A root `skills` entry, which a previous step's `file_write` can leave: the binary refuses
        // to start beside it, before any model call, and an exit the loop read as the session's own
        // failure would be one it paid for again on every step until `maxSteps`. Refused here instead,
        // before anything is spawned or paid, as the recurring refusal that stops the loop.
        await refuseSkillsEntry(layout.host.workspace);
      } catch (e) {
        throw asRefusal(e, "workspace");
      }
      // The bytes about to run are the bytes the Genesis committed, checked before anything is
      // spawned or paid for.
      binaryUnchanged(this.binary);

      const token = randomBytes(32).toString("hex");
      const toolsToken = randomBytes(32).toString("hex");
      const hostIds = this.hostToolIds();
      const contextWindow = await this.modelContextWindow();
      const step = {
        model: this.policy.model,
        temperature: this.policy.temperature ?? 0.2,
        modelSocket: layout.inside.modelSocket,
        toolsSocket: layout.inside.toolsSocket,
        workspacePath: layout.inside.workspace,
        // The model's real window, so a sandbox reading its sources is not held to upstream's 32k
        // fallback (CONTRACT §1). Absent when unknown, and the config then carries no `context_window`.
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
      // Taken from `step`, the object both renders of the config below are made from, so the window
      // the replay record commits is the one the sandbox's TOML carried and not a second lookup.
      run.contextWindow = step.contextWindow;
      run.toml = renderConfigToml(this.posture, { ...step, token: "<step token>", toolsToken: "<step token>" });
      run.profile =
        this.posture.wrapper.kind === "sandbox-exec"
          ? seatbeltProfile(this.posture, layout.host)
          : bwrapArgs(this.posture, { ...layout.host, libs: this.binary.libs, now }).join("\n") + "\n";

      let proxy: ModelProxy | undefined;
      let host: HostToolsServer | undefined;
      let exit: SandboxExit;
      try {
        proxy = await startModelProxy({
          socketPath: layout.host.modelSocket,
          token,
          model: this.policy.model,
          temperature: step.temperature,
          expect: { now },
          hostTools: hostIds.map((id) => HOST_TOOL_WIRE_NAMES[id]),
          chat: (req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> => this.paidChat(s, req, { signal }),
          onToolCalls: async (calls) => {
            for (const c of calls) {
              await this.recordToolAction(s, c);
              run.resolved.set(c.name, (run.resolved.get(c.name) ?? 0) + 1);
            }
          },
        });
        host = await startHostTools({
          socketPath: layout.host.toolsSocket,
          token: toolsToken,
          allow: hostIds,
          call: (id, args) => this.callTool(s, id, args),
          // A real host tool outside the policy keeps its own id (`store.set:403`), and none
          // of the six is an id the host writes for itself. Any other path segment is the sandbox's
          // own invention, and it goes under `unknown:`, as `callTool` and the model proxy record an
          // undeclared name. Recorded as given, a compromised sandbox could POST
          // `/tools/loop.step` and have the host anchor a 403 Action under the checkpoint's id, which
          // fails every later `--require-preimages` audit of the chain and cannot be removed.
          onRefused: (id, args, error) =>
            this.recordToolAction(s, {
              toolId: Object.prototype.hasOwnProperty.call(HOST_TOOL_WIRE_NAMES, id) ? id : undeclaredToolId(id),
              args,
              result: { error },
              statusCode: 403,
            }),
        });
        fs.writeFileSync(
          path.join(layout.host.configDir, "config.toml"),
          renderConfigToml(this.posture, { ...step, token, toolsToken }),
          { mode: 0o600 }
        );
        const spec = spawnSpec(
          this.posture,
          { ...layout.host, now, libs: this.binary.libs, wrapperPath: this.binary.wrapperPath },
          zeroclawArgv(this.posture, { configDir: layout.inside.configDir, message })
        );
        exit = await this.spawnSandbox(spec, s.opts.signal);
      } finally {
        await proxy?.close().catch(() => undefined);
        await host?.close().catch(() => undefined);
      }

      // What failed on either socket is the step's reason, as thrown: a refusal, a charge that did
      // not land, the budget.
      const failure = proxy!.failure() ?? host!.failure();
      const trace = await readTrace(layout.host.configDir);
      if (trace.refused) run.traceRefused = trace.refused;
      try {
        await this.anchorUnreported(s, proxy!.pending(), trace.records, run);
      } catch (e) {
        if (failure === undefined) throw e;
      }
      try {
        await this.keepBlobs(layout, trace.bytes, messageBytes, run);
      } catch (e) {
        // A socket's failure is the root; a workspace the tree then refuses is not the reason. It is
        // still a workspace the next step's walk will refuse, so the loop is told.
        if (SandboxRefused.is(e)) run.sandboxRefused ??= e.reason;
        if (failure === undefined) throw e;
      }
      if (failure !== undefined) throw failure;
      return outcomeOf(exit, this.sandbox.timeoutMs, path.basename(this.binary.wrapperPath));
    } finally {
      fs.rmSync(layout.stepDir, { recursive: true, force: true });
    }
  }

  /**
   * The workspace after the sandbox, hashed under the posture's cap, and the step's blobs: each file
   * content the previous tree did not hold, the tree, the message and the trace. A workspace the
   * tree refuses (over the cap, a symlink the sandbox made) fails the step with the tree's reason, as
   * a `SandboxRefused`: the next step starts from this same workspace and its walk would refuse it.
   */
  private async keepBlobs(
    layout: { host: HostSandbox },
    trace: Uint8Array | undefined,
    messageBytes: Uint8Array,
    run: SandboxRun
  ): Promise<void> {
    let after: WorkspaceTree;
    try {
      after = await hashWorkspace(layout.host.workspace, this.walkLimits());
    } catch (e) {
      throw asRefusal(e, "workspace");
    }
    const changes = workspaceChanges(run.before?.entries, after.entries, { sources: this.sources !== undefined });
    for (const file of changes.toStore) {
      await this.store.put(await readWorkspaceFile(layout.host.workspace, file));
    }
    await this.store.put(after.bytes);
    await this.store.put(messageBytes);
    // `readTrace` returns no bytes over the cap, so what is here is what the step's bundle may hold.
    if (trace) run.traceHash = hex(await this.store.put(trace));
    run.after = after;
  }

  /**
   * Every call a reply asked for whose result no request carried back. Each is an Action,
   * in the order the reply made them: from the flushed trace when it holds the call's result — by
   * the call's id when the record carries one, else by position among the records for that tool
   * after the ones the proxy already resolved — and otherwise a 500 (a file tool) or 404 (an
   * invented name) with `NOT_REPORTED_BACK` as its result. Nothing the model asked for is left
   * off the chain. An invented name is matched against the trace by the name the model gave
   * (`call.name`) and recorded under `call.toolId`, which `observedToolCalls` prefixed `unknown:`,
   * so an unanswered `loop.step` is no more a checkpoint here than on the proxy's path.
   */
  private async anchorUnreported(
    s: SessionCtx,
    pending: ObservedToolCall[],
    records: TraceResult[],
    run: SandboxRun
  ): Promise<void> {
    const used = new Set<TraceResult>();
    const seen = new Map<string, number>();
    for (const call of pending) {
      let found = records.find((r) => r.callId === call.callId && !used.has(r));
      if (!found) {
        const index = (run.resolved.get(call.name) ?? 0) + (seen.get(call.name) ?? 0);
        const candidate = records.filter((r) => r.tool === call.name)[index];
        if (candidate && !used.has(candidate) && (candidate.callId === undefined || candidate.callId === call.callId))
          found = candidate;
      }
      seen.set(call.name, (seen.get(call.name) ?? 0) + 1);
      if (found) used.add(found);
      const result = found ? found.output : NOT_REPORTED_BACK;
      const statusCode = found ? observedStatus(call, found.output) : call.kind === "unknown" ? 404 : 500;
      await this.recordToolAction(s, { toolId: call.toolId, args: call.args, result, statusCode });
    }
  }

  /** The session's directories, fresh, and the sandbox's paths as the host and as the process see them. */
  private layOut(sessionId: string): { host: HostSandbox; inside: HostSandbox; stepDir: string } {
    const sandboxDir = path.join(this.sandbox.home, "loops", ...this.sandbox.sandbox.split("/"));
    fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
    // The sandbox's directory is resolved, and `work` inside it is not: Seatbelt's `(subpath "@WORK@")`
    // covers `work` itself, so a sandbox can remove it and leave a symlink in its place. Resolving
    // that link would hand the next step's wrapper — and the tree's walk, which refuses a root that is
    // a symlink only if it is given the link — whatever directory it names, the console's keys included.
    const work = path.join(fs.realpathSync(sandboxDir), "work");
    let top: fs.Stats;
    try {
      top = fs.lstatSync(work);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      fs.mkdirSync(work, { mode: 0o700 });
      top = fs.lstatSync(work);
    }
    if (top.isSymbolicLink() || !top.isDirectory()) {
      // Nothing resets a workspace between steps, so every later step would meet it too.
      throw new SandboxRefused(
        "workspace",
        `the sandbox's workspace ${work} is ${top.isSymbolicLink() ? "a symlink" : "not a directory"}`
      );
    }
    const stepDir = path.join(sandboxDir, "steps", hex(sha256(utf8(sessionId))).slice(0, 10));
    // A leftover from a session of the same id that did not clean up (a crash, a retried step).
    fs.rmSync(stepDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(stepDir, "cfg"), { recursive: true, mode: 0o700 });
    // Resolved, because Seatbelt matches the real path (`/tmp` is `/private/tmp` on macOS) and the
    // tree refuses a workspace root that is a symlink.
    const realStep = fs.realpathSync(stepDir);
    const host: HostSandbox = {
      binary: this.binary.path,
      workspace: work,
      configDir: path.join(realStep, "cfg"),
      modelSocket: path.join(realStep, "m.sock"),
      toolsSocket: path.join(realStep, "t.sock"),
    };
    for (const sock of [host.modelSocket, host.toolsSocket]) {
      if (!socketPathOk(sock, this.binary.platform)) {
        fs.rmSync(stepDir, { recursive: true, force: true });
        // The home and the sandbox's name are the loop's for its whole life: every step would be refused.
        throw new SandboxRefused(
          "socket",
          `the sandbox's socket path is ${Buffer.byteLength(sock)} bytes, longer than the binary can connect to on ` +
            `${this.binary.platform}: ${sock}; set LATH_ZEROCLAW_HOME to a shorter directory`
        );
      }
    }
    return { host, inside: sandboxPaths(this.posture, host), stepDir };
  }

  /** Spawns the sandbox detached, stdin closed, and waits for it under the wall clock and the caller's signal. */
  private spawnSandbox(spec: SpawnSpec, signal?: AbortSignal): Promise<SandboxExit> {
    return new Promise((resolve) => {
      const exit: SandboxExit = {
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        overflow: false,
      };
      let child: ChildProcess;
      try {
        // `env` is the spawn's whole environment, never merged over `process.env`, which in the
        // Next process holds the treasury and every `LATH_*` secret (CONTRACT §4).
        child = this.sandbox.spawner(spec.file, spec.args, {
          env: exactEnv(spec.env),
          cwd: spec.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ ...exit, error: e as Error });
        return;
      }
      const out: Buffer[] = [];
      let outBytes = 0;
      let done = false;
      const kill = () => {
        // The whole group: `detached` made the sandbox its leader, and a wrapper's child must not
        // outlive it (`bwrap` also has `--die-with-parent`).
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      };
      const timer = setTimeout(() => {
        exit.timedOut = true;
        kill();
      }, this.sandbox.timeoutMs);
      const onAbort = () => {
        exit.aborted = true;
        kill();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        exit.stdout = Buffer.concat(out).toString("utf8");
        resolve(exit);
      };
      child.stdout?.on("data", (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > MAX_STDOUT_BYTES) {
          if (!exit.overflow) {
            exit.overflow = true;
            kill();
          }
          return;
        }
        out.push(d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        exit.stderr = (exit.stderr + d.toString("utf8")).slice(-STDERR_KEPT);
      });
      child.on("error", (e) => {
        exit.error = e;
        // A spawn that failed never gets a `close`; one that failed later still does.
        if (!child.pid) finish();
      });
      child.on("close", (code, sig) => {
        exit.code = code;
        exit.signal = sig;
        finish();
      });
    });
  }
}

/**
 * ZeroClaw's stderr in the words the console uses. A refusal quotes the sandbox's last stderr lines,
 * and the loop's history row and the ZeroClaw tab print that reason as it is; upstream says
 * _provider_ for the model's upstream, a word nothing on screen says. Its known sentence ("The
 * selected model provider timed out. Try again or choose another provider.") is rewritten whole, and
 * any other use of the word is replaced, so a new upstream message cannot bring it back.
 */
export function sandboxStderr(text: string): string {
  return text
    .replace(
      /The selected model provider timed out\. Try again or choose another provider\./g,
      "The model timed out upstream."
    )
    .replace(/\bmodel providers?\b/gi, "model's upstream")
    .replace(/\bproviders?\b/gi, "upstream");
}

/**
 * The session's outcome from how its sandbox exited, when neither socket failed it.
 *
 * Three exits are `SandboxRefused`, because the next step would meet them unchanged: a spawn
 * that failed outright (the wrapper or the binary is gone or no longer executable), a non-zero
 * exit whose stderr opens with the wrapper's own name (`sandbox-exec: …`, `bwrap: …`) — the wrapper
 * speaking, before or instead of the binary, which is how a profile it will not apply or a binary
 * it cannot exec is reported — and the binary refusing the workspace's `skills` entry. Every other
 * failure is the session's own and may not recur: a model that timed out upstream, a turn limit, a
 * crash in one run.
 */
function outcomeOf(exit: SandboxExit, timeoutMs: number, wrapperName: string): TurnsOutcome {
  const stderr = sandboxStderr(tail(exit.stderr));
  if (exit.error) throw new SandboxRefused("wrapper", `the sandbox could not be started: ${exit.error.message}`);
  if (exit.timedOut)
    throw new Error(`the sandbox ran past its ${Math.round(timeoutMs / 1000)} s wall clock and was killed`);
  if (exit.aborted) throw new Error("the session was abandoned by its caller and the sandbox was killed");
  if (exit.overflow) throw new Error(`the sandbox wrote more than ${MAX_STDOUT_BYTES} bytes to stdout and was killed`);
  if (exit.code !== 0) {
    const how = exit.code === null ? `was killed by ${exit.signal}` : `exited ${exit.code}`;
    const message = `the sandbox ${how}${stderr ? `: ${stderr}` : ""}`;
    if (exit.code !== null && wrapperName && exit.stderr.trimStart().startsWith(`${wrapperName}:`)) {
      throw new SandboxRefused("wrapper", `${message} (the wrapper ${wrapperName} would not start the binary)`);
    }
    // The binary's own workspace check (patch 0005 `check_workspace`), for a `skills` entry the host's
    // check before the spawn did not see — one that appeared between the two. It refuses before any
    // model call and the workspace keeps the entry, so the next step would meet it unchanged.
    if (exit.code !== null && /\blath: refused `[^`]*\/skills`/.test(exit.stderr)) {
      throw new SandboxRefused("workspace", message);
    }
    throw new Error(message);
  }
  // One trailing newline is the terminal's, not the model's.
  const output = exit.stdout.replace(/\r?\n$/, "");
  if (output.trim().length === 0) {
    throw new Error(`the sandbox exited 0 with nothing on stdout${stderr ? `: ${stderr}` : ""}`);
  }
  return { status: "success", output };
}

/** A `tool_call_result` record of the flushed runtime trace. */
export interface TraceResult {
  tool: string;
  output: string;
  callId?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The runtime trace as the host read it: its bytes and records, or why it was left unread. */
export interface SandboxTrace {
  bytes?: Uint8Array;
  records: TraceResult[];
  /** Set when a trace was there and the host would not read it; absent when there was none. */
  refused?: string;
}

/**
 * The runtime trace the sandbox left at `<cfg>/data/state/runtime-trace.jsonl`, read as the workspace
 * walk reads a file, because every component of that path is the sandbox's to write: `cfg/` is under
 * Seatbelt's `(subpath "@CFG@")` and bound read-write by `bwrap`, and on macOS the subpath covers the
 * directory itself, so it can be removed and put back as a symlink. A symlink at any component would
 * have the host read a host file — the server keypair — into a blob the loop's owner can read; a
 * FIFO would block the read, and with `readFileSync` the console's event loop, for good; a file of
 * any size would be read whole. So a symlink at `cfg/`, `data/`, `state/` or the file, anything but a
 * regular file with one link, and a file over `MAX_TRACE_BYTES` are no trace, with the reason, and the
 * directories are checked again after the read so a swap during it is refused too. The trace is a
 * blob of the bundle and a source of results for calls not reported back (`anchorUnreported`), never
 * the source of the Actions, so a step without one is still a whole step.
 */
export async function readTrace(configDir: string): Promise<SandboxTrace> {
  const rel = TRACE_FILE.join("/");
  const no = (why: string): SandboxTrace => ({
    records: [],
    refused: `the runtime trace ${rel} was not read: ${why}`,
  });
  const dirs = [configDir];
  for (const part of TRACE_FILE.slice(0, -1)) dirs.push(path.join(dirs[dirs.length - 1], part));
  const file = path.join(configDir, ...TRACE_FILE);
  const shown = (p: string) => path.relative(configDir, p) || "the step's config directory";
  // ENOENT anywhere is a binary that wrote no trace, which is not a refusal.
  const look = async (p: string): Promise<fs.Stats | "missing"> => {
    try {
      return await fs.promises.lstat(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw e;
    }
  };
  let bytes: Uint8Array;
  try {
    const seen: fs.Stats[] = [];
    for (const dir of dirs) {
      const st = await look(dir);
      if (st === "missing") return { records: [] };
      if (st.isSymbolicLink()) return no(`${shown(dir)} is a symlink`);
      if (!st.isDirectory()) return no(`${shown(dir)} is not a directory`);
      seen.push(st);
    }
    const st = await look(file);
    if (st === "missing") return { records: [] };
    if (st.isSymbolicLink()) return no("it is a symlink");
    if (!st.isFile()) return no(`it is ${st.isFIFO() ? "a FIFO" : st.isSocket() ? "a socket" : "not a regular file"}`);
    bytes = await readRegular(file, rel, { what: "the runtime trace", maxBytes: MAX_TRACE_BYTES });
    for (let i = 0; i < dirs.length; i++) {
      const again = await look(dirs[i]);
      if (again === "missing" || again.isSymbolicLink() || again.dev !== seen[i].dev || again.ino !== seen[i].ino) {
        return no(`${shown(dirs[i])} changed while it was read`);
      }
    }
  } catch (e) {
    // `readRegular`'s refusals (a symlink or FIFO swapped in after the `lstat`, a hard link, over the
    // cap) and any error reading it: the trace is left out and the step says why.
    return no(e instanceof WorkspaceRefused ? e.message : (e as Error).message);
  }
  return { bytes, records: traceRecords(bytes) };
}

/**
 * The trace's `tool_call_result` records, in file order. Read liberally — the record's type under
 * any of the keys a JSONL logger uses, its fields at the top or one level down — because the trace
 * is ZeroClaw's format and not a contract; a line that is not a record is skipped.
 */
function traceRecords(bytes: Uint8Array): TraceResult[] {
  const records: TraceResult[] = [];
  for (const line of Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      r = parsed;
    } catch {
      continue;
    }
    const isResult = ["type", "kind", "event", "record"].some((k) => r[k] === "tool_call_result");
    if (!isResult) continue;
    const inner = [r.data, r.payload, r.fields].find((v) => v && typeof v === "object") as
      | Record<string, unknown>
      | undefined;
    const f = { ...(inner ?? {}), ...r };
    const tool = asString(f.tool) ?? asString(f.tool_name);
    if (!tool) continue;
    const raw = f.output ?? f.result;
    const output = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw);
    const callId = asString(f.tool_call_id) ?? asString(f.call_id);
    records.push({ tool, output, ...(callId ? { callId } : {}) });
  }
  return records;
}

/**
 * The session's tool Actions by seq, named: the chain holds `sha256(tool_id)` as an Action's
 * reference, so a name comes from the ids this session recorded (and the sandbox's two file tools).
 * Model calls (`llm.*`) are left out; they are the proxy's meter, not the sandbox's tool calls.
 */
function namedActions(
  events: readonly LogResult[],
  epochs: readonly EpochCommit[],
  names: ReadonlySet<string>
): { seq: string; tool: string; status: number }[] {
  const byHash = new Map<string, string>();
  for (const n of ["zc.file_read", "zc.file_write", ...names]) {
    if (!n.startsWith("llm.")) byHash.set(hex(sha256(utf8(n))), n);
  }
  const out: { seq: bigint; tool: string; status: number }[] = [];
  const take = (seq: bigint, input: LogResult["input"]) => {
    if (input.kind !== EventKind.Action) return;
    const tool = byHash.get(hex(input.reference));
    if (tool) out.push({ seq, tool, status: input.status });
  };
  for (const e of events) take(e.seq, e.input);
  for (const epoch of epochs) epoch.inputs.forEach((input, i) => take(epoch.startSeq + BigInt(i), input));
  return out
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    .map((a) => ({ seq: a.seq.toString(), tool: a.tool, status: a.status }));
}

export { PostureRefused };
