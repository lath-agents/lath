/**
 * The closed beta: which wallets may take an action this console pays for.
 *
 * Every model call a session or a loop step makes is paid from the operator's Tempo treasury in
 * real USDC.e, and a deploy, a clone and a store write each spend the server's
 * SOL. The per-wallet quotas bound none of that against a stranger, because a devnet wallet is
 * free to mint and the Circle faucet funds it; a console open to the internet is a console anyone
 * can drain by rotating wallets. So on a public deployment the operator names the wallets that may
 * spend, and every other caller keeps every read and is told where the waitlist is.
 *
 * Pure admission. Nothing here is hashed, signed, committed or written: a refusal happens before a
 * route builds a transaction, opens a channel or takes the run slot, and an admitted request runs
 * exactly as it would with the gate off.
 *
 * The list is `LATH_BETA_WALLETS` (base58 addresses separated by commas or whitespace) and/or
 * `LATH_BETA_FILE` (one address per line, `#` starts a comment), the union of the two. With
 * neither set the gate is off and nothing changes — `npm run dev:devnet`, the Playwright suite and
 * every node suite set neither. Both are read at every call rather than captured at load, so a
 * suite can turn the gate on and off; the file is re-read only when its stat changes, so adding a
 * wallet is an edit to the file and not a restart.
 *
 * Fails closed: a `LATH_BETA_FILE` that cannot be read refuses everyone, the wallets
 * `LATH_BETA_WALLETS` names included, and says why in the server log. Opening the gate because a
 * file went missing would turn an operator's typo, a deploy that forgot to copy the file or an
 * editor's save-by-rename into an open console; refusing for a moment is the cheaper mistake. An
 * entry that is not an address is logged by its position and ignored, never thrown on, and never
 * echoed: a line that is not a public key may be something the operator did not mean to paste,
 * such as a secret key, and the log is not where it should land.
 *
 * Environment (documented with the rest in `runner.ts`):
 *   LATH_BETA_WALLETS   invited wallets, inline
 *   LATH_BETA_FILE      a file of invited wallets, re-read when it changes
 *   LATH_WAITLIST_URL   where a refusal points (default https://getlath.xyz)
 *
 * This module imports no other console module, so a route can ask it before it loads anything
 * heavier, and a node suite can load it alone.
 */
import * as fs from "fs";
import { PublicKey } from "@solana/web3.js";

export const DEFAULT_WAITLIST_URL = "https://getlath.xyz";

type Env = Record<string, string | undefined>;

/** Empty means unset, as `env()` in `runner.ts` reads it: an exported `""` is not a list. */
function setting(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

/** The canonical base58 of a 32-byte key, or `null` for anything else. */
function canonical(raw: string): string | null {
  try {
    const key = new PublicKey(raw).toBase58();
    // Round-tripped, so the set holds one spelling per wallet and a lookup compares like with like.
    return key === raw ? key : null;
  } catch {
    return null;
  }
}

/**
 * The addresses in `text`. Commas and whitespace separate entries, `#` comments to the end of its
 * line. What is not an address is counted, logged by line and position, and dropped.
 */
function parseList(text: string, source: string): Set<string> {
  const wallets = new Set<string>();
  const ignored: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const entries = line
      .replace(/#.*$/, "")
      .split(/[\s,]+/)
      .filter(Boolean);
    entries.forEach((entry, j) => {
      const key = canonical(entry);
      if (key) wallets.add(key);
      else ignored.push(entries.length > 1 ? `line ${i + 1} entry ${j + 1}` : `line ${i + 1}`);
    });
  });
  if (ignored.length) {
    console.warn(
      `[beta] ${source}: ignoring ${ignored.length} ${ignored.length === 1 ? "entry" : "entries"} that ` +
        `${ignored.length === 1 ? "is" : "are"} not a Solana address (${ignored.join(", ")})`
    );
  }
  return wallets;
}

/**
 * What the last read found, once per process. On `globalThis` for the reason the nonce map in
 * `runner.ts` is: Next compiles each route into its own module graph, so a module-level memo here
 * would be one per route bundle — each reading the file and logging its bad lines on its own.
 */
interface BetaState {
  inline: { raw: string; wallets: Set<string> } | null;
  file: { path: string; stamp: string; wallets: Set<string> } | null;
  /** The reason the file was last unreadable, so it is logged once per failure and not per request. */
  fileError: string | null;
}
const STATE_KEY = Symbol.for("lath.betaList");
function state(): BetaState {
  const g = globalThis as any;
  if (g[STATE_KEY] === undefined) {
    const fresh: BetaState = { inline: null, file: null, fileError: null };
    g[STATE_KEY] = fresh;
  }
  return g[STATE_KEY] as BetaState;
}

/**
 * The file's wallets, re-read when its stat moves, or why it cannot be read.
 *
 * The stamp is the mtime with the size and the inode beside it: an edit within the file system's
 * mtime resolution still changes the size, and an editor that saves by writing a new file and
 * renaming it over the old one changes the inode. A file that cannot be stat'ed or read is not
 * remembered as anything — the next request asks again, so a file that comes back is in force at
 * once, and a list held from before it went missing is never served in its place.
 */
function readFile(file: string, s: BetaState): { wallets: Set<string> } | { broken: string } {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a regular file");
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    let read = s.file;
    if (!(read && read.path === file && read.stamp === stamp)) {
      read = { path: file, stamp, wallets: parseList(fs.readFileSync(file, "utf8"), `LATH_BETA_FILE ${file}`) };
      s.file = read;
    }
    if (s.fileError) {
      console.warn(`[beta] LATH_BETA_FILE ${file} is readable again; its ${read.wallets.size} wallets are in force`);
      s.fileError = null;
    }
    return { wallets: read.wallets };
  } catch (e: any) {
    s.file = null;
    const reason = `${file}: ${e?.code ?? e?.message ?? String(e)}`;
    if (s.fileError !== reason) {
      console.error(`[beta] LATH_BETA_FILE cannot be read (${reason}); every gated action is refused until it can`);
      s.fileError = reason;
    }
    return { broken: reason };
  }
}

type BetaList = { on: false } | { on: true; lists: Set<string>[] } | { on: true; broken: string };

function betaList(env: Env): BetaList {
  const inline = setting(env, "LATH_BETA_WALLETS");
  const file = setting(env, "LATH_BETA_FILE");
  if (!inline && !file) return { on: false };
  const s = state();
  let listed = s.inline;
  if (!listed || listed.raw !== inline) {
    listed = { raw: inline, wallets: parseList(inline, "LATH_BETA_WALLETS") };
    s.inline = listed;
  }
  if (!file) return { on: true, lists: [listed.wallets] };
  const read = readFile(file, s);
  if ("broken" in read) return { on: true, broken: read.broken };
  return { on: true, lists: [listed.wallets, read.wallets] };
}

/** Whether the gate is on: either variable names a list, even an empty or unreadable one. */
export function betaEnabled(env: Env = process.env): boolean {
  return !!(setting(env, "LATH_BETA_WALLETS") || setting(env, "LATH_BETA_FILE"));
}

/**
 * Why `wallet` may not take an action this console pays for, or `null` when it may.
 *
 * `null` always while the gate is off. On, a `null` wallet — a request nobody signed, or whose
 * signature was refused — is refused: an anonymous session runs scripted and bills nobody, but it
 * still writes a real chain on the server's SOL, and it is the one kind of request that needs no
 * wallet at all, so it is the cheapest to repeat. The route passes the wallet it has already verified by signature, or the one its
 * `prepare` names and whose signature its `confirm` proves; this only answers whether it is listed.
 */
export function betaRefusal(wallet: string | null, env: Env = process.env): string | null {
  const list = betaList(env);
  if (!list.on) return null;
  const waitlist = setting(env, "LATH_WAITLIST_URL") || DEFAULT_WAITLIST_URL;
  if ("broken" in list) {
    return (
      "Lath is in closed beta, and this console cannot read its invite list right now, so nothing it pays " +
      `for can start. Try again shortly, or join the waitlist at ${waitlist}.`
    );
  }
  const key = wallet ? canonical(wallet) : null;
  if (key && list.lists.some((l) => l.has(key))) return null;
  const who = wallet ? `${wallet} is not an invited wallet` : "this request is not signed by an invited wallet";
  return (
    `Lath is in closed beta: only invited wallets can run sessions, deploy, clone or start ` +
    `loops here, and ${who}. Everything stays readable. Join the waitlist at ${waitlist}.`
  );
}

/**
 * `betaRefusal` as the answer a route returns: 403 with `{ error }`, the status and shape every
 * route already uses for "this wallet may not", so the browser's error display shows the sentence
 * as it shows any other refusal. `note` is appended in brackets — `/api/run` says there why a
 * signature it was sent did not count.
 */
export function betaRefused(wallet: string | null, note?: string | null): Response | null {
  const refusal = betaRefusal(wallet);
  if (!refusal) return null;
  return Response.json({ error: note ? `${refusal} (${note})` : refusal }, { status: 403 });
}
