/**
 * `scripts/evidence` — the evidence page for one filmed loop: a single static page a judge opens
 * after the film, which shows
 * everything the run did on the public explorers — the agent's records, each step's checkpoint and
 * every paid call's USDC debit on explorer.solana.com (devnet), the receipt on SAS when there is one,
 * the loop's access key, payment channel, storage PUTs and settlement on explore.tempo.xyz (Tempo
 * mainnet), and the pinned files on the Irys gateway — with the `lath-audit` commands that check it.
 *
 *   npm run -s evidence -- --loop <loopId> [--console http://localhost:3000] [--rpc <devnet url>]
 *                          [--out <dir>] [--links <demo-links.json>] [--tempo-rpc <url>] [--admin <pubkey>]
 *
 * - `--console`: the laptop console the run was made on (default `http://localhost:3000`). Only its
 *   open reads are used — `GET /api/loops?id=`, `GET /api/zeroclaw/<loopId>`, `GET /api/tempo/treasury`
 *   — so nothing owner-only, decrypted or secret can reach the page.
 * - `--rpc`: a ZK-compression RPC for Solana devnet; default `LATH_DEVNET_RPC`, then `solana config
 *   get` (as `lath-audit` resolves it). Its key is masked in every line this prints and never written.
 * - `--out`: where `index.html` and `evidence.json` (the same facts, for the next tool) go; default
 *   `evidence-out/` at the repository root, which is git-ignored.
 * - `--links`: the take's `demo-links.json` (frontend/e2e/demo-record.spec.ts), a fallback for the
 *   receipt's transaction when the console's view lacks it.
 * - `--render <evidence.json>`: no reads; draws `index.html` again from a gathered `evidence.json`
 *   (beside it, or in `--out`), for a wording or layout change after the console is gone.
 * - `--admin`: the lath-billing treasury admin whose PDAs hold the owner's balance; default
 *   `NEXT_PUBLIC_TREASURY_ADMIN`, then the devnet deployment's (docs/ARCHITECTURE.md §12).
 *
 * Read-only by construction: HTTP GETs to the console and to Irys, read calls to Solana and to Tempo,
 * and no key loaded. A fact that cannot be read is listed on the page under _What this page could not
 * read_, and printed here.
 *
 * **Publishing it is the operator's step**, after the take and before the submission: open
 * `<out>/index.html` from disk and check every link from a logged-out browser, then publish it with
 * the site as `evidence/index.html`, so it serves at getlath.xyz/evidence
 * (`npx wrangler pages deploy . --project-name getlath`). The page is one file:
 * inline CSS, no script, the two fonts from Google Fonts, the mark inline. `evidence.json` stays
 * beside it or off the site, as the operator prefers; the page does not read it.
 */
import * as fs from "fs";
import * as path from "path";
import { rpcArg } from "../../sdk/src/cli";
import { TEMPO_RPC_URL } from "../../sdk/src";
import { buildEvidence } from "./build";
import { gather } from "./gather";
import { maskSecrets, wordProblems } from "./model";
import { renderEvidencePage } from "./render";

const REPO = path.resolve(__dirname, "..", "..");
/** The devnet lath-billing admin (docs/ARCHITECTURE.md §12, `scripts/dev-devnet.sh`'s default). */
const DEVNET_BILLING_ADMIN = "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // `--render <evidence.json>`: draw the page again from facts already gathered, with no read at all,
  // for a wording or layout change after the take, when the console may be gone.
  const again = arg(argv, "render");
  if (again) {
    const evidence = JSON.parse(fs.readFileSync(again, "utf8"));
    const html = renderEvidencePage(evidence);
    const target = path.resolve(arg(argv, "out") ?? path.dirname(again));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "index.html"), html);
    console.log(`wrote ${path.join(target, "index.html")} from ${again}`);
    for (const p of wordProblems(html)) console.log(`  check the words: ${p}`);
    return 0;
  }
  const loopId = arg(argv, "loop");
  if (!loopId || !/^loop-[0-9a-f]{16}$/.test(loopId)) {
    console.error(
      "usage: npm run -s evidence -- --loop <loop-…16 hex> [--console url] [--rpc url] [--out dir] [--links file]"
    );
    return 3;
  }
  const consoleUrl = (arg(argv, "console") ?? "http://localhost:3000").replace(/\/+$/, "");
  let rpc: string;
  try {
    rpc = rpcArg(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 3;
  }
  const out = path.resolve(arg(argv, "out") ?? path.join(REPO, "evidence-out"));
  const linksFile = arg(argv, "links");
  let links: Record<string, any> | null = null;
  if (linksFile) {
    try {
      links = JSON.parse(fs.readFileSync(linksFile, "utf8"));
    } catch (e) {
      console.error(`--links ${linksFile} could not be read: ${(e as Error).message}`);
      return 3;
    }
  }
  const log = (line: string) => console.log(maskSecrets(line));

  log(`evidence: ${loopId} from ${consoleUrl}, Solana devnet over ${maskSecrets(rpc)}, read-only`);
  const input = await gather({
    loopId,
    console: consoleUrl,
    rpc,
    tempoRpc: arg(argv, "tempo-rpc") ?? TEMPO_RPC_URL,
    billingAdmin: arg(argv, "admin") ?? process.env.NEXT_PUBLIC_TREASURY_ADMIN ?? DEVNET_BILLING_ADMIN,
    links,
    log,
  });
  const evidence = buildEvidence(input);
  const html = renderEvidencePage(evidence);

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), html);
  // The json is the page's facts, not the reads behind them: it carries nothing the page does not.
  fs.writeFileSync(path.join(out, "evidence.json"), maskSecrets(JSON.stringify(evidence, null, 2)) + "\n");

  log(`wrote ${path.join(out, "index.html")} and evidence.json`);
  log(
    `  ${evidence.steps.length} steps, ${evidence.steps.reduce((n, s) => n + s.calls.length, 0)} paid calls, ` +
      `${evidence.tempo.channels.length} Tempo channel(s), receipt: ${
        evidence.receipt ? evidence.receipt.status : "none"
      }, ` +
      `${evidence.sources?.sources.reduce((n, s) => n + s.files.length, 0) ?? 0} files on Irys`
  );
  for (const u of evidence.unread) log(`  not read: ${u}`);
  const problems = wordProblems(html);
  for (const p of problems) log(`  check the words: ${p}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(maskSecrets(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  );
}
