/**
 * The tile join (`frontend/src/lib/tiles.ts`), over the five rows a wallet actually has:
 * an agent it signs for with a running loop, an agent it only funds that has been quiet for a
 * day, a foreign header nobody named, a registry row the owner archived, and a run that reached
 * its cap.
 *
 * Node-only by construction: `tiles.ts` imports nothing but `lib/draft.ts`, which imports nothing, so
 * this suite needs no validator, no RPC and no bundler alias — the same reason `tests/spend.ts` can
 * import `lib/spend.ts`. The loop-budget readers (`lib/draft.ts`, `lib/loop-money.ts`) are pinned
 * here too, because the tiles are one of the three places that read them.
 */
import { assert } from "chai";
import {
  ACTIVE_WINDOW_MS,
  EMPTY_DESCRIPTION,
  TileLoopInput,
  TileOwnerInput,
  TileRegistryInput,
  bins24,
  statusOf,
  tileRows,
} from "../frontend/src/lib/tiles";
import { NOT_SANDBOXED_DESCRIPTION, TileZeroClawInput, bytesLabel, zeroclawTileRows } from "../frontend/src/lib/tiles";
import { loopBudgetFoot } from "../frontend/src/lib/tiles";
import { draftLoopBudget } from "../frontend/src/lib/draft";
import { loopBudgetFigures } from "../frontend/src/lib/loop-money";
import { pollOptions, SCHEDULE_FAST_MS, triggerLabel, triggerOf } from "../frontend/src/lib/loop-trigger";

const NOW = 1_780_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A 32-byte id whose hex is a readable prefix, so a failing assertion names the row. */
function idOf(prefix: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < prefix.length && i < 32; i++) bytes[i] = prefix.charCodeAt(i);
  return bytes;
}

function hexOf(prefix: string): string {
  return Buffer.from(idOf(prefix)).toString("hex");
}

function key(base58: string) {
  return { toBase58: () => base58 };
}

const SIGNER_ID = idOf("signer");
const FUNDED_ID = idOf("funded");
const FOREIGN_ID = idOf("foreign");
const ARCHIVED_ID = idOf("archived");

const owners: TileOwnerInput[] = [
  {
    address: key("addr-signer"),
    relations: ["signer"],
    state: {
      agentId: SIGNER_ID,
      authority: key("AuthSigner1111111111111111111111111111111111"),
      seq: 42n,
      head: idOf("head-signer"),
      createdAt: NOW - 7 * DAY,
      updatedAt: NOW - 2 * 60_000,
    },
  },
  {
    address: key("addr-funded"),
    relations: ["funded"],
    allowance: { cap: 5_000_000n, spent: 1_250_000n, expiresAt: BigInt(Math.floor((NOW + DAY) / 1000)) },
    state: {
      agentId: FUNDED_ID,
      authority: key("AuthFunded1111111111111111111111111111111111"),
      seq: 9n,
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW - DAY,
    },
  },
  {
    // Foreign: this wallet funds the authority, nothing published a name and the console's
    // registry never deployed it, so every console-side field is absent.
    address: key("addr-foreign"),
    relations: ["funded"],
    state: {
      agentId: FOREIGN_ID,
      authority: key("AuthForeign111111111111111111111111111111111"),
      seq: 1n,
      createdAt: NOW - 3 * DAY,
      updatedAt: NOW - 3 * DAY,
    },
  },
  {
    address: key("addr-archived"),
    relations: ["signer"],
    state: {
      agentId: ARCHIVED_ID,
      authority: key("AuthArchived11111111111111111111111111111111"),
      seq: 5n,
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 3 * HOUR,
    },
  },
];

const registry: TileRegistryInput = {
  archived: [hexOf("archived")],
  agents: [
    {
      id: hexOf("signer"),
      name: "watcher",
      description: "Watches the BTC feed and writes a note every step.",
      policy: { model: "anthropic/claude-haiku-4.5", tools: ["pyth.price"], budgetCapUsdc: "1.0", expirationDays: 7 },
      template: { id: "tpl-abcdef0123456789", version: 2 },
    },
    {
      id: hexOf("funded"),
      name: "borrowed",
      clonedFrom: { agentId: hexOf("signer"), name: "watcher", via: "market" },
    },
    { id: hexOf("archived"), name: "retired" },
  ],
};

const runningLoop: TileLoopInput = {
  id: "loop-running",
  agentId: hexOf("signer"),
  agentName: "watcher",
  prompt: "Check the feed and write what changed.",
  promptHash: "aa".repeat(32),
  intervalMs: 5 * 60_000,
  maxSteps: 10,
  budgetMicroUsdcPerStep: "50000",
  model: "anthropic/claude-haiku-4.5",
  createdAt: NOW - 2 * HOUR,
  trigger: { kind: "schedule" },
  template: { id: "tpl-abcdef0123456789", version: 2 },
  status: "running",
  stepping: true,
  steps: 3,
  lastStepAt: NOW - 60_000,
  nextStepAt: NOW + 4 * 60_000,
  totalCostMicroUsdc: "150000",
};

const cappedLoop: TileLoopInput = {
  id: "loop-capped",
  agentId: hexOf("funded"),
  agentName: "borrowed",
  prompt: "Summarise the day.",
  intervalMs: HOUR,
  maxSteps: 4,
  budgetMicroUsdcPerStep: "25000",
  createdAt: NOW - 6 * HOUR,
  trigger: { kind: "schedule" },
  status: "stopped",
  stopReason: "max-steps",
  steps: 4,
  lastStepAt: NOW - 90 * 60_000,
  nextStepAt: null,
  totalCostMicroUsdc: "100000",
};

const archivedLoop: TileLoopInput = {
  id: "loop-archived",
  agentId: hexOf("archived"),
  agentName: "retired",
  status: "stopped",
  archivedAt: NOW - DAY,
};

const names = { [hexOf("signer")]: "watcher" };

function join(extra: Partial<Parameters<typeof tileRows>[0]> = {}) {
  return tileRows({
    owners,
    registry,
    loops: [runningLoop, cappedLoop, archivedLoop],
    names,
    now: NOW,
    ...extra,
  });
}

describe("tile rows", () => {
  it("drops an archived registry row from the agent grid", () => {
    const { agents } = join();
    assert.deepEqual(
      agents.map((a) => a.agentId),
      [hexOf("signer"), hexOf("funded"), hexOf("foreign")],
      "newest write first, and the archived row is not in the list at all"
    );
    assert.isUndefined(agents.find((a) => a.agentId === hexOf("archived")));
  });

  it("drops an archived loop, and the archived agent's chip never becomes a loop", () => {
    const { loops } = join();
    assert.deepEqual(
      loops.map((l) => l.loopId),
      ["loop-running", "loop-capped"]
    );
  });

  it("reads a signer agent with a running loop as a stepping loop tile", () => {
    const row = join().agents.find((a) => a.agentId === hexOf("signer"))!;
    assert.equal(row.kind, "loop", "a non-archived loop on the agent makes the chip say loop");
    assert.equal(row.status, "stepping");
    assert.equal(row.testId, "owner-row");
    assert.equal(row.href, `/agent/${hexOf("signer")}`);
    assert.equal(row.name, "watcher");
    assert.equal(row.nameSource, "chain", "a published NameRecord is a chain fact");
    assert.isFalse(row.unnamed);
    assert.equal(row.description, "Watches the BTC feed and writes a note every step.");
    assert.isFalse(row.descriptionPlaceholder);
    assert.equal(row.footLeft, "seq 42 · 2 min ago");
    assert.equal(row.footLeftSource, "chain");
    assert.deepEqual(row.relations, ["signer"]);
    assert.notProperty(row, "market", "no market badge: the marketplace is on the roadmap");
    const labels = row.fields.map((f) => f.label);
    assert.deepEqual(labels, ["model", "tools", "seq", "head", "authority", "template"]);
    assert.isTrue(
      row.fields.every((f) => f.source === "chain" || f.source === "console"),
      "every hover-card field carries a tag"
    );
    assert.equal(row.fields.find((f) => f.label === "head")!.source, "chain");
    assert.equal(row.fields.find((f) => f.label === "template")!.source, "console");
  });

  it("reads a funded agent idle for a day, with its copy lineage and allowance, and no market badge", () => {
    const row = join().agents.find((a) => a.agentId === hexOf("funded"))!;
    assert.equal(row.status, "idle", "a day past the active window");
    assert.equal(row.statusTone, "neutral");
    assert.deepEqual(row.relations, ["funded"]);
    // A copy launched off a marketplace listing reads as a copy, with no market badge.
    assert.notProperty(row, "market");
    const lineage = row.fields.find((f) => f.label === "cloned from")!;
    assert.equal(lineage.value, "watcher");
    assert.equal(lineage.title, "copied from another wallet's agent");
    assert.equal(row.nameSource, "console", "no NameRecord: the registry named it");
    assert.equal(row.description, EMPTY_DESCRIPTION);
    assert.isTrue(row.descriptionPlaceholder);
    const allowance = row.fields.find((f) => f.label === "allowance")!;
    assert.equal(allowance.value, "1.250000 / 5.000000 USDC");
    assert.equal(allowance.source, "chain");
    assert.equal(row.footLeft, "seq 9 · 1 d ago");
    // The foot says what the wallet approved and what is spent, not the bare word *funded*.
    assert.equal(row.allowanceLabel, "spent 1.25 / 5 USDC");
    assert.match(row.allowanceTitle!, /approved this agent from its balance; expires \d{4}-\d{2}-\d{2}\./);
  });

  it("says an expired allowance is expired on the tile itself", () => {
    const expired = owners.map((o) =>
      o.state.agentId === FUNDED_ID
        ? { ...o, allowance: { ...o.allowance!, expiresAt: BigInt(Math.floor((NOW - DAY) / 1000)) } }
        : o
    );
    const row = tileRows({ owners: expired, now: NOW }).agents.find((a) => a.agentId === hexOf("funded"))!;
    assert.equal(row.allowanceLabel, "spent 1.25 / 5 USDC · expired");
  });

  it("names an unnamed foreign header by its id and claims nothing else about it", () => {
    const row = join().agents.find((a) => a.agentId === hexOf("foreign"))!;
    assert.isTrue(row.unnamed);
    assert.match(row.name, /^unnamed · /);
    assert.equal(row.kind, "agent");
    assert.equal(row.status, "idle");
    assert.equal(row.description, EMPTY_DESCRIPTION);
    assert.deepEqual(
      row.fields.map((f) => f.label),
      ["seq", "authority"],
      "no registry row means no model, no tools, no lineage — only what the header itself says"
    );
  });

  it("reads an owner's stop and a spent budget as grey, not as failures", () => {
    const stopped = join({
      loops: [{ ...runningLoop, status: "stopped", stopReason: "stopped", stepping: false }],
    }).loops.find((l) => l.loopId === "loop-running")!;
    assert.equal(stopped.statusLabel, "stopped");
    assert.equal(stopped.statusTone, "neutral");
    const budget = join({
      loops: [{ ...runningLoop, status: "stopped", stopReason: "budget", stepping: false }],
    }).loops.find((l) => l.loopId === "loop-running")!;
    assert.equal(budget.statusTone, "neutral");
    const failed = join({
      loops: [{ ...runningLoop, status: "stopped", stopReason: "error", stepping: false }],
    }).loops.find((l) => l.loopId === "loop-running")!;
    assert.equal(failed.statusTone, "bad");
  });

  it("reads a loop at its cap as finished, not as stopped", () => {
    const row = join().loops.find((l) => l.loopId === "loop-capped")!;
    assert.equal(row.status, "finished");
    assert.equal(row.statusLabel, "finished");
    assert.equal(row.testId, "loop-row");
    assert.equal(row.href, "/loop/loop-capped");
    assert.equal(row.footLeft, "step 4/4 · next —");
    // The whole budget: this row is from an older console and names only 0.025 a step over 4 steps,
    // so it reads as the 0.1 that loop could ever have spent. The foot says what was spent of it,
    // the spend exact and the budget trimmed.
    assert.equal(row.footRight, "every 1 h · 0.100000 of 0.1 USDC spent");
    assert.equal(row.description, "Summarise the day.");
  });

  it("carries the running loop's own facts on its tile", () => {
    const row = join().loops.find((l) => l.loopId === "loop-running")!;
    assert.equal(row.status, "stepping");
    assert.equal(row.agentId, hexOf("signer"));
    assert.equal(row.footLeft, "step 3/10 · next in 4 min");
    assert.deepEqual(
      row.fields.map((f) => f.label),
      ["model", "prompt hash", "trigger", "spent", "coordinator", "template"]
    );
    assert.equal(row.fields.find((f) => f.label === "spent")!.value, "0.150000 USDC");
  });

  it("distinguishes a sparkline that was not read from one that is empty", () => {
    const absent = join().agents[0];
    assert.isNull(absent.bins, "no events prop: the tile ships with the foot alone");

    const quiet = join({ events: { [hexOf("signer")]: [] } }).agents.find((a) => a.agentId === hexOf("signer"))!;
    assert.isNotNull(quiet.bins);
    assert.lengthOf(quiet.bins!, 24);
    assert.equal(quiet.eventCount, 0);
  });

  it("bins24 folds record timestamps into 24 hourly bins, oldest first", () => {
    const events = [
      { timestamp: NOW - 30 * 60_000 }, // last bin
      { timestamp: BigInt(NOW - 45 * 60_000) }, // last bin, and a bigint as the SDK returns it
      { timestamp: NOW - 23.5 * HOUR }, // first bin
      { timestamp: NOW - 40 * HOUR }, // outside the window: dropped, never clamped
      { timestamp: NOW + HOUR }, // clock skew ahead of us: dropped
    ];
    const bins = bins24(events, NOW);
    assert.lengthOf(bins, 24);
    assert.equal(bins[23], 2);
    assert.equal(bins[0], 1);
    assert.equal(
      bins.reduce((n, b) => n + b, 0),
      3
    );
    assert.deepEqual(bins24(undefined, NOW), new Array(24).fill(0));
  });

  it("statusOf reads an agent by its header when no loop is running", () => {
    assert.equal(statusOf({ kind: "agent", updatedAtMs: NOW - 1000, now: NOW }).status, "active");
    assert.equal(statusOf({ kind: "agent", updatedAtMs: NOW - ACTIVE_WINDOW_MS - 1, now: NOW }).status, "idle");
    assert.equal(
      statusOf({ kind: "agent", updatedAtMs: NOW - DAY, loop: { status: "running" }, now: NOW }).status,
      "running",
      "a running loop outranks a cold header"
    );
    assert.equal(
      statusOf({ kind: "agent", updatedAtMs: NOW - DAY, loop: { status: "paused" }, now: NOW }).status,
      "idle",
      "a paused loop says nothing about the agent"
    );
  });

  it("statusOf words a stopped run the way the loop badge does", () => {
    assert.equal(statusOf({ kind: "loop", loop: { status: "paused" }, now: NOW }).status, "paused");
    const unanchored = statusOf({ kind: "loop", loop: { status: "stopped", stopReason: "anchor-failed" }, now: NOW });
    assert.equal(unanchored.status, "stopped");
    assert.equal(unanchored.label, "not anchored", "the step ran; what is missing is the transactions");
    assert.equal(unanchored.tone, "warn");
  });

  it("says a gated loop's tile wakes on a gate, not every poll", () => {
    // A gated run's `intervalMs` is its poll, so the interval would read as a step a minute.
    const gated: TileLoopInput = { ...runningLoop, id: "loop-gated", intervalMs: 60_000, trigger: { kind: "gate" } };
    const row = join({ loops: [gated] }).loops.find((l) => l.loopId === "loop-gated")!;
    assert.match(row.footRight, /^on a gate · /);
    // Every other trigger's words are what they were.
    const scheduled = join().loops.find((l) => l.loopId === "loop-capped")!;
    assert.match(scheduled.footRight, /^every 1 h/);
  });
});

/**
 * What wakes a loop, as the lists, cards and the loop page say it (`lib/loop-trigger.ts`), and the
 * interval chips the start form offers.
 */
describe("loop trigger", () => {
  it("reads a gated run as on a gate, with its poll, and every other trigger by its kind", () => {
    assert.deepEqual(triggerOf({ trigger: { kind: "gate", pollMs: 15_000 } }), { kind: "gate", pollMs: 15_000 });
    assert.equal(triggerLabel(triggerOf({ trigger: { kind: "gate", pollMs: 60_000 } })), "on a gate");
    assert.equal(triggerLabel(triggerOf({ trigger: { kind: "request", pollMs: 15_000 } })), "on request");
    assert.equal(triggerLabel(triggerOf({ trigger: { kind: "feed" } })), "feed");
    assert.equal(triggerLabel(triggerOf({ trigger: { kind: "schedule" } })), "on schedule");
    // An older run carries no trigger at all, and an unknown kind is not a gate.
    assert.equal(triggerLabel(triggerOf({})), "on schedule");
    assert.equal(triggerLabel(triggerOf({ trigger: { kind: "tide" } })), "on schedule");
  });

  it("offers a schedule loop a 10 s chip first, and hides it under a higher reported floor", () => {
    const intervals = [
      { ms: 60_000, label: "1 min" },
      { ms: 5 * 60_000, label: "5 min" },
    ];
    assert.equal(SCHEDULE_FAST_MS, 10_000);
    assert.deepEqual(
      pollOptions(intervals).map((i) => [i.ms, i.label]),
      [
        [10_000, "10 s"],
        [60_000, "1 min"],
        [5 * 60_000, "5 min"],
      ]
    );
    // At the route's floor it shows; above it the chip would sign into a refusal, so it is gone.
    assert.equal(pollOptions(intervals, 10_000)[0].ms, 10_000);
    assert.deepEqual(pollOptions(intervals, 15_000), intervals);
    // A list that already carries it is not given a second one.
    const withFast = [{ ms: 10_000, label: "10 s" }, ...intervals];
    assert.deepEqual(pollOptions(withFast), withFast);
  });
});

describe("zeroclaw tile rows", () => {
  const recorded = <T>(value: T) => ({ value, source: "console" as const });
  const none = (note: string) => ({ value: null, source: "console" as const, note });
  const NOT_YET = "not yet sandboxed: no step of this loop has run in a sandbox";
  const STEP_NOT = "not sandboxed: this step ran outside a sandbox";

  /** A loop whose steps ran in-process: every sandbox field is the console saying it has none. */
  const inProcess: TileZeroClawInput = {
    loopId: "loop-old",
    agentId: hexOf("old"),
    agentName: "old-watcher",
    loopStatus: "stopped",
    createdAt: NOW - 3 * DAY,
    sandboxed: false,
    wrapper: none(NOT_YET),
    binarySha256: none(NOT_YET),
    postureHash: none(NOT_YET),
    lastStep: {
      step: 3,
      seq: recorded("57"),
      ranAt: recorded(NOW - 2 * DAY),
      zcActions: none(STEP_NOT),
      replayable: false,
      workspace: none(STEP_NOT),
    },
  };

  /** A loop in a sandbox right now, whose last step wrote two `zc.*` Actions and a replay record. */
  const sandboxed: TileZeroClawInput = {
    loopId: "loop-sandbox",
    agentId: hexOf("sandbox"),
    agentName: "scratcher",
    loopStatus: "running",
    stepping: true,
    createdAt: NOW - DAY,
    sandboxed: true,
    wrapper: recorded({ kind: "bwrap", platform: "linux" }),
    binarySha256: recorded("ab".repeat(32)),
    postureHash: recorded("cd".repeat(32)),
    lastStep: {
      step: 2,
      seq: recorded("14"),
      ranAt: recorded(NOW - 5 * 60_000),
      zcActions: recorded(2),
      replayable: true,
      workspace: recorded({ bytes: 1536, files: 1, capBytes: 8 * 1024 * 1024, capFiles: 1000 }),
    },
  };

  /** A loop that has not stepped at all. */
  const fresh: TileZeroClawInput = {
    loopId: "loop-fresh",
    agentId: hexOf("fresh"),
    loopStatus: "running",
    createdAt: NOW - HOUR,
    sandboxed: false,
    wrapper: none("no step yet"),
    binarySha256: none("no step yet"),
    postureHash: none("no step yet"),
    lastStep: null,
  };

  it("says a loop whose steps ran in-process is not yet sandboxed, and draws no zero for it", () => {
    const [row] = zeroclawTileRows({ sandboxes: [inProcess], now: NOW });
    assert.equal(row.kind, "zeroclaw");
    assert.equal(row.testId, "zeroclaw-row");
    assert.equal(row.href, "/zeroclaw/loop-old");
    assert.equal(row.loopId, "loop-old");
    assert.equal(row.agentId, hexOf("old"));
    assert.equal(row.description, NOT_SANDBOXED_DESCRIPTION);
    assert.isTrue(row.descriptionPlaceholder);
    assert.equal(row.footRight, "not yet sandboxed", "no wrapper, no zc count and no workspace to put there");
    assert.notMatch(row.footRight, /\b0 zc\b/);
    assert.equal(row.footLeft, "seq 57 · 2 d ago", "the console's record of the last step when no header was read");
    assert.equal(row.footLeftSource, "console");
    assert.equal(row.status, "stopped");
    assert.equal(row.statusTone, "neutral", "a stopped loop is not a failure of its sandbox");
    const wrapper = row.fields.find((f) => f.label === "wrapper")!;
    assert.equal(wrapper.value, "—");
    assert.equal(wrapper.title, NOT_YET, "the dash carries the reason, not a guess");
    assert.equal(row.fields.find((f) => f.label === "zc actions")!.value, "—");
    assert.equal(row.fields.find((f) => f.label === "replayable")!.value, "no");
    assert.isNull(row.bins, "a sandbox tile reads no events");
  });

  it("carries a sandboxed step's wrapper, sandbox action count and workspace, and the header as chain", () => {
    const headers = { [hexOf("sandbox")]: { seq: 15n, updatedAtMs: NOW - 5 * 60_000 } };
    const [row] = zeroclawTileRows({ sandboxes: [sandboxed], headers, now: NOW });
    assert.equal(row.status, "stepping");
    assert.equal(row.statusLabel, "in a sandbox");
    assert.equal(row.statusTone, "cyan");
    assert.equal(row.footLeft, "seq 15 · 5 min ago");
    assert.equal(row.footLeftSource, "chain", "the header was read, so the seq is the chain's");
    assert.equal(row.footRight, "bwrap · 2 sandbox actions · 1.5 KiB/8.0 MiB");
    assert.equal(row.footRightSource, "console");
    assert.equal(row.description, "The last sandboxed step ran under bwrap on Linux.");
    assert.isFalse(row.descriptionPlaceholder);
    assert.deepEqual(
      row.fields.map((f) => f.label),
      [
        "wrapper",
        "binary sha256",
        "posture hash",
        "seq",
        "last step seq",
        "zc actions",
        "workspace",
        "replayable",
        "loop",
      ]
    );
    assert.equal(row.fields.find((f) => f.label === "seq")!.source, "chain");
    assert.equal(row.fields.find((f) => f.label === "zc actions")!.source, "console");
    const posture = row.fields.find((f) => f.label === "posture hash")!;
    assert.isTrue(posture.mono);
    assert.equal(posture.title, "cd".repeat(32), "the full hash is one hover away");
    assert.equal(row.fields.find((f) => f.label === "replayable")!.value, "yes");
    assert.isTrue(
      row.fields.every((f) => f.source === "chain" || f.source === "console"),
      "every hover-card field carries a tag"
    );
  });

  it("falls back to the console when the header read has not answered for that agent", () => {
    const [row] = zeroclawTileRows({
      sandboxes: [sandboxed],
      headers: { [hexOf("someone-else")]: { seq: 1n, updatedAtMs: NOW } },
      now: NOW,
    });
    assert.equal(row.footLeft, "seq 14 · 5 min ago");
    assert.equal(row.footLeftSource, "console");
    assert.isUndefined(row.fields.find((f) => f.label === "seq"));
  });

  it("reads a loop that has not stepped as having no step, not as step 0", () => {
    const [row] = zeroclawTileRows({ sandboxes: [fresh], now: NOW });
    assert.equal(row.footLeft, "no step yet");
    assert.isTrue(row.unnamed);
    assert.deepEqual(
      row.fields.map((f) => f.label),
      ["wrapper", "binary sha256", "posture hash", "loop"],
      "no step: nothing about a step on the card"
    );
  });

  it("sorts sandboxes by their last write, newest first", () => {
    const rows = zeroclawTileRows({ sandboxes: [inProcess, fresh, sandboxed], now: NOW });
    assert.deepEqual(
      rows.map((r) => r.loopId),
      ["loop-sandbox", "loop-fresh", "loop-old"],
      "a loop with no step sorts by its creation"
    );
  });

  it("prints bytes in binary units against the 8 MiB cap", () => {
    assert.equal(bytesLabel(0), "0 B");
    assert.equal(bytesLabel(1023), "1023 B");
    assert.equal(bytesLabel(1536), "1.5 KiB");
    assert.equal(bytesLabel(8 * 1024 * 1024), "8.0 MiB");
    assert.equal(bytesLabel(-1), "—");
  });
});

/**
 * One budget per loop: the readers every loop screen shares. An older row or draft carries only a
 * per-step figure, and each of them has to read it as the same
 * whole budget — `perStep × maxSteps` — or two screens would quote one loop two budgets.
 */
describe("loop budget readers", () => {
  it("reads a new row's budget as named and an old row's as perStep × maxSteps", () => {
    assert.equal(draftLoopBudget({ budgetMicroUsdc: "5000000", budgetMicroUsdcPerStep: "1", maxSteps: 6 }), "5000000");
    assert.equal(draftLoopBudget({ budgetMicroUsdcPerStep: "50000", maxSteps: 6 }), "300000");
    // Nothing to derive from: no figure rather than a zero, so a form falls back to its default chip.
    assert.isUndefined(draftLoopBudget({ budgetMicroUsdcPerStep: "50000" }));
    assert.isUndefined(draftLoopBudget({ budgetMicroUsdcPerStep: "0.05", maxSteps: 6 }), "not micro-USDC");
    assert.isUndefined(draftLoopBudget(undefined));
  });

  it("puts the whole budget on a new loop's tile, and nothing on one that names none", () => {
    const row = join({ loops: [{ ...runningLoop, budgetMicroUsdc: "5000000" }] }).loops.find(
      (l) => l.loopId === "loop-running"
    )!;
    // Spent against it, where the row carries a spend; the budget alone where it carries none.
    assert.include(row.footRight, "of 5 USDC spent");
    assert.notInclude(row.footRight, "/step");
    const unspent = join({
      loops: [{ ...runningLoop, budgetMicroUsdc: "5000000", totalCostMicroUsdc: undefined }],
    }).loops.find((l) => l.loopId === "loop-running")!;
    assert.include(unspent.footRight, "5.000000 budget");
    assert.isNull(loopBudgetFoot({ maxSteps: 3 }));
  });

  it("reads spent against the budget, members included, floored at zero left", () => {
    const f = loopBudgetFigures({
      maxSteps: 6,
      budgetMicroUsdcPerStep: "833333",
      budgetMicroUsdc: "5000000",
      totalCostMicroUsdc: "100000",
      spentMicroUsdc: "1250000",
      jevBudgetBase: "750000",
      jevSpentBase: "42",
    });
    assert.equal(f.budget, BigInt(5_000_000));
    assert.equal(f.spent, BigInt(1_250_000), "spentMicroUsdc, not totalCostMicroUsdc: it carries the members");
    assert.equal(f.remaining, BigInt(3_750_000));
    assert.equal(f.fraction, 0.25);
    assert.deepEqual(f.jev, { budget: BigInt(750_000), spent: BigInt(42), exhausted: false });

    // The call that crosses the line is paid for, so spent may pass the budget by one call.
    const over = loopBudgetFigures({
      maxSteps: 3,
      budgetMicroUsdcPerStep: "1",
      budgetMicroUsdc: "3",
      totalCostMicroUsdc: "5",
      spentMicroUsdc: "5",
      jevBudgetBase: "0",
      jevSpentBase: "0",
    });
    assert.equal(over.remaining, BigInt(0));
    assert.equal(over.fraction, 1);
    assert.isTrue(over.jev!.exhausted, "a zero Jev share is spent from the start");
  });

  it("reads an older console's row as its derived budget, with no Jev share", () => {
    const f = loopBudgetFigures({ maxSteps: 4, budgetMicroUsdcPerStep: "25000", totalCostMicroUsdc: "60000" });
    assert.equal(f.budget, BigInt(100_000));
    assert.equal(f.spent, BigInt(60_000));
    assert.equal(f.remaining, BigInt(40_000));
    assert.isNull(f.jev, "no share was kept, which is not the same as a spent one");
  });
});
