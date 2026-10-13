/**
 * A wallet adapter that signs with a keypair from the environment, so Playwright can drive the
 * **write** paths — deposit, approve, revoke, and the signed messages that deploy an
 * agent or start a loop — that a browser extension otherwise gates.
 *
 * ## Why this is safe, and how it is kept that way
 *
 * A key-holding adapter compiled into a web app is exactly the thing that should never reach
 * production, so it is fenced by three conditions that all have to hold, checked here rather
 * than at the call site:
 *
 * 1. `NEXT_PUBLIC_E2E_WALLET_SECRET` is set. In every real build it is not, and the module's
 *    only export returns `null`.
 * 2. `NEXT_PUBLIC_CLUSTER` is `devnet`. A key that can sign on mainnet is never
 *    loaded, whatever the first variable says. Devnet is the only cluster
 *    this project runs its browser suite on (`frontend/e2e`); the devnet E2E key is derived from source by
 *    `scripts/seed.ts --devnet` and may only ever hold faucet funds.
 * 3. `NODE_ENV !== "production"`. `next build` for deployment cannot switch this on even with
 *    both variables present.
 *
 * The seed script prints the secret only under `--e2e-wallet`, so the default env a developer
 * generates does not contain a key at all; on devnet `dev-devnet.sh` loads it only under `--e2e`.
 */
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";
import { BaseSignerWalletAdapter, WalletReadyState } from "@solana/wallet-adapter-base";
import { ed25519 } from "@noble/curves/ed25519.js";

const NAME = "E2E Keypair" as any;

/**
 * What a signature is about to cover, handed to `window.__lathE2ESignHook` when a page defines one.
 *
 * The recorded demo (`e2e/demo-record.spec.ts`) defines it to show a wallet's approval card with
 * these exact bytes before the keypair signs, because this adapter has no window of its own and the
 * film would otherwise show no signature at all. The hook can delay a signature and read what it
 * covers; it cannot change either, since the adapter signs what it was given after the hook returns.
 * No page of the app defines it, so a suite run never waits on it.
 */
export type E2ESignRequest =
  | { kind: "message"; text: string; signer: string }
  | { kind: "transaction"; programs: string[]; feePayer: string | null; signer: string };

async function beforeSign(request: E2ESignRequest): Promise<void> {
  const hook = (globalThis as { __lathE2ESignHook?: (r: E2ESignRequest) => unknown }).__lathE2ESignHook;
  if (typeof hook === "function") await hook(request);
}

/** The programs a transaction calls, in order and once each, for the approval card. */
function programsOf(tx: Transaction | VersionedTransaction): { programs: string[]; feePayer: string | null } {
  if (tx instanceof VersionedTransaction) {
    const keys = tx.message.staticAccountKeys;
    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58() ?? "?");
    return { programs: [...new Set(programs)], feePayer: keys[0]?.toBase58() ?? null };
  }
  const programs = tx.instructions.map((ix) => ix.programId.toBase58());
  return { programs: [...new Set(programs)], feePayer: tx.feePayer?.toBase58() ?? null };
}

class E2EWalletAdapter extends BaseSignerWalletAdapter {
  name = NAME;
  url = "https://github.com/anza-xyz/wallet-adapter";
  // A 1×1 transparent gif: the modal wants an icon and this wallet has no brand to show.
  icon = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  readonly supportedTransactionVersions = new Set(["legacy", 0] as const);
  readyState = WalletReadyState.Installed;

  private _publicKey: PublicKey | null = null;

  constructor(private readonly keypair: Keypair) {
    super();
  }

  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return false;
  }

  async connect(): Promise<void> {
    this._publicKey = this.keypair.publicKey;
    this.emit("connect", this._publicKey);
  }

  async disconnect(): Promise<void> {
    this._publicKey = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    await beforeSign({ kind: "transaction", ...programsOf(tx), signer: this.keypair.publicKey.toBase58() });
    if (tx instanceof VersionedTransaction) tx.sign([this.keypair]);
    else tx.partialSign(this.keypair);
    return tx;
  }

  /**
   * `signMessage` is what `useWallet()` exposes only when the adapter has it, and it is what the
   * server-side routes verify (`verifyAuth`): a `Lath deploy` / `loop` / `market` message
   * signed by the wallet. A 64-byte web3.js secret key is `seed ‖ pubkey`; ed25519 signs with
   * the seed.
   */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    await beforeSign({
      kind: "message",
      text: new TextDecoder().decode(message),
      signer: this.keypair.publicKey.toBase58(),
    });
    return ed25519.sign(message, this.keypair.secretKey.slice(0, 32));
  }
}

/** The keypair behind the three fences above, or `null` — the answer in every build that is not a local test run. */
function e2eKeypair(): Keypair | null {
  const secret = process.env.NEXT_PUBLIC_E2E_WALLET_SECRET;
  if (!secret) return null;
  if (process.env.NEXT_PUBLIC_CLUSTER !== "devnet") return null;
  if (process.env.NODE_ENV === "production") return null;
  try {
    // A JSON array of 64 bytes — what `solana-keygen` and the seed script write.
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
  } catch {
    // A malformed key is a broken test setup, not a reason to break the app.
    return null;
  }
}

/** The adapter, or `null` — which is the answer in every build that is not a local test run. */
export function e2eWallet(): Adapter | null {
  // The three fences again, inline ahead of `new`: Next folds these reads to constants, and only a
  // constant `return null` in this function lets the minifier drop the adapter class from a
  // production bundle. Behind the shared `e2eKeypair()` call alone the class survived (CI's grep).
  if (!process.env.NEXT_PUBLIC_E2E_WALLET_SECRET) return null;
  if (process.env.NEXT_PUBLIC_CLUSTER !== "devnet") return null;
  if (process.env.NODE_ENV === "production") return null;
  const keypair = e2eKeypair();
  return keypair ? (new E2EWalletAdapter(keypair) as unknown as Adapter) : null;
}

/**
 * The E2E keypair's public key under the same fences, for a view that treats that wallet's runs as
 * the operator's (`/billing`). A page compares the connected `publicKey` to this rather than reading
 * the adapter's *name*, which any wallet may call itself. `null` wherever the adapter is.
 */
export function e2eWalletPublicKey(): PublicKey | null {
  return e2eKeypair()?.publicKey ?? null;
}
