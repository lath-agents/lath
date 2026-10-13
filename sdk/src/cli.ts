/**
 * `lath-audit` — the command line an external auditor runs, with no checkout of this repo:
 *
 * ```bash
 * npm run -s audit -- <agent id> --rpc "https://devnet.helius-rpc.com/?api-key=…"
 * npm run -s audit -- --name agent-alpha --store .lath-traces --recover
 * npm run -s audit -- <agent id> --store .lath-traces --json
 * ```
 *
 * Exit codes: `0` verified, `1` the hash chain does not replay, `2` traces are missing,
 * `3` the agent is not registered or the arguments are wrong, `4` the replay never reached
 * `AgentState.head` — the chain is unchecked rather than wrong, which is what a chain logged
 * entirely with `log_event_compact` looks like without `--recover` — or the chain folded epochs
 * and no reader was given for them (`--epochs`, `--store` or `--gateway`): the steps inside an
 * epoch exist only in its blob, so an audit that never opened it has checked none of them.
 *
 * There is one other subcommand, `reanchor`, which uploads epoch blobs that fell back to a local
 * directory during an outage and repoints their locator cells:
 *
 * ```bash
 * npm run -s audit -- reanchor <agent id> --rpc "…" --keypair ~/.config/…/id.json \
 *   --epochs .traces-devnet --scheme 4 --irys-network devnet
 * ```
 *
 * And one more, `verify-inference`, which answers the payment question rather than the chain one:
 * the LLM call at a seq committed a Tempo voucher in the blob its `result_hash` names, and this
 * checks that voucher against the channel it was signed on:
 *
 * ```bash
 * npm run -s audit -- verify-inference <agent id> 7 --rpc "$R" --gateway https://gateway.irys.xyz --scheme 4
 * ```
 *
 * and `verify-channel`, which asks the same question of a whole channel. A loop's channel covers
 * every one of its steps, so the deltas of its vouchers must add up to what the escrow's
 * `ChannelClosed` paid out:
 *
 * ```bash
 * npm run -s audit -- verify-channel <agent id> --rpc "$R" --gateway https://gateway.irys.xyz --scheme 4
 * ```
 *
 * and `verify-step`, which asks the loop question: a step whose loop ran with a verifier committed
 * a decision blob's hash as the ninth key of its `loop.step` manifest, and this re-hashes the
 * blob, checks the verdict against what the step did with its memory, and checks the voucher
 * rode the loop's channel:
 *
 * ```bash
 * npm run -s audit -- verify-step <agent id> 12 --rpc "$R" --gateway https://gateway.irys.xyz --scheme 4
 * ```
 *
 * A step a roadmap feature wrote (a team, a gate, a trace audit, a protocol plugin) is reported as
 * such by `verify-step` and never called verified: this build has no `verify-plugins` or
 * `verify-improve`, and no gate, team or trace-audit checks in `verify-step`, because those features
 * are on the roadmap.
 *
 * And `verify-charge`, the charge sibling of `verify-channel`: every Tempo storage PUT a loop recorded
 * as a `storage.put` Action, held to the one Tempo transfer its receipt names, and every snapshot
 * and receipt a leaf carries paired with its step. It reads Tempo over the free RPC; the auditor pays
 * nothing.
 *
 * Their exit codes are the audit's read the same way: `0` VERIFIED, `4` PENDING — the channel is
 * open, or Tempo could not be read, so nothing is settled and nothing is wrong — `2` FAILED or
 * nothing to check, `3` bad arguments.
 *
 * And `verify-receipt`, which reads a loop's receipt on the Solana Attestation Service and holds it
 * to the records it points at: the account at the address the committed pointer and the loop id
 * derive, on the committed credential, schema and signer; its agent and loop; a `loop.step` of that
 * loop at its seq that is the loop's last, records the goal reached, and whose leaf commits its head;
 * its step count and goal as the manifests commit them. Its money fields are printed as the console
 * reported them. The receipt is an index into the chain, not a proof of it. Exit codes: `0`
 * VERIFIED, `1` a contradiction, `2` nothing to check or a reader that did not answer:
 *
 * ```bash
 * npm run -s audit -- verify-receipt <agent id> --rpc "$R" --store frontend/.traces-devnet
 * ```
 *
 * `reanchor` is a subcommand rather than a `--reanchor` flag on the audit because it is the opposite kind
 * of command: the audit is read-only and runs on a signer that refuses to sign, while this one
 * spends the uploader's Irys balance and writes cells to the agent's chain. A verification that
 * could write if a flag were mistyped is not a verification. Nothing calls it automatically — a
 * session that fell back reports it and stops there, and an operator decides when to pay.
 *
 * The audit itself lives in `audit.ts` and touches no Node built-in; everything node-shaped —
 * argv, the filesystem store, the process exit — is here, and this entry is never part of
 * `@lath/sdk/browser`.
 */
import { createRpc } from "@lightprotocol/stateless.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  audit,
  billingChargeDebit,
  channelsExitCode,
  chargesExitCode,
  exitCode,
  formatChannels,
  formatCharges,
  formatInference,
  formatKeyLines,
  formatReport,
  formatStepVerify,
  inferenceExitCode,
  stepVerifyExitCode,
  verifyChannels,
  verifyCharges,
  verifyInference,
  verifyStepDecision,
  type AuditReport,
  type ChannelsReport,
} from "./audit";
import { TEMPO_RPC_URL, TempoRpcReader } from "./tempo";
import { blindBetween, walkChain } from "./audit/core";
import type { SolanaTxReader, SolanaTxView } from "./audit/solana";
import {
  formatReceipt,
  type ReceiptAccountReader,
  receiptsExitCode,
  receiptsStatus,
  verifyReceiptLoops,
} from "./audit/receipt";
import { listSteps } from "./loops";
import { binaryCommand } from "./binary-audit";
import { BundledTraceStore, isSessionScoped, type SessionScopedTraceStore } from "./bundle";
import { LathClient } from "./client";
import { hex, toBytes32 } from "./hash";
import { idFromString } from "./hash";
import { traceStoreBackend, type TraceStore } from "./trace-store";
import {
  AnchoredEpochStore,
  HttpGatewayBackend,
  IRYS_ENCODING,
  IRYS_GATEWAY,
  type LocatorBackend,
  type LocatorEncoding,
  LocatorRegistry,
  LocatorScheme,
  reanchorEpochs,
} from "./locator";
import { EncryptedTraceStore, FsLocatorBackend } from "./trace-store-node";
import { IrysBackend, type IrysNetwork } from "./irys";
import { type EpochStore } from "./rollup";
import { FileEpochStore, FileTraceStore } from "./trace-store-node";

export const USAGE = [
  "usage: lath-audit <agent id hex|pubkey> [--name <string>] [--rpc url] [--store <dir>]",
  "       --rpc defaults to $LATH_DEVNET_RPC, then $LATH_RPC_URL, then `solana config`'s devnet url",
  "       [--gateway <url>] [--registry <name>] [--scheme <n>] [--encoding hex|base64url] [--irys-gateway <url>]",
  "       [--indexer url] [--prover url] [--recover] [--traces <file|hex,hex>]",
  "       [--epochs <dir>] [--require-preimages] [--name-check] [--json] [--trace-key <hex|path>]",
  "       --trace-key opens an owner-encrypted agent's blobs: 64 hex characters, or a file of them.",
  "       Without it their preimages report as encrypted rather than unavailable: an audit without",
  "       --require-preimages still verifies (the owner chose not to show them), one with it ends NOT",
  "       VERIFIED (exit 4), because the preimages it asked for were not read. --require-preimages",
  "       with no --store or --gateway reads nothing either, and is NOT VERIFIED (exit 4) the same way.",
  "       Exit 0 verified, 1 the chain does not replay, 2 traces or epoch blobs missing or disagreeing,",
  "       3 bad arguments, 4 not checked: the replay never reached the head (try --recover); a mid-chain",
  "       gap no compact write in history accounts for, e.g. a record the RPC does not return (try",
  "       --recover); the chain has epochs and nothing opened them (pass --epochs <dir>, --store or",
  "       --gateway); encrypted preimages not opened under --require-preimages (pass --trace-key); or",
  "       --require-preimages with no preimage reader (pass --store or --gateway).",
  "       Lifecycle records (agent.deploy, loop.start/pause/resume/stop) are held to the owner's",
  "       signatures they carry and the deploy transaction; a failed one is exit 2. --trace-key also",
  "       opens their private halves. A chain without them prints no deploy or loops line.",
  "       lath-audit reanchor <agent id|--name n> --keypair <path> --epochs <dir>",
  "       [--rpc url] [--scheme 0|4] [--irys-network devnet|mainnet] [--gateway url] [--registry <name>]",
  "       lath-audit verify-inference <agent id|--name n> <seq> [--rpc url] [--tempo-rpc url]",
  "       [--store <dir>] [--gateway url] [--epochs <dir>] [--scheme 0|4] [--encoding hex|base64url]",
  "       [--registry <name>] [--payer 0x…] [--payee 0x…] [--json] [--trace-key <hex|path>]",
  "       --payer is who paid the seq being verified: the operator's Tempo treasury for a v2 record,",
  "       the agent's derived Tempo address for a v1 one. Without --store/--gateway: no preimage.",
  "       --payee is whom the close must have paid: the model gateway's payee. Without it a close that",
  "       paid its own payer still fails; the payee and the channel's token (USDC.e, from its open) print.",
  "       --store and --gateway layer: the directory answers first, the gateway for its --scheme next,",
  "       and scheme-4 locators always read through gateway.irys.xyz (--irys-gateway moves it).",
  "       lath-audit verify-channel <agent id|--name n> [--channel <0x…>] [--rpc url] [--tempo-rpc url]",
  "       [--store <dir>] [--gateway url] [--epochs <dir>] [--scheme 0|4] [--encoding hex|base64url]",
  "       [--registry <name>] [--payer 0x…] [--payee 0x…] [--json] [--trace-key <hex|path>] [--refetch]",
  "       [--margin 0.1]",
  "       every channel the chain paid through, or one: its vouchers' deltas, and the deltas of the",
  "       decisions its checkpoints commit, against what the escrow's ChannelClosed paid out. A loop's",
  "       channel covers all of its steps. --refetch reads each per-event call's transaction",
  "       and holds its billing debit to ceil(delta x (1 + margin)); a seq an epoch batched is not read.",
  "       Every close is held to --payee, else to the payee of the chain's first verified channel; one",
  "       closed to its own payer, or a channel opened in a token other than USDC.e, fails.",
  "       [--key]  on verify-inference, verify-channel and the audit itself: the loop's Tempo access key.",
  "       When the loop's Genesis policy commits a tempoKey, (a) its authorize transaction rooted that key",
  "       on the chain's payer with the committed expiry and limit, and (b) every channel was opened with",
  "       it as authorizedSigner and every voucher naming a signer names it; a mismatch fails, an",
  "       unreadable Tempo is unchecked, which holds verify-channel at PENDING (exit 4). It prints the",
  "       key line whenever a tempoKey is committed; --key asks for it by name, and says so when the",
  "       policy commits none.",
  "       lath-audit verify-charge <agent id|--name n> [--rpc url] [--tempo-rpc url] [--store <dir>]",
  "       [--gateway url] [--epochs <dir>] [--scheme 0|4] [--encoding hex|base64url] [--registry <name>]",
  "       [--payer 0x…] [--recipient 0x…] [--json] [--trace-key <hex|path>]",
  "       every Tempo storage PUT on the chain: its args, report and receipt re-hashed, and the Tempo",
  "       transaction its receipt names read for the USDC.e transfer payer -> recipient of its amount;",
  "       every snapshot and receipt a leaf carries paired with its step. Exit codes as verify-channel.",
  "       A transaction two receipts name fails the second. --payer pins every receipt's payer; without",
  "       it the payer is the chain's own vouchers' (the treasury), else the first receipt's. --recipient",
  "       pins every receipt's recipient (the storage gateway's payee); without it the first paid charge's,",
  "       and a scoped loop key's charges are held to the payees its policy commits. A charge in another",
  "       token, or one naming the payer or the escrow as recipient, fails.",
  "       lath-audit verify-step <agent id|--name n> <seq> [--rpc url] [--store <dir>] [--gateway url]",
  "       [--epochs <dir>] [--scheme 0|4] [--encoding hex|base64url] [--registry <name>] [--json]",
  "       [--tempo-rpc url] [--payer 0x…] [--recipient 0x…]",
  "       the second model's verdict on that loop step: the decision blob under the manifest's",
  "       verifyHash, re-hashed, matched against what the step did with its memory, and its",
  "       voucher checked against the loop's channel. 0 verified, 1 disagreement, 2 nothing to check.",
  "       On a loop that pays Tempo's storage and RPC, a storage line per PUT of the step's report",
  "       (key, amount, tx, verdict, the transfer read over --tempo-rpc) and the snapshot line (block,",
  "       the record that carried it, paired). A charge Tempo contradicts, or a carry that does not",
  "       pair, fails the step; one that could not be read changes nothing. The step's charges are held",
  "       to verify-charge's pins: --payer and --recipient as there, and a transaction an earlier",
  "       charge on the chain named fails.",
  "       A step a roadmap feature wrote (a team, a gate, a trace audit, a protocol plugin) prints a roadmap",
  "       line and is NOT VERIFIED (exit 2): this build does not verify those.",
  "       lath-audit verify-receipt <agent id|--name n> [--loop <id>] [--rpc url] [--store <dir>] [--gateway url]",
  "       [--epochs <dir>] [--scheme 0|4] [--encoding hex|base64url] [--registry <name>] [--json]",
  "       [--trace-key <hex|path>]",
  "       a loop's receipt on the Solana Attestation Service, for every loop whose policy commits one: the",
  "       account at the address its pointer and the loop id derive, read over --rpc, owned by SAS, on the",
  "       committed credential, schema and nonce and signed by the committed signer; its agent and loop;",
  "       a loop.step of that loop at its seq, the loop's last, recording the goal reached, whose leaf",
  "       commits its head; its step count and goal as the manifests commit them. The money fields are",
  "       printed as the console reported them, not re-derived. The receipt points at the records; the",
  "       audit checks them. A committed receipt with no account is not checked, unless the loop's last",
  "       step did not reach its goal (then none is due). 0 verified, 1 a contradiction, 2 nothing to",
  "       check or a reader that did not answer.",
  "       lath-audit binary <agent id|--name n> <seq> [--policy <console url|file>] [--local <path>] [--build]",
  "       [--rpc url] [--gateway url] [--scheme 0|4] [--store <dir>] [--trace-key <hex|path>] [--repo <dir>] [--json]",
  "       the ZeroClaw build a sandboxed step committed to, held to its Genesis, against the published builds,",
  "       this checkout's patches, a local binary, or zeroclaw/build.sh --expect (slow). 0 verified, 1 mismatch.",
  "       --posture-irys <id> reads the posture's copy on Irys (via --irys-gateway, default gateway.irys.xyz)",
  "       and holds its hash to the policy's posture; with no policy document it is the posture, unanchored.",
].join("\n");

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/**
 * The RPC url: `--rpc` when it is given, else `LATH_DEVNET_RPC` (or `LATH_RPC_URL`) from the
 * environment, else the devnet url in `solana config get`, else an error — there is no localhost
 * default, so a missing RPC fails here rather than as an empty chain read. The same order `scripts/irys.ts` and
 * `scripts/init-treasury.ts` already use.
 *
 * The flag is kept because typing a url is how an auditor with no checkout runs this. The
 * environment is there because a ZK-compression endpoint's query string *is* an API key: an
 * argument is readable by anything that can list processes, and it survives in `set -x` traces and
 * in any log line that echoes the command, which is how a nightly CI job would publish one. Nothing
 * here prints the url, so the key is not echoed either way.
 *
 * Each fallback is reached only when everything before it named nothing. The CLI fallback throws
 * when there is no devnet `solana config`, so it is never evaluated as `arg`'s default before
 * `--rpc` is looked at: an auditor on a clean machine — or one whose `solana config` points at
 * mainnet — could then not run the very line the console prints, `--rpc` and all.
 * @internal — exported for `tests/audit.ts`; `env` and `solanaConfig` are its seams.
 */
export function rpcArg(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  solanaConfig: () => string = solanaConfigDevnetRpc
): string {
  return arg(argv, "rpc") ?? env.LATH_DEVNET_RPC ?? env.LATH_RPC_URL ?? solanaConfig();
}

function solanaConfigDevnetRpc(): string {
  try {
    const out = execSync("solana config get", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /^RPC URL:\s*(\S+)/m.exec(out);
    if (m && /devnet/.test(m[1])) return m[1];
  } catch {
    // no CLI; fall through to the error below
  }
  throw new Error(
    "no RPC: pass --rpc, set LATH_DEVNET_RPC (a ZK-compression devnet RPC), or point `solana config` at devnet"
  );
}

/**
 * `--store` is a directory of blobs named by hex hash — what `FileTraceStore` writes.
 *
 * There is no remote backend (S3/MinIO, Postgres): a local content-addressed folder is enough for
 * reading a chain, and the durable answer is Irys behind the on-chain locator map rather than
 * another bucket.
 */
export function openStore(spec: string): FileTraceStore {
  return new FileTraceStore(path.resolve(spec));
}

/**
 * What the reader flags name, before anything is opened: the local directories (`--store` for
 * traces, `--epochs` for epoch blobs) and the gateways, one per scheme.
 *
 * The chain carries a scheme tag and never a url (SPEC §14.1), and one chain can carry both
 * schemes — a console chain that flipped from `fs` to `irys` has Raw locators before and Irys
 * ones after, and a console on the `irys` backend keeps its trace blobs in `LATH_TRACE_DIR`
 * while its epochs go to Irys. So the readers are not alternatives
 * but layers: `--store` names bytes on this disk, `--gateway` names where the `--scheme` it
 * came with is served, and scheme 4 always has somewhere to go — the Irys gateway is on every
 * plan that reads anything, without a flag, because a reader with an RPC needs nothing else to
 * resolve a scheme-4 locator. `--irys-gateway` moves it. Naming nothing keeps the audit
 * chain-only.
 */
export interface ReadPlan {
  store?: string;
  epochs?: string;
  gateways: { url: string; scheme: number; encoding: LocatorEncoding }[];
}

export function readPlan(argv: string[]): ReadPlan {
  const scheme = Number(arg(argv, "scheme", String(LocatorScheme.Raw)));
  if (!Number.isInteger(scheme) || scheme < 0 || scheme > 255) {
    throw new Error(`--scheme must be a u8, got ${arg(argv, "scheme")}`);
  }
  // Irys serves its ids in base64url and nothing else, so `--scheme 4` without `--encoding`
  // means base64url rather than the hex a raw directory uses. Spelling both out still works and
  // is what the console prints.
  const encoding = arg(argv, "encoding", scheme === LocatorScheme.Irys ? IRYS_ENCODING : "hex") as LocatorEncoding;
  if (encoding !== "hex" && encoding !== "base64url") {
    throw new Error(`--encoding is hex or base64url, got ${encoding}`);
  }
  const plan: ReadPlan = { store: arg(argv, "store"), epochs: arg(argv, "epochs"), gateways: [] };
  const explicit = arg(argv, "gateway");
  if (explicit) plan.gateways.push({ url: explicit, scheme, encoding });
  const named = explicit || plan.store || plan.epochs || arg(argv, "scheme") !== undefined;
  if (named && !plan.gateways.some((g) => g.scheme === LocatorScheme.Irys)) {
    plan.gateways.push({
      url: arg(argv, "irys-gateway", IRYS_GATEWAY)!,
      scheme: LocatorScheme.Irys,
      encoding: IRYS_ENCODING,
    });
  }
  return plan;
}

/** One scheme served from several places: the first that has the bytes answers. Read-only. */
class LayeredBackend implements LocatorBackend {
  constructor(readonly scheme: LocatorBackend["scheme"], private readonly layers: readonly LocatorBackend[]) {}
  async upload(): Promise<never> {
    throw new Error("lath-audit is read-only");
  }
  async download(id: Uint8Array): Promise<Uint8Array | null> {
    for (const layer of this.layers) {
      const bytes = await layer.download(id).catch(() => null);
      if (bytes) return bytes;
    }
    return null;
  }
}

/**
 * `--trace-key <hex|path>`: the 32 bytes an owner-encrypted agent's blobs were written under,
 * either as 64 hex characters or as the path of a file holding them. A path is the form to prefer —
 * an argument is readable by anything that can list processes, the same reason `--rpc` has an
 * environment form.
 */
function traceKeyArg(argv: string[]): Uint8Array | undefined {
  const spec = arg(argv, "trace-key");
  if (!spec) return undefined;
  const text = /^[0-9a-fA-F]{64}$/.test(spec.trim()) ? spec.trim() : fs.readFileSync(path.resolve(spec), "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error("--trace-key is 64 hex characters, or a path to a file of them");
  return toBytes32(text);
}

/**
 * The same store, read through the owner's key. `EncryptedTraceStore` is the decrypting half and
 * the store below is its backend, so every leg the flags built — the directory, the bundle, the
 * gateways — is unchanged and only the bytes coming back are opened. A blob that is not
 * ciphertext passes through, which is what keeps epoch blobs and bundles readable on a chain
 * whose traces are encrypted; `openSession` is forwarded, or one bundle per session would stop
 * being opened the moment a key is given.
 */
class KeyedTraceStore implements SessionScopedTraceStore {
  private readonly opener: TraceStore;
  constructor(private readonly inner: TraceStore, key: Uint8Array) {
    this.opener = new EncryptedTraceStore(traceStoreBackend(inner), key);
  }
  async put(): Promise<never> {
    throw new Error("lath-audit is read-only");
  }
  get(hash: Uint8Array): Promise<Uint8Array | null> {
    return this.opener.get(hash);
  }
  async openSession(genesisPayloadHash: Uint8Array): Promise<number> {
    return isSessionScoped(this.inner) ? this.inner.openSession(genesisPayloadHash) : 0;
  }
}

/**
 * Trace stores in order: a local directory answers by hash with no network, the gateways after it.
 *
 * With `--trace-key` each leg is opened with the key *before* they are layered, so a local blob
 * the key refuses falls through to the session's bundle rather than ending the read: the
 * directory's name can hold another agent's ciphertext of the same plaintext while the bundle
 * this agent sealed holds its own (`trace-store.ts`, "Two keys, one plaintext"). A refusal is
 * still the answer when no later leg has the bytes, so a blob that is truly not this key's reads
 * as unopenable, not as missing.
 */
class LayeredTraceStore implements SessionScopedTraceStore {
  constructor(private readonly local: TraceStore | undefined, private readonly remote: SessionScopedTraceStore) {}
  async put(): Promise<never> {
    throw new Error("lath-audit is read-only");
  }
  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    let refused: unknown = undefined;
    const local = this.local ? await this.local.get(hash).catch((e) => ((refused = e), null)) : null;
    if (local) return local;
    const remote = await this.remote.get(hash);
    if (remote || refused === undefined) return remote;
    throw refused;
  }
  openSession(genesisPayloadHash: Uint8Array): Promise<number> {
    return this.remote.openSession(genesisPayloadHash);
  }
}

/**
 * Epoch stores in order: `--epochs`, then each anchored reader, which answers only for its own scheme.
 *
 * A layer that answers `null` has said it does not hold the epoch; one that throws — an `--epochs`
 * directory this process cannot read (`FileEpochStore.get`), a registry read the RPC failed — has
 * said nothing. The later layers are still asked, because the audit re-derives the root from
 * whatever bytes come back (`verifyEpochBlob`), so a gateway copy is as good as the directory's and
 * an unreadable directory must not hide it. But when no layer has the bytes, the first error is the
 * answer, not `null`: the audit counts a `null` epoch as bytes nobody kept and fails the chain over
 * it, which a read that never happened cannot say. It surfaces as `lath-audit`'s error exit, as the
 * same throw does with `--epochs` alone, where the directory is the store with no layer around it.
 * @internal — exported for `tests/audit.ts`.
 */
export class LayeredEpochStore implements EpochStore {
  constructor(private readonly layers: readonly EpochStore[]) {}
  async put(): Promise<never> {
    throw new Error("lath-audit is read-only");
  }
  async anchor(): Promise<never> {
    throw new Error("lath-audit is read-only");
  }
  async get(root: Uint8Array): Promise<Uint8Array | null> {
    let failed: { error: unknown } | undefined;
    for (const layer of this.layers) {
      let bytes: Uint8Array | null;
      try {
        bytes = await layer.get(root);
      } catch (e) {
        failed ??= { error: e };
        continue;
      }
      if (bytes) return bytes;
    }
    if (failed) throw failed.error;
    return null;
  }
}

/**
 * The stores a plan opens: traces through a direct cell, then the bundle of the session being
 * walked, then by hash on the raw scheme only (`bundle.ts`); epochs through `root → locator` in
 * the owner's registry, the same way (`AnchoredEpochStore`). A console on the `fs` backend
 * anchors its epoch blobs into the directory `--store` names, addressed by hash under the Raw
 * scheme, so that directory is an epoch reader too. The registry is read from the audited
 * agent's own namespace, which is what stops a third party from answering for it.
 */
function openReads(
  client: LathClient,
  agentId: Uint8Array,
  argv: string[]
): { store?: TraceStore; epochs?: EpochStore } {
  const plan = readPlan(argv);
  const key = traceKeyArg(argv);
  const keyed = (store: SessionScopedTraceStore): SessionScopedTraceStore =>
    key ? new KeyedTraceStore(store, key) : store;
  const epochsDir = plan.epochs ? new FileEpochStore(path.resolve(plan.epochs)) : undefined;
  if (!plan.store && plan.gateways.length === 0) return { epochs: epochsDir };
  const registryName = arg(argv, "registry");
  const registry = new LocatorRegistry(client, agentId, registryName ? idFromString(registryName) : undefined);
  const byScheme = new Map<number, LocatorBackend[]>();
  const add = (b: LocatorBackend) => byScheme.set(b.scheme, [...(byScheme.get(b.scheme) ?? []), b]);
  if (plan.store) add(new FsLocatorBackend(path.resolve(plan.store), { scheme: LocatorScheme.Raw, encoding: "hex" }));
  for (const g of plan.gateways) add(new HttpGatewayBackend(g.url, { scheme: g.scheme, encoding: g.encoding }));
  const readers = [...byScheme.entries()].map(([scheme, layers]) =>
    layers.length === 1 ? layers[0] : new LayeredBackend(scheme as LocatorBackend["scheme"], layers)
  );
  const remote = new BundledTraceStore(registry, readers);
  // The local directory is opened with the key on its own backend rather than through the layer,
  // because only there can the key's variant name be read (`traceVariantName`).
  const local = plan.store ? openStore(plan.store) : undefined;
  const localKeyed = local && key ? new EncryptedTraceStore(local.backend, key) : local;
  return {
    store: local ? new LayeredTraceStore(localKeyed, keyed(remote)) : keyed(remote),
    epochs: new LayeredEpochStore([
      ...(epochsDir ? [epochsDir] : []),
      ...readers.map((r) => new AnchoredEpochStore(r, registry)),
    ]),
  };
}

function readTraceList(spec: string): string[] {
  const raw = fs.existsSync(spec) ? fs.readFileSync(spec, "utf8") : spec;
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Auditing is read-only, so there is no key to supply. `LathClient` still wants a signer for
 * its write paths; this one refuses to sign, which is the correct behaviour for an auditor.
 */
function readOnlySigner() {
  // Required lazily so importing this module never pulls web3.js into a caller that only wants
  // the usage string.
  const { PublicKey } = require("@solana/web3.js");
  return {
    publicKey: PublicKey.default,
    async signTransaction(): Promise<never> {
      throw new Error("lath-audit is read-only");
    },
  };
}

/** Values that follow a flag are not the positional agent id. */
function positionalOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) continue;
    if (i > 0 && argv[i - 1].startsWith("--")) continue;
    return argv[i];
  }
  return undefined;
}

/**
 * `reanchor` writes, so unlike the audit it needs a real key: the one that owns the agent, since
 * only the authority that signed `register_agent` may write cells on its chain, and on Irys the
 * same key is the uploader whose balance pays for the bytes.
 */
function keypairFrom(spec: string) {
  const { Keypair } = require("@solana/web3.js");
  const text = spec.trim().startsWith("[") ? spec : fs.readFileSync(path.resolve(spec), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
}

/**
 * Re-uploads the epoch blobs a failed upload left in `--epochs` and repoints their cells. Prints
 * one line per root as it goes, because each one is an upload and a transaction and an operator
 * watching an outage recovery wants to see it move.
 *
 * Exit codes: `0` nothing failed, `2` at least one blob could not be re-anchored (the same code
 * the audit uses for bytes it cannot get), `3` the arguments are wrong.
 */
async function reanchorCommand(argv: string[]): Promise<number> {
  const name = arg(argv, "name");
  const positional = positionalOf(argv);
  const keypair = arg(argv, "keypair");
  const dir = arg(argv, "epochs");
  if ((!positional && !name) || !keypair || !dir) {
    console.error(USAGE);
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(positional!);
  const rpcUrl = rpcArg(argv);
  const rpc = createRpc(rpcUrl, arg(argv, "indexer", rpcUrl)!, arg(argv, "prover", rpcUrl)!, {
    commitment: "confirmed",
  });
  const signer = keypairFrom(keypair);
  const client = LathClient.fromIdl(rpc, signer);
  const scheme = Number(arg(argv, "scheme", String(LocatorScheme.Irys)));
  let backend: LocatorBackend;
  if (scheme === LocatorScheme.Irys) {
    backend = new IrysBackend({
      wallet: signer,
      network: (arg(argv, "irys-network", "devnet") as IrysNetwork) ?? "devnet",
      rpc: rpcUrl,
      gateway: arg(argv, "gateway", IRYS_GATEWAY),
    });
  } else if (scheme === LocatorScheme.Raw) {
    // The development backend: the same directory the blobs are already in, so this only writes
    // the cells that were never written.
    backend = new FsLocatorBackend(path.resolve(dir), { scheme: LocatorScheme.Raw, encoding: "hex" });
  } else {
    console.error(`--scheme is 0 (raw) or 4 (Irys), got ${scheme}`);
    return 3;
  }

  const result = await reanchorEpochs({
    client,
    registry: new LocatorRegistry(
      client,
      agentId,
      arg(argv, "registry") ? idFromString(arg(argv, "registry")!) : undefined
    ),
    backend,
    fallback: new FileEpochStore(path.resolve(dir)),
    agentId,
    onRoot: (root, outcome, detail) => console.log(`${outcome.padEnd(10)} ${hex(root)}${detail ? `  ${detail}` : ""}`),
  });
  console.log(
    `re-anchored ${result.reanchored.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`
  );
  return result.failed.length ? 2 : 0;
}

/** Every value that is neither a flag nor the value of one, in order. */
function positionalsOf(argv: string[]): string[] {
  return argv.filter((v, i) => !v.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
}

/**
 * `verify-inference <agent id|--name n> <seq>` — did the LLM call at that seq get paid for, and
 * can anyone else see it?
 *
 * Read-only on both chains, like the audit and unlike `reanchor`: it reads the record, the blob
 * the record's `result_hash` names, and two things on Tempo — the receipt of the settlement the
 * chain named, or the channel the vouchers were signed against. No key, and nothing to sign.
 *
 * The voucher lives in the blob, not on Solana, so `--store <dir>` or `--gateway <url>` is what
 * makes an answer possible at all; without one the verdict is `no-preimage`. `--payer` is the
 * address the caller expects — the console prints it — and without it the payer is checked
 * against the agent's own other records and reported rather than asserted, because a verifier
 * holds no agent secret and cannot re-derive an address from one.
 *
 * A seq the rollup batched has no record account, only a step inside an epoch blob, so the same
 * `--epochs <dir>` / `--gateway` the audit resolves epochs with is what makes those seqs
 * answerable. Every Action a console session writes is one of them.
 *
 * Which address that is depends on the record: for a record on the pool (v2) it is the operator's
 * Tempo treasury, which `GET /api/tempo/treasury` prints, and for an older v1 record it is the
 * agent's own derived Tempo address, which the agent page prints beside its v1 wallet. A chain may
 * carry both, in that order — the verifier allows one such change and no more — so `--payer` names
 * the payer of *the seq being verified*, not of the chain.
 *
 * Exit codes: `0` VERIFIED, `4` PENDING (the channel is open, or Tempo could not be read — the
 * audit's code for *unchecked*), `2` FAILED or nothing to check, `3` the arguments are wrong.
 */
async function verifyInferenceCommand(argv: string[]): Promise<number> {
  const name = arg(argv, "name");
  const positionals = positionalsOf(argv);
  const seqArg = name ? positionals[0] : positionals[1];
  const idArg = name ? undefined : positionals[0];
  if ((!idArg && !name) || seqArg === undefined || !/^[0-9]+$/.test(seqArg)) {
    console.error(USAGE);
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(idArg!);
  const reads = paymentReads(argv, agentId);
  if (typeof reads === "number") return reads;

  const report = await verifyInference(reads.client, agentId, seqArg, { ...reads.opts, requireKey: flag(argv, "key") });

  if (flag(argv, "json")) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatInference(report)) console.log(line);
  return inferenceExitCode(report);
}

/**
 * The four reads both payment commands make — the chain, the blobs behind it, the epoch blobs a
 * rolled-up chain batched its Actions into, and Tempo — built from the same flags, so
 * `verify-channel` takes exactly the arguments `verify-inference` does. A number back is the exit
 * code of arguments that contradict each other.
 */
function paymentReads(
  argv: string[],
  agentId: Uint8Array
):
  | {
      client: LathClient;
      opts: {
        store?: TraceStore;
        reader: TempoRpcReader;
        epochs?: EpochStore;
        expectedPayer?: string;
        expectedPayee?: string;
        expectedRecipient?: string;
      };
    }
  | number {
  const rpcUrl = rpcArg(argv);
  const rpc = createRpc(rpcUrl, arg(argv, "indexer", rpcUrl)!, arg(argv, "prover", rpcUrl)!, {
    commitment: "confirmed",
  });
  const client = LathClient.fromIdl(rpc, readOnlySigner());
  return {
    client,
    opts: {
      ...openReads(client, agentId, argv),
      // Built unconditionally: it opens no connection until it is asked something, and a reader
      // that cannot be reached is a `pending`, not a crash.
      reader: new TempoRpcReader({ url: arg(argv, "tempo-rpc", TEMPO_RPC_URL) }),
      expectedPayer: arg(argv, "payer"),
      // `--payee`: the model gateway's payee, which verify-inference and verify-channel hold every
      // channel close to. The commands that read no close ignore it.
      expectedPayee: arg(argv, "payee"),
      // `--recipient`: the storage gateway's payee, which verify-charge and verify-step hold every
      // storage charge to. The payment commands that read no charge ignore it.
      expectedRecipient: arg(argv, "recipient"),
    },
  };
}

/**
 * `verify-channel <agent id|--name n> [--channel id]` — the same question as `verify-inference`
 * asked of a whole channel rather than one call.
 *
 * A loop holds one Tempo channel for all of its steps and closes it once, so a chain that ran a
 * loop carries every voucher that channel ever signed. Adding their deltas up gives what the
 * calls cost, and the `ChannelClosed` receipt the `loop.settlement` record names says what the
 * escrow paid the gateway; a chain that saw the channel from its open must make those the same
 * number. Every channel on the chain is checked unless `--channel` names one.
 *
 * Read-only, key-free, and the flags are `verify-inference`'s: `--store`/`--gateway` for the
 * blobs the vouchers live in, `--epochs`/`--gateway` for the seqs the rollup batched,
 * `--tempo-rpc` for the escrow, `--payer` for the address the caller expects.
 *
 * Exit codes: `0` VERIFIED, `4` PENDING (open, or Tempo could not be read — a committed loop key's
 * checks included), `2` FAILED or nothing to check, `3` the arguments are wrong.
 */
async function verifyChannelCommand(argv: string[]): Promise<number> {
  const name = arg(argv, "name");
  const idArg = name ? undefined : positionalsOf(argv)[0];
  if (!idArg && !name) {
    console.error(USAGE);
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(idArg!);
  const reads = paymentReads(argv, agentId);
  if (typeof reads === "number") return reads;

  // `--key` changes no verdict: the key line prints whenever the loop's policy commits a key, and
  // the flag only makes a chain without one say so, rather than print nothing about a check it asked for.
  const margin = marginBpsArg(argv);
  if (typeof margin === "number" && margin < 0) return 3;
  const report = await verifyChannels(reads.client, agentId, {
    ...reads.opts,
    channelId: arg(argv, "channel"),
    requireKey: flag(argv, "key"),
    // The debit read is one transaction per per-event call, so it is asked for.
    ...(flag(argv, "refetch") ? { debitOf: checkpointDebitReader(reads.client) } : {}),
    ...(margin !== undefined ? { marginBps: margin } : {}),
  });

  if (flag(argv, "json")) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatChannels(report)) console.log(line);
  return channelsExitCode(report);
}

/**
 * `verify-charge <agent id|--name n>` — the charge sibling of `verify-channel`. Every
 * `storage.put` on the chain is held to the transfer its receipt names, read over the free
 * `--tempo-rpc`, and every loop's carries are paired with their steps. The same reads and exit
 * codes as `verify-channel`.
 */
async function verifyChargeCommand(argv: string[]): Promise<number> {
  const name = arg(argv, "name");
  const idArg = name ? undefined : positionalsOf(argv)[0];
  if (!idArg && !name) {
    console.error(USAGE);
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(idArg!);
  const reads = paymentReads(argv, agentId);
  if (typeof reads === "number") return reads;

  const report = await verifyCharges(reads.client, agentId, reads.opts);

  if (flag(argv, "json")) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatCharges(report)) console.log(line);
  return chargesExitCode(report);
}

/**
 * `verify-step <agent id|--name n> <seq>` — did a second model judge that loop step, and does the
 * chain agree with what it said?
 *
 * Read-only and key-free like `verify-inference`, and it takes the same reads: `--store`/
 * `--gateway`/`--scheme` for the manifest and the decision blob, `--epochs`/`--gateway` for the
 * seqs the rollup batched, `--rpc` for the chain. The voucher check here is the blob's channel
 * against the chain's own vouchers, not the escrow's receipt, which is what `verify-inference` and
 * `verify-channel` are for. The one Tempo read it makes is for a step whose report a loop published
 * to Tempo storage: the transfer that paid for it, over `--tempo-rpc`.
 *
 * Exit codes: `0` VERIFIED, `1` the chain and the decision disagree, `2` nothing to check —
 * including a step that was never verified — `3` the arguments are wrong.
 */
async function verifyStepCommand(argv: string[]): Promise<number> {
  const name = arg(argv, "name");
  const positionals = positionalsOf(argv);
  const seqArg = name ? positionals[0] : positionals[1];
  const idArg = name ? undefined : positionals[0];
  if ((!idArg && !name) || seqArg === undefined || !/^[0-9]+$/.test(seqArg)) {
    console.error(USAGE);
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(idArg!);
  const reads = paymentReads(argv, agentId);
  if (typeof reads === "number") return reads;

  const report = await verifyStepDecision(reads.client, agentId, seqArg, reads.opts);

  if (flag(argv, "json")) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatStepVerify(report)) console.log(line);
  return stepVerifyExitCode(report);
}

/**
 * `verify-receipt <agent id|--name n> [--loop id]` — a loop's receipt on SAS held to the records it
 * points at, for every loop whose policy commits `receipt`, or the one `--loop` names. The same
 * reads as `verify-step`, the receipt's account over the same `--rpc`, and the head before each
 * `loop.step` from `listSteps`, which walks transaction history; when
 * that walk fails the record's leaf is what binds the receipt's head, and the line says so.
 *
 * Exit codes: `0` VERIFIED, `1` a contradiction, `2` nothing to check or a reader that did not answer,
 * `3` the arguments are wrong.
 */
async function verifyReceiptCommand(argv: string[]): Promise<number> {
  const name = arg(argv, "name");
  const idArg = name ? undefined : positionalsOf(argv)[0];
  if (!idArg && !name) {
    console.error(USAGE);
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(idArg!);
  const reads = paymentReads(argv, agentId);
  if (typeof reads === "number") return reads;
  const only = arg(argv, "loop");

  const walked = await walkChain(reads.client, agentId, reads.opts.epochs);
  // The chain's head before each checkpoint: a stronger read of the receipt's head than the leaf
  // alone. A history walk the RPC refuses leaves it out, and the leaf check still runs.
  const priorHeads = await listSteps(reads.client, agentId)
    .then((steps) => new Map(steps.map((s) => [s.seq.toString(), s.priorHead ? hex(s.priorHead) : null])))
    .catch(() => undefined);
  const result = await verifyReceiptLoops(
    agentId,
    walked.records,
    {
      store: reads.opts.store,
      accounts: solanaAccountReader(reads.client.rpc),
      blind: (from, to) => blindBetween(walked, from, to),
      ...(priorHeads ? { priorHeads } : {}),
    },
    only
  );

  const status = receiptsStatus(result);
  if (flag(argv, "json")) console.log(JSON.stringify(result, null, 2));
  else {
    if (!result.loops.length)
      console.log(`no receipts: no loop on this chain${only ? ` named ${only}` : ""} commits one`);
    for (const l of result.loops) {
      console.log(`loop       ${l.loopId}`);
      for (const line of formatReceipt(l)) console.log(`  ${line}`);
    }
    for (const u of result.unread) console.log(`not checkable: ${u}`);
    console.log("");
    console.log(status === "failed" ? "FAILED" : status === "unchecked" ? "NOT VERIFIED" : "VERIFIED");
  }
  return receiptsExitCode(result);
}

/**
 * Solana as `ReceiptAccountReader` reads it: one `getAccountInfo` at `confirmed`, the owner as base58.
 * A throw (an RPC that does not answer) makes the receipt unchecked, never failed.
 * @internal — exported for `tests/audit-receipt.ts`.
 */
export function solanaAccountReader(
  conn: Pick<import("@solana/web3.js").Connection, "getAccountInfo">
): ReceiptAccountReader {
  return {
    async getAccountInfo(address: string) {
      // Required lazily, as `readOnlySigner` does, so importing this module never pulls web3.js into a
      // caller that only wants the usage string.
      const { PublicKey } = require("@solana/web3.js") as typeof import("@solana/web3.js");
      const info = await conn.getAccountInfo(new PublicKey(address), "confirmed");
      return info ? { owner: info.owner.toBase58(), data: new Uint8Array(info.data) } : null;
    },
  };
}

/**
 * Solana as `SolanaTxReader` reads it: one `getTransaction` at `confirmed`, with
 * `maxSupportedTransactionVersion: 1` so a versioned transaction is not refused outright. The
 * signers are the message's first `numRequiredSignatures` keys; each instruction's accounts are
 * resolved through the transaction's own address-table lookups; token deltas are post − pre per
 * token account, summed by owner and mint. Account flags are not read: the message's are wider
 * than an instruction's (the fee payer shows signer-writable), and the audit compares keys by position.
 * web3.js 1.98.4 parses only legacy and v0 responses; a version it cannot parse throws here, which a
 * check reads as unchecked, never as failed. The lifecycle audit reads a deploy's transaction with it.
 */
export function solanaTxReader(conn: Pick<import("@solana/web3.js").Connection, "getTransaction">): SolanaTxReader {
  return {
    async getTransaction(signature: string): Promise<SolanaTxView | null> {
      const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
      if (!tx) return null;
      const message = tx.transaction.message;
      const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
      const key = (i: number) => keys.get(i)?.toBase58() ?? "";
      type Balance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
      const balances = new Map<number, { owner: string; mint: string; pre: bigint; post: bigint }>();
      const add = (b: Balance, post: boolean) => {
        const row = balances.get(b.accountIndex) ?? {
          owner: b.owner ?? key(b.accountIndex),
          mint: b.mint,
          pre: 0n,
          post: 0n,
        };
        if (post) row.post = BigInt(b.uiTokenAmount.amount);
        else row.pre = BigInt(b.uiTokenAmount.amount);
        balances.set(b.accountIndex, row);
      };
      for (const b of tx.meta?.preTokenBalances ?? []) add(b, false);
      for (const b of tx.meta?.postTokenBalances ?? []) add(b, true);
      const byOwner = new Map<string, { owner: string; mint: string; delta: bigint }>();
      for (const b of balances.values()) {
        const id = `${b.owner}:${b.mint}`;
        const row = byOwner.get(id) ?? { owner: b.owner, mint: b.mint, delta: 0n };
        row.delta += b.post - b.pre;
        byOwner.set(id, row);
      }
      return {
        slot: tx.slot,
        err: tx.meta?.err ?? null,
        signers: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((k) => k.toBase58()),
        instructions: message.compiledInstructions.map((ix) => ({
          programId: key(ix.programIdIndex),
          accounts: ix.accountKeyIndexes.map(key),
          data: Buffer.from(ix.data).toString("base64"),
        })),
        tokenDeltas: [...byOwner.values()].map((r) => ({ owner: r.owner, mint: r.mint, delta: r.delta.toString() })),
      };
    },
  };
}

/**
 * `--margin` as bps, `undefined` when absent, `-1` after printing why when it is not a margin. The
 * operator's margin is not on the chain, so it is a statement the auditor makes: a decimal as
 * `LATH_MARGIN` takes it, turned into bps the way the runtime turns it (`toMicroUsdcFromBase`).
 */
function marginBpsArg(argv: string[]): number | undefined {
  const marginArg = arg(argv, "margin");
  if (marginArg === undefined) return undefined;
  const m = Number(marginArg);
  if (!Number.isFinite(m) || m < 0) {
    console.error(`--margin: ${marginArg} is not a margin (0.1 is ten per cent)`);
    return -1;
  }
  return Math.round(m * 10_000);
}

/**
 * `--refetch`'s one read on `verify-channel`: what the transaction that wrote the record at a seq
 * debited through lath-billing `charge`, micro-USDC (`billingChargeDebit`), `null` when it cannot be
 * found or read — unchecked, not wrong.
 *
 * A record is a compressed account written once, so the only signatures that touched its address are
 * the one that created it: one indexer page and one transaction, instead of every transaction the agent
 * ever wrote. Only when that does not name exactly one transaction (a record the indexer does not hold
 * as an account) is the agent's history walked. Each read is memoised for the command's life; a read
 * that fails is dropped from the cache, so a later seq asks again rather than inheriting one 429.
 */
function checkpointDebitReader(
  client: Pick<LathClient, "rpc" | "eventAddress" | "recoverEventsFromHistory">
): (agentId: string, seq: bigint) => Promise<bigint | null> {
  const debits = new Map<string, Promise<bigint | null>>();
  const read = async (agentId: string, seq: bigint): Promise<bigint | null> => {
    const id = toBytes32(agentId);
    let signature: string | undefined;
    const page = await client.rpc
      .getCompressionSignaturesForAddress(client.eventAddress(id, seq), {})
      .catch(() => null);
    if (page?.items.length === 1) signature = page.items[0].signature;
    else {
      const records = await client.recoverEventsFromHistory(id);
      signature = records.find((r) => r.seq === seq)?.signature;
    }
    if (!signature) return null;
    const tx = await client.rpc.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) return null;
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined,
    });
    return billingChargeDebit(
      tx.transaction.message.compiledInstructions.map((ix) => ({
        programId: keys.get(ix.programIdIndex)?.toBase58() ?? "",
        data: ix.data,
      }))
    );
  };
  return (agentId, seq) => {
    const key = `${hex(toBytes32(agentId))}@${seq}`;
    let p = debits.get(key);
    if (!p) {
      p = read(agentId, seq);
      debits.set(key, p);
      p.catch(() => debits.delete(key));
    }
    return p.catch(() => null);
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // `npx @lath/sdk lath-audit …` can hand the bin name through as argv[0]; drop it so
  // both invocation shapes behave the same.
  if (argv[0] === "lath-audit") argv = argv.slice(1);
  if (flag(argv, "help") || flag(argv, "h")) {
    console.log(USAGE);
    return 0;
  }
  // The one subcommand. It is matched before the positional agent id is read, so `reanchor` is
  // never mistaken for one.
  if (argv[0] === "reanchor") return reanchorCommand(argv.slice(1));
  if (argv[0] === "verify-inference") return verifyInferenceCommand(argv.slice(1));
  if (argv[0] === "verify-channel") return verifyChannelCommand(argv.slice(1));
  if (argv[0] === "verify-charge") return verifyChargeCommand(argv.slice(1));
  if (argv[0] === "verify-step") return verifyStepCommand(argv.slice(1));
  // Named and refused rather than read as an agent id: a reader who meets one of these names
  // should learn that the command is not in this build, not that "verify-plugins" is not a hex id.
  // `verify-feed` and `verify-request` check the oracle's proof transactions, which this build does
  // not read.
  if (["verify-plugins", "verify-improve", "verify-feed", "verify-request"].includes(argv[0])) {
    console.error(`${argv[0]} is not in this build: the feature it audits is on the roadmap`);
    return 3;
  }
  if (argv[0] === "verify-receipt") return verifyReceiptCommand(argv.slice(1));
  if (argv[0] === "binary") return binaryCommand(argv.slice(1), (id) => paymentReads(argv.slice(1), id));

  const positional = positionalOf(argv);
  const name = arg(argv, "name");
  if (!positional && !name) {
    console.error(USAGE);
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(positional!);

  const rpcUrl = rpcArg(argv);
  const rpc = createRpc(rpcUrl, arg(argv, "indexer", rpcUrl)!, arg(argv, "prover", rpcUrl)!, {
    commitment: "confirmed",
  });
  const client = LathClient.fromIdl(rpc, readOnlySigner());

  const tracesArg = arg(argv, "traces");

  const report = await audit(client, agentId, {
    ...openReads(client, agentId, argv),
    recover: flag(argv, "recover"),
    traceHashes: (tracesArg ? readTraceList(tracesArg) : []).map((h) => toBytes32(h)),
    requirePreimages: flag(argv, "require-preimages"),
    // Off unless asked: it is a second account fetch, and it answers a different question from
    // "does this chain replay". When it is on, a name only prints if it re-hashes to the id.
    resolveName: flag(argv, "name-check"),
    // The deploy and loop lifecycle records, held to the owner's signatures they carry. A chain with
    // none prints no lifecycle lines; the deploy transaction is read over the same RPC, and the
    // private halves open through the store only when `--trace-key` keyed it.
    lifecycle: { tx: solanaTxReader(rpc), keyed: traceKeyArg(argv) !== undefined },
  });

  // `--key`: the loop key checks under the chain audit, on the same reads. They are
  // `verify-channel`'s, run over every channel, and only the key block is printed — the amounts are
  // `verify-channel`'s question, not this one's.
  const keyReport = flag(argv, "key")
    ? await verifyChannels(client, agentId, {
        ...openReads(client, agentId, argv),
        reader: new TempoRpcReader({ url: arg(argv, "tempo-rpc", TEMPO_RPC_URL) }),
        expectedPayer: arg(argv, "payer"),
        expectedPayee: arg(argv, "payee"),
        requireKey: true,
      })
    : undefined;

  const out = keyedAudit(report, keyReport);
  if (flag(argv, "json")) console.log(JSON.stringify(out.json, null, 2));
  else for (const line of out.lines) console.log(line);
  return out.code;
}

/**
 * The audit's output with `--key`'s block: the text lines, the JSON, and the exit code, from the
 * chain audit and the key checks run beside it.
 *
 * A chain that replays but whose key contradicts its policy is a disagreement, the audit's 2. An
 * unchecked key changes nothing: Tempo not answering is not a fault of the chain. The verdict says
 * so too, not only the exit code: a failed key puts its block before the verdict, which reads
 * `FAILED (loop key)` where it would have read `VERIFIED`, and the JSON says `ok: false` with the
 * key check in `reasons` rather than nesting the failure under `tempoKey` beside `ok: true`, so a
 * reader — or a script reading the last word or `.ok` — never takes a chain whose key failed as
 * verified. Every other report keeps the chain audit's verdict and `ok`.
 * @internal — exported for `tests/audit.ts`.
 */
export function keyedAudit(
  report: AuditReport,
  keyReport: ChannelsReport | undefined
): { lines: string[]; json: unknown; code: number } {
  const failedKey =
    keyReport?.key?.status === "failed"
      ? `(a) ${keyReport.key.detail}`
      : keyReport?.scopes?.status === "failed"
      ? `(d) ${keyReport.scopes.detail}`
      : keyReport?.channels.find((c) => c.key?.status === "failed")?.key?.detail;
  const keyFailed = failedKey !== undefined;
  const tempoKey = keyReport && {
    key: keyReport.key ?? null,
    // (d), only for a key whose policy commits scopes, so an unscoped key's JSON carries no `scopes`.
    ...(keyReport.scopes ? { scopes: keyReport.scopes } : {}),
    channels: keyReport.channels.filter((c) => c.key).map((c) => ({ channelId: c.channelId, key: c.key })),
  };
  const reason = keyFailed ? `the loop's Tempo key: ${failedKey}` : undefined;
  const json = {
    ...report,
    ...(tempoKey ? { tempoKey } : {}),
    ...(reason ? { ok: false, reasons: [reason] } : {}),
  };
  const lines = formatReport(report);
  const code = exitCode(report);
  // The audit's own rule (`exitCode`): a failure outranks "not checked". A chain that is only
  // unchecked (4) — an epoch not opened, a gap no history names — has not failed on its own, so a
  // key that contradicts its policy is the verdict, 2 and `FAILED (loop key)`, not the 4 and the
  // `NOT VERIFIED` that would let a real key failure read as a missing read.
  const chainFailed = code !== 0 && code !== 4;
  if (keyReport && keyFailed) {
    // The verdict is the report's last line, after a blank one: the key block goes between them.
    const verdict = lines.pop()!;
    if (lines[lines.length - 1] === "") lines.pop();
    lines.push("", ...formatKeyLines(keyReport), "", chainFailed ? verdict : "FAILED (loop key)");
  } else if (keyReport) {
    lines.push("", ...formatKeyLines(keyReport));
  }
  return { lines, json, code: !chainFailed && keyFailed ? 2 : code };
}

export function run(): void {
  main()
    .then((code) => process.exit(code))
    .catch((e: any) => {
      console.error(String(e?.message ?? e));
      process.exit(3);
    });
}

if (require.main === module) run();
