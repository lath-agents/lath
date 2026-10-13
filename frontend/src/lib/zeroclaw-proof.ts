/**
 * The ZeroClaw page's proof screen, as pure functions: which file a
 * `zc.file_read` read and whether it is one of the loop's pinned sources on Irys, whether the text the
 * tool handed back re-builds to the pinned file's bytes, what a step's model calls paid on Tempo, and
 * the step's counts by kind.
 *
 * What a `zc.file_*` Action commits, which everything here is shaped by: the proxy sees ZeroClaw's own
 * file tools cross the model socket and records them through `recordToolAction`, so the
 * Action's **args blob** is the model's argument object as JSON (`{"path": "sources/…"}`, and
 * `offset` / `limit` / `encoding` when the model passed them) and its **result blob** is the text
 * ZeroClaw handed back, verbatim. There is no sha256 of the file in either: `file_read` answers with
 * the file's lines numbered (`1: …`) and a `[N lines total]` trailer, so the only way to hold a read
 * to its pinned file is to re-build the bytes from that text and hash them — which this does, and
 * which works only for a whole, un-truncated, UTF-8 read. Anything else is _not comparable_, never a
 * failure. A path is known only once its args blob is read; nothing here guesses one.
 *
 * No React, no network and no hashing of its own — the caller passes `sha256Hex` in — so
 * `tests/zeroclaw-proof.ts` runs every rule in Node, and the page and the test use the same code.
 */

/** The manifest shape this reads, structurally: `SourcesManifest` in `@/types/zeroclaw`. */
export interface ProofManifest {
  sources: { dir: string; files: { path: string; size: number; sha256: string }[] }[];
}

export type ProofVerdict = "match" | "mismatch" | "unavailable";

/** The arguments of a `zc.file_read` / `zc.file_write` Action, from its args blob. */
export interface FileToolArgs {
  path: string;
  /** The model asked for part of the file (`offset` / `limit`), or its bytes as base64. */
  partial: boolean;
}

/** `null` for anything that is not a JSON object with a string `path`: an unparsed `{ _raw }` too. */
export function fileToolArgs(bytes: Uint8Array | undefined | null): FileToolArgs | null {
  if (!bytes) return null;
  try {
    const args = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
    if (!args || typeof args !== "object" || typeof args.path !== "string" || !args.path) return null;
    const partial = args.offset !== undefined || args.limit !== undefined || args.encoding === "base64";
    return { path: args.path, partial };
  } catch {
    return null;
  }
}

/**
 * The path relative to the sandbox's workspace, as the manifest names files: `./` and repeated
 * slashes dropped, and the workspace's absolute path (`/lath/work` under `bwrap`, the replay record's
 * `workspacePath`) stripped when the model spelled it out. `null` for a path that leaves the
 * workspace (`..`, or absolute elsewhere): that is no file of the manifest's, whatever it names.
 */
export function workspaceRelative(path: string, workspacePath?: string | null): string | null {
  let p = path.trim().replace(/\/{2,}/g, "/");
  const root = workspacePath ? workspacePath.replace(/\/+$/, "") : null;
  if (root && (p === root || p.startsWith(`${root}/`))) {
    p = p.slice(root.length).replace(/^\/+/, "");
  } else if (p.startsWith("/")) {
    // Absolute and not under the workspace the record names: outside it, when there is a record
    // to say where it is; without one, read as the workspace-relative path it most likely is.
    if (root) return null;
    p = p.replace(/^\/+/, "");
  }
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

/** Where one read's path points: a file the manifest pins, a path under `sources/` it does not list, or the workspace. */
export type ReadTarget =
  | { kind: "source"; path: string; file: { path: string; size: number; sha256: string }; url: string | null }
  | { kind: "unlisted"; path: string }
  | { kind: "workspace"; path: string };

/**
 * Resolves one read's path against the loop's sources manifest and its Irys index: a file under
 * `sources/` that the manifest lists is a `source`, linked at `{gateway}/{irysId}` when the index
 * names an object for its hash (the same link the Sources card draws); under `sources/` and not
 * listed is `unlisted` — a directory, a typo, or a file the sandbox was never seeded with — and
 * everything else is the step's own `workspace`, such as `report/authority.md`.
 */
export function readTarget(
  path: string,
  manifest: ProofManifest | null,
  irys: { gateway: string; files: Record<string, string> } | null,
  workspacePath?: string | null
): ReadTarget {
  const rel = workspaceRelative(path, workspacePath);
  if (rel === null || !(rel === "sources" || rel.startsWith("sources/")))
    return { kind: "workspace", path: rel ?? path };
  const inner = rel.slice("sources/".length);
  for (const entry of manifest?.sources ?? []) {
    const file = entry.files.find((f) => f.path === inner);
    if (file) {
      const id = irys?.files[file.sha256];
      return { kind: "source", path: rel, file, url: id && irys ? `${irys.gateway}/${id}` : null };
    }
  }
  return { kind: "unlisted", path: rel };
}

/**
 * The file text a `file_read` answer was built from, when the answer is a whole read in ZeroClaw's
 * numbered form (upstream ZeroClaw's `tools/file_read.rs`): every line `n: text`, numbered 1…N with none missing, then
 * `[N lines total]`. `null` for anything else — a partial read (`[Lines a-b of N]`), an error, a
 * lossy or base64 answer, a result the agent loop truncated in the middle — because only a whole
 * read can be held to the whole file. The empty string is an empty file, which ZeroClaw answers
 * with no text at all.
 */
export function rebuildNumberedRead(result: string): { lines: string[] } | null {
  if (result === "") return { lines: [] };
  const all = result.split("\n");
  const trailer = /^\[(\d+) lines total\]$/.exec(all[all.length - 1] ?? "");
  if (!trailer) return null;
  const total = Number(trailer[1]);
  const body = all.slice(0, -1);
  if (body.length !== total) return null;
  const lines: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const prefix = `${i + 1}: `;
    if (!body[i].startsWith(prefix)) return null;
    lines.push(body[i].slice(prefix.length));
  }
  return { lines };
}

/**
 * Whether a read's answer re-builds to the pinned file's sha256. `str::lines` drops the final
 * newline and a `\r` before each `\n`, so the file is one of four texts — `\n` or `\r\n` joins,
 * with or without a trailing newline — and a match on any of them is a match. A whole read that
 * matches none is a `mismatch`: the model was shown lines the pinned file does not have. Anything
 * that cannot be re-built is `unavailable`, with the reason.
 */
export function readMatchesPinned(
  result: string | null,
  status: number,
  pinnedSha256: string,
  sha256Hex: (text: string) => string
): { verdict: ProofVerdict; detail: string } {
  if (result === null) return { verdict: "unavailable", detail: "the read's result is not open on this page" };
  if (status >= 400) return { verdict: "unavailable", detail: "the read failed; there is no file text to compare" };
  const rebuilt = rebuildNumberedRead(result);
  if (!rebuilt) {
    return {
      verdict: "unavailable",
      detail: "not a whole read in file_read's numbered form (a partial, truncated or base64 read)",
    };
  }
  const { lines } = rebuilt;
  const candidates =
    lines.length === 0
      ? [""]
      : [lines.join("\n"), `${lines.join("\n")}\n`, lines.join("\r\n"), `${lines.join("\r\n")}\r\n`];
  const want = pinnedSha256.toLowerCase();
  if (candidates.some((c) => sha256Hex(c) === want)) {
    return { verdict: "match", detail: `the text the model was shown re-builds to ${want.slice(0, 12)}…` };
  }
  return {
    verdict: "mismatch",
    detail: `the text the model was shown does not re-build to the pinned ${want.slice(0, 12)}…`,
  };
}

/** The `payment` an `llm.*` Action's result blob carries on the Tempo rail, the fields this sums. */
export interface ProofPayment {
  channelId: string;
  cumulativeBefore: string;
  cumulativeAfter: string;
}

/** The payment in an `llm.*` result blob, as `paymentFromBlob` in `TracePanel` reads it. */
export function paymentOf(bytes: Uint8Array | undefined | null): ProofPayment | null {
  if (!bytes) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(bytes))?.payment;
    return p?.rail === "tempo" && typeof p.channelId === "string" && p.channelId ? (p as ProofPayment) : null;
  } catch {
    return null;
  }
}

/**
 * One call's gateway price, USDC.e base units: the voucher delta, `cumulativeAfter −
 * cumulativeBefore`, which is what left the payer's channel for it (`gatewayPrice` in
 * `lib/tempo.ts`, kept here too because that module is a hook module a Node test cannot load).
 */
export function voucherDelta(p: ProofPayment): bigint {
  try {
    const d = BigInt(p.cumulativeAfter || "0") - BigInt(p.cumulativeBefore || "0");
    return d > BigInt(0) ? d : BigInt(0);
  } catch {
    return BigInt(0);
  }
}

/** The step's model calls, summed: the total, and the channels they rode (one, on every loop today). */
export function sumPayments(payments: readonly (ProofPayment | null)[]): {
  paid: number;
  total: bigint;
  channels: string[];
} {
  let total = BigInt(0);
  const channels: string[] = [];
  let paid = 0;
  for (const p of payments) {
    if (!p) continue;
    paid++;
    total += voucherDelta(p);
    const c = p.channelId.toLowerCase();
    if (!channels.includes(c)) channels.push(c);
  }
  return { paid, total, channels };
}

/**
 * The `llm.*` tool ids a step's model calls can carry, by name: `llm.<model>` for the model the
 * policy document commits, which is what the runtime writes when the provider answers with that id
 * (`runtime.ts`). An answer under a dated id is a different name, and its Action stays unnamed on
 * a locked page — the count then says fewer calls than there were, never more.
 */
export function llmToolNames(policyDocument: string | null | undefined): string[] {
  if (!policyDocument) return [];
  try {
    const m = (JSON.parse(policyDocument) as { model?: unknown } | null)?.model;
    return typeof m === "string" && m ? [`llm.${m}`] : [];
  } catch {
    return [];
  }
}

/** What one step's Actions add up to, by kind, from public chain data (tool ids) alone. */
export interface StepCounts {
  reads: number;
  writes: number;
  modelCalls: number;
  /** Host tools and anything else named or unnamed that is neither of the above. */
  other: number;
}

export function stepCounts(
  actions: readonly { tool: string | null; toolHash: string }[],
  llmHashes: ReadonlySet<string>
): StepCounts {
  const counts: StepCounts = { reads: 0, writes: 0, modelCalls: 0, other: 0 };
  for (const a of actions) {
    if (a.tool === "zc.file_read") counts.reads++;
    else if (a.tool === "zc.file_write") counts.writes++;
    else if ((a.tool && a.tool.startsWith("llm.")) || llmHashes.has(a.toolHash.toLowerCase())) counts.modelCalls++;
    else if (a.tool !== "loop.step") counts.other++;
  }
  return counts;
}
