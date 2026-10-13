/**
 * What changed since a loop's Solana sources were pinned: before every step the host re-reads each
 * Solana source of the loop's manifest at `confirmed` and compares it with the files the start pinned. The sandbox is told the
 * result in one note of its step's message (`sourcesRefreshNote`, `withSourcesNote`); nothing here
 * writes a file, and the pinned `sources/`, the `lath.sources.v1` manifest and `sourcesHash` are the
 * start's for the loop's whole life.
 *
 * Why: sources are pinned at start and the sandbox has no network, so without this a chain change —
 * the demo's program authority moving to a council vault on stage — would never reach a step of a
 * loop on the clock. The pin stays the evidence the loop cites; this says what the chain holds now,
 * beside it.
 *
 * What is compared, each against the pinned file it lives in:
 *
 * - a program of the upgradeable loader (`program.json` pinned): its upgrade authority,
 *   `authorityKind` and last deploy slot, from the programdata's 45-byte header;
 * - any other account: its owner, its size, the `sha256` of its data (when `account.json` pinned the
 *   bytes), and — when the data moved and `decoded.json` was pinned — each top-level field of the
 *   account decoded again with its owner's IDL.
 *
 * The reads are bounded: one `getAccountInfo` per source, plus the programdata's header for a
 * program. Decoding needs the owner's IDL, taken from the same manifest when the owner program is
 * itself a source (its pinned `idl.json`), and otherwise read once per owner and kept for the
 * process — one more read, the first time an IDL-decoded account's data moves. Devnet is read
 * through the console's RPC, mainnet through `LATH_MAINNET_RPC` (`defaultSourcesDeps`), each source
 * under its own deadline.
 *
 * A read that fails is a row of the note — `could not re-read <address>: <reason>` — and the step
 * runs on what it has pinned: a chain read is never a `SandboxRefused`. Nothing here throws.
 */
import {
  solanaSourceEntries,
  sourceChangeValue,
  sourcesRefreshNote,
  sourcesRefreshUnread,
  type ResolvedSource,
  type SourceChange,
  type SourceEntry,
  type SourceRefresh,
  type SourcesManifest,
} from "@lath/runtime/zeroclaw/sources";
import { errorText } from "@lath/runtime";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
  PROGRAMDATA_HEADER,
  UPGRADEABLE_LOADER,
  authorityKind,
  decodeWithIdl,
  getAccount,
  readAnchorIdl,
  sha256Hex,
  type Ctx,
  type RpcAccount,
  type SourcesDeps,
} from "./sources";

/** One source's re-read, every request of it together: a step waits on this before its sandbox opens. */
const REFRESH_SOURCE_TIMEOUT_MS = 20_000;

/** Owner IDLs read for a decode, by RPC and owner. Only a readable IDL is kept; a missing one is asked again. */
export type IdlCache = Map<string, { idl: unknown; address: string }>;
const PROCESS_IDLS: IdlCache = new Map();

type Solana = Extract<ResolvedSource, { kind: "solana" }>;
type Change = (what: string, from: unknown, to: unknown) => void;

interface PinnedAccount {
  owner: string;
  space: number;
  /** Base64, or `null` when the account was over the per-file cap and its bytes were left out. */
  data: string | null;
}

interface PinnedProgram {
  programData: string;
  upgradeAuthority: string | null;
  authorityKind: string;
  lastDeploySlot: string;
}

interface PinnedDecoded {
  owner: string;
  idl: string;
  accountType: string;
  data: unknown;
}

/**
 * A pinned file of `entry`, parsed, or `undefined` when the manifest pins none by that name. Read from
 * the fetched directory the sandboxes are seeded from, and held to the manifest's hash first: a copy
 * edited on the host is not what the loop pinned, and comparing against it would report a change
 * that never happened on chain.
 */
function pinnedFile(dir: string, entry: SourceEntry, name: string): unknown {
  const rel = `${entry.dir}/${name}`;
  const file = entry.files.find((f) => f.path === rel);
  if (!file) return undefined;
  const bytes = fs.readFileSync(path.join(dir, ...rel.split("/")));
  if (sha256Hex(bytes) !== file.sha256) {
    throw new Error(`the pinned sources/${rel} on this host no longer matches the manifest`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A program of the upgradeable loader: who can upgrade it now, and when it was last deployed. */
async function programChanges(
  ctx: Ctx,
  rpc: string,
  pinned: PinnedProgram,
  acct: RpcAccount,
  data: Buffer,
  slot: number,
  change: Change,
  changes: SourceChange[]
): Promise<void> {
  if (acct.owner !== UPGRADEABLE_LOADER || !acct.executable || data.length < 36 || data.readUInt32LE(0) !== 2) {
    changes.push({ what: "program.json", from: "an upgradeable program", to: "not an upgradeable program now" });
    return;
  }
  const programData = new PublicKey(data.subarray(4, 36)).toBase58();
  change("program.json programData", pinned.programData, programData);
  // The header only: the ELF is up to 10 MiB, and nothing the note says is in it.
  const pd = await getAccount(ctx, rpc, programData, slot, { offset: 0, length: PROGRAMDATA_HEADER });
  if (!pd.value) {
    changes.push({
      what: "program.json programData",
      from: programData,
      to: "no account now (the program was closed)",
    });
    return;
  }
  const header = Buffer.from(pd.value.data[0], "base64");
  if (header.length < PROGRAMDATA_HEADER || header.readUInt32LE(0) !== 3) {
    throw new Error(`${programData} is not an upgradeable loader programdata account`);
  }
  const authority = header[12] === 1 ? new PublicKey(header.subarray(13, 45)).toBase58() : null;
  change("program.json upgradeAuthority", pinned.upgradeAuthority, authority);
  change("program.json authorityKind", pinned.authorityKind, authorityKind(authority));
  change("program.json lastDeploySlot", pinned.lastDeploySlot, header.readBigUInt64LE(4).toString());
}

/**
 * The IDL `decoded.json` was made with, to decode the account again: the owner program's pinned
 * `idl.json` when the owner is itself a source of this manifest on the same cluster, else the
 * owner's IDL account, read once for the process.
 */
async function ownerIdl(
  ctx: Ctx,
  rpc: string,
  manifest: SourcesManifest,
  dir: string,
  cluster: Solana["cluster"],
  pinned: PinnedDecoded,
  slot: number,
  idls: IdlCache
): Promise<{ idl: unknown; address: string } | null> {
  for (const { entry } of solanaSourceEntries(manifest)) {
    const s = entry.source as Solana;
    if (s.cluster !== cluster || s.address !== pinned.owner) continue;
    const idl = pinnedFile(dir, entry, "idl.json");
    if (idl !== undefined) return { idl, address: pinned.idl };
  }
  const key = `${rpc}\u0000${pinned.owner}`;
  const kept = idls.get(key);
  if (kept) return kept;
  const read = await readAnchorIdl(ctx, rpc, new PublicKey(pinned.owner), slot);
  if (read.kind !== "json") return null;
  const got = { idl: read.idl, address: read.address };
  idls.set(key, got);
  return got;
}

/** An IDL-decoded account whose data moved: each top-level field of the decode, old → new. */
async function decodedChanges(
  ctx: Ctx,
  rpc: string,
  manifest: SourcesManifest,
  dir: string,
  cluster: Solana["cluster"],
  pinned: PinnedDecoded,
  data: Buffer,
  slot: number,
  idls: IdlCache,
  change: Change,
  changes: SourceChange[]
): Promise<void> {
  let idl: { idl: unknown; address: string } | null;
  try {
    idl = await ownerIdl(ctx, rpc, manifest, dir, cluster, pinned, slot, idls);
  } catch (e) {
    const why = errorText(e);
    changes.push({ what: "decoded.json", from: `a ${pinned.accountType}`, to: `not decoded: its owner's IDL: ${why}` });
    return;
  }
  if (!idl) {
    changes.push({
      what: "decoded.json",
      from: `a ${pinned.accountType}`,
      to: "not decoded: its owner has no IDL now",
    });
    return;
  }
  const d = decodeWithIdl(idl.idl, idl.address, pinned.owner, data);
  if (d.kind === "skip") {
    changes.push({ what: "decoded.json", from: `a ${pinned.accountType}`, to: `not decoded: ${d.why}` });
    return;
  }
  change("decoded.json accountType", pinned.accountType, d.accountType);
  if (!isRecord(pinned.data) || !isRecord(d.value)) {
    change("decoded.json data", pinned.data, d.value);
    return;
  }
  const was = pinned.data;
  const now = d.value;
  for (const k of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    change(`decoded.json data.${k}`, was[k], now[k]);
  }
}

async function refreshOne(
  n: number,
  entry: SourceEntry,
  manifest: SourcesManifest,
  dir: string,
  deps: SourcesDeps,
  idls: IdlCache
): Promise<SourceRefresh> {
  const s = entry.source as Solana;
  const row = { n, address: s.address, pinnedSlot: s.slot };
  try {
    const rpc = deps.rpc[s.cluster];
    if (!rpc) {
      throw new Error(
        s.cluster === "mainnet" ? "LATH_MAINNET_RPC is unset on this host" : "LATH_RPC_URL is unset on this host"
      );
    }
    const account = pinnedFile(dir, entry, "account.json") as PinnedAccount | undefined;
    if (!account) throw new Error("the manifest pins no account.json for it");
    const program = pinnedFile(dir, entry, "program.json") as PinnedProgram | undefined;
    const decoded = pinnedFile(dir, entry, "decoded.json") as PinnedDecoded | undefined;

    const ctx: Ctx = { deps, deadline: deps.now() + REFRESH_SOURCE_TIMEOUT_MS };
    const read = await getAccount(ctx, rpc, s.address);
    const slot = String(read.slot);
    const changes: SourceChange[] = [];
    const change: Change = (what, from, to) => {
      const f = sourceChangeValue(from);
      const t = sourceChangeValue(to);
      if (f !== t) changes.push({ what, from: f, to: t });
    };
    if (!read.value) {
      changes.push({ what: "account.json", from: `an account owned by ${account.owner}`, to: "no account now" });
      return { ...row, slot, changes };
    }
    const acct = read.value;
    const data = Buffer.from(acct.data[0], "base64");
    change("account.json owner", account.owner, acct.owner);
    if (program) {
      await programChanges(ctx, rpc, program, acct, data, read.slot, change, changes);
      return { ...row, slot, changes };
    }
    change("account.json space", account.space, data.length);
    // An account pinned over the per-file cap has no bytes to compare; its decode, when one was
    // pinned, is then compared on every step rather than only when the hash moved.
    const moved = account.data === null || sha256Hex(Buffer.from(account.data, "base64")) !== sha256Hex(data);
    if (account.data !== null) {
      change("account.json data sha256", sha256Hex(Buffer.from(account.data, "base64")), sha256Hex(data));
    }
    if (decoded && moved && acct.owner === decoded.owner) {
      await decodedChanges(ctx, rpc, manifest, dir, s.cluster, decoded, data, read.slot, idls, change, changes);
    }
    return { ...row, slot, changes };
  } catch (e) {
    return { ...row, error: errorText(e) };
  }
}

/** Every Solana source of the loop re-read, in manifest order; empty for a loop with none. Never throws. */
export async function refreshSolanaSources(
  sources: { manifest: SourcesManifest; dir: string },
  deps: SourcesDeps,
  idls: IdlCache = PROCESS_IDLS
): Promise<SourceRefresh[]> {
  return Promise.all(
    solanaSourceEntries(sources.manifest).map(({ n, entry }) =>
      refreshOne(n, entry, sources.manifest, sources.dir, deps, idls)
    )
  );
}

/**
 * The step's _changed since pinned_ note, or `undefined` for a loop with no Solana source — which then
 * makes no request and is told nothing. Never rejects: whatever fails is a line of the note.
 */
export async function sourcesRefreshNoteFor(
  sources: { manifest: SourcesManifest; dir: string } | undefined,
  deps: SourcesDeps,
  idls: IdlCache = PROCESS_IDLS
): Promise<string | undefined> {
  if (!sources || solanaSourceEntries(sources.manifest).length === 0) return undefined;
  try {
    return sourcesRefreshNote(await refreshSolanaSources(sources, deps, idls));
  } catch (e) {
    return sourcesRefreshNote(sourcesRefreshUnread(sources.manifest, errorText(e)));
  }
}
