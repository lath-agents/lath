/**
 * What changed since a loop's Solana sources were pinned: the console's per-step re-read
 * (`_lib/sources-refresh.ts`) on a stubbed RPC, the note it
 * renders (`sourcesRefreshNote`), and the note's path into a sandbox's `-m` message and from there into
 * the replay record's `messageHash`, the blob stored under it and the loop manifest's `replayHash`.
 *
 * The sandbox half runs a stub binary that prints one line and exits, unwrapped, through the
 * runtime's test-only spawner — what is under test is the message the host hands it, not the binary.
 * Node-only: temporary directories, a stubbed network, the in-memory chain of `fixtures/fake-chain.ts`.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { EpochStore, hex, idFromString, loopManifestBytes, MemoryTraceStore, sha256, utf8 } from "../sdk/src";
import { AnchorQueue, ChatTransport, LoopRunner, MemoryAnchorJournal, NoopBilling, stepMessages } from "../runtime/src";
import {
  ZeroClawRuntime,
  sandboxMessageText,
  withSourcesNote,
  type ZeroClawBinary,
  type ZeroClawRuntimeOptions,
  type ZeroClawSandboxOptions,
} from "../runtime/src/zeroclaw/runtime";
import { wrapperKind } from "../runtime/src/zeroclaw/posture";
import { decodeReplayRecord } from "../runtime/src/zeroclaw/replay";
import {
  SOURCES_REFRESH_HEAD,
  SOURCES_REFRESH_NOTE_MAX_BYTES,
  sourcesHash,
  sourcesIndex,
  sourcesRefreshNote,
  type SourceRefresh,
  type SourcesManifest,
} from "../runtime/src/zeroclaw/sources";
import { fetchSources, type SourcesDeps } from "../frontend/src/app/api/_lib/sources";
import {
  refreshSolanaSources,
  sourcesRefreshNoteFor,
  type IdlCache,
} from "../frontend/src/app/api/_lib/sources-refresh";
import type { TransportRequest, TransportResponse } from "../frontend/src/app/api/_lib/safe-fetch";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";

// ─── A stubbed RPC ───────────────────────────────────────────────────────────

const DEVNET = "https://devnet.rpc.test/";
const MAINNET = "https://mainnet.rpc.test/";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
/** The demo's _target_: a tiny program on devnet. */
const TARGET = new PublicKey(Buffer.alloc(32, 44)).toBase58();
const TARGET_DATA = new PublicKey(Buffer.alloc(32, 45)).toBase58();
const SQUADS_DATA = new PublicKey(Buffer.alloc(32, 7)).toBase58();
/** A presenter's key, as `solana-keygen` makes one: on the curve. */
const PRESENTER = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey;
const CREATE_KEY = new PublicKey(Buffer.alloc(32, 21));
const MULTISIG = PublicKey.findProgramAddressSync(
  [Buffer.from("multisig"), Buffer.from("multisig"), CREATE_KEY.toBuffer()],
  new PublicKey(SQUADS)
)[0];
/** Squads' vault 0 of that multisig: a PDA, off the curve — the council's vault. */
const VAULT = PublicKey.findProgramAddressSync(
  [Buffer.from("multisig"), MULTISIG.toBuffer(), Buffer.from("vault"), Buffer.from([0])],
  new PublicKey(SQUADS)
)[0];
const MEMBERS = [11, 12, 13].map((b) => Keypair.fromSeed(Buffer.alloc(32, b)).publicKey);

/** Squads v4's `Multisig` in the pre-0.30 IDL format Squads has on chain. */
const SQUADS_IDL = {
  version: "2.1.0",
  name: "squads_multisig_program",
  instructions: [],
  accounts: [
    {
      name: "Multisig",
      type: {
        kind: "struct",
        fields: [
          { name: "createKey", type: "publicKey" },
          { name: "configAuthority", type: "publicKey" },
          { name: "threshold", type: "u16" },
          { name: "timeLock", type: "u32" },
          { name: "transactionIndex", type: "u64" },
          { name: "staleTransactionIndex", type: "u64" },
          { name: "rentCollector", type: { option: "publicKey" } },
          { name: "bump", type: "u8" },
          { name: "members", type: { vec: { defined: "Member" } } },
        ],
      },
    },
  ],
  types: [
    {
      name: "Member",
      type: {
        kind: "struct",
        fields: [
          { name: "key", type: "publicKey" },
          { name: "permissions", type: { defined: "Permissions" } },
        ],
      },
    },
    { name: "Permissions", type: { kind: "struct", fields: [{ name: "mask", type: "u8" }] } },
  ],
};

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/** A 2-of-3 (or `threshold`-of-3) `Multisig` as Squads lays it out. */
function multisigData(threshold = 2, txIndex = 5n): Buffer {
  const u16 = Buffer.alloc(2);
  u16.writeUInt16LE(threshold);
  const tx = Buffer.alloc(8);
  tx.writeBigUInt64LE(txIndex);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(MEMBERS.length);
  return Buffer.concat([
    discriminator("Multisig"),
    CREATE_KEY.toBuffer(),
    Buffer.alloc(32),
    u16,
    Buffer.alloc(4),
    tx,
    Buffer.alloc(8),
    Buffer.from([0]),
    Buffer.from([254]),
    len,
    ...MEMBERS.map((m) => Buffer.concat([m.toBuffer(), Buffer.from([7])])),
    Buffer.alloc(64),
  ]);
}

function programAccount(programData: string): Buffer {
  const b = Buffer.alloc(36);
  b.writeUInt32LE(2, 0);
  new PublicKey(programData).toBuffer().copy(b, 4);
  return b;
}

function programData(authority: PublicKey | null, deploySlot = 503000000n): Buffer {
  const pd = Buffer.alloc(45);
  pd.writeUInt32LE(3, 0);
  pd.writeBigUInt64LE(deploySlot, 4);
  if (authority) {
    pd[12] = 1;
    authority.toBuffer().copy(pd, 13);
  }
  return Buffer.concat([pd, Buffer.from("\x7fELF"), Buffer.alloc(60, 1)]);
}

async function idlAddress(program: string): Promise<string> {
  const key = new PublicKey(program);
  const base = PublicKey.findProgramAddressSync([], key)[0];
  return (await PublicKey.createWithSeed(base, "anchor:idl", key)).toBase58();
}

function idlAccount(idl: unknown): Buffer {
  const payload = zlib.deflateSync(Buffer.from(JSON.stringify(idl)));
  const head = Buffer.alloc(44);
  head.writeUInt32LE(payload.length, 40);
  return Buffer.concat([head, payload]);
}

type Account = { owner: string; executable: boolean; data: Buffer };

interface Rpc {
  deps: SourcesDeps;
  /** The chain, by cluster and address; a case edits it between the pin and the re-read. */
  chain: Record<"devnet" | "mainnet", Record<string, Account>>;
  slot: Record<"devnet" | "mainnet", number>;
  /** Addresses whose read answers 500. */
  failing: Set<string>;
  /** Every `getAccountInfo`, in order: which cluster, which address, and its options. */
  seen: { cluster: string; address: string; opts: Record<string, unknown> }[];
}

function rpc(opts: { mainnet?: boolean } = {}): Rpc {
  const r: Rpc = {
    chain: { devnet: {}, mainnet: {} },
    slot: { devnet: 412_000_000, mainnet: 370_000_000 },
    failing: new Set(),
    seen: [],
    deps: undefined as unknown as SourcesDeps,
  };
  const answer = (status: number, body: unknown): TransportResponse => ({
    status,
    headers: {},
    body: (async function* () {
      yield new TextEncoder().encode(JSON.stringify(body));
    })(),
    cancel: () => undefined,
  });
  r.deps = {
    lookup: async () => {
      throw new Error("no lookup: the RPC is trusted");
    },
    fetch: async (req: TransportRequest): Promise<TransportResponse> => {
      const url = req.url.toString();
      const cluster = url === DEVNET ? "devnet" : url === MAINNET ? "mainnet" : null;
      if (!cluster) return answer(404, {});
      const body = JSON.parse(Buffer.from(req.body!).toString("utf8"));
      assert.equal(body.method, "getAccountInfo");
      const [address, o] = body.params;
      assert.equal(o.commitment, "confirmed");
      r.seen.push({ cluster, address, opts: o });
      if (r.failing.has(address)) return answer(500, { error: "overloaded" });
      const a = r.chain[cluster][address];
      let data = a?.data;
      if (data && o.dataSlice) data = data.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length);
      const value = a
        ? { owner: a.owner, executable: a.executable, lamports: 1_141_440, data: [data!.toString("base64"), "base64"] }
        : null;
      return answer(200, { jsonrpc: "2.0", id: 1, result: { context: { slot: r.slot[cluster] }, value } });
    },
    rpc: { devnet: DEVNET, mainnet: opts.mainnet ? MAINNET : "" },
    now: () => 1_000_000,
  };
  return r;
}

/** The demo's chain on devnet: Squads v4 with its IDL, _target_ upgradeable by the presenter, and a 2-of-3 council. */
async function demoChain(r: Rpc, cluster: "devnet" | "mainnet" = "devnet"): Promise<void> {
  const c = r.chain[cluster];
  c[SQUADS] = { owner: LOADER, executable: true, data: programAccount(SQUADS_DATA) };
  c[SQUADS_DATA] = { owner: LOADER, executable: false, data: programData(PRESENTER) };
  c[await idlAddress(SQUADS)] = { owner: SQUADS, executable: false, data: idlAccount(SQUADS_IDL) };
  c[TARGET] = { owner: LOADER, executable: true, data: programAccount(TARGET_DATA) };
  c[TARGET_DATA] = { owner: LOADER, executable: false, data: programData(PRESENTER, 411_000_000n) };
  c[MULTISIG.toBase58()] = { owner: SQUADS, executable: false, data: multisigData() };
}

function tmp(prefix = "srf-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Removes a test root that may hold a seeded, read-only `sources/` (0555 directories). */
function removeTree(dir: string): void {
  spawnSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The loop's sources as the start leaves them: fetched to a directory, and the manifest committing it. */
async function pin(r: Rpc, inputs: unknown[], root = tmp()): Promise<{ manifest: SourcesManifest; dir: string }> {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, "sources.fetched");
  const { manifest } = await fetchSources(inputs, r.deps, dir);
  return { manifest, dir };
}

const devnet = (address: string) => ({ kind: "solana", cluster: "devnet", address });

/** Every file under `dir` with the hash of its bytes, sorted: what a case holds still across a re-read. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.sort();
}

// ─── The re-read ─────────────────────────────────────────────────────────────

describe("sources refresh: what changed since the Solana sources were pinned", () => {
  it("shows target's authority moving from the presenter's key to the council's vault: old → new, keypair → pda", async () => {
    const r = rpc();
    await demoChain(r);
    const src = await pin(r, [devnet(TARGET)]);
    const pinned = src.manifest.sources[0].source as { slot: string };
    assert.equal(pinned.slot, "412000000");
    const hashBefore = sourcesHash(src.manifest);
    const filesBefore = snapshot(src.dir);

    // On stage: the presenter moves target's upgrade authority to the vault, some slots later.
    r.chain.devnet[TARGET_DATA] = { owner: LOADER, executable: false, data: programData(VAULT, 411_000_000n) };
    r.slot.devnet = 412_000_950;
    r.seen.length = 0;

    const [row] = await refreshSolanaSources(src, r.deps);
    assert.deepEqual(row, {
      n: 1,
      address: TARGET,
      pinnedSlot: "412000000",
      slot: "412000950",
      changes: [
        { what: "program.json upgradeAuthority", from: PRESENTER.toBase58(), to: VAULT.toBase58() },
        { what: "program.json authorityKind", from: "keypair", to: "pda" },
      ],
    });
    // Two reads: the program, then only the programdata's header, at the first read's slot or later.
    assert.deepEqual(
      r.seen.map((s) => s.address),
      [TARGET, TARGET_DATA]
    );
    assert.deepEqual(r.seen[1].opts.dataSlice, { offset: 0, length: 45 });
    assert.equal(r.seen[1].opts.minContextSlot, 412_000_950);

    const note = (await sourcesRefreshNoteFor(src, r.deps))!;
    assert.equal(
      note,
      `${SOURCES_REFRESH_HEAD}\n` +
        `[1] ${TARGET}: changed since slot 412000000 (read at slot 412000950)\n` +
        `  program.json upgradeAuthority: ${PRESENTER.toBase58()} → ${VAULT.toBase58()}\n` +
        "  program.json authorityKind: keypair → pda\n"
    );
    // The pin is the start's: nothing under the fetched directory was written, and the hash is the same.
    assert.deepEqual(snapshot(src.dir), filesBefore);
    assert.equal(sourcesHash(src.manifest), hashBefore);
    const program = JSON.parse(fs.readFileSync(path.join(src.dir, `solana/devnet/${TARGET}/program.json`), "utf8"));
    assert.equal(program.upgradeAuthority, PRESENTER.toBase58());
  });

  it("says unchanged since the pinned slot for a source that did not move, with one read per account", async () => {
    const r = rpc();
    await demoChain(r);
    const src = await pin(r, [devnet(SQUADS), devnet(MULTISIG.toBase58())]);
    r.slot.devnet = 412_000_100;
    r.seen.length = 0;
    const note = (await sourcesRefreshNoteFor(src, r.deps))!;
    assert.equal(
      note,
      `${SOURCES_REFRESH_HEAD}\n` +
        `[1] ${SQUADS}: unchanged since slot 412000000 (read at slot 412000100)\n` +
        `[2] ${MULTISIG.toBase58()}: unchanged since slot 412000000 (read at slot 412000100)\n`
    );
    // A program is two reads, an account one; nothing else (no IDL read for data that did not move).
    assert.lengthOf(r.seen, 3);
  });

  it("names each changed field of an IDL-decoded account, decoding with the owner's pinned idl.json", async () => {
    const r = rpc();
    await demoChain(r);
    const src = await pin(r, [devnet(SQUADS), devnet(MULTISIG.toBase58())]);
    r.chain.devnet[MULTISIG.toBase58()] = { owner: SQUADS, executable: false, data: multisigData(3, 6n) };
    r.seen.length = 0;
    const rows = await refreshSolanaSources(src, r.deps, new Map());
    const row = rows[1] as Extract<SourceRefresh, { changes: unknown }>;
    const what = row.changes.map((c) => c.what);
    assert.deepEqual(what, [
      "account.json data sha256",
      "decoded.json data.threshold",
      "decoded.json data.transactionIndex",
    ]);
    assert.deepInclude(row.changes, { what: "decoded.json data.threshold", from: "2", to: "3" });
    assert.deepInclude(row.changes, { what: "decoded.json data.transactionIndex", from: "5", to: "6" });
    // The owner is a source of this loop, so its pinned IDL decoded the account: no IDL account read.
    assert.notInclude(
      r.seen.map((s) => s.address),
      await idlAddress(SQUADS)
    );
  });

  it("reads the owner's IDL once for the process when the owner is not a source, and keeps it", async () => {
    const r = rpc();
    await demoChain(r);
    const src = await pin(r, [devnet(MULTISIG.toBase58())]);
    r.chain.devnet[MULTISIG.toBase58()] = { owner: SQUADS, executable: false, data: multisigData(3) };
    const idls: IdlCache = new Map();
    const idl = await idlAddress(SQUADS);
    for (const reads of [1, 0]) {
      r.seen.length = 0;
      const [row] = await refreshSolanaSources(src, r.deps, idls);
      assert.deepInclude((row as { changes: unknown[] }).changes, {
        what: "decoded.json data.threshold",
        from: "2",
        to: "3",
      });
      assert.equal(r.seen.filter((s) => s.address === idl).length, reads);
    }
  });

  it("reports a failed re-read as a row, beside the sources that were read", async () => {
    const r = rpc();
    await demoChain(r);
    await demoChain(r, "mainnet");
    const both = rpc({ mainnet: true });
    both.chain = r.chain;
    const src = await pin(both, [
      devnet(TARGET),
      devnet(SQUADS),
      { kind: "solana", cluster: "mainnet", address: SQUADS },
    ]);

    // Mainnet with LATH_MAINNET_RPC gone, and devnet's Squads answering 500.
    r.failing.add(SQUADS);
    const note = (await sourcesRefreshNoteFor(src, r.deps))!;
    const lines = note.trimEnd().split("\n");
    assert.equal(lines[1], `[1] ${TARGET}: unchanged since slot 412000000 (read at slot 412000000)`);
    assert.match(lines[2], new RegExp(`^\\[2\\] could not re-read ${SQUADS}: .*500`));
    assert.equal(lines[3], `[3] could not re-read ${SQUADS}: LATH_MAINNET_RPC is unset on this host`);

    // A pinned file edited on the host is not the pin: it is reported, not compared.
    const program = path.join(src.dir, `solana/devnet/${TARGET}/program.json`);
    fs.writeFileSync(program, fs.readFileSync(program, "utf8").replace("keypair", "pda"));
    const [row] = await refreshSolanaSources(src, r.deps);
    assert.match(
      (row as { error: string }).error,
      /the pinned sources\/solana\/devnet\/\w+\/program\.json on this host/
    );
  });

  it("reads nothing and writes no note for a loop with no Solana source", async () => {
    const r = rpc();
    const manifest: SourcesManifest = {
      v: 1,
      sources: [
        {
          source: {
            kind: "url",
            input: "https://docs.example.org/spec.md",
            finalUrl: "https://docs.example.org/spec.md",
            contentType: "text/markdown",
          },
          dir: "url/docs.example.org/spec.md",
          files: [],
        },
      ],
    };
    assert.isUndefined(await sourcesRefreshNoteFor({ manifest, dir: tmp() }, r.deps));
    assert.isUndefined(await sourcesRefreshNoteFor(undefined, r.deps));
    assert.lengthOf(r.seen, 0);
    assert.isUndefined(sourcesRefreshNote([]));
  });

  it("holds the note to its cap by leaving changed fields out before any source", () => {
    const rows: SourceRefresh[] = Array.from({ length: 8 }, (_, i) => ({
      n: i + 1,
      address: new PublicKey(Buffer.alloc(32, i + 1)).toBase58(),
      pinnedSlot: "1",
      slot: "2",
      changes: Array.from({ length: 12 }, (_, k) => ({
        what: `decoded.json data.f${k}`,
        from: "a".repeat(200),
        to: "b",
      })),
    }));
    const note = sourcesRefreshNote(rows)!;
    assert.isAtMost(Buffer.byteLength(note), SOURCES_REFRESH_NOTE_MAX_BYTES);
    for (let i = 1; i <= 8; i++) assert.include(note, `[${i}] `);
    assert.include(note, "more changed fields, left out to keep this note small");
    assert.include(note, `${"a".repeat(160)}… → b`, "a long value is cut");
  });
});

// ─── Into the sandbox's message, and what commits it ─────────────────────────

const PLATFORM = process.platform;
const SUPPORTED = PLATFORM === "darwin" || PLATFORM === "linux";
const T = Date.UTC(2026, 8, 25, 12, 0, 0);
const MODEL = "deepseek/deepseek-v4.1-flash";
const USER = new PublicKey("11111111111111111111111111111112");

/** The binary, as far as this suite needs one: it answers `--version` and prints one line. */
const STUB = `
if (process.argv[2] === "--version") { process.stdout.write("zeroclaw 0.0.0-stub (lath) patchset=stub\\n"); process.exit(0); }
process.stdout.write("Read the sources.\\n");
`;

/** Every model call fails: the stub makes none, and a step that did would be a bug here. */
const noModel: ChatTransport = {
  async chat() {
    throw new Error("the stub binary makes no model call");
  },
};

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

describe("sources refresh: the note in the step's message, committed by messageHash", function () {
  this.timeout(60_000);

  let root = "";
  let binary: ZeroClawBinary;
  const spawned: string[] = [];
  const spawner = (file: string, args: string[], options: SpawnOptions): ChildProcess => {
    spawned.push(args[args.indexOf("-m") + 1]);
    return spawn(process.execPath, [binary.path, ...args.slice(args.indexOf("--config-dir"))], options);
  };

  before(function () {
    if (!SUPPORTED) {
      console.log(`      skipped: no wrapper on ${PLATFORM}`);
      this.skip();
    }
    // Short: a socket path is at most 103 bytes to the binary on macOS.
    root = fs.realpathSync(fs.mkdtempSync("/tmp/srf-"));
    const stub = path.join(root, "bin", "zeroclaw");
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(stub, `#!${process.execPath}\n${STUB}`, { mode: 0o755 });
    binary = {
      path: stub,
      sha256: createHash("sha256").update(fs.readFileSync(stub)).digest("hex"),
      patchSet: "stub",
      version: "zeroclaw 0.0.0-stub (lath) patchset=stub",
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
  });

  let homes = 0;
  function runtime(
    zeroclaw: Partial<ZeroClawSandboxOptions>,
    extra: Partial<ZeroClawRuntimeOptions> = {}
  ): { rt: ZeroClawRuntime; store: MemoryTraceStore } {
    const store = new MemoryTraceStore();
    const rt = new ZeroClawRuntime({
      client: new FakeChain().asClient(),
      agentId: idFromString("sources-refresh-agent"),
      transport: noModel,
      store,
      billing: new NoopBilling(),
      storePayloads: true,
      structures: false,
      publishPolicy: false,
      now: () => T,
      policy: { model: MODEL, temperature: 0.2, toolAllowList: [], maxCost: 5_000_000 },
      system: "You are one step of a loop.",
      ...extra,
      zeroclaw: {
        binary,
        home: path.join(root, `h${homes++}`),
        sandbox: "loop-rf",
        spawner,
        contextWindow: async () => undefined,
        ...zeroclaw,
      },
    } as ZeroClawRuntimeOptions);
    return { rt, store };
  }

  it("puts the note after the goal and before the memory, where the replay record's messageHash commits it", async () => {
    const r = rpc();
    await demoChain(r);
    const src = await pin(r, [devnet(TARGET)], path.join(root, "p1"));
    r.chain.devnet[TARGET_DATA] = { owner: LOADER, executable: false, data: programData(VAULT, 411_000_000n) };
    r.slot.devnet = 412_000_950;
    const note = (await sourcesRefreshNoteFor(src, r.deps))!;
    let asked = 0;
    const { rt, store } = runtime({
      sources: src,
      sourcesNote: async () => {
        asked++;
        return note;
      },
    });
    const opts = {
      user: USER,
      prompt: "Who can upgrade target?",
      goal: "A cited answer, with target's authority held by the council's vault.",
      memory: { text: "the plan so far", hash: "ab".repeat(32), from: "step 1" },
    };
    const result = await rt.start({ ...opts, sessionId: "loop-rf:step-2" });
    assert.equal(result.status, "success", result.reason);
    assert.equal(asked, 1);

    const message = spawned[0];
    const expected = sandboxMessageText(
      withSourcesNote(stepMessages({ ...opts, system: "You are one step of a loop." }), note, true),
      src.manifest
    );
    assert.equal(message, expected);
    assert.isTrue(message.startsWith(`${sourcesIndex(src.manifest)}\n`), "the index is still the prefix");
    // Where a gated step's wake note stands (gated loops are not in this build): after the goal.
    const goalAt = message.indexOf("A cited answer, with target's authority held by the council's vault.");
    const noteAt = message.indexOf(note);
    const memoryAt = message.indexOf("the plan so far");
    assert.isTrue(goalAt >= 0 && goalAt < noteAt && noteAt < memoryAt, "the goal, then the note, then the memory");
    assert.include(message, `program.json authorityKind: keypair → pda`);

    // What commits it: the record's messageHash is the hash of exactly these bytes, and the store
    // holds them under it — the note is in the blob a replayer re-runs the step with.
    const record = decodeReplayRecord((await store.get(Buffer.from(result.replayHash!, "hex")))!)!;
    assert.equal(record.messageHash, hex(sha256(utf8(message))));
    assert.equal(new TextDecoder().decode((await store.get(Buffer.from(record.messageHash, "hex")))!), message);
    // And nothing about the pin moved: the posture still commits the manifest the start fetched.
    assert.equal(rt.policy.sandbox!.sources!.hash, sourcesHash(src.manifest));
  });

  it("commits each step's own note through the loop manifest's replayHash", async () => {
    const r = rpc();
    await demoChain(r);
    const src = await pin(r, [devnet(TARGET)], path.join(root, "p2"));
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
    const { rt, store } = runtime({ sources: src, sourcesNote: () => sourcesRefreshNoteFor(src, r.deps) }, {
      client: chain.asClient(),
      billing,
      rollup: { store: epochStore(), batchSize: 16 },
      anchor: { queue, drain: true },
    } as Partial<ZeroClawRuntimeOptions>);
    const runner = new LoopRunner({
      runtime: rt,
      loopId: "loop-rf",
      prompt: "Who can upgrade target?",
      intervalMs: 0,
      maxSteps: 2,
      user: USER,
      startedAt: T,
      now: () => T,
      sleep: async () => undefined,
    });
    const one = await runner.step();
    // Between the steps, on stage: the authority moves to the vault.
    r.chain.devnet[TARGET_DATA] = { owner: LOADER, executable: false, data: programData(VAULT, 411_000_000n) };
    r.slot.devnet = 412_000_950;
    const two = await runner.step();
    assert.equal(one.status, "success", one.reason);
    assert.equal(two.status, "success", two.reason);

    const told: string[] = [];
    for (const stepped of [one, two]) {
      const h = stepped.manifest!.replayHash!;
      assert.include(new TextDecoder().decode(loopManifestBytes(stepped.manifest!)), `"replayHash":"${h}"`);
      const record = decodeReplayRecord((await store.get(Buffer.from(h, "hex")))!)!;
      told.push(new TextDecoder().decode((await store.get(Buffer.from(record.messageHash, "hex")))!));
    }
    assert.include(told[0], `[1] ${TARGET}: unchanged since slot 412000000 (read at slot 412000000)`);
    assert.include(told[1], `[1] ${TARGET}: changed since slot 412000000 (read at slot 412000950)`);
    assert.include(told[1], `program.json upgradeAuthority: ${PRESENTER.toBase58()} → ${VAULT.toBase58()}`);
  });

  it("runs the step when the re-read fails outright, saying so for each Solana source", async () => {
    const r = rpc();
    await demoChain(r);
    const src = await pin(r, [devnet(TARGET), devnet(SQUADS)], path.join(root, "p3"));
    const { rt } = runtime({
      sources: src,
      sourcesNote: async () => {
        throw new Error("the RPC is down");
      },
    });
    const result = await rt.start({ user: USER, prompt: "Who can upgrade target?", sessionId: "loop-rf:step-1" });
    assert.equal(result.status, "success", result.reason);
    assert.notProperty(result, "sandboxRefused");
    assert.include(spawned[0], `[1] could not re-read ${TARGET}: the RPC is down`);
    assert.include(spawned[0], `[2] could not re-read ${SQUADS}: the RPC is down`);
  });

  it("writes no note for a loop with no Solana source, and its message, record and posture hash as before", async () => {
    const dir = path.join(root, "p4");
    // A URL's file sits in the directory its path names, under the last segment's name (`fetchUrl`).
    const file = "url/docs.example.org/spec.md/spec.md";
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "# Spec\n");
    const manifest: SourcesManifest = {
      v: 1,
      sources: [
        {
          source: {
            kind: "url",
            input: "https://docs.example.org/spec.md",
            finalUrl: "https://docs.example.org/spec.md",
            contentType: "text/markdown",
          },
          dir: "url/docs.example.org/spec.md",
          files: [{ path: file, size: 7, sha256: createHash("sha256").update("# Spec\n").digest("hex") }],
        },
      ],
    };
    const src = { manifest, dir };
    const r = rpc();
    const home = path.join(root, "p4h");
    const records: string[] = [];
    const postures: string[] = [];
    for (const [i, sourcesNote] of [undefined, () => sourcesRefreshNoteFor(src, r.deps)].entries()) {
      const { rt, store } = runtime({ sources: src, home, ...(sourcesNote ? { sourcesNote } : {}) });
      const result = await rt.start({ user: USER, prompt: "Read the spec.", sessionId: `loop-rf:step-${i}` });
      assert.equal(result.status, "success", result.reason);
      const record = decodeReplayRecord((await store.get(Buffer.from(result.replayHash!, "hex")))!)!;
      records.push(record.messageHash);
      postures.push(record.postureHash);
    }
    assert.lengthOf(r.seen, 0, "nothing was read");
    assert.equal(spawned[0], spawned[1], "the same message, byte for byte");
    assert.notInclude(spawned[1], "Changed since pinned");
    assert.equal(records[0], records[1]);
    assert.equal(postures[0], postures[1]);
  });

  it("asks nothing of a sandbox with no sources, whatever it is handed", async () => {
    let asked = 0;
    const { rt } = runtime({
      sourcesNote: async () => {
        asked++;
        return "never";
      },
    });
    const result = await rt.start({ user: USER, prompt: "hi", sessionId: "loop-rf:plain" });
    assert.equal(result.status, "success", result.reason);
    assert.equal(asked, 0);
    assert.notInclude(spawned[0], "never");
  });
});
