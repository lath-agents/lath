/**
 * Seals a session owes the chain, kept on disk until they can be paid.
 *
 * The seal is a chain write — the bundle registry's structure on the first session of a chain and
 * a locator cell on every one — so a session whose drain failed cannot seal: a cell written while
 * that session's records are still journaled takes the seq the genesis is holding. `/api/run` skips
 * the seal in that case and says so: *the blobs are in the trace directory and the seal can be run
 * once the records have landed*. Something has to run it. Without this note a session that failed
 * and was retried would keep `not sealed` for good — harmless on the `fs` backend, where an audit
 * finds the blobs in `TRACE_DIR` anyway, and not harmless on Irys, where those bytes would then
 * never leave the server that made them.
 *
 * This is the note that outlives the request. `RecordingTraceStore.recorded` is memory; what a
 * deferred seal needs is only the genesis payload hash the bundle is keyed by and the hashes of
 * the blobs, because the blobs themselves are content-addressed in `TRACE_DIR` and are still
 * there. So the note is small, and rebuilding the bundle is a read per blob from the same store
 * the session wrote to.
 *
 * `<TRACE_DIR>/unsealed/<agentIdHex>.json`, one file per chain, a list because a chain can fail
 * twice before anyone clicks. Written the way the anchor journal is written — a temporary file
 * renamed over the target — so a crash mid-write leaves the previous list rather than half of the
 * new one.
 */
import fs from "node:fs";
import path from "node:path";

import { LocatorBackend, LocatorRegistry, SealResult, TraceStore, sealBundle, toBytes32 } from "@lath/sdk";

import { TRACE_DIR } from "./runner";
import { syncDirSync } from "./json-store";

/** One session's unpaid seal: the key the bundle is derived from, and what goes in it. */
export interface UnsealedSession {
  /** Hex of the genesis `payload_hash`; `bundleKey` is derived from it, so it is the bundle's id. */
  genesisPayloadHash: string;
  /** Hex sha256 of every blob the session put, in put order — the bundle's contents. */
  hashes: string[];
  /** When the seal was deferred, so a note that can never be paid can be recognised as old. */
  at: number;
}

function file(agentIdHex: string): string {
  return path.join(TRACE_DIR, "unsealed", `${agentIdHex}.json`);
}

/**
 * The notes this chain owes. A note that is not there is a chain that owes no seal, and reads as
 * `[]`. One that is there and unreadable — an `EMFILE`, a torn write, a file that is not a list —
 * throws: it read as `[]` too, and the next `deferSeal` then wrote its one note over every other
 * note the agent held. Every caller already catches (`deferSeal` here, `sealDeferred`'s callers in
 * `run/route.ts`, `loop-step.ts` and `loop-retry.ts`), so a throw skips the write and keeps the file for a later read,
 * and still fails no session: the seal is a copy made for readers, and its records are on chain.
 */
async function read(agentIdHex: string): Promise<UnsealedSession[]> {
  let text: string;
  try {
    text = await fs.promises.readFile(file(agentIdHex), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file(agentIdHex)} is not a list of deferred seals`);
  return parsed as UnsealedSession[];
}

async function write(agentIdHex: string, sessions: UnsealedSession[]): Promise<void> {
  const target = file(agentIdHex);
  if (sessions.length === 0) {
    await fs.promises.rm(target, { force: true });
    return;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  // Flushed before the rename and the directory after it, as `writeJsonAtomic` does and for its reason.
  const fh = await fs.promises.open(tmp, "w");
  try {
    await fh.writeFile(`${JSON.stringify(sessions, null, 2)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, target);
  syncDirSync(path.dirname(target));
}

/**
 * Remembers that this session could not seal. Never throws: the session has already answered and
 * its records are already journaled, and losing the note costs a bundle, not a chain.
 */
export async function deferSeal(agentIdHex: string, session: UnsealedSession): Promise<void> {
  try {
    const have = await read(agentIdHex);
    // The same genesis twice is the same session seen twice — a second skip for one session, not
    // two sessions — and the bundle is keyed by that hash, so only one of them can ever land.
    const rest = have.filter((s) => s.genesisPayloadHash !== session.genesisPayloadHash);
    await write(agentIdHex, [...rest, session]);
  } catch {
    // Nothing to do about it here, and nothing worth failing for.
  }
}

/** What this chain still owes, oldest first. */
export async function unsealedSessions(agentIdHex: string): Promise<UnsealedSession[]> {
  return read(agentIdHex);
}

/**
 * Pays every seal this chain owes, and forgets the ones that landed.
 *
 * Called after a retry has drained clean, which is the condition the skip was waiting on: the
 * records are on chain, so a cell can be written without taking a seq a journaled record holds.
 * A session whose blobs are no longer in the store is dropped rather than retried for ever — the
 * bytes are what the bundle *is*, and a note that names bytes nobody has cannot become one.
 *
 * Returns one result per session, in the order they were owed, so the caller can say what landed.
 */
export async function sealDeferred(
  agentIdHex: string,
  anchor: { backend: LocatorBackend; registry: LocatorRegistry; store: TraceStore }
): Promise<{ session: UnsealedSession; result: SealResult }[]> {
  const owed = await read(agentIdHex);
  if (owed.length === 0) return [];
  const done: { session: UnsealedSession; result: SealResult }[] = [];
  const keep: UnsealedSession[] = [];
  for (const session of owed) {
    const blobs: Uint8Array[] = [];
    let missing = 0;
    for (const h of session.hashes) {
      const bytes = await anchor.store.get(toBytes32(h)).catch(() => null);
      if (bytes) blobs.push(bytes);
      else missing++;
    }
    if (blobs.length === 0) {
      done.push({ session, result: { error: "none of this session's blobs are in the trace store any more" } });
      continue;
    }
    const result =
      missing > 0
        ? // A partial bundle is worse than none: the key is derived, so a reader who finds a cell
          // for this session stops looking, and the hashes that were dropped would read
          // `unavailable` with nothing to say they are elsewhere.
          ({ error: `${missing} of this session's ${session.hashes.length} blobs are missing` } as SealResult)
        : await sealBundle(anchor, blobs, toBytes32(session.genesisPayloadHash));
    done.push({ session, result });
    if (result.error) keep.push(session);
  }
  await write(agentIdHex, keep);
  return done;
}
