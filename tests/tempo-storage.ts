/**
 * The charge transport that pays Tempo's storage gateway (docs/ARCHITECTURE.md §7.4), the
 * queue that PUTs each step's report after its leaf, and the drain a stop waits for.
 *
 * Node-only, network-free, key-free: the charge client is a fake that answers a 402 the way mppx
 * does — it hands each challenge to `approve` before it would sign — and the account is an address
 * with no key behind it. No Tempo transaction is made and no mainnet money can be spent from here.
 */
import * as path from "path";
import { pathToFileURL } from "url";
import { expect } from "chai";
import { keccak256, stringToBytes, toBytes } from "viem";
import { MemoryTraceStore, decodeLoopManifest, hex, sha256, toBytes32, utf8 } from "../sdk/src";
import {
  ChargeRefused,
  LoopTempoServices,
  MppChargeTransport,
  PaidChargeFailed,
  STORAGE_PUT_TOOL,
  TEMPO_STOP_DRAIN_MS,
  chargeAmountBase,
  chargeMethodParameters,
  decodeTempoCarry,
  storageKey,
  type ChargeFetcher,
  type LoopEvent,
  type MppChargeChallenge,
  type MppChargeClientFactory,
  type MppChargeResult,
  type StorageReportFile,
} from "../runtime/src";
import { stepReportFile } from "../runtime/src/zeroclaw/report";
import { EMPTY_WORKSPACE_HASH, treeBytes, type WorkspaceEntry } from "../runtime/src/zeroclaw/workspace";
import { tempoLoop } from "./fixtures/tempo-loop";
import { hashPayload, type LogResult } from "../sdk/src";

/** An address with no key: the transport reads only `.address`. */
const PAYER = "0x18fB0000000000000000000000000000000000B0";
const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
const RECIPIENT = "0x5707000000000000000000000000000000000000";
const STORAGE = "https://storage.mpp.tempo.xyz";

/** A storage challenge as the gateway serialises one: base units, USDC.e, Tempo mainnet. */
function challenge(
  amount: string | number = "200",
  over: Partial<MppChargeChallenge["request"]> = {}
): MppChargeChallenge {
  return {
    method: "tempo",
    intent: "charge",
    request: { amount, currency: USDC_E, recipient: RECIPIENT, decimals: 6, methodDetails: { chainId: 4217 }, ...over },
  };
}

interface Sent {
  url: string;
  method?: string;
  /** Whether a credential was created — the moment a transfer is signed. */
  signed: boolean;
}

/**
 * A charge client that answers like the gateway: a 402 with `quote`, then — if `approve` let it
 * through — the paid answer `status` with a `Payment-Receipt` naming `reference`. `unpaid` answers
 * without any challenge at all (the gateway's plain 404 for a key with a `/`); `cut` throws after
 * the credential went out; `refuseCredential` answers 402 again after it.
 */
function gateway(
  o: {
    quote?: MppChargeChallenge | MppChargeChallenge[];
    status?: number;
    body?: string;
    reference?: string;
    unpaid?: number;
    cut?: boolean;
    refuseCredential?: boolean;
  } = {}
): {
  factory: MppChargeClientFactory;
  sent: Sent[];
  readReceipt: (res: Response) => Promise<{ reference?: string } | null>;
} {
  const sent: Sent[] = [];
  const factory: MppChargeClientFactory = async ({ approve }) => ({
    async fetch(url: string, init?: RequestInit) {
      const record: Sent = { url, method: init?.method, signed: false };
      sent.push(record);
      if (o.unpaid) return new Response("not found", { status: o.unpaid });
      const quotes = Array.isArray(o.quote) ? o.quote : [o.quote ?? challenge()];
      for (const q of quotes) {
        approve(q); // throws to refuse, before anything is signed
        record.signed = true;
      }
      if (o.cut) throw new Error("socket hang up");
      if (o.refuseCredential) return new Response("payment rejected", { status: 402 });
      return new Response(o.body ?? "ok", {
        status: o.status ?? 200,
        headers: o.reference === undefined ? {} : { "x-test-receipt": o.reference },
      });
    },
  });
  // The fake receipt rides a test header; the real reader is mppx's `Receipt.fromResponse`.
  const readReceipt = async (res: Response) => {
    const reference = res.headers.get("x-test-receipt");
    return reference === null ? null : { reference };
  };
  return { factory, sent, readReceipt };
}

function transport(g: ReturnType<typeof gateway>, maxCostBase = BigInt(1_000)) {
  return new MppChargeTransport({
    account: { address: PAYER },
    maxCostBase,
    currency: USDC_E,
    clientFactory: g.factory,
    readReceipt: g.readReceipt,
  });
}

describe("storage — the charge transport", () => {
  it("pays a stubbed 402 and answers { status, bytes, payment } with the receipt's reference", async () => {
    const g = gateway({ reference: "0xtx1", body: "stored" });
    const res = await transport(g).fetch(`${STORAGE}/loop-a-key`, { method: "PUT", body: "report" });
    expect(res.status).to.equal(200);
    expect(new TextDecoder().decode(res.bytes)).to.equal("stored");
    expect(res.payment).to.deep.equal({
      intent: "charge",
      chainId: 4217,
      payer: PAYER,
      recipient: RECIPIENT,
      amount: "200",
      currency: USDC_E,
      reference: "0xtx1",
    });
    expect(g.sent).to.have.length(1);
    expect(g.sent[0].signed).to.equal(true);
  });

  it("names a loop key as signer beside the root as payer, and a treasury charge has no signer key", async () => {
    // An owner-paid storage PUT is signed by the loop's access key, whose account reports the
    // root as `address`; the audit's payer stays the treasury and the key goes beside it.
    const KEY = "0x6B1aE0a6f2C9e4D3b5A7c8E9f0a1B2c3D4e5F607";
    const g = gateway({ reference: "0xtx2" });
    const keyed = new MppChargeTransport({
      account: { address: PAYER, accessKeyAddress: KEY },
      maxCostBase: BigInt(1_000),
      currency: USDC_E,
      clientFactory: g.factory,
      readReceipt: g.readReceipt,
    });
    const res = await keyed.fetch(`${STORAGE}/loop-a-key`, { method: "PUT", body: "report" });
    expect(res.payment).to.deep.equal({
      intent: "charge",
      chainId: 4217,
      payer: PAYER,
      signer: KEY,
      recipient: RECIPIENT,
      amount: "200",
      currency: USDC_E,
      reference: "0xtx2",
    });
    expect(keyed.payer).to.equal(PAYER);

    // A cut call's approved payment names the key too: the record of a failed PUT is the same record.
    const cut = gateway({ cut: true });
    const thrown = await new MppChargeTransport({
      account: { address: PAYER, accessKeyAddress: KEY },
      maxCostBase: BigInt(1_000),
      currency: USDC_E,
      clientFactory: cut.factory,
      readReceipt: cut.readReceipt,
    })
      .fetch(`${STORAGE}/loop-a-key`, { method: "PUT", body: "report" })
      .then(
        () => null,
        (e) => e
      );
    expect(thrown).to.be.instanceOf(PaidChargeFailed);
    expect((thrown as PaidChargeFailed).payment.signer).to.equal(KEY);
    expect((thrown as PaidChargeFailed).payment.payer).to.equal(PAYER);

    // The treasury's record has no `signer` key at all, so it serialises exactly as before keys.
    const plain = await transport(gateway({ reference: "0xtx3" })).fetch(`${STORAGE}/loop-a-key`, { method: "PUT" });
    expect("signer" in plain.payment!).to.equal(false);
    expect(JSON.stringify(plain.payment)).to.not.include("signer");
  });

  it("refuses a charge over the per-call ceiling before anything is signed", async () => {
    const g = gateway({ quote: challenge("1001"), reference: "0xnever" });
    let err: unknown;
    try {
      await transport(g, BigInt(1_000)).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(ChargeRefused);
    expect((err as Error).message).to.match(/1001 base units.*at most 1000/);
    expect(g.sent[0].signed, "no credential was created").to.equal(false);
  });

  it("refuses another currency, another chain, another intent and an unreadable price", async () => {
    const cases: MppChargeChallenge[] = [
      challenge("200", { currency: "0x0000000000000000000000000000000000000001" }),
      challenge("200", { methodDetails: { chainId: 1 } }),
      { ...challenge(), intent: "session" },
      challenge("a lot"),
    ];
    for (const quote of cases) {
      const g = gateway({ quote, reference: "0xnever" });
      let err: unknown;
      try {
        await transport(g).fetch(`${STORAGE}/k`);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(quote)).to.be.instanceOf(ChargeRefused);
      expect(g.sent[0].signed).to.equal(false);
    }
  });

  it("pays once per call: a second challenge inside one call is refused", async () => {
    const g = gateway({ quote: [challenge("200"), challenge("200")], reference: "0xtx" });
    let err: unknown;
    try {
      await transport(g).fetch(`${STORAGE}/k`);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(ChargeRefused);
    expect((err as Error).message).to.match(/second challenge/);
  });

  it("answers an unpaid response with no payment, and a refused credential with none either", async () => {
    const unpaid = await transport(gateway({ unpaid: 404 })).fetch(`${STORAGE}/a/b`);
    expect(unpaid.status).to.equal(404);
    expect(unpaid.payment).to.equal(undefined);

    const refused = await transport(gateway({ refuseCredential: true, reference: "0xnope" })).fetch(`${STORAGE}/k`);
    expect(refused.status).to.equal(402);
    expect(refused.payment).to.equal(undefined);
  });

  it("records a paid 404 as paid: the gateway charged for the call whatever it found", async () => {
    const res = await transport(gateway({ status: 404, reference: "0xpaid404" })).fetch(`${STORAGE}/k`);
    expect(res.status).to.equal(404);
    expect(res.payment?.reference).to.equal("0xpaid404");
  });

  it("throws PaidChargeFailed, with what it approved and no reference, when a signed call is cut", async () => {
    let err: unknown;
    try {
      await transport(gateway({ cut: true })).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(PaidChargeFailed);
    expect((err as PaidChargeFailed).payment).to.include({ amount: "200", reference: "", payer: PAYER });
  });

  describe("a gateway that stalls", () => {
    /** A charge client that approves (or not) and then never answers, whatever its signal says. */
    const stalled =
      (approveFirst: boolean): MppChargeClientFactory =>
      async ({ approve }) => ({
        async fetch() {
          if (approveFirst) approve(challenge());
          return new Promise<Response>(() => undefined);
        },
      });
    const within = (factory: MppChargeClientFactory, readReceipt = gateway().readReceipt) =>
      new MppChargeTransport({
        account: { address: PAYER },
        maxCostBase: BigInt(1_000),
        currency: USDC_E,
        clientFactory: factory,
        readReceipt,
        callDeadlineMs: 30,
      });
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e) => e
      );

    it("gives up on a signed call at the deadline, as PaidChargeFailed with what it approved", async () => {
      const t0 = Date.now();
      const err = await failure(within(stalled(true)).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" }));
      expect(Date.now() - t0).to.be.lessThan(2_000);
      expect(err).to.be.instanceOf(PaidChargeFailed);
      expect(String(err.message)).to.match(/did not answer the charge call/);
      expect((err as PaidChargeFailed).payment).to.include({ amount: "200", reference: "" });
    });

    it("gives up before anything was signed as a plain failure, which records nothing paid", async () => {
      const err = await failure(within(stalled(false)).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" }));
      expect(err).to.be.instanceOf(Error);
      expect(err).to.not.be.instanceOf(PaidChargeFailed);
      expect(String(err.message)).to.match(/did not answer the charge call/);
    });

    it("bounds the body too: a paid answer that trickles keeps the receipt's reference", async () => {
      const g = gateway();
      const trickle: MppChargeClientFactory = async ({ approve }) => ({
        async fetch() {
          approve(challenge());
          // Headers and a receipt at once, then one byte and silence: undici's own timeout never fires.
          const body = new ReadableStream<Uint8Array>({
            start: (c) => c.enqueue(new Uint8Array([1])),
          });
          return new Response(body, { status: 200, headers: { "x-test-receipt": "0xtrickled" } });
        },
      });
      const err = await failure(within(trickle, g.readReceipt).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" }));
      expect(err).to.be.instanceOf(PaidChargeFailed);
      expect((err as PaidChargeFailed).payment.reference).to.equal("0xtrickled");
    });

    it("follows the caller's own signal as well as the deadline", async () => {
      const ac = new AbortController();
      const t = new MppChargeTransport({
        account: { address: PAYER },
        maxCostBase: BigInt(1_000),
        currency: USDC_E,
        clientFactory: stalled(true),
        readReceipt: gateway().readReceipt,
      });
      const pending = failure(t.fetch(`${STORAGE}/k`, { method: "PUT", body: "x", signal: ac.signal }));
      ac.abort(new Error("the caller stopped"));
      const err = await pending;
      expect(err).to.be.instanceOf(PaidChargeFailed);
      expect(String(err.message)).to.equal("the caller stopped");
    });
  });

  it("hands a clientId to the charge client only when it was given one", async () => {
    // What each factory call was asked for, so the test sees the parameters mppx would be built with.
    const asked: Parameters<MppChargeClientFactory>[0][] = [];
    const recording = (g: ReturnType<typeof gateway>): MppChargeClientFactory => {
      return async (o) => {
        asked.push(o);
        return g.factory(o);
      };
    };
    const LOOP_ID = "loop-keyed-demo";
    const g = gateway({ reference: "0xtx4" });
    const keyed = new MppChargeTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(1_000),
      currency: USDC_E,
      clientId: LOOP_ID,
      clientFactory: recording(g),
      readReceipt: g.readReceipt,
    });
    const res = await keyed.fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
    expect(asked[0].clientId).to.equal(LOOP_ID);
    // The record is the one an unattributed charge writes: the id rides the transfer's memo, not the payment.
    expect(Object.keys(res.payment!).sort()).to.deep.equal(
      ["amount", "chainId", "currency", "intent", "payer", "recipient", "reference"].sort()
    );

    const h = gateway({ reference: "0xtx5" });
    await new MppChargeTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(1_000),
      currency: USDC_E,
      clientFactory: recording(h),
      readReceipt: h.readReceipt,
    }).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
    expect("clientId" in asked[1], "an unkeyed charge's factory is never told a clientId").to.equal(false);
  });

  it("passes mppx's tempo.charge the clientId when set, and exactly the unattributed parameters when not", () => {
    const base = { account: { address: PAYER }, chainId: 4217, rpcUrl: "https://rpc.tempo.xyz", approve: () => {} };
    const before = {
      account: base.account,
      expectedChainId: 4217,
      allowedChainIds: [4217],
      rpcUrl: { 4217: "https://rpc.tempo.xyz" },
    };
    expect(chargeMethodParameters(base)).to.deep.equal(before);
    expect(chargeMethodParameters({ ...base, clientId: "" }), "an empty id is no id").to.deep.equal(before);
    expect(chargeMethodParameters({ ...base, clientId: "loop-a" })).to.deep.equal({ ...before, clientId: "loop-a" });
  });

  it("mppx writes keccak256(clientId)[0..9] into memo bytes 15..24, and zeros without one", async () => {
    // `Attribution` is not in mppx's export map, so it is loaded from its file — the module
    // `tempo/client/Charge.js` itself calls with the `clientId` the parameters above carry. Through
    // `new Function` for the reason `transport/mpp.ts` gives: mppx is ESM-only and this suite is not.
    const file = pathToFileURL(path.join(__dirname, "..", "node_modules", "mppx", "dist", "tempo", "Attribution.js"));
    const load = new Function("m", "return import(m)") as (m: string) => Promise<any>;
    const Attribution = await load(file.href);
    const LOOP_ID = "loop-keyed-demo";
    const challengeId = "challenge-1";
    const serverId = "storage.mpp.tempo.xyz";

    const attributed = toBytes(Attribution.encode({ challengeId, clientId: LOOP_ID, serverId }));
    const anonymous = toBytes(Attribution.encode({ challengeId, serverId }));
    expect(attributed).to.have.length(32);
    const fingerprint = toBytes(keccak256(stringToBytes(LOOP_ID))).slice(0, 10);
    expect(Array.from(attributed.slice(15, 25))).to.deep.equal(Array.from(fingerprint));
    expect(Array.from(anonymous.slice(15, 25))).to.deep.equal(new Array(10).fill(0));
    // Everything but the client field is the same memo: the tag, version, server and nonce do not move.
    expect(Array.from(attributed.slice(0, 15))).to.deep.equal(Array.from(anonymous.slice(0, 15)));
    expect(Array.from(attributed.slice(25))).to.deep.equal(Array.from(anonymous.slice(25)));
  });

  it("reads a price in base units, or in the challenge's decimals", () => {
    expect(chargeAmountBase({ amount: "200" })).to.equal(BigInt(200));
    expect(chargeAmountBase({ amount: 200 })).to.equal(BigInt(200));
    expect(chargeAmountBase({ amount: "0.0002", decimals: 6 })).to.equal(BigInt(200));
    expect(chargeAmountBase({ amount: "0.0000001", decimals: 6 })).to.equal(null);
    expect(chargeAmountBase({ amount: "-1" })).to.equal(null);
  });
});

// ─── The storage queue ────────────────────────────────────────────────────────────────────────

const LOOP = "loop-storage-demo";
const REPORT: StorageReportFile = {
  path: "report/authority.md",
  bytes: utf8("# Who can upgrade\n\nThe council, 2 of 3.\n"),
};
const REPORT_HASH = hex(sha256(REPORT.bytes));

/** What a charge fetcher was asked — each key, and the body and content type sent under it — and how it answers. */
function fakeStorage(
  answer: (key: string) => Promise<MppChargeResult>
): ChargeFetcher & { calls: string[]; bodies: Uint8Array[]; types: string[] } {
  const calls: string[] = [];
  const bodies: Uint8Array[] = [];
  const types: string[] = [];
  return {
    payer: PAYER,
    calls,
    bodies,
    types,
    async fetch(url: string, init?: RequestInit) {
      const key = url.slice(url.lastIndexOf("/") + 1);
      calls.push(key);
      bodies.push(init?.body as unknown as Uint8Array);
      types.push(new Headers(init?.headers).get("content-type") ?? "");
      return answer(key);
    },
  };
}

function paid(reference: string, amount = "200", status = 200): MppChargeResult {
  return {
    status,
    bytes: utf8(status === 200 ? "" : "InternalError"),
    payment: {
      intent: "charge",
      chainId: 4217,
      payer: PAYER,
      recipient: RECIPIENT,
      amount,
      currency: USDC_E,
      reference,
    },
  };
}

describe("storage — the storage queue", () => {
  it("returns at once, then PUTs the report once, under <loopId>-<sha256> and nothing else", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const storage = fakeStorage(async () => {
      await gate;
      return paid("0xmain");
    });
    const services = new LoopTempoServices({ loopId: LOOP, storage });
    services.afterLeaf(1, async () => REPORT);
    expect(services.inFlight, "the job runs after afterLeaf returns").to.equal(1);
    expect(services.takePuts()).to.have.length(0);
    release();
    await services.drain();
    expect(storage.calls, "no second PUT under -latest").to.deep.equal([`${LOOP}-${REPORT_HASH}`]);
    const [put] = services.takePuts();
    expect(put.key).to.equal(storageKey(LOOP, REPORT_HASH));
    expect(put.ofStep).to.equal(1);
    expect(put.statusCode).to.equal(200);
    expect(put.ownerBase).to.equal(BigInt(200));
    expect(put.receipt).to.deep.include({
      key: put.key,
      bytes: REPORT.bytes.length,
      storedBytes: REPORT.bytes.length,
      encoding: "plain",
      path: REPORT.path,
    });
    expect(put.receipt.payment?.reference).to.equal("0xmain");
    expect(put.receipt).to.not.have.property("latest");
    // A plain agent's report goes as itself, typed as what it is.
    expect(storage.bodies[0]).to.deep.equal(REPORT.bytes);
    expect(storage.types[0]).to.match(/^text\/markdown/);
  });

  it("publishes nothing and records nothing for a step that wrote no report", async () => {
    const storage = fakeStorage(async () => paid("0x"));
    const services = new LoopTempoServices({ loopId: LOOP, storage });
    services.afterLeaf(1, async () => null);
    services.afterLeaf(2, async () => {
      throw new Error("the store has no replay record");
    });
    await services.drain();
    expect(storage.calls).to.have.length(0);
    expect(services.takePuts()).to.have.length(0);
  });

  it("records every failed PUT as failed, and charges the owner only for a payment a receipt names", async () => {
    const cases: [string, (key: string) => Promise<MppChargeResult>, number, bigint][] = [
      ["refused", async () => Promise.reject(new ChargeRefused("over the ceiling")), 402, BigInt(0)],
      ["unreachable", async () => Promise.reject(new Error("ECONNRESET")), 502, BigInt(0)],
      [
        "cut after signing",
        async () => Promise.reject(new PaidChargeFailed("socket hang up", { ...paid("").payment!, reference: "" })),
        502,
        BigInt(0),
      ],
      ["paid 500", async () => paid("0xpaid500", "200", 500), 500, BigInt(200)],
    ];
    for (const [name, answer, statusCode, ownerBase] of cases) {
      const services = new LoopTempoServices({ loopId: LOOP, storage: fakeStorage(answer) });
      services.afterLeaf(3, async () => REPORT);
      await services.drain();
      const [put] = services.takePuts();
      expect(put, name).to.exist;
      expect(put.statusCode, name).to.equal(statusCode);
      expect(put.ownerBase, name).to.equal(ownerBase);
      expect(put.receipt.error, name).to.be.a("string");
    }
  });
});

// ─── A keyed loop's charge: what would defeat its attribution or its scopes is never signed ──

describe("storage — a keyed loop's charge refuses a gateway memo, splits and another payee", () => {
  const LOOP_ID = "loop-keyed-demo";
  const SPLIT = { amount: "50", recipient: "0x5708000000000000000000000000000000000000" };

  function keyedTransport(g: ReturnType<typeof gateway>, over: { clientId?: string; pin?: readonly string[] } = {}) {
    return new MppChargeTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(1_000),
      currency: USDC_E,
      ...(over.clientId ? { clientId: over.clientId } : {}),
      ...(over.pin ? { expectedRecipients: over.pin } : {}),
      clientFactory: g.factory,
      readReceipt: g.readReceipt,
    });
  }

  async function refusal(t: MppChargeTransport): Promise<unknown> {
    try {
      await t.fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it("refuses a challenge naming its own memo or splits when the charge carries a clientId, before signing", async () => {
    const cases: [string, MppChargeChallenge, RegExp][] = [
      ["memo", challenge("200", { methodDetails: { chainId: 4217, memo: `0x${"ab".repeat(32)}` } }), /memo/],
      ["splits", challenge("200", { methodDetails: { chainId: 4217, splits: [SPLIT] } }), /splits/],
    ];
    for (const [name, quote, reason] of cases) {
      const g = gateway({ quote, reference: "0xnever" });
      const err = await refusal(keyedTransport(g, { clientId: LOOP_ID }));
      expect(err, name).to.be.instanceOf(ChargeRefused);
      expect((err as Error).message, name).to.match(reason);
      expect(g.sent[0].signed, `${name}: no credential was created`).to.equal(false);
    }
    // An empty memo or an empty split list asks nothing of the transfer, and is paid.
    for (const methodDetails of [
      { chainId: 4217, memo: "" },
      { chainId: 4217, splits: [] },
    ]) {
      const g = gateway({ quote: challenge("200", { methodDetails }), reference: "0xok" });
      const res = await keyedTransport(g, { clientId: LOOP_ID }).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
      expect(res.payment?.reference).to.equal("0xok");
    }
  });

  it("pays the same challenges without a clientId exactly as before", async () => {
    for (const methodDetails of [
      { chainId: 4217, memo: `0x${"ab".repeat(32)}` },
      { chainId: 4217, splits: [SPLIT] },
    ]) {
      const g = gateway({ quote: challenge("200", { methodDetails }), reference: "0xplain" });
      const plain = await keyedTransport(g).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
      const h = gateway({ reference: "0xplain" });
      const before = await keyedTransport(h).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
      expect(plain.payment, JSON.stringify(methodDetails)).to.deep.equal(before.payment);
      expect(g.sent[0].signed).to.equal(true);
    }
  });

  it("refuses another payee, as recipient or in a split, when the payee is pinned, before signing", async () => {
    const pin = [RECIPIENT.toUpperCase().replace(/^0X/, "0x")];
    const cases: [string, MppChargeChallenge, RegExp][] = [
      ["recipient", challenge("200", { recipient: "0x5709000000000000000000000000000000000000" }), /0x5709/],
      ["no recipient", challenge("200", { recipient: undefined }), /nobody/],
      ["split", challenge("200", { methodDetails: { chainId: 4217, splits: [SPLIT] } }), /0x5708/],
    ];
    for (const [name, quote, reason] of cases) {
      const g = gateway({ quote, reference: "0xnever" });
      const err = await refusal(keyedTransport(g, { pin }));
      expect(err, name).to.be.instanceOf(ChargeRefused);
      expect((err as Error).message, name).to.match(reason);
      expect(g.sent[0].signed, `${name}: no credential was created`).to.equal(false);
    }
    // The pinned payee, in any case, is paid; and mppx is handed the same allowlist.
    const asked: Parameters<MppChargeClientFactory>[0][] = [];
    const g = gateway({ reference: "0xpinned" });
    const res = await new MppChargeTransport({
      account: { address: PAYER },
      maxCostBase: BigInt(1_000),
      currency: USDC_E,
      expectedRecipients: pin,
      clientFactory: async (o) => {
        asked.push(o);
        return g.factory(o);
      },
      readReceipt: g.readReceipt,
    }).fetch(`${STORAGE}/k`, { method: "PUT", body: "x" });
    expect(res.payment?.reference).to.equal("0xpinned");
    expect(asked[0].expectedRecipients).to.deep.equal(pin);
  });

  it("records a refused attributed charge as an unpaid storage call, charging the owner nothing", async () => {
    const g = gateway({
      quote: challenge("200", { methodDetails: { chainId: 4217, memo: `0x${"cd".repeat(32)}` } }),
      reference: "0xnever",
    });
    const services = new LoopTempoServices({ loopId: LOOP, storage: keyedTransport(g, { clientId: LOOP }) });
    services.afterLeaf(3, async () => REPORT);
    await services.drain();
    const [put] = services.takePuts();
    expect(put.statusCode).to.equal(402);
    expect(put.ownerBase).to.equal(BigInt(0));
    expect(put.receipt.payment).to.equal(undefined);
    expect(put.receipt.error).to.match(/memo/);
    expect(g.sent[0].signed).to.equal(false);
  });
});

// ─── The queue through a loop: the Action, the owner's debit, and the leaf that carries the receipt ──

describe("storage — a loop that publishes its reports", () => {
  it("writes the storage.put Action at the next step's start, debits the owner, and carries the receipt in the next leaf", async () => {
    const services = new LoopTempoServices({ loopId: LOOP, storage: fakeStorage(async () => paid("0xmain")) });
    const events: LoopEvent[] = [];
    const { billing, store, runner } = tempoLoop({ loopId: LOOP, services, report: async () => REPORT, events });

    const first = await runner.step();
    expect(first.leafOk).to.equal(true);
    expect(first.manifest?.tempoHash, "nothing is carried before the first PUT is written").to.equal(undefined);
    await services.drain();
    const chargesBefore = billing.charges.length;

    const second = await runner.step();
    expect(second.leafOk).to.equal(true);
    const storageEvent = events.find((e) => e.type === "storage");
    expect(storageEvent, "one storage.put was written").to.exist;
    expect(storageEvent!.step).to.equal(1);
    // 200 base units with the default 10% margin, rounded up: the formula a model call meets.
    expect(storageEvent!.costMicroUsdc).to.equal("220");
    expect(billing.charges.slice(chargesBefore).map((c) => c.amountMicroUsdc)).to.include("220");
    expect(BigInt(runner.snapshot().spentMicroUsdc!) >= BigInt(220)).to.equal(true);

    // The Action's blobs: `{ service, key }` under args, the report itself under result.
    expect(await store.get(sha256(REPORT.bytes))).to.deep.equal(REPORT.bytes);

    // The leaf of step 2 names the carry, which names the Action and its receipt.
    const manifest = decodeLoopManifest((await store.get(sha256(utf8(JSON.stringify(second.manifest)))))!);
    expect(manifest, "the manifest round-trips with its fifteenth key").to.deep.equal(second.manifest);
    const tempoHash = second.manifest!.tempoHash!;
    expect(tempoHash).to.match(/^[0-9a-f]{64}$/);
    const carry = decodeTempoCarry((await store.get(toBytes32(tempoHash)))!)!;
    expect(carry.storage).to.have.length(1);
    expect(carry.storage![0]).to.include({ ofStep: 1, seq: storageEvent!.seq, statusCode: 200 });
    const receipt = JSON.parse(new TextDecoder().decode((await store.get(toBytes32(carry.storage![0].receiptHash)))!));
    expect(receipt.payment).to.include({ intent: "charge", amount: "200", reference: "0xmain" });
    expect(receipt.key).to.equal(storageKey(LOOP, REPORT_HASH));

    // Carried once: the third step's leaf carries nothing new from step 1.
    await services.drain();
    const third = await runner.step();
    const thirdCarry = third.manifest?.tempoHash
      ? decodeTempoCarry((await store.get(toBytes32(third.manifest.tempoHash)))!)
      : null;
    expect((thirdCarry?.storage ?? []).map((s) => s.ofStep)).to.not.include(1);
  });

  it("records a failed PUT as a failed storage.put, charges nobody, and the loop goes on", async () => {
    const services = new LoopTempoServices({
      loopId: LOOP,
      storage: fakeStorage(async () => Promise.reject(new Error("ECONNRESET"))),
    });
    const events: LoopEvent[] = [];
    const { billing, runner } = tempoLoop({ loopId: LOOP, services, report: async () => REPORT, events });
    await runner.step();
    await services.drain();
    const before = billing.charges.map((c) => c.amountMicroUsdc);
    const second = await runner.step();
    expect(second.leafOk).to.equal(true);
    const failed = events.find((e) => e.type === "storage");
    expect(failed?.error).to.match(/ECONNRESET/);
    expect(failed?.costMicroUsdc).to.equal("0");
    // Only the model calls' charges moved; the failed PUT added none.
    expect(billing.charges.length - before.length).to.equal(1);
    expect(runner.snapshot().status).to.not.equal("stopped");
  });

  describe("on a runtime that does not journal: a storage.put charged through chargeAndLog", () => {
    /**
     * The loop's direct path (no anchor queue), reached by taking the queue off the fixture's runtime:
     * its backend charges a `storage.put` the way a real one does — the debit and the record in one
     * transaction — and its first such charge throws `failure`, after landing when `landed` is set.
     */
    async function directPut(
      failure: string,
      landed: boolean,
      opts: { signature?: string; chargeLanded?: boolean | null | "unknown" } = {}
    ) {
      const services = new LoopTempoServices({ loopId: LOOP, storage: fakeStorage(async () => paid("0xmain")) });
      const events: LoopEvent[] = [];
      const { chain, runtime, runner } = tempoLoop({ loopId: LOOP, services, events });
      await runtime.ensureRegistered();
      const debits: string[] = [];
      // The records this backend wrote, by seq, so the runner can find a landed one by its payload.
      const records = new Map<bigint, { payloadHash: Uint8Array }>();
      (chain as any).getEvent = async (_agent: unknown, seq: bigint) => records.get(BigInt(seq)) ?? null;
      let failed = false;
      const write = async (req: any): Promise<LogResult> => {
        debits.push(req.amountMicroUsdc.toString());
        const logged = await chain.asClient().logEvent(req.agentId, req.payload, { timestamp: req.timestamp });
        records.set(logged.seq, { payloadHash: hashPayload(req.payload) });
        return logged;
      };
      const asked: string[] = [];
      (runtime as any).anchor = undefined;
      (runtime as any).billing = {
        async chargeAndLog(req: any): Promise<LogResult | null> {
          if (!failed) {
            failed = true;
            if (landed) await write(req);
            throw Object.assign(new Error(failure), opts.signature ? { signature: opts.signature } : {});
          }
          return write(req);
        },
        ...(opts.chargeLanded !== undefined
          ? {
              async chargeLanded(sig: string) {
                asked.push(sig);
                return opts.chargeLanded;
              },
            }
          : {}),
      };
      services.afterLeaf(1, async () => REPORT);
      await services.drain();
      const writePuts = () => (runner as any).writeStoragePuts(2) as Promise<void>;
      return { chain, events, debits, writePuts, runner, services, asked, records };
    }

    it("drops a PUT in doubt with no signature to ask about: one debit, one Action, and says so", async () => {
      const { chain, events, debits, writePuts } = await directPut("confirmation timed out", true);
      await writePuts();
      await writePuts();
      expect(debits, "one debit for one PUT, never two").to.deep.equal(["220"]);
      expect(chain.applied, "and one Action on the chain").to.have.length(1);
      const error = events.find((e) => e.type === "error" && /no signature to ask/.test(String(e.error)));
      expect(error, "the operator is told why it is not written again").to.exist;
    });

    it("writes a PUT again whose charge never left the process", async () => {
      const { chain, events, debits, writePuts } = await directPut("failed to get recent blockhash", false);
      await writePuts();
      await writePuts();
      expect(debits).to.deep.equal(["220"]);
      expect(chain.applied).to.have.length(1);
      expect(events.filter((e) => e.type === "storage")).to.have.length(1);
    });

    it("writes a PUT again whose charge the billing program refused, since a refusal moved nothing", async () => {
      const refused =
        "Simulation failed. Error processing Instruction 0: custom program error: 0xbc4. " +
        "Program log: AnchorError caused by account: allowance. Error Code: AccountNotInitialized. Error Number: 3012.";
      const { chain, events, debits, writePuts } = await directPut(refused, false, { signature: "sig-refused" });
      await writePuts();
      expect(
        events.filter((e) => e.type === "storage"),
        "not written while the grant is gone"
      ).to.have.length(0);
      await writePuts();
      expect(debits).to.deep.equal(["220"]);
      expect(chain.applied).to.have.length(1);
      expect(
        events.filter((e) => e.type === "storage"),
        "written at the next quiet point"
      ).to.have.length(1);
    });

    it("counts a parked PUT whose charge landed with its record: spend and carry, no second write", async () => {
      const { chain, events, debits, writePuts, runner, services } = await directPut("confirmation timed out", true, {
        signature: "sig-landed",
        chargeLanded: "unknown",
      });
      const spentBefore = BigInt(runner.snapshot().spentMicroUsdc ?? "0");
      await writePuts();
      expect(
        events.filter((e) => e.type === "storage"),
        "not counted while in doubt"
      ).to.have.length(0);
      await writePuts();
      expect(debits, "one debit").to.deep.equal(["220"]);
      expect(chain.applied, "one Action").to.have.length(1);
      const counted = events.filter((e) => e.type === "storage");
      expect(counted, "found by its record and counted").to.have.length(1);
      expect(counted[0].seq).to.equal(chain.applied[0].seq);
      expect(BigInt(runner.snapshot().spentMicroUsdc ?? "0") - spentBefore).to.equal(BigInt(220));
      expect(services.carry()?.storage?.map((c) => c.seq)).to.deep.equal([chain.applied[0].seq]);
    });

    it("writes a parked PUT again once the cluster has no record of its charge", async () => {
      const { chain, events, debits, writePuts, asked } = await directPut("confirmation timed out", false, {
        signature: "sig-lost",
        chargeLanded: null,
      });
      await writePuts();
      expect(debits, "nothing landed").to.deep.equal([]);
      await writePuts();
      expect(asked).to.deep.equal(["sig-lost"]);
      expect(debits).to.deep.equal(["220"]);
      expect(chain.applied).to.have.length(1);
      expect(events.filter((e) => e.type === "storage")).to.have.length(1);
    });

    it("keeps a parked PUT parked while nothing can say whether it landed", async () => {
      const { chain, events, debits, writePuts } = await directPut("confirmation timed out", false, {
        signature: "sig-unknown",
        chargeLanded: "unknown",
      });
      await writePuts();
      await writePuts();
      await writePuts();
      expect(debits, "never sent again").to.deep.equal([]);
      expect(chain.applied).to.have.length(0);
      expect(events.filter((e) => e.type === "storage")).to.have.length(0);
    });
  });

  it("builds nothing without services: the manifest is the one it always was", async () => {
    const { runner } = tempoLoop({ loopId: LOOP });
    const first = await runner.step();
    const second = await runner.step();
    expect(first.manifest).to.not.have.property("tempoHash");
    expect(second.manifest).to.not.have.property("tempoHash");
    expect(STORAGE_PUT_TOOL).to.equal("storage.put");
  });
});

// ─── The report a step wrote, read back from its replay record ──────────────────────────────

describe("storage — which file is a step's report", () => {
  function file(path: string, text: string): WorkspaceEntry & { bytes: Uint8Array } {
    const bytes = utf8(text);
    return { kind: "file", path, size: bytes.length, sha256: hex(sha256(bytes)), bytes };
  }
  async function stepWith(
    store: MemoryTraceStore,
    before: WorkspaceEntry[] | null,
    after: WorkspaceEntry[],
    fold = false
  ) {
    for (const e of after) if ("bytes" in e) await store.put((e as any).bytes);
    const afterHash = hex(await store.put(treeBytes(after)));
    const beforeHash = before ? hex(await store.put(treeBytes(before))) : EMPTY_WORKSPACE_HASH;
    const record = { v: 1, workspaceBefore: beforeHash, workspaceAfter: afterHash };
    const bytes = utf8(
      JSON.stringify(
        fold
          ? [
              { ...record, workspaceAfter: beforeHash },
              { ...record, workspaceBefore: beforeHash },
            ]
          : record
      )
    );
    return hex(await store.put(bytes));
  }
  const dir = (path: string): WorkspaceEntry => ({ kind: "dir", path });

  it("is the file the step wrote under report/", async () => {
    const store = new MemoryTraceStore();
    const report = file("report/authority.md", "# v1\n");
    const replay = await stepWith(store, null, [dir("notes"), file("notes/a.txt", "scratch"), dir("report"), report]);
    const got = await stepReportFile(store, replay);
    expect(got?.path).to.equal("report/authority.md");
    expect(got?.bytes).to.deep.equal(report.bytes);
  });

  it("is nothing when the step left the report as it found it, and the new bytes when it changed it", async () => {
    const store = new MemoryTraceStore();
    const v1 = file("report/authority.md", "# v1\n");
    const unchanged = await stepWith(store, [dir("report"), v1], [dir("report"), v1, file("scratch.txt", "x")]);
    expect(await stepReportFile(store, unchanged)).to.equal(null);
    const v2 = file("report/authority.md", "# v2\n");
    const changed = await stepWith(store, [dir("report"), v1], [dir("report"), v2]);
    expect((await stepReportFile(store, changed))?.bytes).to.deep.equal(v2.bytes);
  });

  it("spans a synthesis fold from its first record's before to its last record's after", async () => {
    const store = new MemoryTraceStore();
    const report = file("report/authority.md", "# folded\n");
    const replay = await stepWith(store, [], [dir("report"), report], true);
    expect((await stepReportFile(store, replay))?.path).to.equal("report/authority.md");
    expect(await stepReportFile(store, undefined)).to.equal(null);
  });
});

// ─── The drain a stop waits for ───────────────────────────────────────────────────────────────

describe("storage — drain on stop", () => {
  /** A paid RPC session stub: answers by method, and says where the close transaction landed. */
  function rpcStub() {
    const calls: string[] = [];
    let cumulative = 0;
    const rpc = {
      calls,
      closes: 0,
      opened: false,
      get channelId() {
        return rpc.opened ? "0xrpc" : undefined;
      },
      get cumulative() {
        return rpc.opened ? String(cumulative) : undefined;
      },
      async open() {
        await rpc.call("eth_chainId");
      },
      async call(method: string, params: unknown[] = []) {
        calls.push(method);
        rpc.opened = true;
        cumulative += 1_000;
        if (method === "eth_chainId") return "0x1079";
        if (method === "eth_blockNumber") return "0x64";
        if (method === "eth_call") return "0x" + BigInt(9_000_000).toString(16).padStart(64, "0");
        if (method === "eth_getTransactionReceipt") return params[0] === "0xsettled" ? { blockNumber: "0x65" } : null;
        throw new Error(`unexpected ${method}`);
      },
      async close() {
        rpc.closes += 1;
        return { txHash: "0xrpcclose", spent: String(cumulative) };
      },
    };
    return rpc;
  }

  function modelChannel() {
    const c = {
      payer: PAYER,
      channelId: "0x7f3c",
      opened: true,
      closes: 0,
      async close() {
        c.closes += 1;
        return { txHash: "0xsettled", spent: "1650" };
      },
    };
    return c;
  }

  it("waits for the PUT and the reads in flight, writes the Action before the stop record, and closes both channels", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rpc = rpcStub();
    const services = new LoopTempoServices({
      loopId: LOOP,
      storage: fakeStorage(async () => {
        await gate;
        return paid("0xmain");
      }),
      rpc,
      treasury: PAYER,
      channel: () => ({ id: "0x7f3c", cumulative: "1650" }),
      readChannel: async () => ({ deposit: BigInt(100_000), settled: BigInt(0) }),
      sleep: async () => undefined,
    });
    const tempo = modelChannel();
    const events: LoopEvent[] = [];
    const { runner, store } = tempoLoop({ loopId: LOOP, services, report: async () => REPORT, events, tempo });

    await runner.step();
    runner.stop("goal-reached", "Jev judged the goal achieved at step 1");
    const settling = runner.settle();
    // The PUT is still held: the stop must not have closed anything yet.
    await new Promise((r) => setTimeout(r, 5));
    expect(tempo.closes, "the model channel waits for the drain").to.equal(0);
    expect(rpc.closes).to.equal(0);
    release();
    const settlement = await settling;

    expect(tempo.closes).to.equal(1);
    expect(rpc.closes).to.equal(1);
    const storageAt = events.findIndex((e) => e.type === "storage");
    const settledAt = events.findIndex((e) => e.type === "settlement");
    expect(storageAt, "the storage.put was written").to.be.greaterThan(-1);
    expect(storageAt, "before the stop record").to.be.lessThan(settledAt);
    expect(Number(events[settledAt].seq)).to.be.greaterThan(Number(events[storageAt].seq));

    const stop = settlement!.services!;
    expect(stop.closeBlock, "the close settlement's block, read over the paid RPC").to.equal("101");
    expect(stop.rpc).to.deep.include({ channelId: "0xrpc", closed: true, txHash: "0xrpcclose" });
    expect(stop.storage?.map((s) => s.ofStep)).to.deep.equal([1]);
    expect(stop.storage?.[0].seq).to.equal(events[storageAt].seq);
    expect(stop.snapshots?.map((s) => s.ofStep)).to.deep.equal([1]);
    expect(stop.lastSnapshot).to.deep.include({ ofStep: 1, block: "100" });
    expect(rpc.calls.indexOf("eth_getTransactionReceipt"), "read before the RPC channel closed").to.be.greaterThan(-1);

    // The stop record's result blob is the settlement, services and all.
    const blob = await store.get(sha256(utf8(JSON.stringify(sortKeys(settlement)))));
    expect(blob, "the record hashes the settlement with its services").to.not.equal(null);
  });

  it("closes the model channel past the stop's bound, and still writes a late PUT's Action before the stop record", async () => {
    // A storage gateway that stalls must not hold the stop in `drain()` before the model channel
    // closes, or the loop's remaining deposit stays in escrow for as long as the PUT hangs.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rpc = rpcStub();
    const services = new LoopTempoServices({
      loopId: LOOP,
      storage: fakeStorage(async () => {
        await gate;
        return paid("0xlate");
      }),
      rpc,
      treasury: PAYER,
      channel: () => ({ id: "0x7f3c", cumulative: "1650" }),
      readChannel: async () => ({ deposit: BigInt(100_000), settled: BigInt(0) }),
      sleep: async () => undefined,
      stopDrainMs: 20,
    });
    expect(new LoopTempoServices({ loopId: LOOP }).stopDrainMs, "the shipped bound").to.equal(TEMPO_STOP_DRAIN_MS);
    const tempo = modelChannel();
    const events: LoopEvent[] = [];
    const { runner } = tempoLoop({ loopId: LOOP, services, report: async () => REPORT, events, tempo });

    await runner.step();
    runner.stop("goal-reached", "Jev judged the goal achieved at step 1");
    const settling = runner.settle();
    await new Promise((r) => setTimeout(r, 80));
    expect(tempo.closes, "the model channel closed while the PUT still hangs").to.equal(1);
    expect(rpc.closes, "the RPC channel waits for the PUT, as its close always has").to.equal(0);
    expect(events.some((e) => e.type === "settlement")).to.equal(false);
    release();
    const settlement = await settling;

    expect(rpc.closes).to.equal(1);
    const storageAt = events.findIndex((e) => e.type === "storage");
    const settledAt = events.findIndex((e) => e.type === "settlement");
    expect(storageAt, "the late PUT's storage.put was written").to.be.greaterThan(-1);
    expect(storageAt, "before the stop record").to.be.lessThan(settledAt);
    expect(settlement!.closed).to.equal(true);
    expect(settlement!.services!.storage?.map((s) => s.seq)).to.deep.equal([events[storageAt].seq]);
  });

  it("settles as before on a loop with no services", async () => {
    const tempo = modelChannel();
    const { runner } = tempoLoop({ loopId: LOOP, tempo });
    await runner.step();
    const settlement = await runner.settle();
    expect(tempo.closes).to.equal(1);
    expect(settlement).to.not.have.property("services");
  });
});

/** `canonicalJson`'s key order, for finding the settlement blob by its hash. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}
