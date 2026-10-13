import { hex, sha256, utf8 } from "@lath/sdk";
import type { LathPosture, WrapperKind } from "./posture";

/**
 * A sandbox's posture in clear on Irys, and the jail rules it names, read back anywhere.
 *
 * The posture is the object `postureHash` hashes (`posture.ts`): `sha256(canonicalJson(posture))`.
 * What goes up is exactly those bytes — no tag line in front, unlike the sources index — so the hash a
 * Genesis commits (under `sandbox` in the policy document) is the hash of the object on Irys, and a
 * stranger re-hashes the download against it with nothing from the console in between.
 *
 * Safe to publish because of how `posture.ts` splits it: the committed posture holds no token, no
 * socket path, no step directory, no clock and no host path. The environment, the argv and the
 * wrapper are templates whose `@NAME@` placeholders are filled only at spawn, and what fills them is
 * either a secret that never enters the posture (the proxy's and the tool listener's tokens, in the
 * TOML) or a per-step value the replay record commits on its own. What the posture does say — the
 * binary's hash, the patch set, the tool list, the workspace cap, the sources' hash — the page
 * already shows every viewer.
 *
 * Pure and free of Node built-ins, so the ZeroClaw page imports it as it imports `sources.ts`.
 */

/**
 * The most a posture download is read to. A posture is a few kilobytes; the cap only bounds what a
 * hostile id can make a reader hold.
 */
export const POSTURE_IRYS_MAX_BYTES = 64 * 1024;

/** The tags a posture is uploaded with, in the style `publishSources` tags a set. */
export function postureIrysTags(postureHash: string): { name: string; value: string }[] {
  return [
    // Served as JSON, so a gateway link opens as the text it is; the bytes are canonical JSON.
    { name: "Content-Type", value: "application/json" },
    { name: "Lath-Kind", value: "sandbox.posture" },
    { name: "Lath-Posture-Hash", value: postureHash },
  ];
}

/** What reading a posture's bytes back came to: the posture, or why it is not the one committed. */
export type PostureBytesCheck =
  | { ok: true; hash: string; json: string; posture: LathPosture }
  | { ok: false; hash: string | null; why: string };

/**
 * Bytes fetched from anywhere, held to the posture hash a step committed: re-hashed first, then
 * parsed. A mismatch names both hashes; bytes that hash right but are not a posture say so, which
 * only a posture writer's bug could produce.
 */
export function checkPostureBytes(bytes: Uint8Array, expected: string): PostureBytesCheck {
  if (bytes.length > POSTURE_IRYS_MAX_BYTES) {
    return { ok: false, hash: null, why: `${bytes.length} bytes, over the ${POSTURE_IRYS_MAX_BYTES}-byte cap` };
  }
  const got = hex(sha256(bytes));
  if (got !== expected) return { ok: false, hash: got, why: `re-hashed to ${got}, the step committed ${expected}` };
  let json: string;
  let parsed: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, hash: got, why: "the bytes hash right but are not JSON" };
  }
  const posture = parsed as LathPosture | null;
  if (!posture || typeof posture !== "object" || posture.version !== 1 || !wrapperOf(posture)) {
    return { ok: false, hash: got, why: "the bytes hash right but are not a version-1 posture with a wrapper" };
  }
  return { ok: true, hash: got, json, posture };
}

/** The posture's bytes as they go up: the JSON string the sandbox recorded, as UTF-8. */
export function postureBytes(postureJson: string): Uint8Array {
  return utf8(postureJson);
}

function wrapperOf(p: { wrapper?: unknown }): { kind: WrapperKind; template: string[] } | null {
  const w = p.wrapper as { kind?: unknown; template?: unknown } | undefined;
  if (!w || (w.kind !== "sandbox-exec" && w.kind !== "bwrap")) return null;
  if (!Array.isArray(w.template) || !w.template.every((l) => typeof l === "string")) return null;
  return { kind: w.kind, template: w.template as string[] };
}

// ─── The jail rules, as the posture names them ─────────────────────────────

/**
 * What each placeholder a wrapper template can name stands for. Shown beside the rules rather than
 * filled in: the values are one step's host paths, which nothing commits, and the rules a Genesis
 * commits are the template.
 */
export const WRAPPER_PLACEHOLDERS: Readonly<Record<string, string>> = Object.freeze({
  BIN: "the Lath-patched binary's path on the host",
  WORK: "the loop's workspace directory",
  CFG: "the step's own config directory",
  MSOCK: "the model proxy's Unix socket",
  TSOCK: "the host-tool listener's Unix socket",
  SRC: "the workspace's sources/ directory",
  ANCESTORS: 'one (literal "…") per parent directory of the workspace and the config directory',
  LIBS: "one --ro-bind per library the binary's loader needs, at its own path",
  ENV: "one --setenv per entry of the posture's env, after --clearenv",
});

/** One sentence per wrapper kind: what the rules below it are. */
export const WRAPPER_EXPLAINED: Readonly<Record<WrapperKind, string>> = Object.freeze({
  "sandbox-exec":
    "A macOS sandbox-exec (Seatbelt) profile: (deny default) refuses everything the lines below do not " +
    "allow, and where two lines match the later one decides.",
  bwrap:
    "Linux bubblewrap arguments: --unshare-all gives the process its own namespaces, network included, " +
    "and only what is bound below is mounted.",
});

/**
 * How many arguments each `bwrap` flag the template uses takes, so one rule is one line. A flag not
 * listed takes every argument up to the next flag, which is right for any flag whose arguments are
 * not themselves flags.
 */
const BWRAP_ARITY: Readonly<Record<string, number>> = Object.freeze({
  "--unshare-all": 0,
  "--die-with-parent": 0,
  "--new-session": 0,
  "--clearenv": 0,
  "--proc": 1,
  "--dev": 1,
  "--tmpfs": 1,
  "--chdir": 1,
  "--ro-bind": 2,
  "--bind": 2,
  "--dev-bind": 2,
  "--symlink": 2,
  "--setenv": 2,
});

export interface JailRules {
  kind: WrapperKind;
  explained: string;
  /** One rule per line, placeholders left as `@NAME@`. */
  lines: string[];
  /** Each placeholder the rules name, in first-use order, with what it stands for. */
  placeholders: { name: string; meaning: string }[];
}

/**
 * The wrapper template a posture commits, as rules to read: the Seatbelt profile one line per
 * template line, as the host writes it; the `bwrap` arguments grouped one flag and its operands per
 * line, and the in-sandbox binary the last argument names on a line of its own. Nothing is filled:
 * a placeholder stays `@NAME@`, and `placeholders` says what it stands for.
 *
 * These are the rules the committed posture names. That the process ran under them is the host's
 * claim — nothing here, or on chain, shows it.
 */
export function jailRules(posture: Pick<LathPosture, "wrapper">): JailRules | null {
  const w = wrapperOf(posture);
  if (!w) return null;
  const lines = w.kind === "bwrap" ? bwrapLines(w.template) : [...w.template];
  const seen: string[] = [];
  for (const line of lines) {
    for (const m of line.matchAll(/@([A-Z]+)@/g)) if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return {
    kind: w.kind,
    explained: WRAPPER_EXPLAINED[w.kind],
    lines,
    placeholders: seen.map((name) => ({ name, meaning: WRAPPER_PLACEHOLDERS[name] ?? "a value filled at spawn" })),
  };
}

function bwrapLines(args: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith("--")) {
      // A placeholder that expands to whole rules (`@ENV@`, `@LIBS@`), or the binary the sandbox runs.
      out.push(a);
      i++;
      continue;
    }
    const arity = BWRAP_ARITY[a];
    let end = i + 1;
    if (arity !== undefined) end = Math.min(args.length, i + 1 + arity);
    else while (end < args.length && !args[end].startsWith("--")) end++;
    out.push(args.slice(i, end).join(" "));
    i = end;
  }
  return out;
}
