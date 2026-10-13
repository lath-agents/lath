/**
 * `AgentStore` — a small key-value store an agent, its loops and its owner read and write.
 *
 * One public `LathMap` per agent at `struct_id = sha256("store")`. Every write folds into the
 * agent's hash chain like any other cell, so each value an agent acted on is provable, and a key's
 * `version` counts its writes.
 *
 * ## Why every value is committed, even a short one
 *
 * A Map cell's `key_slot` is `sha256(key)`, which cannot be read back into a key name, and a list
 * of `sha256` values is not a store anyone can use. So the cell never holds the value inline: its
 * `value_slot` is `sha256(entry)`, where `entry` is the canonical JSON `{"key","v","value"}` kept
 * in the trace store. A reader fetches the entry, re-hashes it against the slot, and checks
 * `sha256(key)` against the key slot — so neither the blob store nor the server that wrote it is
 * trusted for *what* the entry says, only for keeping it available.
 *
 * ## Who wrote it
 *
 * The chain's signer is always the agent's key: `replace_cell` is owner-only
 * (SPEC §12 #12), and for a console agent the owner key is server-held. The
 * cell's `tag` says on whose behalf the write was made — the agent's own tool call, or the wallet
 * that owns the agent through a signed request (`storeWriteBinding`). The tag is the console's
 * claim, not a signature the chain checked; the signed request is what backs it.
 *
 * ## No delete
 *
 * Closing a Map key retires its address for good (SPEC §12 #5), so a store that deleted would
 * hand out keys that can never be written again. Setting a key to `""` is how a value is cleared.
 *
 * Pure except for `AgentStore`, and free of Node built-ins: the browser reads with the same
 * functions the server writes with.
 */
import { AppendPolicy, Cell, StructMode } from "./cells";
import { CellWriteResult, LathClient } from "./client";
import { Bytes32, hex, idFromString, sha256, utf8 } from "./hash";
import { canonicalJson } from "./market";
import { AuthBinding } from "./signer";
import { LathMap } from "./structures";
import { TraceStore } from "./trace-store";

/** The store's `struct_id`, one per agent. */
export const STORE_ID: Bytes32 = idFromString("store");

/** A key: short, printable, no whitespace — it is shown on screen and typed by a model. */
export const STORE_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
/** A value's ceiling in UTF-8 bytes. The value lives in the trace store, so this is a demo bound, not a cell bound. */
export const MAX_STORE_VALUE_BYTES = 1024;

/** Whose request a write carried, in the cell's `tag`. */
export enum StoreWriter {
  /** The agent's own `store.set` tool call, in a session or a loop step. */
  Agent = 1,
  /** The wallet that owns the agent, through a signed request. */
  Owner = 2,
}

/** Throws when a key or value is outside what the store accepts. */
export function checkStoreEntry(key: string, value: string): void {
  if (!STORE_KEY.test(key)) throw new Error(`a store key must match ${STORE_KEY}: ${JSON.stringify(key)}`);
  const size = utf8(value).length;
  if (size > MAX_STORE_VALUE_BYTES) {
    throw new Error(`a store value holds at most ${MAX_STORE_VALUE_BYTES} bytes, got ${size}`);
  }
}

/** The exact bytes a cell's `value_slot` commits to. */
export function storeEntryBytes(key: string, value: string): Uint8Array {
  checkStoreEntry(key, value);
  return utf8(canonicalJson({ key, v: 1, value }));
}

export function storeKeySlot(key: string): Bytes32 {
  return sha256(utf8(key));
}

/** One key as a reader sees it. `status` says how far the entry could be checked. */
export interface StoreEntry {
  /** `ok`: the entry re-hashed to the slot and its key to the key slot. */
  status: "ok" | "missing" | "mismatch";
  key?: string;
  value?: string;
  keySlot: string;
  /** Writes to this key: 0 for the first `put`, +1 per replace. */
  version: bigint;
  writer: StoreWriter | number;
  opSeq: bigint;
  timestamp: bigint;
}

/**
 * Checks an entry blob against the cell that commits to it. `blob` is whatever the store handed
 * back, or `null` when it had nothing: a missing blob is `missing`, bytes that do not re-hash or
 * name another key are `mismatch`, and neither is shown as a value.
 */
export function openStoreEntry(cell: Cell, blob: Uint8Array | null): StoreEntry {
  const base = {
    keySlot: hex(cell.keySlot),
    version: BigInt(cell.indexOrVersion),
    writer: cell.tag,
    opSeq: BigInt(cell.opSeq),
    timestamp: BigInt(cell.timestamp),
  };
  if (!blob) return { status: "missing", ...base };
  if (hex(sha256(blob)) !== hex(cell.valueSlot)) return { status: "mismatch", ...base };
  let parsed: { key?: unknown; value?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(blob));
  } catch {
    return { status: "mismatch", ...base };
  }
  if (typeof parsed.key !== "string" || typeof parsed.value !== "string") return { status: "mismatch", ...base };
  if (hex(storeKeySlot(parsed.key)) !== base.keySlot) return { status: "mismatch", ...base };
  return { status: "ok", key: parsed.key, value: parsed.value, ...base };
}

/**
 * What an owner's signed store write names: the verb carries the first 128 bits of
 * `sha256(entry)`, so the signature covers the key and the value and not only the agent — a
 * signature for `mode = watch` cannot be posted with `mode = trade`. Used by the browser that
 * signs and by `POST /api/store/<id>` that checks.
 */
export function storeWriteBinding(agentId: string, key: string, value: string): AuthBinding {
  return {
    action: `store.set:${hex(sha256(storeEntryBytes(key, value))).slice(0, 32)}`,
    target: agentId.toLowerCase(),
  };
}

/**
 * The store of one agent. Writes need a client signed by the agent's key; reads need only an
 * indexer and the trace store the entries were written to.
 */
export class AgentStore {
  readonly map: LathMap;

  constructor(
    readonly client: LathClient,
    readonly ownerId: Bytes32,
    readonly store: TraceStore,
    opts: { now?: () => number } = {}
  ) {
    this.map = new LathMap(client, ownerId, STORE_ID, {
      mode: StructMode.Public,
      appendPolicy: AppendPolicy.OwnerOnly,
      store,
      now: opts.now,
    });
  }

  ensureCreated(): Promise<boolean> {
    return this.map.ensureCreated();
  }

  /**
   * Writes `value` under `key`: a `put` the first time, a `replace` after. The entry goes to the
   * trace store *before* the cell that commits to it, so no cell ever names bytes nobody kept.
   */
  async set(key: string, value: string, writer: StoreWriter): Promise<CellWriteResult> {
    const entry = storeEntryBytes(key, value);
    const digest = await this.store.put(entry);
    // A 32-byte value is written as-is by `LathMap.encode`, so the slot is exactly the digest.
    return (await this.map.has(key))
      ? this.map.replace(key, digest, { tag: writer })
      : this.map.put(key, digest, { tag: writer });
  }

  async get(key: string): Promise<StoreEntry | null> {
    const cell = await this.client.getMapCell(this.ownerId, STORE_ID, storeKeySlot(key));
    return cell ? openStoreEntry(cell, await this.store.get(cell.valueSlot)) : null;
  }

  /** Every key, oldest write first. */
  async entries(): Promise<StoreEntry[]> {
    const cells = await this.client.listCells(this.ownerId, STORE_ID);
    return Promise.all(cells.map(async (c) => openStoreEntry(c, await this.store.get(c.valueSlot))));
  }
}
