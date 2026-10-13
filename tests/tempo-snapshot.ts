/**
 * The paid RPC session a loop's own Tempo reads go through (docs/ARCHITECTURE.md §7.4), and the
 * snapshot each leaf's reads produce, carried by the next leaf that closes after it is ready.
 *
 * Node-only, network-free, key-free: the mppx session is a fake that answers JSON-RPC and counts its
 * vouchers, and the loop runs over the in-memory chain in `fixtures/fake-chain.ts`. No Tempo
 * transaction is made and no mainnet money can be spent from here.
 *
 * The last block is the console's side of the loop keys (docs/ARCHITECTURE.md §7.3): which account
 * the storage charge and the RPC session are built with. It builds clients and
 * never calls them, under a throwaway treasury key.
 */
// First, so `_lib/runner.ts` (loaded by `_lib/tempo.ts`) captures a throwaway trace directory.
import "./fixtures/trace-dir";
import { expect } from "chai";
import { privateKeyToAccount } from "viem/accounts";
import { TempoRpcReader, toBytes32 } from "../sdk/src";
import {
  LoopTempoServices,
  MppRpcSession,
  decodeTempoCarry,
  type MppSession,
  type RpcSessionLike,
  type TempoCarry,
} from "../runtime/src";
import { tempoLoop } from "./fixtures/tempo-loop";
import {
  accessKeyOf,
  treasuryChargeTransport,
  treasuryRpcSession,
  type TempoSigningAccount,
} from "../frontend/src/app/api/_lib/tempo";

const PAYER = "0x18fB0000000000000000000000000000000000B0";
const LOOP = "loop-snapshot-demo";
const MODEL_CHANNEL = "0x" + "7f".repeat(32);

/** A fake mppx session over JSON-RPC: one voucher of 1 000 base units a call, answers by method. */
function fakeSession(answers: Record<string, unknown>, o: { inFlight?: { now: number; max: number } } = {}) {
  let cumulative = BigInt(0);
  let opened = false;
  const methods: string[] = [];
  const session: MppSession & { methods: string[]; closes: number } = {
    methods,
    closes: 0,
    get cumulative() {
      return cumulative;
    },
    get channelId() {
      return opened ? "0xrpcchannel" : undefined;
    },
    get opened() {
      return opened;
    },
    async fetch(_url: string, init?: RequestInit) {
      const { method, id } = JSON.parse(String(init?.body));
      if (o.inFlight) {
        o.inFlight.now += 1;
        o.inFlight.max = Math.max(o.inFlight.max, o.inFlight.now);
      }
      await new Promise((r) => setTimeout(r, 2));
      if (o.inFlight) o.inFlight.now -= 1;
      opened = true;
      cumulative += BigInt(1_000);
      methods.push(method);
      const result = answers[method];
      const body =
        result instanceof Error
          ? { jsonrpc: "2.0", id, error: { message: result.message } }
          : { jsonrpc: "2.0", id, result };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    async close() {
      session.closes += 1;
      return { txHash: "0xrpcclose", spent: cumulative.toString() };
    },
  };
  return session;
}

const ANSWERS = {
  eth_chainId: "0x1079",
  eth_blockNumber: "0x10",
  eth_call: "0x" + BigInt(5_000_000).toString(16).padStart(64, "0"),
};

describe("rpc — the paid RPC session", () => {
  it("opens with eth_chainId, answers JSON-RPC, and queues its calls on the one channel", async () => {
    const inFlight = { now: 0, max: 0 };
    const fake = fakeSession(ANSWERS, { inFlight });
    const rpc = new MppRpcSession({
      account: { address: PAYER },
      maxDepositBase: BigInt(20_000),
      topUpBase: BigInt(10_000),
      sessionFactory: async () => fake,
    });
    await rpc.open();
    const [block, balance] = await Promise.all([rpc.call("eth_blockNumber"), rpc.call("eth_call", [{}, "latest"])]);
    expect(block).to.equal("0x10");
    expect(balance).to.equal(ANSWERS.eth_call);
    expect(inFlight.max, "one voucher at a time on one cumulative").to.equal(1);
    expect(rpc.cumulative).to.equal("3000");
    expect(rpc.channelId).to.equal("0xrpcchannel");
    expect(await rpc.close()).to.deep.equal({ txHash: "0xrpcclose", spent: "3000" });
  });

  it("abandons a call the gateway never answers at its deadline, and frees the queue for the next", async () => {
    // Without a deadline a stalled call would hold the one queue every call and the close wait in,
    // for undici's 300 s or forever, and a loop's stop would wait behind it with the model channel open.
    const fake = fakeSession(ANSWERS);
    const answer = fake.fetch.bind(fake);
    let stall = true;
    const signals: (AbortSignal | undefined)[] = [];
    fake.fetch = async (url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      // The first call stalls and does not even hear its signal: an mppx inside a request of its own.
      if (stall) {
        stall = false;
        return new Promise<Response>(() => undefined);
      }
      return answer(url, init);
    };
    const rpc = new MppRpcSession({
      account: { address: PAYER },
      maxDepositBase: BigInt(20_000),
      topUpBase: BigInt(10_000),
      sessionFactory: async () => fake,
      callDeadlineMs: 30,
      abortGraceMs: 10,
    });
    const t0 = Date.now();
    const thrown = await rpc.call("eth_blockNumber").then(
      () => null,
      (e) => e
    );
    expect(Date.now() - t0).to.be.lessThan(2_000);
    expect(String(thrown?.message)).to.match(/did not answer the RPC call eth_blockNumber/);
    expect(signals[0]?.aborted, "the fetch was told to stop").to.equal(true);
    expect(await rpc.call("eth_blockNumber"), "the next call is not stuck behind it").to.equal("0x10");
    expect(await rpc.close()).to.deep.include({ txHash: "0xrpcclose" });
  });

  it("throws on a close with no receipt, so the ledgered session keeps its row", async () => {
    const fake = fakeSession(ANSWERS);
    // What mppx answers to a 2xx close without a Payment-Receipt header.
    fake.close = async () => {
      fake.closes += 1;
      return undefined;
    };
    const rpc = new MppRpcSession({
      account: { address: PAYER },
      maxDepositBase: BigInt(20_000),
      topUpBase: BigInt(10_000),
      sessionFactory: async () => fake,
    });
    await rpc.open();
    const thrown = await rpc.close().then(
      () => null,
      (e) => e
    );
    expect(thrown).to.be.instanceOf(Error);
    expect(String(thrown.message)).to.match(/0xrpcchannel returned no receipt/);
    expect(fake.closes).to.equal(1);
    // `LoopTempoServices.close` turns it into `closed: false` with the reason, as for any failed close.
    const s = new LoopTempoServices({ loopId: LOOP, rpc });
    const closed = await s.close();
    expect(closed.rpc?.closed).to.equal(false);
  });

  it("refuses a node on another chain, and throws a JSON-RPC error with its message", async () => {
    const other = new MppRpcSession({
      account: { address: PAYER },
      maxDepositBase: BigInt(20_000),
      topUpBase: BigInt(10_000),
      sessionFactory: async () => fakeSession({ eth_chainId: "0x1" }),
    });
    let err: unknown;
    try {
      await other.open();
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/answers chain 1/);

    const failing = new MppRpcSession({
      account: { address: PAYER },
      maxDepositBase: BigInt(20_000),
      topUpBase: BigInt(10_000),
      sessionFactory: async () => fakeSession({ eth_blockNumber: new Error("header not found") }),
    });
    err = undefined;
    try {
      await failing.call("eth_blockNumber");
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/eth_blockNumber: header not found/);
  });
});

/** An `RpcSessionLike` over a fake session, with a gate a test can hold the reads behind. */
function rpcOver(
  answers: Record<string, unknown>,
  gate?: Promise<void>
): RpcSessionLike & { calls: string[]; opens: number } {
  const calls: string[] = [];
  let cumulative = 0;
  const rpc = {
    calls,
    opens: 0,
    opened: false,
    get channelId() {
      return rpc.opened ? "0xrpcchannel" : undefined;
    },
    get cumulative() {
      return rpc.opened ? String(cumulative) : undefined;
    },
    async open() {
      rpc.opens += 1;
      await rpc.call("eth_chainId", []);
    },
    async call(method: string, _params: unknown[] = []) {
      if (gate && method !== "eth_chainId") await gate;
      calls.push(method);
      rpc.opened = true;
      cumulative += 1_000;
      const result = answers[method];
      if (result instanceof Error) throw result;
      return result;
    },
    async close() {
      return { txHash: "0xrpcclose", spent: String(cumulative) };
    },
  };
  return rpc;
}

function services(rpc: RpcSessionLike) {
  return new LoopTempoServices({
    loopId: LOOP,
    rpc,
    treasury: PAYER,
    channel: () => ({ id: MODEL_CHANNEL, cumulative: "4500" }),
    readChannel: async () => ({ deposit: BigInt(1_000_000), settled: BigInt(0) }),
    now: () => 1_700_000_000_000,
  });
}

async function carryOf(
  store: { get(h: Uint8Array): Promise<Uint8Array | null> },
  tempoHash?: string
): Promise<TempoCarry | null> {
  if (!tempoHash) return null;
  return decodeTempoCarry((await store.get(toBytes32(tempoHash)))!);
}

describe("rpc — the model channel, read through the paid session", () => {
  it("routes TempoRpcReader's eth_call through the session and decodes (settled, deposit)", async () => {
    const seen: { method: string; params: unknown[] }[] = [];
    const word = (n: number) => BigInt(n).toString(16).padStart(64, "0");
    const reader = new TempoRpcReader({
      request: async (method, params) => {
        seen.push({ method, params });
        return "0x" + word(1_500) + word(250_000) + word(0);
      },
    });
    const state = await reader.channelState(MODEL_CHANNEL);
    expect(state).to.deep.equal({ settled: BigInt(1_500), deposit: BigInt(250_000), closeRequestedAt: 0 });
    expect(
      seen.map((c) => c.method),
      "no eth_chainId: the session checked its chain when it opened"
    ).to.deep.equal(["eth_call"]);
  });
});

describe("rpc — the snapshot, carried forward", () => {
  it("reads the block, the model channel, the treasury and its own cumulative after a leaf", async () => {
    const rpc = rpcOver(ANSWERS);
    const s = services(rpc);
    s.afterLeaf(4, async () => null);
    await s.drain();
    const carry = s.carry()!;
    expect(carry.snapshots).to.have.length(1);
    expect(carry.snapshots![0]).to.deep.equal({
      ofStep: 4,
      takenAt: 1_700_000_000_000,
      block: "16",
      channel: { id: MODEL_CHANNEL, deposit: "1000000", settled: "0", cumulative: "4500" },
      treasury: { usdcE: "5000000" },
      rpc: { channelId: "0xrpcchannel", cumulative: "3000" },
    });
    expect(rpc.opens, "the open was fired once, by the first job").to.equal(1);
    expect(s.lastSnapshot?.ofStep).to.equal(4);
  });

  it("carries a read that failed as a snapshot with its error", async () => {
    const s = services(rpcOver({ ...ANSWERS, eth_blockNumber: new Error("gateway timeout") }));
    s.afterLeaf(2, async () => null);
    await s.drain();
    const [snap] = s.carry()!.snapshots!;
    expect(snap.ofStep).to.equal(2);
    expect(snap.error).to.match(/gateway timeout/);
    expect(snap.block).to.equal(undefined);
  });

  it("opens the session beside the first step, and puts step N's snapshot in step N+1's leaf", async () => {
    const rpc = rpcOver(ANSWERS);
    const s = services(rpc);
    const { runner, store } = tempoLoop({ loopId: LOOP, services: s });

    const first = await runner.step();
    expect(rpc.opens, "fired at the first step's start").to.equal(1);
    expect(first.manifest?.tempoHash, "nothing is ready when step 1 closes").to.equal(undefined);
    await s.drain();

    const second = await runner.step();
    const carry = await carryOf(store, second.manifest?.tempoHash);
    expect(carry?.snapshots?.map((x) => x.ofStep)).to.deep.equal([1]);
    expect(carry?.storage, "no storage without a charge client").to.equal(undefined);
    expect(rpc.opens, "and never again").to.equal(1);
  });

  it("carries a late snapshot in the next leaf that closes after it, still paired with its own step", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = services(rpcOver(ANSWERS, gate));
    const { runner, store } = tempoLoop({ loopId: LOOP, services: s });

    await runner.step(); // step 1's reads start, and wait behind the gate
    const second = await runner.step(); // closes while they wait
    expect(second.manifest?.tempoHash, "step 1's snapshot is not ready yet").to.equal(undefined);

    release();
    await s.drain(); // step 1's and step 2's reads both finish
    const third = await runner.step();
    const carry = await carryOf(store, third.manifest?.tempoHash);
    const ofSteps = carry!.snapshots!.map((x) => x.ofStep);
    expect(ofSteps).to.deep.equal([1, 2]);
    // Pairing: every snapshot names a step before the leaf that carries it.
    for (const snap of carry!.snapshots!) expect(snap.ofStep).to.be.lessThan(third.step);

    // Carried once: the fourth leaf carries only step 3's.
    await s.drain();
    const fourth = await runner.step();
    const next = await carryOf(store, fourth.manifest?.tempoHash);
    expect(next!.snapshots!.map((x) => x.ofStep)).to.deep.equal([3]);
  });

  it("closes the RPC channel once, after an open still in flight", async () => {
    let release!: () => void;
    const opening = new Promise<void>((r) => (release = r));
    const rpc = rpcOver(ANSWERS);
    const open = rpc.open.bind(rpc);
    rpc.open = async () => {
      await opening;
      await open();
    };
    const s = services(rpc);
    s.start();
    const closing = s.close();
    release();
    const closed = await closing;
    expect(closed.rpc).to.deep.include({ channelId: "0xrpcchannel", closed: true, txHash: "0xrpcclose" });
    expect(await s.close(), "idempotent").to.equal(closed);
  });
});

describe("loop keys — who signs the storage charge and the RPC session", () => {
  const TREASURY_PK = `0x${"11".repeat(32)}` as const;
  const treasury = privateKeyToAccount(TREASURY_PK);
  const KEY = "0x00000000000000000000000000000000000Ac0e5" as const;
  /** The shape `viem/tempo` gives an access key rooted on the treasury: the root's address, the key beside it. */
  const keyAccount: TempoSigningAccount = { address: treasury.address, accessKeyAddress: KEY };
  /** What the client was built with; read off the instance, since nothing here may sign or send. */
  const accountOf = (client: unknown) => (client as { opts: { account: TempoSigningAccount } }).opts.account;

  let saved: string | undefined;
  before(() => {
    saved = process.env.LATH_TEMPO_TREASURY;
    process.env.LATH_TEMPO_TREASURY = TREASURY_PK;
  });
  after(() => {
    if (saved === undefined) delete process.env.LATH_TEMPO_TREASURY;
    else process.env.LATH_TEMPO_TREASURY = saved;
  });

  it("builds the storage charge on the treasury by default, and on a loop's key when given one", () => {
    const plain = treasuryChargeTransport();
    expect(accountOf(plain).address).to.equal(treasury.address);
    expect(accessKeyOf(accountOf(plain)), "the treasury's own key").to.equal(undefined);

    const keyed = treasuryChargeTransport(undefined, keyAccount);
    expect(accountOf(keyed)).to.equal(keyAccount);
    expect(keyed.payer, "a key's payment still names the treasury as payer").to.equal(treasury.address);
  });

  it("forwards a keyed loop's clientId to the charge transport, and none without one", () => {
    const optsOf = (client: unknown) => (client as { opts: Record<string, unknown> }).opts;
    const keyed = treasuryChargeTransport(undefined, keyAccount, { clientId: LOOP });
    expect(optsOf(keyed).clientId).to.equal(LOOP);
    expect(accountOf(keyed)).to.equal(keyAccount);

    // Absent as a key, not present as `undefined`: the transport's options are the ones an
    // unattributed transport has, so its factory is asked for exactly the same mppx client.
    for (const plain of [
      treasuryChargeTransport(),
      treasuryChargeTransport(undefined, keyAccount),
      treasuryChargeTransport(undefined, undefined, {}),
    ]) {
      expect("clientId" in optsOf(plain)).to.equal(false);
    }
  });

  it("refuses a storage charge on an account rooted anywhere but the treasury", () => {
    const elsewhere: TempoSigningAccount = {
      address: "0x000000000000000000000000000000000000E15e",
      accessKeyAddress: KEY,
    };
    expect(() => treasuryChargeTransport(undefined, elsewhere)).to.throw(/refused/);
  });

  it("keeps the RPC session on the treasury: Lath pays it, so no loop's key ever signs it", () => {
    const rpc = treasuryRpcSession("ab".repeat(32));
    expect(accountOf(rpc).address).to.equal(treasury.address);
    expect(accessKeyOf(accountOf(rpc))).to.equal(undefined);
  });
});
