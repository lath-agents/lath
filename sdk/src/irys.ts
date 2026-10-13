/**
 * Irys as a `LocatorBackend` — the decentralized blob store behind the on-chain
 * `sha256 → locator` map (SPEC.md §14.1).
 *
 * Nothing above this file knows about Irys. `AnchoredTraceStore`, `AnchoredEpochStore`, the
 * K-epoch manifests and `lath-audit` see only the two-method interface and `LocatorScheme.Irys`.
 * What this adds is the publisher's side: a funded uploader that returns a transaction id, which
 * is 32 bytes and therefore fits the locator cell inline.
 *
 * ## What is trusted for what
 *
 * Irys is trusted for **availability** and never for **correctness**. Every reader re-hashes:
 * `AnchoredTraceStore.get` compares `sha256(bytes)` to the hash the chain carries, and an epoch
 * reader rebuilds the root with `verifyEpochBlob`. A gateway that returns the wrong bytes shows
 * up as *missing*, never as a trace. There is no code path here that believes Irys, and
 * `download` is nothing but `HttpGatewayBackend` — the same read an auditor with no keys does.
 *
 * ## The id
 *
 * An Irys receipt prints its id in **base58** (the way the SDK built against —
 * `@irys/upload-solana` 0.1.8 — returns it): 44 characters for 32 bytes, or 43 for about one id in
 * eighteen, whose value is below 58^43. The gateway serves the same bytes under the base58 spelling
 * *and* under the unpadded base64url spelling it inherits from the bundler lineage it grew out of
 * (always 43 characters), which is what `HttpGatewayBackend` already speaks and what the console
 * and `lath-audit --encoding base64url` read with. Either way the cell carries the 32 raw bytes;
 * `decodeIrysId` accepts both spellings and refuses anything that is not exactly 32 bytes.
 *
 * The two spellings overlap: a 43-character string drawn only from the base58 alphabet is a valid
 * spelling of two different ids (about 1.3% of base64url ids, and as many 43-character receipts).
 * Nothing in the string says which it is — base58 always round-trips — so `decodeIrysId` reads it
 * as base58, the receipt's spelling and the one `upload` anchors, and a caller holding a gateway
 * spelling says so with `spelling: "base64url"`.
 *
 * ## Money and order
 *
 * Uploads are paid from a balance the wallet holds *at Irys*, funded from Solana by `fund`.
 * That is a second balance beside the SOL the same key spends on fees, and running out of
 * either looks different: no SOL refuses the epoch, no Irys credit makes `upload` throw. An
 * `upload` that throws does not fail the session or lose the epoch. `createEpochCommitter` first
 * tries again — three attempts by default, 1 s then 2 s apart, the whole wait capped at ten
 * seconds — but only for a failure another attempt could survive: a dropped connection, a
 * timeout, a 5xx. The 4xx answers are this file's own failures (no balance at Irys, a bundle over
 * the node's size limit, a rejected signature); they will say the same thing in two seconds, so
 * they skip the wait. Only then does it write the blob to the fallback store the console gave
 * the epoch store — its own trace directory — commit the epoch, and report `anchored: false` with
 * this error in `anchorError` and the number of tries in `anchorAttempts`. Nothing is anchored
 * for that epoch, because there is no uploaded id to point a cell at; the bytes are on the console
 * until the operator re-uploads them with `lath-audit reanchor`, which uploads each fallen-back
 * blob and repoints its cell. The write order is blob, then `commit_epoch`, then the locator, so a
 * paid-for blob whose chain write then fails is an orphan nobody points
 * at (harmless), and a committed epoch whose locator write fails is `anchorError` or, with
 * manifests, `anchorPending` until `flushAnchors()`. `upload` itself is one call with no retry
 * loop: the committer retries only failures it has classified, while a retry *here* would repeat
 * uploads that threw after the bytes were paid for, and pay twice for one blob.
 *
 * Node only (it signs uploads): exported from `sdk/src/index.ts`, never from `browser.ts`.
 * Browsers read Irys through `HttpGatewayBackend` with `scheme: 4, encoding: "base64url"`.
 *
 * Devnet uploads are kept for about 60 days and paid with devnet SOL; permanence is a mainnet
 * property.
 */
import bs58 from "bs58";
import {
  encodeLocatorId,
  HttpGatewayBackend,
  IRYS_ENCODING,
  IRYS_GATEWAY,
  LocatorBackend,
  LocatorScheme,
  LocatorSchemeValue,
  MAX_LOCATOR_BYTES,
} from "./locator";

export type IrysNetwork = "mainnet" | "devnet";

/** The upload nodes per network, as `@irys/upload-core` 0.0.10 resolves them. */
export const IRYS_NODES: Record<IrysNetwork, string> = {
  mainnet: "https://uploader.irys.xyz",
  devnet: "https://devnet.irys.xyz",
};

/**
 * The gateway and the spelling a reader fetches with. They are defined in `locator.ts`, which a
 * browser can import, and re-exported here so the publisher's side reads as one module.
 */
export { IRYS_ENCODING, IRYS_GATEWAY } from "./locator";

interface IrysBackendOptions {
  /** The Solana key that pays Irys for bytes — a `Keypair`, or its 64-byte secret key. */
  wallet: { secretKey: Uint8Array } | Uint8Array;
  network: IrysNetwork;
  /** The Solana RPC Irys prices against and `fund` sends through. Required on devnet. */
  rpc: string;
  /** The Irys node uploads go to. Defaults to the network's. */
  node?: string;
  /** The gateway `download` reads through. Defaults to `IRYS_GATEWAY`. */
  gateway?: string;
  /** Injected for tests, and for callers who need headers or a proxy. Reads only. */
  fetch?: typeof fetch;
}

/** The slice of the Irys client this backend uses, typed here so the SDK's types do not depend on Irys's. */
interface IrysClient {
  address?: string;
  upload(data: Buffer, opts?: { tags?: { name: string; value: string }[] }): Promise<{ id: string; timestamp: number }>;
  getBalance(): Promise<{ toString(): string }>;
  getPrice(bytes: number): Promise<{ toString(): string }>;
  fund(amount: string): Promise<{ id: string; quantity: string }>;
}

export class IrysBackend implements LocatorBackend {
  readonly scheme: LocatorSchemeValue = LocatorScheme.Irys;
  readonly network: IrysNetwork;
  readonly node: string;
  readonly gateway: string;
  readonly rpc: string;
  private readonly secretKey: Uint8Array;
  private readonly reader: HttpGatewayBackend;
  private client: Promise<IrysClient> | null = null;

  constructor(opts: IrysBackendOptions) {
    const secretKey = opts.wallet instanceof Uint8Array ? opts.wallet : opts.wallet?.secretKey;
    if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
      throw new Error("IrysBackend needs the uploader's Solana keypair (a 64-byte secret key)");
    }
    if (opts.network !== "mainnet" && opts.network !== "devnet") {
      throw new Error(`IrysBackend network is "mainnet" or "devnet", got ${JSON.stringify(opts.network)}`);
    }
    if (!opts.rpc) throw new Error("IrysBackend needs the Solana RPC url Irys prices against (rpc)");
    this.secretKey = secretKey;
    this.network = opts.network;
    this.rpc = opts.rpc;
    this.node = (opts.node || IRYS_NODES[opts.network]).replace(/\/+$/, "");
    this.gateway = (opts.gateway || IRYS_GATEWAY).replace(/\/+$/, "");
    this.reader = new HttpGatewayBackend(this.gateway, {
      scheme: LocatorScheme.Irys,
      encoding: IRYS_ENCODING,
      fetch: opts.fetch,
    });
  }

  /** The URL an auditor fetches for a locator — the base64url spelling the gateway accepts. */
  urlFor(id: Uint8Array): string {
    return this.reader.urlFor(id);
  }

  /**
   * One upload, one receipt, the receipt's id as 32 raw bytes. Throws on anything else —
   * no funds, no node, an id of another length — and never retries: the caller above already
   * treats a throwing anchor as `anchorError`, and a second attempt could pay twice.
   */
  async upload(bytes: Uint8Array): Promise<Uint8Array> {
    const irys = await this.connect();
    const receipt = await irys.upload(Buffer.from(bytes), {
      tags: [{ name: "Content-Type", value: "application/octet-stream" }],
    });
    return decodeIrysId(receipt.id);
  }

  /** Read-only, over the gateway. A gateway that is down and a blob that never existed are both `null`. */
  async download(id: Uint8Array): Promise<Uint8Array | null> {
    return this.reader.download(id);
  }

  /** The uploader's Solana address — what `fund` credits and what the balance belongs to. */
  async address(): Promise<string> {
    const irys = await this.connect();
    if (!irys.address) throw new Error("the Irys client reported no address for the uploader");
    return irys.address;
  }

  /** Lamports credited to the uploader at Irys — the second balance, not the wallet's SOL. */
  async balance(): Promise<bigint> {
    return BigInt((await (await this.connect()).getBalance()).toString());
  }

  /** What Irys charges for `bytes`, in lamports, at this moment. */
  async price(bytes: number): Promise<bigint> {
    return BigInt((await (await this.connect()).getPrice(bytes)).toString());
  }

  /**
   * Moves `lamports` of SOL from the wallet to its Irys balance: one Solana transfer to Irys's
   * address, confirmed at `finalized`, so expect it to take the better part of a minute.
   */
  async fund(lamports: bigint): Promise<{ signature: string }> {
    if (lamports <= 0n) throw new Error("fund needs a positive number of lamports");
    const res = await (await this.connect()).fund(lamports.toString());
    return { signature: res.id };
  }

  /**
   * Built on first use, so constructing a backend costs nothing and importing the SDK never
   * loads Irys's client. `@irys/upload` and `@irys/upload-solana` are the packages the SDK
   * depends on for this; the dynamic import keeps them off every other path.
   */
  private connect(): Promise<IrysClient> {
    if (!this.client) {
      this.client = (async () => {
        const [{ Uploader }, { Solana }] = await Promise.all([import("@irys/upload"), import("@irys/upload-solana")]);
        const builder = Uploader(Solana as any)
          .withWallet(this.secretKey)
          .withRpc(this.rpc)
          .network(this.network)
          .bundlerUrl(this.node);
        return (await builder.build()) as unknown as IrysClient;
      })();
      // A failed connection is not cached: the next call sees the same error, not a dead promise.
      this.client.catch(() => (this.client = null));
    }
    return this.client;
  }
}

/**
 * An Irys transaction id, as the receipt prints it (base58) or as the gateway path spells it
 * (unpadded base64url), to its 32 raw bytes. Anything that is not exactly 32 bytes is refused —
 * a truncated id would still fit the cell and would point at nothing.
 *
 * Without `spelling`, an id that is valid in both (43 characters, all in the base58 alphabet) is
 * read as base58 — the receipt's spelling, so `upload` never anchors the wrong bytes — and a
 * base64url id of that shape decodes to another id. A caller that knows it holds the gateway's
 * spelling passes `"base64url"` and is never guessed for (see the header's _The id_).
 */
export function decodeIrysId(id: string, spelling?: "base58" | "base64url"): Uint8Array {
  let raw: Uint8Array | null = null;
  if (spelling !== "base64url" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(id)) {
    try {
      raw = new Uint8Array(bs58.decode(id));
    } catch {
      raw = null;
    }
  }
  if (spelling !== "base58" && (!raw || raw.length !== MAX_LOCATOR_BYTES) && /^[A-Za-z0-9_-]{43}$/.test(id)) {
    raw = new Uint8Array(Buffer.from(id, "base64url"));
  }
  if (!raw || raw.length !== MAX_LOCATOR_BYTES) {
    throw new Error(
      `an Irys transaction id decodes to ${MAX_LOCATOR_BYTES} bytes; ${JSON.stringify(id)} ` +
        `decodes to ${raw ? raw.length : "nothing"} — refusing to anchor it`
    );
  }
  return raw;
}

/** The id as Irys prints it: base58 of the 32 bytes. `encodeLocatorId(id, "base64url")` is the other spelling. */
export function irysIdString(id: Uint8Array): string {
  if (id.length !== MAX_LOCATOR_BYTES) throw new Error(`an Irys id is ${MAX_LOCATOR_BYTES} bytes, got ${id.length}`);
  return bs58.encode(id);
}

/** Both spellings the gateway serves an id under. */
export function irysIdSpellings(id: Uint8Array): { base58: string; base64url: string } {
  return { base58: irysIdString(id), base64url: encodeLocatorId(id, "base64url") };
}
