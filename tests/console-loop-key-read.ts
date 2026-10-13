import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TEMPO_USDC_E, releaseTreasuryForTests } from "../frontend/src/app/api/_lib/tempo";
import { setTempoKeyChainForTests, TempoKeyTestHooks } from "../frontend/src/app/api/_lib/tempo-keys";
import { LoopRecord, recordLoop } from "../frontend/src/app/api/_lib/loops";
// Loaded through `require` so the root `tsc` does not follow the route's type imports into the
// frontend's client modules, which compile only under the frontend's config (`console-quota-order`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GET: loopsGET } = require("../frontend/src/app/api/loops/route") as {
  GET: (req: unknown) => Promise<Response>;
};

/**
 * `GET /api/loops?id=` on a loop with a Tempo access key reads the key's state off Tempo from the
 * console's own address. The route is public and anonymous, so N readers that arrive together must
 * share one read rather than fire N (the exposure `tempo/treasury/route.ts` closes the same way): the
 * cache holds the read's promise from the moment it is made, not its answer once it lands.
 *
 * Network-free: the keychain is a stand-in whose `readState` counts its calls and answers when told.
 * Runs in its own mocha process: the route's key-state cache is process state.
 */

const treasury = privateKeyToAccount(generatePrivateKey());
const AGENT = "ab".repeat(32);

function keyedLoop(id: string): LoopRecord {
  const key = privateKeyToAccount(generatePrivateKey());
  const loop: LoopRecord = {
    id,
    agentId: AGENT,
    agentName: "watcher",
    owner: "OwNeR111111111111111111111111111111111111111",
    prompt: "check the slot and report",
    promptHash: "cd".repeat(32),
    intervalMs: 15_000,
    maxSteps: 3,
    budgetMicroUsdcPerStep: "50000",
    model: "deepseek/deepseek-v4.1-flash",
    createdAt: Date.now(),
    // Stopped, so the heartbeat every GET is does not pick it up and start a scheduler.
    status: "stopped",
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
    tempoKey: {
      loopId: id,
      address: key.address,
      token: TEMPO_USDC_E,
      limitBase: "1000000",
      expiry: Math.floor(Date.now() / 1000) + 86_400,
    },
  };
  recordLoop(loop);
  return loop;
}

/** A keychain whose `readState` answers only when `release` is called, counting every call. */
function gatedChain(fail = false) {
  let reads = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // Only the read: a call left out rejects rather than reaching the network.
  const chain: TempoKeyTestHooks = {
    readState: async () => {
      reads++;
      await gate;
      if (fail) throw new Error("rpc.tempo.xyz unreachable");
      return { remaining: BigInt(750_000), expiry: Math.floor(Date.now() / 1000) + 86_400, isRevoked: false };
    },
    treasury,
  };
  return { chain, reads: () => reads, release: () => release() };
}

// The route's GET reads `nextUrl` and a header; `next/server` does not resolve from the root suites.
const get = (id: string) =>
  loopsGET({ nextUrl: new URL(`http://localhost:3000/api/loops?id=${id}`), headers: new Headers() });

describe("GET /api/loops?id=: one Tempo key read for readers that arrive together", () => {
  afterEach(() => {
    setTempoKeyChainForTests(null);
    releaseTreasuryForTests();
  });
  after(() => fs.rmSync(path.join(traceDir, "loops.json"), { force: true }));

  it("shares the read in flight among concurrent readers, and reuses its answer", async () => {
    const loop = keyedLoop("loop-key-read-000000a1");
    const gated = gatedChain();
    setTempoKeyChainForTests(gated.chain);
    const pending = Array.from({ length: 6 }, () => get(loop.id));
    // Let every request reach the key read before Tempo answers.
    await new Promise((r) => setTimeout(r, 50));
    gated.release();
    const bodies = await Promise.all(pending.map(async (p) => (await p).json() as any));
    assert.equal(gated.reads(), 1, "six concurrent readers made one Tempo read");
    for (const b of bodies) assert.equal(b.loop.tempoKey.remaining, "750000");
    await (await get(loop.id)).json();
    assert.equal(gated.reads(), 1, "a reader inside the window reuses the answer");
  });

  it("shares a failed read in flight, and drops it once it settles so the next reader asks again", async () => {
    const loop = keyedLoop("loop-key-read-000000a2");
    const gated = gatedChain(true);
    setTempoKeyChainForTests(gated.chain);
    const pending = Array.from({ length: 4 }, () => get(loop.id));
    await new Promise((r) => setTimeout(r, 50));
    gated.release();
    const bodies = await Promise.all(pending.map(async (p) => (await p).json() as any));
    assert.equal(gated.reads(), 1);
    for (const b of bodies) assert.isNull(b.loop.tempoKey.remaining);
    await (await get(loop.id)).json();
    assert.equal(gated.reads(), 2, "a failed read is not kept for the window");
  });
});
