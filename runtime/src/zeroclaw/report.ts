/**
 * The file a sandboxed step leaves as its report: what the host PUTs to Tempo storage after the
 * step's leaf lands.
 *
 * **Which file.** The one the step *wrote* under `report/` — added, or changed from what the step
 * started with — and the first in the tree's order when it wrote several. The standing instructions
 * the demo runs say `Keep your answer in report/authority.md`, and a step that left the report as it
 * found it (or wrote none) publishes nothing: republishing the same bytes would pay for a key the
 * previous step already stored, and a step with nothing new has no deliverable. A convention rather
 * than a policy field, on purpose: a policy field would move `policy_version_hash`, which this build
 * must not touch.
 *
 * **Where it is read from.** The trace store, not the workspace on disk. The next step starts in the
 * same directory seconds later and may rewrite the file before a PUT that runs off the step's clock
 * gets to it; the store holds every file a step wrote under its content hash, the trees under
 * `workspaceBefore` and `workspaceAfter`, and the replay record naming both under the step's
 * committed `replayHash` — so the bytes read here are the ones the step's own record names, whenever
 * they are read. Every blob is re-hashed on the way in.
 *
 * Node-only because the tree parser lives beside the walker, which reads the filesystem; `LoopRunner`
 * is handed this through `stepReport` rather than importing it.
 */
import { hex, sha256, toBytes32, type TraceStore } from "@lath/sdk";
import type { StorageReportFile } from "../loop-tempo";
import { EMPTY_WORKSPACE_HASH, parseTreeBytes, workspaceChanges, type WorkspaceEntry } from "./workspace";

/** The directory a step's report is looked for in. */
export const REPORT_DIR = "report";

const HEX64 = /^[0-9a-f]{64}$/;

/** A blob by its hex hash, re-hashed on arrival; `null` for nothing, or for other bytes. */
async function blob(store: TraceStore, hash: string): Promise<Uint8Array | null> {
  if (!HEX64.test(hash)) return null;
  const bytes = await store.get(toBytes32(hash)).catch(() => null);
  return bytes && hex(sha256(bytes)) === hash ? bytes : null;
}

/**
 * The workspace hashes a step's replay record spans: `workspaceBefore` of its first record and
 * `workspaceAfter` of its last. A synthesis step's `replayHash` names the fold `[recordA, recordB]`,
 * and B starts where A ended, so the step's writes are everything between the two ends.
 */
export function replaySpan(bytes: Uint8Array): { before: string; after: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const records = (Array.isArray(parsed) ? parsed : [parsed]) as {
    workspaceBefore?: unknown;
    workspaceAfter?: unknown;
  }[];
  const first = records[0];
  const last = records[records.length - 1];
  const before = first?.workspaceBefore;
  const after = last?.workspaceAfter;
  if (typeof before !== "string" || typeof after !== "string" || !HEX64.test(before) || !HEX64.test(after)) {
    return null;
  }
  return { before, after };
}

async function tree(store: TraceStore, hash: string): Promise<WorkspaceEntry[] | null> {
  if (hash === EMPTY_WORKSPACE_HASH) return [];
  const bytes = await blob(store, hash);
  if (!bytes) return null;
  try {
    return parseTreeBytes(bytes);
  } catch {
    return null;
  }
}

/**
 * The report the step under `replayHash` wrote, or `null` when it wrote none or it cannot be read
 * back. A `workspaceBefore` tree the store does not hold — a sandbox's first step with seeded
 * sources — counts as empty: every file under `report/` is then new, which on a first step it is.
 */
export async function stepReportFile(
  store: TraceStore,
  replayHash: string | undefined,
  dir: string = REPORT_DIR
): Promise<StorageReportFile | null> {
  if (!replayHash) return null;
  const record = await blob(store, replayHash);
  const span = record ? replaySpan(record) : null;
  if (!span) return null;
  const after = await tree(store, span.after);
  if (!after) return null;
  const before = (await tree(store, span.before)) ?? [];
  const changes = workspaceChanges(before, after, { sources: true });
  const written = new Set([...changes.added, ...changes.modified].map((f) => f.path));
  const prefix = `${dir}/`;
  for (const entry of after) {
    if (entry.kind !== "file" || !entry.path.startsWith(prefix) || !written.has(entry.path)) continue;
    const bytes = await blob(store, entry.sha256);
    return bytes ? { path: entry.path, bytes } : null;
  }
  return null;
}
