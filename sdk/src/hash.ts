/**
 * The primitives every hash in Lath is built from.
 *
 * Deliberately free of Node built-ins: `crypto` and `Buffer` are what stop a bundle from
 * running in a browser, and the SDK's read path — decode a record, replay a chain, check a
 * trace — has to work in a page with no polyfills at all. `@noble/hashes`
 * gives a synchronous SHA-256 in both runtimes, which WebCrypto cannot: `computeHead` folds a
 * chain step by step and is called from synchronous code.
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

export type Bytes32 = Uint8Array; // length 32

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = nobleSha256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

function scalar(n: bigint | number, bytes: number, signed: boolean): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 8) {
    if (signed) view.setBigInt64(0, BigInt(n), true);
    else view.setBigUint64(0, BigInt(n), true);
  } else if (bytes === 4) {
    view.setUint32(0, Number(n), true);
  } else {
    view.setUint16(0, Number(n), true);
  }
  return out;
}

export function u64le(n: bigint | number): Uint8Array {
  return scalar(n, 8, false);
}

export function i64le(n: bigint | number): Uint8Array {
  return scalar(n, 8, true);
}

export function u16le(n: number): Uint8Array {
  return scalar(n, 2, false);
}

export function u32le(n: number): Uint8Array {
  return scalar(n, 4, false);
}

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

function fromHex(s: string): Uint8Array {
  const clean = s.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Accepts a 32-byte array, a hex string, a PublicKey, or a base58 string. */
export function toBytes32(v: Uint8Array | number[] | string | PublicKey): Uint8Array {
  // Duck-typed rather than `instanceof`: a bundle that carries two copies of web3.js (an app and
  // a workspace package resolving to different node_modules) has two `PublicKey` classes, and
  // a key from the other one is still a key.
  const key = v as unknown as PublicKey;
  if (v instanceof PublicKey || (v && typeof key.toBytes === "function")) return key.toBytes();
  if (typeof v === "string") {
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return fromHex(v);
    try {
      return new PublicKey(v).toBytes();
    } catch {
      return idFromString(v);
    }
  }
  const out = Uint8Array.from(v);
  if (out.length !== 32) throw new Error(`expected 32 bytes, got ${out.length}`);
  return out;
}

export function hex(b: Uint8Array | number[]): string {
  let out = "";
  for (const byte of b) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Deterministic 32-byte id from an arbitrary string (agent names, tool ids, task ids). */
export function idFromString(s: string): Uint8Array {
  return sha256(utf8(s));
}

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace, `undefined` values dropped,
 * arrays left in the order the caller wrote them. Two structurally equal values always produce the
 * same bytes, so a hash of them is reproducible by anyone holding the value — with `jq -S` and
 * `sha256sum` if they like.
 *
 * Byte-identical to `canonicalJson` in `runtime/src/policy.ts`, which hashes policies. It is
 * restated rather than shared because the dependency runs the other way — the runtime imports
 * the SDK — and a browser checking a hash cannot pull in the runtime. It lives here, at the bottom
 * of the SDK, because the signed console message (`signer.ts`) needs it and the client imports the
 * signer: a primitive belongs below both rather than in a cycle between them. `market.ts`
 * re-exports it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * `n` cryptographically strong random bytes, from the Web Crypto API — which Node has had on
 * `globalThis` since 18 and every browser has always had. Used for salts and nonces, never for
 * key material that has to survive a page reload.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export const ZERO32 = new Uint8Array(32);
