/**
 * What a chain written encrypted holds when an agent's traces are encrypted to its owner, made
 * for the read-side suites.
 *
 * This build writes traces in the clear (SECURITY.md §3) and the SDK's encrypted stores only read:
 * `put` refuses. Devnet still carries chains whose blobs were encrypted, and those must keep
 * auditing, so the suites that prove it need the same bytes, and this is the one place that makes
 * them. It is test-only on purpose: an encryptor shipped in the SDK would be a write path again.
 *
 * Byte-identical to the encrypted format devnet chains carry: `"LTE2" ‖ sha256(plaintext) ‖
 * nonce(12) ‖ ciphertext ‖ tag(16)`, AES-256-GCM with the plaintext hash as the additional data, a
 * fresh nonce per write. `LTE1` is the older format, the same minus the hash in the clear. And the
 * same placement: the plain name when it is free or already opens under this key, the key's variant
 * (`traceVariantName`) when another key's ciphertext holds it. So a reader that opens what this
 * writes opens what those chains hold.
 */
import { createCipheriv, randomBytes } from "crypto";
import {
  EncryptedTraceStore,
  hex,
  MemoryBackend,
  sha256,
  traceVariantName,
  utf8,
  type BlobBackend,
  type StoringTraceStore,
} from "../../sdk/src";

/** A fresh 32-byte AES-256 trace key, as the console's per-agent derivation produced. */
export function traceKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** One sealed blob: the bytes at rest, and the plaintext hash they answer for. */
export function sealTrace(
  key: Uint8Array,
  bytes: Uint8Array,
  format: "LTE2" | "LTE1" = "LTE2"
): { hash: Uint8Array; blob: Uint8Array } {
  if (key.length !== 32) throw new Error("a trace key is 32 bytes");
  const hash = sha256(bytes);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(hash));
  const sealed = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  const header = format === "LTE2" ? Buffer.concat([Buffer.from(utf8("LTE2")), Buffer.from(hash)]) : utf8("LTE1");
  return { hash, blob: new Uint8Array(Buffer.concat([header, nonce, sealed])) };
}

/**
 * An encrypting store as a session wrote through one: `put` seals and files the blob, `putStored`
 * also hands back the ciphertext (what a session bundle carried), and `get` opens through the SDK's
 * own reader, so a suite that reads back through this store is still testing the SDK.
 */
export class SealingTraceStore implements StoringTraceStore {
  private readonly reader: EncryptedTraceStore;

  constructor(readonly backend: BlobBackend, private readonly key: Uint8Array) {
    this.reader = new EncryptedTraceStore(backend, key);
  }

  async put(bytes: Uint8Array): Promise<Uint8Array> {
    return (await this.putStored(bytes)).hash;
  }

  async putStored(bytes: Uint8Array): Promise<{ hash: Uint8Array; stored: Uint8Array }> {
    const { hash, blob } = sealTrace(this.key, bytes);
    const held = await this.backend.get(hex(hash));
    if (!held) await this.backend.set(hex(hash), blob);
    else if (!(await this.opens(held, hash))) await this.backend.set(traceVariantName(this.key, hash), blob);
    return { hash, stored: blob };
  }

  get(hash: Uint8Array): Promise<Uint8Array | null> {
    return this.reader.get(hash);
  }

  /** Whether `held` reads, under this key, as the bytes behind `hash` (the plaintext itself does). */
  private async opens(held: Uint8Array, hash: Uint8Array): Promise<boolean> {
    const one = new MemoryBackend();
    await one.set(hex(hash), held);
    const opened = await new EncryptedTraceStore(one, this.key).get(hash).catch(() => null);
    return opened !== null && hex(sha256(opened)) === hex(hash);
  }
}
