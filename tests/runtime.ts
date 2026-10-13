import { web3 } from "@coral-xyz/anchor";
import * as path from "path";
import { assert } from "chai";
import {
  type Lath,
  EventKind,
  hex,
  idFromString,
  CellOp,
  LathClient,
  Mailbox,
  MemoryTraceStore,
  ResolutionStatus,
  sha256,
  utf8,
  verifyHandoff,
} from "../sdk/src";
import {
  AgentRuntime,
  AgentRuntimeOptions,
  canonicalJson,
  ChargeAndLogRequest,
  ChatResult,
  ChatTransport,
  MppOpenRouterTransport,
  MppSession,
  NoopBilling,
  policyDocument,
  policyVersionHash,
  promptHash,
  margin,
  toMicroUsdc,
  toMicroUsdcFromBase,
  toRuntimePolicy,
} from "../runtime/src";
import { RecordedTransport } from "./fixtures/recorded-transport";
import { FakeChain } from "./fixtures/fake-chain";
import * as fs from "fs";
import { audit, subHashes } from "../sdk/src/audit";
import PARENT_FIXTURE from "../runtime/fixtures/parent.json";
import CHILD_FIXTURE from "../runtime/fixtures/child.json";

const parentFixture = PARENT_FIXTURE as unknown as ChatResult[];
const childFixture = CHILD_FIXTURE as unknown as ChatResult[];

describe("runtime policy and metering", () => {
  it("canonical JSON is key-order independent", () => {
    assert.equal(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] }), '{"a":[3,{"c":5,"d":4}],"b":1}');
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  it("policy hash ignores allow-list order and tracks every field", () => {
    const base = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };
    assert.equal(hex(policyVersionHash(base)), hex(policyVersionHash({ ...base, toolAllowList: ["b", "a"] })));
    for (const changed of [
      { ...base, model: "anthropic/claude-haiku-4.5" },
      { ...base, temperature: 0.3 },
      { ...base, toolAllowList: ["a"] },
      { ...base, maxCost: 5_001 },
    ]) {
      assert.notEqual(hex(policyVersionHash(base)), hex(policyVersionHash(changed)));
    }
  });

  it("a policy with no prompt hashes to the fixed vector, and a prompt changes it", () => {
    const base = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };
    // Pinned bytes, not a re-derivation: `promptHash` is a new key in the canonical document
    // and the point of it being optional is that every genesis hash written before it existed
    // stays valid. If this digest moves, agents already deployed changed policy.
    assert.equal(hex(policyVersionHash(base)), "86d2d33dc8e74fdcf19a52eebb162c94d219241594f33a95ba81c418856912d0");
    assert.equal(hex(policyVersionHash({ ...base, promptHash: undefined })), hex(policyVersionHash(base)));

    const prompt = "You watch the SOL/USDC pool and say what changed.";
    assert.equal(promptHash(prompt), "6182417bbd101bec13338e572f204411f74df1b363590ffb0bd25be3541b4858");
    assert.equal(promptHash(prompt), hex(sha256(utf8(prompt))), "the preimage key is sha256 of the prompt bytes");
    assert.equal(
      hex(policyVersionHash({ ...base, promptHash: promptHash(prompt) })),
      "9c2bb44f03366b7bb2194e860a7275f99177bdc35ed029d3db9de88c1c548c06"
    );
    assert.notEqual(hex(policyVersionHash({ ...base, promptHash: promptHash(prompt) })), hex(policyVersionHash(base)));
    assert.notEqual(
      hex(policyVersionHash({ ...base, promptHash: promptHash(prompt) })),
      hex(policyVersionHash({ ...base, promptHash: promptHash(`${prompt} Twice a day.`) })),
      "a different prompt is a different policy"
    );
  });

  it("publishes the exact bytes the policy hash commits to, on either rail", () => {
    const base = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };
    // The registry key must be the hash of the published document, or `has()` is never
    // true and the second session re-creates the same cell. A `tempo` policy carries `payment`
    // in both; a `vault` one carries it in neither and hashes as a policy with no rail does.
    for (const policy of [base, { ...base, payment: "tempo" as const }, { ...base, payment: "vault" as const }]) {
      assert.equal(hex(sha256(utf8(policyDocument(policy)))), hex(policyVersionHash(policy)));
    }
    assert.ok(policyDocument({ ...base, payment: "tempo" }).includes('"payment":"tempo"'));
    assert.ok(!policyDocument({ ...base, payment: "vault" }).includes("payment"));
    assert.equal(policyDocument({ ...base, payment: "vault" }), policyDocument(base));
  });

  it("rounds cost up to micro-USDC with margin", () => {
    assert.equal(toMicroUsdc(0.0031415, 0.1), 3456n); // 3455.65 → up
    assert.equal(toMicroUsdc(0.000001, 0.1), 2n); // 1.1 → up
    assert.equal(toMicroUsdc(0, 0.1), 0n);
    assert.equal(toMicroUsdc(-1, 0.1), 0n);
    assert.equal(toMicroUsdc(1, 0), 1_000_000n);
  });

  /**
   * Lath names tools `namespace.verb`; the OpenAI function schema most providers
   * implement allows `[A-Za-z0-9_-]` only, and at least one enforces it with a 400 before a
   * single step runs. So the dot becomes an underscore on the wire and is mapped back when the
   * model calls it — and nothing on chain is the wire name.
   *
   * There was no coverage of this at all. A regression is a 400 on every step of every deployed
   * agent that has tools, which is every deployed agent.
   */
  it("a dotted tool name goes out underscored and comes back dotted", () => {
    const names = ["solana.slot", "lath.verify_chain", "plain", "a.b.c"];
    const runtime = new AgentRuntime({
      client: {} as any,
      agentId: idFromString("wire-names"),
      transport: new RecordedTransport([]),
      policy: { model: "m", temperature: 0, toolAllowList: names, maxCost: 1 },
      tools: names.map((name) => ({ name, async execute() {} })),
    });

    // Out: every schema name is one the provider will accept, and the dots are the only thing
    // that moved.
    const wire = runtime.toolSchemas().map((s) => s.function.name);
    assert.deepEqual(wire, ["solana_slot", "lath_verify_chain", "plain", "a_b_c"]);
    for (const n of wire) assert.match(n, /^[A-Za-z0-9_-]+$/, `${n} is not a legal function name`);

    // Back: what the model calls resolves to the tool this runtime knows by dots. `toolName` is
    // private because only `runToolCall` has any business calling it, and `runToolCall` needs a
    // chain; this is the half of the round trip that can be checked without one.
    const back = (w: string) => (runtime as any).toolName(w);
    for (let i = 0; i < names.length; i++) assert.equal(back(wire[i]), names[i]);

    // A name the runtime does not know comes back unchanged, which is what lets `runToolCall`
    // log `unknown tool "x"` with the name the model actually used.
    assert.equal(back("nope_nope"), "nope_nope");
    assert.equal(back(""), "");

    // The policy commits to the dotted names, not the wire ones — renaming on the wire must not
    // be able to change a deployed agent's `policy_version_hash`.
    const policy = { model: "m", temperature: 0, toolAllowList: names, maxCost: 1 };
    assert.notEqual(
      hex(policyVersionHash(policy)),
      hex(policyVersionHash({ ...policy, toolAllowList: wire })),
      "the wire name is not what the policy hash sees"
    );
  });

  it("prefers an exact tool name over one that only matches after the dot is replaced", () => {
    // `a_b` and `a.b` collide on the wire. `toolName` checks for an exact match first, so the
    // tool literally called `a_b` wins and `a.b` is unreachable — the collision is the
    // publisher's to avoid, and this pins which way it resolves rather than leaving it to the
    // insertion order of a Map.
    const runtime = new AgentRuntime({
      client: {} as any,
      agentId: idFromString("wire-collision"),
      transport: new RecordedTransport([]),
      policy: { model: "m", temperature: 0, toolAllowList: ["a.b", "a_b"], maxCost: 1 },
      tools: [
        { name: "a.b", async execute() {} },
        { name: "a_b", async execute() {} },
      ],
    });
    assert.deepEqual(
      runtime.toolSchemas().map((s) => s.function.name),
      ["a_b", "a_b"]
    );
    assert.equal((runtime as any).toolName("a_b"), "a_b");
  });

  it("refuses a tool that the policy does not allow", () => {
    assert.throws(
      () =>
        new AgentRuntime({
          client: {} as any,
          agentId: idFromString("nope"),
          transport: new RecordedTransport([]),
          policy: { model: "m", temperature: 0, toolAllowList: [], maxCost: 1 },
          tools: [{ name: "lookup", async execute() {} }],
        }),
      /not in the policy allow-list/
    );
  });
});

/**
 * The runtime on the `tempo` rail (docs/ARCHITECTURE.md §7.2).
 *
 * Node-only and network-free: an in-memory chain (`fixtures/fake-chain.ts`), an in-memory trace
 * store, and a `FakeMppSession` standing in for mppx over the same fixture `tests/tempo-inference.ts`
 * reads. No Tempo transaction is made, no key exists and no mainnet money can be spent from here.
 *
 * What these guard is the half the transport's own suite cannot: that the payment reaches the *record* — the blob the
 * chain hashes — and the *bill* — the vault charge the user actually pays — and that neither of
 * them moves for a session on the vault rail, whose bytes must stay exactly what they were.
 *
 * The describe name carries "runtime policy and metering" so CI's node-only slice
 * (`-g 'runtime policy and metering'`) runs it without a workflow change.
 */
describe("runtime policy and metering on the tempo rail", () => {
  const TEMPO_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tempo-gateway.json"), "utf8")) as {
    channelId: string;
    withUsage: { status: number; body: any };
    withoutUsage: { status: number; body: any };
    refused: { status: number; body: Record<string, unknown> };
    quoteBaseUnits: string;
  };
  /** The gateway's flat per-request quote for `openai/gpt-4o-mini`: the meter's unit. */
  const QUOTE = BigInt(TEMPO_FIXTURE.quoteBaseUnits);
  const PAYER = "0x18fB0000000000000000000000000000000000B0";
  const SETTLEMENT_TX = "0xc1d6a5ed0000000000000000000000000000000000000000000000000000745c";
  const USER = new web3.PublicKey("11111111111111111111111111111112");

  /**
   * mppx's session manager, as much of it as the transport touches. The charge lands as the
   * response is produced, which is what the transport's read-after-drain then sees; the ordering
   * itself is `tests/tempo-inference.ts`'s to prove, and this file takes it as given.
   */
  class FakeMppSession {
    opened = false;
    channelId: string | undefined;
    closes = 0;
    failClose = false;
    private total = BigInt(0);
    private i = 0;

    private readonly plans: { status: number; body: unknown; charge?: bigint }[];

    constructor(plans: { status: number; body: unknown; charge?: bigint }[]) {
      this.plans = plans;
    }

    get cumulative(): bigint {
      return this.total;
    }

    async fetch(_url: string, _init?: RequestInit): Promise<Response> {
      this.opened = true;
      this.channelId = TEMPO_FIXTURE.channelId;
      const plan = this.plans[Math.min(this.i++, this.plans.length - 1)];
      if (plan.charge) this.total += plan.charge;
      return new Response(JSON.stringify(plan.body), { status: plan.status });
    }

    async close(): Promise<{ txHash?: string; spent?: string }> {
      this.closes++;
      if (this.failClose) throw new Error("the settlement transaction was not accepted");
      return { txHash: SETTLEMENT_TX, spent: this.total.toString() };
    }
  }

  function tempoTransport(session: FakeMppSession): MppOpenRouterTransport {
    return new MppOpenRouterTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      sessionFactory: async () => session as unknown as MppSession,
    });
  }

  /** A session shaped the way the console runs one, on an in-memory chain. */
  function sessionOn(chain: FakeChain, transport: ChatTransport, extra: Partial<AgentRuntimeOptions> = {}) {
    const store = new MemoryTraceStore();
    const billing = new NoopBilling();
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: idFromString("tempo-runtime-agent"),
      transport,
      store,
      billing,
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      policy: { model: "openai/gpt-4o-mini", temperature: 0, toolAllowList: [], maxCost: 5_000_000 },
      // The console hands the same object twice — it is the transport that pays and the channel
      // that settles — and so does this.
      tempo: transport instanceof MppOpenRouterTransport ? transport : undefined,
      ...extra,
    });
    return { runtime, store, billing };
  }

  /** The blob an event's `result_hash` names, resolved through its payload preimage. */
  async function resultBlob(store: MemoryTraceStore, record: { input: { kind: number; payloadHash: Uint8Array } }) {
    const preimage = await store.get(record.input.payloadHash);
    assert.isNotNull(preimage, "the payload preimage was stored");
    const subs = subHashes(record.input.kind, preimage!.slice(1));
    const resultHash = subs[subs.length - 1];
    const blob = await store.get(resultHash);
    assert.isNotNull(blob, "the result blob was stored");
    return { resultHash, blob: blob!, json: JSON.parse(Buffer.from(blob!).toString("utf8")) };
  }

  const okPlan = { status: 200, body: TEMPO_FIXTURE.withUsage.body, charge: QUOTE };

  afterEach(() => {
    delete process.env.LATH_MARGIN;
  });

  it("hashes an explicit vault rail exactly as an absent one, and a tempo rail differently", () => {
    const base = { model: "openai/gpt-4o-mini", temperature: 0.2, toolAllowList: ["a"], maxCost: 5_000 };
    // The whole point of the field being optional: every genesis hash written without it has to
    // stay where it is, and a deployment that says out loud what it was already doing must not
    // move one.
    assert.equal(
      hex(policyVersionHash({ ...base, payment: "vault" })),
      hex(policyVersionHash(base)),
      "an explicit vault rail is the same policy as no rail at all"
    );
    assert.notEqual(
      hex(policyVersionHash({ ...base, payment: "tempo" })),
      hex(policyVersionHash(base)),
      "the tempo rail is a different set of rules and says so"
    );
    // And the normalisation is in the policy itself, not only in the hash: the document the
    // registry publishes and the genesis `input` both read off `toRuntimePolicy`.
    assert.isUndefined(toRuntimePolicy({ ...base, payment: "vault" }).payment);
    assert.equal(toRuntimePolicy({ ...base, payment: "tempo" }).payment, "tempo");
  });

  it("meters the voucher delta with the tempo margin, rounding up", () => {
    // 750 × 1.15 = 862.5 → 863. Integer arithmetic throughout: the charge is reproducible from
    // the delta a record commits and the documented margin, with no float to disagree about.
    assert.equal(toMicroUsdcFromBase(QUOTE, 0.15), 863n);
    assert.equal(toMicroUsdcFromBase(BigInt(10_000), 0.15), 11_500n);
    assert.equal(toMicroUsdcFromBase(0n, 0.15), 0n);
    // The default is the measurement's: the treasury pays no gas per channel, so the one
    // margin is 0.10. 750 × 1.10 = 825, exact.
    assert.equal(margin(), 0.1, "unset means the documented default");
    assert.equal(toMicroUsdcFromBase(QUOTE, margin()), 825n);
  });

  it("stores the voucher in the blob the record hashes", async () => {
    const chain = new FakeChain();
    const session = new FakeMppSession([okPlan]);
    const { runtime, store } = sessionOn(chain, tempoTransport(session));

    const result = await runtime.start({ user: USER, prompt: "ping", sessionId: "tempo-1" });
    assert.equal(result.status, "success", result.reason);

    const action = result.events.find((e) => e.input.kind === EventKind.Action)!;
    const { resultHash, blob, json } = await resultBlob(store, action);

    // `result_hash` is sha256 of exactly these bytes, so the chain commits the payment as much
    // as it commits the completion: an auditor reads both out of one blob.
    assert.equal(hex(sha256(blob)), hex(resultHash));
    assert.deepEqual(json.payment, {
      rail: "tempo",
      chainId: 4217,
      payer: PAYER,
      channelId: TEMPO_FIXTURE.channelId,
      cumulativeBefore: "0",
      cumulativeAfter: QUOTE.toString(),
      usageCost: TEMPO_FIXTURE.withUsage.body.usage.cost,
    });
    // The body is otherwise untouched: the rail hangs the payment beside the completion and
    // changes nothing an existing reader looks at.
    assert.equal(json.id, TEMPO_FIXTURE.withUsage.body.id);
    assert.deepEqual(json.choices, TEMPO_FIXTURE.withUsage.body.choices);
  });

  it("leaves the blob byte-identical on the vault rail", async () => {
    const chain = new FakeChain();
    const body = TEMPO_FIXTURE.withUsage.body;
    const vault: ChatTransport = {
      async chat() {
        return { status: 200, body } as ChatResult;
      },
    };
    const { runtime, store } = sessionOn(chain, vault);

    const result = await runtime.start({ user: USER, prompt: "ping", sessionId: "vault-1" });
    const action = result.events.find((e) => e.input.kind === EventKind.Action)!;
    const { blob, json } = await resultBlob(store, action);

    // A chain written before this rail existed reads exactly as before, because the bytes are
    // the ones it would have written: nothing is defaulted in, not even a null.
    assert.isUndefined(json.payment);
    assert.equal(Buffer.from(blob).toString("utf8"), JSON.stringify(body));
  });

  it("charges the delta and the tempo margin, whether or not the gateway priced the tokens", async () => {
    for (const [name, plan] of [
      ["with usage.cost", { status: 200, body: TEMPO_FIXTURE.withUsage.body, charge: QUOTE }],
      ["without", { status: 200, body: TEMPO_FIXTURE.withoutUsage.body, charge: QUOTE }],
    ] as const) {
      const chain = new FakeChain();
      const session = new FakeMppSession([plan]);
      const { runtime, store, billing } = sessionOn(chain, tempoTransport(session));
      const result = await runtime.start({ user: USER, prompt: "ping", sessionId: `tempo-${name}` });

      // `ceil(750 × 1.10)` either way: `usage.cost` is a record and never a meter, so
      // the two bodies differ in what they say and not in what they cost.
      assert.equal(billing.charged, 825n, `${name}: the delta with the tempo margin`);
      assert.equal(result.costMicroUsdc, 825n, name);

      const action = result.events.find((e) => e.input.kind === EventKind.Action)!;
      const { json } = await resultBlob(store, action);
      if (name === "with usage.cost") {
        assert.equal(json.payment.usageCost, TEMPO_FIXTURE.withUsage.body.usage.cost);
      } else {
        // Absent, not zero: zero would read as "the model was free" rather than "the gateway
        // said nothing about it".
        assert.notProperty(json.payment, "usageCost");
      }
    }
  });

  it("writes no event for a call whose voucher was refused, and resolves the session failed", async () => {
    const chain = new FakeChain();
    const session = new FakeMppSession([{ status: TEMPO_FIXTURE.refused.status, body: TEMPO_FIXTURE.refused.body }]);
    const { runtime, billing } = sessionOn(chain, tempoTransport(session));

    const result = await runtime.start({ user: USER, prompt: "ping", sessionId: "tempo-refused" });

    assert.equal(result.status, "failed");
    // The throw comes out of `transport.chat`, which is before every `store.put` and every
    // charge, so there is nothing to unwind: the chain carries the genesis and the resolution
    // and no Action claiming work that was never paid for.
    assert.isUndefined(result.events.find((e) => e.input.kind === EventKind.Action));
    assert.equal(billing.charged, 0n);
    assert.equal(result.costMicroUsdc, 0n);
    assert.include(result.reason ?? "", "402", "the gateway's own refusal is what the record says");
    // And the channel is still settled: a refused call leaves a channel open, not a session
    // that may skip its receipt.
    assert.equal(session.closes, 1);
    assert.equal(result.tempo?.closed, true);
  });

  it("puts the settlement transaction in the Resolution blob", async () => {
    const chain = new FakeChain();
    const session = new FakeMppSession([okPlan]);
    const { runtime, store } = sessionOn(chain, tempoTransport(session));

    const result = await runtime.start({ user: USER, prompt: "ping", sessionId: "tempo-settled" });
    assert.equal(session.closes, 1, "one channel, closed once");
    assert.deepEqual(
      { closed: result.tempo?.closed, txHash: result.tempo?.txHash, payer: result.tempo?.payer },
      { closed: true, txHash: SETTLEMENT_TX, payer: PAYER }
    );

    const resolution = result.events.find((e) => e.input.kind === EventKind.Resolution)!;
    const { json } = await resultBlob(store, resolution);
    // The receipt rides on the record that closes the session it paid for — the channel is per
    // session, and so is the Resolution. It names its channel too, so a verifier can
    // tell this settlement from another channel's.
    assert.deepEqual(json.settlement, {
      txHash: SETTLEMENT_TX,
      spent: QUOTE.toString(),
      channelId: TEMPO_FIXTURE.channelId,
    });
  });

  it("reports a close that failed instead of failing the session for it", async () => {
    const chain = new FakeChain();
    const session = new FakeMppSession([okPlan]);
    session.failClose = true;
    const { runtime, store } = sessionOn(chain, tempoTransport(session));

    const result = await runtime.start({ user: USER, prompt: "ping", sessionId: "tempo-unsettled" });

    // The calls were paid for and their records are on chain; what failed is the receipt
    // The channel id survives on the snapshot because only a retry that names it can
    // close the channel, and only the operator's key can do that at all.
    assert.equal(result.status, "success");
    assert.equal(result.workStatus, "success");
    assert.equal(result.tempo?.closed, false);
    assert.equal(result.tempo?.channelId, TEMPO_FIXTURE.channelId);
    assert.include(result.tempo?.error ?? "", "not accepted");

    const resolution = result.events.find((e) => e.input.kind === EventKind.Resolution)!;
    const { json } = await resultBlob(store, resolution);
    assert.isUndefined(json.settlement, "a settlement nobody can point at is not written down");
  });
});
