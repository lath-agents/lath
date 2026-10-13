/**
 * What `seed.ts` and `authorize.ts` share: the demo issuer's directory and the addresses file the
 * console reads, the Solana Attestation Service's instructions built by hand with web3.js v1, its
 * accounts decoded, its refusals named, and the payer and the send. The bytes were first run on devnet
 * by a probe (`tests/plugin-sas.ts` pins its golden bytes).
 *
 * SAS is `22zoJMtd…4BdG` on devnet. `sas-lib` is built on `@solana/kit`, which neither the plugin
 * interface nor these scripts use, so the instructions are written out from its generated builders
 * (account order) and the program's own source (`program/src/`, the checks and the error codes). The
 * addresses and the claim's bytes come from `@lath/sdk` — the same functions the plugin, the console and
 * the audit derive them with — so a script and a loop can never disagree about an account.
 *
 * The issuer key lives under `~/.lath/demo-attest` (`--dir`), outside the checkout: a key under the
 * checkout is one `git add -A` from being committed, and this one decides who may attest under the
 * credential. The console never reads it; it reads `addresses.json` beside it, public addresses only.
 */
import {
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionError,
} from "@solana/web3.js";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LOOP_RECEIPT_FIELDS,
  LOOP_RECEIPT_LAYOUT,
  LOOP_RECEIPT_SCHEMA_NAME,
  LOOP_RECEIPT_SCHEMA_VERSION,
  SAS_PROGRAM_ID,
  SAS_SCHEMA_FIELDS,
  SAS_SCHEMA_LAYOUT,
  SAS_SCHEMA_NAME,
  SAS_SCHEMA_VERSION,
  sasAttestationAddress,
  sasClaimBytes,
  sasCredentialAddress,
  sasEventAuthorityAddress,
  sasSchemaAddress,
} from "@lath/sdk";
import { DEVNET_GENESIS, assertCluster } from "../_cluster";

export const SAS = new PublicKey(SAS_PROGRAM_ID);

// ─── Flags, the devnet url and key files ───────────────────────────────────────

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function expand(p: string): string {
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

/** The solana CLI's own config value, or undefined when the CLI is missing or silent. */
function cliConfig(field: "RPC URL" | "Keypair Path"): string | undefined {
  try {
    const out = execFileSync("solana", ["config", "get"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.startsWith(`${field}:`));
    const value = line?.slice(field.length + 1).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** A url with any `api-key` query value masked, for printing. */
export function redact(url: string): string {
  return url.replace(/(api-key=)[^&]+/i, "$1…");
}

/**
 * The devnet RPC: `--rpc`, else `LATH_DEVNET_RPC`, else the solana CLI's configured url — the order
 * the console uses. SAS's accounts are ordinary ones, so neither script needs the compression index, but
 * using the console's url keeps one rate limit to reason about. Whatever the source, `connectSas` refuses
 * it unless its genesis hash is devnet's.
 */
export function devnetRpc(): { url: string; source: string } {
  const fromFlag = arg("rpc");
  if (fromFlag) return { url: fromFlag, source: "--rpc" };
  if (process.env.LATH_DEVNET_RPC) return { url: process.env.LATH_DEVNET_RPC, source: "LATH_DEVNET_RPC" };
  const cli = cliConfig("RPC URL");
  if (cli) return { url: cli, source: "solana config get" };
  return { url: "https://api.devnet.solana.com", source: "default" };
}

export function readKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/**
 * The key at `file`, generating it there first when it does not exist yet — on a dry run, an in-memory
 * key that is never written, so a dry run leaves no file behind and a real run after it still starts
 * clean. An existing file is always reused: the credential and both schemas derive from the issuer's
 * address, so regenerating it would silently point the demo at a different credential.
 */
export function keyAt(file: string, dryRun: boolean): { keypair: Keypair; state: "existing" | "new" | "ephemeral" } {
  if (fs.existsSync(file)) return { keypair: readKeypair(file), state: "existing" };
  const keypair = Keypair.generate();
  if (dryRun) return { keypair, state: "ephemeral" };
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, state: "new" };
}

export function describeKey(label: string, file: string, k: { keypair: Keypair; state: string }): string {
  const where =
    k.state === "ephemeral" ? `would be generated at ${file} (dry run: not written)` : `${file} (${k.state})`;
  return `${label.padEnd(18)} ${k.keypair.publicKey.toBase58()}  ${where}`;
}

/**
 * The payer: `--payer <path>`, else `ANCHOR_WALLET`, else the solana CLI's keypair. It pays rent and
 * fees and is never a participant: not the issuer, not an authorized signer.
 */
export function payerPath(): string {
  return expand(
    arg("payer") ??
      process.env.ANCHOR_WALLET ??
      cliConfig("Keypair Path") ??
      path.join(os.homedir(), ".config", "solana", "id.json")
  );
}

export function sol(lamports: number | bigint): string {
  return `${(Number(lamports) / 1e9).toFixed(9).replace(/\.?0+$/, "")} SOL`;
}

/** The demo credential: `["credential", issuer, "lath-demo"]`, which the probe made on devnet. */
export const DEMO_CREDENTIAL_NAME = "lath-demo";

/** `upgrade-authority` v1's one-line description, what an explorer shows beside the schema. */
export const SCHEMA_DESCRIPTION =
  "Lath: who can upgrade a program, as a loop step read it on chain, and what that reasoning cost on Tempo";

/** `program/src/error.rs`, in order: `ProgramError::Custom(index)`. */
export const SAS_ERRORS = [
  "InvalidCredential",
  "InvalidSchema",
  "InvalidAttestation",
  "InvalidAuthority",
  "InvalidSchemaDataType",
  "SignerNotAuthorized",
  "InvalidAttestationData",
  "InvalidEventAuthority",
  "InvalidMint",
  "InvalidProgramSigner",
  "InvalidTokenAccount",
  "SchemaPaused",
];

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

// ─── The directory and its addresses file ──────────────────────────────────────

/** `~/.lath/demo-attest`, or `--dir`. It is created only on a real run. */
export function attestDir(): string {
  return expand(arg("dir") ?? path.join(os.homedir(), ".lath", "demo-attest"));
}

/** 0700 even when it already existed: `mkdirSync`'s mode is masked by the umask and ignored for an existing dir. */
export function ensureAttestDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** The issuer key at `<dir>/issuer.json`: reused when there, made once on a real run, in memory on a dry one. */
export function issuerKey(dir: string, dryRun: boolean) {
  const file = path.join(dir, "issuer.json");
  return { file, ...keyAt(file, dryRun) };
}

/** An authorization the issuer granted or took back, keyed in `addresses.json` by the key's address. */
export type AuthorizationRecord = {
  loopId?: string;
  /** Unix ms. */
  at: number;
  signature: string;
  removed?: { at: number; signature: string };
};

/**
 * `~/.lath/demo-attest/addresses.json`. The first block is the contract the console reads
 * (`attestDemo`, `GET /api/loops`), in exactly this shape: change it only with the console. The rest is
 * these scripts' bookkeeping beside it: public addresses, a path and signatures, never a secret.
 */
export type AttestAddresses = {
  issuer?: string;
  credential?: string;
  credentialName?: string;
  schema?: string;
  schemaName?: string;
  schemaVersion?: number;
  subjects?: { name: string; address: string }[];
  /** `loop-receipt` v1 under the same credential, once the seed has made it. */
  receiptSchema?: string;

  cluster?: "devnet";
  issuerKeypair?: string;
  seedSignature?: string;
  authorizations?: Record<string, AuthorizationRecord>;
};

export function readAttest(dir: string): AttestAddresses {
  const file = path.join(dir, "addresses.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as AttestAddresses) : {};
}

/** Merge `patch` into `addresses.json`; `authorizations` merge by key, so one loop's record never drops another's. */
export function writeAttest(dir: string, patch: AttestAddresses): string {
  ensureAttestDir(dir);
  const file = path.join(dir, "addresses.json");
  const was = readAttest(dir);
  const next: AttestAddresses = {
    ...was,
    ...patch,
    ...(patch.authorizations ? { authorizations: { ...was.authorizations, ...patch.authorizations } } : {}),
    cluster: "devnet",
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return file;
}

/**
 * The demo's credential and schema from the issuer's address alone, by the SDK's derivations: what the
 * seed makes and what `authorize.ts` acts on, whether or not `addresses.json` has been written yet.
 */
export function demoAddresses(issuer: PublicKey): {
  credential: PublicKey;
  schema: PublicKey;
  receiptSchema: PublicKey;
} {
  const credential = sasCredentialAddress(issuer.toBase58(), DEMO_CREDENTIAL_NAME);
  return {
    credential: new PublicKey(credential),
    schema: new PublicKey(sasSchemaAddress(credential, SAS_SCHEMA_NAME, SAS_SCHEMA_VERSION)),
    receiptSchema: new PublicKey(sasSchemaAddress(credential, LOOP_RECEIPT_SCHEMA_NAME, LOOP_RECEIPT_SCHEMA_VERSION)),
  };
}

/**
 * The largest attestation account `upgrade-authority` v1 makes, bytes: the discriminator, `nonce`,
 * `credential`, `schema`, the data as a u32-prefixed vector, `signer`, `expiry` and `token_account`,
 * with the data the plugin's encoder writes for the longest claim (base58's longest addresses, a whole
 * `0x` Tempo address). 368 B; the console funds a loop's key by the same sum.
 */
export const ATTESTATION_ACCOUNT_BYTES =
  1 +
  32 * 3 +
  4 +
  sasClaimBytes({
    program: "1".repeat(44),
    authority: "1".repeat(44),
    kind: "immutable",
    asOfSlot: 0,
    evidence: "00".repeat(32),
    tempoCost: "0",
    tempoPayer: `0x${"0".repeat(40)}`,
  }).length +
  32 +
  8 +
  32;

// ─── The connection ────────────────────────────────────────────────────────────

/** The devnet connection, refused unless its genesis is devnet's and SAS is there. */
export async function connectSas(tag: string): Promise<Connection> {
  const devnet = devnetRpc();
  const connection = new Connection(devnet.url, "confirmed");
  await assertCluster(connection, DEVNET_GENESIS, "devnet");
  const program = await connection.getAccountInfo(SAS, "confirmed");
  if (!program?.executable) throw new Error(`SAS ${SAS.toBase58()} is not an executable program on devnet`);
  console.log(`${tag}devnet  ${redact(devnet.url)} (from ${devnet.source}; genesis checked; SAS executable)`);
  return connection;
}

/** The payer that funds the issuer and pays every fee: `--payer`, else the Solana CLI's keypair. */
export function loadPayer(): { keypair: Keypair; file: string } {
  const file = payerPath();
  if (!fs.existsSync(file)) throw new Error(`no payer keypair at ${file}; pass --payer`);
  return { keypair: readKeypair(file), file };
}

// ─── Transactions ──────────────────────────────────────────────────────────────

/** Signers deduplicated by key: a fee payer that also signs an instruction is passed once. */
function uniqueSigners(signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  return signers.filter((k) => !seen.has(k.publicKey.toBase58()) && seen.add(k.publicKey.toBase58()));
}

function v0(ixs: TransactionInstruction[], feePayer: PublicKey, blockhash: string): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
  );
}

/** The serialized size of an unsigned v0 transaction, signature slots included; Infinity when it does not encode. */
function txBytes(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  try {
    return v0(ixs, feePayer, PublicKey.default.toBase58()).serialize().length;
  } catch {
    return Infinity;
  }
}

/** A simulation's answer; `why` alone when the transaction was not simulated (`simulated: false`). */
export type Sim = {
  simulated: boolean;
  bytes: number;
  err?: TransactionError | null;
  logs?: string[];
  unitsConsumed?: number;
  why?: string;
};

/**
 * Simulate without signatures: the RPC skips signature checks, replaces the blockhash, and nothing
 * lands. A transaction past the packet size is not sent to the RPC at all, and says so.
 */
export async function simulate(
  connection: Connection,
  ixs: TransactionInstruction[],
  feePayer: PublicKey
): Promise<Sim> {
  const bytes = txBytes(ixs, feePayer);
  if (bytes > PACKET_DATA_SIZE) {
    return {
      simulated: false,
      bytes,
      why: `${bytes === Infinity ? "over" : bytes} B, past the ${PACKET_DATA_SIZE} B packet`,
    };
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const sim = await connection.simulateTransaction(v0(ixs, feePayer, blockhash), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  return {
    simulated: true,
    bytes,
    err: sim.value.err,
    logs: sim.value.logs ?? [],
    unitsConsumed: sim.value.unitsConsumed,
  };
}

/**
 * Sign and send one v0 transaction and wait for `confirmed`. `landFailure` skips preflight, so a
 * transaction the program refuses still lands, pays its fee and has a signature an explorer shows:
 * what `authorize.ts --outside` wants. Otherwise a refusal throws at preflight and nothing lands.
 */
export async function send(
  connection: Connection,
  ixs: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[],
  landFailure = false
): Promise<{ signature: string; err: TransactionError | null }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = v0(ixs, feePayer.publicKey, blockhash);
  tx.sign(uniqueSigners([feePayer, ...signers]));
  const signature = await connection.sendTransaction(tx, { maxRetries: 5, skipPreflight: landFailure });
  // web3.js 1.98 returns a failed transaction's error from the websocket path but *rejects* with the
  // bare `TransactionError` object when its status poll sees the failure first, so a refusal the
  // script expects (SAS 5) arrives either way and both are the same answer.
  try {
    const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    return { signature, err: confirmed.value.err };
  } catch (e) {
    if (e && typeof e === "object" && !(e instanceof Error)) return { signature, err: e as TransactionError };
    throw e;
  }
}

/** `getTransaction` at `confirmed`, retried while the RPC has not indexed it yet. */
export async function readLanded(connection: Connection, signature: string) {
  for (let i = 0; i < 10; i++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${signature} is not readable at confirmed after 15 s`);
}

// ─── Encoding (Borsh, by hand) ─────────────────────────────────────────────────

export const u8 = (n: number) => Buffer.from([n]);
export function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
export function i64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
}
export const bytes = (b: Uint8Array) => Buffer.concat([u32(b.length), Buffer.from(b)]);
export const str = (s: string) => bytes(Buffer.from(s, "utf8"));
const keys = (ks: PublicKey[]) => Buffer.concat([u32(ks.length), ...ks.map((k) => k.toBuffer())]);

// ─── Instructions (account order from sas-lib's generated builders) ────────────

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const SYSTEM = r(SystemProgram.programId);
const ix = (accounts: TransactionInstruction["keys"], data: Buffer) =>
  new TransactionInstruction({ programId: SAS, keys: accounts, data });

/** `createCredential` (0): `name`, and the first authorized signers. The authority signs; the payer pays the rent. */
export function createCredentialIx(payer: PublicKey, authority: PublicKey, name: string, signers: PublicKey[]) {
  const credential = new PublicKey(sasCredentialAddress(authority.toBase58(), name));
  return ix(
    [w(payer, true), w(credential), r(authority, true), SYSTEM],
    Buffer.concat([u8(0), str(name), keys(signers)])
  );
}

export type SchemaTerms = {
  name: string;
  version: number;
  description: string;
  /** One byte per field: 0 u8, 3 u64, 12 String, 13 Vec<u8>. */
  layout: readonly number[];
  fields: readonly string[];
};

/** `upgrade-authority` v1, from the SDK's own field list and layout, which the plugin's encoder writes. */
export const UPGRADE_AUTHORITY_SCHEMA: SchemaTerms = {
  name: SAS_SCHEMA_NAME,
  version: SAS_SCHEMA_VERSION,
  description: SCHEMA_DESCRIPTION,
  layout: SAS_SCHEMA_LAYOUT,
  fields: SAS_SCHEMA_FIELDS,
};

/**
 * `loop-receipt` v1 (docs/ARCHITECTURE.md §8), from the SDK's field list and layout,
 * which the console's receipt encoder writes. On the same credential as `upgrade-authority` v1.
 */
export const LOOP_RECEIPT_SCHEMA: SchemaTerms = {
  name: LOOP_RECEIPT_SCHEMA_NAME,
  version: LOOP_RECEIPT_SCHEMA_VERSION,
  description:
    "A Lath loop's receipt: the agent, the loop, its last step's seq and head on the agent's chain, the step " +
    "count, the goal's sha256, USDC charged on Solana, and USDC.e spent on Tempo with the key that paid.",
  layout: LOOP_RECEIPT_LAYOUT,
  fields: LOOP_RECEIPT_FIELDS,
};

/**
 * `createSchema` (1) on `credential`. The schema's address is `["schema", credential, name, [version]]`,
 * and SAS takes the version as the next free one for the name, so a v1 seed against a credential that
 * already has the name makes no new v1: the seed checks the account first.
 */
export function createSchemaIx(payer: PublicKey, authority: PublicKey, credential: PublicKey, terms: SchemaTerms) {
  const schema = new PublicKey(sasSchemaAddress(credential.toBase58(), terms.name, terms.version));
  return ix(
    [w(payer, true), r(authority, true), r(credential), w(schema), SYSTEM],
    Buffer.concat([
      u8(1),
      str(terms.name),
      str(terms.description),
      bytes(Buffer.from(terms.layout as number[])),
      u32(terms.fields.length),
      ...terms.fields.map(str),
    ])
  );
}

/**
 * `changeAuthorizedSigners` (3): the **whole** new list, not a delta, so a caller reads the current one
 * first and sends it with one key added or removed. The credential's authority signs; the payer pays any
 * rent the larger account needs.
 */
export function changeSignersIx(payer: PublicKey, authority: PublicKey, credential: PublicKey, signers: PublicKey[]) {
  return ix([w(payer, true), r(authority, true), w(credential), SYSTEM], Buffer.concat([u8(3), keys(signers)]));
}

/**
 * `createAttestation` (6) on `nonce` — a subject's program id — with `data` encoded under the
 * schema and `expiry` in unix seconds (0 is none). `signer` must be an authorized signer of the
 * credential (SAS 5 otherwise); `payer` pays the account's rent.
 */
export function createAttestationIx(
  payer: PublicKey,
  signer: PublicKey,
  credential: PublicKey,
  schema: PublicKey,
  nonce: PublicKey,
  data: Uint8Array,
  expiry: bigint
) {
  const attestation = new PublicKey(sasAttestationAddress(credential.toBase58(), schema.toBase58(), nonce.toBase58()));
  return ix(
    [w(payer, true), r(signer, true), r(credential), r(schema), w(attestation), SYSTEM],
    Buffer.concat([u8(6), nonce.toBuffer(), bytes(data), i64(expiry)])
  );
}

/** `closeAttestation` (7): the rent goes to `payer`. Any authorized signer may close any attestation. */
export function closeAttestationIx(payer: PublicKey, signer: PublicKey, credential: PublicKey, attestation: PublicKey) {
  return ix(
    [
      w(payer, true),
      r(signer, true),
      r(credential),
      w(attestation),
      r(new PublicKey(sasEventAuthorityAddress())),
      SYSTEM,
      r(SAS),
    ],
    u8(7)
  );
}

// ─── Decoding ──────────────────────────────────────────────────────────────────

class Reader {
  o = 0;
  constructor(readonly b: Buffer) {}
  need(n: number) {
    if (this.o + n > this.b.length)
      throw new Error(`the account ends at ${this.b.length} B, ${n} B more were expected`);
  }
  u8() {
    this.need(1);
    return this.b[this.o++];
  }
  u32() {
    this.need(4);
    const v = this.b.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  key() {
    this.need(32);
    const k = new PublicKey(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  bytes() {
    const n = this.u32();
    this.need(n);
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
}

export type CredentialAccount = { discriminator: number; authority: string; name: string; authorizedSigners: string[] };

export function decodeCredential(b: Buffer): CredentialAccount {
  const rd = new Reader(b);
  const discriminator = rd.u8();
  const authority = rd.key().toBase58();
  const name = rd.bytes().toString("utf8");
  const n = rd.u32();
  const authorizedSigners = Array.from({ length: n }, () => rd.key().toBase58());
  return { discriminator, authority, name, authorizedSigners };
}

export type SchemaAccount = {
  discriminator: number;
  credential: string;
  name: string;
  description: string;
  layout: number[];
  fields: string[] | null;
  isPaused: boolean;
  version: number;
};

/**
 * A schema account: the discriminator, `credential`, `name`, `description` and `layout` as u32-prefixed
 * bytes, the field names, then `is_paused` and `version` as its last two bytes. The field names are read
 * both ways SAS has been seen to keep them — a u32-prefixed blob holding a Borsh `Vec<String>`, or the
 * `Vec<String>` itself — and the one that ends exactly at `is_paused` wins; `null` when neither does.
 */
export function decodeSchema(b: Buffer): SchemaAccount {
  const rd = new Reader(b);
  const discriminator = rd.u8();
  const credential = rd.key().toBase58();
  const name = rd.bytes().toString("utf8");
  const description = rd.bytes().toString("utf8");
  const layout = Array.from(rd.bytes());
  // The field names as SAS stores them (the runtime's `decodeSchema` reads them so): one `Vec<u8>` whose
  // bytes are each name as a u32 length and its UTF-8, with no count before them. Reading a count first
  // would make a re-run of the seed find its own schema "unreadable" and refuse.
  let fields: string[] | null;
  try {
    const names = new Reader(rd.bytes());
    const out: string[] = [];
    while (names.o < names.b.length) out.push(names.bytes().toString("utf8"));
    fields = out;
  } catch {
    fields = null;
  }
  const end = b.length - 2;
  return { discriminator, credential, name, description, layout, fields, isPaused: b[end] !== 0, version: b[end + 1] };
}

export type AttestationAccount = {
  discriminator: number;
  nonce: string;
  credential: string;
  schema: string;
  data: Buffer;
  signer: string;
  expiry: bigint;
  tokenAccount: string;
};

export function decodeAttestation(b: Buffer): AttestationAccount {
  const rd = new Reader(b);
  return {
    discriminator: rd.u8(),
    nonce: rd.key().toBase58(),
    credential: rd.key().toBase58(),
    schema: rd.key().toBase58(),
    data: Buffer.from(rd.bytes()),
    signer: rd.key().toBase58(),
    expiry: rd.i64(),
    tokenAccount: rd.key().toBase58(),
  };
}

// ─── Refusals ──────────────────────────────────────────────────────────────────

/**
 * A simulated or landed failure in words, naming SAS's own codes. `null` error is success. A failed
 * CPI propagates its code through SAS's own failure line, so the System Program's `AccountAlreadyInUse`
 * (0) on a reused nonce would otherwise read as SAS 0 `InvalidCredential`.
 */
export function refusal(err: TransactionError | null | undefined | unknown, logs: string[] = []): string {
  if (!err) return "none: it would succeed";
  const ie = (err as { InstructionError?: [number, unknown] }).InstructionError;
  const custom = (ie?.[1] as { Custom?: number } | undefined)?.Custom;
  if (typeof custom === "number" && logs.some((l) => l.includes(`${SystemProgram.programId.toBase58()} failed`))) {
    return `System Program ${custom}${custom === 0 ? " AccountAlreadyInUse" : ""}`;
  }
  const fromSas = logs.some((l) => l.includes(`${SAS.toBase58()} failed`));
  if (typeof custom === "number" && fromSas) return `SAS ${custom} ${SAS_ERRORS[custom] ?? "unknown"}`;
  const last = logs.filter((l) => /failed|error|already in use|insufficient/i.test(l)).slice(-2);
  return `${JSON.stringify(err)}${last.length ? `  [${last.join(" | ")}]` : ""}`;
}

/** The SAS code of a refusal, when SAS gave one: `5` for `SignerNotAuthorized`. */
export function sasCode(err: unknown, logs: string[] = []): number | undefined {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const custom = (ie?.[1] as { Custom?: number } | undefined)?.Custom;
  const fromSas = logs.some((l) => l.includes(`${SAS.toBase58()} failed`));
  const fromSystem = logs.some((l) => l.includes(`${SystemProgram.programId.toBase58()} failed`));
  return typeof custom === "number" && fromSas && !fromSystem ? custom : undefined;
}
