import { Connection, Keypair, SendTransactionError, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * The id the cluster files a signed transaction under: its fee payer's signature, read back out of
 * the wire bytes `sendRawTransaction` is handed. The billing client takes the same signature from
 * the transaction before it sends, so a stub that invented its own would name a
 * transaction the client never asks about.
 */
export function signatureOfWire(raw: Uint8Array): string {
  return bs58.encode(Transaction.from(raw).signature!);
}

/**
 * A `Connection` stand-in for the billing client's send path, and only that: every transaction is
 * accepted and counted, and while `failing` every status read answers 429. It is the in-doubt
 * charge's RPC — the charge lands, and for as long as the client waits nobody can say so.
 *
 * Once `failing` is cleared, a status read reports every signature sent through it as finalized,
 * except those in `lost`, of which the cluster has no record. No chain is behind it: the billing
 * program's instructions are built from the bundled IDL and never executed.
 */
export class DoubtfulRpc {
  readonly sent: string[] = [];
  readonly lost = new Set<string>();
  failing = true;
  statusReads = 0;
  readonly commitment = "confirmed";

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getLatestBlockhash() {
    // A fresh blockhash per call, so a rebuilt transaction has a signature of its own and a resend
    // shows up as a second one.
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 };
  }

  async getAccountInfo() {
    // No legacy grant to repair: the charge goes out as the debit alone.
    return null;
  }

  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    const sig = signatureOfWire(raw);
    this.sent.push(sig);
    return sig;
  }

  async getSignatureStatuses(signatures: string[]) {
    this.statusReads++;
    if (this.failing) throw new Error("429 Too Many Requests");
    return {
      value: signatures.map((s) =>
        this.sent.includes(s) && !this.lost.has(s) ? { err: null, confirmationStatus: "finalized" } : null
      ),
    };
  }

  async getBlockHeight(): Promise<number> {
    // Past every blockhash this hands out, so a transaction it has no record of reads as expired
    // rather than pending.
    return 2_000;
  }
}

/**
 * What one `sendRawTransaction` does, in the order the sends arrive:
 *
 * - `"ok"` forwards it and answers its signature;
 * - `"forward-then-502"` forwards it and then fails the HTTP call, the way a gateway that timed
 *   out on the node answers after the node already has the transaction;
 * - `"drop-502"` fails the HTTP call and forwards nothing;
 * - `"refuse"` is the node's own preflight refusal, a `SendTransactionError` naming
 *   `AllowanceExpired` — nothing forwarded, and the program's reason in the logs.
 */
export type SendOutcome = "ok" | "forward-then-502" | "drop-502" | "refuse";

/**
 * A cluster where every forwarded transaction lands — finalized once `landAfterMs` has passed
 * since it was forwarded — and the provider in front of it fails in the two ways that could cost
 * the billing client its signature: a send that fails after forwarding
 * (`sendOutcomes`), and a block-height read answering a JSON-RPC internal error, which carries no
 * status code and so does not look transient (`heightFaults`).
 *
 * `heights` is what successive `getBlockHeight` calls answer (the last one repeats); every
 * blockhash this hands out is valid through height 1 000. `sendHeights` records the height the
 * cluster stood at when each send arrived, so a test can tell a rebuild sent after the first
 * transaction's blockhash expired from one sent while it could still land.
 */
export class ForwardingRpc {
  /** Signatures forwarded to the cluster, in order: each one lands. */
  readonly forwarded: { signature: string; at: number }[] = [];
  /** Every `sendRawTransaction` call, forwarded or not. */
  sends = 0;
  readonly sendHeights: number[] = [];
  sendOutcomes: SendOutcome[] = [];
  heightFaults = 0;
  heights: number[] = [500];
  landAfterMs = 0;
  statusReads = 0;
  readonly commitment = "confirmed";
  private heightReads = 0;

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getLatestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 };
  }

  async getAccountInfo() {
    return null;
  }

  private currentHeight(): number {
    return this.heights[Math.min(this.heightReads, this.heights.length - 1)];
  }

  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    this.sends++;
    this.sendHeights.push(this.currentHeight());
    const signature = signatureOfWire(raw);
    const outcome = this.sendOutcomes.shift() ?? "ok";
    if (outcome === "refuse") {
      throw new SendTransactionError({
        action: "simulate",
        signature: "",
        transactionMessage:
          "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1773",
        logs: [
          "Program log: Instruction: Charge",
          "Program log: AnchorError thrown in programs/lath-billing/src/lib.rs:301. Error Code: AllowanceExpired. " +
            "Error Number: 6003. Error Message: Allowance has expired.",
        ],
      });
    }
    if (outcome === "drop-502") throw new Error("502 Bad Gateway: upstream connect error");
    this.forwarded.push({ signature, at: Date.now() });
    if (outcome === "forward-then-502") throw new Error("502 Bad Gateway: upstream request timeout");
    return signature;
  }

  /** Forwarded signatures whose transaction has landed by now. */
  landed(): string[] {
    const now = Date.now();
    return this.forwarded.filter((t) => now - t.at >= this.landAfterMs).map((t) => t.signature);
  }

  async getSignatureStatuses(signatures: string[]) {
    this.statusReads++;
    const landed = new Set(this.landed());
    return {
      context: { slot: 1 },
      value: signatures.map((s) => (landed.has(s) ? { err: null, confirmationStatus: "finalized" } : null)),
    };
  }

  async getBlockHeight(): Promise<number> {
    if (this.heightFaults > 0) {
      this.heightFaults--;
      throw Object.assign(new Error("failed to get block height information: Internal error"), { code: -32603 });
    }
    const height = this.currentHeight();
    this.heightReads++;
    return height;
  }
}
