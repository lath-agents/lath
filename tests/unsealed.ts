import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

import { FileTraceStore, Locator, LocatorBackend, LocatorScheme, decodeBundle, hex, sha256 } from "@lath/sdk";

import { deferSeal, sealDeferred, unsealedSessions } from "../frontend/src/app/api/_lib/unsealed";

/**
 * The seal a failed session leaves owed.
 *
 * `/api/run` and a loop step both skip the seal when the drain fails — a locator cell written
 * while records are journaled takes the seq one of them is holding — and neither leaves it
 * skipped for good. What they leave is a note, and what pays it is any later write that
 * lands those records. These cases are the note and the paying, without a chain: the registry is
 * a fake, because what is under test is the bookkeeping, not the cell.
 */

const GENESIS = sha256(Buffer.from("a genesis payload"));

/** Enough of a `LocatorRegistry` for the seal: a map with the three calls `sealBundle` makes. */
class FakeRegistry {
  readonly published = new Map<string, Locator>();
  created = 0;

  async ensureCreated(): Promise<void> {
    this.created++;
  }
  async resolve(key: Uint8Array): Promise<{ locator: Locator } | null> {
    const found = this.published.get(hex(key));
    return found ? { locator: found } : null;
  }
  async publish(key: Uint8Array, locator: Locator): Promise<void> {
    this.published.set(hex(key), locator);
  }
}

/** A backend that keeps what it is given, so the bundle can be decoded back. */
class FakeBackend implements LocatorBackend {
  readonly scheme = LocatorScheme.Raw;
  readonly uploaded: Uint8Array[] = [];

  async upload(bytes: Uint8Array): Promise<Uint8Array> {
    this.uploaded.push(bytes.slice());
    return sha256(bytes);
  }
  async download(id: Uint8Array): Promise<Uint8Array | null> {
    const found = this.uploaded.find((b) => hex(sha256(b)) === hex(id));
    return found ?? null;
  }
}

function anchorFor(store: FileTraceStore) {
  const backend = new FakeBackend();
  const registry = new FakeRegistry();
  return { backend, registry: registry as any, store, fake: { backend, registry } };
}

describe("the seal a failed session leaves owed", () => {
  const store = new FileTraceStore(traceDir);
  const agent = hex(sha256(Buffer.from("unsealed-agent")));

  async function put(...bodies: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const b of bodies) out.push(hex(await store.put(Buffer.from(b))));
    return out;
  }

  afterEach(() => {
    fs.rmSync(path.join(traceDir, "unsealed"), { recursive: true, force: true });
  });

  it("keeps the key and the hashes, not the bytes: the trace store already has those", async () => {
    const hashes = await put("one", "two", "three");
    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 1 });

    const owed = await unsealedSessions(agent);
    assert.lengthOf(owed, 1);
    assert.deepEqual(owed[0].hashes, hashes);
    assert.equal(owed[0].genesisPayloadHash, hex(GENESIS));
  });

  it("pays it from the store, and forgets it", async () => {
    const hashes = await put("one", "two", "three");
    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 1 });

    const a = anchorFor(store);
    const done = await sealDeferred(agent, a);

    assert.lengthOf(done, 1);
    assert.isUndefined(done[0].result.error, done[0].result.error);
    assert.equal(done[0].result.count, 3);
    assert.lengthOf(await unsealedSessions(agent), 0, "a seal that landed is not owed twice");

    // The bundle holds the session's bytes, in the order they were put.
    const entries = decodeBundle(a.fake.backend.uploaded[0]);
    assert.deepEqual(
      entries.map((e) => Buffer.from(e).toString()),
      ["one", "two", "three"]
    );
  });

  it("does not publish a partial bundle, and keeps owing it", async () => {
    const hashes = await put("one", "two");
    // A hash of bytes nobody stored: a reader who found a cell for this session would stop
    // looking, and the missing entry would read `unavailable` with nothing to say where it is.
    hashes.push(hex(sha256(Buffer.from("never stored"))));
    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 1 });

    const a = anchorFor(store);
    const done = await sealDeferred(agent, a);

    assert.match(done[0].result.error ?? "", /1 of this session's 3 blobs are missing/);
    assert.lengthOf(a.fake.backend.uploaded, 0, "nothing was uploaded");
    assert.lengthOf(await unsealedSessions(agent), 1, "still owed, so a later retry can try again");
  });

  it("drops a note whose blobs are all gone rather than owing it for ever", async () => {
    const hashes = [hex(sha256(Buffer.from("gone a"))), hex(sha256(Buffer.from("gone b")))];
    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 1 });

    const done = await sealDeferred(agent, anchorFor(store));
    assert.match(done[0].result.error ?? "", /none of this session's blobs/);
    assert.lengthOf(await unsealedSessions(agent), 0);
  });

  it("is one note per session, however often the same one is deferred", async () => {
    const hashes = await put("one");
    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 1 });
    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 2 });

    const owed = await unsealedSessions(agent);
    assert.lengthOf(owed, 1, "the bundle is keyed by the genesis, so only one of them can land");
    assert.equal(owed[0].at, 2);
  });

  it("leaves a note file it cannot read alone rather than writing one note over it", async () => {
    const file = path.join(traceDir, "unsealed", `${agent}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const torn = '[{"genesisPayloadHash": "aa", "hashes": [';
    fs.writeFileSync(file, torn);
    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes: await put("one"), at: 1 });
    assert.equal(fs.readFileSync(file, "utf8"), torn, "the other notes are still there to be read later");
    await unsealedSessions(agent).then(
      () => assert.fail("an unreadable note is not a chain that owes nothing"),
      () => undefined
    );
  });

  it("keeps the locator a second seal finds already published", async () => {
    const hashes = await put("one", "two");
    const a = anchorFor(store);

    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 1 });
    const first = await sealDeferred(agent, a);

    await deferSeal(agent, { genesisPayloadHash: hex(GENESIS), hashes, at: 2 });
    const second = await sealDeferred(agent, a);

    assert.deepEqual(second[0].result.locator, first[0].result.locator);
    assert.lengthOf(a.fake.backend.uploaded, 1, "nothing is uploaded twice");
  });
});
