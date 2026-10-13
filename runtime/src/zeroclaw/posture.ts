import { hex, sha256, utf8 } from "@lath/sdk";
import { canonicalJson } from "../policy";
import { SOURCES_DIR } from "./sources";

/**
 * The one posture every sandboxed loop step runs under, as data,
 * and the pure functions that turn it into what the host writes and spawns: the `config.toml` of
 * `zeroclaw/CONTRACT.md` §1, the step's environment of §4, and the wrapper — a `sandbox-exec`
 * profile on macOS, `bwrap` arguments on Linux.
 *
 * The split that matters is between the **committed** posture and the **per-step** values. The
 * posture goes into `RuntimePolicy.sandbox` and so under every step's `policy_version_hash`: an
 * operator who loosens the jail between two steps of one loop changes the hash, and the chain shows
 * it. For that to mean anything, every step of a loop under the same policy must commit the same
 * bytes, so the posture holds no token, no socket path, no step directory, no clock and no host
 * path at all — the wrapper and the environment are committed as templates whose `@NAME@`
 * placeholders are filled only at spawn. What fills them is either a secret (the tokens, which go
 * into the TOML and never into the posture) or a value the replay record commits on its own (the
 * step's instant, the workspace path).
 *
 * Pure and free of Node built-ins: no `path`, no `fs`, no `Buffer`. The host resolves real paths
 * (`realpath`, because Seatbelt matches the resolved path and `/tmp` is `/private/tmp` on macOS)
 * and finds the loader's libraries (`ldd` on Linux), and hands the results in.
 */

/** The platforms that have a wrapper. Anything else has no air gap, so it has no posture. */
export type ZeroClawPlatform = "darwin" | "linux";

/** The host's wrapper: `sandbox-exec` with a deny-default profile, or `bwrap --unshare-all`. */
export type WrapperKind = "sandbox-exec" | "bwrap";

/**
 * The committed posture. Every key is part of the jail or of what the binary is told to be, so
 * `policyDocument` folds the object in whole rather than picking named keys: a key added here
 * later must move the hash, which a field-by-field normaliser would silently drop.
 */
export interface LathPosture {
  /** Bumped when the meaning of a key changes, so an old posture is never read as a new one. */
  version: 1;
  /** `sha256` of the Lath-patched binary, hex: a replay with another build is not one. */
  binarySha256: string;
  /** Identity of `zeroclaw/patches/*` on `zeroclaw/UPSTREAM`, as `zeroclaw/build.sh` prints it. */
  patchSet: string;
  /** The `config.toml` the host renders, minus the per-step values (CONTRACT §1). */
  config: {
    schema_version: 3;
    locale: "en";
    native_tools: true;
    /** `[risk_profiles.lath]`. */
    risk_profile: {
      level: "full";
      workspace_only: true;
      /** Wire names, sorted: ZeroClaw's two file tools and the host tools the loop's policy allows. */
      allowed_tools: string[];
      always_ask: string[];
      /** The host's wrapper is the sandbox; nothing is spawned to detect one. */
      sandbox_enabled: false;
    };
    /** `[runtime_profiles.lath]`: `AgentRuntime`'s `maxSteps`, committed nowhere else. */
    runtime_profile: { max_tool_iterations: number };
    memory: { backend: "none" };
    cost: { enabled: false };
    reliability: { provider_retries: 0 };
  };
  /**
   * The workspace cap: the host's (`WORKSPACE_MAX_BYTES`, `WORKSPACE_MAX_FILES`) unless the owner
   * lowered it, and a step whose workspace exceeds either bound fails. Always present, so a lowered cap changes a
   * value and never the key set: a posture at the host's cap hashes as it always did.
   */
  workspace: { maxBytes: number; maxFiles: number };
  /** The binary's argv after the wrapper, as a template (CONTRACT §4). */
  argv: string[];
  /** The environment, whole, as a template: nothing else reaches the process (CONTRACT §4). */
  env: Record<string, string>;
  /** The wrapper, as a template. `sandbox-exec`: the profile's lines. `bwrap`: its arguments. */
  wrapper: { kind: WrapperKind; template: string[] };
  /**
   * The sandbox's sources (CONTRACT §5): the manifest's hash (`sourcesHash` in `sources.ts`) and
   * the caps it was fetched under. Set only when the loop has sources; absent, `canonicalJson` drops
   * the key and the posture hashes byte for byte as a posture without the key, which is what keeps
   * every policy hash committed without sources verifying.
   */
  sources?: { hash: string; maxBytes: number; maxFiles: number };
}

/** The host's workspace cap: 8 MiB and 1 000 files. `workspace.ts` enforces what this commits. */
export const WORKSPACE_MAX_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_MAX_FILES = 1000;

/**
 * A workspace cap below the host's, as `lathPosture` takes it. Either bound may be left out and is
 * then the host's; neither may be raised, because the host's cap is what keeps a step's workspace
 * hashable and storable in one bundle, and a sandbox the owner could widen would be one the operator
 * did not size for.
 */
export interface PostureWorkspace {
  maxBytes?: number;
  maxFiles?: number;
}

/** The workspace cap a posture commits: the host's, lowered where `workspace` lowers it; refuses a raise. */
export function workspaceCap(workspace?: PostureWorkspace): { maxBytes: number; maxFiles: number } {
  const out = { maxBytes: WORKSPACE_MAX_BYTES, maxFiles: WORKSPACE_MAX_FILES };
  for (const k of ["maxBytes", "maxFiles"] as const) {
    const v = workspace?.[k];
    if (v === undefined) continue;
    if (!Number.isSafeInteger(v) || v < 1) throw new Error(`workspace.${k} must be a positive integer: ${v}`);
    if (v > out[k]) throw new Error(`workspace.${k} of ${v} is above the host's cap of ${out[k]}`);
    out[k] = v;
  }
  return out;
}

/** `AgentRuntime`'s default `maxSteps` (`runtime.ts`), which becomes `max_tool_iterations`. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 16;

/** The agent alias in the generated config; one agent per step's config (patch 0005). */
export const ZEROCLAW_AGENT_ALIAS = "lath";

/** ZeroClaw's own two tools. They run inside the sandbox; the host records them as `zc.*`. */
export const ZEROCLAW_FILE_TOOLS = ["file_read", "file_write"] as const;

/**
 * The six host tools compiled into the Lath registry (patch 0004), by the dotted id the chain
 * records, with the wire name the model sees: a dot becomes `_`, exactly as `runtime.ts`
 * `wireName` does, so the host maps them back with the code it already has (CONTRACT §3).
 */
export const HOST_TOOL_WIRE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "store.get": "store_get",
  "store.set": "store_set",
  "solana.slot": "solana_slot",
  "solana.fees": "solana_fees",
  "solana.balance": "solana_balance",
  "lath.verify_chain": "lath_verify_chain",
});

/** The fixed paths inside the Linux sandbox. Fixed, so the workspace path in the system prompt — a
 * replay input — is the same on every Linux host. */
export const BWRAP_SANDBOX = Object.freeze({
  binary: "/lath/bin/zeroclaw",
  workspace: "/lath/work",
  configDir: "/lath/cfg",
  modelSocket: "/lath/m.sock",
  toolsSocket: "/lath/t.sock",
});

/** The Seatbelt line that gives the sandbox its workspace and config directory; see the template below. */
const SEATBELT_WORKSPACE_LINE = '(allow file-read* file-write* (subpath "@WORK@") (subpath "@CFG@"))';

/**
 * The one line a sandbox with sources adds to the Seatbelt profile, right after the workspace's
 * allow: `<workspace>/sources` is refused every kind of write (create, modify, unlink, rename, the
 * directory itself included), while the allow above it still gives it reads. It must come after
 * the allow, not before: Seatbelt lets the last matching rule decide, which a probe confirmed
 * rather than assumed (deny-then-allow wrote into the subtree;
 * allow-then-deny refused the write, the append, the mkdir, the unlink and the rename, and still
 * read). Only a posture with sources carries it, so every posture without them keeps its bytes.
 */
const SEATBELT_SOURCES_LINE = '(deny file-write* (subpath "@SRC@"))';

/**
 * The `sandbox-exec` profile, exactly the shape `zeroclaw/probe/airgap.sh macos` passes, with the
 * sandbox's paths as placeholders. The probe runs it in both shapes the product runs: `SOURCES=0`
 * is this template as it stands, the profile of every loop without sources; `SOURCES=1` adds
 * `SEATBELT_SOURCES_LINE` after the workspace's allow (CONTRACT §5).
 * `tests/zeroclaw-airgap.ts` holds the generated profile to the same expectations in both.
 * - `(deny default)`, so everything not named is refused, network included;
 * - exec and read of the binary only — no `/bin/sh`, which the Lath build does not stat (patch 0005);
 * - read of the loader (`/usr/lib`, `/System/Library`, the cryptexes), and of `/` itself, which
 *   dyld opens at start — a read of `/`'s entries, not of anything below it;
 * - metadata of each ancestor of the sandbox, because path canonicalisation walks them;
 * - the three device nodes a Rust binary touches, and `sysctl-read` for its start-up queries;
 * - read and write under the workspace and the step's config directory, and nothing else;
 * - two `network-outbound` rules, one per socket, which are the whole of what the sandbox may reach.
 * Committed with the posture, so changing any line changes every step's policy hash.
 */
const SEATBELT_TEMPLATE: readonly string[] = Object.freeze([
  "(version 1)",
  "(deny default)",
  '(allow process-exec (literal "@BIN@"))',
  '(allow file-read* (literal "@BIN@"))',
  '(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/System/Cryptexes"))',
  "(allow file-read-metadata @ANCESTORS@)",
  '(allow file-read* (literal "/"))',
  '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
  '(allow file-write-data (literal "/dev/null"))',
  "(allow sysctl-read)",
  SEATBELT_WORKSPACE_LINE,
  '(allow network-outbound (remote unix-socket (path-literal "@MSOCK@")))',
  '(allow network-outbound (remote unix-socket (path-literal "@TSOCK@")))',
]);

/**
 * The `bwrap` arguments, the shape `airgap.sh linux` passes in a Debian container, at the sandbox's
 * fixed paths — without sources (`SOURCES=0`, these arguments as they stand) and with them
 * (`SOURCES=1`, plus `BWRAP_SOURCES_ARGS` after the workspace's bind). `--unshare-all` takes the
 * network namespace, so there is no route anywhere, not even to the host's loopback; pathname Unix
 * sockets still cross because they are files, bound in. Only the binary, its loader's libraries
 * (`@LIBS@`, one `--ro-bind` per library at its own path), the workspace, the config directory and
 * the two sockets are mounted.
 * `@ENV@` expands to one `--setenv` per entry of the posture's `env`, after `--clearenv`, so the
 * environment is written down once. The binary's argv follows the last element.
 */
const BWRAP_TEMPLATE: readonly string[] = Object.freeze([
  "--unshare-all",
  "--die-with-parent",
  "--new-session",
  "--clearenv",
  "@ENV@",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "@LIBS@",
  "--ro-bind",
  "@BIN@",
  BWRAP_SANDBOX.binary,
  "--bind",
  "@WORK@",
  BWRAP_SANDBOX.workspace,
  "--bind",
  "@CFG@",
  BWRAP_SANDBOX.configDir,
  "--bind",
  "@MSOCK@",
  BWRAP_SANDBOX.modelSocket,
  "--bind",
  "@TSOCK@",
  BWRAP_SANDBOX.toolsSocket,
  "--chdir",
  BWRAP_SANDBOX.workspace,
  BWRAP_SANDBOX.binary,
]);

/**
 * The mount a sandbox with sources adds after the workspace's `--bind`: the host's
 * `<workspace>/sources` bound read-only over the same subtree of `/lath/work`. A later mount covers
 * an earlier one, so the sandbox sees the rest of the workspace writable and `sources/` read-only: a
 * write into it is `EROFS` from the kernel, and, being a mount point, the directory cannot be
 * renamed or removed either. Only a posture with sources carries it.
 */
const BWRAP_SOURCES_ARGS: readonly string[] = Object.freeze([
  "--ro-bind",
  "@SRC@",
  `${BWRAP_SANDBOX.workspace}/${SOURCES_DIR}`,
]);

/**
 * CONTRACT §4's environment. `HOME` is the step's config directory — inside the step's directory,
 * and on Linux the only part of it that is mounted. `ZEROCLAW_NOW` is the step's own start instant.
 * Nothing is inherited: not `PATH`, which a build with no shell does not need, and not any
 * `ZEROCLAW_*` variable, which would override config.
 */
const ENV_TEMPLATE: Readonly<Record<string, string>> = Object.freeze({
  HOME: "@HOME@",
  LANG: "C",
  TZ: "UTC",
  ZEROCLAW_NOW: "@NOW@",
  ZEROCLAW_OMIT_HOST: "1",
});

/** CONTRACT §4's invocation after the binary: `--config-dir <cfg> agent -a lath -m "<message>"`. */
const ARGV_TEMPLATE: readonly string[] = Object.freeze([
  "--config-dir",
  "@CFG@",
  "agent",
  "-a",
  ZEROCLAW_AGENT_ALIAS,
  "-m",
  "@MESSAGE@",
]);

/** A loop's policy names a tool the sandbox cannot run. `/api/loops` refuses to start it, naming it. */
export class PostureRefused extends Error {
  constructor(readonly tool: string, readonly reason: string) {
    super(`a sandboxed loop cannot run ${tool}: ${reason}`);
    this.name = "PostureRefused";
  }
  static is(e: unknown): e is PostureRefused {
    return e instanceof Error && e.name === "PostureRefused";
  }
}

/** The wire names `allowed_tools` gets from a loop's `toolAllowList`, sorted; refuses the rest. */
export function allowedWireTools(toolAllowList: readonly string[]): string[] {
  const out = new Set<string>(ZEROCLAW_FILE_TOOLS);
  for (const id of toolAllowList) {
    if (HOST_TOOL_WIRE_NAMES[id]) {
      out.add(HOST_TOOL_WIRE_NAMES[id]);
    } else if (id === "zc.file_read" || id === "zc.file_write") {
      // The ids the host records ZeroClaw's own tools under; they are in every posture already, so
      // naming them in the policy changes nothing.
      continue;
    } else if (id.startsWith("web.")) {
      // Internet access, even when the host runs it: the sandbox is air-gapped.
      throw new PostureRefused(id, "web tools are internet access, and the sandbox is air-gapped");
    } else if (id === "lattice.verify_chain") {
      throw new PostureRefused(id, "this alias is not in the Lath build; use lath.verify_chain");
    } else {
      throw new PostureRefused(id, "the Lath build compiles in file_read, file_write and the six host tools only");
    }
  }
  return [...out].sort();
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The wrapper template for a platform, with the sources rule spliced in right after the
 * workspace's when the sandbox has sources — so the committed template is the one applied, and a
 * posture without sources has exactly the template it always had.
 */
function wrapperTemplate(kind: WrapperKind, withSources: boolean): string[] {
  if (kind === "sandbox-exec") {
    const out = [...SEATBELT_TEMPLATE];
    if (withSources) out.splice(out.indexOf(SEATBELT_WORKSPACE_LINE) + 1, 0, SEATBELT_SOURCES_LINE);
    return out;
  }
  const out = [...BWRAP_TEMPLATE];
  if (withSources) out.splice(out.indexOf(BWRAP_SANDBOX.workspace) + 1, 0, ...BWRAP_SOURCES_ARGS);
  return out;
}

/** The posture's `sources` key, as `lathPosture` takes it. */
export interface PostureSources {
  /** `sourcesHash(manifest)`, hex. */
  hash: string;
  /** The caps the sources were fetched under, which `hashWorkspace` holds `sources/` to. */
  maxBytes: number;
  maxFiles: number;
}

/**
 * The posture for a loop step. Everything it takes is committed: the loop's tool list (as the wire
 * names ZeroClaw allows), `maxSteps`, the binary and patch set, and the platform, which picks the
 * wrapper — so a posture hash names the jail and not merely the policy that asked for one.
 *
 * `workspace` is the owner's lowered cap: it replaces the host's values under the key that always
 * holds them, so a posture given none — or one equal to the host's — has the bytes of a posture at
 * the host's cap.
 *
 * `sources` is the manifest's hash and the caps it was fetched under. Given, the posture gains the
 * `sources` key and the wrapper its read-only rule for `<workspace>/sources`; absent, neither is
 * there, and the posture is byte for byte one without sources — which is what keeps every policy
 * hash committed without sources verifying.
 */
export function lathPosture(opts: {
  toolAllowList: readonly string[];
  maxSteps?: number;
  binarySha256: string;
  patchSet: string;
  platform: string;
  workspace?: PostureWorkspace;
  sources?: PostureSources;
}): LathPosture {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_TOOL_ITERATIONS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error(`maxSteps must be a positive integer: ${maxSteps}`);
  if (!HEX64.test(opts.binarySha256)) throw new Error("binarySha256 must be 64 lowercase hex characters");
  // Not whitespace-free for looks: `build.sh` prints it on one line and docs/ARCHITECTURE.md quotes it.
  if (!opts.patchSet || /\s/.test(opts.patchSet)) throw new Error("patchSet must be a non-empty token");
  const src = opts.sources;
  if (src) {
    if (!HEX64.test(src.hash)) throw new Error("sources.hash must be 64 lowercase hex characters");
    if (!Number.isSafeInteger(src.maxBytes) || src.maxBytes < 1)
      throw new Error(`sources.maxBytes must be a positive integer: ${src.maxBytes}`);
    if (!Number.isSafeInteger(src.maxFiles) || src.maxFiles < 1)
      throw new Error(`sources.maxFiles must be a positive integer: ${src.maxFiles}`);
  }
  const workspace = workspaceCap(opts.workspace);
  const kind = wrapperKind(opts.platform);
  return {
    version: 1,
    binarySha256: opts.binarySha256,
    patchSet: opts.patchSet,
    config: {
      schema_version: 3,
      locale: "en",
      native_tools: true,
      risk_profile: {
        level: "full",
        workspace_only: true,
        allowed_tools: allowedWireTools(opts.toolAllowList),
        always_ask: [],
        sandbox_enabled: false,
      },
      runtime_profile: { max_tool_iterations: maxSteps },
      memory: { backend: "none" },
      cost: { enabled: false },
      reliability: { provider_retries: 0 },
    },
    workspace,
    argv: [...ARGV_TEMPLATE],
    env: { ...ENV_TEMPLATE },
    wrapper: { kind, template: wrapperTemplate(kind, src !== undefined) },
    // Absent rather than `undefined` when there are none: the object then equals, key for key, a
    // posture that has no `sources` key, and not only in its canonical bytes.
    ...(src ? { sources: { hash: src.hash, maxBytes: src.maxBytes, maxFiles: src.maxFiles } } : {}),
  };
}

/** Which wrapper a platform uses; any other platform has no air gap and is refused. */
export function wrapperKind(platform: string): WrapperKind {
  if (platform === "darwin") return "sandbox-exec";
  if (platform === "linux") return "bwrap";
  throw new Error(`no ZeroClaw wrapper on ${platform}: a loop step runs air-gapped or not at all`);
}

/** `sha256(canonicalJson(posture))`, hex — the replay record's `postureHash`. */
export function postureHash(posture: LathPosture): string {
  return hex(sha256(utf8(canonicalJson(posture))));
}

// ---------------------------------------------------------------------------------------------
// Paths

/**
 * A Unix socket path the Rust side can connect to. `sun_path` is 104 bytes on macOS and 108 on
 * Linux, and Rust's `std` (under mio and tokio, so under reqwest's `unix_socket`) refuses a path
 * that does not leave room for the terminating NUL — `path must be shorter than SUN_LEN` — even
 * though Node will bind one byte longer. So the limit is 103 and 107 bytes: a host path Node can
 * listen on but the binary cannot reach would fail the step at its first model call, after the
 * Genesis is written, instead of at start. Hence `LATH_ZEROCLAW_HOME` is short.
 */
export function socketPathOk(path: string, platform: string): boolean {
  const sunPath = platform === "darwin" ? 104 : platform === "linux" ? 108 : 0;
  const bytes = new TextEncoder().encode(path).length;
  return path.startsWith("/") && !path.includes("\0") && bytes > 1 && bytes < sunPath;
}

/**
 * A path fit to put in a profile or a mount: absolute, already normalised (no `.`/`..` segment,
 * no doubled or trailing slash), and free of the characters a Seatbelt string or the TOML could
 * be broken out of. Refused rather than escaped: the host chooses these paths, so a quote or a
 * newline in one is a bug upstream of here, and escaping it would hide that.
 */
function sandboxPath(label: string, p: string): string {
  if (!p.startsWith("/")) throw new Error(`${label} must be absolute: ${p}`);
  if (p !== "/" && (p.endsWith("/") || p.includes("//"))) throw new Error(`${label} must be normalised: ${p}`);
  if (p.split("/").some((seg) => seg === "." || seg === "..")) throw new Error(`${label} must be normalised: ${p}`);
  if (/["\\\u0000-\u001f\u007f]/.test(p)) throw new Error(`${label} has a character a profile cannot hold: ${p}`);
  return p;
}

/** Every proper ancestor of an absolute path, `/` first. */
function ancestors(p: string): string[] {
  const segs = p.split("/").filter(Boolean);
  const out = ["/"];
  for (let i = 1; i < segs.length; i++) out.push(`/${segs.slice(0, i).join("/")}`);
  return out;
}

/** The sandbox on the host: real, resolved, absolute paths. */
export interface HostSandbox {
  /** The Lath-patched binary (or, in the air-gap test, the probe standing in for it). */
  binary: string;
  /** The loop's workspace, persistent across its steps. */
  workspace: string;
  /** The step's fresh config directory: `config.toml`, and `data/` where ZeroClaw writes. */
  configDir: string;
  /** The metering proxy's socket, `<step>/m.sock`. */
  modelSocket: string;
  /** The host-tool listener's socket, `<step>/t.sock`. */
  toolsSocket: string;
}

/**
 * The same sandbox as the process inside sees it: the fixed `/lath/…` mounts under `bwrap`, the real
 * paths under `sandbox-exec`, which has no mount namespace. These are the paths the TOML, the
 * environment and the argv carry.
 */
export function sandboxPaths(posture: LathPosture, host: HostSandbox): HostSandbox {
  if (posture.wrapper.kind === "bwrap") return { ...BWRAP_SANDBOX };
  return {
    binary: sandboxPath("binary", host.binary),
    workspace: sandboxPath("workspace", host.workspace),
    configDir: sandboxPath("configDir", host.configDir),
    modelSocket: sandboxPath("modelSocket", host.modelSocket),
    toolsSocket: sandboxPath("toolsSocket", host.toolsSocket),
  };
}

/** Fills `@NAME@` placeholders in one pass, so a value is never itself scanned for placeholders. */
function fill(s: string, values: Record<string, string>): string {
  return s.replace(/@([A-Z]+)@/g, (whole, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`no value for ${whole}`);
    return v;
  });
}

// ---------------------------------------------------------------------------------------------
// The environment and the argv

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The step's instant as `ZEROCLAW_NOW` carries it. A `Date` is written to the second in UTC — the
 * precision of the `[YYYY-MM-DD HH:MM:SS tz]` prefix the model sees — so the replay record commits
 * the string the binary read, not a millisecond it rounded away.
 */
export function zeroclawNow(now: Date | string): string {
  if (typeof now === "string") {
    if (!RFC3339.test(now)) throw new Error(`ZEROCLAW_NOW must be RFC 3339: ${now}`);
    return now;
  }
  if (Number.isNaN(now.getTime())) throw new Error("ZEROCLAW_NOW from an invalid Date");
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The exact environment of the step's process (CONTRACT §4), from the committed template. `home`
 * is the config directory as the sandbox sees it (`sandboxPaths(...).configDir`). Under `bwrap` the
 * same record reaches the child through `--setenv` after `--clearenv`; under `sandbox-exec` it is
 * the spawn's whole `env`, which the profile passes through unchanged.
 */
export function stepEnv(posture: LathPosture, opts: { now: Date | string; home: string }): Record<string, string> {
  const values = { HOME: sandboxPath("home", opts.home), NOW: zeroclawNow(opts.now) };
  const out: Record<string, string> = {};
  for (const k of Object.keys(posture.env).sort()) out[k] = fill(posture.env[k], values);
  return out;
}

/** The binary's argv after the wrapper (CONTRACT §4). The message is one argument, never split. */
export function zeroclawArgv(posture: LathPosture, opts: { configDir: string; message: string }): string[] {
  return posture.argv.map((a) =>
    a === "@MESSAGE@" ? opts.message : fill(a, { CFG: sandboxPath("configDir", opts.configDir) })
  );
}

// ---------------------------------------------------------------------------------------------
// The config

/** A TOML basic string. Control characters are escaped, so a model slug or token cannot end the line. */
function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * A TOML float. An integral temperature is written `1.0`, not `1`: TOML's `1` is an integer, and
 * whether the binary's deserialiser widens it is not something the host should depend on.
 */
function tomlFloat(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function tomlStrings(xs: readonly string[]): string {
  return `[${xs.map(tomlString).join(", ")}]`;
}

/**
 * The step's `config.toml`, CONTRACT §1 exactly: every key, in the contract's order, derived from
 * the committed posture plus the per-step values — never hand-edited. Byte-stable: the same inputs
 * give the same bytes, because the bytes are what the binary validates (patch 0005) and a later
 * pass may hash them. Paths are the sandbox's (`sandboxPaths`); the tokens are the step's and appear
 * here and nowhere in the posture.
 */
export function renderConfigToml(
  posture: LathPosture,
  step: {
    model: string;
    temperature: number;
    modelSocket: string;
    toolsSocket: string;
    token: string;
    toolsToken: string;
    workspacePath: string;
    /**
     * The model's context window in tokens, when the host knows it. Unset, the binary runs against
     * upstream's 32 000-token compatibility fallback and refuses a turn whose retained tokens pass
     * it before dispatch, which a sandbox reading a dozen sources does. It is a per-step value like
     * `model`, not a posture key: the window is a fact about the model the step calls, so it never
     * moves `postureHash` or the policy hash, and a step without it renders the bytes it always did.
     */
    contextWindow?: number;
  }
): string {
  const c = posture.config;
  if (step.contextWindow !== undefined && !(Number.isSafeInteger(step.contextWindow) && step.contextWindow > 0)) {
    // Patch 0005 refuses anything but a positive integer; failing here names the host's bug first.
    throw new Error(`contextWindow must be a positive integer, got ${step.contextWindow}`);
  }
  const lines = [
    `schema_version = ${c.schema_version}`,
    `locale = ${tomlString(c.locale)}`,
    "",
    "[providers.models.custom.lath]",
    `model = ${tomlString(step.model)}`,
    // The host is ignored over a Unix socket; the path is what the proxy routes on (CONTRACT §2).
    `uri = ${tomlString("http://localhost/v1")}`,
    `unix_socket = ${tomlString(sandboxPath("modelSocket", step.modelSocket))}`,
    `api_key = ${tomlString(step.token)}`,
    `native_tools = ${c.native_tools}`,
    `temperature = ${tomlFloat(step.temperature)}`,
    ...(step.contextWindow !== undefined ? [`context_window = ${step.contextWindow}`] : []),
    "",
    `[agents.${ZEROCLAW_AGENT_ALIAS}]`,
    "enabled = true",
    `model_provider = ${tomlString(`custom.${ZEROCLAW_AGENT_ALIAS}`)}`,
    `risk_profile = ${tomlString(ZEROCLAW_AGENT_ALIAS)}`,
    `runtime_profile = ${tomlString(ZEROCLAW_AGENT_ALIAS)}`,
    "",
    `[agents.${ZEROCLAW_AGENT_ALIAS}.workspace]`,
    `path = ${tomlString(sandboxPath("workspacePath", step.workspacePath))}`,
    "",
    `[agents.${ZEROCLAW_AGENT_ALIAS}.memory]`,
    `backend = ${tomlString(c.memory.backend)}`,
    "",
    `[risk_profiles.${ZEROCLAW_AGENT_ALIAS}]`,
    `level = ${tomlString(c.risk_profile.level)}`,
    `workspace_only = ${c.risk_profile.workspace_only}`,
    `allowed_tools = ${tomlStrings(c.risk_profile.allowed_tools)}`,
    `always_ask = ${tomlStrings(c.risk_profile.always_ask)}`,
    `sandbox_enabled = ${c.risk_profile.sandbox_enabled}`,
    "",
    `[runtime_profiles.${ZEROCLAW_AGENT_ALIAS}]`,
    `max_tool_iterations = ${c.runtime_profile.max_tool_iterations}`,
    "",
    "[memory]",
    `backend = ${tomlString(c.memory.backend)}`,
    "",
    "[cost]",
    `enabled = ${c.cost.enabled}`,
    "",
    "[reliability]",
    `provider_retries = ${c.reliability.provider_retries}`,
    "",
    "[lath]",
    `tools_socket = ${tomlString(sandboxPath("toolsSocket", step.toolsSocket))}`,
    `tools_token = ${tomlString(step.toolsToken)}`,
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// The wrapper

function assertKind(posture: LathPosture, kind: WrapperKind): void {
  if (posture.wrapper.kind !== kind) throw new Error(`this posture's wrapper is ${posture.wrapper.kind}, not ${kind}`);
}

/**
 * The `sandbox-exec` profile for one step: the committed template with the sandbox's real paths in
 * it, so the profile applied is the profile committed, placeholder for placeholder. The ancestors
 * are those of the workspace and the config directory, deduplicated and sorted.
 */
export function seatbeltProfile(posture: LathPosture, sandbox: HostSandbox): string {
  assertKind(posture, "sandbox-exec");
  const r = sandboxPaths(posture, sandbox);
  const anc = [...new Set([...ancestors(r.workspace), ...ancestors(r.configDir)])].sort();
  const values = {
    BIN: r.binary,
    WORK: r.workspace,
    CFG: r.configDir,
    MSOCK: r.modelSocket,
    TSOCK: r.toolsSocket,
    ANCESTORS: anc.map((a) => `(literal "${a}")`).join(" "),
    // Filled whether or not the template names it; only a posture with sources does.
    SRC: `${r.workspace}/${SOURCES_DIR}`,
  };
  return `${posture.wrapper.template.map((line) => fill(line, values)).join("\n")}\n`;
}

/**
 * The `bwrap` arguments for one step, up to and including the in-sandbox binary; the binary's own
 * argv (`zeroclawArgv`) follows. `libs` are the absolute paths the binary's loader needs, as the
 * host reads them from `ldd` — each mounted read-only at its own path. `now` fills the committed
 * environment's `ZEROCLAW_NOW`.
 */
export function bwrapArgs(
  posture: LathPosture,
  sandbox: HostSandbox & { libs: readonly string[]; now: Date | string }
): string[] {
  assertKind(posture, "bwrap");
  const values = {
    BIN: sandboxPath("binary", sandbox.binary),
    WORK: sandboxPath("workspace", sandbox.workspace),
    CFG: sandboxPath("configDir", sandbox.configDir),
    MSOCK: sandboxPath("modelSocket", sandbox.modelSocket),
    TSOCK: sandboxPath("toolsSocket", sandbox.toolsSocket),
    // The host's side of the read-only mount; filled whether or not the template names it.
    SRC: `${sandboxPath("workspace", sandbox.workspace)}/${SOURCES_DIR}`,
  };
  const env = stepEnv(posture, { now: sandbox.now, home: BWRAP_SANDBOX.configDir });
  const libs = [...new Set(sandbox.libs.map((l) => sandboxPath("lib", l)))].sort();
  const out: string[] = [];
  for (const a of posture.wrapper.template) {
    if (a === "@ENV@") for (const k of Object.keys(env)) out.push("--setenv", k, env[k]);
    else if (a === "@LIBS@") for (const l of libs) out.push("--ro-bind", l, l);
    else out.push(fill(a, values));
  }
  return out;
}

/**
 * The libraries a binary's loader needs, from `ldd <binary>`'s output: every absolute path on it,
 * sorted and deduplicated — the loader itself (`/lib64/ld-linux-x86-64.so.2 (0x…)`) and each
 * resolved `name => /path (0x…)`. The vDSO has no path and is not a file, so it is not mounted.
 * The host runs `ldd`; this only reads what it printed, so it stays pure.
 */
export function lddLibs(lddOutput: string): string[] {
  const out = new Set<string>();
  for (const m of lddOutput.matchAll(/(?:^|\s)(\/[^\s]+)/g)) out.add(m[1]);
  return [...out].sort();
}

/** What the host passes to `spawn`: the wrapper, its arguments, the whole environment, the cwd. */
export interface SpawnSpec {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * The spawn of one step's process under its wrapper, whole: `argv` is what follows the binary
 * (`zeroclawArgv(...)` for a step; the probe's arguments in the air-gap test). `env` is exactly
 * `stepEnv` — the host must pass it as the spawn's `env`, never merged over `process.env`, which in
 * the Next process holds the treasury and every `LATH_*` secret. The caller adds `detached`
 * and closes stdin (CONTRACT §4).
 */
export function spawnSpec(
  posture: LathPosture,
  sandbox: HostSandbox & { now: Date | string; libs?: readonly string[]; wrapperPath?: string },
  argv: readonly string[]
): SpawnSpec {
  const inside = sandboxPaths(posture, sandbox);
  const env = stepEnv(posture, { now: sandbox.now, home: inside.configDir });
  if (posture.wrapper.kind === "sandbox-exec") {
    // `-p`, not `-f`: the profile holds no secret, and a file would be one more thing in the step
    // directory the sandbox could read.
    return {
      file: sandbox.wrapperPath ?? "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(posture, sandbox), inside.binary, ...argv],
      env,
      cwd: inside.workspace,
    };
  }
  return {
    file: sandbox.wrapperPath ?? "/usr/bin/bwrap",
    args: [...bwrapArgs(posture, { ...sandbox, libs: sandbox.libs ?? [] }), ...argv],
    env,
    cwd: sandboxPath("workspace", sandbox.workspace),
  };
}
