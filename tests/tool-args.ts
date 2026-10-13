import "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { hex, idFromString, MemoryTraceStore } from "../sdk/src";
import {
  AgentRuntime,
  AgentRuntimeOptions,
  ChatResult,
  ChatTransport,
  MAX_TOOL_STRING_CHARS,
  NoopBilling,
  RuntimeEvent,
  SessionCtx,
  StartOptions,
  ToolDefinition,
  TurnsOutcome,
  toolArgumentsProblem,
  undeclaredToolId,
} from "../runtime/src";
import { startHostTools } from "../runtime/src/zeroclaw/host-tools";
import { TOOL_DEADLINE_MS, boundedTool, consoleTools } from "../frontend/src/app/api/_lib/tools";
import { FakeChain } from "./fixtures/fake-chain";

/**
 * Two rules on a model's tool calls.
 *
 * A model-chosen argument of the wrong JSON type must not reach a tool's `execute` unchecked:
 * `solana.balance` with `{"address": {"length": 3e9}}` would abort the console in `new BN`. `callTool`
 * holds every call to the tool's declared schema and answers 400 without running it. These cases
 * never run the crash: the malicious arguments are refused before anything allocates, and a
 * regression would show as a tool that ran (the stubbed RPC is called) long before it showed as an
 * abort. Nothing here allocates more than a few kilobytes.
 *
 * A call to a name the runtime did not declare is recorded as `unknown:<name>`, so an invented
 * `loop.step` or `storage.put` is never an Action under an id a reader acts on.
 */

const MODEL = "test/model";
const USER = new PublicKey("11111111111111111111111111111112");
const AGENT = idFromString("tool-args-agent");
const ADDRESS = "So11111111111111111111111111111111111111112";

/** The two calls SECURITY.md quotes, as the model's argument strings. */
const BALANCE_BOMB = JSON.stringify({ address: { length: 3_000_000_000 } });
const VERIFY_BOMB = JSON.stringify({ agentId: { length: 2e9 } });

function call(id: string, name: string, args: string) {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

function completion(message: Record<string, unknown>, n: number): ChatResult {
  return {
    status: 200,
    body: {
      id: `gen-${n}`,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, ...message } as any,
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
    },
  };
}

/** Replays `replies` in order and keeps every request, so a case can read what the model was told. */
function scripted(replies: ChatResult[]) {
  const seen: any[] = [];
  const t: ChatTransport = {
    async chat(req) {
      seen.push(JSON.parse(JSON.stringify(req)));
      return replies[Math.min(seen.length - 1, replies.length - 1)];
    },
  };
  return { t, seen };
}

/** The real console tools over a stubbed RPC and client, counting what reached them. */
function tools() {
  const reached = { getBalance: 0, verifyChain: 0 };
  const rpc = {
    async getBalance() {
      reached.getBalance++;
      return 5_000_000_000;
    },
  } as any;
  const client = {
    async verifyChain() {
      reached.verifyChain++;
      return { ok: true, seq: 0n, records: 0, epochs: [], head: new Uint8Array(32) };
    },
  } as any;
  const defs = consoleTools(rpc, client, AGENT, "session");
  return { defs, reached };
}

function runtime(defs: ToolDefinition[], transport: ChatTransport, events: RuntimeEvent[]) {
  return new AgentRuntime({
    client: new FakeChain().asClient(),
    agentId: AGENT,
    transport,
    store: new MemoryTraceStore(),
    billing: new NoopBilling(),
    storePayloads: true,
    structures: false,
    publishPolicy: false,
    now: () => 1_700_000_000_000,
    onEvent: (e: RuntimeEvent) => events.push(e),
    policy: { model: MODEL, temperature: 0, toolAllowList: defs.map((d) => d.name), maxCost: 5_000_000 },
    tools: defs,
  } as AgentRuntimeOptions);
}

const actions = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "action").map((e) => `${e.toolId}:${e.statusCode}`);

describe("tool arguments: the schema check every call passes", () => {
  const schema = {
    type: "object",
    properties: {
      address: { type: "string" },
      ids: { type: "array", items: { type: "string" } },
      n: { type: "integer" },
      either: { type: ["string", "number"] },
    },
    required: ["address"],
  };

  it("accepts what the schema declares, leaves undeclared keys alone, and reads null as left out", () => {
    assert.isNull(toolArgumentsProblem(schema, { address: ADDRESS }));
    assert.isNull(toolArgumentsProblem(schema, { address: ADDRESS, ids: ["solana"], n: 3, either: 1, extra: [1] }));
    assert.isNull(toolArgumentsProblem(schema, { address: ADDRESS, ids: null, n: null }));
    assert.isNull(toolArgumentsProblem(undefined, {}));
    assert.isNull(toolArgumentsProblem({ type: "object", properties: { key: { type: "string" } } }, {}));
    // JSON.parse makes an own `__proto__` key; it is an undeclared key like any other.
    assert.isNull(toolArgumentsProblem(schema, JSON.parse(`{"address":"${ADDRESS}","__proto__":{"x":1}}`)));
  });

  it("refuses arguments that are not a plain object", () => {
    for (const args of [null, "x", 5, [ADDRESS], true]) {
      assert.match(toolArgumentsProblem(schema, args)!, /must be a JSON object/, JSON.stringify(args));
    }
    assert.match(toolArgumentsProblem(undefined, new Date())!, /must be a JSON object/);
  });

  it("refuses a property of the wrong JSON type, at any depth the schema declares", () => {
    assert.match(
      toolArgumentsProblem(schema, JSON.parse(BALANCE_BOMB))!,
      /arguments\.address must be string, not object/
    );
    assert.match(toolArgumentsProblem(schema, { address: 5 })!, /address must be string, not number/);
    assert.match(toolArgumentsProblem(schema, { address: ADDRESS, ids: "solana" })!, /ids must be array/);
    assert.match(toolArgumentsProblem(schema, { address: ADDRESS, ids: { length: 3e9 } })!, /ids must be array/);
    assert.match(
      toolArgumentsProblem(schema, { address: ADDRESS, ids: ["a", { length: 1 }] })!,
      /ids\[1\] must be string/
    );
    assert.match(toolArgumentsProblem(schema, { address: ADDRESS, n: 1.5 })!, /n must be integer/);
    assert.match(toolArgumentsProblem(schema, { address: ADDRESS, either: true })!, /must be string or number/);
    // A type name outside JSON Schema's seven admits nothing, a prototype method's name included.
    const odd = { type: "object", properties: { a: { type: "toString" } } };
    assert.match(toolArgumentsProblem(odd, { a: "x" })!, /a must be toString/);
  });

  it("refuses a missing or null required property", () => {
    assert.match(toolArgumentsProblem(schema, {})!, /address is required/);
    assert.match(toolArgumentsProblem(schema, { address: null })!, /address is required/);
  });

  it(`caps every string at ${MAX_TOOL_STRING_CHARS} characters, declared or not`, () => {
    const long = "a".repeat(MAX_TOOL_STRING_CHARS + 1);
    assert.isNull(toolArgumentsProblem(schema, { address: "a".repeat(MAX_TOOL_STRING_CHARS) }));
    assert.match(toolArgumentsProblem(schema, { address: long })!, /characters; a tool takes at most/);
    assert.match(toolArgumentsProblem(schema, { address: ADDRESS, extra: { deep: [long] } })!, /extra\.deep\[0\]/);
  });

  it("refuses nesting deeper than it walks", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = [deep];
    assert.match(toolArgumentsProblem(schema, { address: ADDRESS, extra: deep })!, /nested deeper than/);
  });
});

describe("tool arguments: through the runtime and the real console tools", () => {
  it("answers SECURITY.md's two calls 400, runs neither tool, writes both Actions, and the session goes on", async () => {
    const { defs, reached } = tools();
    const events: RuntimeEvent[] = [];
    const { t, seen } = scripted([
      completion(
        {
          tool_calls: [
            call("c1", "solana_balance", BALANCE_BOMB),
            call("c2", "lath_verify_chain", VERIFY_BOMB),
            call("c3", "lattice_verify_chain", VERIFY_BOMB),
            call("c4", "market_prices", JSON.stringify({ ids: { length: 3e9 } })),
            call("c5", "store_set", JSON.stringify({ key: { length: 3e9 }, value: "v" })),
            call("c6", "solana_balance", JSON.stringify({ address: ADDRESS })),
          ],
        },
        1
      ),
      completion({ content: "done" }, 2),
    ]);
    const rt = runtime(defs, t, events);
    const result = await rt.start({ user: USER, prompt: "check", sessionId: "tool-args-1" });
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(actions(events), [
      `llm.${MODEL}:200`,
      "solana.balance:400",
      "lath.verify_chain:400",
      "lattice.verify_chain:400",
      "market.prices:400",
      "store.set:400",
      "solana.balance:200",
      `llm.${MODEL}:200`,
    ]);
    assert.equal(reached.getBalance, 1, "only the well-formed call reached the RPC");
    assert.equal(reached.verifyChain, 0);
    // The model is told why, in the tool message, as it is told about any failed call.
    const toolMessages = seen[1].messages.filter((m: any) => m.role === "tool");
    assert.match(
      toolMessages[0].content,
      /invalid arguments for \\"solana\.balance\\": arguments\.address must be string/
    );
    assert.match(toolMessages[1].content, /arguments\.agentId must be string/);
    assert.include(toolMessages[5].content, '"lamports":5000000000');
  });

  it("records an invented name as unknown:<name>, reserved ids and `delegate` alike", async () => {
    const { defs } = tools();
    const events: RuntimeEvent[] = [];
    const invented = ["loop.step", "storage.put", "loop.settlement", "oracle.feed", `llm.${MODEL}`, "delegate.x"];
    const { t } = scripted([
      completion(
        {
          tool_calls: [
            ...invented.map((name, i) => call(`i${i}`, name, JSON.stringify({ step: 999 }))),
            // No delegates are declared, so `delegate` was never offered: it is an invented name too.
            call("d", "delegate", JSON.stringify({ agent: "x", task: "y" })),
          ],
        },
        1
      ),
      completion({ content: "done" }, 2),
    ]);
    const result = await runtime(defs, t, events).start({ user: USER, prompt: "x", sessionId: "tool-args-2" });
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(actions(events), [
      `llm.${MODEL}:200`,
      ...invented.map((name) => `unknown:${name}:404`),
      "unknown:delegate:404",
      `llm.${MODEL}:200`,
    ]);
    assert.equal(undeclaredToolId("loop.step"), "unknown:loop.step");
    // On the chain the reference is the hash of the prefixed id, never of the reserved one.
    const refs = result.events.map((e: any) => hex(e.input.reference));
    for (const name of ["loop.step", "storage.put", "loop.settlement", "oracle.feed"]) {
      assert.notInclude(refs, hex(idFromString(name)), name);
      assert.include(refs, hex(idFromString(`unknown:${name}`)), name);
    }
  });

  it("refuses to declare a tool under the prefix an undeclared call records", () => {
    const def = { name: "unknown:x", async execute() {} };
    assert.throws(() => runtime([def], scripted([]).t, []), /reserved for undeclared calls/);
  });
});

describe("tool arguments: through the sandbox's tools socket", () => {
  let dir: string;
  beforeEach(() => {
    // Short: a Unix socket path is at most 104 bytes on macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * A runtime whose turns are a sandbox's: it serves the tools socket bound to `callTool` for the
   * session, as `ZeroClawRuntime` does, and `script` plays the binary posting to it.
   */
  class Bound extends AgentRuntime {
    script?: (socketPath: string) => Promise<void>;
    failure?: unknown;

    protected async runTurns(s: SessionCtx, _messages: unknown, _opts: StartOptions): Promise<TurnsOutcome> {
      const server = await startHostTools({
        socketPath: path.join(dir, "t.sock"),
        token: "t0ken",
        allow: ["solana.balance", "lath.verify_chain", "solana.slot"],
        call: (id, args) => this.callTool(s, id, args),
        onRefused: async () => {
          throw new Error("nothing here is outside the allow-list");
        },
      });
      try {
        await this.script!(server.socketPath);
        this.failure = server.failure();
        return { status: "success", output: "done" };
      } finally {
        await server.close();
      }
    }
  }

  function post(socketPath: string, url: string, body: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: url,
          method: "POST",
          headers: { authorization: "Bearer t0ken", "content-type": "application/json" },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }));
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("answers the malicious call as a tool error the binary reads, with a 400 Action, and fails nothing", async () => {
    const { defs, reached } = tools();
    const events: RuntimeEvent[] = [];
    const rt = new Bound({
      client: new FakeChain().asClient(),
      agentId: AGENT,
      transport: scripted([]).t,
      store: new MemoryTraceStore(),
      billing: new NoopBilling(),
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      onEvent: (e: RuntimeEvent) => events.push(e),
      policy: { model: MODEL, temperature: 0, toolAllowList: defs.map((d) => d.name), maxCost: 5_000_000 },
      tools: defs,
    } as AgentRuntimeOptions);
    const answers: { status: number; json: any }[] = [];
    rt.script = async (socketPath) => {
      answers.push(await post(socketPath, "/tools/solana.balance", BALANCE_BOMB));
      answers.push(await post(socketPath, "/tools/lath.verify_chain", VERIFY_BOMB));
      answers.push(await post(socketPath, "/tools/lath.verify_chain", '"not an object"'));
      // `null` is a call with no arguments: the empty object, past the check.
      answers.push(await post(socketPath, "/tools/solana.slot", "null"));
    };
    const result = await rt.start({ user: USER, prompt: "check", sessionId: "tool-args-sandbox" });
    assert.equal(result.status, "success", result.reason);
    const [balance, verify, notObject] = answers;
    // 500 on the wire: the binary takes only 200, 404 and 500 as a tool's answer (`zeroclaw/CONTRACT.md` §3).
    assert.equal(balance.status, 500);
    assert.match(balance.json.error, /invalid arguments for "solana\.balance"/);
    assert.equal(verify.status, 500);
    assert.equal(notObject.status, 500);
    assert.match(notObject.json.error, /must be a JSON object, not string/);
    assert.isUndefined(rt.failure, "a refused call is information for the model, not a failed step");
    assert.deepEqual(actions(events), [
      "solana.balance:400",
      "lath.verify_chain:400",
      "lath.verify_chain:400",
      // `solana.slot` ran (and failed on the stub RPC, which has no `getSlot`): past the check.
      "solana.slot:500",
    ]);
    assert.match(answers[3].json.error, /getSlot/);
    assert.deepEqual(reached, { getBalance: 0, verifyChain: 0 });
  });
});

describe("tool arguments: each tool's own backstop, for a caller that skips the check", () => {
  const byName = (defs: ToolDefinition[], name: string) => defs.find((d) => d.name === name)!;
  const ctx = { sessionId: "s", agentId: AGENT, spentMicroUsdc: 0n };

  it("solana.balance takes only a base58 address string", async () => {
    const { defs, reached } = tools();
    const tool = byName(defs, "solana.balance");
    for (const address of [{ length: 3e9 }, 5, "", "0OIl", "a".repeat(45), null]) {
      let threw: unknown;
      await tool.execute({ address }, ctx).catch((e) => (threw = e));
      assert.match(String((threw as Error)?.message), /base58 Solana address/, JSON.stringify(address));
    }
    assert.equal(reached.getBalance, 0);
    assert.deepEqual(await tool.execute({ address: ADDRESS }, ctx), {
      address: ADDRESS,
      lamports: 5_000_000_000,
      sol: 5,
    });
  });

  it("lath.verify_chain and its alias take only a 64-character hex id", async () => {
    const { defs, reached } = tools();
    for (const name of ["lath.verify_chain", "lattice.verify_chain"]) {
      for (const agentId of [{ length: 2e9 }, 7, "abcd", "z".repeat(64), ["a"]]) {
        let threw: unknown;
        await byName(defs, name)
          .execute({ agentId }, ctx)
          .catch((e) => (threw = e));
        assert.match(String((threw as Error)?.message), /64 hex characters/, `${name} ${JSON.stringify(agentId)}`);
      }
    }
    assert.equal(reached.verifyChain, 0);
  });

  it("the store and web tools refuse a non-string key, query or url and a non-array ids", async () => {
    const { defs } = tools();
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["store.get", { key: { length: 3e9 } }, /key must be a string/],
      ["store.set", { key: { length: 3e9 }, value: "v" }, /key must be a string/],
      ["web.search", { query: { length: 3e9 } }, /query string/],
      ["web.fetch_page", { url: { length: 3e9 } }, /http\(s\) URL/],
      ["market.prices", { ids: { length: 3e9 } }, /array of CoinGecko ids/],
      ["market.prices", { ids: "solana" }, /array of CoinGecko ids/],
    ];
    for (const [name, args, expected] of cases) {
      let threw: unknown;
      await byName(defs, name)
        .execute(args, ctx)
        .catch((e) => (threw = e));
      assert.match(String((threw as Error)?.message), expected, name);
    }
  });
});

/**
 * A backstop: `callTool` awaits a tool with no limit and `/api/run` holds the run slot until
 * its session exits, so a tool that never settles would hold every session and loop step out. Each read
 * the console hands a model is raced against `TOOL_DEADLINE_MS`; the store's write is not, because a
 * write reported failed while it may still land is a record that contradicts the chain.
 */
describe("tool calls: a read that never answers is given up on, a write is not", () => {
  const ctx = { sessionId: "s", agentId: AGENT, spentMicroUsdc: 0n };
  const never = () => new Promise<never>(() => {});

  /** Runs `fn` with `TOOL_DEADLINE_MS` shortened to `ms`, by the timer it is armed with. */
  async function withShortDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const real = global.setTimeout;
    (global as any).setTimeout = (cb: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) =>
      real(cb, delay === TOOL_DEADLINE_MS ? ms : delay, ...rest);
    try {
      return await fn();
    } finally {
      global.setTimeout = real;
    }
  }

  it("boundedTool passes a value and an error through, and turns a hang into an error naming the tool", async () => {
    const ok = boundedTool({ name: "t.ok", execute: async () => ({ fine: true }) }, 50);
    assert.deepEqual(await ok.execute({}, ctx), { fine: true });
    const bad = boundedTool(
      {
        name: "t.bad",
        execute: async () => {
          throw new Error("its own reason");
        },
      },
      50
    );
    assert.equal(String(await bad.execute({}, ctx).catch((e) => e.message)), "its own reason");
    const hung = boundedTool({ name: "t.hung", description: "d", parameters: { type: "object" }, execute: never }, 50);
    assert.equal(hung.description, "d");
    assert.deepEqual(hung.parameters, { type: "object" });
    const t0 = Date.now();
    assert.match(String(await hung.execute({}, ctx).catch((e) => e.message)), /t\.hung did not answer/);
    assert.isBelow(Date.now() - t0, 1000);
  });

  it("every console read is bounded, and store.set is left to finish", async () => {
    const rpc = {
      getSlot: never,
      getBalance: never,
      getRecentPrioritizationFees: never,
    } as any;
    const client = { verifyChain: never } as any;
    let writes = 0;
    const defs = consoleTools(rpc, client, AGENT, "session", () => {
      writes++;
      return never();
    });
    const byName = (name: string) => defs.find((d) => d.name === name)!;
    await withShortDeadline(40, async () => {
      for (const [name, args] of [
        ["solana.slot", {}],
        ["solana.fees", {}],
        ["solana.balance", { address: ADDRESS }],
        ["lath.verify_chain", {}],
        ["lattice.verify_chain", {}],
      ] as const) {
        const msg = await byName(name)
          .execute(args, ctx)
          .catch((e) => e.message);
        assert.match(String(msg), new RegExp(`${name.replace(".", "\\.")} did not answer`), name);
      }
      // The write is still waiting on its (stubbed, never-landing) chain write after several of the
      // reads' deadlines: nothing answered it "failed" while it could still land.
      let settled = false;
      void byName("store.set")
        .execute({ key: "k", value: "v" }, ctx)
        .then(
          () => (settled = true),
          () => (settled = true)
        );
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(writes, 1);
      assert.isFalse(settled, "store.set was cut off by the read deadline");
    });
  });
});
