import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { epochsSupported, epochsSupportedOrNot } from "../frontend/src/app/api/_lib/runner";

/**
 * `epochsSupported` caches only an answer read from the program's bytes. A first probe that threw,
 * or found no program-data account on a lagging node, cached as `false` for the life of the process
 * would refuse every loop step and run every `/api/run` without epochs until a restart. Such a
 * probe rejects instead, so a loop step fails and is retried instead of being refused
 * (a refusal stops the loop for good), and `/api/run` reads it as `false` for one session only. Node only: the RPC is a stub with `getAccountInfo` and nothing else, and each case uses a
 * fresh program id so the per-process cache does not carry one case into the next.
 */
describe("the commit_epoch probe caches only what it read", () => {
  const saved = process.env.LATH_EPOCHS;
  before(() => delete process.env.LATH_EPOCHS);
  after(() => {
    if (saved === undefined) delete process.env.LATH_EPOCHS;
    else process.env.LATH_EPOCHS = saved;
  });

  const withEpochs = { data: Buffer.concat([Buffer.alloc(40), Buffer.from("lattice.epoch"), Buffer.alloc(8)]) };
  const withoutEpochs = { data: Buffer.alloc(64) };

  function rpcAnswering(...answers: Array<() => unknown>) {
    const rpc = {
      calls: 0,
      getAccountInfo: async () => answers[Math.min(rpc.calls++, answers.length - 1)](),
    };
    return rpc;
  }

  /** The message a promise rejects with, or a failure of this test if it resolved. */
  async function rejection(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected the probe to reject");
  }

  it("a probe that threw rejects, then the next caller asks again and the answer sticks", async () => {
    const programId = Keypair.generate().publicKey;
    const rpc = rpcAnswering(
      () => {
        throw new Error("429 Too Many Requests");
      },
      () => withEpochs
    );
    expect(await rejection(epochsSupported(rpc as any, programId))).to.match(/429/);
    expect(await epochsSupported(rpc as any, programId)).to.equal(true);
    expect(await epochsSupported(rpc as any, programId)).to.equal(true);
    expect(rpc.calls, "the answer read from bytes is cached").to.equal(2);
  });

  it("a missing program-data account rejects and is not cached either", async () => {
    const programId = Keypair.generate().publicKey;
    const rpc = rpcAnswering(
      () => null,
      () => withEpochs
    );
    expect(await rejection(epochsSupported(rpc as any, programId))).to.match(/no program-data account/);
    expect(await epochsSupported(rpc as any, programId)).to.equal(true);
    expect(rpc.calls).to.equal(2);
  });

  it("a session caller reads a failed probe as false for that call only", async () => {
    const programId = Keypair.generate().publicKey;
    const rpc = rpcAnswering(
      () => {
        throw new Error("fetch failed");
      },
      () => withEpochs
    );
    expect(await epochsSupportedOrNot(rpc as any, programId)).to.equal(false);
    expect(await epochsSupportedOrNot(rpc as any, programId)).to.equal(true);
    expect(rpc.calls).to.equal(2);
  });

  it("bytes without the tag are a real answer, and that false is cached", async () => {
    const programId = Keypair.generate().publicKey;
    const rpc = rpcAnswering(
      () => withoutEpochs,
      () => withEpochs
    );
    expect(await epochsSupported(rpc as any, programId)).to.equal(false);
    expect(await epochsSupported(rpc as any, programId)).to.equal(false);
    expect(rpc.calls).to.equal(1);
  });

  it("callers waiting on the same failed probe all see its rejection, from one read", async () => {
    const programId = Keypair.generate().publicKey;
    const rpc = rpcAnswering(
      () => {
        throw new Error("fetch failed");
      },
      () => withEpochs
    );
    const both = await Promise.allSettled([
      epochsSupported(rpc as any, programId),
      epochsSupported(rpc as any, programId),
    ]);
    expect(both.map((r) => r.status)).to.deep.equal(["rejected", "rejected"]);
    expect(rpc.calls).to.equal(1);
    expect(await epochsSupported(rpc as any, programId)).to.equal(true);
  });
});
