/**
 * Which gateway a reader asks for a blob, and what it says when none of them
 * can answer.
 *
 * The chain carries a scheme tag and never a url (SPEC §14.1), so one chain can hold Raw
 * locators written before its console moved to Irys and scheme-4 ones written after, and the
 * reader has to choose per locator. `routeLocatorRead` is that choice on its own — no backends,
 * no environment, no network — and it is what `frontend/src/lib/traces.ts` `planByHash` and
 * `lath-audit` both go through. Three of its outcomes are each a different sentence on
 * screen and are worth pinning:
 *
 * 1. a scheme-4 locator resolves at `https://gateway.irys.xyz` with nothing configured;
 * 2. a scheme-0 locator on a reader with no raw gateway is `unavailable` — the chain does vouch
 *    for those bytes, this reader just cannot fetch them — and never `not-anchored`;
 * 3. a hash the chain never mapped is `not-anchored`, and Irys is not asked, because an Irys id
 *    is Irys's own and no hash predicts one.
 *
 * The console's own wiring of this — which reader, which url — is checked by the frontend
 * typecheck and by `frontend/e2e/verify-links.spec.ts`; it cannot be imported here, because the
 * root tsconfig compiles without the DOM lib.
 */
import { assert } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  BundleIndex,
  bundleKey,
  encodeBundle,
  encodeLocatorId,
  GATEWAY_READ_TIMEOUT_MS,
  hex,
  HttpGatewayBackend,
  indexBundle,
  IRYS_ENCODING,
  IRYS_GATEWAY,
  LocatorScheme,
  MemoryBackend,
  ResolvedLocator,
  routeLocatorRead,
  sha256,
  WebEncryptedTraceStore,
} from "@lath/sdk";
import { sealTrace, traceKey } from "./fixtures/sealed-traces";
import { blobCheckCommand } from "../frontend/src/lib/check-commands";
import { TraceQueryScope, tracePartQueryKey, traceQueryKey } from "../frontend/src/lib/trace-keys";

/** What a browser with no trace-gateway environment holds: the Irys reader and nothing else. */
const IRYS_ONLY = [LocatorScheme.Irys];
/** What a development console holds: a raw gateway it writes through, plus the Irys default. */
const BOTH = [LocatorScheme.Irys, LocatorScheme.Raw];

describe("trace routing", () => {
  const id = sha256(new TextEncoder().encode("an irys transaction id")); // 32 bytes, as a real one is
  const hash = sha256(new TextEncoder().encode('{"prompt":"anchored"}'));

  it("sends a scheme-4 locator to the Irys gateway, with nothing configured", () => {
    const route = routeLocatorRead(IRYS_ONLY, LocatorScheme.Irys);
    assert.deepEqual(route, { via: "locator", scheme: LocatorScheme.Irys });

    // The url that follows from it — the one the console prints and an auditor pastes into curl.
    const reader = new HttpGatewayBackend(IRYS_GATEWAY, { scheme: LocatorScheme.Irys, encoding: IRYS_ENCODING });
    assert.equal(reader.urlFor(id), `https://gateway.irys.xyz/${encodeLocatorId(id, "base64url")}`);
    assert.match(reader.urlFor(id), /^https:\/\/gateway\.irys\.xyz\/[A-Za-z0-9_-]{43}$/);
  });

  it("calls a scheme-0 locator unavailable when there is no raw gateway, never not-anchored", () => {
    const route = routeLocatorRead(IRYS_ONLY, LocatorScheme.Raw);
    // `not-anchored` would be a claim about the chain, and the chain did anchor this one: the
    // locator stays on screen so a reader can fetch it somewhere this deployment cannot.
    assert.deepEqual(route, { via: "none", status: "unavailable" });
  });

  it("reads a scheme-0 locator through the raw gateway where one is configured", () => {
    assert.deepEqual(routeLocatorRead(BOTH, LocatorScheme.Raw), { via: "locator", scheme: LocatorScheme.Raw });
    const reader = new HttpGatewayBackend("https://blobs.example/traces", { scheme: LocatorScheme.Raw });
    assert.equal(reader.urlFor(hash), `https://blobs.example/traces/${hex(hash)}`);
  });

  it("asks by hash only where a content-addressed gateway is configured", () => {
    // A raw store names a file by its sha256, so an unanchored hash is worth a request.
    assert.deepEqual(routeLocatorRead(BOTH, null), { via: "hash" });
    // With only Irys there is nothing to ask for: no hash predicts an Irys id.
    assert.deepEqual(routeLocatorRead(IRYS_ONLY, null), { via: "none", status: "not-anchored" });
  });

  it("has no gateway for a tag nobody assigned", () => {
    // Unassigned rather than reserved (SPEC §14.1): a reader that meets one says so and stops.
    assert.deepEqual(routeLocatorRead(BOTH, 7), { via: "none", status: "unavailable" });
  });

  it("carries the bundle's own cell on a hit answered out of a session bundle", async () => {
    // On a bundle-sealing console every record payload reads this way: the registry holds no
    // cell for the payload hash, only for the bundle it is inside. Reaching that branch with
    // nothing to show, the console's `planByHash` would have the panel print "no gateway
    // configured" for a case where no gateway was ever wanted. What the index has to
    // keep, then, is the cell that named the bundle — the one thing the chain does say about
    // these bytes — so the panel can hand a reader the bundle's url and the entry to pull out.
    const genesis = sha256(new TextEncoder().encode("a genesis payload"));
    const entry = new TextEncoder().encode('{"tool":"solana.slot","args":{}}');
    const bundle = encodeBundle([entry]);
    const found = {
      hash: bundleKey(genesis),
      locator: { scheme: LocatorScheme.Irys, id },
      version: 0n,
      publishedAt: 0n,
      cell: { address: "the bundle's cell" },
    } as unknown as ResolvedLocator;

    const index = new BundleIndex();
    assert.isNull(index.sourceOf(sha256(entry)), "nothing opened, nothing to name");
    assert.equal(await index.open(genesis, async () => ({ bytes: bundle, found })), 1);

    const source = index.sourceOf(sha256(entry));
    assert.isNotNull(source);
    assert.equal(hex(source!.key), hex(bundleKey(genesis)), "the derived key, not something looked up");
    assert.strictEqual(source!.found, found, "the very cell the registry answered with");
    assert.equal(source!.found.locator.scheme, LocatorScheme.Irys);
    // And it is the bundle's url the reader is sent to, not one built from the entry's hash.
    const reader = new HttpGatewayBackend(IRYS_GATEWAY, { scheme: LocatorScheme.Irys, encoding: IRYS_ENCODING });
    assert.equal(reader.urlFor(source!.found.locator.id), `${IRYS_GATEWAY}/${encodeLocatorId(id, "base64url")}`);
    assert.isNull(index.sourceOf(sha256(new TextEncoder().encode("never bundled"))));
  });
});

/**
 * The verify block's command, run for real: a command that is only ever read is a command
 * nobody has checked. The console writes every trace in the clear, so the page prints the
 * plaintext check alone, and `lath-audit --trace-key` is the check for a chain written encrypted.
 * `check-commands.ts` imports nothing so it can be loaded here; the curl line is dropped (no
 * network).
 */
describe("offline check commands", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const plaintext = utf8('{"prompt":"a trace written in the clear"}');
  let dir: string;
  let digest: string;

  function run(command: string) {
    const script = command
      .split("\n")
      .filter((l) => !l.startsWith("curl "))
      .join("\n");
    const out = spawnSync("sh", ["-c", script], { cwd: dir, encoding: "utf8" });
    return { out: `${out.stdout}${out.stderr}`.trim(), status: out.status };
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-check-"));
    // A sealed ciphertext of the same bytes (this build writes none).
    const { hash, blob: stored } = sealTrace(traceKey(), plaintext);
    digest = hex(hash);
    fs.writeFileSync(path.join(dir, "trace.bin"), stored);
    fs.writeFileSync(path.join(dir, "plain.bin"), plaintext);
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("hashes a plaintext download to the chain's digest, and a sealed ciphertext to something else", () => {
    const onPlaintext = run(blobCheckCommand("u", digest, "plain.bin")).out;
    assert.include(onPlaintext.split("\n")[0], digest);
    // Which is why the plaintext check is no check for a sealed trace: the
    // ciphertext hashes to nothing the chain holds.
    const onCiphertext = run(blobCheckCommand("u", digest, "trace.bin")).out;
    assert.notInclude(onCiphertext.split("\n")[0], digest);
  });
});

/**
 * The SDK half of a reader's key-refused answer (`lath-audit --trace-key` opens sealed bundles).
 * A bundle keys an LTE2 entry by the hash its header claims, so the lookup can find ciphertext
 * that was sealed under another key — a re-encrypted slot, or a forged header. What the reader's
 * key does with it: it does not open, and the reader must be told that rather than "unlock to read".
 */
describe("a bundle entry sealed under another key", () => {
  it("is found by the hash its header names, and does not open with this page's key", async () => {
    const plaintext = new TextEncoder().encode('{"memory":"step 3"}');
    const keyA = traceKey();
    const keyB = traceKey();
    // Sealed under key A as a chain written encrypted holds it (`tests/fixtures/sealed-traces.ts`).
    const { hash, blob: stored } = sealTrace(keyA, plaintext);

    const index = indexBundle(encodeBundle([stored]));
    const entry = index.get(hex(hash));
    assert.isDefined(entry, "the header's hash wins the lookup");

    const one = new MemoryBackend();
    await one.set(hex(hash), entry!);
    assert.isNull(await new WebEncryptedTraceStore(one, keyB).get(hash), "key B does not open it: keyRefused");
    assert.equal(hex((await new WebEncryptedTraceStore(one, keyA).get(hash))!), hex(plaintext), "key A does");
  });
});

/**
 * A resolved trace states facts about one agent's chain — the locator
 * account, the session bundle it came out of, and `not-anchored` on a console with no raw gateway —
 * so the cache key it is kept under names the agent and the genesis, not only the hash. Keyed on
 * hash and gateway alone, agent A's answer for a shared sub-hash would be served on agent B's
 * page for five minutes without B's own read running.
 */
describe("a trace answer is cached per agent and per session", () => {
  const hash = hex(sha256(new TextEncoder().encode("{}")));
  const scope = (over: Partial<TraceQueryScope> = {}): TraceQueryScope => ({
    agent: hex(sha256(new TextEncoder().encode("agent-a"))),
    genesis: "",
    gateway: null,
    ...over,
  });
  const agentB = hex(sha256(new TextEncoder().encode("agent-b")));
  const genesis = hex(sha256(new TextEncoder().encode("genesis")));

  it("keys the same hash on two agents apart, for a record and for a part", () => {
    assert.notDeepEqual(traceQueryKey(hash, scope()), traceQueryKey(hash, scope({ agent: agentB })));
    assert.notDeepEqual(tracePartQueryKey(hash, scope()), tracePartQueryKey(hash, scope({ agent: agentB })));
  });

  it("keys a read without the genesis apart from one that opens the session's bundle", () => {
    assert.notDeepEqual(tracePartQueryKey(hash, scope()), tracePartQueryKey(hash, scope({ genesis })));
    assert.notDeepEqual(traceQueryKey(hash, scope()), traceQueryKey(hash, scope({ genesis })));
  });

  it("still shares one fetch between two panels of the same agent and session", () => {
    // `useTracePart` and `useChainSettlement` read the same blob through the same key.
    assert.deepEqual(tracePartQueryKey(hash, scope({ genesis })), tracePartQueryKey(hash, scope({ genesis })));
    // A record's read and a part's read are different answers (one lists sub-hashes), as before.
    assert.notDeepEqual<readonly unknown[]>(traceQueryKey(hash, scope()), tracePartQueryKey(hash, scope()));
  });

  it("keeps the gateway in the key, so another gateway re-resolves", () => {
    // The key is exactly the hash, the gateway, the agent and the genesis: no trace key's tag,
    // since this console writes in the clear and no key's arrival changes an answer.
    assert.deepEqual(tracePartQueryKey(hash, scope({ genesis })), ["trace-part", hash, null, scope().agent, genesis]);
    assert.deepEqual(traceQueryKey(hash, scope({ genesis })), ["trace", hash, null, scope().agent, genesis]);
    assert.notDeepEqual(
      tracePartQueryKey(hash, scope()),
      tracePartQueryKey(hash, scope({ gateway: "http://localhost:3112" }))
    );
  });
});

/**
 * `HttpGatewayBackend.download` has a deadline: without one, a gateway that took the connection and
 * never answered would hang an audit, a mocha run or a trace panel for as long as the socket lived. A
 * read past `timeoutMs` lands in the same `null` a gateway that is down does — the
 * audit's *the bytes are not available* — and a gateway that answers is read exactly as before.
 *
 * A real socket on 127.0.0.1 and the global `fetch`, not a stub: what is being pinned is that the
 * signal reaches the request and outlives the headers, which only a real `fetch` can show.
 */
describe("a gateway that does not answer", () => {
  const id = sha256(new TextEncoder().encode("a blob the gateway is asked for"));
  const blob = new TextEncoder().encode('{"prompt":"served"}');
  type Mode = "serve" | "silent" | "drip";
  let mode: Mode = "serve";
  let server: http.Server;
  let base: string;
  const open = new Set<http.ServerResponse>();

  before(async () => {
    server = http.createServer((_req, res) => {
      open.add(res);
      res.on("close", () => open.delete(res));
      if (mode === "serve") res.end(Buffer.from(blob));
      // `silent` takes the request and never writes a byte; `drip` sends a 200 and the first
      // byte of a body it never finishes — a stall after the headers, which a deadline on the
      // headers alone would let hang.
      else if (mode === "drip") {
        res.writeHead(200, { "content-length": String(blob.length) });
        res.write(Buffer.from(blob.subarray(0, 1)));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const res of open) res.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The read, or `"hung"` if it is still waiting well after its own deadline should have fired. */
  const within = (p: Promise<Uint8Array | null>, ms: number) =>
    Promise.race([p, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms).unref())]);

  it("reads a gateway that answers exactly as before", async () => {
    mode = "serve";
    const got = await new HttpGatewayBackend(base, { timeoutMs: 200 }).download(id);
    assert.deepEqual(got && Array.from(got), Array.from(blob));
  });

  it("gives up on a gateway that never sends headers, and calls the bytes missing", async () => {
    mode = "silent";
    const started = Date.now();
    const got = await within(new HttpGatewayBackend(base, { timeoutMs: 200 }).download(id), 1_200);
    assert.isNull(got, "a stalled gateway reads as one that is down: missing, not a hang and not a throw");
    assert.isAtLeast(Date.now() - started, 150, "and only once its deadline has passed");
  });

  it("gives up on a body that stops arriving after a 200, too", async () => {
    mode = "drip";
    const got = await within(new HttpGatewayBackend(base, { timeoutMs: 200 }).download(id), 1_200);
    assert.isNull(got);
  });

  it("has a default deadline, so a caller that sets none is bounded as well", () => {
    // `lath-audit`, the console's trace readers and `IrysBackend` construct it without one.
    assert.equal(GATEWAY_READ_TIMEOUT_MS, 15_000);
  });
});
