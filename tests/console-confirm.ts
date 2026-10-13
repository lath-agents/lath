import "./fixtures/trace-dir";
import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import { confirmLandedDeploy } from "../frontend/src/app/api/_lib/runner";
import { backoffDelay, isRetryableRpcError, withRetry } from "../frontend/src/app/api/_lib/retry";

/**
 * When a confirm spends its ticket.
 *
 * A deploy and a clone call one helper for it, which is what makes it testable: the two chain
 * reads are injected the way `RequestPoll` is in
 * `_lib/loops.ts`, so the spend rule can be exercised against a fake chain with no validator.
 *
 * The rule: by the time a confirm runs the transaction has already landed and been signed, so a
 * ticket burned because one RPC node was a slot behind leaves a registered, funded agent with no
 * record, under a name `prepareDeployTx` refuses forever. A *transient* refusal must therefore
 * keep the ticket and say so, and only a permanent one may spend it. Get it backwards and a
 * retry loop spends the ticket on the first permanent refusal, after which every retry answers
 * "unknown ticket" instead of what was actually wrong.
 */
describe("confirming a landed deploy", () => {
  const server = Keypair.generate();
  const ticket = { message: "Lath deploy\nwallet: W", wallet: "W" };
  const base = { server, name: "a-name", signature: "sig", ticket };

  async function run(
    signed: { ok: true } | { reason: string; transient?: boolean },
    landed: { authority: string } | null
  ) {
    let spent = 0;
    const out = await confirmLandedDeploy({
      ...base,
      noun: "deploy",
      spend: () => spent++,
      chain: { signedBy: async () => signed, landed: async () => landed },
    });
    const body: any = "refused" in out ? await out.refused.json() : null;
    return { out, spent, body, status: "refused" in out ? out.refused.status : 200 };
  }

  it("keeps the ticket on a transient refusal, and says it is transient", async () => {
    const { spent, body, status } = await run({ reason: "it did not land", transient: true }, null);
    assert.equal(spent, 0, "a ticket spent here is a name burned for good");
    assert.isTrue(body.transient, "the browser needs to know this one is worth retrying");
    assert.equal(status, 409);
    assert.include(body.error, "this deploy is not confirmed: it did not land");
  });

  it("spends the ticket on a permanent refusal, and does not claim it is transient", async () => {
    const { spent, body } = await run({ reason: "another wallet signed it" }, null);
    assert.equal(spent, 1);
    assert.notProperty(body, "transient", "a retry loop must stop here, not go round again");
    assert.include(body.error, "another wallet signed it");
  });

  it("keeps the ticket when the transaction is proved but the indexer has not caught up", async () => {
    // `deployTxSignedBy` has already said this landed and succeeded, so a missing header is the
    // compressed-account indexer lagging, which on devnet it routinely does.
    const { spent, body } = await run({ ok: true }, null);
    assert.equal(spent, 0);
    assert.isTrue(body.transient);
    assert.include(body.error, "the deploy transaction did not land");
  });

  it("spends the ticket exactly once when the chain has answered, and reports the authority", async () => {
    const { out, spent } = await run({ ok: true }, { authority: "AUTH" });
    assert.equal(spent, 1);
    assert.deepEqual(out, { authority: "AUTH" });
  });

  it("names the operation in the refusal, so three flows do not all say deploy", async () => {
    for (const noun of ["deploy", "clone", "launch"]) {
      const out = await confirmLandedDeploy({
        ...base,
        noun,
        spend: () => {},
        chain: { signedBy: async () => ({ ok: true } as const), landed: async () => null },
      });
      assert.property(out, "refused");
      const body: any = await (out as { refused: Response }).refused.json();
      assert.include(body.error, `the ${noun} transaction did not land`);
    }
  });
});

/**
 * The name publish's retry. stateless.js throws `HTTP error! status: 429` on a Photon
 * rate limit and does not wait, so one unretried 429 would leave a registered clone "Unnamed" for good. The rule
 * under test: rate limits, 5xx and transport failures are retried with a doubling, capped wait;
 * a refusal the program or SDK makes is not, because it fails the same way every time.
 */
describe("retrying a best-effort name publish", () => {
  const policy = { attempts: 4, baseDelayMs: 100, maxDelayMs: 250 };

  async function run(errors: unknown[]) {
    const waits: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        const e = errors[calls++];
        if (e !== undefined) throw e;
        return "named";
      },
      policy,
      { sleep: async (ms) => void waits.push(ms) }
    ).catch((e) => e);
    return { out, calls, waits };
  }

  it("classifies what stateless.js and fetch actually throw", () => {
    assert.isTrue(isRetryableRpcError(new Error("HTTP error! status: 429")));
    assert.isTrue(isRetryableRpcError(new Error("HTTP error! status: 503")));
    assert.isTrue(isRetryableRpcError({ status: 502 }));
    assert.isTrue(isRetryableRpcError(new TypeError("fetch failed")));
    assert.isTrue(isRetryableRpcError(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })));
    assert.isFalse(isRetryableRpcError(new Error("HTTP error! status: 400")));
    assert.isFalse(isRetryableRpcError(new Error('"a" hashes to 00, not to this owner 11')));
  });

  it("outlasts a rate limit and backs off with a doubling, capped wait", async () => {
    const r = await run([
      new Error("HTTP error! status: 429"),
      new Error("HTTP error! status: 429"),
      new Error("fetch failed"),
    ]);
    assert.equal(r.out, "named");
    assert.equal(r.calls, 4);
    assert.deepEqual(r.waits, [100, 200, 250]);
  });

  it("stops at the attempt bound and rethrows the last error", async () => {
    const r = await run(Array.from({ length: 10 }, (_, i) => new Error(`HTTP error! status: 429 #${i}`)));
    assert.equal(r.calls, 4);
    assert.match(String(r.out?.message), /#3$/);
  });

  it("does not retry a refusal that would fail identically", async () => {
    const r = await run([new Error("a published name holds 32 bytes inline")]);
    assert.equal(r.calls, 1);
    assert.deepEqual(r.waits, []);
  });

  it("gives backoffDelay the same schedule", () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((n) => backoffDelay(policy, n)),
      [100, 200, 250, 250]
    );
  });
});
