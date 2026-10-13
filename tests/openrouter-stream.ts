/**
 * The streaming transport.
 *
 * The interactive console needs the model's tokens as they arrive, but the chain is written from
 * `res.body`: `resultHash` commits to it, so a session that streamed and one that buffered must
 * produce byte-identical bodies or the same conversation audits differently depending on which
 * path the console happened to take. That equality is the point of this file, and everything
 * else here guards a way of losing it — a line split across network chunks, a tool call whose
 * arguments arrive in fragments, a stream cut before `[DONE]`.
 *
 * Node-only: a fake `fetchImpl` supplies the SSE body, so there is no network and no key.
 */
import { expect } from "chai";
import { chatCore, OpenRouterClient, OpenRouterError } from "../runtime/src/openrouter";
import type { ChatRequest, ChatResponse } from "../runtime/src/openrouter";
import { RecordedTransport } from "./fixtures/recorded-transport";

const REQ: ChatRequest = {
  model: "anthropic/claude-3.5-haiku",
  messages: [{ role: "user", content: "two words" }],
  usage: { include: true },
};

/** What the same completion looks like when OpenRouter is asked for it without `stream`. */
const BUFFERED: ChatResponse = {
  id: "gen-1",
  model: "anthropic/claude-3.5-haiku",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello there",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lath.now", arguments: '{"tz":"UTC"}' } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15, cost: 0.000123 },
};

/** The chunk sequence a provider sends for `BUFFERED`, including the keep-alive comment lines. */
const SSE = [
  ": OPENROUTER PROCESSING\n\n",
  'data: {"id":"gen-1","model":"anthropic/claude-3.5-haiku","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
  'data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n',
  ': OPENROUTER PROCESSING\n\ndata: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lath.now","arguments":"{\\"tz\\":"}}]}}]}\n\n',
  'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15,"cost":0.000123}}\n\n',
  "data: [DONE]\n\n",
].join("");

/**
 * Splits `text` into byte chunks that deliberately fall mid-line: the transport's line buffer is
 * the only thing between a split `data:` line and a JSON parse error, so the fixture has to
 * exercise it rather than hand over one tidy chunk per event.
 */
function sseStream(text: string, every = 17): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + every));
      at += every;
    },
  });
}

/** Records the request body so the "no `stream` field when buffered" assertion can read it. */
function fakeFetch(respond: () => Response): { impl: typeof fetch; bodies: any[]; inits: RequestInit[] } {
  const bodies: any[] = [];
  const inits: RequestInit[] = [];
  const impl = (async (_url: any, init: RequestInit) => {
    inits.push(init);
    bodies.push(JSON.parse(String(init.body)));
    return respond();
  }) as unknown as typeof fetch;
  return { impl, bodies, inits };
}

function client(impl: typeof fetch): OpenRouterClient {
  return new OpenRouterClient({ apiKey: "test-key", fetchImpl: impl });
}

describe("openrouter streaming transport", () => {
  it("assembles a streamed body that equals the buffered one field for field", async () => {
    const f = fakeFetch(() => new Response(sseStream(SSE), { status: 200 }));
    const tokens: string[] = [];
    const res = await client(f.impl).chat(REQ, { onToken: (t) => tokens.push(t) });

    expect(res.status).to.equal(200);
    expect(res.streamed).to.equal(true);
    expect(res.body).to.deep.equal(BUFFERED);
    // Every delta, in arrival order, and nothing that was not a content delta.
    expect(tokens).to.deep.equal(["Hello", " there"]);
    expect(tokens.join("")).to.equal(BUFFERED.choices[0].message.content);
  });

  it("sends `stream: true` only when onToken is given", async () => {
    const streamed = fakeFetch(() => new Response(sseStream(SSE), { status: 200 }));
    await client(streamed.impl).chat(REQ, { onToken: () => undefined });
    expect(streamed.bodies[0].stream).to.equal(true);
    // The rest of the request is untouched — the model, the messages and the usage meter.
    delete streamed.bodies[0].stream;
    expect(streamed.bodies[0]).to.deep.equal(JSON.parse(JSON.stringify(REQ)));

    const buffered = fakeFetch(() => new Response(JSON.stringify(BUFFERED), { status: 200 }));
    const res = await client(buffered.impl).chat(REQ);
    // Byte-for-byte the request the buffered path has always sent: no `stream` key at all, so a
    // chain written before streaming existed and one written now hash the same `argsHash`.
    expect(String(buffered.inits[0].body)).to.equal(JSON.stringify(REQ));
    expect("stream" in buffered.bodies[0]).to.equal(false);
    expect(res.body).to.deep.equal(BUFFERED);
    expect(res.streamed).to.equal(undefined);
  });

  it("merges tool-call deltas that share an index and keeps a content-free reply null", async () => {
    const sse = [
      'data: {"id":"gen-2","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"one","arguments":"{\\"x\\""}},{"index":1,"id":"b","type":"function","function":{"name":"two","arguments":"{}"}}]}}]}\n\n',
      'data: {"id":"gen-2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const f = fakeFetch(() => new Response(sseStream(sse, 13), { status: 200 }));
    const tokens: string[] = [];
    const res = await client(f.impl).chat(REQ, { onToken: (t) => tokens.push(t) });

    expect(tokens).to.deep.equal([]);
    // `null`, not `""`: that is what the buffered form of a tool-call-only reply carries, and a
    // different value here would be a different hashed body for the same completion.
    expect(res.body.choices[0].message.content).to.equal(null);
    expect(res.body.choices[0].message.tool_calls).to.deep.equal([
      { id: "a", type: "function", function: { name: "one", arguments: '{"x":1}' } },
      { id: "b", type: "function", function: { name: "two", arguments: "{}" } },
    ]);
    expect(res.body.choices[0].finish_reason).to.equal("tool_calls");
    expect(res.body.usage).to.equal(undefined);
  });

  it("raises OpenRouterError with the body on a non-2xx, streamed or not", async () => {
    const err = () => new Response('{"error":{"message":"insufficient credits"}}', { status: 402 });
    for (const opts of [undefined, { onToken: () => undefined }]) {
      const f = fakeFetch(err);
      const thrown = await client(f.impl)
        .chat(REQ, opts)
        .then(
          () => null,
          (e) => e
        );
      expect(thrown).to.be.instanceOf(OpenRouterError);
      expect((thrown as OpenRouterError).status).to.equal(402);
      expect((thrown as OpenRouterError).body).to.contain("insufficient credits");
    }
  });

  it("raises rather than anchoring a stream that was cut before [DONE]", async () => {
    const cut = SSE.slice(0, SSE.indexOf("data: [DONE]"));
    const f = fakeFetch(() => new Response(sseStream(cut), { status: 200 }));
    const thrown = await client(f.impl)
      .chat(REQ, { onToken: () => undefined })
      .then(
        () => null,
        (e) => e
      );
    expect(thrown).to.be.instanceOf(OpenRouterError);
    // What was received is in the error, because a truncated reply is diagnosed from its tail.
    expect((thrown as OpenRouterError).body).to.contain("Hello");
  });

  it("raises on a chunk that carries an error object after the 200 headers", async () => {
    const sse =
      'data: {"id":"gen-3","model":"m","choices":[{"index":0,"delta":{"content":"par"}}]}\n\n' +
      'data: {"error":{"code":502,"message":"provider dropped"}}\n\n' +
      "data: [DONE]\n\n";
    const f = fakeFetch(() => new Response(sseStream(sse, 29), { status: 200 }));
    const thrown = await client(f.impl)
      .chat(REQ, { onToken: () => undefined })
      .then(
        () => null,
        (e) => e
      );
    expect(thrown).to.be.instanceOf(OpenRouterError);
    expect((thrown as OpenRouterError).body).to.contain("provider dropped");
  });

  it("passes the abort signal to fetch", async () => {
    const ac = new AbortController();
    const f = fakeFetch(() => new Response(sseStream(SSE), { status: 200 }));
    await client(f.impl).chat(REQ, { onToken: () => undefined, signal: ac.signal });
    expect(f.inits[0].signal).to.equal(ac.signal);
  });

  it("assembles the same body through chatCore, which is all OpenRouterClient adds a key to", async () => {
    // The vault and `tempo` rails share this function; the client is a
    // caller that supplies the URL, the bearer header and `[DONE]` as the terminal frame, so a
    // body assembled either way is the same body and the two rails audit alike.
    const f = fakeFetch(() => new Response(sseStream(SSE), { status: 200 }));
    const res = await chatCore(f.impl, "https://openrouter.ai/api/v1/chat/completions", { a: "b" }, REQ, {
      onToken: () => undefined,
    });
    expect(res.body).to.deep.equal(BUFFERED);

    const client = fakeFetch(() => new Response(JSON.stringify(BUFFERED), { status: 200 }));
    await new OpenRouterClient({ apiKey: "test-key", fetchImpl: client.impl, title: "t" }).chat(REQ);
    const headers = client.inits[0].headers as Record<string, string>;
    expect(headers.Authorization).to.equal("Bearer test-key");
    expect(headers["X-Title"]).to.equal("t");
  });

  it("still demands [DONE] on the vault rail when the stream carries a payment receipt", async () => {
    // The MPP gateway's terminal frame is not something OpenRouter sends, so it neither
    // ends a vault-rail stream nor is parsed as a completion chunk.
    const sse =
      'data: {"id":"gen-4","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
      "event: payment-receipt\n" +
      'data: {"channelId":"0xabc","acceptedCumulative":"750","spent":"750","units":1}\n\n';
    const f = fakeFetch(() => new Response(sseStream(sse, 23), { status: 200 }));
    const thrown = await client(f.impl)
      .chat(REQ, { onToken: () => undefined })
      .then(
        () => null,
        (e) => e
      );
    expect(thrown).to.be.instanceOf(OpenRouterError);

    // The same bytes on the `tempo` rail are a complete reply, and the receipt stays out of it.
    const g = fakeFetch(() => new Response(sseStream(sse, 23), { status: 200 }));
    const seen: Record<string, unknown>[] = [];
    const res = await chatCore(g.impl, "https://gateway.invalid", {}, REQ, {
      onToken: () => undefined,
      terminal: "receipt",
      onReceipt: (r) => seen.push(r),
    });
    expect(res.body.choices[0].message.content).to.equal("hi");
    expect(res.body.usage).to.equal(undefined);
    expect(seen).to.deep.equal([{ channelId: "0xabc", acceptedCumulative: "750", spent: "750", units: 1 }]);
  });

  it("tells onFirstData once, at the first data frame and not at a keep-alive comment", async () => {
    // The first-data window a retried chat attempt gets is cleared by this call: a comment is what
    // the gateway sends while it still waits on the model, so it must not count as the answer starting.
    const seen: string[] = [];
    const impl = (async () => {
      seen.push("fetch");
      return new Response(sseStream(SSE, 5), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await chatCore(impl, "https://x.test", {}, REQ, {
      onToken: (t) => seen.push(`token:${t}`),
      onFirstData: () => seen.push("first"),
    });
    expect(res.body).to.deep.equal(BUFFERED);
    expect(seen.filter((x) => x === "first")).to.have.length(1);
    // Before the first token: the frame that carried it is the first data frame.
    expect(seen.slice(0, 3)).to.deep.equal(["fetch", "first", "token:Hello"]);

    // A stream of nothing but comments never starts the answer.
    let first = 0;
    const comments = (async () =>
      new Response(sseStream(": OPENROUTER PROCESSING\n\n"), { status: 200 })) as unknown as typeof fetch;
    await chatCore(comments, "https://x.test", {}, REQ, { onToken: () => undefined, onFirstData: () => first++ }).catch(
      () => undefined
    );
    expect(first).to.equal(0);
  });

  it("RecordedTransport replays a recording as one token and still returns the recorded body", async () => {
    const t = new RecordedTransport([{ status: 200, body: BUFFERED }]);
    const plain = await t.chat(REQ);
    expect(plain.body).to.deep.equal(BUFFERED);
    expect(plain.streamed).to.equal(undefined);

    const t2 = new RecordedTransport([{ status: 200, body: BUFFERED }]);
    const tokens: string[] = [];
    const streamed = await t2.chat(REQ, { onToken: (x) => tokens.push(x) });
    expect(tokens).to.deep.equal(["Hello there"]);
    expect(streamed.streamed).to.equal(true);
    expect(streamed.body).to.deep.equal(BUFFERED);
  });
});
