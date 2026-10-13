/**
 * The Irys uploader's second balance, from the command line:
 *
 * ```bash
 * npm run irys -- balance                 # lamports the wallet holds at Irys, and the wallet's SOL
 * npm run irys -- price 4096              # what 4 KiB costs right now, in lamports
 * npm run irys -- fund 0.05               # move 0.05 SOL from the wallet to its Irys balance
 * ```
 *
 * The wallet is **the key the runtime actually uploads with**, resolved the way
 * `frontend/src/app/api/_lib/runner.ts` `loadKeypair()` resolves it: `LATH_RUNTIME_KEYPAIR`
 * (a path, `~` expanded, or an inline JSON array), else `frontend/.runtime-keypair.json` — the
 * console's default, which it spells `.runtime-keypair.json` against its own cwd — else
 * `ANCHOR_WALLET`, else `~/.config/solana/id.json`. Reading `ANCHOR_WALLET` first and
 * unconditionally would mean that on any machine where the two differ, an operator following the
 * console's "fund it with `npm run irys -- fund`" refusal funds a key that never uploads anything.
 * Every command prints which of those four it chose and the address it resolved to, so a fund can
 * be checked against the address the refusal named.
 *
 * The RPC is `--rpc`, else `LATH_DEVNET_RPC`, else `LATH_RPC_URL`; the network is
 * `LATH_IRYS_NETWORK` (default devnet), the node `LATH_IRYS_NODE` and the gateway
 * `LATH_IRYS_GATEWAY`.
 *
 * A fund is one Solana transfer to Irys's address, confirmed at `finalized` — expect a minute.
 * On devnet the SOL is faucet SOL and the bytes expire in ~60 days; on mainnet both are real.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IrysBackend, IrysNetwork } from "../sdk/src";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * The key the runtime uploads with, and the name of the thing that decided it.
 *
 * The order is `loadKeypair()`'s in `frontend/src/app/api/_lib/runner.ts`, because funding any
 * other key is funding a stranger: `LATH_RUNTIME_KEYPAIR` first (the console reads it as a
 * path *or* as an inline JSON array, so this does too), then the console's own default — which it
 * spells `.runtime-keypair.json` against its cwd, and the console's cwd is `frontend/` — and only
 * then `ANCHOR_WALLET`. The CLI wallet stays last rather than being dropped: a deployment that
 * runs the console on the CLI key has neither of the first two, and that is the case the old
 * `ANCHOR_WALLET`-only lookup was right about.
 */
function uploader(): { wallet: Keypair; source: string } {
  const consoleDefault = path.join(__dirname, "..", "frontend", ".runtime-keypair.json");
  const candidates: { source: string; spec: string | undefined }[] = [
    { source: "LATH_RUNTIME_KEYPAIR", spec: process.env.LATH_RUNTIME_KEYPAIR },
    { source: "frontend/.runtime-keypair.json", spec: fs.existsSync(consoleDefault) ? consoleDefault : undefined },
    { source: "ANCHOR_WALLET", spec: process.env.ANCHOR_WALLET },
    { source: "~/.config/solana/id.json", spec: path.join(os.homedir(), ".config/solana/id.json") },
  ];
  for (const { source, spec } of candidates) {
    if (!spec) continue;
    // An inline array is the secret itself; anything else is a path, `~` expanded the way the
    // console expands it.
    const inline = spec.trim().startsWith("[");
    const file = spec.replace(/^~/, os.homedir());
    if (!inline && !fs.existsSync(file)) continue;
    const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(inline ? spec : fs.readFileSync(file, "utf8"))));
    return { wallet, source: inline ? `${source} (inline)` : `${source} (${file})` };
  }
  throw new Error(
    "no uploader key: set LATH_RUNTIME_KEYPAIR or ANCHOR_WALLET, or write frontend/.runtime-keypair.json"
  );
}

async function main(): Promise<number> {
  const [cmd, value] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--rpc");
  const rpc = arg("rpc") ?? process.env.LATH_DEVNET_RPC ?? process.env.LATH_RPC_URL;
  if (!cmd || !["balance", "price", "fund"].includes(cmd) || !rpc) {
    console.error("usage: npm run irys -- balance | price <bytes> | fund <sol>   [--rpc <url>]  (or LATH_DEVNET_RPC)");
    return 2;
  }
  const { wallet, source } = uploader();
  const network = (process.env.LATH_IRYS_NETWORK ?? "devnet") as IrysNetwork;
  const irys = new IrysBackend({
    wallet,
    network,
    rpc,
    node: process.env.LATH_IRYS_NODE,
    gateway: process.env.LATH_IRYS_GATEWAY,
  });
  const sol = (lamports: bigint) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;

  // Said before anything is funded or read, and on stderr so it survives a piped `price`: the
  // risk is an operator funding a key that is not the uploader, and the only guard that
  // survives a changed environment is naming the key this run picked and where it came from.
  console.error(`uploader key ${wallet.publicKey.toBase58()} — from ${source}`);

  if (cmd === "price") {
    const bytes = Number(value);
    if (!Number.isInteger(bytes) || bytes <= 0) throw new Error(`price wants a byte count, got ${value}`);
    const price = await irys.price(bytes);
    console.log(`${bytes} bytes on Irys ${network}: ${price} lamports (${sol(price)})`);
    return 0;
  }
  if (cmd === "fund") {
    const amount = Number(value);
    if (!(amount > 0)) throw new Error(`fund wants an amount in SOL, got ${value}`);
    const lamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));
    console.log(`funding ${await irys.address()} at Irys ${network} (${irys.node}) with ${sol(lamports)}…`);
    const t0 = Date.now();
    const { signature } = await irys.fund(lamports);
    console.log(`funded in ${Date.now() - t0} ms: ${signature}`);
  }
  const balance = await irys.balance();
  const onChain = BigInt(await new Connection(rpc, "confirmed").getBalance(wallet.publicKey));
  console.log(`uploader   ${await irys.address()} — from ${source}`);
  console.log(`network    Irys ${network} · node ${irys.node} · gateway ${irys.gateway}`);
  console.log(`at Irys    ${balance} lamports (${sol(balance)}) — pays for bytes`);
  console.log(`in wallet  ${onChain} lamports (${sol(onChain)}) — pays Solana fees`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
