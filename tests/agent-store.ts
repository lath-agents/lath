import "./fixtures/trace-dir";
import { assert } from "chai";
import {
  Cell,
  STORE_ID,
  StoreWriter,
  checkStoreEntry,
  hex,
  idFromString,
  openStoreEntry,
  sha256,
  storeEntryBytes,
  storeKeySlot,
  storeWriteBinding,
  utf8,
} from "@lath/sdk";
import {
  OFFERED_TOOL_NAMES,
  OPT_IN_TOOL_NAMES,
  STORE_TOOL_NAMES,
  TOOL_NAMES,
} from "../frontend/src/app/api/_lib/tools";

/**
 * The agent store (`sdk/src/store.ts`) without a chain: what a cell commits to, what a reader
 * accepts back, and what an owner's signature binds. Node-only.
 */

/** The cell `AgentStore.set` would write for `key = value`. */
function cellFor(key: string, value: string, over: Partial<Cell> = {}): Cell {
  return {
    ownerId: idFromString("store-test-agent"),
    structId: STORE_ID,
    indexOrVersion: 2n,
    opSeq: 17n,
    timestamp: 1_700_000_000_000n,
    tag: StoreWriter.Owner,
    status: 0,
    keySlot: storeKeySlot(key),
    valueSlot: sha256(storeEntryBytes(key, value)),
    head: new Uint8Array(32),
    ...over,
  };
}

describe("agent store entries", () => {
  it("commits to canonical JSON of the key and the value, so the hash is reproducible", () => {
    assert.equal(new TextDecoder().decode(storeEntryBytes("mode", "watch")), '{"key":"mode","v":1,"value":"watch"}');
    assert.equal(hex(STORE_ID), hex(idFromString("store")));
  });

  it("opens an entry that re-hashes to its slot and names its own key", () => {
    const e = openStoreEntry(cellFor("threshold", "0.05"), storeEntryBytes("threshold", "0.05"));
    assert.equal(e.status, "ok");
    assert.equal(e.key, "threshold");
    assert.equal(e.value, "0.05");
    assert.equal(e.version, 2n);
    assert.equal(e.writer, StoreWriter.Owner);
  });

  it("reports a missing entry as missing, not as an empty value", () => {
    const e = openStoreEntry(cellFor("threshold", "0.05"), null);
    assert.equal(e.status, "missing");
    assert.isUndefined(e.value);
  });

  it("refuses bytes that do not hash to the slot", () => {
    const e = openStoreEntry(cellFor("threshold", "0.05"), storeEntryBytes("threshold", "0.50"));
    assert.equal(e.status, "mismatch");
    assert.isUndefined(e.value);
  });

  it("refuses an entry filed under another key's cell, even when its bytes match the slot", () => {
    // A value slot that commits to `other`'s entry, in the cell at `threshold`'s address: the bytes
    // re-hash, but the key inside them is not the one the cell is addressed by.
    const cell = cellFor("threshold", "0.05", { valueSlot: sha256(storeEntryBytes("other", "0.05")) });
    assert.equal(openStoreEntry(cell, storeEntryBytes("other", "0.05")).status, "mismatch");
  });

  it("refuses bytes that are not an entry at all", () => {
    const junk = utf8("not json");
    assert.equal(openStoreEntry(cellFor("k", "v", { valueSlot: sha256(junk) }), junk).status, "mismatch");
  });

  it("bounds keys and values", () => {
    assert.doesNotThrow(() => checkStoreEntry("a.b_c:d-1", ""));
    assert.throws(() => checkStoreEntry("", "v"), /store key/);
    assert.throws(() => checkStoreEntry("has space", "v"), /store key/);
    assert.throws(() => checkStoreEntry("x".repeat(65), "v"), /store key/);
    assert.doesNotThrow(() => checkStoreEntry("k", "x".repeat(1024)));
    assert.throws(() => checkStoreEntry("k", "x".repeat(1025)), /at most 1024 bytes/);
  });
});

describe("an owner's signed store write", () => {
  const agent = hex(idFromString("store-test-agent"));

  it("binds the key and the value, not only the agent", () => {
    const a = storeWriteBinding(agent, "mode", "watch");
    assert.equal(a.target, agent);
    assert.match(a.action, /^store\.set:[0-9a-f]{32}$/);
    assert.notEqual(storeWriteBinding(agent, "mode", "trade").action, a.action);
    assert.notEqual(storeWriteBinding(agent, "mood", "watch").action, a.action);
  });

  it("names the agent in lower case, as the route compares it", () => {
    assert.equal(storeWriteBinding(agent.toUpperCase(), "k", "v").target, agent);
  });

  it("throws on an entry the store would refuse, before anything is signed", () => {
    assert.throws(() => storeWriteBinding(agent, "bad key", "v"), /store key/);
  });
});

describe("the store tools in the catalogue", () => {
  it("are accepted and offered, and opt-in so a policy that names no tools keeps its hash", () => {
    for (const name of STORE_TOOL_NAMES) {
      assert.include(TOOL_NAMES, name);
      assert.include(OFFERED_TOOL_NAMES, name);
      assert.include(OPT_IN_TOOL_NAMES, name);
    }
  });
});
