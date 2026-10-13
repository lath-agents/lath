/**
 * `TaskGraph` and `Mailbox` — abstractions built on `LathLog` / `LathSet` with **no new on-chain
 * code**. Everything here is a naming convention over cells that already exist.
 */
import { PublicKey } from "@solana/web3.js";
import { AppendPolicy, allowListProof, allowListRoot, Cell, CELL_OFFSETS, StructKind, StructMode } from "./cells";
import { CellWriteResult, LathClient } from "./client";
import { Bytes32, hex, idFromString, sha256, toBytes32 } from "./hash";
import { Entry, LathLog, LathMap, LathSet, StructureOptions, toBytes, Value } from "./structures";

/** An edge as it comes back from a query. */
interface Edge {
  from: Bytes32;
  to: Bytes32;
  /** Edge kind, caller-defined. `0` when unset. */
  tag: number;
  /** The owner's operation counter when the edge was added — its place in the history. */
  opSeq: bigint;
  cell: Cell;
}

/**
 * A directed task graph: delegations, dependencies, call trees.
 *
 * Edges live in a **`Log`**, not a `Map`. A `Map` cell is addressed *by*
 * its `key_slot`, so the key that makes out-edges enumerable — `sha256(from)`, shared by every
 * edge leaving a node — would collide with itself on the second edge. A `Log` addresses by
 * index, which leaves `key_slot` free to be exactly that shared value, and Photon can filter on
 * it at `CELL_OFFSETS.keySlot`. Edges are append-only, which is what a record of what happened
 * should be.
 *
 * `to` is stored inline in the 32-byte value slot, so the graph is reconstructible from chain
 * data alone — no trace store required to walk it.
 */
export class TaskGraph {
  readonly log: LathLog;

  constructor(
    client: LathClient,
    ownerId: Bytes32,
    graphId: Bytes32 = idFromString("task-graph"),
    opts: StructureOptions = {}
  ) {
    this.log = new LathLog(client, ownerId, graphId, { ...opts, consumable: false });
  }

  static id(name: string): Bytes32 {
    return idFromString(name);
  }

  async ensureCreated(): Promise<boolean> {
    return this.log.ensureCreated();
  }

  /**
   * The logical out-edge key, `sha256(from)`. In private mode `LathLog.append` salts
   * references with the structure secret, so what is actually on-chain is `storedOutKey`.
   */
  outKey(from: Bytes32 | PublicKey): Bytes32 {
    return sha256(node(from));
  }

  /** What a query has to match: the salted form in private mode, the plain one otherwise. */
  private storedOutKey(from: Bytes32 | PublicKey): Bytes32 {
    const key = this.outKey(from);
    return this.log.mode === StructMode.Private ? sha256(this.log.secret!, key) : key;
  }

  /**
   * Records `from → to`. `tag` is a caller-defined edge kind (delegation, dependency, retry…);
   * anything richer belongs in the trace store, keyed by the value the caller passes.
   */
  async addEdge(
    from: Bytes32 | PublicKey,
    to: Bytes32 | PublicKey,
    opts: { tag?: number } = {}
  ): Promise<CellWriteResult & { index: bigint }> {
    return this.log.append(node(to), { tag: opts.tag ?? 0, reference: this.outKey(from) });
  }

  /** Every edge, in the order they were recorded. */
  async edges(): Promise<Edge[]> {
    return (await this.log.entries()).map((e) => toEdge(e.cell));
  }

  /** Edges leaving one node — one Photon `memcmp` at the `key_slot` offset, no scan. */
  async outEdges(from: Bytes32 | PublicKey): Promise<Edge[]> {
    const cells = await this.log.client.listCells(this.log.ownerId, this.log.structId, [
      { offset: CELL_OFFSETS.keySlot, bytes: this.storedOutKey(from) },
    ]);
    return cells.map(toEdge);
  }

  /**
   * Edges arriving at one node — a `memcmp` on the value slot, which holds `to` verbatim.
   * Public mode only: a private graph commits its values, so `to` is not on-chain to match.
   */
  async inEdges(to: Bytes32 | PublicKey): Promise<Edge[]> {
    if (this.log.mode === StructMode.Private) {
      throw new Error("inEdges needs public mode: a private graph commits `to` rather than storing it");
    }
    const cells = await this.log.client.listCells(this.log.ownerId, this.log.structId, [
      { offset: CELL_OFFSETS.valueSlot, bytes: node(to) },
    ]);
    return cells.map(toEdge);
  }

  /**
   * The graph as DOT (`dot`, `neato`, …). Nodes are hex-truncated for readability; pass `label`
   * to name them.
   */
  async toDot(label: (id: Bytes32) => string = (id) => hex(id).slice(0, 8)): Promise<string> {
    const lines = ["digraph lath {", "  rankdir=LR;"];
    for (const e of await this.edges()) {
      const attrs = e.tag ? ` [label="${e.tag}"]` : "";
      lines.push(`  "${label(e.from)}" -> "${label(e.to)}"${attrs};`);
    }
    lines.push("}");
    return lines.join("\n");
  }

  /** The same graph as JSON, for anything that is not graphviz. */
  async toJson(): Promise<{ edges: { from: string; to: string; tag: number; opSeq: string }[] }> {
    return {
      edges: (await this.edges()).map((e) => ({
        from: hex(e.from),
        to: hex(e.to),
        tag: e.tag,
        opSeq: e.opSeq.toString(),
      })),
    };
  }
}

/** `from` is only recoverable as its out-key: `sha256` is one-way, which is the point. */
function toEdge(cell: Cell): Edge {
  return { from: cell.keySlot, to: cell.valueSlot, tag: cell.tag, opSeq: cell.opSeq, cell };
}

function node(v: Bytes32 | PublicKey): Bytes32 {
  return v instanceof PublicKey ? v.toBytes() : toBytes32(v);
}

/**
 * A queue owned by its **recipient**: producers append, only the owner dequeues.
 *
 * It is a consumable `Log`, so `close_cell` is the dequeue and it is provable — the cell is
 * gone, and the `CellWritten{op: CLOSE}` fold in the owner's chain is the receipt. Senders are
 * gated by the structure's `append_policy`: `Anyone`, or an `AllowList` whose Merkle root the
 * header commits to.
 */
export class Mailbox {
  readonly log: LathLog;

  constructor(
    client: LathClient,
    /** The **recipient**: the mailbox lives in their namespace and their chain. */
    readonly recipientId: Bytes32,
    mailboxId: Bytes32 = idFromString("mailbox"),
    opts: StructureOptions & { senders?: PublicKey[] } = {}
  ) {
    this.senders = opts.senders;
    this.log = new LathLog(client, recipientId, mailboxId, {
      ...opts,
      consumable: true,
      appendPolicy: opts.appendPolicy ?? (opts.senders ? AppendPolicy.AllowList : AppendPolicy.Anyone),
    });
  }

  readonly senders?: PublicKey[];

  static id(name: string): Bytes32 {
    return idFromString(name);
  }

  /**
   * Creates the mailbox. Must be signed by the recipient: it is their structure.
   *
   * `policy_ref` is one 32-byte field and an allow-list mailbox spends it on the sender root,
   * so an allow-listed **private** mailbox cannot also commit to `sha256(secret)` the way a
   * plain private `Log` does. That is a layout constraint, not an oversight — the secret still
   * salts every slot, it is simply not committed on-chain — and it is why this method builds
   * its own `createParams` instead of deferring to `LathLog`.
   */
  async ensureCreated(): Promise<boolean> {
    if (await this.log.client.getHeader(this.log.ownerId, this.log.structId)) return false;
    await this.log.client.createStruct(this.log.ownerId, {
      structId: this.log.structId,
      kind: StructKind.Log,
      mode: this.log.mode,
      consumable: true,
      appendPolicy: this.log.appendPolicyOf,
      policyRef: this.senders
        ? allowListRoot(this.senders)
        : this.log.mode === StructMode.Private
        ? sha256(this.log.secret!)
        : undefined,
      createdAt: this.log.now(),
    });
    return true;
  }

  /**
   * Appends a message. `sender` is the client of whoever is sending — not the recipient — and
   * must be on the allow list when the mailbox has one.
   *
   * The returned `index` is what the recipient passes to `consume`, so a producer can tell a
   * consumer exactly which message to dequeue — the runtime's delegation hand-off depends on
   * it. `slot` is what went on-chain, so a recipient who was handed the message bytes out of
   * band can check that the cell commits to *those* bytes before consuming it.
   *
   * The value is encoded by the mailbox's own rules (`LathLog.encode`): inline when it fits,
   * committed to the store otherwise, salted in private mode. Note that in private mode the
   * bytes land in the **recipient's** store instance, which a remote sender may not share — a
   * private mailbox across a process boundary needs a store both sides can reach.
   */
  async send(
    sender: LathClient,
    message: Value,
    opts: { tag?: number; status?: number } = {}
  ): Promise<CellWriteResult & { index: bigint; slot: Bytes32 }> {
    if (this.senders && !this.senders.some((s) => s.equals(sender.authority.publicKey))) {
      throw new Error(
        `${sender.authority.publicKey.toBase58()} is not on this mailbox's allow list; the program would reject the append`
      );
    }
    const { slot } = await this.log.encode(message);
    const res = await sender.createCell(this.log.ownerId, this.log.structId, {
      tag: opts.tag ?? 0,
      status: opts.status ?? 0,
      keySlot: sha256(sender.authority.publicKey.toBytes()),
      valueSlot: slot,
      allowListProof: this.senders ? allowListProof(this.senders, sender.authority.publicKey) : undefined,
      timestamp: this.log.now(),
    });
    return { ...res, index: res.cell.indexOrVersion, slot };
  }

  /** Undelivered messages, oldest first. */
  async pending(): Promise<Entry[]> {
    return this.log.entries();
  }

  /** One undelivered message by index; `null` once it has been consumed. */
  async get(index: bigint | number): Promise<Entry | null> {
    return this.log.get(index);
  }

  /** Messages from one sender — `key_slot` is `sha256(sender)`. */
  async fromSender(sender: PublicKey) {
    const cells = await this.log.client.listCells(this.log.ownerId, this.log.structId, [
      { offset: CELL_OFFSETS.keySlot, bytes: sha256(sender.toBytes()) },
    ]);
    return cells;
  }

  /** The provable dequeue. Only the recipient can do it. */
  async consume(index: bigint | number): Promise<CellWriteResult> {
    return this.log.consume(index);
  }
}

/**
 * Policy commitment registry: resolves a genesis event's `policy_version_hash` to
 * a published policy, with **no new on-chain code** — it is a public `Map` keyed by the policy
 * hash. The address non-inclusion proof behind `put` makes `publish` a proof of *first*
 * publication; the Map owner is the authority; `Cell.indexOrVersion` is the version
 * (`amend` bumps it); `close` revokes. The registry lives in the operator's namespace, so
 * resolution is by (operator, hash) and cannot be squatted by a third party.
 *
 * `publish` hashes the exact bytes it stores, so a policy hashed elsewhere — e.g. the
 * runtime's canonical-JSON `policyVersionHash` — resolves here as long as the same bytes are
 * what gets published.
 */
export class PolicyRegistry {
  readonly map: LathMap;

  constructor(
    client: LathClient,
    /** The operator whose policies these are; the registry folds into their chain. */
    ownerId: Bytes32,
    registryId: Bytes32 = idFromString("policy-registry"),
    opts: StructureOptions = {}
  ) {
    this.map = new LathMap(client, ownerId, registryId, opts);
  }

  static id(name: string): Bytes32 {
    return idFromString(name);
  }

  async ensureCreated(): Promise<boolean> {
    return this.map.ensureCreated();
  }

  /** What `policy_version_hash` should be for a policy document: the hash of its bytes. */
  static hashOf(policy: Value): Bytes32 {
    return sha256(toBytes(policy));
  }

  /**
   * Publishes a policy. Fails if this hash was ever published to this registry — creating the
   * cell requires proving its address did not exist, which is what makes the first publication
   * provable. A hash that was revoked fails too, with `MapKeyRetiredError`: revocation retires
   * the key (see `revoke`). Returns the hash a genesis event should carry.
   */
  async publish(policy: Value, opts: { tag?: number } = {}): Promise<{ hash: Bytes32; result: CellWriteResult }> {
    const hash = PolicyRegistry.hashOf(policy);
    const result = await this.map.put(hash, policy, opts);
    return { hash, result };
  }

  /**
   * Replaces the document behind a hash — a correction, not a new policy: a policy whose
   * *rules* change must change its hash, and that is a new `publish`. Bumps the version.
   */
  async amend(hash: Bytes32 | string, policy: Value): Promise<CellWriteResult> {
    return this.map.replace(toBytes32(hash), policy);
  }

  /**
   * Resolves a hash — from a genesis event's `policy_version_hash` — to what was published.
   * `null` means never published here, or revoked.
   */
  async resolve(
    hash: Bytes32 | string
  ): Promise<{ hash: Bytes32; version: bigint; publishedAt: bigint; entry: Entry } | null> {
    const key = toBytes32(hash);
    const entry = await this.map.get(key);
    if (!entry) return null;
    return { hash: key, version: entry.cell.indexOrVersion, publishedAt: entry.cell.timestamp, entry };
  }

  /** Membership without fetching the document. */
  async has(hash: Bytes32 | string): Promise<boolean> {
    return this.map.has(toBytes32(hash));
  }

  /**
   * Revokes a policy. The nullified cell and the chain fold remain as the audit trail.
   * Revocation is permanent: a closed key cannot be put again (SPEC §12 #5), so the same hash can
   * never be re-published here. A policy that may come back should be `amend`ed with a status
   * that says it is suspended rather than revoked.
   */
  async revoke(hash: Bytes32 | string): Promise<CellWriteResult> {
    return this.map.close(toBytes32(hash));
  }
}

/**
 * The owner's own name, published by the owner, checked by arithmetic.
 *
 * `agent_id = sha256(name)` is one-way, so the chain can confirm a name you already hold and can
 * never hand you one. The usual conclusion — a name registry someone runs, with a signature
 * check on who may claim what — is unnecessary here, and this is why: an owner can publish the
 * *preimage* of its own id in its own namespace, and a reader re-hashes it. A wrong name is
 * arithmetically wrong, so nothing about the publication has to be trusted, and there is no
 * authority to squat, bribe or take offline. A separate name-registry service would have nothing
 * left to do.
 *
 * A `Map` with one key, rather than a bare cell, so the same structure can later carry other
 * self-certifying facts without moving what is already there.
 *
 * The name must be **at most 32 bytes** — it rides inline in the cell. Longer than that and
 * `Structure.encode` would commit it by hash, which is the one thing this must not do: the value
 * of publishing a preimage is that it is *there*, not that it is committed to. `LathMap`'s
 * own `keySlot` hashing is unaffected; only the value has to be readable.
 */
export class NameRecord {
  readonly map: LathMap;
  /** The single key. Named so a reader with no SDK can still find the cell. */
  static readonly KEY = "name";
  /** Longer names are still valid ids — they just cannot be published this way. */
  static readonly MAX_BYTES = 32;

  constructor(
    client: LathClient,
    readonly ownerId: Bytes32,
    profileId: Bytes32 = idFromString("profile"),
    opts: StructureOptions = {}
  ) {
    if (opts.mode !== undefined && opts.mode !== StructMode.Public) {
      throw new Error("a name record is public: a private one commits the name instead of publishing it");
    }
    this.map = new LathMap(client, ownerId, profileId, { ...opts, mode: StructMode.Public });
  }

  static id(name: string): Bytes32 {
    return idFromString(name);
  }

  async ensureCreated(): Promise<boolean> {
    return this.map.ensureCreated();
  }

  /**
   * Publishes the owner's name. Refuses a name that is not this owner's — the check is
   * `sha256(name) === ownerId`, the same one a reader makes, done before spending a write on a
   * claim that could never verify.
   */
  async publish(name: string): Promise<CellWriteResult> {
    const bytes = toBytes(name);
    if (bytes.length === 0) throw new Error("a name is not empty");
    if (bytes.length > NameRecord.MAX_BYTES) {
      throw new Error(
        `a published name holds ${NameRecord.MAX_BYTES} bytes inline, got ${bytes.length}; longer names are valid ids but cannot be published`
      );
    }
    if (hex(idFromString(name)) !== hex(this.ownerId)) {
      throw new Error(`"${name}" hashes to ${hex(idFromString(name))}, not to this owner ${hex(this.ownerId)}`);
    }
    return (await this.map.has(NameRecord.KEY))
      ? this.map.replace(NameRecord.KEY, bytes)
      : this.map.put(NameRecord.KEY, bytes);
  }

  /**
   * The owner's name, or `null` if none is published **or the published one does not hash to
   * this owner**. The two are deliberately the same answer: an unverifiable name is not a name,
   * and returning it with a flag invites a caller to render it anyway.
   *
   * Use `read()` when you want to see what was actually written.
   */
  async name(): Promise<string | null> {
    const found = await this.read();
    return found?.verified ? found.name : null;
  }

  /** What is on chain and whether it checks out — for a UI that must explain a mismatch. */
  async read(): Promise<{ name: string; verified: boolean; cell: Cell } | null> {
    const entry = await this.map.get(NameRecord.KEY);
    if (!entry?.value) return null;
    // The slot is zero-padded to 32; the name is what precedes the padding.
    const trimmed = entry.value.slice(0, trimEnd(entry.value));
    const name = new TextDecoder().decode(trimmed);
    return { name, verified: hex(idFromString(name)) === hex(this.ownerId), cell: entry.cell };
  }

  /**
   * Withdraws the name. The cell's history stays in the chain fold. This is **permanent**: the
   * one key is retired (SPEC §12 #5), so a later `publish` on this owner throws
   * `MapKeyRetiredError` instead of re-publishing.
   */
  async withdraw(): Promise<CellWriteResult> {
    return this.map.close(NameRecord.KEY);
  }
}

/** Index one past the last non-zero byte — `value_slot` pads, and a name never ends in NUL. */
function trimEnd(bytes: Uint8Array): number {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return end;
}
