import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AnchoredEpochStore,
  computeHead,
  EventKind,
  EventRecord,
  GENESIS_HEAD,
  hex,
  i64le,
  idFromString,
  LathClient,
  Locator,
  LocatorBackend,
  LocatorRegistry,
  LocatorScheme,
  MemoryEpochStore,
  reanchorEpochs,
  sha256,
  u16le,
  u64le,
  type Bytes32,
} from "../sdk/src";
import { decodeCell, decodeStructHeader } from "../sdk/src/layout";
import { Cell, StructHeader, StructKind, StructMode } from "../sdk/src";

/**
 * No validator and no RPC. Two read-side promises, each driven from a stub:
 *
 * - Photon's cursor repeats accounts across pages and can come back unchanged. The page walks
 *   under `verifyChain` must hold each account once — a record folded twice reads as a divergence
 *   at its seq, so an honest chain would audit BROKEN — and must stop on a
 *   cursor that does not move.
 * - An epoch whose blob uploaded but whose locator cell did not land stays anchorable: a retry in
 *   the same process still finds its locator, and `reanchorEpochs` finds its bytes afterwards.
 */

const PROGRAM_ID = new PublicKey("AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz");
const AGENT = idFromString("photon-paging-agent");

function encode(r: EventRecord): Uint8Array {
  const out = new Uint8Array(147);
  out.set(r.agentId, 0);
  out.set(u64le(r.seq), 32);
  out.set(i64le(r.timestamp), 40);
  out[48] = r.kind;
  out.set(u16le(r.status), 49);
  out.set(r.reference, 51);
  out.set(r.payloadHash, 83);
  out.set(r.head, 115);
  return out;
}

function chain(n: number): { records: EventRecord[]; head: Bytes32 } {
  const records: EventRecord[] = [];
  let head: Bytes32 = GENESIS_HEAD;
  for (let i = 0n; i < BigInt(n); i++) {
    const r: EventRecord = {
      agentId: AGENT,
      seq: i,
      timestamp: 1_700_000_000_000n + i,
      kind: EventKind.Action,
      status: 0,
      reference: new Uint8Array(32),
      payloadHash: sha256(new Uint8Array([Number(i)])),
      head: new Uint8Array(32),
    };
    r.head = computeHead(head, AGENT, i, r);
    head = r.head;
    records.push(r);
  }
  return { records, head };
}

type Page = { items: unknown[]; cursor: string | null };

/** A client whose Photon reads are answered by `pages(cursor)`; everything else is unreachable. */
function clientWith(pages: (cursor: string | undefined) => Page, signatures?: (cursor?: string) => Page): LathClient {
  const rpc = {
    getCompressedAccountsByOwner: async (_: unknown, opts: { cursor?: string }) => pages(opts?.cursor),
    getCompressionSignaturesForAddress: async (_: unknown, opts: { cursor?: string }) =>
      (signatures ?? (() => ({ items: [], cursor: null })))(opts?.cursor),
    getTransaction: async () => null,
  };
  return new LathClient(rpc as any, { programId: PROGRAM_ID, coder: {} } as any, Keypair.generate());
}

describe("Photon paging", () => {
  const { records, head } = chain(3);
  const probe = new LathClient({} as any, { programId: PROGRAM_ID } as any, Keypair.generate());
  const item = (r: EventRecord) => ({
    data: { data: Buffer.from(encode(r)) },
    address: probe.eventAddress(AGENT, r.seq).toBytes(),
  });

  it("holds a record a later page repeats once, so the honest chain still verifies", async () => {
    // Page 2 repeats seq 1, as the cursor did at `limit: 100` on devnet.
    const client = clientWith((cursor) =>
      cursor === undefined
        ? { items: [item(records[0]), item(records[1])], cursor: "c1" }
        : { items: [item(records[1]), item(records[2])], cursor: null }
    );
    const events = await client.listEvents(AGENT);
    assert.deepEqual(
      events.map((e) => e.seq.toString()),
      ["0", "1", "2"]
    );

    const reads = client as any;
    reads.getAgentState = async () => ({
      account: {},
      state: { authority: PublicKey.default, agentId: AGENT, seq: 3n, head, createdAt: 0n, updatedAt: 0n },
    });
    const v = await client.verifyChain(AGENT);
    assert.isTrue(v.ok, `firstBadSeq ${v.firstBadSeq}`);
    assert.isUndefined(v.firstBadSeq);
    assert.isTrue(v.headReached);
  });

  it("stops on a cursor that comes back unchanged instead of paging forever", async () => {
    let calls = 0;
    const client = clientWith(() => {
      if (++calls > 10) throw new Error("paged past an unchanged cursor");
      return { items: [item(records[0])], cursor: "stuck" };
    });
    const events = await client.listEvents(AGENT);
    assert.equal(events.length, 1);
    assert.equal(calls, 2, "the first page, then the one that returned the same cursor");

    calls = 0;
    assert.deepEqual(await client.listStructs(AGENT), []);
    assert.equal(calls, 2);
    calls = 0;
    assert.deepEqual(await client.listOwnerCells(AGENT, []), []);
    assert.equal(calls, 2);
  });

  it("walks transaction history to an end when its signature cursor sticks, each signature once", async () => {
    let calls = 0;
    const client = clientWith(
      () => ({ items: [], cursor: null }),
      () => {
        if (++calls > 10) throw new Error("paged past an unchanged cursor");
        return { items: [{ signature: "sig-a" }, { signature: "sig-b" }], cursor: "stuck" };
      }
    );
    let fetched = 0;
    (client as any).rpc.getTransaction = async () => {
      fetched++;
      return null;
    };
    const history = await client.readHistory(AGENT);
    assert.deepEqual(history.events, []);
    assert.equal(calls, 2);
    assert.equal(fetched, 2, "a signature the second page repeated is read once");
  });
});

// ─── Cells and headers: one copy each, the latest ───────────────────────────

const STRUCT = idFromString("photon-paging-struct");

function encodeCell(c: Cell): Uint8Array {
  const out = new Uint8Array(187);
  out.set(c.ownerId, 0);
  out.set(c.structId, 32);
  out.set(u64le(c.indexOrVersion), 64);
  out.set(u64le(c.opSeq), 72);
  out.set(i64le(c.timestamp), 80);
  out[88] = c.tag;
  out.set(u16le(c.status), 89);
  out.set(c.keySlot, 91);
  out.set(c.valueSlot, 123);
  out.set(c.head, 155);
  return out;
}

function encodeHeader(h: StructHeader): Uint8Array {
  const out = new Uint8Array(116);
  out.set(h.ownerId, 0);
  out.set(h.structId, 32);
  out[64] = h.kind;
  out[65] = h.mode;
  out.set(u64le(h.lenOrCount), 66);
  out.set(u64le(h.createdOpSeq), 74);
  out[82] = h.consumable ? 1 : 0;
  out[83] = h.appendPolicy;
  out.set(h.policyRef, 84);
  return out;
}

const mapHeader = (lenOrCount: bigint, appendPolicy = 0): StructHeader => ({
  ownerId: AGENT,
  structId: STRUCT,
  kind: StructKind.Map,
  mode: StructMode.Public,
  lenOrCount,
  createdOpSeq: 0n,
  consumable: false,
  appendPolicy,
  policyRef: new Uint8Array(32),
});

/** One Map key's cell at `version`, written at `opSeq`. */
const mapCell = (key: number, version: bigint, opSeq: bigint): Cell => ({
  ownerId: AGENT,
  structId: STRUCT,
  indexOrVersion: version,
  opSeq,
  timestamp: 1_700_000_000_000n,
  tag: 0,
  status: 0,
  keySlot: sha256(new Uint8Array([key])),
  valueSlot: sha256(new Uint8Array([key, Number(version)])),
  head: new Uint8Array(32),
});

/** A client with the layout decoders, so cells and headers decode without an Anchor coder. */
function cellClient(pages: (cursor: string | undefined) => Page): LathClient {
  const client = clientWith(pages) as any;
  client.decodeCell = decodeCell;
  client.decodeStructHeader = decodeStructHeader;
  client.getHeader = async () => ({ account: {}, header: mapHeader(2n) });
  return client as LathClient;
}

describe("Photon paging over cells and headers", () => {
  const probe = new LathClient({} as any, { programId: PROGRAM_ID } as any, Keypair.generate());
  const cellItem = (c: Cell) => ({
    data: { data: Buffer.from(encodeCell(c)) },
    address: probe.mapCellAddress(AGENT, STRUCT, c.keySlot).toBytes(),
  });
  const headerItem = (h: StructHeader, leafIndex: number, tree = PROGRAM_ID) => ({
    data: { data: Buffer.from(encodeHeader(h)) },
    address: probe.headerAddress(AGENT, STRUCT).toBytes(),
    treeInfo: { tree },
    leafIndex,
  });

  it("listCells holds a repeated cell once and stops on an unchanged cursor", async () => {
    let calls = 0;
    const a = mapCell(1, 0n, 1n);
    const b = mapCell(2, 0n, 2n);
    const client = cellClient(() => {
      if (++calls > 10) throw new Error("paged past an unchanged cursor");
      return { items: calls === 1 ? [cellItem(a)] : [cellItem(a), cellItem(b)], cursor: "stuck" };
    });
    const cells = await client.listCells(AGENT, STRUCT);
    assert.deepEqual(
      cells.map((c) => c.opSeq.toString()),
      ["1", "2"]
    );
    assert.equal(calls, 2);
  });

  it("ends a walk whose cursor cycles A → B → A", async () => {
    let calls = 0;
    const order = ["A", "B", "A", "B"];
    const client = cellClient(() => {
      if (++calls > 10) throw new Error("paged round a cursor cycle");
      return { items: [], cursor: order[calls - 1] };
    });
    await client.listCells(AGENT, STRUCT);
    assert.equal(calls, 3, "pages at undefined, A and B; the A that comes back again ends it");
    calls = 0;
    await client.listEvents(AGENT);
    assert.equal(calls, 3);
  });

  it("keeps the later version of a cell a replace_cell rewrote between two pages", async () => {
    const v0 = mapCell(1, 0n, 1n);
    const v1 = mapCell(1, 1n, 4n);
    for (const pages of [
      [[cellItem(v0)], [cellItem(v1)]],
      [[cellItem(v1)], [cellItem(v0)]],
    ]) {
      const walk = (cursor: string | undefined) =>
        cursor === undefined ? { items: pages[0], cursor: "p2" } : { items: pages[1], cursor: null };
      const listed = await cellClient(walk).listCells(AGENT, STRUCT);
      assert.deepEqual(
        listed.map((c) => [c.indexOrVersion, c.opSeq]),
        [[1n, 4n]]
      );
      const owned = await cellClient(walk).listOwnerCells(AGENT, [mapHeader(1n)]);
      assert.deepEqual(
        owned.map((c) => [c.indexOrVersion, c.opSeq]),
        [[1n, 4n]]
      );
    }
  });

  it("keeps the later version of a header, by count and then by leaf in the same tree", async () => {
    const run = async (first: unknown, second: unknown) =>
      cellClient((cursor) =>
        cursor === undefined ? { items: [first], cursor: "p2" } : { items: [second], cursor: null }
      )
        .listStructs(AGENT)
        .then((hs) => hs.map((h) => [h.lenOrCount, h.appendPolicy]));

    // A create_cell between the pages: the higher count is the later header, whichever page it is on.
    assert.deepEqual(await run(headerItem(mapHeader(3n), 9), headerItem(mapHeader(1n), 4)), [[3n, 0]]);
    assert.deepEqual(await run(headerItem(mapHeader(1n), 4), headerItem(mapHeader(3n), 9)), [[3n, 0]]);
    // A set_append_policy between the pages: same count, the higher leaf in the same tree.
    assert.deepEqual(await run(headerItem(mapHeader(1n, 0), 4), headerItem(mapHeader(1n, 1), 7)), [[1n, 1]]);
    assert.deepEqual(await run(headerItem(mapHeader(1n, 1), 7), headerItem(mapHeader(1n, 0), 4)), [[1n, 1]]);
    // Nothing returned carries the paging bookkeeping.
    const [h] = await cellClient(() => ({ items: [headerItem(mapHeader(1n), 4)], cursor: null })).listStructs(AGENT);
    assert.notProperty(h, "leaf");
  });
});

// ─── An anchor whose cell write failed ──────────────────────────────────────

function memoryBackend(): LocatorBackend & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    scheme: LocatorScheme.Raw,
    blobs,
    async upload(bytes: Uint8Array) {
      const id = sha256(bytes);
      blobs.set(hex(id), bytes);
      return id;
    },
    async download(id: Uint8Array) {
      return blobs.get(hex(id)) ?? null;
    },
  } as any;
}

/** A registry over a map whose `publish` throws while `failing` is set. */
function flakyRegistry() {
  const cells = new Map<string, Locator>();
  const state = { failing: true, publishes: 0 };
  const registry = Object.create(LocatorRegistry.prototype) as LocatorRegistry;
  Object.assign(registry as unknown as Record<string, unknown>, {
    ensureCreated: async () => true,
    has: async (hash: Bytes32) => cells.has(hex(hash)),
    resolve: async (hash: Bytes32) => {
      const locator = cells.get(hex(hash));
      return locator ? { hash, locator, version: 0n, publishedAt: 0n, cell: null } : null;
    },
    publish: async (hash: Bytes32, locator: Locator) => {
      state.publishes++;
      if (state.failing) throw new Error("429 Too Many Requests");
      cells.set(hex(hash), locator);
    },
    repoint: async (hash: Bytes32, locator: Locator) => {
      cells.set(hex(hash), locator);
    },
  });
  return { registry, cells, state };
}

describe("an epoch whose locator cell did not land", () => {
  const root = sha256(new Uint8Array([7]));
  const blob = new Uint8Array([1, 2, 3, 4]);

  it("keeps its locator for a retry in the same process", async () => {
    const backend = memoryBackend();
    const { registry, cells, state } = flakyRegistry();
    const store = new AnchoredEpochStore(backend, registry, { fallback: new MemoryEpochStore(), manifests: registry });
    await store.put(root, blob);
    let threw = false;
    try {
      await store.anchor(root);
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /429/);
    }
    assert.isTrue(threw);
    // Still readable from this process meanwhile.
    assert.deepEqual(await store.get(root), blob);

    state.failing = false;
    assert.deepEqual(await store.anchor(root), { published: true });
    assert.isTrue(cells.has(hex(root)));
    assert.equal(state.publishes, 2);
  });

  it("leaves its bytes in the fallback, where reanchorEpochs finds and publishes them", async () => {
    const backend = memoryBackend();
    const { registry, cells } = flakyRegistry();
    const fallback = new MemoryEpochStore();
    const store = new AnchoredEpochStore(backend, registry, { fallback, manifests: registry });
    await store.put(root, blob);
    await store.anchor(root).catch(() => undefined);
    assert.deepEqual(await fallback.get(root), blob, "copied into the fallback once the cell write failed");

    // A later process: the in-memory locator is gone, only the fallback and the chain remain.
    const { registry: fresh, cells: freshCells, state: freshState } = flakyRegistry();
    freshState.failing = false;
    const client = Object.create(LathClient.prototype) as LathClient;
    const result = await reanchorEpochs({
      client,
      registry: fresh,
      backend,
      fallback,
      agentId: AGENT,
      roots: [root],
    });
    assert.deepEqual(result.reanchored, [hex(root)]);
    assert.isTrue(freshCells.has(hex(root)));
    assert.equal(cells.size, 0);
  });

  it("fills the fallback from the bytes put held, when the backend cannot serve them back yet", async () => {
    // An Irys gateway can answer 404 for a transaction seconds old: this backend never serves.
    const backend = memoryBackend();
    let downloads = 0;
    backend.download = async () => {
      downloads++;
      throw new Error("404 Not Found");
    };
    const { registry, state } = flakyRegistry();
    const fallback = new MemoryEpochStore();
    const store = new AnchoredEpochStore(backend, registry, { fallback, manifests: registry });
    await store.put(root, blob);
    await store.anchor(root).catch(() => undefined);
    assert.deepEqual(await fallback.get(root), blob);
    assert.equal(downloads, 0, "the bytes were in hand, so nothing was read back");

    // A second failed attempt finds them already kept and writes nothing more.
    await store.anchor(root).catch(() => undefined);
    assert.equal(state.publishes, 2);
    assert.equal(downloads, 0);
  });
});
