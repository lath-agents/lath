/**
 * The transport that pays for inference over MPP (docs/ARCHITECTURE.md §7.2).
 *
 * The claim this file guards is that the rail is invisible to the chain: a record written on the
 * `tempo` rail commits the same `ChatResponse` bytes a record written on the vault rail commits,
 * so the same conversation audits identically whichever rail paid for it, and the payment rides
 * beside the body rather than inside it. Everything else here guards a way of losing money to a
 * bug — a cumulative read before the gateway's receipt arrived, a retry that would sign a second
 * voucher, a stream nobody is reading that keeps a channel open.
 *
 * Node-only, network-free, key-free: a `FakeMppSession` replays `tests/fixtures/tempo-gateway.json`
 * (re-created by hand from measured gateway answers, not recorded live) and the account is an address with no
 * key behind it. No Tempo transaction is made and no mainnet money can be spent from here.
 */
import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  AgentRuntime,
  canonicalJson,
  CHANNEL_OPENED_TOPIC,
  chatCore,
  decideWithin,
  MppOpenRouterTransport,
  MppSession,
  NoAnswerTimeout,
  NoopBilling,
  OpenRouterClient,
  OpenRouterError,
  openBlockOf,
  PaidCallFailed,
  policyDocument,
  policyVersionHash,
  TEMPO_DECISIONS_URL,
  toHumanUsdc,
  toRuntimePolicy,
} from "../runtime/src";
import { hex, idFromString, MemoryTraceStore, settlementFromBlob } from "@lath/sdk";
import type {
  ChatRequest,
  ChatResponse,
  ChatResult,
  ChatTransport,
  DecideRequest,
  MppChannelEntry,
  MppChannelRecovery,
  MppCloseReceipt,
  RuntimePolicy,
  TempoChannel,
} from "../runtime/src";
import { FakeChain } from "./fixtures/fake-chain";

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tempo-gateway.json"), "utf8")) as {
  channelId: string;
  withUsage: { status: number; body: ChatResponse };
  withoutUsage: { status: number; body: ChatResponse };
  streamed: { status: number; sse: string[]; body: ChatResponse };
  refused: { status: number; body: Record<string, unknown> };
  quoteBaseUnits: string;
};

/** The gateway's flat per-request quote for `openai/gpt-4o-mini`: the meter's unit. */
const QUOTE = BigInt(FIXTURE.quoteBaseUnits);

const REQ: ChatRequest = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Reply with the single word: pong" }],
  usage: { include: true },
};

/** An address with no key: the transport hands the account to mppx and reads only `.address`. */
const PAYER = "0x18fB0000000000000000000000000000000000B0";

/** The gateway's flat quote for one decision: 42 base units, whatever the state (as probed). */
const DECISION_QUOTE = BigInt(42);

/**
 * A decisions answer body as the probe recorded it through the gateway: TypeSafe's `answers`,
 * plus OpenRouter's `id`, `provider` and
 * `usage.cost`, and the dated build the pinned slug resolved to.
 */
const DECISION_BODY = {
  id: "gen-jev-0000000000000000",
  provider: "TypeSafe",
  model: "typesafe/jev-1.13-20260917",
  answers: {
    followed_plan: { noul: 0.87, confidence: 0.87 },
    verdict: { choice: "accept", confidence: 0.91, probabilities: { accept: 0.91, retry: 0.07, escalate: 0.02 } },
  },
  usage: { prompt_tokens: 601, completion_tokens: 48, total_tokens: 649, cost: 0.000025242 },
};

const DECIDE: DecideRequest = {
  model: "typesafe/jev-1.13",
  state: "PROMPT: …\n\nPREVIOUS MEMORY: none\n\nSTEP OUTPUT: LTV_CAP=65",
  questions: { followed_plan: { type: "noul" }, verdict: { type: "choice" } },
};

interface Plan {
  status: number;
  /** A buffered body, or the SSE frames of a streamed one. */
  text?: string;
  sse?: string[];
  /** Whether this call advances the channel's cumulative. A refusal does not. */
  charge?: bigint;
}

/**
 * mppx's session manager, as much of it as the transport touches. Two things make it a test
 * rather than a stub: `cumulative` records when it was read against whether the body had been
 * drained by then, and the body is always a stream chunked mid-line, so a reader that stops at
 * the wrong frame is caught here rather than on mainnet.
 */
class FakeMppSession implements MppSession {
  readonly fetches: { url: string; init?: RequestInit }[] = [];
  /** Every read of `cumulative`, with the drain state at the moment it was read. */
  readonly reads: { value: string; drained: boolean }[] = [];
  closes = 0;
  /** Set when a fetch's `AbortSignal` was seen aborted while the body was being written. */
  abortSeen = false;
  opened = false;
  channelId: string | undefined;
  private total = BigInt(0);
  private drained = false;
  private i = 0;

  private readonly plans: Plan[];
  private readonly chunk: number;

  constructor(plans: Plan[], chunk = 17) {
    this.plans = plans;
    this.chunk = chunk;
  }

  get cumulative(): bigint {
    this.reads.push({ value: this.total.toString(), drained: this.drained });
    return this.total;
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.fetches.push({ url, init });
    // A channel is opened by the first 402 inside mppx, before any body comes back.
    this.opened = true;
    this.channelId = FIXTURE.channelId;
    const plan = this.plans[Math.min(this.i++, this.plans.length - 1)];
    this.drained = false;
    const text = plan.text ?? (plan.sse ?? []).join("");
    const bytes = new TextEncoder().encode(text);
    const signal = init?.signal as AbortSignal | undefined;
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (signal?.aborted) {
          // What a real `fetch` does to a body whose caller walked away.
          this.abortSeen = true;
          controller.error(new Error("the request was aborted"));
          return;
        }
        if (at >= bytes.length) {
          // The voucher is accepted by the gateway as it finishes the response, so the channel
          // advances exactly here: a transport that read `cumulative` any earlier reads zero.
          if (plan.charge) this.total += plan.charge;
          this.drained = true;
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, at + this.chunk));
        at += this.chunk;
      },
      cancel: () => {
        // Dropping the body is how the gateway learns nobody is reading: the transport cancels
        // its reader as it raises, whether or not the abort reached this fetch first.
        if (signal?.aborted) this.abortSeen = true;
      },
    });
    return new Response(body, { status: plan.status });
  }

  async close(): Promise<MppCloseReceipt> {
    this.closes++;
    return { txHash: "0xc1d6a5ed0000000000000000000000000000000000000000000000000000745c", spent: this.total };
  }
}

function transport(session: MppSession): MppOpenRouterTransport {
  return new MppOpenRouterTransport({
    account: { address: PAYER },
    maxCostBase: BigInt(10_000),
    maxSteps: 4,
    sessionFactory: async () => session,
  });
}

/** The vault rail over the same bytes, for the byte-identity claim. */
async function vaultBody(text: string, streamed = false): Promise<ChatResponse> {
  const impl = (async () => new Response(text, { status: 200 })) as unknown as typeof fetch;
  const client = new OpenRouterClient({ apiKey: "test-key", fetchImpl: impl });
  const res = await client.chat(REQ, streamed ? { onToken: () => undefined } : undefined);
  return res.body;
}

describe("tempo inference transport", () => {
  it("produces the body the vault rail produces, and hangs the payment beside it", async () => {
    const session = new FakeMppSession([{ status: 200, text: JSON.stringify(FIXTURE.withUsage.body), charge: QUOTE }]);
    const t = transport(session);
    const res = await t.chat(REQ);

    // The bytes a record hashes, identical across rails: `result_hash` is comparable, which is
    // what lets one auditor read chains written on either.
    expect(canonicalJson(res.body)).to.equal(canonicalJson(await vaultBody(JSON.stringify(FIXTURE.withUsage.body))));
    expect(res.status).to.equal(200);
    expect(res.payment).to.deep.equal({
      rail: "tempo",
      chainId: 4217,
      payer: PAYER,
      channelId: FIXTURE.channelId,
      cumulativeBefore: "0",
      cumulativeAfter: QUOTE.toString(),
      usageCost: FIXTURE.withUsage.body.usage!.cost,
    });
    // The gateway's flat quote, not the token cost: 750 base units against 3.3 µUSD.
    expect(BigInt(res.payment!.cumulativeAfter) - BigInt(res.payment!.cumulativeBefore)).to.equal(QUOTE);
    expect(res.payment!.usageCost).to.not.equal(Number(QUOTE) / 1e6);
    expect(t.channelId).to.equal(FIXTURE.channelId);
    expect(t.opened).to.equal(true);
    expect(t.payer).to.equal(PAYER);
  });

  // An opening promise cached with no reset would let one factory that failed answer every later
  // call of the process with the same rejection. `MppRpcSession` resets.
  it("tries to open again after a factory that failed, rather than keeping its rejection", async () => {
    const session = new FakeMppSession([{ status: 200, text: JSON.stringify(FIXTURE.withUsage.body), charge: QUOTE }]);
    let calls = 0;
    const t = new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      sessionFactory: async () => {
        calls++;
        if (calls === 1) throw new Error("mppx/client could not be loaded");
        return session;
      },
    });
    let first: unknown;
    await t.chat(REQ).catch((e) => (first = e));
    expect(String((first as Error)?.message)).to.match(/could not be loaded/);
    const res = await t.chat(REQ);
    expect(res.status).to.equal(200);
    expect(calls).to.equal(2);
  });

  it("records no usageCost when the gateway returned none, and still meters the delta", async () => {
    const session = new FakeMppSession([
      { status: 200, text: JSON.stringify(FIXTURE.withoutUsage.body), charge: QUOTE },
    ]);
    const res = await transport(session).chat(REQ);

    expect(canonicalJson(res.body)).to.equal(canonicalJson(await vaultBody(JSON.stringify(FIXTURE.withoutUsage.body))));
    // Absent, not zero: zero would read as "the model was free" rather than "the gateway said
    // nothing about it", and the meter is the delta either way.
    expect("usageCost" in res.payment!).to.equal(false);
    expect(res.payment!.cumulativeAfter).to.equal(QUOTE.toString());
  });

  it("reads the cumulative only after the gateway's payment-receipt frame", async () => {
    const session = new FakeMppSession([{ status: 200, sse: FIXTURE.streamed.sse, charge: QUOTE }]);
    const tokens: string[] = [];
    const res = await transport(session).chat(REQ, { onToken: (t) => tokens.push(t) });

    // The gateway sends no `data: [DONE]`; the stream still assembles the buffered body.
    expect(res.streamed).to.equal(true);
    expect(res.body).to.deep.equal(FIXTURE.streamed.body);
    expect(canonicalJson(res.body)).to.equal(canonicalJson(await vaultBody(JSON.stringify(FIXTURE.streamed.body))));
    expect(tokens).to.deep.equal(["po", "ng"]);
    // One fetch per call, so the before/after pair brackets exactly one request.
    expect(session.fetches.length).to.equal(1);
    expect(res.payment!.cumulativeBefore).to.equal("0");
    expect(res.payment!.cumulativeAfter).to.equal(QUOTE.toString());
    // The only read that saw the charge saw it after the body was drained: a transport that read
    // it a frame early would have committed a delta of zero for a call it paid 750 for.
    for (const read of session.reads) expect(read.value === "0" || read.drained).to.equal(true);
    expect(session.reads[session.reads.length - 1].drained).to.equal(true);
  });

  it("rejects a refused voucher and does not try again", async () => {
    const session = new FakeMppSession([{ status: 402, text: JSON.stringify(FIXTURE.refused.body) }]);
    const t = transport(session);
    const thrown = await t.chat(REQ).then(
      () => null,
      (e) => e
    );

    expect(thrown).to.be.instanceOf(OpenRouterError);
    expect((thrown as OpenRouterError).status).to.equal(402);
    expect((thrown as OpenRouterError).body).to.contain("the voucher was refused");
    // No retry, no backoff: a second attempt would sign a second voucher for a completion the
    // first attempt may already have bought.
    expect(session.fetches.length).to.equal(1);
    // Nothing was charged, and the throw happens before any store write or charge in the runtime.
    expect(t.channelId).to.equal(FIXTURE.channelId);
  });

  it("rejects when the caller aborts mid-stream, and the gateway sees the abort", async () => {
    const session = new FakeMppSession([{ status: 200, sse: FIXTURE.streamed.sse, charge: QUOTE }]);
    const ac = new AbortController();
    const thrown = await transport(session)
      .chat(REQ, { onToken: () => ac.abort(), signal: ac.signal })
      .then(
        () => null,
        (e) => e
      );

    expect(thrown).to.be.instanceOf(Error);
    // The fetch carries the transport's deadline signal, which follows the caller's: aborted with it.
    expect((session.fetches[0].init!.signal as AbortSignal).aborted).to.equal(true);
    expect(session.abortSeen).to.equal(true);
  });

  it("settles once and only when a channel was opened", async () => {
    const session = new FakeMppSession([{ status: 200, text: JSON.stringify(FIXTURE.withUsage.body), charge: QUOTE }]);
    const t = transport(session);
    // Nothing opened yet: closing is a no-op rather than a transaction.
    expect(await t.close()).to.deep.equal({});
    expect(session.closes).to.equal(0);

    await t.chat(REQ);
    const settlement = await t.close();
    expect(settlement.txHash).to.be.a("string");
    expect(settlement.spent).to.equal(QUOTE.toString());
    expect(session.closes).to.equal(1);
  });

  it("refuses to call a close that came back with no receipt a settlement", async () => {
    // mppx answers `undefined` to a 2xx close that carries no Payment-Receipt. Handed on as
    // `{ txHash: undefined }`, it would be recorded `closed: true`: the ledger row would go, and a
    // keyed loop's key be revoked, for a close nothing showed had settled.
    class NoReceipt extends FakeMppSession {
      async close(): Promise<MppCloseReceipt> {
        this.closes++;
        return undefined as unknown as MppCloseReceipt;
      }
    }
    const session = new NoReceipt([{ status: 200, text: JSON.stringify(FIXTURE.withUsage.body), charge: QUOTE }]);
    const t = transport(session);
    await t.chat(REQ);
    const thrown = await t.close().then(
      () => null,
      (e) => e
    );
    expect(thrown).to.be.instanceOf(Error);
    expect(String(thrown.message)).to.match(/no receipt, so nothing is known to have settled/);
    expect(String(thrown.message)).to.include(FIXTURE.channelId);
    expect(session.closes).to.equal(1);
  });

  it("sizes the deposit from the step ceiling, so a top-up cannot fall between two steps", async () => {
    // `maxDeposit = maxCost × maxSteps + maxCost`, `topUpAmount = maxCost`, in the human
    // units mppx takes and the base units the vault meters in.
    expect(toHumanUsdc(BigInt(10_000))).to.equal("0.010000");
    expect(toHumanUsdc(BigInt(10_000) * BigInt(5))).to.equal("0.050000");
    expect(toHumanUsdc(BigInt(0))).to.equal("0.000000");
    expect(toHumanUsdc(BigInt(1_500_000))).to.equal("1.500000");
  });

  it("takes EOF after a finish_reason as terminal, but only on the tempo rail", async () => {
    // A gateway that cuts the connection instead of writing its receipt still delivered a whole
    // completion; the vault rail keeps demanding `[DONE]`, which is what a cut stream lacks.
    const noReceipt = FIXTURE.streamed.sse.slice(0, -2).join("");
    const impl = (async () => new Response(stream(noReceipt), { status: 200 })) as unknown as typeof fetch;

    const ok = await chatCore(impl, "https://gateway.invalid", {}, REQ, {
      onToken: () => undefined,
      terminal: "receipt",
    });
    expect(ok.body.choices[0].finish_reason).to.equal("stop");

    const cut = await chatCore(impl, "https://gateway.invalid", {}, REQ, { onToken: () => undefined }).then(
      () => null,
      (e) => e
    );
    expect(cut).to.be.instanceOf(OpenRouterError);
  });
});

/**
 * mppx as it actually behaves on a paid call (read from mppx 0.10.1's source): the voucher
 * is signed — and the manager's `cumulative` advanced — inside `fetch`, before the request goes
 * out, and it is put back only when that request fails before a 2xx. `FakeMppSession` above
 * advances at the end of the body, which is what a *completed* call looks like from outside; this
 * one is what a call that dies after its headers looks like, which is the case the transport has
 * to record rather than drop.
 */
class SigningSession implements MppSession {
  opened = false;
  channelId: string | undefined;
  private total = BigInt(0);
  private readonly plan: { refuse: true } | { status?: number; frames: string[]; end: "eof" | "error"; charge: bigint };

  constructor(plan: SigningSession["plan"]) {
    this.plan = plan;
  }

  get cumulative(): bigint {
    return this.total;
  }

  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    this.opened = true;
    this.channelId = FIXTURE.channelId;
    // A request that never got a 2xx: mppx restores the cumulative, so from outside it never moved.
    if ("refuse" in this.plan) throw new Error("connect ECONNREFUSED");
    const plan = this.plan;
    this.total += plan.charge;
    const signal = init?.signal as AbortSignal | undefined;
    const frames = plan.frames.map((f) => new TextEncoder().encode(f));
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (signal?.aborted) {
          controller.error(new Error("the request was aborted"));
          return;
        }
        if (at < frames.length) {
          controller.enqueue(frames[at++]);
          return;
        }
        if (plan.end === "error") controller.error(new Error("socket hang up"));
        else controller.close();
      },
    });
    return new Response(body, { status: plan.status ?? 200 });
  }

  async close(): Promise<MppCloseReceipt> {
    return { txHash: "0x00", spent: this.total };
  }
}

describe("tempo inference transport, a paid call that fails", () => {
  /** The first content frame and nothing after it: no `finish_reason`, no receipt. */
  const HEAD = FIXTURE.streamed.sse.slice(0, 2);

  async function failure(session: SigningSession, opts: Parameters<MppOpenRouterTransport["chat"]>[1]) {
    const t = transport(session);
    const thrown = await t.chat(REQ, opts).then(
      () => null,
      (e) => e
    );
    return { t, thrown };
  }

  it("raises PaidCallFailed with the voucher bracket when the stream is cut after its headers", async () => {
    const { t, thrown } = await failure(new SigningSession({ frames: HEAD, end: "eof", charge: QUOTE }), {
      onToken: () => undefined,
    });
    expect(PaidCallFailed.is(thrown)).to.equal(true);
    const paid = thrown as PaidCallFailed;
    // Exactly what a successful call's `payment` would have said, minus the `usageCost` a body
    // that never finished could not carry.
    expect(paid.payment).to.deep.equal({
      rail: "tempo",
      chainId: 4217,
      payer: PAYER,
      channelId: FIXTURE.channelId,
      cumulativeBefore: "0",
      cumulativeAfter: QUOTE.toString(),
    });
    // The 200 it streamed under is not the call's outcome, so no status is carried.
    expect(paid.status).to.equal(undefined);
    expect(t.cumulative).to.equal(QUOTE.toString());
  });

  it("raises PaidCallFailed for a body that errors mid-stream, and for a mid-stream error frame", async () => {
    const socket = await failure(new SigningSession({ frames: HEAD, end: "error", charge: QUOTE }), {
      onToken: () => undefined,
    });
    expect(PaidCallFailed.is(socket.thrown)).to.equal(true);
    expect(BigInt((socket.thrown as PaidCallFailed).payment.cumulativeAfter)).to.equal(QUOTE);

    const frame = 'event: message\ndata: {"error":{"message":"provider overloaded"}}\n\n';
    const provider = await failure(new SigningSession({ frames: [...HEAD, frame], end: "eof", charge: QUOTE }), {
      onToken: () => undefined,
    });
    expect(PaidCallFailed.is(provider.thrown)).to.equal(true);
    expect((provider.thrown as Error).message).to.contain("provider overloaded");
  });

  it("carries the status of a failure the gateway answered with and kept the voucher for", async () => {
    const { thrown } = await failure(
      new SigningSession({ status: 502, frames: ["upstream failed"], end: "eof", charge: QUOTE }),
      undefined
    );
    expect(PaidCallFailed.is(thrown)).to.equal(true);
    expect((thrown as PaidCallFailed).status).to.equal(502);
  });

  it("raises PaidCallFailed when the caller aborts mid-body, because the voucher was already signed", async () => {
    const ac = new AbortController();
    const { thrown } = await failure(new SigningSession({ frames: HEAD, end: "eof", charge: QUOTE }), {
      onToken: () => ac.abort(),
      signal: ac.signal,
    });
    expect(PaidCallFailed.is(thrown)).to.equal(true);
    expect((thrown as PaidCallFailed).payment.cumulativeAfter).to.equal(QUOTE.toString());
  });

  it("lets a failure that was never paid for through as it was", async () => {
    // The refused-before-2xx case: nothing moved, so there is nothing to record, and the runtime
    // must see the plain error it always saw (a refused voucher still writes nothing).
    const { t, thrown } = await failure(new SigningSession({ refuse: true }), undefined);
    expect(thrown).to.be.instanceOf(Error);
    expect(PaidCallFailed.is(thrown)).to.equal(false);
    expect(t.cumulative).to.equal("0");
  });
});

describe("tempo decisions transport", () => {
  it("asks for a decision on the loop's own channel and meters its 42-unit voucher", async () => {
    const session = new FakeMppSession([
      { status: 200, text: JSON.stringify(DECISION_BODY), charge: DECISION_QUOTE },
      { status: 200, text: JSON.stringify(FIXTURE.withUsage.body), charge: QUOTE },
    ]);
    const t = transport(session);
    const res = await t.decide(DECIDE);

    // The answers come back as the gateway wrote them: the verdict, its confidence and the dated
    // build are what the step's manifest ends up committing through `verifyHash`.
    expect(res.answers.verdict.choice).to.equal("accept");
    expect(res.answers.verdict.confidence).to.equal(0.91);
    expect(res.answers.followed_plan.noul).to.equal(0.87);
    expect(res.model).to.equal("typesafe/jev-1.13-20260917");
    expect(res.payment).to.deep.equal({
      rail: "tempo",
      chainId: 4217,
      payer: PAYER,
      channelId: FIXTURE.channelId,
      cumulativeBefore: "0",
      cumulativeAfter: DECISION_QUOTE.toString(),
      usageCost: DECISION_BODY.usage.cost,
    });
    // The endpoint is the gateway's proxy, one segment above OpenRouter's own path: the native
    // `/api/alpha/decisions` is a 404 there.
    expect(session.fetches[0].url).to.equal(TEMPO_DECISIONS_URL);
    expect(TEMPO_DECISIONS_URL).to.not.contain("/api/alpha");
    // The request is the probe's body and nothing else — no `stream`, no `usage.include`.
    expect(JSON.parse(String(session.fetches[0].init!.body))).to.deep.equal({
      model: DECIDE.model,
      state: DECIDE.state,
      questions: DECIDE.questions,
    });
    // One attempt. A second would sign a second voucher for a decision already bought.
    expect(session.fetches.length).to.equal(1);

    // The chat call after it rides the same channel, so the loop still holds exactly one and
    // the decision's delta is comparable with the step's.
    const chat = await t.chat(REQ);
    expect(chat.payment!.channelId).to.equal(res.payment!.channelId);
    expect(chat.payment!.cumulativeBefore).to.equal(DECISION_QUOTE.toString());
    expect(chat.payment!.cumulativeAfter).to.equal((DECISION_QUOTE + QUOTE).toString());
    expect(session.fetches.length).to.equal(2);
  });

  it("rejects a non-200 as OpenRouterError, and a paid body that is not JSON as PaidCallFailed", async () => {
    const refused = new FakeMppSession([{ status: 402, text: JSON.stringify(FIXTURE.refused.body) }]);
    const thrown = await transport(refused)
      .decide(DECIDE)
      .then(
        () => null,
        (e) => e
      );
    expect(thrown).to.be.instanceOf(OpenRouterError);
    expect((thrown as OpenRouterError).status).to.equal(402);
    expect(refused.fetches.length).to.equal(1);

    // A 200 carrying a gateway's HTML error page is not an answer, and a caller that treated it
    // as one would commit a `verifyHash` over nothing. The runner reads both as "unavailable".
    // This one was paid for — the voucher moved — so it carries the bracket, with no
    // status: the 200 it came under says nothing about the call.
    const html = new FakeMppSession([{ status: 200, text: "<html>bad gateway</html>", charge: DECISION_QUOTE }]);
    const notJson = await transport(html)
      .decide(DECIDE)
      .then(
        () => null,
        (e) => e
      );
    expect(PaidCallFailed.is(notJson)).to.equal(true);
    expect((notJson as PaidCallFailed).status).to.equal(undefined);
    expect((notJson as PaidCallFailed).payment.cumulativeAfter).to.equal(DECISION_QUOTE.toString());
  });

  it("puts verify in the policy document only when a loop asked for one", () => {
    const base = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };
    // The same pinned digest `tests/runtime.ts` asserts: `verify` is a new optional key, and a
    // policy without it must hash exactly as it did before the key existed, or every loop already
    // on devnet changed policy.
    expect(hex(policyVersionHash(base))).to.equal("86d2d33dc8e74fdcf19a52eebb162c94d219241594f33a95ba81c418856912d0");
    expect(hex(policyVersionHash({ ...base, verify: undefined }))).to.equal(hex(policyVersionHash(base)));

    const verify = { model: "typesafe/jev-1.13", minConfidence: 0.6 };
    expect(hex(policyVersionHash({ ...base, verify }))).to.not.equal(hex(policyVersionHash(base)));
    // Both halves are committed: a different judge and a different bar are different rules.
    expect(hex(policyVersionHash({ ...base, verify }))).to.not.equal(
      hex(policyVersionHash({ ...base, verify: { ...verify, minConfidence: 0.9 } }))
    );
    expect(hex(policyVersionHash({ ...base, verify }))).to.not.equal(
      hex(policyVersionHash({ ...base, verify: { ...verify, model: "typesafe/jev-1.12" } }))
    );
  });

  it("puts the team in the policy document only when a loop has one, and commits its order", () => {
    const base = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };
    // The same vector again from the other side: `workers` is the second new optional key, and a
    // loop without a team still hashes its policy the way every loop on devnet hashed it.
    expect(hex(policyVersionHash({ ...base, workers: undefined }))).to.equal(hex(policyVersionHash(base)));

    const a = "11".repeat(32);
    const b = "22".repeat(32);
    const workers = { agentIds: [a, b], model: "deepseek/deepseek-v4.1-flash", budgetMicroUsdcPerTask: "20000" };
    expect(hex(policyVersionHash({ ...base, workers }))).to.not.equal(hex(policyVersionHash(base)));
    // All three halves are rules: who may be asked, on what model, and for how much each.
    for (const other of [
      { ...workers, agentIds: [a] },
      { ...workers, model: "moonshotai/kimi-k3" },
      { ...workers, budgetMicroUsdcPerTask: "30000" },
      // Order is data, unlike `toolAllowList`: it decides who gets the first task line and where
      // each answer lands in the memory, so a swapped roster is a different roster.
      { ...workers, agentIds: [b, a] },
    ]) {
      expect(hex(policyVersionHash({ ...base, workers: other }))).to.not.equal(
        hex(policyVersionHash({ ...base, workers }))
      );
    }
    // An extra key on the roster object is not a rule and must not move the hash.
    expect(hex(policyVersionHash({ ...base, workers: { ...workers, names: ["a", "b"] } as any }))).to.equal(
      hex(policyVersionHash({ ...base, workers }))
    );
  });

  it("never pays for a decision the deadline has already given up on", async () => {
    // The voucher is signed inside `session.fetch`, before the request goes out, so a deadline
    // that only lost a `Promise.race` would leave 42 base units bought for an answer the runner
    // then threw away — the channel paying out more than the chain's blobs bought.
    const session = new FakeMppSession([{ status: 200, text: JSON.stringify(DECISION_BODY), charge: DECISION_QUOTE }]);
    const t = transport(session);
    const ac = new AbortController();
    ac.abort();

    const thrown = await t.decide(DECIDE, { signal: ac.signal }).then(
      () => null,
      (e) => e
    );
    expect(thrown).to.be.instanceOf(Error);
    // Nothing reached the gateway and no channel was opened: the cheapest possible outcome for a
    // decision nobody is waiting for.
    expect(session.fetches.length).to.equal(0);
    expect(t.opened).to.equal(false);
    expect(t.cumulative).to.equal(undefined);
  });

  it("raises PaidCallFailed for a decision paid for and cut off mid-body, and a plain error for a refusal", async () => {
    const half = JSON.stringify(DECISION_BODY).slice(0, 20);
    const cut = await transport(new SigningSession({ frames: [half], end: "error", charge: DECISION_QUOTE }))
      .decide(DECIDE)
      .then(
        () => null,
        (e) => e
      );
    expect(PaidCallFailed.is(cut)).to.equal(true);
    expect((cut as PaidCallFailed).payment).to.deep.equal({
      rail: "tempo",
      chainId: 4217,
      payer: PAYER,
      channelId: FIXTURE.channelId,
      cumulativeBefore: "0",
      cumulativeAfter: DECISION_QUOTE.toString(),
    });

    const refused = await transport(new SigningSession({ refuse: true }))
      .decide(DECIDE)
      .then(
        () => null,
        (e) => e
      );
    expect(refused).to.be.instanceOf(Error);
    expect(PaidCallFailed.is(refused)).to.equal(false);
  });

  it("hands the deadline's signal to the request, so a late decision is cut off rather than bought", async () => {
    const session = new FakeMppSession([{ status: 200, text: JSON.stringify(DECISION_BODY), charge: DECISION_QUOTE }]);
    const ac = new AbortController();
    // The runner's 20 s timer fires once the headers are in: the request's signal follows it (with
    // the transport's own deadline beside it), so `fetch` abandons the body instead of it arriving
    // at 21 s against a voucher already signed for it.
    const fetchOnce = session.fetch.bind(session);
    session.fetch = async (url: string, init?: RequestInit) => {
      const r = await fetchOnce(url, init);
      ac.abort(new Error("late"));
      return r;
    };
    const thrown = await transport(session)
      .decide(DECIDE, { signal: ac.signal })
      .then(
        () => null,
        (e) => e
      );
    expect(thrown).to.be.instanceOf(Error);
    expect((session.fetches[0].init!.signal as AbortSignal).aborted).to.equal(true);
  });
});

/**
 * One channel, and a probe of how many requests are on it at once. `fetch` holds its slot for the
 * whole round trip and advances the cumulative at the end of it, which is where the gateway's
 * receipt advances a real one.
 */
class ConcurrencyProbeSession implements MppSession {
  opened = false;
  channelId: string | undefined;
  /** The highest number of requests that were in flight together. Serialized means 1. */
  maxInFlight = 0;
  private inFlight = 0;
  private total = BigInt(0);
  private readonly body: string;
  private readonly quote: bigint;
  private readonly latencyMs: number;

  constructor(body: string, quote: bigint, latencyMs = 5) {
    this.body = body;
    this.quote = quote;
    this.latencyMs = latencyMs;
  }

  get cumulative(): bigint {
    return this.total;
  }

  async fetch(_url: string, _init?: RequestInit): Promise<Response> {
    this.opened = true;
    this.channelId = FIXTURE.channelId;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    // One cumulative per request, signed by the one payer against the one channel: this is the
    // counter two concurrent callers would race.
    this.total += this.quote;
    this.inFlight--;
    return new Response(this.body, { status: 200 });
  }

  async close(): Promise<MppCloseReceipt> {
    return { txHash: "0x00", spent: this.total };
  }
}

describe("tempo transport, one channel under a team", () => {
  it("serializes concurrent chat calls, so three members' vouchers do not race one cumulative", async () => {
    // A team's members share the loop's channel and run in
    // parallel, so this is the ordinary case and not an exotic one. Without the queue all three
    // would read `cumulativeBefore: "0"` and each commit the other two's price as its own.
    const session = new ConcurrencyProbeSession(JSON.stringify(FIXTURE.withUsage.body), QUOTE);
    const t = new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      sessionFactory: async () => session,
    });

    const results = await Promise.all([t.chat(REQ), t.chat(REQ), t.chat(REQ)]);

    expect(session.maxInFlight).to.equal(1, "one request on the channel at a time");
    // Disjoint and monotonic: each call's delta is its own quote and the three tile the total.
    expect(results.map((r) => [r.payment!.cumulativeBefore, r.payment!.cumulativeAfter])).to.deep.equal([
      ["0", QUOTE.toString()],
      [QUOTE.toString(), (QUOTE * BigInt(2)).toString()],
      [(QUOTE * BigInt(2)).toString(), (QUOTE * BigInt(3)).toString()],
    ]);
    expect(t.cumulative).to.equal((QUOTE * BigInt(3)).toString());
  });

  it("lets a call that threw be followed by one that works", async () => {
    // The queue is an ordering, not a fate shared between callers: a member whose voucher is
    // refused fails that one task, and the next member's call still goes out.
    const session = new FakeMppSession([
      { status: 402, text: JSON.stringify(FIXTURE.refused.body) },
      { status: 200, text: JSON.stringify(FIXTURE.withUsage.body), charge: QUOTE },
    ]);
    const t = transport(session);

    const [first, second] = await Promise.all([
      t.chat(REQ).then(
        () => null,
        (e) => e
      ),
      t.chat(REQ).then(
        (r) => r,
        () => null
      ),
    ]);
    expect(first).to.be.instanceOf(OpenRouterError);
    expect(second).to.not.equal(null);
    // The refusal advanced nothing, so the second call is still the channel's first payment.
    expect((second as Awaited<ReturnType<typeof t.chat>>).payment!.cumulativeBefore).to.equal("0");
    expect(session.fetches.length).to.equal(2);
  });
});

/**
 * A gateway whose first request never settles — not even when aborted, the way a request mppx
 * makes on its own (a top-up, a voucher retry) never hears the caller's signal — and whose later
 * requests answer. The failure it stands for: one hung call holding the channel's queue for good.
 */
class HangsOnceSession implements MppSession {
  opened = false;
  channelId: string | undefined;
  fetches = 0;
  private total = BigInt(0);
  private readonly text: string;
  private readonly charge: bigint;
  constructor(text: string, charge: bigint) {
    this.text = text;
    this.charge = charge;
  }
  get cumulative(): bigint {
    return this.total;
  }
  async fetch(): Promise<Response> {
    this.opened = true;
    this.channelId = FIXTURE.channelId;
    if (this.fetches++ === 0) return new Promise<Response>(() => undefined);
    this.total += this.charge;
    return new Response(this.text, { status: 200 });
  }
  async close(): Promise<MppCloseReceipt> {
    return { spent: this.total };
  }
}

describe("tempo transport, a call that never settles", () => {
  it("gives up on it at the deadline and frees the queue for the next call, chat and decision alike", async () => {
    const lines: string[] = [];
    const t = new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      callDeadlineMs: 150,
      abortGraceMs: 50,
      log: (l) => lines.push(l),
      sessionFactory: async () => new HangsOnceSession(JSON.stringify(FIXTURE.withUsage.body), QUOTE),
    });

    const [hung, next] = await Promise.all([
      t.chat(REQ).then(
        () => null,
        (e: Error) => e
      ),
      t.chat(REQ),
    ]);
    expect(hung?.message).to.equal("the gateway did not answer the model call in 0.15 s");
    // Nothing was vouchered for the hung call, so the next one is still the channel's first payment.
    expect(next.payment!.cumulativeBefore).to.equal("0");
    expect(next.payment!.cumulativeAfter).to.equal(QUOTE.toString());
    // Still inside mppx once the grace ran out, so the transport could not say what it cost and
    // took the unpaid reading; the log says so, for the operator reconciling the treasury.
    expect(lines[0]).to.match(
      /^tempo chat: 0\.\d s, still inside mppx 0\.05 s after it was abandoned, recorded as unpaid: the gateway did not answer/
    );
    expect(lines[1]).to.match(/^tempo chat: \d+\.\d s, \+\d+ base units, ok$/);
  });

  it("gives a decision with no caller deadline the transport's own", async () => {
    const t = new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      callDeadlineMs: 150,
      abortGraceMs: 50,
      sessionFactory: async () => new HangsOnceSession(JSON.stringify(DECISION_BODY), DECISION_QUOTE),
    });
    const err = await t.decide(DECIDE).then(
      () => null,
      (e: Error) => e
    );
    expect(err?.message).to.equal("the gateway did not answer the decision in 0.15 s");
    const ok = await t.decide(DECIDE);
    expect(ok.payment!.cumulativeAfter).to.equal(DECISION_QUOTE.toString());
  });
});

/** One gateway round trip for `RollbackSession`: when its headers come, and when its body does. */
interface RoundTrip {
  /** Headers after this many ms; `"stuck"` is an mppx that never hears the abort (a top-up of its own). */
  headers: number | "stuck";
  /** The body after this many more ms, a stream the abort cuts. */
  bodyAfter?: number;
  text: string;
  charge: bigint;
}

/**
 * mppx's `doFetch` on the timing that matters (mppx 0.10.1
 * `SessionManager.js` `doFetch`, `restoreRuntime`, `Fetch.js` `from`): the voucher is signed —
 * `cumulative` advanced — before the request goes out, and a request that fails before a 2xx has it
 * put back in `doFetch`'s catch, which runs only after the fetch's rejection has come up through
 * mppx's own wrappers, a few turns of the event loop after the abort. One request at a time, as
 * mppx's in-flight guard enforces: a second fetch while one is out throws before signing anything.
 *
 * `SigningSession` signs and never rolls back, and `HangsOnceSession` never signs the hung call, so
 * neither could see a counter read that lands between the abort and the rollback.
 */
class RollbackSession implements MppSession {
  opened = false;
  channelId: string | undefined;
  fetches = 0;
  /** Called when a fetch meets the in-flight guard, before it throws; a test uses it to move time. */
  onOverlap?: () => void;
  private total = BigInt(0);
  private inFlight = false;
  private release: ((ok: boolean) => void) | undefined;

  private readonly trips: RoundTrip[];

  constructor(trips: RoundTrip[]) {
    this.trips = trips;
  }

  get cumulative(): bigint {
    return this.total;
  }

  /** Signs the stuck call's voucher late, the way an mppx held in a top-up signs once it returns. */
  signStuck(charge: bigint): void {
    this.total += charge;
  }

  /** Lets the stuck call out: with its 2xx (`true`), or failed before one and rolled back. */
  settleStuck(ok: boolean): void {
    this.release?.(ok);
  }

  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    if (this.inFlight) {
      this.onOverlap?.();
      throw new Error("SessionManager: a request is already in flight");
    }
    const trip = this.trips[Math.min(this.fetches++, this.trips.length - 1)];
    this.inFlight = true;
    this.opened = true;
    this.channelId = FIXTURE.channelId;
    const previous = this.total;
    if (trip.headers !== "stuck") this.total += trip.charge;
    const signal = init?.signal as AbortSignal | undefined;
    try {
      if (trip.headers === "stuck") {
        const ok = await new Promise<boolean>((resolve) => (this.release = resolve));
        if (!ok) throw new Error("the top-up failed");
      } else {
        await waitOrAbort(trip.headers, signal);
      }
    } catch (e) {
      // `Fetch.from`, the transport wrapper around it and `doFetch`'s own catch, in that order.
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      this.total = previous;
      this.inFlight = false;
      throw e;
    }
    this.inFlight = false;
    const bytes = new TextEncoder().encode(trip.text);
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (sent) return controller.close();
        try {
          await waitOrAbort(trip.bodyAfter ?? 0, signal);
        } catch (e) {
          return controller.error(e);
        }
        sent = true;
        controller.enqueue(bytes);
      },
    });
    return new Response(body, { status: 200 });
  }

  async close(): Promise<MppCloseReceipt> {
    return { spent: this.total };
  }
}

/** `ms` of network, or a rejection the moment `signal` aborts — what a real fetch does. */
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

describe("tempo transport, an abort before the headers", () => {
  const CHAT_TEXT = JSON.stringify(FIXTURE.withUsage.body);
  const DECISION_TEXT = JSON.stringify(DECISION_BODY);

  function rollbackTransport(session: RollbackSession, lines: string[] = []): MppOpenRouterTransport {
    return new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      callDeadlineMs: 60,
      abortGraceMs: 200,
      log: (l) => lines.push(l),
      sessionFactory: async () => session,
    });
  }

  const caught = <T>(p: Promise<T>) =>
    p.then(
      () => null,
      (e: unknown) => e as Error
    );

  it("records nothing for a model call its deadline cut before the headers, and the next call opens at 0", async () => {
    // The whole model latency of a non-streamed call sits before its headers: a loop step past
    // 110 s must not be charged a voucher mppx then rolled back, or the next call brackets it again.
    const session = new RollbackSession([
      { headers: 5_000, text: CHAT_TEXT, charge: QUOTE },
      { headers: 0, text: CHAT_TEXT, charge: QUOTE },
    ]);
    const lines: string[] = [];
    const t = rollbackTransport(session, lines);

    const cut = await caught(t.chat(REQ));
    expect(cut?.message).to.equal("the gateway did not answer the model call in 0.06 s");
    expect(PaidCallFailed.is(cut)).to.equal(false);
    expect(t.cumulative).to.equal("0");
    expect(lines[0]).to.match(/^tempo chat: 0\.\d s, \+0 base units, failed: the gateway did not answer/);

    const next = await t.chat(REQ);
    expect(next.payment).to.include({ cumulativeBefore: "0", cumulativeAfter: QUOTE.toString() });
  });

  it("records nothing for a model call the caller aborted before the headers", async () => {
    const session = new RollbackSession([{ headers: 5_000, text: CHAT_TEXT, charge: QUOTE }]);
    const t = new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      abortGraceMs: 200,
      sessionFactory: async () => session,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("the sandbox closed the request")), 30);
    const cut = await caught(t.chat(REQ, { signal: ac.signal }));
    expect(cut?.message).to.equal("the sandbox closed the request");
    expect(PaidCallFailed.is(cut)).to.equal(false);
    expect(t.cumulative).to.equal("0");
  });

  it("records nothing for a decision cut before the headers, by the transport's deadline or the runner's", async () => {
    const own = rollbackTransport(
      new RollbackSession([
        { headers: 5_000, text: DECISION_TEXT, charge: DECISION_QUOTE },
        { headers: 0, text: DECISION_TEXT, charge: DECISION_QUOTE },
      ])
    );
    const cut = await caught(own.decide(DECIDE));
    expect(cut?.message).to.equal("the gateway did not answer the decision in 0.06 s");
    expect(PaidCallFailed.is(cut)).to.equal(false);
    const next = await own.decide(DECIDE);
    expect(next.payment).to.include({ cumulativeBefore: "0", cumulativeAfter: DECISION_QUOTE.toString() });

    // `decideWithin`, as Jev's verify, goal check and gate ask call it: its grace hears the
    // transport's unpaid answer, so the gate adds nothing to `costBase` and no blob is stored.
    const runner = new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      sessionFactory: async () =>
        new RollbackSession([{ headers: 5_000, text: DECISION_TEXT, charge: DECISION_QUOTE }]),
    });
    const timedOut = await caught(decideWithin(runner, DECIDE, 30));
    expect(timedOut?.message).to.equal("the decision did not come back in 30 ms");
    expect(PaidCallFailed.is(timedOut)).to.equal(false);
    expect(runner.cumulative).to.equal("0");
  });

  it("still records the voucher of a call cut after a real 2xx, chat and decision alike", async () => {
    // Headers at once, the body later than the deadline: mppx's request is over and the voucher is
    // the gateway's, so the counter is read at once and the bracket is owed.
    const chat = rollbackTransport(
      new RollbackSession([{ headers: 0, bodyAfter: 5_000, text: CHAT_TEXT, charge: QUOTE }])
    );
    const cutChat = await caught(chat.chat(REQ));
    expect(PaidCallFailed.is(cutChat)).to.equal(true);
    expect((cutChat as PaidCallFailed).payment).to.include({
      cumulativeBefore: "0",
      cumulativeAfter: QUOTE.toString(),
    });

    const decide = rollbackTransport(
      new RollbackSession([{ headers: 0, bodyAfter: 5_000, text: DECISION_TEXT, charge: DECISION_QUOTE }])
    );
    const cutDecision = await caught(decide.decide(DECIDE));
    expect(PaidCallFailed.is(cutDecision)).to.equal(true);
    expect((cutDecision as PaidCallFailed).payment.cumulativeAfter).to.equal(DECISION_QUOTE.toString());
  });

  it("reads a call still inside mppx after the grace as unpaid, and never pins its voucher on a later call", async () => {
    const session = new RollbackSession([
      { headers: "stuck", text: CHAT_TEXT, charge: QUOTE },
      { headers: 0, text: CHAT_TEXT, charge: QUOTE },
    ]);
    const lines: string[] = [];
    const t = rollbackTransport(session, lines);

    const stuck = await caught(t.chat(REQ));
    expect(PaidCallFailed.is(stuck)).to.equal(false);
    expect(lines[0]).to.match(/still inside mppx 0\.2 s after it was abandoned, recorded as unpaid/);

    // The stuck call signs while a later one is refused by mppx's in-flight guard: the counter
    // moves under the later call's bracket, but the voucher is not the later call's to record.
    session.onOverlap = () => session.signStuck(QUOTE);
    const refused = await caught(t.chat(REQ));
    expect(refused?.message).to.contain("already in flight");
    expect(PaidCallFailed.is(refused)).to.equal(false);

    // When it does come out paid, the log names the voucher no record carries.
    session.settleStuck(true);
    await new Promise((r) => setImmediate(r));
    expect(lines[lines.length - 1]).to.match(
      /came out of mppx, \+750 base units vouchered that no record names — the treasury carries them$/
    );
  });
});

// ─── The loop's access key in the policy and on every record ────────────────────────────────

/**
 * One policy of every shape a Genesis on devnet commits — a chat run, an `AgentConfig`, a template
 * and a market launch on each rail, a goal loop with the decision seats and the trace audit, a team,
 * a gated loop with every watch kind, a sandboxed step — each with its digest as the document
 * builder computes it for a policy with no `tempoKey`. A key added to the document
 * builder that leaked into a policy without a key would move one of these, and with it the
 * `policy_version_hash` of every chain of that shape: the audit would read them as new rules.
 */
const JEV = "typesafe/jev-1.13";
const POLICY_FIXTURES: Record<string, { policy: any; hash: string }> = {
  chatRun: {
    policy: { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 },
    hash: "86d2d33dc8e74fdcf19a52eebb162c94d219241594f33a95ba81c418856912d0",
  },
  agentConfig: {
    policy: { model: "openai/gpt-4o-mini", tools: ["web.fetch", "lath.verify_chain"], maxCost: 2_000_000 },
    hash: "01977cdbc49acaed8f8f5b906bb73a5298dea84f61056fba7053c11dc2069718",
  },
  template: {
    policy: {
      model: "deepseek/deepseek-v4.1-flash",
      temperature: 0.2,
      toolAllowList: ["web.fetch", "solana.account"],
      maxCost: 25_000_000,
      promptHash: "6182417bbd101bec13338e572f204411f74df1b363590ffb0bd25be3541b4858",
      payment: "vault",
    },
    hash: "fa379bde583ff20a4993b3629f3d6be73384d97a7237a7c0bd8c2659004bda18",
  },
  marketTempo: {
    policy: {
      model: "deepseek/deepseek-v4.1-flash",
      temperature: 0.2,
      toolAllowList: ["web.fetch"],
      maxCost: 10_000_000,
      promptHash: "6182417bbd101bec13338e572f204411f74df1b363590ffb0bd25be3541b4858",
      payment: "tempo",
    },
    hash: "b325a33e5e1e9f1c0c1a34ad91460aa00c3422f2aba76ce743a0d57004af3fef",
  },
  goalLoop: {
    policy: {
      model: "anthropic/claude-sonnet-5",
      temperature: 0.2,
      toolAllowList: ["a", "b"],
      maxCost: 5_000_000,
      payment: "tempo",
      verify: { model: JEV, minConfidence: 0.6 },
      goalCheck: { model: JEV, minConfidence: 0.5 },
      // Span-01, a reader older policies commit: a policy that committed it must keep this hash.
      traceAudit: {
        model: "respan/span-01",
        behaviours: {
          injection_followed: { bar: 0.5, onPresent: "stop" },
          stuck_loop: { bar: 0.5, onPresent: "flag" },
        },
      },
    },
    hash: "44337635ede50d18e9c0603e607e92ddeaf948ee6a7a62eb702bf8d0a76ffb1c",
  },
  teamLoop: {
    policy: {
      model: "anthropic/claude-sonnet-5",
      temperature: 0.2,
      toolAllowList: ["lath.delegate"],
      maxCost: 8_000_000,
      workers: {
        agentIds: ["11".repeat(32), "22".repeat(32)],
        model: "deepseek/deepseek-v4.1-flash",
        budgetMicroUsdcPerTask: "20000",
        slots: [
          { name: "reader", model: "moonshotai/kimi-k3", policyHash: "33".repeat(32) },
          { model: "deepseek/deepseek-v4.1-flash" },
        ],
        synthesize: true,
      },
    },
    hash: "09f5ea3ce2e1d6bf72e063ecae3563f54c63255d24cb3dbee96b7e78cac674d2",
  },
  gatedLoop: {
    policy: {
      model: "anthropic/claude-sonnet-5",
      temperature: 0.2,
      toolAllowList: ["a"],
      maxCost: 3_000_000,
      gate: {
        model: JEV,
        barBps: 6000,
        watch: [
          { kind: "store", keys: ["prices", "news"] },
          { kind: "agent", agentId: "11".repeat(32), label: "scout", routineCalls: 2 },
          { kind: "solana", address: "So11111111111111111111111111111111111111112", label: "wsol" },
          {
            kind: "pyth",
            feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
            label: "SOL/USD",
            minMoveBps: 50,
          },
        ],
        failMode: "closed",
        heartbeatMs: 3_600_000,
      },
    },
    hash: "93c9054437e82afc46e28bc205b86e8c644ad6988ce0c5104c6a026be55c526e",
  },
  sandboxStep: {
    policy: {
      model: "anthropic/claude-sonnet-5",
      temperature: 0.2,
      toolAllowList: ["a", "b"],
      maxCost: 5_000_000,
      payment: "tempo",
      sandbox: {
        version: 1,
        risk: "medium",
        tools: ["file_read", "shell"],
        wrapper: ["sandbox-exec", "-p"],
        binarySha256: "44".repeat(32),
      },
    },
    hash: "945f7539418e0be7c6c9e175cf8bcd1c4227ae193cecedcaf66998eb9da17395",
  },
};

/** A loop key rooted on `PAYER`, as `Account.fromSecp256k1(pk, { access: root }).accessKeyAddress` reports it: checksummed. */
const KEY = "0x6B1aE0a6f2C9e4D3b5A7c8E9f0a1B2c3D4e5F607";
const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
const AUTHORIZE_TX = "0x" + "ab".repeat(32);

/** The terms as the console commits them: lower-case hex, a decimal limit, Unix seconds. */
const TEMPO_KEY = {
  address: KEY.toLowerCase(),
  token: USDC_E,
  limitBase: "5750000",
  expiry: 1_767_225_600,
  authorizeTx: AUTHORIZE_TX,
};

/**
 * `sha256(policyDocument({ ...chatRun, tempoKey: TEMPO_KEY }))`, pinned: what a keyed loop's
 * Genesis and the audit must both reproduce from the same terms.
 */
const TEMPO_KEY_POLICY_VECTOR = "fe2e7269cf87e84dc9fdca1260f7a1e8f453fe3cf324bf85c8a74fafa4b63bbb";

describe("the loop's Tempo access key in the policy", () => {
  const base = POLICY_FIXTURES.chatRun.policy as RuntimePolicy;

  it("hashes every existing policy shape exactly as the contract commit did", () => {
    for (const [name, { policy, hash }] of Object.entries(POLICY_FIXTURES)) {
      expect(hex(policyVersionHash(policy)), name).to.equal(hash);
      // An explicit `undefined` is the switch off, and is the same policy as no key at all.
      expect(hex(policyVersionHash({ ...policy, tempoKey: undefined })), `${name}, tempoKey undefined`).to.equal(hash);
      expect(policyDocument(policy), name).to.not.include("tempoKey");
      // Spread, not set: the normalised object has no `tempoKey` key for a caller that compares or
      // serialises it without dropping `undefined`.
      expect("tempoKey" in toRuntimePolicy(policy), name).to.equal(false);
    }
  });

  it("commits the key as exactly five normalised members", () => {
    const on: RuntimePolicy = { ...base, tempoKey: TEMPO_KEY };
    expect(policyDocument(on)).to.include(
      `"tempoKey":{"address":"${KEY.toLowerCase()}","authorizeTx":"${AUTHORIZE_TX}",` +
        `"expiry":1767225600,"limitBase":"5750000","token":"${USDC_E}"}`
    );
    expect(hex(policyVersionHash(on))).to.equal(TEMPO_KEY_POLICY_VECTOR);
    expect(toRuntimePolicy(on).tempoKey).to.deep.equal(TEMPO_KEY);
  });

  it("hashes two writers of the same terms alike: key order, case, number types and extras", () => {
    const on = hex(policyVersionHash({ ...base, tempoKey: TEMPO_KEY }));
    const otherWriter = {
      // Another key order, a checksummed address and token, an upper-case hash, a numeric limit,
      // a string expiry and the file path a careless caller left on the row: one policy.
      authorizeTx: "0x" + "AB".repeat(32),
      expiry: "1767225600",
      limitBase: 5_750_000,
      token: "0x20C000000000000000000000B9537D11C60E8B50",
      address: KEY,
      file: "/Users/someone/.lath/tempo-keys/loop-1.json",
      loopId: "loop-1",
    };
    expect(hex(policyVersionHash({ ...base, tempoKey: otherWriter as any }))).to.equal(on);
    expect(policyDocument({ ...base, tempoKey: otherWriter as any })).to.not.include("tempo-keys");
    // A bigint limit, as viem hands one back.
    const bigLimit = { ...TEMPO_KEY, limitBase: BigInt(5_750_000) as any };
    expect(hex(policyVersionHash({ ...base, tempoKey: bigLimit }))).to.equal(on);
  });

  it("moves the hash for any change of terms, and the key moves it from no key", () => {
    const on = hex(policyVersionHash({ ...base, tempoKey: TEMPO_KEY }));
    expect(on).to.not.equal(POLICY_FIXTURES.chatRun.hash);
    for (const other of [
      { ...TEMPO_KEY, address: "0x" + "77".repeat(20) },
      { ...TEMPO_KEY, token: "0x" + "88".repeat(20) },
      { ...TEMPO_KEY, limitBase: "5750001" },
      { ...TEMPO_KEY, expiry: TEMPO_KEY.expiry + 1 },
      { ...TEMPO_KEY, authorizeTx: "0x" + "cd".repeat(32) },
    ]) {
      expect(hex(policyVersionHash({ ...base, tempoKey: other }))).to.not.equal(on);
    }
  });
});

/** A session that hands back the open's receipt the way mppx's `PaymentResponse` does: `receipt.txHash` on the first answer only. */
class OpeningSession extends FakeMppSession {
  readonly openTx = "0x" + "0e".repeat(32);

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const first = this.fetches.length === 0;
    const res = await super.fetch(url, init);
    return Object.assign(res, {
      receipt: { channelId: FIXTURE.channelId, spent: "0", ...(first ? { txHash: this.openTx } : {}) },
    });
  }
}

/** The channel as mppx stores it when a key opened it on the root's behalf (`ChannelOps.js:28`). */
const ENTRY: MppChannelEntry = {
  channelId: FIXTURE.channelId,
  cumulativeAmount: BigInt(0),
  deposit: BigInt(50_000),
  descriptor: {
    payer: PAYER,
    payee: "0x5707000000000000000000000000000000000000",
    operator: "0x0000000000000000000000000000000000000000",
    token: USDC_E,
    salt: "0x" + "01".repeat(32),
    authorizedSigner: KEY,
    expiringNonceHash: "0x" + "02".repeat(32),
  },
  escrow: "0x4d50500000000000000000000000000000000000",
  chainId: 4217,
  opened: true,
};

function keyed(
  session: MppSession,
  o: {
    accessKeyAddress?: string;
    reader?: (tx: string, id: string, escrow?: string) => Promise<string | undefined>;
  } = {},
  onChannel?: (r: MppChannelRecovery) => void
): MppOpenRouterTransport {
  return new MppOpenRouterTransport({
    account: { address: PAYER, ...(o.accessKeyAddress ? { accessKeyAddress: o.accessKeyAddress } : {}) },
    maxCostBase: BigInt(10_000),
    maxSteps: 4,
    sessionFactory: async (f) => {
      f.onChannelUpdate?.(ENTRY);
      return session;
    },
    openBlockReader: o.reader,
    onChannel,
  });
}

const twoCalls = (): Plan[] => [
  { status: 200, text: JSON.stringify(FIXTURE.withUsage.body), charge: QUOTE },
  { status: 200, text: JSON.stringify(DECISION_BODY), charge: DECISION_QUOTE },
];

describe("the loop's Tempo access key on every record", () => {
  it("names the key as signer and the root as payer on a key account's chat and decide records", async () => {
    const t = keyed(new FakeMppSession(twoCalls()), { accessKeyAddress: KEY });
    const chat = await t.chat(REQ);
    expect(chat.payment!.payer).to.equal(PAYER);
    expect(chat.payment!.signer).to.equal(KEY);
    expect(t.payer).to.equal(PAYER, "the treasury stays the payer the audit's one-switch rule reads");
    const decision = await t.decide(DECIDE);
    expect(decision.payment!.payer).to.equal(PAYER);
    expect(decision.payment!.signer).to.equal(KEY);
  });

  it("writes no signer key at all on a treasury account's records", async () => {
    const t = keyed(new FakeMppSession(twoCalls()));
    const chat = await t.chat(REQ);
    const decision = await t.decide(DECIDE);
    for (const p of [chat.payment!, decision.payment!]) {
      expect("signer" in p).to.equal(false);
      expect("openBlock" in p).to.equal(false);
      expect(JSON.stringify(p)).to.not.include("signer");
    }
    expect(Object.keys(t.recovery!)).to.not.include("openBlock");
  });

  it("names the key on a paid call's failure bracket too", async () => {
    const t = keyed(new SigningSession({ frames: FIXTURE.streamed.sse.slice(0, 2), end: "eof", charge: QUOTE }), {
      accessKeyAddress: KEY,
    });
    const thrown = await t.chat(REQ, { onToken: () => undefined }).then(
      () => null,
      (e) => e
    );
    expect(PaidCallFailed.is(thrown)).to.equal(true);
    expect((thrown as PaidCallFailed).payment.signer).to.equal(KEY);
    expect((thrown as PaidCallFailed).payment.payer).to.equal(PAYER);
  });

  it("learns the open block off the open's receipt without waiting on it, and carries it from then on", async () => {
    const asked: { tx: string; id: string; escrow?: string }[] = [];
    let answer!: (block: string | undefined) => void;
    const reader = (tx: string, id: string, escrow?: string) => {
      asked.push({ tx, id, escrow });
      return new Promise<string | undefined>((resolve) => (answer = resolve));
    };
    const recoveries: MppChannelRecovery[] = [];
    const session = new OpeningSession(twoCalls());
    const t = keyed(session, { accessKeyAddress: KEY, reader }, (r) => recoveries.push(r));

    // The read is still pending when the first call returns: the paid call did not wait on it, and
    // its record goes without the block rather than with a guess.
    const first = await t.chat(REQ);
    expect(asked).to.deep.equal([{ tx: session.openTx, id: FIXTURE.channelId.toLowerCase(), escrow: ENTRY.escrow }]);
    expect("openBlock" in first.payment!).to.equal(false);
    expect("openBlock" in t.recovery!).to.equal(false);

    answer("4321987");
    await new Promise((r) => setImmediate(r));
    // The ledger row hears it at once (the ledger copies it onto `OpenChannelRow.openBlock`)…
    expect(recoveries[recoveries.length - 1].openBlock).to.equal("4321987");
    expect(t.recovery!.openBlock).to.equal("4321987");
    // …and every record of the channel from then on carries it. Asked once: the second answer has
    // no hash, and a known channel is never asked again.
    const second = await t.decide(DECIDE);
    expect(second.payment!.openBlock).to.equal("4321987");
    expect(second.payment!.signer).to.equal(KEY);
    expect(asked).to.have.length(1);
  });

  it("never reads an open block for a treasury channel, so its records and row stay as they were", async () => {
    // The session reports the open's hash and the reader would answer: with the switch off every
    // record and ledger row must still be byte-identical to one written without keys.
    let asked = 0;
    const recoveries: MppChannelRecovery[] = [];
    const t = keyed(
      new OpeningSession(twoCalls()),
      {
        reader: async () => {
          asked++;
          return "1";
        },
      },
      (r) => recoveries.push(r)
    );
    const first = await t.chat(REQ);
    await new Promise((r) => setImmediate(r));
    const second = await t.decide(DECIDE);
    expect(asked).to.equal(0);
    for (const p of [first.payment!, second.payment!]) {
      expect("openBlock" in p).to.equal(false);
      expect("signer" in p).to.equal(false);
    }
    expect(recoveries.length).to.be.greaterThan(0);
    for (const r of [...recoveries, t.recovery!]) expect("openBlock" in r).to.equal(false);
  });

  it("leaves the block absent when the read fails, and the call still succeeds", async () => {
    const lines: string[] = [];
    const t = new MppOpenRouterTransport({
      account: { address: PAYER, accessKeyAddress: KEY },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      sessionFactory: async () => new OpeningSession(twoCalls()),
      openBlockReader: async () => {
        throw new Error("rpc.tempo.xyz is down");
      },
      log: (l) => lines.push(l),
    });
    const first = await t.chat(REQ);
    await new Promise((r) => setImmediate(r));
    const second = await t.decide(DECIDE);
    expect(first.payment!.signer).to.equal(KEY);
    expect("openBlock" in second.payment!).to.equal(false);
    expect(lines.some((l) => /open block .* was not read/.test(l))).to.equal(true);
  });

  it("takes a block only from a receipt that logged this channel's ChannelOpened", () => {
    const id = FIXTURE.channelId;
    const escrow = ENTRY.escrow;
    const opened = { address: escrow, topics: [CHANNEL_OPENED_TOPIC, id.toUpperCase().replace("0X", "0x")] };
    const ok = { status: "0x1", blockNumber: "0x41f2a3", logs: [opened] };
    expect(openBlockOf(ok, id, escrow)).to.equal(String(0x41f2a3));
    expect(openBlockOf(ok, id)).to.equal(String(0x41f2a3));
    // A top-up's transaction logs `TopUp`, not an open; another channel's open is not this one's;
    // a log from another contract is not the escrow's; a reverted transaction opened nothing.
    const topUp = { ...ok, logs: [{ ...opened, topics: ["0x" + "99".repeat(32), id] }] };
    const another = { ...ok, logs: [{ ...opened, topics: [CHANNEL_OPENED_TOPIC, "0x" + "55".repeat(32)] }] };
    const elsewhere = { ...ok, logs: [{ ...opened, address: "0x" + "66".repeat(20) }] };
    expect(openBlockOf(topUp, id)).to.equal(undefined);
    expect(openBlockOf(another, id)).to.equal(undefined);
    expect(openBlockOf(elsewhere, id, escrow)).to.equal(undefined);
    expect(openBlockOf({ ...ok, status: "0x0" }, id)).to.equal(undefined);
    expect(openBlockOf(null, id)).to.equal(undefined);
  });
});

/** Bytes in chunks that fall mid-line, the way a network delivers them. */
function stream(text: string, every = 17): ReadableStream<Uint8Array> {
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

describe("the one-shot Resolution's settlement names its channel", () => {
  /** One answer and done: what the Resolution carries is the point, not the call. */
  const answering: ChatTransport = {
    async chat(_req: ChatRequest): Promise<ChatResult> {
      return {
        status: 200,
        body: {
          id: "gen-1",
          model: "test/model",
          choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        } as ChatResponse,
      };
    },
  };
  const CHANNEL = `0x${"5a".repeat(32)}`;
  const TX = `0x${"c1".repeat(32)}`;

  async function resolve(tempo: TempoChannel) {
    const chain = new FakeChain();
    const agentId = idFromString("tempo-resolution-agent");
    await chain.registerAgent(agentId);
    const store = new MemoryTraceStore();
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId,
      transport: answering,
      store,
      billing: new NoopBilling(),
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 5_000_000 },
      tempo,
    });
    const result = await runtime.start({
      user: new PublicKey("11111111111111111111111111111112"),
      prompt: "go",
      sessionId: "s1",
    });
    const blob = await store.get(result.outputHash);
    expect(blob, "the Resolution's output blob is in the store").to.not.be.null;
    return { result, output: JSON.parse(Buffer.from(blob!).toString("utf8")), settlement: settlementFromBlob(blob!) };
  }

  it("writes channelId beside txHash and spent when the close landed", async () => {
    const { result, output, settlement } = await resolve({
      payer: "0x0000000000000000000000000000000000000001",
      channelId: CHANNEL,
      opened: true,
      close: async () => ({ txHash: TX, spent: "750" }),
    });
    expect(result.status).to.equal("success");
    expect(output.settlement).to.deep.equal({ txHash: TX, spent: "750", channelId: CHANNEL });
    // What the verifier reads back: the channel this settlement is for, so a walk past another
    // session's Resolution can tell it is not its own.
    expect(settlement).to.deep.equal({ txHash: TX, spent: "750", channelId: CHANNEL });
  });

  it("writes no settlement at all when the close did not land, as before", async () => {
    const { output, settlement } = await resolve({
      payer: "0x0000000000000000000000000000000000000001",
      channelId: CHANNEL,
      opened: true,
      close: async () => {
        throw new Error("the escrow is unreachable");
      },
    });
    expect(output).to.not.have.property("settlement");
    expect(settlement).to.be.null;
  });
});

// ─── A chat attempt's deadlines: the first-data window and the caller's deadline ────────────────

/**
 * A gateway that answers 2xx at once — the voucher is kept — and then writes its SSE frames on a
 * schedule, each `afterMs` after the one before; an abort errors the body the way a real fetch does.
 * Nothing past the comments is the stall it stands for: headers, keep-alives, and no answer.
 */
class DripSession implements MppSession {
  opened = false;
  channelId: string | undefined;
  fetches = 0;
  private total = BigInt(0);
  private readonly frames: { afterMs: number; text: string }[];
  private readonly charge: bigint;

  constructor(frames: { afterMs: number; text: string }[], charge: bigint) {
    this.frames = frames;
    this.charge = charge;
  }

  get cumulative(): bigint {
    return this.total;
  }

  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    this.fetches++;
    this.opened = true;
    this.channelId = FIXTURE.channelId;
    // Signed before the request goes out and kept, because the headers come back 2xx.
    this.total += this.charge;
    const signal = init?.signal as AbortSignal | undefined;
    const frames = [...this.frames];
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const next = frames.shift();
        if (!next) return controller.close();
        try {
          await waitOrAbort(next.afterMs, signal);
        } catch (e) {
          return controller.error(e);
        }
        controller.enqueue(new TextEncoder().encode(next.text));
      },
    });
    return new Response(body, { status: 200 });
  }

  async close(): Promise<MppCloseReceipt> {
    return { txHash: "0x" + "c1".repeat(32), spent: this.total };
  }
}

describe("tempo transport, a chat attempt's deadlines", () => {
  const frames = (afterMs: number) => FIXTURE.streamed.sse.map((text, i) => ({ afterMs: i === 0 ? afterMs : 5, text }));
  const keepAlive = { afterMs: 10, text: ": OPENROUTER PROCESSING\n\n" };

  function drip(session: MppSession, log?: string[]) {
    return new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      abortGraceMs: 200,
      sessionFactory: async () => session,
      ...(log ? { log: (l: string) => log.push(l) } : {}),
    });
  }

  it("cuts a stream that sends nothing but keep-alives at its first-data window, paid and marked timed out", async () => {
    const session = new DripSession([keepAlive, keepAlive, { afterMs: 5_000, text: "" }], QUOTE);
    const log: string[] = [];
    const t0 = Date.now();
    const err = await drip(session, log)
      .chat(REQ, {
        onToken: () => undefined,
        firstDataMs: 120,
        deadlineAt: Date.now() + 5_000,
        attempt: "attempt 1 of 2, openai/gpt-4o-mini",
      })
      .catch((e) => e);
    expect(Date.now() - t0).to.be.below(2_000);
    expect(PaidCallFailed.is(err)).to.equal(true);
    expect((err as PaidCallFailed).timedOut).to.equal(true);
    expect(err.message).to.equal("the gateway sent no part of the model's answer in 0.12 s");
    expect((err as PaidCallFailed).payment.cumulativeAfter).to.equal(QUOTE.toString());
    // The attempt's own line, with its cost, in the style every paid call already logs.
    expect(log[0]).to.match(/^tempo chat \(attempt 1 of 2, openai\/gpt-4o-mini\): 0\.\d s, \+750 base units, failed: /);
  });

  it("leaves a stream that is producing frames alone past its first-data window", async () => {
    // The first frame at 60 ms, inside a 120 ms window; the rest arrive by ~300 ms, well past it.
    const slow = FIXTURE.streamed.sse.map((text, i) => ({ afterMs: i === 0 ? 60 : 40, text }));
    const res = await drip(new DripSession(slow, QUOTE)).chat(REQ, {
      onToken: () => undefined,
      firstDataMs: 120,
      deadlineAt: Date.now() + 5_000,
    });
    expect(res.body).to.deep.equal(FIXTURE.streamed.body);
    expect(res.payment!.cumulativeAfter).to.equal(QUOTE.toString());
  });

  it("holds a buffered call to its deadline only: a first-data window means nothing without frames", async () => {
    const buffered = [{ afterMs: 200, text: JSON.stringify(FIXTURE.withUsage.body) }];
    const res = await drip(new DripSession(buffered, QUOTE)).chat(REQ, {
      firstDataMs: 50,
      deadlineAt: Date.now() + 5_000,
    });
    expect(res.body).to.deep.equal(FIXTURE.withUsage.body);
  });

  it("refuses an attempt whose deadline passed in the queue before anything is signed", async () => {
    const session = new DripSession(frames(5), QUOTE);
    const err = await drip(session)
      .chat(REQ, { onToken: () => undefined, deadlineAt: Date.now() - 1 })
      .catch((e) => e);
    expect(NoAnswerTimeout.is(err)).to.equal(true);
    expect(session.fetches).to.equal(0);
    expect(session.cumulative).to.equal(BigInt(0));
  });

  it("keeps a call with no attempt options on the transport's own deadline and log line", async () => {
    const log: string[] = [];
    const res = await drip(new DripSession(frames(5), QUOTE), log).chat(REQ, { onToken: () => undefined });
    expect(res.body).to.deep.equal(FIXTURE.streamed.body);
    expect(log[0]).to.match(/^tempo chat: \d+\.\d s, \+750 base units, ok$/);
  });
});
