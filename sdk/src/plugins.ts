/**
 * Protocol plugins in this build: the Solana Attestation Service's addresses and the
 * `upgrade-authority` claim, which the loop receipt (`receipt.ts`, `sas.receipt`) and the demo's
 * credential scripts (`scripts/demo-attest/`) build on, and the grant types a policy document may
 * commit.
 *
 * The grant plugins themselves — `squads.pay` and `sas.attest`, the `PROPOSE:` block, the rule check,
 * the frozen question, the step record and its audit — are on the roadmap and not in this build: a
 * console refuses a loop that asks for `grants`, and this build does not verify a step they wrote.
 * What is here is what something live still reads:
 *
 * - `Grants` and its items, the type of `RuntimePolicy.grants`, so a policy document that commits one
 *   keeps hashing as it did (`runtime/src/policy.ts`, `grantsDocument`);
 * - the two tool ids, which the console's event list labels an old record by.
 *
 * Pure: `utf8` and `PublicKey` and nothing else, no Anchor and no Node built-in, because `browser.ts`
 * re-exports this file and CI fails the browser bundle on either.
 */
import { PublicKey } from "@solana/web3.js";
import { utf8 } from "./hash";

// ---------------------------------------------------------------------------------------------
// The grant plugins' names (read side only)

/** The tool ids a grant plugin wrote as an Action, `<plugin>.<action>`. */
export const SQUADS_PAY_TOOL = "squads.pay";
export const SAS_ATTEST_TOOL = "sas.attest";

// ---------------------------------------------------------------------------------------------
// SAS constants

/** The Solana Attestation Service's program id, the same on devnet and mainnet. */
export const SAS_PROGRAM_ID = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG";

/** The BPF upgradeable loader: a program's `ProgramData` is `[program]` under it, and holds the upgrade authority. */
export const BPF_UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

/** The schema `upgrade-authority` v1 on the demo credential: its name and version are PDA seeds. */
export const SAS_SCHEMA_NAME = "upgrade-authority";
export const SAS_SCHEMA_VERSION = 1;

/**
 * The schema's fields, in order, and their SAS layout bytes (`sas-lib` `utils.js`: 0 u8, 3 u64,
 * 12 String, 13 Vec<u8>). The encoder writes these and nothing else; a schema read on chain whose
 * layout differs is not this schema, and nothing is sent under it (data that does not fit makes the
 * program panic with no clean code).
 */
export const SAS_SCHEMA_FIELDS: readonly string[] = Object.freeze([
  "program",
  "authority",
  "kind",
  "asOfSlot",
  "evidence",
  "tempoCost",
  "tempoPayer",
]);
export const SAS_SCHEMA_LAYOUT: readonly number[] = Object.freeze([12, 12, 0, 3, 13, 3, 12]);

/** `kind`'s u8 in the data, by word. */
export const SAS_KINDS = Object.freeze({ key: 0, pda: 1, immutable: 2 } as const);
export type SasKind = keyof typeof SAS_KINDS;

/** What `authority` says when the program is immutable. */
export const SAS_NO_AUTHORITY = "none";

// ---------------------------------------------------------------------------------------------
// The grants: what an owner signed in a start body and a policy committed

/** One payee a grant allows, by the name a `PROPOSE:` line used and the wallet it pays. */
export interface GrantPayee {
  name: string;
  /** The destination wallet (base58), not its token account: Squads checks `destinations` against it. */
  address: string;
}

/**
 * One plugin action the owner permitted, within bounds: a union on `plugin`, one member per plugin.
 */
export type GrantItem = SquadsGrantItem | SasGrantItem;

/**
 * `squads.pay`: pay from a Squads vault under a spending limit the team voted to the loop's key.
 * Amounts are base units of `mint`, decimal strings.
 */
export interface SquadsGrantItem {
  id: string;
  plugin: "squads";
  action: "pay";
  /** The multisig (base58). */
  multisig: string;
  vaultIndex: number;
  /** The SPL mint (base58). */
  mint: string;
  /**
   * The spending limit's PDA, `["multisig", multisig, "spending_limit", createKey]` with
   * `createKey` the loop's own key. Absent in the start body and set by the console at prepare,
   * beside `solanaKey`, so the policy commits it before the team votes.
   */
  spendingLimit?: string;
  payees: GrantPayee[];
  maxPerAction: string;
  maxTotal: string;
  /** A reference (an invoice id) is paid once. Always `true` in v1. */
  uniqueRef: true;
}

/** One program an `sas.attest` grant let the loop attest about, by the name a `PROPOSE:` line used. */
export interface SasSubject {
  name: string;
  /** The program id (base58): the attestation's nonce, so SAS keeps one live attestation per program. */
  address: string;
}

/**
 * `sas.attest`: publish who can upgrade each subject as an attestation under `credential` and
 * `schema`, signed by the loop's own key once the credential's issuer has authorized it.
 * `maxTotal` counts attestations over the loop's life, and each one expires `expiresInDays` after it
 * is checked, never after the grants' `expiresAt`.
 */
export interface SasGrantItem {
  id: string;
  plugin: "sas";
  action: "attest";
  /** The SAS credential (base58), e.g. `lath-demo`'s PDA. */
  credential: string;
  /** The SAS schema (base58): `upgrade-authority` v1 under `credential`. */
  schema: string;
  subjects: SasSubject[];
  /** Attestations over the loop's life, an integer 1..5. */
  maxTotal: number;
  /** An integer 1..365. */
  expiresInDays: number;
}

export interface Grants {
  v: 1;
  cluster: "devnet";
  /** The owner's instruction to the decision model. */
  mandate: string;
  /** The bar `p(act)` had to reach, bps. */
  barBps: number;
  /** Proposals considered per step. */
  maxPerStep: number;
  /** Unix seconds. */
  expiresAt: number;
  items: GrantItem[];
}

// ---------------------------------------------------------------------------------------------
// SAS addresses and the claim

/**
 * A claim as the schema holds it, the attestation's data in JSON form: `sasClaimBytes`
 * encodes it in `SAS_SCHEMA_FIELDS` order with `SAS_SCHEMA_LAYOUT`, `decodeSasClaim` reads it back.
 */
export interface SasClaim {
  /** The subject's program id, base58. */
  program: string;
  /** The upgrade authority, base58, or `SAS_NO_AUTHORITY` when the program is immutable. */
  authority: string;
  kind: SasKind;
  /** The snapshot's context slot (u64 in the data). */
  asOfSlot: number;
  /** `decisionHash`, hex: the Lath decision blob that approved this claim. 32 bytes in the data. */
  evidence: string;
  /** USDC.e base units (6 dp) this step's sessions paid over Tempo before the plugin ran, decimal (u64 in the data). */
  tempoCost: string;
  /** The Tempo address that signed those vouchers: the loop's access key, else the treasury. `""` when the step paid nothing. */
  tempoPayer: string;
}

const BASE_AMOUNT = /^(?:0|[1-9]\d*)$/;
const U64_MAX = (1n << 64n) - 1n;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base-unit string as a bigint, or `null` — never a throw. */
function big(s: unknown): bigint | null {
  return typeof s === "string" && BASE_AMOUNT.test(s) ? BigInt(s) : null;
}

/** A base58 key that round-trips through `PublicKey`: exactly 32 bytes, written canonically. */
function isAddress(s: unknown): s is string {
  if (typeof s !== "string" || !BASE58.test(s)) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

/** A program's `ProgramData` account: `[program]` under the upgradeable loader. Throws on an address that is not one. */
export function programDataAddress(program: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [new PublicKey(program).toBytes()],
    new PublicKey(BPF_UPGRADEABLE_LOADER_ID)
  );
  return pda.toBase58();
}

const sasPda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, new PublicKey(SAS_PROGRAM_ID))[0];

/** `["credential", authority, name]` under SAS. */
export function sasCredentialAddress(authority: string, name: string): string {
  return sasPda([utf8("credential"), new PublicKey(authority).toBytes(), utf8(name)]).toBase58();
}

/** `["schema", credential, name, [version]]` under SAS. */
export function sasSchemaAddress(credential: string, name: string, version: number): string {
  return sasPda([utf8("schema"), new PublicKey(credential).toBytes(), utf8(name), Uint8Array.of(version)]).toBase58();
}

/** `["attestation", credential, schema, nonce]` under SAS; the nonce is the subject's program id. */
export function sasAttestationAddress(credential: string, schema: string, nonce: string): string {
  return sasPda([
    utf8("attestation"),
    new PublicKey(credential).toBytes(),
    new PublicKey(schema).toBytes(),
    new PublicKey(nonce).toBytes(),
  ]).toBase58();
}

/** SAS's event authority, `["__event_authority"]`: `closeAttestation` names it. */
export function sasEventAuthorityAddress(): string {
  return sasPda([utf8("__event_authority")]).toBase58();
}

/**
 * `kind` from the authority alone: `SAS_NO_AUTHORITY` is `immutable`, a key on the ed25519 curve
 * is `key`, one off it is `pda` (a Squads vault is one). `null` for anything that is not an address.
 */
export function sasKindOf(authority: string | null | undefined): SasKind | null {
  if (authority === SAS_NO_AUTHORITY) return "immutable";
  if (!isAddress(authority)) return null;
  return PublicKey.isOnCurve(new PublicKey(authority).toBytes()) ? "key" : "pda";
}

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

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const sasVec = (b: Uint8Array) => concatBytes([u32le(b.length), b]);

/**
 * The attestation's data: the claim's fields in `SAS_SCHEMA_FIELDS` order, Borsh as SAS reads
 * `SAS_SCHEMA_LAYOUT` — a String or a Vec<u8> is a u32 LE length and its bytes, a u8 one byte, a u64
 * eight LE. Throws on a claim the schema cannot hold (an unknown kind, an `evidence` that is not 32
 * bytes of hex, a slot or a cost past u64), because data that does not fit makes the program panic.
 */
export function sasClaimBytes(claim: SasClaim): Uint8Array {
  const kind = SAS_KINDS[claim.kind];
  if (kind === undefined || !Object.prototype.hasOwnProperty.call(SAS_KINDS, claim.kind)) {
    throw new Error(`sasClaimBytes: kind ${JSON.stringify(claim.kind)} is not key, pda or immutable`);
  }
  if (!Number.isSafeInteger(claim.asOfSlot) || claim.asOfSlot < 0) {
    throw new Error(`sasClaimBytes: asOfSlot ${claim.asOfSlot} is not a slot`);
  }
  if (typeof claim.evidence !== "string" || !HEX64.test(claim.evidence)) {
    throw new Error("sasClaimBytes: evidence must be 32 bytes of lower-case hex");
  }
  const cost = big(claim.tempoCost);
  if (cost === null || cost > U64_MAX) throw new Error(`sasClaimBytes: tempoCost ${claim.tempoCost} is not a u64`);
  const evidence = new Uint8Array(32);
  for (let i = 0; i < 32; i++) evidence[i] = parseInt(claim.evidence.slice(i * 2, i * 2 + 2), 16);
  return concatBytes([
    sasVec(utf8(String(claim.program))),
    sasVec(utf8(String(claim.authority))),
    Uint8Array.of(kind),
    u64le(BigInt(claim.asOfSlot)),
    sasVec(evidence),
    u64le(cost),
    sasVec(utf8(String(claim.tempoPayer))),
  ]);
}

/** The inverse of `sasClaimBytes`, or `null` for bytes that are not exactly one claim. */
export function decodeSasClaim(bytes: Uint8Array): SasClaim | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = new TextDecoder("utf-8", { fatal: true });
    let o = 0;
    const need = (n: number) => {
      if (o + n > bytes.length) throw new Error("short");
    };
    const vec = () => {
      need(4);
      const n = view.getUint32(o, true);
      o += 4;
      need(n);
      const v = bytes.subarray(o, o + n);
      o += n;
      return v;
    };
    const u64 = () => {
      need(8);
      const v = view.getBigUint64(o, true);
      o += 8;
      return v;
    };
    const program = text.decode(vec());
    const authority = text.decode(vec());
    need(1);
    const k = bytes[o++];
    const kind = (Object.keys(SAS_KINDS) as SasKind[]).find((w) => SAS_KINDS[w] === k);
    const slot = u64();
    const evidence = vec();
    const tempoCost = u64();
    const tempoPayer = text.decode(vec());
    if (kind === undefined || evidence.length !== 32 || o !== bytes.length) return null;
    if (slot > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return {
      program,
      authority,
      kind,
      asOfSlot: Number(slot),
      evidence: Array.from(evidence, (b) => b.toString(16).padStart(2, "0")).join(""),
      tempoCost: tempoCost.toString(),
      tempoPayer,
    };
  } catch {
    return null;
  }
}
