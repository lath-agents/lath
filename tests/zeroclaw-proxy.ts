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
  BudgetExceeded,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatTransport,
  ModelNoAnswer,
  NoopBilling,
  PaidCallFailed,
  RuntimeEvent,
  SessionCtx,
  StartOptions,
  TempoPayment,
  TurnsOutcome,
} from "../runtime/src";
import {
  ModelProxy,
  ObservedToolAction,
  ProxyRefused,
  expectedClock,
  observedToolCalls,
  startModelProxy,
} from "../runtime/src/zeroclaw/proxy";
import { HostToolsServer, startHostTools } from "../runtime/src/zeroclaw/host-tools";
import { FakeChain } from "./fixtures/fake-chain";

/**
 * The two sockets a sandboxed ZeroClaw step reaches the host through (`zeroclaw/CONTRACT.md` §2,
 * §3), served over real Unix sockets in a temp directory, with fakes
 * where the host binds `paidChat` and `callTool` — and then with the real `AgentRuntime` bound, to
 * show a model call from outside the ReAct loop is the same record a ReAct turn writes.
 *
 * Node-only: no validator, no RPC, no key, no binary, and nothing that can spend money.
 */

const NOW = "2026-09-24T12:00:00Z";
const MODEL = "deepseek/deepseek-v4.1-flash";
const TOKEN = "step-token-0123456789abcdef";
const USER = new PublicKey("11111111111111111111111111111112");
/** The host tools the proxy's own cases allow: their calls are the tools socket's to record. */
const HOST_WIRE = ["store_get", "store_set", "solana_slot"];

/** The system prompt as the Lath binary writes it under `ZEROCLAW_NOW` and `ZEROCLAW_OMIT_HOST`. */
function systemPrompt(opts: { date?: string; runtime?: string; before?: string } = {}): string {
  return [
    "## Tooling\n\nfile_read, file_write\n",
    opts.before ?? "",
    `## Current Date\n\n${opts.date ?? "2026-09-24 (+00:00)"}\n`,
    `## Runtime\n\n${opts.runtime ?? `Model: ${MODEL}`}\n`,
    "This is an interactive conversation with a user.",
  ].join("\n");
}

/** A request shaped as ZeroClaw's `custom` provider sends it: keys sorted, `stream: false`. */
function zcBody(extra: { messages?: ChatMessage[]; model?: string; user?: string; system?: string } = {}) {
  return {
    messages: extra.messages ?? [
      { role: "system", content: extra.system ?? systemPrompt() },
      { role: "user", content: extra.user ?? "[2026-09-24 12:00:00 +00:00] Write a note and read it back." },
    ],
    model: extra.model ?? MODEL,
    stream: false,
    temperature: 0.7,
    tool_choice: "auto",
    tools: [{ type: "function", function: { name: "file_read", parameters: { type: "object", properties: {} } } }],
  };
}

const PAYMENT: TempoPayment = {
  rail: "tempo",
  chainId: 4217,
  payer: "0x18fB0000000000000000000000000000000000B0",
  channelId: "0xchannel",
  cumulativeBefore: "0",
  cumulativeAfter: "750",
};

function completion(message: Partial<ChatMessage>, n = 1): ChatResult {
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
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.0001 },
    },
    payment: PAYMENT,
  };
}

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

/** One HTTP/1.1 request over a Unix socket, as the sandbox's client makes it. */
function post(
  socketPath: string,
  urlPath: string,
  body: unknown,
  opts: { token?: string | null; method?: string; raw?: string } = {}
): Promise<{ status: number; text: string; json: any }> {
  const text = opts.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: opts.method ?? "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const out = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try {
          json = JSON.parse(out);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, text: out, json });
      });
    });
    req.on("error", reject);
    req.end(text);
  });
}

function tempDir(): string {
  // `os.tmpdir()` is short enough on both platforms for a socket path under it (the 103-byte cap).
  return fs.mkdtempSync(path.join(os.tmpdir(), "zcp-"));
}

/** A `chat` that answers from a script and logs what it was sent, and when, into `log`. */
function scriptedChat(replies: (ChatResult | Error)[], log: string[] = []) {
  const seen: ChatRequest[] = [];
  const chat = async (req: ChatRequest) => {
    seen.push(req);
    log.push(`chat${seen.length}`);
    const r = replies[Math.min(seen.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { chat, seen, log };
}

describe("zeroclaw: the model socket", () => {
  let dir: string;
  const open: { close(): Promise<void> }[] = [];

  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function proxy(
    replies: (ChatResult | Error)[],
    extra: { token?: string; socket?: string; onFile?: (c: ObservedToolAction[]) => Promise<void>; log?: string[] } = {}
  ) {
    const script = scriptedChat(replies, extra.log);
    const files: ObservedToolAction[][] = [];
    const p = await startModelProxy({
      socketPath: path.join(dir, extra.socket ?? "m.sock"),
      token: extra.token ?? TOKEN,
      model: MODEL,
      temperature: 0.2,
      expect: { now: NOW },
      hostTools: HOST_WIRE,
      chat: script.chat,
      onToolCalls:
        extra.onFile ??
        (async (calls) => {
          files.push(calls);
          for (const c of calls) extra.log?.push(`file:${c.toolId}`);
        }),
    });
    open.push(p);
    return { p, ...script, files };
  }

  it("refuses a request without the step's bearer, and pays nothing for it", async () => {
    const { p, seen } = await proxy([completion({ content: "hi" })]);
    for (const token of [null, "", "step-token-0123456789abcdeX", `${TOKEN}x`]) {
      const r = await post(p.socketPath, "/v1/chat/completions", zcBody(), { token });
      assert.equal(r.status, 401, `token ${JSON.stringify(token)}`);
    }
    assert.lengthOf(seen, 0);
    // Someone else knocking is not the step failing.
    assert.isUndefined(p.failure());
  });

  it("refuses a request on another step's socket: its token is not this step's", async () => {
    const a = await proxy([completion({ content: "a" })], { token: "token-of-step-a", socket: "a.sock" });
    const b = await proxy([completion({ content: "b" })], { token: "token-of-step-b", socket: "b.sock" });
    const r = await post(b.p.socketPath, "/v1/chat/completions", zcBody(), { token: "token-of-step-a" });
    assert.equal(r.status, 401);
    assert.lengthOf(b.seen, 0);
    const ok = await post(a.p.socketPath, "/v1/chat/completions", zcBody(), { token: "token-of-step-a" });
    assert.equal(ok.status, 200);
  });

  it("serves one path and nothing else", async () => {
    const { p, seen } = await proxy([completion({ content: "hi" })]);
    assert.equal((await post(p.socketPath, "/alpha/decisions", zcBody())).status, 404);
    assert.equal((await post(p.socketPath, "/v1/chat/completions", undefined, { method: "GET", raw: "" })).status, 404);
    assert.lengthOf(seen, 0);
  });

  it("refuses another model with a 400 before anything is paid, and fails the step", async () => {
    const { p, seen } = await proxy([completion({ content: "hi" })]);
    const r = await post(p.socketPath, "/v1/chat/completions", zcBody({ model: "openai/gpt-5" }));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /openai\/gpt-5/);
    // Neither of the phrases ZeroClaw reads as "resend without tools" (compatible.rs).
    assert.notMatch(r.text.toLowerCase(), /tool_choice|was not in request|does not support tools/);
    assert.lengthOf(seen, 0, "nothing was paid for");
    assert.instanceOf(p.failure(), ProxyRefused);
    // A step that failed buys nothing more, even with the right model.
    const after = await post(p.socketPath, "/v1/chat/completions", zcBody());
    assert.equal(after.status, 503);
    assert.lengthOf(seen, 0);
  });

  it("does not fail the step for a body cut off by the sandbox going away, so its wall clock stays the reason", async () => {
    const { p, seen } = await proxy([completion({ content: "hi" })]);
    // A sandbox killed mid-body: the headers promise more than is sent, then the connection drops.
    await new Promise<void>((resolve) => {
      const req = http.request({
        socketPath: p.socketPath,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "4096", authorization: `Bearer ${TOKEN}` },
      });
      req.on("error", () => resolve());
      req.write('{"model":"');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    assert.lengthOf(seen, 0);
    assert.isUndefined(p.failure());
    // A complete body that is not JSON is still the sandbox's mistake, and fails the step.
    const bad = await post(p.socketPath, "/v1/chat/completions", undefined, { raw: '{"model":' });
    assert.equal(bad.status, 400);
    assert.instanceOf(p.failure(), ProxyRefused);
  });

  it("pins model and temperature, adds the usage flag, and answers the body with no payment", async () => {
    const reply = completion({ content: "DONE" });
    const { p, seen } = await proxy([reply]);
    const r = await post(p.socketPath, "/v1/chat/completions", zcBody());
    assert.equal(r.status, 200);
    assert.lengthOf(seen, 1);
    const sent = seen[0] as any;
    assert.equal(sent.model, MODEL);
    assert.equal(sent.temperature, 0.2, "the policy's temperature, not the sandbox's 0.7");
    assert.deepEqual(sent.usage, { include: true });
    // ZeroClaw's own request, key for key: what `args_hash` commits is what the model saw.
    assert.deepEqual(Object.keys(sent), [
      "messages",
      "model",
      "stream",
      "temperature",
      "tool_choice",
      "tools",
      "usage",
    ]);
    assert.deepEqual(sent.messages, zcBody().messages);
    assert.equal(sent.tool_choice, "auto");
    // The body verbatim — usage and all — and the voucher never enters the sandbox.
    assert.equal(r.text, JSON.stringify(reply.body));
    assert.isUndefined(r.json.payment);
    assert.deepEqual(r.json.usage, reply.body.usage);
    assert.isUndefined(p.failure());
    assert.equal(p.calls(), 1);
  });

  describe("the clock and the host are checked, not rewritten", () => {
    const refusals: [string, ReturnType<typeof zcBody>, RegExp][] = [
      ["a user message dated by the wall clock", zcBody({ user: "[2026-09-24 12:00:07 +00:00] hi" }), /dated/],
      ["a user message in another zone", zcBody({ user: "[2026-09-24 14:00:00 +02:00] hi" }), /dated/],
      ["another current date", zcBody({ system: systemPrompt({ date: "2026-09-25 (+00:00)" }) }), /current date/],
      [
        "a current date in another zone",
        zcBody({ system: systemPrompt({ date: "2026-09-24 (+02:00)" }) }),
        /current date/,
      ],
      [
        "a runtime line naming the host",
        zcBody({ system: systemPrompt({ runtime: `Host: build-7 | OS: macos | Model: ${MODEL}` }) }),
        /Host/,
      ],
      [
        "a runtime line naming the shell",
        zcBody({ system: systemPrompt({ runtime: `Shell: zsh | Model: ${MODEL}` }) }),
        /Shell/,
      ],
    ];
    for (const [what, body, reason] of refusals) {
      it(`refuses ${what}, unpaid, and fails the step with the reason`, async () => {
        const { p, seen } = await proxy([completion({ content: "hi" })]);
        const r = await post(p.socketPath, "/v1/chat/completions", body);
        assert.isAtLeast(r.status, 400);
        assert.isBelow(r.status, 500);
        assert.notEqual(r.status, 400, "not a 400: ZeroClaw reads some 400s as a reason to resend");
        assert.lengthOf(seen, 0);
        const failure = p.failure() as ProxyRefused;
        assert.instanceOf(failure, ProxyRefused);
        assert.match(failure.message, reason);
      });
    }

    it("passes the step's own clock, and a request with no prefix at all", async () => {
      const { p, seen } = await proxy([completion({ content: "hi" })]);
      assert.equal((await post(p.socketPath, "/v1/chat/completions", zcBody())).status, 200);
      assert.equal((await post(p.socketPath, "/v1/chat/completions", zcBody({ user: "hi" }))).status, 200);
      assert.lengthOf(seen, 2);
    });

    it("reads the sections ZeroClaw writes last, so a workspace file cannot pass or fail a step", async () => {
      // A MEMORY.md the model wrote is folded into the system prompt before the date section.
      const planted = "## Current Date\n\n1999-01-01 (+00:00)\n\n## Runtime\n\nHost: elsewhere | Model: x\n";
      const { p, seen } = await proxy([completion({ content: "hi" })]);
      const r = await post(p.socketPath, "/v1/chat/completions", zcBody({ system: systemPrompt({ before: planted }) }));
      assert.equal(r.status, 200);
      assert.lengthOf(seen, 1);
    });

    it("formats the instant as the binary does under TZ=UTC, truncating the fraction", () => {
      assert.deepEqual(expectedClock("2026-09-24T12:00:00.999Z"), {
        prefix: "[2026-09-24 12:00:00 +00:00]",
        currentDate: "2026-09-24 (+00:00)",
      });
      assert.deepEqual(expectedClock(new Date("2026-09-24T23:59:59+02:00")).prefix, "[2026-09-24 21:59:59 +00:00]");
      assert.throws(() => expectedClock("yesterday"), /not an instant/);
    });
  });

  it("answers a paid call that lost its body with a non-2xx, and keeps it as the failure", async () => {
    const lost = new PaidCallFailed("the stream was cut", PAYMENT);
    const { p, seen } = await proxy([lost]);
    const r = await post(p.socketPath, "/v1/chat/completions", zcBody());
    assert.equal(r.status, 502);
    assert.lengthOf(seen, 1);
    assert.strictEqual(p.failure(), lost);
    assert.equal((await post(p.socketPath, "/v1/chat/completions", zcBody())).status, 503);
    assert.lengthOf(seen, 1, "the step is over; nothing more is paid for");
  });

  it("answers a call whose every attempt got no answer with a 502, and keeps it as thrown", async () => {
    // The step's row reads the cause off the failure by type, so the proxy must hand it back as it came.
    const none = new ModelNoAnswer("the model gave no answer after 2 attempts: …", 2);
    const { p } = await proxy([none]);
    const r = await post(p.socketPath, "/v1/chat/completions", zcBody());
    assert.equal(r.status, 502);
    assert.strictEqual(p.failure(), none);
  });

  it("keeps a budget stop as thrown, so the session can still resolve aborted", async () => {
    const over = new BudgetExceeded("metered 900 µUSDC of a 500 µUSDC budget");
    const { p } = await proxy([over]);
    const r = await post(p.socketPath, "/v1/chat/completions", zcBody());
    assert.isAtLeast(r.status, 500);
    assert.strictEqual(p.failure(), over);
  });

  describe("the file tools become Actions from the traffic", () => {
    const first = () => zcBody();
    const reply1 = completion(
      {
        tool_calls: [
          toolCall("call_1", "file_write", { path: "notes/a.txt", content: "hello\n" }),
          toolCall("call_2", "store_get", { key: "k" }),
          toolCall("call_3", "file_read", { path: "missing.txt" }),
        ],
      },
      1
    );
    const second = (results: [string, string, string][]) => {
      const b = zcBody();
      b.messages.push(reply1.body.choices[0].message);
      for (const [id, name, content] of results) b.messages.push({ role: "tool", tool_call_id: id, name, content });
      return b;
    };

    it("records reply i's file calls from request i+1, in order, before request i+1 is paid", async () => {
      const log: string[] = [];
      const { p, files } = await proxy([reply1, completion({ content: "DONE" }, 2)], { log });
      assert.equal((await post(p.socketPath, "/v1/chat/completions", first())).status, 200);
      assert.deepEqual(
        p.pending().map((c) => c.toolId),
        ["zc.file_write", "zc.file_read"],
        "observed, and not on the chain until their results arrive"
      );
      const r = await post(
        p.socketPath,
        "/v1/chat/completions",
        second([
          ["call_1", "file_write", "Written 6 bytes to notes/a.txt"],
          ["call_2", "store_get", '{"value":"v"}'],
          ["call_3", "file_read", "Error: file not found: missing.txt"],
        ])
      );
      assert.equal(r.status, 200);
      assert.deepEqual(log, ["chat1", "file:zc.file_write", "file:zc.file_read", "chat2"]);
      assert.lengthOf(files, 1);
      // The host tool is the tools socket's to record; recording it here too would be twice.
      assert.deepEqual(
        files[0].map((c) => [c.callId, c.toolId, c.statusCode, c.result]),
        [
          ["call_1", "zc.file_write", 200, "Written 6 bytes to notes/a.txt"],
          ["call_3", "zc.file_read", 500, "Error: file not found: missing.txt"],
        ]
      );
      assert.deepEqual(files[0][0].args, { path: "notes/a.txt", content: "hello\n" });
      assert.deepEqual(p.pending(), []);
    });

    it("marks ZeroClaw's other error form 500 and leaves an unanswered call pending", async () => {
      const { p, files } = await proxy([reply1, completion({ content: "DONE" }, 2)]);
      await post(p.socketPath, "/v1/chat/completions", first());
      await post(
        p.socketPath,
        "/v1/chat/completions",
        second([["call_1", "file_write", "Error executing file_write: permission denied"]])
      );
      assert.deepEqual(
        files[0].map((c) => [c.toolId, c.statusCode]),
        [["zc.file_write", 500]]
      );
      assert.deepEqual(
        p.pending().map((c) => c.callId),
        ["call_3"]
      );
    });

    it("pays nothing when the file tools could not be recorded", async () => {
      const { p, seen } = await proxy([reply1, completion({ content: "DONE" }, 2)], {
        onFile: async () => {
          throw new Error("the chain did not take it");
        },
      });
      await post(p.socketPath, "/v1/chat/completions", first());
      const r = await post(p.socketPath, "/v1/chat/completions", second([["call_1", "file_write", "Written 6 bytes"]]));
      assert.isAtLeast(r.status, 500);
      assert.lengthOf(seen, 1, "request 2 was not paid for");
      assert.match(String((p.failure() as Error).message), /did not take it/);
    });
  });

  describe("a name the model invented is a 404 Action under unknown:<that name>", () => {
    const reply1 = completion(
      {
        tool_calls: [
          toolCall("call_1", "shell", { cmd: "ls" }),
          toolCall("call_2", "store_get", { key: "k" }),
          toolCall("call_3", "file_read", { path: "a.txt" }),
        ],
      },
      1
    );
    const second = (results: [string, string, string][]) => {
      const b = zcBody();
      b.messages.push(reply1.body.choices[0].message);
      for (const [id, name, content] of results) b.messages.push({ role: "tool", tool_call_id: id, name, content });
      return b;
    };

    it("records it from the next request, in reply order with the file tools, and never the host tool", async () => {
      const { p, files } = await proxy([reply1, completion({ content: "DONE" }, 2)]);
      await post(p.socketPath, "/v1/chat/completions", zcBody());
      assert.deepEqual(
        p.pending().map((c) => [c.toolId, c.kind]),
        [
          ["unknown:shell", "unknown"],
          ["zc.file_read", "file"],
        ]
      );
      await post(
        p.socketPath,
        "/v1/chat/completions",
        second([
          ["call_1", "shell", "Unknown tool: shell"],
          ["call_2", "store_get", '{"found":false}'],
          ["call_3", "file_read", "hello"],
        ])
      );
      assert.deepEqual(
        files[0].map((c) => [c.toolId, c.statusCode, c.result]),
        [
          ["unknown:shell", 404, "Unknown tool: shell"],
          ["zc.file_read", 200, "hello"],
        ]
      );
      assert.deepEqual(files[0][0].args, { cmd: "ls" });
    });

    it("is 404 whatever the sandbox's text says, since nothing ran", async () => {
      const { p, files } = await proxy([reply1, completion({ content: "DONE" }, 2)]);
      await post(p.socketPath, "/v1/chat/completions", zcBody());
      await post(p.socketPath, "/v1/chat/completions", second([["call_1", "shell", "ok"]]));
      assert.deepEqual(
        files[0].map((c) => [c.toolId, c.statusCode]),
        [["unknown:shell", 404]]
      );
    });

    it("never records an invented call under an id the host writes, and leaves the file tools' ids alone", () => {
      const reserved = ["loop.step", "loop_step", "storage.put", "loop.settlement", "oracle.feed", "zc.file_read"];
      const message = {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          ...reserved.map((name, i) => toolCall(`r${i}`, name, { step: 999 })),
          toolCall("f1", "file_write", { path: "a", content: "b" }),
          toolCall("h1", "store_get", { key: "k" }),
        ],
      };
      const seen = observedToolCalls(message as any, new Set(["store_get"]));
      assert.deepEqual(
        seen.map((c) => [c.name, c.toolId, c.kind]),
        [...reserved.map((name) => [name, `unknown:${name}`, "unknown"]), ["file_write", "zc.file_write", "file"]]
      );
    });
  });

  it("serves one request at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const p = await startModelProxy({
      socketPath: path.join(dir, "m.sock"),
      token: TOKEN,
      model: MODEL,
      temperature: 0.2,
      expect: { now: NOW },
      chat: async () => {
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return completion({ content: "ok" });
      },
      hostTools: [],
      onToolCalls: async () => undefined,
    });
    open.push(p);
    const rs = await Promise.all([1, 2, 3, 4].map(() => post(p.socketPath, "/v1/chat/completions", zcBody())));
    assert.deepEqual(
      rs.map((r) => r.status),
      [200, 200, 200, 200]
    );
    assert.equal(most, 1);
  });

  it("aborts the paid call when the sandbox closes the request, so it does not hold the queue", async () => {
    // ZeroClaw's provider timeout (120 s) closes the connection; were the call it gave up on to go
    // on waiting, every later request would queue behind it.
    let aborted: unknown;
    const p = await startModelProxy({
      socketPath: path.join(dir, "m.sock"),
      token: TOKEN,
      model: MODEL,
      temperature: 0.2,
      expect: { now: NOW },
      chat: (_req, signal) =>
        new Promise<ChatResult>((_, reject) =>
          signal!.addEventListener("abort", () => {
            aborted = signal!.reason;
            reject(signal!.reason);
          })
        ),
      hostTools: [],
      onToolCalls: async () => undefined,
    });
    open.push(p);
    await new Promise<void>((resolve) => {
      const req = http.request({
        socketPath: p.socketPath,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      });
      req.on("error", () => resolve());
      req.end(JSON.stringify(zcBody()));
      setTimeout(() => req.destroy(), 50);
    });
    for (let i = 0; i < 50 && aborted === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(String((aborted as Error)?.message), /the sandbox closed the request/);
  });

  it("closes only once the call in flight has recorded, so the host reads its failure after it", async () => {
    // A sandbox killed mid-call (its wall clock, an abort): the paid call goes on after the socket
    // closes, and its record has to land before the host resolves the session.
    const order: string[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const p = await startModelProxy({
      socketPath: path.join(dir, "m.sock"),
      token: TOKEN,
      model: MODEL,
      temperature: 0.2,
      expect: { now: NOW },
      chat: (_req, signal) =>
        new Promise<ChatResult>((_, reject) => {
          started();
          signal!.addEventListener("abort", () =>
            // The paid record is written a little after the abort, as `paidChat`'s is.
            setTimeout(() => {
              order.push("recorded");
              reject(new Error("paid and cut"));
            }, 100)
          );
        }),
      hostTools: [],
      onToolCalls: async () => undefined,
    });
    post(p.socketPath, "/v1/chat/completions", zcBody()).catch(() => undefined);
    await inFlight;
    await p.close();
    order.push("closed");
    assert.deepEqual(order, ["recorded", "closed"]);
    assert.match(String((p.failure() as Error)?.message), /paid and cut/);
  });

  it("fails the step for a call that outlives the sandbox, and still waits for its record", async () => {
    // A straggler that records after `close()` returned lands after the Resolution, at a seq the
    // checkpoint may hold. It is waited out, and the step is failed for how long it took.
    const order: string[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const p = await startModelProxy({
      socketPath: path.join(dir, "m.sock"),
      token: TOKEN,
      model: MODEL,
      temperature: 0.2,
      expect: { now: NOW },
      chat: () => {
        started();
        // Deaf to the abort, and slower than the bound: the worst a transport can do.
        return new Promise<ChatResult>((_, reject) =>
          setTimeout(() => {
            order.push("recorded");
            reject(new Error("paid late"));
          }, 150)
        );
      },
      hostTools: [],
      onToolCalls: async () => undefined,
      closeSettleMs: 30,
    });
    post(p.socketPath, "/v1/chat/completions", zcBody()).catch(() => undefined);
    await inFlight;
    await p.close();
    order.push("closed");
    assert.deepEqual(order, ["recorded", "closed"], "no record after close returns");
    assert.match(String((p.failure() as Error)?.message), /still running/);
  });

  it("takes a fresh path only, owner-only, and removes the socket when it closes", async () => {
    const socketPath = path.join(dir, "m.sock");
    const p = await startModelProxy({
      socketPath,
      token: TOKEN,
      model: MODEL,
      temperature: 0.2,
      expect: { now: NOW },
      chat: async () => completion({ content: "ok" }),
      hostTools: [],
      onToolCalls: async () => undefined,
    });
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    let refused: unknown;
    try {
      await startModelProxy({
        socketPath,
        token: TOKEN,
        model: MODEL,
        temperature: 0.2,
        expect: { now: NOW },
        chat: async () => completion({ content: "ok" }),
        hostTools: [],
        onToolCalls: async () => undefined,
      });
    } catch (e) {
      refused = e;
    }
    assert.match(String((refused as Error)?.message), /already exists/);
    await p.close();
    assert.isFalse(fs.existsSync(socketPath));
  });
});

describe("zeroclaw: the tools socket", () => {
  let dir: string;
  const servers: HostToolsServer[] = [];

  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function tools(
    call: (id: string, args: unknown) => Promise<{ result: unknown; statusCode: number }>,
    onRefused?: () => Promise<void>
  ) {
    const calls: [string, unknown][] = [];
    const refused: [string, unknown, string][] = [];
    const server = await startHostTools({
      socketPath: path.join(dir, `t${servers.length}.sock`),
      token: TOKEN,
      allow: ["store.get", "store.set", "solana.slot"],
      call: async (id, args) => {
        calls.push([id, args]);
        return call(id, args);
      },
      onRefused: async (id, args, error) => {
        refused.push([id, args, error]);
        await onRefused?.();
      },
    });
    servers.push(server);
    return { s: server, calls, refused };
  }

  it("refuses a call without the step's bearer", async () => {
    const { s, calls } = await tools(async () => ({ result: 1, statusCode: 200 }));
    assert.equal((await post(s.socketPath, "/tools/store.get", { key: "k" }, { token: "nope" })).status, 401);
    assert.equal((await post(s.socketPath, "/tools/store.get", { key: "k" }, { token: null })).status, 401);
    assert.lengthOf(calls, 0);
  });

  it("answers 403 for an id outside the allow-list and anchors the attempt under the id asked for", async () => {
    const { s, calls, refused } = await tools(async () => ({ result: 1, statusCode: 200 }));
    for (const p of ["/tools/shell", "/tools/store_get", "/tools/lath.verify_chain"]) {
      const r = await post(s.socketPath, p, { a: 1 });
      assert.equal(r.status, 403, p);
      assert.match(r.json.error, /not one this step's policy allows/);
    }
    assert.lengthOf(calls, 0, "nothing ran");
    assert.deepEqual(
      refused.map(([id, args]) => [id, args]),
      [
        ["shell", { a: 1 }],
        ["store_get", { a: 1 }],
        ["lath.verify_chain", { a: 1 }],
      ]
    );
    // A refusal is information for the model, not a failed step.
    assert.isUndefined(s.failure());
  });

  it("answers 404 with no Action for another path, or an id no chain record could carry", async () => {
    const { s, calls, refused } = await tools(async () => ({ result: 1, statusCode: 200 }));
    for (const p of ["/v1/chat/completions", `/tools/${"x".repeat(65)}`, "/tools/a%20b", "/tools/"]) {
      const r = await post(s.socketPath, p, {});
      assert.equal(r.status, 404, p);
      assert.isString(r.json.error);
    }
    assert.lengthOf(calls, 0);
    assert.lengthOf(refused, 0);
  });

  it("fails the step when a refusal's Action does not land", async () => {
    const { s } = await tools(
      async () => ({ result: 1, statusCode: 200 }),
      async () => {
        throw new Error("the chain did not take the refusal");
      }
    );
    assert.equal((await post(s.socketPath, "/tools/shell", {})).status, 500);
    assert.match(String((s.failure() as Error).message), /did not take the refusal/);
    assert.equal((await post(s.socketPath, "/tools/store.get", {})).status, 503);
  });

  it("dispatches the dotted id with the arguments as given, and answers 200 {result}", async () => {
    const { s, calls } = await tools(async (id) => ({ result: { id, value: "v" }, statusCode: 200 }));
    const r = await post(s.socketPath, "/tools/store.get", { key: "k", nested: { a: [1, 2] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { result: { id: "store.get", value: "v" } });
    assert.deepEqual(calls, [["store.get", { key: "k", nested: { a: [1, 2] } }]]);
    const empty = await tools(async () => ({ result: undefined, statusCode: 200 }));
    assert.deepEqual((await post(empty.s.socketPath, "/tools/solana.slot", {})).json, { result: null });
  });

  it("carries a tool's 404 and 500 as {error}", async () => {
    let next: { result: unknown; statusCode: number } = {
      result: { error: 'unknown tool "store.set"' },
      statusCode: 404,
    };
    const { s } = await tools(async () => next);
    const missing = await post(s.socketPath, "/tools/store.set", {});
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'unknown tool "store.set"' });
    next = { result: { error: "rpc timed out" }, statusCode: 500 };
    const crashed = await post(s.socketPath, "/tools/solana.slot", {});
    assert.equal(crashed.status, 500);
    assert.deepEqual(crashed.json, { error: "rpc timed out" });
    assert.isUndefined(s.failure(), "a tool failing is information for the model, not a failed step");
  });

  it("fails the step when a call's Action does not land, and runs nothing after", async () => {
    const { s, calls } = await tools(async () => {
      throw new Error("the chain did not take it");
    });
    const r = await post(s.socketPath, "/tools/store.get", {});
    assert.equal(r.status, 500);
    assert.match(String((s.failure() as Error).message), /did not take it/);
    assert.equal((await post(s.socketPath, "/tools/store.get", {})).status, 503);
    assert.lengthOf(calls, 1);
  });

  it("answers a body that is not JSON without running a tool", async () => {
    const { s, calls } = await tools(async () => ({ result: 1, statusCode: 200 }));
    const r = await post(s.socketPath, "/tools/store.get", undefined, { raw: "{not json" });
    assert.equal(r.status, 400);
    assert.lengthOf(calls, 0);
  });

  it("runs one call at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const { s } = await tools(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { result: 1, statusCode: 200 };
    });
    await Promise.all([1, 2, 3].map(() => post(s.socketPath, "/tools/solana.slot", {})));
    assert.equal(most, 1);
  });

  it("closes only once the call in flight has written its Action", async () => {
    const order: string[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const { s } = await tools(async () => {
      started();
      await new Promise((r) => setTimeout(r, 100));
      order.push("recorded");
      return { result: 1, statusCode: 200 };
    });
    post(s.socketPath, "/tools/solana.slot", {}).catch(() => undefined);
    await inFlight;
    await s.close();
    order.push("closed");
    assert.deepEqual(order, ["recorded", "closed"]);
    assert.isUndefined(s.failure());
  });

  it("fails the step for a tool call that outlives the sandbox, and still waits for its Action", async () => {
    const order: string[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const server = await startHostTools({
      socketPath: path.join(dir, "late.sock"),
      token: TOKEN,
      allow: ["solana.slot"],
      call: async () => {
        started();
        await new Promise((r) => setTimeout(r, 150));
        order.push("recorded");
        return { result: 1, statusCode: 200 };
      },
      onRefused: async () => undefined,
      closeSettleMs: 30,
    });
    servers.push(server);
    post(server.socketPath, "/tools/solana.slot", {}).catch(() => undefined);
    await inFlight;
    await server.close();
    order.push("closed");
    assert.deepEqual(order, ["recorded", "closed"], "no Action after close returns");
    assert.match(String((server.failure() as Error)?.message), /still running/);
  });

  it("runs nothing queued behind the call in flight once the sandbox has exited", async () => {
    const ran: number[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    let n = 0;
    const server = await startHostTools({
      socketPath: path.join(dir, "queued.sock"),
      token: TOKEN,
      allow: ["solana.slot"],
      call: async () => {
        const me = ++n;
        ran.push(me);
        if (me === 1) {
          started();
          await new Promise((r) => setTimeout(r, 100));
        }
        return { result: me, statusCode: 200 };
      },
      onRefused: async () => undefined,
    });
    servers.push(server);
    post(server.socketPath, "/tools/solana.slot", {}).catch(() => undefined);
    await inFlight;
    // Queued behind the first, then the sandbox goes away.
    post(server.socketPath, "/tools/solana.slot", {}).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await server.close();
    assert.deepEqual(ran, [1], "the queued call ran nothing and wrote nothing");
  });
});

/**
 * The refactored runtime, driven the way the sandboxed executor will drive it: a subclass whose
 * `runTurns` plays the sandbox — it POSTs to the two sockets it started, bound to `paidChat`,
 * `recordToolAction` and `callTool` — instead of running the ReAct loop.
 */
describe("zeroclaw: AgentRuntime driven from outside the ReAct loop", () => {
  const AGENT = idFromString("zeroclaw-proxy-agent");

  /** The sandbox's side of a step: the requests it sends, in order, and host-tool calls between them. */
  type SandboxScript = (
    send: (body: unknown) => Promise<{ status: number; json: any }>,
    tool: (id: string, args: unknown) => Promise<{ status: number; json: any }>
  ) => Promise<string>;

  class SandboxRuntime extends AgentRuntime {
    sandbox?: SandboxScript;
    /** The `ZEROCLAW_NOW` this step's sandbox was told. */
    stepNow = NOW;

    protected async runTurns(s: SessionCtx, _messages: ChatMessage[], _opts: StartOptions): Promise<TurnsOutcome> {
      const dir = tempDir();
      let proxy: ModelProxy | undefined;
      let host: HostToolsServer | undefined;
      try {
        proxy = await startModelProxy({
          socketPath: path.join(dir, "m.sock"),
          token: TOKEN,
          model: this.policy.model,
          temperature: this.policy.temperature!,
          expect: { now: this.stepNow },
          hostTools: this.policy.toolAllowList.map((id) => id.replace(/\./g, "_")),
          chat: (req) => this.paidChat(s, req),
          onToolCalls: async (calls) => {
            for (const c of calls) await this.recordToolAction(s, c);
          },
        });
        host = await startHostTools({
          socketPath: path.join(dir, "t.sock"),
          token: TOKEN,
          allow: this.policy.toolAllowList,
          call: (id, args) => this.callTool(s, id, args),
          onRefused: (id, args, error) =>
            this.recordToolAction(s, { toolId: id, args, result: { error }, statusCode: 403 }),
        });
        const m = proxy.socketPath;
        const t = host.socketPath;
        const output = await this.sandbox!(
          (body) => post(m, "/v1/chat/completions", body),
          (id, args) => post(t, `/tools/${id}`, args)
        );
        // What the sandbox's process exit would carry: the first thing that failed, as thrown.
        const failure = proxy.failure() ?? host.failure();
        if (failure) throw failure;
        return { status: "success", output };
      } finally {
        await proxy?.close();
        await host?.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  function options(
    chain: FakeChain,
    transport: ChatTransport,
    events: RuntimeEvent[],
    extra: Partial<AgentRuntimeOptions> = {}
  ) {
    return {
      client: chain.asClient(),
      agentId: AGENT,
      transport,
      store: new MemoryTraceStore(),
      billing: new NoopBilling(),
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      onEvent: (e: RuntimeEvent) => events.push(e),
      policy: { model: MODEL, temperature: 0.2, toolAllowList: [], maxCost: 5_000_000 },
      ...extra,
    } as AgentRuntimeOptions;
  }

  /** A transport that answers from a script, recording what it was sent. */
  function transport(replies: ChatResult[]) {
    const seen: ChatRequest[] = [];
    const t: ChatTransport = {
      async chat(req) {
        seen.push(JSON.parse(JSON.stringify(req)));
        return replies[Math.min(seen.length - 1, replies.length - 1)];
      },
    };
    return { t, seen };
  }

  const PROMPT = "[2026-09-24 12:00:00 +00:00] Say hello.";

  it("writes the same chain for a model call through the socket as for a ReAct turn", async () => {
    const reply = completion({ content: "hello" });

    // The ReAct loop, as every session runs today.
    const plainChain = new FakeChain();
    const plainEvents: RuntimeEvent[] = [];
    const plain = transport([reply]);
    const direct = new AgentRuntime(options(plainChain, plain.t, plainEvents));
    const a = await direct.start({ user: USER, prompt: PROMPT, sessionId: "zc-same" });
    assert.equal(a.status, "success", a.reason);

    // The same request, sent by a sandbox as ZeroClaw would build it: without the usage flag, which
    // the proxy adds, and with its own temperature, which the proxy pins.
    const sandboxChain = new FakeChain();
    const sandboxEvents: RuntimeEvent[] = [];
    const viaSandbox = transport([reply]);
    const sandboxed = new SandboxRuntime(options(sandboxChain, viaSandbox.t, sandboxEvents));
    sandboxed.sandbox = async (send) => {
      const { usage: _usage, ...body } = plain.seen[0] as any;
      const r = await send({ ...body, temperature: 0.9 });
      assert.equal(r.status, 200);
      return r.json.choices[0].message.content;
    };
    const b = await sandboxed.start({ user: USER, prompt: PROMPT, sessionId: "zc-same" });
    assert.equal(b.status, "success", b.reason);

    // Byte-identical requests, so the same `args_hash`; the same body, so the same `result_hash`;
    // and so the same chain, record for record, to the Resolution's head.
    assert.equal(JSON.stringify(viaSandbox.seen[0]), JSON.stringify(plain.seen[0]));
    assert.equal(hex(b.head), hex(a.head));
    assert.equal(b.steps, a.steps);
    assert.equal(b.costMicroUsdc, a.costMicroUsdc);
    assert.deepEqual(
      sandboxEvents.map((e) => [e.type, e.toolId, e.statusCode, e.head]),
      plainEvents.map((e) => [e.type, e.toolId, e.statusCode, e.head])
    );
  });

  it("puts every call of a sandbox's step on the chain once, in the order it happened", async () => {
    const reply1 = completion({
      tool_calls: [
        toolCall("call_1", "file_write", { path: "a.txt", content: "hi" }),
        toolCall("call_2", "store_get", { key: "k" }),
      ],
    });
    const reply2 = completion({ content: "DONE" }, 2);
    const chain = new FakeChain();
    const events: RuntimeEvent[] = [];
    const { t } = transport([reply1, reply2]);
    const store = new MemoryTraceStore();
    const runtime = new SandboxRuntime(
      options(chain, t, events, {
        store,
        tools: [{ name: "store.get", execute: async (args: any) => ({ key: args.key, value: "v" }) }],
        policy: { model: MODEL, temperature: 0.2, toolAllowList: ["store.get"], maxCost: 5_000_000 },
      })
    );
    runtime.sandbox = async (send, tool) => {
      const r1 = await send(zcBody());
      const calls = r1.json.choices[0].message.tool_calls;
      // The sandbox runs file_write itself, and store_get through the tools socket.
      const got = await tool("store.get", JSON.parse(calls[1].function.arguments));
      assert.equal(got.status, 200);
      const b = zcBody();
      b.messages.push(r1.json.choices[0].message);
      b.messages.push({
        role: "tool",
        tool_call_id: "call_1",
        name: "file_write",
        content: "Written 2 bytes to a.txt",
      });
      b.messages.push({
        role: "tool",
        tool_call_id: "call_2",
        name: "store_get",
        content: JSON.stringify(got.json.result),
      });
      const r2 = await send(b);
      return r2.json.choices[0].message.content;
    };
    const result = await runtime.start({ user: USER, prompt: "write and read", sessionId: "zc-order" });
    assert.equal(result.status, "success", result.reason);
    assert.equal(result.output, "DONE");
    assert.equal(result.steps, 2, "two paid model calls");

    // store.get is written as it runs; file_write when the request carrying its result arrives,
    // before that request's model call.
    assert.deepEqual(
      events.map((e) => (e.type === "action" ? `${e.toolId}:${e.statusCode}` : e.type)),
      ["genesis", `llm.${MODEL}:200`, "store.get:200", "zc.file_write:200", `llm.${MODEL}:200`, "resolution"]
    );
    assert.lengthOf(result.events, 6);
    // The zc Action commits the model's arguments as a tool Action does, and the sandbox's result text.
    const zc = result.events[3] as any;
    const argsBlob = await store.get(zc.argsHash);
    const resultBlob = await store.get(zc.resultHash);
    assert.equal(Buffer.from(argsBlob!).toString("utf8"), JSON.stringify({ path: "a.txt", content: "hi" }));
    assert.equal(Buffer.from(resultBlob!).toString("utf8"), "Written 2 bytes to a.txt");
  });

  it("anchors an invented name as a 404 and a host tool outside the policy as a 403, and runs neither", async () => {
    const reply1 = completion({ tool_calls: [toolCall("call_1", "shell", { cmd: "ls" })] });
    const reply2 = completion({ content: "DONE" }, 2);
    const chain = new FakeChain();
    const events: RuntimeEvent[] = [];
    const { t } = transport([reply1, reply2]);
    let ran = 0;
    const runtime = new SandboxRuntime(
      options(chain, t, events, {
        tools: [{ name: "store.get", execute: async () => (ran++, { value: "v" }) }],
        policy: { model: MODEL, temperature: 0.2, toolAllowList: ["store.get"], maxCost: 5_000_000 },
      })
    );
    runtime.sandbox = async (send, tool) => {
      const r1 = await send(zcBody());
      // A sandbox asking the tools socket for a host tool the policy does not allow.
      const refused = await tool("store.set", { key: "k", value: "v" });
      assert.equal(refused.status, 403);
      const b = zcBody();
      b.messages.push(r1.json.choices[0].message);
      b.messages.push({ role: "tool", tool_call_id: "call_1", name: "shell", content: "Unknown tool: shell" });
      const r2 = await send(b);
      return r2.json.choices[0].message.content;
    };
    const result = await runtime.start({ user: USER, prompt: "try", sessionId: "zc-refused" });
    assert.equal(result.status, "success", result.reason);
    assert.equal(ran, 0);
    assert.deepEqual(
      events.map((e) => (e.type === "action" ? `${e.toolId}:${e.statusCode}` : e.type)),
      ["genesis", `llm.${MODEL}:200`, "store.set:403", "unknown:shell:404", `llm.${MODEL}:200`, "resolution"]
    );
  });

  it("resolves a step aborted when the ceiling stops a call from the sandbox", async () => {
    const expensive = completion({ content: "hi" });
    expensive.payment = { ...PAYMENT, cumulativeAfter: "10000" };
    const chain = new FakeChain();
    const events: RuntimeEvent[] = [];
    const { t } = transport([expensive]);
    const runtime = new SandboxRuntime(
      options(chain, t, events, { policy: { model: MODEL, temperature: 0.2, toolAllowList: [], maxCost: 500 } })
    );
    runtime.sandbox = async (send) => {
      const r = await send(zcBody());
      assert.isAtLeast(r.status, 500, "the sandbox is told the call failed");
      return "";
    };
    const result = await runtime.start({ user: USER, prompt: "hi", sessionId: "zc-budget" });
    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /µUSDC budget/);
    // The call that breached the budget is paid for and recorded; the ceiling stops the next.
    assert.deepEqual(
      events.map((e) => e.type),
      ["genesis", "action", "resolution"]
    );
  });

  it("refuses a sandbox whose clock is not the step's, and the step fails with the reason", async () => {
    const chain = new FakeChain();
    const events: RuntimeEvent[] = [];
    const { t, seen } = transport([completion({ content: "hi" })]);
    const runtime = new SandboxRuntime(options(chain, t, events));
    runtime.sandbox = async (send) => {
      await send(zcBody({ user: "[2026-09-24 12:03:41 +00:00] hi" }));
      return "";
    };
    const result = await runtime.start({ user: USER, prompt: "hi", sessionId: "zc-clock" });
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /dated/);
    assert.lengthOf(seen, 0, "nothing was paid for");
    assert.deepEqual(
      events.map((e) => e.type),
      ["genesis", "resolution"]
    );
  });
});
