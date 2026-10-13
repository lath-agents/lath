import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { readLoops } from "../frontend/src/app/api/_lib/loops";
import {
  acquireRunSlot,
  readRegistry,
  recordAgent,
  runSlotHolder,
  updateAgent,
  type DeployedAgent,
} from "../frontend/src/app/api/_lib/runner";
import { readTemplates, recordTemplate } from "../frontend/src/app/api/_lib/templates";
import { writeJsonAtomic } from "../frontend/src/app/api/_lib/json-store";

/**
 * The two store guards. They are the only thing standing between an older store file and a
 * crashed route: `/loop/<id>` would read `maxWakes` rows and throw on `BigInt(undefined)`, and an
 * orphaned `kind: "swarm"` row typed as an agent would derive a key that owns nothing. Pure file
 * I/O — no chain, no validator.
 *
 * Both modules read `LATH_TRACE_DIR` once, at module load, so `./fixtures/trace-dir` is
 * imported first: it makes the directory and sets the variable before they are evaluated.
 */

const currentLoop = {
  id: "loop-current",
  agentId: "aa".repeat(32),
  owner: "So11111111111111111111111111111111111111112",
  prompt: "check the slot",
  intervalMs: 15_000,
  maxSteps: 3,
  budgetMicroUsdcPerStep: "50000",
  status: "paused",
  snapshot: { steps: 0 },
  history: [],
};

// The shape an older store holds for `loop.wake` records: no `maxSteps`, no
// `budgetMicroUsdcPerStep`, and the two keys that replaced them are absent.
const legacyLoop = {
  id: "loop-legacy",
  agentId: "bb".repeat(32),
  owner: "So11111111111111111111111111111111111111112",
  prompt: "wake and report",
  intervalMs: 15_000,
  maxWakes: 3,
  budgetMicroUsdcPerWake: "50000",
  status: "paused",
  snapshot: { steps: 0 },
  history: [],
};

const agentRow = {
  name: "seed-agent-alpha",
  authority: "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy",
  createdAt: 1,
  policy: {},
};
const swarmRow = {
  name: "chat-swarm-1",
  authority: "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy",
  createdAt: 1,
  policy: {},
  kind: "swarm",
};

describe("store guards", () => {
  it("readLoops drops a record that lacks the current keys", () => {
    fs.writeFileSync(
      path.join(traceDir, "loops.json"),
      JSON.stringify({ "loop-current": currentLoop, "loop-legacy": legacyLoop })
    );
    const loops = readLoops();
    assert.deepEqual(Object.keys(loops), ["loop-current"]);
  });

  it("readRegistry rejects a row of an owner kind this build does not have", () => {
    fs.writeFileSync(
      path.join(traceDir, "agents.json"),
      JSON.stringify({ agent1: agentRow, "chat-swarm-1": swarmRow })
    );
    const agents = readRegistry();
    assert.deepEqual(Object.keys(agents), ["agent1"]);
  });
});

/**
 * `agents.json` and `templates.json` are written whole after every read, and the read drops what
 * it cannot parse, so the next deploy or template save would erase a row this build does not read.
 * All three stores keep such rows aside, as `loops.json` does (`unreadRows`).
 */
describe("a row this build cannot read survives the next write", () => {
  const agentsFile = path.join(traceDir, "agents.json");
  const templatesFile = path.join(traceDir, "templates.json");
  const onDisk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

  it("keeps an unreadable agents.json row through a deploy and an update", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ agent1: agentRow, "chat-swarm-1": swarmRow }));
    recordAgent("agent2", { ...agentRow, name: "seed-agent-beta" } as DeployedAgent);
    updateAgent("agent1", (a) => ({ ...a, archivedAt: 5 }));
    const stored = onDisk(agentsFile);
    assert.deepEqual(stored["chat-swarm-1"], swarmRow, "kept exactly as it was");
    assert.equal(stored.agent1.archivedAt, 5);
    assert.equal(stored.agent2.name, "seed-agent-beta");
    assert.deepEqual(Object.keys(readRegistry()).sort(), ["agent1", "agent2"], "and still not read");
  });

  it("keeps an id with no readable version, and an unreadable version beside readable ones", () => {
    const owner = "So11111111111111111111111111111111111111112";
    const version = (n: number) => ({
      id: "tpl-mixed",
      kind: "loop",
      owner,
      name: "mixed",
      version: n,
      hash: `h${n}`,
      createdAt: n,
      config: { prompt: "p" },
    });
    // v2 lacks `hash`, the shape an older or newer build might leave.
    const { hash: _hash, ...unreadV2 } = version(2);
    const legacy = { unexpected: true };
    fs.writeFileSync(
      templatesFile,
      JSON.stringify({ "tpl-mixed": [version(1), unreadV2], "tpl-legacy": [legacy], "tpl-odd": "not a list" })
    );
    const appended = recordTemplate({
      id: "tpl-mixed",
      kind: "loop",
      owner,
      name: "mixed",
      config: { prompt: "q" } as any,
    });
    assert.equal(appended.version, 3, "numbered past the version this build could not read");
    const stored = onDisk(templatesFile);
    assert.deepEqual(stored["tpl-legacy"], [legacy]);
    assert.equal(stored["tpl-odd"], "not a list");
    assert.deepEqual(
      stored["tpl-mixed"].map((v: { version: number }) => v.version),
      [1, 2, 3],
      "the unread v2 kept in place, ascending"
    );
    assert.deepEqual(stored["tpl-mixed"][1], unreadV2);
    assert.deepEqual(
      readTemplates()["tpl-mixed"].map((v) => v.version),
      [1, 3]
    );
  });
});

/**
 * Two callers of one route share a label, so a slot matched on its label would let a holder whose
 * TTL lapsed release, in its `finally`, the slot the next caller had since taken under the same words.
 */
describe("the run slot is released only by the acquisition that holds it", () => {
  it("leaves a second holder's slot taken when the first, lapsed, releases under the same label", async () => {
    const first = acquireRunSlot("a store write", 1);
    assert.isNotNull(first);
    await new Promise((r) => setTimeout(r, 5));
    const second = acquireRunSlot("a store write", 60_000);
    assert.isNotNull(second, "the lapsed slot is free");
    first!.release();
    first!.extend(60_000);
    assert.equal(runSlotHolder(), "a store write", "still the second holder's");
    assert.isNull(acquireRunSlot("a store write", 60_000), "and nobody else gets it");
    second!.release();
    assert.isNull(runSlotHolder());
  });
});

/**
 * `agents.json`, `templates.json` and `loops.json` are written beside the file and renamed; with no
 * flush, a power loss could leave a zero-length store that every later read refuses. The bytes are
 * flushed before the rename and the directory after it.
 */
describe("a store write is flushed before it replaces the file", () => {
  it("syncs the temp file, renames it, then syncs the directory", () => {
    const order: string[] = [];
    // The module itself, not this file's namespace import of it, whose properties are getters.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeFs = require("fs") as typeof fs;
    const real = { fsyncSync: nodeFs.fsyncSync, renameSync: nodeFs.renameSync, openSync: nodeFs.openSync };
    const opened = new Map<number, string>();
    (nodeFs as any).openSync = (file: fs.PathLike, ...rest: any[]) => {
      const fd = (real.openSync as any)(file, ...rest);
      opened.set(fd, path.basename(String(file)));
      return fd;
    };
    (nodeFs as any).fsyncSync = (fd: number) => {
      order.push(`sync ${opened.get(fd)}`);
      return real.fsyncSync(fd);
    };
    (nodeFs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
      order.push("rename");
      return real.renameSync(from, to);
    };
    const dir = path.join(traceDir, "flushed");
    try {
      writeJsonAtomic(path.join(dir, "store.json"), { a: 1 });
    } finally {
      Object.assign(nodeFs, real);
    }
    assert.deepEqual(order, [`sync store.json.${process.pid}.tmp`, "rename", "sync flushed"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8")), { a: 1 });
  });
});
