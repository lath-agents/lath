/**
 * Fills a cluster with enough state for the web app to be worth looking at, and prints the env
 * that points at it.
 *
 * ```bash
 * # devnet — the only cluster this project runs on. The RPC is LATH_DEVNET_RPC
 * # or the solana CLI config; ANCHOR_WALLET (default ~/.config/solana/id.json) funds the seed keys.
 * # LATH_SEED_SECRET is mandatory here — see "Why devnet needs a secret" below.
 * LATH_SEED_SECRET="$(openssl rand -hex 32)" \
 *   npx ts-node -P ./tsconfig.json scripts/seed.ts --devnet --e2e-wallet > frontend/.env.devnet.e2e
 * * ```
 *
 * ## Why devnet needs a secret
 *
 * A `seeded(label)` that hashed a public string and nothing else would, on devnet, give every
 * reader of this repo the private keys that hold real escrow in the *deployed* treasury, the
 * allowance grant, and the authority of the seeded agent chain. A reader could withdraw the
 * escrow, revoke the grant, sign console auth messages as that wallet, append to the chain, or
 * `close_agent` it and spend `sha256(name)` for good.
 *
 * So on `--devnet` the preimage mixes in `LATH_SEED_SECRET`, which this repository does not
 * contain, and the script refuses to seed devnet at all when it is unset. Keep it: it *is* the
 * custody of those accounts, and a different value is a different, unfunded set of keys.
 *
 * `NEXT_PUBLIC_E2E_WALLET_SECRET` is a separate mechanism and is not a substitute. It is an
 * *output*: with `--e2e-wallet` this script prints the seed user's full secret key into the env
 * file so the browser suite can sign without a wallet extension. `LATH_SEED_SECRET` is the
 * *input* the key is derived from, one level up — the E2E secret is one of the keys it produces,
 * so rotating `LATH_SEED_SECRET` invalidates every previously printed E2E env file, and a
 * leaked E2E env file exposes only that one wallet, never the agent authority or the admin.
 *
 * **Already exposed, and not this script's to repair:** older devnet fixtures — `seed-agent-alpha`'s
 * authority and the seed user's escrow — were derived from public labels and stay
 * world-derivable forever. Re-seeding under a secret produces *new* keys; it does not rescue the
 * old ones. An operator has to withdraw the old escrow and re-seed. Note that the new authority
 * cannot append to the existing `seed-agent-alpha`
 * chain — only the key that signed `register_agent` ever can — so a devnet rerun skips every
 * agent write that already exists and only re-grants the allowance under the new keys; a fixture
 * that must be *written* again needs a fresh name.
 *
 * On devnet the treasury already exists under the real admin and the mint is Circle's devnet
 * USDC, which this script cannot mint: the seed user is funded with SOL from `ANCHOR_WALLET`,
 * deposits only what its USDC account already holds (fund it at faucet.circle.com — the address
 * is printed), and the seed agent's authority is funded the same way. Blobs go to
 * `frontend/.traces-devnet`, the directory the devnet console serves.
 *
 * Creates: a USDC-shaped mint, a treasury, a user with a deposit, an agent authority the user
 * funds through an allowance, one agent chain with all four event kinds on it, a `Log`, a `Map`
 * and a `Set` on that agent, and a consumable `Log` on it in the shape a mailbox has. The
 * marketplace is on the roadmap: devnet still holds a second agent's chain, `seed-blueprint-alpha`,
 * with a launch-priced `agent.offer`, and nothing here seeds it.
 * Every keypair is derived deterministically (from the labels
 * plus `LATH_SEED_SECRET`), so rerunning against the same cluster with the same
 * secret tops up the same accounts instead of making new ones.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRpc } from "@lightprotocol/stateless.js";
import { DEVNET_GENESIS, assertCluster } from "./_cluster";
import { getAccount, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  AgentLogger,
  AnchoredEpochStore,
  BillingClient,
  EventInput,
  EventKind,
  hex,
  idFromString,
  LathClient,
  LathLog,
  LathMap,
  LathSet,
  AnchoredTraceStore,
  FsLocatorBackend,
  LocatorRegistry,
  LocatorScheme,
  NameRecord,
  payloadPreimage,
  ResolutionStatus,
  sha256,
  USDC_DECIMALS,
  toEventInput,
  utf8,
} from "../sdk/src";

// devnet is the only cluster this script seeds. `--devnet` is still accepted so run sheets that pass it keep working.
const CLUSTER: SeedCluster = "devnet";

function devnetRpc(): string {
  const fromEnv = process.env.LATH_DEVNET_RPC;
  if (fromEnv) return fromEnv;
  try {
    const out = execSync("solana config get", { encoding: "utf8" });
    const m = /^RPC URL:\s*(\S+)/m.exec(out);
    if (m && /devnet/.test(m[1])) return m[1];
  } catch {
    // no CLI; fall through to the error below
  }
  throw new Error("seeding needs LATH_DEVNET_RPC (a ZK-compression devnet RPC) or a devnet url in `solana config`");
}

const USDC = (n: number) => BigInt(Math.round(n * 10 ** USDC_DECIMALS));

/** The real devnet treasury admin (docs/ARCHITECTURE.md §12); the seed reads its treasury, never creates one. */
const DEVNET_TREASURY_ADMIN = process.env.NEXT_PUBLIC_TREASURY_ADMIN ?? "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";

/** Where the seeded agent's traces land, and the URL `e2e/serve-traces` puts them behind. */
const TRACE_DIR = process.env.LATH_TRACE_DIR ?? path.join(__dirname, "..", "frontend", ".traces-devnet");
const TRACE_GATEWAY = process.env.LATH_TRACE_GATEWAY ?? "http://127.0.0.1:3112";

/**
 * `"localnet"` is not a mode: nothing seeds a local validator. It stays only because
 * `lattice-seed-localnet:` is a frozen derivation input pinned by `tests/seed-keys.ts`
 * (docs/ARCHITECTURE.md §13).
 */
export type SeedCluster = "devnet" | "localnet";

/**
 * Short enough to type, long enough that the derivation is not a dictionary away. A one-character
 * secret fails closed for the same reason an empty one does: it is guessable, so the keys it
 * derives are as exposed as the ones this check exists to replace.
 */
export const SEED_SECRET_MIN_LENGTH = 16;

// Only the variable's name is the product's: the secret's value is mixed into the derivation below
// as `sha256(secret)`, so the same value under this name derives the same keys as it does under
// `LATTICE_SEED_SECRET`.
export const SEED_SECRET_ENV = "LATH_SEED_SECRET";

/**
 * The secret folded into the devnet derivation, or `null` for the frozen `localnet` input. Throws
 * rather than falling back, because the fallback is precisely the world-derivable
 * key this guard exists to prevent — an unset variable must stop the run, not quietly seed the shared
 * cluster with keys anyone can sign for.
 *
 * Read from an explicit environment rather than `process.env` directly so the guard is testable
 * without mutating the process.
 */
export function seedSecret(cluster: SeedCluster, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cluster === "localnet") return null;
  const secret = (env[SEED_SECRET_ENV] ?? "").trim();
  if (!secret) {
    throw new Error(
      `seeding needs ${SEED_SECRET_ENV}: devnet seed keys hold real escrow in the deployed treasury and the ` +
        `authority of the seeded agent, so they must not be derivable from this repository. ` +
        `Generate one once, keep it, and pass it every run: export ${SEED_SECRET_ENV}="$(openssl rand -hex 32)". ` +
        `A different value derives a different, unfunded set of keys.`
    );
  }
  if (secret.length < SEED_SECRET_MIN_LENGTH) {
    throw new Error(
      `${SEED_SECRET_ENV} is ${secret.length} characters; at least ${SEED_SECRET_MIN_LENGTH} are needed for the ` +
        `derivation not to be guessable. Use \`openssl rand -hex 32\`.`
    );
  }
  return secret;
}

/**
 * Deterministic keypairs so a rerun is idempotent rather than additive.
 *
 * The frozen `localnet` input is deliberately public (nothing uses it as a mode).
 * Devnet mixes in
 * `LATH_SEED_SECRET`, so the same label on the same cluster yields a different key for every
 * operator and none for a reader of this repo.
 *
 * The secret enters as `sha256(secret)` rather than raw, so its length never shifts the label's
 * position in the preimage and the raw value cannot surface in a preimage dumped while debugging.
 *
 * The two domain strings below keep the old `lattice-` spelling and are frozen there. They are key
 * *derivation* inputs, not prose: the devnet agent authority, the seed user's wallet and the mint
 * all exist on devnet under the keys these exact preimages produce. Renaming the domain derives a
 * different, unfunded set and orphans every seeded agent — only the key that signed
 * `register_agent` may ever append to its chain. The product is Lath; these bytes are not.
 */
export function seedKeypair(label: string, cluster: SeedCluster, env: NodeJS.ProcessEnv = process.env): Keypair {
  const secret = seedSecret(cluster, env);
  const preimage =
    secret === null ? `lattice-seed-localnet:${label}` : `lattice-seed-devnet:${hex(sha256(utf8(secret)))}:${label}`;
  return Keypair.fromSeed(sha256(utf8(preimage)).slice(0, 32));
}

function seeded(label: string): Keypair {
  return seedKeypair(label, CLUSTER);
}

/** The wallet that funds the devnet seed keys: `ANCHOR_WALLET`, else the solana CLI's default. */
function funder(): Keypair {
  const walletPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
}

const log = (...args: unknown[]) => console.error(...args);

async function main() {
  // Fail before a single network call: on devnet an unset secret means world-derivable keys, and
  // the very next thing this script does is fund them and deposit escrow to them.
  seedSecret(CLUSTER);

  // One hosted url serves JSON-RPC, Photon and the prover on devnet. Resolved here, not at load:
  // `tests/seed-keys.ts` imports this file for its key derivation, and CI has no devnet RPC.
  const rpcUrl = devnetRpc();
  const rpc = createRpc(rpcUrl, rpcUrl, rpcUrl, { commitment: "confirmed" });
  // Before the funder's first transfer: nothing above says which cluster the url is, and the next
  // thing this does is send SOL from the operator's key (`_cluster.ts`).
  await assertCluster(rpc, DEVNET_GENESIS, "devnet");

  // On devnet the admin is the deployed treasury's admin, read-only here; `funder()` signs the
  // SOL transfers and is usually that same key (~/.config/solana/id.json).
  const admin = funder();
  const adminPubkey = new PublicKey(DEVNET_TREASURY_ADMIN);
  const user = seeded("user");
  const agentAuthority = seeded("agent-authority");

  // Faucet SOL is rate-limited per address; a transfer from the operator's key is not.
  const floor = 0.3 * LAMPORTS_PER_SOL;
  for (const [label, kp] of [
    ["seed user (the E2E wallet)", user],
    ["seed agent authority", agentAuthority],
  ] as const) {
    const balance = await rpc.getBalance(kp.publicKey);
    if (balance < floor) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: kp.publicKey,
          lamports: 0.5 * LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTransaction(rpc, tx, [admin], { commitment: "confirmed" });
      log(`${label} ${kp.publicKey.toBase58()} funded with 0.5 SOL from ${admin.publicKey.toBase58()}`);
    }
  }

  const billing = (kp: Keypair) => BillingClient.fromIdl(rpc, kp, { admin: adminPubkey });
  const adminBilling = billing(admin);
  const userBilling = billing(user);

  let treasury = await adminBilling.getTreasury();
  let mint: PublicKey;
  if (treasury) {
    mint = treasury.usdcMint;
    log(`treasury already exists (${adminBilling.treasuryAddress().toBase58()})`);
  } else {
    throw new Error(`no treasury under admin ${adminPubkey.toBase58()} on this cluster (docs/ARCHITECTURE.md §12)`);
  }

  // The user's USDC lives in their **associated** token account, not a keypair-owned one.
  // `getOrCreateAssociatedTokenAccount` is also what makes a rerun a top-up rather than a
  // failure on "account already in use".
  //
  // The app derives the ATA (`getAssociatedTokenAddressSync`), so USDC parked in a keypair-owned
  // account is invisible to it and /billing would show "this wallet has no USDC account" while
  // holding 500. A seed that a real
  // wallet cannot see is not a seed.
  const userToken = (await getOrCreateAssociatedTokenAccount(rpc, user, mint, user.publicKey)).address;
  // Circle's mint: nothing to mint. Deposit what the faucet put in the account, once, and say
  // where to get more — every billed session draws on this escrow.
  const held = (await getAccount(rpc, userToken)).amount;
  const escrow = await userBilling.getBalance(user.publicKey);
  if (!escrow && held > 0n) {
    await userBilling.deposit({ amount: held, usdcMint: mint, userToken });
    log(`seed user deposited ${Number(held) / 10 ** USDC_DECIMALS} USDC into the treasury`);
  } else if (!escrow) {
    log(
      `seed user ${user.publicKey.toBase58()} holds no devnet USDC: send it 20 from https://faucet.circle.com (Solana Devnet) and rerun — until then sessions are unbilled`
    );
  }
  await userBilling.approveAgent({
    agentAuthority: agentAuthority.publicKey,
    cap: USDC(40),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    policyVersionHash: sha256(utf8("seed-policy-v1")),
  });

  // One agent chain with all four primitives on it.
  const agentName = "seed-agent-alpha";
  const agentId = idFromString(agentName);
  // The counterparty of the seeded Delegation. Nothing registers it: a Delegation records who
  // the work went to, and only the other half, on that agent's own chain, completes the pair.
  const peerId = idFromString("seed-agent-beta");
  const lath = LathClient.fromIdl(rpc, agentAuthority);

  /**
   * The agent's traces go to a directory whose filenames are ids the backend picked, and the
   * `sha256 → id` mapping goes on the agent's own chain. Serving that directory over HTTP is
   * then a complete gateway, which is what `TRACE_DIR` / `NEXT_PUBLIC_TRACE_GATEWAY` below give
   * the app — the same path a real Irys deployment takes, with a directory standing in for
   * the network.
   */
  const registry = new LocatorRegistry(lath, agentId);
  const store = new AnchoredTraceStore(
    new FsLocatorBackend(TRACE_DIR, { scheme: LocatorScheme.Raw, encoding: "hex" }),
    registry
  );
  // `storePayloads` so the app and the auditor can walk payload_hash → sub-hashes; without it
  // every trace resolves to "not anchored" and the panel has nothing to show.
  const logger = new AgentLogger(lath, agentId, { store, storePayloads: true });

  if (await logger.ensureRegistered()) {
    // The registry has to exist before the first trace is anchored, and `ensureRegistered` is
    // what created the header it hangs off.
    await registry.ensureCreated();
    await logger.genesis({
      sessionId: "seed-session",
      caller: user.publicKey,
      policyVersionHash: sha256(utf8("seed-policy-v1")),
      input: { goal: "summarise the quarter" },
    });
    await logger.action({
      toolId: "http.get",
      args: { url: "https://example.com" },
      result: { ok: true },
      statusCode: 200,
    });
    await logger.action({ toolId: "db.write", args: { rows: 3 }, result: { error: "timeout" }, statusCode: 504 });
    await logger.delegate({ parentTaskId: "seed-task", to: peerId, scope: { role: "worker" } });
    await logger.resolve({
      taskId: "seed-task",
      status: ResolutionStatus.Success,
      output: { summary: "done" },
      totalStepCount: 3,
    });
    log(`agent ${agentName} registered and logged`);
  }

  /**
   * One rollup epoch on the same chain: four steps folded into a single Merkle root and a
   * single `commit_epoch` write, with the blob published `root → locator` in the same registry
   * the traces use. That is what lets a browser fetch the blob, rebuild the root, and prove one
   * step's inclusion against the root the chain folded (`sdk/src/rollup.ts`, SPEC.md §15).
   * Guarded on the chain's own epoch list, so a rerun does not add a second one.
   */
  const epochStore = new AnchoredEpochStore(store.backend, registry);
  if ((await lath.listEpochs(agentId)).length === 0) {
    const steps = [
      { toolId: "http.get", args: { url: "https://example.com/a" }, result: { bytes: 1204 }, statusCode: 200 },
      { toolId: "http.get", args: { url: "https://example.com/b" }, result: { bytes: 880 }, statusCode: 200 },
      { toolId: "db.write", args: { rows: 2 }, result: { ok: true }, statusCode: 200 },
      { toolId: "db.write", args: { rows: 1 }, result: { error: "conflict" }, statusCode: 409 },
    ];
    const inputs: EventInput[] = [];
    for (const s of steps) {
      // The same three blobs a logged action stores, so an epoch step's payload_hash and the
      // sub-hashes inside it resolve through the gateway exactly as a record's do.
      const argsHash = await store.put(utf8(JSON.stringify(s.args)));
      const resultHash = await store.put(utf8(JSON.stringify(s.result)));
      const payload = {
        kind: EventKind.Action as const,
        toolId: s.toolId,
        argsHash,
        resultHash,
        statusCode: s.statusCode,
      };
      await store.put(payloadPreimage(payload));
      inputs.push(toEventInput(payload, Date.now()));
    }
    const commit = await lath.createEpochCommitter(agentId, epochStore)(inputs);
    log(
      `agent ${agentName} committed one epoch: seq ${commit.startSeq}–${commit.endSeq - 1n}, root ${hex(
        commit.epochRoot
      ).slice(0, 16)}…`
    );
  }

  // The agent publishes its own name: `sha256(name) == agent_id`, so a reader checks it by
  // re-hashing and no registry has to be trusted for it.
  const nameRecord = new NameRecord(lath, agentId);
  if (await nameRecord.ensureCreated()) {
    await nameRecord.publish(agentName);
    log(`agent ${agentName} published its own name`);
  }

  // One of each base structure, so the app's data-structures view has something to show. Values
  // are kept under 32 bytes on purpose: they then live in the `value_slot` itself and a reader
  // with no trace store still sees them, which is the case the view has to make legible.
  const notes = new LathLog(lath, agentId, LathLog.id("notes"), { store });
  if (await notes.ensureCreated()) {
    await notes.append("quarter summary drafted", { tag: 1, status: 200 });
    await notes.append("sources checked", { tag: 1, status: 200 });
    await notes.append("db.write retried", { tag: 2, status: 504 });
    log("agent log `notes` seeded with 3 entries");
  }

  const memo = new LathMap(lath, agentId, LathMap.id("memo"), { store });
  if (await memo.ensureCreated()) {
    await memo.put("model", "claude-opus-5");
    await memo.put("quarter", "2026-Q2");
    await memo.put("retries", "1");
    await memo.replace("retries", "2");
    log("agent map `memo` seeded with 3 keys (one replaced)");
  }

  const tools = new LathSet(lath, agentId, LathSet.id("tools"), { store });
  if (await tools.ensureCreated()) {
    await tools.add("http.get");
    await tools.add("db.write");
    log("agent set `tools` seeded with 2 members");
  }

  // A consumable Log on the agent — the shape a mailbox has, so the view shows a queue too.
  const inbox = new LathLog(lath, agentId, LathLog.id("mailbox"), { store, consumable: true });
  if (await inbox.ensureCreated()) {
    await inbox.append("task: summarise", { tag: 1 });
    await inbox.append("task: verify", { tag: 1 });
    await inbox.append("task: publish", { tag: 1 });
    await inbox.consume(0);
    log("agent mailbox seeded with 3 messages, 1 consumed");
  }

  // stdout is the env file; everything else went to stderr.
  // `scripts/dev-devnet.sh --e2e` sources this file. The cluster, RPC, admin and mint come from
  // the script itself; only the gateway the browser reads blobs through and the E2E key are
  // the seed's to say.
  console.log(`# seeded on devnet ${new Date().toISOString()} — sourced by \`npm run dev:devnet -- --e2e\``);
  console.log(`NEXT_PUBLIC_TRACE_GATEWAY="${TRACE_GATEWAY}"`);
  if (process.argv.includes("--e2e-wallet")) {
    // Opt-in, so a `.env.local` a developer generates by habit holds no key at all. The adapter
    // that reads it refuses to load outside a development build anyway
    // (`frontend/src/lib/e2e-wallet.ts`); this flag is the first of those fences, not the only
    // one.
    console.log(`NEXT_PUBLIC_E2E_WALLET_SECRET='${JSON.stringify(Array.from(user.secretKey))}'`);
  }
  console.log(`# user wallet     ${user.publicKey.toBase58()}`);
  console.log(`# agent authority ${agentAuthority.publicKey.toBase58()}`);
  console.log(`# agent id        ${Buffer.from(agentId).toString("hex")}`);
}

// Guarded so `seedKeypair` / `seedSecret` can be imported by `tests/seed-keys.ts` without the
// import seeding anything. The CLI is unchanged: run as a script, this still runs `main`.
if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
