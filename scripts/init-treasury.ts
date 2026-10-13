/**
 * `init-treasury` — creates the one treasury a deployment bills against.
 *
 * A treasury is namespaced by its admin (`["treasury", admin]`), and every user balance,
 * allowance and the USDC vault hang off it. Nothing else in Lath needs configuring, so this
 * is the whole of "standing up billing on a cluster": run it once per admin key, record the
 * PDAs with the deployment (devnet's admin is in docs/ARCHITECTURE.md §12), and hand the admin
 * pubkey to the frontend as `treasuryAdmin`.
 *
 * ```bash
 * R="https://devnet.helius-rpc.com/?api-key=…"
 * ts-node scripts/init-treasury.ts --rpc "$R" \
 *   --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
 *   --sweep-destination <owner pubkey or token account> \
 *   --max-sweep-per-call 1000 --max-sweep-per-day 5000
 * ```
 *
 * Idempotent: if the admin already has a treasury it prints it and exits 0 without sending a
 * transaction. Pass `--dry-run` to print what it would create and stop.
 *
 * ## Choices this script makes for you
 *
 * - **Sweeper defaults to the admin.** The sweeper is the only key allowed to move metered
 *   revenue out of the vault, so a separate hot key (`--sweeper`) is the safer production
 *   shape; the admin is the convenient devnet one.
 * - **The sweep destination is a token account.** Passing a wallet address creates (or reuses)
 *   its associated token account for the mint, because that is what the program stores and
 *   checks on every sweep — it cannot be changed later without a new treasury.
 * - **Caps are in whole USDC** on the command line and micro-USDC on-chain. `0` means
 *   unlimited, which is the default and is worth overriding on anything but a devnet.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BillingClient, USDC_DECIMALS } from "../sdk/src";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usdc(whole: string | undefined): bigint {
  if (!whole) return 0n;
  const n = Number(whole);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${whole} is not a non-negative number`);
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/**
 * Resolves `--sweep-destination` to a token account for `mint`, creating the associated one if
 * a wallet address was given and it does not exist yet. Returns the account and any
 * instruction needed to bring it into being.
 */
async function resolveSweepDestination(
  connection: Connection,
  spec: PublicKey,
  mint: PublicKey,
  payer: PublicKey
): Promise<{ tokenAccount: PublicKey; create?: ReturnType<typeof createAssociatedTokenAccountInstruction> }> {
  // Already a token account for this mint? Then use it as given.
  try {
    const existing = await getAccount(connection, spec);
    if (!existing.mint.equals(mint)) {
      throw new Error(`sweep destination ${spec.toBase58()} holds ${existing.mint.toBase58()}, not ${mint.toBase58()}`);
    }
    return { tokenAccount: spec };
  } catch (e: any) {
    if (/holds/.test(e?.message ?? "")) throw e; // wrong mint is fatal, "not a token account" is not
  }

  const ata = getAssociatedTokenAddressSync(mint, spec, true);
  const info = await connection.getAccountInfo(ata);
  if (info) return { tokenAccount: ata };
  return { tokenAccount: ata, create: createAssociatedTokenAccountInstruction(payer, ata, spec, mint) };
}

async function main() {
  const rpcUrl = arg("rpc", process.env.LATH_DEVNET_RPC);
  if (!rpcUrl) throw new Error("pass --rpc <url> or set LATH_DEVNET_RPC");

  const walletPath = arg("admin", process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json"))!;
  const admin = loadKeypair(walletPath);

  const mintArg = arg("mint");
  if (!mintArg) throw new Error("pass --mint <usdc mint>");
  const usdcMint = new PublicKey(mintArg);

  const destArg = arg("sweep-destination");
  if (!destArg) throw new Error("pass --sweep-destination <wallet or token account>");
  const sweepSpec = new PublicKey(destArg);

  const sweeper = new PublicKey(arg("sweeper", admin.publicKey.toBase58())!);
  const maxSweepPerCall = usdc(arg("max-sweep-per-call"));
  const maxSweepPerDay = usdc(arg("max-sweep-per-day"));

  const connection = new Connection(rpcUrl, "confirmed");
  const billing = BillingClient.fromIdl(connection, admin, { admin: admin.publicKey });

  const existing = await billing.getTreasury();
  if (existing) {
    console.log("treasury already exists — nothing to do\n");
    report(billing, existing.usdcMint, existing.sweepDestination, existing.sweeper, existing);
    return;
  }

  const mint = await getMint(connection, usdcMint);
  if (mint.decimals !== USDC_DECIMALS) {
    throw new Error(`mint ${usdcMint.toBase58()} has ${mint.decimals} decimals, expected ${USDC_DECIMALS}`);
  }

  const { tokenAccount, create } = await resolveSweepDestination(connection, sweepSpec, usdcMint, admin.publicKey);

  console.log(`rpc               ${rpcUrl.replace(/api-key=[^&]+/, "api-key=…")}`);
  console.log(`admin             ${admin.publicKey.toBase58()}  (${walletPath})`);
  console.log(`usdc mint         ${usdcMint.toBase58()}`);
  console.log(`sweep destination ${tokenAccount.toBase58()}${create ? "  (will be created)" : ""}`);
  console.log(`sweeper           ${sweeper.toBase58()}`);
  console.log(`max sweep / call  ${maxSweepPerCall === 0n ? "unlimited" : maxSweepPerCall + " µUSDC"}`);
  console.log(`max sweep / day   ${maxSweepPerDay === 0n ? "unlimited" : maxSweepPerDay + " µUSDC"}`);
  console.log(`treasury          ${billing.treasuryAddress().toBase58()}`);
  console.log(`vault             ${billing.vaultAddress().toBase58()}`);

  if (flag("dry-run")) {
    console.log("\n--dry-run: nothing sent");
    return;
  }

  const initIx = await billing.initTreasuryIx({
    usdcMint,
    sweepDestination: tokenAccount,
    sweeper,
    maxSweepPerCall,
    maxSweepPerDay,
  });
  // One transaction: the destination has to exist before `init_treasury` records it.
  const signature = await billing.send(create ? [create, initIx] : [initIx]);
  console.log(`\ninit_treasury     ${signature}`);

  const treasury = await billing.getTreasury();
  if (!treasury) throw new Error("init_treasury confirmed but the treasury does not read back");
  report(billing, treasury.usdcMint, treasury.sweepDestination, treasury.sweeper, treasury);
}

function report(billing: BillingClient, mint: PublicKey, dest: PublicKey, sweeper: PublicKey, t: { admin: PublicKey }) {
  console.log("Record this with the deployment:\n");
  console.log(`| Admin | \`${t.admin.toBase58()}\` |`);
  console.log(`| Treasury PDA | \`${billing.treasuryAddress().toBase58()}\` |`);
  console.log(`| Vault (USDC) | \`${billing.vaultAddress().toBase58()}\` |`);
  console.log(`| USDC mint | \`${mint.toBase58()}\` |`);
  console.log(`| Sweep destination | \`${dest.toBase58()}\` |`);
  console.log(`| Sweeper | \`${sweeper.toBase58()}\` |`);
  console.log(`| Token program | \`${TOKEN_PROGRAM_ID.toBase58()}\` |`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
