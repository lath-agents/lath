/**
 * Trace stores that need Node: the filesystem backend and the AES-256-GCM decrypting store.
 *
 * Kept out of `trace-store.ts` so a browser bundle of the SDK never reaches for `fs`, `path`
 * or `node:crypto`. `sdk/src/index.ts` re-exports these, so nothing in Node changes; a browser
 * imports `@lath/sdk/browser` instead.
 */
import { type EpochStore } from "./rollup";
import { createDecipheriv, randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { hex, sha256 } from "./hash";
import {
  BlobBackend,
  ENCRYPTED_TRACE_TAG_LEN,
  ENCRYPTED_TRACE_WRITE_REFUSED,
  PlainTraceStore,
  splitEncryptedTraceBlob,
  traceVariantName,
  type TraceStore,
} from "./trace-store";
import { encodeLocatorId, LocatorBackend, LocatorEncoding, LocatorScheme, LocatorSchemeValue } from "./locator";

/** One file per blob, named by hex hash. Fine for a single agent host. */
class FileBackend implements BlobBackend {
  constructor(private readonly dir: string) {}
  async set(key: string, bytes: Uint8Array): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, key), bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(path.join(this.dir, key)));
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
}

/**
 * AES-256-GCM decrypting store over `node:crypto`: what `lath-audit --trace-key` opens a chain's
 * blobs with. Blobs are keyed by sha256(plaintext) — the same value anchored on-chain — and are
 * what a chain written encrypted holds: `"LTE2" ‖ hash(32) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, or
 * the older LTE1, the formats `WebEncryptedTraceStore` opens with WebCrypto. The hash is the GCM
 * additional data, so a blob cannot be swapped under another key. Auditors need the symmetric key
 * to read; the public ledger never learns the contents.
 *
 * Read-only: this build writes traces in the clear, so `put` refuses rather than encrypting
 * (`ENCRYPTED_TRACE_WRITE_REFUSED`). It is still a `TraceStore`, because the audit takes one.
 */
export class EncryptedTraceStore implements TraceStore {
  constructor(readonly backend: BlobBackend, private readonly key: Uint8Array) {
    if (key.length !== 32) throw new Error("EncryptedTraceStore needs a 32-byte key");
  }
  async put(_bytes?: Uint8Array): Promise<never> {
    throw new Error(ENCRYPTED_TRACE_WRITE_REFUSED);
  }
  /**
   * Throws on a wrong key or a tampered blob; returns `null` only when nothing is stored, and the
   * blob itself when it is not ciphertext at all — a store read with a key still has to answer
   * for the plaintext blobs beside the traces (epoch blobs `LEP1`, session bundles `LPB1`), and
   * refusing them would make one key the price of reading anything.
   */
  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    const blob = await this.backend.get(hex(hash));
    if (!blob) return null;
    // Filed under its re-hash, a blob proves itself (as in `bundle.ts`): a plaintext that
    // happens to begin with `LTE1`/`LTE2` is not ciphertext to open, and read as one it would throw
    // "carries the hash … in its header". No ciphertext re-hashes to the plaintext hash.
    if (hex(sha256(blob)) === hex(hash)) return blob;
    try {
      return this.open(blob, hash);
    } catch (refused) {
      // The plain name may hold another agent's ciphertext of the same plaintext; this key's copy
      // is then under its variant. With none, the refusal of the plain name is the answer.
      const variant = await this.backend.get(traceVariantName(this.key, hash));
      if (!variant) throw refused;
      return this.open(variant, hash);
    }
  }

  private open(blob: Uint8Array, hash: Uint8Array): Uint8Array {
    const parts = splitEncryptedTraceBlob(blob);
    if (!parts) return blob;
    // A blob whose header names another hash is one this backend filed wrong, and decrypting it
    // under the hash that was asked for would hand the caller bytes the chain never committed to
    // this key. The tag would catch it a moment later; saying so here says *what* is wrong.
    if (parts.hash && hex(parts.hash) !== hex(hash)) {
      throw new Error(`blob ${hex(hash)} carries the hash ${hex(parts.hash)} in its header`);
    }
    const b = Buffer.from(parts.ciphertextAndTag);
    const tag = b.subarray(b.length - ENCRYPTED_TRACE_TAG_LEN);
    const ct = b.subarray(0, b.length - ENCRYPTED_TRACE_TAG_LEN);
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parts.nonce));
    d.setAAD(Buffer.from(hash));
    d.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([d.update(ct), d.final()]));
  }
}

export class FileTraceStore extends PlainTraceStore {
  constructor(dir: string) {
    super(new FileBackend(dir));
  }
}

/**
 * A directory of blobs named by an id the *backend* picks — the publisher's side of the
 * `sha256 → locator` map, and the smallest real one there is.
 *
 * It exists for two reasons. It is what an operator runs before committing to Irys:
 * point a static file server at the directory and the resulting URL is a working gateway for
 * `HttpGatewayBackend`, so the whole path — anchor, serve, resolve, re-hash — runs end to end
 * with no third party. And it is the honest local stand-in, because the id is **random rather
 * than the content hash**: a content-addressed directory would resolve without the chain and
 * would quietly prove nothing.
 *
 * `encoding` must match what the gateway's URLs use, since the filename is the path segment.
 */
export class FsLocatorBackend implements LocatorBackend {
  readonly scheme: LocatorSchemeValue;
  private readonly encoding: LocatorEncoding;

  constructor(private readonly dir: string, opts: { scheme?: LocatorSchemeValue; encoding?: LocatorEncoding } = {}) {
    this.scheme = opts.scheme ?? LocatorScheme.Raw;
    this.encoding = opts.encoding ?? "hex";
  }

  private nameOf(id: Uint8Array): string {
    return encodeLocatorId(id, this.encoding);
  }

  async upload(bytes: Uint8Array): Promise<Uint8Array> {
    const id = randomBytes(32);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, this.nameOf(id)), bytes);
    return new Uint8Array(id);
  }

  async download(id: Uint8Array): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(path.join(this.dir, this.nameOf(id))));
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
}

/** Epoch blobs as files named by their root: `<dir>/<root hex>.epoch`. */
export class FileEpochStore implements EpochStore {
  constructor(private readonly dir: string) {}

  private pathFor(root: Uint8Array): string {
    return path.join(this.dir, `${hex(root)}.epoch`);
  }

  async put(root: Uint8Array, blob: Uint8Array): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.pathFor(root), blob);
  }

  /**
   * `null` only for a file that is not there. Any other failure — a directory this process cannot
   * read, a disk error — throws, because an audit counts a `null` root as an epoch whose bytes
   * nobody kept, and a re-anchor skips it as having none to upload.
   */
  async get(root: Uint8Array): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.pathFor(root)));
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
}
