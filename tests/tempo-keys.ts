/**
 * A loop's Tempo access key (docs/ARCHITECTURE.md §7.3), from its file to its
 * revoke (`frontend/src/app/api/_lib/tempo-keys.ts`).
 *
 * Node-only, network-free: the key directory and `LATH_TRACE_DIR` are throwaway directories under
 * the OS temp dir, the treasury is a random key handed in through the test hooks, and every call
 * that would reach Tempo goes to a fake keychain that keeps its state in memory. The one real
 * `viem/tempo` call, `Account.fromSecp256k1`, is pure curve arithmetic.
 */
import { traceDir } from "./fixtures/trace-dir";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert } from "chai";
import { encodeFunctionData, getAddress, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  readTreasuryLock,
  releaseTreasuryForTests,
  TEMPO_ESCROW,
  TEMPO_USDC_E,
} from "../frontend/src/app/api/_lib/tempo";
import {
  ESCROW_OPEN_SELECTOR,
  ESCROW_TOP_UP_SELECTOR,
  TIP20_TRANSFER_WITH_MEMO_SELECTOR,
  LIMIT_UPDATE_SETS,
  LoopKeyLimitUnknownError,
  LoopKeyOverCapError,
  LoopKeyReadFailedError,
  LoopKeyChannelRow,
  LimitUpdateSemantics,
  TempoKeyChain,
  authorizeLoopKey,
  createLoopKey,
  deleteLoopKeyFile,
  limitUpdateValue,
  loopKeyAccount,
  loopKeyFilePath,
  loopKeyLimitTarget,
  loopKeyAuthorizeArgs,
  loopKeyScopes,
  loopKeyScopesEnabled,
  loopKeyState,
  loopKeysEnabled,
  reconcileLoopKeyLimit,
  revokeLoopKey,
  setTempoKeyChainForTests,
} from "../frontend/src/app/api/_lib/tempo-keys";

const SOURCE = path.join(__dirname, "..", "frontend", "src", "app", "api", "_lib", "tempo-keys.ts");
const treasury = privateKeyToAccount(generatePrivateKey());
const LOOP = "loop-0123456789abcdef";
const in30Days = () => Math.floor(Date.now() / 1000) + 30 * 86_400;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
/** A storage payee in checksummed mixed case, as a 402 challenge may spell it. */
const PAYEE = getAddress("0xabcdef0123456789abcdef0123456789abcdef01");
const NODE_MODULES = path.join(__dirname, "..", "node_modules");
// `viem/tempo` and mppx's files go through `import()`, as the module under test loads them: required
// as CommonJS they pull in `ox`, which tsconfig-paths maps to its `.d.ts` files at run time.
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

/**
 * A keychain in memory. `semantics` is what *this* chain's `updateSpendingLimit` does, which a test
 * may set apart from what the module believes, to see the recheck catch the difference.
 */
class FakeKeychain {
  keys = new Map<string, { total: bigint; spent: bigint; expiry: number; revoked: boolean }>();
  calls: { op: string; args: any }[] = [];
  n = 0;
  semantics: LimitUpdateSemantics;
  constructor(semantics: LimitUpdateSemantics = "remaining") {
    this.semantics = semantics;
  }

  spend(key: string, amount: bigint): void {
    this.keys.get(key.toLowerCase())!.spent += amount;
  }
  remaining(key: string): bigint {
    const k = this.keys.get(key.toLowerCase())!;
    const left = k.total - k.spent;
    return left > BigInt(0) ? left : BigInt(0);
  }

  hooks(extra: Partial<TempoKeyChain> = {}) {
    const chain: TempoKeyChain = {
      authorize: async (o) => {
        this.calls.push({ op: "authorize", args: o });
        this.keys.set(o.key.toLowerCase(), { total: o.limit, spent: BigInt(0), expiry: o.expiry, revoked: false });
        return { txHash: tx(++this.n), status: "success" };
      },
      updateLimit: async (o) => {
        this.calls.push({ op: "updateLimit", args: o });
        const k = this.keys.get(o.key.toLowerCase())!;
        k.total = this.semantics === "remaining" ? k.spent + o.limit : o.limit;
        return tx(++this.n);
      },
      revoke: async (o) => {
        this.calls.push({ op: "revoke", args: o });
        this.keys.get(o.key.toLowerCase())!.revoked = true;
        return tx(++this.n);
      },
      readState: async (o) => {
        this.calls.push({ op: "readState", args: o });
        const k = this.keys.get(o.key.toLowerCase());
        if (!k) throw new Error("KeyNotFound");
        return {
          remaining: this.remaining(o.key),
          expiry: k.expiry,
          isRevoked: k.revoked,
          ...(o.wantTotal ? { total: k.total } : {}),
        };
      },
    };
    return { ...chain, ...extra, treasury };
  }
  ops(): string[] {
    return this.calls.map((c) => c.op);
  }
}

let keyDir: string;

function fresh(): void {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-tempo-keys-"));
  process.env.LATH_TEMPO_KEY_DIR = path.join(keyDir, "keys");
}

async function authorized(chain: FakeKeychain, limitBase = "1000000") {
  setTempoKeyChainForTests(chain.hooks());
  return authorizeLoopKey(createLoopKey(LOOP, limitBase, in30Days()));
}

/** Runs `fn` with `console.warn` captured, so a test can read what the module said. */
async function capturingWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: string[] }> {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    return { result: await fn(), warned };
  } finally {
    console.warn = original;
  }
}

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("tempo-keys: per-loop access keys", () => {
  beforeEach(() => {
    fresh();
    setTempoKeyChainForTests(new FakeKeychain().hooks());
  });
  afterEach(() => {
    setTempoKeyChainForTests(null);
    releaseTreasuryForTests();
    delete process.env.LATH_TEMPO_KEY_DIR;
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  describe("the switch", () => {
    const saved = process.env.LATH_TEMPO_LOOP_KEYS;
    after(() => {
      if (saved === undefined) delete process.env.LATH_TEMPO_LOOP_KEYS;
      else process.env.LATH_TEMPO_LOOP_KEYS = saved;
    });

    it("is on for 1, on, true and yes in any case, and off for anything else or unset", () => {
      for (const v of ["1", "on", "true", "yes", "ON", " Yes ", "TRUE"]) {
        process.env.LATH_TEMPO_LOOP_KEYS = v;
        assert.isTrue(loopKeysEnabled(), JSON.stringify(v));
      }
      for (const v of ["", "0", "off", "false", "no", "enabled", "1 "]) {
        process.env.LATH_TEMPO_LOOP_KEYS = v;
        assert.equal(loopKeysEnabled(), v === "1 ", JSON.stringify(v));
      }
      delete process.env.LATH_TEMPO_LOOP_KEYS;
      assert.isFalse(loopKeysEnabled());
    });
  });

  describe("the key file", () => {
    it("is written with mode 0600 in a 0700 directory, holding a key that is its address", () => {
      const key = createLoopKey(LOOP, "250000", in30Days());
      assert.equal(key.file, loopKeyFilePath(LOOP));
      assert.equal(fs.statSync(key.file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(key.file)).mode & 0o777, 0o700);
      const file = JSON.parse(fs.readFileSync(key.file, "utf8"));
      assert.equal(file.v, 1);
      assert.equal(file.loopId, LOOP);
      assert.equal(privateKeyToAccount(file.privateKey).address, key.address);
      assert.equal(file.root, treasury.address);
      assert.equal(file.token, TEMPO_USDC_E);
      assert.equal(file.limitBase, "250000");
      assert.isUndefined(file.authorizeTx);
      assert.isUndefined(key.authorizeTx);
    });

    it("holds a random key: two loops never share one, and none is the treasury", () => {
      const a = createLoopKey(LOOP, "1", in30Days());
      const b = createLoopKey("loop-fedcba9876543210", "1", in30Days());
      assert.notEqual(a.address, b.address);
      assert.notEqual(a.address, treasury.address);
    });

    it("never comes from the server seed: the module imports nothing but TRACE_DIR from runner.ts and never calls derived()", () => {
      const src = fs.readFileSync(SOURCE, "utf8");
      const imports = src.match(/import[\s\S]*?from\s+"[^"]+";/g) ?? [];
      for (const line of imports) assert.notMatch(line, /\bderived\b|\bserverKeypair\b|\btraceKeyFor\b/, line);
      const fromRunner = imports.filter((l) => /from\s+"\.\/runner"/.test(l));
      assert.deepEqual(fromRunner, ['import { TRACE_DIR } from "./runner";']);
      assert.notMatch(src, /\bderived\s*\(/);
      assert.match(src, /generatePrivateKey\(\)/);
    });

    it("refuses a second key for the same loop rather than overwriting it", () => {
      const first = createLoopKey(LOOP, "1", in30Days());
      const before = fs.readFileSync(first.file, "utf8");
      assert.throws(() => createLoopKey(LOOP, "1", in30Days()), /already has a key file/);
      assert.equal(fs.readFileSync(first.file, "utf8"), before);
    });

    it("refuses a key directory at or under LATH_TRACE_DIR, through a symlink too", () => {
      process.env.LATH_TEMPO_KEY_DIR = path.join(traceDir, "tempo-keys");
      assert.throws(() => createLoopKey(LOOP, "1", in30Days()), /inside LATH_TRACE_DIR/);
      process.env.LATH_TEMPO_KEY_DIR = traceDir;
      assert.throws(() => createLoopKey(LOOP, "1", in30Days()), /inside LATH_TRACE_DIR/);
      const link = path.join(keyDir, "looks-elsewhere");
      fs.symlinkSync(traceDir, link);
      process.env.LATH_TEMPO_KEY_DIR = path.join(link, "keys");
      assert.throws(() => createLoopKey(LOOP, "1", in30Days()), /inside LATH_TRACE_DIR/);
      assert.isFalse(fs.existsSync(path.join(traceDir, "keys")));
      assert.isFalse(fs.existsSync(path.join(traceDir, "tempo-keys")));
    });

    it("refuses the trace directory under another spelling of its case where the file system folds case", function () {
      // The proof of concept: `<base>/TRACES/keys` is `<base>/traces/keys` on APFS.
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "lath-case-"));
      const trace = path.join(base, "traces");
      fs.mkdirSync(trace);
      const folds = fs.existsSync(path.join(base, "TRACES"));
      const saved = process.env.LATH_TRACE_DIR;
      process.env.LATH_TRACE_DIR = trace;
      try {
        process.env.LATH_TEMPO_KEY_DIR = path.join(trace, "keys");
        assert.throws(() => createLoopKey(LOOP, "1", in30Days()), /inside LATH_TRACE_DIR/);
        process.env.LATH_TEMPO_KEY_DIR = path.join(base, "TRACES", "keys");
        if (process.platform === "darwin" || process.platform === "win32") {
          assert.throws(() => createLoopKey(LOOP, "1", in30Days()), /inside LATH_TRACE_DIR/);
          assert.isFalse(fs.existsSync(path.join(trace, "keys")));
        } else if (!folds) {
          // A case-sensitive file system: `TRACES` is another directory, and allowed.
          const key = createLoopKey(LOOP, "1", in30Days());
          assert.notInclude(fs.realpathSync.native(key.file), fs.realpathSync.native(trace) + path.sep);
        } else {
          this.skip();
        }
      } finally {
        process.env.LATH_TRACE_DIR = saved;
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("refuses a loop id that could name a file elsewhere, a zero limit and a past expiry, writing nothing", () => {
      assert.throws(() => createLoopKey("../escape", "1", in30Days()), /not a loop id/);
      assert.throws(() => createLoopKey("a/b", "1", in30Days()), /not a loop id/);
      assert.throws(() => createLoopKey(LOOP, "0", in30Days()), /above zero/);
      assert.throws(() => createLoopKey(LOOP, "1.5", in30Days()), /base-unit integer/);
      assert.throws(() => createLoopKey(LOOP, "1", Math.floor(Date.now() / 1000) - 1), /future/);
      assert.isFalse(fs.existsSync(loopKeyFilePath(LOOP)));
    });

    it("deleteLoopKeyFile removes it, and is quiet when there is none", () => {
      const key = createLoopKey(LOOP, "1", in30Days());
      deleteLoopKeyFile(LOOP);
      assert.isFalse(fs.existsSync(key.file));
      deleteLoopKeyFile(LOOP);
    });
  });

  describe("authorizing", () => {
    it("sends only after the file exists, with the file's limit and expiry, and records the transaction in it", async () => {
      const chain = new FakeKeychain();
      const expiry = in30Days();
      let fileAtSend: any = null;
      setTempoKeyChainForTests(
        chain.hooks({
          authorize: async (o) => {
            assert.isTrue(fs.existsSync(loopKeyFilePath(LOOP)), "the key file exists before the authorize is sent");
            fileAtSend = JSON.parse(fs.readFileSync(loopKeyFilePath(LOOP), "utf8"));
            assert.equal(o.key, fileAtSend.address);
            assert.equal(o.root, treasury.address);
            assert.equal(o.limit, BigInt(750_000));
            assert.equal(o.expiry, expiry);
            assert.equal(o.token, TEMPO_USDC_E);
            return { txHash: tx(7), status: "success" };
          },
        })
      );
      const key = await authorizeLoopKey(createLoopKey(LOOP, "750000", expiry));
      assert.isNotNull(fileAtSend);
      assert.equal(key.authorizeTx, tx(7));
      const file = JSON.parse(fs.readFileSync(key.file, "utf8"));
      assert.equal(file.authorizeTx, tx(7));
      assert.equal(file.privateKey, fileAtSend.privateKey);
      assert.equal(fs.statSync(key.file).mode & 0o777, 0o600);
    });

    it("holds the treasury lock while it sends", async () => {
      releaseTreasuryForTests();
      fs.rmSync(path.join(traceDir, "tempo-channels.lock"), { force: true });
      let lockAtSend: any = null;
      setTempoKeyChainForTests(
        new FakeKeychain().hooks({
          authorize: async () => {
            lockAtSend = readTreasuryLock();
            return { txHash: tx(1), status: "success" };
          },
        })
      );
      await authorizeLoopKey(createLoopKey(LOOP, "1", in30Days()));
      assert.equal(lockAtSend?.pid, process.pid);
    });

    it("deletes the file and surfaces Tempo's reason when the authorize fails", async () => {
      setTempoKeyChainForTests(
        new FakeKeychain().hooks({
          authorize: async () => {
            throw Object.assign(new Error("long viem message"), {
              shortMessage: "Execution reverted",
              details: "Account keychain error: KeyAlreadyExists",
            });
          },
        })
      );
      const key = createLoopKey(LOOP, "1", in30Days());
      const privateKey = JSON.parse(fs.readFileSync(key.file, "utf8")).privateKey;
      const { result, warned } = await capturingWarn(() => rejects(authorizeLoopKey(key)));
      const e = result;
      assert.match(e.message, /authorizing the Tempo key of loop-0123456789abcdef failed/);
      assert.match(e.message, /KeyAlreadyExists/);
      assert.isFalse(fs.existsSync(key.file));
      // The address, so the treasury can revoke a key the authorize may have reached — never the secret.
      for (const text of [e.message, warned.join("\n")]) {
        assert.include(text, key.address);
        assert.match(text, /may be authorized on the treasury/);
        assert.match(text, /revoke it by address/);
        assert.notInclude(text, privateKey);
        assert.notInclude(text.toLowerCase(), privateKey.slice(2).toLowerCase());
      }
    });

    it("treats a reverted or unmined authorize as a failure, deletes the file and logs the transaction", async () => {
      for (const status of ["reverted", "pending"] as const) {
        setTempoKeyChainForTests(new FakeKeychain().hooks({ authorize: async () => ({ txHash: tx(3), status }) }));
        const key = createLoopKey(LOOP, "1", in30Days());
        const { result: e, warned } = await capturingWarn(() => rejects(authorizeLoopKey(key)));
        assert.match(e.message, status === "reverted" ? /reverted/ : /not mined in time/);
        assert.include(e.message, tx(3));
        assert.include(warned.join("\n"), `${key.address} (authorize ${tx(3)}) may be authorized`);
        assert.isFalse(fs.existsSync(key.file));
      }
    });

    it("refuses a key whose terms differ from its file, sends nothing, and says nothing was sent", async () => {
      const chain = new FakeKeychain();
      setTempoKeyChainForTests(chain.hooks());
      const key = createLoopKey(LOOP, "100", in30Days());
      const { result: e, warned } = await capturingWarn(() =>
        rejects(authorizeLoopKey({ ...key, limitBase: "999999" }))
      );
      assert.match(e.message, /does not match its file/);
      assert.match(e.message, /nothing was sent/);
      assert.include(warned.join("\n"), key.address);
      assert.deepEqual(chain.ops(), []);
      assert.isFalse(fs.existsSync(key.file));
    });

    it("refuses a second authorize of the same key and leaves its file alone", async () => {
      const key = await authorized(new FakeKeychain());
      const e = await rejects(authorizeLoopKey(key));
      assert.match(e.message, /already authorized/);
      assert.isTrue(fs.existsSync(key.file));
    });
  });

  describe("the account mppx signs with", () => {
    it("pays from the treasury and signs as the loop's key", async () => {
      const key = await authorized(new FakeKeychain());
      const account = await loopKeyAccount(LOOP);
      assert.equal(account.address.toLowerCase(), treasury.address.toLowerCase());
      assert.equal(account.accessKeyAddress.toLowerCase(), key.address.toLowerCase());
      assert.strictEqual(await loopKeyAccount(LOOP), account, "cached per loop");
    });

    it("is null when the file is gone", async () => {
      await authorized(new FakeKeychain());
      deleteLoopKeyFile(LOOP);
      assert.isNull(await loopKeyAccount(LOOP));
    });

    it("refuses a file whose address is not its private key's, or whose root is another treasury", async () => {
      const key = await authorized(new FakeKeychain());
      const file = JSON.parse(fs.readFileSync(key.file, "utf8"));
      fs.writeFileSync(
        key.file,
        JSON.stringify({ ...file, address: privateKeyToAccount(generatePrivateKey()).address })
      );
      setTempoKeyChainForTests(new FakeKeychain().hooks()); // drops the cache
      assert.match((await rejects(loopKeyAccount(LOOP))).message, /names 0x.*but its private key is/);
      fs.writeFileSync(key.file, JSON.stringify({ ...file, root: privateKeyToAccount(generatePrivateKey()).address }));
      assert.match((await rejects(loopKeyAccount(LOOP))).message, /not on this treasury/);
    });
  });

  describe("the limit target", () => {
    const row = (channelId: string, deposit: string, closed: boolean, settled?: string): LoopKeyChannelRow => ({
      channelId,
      deposit,
      closed,
      ...(settled !== undefined ? { settled } : {}),
    });

    it("is limitBase less what closed channels settled and what open ones hold", () => {
      const rows = [
        row("a", "300000", true, "120000"), // closed: its settlement, not its deposit
        row("b", "200000", false), // open: its whole deposit
        row("charge-1", "5000", true, "5000"), // a storage charge the key signed: never restored
        row("charge-2", "2500", true, "2500"),
      ];
      assert.equal(loopKeyLimitTarget("1000000", rows), BigInt(1_000_000 - 120_000 - 200_000 - 5_000 - 2_500));
      assert.equal(loopKeyLimitTarget("1000000", []), BigInt(1_000_000));
    });

    it("counts a closed channel's whole deposit when what it settled is unknown", () => {
      assert.equal(loopKeyLimitTarget("1000", [row("a", "400", true)]), BigInt(600));
    });

    it("floors at zero", () => {
      assert.equal(loopKeyLimitTarget("1000", [row("a", "900", false), row("b", "500", true, "500")]), BigInt(0));
    });

    it("refuses a row that is not base units", () => {
      assert.throws(() => loopKeyLimitTarget("1000", [row("a", "0.5", false)]), /base-unit integer/);
      assert.throws(() => loopKeyLimitTarget("1000", [row("a", "1", true, "-1")]), /base-unit integer/);
    });
  });

  describe("the update value, both readings of a limit update", () => {
    it("defaults to the remaining reading", () => {
      assert.equal(LIMIT_UPDATE_SETS, "remaining");
    });

    it("remaining: sends the target itself", () => {
      assert.equal(limitUpdateValue(BigInt(600), { remaining: BigInt(100) }, "remaining"), BigInt(600));
      assert.equal(limitUpdateValue(BigInt(0), { remaining: BigInt(100) }, "remaining"), BigInt(0));
    });

    it("total: sends what was spent plus the target, so the remaining becomes the target", () => {
      // total 1000, remaining 100: 900 spent; a target of 600 is a total of 1500.
      assert.equal(
        limitUpdateValue(BigInt(600), { remaining: BigInt(100), total: BigInt(1000) }, "total"),
        BigInt(1500)
      );
      assert.equal(limitUpdateValue(BigInt(0), { remaining: BigInt(0), total: BigInt(1000) }, "total"), BigInt(1000));
    });

    it("total: refuses without the limit in force, or with a remaining above it", () => {
      assert.throws(() => limitUpdateValue(BigInt(1), { remaining: BigInt(1) }, "total"), /limit in force is unknown/);
      assert.throws(
        () => limitUpdateValue(BigInt(1), { remaining: BigInt(5), total: BigInt(4) }, "total"),
        /refusing to update/
      );
      assert.throws(() => limitUpdateValue(BigInt(-1), { remaining: BigInt(0) }, "remaining"), /negative/);
    });
  });

  describe("reconciling", () => {
    it("sends nothing when Tempo already says the target", async () => {
      const chain = new FakeKeychain();
      const key = await authorized(chain, "1000000");
      chain.spend(key.address, BigInt(200_000)); // the open channel's deposit, counted by the keychain
      chain.calls = [];
      const r = await reconcileLoopKeyLimit(LOOP, [{ channelId: "a", deposit: "200000", closed: false }]);
      assert.deepEqual(r, { target: "800000", sent: false });
      assert.notInclude(chain.ops(), "updateLimit");
    });

    it("restores what a close refunded, sending the target once and nothing on the second call", async () => {
      const chain = new FakeKeychain();
      const key = await authorized(chain, "1000000");
      chain.spend(key.address, BigInt(300_000)); // opened at 0.3, closed having paid 0.12
      const rows = [{ channelId: "a", deposit: "300000", settled: "120000", closed: true }];
      const r = await reconcileLoopKeyLimit(LOOP, rows);
      assert.equal(r.target, "880000");
      assert.isTrue(r.sent);
      assert.match(r.txHash!, /^0x[0-9a-f]{64}$/);
      const update = chain.calls.find((c) => c.op === "updateLimit")!;
      assert.equal(update.args.limit, BigInt(880_000));
      assert.equal(chain.remaining(key.address), BigInt(880_000));
      chain.calls = [];
      assert.deepEqual(await reconcileLoopKeyLimit(LOOP, rows), { target: "880000", sent: false });
      assert.notInclude(chain.ops(), "updateLimit");
    });

    it("lowers the limit too when the keychain holds more than the formula allows", async () => {
      const chain = new FakeKeychain();
      const key = await authorized(chain, "1000000");
      const r = await reconcileLoopKeyLimit(LOOP, [{ channelId: "c", deposit: "5000", settled: "5000", closed: true }]);
      assert.equal(r.target, "995000");
      assert.equal(chain.remaining(key.address), BigInt(995_000));
    });

    it("under the total reading, sends spent plus target and reads the limit in force to size it", async () => {
      const chain = new FakeKeychain("total");
      const key = await authorized(chain, "1000000");
      setTempoKeyChainForTests({ ...chain.hooks(), limitUpdateSets: "total" });
      chain.spend(key.address, BigInt(300_000));
      const r = await reconcileLoopKeyLimit(LOOP, [
        { channelId: "a", deposit: "300000", settled: "120000", closed: true },
      ]);
      assert.equal(r.target, "880000");
      const update = chain.calls.find((c) => c.op === "updateLimit")!;
      assert.equal(update.args.limit, BigInt(300_000 + 880_000));
      assert.equal(chain.remaining(key.address), BigInt(880_000));
      const reads = chain.calls.filter((c) => c.op === "readState");
      assert.isTrue(reads.every((c) => c.args.wantTotal?.limitBase === "1000000" && !!c.args.wantTotal.authorizeTx));
    });

    it("throws when the update left the key above its target (the update read the wrong way round)", async () => {
      // The module believes "total"; this chain sets the remaining amount. Spent + target as a
      // remaining is over the cap, and the recheck must say so rather than return.
      const chain = new FakeKeychain("remaining");
      const key = await authorized(chain, "1000000");
      setTempoKeyChainForTests({ ...chain.hooks(), limitUpdateSets: "total" });
      chain.spend(key.address, BigInt(300_000));
      const e = await rejects(
        reconcileLoopKeyLimit(LOOP, [{ channelId: "a", deposit: "300000", settled: "120000", closed: true }])
      );
      // Fails closed: the key is shut (limit 0, under either reading) before the throw.
      assert.instanceOf(e, LoopKeyOverCapError);
      assert.isTrue((e as LoopKeyOverCapError).zeroed);
      assert.match(e.message, /above its target 880000.*its limit was set to 0/);
      const updates = chain.calls.filter((c) => c.op === "updateLimit").map((c) => c.args.limit);
      assert.deepEqual(updates, [BigInt(300_000 + 880_000), BigInt(0)]);
      assert.equal(chain.remaining(key.address), BigInt(0));
    });

    it("still throws over-cap, saying how to revoke, when the update to zero fails too", async () => {
      const chain = new FakeKeychain("remaining");
      const key = await authorized(chain, "1000000");
      const base = chain.hooks();
      setTempoKeyChainForTests({
        ...base,
        limitUpdateSets: "total",
        updateLimit: async (o) => {
          if (o.limit === BigInt(0)) throw new Error("rpc down");
          return base.updateLimit(o);
        },
      });
      chain.spend(key.address, BigInt(300_000)); // so spent + target, read as a remaining, is over the cap
      const e = await rejects(
        reconcileLoopKeyLimit(LOOP, [{ channelId: "c", deposit: "10", settled: "10", closed: true }])
      );
      assert.instanceOf(e, LoopKeyOverCapError);
      assert.isFalse((e as LoopKeyOverCapError).zeroed);
      assert.include(e.message, `revoke it from the treasury by address ${key.address}`);
    });

    it("throws, never skips, when the recheck after an update cannot be read", async () => {
      const chain = new FakeKeychain();
      await authorized(chain, "1000");
      const base = chain.hooks();
      let reads = 0;
      setTempoKeyChainForTests({
        ...base,
        readState: async (o) => {
          // The first two reads size the update (outside and under the lock); the recheck fails.
          if (++reads > 2) throw new Error("rpc.tempo.xyz unreachable");
          return base.readState(o);
        },
      });
      const e = await rejects(
        reconcileLoopKeyLimit(LOOP, [{ channelId: "c", deposit: "10", settled: "10", closed: true }])
      );
      assert.instanceOf(e, LoopKeyLimitUnknownError);
      assert.match(e.message, /could not be read back after 0x[0-9a-f]{64} set it for 990/);
    });

    it("throws a distinct unknown-outcome error, carrying Tempo's reason, when an update fails and the key does not read its target", async () => {
      const chain = new FakeKeychain();
      await authorized(chain, "1000");
      setTempoKeyChainForTests(
        chain.hooks({
          updateLimit: async () => {
            throw Object.assign(new Error("x"), { shortMessage: "Account keychain error: KeyExpired" });
          },
        })
      );
      const e = await rejects(reconcileLoopKeyLimit(LOOP, [{ channelId: "a", deposit: "1", closed: true }]));
      assert.instanceOf(e, LoopKeyLimitUnknownError);
      assert.match(e.message, /KeyExpired/);
      assert.match(e.message, /outcome is unknown: the key now reads 1000 remaining/);
      deleteLoopKeyFile(LOOP);
      assert.match((await rejects(reconcileLoopKeyLimit(LOOP, []))).message, /no key file/);
    });

    it("throws a retryable read failure, and sends nothing, when the key cannot be read before an update", async () => {
      const chain = new FakeKeychain();
      await authorized(chain, "1000");
      setTempoKeyChainForTests(
        chain.hooks({
          readState: async () => {
            throw new Error("getRemainingLimit timed out");
          },
        })
      );
      const before = chain.ops().length;
      const e = await rejects(reconcileLoopKeyLimit(LOOP, [{ channelId: "a", deposit: "1", closed: true }]));
      assert.instanceOf(e, LoopKeyReadFailedError);
      assert.isTrue(LoopKeyReadFailedError.is({ name: "LoopKeyReadFailedError" }), "matched by name across copies");
      assert.match(e.message, /timed out.*nothing was sent/);
      assert.notInclude(chain.ops().slice(before), "updateLimit");
    });

    it("is unknown too when the state cannot be read after a failed update", async () => {
      const chain = new FakeKeychain();
      await authorized(chain, "1000");
      const base = chain.hooks();
      let reads = 0;
      setTempoKeyChainForTests({
        ...base,
        updateLimit: async () => {
          throw new Error("timed out waiting for the receipt");
        },
        readState: async (o) => {
          if (++reads > 2) throw new Error("rpc down");
          return base.readState(o);
        },
      });
      const e = await rejects(reconcileLoopKeyLimit(LOOP, [{ channelId: "a", deposit: "1", closed: true }]));
      assert.instanceOf(e, LoopKeyLimitUnknownError);
      assert.match(e.message, /could not be read back/);
    });

    it("accepts an update that errored after it landed, when the key reads its target", async () => {
      const chain = new FakeKeychain();
      const key = await authorized(chain, "1000");
      const base = chain.hooks();
      setTempoKeyChainForTests({
        ...base,
        updateLimit: async (o) => {
          await base.updateLimit(o);
          throw new Error("timed out waiting for the receipt");
        },
      });
      const r = await reconcileLoopKeyLimit(LOOP, [{ channelId: "a", deposit: "100", closed: true }]);
      assert.deepEqual(r, { target: "900", sent: true });
      assert.equal(chain.remaining(key.address), BigInt(900));
    });

    it("shuts the key when an update errored but left it above its target", async () => {
      // The module believes "total"; the chain sets the remaining amount, applies, then the answer is lost.
      const chain = new FakeKeychain("remaining");
      const key = await authorized(chain, "1000");
      const base = chain.hooks();
      setTempoKeyChainForTests({
        ...base,
        limitUpdateSets: "total",
        updateLimit: async (o) => {
          const hash = await base.updateLimit(o);
          if (o.limit !== BigInt(0)) throw new Error("timed out waiting for the receipt");
          return hash;
        },
      });
      chain.spend(key.address, BigInt(400));
      const e = await rejects(
        reconcileLoopKeyLimit(LOOP, [{ channelId: "a", deposit: "400", settled: "100", closed: true }])
      );
      assert.instanceOf(e, LoopKeyOverCapError);
      assert.equal(chain.remaining(key.address), BigInt(0));
    });

    it("recomputes the target under the lock from rowsUnderLock", async () => {
      const chain = new FakeKeychain();
      const key = await authorized(chain, "1000");
      const stale = [{ channelId: "a", deposit: "100", settled: "40", closed: true }];
      const fresh = [...stale, { channelId: "b", deposit: "300", closed: false }];
      chain.spend(key.address, BigInt(400));
      const r = await reconcileLoopKeyLimit(LOOP, stale, { rowsUnderLock: async () => fresh });
      assert.equal(r.target, "660");
      assert.equal(chain.remaining(key.address), BigInt(660));
    });
  });

  describe("revoking", () => {
    it("revokes from the treasury, then deletes the file", async () => {
      const chain = new FakeKeychain();
      const key = await authorized(chain);
      const hash = await revokeLoopKey(LOOP);
      assert.match(hash!, /^0x[0-9a-f]{64}$/);
      const revoke = chain.calls.find((c) => c.op === "revoke")!;
      assert.deepEqual(revoke.args, { root: treasury.address, key: key.address });
      assert.isFalse(fs.existsSync(key.file));
      assert.isNull(await loopKeyAccount(LOOP));
    });

    it("is null when there is no key, and keeps the file when the revoke fails", async () => {
      assert.isNull(await revokeLoopKey(LOOP));
      const key = await authorized(new FakeKeychain());
      setTempoKeyChainForTests(
        new FakeKeychain().hooks({
          revoke: async () => {
            throw new Error("rpc down");
          },
        })
      );
      assert.match((await rejects(revokeLoopKey(LOOP))).message, /revoking the Tempo key .* failed: rpc down/);
      assert.isTrue(fs.existsSync(key.file));
    });
  });

  describe("reading a key's state", () => {
    it("answers by address, with no file needed", async () => {
      const chain = new FakeKeychain();
      const key = await authorized(chain, "5000");
      chain.spend(key.address, BigInt(1_200));
      deleteLoopKeyFile(LOOP);
      const state = await loopKeyState({ address: key.address, token: key.token });
      assert.deepEqual(state, { remaining: "3800", expiry: key.expiry, isRevoked: false });
    });

    it("is null when the reader throws", async () => {
      setTempoKeyChainForTests(
        new FakeKeychain().hooks({
          readState: async () => {
            throw new Error("rpc.tempo.xyz unreachable");
          },
        })
      );
      assert.isNull(await loopKeyState({ address: treasury.address, token: TEMPO_USDC_E }));
    });
  });

  describe("call scopes", () => {
    const savedKeys = process.env.LATH_TEMPO_LOOP_KEYS;
    const savedScopes = process.env.LATH_TEMPO_KEY_SCOPES;
    afterEach(() => {
      if (savedKeys === undefined) delete process.env.LATH_TEMPO_LOOP_KEYS;
      else process.env.LATH_TEMPO_LOOP_KEYS = savedKeys;
      if (savedScopes === undefined) delete process.env.LATH_TEMPO_KEY_SCOPES;
      else process.env.LATH_TEMPO_KEY_SCOPES = savedScopes;
    });

    it("are exactly three: USDC.e transferWithMemo to the payee, then the escrow's topUp and open, all lower-case", () => {
      assert.deepEqual(loopKeyScopes(PAYEE), [
        {
          address: "0x20c000000000000000000000b9537d11c60e8b50",
          selector: "0x95777d59",
          recipients: [PAYEE.toLowerCase()],
        },
        { address: "0x4d50500000000000000000000000000000000000", selector: "0xdc48471e" },
        { address: "0x4d50500000000000000000000000000000000000", selector: "0xedc53b00" },
      ]);
      assert.equal(TEMPO_USDC_E, "0x20c000000000000000000000b9537d11c60e8b50");
      assert.equal(TEMPO_ESCROW, "0x4d50500000000000000000000000000000000000");
      // Only the transfer names recipients; the escrow scopes carry no `recipients` key at all.
      for (const s of loopKeyScopes(PAYEE).filter((s) => s.address === TEMPO_ESCROW))
        assert.notProperty(s, "recipients");
    });

    it("hold each selector to the installed mppx and viem, and to the shape viem's own Scopes builders make", async () => {
      assert.equal(toFunctionSelector("open(address,address,address,uint96,bytes32,address)"), ESCROW_OPEN_SELECTOR);
      assert.equal(
        toFunctionSelector("topUp((address,address,address,address,bytes32,address,bytes32),uint96)"),
        ESCROW_TOP_UP_SELECTOR
      );
      assert.equal(toFunctionSelector("transferWithMemo(address,uint256,bytes32)"), TIP20_TRANSFER_WITH_MEMO_SELECTOR);

      // The ABI mppx encodes the open and the top-up from (ChannelOps.js imports it by this path).
      const { escrowAbi } = await dynamicImport(
        path.join(NODE_MODULES, "mppx", "dist", "tempo", "session", "precompile", "escrow.abi.js")
      );
      const fn = (name: string) => escrowAbi.find((x: any) => x.type === "function" && x.name === name);
      assert.equal(toFunctionSelector(fn("open")), ESCROW_OPEN_SELECTOR);
      assert.equal(toFunctionSelector(fn("topUp")), ESCROW_TOP_UP_SELECTOR);
      const { tip20ChannelEscrow } = await dynamicImport(
        path.join(NODE_MODULES, "mppx", "dist", "tempo", "session", "precompile", "Protocol.js")
      );
      assert.equal(tip20ChannelEscrow.toLowerCase(), TEMPO_ESCROW);

      const { Actions, Addresses, Scopes, Selectors } = await dynamicImport("viem/tempo");
      assert.equal(Addresses.tip20ChannelReserve.toLowerCase(), TEMPO_ESCROW);
      assert.equal(Selectors.tip20ChannelReserve.open, ESCROW_OPEN_SELECTOR);
      assert.equal(Selectors.tip20ChannelReserve.topUp, ESCROW_TOP_UP_SELECTOR);
      assert.equal(Selectors.tip20.transferWithMemo, TIP20_TRANSFER_WITH_MEMO_SELECTOR);
      // What mppx's charge builds: `Actions.token.transfer.call` with a memo, which must encode as
      // the scoped selector or every keyed storage charge would be refused.
      const charge = Actions.token.transfer.call({ token: TEMPO_USDC_E, to: PAYEE, amount: BigInt(200), memo: "0x01" });
      assert.equal(charge.functionName, "transferWithMemo");
      assert.equal(encodeFunctionData(charge).slice(0, 10), TIP20_TRANSFER_WITH_MEMO_SELECTOR);

      const lower = (s: any) => ({
        address: s.address.toLowerCase(),
        ...(s.selector ? { selector: s.selector } : {}),
        ...(s.recipients ? { recipients: s.recipients.map((r: string) => r.toLowerCase()) } : {}),
      });
      const escrow = Scopes.contract(TEMPO_ESCROW, Selectors.tip20ChannelReserve);
      const viemBuilt = [
        Scopes.tip20(TEMPO_USDC_E).transferWithMemo({ recipients: [PAYEE] }),
        escrow.topUp(),
        escrow.open(),
      ].map(lower);
      assert.deepEqual(loopKeyScopes(PAYEE), viemBuilt);
    });

    it("refuse a payee that is not an address, or is zero", () => {
      for (const bad of ["", "0x1234", "0x" + "0".repeat(40), "not an address", undefined as any]) {
        assert.throws(() => loopKeyScopes(bad), /storage payee is not an address/, String(bad));
      }
    });

    it("are on with the keys unless LATH_TEMPO_KEY_SCOPES says off, and never without the keys", () => {
      delete process.env.LATH_TEMPO_LOOP_KEYS;
      for (const v of [undefined, "", "on", "off"]) {
        if (v === undefined) delete process.env.LATH_TEMPO_KEY_SCOPES;
        else process.env.LATH_TEMPO_KEY_SCOPES = v;
        assert.isFalse(loopKeyScopesEnabled(), `keys off, scopes ${v}`);
      }
      process.env.LATH_TEMPO_LOOP_KEYS = "on";
      delete process.env.LATH_TEMPO_KEY_SCOPES;
      assert.isTrue(loopKeyScopesEnabled(), "keys on, scopes unset");
      for (const v of ["", "1", "on", "yes", "anything"]) {
        process.env.LATH_TEMPO_KEY_SCOPES = v;
        assert.isTrue(loopKeyScopesEnabled(), `keys on, scopes ${JSON.stringify(v)}`);
      }
      for (const v of ["off", "0", "false", "no", "OFF", " Off "]) {
        process.env.LATH_TEMPO_KEY_SCOPES = v;
        assert.isFalse(loopKeyScopesEnabled(), `keys on, scopes ${JSON.stringify(v)}`);
      }
    });

    it("round-trip through the key file and the LoopKey, normalised; an unscoped key's file has no scopes key", () => {
      const scopes = loopKeyScopes(PAYEE);
      const key = createLoopKey(LOOP, "3000", in30Days(), scopes);
      assert.deepEqual(key.scopes, scopes);
      const file = JSON.parse(fs.readFileSync(key.file, "utf8"));
      assert.deepEqual(file.scopes, scopes);

      const bare = createLoopKey("loop-fedcba9876543210", "3000", in30Days());
      assert.notProperty(bare, "scopes");
      assert.notProperty(JSON.parse(fs.readFileSync(bare.file, "utf8")), "scopes");
    });

    it("are normalised by createLoopKey from any order and case, and a malformed or empty list writes nothing", () => {
      const shuffled = [
        {
          address: TEMPO_ESCROW.toUpperCase().replace("0X", "0x"),
          selector: ESCROW_OPEN_SELECTOR.toUpperCase().replace("0X", "0x"),
        },
        { address: TEMPO_USDC_E, selector: TIP20_TRANSFER_WITH_MEMO_SELECTOR, recipients: [PAYEE, treasury.address] },
        { address: TEMPO_ESCROW, selector: ESCROW_TOP_UP_SELECTOR },
      ];
      const key = createLoopKey(LOOP, "3000", in30Days(), shuffled);
      assert.deepEqual(key.scopes, [
        {
          address: TEMPO_USDC_E,
          selector: TIP20_TRANSFER_WITH_MEMO_SELECTOR,
          recipients: [PAYEE.toLowerCase(), treasury.address.toLowerCase()].sort(),
        },
        { address: TEMPO_ESCROW, selector: ESCROW_TOP_UP_SELECTOR },
        { address: TEMPO_ESCROW, selector: ESCROW_OPEN_SELECTOR },
      ]);
      deleteLoopKeyFile(LOOP);

      const bad: any[] = [
        [],
        [{ address: "0x1234" }],
        [{ address: TEMPO_ESCROW, selector: "0x1234" }],
        [{ address: TEMPO_USDC_E, recipients: [PAYEE] }],
        [{ address: TEMPO_USDC_E, selector: TIP20_TRANSFER_WITH_MEMO_SELECTOR, recipients: ["nobody"] }],
        // Empty reads as "pays no one" here and as "pays anyone" to the keychain.
        [{ address: TEMPO_USDC_E, selector: TIP20_TRANSFER_WITH_MEMO_SELECTOR, recipients: [] }],
      ];
      for (const scopes of bad) {
        assert.throws(() => createLoopKey(LOOP, "3000", in30Days(), scopes), /scope/, JSON.stringify(scopes));
        assert.isFalse(fs.existsSync(loopKeyFilePath(LOOP)), JSON.stringify(scopes));
      }
    });

    it("are sent with the authorize when the file has them, and no scopes key is sent when it has none", async () => {
      const seen: any[] = [];
      const chain = new FakeKeychain();
      setTempoKeyChainForTests(
        chain.hooks({
          authorize: async (o) => {
            seen.push(o);
            return { txHash: tx(seen.length), status: "success" };
          },
        })
      );
      const scopes = loopKeyScopes(PAYEE);
      const scoped = await authorizeLoopKey(createLoopKey(LOOP, "3000", in30Days(), scopes));
      assert.deepEqual(seen[0].scopes, scopes);
      assert.deepEqual(scoped.scopes, scopes);
      assert.deepEqual(JSON.parse(fs.readFileSync(scoped.file, "utf8")).scopes, scopes);

      await authorizeLoopKey(createLoopKey("loop-fedcba9876543210", "3000", in30Days()));
      assert.notProperty(seen[1], "scopes");
      assert.deepEqual(Object.keys(seen[1]).sort(), ["expiry", "key", "limit", "root", "token"]);
    });

    it("hand viem's authorizeSync a scopes field only for a scoped key; an unscoped one is the unscoped call exactly", () => {
      const o = { key: treasury.address, token: TEMPO_USDC_E, limit: BigInt(3000), expiry: 1_900_000_000 };
      const bare = loopKeyAuthorizeArgs(o);
      assert.notProperty(bare, "scopes");
      // The object an unscoped `realChain.authorize` passes, literally (sequential nonce: no nonceKey).
      assert.deepEqual(bare, {
        accessKey: { address: o.key, type: "secp256k1" },
        expiry: o.expiry,
        limits: [{ token: o.token, limit: o.limit }],
      });
      const scopes = loopKeyScopes(PAYEE);
      const scoped = loopKeyAuthorizeArgs({ ...o, scopes });
      assert.deepEqual(scoped, { ...bare, scopes });
      assert.notStrictEqual((scoped as any).scopes, scopes, "a copy, so viem cannot reach back into the file's terms");
    });

    it("are terms of the key: a caller's copy whose scopes differ from the file's is refused and nothing is sent", async () => {
      const chain = new FakeKeychain();
      setTempoKeyChainForTests(chain.hooks());
      const key = createLoopKey(LOOP, "3000", in30Days(), loopKeyScopes(PAYEE));
      const { scopes: _dropped, ...unscoped } = key;
      const e = await rejects(authorizeLoopKey(unscoped as typeof key));
      assert.match(e.message, /does not match its file/);
      assert.notInclude(chain.ops(), "authorize");
    });

    it("cover the loop-key cap shot: a direct escrow open, encoded from mppx's ABI, is inside them", async () => {
      const { escrowAbi } = await dynamicImport(
        path.join(NODE_MODULES, "mppx", "dist", "tempo", "session", "precompile", "escrow.abi.js")
      );
      const data = encodeFunctionData({
        abi: escrowAbi,
        functionName: "open",
        args: [PAYEE, treasury.address, TEMPO_USDC_E, BigInt(6000), `0x${"11".repeat(32)}`, treasury.address],
      });
      const scopes = loopKeyScopes(PAYEE);
      assert.isTrue(
        scopes.some((s) => s.address === TEMPO_ESCROW && s.selector === data.slice(0, 10)),
        "the cap shot's open is a scoped call, so a refusal it meets is the limit's, not CallNotAllowed"
      );
    });
  });
});
