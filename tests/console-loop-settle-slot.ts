import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LoopChannel,
  LoopChannelHooks,
  LoopRecord,
  afterLoopStep,
  archiveLoop,
  checkLoopStart,
  discardLoopAnchor,
  loopChannelMark,
  loopSettling,
  openLoopChannel,
  readLoop,
  recordLoop,
  retryLoopAnchor,
  setLoopKeySeamsForTests,
  setRevokeBackoffForTests,
  settleLoopChannel,
  stepSlotHolder,
  stopLoop,
  sweepLoopKeys,
  unarchiveLoop,
} from "../frontend/src/app/api/_lib/loops";
import { acquireRunSlot, lookupAgent, recordAgent, RunSlot } from "../frontend/src/app/api/_lib/runner";
import { hex } from "@lath/sdk";

/**
 * Every write of a loop agent's chain outside a step — the settlement, Retry, Discard — goes
 * through the one run slot, and a loop's settles go one at a time.
 *
 * A settle that took no slot would let a Stop followed by *Run again* on the same agent have the
 * old run's `loop.settlement` take the seq the new run's first step had journaled against, and an
 * `unbilled` settle and the next step's `restart` settle close one channel twice. No chain here:
 * the three `LoopChannelHooks` stand in for Tempo and the runner, as in `tests/console-loops.ts`, and
 * a slot taken with `acquireRunSlot` stands in for a session or another step.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const AGENT = "cd".repeat(32);
const PAYER = "0x18fB0000000000000000000000000000000000B0";

function clearStore(): void {
  for (const f of ["loops.json", "templates.json", "agents.json", "market.json"]) {
    fs.rmSync(path.join(traceDir, f), { force: true });
  }
}

function deploy(): void {
  recordAgent(AGENT, {
    name: "settler",
    authority: "AuThOrItY1111111111111111111111111111111111",
    owner: OWNER,
    createdAt: Date.now(),
    policy: { model: "deepseek/deepseek-v4.1-flash", tools: [], budgetCapUsdc: "1.00", expirationDays: 14 },
  });
}

function record(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
  const loop: LoopRecord = {
    id,
    agentId: AGENT,
    agentName: "settler",
    owner: OWNER,
    prompt: "check the slot and report",
    promptHash: "ef".repeat(32),
    intervalMs: 15_000,
    maxSteps: 5,
    budgetMicroUsdcPerStep: "50000",
    model: "deepseek/deepseek-v4.1-flash",
    createdAt: Date.now(),
    status: "running",
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
    ...over,
  };
  recordLoop(loop);
  return loop;
}

function fakeChannel(channelId: string): LoopChannel & { closes: number } {
  let total = BigInt(0);
  return {
    closes: 0,
    payer: PAYER,
    channelId,
    opened: true,
    get cumulative() {
      return total.toString();
    },
    chat: async () => {
      total += BigInt(750);
      return {} as any;
    },
    async close() {
      this.closes++;
      return { txHash: `0xtx-${channelId}`, spent: total.toString() };
    },
  };
}

/** The seams, with a log of every settlement and every close by id the treasury would have made. */
function hooksFor(channels: LoopChannel[]) {
  const settlements: { channelId?: string; reason?: string }[] = [];
  const closedById: string[] = [];
  let opens = 0;
  const hooks: LoopChannelHooks = {
    open: async () => ({ channel: channels[Math.min(opens++, channels.length - 1)] }),
    closeById: async (channelId) => {
      closedById.push(channelId);
      return { txHash: `0xrestart-${channelId}`, spent: "1500" };
    },
    settle: async (_loop, channel) => {
      const receipt = await channel.close();
      settlements.push({ channelId: channel.channelId });
      return { payer: channel.payer, channelId: channel.channelId, closed: true, ...receipt };
    },
  };
  return { hooks, settlements, closedById };
}

/** A plain start on the agent, the long body `POST /api/loops` takes. */
function startBody() {
  return {
    agentId: AGENT,
    prompt: "check the slot and report",
    intervalMs: 15_000,
    maxSteps: 3,
    budgetMicroUsdcPerStep: "50000",
    model: "deepseek/deepseek-v4.1-flash",
  };
}

/** A timer tick: a fired settle whose slot was free has finished by then. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Longer than the settle's slot poll, so one that was waiting has taken the freed slot. */
const polled = () => new Promise<void>((resolve) => setTimeout(resolve, 700));

/** A loop holding a channel it has paid one call through, with the row naming it. */
async function holding(id: string, channel: LoopChannel & { closes: number }, hooks: LoopChannelHooks) {
  record(id);
  const opened = await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks);
  assert.equal(opened?.channelId, channel.channelId);
  await opened!.chat({} as any);
  // What the end of a step does: the row takes the channel, and the idle settle is armed.
  afterLoopStep(id, hooks);
  assert.equal(readLoop(id)!.channel?.channelId, channel.channelId);
}

describe("loop settlement under the run slot", () => {
  let slot: RunSlot | null = null;
  const take = (holder: string) => {
    slot = acquireRunSlot(holder, 60_000);
    assert.ok(slot, `the run slot is free for ${holder}`);
    return slot!;
  };

  before(() => {
    process.env.LATH_TEMPO_TREASURY = `0x${"11".repeat(32)}`;
  });
  beforeEach(() => {
    clearStore();
    deploy();
  });
  afterEach(() => {
    slot?.release();
    slot = null;
  });

  it("a Stop mid-step settles after the step lets the slot go, and a start waits for it", async () => {
    const channel = fakeChannel("ch-stop");
    const { hooks, settlements } = hooksFor([channel]);
    const id = "loop-settle-stop";
    await holding(id, channel, hooks);

    // A step of this loop holds the slot; the owner presses Stop.
    const step = take(stepSlotHolder(id));
    stopLoop(id, "stopped", hooks);
    await settled();
    assert.deepEqual(settlements, [], "nothing is written beside the step");
    assert.equal(channel.closes, 0);
    assert.isTrue(loopSettling(id), "the settle is queued, not dropped");

    // *Run again* on the same agent is refused while the old run's record is still to land.
    const again = startBody();
    const refused = checkLoopStart(again, OWNER) as { error: string; status: number };
    assert.equal(refused.status, 409);
    assert.match(refused.error, /still settling its Tempo channel/);

    step.release();
    slot = null;
    await polled();
    assert.deepEqual(settlements, [{ channelId: "ch-stop" }], "settled once the slot was free");
    assert.equal(channel.closes, 1);
    assert.isUndefined(readLoop(id)!.channel);
    assert.isFalse(loopSettling(id));
    assert.notProperty(checkLoopStart(again, OWNER), "error", "and the start goes through after it");
  });

  it("refuses a start beside a stopped run whose channel is still on its row", async () => {
    record("loop-settle-row", {
      status: "stopped",
      stopReason: "stopped",
      channel: { channelId: "ch-left", payer: PAYER, openedAt: 1, openedAtStep: 0, cumulative: "750" },
    });
    const again = startBody();
    assert.deepInclude(checkLoopStart(again, OWNER), { status: 409 });
  });

  it("defers an idle settle that finds the slot taken, keeping the channel held", async () => {
    const channel = fakeChannel("ch-idle");
    const { hooks, settlements } = hooksFor([channel]);
    const id = "loop-settle-idle";
    await holding(id, channel, hooks);

    take("a console session");
    assert.isUndefined(await settleLoopChannel(id, "idle", hooks));
    assert.deepEqual(settlements, [], "not written beside the session");
    assert.equal(loopChannelMark(id).channelId, "ch-idle", "and not dropped: the channel is still held");
    assert.equal(readLoop(id)!.channel?.channelId, "ch-idle");

    slot!.release();
    slot = null;
    await settleLoopChannel(id, "stopped", hooks);
    assert.deepEqual(settlements, [{ channelId: "ch-idle" }]);
    assert.equal(channel.closes, 1);
  });

  it("closes one channel once when an unbilled settle and a restart settle overlap", async () => {
    const channel = fakeChannel("ch-twice");
    const { hooks, settlements, closedById } = hooksFor([channel]);
    const id = "loop-settle-twice";
    await holding(id, channel, hooks);

    // `afterLoopStep`'s unbilled settle, and the next tick's `openLoopChannel` finding the row.
    await Promise.all([settleLoopChannel(id, "unbilled", hooks), settleLoopChannel(id, "restart", hooks)]);
    assert.deepEqual(settlements, [{ channelId: "ch-twice" }], "one settlement record");
    assert.equal(channel.closes, 1);
    assert.deepEqual(closedById, [], "and no second close by id of the channel just closed");
    assert.isUndefined(readLoop(id)!.channel);
  });

  it("settles a restart row under the step's own slot, without waiting on itself", async () => {
    const fresh = fakeChannel("ch-fresh");
    const { hooks, settlements, closedById } = hooksFor([fresh]);
    const id = "loop-settle-restart";
    record(id, {
      rail: "tempo",
      channel: { channelId: "ch-stranded", payer: PAYER, openedAt: 1, openedAtStep: 0, cumulative: "1500" },
    });
    take(stepSlotHolder(id));
    const opened = await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks);
    assert.deepEqual(closedById, ["ch-stranded"]);
    assert.deepEqual(settlements, [{ channelId: "ch-stranded" }]);
    assert.equal(opened?.channelId, "ch-fresh");
  });

  it("a step opens nothing on top of a restart row whose close fails, keeps the row, and settles it next step", async () => {
    const fresh = fakeChannel("ch-after-retry");
    const { hooks: working, closedById } = hooksFor([fresh]);
    let failing = true;
    let opens = 0;
    // The runner's own shape for a close that threw: `closed: false` with the reason, never a throw.
    const hooks: LoopChannelHooks = {
      ...working,
      open: async (loop) => {
        opens++;
        return working.open!(loop);
      },
      closeById: async (channelId, payer) => {
        if (failing) throw new Error("tempo did not answer");
        return working.closeById!(channelId, payer);
      },
      settle: async (_loop, channel) => {
        try {
          const receipt = await channel.close();
          return { payer: channel.payer, channelId: channel.channelId, closed: true, ...receipt };
        } catch (e) {
          return { payer: channel.payer, channelId: channel.channelId, closed: false, error: (e as Error).message };
        }
      },
    };
    const id = "loop-settle-restart-fails";
    record(id, {
      rail: "tempo",
      channel: { channelId: "ch-stranded", payer: PAYER, openedAt: 1, openedAtStep: 0, cumulative: "1500" },
    });
    take(stepSlotHolder(id));
    assert.isNull(await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks));
    assert.equal(opens, 0, "no second deposit beside the one nobody holds");
    assert.equal(readLoop(id)!.channel?.channelId, "ch-stranded", "the failed close stays on the row to retry");
    assert.equal(readLoop(id)!.snapshot.tempo?.closed, false);
    assert.match(readLoop(id)!.tempoNote!, /could not be settled yet/);

    failing = false;
    const opened = await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks);
    assert.deepEqual(closedById, ["ch-stranded"]);
    assert.equal(opened?.channelId, "ch-after-retry");
    assert.isUndefined(readLoop(id)!.tempoNote);
  });

  it("a gate ask, holding no slot, opens nothing on top of a restart row it cannot settle", async () => {
    const fresh = fakeChannel("ch-not-opened");
    const { hooks, settlements, closedById } = hooksFor([fresh]);
    const id = "loop-settle-ask";
    record(id, {
      rail: "tempo",
      channel: { channelId: "ch-stranded", payer: PAYER, openedAt: 1, openedAtStep: 0, cumulative: "1500" },
    });
    take("a console session");
    assert.isNull(await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks, false));
    assert.deepEqual(closedById, []);
    assert.deepEqual(settlements, []);
    assert.equal(readLoop(id)!.channel?.channelId, "ch-stranded", "the row is left for a settle that has the slot");
    assert.match(readLoop(id)!.tempoNote!, /could not be settled yet/);
  });

  it("answers Retry and Discard at once when another writer holds the slot, and sends nothing", async () => {
    const id = "loop-settle-retry";
    record(id, { status: "stopped", stopReason: "anchor-failed" });
    const calls: string[] = [];
    const queue = {
      async retry(a: Uint8Array) {
        calls.push(`retry:${hex(a)}`);
      },
      async drain(a: Uint8Array) {
        calls.push(`drain:${hex(a)}`);
      },
      async discard(a: Uint8Array) {
        calls.push(`discard:${hex(a)}`);
        return { dropped: [], unbilledMicroUsdc: 0n, chargedMicroUsdc: 0n, reason: "diverged" } as any;
      },
    };
    take("a console session");
    const retried = await retryLoopAnchor(id, { queue, resume: () => calls.push("resume") });
    assert.match(retried.error!, /another run is writing a chain/);
    const discarded = await discardLoopAnchor(id, { queue });
    assert.match(discarded.error!, /another run is writing a chain/);
    assert.deepEqual(calls, [], "nothing reached the writer queue");
    assert.equal(readLoop(id)!.stopReason, "anchor-failed", "and the run is as it was");

    slot!.release();
    slot = null;
    const after = await retryLoopAnchor(id, { queue, resume: () => calls.push("resume") });
    assert.isUndefined(after.error);
    assert.deepEqual(calls.slice(0, 2), [`retry:${AGENT}`, `drain:${AGENT}`], "with the slot free it runs");
  });
});

/**
 * A keyed loop's stop (docs/ARCHITECTURE.md §7.3): the channel is
 * closed first, under the run slot like every settle, and only then is the key revoked — after the
 * slot a step held is let go, never beside it. A revoke that fails is kept on the row and never holds
 * the stop up. The key calls are fakes (`setLoopKeySeamsForTests`); nothing here reaches Tempo.
 */
describe("a keyed loop's stop: close, then revoke", () => {
  let slot: RunSlot | null = null;
  let order: string[];

  function keyedHooks(channel: LoopChannel & { closes: number }) {
    const { hooks } = hooksFor([channel]);
    const settle: LoopChannelHooks["settle"] = async (loop, c) => {
      const settlement = await hooks.settle!(loop, c);
      order.push(`close ${c.channelId}`);
      return settlement;
    };
    return { ...hooks, settle };
  }

  function keySeams(revoke: () => Promise<`0x${string}` | null>) {
    setLoopKeySeamsForTests({
      account: async () => ({ address: PAYER, accessKeyAddress: "0xkey" }),
      reconcile: async () => ({ target: "0", sent: false }),
      revoke: async (loopId) => {
        order.push(`revoke ${loopId}`);
        return revoke();
      },
    });
  }

  const tempoKey = (loopId: string): LoopRecord["tempoKey"] => ({
    loopId,
    address: "0xAbCd00000000000000000000000000000000Ef01",
    token: "0x20C000000000000000000000b9537d11c60E8b50",
    limitBase: "172500",
    expiry: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    authorizeTx: `0x${"ab".repeat(32)}`,
  });

  before(() => {
    process.env.LATH_TEMPO_TREASURY = `0x${"11".repeat(32)}`;
  });
  beforeEach(() => {
    clearStore();
    deploy();
    order = [];
  });
  afterEach(() => {
    slot?.release();
    slot = null;
    setLoopKeySeamsForTests(undefined);
  });

  it("closes the channel after the step lets the slot go, then revokes the key", async () => {
    keySeams(async () => `0x${"cd".repeat(32)}`);
    const channel = fakeChannel("ch-keyed-stop");
    const hooks = keyedHooks(channel);
    const id = "loop-keyed-stop";
    record(id, { tempoKey: tempoKey(id) });
    await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks);
    await (await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks))!.chat({} as any);
    afterLoopStep(id, hooks);

    slot = acquireRunSlot(stepSlotHolder(id), 60_000);
    stopLoop(id, "stopped", hooks);
    await settled();
    assert.deepEqual(order, [], "neither the close nor the revoke runs beside the step");

    slot!.release();
    slot = null;
    await polled();
    assert.deepEqual(order, ["close ch-keyed-stop", `revoke ${id}`], "close first, then revoke");
    assert.equal(readLoop(id)!.tempoKeyRevoke!.txHash, `0x${"cd".repeat(32)}`);
    assert.isNumber(readLoop(id)!.tempoKeyRevoke!.revokedAt);

    // A second settle — a stop racing an archive — revokes nothing again.
    await settleLoopChannel(id, "archived", hooks);
    assert.equal(order.filter((o) => o.startsWith("revoke")).length, 1);
  });

  it("keeps a failed revoke on the row and leaves the loop stopped, for a later try", async () => {
    keySeams(async () => {
      throw new Error("nonce too low");
    });
    const channel = fakeChannel("ch-keyed-fail");
    const hooks = keyedHooks(channel);
    const id = "loop-keyed-revoke-fails";
    record(id, { tempoKey: tempoKey(id) });
    await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks);
    stopLoop(id, "stopped", hooks);
    await polled();
    assert.deepEqual(order, ["close ch-keyed-fail", `revoke ${id}`]);
    const after = readLoop(id)!;
    assert.equal(after.status, "stopped");
    assert.equal(after.stopReason, "stopped");
    assert.match(after.tempoKeyRevoke!.error!, /nonce too low/);
    assert.isUndefined(after.tempoKeyRevoke!.revokedAt);
  });

  it("does not revoke while the stopped loop's channel is still on its row", async () => {
    keySeams(async () => `0x${"cd".repeat(32)}`);
    const id = "loop-keyed-left";
    record(id, {
      tempoKey: tempoKey(id),
      status: "stopped",
      stopReason: "stopped",
      channel: { channelId: "ch-left", payer: PAYER, openedAt: 1, openedAtStep: 0, cumulative: "750" },
    });
    // The settle cannot have the slot, so the channel stays on the row and the key with it.
    slot = acquireRunSlot("a console session", 60_000);
    void settleLoopChannel(id, "restart", hooksFor([]).hooks);
    await settled();
    assert.deepEqual(order, []);
    assert.isUndefined(readLoop(id)!.tempoKeyRevoke);
  });

  it("sends no key call at all for a loop without a key", async () => {
    keySeams(async () => {
      throw new Error("revoke called for a loop without a key");
    });
    const channel = fakeChannel("ch-plain");
    const { hooks, settlements } = hooksFor([channel]);
    const id = "loop-plain-stop";
    record(id);
    await openLoopChannel(readLoop(id)!, lookupAgent(AGENT)!, true, hooks);
    stopLoop(id, "stopped", hooks);
    await polled();
    assert.deepEqual(settlements, [{ channelId: "ch-plain" }]);
    assert.deepEqual(order, []);
    assert.notProperty(readLoop(id)!, "tempoKeyRevoke");
    assert.notProperty(readLoop(id)!, "tempoKeyClosed");
  });
});

/**
 * When a stopped keyed loop's key goes: not
 * while a Retry can still resume the run (`anchor-failed`), but once a Discard, an archive or a Retry
 * that leaves it stopped ends it; a refused revoke is tried again on a backoff; a revoke with no key
 * file is recorded as one to make by hand and never as revoked; and the console start's sweep revokes
 * a key file with no loop row. Every key call is a fake; nothing here reaches Tempo.
 */
describe("a keyed loop's key: revoked when nothing can resume the run", () => {
  let revokes: string[];
  let answer: (loopId: string) => Promise<`0x${string}` | null>;
  const TX = `0x${"cd".repeat(32)}` as `0x${string}`;
  const tempoKey = (loopId: string): LoopRecord["tempoKey"] => ({
    loopId,
    address: "0xAbCd00000000000000000000000000000000Ef01",
    token: "0x20C000000000000000000000b9537d11c60E8b50",
    limitBase: "172500",
    expiry: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    authorizeTx: `0x${"ab".repeat(32)}`,
  });
  /** A run its failed writes stopped, its channel already closed: what `afterLoopStep` settles. */
  const anchorFailed = (id: string, over: Partial<LoopRecord> = {}) =>
    record(id, {
      tempoKey: tempoKey(id),
      status: "stopped",
      stopReason: "anchor-failed",
      stopDetail: "step 1 ran and its chain writes did not land",
      snapshot: { loopId: id, steps: 1, status: "stopped", totalCostMicroUsdc: "0", consecutiveFailures: 0 } as any,
      ...over,
    });
  const queue = {
    retry: async () => undefined,
    drain: async () => undefined,
    discard: async () => ({ dropped: [], unbilledMicroUsdc: 0n, chargedMicroUsdc: 0n, reason: "head diverged" } as any),
  };

  before(() => {
    process.env.LATH_TEMPO_TREASURY = `0x${"11".repeat(32)}`;
  });
  beforeEach(() => {
    clearStore();
    deploy();
    revokes = [];
    answer = async () => TX;
    setLoopKeySeamsForTests({
      revoke: async (loopId) => {
        revokes.push(loopId);
        return answer(loopId);
      },
    });
  });
  afterEach(() => {
    setLoopKeySeamsForTests(undefined);
    setRevokeBackoffForTests(undefined);
  });

  it("keeps the key of a run stopped anchor-failed, so the Retry that resumes it can pay", async () => {
    const id = "loop-00000000000000aa";
    anchorFailed(id);
    await settleLoopChannel(id, "anchor-failed", {});
    assert.deepEqual(revokes, [], "a Retry can still resume this run");
    const { loop: after } = await retryLoopAnchor(id, { queue, resume: () => undefined });
    assert.equal(after?.status, "running");
    assert.deepEqual(revokes, [], "and the resumed run still has its key");
    assert.isUndefined(readLoop(id)!.tempoKeyRevoke);
  });

  it("revokes once a Retry leaves the run stopped for good", async () => {
    const id = "loop-00000000000000ab";
    // Its last step was the one that failed: the Retry lands it, and nothing resumes.
    anchorFailed(id, { maxSteps: 1 });
    await retryLoopAnchor(id, { queue, resume: () => assert.fail("a finished run is not resumed") });
    assert.deepEqual(revokes, [id]);
    assert.equal(readLoop(id)!.tempoKeyRevoke!.txHash, TX);
  });

  it("revokes when a Discard ends the run, after its owed close is paid", async () => {
    const id = "loop-00000000000000ac";
    anchorFailed(id);
    const { error } = await discardLoopAnchor(id, { queue });
    assert.isUndefined(error);
    assert.equal(readLoop(id)!.stopReason, "anchor-discarded");
    assert.deepEqual(revokes, [id]);
  });

  it("revokes when an archive ends a run a Retry could have resumed", async () => {
    const id = "loop-00000000000000ad";
    anchorFailed(id);
    archiveLoop(id);
    await settled();
    assert.deepEqual(revokes, [id]);
  });

  it("records a revoke with no key file as one to make by hand, never as revoked", async () => {
    const id = "loop-00000000000000ae";
    answer = async () => null;
    record(id, { tempoKey: tempoKey(id), status: "stopped", stopReason: "stopped" });
    await settleLoopChannel(id, "stopped", {});
    const revoke = readLoop(id)!.tempoKeyRevoke!;
    assert.isUndefined(revoke.revokedAt);
    assert.isUndefined(revoke.txHash);
    assert.isTrue(revoke.byHand);
    assert.include(revoke.error!, "0xAbCd00000000000000000000000000000000Ef01");
    // Nothing more is tried: there is no file to sign with.
    await settleLoopChannel(id, "archived", {});
    assert.deepEqual(revokes, [id]);
  });

  it("tries a refused revoke again on a backoff until it lands", async () => {
    const id = "loop-00000000000000af";
    setRevokeBackoffForTests([10]);
    let tries = 0;
    answer = async () => {
      if (++tries === 1) throw new Error("nonce too low");
      return TX;
    };
    record(id, { tempoKey: tempoKey(id), status: "stopped", stopReason: "stopped" });
    await settleLoopChannel(id, "stopped", {});
    assert.match(readLoop(id)!.tempoKeyRevoke!.error!, /nonce too low/);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(readLoop(id)!.tempoKeyRevoke!.txHash, TX);
    assert.deepEqual(revokes, [id, id]);
  });

  it("does not resume a run whose archive's revoke is still in flight when it is unarchived and retried", async () => {
    const id = "loop-00000000000000b3";
    let land!: () => void;
    answer = () => new Promise((resolve) => (land = () => resolve(TX)));
    anchorFailed(id);
    archiveLoop(id);
    await settled();
    assert.deepEqual(revokes, [id], "the archive's revoke is in flight");
    unarchiveLoop(id);
    const { loop: after } = await retryLoopAnchor(id, { queue, resume: () => assert.fail("no key to pay with") });
    assert.equal(after?.status, "stopped");
    land();
    await settled();
    assert.equal(readLoop(id)!.tempoKeyRevoke!.txHash, TX);
  });

  it("sweeps a key file with no loop row once it is old enough, and leaves a start in flight alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-sweep-keys-"));
    const saved = process.env.LATH_TEMPO_KEY_DIR;
    process.env.LATH_TEMPO_KEY_DIR = dir;
    try {
      const old = "loop-00000000000000b0";
      const young = "loop-00000000000000b1";
      const kept = "loop-00000000000000b2";
      for (const id of [old, young, kept]) {
        fs.writeFileSync(
          path.join(dir, `${id}.json`),
          JSON.stringify({ v: 1, loopId: id, address: `0x${id.slice(-2)}` })
        );
      }
      const hourAgo = new Date(Date.now() - 60 * 60_000);
      fs.utimesSync(path.join(dir, `${old}.json`), hourAgo, hourAgo);
      fs.utimesSync(path.join(dir, `${kept}.json`), hourAgo, hourAgo);
      // A running loop's key is its own, however old its file.
      record(kept, { tempoKey: tempoKey(kept) });
      await sweepLoopKeys({ orphans: true });
      assert.deepEqual(revokes, [old]);
    } finally {
      if (saved === undefined) delete process.env.LATH_TEMPO_KEY_DIR;
      else process.env.LATH_TEMPO_KEY_DIR = saved;
    }
  });
});
