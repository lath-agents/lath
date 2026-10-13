/**
 * `ZeroClawRuntime`, the sandbox a loop step runs in (docs/ARCHITECTURE.md §5).
 *
 * Every case but the last runs a **stub** of the Lath-patched binary: a Node script that plays
 * `zeroclaw --config-dir <cfg> agent -a lath -m <message>` exactly as `zeroclaw/CONTRACT.md` says —
 * it reads the `config.toml` the host wrote, talks to the metering proxy and the tools socket over
 * the two Unix sockets, runs `file_read` / `file_write` in the workspace itself, answers a name it
 * does not hold with `Unknown tool`, writes the runtime trace, and prints the final text. It runs
 * **unwrapped**, through the runtime's test-only `spawner`, which also lets the case read what the
 * host would have spawned: the wrapper, its arguments and the environment, whole.
 *
 * The last case is opt-in: with `LATH_ZEROCLAW_BIN` pointing at a real Lath build it runs the same
 * two steps under the real wrapper, and skips, saying so, without one.
 *
 * Node-only: temporary directories, the in-memory chain of `fixtures/fake-chain.ts`, scripted model
 * replies, and nothing that can spend money.
 */
import { assert } from "chai";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import {
  EpochStore,
  EventKind,
  hex,
  idFromString,
  loopManifestBytes,
  MemoryTraceStore,
  sha256,
  utf8,
} from "../sdk/src";
import {
  AgentRuntime,
  AgentRuntimeOptions,
  AnchorQueue,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatTransport,
  LoopRunner,
  MemoryAnchorJournal,
  NoopBilling,
  RuntimeEvent,
  ToolDefinition,
  canonicalJson,
  policyVersionHash,
  stepMessages,
} from "../runtime/src";
import {
  NOT_REPORTED_BACK,
  PostureRefused,
  ZeroClawBinary,
  ZeroClawRuntime,
  ZeroClawSandboxOptions,
  ZeroClawRuntimeOptions,
  ZeroClawUnavailable,
  SandboxRefused,
  type SandboxSessionResult,
  resolveZeroClaw,
  sandboxMessageText,
  sandboxStderr,
  sandboxPosture,
  stepMessageText,
  withSandbox,
} from "../runtime/src/zeroclaw/runtime";
import {
  KNOWN_CONTEXT_WINDOWS,
  contextWindowsFromModels,
  openRouterContextWindow,
  openRouterContextWindows,
  type ContextWindowLookup,
} from "../runtime/src/zeroclaw/context-window";
import { renderConfigToml, wrapperKind } from "../runtime/src/zeroclaw/posture";
import { decodeReplayRecord, zeroclawNow } from "../runtime/src/zeroclaw/replay";
import { sourceDir, sourcesHash, sourcesIndex, type SourcesManifest } from "../runtime/src/zeroclaw/sources";
import { EMPTY_WORKSPACE_HASH, sourcesTreeHash } from "../runtime/src/zeroclaw/workspace";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";

const T = Date.UTC(2026, 8, 24, 12, 0, 0, 250);
const NOW = zeroclawNow(T);
const MODEL = "deepseek/deepseek-v4.1-flash";
const USER = new PublicKey("11111111111111111111111111111112");
const PLATFORM = process.platform;
const SUPPORTED = PLATFORM === "darwin" || PLATFORM === "linux";

/**
 * The stub binary. Plain CommonJS so it runs under the same `node` with no loader, and with an
 * absolute shebang so `--version` answers under the empty environment the host probes it with.
 */
const STUB = `
const fs = require("fs");
const http = require("http");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("zeroclaw 0.0.0-stub (lath) patchset=stub-patchset\\n");
  process.exit(0);
}
// Under bwrap the sandbox's paths are the fixed /lath/* mounts; unwrapped, the test's spawner hands
// the stub the mounts as a map so it can find the same files on the host.
const MAP = JSON.parse(process.env.STUB_MAP || "{}");
function real(p) {
  for (const [inside, host] of Object.entries(MAP)) if (p === inside || p.startsWith(inside + "/")) return host + p.slice(inside.length);
  return p;
}
const cfgDir = real(args[args.indexOf("--config-dir") + 1]);
const message = args[args.indexOf("-m") + 1];
const toml = fs.readFileSync(path.join(cfgDir, "config.toml"), "utf8");
function get(section, key) {
  let at = "";
  for (const line of toml.split("\\n")) {
    const s = /^\\[(.+)\\]$/.exec(line);
    if (s) { at = s[1]; continue; }
    const kv = /^([a-z_]+) = (.*)$/.exec(line);
    if (kv && at === section && kv[1] === key) return JSON.parse(kv[2]);
  }
  throw new Error("config.toml has no " + section + "." + key);
}
const HOST = { store_get: "store.get", store_set: "store.set", solana_slot: "solana.slot",
  solana_fees: "solana.fees", solana_balance: "solana.balance", lath_verify_chain: "lath.verify_chain" };
const msock = real(get("providers.models.custom.lath", "unix_socket"));
const token = get("providers.models.custom.lath", "api_key");
const model = get("providers.models.custom.lath", "model");
const tsock = real(get("lath", "tools_socket"));
const ttoken = get("lath", "tools_token");
const work = real(get("agents.lath.workspace", "path"));
const allowed = get("risk_profiles.lath", "allowed_tools");
const maxIter = get("runtime_profiles.lath", "max_tool_iterations");
const now = process.env.ZEROCLAW_NOW;
const date = now.slice(0, 10);
const prefix = "[" + date + " " + now.slice(11, 19) + " +00:00]";
const traceFile = path.join(cfgDir, "data", "state", "runtime-trace.jsonl");
fs.mkdirSync(path.dirname(traceFile), { recursive: true });
function post(socketPath, urlPath, bearer, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({ socketPath, path: urlPath, method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + bearer } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(text);
  });
}
async function runTool(call) {
  const name = call.function.name;
  let a = {};
  try { a = JSON.parse(call.function.arguments || "{}"); } catch (e) {}
  if (!allowed.includes(name)) return "Unknown tool: " + name;
  if (name === "file_write") {
    // An OS refusal (a read-only sources/) is the tool's error result, as the binary reports one.
    try {
      const p = path.join(work, a.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, a.content);
    } catch (e) { return "Error: " + e.message; }
    return "Written " + Buffer.byteLength(a.content) + " bytes to " + a.path;
  }
  if (name === "file_read") {
    try { return fs.readFileSync(path.join(work, a.path), "utf8"); } catch (e) { return "Error: file not found: " + a.path; }
  }
  const r = await post(tsock, "/tools/" + HOST[name], ttoken, a);
  return r.status === 200 ? JSON.stringify(r.json.result) : "Error: " + r.json.error;
}
// A compromised binary: before its first turn it asks the tools socket for ids no honest
// build holds, with the step's own tools token. Unset in every case but the one that plays it.
const RAW_POSTS = JSON.parse(process.env.STUB_RAW_POSTS || "[]");
(async () => {
  for (const id of RAW_POSTS) await post(tsock, "/tools/" + id, ttoken, {});
  const tools = allowed.map((n) => ({ type: "function", function: { name: n, parameters: { type: "object", properties: {} } } }));
  const messages = [
    { role: "system", content: "## Tooling\\n\\n" + allowed.join(", ") + "\\n\\n## Current Date\\n\\n" + date +
      " (+00:00)\\n\\n## Runtime\\n\\nModel: " + model + "\\n" },
    { role: "user", content: prefix + " " + message },
  ];
  for (let i = 0; ; i++) {
    const r = await post(msock, "/v1/chat/completions", token,
      { messages, model, stream: false, temperature: 0.7, tool_choice: "auto", tools });
    if (r.status !== 200) { process.stderr.write("provider error " + r.status + ": " + JSON.stringify(r.json) + "\\n"); process.exit(2); }
    const reply = r.json.choices[0].message;
    messages.push(reply);
    if (!reply.tool_calls || reply.tool_calls.length === 0) { process.stdout.write(reply.content + "\\n"); process.exit(0); }
    for (const call of reply.tool_calls) {
      const out = await runTool(call);
      let a = {};
      try { a = JSON.parse(call.function.arguments || "{}"); } catch (e) {}
      if (!String(a.path || "").startsWith("notrace")) {
        fs.appendFileSync(traceFile, JSON.stringify({ event: "tool_call_result", tool: call.function.name, output: out }) + "\\n");
      }
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: out });
    }
    if (i + 1 >= maxIter) { process.stderr.write("reached max_tool_iterations (" + maxIter + ")\\n"); process.exit(1); }
  }
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\\n"); process.exit(3); });
`;

function writeExec(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return file;
}

function fileSha(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The context-window lookup every sandbox in this file gets unless a case passes its own: it knows no
 * model, so a step renders today's config, and no case reaches OpenRouter's model list.
 */
const noWindow: ContextWindowLookup = async () => undefined;

/** What a case may override in the suite's runtime: any option, and any part of the sandbox's. */
type RuntimeExtra = Omit<Partial<ZeroClawRuntimeOptions>, "zeroclaw"> & {
  home?: string;
  sandbox?: string;
  zeroclaw?: Partial<ZeroClawSandboxOptions>;
};

/** Removes a test root that may hold a seeded, read-only `sources/` (0555 directories). */
function removeTree(dir: string): void {
  spawnSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── A sandbox's sources ───────────────────────────────────────────────────────

const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const README = "github/Squads-Protocol/v4/programs/README.md";
const SOURCE_FILES: Record<string, string> = {
  [README]: "# squads\n",
  "github/Squads-Protocol/v4/programs/src/lib.rs": "fn main() {}\n",
  [`solana/devnet/${SQUADS}/account.json`]: '{"executable":true}\n',
};

/** A fetched directory as the console leaves it (`sources.fetched`), and the manifest committing it. */
function fetchedSources(dir: string): { dir: string; manifest: SourcesManifest } {
  for (const [p, body] of Object.entries(SOURCE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  const file = (p: string) => ({
    path: p,
    size: Buffer.byteLength(SOURCE_FILES[p]),
    sha256: createHash("sha256").update(SOURCE_FILES[p]).digest("hex"),
  });
  const github = {
    kind: "github" as const,
    input: "https://github.com/Squads-Protocol/v4/tree/main/programs",
    owner: "Squads-Protocol",
    repo: "v4",
    ref: "main",
    path: "programs",
    commit: "a".repeat(40),
  };
  const solana = { kind: "solana" as const, input: SQUADS, cluster: "devnet" as const, address: SQUADS, slot: "4123" };
  return {
    dir,
    manifest: {
      v: 1,
      sources: [
        {
          source: github,
          dir: sourceDir(github),
          files: [file(README), file("github/Squads-Protocol/v4/programs/src/lib.rs")],
        },
        { source: solana, dir: sourceDir(solana), files: [file(`solana/devnet/${SQUADS}/account.json`)] },
      ],
    },
  };
}

// ─── Scripted model replies ─────────────────────────────────────────────────

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

function reply(message: Partial<ChatMessage>, n: number): ChatResult {
  return {
    status: 200,
    body: {
      id: `gen-${n}`,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, ...message } as ChatMessage,
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
    },
  };
}

/** Answers from a queue, one reply per call, and keeps what it was sent. */
class Scripted implements ChatTransport {
  readonly seen: ChatRequest[] = [];
  // A field, not a parameter property: mocha loads a test through Node's own type stripping
  // first, which refuses parameter properties before ts-node is ever asked.
  private readonly replies: ChatResult[];
  constructor(replies: ChatResult[]) {
    this.replies = replies;
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.seen.push(JSON.parse(JSON.stringify(req)));
    const r = this.replies.shift();
    if (!r) throw new Error("the script ran out of replies");
    return r;
  }
}

function epochStore(): EpochStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(root: Uint8Array, blob: Uint8Array) {
      blobs.set(hex(root), blob);
    },
    async get(root: Uint8Array) {
      return blobs.get(hex(root)) ?? null;
    },
  } as EpochStore;
}

const slotTool: ToolDefinition = {
  name: "solana.slot",
  description: "The cluster's current slot and block time.",
  async execute() {
    return { slot: 42 };
  },
};

describe("zeroclaw: the sandbox a loop step runs in (stub binary, unwrapped)", function () {
  this.timeout(60_000);

  let root = "";
  let stub = "";
  let binary: ZeroClawBinary;
  const spawned: { file: string; args: string[]; options: SpawnOptions; toml: string }[] = [];
  /** Tools-socket ids the next stub POSTs before its first turn, playing a compromised sandbox. */
  let rawPosts: string[] = [];

  /**
   * The test-only spawner: records what the host would spawn — and the config it wrote — then runs
   * the stub without the wrapper. Under `bwrap` the sandbox's paths are mounts, so the stub is handed
   * them as a map; that one extra variable is added after the spawn's environment was recorded.
   */
  const spawner = (file: string, args: string[], options: SpawnOptions): ChildProcess => {
    const map: Record<string, string> = {};
    for (let i = 0; i + 2 < args.length; i++) {
      if ((args[i] === "--bind" || args[i] === "--ro-bind") && args[i + 2].startsWith("/lath/"))
        map[args[i + 2]] = args[i + 1];
    }
    const at = args.indexOf("--config-dir");
    const cfg = map[args[at + 1]] ?? args[at + 1];
    spawned.push({ file, args, options, toml: fs.readFileSync(path.join(cfg, "config.toml"), "utf8") });
    const env = {
      ...(options.env as Record<string, string>),
      STUB_MAP: JSON.stringify(map),
      ...(rawPosts.length ? { STUB_RAW_POSTS: JSON.stringify(rawPosts) } : {}),
    };
    return spawn(process.execPath, [stub, ...args.slice(at)], { ...options, env });
  };

  before(function () {
    if (!SUPPORTED) {
      console.log(`      skipped: no wrapper on ${PLATFORM}`);
      this.skip();
    }
    // Short and resolved: a socket path is at most 103 bytes to the binary on macOS.
    root = fs.realpathSync(fs.mkdtempSync("/tmp/zcr-"));
    stub = writeExec(path.join(root, "bin", "zeroclaw"), STUB);
    binary = {
      path: stub,
      sha256: fileSha(stub),
      patchSet: "stub-patchset",
      version: "zeroclaw 0.0.0-stub (lath) patchset=stub-patchset",
      platform: PLATFORM as "darwin" | "linux",
      wrapper: wrapperKind(PLATFORM),
      wrapperPath: PLATFORM === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap",
      libs: [],
    };
  });

  after(() => {
    if (root) removeTree(root);
  });

  beforeEach(() => {
    spawned.length = 0;
    rawPosts = [];
  });

  let sandboxes = 0;
  function runtime(
    transport: ChatTransport,
    extra: RuntimeExtra = {}
  ): { rt: ZeroClawRuntime; chain: FakeChain; events: RuntimeEvent[]; store: MemoryTraceStore; home: string } {
    const chain = new FakeChain();
    const events: RuntimeEvent[] = [];
    const store = new MemoryTraceStore();
    const home = extra.home ?? path.join(root, `h${sandboxes++}`);
    const rt = new ZeroClawRuntime({
      client: chain.asClient(),
      agentId: idFromString("zeroclaw-runtime-agent"),
      transport,
      store,
      billing: new NoopBilling(),
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => T,
      onEvent: (e) => events.push(e),
      policy: { model: MODEL, temperature: 0.2, toolAllowList: ["solana.slot"], maxCost: 5_000_000 },
      tools: [slotTool],
      system: "You are one step of a loop.",
      ...extra,
      zeroclaw: {
        binary,
        home,
        sandbox: extra.sandbox ?? "loop-zc",
        spawner,
        contextWindow: noWindow,
        ...(extra.zeroclaw ?? {}),
      },
    } as ZeroClawRuntimeOptions);
    return { rt, chain, events, store, home };
  }

  const trail = (events: RuntimeEvent[]) =>
    events.map((e) => (e.type === "action" ? `${e.toolId}:${e.statusCode}` : e.type));

  it("spawns under the wrapper with exactly the contract's environment, detached, stdin closed", async () => {
    const before = process.env.LATH_TEMPO_TREASURY;
    process.env.LATH_TEMPO_TREASURY = "0xsecret-that-must-not-reach-the-sandbox";
    try {
      const { rt } = runtime(new Scripted([reply({ content: "nothing changed" }, 1)]));
      const memory = { text: "the plan so far", hash: "ab".repeat(32), from: "step 1" };
      const result = await rt.start({ user: USER, prompt: "Watch the cluster.", sessionId: "loop-zc:step-2", memory });
      assert.equal(result.status, "success", result.reason);
      assert.equal(result.output, "nothing changed");

      assert.lengthOf(spawned, 1);
      const { file, args, options } = spawned[0];
      const env = options.env as Record<string, string>;
      assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "TZ", "ZEROCLAW_NOW", "ZEROCLAW_OMIT_HOST"]);
      assert.equal(env.TZ, "UTC");
      assert.equal(env.LANG, "C");
      assert.equal(env.ZEROCLAW_NOW, NOW);
      assert.equal(env.ZEROCLAW_OMIT_HOST, "1");
      assert.notInclude(JSON.stringify(options), "0xsecret");
      assert.isTrue(options.detached);
      assert.equal((options.stdio as string[])[0], "ignore");

      const at = args.indexOf("--config-dir");
      const cfg = args[at + 1];
      assert.deepEqual(args.slice(at + 2, at + 6), ["agent", "-a", "lath", "-m"]);
      // HOME is the step's config directory, as the sandbox sees it.
      assert.equal(env.HOME, cfg);
      if (PLATFORM === "darwin") {
        assert.equal(file, "/usr/bin/sandbox-exec");
        assert.equal(args[0], "-p");
        assert.include(args[1], "(deny default)");
        assert.equal(args[2], stub);
      } else {
        assert.equal(file, "/usr/bin/bwrap");
        assert.include(args, "--unshare-all");
        assert.equal(cfg, "/lath/cfg");
      }

      // The message is the in-process runtime's conversation, the same array, rendered once.
      const message = args[at + 6];
      const expected = stepMessageText(
        stepMessages({ system: "You are one step of a loop.", prompt: "Watch the cluster.", memory })
      );
      assert.equal(message, expected);
      assert.include(message, "the plan so far");

      // The step directory, with the token-bearing TOML and both sockets, is gone.
      if (PLATFORM === "darwin") assert.isFalse(fs.existsSync(path.dirname(cfg)));
    } finally {
      if (before === undefined) delete process.env.LATH_TEMPO_TREASURY;
      else process.env.LATH_TEMPO_TREASURY = before;
    }
  });

  it("sends the same messages an in-process session would, byte for byte", async () => {
    const plain = new Scripted([reply({ content: "ok" }, 1)]);
    const inProcess = new AgentRuntime({
      client: new FakeChain().asClient(),
      agentId: idFromString("zeroclaw-runtime-agent"),
      transport: plain,
      structures: false,
      publishPolicy: false,
      now: () => T,
      policy: { model: MODEL, temperature: 0.2, toolAllowList: [], maxCost: 5_000_000 },
      system: "You are one step of a loop.",
    } as AgentRuntimeOptions);
    const opts = {
      user: USER,
      prompt: "Watch the cluster.",
      goal: "Find the slot.",
      team: { names: ["a", "b"] },
    };
    await inProcess.start({ ...opts, sessionId: "plain" });
    const { rt } = runtime(new Scripted([reply({ content: "ok" }, 1)]));
    await rt.start({ ...opts, sessionId: "sandbox" });
    const at = spawned[0].args.indexOf("-m");
    assert.equal(spawned[0].args[at + 1], stepMessageText(plain.seen[0].messages));
  });

  it("commits the posture in the Genesis through policy.sandbox", async () => {
    const { rt, store } = runtime(new Scripted([reply({ content: "ok" }, 1)]));
    const policy = { model: MODEL, temperature: 0.2, toolAllowList: ["solana.slot"], maxCost: 5_000_000 };
    const posture = sandboxPosture({ toolAllowList: ["solana.slot"], binary });
    assert.deepEqual(rt.policy.sandbox, posture);
    assert.equal(posture.binarySha256, binary.sha256);
    assert.deepEqual(posture.config.risk_profile.allowed_tools, ["file_read", "file_write", "solana_slot"]);
    assert.equal(hex(rt.policyVersionHash), hex(policyVersionHash(withSandbox(policy, binary))));
    assert.notEqual(hex(rt.policyVersionHash), hex(policyVersionHash(policy)), "the posture moves the hash");

    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    const genesis = result.events.find((e) => e.input.kind === EventKind.Genesis) as any;
    const input = JSON.parse(Buffer.from((await store.get(genesis.inputHash))!).toString("utf8"));
    assert.equal(canonicalJson(input.policy.sandbox), canonicalJson(posture));

    // What the console records beside the step says the same, and holds no token.
    const report = rt.stepReport()!;
    assert.equal(report.postureJson, canonicalJson(posture));
    assert.equal(report.postureHash, hex(sha256(utf8(report.postureJson))));
    assert.equal(report.policyDocument, rt.policyDocument);
    assert.include(report.postureToml!, 'api_key = "<step token>"');
    assert.include(report.postureToml!, 'tools_token = "<step token>"');
    const tokens = [...spawned[0].toml.matchAll(/^(?:api_key|tools_token) = "([0-9a-f]{64})"$/gm)].map((m) => m[1]);
    assert.lengthOf(tokens, 2, "the sandbox got two tokens");
    assert.notEqual(tokens[0], tokens[1]);
    for (const t of tokens) assert.notInclude(JSON.stringify(report), t, "no token in the report");
    assert.equal(report.genesisSeq, genesis.seq.toString());
  });

  it("refuses a policy that names a web tool or the `lattice.verify_chain` alias, naming the tool", () => {
    for (const tool of ["web.fetch", "lattice.verify_chain"]) {
      let refused: unknown;
      try {
        runtime(new Scripted([]), {
          policy: { model: MODEL, temperature: 0.2, toolAllowList: [tool], maxCost: 1 },
          tools: [],
        });
      } catch (e) {
        refused = e;
      }
      assert.isTrue(PostureRefused.is(refused), tool);
      assert.equal((refused as PostureRefused).tool, tool);
    }
  });

  it("fails the step, before any sandbox, when the socket path would be too long for the binary", async () => {
    const long = path.join(root, "x".repeat(90));
    const transport = new Scripted([reply({ content: "ok" }, 1)]);
    const { rt, events } = runtime(transport, { home: long });
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(result.status, "failed");
    assert.match(result.reason!, /LATH_ZEROCLAW_HOME/);
    assert.lengthOf(spawned, 0);
    assert.lengthOf(transport.seen, 0, "nothing was paid for");
    assert.deepEqual(trail(events), ["genesis", "resolution"]);
    assert.match(rt.stepReport()!.refused!, /socket path/);
    // The loop's home is the loop's for its life: every step would be refused the same way.
    assert.equal((result as SandboxSessionResult).sandboxRefused, result.reason);
  });

  it("fails the step when the workspace is over the posture's cap, naming the cap", async () => {
    const transport = new Scripted([reply({ content: "ok" }, 1)]);
    const { rt, home } = runtime(transport);
    const work = path.join(home, "loops", "loop-zc", "work");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(result.status, "failed");
    assert.match(result.reason!, /cap \(the host's default\)/);
    // A tree refused before the sandbox is refused again on the next step: nothing resets it.
    assert.equal((result as SandboxSessionResult).sandboxRefused, result.reason, "the reason, byte for byte");
    assert.lengthOf(spawned, 0);
    assert.lengthOf(transport.seen, 0);
  });

  it("commits a lowered workspace cap in the posture and holds the sandbox to it", async () => {
    const cap = { maxBytes: 1024, maxFiles: 3 };
    const transport = new Scripted([reply({ content: "ok" }, 1)]);
    const { rt, home } = runtime(transport, { zeroclaw: { workspace: cap } } as RuntimeExtra);
    // Committed where the host's default cap is, and the hash a caller names beforehand (`withSandbox`, as a
    // team names its members' policies) is the one this sandbox's Genesis commits.
    assert.deepEqual(rt.policy.sandbox!.workspace, cap);
    const policy = { model: MODEL, temperature: 0.2, toolAllowList: ["solana.slot"], maxCost: 5_000_000 };
    assert.equal(
      hex(rt.policyVersionHash),
      hex(policyVersionHash(withSandbox(policy, binary, undefined, undefined, cap)))
    );
    assert.notEqual(hex(rt.policyVersionHash), hex(policyVersionHash(withSandbox(policy, binary))));
    // A policy that names the host's cap is not the posture this sandbox applies.
    assert.throws(
      () => runtime(new Scripted([]), { policy: withSandbox(policy, binary), zeroclaw: { workspace: cap } } as any),
      /not the posture this sandbox applies/
    );
    // Well under the host's default, over the owner's cap: the walk refuses it as it refuses the default's.
    const work = path.join(home, "loops", "loop-zc", "work");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "notes.md"), Buffer.alloc(cap.maxBytes + 1, 0x61));
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(result.status, "failed");
    assert.match(result.reason!, /1024-byte cap/);
    assert.lengthOf(spawned, 0);
    assert.lengthOf(transport.seen, 0, "nothing was paid for");
  });

  it("refuses a workspace cap above the host's default at construction", () => {
    assert.throws(
      () => runtime(new Scripted([]), { zeroclaw: { workspace: { maxFiles: 1001 } } } as RuntimeExtra),
      /above the host's cap/
    );
  });

  it("anchors a tool the model invented as a 404 under unknown:<the name it gave>", async () => {
    const { rt, events } = runtime(
      new Scripted([reply({ tool_calls: [toolCall("c1", "shell", { cmd: "ls" })] }, 1), reply({ content: "done" }, 2)])
    );
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(trail(events), [
      "genesis",
      `llm.${MODEL}:200`,
      "unknown:shell:404",
      `llm.${MODEL}:200`,
      "resolution",
    ]);
    assert.deepEqual(
      rt.stepReport()!.actions.map((a) => [a.tool, a.status]),
      [["unknown:shell", 404]]
    );
  });

  it("an invented call named like a record the host writes never carries that id", async () => {
    // `loop.step` is a checkpoint to every reader, `storage.put` a charge, `loop.settlement` a
    // settlement. Asked for by a model, each is a 404 under the prefix, answered or not.
    const reserved = ["loop.step", "loop_step", "storage.put", "loop.settlement", "oracle.feed", `llm.${MODEL}`];
    const { rt, events } = runtime(
      new Scripted([
        reply({ tool_calls: reserved.map((name, i) => toolCall(`r${i}`, name, { step: 999 })) }, 1),
        reply({ content: "done" }, 2),
      ])
    );
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(result.status, "success", result.reason);
    const actions = events.filter((e) => e.type === "action").map((e) => `${e.toolId}:${e.statusCode}`);
    assert.deepEqual(actions, [
      `llm.${MODEL}:200`,
      ...reserved.map((name) => `unknown:${name}:404`),
      `llm.${MODEL}:200`,
    ]);

    // And never answered: the sandbox stops before the request that would carry the result, so the
    // call is the end-of-step pass's, which records it under the same prefix.
    const unreported = runtime(new Scripted([reply({ tool_calls: [toolCall("u1", "loop.step", { step: 999 })] }, 1)]), {
      maxSteps: 1,
    });
    const failed = await unreported.rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(failed.status, "failed");
    assert.deepEqual(trail(unreported.events), ["genesis", `llm.${MODEL}:200`, "unknown:loop.step:404", "resolution"]);
  });

  it("a sandbox that asks the tools socket for an id the host writes has the refusal anchored under unknown:", async () => {
    // Prefixing the model's invented names is not enough: the tools socket's own refusal needs it
    // too. A compromised sandbox holding the step's tools token could POST /tools/loop.step, and an
    // unprefixed 403 Action whose reference is sha256("loop.step") would be a checkpoint to every
    // reader, and a record that fails every later --require-preimages audit of the chain for good.
    // A real host tool outside the policy keeps its own id.
    rawPosts = ["loop.step", "storage.put", "loop.settlement", "store.set"];
    const { rt, events } = runtime(new Scripted([reply({ content: "done" }, 1)]));
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(trail(events), [
      "genesis",
      "unknown:loop.step:403",
      "unknown:storage.put:403",
      "unknown:loop.settlement:403",
      "store.set:403",
      `llm.${MODEL}:200`,
      "resolution",
    ]);
  });

  it("anchors file calls never reported back — from the trace when it holds them, else as a 500", async () => {
    const { rt, events, store } = runtime(
      new Scripted([
        reply(
          {
            tool_calls: [
              toolCall("c1", "file_write", { path: "a.txt", content: "one\n" }),
              toolCall("c2", "file_write", { path: "notrace-b.txt", content: "two\n" }),
            ],
          },
          1
        ),
      ]),
      // One tool round and the sandbox stops, before the request that would carry the results.
      { maxSteps: 1 }
    );
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(result.status, "failed");
    assert.match(result.reason!, /exited 1: .*max_tool_iterations/);
    assert.deepEqual(trail(events), [
      "genesis",
      `llm.${MODEL}:200`,
      "zc.file_write:200",
      "zc.file_write:500",
      "resolution",
    ]);
    const actions = result.events.filter((e) => e.input.kind === EventKind.Action) as any[];
    const fromTrace = Buffer.from((await store.get(actions[1].resultHash))!).toString("utf8");
    const unreported = Buffer.from((await store.get(actions[2].resultHash))!).toString("utf8");
    assert.equal(fromTrace, "Written 4 bytes to a.txt");
    assert.equal(unreported, NOT_REPORTED_BACK);
    // The failed step still hashed and kept what it left in the workspace.
    const report = rt.stepReport()!;
    assert.equal(report.workspace!.files, 2);
    assert.exists(report.replayHash);
    assert.exists(report.traceHash);
    // A turn limit is the session's own failure, not one every later step would meet: no refusal.
    assert.notProperty(result, "sandboxRefused");
  });

  it("writes the model's context window into the step's config when the lookup knows it, and none when not", async () => {
    const asked: string[] = [];
    const known: ContextWindowLookup = async (model) => {
      asked.push(model);
      return model === MODEL ? 163_840 : undefined;
    };
    const one = runtime(new Scripted([reply({ content: "ok" }, 1)]), {
      zeroclaw: { contextWindow: known },
    } as RuntimeExtra);
    const a = await one.rt.start({ user: USER, prompt: "p", sessionId: "loop-zc:step-1" });
    assert.equal(a.status, "success", a.reason);
    assert.deepEqual(asked, [MODEL], "asked once, for the policy's model");
    assert.include(spawned[0].toml, "\ntemperature = 0.2\ncontext_window = 163840\n");
    // The step's report carries the config as written, so the window it ran with is on its row.
    assert.include(one.rt.stepReport()!.postureToml!, "context_window = 163840");
    const postureWith = one.rt.stepReport()!.postureHash;
    // And the replay record commits the same window, so a replayer rebuilds the config the sandbox ran.
    const withWindow = decodeReplayRecord(
      (await one.store.get(Buffer.from(one.rt.stepReport()!.replayHash!, "hex")))!
    )!;
    assert.equal(withWindow.contextWindow, 163_840);
    assert.deepEqual(one.rt.stepReport()!.replay, withWindow);

    // Unknown, thrown, or not a window the binary would take: the config is the one without the key.
    const cases: ContextWindowLookup[] = [
      noWindow,
      async () => {
        throw new Error("the list is down");
      },
      async () => 0,
      async () => 1.5,
    ];
    for (const lookup of cases) {
      spawned.length = 0;
      const other = runtime(new Scripted([reply({ content: "ok" }, 1)]), {
        zeroclaw: { contextWindow: lookup },
      } as RuntimeExtra);
      const r = await other.rt.start({ user: USER, prompt: "p", sessionId: "loop-zc:step-1" });
      assert.equal(r.status, "success", r.reason);
      assert.notInclude(spawned[0].toml, "context_window");
      // Per step, not posture: the window never moves the hash the Genesis commits.
      assert.equal(other.rt.stepReport()!.postureHash, postureWith);
      // No key in the TOML, no key in the record: the record's bytes are those of a record without the window.
      const record = decodeReplayRecord(
        (await other.store.get(Buffer.from(other.rt.stepReport()!.replayHash!, "hex")))!
      )!;
      assert.notProperty(record, "contextWindow");
    }
  });

  it("a wrapper that will not start the binary is SandboxRefused; a spawn that fails outright too", async () => {
    const wrapper = path.basename(binary.wrapperPath);
    // The wrapper speaking instead of the binary: its own name opens stderr, and it exits non-zero.
    const refusing = (_file: string, _args: string[], options: SpawnOptions): ChildProcess =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stderr.write(${JSON.stringify(`${wrapper}: execvp of the binary failed\n`)}); process.exit(65)`,
        ],
        options
      );
    const one = runtime(new Scripted([]), { zeroclaw: { spawner: refusing } } as RuntimeExtra);
    const a = (await one.rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" })) as SandboxSessionResult;
    assert.equal(a.status, "failed");
    assert.match(a.sandboxRefused!, new RegExp(`exited 65: ${wrapper}: execvp.*would not start the binary`));
    assert.equal(a.reason, a.sandboxRefused);

    // The binary or the wrapper gone since `resolveZeroClaw` cached its success.
    const gone = (_file: string, args: string[], options: SpawnOptions): ChildProcess =>
      spawn(path.join(root, "no-such-wrapper"), args, options);
    const two = runtime(new Scripted([]), { zeroclaw: { spawner: gone } } as RuntimeExtra);
    const b = (await two.rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" })) as SandboxSessionResult;
    assert.equal(b.status, "failed");
    assert.match(b.sandboxRefused!, /the sandbox could not be started: .*ENOENT/);

    // Any other non-zero exit is the session's own: a stderr that does not open with the wrapper's name.
    const crashing = (_file: string, _args: string[], options: SpawnOptions): ChildProcess =>
      spawn(process.execPath, ["-e", `process.stderr.write("thread 'main' panicked\\n"); process.exit(101)`], options);
    const three = runtime(new Scripted([]), { zeroclaw: { spawner: crashing } } as RuntimeExtra);
    const c = (await three.rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" })) as SandboxSessionResult;
    assert.equal(c.status, "failed");
    assert.match(c.reason!, /exited 101/);
    assert.notProperty(c, "sandboxRefused");
    assert.isTrue(SandboxRefused.is(new SandboxRefused("wrapper", "x")));
    assert.isFalse(SandboxRefused.is(new Error("x")));
  });

  it("refuses a spawn whose binary was rebuilt in place since it was resolved, before anything runs", async () => {
    // A binary of its own, so rewriting it leaves the one the other cases resolve alone. The spawner
    // runs the stub whatever path it is handed, so its bytes only have to be hashed.
    const copy = writeExec(path.join(root, "rebuilt", "zeroclaw"), "// the build the loop resolved\n");
    const pinned = { ...binary, path: copy, sha256: fileSha(copy) };
    const first = runtime(new Scripted([reply({ content: "ok" }, 1)]), {
      zeroclaw: { binary: pinned },
    } as RuntimeExtra);
    const a = await first.rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
    assert.equal(a.status, "success", a.reason);

    // `zeroclaw/build.sh` copying new bytes over the same path: same inode, a new size and mtime.
    fs.appendFileSync(copy, "\n// rebuilt\n");
    spawned.length = 0;
    const second = runtime(new Scripted([reply({ content: "ok" }, 1)]), {
      zeroclaw: { binary: pinned },
    } as RuntimeExtra);
    const b = (await second.rt.start({
      user: USER,
      prompt: "hi",
      sessionId: "loop-zc:step-2",
    })) as SandboxSessionResult;
    assert.equal(b.status, "failed");
    assert.match(b.sandboxRefused!, /changed since this loop resolved it/);
    assert.lengthOf(spawned, 0, "nothing was spawned on the new bytes");
  });

  it("a loop whose sandbox leaves the workspace over its cap stops after that step, with the tree's sentence", async () => {
    const cap = { maxBytes: 1024, maxFiles: 10 };
    const transport = new Scripted([
      // Step 1 writes past the owner's cap; the walk after the sandbox refuses the tree.
      reply({ tool_calls: [toolCall("c1", "file_write", { path: "big.md", content: "x".repeat(2000) })] }, 1),
      reply({ content: "Wrote it." }, 2),
      // Never reached: step 2 would be refused by the same walk before its sandbox, and paid for anyway.
      reply({ content: "step 2" }, 3),
    ]);
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new MemoryAnchorJournal(),
      billing,
      maxAttempts: 1,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    const events: RuntimeEvent[] = [];
    const { rt } = runtime(transport, {
      client: chain.asClient(),
      billing,
      onEvent: (e: RuntimeEvent) => events.push(e),
      rollup: { store: epochStore(), batchSize: 16 },
      anchor: { queue, drain: true },
      zeroclaw: { workspace: cap },
    } as RuntimeExtra);
    const runner = new LoopRunner({
      runtime: rt,
      loopId: "loop-zc",
      prompt: "Keep a plan in the workspace.",
      intervalMs: 0,
      maxSteps: 5,
      user: USER,
      startedAt: T,
      now: () => T,
      sleep: async () => undefined,
    });

    const one = await runner.step();
    assert.equal(one.status, "failed");
    assert.match(one.reason!, /1024-byte cap/);
    // The step ran and was paid for, so it is checkpointed like any failed step; the loop stops after it.
    assert.isTrue(one.leafOk);
    const snap = runner.snapshot();
    assert.equal(snap.status, "stopped");
    assert.equal(snap.stopReason, "sandbox");
    assert.equal(snap.stopDetail, `the sandbox refused step 1: ${one.reason}`, "the tree's sentence, whole");
    // Its Resolution is on chain as failed.
    const resolutions = events.filter((e) => e.type === "resolution");
    assert.lengthOf(resolutions, 1);
    assert.equal(resolutions[0].status, "failed");

    // No further step: no second Genesis, no second model call.
    let refused: unknown;
    try {
      await runner.step();
    } catch (e) {
      refused = e;
    }
    assert.match(String(refused), /is stopped \(sandbox\)/);
    assert.lengthOf(
      events.filter((e) => e.type === "genesis"),
      1
    );
    assert.lengthOf(transport.seen, 2, "step 2's reply was never asked for");
  });

  it("a step that leaves a root `skills` entry stops the loop before the next sandbox, with nothing deleted", async () => {
    const transport = new Scripted([
      // Step 1 writes the one name the Lath binary will not start beside; the step itself ran.
      reply({ tool_calls: [toolCall("c1", "file_write", { path: "skills", content: "a skill\n" })] }, 1),
      reply({ content: "Wrote it." }, 2),
      // Never reached: otherwise step 2's binary would exit at its own check and the loop pay on.
      reply({ content: "step 2" }, 3),
    ]);
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new MemoryAnchorJournal(),
      billing,
      maxAttempts: 1,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    const { rt, home } = runtime(transport, {
      client: chain.asClient(),
      billing,
      rollup: { store: epochStore(), batchSize: 16 },
      anchor: { queue, drain: true },
    } as RuntimeExtra);
    const runner = new LoopRunner({
      runtime: rt,
      loopId: "loop-zc",
      prompt: "Keep a plan in the workspace.",
      intervalMs: 0,
      maxSteps: 5,
      user: USER,
      startedAt: T,
      now: () => T,
      sleep: async () => undefined,
    });

    const one = await runner.step();
    assert.equal(one.status, "success", one.reason);
    const two = await runner.step();
    assert.equal(two.status, "failed");
    assert.match(two.reason!, /root `skills` entry/);
    const snap = runner.snapshot();
    assert.equal(snap.status, "stopped");
    assert.equal(snap.stopReason, "sandbox");
    assert.lengthOf(spawned, 1, "no sandbox for step 2");
    assert.lengthOf(transport.seen, 2, "nothing paid for step 2");
    // Left where the step put it: the committed tree holds it, and the next workspaceBefore must too.
    assert.equal(fs.readFileSync(path.join(home, "loops", "loop-zc", "work", "skills"), "utf8"), "a skill\n");
  });

  it("the binary refusing a `skills` entry is SandboxRefused; its other refusals are the session's own", async () => {
    const exiting =
      (stderr: string) =>
      (_file: string, _args: string[], options: SpawnOptions): ChildProcess =>
        spawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`], options);
    const one = runtime(new Scripted([]), {
      zeroclaw: {
        spawner: exiting(
          "Error: lath: refused `/workspace/skills`: the Lath build loads no skill, and a workspace skills directory would be one\n"
        ),
      },
    } as RuntimeExtra);
    const a = (await one.rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" })) as SandboxSessionResult;
    assert.equal(a.status, "failed");
    assert.match(a.sandboxRefused!, /exited 1: Error: lath: refused `\/workspace\/skills`/);
    assert.equal(a.reason, a.sandboxRefused);

    // A config key named after skills is not the workspace check.
    const two = runtime(new Scripted([]), {
      zeroclaw: { spawner: exiting("Error: lath: refused config key `skills`: not part of the Lath posture\n") },
    } as RuntimeExtra);
    const b = (await two.rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" })) as SandboxSessionResult;
    assert.equal(b.status, "failed");
    assert.notProperty(b, "sandboxRefused");
  });

  it("runs a two-step loop that writes a file in step 1 and reads it back in step 2", async () => {
    const transport = new Scripted([
      reply(
        {
          tool_calls: [
            toolCall("c1", "file_write", { path: "notes/plan.txt", content: "remember: 42\n" }),
            toolCall("c2", "solana_slot", {}),
          ],
        },
        1
      ),
      reply({ content: "Wrote the plan." }, 2),
      reply({ tool_calls: [toolCall("c3", "file_read", { path: "notes/plan.txt" })] }, 3),
      reply({ content: "Read it back: remember: 42" }, 4),
    ]);
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new MemoryAnchorJournal(),
      billing,
      maxAttempts: 1,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    const events: RuntimeEvent[] = [];
    const { rt, store } = runtime(transport, {
      client: chain.asClient(),
      billing,
      onEvent: (e: RuntimeEvent) => events.push(e),
      rollup: { store: epochStore(), batchSize: 16 },
      anchor: { queue, drain: true },
    } as Partial<ZeroClawRuntimeOptions>);
    const runner = new LoopRunner({
      runtime: rt,
      loopId: "loop-zc",
      prompt: "Keep a plan in the workspace.",
      intervalMs: 0,
      maxSteps: 2,
      user: USER,
      startedAt: T,
      now: () => T,
      sleep: async () => undefined,
    });

    const one = await runner.step();
    const two = await runner.step();
    assert.isTrue(one.leafOk && two.leafOk);
    assert.equal(one.status, "success", one.reason);
    assert.equal(two.status, "success", two.reason);

    const actions = events.filter((e) => e.type === "action").map((e) => `${e.toolId}:${e.statusCode}`);
    assert.includeMembers(actions, ["solana.slot:200", "zc.file_write:200", "zc.file_read:200"]);
    assert.isBelow(actions.indexOf("zc.file_write:200"), actions.indexOf("zc.file_read:200"));

    // Step 2's file_read Action commits what step 1 wrote.
    const read = transport.seen[3].messages.find((m) => m.role === "tool" && m.tool_call_id === "c3");
    assert.equal(read!.content, "remember: 42\n");

    // A replayHash in each manifest, each naming a stored record; step 2 starts where step 1 ended.
    const records = [];
    for (const stepped of [one, two]) {
      const h = stepped.manifest!.replayHash!;
      assert.match(h, /^[0-9a-f]{64}$/);
      assert.include(new TextDecoder().decode(loopManifestBytes(stepped.manifest!)), `"replayHash":"${h}"`);
      const record = decodeReplayRecord((await store.get(Buffer.from(h, "hex")))!);
      assert.exists(record);
      records.push(record!);
    }
    assert.equal(records[0].workspaceBefore, EMPTY_WORKSPACE_HASH);
    assert.equal(records[1].workspaceBefore, records[0].workspaceAfter);
    assert.equal(records[1].workspaceAfter, records[0].workspaceAfter, "step 2 only read");
    assert.equal(records[0].now, NOW);
    assert.equal(records[0].workspacePath.endsWith("/work"), true);
    assert.isAbove(records[0].seqs.length, 2);
    // The file and the message are blobs of the step.
    assert.deepEqual(await store.get(sha256(utf8("remember: 42\n"))), utf8("remember: 42\n"));
    assert.exists(await store.get(Buffer.from(records[0].messageHash, "hex")));
  });

  describe("a loop with sources", () => {
    let fetchedN = 0;
    const fetched = () => fetchedSources(path.join(root, `fetched-${fetchedN++}`));
    const messageOf = (i: number) => spawned[i].args[spawned[i].args.indexOf("-m") + 1];

    it("reads sources/ (200), fails to write into it (500), writes its own file, and step 2 starts where step 1 ended", async function () {
      // The unwrapped stub's only guard on sources/ is the mode on disk, which root ignores; the
      // wrapper's rule is the air-gap suite's to prove.
      if (process.getuid?.() === 0) {
        console.log("      skipped: running as root, whom a 0555 directory does not stop");
        this.skip();
      }
      const src = fetched();
      const transport = new Scripted([
        reply(
          {
            tool_calls: [
              toolCall("c1", "file_read", { path: `sources/${README}` }),
              toolCall("c2", "file_write", { path: `sources/${README}`, content: "overwritten\n" }),
              toolCall("c3", "file_write", { path: "notes.md", content: "mine\n" }),
            ],
          },
          1
        ),
        reply({ content: "Read the sources." }, 2),
        reply({ content: "Nothing new." }, 3),
      ]);
      const chain = new FakeChain();
      const billing = new RecordingBilling();
      const queue = new AnchorQueue({
        client: chain.asClient(),
        journal: new MemoryAnchorJournal(),
        billing,
        maxAttempts: 1,
        indexerWaitMs: 200,
        retryDelayMs: 5,
      });
      const events: RuntimeEvent[] = [];
      const { rt, store, home } = runtime(transport, {
        client: chain.asClient(),
        billing,
        onEvent: (e: RuntimeEvent) => events.push(e),
        rollup: { store: epochStore(), batchSize: 16 },
        anchor: { queue, drain: true },
        zeroclaw: { sources: src },
      } as RuntimeExtra);

      // The posture commits the manifest, and a caller naming the hash first names the same one.
      const policy = { model: MODEL, temperature: 0.2, toolAllowList: ["solana.slot"], maxCost: 5_000_000 };
      assert.equal(rt.policy.sandbox!.sources!.hash, sourcesHash(src.manifest));
      assert.equal(
        hex(rt.policyVersionHash),
        hex(policyVersionHash(withSandbox(policy, binary, undefined, src.manifest)))
      );
      assert.notEqual(hex(rt.policyVersionHash), hex(policyVersionHash(withSandbox(policy, binary))));

      const runner = new LoopRunner({
        runtime: rt,
        loopId: "loop-zc",
        prompt: "Audit the program.",
        intervalMs: 0,
        maxSteps: 2,
        user: USER,
        startedAt: T,
        now: () => T,
        sleep: async () => undefined,
      });
      const one = await runner.step();
      const two = await runner.step();
      assert.equal(one.status, "success", one.reason);
      assert.equal(two.status, "success", two.reason);

      const actions = events.filter((e) => e.type === "action").map((e) => `${e.toolId}:${e.statusCode}`);
      const files = actions.filter((a) => a.startsWith("zc."));
      assert.deepEqual(files, ["zc.file_read:200", "zc.file_write:500", "zc.file_write:200"]);
      const read = transport.seen[1].messages.find((m) => m.role === "tool" && m.tool_call_id === "c1");
      assert.equal(read!.content, "# squads\n");
      const work = path.join(home, "loops", "loop-zc", "work");
      assert.equal(fs.readFileSync(path.join(work, "sources", README), "utf8"), "# squads\n", "the write did not land");
      assert.equal(fs.readFileSync(path.join(work, "notes.md"), "utf8"), "mine\n");

      // Step 1 starts from the seeded sources' tree, step 2 from what step 1 left.
      const records = [];
      for (const stepped of [one, two]) {
        records.push(decodeReplayRecord((await store.get(Buffer.from(stepped.manifest!.replayHash!, "hex")))!)!);
      }
      assert.equal(records[0].workspaceBefore, sourcesTreeHash(src.manifest));
      assert.notEqual(records[0].workspaceBefore, EMPTY_WORKSPACE_HASH);
      assert.equal(records[1].workspaceBefore, records[0].workspaceAfter);

      // The index opens both steps' messages: the same prefix, byte for byte.
      const index = sourcesIndex(src.manifest);
      assert.lengthOf(spawned, 2);
      for (const i of [0, 1])
        assert.isTrue(messageOf(i).startsWith(`${index}\n`), `step ${i + 1} opens with the index`);
      assert.notEqual(messageOf(0), messageOf(1), "the rest of the message is the step's own");

      // The sources are the manifest's blobs, never re-stored as a step's; what the step wrote is.
      // (Not README.md: the file_read's result is its content, and the Action stores its result.)
      assert.isNull(await store.get(sha256(utf8("fn main() {}\n"))));
      assert.deepEqual(await store.get(sha256(utf8("mine\n"))), utf8("mine\n"));

      const report = rt.stepReport()!;
      assert.deepEqual(report.sources, { hash: sourcesHash(src.manifest), manifest: src.manifest });
      assert.equal(report.workspace!.files, 1, "sources/ is not counted against the workspace cap");
      if (PLATFORM === "darwin") {
        assert.include(spawned[0].args[1], `(deny file-write* (subpath "${fs.realpathSync(work)}/sources"))`);
      } else {
        assert.include(spawned[0].args.join(" "), `--ro-bind ${fs.realpathSync(work)}/sources /lath/work/sources`);
      }
    });

    it("refuses step 2, before any sandbox or payment, when sources/ was edited between steps", async () => {
      const src = fetched();
      const transport = new Scripted([reply({ content: "step one" }, 1), reply({ content: "never" }, 2)]);
      const { rt, home } = runtime(transport, { zeroclaw: { sources: src } } as RuntimeExtra);
      const first = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
      assert.equal(first.status, "success", first.reason);

      const file = path.join(home, "loops", "loop-zc", "work", "sources", README);
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, "# edited on the host\n");
      const second = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-2" });
      assert.equal(second.status, "failed");
      assert.match(second.reason!, /does not match the manifest its posture commits/);
      assert.include(second.reason!, `sources/${README}`);
      assert.lengthOf(spawned, 1, "no sandbox for step 2");
      assert.lengthOf(transport.seen, 1, "nothing paid for step 2");
    });

    it("seeds a member's sandbox with the same sources, and opens its message with the same index", async () => {
      const src = fetched();
      const lead = runtime(new Scripted([reply({ content: "lead" }, 1)]), {
        zeroclaw: { sources: src },
      } as RuntimeExtra);
      const a = await lead.rt.start({ user: USER, prompt: "lead the team", sessionId: "loop-zc:step-1" });
      const member = runtime(new Scripted([reply({ content: "member" }, 1)]), {
        home: lead.home,
        sandbox: "loop-zc/m/alice",
        zeroclaw: { sources: src },
      } as RuntimeExtra);
      const m = await member.rt.start({ user: USER, prompt: "read the program", sessionId: "loop-zc:step-1:alice" });
      assert.equal(a.status, "success", a.reason);
      assert.equal(m.status, "success", m.reason);
      const index = sourcesIndex(src.manifest);
      assert.isTrue(messageOf(0).startsWith(index) && messageOf(1).startsWith(index));
      const memberRecord = decodeReplayRecord((await member.store.get(Buffer.from(m.replayHash!, "hex")))!)!;
      assert.equal(memberRecord.workspaceBefore, sourcesTreeHash(src.manifest));
      const own = path.join(lead.home, "loops", "loop-zc", "m", "alice", "work", "sources", README);
      assert.equal(fs.readFileSync(own, "utf8"), "# squads\n", "its own copy, in its own workspace");
      assert.equal(member.rt.policy.sandbox!.sources!.hash, lead.rt.policy.sandbox!.sources!.hash);
    });

    it("adds nothing for a manifest with no sources: today's posture and message", async () => {
      const empty = { dir: path.join(root, "bin"), manifest: { v: 1 as const, sources: [] } };
      const { rt } = runtime(new Scripted([reply({ content: "ok" }, 1)]), {
        zeroclaw: { sources: empty },
      } as RuntimeExtra);
      assert.notProperty(rt.policy.sandbox!, "sources");
      assert.deepEqual(rt.policy.sandbox, sandboxPosture({ toolAllowList: ["solana.slot"], binary }));
      const r = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-zc:step-1" });
      assert.equal(r.status, "success", r.reason);
      assert.notProperty(rt.stepReport()!, "sources");
      assert.equal(sandboxMessageText([{ role: "user", content: "x" }], empty.manifest), "x");
    });

    it("refuses, at construction, sources it could never seed a sandbox from", () => {
      const src = fetched();
      const bad: [string, { dir: string; manifest: SourcesManifest }, RegExp][] = [
        ["relative", { ...src, dir: "fetched" }, /not absolute/],
        ["missing", { ...src, dir: path.join(root, "no-such-dir") }, /does not exist/],
        [
          "in a workspace",
          { ...src, dir: path.join(root, "hx", "loops", "loop-zc", "work", "f") },
          /inside a sandbox's workspace/,
        ],
        [
          "not canonical",
          { ...src, manifest: { ...src.manifest, sources: [{ ...src.manifest.sources[0], dir: "elsewhere" }] } },
          /not a canonical/,
        ],
      ];
      for (const [what, sources, why] of bad) {
        assert.throws(
          () => runtime(new Scripted([]), { home: path.join(root, "hx"), zeroclaw: { sources } } as any),
          why,
          what
        );
      }
    });
  });

  describe("resolveZeroClaw: no working Lath binary is a refusal with the reason", () => {
    it("with no binary set and none on PATH", () => {
      assert.throws(() => resolveZeroClaw({ bin: "", pathEnv: path.join(root, "empty") }), /LATH_ZEROCLAW_BIN/);
    });

    it("with a file that does not exist, or is not executable", () => {
      assert.throws(() => resolveZeroClaw({ bin: path.join(root, "nope") }), /does not exist/);
      const plain = path.join(root, "bin", "plain");
      fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
      assert.throws(() => resolveZeroClaw({ bin: plain }), /not executable/);
    });

    it("with a --version that does not answer", () => {
      const mute = writeExec(path.join(root, "bin", "mute"), "process.exit(3);\n");
      const err = (() => {
        try {
          resolveZeroClaw({ bin: mute });
        } catch (e) {
          return e;
        }
      })();
      assert.isTrue(ZeroClawUnavailable.is(err));
      assert.match((err as Error).message, /--version did not answer \(exit 3\)/);
    });

    it("with a binary that is not the Lath build, or a build record for other bytes", () => {
      const stock = writeExec(path.join(root, "bin", "stock"), 'console.log("zeroclaw 0.7.5");\n');
      assert.throws(() => resolveZeroClaw({ bin: stock }), /not the Lath build/);
      fs.writeFileSync(`${stock}.sha256`, `${"0".repeat(64)}  zeroclaw  x  upstream=x  patchset=abc\n`);
      assert.throws(() => resolveZeroClaw({ bin: stock }), /names another binary/);
    });

    it("with a wrapper that cannot start", () => {
      assert.throws(
        () => resolveZeroClaw({ bin: stub, wrapperPath: path.join(root, "no-such-wrapper") }),
        /cannot start a profile|cannot make namespaces|no bwrap/
      );
    });

    it("and reads the patch set from the build record beside the binary when the wrapper works", () => {
      const built = writeExec(path.join(root, "bin", "built"), 'console.log("zeroclaw 0.7.5");\n');
      fs.writeFileSync(`${built}.sha256`, `${fileSha(built)}  zeroclaw  x  upstream=dc372cc  patchset=feed\n`);
      try {
        const b = resolveZeroClaw({ bin: built });
        assert.equal(b.patchSet, "feed");
        assert.equal(b.sha256, fileSha(built));
        assert.equal(b.wrapper, wrapperKind(PLATFORM));
      } catch (e) {
        // A Linux host with no usable bwrap refuses here, which is the refusal such a host must give.
        assert.isTrue(ZeroClawUnavailable.is(e));
        assert.match((e as Error).message, /bwrap/);
      }
    });
  });
});

describe("zeroclaw: a sandbox's stderr in the console's words", () => {
  // A refusal that quoted ZeroClaw's timeout sentence would make the sandbox page say a word
  // nothing on screen may say.
  const WORD = new RegExp(`\\b${"provi" + "der"}s?\\b`, "i");

  it("rewrites upstream's timeout sentence whole", () => {
    const raw =
      "Error: The selected model " + "provi" + "der timed out. Try again or choose another " + "provi" + "der.";
    assert.equal(sandboxStderr(raw), "Error: The model timed out upstream.");
  });

  it("leaves no use of the word in any other message, and every other byte as it was", () => {
    const raw = "provi" + "der error 500: {}; Model " + "Provi" + "ders unavailable; exit 3";
    const out = sandboxStderr(raw);
    assert.notMatch(out, WORD);
    assert.equal(out, "upstream error 500: {}; model's upstream unavailable; exit 3");
    assert.equal(sandboxStderr("reached max_tool_iterations (8)"), "reached max_tool_iterations (8)");
  });
});

describe("zeroclaw: the model's context window, from OpenRouter's list (no network)", () => {
  const LIST = {
    data: [
      { id: MODEL, canonical_slug: "deepseek/deepseek-v4.1-flash-20260901", context_length: 163_840 },
      { id: "anthropic/claude-sonnet-5", context_length: 1_000_000 },
      { id: "broken/zero", context_length: 0 },
      { id: "broken/float", context_length: 1.5 },
      { id: "broken/none" },
    ],
  };
  function stubFetch(body: unknown = LIST, ok = true) {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (body instanceof Error) throw body;
      return { ok, status: ok ? 200 : 503, json: async () => body };
    };
    return { fetch, calls };
  }

  it("reads id and canonical_slug to a positive integer window, and skips any other row", () => {
    const w = contextWindowsFromModels(LIST);
    assert.equal(w.get(MODEL), 163_840);
    assert.equal(w.get("deepseek/deepseek-v4.1-flash-20260901"), 163_840);
    assert.equal(w.get("anthropic/claude-sonnet-5"), 1_000_000);
    for (const id of ["broken/zero", "broken/float", "broken/none"]) assert.isFalse(w.has(id), id);
    assert.equal(contextWindowsFromModels({ nope: 1 }).size, 0);
    assert.equal(contextWindowsFromModels(null).size, 0);
  });

  it("fetches the list once for every model and step, and knows a :variant by its model", async () => {
    const { fetch, calls } = stubFetch();
    const lookup = openRouterContextWindows({ fetch });
    assert.equal(await lookup(MODEL), 163_840);
    assert.equal(await lookup(`${MODEL}:nitro`), 163_840);
    assert.equal(await lookup("anthropic/claude-sonnet-5"), 1_000_000);
    assert.isUndefined(await lookup("unknown/model"));
    assert.isUndefined(await lookup("broken/zero"));
    assert.deepEqual(calls, ["https://openrouter.ai/api/v1/models"]);
  });

  it("forgets a failed read at once: the next call reads the list again, with no cool-down", async () => {
    // A failed read kept for five minutes would hold the next steps at ZeroClaw's 32k fallback for
    // that long. The call after a failure reads again, and the read that works is
    // kept for every later call.
    let down = true;
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (down) throw new Error("timed out");
      return { ok: true, status: 200, json: async () => LIST };
    };
    const lookup = openRouterContextWindows({ fetch, known: new Map() });
    assert.isUndefined(await lookup(MODEL), "no list and no table: no window");
    assert.isUndefined(await lookup(MODEL));
    assert.lengthOf(calls, 2, "each call after a failure reads again");
    down = false;
    assert.equal(await lookup(MODEL), 163_840, "the next call after the outage has the window");
    assert.equal(await lookup("anthropic/claude-sonnet-5"), 1_000_000);
    assert.lengthOf(calls, 3, "and a read that worked is kept");

    for (const failing of [stubFetch(LIST, false), stubFetch({ data: [] }), stubFetch({ error: "busy" })]) {
      const once = openRouterContextWindows({ fetch: failing.fetch, known: new Map() });
      assert.isUndefined(await once(MODEL), "a non-2xx or a body with no readable row is a failure");
      await once(MODEL);
      assert.lengthOf(failing.calls, 2, "and is not kept either");
    }
  });

  it("shares one read between the calls made while it is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      await gate;
      return { ok: true, status: 200, json: async () => LIST };
    };
    const lookup = openRouterContextWindows({ fetch, known: new Map() });
    const both = Promise.all([lookup(MODEL), lookup(`${MODEL}:nitro`)]);
    release();
    assert.deepEqual(await both, [163_840, 163_840]);
    assert.lengthOf(calls, 1);
  });

  it("answers from the table copied from the list while the list cannot be read, and nothing else", async () => {
    const down = stubFetch(new Error("offline"));
    const lookup = openRouterContextWindows({ fetch: down.fetch });
    assert.equal(await lookup(MODEL), 1_048_576, "the console's default model, as the list stated it");
    assert.equal(await lookup(`${MODEL}:nitro`), 1_048_576, "a :variant by its model, as for the list");
    assert.isUndefined(await lookup("anthropic/claude-sonnet-5"), "a model the table does not name is not guessed");
    // The live list wins over the table whenever it is read, even where the two disagree.
    assert.equal(await openRouterContextWindows({ fetch: stubFetch().fetch })(MODEL), 163_840);

    // The table names only models the console offers, each a positive integer, the default among them:
    // a model added to `MODELS` without a row falls back to upstream's 32k only when the list is down
    // too, and a row for a model the console does not offer is a figure nobody re-reads.
    const runner = fs.readFileSync(path.join(__dirname, "../frontend/src/app/api/_lib/runner.ts"), "utf8");
    const set = runner.slice(runner.indexOf("export const MODELS = new Set(["));
    const offered = new Set([...set.slice(0, set.indexOf("]);")).matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]));
    assert.include([...offered], MODEL);
    assert.isTrue(KNOWN_CONTEXT_WINDOWS.has(MODEL));
    for (const [id, n] of KNOWN_CONTEXT_WINDOWS) {
      assert.isTrue(offered.has(id), `${id} is not in MODELS`);
      assert.isTrue(Number.isSafeInteger(n) && n > 0, `${id}: ${n}`);
    }
  });

  it("reads the list before any step asks (the console's start), and keeps the read for the steps", async () => {
    const { fetch, calls } = stubFetch();
    const lookup = openRouterContextWindows({ fetch, known: new Map() });
    assert.isTrue(await lookup.prefetch());
    assert.equal(await lookup(MODEL), 163_840);
    assert.isTrue(await lookup.prefetch());
    assert.lengthOf(calls, 1, "the steps reuse the start's read");

    const down = stubFetch(new Error("offline"));
    const cold = openRouterContextWindows({ fetch: down.fetch, known: new Map() });
    assert.isFalse(await cold.prefetch(), "a failed start says so");
    await cold(MODEL);
    assert.lengthOf(down.calls, 2, "and the first step reads again");
  });

  it("keeps the process's lookup on globalThis, so the start and the loop route share one read", () => {
    // Next compiles instrumentation.ts and each route into module graphs of their own; a module-level
    // lookup would be one per graph, and the start's read would fill a cache no step reads.
    const g = globalThis as unknown as Record<symbol, unknown>;
    assert.strictEqual(g[Symbol.for("lath.zeroclaw.openRouterContextWindow")], openRouterContextWindow);
    assert.isFunction(openRouterContextWindow.prefetch);
  });
});

/**
 * The same two steps with the real Lath-patched binary under the real wrapper, once
 * `zeroclaw/build.sh` has built it: `LATH_ZEROCLAW_BIN=zeroclaw/.build/zeroclaw`. Skipped, saying so, without it.
 */
describe("zeroclaw: the sandbox with the real Lath build (opt-in, LATH_ZEROCLAW_BIN)", function () {
  this.timeout(240_000);
  let binary: ZeroClawBinary;
  let root = "";

  before(function () {
    const bin = process.env.LATH_ZEROCLAW_BIN;
    if (!bin) {
      console.log("      skipped: LATH_ZEROCLAW_BIN is not set to a Lath build");
      this.skip();
    }
    binary = resolveZeroClaw({ bin });
    root = fs.realpathSync(fs.mkdtempSync("/tmp/zcl-"));
  });

  after(() => {
    if (root) removeTree(root);
  });

  it("writes a file in step 1 and reads it back in step 2, under the wrapper", async () => {
    const transport = new Scripted([
      reply({ tool_calls: [toolCall("c1", "file_write", { path: "plan.txt", content: "remember: 42\n" })] }, 1),
      reply({ content: "Wrote the plan." }, 2),
      reply({ tool_calls: [toolCall("c2", "file_read", { path: "plan.txt" })] }, 3),
      reply({ content: "Read it back." }, 4),
    ]);
    const chain = new FakeChain();
    const store = new MemoryTraceStore();
    const events: RuntimeEvent[] = [];
    // The fake chain has no epoch committer of its own, so epochs go through an anchor queue, as
    // in the stub case above; without one the runtime asks the client for a committer it lacks.
    const billing = new RecordingBilling();
    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new MemoryAnchorJournal(),
      billing,
      maxAttempts: 1,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    const rt = new ZeroClawRuntime({
      client: chain.asClient(),
      agentId: idFromString("zeroclaw-real-agent"),
      transport,
      store,
      billing,
      anchor: { queue, drain: true },
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => Date.now(),
      onEvent: (e) => events.push(e),
      policy: { model: MODEL, temperature: 0.2, toolAllowList: ["solana.slot"], maxCost: 5_000_000 },
      tools: [slotTool],
      rollup: { store: epochStore(), batchSize: 16 },
      zeroclaw: { binary, home: root, sandbox: "loop-real", contextWindow: noWindow },
    });
    const runner = new LoopRunner({
      runtime: rt,
      loopId: "loop-real",
      prompt: "Keep a plan in the workspace.",
      intervalMs: 0,
      maxSteps: 2,
      user: USER,
      startedAt: Date.now(),
      sleep: async () => undefined,
    });
    const one = await runner.step();
    const two = await runner.step();
    assert.equal(one.status, "success", one.reason);
    assert.equal(two.status, "success", two.reason);
    const tools = events.filter((e) => e.type === "action").map((e) => `${e.toolId}:${e.statusCode}`);
    assert.includeMembers(tools, ["zc.file_write:200", "zc.file_read:200"]);
    assert.match(one.manifest!.replayHash!, /^[0-9a-f]{64}$/);
    assert.match(two.manifest!.replayHash!, /^[0-9a-f]{64}$/);

    // `zeroclaw/CONTRACT.md` §3: the host tools the binary offers the model carry the Lath definitions verbatim.
    const offered = transport.seen[0].tools ?? [];
    const slot = offered.find((t) => t.function.name === "solana_slot");
    assert.exists(slot, "the binary offers the host tool the policy allows");
    assert.equal(slot!.function.description, slotTool.description);
  });

  it("runs a step whose config carries the model's context window, and refuses one that is not a positive integer", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new MemoryAnchorJournal(),
      billing,
      maxAttempts: 1,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    const rt = new ZeroClawRuntime({
      client: chain.asClient(),
      agentId: idFromString("zeroclaw-real-window"),
      transport: new Scripted([reply({ content: "Ran with the model's window." }, 1)]),
      store: new MemoryTraceStore(),
      billing,
      anchor: { queue, drain: true },
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => Date.now(),
      policy: { model: MODEL, temperature: 0.2, toolAllowList: [], maxCost: 5_000_000 },
      rollup: { store: epochStore(), batchSize: 16 },
      zeroclaw: { binary, home: root, sandbox: "loop-window", contextWindow: async () => 163_840 },
    });
    const result = await rt.start({ user: USER, prompt: "Say so.", sessionId: "loop-window:step-1" });
    assert.equal(result.status, "success", result.reason);
    const toml = rt.stepReport()!.postureToml!;
    assert.include(toml, "\ncontext_window = 163840\n", "patch 0005 accepted the config with the key");
    // The record of the step the real binary ran names the window its config carried.
    assert.equal(rt.stepReport()!.replay!.contextWindow, 163_840);

    // The same config with a window the host never writes, run as the host runs a step but
    // unwrapped: the refusal comes before any socket is dialled.
    const dir = path.join(root, "window-refused");
    const work = path.join(dir, "work");
    fs.mkdirSync(work, { recursive: true });
    const base = toml.replace(/"\/lath\/work"/, JSON.stringify(work)).replace(/"\/lath\//g, `"${dir}/`);
    // Zero is a `usize` to upstream's typed load, so patch 0005's posture check sees it and names
    // the key; anything that is not a `usize` fails the typed load first, and the Lath build then
    // refuses the section it could not read, by name. Both before any socket.
    const cases: [string, string][] = [
      ["0", "context_window"],
      ["-1", "providers.models.custom.lath"],
      ["1.5", "providers.models.custom.lath"],
      ['"163840"', "providers.models.custom.lath"],
    ];
    for (const [bad, needle] of cases) {
      const cfg = path.join(dir, "cfg");
      fs.rmSync(cfg, { recursive: true, force: true });
      fs.mkdirSync(cfg);
      fs.writeFileSync(
        path.join(cfg, "config.toml"),
        base.replace("context_window = 163840", `context_window = ${bad}`)
      );
      const r = spawnSync(binary.path, ["--config-dir", cfg, "agent", "-a", "lath", "-m", "hi"], {
        env: { HOME: cfg, TZ: "UTC", LANG: "C", ZEROCLAW_NOW: "2026-09-24T12:00:00Z", ZEROCLAW_OMIT_HOST: "1" },
        cwd: work,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.notEqual(r.status, 0, `context_window = ${bad} was accepted`);
      assert.include(r.stderr, needle, `context_window = ${bad}: ${r.stderr.slice(-400)}`);
    }
  });

  it("reads sources/ and is refused a write into it, under the wrapper's read-only rule", async () => {
    const src = fetchedSources(path.join(root, "fetched"));
    const work = path.join(root, "loops", "loop-src", "work");
    // The host seeds and locks `sources/` (0555) before every spawn. This spawner opens the mode
    // again just before the real wrapper runs, so what refuses the write is the wrapper's rule and
    // not the mode on disk: the case proves the rule, which is what the posture commits.
    const spawner = (file: string, args: string[], options: SpawnOptions): ChildProcess => {
      spawnSync("chmod", ["-R", "u+w", path.join(work, "sources")]);
      return spawn(file, args, options);
    };
    const transport = new Scripted([
      reply(
        {
          tool_calls: [
            toolCall("c1", "file_read", { path: `sources/${README}` }),
            toolCall("c2", "file_write", { path: `sources/${README}`, content: "overwritten\n" }),
          ],
        },
        1
      ),
      reply({ content: "Read it, could not change it." }, 2),
    ]);
    const store = new MemoryTraceStore();
    const events: RuntimeEvent[] = [];
    const billing = new RecordingBilling();
    const chain = new FakeChain();
    const queue = new AnchorQueue({
      client: chain.asClient(),
      journal: new MemoryAnchorJournal(),
      billing,
      maxAttempts: 1,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
    const rt = new ZeroClawRuntime({
      client: chain.asClient(),
      agentId: idFromString("zeroclaw-real-sources"),
      transport,
      store,
      billing,
      anchor: { queue, drain: true },
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => Date.now(),
      onEvent: (e) => events.push(e),
      policy: { model: MODEL, temperature: 0.2, toolAllowList: [], maxCost: 5_000_000 },
      rollup: { store: epochStore(), batchSize: 16 },
      zeroclaw: { binary, home: root, sandbox: "loop-src", sources: src, spawner, contextWindow: noWindow },
    });

    const result = await rt.start({ user: USER, prompt: "Read the program.", sessionId: "loop-src:step-1" });
    assert.equal(result.status, "success", result.reason);
    const tools = events.filter((e) => e.type === "action").map((e) => `${e.toolId}:${e.statusCode}`);
    assert.deepEqual(
      tools.filter((t) => t.startsWith("zc.")),
      ["zc.file_read:200", "zc.file_write:500"]
    );
    assert.equal(fs.readFileSync(path.join(work, "sources", README), "utf8"), "# squads\n", "the write did not land");
    const read = transport.seen[1].messages.find((m) => m.role === "tool" && m.tool_call_id === "c1");
    assert.include(String(read!.content), "# squads");
    // The OS's refusal (Seatbelt answers EPERM, a read-only mount EROFS), not a choice the binary made.
    const write = transport.seen[1].messages.find((m) => m.role === "tool" && m.tool_call_id === "c2");
    assert.match(String(write!.content), /not permitted|Read-only file system|os error (1|30)\b/i);
  });
});
