/**
 * The cell hash-chain vector, pinned against `next_cell_head` in `programs/lath/src/lib.rs`.
 */
import { assert } from "chai";
import { createRpc } from "@lightprotocol/stateless.js";
import { Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AppendPolicy,
  CellOp,
  computeCellHead,
  computeStructHead,
  hex,
  idFromString,
  LathClient,
  LathLog,
  MemoryTraceStore,
  valueSlot,
} from "../sdk/src";

/**
 * Pinned against `next_cell_head` in `programs/lath/src/lib.rs` — the two must stay
 * byte-identical. Needs no chain, so CI runs it in the node-only job; keep it a
 * top-level suite (no `before`) so `-g` can select it in isolation.
 */
describe("cell hash chain vector", () => {
  it("matches the Rust cell-head vector", () => {
    const head = computeCellHead(new Uint8Array(32).fill(7), CellOp.Create, {
      ownerId: new Uint8Array(32).fill(1),
      structId: new Uint8Array(32).fill(2),
      indexOrVersion: 3n,
      opSeq: 9n,
      timestamp: 1_700_000_000_000n,
      tag: 4,
      status: 200,
      keySlot: new Uint8Array(32).fill(5),
      valueSlot: new Uint8Array(32).fill(6),
      head: new Uint8Array(32),
    });
    assert.equal(hex(head), "1d23332128dcd07a83b9ae64738987f1dfa93568bfc30718350e4ae0bb8cb014");
  });
});

/**
 * `set_append_policy` against a live cluster: a header
 * created `Anyone` admits a stranger's append, the owner takes it to `OwnerOnly` in place, and the
 * same stranger is refused while the owner still appends. Skipped unless `LATH_DEVNET_RPC` is set,
 * like `tests/devnet.ts`, and it writes to that cluster — a fresh agent, three cells and the
 * rewrite — paid by the wallet at `ANCHOR_WALLET`, which also lends the stranger its fees.
 *
 * It passes only against a `lath` deploy that carries the instruction: on a deploy without it
 * (program-data slot `502657763`) the call fails before the program runs, with Anchor's
 * `InstructionFallbackNotFound` (0x65). docs/ARCHITECTURE.md §12 logs the deployed slots.
 */
describe("set_append_policy on a live cluster", function () {
  this.timeout(300_000);

  const RPC = process.env.LATH_DEVNET_RPC;
  const PHOTON = process.env.LATH_DEVNET_PHOTON ?? RPC;
  const PROVER = process.env.LATH_DEVNET_PROVER ?? RPC;
  const walletPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");

  let payer: Keypair;
  let client: LathClient;

  const errorName = (e: any): string => {
    const text = [e?.message, JSON.stringify(e?.logs ?? []), String(e)].join(" ");
    return text.match(/Error Code: (\w+)/)?.[1] ?? text;
  };

  before(function () {
    if (!RPC) this.skip();
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
    client = LathClient.fromIdl(createRpc(RPC, PHOTON, PROVER, { commitment: "confirmed" }), payer);
  });

  it("takes a legacy Anyone header to OwnerOnly in place, and the stranger it admitted is refused", async () => {
    const ownerId = idFromString(`p1-set-policy-${process.pid}-${Date.now()}`);
    await client.registerAgent(ownerId);

    // The shape of an older `runtime-inbox`: a consumable Log anyone may append to.
    const structId = LathLog.id("p1-inbox");
    const inbox = new LathLog(client, ownerId, structId, {
      consumable: true,
      appendPolicy: AppendPolicy.Anyone,
      store: new MemoryTraceStore(),
    });
    assert.isTrue(await inbox.ensureCreated());

    // A stranger with nothing but fees. Under `Anyone` the program runs no authority check, so
    // the append lands and spends the owner's seq — the exposure `set_append_policy` closes.
    const stranger = Keypair.generate();
    await sendAndConfirmTransaction(
      client.rpc,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: stranger.publicKey,
          lamports: LAMPORTS_PER_SOL / 50,
        })
      ),
      [payer],
      { commitment: "confirmed" }
    );
    const other = LathClient.fromIdl(client.rpc, stranger);
    const intrusion = await other.createCell(ownerId, structId, { valueSlot: valueSlot("stranger") });
    assert.equal(intrusion.cell.indexOrVersion, 0n);

    const before = (await client.getAgentState(ownerId))!.state;
    const created = (await client.getHeader(ownerId, structId))!.header;
    assert.equal(created.appendPolicy, AppendPolicy.Anyone);
    assert.equal(created.lenOrCount, 1n);

    // A key that is not the owner cannot even build the rewrite: the SDK's ownership guard
    // refuses before a transaction exists, and the program's `require_keys_eq!` sits behind it.
    let refused: unknown;
    try {
      await other.setAppendPolicy(ownerId, structId, AppendPolicy.OwnerOnly);
    } catch (e) {
      refused = e;
    }
    assert.match(errorName(refused), /does not own this agent|Unauthorized/);

    const res = await inbox.setAppendPolicy(AppendPolicy.OwnerOnly);
    assert.equal(res.opSeq, before.seq);
    assert.equal(hex(res.head), hex(computeStructHead(before.head, res.header, before.seq, CellOp.SetAppendPolicy)));

    // Rewritten in place: the same address, the same length, creation seq and shape; only the
    // policy moved. The owner's chain advanced by exactly the one fold the SDK predicted.
    const found = (await client.getHeader(ownerId, structId))!;
    assert.equal(found.header.address!.toBase58(), res.address.toBase58());
    assert.equal(found.header.address!.toBase58(), created.address!.toBase58());
    assert.equal(found.header.appendPolicy, AppendPolicy.OwnerOnly);
    assert.equal(hex(found.header.policyRef), hex(created.policyRef), "policyRef is kept when none is given");
    assert.equal(found.header.lenOrCount, 1n);
    assert.equal(found.header.createdOpSeq, created.createdOpSeq);
    assert.equal(found.header.kind, created.kind);
    assert.equal(found.header.mode, created.mode);
    assert.equal(found.header.consumable, created.consumable);
    const after = (await client.getAgentState(ownerId))!.state;
    assert.equal(after.seq, before.seq + 1n);
    assert.equal(hex(after.head), hex(res.head));

    // The same stranger, the same call: refused by the program now, and the chain does not move.
    let failed: unknown;
    try {
      await other.createCell(ownerId, structId, { valueSlot: valueSlot("stranger again") });
    } catch (e) {
      failed = e;
    }
    assert.isDefined(failed, "an append by a non-owner must fail under OwnerOnly");
    assert.match(errorName(failed), /Unauthorized/);
    const still = (await client.getAgentState(ownerId))!.state;
    assert.equal(still.seq, after.seq, "the refused append spent no seq");
    assert.equal(hex(still.head), hex(after.head));

    // The owner still appends, at the index the stranger's cell left it.
    const own = await inbox.append("owner, after the rewrite");
    assert.equal(own.index, 1n);
    assert.equal((await client.getHeader(ownerId, structId))!.header.lenOrCount, 2n);

    // An AllowList needs its root; the SDK says so before anything is sent.
    let noRoot: unknown;
    try {
      await inbox.setAppendPolicy(AppendPolicy.AllowList);
    } catch (e) {
      noRoot = e;
    }
    assert.match(String((noRoot as Error)?.message), /policyRef/);
  });
});
