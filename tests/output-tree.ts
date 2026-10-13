import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TreeInfo, TreeType } from "@lightprotocol/stateless.js";
import { selectOutputTree } from "../sdk/src";

/**
 * `selectOutputTree` is the whole of the client's output-tree choice, and it is a pure function
 * over tree pubkeys — so it is checked here rather than against a validator. What it has to get
 * right is that a write which spends a header puts its outputs back in that header's tree, so an
 * agent's accounts stay together instead of scattering across the five trees devnet runs.
 */
function treeInfo(label: string, next?: TreeInfo): TreeInfo {
  const info: TreeInfo = {
    tree: Keypair.generate().publicKey,
    queue: Keypair.generate().publicKey,
    treeType: TreeType.StateV2,
    // `null` and not `undefined`: the RPC sets this field on every tree it returns and leaves it
    // null for a tree still accepting leaves, so the fixture has to have the same shape.
    nextTreeInfo: next ?? null,
  };
  // The label is only here so an assertion failure names the tree a reader recognises.
  (info as unknown as { label: string }).label = label;
  return info;
}

function same(a: TreeInfo, b: TreeInfo): boolean {
  return a.tree.equals(b.tree) && a.queue.equals(b.queue);
}

describe("output state tree selection", () => {
  const discovered = treeInfo("discovered");
  const ownerTree = treeInfo("owner");
  const headerTree = treeInfo("header");

  it("uses the discovered tree only when the write spends nothing", () => {
    assert.isTrue(same(selectOutputTree([], discovered), discovered));
  });

  it("pins a one-input write to the tree its input is spent from", () => {
    const chosen = selectOutputTree([ownerTree], discovered);
    assert.isTrue(same(chosen, ownerTree), "a write that spends the agent header outputs into its tree");
    assert.isFalse(same(chosen, discovered), "the randomly discovered tree is not used when an input pins one");
  });

  it("routes a two-input write to the first input's tree, which is the owner header's", () => {
    const chosen = selectOutputTree([ownerTree, headerTree], discovered);
    assert.isTrue(same(chosen, ownerTree));
  });

  it("keeps both inputs' tree when they already agree", () => {
    const chosen = selectOutputTree([ownerTree, ownerTree], discovered);
    assert.isTrue(same(chosen, ownerTree));
  });

  it("follows a rolled-over tree to its successor, which is where leaves still fit", () => {
    const successor = treeInfo("successor");
    const rolled = treeInfo("rolled", successor);
    assert.isTrue(same(selectOutputTree([rolled], discovered), successor));
    assert.isTrue(same(selectOutputTree([], rolled), successor), "the fallback rolls over too");
  });

  it("returns a queue the caller can pack, not a bare tree pubkey", () => {
    const chosen = selectOutputTree([ownerTree], discovered);
    assert.instanceOf(chosen.queue, PublicKey);
    assert.isFalse(chosen.queue.equals(chosen.tree), "the queue is the account a write inserts into");
  });
});

/**
 * A cell write spends two accounts, and the program hands them to the Light system program
 * in `with_light_account` order — the header (or the cell) first, the agent's state second
 * (`programs/lath/src/lib.rs`). Leaves proven by root are folded into the proof's public input in
 * that order, so a proof requested the other way round verifies only while one of the two is still
 * in the output queue; once both are in the tree every write fails with 0x179b, so an agent idle
 * for half an hour would be unwritable. Each builder is stopped at the instruction, after
 * it has asked for the proof and indexed the metas, with the client's reads stubbed out.
 */
describe("two-input cell proofs follow the program's input order", () => {
  const OWNER_HASH = "owner-state";
  const OTHER_HASH = "header-or-cell";

  function stubbed(method: "createCell" | "replaceCell" | "closeCell") {
    const asked: string[][] = [];
    const metas: [string, number][] = [];
    const rpc = {
      commitment: "confirmed",
      getValidityProofV0: async (hashes: { hash: string }[]) => {
        asked.push(hashes.map((h) => h.hash));
        return { compressedProof: null, rootIndices: [0, 0, 0], leafIndices: [0, 0], proveByIndices: [false, false] };
      },
    } as any;
    const { LathClient } = require("../sdk/src/client");
    const client = LathClient.fromIdl(rpc, Keypair.generate(), { retryDelayMs: 1, maxRetries: 0 });
    const tree = treeInfo("state");
    const account = (hash: string) => ({ hash, treeInfo: tree });
    const state = { seq: 5n, head: new Uint8Array(32), authority: client.authority.publicKey };
    const c = client as any;
    c.getAgentState = async () => ({ account: account(OWNER_HASH), state });
    c.ownedState = async () => ({ account: account(OWNER_HASH), state });
    c.priorLanded = async () => undefined;
    c.getHeader = async () => ({
      account: account(OTHER_HASH),
      header: { kind: 1, lenOrCount: 0n, consumable: false },
    });
    c.getCellAt = async () => ({
      account: account(OTHER_HASH),
      cell: { indexOrVersion: 0n, keySlot: new Uint8Array(32) },
    });
    c.outputTreeFor = async () => tree;
    // The instruction's argument shapers read fields this stub state does not carry, and they are
    // not what is under test.
    for (const shaper of ["agentStateArg", "headerArg", "cellArg", "cellInputArg"]) c[shaper] = () => ({});
    // Addresses are derived against an address tree this RPC-less client never looked up.
    c.addressTree = Keypair.generate().publicKey;
    c.logCellAddress = c.mapCellAddress = () => Keypair.generate().publicKey;
    c.metaFor = (acc: { hash: string }, _proof: unknown, index: number) => {
      metas.push([acc.hash, index]);
      return {};
    };
    c.program = {
      programId: c.program.programId,
      methods: new Proxy(
        {},
        {
          get: (_t, name) => () => {
            throw new Error(`STOP:${String(name)}`);
          },
        }
      ),
    };
    return { client, asked, metas, method };
  }

  for (const method of ["createCell", "replaceCell", "closeCell"] as const) {
    it(`${method} asks for the ${
      method === "createCell" ? "header" : "cell"
    }'s leaf first and indexes the metas to match`, async () => {
      const { client, asked, metas } = stubbed(method);
      const owner = new Uint8Array(32).fill(1);
      const structId = new Uint8Array(32).fill(2);
      const call =
        method === "createCell"
          ? client.createCell(owner, structId, {})
          : method === "replaceCell"
          ? client.replaceCell(owner, structId, new Uint8Array(32), {})
          : client.closeCell(owner, structId, { keySlot: new Uint8Array(32) });
      const error = await call.then(
        () => null,
        (e: Error) => e
      );
      assert.match(String(error?.message), new RegExp(`STOP:${method}`), "stopped at the instruction, not before it");
      assert.deepEqual(asked, [[OTHER_HASH, OWNER_HASH]], "the proof's leaves in the program's order");
      assert.sameDeepMembers(
        metas,
        [
          [OTHER_HASH, 0],
          [OWNER_HASH, 1],
        ],
        "and each meta reads the root index at its own position"
      );
    });
  }
});
