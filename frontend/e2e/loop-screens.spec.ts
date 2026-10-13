import { expect, test, type Locator, type Page } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

/**
 * Three screenshots of a loop someone else started, taken read-only: the same three frames
 * `demo-record.spec.ts` takes of its own run — `01-started`, `02-running`, `03-finished` — so a loop
 * started by hand in Phantom leaves the same pictures as the recorded demo.
 *
 * **It never signs and never writes.** The page is opened with a watch-only wallet: an injected
 * provider that reports the public key in `LOOP_SCREENS_OWNER` and rejects every sign call, so the
 * wallet gate lets the loop page render as that owner's and nothing it does can reach a wallet. The
 * console answers every read in full, so the frames show what any reader sees. As a second fence, any
 * request that is not a read to the console's write routes is aborted and noted. The spec's own
 * requests are `GET /api/loops?id=` polls. It does not use the E2E wallet and does not need `--e2e`:
 * any console on `PLAYWRIGHT_BASE_URL` serves it.
 *
 * Skipped unless `LOOP_SCREENS=<loopId>` is set. Run it right after the loop's start, from
 * `frontend/`:
 *
 * ```bash
 * LOOP_SCREENS=<loopId> LOOP_SCREENS_OWNER=<owner pubkey> PLAYWRIGHT_BASE_URL=http://localhost:3000 \
 *   npx playwright test loop-screens --workers=1
 * ```
 *
 * The moments, each waited for on the console's own row and then on the page, and each soft: a part
 * of the page that does not come in time is written into the frame's note rather than failing, because
 * the run goes on either way and a late frame is still the run's own.
 *
 * - **`01-started`**: as soon as the loop page renders — the terms, the Tempo-enforced cap row with the
 *   loop's key, the receipt card _waiting_ (on a loop that commits one), step 1 pending;
 * - **`02-running`**: on step 1's landing — its row with the decision model's goal chip, the channel's
 *   bar moved — while the loop runs on;
 * - **`03-finished`**: once the loop has stopped and, on a loop that commits a receipt, the receipt is
 *   no longer _waiting_ (published, about a minute after the stop); otherwise once the settlement shows.
 *   A reload first, so the card and the steps table are read fresh.
 *
 * Each is a full-page PNG (`<name>.png`) and a viewport PNG (`<name>-viewport.png`), into
 * `LOOP_SCREENS_DIR` (default the test's output directory), with `loop-screens.json` beside them: when
 * each was taken, what the console's row said then, and what the page did not show. Steps take two to
 * three minutes each, so the timeouts are generous: a loop on the `protocol-audit` preset runs up to
 * 12 steps 10 s apart, so the stop is waited for up to an hour after step 1 (eleven more steps at
 * three minutes, and room for a slow one).
 *
 * Knobs: `LOOP_SCREENS_VIEWPORT` (default `1920x1080`, the recording's size), `LOOP_SCREENS_DIR`.
 */

const LOOP = process.env.LOOP_SCREENS ?? "";
const OWNER = process.env.LOOP_SCREENS_OWNER ?? "";
const [WIDTH, HEIGHT] = (process.env.LOOP_SCREENS_VIEWPORT ?? "1920x1080").split("x").map(Number);

/** The console's routes that write, fenced off for anything but a read (see the header). */
const WRITE_ROUTES = /\/api\/(loops|agents|run|market|templates)(\/|\?|$)/;

/**
 * A watch-only stand-in for Phantom, run in the page before the app: it reports `owner` on connect so
 * the owner's view renders, and refuses every signature, so nothing on the page can sign. The legacy
 * `window.phantom.solana` shape is what `PhantomWalletAdapter` detects, and `walletName` is the
 * adapter's remembered choice, so `autoConnect` picks it without a click. Base58 is decoded by hand
 * because nothing is imported into an init script.
 */
function watchOnlyWallet(owner: string) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const decode = (s: string) => {
    let n = BigInt(0);
    for (const c of s) n = n * BigInt(58) + BigInt(A.indexOf(c));
    const out: number[] = [];
    while (n > BigInt(0)) {
      out.unshift(Number(n & BigInt(255)));
      n >>= BigInt(8);
    }
    for (const c of s) {
      if (c !== "1") break;
      out.unshift(0);
    }
    return new Uint8Array(out);
  };
  const bytes = decode(owner);
  const key = { toBytes: () => bytes, toString: () => owner, toBase58: () => owner };
  const refuse = () => Promise.reject(new Error("watch-only wallet: signing refused"));
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const provider = {
    isPhantom: true,
    publicKey: null as typeof key | null,
    isConnected: false,
    connect: async () => {
      provider.publicKey = key;
      provider.isConnected = true;
      (listeners.connect ?? []).forEach((f) => f(key));
      return { publicKey: key };
    },
    disconnect: async () => {
      provider.publicKey = null;
      provider.isConnected = false;
      (listeners.disconnect ?? []).forEach((f) => f());
    },
    on: (event: string, f: (...args: unknown[]) => void) => {
      (listeners[event] = listeners[event] ?? []).push(f);
    },
    off: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},
    signTransaction: refuse,
    signAllTransactions: refuse,
    signMessage: refuse,
    signAndSendTransaction: refuse,
    signIn: refuse,
    request: refuse,
  };
  const w = window as unknown as Record<string, unknown>;
  w.phantom = { solana: provider };
  w.solana = provider;
  w.isPhantomInstalled = true;
  try {
    localStorage.setItem("walletName", JSON.stringify("Phantom"));
  } catch {
    // A page with no storage still renders; the header's wallet button is then picked below.
  }
}

test("loop screens: started, running, finished — read-only", async ({ browser, request }, testInfo) => {
  test.skip(!LOOP, "takes three screenshots of a running loop, read-only: set LOOP_SCREENS=<loopId>");
  // Step 1 (≤ 20 min), the stop (≤ 60 min), the receipt (≤ 8 min) and the reloads, whole.
  test.setTimeout(95 * 60_000);
  expect(OWNER, "set LOOP_SCREENS_OWNER to the loop owner's public key (the watch-only wallet reports it)").not.toBe(
    ""
  );
  new PublicKey(OWNER); // throws on a key that is not base58, before a browser opens

  const out = process.env.LOOP_SCREENS_DIR ? path.resolve(process.env.LOOP_SCREENS_DIR) : testInfo.outputPath();
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const log: Record<string, unknown>[] = [];
  const fenced: string[] = [];

  /** The console's row for this loop, or `null` on a dropped poll (the console busy anchoring). */
  const row = async (): Promise<any> =>
    request
      .get(`/api/loops?id=${encodeURIComponent(LOOP)}`)
      .then(async (r) => (r.ok() ? (await r.json())?.loop ?? null : null))
      .catch(() => null);
  /** Polls the row every 5 s until `done` holds or `ms` pass; the last row read either way. */
  const until = async (done: (loop: any) => boolean, ms: number): Promise<any> => {
    const end = Date.now() + ms;
    let last: any = null;
    for (;;) {
      const loop = await row();
      if (loop) last = loop;
      if (loop && done(loop)) return loop;
      if (Date.now() >= end) return last;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  };

  const first = await row();
  expect(first, `GET /api/loops?id=${LOOP} found no loop on this console`).toBeTruthy();
  if (first.owner && first.owner !== OWNER) {
    // Not refused: the frames would be a stranger's view, which is still read-only; said so instead.
    console.log(
      `[screens] the loop's owner is ${first.owner}, not LOOP_SCREENS_OWNER: the frames show a stranger's view`
    );
  }
  const hasReceipt = !!first.receipt;

  const context = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? testInfo.project.use.baseURL,
    viewport: { width: WIDTH, height: HEIGHT },
  });
  await context.addInitScript(watchOnlyWallet, OWNER);
  await context.route(WRITE_ROUTES, (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD") return route.continue();
    fenced.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  const page = await context.newPage();

  /** Whether `target` shows within `timeout`, without failing. */
  const shows = (target: Locator, timeout: number) =>
    target.waitFor({ timeout }).then(
      () => true,
      () => false
    );

  /** Opens (or reloads) the loop page and waits for the wallet and the page's money flow. */
  const openLoopPage = async (p: Page, reload = false) => {
    if (reload) await p.reload();
    else await p.goto(`/loop/${LOOP}`);
    // `autoConnect` picks the remembered wallet; a header still offering _Select Wallet_ after a while
    // is picked by hand, the stand-in listed as Phantom.
    const select = p.getByRole("button", { name: /select wallet/i });
    if (await shows(select, 5_000)) {
      await p.waitForTimeout(10_000);
      if (await select.count()) {
        await select.first().click();
        await p
          .getByRole("button", { name: /phantom/i })
          .first()
          .click();
      }
    }
    await expect(select).toHaveCount(0, { timeout: 60_000 });
    await expect(p.getByTestId("money-flow")).toBeVisible({ timeout: 180_000 });
  };

  /** The viewport, then the full page, and a line in `loop-screens.json`. */
  const screenshot = async (name: "01-started" | "02-running" | "03-finished", loop: any, missing: string[]) => {
    await page.screenshot({ path: path.join(out, `${name}-viewport.png`) });
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    const entry = {
      name,
      at: new Date().toISOString(),
      afterMs: Date.now() - t0,
      status: loop?.status ?? null,
      steps: loop?.history?.length ?? null,
      goal: loop?.history?.at(-1)?.goalCheck?.outcome ?? null,
      receipt: loop?.receipt?.status ?? null,
      missing,
      files: [`${name}.png`, `${name}-viewport.png`],
    };
    log.push(entry);
    console.log(`[screens] ${name} — ${JSON.stringify({ ...entry, files: undefined })}`);
  };

  try {
    // ── 01-started: the page as soon as it renders after the start.
    await openLoopPage(page);
    {
      const missing: string[] = [];
      if (!(await shows(page.getByTestId("loop-tempo-key"), 60_000))) missing.push("no cap row");
      if (hasReceipt && !(await shows(page.getByTestId("loop-receipt-status"), 60_000)))
        missing.push("no receipt card");
      const now = await row();
      if ((now?.history?.length ?? 0) > 0) missing.push("taken after step 1 had landed: started late");
      else if (now?.status === "running" && !(await shows(page.getByTestId("loop-step-pending"), 180_000)))
        missing.push("no pending step");
      await screenshot("01-started", now ?? first, missing);
    }

    // ── 02-running: on step 1's landing, read on the console's row first (it lands there before the
    // browser's indexer read), then on the page. The page draws new rows on its own polls; one reload
    // is the fallback for a table that sat on its skeleton.
    {
      const missing: string[] = [];
      const landed = await until((l) => (l.history?.length ?? 0) >= 1 || l.status === "stopped", 20 * 60_000);
      if ((landed?.history?.length ?? 0) < 1) missing.push("no step landed within 20 min");
      const chip = page.getByTestId("step-goal-check").first();
      if (!(await shows(chip, 90_000))) {
        await openLoopPage(page, true);
        if (!(await shows(chip, 120_000))) missing.push("no goal chip on the page");
      }
      if (!(await shows(page.getByTestId("open-channel"), 30_000))) missing.push("no open channel");
      if (landed?.status === "stopped") missing.push("the loop had stopped: taken late");
      await screenshot("02-running", landed, missing);
    }

    // ── 03-finished: the stop, then the receipt's publish (after the settle, the key's revoke and the
    // sweep), then a reload so the page reads both fresh.
    {
      const missing: string[] = [];
      let done = await until((l) => l.status === "stopped", 60 * 60_000);
      if (done?.status !== "stopped") missing.push("the loop had not stopped within 60 min");
      if (hasReceipt) {
        done = await until((l) => l.status === "stopped" && !!l.receipt && l.receipt.status !== "waiting", 8 * 60_000);
        if (!done?.receipt || done.receipt.status === "waiting") missing.push("the receipt was still waiting");
      }
      await openLoopPage(page, true);
      if (hasReceipt && done?.receipt?.status) {
        const card = page.getByTestId("loop-receipt-status");
        const there = await expect(card)
          .toHaveAttribute("data-status", done.receipt.status, { timeout: 60_000 })
          .then(
            () => true,
            () => false
          );
        if (!there) missing.push(`the receipt card did not read ${done.receipt.status}`);
      }
      const settled = page.getByTestId("money-flow").getByTestId("money-flow-settlement");
      if (!(await shows(settled, 180_000))) missing.push("no settlement on the money flow");
      const steps = done?.history?.length ?? 0;
      const filled = await expect
        .poll(() => page.getByTestId("step-goal-check").count(), { timeout: 120_000 })
        .toBeGreaterThanOrEqual(steps)
        .then(
          () => true,
          () => false
        );
      if (!filled) missing.push("not every step's row back after the reload");
      await screenshot("03-finished", done, missing);
    }
  } finally {
    writeFileSync(
      path.join(out, "loop-screens.json"),
      JSON.stringify({ loopId: LOOP, owner: OWNER, viewport: `${WIDTH}x${HEIGHT}`, screens: log, fenced }, null, 2) +
        "\n"
    );
    await context.close();
  }
  // A write the page tried is a finding, not a frame: the fence stopped it, and the run is not touched.
  expect(fenced, "the page tried a write, which the fence aborted").toEqual([]);
});
