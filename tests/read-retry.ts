import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { LathClient } from "../sdk/src/client";
import { BillingClient } from "../sdk/src/billing";
import {
  confirmByPolling,
  forgetRpcQuotaSpent,
  isRpcQuotaError,
  isTransientRpcError,
  noteRpcQuotaSpent,
  RPC_QUOTA_ERROR,
  RPC_QUOTA_MEMORY_MS,
  rpcQuotaSpentRecently,
  withTransientReadRetries,
} from "../sdk/src/confirm";
import { ALLOWANCE_LEGACY_LEN, ALLOWANCE_LEN } from "../sdk/src/layout";
import bs58 from "bs58";
import {
  BROWSER_NETWORK_ERROR,
  base58,
  broadcastPrepared,
  browserNetworkErrorsTransient,
  settleBroadcast,
  unrecordedWriteError,
} from "../frontend/src/lib/broadcast";
import { LathMap, MapKeyRetiredError } from "../sdk/src/structures";
import { signatureOfWire } from "./fixtures/doubtful-rpc";

// The SDK remembers a spent RPC plan for a minute (`noteRpcQuotaSpent`); one test's sighting must
// not turn the next test's 429 into a spent plan.
beforeEach(() => forgetRpcQuotaSpent());

/**
 * A rate-limited Photon read is retried, not surfaced. `ensureRegistered` reads the agent's
 * state outside `withRetry`, and one 429 there must not end a whole session while the writes
 * around it retry. The rpc here is a stub: only `getCompressedAccount`
 * and `commitment` are touched by a state read.
 */
function clientWith(read: () => Promise<unknown>) {
  const rpc = { commitment: "confirmed", getCompressedAccount: read } as any;
  return LathClient.fromIdl(rpc, Keypair.generate(), { retryDelayMs: 1, maxRetries: 3 });
}

/** The message a promise rejects with, or a failure of this test if it resolved. */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the read to reject");
}

describe("state reads retry transient RPC failures", () => {
  const agentId = new Uint8Array(32).fill(7);

  it("a 429 on the first read is retried and the second answer stands", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP error! status: 429");
      return null;
    });
    expect(await client.getAgentState(agentId)).to.equal(null);
    expect(calls).to.equal(2);
  });

  it("a limit that holds for every attempt surfaces as the same error", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      throw new Error("HTTP error! status: 429");
    });
    expect(await failure(client.getAgentState(agentId))).to.match(/429/);
    expect(calls).to.equal(4);
  });

  it("an error that is not transient is thrown on the first attempt", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      throw new Error("invalid params");
    });
    expect(await failure(client.getAgentState(agentId))).to.match(/invalid params/);
    expect(calls).to.equal(1);
  });
});

/**
 * `confirmByPolling` under a rate-limited RPC. A 429 while polling, thrown as a failed
 * confirmation for a transaction that had landed, would have the caller send it again. The
 * connection is a stub: only `getSignatureStatuses` and `getBlockHeight` are touched.
 */
describe("confirmation survives transient RPC errors", () => {
  const confirmed = { slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" };
  const statuses = (value: unknown[]) => ({ context: { slot: 1 }, value });
  const rateLimited = () => {
    throw new Error("HTTP error! status: 429 Too Many Requests");
  };

  it("classifies transport failures as transient and program failures as not", () => {
    expect(isTransientRpcError(new Error("HTTP error! status: 429"))).to.equal(true);
    expect(isTransientRpcError(new Error("fetch failed"))).to.equal(true);
    expect(isTransientRpcError(new Error("502 Bad Gateway"))).to.equal(true);
    // Photon behind a load balancer, now and then: the next request is served.
    expect(
      isTransientRpcError(new Error("failed to get info for compressed account 1054961332: Method not found"))
    ).to.equal(true);
    expect(isTransientRpcError(new Error('{"code":-32601,"message":"Method not found"}'))).to.equal(true);
    expect(isTransientRpcError(new Error("custom program error: 0x1782"))).to.equal(false);
  });

  it("a 429 on the status read is asked again, and the next answer stands", async () => {
    let calls = 0;
    const connection = {
      getSignatureStatuses: async () => (++calls === 1 ? rateLimited() : statuses([confirmed])),
      getBlockHeight: async () => 1,
    } as any;
    await confirmByPolling(connection, "sig", 100, { intervalMs: 1, maxWaitMs: 1_000 });
    expect(calls).to.equal(2);
  });

  it("a 429 on the height read, then an expired blockhash with no status, is an expiry", async () => {
    let heights = 0;
    const connection = {
      getSignatureStatuses: async () => statuses([null]),
      getBlockHeight: async () => (++heights === 1 ? rateLimited() : 101),
    } as any;
    expect(await failure(confirmByPolling(connection, "sig", 100, { intervalMs: 1, maxWaitMs: 1_000 }))).to.match(
      /block height exceeded/
    );
  });

  it("an expired blockhash whose final look over history finds the transaction confirmed resolves", async () => {
    // The race the final look closes: the transaction confirmed between the status read and the
    // height read, so the first read saw nothing and the height says the window is over.
    let heights = 0;
    const connection = {
      getSignatureStatuses: async (_: string[], opts: { searchTransactionHistory: boolean }) =>
        statuses([opts.searchTransactionHistory ? confirmed : null]),
      getBlockHeight: async () => (++heights === 1 ? rateLimited() : 101),
    } as any;
    await confirmByPolling(connection, "sig", 100, { intervalMs: 1, maxWaitMs: 1_000 });
  });

  it("a status with an error still fails at once", async () => {
    const connection = {
      getSignatureStatuses: async () => statuses([{ ...confirmed, err: { InstructionError: [0, { Custom: 6003 }] } }]),
      getBlockHeight: async () => 1,
    } as any;
    expect(await failure(confirmByPolling(connection, "sig", 100, { intervalMs: 1 }))).to.match(/sig failed/);
  });

  it("an RPC that answers only 429s ends as unknown, without claiming the blockhash expired", async () => {
    const connection = { getSignatureStatuses: rateLimited, getBlockHeight: rateLimited } as any;
    let error: any;
    try {
      await confirmByPolling(connection, "sig", 100, { intervalMs: 1, maxWaitMs: 5 });
    } catch (e) {
      error = e;
    }
    expect(error, "it must give up").to.not.equal(undefined);
    expect(error.confirmationUnknown).to.equal(true);
    expect(error.message).to.match(/confirmation of sig unknown/);
    expect(error.message).to.not.match(/block height exceeded|expired/);
  });
});

/**
 * A deploy, clone or launch the browser broadcast keeps its ticket unless the chain gave a verdict
 * against the transaction. A browser's dropped request (`Failed to fetch`, `Load failed`,
 * `NetworkError …`) is not in the SDK's transient list, so one blip on the first poll could end it,
 * the status read a second later find nothing yet, and the ticket be thrown away for a transaction
 * that landed moments later — an agent on chain the console has no record of.
 * Run against the SDK's real `confirmByPolling` over a fake cluster, as `useSendPrepared` runs it.
 */
describe("a broadcast prepared transaction keeps its ticket until the chain says otherwise", () => {
  const confirmed = { slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" };
  const statuses = (value: unknown[]) => ({ context: { slot: 1 }, value });
  const BROWSER_BLIPS = ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."];
  const blip = (message: string) => () => Promise.reject(new TypeError(message));

  it("the browsers' network failures are not in the SDK's transient list, so the wrapper is needed", () => {
    for (const m of BROWSER_BLIPS) {
      expect(isTransientRpcError(new TypeError(m)), m).to.equal(false);
      expect(BROWSER_NETWORK_ERROR.test(m), m).to.equal(true);
    }
  });

  it("a network blip on the first poll is asked again, and the landed transaction confirms", async () => {
    for (const m of BROWSER_BLIPS) {
      let calls = 0;
      const connection = {
        getSignatureStatuses: async () => (++calls === 1 ? blip(m)() : statuses([confirmed])),
        getBlockHeight: async () => 1,
      };
      // Without the wrapper the first rejection ends the poll at once — the defect.
      expect(await failure(confirmByPolling(connection as any, "sig", 100, { intervalMs: 1 }))).to.equal(m);
      calls = 0;
      await confirmByPolling(browserNetworkErrorsTransient(connection) as any, "sig", 100, { intervalMs: 1 });
      expect(calls, m).to.equal(2);
    }
  });

  it("leaves every other rejection and every answer as they were", async () => {
    const answer = statuses([confirmed]);
    const connection = browserNetworkErrorsTransient({
      getSignatureStatuses: async () => answer,
      getBlockHeight: () => Promise.reject(new Error("custom program error: 0x1782")),
      commitment: "confirmed",
    });
    expect(await connection.getSignatureStatuses()).to.equal(answer);
    expect(await failure(connection.getBlockHeight())).to.equal("custom program error: 0x1782");
    expect(connection.commitment).to.equal("confirmed");
  });

  it("an unreadable confirmation resolves unconfirmed with the signature, so the ticket is presented", async () => {
    // The poll fails on something that is not a verdict, and the status read after it fails too.
    const sent = await settleBroadcast(
      "sig",
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => Promise.reject(new TypeError("Failed to fetch"))
    );
    expect(sent).to.deep.equal({ signature: "sig", landed: false });
    // An RPC that answered only transient errors until the poll gave up is the same: not known.
    const unknown = Object.assign(new Error("confirmation of sig unknown: …"), { confirmationUnknown: true });
    expect(
      await settleBroadcast(
        "sig",
        () => Promise.reject(unknown),
        async () => null
      )
    ).to.deep.equal({
      signature: "sig",
      landed: false,
    });
  });

  it("a status read that finds it confirmed resolves landed, as before", async () => {
    const sent = await settleBroadcast(
      "sig",
      () => Promise.reject(new TypeError("Failed to fetch")),
      async () => confirmed
    );
    expect(sent).to.deep.equal({ signature: "sig", landed: true });
    expect(
      await settleBroadcast(
        "sig",
        async () => undefined,
        async () => null
      )
    ).to.deep.equal({
      signature: "sig",
      landed: true,
    });
  });

  it("only the chain's verdicts end the flow: a failed transaction and an expired blockhash", async () => {
    // Failed on chain, by the poll or by the status read.
    const failedOnChain = { ...confirmed, err: { InstructionError: [0, { Custom: 6003 }] } };
    const byPoll = {
      getSignatureStatuses: async () => statuses([failedOnChain]),
      getBlockHeight: async () => 1,
    } as any;
    expect(
      await failure(
        settleBroadcast(
          "sig",
          () => confirmByPolling(byPoll, "sig", 100, { intervalMs: 1 }),
          () => Promise.reject(new TypeError("Failed to fetch"))
        )
      )
    ).to.match(/sig failed/);
    expect(
      await failure(
        settleBroadcast(
          "sig",
          () => Promise.reject(new TypeError("Failed to fetch")),
          async () => failedOnChain
        )
      )
    ).to.match(/failed on-chain/);
    // Expired: the window closed and a last look over history found nothing.
    const expired = { getSignatureStatuses: async () => statuses([null]), getBlockHeight: async () => 101 } as any;
    expect(
      await failure(
        settleBroadcast(
          "sig",
          () => confirmByPolling(expired, "sig", 100, { intervalMs: 1 }),
          async () => null
        )
      )
    ).to.match(/block height exceeded/);
  });

  /**
   * The send itself can lose its answer — the RPC proxy's 504 or 502 after Helius
   * forwarded the transaction, or a dropped fetch — and the signed transaction still lands. The
   * signature is known before the send, and only an answer about the transaction ends the flow there.
   */
  it("knows the signature before the send: base58 of the fee payer's signature, as bs58 encodes it", () => {
    for (const bytes of [new Uint8Array(64), new Uint8Array(64).fill(255), Keypair.generate().secretKey]) {
      expect(base58(bytes)).to.equal(bs58.encode(bytes));
    }
    const leadingZeros = new Uint8Array(64);
    leadingZeros[3] = 9;
    expect(base58(leadingZeros)).to.equal(bs58.encode(leadingZeros));
  });

  it("a send that got no answer is settled, and a transaction that landed keeps its ticket", async () => {
    const proxyTimeout = new Error('504 Gateway Timeout: {"jsonrpc":"2.0","error":{"code":-32000}}');
    for (const lost of [proxyTimeout, new TypeError("Failed to fetch")]) {
      const landed = { getSignatureStatuses: async () => statuses([confirmed]), getBlockHeight: async () => 1 } as any;
      expect(
        await broadcastPrepared(
          "sig",
          () => Promise.reject(lost),
          () => false,
          () => confirmByPolling(landed, "sig", 100, { intervalMs: 1 }),
          async () => confirmed
        )
      ).to.deep.equal({ signature: "sig", landed: true });
      // Nothing readable either way: unknown, and the ticket is still presented.
      expect(
        await broadcastPrepared(
          "sig",
          () => Promise.reject(lost),
          () => false,
          () => Promise.reject(new TypeError("Failed to fetch")),
          () => Promise.reject(new TypeError("Failed to fetch"))
        )
      ).to.deep.equal({ signature: "sig", landed: false });
    }
  });

  it("a send verdict throws at once, and a send that never left reports its own error", async () => {
    let polled = false;
    const preflight = new Error("Simulation failed: custom program error: 0x1782");
    expect(
      await failure(
        broadcastPrepared(
          "sig",
          () => Promise.reject(preflight),
          (e) => e === preflight,
          async () => {
            polled = true;
          },
          async () => null
        )
      )
    ).to.match(/0x1782/);
    expect(polled, "a verdict from the send is not polled").to.equal(false);
    // Unanswered, then the blockhash expired with the transaction nowhere: it never left, and the
    // send's own reason is what the user reads, not "block height exceeded".
    const expired = { getSignatureStatuses: async () => statuses([null]), getBlockHeight: async () => 101 } as any;
    expect(
      await failure(
        broadcastPrepared(
          "sig",
          () => Promise.reject(new Error("429 Too Many Requests: max usage reached")),
          () => false,
          () => confirmByPolling(expired, "sig", 100, { intervalMs: 1 }),
          async () => null
        )
      )
    ).to.match(/max usage reached/);
    // A sent transaction whose answer was lost and which then failed on chain says so.
    const failedOnChain = { ...confirmed, err: { InstructionError: [0, { Custom: 6003 }] } };
    expect(
      await failure(
        broadcastPrepared(
          "sig",
          () => Promise.reject(new TypeError("Failed to fetch")),
          () => false,
          () => Promise.reject(new TypeError("Failed to fetch")),
          async () => failedOnChain
        )
      )
    ).to.match(/failed on-chain/);
  });

  it("says a sent transaction may have landed, and a seen one did, naming the signature either way", () => {
    const err = new Error("this deploy is not confirmed: no transaction sig on devnet: it did not land");
    const seen = unrecordedWriteError(err, { signature: "sig", landed: true }, "agent").message;
    expect(seen).to.match(/^this deploy is not confirmed/);
    expect(seen).to.match(/the transaction sig landed, so the agent is registered on chain/);
    const unseen = unrecordedWriteError(err, { signature: "sig", landed: false }, "copy").message;
    expect(unseen).to.match(/the transaction sig was sent, but whether it landed could not be read/);
    expect(unseen).to.match(/If it did, the copy is registered on chain/);
    expect(unseen).to.not.match(/sig landed, so/);
  });
});

describe("BillingClient.send does not resend what it cannot account for", () => {
  it("a charge whose status cannot be read is not sent a second time", async function () {
    this.timeout(20_000);
    let sent = 0;
    const signatures: string[] = [];
    const connection = {
      commitment: "confirmed",
      getLatestBlockhash: async () => ({
        blockhash: new PublicKey(new Uint8Array(32).fill(5)).toBase58(),
        lastValidBlockHeight: 100,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sent += 1;
        signatures.push(signatureOfWire(raw));
        return signatures[signatures.length - 1];
      },
      getSignatureStatuses: async () => {
        throw new Error("HTTP error! status: 429 Too Many Requests");
      },
      getBlockHeight: async () => {
        throw new Error("HTTP error! status: 429 Too Many Requests");
      },
    } as any;
    const billing = BillingClient.fromIdl(connection, Keypair.generate(), {
      maxRetries: 2,
      retryDelayMs: 1,
      confirmMaxWaitMs: 5,
    });
    const ix = new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(0) });
    expect(await failure(billing.send([ix]))).to.equal(
      `could not tell whether ${signatures[0]} landed; not resent (a resent charge debits twice)`
    );
    expect(sent).to.equal(1);
  });

  it("a poll that meets a non-transient RPC error keeps asking, with the option the billing client sets", async () => {
    // `failed to get block height information: Internal error` carries no status code,
    // so `isTransientRpcError` does not match it, and by default the poll rethrows while the
    // transaction may still land. With `anyRpcError` it is asked again and the next answer stands.
    let heights = 0;
    let statuses = 0;
    const connection = {
      getSignatureStatuses: async () => ({
        context: { slot: 1 },
        value: [++statuses >= 2 ? { slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" } : null],
      }),
      getBlockHeight: async () => {
        if (++heights === 1) throw new Error("failed to get block height information: Internal error");
        return 1;
      },
    } as any;
    expect(await failure(confirmByPolling(connection, "sig", 100, { intervalMs: 1, maxWaitMs: 1_000 }))).to.match(
      /Internal error/
    );
    heights = 0;
    statuses = 0;
    await confirmByPolling(connection, "sig", 100, { intervalMs: 1, maxWaitMs: 1_000, anyRpcError: true });
    expect(statuses).to.equal(2);
  });

  it("under anyRpcError, an RPC that only errors still ends as unknown", async () => {
    const internal = () => {
      throw new Error("failed to get signature status: Internal error");
    };
    const connection = { getSignatureStatuses: internal, getBlockHeight: internal } as any;
    let error: any;
    try {
      await confirmByPolling(connection, "sig", 100, { intervalMs: 1, maxWaitMs: 5, anyRpcError: true });
    } catch (e) {
      error = e;
    }
    expect(error?.confirmationUnknown).to.equal(true);
    expect(error.message).to.match(/^confirmation of sig unknown: the RPC answered only errors/);
  });
});

describe("BillingClient.chargeIxs repairs a legacy grant in the same transaction", () => {
  function billingWithGrantOf(len: number | null) {
    const connection = {
      commitment: "confirmed",
      getAccountInfo: async () => (len === null ? null : { data: Buffer.alloc(len), owner: PublicKey.default }),
    } as any;
    return BillingClient.fromIdl(connection, Keypair.generate(), { admin: Keypair.generate().publicKey });
  }
  const names = (billing: BillingClient, ixs: TransactionInstruction[]) =>
    ixs.map((ix) => (billing.program.coder.instruction as any).decode(ix.data)?.name);

  it("prepends migrate_allowance to the charge on a 129-byte grant", async () => {
    const billing = billingWithGrantOf(ALLOWANCE_LEGACY_LEN);
    const ixs = await billing.chargeIxs(Keypair.generate().publicKey, 7);
    expect(names(billing, ixs)).to.deep.equal(["migrateAllowance", "charge"]);
  });

  it("is the charge alone on a grant that already has the current layout", async () => {
    const billing = billingWithGrantOf(ALLOWANCE_LEN);
    const ixs = await billing.chargeIxs(Keypair.generate().publicKey, 7);
    expect(names(billing, ixs)).to.deep.equal(["charge"]);
  });
});

/**
 * A closed Map key is retired. `close_cell` leaves an empty account at the address, which
 * `getCellAt` reads as `null` — so `has()` would say absent and `put` go on to die on an opaque proof
 * error. The rpc is a stub: `getCompressedAccount` answers per address, and the proof call throws
 * if it is ever reached.
 */
describe("a closed Map key is refused by name", () => {
  const ownerId = new Uint8Array(32).fill(2);
  const structId = new Uint8Array(32).fill(3);

  function clientOver(account: (address: string) => unknown) {
    let proofs = 0;
    const rpc = {
      commitment: "confirmed",
      getCompressedAccount: async (address: any) =>
        account(new PublicKey(Uint8Array.from(address.toArray("be", 32))).toBase58()),
      getValidityProofV0: async () => {
        proofs += 1;
        throw new Error("the proof call must not be reached");
      },
    } as any;
    const client = LathClient.fromIdl(rpc, Keypair.generate(), { retryDelayMs: 1, maxRetries: 0 });
    return { client, proofs: () => proofs };
  }

  it("reads absent, closed and live apart", async () => {
    let closedAddress = "";
    // An empty account at the closed key's address, a 187-byte cell everywhere else.
    const { client } = clientOver((a) => ({ data: { data: Buffer.alloc(a === closedAddress ? 0 : 187) } }));
    const map = new LathMap(client, ownerId, structId);
    closedAddress = map.address("closed").toBase58();
    expect(await client.cellStateAt(map.address("closed"))).to.equal("closed");
    expect(await client.cellStateAt(map.address("live"))).to.equal("live");

    const nothing = clientOver(() => null).client;
    expect(await nothing.cellStateAt(map.address("anything"))).to.equal("absent");
  });

  it("put on a closed key throws MapKeyRetiredError before any proof is asked for", async () => {
    const { client, proofs } = clientOver(() => ({ data: { data: Buffer.alloc(0) } }));
    const map = new LathMap(client, ownerId, structId);
    let error: unknown;
    try {
      await map.put("gone", "again");
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(MapKeyRetiredError);
    expect((error as Error).message).to.match(/closing a Map key retires its address/);
    expect(proofs()).to.equal(0);
  });
});

describe("transient read retries on the client's rpc", () => {
  const flaky = (failures: number, message = "failed to get info for compressed account 1: Method not found") => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async getCompressedAccount(x: number) {
        calls++;
        if (calls <= failures) throw new Error(message);
        return { x, calls };
      },
      async getBalance() {
        calls++;
        throw new Error("503 Service Unavailable");
      },
    };
  };

  it("asks a compression read again after Method not found, and returns the answer", async () => {
    const rpc = flaky(2);
    const out = await withTransientReadRetries(rpc, 4, 1).getCompressedAccount(7);
    expect(out).to.deep.equal({ x: 7, calls: 3 });
  });

  it("gives up after its attempts, with the last error", async () => {
    const rpc = flaky(10);
    let err: any;
    await withTransientReadRetries(rpc, 3, 1)
      .getCompressedAccount(1)
      .catch((e) => (err = e));
    expect(err?.message).to.match(/Method not found/);
    expect(rpc.calls).to.equal(3);
  });

  it("does not retry a read that failed for a reason of its own", async () => {
    const rpc = flaky(10, "invalid address");
    await withTransientReadRetries(rpc, 4, 1)
      .getCompressedAccount(1)
      .catch(() => undefined);
    expect(rpc.calls).to.equal(1);
  });

  it("does not retry a read refused because the RPC's plan has run out", async () => {
    const rpc = flaky(10, "429 Too Many Requests: upstream RPC answered 429: max usage reached");
    let err: any;
    await withTransientReadRetries(rpc, 4, 1)
      .getCompressedAccount(1)
      .catch((e) => (err = e));
    expect(err?.message).to.match(/max usage reached/);
    expect(rpc.calls).to.equal(1);
    // With no spent plan seen lately, a plain 429 is still a hiccup, asked again.
    forgetRpcQuotaSpent();
    const burst = flaky(1, "429 Too Many Requests");
    await withTransientReadRetries(burst, 4, 1).getCompressedAccount(1);
    expect(burst.calls).to.equal(2);
  });

  it("does not retry stateless.js's bare 429 for a minute after another call saw the spent plan", async () => {
    // stateless.js 0.23.3 throws this for every 429, without the body that says why. A web3.js call
    // through the app's fetch wrapper did see the body, and said so through the hook.
    const bare = "HTTP error! status: 429";
    const seenAt = Date.now();
    noteRpcQuotaSpent(seenAt);
    expect(isRpcQuotaError(new Error(bare))).to.equal(true);
    const rpc = flaky(10, bare);
    let err: any;
    await withTransientReadRetries(rpc, 4, 1)
      .getCompressedAccount(1)
      .catch((e) => (err = e));
    expect(err?.message).to.equal(bare);
    expect(rpc.calls).to.equal(1);
    // The memory is bounded: a minute later the same 429 is a burst again.
    expect(rpcQuotaSpentRecently(seenAt + RPC_QUOTA_MEMORY_MS - 1)).to.equal(true);
    expect(rpcQuotaSpentRecently(seenAt + RPC_QUOTA_MEMORY_MS)).to.equal(false);
    // Something that is not a 429 is never the plan, however fresh the memory.
    expect(isRpcQuotaError(new Error("503 Service Unavailable"))).to.equal(false);
  });

  it("remembers a spent plan whose words it reads in an error, and the app's words match the SDK's", async () => {
    expect(isRpcQuotaError(new Error("HTTP error! status: 429"))).to.equal(false);
    expect(isRpcQuotaError("upstream RPC answered 429: max usage reached")).to.equal(true);
    expect(isRpcQuotaError(new Error("HTTP error! status: 429"))).to.equal(true);
    // One regex: the words older read-error texts use all count here too.
    for (const words of ["max usage reached", "quota exceeded", "credits exhausted", "usage limit hit"]) {
      expect(RPC_QUOTA_ERROR.test(words), words).to.equal(true);
    }
  });

  it("leaves the write confirmation's view of a 429 alone", () => {
    noteRpcQuotaSpent();
    // A confirmation poll still treats every 429 as transient, spent plan or not.
    expect(isTransientRpcError(new Error("HTTP error! status: 429"))).to.equal(true);
    expect(isTransientRpcError(new Error("429 max usage reached"))).to.equal(true);
  });

  it("leaves methods outside the read list alone", async () => {
    const rpc = flaky(0);
    await withTransientReadRetries(rpc, 4, 1)
      .getBalance()
      .catch(() => undefined);
    expect(rpc.calls).to.equal(1);
  });
});
