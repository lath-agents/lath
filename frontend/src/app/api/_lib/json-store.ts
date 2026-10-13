/**
 * The JSON files under `LATH_TRACE_DIR` that are the console's memory — `agents.json`,
 * `templates.json`, `loops.json` and the rest — read and written one way.
 *
 * Two rules, each closing one failure:
 *
 * - **Only a missing file is an empty store.** A store that answered an empty map to *any* read
 *   error would let the write that follows — a deploy's `recordAgent`, a template's
 *   `recordTemplate` — save that empty map over the file: one transient `EMFILE` on
 *   `readFileSync` plus one deploy would leave `agents.json` holding only that deploy's agent. So
 *   `ENOENT` yields `empty()`, because only then is there nothing to lose, and every other read
 *   error throws, so the write that would have followed is refused and the file stays as it was.
 *   A parse error throws for the same reason: a file that is not JSON is one somebody has to look
 *   at, not one to overwrite.
 * - **A write is a write beside the file and a rename**, so a crash never leaves half a store.
 *   The temp name carries the pid, so two processes on one directory (a dev server and a seed
 *   script) do not write into each other's half-written file. The temp file is flushed before the
 *   rename and the directory after it (`writeFlushedSync`, `syncDirSync`): a rename can reach the
 *   disk before the bytes it names, and a power loss between the two would leave a zero-length store
 *   that every later read refuses — the rule above, turned against the file it protects.
 *
 * Synchronous on purpose, as the callers are: each store is read, changed and written in one
 * call so two edits arriving together cannot each write a map built from the same stale read.
 * `tempo-keys.ts` and `unsealed.ts` keep their own writers — theirs are mode 0600 and async.
 */
import * as fs from "fs";
import * as path from "path";

/** The file's parsed JSON, `empty()` when there is no file, and a throw for anything else. */
export function readJsonOr<T>(file: string, empty: () => T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return empty();
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    // Named, because the next thing anyone does with this error is open the file.
    throw new Error(`${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Writes `value` as indented JSON: mkdir, `${file}.${pid}.tmp`, write and flush, rename, flush the directory. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFlushedSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
  syncDirSync(path.dirname(file));
}

/**
 * Writes `data` to `file` and flushes it to the disk before returning. `flag` is `"w"` for a temp
 * file about to be renamed over its target, `"wx"` for a file that must not exist yet (a loop's key);
 * `mode` applies only when the file is created, as with `writeFileSync`.
 */
export function writeFlushedSync(file: string, data: string, opts: { mode?: number; flag?: "w" | "wx" } = {}): void {
  const fd = fs.openSync(file, opts.flag ?? "w", opts.mode ?? 0o666);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Flushes a directory's entries, so a rename or a create in it survives a power loss. Best effort:
 * Windows cannot open a directory, and some filesystems refuse to flush one; the file's own flush
 * is then all the guarantee there is, and a write that already landed must not fail over it.
 */
export function syncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Above: nothing more can be done on this platform.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
