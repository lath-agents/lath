/**
 * The treasury lock and what a restart settles first.
 *
 * Node-only, network-free: the lock and the ledger are files in a throwaway `LATH_TRACE_DIR`,
 * the "other process" is a pid and a liveness answer the test supplies, and every close goes
 * through the recovery hooks. No real treasury key exists here and no channel is opened: the loop-key
 * cases set a throwaway one so `treasuryAccount()` answers, build transports they never call, and
 * hand every close a fake `close` and `escrow`.
 */
import { traceDir } from "./fixtures/trace-dir";
import * as fs from "fs";
import * as path from "path";
import { assert } from "chai";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logSearchRanges } from "@lath/sdk";
import { MppOpenRouterTransport, type ChatRequest, type MppChannelRecovery, type MppSession } from "@lath/runtime";
import {
  ChannelClosePlan,
  LOCK_STALE_MS,
  OpenChannelRow,
  PooledTempoTransport,
  TEMPO_RPC_TIMEOUT_MS,
  TempoSigningAccount,
  TreasuryHeldError,
  accessKeyOf,
  claimTreasury,
  closeChannelById,
  forgetOpenChannel,
  ZERO_READ_TRUST_AGE_MS,
  httpRpc,
  openChannelCount,
  openChannelLedger,
  openTempoChannel,
  readChannelLedger,
  readTreasuryLock,
  recoverOpenChannels,
  recoveryFromChain,
  releaseTreasuryForTests,
  rememberOpenChannel,
  setKeyAccountFor,
  setKeyedCloseListener,
  usdcBalance,
  type JsonRpc,
  type KeyedChannelClosed,
} from "../frontend/src/app/api/_lib/tempo";

const PAYER = "0x18fB0000000000000000000000000000000000B0";
const row = (channelId: string, loopId?: string): OpenChannelRow => ({
  agentId: "ab".repeat(32),
  channelId,
  payer: PAYER,
  openedAt: Date.now(),
  ...(loopId ? { loopId } : {}),
});

function clear(): void {
  releaseTreasuryForTests();
  fs.rmSync(path.join(traceDir, "tempo-channels.json"), { force: true });
}

describe("the treasury lock", () => {
  beforeEach(clear);
  after(clear);

  it("is claimed by the first process and refused to a second live one, with the holder in the reason", () => {
    const first = claimTreasury({ pid: 1001, now: 1_000_000, alive: () => true });
    assert.deepEqual(readTreasuryLock(), first);
    assert.equal(first.pid, 1001);

    let thrown: unknown;
    try {
      claimTreasury({ pid: 1002, now: 1_005_000, alive: () => true });
    } catch (e) {
      thrown = e;
    }
    assert.instanceOf(thrown, TreasuryHeldError);
    assert.equal((thrown as TreasuryHeldError).holder.pid, 1001);
    assert.match((thrown as TreasuryHeldError).message, /pid 1001/);
    assert.match((thrown as TreasuryHeldError).message, /two processes on one treasury are refused/);
    // The refusal changed nothing on disk: the holder still holds it.
    assert.equal(readTreasuryLock()!.pid, 1001);
  });

  it("is refreshed, not refused, when the same process claims again", () => {
    const first = claimTreasury({ pid: 1001, now: 1_000_000, alive: () => true });
    const again = claimTreasury({ pid: 1001, now: 1_020_000, alive: () => true });
    assert.equal(again.startedAt, first.startedAt, "the claim keeps its start");
    assert.equal(again.heartbeatAt, 1_020_000);
  });

  it("is taken over when the holder is dead, or its heartbeat is stale", () => {
    claimTreasury({ pid: 1001, now: 1_000_000, alive: () => true });
    // A pid that is gone: the crash a restart recovers from.
    const taken = claimTreasury({ pid: 1002, now: 1_001_000, alive: (pid) => pid !== 1001 });
    assert.equal(taken.pid, 1002);
    assert.equal(taken.startedAt, 1_001_000, "a takeover is a new claim, not a continuation");

    // A pid that answers but has not written a heartbeat in three intervals: a wedged process.
    const stale = claimTreasury({ pid: 1003, now: 1_001_000 + LOCK_STALE_MS, alive: () => true });
    assert.equal(stale.pid, 1003);
    assert.equal(readTreasuryLock()!.pid, 1003);
  });

  it("reads a garbage lock file as no lock at all", () => {
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(path.join(traceDir, "tempo-channels.lock"), "not json");
    assert.isNull(readTreasuryLock());
    assert.equal(claimTreasury({ pid: 7, now: 1, alive: () => true }).pid, 7);
  });
});

describe("what a restart settles before it opens a channel", () => {
  beforeEach(clear);
  after(clear);

  it("closes every chat row through the treasury and hands every loop row to its loop", async () => {
    rememberOpenChannel(row("0xchat-1"));
    rememberOpenChannel(row("0xloop-1", "loop-a"));
    rememberOpenChannel(row("0xchat-2"));
    const closed: string[] = [];
    const loops: string[] = [];
    const report = await recoverOpenChannels({
      closeById: async (channelId, payer) => {
        assert.equal(payer, PAYER);
        closed.push(channelId);
      },
      settleLoop: async (loopId, r) => {
        loops.push(`${loopId}:${r.channelId}`);
        // The loop's own settle prunes its row, the way `settleLoopChannel` does through
        // `closeChannelById`; the recovery does not do it for the loop.
        forgetOpenChannel(r.channelId);
      },
    });
    assert.deepEqual(closed, ["0xchat-1", "0xchat-2"]);
    assert.deepEqual(loops, ["loop-a:0xloop-1"]);
    assert.deepEqual(report, { settled: ["0xchat-1", "0xchat-2"], loops: ["0xloop-1"], failed: [] });
    assert.deepEqual(openChannelLedger(), [], "every row settled left the ledger");
  });

  // A console killed early in a loop's first step can write the ledger row and die before the
  // `channel` field reaches the loop record, so the loop's settler finds nothing to settle and
  // returns without pruning. Counted as handled anyway, the row would let the resumed loop open a
  // second channel while the first still held its deposit.
  it("closes a loop row its own settler could not settle, rather than counting it as handled", async () => {
    rememberOpenChannel(row("0xloop-orphan", "loop-a"));
    const closed: string[] = [];
    const report = await recoverOpenChannels({
      closeById: async (channelId) => {
        closed.push(channelId);
      },
      // The loop record has no channel of its own, so this settles nothing and leaves the row.
      settleLoop: async () => undefined,
    });
    assert.deepEqual(closed, ["0xloop-orphan"], "the treasury closed what the loop could not");
    assert.deepEqual(report, { settled: ["0xloop-orphan"], loops: [], failed: [] });
    assert.deepEqual(openChannelLedger(), [], "no row survives a recovery pass that reported none failed");
  });

  it("leaves a loop row alone when no loop settler is given, for that loop's own scheduler", async () => {
    rememberOpenChannel(row("0xloop-1", "loop-a"));
    const report = await recoverOpenChannels({ closeById: async () => assert.fail("a loop row is not closed here") });
    assert.deepEqual(report, { settled: [], loops: [], failed: [] });
    assert.equal(openChannelLedger().length, 1);
  });

  it("keeps a row whose close failed, and reports it rather than throwing", async () => {
    rememberOpenChannel(row("0xchat-bad"));
    rememberOpenChannel(row("0xchat-ok"));
    const report = await recoverOpenChannels({
      closeById: async (channelId) => {
        if (channelId === "0xchat-bad") throw new Error("gateway 502");
      },
    });
    assert.deepEqual(report.settled, ["0xchat-ok"]);
    assert.deepEqual(report.failed, [{ channelId: "0xchat-bad", error: "gateway 502" }]);
    assert.deepEqual(
      openChannelLedger().map((r) => r.channelId),
      ["0xchat-bad"],
      "the failed row stays for the next restart"
    );
  });

  it("runs once per process: a second caller awaits the first pass and settles nothing twice", async () => {
    rememberOpenChannel(row("0xchat-1"));
    let closes = 0;
    const hooks = {
      closeById: async () => {
        closes++;
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    const [a, b] = await Promise.all([recoverOpenChannels(hooks), recoverOpenChannels(hooks)]);
    assert.strictEqual(a, b);
    assert.equal(closes, 1);
    // A row remembered after the pass is a live channel of this process, not a leftover.
    rememberOpenChannel(row("0xchat-live"));
    await recoverOpenChannels(hooks);
    assert.equal(closes, 1);
  });
});

// A ledger read that answered `[]` to any failure, followed by a plain `writeFileSync` over the
// file, would turn one failed read (`EMFILE`) or one torn file (a kill or `ENOSPC` mid-write) into
// a ledger holding only the next voucher's row, every other channel's deposit left in escrow with
// no row naming it.
describe("a ledger that cannot be read is left as it is, not written over", () => {
  const LEDGER = path.join(traceDir, "tempo-channels.json");
  const LOCK = path.join(traceDir, "tempo-channels.lock");
  beforeEach(clear);
  afterEach(() => {
    // A case that turned the ledger into a directory, to make every read fail, puts it back.
    if (fs.existsSync(LEDGER) && fs.statSync(LEDGER).isDirectory()) fs.rmSync(LEDGER, { recursive: true });
  });
  after(clear);
  /** Runs `fn` with `console.warn` captured, and answers what it said. */
  const warned = (fn: () => void): string[] => {
    const lines: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      fn();
    } finally {
      console.warn = real;
    }
    return lines;
  };

  it("keeps a torn ledger's bytes when the next voucher and the next close arrive", () => {
    rememberOpenChannel(row("0xA"));
    rememberOpenChannel(row("0xB"));
    rememberOpenChannel(row("0xC"));
    const whole = fs.readFileSync(LEDGER, "utf8");
    // What a kill mid-write of a plain write leaves: the first half of the file.
    const torn = whole.slice(0, Math.floor(whole.length / 2));
    fs.writeFileSync(LEDGER, torn);

    assert.throws(() => readChannelLedger(), /not JSON/, "a torn ledger is not an empty one");
    assert.deepEqual(openChannelLedger(), [], "the display read still answers, with nothing");
    const lines = warned(() => {
      rememberOpenChannel(row("0xD"));
      forgetOpenChannel("0xA");
    });
    assert.equal(fs.readFileSync(LEDGER, "utf8"), torn, "neither write replaced the file");
    assert.lengthOf(lines, 2);
    assert.match(lines[0], /0xD's row was skipped/);
    assert.match(lines[1], /removal of channel 0xA's row was skipped/);

    // Repaired by hand, every row is still there, and the ledger takes writes again.
    fs.writeFileSync(LEDGER, whole);
    rememberOpenChannel(row("0xD"));
    assert.deepEqual(
      readChannelLedger().map((r) => r.channelId),
      ["0xA", "0xB", "0xC", "0xD"]
    );
  });

  it("writes nothing when the read fails for any reason but a missing file", () => {
    // A directory at the ledger's path: every read fails with EISDIR, as one under EMFILE or EIO does.
    fs.mkdirSync(LEDGER, { recursive: true });
    assert.throws(() => readChannelLedger(), /EISDIR|illegal operation/);
    const lines = warned(() => rememberOpenChannel(row("0xE")));
    assert.isTrue(fs.statSync(LEDGER).isDirectory(), "left as it was");
    assert.lengthOf(lines, 1);
    // And a missing file is the one empty ledger.
    fs.rmSync(LEDGER, { recursive: true });
    assert.deepEqual(readChannelLedger(), []);
    rememberOpenChannel(row("0xE"));
    assert.deepEqual(
      readChannelLedger().map((r) => r.channelId),
      ["0xE"]
    );
  });

  it("writes the ledger and the lock beside the file and renames them in, readable by this user only", () => {
    rememberOpenChannel(row("0xF"));
    claimTreasury({ pid: 4242, now: 1, alive: () => true });
    for (const file of [LEDGER, LOCK]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${path.basename(file)} is 0600`);
    }
    const strays = fs.readdirSync(traceDir).filter((f) => f.startsWith("tempo-channels") && f.endsWith(".tmp"));
    assert.deepEqual(strays, [], "no temp file is left behind");
    assert.equal(readTreasuryLock()!.pid, 4242);
  });

  it("settles nothing from a ledger it cannot read, and reads it again on the next pass", async () => {
    rememberOpenChannel(row("0xchat-1"));
    const whole = fs.readFileSync(LEDGER, "utf8");
    fs.writeFileSync(LEDGER, whole.slice(0, 10));
    const closed: string[] = [];
    const hooks = {
      closeById: async (channelId: string) => {
        closed.push(channelId);
        forgetOpenChannel(channelId);
      },
    };
    let first!: Awaited<ReturnType<typeof recoverOpenChannels>>;
    const lines: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      first = await recoverOpenChannels(hooks);
    } finally {
      console.warn = real;
    }
    assert.deepEqual(first, { settled: [], loops: [], failed: [] });
    assert.match(lines.join("\n"), /recovery could not read the open-channel ledger/);
    assert.deepEqual(closed, []);

    // The descriptor came back: the next open's pass reads the ledger and settles the row, instead
    // of answering with the empty pass for the life of the process.
    fs.writeFileSync(LEDGER, whole);
    const second = await recoverOpenChannels(hooks);
    assert.deepEqual(second.settled, ["0xchat-1"]);
    assert.deepEqual(closed, ["0xchat-1"]);
    assert.deepEqual(readChannelLedger(), []);
  });

  it("keeps a loop's row, reported failed, when the ledger cannot be read after the loop's settle", async () => {
    rememberOpenChannel(row("0xloop-1", "loop-a"));
    const whole = fs.readFileSync(LEDGER, "utf8");
    const report = await recoverOpenChannels({
      closeById: async () => assert.fail("not closed on a ledger nobody could read"),
      // The loop's settle runs, and the ledger tears under it.
      settleLoop: async () => fs.writeFileSync(LEDGER, whole.slice(0, 7)),
    });
    assert.deepEqual(report.settled, []);
    assert.deepEqual(report.loops, [], "not counted as handed to its loop either");
    assert.deepEqual(
      report.failed.map((f) => f.channelId),
      ["0xloop-1"]
    );
    assert.equal(fs.readFileSync(LEDGER, "utf8"), whole.slice(0, 7));
  });
});

// A `closeChannelById` that built a fresh session manager and called `close()` on it would close
// that manager's *active* channel — none — answer `undefined`, touch no chain, and prune the row.
// These pin the two halves of the rule: the close is made against what the row carries, and a
// close that proves nothing leaves the row.
describe("closing a channel by its row", () => {
  beforeEach(clear);
  after(clear);

  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  /** The escrow as it reads while a deposit is committed. */
  const escrow = async () => ({ settled: BigInt(1500), deposit: BigInt(50750), closeRequestedAt: 0 });
  const recovery: MppChannelRecovery = {
    channelId: "0xrow-1",
    chainId: 4217,
    escrow: "0x4d50500000000000000000000000000000000000",
    descriptor: {
      payer: account.address,
      payee: "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe",
      operator: "0x0000000000000000000000000000000000000000",
      token: "0x20c000000000000000000000b9537d11c60e8b50",
      salt: `0x${"ab".repeat(32)}`,
      authorizedSigner: account.address,
      expiringNonceHash: `0x${"cd".repeat(32)}`,
    },
    deposit: "50750",
    cumulative: "1500",
    spent: "1500",
    endpoint: "https://openrouter.mpp.tempo.xyz/v1/chat/completions",
    opened: true,
  };

  it("closes the channel the row names, with the row's descriptor, and prunes the row only on a receipt", async () => {
    rememberOpenChannel({ ...row("0xrow-1"), payer: account.address, recovery });
    const plans: ChannelClosePlan[] = [];

    // No receipt: nothing is known to have settled, so the row stays and the caller is told.
    let thrown: unknown;
    try {
      await closeChannelById("0xrow-1", account.address, {
        account,
        escrow,
        close: async (plan) => {
          plans.push(plan);
          return undefined;
        },
      });
    } catch (e) {
      thrown = e;
    }
    assert.match(String((thrown as Error)?.message), /no receipt/);
    assert.equal(openChannelLedger().length, 1, "a close without a receipt keeps its row");

    // A receipt: the row goes, and the plan was for this channel's own descriptor.
    const receipt = await closeChannelById("0xrow-1", account.address, {
      account,
      escrow,
      close: async (plan) => {
        plans.push(plan);
        return { txHash: "0xsettled", spent: BigInt(1500) };
      },
    });
    assert.deepEqual(receipt, { txHash: "0xsettled", spent: "1500" });
    assert.deepEqual(openChannelLedger(), []);
    assert.equal(plans.length, 2);
    for (const plan of plans) {
      assert.equal(plan.source, "ledger");
      assert.equal(plan.channelId, "0xrow-1");
      assert.deepEqual(plan.recovery.descriptor, recovery.descriptor);
      assert.equal(plan.recovery.cumulative, "1500");
    }
  });

  it("reads a legacy row's descriptor off the chain, and keeps a row it cannot close rather than guessing", async () => {
    // An older row: an id, a payer, no descriptor.
    rememberOpenChannel({ ...row("0xlegacy"), payer: account.address });
    let thrown: unknown;
    try {
      await closeChannelById("0xlegacy", account.address, {
        account,
        escrow,
        fromChain: async () => undefined,
        close: async () => assert.fail("nothing to close with"),
      });
    } catch (e) {
      thrown = e;
    }
    assert.match(String((thrown as Error)?.message), /cannot be closed/);
    assert.equal(openChannelLedger().length, 1, "the row that cannot be closed is kept, and says so");

    const plans: ChannelClosePlan[] = [];
    await closeChannelById("0xlegacy", account.address, {
      account,
      escrow,
      fromChain: async (channelId) => ({ ...recovery, channelId }),
      close: async (plan) => {
        plans.push(plan);
        return { txHash: "0xfrom-chain" };
      },
    });
    assert.equal(plans[0].source, "chain");
    assert.equal(plans[0].recovery.descriptor.salt, recovery.descriptor.salt);
    assert.deepEqual(openChannelLedger(), []);
  });

  // `undefined` from the log scan is the claim that the escrow has no ChannelOpened log for the id.
  // A timeout or a 429 is no such claim, and must not be reported as one; a window the RPC refuses
  // as wider than it serves is the one failure the scan moves past.
  it("throws a log read that failed, rather than reporting the channel has no ChannelOpened log", async () => {
    const asked: string[] = [];
    const rpc: JsonRpc = async (method) => {
      asked.push(method);
      if (method === "eth_blockNumber") return "0x1000000";
      if (method === "eth_getLogs") throw new Error("eth_getLogs failed (429)");
      return assert.fail(`no ${method} after a failed log read`);
    };
    const thrown = await recoveryFromChain("0x" + "11".repeat(32), PAYER, rpc).catch((e: Error) => e);
    assert.instanceOf(thrown, Error);
    assert.match((thrown as Error).message, /429/);
    assert.deepEqual(asked, ["eth_blockNumber", "eth_getLogs"], "no wider window is tried after a failed read");
  });

  it("moves past a window the RPC refuses as too wide, and finds nothing when none holds the log", async () => {
    const windows: string[] = [];
    const rpc: JsonRpc = async (method, params) => {
      if (method === "eth_blockNumber") return "0x1000000";
      if (method !== "eth_getLogs") return assert.fail(`no ${method} when no log was found`);
      windows.push((params[0] as { fromBlock: string }).fromBlock);
      if (windows.length === 1) return [];
      throw new Error("eth_getLogs: query exceeds max block range 100000");
    };
    assert.isUndefined(await recoveryFromChain("0x" + "11".repeat(32), PAYER, rpc));
    assert.lengthOf(
      windows,
      logSearchRanges(BigInt("0x1000000")).length,
      "every range is asked, the refused ones included"
    );
  });

  // rpc.tempo.xyz refuses any range over 100 000 blocks, so windows of 500 000 or 5 000 000 blocks
  // from the head would never recover a row older than ~7.5 h; the search stays under the cap.
  // The escrow's `ChannelOpened`, as `recoveryFromChain` decodes it (`CHANNEL_OPENED` in `_lib/tempo.ts`).
  const openedLogFor = (payer: string) => {
    const abi = [
      {
        type: "event",
        name: "ChannelOpened",
        inputs: [
          { name: "channelId", type: "bytes32", indexed: true },
          { name: "payer", type: "address", indexed: true },
          { name: "payee", type: "address", indexed: true },
          { name: "operator", type: "address", indexed: false },
          { name: "token", type: "address", indexed: false },
          { name: "authorizedSigner", type: "address", indexed: false },
          { name: "salt", type: "bytes32", indexed: false },
          { name: "expiringNonceHash", type: "bytes32", indexed: false },
          { name: "deposit", type: "uint96", indexed: false },
        ],
      },
    ] as const;
    const zero = "0x0000000000000000000000000000000000000000" as const;
    return {
      topics: encodeEventTopics({
        abi,
        eventName: "ChannelOpened",
        args: { channelId: `0x${"11".repeat(32)}`, payer: payer as `0x${string}`, payee: zero },
      }),
      data: encodeAbiParameters(
        abi[0].inputs.filter((i) => !i.indexed),
        [zero, zero, zero, `0x${"22".repeat(32)}`, `0x${"33".repeat(32)}`, BigInt(2500)]
      ),
    };
  };
  // `getChannelState`'s answer: settled, deposit, closeRequestedAt.
  const escrowStateWord = () =>
    encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "uint96" }, { type: "uint96" }, { type: "uint32" }] }],
      [[BigInt(100), BigInt(2500), 0]]
    );

  it("finds the ChannelOpened log of a row opened 200 000 blocks back, under the RPC's range cap", async () => {
    const head = BigInt("0x1000000");
    const opened = head - BigInt(200_000);
    const asked: [bigint, bigint][] = [];
    const rpc: JsonRpc = async (method, params) => {
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      if (method === "eth_getLogs") {
        const f = params[0] as { fromBlock: string; toBlock: string };
        const range: [bigint, bigint] = [BigInt(f.fromBlock), BigInt(f.toBlock)];
        asked.push(range);
        if (range[1] - range[0] > BigInt(100_000)) throw new Error("query exceeds max block range 100000");
        return range[0] <= opened && opened <= range[1] ? [openedLogFor(PAYER)] : [];
      }
      if (method === "eth_call") return escrowStateWord();
      return assert.fail(`no ${method}`);
    };
    const recovered = await recoveryFromChain("0x" + "11".repeat(32), PAYER, rpc);
    assert.isDefined(recovered, "found, three ranges back");
    assert.lengthOf(asked, 3);
  });

  // A console killed between mppx signing the open and the gateway submitting it leaves a row
  // for a channel the escrow has never seen.
  it("drops a row whose channel the escrow holds nothing under, without posting a close", async () => {
    rememberOpenChannel({ ...row("0xnever-opened"), payer: account.address, recovery });
    const receipt = await closeChannelById("0xnever-opened", account.address, {
      account,
      now: Date.now() + ZERO_READ_TRUST_AGE_MS,
      escrow: async () => ({ settled: BigInt(0), deposit: BigInt(0), closeRequestedAt: 0 }),
      close: async () => assert.fail("nothing is held, so nothing is closed"),
    });
    assert.deepEqual(receipt, {}, "no transaction, because none was made");
    assert.deepEqual(openChannelLedger(), [], "the row is gone rather than failing every restart");
  });

  // A node a block behind the open reads zeros for a channel that holds a deposit.
  it("keeps a young row whose channel reads zeros, and says the close is to be tried again", async () => {
    rememberOpenChannel({ ...row("0xjust-opened"), payer: account.address, recovery });
    const err = await closeChannelById("0xjust-opened", account.address, {
      account,
      escrow: async () => ({ settled: BigInt(0), deposit: BigInt(0), closeRequestedAt: 0 }),
      close: async () => assert.fail("nothing is closed on a read that may be behind"),
    }).catch((e: Error) => e);
    assert.instanceOf(err, Error);
    assert.match((err as Error).message, /tried again later/);
    assert.deepEqual(
      openChannelLedger().map((r) => r.channelId),
      ["0xjust-opened"]
    );
    forgetOpenChannel("0xjust-opened");
  });

  it("merges a later write over the row rather than replacing it, so a write that knows less keeps the descriptor", () => {
    rememberOpenChannel({ ...row("0xrow-2"), openedAt: 5, recovery });
    rememberOpenChannel({ ...row("0xrow-2"), openedAt: 9 });
    const [r] = openChannelLedger();
    assert.equal(r.openedAt, 5, "the first write's openedAt is the channel's");
    assert.deepEqual(r.recovery, recovery);
  });
});

// A loop's channel is signed by its own access key, rooted on the treasury (docs/ARCHITECTURE.md
// §7.3). The row names that key as `signer` (and `payer` stays the treasury); a close of such a row
// is signed by the key the `keyAccountFor` hook hands back, and a row whose key is gone is kept with
// one `tempo-key-missing` line naming the force-close. A row without `signer` is a treasury
// channel's, and the cases above pin that it closes exactly as it does.
describe("a loop key's channel: its row, and its close", () => {
  const TREASURY_PK = `0x${"11".repeat(32)}` as const;
  const treasury = privateKeyToAccount(TREASURY_PK);
  const KEY = "0x00000000000000000000000000000000000Ac0e5";
  const OTHER_KEY = "0x0000000000000000000000000000000000000BAd";
  /** An access-key account as `viem/tempo` builds one: the root's address, the key beside it. */
  const keyAccount = (accessKeyAddress: string = KEY): TempoSigningAccount => ({
    address: treasury.address,
    accessKeyAddress: accessKeyAddress as `0x${string}`,
  });
  const escrow = async () => ({ settled: BigInt(1500), deposit: BigInt(50750), closeRequestedAt: 0 });
  const recoveryOf = (channelId: string, authorizedSigner: string): MppChannelRecovery => ({
    channelId,
    chainId: 4217,
    escrow: "0x4d50500000000000000000000000000000000000",
    descriptor: {
      payer: treasury.address,
      payee: "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe",
      operator: "0x0000000000000000000000000000000000000000",
      token: "0x20c000000000000000000000b9537d11c60e8b50",
      salt: `0x${"ab".repeat(32)}`,
      authorizedSigner,
      expiringNonceHash: `0x${"cd".repeat(32)}`,
    },
    deposit: "50750",
    cumulative: "1500",
    spent: "1500",
    endpoint: "https://openrouter.mpp.tempo.xyz/v1/chat/completions",
    opened: true,
  });
  const keyedRow = (channelId: string, loopId = "loop-k"): OpenChannelRow => ({
    ...row(channelId, loopId),
    payer: treasury.address,
    signer: KEY,
    recovery: recoveryOf(channelId, KEY),
  });
  const noClose = async (): Promise<undefined> => assert.fail("no key, so no close is posted");

  /** Every console line printed while `fn` runs, so a case can count the `tempo-key-missing` ones. */
  async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const lines: string[] = [];
    const { log, warn } = console;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      return { result: await fn(), lines };
    } finally {
      console.log = log;
      console.warn = warn;
    }
  }

  let savedTreasury: string | undefined;
  before(() => {
    savedTreasury = process.env.LATH_TEMPO_TREASURY;
    // The module reads the treasury once and keeps it, so this is set before the first case asks.
    process.env.LATH_TEMPO_TREASURY = TREASURY_PK;
  });
  beforeEach(clear);
  afterEach(() => {
    setKeyAccountFor(undefined);
    setKeyedCloseListener(undefined);
  });
  after(() => {
    clear();
    if (savedTreasury === undefined) delete process.env.LATH_TEMPO_TREASURY;
    else process.env.LATH_TEMPO_TREASURY = savedTreasury;
  });

  it("closes a row with a signer through the hook's account, and a row without one through the treasury", async () => {
    const asked: OpenChannelRow[] = [];
    const key = keyAccount();
    setKeyAccountFor(async (r) => {
      asked.push(r);
      return key;
    });
    rememberOpenChannel(keyedRow("0xkeyed-1"));
    rememberOpenChannel({
      ...row("0xtreasury-1"),
      payer: treasury.address,
      recovery: recoveryOf("0xtreasury-1", treasury.address),
    });
    const plans: ChannelClosePlan[] = [];
    const close = async (plan: ChannelClosePlan) => {
      plans.push(plan);
      return { txHash: `0xclosed-${plan.channelId}` };
    };

    await closeChannelById("0xkeyed-1", treasury.address, { escrow, close });
    assert.strictEqual(plans[0].account, key, "the close is signed by the loop's key");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].loopId, "loop-k", "the hook is asked with the row, which names its loop");
    assert.equal(asked[0].signer, KEY);

    await closeChannelById("0xtreasury-1", treasury.address, { escrow, close });
    assert.equal(asked.length, 1, "a row without a signer never asks the hook");
    assert.equal(plans[1].account.address, treasury.address, "and closes with the treasury, as before the keys");
    assert.isUndefined(accessKeyOf(plans[1].account));
    assert.deepEqual(openChannelLedger(), []);
  });

  // The loop's reconcile hands a channel's refund back to its key only for a settle it can show,
  // and a close by id (the restart's recovery pass) happens outside the loop's own settle.
  it("tells the loop of a keyed channel it closed by id, with the escrow's deposit and the close's amount", async () => {
    const told: KeyedChannelClosed[] = [];
    setKeyedCloseListener((c) => told.push(c));
    setKeyAccountFor(async () => keyAccount());
    rememberOpenChannel(keyedRow("0xkeyed-told"));
    rememberOpenChannel({
      ...row("0xtreasury-untold", "loop-t"),
      payer: treasury.address,
      recovery: recoveryOf("0xtreasury-untold", treasury.address),
    });
    // A gateway whose receipt says less than the key signed (the row's cumulative, 1500).
    const close = async (plan: ChannelClosePlan) => ({ txHash: `0xclosed-${plan.channelId}`, spent: BigInt(900) });

    const keyed = await closeChannelById("0xkeyed-told", treasury.address, { escrow, close });
    assert.deepEqual(told, [
      { loopId: "loop-k", channelId: "0xkeyed-told", deposit: "50750", spent: "900", signed: "1500" },
    ]);
    const plain = await closeChannelById("0xtreasury-untold", treasury.address, { escrow, close });
    assert.lengthOf(told, 1, "a treasury-signed row, loop or not, tells nobody");
    // And the receipt each caller gets is the shape it always was.
    assert.deepEqual(keyed, { txHash: "0xclosed-0xkeyed-told", spent: "900" });
    assert.deepEqual(plain, { txHash: "0xclosed-0xtreasury-untold", spent: "900" });
  });

  it("keeps a row whose key the hook cannot load, and says tempo-key-missing once across two recovery passes", async () => {
    let asks = 0;
    setKeyAccountFor(async () => {
      asks++;
      return null;
    });
    rememberOpenChannel(keyedRow("0xkey-gone"));
    const hooks = {
      // The loop's own settle finds nothing to settle (the killed-first-step shape), so the pass closes the row.
      settleLoop: async () => undefined,
      closeById: (channelId: string, payer: string) => closeChannelById(channelId, payer, { escrow, close: noClose }),
    };
    const first = await captured(() => recoverOpenChannels(hooks));
    // A second pass, as a later recovery would make it, in the same process.
    releaseTreasuryForTests();
    const second = await captured(() => recoverOpenChannels(hooks));

    for (const { result } of [first, second]) {
      assert.deepEqual(result.settled, [], "a kept row is never reported settled");
      assert.deepEqual(
        result.failed.map((f) => f.channelId),
        ["0xkey-gone"]
      );
    }
    assert.equal(asks, 2, "each pass asks again, so a key restored between passes is used");
    const missing = [...first.lines, ...second.lines].filter((l) => l.includes("tempo-key-missing"));
    assert.lengthOf(missing, 1, "one line per channel per process");
    assert.include(missing[0], "0xkey-gone");
    assert.include(missing[0], "requestClose");
    assert.include(missing[0], "withdraw");
    assert.include(missing[0], "scripts/tempo-access-key-probe.ts --root-treasury --case p4 --channel 0xkey-gone");
    assert.deepEqual(
      openChannelLedger().map((r) => r.channelId),
      ["0xkey-gone"],
      "the row stays for the force-close"
    );
  });

  it("keeps a keyed row when no hook is installed at all, and when the hook throws", async () => {
    rememberOpenChannel(keyedRow("0xno-hook"));
    const noHook = await captured(() =>
      closeChannelById("0xno-hook", treasury.address, { escrow, close: noClose }).catch((e: Error) => e)
    );
    assert.instanceOf(noHook.result, Error);
    assert.match((noHook.result as Error).message, /row is kept/);
    assert.isTrue(noHook.lines.some((l) => l.includes("tempo-key-missing") && l.includes("no key hook")));

    setKeyAccountFor(async () => {
      throw new Error("EACCES on the key file");
    });
    rememberOpenChannel(keyedRow("0xhook-throws"));
    const thrown = await captured(() =>
      closeChannelById("0xhook-throws", treasury.address, { escrow, close: noClose }).catch((e: Error) => e)
    );
    assert.instanceOf(thrown.result, Error);
    assert.isTrue(thrown.lines.some((l) => l.includes("tempo-key-missing") && l.includes("EACCES")));
    assert.lengthOf(openChannelLedger(), 2, "both rows are kept");
  });

  it("refuses a hook account for another key, and keeps the row", async () => {
    setKeyAccountFor(async () => keyAccount(OTHER_KEY));
    rememberOpenChannel(keyedRow("0xwrong-key"));
    let thrown: unknown;
    try {
      await closeChannelById("0xwrong-key", treasury.address, { escrow, close: noClose });
    } catch (e) {
      thrown = e;
    }
    assert.match(String((thrown as Error)?.message), /refused/);
    assert.include(String((thrown as Error)?.message), OTHER_KEY);
    assert.lengthOf(openChannelLedger(), 1);
  });

  it("treats a legacy row whose chain descriptor names another signer as keyed, by its loop or not at all", async () => {
    const key = keyAccount();
    const asked: OpenChannelRow[] = [];
    setKeyAccountFor(async (r) => {
      asked.push(r);
      return key;
    });
    const fromChain = async (channelId: string) => recoveryOf(channelId, KEY);
    const plans: ChannelClosePlan[] = [];
    const close = async (plan: ChannelClosePlan) => {
      plans.push(plan);
      return { txHash: "0xclosed" };
    };

    // A row with no descriptor and no `signer`, but its loop: the chain names the key, the loop finds it.
    rememberOpenChannel({ ...row("0xlegacy-keyed", "loop-k"), payer: treasury.address });
    await closeChannelById("0xlegacy-keyed", treasury.address, { escrow, fromChain, close });
    assert.equal(plans[0].source, "chain");
    assert.strictEqual(plans[0].account, key);
    assert.equal(asked[0].signer, KEY);
    assert.equal(asked[0].loopId, "loop-k");

    // No row and no loop: nothing to find the key by, so the hook is not asked and nothing is posted.
    const kept = await captured(() =>
      closeChannelById("0xlegacy-orphan", treasury.address, { escrow, fromChain, close }).catch((e: Error) => e)
    );
    assert.instanceOf(kept.result, Error);
    assert.equal(asked.length, 1);
    assert.equal(plans.length, 1);
    assert.isTrue(kept.lines.some((l) => l.includes("tempo-key-missing") && l.includes("0xlegacy-orphan")));

    // The caller's loop is enough when the ledger has no row.
    await closeChannelById("0xlegacy-by-loop", treasury.address, { escrow, fromChain, close, loopId: "loop-k" });
    assert.equal(asked[1].loopId, "loop-k");
    assert.strictEqual(plans[1].account, key);
  });

  /** A balance read that answers `held` base units, so `tempoCanCover` passes without a network. */
  const rpcHolding = (held: bigint) => async (method: string) => {
    if (method === "eth_call") return `0x${held.toString(16).padStart(64, "0")}`;
    throw new Error(`no ${method} in this suite`);
  };
  const ledgerJson = (): Record<string, unknown>[] =>
    JSON.parse(fs.readFileSync(path.join(traceDir, "tempo-channels.json"), "utf8"));
  /** Fires the transport's `onChannel` the way mppx's first store write does, without opening anything. */
  const announce = (channel: unknown, recovery: MppChannelRecovery) => (channel as any).inner.opts.onChannel(recovery);

  it("opens with an access key: the row names the key as signer, the treasury as payer, and the open block", async () => {
    const key = keyAccount();
    const opened = await openTempoChannel({
      maxDepositBase: BigInt(1000),
      topUpBase: BigInt(500),
      agentId: "cd".repeat(32),
      loopId: "loop-k",
      rpc: rpcHolding(BigInt(5000)),
      account: key,
    });
    assert.property(opened, "channel");
    const channel = (opened as { channel: { payer: string } }).channel;
    assert.equal(channel.payer, treasury.address, "every record this transport writes names the treasury");
    assert.strictEqual((channel as any).inner.opts.account, key, "and the key signs");
    announce(channel, { ...recoveryOf("0xopened-keyed", KEY), openBlock: "1234567" });
    const [r] = ledgerJson();
    assert.equal(r.payer, treasury.address);
    assert.equal(r.signer, KEY);
    assert.equal(r.loopId, "loop-k");
    assert.equal(r.openBlock, "1234567");
  });

  it("opens with the treasury exactly as before: no signer key on the serialized row at all", async () => {
    const opened = await openTempoChannel({
      maxDepositBase: BigInt(1000),
      topUpBase: BigInt(500),
      agentId: "cd".repeat(32),
      loopId: "loop-t",
      rpc: rpcHolding(BigInt(5000)),
    });
    const channel = (opened as { channel: unknown }).channel;
    assert.equal((channel as any).inner.opts.account.address, treasury.address);
    assert.isUndefined(accessKeyOf((channel as any).inner.opts.account));
    announce(channel, recoveryOf("0xopened-treasury", treasury.address));
    const [r] = ledgerJson();
    assert.notProperty(r, "signer", "absent, not undefined-valued");
    assert.notProperty(r, "openBlock");
    assert.deepEqual(Object.keys(r), ["agentId", "channelId", "payer", "openedAt", "loopId", "recovery"]);
    assert.equal(r.payer, treasury.address);
  });

  it("refuses an account rooted anywhere but the treasury, before it opens anything", async () => {
    const elsewhere: TempoSigningAccount = {
      address: "0x000000000000000000000000000000000000E15e",
      accessKeyAddress: KEY as `0x${string}`,
    };
    let thrown: unknown;
    try {
      await openTempoChannel({
        maxDepositBase: BigInt(1000),
        topUpBase: BigInt(500),
        rpc: rpcHolding(BigInt(5000)),
        account: elsewhere,
      });
    } catch (e) {
      thrown = e;
    }
    assert.match(String((thrown as Error)?.message), /refused/);
    assert.deepEqual(openChannelLedger(), []);
  });
});

describe("the treasury's public balance read, and every Tempo read's deadline", () => {
  const TREASURY_PK = `0x${"11".repeat(32)}` as const;
  const BALANCE = BigInt(123_456_789);
  let savedTreasury: string | undefined;
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  /** A route's JSON body, untyped the way the panel reads it. */
  const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
  before(() => {
    savedTreasury = process.env.LATH_TEMPO_TREASURY;
    process.env.LATH_TEMPO_TREASURY = TREASURY_PK;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  });
  after(() => {
    if (savedTreasury === undefined) delete process.env.LATH_TEMPO_TREASURY;
    else process.env.LATH_TEMPO_TREASURY = savedTreasury;
  });

  it("makes one upstream call per window, however many anonymous callers ask at once", async () => {
    const { GET } = await import("../frontend/src/app/api/tempo/treasury/route");
    let calls = 0;
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      assert.instanceOf(init?.signal, AbortSignal, "every Tempo read carries a deadline");
      await held;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${BALANCE.toString(16).padStart(64, "0")}` }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const t0 = realNow();
    Date.now = () => t0;
    const asks = Array.from({ length: 25 }, () => GET());
    answer();
    const bodies = await Promise.all(asks.map(read));
    assert.equal(calls, 1, "twenty-five GETs in flight, one balanceOf");
    assert.isTrue(bodies.every((b) => b.balanceBase === BALANCE.toString()));

    Date.now = () => t0 + 14_000;
    await read(GET());
    assert.equal(calls, 1, "still inside the window");

    Date.now = () => t0 + 16_000;
    const later = await read(GET());
    assert.equal(calls, 2, "a fresh read once the window has passed");
    assert.equal(later.balanceBase, BALANCE.toString());
  });

  it("keeps a failed read for the window too, so callers cannot hammer an RPC that is refusing", async () => {
    const { GET } = await import("../frontend/src/app/api/tempo/treasury/route");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;
    // Well past the last case's window, so this one starts with nothing cached.
    const t0 = realNow() + 1_000_000;
    Date.now = () => t0;
    const first = await read(GET());
    const second = await read(GET());
    assert.isNull(first.balanceBase, "unknown, not zero");
    assert.match(first.balanceError, /429/);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });

  it("abandons a Tempo read whose server accepts the request and then never answers", async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const started = realNow();
    let thrown: unknown;
    try {
      await usdcBalance(httpRpc("https://rpc.invalid", { timeoutMs: 50 }), PAYER);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, "the stalled read rejects instead of holding its caller");
    assert.match(String((thrown as Error).name), /TimeoutError|AbortError/);
    assert.isBelow(realNow() - started, 5_000);
    assert.equal(TEMPO_RPC_TIMEOUT_MS, 10_000, "the shipped deadline");
  });
});

// mppx answers `undefined` to a 2xx close that carries no Payment-Receipt. Handed on as
// `{ txHash: undefined }`, it would let the pooled wrapper drop the channel's row unconditionally,
// leaving the restart nothing to settle from, though nothing showed the channel had settled.
// `closeChannelById` keeps a row on a receiptless close, and so does the session's own close.
describe("a session's own close with no receipt keeps the channel's row", () => {
  beforeEach(clear);
  after(clear);

  const CHANNEL = `0x${"5e".repeat(32)}`;
  /** One paid answer and a channel that opens on it; `close` answers what the test says. */
  function session(close: () => Promise<{ txHash?: string; spent?: string } | undefined>): MppSession {
    let opened = false;
    return {
      get cumulative() {
        return opened ? BigInt(1500) : BigInt(0);
      },
      get channelId() {
        return opened ? CHANNEL : undefined;
      },
      get opened() {
        return opened;
      },
      async fetch() {
        opened = true;
        return new Response(
          JSON.stringify({
            id: "gen-1",
            model: "test/model",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0015 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      close,
    };
  }
  const pooled = (s: MppSession) =>
    new PooledTempoTransport(
      new MppOpenRouterTransport({
        account: { address: PAYER },
        maxCostBase: BigInt(10_000),
        maxSteps: 4,
        sessionFactory: async () => s,
      }),
      "ab".repeat(32)
    );
  const REQ: ChatRequest = {
    model: "test/model",
    messages: [{ role: "user", content: "ping" }],
    usage: { include: true },
  };

  it("throws, keeps the row for the restart's recovery, and still counts the channel down", async () => {
    const t = pooled(session(async () => undefined));
    const before = openChannelCount();
    await t.chat(REQ);
    assert.deepEqual(
      readChannelLedger().map((r) => r.channelId),
      [CHANNEL],
      "the open wrote its row"
    );
    assert.equal(openChannelCount(), before + 1);

    let thrown: unknown;
    try {
      await t.close();
    } catch (e) {
      thrown = e;
    }
    assert.match(String((thrown as Error)?.message), /no receipt, so nothing is known to have settled/);
    assert.deepEqual(
      readChannelLedger().map((r) => r.channelId),
      [CHANNEL],
      "the row stays: the restart's recovery settles it through closeChannelById"
    );
    assert.equal(openChannelCount(), before, "this process holds nothing it can still settle");
  });

  it("drops the row on a close that came back with its receipt, as before", async () => {
    const t = pooled(session(async () => ({ txHash: `0x${"aa".repeat(32)}`, spent: "1500" })));
    await t.chat(REQ);
    const receipt = await t.close();
    assert.equal(receipt.txHash, `0x${"aa".repeat(32)}`);
    assert.equal(receipt.spent, "1500");
    assert.deepEqual(readChannelLedger(), []);
  });
});
