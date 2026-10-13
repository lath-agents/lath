import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { installCursor, installSecretMask, installWalletCard } from "./demo-overlay";
import { deployBlankAgent } from "./loop-flow";
import { closeInfo, openAdvanced, openInfo } from "./disclose";
import { LOOP_PRESETS } from "@/lib/loop-presets";

/**
 * The submission demo, recorded: one real goal loop on devnet, started from an agent that already
 * exists, driven in the order of the shot list below and filmed by Playwright as one uncut take.
 *
 * **The loop is the _Protocol research and audit_ preset** (`protocol-audit`): a one-page audit note
 * on Squads v4, one paragraph in four parts, cited from two pinned files — the program's instructions
 * folder at a commit, the program on Solana devnet at a slot — that takes a part or two a step until
 * the decision model judges all four there, up to 6 steps 10 s apart, one budget of 1 USDC, and the
 * receipt on SAS when it says _achieved_. Nothing on chain changes during the run, so nothing is spent
 * but the run's own money. The film's claim is that the note is pinned and citable, never that the
 * audit is right.
 *
 * Not a test of the product, and never part of a suite run: it spends real USDC.e from the Tempo
 * treasury, spends the console's runtime key's SOL on the receipt's rent, and runs only with
 * `DEMO_RECORD=1`. The uncut video is the evidence the cut is held to, so nothing here stages a figure:
 * every chip, answer and cost on screen is the run's own, and nothing is spliced in from another run.
 *
 * **The film shows how a loop works; the evidence page shows it checks.** The take spends no time on
 * explorer hops or a terminal: a judge opens the evidence page after watching
 * (`npm run -s evidence -- --loop <loopId>`, a separate build: every transaction of the loop on
 * explorer.solana.com, the SAS receipt, explore.tempo.xyz and Irys), and the film's last beat points
 * at it. The hops are behind `DEMO_EXPLORER_HOPS=on`, and the audits run here — a take that would not
 * verify fails now, not in the edit — but they are not a filmed beat.
 *
 * **Two variants, decided by the console, not by a knob.** With `LATH_PROTOCOL_PLUGINS` on and the
 * `loop-receipt` schema seeded, `GET /api/loops` names a receipt pointer (`attestDemo.receipt`), the
 * preset's form sends it, and the take films SAS · receipt (the shots marked **R** below). With the
 * switch off it films the variant without the receipt. The take reads which once, at its start, so
 * every shot agrees with the form the run was started from; `prepare` says which it will be before
 * anything is spent. A console with the switch on and no receipt pointer is refused rather than filmed
 * without one: the preset picks no receipt there and Start is not held, but the form would show a
 * _Protocol plugins_ section switched off, which neither variant films, and the take would run without
 * the receipt its console was started for.
 *
 * **The agent exists before the take**: `prepare` deploys it, unfilmed, when it is not there yet, so
 * the film opens on an agent already registered on Solana with its cap, and the one signature on
 * camera is the loop's.
 *
 * Two cases, run in order with `--workers=1`:
 *
 * - **prepare** (no video): the console can run billed sessions, the treasury is set and holds no open
 *   channel, and — for the receipt variant — the receipt pointer is there and the console's runtime
 *   key, which pays the receipt's rent and fee, holds at least 0.05 SOL; then, only once all of that
 *   holds, the demo agent is deployed through the wizard's Blank path with the E2E wallet if it does not
 *   exist, and checked to be the E2E wallet's and to carry no store tools;
 * - **take** (video on), shots 1–6 (7, the evidence page, and 8, the end card, are not in it):
 *   1. **the agent** — Agents, the agent's row and its panel (its cap on Solana), the pointer on
 *      _Run as a loop_, then a cut to the preset's link, `&preset=protocol-audit` (no preset is listed on
 *      screen): the form on that agent, filled from the preset, with no _Start from_;
 *   2. **the form** — the goal, the cost line, _Decision model checks the goal_, the two read-only Files and _Check
 *      sources_ resolving the repo to its commit and the program to its slot, 6 steps, 1 USDC; **R**
 *      then the _Protocol plugins_ section with SAS · receipt pressed (and any _soon_ chips the form
 *      shows);
 *   3. **the start** — the one `"Lath loop"` signature and the start button's stages, onto the loop page;
 *   4. **started** — the Tempo-enforced cap row (the loop's own key and its limit) and **R** the receipt
 *      card _waiting_; screenshot `01-started`;
 *   5. **running** — the pending row, the money flow (your cap on Solana → Lath's treasury on Tempo →
 *      OpenRouter via Tempo), the open channel's bar call by call, then each step's row as it lands —
 *      its Answer, the decision model's goal chip and its Tempo figure, the later rows held briefly —
 *      _continue_ until one says _achieved_; screenshot `02-running` on the first row that says
 *      _continue_ (on step 1's row, noted, if step 1 is already _achieved_);
 *   6. **finished** — the finish note, _Open report_ when a step published one (the one-page note,
 *      stored on Tempo, re-hashed in this browser; cut otherwise), the flow's settlement and the _Paid
 *      on Tempo_ card, **R** the wait for the receipt (a skip card), a reload and the _Receipt on SAS_
 *      card turned _published_; screenshot `03-finished` (without the receipt, after the settlement);
 *      then a short Proof.
 *
 * **Three screenshots, the run's own frames.** `01-started`, `02-running` and `03-finished`, each a
 * full-page PNG and a viewport PNG at the take's size, taken off the clock once the page shows what
 * the frame names, and marked on the timeline. Nothing is staged for them: each is
 * taken at the moment it names, and one that could not be taken is a timeline note rather than a
 * failed take, since the run is already spending. `loop-screens.spec.ts` takes the same three of a run
 * started by hand, read-only.
 *
 * What the take leaves in its output directory (`test-results/demo-record-…-take/`):
 *
 * - `take.webm`, the uncut take;
 * - `01-started.png`, `01-started-viewport.png`, and the same for `02-running` and `03-finished`;
 * - `demo-timeline.json`: each beat's offset from the start of the take, so the cut can place its
 *   skip cards with the real time skipped. The offsets start within a second of the video's first
 *   frame;
 * - `demo-links.json`: what the end card and the evidence page need, as this run produced it — the
 *   evidence command for this loop, the last step's `loop.step` transaction on explorer.solana.com
 *   (read from the loop row, which keeps each checkpoint's signature), the channel's close on
 *   explore.tempo.xyz, the loop key, **R** the receipt's attestation and transaction, the loop page,
 *   the audit commands, the screenshots, and where the pinned files are on Irys; without the receipt,
 *   the end card's one line of text;
 * - `sources-irys.json`: each pinned file's Irys id (the ids show only on the sandbox page, which
 *   stays off camera), read from the console's open sandbox route and the index and
 *   manifest on Irys;
 * - `tempo-stats.txt`: `npm run -s tempo:stats` for the treasury, a read, for the end card's line;
 * - `verify-channel.txt`, `verify-step.txt`, and `verify-receipt.txt` or `audit-irys.txt`: the
 *   audits' output, run here once the loop has a checkpoint, and the exact commands — the take's self-
 *   check, and what the evidence page's one `lath-audit` line is read from.
 *
 * The wallet is the E2E keypair (`lib/e2e-wallet.ts`): it signs without a prompt, so the start shows
 * the button's stages and not a wallet window, and the voice-over carries the signature. It loads only
 * under `next dev` on devnet, and its secret is served to the LAN (SECURITY.md): record on a
 * network you trust.
 *
 * The console is `dev:devnet -- --e2e` with the variables below: the protocol plugins and their key
 * directory (the receipt), the loop's own Tempo access key unscoped (shot 4's cap row), and the
 * mainnet RPC (the preset reads only devnet, but the console keeps it for a loop that reads a mainnet
 * address). No `LATH_LOOP_BUDGET_MAX_USDC`: the budget chips are 1 / 5 / 10 and the preset's 1 USDC
 * is the first. `--e2e` pins blobs and sources on Irys as any devnet console does — the film says
 * that is where they are, so it must never run with `LATH_TRACE_BACKEND=fs`. Run it:
 *
 * ```bash
 * # terminal 1, the console, on :3000. For the variant without the receipt, drop LATH_PROTOCOL_PLUGINS
 * # and LATH_SOLANA_KEY_DIR; prepare says which variant the take will film. (The sed uses `-E` and
 * # `+` rather than ` *`, whose star-slash after `RPC URL:` would close this comment.)
 * RPC="$(solana config get | sed -nE 's/^RPC URL: +//p' | tr -d '[:space:]')"; KEY="${RPC##*api-key=}"
 * LATH_DEVNET_RPC="$RPC" LATH_PROTOCOL_PLUGINS=on LATH_SOLANA_KEY_DIR="$HOME/.lath/solana-keys" \
 * LATH_TEMPO_LOOP_KEYS=on LATH_TEMPO_KEY_DIR="$HOME/.lath/tempo-keys" LATH_TEMPO_KEY_SCOPES=off \
 * LATH_MAINNET_RPC="https://mainnet.helius-rpc.com/?api-key=$KEY" \
 * LATH_TRACE_BACKEND=irys LATH_IRYS_NETWORK=devnet LATH_DEPLOYS_PER_HOUR=30 \
 *   npm run dev:devnet -- --e2e
 * # terminal 2, from frontend/. LATH_TRACE_DIR is the directory the :3112 gateway serves to the
 * # browser, which Playwright starts from this shell; it must be the console's.
 * DEMO_RECORD=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 LATH_TRACE_DIR=$PWD/.traces-devnet LATH_DEVNET_RPC=... \
 *   npx playwright test demo-record --workers=1
 * ```
 *
 * The knobs, all optional:
 *
 * - `DEMO_AGENT`: the agent's name (default `squads-audit-film`: fresh, a name that says what the film
 *   is about, and kept for the end card and the evidence page). `prepare` deploys it when it does not
 *   exist; a fresh name for each take keeps another run's steps off its page (LoopSteps says _N steps …
 *   belong to another run_ otherwise).
 * - `DEMO_BUDGET`: the loop budget chip's label without ` USDC` (default: the first chip, 1). The
 *   chips are 1 / 5 / 10 unless the console's `LATH_LOOP_BUDGET_MAX_USDC` is lower.
 * - `DEMO_UNTIL=sources`: stop after _Check sources_ and the plugins beat, before the signature. With
 *   the agent deployed by `prepare` it spends nothing, so it is how the selectors and the pacing of
 *   shots 1–2 are rehearsed.
 * - `DEMO_LOOP=<id>`: pick up a run already started — a take cut short — on its loop page, instead of
 *   starting one. Shots 1–3 are then not in the take, and neither are `01-started` and `02-running`,
 *   which a run past its start cannot honestly be.
 * - `DEMO_EXPLORER_HOPS=on`: in shot 6 the tab also follows the settlement to explore.tempo.xyz
 *   (without the receipt, the loop key's address page as well) and the receipt's transaction to
 *   explorer.solana.com, then comes back. Default off: the links are pointed at and written into
 *   `demo-links.json`, and the evidence page opens them.
 * - `DEMO_WALLET=off`: no approval card. Default: the signature shows a wallet's card with what it
 *   covers for `DEMO_SIGN_MS` (default 3000) before the keypair signs.
 * - `DEMO_VIEWPORT` (default `1920x1080`), `DEMO_PACE` (the pause on each beat, default 2500 ms),
 *   `DEMO_VIDEO=off` (film the screen instead, with `--headed`), `DEMO_CURSOR=off` (no pointer dot).
 */

const RECORD = process.env.DEMO_RECORD === "1";
const AGENT = process.env.DEMO_AGENT ?? "squads-audit-film";
const AGENT_ID = createHash("sha256").update(AGENT).digest("hex");
const PACE = Number(process.env.DEMO_PACE ?? 2500);
const [WIDTH, HEIGHT] = (process.env.DEMO_VIEWPORT ?? "1920x1080").split("x").map(Number);
const REPO = path.resolve(__dirname, "../..");
const HOPS = process.env.DEMO_EXPLORER_HOPS === "on";

/**
 * What the console's runtime key must hold before a receipt take:
 * the receipt's rent, 2 763 520 lamports for its 416 B account, and a 5 000-lamport fee, with room for
 * a retake. Short of it the publish fails after the stop, which is the one beat a take cannot redo.
 */
const RECEIPT_MIN_LAMPORTS = 50_000_000;

/** Where a pinned file is read in the evidence page: the gateway the plain audit also reads Irys through. */
const IRYS_GATEWAY = "https://gateway.irys.xyz";

/** The end card's one line of text when the receipt is not in the film. */
const NEXT_LINE = "Next: protocol plugins — a receipt on SAS, Pyth, swaps.";

/**
 * The names the approval card gives a transaction's programs: Lath's own from `Anchor.toml`'s devnet
 * table (the ids are the same on both clusters), and the runtime's usual companions. Anything else
 * shows as a shortened id.
 */
const PROGRAM_NAMES: Record<string, string> = {
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  ...Object.fromEntries(
    [...readFileSync(path.join(REPO, "Anchor.toml"), "utf8").matchAll(/^(lath\w*) = "([1-9A-HJ-NP-Za-km-z]+)"$/gm)].map(
      ([, name, id]) => [id, name.replace(/_/g, "-")]
    )
  ),
};

/**
 * The film's terms come from the `protocol-audit` preset: the take reaches it by its link
 * (`&preset=protocol-audit`) after pointing at _Run as a loop_ on the agent, since no preset is
 * listed on screen and the form cannot add the preset's GitHub and Solana sources by hand. Nothing in
 * it is a demo deploy: the repo and the program are Squads v4's own, so `prepare` has no address to
 * hold against a file.
 */
const PRESET = LOOP_PRESETS["protocol-audit"];

/** The preset's two Files as the form shows them read-only: the repo path, then the program on devnet. */
const SOURCES = PRESET.sandbox.sources ?? [];
const SQUADS_PROGRAM = SOURCES.flatMap((s) => (s.kind === "solana" ? [s.address] : []))[0] ?? "";
const SQUADS_REPO = SOURCES.flatMap((s) => (s.kind === "github" ? [s.url] : []))[0] ?? "";

/**
 * How long the take waits for the run's rows: the preset's 6 steps at the 2–3 min a step of this loop
 * takes (its model call, the verify seat and the goal check, each paid on the channel), the 10 s pause
 * between them, and 10 min for the indexer's lag and a slow step on a bad devnet day. A run that has not
 * stopped by then is not filmed around: the take fails on the stop reason below.
 */
const STEPS = PRESET.loop.maxSteps ?? 6;
const STEP_MS = 3 * 60_000;
const ROWS_DEADLINE_MS = STEPS * (STEP_MS + (PRESET.loop.intervalMs ?? 10_000)) + 10 * 60_000;

/**
 * How many landed rows are filmed at the full pace; the ones after are held briefly. Six rows at the
 * full pace would be half a minute of the same three cells, and the cut covers the time between them
 * with skip cards anyway: the later rows only need to be on screen long enough to read their chip.
 */
const ROWS_IN_FULL = 2;

/**
 * How long a step card whose answer line is hidden is given to draw one. Short, because it is on
 * camera: the line is decided in the same pass as the goal chip the take has already read.
 */
const ANSWER_GRACE_MS = 3_000;

/** One JSON-RPC read on a plain devnet RPC. The url is never printed: a Helius url carries its key. */
async function rpcCall(rpc: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json())?.result;
}

/** An account's lamports, as `solana balance` would read them, on a plain devnet RPC. */
async function lamportsOf(rpc: string, address: string): Promise<number> {
  const value = (await rpcCall(rpc, "getBalance", [address, { commitment: "confirmed" }]))?.value;
  if (typeof value !== "number") throw new Error(`getBalance of ${address} did not answer`);
  return value;
}

/**
 * Which variant this console films (the shots marked **R**): the receipt when the console takes protocol
 * plugins and names a receipt pointer, which is exactly when the preset's form sends one. `signer` is
 * the console's runtime key, which signs and pays for the receipt.
 */
async function receiptVariant(
  request: APIRequestContext
): Promise<{ plugins: boolean; receipt: { schema: string; signer: string } | null }> {
  const list = await (await request.get("/api/loops")).json();
  const plugins = list.protocolPlugins === "on";
  return { plugins, receipt: plugins ? list.attestDemo?.receipt ?? null : null };
}

/**
 * Each pinned file's Irys id, for the evidence page. The console's open sandbox route
 * names the loop's sources index on Irys on every view, the owner's or not, because the files are on
 * Irys in clear by design; the index maps each file's sha256 to its id, and the manifest it names maps
 * each path to its sha256. All three are public reads; nothing is uploaded or signed. A failure is
 * written into the file rather than failing a take whose film is already whole.
 */
async function sourcesOnIrys(request: APIRequestContext, loopId: string): Promise<Record<string, unknown>> {
  try {
    const detail = await (await request.get(`/api/zeroclaw/${encodeURIComponent(loopId)}`)).json();
    const irys = detail?.sandbox?.irys?.value;
    if (!irys?.index || !irys?.gateway) {
      return { note: detail?.sandbox?.irys?.note ?? "the console names no sources index on Irys for this loop" };
    }
    // Each object is a tag line, then canonical JSON (`lath.sources.irys.v1`, `SOURCES_TAG` in
    // `runtime/src/zeroclaw/sources.ts`); the tag is not checked here, the evidence page re-hashes.
    const body = async (id: string) => {
      const text = await (await fetch(`${irys.gateway}/${id}`)).text();
      return JSON.parse(text.slice(text.indexOf("\n") + 1));
    };
    const index = await body(irys.index);
    const manifest = await body(index.manifest);
    const link = (id: string | undefined) => (id ? `${IRYS_GATEWAY}/${id}` : null);
    return {
      gateway: irys.gateway,
      index: { id: irys.index, url: link(irys.index) },
      manifest: { id: index.manifest, url: link(index.manifest) },
      sourcesHash: index.sourcesHash,
      sources: (manifest.sources ?? []).map((entry: any) => ({
        source: entry.source,
        dir: entry.dir,
        files: (entry.files ?? []).map((f: any) => ({
          path: f.path,
          size: f.size,
          sha256: f.sha256,
          irys: index.files?.[f.sha256] ?? null,
          url: link(index.files?.[f.sha256]),
        })),
      })),
    };
  } catch (e) {
    return { error: `the sources on Irys could not be read: ${(e as Error).message}` };
  }
}

/** As every spec here connects: wait for the header's trigger, then pick the E2E keypair. */
async function connectWallet(page: Page) {
  await expect(page.locator(".wallet-adapter-button-trigger").first()).toBeVisible({ timeout: 60_000 });
  const select = page.getByRole("button", { name: /select wallet/i });
  if (await select.count()) {
    await select.first().click();
    await page.getByRole("button", { name: /E2E Keypair/i }).click();
  }
  await expect(page.getByRole("button", { name: /select wallet/i })).toHaveCount(0);
}

/** The agent's row in `GET /api/agents`, or `undefined` while the console has none of that id. */
async function agentRow(
  request: APIRequestContext
): Promise<{ id: string; owner?: string; policy?: { tools?: string[] } } | undefined> {
  const agents = await (await request.get("/api/agents")).json();
  return agents.agents.find((a: { id: string }) => a.id === AGENT_ID);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  test.skip(!RECORD, "records the submission demo and spends real USDC.e and the receipt's rent: set DEMO_RECORD=1");
});

test.describe("prepare", () => {
  test("the console is billed, the preset is the film's, and the demo agent exists and is fit to film", async ({
    browser,
    request,
  }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const runner = await (await request.get("/api/run")).json();
    expect(runner.ready, `the server cannot run sessions: ${runner.reason}`).toBe(true);
    // A take must be billed: without a treasury every step runs scripted and the film would show a
    // fixture's answers, which it must never do.
    const treasury = await (await request.get("/api/tempo/treasury")).json();
    expect(treasury.enabled, "start the console with the Tempo treasury").toBe(true);
    expect(treasury.openChannels, "another loop holds a channel open: stop it first").toBe(0);
    // And it can hold this run's deposit: the whole budget plus Lath's decision share (`treasuryShortfall`).
    // The start refuses a run it cannot hold only after the wallet has signed, and the form's amber
    // shortfall line would be on film in shot 2 — so a take that would stop at shot 3 stops here, free.
    const limits = await (await request.get("/api/loops")).json();
    const budget = BigInt(PRESET.loop.budgetMicroUsdc ?? "0");
    const needed = budget + (budget * BigInt(Math.round((limits.jevBudgetPercent ?? 15) * 100))) / 10_000n;
    expect(
      treasury.balanceBase,
      `the treasury's balance could not be read: ${treasury.balanceError ?? ""}`
    ).not.toBeNull();
    expect(
      BigInt(treasury.balanceBase),
      `the treasury ${treasury.address} holds ${Number(treasury.balanceBase) / 1e6} USDC.e; this run's deposit is ` +
        `${Number(needed) / 1e6} (the budget and Lath's ${
          limits.jevBudgetPercent ?? 15
        }% for the decision model): top it up`
    ).toBeGreaterThanOrEqual(needed);

    // A plain account read, so any devnet RPC answers it; the console's own needs the compression index.
    // The runtime key's balance below is the one chain read here: the preset spends no demo target's
    // authority, so nothing else on chain has to be found unspent first.
    const rpc = process.env.DEMO_DEVNET_RPC ?? process.env.LATH_DEVNET_RPC ?? "https://api.devnet.solana.com";
    // The preset as the take films it and the voice describes it: two read-only Files — the program's
    // instructions folder and the program on Solana devnet — up to 6 steps 10 s apart, the one-page note,
    // the receipt asked for. A preset edited since would film a form the voice no longer matches.
    expect(
      SOURCES.map((s) => s.kind),
      "the protocol-audit preset's Files changed"
    ).toEqual(["github", "solana"]);
    expect(SQUADS_REPO, "the protocol-audit preset's GitHub File is no longer the instructions folder").toMatch(
      /^https:\/\/github\.com\/Squads-Protocol\/v4\/tree\/main\/programs\/squads_multisig_program\/src\/instructions$/
    );
    expect(SQUADS_PROGRAM, "the protocol-audit preset names no Solana program").not.toBe("");
    expect(PRESET.loop.goal, "the protocol-audit preset's goal is no longer the one-page note").toMatch(
      /^Before I approve a Squads transaction: who can upgrade this program, [^?]+\? Answer in four parts, one per step/
    );
    expect(PRESET.loop.maxSteps, "the protocol-audit preset's steps changed").toBe(6);
    expect(PRESET.loop.intervalMs, "the protocol-audit preset's pause changed").toBe(10_000);
    expect(PRESET.receipt, "the protocol-audit preset no longer asks for the receipt").toBe(true);

    // The variant, said before anything is spent. With plugins on, the receipt's preconditions are a
    // pointer (the seeded schema and a runtime key) and SOL for the rent. A console that takes plugins
    // but has no pointer opens the preset with the section off — no line and Start not held — but that
    // is a form neither variant films, so it is refused here rather than filmed.
    const variant = await receiptVariant(request);
    if (variant.plugins) {
      expect(
        variant.receipt,
        "LATH_PROTOCOL_PLUGINS is on but GET /api/loops names no attestDemo.receipt: run demo-attest:seed " +
          "and give the console its runtime key, or restart it with the switch off"
      ).not.toBeNull();
      const lamports = await lamportsOf(rpc, variant.receipt!.signer);
      expect(
        lamports,
        `the console's runtime key ${variant.receipt!.signer} holds ${lamports / 1e9} SOL, short of the 0.05 the ` +
          "receipt's rent and fee need"
      ).toBeGreaterThanOrEqual(RECEIPT_MIN_LAMPORTS);
      console.log(
        `[demo] variant: WITH SAS · receipt (schema ${variant.receipt!.schema}, signer ${variant.receipt!.signer}, ` +
          `${
            lamports / 1e9
          } SOL) — shot 2's plugins beat, the receipt in shots 4 and 6, and verify-receipt are in the take`
      );
    } else {
      console.log(
        "[demo] variant: WITHOUT the receipt (LATH_PROTOCOL_PLUGINS off) — the receipt card goes from shots 4 and 6; " +
          "its time goes to the channel's bar and the loop key, and the plain audit from Irys runs instead"
      );
    }

    // The agent, deployed here and not on camera: the film opens on an agent that already exists. Last,
    // so a console that is not ready spends nothing. The deploy is the wizard's Blank path, the one that
    // grants the allowance in the same transaction, with the wizard's default model and the chain reads
    // and no store tools, and its context has no video, since nothing here is in the film.
    let row = await agentRow(request);
    if (!row) {
      const context = await browser.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? testInfo.project.use.baseURL,
      });
      try {
        const page = await context.newPage();
        console.log(`[demo] ${AGENT} does not exist: deploying it with the E2E wallet, unfilmed`);
        await deployBlankAgent(page, AGENT, connectWallet, { timeout: 240_000 });
      } finally {
        await context.close();
      }
      // The console records the deploy as it confirms; a poll covers the registry's write landing after
      // the wizard's done state.
      await expect.poll(async () => !!(await agentRow(request)), { timeout: 120_000 }).toBe(true);
      row = await agentRow(request);
    }
    expect(row!.policy?.tools ?? [], "the demo agent must not carry the store tools").not.toContain("store.get");
    console.log(`[demo] ${AGENT} (${AGENT_ID.slice(0, 8)}…) exists: the take opens on its row`);
  });
});

test.describe("take", () => {
  test("the demo's shot list, one real run", async ({ browser, request }, testInfo) => {
    // The rows' deadline, and around it the form and the start (~5 min), the receipt's wait (≤ 4 min), the
    // three audits (each allowed 10 min) and `tempo:stats` (5 min): a run of its 6 steps must fit whole.
    test.setTimeout(ROWS_DEADLINE_MS + 45 * 60_000);
    // The take films an agent that exists (shot 1); `prepare` deploys it.
    expect(await agentRow(request), `${AGENT} does not exist: run the prepare case first`).toBeTruthy();
    // Its own context, because only a context opened here can film at the take's size: Playwright
    // refuses a per-group `video` option, and the prepare case has nothing worth filming.
    const context = await browser.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? testInfo.project.use.baseURL,
      viewport: { width: WIDTH, height: HEIGHT },
      ...(process.env.DEMO_VIDEO === "off"
        ? {}
        : { recordVideo: { dir: testInfo.outputPath("video"), size: { width: WIDTH, height: HEIGHT } } }),
    });
    const page = await context.newPage();
    const timeline: { beat: string; atMs: number; at: string; note?: string }[] = [];
    const t0 = Date.now();
    const mark = (beat: string, note?: string) => {
      const atMs = Date.now() - t0;
      timeline.push({ beat, atMs, at: new Date().toISOString(), ...(note ? { note } : {}) });
      const m = Math.floor(atMs / 60_000);
      const s = String(Math.floor((atMs % 60_000) / 1000)).padStart(2, "0");
      console.log(`[demo ${m}:${s}] ${beat}${note ? ` — ${note}` : ""}`);
    };

    // Read once, before the first frame: whether this take films SAS · receipt. The form, the receipt
    // card, the audits and the end card all follow this one answer, so a console restarted mid-take
    // cannot film half of each variant.
    const variant = await receiptVariant(request);
    expect(
      !variant.plugins || variant.receipt,
      "LATH_PROTOCOL_PLUGINS is on but the console names no receipt pointer: run the prepare case"
    ).toBeTruthy();
    const RECEIPT = variant.receipt !== null;
    mark("variant", RECEIPT ? "with SAS · receipt" : "without the receipt");

    // The pointer and the wallet's approval card (`demo-overlay.ts`); the card marks the timeline.
    await page.exposeFunction("__demoMark", (beat: string, note?: string) => mark(beat, note));
    await installSecretMask(page);
    if (process.env.DEMO_CURSOR !== "off") await installCursor(page);
    if (process.env.DEMO_WALLET !== "off") {
      await installWalletCard(page, { names: PROGRAM_NAMES, holdMs: Number(process.env.DEMO_SIGN_MS ?? 3000) });
    }

    /** Scrolls `target` to the middle of the screen, moves the pointer onto it, and holds. */
    const pointAt = async (target: Locator, hold = PACE) => {
      await target.waitFor({ timeout: 60_000 });
      await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
      await page.waitForTimeout(700);
      const box = await target.boundingBox();
      if (box) await page.mouse.move(box.x + Math.min(box.width / 2, 180), box.y + box.height / 2, { steps: 30 });
      await page.waitForTimeout(hold);
    };

    /** Whether `target` shows within `timeout`, without failing: a missing frame is noted, not fatal. */
    const shows = (target: Locator, timeout: number) =>
      target.waitFor({ timeout }).then(
        () => true,
        () => false
      );

    /**
     * One of the three screenshots: the viewport at the take's size, then the full page, both the
     * frame the run is showing. Taken off the clock and marked on the timeline so the
     * cut can skip the second the capture takes. A capture that throws is noted and the take goes on:
     * the run is already spending, and the video holds the same frame.
     */
    const screens: { name: string; full: string; viewport: string; atMs: number; note: string }[] = [];
    const screenshot = async (name: "01-started" | "02-running" | "03-finished", note: string) => {
      try {
        await page.screenshot({ path: testInfo.outputPath(`${name}-viewport.png`) });
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
        screens.push({ name, full: `${name}.png`, viewport: `${name}-viewport.png`, atMs: Date.now() - t0, note });
        mark(`screenshot: ${name}`, note);
      } catch (e) {
        mark(`screenshot: ${name} FAILED`, (e as Error).message.slice(0, 200));
      }
    };

    try {
      let loopId: string;
      if (process.env.DEMO_LOOP) {
        // `DEMO_LOOP` picks up a run already started — a take cut short — on its own page, so the rest
        // of the same run is filmed instead of paying for a new one.
        await page.goto(`/loop/${process.env.DEMO_LOOP}`);
        await connectWallet(page);
        loopId = process.env.DEMO_LOOP;
        mark("loop page", `${loopId}, picked up (DEMO_LOOP)`);
      } else {
        // ── Shot 1 · the agent, already registered on Solana with its cap, then _Run as a loop_. The
        // Agents, its row and its panel, all client navigations from `/`, so the wallet stays
        // connected. `nestWorkspace` puts a row with a running loop first, then the newest; `prepare`
        // has just deployed this agent, so it heads the list unless another of this wallet's agents is newer.
        // The list is filmed from its top; a row that is not first is a timeline note, not a failure.
        await page.goto("/");
        await connectWallet(page);
        // The Lath mark, which leads to Agents.
        await page.getByTestId("nav-home").click();
        const spine = page.getByTestId("owners-spine");
        await expect(spine).toBeVisible({ timeout: 120_000 });
        const agentListRow = spine.locator(`[data-testid="owner-row"][data-agent-id="${AGENT_ID}"]`).first();
        await expect(agentListRow).toBeVisible({ timeout: 120_000 });
        await page.evaluate(() => window.scrollTo({ top: 0 }));
        const firstRow = await spine
          .locator('[data-testid="owner-row"][data-depth="0"]')
          .first()
          .getAttribute("data-agent-id");
        if (firstRow?.toLowerCase() !== AGENT_ID)
          mark("agents list: the demo agent is not the first row", firstRow ?? "");
        mark("the agent", "0:00 — Agents, the agent's row");
        await pointAt(agentListRow, PACE / 2);
        await agentListRow.locator("button").first().click();
        // The panel: its spending cap, read from the chain, is the allowance the deploy granted.
        const agentPanel = page.getByTestId("owner-spine");
        await expect(agentPanel).toBeVisible({ timeout: 60_000 });
        await pointAt(agentPanel.getByTestId("agent-allowance"), PACE * 1.5);
        mark("the agent's panel", "registered on Solana, its cap");
        // _Run as a loop_ is pointed at, then the take cuts to the preset's link: no preset is listed on
        // screen, so the audit's terms — its Goal and its two pinned Files, which the form cannot add by
        // hand — arrive only by `&preset=protocol-audit`. The cut opens the form exactly as _Run as a
        // loop_ would on this agent, filled from the preset.
        await pointAt(agentPanel.getByTestId("compose-loop"), PACE / 2);
        mark("run as a loop", "then the cut to the preset's link");
        await page.goto(`/create?loop=1&agent=${AGENT_ID}&preset=protocol-audit`);
        await connectWallet(page);
        await expect(page.getByTestId("start-from")).toHaveCount(0);
        await expect(page.getByTestId("loop-agent-select")).toHaveValue(AGENT_ID, { timeout: 120_000 });

        // ── Shot 2 · the form, on the `protocol-audit` preset. Every option is on screen: the goal check
        // right under the goal, the Files section with the preset's two sources read-only, and verify on
        // for every step with no toggle (the run is filmed verified, as every run started from the form
        // is). The preset fills every term the voice names, so the
        // take checks them rather than clicking them: a chip pressed here would be a term the preset
        // link does not open with.
        const form = page.getByTestId("loop-start-form");
        await expect(form).toBeVisible({ timeout: 120_000 });
        await expect(form).toHaveAttribute("data-preset", PRESET.id);
        mark("form: the preset");
        await openAdvanced(form);
        await expect(page.getByTestId("loop-goal-input")).toHaveValue(PRESET.loop.goal!);
        await expect(page.getByTestId("loop-goal-check-toggle")).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByTestId("loop-verify-always")).toContainText("minimum confidence of 0.5");
        await expect(page.getByTestId("loop-sandbox-toggle")).toHaveAttribute("aria-pressed", "true");
        const files = page.getByTestId("loop-sandbox-source-frozen");
        await expect(files).toHaveCount(2);
        await expect(files.nth(0)).toContainText("GitHub");
        await expect(files.nth(0)).toContainText("Squads-Protocol/v4");
        await expect(files.nth(0)).toContainText("src/instructions");
        await expect(files.nth(1)).toContainText("Solana · devnet");
        await expect(files.nth(1)).toContainText(SQUADS_PROGRAM);
        // The preset carries no tools key: chain reads on, the store as the agent was deployed.
        await expect(page.getByTestId("loop-sandbox-carried")).toHaveCount(0);
        // _Step Interval_ 10 s and 6 steps, the preset's own chips (a goal loop offers the 10 s chip ahead
        // of the minutes, `pollOptions`).
        await expect(form.getByRole("button", { name: "10 s", exact: true })).toHaveAttribute("aria-pressed", "true");
        const steps = form.getByRole("button", { name: String(STEPS), exact: true });
        await expect(steps).toHaveAttribute("aria-pressed", "true");
        const budgets = page.getByTestId("loop-budget-field").getByRole("button");
        const budget = process.env.DEMO_BUDGET
          ? page.getByTestId(`loop-budget-${process.env.DEMO_BUDGET}`)
          : budgets.first();
        await budget.click();
        mark(
          "form: filled",
          `${STEPS} steps, budget ${await page.getByTestId("loop-budget-field").getAttribute("data-usdc")} USDC`
        );

        // The goal (one paragraph in four parts, each claim cited), then the cost line that says who
        // pays (OpenRouter via Tempo, debited on Solana; Lath's share of the decision model is in its ⓘ,
        // not on the line), then the goal check under the goal: the decision model, not
        // the agent, says when the note is done.
        await pointAt(page.getByTestId("loop-goal-input"), PACE * 1.5);
        mark("form: the goal", "the question a signer asks before approving a Squads transaction");
        await pointAt(page.getByTestId("loop-cost-line"), PACE * 1.5);
        mark("form: the cost line", "OpenRouter via Tempo, debited on Solana");
        await pointAt(page.getByTestId("loop-goal-check"));
        mark("form: Decision model checks the goal");

        // The two Files, then Check sources: the repo resolves to a commit and the program to a slot,
        // each with its file count, before anything is signed.
        await pointAt(page.getByTestId("loop-sandbox-sources"));
        mark("check sources: pressed");
        await page.getByTestId("loop-sandbox-check-sources").click();
        await expect(page.getByTestId("loop-sandbox-check-ok")).toBeVisible({ timeout: 180_000 });
        const resolved = page.getByTestId("loop-sandbox-source-resolved");
        await expect(resolved).toHaveCount(2);
        await expect(resolved.nth(0)).toContainText(/Squads-Protocol\/v4 @ main → [0-9a-f]{7}/);
        await expect(resolved.nth(1)).toContainText(/Solana devnet · slot \d+/);
        mark("check sources: resolved", "the repo at a commit, the program at a slot");
        await pointAt(resolved.nth(0));
        await pointAt(resolved.nth(1));

        // The terms the voice names last: 6 steps, one budget of 1 USDC for the whole loop.
        await pointAt(steps, PACE / 2);
        await pointAt(budget, PACE / 2);
        mark("form: steps and budget");

        // R · the plugins beat: the section the preset opens switched on with SAS · receipt picked, then
        // any chips the form shows greyed _soon_ — there may be none, so the beat is counted rather than
        // waited for (a `waitFor` on no chip would give up after 60 s and fail the take before shot 3).
        // Without the receipt the section is not on the form at all (the switch is off), so there is
        // nothing to point at — and, since the preset picks the receipt only where the console offers it,
        // no line about one either: there is nothing for the pointer to keep off.
        if (!RECEIPT) await expect(page.getByTestId("loop-plugins")).toHaveCount(0);
        if (RECEIPT) {
          await expect(page.getByTestId("plugins-no-receipt-schema")).toHaveCount(0);
          await pointAt(page.getByTestId("loop-plugins"), PACE / 2);
          const pick = page.getByTestId("plugins-pick-sas.receipt");
          await expect(pick, "the preset did not pick SAS · receipt").toHaveAttribute("aria-pressed", "true");
          await pointAt(pick, PACE);
          mark("form: SAS · receipt", "picked by the preset");
          const soon = page.getByTestId("plugins-grant").locator('button[disabled][data-testid^="plugins-pick-"]');
          const n = await soon.count();
          if (n > 0) {
            await pointAt(soon.first(), PACE / 2);
            await pointAt(soon.last(), PACE / 2);
          }
          mark("form: the soon chips", `${n} greyed`);
        }

        // A free rehearsal of shots 1–2: everything above is unsigned, and nothing is pinned on Irys or
        // paid until the start.
        if (process.env.DEMO_UNTIL === "sources") {
          mark("stopped before the start", "DEMO_UNTIL=sources");
          return;
        }

        // ── Shot 3 · the one signature, then the start button's stages, onto the loop page.
        await pointAt(page.getByTestId("loop-start"), PACE / 2);
        mark("start: signed", "one Lath loop message");
        await page.getByTestId("loop-start").click();
        await expect
          .poll(async () => /\/loop\/loop-/.test(page.url()) || (await page.getByTestId("loop-live").count()) > 0, {
            timeout: 240_000,
          })
          .toBe(true);
        if (!/\/loop\/loop-/.test(page.url())) await page.getByTestId("loop-live-open").click();
        await expect(page).toHaveURL(/\/loop\/loop-/, { timeout: 60_000 });
        loopId = page.url().split("/loop/")[1].split(/[?#]/)[0];
        mark("loop page", loopId);
      }

      /**
       * Opens a card the page folds by default (_Paid on Tempo_, the receipt, _On Solana_) before its
       * shot. A no-op when it is open already or not on the page; a reload folds them all again.
       */
      const unfold = async (testId: string) => {
        const toggle = page.getByTestId(`${testId}-toggle`).first();
        if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      };
      /** Back on the loop page after a hop to an explorer or a reload, off the clock. */
      const backOnLoopPage = async (why: string) => {
        if (!new URL(page.url()).pathname.startsWith(`/loop/${loopId}`)) await page.goto(`/loop/${loopId}`);
        await connectWallet(page);
        await expect(page.getByTestId("money-flow")).toBeVisible({ timeout: 120_000 });
        mark(why, "off the clock");
      };
      await expect(page.getByTestId("money-flow")).toBeVisible({ timeout: 120_000 });

      // ── Shot 4 · started. The screenshot first, once the page shows what it names — the terms, the
      // cap row with the loop's key, the receipt card waiting, step 1 pending — each waited for and
      // noted when it does not come rather than failed: the run has started and is spending. Not on a
      // run picked up with `DEMO_LOOP`, which is past its start (nor `02-running` below, for the same
      // reason): a frame labelled _started_ must be one.
      const keyRow = page.getByTestId("loop-tempo-key");
      const receiptStatus = page.getByTestId("loop-receipt-status");
      if (!process.env.DEMO_LOOP) {
        const missing = [
          (await shows(keyRow, 30_000)) ? null : "no cap row",
          !RECEIPT || (await shows(receiptStatus, 60_000)) ? null : "no receipt card",
          (await shows(page.getByTestId("loop-step-pending"), 120_000)) ? null : "no pending step",
        ].filter(Boolean);
        await screenshot(
          "01-started",
          `the loop page after the start${missing.length ? `; ${missing.join(", ")}` : ""}`
        );
      }
      // The Tempo-enforced cap row: the loop's own key and its limit. It renders on a loop started with
      // its own key (`LATH_TEMPO_LOOP_KEYS`); the film claims the key, so its absence is marked
      // loudly rather than passed over.
      if (await keyRow.count()) {
        await pointAt(keyRow, PACE * 2);
        mark("the loop's key", "the Tempo-enforced cap: the budget plus the decision share");
      } else {
        mark("the loop's key", "NO cap row: was the console started with LATH_TEMPO_LOOP_KEYS=on?");
      }
      if (RECEIPT && (await receiptStatus.count())) {
        await pointAt(receiptStatus, PACE);
        mark("receipt: waiting", `data-status ${await receiptStatus.getAttribute("data-status")}`);
      }

      // ── Shot 5 · running: the money flow while the channel fills — OpenRouter via Tempo, call by
      // call. Without the receipt the bar is held for two more polls (shot 5 takes the receipt card's
      // seconds from shot 4).
      if (await page.getByTestId("loop-step-pending").count()) {
        await pointAt(page.getByTestId("loop-step-pending"));
        mark("step running");
      }
      const flow = page.getByTestId("money-flow");
      await pointAt(flow, PACE * 2);
      mark("money flow", "your cap on Solana → Lath's treasury on Tempo → OpenRouter via Tempo");
      // The channel opens on step 1's first paid call. Its bar moves on each poll while the step pays;
      // the hold reads its figure each time, so the timeline says which call each frame shows.
      const channel = page.getByTestId("open-channel");
      if (await shows(channel, 240_000)) {
        await pointAt(channel, PACE);
        let last = "";
        const polls = RECEIPT ? 6 : 8;
        for (let i = 0; i < polls && (await channel.count()); i++) {
          const used = (
            (await channel
              .getByTestId("open-channel-used")
              .innerText()
              .catch(() => "")) || ""
          ).trim();
          if (used && used !== last) mark("channel filling", used);
          last = used;
          await page.waitForTimeout(PACE * 2);
        }
      } else {
        mark("channel filling", "no open channel drawn within 4 min");
      }

      // Each step's row as it lands, found by its `#n` cell rather than its position, so the table's
      // order does not matter. The note takes a part or two a step, and the decision model says continue
      // until it judges all four parts there; the run ends on its achieved, at the budget, or at 6
      // steps. Every row is filmed — its Answer, its goal chip, its Tempo figure — the first
      // `ROWS_IN_FULL` at the full pace and the rest briefly, since by then the voice has said what a row
      // is. Nothing is asserted of any one step's answer: whether step 1 already says achieved is the
      // decision model's call, not something the take can arrange.
      //
      // `02-running` is the first row that lands with goal: continue — the note begun, the channel's
      // bar moved, the next step about to run. If step 1 already says achieved there is no such row, so
      // the frame is step 1's, and the timeline says so; a row the decision model could not be asked about
      // (`unavailable`, the chip's _goal: unchecked_) is filmed and passed over for the frame.
      const stepRow = (n: number) => page.getByTestId("loop-steps").locator(`.step-row[data-step="${n}"]`);
      let seen = 0;
      let running = !!process.env.DEMO_LOOP;
      const deadline = Date.now() + ROWS_DEADLINE_MS;
      while (Date.now() < deadline) {
        // The rows themselves, not the goal chips: a step that failed lands a row with no chip
        // (`failStep` returns before the goal check), and counting chips would point `#n` at the wrong
        // row and time out on it while the run went on spending.
        const landed = await page.getByTestId("loop-steps").locator(".step-row").count();
        for (let n = seen + 1; n <= landed; n++) {
          const row = stepRow(n);
          const chip = row.getByTestId("step-goal-check");
          const hold = n <= ROWS_IN_FULL ? PACE : PACE / 2;
          if (!(await shows(chip, 30_000))) {
            mark(`step ${n} row`, "no goal check: the step failed, or its row landed without one");
            await pointAt(row, hold / 2);
            seen = n;
            continue;
          }
          await expect(chip).toContainText(/goal: (continue|achieved|unchecked)/, { timeout: 120_000 });
          // The outcome as the row keeps it (`data-goal`), not the chip's words: _achieved_ under the bar
          // reads `goal: achieved 0.4 · below the bar` and is a continue.
          const outcome = await chip.getAttribute("data-goal");
          mark(`step ${n} row`, (await chip.innerText()).trim());
          // The answer, when the step left one to show: a card with none keeps the line in the DOM but
          // `hidden`. The line comes out of the same verified pass as the chip just read, so by now it
          // is drawn or it is not; a long wait for a hidden one would hold the camera on every card
          // without an answer. Asked at once, then a short grace for a card re-verified on the next poll.
          const answer = row.getByTestId("step-answer");
          if ((await answer.isVisible()) || (await shows(answer, ANSWER_GRACE_MS))) await pointAt(answer, hold);
          else mark(`step ${n} row`, "no answer line on the card");
          await pointAt(chip, hold);
          if (!running && (outcome === "continue" || (n === 1 && outcome === "achieved"))) {
            running = true;
            await screenshot(
              "02-running",
              outcome === "continue"
                ? `step ${n} landed, goal: continue`
                : "step 1 landed, goal: achieved — no row said continue, so the frame is step 1's"
            );
          }
          // The step's cost on its card: what the owner was charged in USDC. What it paid OpenRouter via
          // Tempo is in the step's proof, and the money flow above shows the run's Tempo payment.
          const paid = row.getByTestId("step-cost");
          if (await paid.count()) await pointAt(paid, hold / 2);
          seen = n;
        }
        // Done once the run has stopped and every step it wrote has its row: the stop can land
        // before the last row does, because the browser reads rows from the indexer, which lags.
        // A dropped poll is the console busy anchoring, not the run failing: try again next round.
        const one = await request
          .get(`/api/loops?id=${encodeURIComponent(loopId)}`)
          .then((r) => r.json())
          .catch(() => null);
        if (one?.loop?.status && one.loop.status !== "running" && seen >= (one.loop.history?.length ?? 0)) break;
        await page.waitForTimeout(5_000);
      }
      if (!running) mark("screenshot: 02-running not taken", "no row said continue, and step 1 did not say achieved");
      let final: any = null;
      for (let i = 0; i < 6 && !final; i++) {
        final = await request
          .get(`/api/loops?id=${encodeURIComponent(loopId)}`)
          .then(async (r) => (await r.json()).loop)
          .catch(() => null);
        if (!final) await page.waitForTimeout(5_000);
      }
      // `max-steps` is the goal's bar not met in 6 steps: no receipt
      // is due, and the film needs the achieved. Said so, rather than only the reason's name.
      expect(
        final.stopReason,
        final.stopReason === "max-steps"
          ? `the decision model never said achieved in ${STEPS} steps: no receipt is due`
          : `the run stopped on ${final.stopReason}: ${final.stopDetail ?? ""}`
      ).toBe("goal-reached");

      // ── Shot 6 · finished: the decision model judged the note done, and the loop stops itself
      // under budget.
      await expect(page.getByTestId("loop-goal-reached")).toBeVisible({ timeout: 120_000 });
      await pointAt(page.getByTestId("loop-goal-reached"), PACE * 1.5);
      mark("finish note", "the decision model judged it achieved");
      // The loop's own Tempo key, as the one-loop read reports it: the receipt's payer must be it, and
      // `verify-channel --key` prints it. `null` on a console without loop keys.
      const keyAddress: string | null = final.tempoKey?.address ?? null;

      // The answer, which is the deliverable here: its first line under the finish note, and _Read the
      // answer_, whose page holds the whole note the last step stored on Tempo, re-hashed in this browser
      // against the record, with the evidence under it. The link opens a new tab, which a recorded page
      // would not film, so the take follows it in this tab and comes back, off the clock.
      //
      // Filmed only when there is one. The goal asks each step to write the note to report/note.md, and a
      // step publishes only a file it wrote there (`runtime/src/zeroclaw/report.ts`): a run whose steps
      // wrote none has nothing to open. The beat is then cut, and the note is still on screen in the last
      // row's Answer.
      const answerLink = page.getByTestId("loop-goal-answer");
      if (await shows(answerLink, 60_000)) {
        const summary = page.getByTestId("loop-answer-summary-text");
        if (await shows(summary, 60_000)) {
          await pointAt(summary, PACE * 2);
          mark("answer", (await summary.innerText()).trim());
        }
        await pointAt(answerLink, PACE / 2);
        mark("answer", "Read the answer");
        await page.goto((await answerLink.getAttribute("href"))!);
        await connectWallet(page);
        await expect(page.getByTestId("loop-report-verified")).toBeVisible({ timeout: 120_000 });
        await pointAt(page.getByTestId("loop-report-verified"), PACE);
        mark("answer page", "re-hashed in this browser");
        const text = page.getByTestId("loop-report-text");
        await pointAt(text, PACE);
        await text.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
        await page.waitForTimeout(PACE * 2);
        mark("answer page: the note", "scrolled to its end");
        const evidence = page.getByTestId("loop-answer-evidence");
        await evidence.scrollIntoViewIfNeeded();
        await pointAt(evidence, PACE * 1.5);
        mark("answer page: the evidence", "the pinned files, the rails, the receipt, every call");
        await page.goto(`/loop/${loopId}`);
        await backOnLoopPage("back on the loop page");
      } else {
        mark("answer: not filmed", "no step published a report; cut the answer beat and its voice-over");
      }

      // The channel settled once on Tempo mainnet. The flow's settlement and what OpenRouter received,
      // checked against Tempo in this browser; the _Paid on Tempo_ card (`tempo-payments`: model,
      // decision model, storage, RPC, each transaction linked).
      const settlement = flow.getByTestId("money-flow-settlement").getByRole("link");
      await expect(settlement).toBeVisible({ timeout: 180_000 });
      await pointAt(flow, PACE);
      const received = flow.getByTestId("money-flow-checked");
      if (await shows(received, 60_000)) await pointAt(received, PACE);
      await pointAt(settlement, PACE * 1.5);
      mark("settled on Tempo", "the money flow's settlement");
      // Lath's two rails for the run, side by side: the records it wrote on Solana and what OpenRouter
      // was paid on Tempo.
      const lathRails = page.getByTestId("loop-rails");
      await lathRails.scrollIntoViewIfNeeded();
      await pointAt(lathRails.getByTestId("loop-rails-solana"), PACE * 2);
      mark("on Solana", (await lathRails.getByTestId("loop-rails-solana-figure").innerText()).trim());
      await pointAt(lathRails.getByTestId("loop-rails-tempo"), PACE * 2);
      mark("on Tempo", (await lathRails.getByTestId("loop-rails-tempo-figure").innerText()).trim());
      await unfold("tempo-payments-card");
      await pointAt(page.getByTestId("tempo-payments"), PACE * 2);
      mark("paid on Tempo", "per service and payer");
      const keyLink = page.getByTestId("loop-tempo-key-address").getByRole("link");
      const keyed = (await keyLink.count()) > 0;
      // Without the receipt the key's line comes back here, revoked, in the receipt card's seconds; with
      // it, the key was shown in shot 4 and comes back as the receipt's payer, so it is not repeated.
      if (keyed && !RECEIPT) {
        await pointAt(page.getByTestId("loop-tempo-key"), PACE * 1.5);
        mark("the loop's key", "revoked at the stop");
      }
      const settleHref = (await settlement.getAttribute("href"))!;
      const keyHref = keyed ? await keyLink.getAttribute("href") : null;
      expect(settleHref, "the settlement opens on Tempo's explorer").toMatch(
        /^https:\/\/explore\.tempo\.xyz\/tx\/0x[0-9a-fA-F]{64}$/
      );
      // Without the receipt, the finished page is this one: the settlement is the run's last word.
      if (!RECEIPT) await screenshot("03-finished", "goal reached, settled on Tempo");
      // The hop, only with `DEMO_EXPLORER_HOPS=on`: in this tab, since a link opens explore.tempo.xyz in
      // a new tab a recorded page would not film. The return waits for the page again off the clock.
      // Off by default: the evidence page opens these links.
      if (HOPS) {
        await page.goto(settleHref);
        await page.waitForTimeout(PACE * 3);
        mark("explore.tempo.xyz: the close", settleHref);
        if (keyHref && !RECEIPT) {
          await page.goto(keyHref);
          await page.waitForTimeout(PACE * 2);
          mark("explore.tempo.xyz: the loop's key", keyHref);
        }
        await backOnLoopPage("back on the loop page");
      }

      // R · the receipt. The console publishes it after the stop's settle, the key's revoke and the
      // sweep, so it can land a minute after the stop; the cut covers the wait
      // with a skip card, and the timeline marks where it starts and ends. A `failed` receipt or a loop
      // that earned `none` is not filmed around: the take fails here, saying why.
      let receipt: any = null;
      let receiptTxHref: string | null = null;
      if (RECEIPT) {
        expect(
          final.receipt,
          "the loop's policy commits no receipt: SAS · receipt was not picked on the form, or the run was " +
            "started from a console with plugins off (DEMO_LOOP)"
        ).toBeTruthy();
        mark("receipt: waiting", "skip card from here to the publish");
        const until = Date.now() + 4 * 60_000;
        for (;;) {
          const r = await request
            .get(`/api/loops?id=${encodeURIComponent(loopId)}`)
            .then(async (res) => (await res.json())?.loop?.receipt)
            .catch(() => undefined);
          if (r && r.status !== "waiting") {
            receipt = r;
            break;
          }
          if (Date.now() >= until) break;
          await page.waitForTimeout(5_000);
        }
        expect(
          receipt,
          "no receipt within 4 min of the settlement: the console publishes after the settle, the revoke and " +
            "the sweep; read its log for `receipt`"
        ).not.toBeNull();
        expect(
          receipt.status,
          receipt.status === "failed"
            ? `the receipt's publish failed: ${receipt.error ?? "no reason given"} (a console restart retries it)`
            : "the loop stopped without Jev's achieved on its last step, so no receipt is due"
        ).toBe("published");
        mark("receipt: published", receipt.address);
        // A reload, as a person does: the card reads the row on the next poll anyway, and the page is
        // waited for again off the clock.
        await page.reload();
        await backOnLoopPage("receipt: reloaded");
        const status = page.getByTestId("loop-receipt-status");
        await expect(status).toHaveAttribute("data-status", "published", { timeout: 60_000 });
        // The finished page, once a reload has let its steps table fill again from the indexer: every
        // step's chip on screen, or two minutes, whichever comes first.
        await expect
          .poll(() => page.getByTestId("step-goal-check").count(), { timeout: 120_000 })
          .toBeGreaterThanOrEqual(final.history?.length ?? 0)
          .catch(() => mark("finished: steps table", "not every row back after the reload"));
        await unfold("loop-receipt-fold");
        await screenshot("03-finished", "goal reached, settled, the receipt published");
        await pointAt(status, PACE);
        await pointAt(page.getByTestId("loop-receipt-links"), PACE);
        mark("receipt: the attestation and its transaction", receipt.signature);
        await pointAt(page.getByTestId("loop-receipt-values"), PACE * 1.5);
        mark("receipt: what it points at", `seq ${receipt.values?.seq} · ${receipt.values?.steps} steps`);
        // The payer, the position and the goal's hash sit behind the receipt card's ⓘ: open it for this
        // beat and close it before the next.
        await openInfo(page.getByTestId("loop-receipt-more-open"));
        await pointAt(page.getByTestId("loop-receipt-payer"), PACE);
        mark("receipt: the Tempo payer", receipt.values?.tempoPayer);
        await closeInfo(page);
        // The voice says the payer is shot 4's key; this holds the receipt to it.
        if (keyAddress && receipt.values?.tempoPayer) {
          expect(String(receipt.values.tempoPayer).toLowerCase(), "the receipt's payer is not the loop's key").toBe(
            keyAddress.toLowerCase()
          );
        }
        const txLink = page.getByTestId("loop-receipt-tx");
        receiptTxHref = await txLink.getAttribute("href");
        expect(receiptTxHref, "the receipt's transaction opens on Solana's explorer").toMatch(
          /^https:\/\/explorer\.solana\.com\/tx\/[1-9A-HJ-NP-Za-km-z]{64,88}\?cluster=devnet$/
        );
        // The same hop as the settlement's, behind the same knob.
        if (HOPS) {
          await pointAt(txLink, PACE / 2);
          await page.goto(receiptTxHref!);
          await page.waitForTimeout(PACE * 4);
          mark("explorer.solana.com: the receipt's transaction", receiptTxHref!);
          await backOnLoopPage("back on the loop page");
        }
      }

      // Every paid call as its Solana record beside its Tempo payment, open under the steps: Lath's two
      // rails are what a judge should see. The rest of the checking is the evidence page's.
      const rails = page.getByTestId("dual-rail");
      if (await shows(rails, 120_000)) {
        await rails.scrollIntoViewIfNeeded();
        await pointAt(rails, PACE * 2);
      }
      mark("every call", "Solana record · Tempo payment");

      // The audit: not filmed, run here as the take's self-check — a take that would
      // not verify fails now, not in the edit — and kept, with the exact commands, for the evidence
      // page's one `lath-audit` line. The RPC is shown as `"$RPC"` and run as the real url: the url
      // carries the Helius key, and the files are kept.
      const last = final.history.at(-1);
      const seq = last?.seq;
      const rpc = process.env.LATH_DEVNET_RPC ?? "";
      // No trace key: the console writes its traces in the clear, so every audit opens them as they are.
      const storeFlags = (shown: boolean) => ["--rpc", shown ? '"$RPC"' : rpc, "--store", "frontend/.traces-devnet"];
      // The plain audit: every blob from Irys through the locator on
      // chain, and no local store, so the verdict leans on nothing this console holds.
      const irysFlags = (shown: boolean) => [
        "--rpc",
        shown ? '"$RPC"' : rpc,
        "--gateway",
        IRYS_GATEWAY,
        "--scheme",
        "4",
        "--encoding",
        "base64url",
        "--require-preimages",
      ];
      const verified = (out: string, what: string) => {
        expect(out, `${what} did not end VERIFIED`).toMatch(/VERIFIED/);
        expect(out, `${what} said NOT VERIFIED`).not.toMatch(/NOT VERIFIED/);
      };
      const audits: {
        file: string;
        args: string[];
        flags: (shown: boolean) => string[];
        check: (run: SpawnSyncReturns<string>) => void;
      }[] = [
        {
          // `--key` is a flag, not an address (`sdk/src/cli.ts`): the key line prints whenever the loop's
          // policy commits a key, with the key's address, and the flag makes a chain without one say so.
          // The address is held to the one the loop row names, so the line is shot 4's key.
          file: "verify-channel.txt",
          args: ["verify-channel", "--name", AGENT, "--key"],
          flags: storeFlags,
          check: (run) => {
            verified(run.stdout, "verify-channel");
            if (keyAddress) {
              expect(run.stdout.toLowerCase(), "verify-channel's key line does not name the loop's key").toContain(
                keyAddress.toLowerCase()
              );
            }
          },
        },
        {
          file: "verify-step.txt",
          args: ["verify-step", "--name", AGENT, String(seq)],
          flags: storeFlags,
          check: (run) => verified(run.stdout, "verify-step"),
        },
        RECEIPT
          ? {
              // Exit 0 is `receiptsStatus` ok: every loop that commits a receipt checked, none failed and
              // none unread, and a loop's status is the worst of its checks. The checks print on one line
              // as `name ✓`, `name ✗` or `name ?` (`formatReceipt`), so no ✗ and no ? is "every check
              // ok" as the output itself says it.
              file: "verify-receipt.txt",
              args: ["verify-receipt", "--name", AGENT],
              flags: storeFlags,
              check: (run) => {
                expect(run.status, `verify-receipt exited ${run.status}`).toBe(0);
                verified(run.stdout, "verify-receipt");
                expect(run.stdout).not.toMatch(/FAILED|not checked/);
                expect(run.stdout).toContain(`loop       ${loopId}`);
                if (receipt?.address) expect(run.stdout).toContain(`receipt    ${receipt.address}`);
                expect(run.stdout, "no receipt check printed ✓").toMatch(/✓/);
                expect(run.stdout, "a receipt check is not ok").not.toMatch(/✗|\S \?( ·|$)/m);
              },
            }
          : {
              file: "audit-irys.txt",
              args: ["--name", AGENT],
              flags: irysFlags,
              check: (run) => {
                expect(run.status, `the plain audit exited ${run.status}`).toBe(0);
                verified(run.stdout, "the plain audit from Irys");
              },
            },
      ];
      const shownCommand = (a: (typeof audits)[number]) =>
        `npm run -s audit -- ${[...a.args, ...a.flags(true)].join(" ")}`;
      for (const a of audits) {
        let out = `${shownCommand(a)}\n\n(not run: the loop has no checkpoint to audit)\n`;
        if (seq) {
          const run = spawnSync("npm", ["run", "-s", "audit", "--", ...a.args, ...a.flags(false)], {
            cwd: REPO,
            encoding: "utf8",
            timeout: 10 * 60_000,
          });
          out = `${shownCommand(a)}\n\n${run.stdout}${run.stderr}`;
          writeFileSync(testInfo.outputPath(a.file), out);
          a.check(run);
        }
        writeFileSync(testInfo.outputPath(a.file), out);
        mark(`audit: ${a.args[0]}`, `${seq ? "VERIFIED" : "not run"} (not filmed)`);
      }

      // The end card and the evidence page, as this run produced them. The Solana link is the last
      // step's `loop.step` transaction: the loop row keeps each checkpoint's signature
      // (`LoopStepSummary`), and the open read carries it, so no write is needed.
      const origin = new URL(page.url()).origin;
      const recordSig: string | undefined = last?.signature;
      const sources = await sourcesOnIrys(request, loopId);
      writeFileSync(testInfo.outputPath("sources-irys.json"), JSON.stringify(sources, null, 2) + "\n");
      const fileCount = Array.isArray(sources.sources)
        ? (sources.sources as { files: unknown[] }[]).reduce((n, s) => n + s.files.length, 0)
        : 0;
      // The treasury's figures for the end card's one line of text, read by address
      // so no key is loaded: `tempo:stats` signs and spends nothing either way.
      const treasuryAddress: string | undefined = (await (await request.get("/api/tempo/treasury")).json())?.address;
      const statsArgs = ["run", "-s", "tempo:stats", "--", ...(treasuryAddress ? ["--address", treasuryAddress] : [])];
      const stats = spawnSync("npm", statsArgs, { cwd: REPO, encoding: "utf8", timeout: 5 * 60_000 });
      writeFileSync(
        testInfo.outputPath("tempo-stats.txt"),
        `npm ${statsArgs.join(" ")}\n\n${stats.stdout ?? ""}${stats.stderr ?? ""}`
      );
      mark("tempo:stats", stats.status === 0 ? "written" : `exit ${stats.status}`);
      writeFileSync(
        testInfo.outputPath("demo-links.json"),
        JSON.stringify(
          {
            variant: RECEIPT ? "receipt" : "no-receipt",
            agent: AGENT,
            agentId: AGENT_ID,
            loopId,
            // The page the film's last beat points at, built by its own command from this loop.
            evidence: `npm run -s evidence -- --loop ${loopId}`,
            solanaRecord: recordSig
              ? `https://explorer.solana.com/tx/${recordSig}?cluster=devnet`
              : `${origin}/agent/${AGENT_ID}?seq=${seq} (no signature on the loop row: its row in Events links the transaction)`,
            solanaRecordSeq: seq ?? null,
            tempoSettlement: settleHref,
            tempoLoopKey: keyHref,
            tempoLoopKeyAddress: keyAddress,
            tempoTreasury: treasuryAddress ? `https://explore.tempo.xyz/address/${treasuryAddress}` : null,
            ...(RECEIPT
              ? {
                  receiptAttestation: `https://explorer.solana.com/address/${receipt.address}?cluster=devnet`,
                  receiptTransaction: receiptTxHref,
                }
              : { endCardText: NEXT_LINE }),
            loopPage: `${origin}/loop/${loopId}`,
            audit: audits.map(shownCommand),
            screenshots: screens,
            sourcesOnIrys: {
              index: (sources.index as { url?: string } | undefined)?.url ?? null,
              manifest: (sources.manifest as { url?: string } | undefined)?.url ?? null,
              files: fileCount,
              detail: "sources-irys.json",
              ...(sources.error || sources.note ? { problem: sources.error ?? sources.note } : {}),
            },
            tempoStats: "tempo-stats.txt",
          },
          null,
          2
        ) + "\n"
      );
    } finally {
      // The video is written when its context closes; keep it under one name beside the timeline.
      const video = page.video();
      await context.close();
      if (video) await video.saveAs(testInfo.outputPath("take.webm"));
      writeFileSync(testInfo.outputPath("demo-timeline.json"), JSON.stringify(timeline, null, 2) + "\n");
      await testInfo.attach("demo-timeline", { path: testInfo.outputPath("demo-timeline.json") });
    }
  });
});
