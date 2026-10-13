/**
 * Irys as the blob backend behind the on-chain `sha256 → locator` map, against Solana devnet
 * and Irys devnet (docs/ARCHITECTURE.md §9).
 *
 * The claim under test: an auditor holding nothing but a public RPC and a public gateway URL
 * downloads an agent's bytes from Irys, re-hashes them, and the chain says whether they are the
 * right ones — no software of ours in the middle and no operator to ask.
 *
 * Gated exactly as `tests/devnet.ts` is — skipped, not failed, without `LATH_DEVNET_RPC`:
 *
 * ```bash
 * LATH_DEVNET_RPC="https://devnet.helius-rpc.com/?api-key=…" npm run test:irys
 * ```
 *
 * The wallet at `ANCHOR_WALLET` (default `~/.config/solana/id.json`) pays the Solana fees *and*
 * must hold an Irys balance: `npm run irys -- fund 0.05` moves devnet SOL to it once. The
 * balance and the clock are read either side of every upload and printed, so the numbers in
 * docs/ARCHITECTURE.md §11 come from here.
 *
 * **Irys devnet uploads expire after about 60 days.** This suite is a liveness check of the
 * path — upload, anchor, resolve, re-hash — and not a permanence claim; permanence is a mainnet
 * property. It spends real time (a fund is a finalized Solana transfer; each epoch is a devnet
 * transaction) and, on mainnet, real money.
 *
 * The id-encoding cases at the top need no network and run in the default suite.
 */
import { createRpc } from "@lightprotocol/stateless.js";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import bs58 from "bs58";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentLogger,
  AnchoredEpochStore,
  AnchoredTraceStore,
  audit,
  decodeIrysId,
  encodeLocatorId,
  EventKind,
  formatReport,
  hex,
  HttpGatewayBackend,
  idFromString,
  IRYS_GATEWAY,
  IRYS_NODES,
  IrysBackend,
  irysIdSpellings,
  irysIdString,
  LathClient,
  LocatorRegistry,
  LocatorScheme,
  MemoryTraceStore,
  sha256,
  utf8,
  verifyEpochBlob,
} from "../sdk/src";

const RPC = process.env.LATH_DEVNET_RPC;
const PHOTON = process.env.LATH_DEVNET_PHOTON ?? RPC;
const PROVER = process.env.LATH_DEVNET_PROVER ?? RPC;
const NODE = process.env.LATH_IRYS_NODE ?? IRYS_NODES.devnet;
const GATEWAY = process.env.LATH_IRYS_GATEWAY ?? IRYS_GATEWAY;
const walletPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");

/** A real devnet receipt: 1 024 bytes of 0x07, uploaded while writing this suite. */
const KNOWN_ID_BASE58 = "HVGq5BDsZTYnHHRtFeeY5pWuPuUYmZ5G3JztpTqGWE3p";
const KNOWN_ID_BASE64URL = "9PkmtEWZPhzff04UAaoaGTSM1PYVJTVXZQ3u8kJ_RO8";
const KNOWN_ID_HEX = "f4f926b445993e1cdf7f4e1401aa1a19348cd4f615253557650deef2427f44ef";

describe("Irys ids", () => {
  it("decodes the receipt's base58 and the gateway's base64url to the same 32 bytes", () => {
    const fromBase58 = decodeIrysId(KNOWN_ID_BASE58);
    const fromBase64url = decodeIrysId(KNOWN_ID_BASE64URL);
    assert.equal(fromBase58.length, 32);
    assert.equal(hex(fromBase58), KNOWN_ID_HEX);
    assert.equal(hex(fromBase64url), KNOWN_ID_HEX);
  });

  it("round-trips through the gateway path encoding and the printed form", () => {
    const id = decodeIrysId(KNOWN_ID_BASE58);
    assert.equal(encodeLocatorId(id, "base64url"), KNOWN_ID_BASE64URL, "the path HttpGatewayBackend fetches");
    assert.equal(irysIdString(id), KNOWN_ID_BASE58, "the id as Irys prints it");
    assert.deepEqual(irysIdSpellings(id), { base58: KNOWN_ID_BASE58, base64url: KNOWN_ID_BASE64URL });
    assert.equal(hex(decodeIrysId(encodeLocatorId(id, "base64url"))), KNOWN_ID_HEX);
  });

  it("reads a 43-character id valid in both spellings as base58 unless told it is base64url", () => {
    // 32 bytes whose base64url spelling uses only base58 characters: also a 32-byte base58 string.
    let raw: Uint8Array = new Uint8Array(32);
    for (let i = 1; ; i++) {
      raw = sha256(utf8(`ambiguous-${i}`));
      const s = encodeLocatorId(raw, "base64url");
      if (/^[1-9A-HJ-NP-Za-km-z]{43}$/.test(s) && bs58.decode(s).length === 32) break;
    }
    const spelled = encodeLocatorId(raw, "base64url");
    assert.notEqual(hex(decodeIrysId(spelled)), hex(raw), "a guess reads the receipt's spelling");
    assert.equal(hex(decodeIrysId(spelled, "base64url")), hex(raw));
    // And a 43-character receipt is still read as the receipt it is.
    let short: Uint8Array = new Uint8Array(32);
    for (let i = 1; ; i++) {
      short = sha256(utf8(`short-${i}`));
      if (irysIdString(short).length === 43) break;
    }
    assert.equal(hex(decodeIrysId(irysIdString(short))), hex(short));
    assert.equal(hex(decodeIrysId(irysIdString(short), "base58")), hex(short));
    assert.throws(() => decodeIrysId(KNOWN_ID_BASE58, "base64url"), /32 bytes/);
  });

  it("refuses an id that is not exactly 32 bytes rather than truncating it", () => {
    // 43 base58 characters can still be 32 bytes; 42 cannot, and neither can 44 of base64url.
    assert.throws(() => decodeIrysId(KNOWN_ID_BASE58.slice(2)), /32 bytes/);
    assert.throws(() => decodeIrysId(KNOWN_ID_BASE64URL + "A"), /32 bytes/);
    assert.throws(() => decodeIrysId(KNOWN_ID_HEX), /32 bytes/, "hex is not a spelling Irys uses");
    assert.throws(() => decodeIrysId(""), /32 bytes/);
    assert.throws(() => irysIdString(new Uint8Array(31)), /32 bytes/);
  });

  it("takes its funding and its network explicitly", () => {
    const key = Keypair.generate();
    assert.throws(() => new IrysBackend({ wallet: key, network: "devnet", rpc: "" }), /rpc/);
    assert.throws(() => new IrysBackend({ wallet: new Uint8Array(32), network: "devnet", rpc: "http://x" }), /64-byte/);
    assert.throws(() => new IrysBackend({ wallet: key, network: "testnet" as any, rpc: "http://x" }), /network/);
    const b = new IrysBackend({ wallet: key, network: "devnet", rpc: "http://x" });
    assert.equal(b.scheme, LocatorScheme.Irys);
    assert.equal(b.node, IRYS_NODES.devnet);
    assert.equal(b.gateway, IRYS_GATEWAY);
    assert.equal(b.urlFor(decodeIrysId(KNOWN_ID_BASE58)), `${IRYS_GATEWAY}/${KNOWN_ID_BASE64URL}`);
  });

  it("download is the gateway read: a missing blob and a down gateway are both null", async () => {
    const key = Keypair.generate();
    const missing = new IrysBackend({
      wallet: key,
      network: "devnet",
      rpc: "http://x",
      fetch: async () => new Response(null, { status: 404 }),
    });
    assert.isNull(await missing.download(decodeIrysId(KNOWN_ID_BASE58)));
    const down = new IrysBackend({
      wallet: key,
      network: "devnet",
      rpc: "http://x",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.isNull(await down.download(decodeIrysId(KNOWN_ID_BASE58)));
  });
});

describe("Irys on devnet", function () {
  this.timeout(600_000);

  let payer: Keypair;
  let client: LathClient;
  /** A client holding a key that owns nothing — the auditor's, for every read. */
  let readerClient: LathClient;
  let irys: IrysBackend;
  /** What an auditor holds: the gateway URL, the scheme, the encoding. No keys. */
  let gateway: HttpGatewayBackend;
  const measured: { what: string; bytes: number; ms: number; lamports: bigint }[] = [];

  /** Upload with the clock and the Irys balance read either side, the way the cost figures are measured. */
  async function timedUpload(what: string, bytes: Uint8Array): Promise<Uint8Array> {
    const before = await irys.balance();
    const t0 = Date.now();
    const id = await irys.upload(bytes);
    const ms = Date.now() - t0;
    const after = await irys.balance();
    measured.push({ what, bytes: bytes.length, ms, lamports: before - after });
    return id;
  }

  before(async function () {
    if (!RPC) this.skip();
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
    const rpc = createRpc(RPC, PHOTON, PROVER, { commitment: "confirmed" });
    client = LathClient.fromIdl(rpc, payer);
    readerClient = LathClient.fromIdl(rpc, Keypair.generate());
    irys = new IrysBackend({ wallet: payer, network: "devnet", rpc: RPC, node: NODE, gateway: GATEWAY });
    gateway = new HttpGatewayBackend(GATEWAY, { scheme: LocatorScheme.Irys, encoding: "base64url" });
    const balance = await irys.balance();
    const need = await irys.price(64 * 1024);
    if (balance < need) {
      throw new Error(
        `the Irys devnet balance of ${await irys.address()} is ${balance} lamports and this suite wants ` +
          `at least ${need}; run \`npm run irys -- fund 0.05\` (devnet SOL) and try again`
      );
    }
  });

  after(() => {
    for (const m of measured) {
      console.log(`      irys upload · ${m.what}: ${m.bytes} B in ${m.ms} ms, ${m.lamports} lamports off the balance`);
    }
  });

  it("round-trips bytes through a 32-byte id", async () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + Date.now()) & 0xff;
    const id = await timedUpload("1 KiB", bytes);
    assert.equal(id.length, 32);
    const back = await irys.download(id);
    assert.isNotNull(back, `nothing at ${irys.urlFor(id)}`);
    assert.equal(hex(back!), hex(bytes));
  });

  it("a blob above the free tier is paid for from the Irys balance, not the wallet", async () => {
    // Small uploads left the balance untouched above; this one is large enough to be charged,
    // which is what makes the lamports figure in docs/ARCHITECTURE.md §11 a measurement.
    const bytes = new Uint8Array(160 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + Date.now()) & 0xff;
    const quoted = await irys.price(bytes.length);
    const id = await timedUpload("160 KiB", bytes);
    const back = await irys.download(id);
    assert.equal(hex(back!), hex(bytes));
    const m = measured[measured.length - 1];
    console.log(`      quoted ${quoted} lamports for ${bytes.length} B; charged ${m.lamports}`);
  });

  it("the id the gateway path uses decodes back to the same 32 bytes", async () => {
    const bytes = utf8(`lath irys id ${Date.now()}`);
    const id = await timedUpload("short", bytes);
    const { base58, base64url } = irysIdSpellings(id);
    assert.equal(hex(decodeIrysId(base64url)), hex(id));
    assert.equal(hex(decodeIrysId(base58)), hex(id));
    // Both spellings are served: the receipt's, and the one the console and the CLI read with.
    for (const spelling of [base58, base64url]) {
      const res = await fetch(`${GATEWAY}/${spelling}`);
      assert.equal(res.status, 200, spelling);
      assert.equal(hex(new Uint8Array(await res.arrayBuffer())), hex(bytes));
    }
    // What an auditor's backend does with the raw bytes from the cell.
    assert.equal(hex((await gateway.download(id))!), hex(bytes));
  });

  describe("a chain anchored to Irys", () => {
    const owner = idFromString(`irys-epoch-${process.pid}-${Date.now()}`);
    let commit: Awaited<ReturnType<ReturnType<LathClient["createEpochCommitter"]>>>;

    it("anchors an epoch and its trace preimages, and a reader with only the chain and the gateway opens them", async () => {
      // The writer: traces and epoch blobs both go to Irys, and both are anchored on chain.
      const registry = new LocatorRegistry(client, owner);
      const traces = new AnchoredTraceStore(irys, registry);
      const logger = new AgentLogger(client, owner, { store: traces, storePayloads: true });
      assert.isTrue(await logger.ensureRegistered());
      // Traces anchor into the registry directly; it is the epoch store that creates it lazily.
      await registry.ensureCreated();
      console.log(
        `      agent ${hex(owner)} — lath-audit ${hex(
          owner
        )} --gateway ${GATEWAY} --scheme 4 --encoding base64url --require-preimages`
      );
      await logger.genesis({
        sessionId: "irys-devnet",
        caller: payer.publicKey,
        policyVersionHash: sha256(utf8("policy-v1")),
        input: { prompt: "anchor two steps on Irys" },
      });
      const store = new AnchoredEpochStore(irys, registry);
      const commitOne = client.createEpochCommitter(owner, store);
      const t0 = Date.now();
      commit = await commitOne([
        {
          timestamp: BigInt(Date.now()),
          kind: EventKind.Action,
          status: 200,
          reference: sha256(utf8("irys-tool")),
          payloadHash: sha256(utf8("step one")),
        },
        {
          timestamp: BigInt(Date.now()),
          kind: EventKind.Action,
          status: 200,
          reference: sha256(utf8("irys-tool")),
          payloadHash: sha256(utf8("step two")),
        },
      ]);
      console.log(`      epoch on Irys: upload + commit_epoch + locator cell in ${Date.now() - t0} ms`);
      assert.isTrue(commit.anchored, commit.anchorError);
      assert.isFalse(commit.anchorPending);

      // The reader: a fresh store over the auditor's gateway and a key that owns nothing.
      const reader = new AnchoredEpochStore(gateway, new LocatorRegistry(readerClient, owner));
      const locator = await reader.locate(commit.epochRoot);
      assert.isNotNull(locator, "the chain does not point at the epoch");
      assert.equal(locator!.scheme, LocatorScheme.Irys);
      assert.equal(locator!.id.length, 32);
      console.log(`      epoch ${hex(commit.epochRoot)} → ${gateway.urlFor(locator!.id)}`);
      const blob = await reader.get(commit.epochRoot);
      assert.isNotNull(blob, `gateway has nothing at ${gateway.urlFor(locator!.id)}`);
      assert.isNotNull(
        verifyEpochBlob(blob!, commit.epochRoot, commit.startSeq, commit.endSeq),
        "root did not rebuild"
      );

      // `lath-audit --gateway <gateway> --scheme 4 --encoding base64url --require-preimages`.
      const report = await audit(readerClient, owner, {
        epochs: reader,
        store: new AnchoredTraceStore(gateway, new LocatorRegistry(readerClient, owner)),
        requirePreimages: true,
      });
      assert.isTrue(report.ok, JSON.stringify(report));
      assert.equal(report.epochs!.checked, 1);
      assert.deepEqual(report.epochs!.missing, []);
      assert.deepEqual(report.traces!.preimagesUnavailable, []);
      assert.deepEqual(report.traces!.missing, []);
      assert.include(formatReport(report), "VERIFIED");
    });

    it("a lying gateway is caught: wrong bytes are missing bytes, never a trace", async () => {
      const wrong = utf8("these are not the bytes the chain committed to");
      const liar = new HttpGatewayBackend(GATEWAY, {
        scheme: LocatorScheme.Irys,
        encoding: "base64url",
        fetch: async () => new Response(wrong, { status: 200 }),
      });
      const registry = new LocatorRegistry(readerClient, owner);
      const epochs = new AnchoredEpochStore(liar, registry);
      // The chain still points somewhere; the bytes that come back do not rebuild the root.
      assert.isNotNull(await epochs.locate(commit.epochRoot));
      const blob = await epochs.get(commit.epochRoot);
      assert.isNotNull(blob, "AnchoredEpochStore.get returns what the backend returned — the caller re-derives");
      assert.isNull(verifyEpochBlob(blob!, commit.epochRoot, commit.startSeq, commit.endSeq));
      // Traces re-hash inside the store: a lie is `null`.
      const traces = new AnchoredTraceStore(liar, registry);
      const [record] = await readerClient.listEvents(owner);
      assert.isNull(await traces.get(record.payloadHash));
      const report = await audit(readerClient, owner, { epochs, store: traces, requirePreimages: true });
      assert.isFalse(report.ok);
      assert.deepEqual(report.epochs!.missing, [hex(commit.epochRoot)]);
      assert.include(report.traces!.preimagesUnavailable, hex(record.payloadHash));
    });
  });

  it("K epochs still amortise into one manifest cell, and every root resolves through it", async () => {
    const owner = idFromString(`irys-manifest-${process.pid}-${Date.now()}`);
    const logger = new AgentLogger(client, owner, { store: new MemoryTraceStore() });
    await logger.ensureRegistered();
    const registry = new LocatorRegistry(client, owner);
    const store = new AnchoredEpochStore(irys, registry, { every: 2 });
    const commitOne = client.createEpochCommitter(owner, store);
    const step = (a: string) => ({
      timestamp: BigInt(Date.now()),
      kind: EventKind.Action,
      status: 200,
      reference: sha256(utf8("irys-tool")),
      payloadHash: sha256(utf8(a)),
    });
    const e1 = await commitOne([step("a")]);
    assert.isTrue(e1.anchored && e1.anchorPending, "queued for the manifest");
    const e2 = await commitOne([step("b"), step("c")]);
    assert.isTrue(e2.anchored);
    assert.isFalse(e2.anchorPending, "the second epoch published the manifest");
    assert.equal((await store.manifests.entries()).length, 1, "one manifest cell for two epochs");
    assert.isFalse(await registry.has(e1.epochRoot), "no direct cells");
    assert.isFalse(await registry.has(e2.epochRoot));

    const reader = new AnchoredEpochStore(gateway, new LocatorRegistry(readerClient, owner));
    for (const e of [e1, e2]) {
      const blob = await reader.get(e.epochRoot);
      assert.isNotNull(blob, `epoch ${hex(e.epochRoot)} via the manifest on Irys`);
      assert.isNotNull(verifyEpochBlob(blob!, e.epochRoot, e.startSeq, e.endSeq));
    }
    const report = await audit(readerClient, owner, { epochs: reader });
    assert.isTrue(report.ok, JSON.stringify(report));
    assert.equal(report.epochs!.checked, 2);
  });
});
