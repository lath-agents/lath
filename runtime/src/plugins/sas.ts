/**
 * The Solana Attestation Service by hand (`SAS_PROGRAM_ID`, live on devnet): the `createAttestation`
 * instruction, the credential, schema and attestation decoders, and SAS's failures in words. The console's
 * loop receipt (`_lib/receipt.ts`) publishes with them.
 *
 * `sas.attest`, a grant plugin that publishes a claim about a program's upgrade authority signed by the
 * loop's own key, is on the roadmap and not in this build. Chains that carry its records still replay here;
 * this build does not verify what their plugin records say.
 *
 * Built by hand rather than through `sas-lib`, which is on `@solana/kit`: the account orders, the
 * discriminators and the data layouts are those of transactions that landed on devnet, whose bytes
 * `tests/plugin-sas.ts` pins.
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { SAS_PROGRAM_ID, sasAttestationAddress } from "@lath/sdk";
import { programErrorCode } from "./solana";

export const SAS = new PublicKey(SAS_PROGRAM_ID);

/** SAS's `program/src/error.rs`, in order: `ProgramError::Custom(index)`. */
export const SAS_ERRORS: readonly string[] = Object.freeze([
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
]);

// The accounts' first byte (`sas-lib`'s generated decoders; the live devnet accounts agree).
const CREDENTIAL_DISCRIMINATOR = 0;
const SCHEMA_DISCRIMINATOR = 1;
const ATTESTATION_DISCRIMINATOR = 2;
// The instruction's first byte.
const CREATE_ATTESTATION = 6;

// ---------------------------------------------------------------------------------------------
// Encoding (Borsh, by hand), exported for the tests and the golden bytes

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function i64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
}

const vec = (b: Uint8Array) => Buffer.concat([u32le(b.length), Buffer.from(b)]);

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

/** What one `createAttestation` is built from, with the data already encoded. */
export interface CreateAttestationInputs {
  payer: PublicKey;
  signer: PublicKey;
  credential: PublicKey;
  schema: PublicKey;
  /** The subject's program id. */
  nonce: PublicKey;
  data: Uint8Array;
  /** Unix seconds. */
  expiry: bigint;
}

/**
 * `createAttestation`: payer (w, s), signer (s), credential, schema, the attestation PDA (w), the
 * System Program; data `u8(6) | nonce | Vec<u8> data | i64 expiry`: the bytes `tests/plugin-sas.ts` pins,
 * which landed on devnet.
 */
export function createAttestationInstruction(i: CreateAttestationInputs): TransactionInstruction {
  const attestation = new PublicKey(
    sasAttestationAddress(i.credential.toBase58(), i.schema.toBase58(), i.nonce.toBase58())
  );
  return new TransactionInstruction({
    programId: SAS,
    keys: [
      w(i.payer, true),
      r(i.signer, true),
      r(i.credential),
      r(i.schema),
      w(attestation),
      r(SystemProgram.programId),
    ],
    data: Buffer.concat([Buffer.of(CREATE_ATTESTATION), i.nonce.toBuffer(), vec(i.data), i64le(i.expiry)]),
  });
}

// ---------------------------------------------------------------------------------------------
// Decoding. Each returns `null` for an account that is absent, owned by another program, or does not
// read whole: a doubtful read lands where nothing is published (`not-authorized`, `schema-paused`,
// `claim-mismatch` downstream), never where something is.

class Reader {
  o = 0;
  constructor(readonly b: Buffer) {}
  need(n: number) {
    if (this.o + n > this.b.length) throw new Error("short");
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
    return k.toBase58();
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

const ownedBy = (info: AccountInfo<Buffer> | null | undefined, program: PublicKey): info is AccountInfo<Buffer> =>
  !!info && info.owner.equals(program);

/** A credential: discriminator 0, authority, name, the authorized signers. */
export function decodeCredential(
  info: AccountInfo<Buffer> | null | undefined
): { authority: string; name: string; authorizedSigners: string[] } | null {
  if (!ownedBy(info, SAS)) return null;
  try {
    const rd = new Reader(info.data);
    if (rd.u8() !== CREDENTIAL_DISCRIMINATOR) return null;
    const authority = rd.key();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(rd.bytes());
    const n = rd.u32();
    // Each signer is 32 bytes: a count the account cannot hold is a corrupt read, not a long list.
    rd.need(n * 32);
    const authorizedSigners = Array.from({ length: n }, () => rd.key());
    return { authority, name, authorizedSigners };
  } catch {
    return null;
  }
}

/**
 * A schema, as the live `lath-probe` account reads (184 B): discriminator 1, credential,
 * name, description, layout (`Vec<u8>`, one byte per field), the field names (a `Vec<u8>` whose bytes
 * are each name as a `u32` length and its UTF-8, with no count before them), `is_paused`, version.
 */
export function decodeSchema(info: AccountInfo<Buffer> | null | undefined): {
  credential: string;
  name: string;
  layout: number[];
  fieldNames: string[];
  paused: boolean;
  version: number;
} | null {
  if (!ownedBy(info, SAS)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true });
    const rd = new Reader(info.data);
    if (rd.u8() !== SCHEMA_DISCRIMINATOR) return null;
    const credential = rd.key();
    const name = text.decode(rd.bytes());
    rd.bytes(); // description
    const layout = Array.from(rd.bytes());
    const names = new Reader(Buffer.from(rd.bytes()));
    const fieldNames: string[] = [];
    while (names.o < names.b.length) fieldNames.push(text.decode(names.bytes()));
    const paused = rd.u8();
    if (paused !== 0 && paused !== 1) return null;
    const version = rd.u8();
    return { credential, name, layout, fieldNames, paused: paused === 1, version };
  } catch {
    return null;
  }
}

/** An attestation: discriminator 2, nonce, credential, schema, data, signer, expiry (i64), token account. */
export function decodeAttestation(info: AccountInfo<Buffer> | null | undefined): {
  nonce: string;
  credential: string;
  schema: string;
  data: Buffer;
  signer: string;
  expiry: bigint;
  tokenAccount: string;
} | null {
  if (!ownedBy(info, SAS)) return null;
  try {
    const rd = new Reader(info.data);
    if (rd.u8() !== ATTESTATION_DISCRIMINATOR) return null;
    const nonce = rd.key();
    const credential = rd.key();
    const schema = rd.key();
    const data = Buffer.from(rd.bytes());
    const signer = rd.key();
    const expiry = rd.i64();
    const tokenAccount = rd.key();
    return { nonce, credential, schema, data, signer, expiry, tokenAccount };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Failures

/**
 * A failure in words, naming SAS's own codes: `code` only when SAS raised it. The System
 * Program's `AccountAlreadyInUse` (0) on a taken attestation PDA propagates through SAS's own failure
 * line with the same number, so the logs tell the two apart, as `scripts/demo-attest`'s `refusal` does: a 0 the
 * System Program raised must not read as SAS 0 `InvalidCredential`.
 */
export function sasFailure(failure: unknown, logs?: readonly string[] | null): { code?: number; words: string } {
  const lines = [...(logs ?? []), ...logsOf(failure)];
  const code = programErrorCode(failure) ?? programErrorCode({ logs: lines });
  const system = SystemProgram.programId.toBase58();
  if (code !== undefined && lines.some((l) => l.includes(`${system} failed`))) {
    return { words: `the System Program refused it (${code}${code === 0 ? " AccountAlreadyInUse" : ""})` };
  }
  if (code !== undefined) return { code, words: `SAS ${code} ${SAS_ERRORS[code] ?? "unknown"}` };
  if (lines.some((l) => /panicked/i.test(l))) return { words: "SAS panicked: the data does not fit the schema" };
  return { words: "no program error" };
}

function logsOf(failure: unknown): string[] {
  try {
    const logs = failure && typeof failure === "object" ? (failure as { logs?: unknown }).logs : undefined;
    return Array.isArray(logs) ? logs.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}
