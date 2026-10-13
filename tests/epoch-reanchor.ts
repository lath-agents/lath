import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  encodeEpochBlob,
  EventInput,
  EventKind,
  EventPayload,
  FileEpochStore,
  hex,
  idFromString,
  LathClient,
  Locator,
  LocatorBackend,
  LocatorRegistry,
  LocatorScheme,
  reanchorEpochs,
  sha256,
  toEventInput,
  type Bytes32,
} from "../sdk/src";

/**
 * No validator: `reanchorEpochs` is a walk over a store and a registry, so the client, the
 * registry and the upload backend are stubs and the fallback is a real `FileEpochStore` in a temp
 * directory — the same class the console hands its epoch stores, holding the same bytes a failed
 * upload would have left there.
 *
 * What is under test is the fallback's promise: a fallback is a delay, so an operator who runs
 * this after an outage ends with every epoch pointed at the backend the console now writes.
 */

const AGENT = idFromString("epoch-reanchor");

function action(i: number): EventPayload {
  return {
    kind: EventKind.Action,
    toolId: `tool-${i}`,
    argsHash: sha256(new Uint8Array([i, 1])),
    resultHash: sha256(new Uint8Array([i, 2])),
    statusCode: 200,
  };
}

function inputs(n: number): EventInput[] {
  return Array.from({ length: n }, (_, i) => toEventInput(action(i), 1_700_000_000_000 + i * 1000));
}

/** A client whose only job here is to answer "which epochs did this agent commit". */
function stubClient(roots: Bytes32[]): LathClient {
  const client = Object.create(LathClient.prototype) as LathClient;
  Object.assign(client as unknown as Record<string, unknown>, {
    listEpochs: async () => roots.map((epochRoot, i) => ({ epochRoot, startSeq: BigInt(i), endSeq: BigInt(i + 1) })),
  });
  return client;
}

/** A registry over a map, recording every write so a case can say which call was made. */
function stubRegistry(initial: Record<string, Locator> = {}) {
  const cells = new Map<string, Locator>(Object.entries(initial));
  const calls: { op: "publish" | "repoint" | "created"; hash?: string; locator?: Locator }[] = [];
  const registry = Object.create(LocatorRegistry.prototype) as LocatorRegistry;
  Object.assign(registry as unknown as Record<string, unknown>, {
    resolve: async (hash: Bytes32) => {
      const locator = cells.get(hex(hash));
      return locator ? { hash, locator, version: 0n, publishedAt: 0n, cell: null } : null;
    },
    ensureCreated: async () => {
      calls.push({ op: "created" });
      return true;
    },
    publish: async (hash: Bytes32, locator: Locator) => {
      calls.push({ op: "publish", hash: hex(hash), locator });
      cells.set(hex(hash), locator);
    },
    repoint: async (hash: Bytes32, locator: Locator) => {
      calls.push({ op: "repoint", hash: hex(hash), locator });
      cells.set(hex(hash), locator);
    },
  });
  return { registry, cells, calls };
}

/** An Irys-shaped backend: 32-byte ids, and a set of blobs it refuses to take. */
function stubBackend(reject: (bytes: Uint8Array) => string | null = () => null) {
  const uploaded: string[] = [];
  const backend: LocatorBackend = {
    scheme: LocatorScheme.Irys,
    async upload(bytes: Uint8Array) {
      const refusal = reject(bytes);
      if (refusal) throw new Error(refusal);
      uploaded.push(hex(sha256(bytes)));
      return sha256(bytes);
    },
    async download() {
      return null;
    },
  };
  return { backend, uploaded };
}

/** Two epoch blobs in a fresh trace directory, exactly as a failed upload would have left them. */
async function fallbackWithTwoEpochs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-reanchor-"));
  const store = new FileEpochStore(dir);
  const roots: Bytes32[] = [];
  for (const n of [2, 3]) {
    const blob = encodeEpochBlob(BigInt(n), inputs(n));
    const root = sha256(blob); // any 32 bytes will do: nothing here re-derives the tree
    await store.put(root, blob);
    roots.push(root);
  }
  return { dir, store, roots };
}

describe("re-anchoring epochs whose upload failed", () => {
  it("uploads both fallen-back blobs and repoints their cells at scheme 4", async () => {
    const { store, roots } = await fallbackWithTwoEpochs();
    // Both were anchored to the filesystem while the console ran in `fs` mode; it writes Irys now.
    const { registry, cells, calls } = stubRegistry({
      [hex(roots[0])]: { scheme: LocatorScheme.Raw, id: roots[0] },
      [hex(roots[1])]: { scheme: LocatorScheme.Raw, id: roots[1] },
    });
    const { backend, uploaded } = stubBackend();

    const result = await reanchorEpochs({
      client: stubClient(roots),
      registry,
      backend,
      fallback: store,
      agentId: AGENT,
    });

    assert.deepEqual(result.reanchored, roots.map(hex));
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.skipped, []);
    assert.lengthOf(uploaded, 2, "both blobs were uploaded");
    assert.deepEqual(
      calls.map((c) => c.op),
      ["repoint", "repoint"],
      "a cell that exists is repointed, never published a second time"
    );
    for (const root of roots) assert.equal(cells.get(hex(root))!.scheme, LocatorScheme.Irys);
  });

  it("keeps going past one upload that fails, and says which", async () => {
    const { store, roots } = await fallbackWithTwoEpochs();
    const second = (await store.get(roots[1]))!;
    const { registry, calls } = stubRegistry({
      [hex(roots[0])]: { scheme: LocatorScheme.Raw, id: roots[0] },
      [hex(roots[1])]: { scheme: LocatorScheme.Raw, id: roots[1] },
    });
    const { backend } = stubBackend((bytes) => (hex(bytes) === hex(second) ? "502 from the bundler" : null));

    const result = await reanchorEpochs({
      client: stubClient(roots),
      registry,
      backend,
      fallback: store,
      agentId: AGENT,
    });

    assert.deepEqual(result.reanchored, [hex(roots[0])], "the one that uploaded is anchored");
    assert.lengthOf(result.failed, 1);
    assert.equal(result.failed[0].root, hex(roots[1]));
    assert.include(result.failed[0].error, "502 from the bundler");
    assert.deepEqual(
      calls.map((c) => c.op),
      ["repoint"],
      "no cell is written for a blob that is not on the backend"
    );
  });

  it("skips what is already anchored on this backend, and what the fallback does not hold", async () => {
    const { store, roots } = await fallbackWithTwoEpochs();
    const missing = sha256(new Uint8Array([9, 9, 9]));
    const { registry, calls } = stubRegistry({
      [hex(roots[0])]: { scheme: LocatorScheme.Irys, id: roots[0] },
    });
    const { backend, uploaded } = stubBackend();

    const result = await reanchorEpochs({
      client: stubClient([roots[0], missing]),
      registry,
      backend,
      fallback: store,
      agentId: AGENT,
    });

    assert.deepEqual(result.skipped, [hex(roots[0]), hex(missing)]);
    assert.deepEqual(result.reanchored, []);
    assert.deepEqual(result.failed, []);
    assert.lengthOf(uploaded, 0, "nothing is paid for twice");
    assert.deepEqual(calls, [], "and no cell is touched");
  });

  it("publishes a first cell for a root the chain never pointed anywhere", async () => {
    const { store, roots } = await fallbackWithTwoEpochs();
    const { registry, calls, cells } = stubRegistry();
    const { backend } = stubBackend();

    const result = await reanchorEpochs({
      client: stubClient(roots),
      registry,
      backend,
      fallback: store,
      agentId: AGENT,
      roots: [roots[0]],
    });

    assert.deepEqual(result.reanchored, [hex(roots[0])]);
    assert.deepEqual(
      calls.map((c) => c.op),
      ["created", "publish"],
      "the registry structure is created before its first cell"
    );
    assert.equal(cells.get(hex(roots[0]))!.scheme, LocatorScheme.Irys);
  });

  // A file that is not there is the one thing `get` answers `null` for. A read that fails for any
  // other reason — here a directory where the blob should be, which `readFile` refuses with
  // EISDIR as it would refuse an unreadable file with EACCES — is not an epoch nobody kept.
  it("fails a root whose blob cannot be read, rather than skipping it as one the fallback never held", async () => {
    const { dir, store, roots } = await fallbackWithTwoEpochs();
    const missing = sha256(new Uint8Array([9, 9, 9]));
    assert.isNull(await store.get(missing), "a root with no file is absent");
    const unreadable = path.join(dir, `${hex(roots[1])}.epoch`);
    fs.rmSync(unreadable);
    fs.mkdirSync(unreadable);
    let thrown: any;
    await store.get(roots[1]).catch((e) => (thrown = e));
    assert.equal(thrown?.code, "EISDIR", "a read that failed throws its own error");

    const { registry } = stubRegistry();
    const { backend, uploaded } = stubBackend();
    const result = await reanchorEpochs({
      client: stubClient(roots),
      registry,
      backend,
      fallback: store,
      agentId: AGENT,
      roots: [roots[1]],
    });
    assert.deepEqual(result.skipped, []);
    assert.lengthOf(result.failed, 1);
    assert.equal(result.failed[0].root, hex(roots[1]));
    assert.lengthOf(uploaded, 0);
  });
});
