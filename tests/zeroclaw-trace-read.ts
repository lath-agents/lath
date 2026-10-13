/**
 * What the host reads back from a sandbox: the host never reads a path
 * the sandbox could write through a symlink, a FIFO or a hard link, nor a file whole before it knows
 * its size.
 *
 * Two parts. `readTrace` itself, against a step's config directory laid out as a compromised binary
 * would leave it: a symlink at the trace or at any directory above it (the server keypair would
 * become a blob the loop's owner decrypts), a FIFO with no writer (a `readFileSync` of it blocked the
 * console's event loop for good, so that case runs in a child process under a deadline), a file over
 * 8 MiB, a hard link, and a normal trace still parsed. Then `ZeroClawRuntime` end to end, with a
 * stand-in binary that does the damage instead of answering: its step keeps no trace blob and says
 * why, and a workspace it turned into a symlink refuses the next step instead of granting its wrapper
 * the directory the link names.
 *
 * Node-only: temporary directories, the in-memory chain of `fixtures/fake-chain.ts`, a stand-in
 * spawned unwrapped through the runtime's test-only `spawner`, and nothing that can spend money.
 */
import { assert } from "chai";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { idFromString, MemoryTraceStore, sha256 } from "../sdk/src";
import { ChatRequest, ChatResult, ChatTransport, NoopBilling } from "../runtime/src";
import {
  readTrace,
  ZeroClawBinary,
  ZeroClawRuntime,
  ZeroClawRuntimeOptions,
  type SandboxSessionResult,
} from "../runtime/src/zeroclaw/runtime";
import { wrapperKind } from "../runtime/src/zeroclaw/posture";
import { FakeChain } from "./fixtures/fake-chain";

const PLATFORM = process.platform;
const SUPPORTED = PLATFORM === "darwin" || PLATFORM === "linux";
const TRACE = ["data", "state", "runtime-trace.jsonl"];
const SECRET = '[12,34,56,"the server keypair, which no blob may hold"]\n';
const RECORD = {
  event: "tool_call_result",
  tool: "file_write",
  output: "Written 4 bytes to a.txt",
  tool_call_id: "c1",
};

/** A fresh step config directory under `root`, with `data/state/` made. */
function cfgDir(root: string, name: string): string {
  const cfg = path.join(root, name, "cfg");
  fs.mkdirSync(path.join(cfg, "data", "state"), { recursive: true });
  return cfg;
}

describe("zeroclaw: the host's read of the runtime trace the sandbox leaves", function () {
  this.timeout(60_000);
  let root = "";
  let secret = "";

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync("/tmp/zct-"));
    secret = path.join(root, "id.json");
    fs.writeFileSync(secret, SECRET);
  });
  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("parses a regular trace and keeps its bytes", async () => {
    const cfg = cfgDir(root, "plain");
    const text = JSON.stringify(RECORD) + "\nnot json\n" + JSON.stringify({ event: "other" }) + "\n";
    fs.writeFileSync(path.join(cfg, ...TRACE), text);
    const trace = await readTrace(cfg);
    assert.notProperty(trace, "refused");
    assert.equal(Buffer.from(trace.bytes!).toString("utf8"), text);
    assert.deepEqual(trace.records, [{ tool: "file_write", output: "Written 4 bytes to a.txt", callId: "c1" }]);
  });

  it("is no trace, and no refusal, when the binary wrote none", async () => {
    const cfg = path.join(root, "none", "cfg");
    fs.mkdirSync(cfg, { recursive: true });
    assert.deepEqual(await readTrace(cfg), { records: [] });
    fs.mkdirSync(path.join(cfg, "data", "state"), { recursive: true });
    assert.deepEqual(await readTrace(cfg), { records: [] });
  });

  it("does not follow a symlink at the trace to a host file", async () => {
    const cfg = cfgDir(root, "link");
    fs.symlinkSync(secret, path.join(cfg, ...TRACE));
    const trace = await readTrace(cfg);
    assert.notProperty(trace, "bytes");
    assert.deepEqual(trace.records, []);
    assert.match(trace.refused!, /runtime-trace\.jsonl was not read: it is a symlink/);
  });

  it("does not follow a symlink at data/, data/state/ or the config directory itself", async () => {
    // A host directory holding a file under the trace's name, as a keys directory could be made to.
    const decoy = path.join(root, "decoy");
    fs.mkdirSync(path.join(decoy, "state"), { recursive: true });
    fs.writeFileSync(path.join(decoy, "state", "runtime-trace.jsonl"), SECRET);
    fs.writeFileSync(path.join(decoy, "runtime-trace.jsonl"), SECRET);

    const a = path.join(root, "dirlink-a", "cfg");
    fs.mkdirSync(a, { recursive: true });
    fs.symlinkSync(decoy, path.join(a, "data"));
    const b = path.join(root, "dirlink-b", "cfg");
    fs.mkdirSync(path.join(b, "data"), { recursive: true });
    fs.symlinkSync(path.join(decoy, "state"), path.join(b, "data", "state"));
    // Seatbelt's subpath covers `cfg` itself: removed and put back as a link to a host tree.
    const c = path.join(root, "dirlink-c");
    fs.mkdirSync(path.join(root, "decoy-cfg", "data"), { recursive: true });
    fs.symlinkSync(path.join(decoy), path.join(root, "decoy-cfg", "data", "state"));
    fs.mkdirSync(c, { recursive: true });
    fs.symlinkSync(path.join(root, "decoy-cfg"), path.join(c, "cfg"));

    for (const [cfg, where] of [
      [a, "data is a symlink"],
      [b, "data/state is a symlink"],
      [path.join(c, "cfg"), "the step's config directory is a symlink"],
    ]) {
      const trace = await readTrace(cfg);
      assert.notProperty(trace, "bytes", cfg);
      assert.include(trace.refused!, where);
    }
  });

  it("refuses a hard link and a trace over 8 MiB, reading neither", async () => {
    const linked = cfgDir(root, "hard");
    fs.writeFileSync(path.join(linked, "other"), JSON.stringify(RECORD) + "\n");
    fs.linkSync(path.join(linked, "other"), path.join(linked, ...TRACE));
    const h = await readTrace(linked);
    assert.notProperty(h, "bytes");
    assert.match(h.refused!, /2 hard links/);

    const big = cfgDir(root, "big");
    const file = path.join(big, ...TRACE);
    fs.writeFileSync(file, JSON.stringify(RECORD) + "\n");
    fs.truncateSync(file, 8 * 1024 * 1024 + 1);
    const o = await readTrace(big);
    assert.notProperty(o, "bytes");
    assert.deepEqual(o.records, []);
    assert.match(o.refused!, /8388609 bytes, over the 8388608/);

    // Exactly at the cap is a trace.
    fs.truncateSync(file, 8 * 1024 * 1024);
    const at = await readTrace(big);
    assert.notProperty(at, "refused");
    assert.equal(at.bytes!.length, 8 * 1024 * 1024);
    assert.lengthOf(at.records, 1);
  });

  it("returns at once on a FIFO with no writer (in a child process, under a deadline)", function () {
    if (!SUPPORTED) this.skip();
    const cfg = cfgDir(root, "fifo");
    const made = spawnSync("mkfifo", [path.join(cfg, ...TRACE)]);
    if (made.status !== 0) this.skip();
    // A blocking read of a FIFO cannot be timed out from inside the process it blocks, so the read
    // runs in a child the deadline kills; a pass is the child answering with the refusal.
    const repo = path.resolve(__dirname, "..");
    const script =
      `require(${JSON.stringify(path.join(repo, "runtime/src/zeroclaw/runtime.ts"))})` +
      `.readTrace(${JSON.stringify(cfg)}).then((t) => { process.stdout.write(JSON.stringify(t)); process.exit(0); })`;
    const r = spawnSync(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-r", "tsconfig-paths/register", "-e", script],
      {
        cwd: repo,
        env: { ...process.env, TS_NODE_PROJECT: path.join(repo, "tsconfig.json") },
        encoding: "utf8",
        timeout: 45_000,
        killSignal: "SIGKILL",
      }
    );
    assert.notEqual(r.signal, "SIGKILL", "the read of a FIFO blocked until the deadline killed it");
    assert.equal(r.status, 0, r.stderr);
    const trace = JSON.parse(r.stdout);
    assert.notProperty(trace, "bytes");
    assert.match(trace.refused, /it is a FIFO/);
  });
});

// ─── End to end: a stand-in binary that attacks the host's reads ─────────────

/**
 * The stand-in: it answers no model and calls no tool, only does what `MODE` says to the step's
 * config directory or the loop's workspace, prints `done` and exits 0 — a binary that was replaced
 * or compromised, running under the wrapper's grants (read and write on `work/` and `cfg/`).
 */
const STANDIN = `
const fs = require("fs");
const path = require("path");
const cfg = process.env.STUB_CFG;
const work = process.env.STUB_WORK;
const target = process.env.STUB_TARGET;
if (process.env.MODE === "trace-symlink") {
  fs.mkdirSync(path.join(cfg, "data", "state"), { recursive: true });
  fs.symlinkSync(target, path.join(cfg, "data", "state", "runtime-trace.jsonl"));
} else if (process.env.MODE === "work-symlink") {
  fs.rmSync(work, { recursive: true, force: true });
  fs.symlinkSync(target, work);
}
process.stdout.write("done\\n");
`;

/** No model is ever asked; a request would be a stand-in that did more than it should. */
class NoModel implements ChatTransport {
  async chat(_req: ChatRequest): Promise<ChatResult> {
    throw new Error("the stand-in asked the model");
  }
}

describe("zeroclaw: a step whose binary attacks the host's reads (stand-in, unwrapped)", function () {
  this.timeout(60_000);
  let root = "";
  let secretDir = "";
  let secret = "";
  let binary: ZeroClawBinary;
  let spawned = 0;

  before(function () {
    if (!SUPPORTED) this.skip();
    // Short and resolved: a socket path is at most 103 bytes to the binary on macOS.
    root = fs.realpathSync(fs.mkdtempSync("/tmp/zct-"));
    secretDir = path.join(root, "keys");
    fs.mkdirSync(secretDir);
    secret = path.join(secretDir, "id.json");
    fs.writeFileSync(secret, SECRET);
    const stub = path.join(root, "zeroclaw");
    fs.writeFileSync(stub, `#!${process.execPath}\n`, { mode: 0o755 });
    binary = {
      path: stub,
      sha256: createHash("sha256").update(fs.readFileSync(stub)).digest("hex"),
      patchSet: "stub-patchset",
      version: "zeroclaw 0.0.0-stub (lath) patchset=stub-patchset",
      platform: PLATFORM as "darwin" | "linux",
      wrapper: wrapperKind(PLATFORM),
      wrapperPath: PLATFORM === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap",
      libs: [],
    };
  });
  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function runtime(mode: string, target: string, home: string) {
    const store = new MemoryTraceStore();
    // The host paths the wrapper would have granted, from the spawn's own arguments: under `bwrap`
    // the `--bind` pairs, under `sandbox-exec` the paths themselves.
    const spawner = (file: string, args: string[], options: SpawnOptions): ChildProcess => {
      spawned++;
      const map: Record<string, string> = {};
      for (let i = 0; i + 2 < args.length; i++) {
        if ((args[i] === "--bind" || args[i] === "--ro-bind") && args[i + 2].startsWith("/lath/"))
          map[args[i + 2]] = args[i + 1];
      }
      const inside = args[args.indexOf("--config-dir") + 1];
      const cfg = map[inside] ?? inside;
      const toml = fs.readFileSync(path.join(cfg, "config.toml"), "utf8");
      const workInside = /^path = "(.+)"$/m.exec(toml.slice(toml.indexOf("[agents.lath.workspace]")))![1];
      const work = map[workInside] ?? workInside;
      const env = { ...(options.env as Record<string, string>), MODE: mode, STUB_CFG: cfg, STUB_WORK: work };
      return spawn(process.execPath, ["-e", STANDIN], { ...options, env: { ...env, STUB_TARGET: target } });
    };
    const rt = new ZeroClawRuntime({
      client: new FakeChain().asClient(),
      agentId: idFromString("zeroclaw-trace-read-agent"),
      transport: new NoModel(),
      store,
      billing: new NoopBilling(),
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => Date.UTC(2026, 8, 30, 12, 0, 0),
      policy: { model: "deepseek/deepseek-v4.1-flash", temperature: 0.2, toolAllowList: [], maxCost: 5_000_000 },
      tools: [],
      system: "You are one step of a loop.",
      zeroclaw: { binary, home, sandbox: "loop-zct", spawner, contextWindow: async () => undefined },
    } as ZeroClawRuntimeOptions);
    return { rt, store };
  }

  const USER = new PublicKey("11111111111111111111111111111112");

  it("keeps no blob of a trace the sandbox made a symlink to a host file, and says why", async () => {
    const { rt, store } = runtime("trace-symlink", secret, path.join(root, "h1"));
    const result = await rt.start({ user: USER, prompt: "p", sessionId: "loop-zct:step-1" });
    assert.equal(result.status, "success", result.reason);
    assert.equal(result.output, "done");
    const report = rt.stepReport()!;
    assert.notProperty(report, "traceHash");
    assert.match(report.traceRefused!, /runtime-trace\.jsonl was not read: it is a symlink/);
    assert.isNull(await store.get(sha256(Buffer.from(SECRET))), "the host file is in the step's store");
  });

  it("refuses the next step when the sandbox turned its workspace into a symlink, and spawns nothing", async () => {
    const home = path.join(root, "h2");
    const one = runtime("work-symlink", secretDir, home);
    const a = (await one.rt.start({ user: USER, prompt: "p", sessionId: "loop-zct:step-1" })) as SandboxSessionResult;
    // The step that did it is refused by the tree's walk, which is given the link.
    assert.equal(a.status, "failed");
    assert.match(a.sandboxRefused!, /workspace root .* is a symlink/);

    // A loop started again on the same sandbox: its workspace is not resolved through the link.
    spawned = 0;
    const two = runtime("none", secretDir, home);
    const b = (await two.rt.start({ user: USER, prompt: "p", sessionId: "loop-zct:step-2" })) as SandboxSessionResult;
    assert.equal(b.status, "failed");
    assert.match(b.sandboxRefused!, /the sandbox's workspace .*\/work is a symlink/);
    assert.equal(spawned, 0, "a sandbox was spawned with the link's target as its workspace");
    assert.deepEqual(fs.readdirSync(secretDir), ["id.json"], "the host directory was written");
  });
});
