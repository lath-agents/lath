/**
 * `LathLog`, `LathMap`, `LathSet` — the base structures (SPEC.md §12) with the cell mechanics of
 * `cells.ts` behind an ordinary collection API.
 *
 * ## Where a value lives
 *
 * A cell's `value_slot` is 32 bytes, so the mode decides what goes in it:
 *
 * | mode | `value_slot` | `TraceStore` |
 * |---|---|---|
 * | public, value ≤ 32 B | the value itself, zero-padded | untouched |
 * | public, value > 32 B | `sha256(value)` | holds `value` |
 * | private | `sha256(salt ‖ value)` | holds `salt ‖ value` |
 *
 * Reading resolves the slot through the store: bytes that hash to the slot mean the slot was a
 * commitment, and their absence means it was the value. Both are reported, so a caller never
 * has to guess which it got.
 *
 * Private mode is **content**-private only. The cell exists, its `op_seq` and timestamp are
 * public, and Photon enumerates it like any other. What it hides is the value (behind a salted
 * commitment — an unsalted hash of a status code or a short id is guessable) and, for a `Map`,
 * the key: addresses derive from `sha256(map_secret ‖ key)`, so without the secret you cannot
 * even ask whether a key is present.
 */
import { PublicKey } from "@solana/web3.js";
import {
  AppendPolicy,
  Cell,
  CELL_OFFSETS,
  CellInput,
  CreateStructParams,
  StructKind,
  StructMode,
  valueSlot,
} from "./cells";
import { CellWriteResult, LathClient, PolicyWriteResult } from "./client";
import { Bytes32, hex, idFromString, sha256, utf8, randomBytes } from "./hash";
import { MemoryTraceStore, TraceStore } from "./trace-store";

/** Anything a structure can hold. Objects are stored as canonical-ish JSON. */
export type Value = Uint8Array | string | object;

export function toBytes(v: Value): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return utf8(v);
  return utf8(JSON.stringify(v));
}

export interface StructureOptions {
  /** Defaults to `Public`. Fixed at creation; `ensureCreated` records it in the header. */
  mode?: StructMode;
  /** Where values that do not fit on-chain go. Defaults to in-memory (nothing persisted). */
  store?: TraceStore;
  /** Private mode: the secret that salts values and, for a `Map`, derives key slots. */
  secret?: Uint8Array;
  /** Who may append. Replacing and closing are always the owner's alone. */
  appendPolicy?: AppendPolicy;
  /** `Log` only: may cells be closed (a queue) or not (an audit log). */
  consumable?: boolean;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

/** What a read gives back: the raw slot, plus the value when the store could resolve it. */
export interface Entry {
  cell: Cell;
  /** The 32-byte slot exactly as it is on-chain. */
  slot: Bytes32;
  /** Resolved value, when the slot was inline or the store still holds the committed bytes. */
  value?: Uint8Array;
  /** True when `slot` *is* the value rather than a commitment to it. */
  inline: boolean;
}

abstract class Structure {
  readonly store: TraceStore;
  readonly mode: StructMode;
  /** Private mode only. Exposed for structures built on top (see `abstractions.ts`). */
  readonly secret?: Uint8Array;
  /**
   * The structure's clock. Public because structures built on top of one — `Mailbox`, whose
   * `send` is signed by someone else's client — must stamp cells with the *same* clock, or a
   * deterministic test and a drifting validator both go wrong (see `abstractions.ts`).
   */
  readonly now: () => number;
  protected readonly appendPolicy: AppendPolicy;

  constructor(
    readonly client: LathClient,
    readonly ownerId: Bytes32,
    readonly structId: Bytes32,
    opts: StructureOptions = {}
  ) {
    this.mode = opts.mode ?? StructMode.Public;
    this.store = opts.store ?? new MemoryTraceStore();
    this.secret = opts.secret;
    this.now = opts.now ?? (() => Date.now());
    this.appendPolicy = opts.appendPolicy ?? AppendPolicy.OwnerOnly;
    if (this.mode === StructMode.Private && !this.secret) {
      throw new Error("private mode needs a secret: it derives Map key slots and salts Log references");
    }
  }

  /** The policy this structure was constructed with. */
  get appendPolicyOf(): AppendPolicy {
    return this.appendPolicy;
  }

  protected abstract createParams(): CreateStructParams;

  /** Creates the structure header if it does not exist yet. Idempotent. */
  async ensureCreated(): Promise<boolean> {
    if (await this.client.getHeader(this.ownerId, this.structId)) return false;
    await this.client.createStruct(this.ownerId, this.createParams());
    return true;
  }

  async header() {
    const found = await this.client.getHeader(this.ownerId, this.structId);
    if (!found) throw new Error(`structure ${hex(this.structId)} does not exist for this owner`);
    return found.header;
  }

  /**
   * Rewrites who may append, in place and owner-signed (`set_append_policy`).
   * The structure and its cells stay where they are; one `op_seq` is spent and the change folds
   * into the owner's chain. `policyRef` is the senders' root under `AllowList` and is otherwise
   * kept as the header holds it — a private structure's `sha256(secret)` survives the rewrite.
   * A `Mailbox` reaches this through its `log`.
   */
  async setAppendPolicy(appendPolicy: AppendPolicy, opts: { policyRef?: Bytes32 } = {}): Promise<PolicyWriteResult> {
    return this.client.setAppendPolicy(this.ownerId, this.structId, appendPolicy, {
      ...opts,
      timestamp: this.now(),
    });
  }

  /**
   * Turns a value into the 32 bytes that go on-chain, putting anything that does not fit (or
   * anything at all, in private mode) into the `TraceStore` first.
   *
   * Public for the same reason as `now`: an abstraction that writes cells into someone else's
   * structure has to produce byte-identical slots, and a second implementation of this rule is
   * a second chance to get private mode wrong.
   */
  async encode(value: Value): Promise<{ slot: Bytes32; inline: boolean }> {
    const bytes = toBytes(value);
    if (this.mode === StructMode.Private) {
      // A fresh salt per write, not a fixed one: with a fixed salt, equal values would produce
      // equal commitments and the chain would leak which writes repeat. The store key *is* the
      // commitment — `sha256(salt ‖ value)` is what the store computes and what goes on-chain —
      // so a reader needs no extra index to get from the slot to the bytes.
      const blob = new Uint8Array(32 + bytes.length);
      blob.set(randomBytes(32), 0);
      blob.set(bytes, 32);
      return { slot: await this.store.put(blob), inline: false };
    }
    if (bytes.length <= 32) return { slot: valueSlot(bytes), inline: true };
    return { slot: await this.store.put(bytes), inline: false };
  }

  /** The inverse of `encode`, as far as the store allows. */
  async decode(cell: Cell): Promise<Entry> {
    const slot = cell.valueSlot;
    const stored = await this.store.get(slot);
    if (stored && hex(sha256(stored)) === hex(slot)) {
      // A committed value. In private mode the first 32 bytes are the salt.
      const value = this.mode === StructMode.Private ? stored.slice(32) : stored;
      return { cell, slot, value, inline: false };
    }
    if (this.mode === StructMode.Private) return { cell, slot, inline: false };
    return { cell, slot, value: slot, inline: true };
  }

  protected input(slot: Bytes32, keySlot: Bytes32, opts: { tag?: number; status?: number } = {}): CellInput {
    return {
      timestamp: this.now(),
      tag: opts.tag ?? 0,
      status: opts.status ?? 0,
      keySlot,
      valueSlot: slot,
    };
  }
}

/**
 * Append-only, index-addressed. The v0.1 event log is this structure with a typed payload
 * schema; anything else that must be ordered and permanent is a plain one.
 */
export class LathLog extends Structure {
  /** Deterministic `struct_id` from a name, so a log is addressable by what it is called. */
  static id(name: string): Bytes32 {
    return idFromString(name);
  }

  protected createParams(): CreateStructParams {
    return {
      structId: this.structId,
      kind: StructKind.Log,
      mode: this.mode,
      consumable: this.consumable,
      appendPolicy: this.appendPolicy,
      policyRef: this.mode === StructMode.Private ? sha256(this.secret!) : undefined,
      createdAt: this.now(),
    };
  }

  constructor(client: LathClient, ownerId: Bytes32, structId: Bytes32, opts: StructureOptions = {}) {
    super(client, ownerId, structId, opts);
    this.consumable = opts.consumable ?? false;
  }

  readonly consumable: boolean;

  /** Number of appends so far — the next index. */
  async length(): Promise<bigint> {
    return (await this.header()).lenOrCount;
  }

  /**
   * Appends one entry. `reference` is the indexable link in `key_slot` — a peer, a tool id, a
   * task — and is salted in private mode so it does not leak.
   */
  async append(
    value: Value,
    opts: { tag?: number; status?: number; reference?: Bytes32 } = {}
  ): Promise<CellWriteResult & { index: bigint; slot: Bytes32 }> {
    const { slot } = await this.encode(value);
    const reference = opts.reference ?? new Uint8Array(32);
    const keySlot = this.mode === StructMode.Private ? sha256(this.secret!, reference) : reference;
    const res = await this.client.createCell(this.ownerId, this.structId, this.input(slot, keySlot, opts));
    return { ...res, index: res.cell.indexOrVersion, slot };
  }

  async get(index: bigint | number): Promise<Entry | null> {
    const cell = await this.client.getLogCell(this.ownerId, this.structId, index, this.consumable);
    return cell ? this.decode(cell) : null;
  }

  /** Every live entry, ascending by index. Consumed entries are simply absent. */
  async entries(): Promise<Entry[]> {
    const cells = await this.client.listCells(this.ownerId, this.structId);
    return Promise.all(cells.map((c) => this.decode(c)));
  }

  /** Photon `memcmp` on `tag`, the one user-level field the offsets expose. */
  async entriesByTag(tag: number): Promise<Entry[]> {
    const cells = await this.client.listCells(this.ownerId, this.structId, [
      { offset: CELL_OFFSETS.tag, bytes: Uint8Array.of(tag) },
    ]);
    return Promise.all(cells.map((c) => this.decode(c)));
  }

  /** The provable dequeue: only a consumable Log allows it, and only for the owner. */
  async consume(index: bigint | number): Promise<CellWriteResult> {
    return this.client.closeCell(this.ownerId, this.structId, { index }, this.now());
  }
}

/**
 * Key-addressed and mutable. `put` creates and fails if the key exists — which is what makes
 * the address-tree non-inclusion proof a membership proof — `replace` versions it, `close`
 * removes it.
 */
export class LathMap extends Structure {
  static id(name: string): Bytes32 {
    return idFromString(name);
  }

  protected createParams(): CreateStructParams {
    return {
      structId: this.structId,
      kind: StructKind.Map,
      mode: this.mode,
      appendPolicy: this.appendPolicy,
      policyRef: this.mode === StructMode.Private ? sha256(this.secret!) : undefined,
      createdAt: this.now(),
    };
  }

  /**
   * Where a key lives. Public: `sha256(key)`, so anyone holding the key can check membership.
   * Private: `sha256(secret ‖ key)`, so only holders of the secret can derive the address at
   * all — the map is not enumerable *by key* without it.
   */
  keySlot(key: Value): Bytes32 {
    const bytes = toBytes(key);
    return this.mode === StructMode.Private ? sha256(this.secret!, bytes) : sha256(bytes);
  }

  address(key: Value): PublicKey {
    return this.client.mapCellAddress(this.ownerId, this.structId, this.keySlot(key));
  }

  /**
   * Creates the cell for `key`. Fails if the key was ever written: creating the address needs a
   * non-inclusion proof. A key that was **closed** is refused up front with
   * `MapKeyRetiredError` — see there.
   */
  async put(key: Value, value: Value = new Uint8Array(0), opts: { tag?: number; status?: number } = {}) {
    const keySlot = this.keySlot(key);
    // A closed cell leaves an empty account at its address and the address stays in the tree, so
    // create cannot prove non-inclusion; failing here names the cause the prover would hide.
    const address = this.client.mapCellAddress(this.ownerId, this.structId, keySlot);
    if ((await this.client.cellStateAt(address)) === "closed") throw new MapKeyRetiredError(keySlot);
    const { slot } = await this.encode(value);
    return this.client.createCell(this.ownerId, this.structId, this.input(slot, keySlot, opts));
  }

  async replace(key: Value, value: Value, opts: { tag?: number; status?: number } = {}) {
    const { slot } = await this.encode(value);
    return this.client.replaceCell(
      this.ownerId,
      this.structId,
      this.keySlot(key),
      this.input(slot, this.keySlot(key), opts)
    );
  }

  async get(key: Value): Promise<Entry | null> {
    const cell = await this.client.getMapCell(this.ownerId, this.structId, this.keySlot(key));
    return cell ? this.decode(cell) : null;
  }

  /** Membership by address: no value is fetched and nothing is trusted but the indexer. */
  async has(key: Value): Promise<boolean> {
    return (await this.client.getMapCell(this.ownerId, this.structId, this.keySlot(key))) !== null;
  }

  /**
   * Closes the cell for `key`, and with it **retires the key**: neither `put` nor `replace` can
   * write it again (SPEC §12 #5). To take a value back and publish another later, `replace` it
   * with a status or value that says so rather than closing it.
   */
  async close(key: Value): Promise<CellWriteResult> {
    return this.client.closeCell(this.ownerId, this.structId, { keySlot: this.keySlot(key) }, this.now());
  }

  /**
   * Every live cell. Keys come back as slots, not as keys: `sha256` is not invertible, and in
   * private mode the slot reveals nothing without the secret. Enumeration is by owner and
   * `struct_id`, which is what Photon can filter on.
   */
  async entries(): Promise<Entry[]> {
    const cells = await this.client.listCells(this.ownerId, this.structId);
    return Promise.all(cells.map((c) => this.decode(c)));
  }

  async size(): Promise<number> {
    return (await this.client.listCells(this.ownerId, this.structId)).length;
  }
}

/**
 * A `put` on a `Map` key that was closed at some earlier op.
 *
 * `close_cell` leaves an empty account at the cell's address — Light's `new_close` keeps the
 * address and zeroes the data — and the address tree never drops an address. So `create_cell`
 * cannot prove the address is new, and `replace_cell` has no `Cell` to spend: the key is retired
 * for good. `LathMap.has` and `get` read a closed key as absent, which is right for a reader and
 * is exactly why a writer would otherwise go on to `put` and die on an opaque proof error.
 */
export class MapKeyRetiredError extends Error {
  constructor(readonly keySlot: Bytes32) {
    super(
      `key ${hex(
        keySlot
      )} was closed at some earlier op; closing a Map key retires its address, so it cannot be put again — see SPEC §12 #5`
    );
    this.name = "MapKeyRetiredError";
  }
}

/**
 * `Map` with no value: membership is the whole content. `add` doubles as a proof that the
 * member was *not* there before, since creating the address requires non-inclusion.
 */
export class LathSet extends LathMap {
  async add(member: Value, opts: { tag?: number; status?: number } = {}) {
    return this.put(member, new Uint8Array(0), opts);
  }

  /** Removes a member for good: a deleted member cannot be added again (see `LathMap.close`). */
  async delete(member: Value): Promise<CellWriteResult> {
    return this.close(member);
  }

  /** The members' key slots. Recovering the members themselves needs the original values. */
  async slots(): Promise<Bytes32[]> {
    return (await this.entries()).map((e) => e.cell.keySlot);
  }
}
