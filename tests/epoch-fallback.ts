import { assert } from "chai";
import {
  createEpochMerkleTree,
  encodeEpochBlob,
  epochLeaves,
  EventInput,
  EventKind,
  EventPayload,
  hex,
  type UploadRetryPolicy,
  idFromString,
  LathClient,
  MemoryEpochStore,
  sha256,
  toEventInput,
  type Bytes32,
  type EpochStore,
} from "../sdk/src";

/**
 * No validator: the client is a prototype with `getAgentState` and `commitEpoch` stubbed, so
 * `createEpochCommitter` runs its own logic against stores that fail on purpose. What is under
 * test is what a blob backend's failure costs — the locator and nothing else — and how many
 * attempts it takes to decide that.
 *
 * Every store here passes `sleep` in its retry policy, so the suite runs in milliseconds and the
 * waits it would have taken are recorded instead of taken.
 */

const AGENT = idFromString("epoch-fallback");

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

/** A client that answers `seq: 0` and signs nothing — everything else is the real committer. */
function stubClient(): { client: LathClient; commits: number[] } {
  const commits: number[] = [];
  const client = Object.create(LathClient.prototype) as LathClient;
  Object.assign(client as unknown as Record<string, unknown>, {
    getAgentState: async () => ({ account: null, state: { seq: 0n } }),
    commitEpoch: async () => {
      commits.push(1);
      return { signature: `sig-${commits.length}`, head: new Uint8Array(32).fill(7) };
    },
  });
  return { client, commits };
}

/** The waits a store's retry policy asked for, so a case can assert the backoff without taking it. */
type Waits = number[];

/**
 * An `EpochStore` whose `put` fails `failures` times before it works. `error` is what it throws:
 * the default is the unfunded-uploader message, which is final, so a case that wants a retry
 * passes a transient one.
 */
function failingStore(
  opts: {
    fallback?: EpochStore;
    failures?: number;
    error?: () => unknown;
    retry?: UploadRetryPolicy;
    waits?: Waits;
  } = {}
): EpochStore & { fallback?: EpochStore; retry?: UploadRetryPolicy; anchors: number; puts: number } {
  const kept = new MemoryEpochStore();
  const limit = opts.failures ?? 1;
  let failures = 0;
  return {
    fallback: opts.fallback,
    retry: {
      ...opts.retry,
      sleep: async (ms: number) => {
        opts.waits?.push(ms);
      },
    },
    anchors: 0,
    puts: 0,
    async put(this: { puts: number }, root: Bytes32, blob: Uint8Array) {
      this.puts++;
      if (failures++ < limit) throw (opts.error ?? (() => new Error("no balance at Irys devnet")))();
      await kept.put(root, blob);
    },
    async get(root: Bytes32) {
      return kept.get(root);
    },
    async anchor(this: { anchors: number }, _root: Bytes32) {
      this.anchors++;
      return { published: true };
    },
  };
}

describe("an epoch whose blob cannot be uploaded", () => {
  it("commits anyway, reports the upload error, and keeps the bytes in the fallback", async () => {
    const { client, commits } = stubClient();
    const fallback = new MemoryEpochStore();
    const store = failingStore({ fallback });
    const steps = inputs(3);

    const commit = await client.createEpochCommitter(AGENT, store)(steps);

    assert.equal(commits.length, 1, "the epoch is on chain");
    assert.isFalse(commit.anchored, "a blob that is not on the backend is not anchored");
    assert.isFalse(commit.anchorPending, "nothing is queued for a manifest either");
    assert.include(commit.anchorError ?? "", "no balance at Irys devnet");
    assert.equal(store.anchors, 0, "there is no uploaded id to point a locator cell at");
    assert.equal(commit.anchorAttempts, 1, "an unfunded uploader is not worth a second attempt");

    // The bytes are recoverable by the root the chain committed, which is the whole point of
    // falling back rather than throwing.
    const blob = await fallback.get(commit.epochRoot);
    assert.isNotNull(blob);
    const expected = encodeEpochBlob(0n, steps);
    assert.equal(hex(sha256(blob!)), hex(sha256(expected)));
    assert.equal(hex(createEpochMerkleTree(epochLeaves(0n, steps)).root), hex(commit.epochRoot));
  });

  it("still reports a locator cell that fails after a good upload", async () => {
    const { client } = stubClient();
    const store = failingStore({});
    await store.put(new Uint8Array(32), new Uint8Array(0)).catch(() => undefined); // spend the one failure
    const throwing: EpochStore = {
      put: store.put.bind(store),
      get: store.get.bind(store),
      anchor: async () => {
        throw new Error("locator cell rejected");
      },
    };

    const commit = await client.createEpochCommitter(AGENT, throwing)(inputs(2));

    assert.isFalse(commit.anchored);
    assert.equal(commit.anchorError, "locator cell rejected");
    assert.isNotNull(await throwing.get(commit.epochRoot), "the blob is on the backend regardless");
  });
});

describe("an upload that is retried before it falls back", () => {
  it("anchors an epoch whose upload failed twice with a transient error", async () => {
    const { client, commits } = stubClient();
    const fallback = new MemoryEpochStore();
    const waits: Waits = [];
    const store = failingStore({
      fallback,
      failures: 2,
      error: () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      waits,
    });

    const commit = await client.createEpochCommitter(AGENT, store)(inputs(2));

    assert.equal(commits.length, 1);
    assert.isTrue(commit.anchored, "the third attempt put the blob on the backend");
    assert.isUndefined(commit.anchorError);
    assert.equal(commit.anchorAttempts, 3, "two failures and the try that worked");
    assert.deepEqual(waits, [1000, 2000], "the default backoff doubles");
    assert.isNull(await fallback.get(commit.epochRoot), "nothing fell back");
    assert.equal(store.anchors, 1, "the locator cell is written, because there is an id for it");
  });

  it("falls back at once on an error another attempt cannot fix", async () => {
    const { client } = stubClient();
    const fallback = new MemoryEpochStore();
    const waits: Waits = [];
    const store = failingStore({
      fallback,
      failures: 99,
      error: () => Object.assign(new Error("Not enough balance for transaction"), { status: 402 }),
      waits,
    });

    const commit = await client.createEpochCommitter(AGENT, store)(inputs(1));

    assert.isFalse(commit.anchored);
    assert.equal(commit.anchorAttempts, 1, "a 4xx says the same thing however often it is asked");
    assert.deepEqual(waits, [], "and costs the session no wait at all");
    assert.include(commit.anchorError ?? "", "Not enough balance");
    assert.isNotNull(await fallback.get(commit.epochRoot));
  });

  it("falls back after the last attempt, carrying the last error", async () => {
    const { client } = stubClient();
    const fallback = new MemoryEpochStore();
    const waits: Waits = [];
    let n = 0;
    const store = failingStore({
      fallback,
      failures: 99,
      error: () => Object.assign(new Error(`gateway timeout ${++n}`), { status: 504 }),
      waits,
    });

    const commit = await client.createEpochCommitter(AGENT, store)(inputs(4));

    assert.equal(store.puts, 3, "three attempts by default");
    assert.equal(commit.anchorAttempts, 3);
    assert.equal(commit.anchorError, "gateway timeout 3", "the error reported is the last one");
    assert.isFalse(commit.anchored);
    assert.deepEqual(waits, [1000, 2000]);
    assert.isNotNull(await fallback.get(commit.epochRoot), "the bytes are recoverable by root");
  });

  it("stops waiting at the cap however many attempts are left", async () => {
    const { client } = stubClient();
    const fallback = new MemoryEpochStore();
    const waits: Waits = [];
    const store = failingStore({
      fallback,
      failures: 99,
      error: () => Object.assign(new Error("bad gateway"), { status: 502 }),
      // A policy that would wait 4 s + 8 s + 16 s + … if the cap did not exist. A session may
      // never be held that long by one epoch.
      retry: { attempts: 10, backoffMs: 4000 },
      waits,
    });

    const commit = await client.createEpochCommitter(AGENT, store)(inputs(1));

    assert.equal(
      waits.reduce((a, b) => a + b, 0),
      10_000,
      "the total wait is the ten-second cap"
    );
    assert.deepEqual(waits, [4000, 6000], "the second wait is trimmed to what is left of it");
    assert.equal(commit.anchorAttempts, 3, "the cap ends the retry, not the attempt count");
    assert.isFalse(commit.anchored);
    assert.isNotNull(await fallback.get(commit.epochRoot));
  });
});
