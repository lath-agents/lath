/**
 * `sas.receipt`: a loop's receipt on the Solana Attestation Service. When Jev's goal check answers
 * `achieved` and the loop stops, the console publishes one attestation, schema `loop-receipt` v1 on the
 * demo credential, that points at the loop's records: the agent, the loop, the chain position its last
 * step committed, the step count, the goal's hash, and what the loop cost on Solana and on Tempo. The
 * records are the proof; the receipt is the index anyone reads in one call, and the audit checks it
 * against them (`audit/receipt.ts`).
 *
 * Pure and browser-safe, as `plugins.ts` is: no Buffer, no Node built-in. The PDA derivations are SAS's
 * own (`sasAttestationAddress`), and the bytes are Borsh as SAS reads the schema's layout.
 */
import { PublicKey } from "@solana/web3.js";
import { hex, idFromString, utf8 } from "./hash";
import { SAS_PROGRAM_ID, sasAttestationAddress } from "./plugins";

/** The schema's name and version: PDA seeds, so fixed once the schema is on devnet. */
export const LOOP_RECEIPT_SCHEMA_NAME = "loop-receipt";
export const LOOP_RECEIPT_SCHEMA_VERSION = 1;

/**
 * The receipt's fields, in order, and their SAS layout codes (0 u8, 3 u64, 12 String, 13 Vec<u8>). A
 * schema read on chain whose layout differs is not this schema, and nothing is published under it.
 */
export const LOOP_RECEIPT_FIELDS: readonly string[] = Object.freeze([
  "agent",
  "loop",
  "seq",
  "head",
  "steps",
  "goal",
  "usdcCharged",
  "tempoSpent",
  "tempoPayer",
]);
export const LOOP_RECEIPT_LAYOUT: readonly number[] = Object.freeze([12, 12, 3, 13, 3, 13, 3, 3, 12]);

/**
 * The nonce's domain. A frozen derivation input: changing it moves every receipt's address, as changing
 * the `lattice.*` domains would move theirs.
 */
export const LOOP_RECEIPT_NONCE_DOMAIN = "lath.loop-receipt:";

/** The tool id the catalog and the loop's records name the feature by. */
export const SAS_RECEIPT_TOOL = "sas.receipt";

/** A receipt as the console builds it and the audit reads it. Numbers past 2^53 are decimal strings. */
export interface LoopReceipt {
  /** The agent id, 64 lower-case hex. */
  agent: string;
  /** The loop id, `loop-<16 hex>`. */
  loop: string;
  /** The seq of the loop's last `loop.step` record, decimal. */
  seq: string;
  /** The head that record's leaf committed to (the chain's head before it), 64 lower-case hex. */
  head: string;
  /** Steps taken, as the loop's snapshot counts them. */
  steps: number;
  /** The goal's SHA-256 as the manifests commit it, 64 lower-case hex. */
  goal: string;
  /** What the owner was charged in USDC on Solana, micro-USDC, decimal. */
  usdcCharged: string;
  /** What the loop's channel paid on Tempo, USDC.e base units, decimal. */
  tempoSpent: string;
  /** The Tempo address that signed the loop's vouchers, `0x…` lower case; empty when none. */
  tempoPayer: string;
}

/** Where a loop's receipt goes and who signs it, as the loop's policy commits it. */
export interface LoopReceiptPointer {
  /** The SAS credential, base58. */
  credential: string;
  /** The `loop-receipt` v1 schema on it, base58. */
  schema: string;
  /** The key that signs and pays for the receipt: the console's runtime key, base58. */
  signer: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const U64_MAX = BigInt("18446744073709551615");

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const vec = (b: Uint8Array) => concat([u32le(b.length), b]);

function fromHex64(s: string, what: string): Uint8Array {
  if (typeof s !== "string" || !HEX64.test(s)) throw new Error(`loopReceiptBytes: ${what} must be 32 bytes of hex`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u64Of(v: string | number, what: string): bigint {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new Error(`loopReceiptBytes: ${what} ${JSON.stringify(v)} is not a u64`);
  const n = BigInt(s);
  if (n > U64_MAX) throw new Error(`loopReceiptBytes: ${what} ${s} is past u64`);
  return n;
}

/**
 * The receipt's data, the fields in `LOOP_RECEIPT_FIELDS` order, Borsh as SAS reads
 * `LOOP_RECEIPT_LAYOUT`. Throws on a receipt the schema cannot hold, because data that does not fit
 * makes the program panic with no clean code.
 */
export function loopReceiptBytes(r: LoopReceipt): Uint8Array {
  if (!HEX64.test(String(r.agent))) throw new Error("loopReceiptBytes: agent must be 64 lower-case hex");
  return concat([
    vec(utf8(String(r.agent))),
    vec(utf8(String(r.loop))),
    u64le(u64Of(r.seq, "seq")),
    vec(fromHex64(r.head, "head")),
    u64le(u64Of(r.steps, "steps")),
    vec(fromHex64(r.goal, "goal")),
    u64le(u64Of(r.usdcCharged, "usdcCharged")),
    u64le(u64Of(r.tempoSpent, "tempoSpent")),
    vec(utf8(String(r.tempoPayer))),
  ]);
}

/** The inverse of `loopReceiptBytes`, or `null` for bytes that are not exactly one receipt. */
export function decodeLoopReceipt(bytes: Uint8Array): LoopReceipt | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = new TextDecoder("utf-8", { fatal: true });
    let o = 0;
    const need = (n: number) => {
      if (o + n > bytes.length) throw new Error("short");
    };
    const v = () => {
      need(4);
      const n = view.getUint32(o, true);
      o += 4;
      need(n);
      const out = bytes.subarray(o, o + n);
      o += n;
      return out;
    };
    const u64 = () => {
      need(8);
      const out = view.getBigUint64(o, true);
      o += 8;
      return out;
    };
    const agent = text.decode(v());
    const loop = text.decode(v());
    const seq = u64();
    const head = v();
    const steps = u64();
    const goal = v();
    const usdcCharged = u64();
    const tempoSpent = u64();
    const tempoPayer = text.decode(v());
    if (o !== bytes.length || head.length !== 32 || goal.length !== 32) return null;
    if (steps > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return {
      agent,
      loop,
      seq: seq.toString(),
      head: hex(head),
      steps: Number(steps),
      goal: hex(goal),
      usdcCharged: usdcCharged.toString(),
      tempoSpent: tempoSpent.toString(),
      tempoPayer,
    };
  } catch {
    return null;
  }
}

/** The receipt's nonce for a loop, base58. */
export function loopReceiptNonce(loopId: string): string {
  return new PublicKey(idFromString(LOOP_RECEIPT_NONCE_DOMAIN + loopId)).toBase58();
}

/** The receipt's address: SAS's attestation PDA over the pointer's credential and schema and the loop's nonce. */
export function loopReceiptAddress(pointer: Pick<LoopReceiptPointer, "credential" | "schema">, loopId: string): string {
  return sasAttestationAddress(pointer.credential, pointer.schema, loopReceiptNonce(loopId));
}

/** The pointer as `policyDocument` writes it: the three named keys, extras dropped. */
export function loopReceiptPointerDocument(p: LoopReceiptPointer): LoopReceiptPointer {
  return { credential: String(p.credential ?? ""), schema: String(p.schema ?? ""), signer: String(p.signer ?? "") };
}

/** A start body's `receipt`, checked for shape: three base58 keys and nothing else. */
export function validateLoopReceiptPointer(
  raw: unknown
): { ok: true; pointer: LoopReceiptPointer } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "receipt must be an object" };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "credential" && k !== "schema" && k !== "signer")
      return { ok: false, reason: `receipt.${k} is not a term` };
  }
  for (const k of ["credential", "schema", "signer"] as const) {
    if (typeof r[k] !== "string" || !BASE58.test(r[k] as string)) {
      return { ok: false, reason: `receipt.${k} must be a base58 address` };
    }
  }
  return { ok: true, pointer: loopReceiptPointerDocument(r as unknown as LoopReceiptPointer) };
}

/** An SAS attestation account, decoded without Buffer (the runtime's `decodeAttestation` uses one). */
export interface SasAttestationAccount {
  nonce: string;
  credential: string;
  schema: string;
  data: Uint8Array;
  signer: string;
  /** Unix seconds; 0 is none. */
  expiry: bigint;
  tokenAccount: string;
}

/** The attestation account's discriminator. */
export const SAS_ATTESTATION_DISCRIMINATOR = 2;

/**
 * An attestation account's bytes: discriminator 2, nonce, credential, schema, data (u32 length and
 * bytes), signer, expiry (i64), token account. `null` for anything else. The caller checks the owner.
 */
export function decodeSasAttestationAccount(data: Uint8Array): SasAttestationAccount | null {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let o = 0;
    const need = (n: number) => {
      if (o + n > data.length) throw new Error("short");
    };
    const key = () => {
      need(32);
      const k = new PublicKey(data.subarray(o, o + 32)).toBase58();
      o += 32;
      return k;
    };
    need(1);
    if (data[o++] !== SAS_ATTESTATION_DISCRIMINATOR) return null;
    const nonce = key();
    const credential = key();
    const schema = key();
    need(4);
    const n = view.getUint32(o, true);
    o += 4;
    need(n);
    const body = data.slice(o, o + n);
    o += n;
    const signer = key();
    need(8);
    const expiry = view.getBigInt64(o, true);
    o += 8;
    const tokenAccount = key();
    return { nonce, credential, schema, data: body, signer, expiry, tokenAccount };
  } catch {
    return null;
  }
}

/** The SAS program, for an owner check beside `decodeSasAttestationAccount`. */
export const LOOP_RECEIPT_PROGRAM_ID = SAS_PROGRAM_ID;

/** The widest receipt data: a 64-hex agent, a 21-byte loop id, two 32-byte hashes, a 42-byte payer. */
export const LOOP_RECEIPT_MAX_DATA_BYTES = loopReceiptBytes({
  agent: "0".repeat(64),
  loop: "loop-0000000000000000",
  seq: U64_MAX.toString(),
  head: "0".repeat(64),
  steps: Number.MAX_SAFE_INTEGER,
  goal: "0".repeat(64),
  usdcCharged: U64_MAX.toString(),
  tempoSpent: U64_MAX.toString(),
  tempoPayer: `0x${"0".repeat(40)}`,
}).length;

/** The receipt account's size: discriminator, nonce, credential, schema, data's length and bytes, signer, expiry, token account. */
export const LOOP_RECEIPT_ACCOUNT_BYTES = 1 + 32 * 3 + 4 + LOOP_RECEIPT_MAX_DATA_BYTES + 32 + 8 + 32;
